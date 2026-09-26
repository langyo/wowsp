use super::*;

/// Decode a hex string into bytes — sample payloads below are pasted
/// straight from the capture dumps they document.
fn hex_literal(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
        .collect()
}

/// PlayerPosition (0x2c) parses the 32-byte layout into a position sample.
#[test]
fn parses_player_position_payload() {
    let mut payload = Vec::new();
    payload.extend_from_slice(&962015i32.to_le_bytes());
    payload.extend_from_slice(&962014i32.to_le_bytes());
    payload.extend_from_slice(&(-516.4f32).to_le_bytes());
    payload.extend_from_slice(&0.0f32.to_le_bytes());
    payload.extend_from_slice(&500.0f32.to_le_bytes());
    payload.extend_from_slice(&3.5f32.to_le_bytes());
    payload.extend_from_slice(&0.0f32.to_le_bytes());
    payload.extend_from_slice(&0.0f32.to_le_bytes());
    let s = parse_player_position(&payload, 1.5).expect("must parse");
    assert_eq!(s.entity_id, 962015);
    assert_eq!(s.vehicle_id, 962014);
    assert!((s.x - -516.4).abs() < 0.01);
    assert!((s.z - 500.0).abs() < 0.01);
    assert!((s.yaw - 3.5).abs() < 0.01);
    assert!((s.time - 1.5).abs() < 0.001);
    // Short payload is rejected.
    assert!(parse_player_position(&payload[..20], 0.0).is_none());
}

/// The state-stream scanner finds a roster shipId at an arbitrary offset
/// and ignores everything else.
#[test]
fn scans_state_for_ship_id() {
    let mut state = vec![0u8; 200];
    state[168..172].copy_from_slice(&3540989648u32.to_le_bytes());
    let candidates: std::collections::HashSet<u32> =
        [3550394352, 3540989648, 4181702352].into_iter().collect();
    assert_eq!(
        scan_state_for_ship_id(&state, &candidates),
        Some(3540989648)
    );
    // Unknown ids are not reported.
    let other: std::collections::HashSet<u32> = [111, 222].into_iter().collect();
    assert_eq!(scan_state_for_ship_id(&state, &other), None);
    // Empty candidate set never matches.
    assert_eq!(
        scan_state_for_ship_id(&state, &std::collections::HashSet::new()),
        None
    );
}

/// The 12.6.0 layout boundary + InteractiveZone index flip at 14.5.0:
/// `parse_version_key` drives both (legacy packet ids / zone type 13 vs 14).
#[test]
fn version_key_boundaries() {
    assert_eq!(parse_version_key("12,5,0,12345"), Some((12, 5, 0)));
    assert_eq!(parse_version_key("0,11,4,1"), Some((0, 11, 4)));
    assert_eq!(parse_version_key("15,0,0,11791718"), Some((15, 0, 0)));
    // Malformed versions yield None (callers fall back to modern layouts).
    assert_eq!(parse_version_key(""), None);
    assert_eq!(parse_version_key("garbage"), None);
    assert_eq!(parse_version_key("12"), None);
}

/// Legacy packet ids remap onto their modern equivalents so the frame loop
/// keeps matching the modern constants.
#[test]
fn remaps_legacy_packet_ids() {
    assert_eq!(remap_legacy_packet_id(0x22), PACKET_NESTED_PROPERTY);
    assert_eq!(remap_legacy_packet_id(0x24), PACKET_CAMERA);
    assert_eq!(remap_legacy_packet_id(0x27), PACKET_MAP);
    assert_eq!(remap_legacy_packet_id(0x29), PACKET_POSITION_AUX);
    assert_eq!(remap_legacy_packet_id(0x2b), PACKET_PLAYER_POSITION);
    assert_eq!(remap_legacy_packet_id(0x2e), PACKET_CAMERA_FREELOOK);
    assert_eq!(remap_legacy_packet_id(0x2f), PACKET_SET_WEAPON_LOCK);
    assert_eq!(remap_legacy_packet_id(0x30), PACKET_SUB_CONTROLLER);
    assert_eq!(remap_legacy_packet_id(0x31), PACKET_CRUISE_STATE);
    assert_eq!(remap_legacy_packet_id(0x32), PACKET_SHOT_TRACKING);
    // Stable ids pass through untouched.
    assert_eq!(remap_legacy_packet_id(PACKET_POSITION), PACKET_POSITION);
    assert_eq!(remap_legacy_packet_id(PACKET_VERSION), PACKET_VERSION);
    assert_eq!(
        remap_legacy_packet_id(PACKET_BASE_PLAYER_CREATE_STUB),
        PACKET_BASE_PLAYER_CREATE_STUB
    );
}

/// End-to-end against a real replay when `WOWSP_TEST_REPLAY` is set. Asserts
/// positions AND EntityCreate kinds are extracted and look sane, and that
/// the version-selected method table yields battle-effect events.
#[test]
fn decodes_real_replay_positions_and_entities() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut cur = 8;
    let mut client_version: Option<String> = None;
    for i in 0..block_count {
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
        cur += 4;
        if i == 0 {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes[cur..cur + bl]) {
                client_version = json
                    .get("clientVersionFromExe")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
            }
        }
        cur += bl;
    }
    let decoded = decode_replay(
        &bytes[cur..],
        &std::collections::HashSet::new(),
        client_version.as_deref(),
    )
    .expect("decode must succeed");
    let total_samples: usize = decoded.positions.values().map(|v| v.len()).sum();
    assert!(total_samples > 0, "must extract position samples");
    // Ships are entity_type 2; a real match has several.
    let ships = decoded
        .kinds
        .iter()
        .filter(|(_, k)| k.entity_type == 2)
        .count();
    // A real match almost always has at least one ship destroyed (someone
    // dies). We don't hard-assert destroys > 0 (a stomps game can have
    // none), but log it so the EntityDestroy path is observable in CI.
    eprintln!(
        "[m3+entity+destroy] version={:?} {} position samples across {} entities; {} EntityCreates ({} type=2 ships); {} destroyed; {} shell launches; {} torpedoes; {} explosions; {} minimap squadron adds; {} wards; {} shot kills",
        client_version,
        total_samples,
        decoded.positions.len(),
        decoded.kinds.len(),
        ships,
        decoded.destroys.len(),
        decoded.shell_launches.len(),
        decoded.torpedoes.len(),
        decoded.explosions.len(),
        decoded.minimap_squadron_adds.len(),
        decoded.wards.len(),
        decoded.shot_kills.len(),
    );
    assert!(ships >= 2, "a real match has at least 2 ships");
    // Artillery fire is universal in a real match — a zero count means the
    // method table misresolved (the bug this layout fixes). Pre-0.11.6
    // replays predate the shipped tables, where decoding is disabled.
    let in_table_range = client_version
        .as_deref()
        .and_then(parse_version_key)
        .map(|k| k >= (0, 11, 6))
        .unwrap_or(true);
    if in_table_range {
        assert!(
            !decoded.shell_launches.is_empty(),
            "receiveArtilleryShots must decode on a real replay"
        );
    }
    // Every shell must have finite coordinates and a positive flight time.
    for s in &decoded.shell_launches {
        assert!(s.x.is_finite() && s.z.is_finite(), "non-finite shot origin");
        assert!(
            s.target_x.is_finite() && s.target_z.is_finite(),
            "non-finite shot target"
        );
        assert!(
            s.server_time_left > 0.0 && s.server_time_left < 150.0,
            "implausible flight time (raw units; seconds = value / 2.75)"
        );
    }
    // Wards must carry plausible patrol rings when present.
    for w in &decoded.wards {
        assert!(w.x.is_finite() && w.z.is_finite(), "non-finite ward centre");
        assert!(
            (10.0..=2_000.0).contains(&w.radius),
            "implausible ward radius {}",
            w.radius
        );
    }
    // Every entity kind must have finite initial coords.
    for k in decoded.kinds.values() {
        assert!(
            k.initial_x.is_finite() && k.initial_z.is_finite(),
            "non-finite spawn"
        );
    }
}

/// Diagnostic: walk all frames and report per-type counts, max payload
/// size, and whether the walk terminated early (absurd size guard).
/// Run with `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[test]
fn dump_packet_stats() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut cur = 8;
    for _ in 0..block_count {
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
        cur += 4 + bl;
    }
    let decrypted = decrypt_stream(&bytes[cur..]).expect("decrypt");
    let inflated = inflate_zlib(&decrypted).expect("inflate");
    let mut c = 0usize;
    let mut counts: std::collections::BTreeMap<u32, (usize, usize)> =
        std::collections::BTreeMap::new();
    let mut early_break = None;
    while c + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[c..c + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[c + 4..c + 8].try_into().unwrap());
        let payload_end = c + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            early_break = Some((c, size, ptype, inflated.len()));
            break;
        }
        let e = counts.entry(ptype).or_default();
        e.0 += 1;
        e.1 = e.1.max(size);
        c = payload_end;
    }
    eprintln!("inflated {} bytes, walked to {}", inflated.len(), c);
    for (t, (n, max)) in &counts {
        eprintln!("  type 0x{t:02x}: {n} packets, max size {max}");
    }
    if let Some((at, size, ptype, total)) = early_break {
        eprintln!("  EARLY BREAK at {at}/{total}: declared size {size}, type 0x{ptype:02x}");
    }
}

/// Diagnostic: for each ship EntityCreate, list every roster shipId found
/// in its state stream (offset -> id) to see whether 15.7 state streams
/// still carry the correct unique shipId when the descriptor shares one.
/// Run with `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[test]
fn dump_state_ship_ids() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut cur = 8;
    let mut candidates: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for _ in 0..block_count {
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
        cur += 4;
        let block = &bytes[cur..cur + bl];
        cur += bl;
        if candidates.is_empty() {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(block) {
                if let Some(arr) = json.get("vehicles").and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(id) = v.get("shipId").and_then(|x| x.as_u64()) {
                            candidates.insert(id as u32);
                        }
                    }
                }
            }
        }
    }
    eprintln!("roster shipIds: {:?}", candidates);
    let decrypted = decrypt_stream(&bytes[cur..]).expect("decrypt");
    let inflated = inflate_zlib(&decrypted).expect("inflate");
    let mut c = 0usize;
    while c + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[c..c + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[c + 4..c + 8].try_into().unwrap());
        let payload_end = c + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        if ptype == PACKET_ENTITY_CREATE {
            let payload = &inflated[c + 12..payload_end];
            if payload.len() >= 38 {
                let eid = i32::from_le_bytes(payload[0..4].try_into().unwrap());
                let etype = i16::from_le_bytes(payload[4..6].try_into().unwrap());
                if etype == 2 {
                    let state = &payload[38..];
                    let mut hits = Vec::new();
                    if state.len() >= 4 {
                        for off in 0..=state.len() - 4 {
                            let val = u32::from_le_bytes(state[off..off + 4].try_into().unwrap());
                            if candidates.contains(&val) {
                                hits.push((off, val));
                            }
                        }
                    }
                    eprintln!("eid {eid}: state len {} hits {:?}", state.len(), hits);
                }
            }
        }
        c = payload_end;
    }
}

/// Diagnostic: dump Position packet payload sizes from a real replay to
/// determine if newer game builds include extra health/speed fields.
/// Run with `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[test]
fn dump_position_packet_sizes() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut cur = 8;
    for _ in 0..block_count {
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
        cur += 4 + bl;
    }
    let decrypted = decrypt_stream(&bytes[cur..]).expect("decrypt");
    let inflated = inflate_zlib(&decrypted).expect("inflate");
    let mut sizes: std::collections::BTreeMap<usize, usize> = std::collections::BTreeMap::new();
    let mut pos = 0usize;
    while pos + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[pos..pos + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[pos + 4..pos + 8].try_into().unwrap());
        let payload_end = pos + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        if ptype == 0x0a {
            *sizes.entry(size).or_default() += 1;
        }
        pos = payload_end;
    }
    eprintln!("Position packet size distribution:");
    for (size, count) in &sizes {
        eprintln!("  {size:>4} bytes: {count:>6} packets");
    }
    // Also dump a sample of the raw Position payload to see if we can spot
    // health data beyond the known fields.
    pos = 0;
    let mut samples = 0u32;
    while pos + 12 <= inflated.len() && samples < 10 {
        let size = u32::from_le_bytes(inflated[pos..pos + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[pos + 4..pos + 8].try_into().unwrap());
        let payload_end = pos + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        if ptype == 0x0a && size >= 45 {
            let payload = &inflated[pos + 12..payload_end];
            let eid = i32::from_le_bytes(payload[0..4].try_into().unwrap());
            // Read first 12 f32 values from the payload as potential
            // entity_id, vehicle_id, x, y, z, yaw, vx?, vy?, vz?, hp?...
            let mut floats = Vec::with_capacity(32);
            let flt_count = (size.min(128) - 8) / 4; // skip entity/vehicle IDs
            for f in 0..flt_count {
                let off = 8 + f * 4;
                if off + 4 <= size {
                    let v = f32::from_le_bytes(payload[off..off + 4].try_into().unwrap());
                    floats.push(v);
                }
            }
            eprintln!("Entity {eid}: size={size} floats={:?}", floats);
            samples += 1;
        }
        pos = payload_end;
    }
}

/// receiveArtilleryShots: a 1-pack, 2-shot salvo decodes muzzle + aim
/// points and flight times per the SHOTS_PACK/SHOT alias layouts.
#[test]
fn decodes_artillery_shots_pack() {
    let mut args = Vec::new();
    args.push(1u8); // 1 pack
    args.extend_from_slice(&4158636752u32.to_le_bytes()); // paramsID
    args.extend_from_slice(&631854i32.to_le_bytes()); // ownerID
    args.extend_from_slice(&7i32.to_le_bytes()); // salvoID
    args.push(2u8); // 2 shots
    for (i, dist) in [100.0f32, 200.0f32].into_iter().enumerate() {
        args.extend_from_slice(&(10.0 + i as f32).to_le_bytes()); // pos.x
        args.extend_from_slice(&5.0f32.to_le_bytes()); // pos.y
        args.extend_from_slice(&20.0f32.to_le_bytes()); // pos.z
        args.extend_from_slice(&0.5f32.to_le_bytes()); // pitch
        args.extend_from_slice(&780.0f32.to_le_bytes()); // speed
        args.extend_from_slice(&dist.to_le_bytes()); // tarPos.x
        args.extend_from_slice(&0.0f32.to_le_bytes()); // tarPos.y
        args.extend_from_slice(&25.0f32.to_le_bytes()); // tarPos.z
        args.extend_from_slice(&(i as u16).to_le_bytes()); // shotID
        args.extend_from_slice(&(3 + i as u16).to_le_bytes()); // gunBarrelID
        args.extend_from_slice(&(4.0 + i as f32).to_le_bytes()); // serverTimeLeft
        args.extend_from_slice(&15.0f32.to_le_bytes()); // shooterHeight
        args.extend_from_slice(&(dist - 10.0).to_le_bytes()); // hitDistance
    }
    let shots = decode_artillery_shots(12.5, &args);
    assert_eq!(shots.len(), 2);
    assert_eq!(shots[0].owner_id, 631854);
    assert_eq!(shots[0].params_id, 4158636752);
    assert_eq!(shots[0].salvo_id, 7);
    assert_eq!(shots[0].shot_id, 0);
    assert!((shots[0].x - 10.0).abs() < 1e-4);
    assert!((shots[0].target_x - 100.0).abs() < 1e-4);
    assert!((shots[0].server_time_left - 4.0).abs() < 1e-4);
    assert!((shots[0].speed - 780.0).abs() < 1e-4);
    assert_eq!(shots[1].shot_id, 1);
    assert!((shots[1].target_x - 200.0).abs() < 1e-4);
}

/// receiveTorpedoes: nullable maneuver/acoustic dumps consume exactly their
/// flag byte when absent (0), letting multi-torpedo packs walk correctly.
#[test]
fn decodes_torpedo_salvo_with_nullable_dumps() {
    let mut args = Vec::new();
    args.push(1u8); // 1 pack
    args.extend_from_slice(&4283843536u32.to_le_bytes()); // paramsID
    args.extend_from_slice(&631866i32.to_le_bytes()); // ownerID
    args.extend_from_slice(&3i32.to_le_bytes()); // salvoID
    args.extend_from_slice(&0u32.to_le_bytes()); // skinID
    args.push(3u8); // 3 torpedoes
    for i in 0..3u16 {
        args.extend_from_slice(&(-254.0 + i as f32).to_le_bytes()); // pos.x
        args.extend_from_slice(&0.0f32.to_le_bytes()); // pos.y
        args.extend_from_slice(&(-28.0f32).to_le_bytes()); // pos.z
        args.extend_from_slice(&0.7f32.to_le_bytes()); // dir.x
        args.extend_from_slice(&0.0f32.to_le_bytes()); // dir.y
        args.extend_from_slice(&5.4f32.to_le_bytes()); // dir.z
        args.extend_from_slice(&i.to_le_bytes()); // shotID
        args.push(1u8); // armed
        args.push(0u8); // maneuverDump = None
        args.push(0u8); // acousticDump = None
    }
    let torps = decode_torpedo_salvos(146.0, &args);
    assert_eq!(torps.len(), 3, "all three fish decode");
    assert_eq!(torps[0].owner_id, 631866);
    assert_eq!(torps[2].shot_id, 2);
    assert!(torps[1].armed);
    assert!((torps[0].dir_z - 5.4).abs() < 1e-4);
    // A present (flag=1) maneuver dump of 44 bytes (5×f32 + 2×VECTOR3)
    // is skipped whole.
    let mut with_dump = args.clone();
    // pack header = 1 count + 4+4+4+4 fixed + 1 count = 18 bytes.
    let t0 = 18;
    with_dump[t0 + 27] = 1; // maneuverDump present
    let mut body = vec![0u8; 44];
    body[..4].copy_from_slice(&1.5f32.to_le_bytes());
    with_dump.splice(t0 + 28..t0 + 28, body);
    let torps2 = decode_torpedo_salvos(146.0, &with_dump);
    assert_eq!(torps2.len(), 3, "dump bytes consumed without desync");
    assert!((torps2[1].x - -253.0).abs() < 1e-4);

    // Unexpected flag (not 0/1): the reference rewinds one byte, so the
    // dict body STARTS at the flag — total consumption is exactly 44.
    let mut odd = args.clone();
    odd[t0 + 27] = 0x7f;
    let mut body2 = vec![0u8; 43];
    body2[..4].copy_from_slice(&2.5f32.to_le_bytes());
    odd.splice(t0 + 28..t0 + 28, body2);
    let torps3 = decode_torpedo_salvos(146.0, &odd);
    assert_eq!(torps3.len(), 3, "recovery path rewinds to the flag byte");
    assert_eq!(torps3[2].shot_id, 2);
}

/// Minimap squadron add/update/remove: the composite plane id's low 32
/// bits carry the owning carrier's vehicle id.
#[test]
fn decodes_minimap_squadron_stream() {
    // owner 631874 at bits 32.., index 1, purpose 4 — from a real 15.0 CV.
    let plane_id: u64 = 631874 | (1 << 32) | (4 << 35);
    let mut add = Vec::new();
    add.extend_from_slice(&plane_id.to_le_bytes());
    add.push(0i8 as u8); // teamId
    add.extend_from_slice(&4287037136u32.to_le_bytes()); // paramsId
    add.extend_from_slice(&(-58.4f32).to_le_bytes()); // pos.x
    add.extend_from_slice(&321.8f32.to_le_bytes()); // pos.y (== world z)
    add.push(0u8);
    let a = decode_minimap_squadron_add(93.0, &add).expect("must parse");
    assert_eq!(a.plane_id, 141734552642);
    assert_eq!(a.owner_id, 631874);
    assert_eq!(a.team_id, 0);
    assert_eq!(a.params_id, 4287037136);
    assert!((a.x - -58.4).abs() < 1e-3);
    assert!((a.z - 321.8).abs() < 1e-3);

    let mut mv = Vec::new();
    mv.extend_from_slice(&plane_id.to_le_bytes());
    mv.extend_from_slice(&(-83.5f32).to_le_bytes());
    mv.extend_from_slice(&339.2f32.to_le_bytes());
    let m = decode_minimap_squadron_move(97.0, &mv).expect("must parse");
    assert_eq!(m.plane_id, plane_id);
    assert!((m.z - 339.2).abs() < 1e-3);
    // Short payloads are rejected.
    assert!(decode_minimap_squadron_add(0.0, &add[..20]).is_none());
    assert!(decode_minimap_squadron_move(0.0, &mv[..12]).is_none());
    assert!(args_is_plane_id(&mv[..8]));
    assert!(!args_is_plane_id(&mv));
}

/// receive_wardAdded: both arg layouts (37 bytes pre-13.2.0, +wardType
/// after) decode the patrol centre, radius and owner.
#[test]
fn decodes_ward_added_both_layouts() {
    let mut args = Vec::new();
    args.extend_from_slice(&(631874u64 | (5 << 32)).to_le_bytes()); // squadronId
    args.extend_from_slice(&(-320.5f32).to_le_bytes()); // pos.x
    args.extend_from_slice(&25.0f32.to_le_bytes()); // pos.y
    args.extend_from_slice(&480.25f32.to_le_bytes()); // pos.z
    args.extend_from_slice(&3.0f32.to_le_bytes()); // time
    args.extend_from_slice(&420.0f32.to_le_bytes()); // radius
    args.push(1u8); // teamId
    args.extend_from_slice(&631874u64.to_le_bytes()); // ownerId
    // Pre-13.2.0: exactly 37 bytes.
    let w = decode_ward_added(60.0, &args, false).expect("must parse");
    assert_eq!(w.squadron_id, 631874 | (5 << 32));
    assert_eq!(w.owner_id, 631874);
    assert_eq!(w.team_id, 1);
    assert!((w.x + 320.5).abs() < 1e-3);
    assert!((w.z - 480.25).abs() < 1e-3);
    assert!((w.radius - 420.0).abs() < 1e-3);
    assert_eq!(w.ward_type, 0);
    // 13.2.0+: trailing wardType byte.
    let mut with_type = args.clone();
    with_type.push(2u8);
    let w2 = decode_ward_added(61.0, &with_type, true).expect("must parse");
    assert_eq!(w2.ward_type, 2);
    assert!((w2.radius - 420.0).abs() < 1e-3);
    // Short payloads are rejected under both layouts.
    assert!(decode_ward_added(0.0, &args[..30], false).is_none());
    assert!(decode_ward_added(0.0, &with_type[..37], true).is_none());
}

/// receiveShotKills: packs flatten into per-kill events; the nullable
/// ballistics dict (12.7.0+) is skipped whole so multi-kill packs stay in
/// sync.
#[test]
fn decodes_shot_kills_packs() {
    let mut args = Vec::new();
    args.push(1u8); // 1 pack
    args.extend_from_slice(&631854i32.to_le_bytes()); // ownerID
    args.push(3u8); // hitType
    args.push(2u8); // 2 kills
    for (i, shot) in [41u16, 42].into_iter().enumerate() {
        args.extend_from_slice(&(300.0 + i as f32).to_le_bytes()); // pos.x
        args.extend_from_slice(&1.0f32.to_le_bytes()); // pos.y
        args.extend_from_slice(&(-275.0f32).to_le_bytes()); // pos.z
        args.extend_from_slice(&shot.to_le_bytes()); // shotID
        args.push(1u8); // ballistics present
        args.extend_from_slice(&[0u8; 29]); // TERMINAL_BALLISTICS_INFO body
    }
    let kills = decode_shot_kills(101.5, &args, true);
    assert_eq!(kills.len(), 2);
    assert_eq!(kills[0].owner_id, 631854);
    assert_eq!(kills[0].hit_type, 3);
    assert_eq!(kills[0].shot_id, 41);
    assert!((kills[1].x - 301.0).abs() < 1e-3);
    // Pre-12.7.0: no ballistics bytes at all.
    let mut legacy = Vec::new();
    legacy.push(1u8);
    legacy.extend_from_slice(&631854i32.to_le_bytes());
    legacy.push(0u8);
    legacy.push(1u8);
    legacy.extend_from_slice(&10.0f32.to_le_bytes());
    legacy.extend_from_slice(&0.0f32.to_le_bytes());
    legacy.extend_from_slice(&20.0f32.to_le_bytes());
    legacy.extend_from_slice(&7u16.to_le_bytes());
    let legacy_kills = decode_shot_kills(50.0, &legacy, false);
    assert_eq!(legacy_kills.len(), 1);
    assert_eq!(legacy_kills[0].shot_id, 7);
    assert!((legacy_kills[0].z - 20.0).abs() < 1e-3);
}

/// onChatMessage: `i32 playerId, STRING namespace, STRING message, STRING
/// unk`. The samples are byte-for-byte the two 15.8.0 captures the decoder
/// was written against (ASCII and CJK bodies, empty `unk`).
#[test]
fn decodes_chat_message_wire_shape() {
    // 537555508 (roster "Nutthakun_Jiamsri") "battle_team" "SRY" ""
    let ascii = hex_literal(&"34720a200b626174746c655f7465616d03535259 00".replace(' ', ""));
    let msg = decode_chat_message(103.6, &ascii).expect("must parse");
    assert_eq!(msg.player_id, 537555508);
    assert_eq!(msg.namespace, "battle_team");
    assert_eq!(msg.message, "SRY");
    assert!((msg.time - 103.6).abs() < 1e-3);
    // 537685747 (roster "wuheshido") "battle_team" "输了" "" — the u8
    // length prefix counts bytes, so the CJK body is 6 bytes, not 2 chars.
    let cjk = hex_literal(&"f36e0c200b626174746c655f7465616d06e8be93e4ba86 00".replace(' ', ""));
    let msg = decode_chat_message(942.4, &cjk).expect("must parse");
    assert_eq!(msg.player_id, 537685747);
    assert_eq!(msg.message, "输了");
    // Truncated payloads are skipped, never fatal.
    assert!(decode_chat_message(0.0, &[]).is_none());
    assert!(decode_chat_message(0.0, &ascii[..ascii.len() - 1]).is_none());
    assert!(decode_chat_message(0.0, &ascii[..8]).is_none());
    // A declared length running past the payload aborts the parse.
    let mut overrun = ascii.clone();
    overrun[4] = 0xff;
    assert!(decode_chat_message(0.0, &overrun).is_none());
}

/// Wire strings escape past 255 bytes via `0xff, u16 len, dummy byte`.
#[test]
fn chat_message_supports_long_escape() {
    let body = vec![b'x'; 300];
    let mut args = Vec::new();
    args.extend_from_slice(&7i32.to_le_bytes()); // playerId
    args.push(0xff);
    args.extend_from_slice(&(body.len() as u16).to_le_bytes());
    args.push(0u8); // dummy byte
    args.extend_from_slice(&body);
    args.push(3u8);
    args.extend_from_slice(b"abc");
    args.push(0u8);
    let msg = decode_chat_message(1.0, &args).expect("must parse");
    assert_eq!(msg.namespace.len(), 300);
    assert_eq!(msg.message, "abc");
}

/// onAchievementEarned: `i32 playerId, u32 achievementId` — sample bytes
/// from the 15.8.0 capture, whose id matches the battle-results
/// achievements list of the same replay.
#[test]
fn decodes_achievement_event() {
    let args = hex_literal(&"99ea0a20b0e3f2fe");
    let a = decode_achievement(237.3, &args).expect("must parse");
    assert_eq!(a.player_id, 537586329);
    assert_eq!(a.achievement_id, 4277330864);
    assert!((a.time - 237.3).abs() < 1e-3);
    assert!(decode_achievement(0.0, &args[..7]).is_none());
    assert!(decode_achievement(0.0, &[]).is_none());
}

/// receiveTorpedoDirection: fixed 39-byte layout decodes owner/shot/pos.
#[test]
fn decodes_torpedo_direction() {
    let mut args = Vec::new();
    args.extend_from_slice(&631866i32.to_le_bytes());
    args.extend_from_slice(&11u16.to_le_bytes());
    args.extend_from_slice(&(-100.5f32).to_le_bytes());
    args.extend_from_slice(&(-2.0f32).to_le_bytes());
    args.extend_from_slice(&300.0f32.to_le_bytes());
    for v in [0.8f32, 6.0, 1.1, 0.5, 0.2] {
        args.extend_from_slice(&v.to_le_bytes());
    }
    args.push(1u8);
    let steers = decode_torpedo_directions(200.0, &args);
    assert_eq!(steers.len(), 1);
    assert_eq!(steers[0].owner_id, 631866);
    assert_eq!(steers[0].shot_id, 11);
    assert!((steers[0].target_yaw - 0.8).abs() < 1e-4);
    // Truncated payloads (below the decoded head fields) yield nothing.
    assert!(decode_torpedo_directions(0.0, &args[..15]).is_empty());
}

/// receiveDamageStat: the exact wire shape a 15.8 capture sends — BLOB
/// length prefix + pickle-proto-2 dict built as EMPTY_DICT, then per pair
/// TUPLE2(weapon, category) + EMPTY_LIST + MARK + [BININT1 count,
/// BINFLOAT total] + APPENDS + SETITEM. Byte-for-byte the first packet of
/// the reference Lexington replay ({(28, 0): [4, 2640.0]} at t=100.75).
#[test]
fn decodes_damage_stat_pickle() {
    let pickle: Vec<u8> = vec![
        0x80, 0x02, // PROTO 2
        0x7d, // EMPTY_DICT
        0x71, 0x01, // BINPUT 1
        0x4b, 0x1c, // BININT1 28 (RocketHe)
        0x4b, 0x00, // BININT1 0 (enemy)
        0x86, // TUPLE2
        0x71, 0x02, // BINPUT 2
        0x5d, // EMPTY_LIST
        0x71, 0x03, // BINPUT 3
        0x28, // MARK
        0x4b, 0x04, // BININT1 4 (count)
        0x47, 0x40, 0xa4, 0xa0, 0x00, 0x00, 0x00, 0x00, 0x00, // BINFLOAT 2640.0 (BE)
        0x65, // APPENDS
        0x73, // SETITEM
        0x2e, // STOP
    ];
    let mut args = vec![pickle.len() as u8];
    args.extend_from_slice(&pickle);
    let out = decode_damage_stat(100.75, &args);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].weapon, 28);
    assert_eq!(out[0].category, 0);
    assert_eq!(out[0].count, 4);
    assert!((out[0].total - 2640.0).abs() < 1e-9);
    assert!((out[0].time - 100.75).abs() < 1e-6);
}

/// receiveDamageStat variants: multiple pairs per dict (SETITEMS batch
/// form), integer totals (spotting damage arrives as int), BININT/BININT2
/// encodings, and tolerance — truncated blob or non-dict payload yields
/// an empty vec instead of panicking.
#[test]
fn decodes_damage_stat_variants() {
    // {(1, 0): [9, 4321.5], (17, 2): [3, 0]} via the SETITEMS batch form:
    // EMPTY_DICT, MARK, then alternating key/value pairs, SETITEMS.
    let mut pickle = vec![0x80u8, 0x02, 0x7d, 0x71, 0x01, 0x28];
    // Key 1: (weapon 1 via BININT, category 0 via BININT1).
    pickle.extend_from_slice(&[0x4a]);
    pickle.extend_from_slice(&1i32.to_le_bytes());
    pickle.extend_from_slice(&[0x4b, 0x00, 0x86]);
    // Value 1: EMPTY_LIST + MARK + count 9 (BININT2) + total 4321.5.
    pickle.extend_from_slice(&[0x5d, 0x28]);
    pickle.extend_from_slice(&[0x4d]);
    pickle.extend_from_slice(&9u16.to_le_bytes());
    pickle.extend_from_slice(&[0x47]);
    pickle.extend_from_slice(&4321.5f64.to_be_bytes());
    pickle.extend_from_slice(&[0x65]);
    // Key 2: (weapon 17 via BININT1, category 2 via BININT1).
    pickle.extend_from_slice(&[0x4b, 0x11, 0x4b, 0x02, 0x86]);
    // Value 2: total as integer 0 (LONG1) — the spotting-damage shape.
    pickle.extend_from_slice(&[0x5d, 0x28, 0x4b, 0x03, 0x8a, 0x01, 0x00, 0x65]);
    pickle.extend_from_slice(&[0x75, 0x2e]); // SETITEMS + STOP
    let mut args = vec![pickle.len() as u8];
    args.extend_from_slice(&pickle);
    let out = decode_damage_stat(500.0, &args);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].weapon, 1);
    assert_eq!(out[0].count, 9);
    assert!((out[0].total - 4321.5).abs() < 1e-9);
    assert_eq!(out[1].weapon, 17);
    assert_eq!(out[1].category, 2);
    assert_eq!(out[1].total, 0.0);
    // Tolerance: bad length prefix / non-dict / empty args → empty.
    assert!(decode_damage_stat(0.0, &[64, 0x80]).is_empty());
    assert!(decode_damage_stat(0.0, &[2, 0x4b, 0x01]).is_empty());
    assert!(decode_damage_stat(0.0, &[]).is_empty());
}

/// The radius scan takes the FIRST integral f32 in 20..700. The state
/// stream of a domination zone packs three integral floats at stable
/// offsets on current clients (verified across 30 replays / 6 maps on
/// 15.8): per-zone radius first (~18), a mode-wide 40 constant (~98),
/// a flag 1 (~102) — the old last-candidate rule grabbed the 40 and
/// drew every ring ~2.5× too small. Bytes below mirror that shape.
#[test]
fn scans_state_for_zone_radius() {
    let mut state = vec![0u8; 106];
    state[18..22].copy_from_slice(&120.0f32.to_le_bytes());
    state[98..102].copy_from_slice(&40.0f32.to_le_bytes());
    state[102..106].copy_from_slice(&1.0f32.to_le_bytes());
    let r = scan_state_for_radius(&state).expect("radius present");
    assert!((r - 120.0).abs() < 0.01, "first candidate wins, got {r}");
    // A different zone on the same map carries its own radius.
    state[18..22].copy_from_slice(&100.0f32.to_le_bytes());
    assert!((scan_state_for_radius(&state).unwrap() - 100.0).abs() < 0.01);
    // Out-of-range leading values are skipped; only the flag 1.0 left
    // (below the 20 m floor) yields no radius at all.
    state[18..22].copy_from_slice(&0.5f32.to_le_bytes());
    state[98..102].copy_from_slice(&[0; 4]);
    assert!(scan_state_for_radius(&state).is_none());
}
