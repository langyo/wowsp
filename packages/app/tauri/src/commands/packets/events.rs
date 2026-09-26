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

/// Read one BigWorld wire string from `args` at `off`: a `u8` length prefix,
/// with `0xff` escaping to `u16` length + one dummy byte. Returns the decoded
/// (lossy UTF-8) string and the offset just past it.
fn read_wire_string(args: &[u8], off: usize) -> Option<(String, usize)> {
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
    Some((String::from_utf8_lossy(raw).into_owned(), cursor + len))
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
