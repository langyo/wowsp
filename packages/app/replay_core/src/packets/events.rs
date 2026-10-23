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
    /// the FixedDict; NOT the GameParams id (`ship_params_id`). Head of a
    /// rigid tail trio: `ship_params_id` = entity + 1 and `team_id` =
    /// entity + 3 in EVERY layout ever pinned (0.10.7 → 15.9.0, the bot
    /// layout included), so the drift probe below moves the trio as one
    /// block instead of testing 3 free indices.
    ship_entity_id: i64,
    ship_params_id: i64,
    team_id: i64,
}

impl ArenaFields {
    /// 15.9.0 inserted one field between `name` (25) and the tail trio,
    /// pushing the trio up by one (verified on a real 15.9.0 capture; the
    /// dict now spans indices 0..38). 0.11.11+ ships the 38-field layout
    /// this replaced (verified upstream across 0.11.11–0.12.8); earlier
    /// layouts shift the alphabetical tail fields further. Bots dropped 10
    /// human-only fields in 0.12.8, moving their tail indices down — no
    /// 15.9.0 bot capture has been pinned yet, so the bot row keeps the
    /// 0.12.8 indices and the drift probe absorbs the same insertion.
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
            (Some(k), _) if k >= (15, 9, 0) => Self {
                avatar_id: 2,
                player_id: 11,
                max_health: 24,
                name: 25,
                ship_entity_id: 34,
                ship_params_id: 35,
                team_id: 37,
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

    /// The trio shifted as one block (`by` slots up/down the index axis).
    fn shifted(&self, by: i64) -> Self {
        Self {
            avatar_id: self.avatar_id,
            player_id: self.player_id,
            max_health: self.max_health,
            name: self.name,
            ship_entity_id: self.ship_entity_id + by,
            ship_params_id: self.ship_params_id + by,
            team_id: self.team_id + by,
        }
    }
}

/// Candidate trio shifts the arena decode probes when the version-keyed
/// layout fails the shape check, most-likely first: insertions only ever
/// push fields UP the alphabetical axis, so +1 (a single new field before
/// the tail) is the canonical next drift, then removal/insertion variants.
const ARENA_TAIL_SHIFTS: [i64; 5] = [0, 1, -1, 2, -2];

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

/// Parse one arena player/bot blob (see [`decode_arena_state`]). The
/// version-keyed [`ArenaFields`] is the primary layout; when its reads fail
/// the cross-player shape check (a version whose insertion has not been
/// pinned yet), the tail trio is probed over [`ARENA_TAIL_SHIFTS`] and the
/// first layout passing the check wins. A blob that fails every candidate
/// still decodes against the version-keyed table — the historical behavior
/// (downstream consumers fall back to their own joins).
fn arena_player_list(
    blob: &[u8],
    version: Option<(u32, u32, u32)>,
    bots: bool,
) -> Vec<wowsp_tauri_shared::ArenaPlayer> {
    let Some(PyVal::List(players)) = parse_pickle(blob) else {
        return Vec::new();
    };
    // Each player is a list of (index, value) tuples (FixedDict pickled
    // flat). Reads tolerate missing pairs — older layouts only ever
    // shrink, never reorder.
    let pairs: Vec<&Vec<PyVal>> = players
        .iter()
        .filter_map(|p| match p {
            PyVal::List(l) => Some(l),
            _ => None,
        })
        .collect();
    if pairs.is_empty() {
        return Vec::new();
    }
    let base = ArenaFields::for_version(version, bots);
    let fields = *ARENA_TAIL_SHIFTS
        .iter()
        .find(|&s| arena_layout_plausible(&pairs, &base.shifted(*s)))
        .unwrap_or(&0);
    pairs
        .iter()
        .filter_map(|p| arena_player_of(p, &base.shifted(fields), bots))
        .collect()
}

/// One player's reads under one layout (see [`arena_player_list`]); `None`
/// when the entity slot is absent or zero.
fn arena_player_of(
    pairs: &[PyVal],
    f: &ArenaFields,
    bots: bool,
) -> Option<wowsp_tauri_shared::ArenaPlayer> {
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
    let entity_id = as_i64(field(f.ship_entity_id)).filter(|e| *e != 0)?;
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
    Some(wowsp_tauri_shared::ArenaPlayer {
        entity_id: entity_id as i32,
        team_id: as_i64(field(f.team_id)).unwrap_or(0) as i8,
        player_id: as_i64(field(f.player_id)).unwrap_or(0),
        ship_params_id: as_i64(field(f.ship_params_id)).unwrap_or(0) as u32,
        max_health: max_health.max(0) as u32,
        name,
        is_bot: bots,
        avatar_id: as_i64(field(f.avatar_id))
            .filter(|v| *v > 0)
            .map(|v| v as i32),
        is_self: false,
    })
}

/// Cross-player shape check for one candidate layout — the drift detector.
/// With the trio read correctly, a human player's ship entity id is exactly
/// its AVATAR entity id + 1 (avatar and vehicle entities are created as a
/// consecutive pair; the avatar slot itself sits at a stable index that has
/// never drifted). Bots carry no avatar, so their check is the trio's own
/// shape: a u32-range GameParams id in the params slot and a 0/1 team slot.
/// A layout is plausible when ≥ 2 players decode an entity and ≥ 80% of
/// those pass their check — the wrong shift misreads EVERY entry (reading
/// e.g. a slot count where the entity id should be), never a near miss.
fn arena_layout_plausible(pairs: &[&Vec<PyVal>], f: &ArenaFields) -> bool {
    let mut with_entity = 0usize;
    let mut consistent = 0usize;
    for p in pairs {
        // `bots: false` — the produced entry's is_bot flag is the one field
        // the checks below never read; the layout probe itself is agnostic.
        let Some(player) = arena_player_of(p, f, false) else {
            continue;
        };
        with_entity += 1;
        let ok = match player.avatar_id {
            Some(avatar) => player.entity_id as i64 == avatar as i64 + 1,
            None => {
                player.ship_params_id >= 100_000_000
                    && player.ship_params_id <= u32::MAX as u32
                    && (player.team_id == 0 || player.team_id == 1)
            },
        };
        if ok {
            consistent += 1;
        }
    }
    with_entity >= 2 && consistent * 5 >= with_entity * 4
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
    // BLOB arg: u8 length prefix + that many payload bytes. WG pickles the
    // dict; Lesta (Мир кораблей) zlib-compresses a MessagePack encoding of
    // the same shape (blob starts with a zlib header, 0x78) and appends a
    // second blob the decoder ignores — inflate before parsing.
    let Some(&len) = args.first() else {
        return out;
    };
    let len = len as usize;
    if len == 0 || args.len() < 1 + len {
        return out;
    }
    let blob = &args[1..1 + len];
    let pickled: Vec<u8> = match blob.first() {
        Some(0x78) => match super::inflate_zlib_with_cap(blob, 1 << 20) {
            Ok(inflated) => inflated,
            Err(_) => return out,
        },
        _ => blob.to_vec(),
    };
    // WG pickles the dict; Lesta serializes the same shape as MessagePack
    // (fixmap of (weapon, category) arrays -> [count, total] pairs, with
    // float32 totals) — normalize both into the sample tuples below.
    let entries: Vec<(i64, i64, i64, f64)> = match parse_pickle(&pickled) {
        Some(PyVal::Dict(entries)) => entries
            .iter()
            .filter_map(|(k, v)| {
                let PyVal::Tuple(key) = k else { return None };
                if key.len() != 2 {
                    return None;
                }
                let (Some(PyVal::Int(weapon)), Some(PyVal::Int(category))) =
                    (key.first(), key.get(1))
                else {
                    return None;
                };
                let PyVal::List(vals) = v else { return None };
                if vals.len() != 2 {
                    return None;
                }
                let Some(PyVal::Int(count)) = vals.first() else {
                    return None;
                };
                let total = match vals.get(1) {
                    Some(PyVal::Float(f)) => *f,
                    Some(PyVal::Int(i)) => *i as f64,
                    _ => return None,
                };
                Some((*weapon, *category, *count, total))
            })
            .collect(),
        _ => parse_damage_stat_msgpack(&pickled),
    };
    for (weapon, category, count, total) in entries {
        out.push(wowsp_tauri_shared::DamageStatSample {
            time,
            weapon,
            category,
            count,
            total,
        });
    }
    out
}

/// Lesta's MessagePack form of `receiveDamageStat`'s payload: a map whose
/// keys are `[weapon, category]` arrays and whose values are
/// `[count, total]` pairs (totals as float32). Only the subset of
/// MessagePack the shape uses is read (fixint / fixed collections / the
/// 1-8 byte numeric primitives); anything else yields an empty vec.
fn parse_damage_stat_msgpack(bytes: &[u8]) -> Vec<(i64, i64, i64, f64)> {
    /// MessagePack recursion guard (audit M-8-class input hardening):
    /// `read` descends one frame per byte on nested fixarray/fixmap
    /// markers, so a hostile blob could reach ~250k frames of recursion
    /// and abort the process on stack overflow (uncatchable). Real
    /// damage-stat payloads nest 3–4 deep; 64 leaves 16x headroom.
    const MSGPACK_MAX_DEPTH: usize = 64;
    #[derive(Clone)]
    enum Val {
        Int(i64),
        Float(f64),
        Array(Vec<Val>),
        Map(Vec<(Val, Val)>),
    }
    fn read(bytes: &[u8], pos: &mut usize, depth: usize) -> Option<Val> {
        if depth > MSGPACK_MAX_DEPTH {
            return None;
        }
        let &first = bytes.get(*pos)?;
        *pos += 1;
        match first {
            0x00..=0x7f => Some(Val::Int(first as i64)),
            0xe0..=0xff => Some(Val::Int(first as i8 as i64)),
            0x80..=0x8f => {
                let mut entries = Vec::with_capacity((first & 0x0f) as usize);
                for _ in 0..(first & 0x0f) {
                    let k = read(bytes, pos, depth + 1)?;
                    let v = read(bytes, pos, depth + 1)?;
                    entries.push((k, v));
                }
                Some(Val::Map(entries))
            },
            0x90..=0x9f => {
                let mut items = Vec::with_capacity((first & 0x0f) as usize);
                for _ in 0..(first & 0x0f) {
                    items.push(read(bytes, pos, depth + 1)?);
                }
                Some(Val::Array(items))
            },
            0xca => {
                let v = f32::from_be_bytes(bytes.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Some(Val::Float(v as f64))
            },
            0xcb => {
                let v = f64::from_be_bytes(bytes.get(*pos..*pos + 8)?.try_into().ok()?);
                *pos += 8;
                Some(Val::Float(v))
            },
            0xcc..=0xd3 => {
                // Width per marker: uint8/int8 → 1, uint16/int16 → 2,
                // uint32/int32 → 4, uint64/int64 → 8 (the int markers do NOT
                // continue the doubling sequence of the uint ones).
                let width = match first {
                    0xcc | 0xd0 => 1,
                    0xcd | 0xd1 => 2,
                    0xce | 0xd2 => 4,
                    _ => 8,
                };
                let raw = bytes.get(*pos..*pos + width)?;
                *pos += width;
                let v = match first {
                    0xcc => raw[0] as i64,
                    0xcd => u16::from_be_bytes(raw.try_into().ok()?) as i64,
                    0xce => u32::from_be_bytes(raw.try_into().ok()?) as i64,
                    0xcf => u64::from_be_bytes(raw.try_into().ok()?) as i64,
                    0xd0 => raw[0] as i8 as i64,
                    0xd1 => i16::from_be_bytes(raw.try_into().ok()?) as i64,
                    0xd2 => i32::from_be_bytes(raw.try_into().ok()?) as i64,
                    _ => i64::from_be_bytes(raw.try_into().ok()?),
                };
                Some(Val::Int(v))
            },
            _ => None,
        }
    }
    let mut pos = 0usize;
    // The whole payload must be one map.
    let Some(Val::Map(entries)) = read(bytes, &mut pos, 0) else {
        return Vec::new();
    };
    let as_int = |v: Option<&Val>| match v {
        Some(Val::Int(i)) => Some(*i),
        _ => None,
    };
    let as_f64 = |v: Option<&Val>| match v {
        Some(Val::Int(i)) => Some(*i as f64),
        Some(Val::Float(f)) => Some(*f),
        _ => None,
    };
    entries
        .into_iter()
        .filter_map(|(key, val)| {
            // Key: [weapon, category]; value: [count, total].
            let Val::Array(key) = key else {
                return None;
            };
            let Val::Array(val) = val else {
                return None;
            };
            Some((
                as_int(key.first())?,
                as_int(key.get(1))?,
                as_int(val.first())?,
                as_f64(val.get(1))?,
            ))
        })
        .collect()
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

/// The hidden-marker sentinel of `MINIMAP_USER_INFO.packedData` (experiment
/// E11): bit 31 set, everything else zero — the unspotted state.
const MINIMAP_HIDDEN_SENTINEL: u32 = 0x8000_0000;

/// Decode `updateMinimapVisionInfo` args (experiment E11): two `MINIMAPINFO`
/// arrays (`ARRAY<MINIMAP_USER_INFO>`, per the 15.8.0 `alias.xml`), each
/// laid out as `[u8 count]{ [u32 vehicleID][u32 packedData] }`.
///
/// The first array carries the live marker updates — the opening packet of a
/// battle contains the whole allied set, later packets only vehicles whose
/// marker state changed (movement, or the hidden sentinel on unspot). The
/// second array was empty in all 1,821 reference-capture calls; its entries
/// are decoded with the same rules (the sentinel test is on the value itself)
/// so a future firing is preserved as evidence rather than guessed at.
///
/// Any desync (truncated entry, trailing bytes) drops the whole packet's
/// events — a misaligned walk would fabricate entity ids.
pub(super) fn decode_minimap_vision(
    time: f32,
    args: &[u8],
) -> Vec<wowsp_tauri_shared::VisionEvent> {
    let mut out = Vec::new();
    let mut off = 0usize;
    for _ in 0..2 {
        let Some(&count) = args.get(off) else {
            return Vec::new();
        };
        off += 1;
        for _ in 0..count {
            let (Some(id), Some(packed)) = (
                read_bytes(args, off).map(u32::from_le_bytes),
                read_bytes(args, off + 4).map(u32::from_le_bytes),
            ) else {
                return Vec::new();
            };
            off += 8;
            out.push(wowsp_tauri_shared::VisionEvent {
                time,
                entity_id: id as i32,
                visible: packed != MINIMAP_HIDDEN_SENTINEL,
                packed_data: packed,
            });
        }
    }
    if off != args.len() {
        return Vec::new();
    }
    out
}

/// Decode Vehicle `onConsumableUsed` args (experiment E11):
/// `[u8 blob_len][CONSUMABLE_USAGE_PARAMS blob][f32 workTimeLeft]`.
///
/// The params blob's first byte is the `ConsumableUsageType` (serialized by
/// the game's `CommonConsumables.UsageConverter`, mirrored by upstream
/// wows-toolkit's wows-replays decoder): 0 = none (empty blob), 1 = default `<BB>`
/// (usage + consumable id), 2 = position `<BBff>` (+ map x/z), 3 = entity
/// target `<BBbQ>` (+ i8 target type + u64 target id). A blob whose length
/// contradicts its declared variant is a desync — the call is skipped rather
/// than half-decoded.
pub(super) fn decode_consumable_used(
    time: f32,
    entity_id: i32,
    args: &[u8],
) -> Option<wowsp_tauri_shared::ConsumableUseEvent> {
    let &blob_len = args.first()?;
    let blob_len = blob_len as usize;
    let blob = args.get(1..1 + blob_len)?;
    let duration = f32::from_le_bytes(read_bytes(args, 1 + blob_len)?);
    if !duration.is_finite() || duration < 0.0 {
        return None;
    }
    let mut event = wowsp_tauri_shared::ConsumableUseEvent {
        time,
        entity_id,
        usage_type: 0,
        consumable_id: 0,
        duration,
        target_x: None,
        target_z: None,
        target_id: None,
    };
    match blob.first().copied() {
        // NONE — empty blob (or a single zero byte, as the reference accepts);
        // trailing bytes past one would be a desync, not a valid NONE payload.
        None | Some(0) if blob_len <= 1 => (),
        // DEFAULT: <BB> = usage + consumable id.
        Some(1) if blob_len == 2 => {
            event.usage_type = 1;
            event.consumable_id = blob[1];
        },
        // POSITION: <BBff> = usage + consumable id + map x + map z.
        Some(2) if blob_len == 10 => {
            event.usage_type = 2;
            event.consumable_id = blob[1];
            event.target_x = Some(f32::from_le_bytes(read_bytes(blob, 2)?));
            event.target_z = Some(f32::from_le_bytes(read_bytes(blob, 6)?));
        },
        // ENTITY: <BBbQ> = usage + consumable id + target type + target id.
        Some(3) if blob_len == 11 => {
            event.usage_type = 3;
            event.consumable_id = blob[1];
            event.target_id = Some(u64::from_le_bytes(read_bytes(blob, 3)?));
        },
        _ => return None,
    }
    Some(event)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Audit M-8-class regression: a hostile blob of nested fixarray-1
    /// markers — one recursion frame per byte once inflated (deflate's
    /// ratio bounds the inflation at ~264 KB, well under the 1 MiB zlib
    /// cap, and still ~10× more frames than the stack holds) — used to
    /// drive `read` into a ~250k-frame recursion, an uncatchable
    /// stack-overflow abort. The depth cap must degrade to the empty-vec
    /// contract instead.
    #[test]
    fn hostile_msgpack_nesting_is_depth_capped() {
        let hostile = vec![0x91u8; 100_000];
        assert!(parse_damage_stat_msgpack(&hostile).is_empty());
        // Just past the cap also refuses: a 65-level fixarray-1 chain.
        let deep = vec![0x91u8; 65];
        assert!(parse_damage_stat_msgpack(&deep).is_empty());
    }

    /// Emit one `(int key, int|str value)` pair as pickle: INT text form for
    /// both integers (handles the u32-range params ids BININT cannot carry),
    /// SHORT_BINSTRING for strings, TUPLE2 to close the pair.
    fn pair(buf: &mut Vec<u8>, key: i64, value: &PyVal) {
        let int = |b: &mut Vec<u8>, v: i64| {
            b.extend_from_slice(b"I");
            b.extend_from_slice(v.to_string().as_bytes());
            b.push(b'\n');
        };
        int(buf, key);
        match value {
            PyVal::Int(v) => int(buf, *v),
            PyVal::Str(s) => {
                buf.push(0x55); // SHORT_BINSTRING
                buf.push(s.len() as u8);
                buf.extend_from_slice(s.as_bytes());
            },
            _ => unreachable!("test fixture values are ints/strings"),
        }
        buf.push(0x86); // TUPLE2
    }

    /// Pickle a players blob: outer LIST of per-player pair LISTS (proto 2,
    /// MARK/APPENDS framing — the shape `parse_pickle` consumes).
    fn players_blob(players: &[Vec<(i64, PyVal)>]) -> Vec<u8> {
        let mut b = vec![0x80, 0x02, 0x5d, 0x28]; // PROTO 2, EMPTY_LIST, MARK
        for pairs in players {
            b.push(0x5d); // EMPTY_LIST (this player's pairs)
            b.push(0x28); // MARK
            for (k, v) in pairs {
                pair(&mut b, *k, v);
            }
            b.push(0x6c); // LIST
        }
        b.push(0x65); // APPENDS
        b.push(0x2e); // STOP
        b
    }

    /// The 15.9.0 player shape (one new field before the tail pushed the
    /// trio to 34/35/37): avatar 2, player id 11, max health 24, name 25,
    /// slot-count-ish small int 33, ship entity 34, params id 35, team 37.
    fn player_159(
        avatar: i64,
        account: i64,
        hp: i64,
        name: &str,
        entity: i64,
        params: i64,
        team: i64,
    ) -> Vec<(i64, PyVal)> {
        vec![
            (2, PyVal::Int(avatar)),
            (11, PyVal::Int(account)),
            (24, PyVal::Int(hp)),
            (25, PyVal::Str(name.to_string())),
            (33, PyVal::Int(34)),
            (34, PyVal::Int(entity)),
            (35, PyVal::Int(params)),
            (37, PyVal::Int(team)),
        ]
    }

    /// The pre-15.9 player shape (0.11.11+ trio at 33/34/36).
    fn player_1111(
        avatar: i64,
        account: i64,
        hp: i64,
        name: &str,
        entity: i64,
        params: i64,
        team: i64,
    ) -> Vec<(i64, PyVal)> {
        vec![
            (2, PyVal::Int(avatar)),
            (11, PyVal::Int(account)),
            (24, PyVal::Int(hp)),
            (25, PyVal::Str(name.to_string())),
            (33, PyVal::Int(entity)),
            (34, PyVal::Int(params)),
            (36, PyVal::Int(team)),
        ]
    }

    #[test]
    fn arena_159_layout_decodes() {
        let blob = players_blob(&[
            player_159(839071, 672005842, 14700, "langyo", 839072, 4078352368, 0),
            player_159(
                839051,
                671965198,
                31400,
                "CharlesDuck",
                839052,
                4278105904,
                0,
            ),
            player_159(
                839053,
                671914004,
                50850,
                "_Aul_NIshizumi_",
                839054,
                3765385168,
                1,
            ),
        ]);
        let out = arena_player_list(&blob, Some((15, 9, 0)), false);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].entity_id, 839072);
        assert_eq!(out[0].avatar_id, Some(839071));
        assert_eq!(out[0].ship_params_id, 4078352368);
        assert_eq!(out[0].team_id, 0);
        assert_eq!(out[0].player_id, 672005842);
        assert_eq!(out[0].max_health, 14700);
        assert_eq!(out[0].name, "langyo");
        assert_eq!(out[2].team_id, 1);
    }

    /// The drift this fix ships for: a replay whose version predates the
    /// pinned 15.9.0 row would read the trio one slot low (entity 34 read
    /// at 33 → slot-count garbage). The probe's +1 shift heals it without a
    /// table row — the safety net for the NEXT unpinned insertion too.
    #[test]
    fn arena_probe_heals_unpinned_tail_drift() {
        let blob = players_blob(&[
            player_159(839071, 672005842, 14700, "langyo", 839072, 4078352368, 0),
            player_159(
                839051,
                671965198,
                31400,
                "CharlesDuck",
                839052,
                4278105904,
                0,
            ),
            player_159(
                839053,
                671914004,
                50850,
                "_Aul_NIshizumi_",
                839054,
                3765385168,
                1,
            ),
        ]);
        let out = arena_player_list(&blob, Some((15, 8, 0)), false);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].entity_id, 839072);
        assert_eq!(out[0].ship_params_id, 4078352368);
        assert_eq!(out[0].team_id, 0);
    }

    /// The 0.11.11+ layout decodes unchanged at shift 0 (no probe detour).
    #[test]
    fn arena_pre159_layout_unchanged() {
        let blob = players_blob(&[
            player_1111(101, 1, 20000, "alpha", 102, 3765385168, 0),
            player_1111(201, 2, 30000, "bravo", 202, 4278105904, 1),
        ]);
        let out = arena_player_list(&blob, Some((0, 11, 11)), false);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].entity_id, 102);
        assert_eq!(out[0].ship_params_id, 3765385168);
        assert_eq!(out[1].team_id, 1);
    }

    /// Bots carry no avatar, so the plausibility check rides the trio's own
    /// shape (u32-range params id + 0/1 team). The 0.12.8 bot row is still
    /// served for 15.9.0 bots (no capture pinned yet) — a drifted bot blob
    /// must heal through the probe exactly like the human one.
    #[test]
    fn arena_bot_blob_probes_without_avatar() {
        let bot = |entity_at: i64| -> Vec<(i64, PyVal)> {
            vec![
                (10, PyVal::Int(9001)),
                (18, PyVal::Int(12000)),
                (19, PyVal::Str("Bot".into())),
                (entity_at, PyVal::Int(555001)),
                (entity_at + 1, PyVal::Int(4184749872)),
                (entity_at + 3, PyVal::Int(1)),
            ]
        };
        // Pinned 0.12.8 bot layout (trio at 23/24/26): decodes as-is.
        let pinned = players_blob(&[bot(23), bot(23)]);
        let out = arena_player_list(&pinned, Some((0, 12, 8)), true);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].entity_id, 555001);
        assert_eq!(out[0].ship_params_id, 4184749872);
        assert!(out[0].is_bot);
        assert_eq!(out[0].avatar_id, None);
        // The same blob one field late (a 15.9-style insertion): the probe's
        // +1 shift restores the reads.
        let drifted = players_blob(&[bot(24), bot(24)]);
        let out = arena_player_list(&drifted, Some((0, 12, 8)), true);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].entity_id, 555001);
        assert_eq!(out[0].ship_params_id, 4184749872);
        assert_eq!(out[0].team_id, 1);
    }
}
