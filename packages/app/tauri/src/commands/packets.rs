//! Replay packet-stream decoder (milestone M3).
//!
//! The `.wowsreplay` packet stream (everything after the JSON header blocks) is
//! Blowfish-ECB-encrypted with a hardcoded 16-byte game key, XOR-chained across
//! consecutive 8-byte plaintext blocks, then zlib-compressed. This module
//! reverses that and walks the resulting frame stream to extract entity
//! position trajectories.
//!
//! Reference: `Monstrofil/replays_unpack` (Python). The Blowfish key, the XOR
//! chain (previous *plaintext* block), and the first-block skip are all from
//! `replay_unpack/replay_reader.py`. Packet framing `[u32 size][u32 type][f32
//! time][payload]` is from `core/network/net_packet.py`; the `Position`
//! (0x0a) layout is from `core/packets/Position.py`.

use blowfish::Blowfish;
use blowfish::cipher::{Block, BlockCipherDecrypt, KeyInit};
use byteorder::BigEndian;
use flate2::read::ZlibDecoder;
use std::io::Read;

use wowsp_tauri_shared::PositionSample;

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

/// Decrypt + decompress the packet stream, then collect every Position packet
/// into a flat timeline. Returns `Err` on structural problems (bad magic,
/// truncated, corrupt zlib); a replay with zero positions still succeeds.
pub fn extract_positions(packet_stream: &[u8]) -> Result<Vec<PositionSample>, String> {
    let decrypted = decrypt_stream(packet_stream)?;
    let inflated = inflate_zlib(&decrypted)?;
    Ok(walk_position_frames(&inflated))
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
        // chunks_exact(8) guarantees `chunk` is exactly 8 bytes; copy into a
        // fixed array so we can both decrypt in place and reinterpret as i64.
        let mut buf: [u8; 8] = [0; 8];
        buf.copy_from_slice(chunk);
        let mut block: Block<WowsBlowfish> = buf.into();
        cipher.decrypt_block(&mut block);
        // Read the decrypted bytes back into a fixed array.
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

/// Walk `[u32 size][u32 type][f32 time][payload]` frames and collect Position
/// packets. Stops cleanly if a frame header is truncated or declares an absurd
/// size (trailing padding).
fn walk_position_frames(inflated: &[u8]) -> Vec<PositionSample> {
    let mut out = Vec::new();
    let mut cur = 0usize;
    while cur + 12 <= inflated.len() {
        let size = u32::from_le_bytes(inflated[cur..cur + 4].try_into().unwrap()) as usize;
        let ptype = u32::from_le_bytes(inflated[cur + 4..cur + 8].try_into().unwrap());
        let time = f32::from_le_bytes(inflated[cur + 8..cur + 12].try_into().unwrap());
        let payload_end = cur + 12 + size;
        if size > 200_000 || payload_end > inflated.len() {
            break;
        }
        if ptype == PACKET_POSITION {
            let payload = &inflated[cur + 12..payload_end];
            if let Some(sample) = parse_position(payload, time) {
                out.push(sample);
            }
        }
        cur = payload_end;
    }
    out
}

/// Parse a Position (0x0a) payload. Layout (33 bytes):
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
    /// that positions are extracted and look sane (non-empty, finite coords).
    #[test]
    fn extracts_positions_from_real_replay() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return;
        };
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        // Skip header blocks to reach the packet stream.
        let block_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let mut cur = 8;
        for _ in 0..block_count {
            let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().unwrap()) as usize;
            cur += 4 + bl;
        }
        let stream = &bytes[cur..];
        let positions = extract_positions(stream).expect("decode must succeed");
        assert!(!positions.is_empty(), "must extract position samples");
        let distinct = positions
            .iter()
            .map(|p| p.entity_id)
            .collect::<std::collections::HashSet<_>>()
            .len();
        eprintln!(
            "[m3] {} position samples across {} entities; first={:?}",
            positions.len(),
            distinct,
            positions.first()
        );
        assert!(distinct >= 2, "a real match has multiple entities");
        // Coordinates should be finite and within a sane map range.
        for p in positions.iter().take(50) {
            assert!(p.x.is_finite() && p.z.is_finite(), "non-finite position");
            assert!(
                p.x.abs() < 10_000.0 && p.z.abs() < 10_000.0,
                "position out of map range"
            );
        }
    }
}
