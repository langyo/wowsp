//! Post-decode stream assembly — the trajectory grouping, HP detection and
//! anchoring, and the Lesta arena synthesis shared by every consumer of a
//! decoded replay (the app's finished-replay and live-temp views, and the
//! settled-battle corpus bench), plus the settled-file entry point
//! [`live_self_stream_from_settled`]. Moved wholesale out of the app crate's
//! `commands::replay::streams` (wave 5a) so the replay-corpus CLI rides the
//! exact same assembly the app's replay views use.

use anyhow::{Context, anyhow};
use std::collections::BTreeMap;
use std::path::Path;

use wowsp_tauri_shared::{LiveSelfStream, VehicleEntry};

use crate::packets::{DecodedReplay, PropertyChange, decode_replay};
use crate::{meta, meta::packet_stream_after_blocks};

/// Decode one SETTLED replay container (a finished `.wowsreplay` /
/// `.korablireplay`, e.g. a drained archive member) into the slim
/// [`LiveSelfStream`] the live self-stats pipeline consumes — the corpus-bench
/// counterpart of the app's live-temp snapshot
/// (`wowsp_tauri::commands::replay::streams::live_snapshot_from_bytes`).
///
/// Settled vs live — where the tolerance lives:
/// - NO partial-decode tolerance: a corpus file must FULLY decode
///   ([`decode_replay`], not `decode_replay_partial`); every error propagates
///   instead of downgrading to the empty snapshot. A settled replay that
///   fails to parse must surface, never masquerade as "still being written".
/// - NO probe-roster synthesis: the live temp container's descriptor carries
///   no roster at all mid-battle (Lesta writes `playersPublicInfo` only when
///   the battle settles), so the live path falls back to the in-game probe's
///   roster file. A settled container HAS its roster — WG inline in the
///   descriptor, Lesta in block[1] — and [`meta::roster_from_raw`] resolves
///   both offline. `path` feeds exactly those two consumers: the container
///   extension (the client-family marker) and the Lesta block[1]/block[2]
///   roster reads (on disk, like every other `roster_from_raw` caller).
///
/// The shared post-decode tail (Lesta arena synthesis → grouping → the slim
/// projection) is [`finish_self_stream`] — the same code the live snapshot
/// runs, so the bench's estimate matches what the live view would have shown.
pub fn live_self_stream_from_settled(path: &Path, bytes: &[u8]) -> anyhow::Result<LiveSelfStream> {
    let stream = packet_stream_after_blocks(bytes).ok_or_else(|| {
        anyhow!(
            "{}: not a valid wowsreplay (no packet stream)",
            path.display()
        )
    })?;
    let lesta = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(crate::is_lesta_replay_extension);
    // The finished-replay prologue (see `read_replay_positions` in the app
    // crate): descriptor version + roster in ONE parse, then the roster
    // shipIds as the entity→player join candidates (0 is the degenerate
    // no-shipId default).
    let mut candidates = std::collections::HashSet::new();
    let mut roster: Vec<VehicleEntry> = Vec::new();
    let mut client_version: Option<String> = None;
    if let Some(json) = meta::extract_descriptor_json(bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            client_version = raw
                .get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            roster = meta::roster_from_raw(path, &raw);
            for v in &roster {
                if v.ship_id > 0 {
                    candidates.insert(v.ship_id as u32);
                }
            }
        }
    }
    let decoded = decode_replay(stream, &candidates, client_version.as_deref(), lesta)
        .with_context(|| format!("{}: decoding the packet stream", path.display()))?;
    Ok(finish_self_stream(decoded, lesta, &roster))
}

/// The shared post-decode tail behind both the live-temp snapshot and
/// [`live_self_stream_from_settled`]: the Lesta arena synthesis (BEFORE
/// grouping — it fills `arena_players` with the state-recovered starting
/// health so the HP anchoring inside `group_by_entity` treats it exactly like
/// a decoded WG arena state), the trajectory grouping, and the slim
/// self-stats projection.
pub fn finish_self_stream(
    mut decoded: DecodedReplay,
    lesta: bool,
    roster: &[VehicleEntry],
) -> LiveSelfStream {
    if lesta {
        synthesize_lesta_arena_players(
            &mut decoded.arena_players,
            &decoded.kinds,
            roster,
            decoded.recorder_ship,
        );
    }
    LiveSelfStream::from_full(group_by_entity(decoded))
}

/// How the HP property's raw 4-byte value should be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HpValueKind {
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
pub fn detect_hp_property(
    kinds: &BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    properties: &BTreeMap<i32, Vec<PropertyChange>>,
) -> (u32, HpValueKind) {
    // Per (entity, index): does the series look like HP under one interpretation?
    let mut scores: BTreeMap<(u32, HpValueKind), (usize, usize)> = BTreeMap::new();
    for (eid, changes) in properties {
        if kinds.get(eid).map(|k| k.entity_type) != Some(2) {
            continue;
        }
        let mut by_index: BTreeMap<u32, Vec<&PropertyChange>> = BTreeMap::new();
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
pub fn anchor_hp_streams(
    hp_map: &mut BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>>,
    arena_players: &[wowsp_tauri_shared::ArenaPlayer],
) {
    let starting: BTreeMap<i32, u32> = arena_players
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
/// mis-pairing would paint an ally enemy-red). `max_health` comes from
/// the EntityCreate state scan (`scan_state_for_max_health`) — the starting
/// health of the exact build, so HP anchoring and the frontend totals read
/// like a decoded WG arena. The frontend's `resolveRosterAssignments`
/// treats arena identities as authoritative for the entities they cover and
/// falls back to its shipId/spawn heuristics for the rest, so a partial
/// list is safe. Runs BEFORE `group_by_entity` so the anchoring inside it
/// sees the synthesized list.
pub fn synthesize_lesta_arena_players(
    arena_players: &mut Vec<wowsp_tauri_shared::ArenaPlayer>,
    kinds: &BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    roster: &[VehicleEntry],
    recorder_ship: Option<i32>,
) {
    if !arena_players.is_empty() || roster.is_empty() {
        return;
    }
    let mut entities_by_ship: BTreeMap<i64, Vec<i32>> = BTreeMap::new();
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
        // The unique ship entity carrying this roster entry's shipId; zero
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
pub fn group_by_entity(decoded: DecodedReplay) -> wowsp_tauri_shared::ReplayStream {
    let DecodedReplay {
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
    let mut hp_map: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> = BTreeMap::new();
    let mut cap_map: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> = BTreeMap::new();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A settled corpus file must fully decode or surface the error — no
    /// live-path downgrade to the empty snapshot: garbage bytes (and a
    /// header-only container without a packet stream) error out.
    #[test]
    fn settled_decode_rejects_non_replay_bytes() {
        let err = live_self_stream_from_settled(Path::new("x.wowsreplay"), b"not a replay")
            .expect_err("garbage bytes must error");
        assert!(err.to_string().contains("not a valid wowsreplay"));
        let mut header_only = Vec::new();
        header_only.extend_from_slice(&crate::meta::REPLAY_MAGIC);
        header_only.extend_from_slice(&1u32.to_le_bytes()); // 1 block...
        header_only.extend_from_slice(&2u32.to_le_bytes()); // ...of 2 bytes
        header_only.extend_from_slice(b"{}"); // descriptor, no stream after it
        assert!(
            live_self_stream_from_settled(Path::new("x.wowsreplay"), &header_only).is_err(),
            "a container whose packet stream fails to fully decode must error"
        );
    }

    fn kind(entity_type: i16, ship_id: Option<i64>) -> wowsp_tauri_shared::EntityKind {
        wowsp_tauri_shared::EntityKind {
            entity_type,
            vehicle_id: 0,
            initial_x: 0.0,
            initial_y: 0.0,
            initial_z: 0.0,
            creation_time: 0.0,
            ship_id,
            max_health: Some(10_000),
            control_point_index: None,
            initial_team: None,
            radius: None,
        }
    }

    fn empty_decode() -> DecodedReplay {
        DecodedReplay {
            recorder_ship: None,
            positions: BTreeMap::new(),
            kinds: BTreeMap::new(),
            destroys: BTreeMap::new(),
            properties: BTreeMap::new(),
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            cap_progress: BTreeMap::new(),
            weapon_locks: Vec::new(),
            battle_results: None,
            method_histogram: Vec::new(),
            method_arg_samples: BTreeMap::new(),
            version: None,
            map_name: None,
            camera: Vec::new(),
            net_stats: Vec::new(),
            leaves: BTreeMap::new(),
            camera_modes: Vec::new(),
            diagnostics: Default::default(),
            squadron_creates: Vec::new(),
            squadron_planes: Vec::new(),
            minimap_squadron_adds: Vec::new(),
            minimap_squadron_moves: Vec::new(),
            minimap_squadron_removes: Vec::new(),
            wards: Vec::new(),
            ward_removes: Vec::new(),
            shot_kills: Vec::new(),
            damage_stats: Vec::new(),
            chat_messages: Vec::new(),
            achievements: Vec::new(),
            arena_players: Vec::new(),
            weather_transitions: Vec::new(),
            weather_notifications: Vec::new(),
        }
    }

    /// The shared tail synthesizes the Lesta arena join (self anchored to the
    /// recorder entity) and the slim projection keeps only ships — the
    /// settled bench's stream is exactly what the live view would render.
    #[test]
    fn finish_self_stream_synthesizes_lesta_arena_and_keeps_ships() {
        let mut decoded = empty_decode();
        decoded.recorder_ship = Some(10);
        decoded.kinds.insert(10, kind(2, Some(101)));
        decoded.kinds.insert(11, kind(2, Some(102)));
        decoded.kinds.insert(12, kind(14, None)); // a capture zone
        let roster = vec![VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 101,
            ship_name: None,
        }];
        let stream = finish_self_stream(decoded, true, &roster);
        let me = stream
            .arena_players
            .iter()
            .find(|p| p.is_self)
            .expect("self anchored via the recorder entity");
        assert_eq!(me.entity_id, 10);
        // The slim projection drops the zone (non-ship trajectory).
        assert_eq!(stream.trajectories.len(), 2);
        assert!(
            stream
                .trajectories
                .iter()
                .all(|t| t.kind.as_ref().is_some_and(|k| k.entity_type == 2))
        );
    }

    /// WG-family decodes keep their decoded arena state untouched (the
    /// synthesis is a no-op on a non-empty list or non-Lesta family).
    #[test]
    fn finish_self_stream_leaves_wg_arena_alone() {
        let mut decoded = empty_decode();
        decoded.kinds.insert(10, kind(2, Some(101)));
        decoded.arena_players = vec![wowsp_tauri_shared::ArenaPlayer {
            entity_id: 10,
            team_id: 0,
            player_id: 7,
            ship_params_id: 101,
            max_health: 10_000,
            name: "decoded".into(),
            is_bot: false,
            avatar_id: None,
            is_self: true,
        }];
        let stream = finish_self_stream(
            decoded,
            false,
            &[VehicleEntry {
                id: 1,
                name: "me".into(),
                relation: 0,
                ship_id: 101,
                ship_name: None,
            }],
        );
        assert_eq!(stream.arena_players.len(), 1);
        assert_eq!(stream.arena_players[0].name, "decoded");
    }
}
