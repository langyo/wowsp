//! Replay packet-stream decoder (milestones M3 + entity-create).
//!
//! The `.wowsreplay` packet stream (everything after the JSON header blocks) is
//! Blowfish-ECB-encrypted with a hardcoded 16-byte game key, XOR-chained across
//! consecutive 8-byte plaintext blocks, then zlib-compressed. This module
//! reverses that and walks the resulting frame stream to extract entity
//! position trajectories (Position, 0x0a), entity-creation metadata
//! (EntityCreate, 0x05) and the battle-effect entity-method events (0x08):
//! artillery launches, torpedo launches/spreads and aircraft squadrons.
//!
//! Reference: `Monstrofil/replays_unpack` for framing, and
//! `MarshalPartyByJack/replay_unpack` (vendored in the local minimap_renderer
//! checkout) for the entity-method semantics. EntityMethod ids are BigWorld
//! "exposed indices" (client-method tables sorted by wire size) that drift
//! every game version — [`method_tables`] resolves them per replay version.
//! Battle-effect arg layouts come from the per-version `alias.xml` type
//! definitions: `SHOTS_PACK` / `TORPEDOES_PACK` / `receive_*MinimapSquadron`.

use std::collections::BTreeMap;
use std::io::Read;

use blowfish::Blowfish;
use blowfish::cipher::{Block, BlockCipherDecrypt, KeyInit};
use byteorder::BigEndian;
use flate2::read::ZlibDecoder;

use wowsp_tauri_shared::{EntityKind, PositionSample};

use super::method_tables::{MethodIds, method_ids_for_version};

/// WoWS uses the big-endian Blowfish variant (PyCryptodome default).
type WowsBlowfish = Blowfish<BigEndian>;

/// The 16-byte WoWS Blowfish key (hardcoded in the game client; same for every
/// replay regardless of version).
const WOWS_BLOWFISH_KEY: [u8; 16] = [
    0x29, 0xB7, 0xC9, 0x09, 0x38, 0x3F, 0x84, 0x88, 0xFA, 0x98, 0xEC, 0x4E, 0x13, 0x19, 0x79, 0xFB,
];

/// Packet type for entity transform updates (position + heading). Self-describing
/// fixed layout — does NOT need the per-version entity DB. Extended fields
/// (health, speed, etc.) are parsed from the trailing payload when present.
const PACKET_POSITION: u32 = 0x0a;
/// Packet type for entity property updates (health, consumables, etc.).
const PACKET_ENTITY_PROPERTY: u32 = 0x07;
/// Packet type for entity creation. The fixed header (entityID / type /
/// vehicleId / spaceId / position / direction) is readable without the entity
/// DB; the trailing `state` BinaryStream (entity properties) is skipped.
const PACKET_ENTITY_CREATE: u32 = 0x05;
/// Packet type for entity destruction. Payload is just the entity id (i32) —
/// emitted when a ship is sunk / a transient (plane, torpedo) expires. We
/// record the time so the frontend can freeze + grey out sunk ships.
const PACKET_ENTITY_DESTROY: u32 = 0x06;
/// Packet type for the recorder's own-player position stream ("PlayerPosition"
/// in Monstrofil's `replays_unpack`). The recorder's own ship never emits
/// Position (0x0a) packets — its transform arrives here instead. Layout:
///   i32 entity_id, i32 linked_entity_id, f32×3 position, f32 yaw/pitch/roll.
/// Current clients (WoWS 12.6+) use 0x2c; older builds use 0x2b.
const PACKET_PLAYER_POSITION: u32 = 0x2c;
const PACKET_PLAYER_POSITION_LEGACY: u32 = 0x2b;
/// Secondary position stream (0x2a) sharing the PlayerPosition 32-byte
/// layout; carried by transient entities on current clients (the reference
/// replay_unpack leaves it undecoded).
const PACKET_POSITION_AUX: u32 = 0x2a;
/// Packet type for the recorder's own-player entity creation ("CellPlayerCreate"
/// in Monstrofil's `replays_unpack`). The avatar (the recorder's own player)
/// is created with this packet rather than EntityCreate (0x05); same layout.
const PACKET_CELL_PLAYER_CREATE: u32 = 0x01;
/// Avatar entity type id (spec index 1). Its method table drives the
/// battle-effect events (shots, torpedoes, squadrons, explosions).
const ENTITY_TYPE_AVATAR: i16 = 1;
/// NestedPropertyUpdate (0x23): nested property blob updates, used by
/// capture zones (InteractiveZone — type 13 pre-14.5.0, 14 after) to stream
/// their live capture progress (0..1 fraction at the tail of the payload).
const PACKET_NESTED_PROPERTY: u32 = 0x23;
/// SetWeaponLock (0x30): the recorder's weapon lock state change.
/// Payload: `u32 weapon_type, u32 lock_type, u32 target_id`.
const PACKET_SET_WEAPON_LOCK: u32 = 0x30;
/// BattleResults (0x22): post-battle statistics payload (a JSON string with a
/// u32 length prefix). Emitted once near match end.
const PACKET_BATTLE_RESULTS: u32 = 0x22;
/// Version (0x16): protocol version string (u32 len + utf8).
const PACKET_VERSION: u32 = 0x16;
/// Camera (0x25): recorder camera pose every tick (quat + pos + fov + dir).
const PACKET_CAMERA: u32 = 0x25;
/// PlayerNetStats (0x1d): packed u32 (fps 8b | ping 16b | isLagging 1b).
const PACKET_NET_STATS: u32 = 0x1d;
/// Map (0x28): arena + map-name packet (carries the map's internal name).
const PACKET_MAP: u32 = 0x28;
/// EntityLeave (0x04) / EntityEnter (0x03): entities leaving/entering the
/// observed area (ships out of view, smoke/planes expiring).
const PACKET_ENTITY_LEAVE: u32 = 0x04;
const PACKET_ENTITY_ENTER: u32 = 0x03;
/// System/utility packets we decode and count (diagnostics only): server
/// tick rate, timestamp, init markers, base player create, create stub,
/// entity control, camera mode, camera freelook, sub controller, cruise
/// state, shot tracking, gun marker.
const PACKET_SERVER_TICK: u32 = 0x0e;
const PACKET_SERVER_TIMESTAMP: u32 = 0x0f;
const PACKET_INIT_FLAG: u32 = 0x10;
const PACKET_INIT_MARKER: u32 = 0x13;
const PACKET_BASE_PLAYER_CREATE: u32 = 0x00;
const PACKET_BASE_PLAYER_CREATE_STUB: u32 = 0x26;
const PACKET_ENTITY_CONTROL: u32 = 0x02;
const PACKET_CAMERA_MODE: u32 = 0x27;
const PACKET_CAMERA_FREELOOK: u32 = 0x2f;
const PACKET_SUB_CONTROLLER: u32 = 0x31;
const PACKET_CRUISE_STATE: u32 = 0x32;
const PACKET_SHOT_TRACKING: u32 = 0x33;
const PACKET_GUN_MARKER: u32 = 0x18;
/// Packet type for entity method calls (0x08). Battle events that have no
/// dedicated entity (artillery salvos, torpedo spreads, squadron markers)
/// arrive here as client-method calls on the avatar (the recorder's own
/// entity). Method ids are per-version exposed indices — resolved through
/// [`method_ids_for_version`], never hardcoded.
const PACKET_ENTITY_METHOD: u32 = 0x08;

/// Version-dependent decoder inputs resolved once per replay: the method-id
/// table and the InteractiveZone entity-type index (13 before 14.5.0, 14 after
/// — `VehicleAppearance` was inserted into `entities.xml` ahead of it).
struct LayoutProfile {
    /// `None` when the replay predates every shipped table (pre-0.11.6): the
    /// exposed indices can't be trusted, so battle-effect decoding is disabled
    /// rather than risk plausible-looking garbage.
    methods: Option<&'static MethodIds>,
    zone_entity_type: i16,
}

/// A single property change sample — one field of an entity updated at a
/// specific time. Health, speed, consumable state, etc.
#[derive(Debug, Clone)]
pub struct PropertyChange {
    pub time: f32,
    pub entity_id: i32,
    /// Property index within the entity definition (e.g. 20 = health for ships).
    pub property_index: u32,
    /// Raw value bytes (1, 2, or 4) packed little-endian into a u32. For
    /// size-4 float properties this is the f32 bit pattern.
    pub value: u32,
    /// Number of value bytes on the wire (1, 2, or 4).
    pub size: u8,
}

/// Output of decoding: per-entity trajectories plus the EntityCreate metadata
/// keyed by entity id (so the frontend can filter ships vs zones vs avatars),
/// a map of entity id → sink time for ships destroyed during the match, and
/// per-entity property change timelines (health, etc.).
pub struct DecodedReplay {
    pub positions: BTreeMap<i32, Vec<PositionSample>>,
    pub kinds: BTreeMap<i32, EntityKind>,
    /// Entity id → match time (seconds) at which the entity was destroyed.
    /// Ships whose id never appears here survived the whole match.
    pub destroys: BTreeMap<i32, f32>,
    /// Per-entity per-property change timelines (property_index → samples).
    pub properties: BTreeMap<i32, Vec<PropertyChange>>,
    /// Artillery launches (`receiveArtilleryShots` on the avatar): per-shell
    /// muzzle point, aim point and flight time.
    pub shell_launches: Vec<wowsp_tauri_shared::ShellLaunchEvent>,
    /// World-space shell impact points (`receiveExplosions` on the avatar).
    pub explosions: Vec<wowsp_tauri_shared::ExplosionEvent>,
    /// Torpedo launches (`receiveTorpedoes` on the avatar).
    pub torpedoes: Vec<wowsp_tauri_shared::TorpedoLaunch>,
    /// Homing-torpedo guidance updates (`receiveTorpedoDirection`).
    pub torpedo_steers: Vec<wowsp_tauri_shared::TorpedoSteer>,
    /// Capture-zone progress streams (NestedPropertyUpdate 0x23, entity
    /// type 14): 0..1 fraction of the current capture per entity.
    pub cap_progress: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>>,
    /// Recorder weapon-lock timeline (SetWeaponLock 0x30).
    pub weapon_locks: Vec<wowsp_tauri_shared::WeaponLockEvent>,
    /// Raw post-battle statistics payload (BattleResults 0x22).
    pub battle_results: Option<String>,
    /// Every EntityMethod call (time, entity_id, method_id, arg_len) — a
    /// diagnostic surface for identifying yet-undecoded signals (team score
    /// updates, consumables, chat) without re-decoding the stream. Collected
    /// unconditionally; nothing reads it yet (protocol-diagnostics groundwork).
    #[allow(dead_code)]
    pub method_histogram: Vec<(f32, i32, i32, u32)>,
    /// First few raw argument blobs per (entity_id, method_id) for offline
    /// protocol identification (hex-dumped by the replay dump test). Kept
    /// alongside the histogram for the same reason.
    #[allow(dead_code)]
    pub method_arg_samples: std::collections::BTreeMap<(i32, i32), Vec<Vec<u8>>>,
    /// Protocol version string (0x16).
    pub version: Option<String>,
    /// Map name from the Map packet (0x28).
    pub map_name: Option<String>,
    /// Recorder camera timeline (0x25).
    pub camera: Vec<wowsp_tauri_shared::CameraSample>,
    /// Player net stats (0x1d).
    pub net_stats: Vec<wowsp_tauri_shared::NetStatsSample>,
    /// Entity id → last leave time (0x04).
    pub leaves: BTreeMap<i32, f32>,
    /// Camera-mode changes (0x27): (time, mode).
    pub camera_modes: Vec<wowsp_tauri_shared::HpSample>,
    /// Counts of decoded system packets (diagnostics).
    pub diagnostics: wowsp_tauri_shared::DiagnosticCounts,
    /// Aircraft squadrons (avatar receive_add/updateSquadron — 3D stream).
    pub squadron_creates: Vec<wowsp_tauri_shared::SquadronCreate>,
    pub squadron_planes: Vec<wowsp_tauri_shared::SquadronPlane>,
    /// Minimap squadron markers (avatar receive_add/update/removeMinimapSquadron).
    pub minimap_squadron_adds: Vec<wowsp_tauri_shared::MinimapSquadronAdd>,
    pub minimap_squadron_moves: Vec<wowsp_tauri_shared::MinimapSquadronMove>,
    pub minimap_squadron_removes: Vec<wowsp_tauri_shared::MinimapSquadronRemove>,
}

/// A raw nested-property update captured from the stream (entity id + the
/// property blob); resolved against the entity types afterwards so only
/// capture zones (type 14) keep their progress stream.
struct RawNestedProperty {
    time: f32,
    entity_id: i32,
    payload: Vec<u8>,
}

/// A raw entity-method call captured from the stream, resolved into an event
/// after the entity types are known (the avatar entity's method table differs
/// from the vehicle table).
struct RawMethodCall {
    time: f32,
    entity_id: i32,
    method_id: i32,
    args: Vec<u8>,
}

/// Decrypt + decompress the packet stream, then walk frames extracting both
/// Position (0x0a) and EntityCreate (0x05) packets.
///
/// `ship_id_candidates`: roster shipIds from the descriptor JSON. Each
/// EntityCreate's trailing state stream is scanned for these so ships can be
/// joined to roster entries (the header `vehicle_id` field is a per-version
/// constant and useless for that).
///
/// `client_version`: the header's `clientVersionFromExe` (comma-separated
/// `major,minor,patch,build`). Selects the packet-ID layout: pre-12.6.0 replays
/// shift ids down and carry no `BattleResults`; it also selects the
/// entity-method id table (see [`method_tables`]) and the InteractiveZone
/// entity-type index. `None` assumes the modern layout.
pub fn decode_replay(
    packet_stream: &[u8],
    ship_id_candidates: &std::collections::HashSet<u32>,
    client_version: Option<&str>,
) -> Result<DecodedReplay, String> {
    let decrypted = decrypt_stream(packet_stream)?;
    let inflated = inflate_zlib(&decrypted)?;
    let version_key = client_version.and_then(parse_version_key);
    let legacy = match version_key {
        Some(k) => k < (12, 6, 0),
        None => false,
    };
    // Battle-effect method decoding requires a table that actually covers the
    // replay's version: below the oldest shipped table (0.11.6) the exposed
    // indices predate anything we know, so events stay empty.
    // Oldest shipped table is 0.11.6 (u32 tuple to match `version_key`).
    let in_table_range = version_key.map(|k| k >= (0, 11, 6)).unwrap_or(true);
    let profile = LayoutProfile {
        methods: in_table_range.then(|| method_ids_for_version(client_version)),
        // VehicleAppearance joins entities.xml in 14.5.0, pushing
        // InteractiveZone from 13 to 14.
        zone_entity_type: match version_key {
            Some(k) if k < (14, 5, 0) => 13,
            _ => 14,
        },
    };
    Ok(walk_frames(&inflated, ship_id_candidates, legacy, &profile))
}

/// `\"15,0,0,11791718\"` → `(15, 0, 0)`; malformed input yields `None`.
fn parse_version_key(v: &str) -> Option<(u32, u32, u32)> {
    let mut parts = v.split(',');
    let (Some(a), Some(b), Some(c)) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    Some((
        a.trim().parse().ok()?,
        b.trim().parse().ok()?,
        c.trim().parse().ok()?,
    ))
}

/// Blowfish-ECB decrypt with the WoWS key + XOR chain. Skips the first 8-byte
/// block (a replay-format marker the client writes). The XOR chain mixes each
/// decrypted plaintext block with the previous plaintext block (NOT ciphertext).
fn decrypt_stream(dirty: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = WowsBlowfish::new_from_slice(&WOWS_BLOWFISH_KEY)
        .map_err(|_| "invalid Blowfish key length".to_string())?;
    let mut out = Vec::with_capacity(dirty.len());
    let mut prev_plain: Option<i64> = None;
    let mut blocks = dirty.chunks_exact(8);
    // The first 8-byte block is a marker — skip it entirely.
    blocks.next();
    for chunk in blocks {
        let mut buf: [u8; 8] = [0; 8];
        buf.copy_from_slice(chunk);
        let mut block: Block<WowsBlowfish> = buf.into();
        cipher.decrypt_block(&mut block);
        let dec: [u8; 8] = block.into();
        // Interpret as a signed 64-bit little-endian (matching Monstrofil's
        // native-order `struct.unpack('q')` on x86) then XOR with previous plaintext.
        let mut v = i64::from_le_bytes(dec);
        if let Some(prev) = prev_plain {
            v ^= prev;
        }
        prev_plain = Some(v);
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(out)
}

/// zlib-decompress the decrypted stream.
fn inflate_zlib(decrypted: &[u8]) -> Result<Vec<u8>, String> {
    let mut dec = ZlibDecoder::new(decrypted);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| format!("zlib inflate: {e}"))?;
    Ok(out)
}

/// Map a legacy (<12.6.0) wire packet id to its modern-layout equivalent so the
/// frame loop can match against the modern constants. The modern layout inserts
/// `BattleResults` at 0x22 and `CameraMode` at 0x27, shifting every later id up;
/// legacy replays therefore carry no `BattleResults` and no `CameraMode`.
fn remap_legacy_packet_id(raw: u32) -> u32 {
    match raw {
        0x22 => PACKET_NESTED_PROPERTY,
        0x24 => PACKET_CAMERA,
        0x27 => PACKET_MAP,
        0x29 => PACKET_POSITION_AUX,
        0x2b => PACKET_PLAYER_POSITION,
        0x2e => PACKET_CAMERA_FREELOOK,
        0x2f => PACKET_SET_WEAPON_LOCK,
        0x30 => PACKET_SUB_CONTROLLER,
        0x31 => PACKET_CRUISE_STATE,
        0x32 => PACKET_SHOT_TRACKING,
        other => other,
    }
}

/// Walk `[u32 size][u32 type][f32 time][payload]` frames, collecting Position
/// samples (grouped by entity id) and EntityCreate metadata. Stops cleanly if a
/// frame header is truncated or declares an absurd size (trailing padding).
///
/// `legacy` selects the pre-12.6.0 packet-id layout (see [`remap_legacy_packet_id`]);
/// `profile` carries the per-version method ids and entity-type indices.
fn walk_frames(
    inflated: &[u8],
    ship_id_candidates: &std::collections::HashSet<u32>,
    legacy: bool,
    profile: &LayoutProfile,
) -> DecodedReplay {
    let mut positions: BTreeMap<i32, Vec<PositionSample>> = BTreeMap::new();
    let mut kinds: BTreeMap<i32, EntityKind> = BTreeMap::new();
    let mut destroys: BTreeMap<i32, f32> = BTreeMap::new();
    let mut properties: BTreeMap<i32, Vec<PropertyChange>> = BTreeMap::new();
    let mut methods: Vec<RawMethodCall> = Vec::new();
    let mut method_histogram: Vec<(f32, i32, i32, u32)> = Vec::new();
    let mut method_arg_samples: std::collections::BTreeMap<(i32, i32), Vec<Vec<u8>>> =
        std::collections::BTreeMap::new();
    let mut nested: Vec<RawNestedProperty> = Vec::new();
    let mut weapon_locks: Vec<wowsp_tauri_shared::WeaponLockEvent> = Vec::new();
    let mut battle_results: Option<String> = None;
    let mut version: Option<String> = None;
    let mut map_name: Option<String> = None;
    let mut camera: Vec<wowsp_tauri_shared::CameraSample> = Vec::new();
    let mut net_stats: Vec<wowsp_tauri_shared::NetStatsSample> = Vec::new();
    let mut leaves: BTreeMap<i32, f32> = BTreeMap::new();
    let mut camera_modes: Vec<wowsp_tauri_shared::HpSample> = Vec::new();
    let mut diagnostics = wowsp_tauri_shared::DiagnosticCounts::default();
    let mut squadron_creates: Vec<wowsp_tauri_shared::SquadronCreate> = Vec::new();
    let mut squadron_planes: Vec<wowsp_tauri_shared::SquadronPlane> = Vec::new();
    let mut minimap_squadron_adds: Vec<wowsp_tauri_shared::MinimapSquadronAdd> = Vec::new();
    let mut minimap_squadron_moves: Vec<wowsp_tauri_shared::MinimapSquadronMove> = Vec::new();
    let mut minimap_squadron_removes: Vec<wowsp_tauri_shared::MinimapSquadronRemove> = Vec::new();
    let mut cur = 0usize;
    while cur + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[cur..cur + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[cur + 4..cur + 8].try_into().unwrap());
        let time = f32::from_le_bytes(inflated[cur + 8..cur + 12].try_into().unwrap());
        let payload_end = cur + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        let payload = &inflated[cur + 12..payload_end];
        let logical_type = if legacy {
            remap_legacy_packet_id(ptype)
        } else {
            ptype
        };
        match logical_type {
            PACKET_POSITION => {
                if let Some(sample) = parse_position(payload, time) {
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            PACKET_PLAYER_POSITION | PACKET_PLAYER_POSITION_LEGACY | PACKET_POSITION_AUX => {
                if let Some(sample) = parse_player_position(payload, time) {
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            PACKET_ENTITY_CREATE => {
                if let Some(created) = parse_entity_create(payload, time, profile.zone_entity_type)
                {
                    let eid = created.entity_id;
                    let mut kind = created.clone_into_kind();
                    kind.ship_id = scan_state_for_ship_id(&payload[38..], ship_id_candidates);
                    // Entities destroyed and re-created mid-match (leaving and
                    // re-entering the observed area) keep their FIRST creation
                    // time so the frontend doesn't hide them until re-creation.
                    kinds.entry(eid).or_insert(kind);
                }
            },
            PACKET_CELL_PLAYER_CREATE => {
                if let Some(created) = parse_cell_player_create(payload, time) {
                    let eid = created.entity_id;
                    let mut kind = created.clone_into_kind();
                    kind.entity_type = ENTITY_TYPE_AVATAR;
                    kinds.entry(eid).or_insert(kind);
                }
            },
            PACKET_ENTITY_DESTROY => {
                if let Some(eid) = parse_entity_destroy(payload) {
                    destroys.insert(eid, time);
                }
            },
            PACKET_ENTITY_PROPERTY => {
                for change in parse_property(payload, time) {
                    properties.entry(change.entity_id).or_default().push(change);
                }
            },
            PACKET_ENTITY_METHOD => {
                if let Some(call) = parse_entity_method(payload, time) {
                    method_histogram.push((
                        call.time,
                        call.entity_id,
                        call.method_id,
                        call.args.len() as u32,
                    ));
                    let entry = method_arg_samples
                        .entry((call.entity_id, call.method_id))
                        .or_default();
                    if entry.len() < 6 {
                        entry.push(call.args[..call.args.len().min(24)].to_vec());
                    }
                    methods.push(call);
                }
            },
            PACKET_NESTED_PROPERTY => {
                if let Some(n) = parse_nested_property(payload, time) {
                    nested.push(n);
                }
            },
            PACKET_SET_WEAPON_LOCK => {
                if let Some(lock) = parse_weapon_lock(payload, time) {
                    weapon_locks.push(lock);
                }
            },
            PACKET_BATTLE_RESULTS => {
                if battle_results.is_none() {
                    battle_results = parse_battle_results(payload);
                }
            },
            PACKET_VERSION => {
                if version.is_none() {
                    version = parse_version(payload);
                }
            },
            PACKET_CAMERA => {
                if let Some(s) = parse_camera(payload, time) {
                    camera.push(s);
                }
            },
            PACKET_NET_STATS => {
                if let Some(s) = parse_net_stats(payload, time) {
                    net_stats.push(s);
                }
            },
            PACKET_MAP => {
                if map_name.is_none() {
                    map_name = parse_map_name(payload);
                }
            },
            PACKET_ENTITY_LEAVE => {
                if let Some(eid) = parse_entity_destroy(payload) {
                    leaves.insert(eid, time);
                }
            },
            PACKET_ENTITY_ENTER => {
                diagnostics.entity_enters += 1;
            },
            PACKET_SERVER_TICK => {
                diagnostics.server_ticks += 1;
            },
            PACKET_SERVER_TIMESTAMP => {
                diagnostics.server_timestamps += 1;
            },
            PACKET_INIT_FLAG => {
                diagnostics.init_flags += 1;
            },
            PACKET_INIT_MARKER => {
                diagnostics.init_markers += 1;
            },
            PACKET_BASE_PLAYER_CREATE => {
                diagnostics.base_player_creates += 1;
            },
            PACKET_BASE_PLAYER_CREATE_STUB => {
                diagnostics.create_stubs += 1;
            },
            PACKET_ENTITY_CONTROL => {
                diagnostics.entity_controls += 1;
            },
            PACKET_CAMERA_MODE => {
                if let Some(mode) = parse_camera_mode(payload, time) {
                    camera_modes.push(mode);
                    diagnostics.camera_modes += 1;
                }
            },
            PACKET_CAMERA_FREELOOK => {
                diagnostics.camera_freelooks += 1;
            },
            PACKET_SUB_CONTROLLER => {
                diagnostics.sub_controllers += 1;
            },
            PACKET_CRUISE_STATE => {
                diagnostics.cruise_states += 1;
            },
            PACKET_SHOT_TRACKING => {
                diagnostics.shot_trackings += 1;
            },
            PACKET_GUN_MARKER => {
                diagnostics.gun_markers += 1;
            },
            _ => {},
        }
        cur = payload_end;
    }
    // Capture-zone progress: nested-property payloads on InteractiveZone
    // entities (type index is version-dependent) carry the live capture
    // fraction as a trailing f32 (0..1). Keep only those, keyed by entity.
    let mut cap_progress: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> = BTreeMap::new();
    for n in &nested {
        if kinds.get(&n.entity_id).map(|k| k.entity_type) != Some(profile.zone_entity_type) {
            continue;
        }
        if n.payload.len() >= 4 {
            let f = f32::from_le_bytes(n.payload[n.payload.len() - 4..].try_into().unwrap());
            if f.is_finite() && (0.0..=1.5).contains(&f) {
                cap_progress
                    .entry(n.entity_id)
                    .or_default()
                    .push(wowsp_tauri_shared::HpSample {
                        time: n.time,
                        value: (f * 1000.0).round() as u32,
                    });
            }
        }
    }
    for samples in cap_progress.values_mut() {
        samples.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    // Resolve method calls into events once the entity types are known: the
    // method ids live in per-entity-type exposed-index tables (version-drifting,
    // see `method_tables`), and only the avatar entity (type 1) carries the
    // battle-effect broadcast methods.
    let mut shell_launches: Vec<wowsp_tauri_shared::ShellLaunchEvent> = Vec::new();
    let mut explosions: Vec<wowsp_tauri_shared::ExplosionEvent> = Vec::new();
    let mut torpedoes: Vec<wowsp_tauri_shared::TorpedoLaunch> = Vec::new();
    let mut torpedo_steers: Vec<wowsp_tauri_shared::TorpedoSteer> = Vec::new();
    for call in &methods {
        let entity_type = kinds.get(&call.entity_id).map(|k| k.entity_type);
        let Some(m) = profile.methods else {
            break;
        };
        if entity_type != Some(ENTITY_TYPE_AVATAR) {
            continue;
        }
        if call.method_id == m.avatar_receive_artillery_shots {
            shell_launches.extend(decode_artillery_shots(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_torpedoes {
            torpedoes.extend(decode_torpedo_salvos(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_explosions {
            explosions.extend(decode_explosions(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_torpedo_direction {
            torpedo_steers.extend(decode_torpedo_directions(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_add_squadron {
            if let Some(s) = decode_squadron_add(call.time, &call.args) {
                squadron_creates.push(s);
            }
        } else if call.method_id == m.avatar_receive_update_squadron {
            squadron_planes.extend(decode_squadron_update(call.time, &call.args));
        } else if call.method_id == m.avatar_receive_add_minimap_squadron {
            if let Some(s) = decode_minimap_squadron_add(call.time, &call.args) {
                minimap_squadron_adds.push(s);
            }
        } else if call.method_id == m.avatar_receive_update_minimap_squadron {
            if let Some(s) = decode_minimap_squadron_move(call.time, &call.args) {
                minimap_squadron_moves.push(s);
            }
        } else if call.method_id == m.avatar_receive_remove_minimap_squadron
            && args_is_plane_id(&call.args)
        {
            minimap_squadron_removes.push(wowsp_tauri_shared::MinimapSquadronRemove {
                time: call.time,
                plane_id: u64::from_le_bytes(call.args[0..8].try_into().unwrap()),
            });
        }
    }
    for samples in positions.values_mut() {
        samples.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    for changes in properties.values_mut() {
        changes.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    DecodedReplay {
        positions,
        kinds,
        destroys,
        properties,
        shell_launches,
        explosions,
        torpedoes,
        torpedo_steers,
        cap_progress,
        weapon_locks,
        battle_results,
        method_histogram,
        method_arg_samples,
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
    }
}

/// Decode `receive_addSquadron` args (15.x `SQUADRON_STATE` layout):
/// u32 paramsID, u8 totalNumPlanes, then the squadron state fixed dict —
/// i64 planeID, u32 skinID, u8 isActive, u8 numPlanes, f32×3 position, ... —
/// then i64 parentID, u32 maxHealth, f32 squadronHealthPart, u64 planeHealth.
/// Only the head fields (through the position) are decoded.
fn decode_squadron_add(time: f32, args: &[u8]) -> Option<wowsp_tauri_shared::SquadronCreate> {
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
fn decode_minimap_squadron_add(
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
fn decode_minimap_squadron_move(
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

/// The owning carrier's vehicle entity id: low 32 bits of the composite
/// squadron id (bit layout from the reference `unpack_plane_id`:
/// [owner 32 | index 3 | purpose 3 | departures 1]).
fn plane_owner_id(plane_id: u64) -> i32 {
    (plane_id & 0xFFFF_FFFF) as u32 as i32
}

/// `receive_removeMinimapSquadron` guards its read with a length check.
fn args_is_plane_id(args: &[u8]) -> bool {
    args.len() == 8
}

/// Decode `receiveArtilleryShots` args (per the `SHOTS_PACK` alias): a u8
/// count of packs, each `{u32 paramsID, i32 ownerID, i32 salvoID, u8 shots[],
/// SHOT}` where `SHOT` is `{VECTOR3 pos, f32 pitch, f32 speed, VECTOR3 tarPos,
/// u16 shotID, u16 gunBarrelID, f32 serverTimeLeft, f32 shooterHeight,
/// f32 hitDistance}` — 48 bytes.
fn decode_artillery_shots(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::ShellLaunchEvent> {
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
        let params_id = u32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let owner_id = i32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap());
        let salvo_id = i32::from_le_bytes(args[off + 8..off + 12].try_into().unwrap());
        let shots = args[off + 12] as usize;
        off += 13;
        for _ in 0..shots {
            if off + 48 > args.len() {
                break 'packs;
            }
            let f = |o: usize| f32::from_le_bytes(args[o..o + 4].try_into().unwrap());
            out.push(wowsp_tauri_shared::ShellLaunchEvent {
                time,
                owner_id,
                params_id,
                salvo_id,
                shot_id: u16::from_le_bytes(args[off + 32..off + 34].try_into().unwrap()),
                x: f(off),
                y: f(off + 4),
                z: f(off + 8),
                target_x: f(off + 20),
                target_y: f(off + 24),
                target_z: f(off + 28),
                server_time_left: f(off + 36),
                speed: f(off + 16),
                gun_barrel_id: u16::from_le_bytes(args[off + 34..off + 36].try_into().unwrap()),
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
fn decode_torpedo_salvos(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::TorpedoLaunch> {
    let mut out = Vec::new();
    let Some(&packs) = args.first() else {
        return out;
    };
    let mut off = 1usize;
    'packs: for _ in 0..packs {
        if off + 17 > args.len() {
            break;
        }
        let params_id = u32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let owner_id = i32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap());
        let salvo_id = i32::from_le_bytes(args[off + 8..off + 12].try_into().unwrap());
        let count = args[off + 16] as usize;
        off += 17;
        for _ in 0..count {
            // Fixed part (pos + dir + shotID + armed) is 27 bytes; the two
            // nullable-dump flag bytes follow, so 29 bytes must remain.
            if off + 29 > args.len() {
                break 'packs;
            }
            let f = |o: usize| f32::from_le_bytes(args[o..o + 4].try_into().unwrap());
            let shot_id = u16::from_le_bytes(args[off + 24..off + 26].try_into().unwrap());
            let armed = args[off + 26] != 0;
            out.push(wowsp_tauri_shared::TorpedoLaunch {
                time,
                owner_id,
                params_id,
                salvo_id,
                shot_id,
                x: f(off),
                y: f(off + 4),
                z: f(off + 8),
                dir_x: f(off + 12),
                dir_y: f(off + 16),
                dir_z: f(off + 20),
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
fn decode_torpedo_directions(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::TorpedoSteer> {
    let mut out = Vec::new();
    if args.len() < 22 {
        return out;
    }
    let owner_id = i32::from_le_bytes(args[0..4].try_into().unwrap());
    let shot_id = u16::from_le_bytes(args[4..6].try_into().unwrap());
    let f = |o: usize| f32::from_le_bytes(args[o..o + 4].try_into().unwrap());
    out.push(wowsp_tauri_shared::TorpedoSteer {
        time,
        owner_id,
        shot_id,
        x: f(6),
        y: f(10),
        z: f(14),
        target_yaw: f(18),
    });
    out
}

/// Decode `receive_updateSquadron` args: u64 planeId, f32 dt, u8 count,
/// then count × {f32×3 position, f32 yaw, u16 time, u8 type, i8 pitch}.
fn decode_squadron_update(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::SquadronPlane> {
    let mut out = Vec::new();
    if args.len() < 13 {
        return out;
    }
    let plane_id = u64::from_le_bytes(args[0..8].try_into().unwrap());
    let count = args[12] as usize;
    let mut off = 13usize;
    for index in 0..count {
        if off + 20 > args.len() {
            break;
        }
        let x = f32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let y = f32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap());
        let z = f32::from_le_bytes(args[off + 8..off + 12].try_into().unwrap());
        let yaw = f32::from_le_bytes(args[off + 12..off + 16].try_into().unwrap());
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

/// Parse a Version (0x16) payload: u32 length + UTF-8 string.
fn parse_version(payload: &[u8]) -> Option<String> {
    if payload.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes(payload[0..4].try_into().ok()?) as usize;
    let body = payload.get(4..4 + len.min(payload.len() - 4))?;
    String::from_utf8(body.to_vec()).ok()
}

/// Parse a Camera (0x25) payload: quaternion (4×f32), camera position (3×f32),
/// fov (f32), [unknown f32 when ≥60 bytes], position (3×f32), direction (3×f32).
fn parse_camera(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::CameraSample> {
    if payload.len() < 56 {
        return None;
    }
    let f = |o: usize| f32::from_le_bytes(payload[o..o + 4].try_into().unwrap());
    Some(wowsp_tauri_shared::CameraSample {
        time,
        rot_x: f(0),
        rot_y: f(4),
        rot_z: f(8),
        rot_w: f(12),
        x: f(16),
        y: f(20),
        z: f(24),
        fov: f(28),
    })
}

/// Parse a PlayerNetStats (0x1d) payload: one packed u32 (fps 8b | ping 16b |
/// isLagging 1b).
fn parse_net_stats(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::NetStatsSample> {
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
fn parse_map_name(payload: &[u8]) -> Option<String> {
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
fn parse_camera_mode(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::HpSample> {
    if payload.len() < 4 {
        return None;
    }
    Some(wowsp_tauri_shared::HpSample {
        time,
        value: u32::from_le_bytes(payload[0..4].try_into().ok()?),
    })
}

/// Parse a NestedPropertyUpdate (0x23) payload: `i32 entity_id, u8 is_slice,
/// u32 payload_size, payload`. The payload blob (BigWorld nested property
/// encoding) is kept raw; capture progress is read from its tail.
fn parse_nested_property(payload: &[u8], time: f32) -> Option<RawNestedProperty> {
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

/// Parse a SetWeaponLock (0x30) payload: three u32s (weapon_type, lock_type,
/// target_id).
fn parse_weapon_lock(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::WeaponLockEvent> {
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
fn parse_battle_results(payload: &[u8]) -> Option<String> {
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
fn parse_cell_player_create(payload: &[u8], time: f32) -> Option<ParsedCreate> {
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
fn parse_entity_method(payload: &[u8], time: f32) -> Option<RawMethodCall> {
    if payload.len() < 12 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let method_id = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    let args_len = u32::from_le_bytes(payload[8..12].try_into().ok()?) as usize;
    let args = payload
        .get(12..12 + args_len.min(payload.len() - 12))?
        .to_vec();
    Some(RawMethodCall {
        time,
        entity_id,
        method_id,
        args,
    })
}

/// Decode `receiveExplosions` args: `u8 count` × {f32×3 position, u32
/// paramsID, u8 hitType}. Returns one event per impact point.
fn decode_explosions(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::ExplosionEvent> {
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
        let x = f32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let y = f32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap());
        let z = f32::from_le_bytes(args[off + 8..off + 12].try_into().unwrap());
        let params_id = u32::from_le_bytes(args[off + 12..off + 16].try_into().unwrap());
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

/// Parsed EntityCreate used internally to key the kinds map; converted to
/// [`EntityKind`] before insertion. Carries the entity id separately.
struct ParsedCreate {
    entity_id: i32,
    entity_type: i16,
    vehicle_id: i32,
    x: f32,
    y: f32,
    z: f32,
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
    fn clone_into_kind(self) -> EntityKind {
        EntityKind {
            entity_type: self.entity_type,
            vehicle_id: self.vehicle_id,
            initial_x: self.x,
            initial_y: self.y,
            initial_z: self.z,
            creation_time: self.creation_time,
            ship_id: None,
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
///   `0a 01 b0 c7 e5 ff ff ff ff ff 01 00 <index>`
///
/// (property 10 present, buoyVisualId constant 0xffe5c7b0, nextControlPoint
/// -1, ControlPointType 1 = Control, empty timer name, 0-based point index).
/// Strike/event zones keep componentsState empty (`0a 00`) and never match.
/// Verified byte-identical across domination, PvE, and brawl modes.
fn scan_state_for_control_point(state: &[u8]) -> Option<i32> {
    const SIG: [u8; 11] = [
        0x0a, 0x01, 0xb0, 0xc7, 0xe5, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ];
    state
        .windows(SIG.len() + 2)
        .position(|w| w[..SIG.len()] == SIG)
        .map(|i| state[i + SIG.len() + 1] as i32)
}

/// Scan an EntityCreate state stream for any roster shipId (u32 LE, sliding
/// 4-byte window). The state blob packs the entity's initial property values;
/// one of them is the ship's GameParams id (observed at offsets ~160-260
/// depending on game version and variable-length fields before it). Returns
/// the first candidate found; empirically each ship entity embeds exactly one.
fn scan_state_for_ship_id(
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
    None
}

/// Scan an EntityCreate state stream for the capture-zone radius: a f32 with
/// an integral value in the 20..700 m range. Empirically the radius is the
/// LAST such field (observed at offset ~98 on domination, ~94 on two-brothers
/// domination, ~18 on the 1v1 brawl layout) and every mode's state packs it
/// as a trailing plain float, so the highest-offset candidate wins. Note the
/// range: classic points are 20..150 m but modern domination points carry
/// ~490 m rings ("Zone_in_port_ally"), so the scan must not cap at 150.
fn scan_state_for_radius(state: &[u8]) -> Option<f32> {
    if state.len() < 4 {
        return None;
    }
    let mut best: Option<(usize, f32)> = None;
    for off in 0..=state.len() - 4 {
        let f = f32::from_le_bytes(state[off..off + 4].try_into().ok()?);
        if f.is_finite() && (20.0..=700.0).contains(&f) && (f - f.round()).abs() < 0.01 {
            best = Some((off, f));
        }
    }
    best.map(|(_, f)| f)
}

/// Parse an EntityCreate (0x05) payload. WoWS layout (from
/// `clients/wows/network/packets/EntityCreate.py`):
///   i32 entity_id, i16 type, i32 vehicle_id, i32 space_id,
///   f32×3 position, f32×3 direction, [BinaryStream state — skipped]
///
/// `zone_entity_type` is the version-dependent InteractiveZone index (13
/// before 14.5.0, 14 after) — only zone entities get the radius / control
/// point / team state scans.
fn parse_entity_create(payload: &[u8], time: f32, zone_entity_type: i16) -> Option<ParsedCreate> {
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
fn parse_entity_destroy(payload: &[u8]) -> Option<i32> {
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
fn parse_property(payload: &[u8], time: f32) -> Vec<PropertyChange> {
    let mut out = Vec::new();
    if payload.len() < 12 {
        return out;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().unwrap_or([0; 4]));
    let mut off = 4usize;
    while off + 8 <= payload.len() {
        let property_index = u32::from_le_bytes(payload[off..off + 4].try_into().unwrap());
        let value_size = u32::from_le_bytes(payload[off + 4..off + 8].try_into().unwrap()) as usize;
        if value_size > 8 || off + 8 + value_size > payload.len() {
            break;
        }
        let value_bytes = &payload[off + 8..off + 8 + value_size];
        let value = match value_size {
            1 => value_bytes[0] as u32,
            2 => u16::from_le_bytes(value_bytes.try_into().unwrap()) as u32,
            4 => u32::from_le_bytes(value_bytes.try_into().unwrap()),
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
fn parse_player_position(payload: &[u8], time: f32) -> Option<PositionSample> {
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
fn parse_position(payload: &[u8], time: f32) -> Option<PositionSample> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes[cur..cur + bl])
                {
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
            "[m3+entity+destroy] version={:?} {} position samples across {} entities; {} EntityCreates ({} type=2 ships); {} destroyed; {} shell launches; {} torpedoes; {} explosions; {} minimap squadron adds",
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
                                let val =
                                    u32::from_le_bytes(state[off..off + 4].try_into().unwrap());
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

    /// receiveTorpedoDirection: fixed 38-byte layout decodes owner/shot/pos.
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
}
