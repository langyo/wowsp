//! Packet-stream decoding: finished-replay position trajectories, the live
//! temp-container snapshots, HP detection/anchoring and the Lesta arena
//! synthesis. Split from the former single-file `commands/replay.rs`.

use std::fs;

use wowsp_tauri_shared::VehicleEntry;

use super::meta::{REPLAY_MAGIC, extract_descriptor_json, roster_from_raw};

/// Decode the packet stream of one `.wowsreplay` and return per-entity
/// position trajectories (milestone M3) annotated with each entity's creation
/// metadata (entity-create: type / vehicleId / initial position) so the
/// frontend can filter ships from capture zones / avatars.
///
/// Async command + [`tokio::task::spawn_blocking`]: the full Blowfish decrypt
/// + zlib inflate of a real match's packet stream is seconds-scale CPU work —
/// it runs on the blocking pool so the UI thread never stalls (same rule as
/// [`pick_replay_files`]).
#[tauri::command]
pub async fn read_replay_positions(
    path: String,
) -> Result<wowsp_tauri_shared::ReplayStream, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        let stream = packet_stream_after_blocks(&bytes)
            .ok_or_else(|| format!("{path}: not a valid wowsreplay (no packet stream)"))?;
        // The container's family picks the entity-method id table (Lesta's
        // version keys sit above every WG table — version-keyed lookup would
        // cross-wire the method-gated streams; see method_tables_lesta).
        let lesta = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(super::game_client::is_lesta_replay_extension);
        // Roster shipIds — the candidate set used to recover each entity's
        // shipId from its EntityCreate state stream (the only reliable
        // entity -> player join key). Goes through the shared roster source
        // so a Lesta container (whose descriptor carries no vehicles array)
        // contributes its synthesized roster just the same; the roster itself
        // is kept for the Lesta arena synthesis below.
        let mut candidates = std::collections::HashSet::new();
        let mut client_version: Option<String> = None;
        let mut roster: Vec<VehicleEntry> = Vec::new();
        if let Some(json) = extract_descriptor_json(&bytes) {
            if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
                client_version = raw
                    .get("clientVersionFromExe")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                roster = roster_from_raw(std::path::Path::new(&path), &raw);
                for v in &roster {
                    // 0 is the degenerate "no shipId in the entry" default —
                    // offering it would let a 4-zero-byte window in any
                    // EntityCreate state label an entity with a bogus id.
                    if v.ship_id > 0 {
                        candidates.insert(v.ship_id as u32);
                    }
                }
            }
        }
        let mut decoded =
            super::packets::decode_replay(stream, &candidates, client_version.as_deref(), lesta)?;
        if lesta {
            // BEFORE grouping: the synthesis fills `arena_players` with the
            // state-recovered starting health, so the HP anchoring and the
            // recorder-team slot inside `group_by_entity` treat it exactly
            // like a decoded WG arena state.
            synthesize_lesta_arena_players(
                &mut decoded.arena_players,
                &decoded.kinds,
                &roster,
                decoded.recorder_ship,
            );
        }
        Ok(group_by_entity(decoded))
    })
    .await
    .map_err(|e| format!("replay positions task failed: {e}"))?
}

/// The running client's in-progress replay container (`temp.wowsreplay` /
/// `temp.korablireplay`), as surfaced to the live self-stats view. `size` is
/// the current byte length — the frontend re-decodes only when it grew, so
/// the (seconds-scale) snapshot decode never re-runs on a quiescent file.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LiveTempReplay {
    pub path: String,
    pub size: u64,
}

/// Locate the live battle's in-progress replay container. Resolves the
/// RUNNING install first (the file belongs to whichever client is actually
/// in a match — the same live-order rule as the roster/telemetry pipelines),
/// then checks each family's `temp.<ext>` name in its replays folder and
/// returns the most recently modified hit. `None` when no game root resolves
/// or no temp container exists (no battle in progress).
#[tauri::command]
pub async fn live_temp_replay() -> Result<Option<LiveTempReplay>, String> {
    tokio::task::spawn_blocking(|| {
        let Some(root) =
            super::game_context::resolve_root(super::game_context::RootPreference::PreferRunning)
        else {
            return Ok(None);
        };
        let dir = super::game_context::replays_dir(&root.root);
        let mut best: Option<(std::time::SystemTime, LiveTempReplay)> = None;
        for ext in super::game_client::replay_extensions() {
            let path = dir.join(format!("temp.{ext}"));
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(t, _)| modified >= *t) {
                best = Some((
                    modified,
                    LiveTempReplay {
                        path: path.to_string_lossy().into_owned(),
                        size: meta.len(),
                    },
                ));
            }
        }
        Ok(best.map(|(_, live)| live))
    })
    .await
    .map_err(|e| format!("live temp replay task failed: {e}"))?
}

/// Decode the CURRENTLY WRITING `temp.wowsreplay` into the same
/// [`ReplayStream`] shape as [`read_replay_positions`], tolerating the torn
/// tail the game is mid-append on (see `decode_replay_partial`). Called
/// repeatedly by the live self-stats view while its tab is open; damage
/// totals, hits, achievements and HP timelines all stream cumulatively, so
/// every call is a complete "battle so far" snapshot, not a delta.
///
/// Mid-write states are the NORMAL first reads, not errors (see
/// [`live_snapshot_from_bytes`]) — the view keeps its syncing state and
/// re-polls as the file grows.
#[tauri::command]
pub async fn read_live_replay_snapshot(
    path: String,
) -> Result<wowsp_tauri_shared::LiveSelfStream, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        Ok(live_snapshot_from_bytes(&path, &bytes))
    })
    .await
    .map_err(|e| format!("live replay snapshot task failed: {e}"))?
}
/// Byte length of the last live-temp read that failed to decode — the
/// downgrade below warns once per growth step instead of once per 5 s poll.
static LAST_LIVE_DECODE_FAILURE_LEN: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(u64::MAX);

/// Parse one live-temp-container read into the slim self-stats snapshot.
///
/// The game writes the container progressively — right after the file is
/// (re)created (battle start, loading screen, the next battle truncating the
/// previous file), the magic/header blocks are not fully on disk yet, and a
/// pre-allocated packet region may still read back as zero fill. Mid-write
/// is the NORMAL first-read state, not corruption: it yields the EMPTY
/// snapshot (the view stays on its syncing state and re-polls on the next
/// size change) instead of surfacing an RpcError for a file that is simply
/// incomplete. A valid prefix behind a torn tail still decodes (see
/// `inflate_zlib_partial`, which keeps the prefix on InvalidData too) —
/// only a stream with nothing decodable downgrades to empty.
///
/// Mirrors the finished-replay path's prologue (roster candidates, version,
/// the Lesta arena synthesis) so the live and settled snapshots agree on
/// identity and starting health; the strict finished-replay reader keeps
/// its hard error for the same shapes (see [`read_replay_positions`]): a
/// completed replay that fails to parse must surface, never masquerade as
/// "still being written".
pub(super) fn live_snapshot_from_bytes(
    path: &str,
    bytes: &[u8],
) -> wowsp_tauri_shared::LiveSelfStream {
    use std::sync::atomic::Ordering;

    let Some(stream) = packet_stream_after_blocks(bytes) else {
        tracing::debug!(
            path,
            len = bytes.len(),
            "live temp replay header not flushed yet; empty snapshot"
        );
        return wowsp_tauri_shared::LiveSelfStream::default();
    };
    let lesta = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(super::game_client::is_lesta_replay_extension);
    let mut candidates = std::collections::HashSet::new();
    let mut client_version: Option<String> = None;
    let mut roster: Vec<VehicleEntry> = Vec::new();
    if let Some(json) = extract_descriptor_json(bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            client_version = raw
                .get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            roster = roster_from_raw(std::path::Path::new(path), &raw);
            if roster.is_empty() {
                // The Lesta LIVE descriptor carries no roster at all (the
                // block[1] playersPublicInfo only lands when the battle
                // settles). The in-game probe's roster file is fresh and
                // complete mid-battle — without it the entity-create ship
                // ids never resolve, the self join fails, and the live
                // view stays on its waiting state for the whole fight
                // (2026-10-08 field session).
                // The freshness gate anchors on the temp container's
                // CREATION time: its mtime advances with every append, and
                // the probe's write-once roster would go "stale" against it
                // in any quiet phase >5 s, silently dropping the roster
                // mid-battle (created() falls back to modified() on
                // filesystems without birth time).
                let battle_start = fs::metadata(path)
                    .and_then(|m| m.created().or_else(|_| m.modified()))
                    .ok();
                if let Some(synth) = super::probe_roster::synthesize_for_arena_since(
                    std::path::Path::new(path),
                    raw.get("playerName").and_then(|v| v.as_str()),
                    battle_start,
                ) {
                    tracing::info!(
                        players = synth.len(),
                        "live temp replay roster synthesized from the in-game probe"
                    );
                    roster = synth;
                }
            }
            for v in &roster {
                if v.ship_id > 0 {
                    candidates.insert(v.ship_id as u32);
                }
            }
        }
    }
    let mut decoded = match super::packets::decode_replay_partial(
        stream,
        &candidates,
        client_version.as_deref(),
        lesta,
    ) {
        Ok(decoded) => decoded,
        // Nothing decodable yet (the packet region is still zero fill, or
        // its first block is mid-flush) — the same mid-write class as the
        // unwritten header; the next size growth gets a fresh attempt. A
        // systematic failure (new client framing, a changed key) shows up
        // here at every growth step, so it warns once per step instead of
        // hiding at debug level for the whole battle.
        Err(e) => {
            if LAST_LIVE_DECODE_FAILURE_LEN.swap(bytes.len() as u64, Ordering::Relaxed)
                != bytes.len() as u64
            {
                tracing::warn!(
                    path,
                    len = bytes.len(),
                    error = %e,
                    "live temp replay not decodable yet; empty snapshot"
                );
            }
            return wowsp_tauri_shared::LiveSelfStream::default();
        },
    };
    if lesta {
        // BEFORE grouping, matching the settled path: the synthesis fills
        // `arena_players` (starting health included) so the HP anchoring
        // and the recorder-team slot behave exactly like a decoded WG
        // arena state.
        synthesize_lesta_arena_players(
            &mut decoded.arena_players,
            &decoded.kinds,
            &roster,
            decoded.recorder_ship,
        );
    }
    // Slim projection: the self view never reads the camera/squadron/
    // chat families, and the snapshot is polled every few seconds —
    // serialize only what it renders (see LiveSelfStream).
    wowsp_tauri_shared::LiveSelfStream::from_full(group_by_entity(decoded))
}

/// Skip the magic + JSON header blocks and return a slice over the encrypted
/// packet stream. Shared by header parsing and position decoding.
pub(super) fn packet_stream_after_blocks(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < 8 || !bytes.starts_with(&REPLAY_MAGIC) {
        return None;
    }
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    let mut cur = 8;
    for _ in 0..block_count {
        if cur + 4 > bytes.len() {
            return None;
        }
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
        cur += 4 + bl;
        if cur > bytes.len() {
            return None;
        }
    }
    Some(&bytes[cur..])
}

/// How the HP property's raw 4-byte value should be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum HpValueKind {
    /// Plain little-endian integer (any size).
    Int,
    /// IEEE f32 bits in a 4-byte field (the `health` property on both tested
    /// versions — index 29 on 0.11.x, 28 on 14.5).
    Float,
}

/// Pick the EntityProperty index that carries ship HP, plus how to read it.
///
/// The property index AND its encoding drift between game versions (0.11.x:
/// float HP at 29; 14.5: float HP at 28; some builds also expose int
/// properties that look HP-ish at 20/21 but are noise). A property qualifies
/// per ship entity when its series:
///   - peaks in plausible HP range (int [1k, 200k], float [5k, 150k]),
///   - starts near the entity's own max (first >= 0.8 * max — HP streams open
///     with a full-health sync),
///   - never jumps UP by more than 35% of max in one step (damage/heal ticks
///     are small; huge upward jumps are init artifacts or packed deltas).
///
/// The index with the most qualifying ship entities wins (ties: more samples).
pub(super) fn detect_hp_property(
    kinds: &std::collections::BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    properties: &std::collections::BTreeMap<i32, Vec<super::packets::PropertyChange>>,
) -> (u32, HpValueKind) {
    use std::collections::BTreeMap as Map;
    // Per (entity, index): does the series look like HP under one interpretation?
    let mut scores: Map<(u32, HpValueKind), (usize, usize)> = Map::new();
    for (eid, changes) in properties {
        if kinds.get(eid).map(|k| k.entity_type) != Some(2) {
            continue;
        }
        let mut by_index: Map<u32, Vec<&super::packets::PropertyChange>> = Map::new();
        for c in changes {
            by_index.entry(c.property_index).or_default().push(c);
        }
        for (idx, rows) in by_index {
            if rows.len() < 3 {
                continue;
            }
            let qualifies = |kind: HpValueKind| -> bool {
                let vals: Vec<f64> = rows
                    .iter()
                    .map(|c| match kind {
                        HpValueKind::Int => c.value as f64,
                        HpValueKind::Float => {
                            if c.size == 4 {
                                f32::from_bits(c.value) as f64
                            } else {
                                f64::NAN
                            }
                        },
                    })
                    .collect();
                if vals.iter().any(|v| !v.is_finite()) {
                    return false;
                }
                let max = vals.iter().cloned().fold(0.0f64, f64::max);
                let lo = if kind == HpValueKind::Int {
                    1_000.0
                } else {
                    5_000.0
                };
                let hi = if kind == HpValueKind::Int {
                    200_000.0
                } else {
                    150_000.0
                };
                if max < lo || max > hi {
                    return false;
                }
                if vals[0] < 0.8 * max {
                    return false;
                }
                let max_step_up = vals.windows(2).map(|w| w[1] - w[0]).fold(0.0f64, f64::max);
                max_step_up <= 0.35 * max
            };
            for kind in [HpValueKind::Int, HpValueKind::Float] {
                if qualifies(kind) {
                    let s = scores.entry((idx, kind)).or_default();
                    s.0 += 1;
                    s.1 += rows.len();
                }
            }
        }
    }
    scores
        .into_iter()
        .max_by_key(|(_, (entities, samples))| (*entities, *samples))
        .map(|((idx, kind), _)| (idx, kind))
        .unwrap_or((20, HpValueKind::Int))
}

/// Prepend each ship's arena starting health at t=0.
///
/// HP property updates only fire when health CHANGES — no ship's stream
/// opens with a full-health sync (verified across a 15.8 replay: every
/// first sample is already a damaged reading, the recorder's own ship
/// included, because the opening full-HP state never needs an update).
/// Step-lookup consumers (`hpAtTime` on the frontend) extrapolate the
/// first sample back to t=0, so without an anchor the whole roster reads
/// as wounded from the opening second — worst for ships first observed
/// after taking hits. The arena's starting health is the authoritative
/// pre-change value: anchor every stream that opens damaged and late.
pub(super) fn anchor_hp_streams(
    hp_map: &mut std::collections::BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>>,
    arena_players: &[wowsp_tauri_shared::ArenaPlayer],
) {
    let starting: std::collections::BTreeMap<i32, u32> = arena_players
        .iter()
        .filter(|p| p.max_health > 0)
        .map(|p| (p.entity_id, p.max_health))
        .collect();
    for (eid, samples) in hp_map.iter_mut() {
        // An empty stream stays empty (no-damage ships keep the frontend's
        // full-health initial label); a stream already opening at the
        // starting health needs no duplicate anchor.
        let Some(&max) = starting.get(eid) else {
            continue;
        };
        if samples
            .first()
            .is_some_and(|s| s.time > 0.0 && s.value < max)
        {
            samples.insert(
                0,
                wowsp_tauri_shared::HpSample {
                    time: 0.0,
                    value: max,
                },
            );
        }
    }
}

/// Synthesize the arena roster join for Lesta replays from the container's
/// block[1] roster: Lesta recordings carry no `onArenaStateReceived`
/// broadcast at all (verified across 26.10 captures — the roster ships in
/// the container header instead), so the authoritative entity → team/player
/// list is rebuilt from that roster plus each entity's EntityCreate-recovered
/// shipId (which on Lesta hides inside a base64-wrapped state property, see
/// `scan_state_for_ship_id`).
///
/// Per-entry: a roster shipId resolving to exactly ONE ship entity joins;
/// a COMPLETE same-config group (N unjoined entities + N unjoined roster
/// entries on one shipId — co-op's mirrored bot fits) pairs by the game's
/// team-blocked spawn order unless the joined entries contradict that
/// model (an ambiguous or partial group is never guessed — a cross-team
/// mis-pairing would paint an ally enemy-red). `max_health` comes from the
/// EntityCreate state scan (`scan_state_for_max_health`) — the starting
/// health of the exact build, so HP anchoring and the frontend totals read
/// like a decoded WG arena. The frontend's `resolveRosterAssignments`
/// treats arena identities as authoritative for the entities they cover and
/// falls back to its shipId/spawn heuristics for the rest, so a partial
/// list is safe. Runs BEFORE `group_by_entity` so the anchoring inside it
/// sees the synthesized list.
pub(super) fn synthesize_lesta_arena_players(
    arena_players: &mut Vec<wowsp_tauri_shared::ArenaPlayer>,
    kinds: &std::collections::BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    roster: &[VehicleEntry],
    recorder_ship: Option<i32>,
) {
    if !arena_players.is_empty() || roster.is_empty() {
        return;
    }
    let mut entities_by_ship: std::collections::BTreeMap<i64, Vec<i32>> =
        std::collections::BTreeMap::new();
    for (eid, kind) in kinds {
        if kind.entity_type != 2 {
            continue;
        }
        if let Some(sid) = kind.ship_id {
            entities_by_ship.entry(sid).or_default().push(*eid);
        }
    }
    let mut players: Vec<wowsp_tauri_shared::ArenaPlayer> = Vec::with_capacity(roster.len());
    // The recorder's own entry anchors to the self-position entity
    // DIRECTLY: a co-op mirror (a teammate in the identical ship config)
    // makes the config-id join ambiguous and the unique-match rule below
    // would drop the local player's row entirely — the 2026-10-08 live
    // calibration: `is_self` vanished mid-battle the moment the mirror's
    // entity resolved. Removing the anchored entity from the candidate
    // map ALSO un-ambiguates the mirror teammate's join (its config id
    // now matches exactly one remaining entity), so the whole roster
    // joins instead of silently losing the mirrored half.
    if let Some(eid) = recorder_ship
        && kinds.contains_key(&eid)
        && let Some(self_entry) = roster.iter().find(|v| v.relation == 0)
    {
        players.push(wowsp_tauri_shared::ArenaPlayer {
            entity_id: eid,
            team_id: 0,
            player_id: self_entry.id,
            ship_params_id: self_entry.ship_id.max(0) as u32,
            max_health: kinds.get(&eid).and_then(|k| k.max_health).unwrap_or(0),
            name: self_entry.name.clone(),
            is_bot: false,
            avatar_id: None,
            is_self: true,
        });
        if let Some(list) = entities_by_ship.get_mut(&self_entry.ship_id) {
            list.retain(|e| *e != eid);
        }
    }
    for v in roster {
        if v.relation == 0 && players.iter().any(|p| p.is_self) {
            continue; // already anchored above
        }
        if v.ship_id <= 0 {
            continue;
        }
        // The unique ship-entity carrying this roster entry's shipId; zero
        // or multiple candidates (mirror picks) are skipped, not guessed.
        let entity_id = match entities_by_ship.get(&v.ship_id).map(|e| e.as_slice()) {
            Some([eid]) => *eid,
            _ => continue,
        };
        players.push(wowsp_tauri_shared::ArenaPlayer {
            entity_id,
            team_id: if v.relation > 1 { 1 } else { 0 },
            player_id: v.id,
            ship_params_id: v.ship_id.max(0) as u32,
            max_health: kinds
                .get(&entity_id)
                .and_then(|k| k.max_health)
                .unwrap_or(0),
            name: v.name.clone(),
            is_bot: v.id < 0,
            avatar_id: None,
            is_self: v.relation == 0,
        });
    }
    // Same-config groups (co-op fields MIRRORED bot fits — one of every
    // bot config per side): each of those candidates is "multiple" for the
    // unique rule above, so a whole mirror pair used to stay unjoined and
    // surface as bare "#entityId" gray rows (the 2026-10-09 co-op battle
    // left a Nassau and a Phoenix pair that way). The game spawns vehicle
    // entities team-blocked in player-list order — the joined entries
    // themselves prove it — but in EITHER orientation: that co-op battle
    // spawned allies first (ids 158821-158827 below enemies 158828-158833),
    // while the 2026-10-13 53_Shoreside capture reversed it (enemy block
    // 432156-432178 below the ally block 432180-432202, the recorder's own
    // 432184 included). A COMPLETE group (N unjoined entities, N unjoined
    // roster entries, one shipId) pairs the k-th entity with the k-th
    // candidate ordered by (relation, id) under the orientation the joined
    // evidence shows. GUARD: the joined evidence must not contradict the
    // team-block model (one team's joined span strictly below the other's);
    // if they interleave, the order assumption is untrustworthy and the
    // group stays skipped — a cross-team mis-pairing would paint an ally
    // enemy-red, which is the exact confusion this join exists to prevent.
    // (Joined evidence absent for either side pairs on the allies-first
    // model alone.)
    let span = |team: i8| -> Option<(i32, i32)> {
        players
            .iter()
            .filter(|p| p.team_id == team)
            .map(|p| p.entity_id)
            .fold(None, |acc, e| {
                Some(match acc {
                    Some((lo, hi)) => (lo.min(e), hi.max(e)),
                    None => (e, e),
                })
            })
    };
    let (span0, span1) = (span(0), span(1));
    // Which team's joined block sits below the other's; exactly one
    // orientation can hold when both sides carry evidence.
    let block_orientation = match (span0, span1) {
        (Some((_, max0)), Some((min1, _))) if max0 < min1 => Some(true),
        (Some((min0, _)), Some((_, max1))) if max1 < min0 => Some(false),
        (Some(_), Some(_)) => None, // interleaved — untrustworthy
        _ => Some(true),            // one side has no joined evidence — model alone
    };
    if let Some(allies_first) = block_orientation {
        let joined_ids: std::collections::HashSet<i64> =
            players.iter().map(|p| p.player_id).collect();
        let mut joined_entities: std::collections::HashSet<i32> =
            players.iter().map(|p| p.entity_id).collect();
        for (ship_id, eids) in &entities_by_ship {
            if *ship_id <= 0 {
                continue;
            }
            // kinds is a BTreeMap, so `eids` ascend — the game's spawn order.
            let free_entities: Vec<i32> = eids
                .iter()
                .copied()
                .filter(|e| !joined_entities.contains(e))
                .collect();
            if free_entities.len() < 2 {
                continue;
            }
            let mut candidates: Vec<&VehicleEntry> = roster
                .iter()
                .filter(|v| v.ship_id == *ship_id && v.relation != 0 && !joined_ids.contains(&v.id))
                .collect();
            // An incomplete group (a config whose entity never resolved or
            // whose roster entry is missing) cannot be paired in order
            // without a guess — stay skipped.
            if candidates.len() != free_entities.len() {
                continue;
            }
            // Relation order follows the observed orientation: relation 1
            // (own team) takes the lower ids only when allies spawned first.
            candidates.sort_by(|a, b| {
                let rel = |v: &VehicleEntry| {
                    if allies_first {
                        v.relation
                    } else {
                        -v.relation
                    }
                };
                rel(a).cmp(&rel(b)).then(a.id.cmp(&b.id))
            });
            // zip yields exactly the matched count (>= 2), so the tail pop
            // below always knows how many entries to undo.
            for (eid, v) in free_entities.iter().zip(candidates) {
                joined_entities.insert(*eid);
                players.push(wowsp_tauri_shared::ArenaPlayer {
                    entity_id: *eid,
                    team_id: if v.relation > 1 { 1 } else { 0 },
                    player_id: v.id,
                    ship_params_id: v.ship_id.max(0) as u32,
                    max_health: kinds.get(eid).and_then(|k| k.max_health).unwrap_or(0),
                    name: v.name.clone(),
                    is_bot: v.id < 0,
                    avatar_id: None,
                    is_self: false,
                });
            }
            let pushed = free_entities.len();
            // Post-pairing re-check: a mixed group's own insertions could
            // create the interleaved state the guard rejects (a paired
            // entry landing inside the other team's block) — the just-
            // pushed entries are the vec tail, so pop them and leave the
            // group unjoined rather than keep a layout the model says is
            // wrong. The check mirrors the chosen orientation.
            let lo_team = if allies_first { 0 } else { 1 };
            let hi_team = 1 - lo_team;
            let hi_of_lo = players
                .iter()
                .filter(|p| p.team_id == lo_team)
                .map(|p| p.entity_id)
                .max();
            let lo_of_hi = players
                .iter()
                .filter(|p| p.team_id == hi_team)
                .map(|p| p.entity_id)
                .min();
            let monotone = match (hi_of_lo, lo_of_hi) {
                (Some(hi), Some(lo)) => hi < lo,
                _ => true,
            };
            if !monotone {
                for p in players.drain(players.len() - pushed..) {
                    joined_entities.remove(&p.entity_id);
                }
            }
        }
    }
    if players.is_empty() {
        return;
    }
    *arena_players = players;
}

/// Group the decoded per-entity positions into trajectories, attaching each
/// entity's creation metadata (type / vehicleId / spawn position) from the
/// EntityCreate packets. Ships (type 2 with many samples) sort first.
pub(super) fn group_by_entity(
    decoded: super::packets::DecodedReplay,
) -> wowsp_tauri_shared::ReplayStream {
    let super::packets::DecodedReplay {
        recorder_ship: _, // consumed by the self-anchor synthesis upstream
        positions,
        kinds,
        destroys,
        properties,
        shell_launches,
        explosions,
        torpedoes,
        torpedo_steers,
        mut cap_progress,
        weapon_locks,
        battle_results,
        method_histogram: _,
        method_arg_samples: _,
        version,
        map_name,
        camera,
        net_stats,
        leaves,
        camera_modes,
        diagnostics,
        squadron_creates,
        squadron_planes,
        minimap_squadron_adds,
        minimap_squadron_moves,
        minimap_squadron_removes,
        wards,
        ward_removes,
        shot_kills,
        damage_stats,
        chat_messages,
        achievements,
        arena_players,
        weather_transitions,
        weather_notifications,
    } = decoded;
    // The recorder's team slot comes from its own arena entry.
    let self_team = arena_players.iter().find(|p| p.is_self).map(|p| p.team_id);
    // Build HP timelines. The property index carrying HP is version-dependent
    // (see detect_hp_property); property 0 on capture zones tracks ownership.
    let (hp_index, hp_kind) = detect_hp_property(&kinds, &properties);
    let mut hp_map: std::collections::BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> =
        std::collections::BTreeMap::new();
    let mut cap_map: std::collections::BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> =
        std::collections::BTreeMap::new();
    for (eid, changes) in &properties {
        for c in changes {
            if c.property_index == hp_index {
                let value = match hp_kind {
                    HpValueKind::Int => c.value,
                    // Float HP streams carry whole-number values; rounding
                    // keeps the wire format (u32) unchanged for the frontend.
                    HpValueKind::Float => f32::from_bits(c.value).round() as u32,
                };
                hp_map
                    .entry(*eid)
                    .or_default()
                    .push(wowsp_tauri_shared::HpSample {
                        time: c.time,
                        value,
                    });
            } else if c.property_index == 0 {
                cap_map
                    .entry(*eid)
                    .or_default()
                    .push(wowsp_tauri_shared::HpSample {
                        time: c.time,
                        value: c.value,
                    });
            }
        }
    }
    anchor_hp_streams(&mut hp_map, &arena_players);
    // Infer death from the HP stream when no EntityDestroy packet exists:
    // a float HP series that ends at exactly 0 means the ship sank (the last
    // sample is the sink instant; the client stops updating HP afterwards).
    // The EntityDestroy (0x06) packet is absent on modern clients, so without
    // this every ship would render alive until match end.
    fn infer_death_time(hp: &[wowsp_tauri_shared::HpSample], existing: Option<f32>) -> Option<f32> {
        if existing.is_some() {
            return existing;
        }
        if hp.len() < 2 {
            return None;
        }
        let last = &hp[hp.len() - 1];
        if last.value == 0 && hp[hp.len() - 2].value > 0 {
            return Some(last.time);
        }
        // Trailing-zero series (HP kept updating at 0 after sinking).
        for i in 1..hp.len() - 1 {
            if hp[i].value == 0 && hp[i + 1].value == 0 {
                return Some(hp[i].time);
            }
        }
        None
    }
    let mut out: Vec<_> = positions
        .into_iter()
        .map(|(entity_id, samples)| {
            let hp_samples = hp_map.remove(&entity_id).unwrap_or_default();
            let cap_samples = cap_map.remove(&entity_id).unwrap_or_default();
            let cap_progress = cap_progress.remove(&entity_id).unwrap_or_default();
            let kind = kinds.get(&entity_id).cloned();
            // Only ships have meaningful HP streams — smoke/zones never do.
            let death_time = if kind.as_ref().map(|k| k.entity_type) == Some(2) {
                infer_death_time(&hp_samples, destroys.get(&entity_id).copied())
            } else {
                destroys.get(&entity_id).copied()
            };
            wowsp_tauri_shared::EntityTrajectory {
                entity_id,
                kind,
                samples,
                death_time,
                hp_samples,
                cap_samples,
                cap_progress,
            }
        })
        .collect();
    // Include entities that have creation metadata but no position samples
    // (e.g. static capture zones, entityType 14, which never emit Position packets).
    for (eid, kind) in &kinds {
        if !out.iter().any(|t| t.entity_id == *eid) {
            out.push(wowsp_tauri_shared::EntityTrajectory {
                entity_id: *eid,
                kind: Some(kind.clone()),
                samples: Vec::new(),
                death_time: destroys.get(eid).copied(),
                hp_samples: hp_map.remove(eid).unwrap_or_default(),
                cap_samples: cap_map.remove(eid).unwrap_or_default(),
                cap_progress: cap_progress.remove(eid).unwrap_or_default(),
            });
        }
    }
    // Largest trajectory first — ships have hundreds/thousands of samples,
    // transient entities (planes, torpedoes) have a few dozen.
    use std::cmp::Reverse;
    out.sort_by_key(|t| Reverse(t.samples.len()));
    wowsp_tauri_shared::ReplayStream {
        trajectories: out,
        shell_launches,
        explosions,
        torpedoes,
        torpedo_steers,
        weapon_locks,
        battle_results,
        version,
        map_name,
        camera,
        net_stats,
        leaves,
        camera_modes,
        diagnostics,
        squadron_creates,
        squadron_planes,
        minimap_squadron_adds,
        minimap_squadron_moves,
        minimap_squadron_removes,
        wards,
        ward_removes,
        shot_kills,
        damage_stats,
        chat_messages,
        achievements,
        arena_players,
        weather_transitions,
        weather_notifications,
        self_team,
    }
}
