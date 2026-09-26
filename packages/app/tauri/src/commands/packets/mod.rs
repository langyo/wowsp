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
    /// receive_wardAdded carries a trailing `wardType` byte from 13.2.0 on.
    ward_has_type: bool,
    /// SHOTKILL entries carry a nullable TERMINAL_BALLISTICS_INFO from 12.7.0
    /// on (flag byte; 29 bytes when present).
    shotkill_has_ballistics: bool,
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
    /// Battle chat timeline (avatar onChatMessage) — every player's messages
    /// with match timestamps. Empty when the version's exposed id isn't
    /// pinned or the payload fails the wire-shape check.
    pub chat_messages: Vec<wowsp_tauri_shared::ChatEvent>,
    /// In-battle achievement awards (avatar onAchievementEarned): a roster
    /// player earned a GameParams achievement at a match time.
    pub achievements: Vec<wowsp_tauri_shared::AchievementEvent>,
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

/// Upper bound on the decompressed size of a replay's packet stream.
/// Legitimate full-match streams measure in the tens of MB, so 256 MiB sits
/// far above any real replay — the cap exists because the encrypted stream
/// can also arrive from a paired peer (not only from local files), and a
/// zlib-compressed bomb would otherwise let an unbounded inflate exhaust
/// memory before the frame walk's per-frame sanity checks ever run.
pub(crate) const MAX_INFLATED_STREAM_BYTES: usize = 256 * 1024 * 1024;

/// zlib-decompress the decrypted stream, bounded by
/// [`MAX_INFLATED_STREAM_BYTES`].
fn inflate_zlib(decrypted: &[u8]) -> Result<Vec<u8>, String> {
    inflate_zlib_with_cap(decrypted, MAX_INFLATED_STREAM_BYTES)
}

/// zlib-decompress `decrypted`, refusing to buffer more than `cap` bytes.
///
/// `Read::take` feeds the decoder `cap + 1` bytes at most, so a stream whose
/// decompressed size strictly exceeds `cap` is rejected instead of being
/// buffered whole — a decompression-bomb guard, not a fidelity trade-off
/// (every real stream stays far under the cap).
pub(crate) fn inflate_zlib_with_cap(decrypted: &[u8], cap: usize) -> Result<Vec<u8>, String> {
    let mut dec = ZlibDecoder::new(decrypted).take(cap as u64 + 1);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| format!("zlib inflate: {e}"))?;
    if out.len() > cap {
        return Err(format!(
            "zlib inflate: decompressed stream exceeds the {cap}-byte cap; \
             the replay may be corrupted or malicious"
        ));
    }
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

mod events;
mod frames;
mod payloads;
mod pickle;

#[cfg(test)]
mod tests;

use events::{
    args_is_plane_id, decode_achievement, decode_artillery_shots, decode_chat_message,
    decode_damage_stat, decode_explosions, decode_minimap_squadron_add,
    decode_minimap_squadron_move, decode_shot_kills, decode_squadron_add, decode_squadron_update,
    decode_torpedo_directions, decode_torpedo_salvos, decode_ward_added,
};
use frames::walk_frames;
#[cfg(test)]
use payloads::scan_state_for_radius;
use payloads::{
    parse_battle_results, parse_camera, parse_camera_mode, parse_cell_player_create,
    parse_entity_create, parse_entity_destroy, parse_entity_method, parse_map_name,
    parse_nested_property, parse_net_stats, parse_player_position, parse_position, parse_property,
    parse_version, parse_weapon_lock, scan_state_for_ship_id,
};
use pickle::{PyVal, parse_pickle};
