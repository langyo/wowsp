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
fn extract_descriptor_json(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        // Maybe bare JSON starting with '{'.
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
    // magic ok: next 4 bytes = little-endian JSON block length.
    let json_len = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let end = 8 + json_len;
    if end > bytes.len() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes[8..end]).into_owned())
}

/// Build a [`ReplayMeta`] from the raw descriptor JSON, pulling the common
/// fields defensively (the client occasionally drops keys).
fn meta_from_raw(path: String, raw: serde_json::Value) -> ReplayMeta {
    let obj = raw.as_object();
    let match_group = obj
        .and_then(|o| o.get("matchGroup"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let date_time = obj
        .and_then(|o| o.get("dateTime"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_id = obj
        .and_then(|o| o.get("mapId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_name = obj
        .and_then(|o| o.get("mapName"))
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
        path,
        match_group,
        date_time,
        map_id,
        map_name,
        vehicles,
        raw,
    }
}

fn parse_vehicle_entry(v: &serde_json::Value) -> Option<VehicleEntry> {
    let obj = v.as_object()?;
    let id = obj.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
    let name = obj
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_owned();
    let relation = obj
        .get("relation")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_owned();
    let ship_id = obj
        .get("shipId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_owned();
    Some(VehicleEntry {
        id,
        name,
        relation,
        ship_id,
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
