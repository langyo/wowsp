use super::*;
/// Decode `receive_addSquadron` args: u32 paramsID, u8 totalNumPlanes, then
/// the `SQUADRON_STATE` fixed dict — i64 planeID, u32 skinID, u8 isActive,
/// u8 numPlanes, f32×3 position, ... — then i64 parentID, u32 maxHealth,
/// f32 squadronHealthPart, u64 planeHealth. Only the head fields through
/// `position` are decoded; they are byte-identical across every shipped
/// definition (0.11.6–15.7.0 — later versions append tail fields after
/// `position`), so the fixed offsets are safe without version gating.
pub(super) fn decode_squadron_add(
    time: f32,
    args: &[u8],
) -> Option<wowsp_tauri_shared::SquadronCreate> {
    if args.len() < 31 {
        return None;
    }
    let params_id = u32::from_le_bytes(args[0..4].try_into().ok()?);
    let plane_id = u64::from_le_bytes(args[5..13].try_into().ok()?);
    let x = f32::from_le_bytes(args[19..23].try_into().ok()?);
    let y = f32::from_le_bytes(args[23..27].try_into().ok()?);
    let z = f32::from_le_bytes(args[27..31].try_into().ok()?);
    Some(wowsp_tauri_shared::SquadronCreate {
        time,
        plane_id,
        params_id,
        x,
        y,
        z,
    })
}

/// Decode `receive_addMinimapSquadron` args: `i64 planeId, i8 teamId,
/// u32 paramsId, VECTOR2 pos, u8 flag`. The VECTOR2's second component is the
/// world Z (not negated — cross-checked against the 3D squadron stream and the
/// carrier position on a 15.0 replay). The plane id packs the owning carrier
/// vehicle id in its low 32 bits.
pub(super) fn decode_minimap_squadron_add(
    time: f32,
    args: &[u8],
) -> Option<wowsp_tauri_shared::MinimapSquadronAdd> {
    if args.len() < 22 {
        return None;
    }
    let plane_id = u64::from_le_bytes(args[0..8].try_into().ok()?);
    let team_id = args[8] as i8;
    let params_id = u32::from_le_bytes(args[9..13].try_into().ok()?);
    let x = f32::from_le_bytes(args[13..17].try_into().ok()?);
    let z = f32::from_le_bytes(args[17..21].try_into().ok()?);
    Some(wowsp_tauri_shared::MinimapSquadronAdd {
        time,
        plane_id,
        owner_id: plane_owner_id(plane_id),
        team_id,
        params_id,
        x,
        z,
    })
}

/// Decode `receive_updateMinimapSquadron` args: `i64 planeId, VECTOR2 pos`.
pub(super) fn decode_minimap_squadron_move(
    time: f32,
    args: &[u8],
) -> Option<wowsp_tauri_shared::MinimapSquadronMove> {
    if args.len() < 16 {
        return None;
    }
    let plane_id = u64::from_le_bytes(args[0..8].try_into().ok()?);
    let x = f32::from_le_bytes(args[8..12].try_into().ok()?);
    let z = f32::from_le_bytes(args[12..16].try_into().ok()?);
    Some(wowsp_tauri_shared::MinimapSquadronMove {
        time,
        plane_id,
        x,
        z,
    })
}

/// Decode `receive_wardAdded` args: `i64 squadronId, VECTOR3 position,
/// f32 time, f32 radius, i8 teamId, u64 ownerId` (+ trailing `u8 wardType`
/// from 13.2.0 — `ward_has_type`). The reference treats a zero radius as the
/// default 60 m patrol ring; we keep the raw value and let the caller decide.
pub(super) fn decode_ward_added(
    time: f32,
    args: &[u8],
    ward_has_type: bool,
) -> Option<wowsp_tauri_shared::WardEvent> {
    let need = if ward_has_type { 38 } else { 37 };
    if args.len() < need {
        return None;
    }
    let squadron_id = u64::from_le_bytes(args[0..8].try_into().ok()?);
    Some(wowsp_tauri_shared::WardEvent {
        time,
        squadron_id,
        owner_id: i64::from_le_bytes(args[29..37].try_into().ok()?),
        team_id: args[28] as i8,
        x: f32::from_le_bytes(read_bytes(args, 8)?),
        y: f32::from_le_bytes(read_bytes(args, 12)?),
        z: f32::from_le_bytes(read_bytes(args, 16)?),
        radius: f32::from_le_bytes(read_bytes(args, 24)?),
        ward_type: if ward_has_type { args[37] } else { 0 },
    })
}

/// Decode `receiveShotKills` args (per the `SHOTKILLS_PACK` alias): a u8
/// count of packs, each `{i32 ownerID, u8 hitType, u8 kills[], SHOTKILL}`
/// where `SHOTKILL` is `{VECTOR3 pos, u16 shotID}` plus a nullable
/// `TERMINAL_BALLISTICS_INFO` (flag byte; 29 bytes when present) on 12.7.0+.
/// The ballistics details are skipped — only the terminal position is kept.
pub(super) fn decode_shot_kills(
    time: f32,
    args: &[u8],
    has_ballistics: bool,
) -> Vec<wowsp_tauri_shared::ShotKillEvent> {
    let mut out = Vec::new();
    let Some(&packs) = args.first() else {
        return out;
    };
    let mut off = 1usize;
    'packs: for _ in 0..packs {
        // ownerID + hitType + kills-count header.
        if off + 6 > args.len() {
            break;
        }
        let Some(owner_id) = read_bytes(args, off).map(i32::from_le_bytes) else {
            break;
        };
        let hit_type = args[off + 4];
        let kills = args[off + 5] as usize;
        off += 6;
        for _ in 0..kills {
            let fixed = if has_ballistics { 15 } else { 14 };
            if off + fixed > args.len() {
                break 'packs;
            }
            let Some(shot_id) = read_bytes(args, off + 12).map(u16::from_le_bytes) else {
                break 'packs;
            };
            let Some(x) = read_bytes(args, off).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(y) = read_bytes(args, off + 4).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(z) = read_bytes(args, off + 8).map(f32::from_le_bytes) else {
                break 'packs;
            };
            out.push(wowsp_tauri_shared::ShotKillEvent {
                time,
                owner_id,
                hit_type,
                shot_id,
                x,
                y,
                z,
            });
            off += 14;
            if has_ballistics {
                match nullable_dict(args, &mut off, 29) {
                    Some(_) => (),
                    None => break 'packs,
                }
            }
        }
    }
    out
}

/// Read one BigWorld wire blob from `args` at `off`: a `u8` length prefix,
/// with `0xff` escaping to `u16` length + one dummy byte. Returns the bytes
/// and the offset just past them. STRING/BLOB share this wire shape.
fn read_wire_blob(args: &[u8], off: usize) -> Option<(&[u8], usize)> {
    let mut cursor = off;
    let len = match *args.get(cursor)? {
        0xff => {
            let u16_len = u16::from_le_bytes(read_bytes(args, cursor + 1)?) as usize;
            // 0xff flag + u16 length + 1 dummy byte before the body.
            cursor += 4;
            u16_len
        },
        plain => {
            cursor += 1;
            plain as usize
        },
    };
    let raw = args.get(cursor..cursor + len)?;
    Some((raw, cursor + len))
}

/// Read one BigWorld wire string from `args` at `off`. Returns the decoded
/// (lossy UTF-8) string and the offset just past it.
fn read_wire_string(args: &[u8], off: usize) -> Option<(String, usize)> {
    let (raw, end) = read_wire_blob(args, off)?;
    Some((String::from_utf8_lossy(raw).into_owned(), end))
}

/// Per-version field indices of the arena-state player FixedDict. The dict is
/// pickled as `(index, value)` pairs whose keys are the player fields'
/// alphabetical sort positions — the field set grows over game versions, so
/// every index drifts when a new alphabetically-earlier field is inserted
/// (mirrors the vendored analyzer's key maps).
struct ArenaFields {
    avatar_id: i64,
    /// The roster player id (joins the descriptor `vehicles[].id`).
    player_id: i64,
    max_health: i64,
    name: i64,
    /// The player's SHIP VEHICLE entity id — confusingly named `shipId` in
    /// the FixedDict; NOT the GameParams id (`ship_params_id`).
    ship_entity_id: i64,
    ship_params_id: i64,
    team_id: i64,
}

impl ArenaFields {
    /// 0.11.11+ ships a 38-field player layout that has stayed stable since
    /// (verified upstream across 0.11.11–0.12.8); earlier layouts shift the
    /// alphabetical tail fields. Bots dropped 10 human-only fields in
    /// 0.12.8, moving their tail indices down.
    fn for_version(version: Option<(u32, u32, u32)>, is_bot: bool) -> Self {
        let bot_layout = is_bot && version.is_some_and(|k| k >= (0, 12, 8));
        match (version, bot_layout) {
            _ if bot_layout => Self {
                avatar_id: -1,
                player_id: 10,
                max_health: 18,
                name: 19,
                ship_entity_id: 23,
                ship_params_id: 24,
                team_id: 26,
            },
            (Some(k), _) if k >= (0, 11, 11) => Self {
                avatar_id: 2,
                player_id: 11,
                max_health: 24,
                name: 25,
                ship_entity_id: 33,
                ship_params_id: 34,
                team_id: 36,
            },
            (Some(k), _) if k >= (0, 10, 9) => Self {
                avatar_id: 2,
                player_id: 11,
                max_health: 23,
                name: 24,
                ship_entity_id: 32,
                ship_params_id: 33,
                team_id: 35,
            },
            (Some(k), _) if k >= (0, 10, 7) => Self {
                avatar_id: 1,
                player_id: 10,
                max_health: 22,
                name: 23,
                ship_entity_id: 30,
                ship_params_id: 31,
                team_id: 33,
            },
            // Pre-0.10.7 (34 fields, recovered upstream from a 0.9.10 replay).
            _ => Self {
                avatar_id: 1,
                player_id: 10,
                max_health: 21,
                name: 22,
                ship_entity_id: 29,
                ship_params_id: 30,
                team_id: 32,
            },
        }
    }
}

/// Decode the avatar's `onArenaStateReceived` args: `i64 arenaId,
/// i8 teamBuildTypeId, BLOB preBattlesInfo, BLOB playersData, BLOB botsData`.
/// The player/bot blobs are pickle-proto-2 lists — one FixedDict pair list
/// per player — read against the per-version [`ArenaFields`] indices. Only
/// the identity fields survive (entity id, team, account/roster id,
/// GameParams ship id, max health, name); any shape mismatch yields `None`
/// (the frontend then falls back to its spawn-side heuristics).
pub(super) fn decode_arena_state(
    args: &[u8],
    version: Option<(u32, u32, u32)>,
) -> Option<Vec<wowsp_tauri_shared::ArenaPlayer>> {
    if args.len() < 11 {
        return None;
    }
    let (_, off) = read_wire_blob(args, 9)?; // skip i64 arenaId + i8 teamBuildTypeId
    let (players_blob, off) = read_wire_blob(args, off)?;
    let (bots_blob, _) = read_wire_blob(args, off)?;
    let mut out = arena_player_list(players_blob, version, false);
    out.extend(arena_player_list(bots_blob, version, true));
    // A real arena carries both full teams; a single-entry "decode" is a
    // misparse of some other method's args, not a roster.
    (out.len() >= 2).then_some(out)
}

/// Parse one arena player/bot blob (see [`decode_arena_state`]).
fn arena_player_list(
    blob: &[u8],
    version: Option<(u32, u32, u32)>,
    bots: bool,
) -> Vec<wowsp_tauri_shared::ArenaPlayer> {
    let Some(PyVal::List(players)) = parse_pickle(blob) else {
        return Vec::new();
    };
    let f = ArenaFields::for_version(version, bots);
    let mut out = Vec::new();
    for p in players {
        // Each player is a list of (index, value) tuples (FixedDict pickled
        // flat). Reads tolerate missing pairs — older layouts only ever
        // shrink, never reorder.
        let PyVal::List(pairs) = &p else {
            continue;
        };
        let field = |idx: i64| -> Option<&PyVal> {
            pairs.iter().find_map(|kv| match kv {
                PyVal::Tuple(pair) => match (pair.first(), pair.get(1)) {
                    (Some(PyVal::Int(k)), v) if *k == idx => v,
                    _ => None,
                },
                _ => None,
            })
        };
        let as_i64 = |v: Option<&PyVal>| -> Option<i64> {
            match v? {
                PyVal::Int(i) => Some(*i),
                PyVal::Float(fl) => Some(*fl as i64),
                _ => None,
            }
        };
        let Some(entity_id) = as_i64(field(f.ship_entity_id)) else {
            continue;
        };
        if entity_id == 0 {
            continue;
        }
        // Event/asymmetric modes deliver scaled FRACTIONAL health here;
        // round to the whole number (a plain float→int cast truncates and
        // would read the ship 1 HP short of its true total).
        let max_health = match field(f.max_health) {
            Some(PyVal::Float(fl)) => fl.round() as i64,
            Some(PyVal::Int(i)) => *i,
            _ => 0,
        };
        let name = match field(f.name) {
            Some(PyVal::Str(s)) => s.clone(),
            _ => String::new(),
        };
        out.push(wowsp_tauri_shared::ArenaPlayer {
            entity_id: entity_id as i32,
            team_id: as_i64(field(f.team_id)).unwrap_or(0) as i8,
            player_id: as_i64(field(f.player_id)).unwrap_or(0),
            ship_params_id: as_i64(field(f.ship_params_id)).unwrap_or(0) as u32,
            max_health: max_health.max(0) as u32,
            name,
            is_bot: bots,
            avatar_id: as_i64(field(f.avatar_id)).map(|v| v as i32),
            is_self: false,
        });
    }
    out
}

/// Decode `onChatMessage` args: `i32 playerId, STRING namespace, STRING
/// message, STRING unk` (the trailing `unk` is bounded but dropped — captures
/// show it empty). Any shape mismatch yields `None` (the message is skipped,
/// never fatal).
pub(super) fn decode_chat_message(time: f32, args: &[u8]) -> Option<wowsp_tauri_shared::ChatEvent> {
    if args.len() < 5 {
        return None;
    }
    let player_id = i32::from_le_bytes(read_bytes(args, 0)?);
    let (namespace, off) = read_wire_string(args, 4)?;
    let (message, off) = read_wire_string(args, off)?;
    // Third string (unknown purpose) only bounds-checks the payload tail.
    read_wire_string(args, off)?;
    Some(wowsp_tauri_shared::ChatEvent {
        time,
        player_id,
        namespace,
        message,
    })
}

/// Decode `onAchievementEarned` args: `i32 playerId, u32 achievementId`. The
/// id joins GameParams Achievement entries (bundled `achievement_names.json`
/// for display names); multiple ids map to the same achievement via template
/// variants, so the frontend keys on the raw id.
pub(super) fn decode_achievement(
    time: f32,
    args: &[u8],
) -> Option<wowsp_tauri_shared::AchievementEvent> {
    if args.len() < 8 {
        return None;
    }
    Some(wowsp_tauri_shared::AchievementEvent {
        time,
        player_id: i32::from_le_bytes(read_bytes(args, 0)?),
        achievement_id: u32::from_le_bytes(read_bytes(args, 4)?),
    })
}

/// Decode the avatar's `receiveDamageStat` args: one BLOB argument — a u8
/// length prefix followed by a pickle-proto-2 dict `{(weapon, category):
/// [count, total]}`. The dict carries a PARTIAL update: each key's value
/// replaces the running total for that pair (never summed across calls), so
/// the samples are emitted as-is and folded by the consumer. Spotting damage
/// can arrive with an integer total — coerced to f64.
pub(super) fn decode_damage_stat(
    time: f32,
    args: &[u8],
) -> Vec<wowsp_tauri_shared::DamageStatSample> {
    let mut out = Vec::new();
    // BLOB arg: u8 length prefix + that many pickle bytes.
    let Some(&len) = args.first() else {
        return out;
    };
    let len = len as usize;
    if len == 0 || args.len() < 1 + len {
        return out;
    }
    let Some(PyVal::Dict(entries)) = parse_pickle(&args[1..1 + len]) else {
        return out;
    };
    for (k, v) in entries {
        // Key: (weapon, category) tuple of ints. Anything else is a future
        // shape — skip the pair rather than guessing.
        let PyVal::Tuple(key) = k else {
            continue;
        };
        if key.len() != 2 {
            continue;
        }
        let (Some(PyVal::Int(weapon)), Some(PyVal::Int(category))) = (key.first(), key.get(1))
        else {
            continue;
        };
        // Value: [count, total].
        let PyVal::List(vals) = v else {
            continue;
        };
        if vals.len() != 2 {
            continue;
        }
        let Some(PyVal::Int(count)) = vals.first() else {
            continue;
        };
        let total = match vals.get(1) {
            Some(PyVal::Float(f)) => *f,
            Some(PyVal::Int(i)) => *i as f64,
            _ => continue,
        };
        out.push(wowsp_tauri_shared::DamageStatSample {
            time,
            weapon: *weapon,
            category: *category,
            count: *count,
            total,
        });
    }
    out
}

/// The owning carrier's vehicle entity id: low 32 bits of the composite
/// squadron id (bit layout from the reference `unpack_plane_id`:
/// [owner 32 | index 3 | purpose 3 | departures 1]).
fn plane_owner_id(plane_id: u64) -> i32 {
    (plane_id & 0xFFFF_FFFF) as u32 as i32
}

/// `receive_removeMinimapSquadron` guards its read with a length check.
pub(super) fn args_is_plane_id(args: &[u8]) -> bool {
    args.len() == 8
}

/// Decode `receiveArtilleryShots` args (per the `SHOTS_PACK` alias): a u8
/// count of packs, each `{u32 paramsID, i32 ownerID, i32 salvoID, u8 shots[],
/// SHOT}` where `SHOT` is `{VECTOR3 pos, f32 pitch, f32 speed, VECTOR3 tarPos,
/// u16 shotID, u16 gunBarrelID, f32 serverTimeLeft, f32 shooterHeight,
/// f32 hitDistance}` — 48 bytes.
pub(super) fn decode_artillery_shots(
    time: f32,
    args: &[u8],
) -> Vec<wowsp_tauri_shared::ShellLaunchEvent> {
    let mut out = Vec::new();
    let Some(&packs) = args.first() else {
        return out;
    };
    let mut off = 1usize;
    'packs: for _ in 0..packs {
        // paramsID + ownerID + salvoID + shots-count header.
        if off + 13 > args.len() {
            break;
        }
        let Some(params_id) = read_bytes(args, off).map(u32::from_le_bytes) else {
            break;
        };
        let Some(owner_id) = read_bytes(args, off + 4).map(i32::from_le_bytes) else {
            break;
        };
        let Some(salvo_id) = read_bytes(args, off + 8).map(i32::from_le_bytes) else {
            break;
        };
        let shots = args[off + 12] as usize;
        off += 13;
        for _ in 0..shots {
            if off + 48 > args.len() {
                break 'packs;
            }
            let Some(x) = read_bytes(args, off).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(y) = read_bytes(args, off + 4).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(z) = read_bytes(args, off + 8).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(speed) = read_bytes(args, off + 16).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(target_x) = read_bytes(args, off + 20).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(target_y) = read_bytes(args, off + 24).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(target_z) = read_bytes(args, off + 28).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(shot_id) = read_bytes(args, off + 32).map(u16::from_le_bytes) else {
                break 'packs;
            };
            let Some(gun_barrel_id) = read_bytes(args, off + 34).map(u16::from_le_bytes) else {
                break 'packs;
            };
            let Some(server_time_left) = read_bytes(args, off + 36).map(f32::from_le_bytes) else {
                break 'packs;
            };
            out.push(wowsp_tauri_shared::ShellLaunchEvent {
                time,
                owner_id,
                params_id,
                salvo_id,
                shot_id,
                x,
                y,
                z,
                target_x,
                target_y,
                target_z,
                server_time_left,
                speed,
                gun_barrel_id,
            });
            off += 48;
        }
    }
    out
}

/// Decode `receiveTorpedoes` args (per the `TORPEDOES_PACK` alias): a u8 count
/// of packs, each `{u32 paramsID, i32 ownerID, i32 salvoID, u32 skinID, u8
/// count, TORPEDO}` where `TORPEDO` is `{VECTOR3 pos, VECTOR3 dir, u16 shotID,
/// u8 armed, TORPEDO_MANEUVER_DUMP?, TORPEDO_ACOUSTIC_DUMP?}`. The dumps are
/// nullable fixed dicts: a flag byte 0 skips them, 1 parses them (any other
/// value rewinds and parses — the reference's recovery path).
pub(super) fn decode_torpedo_salvos(
    time: f32,
    args: &[u8],
) -> Vec<wowsp_tauri_shared::TorpedoLaunch> {
    let mut out = Vec::new();
    let Some(&packs) = args.first() else {
        return out;
    };
    let mut off = 1usize;
    'packs: for _ in 0..packs {
        if off + 17 > args.len() {
            break;
        }
        let Some(params_id) = read_bytes(args, off).map(u32::from_le_bytes) else {
            break;
        };
        let Some(owner_id) = read_bytes(args, off + 4).map(i32::from_le_bytes) else {
            break;
        };
        let Some(salvo_id) = read_bytes(args, off + 8).map(i32::from_le_bytes) else {
            break;
        };
        let count = args[off + 16] as usize;
        off += 17;
        for _ in 0..count {
            // Fixed part (pos + dir + shotID + armed) is 27 bytes; the two
            // nullable-dump flag bytes follow, so 29 bytes must remain.
            if off + 29 > args.len() {
                break 'packs;
            }
            let Some(x) = read_bytes(args, off).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(y) = read_bytes(args, off + 4).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(z) = read_bytes(args, off + 8).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(dir_x) = read_bytes(args, off + 12).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(dir_y) = read_bytes(args, off + 16).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(dir_z) = read_bytes(args, off + 20).map(f32::from_le_bytes) else {
                break 'packs;
            };
            let Some(shot_id) = read_bytes(args, off + 24).map(u16::from_le_bytes) else {
                break 'packs;
            };
            let armed = args[off + 26] != 0;
            out.push(wowsp_tauri_shared::TorpedoLaunch {
                time,
                owner_id,
                params_id,
                salvo_id,
                shot_id,
                x,
                y,
                z,
                dir_x,
                dir_y,
                dir_z,
                armed,
            });
            off += 27;
            // maneuverDump: targetYaw/changeTime/stopTime/currentTime/yawSpeed
            // (5×f32 = 20) + armPos + finalPos (2×VECTOR3 = 24) = 44 bytes.
            match nullable_dict(args, &mut off, 44) {
                Some(_) => (),
                None => break 'packs,
            }
            // acousticDump: 3×u8 + 7×f32 = 31 bytes.
            match nullable_dict(args, &mut off, 31) {
                Some(_) => (),
                None => break 'packs,
            }
        }
    }
    out
}

/// Consume one nullable fixed dict of `body` bytes: flag 0 → skipped; flag 1
/// → consume the body; any other flag → the dict body starts AT the flag byte
/// (the reference rewinds one byte and parses), so only `body - 1` more bytes
/// are consumed after the flag. Returns `None` when the stream is truncated.
fn nullable_dict(args: &[u8], off: &mut usize, body: usize) -> Option<()> {
    let flag = *args.get(*off)?;
    *off += 1;
    let len = if flag == 0 {
        0
    } else if flag == 1 {
        body
    } else {
        body - 1
    };
    if *off + len > args.len() {
        return None;
    }
    *off += len;
    Some(())
}

/// Decode `receiveTorpedoDirection` args (acoustic torpedo guidance):
/// `i32 vehicleId, u16 shotId, VECTOR3 pos, f32 targetYaw, f32 targetDepth,
/// f32 speedCoef, f32 curYawSpeed, f32 curPitchSpeed, u8 canReachDepth`
/// (39 bytes; only the head fields through targetYaw are kept).
pub(super) fn decode_torpedo_directions(
    time: f32,
    args: &[u8],
) -> Vec<wowsp_tauri_shared::TorpedoSteer> {
    let mut out = Vec::new();
    if args.len() < 22 {
        return out;
    }
    let Some(owner_id) = read_bytes(args, 0).map(i32::from_le_bytes) else {
        return out;
    };
    let Some(shot_id) = read_bytes(args, 4).map(u16::from_le_bytes) else {
        return out;
    };
    let Some(x) = read_bytes(args, 6).map(f32::from_le_bytes) else {
        return out;
    };
    let Some(y) = read_bytes(args, 10).map(f32::from_le_bytes) else {
        return out;
    };
    let Some(z) = read_bytes(args, 14).map(f32::from_le_bytes) else {
        return out;
    };
    let Some(target_yaw) = read_bytes(args, 18).map(f32::from_le_bytes) else {
        return out;
    };
    out.push(wowsp_tauri_shared::TorpedoSteer {
        time,
        owner_id,
        shot_id,
        x,
        y,
        z,
        target_yaw,
    });
    out
}

/// Decode `receive_updateSquadron` args: u64 planeId, f32 dt, u8 count,
/// then count × {f32×3 position, f32 yaw, u16 time, u8 type, i8 pitch}.
pub(super) fn decode_squadron_update(
    time: f32,
    args: &[u8],
) -> Vec<wowsp_tauri_shared::SquadronPlane> {
    let mut out = Vec::new();
    if args.len() < 13 {
        return out;
    }
    let Some(plane_id) = read_bytes(args, 0).map(u64::from_le_bytes) else {
        return out;
    };
    let count = args[12] as usize;
    let mut off = 13usize;
    for index in 0..count {
        if off + 20 > args.len() {
            break;
        }
        let Some(x) = read_bytes(args, off).map(f32::from_le_bytes) else {
            break;
        };
        let Some(y) = read_bytes(args, off + 4).map(f32::from_le_bytes) else {
            break;
        };
        let Some(z) = read_bytes(args, off + 8).map(f32::from_le_bytes) else {
            break;
        };
        let Some(yaw) = read_bytes(args, off + 12).map(f32::from_le_bytes) else {
            break;
        };
        off += 20;
        out.push(wowsp_tauri_shared::SquadronPlane {
            time,
            plane_id,
            index: index as u8,
            x,
            y,
            z,
            yaw,
        });
    }
    out
}

/// Decode `receiveExplosions` args: `u8 count` × {f32×3 position, u32
/// paramsID, u8 hitType}. Returns one event per impact point.
pub(super) fn decode_explosions(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::ExplosionEvent> {
    let mut out = Vec::new();
    let mut off = 0usize;
    let Some(&count) = args.first() else {
        return out;
    };
    off += 1;
    for _ in 0..count {
        if off + 17 > args.len() {
            break;
        }
        let Some(x) = read_bytes(args, off).map(f32::from_le_bytes) else {
            break;
        };
        let Some(y) = read_bytes(args, off + 4).map(f32::from_le_bytes) else {
            break;
        };
        let Some(z) = read_bytes(args, off + 8).map(f32::from_le_bytes) else {
            break;
        };
        let Some(params_id) = read_bytes(args, off + 12).map(u32::from_le_bytes) else {
            break;
        };
        off += 17; // pos(12) + paramsID(4) + hitType(1)
        out.push(wowsp_tauri_shared::ExplosionEvent {
            time,
            x,
            y,
            z,
            params_id,
        });
    }
    out
}
