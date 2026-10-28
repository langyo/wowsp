//! The local player-marker store (玩家标记) — a flat JSON list under the
//! appdata root, CRUD over IPC, ZERO network. The former WG/Lesta OpenID
//! sync pipeline is gone: the WG portals dropped their public login API
//! (METHOD_NOT_FOUND probed 2026-10-26 on every international gateway) and
//! the CN cluster never had one, so the markers are the user's own local
//! judgments, built by hand and kept on this machine only.

use anyhow::{Result, anyhow};
use tauri::{Emitter, Manager};

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use wowsp_tauri_shared::{CommandResult, MarkerColor, MarkerEntry};

use crate::commands::ensure_main_window_label;
use crate::paths;
use crate::settings_store;

pub(crate) const MARKERS_FILE: &str = "markers.json";

/// Broadcast after every successful marker write: the overlay windows (Tab
/// table, aim card, chat) each hold their own one-shot copy of the list and
/// re-fetch on this event instead of going stale mid-session.
pub(crate) const MARKERS_CHANGED_EVENT: &str = "wowsp://markers-changed";

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Nickname equality: unicode-aware lowercase (CJK has no case; latin
/// nicknames compare case-insensitively), trimmed.
pub(crate) fn same_nickname(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Tolerant read: unreadable or unparsable files count as an EMPTY list —
/// the file is data-cache JSON, never a settings file (settings-store
/// conventions; the next write heals it).
pub(crate) fn load_markers_from(dir: &Path) -> Vec<MarkerEntry> {
    let raw = match std::fs::read_to_string(dir.join(MARKERS_FILE)) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// The persisted list (settings page + every battle-marker surface).
pub(crate) fn load_markers() -> Vec<MarkerEntry> {
    match paths::ensure_data_dir() {
        Ok(dir) => load_markers_from(&dir),
        Err(_) => Vec::new(),
    }
}

/// Atomic write behind the shared settings-store gate.
pub(crate) fn store_markers(dir: &Path, markers: &[MarkerEntry]) -> Result<()> {
    let json = serde_json::to_string(markers).map_err(|e| anyhow!("serialize markers: {e}"))?;
    settings_store::store(dir, MARKERS_FILE, &json)
}

// ── commands ─────────────────────────────────────────────────────────────────

/// The local marker list (settings page + battle-marker surfaces).
#[tauri::command]
pub fn markers_list() -> CommandResult<Vec<MarkerEntry>> {
    Ok(load_markers())
}

/// Add or update one marker — the same nickname (case-insensitive) UPSERTS:
/// color/note update in place, an arriving account id fills the blank.
/// Returns the full list so the webui store stays in lock-step with disk.
/// Main window only.
#[tauri::command]
pub fn markers_add(
    window: tauri::Window,
    nickname: String,
    color: MarkerColor,
    note: Option<String>,
    account_id: Option<i64>,
) -> CommandResult<Vec<MarkerEntry>> {
    ensure_main_window_label(window.label())?;
    let trimmed = nickname.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("marker nickname is empty").into());
    }
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    let mut markers = load_markers_from(&dir);
    match markers
        .iter_mut()
        .find(|m| same_nickname(&m.nickname, trimmed))
    {
        Some(existing) => {
            existing.color = color;
            existing.note = note;
            if account_id.is_some() {
                existing.account_id = account_id;
            }
        },
        None => markers.push(MarkerEntry {
            nickname: trimmed.to_string(),
            color,
            note,
            account_id,
            created_at: unix_now(),
        }),
    }
    store_markers(&dir, &markers).map_err(|e| anyhow!("store markers: {e:#}"))?;
    let _ = window.app_handle().emit(MARKERS_CHANGED_EVENT, ());
    Ok(markers)
}

/// Remove one marker by nickname (case-insensitive). Returns the remaining
/// list. Main window only.
#[tauri::command]
pub fn markers_remove(window: tauri::Window, nickname: String) -> CommandResult<Vec<MarkerEntry>> {
    ensure_main_window_label(window.label())?;
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    let mut markers = load_markers_from(&dir);
    markers.retain(|m| !same_nickname(&m.nickname, &nickname));
    store_markers(&dir, &markers).map_err(|e| anyhow!("store markers: {e:#}"))?;
    let _ = window.app_handle().emit(MARKERS_CHANGED_EVENT, ());
    Ok(markers)
}
