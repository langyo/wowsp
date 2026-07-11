//! Replay (`.wowsreplay`) header parsing.
//!
//! File layout:
//!   4 bytes  magic       = `{0x12, 0x32, 0x34, 0x11}`
//!   4 bytes  json_len    = little-endian u32
//!   N bytes  json_block  = match descriptor JSON (roster, map, match type)
//!   4 bytes  meta_count  = u32, number of trailing metadata blocks
//!   ...      metadata    = extra metadata blocks (usually empty for live)
//!   ...      packets     = encrypted/zlib packet stream (Phase 2 — milestone M3)
//!
//! Phase 1 (this file) implements the magic check + JSON block extraction. The
//! dual-format reader also accepts the bare-JSON variant the client writes as
//! `tempArenaInfo.json` (same logic ApeRadar's `FileUtils.ReadTempArenaInfoFile`
//! uses). The packet-stream decode lands in M3.

use std::fs;
use std::path::PathBuf;

use wowsp_tauri_shared::{ReplayMeta, VehicleEntry};

/// Replay magic — first 4 bytes of every `.wowsreplay`.
const REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];

/// Read + parse the header of one `.wowsreplay` file into a [`ReplayMeta`].
///
/// `path` must point at an existing file. On any structural problem (missing
/// magic, truncated header, unparseable JSON) the raw JSON block is still
/// returned when recoverable, so the frontend can render whatever it can.
#[tauri::command]
pub fn read_replay_header(path: String) -> Result<ReplayMeta, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let json = extract_descriptor_json(&bytes)
        .ok_or_else(|| format!("{path}: not a valid wowsreplay (magic mismatch or truncated)"))?;
    let raw: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("parse descriptor JSON: {e}"))?;
    Ok(meta_from_raw(path, raw))
}

/// Decode the packet stream of one `.wowsreplay` and return per-entity
/// position trajectories (milestone M3) annotated with each entity's creation
/// metadata (entity-create: type / vehicleId / initial position) so the frontend
/// can filter ships from capture zones / avatars.
#[tauri::command]
pub fn read_replay_positions(
    path: String,
) -> Result<Vec<wowsp_tauri_shared::EntityTrajectory>, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let stream = packet_stream_after_blocks(&bytes)
        .ok_or_else(|| format!("{path}: not a valid wowsreplay (no packet stream)"))?;
    let decoded = super::packets::decode_replay(stream)?;
    Ok(group_by_entity(decoded))
}

/// Skip the magic + JSON header blocks and return a slice over the encrypted
/// packet stream. Shared by header parsing and position decoding.
fn packet_stream_after_blocks(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < 8 || !bytes.starts_with(&REPLAY_MAGIC) {
        return None;
    }
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    let mut cur = 8;
    for _ in 0..block_count {
        if cur + 4 > bytes.len() {
            return None;
        }
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
        cur += 4 + bl;
        if cur > bytes.len() {
            return None;
        }
    }
    Some(&bytes[cur..])
}

/// Group the decoded per-entity positions into trajectories, attaching each
/// entity's creation metadata (type / vehicleId / spawn position) from the
/// EntityCreate packets. Ships (type 2 with many samples) sort first.
fn group_by_entity(
    decoded: super::packets::DecodedReplay,
) -> Vec<wowsp_tauri_shared::EntityTrajectory> {
    let super::packets::DecodedReplay { positions, kinds } = decoded;
    let mut out: Vec<_> = positions
        .into_iter()
        .map(
            |(entity_id, samples)| wowsp_tauri_shared::EntityTrajectory {
                entity_id,
                kind: kinds.get(&entity_id).cloned(),
                samples,
            },
        )
        .collect();
    // Largest trajectory first — ships have hundreds/thousands of samples,
    // transient entities (planes, torpedoes) have a few dozen.
    use std::cmp::Reverse;
    out.sort_by_key(|t| Reverse(t.samples.len()));
    out
}

/// List `.wowsreplay` files under a directory (defaults to the detected game's
/// `replays/` folder). Returns at most `limit` paths sorted newest-first.
#[tauri::command]
pub fn list_replays(dir: Option<String>, limit: Option<usize>) -> Result<Vec<String>, String> {
    let dir = resolve_replay_dir(dir)?;
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    walk_replays(&dir, &mut entries);
    use std::cmp::Reverse;
    entries.sort_by_key(|(_, t)| Reverse(*t));
    let limit = limit.unwrap_or(200);
    Ok(entries
        .into_iter()
        .take(limit)
        .map(|(p, _)| p.to_string_lossy().into_owned())
        .collect())
}

/// Public re-export so `arena_info` can reuse the exact same JSON extraction
/// (the live `tempArenaInfo.json` shares the replay's dual-format header).
pub fn extract_descriptor_json_pub(bytes: &[u8]) -> Option<String> {
    extract_descriptor_json(bytes)
}

/// Public re-export of [`meta_from_raw`] for `arena_info` (same JSON shape).
pub fn meta_from_raw_pub(path: String, raw: serde_json::Value) -> ReplayMeta {
    meta_from_raw(path, raw)
}

/// Pull the descriptor JSON out of a replay byte slice. Handles both the
/// binary-prefixed replay format and the bare-JSON `tempArenaInfo.json`
/// variant — the same dual-format logic ApeRadar ships.
///
/// Replay layout: `magic(4) + block_count(4) + [len(4)+payload]×block_count`.
/// The first payload is the match-descriptor JSON.
fn extract_descriptor_json(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        if bytes.first().copied() == Some(b'{') {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        return None;
    }
    if !bytes.starts_with(&REPLAY_MAGIC) {
        if bytes.first().copied() == Some(b'{') {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        return None;
    }
    // magic(4) + block_count(4); first block = len(4) + JSON payload.
    let mut cur = 4;
    let block_count = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
    cur += 4;
    if block_count == 0 {
        return None;
    }
    // First block length.
    if cur + 4 > bytes.len() {
        return None;
    }
    let json_len = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
    cur += 4;
    let end = cur + json_len;
    if end > bytes.len() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes[cur..end]).into_owned())
}

/// Build a [`ReplayMeta`] from the raw descriptor JSON, pulling the common
/// fields defensively. `dateTime` is parsed from the replay filename (the
/// descriptor has no timestamp).
fn meta_from_raw(path: String, raw: serde_json::Value) -> ReplayMeta {
    let obj = raw.as_object();
    let match_group = obj
        .and_then(|o| o.get("matchGroup"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_id = obj.and_then(|o| o.get("mapId")).and_then(|v| v.as_i64());
    let map_name = obj
        .and_then(|o| o.get("mapDisplayName"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let vehicles = obj
        .and_then(|o| o.get("vehicles"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(parse_vehicle_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    ReplayMeta {
        date_time: parse_datetime_from_filename(&path),
        path,
        match_group,
        map_id,
        map_name,
        vehicles,
        raw,
    }
}

/// Filenames look like `20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay`;
/// the leading `YYYYMMDD_HHMMSS` is the only timestamp source.
fn parse_datetime_from_filename(path: &str) -> Option<String> {
    let stem = std::path::Path::new(path)
        .file_name()?
        .to_str()?
        .split('_')
        .next()?;
    if stem.len() == 8 && stem.chars().all(|c| c.is_ascii_digit()) {
        Some(stem.to_owned())
    } else {
        None
    }
}

fn parse_vehicle_entry(v: &serde_json::Value) -> Option<VehicleEntry> {
    let obj = v.as_object()?;
    Some(VehicleEntry {
        id: obj.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
        name: obj
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_owned(),
        relation: obj.get("relation").and_then(|x| x.as_i64()).unwrap_or(0),
        ship_id: obj.get("shipId").and_then(|x| x.as_i64()).unwrap_or(0),
        ship_name: None,
    })
}

fn resolve_replay_dir(dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = dir {
        return Ok(PathBuf::from(d));
    }
    if let Ok(d) = std::env::var("WOWSP_REPLAY_DIR") {
        return Ok(PathBuf::from(d));
    }
    if let Ok(game) = std::env::var("WOWSP_GAME_PATH") {
        return Ok(PathBuf::from(game).join("replays"));
    }
    Err("no replay dir: pass `dir`, or set WOWSP_REPLAY_DIR / WOWSP_GAME_PATH".into())
}

fn walk_replays(dir: &PathBuf, out: &mut Vec<(PathBuf, std::time::SystemTime)>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else { continue };
        if meta.is_dir() {
            walk_replays(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("wowsreplay") {
            if let Ok(mtime) = meta.modified() {
                out.push((path, mtime));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic replay: magic + 1 block + a tiny JSON descriptor. Verifies the
    /// block-count format is parsed correctly (the bug the skeleton had).
    #[test]
    fn parses_synthetic_replay_header() {
        let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        let extracted = extract_descriptor_json(&bytes).expect("must extract JSON");
        assert!(extracted.contains("15_NE_north"));
        let raw: serde_json::Value = serde_json::from_str(&extracted).unwrap();
        let meta = meta_from_raw("20250622_152405_x.wowsreplay".into(), raw);
        assert_eq!(meta.map_name.as_deref(), Some("15_NE_north"));
        assert_eq!(meta.map_id, Some(8));
        assert_eq!(meta.match_group.as_deref(), Some("pvp"));
        assert_eq!(meta.date_time.as_deref(), Some("20250622"));
    }

    /// If a real replay is available on this machine, parse it end-to-end.
    #[test]
    fn parses_real_replay_if_present() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return; // no real replay on this machine — skip
        };
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let json = extract_descriptor_json(&bytes)
            .unwrap_or_else(|| panic!("no descriptor JSON in {path}"));
        let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor must be JSON");
        let meta = meta_from_raw(path.clone(), raw);
        assert!(!meta.vehicles.is_empty(), "roster must not be empty");
        assert!(meta.map_name.is_some(), "mapDisplayName must be present");
        eprintln!(
            "[real-replay] {} → map={}, {} players",
            path,
            meta.map_name.unwrap(),
            meta.vehicles.len()
        );
    }
}
