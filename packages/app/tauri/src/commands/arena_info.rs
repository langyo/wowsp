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

/// Team sizes (allies, enemies) of the most recently seen battle roster.
/// Kept SEPARATE: asymmetrical modes (e.g. 12 vs 6) render two sub-tables
/// with different row counts, and the overlay grid must match each side's
/// own count. Packed as (allies << 16) | enemies; 0 = no battle seen yet.
static LAST_TEAM_SIZES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// mtime (unix seconds) of the most recently seen tempArenaInfo.json — NOT
/// the read time: the file is re-read every few seconds by polling, so only
/// its modification stamp says when the battle actually started.
static LAST_ARENA_MTIME: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record both team sizes (allies = relation ≤ 1) and the battle's start
/// stamp (the arena file's mtime).
fn note_arena_seen(vehicles: &[wowsp_tauri_shared::VehicleEntry], file_mtime: SystemTime) {
    let allies = vehicles.iter().filter(|v| v.relation <= 1).count();
    let enemies = vehicles.len() - allies;
    LAST_TEAM_SIZES.store(
        (allies << 16) | enemies,
        std::sync::atomic::Ordering::Relaxed,
    );
    LAST_ARENA_MTIME.store(unix_secs(file_mtime), std::sync::atomic::Ordering::Relaxed);
}

/// Latest known per-team player counts (allies, enemies) — (0, 0) before
/// any battle was seen.
pub(crate) fn last_known_team_sizes() -> (usize, usize) {
    let packed = LAST_TEAM_SIZES.load(std::sync::atomic::Ordering::Relaxed);
    (packed >> 16, packed & 0xFFFF)
}

/// True when the most recent battle roster is no older than `max_age_secs`.
/// The overlay Tab watcher refuses to capture outside this window — Tab in
/// port or long after a battle must stay a no-op.
pub(crate) fn arena_seen_within(max_age_secs: u64) -> bool {
    let at = LAST_ARENA_MTIME.load(std::sync::atomic::Ordering::Relaxed);
    at > 0 && unix_secs(SystemTime::now()) - at <= max_age_secs as i64
}

/// Battle identity stamp (the arena file's mtime, unix seconds; 0 = never).
/// The overlay pins its detected anchor to this stamp: same battle → same
/// anchor, no per-press re-detection drift.
pub(crate) fn last_arena_stamp() -> i64 {
    LAST_ARENA_MTIME.load(std::sync::atomic::Ordering::Relaxed)
}

/// Cheap synchronous re-check of the arena file, used by the overlay Tab
/// watcher on each fresh press when the cached state is stale: stat (and
/// parse, when newer) `<replays>/tempArenaInfo.json` directly. Returns
/// whether a fresh roster is now known. A partially written file fails to
/// parse and is simply not recorded — the next press retries.
pub(crate) fn refresh_battle_state() -> bool {
    let Ok(dir) = resolve_arena_dir(None) else {
        return false;
    };
    let Some(path) = find_latest_arena_info(&dir) else {
        return false;
    };
    let Ok(meta) = path.metadata() else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let at = LAST_ARENA_MTIME.load(std::sync::atomic::Ordering::Relaxed);
    if at > 0 && unix_secs(mtime) <= at {
        // Nothing newer than what we already recorded.
        return arena_seen_within(1);
    }
    match read_arena_file(&path) {
        Ok(info) => {
            note_arena_seen(&info.vehicles, mtime);
            true
        },
        Err(e) => {
            tracing::debug!(error = %e, "battle-state refresh: arena file not parseable yet");
            false
        },
    }
}

/// One-shot read of the most recent `tempArenaInfo.json` under the configured
/// replay dir. Reuses the replay descriptor parser since the JSON shape is
/// identical (the file even shares the 8-byte-prefixed variant sometimes).
// All commands here are async so they run on the Tauri async runtime
// instead of the main/UI thread: `read_temp_arena_info` walks the replay
// tree and is polled every 3 s, and a sync command would inline that walk
// on the webview IPC (main) thread, stalling every queued request.
#[tauri::command]
pub async fn read_temp_arena_info(dir: Option<String>) -> Result<Option<ArenaInfo>, String> {
    let dir = resolve_arena_dir(dir)?;
    let Some(path) = find_latest_arena_info(&dir) else {
        return Ok(None);
    };
    let mtime = path.metadata().and_then(|m| m.modified()).ok();
    let info = read_arena_file(&path)?;
    if let Some(mtime) = mtime {
        note_arena_seen(&info.vehicles, mtime);
    }
    Ok(Some(info))
}

/// Start a background file watcher that emits [`ARENA_INFO_EVENT`] whenever a
/// newer `tempArenaInfo.json` appears. Spawns a `notify` watcher on a dedicated
/// thread; the watcher is killed when the app shuts down (malkuth drain). Safe
/// to call repeatedly — a second call stops the previous watcher first.
#[tauri::command]
pub async fn start_arena_watcher(app: AppHandle, dir: Option<String>) -> Result<(), String> {
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
pub async fn stop_arena_watcher() -> Result<(), String> {
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
        map_name: meta.map_name,
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
    let state = Mutex::new(WatchState {
        last_mtime,
        last_scan: std::time::Instant::now(),
    });
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

/// Watcher bookkeeping: the last-emitted arena mtime plus a scan debouncer.
struct WatchState {
    last_mtime: SystemTime,
    last_scan: std::time::Instant,
}

/// Minimum spacing between directory scans in the notify callback. During a
/// battle the game continuously rewrites the ongoing `.wowsreplay` in the
/// same watched tree — those events must not each trigger a full recursive
/// walk of the replays folder.
const ARENA_SCAN_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(250);

/// notify callback: on a create/modify of tempArenaInfo.json, read its mtime;
/// if newer than the last-emitted one, re-parse + emit.
fn handle_watch_event(
    app: &AppHandle,
    target_dir: &PathBuf,
    state: &Mutex<WatchState>,
    res: Result<notify::Event, notify::Error>,
) {
    let Ok(ev) = res else { return };
    if !matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
        return;
    }
    // Only events touching the arena file itself justify a scan — anything
    // else (replay writes, subfolder churn) is filtered out before the walk.
    let touches_arena = ev.paths.iter().any(|p| {
        p.file_name()
            .is_some_and(|n| n == std::ffi::OsStr::new("tempArenaInfo.json"))
    });
    if !touches_arena {
        return;
    }
    // Debounce: a write typically arrives as a create+modify pair; one scan
    // per window is plenty and the mtime compare keeps the semantics exact.
    {
        let mut guard = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.last_scan.elapsed() < ARENA_SCAN_DEBOUNCE {
            return;
        }
        guard.last_scan = std::time::Instant::now();
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
    if mtime <= guard.last_mtime {
        return; // not newer — skip (requireFileToBeNewer)
    }
    guard.last_mtime = mtime;
    drop(guard);

    match read_arena_file(&path) {
        Ok(info) => {
            tracing::info!(
                players = info.vehicles.len(),
                "fresh tempArenaInfo.json — emitting arena-info event"
            );
            note_arena_seen(&info.vehicles, mtime);
            if let Err(e) = app.emit(ARENA_INFO_EVENT, &info) {
                tracing::warn!(error = %e, "emit arena-info event failed");
            }
        },
        Err(e) => tracing::warn!(error = %e, "re-read tempArenaInfo.json after change failed"),
    }
}

/// Cached auto-detected install (game root + its replays dir). The detection
/// scans the registry and Steam libraries; `read_temp_arena_info` is polled
/// every 3 s WITHOUT an explicit dir, so an uncached miss would re-scan all
/// of that per poll. Invalidated when the game root disappears.
static DETECTED_DIR_CACHE: Mutex<Option<(PathBuf, PathBuf)>> = Mutex::new(None);

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
    // Last resort: auto-detect the install (registry + Steam) and use its
    // `replays/` folder. Mirrors `replay::resolve_replay_dir`. The frontend
    // normally passes the active install's path explicitly.
    if let Some((root, replays)) = DETECTED_DIR_CACHE.lock().ok().and_then(|g| g.clone()) {
        if root.is_dir() {
            return Ok(replays);
        }
    }
    if let Some(detected) = super::game_detect::scan_game_installs().into_iter().next() {
        let root = PathBuf::from(&detected.path);
        let replays = root.join("replays");
        if let Ok(mut cache) = DETECTED_DIR_CACHE.lock() {
            *cache = Some((root.clone(), replays.clone()));
        }
        return Ok(replays);
    }
    Err("no replay dir: pass `dir`, or set WOWSP_REPLAY_DIR / WOWSP_GAME_PATH".into())
}

fn find_latest_arena_info(dir: &PathBuf) -> Option<PathBuf> {
    // Fast path: the game writes the file directly into <replays>/ — only
    // fall back to the recursive walk (versioned subfolders) when it is not
    // there. The walk stats every file in the tree and runs on a 3 s poll.
    let direct = dir.join("tempArenaInfo.json");
    if direct.is_file() {
        return Some(direct);
    }
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
