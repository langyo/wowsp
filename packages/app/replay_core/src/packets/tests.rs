// ── corpus gating ───────────────────────────────────────────────────────────
//
// Integration tests that need a real `.wowsreplay` read `WOWSP_TEST_REPLAY`.
// The remaining corpus-bound tests are diagnostics over a live capture (frame
// dumps, per-capture method-table coverage, vision/consumable/engine-stream
// checks): with the variable unset they print
// `skipped: set WOWSP_TEST_REPLAY ...` and return — never silently. Set
// `WOWSP_TEST_REQUIRE_CORPUS=1` to turn every skip into a failure (use it in
// the corpus/nightly job so a missing fixture is loud instead of green).
//
// The behavioural end-to-end test (`decodes_real_replay_positions_and_entities`)
// no longer needs a corpus: it decodes the synthetic container built further
// down and asserts its KNOWN content, switching to the real file only when the
// variable is set.

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

/// Build one wire frame `[u32 size][u32 type][f32 time][payload]`.
fn wire_frame(ptype: u32, time: f32, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(12 + payload.len());
    f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    f.extend_from_slice(&ptype.to_le_bytes());
    f.extend_from_slice(&time.to_le_bytes());
    f.extend_from_slice(payload);
    f
}

/// A 32-byte PlayerPosition-layout payload, as the Lesta 26.10 0x2e stream
/// carries it (entity 7, linked ship 8, at (-100, 0, 250) heading 1.25).
fn lesta_self_position_payload() -> Vec<u8> {
    let mut p = Vec::with_capacity(32);
    p.extend_from_slice(&7i32.to_le_bytes());
    p.extend_from_slice(&8i32.to_le_bytes());
    p.extend_from_slice(&(-100.0f32).to_le_bytes());
    p.extend_from_slice(&0.0f32.to_le_bytes());
    p.extend_from_slice(&250.0f32.to_le_bytes());
    p.extend_from_slice(&1.25f32.to_le_bytes());
    p.extend_from_slice(&0.0f32.to_le_bytes());
    p.extend_from_slice(&0.0f32.to_le_bytes());
    p
}

fn profile_for(lesta: bool) -> LayoutProfile {
    LayoutProfile {
        methods: None,
        zone_entity_type: 14,
        ward_has_type: true,
        shotkill_has_ballistics: true,
        arena_state_method: None,
        e11: None,
        builds: false,
        lesta,
    }
}

/// Report a corpus-gated test as skipped (or fail when the corpus is required).
fn corpus_skip(test_name: &str) {
    eprintln!("skipped: set WOWSP_TEST_REPLAY (corpus-bound test: {test_name})");
    if std::env::var_os("WOWSP_TEST_REQUIRE_CORPUS").is_some() {
        panic!(
            "WOWSP_TEST_REQUIRE_CORPUS is set but WOWSP_TEST_REPLAY is unset: \
             cannot run corpus-bound test {test_name}"
        );
    }
}

// ── synthetic replay fixture (corpus-free end-to-end coverage) ─────────────
//
// A complete container: the real framing (magic + block count + descriptor
// JSON block + encrypted packet stream) around a frame stream the decoder's
// wire path reads byte-for-byte. Content is deliberately tiny and KNOWN so
// every assertion below is against a value this file chose, not against a
// capture whose shape can drift.

/// 15.8.0 is the version the shipped method/CreateState pins target, so the
/// decode path resolves every version gate exactly as it does for the
/// reference capture.
const SYNTH_CLIENT_VERSION: &str = "15,8,0,13187581";
const SYNTH_SHIP_A: i32 = 1001;
const SYNTH_SHIP_B: i32 = 1002;
const SYNTH_AVATAR: i32 = 900;
const SYNTH_SHIP_ID_A: u32 = 3_542_005_040;
const SYNTH_SHIP_ID_B: u32 = 3_542_005_041;
const SYNTH_MAX_HP_A: f32 = 74_200.0;
const SYNTH_MAX_HP_B: f32 = 55_000.0;
/// Property index carrying the int HP series in the fixture (the decoder
/// detects the index from the series, it is not hardcoded there).
const SYNTH_HP_PROPERTY: u32 = 20;

/// Two teams plus the same-config mirror pair (A and an enemy share
/// `SYNTH_SHIP_ID_A`) — the live shape that used to break the shipId join.
fn synthetic_descriptor() -> serde_json::Value {
    serde_json::json!({
        "clientVersionFromExe": SYNTH_CLIENT_VERSION,
        "matchGroup": "synthetic",
        "mapDisplayName": "Synthetic Basin",
        "vehicles": [
            {"id": 1, "shipId": SYNTH_SHIP_ID_A, "relation": 0, "name": "synthetic_self"},
            {"id": 2, "shipId": SYNTH_SHIP_ID_B, "relation": 1, "name": "synthetic_ally"},
            {"id": 3, "shipId": SYNTH_SHIP_ID_A, "relation": 2, "name": "synthetic_mirror"},
        ],
    })
}

/// One EntityCreate state stream: `u32 length` + the BigWorld property blob.
/// `scan_state_for_ship_id` finds the roster shipId at offset 40, and
/// `scan_state_for_max_health` finds the duplicated full-HP pair (current ==
/// max at spawn) at the WG-shaped offsets 73/88.
fn synthetic_create_state(ship_id: u32, max_hp: f32) -> Vec<u8> {
    let mut state = vec![0u8; 200];
    state[40..44].copy_from_slice(&ship_id.to_le_bytes());
    state[73..77].copy_from_slice(&max_hp.to_le_bytes());
    state[88..92].copy_from_slice(&max_hp.to_le_bytes());
    let mut out = Vec::with_capacity(4 + state.len());
    out.extend_from_slice(&(state.len() as u32).to_le_bytes());
    out.extend_from_slice(&state);
    out
}

/// EntityCreate (0x05) for a type-2 ship: the 38-byte fixed header the
/// parser reads (eid, type, header vehicleId, spaceId, x/y/z, direction)
/// followed by the create state.
fn synthetic_ship_create(
    entity_id: i32,
    x: f32,
    z: f32,
    ship_id: u32,
    max_hp: f32,
    yaw: f32,
) -> Vec<u8> {
    let mut p = Vec::with_capacity(38 + 204);
    p.extend_from_slice(&entity_id.to_le_bytes());
    p.extend_from_slice(&ENTITY_TYPE_VEHICLE.to_le_bytes());
    p.extend_from_slice(&0i32.to_le_bytes()); // header vehicleId (per-version constant)
    p.extend_from_slice(&0i32.to_le_bytes()); // spaceId
    p.extend_from_slice(&x.to_le_bytes());
    p.extend_from_slice(&0f32.to_le_bytes());
    p.extend_from_slice(&z.to_le_bytes());
    p.extend_from_slice(&yaw.to_le_bytes());
    p.extend_from_slice(&[0u8; 8]); // pitch + roll
    p.extend_from_slice(&synthetic_create_state(ship_id, max_hp));
    p
}

/// CellPlayerCreate (0x01) for the recorder's avatar: same 38-byte header,
/// with the occupied vehicle in the vehicleId slot.
fn synthetic_avatar_create() -> Vec<u8> {
    let mut p = vec![0u8; 38];
    p[0..4].copy_from_slice(&SYNTH_AVATAR.to_le_bytes());
    p[8..12].copy_from_slice(&SYNTH_SHIP_A.to_le_bytes());
    p[12..16].copy_from_slice(&(-100.0f32).to_le_bytes());
    p[20..24].copy_from_slice(&250.0f32.to_le_bytes());
    p
}

/// Position (0x0a) payload: 36-byte fixed layout; only eid/x/z/yaw carry
/// meaning for this fixture.
fn synthetic_position_payload(entity_id: i32, x: f32, z: f32, yaw: f32) -> Vec<u8> {
    let mut p = vec![0u8; 36];
    p[0..4].copy_from_slice(&entity_id.to_le_bytes());
    p[8..12].copy_from_slice(&x.to_le_bytes());
    p[16..20].copy_from_slice(&z.to_le_bytes());
    p[32..36].copy_from_slice(&yaw.to_le_bytes());
    p
}

/// PlayerPosition (0x2c) payload: the 32-byte self-stream layout.
fn synthetic_self_position_payload(
    entity_id: i32,
    linked_vehicle: i32,
    x: f32,
    z: f32,
    yaw: f32,
) -> Vec<u8> {
    let mut p = vec![0u8; 32];
    p[0..4].copy_from_slice(&entity_id.to_le_bytes());
    p[4..8].copy_from_slice(&linked_vehicle.to_le_bytes());
    p[8..12].copy_from_slice(&x.to_le_bytes());
    p[16..20].copy_from_slice(&z.to_le_bytes());
    p[20..24].copy_from_slice(&yaw.to_le_bytes());
    p
}

/// EntityProperty (0x07) payload: one size-4 int change for `entity_id`.
fn synthetic_property_payload(entity_id: i32, index: u32, value: u32) -> Vec<u8> {
    let mut p = Vec::new();
    p.extend_from_slice(&entity_id.to_le_bytes());
    p.extend_from_slice(&index.to_le_bytes());
    p.extend_from_slice(&4u32.to_le_bytes());
    p.extend_from_slice(&value.to_le_bytes());
    p
}

/// The frame stream: two ships (create + 3 positions each), the avatar with
/// its self-stream link, HP changes for both ships (B ends on an explicit
/// EntityDestroy instead of an HP-0 inference), and the Version packet.
fn synthetic_frames() -> Vec<u8> {
    let mut frames = Vec::new();
    frames.extend(wire_frame(
        PACKET_ENTITY_CREATE,
        0.5,
        &synthetic_ship_create(
            SYNTH_SHIP_A,
            -100.0,
            250.0,
            SYNTH_SHIP_ID_A,
            SYNTH_MAX_HP_A,
            1.25,
        ),
    ));
    frames.extend(wire_frame(
        PACKET_ENTITY_CREATE,
        0.5,
        &synthetic_ship_create(
            SYNTH_SHIP_B,
            -50.0,
            250.0,
            SYNTH_SHIP_ID_B,
            SYNTH_MAX_HP_B,
            0.0,
        ),
    ));
    frames.extend(wire_frame(
        PACKET_CELL_PLAYER_CREATE,
        0.6,
        &synthetic_avatar_create(),
    ));
    frames.extend(wire_frame(
        PACKET_PLAYER_POSITION,
        1.0,
        &synthetic_self_position_payload(SYNTH_AVATAR, SYNTH_SHIP_A, -100.0, 250.0, 1.25),
    ));
    for (time, x) in [(1.0f32, -100.0f32), (2.0, -95.0), (3.0, -90.0)] {
        frames.extend(wire_frame(
            PACKET_POSITION,
            time,
            &synthetic_position_payload(SYNTH_SHIP_A, x, 250.0, 1.25),
        ));
        frames.extend(wire_frame(
            PACKET_POSITION,
            time,
            &synthetic_position_payload(SYNTH_SHIP_B, x + 50.0, 250.0, 0.0),
        ));
    }
    // A's HP falls to exactly 0 at 40 s (the sink-inference path); B keeps a
    // positive series and is destroyed explicitly at 60 s.
    for (time, hp) in [
        (10.0f32, 74_200u32),
        (20.0, 50_000),
        (30.0, 20_000),
        (40.0, 0),
    ] {
        frames.extend(wire_frame(
            PACKET_ENTITY_PROPERTY,
            time,
            &synthetic_property_payload(SYNTH_SHIP_A, SYNTH_HP_PROPERTY, hp),
        ));
    }
    for (time, hp) in [(10.0f32, 55_000u32), (20.0, 40_000), (30.0, 25_000)] {
        frames.extend(wire_frame(
            PACKET_ENTITY_PROPERTY,
            time,
            &synthetic_property_payload(SYNTH_SHIP_B, SYNTH_HP_PROPERTY, hp),
        ));
    }
    frames.extend(wire_frame(
        PACKET_ENTITY_DESTROY,
        60.0,
        &SYNTH_SHIP_B.to_le_bytes(),
    ));
    let mut version = (SYNTH_CLIENT_VERSION.len() as u32).to_le_bytes().to_vec();
    version.extend_from_slice(SYNTH_CLIENT_VERSION.as_bytes());
    frames.extend(wire_frame(PACKET_VERSION, 0.0, &version));
    frames
}

/// Encrypt+compress the frame stream exactly like the game writes it:
/// zlib-deflate, then the inverse Blowfish/XOR chain with the 8-byte marker
/// prefix (see `encrypt_stream_for_test`).
fn synthetic_packet_stream() -> Vec<u8> {
    use std::io::Write as _;
    let mut plain = Vec::new();
    let mut encoder = flate2::write::ZlibEncoder::new(&mut plain, flate2::Compression::default());
    encoder
        .write_all(&synthetic_frames())
        .expect("deflate synthetic frames");
    // finish() writes the zlib trailer; dropping the encoder alone would
    // leave a truncated stream the strict inflater rejects.
    encoder.finish().expect("finish synthetic zlib stream");
    encrypt_stream_for_test(&plain)
}

/// The complete container the app reads: magic + block count (1) + descriptor
/// JSON block + encrypted packet stream.
fn synthetic_container() -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&crate::meta::REPLAY_MAGIC);
    out.extend_from_slice(&1u32.to_le_bytes());
    let descriptor = synthetic_descriptor().to_string().into_bytes();
    out.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
    out.extend_from_slice(&descriptor);
    out.extend_from_slice(&synthetic_packet_stream());
    out
}

fn synthetic_ship_id_candidates() -> std::collections::HashSet<u32> {
    [SYNTH_SHIP_ID_A, SYNTH_SHIP_ID_B].into_iter().collect()
}

/// Decode the synthetic container through the SAME two entry points the app
/// uses: the container header path (`meta`) then the packet decoder.
fn decode_synthetic_replay() -> DecodedReplay {
    let bytes = synthetic_container();
    let descriptor = crate::meta::extract_descriptor_json(&bytes).expect("descriptor block");
    let raw: serde_json::Value =
        serde_json::from_str(&descriptor).expect("descriptor block must be JSON");
    assert_eq!(
        raw,
        synthetic_descriptor(),
        "header path must return the descriptor verbatim"
    );
    let version = raw
        .get("clientVersionFromExe")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let stream =
        crate::meta::packet_stream_after_blocks(&bytes).expect("packet stream after blocks");
    decode_replay(
        stream,
        &synthetic_ship_id_candidates(),
        version.as_deref(),
        false,
    )
    .expect("synthetic replay must decode")
}

/// Lesta 26.10's 0x2e self-position stream decodes into position samples
/// only for Lesta-family containers — a WG replay must keep ignoring the
/// id (it sits in WG's undefined tail gap), and a non-32-byte payload is
/// never a position (the shape gate inside the parser).
#[test]
fn lesta_tail_position_stream_is_family_and_shape_gated() {
    let empty: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let frames = wire_frame(0x2e, 12.5, &lesta_self_position_payload());
    let lesta = super::frames::walk_frames(&frames, &empty, false, &profile_for(true), None);
    let samples = lesta
        .positions
        .get(&7)
        .expect("the 0x2e sample must decode on a Lesta container");
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].entity_id, 7);
    assert_eq!(samples[0].vehicle_id, 8);
    assert!((samples[0].x - -100.0).abs() < 0.01);
    assert!((samples[0].z - 250.0).abs() < 0.01);
    assert!((samples[0].yaw - 1.25).abs() < 0.001);

    // Same wire bytes, WG family: the id stays in the ignored tail gap.
    let wg = super::frames::walk_frames(&frames, &empty, false, &profile_for(false), None);
    assert!(
        wg.positions.is_empty(),
        "WG containers must not decode 0x2e"
    );

    // Lesta family but a payload that is not the 32-byte layout: skipped.
    let short = wire_frame(0x2e, 13.0, &[1, 2, 3, 4, 5, 6, 7, 8]);
    let malformed = super::frames::walk_frames(&short, &empty, false, &profile_for(true), None);
    assert!(
        malformed.positions.is_empty(),
        "shape gate must reject non-positions"
    );
}

/// A 60-byte camera payload in the Lesta 26.10 0x26 layout: the WG camera
/// prefix (identity quaternion, position, fov) followed by 28 bytes of
/// auxiliary floats the decoder ignores.
fn lesta_camera_payload() -> Vec<u8> {
    let mut p = vec![0u8; 60];
    p[12..16].copy_from_slice(&1.0f32.to_le_bytes()); // quat.w
    p[16..20].copy_from_slice(&(-100.5f32).to_le_bytes()); // pos.x
    p[20..24].copy_from_slice(&7.0f32.to_le_bytes()); // pos.y
    p[24..28].copy_from_slice(&250.5f32.to_le_bytes()); // pos.z
    p[28..32].copy_from_slice(&0.8727f32.to_le_bytes()); // fov
    p
}

/// Lesta 26.10's 0x26 camera stream decodes into camera samples only for
/// Lesta-family containers — WG uses the id for the tiny
/// BasePlayerCreateStub, which the parser's ≥56-byte gate also rejects.
#[test]
fn lesta_camera_stream_is_family_and_shape_gated() {
    let empty: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let frames = wire_frame(0x26, 42.0, &lesta_camera_payload());
    let lesta = super::frames::walk_frames(&frames, &empty, false, &profile_for(true), None);
    let [sample] = lesta.camera.as_slice() else {
        panic!("the 0x26 camera sample must decode on a Lesta container");
    };
    assert!((sample.time - 42.0).abs() < 0.001);
    assert!((sample.rot_w - 1.0).abs() < 0.001);
    assert!((sample.x - -100.5).abs() < 0.01);
    assert!((sample.y - 7.0).abs() < 0.01);
    assert!((sample.z - 250.5).abs() < 0.01);
    assert!((sample.fov - 0.8727).abs() < 0.001);

    // Same wire bytes, WG family: 0x26 is the BasePlayerCreateStub slot and
    // must never feed the camera timeline.
    let wg = super::frames::walk_frames(&frames, &empty, false, &profile_for(false), None);
    assert!(wg.camera.is_empty(), "WG containers must not decode 0x26");

    // Lesta family but a payload below the 56-byte camera layout: skipped.
    let short = wire_frame(0x26, 43.0, &lesta_camera_payload()[..40]);
    let malformed = super::frames::walk_frames(&short, &empty, false, &profile_for(true), None);
    assert!(
        malformed.camera.is_empty(),
        "shape gate must reject non-camera payloads"
    );
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

/// The create-state max-health scan takes the largest integral f32 in the
/// full-HP band that occurs at least TWICE (the current/max health property
/// pair, equal at spawn), ignoring one-off straddle artifacts, sub-band
/// floats and the per-version damage-cap constant above the band.
#[test]
fn scans_state_for_max_health_by_duplicated_value() {
    let mk = |health: f32, hp_off_a: usize, hp_off_b: usize, artifact: Option<(f32, usize)>| {
        let mut state = vec![0u8; 200];
        state[4..8].copy_from_slice(&123.45f32.to_le_bytes()); // sub-band noise
        state[40..44].copy_from_slice(&200_000.0f32.to_le_bytes()); // damage-cap constant
        for off in [hp_off_a, hp_off_b] {
            state[off..off + 4].copy_from_slice(&health.to_le_bytes());
        }
        if let Some((v, off)) = artifact {
            state[off..off + 4].copy_from_slice(&v.to_le_bytes());
        }
        state
    };
    // WG-shaped placement (73/88) and Lesta-shaped (117/132), each with a
    // one-off straddle artifact that used to win a naive max-scan.
    assert_eq!(
        scan_state_for_max_health(&mk(31_200.0, 73, 88, Some((131_196.0, 10)))),
        Some(31_200)
    );
    assert_eq!(
        scan_state_for_max_health(&mk(42_500.0, 117, 132, Some((10_816.0, 80)))),
        Some(42_500)
    );
    // An in-band value seen only once never qualifies.
    let mut single = vec![0u8; 200];
    single[50..54].copy_from_slice(&52_400.0f32.to_le_bytes());
    assert_eq!(scan_state_for_max_health(&single), None);
    // Nothing in band -> None; short states never panic.
    assert_eq!(scan_state_for_max_health(&[0u8; 64]), None);
    assert_eq!(scan_state_for_max_health(&[0u8; 3]), None);
}

/// End-to-end coverage of the container → packet → assembly path.
///
/// Default (no corpus): decode the synthetic container and assert its KNOWN
/// content exactly — position timelines, EntityCreate metadata (entity type /
/// roster shipId / create-state max health), the avatar's self-stream
/// recorder-vehicle join, EntityDestroy, and the HP-detect → sink-inference →
/// trajectory-grouping pipeline.
///
/// With `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`: run the historical
/// real-capture assertions instead (sane positions, version-selected method
/// table yielding battle effects, plausible wards/shells).
#[test]
fn decodes_real_replay_positions_and_entities() {
    let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
        let decoded = decode_synthetic_replay();
        // ── position timelines ─────────────────────────────────────────────
        let total_samples: usize = decoded.positions.values().map(|v| v.len()).sum();
        assert_eq!(
            total_samples, 7,
            "3 + 3 ship samples + 1 self-stream sample"
        );
        assert_eq!(decoded.positions.len(), 3, "two ships + the avatar");
        assert_eq!(decoded.positions[&SYNTH_SHIP_A].len(), 3);
        assert_eq!(decoded.positions[&SYNTH_SHIP_B].len(), 3);
        assert_eq!(decoded.positions[&SYNTH_SHIP_A][2].x, -90.0);
        assert_eq!(decoded.positions[&SYNTH_SHIP_B][2].x, -40.0);
        let self_track = &decoded.positions[&SYNTH_AVATAR];
        assert_eq!(self_track.len(), 1);
        assert_eq!(
            self_track[0].vehicle_id, SYNTH_SHIP_A,
            "self stream links the recorder's vehicle"
        );
        assert_eq!(decoded.recorder_vehicle, Some(SYNTH_SHIP_A));
        assert_eq!(decoded.recorder_ship, None, "both ships stream 0x0a");
        // ── EntityCreate metadata: kind, roster join, create-state max HP ──
        let ship_a = decoded.kinds.get(&SYNTH_SHIP_A).expect("ship A created");
        assert_eq!(ship_a.entity_type, ENTITY_TYPE_VEHICLE);
        assert_eq!((ship_a.initial_x, ship_a.initial_z), (-100.0, 250.0));
        assert_eq!(ship_a.ship_id, Some(i64::from(SYNTH_SHIP_ID_A)));
        assert_eq!(ship_a.max_health, Some(SYNTH_MAX_HP_A as u32));
        let ship_b = decoded.kinds.get(&SYNTH_SHIP_B).expect("ship B created");
        assert_eq!(ship_b.ship_id, Some(i64::from(SYNTH_SHIP_ID_B)));
        assert_eq!(ship_b.max_health, Some(SYNTH_MAX_HP_B as u32));
        assert_eq!(
            decoded.kinds.get(&SYNTH_AVATAR).map(|k| k.entity_type),
            Some(ENTITY_TYPE_AVATAR)
        );
        // ── destroy + property streams ─────────────────────────────────────
        assert_eq!(decoded.destroys.get(&SYNTH_SHIP_B).copied(), Some(60.0));
        assert!(!decoded.destroys.contains_key(&SYNTH_SHIP_A));
        assert_eq!(decoded.properties.get(&SYNTH_SHIP_A).map(Vec::len), Some(4));
        assert_eq!(decoded.version.as_deref(), Some(SYNTH_CLIENT_VERSION));
        // ── assembly: HP detection, sink inference, grouping ───────────────
        let stream = crate::assemble::group_by_entity(decoded);
        assert_eq!(stream.recorder_vehicle_id, Some(SYNTH_SHIP_A));
        let trajectory = |eid: i32| {
            stream
                .trajectories
                .iter()
                .find(|t| t.entity_id == eid)
                .unwrap_or_else(|| panic!("trajectory {eid}"))
        };
        let a = trajectory(SYNTH_SHIP_A);
        assert_eq!(a.samples.len(), 3);
        assert_eq!(a.hp_samples.len(), 4);
        assert_eq!(a.hp_samples.last().map(|s| s.value), Some(0));
        assert_eq!(a.death_time, Some(40.0), "HP 0 at 40 s infers the sink");
        let b = trajectory(SYNTH_SHIP_B);
        assert_eq!(b.hp_samples.len(), 3);
        assert_eq!(b.death_time, Some(60.0), "explicit EntityDestroy wins");
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let descriptor = crate::meta::extract_descriptor_json(&bytes).expect("descriptor block");
    let client_version = serde_json::from_str::<serde_json::Value>(&descriptor)
        .ok()
        .and_then(|raw| {
            raw.get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        });
    let packet_stream = crate::meta::packet_stream_after_blocks(&bytes).expect("packet stream");
    let decoded = decode_replay(
        packet_stream,
        &std::collections::HashSet::new(),
        client_version.as_deref(),
        false,
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
    // Global-weather timeline (cyclone/storm) — printed for the empirical
    // replay check; counts vary per match so nothing is asserted.
    for w in &decoded.weather_transitions {
        eprintln!(
            "[weather] transition t={}: {} -> {} over {}..{}",
            w.time, w.from_param, w.to_param, w.start_time, w.end_time
        );
    }
    for n in &decoded.weather_notifications {
        eprintln!(
            "[weather] notification t={}: {} at {}",
            n.time, n.param, n.at_time
        );
    }
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
        corpus_skip("dump_packet_stats");
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
        corpus_skip("dump_state_ship_ids");
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
        corpus_skip("dump_position_packet_sizes");
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

/// The control-point scan reads the 0-based point index off the
/// `controlPoint` component tail (`<type> 00 <index>`) WITHOUT hard-coding
/// the ControlPointType byte. The first two full states are pasted straight
/// from a 15.8 58_RidgeNew domination_2point capture — the mode packs type
/// 5 where the classic layouts pack 1, so the old type-anchored signature
/// matched NOTHING and every 2-cap point vanished from the map (each side's
/// pre-owned home point is the one that goes fully stream-silent). The
/// third state swaps in the verbatim 47_Sleeping_Giant domination_4point
/// tail (type 1, index 2) to pin the classic shape.
#[test]
fn scans_state_for_control_point() {
    // 58_RidgeNew eid 20040 — enemy home point, index 0 (A).
    let state = hex_literal(
        "690000000c0000010902000301040000000500003443060000000007000000\
         0000000000082346363546303242342e34413136444541442e373831463741\
         39322e364535343136373809000a01b0c7e5ffffffffff050000010000000\
         0ff00000101000034430000803f0b0100",
    );
    assert_eq!(scan_state_for_control_point(&state), Some(0));

    // 58_RidgeNew eid 20039 — our pre-owned home point, index 1 (B).
    let state = hex_literal(
        "690000000c0001010902000301040000000500003443060000000007000000\
         0000000000082342363742424532432e34333845324231462e363743353932\
         38322e413731464543433309000a01b0c7e5ffffffffff050001010000000\
         0ff00000101000034430000803f0b0100",
    );
    assert_eq!(scan_state_for_control_point(&state), Some(1));

    // 47_Sleeping_Giant domination_4point — ControlPointType 1, index 2
    // (leading bytes mirror the RidgeNew capture; the tail from the buoy
    // constant on is verbatim).
    let state = hex_literal(
        "690000000c0000010902000301040000000500003443060000000007000000\
         0000000000082346363546303242342e34413136444541442e373831463741\
         39322e364535343136373809000a01b0c7e5ffffffffff010002010000000\
         0ff00000101000070420000803f0b0100",
    );
    assert_eq!(scan_state_for_control_point(&state), Some(2));

    // A strike/event zone: componentsState stays empty (`0a 00`) and its
    // separate constant (b0 c7 8d ff) must not match — pasted from the
    // same capture's eid 270980 tail.
    let strike = hex_literal("323032332e353909014544594145445941b0c78dff0a00000b0100");
    assert_eq!(scan_state_for_control_point(&strike), None);

    // A buoy-constant lookalike without the `00` separator yields nothing.
    let mut bogus = vec![0u8; 24];
    bogus[..10].copy_from_slice(&[0x0a, 0x01, 0xb0, 0xc7, 0xe5, 0xff, 0xff, 0xff, 0xff, 0xff]);
    bogus[10] = 0x01; // ControlPointType slot
    bogus[11] = 0x07; // non-zero separator byte
    bogus[12] = 0x01;
    assert_eq!(scan_state_for_control_point(&bogus), None);
    // An oversized index byte is rejected the same way.
    bogus[11] = 0x00;
    bogus[12] = 0x40;
    assert_eq!(scan_state_for_control_point(&bogus), None);
    // Truncated tail (no room for `<type> 00 <index>`) yields nothing.
    let mut short = bogus;
    short.truncate(12);
    assert_eq!(scan_state_for_control_point(&short), None);
}

// ── Global weather (NestedPropertyUpdate 0x23) ─────────────────────────────

/// The weather-id shape gate accepts every known GlobalWeather id (all 35
/// entries of a 15.8 dump share it; nine samples here span the 0xFD/0xFE/
/// 0xFF top bytes) and rejects ship ids / off-by-one neighbours.
#[test]
fn global_weather_param_shape_gate() {
    for id in [
        4293183408u32, // PCOW001_Sunny
        4288989104,    // PCOW005_Evening
        4283746224,    // PCOW010_Rain_Logic (cyclone)
        4282697648,    // PCOW011_Night
        4286891952,    // PCOW007_Dull
        4287940528,    // PCOW006_Storm_Logic
        4284794800,    // PCOW009_Snowstorm_Logic
        4269066160,    // PCOW024_Rain_Logic_12km
        4268017584,    // PCOW025_Storm_Logic_12km
    ] {
        assert!(is_global_weather_param(id), "id {id} must pass the gate");
    }
    // A ship GameParams id and a weather id minus one never share the shape.
    assert!(!is_global_weather_param(3660461904));
    assert!(!is_global_weather_param(4283746223));
}

/// "item" SetKey blobs (16 bytes) decode as transitions. Every sample is a
/// byte-for-byte capture from a 15.8 cyclone replay: the battle-start
/// same-weather window, the Evening → Rain_Logic (cyclone) blend, the
/// mid-cyclone re-assertion, the lift blend and the post-battle tail.
#[test]
fn decodes_weather_transition_blobs() {
    let item = hex_literal("bcb48001b0c7a4ffb0c7a4ff0000a401");
    match parse_weather_nested(&item) {
        Some(WeatherSignal::Transition {
            from_param,
            to_param,
            start_time,
            end_time,
        }) => {
            assert_eq!(from_param, 4288989104); // PCOW005_Evening
            assert_eq!(to_param, 4288989104);
            assert!((start_time - 0.0).abs() < 1e-3);
            assert!((end_time - 420.0).abs() < 1e-3);
        },
        other => panic!("expected a transition, got {other:?}"),
    }
    let blend = hex_literal("bcb48001b0c7a4ffb0c754ffa5011d02");
    match parse_weather_nested(&blend) {
        Some(WeatherSignal::Transition {
            from_param,
            to_param,
            start_time,
            end_time,
        }) => {
            assert_eq!(from_param, 4288989104); // PCOW005_Evening
            assert_eq!(to_param, 4283746224); // PCOW010_Rain_Logic
            assert!((start_time - 421.0).abs() < 1e-3);
            assert!((end_time - 541.0).abs() < 1e-3);
        },
        other => panic!("expected a transition, got {other:?}"),
    }
    // The trailing window: Evening→Evening over 972..6972 — the server
    // schedules the post-battle weather past the 1200 s match cap, so the
    // scan horizon is 7200 s, not 3600.
    let tail = hex_literal("bcb48001b0c7a4ffb0c7a4ffcc033c1b");
    match parse_weather_nested(&tail) {
        Some(WeatherSignal::Transition {
            from_param,
            to_param,
            start_time,
            end_time,
        }) => {
            assert_eq!(from_param, 4288989104);
            assert_eq!(to_param, 4288989104);
            assert!((start_time - 972.0).abs() < 1e-3);
            assert!((end_time - 6972.0).abs() < 1e-3);
        },
        other => panic!("expected a transition, got {other:?}"),
    }
    // Mid-cyclone re-assertion (Rain→Rain 542..849) and the lift blend
    // (Rain→Evening 851..971) from the same capture — the re-assertion is
    // what the frontend must treat as "no change" while the cyclone holds.
    let reassert = hex_literal("bcb48001b0c754ffb0c754ff1e025103");
    match parse_weather_nested(&reassert) {
        Some(WeatherSignal::Transition {
            from_param,
            to_param,
            start_time,
            end_time,
        }) => {
            assert_eq!((from_param, to_param), (4283746224, 4283746224));
            assert!((start_time - 542.0).abs() < 1e-3);
            assert!((end_time - 849.0).abs() < 1e-3);
        },
        other => panic!("expected a transition, got {other:?}"),
    }
    let lift = hex_literal("bcb48001b0c754ffb0c7a4ff5303cb03");
    match parse_weather_nested(&lift) {
        Some(WeatherSignal::Transition {
            from_param,
            to_param,
            start_time,
            end_time,
        }) => {
            assert_eq!(from_param, 4283746224); // PCOW010_Rain_Logic
            assert_eq!(to_param, 4288989104); // PCOW005_Evening
            assert!((start_time - 851.0).abs() < 1e-3);
            assert!((end_time - 971.0).abs() < 1e-3);
        },
        other => panic!("expected a transition, got {other:?}"),
    }
}

/// "notification" SetKey blobs (10 bytes) decode as warnings — the two
/// announcements from the same 15.8 replay: the cyclone arrives at 420 s,
/// the lift back to Evening at 849 s.
#[test]
fn decodes_weather_notification_blobs() {
    let rain = hex_literal("bcb50001b0c754ffa401");
    match parse_weather_nested(&rain) {
        Some(WeatherSignal::Notification { param, at_time }) => {
            assert_eq!(param, 4283746224); // PCOW010_Rain_Logic
            assert!((at_time - 420.0).abs() < 1e-3);
        },
        other => panic!("expected a notification, got {other:?}"),
    }
    let evening = hex_literal("bcb50001b0c7a4ff5103");
    match parse_weather_nested(&evening) {
        Some(WeatherSignal::Notification { param, at_time }) => {
            assert_eq!(param, 4288989104); // PCOW005_Evening
            assert!((at_time - 849.0).abs() < 1e-3);
        },
        other => panic!("expected a notification, got {other:?}"),
    }
}

/// Non-weather nested-property blobs never match: short bit-path prefixes
/// from other properties and a 13-byte squadron-position payload all fail
/// the shape gate.
#[test]
fn rejects_non_weather_nested_blobs() {
    assert!(parse_weather_nested(&hex_literal("bcf6902e01")).is_none());
    assert!(parse_weather_nested(&hex_literal("d64001")).is_none());
    // Squadron position: entity/u32-heavy, no weather-shaped id anywhere.
    let squad = hex_literal("c68e6809c40000000049247543");
    assert_eq!(squad.len(), 13);
    assert!(parse_weather_nested(&squad).is_none());
    assert!(parse_weather_nested(&[]).is_none());
}

/// Compress `data` with zlib — the mirror of what the decoder inflates.
fn zlib_compress(data: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    enc.write_all(data).expect("compress");
    enc.finish().expect("finish zlib stream")
}

/// The inflate cap rejects a decompression bomb: ~1 MiB of zeros compresses
/// into a couple of KB, but must not be buffered past the requested cap, and
/// the error names the cap it tripped.
#[test]
fn inflate_cap_rejects_decompression_bomb() {
    let bomb = zlib_compress(&vec![0u8; 1024 * 1024]);
    assert!(
        bomb.len() < 64 * 1024,
        "the bomb's compressed form is tiny (got {} bytes)",
        bomb.len()
    );
    let err = inflate_zlib_with_cap(&bomb, 64 * 1024)
        .expect_err("must trip the cap")
        .to_string();
    assert!(err.contains("65536"), "error names the cap: {err}");
    assert!(
        err.contains("malicious"),
        "error flags corrupt-or-malicious: {err}"
    );
}

/// A legitimate payload under the cap round-trips byte-exact through both the
/// capped primitive and the production wrapper.
#[test]
fn inflate_with_cap_round_trips_small_payload() {
    let payload: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
    let compressed = zlib_compress(&payload);
    let out = inflate_zlib_with_cap(&compressed, MAX_INFLATED_STREAM_BYTES)
        .expect("inflate under the cap");
    assert_eq!(out, payload);
    assert_eq!(inflate_zlib(&compressed).expect("wrapper"), payload);
}

// ── Arena state (onArenaStateReceived) ────────────────────────────────────

/// A value the test pickler below can encode.
trait PickleValue {
    fn push_pickle(&self, out: &mut Vec<u8>);
}
impl PickleValue for i64 {
    fn push_pickle(&self, out: &mut Vec<u8>) {
        out.push(0x8a); // LONG1 — 1-byte length + LE two's-complement payload
        out.push(8);
        out.extend_from_slice(&self.to_le_bytes());
    }
}
impl PickleValue for str {
    fn push_pickle(&self, out: &mut Vec<u8>) {
        let raw = self.as_bytes();
        out.push(0x55); // SHORT_BINSTRING — u8 length + raw bytes
        out.push(raw.len() as u8);
        out.extend_from_slice(raw);
    }
}
impl PickleValue for String {
    fn push_pickle(&self, out: &mut Vec<u8>) {
        self.as_str().push_pickle(out);
    }
}
impl PickleValue for f64 {
    fn push_pickle(&self, out: &mut Vec<u8>) {
        out.push(0x47); // BINFLOAT — 8-byte BIG-endian double
        out.extend_from_slice(&self.to_be_bytes());
    }
}

/// A nickname riding BINSTRING 'T' (u32 length) — the 15.9 arena blob's
/// spelling for one player row (the WW2 operation replay, user report
/// 2026-10-26). The parser historically only knew SHORT_BINSTRING 'U'.
struct BinStringValue<'a>(&'a str);

impl PickleValue for BinStringValue<'_> {
    fn push_pickle(&self, out: &mut Vec<u8>) {
        out.push(0x54); // BINSTRING — u32 LE length + raw bytes
        out.extend_from_slice(&(self.0.len() as u32).to_le_bytes());
        out.extend_from_slice(self.0.as_bytes());
    }
}

/// An embedded `CamouflageInfo` OBJECT: GLOBAL 'c' (module\nname\n) + a
/// two-element args tuple + NEWOBJ. The 15.9 player FixedDict fields one of
/// these per row; the identity join never reads it, but the parser must
/// keep the stack balanced through it.
struct CamouflageObject(i64, i64);

impl PickleValue for CamouflageObject {
    fn push_pickle(&self, out: &mut Vec<u8>) {
        out.push(0x63); // GLOBAL — "module\nname\n"
        out.extend_from_slice(b"CamouflageInfo\nCamouflageInfo\n");
        out.push(0x28); // MARK (args tuple)
        out.push(0x49); // INT (text decimal + newline)
        out.extend_from_slice(self.0.to_string().as_bytes());
        out.push(b'\n');
        out.push(0x4b); // BININT1
        out.push(self.1 as u8);
        out.push(0x74); // TUPLE
        out.push(0x81); // NEWOBJ — pop args + class, push the object
    }
}

/// Hand-assemble one arena player FixedDict the way the client pickles it:
/// a list of `(index, value)` tuples (proto-2: EMPTY_LIST + APPEND over
/// TUPLE pairs, nested under the outer roster list's MARK).
fn pickle_player(fields: &[(&i64, &dyn PickleValue)]) -> Vec<u8> {
    let mut out = vec![0x80, 0x02, 0x5d, 0x71, 0x01, 0x28, 0x5d]; // PROTO, list, BINPUT, MARK, inner list
    for field in fields {
        let (idx, value): (&i64, &dyn PickleValue) = *field;
        out.push(0x28); // MARK (tuple)
        out.push(0x4a); // BININT (i32 LE)
        out.extend_from_slice(&(*idx as i32).to_le_bytes());
        value.push_pickle(&mut out);
        out.push(0x74); // TUPLE
        out.push(0x61); // APPEND (single item into the list below)
    }
    out.push(0x2e); // STOP
    out
}

/// Wrap pickled players into the arena blob's outer list.
fn pickle_list(items: &[&[u8]]) -> Vec<u8> {
    let mut out = vec![0x80, 0x02, 0x5d, 0x71, 0x01, 0x28];
    for it in items {
        out.extend_from_slice(&it[6..it.len() - 1]); // strip PROTO+LIST+BINPUT+MARK head and STOP
    }
    out.push(0x65); // APPENDS
    out.push(0x2e); // STOP
    out
}

/// Build an `onArenaStateReceived` args blob: `i64 arenaId, i8
/// teamBuildTypeId, BLOB×3` (BigWorld wire blobs: u8 length, 0xff-escaped
/// to u16 + one dummy byte).
fn arena_args(players_pickle: &[u8], bots_pickle: &[u8]) -> Vec<u8> {
    fn push_blob(out: &mut Vec<u8>, data: &[u8]) {
        if data.len() < 0xff {
            out.push(data.len() as u8);
        } else {
            out.push(0xff);
            out.extend_from_slice(&(data.len() as u16).to_le_bytes());
            out.push(0); // dummy byte that follows the escaped length
        }
        out.extend_from_slice(data);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&0x1234_5678_9abc_def0i64.to_le_bytes());
    out.push(1); // teamBuildTypeId
    push_blob(&mut out, b""); // preBattlesInfo (empty)
    push_blob(&mut out, players_pickle);
    push_blob(&mut out, bots_pickle);
    out
}

/// `onArenaStateReceived` decode (0.11.11+ player layout): entity id, team,
/// accountDBID, GameParams ship id, max health and name come out of the
/// pair-list FixedDict; bots arrive in the separate blob with their own
/// (0.12.8-shifted) layout.
#[test]
fn decodes_arena_state_players() {
    let (f_avatar, f_id, _f_isbot, f_health, f_name, f_ship, f_params, f_team) =
        (2i64, 11i64, 15i64, 24i64, 25i64, 33i64, 34i64, 36i64);
    let human = pickle_player(&[
        (&f_avatar, &7_710_001i64),
        (&f_id, &601i64),
        (&_f_isbot, &0i64),
        (&f_health, &12_600i64),
        (&f_name, &"langyo".to_string()),
        (&f_ship, &7_561_151i64),
        (&f_params, &4_076_255_216i64),
        (&f_team, &1i64),
    ]);
    // Bot layout (0.12.8+): accountDBID 0, id 10, isBot 13, maxHealth 18,
    // name 19, shipId 23, shipParamsId 24, teamId 26; no avatarId.
    let (b_account, b_id, b_isbot, b_health, b_name, b_ship, b_params, b_team) =
        (0i64, 10i64, 13i64, 18i64, 19i64, 23i64, 24i64, 26i64);
    let bot = pickle_player(&[
        (&b_account, &0i64),
        (&b_id, &5_370_374i64),
        (&b_isbot, &1i64),
        (&b_health, &14_080i64),
        (&b_name, &"provisional_gunner".to_string()),
        (&b_ship, &7_561_099i64),
        (&b_params, &3_542_005_040i64),
        (&b_team, &0i64),
    ]);
    let args = arena_args(&pickle_list(&[&human]), &pickle_list(&[&bot]));
    let players = decode_arena_state(&args, Some((15, 8, 0))).expect("arena state must decode");
    assert_eq!(players.len(), 2);
    let human = players
        .iter()
        .find(|p| p.entity_id == 7_561_151)
        .expect("human entry");
    assert_eq!(human.team_id, 1);
    assert_eq!(human.player_id, 601);
    assert_eq!(human.ship_params_id, 4_076_255_216);
    assert_eq!(human.max_health, 12_600);
    assert_eq!(human.name, "langyo");
    assert_eq!(human.avatar_id, Some(7_710_001));
    assert!(!human.is_bot);
    let bot = players
        .iter()
        .find(|p| p.entity_id == 7_561_099)
        .expect("bot entry");
    assert!(bot.is_bot);
    assert_eq!(bot.team_id, 0);
    assert_eq!(bot.ship_params_id, 3_542_005_040);
    assert_eq!(bot.name, "provisional_gunner");
    assert_eq!(bot.avatar_id, None);
    // Truncated / garbage args never panic, just yield None.
    assert!(decode_arena_state(&args[..9], Some((15, 8, 0))).is_none());
    assert!(decode_arena_state(&[], Some((15, 8, 0))).is_none());
}

/// Review M-1 regression: the arena-state method id must be gated on a
/// PARSED version. Without one, the id would come from the newest table
/// while `ArenaFields::for_version(None, _)` decodes with the OLDEST
/// field layout — a plausible-looking but wrong arena roster. The gate
/// holds for both container families (the field layout has no
/// family-specific default).
#[test]
fn arena_state_method_requires_a_parsed_version() {
    // WG, modern pinned version → the table's id rides through.
    let p = build_layout_profile(Some((15, 8, 0)), false, Some("15,8,0,11791718"));
    assert!(p.arena_state_method.is_some_and(|id| id > 0));
    // WG, NO parsed version → the arena decode is skipped entirely.
    let p = build_layout_profile(None, false, None);
    assert!(
        p.arena_state_method.is_none(),
        "no version → newest method id + oldest fields must not mix"
    );
    // The same gate holds for the Lesta family.
    let p = build_layout_profile(None, true, None);
    assert!(p.arena_state_method.is_none());
    let p = build_layout_profile(Some((0, 12, 0)), true, Some("0,12,0,1"));
    assert!(p.arena_state_method.is_some());
    // Pre-table versions keep the whole events surface disabled.
    let p = build_layout_profile(Some((0, 11, 5)), false, Some("0,11,5,1"));
    assert!(p.methods.is_none());
    assert!(p.arena_state_method.is_none());
}

/// Event/asymmetric modes pickle maxHealth as a scaled FLOAT — it must
/// round to the whole number the ship actually sails with (a plain
/// float→int cast truncates and reads 1 HP short of the true total).
#[test]
fn rounds_fractional_arena_max_health() {
    let (f_avatar, f_id, f_health, f_name, f_ship, f_params, f_team) =
        (2i64, 11i64, 24i64, 25i64, 33i64, 34i64, 36i64);
    let scaled = pickle_player(&[
        (&f_avatar, &7_710_009i64),
        (&f_id, &602i64),
        (&f_health, &46_436.8f64),
        (&f_name, &"scaled_bot".to_string()),
        (&f_ship, &7_561_152i64),
        (&f_params, &4_076_255_217i64),
        (&f_team, &0i64),
    ]);
    // A second entry exists only to clear decode_arena_state's "both teams
    // present" guard (a single-entry blob is treated as a misparse).
    let filler = pickle_player(&[
        (&f_avatar, &7_710_010i64),
        (&f_id, &603i64),
        (&f_health, &40_100i64),
        (&f_name, &"other".to_string()),
        (&f_ship, &7_561_153i64),
        (&f_params, &4_076_255_218i64),
        (&f_team, &1i64),
    ]);
    let args = arena_args(&pickle_list(&[&scaled, &filler]), &pickle_list(&[]));
    let players = decode_arena_state(&args, Some((15, 8, 0))).expect("arena state must decode");
    assert_eq!(players.len(), 2);
    let scaled = players
        .iter()
        .find(|p| p.entity_id == 7_561_152)
        .expect("scaled entry");
    assert_eq!(scaled.max_health, 46_437);
}

/// The 15.9 arena blob shape regression (user report 2026-10-26, the WW2
/// operation replay): one player row fields its nickname through BINSTRING
/// 'T' and carries an embedded `CamouflageInfo` OBJECT pair — a GLOBAL +
/// NEWOBJ value the identity join never reads but the parser must survive.
/// Without the BINSTRING arm the pickle parse aborted, the arena state was
/// lost for EVERY 15.9 battle, and the single-team operation map painted
/// its whole scripted enemy fleet ally-green.
#[test]
fn decodes_arena_state_15_9_blob_with_object_and_binstring_fields() {
    let (f_avatar, f_id, f_object, f_health, f_name, f_ship, f_params, f_team) =
        (2i64, 11i64, 3i64, 24i64, 25i64, 34i64, 35i64, 37i64);
    let human = pickle_player(&[
        (&f_avatar, &7_710_009i64),
        (&f_id, &601i64),
        (&f_object, &CamouflageObject(4_291_424_176, 0)),
        (&f_health, &12_600i64),
        (&f_name, &BinStringValue("langyo")),
        (&f_ship, &7_710_010i64),
        (&f_params, &4_076_255_216i64),
        (&f_team, &0i64),
    ]);
    let filler = pickle_player(&[
        (&f_avatar, &7_710_019i64),
        (&f_id, &603i64),
        (&f_object, &CamouflageObject(4_291_424_176, 0)),
        (&f_health, &40_100i64),
        (&f_name, &BinStringValue("other")),
        (&f_ship, &7_710_020i64),
        (&f_params, &4_076_255_218i64),
        (&f_team, &1i64),
    ]);
    let args = arena_args(&pickle_list(&[&human, &filler]), &pickle_list(&[]));
    let players = decode_arena_state(&args, Some((15, 9, 0))).expect("15.9 arena must decode");
    assert_eq!(players.len(), 2);
    let self_row = players
        .iter()
        .find(|p| p.entity_id == 7_710_010)
        .expect("entity row");
    assert_eq!(self_row.name, "langyo");
    assert_eq!(self_row.team_id, 0);
    assert_eq!(self_row.ship_params_id, 4_076_255_216);
    assert_eq!(self_row.avatar_id, Some(7_710_009));
    let other = players
        .iter()
        .find(|p| p.entity_id == 7_710_020)
        .expect("filler row");
    assert_eq!(other.name, "other");
    assert_eq!(other.team_id, 1);
}

/// Diagnostic: the arena's initial player state vs the descriptor roster.
/// Every arena entry that joins the roster by account id must agree on the
/// team (relation 0/1 → the recorder's side, 2+ → the other), and the
/// recorder's avatar must mark exactly one entry `isSelf` — the regression
/// the spawn-side shipId heuristic got wrong (mirror picks sailed onto the
/// wrong team). Run with `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[test]
fn dump_arena_state() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        corpus_skip("dump_arena_state");
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let mut cur = 8;
    let mut client_version: Option<String> = None;
    let mut roster: std::collections::HashMap<i64, (u32, String)> =
        std::collections::HashMap::new();
    for i in 0..block_count {
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
        cur += 4;
        let block = &bytes[cur..cur + bl];
        cur += bl;
        if i == 0 {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(block) {
                client_version = json
                    .get("clientVersionFromExe")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                if let Some(arr) = json.get("vehicles").and_then(|v| v.as_array()) {
                    for v in arr {
                        roster.insert(
                            v.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
                            (
                                v.get("relation").and_then(|x| x.as_i64()).unwrap_or(0) as u32,
                                v.get("name")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            ),
                        );
                    }
                }
            }
        }
    }
    let decoded = decode_replay(
        &bytes[cur..],
        &std::collections::HashSet::new(),
        client_version.as_deref(),
        false,
    )
    .expect("decode must succeed");
    eprintln!(
        "arena players: {} (client {client_version:?})",
        decoded.arena_players.len()
    );
    if decoded.arena_players.is_empty() {
        eprintln!("(arena state not decoded — version unpinned or shape mismatch)");
        return;
    }
    let self_entries: Vec<_> = decoded.arena_players.iter().filter(|p| p.is_self).collect();
    assert_eq!(self_entries.len(), 1, "exactly one self entry");
    let self_team = self_entries[0].team_id;
    for p in &decoded.arena_players {
        let Some((rel, name)) = roster.get(&p.player_id) else {
            continue;
        };
        let expected_side = if *rel <= 1 { self_team } else { 1 - self_team };
        assert_eq!(
            p.team_id, expected_side,
            "arena team disagrees with roster relation for {name}"
        );
    }
}

fn hex(data: &[u8]) -> String {
    data.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Diagnostic: dump weather-related signals from a real replay — non-ship
/// EntityCreates (BattleLogic / InteractiveZone), nested-property packets on
/// them, 0x2a movement streams for non-ship entities, and float/string
/// patterns inside the largest non-ship create state.
/// Run with `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[test]
fn dump_weather_signals() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        corpus_skip("dump_weather_signals");
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
    let mut creates: std::collections::BTreeMap<i32, (i16, usize, f32)> =
        std::collections::BTreeMap::new();
    let mut nested_counts: std::collections::BTreeMap<i32, usize> =
        std::collections::BTreeMap::new();
    let mut nested_samples: std::collections::BTreeMap<i32, Vec<(f32, Vec<u8>)>> =
        std::collections::BTreeMap::new();
    let mut prop_counts: std::collections::BTreeMap<i32, usize> = std::collections::BTreeMap::new();
    let mut prop_samples: std::collections::BTreeMap<i32, Vec<(f32, Vec<u8>)>> =
        std::collections::BTreeMap::new();
    let mut aux_moves: std::collections::BTreeMap<i32, Vec<(f32, f32, f32, f32)>> =
        std::collections::BTreeMap::new();
    while c + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[c..c + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[c + 4..c + 8].try_into().unwrap());
        let time = f32::from_le_bytes(inflated[c + 8..c + 12].try_into().unwrap());
        let payload_end = c + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        let payload = &inflated[c + 12..payload_end];
        match ptype {
            PACKET_ENTITY_CREATE | PACKET_CELL_PLAYER_CREATE => {
                if payload.len() >= 38 {
                    let eid = i32::from_le_bytes(payload[0..4].try_into().unwrap());
                    let etype = if ptype == PACKET_CELL_PLAYER_CREATE {
                        1
                    } else {
                        i16::from_le_bytes(payload[4..6].try_into().unwrap())
                    };
                    creates.insert(eid, (etype, payload.len(), time));
                }
            },
            PACKET_NESTED_PROPERTY => {
                if payload.len() >= 9 {
                    let eid = i32::from_le_bytes(payload[0..4].try_into().unwrap());
                    let size2 = u32::from_le_bytes(payload[5..9].try_into().unwrap()) as usize;
                    let data = &payload[9..(9 + size2).min(payload.len())];
                    *nested_counts.entry(eid).or_default() += 1;
                    let entry = nested_samples.entry(eid).or_default();
                    if entry.len() < 4000 {
                        entry.push((time, data.to_vec()));
                    }
                }
            },
            PACKET_ENTITY_PROPERTY => {
                if payload.len() >= 4 {
                    let eid = i32::from_le_bytes(payload[0..4].try_into().unwrap());
                    *prop_counts.entry(eid).or_default() += 1;
                    let entry = prop_samples.entry(eid).or_default();
                    if entry.len() < 1300 {
                        entry.push((time, payload[..payload.len().min(40)].to_vec()));
                    }
                }
            },
            PACKET_POSITION_AUX if payload.len() >= 32 => {
                let eid = i32::from_le_bytes(payload[0..4].try_into().unwrap());
                let x = f32::from_le_bytes(payload[8..12].try_into().unwrap());
                let y = f32::from_le_bytes(payload[12..16].try_into().unwrap());
                let z = f32::from_le_bytes(payload[16..20].try_into().unwrap());
                let entry = aux_moves.entry(eid).or_default();
                if entry.len() < 3 || (entry.len() % 200 == 0 && entry.len() < 2000) {
                    entry.push((time, x, y, z));
                }
            },
            _ => {},
        }
        c = payload_end;
    }
    eprintln!("== non-ship entity creates ==");
    for (eid, (etype, len, t)) in &creates {
        if *etype != 2 && *etype != 1 {
            eprintln!("  eid {eid}: type {etype}, payload {len}B @t={t}");
        }
    }
    eprintln!("== nested-property packets per entity (non-avatar/ship) ==");
    for (eid, n) in &nested_counts {
        let etype = creates.get(eid).map(|x| x.0);
        if etype != Some(2) && etype != Some(1) {
            eprintln!("NESTEDIT eid {eid} (type {etype:?}): {n} nested");
            if *n > 300 {
                for (t, data) in nested_samples.get(eid).into_iter().flatten() {
                    eprintln!("NESTED t={t} len={}: {}", data.len(), hex(data));
                }
            } else {
                for (t, data) in nested_samples.get(eid).into_iter().flatten().take(8) {
                    eprintln!("    t={t}: {}", hex(&data[..data.len().min(48)]));
                }
            }
        }
    }
    eprintln!("== 0x07 property packets per entity (non-avatar/ship) ==");
    for (eid, n) in &prop_counts {
        let etype = creates.get(eid).map(|x| x.0);
        if etype != Some(2) && etype != Some(1) {
            eprintln!("  eid {eid} (type {etype:?}): {n} props");
            if *n > 300 {
                for (t, data) in prop_samples.get(eid).into_iter().flatten() {
                    eprintln!("PROP t={t}: {}", hex(data));
                }
            }
        }
    }
    eprintln!("== 0x2a movement per entity (non-avatar/ship) ==");
    for (eid, moves) in &aux_moves {
        let etype = creates.get(eid).map(|x| x.0);
        if etype != Some(2) && etype != Some(1) {
            eprintln!(
                "  eid {eid} (type {etype:?}): {} sampled moves",
                moves.len()
            );
            for (t, x, y, z) in moves.iter().take(6) {
                eprintln!("    t={t}: ({x:.1}, {y:.1}, {z:.1})");
            }
        }
    }
    let mut biggest: Option<(i32, &[u8])> = None;
    c = 0;
    while c + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[c..c + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[c + 4..c + 8].try_into().unwrap());
        let payload_end = c + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        let payload = &inflated[c + 12..payload_end];
        if ptype == PACKET_ENTITY_CREATE
            && payload.len() >= 38
            && i16::from_le_bytes(payload[4..6].try_into().unwrap()) != 2
            && biggest.is_none_or(|(_, b)| payload.len() > b.len())
        {
            biggest = Some((
                i32::from_le_bytes(payload[0..4].try_into().unwrap()),
                payload,
            ));
        }
        c = payload_end;
    }
    if let Some((eid, payload)) = biggest {
        let state = &payload[38..];
        eprintln!(
            "== biggest non-ship create eid {eid}: state {}B ==",
            state.len()
        );
        eprintln!("STATE {}", hex(state));
        for off in 0..state.len().saturating_sub(4) {
            let f = f32::from_le_bytes(state[off..off + 4].try_into().unwrap());
            if f.is_finite() && (20.0..=700.0).contains(&f) && (f - f.round()).abs() < 0.01 {
                eprintln!("  integral float @ {off}: {f}");
            }
        }
        for needle in ["weather", "localWeather", "Rain", "rain", "Cyclone"] {
            if let Some(i) = state
                .windows(needle.len())
                .position(|w| w == needle.as_bytes())
            {
                let lo = i.saturating_sub(16);
                let hi = (i + 96).min(state.len());
                eprintln!("  str {needle:?} @ {i}: {}", hex(&state[lo..hi]));
            }
        }
    }
}

/// The state-stream shipId scanner also looks inside base64 runs: Lesta
/// wraps the ship's GameParams id property in a base64 blob in the
/// EntityCreate state (26.10).
#[test]
fn scans_state_for_ship_id_inside_base64() {
    // "01 00 00 00" + shipId LE + filler, base64-encoded and
    // embedded mid-state with noise around it.
    let mut inner = vec![0x01, 0x00, 0x00, 0x00];
    inner.extend_from_slice(&3540989648u32.to_le_bytes());
    inner.extend_from_slice(&[0x36, 0x00, 0x00, 0x00, 0xaa, 0xbb]);
    let encoded = base64_encode(&inner);
    let mut state = vec![0u8; 200];
    let off = 120;
    state[off..off + encoded.len()].copy_from_slice(&encoded);
    let candidates: std::collections::HashSet<u32> = [3550394352, 3540989648].into_iter().collect();
    assert_eq!(
        scan_state_for_ship_id(&state, &candidates),
        Some(3540989648)
    );
    // Candidates that appear nowhere (raw or in any decoded run) match
    // nothing.
    let none: std::collections::HashSet<u32> = [4275878552, 4026531840].into_iter().collect();
    assert_eq!(scan_state_for_ship_id(&state, &none), None);
}

/// Minimal RFC 4648 base64 encoder for the scan test (the decoder under
/// test lives in payloads.rs; this only produces valid input for it).
fn base64_encode(bytes: &[u8]) -> Vec<u8> {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHA[(n >> 18) as usize & 63]);
        out.push(ALPHA[(n >> 12) as usize & 63]);
        out.push(if chunk.len() > 1 {
            ALPHA[(n >> 6) as usize & 63]
        } else {
            b'='
        });
        out.push(if chunk.len() > 2 {
            ALPHA[n as usize & 63]
        } else {
            b'='
        });
    }
    out
}

/// Lesta's receiveDamageStat payload: u8 length prefix + zlib(MessagePack)
/// map of `[weapon, category] -> [count, float32 total]` (+ an ignored
/// trailing second blob). WG pickles the same shape (covered by captures);
/// both decode to the same samples.
#[test]
fn decodes_lesta_msgpack_damage_stat() {
    // zlib(fixmap2 { [1,0]: [6, 22162.0f32], [4,0]: [2, 1500.5f32] }) with
    // a trailing ignored second-blob stub.
    let arg: Vec<u8> = [
        0x1e, 0x78, 0x9c, 0x6b, 0x9a, 0xc4, 0xc8, 0x30, 0x89, 0xed, 0x94, 0xdb, 0x5a, 0x15, 0x86,
        0x49, 0x2c, 0x0c, 0x93, 0x98, 0x4e, 0xb9, 0xec, 0x9e, 0xc0, 0x00, 0x00, 0x4c, 0xa4, 0x07,
        0x12, 0x00, 0x00,
    ]
    .to_vec();
    let out = super::events::decode_damage_stat(12.5, &arg);
    assert_eq!(out.len(), 2);
    assert_eq!((out[0].weapon, out[0].category, out[0].count), (1, 0, 6));
    assert!((out[0].total - 22162.0).abs() < 0.5);
    assert_eq!((out[1].weapon, out[1].category, out[1].count), (4, 0, 2));
    assert!((out[1].total - 1500.5).abs() < 0.5);
}

/// The MessagePack subset reader consumes the signed int markers with their
/// real widths (int16/int32 → 2/4 bytes, NOT the doubling the uint sequence
/// suggests) — a payload using them must parse without dropping.
#[test]
fn decodes_lesta_msgpack_damage_stat_signed_ints() {
    // zlib(fixmap1 { [int16 2, int32 5]: [int32 100, f32 999.0] }).
    let arg: Vec<u8> = [
        0x1b, 0x78, 0x9c, 0x6b, 0x9c, 0x74, 0x91, 0x81, 0xe9, 0x12, 0x03, 0x03, 0x03, 0xeb, 0x24,
        0x10, 0x99, 0x72, 0xca, 0xa5, 0xf2, 0x00, 0x03, 0x00, 0x4b, 0xd2, 0x06, 0xcd,
    ]
    .to_vec();
    let out = super::events::decode_damage_stat(1.0, &arg);
    assert_eq!(out.len(), 1);
    assert_eq!((out[0].weapon, out[0].category, out[0].count), (2, 5, 100));
    assert!((out[0].total - 999.0).abs() < 0.5);
}

// ── live temp-replay truncation tolerance ───────────────────────────────────

/// Encrypt `plain` with the replay scheme's inverse (Blowfish-ECB + the
/// plaintext XOR chain, `decrypt_stream` run backwards) and prefix the 8-byte
/// marker block the decryptor skips. Mirrors what the game writes, so the
/// partial-decode tests exercise the real wire path.
fn encrypt_stream_for_test(plain: &[u8]) -> Vec<u8> {
    use blowfish::cipher::{BlockCipherEncrypt, KeyInit};

    let cipher = WowsBlowfish::new_from_slice(&WOWS_BLOWFISH_KEY).unwrap();
    let mut out = vec![0u8; 8]; // the marker block decrypt_stream skips
    let mut prev_plain: i64 = 0;
    for chunk in plain.chunks(8) {
        let mut block = [0u8; 8];
        block[..chunk.len()].copy_from_slice(chunk);
        let v = i64::from_le_bytes(block);
        let mut buf: [u8; 8] = (v ^ prev_plain).to_le_bytes();
        let mut block: Block<WowsBlowfish> = buf.into();
        cipher.encrypt_block(&mut block);
        buf = block.into();
        out.extend_from_slice(&buf);
        prev_plain = v;
    }
    out
}

/// A truncated in-progress stream decodes (partial) but is rejected by the
/// strict path — the exact split `temp.wowsreplay` tailing relies on.
#[test]
fn partial_decode_tolerates_torn_tail() {
    use std::io::Write as _;

    let frames: Vec<u8> = (0..4096u32)
        .flat_map(|i| i.to_le_bytes().to_vec())
        .collect();
    let mut plain = Vec::new();
    flate2::write::ZlibEncoder::new(&mut plain, flate2::Compression::default())
        .write_all(&frames)
        .unwrap();
    let encrypted = encrypt_stream_for_test(&plain);
    // Tear the stream: a partial trailing block AND a mid-deflate cut.
    let torn = &encrypted[..encrypted.len() - 13];

    let strict = decode_replay(torn, &Default::default(), None, false);
    assert!(strict.is_err(), "strict decode must reject a torn stream");

    let partial = decode_replay_partial(torn, &Default::default(), None, false);
    assert!(
        partial.is_ok(),
        "partial decode must tolerate the torn tail"
    );
    // The walk stays total — no panic, and the marker-only prefix decodes to
    // an empty-but-valid result shape.
    let decoded = partial.unwrap();
    assert!(decoded.positions.is_empty());
}

/// A complete stream decodes identically through both entry points.
#[test]
fn partial_decode_matches_strict_on_complete_stream() {
    use std::io::Write as _;

    let plain = Vec::new();
    let mut enc = flate2::write::ZlibEncoder::new(plain, flate2::Compression::default());
    enc.write_all(&[1, 2, 3, 4, 5, 6, 7, 8]).unwrap();
    let plain = enc.finish().unwrap();
    let encrypted = encrypt_stream_for_test(&plain);

    let a = decode_replay(&encrypted, &Default::default(), None, false).unwrap();
    let b = decode_replay_partial(&encrypted, &Default::default(), None, false).unwrap();
    assert_eq!(a.version, b.version);
    assert_eq!(a.positions.len(), b.positions.len());
}

/// Garbage (not a zlib stream at all) is rejected by the partial path too —
/// only the `UnexpectedEof` truncation signal is tolerated.
#[test]
fn partial_decode_still_rejects_garbage() {
    let garbage = encrypt_stream_for_test(&[0xff; 512]);
    assert!(decode_replay_partial(&garbage, &Default::default(), None, false).is_err());
}

/// A valid deflate prefix with a zero-filled tail — the still-unwritten
/// region of a pre-allocated temp container — must keep the frames the
/// prefix holds on the partial path (the frame walk is total, so the
/// snapshot loses only the tail), while the strict path keeps its hard
/// error for the same bytes.
#[test]
fn partial_decode_keeps_prefix_behind_zero_fill() {
    use std::io::Write as _;

    // Server-tick frames (size 0, type 0x0e): the walk counts them even
    // though they carry no payload, so any surviving prefix is observable.
    let mut frames = Vec::new();
    for i in 0..2048u32 {
        frames.extend_from_slice(&0u32.to_le_bytes()); // payload size
        frames.extend_from_slice(&0x0eu32.to_le_bytes()); // server tick
        frames.extend_from_slice(&(i as f32).to_le_bytes()); // time
    }
    let mut compressed = Vec::new();
    flate2::write::ZlibEncoder::new(&mut compressed, flate2::Compression::default())
        .write_all(&frames)
        .unwrap();
    let encrypted = encrypt_stream_for_test(&compressed);
    // Cut at a block boundary mid-stream, then a zero-filled region.
    let cut = encrypted.len() / 2 / 8 * 8;
    let mut torn = encrypted[..cut].to_vec();
    torn.extend_from_slice(&[0u8; 8192]);

    let strict = decode_replay(&torn, &Default::default(), None, false);
    assert!(
        strict.is_err(),
        "the strict decode must reject the zero-filled tail"
    );

    let partial = decode_replay_partial(&torn, &Default::default(), None, false)
        .expect("the partial decode must keep the prefix");
    assert!(
        partial.diagnostics.server_ticks > 0,
        "frames before the zero fill must survive the partial decode"
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Recorder-ship anchor (live calibration, 2026-10-08 Lesta battle)
// ─────────────────────────────────────────────────────────────────────────

/// The recorder's own ship never emits Position (0x0a) packets — its
/// transform rides the 0x2c stream instead — so among the type-2 entities
/// exactly ONE carries no 0x0a samples, verified on a Lesta capture; the
/// anchor is consumed only on the Lesta paths today. That
/// anchor survives roster gaps, co-op mirror configs and Lesta's missing
/// arena state, where the config-id join falls apart (the live battle this
/// rule was cut on: the self entry vanished mid-fight before it).
fn calib_sample_at(time: f32) -> wowsp_tauri_shared::PositionSample {
    wowsp_tauri_shared::PositionSample {
        entity_id: 0,
        vehicle_id: 0,
        time,
        x: 0.0,
        y: 0.0,
        z: 0.0,
        yaw: 0.0,
    }
}

#[test]
fn recorder_ship_is_the_type2_entity_without_0x0a_samples() {
    // Three ships: 11 streams 0x0a, the recorder's 12 only ever rides the
    // 0x2c stream (present in the position map, absent from the 0x0a
    // counts), 13 streams 0x0a; entity 14 is not a ship.
    let mut kinds = std::collections::BTreeMap::new();
    kinds.insert(11, test_entity_kind(2));
    kinds.insert(12, test_entity_kind(2));
    kinds.insert(13, test_entity_kind(2));
    kinds.insert(14, test_entity_kind(7));
    let mut positions = std::collections::BTreeMap::new();
    positions.insert(11, vec![calib_sample_at(1.0)]);
    positions.insert(12, vec![calib_sample_at(1.0)]); // the 0x2c stream
    positions.insert(13, vec![calib_sample_at(2.0)]);
    let mut a_counts = std::collections::BTreeMap::new();
    a_counts.insert(11, 1usize);
    a_counts.insert(13, 1usize);
    assert_eq!(
        super::frames::recorder_ship_of(&kinds, &a_counts, &positions),
        Some(12)
    );
}

/// A ship created but never sampled (torn prefix) must NOT become the
/// anchor: only a 0x2c-riding ship qualifies, and 0 or 2+ candidates
/// mean no anchor at all (the config-id fallback stays in force).
#[test]
fn recorder_ship_anchor_refuses_ambiguous_captures() {
    let mut kinds = std::collections::BTreeMap::new();
    let mut positions = std::collections::BTreeMap::new();
    let mut a_counts = std::collections::BTreeMap::new();
    for eid in [21i32, 22, 23] {
        kinds.insert(eid, test_entity_kind(2));
        positions.insert(eid, vec![calib_sample_at(1.0)]);
        a_counts.insert(eid, 1usize);
    }
    // Every ship streams 0x0a: no candidate.
    assert_eq!(
        super::frames::recorder_ship_of(&kinds, &a_counts, &positions),
        None
    );
    // One candidate that is NOT in the position map (created, unsampled):
    // still refused — the anchor must ride the 0x2c stream.
    a_counts.remove(&22);
    positions.remove(&22);
    assert_eq!(
        super::frames::recorder_ship_of(&kinds, &a_counts, &positions),
        None
    );
    // Two 0x2c-riding ships (a spectator-era ambiguity): refused.
    a_counts.remove(&21);
    a_counts.remove(&23);
    assert_eq!(
        super::frames::recorder_ship_of(&kinds, &a_counts, &positions),
        None
    );
}

fn test_entity_kind(entity_type: i16) -> wowsp_tauri_shared::EntityKind {
    wowsp_tauri_shared::EntityKind {
        entity_type,
        vehicle_id: 0,
        initial_x: 0.0,
        initial_y: 0.0,
        initial_z: 0.0,
        creation_time: 0.0,
        ship_id: None,
        max_health: None,
        control_point_index: None,
        initial_team: None,
        radius: None,
        team_id: None,
    }
}

/// CruiseState (0x32): the 8-byte `u32 controller, i32 level` layout
/// decodes for both controllers, maps confirmed levels to normalized
/// values, leaves unconfirmed ones as `None`, and rejects non-8-byte
/// payloads outright.
#[test]
fn decodes_cruise_state_payload() {
    let mk = |controller: u32, level: i32| {
        let mut p = Vec::new();
        p.extend_from_slice(&controller.to_le_bytes());
        p.extend_from_slice(&level.to_le_bytes());
        p
    };
    // Throttle: battle-start W W W W burst (real bytes from the reference
    // replay): 0 -> 1 -> 2 -> 3 -> 4.
    for (level, want) in [(0, 0.0f32), (1, 0.25), (2, 0.5), (3, 0.75), (4, 1.0)] {
        let s = parse_cruise_state(&mk(0, level), 7.2).expect("must parse");
        assert_eq!(s.controller, 0);
        assert_eq!(s.level, level);
        assert!((s.value.expect("ahead presets map") - want).abs() < 1e-6);
    }
    // Astern tap (real bytes: ff ff ff ff): sign mapped, depth kept at
    // -1.0 with the documented uncertainty.
    let s = parse_cruise_state(&mk(0, -1), 483.14).expect("must parse");
    assert_eq!(s.value, Some(-1.0));
    // Deeper astern levels were never observed — must stay unmapped.
    assert_eq!(
        parse_cruise_state(&mk(0, -2), 0.0)
            .expect("structure decodes")
            .value,
        None
    );
    // Rudder: the t=112 hard-over burst 1 -> 0 -> -1 -> -2 (real bytes).
    for (level, want) in [(1, 0.5f32), (0, 0.0), (-1, -0.5), (-2, -1.0)] {
        let s = parse_cruise_state(&mk(1, level), 112.9).expect("must parse");
        assert_eq!(s.controller, 1);
        assert!((s.value.expect("rudder marks map") - want).abs() < 1e-6);
    }
    // Unknown controller id — structure decodes, semantics stay None.
    let s = parse_cruise_state(&mk(3, 1), 1.0).expect("must parse");
    assert_eq!(s.value, None);
    // Length discipline: 7 or 9 bytes never observed — rejected.
    assert!(parse_cruise_state(&mk(0, 4)[..7], 0.0).is_none());
    let mut nine = mk(0, 4);
    nine.push(0);
    assert!(parse_cruise_state(&nine, 0.0).is_none());
}

/// E2 verification against a real replay (skips without
/// `WOWSP_TEST_REPLAY`): the decoded throttle timeline must be consistent
/// with position-differentiated speed of the recorder's own ship —
/// sustained full-ahead reaches (at least) half the ship's top observed
/// speed, and sustained stop events bring it to a near standstill — and
/// the recorder-vehicle join (avatar's 0x2c link) must resolve to the
/// type-2 entity whose cruise samples are attached.
#[test]
fn cruise_state_consistent_with_speed_on_real_replay() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        corpus_skip("cruise_state_consistent_with_speed_on_real_replay");
        return;
    };
    let bytes = std::fs::read(&path).expect("read real replay");
    // Mirror read_replay_positions' preamble minimally: block-walk to the
    // packet stream, descriptor roster ids, version-driven profile.
    let mut cur = 8usize;
    let mut client_version: Option<String> = None;
    if let Some(json) = crate::meta::extract_descriptor_json(&bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            client_version = raw
                .get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string);
        }
    }
    if let Some(n) = u32::from_le_bytes(bytes[4..8].try_into().unwrap()).checked_sub(1) {
        for _ in 0..n {
            let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
            cur += 4 + bl;
        }
    }
    let decoded = decode_replay(
        &bytes[cur..],
        &std::collections::HashSet::new(),
        client_version.as_deref(),
        false,
    )
    .expect("decode real replay");
    let stream = crate::assemble::group_by_entity(decoded);
    let recorder_id = stream
        .recorder_vehicle_id
        .expect("modern replay must carry the avatar->vehicle link");
    let traj = stream
        .trajectories
        .iter()
        .find(|t| t.entity_id == recorder_id)
        .expect("recorder trajectory");
    assert_eq!(
        traj.kind.as_ref().map(|k| k.entity_type),
        Some(2),
        "recorder vehicle must be a type-2 ship"
    );
    let cruise = &traj.cruise_samples;
    assert!(
        !cruise.is_empty(),
        "a real replay must carry CruiseState packets"
    );
    // Every sample must be one of the two known controllers with
    // dynamics-confirmed level ranges.
    for s in cruise {
        assert!(s.controller <= 1, "unexpected controller {}", s.controller);
        if s.controller == 0 {
            assert!((-1..=4).contains(&s.level), "throttle level {}", s.level);
        } else {
            assert!((-2..=2).contains(&s.level), "rudder level {}", s.level);
        }
    }
    // No other entity carries cruise samples.
    for t in &stream.trajectories {
        if t.entity_id != recorder_id {
            assert!(
                t.cruise_samples.is_empty(),
                "cruise samples leaked onto entity {}",
                t.entity_id
            );
        }
    }
    // Speed series (planar) of the recorder's ship.
    let samples = &traj.samples;
    if samples.len() < 2 {
        eprintln!(
            "[e2] degenerate replay: {} position samples - skipping",
            samples.len()
        );
        return;
    }
    let speed_at = |t: f32, win: f32| -> Option<f32> {
        let a = samples.iter().find(|s| s.time >= t - win)?;
        let b = samples.iter().rev().find(|s| s.time <= t + win)?;
        let dt = b.time - a.time;
        if dt < 0.5 {
            return None;
        }
        Some(((b.x - a.x).powi(2) + (b.z - a.z).powi(2)).sqrt() / dt)
    };
    // Ship's top observed speed: 95th percentile of the 30s-window series
    // (robust against any stray jumps).
    let mut speeds = Vec::new();
    let mut t = samples.first().unwrap().time;
    let t_end = samples.last().unwrap().time;
    while t < t_end {
        if let Some(v) = speed_at(t + 15.0, 15.0) {
            speeds.push(v);
        }
        t += 10.0;
    }
    speeds.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = speeds[(speeds.len() as f32 * 0.95) as usize].max(1e-3);
    // Step-hold the throttle timeline; check quasi-steady consistency.
    let throttle_at = |tt: f32| -> Option<i32> {
        cruise
            .iter()
            .filter(|s| s.controller == 0 && s.time <= tt)
            .next_back()
            .map(|s| s.level)
    };
    let mut full_ok = 0usize;
    let mut stop_ok = 0usize;
    let mut full_total = 0usize;
    let mut stop_total = 0usize;
    let mut tt = samples.first().unwrap().time + 60.0;
    while tt < t_end - 60.0 {
        let level = throttle_at(tt);
        let held = |target: i32| -> bool {
            // The level at tt and 20 s earlier match -> held long enough
            // for the ship to have settled towards it.
            level == Some(target) && throttle_at(tt - 20.0) == Some(target)
        };
        if held(4) {
            full_total += 1;
            if let Some(v) = speed_at(tt, 8.0) {
                if v >= 0.5 * p95 {
                    full_ok += 1;
                }
            }
        } else if held(0) {
            stop_total += 1;
            if let Some(v) = speed_at(tt, 8.0) {
                if v <= 0.25 * p95 {
                    stop_ok += 1;
                }
            }
        }
        tt += 5.0;
    }
    eprintln!(
        "[e2] {} cruise samples ({} throttle / {} rudder); p95 speed {:.2}; full-ahead settled {}/{} windows >= 50% p95; stop settled {}/{} windows <= 25% p95",
        cruise.len(),
        cruise.iter().filter(|s| s.controller == 0).count(),
        cruise.iter().filter(|s| s.controller == 1).count(),
        p95,
        full_ok,
        full_total,
        stop_ok,
        stop_total
    );
    // The reference Lexington replay: 17/31 throttle, 14/31 rudder. Both
    // behaviors must have been exercised and held at least 80% of the
    // settled windows.
    assert!(full_total > 0, "no sustained full-ahead window observed");
    assert!(stop_total > 0, "no sustained stop window observed");
    assert!(
        full_ok as f32 / full_total as f32 >= 0.8,
        "full-ahead windows inconsistent with speed ({full_ok}/{full_total})"
    );
    assert!(
        stop_ok as f32 / stop_total as f32 >= 0.8,
        "stop windows inconsistent with speed ({stop_ok}/{stop_total})"
    );
}

/// The exact SmokeScreen create-state bytes captured from the 15.8.0
/// reference replay — one per smoke family present in that match.
/// eid 205831 (Amalfi exhaust smoke), 205853 (Yorktown plane smoke),
/// 205884 (Colonna BB oil smoke).
fn smoke_state_blob(family: u8) -> Vec<u8> {
    match family {
            // radius 17.0, height 5.0, one puff point at (483.50, 0, -96.24).
            0 => "5c00000007000101000088410200008841030000a0400401baccf143000000001e9ac0c2051f7061727469636c65732f536d6f6b6553637265656e5f737061776e2e786d6c06197061727469636c65732f536d6f6b6553637265656e2e786d6c",
            // radius 17.5, height 10.0.
            1 => "5c0000000700010100008c410200008c4103000020410401353a3c4200000000883be343051f7061727469636c65732f536d6f6b6553637265656e5f737061776e2e786d6c06197061727469636c65732f536d6f6b6553637265656e2e786d6c",
            // radius 30.0, height 5.0.
            _ => "5c000000070001010000f041020000f041030000a04004013bf307c30000000045f06cc2051f7061727469636c65732f536d6f6b6553637265656e5f737061776e2e786d6c06197061727469636c65732f536d6f6b6553637265656e2e786d6c",
        }
        .chars()
        .map(|c| c.to_digit(16).unwrap() as u8)
        .collect::<Vec<u8>>()
        .chunks(2)
        .map(|c| (c[0] << 4) | c[1])
        .collect()
}

/// parse_smoke_state walks the real captured state blobs and yields the
/// GameParams radius/height of each family: 17.0/5.0 (Italian exhaust
/// smoke), 17.5/10.0 (support-CV plane smoke), 30.0/5.0 (Italian BB oil
/// smoke).
#[test]
fn parses_smoke_state_from_reference_replay_bytes() {
    let (r, h) = parse_smoke_state(&smoke_state_blob(0));
    assert_eq!(r, Some(17.0));
    assert_eq!(h, Some(5.0));
    let (r, h) = parse_smoke_state(&smoke_state_blob(1));
    assert_eq!(r, Some(17.5));
    assert_eq!(h, Some(10.0));
    let (r, h) = parse_smoke_state(&smoke_state_blob(2));
    assert_eq!(r, Some(30.0));
    assert_eq!(h, Some(5.0));
    // The blob is passed with its u32 length prefix included (payload
    // tail as the frame loop sees it); a bare prefix shorter than the
    // count byte yields nothing.
    assert_eq!(parse_smoke_state(&[0x5c, 0, 0, 0]), (None, None));
    assert_eq!(parse_smoke_state(&[]), (None, None));
}

/// Any desync disables the fields instead of guessing: an unknown
/// property id (future def change) or a truncated value aborts the walk.
#[test]
fn smoke_state_walk_rejects_desync() {
    let mut blob = smoke_state_blob(0);
    // Corrupt the first property id (offset 4+1) to an id the smoke def
    // does not define.
    blob[5] = 0x63;
    assert_eq!(parse_smoke_state(&blob), (None, None));
    // Truncating mid-string also aborts.
    let short = &smoke_state_blob(0)[..40];
    assert_eq!(parse_smoke_state(short), (None, None));
    // An out-of-plausibility radius (id 2) is rejected: flip the float to
    // 1e9 (0x4e6e6b28) — walk succeeds but the gate zeroes both fields.
    let mut hot = smoke_state_blob(0);
    let off = 4 + 1 + 2 + 5 + 1; // prefix + nProps + id0/i8 + id1/f32 + id2
    hot[off..off + 4].copy_from_slice(&1e9f32.to_le_bytes());
    assert_eq!(parse_smoke_state(&hot), (None, None));
}

/// Frame-level lifecycle: a SmokeScreen EntityCreate followed by its
/// EntityLeave produces one event with the walked radius/height and the
/// leave time as the observed dissipation end.
#[test]
fn walk_frames_collects_smoke_lifecycle() {
    fn frame(ptype: u32, time: f32, payload: &[u8]) -> Vec<u8> {
        let mut f = Vec::with_capacity(12 + payload.len());
        f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        f.extend_from_slice(&ptype.to_le_bytes());
        f.extend_from_slice(&time.to_le_bytes());
        f.extend_from_slice(payload);
        f
    }
    // EntityCreate payload: eid=205831, type=4, vehicle/space=0, pos,
    // direction, then the real captured state blob.
    let mut create = Vec::new();
    create.extend_from_slice(&205831i32.to_le_bytes());
    create.extend_from_slice(&4i16.to_le_bytes());
    create.extend_from_slice(&0i32.to_le_bytes());
    create.extend_from_slice(&0i32.to_le_bytes());
    create.extend_from_slice(&484.0f32.to_le_bytes());
    create.extend_from_slice(&0.0f32.to_le_bytes());
    create.extend_from_slice(&(-96.0f32).to_le_bytes());
    create.extend_from_slice(&[0u8; 12]);
    create.extend_from_slice(&smoke_state_blob(0));
    let mut stream = frame(PACKET_ENTITY_CREATE, 81.7, &create);
    // A ship EntityCreate must NOT produce a smoke event.
    let mut ship_create = create.clone();
    ship_create[4..6].copy_from_slice(&2i16.to_le_bytes());
    stream.extend(frame(PACKET_ENTITY_CREATE, 82.0, &ship_create));
    // The entity leaves the observed area at 131.7 — dissipation.
    stream.extend(frame(PACKET_ENTITY_LEAVE, 131.7, &205831i32.to_le_bytes()));

    let profile = LayoutProfile {
        e11: None,
        ..profile_for(false)
    };
    let decoded = walk_frames(
        &stream,
        &std::collections::HashSet::new(),
        false,
        &profile,
        None,
    );
    assert_eq!(
        decoded.smoke_screens.len(),
        1,
        "only the type-4 create counts"
    );
    let s = &decoded.smoke_screens[0];
    assert_eq!(s.entity_id, 205831);
    assert!((s.time - 81.7).abs() < 1e-4);
    assert!((s.x - 484.0).abs() < 1e-3);
    assert!((s.z + 96.0).abs() < 1e-3);
    assert_eq!(s.radius, Some(17.0));
    assert_eq!(s.height, Some(5.0));
    assert_eq!(s.end_time, Some(131.7));
    // The entity kind is still recorded for the position-stream consumer.
    assert_eq!(
        decoded.kinds.get(&205831).map(|k| k.entity_type),
        Some(ENTITY_TYPE_SMOKE_SCREEN)
    );
}

/// E8 against the real replay (skips without `WOWSP_TEST_REPLAY`): every
/// smoke must decode a plausible radius/height, carry a dissipation end
/// after its creation, and spawn where its own position trail begins
/// (the create state's first puff point equals the header position, so
/// the trajectory's first sample must sit next to it).
#[test]
fn smoke_screens_on_real_replay() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        corpus_skip("smoke_screens_on_real_replay");
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
        false,
    )
    .expect("decode must succeed");
    if decoded.smoke_screens.is_empty() {
        eprintln!("[e8] no smoke screens in this replay - skipping");
        return;
    }
    eprintln!(
        "[e8] {} smoke screens (version {:?}):",
        decoded.smoke_screens.len(),
        client_version
    );
    for s in &decoded.smoke_screens {
        eprintln!(
            "  t={:>6.1} eid={} pos=({:>6.1},{:>6.1}) r={:?} h={:?} end={:?} dur={}",
            s.time,
            s.entity_id,
            s.x,
            s.z,
            s.radius,
            s.height,
            s.end_time,
            s.end_time.map(|e| e - s.time).unwrap_or(f32::NAN)
        );
    }
    for s in &decoded.smoke_screens {
        let (Some(r), Some(h), Some(end)) = (s.radius, s.height, s.end_time) else {
            panic!("smoke {} must decode radius/height/end_time", s.entity_id);
        };
        assert!((1.0..=100.0).contains(&r), "implausible radius {r}");
        assert!((0.5..=100.0).contains(&h), "implausible height {h}");
        assert!(end > s.time, "dissipation before creation");
        // Total smoke lifetimes in WoWS run ~20-140 s (emission + puff
        // lifeTime); the observed entity lifetime must land there.
        assert!(
            (10.0..=180.0).contains(&(end - s.time)),
            "implausible lifetime {:.1}",
            end - s.time
        );
        // Positional anchor: the smoke entity's own trail starts at its
        // spawn point (within the cloud radius in scene units, ~2x slack).
        if let Some(first) = decoded.positions.get(&s.entity_id).and_then(|v| v.first()) {
            let d = ((first.x - s.x).powi(2) + (first.z - s.z).powi(2)).sqrt();
            let r_scene = r * 30.0 / 5.86; // GameParams units -> scene units
            assert!(
                d <= 2.0 * r_scene,
                "trail starts {d:.0}u from spawn but radius is only {r_scene:.0}u scene"
            );
        }
    }
    // Every smoke entity is a type-4 kind.
    for s in &decoded.smoke_screens {
        assert_eq!(
            decoded.kinds.get(&s.entity_id).map(|k| k.entity_type),
            Some(ENTITY_TYPE_SMOKE_SCREEN)
        );
    }
}

/// updateMinimapVisionInfo: the exact wire bytes captured from the 15.8.0
/// reference replay — the t=30.3 packet (one live marker update for
/// vehicle 963613) and a synthetic batch echoing the t=0 opening packet's
/// shape (live entries + the hidden sentinel + empty second array).
#[test]
fn decodes_minimap_vision_packets() {
    // Real t=30.3 payload: count=1, {963613, 0x37e4836f}, count=0.
    let args: Vec<u8> = [0x01u8, 0x1d, 0xb4, 0x0e, 0x00, 0x6f, 0x83, 0xe4, 0x37, 0x00]
        .into_iter()
        .collect();
    let events = decode_minimap_vision(30.3, &args);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].entity_id, 963613);
    assert_eq!(events[0].packed_data, 0x37e4_836f);
    assert!(events[0].visible);
    assert!((events[0].time - 30.3).abs() < 1e-6);

    // Opening-packet shape: live entries for the allied set, one sentinel
    // (unspotted) entry, empty second array.
    let mut batch: Vec<u8> = vec![0x04];
    for (id, packed) in [
        (963601u32, 0x37e6_9bce_u32),
        (963603, 0x37e6_1383),
        (963607, 0x37e7_6bcb),
        (963617, 0x8000_0000u32),
    ] {
        batch.extend_from_slice(&id.to_le_bytes());
        batch.extend_from_slice(&packed.to_le_bytes());
    }
    batch.push(0x00); // second array: empty
    let events = decode_minimap_vision(0.0, &batch);
    assert_eq!(events.len(), 4);
    assert!(events[..3].iter().all(|e| e.visible));
    let hidden = &events[3];
    assert!(!hidden.visible);
    assert_eq!(hidden.entity_id, 963617);
    assert_eq!(hidden.packed_data, 0x8000_0000u32);

    // Second-array entries decode under the same rules (never observed on
    // the wire — preserved as evidence, not assigned new semantics).
    let mut two_arrays: Vec<u8> = vec![0x00, 0x01];
    two_arrays.extend_from_slice(&963621u32.to_le_bytes());
    two_arrays.extend_from_slice(&0x37e2_6b2bu32.to_le_bytes());
    let events = decode_minimap_vision(12.0, &two_arrays);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].entity_id, 963621);
    assert!(events[0].visible);

    // Desync discipline: truncated entry, or trailing garbage after the
    // second array, drops the whole packet's events.
    assert!(decode_minimap_vision(0.0, &batch[..8]).is_empty());
    let mut trailing = batch.clone();
    trailing.push(0xff);
    assert!(decode_minimap_vision(0.0, &trailing).is_empty());
    assert!(decode_minimap_vision(0.0, &[]).is_empty());
}

/// onConsumableUsed: every usage variant decodes; desyncs are skipped.
/// The DEFAULT bytes are the real t=74.9 capture (usage blob {1, 10},
/// workTimeLeft 120.5 s).
#[test]
fn decodes_consumable_used_variants() {
    let real: Vec<u8> = [0x02u8, 0x01, 0x0a, 0x00, 0x00, 0xf2, 0x42]
        .into_iter()
        .collect();
    let e = decode_consumable_used(74.9, 963623, &real).expect("must decode");
    assert_eq!(e.usage_type, 1);
    assert_eq!(e.consumable_id, 10);
    assert!((e.duration - 121.0).abs() < 1e-3);
    assert_eq!(e.entity_id, 963623);
    assert!(e.target_x.is_none() && e.target_z.is_none() && e.target_id.is_none());

    // POSITION variant: blob <BBff> plus f32 duration.
    let mut pos: Vec<u8> = vec![0x0a, 0x02, 0x05];
    pos.extend_from_slice(&123.5f32.to_le_bytes());
    pos.extend_from_slice(&(-67.25f32).to_le_bytes());
    pos.extend_from_slice(&30.0f32.to_le_bytes());
    let e = decode_consumable_used(83.3, 951995, &pos).expect("must decode");
    assert_eq!(e.usage_type, 2);
    assert_eq!(e.consumable_id, 5);
    assert!((e.target_x.unwrap() - 123.5).abs() < 1e-3);
    assert!((e.target_z.unwrap() + 67.25).abs() < 1e-3);
    assert_eq!(e.target_id, None);

    // ENTITY variant: blob <BBbQ>.
    let mut ent: Vec<u8> = vec![0x0b, 0x03, 0x07, 0x01];
    ent.extend_from_slice(&963621u64.to_le_bytes());
    ent.extend_from_slice(&45.0f32.to_le_bytes());
    let e = decode_consumable_used(90.0, 951999, &ent).expect("must decode");
    assert_eq!(e.usage_type, 3);
    assert_eq!(e.consumable_id, 7);
    assert_eq!(e.target_id, Some(963621));

    // NONE variant: empty blob, duration only.
    let mut none: Vec<u8> = vec![0x00];
    none.extend_from_slice(&5.0f32.to_le_bytes());
    let e = decode_consumable_used(101.0, 963619, &none).expect("must decode");
    assert_eq!(e.usage_type, 0);
    assert_eq!(e.consumable_id, 0);
    assert!((e.duration - 5.0).abs() < 1e-4);

    // Desyncs: variant/length contradiction, truncation, bad duration.
    assert!(decode_consumable_used(0.0, 1, &[0x02, 0x02, 0x09, 0, 0, 0x16, 0x44]).is_none());
    assert!(decode_consumable_used(0.0, 1, &real[..5]).is_none());
    assert!(decode_consumable_used(0.0, 1, &[]).is_none());
    let mut nan = real.clone();
    nan[6] = 0xff; // duration exponent all-ones -> non-finite
    nan[3] = 0x7f;
    assert!(decode_consumable_used(0.0, 1, &nan).is_none());
}

/// Hostile EntityCreate floods are capped at MAX_TRACKED_ENTITIES: the
/// walk keeps tracking existing entities and drops NEW ones instead of
/// growing kinds (and, downstream, the merge's trajectories) without
/// bound. 100_001 distinct creations must leave exactly the cap in
/// place.
#[test]
fn entity_create_flood_is_capped_at_the_tracking_budget() {
    fn frame(ptype: u32, payload: &[u8]) -> Vec<u8> {
        let mut f = Vec::with_capacity(12 + payload.len());
        f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        f.extend_from_slice(&ptype.to_le_bytes());
        f.extend_from_slice(&0f32.to_le_bytes());
        f.extend_from_slice(payload);
        f
    }
    fn entity_create(eid: i32, etype: i16) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&eid.to_le_bytes());
        p.extend_from_slice(&etype.to_le_bytes());
        p.extend_from_slice(&0i32.to_le_bytes());
        p.extend_from_slice(&0i32.to_le_bytes());
        p.extend_from_slice(&[0u8; 24]);
        p
    }
    let mut stream = Vec::new();
    for eid in 0..=super::frames::MAX_TRACKED_ENTITIES as i32 {
        stream.extend(frame(
            PACKET_ENTITY_CREATE,
            &entity_create(eid, ENTITY_TYPE_VEHICLE),
        ));
    }
    let decoded = walk_frames(
        &stream,
        &std::collections::HashSet::new(),
        false,
        &profile_for(false),
        None,
    );
    assert_eq!(
        decoded.kinds.len(),
        super::frames::MAX_TRACKED_ENTITIES,
        "the flood must stop at the cap, one entity short of the input"
    );
}

/// The engine-state projection: type-2 entities' idx 9/10 property changes
/// become samples; other entities and other indices stay out; a version
/// without the E11 pin projects nothing.
#[test]
fn walk_frames_collects_engine_states() {
    fn frame(ptype: u32, time: f32, payload: &[u8]) -> Vec<u8> {
        let mut f = Vec::with_capacity(12 + payload.len());
        f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        f.extend_from_slice(&ptype.to_le_bytes());
        f.extend_from_slice(&time.to_le_bytes());
        f.extend_from_slice(payload);
        f
    }
    fn entity_create(eid: i32, etype: i16) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&eid.to_le_bytes());
        p.extend_from_slice(&etype.to_le_bytes());
        p.extend_from_slice(&0i32.to_le_bytes());
        p.extend_from_slice(&0i32.to_le_bytes());
        p.extend_from_slice(&[0u8; 24]);
        p
    }
    fn property(eid: i32, idx: u32, value: u8) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&eid.to_le_bytes());
        p.extend_from_slice(&idx.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.push(value);
        p
    }
    let mut stream = Vec::new();
    stream.extend(frame(
        PACKET_ENTITY_CREATE,
        0.0,
        &entity_create(963613, ENTITY_TYPE_VEHICLE),
    ));
    stream.extend(frame(
        PACKET_ENTITY_CREATE,
        0.0,
        &entity_create(963614, ENTITY_TYPE_AVATAR),
    ));
    stream.extend(frame(PACKET_ENTITY_PROPERTY, 29.0, &property(963613, 9, 2)));
    stream.extend(frame(PACKET_ENTITY_PROPERTY, 31.0, &property(963613, 9, 5)));
    stream.extend(frame(
        PACKET_ENTITY_PROPERTY,
        32.0,
        &property(963613, 10, 0xff),
    ));
    // Avatar property at the same indices must not leak in.
    stream.extend(frame(PACKET_ENTITY_PROPERTY, 33.0, &property(963614, 9, 7)));

    let profile = |e11: Option<E11MethodIds>| LayoutProfile {
        e11,
        ..profile_for(false)
    };
    let ids = e11_method_ids(Some((15, 8, 0)));
    let decoded = walk_frames(
        &stream,
        &std::collections::HashSet::new(),
        false,
        &profile(ids),
        None,
    );
    assert_eq!(decoded.engine_states.len(), 3, "two power + one dir change");
    let s0 = &decoded.engine_states[0];
    assert_eq!(s0.entity_id, 963613);
    assert_eq!(s0.power, Some(2));
    assert_eq!(s0.dir, None);
    assert!((s0.time - 29.0).abs() < 1e-6);
    let dir = &decoded.engine_states[2];
    assert_eq!(dir.dir, Some(-1), "0xff as i8 = -1 (braking)");
    assert_eq!(dir.power, None);
    // Without the E11 pin the projection stays empty.
    let off = walk_frames(
        &stream,
        &std::collections::HashSet::new(),
        false,
        &profile(None),
        None,
    );
    assert!(off.engine_states.is_empty());
}

/// Shared helper for the E11 real-replay tests: decode the env-gated
/// replay (None when `WOWSP_TEST_REPLAY` is unset).
fn decoded_real_replay() -> Option<DecodedReplay> {
    let path = std::env::var("WOWSP_TEST_REPLAY").ok()?;
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
        false,
    )
    .expect("decode must succeed");
    Some(decoded)
}

/// E11 against the real replay (skips without `WOWSP_TEST_REPLAY`): the
/// minimap vision stream is the explicit spot/unspot signal. Every >4 s
/// gap in a vehicle's position stream must be bracketed by vision events,
/// the last event before a gap must be the hidden sentinel in the strong
/// majority, and the first event after must be positional. This is the G1
/// core metric: the alignment rate of the explicit events against E3's
/// gap-inferred visibility.
#[test]
fn e11_vision_events_on_real_replay() {
    let Some(decoded) = decoded_real_replay() else {
        corpus_skip("e11_vision_events_on_real_replay");
        return;
    };
    if decoded.vision_events.is_empty() {
        eprintln!("[e11] no vision events decoded (version without pin?) - skipping");
        return;
    }
    let ships: std::collections::BTreeSet<i32> = decoded
        .kinds
        .iter()
        .filter(|(_, k)| k.entity_type == ENTITY_TYPE_VEHICLE)
        .map(|(eid, _)| *eid)
        .collect();
    // Every referenced entity is a vehicle.
    for e in &decoded.vision_events {
        assert!(
            ships.contains(&e.entity_id),
            "non-vehicle id {}",
            e.entity_id
        );
    }
    let hidden = decoded.vision_events.iter().filter(|e| !e.visible).count();
    eprintln!(
        "[e11] {} vision events across {} vehicles; {} hidden-sentinel events ({:.1}%)",
        decoded.vision_events.len(),
        decoded
            .vision_events
            .iter()
            .map(|e| e.entity_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        hidden,
        100.0 * hidden as f32 / decoded.vision_events.len() as f32
    );
    // Gap alignment over every vehicle's position stream.
    let by_entity: std::collections::BTreeMap<i32, Vec<&wowsp_tauri_shared::VisionEvent>> = decoded
        .vision_events
        .iter()
        .fold(std::collections::BTreeMap::new(), |mut m, e| {
            m.entry(e.entity_id).or_default().push(e);
            m
        });
    let gap_threshold = 4.0f32;
    let mut starts_total = 0usize;
    let mut starts_hit = 0usize;
    let mut starts_sentinel = 0usize;
    let mut ends_total = 0usize;
    let mut ends_hit = 0usize;
    let mut ends_positional = 0usize;
    for (eid, samples) in &decoded.positions {
        if !ships.contains(eid) || samples.len() < 2 {
            continue;
        }
        let Some(events) = by_entity.get(eid) else {
            continue;
        };
        for w in samples.windows(2) {
            let (a, b) = (w[0].time, w[1].time);
            if b - a <= gap_threshold {
                continue;
            }
            starts_total += 1;
            if let Some(last) = events
                .iter()
                .filter(|e| a - 3.5 <= e.time && e.time <= a + 1.5)
                .next_back()
            {
                starts_hit += 1;
                if !last.visible {
                    starts_sentinel += 1;
                }
            }
            ends_total += 1;
            if let Some(first) = events
                .iter()
                .find(|e| b - 1.5 <= e.time && e.time <= b + 3.5)
            {
                ends_hit += 1;
                if first.visible {
                    ends_positional += 1;
                }
            }
        }
    }
    eprintln!(
        "[e11] gap alignment: starts {starts_hit}/{starts_total} (sentinel {starts_sentinel}), ends {ends_hit}/{ends_total} (positional {ends_positional})"
    );
    assert!(starts_total > 0, "reference capture must contain gaps");
    assert!(
        starts_hit * 10 >= starts_total * 9,
        "gap starts without vision event: {}",
        starts_total - starts_hit
    );
    assert!(
        ends_hit * 10 >= ends_total * 9,
        "gap ends without vision event: {}",
        ends_total - ends_hit
    );
    assert!(
        starts_sentinel * 7 >= starts_hit * 5,
        "too few hidden-sentinel terminations: {starts_sentinel}/{starts_hit}"
    );
    assert_eq!(
        ends_positional, ends_hit,
        "every gap-end resumption must be positional"
    );
}

/// E11 against the real replay: consumable uses decode on vehicles of
/// both teams with sane durations.
#[test]
fn e11_consumables_on_real_replay() {
    let Some(decoded) = decoded_real_replay() else {
        corpus_skip("e11_consumables_on_real_replay");
        return;
    };
    if decoded.consumable_uses.is_empty() {
        eprintln!("[e11] no consumable uses decoded (version without pin?) - skipping");
        return;
    }
    let ships: std::collections::BTreeSet<i32> = decoded
        .kinds
        .iter()
        .filter(|(_, k)| k.entity_type == ENTITY_TYPE_VEHICLE)
        .map(|(eid, _)| *eid)
        .collect();
    let users: std::collections::BTreeSet<i32> = decoded
        .consumable_uses
        .iter()
        .map(|e| e.entity_id)
        .collect();
    let ids: std::collections::BTreeSet<u8> = decoded
        .consumable_uses
        .iter()
        .map(|e| e.consumable_id)
        .collect();
    eprintln!(
        "[e11] {} consumable uses across {}/{} vehicles; ids {:?}",
        decoded.consumable_uses.len(),
        users.len(),
        ships.len(),
        ids
    );
    assert!(
        decoded.consumable_uses.len() >= 40,
        "reference capture carries 104 uses"
    );
    assert!(users.len() >= 10, "expected double-digit vehicle coverage");
    assert!(
        users.len() * 2 >= ships.len() - 4,
        "uses must cover vehicles of both teams"
    );
    for e in &decoded.consumable_uses {
        assert!(ships.contains(&e.entity_id), "non-vehicle consumer");
        assert!(e.usage_type <= 3, "unknown usage variant {}", e.usage_type);
        assert!(
            e.duration > 0.0 && e.duration <= 700.0,
            "implausible workTimeLeft {}",
            e.duration
        );
    }
}

/// E11 against the real replay: every vehicle carries engine-state
/// samples; settled low power means near-standstill, full power tracks
/// the ship's top speed, and the recorder's own engine power follows its
/// CruiseState throttle (10 under sustained full-ahead).
#[test]
fn e11_engine_states_on_real_replay() {
    let Some(decoded) = decoded_real_replay() else {
        corpus_skip("e11_engine_states_on_real_replay");
        return;
    };
    if decoded.engine_states.is_empty() {
        eprintln!("[e11] no engine states decoded (version without pin?) - skipping");
        return;
    }
    let ships: std::collections::BTreeSet<i32> = decoded
        .kinds
        .iter()
        .filter(|(_, k)| k.entity_type == ENTITY_TYPE_VEHICLE)
        .map(|(eid, _)| *eid)
        .collect();
    let covered: std::collections::BTreeSet<i32> =
        decoded.engine_states.iter().map(|s| s.entity_id).collect();
    // Reference capture: 23/24 vehicles carry engine-state samples — the
    // 24th (951997) streams positions but no idx-9/10 property packets at
    // all, so full coverage cannot be forced.
    assert!(
        covered.len() + 1 >= ships.len(),
        "engine states must cover nearly every vehicle ({}/{})",
        covered.len(),
        ships.len()
    );

    // Windowed speed helper over one entity's (sorted) samples.
    let speed_at = |eid: i32, t: f32, win: f32| -> Option<f32> {
        let samples = decoded.positions.get(&eid)?;
        let a = samples.iter().find(|s| s.time >= t - win)?;
        let b = samples.iter().rev().find(|s| s.time <= t + win)?;
        let dt = b.time - a.time;
        if dt < 1.0 {
            return None;
        }
        Some(((b.x - a.x).powi(2) + (b.z - a.z).powi(2)).sqrt() / dt)
    };
    // p95 of windowed planar speed per ship.
    let p95 = |eid: i32| -> f32 {
        let mut speeds = Vec::new();
        if let Some(ss) = decoded.positions.get(&eid) {
            for w in ss.windows(2) {
                let dt = w[1].time - w[0].time;
                if (0.5..=4.0).contains(&dt) {
                    speeds
                        .push(((w[1].x - w[0].x).powi(2) + (w[1].z - w[0].z).powi(2)).sqrt() / dt);
                }
            }
        }
        speeds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        speeds
            .get(speeds.len() * 95 / 100)
            .copied()
            .unwrap_or(f32::MAX)
            .max(1e-3)
    };
    let power_at = |eid: i32, t: f32| -> Option<u8> {
        decoded
            .engine_states
            .iter()
            .filter(|s| s.entity_id == eid && s.power.is_some() && s.time <= t)
            .next_back()
            .and_then(|s| s.power)
    };
    let stream_bounds = |eid: i32| -> Option<(f32, f32)> {
        decoded
            .positions
            .get(&eid)
            .and_then(|v| v.first().zip(v.last()))
            .map(|(a, b)| (a.time, b.time))
    };

    let mut low_ratios = Vec::new();
    let mut full_ratios = Vec::new();
    for eid in &ships {
        let Some((t0, t1)) = stream_bounds(*eid) else {
            continue;
        };
        let top = p95(*eid);
        let mut t = t0 + 20.0;
        while t < t1 {
            if let (Some(ep), Some(v)) = (power_at(*eid, t), speed_at(*eid, t, 8.0)) {
                if ep <= 2 {
                    low_ratios.push(v / top);
                } else if ep == 10 {
                    full_ratios.push(v / top);
                }
            }
            t += 10.0;
        }
    }
    low_ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    full_ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let low_med = low_ratios[low_ratios.len() / 2];
    let full_med = full_ratios[full_ratios.len() / 2];
    eprintln!(
        "[e11] engine anchors: low-power median speed ratio {low_med:.3} (n={}), full-power median {full_med:.3} (n={})",
        low_ratios.len(),
        full_ratios.len()
    );
    assert!(
        low_med <= 0.25,
        "settled low power must be near-standstill (median ratio {low_med:.3})"
    );
    assert!(
        full_med >= 0.35,
        "full power must track top speed (median ratio {full_med:.3})"
    );

    // Recorder anchor: sustained full-ahead CruiseState -> engine power 10.
    let Some(rec) = decoded.recorder_vehicle else {
        panic!("modern replay must carry the avatar->vehicle link");
    };
    let throttle_at = |t: f32| -> Option<i32> {
        decoded
            .cruise
            .iter()
            .filter(|c| c.controller == 0 && c.time <= t)
            .next_back()
            .map(|c| c.level)
    };
    let mut checked = 0;
    let mut agreed = 0;
    for t in [50.0f32, 100.0, 150.0, 200.0, 250.0] {
        if throttle_at(t) == Some(4) {
            checked += 1;
            if power_at(rec, t) == Some(10) {
                agreed += 1;
            }
        }
    }
    eprintln!("[e11] recorder throttle->power agreement: {agreed}/{checked} probes");
    assert!(checked > 0, "recorder must hold full-ahead long enough");
    assert_eq!(
        agreed, checked,
        "sustained full throttle must read power 10"
    );
}

// ── vehicle build decode (15.9 create-state properties) ────────────────────
//
// The fixtures below are raw EntityCreate (0x05) payloads from the 2026-10-25
// reference capture (20261025_144331_..._e09_Halloween_2019.wowsreplay): the
// recorder's own ship (roster relation 0) and an ENEMY ship (relation 2). They
// prove the DECODE layer keeps both teams' builds; the IPC exit filters to
// allies (covered in the Tauri crate's tests).

/// Raw EntityCreate payload, 475 bytes: entity 677453, ship 4065212112
/// (PJSD219 Kitakaze), relation 0, 6 modernizations, 4 + 2 empty consumable
/// slots, 4 economic bonuses and 5 learned captain skills.
const FIXTURE_ALLY_SELF_HEX: &str = "4d560a0002000b17000000000000e774b6c300000000788bcec39ceb453f0000000000000000b10100003600000100020003000400050106010701080109000a000b000c000d000e000f0010001100120013000014ffff159f11160000179f111800001900001a00001b000000001c0054ba461d000000001e000000001f0054ba462000000000210000000022005043482300000000244c560a00250000000026b36a0e002700000000280000000029000000002a00000000000000002b04000000002c0400010101020103012d002e002fdc01000000d0364ef2340000000e000000d02e3ccbd0aeefcbd02e16cdd0ae36cbd0ae4dcb0000000000000000000000000000000000000000000000000000000000000000000000000000000006000000b0cf12feb0cfa2fbb0cfe2fdb0cf72feb0cf42feb0cf22ff0000000000000000000000000000000006000000b09f62ffb09f12ffb09f02ffb09fd2fe00000000000000000000000004000000b0ef2fffb0ef8ffeb0efeffdb0ef4ffd06000000000000000800000000000000000000000000000000000000000000000000000000000000000000001b00000030d0a6e2ff0006000000050c12141922000031003200330580024b002e3404b0c7e6ff350001000000000100";

/// Raw EntityCreate payload, 525 bytes: entity 677451, ship 3750639408
/// (PGSD519 Z-44), relation 2, 6 modernizations, camouflage + 5 signal flags
/// (PCEP/PCEF ids in the exterior slots) and 17 learned captain skills.
const FIXTURE_ENEMY_HEX: &str = "4b560a0002000b17000000000000fa98f942518e3632df7501c3777bddbf0000000000000000e301000036000001000200030004010500060107010801090a0a010b000c000d000e000f0010001100120013000014221a15221a16000017601118000019ea001a00001b000000001c002cb0461d000000001e000000001f002cb0462000000000210000000022005043482301000000244a560a00250000000026495a1400270000000028920a063f29000000002a00000000000000002b01002c0100012d002e002ffc0100000030378edf3c0000000e000000302f7ccd30af9fcd302f86cd30af76cd30af9dcd0000000000000000000000000000000000000000000000000000000000000000000000000000000006000000b0cf12feb0cfa2fbb0cf92fbb0cf72feb0cf42feb0cf12ff06000000b06f28f9b06fcdfeb06fadffb06f1dffb06f9dffb06f3dfe0000000001000000b06f28f9010000000000000006000000b09f62ffb09f12ffb09f02ff0000000000000000000000000000000004000000b0ef4fffb0ef9ffeb0effffdb0ef4ffd1e00000000000000080000000000000000000000000000000000000000000000000000000000000000000000100000003030a7e2ff000600000903080c11131517192608040c111214171819000031003200330580024b002e3404b0c7e6ff3500010110c5c9f6030100000000000080bf000000000100";

/// The 15.9.x version key the fixtures were captured on.
const FIXTURE_VERSION: (u32, u32, u32) = (15, 9, 0);

#[test]
fn decodes_ally_vehicle_build_from_the_reference_capture() {
    let payload = hex_literal(FIXTURE_ALLY_SELF_HEX);
    assert_eq!(payload.len(), 475, "fixture byte length");
    let build = super::build::decode_vehicle_build(677_453, &payload[38..], FIXTURE_VERSION)
        .expect("ally build must decode");
    assert_eq!(build.entity_id, 677_453);
    assert_eq!(build.ship_params_id, 4_065_212_112);
    // Hull/artillery/torpedo/sonar/engine modules (zero-padded to 14 slots).
    assert_eq!(build.units.len(), 14);
    assert_eq!(
        build.units[..5],
        [
            0xcb3c_2ed0,
            0xcbef_aed0,
            0xcd16_2ed0,
            0xcb36_aed0,
            0xcb4d_aed0
        ]
    );
    assert!(build.units[5..].iter().all(|unit| *unit == 0));
    assert_eq!(
        build.modernization,
        [
            0xfe12_cfb0,
            0xfba2_cfb0,
            0xfde2_cfb0,
            0xfe72_cfb0,
            0xfe42_cfb0,
            0xff22_cfb0
        ]
    );
    // No camouflage/signal exterior slots on this capture's recoder ship.
    assert!(build.exteriors.is_empty());
    // AbilitySlots: 4 mounted consumables + 2 empty slots.
    assert_eq!(
        build.abilities,
        [0xff62_9fb0, 0xff12_9fb0, 0xff02_9fb0, 0xfed2_9fb0, 0, 0]
    );
    assert!(build.ensigns.is_empty());
    assert_eq!(
        build.ecoboosts,
        [0xff2f_efb0, 0xfe8f_efb0, 0xfdef_efb0, 0xfd4f_efb0]
    );
    // Captain + per-species learned-skill arrays (6 rows, destroyer row = 3).
    assert_eq!(build.crew_params_id, 0xffe2_a6d0);
    assert!(!build.is_in_adaptation);
    assert_eq!(build.learned_skills.len(), 6);
    assert_eq!(build.learned_skills[3], [12, 18, 20, 25, 34]);
    assert!(build.learned_skills[0].is_empty());
}

#[test]
fn decodes_enemy_vehicle_build_from_the_reference_capture() {
    let payload = hex_literal(FIXTURE_ENEMY_HEX);
    assert_eq!(payload.len(), 525, "fixture byte length");
    let build = super::build::decode_vehicle_build(677_451, &payload[38..], FIXTURE_VERSION)
        .expect("enemy build must decode in the decode layer");
    assert_eq!(build.entity_id, 677_451);
    assert_eq!(build.ship_params_id, 3_750_639_408);
    assert_eq!(build.units.len(), 14);
    assert_eq!(build.modernization.len(), 6);
    // Camouflage + signal flags live in the ExteriorSlots section.
    assert_eq!(build.exteriors.len(), 6);
    assert_eq!(build.exteriors[0], 0xf928_6fb0);
    assert_eq!(build.abilities.len(), 6);
    assert_eq!(build.ecoboosts.len(), 4);
    assert_eq!(build.crew_params_id, 0xffe2_a730);
    assert_eq!(build.learned_skills.len(), 6);
    assert_eq!(build.learned_skills[2], [3, 8, 12, 17, 19, 21, 23, 25, 38]);
    assert_eq!(build.learned_skills[3], [4, 12, 17, 18, 20, 23, 24, 25]);
}

#[test]
fn vehicle_build_walk_rejects_a_desynced_create_state() {
    let payload = hex_literal(FIXTURE_ALLY_SELF_HEX);
    let state = &payload[38..];
    assert!(super::build::decode_vehicle_build(1, &state[..100], FIXTURE_VERSION).is_none());
    // Wrong property count byte.
    let mut wrong_count = state.to_vec();
    wrong_count[4] = 53;
    assert!(super::build::decode_vehicle_build(1, &wrong_count, FIXTURE_VERSION).is_none());
    // Declared total length disagrees with the slice.
    let mut wrong_len = state.to_vec();
    wrong_len[0] ^= 0xff;
    assert!(super::build::decode_vehicle_build(1, &wrong_len, FIXTURE_VERSION).is_none());
}

#[test]
fn builds_are_counted_as_skipped_on_older_client_versions() {
    // The synthetic container pins client 15.8.0: the decoder must leave
    // vehicle_builds empty, count each ship entity as skipped, and never run
    // a decode against the wrong property map.
    let decoded = decode_synthetic_replay();
    assert!(decoded.vehicle_builds.is_empty());
    assert_eq!(decoded.diagnostics.builds_decoded, 0);
    assert_eq!(
        decoded.diagnostics.builds_skipped, 2,
        "the synthetic replay has two ship entities"
    );
}

#[test]
fn build_decode_is_pinned_to_the_15_9_era() {
    assert!(super::build::builds_supported(Some((15, 9, 0))));
    assert!(super::build::builds_supported(Some((15, 9, 7))));
    assert!(!super::build::builds_supported(Some((15, 8, 1))));
    assert!(!super::build::builds_supported(None));
}

/// The 15.9 shipConfig inserted one u32 between the color-scheme section and
/// the ability slots: the SAME bytes must read the ability section under the
/// 15.8 order and fail the sanity caps under the 15.9 order.
#[test]
fn ship_config_section_order_is_version_gated() {
    fn push_u32(blob: &mut Vec<u8>, value: u32) {
        blob.extend_from_slice(&value.to_le_bytes());
    }
    let mut blob = Vec::new();
    // header: version, ship_params_id, element_count, unit_count, units[1],
    // 13.2+ unknown field.
    for value in [1u32, 4_065_212_112, 0, 1, 100] {
        push_u32(&mut blob, value);
    }
    push_u32(&mut blob, 0); // >= 13.2 unknown
    // modernization section (1 item).
    push_u32(&mut blob, 1);
    push_u32(&mut blob, 0xff12_cfb0);
    // exteriors (empty), supply state, color schemes (empty).
    push_u32(&mut blob, 0);
    push_u32(&mut blob, 0);
    push_u32(&mut blob, 0);
    // ability slots (2), ensign slots (0), ecoboost slots (1).
    push_u32(&mut blob, 2);
    push_u32(&mut blob, 0xff62_9fb0);
    push_u32(&mut blob, 0xff12_9fb0);
    push_u32(&mut blob, 0);
    push_u32(&mut blob, 1);
    push_u32(&mut blob, 0xff2f_efb0);

    let old = super::build::decode_ship_config_blob(&blob, (15, 8, 1))
        .expect("15.8 layout matches the bytes");
    assert_eq!(old.abilities, [0xff62_9fb0, 0xff12_9fb0]);
    assert!(old.ensigns.is_empty());
    assert_eq!(old.ecoboosts, [0xff2f_efb0]);

    // 15.9 reads the ability COUNT as the extra u32 slot, then interprets the
    // first ability id as a section count — over the sanity cap, so the whole
    // config is refused instead of silently shifted.
    assert!(super::build::decode_ship_config_blob(&blob, (15, 9, 0)).is_none());
}

/// Corpus check on the real reference capture (read-only): the decode layer
/// covers every vehicle, INCLUDING the enemy team, and the per-player values
/// stay within the format's slot bounds.
#[test]
fn decodes_every_vehicle_build_on_the_reference_capture() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        corpus_skip("decodes_every_vehicle_build_on_the_reference_capture");
        return;
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let stream = crate::meta::packet_stream_after_blocks(&bytes).expect("packet stream");
    let json = crate::meta::extract_descriptor_json(&bytes).expect("descriptor JSON");
    let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor must be JSON");
    let roster = crate::meta::roster_from_raw(std::path::Path::new(&path), &raw);
    let ship_relations: std::collections::HashMap<i64, i64> =
        roster.iter().map(|v| (v.ship_id, v.relation)).collect();
    let candidates: std::collections::HashSet<u32> = roster
        .iter()
        .filter(|v| v.ship_id > 0)
        .map(|v| v.ship_id as u32)
        .collect();
    let version = raw
        .get("clientVersionFromExe")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let decoded = decode_replay(stream, &candidates, version.as_deref(), false)
        .expect("reference capture must decode");
    eprintln!(
        "[build] {} vehicle builds decoded, {} skipped",
        decoded.diagnostics.builds_decoded, decoded.diagnostics.builds_skipped
    );
    assert!(
        decoded.vehicle_builds.len() >= 6,
        "the reference capture has 6 vehicles, got {}",
        decoded.vehicle_builds.len()
    );
    assert_eq!(
        decoded.vehicle_builds.len(),
        decoded.diagnostics.builds_decoded as usize,
        "diagnostics must count every decoded build"
    );
    let mut enemies = 0usize;
    for build in &decoded.vehicle_builds {
        assert!(
            candidates.contains(&build.ship_params_id),
            "build ship id {} must join the roster",
            build.ship_params_id
        );
        assert!(!build.units.is_empty(), "hull/module units must decode");
        assert!(build.modernization.len() <= 6);
        assert!(build.abilities.len() <= 6);
        assert_eq!(build.learned_skills.len(), 6);
        if ship_relations.get(&i64::from(build.ship_params_id)) == Some(&2) {
            enemies += 1;
        }
    }
    // Decode-layer completeness: the enemy team's builds are decoded too (the
    // IPC exit is what drops them).
    assert!(enemies >= 1, "enemy builds must exist in the decode layer");
}
