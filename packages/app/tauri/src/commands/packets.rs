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
/// Vehicle entity type id (spec index 2) — ships. Its method table carries
/// the per-vehicle client events (consumable uses, E11).
const ENTITY_TYPE_VEHICLE: i16 = 2;
/// SmokeScreen entity type id (spec index 4 in the ClientServerEntities
/// order, confirmed against the 15.8.0 `entities.xml`). Smoke clouds are real
/// entities: created when emission starts and despawned on dissipation.
const ENTITY_TYPE_SMOKE_SCREEN: i16 = 4;
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
/// CruiseState (0x32): the recorder's own discrete control presets —
/// `u32 controller, i32 level` (8-byte payload; see [`parse_cruise_state`]
/// and [`wowsp_tauri_shared::CruiseSample`] for the reverse-engineered
/// semantics). Legacy (<12.6.0) wire id is 0x31 via [`remap_legacy_packet_id`].
const PACKET_CRUISE_STATE: u32 = 0x32;
const PACKET_SHOT_TRACKING: u32 = 0x33;
const PACKET_GUN_MARKER: u32 = 0x18;
/// Packet type for entity method calls (0x08). Battle events that have no
/// dedicated entity (artillery salvos, torpedo spreads, squadron markers)
/// arrive here as client-method calls on the avatar (the recorder's own
/// entity). Method ids are per-version exposed indices — resolved through
/// [`method_ids_for_version`], never hardcoded.
const PACKET_ENTITY_METHOD: u32 = 0x08;

/// Experiment E11 method ids (see [`E11MethodIds`]): resolved per version.
fn e11_method_ids(version_key: Option<(u32, u32, u32)>) -> Option<E11MethodIds> {
    match version_key {
        // Pinned against the 15.8.0 exposed tables (E10: def build 13187581,
        // wire-validated on the reference capture). Promoting these into the
        // generated `method_tables` (and its generator) is a follow-up that
        // touches frozen files; until then other versions decode nothing.
        Some((15, 8, _)) => Some(E11MethodIds {
            avatar_update_minimap_vision_info: 155,
            vehicle_on_consumable_used: 72,
        }),
        _ => None,
    }
}

/// Experiment E11 method ids for the G1 candidate events that are not yet in
/// the generated [`MethodIds`] tables: the avatar's minimap vision stream and
/// the vehicle consumable-use stream. The engine-state projection needs no
/// method ids (properties are index-addressed) but shares the same 15.8.0
/// pin, so it rides on this being `Some`.
#[derive(Debug, Clone, Copy)]
struct E11MethodIds {
    avatar_update_minimap_vision_info: i32,
    vehicle_on_consumable_used: i32,
}

/// Version-dependent decoder inputs resolved once per replay: the method-id
/// table and the InteractiveZone entity-type index (13 before 14.5.0, 14 after
/// — `VehicleAppearance` was inserted into `entities.xml` ahead of it).
struct LayoutProfile {
    /// `None` when the replay predates every shipped table (pre-0.11.6): the
    /// exposed indices can't be trusted, so battle-effect decoding is disabled
    /// rather than risk plausible-looking garbage.
    methods: Option<&'static MethodIds>,
    zone_entity_type: i16,
    /// receive_wardAdded carries a trailing `wardType` byte from 13.2.0 on.
    ward_has_type: bool,
    /// SHOTKILL entries carry a nullable TERMINAL_BALLISTICS_INFO from 12.7.0
    /// on (flag byte; 29 bytes when present).
    shotkill_has_ballistics: bool,
    /// E11 experimental decoders (minimap vision, consumable uses, engine
    /// state projection) — only for versions whose ids/indices are pinned.
    e11: Option<E11MethodIds>,
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
    /// Fighter-patrol wards (avatar receive_wardAdded / receive_wardRemoved).
    pub wards: Vec<wowsp_tauri_shared::WardEvent>,
    pub ward_removes: Vec<wowsp_tauri_shared::WardRemoveEvent>,
    /// Projectile kills (avatar receiveShotKills) — terminal impact points.
    pub shot_kills: Vec<wowsp_tauri_shared::ShotKillEvent>,
    /// Cumulative damage stats (avatar receiveDamageStat) — the server's
    /// authoritative per-weapon totals for the recorder, incl. aircraft
    /// weapons. Empty on versions whose exposed method id isn't pinned.
    pub damage_stats: Vec<wowsp_tauri_shared::DamageStatSample>,
    /// Recorder control-input timeline (CruiseState, 0x32) — engine telegraph
    /// and rudder presets (experiment E2). Recorder-scoped, like `camera`.
    pub cruise: Vec<wowsp_tauri_shared::CruiseSample>,
    /// Smoke-screen lifecycles (entityType 4 entities, experiment E8):
    /// creation time/position plus radius / height walked out of the create
    /// state, with the observed dissipation time filled in from the entity's
    /// leave/destroy. Empty on streams without smoke.
    pub smoke_screens: Vec<wowsp_tauri_shared::SmokeScreenEvent>,
    /// Entity id of the recorder's own vehicle — recovered from the avatar's
    /// PlayerPosition (0x2c) packets: a subset of them link the avatar entity
    /// (created by CellPlayerCreate) to the vehicle it occupies. `None` when
    /// no link was seen.
    pub recorder_vehicle: Option<i32>,
    /// Minimap vision updates (avatar `updateMinimapVisionInfo`, experiment
    /// E11): the explicit spot/unspot stream — one entry per vehicle whose
    /// minimap marker state changed. Empty on versions without a pinned id.
    #[allow(dead_code)]
    pub vision_events: Vec<wowsp_tauri_shared::VisionEvent>,
    /// Consumable activations (Vehicle `onConsumableUsed`, experiment E11) on
    /// every vehicle the client observed, both teams. Empty on versions
    /// without a pinned id.
    #[allow(dead_code)]
    pub consumable_uses: Vec<wowsp_tauri_shared::ConsumableUseEvent>,
    /// Per-vehicle engine-state changes (enginePower idx 9 / engineDir idx 10
    /// properties on type-2 entities, experiment E11). Empty on versions
    /// without the pinned property indices.
    #[allow(dead_code)]
    pub engine_states: Vec<wowsp_tauri_shared::EngineStateSample>,
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
    if client_version.is_some() && version_key.is_none() {
        // A present-but-unparseable version would silently flip every
        // version-gated layout — surface it instead.
        tracing::warn!(
            "unparseable clientVersionFromExe {:?}; assuming modern layout",
            client_version
        );
    }
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
        ward_has_type: version_key.map(|k| k >= (13, 2, 0)).unwrap_or(true),
        shotkill_has_ballistics: version_key.map(|k| k >= (12, 7, 0)).unwrap_or(true),
        e11: e11_method_ids(version_key),
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

/// Copy `N` bytes out of `data` starting at `off` without panicking on a
/// truncated slice. Every caller length-guards ahead of use, so `None` replaces
/// the previously hardcoded panic on the (unreachable) short-slice case while
/// keeping the decoders total on malformed input (skip the item / stop the
/// walk, as each site dictates).
fn read_bytes<const N: usize>(data: &[u8], off: usize) -> Option<[u8; N]> {
    data.get(off..off + N).and_then(|s| s.try_into().ok())
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
    let mut wards: Vec<wowsp_tauri_shared::WardEvent> = Vec::new();
    let mut ward_removes: Vec<wowsp_tauri_shared::WardRemoveEvent> = Vec::new();
    let mut shot_kills: Vec<wowsp_tauri_shared::ShotKillEvent> = Vec::new();
    let mut damage_stats: Vec<wowsp_tauri_shared::DamageStatSample> = Vec::new();
    let mut cruise: Vec<wowsp_tauri_shared::CruiseSample> = Vec::new();
    let mut vision_events: Vec<wowsp_tauri_shared::VisionEvent> = Vec::new();
    let mut consumable_uses: Vec<wowsp_tauri_shared::ConsumableUseEvent> = Vec::new();
    // SmokeScreen entities keyed by id while their lifecycle is assembled;
    // converted to the sorted event list after the walk (the dissipation end
    // only becomes known when the leave/destroy packet arrives later).
    let mut smokes: BTreeMap<i32, wowsp_tauri_shared::SmokeScreenEvent> = BTreeMap::new();
    // The recorder's avatar (CellPlayerCreate) and, once its 0x2c stream
    // links to the occupied vehicle, the recorder's own ship entity id.
    let mut avatar_id: Option<i32> = None;
    let mut recorder_vehicle: Option<i32> = None;
    let mut cur = 0usize;
    while cur + 12 <= inflated.len() {
        let Some(size) = read_bytes(inflated, cur)
            .map(u32::from_le_bytes)
            .map(|v| v as usize)
        else {
            break;
        };
        let Some(ptype) = read_bytes(inflated, cur + 4).map(u32::from_le_bytes) else {
            break;
        };
        let Some(time) = read_bytes(inflated, cur + 8).map(f32::from_le_bytes) else {
            break;
        };
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
            // 0x2b needs no arm: the legacy remap already maps it onto
            // PACKET_PLAYER_POSITION, and modern clients never emit it.
            PACKET_PLAYER_POSITION | PACKET_POSITION_AUX => {
                if let Some(sample) = parse_player_position(payload, time) {
                    // The avatar's own 0x2c stream occasionally links to the
                    // vehicle it occupies (linked != 0) — the only
                    // deterministic recorder-vehicle join in the stream.
                    // Only 0x2c is trusted for it: the 0x2a aux stream also
                    // carries the avatar (spectate/aircraft following) and
                    // its links were not verified.
                    if ptype == PACKET_PLAYER_POSITION
                        && recorder_vehicle.is_none()
                        && Some(sample.entity_id) == avatar_id
                        && sample.vehicle_id != 0
                    {
                        recorder_vehicle = Some(sample.vehicle_id);
                    }
                    positions.entry(sample.entity_id).or_default().push(sample);
                }
            },
            PACKET_ENTITY_CREATE => {
                if let Some(created) = parse_entity_create(payload, time, profile.zone_entity_type)
                {
                    let eid = created.entity_id;
                    let entity_type = created.entity_type;
                    let (x, y, z) = (created.x, created.y, created.z);
                    let mut kind = created.clone_into_kind();
                    kind.ship_id = scan_state_for_ship_id(&payload[38..], ship_id_candidates);
                    // Smoke screens: walk the create state for the radius /
                    // height properties (experiment E8). Only the event list
                    // consumes them — the kind stays a plain entity so the
                    // frontend's smoke rendering is untouched.
                    if entity_type == ENTITY_TYPE_SMOKE_SCREEN {
                        let (radius, height) = parse_smoke_state(&payload[38..]);
                        smokes
                            .entry(eid)
                            .or_insert(wowsp_tauri_shared::SmokeScreenEvent {
                                time,
                                entity_id: eid,
                                x,
                                y,
                                z,
                                radius,
                                height,
                                end_time: None,
                            });
                    }
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
                    if avatar_id.is_none() {
                        avatar_id = Some(eid);
                    }
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
                if let Some(sample) = parse_cruise_state(payload, time) {
                    cruise.push(sample);
                }
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
            let Some(f) = read_bytes(&n.payload, n.payload.len() - 4).map(f32::from_le_bytes)
            else {
                continue;
            };
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
            // Vehicle-side method streams (E11): consumable uses fire on
            // type-2 entities against the Vehicle exposed-id table.
            if entity_type == Some(ENTITY_TYPE_VEHICLE)
                && profile
                    .e11
                    .is_some_and(|e| e.vehicle_on_consumable_used == call.method_id)
            {
                if let Some(event) = decode_consumable_used(call.time, call.entity_id, &call.args) {
                    consumable_uses.push(event);
                }
            }
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
            let Some(plane_id) = read_bytes(&call.args, 0).map(u64::from_le_bytes) else {
                continue;
            };
            minimap_squadron_removes.push(wowsp_tauri_shared::MinimapSquadronRemove {
                time: call.time,
                plane_id,
            });
        } else if call.method_id == m.avatar_receive_ward_added {
            if let Some(w) = decode_ward_added(call.time, &call.args, profile.ward_has_type) {
                wards.push(w);
            }
        } else if call.method_id == m.avatar_receive_ward_removed && args_is_plane_id(&call.args) {
            let Some(plane_id) = read_bytes(&call.args, 0).map(u64::from_le_bytes) else {
                continue;
            };
            ward_removes.push(wowsp_tauri_shared::WardRemoveEvent {
                time: call.time,
                plane_id,
            });
        } else if call.method_id == m.avatar_receive_shot_kills {
            shot_kills.extend(decode_shot_kills(
                call.time,
                &call.args,
                profile.shotkill_has_ballistics,
            ));
        } else if m.avatar_receive_damage_stat == Some(call.method_id) {
            damage_stats.extend(decode_damage_stat(call.time, &call.args));
        } else if profile
            .e11
            .is_some_and(|e| e.avatar_update_minimap_vision_info == call.method_id)
        {
            vision_events.extend(decode_minimap_vision(call.time, &call.args));
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
    cruise.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Finish the smoke lifecycles: the observed dissipation end. A destroy is
    // authoritative; otherwise the entity's leave time (the last one recorded
    // — the map is overwritten per packet) is the despawn the server sent when
    // the final puff faded.
    let mut smoke_screens: Vec<wowsp_tauri_shared::SmokeScreenEvent> =
        smokes.into_values().collect();
    for s in &mut smoke_screens {
        s.end_time = destroys
            .get(&s.entity_id)
            .copied()
            .or_else(|| leaves.get(&s.entity_id).copied());
    }
    smoke_screens.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Engine-state projection (experiment E11): enginePower (idx 9, UINT8) and
    // engineDir (idx 10, INT8) ALL_CLIENTS properties on Vehicle entities.
    // The raw property stream is already collected; this filters it to the
    // pinned indices on type-2 entities only. The indices were pinned against
    // the 15.8.0 Vehicle.def (E8) — other versions' property sorts are
    // unverified, so the projection rides the E11 version gate.
    let mut engine_states: Vec<wowsp_tauri_shared::EngineStateSample> = Vec::new();
    if profile.e11.is_some() {
        for (eid, changes) in &properties {
            if kinds.get(eid).map(|k| k.entity_type) != Some(ENTITY_TYPE_VEHICLE) {
                continue;
            }
            for c in changes {
                if c.size != 1 {
                    continue;
                }
                let sample = match c.property_index {
                    9 => wowsp_tauri_shared::EngineStateSample {
                        time: c.time,
                        entity_id: *eid,
                        power: Some(c.value as u8),
                        dir: None,
                    },
                    10 => wowsp_tauri_shared::EngineStateSample {
                        time: c.time,
                        entity_id: *eid,
                        power: None,
                        dir: Some(c.value as u8 as i8),
                    },
                    _ => continue,
                };
                engine_states.push(sample);
            }
        }
        engine_states.sort_by(|a, b| {
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
        wards,
        ward_removes,
        shot_kills,
        damage_stats,
        cruise,
        recorder_vehicle,
        smoke_screens,
        vision_events,
        consumable_uses,
        engine_states,
    }
}

/// Decode `receive_addSquadron` args: u32 paramsID, u8 totalNumPlanes, then
/// the `SQUADRON_STATE` fixed dict — i64 planeID, u32 skinID, u8 isActive,
/// u8 numPlanes, f32×3 position, ... — then i64 parentID, u32 maxHealth,
/// f32 squadronHealthPart, u64 planeHealth. Only the head fields through
/// `position` are decoded; they are byte-identical across every shipped
/// definition (0.11.6–15.7.0 — later versions append tail fields after
/// `position`), so the fixed offsets are safe without version gating.
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

/// Decode `receive_wardAdded` args: `i64 squadronId, VECTOR3 position,
/// f32 time, f32 radius, i8 teamId, u64 ownerId` (+ trailing `u8 wardType`
/// from 13.2.0 — `ward_has_type`). The reference treats a zero radius as the
/// default 60 m patrol ring; we keep the raw value and let the caller decide.
fn decode_ward_added(
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
fn decode_shot_kills(
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

/// A value from a narrow pickle-proto-2 subset — exactly the shapes the
/// `receiveDamageStat` payload uses (dict of `(i64, i64)` keys to
/// `[i64, f64]` lists). Anything outside the subset aborts the parse.
#[derive(Debug, Clone, PartialEq)]
enum PyVal {
    None,
    Int(i64),
    Float(f64),
    Tuple(Vec<PyVal>),
    List(Vec<PyVal>),
    Dict(Vec<(PyVal, PyVal)>),
}

/// Evaluate a pickle-proto-2 bytecode subset (see [`PyVal`]): a tiny stack
/// machine with the CPython metastack MARK semantics. Returns the single
/// top-level value, or `None` on truncated/unsupported opcodes (the caller
/// then just leaves that sample set empty — damage stats are an enhancement,
/// never a hard requirement).
fn parse_pickle(bytes: &[u8]) -> Option<PyVal> {
    let mut stack: Vec<PyVal> = Vec::new();
    let mut metastack: Vec<Vec<PyVal>> = Vec::new();
    let mut memo: Vec<PyVal> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let op = bytes[i];
        i += 1;
        match op {
            0x80 => i += 1,                                     // PROTO (version byte)
            0x28 => metastack.push(std::mem::take(&mut stack)), // MARK '('
            0x4e => stack.push(PyVal::None),                    // NONE 'N'
            0x4b => {
                // BININT1 'K' — u8
                stack.push(PyVal::Int(*bytes.get(i)? as i64));
                i += 1;
            },
            0x4d => {
                // BININT2 'M' — u16 LE
                stack.push(PyVal::Int(u16::from_le_bytes(read_bytes(bytes, i)?) as i64));
                i += 2;
            },
            0x4a => {
                // BININT 'J' — i32 LE
                stack.push(PyVal::Int(i32::from_le_bytes(read_bytes(bytes, i)?) as i64));
                i += 4;
            },
            0x8a => {
                // LONG1 — 1-byte length + little-endian two's-complement payload.
                // Payloads beyond i64 width are outside the supported subset.
                let n = *bytes.get(i)? as usize;
                i += 1;
                if n > 8 {
                    return None;
                }
                let raw = bytes.get(i..i + n)?;
                i += n;
                let mut v: i64 = 0;
                for (k, b) in raw.iter().enumerate() {
                    v |= (*b as i64) << (8 * k);
                }
                // Sign-extend from the last payload byte (n == 8 needs none).
                if n > 0 && n < 8 {
                    let shift = 64 - 8 * n;
                    v = (v << shift) >> shift;
                }
                stack.push(PyVal::Int(v));
            },
            0x47 => {
                // BINFLOAT 'G' — f64 BIG-endian (the pickle spec's one big-endian field)
                stack.push(PyVal::Float(f64::from_be_bytes(read_bytes(bytes, i)?)));
                i += 8;
            },
            0x86 => {
                // TUPLE2
                let b = stack.pop()?;
                let a = stack.pop()?;
                stack.push(PyVal::Tuple(vec![a, b]));
            },
            0x74 => {
                // TUPLE 't' — everything back to the mark
                let items = pop_mark(&mut stack, &mut metastack)?;
                stack.push(PyVal::Tuple(items));
            },
            0x5d => stack.push(PyVal::List(Vec::new())), // EMPTY_LIST ']'
            0x7d => stack.push(PyVal::Dict(Vec::new())), // EMPTY_DICT '}'
            0x6c => {
                // LIST 'l' — everything back to the mark
                let items = pop_mark(&mut stack, &mut metastack)?;
                stack.push(PyVal::List(items));
            },
            0x61 => {
                // APPEND 'a'
                let v = stack.pop()?;
                match stack.last_mut()? {
                    PyVal::List(l) => l.push(v),
                    _ => return None,
                }
            },
            0x65 => {
                // APPENDS 'e' — items back to the mark, into the list below them
                let items = pop_mark(&mut stack, &mut metastack)?;
                match stack.last_mut()? {
                    PyVal::List(l) => l.extend(items),
                    _ => return None,
                }
            },
            0x73 => {
                // SETITEM 's' — value + key into the dict below them
                let value = stack.pop()?;
                let key = stack.pop()?;
                match stack.last_mut()? {
                    PyVal::Dict(d) => d.push((key, value)),
                    _ => return None,
                }
            },
            0x75 => {
                // SETITEMS 'u' — pairs back to the mark, into the dict below them
                let items = pop_mark(&mut stack, &mut metastack)?;
                if items.len() % 2 != 0 {
                    return None;
                }
                match stack.last_mut()? {
                    PyVal::Dict(d) => {
                        for pair in items.chunks_exact(2) {
                            d.push((pair[0].clone(), pair[1].clone()));
                        }
                    },
                    _ => return None,
                }
            },
            0x71 => {
                // BINPUT 'q' — memoize the top of stack (1-byte index)
                let idx = *bytes.get(i)? as usize;
                i += 1;
                if let Some(v) = stack.last() {
                    if memo.len() <= idx {
                        memo.resize(idx + 1, PyVal::None);
                    }
                    memo[idx] = v.clone();
                }
            },
            0x72 => {
                // LONG_BINPUT 'r' — same with a 4-byte index
                let idx = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                if let Some(v) = stack.last() {
                    if memo.len() <= idx {
                        memo.resize(idx + 1, PyVal::None);
                    }
                    memo[idx] = v.clone();
                }
            },
            0x68 => {
                // BINGET 'h' — push a memoized value back
                let idx = *bytes.get(i)? as usize;
                i += 1;
                stack.push(memo.get(idx)?.clone());
            },
            0x6a => {
                // LONG_BINGET 'j'
                let idx = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                stack.push(memo.get(idx)?.clone());
            },
            0x2e => break, // STOP '.'
            _ => return None,
        }
    }
    stack.pop()
}

/// Pop the current stack back to the last MARK (CPython `pop_mark`).
fn pop_mark(stack: &mut Vec<PyVal>, metastack: &mut Vec<Vec<PyVal>>) -> Option<Vec<PyVal>> {
    let items = std::mem::take(stack);
    *stack = metastack.pop()?;
    Some(items)
}

/// Decode the avatar's `receiveDamageStat` args: one BLOB argument — a u8
/// length prefix followed by a pickle-proto-2 dict `{(weapon, category):
/// [count, total]}`. The dict carries a PARTIAL update: each key's value
/// replaces the running total for that pair (never summed across calls), so
/// the samples are emitted as-is and folded by the consumer. Spotting damage
/// can arrive with an integer total — coerced to f64.
fn decode_damage_stat(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::DamageStatSample> {
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
fn decode_minimap_vision(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::VisionEvent> {
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
/// the game's `CommonConsumables.UsageConverter`, mirrored by the vendored
/// wows-replays decoder): 0 = none (empty blob), 1 = default `<BB>`
/// (usage + consumable id), 2 = position `<BBff>` (+ map x/z), 3 = entity
/// target `<BBbQ>` (+ i8 target type + u64 target id). A blob whose length
/// contradicts its declared variant is a desync — the call is skipped rather
/// than half-decoded.
fn decode_consumable_used(
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
        // NONE — empty blob (or a leading zero byte, as the reference accepts).
        None | Some(0) => (),
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
fn decode_torpedo_directions(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::TorpedoSteer> {
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
fn decode_squadron_update(time: f32, args: &[u8]) -> Vec<wowsp_tauri_shared::SquadronPlane> {
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
fn parse_cruise_state(payload: &[u8], time: f32) -> Option<wowsp_tauri_shared::CruiseSample> {
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
fn parse_smoke_state(state: &[u8]) -> (Option<f32>, Option<f32>) {
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
            return;
        };
        let stream = crate::commands::replay::read_replay_positions(path.clone())
            .expect("decode real replay");
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
            methods: None,
            zone_entity_type: 14,
            ward_has_type: true,
            shotkill_has_ballistics: true,
            e11: None,
        };
        let decoded = walk_frames(&stream, &std::collections::HashSet::new(), false, &profile);
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
            (963617, MINIMAP_HIDDEN_SENTINEL),
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
        assert_eq!(hidden.packed_data, MINIMAP_HIDDEN_SENTINEL);

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
            methods: None,
            zone_entity_type: 14,
            ward_has_type: true,
            shotkill_has_ballistics: true,
            e11,
        };
        let ids = e11_method_ids(Some((15, 8, 0)));
        let decoded = walk_frames(
            &stream,
            &std::collections::HashSet::new(),
            false,
            &profile(ids),
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
        let by_entity: std::collections::BTreeMap<i32, Vec<&wowsp_tauri_shared::VisionEvent>> =
            decoded
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
                        speeds.push(
                            ((w[1].x - w[0].x).powi(2) + (w[1].z - w[0].z).powi(2)).sqrt() / dt,
                        );
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
}
