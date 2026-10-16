use super::*;
/// Parse a Version (0x16) payload: u32 length + UTF-8 string.
pub(super) fn parse_version(payload: &[u8]) -> Option<String> {
    if payload.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes(payload[0..4].try_into().ok()?) as usize;
    let body = payload.get(4..4 + len.min(payload.len() - 4))?;
    String::from_utf8(body.to_vec()).ok()
}

/// Parse a Camera (0x25) payload: quaternion (4×f32), camera position (3×f32),
/// fov (f32), [unknown f32 when ≥60 bytes], position (3×f32), direction (3×f32).
pub(super) fn parse_camera(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::CameraSample> {
    if payload.len() < 56 {
        return None;
    }
    Some(wowsp_tauri_shared::CameraSample {
        time,
        rot_x: f32::from_le_bytes(read_bytes(payload, 0)?),
        rot_y: f32::from_le_bytes(read_bytes(payload, 4)?),
        rot_z: f32::from_le_bytes(read_bytes(payload, 8)?),
        rot_w: f32::from_le_bytes(read_bytes(payload, 12)?),
        x: f32::from_le_bytes(read_bytes(payload, 16)?),
        y: f32::from_le_bytes(read_bytes(payload, 20)?),
        z: f32::from_le_bytes(read_bytes(payload, 24)?),
        fov: f32::from_le_bytes(read_bytes(payload, 28)?),
    })
}

/// Parse a PlayerNetStats (0x1d) payload: one packed u32 (fps 8b | ping 16b |
/// isLagging 1b).
pub(super) fn parse_net_stats(
    payload: &[u8],
    time: f32,
) -> Option<wowsp_tauri_shared::NetStatsSample> {
    if payload.len() < 4 {
        return None;
    }
    let v = u32::from_le_bytes(payload[0..4].try_into().ok()?);
    Some(wowsp_tauri_shared::NetStatsSample {
        time,
        fps: (v & 0xFF) as u8,
        ping: ((v >> 8) & 0xFFFF) as u16,
        is_lagging: (v >> 24) & 1 != 0,
    })
}

/// Extract the map name from a Map (0x28) payload. Layout: u32 space_id,
/// i64 arena_id, u32 unknown1, u32 unknown2, blob, [u32 len, C-string
/// map_name], 64-byte matrix, u8 unknown. Rather than trusting the blob
/// length, scan for the "spaces/" prefix and read the C-string after it.
pub(super) fn parse_map_name(payload: &[u8]) -> Option<String> {
    let idx = payload.windows(7).position(|w| w == b"spaces/")?;
    let off = idx;
    let end = payload[off..]
        .iter()
        .position(|&b| b == 0)
        .map(|i| off + i)
        .unwrap_or(payload.len());
    let name = std::str::from_utf8(&payload[off..end]).ok()?;
    if name.is_empty() || name.len() > 120 {
        return None;
    }
    Some(name.to_string())
}

/// Parse a CameraMode (0x27) payload: one u32 mode id.
pub(super) fn parse_camera_mode(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::HpSample> {
    if payload.len() < 4 {
        return None;
    }
    Some(wowsp_tauri_shared::HpSample {
        time,
        value: u32::from_le_bytes(payload[0..4].try_into().ok()?),
    })
}

/// Parse a CruiseState (0x32) payload — the recorder's discrete control
/// presets (experiment E2). Reverse-engineered layout (every packet on the
/// 15.8.0 reference replay was exactly 8 bytes):
///
///   `u32 controller, i32 level` (both little-endian)
///
/// Despite the module's entity-centric packets, the first u32 is NOT a
/// BigWorld entity id — observed values are only 0/1, with 0 verified as the
/// engine telegraph (throttle) and 1 as the rudder via position/yaw
/// correlation on the reference replay. Levels with no confirmed meaning
/// decode with `value: None`; among confirmed levels the rudder magnitude
/// mapping is itself inferred (5-mark scaling), not separately confirmed —
/// see [`wowsp_tauri_shared::CruiseSample`] for the per-branch evidence
/// grading. Payloads that are not exactly 8 bytes are skipped (never
/// observed, but a future layout change must not silently misparse).
pub(super) fn parse_cruise_state(
    payload: &[u8],
    time: f32,
) -> Option<wowsp_tauri_shared::CruiseSample> {
    if payload.len() != 8 {
        return None;
    }
    let controller = u32::from_le_bytes(payload[0..4].try_into().ok()?);
    let level = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    Some(wowsp_tauri_shared::CruiseSample {
        time,
        controller,
        level,
        value: wowsp_tauri_shared::CruiseSample::map_value(controller, level),
    })
}

/// Parse a NestedPropertyUpdate (0x23) payload: `i32 entity_id, u8 is_slice,
/// u32 payload_size, payload`. The payload blob (BigWorld nested property
/// encoding) is kept raw; capture progress is read from its tail.
pub(super) fn parse_nested_property(payload: &[u8], time: f32) -> Option<RawNestedProperty> {
    if payload.len() < 9 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let size = u32::from_le_bytes(payload[5..9].try_into().ok()?) as usize;
    let data = payload.get(9..9 + size.min(payload.len() - 9))?.to_vec();
    Some(RawNestedProperty {
        time,
        entity_id,
        payload: data,
    })
}

/// Shape gate for GlobalWeather GameParams ids: every entry in a 15.8
/// GameParams dump (all 35) has low 16 bits `0xC7B0`, nibble 4 at bits 16..20,
/// and a top byte of 0xFD/0xFE/0xFF (e.g. 4293183408 PCOW001_Sunny,
/// 4283746224 PCOW010_Rain_Logic). Ship and consumable ids never share the
/// shape, so the gate alone separates weather values from squadron positions
/// and other nested-property traffic.
pub(super) fn is_global_weather_param(id: u32) -> bool {
    (id & 0xFFFF) == 0xC7B0 && ((id >> 16) & 0x0F) == 4 && matches!(id >> 24, 0xFD..=0xFF)
}

/// Parse the global-weather state out of a NestedPropertyUpdate (0x23) blob
/// from the BattleLogic entity (`state.weather.globalWeather`). Two SetKey
/// shapes exist, each a version-drifting bit-path prefix followed by the
/// value:
///   "item" (16 bytes): `[prefix u32?][fromParam u32][toParam u32]
///    [startTime u16][endTime u16]` — the linear interpolation window
///    (battle seconds) between two weather logics;
///   "notification" (10 bytes): `[prefix u32?][param u32][time u16]` — the
///    cyclone/storm approach warning.
/// The prefix LENGTH drifts across versions, but the value block always
/// ENDS the payload — both shapes are therefore read straight off the tail,
/// and a mis-anchored blob simply fails the weather-id shape gate. The
/// horizon is 7200 s, not the 1200 s battle cap, because the server's
/// trailing window overruns the battle — the 15.8 capture's final blend is
/// Evening→Evening over 972..6972. Nested payloads on other entities
/// (squadron positions, capture progress) never satisfy the gate. Verified
/// on that 15.8 cyclone replay.
pub(super) fn parse_weather_nested(payload: &[u8]) -> Option<WeatherSignal> {
    // Two hours: a generous schedule horizon covering the observed 6972 s
    // tail window while still rejecting arbitrary u16 garbage.
    const MAX_SCHEDULE_S: u16 = 7200;
    if payload.len() >= 12 {
        let o = payload.len() - 12;
        let (Some(from_param), Some(to_param)) = (
            read_bytes(payload, o).map(u32::from_le_bytes),
            read_bytes(payload, o + 4).map(u32::from_le_bytes),
        ) else {
            return None;
        };
        let (Some(start_time), Some(end_time)) = (
            read_bytes(payload, o + 8).map(u16::from_le_bytes),
            read_bytes(payload, o + 10).map(u16::from_le_bytes),
        ) else {
            return None;
        };
        if is_global_weather_param(from_param)
            && is_global_weather_param(to_param)
            && start_time < end_time
            && end_time <= MAX_SCHEDULE_S
        {
            return Some(WeatherSignal::Transition {
                from_param,
                to_param,
                start_time: start_time as f32,
                end_time: end_time as f32,
            });
        }
    }
    if payload.len() >= 6 {
        let o = payload.len() - 6;
        let (Some(param), Some(at_time)) = (
            read_bytes(payload, o).map(u32::from_le_bytes),
            read_bytes(payload, o + 4).map(u16::from_le_bytes),
        ) else {
            return None;
        };
        if is_global_weather_param(param) && at_time <= MAX_SCHEDULE_S {
            return Some(WeatherSignal::Notification {
                param,
                at_time: at_time as f32,
            });
        }
    }
    None
}

/// Parse a SetWeaponLock (0x30) payload: three u32s (weapon_type, lock_type,
/// target_id).
pub(super) fn parse_weapon_lock(
    payload: &[u8],
    time: f32,
) -> Option<wowsp_tauri_shared::WeaponLockEvent> {
    if payload.len() < 12 {
        return None;
    }
    let weapon_type = u32::from_le_bytes(payload[0..4].try_into().ok()?);
    let lock_type = u32::from_le_bytes(payload[4..8].try_into().ok()?);
    let target_id = i32::from_le_bytes(payload[8..12].try_into().ok()?);
    Some(wowsp_tauri_shared::WeaponLockEvent {
        time,
        weapon_type,
        lock_type,
        target_id,
    })
}

/// Parse a BattleResults (0x22) payload: u32 length + UTF-8 string.
pub(super) fn parse_battle_results(payload: &[u8]) -> Option<String> {
    if payload.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes(payload[0..4].try_into().ok()?) as usize;
    let body = payload.get(4..4 + len.min(payload.len() - 4))?;
    String::from_utf8(body.to_vec()).ok()
}

/// Parse a CellPlayerCreate (0x01) payload — the recorder's own avatar. Layout
/// differs from EntityCreate: `i32 entity_id, u32 space_id, u32 vehicle_id,
/// f32×3 position, f32×3 rotation, u32 props_len, props`. The entity type is
/// always Avatar (spec 1).
pub(super) fn parse_cell_player_create(payload: &[u8], time: f32) -> Option<ParsedCreate> {
    if payload.len() < 38 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    // space_id at [4..8] — unused.
    let vehicle_id = i32::from_le_bytes(payload[8..12].try_into().ok()?);
    let x = f32::from_le_bytes(payload[12..16].try_into().ok()?);
    let y = f32::from_le_bytes(payload[16..20].try_into().ok()?);
    let z = f32::from_le_bytes(payload[20..24].try_into().ok()?);
    Some(ParsedCreate {
        entity_id,
        entity_type: ENTITY_TYPE_AVATAR,
        vehicle_id,
        x,
        y,
        z,
        creation_time: time,
        radius: None,
        control_point_index: None,
        initial_team: None,
    })
}

/// Parse an EntityMethod (0x08) payload: `i32 entity_id, i32 method_id`,
/// followed by a `u32 args_len` + args blob (BigWorld RPC BinaryStream).
/// The args are kept raw — decoding happens against the receiver's method
/// table afterwards.
pub(super) fn parse_entity_method(payload: &[u8], time: f32) -> Option<RawMethodCall> {
    if payload.len() < 12 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let method_id = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    let args_len = u32::from_le_bytes(payload[8..12].try_into().ok()?) as usize;
    // A declared length beyond the payload is a framing error — skip the
    // call entirely rather than decode a truncated (half) argument blob.
    let args = payload.get(12..12 + args_len)?.to_vec();
    Some(RawMethodCall {
        time,
        entity_id,
        method_id,
        args,
    })
}

/// Parsed EntityCreate used internally to key the kinds map; converted to
/// [`EntityKind`] before insertion. Carries the entity id separately.
pub(super) struct ParsedCreate {
    pub(super) entity_id: i32,
    pub(super) entity_type: i16,
    vehicle_id: i32,
    pub(super) x: f32,
    pub(super) y: f32,
    pub(super) z: f32,
    creation_time: f32,
    /// Capture-zone radius (metres) recovered from the state stream when the
    /// entity is an InteractiveZone; `None` for other types or when no
    /// candidate is found.
    radius: Option<f32>,
    /// 0-based capture-point index (A=0, B=1, ...) when the create state
    /// carries a real `controlPoint` component; `None` otherwise (strike /
    /// event zones have an empty componentsState).
    control_point_index: Option<i32>,
    /// Initial owning team (0/1, -1 = neutral) from the `teamId` property.
    initial_team: Option<i8>,
}

impl ParsedCreate {
    pub(super) fn clone_into_kind(self) -> EntityKind {
        EntityKind {
            entity_type: self.entity_type,
            vehicle_id: self.vehicle_id,
            initial_x: self.x,
            initial_y: self.y,
            initial_z: self.z,
            creation_time: self.creation_time,
            ship_id: None,
            max_health: None,
            radius: self.radius,
            control_point_index: self.control_point_index,
            initial_team: self.initial_team,
        }
    }
}

/// Initial owning team of an InteractiveZone from its create state: the
/// InteractiveZone `teamId` property (INT8) is the first property byte of
/// the state stream — `[u32 len][0c 00]<teamId>...` — so it sits at offset
/// 6: -1 = neutral, 0/1 = team. Zones owned from match start never emit
/// capSamples/capProgress updates, so the opening colour must come from
/// here. Verified across domination/PvE/brawl and current clients.
fn scan_state_for_team(state: &[u8]) -> Option<i8> {
    if state.len() < 7 {
        return None;
    }
    let t = state[6] as i8;
    (t == -1 || t == 0 || t == 1).then_some(t)
}

/// Detect a real domination point in an InteractiveZone (type 14) create
/// state. Real points carry the `componentsState` property (index 10) with a
/// non-empty `controlPoint` component, packed as:
///
///   `0a 01 b0 c7 e5 ff ff ff ff ff <type> 00 <index>`
///
/// (property 10 present, buoyVisualId constant 0xffe5c7b0, nextControlPoint
/// -1, ControlPointType byte, empty timer name, 0-based point index).
/// Strike/event zones keep componentsState empty (`0a 00`) and never match.
///
/// The ControlPointType byte is mode- and version-drifting (1 = Control on
/// domination_3/4-point layouts, 5 on the 15.8 domination_2point one) and
/// stays OUT of the match — hard-coding it silently dropped every real
/// point on 2-cap layouts (the create state still carries everything; only
/// the trailing index was unreadable). The `00` separator and a small index
/// keep accidental buoy-constant lookalikes (e.g. a GUID embedding the
/// bytes) from producing a phantom point.
/// Verified byte-identical across domination, PvE, brawl, and asymmetric
/// modes on 15.8.
pub(super) fn scan_state_for_control_point(state: &[u8]) -> Option<i32> {
    const SIG: [u8; 10] = [0x0a, 0x01, 0xb0, 0xc7, 0xe5, 0xff, 0xff, 0xff, 0xff, 0xff];
    state
        .windows(SIG.len() + 3)
        .position(|w| w[..SIG.len()] == SIG)
        .filter(|&i| state[i + SIG.len() + 1] == 0 && state[i + SIG.len() + 2] < 16)
        .map(|i| state[i + SIG.len() + 2] as i32)
}

/// Scan an EntityCreate state stream for any roster shipId (u32 LE, sliding
/// 4-byte window). The state blob packs the entity's initial property values;
/// one of them is the ship's GameParams id (observed at offsets ~160-260
/// depending on game version and variable-length fields before it). Returns
/// the first candidate found; empirically each ship entity embeds exactly one.
///
/// Lesta (Мир кораблей) wraps that property in a base64-encoded blob inside
/// the state (verified on 26.10: every ship entity carries exactly one long
/// base64 run whose decoded bytes hold the shipId), so the scan also runs
/// over each maximal base64 run's decoded bytes. A run that isn't valid
/// base64 decodes to garbage that simply matches no candidate.
pub(super) fn scan_state_for_ship_id(
    state: &[u8],
    candidates: &std::collections::HashSet<u32>,
) -> Option<i64> {
    if candidates.is_empty() || state.len() < 4 {
        return None;
    }
    for off in 0..=state.len() - 4 {
        let val = u32::from_le_bytes(state[off..off + 4].try_into().ok()?);
        if candidates.contains(&val) {
            return Some(val as i64);
        }
    }
    scan_base64_runs_for_ship_id(state, candidates)
}

/// Walk a SmokeScreen EntityCreate state stream and extract the `radius` and
/// `height` properties (experiment E8).
///
/// Layout (ground truth: the 15.8.0 `SmokeScreen.def` plus BigWorld's exposed
/// property indexing — client-visible properties sorted by wire size, equal
/// sizes keeping def order, verified by the zone teamId walk):
///
/// ```text
/// [u32 state_len][u8 n_props]{ [u8 prop_id][value] }×n
///   id 0  activePointIndex  INT8
///   id 1  bcRadius          FLOAT32   (collision radius — observed == radius)
///   id 2  radius            FLOAT32   ← the smoke-cloud radius
///   id 3  height            FLOAT32   ← column height (5=ship, 10=plane)
///   id 4  points            ARRAY<VECTOR3> (u8 count + n×12 bytes)
///   id 5  spawnPointEffect  STRING    ("particles/SmokeScreen_spawn.xml")
///   id 6  livePointEffect   STRING    ("particles/SmokeScreen.xml")
/// ```
///
/// Evidence chain (15.8.0 reference replay): walked radii {17.0, 17.5, 30.0}
/// exactly match the GameParams `logic.radius` of the three smoke families
/// actually present in the match — Italian exhaust smoke (Amalfi/Veneto,
/// r=17), support-CV plane smoke (Yorktown US_SCV, r=17.5, height 10) and
/// Italian BB oil smoke (Colonna, r=30) — and each smoke's create position
/// sits within 1–4 scene units of the identified layer's hull. Wire values
/// are in the GameParams distance unit (≈30 m; calibrated via radar
/// `distShip`), not the 5.86 m/unit scene axis.
///
/// Any desync (unknown id, truncated value) yields `(None, None)` rather
/// than a guessed mapping — a future def change shifts the ids and disables
/// the fields instead of misreporting.
pub(super) fn parse_smoke_state(state: &[u8]) -> (Option<f32>, Option<f32>) {
    // Skip the u32 state-length prefix; a blob shorter than the count byte
    // plus one property header cannot carry the fields we want.
    let Some(blob) = state.get(4..) else {
        return (None, None);
    };
    let Some(&n_props) = blob.first() else {
        return (None, None);
    };
    let mut radius = None;
    let mut height = None;
    let mut off = 1usize;
    for _ in 0..n_props {
        let Some(&id) = blob.get(off) else {
            return (None, None);
        };
        off += 1;
        match id {
            0 => off += 1, // activePointIndex: INT8
            1..=3 => {
                // bcRadius / radius / height: FLOAT32.
                let Some(bytes) = blob.get(off..off + 4) else {
                    return (None, None);
                };
                off += 4;
                let Some(v) = read_bytes::<4>(bytes, 0).map(f32::from_le_bytes) else {
                    return (None, None);
                };
                if !v.is_finite() {
                    return (None, None);
                }
                if id == 2 {
                    radius = Some(v);
                } else if id == 3 {
                    height = Some(v);
                }
            },
            4 => {
                // points: u8 count + count × VECTOR3.
                let Some(&count) = blob.get(off) else {
                    return (None, None);
                };
                off += 1 + 12 * count as usize;
            },
            5 | 6 => {
                // effect strings: u8 length + bytes.
                let Some(&len) = blob.get(off) else {
                    return (None, None);
                };
                off += 1 + len as usize;
            },
            _ => return (None, None),
        }
        if off > blob.len() {
            return (None, None);
        }
    }
    // Plausibility gates: every GameParams smoke radius observed so far is
    // 13.3–40 and heights 5–10; anything else means the walk misaligned.
    if let Some(r) = radius {
        if !(1.0..=100.0).contains(&r) {
            return (None, None);
        }
    }
    if let Some(h) = height {
        if !(0.5..=100.0).contains(&h) {
            return (None, None);
        }
    }
    (radius, height)
}

/// Scan a ship's EntityCreate state stream for its starting (max) health.
/// The state packs the entity's initial property values as
/// `<u16 property index><value>` entries, and the health property sits at a
/// field-order-dependent offset that drifts between game versions (verified
/// across two clients: WG 15.8.1 carries the exact arena maxHealth at
/// offsets 73/88 in one capture, 111/126 in another; Lesta 26.10 around
/// 117/132), so neither a fixed offset nor an alignment guess is safe — a
/// real capture misaligns both ways. What HOLDS on both clients: the
/// starting health is written twice (the current-health and max-health
/// properties, equal at spawn, ~15 bytes apart) while every other in-band
/// reading is a one-off straddle artifact (a neighbouring field's tail
/// bytes + a property index + the health float's exponent byte decode to a
/// plausible-looking integer — observed as 131196 next to a true 27300 and
/// 10816 next to a true 41200). The scan therefore takes the LARGEST
/// integral f32 in the plausible full-HP band that occurs at least twice in
/// the state (a per-version damage-cap constant sits far above the band —
/// 200000 on 26.10 — and real property values sit far below it); no
/// duplicated member yields `None` and consumers fall back to their
/// existing peak/encyclopedia totals.
pub(super) fn scan_state_for_max_health(state: &[u8]) -> Option<u32> {
    const LO: f32 = 5000.0;
    const HI: f32 = 150_000.0;
    if state.len() < 4 {
        return None;
    }
    let mut seen: Vec<(u32, u8)> = Vec::new(); // (value, times) — a handful of band members at most.
    for off in 0..=state.len() - 4 {
        let v = f32::from_le_bytes(state[off..off + 4].try_into().ok()?);
        if v > LO && v < HI && v == v.trunc() {
            let key = v as u32;
            match seen.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 += 1,
                None => seen.push((key, 1)),
            }
        }
    }
    seen.iter()
        .filter(|(_, times)| *times >= 2)
        .map(|(value, _)| *value)
        .max()
}

/// Minimal base64 run finder + decoder feeding the Lesta leg of
/// [`scan_state_for_ship_id`]: walk maximal `[A-Za-z0-9+/]{16,}` stretches,
/// trim a trailing partial quantum, decode, and slide the same 4-byte
/// candidate window over the decoded bytes.
fn scan_base64_runs_for_ship_id(
    state: &[u8],
    candidates: &std::collections::HashSet<u32>,
) -> Option<i64> {
    const MIN_RUN: usize = 16;
    let b64_val = |b: u8| -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut i = 0;
    while i + MIN_RUN <= state.len() {
        if b64_val(state[i]).is_none() {
            i += 1;
            continue;
        }
        let start = i;
        while i < state.len() && b64_val(state[i]).is_some() {
            i += 1;
        }
        if i - start < MIN_RUN {
            continue;
        }
        // Decode whole 4-char quanta (a trailing partial quantum carries no
        // full byte anyway).
        let mut decoded = Vec::with_capacity((i - start) / 4 * 3);
        for chunk in state[start..i].chunks(4) {
            let mut acc: u32 = 0;
            for &b in chunk {
                acc = (acc << 6) | b64_val(b)? as u32;
            }
            match chunk.len() {
                4 => {
                    decoded.push((acc >> 16) as u8);
                    decoded.push((acc >> 8) as u8);
                    decoded.push(acc as u8);
                },
                3 => {
                    acc <<= 6;
                    decoded.push((acc >> 16) as u8);
                    decoded.push((acc >> 8) as u8);
                },
                2 => {
                    acc <<= 12;
                    decoded.push((acc >> 16) as u8);
                },
                _ => {},
            }
        }
        if decoded.len() >= 4 {
            for off in 0..=decoded.len() - 4 {
                let val = u32::from_le_bytes(decoded[off..off + 4].try_into().ok()?);
                if candidates.contains(&val) {
                    return Some(val as i64);
                }
            }
        }
    }
    None
}

/// Scan an EntityCreate state stream for the capture-zone radius: a f32 with
/// an integral value in the 20..700 m range. The state packs three integral
/// floats at stable offsets on current clients (verified across 30 replays /
/// 6 maps on 15.8: offsets 18/98/102 in every state): the per-zone RADIUS
/// first (80 m Atlantic … 140 m Britain, 100/120 m Shards — matches the
/// rings traced off the in-game minimap), then a mode-wide constant 40 and a
/// flag 1. The FIRST candidate is therefore the radius; taking the last one
/// used to grab the 40 m constant and drew every ring ~2.5× too small.
/// Classic points are 20..150 m and the scan must not cap there (bigger
/// layouts exist), but the range has to stay clear of the trailing 1.0.
pub(super) fn scan_state_for_radius(state: &[u8]) -> Option<f32> {
    if state.len() < 4 {
        return None;
    }
    for off in 0..=state.len() - 4 {
        let f = f32::from_le_bytes(state[off..off + 4].try_into().ok()?);
        if f.is_finite() && (20.0..=700.0).contains(&f) && (f - f.round()).abs() < 0.01 {
            return Some(f);
        }
    }
    None
}

/// Parse an EntityCreate (0x05) payload. WoWS layout (from
/// `clients/wows/network/packets/EntityCreate.py`):
///   i32 entity_id, i16 type, i32 vehicle_id, i32 space_id,
///   f32×3 position, f32×3 direction, [BinaryStream state — skipped]
///
/// `zone_entity_type` is the version-dependent InteractiveZone index (13
/// before 14.5.0, 14 after) — only zone entities get the radius / control
/// point / team state scans.
pub(super) fn parse_entity_create(
    payload: &[u8],
    time: f32,
    zone_entity_type: i16,
) -> Option<ParsedCreate> {
    // Fixed header is 4+2+4+4+12+12 = 38 bytes; trailing state is variable.
    if payload.len() < 38 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let entity_type = i16::from_le_bytes(payload[4..6].try_into().ok()?);
    let vehicle_id = i32::from_le_bytes(payload[6..10].try_into().ok()?);
    // space_id at [10..14] — unused here.
    let x = f32::from_le_bytes(payload[14..18].try_into().ok()?);
    let y = f32::from_le_bytes(payload[18..22].try_into().ok()?);
    let z = f32::from_le_bytes(payload[22..26].try_into().ok()?);
    let is_zone = entity_type == zone_entity_type && payload.len() > 38;
    let radius = if is_zone {
        scan_state_for_radius(&payload[38..])
    } else {
        None
    };
    let control_point_index = if is_zone {
        scan_state_for_control_point(&payload[38..])
    } else {
        None
    };
    let initial_team = if is_zone {
        scan_state_for_team(&payload[38..])
    } else {
        None
    };
    Some(ParsedCreate {
        entity_id,
        entity_type,
        vehicle_id,
        x,
        y,
        z,
        creation_time: time,
        radius,
        control_point_index,
        initial_team,
    })
}

/// Parse an EntityDestroy (0x06) payload. WoWS layout: a single i32 entity id
/// identifying the entity being removed (ship sunk, plane/torpedo expired).
pub(super) fn parse_entity_destroy(payload: &[u8]) -> Option<i32> {
    if payload.len() < 4 {
        return None;
    }
    Some(i32::from_le_bytes(payload[0..4].try_into().ok()?))
}

/// Parse EntityProperty (0x07) payload. Each packet can carry one or more
/// property changes. Layout per change:
///   u32 property_index
///   u32 value_size (1, 2, or 4)
///   [value_size bytes] the value (u8, u16, or u32)
/// All changes in the payload apply to the same entity_id (the first u32).
pub(super) fn parse_property(payload: &[u8], time: f32) -> Vec<PropertyChange> {
    let mut out = Vec::new();
    if payload.len() < 12 {
        return out;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().unwrap_or([0; 4]));
    let mut off = 4usize;
    while off + 8 <= payload.len() {
        let Some(property_index) = read_bytes(payload, off).map(u32::from_le_bytes) else {
            break;
        };
        let Some(value_size) = read_bytes(payload, off + 4)
            .map(u32::from_le_bytes)
            .map(|v| v as usize)
        else {
            break;
        };
        if value_size > 8 || off + 8 + value_size > payload.len() {
            break;
        }
        let value_bytes = &payload[off + 8..off + 8 + value_size];
        let value = match value_size {
            1 => value_bytes[0] as u32,
            2 => read_bytes(value_bytes, 0)
                .map(u16::from_le_bytes)
                .unwrap_or(0) as u32,
            4 => read_bytes(value_bytes, 0)
                .map(u32::from_le_bytes)
                .unwrap_or(0),
            _ => 0,
        };
        out.push(PropertyChange {
            time,
            entity_id,
            property_index,
            value,
            size: value_size as u8,
        });
        off += 8 + value_size;
    }
    out
}

/// Parse a PlayerPosition (0x2b legacy / 0x2c current / 0x2a aircraft) payload.
/// Layout (Monstrofil `replays_unpack` `PlayerPosition.py`, 32 bytes):
///   i32 entity_id, i32 linked_entity_id,
///   f32×3 position, f32 yaw, f32 pitch, f32 roll
/// This stream carries the recorder's own ship (which never emits 0x0a),
/// aircraft/squadrons, plus the camera/avatar entity; the frontend keeps only
/// type-2 ships and type-4 aircraft.
pub(super) fn parse_player_position(payload: &[u8], time: f32) -> Option<PositionSample> {
    if payload.len() < 32 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let linked_id = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    let x = f32::from_le_bytes(payload[8..12].try_into().ok()?);
    let y = f32::from_le_bytes(payload[12..16].try_into().ok()?);
    let z = f32::from_le_bytes(payload[16..20].try_into().ok()?);
    let yaw = f32::from_le_bytes(payload[20..24].try_into().ok()?);
    Some(PositionSample {
        time,
        entity_id,
        vehicle_id: linked_id,
        x,
        y,
        z,
        yaw,
    })
}

/// Parse a Position (0x0a) payload. Layout for current WoWS builds (45 bytes):
///   i32 entity_id, i32 vehicle_id, f32×3 position,
///   u32 seq/flags, u32 padding, u32 flags2,
///   f32 yaw, [u32 padding×2, i8 is_error]
pub(super) fn parse_position(payload: &[u8], time: f32) -> Option<PositionSample> {
    if payload.len() < 36 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let vehicle_id = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    let x = f32::from_le_bytes(payload[8..12].try_into().ok()?);
    let y = f32::from_le_bytes(payload[12..16].try_into().ok()?);
    let z = f32::from_le_bytes(payload[16..20].try_into().ok()?);
    let yaw = f32::from_le_bytes(payload[32..36].try_into().ok()?);
    Some(PositionSample {
        time,
        entity_id,
        vehicle_id,
        x,
        y,
        z,
        yaw,
    })
}
