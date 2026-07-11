//! Live `tempArenaInfo.json` polling for overlay mode (milestone M7).
//!
//! When a battle loads, the game writes `<game_path>/replays/tempArenaInfo.json`
//! with the full roster for that match. In overlay mode WoWSP watches that file
//! and emits a `wowsp://arena-info` Tauri event whenever a fresh battle starts
//! — same mechanic as ApeRadar's `FileUtils.GetLatestTempArenaInfoFile(
//! requireFileToBeNewer=true)`, but event-driven via the `notify` crate instead
//! of a 1-second poll, so idle cost is near zero.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use notify::{RecommendedWatcher, RecursiveMode, Watcher, event::EventKind};
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::ArenaInfo;

use crate::commands::replay;

/// Tauri event name emitted whenever a fresh battle's roster appears.
pub const ARENA_INFO_EVENT: &str = "wowsp://arena-info";

/// One-shot read of the most recent `tempArenaInfo.json` under the configured
/// replay dir. Reuses the replay descriptor parser since the JSON shape is
/// identical (the file even shares the 8-byte-prefixed variant sometimes).
#[tauri::command]
pub fn read_temp_arena_info(dir: Option<String>) -> Result<Option<ArenaInfo>, String> {
    let dir = resolve_arena_dir(dir)?;
    let Some(path) = find_latest_arena_info(&dir) else {
        return Ok(None);
    };
    read_arena_file(&path).map(Some)
}

/// Start a background file watcher that emits [`ARENA_INFO_EVENT`] whenever a
/// newer `tempArenaInfo.json` appears. Spawns a `notify` watcher on a dedicated
/// thread; the watcher is killed when the app shuts down (malkuth drain). Safe
/// to call repeatedly — a second call stops the previous watcher first.
#[tauri::command]
pub fn start_arena_watcher(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    // Replace any existing watcher handle.
    let target = resolve_arena_dir(dir)?;
    let watcher = spawn_watcher(app.clone(), target)?;
    *ACTIVE_WATCHER
        .lock()
        .map_err(|e| format!("watcher lock: {e}"))? = Some(watcher);
    tracing::info!("arena watcher started");
    Ok(())
}

/// Stop the background arena watcher.
#[tauri::command]
pub fn stop_arena_watcher() -> Result<(), String> {
    if let Some(w) = ACTIVE_WATCHER
        .lock()
        .map_err(|e| format!("watcher lock: {e}"))?
        .take()
    {
        // Drop kills the watcher (RecommendedWatcher stops its thread on drop).
        drop(w);
        tracing::info!("arena watcher stopped");
    }
    Ok(())
}

static ACTIVE_WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// Read + parse one `tempArenaInfo.json` file into [`ArenaInfo`].
fn read_arena_file(path: &PathBuf) -> Result<ArenaInfo, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let json = replay::extract_descriptor_json_pub(&bytes)
        .ok_or_else(|| "tempArenaInfo.json: malformed".to_string())?;
    let raw: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("parse arena JSON: {e}"))?;
    let meta = replay::meta_from_raw_pub(path.to_string_lossy().into_owned(), raw.clone());
    Ok(ArenaInfo {
        match_group: meta.match_group,
        date_time: meta.date_time,
        vehicles: meta.vehicles,
        raw,
    })
}

/// Build + spawn the notify watcher. The watcher runs on its own thread (notify
/// is callback-based); the callback captures the AppHandle to emit Tauri events
/// and tracks the last-seen mtime so only *newer* files trigger (ApeRadar's
/// `requireFileToBeNewer` semantic — the game rewrites the same path each
/// battle, so without this every touch would fire).
fn spawn_watcher(app: AppHandle, target_dir: PathBuf) -> Result<RecommendedWatcher, String> {
    // Snapshot the last-seen mtime BEFORE moving target_dir into the closure.
    let last_mtime = find_latest_arena_info(&target_dir)
        .and_then(|p| p.metadata().and_then(|m| m.modified()).ok())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let state = Mutex::new(last_mtime);
    let app_for_cb = app.clone();
    let watch_root = target_dir.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            handle_watch_event(&app_for_cb, &target_dir, &state, res);
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("create watcher: {e}"))?;

    // Watch the replay dir recursively — the file lives directly under it but
    // versioned subfolders can appear too.
    watcher
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {watch_root:?}: {e}"))?;
    Ok(watcher)
}

/// notify callback: on a create/modify of tempArenaInfo.json, read its mtime;
/// if newer than the last-emitted one, re-parse + emit.
fn handle_watch_event(
    app: &AppHandle,
    target_dir: &PathBuf,
    state: &Mutex<SystemTime>,
    res: Result<notify::Event, notify::Error>,
) {
    let Ok(ev) = res else { return };
    if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
        return;
    }
    let Some(path) = find_latest_arena_info(target_dir) else {
        return;
    };
    let Ok(meta) = path.metadata() else { return };
    let Ok(mtime) = meta.modified() else { return };

    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if mtime <= *guard {
        return; // not newer — skip (requireFileToBeNewer)
    }
    *guard = mtime;
    drop(guard);

    match read_arena_file(&path) {
        Ok(info) => {
            tracing::info!(
                players = info.vehicles.len(),
                "fresh tempArenaInfo.json — emitting arena-info event"
            );
            if let Err(e) = app.emit(ARENA_INFO_EVENT, &info) {
                tracing::warn!(error = %e, "emit arena-info event failed");
            }
        },
        Err(e) => tracing::warn!(error = %e, "re-read tempArenaInfo.json after change failed"),
    }
}

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
    // As a last resort, try the detected install (managed state set by the
    // config store on the frontend). If still nothing, surface a clear error.
    Err("no replay dir: set WOWSP_GAME_PATH or WOWSP_REPLAY_DIR".into())
}

fn find_latest_arena_info(dir: &PathBuf) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    walk_for_arena(dir, &mut best);
    best.map(|(p, _)| p)
}

fn walk_for_arena(dir: &PathBuf, best: &mut Option<(PathBuf, SystemTime)>) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a fake tempArenaInfo.json into a temp dir, confirm it parses.
    #[test]
    fn parses_synthetic_arena_info() {
        let dir = std::env::temp_dir().join("wowsp_arena_test");
        std::fs::create_dir_all(&dir).unwrap();
        let json =
            r#"{"matchGroup":"pvp","vehicles":[{"id":1,"name":"A","relation":0,"shipId":10}]}"#;
        let path = dir.join("tempArenaInfo.json");
        std::fs::write(&path, json).unwrap();
        let info = read_arena_file(&path).expect("parse");
        assert_eq!(info.match_group.as_deref(), Some("pvp"));
        assert_eq!(info.vehicles.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// find_latest_arena_info picks the only tempArenaInfo.json in a dir tree.
    #[test]
    fn finds_arena_info_in_subdir() {
        let root = std::env::temp_dir().join("wowsp_arena_walk_test");
        let sub = root.join("14.5.0.0");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("tempArenaInfo.json"), b"{}").unwrap();
        // also a non-matching file that must be skipped
        std::fs::write(root.join("other.json"), b"{}").unwrap();
        let found = find_latest_arena_info(&root).expect("must find");
        assert!(found.ends_with("tempArenaInfo.json"));
        std::fs::remove_dir_all(&root).ok();
    }
}
