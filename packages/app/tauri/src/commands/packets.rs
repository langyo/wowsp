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
            _ => {},
        }
        cur = payload_end;
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
    }
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
    Some(ParsedCreate {
        entity_id,
        entity_type,
        vehicle_id,
        x,
        y,
        z,
        creation_time: time,
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
