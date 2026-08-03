//! Replay packet-stream decoder (milestones M3 + entity-create).
//!
//! The `.wowsreplay` packet stream (everything after the JSON header blocks) is
//! Blowfish-ECB-encrypted with a hardcoded 16-byte game key, XOR-chained across
//! consecutive 8-byte plaintext blocks, then zlib-compressed. This module
//! reverses that and walks the resulting frame stream to extract entity
//! position trajectories (Position, 0x0a) AND entity-creation metadata
//! (EntityCreate, 0x05) so the frontend can tell ships from capture zones.
//!
//! Reference: `Monstrofil/replays_unpack` (Python). The Blowfish key, the XOR
//! chain (previous *plaintext* block), and the first-block skip are all from
//! `replay_unpack/replay_reader.py`. Packet framing `[u32 size][u32 type][f32
//! time][payload]` is from `core/network/net_packet.py`; the `Position` (0x0a)
//! and `EntityCreate` (0x05) layouts are from `core/packets/*.py`.

use std::collections::BTreeMap;
use std::io::Read;

use blowfish::Blowfish;
use blowfish::cipher::{Block, BlockCipherDecrypt, KeyInit};
use byteorder::BigEndian;
use flate2::read::ZlibDecoder;

use wowsp_tauri_shared::{EntityKind, PositionSample};

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
/// Secondary position stream used by aircraft/squadrons (entityType 4) and
/// other transient entities on current clients. Same 32-byte layout as
/// PlayerPosition.
const PACKET_POSITION_AUX: u32 = 0x2a;
/// Packet type for the recorder's own-player entity creation ("CellPlayerCreate"
/// in Monstrofil's `replays_unpack`). The avatar (the recorder's own player)
/// is created with this packet rather than EntityCreate (0x05); same layout.
const PACKET_CELL_PLAYER_CREATE: u32 = 0x01;
/// Packet type for entity method calls (0x08). Battle events that have no
/// dedicated entity (shell explosions, torpedo launches) arrive here as
/// method calls on the avatar (the recorder's own player entity) and the
/// firing vehicle. Method ids are per-entity-type tables:
///   Avatar client method 126 = receiveExplosions (world-space impact points)
///   Vehicle client method  47 = shootTorpedo (launch direction vector)
const PACKET_ENTITY_METHOD: u32 = 0x08;
/// Avatar entity type id (spec index 1). Its method table drives
/// `receiveExplosions` (id 126) parsing.
const ENTITY_TYPE_AVATAR: i16 = 1;
/// NestedPropertyUpdate (0x23): nested property blob updates, used by
/// capture zones to stream their live capture progress (0..1 fraction at the
/// tail of the payload).
const PACKET_NESTED_PROPERTY: u32 = 0x23;
/// SetWeaponLock (0x30): the recorder's weapon lock state change.
/// Payload: `u32 weapon_type, u32 lock_type, u32 target_id`.
const PACKET_SET_WEAPON_LOCK: u32 = 0x30;
/// BattleResults (0x22): post-battle statistics payload (a JSON string with a
/// u32 length prefix). Emitted once near match end.
const PACKET_BATTLE_RESULTS: u32 = 0x22;
/// Avatar client-method id for `receiveExplosions` on current clients
/// (15.x): array of {Vector3 pos, u32 paramsID, u8 hitType}.
const METHOD_RECEIVE_EXPLOSIONS: i32 = 126;
/// Vehicle client-method id for `shootTorpedo` on current clients (15.x):
/// {i32 tube, Vector3 dir, i32, i32, u8}.
const METHOD_SHOOT_TORPEDO: i32 = 47;

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
    /// World-space shell impact points (`receiveExplosions` on the avatar).
    pub explosions: Vec<wowsp_tauri_shared::ExplosionEvent>,
    /// Torpedo launches (`shootTorpedo` on the firing vehicle).
    pub torpedoes: Vec<wowsp_tauri_shared::TorpedoLaunch>,
    /// Capture-zone progress streams (NestedPropertyUpdate 0x23, entity
    /// type 14): 0..1 fraction of the current capture per entity.
    pub cap_progress: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>>,
    /// Recorder weapon-lock timeline (SetWeaponLock 0x30).
    pub weapon_locks: Vec<wowsp_tauri_shared::WeaponLockEvent>,
    /// Raw post-battle statistics payload (BattleResults 0x22).
    pub battle_results: Option<String>,
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
pub fn decode_replay(
    packet_stream: &[u8],
    ship_id_candidates: &std::collections::HashSet<u32>,
) -> Result<DecodedReplay, String> {
    let decrypted = decrypt_stream(packet_stream)?;
    let inflated = inflate_zlib(&decrypted)?;
    Ok(walk_frames(&inflated, ship_id_candidates))
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

/// Walk `[u32 size][u32 type][f32 time][payload]` frames, collecting Position
/// samples (grouped by entity id) and EntityCreate metadata. Stops cleanly if a
/// frame header is truncated or declares an absurd size (trailing padding).
fn walk_frames(
    inflated: &[u8],
    ship_id_candidates: &std::collections::HashSet<u32>,
) -> DecodedReplay {
    let mut positions: BTreeMap<i32, Vec<PositionSample>> = BTreeMap::new();
    let mut kinds: BTreeMap<i32, EntityKind> = BTreeMap::new();
    let mut destroys: BTreeMap<i32, f32> = BTreeMap::new();
    let mut properties: BTreeMap<i32, Vec<PropertyChange>> = BTreeMap::new();
    let mut methods: Vec<RawMethodCall> = Vec::new();
    let mut nested: Vec<RawNestedProperty> = Vec::new();
    let mut weapon_locks: Vec<wowsp_tauri_shared::WeaponLockEvent> = Vec::new();
    let mut battle_results: Option<String> = None;
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
        match ptype {
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
                if let Some(created) = parse_entity_create(payload, time) {
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
            _ => {},
        }
        cur = payload_end;
    }
    // Capture-zone progress: nested-property payloads on type-14 entities
    // carry the live capture fraction as a trailing f32 (0..1). Keep only
    // those, keyed by entity.
    let mut cap_progress: BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> = BTreeMap::new();
    for n in &nested {
        if kinds.get(&n.entity_id).map(|k| k.entity_type) != Some(14) {
            continue;
        }
        if n.payload.len() >= 4 {
            let f = f32::from_le_bytes(n.payload[n.payload.len() - 4..].try_into().unwrap());
            if f.is_finite() && f >= 0.0 && f <= 1.5 {
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
    // method ids live in per-entity-type tables, so e.g. id 126 is only
    // `receiveExplosions` when the receiver is the avatar entity (type 1).
    let mut explosions: Vec<wowsp_tauri_shared::ExplosionEvent> = Vec::new();
    let mut torpedoes: Vec<wowsp_tauri_shared::TorpedoLaunch> = Vec::new();
    for call in &methods {
        let entity_type = kinds.get(&call.entity_id).map(|k| k.entity_type);
        if entity_type == Some(ENTITY_TYPE_AVATAR) && call.method_id == METHOD_RECEIVE_EXPLOSIONS {
            explosions.extend(decode_explosions(call.time, &call.args));
        } else if entity_type == Some(2) && call.method_id == METHOD_SHOOT_TORPEDO {
            if let Some(t) = decode_torpedo_launch(call.time, call.entity_id, &call.args) {
                torpedoes.push(t);
            }
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
        explosions,
        torpedoes,
        cap_progress,
        weapon_locks,
        battle_results,
    }
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
fn parse_weapon_lock(
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
    let args = payload.get(12..12 + args_len.min(payload.len() - 12))?.to_vec();
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
    let Some(&count) = args.first() else { return out };
    off += 1;
    for _ in 0..count {
        if off + 17 > args.len() {
            break;
        }
        let x = f32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let y = f32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap());
        let z = f32::from_le_bytes(args[off + 8..off + 12].try_into().unwrap());
        off += 17; // pos(12) + paramsID(4) + hitType(1)
        out.push(wowsp_tauri_shared::ExplosionEvent { time, x, y, z });
    }
    out
}

/// Decode `shootTorpedo` args: `i32 tube, f32×3 direction, i32, i32, u8`.
fn decode_torpedo_launch(
    time: f32,
    entity_id: i32,
    args: &[u8],
) -> Option<wowsp_tauri_shared::TorpedoLaunch> {
    if args.len() < 21 {
        return None;
    }
    let dir_x = f32::from_le_bytes(args[4..8].try_into().ok()?);
    let dir_y = f32::from_le_bytes(args[8..12].try_into().ok()?);
    let dir_z = f32::from_le_bytes(args[12..16].try_into().ok()?);
    Some(wowsp_tauri_shared::TorpedoLaunch {
        time,
        entity_id,
        dir_x,
        dir_y,
        dir_z,
    })
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
    /// entity type is 14; `None` for other types or when no candidate is found.
    radius: Option<f32>,
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
        }
    }
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
/// an integral value in the 20..150 m range. Empirically the radius is the
/// LAST such field (observed at offset ~98 on domination, ~94 on two-brothers
/// domination, ~18 on the 1v1 brawl layout) and every mode's state packs it
/// as a trailing plain float, so the highest-offset candidate wins.
fn scan_state_for_radius(state: &[u8]) -> Option<f32> {
    if state.len() < 4 {
        return None;
    }
    let mut best: Option<(usize, f32)> = None;
    for off in 0..=state.len() - 4 {
        let f = f32::from_le_bytes(state[off..off + 4].try_into().ok()?);
        if f.is_finite() && f >= 20.0 && f <= 150.0 && (f - f.round()).abs() < 0.01 {
            best = Some((off, f));
        }
    }
    best.map(|(_, f)| f)
}

/// Parse an EntityCreate (0x05) payload. WoWS layout (from
/// `clients/wows/network/packets/EntityCreate.py`):
///   i32 entity_id, i16 type, i32 vehicle_id, i32 space_id,
///   f32×3 position, f32×3 direction, [BinaryStream state — skipped]
fn parse_entity_create(payload: &[u8], time: f32) -> Option<ParsedCreate> {
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
    let radius = if entity_type == 14 && payload.len() > 38 {
        scan_state_for_radius(&payload[38..])
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
        payload.extend_from_slice(&3.14f32.to_le_bytes());
        payload.extend_from_slice(&0.0f32.to_le_bytes());
        payload.extend_from_slice(&0.0f32.to_le_bytes());
        let s = parse_player_position(&payload, 1.5).expect("must parse");
        assert_eq!(s.entity_id, 962015);
        assert_eq!(s.vehicle_id, 962014);
        assert!((s.x - -516.4).abs() < 0.01);
        assert!((s.z - 500.0).abs() < 0.01);
        assert!((s.yaw - 3.14).abs() < 0.01);
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

    /// End-to-end against a real replay when `WOWSP_TEST_REPLAY` is set. Asserts
    /// positions AND EntityCreate kinds are extracted and look sane.
    #[test]
    fn decodes_real_replay_positions_and_entities() {
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
        let decoded = decode_replay(&bytes[cur..], &std::collections::HashSet::new())
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
            "[m3+entity+destroy] {} position samples across {} entities; {} EntityCreates ({} type=2 ships); {} destroyed",
            total_samples,
            decoded.positions.len(),
            decoded.kinds.len(),
            ships,
            decoded.destroys.len(),
        );
        assert!(ships >= 2, "a real match has at least 2 ships");
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
}
