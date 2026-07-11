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
/// fixed layout — does NOT need the per-version entity DB.
const PACKET_POSITION: u32 = 0x0a;
/// Packet type for entity creation. The fixed header (entityID / type /
/// vehicleId / spaceId / position / direction) is readable without the entity
/// DB; the trailing `state` BinaryStream (entity properties) is skipped.
const PACKET_ENTITY_CREATE: u32 = 0x05;

/// Output of decoding: per-entity trajectories plus the EntityCreate metadata
/// keyed by entity id (so the frontend can filter ships vs zones vs avatars).
pub struct DecodedReplay {
    pub positions: BTreeMap<i32, Vec<PositionSample>>,
    pub kinds: BTreeMap<i32, EntityKind>,
}

/// Decrypt + decompress the packet stream, then walk frames extracting both
/// Position (0x0a) and EntityCreate (0x05) packets.
pub fn decode_replay(packet_stream: &[u8]) -> Result<DecodedReplay, String> {
    let decrypted = decrypt_stream(packet_stream)?;
    let inflated = inflate_zlib(&decrypted)?;
    Ok(walk_frames(&inflated))
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
fn walk_frames(inflated: &[u8]) -> DecodedReplay {
    let mut positions: BTreeMap<i32, Vec<PositionSample>> = BTreeMap::new();
    let mut kinds: BTreeMap<i32, EntityKind> = BTreeMap::new();
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
            PACKET_ENTITY_CREATE => {
                if let Some(created) = parse_entity_create(payload) {
                    let eid = created.entity_id;
                    kinds.insert(eid, created.clone_into_kind());
                }
            },
            _ => {},
        }
        cur = payload_end;
    }
    // Sort each entity's samples by time for clean playback scrubbing.
    for samples in positions.values_mut() {
        samples.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    DecodedReplay { positions, kinds }
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
}

impl ParsedCreate {
    fn clone_into_kind(self) -> EntityKind {
        EntityKind {
            entity_type: self.entity_type,
            vehicle_id: self.vehicle_id,
            initial_x: self.x,
            initial_y: self.y,
            initial_z: self.z,
        }
    }
}

/// Parse an EntityCreate (0x05) payload. WoWS layout (from
/// `clients/wows/network/packets/EntityCreate.py`):
///   i32 entity_id, i16 type, i32 vehicle_id, i32 space_id,
///   f32×3 position, f32×3 direction, [BinaryStream state — skipped]
fn parse_entity_create(payload: &[u8]) -> Option<ParsedCreate> {
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
    })
}

/// Parse a Position (0x0a) payload. Layout (45 bytes):
///   i32 entity_id, i32 vehicle_id, f32×3 position, f32×3 position_error,
///   f32 yaw, f32 pitch, f32 roll, i8 is_error
fn parse_position(payload: &[u8], time: f32) -> Option<PositionSample> {
    if payload.len() < 28 {
        return None;
    }
    let entity_id = i32::from_le_bytes(payload[0..4].try_into().ok()?);
    let vehicle_id = i32::from_le_bytes(payload[4..8].try_into().ok()?);
    let x = f32::from_le_bytes(payload[8..12].try_into().ok()?);
    let y = f32::from_le_bytes(payload[12..16].try_into().ok()?);
    let z = f32::from_le_bytes(payload[16..20].try_into().ok()?);
    let yaw = f32::from_le_bytes(payload[24..28].try_into().ok()?);
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
        let decoded = decode_replay(&bytes[cur..]).expect("decode must succeed");
        let total_samples: usize = decoded.positions.values().map(|v| v.len()).sum();
        assert!(total_samples > 0, "must extract position samples");
        // Ships are entity_type 2; a real match has several.
        let ships = decoded
            .kinds
            .iter()
            .filter(|(_, k)| k.entity_type == 2)
            .count();
        eprintln!(
            "[m3+entity] {} position samples across {} entities; {} EntityCreates ({} type=2 ships)",
            total_samples,
            decoded.positions.len(),
            decoded.kinds.len(),
            ships
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
}
