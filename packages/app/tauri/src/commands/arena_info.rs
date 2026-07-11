//! Live `tempArenaInfo.json` polling for overlay mode.
//!
//! When a battle loads, the game writes `<game_path>/replays/tempArenaInfo.json`
//! with the full roster for that match. In overlay mode WoWSP watches that file
//! and emits a Tauri event whenever a fresh battle starts — same mechanic as
//! ApeRadar's `FileUtils.GetLatestTempArenaInfoFile(requireFileToBeNewer=true)`
//! 1-second poll, but using `notify` for lower overhead.
//!
//! Status: **skeleton**. `read_temp_arena_info` reads the file on demand
//! (enough for the frontend to wire the overlay). The push-based watcher
//! (`start_arena_watcher`) is TODO(M7).

use std::path::PathBuf;
use std::sync::Mutex;

use wowsp_tauri_shared::ArenaInfo;

use crate::commands::replay;

/// One-shot read of the most recent `tempArenaInfo.json` under the configured
/// replay dir. Reuses the replay descriptor parser since the JSON shape is
/// identical (the file even shares the 8-byte-prefixed variant sometimes).
#[tauri::command]
pub fn read_temp_arena_info(dir: Option<String>) -> Result<Option<ArenaInfo>, String> {
    let dir = resolve_arena_dir(dir)?;
    let Some(path) = find_latest_arena_info(&dir) else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    // Same dual-format extraction as a replay header.
    let json = replay::extract_descriptor_json_pub(&bytes)
        .ok_or_else(|| "tempArenaInfo.json: malformed".to_string())?;
    let raw: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("parse arena JSON: {e}"))?;
    let meta = replay::meta_from_raw_pub(path.to_string_lossy().into_owned(), raw.clone());
    Ok(Some(ArenaInfo {
        match_group: meta.match_group,
        date_time: meta.date_time,
        vehicles: meta.vehicles,
        raw,
    }))
}

/// Start a background file watcher that emits a `wowsp://arena-info` event
/// whenever a newer `tempArenaInfo.json` appears. TODO(M7): spawn a `notify`
/// watcher task bridged to `app_handle.emit`.
#[tauri::command]
pub fn start_arena_watcher(_app: tauri::AppHandle, _dir: Option<String>) -> Result<(), String> {
    // Placeholder so the frontend can wire the call; real watcher lands in M7.
    if let Ok(mut guard) = WATCHER_ACTIVE.lock() {
        *guard = true;
    }
    Ok(())
}

/// Stop the background arena watcher. TODO(M7).
#[tauri::command]
pub fn stop_arena_watcher() -> Result<(), String> {
    if let Ok(mut guard) = WATCHER_ACTIVE.lock() {
        *guard = false;
    }
    Ok(())
}

static WATCHER_ACTIVE: Mutex<bool> = Mutex::new(false);

fn resolve_arena_dir(dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = dir {
        return Ok(PathBuf::from(d));
    }
    if let Ok(d) = std::env::var("WOWSP_REPLAY_DIR") {
        return Ok(PathBuf::from(d));
    }
    if let Ok(game) = std::env::var("WOWSP_GAME_PATH") {
        return Ok(PathBuf::from(game).join("replays"));
    }
    Err("no replay dir: set WOWSP_GAME_PATH or WOWSP_REPLAY_DIR".into())
}

fn find_latest_arena_info(dir: &PathBuf) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    walk_for_arena(dir, &mut best);
    best.map(|(p, _)| p)
}

fn walk_for_arena(dir: &PathBuf, best: &mut Option<(PathBuf, std::time::SystemTime)>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else { continue };
        if meta.is_dir() {
            walk_for_arena(&path, best);
        } else if path.file_name().and_then(|n| n.to_str()) == Some("tempArenaInfo.json") {
            if let Ok(mtime) = meta.modified() {
                if best.as_ref().is_none_or(|(_, t)| mtime > *t) {
                    *best = Some((path, mtime));
                }
            }
        }
    }
}
