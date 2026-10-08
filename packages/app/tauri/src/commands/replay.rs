//! Replay header parsing — WG `.wowsreplay` and the Lesta (Мир кораблей)
//! `.korablireplay` container.
//!
//! File layout (both clients — the Lesta container keeps the WG framing
//! byte-for-byte, only its block payload set differs):
//!   4 bytes  magic       = `{0x12, 0x32, 0x34, 0x11}`
//!   4 bytes  block_count = little-endian u32
//!   ...      blocks      = `block_count` × (4-byte LE length + payload)
//!   ...      packets     = encrypted/zlib packet stream (`packets`)
//!
//! WG writes 3 blocks, the first carrying the match-descriptor JSON with the
//! roster inline (`vehicles`). Lesta writes 4:
//!   - block[0] — the match descriptor JSON. Same core keys as WG
//!     (`matchGroup`, `mapId`, `mapDisplayName`, `scenario`,
//!     `clientVersionFromExe`, ...), but NO `vehicles` roster;
//!   - block[1] — the roster JSON: `playersPublicInfo` maps account id →
//!     positional array ([0] id — negative = bot, [1] name (same
//!     `:Name:` / `IDS_*` / `#Name` bot markers as WG), [6] team 0/1,
//!     [7] shipId in the WG numeric format);
//!   - block[2] — ASCII `"<accountDBID>.<arenaUniqueID>"`, pinning the
//!     recorder's account id;
//!   - block[3] — 32 ASCII hex chars, an integrity checksum (not a key;
//!     ignored).
//!
//! A descriptor without `vehicles` gets its roster synthesized from [1] +
//! [2] ([`lesta_roster`]); relations, bot/scripted counts and the recorder's
//! ship then follow the WG rules unchanged.
//!
//! The packet stream behind the blocks is also the exact WG scheme (same
//! Blowfish key + XOR chain + zlib, [`packets::decode_replay`]), so
//! trajectories decode unchanged. Fixed-layout packets (positions, entity
//! create/destroy, player position) are version-independent;
//! EntityMethod-id-gated features run under the Lesta Avatar method table
//! ([`crate::commands::method_tables_lesta`]) selected by the container
//! family — Lesta's `clientVersionFromExe` ("26,10,0,...") sits above every
//! WG table, so version-keyed lookup would cross-wire those streams. Lesta
//! recordings additionally carry NO `onArenaStateReceived` and NO chat
//! broadcast at all (verified across 26.10 captures): the arena roster is
//! synthesized from the block[1] roster plus the EntityCreate shipId scan
//! ([`synthesize_lesta_arena_players`]), with each ship's starting health
//! recovered from the create state, and the chat stream stays empty — no
//! sanctioned local chat source exists either (the Mods API exposes no chat
//! event; both clients ship their game scripts encrypted, so Lesta's
//! CHAT_MESSAGE_BLOB converter can't be read offline; the client writes no
//! battle-chat log to disk), so chat-bearing Lesta recordings, should they
//! turn out to exist, are the only remaining path.
//!
//! The dual-format reader also accepts the bare-JSON variant the client
//! writes as `tempArenaInfo.json` (same logic ApeRadar's
//! `FileUtils.ReadTempArenaInfoFile` uses).

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use wowsp_tauri_shared::{GameInstall, ReplayMeta, ReplayMetaLite, VehicleEntry};

// The replay-container extension test lives in the per-client compat
// registry (commands/game_client.rs); the walk below and this module's tests
// keep calling it by its plain name.
use super::game_client::is_replay_extension;

/// Replay magic — first 4 bytes of every `.wowsreplay`.
const REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];

/// Read + parse the header of one `.wowsreplay` file into a [`ReplayMeta`].
///
/// `path` must point at an existing file. On any structural problem (missing
/// magic, truncated header, unparseable JSON) the raw JSON block is still
/// returned when recoverable, so the frontend can render whatever it can.
///
/// Async command + [`tokio::task::spawn_blocking`]: reading + decrypting the
/// descriptor block is real file I/O + CPU work, which must never run on the
/// UI thread (Tauri 2 synchronous commands do) — same rule as
/// [`pick_replay_files`].
#[tauri::command]
pub async fn read_replay_header(path: String) -> Result<ReplayMeta, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        let json = extract_descriptor_json(&bytes).ok_or_else(|| {
            format!("{path}: not a valid wowsreplay (magic mismatch or truncated)")
        })?;
        let raw: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| format!("parse descriptor JSON: {e}"))?;
        Ok(meta_from_raw(path, raw))
    })
    .await
    .map_err(|e| format!("replay header task failed: {e}"))?
}

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
            synthesize_lesta_arena_players(&mut decoded.arena_players, &decoded.kinds, &roster);
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
fn live_snapshot_from_bytes(path: &str, bytes: &[u8]) -> wowsp_tauri_shared::LiveSelfStream {
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
        synthesize_lesta_arena_players(&mut decoded.arena_players, &decoded.kinds, &roster);
    }
    // Slim projection: the self view never reads the camera/squadron/
    // chat families, and the snapshot is polled every few seconds —
    // serialize only what it renders (see LiveSelfStream).
    wowsp_tauri_shared::LiveSelfStream::from_full(group_by_entity(decoded))
}

/// Skip the magic + JSON header blocks and return a slice over the encrypted
/// packet stream. Shared by header parsing and position decoding.
fn packet_stream_after_blocks(bytes: &[u8]) -> Option<&[u8]> {
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
enum HpValueKind {
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
fn detect_hp_property(
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
fn anchor_hp_streams(
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
/// mirror picks (two players on one ship share the shipId, common among
/// bots) are skipped rather than guessed. `max_health` comes from the
/// EntityCreate state scan (`scan_state_for_max_health`) — the starting
/// health of the exact build, so HP anchoring and the frontend totals read
/// like a decoded WG arena. The frontend's `resolveRosterAssignments`
/// treats arena identities as authoritative for the entities they cover and
/// falls back to its shipId/spawn heuristics for the rest, so a partial
/// list is safe. Runs BEFORE `group_by_entity` so the anchoring inside it
/// sees the synthesized list.
fn synthesize_lesta_arena_players(
    arena_players: &mut Vec<wowsp_tauri_shared::ArenaPlayer>,
    kinds: &std::collections::BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    roster: &[VehicleEntry],
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
    let mut players = Vec::with_capacity(roster.len());
    for v in roster {
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
    if players.is_empty() {
        return;
    }
    *arena_players = players;
}

/// Group the decoded per-entity positions into trajectories, attaching each
/// entity's creation metadata (type / vehicleId / spawn position) from the
/// EntityCreate packets. Ships (type 2 with many samples) sort first.
fn group_by_entity(decoded: super::packets::DecodedReplay) -> wowsp_tauri_shared::ReplayStream {
    let super::packets::DecodedReplay {
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

/// Open a native multi-select file dialog for `.wowsreplay` files anywhere on
/// disk (replays shared from other players live outside the game's replays
/// folder). Returns the picked absolute paths; an empty vec means the user
/// cancelled. Picked files are opened through the same
/// [`read_replay_header`] / [`read_replay_positions`] commands as regular
/// replays — both accept arbitrary paths.
#[tauri::command]
pub async fn pick_replay_files() -> Result<Vec<String>, String> {
    // Mobile: replays arrive through the pairing / document-picker flow (a
    // later mobile phase), not a desktop-style multi-select dialog.
    #[cfg(mobile)]
    {
        return Err(crate::mobile_unsupported::PICKER.into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread.
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Select World of Warships replays")
                .add_filter("World of Warships replay", &["wowsreplay"])
                .add_filter("Lesta Мир кораблей replay", &["korablireplay"])
                .pick_files()
        })
        .await
        .map_err(|e| format!("replay file picker task failed: {e}"))?;
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    }
}

/// List `.wowsreplay` files under a directory (defaults to the resolved
/// default replay dir — the unified game context's user-scoped order).
/// Returns at most `limit` paths sorted newest-first — every replay when
/// `limit` is omitted. The walk recurses into the per-version archive
/// subfolders the game keeps under `replays/` (e.g. `replays/14.5.0.0/`),
/// which can hold many hundreds of files past what the root folder keeps,
/// so an implicit cap would silently drop a player's archived history.
///
/// Async command + [`tokio::task::spawn_blocking`]: the recursive directory
/// walk + per-file metadata reads are blocking I/O that must never run on the
/// UI thread (Tauri 2 synchronous commands do) — same rule as
/// [`read_replay_header`].
#[tauri::command]
pub async fn list_replays(
    dir: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let dir = resolve_replay_dir(dir)?;
        let mut entries: Vec<WalkedReplay> = Vec::new();
        walk_replays(&dir, &mut entries);
        use std::cmp::Reverse;
        entries.sort_by_key(|e| Reverse(e.mtime));
        // No implicit cap (see the command doc): only an explicit `limit`
        // truncates, so version-archive subfolders are never silently
        // dropped once a tree grows past any fixed default.
        let limit = limit.unwrap_or(usize::MAX);
        Ok(entries
            .into_iter()
            .take(limit)
            .map(|e| e.path.to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|e| format!("replay listing task failed: {e}"))?
}

/// List replays with their parsed descriptor metadata — same walk as
/// [`list_replays`], but each entry carries the lightweight summary fields
/// (date/time, match group, map, own ship, player count) instead of just a
/// path. Per file only the first JSON block is read — a bounded header read
/// (see [`lite_from_path`]), never the multi-MB packet stream behind it — and
/// the whole scan runs on the blocking pool
/// ([`tokio::task::spawn_blocking`]) so the UI thread never stalls. Files
/// whose header can't be parsed still appear, with whatever fields were
/// recoverable.
///
/// `all` widens the scan from ONE root to every detected client
/// ([`super::game_context::replay_roots`]): the rail then lists each
/// client's replays side by side, every entry stamped with its owning
/// install (`install_path`/`install_kind`/`install_realm`) so the cards can
/// label the server and the rail can filter by it. `dir` is ignored in
/// that mode (an explicit folder is by definition a single-root scan); with
/// `all` unset the historical single-root behavior is unchanged, which is
/// what the pairing / import flows keep calling.
#[tauri::command]
pub async fn list_replays_meta(
    dir: Option<String>,
    limit: Option<usize>,
    all: Option<bool>,
) -> Result<Vec<ReplayMetaLite>, String> {
    let all = all.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        if all {
            Ok(scan_all_replays_meta(limit))
        } else {
            scan_replays_meta(dir, limit).map(|(_, entries)| entries)
        }
    })
    .await
    .map_err(|e| format!("replay listing task failed: {e}"))?
}

/// The all-clients enumeration core behind `list_replays_meta { all: true }`:
/// walk every root [`super::game_context::replay_roots`] reports (each
/// detected install's `replays/` folder plus the resolved default dir when
/// no install covers it), parse each file's descriptor, and stamp the entry
/// with the owning install.
pub(crate) fn scan_all_replays_meta(limit: Option<usize>) -> Vec<ReplayMetaLite> {
    scan_roots_meta(&super::game_context::replay_roots(), limit)
}

/// [`scan_all_replays_meta`]'s pure core — the roots arrive as a parameter
/// so tests can drive synthetic trees, the same shape `playtime.rs` uses
/// for its ledger. Files are de-duplicated by normalized path, so a folder
/// reachable through two spellings still contributes each replay exactly
/// once (root de-duplication is the caller's: `game_context::replay_roots`
/// never reports overlapping roots).
///
/// Sorted by mtime descending — the same newest-first order the single-root
/// scan answers — with an explicit `limit` applied after that sort (no
/// implicit cap: see [`scan_replays_meta`]). A `limit` of 0 answers nothing,
/// matching the single-root scan's `.take(0)`.
fn scan_roots_meta(
    roots: &[(PathBuf, Option<GameInstall>)],
    limit: Option<usize>,
) -> Vec<ReplayMetaLite> {
    let mut walked: Vec<(WalkedReplay, Option<GameInstall>)> = Vec::new();
    for (root, owner) in roots {
        let mut files = Vec::new();
        walk_replays(root, &mut files);
        for file in files {
            walked.push((file, owner.clone()));
        }
    }
    use std::cmp::Reverse;
    walked.sort_by_key(|(e, _)| Reverse(e.mtime));
    let limit = limit.unwrap_or(usize::MAX);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (file, owner) in walked {
        if out.len() >= limit {
            break;
        }
        let key = super::game_detect::install_path_key(&file.path.to_string_lossy());
        if !seen.insert(key) {
            continue;
        }
        let mut lite = lite_from_path(&file.path);
        if let Some(install) = owner {
            lite.install_path = Some(install.path.clone());
            lite.install_kind = Some(install.kind);
            lite.install_realm = install.realm.clone();
        }
        out.push(lite);
    }
    out
}

/// Enumeration core shared by the [`list_replays_meta`] command and the
/// pairing server's `/api/replays` route (single source of truth — never
/// duplicate the walk). Returns the resolved replay ROOT alongside the
/// entries so callers that need relative names (the pairing server projects
/// absolute paths onto root-relative remote names) can do so.
pub(crate) fn scan_replays_meta(
    dir: Option<String>,
    limit: Option<usize>,
) -> Result<(PathBuf, Vec<ReplayMetaLite>), String> {
    let dir = resolve_replay_dir(dir)?;
    let mut entries: Vec<WalkedReplay> = Vec::new();
    walk_replays(&dir, &mut entries);
    use std::cmp::Reverse;
    entries.sort_by_key(|e| Reverse(e.mtime));
    // No implicit cap — same rationale as list_replays: the versioned
    // archive subfolders routinely push a tree past any fixed default, and
    // mtime-desc truncation would drop exactly the OLDEST (archived)
    // replays, which is the history the caller wants to surface.
    let limit = limit.unwrap_or(usize::MAX);
    Ok((
        dir,
        entries
            .into_iter()
            .take(limit)
            .map(|e| lite_from_path(&e.path))
            .collect(),
    ))
}

/// Generous upper bound on any one metadata block: real descriptors run a
/// few hundred KB (roster-heavy), so a length prefix beyond this is a corrupt
/// or malicious header, not a block worth buffering.
const MAX_FIRST_BLOCK_BYTES: usize = 16 * 1024 * 1024;

/// Read one metadata block of a replay file by index (0 = the descriptor
/// JSON, 1 = the Lesta roster JSON, ...): the 8-byte prologue (magic + block
/// count), then the 4-byte little-endian length prefixes of every block
/// before `index` — their payloads are SEEKED past, never buffered — and
/// finally `index`'s length + payload. Same framing
/// [`extract_descriptor_json`] parses on an in-memory slice, minus the
/// multi-MB packet stream that follows. Lengths above
/// [`MAX_FIRST_BLOCK_BYTES`] are rejected so a corrupt prefix can never
/// drive a huge allocation or read.
fn read_block(path: &std::path::Path, index: usize) -> std::io::Result<Vec<u8>> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut f = fs::File::open(path)?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)?;
    if magic != REPLAY_MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not a wowsreplay container (magic mismatch)",
        ));
    }
    let mut count = [0u8; 4];
    f.read_exact(&mut count)?;
    let block_count = u32::from_le_bytes(count) as usize;
    if block_count == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "wowsreplay container has no blocks",
        ));
    }
    if index >= block_count {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            format!("wowsreplay container has {block_count} blocks, block {index} missing"),
        ));
    }
    let mut len = [0u8; 4];
    for _ in 0..index {
        f.read_exact(&mut len)?;
        let skip = u32::from_le_bytes(len);
        f.seek(SeekFrom::Current(i64::from(skip)))?;
    }
    f.read_exact(&mut len)?;
    let block_len = u32::from_le_bytes(len) as usize;
    if block_len > MAX_FIRST_BLOCK_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("block {index} length {block_len} exceeds {MAX_FIRST_BLOCK_BYTES}"),
        ));
    }
    let mut payload = vec![0u8; block_len];
    f.read_exact(&mut payload)?;
    Ok(payload)
}

/// Build a [`ReplayMetaLite`] for one replay file by reading just its
/// descriptor-JSON block. On any read/parse failure, returns a lite entry with
/// only the path + filename-derived datetime populated, so the file is still
/// listed.
///
/// `pub(crate)`: the playtime battle ledger (commands/playtime.rs) shares
/// this exact projection for its replay-derived rows — never duplicate the
/// header parse.
pub(crate) fn lite_from_path(path: &std::path::Path) -> ReplayMetaLite {
    let path_str = path.to_string_lossy().into_owned();
    let date_time = parse_datetime_from_filename(&path_str);
    // The walk only surfaces replay containers (`*.wowsreplay` and the Lesta
    // `*.korablireplay`, same framing), never the bare-JSON tempArenaInfo
    // variant, so the bounded block read is the only input path needed — the
    // multi-MB packet stream behind the header is never touched. A Lesta
    // descriptor (no `vehicles`) additionally pulls its roster from blocks 1
    // and 2 through the same bounded reads. Any read/parse failure falls back
    // to the path + filename-datetime entry below.
    let raw: Option<serde_json::Value> = read_block(path, 0)
        .ok()
        .and_then(|payload| serde_json::from_str(&String::from_utf8_lossy(&payload)).ok());
    let Some(raw) = raw else {
        return ReplayMetaLite {
            path: path_str,
            date_time,
            match_group: None,
            map_name: None,
            map_id: None,
            scenario: None,
            event_type: None,
            bot_count: 0,
            scripted_unit_count: 0,
            own_ship_id: None,
            player_name: None,
            player_count: 0,
            install_path: None,
            install_kind: None,
            install_realm: None,
        };
    };
    lite_from_raw(path_str, date_time, raw)
}

/// Project the parsed descriptor JSON onto a [`ReplayMetaLite`]. Shares the
/// defensive field-pulling style of [`meta_from_raw`] and the same roster
/// source ([`roster_from_raw`] — WG `vehicles`, or the synthesized Lesta
/// roster), resolving the recording player's ship (relation == 0).
fn lite_from_raw(
    path: String,
    date_time: Option<String>,
    raw: serde_json::Value,
) -> ReplayMetaLite {
    let obj = raw.as_object();
    let match_group = obj
        .and_then(|o| o.get("matchGroup"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_id = obj.and_then(|o| o.get("mapId")).and_then(|v| v.as_i64());
    let map_name = obj
        .and_then(|o| o.get("mapDisplayName"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let scenario = obj
        .and_then(|o| o.get("scenario"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let event_type = obj
        .and_then(|o| o.get("eventType"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    // Pull the roster just enough to count players + find the recorder
    // (relation 0). For a Lesta descriptor this synthesizes the roster from
    // block[1]/block[2] — the path is only re-opened when the descriptor
    // carries no `vehicles` array.
    let vehicles = roster_from_raw(std::path::Path::new(&path), &raw);
    // Listed players only: scripted scenario NPCs (`IDS_*` text keys, `#Name`
    // — story-mode ally flagships riding relation-1 slots) are not players
    // and sit out the count, matching the frontend's roster filtering
    // (utils/rosterSides). The `:Name:` co-op bot fills stay counted — they
    // really are team slots.
    let player_count = vehicles
        .iter()
        .filter(|v| !is_scripted_unit_nickname(&v.name))
        .count();
    let (bot_count, scripted_unit_count) =
        vehicles.iter().fold((0u32, 0u32), |(bots, scripted), v| {
            (
                bots + u32::from(is_bot_nickname(&v.name)),
                scripted + u32::from(is_scripted_unit_nickname(&v.name)),
            )
        });
    let own = vehicles.iter().find(|v| v.relation == 0);
    let own_ship_id = own.map(|v| v.ship_id);
    // The recorder's identity: the descriptor's own `playerName` (the
    // client writes it verbatim, Lesta included) with the relation-0 roster
    // entry's `name` as the fallback for headers that omit it. Roster names
    // are player nicknames on both clients — the descriptor carries no ship
    // name, which is why the list card titles a replay with this.
    let player_name = obj
        .and_then(|o| o.get("playerName"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            own.map(|v| v.name.trim().to_owned())
                .filter(|name| !name.is_empty())
        });

    ReplayMetaLite {
        path,
        date_time,
        match_group,
        map_name,
        map_id,
        scenario,
        event_type,
        bot_count,
        scripted_unit_count,
        own_ship_id,
        player_name,
        player_count,
        // Filled by the scan that owns the root — see `scan_all_replays_meta`.
        install_path: None,
        install_kind: None,
        install_realm: None,
    }
}

/// Public re-export so `arena_info` can reuse the exact same JSON extraction
/// (the live `tempArenaInfo.json` shares the replay's dual-format header).
pub fn extract_descriptor_json_pub(bytes: &[u8]) -> Option<String> {
    extract_descriptor_json(bytes)
}

/// Public re-export of [`meta_from_raw`] for `arena_info` (same JSON shape).
pub fn meta_from_raw_pub(path: String, raw: serde_json::Value) -> ReplayMeta {
    meta_from_raw(path, raw)
}

/// Pull the descriptor JSON out of a replay byte slice. Handles both the
/// binary-prefixed replay format and the bare-JSON `tempArenaInfo.json`
/// variant — the same dual-format logic ApeRadar ships.
///
/// Replay layout: `magic(4) + block_count(4) + [len(4)+payload]×block_count`.
/// The first payload is the match-descriptor JSON.
fn extract_descriptor_json(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        if bytes.first().copied() == Some(b'{') {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        return None;
    }
    if !bytes.starts_with(&REPLAY_MAGIC) {
        if bytes.first().copied() == Some(b'{') {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        return None;
    }
    // magic(4) + block_count(4); first block = len(4) + JSON payload.
    let mut cur = 4;
    let block_count = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
    cur += 4;
    if block_count == 0 {
        return None;
    }
    // First block length.
    if cur + 4 > bytes.len() {
        return None;
    }
    let json_len = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
    cur += 4;
    let end = cur + json_len;
    if end > bytes.len() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes[cur..end]).into_owned())
}

/// Build a [`ReplayMeta`] from the raw descriptor JSON, pulling the common
/// fields defensively. `dateTime` is parsed from the replay filename (the
/// descriptor has no timestamp).
fn meta_from_raw(path: String, raw: serde_json::Value) -> ReplayMeta {
    let obj = raw.as_object();
    let match_group = obj
        .and_then(|o| o.get("matchGroup"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_id = obj.and_then(|o| o.get("mapId")).and_then(|v| v.as_i64());
    let map_name = obj
        .and_then(|o| o.get("mapDisplayName"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let scenario = obj
        .and_then(|o| o.get("scenario"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let event_type = obj
        .and_then(|o| o.get("eventType"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let vehicles = roster_from_raw(std::path::Path::new(&path), &raw);
    let bot_count = vehicles.iter().filter(|v| is_bot_nickname(&v.name)).count() as u32;
    let scripted_unit_count = vehicles
        .iter()
        .filter(|v| is_scripted_unit_nickname(&v.name))
        .count() as u32;

    ReplayMeta {
        // Replay files carry no timestamp in the descriptor (filename wins);
        // the live tempArenaInfo.json HAS a "dateTime" field and no date in
        // its name, so the descriptor is the fallback there.
        date_time: parse_datetime_from_filename(&path).or_else(|| {
            obj.and_then(|o| o.get("dateTime"))
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        }),
        path,
        match_group,
        map_id,
        map_name,
        scenario,
        event_type,
        bot_count,
        scripted_unit_count,
        vehicles,
        raw,
    }
}

/// The client fills bot rosters with colon-wrapped nicknames (`:Sturdee:`)
/// and scripted scenario units with their text-key / scenario-style nickname
/// (see [`is_scripted_unit_nickname`]) — the same markers the frontend's
/// `isAiName` uses to skip WG API lookups. Mirrors that
/// `^(?::.*:|IDS_.*|#.+)$` rule.
pub(crate) fn is_bot_nickname(name: &str) -> bool {
    is_scripted_unit_nickname(name)
        || (name.len() >= 2 && name.starts_with(':') && name.ends_with(':'))
}

/// Scripted scenario units — operation (行动) fleets whose nickname is the
/// client text key (`IDS_OP_15_DUMMY_01`, `IDS_SCENARIO_...`, the tutorial
/// `IDS_AL_01`/`IDS_EN_01`) or the `#Name` scenario style. Unlike the
/// `:Name:` bots that official co-op / random battles fill, these field only
/// in scripted scenarios (operations and the intro/tutorial battles), so
/// their count doubles as an operation fingerprint for the frontend mode
/// classifier (see `ReplayMeta::scripted_unit_count`).
pub(crate) fn is_scripted_unit_nickname(name: &str) -> bool {
    name.starts_with("IDS_") || (name.len() >= 2 && name.starts_with('#'))
}

/// Whether this battle is a REAL operation (行动) — the PCVO*/`_op_`/`_hl_`
/// descriptor fingerprints plus the roster scan for arena files whose
/// descriptor carries no scenario (a `pve` matchGroup with `IDS_OP_*`
/// nicknames), EXCLUDING the tutorial family (`low_lvl_operation`,
/// `first_battle`, the `IDS_OP_15_*` escort op) whose scripted units field
/// as real team rows. Exact mirror of the frontend's `isOperationBattle`
/// (utils/modeColors.ts): the live surfaces' scripted-unit filtering
/// (arena_info's `note_arena_seen` here, the webui's `splitLiveRosterSides`)
/// keys on the same rule on both sides of the IPC boundary, so the sink
/// solver's ally block and the frontend's ally order stay index-aligned.
pub(crate) fn is_operation_battle(
    match_group: Option<&str>,
    scenario: Option<&str>,
    event_type: Option<&str>,
    vehicles: &[wowsp_tauri_shared::VehicleEntry],
) -> bool {
    let sc = scenario.unwrap_or("").to_lowercase();
    let et = event_type.unwrap_or("").to_lowercase();
    if sc.starts_with("low_lvl_operation") || sc == "first_battle" {
        return false;
    }
    if et.starts_with("low_lvl_operation") || et == "first_battle" {
        return false;
    }
    if vehicles
        .iter()
        .any(|v| v.name.to_uppercase().starts_with("IDS_OP_15_"))
    {
        return false;
    }
    if et.starts_with("pcvo") || sc.starts_with("pcvo") {
        return true;
    }
    if et.contains("_op_") || sc.contains("_op_") || sc.contains("_hl_") {
        return true;
    }
    match_group.unwrap_or("").eq_ignore_ascii_case("pve")
        && vehicles
            .iter()
            .any(|v| v.name.to_uppercase().starts_with("IDS_OP_"))
}

/// Filenames look like `20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay`;
/// the leading `YYYYMMDD_HHMMSS` is the only timestamp source. Both segments
/// are 8/6 pure digits; we return them joined by `_` when both are present,
/// falling back to the date alone if only the first matches.
fn parse_datetime_from_filename(path: &str) -> Option<String> {
    let name = std::path::Path::new(path).file_name()?.to_str()?;
    let mut parts = name.split('_');
    let date = parts.next()?;
    let is_digits = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_digit());
    if !is_digits(date, 8) {
        return None;
    }
    match parts.next() {
        Some(t) if is_digits(t, 6) => Some(format!("{date}_{t}")),
        _ => Some(date.to_owned()),
    }
}

fn parse_vehicle_entry(v: &serde_json::Value) -> Option<VehicleEntry> {
    let obj = v.as_object()?;
    Some(VehicleEntry {
        id: obj.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
        name: obj
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_owned(),
        relation: obj.get("relation").and_then(|x| x.as_i64()).unwrap_or(0),
        ship_id: obj.get("shipId").and_then(|x| x.as_i64()).unwrap_or(0),
        ship_name: None,
    })
}

/// The roster behind a parsed descriptor — the single source shared by the
/// full ([`meta_from_raw`]) and lite ([`lite_from_raw`]) projections, never
/// duplicated. WG descriptors carry the roster inline (`vehicles`); a
/// descriptor without one is the Lesta container, whose roster is
/// synthesized from block[1]/block[2] ([`lesta_roster`]).
fn roster_from_raw(path: &std::path::Path, raw: &serde_json::Value) -> Vec<VehicleEntry> {
    if let Some(arr) = raw.get("vehicles").and_then(|v| v.as_array()) {
        return arr.iter().filter_map(parse_vehicle_entry).collect();
    }
    lesta_roster(path, raw)
}

/// One positional `playersPublicInfo` entry (see the module docs for the
/// layout). Every slot is pulled defensively: an entry without its identity
/// slots is dropped, missing optional slots heal to WG-neutral defaults.
struct LestaPlayer {
    id: i64,
    name: String,
    team: i64,
    ship_id: i64,
}

/// Parse one `playersPublicInfo` positional array: `[0]` account id, `[1]`
/// name, `[6]` team (0/1), `[7]` shipId.
fn parse_lesta_player(entry: &serde_json::Value) -> Option<LestaPlayer> {
    let arr = entry.as_array()?;
    let get_i64 = |i: usize| arr.get(i).and_then(|v| v.as_i64());
    let get_str = |i: usize| arr.get(i).and_then(|v| v.as_str());
    Some(LestaPlayer {
        id: get_i64(0)?,
        name: get_str(1)?.to_owned(),
        team: get_i64(6).unwrap_or(0),
        ship_id: get_i64(7).unwrap_or(0),
    })
}

/// Synthesize a WG-shaped roster for a Lesta descriptor (no `vehicles`):
/// block[1] carries the roster as `playersPublicInfo` positional arrays,
/// block[2] pins the recorder. Relations follow the WG rule once the
/// recorder is known — 0 for the recorder, 1 for its team, 2 for the other.
///
/// Defensive throughout: a block[1]/block[2] that is missing, unparseable
/// or roster-less degrades to an empty list (the descriptor's own fields
/// still parse) — a Lesta header read must never fail the whole parse.
fn lesta_roster(path: &std::path::Path, descriptor: &serde_json::Value) -> Vec<VehicleEntry> {
    let players: Vec<LestaPlayer> = read_block(path, 1)
        .ok()
        .and_then(|payload| {
            serde_json::from_str::<serde_json::Value>(&String::from_utf8_lossy(&payload)).ok()
        })
        .and_then(|raw| {
            raw.get("playersPublicInfo")
                .and_then(|v| v.as_object())
                .map(|entries| entries.values().filter_map(parse_lesta_player).collect())
        })
        .unwrap_or_default();
    if players.is_empty() {
        return Vec::new();
    }
    // The recorder: block[2]'s leading integer (`"<accountDBID>.<arenaID>"`)
    // when it lands on a roster entry, else the descriptor's `playerName`
    // matched against the names, else the first positive-id (human) entry.
    let recorder_from_marker = read_block(path, 2).ok().and_then(|payload| {
        let text = String::from_utf8_lossy(&payload);
        text.trim()
            .split('.')
            .next()
            .and_then(|head| head.trim().parse::<i64>().ok())
    });
    let self_idx = recorder_from_marker
        .and_then(|id| players.iter().position(|p| p.id == id))
        .or_else(|| {
            descriptor
                .get("playerName")
                .and_then(|v| v.as_str())
                .and_then(|name| players.iter().position(|p| p.name == name))
        })
        .or_else(|| players.iter().position(|p| p.id > 0));
    let Some(self_idx) = self_idx else {
        return Vec::new();
    };
    let self_team = players[self_idx].team;
    players
        .into_iter()
        .enumerate()
        .map(|(i, p)| VehicleEntry {
            relation: if i == self_idx {
                0
            } else if p.team == self_team {
                1
            } else {
                2
            },
            id: p.id,
            name: p.name,
            ship_id: p.ship_id,
            ship_name: None,
        })
        .collect()
}

/// Default replay dir when neither an explicit `dir` nor the env pins name
/// one. Desktop resolves through the unified game context in its user-scoped
/// order — the persisted active install, then the running client, then the
/// first detected install — instead of blindly taking the first registry hit
/// (on multi-install machines that could be a folder the user never selected
/// and nothing is writing to). Mobile replays live in the app-private
/// managed dir (`<app_data>/replays`), filled by the pairing / import flow —
/// there is no game install to auto-detect on a phone.
#[cfg(desktop)]
fn default_replay_dir() -> Result<PathBuf, String> {
    super::game_context::resolve_root(super::game_context::RootPreference::PreferActive)
        .map(|ctx| super::game_context::replays_dir(&ctx.root))
        .ok_or_else(|| {
            "no replay dir: pass `dir`, or set WOWSP_REPLAY_DIR / WOWSP_GAME_PATH".into()
        })
}

#[cfg(mobile)]
fn default_replay_dir() -> Result<PathBuf, String> {
    crate::paths::ensure_data_dir().map(|d| d.join("replays"))
}

/// Resolve the replay dir the caller asked for (explicit → env override →
/// platform default). Shared with the pairing module, which writes imports /
/// pulls into the same dir the local listing reads.
pub(crate) fn resolve_replay_dir(dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = dir {
        return Ok(PathBuf::from(d));
    }
    if let Ok(d) = std::env::var("WOWSP_REPLAY_DIR") {
        return Ok(PathBuf::from(d));
    }
    if let Ok(game) = std::env::var("WOWSP_GAME_PATH") {
        return Ok(PathBuf::from(game).join("replays"));
    }
    default_replay_dir()
}

/// One replay file surfaced by [`walk_replays`]: its path, modification
/// time (the listings' newest-first sort key) and length in bytes (the
/// playtime battle ledger's cache-identity half, alongside the mtime).
pub(crate) struct WalkedReplay {
    pub path: PathBuf,
    pub mtime: std::time::SystemTime,
    pub len: u64,
}

/// Recursively collect every replay container under `dir` (both clients'
/// extensions; the live `temp.*` files are skipped — see below). Shared by
/// the listing commands, the pairing server's replay route and the playtime
/// battle ledger (single source of truth — never duplicate the walk).
pub(crate) fn walk_replays(dir: &PathBuf, out: &mut Vec<WalkedReplay>) {
    // The game writes a live temp container during a match (`temp.<ext>` for
    // each client family's container extension — WG: temp.wowsreplay, Lesta:
    // temp.korablireplay); it is not a completed replay. The frontend renders
    // it as a live-battle entry instead of listing it here. Generated from
    // the compat registry so a future family needs no edit here; the match
    // stays exact (case-sensitive) on the file name, as before.
    let temp_names: Vec<String> = super::game_client::replay_extensions()
        .into_iter()
        .map(|ext| format!("temp.{ext}"))
        .collect();
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else { continue };
        if meta.is_dir() {
            walk_replays(&path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(is_replay_extension)
        {
            let is_temp = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| temp_names.iter().any(|temp| n == temp.as_str()));
            if is_temp {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
                out.push(WalkedReplay {
                    path,
                    mtime,
                    len: meta.len(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::GameInstallKind;

    /// The Lesta arena synthesis joins roster entries to ship entities by
    /// unique EntityCreate shipId, skips mirror picks (two roster entries on
    /// one shipId) instead of guessing, marks the recorder via relation 0,
    /// carries the create-state starting health through, and leaves an
    /// already-decoded arena list untouched.
    #[test]
    fn lesta_arena_synthesis_joins_unique_and_skips_mirrors() {
        let kind = |eid: i32, ship_id: Option<i64>, max_health: Option<u32>| {
            (
                eid,
                wowsp_tauri_shared::EntityKind {
                    entity_type: 2,
                    vehicle_id: 0,
                    initial_x: 0.0,
                    initial_y: 0.0,
                    initial_z: 0.0,
                    creation_time: 0.0,
                    ship_id,
                    max_health,
                    radius: None,
                    control_point_index: None,
                    initial_team: None,
                },
            )
        };
        let kinds: std::collections::BTreeMap<_, _> = [
            kind(10, Some(101), Some(42_500)),
            kind(11, Some(102), Some(12_000)),
            kind(12, Some(103), Some(9_999)),
            kind(13, Some(103), Some(9_999)),
            kind(14, None, None),
        ]
        .into();
        let mut arena = Vec::new();
        let roster = vec![
            VehicleEntry {
                id: 1,
                name: "me".into(),
                relation: 0,
                ship_id: 101,
                ship_name: None,
            },
            VehicleEntry {
                id: -2,
                name: ":Bot:".into(),
                relation: 1,
                ship_id: 102,
                ship_name: None,
            },
            VehicleEntry {
                id: 3,
                name: "foe-a".into(),
                relation: 2,
                ship_id: 103,
                ship_name: None,
            },
            VehicleEntry {
                id: 4,
                name: "foe-b".into(),
                relation: 2,
                ship_id: 103,
                ship_name: None,
            },
            VehicleEntry {
                id: 5,
                name: "no-ship".into(),
                relation: 1,
                ship_id: 0,
                ship_name: None,
            },
        ];
        synthesize_lesta_arena_players(&mut arena, &kinds, &roster);
        // Mirror-picked 103 (two roster entries, two entities) joins
        // nothing; shipId-less entity 14 and the ship_id-0 entry join
        // nothing.
        assert_eq!(arena.len(), 2);
        let me = arena.iter().find(|p| p.is_self).unwrap();
        assert_eq!((me.entity_id, me.team_id, me.player_id), (10, 0, 1));
        assert_eq!(me.max_health, 42_500);
        let bot = arena.iter().find(|p| p.player_id == -2).unwrap();
        assert_eq!((bot.entity_id, bot.team_id, bot.is_bot), (11, 0, true));
        assert_eq!(bot.max_health, 12_000);
        // The two mirror entities keep no identity (frontend heuristics).
        assert!(!arena.iter().any(|p| p.entity_id == 12 || p.entity_id == 13));
    }

    /// An arena list that already decoded (WG path) or an empty roster keeps
    /// the synthesis a no-op.
    #[test]
    fn lesta_arena_synthesis_is_noop_when_unneeded() {
        let kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> =
            std::collections::BTreeMap::new();
        let mut arena = Vec::new();
        synthesize_lesta_arena_players(&mut arena, &kinds, &[]);
        assert!(arena.is_empty());

        let mut populated = vec![wowsp_tauri_shared::ArenaPlayer {
            entity_id: 1,
            team_id: 0,
            player_id: 7,
            ship_params_id: 42,
            max_health: 100,
            name: "wg".into(),
            is_bot: false,
            avatar_id: None,
            is_self: true,
        }];
        let before: Vec<_> = populated
            .iter()
            .map(|p| (p.entity_id, p.player_id, p.max_health))
            .collect();
        synthesize_lesta_arena_players(
            &mut populated,
            &kinds,
            &[VehicleEntry {
                id: 9,
                name: "x".into(),
                relation: 0,
                ship_id: 1,
                ship_name: None,
            }],
        );
        let after: Vec<_> = populated
            .iter()
            .map(|p| (p.entity_id, p.player_id, p.max_health))
            .collect();
        assert_eq!(after, before);
    }

    /// HP property detection picks the index whose series behave like HP
    /// (start full, plausible magnitude, no wild upward jumps) under either
    /// int or float interpretation, regardless of game version.
    #[test]
    fn detect_hp_property_scores_by_magnitude() {
        let mut kinds = std::collections::BTreeMap::new();
        kinds.insert(
            1,
            wowsp_tauri_shared::EntityKind {
                entity_type: 2,
                vehicle_id: 7770,
                initial_x: 0.0,
                initial_y: 0.0,
                initial_z: 0.0,
                creation_time: 0.0,
                ship_id: None,
                max_health: None,
                radius: None,
                control_point_index: None,
                initial_team: None,
            },
        );
        let change =
            |property_index: u32, value: u32, size: u8| super::super::packets::PropertyChange {
                time: 0.0,
                entity_id: 1,
                property_index,
                value,
                size,
            };
        // Float HP at 28 (14.5 layout), int noise at 20 (starts full but jumps
        // +86% in one step -> rejected).
        let hp = |v: f32| change(28, v.to_bits(), 4);
        let props = std::collections::BTreeMap::from([(
            1,
            vec![
                hp(70011.0),
                hp(65500.0),
                hp(60100.0),
                hp(52300.0),
                change(20, 31454, 2),
                change(20, 4603, 2),
                change(20, 31737, 2),
                change(20, 31736, 2),
            ],
        )]);
        assert_eq!(detect_hp_property(&kinds, &props), (28, HpValueKind::Float));

        // Int HP at 21 (0.11.x-style integer stream, smooth decline).
        let props_int = std::collections::BTreeMap::from([(
            1,
            vec![
                change(21, 20340, 4),
                change(21, 19800, 4),
                change(21, 18500, 4),
                change(21, 17000, 4),
            ],
        )]);
        assert_eq!(
            detect_hp_property(&kinds, &props_int),
            (21, HpValueKind::Int)
        );

        // No plausible HP anywhere -> default (20, Int).
        let props_none = std::collections::BTreeMap::from([(1, vec![change(7, 5, 1)])]);
        assert_eq!(
            detect_hp_property(&kinds, &props_none),
            (20, HpValueKind::Int)
        );
    }

    /// Streams that first report a damaged reading get the arena starting
    /// health prepended at t=0; streams already opening full, entities the
    /// arena does not know, and empty streams stay untouched.
    #[test]
    fn anchor_hp_streams_prepends_starting_health() {
        let sample = |time: f32, value: u32| wowsp_tauri_shared::HpSample { time, value };
        let arena = |entity_id: i32, max_health: u32| wowsp_tauri_shared::ArenaPlayer {
            entity_id,
            team_id: 0,
            player_id: 0,
            ship_params_id: 0,
            max_health,
            name: String::new(),
            is_bot: false,
            avatar_id: None,
            is_self: false,
        };
        // Damaged first reading at t=151.6 (the L-20 replay's own sub).
        let mut hp_map = std::collections::BTreeMap::from([
            (1, vec![sample(151.6, 9_168), sample(330.7, 8_541)]),
            // Already opens at the starting health: no duplicate anchor.
            (2, vec![sample(30.2, 69_650), sample(90.0, 66_000)]),
            // Not in the arena: nothing to anchor from.
            (3, vec![sample(120.0, 500)]),
            // Zero max_health entry is not a usable anchor.
            (4, vec![sample(80.0, 300)]),
        ]);
        let players = vec![arena(1, 14_000), arena(2, 69_650), arena(4, 0)];
        anchor_hp_streams(&mut hp_map, &players);
        let head = |eid: i32| hp_map.get(&eid).map(|s| (s[0].time, s[0].value));
        assert_eq!(
            head(1),
            Some((0.0, 14_000)),
            "damaged stream gains a full-health t=0 anchor"
        );
        assert_eq!(hp_map.get(&1).map(Vec::len), Some(3));
        assert_eq!(
            head(2),
            Some((30.2, 69_650)),
            "already-full stream is not duplicated"
        );
        assert_eq!(
            head(3),
            Some((120.0, 500)),
            "arena-unknown entity stays untouched"
        );
        assert_eq!(
            head(4),
            Some((80.0, 300)),
            "zero max-health entry anchors nothing"
        );
        // An empty stream stays empty (no-damage ships keep the frontend's
        // full-health initial label).
        let mut empty_map = std::collections::BTreeMap::from([(5, Vec::new())]);
        anchor_hp_streams(&mut empty_map, &[arena(5, 23_200)]);
        assert!(empty_map.get(&5).is_some_and(Vec::is_empty));
    }

    /// Synthetic replay: magic + 1 block + a tiny JSON descriptor. Verifies the
    /// block-count format is parsed correctly (the bug the skeleton had).
    #[test]
    fn parses_synthetic_replay_header() {
        let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        let extracted = extract_descriptor_json(&bytes).expect("must extract JSON");
        assert!(extracted.contains("15_NE_north"));
        let raw: serde_json::Value = serde_json::from_str(&extracted).unwrap();
        let meta = meta_from_raw("20250622_152405_x.wowsreplay".into(), raw);
        assert_eq!(meta.map_name.as_deref(), Some("15_NE_north"));
        assert_eq!(meta.map_id, Some(8));
        assert_eq!(meta.match_group.as_deref(), Some("pvp"));
        // dateTime now retains the full YYYYMMDD_HHMMSS from the filename.
        assert_eq!(meta.date_time.as_deref(), Some("20250622_152405"));
    }

    /// Datetime parser keeps the time-of-day segment and tolerates a date-only
    /// filename (older clients / renamed files).
    #[test]
    fn datetime_parser_keeps_time_or_date() {
        assert_eq!(
            parse_datetime_from_filename("20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay")
                .as_deref(),
            Some("20250622_152405"),
        );
        assert_eq!(
            parse_datetime_from_filename("20250622_someother.wowsreplay").as_deref(),
            Some("20250622"),
        );
        assert!(parse_datetime_from_filename("replay.wowsreplay").is_none());
    }

    /// The lite projection counts players and finds the recorder's ship
    /// (relation == 0) without retaining the roster or raw JSON.
    #[test]
    fn lite_from_raw_finds_own_ship() {
        let json = r#"{"matchGroup":"ranked","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[
            {"id":1,"name":"Alpha","relation":0,"shipId":4182828960},
            {"id":2,"name":"Bravo","relation":1,"shipId":4286591792},
            {"id":3,"name":"Enemy","relation":2,"shipId":4292851696}
        ]}"#;
        let raw: serde_json::Value = serde_json::from_str(json).unwrap();
        let lite = lite_from_raw(
            "20250622_152405_x.wowsreplay".into(),
            Some("20250622_152405".into()),
            raw,
        );
        assert_eq!(lite.match_group.as_deref(), Some("ranked"));
        assert_eq!(lite.map_name.as_deref(), Some("15_NE_north"));
        assert_eq!(lite.player_count, 3);
        assert_eq!(lite.own_ship_id, Some(4182828960));
        assert_eq!(lite.player_name.as_deref(), Some("Alpha"));
    }

    /// Unique temp file path for `lite_from_path` tests (this crate has no
    /// tempfile dev-dependency): the system temp dir + the given base + a
    /// per-process counter. The counter rides AFTER the base so a base that
    /// opens with `YYYYMMDD_HHMMSS` still parses as the filename datetime.
    /// Callers remove the file when done.
    fn temp_replay_path(base: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("{base}_{n}.wowsreplay"))
    }

    /// The walk surfaces both clients' containers (`.wowsreplay` and the
    /// Lesta `.korablireplay`) but never either client's live temp file.
    #[test]
    fn walk_replays_lists_both_containers_and_skips_temps() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-walk-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "20261001_024940_PRSB910-Kremlin_15_NE_north.wowsreplay",
            "20261001_031102_PRSB910-Kremlin_15_NE_north.korablireplay",
            "temp.wowsreplay",
            "temp.korablireplay",
            "tempArenaInfo.json",
            "notes.txt",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let mut out = Vec::new();
        walk_replays(&dir, &mut out);
        let mut names: Vec<_> = out
            .iter()
            .map(|e| e.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "20261001_024940_PRSB910-Kremlin_15_NE_north.wowsreplay".to_string(),
                "20261001_031102_PRSB910-Kremlin_15_NE_north.korablireplay".to_string(),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// An omitted `limit` caps nothing: the scan lists EVERY replay in the
    /// tree — root files and version-archive subfolder files alike. 205
    /// root files + 1 archived = 206; the retired implicit 200-cap would
    /// have dropped six of these entries after its mtime-desc truncation,
    /// which is exactly how archived history used to vanish.
    #[test]
    fn scan_replays_meta_without_limit_keeps_version_archives() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-scan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("14.5.0.0")).unwrap();
        for i in 0..205 {
            std::fs::write(dir.join(format!("20250101_{:06}_a.wowsreplay", i)), b"x").unwrap();
        }
        std::fs::write(
            dir.join("14.5.0.0")
                .join("20250622_152405_archived.wowsreplay"),
            b"x",
        )
        .unwrap();
        let (root, entries) = scan_replays_meta(Some(dir.to_string_lossy().into_owned()), None)
            .unwrap_or_else(|e| panic!("scan failed: {e}"));
        assert_eq!(root, dir);
        assert_eq!(entries.len(), 206);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Extension test is case-insensitive and covers both spellings.
    #[test]
    fn is_replay_extension_matches_both_clients() {
        assert!(is_replay_extension("wowsreplay"));
        assert!(is_replay_extension("korablireplay"));
        assert!(is_replay_extension("WoWsRePlay"));
        assert!(!is_replay_extension("json"));
        assert!(!is_replay_extension(""));
    }

    /// `lite_from_path` fills the summary fields from the FIRST block only:
    /// the descriptor parses even though a fat (here: garbage) packet stream
    /// follows, because the bounded header read never touches it.
    #[test]
    fn lite_from_path_reads_bounded_first_block() {
        let path = temp_replay_path("20250622_152405_lite");
        let json = r#"{"matchGroup":"ranked","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[
            {"id":1,"name":"Alpha","relation":0,"shipId":4182828960},
            {"id":2,"name":"Bravo","relation":1,"shipId":4286591792}
        ]}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        // Stand-in for the encrypted packet stream a real replay carries —
        // several MB in production, never read by the listing path.
        bytes.extend_from_slice(&[0u8; 4096]);
        std::fs::write(&path, &bytes).expect("write temp replay");
        let lite = lite_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(lite.date_time.as_deref(), Some("20250622_152405"));
        assert_eq!(lite.match_group.as_deref(), Some("ranked"));
        assert_eq!(lite.map_name.as_deref(), Some("15_NE_north"));
        assert_eq!(lite.map_id, Some(8));
        assert_eq!(lite.player_count, 2);
        assert_eq!(lite.own_ship_id, Some(4182828960));
        // No `playerName` in this descriptor — the relation-0 roster name
        // stands in as the recorder's identity.
        assert_eq!(lite.player_name.as_deref(), Some("Alpha"));
        // A single-dir scan tags nothing: the owner is only known to the
        // all-clients scan (see the tagging test below).
        assert!(lite.install_path.is_none());
        assert!(lite.install_kind.is_none());
        assert!(lite.install_realm.is_none());
    }

    /// The recorder's nickname wins from the descriptor's own `playerName`
    /// (the CN client fills it with the account name), and a blank value
    /// falls back to the relation-0 roster entry — a header that carries
    /// neither answers `None` instead of an empty identity.
    #[test]
    fn lite_from_raw_prefers_descriptor_player_name_with_roster_fallback() {
        let raw = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
        let vehicles = r#""vehicles":[{"id":1,"name":"langyo","relation":0,"shipId":7}]"#;

        let named = lite_from_raw(
            "a.wowsreplay".into(),
            Some("20261008_003254".into()),
            raw(&format!(r#"{{"playerName":"神楽坂柚咲",{vehicles}}}"#)),
        );
        assert_eq!(named.player_name.as_deref(), Some("神楽坂柚咲"));

        let blank = lite_from_raw(
            "b.wowsreplay".into(),
            None,
            raw(&format!(r#"{{"playerName":"   ",{vehicles}}}"#)),
        );
        assert_eq!(blank.player_name.as_deref(), Some("langyo"));

        let headerless = lite_from_raw("c.wowsreplay".into(), None, raw(r#"{"matchGroup":"pvp"}"#));
        assert!(headerless.player_name.is_none());
        assert!(headerless.own_ship_id.is_none());
    }

    /// The all-clients scan walks every root it is handed and stamps each
    /// entry with that root's owning install — kind + realm + path — while
    /// files under an unowned root stay untagged (they belong to no client
    /// to label or filter by). The newest-first mtime order and the
    /// explicit limit apply across the whole set, not per root.
    #[test]
    fn scan_roots_meta_tags_entries_with_their_owning_install() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-all-roots-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let steam_replays = dir.join("steam").join("replays");
        let cn_replays = dir.join("cn360").join("replays");
        let loose = dir.join("loose");
        for root in [&steam_replays, &cn_replays, &loose] {
            std::fs::create_dir_all(root).unwrap();
        }
        // Write each file and PIN its mtime one day apart: the scan's
        // newest-first order (and the cap test below) keys on mtime, and a
        // CI runner's filesystem can stamp three rapid writes with the SAME
        // timestamp — the stable sort would then fall back to insertion
        // order and "newest survived the cap" would depend on write order.
        let write_stamped = |path: PathBuf, at: std::time::SystemTime| {
            std::fs::write(&path, b"not a replay").unwrap();
            // Write access, not the read-only `File::open` — Windows denies
            // setting the modified time through a read-only handle.
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(at)
                .unwrap();
        };
        let day = |n: u64| {
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000 + n * 86_400)
        };
        write_stamped(steam_replays.join("20261001_100000_a.wowsreplay"), day(0));
        write_stamped(cn_replays.join("20261002_100000_b.wowsreplay"), day(1));
        write_stamped(loose.join("20261003_100000_c.wowsreplay"), day(2));

        let install = |kind: GameInstallKind, path: &std::path::Path, realm: &str| GameInstall {
            kind,
            path: path.to_string_lossy().into_owned(),
            realm: Some(realm.to_string()),
        };
        let roots = vec![
            (
                steam_replays.clone(),
                Some(install(GameInstallKind::Steam, &dir.join("steam"), "asia")),
            ),
            (
                cn_replays.clone(),
                Some(install(GameInstallKind::Cn360, &dir.join("cn360"), "cn")),
            ),
            (loose.clone(), None),
        ];
        let entries = scan_roots_meta(&roots, None);
        assert_eq!(entries.len(), 3, "every root contributes its files");
        let by_name = |needle: &str| {
            entries
                .iter()
                .find(|e| e.path.contains(needle))
                .unwrap_or_else(|| panic!("missing {needle}"))
        };
        let steam = by_name("20261001_100000_a");
        assert_eq!(steam.install_realm.as_deref(), Some("asia"));
        assert_eq!(steam.install_kind, Some(GameInstallKind::Steam));
        assert_eq!(
            steam.install_path.as_deref(),
            Some(dir.join("steam").to_string_lossy().as_ref())
        );
        let cn = by_name("20261002_100000_b");
        assert_eq!(cn.install_realm.as_deref(), Some("cn"));
        assert_eq!(cn.install_kind, Some(GameInstallKind::Cn360));
        let untagged = by_name("20261003_100000_c");
        assert!(untagged.install_path.is_none());
        assert!(untagged.install_kind.is_none());
        assert!(untagged.install_realm.is_none());

        // The cap applies to the whole set AFTER the newest-first sort, so a
        // capped scan keeps the freshest files (the archived-history trap the
        // single-root scan's contract calls out) — and 0 answers nothing,
        // exactly like the single-root scan's `.take(0)`.
        let capped = scan_roots_meta(&roots, Some(1));
        assert_eq!(capped.len(), 1);
        assert!(
            capped[0].path.contains("20261003_100000_c"),
            "the newest file survived the cap: {}",
            capped[0].path
        );
        assert!(scan_roots_meta(&roots, Some(0)).is_empty());
        // Identical roots listed twice must not duplicate entries.
        let doubled = {
            let mut both = roots.clone();
            both.push(roots[0].clone());
            scan_roots_meta(&both, None)
        };
        assert_eq!(doubled.len(), 3, "one file, one entry");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A file truncated mid-prologue (4 bytes) falls back to the path +
    /// filename-datetime lite entry — listed, never a panic.
    #[test]
    fn lite_from_path_falls_back_on_truncated_file() {
        let path = temp_replay_path("20250701_101010_trunc");
        std::fs::write(&path, REPLAY_MAGIC).expect("write truncated replay");
        let lite = lite_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(lite.path, path.to_string_lossy());
        assert_eq!(lite.date_time.as_deref(), Some("20250701_101010"));
        assert_eq!(lite.match_group, None);
        assert_eq!(lite.map_name, None);
        assert_eq!(lite.map_id, None);
        assert_eq!(lite.bot_count, 0);
        assert_eq!(lite.player_count, 0);
        assert_eq!(lite.own_ship_id, None);
    }

    /// Unique temp path with the Lesta `.korablireplay` extension (the same
    /// per-process counter scheme as [`temp_replay_path`]; the filename
    /// datetime parser reads the base name either way).
    fn temp_korabli_path(base: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("{base}_{n}.korablireplay"))
    }

    /// A synthetic Lesta `.korablireplay` modeled on the real container: the
    /// WG framing with the Lesta 4-block payload set — [0] descriptor
    /// (modeled on the real schema, NO `vehicles`), [1] roster JSON whose
    /// `playersPublicInfo` positional arrays mirror the verified positions
    /// ([0] id, [1] name, [2] clanDBID, [3] clan tag, [6] team, [7] shipId,
    /// [9] realm, [15] max HP), [2] recorder marker (parameterized so the
    /// fallback test can corrupt it), [3] checksum hex. The roster mixes all
    /// four relation cases: the recorder, a same-team human, an enemy
    /// `:Bot:` and an enemy `IDS_OP_X` scripted unit.
    fn write_synthetic_lesta_replay(path: &std::path::Path, recorder_marker: &str) {
        let descriptor = r#"{"matchGroup":"cooperative","mapDisplayName":"28_naval_mission",
            "mapId":17,"mapName":"spaces/28_naval_mission","scenario":"domination_sandbox_3point_alt_5-6_coop",
            "eventType":"","gameType":"CooperativeBattle","clientVersionFromExe":"26,10,0,8867689",
            "playerName":"langyo","playerVehicle":"PRSB505-Oktyabrskaya-Revolutsiya"}"#;
        let roster = r#"{"accountDBID":1000000001,"arenaUniqueID":1234567890123456,
            "keepUntilTime":0,"playersPublicInfo":{
            "1000000001":[1000000001,"langyo",0,"",0,-1,1,3340711376,0,"RU",[],0,0,-1,0,42500],
            "88240732":[88240732,"karasik60",0,"",0,-1,1,3765352400,0,"RU",[],0,0,-1,0,29400],
            "-268475967":[-268475967,":Bot:",0,"",0,-1,0,4184815568,0,"RU",[],0,0,-1,0,41200],
            "-624526534":[-624526534,"IDS_OP_X",0,"",0,-1,0,4179539408,0,"RU",[],0,0,-1,0,65400]}}"#;
        let checksum = "53BB63FBD4C37D37CF945F0BD78B1EAC";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&REPLAY_MAGIC);
        bytes.extend_from_slice(&4u32.to_le_bytes()); // Lesta writes 4 blocks
        for block in [descriptor, roster, recorder_marker, checksum] {
            bytes.extend_from_slice(&(block.len() as u32).to_le_bytes());
            bytes.extend_from_slice(block.as_bytes());
        }
        // Stand-in for the encrypted packet stream (identical WG scheme).
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(path, &bytes).expect("write synthetic korablireplay");
    }

    /// A Lesta descriptor (no `vehicles`) synthesizes the roster from
    /// block[1]'s `playersPublicInfo` with block[2] pinning the recorder:
    /// relations come out exactly 0/1/2, and the existing bot/scripted
    /// classifiers apply unchanged (Lesta kept WG's bot markers).
    #[test]
    fn lesta_header_synthesizes_roster_from_blocks() {
        let path = temp_korabli_path("20261001_025958_lesta");
        write_synthetic_lesta_replay(&path, "1000000001.1234567890123456");
        // The same internals read_replay_header runs.
        let bytes = std::fs::read(&path).unwrap();
        let json = extract_descriptor_json(&bytes).expect("descriptor block");
        let raw: serde_json::Value = serde_json::from_str(&json).unwrap();
        let meta = meta_from_raw(path.to_string_lossy().into_owned(), raw);
        let _ = std::fs::remove_file(&path);
        assert_eq!(meta.match_group.as_deref(), Some("cooperative"));
        assert_eq!(meta.map_name.as_deref(), Some("28_naval_mission"));
        assert_eq!(meta.vehicles.len(), 4);
        let by_name = |n: &str| meta.vehicles.iter().find(|v| v.name == n).unwrap();
        // block[2] pins the recorder (team 1 here); its team are allies.
        assert_eq!(by_name("langyo").relation, 0);
        assert_eq!(by_name("karasik60").relation, 1);
        assert_eq!(by_name(":Bot:").relation, 2);
        assert_eq!(by_name("IDS_OP_X").relation, 2);
        assert_eq!(by_name("langyo").ship_id, 3340711376);
        assert_eq!(by_name("IDS_OP_X").id, -624526534);
        // `:Bot:` and `IDS_OP_X` are both bot nicknames; only the latter is
        // a scripted unit.
        assert_eq!(meta.bot_count, 2);
        assert_eq!(meta.scripted_unit_count, 1);
    }

    /// The lite projection over a Lesta container carries the full summary:
    /// descriptor fields plus the synthesized roster's counts and recorder.
    #[test]
    fn lite_from_path_parses_synthetic_lesta_replay() {
        let path = temp_korabli_path("20261001_025958_lesta_lite");
        write_synthetic_lesta_replay(&path, "1000000001.1234567890123456");
        let lite = lite_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(lite.date_time.as_deref(), Some("20261001_025958"));
        assert_eq!(lite.match_group.as_deref(), Some("cooperative"));
        assert_eq!(lite.map_name.as_deref(), Some("28_naval_mission"));
        assert_eq!(
            lite.scenario.as_deref(),
            Some("domination_sandbox_3point_alt_5-6_coop")
        );
        assert_eq!(lite.own_ship_id, Some(3340711376));
        assert_eq!(lite.player_name.as_deref(), Some("langyo"));
        // The `IDS_OP_X` scripted unit sits out; the `:Bot:` fill counts.
        assert_eq!(lite.player_count, 3);
        assert_eq!(lite.bot_count, 2);
        assert_eq!(lite.scripted_unit_count, 1);
    }

    /// An unparseable block[2] marker falls back to matching the
    /// descriptor's `playerName` against the roster names — the recorder
    /// still resolves (and with no name match either, the first positive-id
    /// entry would).
    #[test]
    fn lesta_roster_falls_back_to_player_name_when_marker_unparseable() {
        let path = temp_korabli_path("20261001_025958_lesta_fb");
        write_synthetic_lesta_replay(&path, "not-an-id");
        let lite = lite_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            lite.own_ship_id,
            Some(3340711376),
            "playerName langyo pins the recorder when the marker fails"
        );
        assert_eq!(lite.player_name.as_deref(), Some("langyo"));
        assert_eq!(lite.player_count, 3);
    }

    /// A Lesta container missing its roster block entirely (fewer blocks
    /// than the marker read needs) degrades to the descriptor-only entry —
    /// never a failed parse.
    #[test]
    fn lesta_roster_degrades_to_empty_when_blocks_missing() {
        let path = temp_korabli_path("20261001_025958_lesta_thin");
        let descriptor =
            r#"{"matchGroup":"cooperative","mapDisplayName":"28_naval_mission","mapId":17}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes()); // descriptor only
        bytes.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
        bytes.extend_from_slice(descriptor.as_bytes());
        std::fs::write(&path, &bytes).expect("write thin korablireplay");
        let lite = lite_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(lite.match_group.as_deref(), Some("cooperative"));
        assert_eq!(lite.map_name.as_deref(), Some("28_naval_mission"));
        assert_eq!(lite.player_count, 0, "no roster block — empty roster");
        assert_eq!(lite.own_ship_id, None);
    }

    /// Ground-truth validation of the Lesta container crack against the
    /// real replays on this machine: takes the newest
    /// `D:\WoWS_Korabli\replays\*.korablireplay` and runs BOTH the
    /// header-parse internals (roster synthesis from `playersPublicInfo`)
    /// and the full packet-stream decode (Blowfish + zlib + frames — the
    /// unmodified WG scheme). Skips when the Lesta client is not installed.
    /// Run locally with `cargo test -p wowsp_tauri --lib -- --ignored lesta`.
    #[test]
    #[ignore = "needs the real Lesta replays on this machine"]
    fn decodes_the_real_lesta_replays_on_this_machine() {
        let dir = std::path::Path::new(r"D:\WoWS_Korabli\replays");
        let Ok(rd) = fs::read_dir(dir) else {
            return; // no Lesta client on this machine — skip
        };
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        for ent in rd.flatten() {
            let path = ent.path();
            let is_container = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(is_replay_extension)
                && path.file_name().and_then(|n| n.to_str()) != Some("temp.korablireplay");
            if !is_container {
                continue;
            }
            if let Ok(mtime) = ent.metadata().and_then(|m| m.modified()) {
                if newest.as_ref().is_none_or(|(best, _)| mtime > *best) {
                    newest = Some((mtime, path));
                }
            }
        }
        let Some((_, path)) = newest else {
            return; // empty replays dir — skip
        };
        // Header internals (what read_replay_header runs).
        let bytes = fs::read(&path).unwrap();
        let json = extract_descriptor_json(&bytes).expect("descriptor JSON");
        let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor parses");
        let meta = meta_from_raw(path.to_string_lossy().into_owned(), raw);
        assert!(
            meta.match_group.as_deref().is_some_and(|m| !m.is_empty()),
            "matchGroup must parse"
        );
        assert!(
            meta.map_name.as_deref().is_some_and(|m| !m.is_empty()),
            "map name must parse"
        );
        assert!(
            !meta.vehicles.is_empty(),
            "roster must synthesize from playersPublicInfo"
        );
        let own = meta
            .vehicles
            .iter()
            .find(|v| v.relation == 0)
            .expect("recorder entry (relation 0)");
        assert!(own.ship_id > 0, "recorder's shipId must resolve");
        assert!(meta.vehicles.len() >= 2, "player_count >= 2");
        eprintln!(
            "[lesta] {}  map={}  {} players  own={} ({}), bots={} scripted={}",
            path.display(),
            meta.map_name.clone().unwrap_or_default(),
            meta.vehicles.len(),
            own.name,
            own.ship_id,
            meta.bot_count,
            meta.scripted_unit_count
        );
        // Full packet path (what read_replay_positions runs): decrypt +
        // inflate + frames → non-empty trajectories. The roster's shipIds
        // ride along as the entity→player join candidates.
        let stream = packet_stream_after_blocks(&bytes).expect("packet stream after 4 blocks");
        let candidates: std::collections::HashSet<u32> =
            meta.vehicles.iter().map(|v| v.ship_id as u32).collect();
        let version = meta
            .raw
            .get("clientVersionFromExe")
            .and_then(|x| x.as_str());
        let decoded = super::super::packets::decode_replay(stream, &candidates, version, false)
            .expect("decode");
        let grouped = group_by_entity(decoded);
        assert!(
            !grouped.trajectories.is_empty(),
            "trajectories must decode from the packet stream"
        );
        let positioned = grouped
            .trajectories
            .iter()
            .filter(|t| !t.samples.is_empty())
            .count();
        assert!(positioned > 0, "at least one entity must have positions");
        eprintln!(
            "[lesta] {} trajectories ({} with position samples)",
            grouped.trajectories.len(),
            positioned
        );
    }

    /// Custom-room bot rosters (`:Name:` nicknames) are counted; plain PvP
    /// rosters and nicknames that merely CONTAIN a colon are not. Shape mirrors
    /// a real training-room descriptor (matchGroup stays "pvp" there — the
    /// frontend relabels it from botCount + the tournament scenario).
    #[test]
    fn bot_count_fills_from_colon_nicknames() {
        let room = r#"{"matchGroup":"pvp","scenario":"domination_tournament_3point","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":":Tirpitz:","relation":1,"shipId":2},
            {"id":3,"name":":Pohl:","relation":1,"shipId":2},
            {"id":4,"name":":Sturdee:","relation":1,"shipId":2},
            {"id":5,"name":":Yegorov:","relation":2,"shipId":3},
            {"id":6,"name":":Bouvet:","relation":2,"shipId":3},
            {"id":7,"name":":Revel:","relation":2,"shipId":3}
        ]}"#;
        let raw: serde_json::Value = serde_json::from_str(room).unwrap();
        let meta = meta_from_raw("x.wowsreplay".into(), raw.clone());
        let lite = lite_from_raw("x.wowsreplay".into(), None, raw);
        assert_eq!(meta.bot_count, 6);
        assert_eq!(lite.bot_count, 6);
        assert_eq!(lite.player_count, 7);

        let plain = r#"{"matchGroup":"pvp","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"we:ird","relation":2,"shipId":2},
            {"id":3,"name":":","relation":2,"shipId":2}
        ]}"#;
        let raw: serde_json::Value = serde_json::from_str(plain).unwrap();
        let meta = meta_from_raw("x.wowsreplay".into(), raw);
        assert_eq!(meta.bot_count, 0);
    }

    /// Operation rosters mix scripted units (`IDS_*` keys, `#Name` scenario
    /// style) with `:Name:` filler bots — shape from the live ASIA escort-op
    /// arena (`matchGroup: "pve"`, `LOW_LVL_OPERATION_1_LVL_2`). Both halves
    /// are counted so the frontend classifier can tell the operation from
    /// plain co-op, whose rosters carry `:Name:` bots only.
    #[test]
    fn scripted_unit_count_splits_operation_rosters() {
        let op = r##"{"matchGroup":"pve","scenario":"LOW_LVL_OPERATION_1_LVL_2","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_15_ALLY_FLAGSHIP","relation":1,"shipId":2},
            {"id":3,"name":"IDS_OP_15_DUMMY_01","relation":1,"shipId":2},
            {"id":4,"name":"#Krebs","relation":2,"shipId":3},
            {"id":5,"name":":Revel:","relation":2,"shipId":3},
            {"id":6,"name":"#Aylard","relation":2,"shipId":3}
        ]}"##;
        let raw: serde_json::Value = serde_json::from_str(op).unwrap();
        let meta = meta_from_raw("x.wowsreplay".into(), raw.clone());
        let lite = lite_from_raw("x.wowsreplay".into(), None, raw);
        assert_eq!(meta.bot_count, 5);
        assert_eq!(meta.scripted_unit_count, 4);
        assert_eq!(lite.bot_count, 5);
        assert_eq!(lite.scripted_unit_count, 4);
        // Listed players only: the human recorder plus the `:Revel:` co-op
        // fill; the four scripted units sit out.
        assert_eq!(lite.player_count, 2);

        // Plain co-op: `:Name:` bots only — scripted count stays zero.
        let coop = r#"{"matchGroup":"pve","scenario":"domination_3point","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":":Yumashev:","relation":2,"shipId":3},
            {"id":3,"name":":WGR_bot:","relation":2,"shipId":3}
        ]}"#;
        let raw: serde_json::Value = serde_json::from_str(coop).unwrap();
        let meta = meta_from_raw("x.wowsreplay".into(), raw);
        assert_eq!(meta.bot_count, 2);
        assert_eq!(meta.scripted_unit_count, 0);
    }

    /// is_operation_battle — the Rust mirror of the frontend's classifier
    /// (utils/modeColors.ts `isOperationBattle`): the descriptor
    /// fingerprints decide, the tutorial family stays excluded, and the
    /// roster scan is the last resort for arena files whose descriptor
    /// carries no scenario. The live scripted-unit filtering (arena_info's
    /// `note_arena_seen`) keys on it, so the shapes here mirror the
    /// frontend's rosterSides tests.
    #[test]
    fn operation_classifier_mirrors_the_frontend() {
        let roster = |json: &str| {
            let raw: serde_json::Value = serde_json::from_str(json).unwrap();
            meta_from_raw("x.wowsreplay".into(), raw).vehicles
        };
        // The story op (PCVO011_OP_10 Chumphon) — the scenario fingerprint
        // alone decides.
        let story = roster(
            r#"{"matchGroup":"pve","scenario":"PCVO011_OP_10_s10_USS_CL","vehicles":[
            {"id":1,"name":"ShigureKira","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_10_09_GAMBLE","relation":1,"shipId":2},
            {"id":3,"name":"IDS_OP_10_EN_0101","relation":2,"shipId":3}
        ]}"#,
        );
        assert!(is_operation_battle(Some("pve"), None, None, &story));
        assert!(is_operation_battle(
            None,
            None,
            Some("PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL"),
            &story
        ));
        // The tutorial family stays excluded — its scripted units field as
        // real team rows, so the live surfaces keep them listed.
        let tutorial = roster(
            r#"{"matchGroup":"pve","scenario":"LOW_LVL_OPERATION_3_LVL_5A","vehicles":[
            {"id":1,"name":"ShigureKira","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_17_ALLY_FLAGSHIP","relation":1,"shipId":2},
            {"id":3,"name":"IDS_EN_01","relation":2,"shipId":3}
        ]}"#,
        );
        assert!(!is_operation_battle(
            Some("pve"),
            Some("LOW_LVL_OPERATION_3_LVL_5A"),
            None,
            &tutorial
        ));
        assert!(!is_operation_battle(
            Some("pve"),
            Some("first_battle"),
            None,
            &tutorial
        ));
        let escort = roster(
            r#"{"matchGroup":"pve","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_15_DUMMY_01","relation":1,"shipId":2}
        ]}"#,
        );
        assert!(!is_operation_battle(Some("pve"), None, None, &escort));
        // The roster scan is the last resort: pve + IDS_OP_* names with no
        // scenario fingerprint anywhere.
        let bare = roster(
            r#"{"matchGroup":"pve","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_09_FLAGMAN_NAME","relation":1,"shipId":2}
        ]}"#,
        );
        assert!(is_operation_battle(Some("pve"), None, None, &bare));
        // PvP / plain co-op never classify as operations.
        let coop = roster(
            r#"{"matchGroup":"pve","scenario":"domination_3point","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":":Yumashev:","relation":2,"shipId":3}
        ]}"#,
        );
        assert!(!is_operation_battle(Some("pvp"), None, None, &coop));
        assert!(!is_operation_battle(
            Some("pve"),
            Some("domination_3point"),
            None,
            &coop
        ));
    }

    /// If a real replay is available on this machine, parse it end-to-end.
    #[test]
    fn parses_real_replay_if_present() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return; // no real replay on this machine — skip
        };
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let json = extract_descriptor_json(&bytes)
            .unwrap_or_else(|| panic!("no descriptor JSON in {path}"));
        let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor must be JSON");
        let meta = meta_from_raw(path.clone(), raw);
        assert!(!meta.vehicles.is_empty(), "roster must not be empty");
        assert!(meta.map_name.is_some(), "mapDisplayName must be present");
        eprintln!(
            "[real-replay] {}  map={}, {} players",
            path,
            meta.map_name.unwrap(),
            meta.vehicles.len()
        );
    }

    /// Diagnostic: dump a real replay's header + trajectories to JSON, used to
    /// feed the mock backend (`scripts/mock/fixtures/replay_dump.json`) so the
    /// holographic map can render a real match in a browser. Run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_DUMP_OUT=out.json]`.
    #[tokio::test]
    async fn dump_replay_json() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return;
        };
        let meta = read_replay_header(path.clone()).await.expect("header");
        let stream = read_replay_positions(path.clone())
            .await
            .expect("positions");
        // Raw per-entity property timelines for offline analysis (score
        // hunting, property-index identification).
        let bytes = std::fs::read(&path).unwrap();
        let pstream = packet_stream_after_blocks(&bytes).expect("packet stream");
        let mut candidates = std::collections::HashSet::new();
        let mut cver: Option<String> = None;
        if let Some(json) = extract_descriptor_json(&bytes) {
            if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
                cver = raw
                    .get("clientVersionFromExe")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                if let Some(arr) = raw.get("vehicles").and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(id) = v.get("shipId").and_then(|x| x.as_u64()) {
                            candidates.insert(id as u32);
                        }
                    }
                }
            }
        }
        let lesta = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(crate::commands::game_client::is_lesta_replay_extension);
        let decoded =
            crate::commands::packets::decode_replay(pstream, &candidates, cver.as_deref(), lesta)
                .expect("decode");
        // (entityType, methodId) histogram with arg-length stats.
        let mut histo: std::collections::BTreeMap<(i16, i32), (u32, u32, f32, f32)> =
            std::collections::BTreeMap::new();
        for (t, eid, mid, alen) in &decoded.method_histogram {
            let et = decoded.kinds.get(eid).map(|k| k.entity_type).unwrap_or(-1);
            let e = histo.entry((et, *mid)).or_insert((0, *alen, *t, *t));
            e.0 += 1;
            e.1 = e.1.max(*alen);
            e.3 = e.3.max(*t);
        }
        let mut props = std::collections::BTreeMap::new();
        for (eid, changes) in &decoded.properties {
            props.insert(
                eid.to_string(),
                changes
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "t": c.time, "p": c.property_index, "v": c.value, "s": c.size,
                        })
                    })
                    .collect::<Vec<_>>(),
            );
        }
        let histo_json: serde_json::Value = histo
            .iter()
            .map(|((et, mid), (n, maxlen, t0, t1))| {
                // raw arg samples for this (entityType, method) — the args
                // are per-entity, so collect from any sampled entity.
                let mut samples: Vec<String> = Vec::new();
                for ((eid2, mid2), blobs) in &decoded.method_arg_samples {
                    if *mid2 != *mid { continue; }
                    let et2 = decoded.kinds.get(eid2).map(|k| k.entity_type).unwrap_or(-1);
                    if et2 != *et { continue; }
                    for b in blobs {
                        samples.push(b.iter().map(|x| format!("{x:02x}")).collect::<String>());
                    }
                    if samples.len() >= 4 { break; }
                }
                serde_json::json!({ "et": et, "mid": mid, "n": n, "maxLen": maxlen, "t0": t0, "t1": t1, "args": samples })
            })
            .collect::<Vec<_>>()
            .into();
        let out = serde_json::json!({
            "properties": props,
            "methods": histo_json,
            "meta": meta,
            "trajectories": stream.trajectories,
            "shellLaunches": stream.shell_launches,
            "explosions": stream.explosions,
            "torpedoes": stream.torpedoes,
            "torpedoSteers": stream.torpedo_steers,
            "weaponLocks": stream.weapon_locks,
            "battleResults": stream.battle_results,
            "version": stream.version,
            "mapName": stream.map_name,
            "camera": stream.camera,
            "netStats": stream.net_stats,
            "leaves": stream.leaves,
            "cameraModes": stream.camera_modes,
            "diagnostics": stream.diagnostics,
            "squadronCreates": stream.squadron_creates,
            "squadronPlanes": stream.squadron_planes,
            "minimapSquadronAdds": stream.minimap_squadron_adds,
            "minimapSquadronMoves": stream.minimap_squadron_moves,
            "minimapSquadronRemoves": stream.minimap_squadron_removes,
            "wards": stream.wards,
            "wardRemoves": stream.ward_removes,
            "shotKills": stream.shot_kills,
            "damageStats": stream.damage_stats,
            "chatMessages": stream.chat_messages,
            "achievements": stream.achievements,
            "arenaPlayers": stream.arena_players,
            "weatherTransitions": stream.weather_transitions,
            "weatherNotifications": stream.weather_notifications,
            "selfTeam": stream.self_team,
        });
        let out_path =
            std::env::var("WOWSP_DUMP_OUT").unwrap_or_else(|_| "replay_dump.json".to_string());
        std::fs::write(&out_path, serde_json::to_string(&out).unwrap()).unwrap();
        eprintln!("dumped to {out_path}");
    }

    /// The live temp container is legitimately read mid-write: every state
    /// before the game has flushed a complete header + packet region must
    /// yield the EMPTY snapshot, never an error — the self view stays on its
    /// syncing state and retries on the next size change. Pinned shapes:
    /// nothing on disk, magic only, a declared-but-missing block table, a
    /// complete header over a zero-filled packet region.
    #[test]
    fn live_snapshot_tolerates_midwrite_containers() {
        let assert_empty = |bytes: &[u8]| {
            let snap = live_snapshot_from_bytes("temp.wowsreplay", bytes);
            assert!(snap.trajectories.is_empty());
            assert!(snap.shot_kills.is_empty());
            assert!(snap.damage_stats.is_empty());
            assert!(snap.battle_results.is_none());
        };
        // The file exists but the game has not written a byte yet (or the
        // next battle just truncated it).
        assert_empty(&[]);
        // Magic flushed, block table not.
        assert_empty(&REPLAY_MAGIC);
        let mut count_only = REPLAY_MAGIC.to_vec();
        count_only.extend_from_slice(&3u32.to_le_bytes());
        assert_empty(&count_only);
        // Block count + a declared block length whose payload has not
        // landed (the declaration runs past EOF).
        let mut declared = REPLAY_MAGIC.to_vec();
        declared.extend_from_slice(&1u32.to_le_bytes());
        declared.extend_from_slice(&64u32.to_le_bytes());
        declared.extend_from_slice(b"{\"a\"");
        assert_empty(&declared);
        // Header complete (one small JSON block) but the packet region is
        // still pre-allocated zero fill.
        let mut zero_fill = REPLAY_MAGIC.to_vec();
        zero_fill.extend_from_slice(&1u32.to_le_bytes());
        zero_fill.extend_from_slice(&2u32.to_le_bytes());
        zero_fill.extend_from_slice(b"{}");
        zero_fill.extend_from_slice(&[0u8; 4096]);
        assert_empty(&zero_fill);
    }

    /// A container whose header walks cleanly but carries no frames yet
    /// decodes to the empty snapshot — through the CLEAN path, not the
    /// downgrade: the strict packet layer accepts the same bytes, which
    /// pins the claim the helper's empty result makes.
    #[test]
    fn live_snapshot_reads_header_only_container() {
        let mut bytes = REPLAY_MAGIC.to_vec();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(b"{}");
        let stream = packet_stream_after_blocks(&bytes).expect("header walks");
        assert!(
            super::super::packets::decode_replay_partial(
                stream,
                &std::collections::HashSet::new(),
                None,
                false
            )
            .is_ok(),
            "an empty packet region must decode cleanly"
        );
        assert!(
            live_snapshot_from_bytes("temp.wowsreplay", &bytes)
                .trajectories
                .is_empty()
        );
    }

    /// The tolerant live helper must not soften the STRICT reader: the same
    /// mid-write shape that yields an empty live snapshot is a hard error on
    /// the finished-replay decode — a completed replay that fails to parse
    /// must surface, never read as "still being written".
    #[test]
    fn strict_decode_keeps_hard_error_for_zero_fill() {
        let mut zero_fill = REPLAY_MAGIC.to_vec();
        zero_fill.extend_from_slice(&1u32.to_le_bytes());
        zero_fill.extend_from_slice(&2u32.to_le_bytes());
        zero_fill.extend_from_slice(b"{}");
        zero_fill.extend_from_slice(&[0u8; 4096]);
        let stream = packet_stream_after_blocks(&zero_fill).expect("header walks");
        assert!(
            super::super::packets::decode_replay(
                stream,
                &std::collections::HashSet::new(),
                None,
                false
            )
            .is_err(),
            "strict decode must reject a zero-filled packet region"
        );
        assert!(
            live_snapshot_from_bytes("temp.wowsreplay", &zero_fill)
                .trajectories
                .is_empty(),
            "the live path keeps its empty-snapshot downgrade"
        );
    }
}

/// Diagnostic: serialize the REAL IPC payload (serde_json over the whole
/// ReplayStream, exactly what Tauri's IPC codec emits) for a real replay,
/// asserting the weather timelines survive the wire. Run with
/// `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[tokio::test]
async fn dump_replay_stream_ipc_json() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let stream = read_replay_positions(path.clone()).await.expect("stream");
    let json = serde_json::to_string(&stream).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&json).expect("reparse");
    let tr = v.get("weatherTransitions").and_then(|x| x.as_array());
    let no = v.get("weatherNotifications").and_then(|x| x.as_array());
    eprintln!(
        "IPC json: weatherTransitions={} weatherNotifications={} (snake_case leak: {})",
        tr.map_or(0, |a| a.len()),
        no.map_or(0, |a| a.len()),
        v.get("weather_transitions").is_some()
    );
    if let Some(a) = tr {
        for t in a {
            eprintln!("  tr: {}", serde_json::to_string(t).unwrap_or_default());
        }
    }
    // The keys must exist on the wire (camelCase, no snake_case twin) for
    // ANY replay; the non-empty check only holds for weather matches —
    // point WOWSP_TEST_REPLAY at a cyclone/storm replay to see data.
    assert!(tr.is_some(), "weatherTransitions key missing on the wire");
    assert!(no.is_some(), "weatherNotifications key missing on the wire");
    assert!(
        !v.get("weather_transitions").is_some(),
        "snake_case field leaked onto the wire"
    );
}
