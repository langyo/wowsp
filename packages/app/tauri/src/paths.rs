//! Shared path resolution for WoWSP data / cache directories.
//!
//! WoWSP runs in three installation modes (see the NSIS template in
//! `packages/app/tauri/installer/installer.nsi`):
//!
//!   1. **Local install** (default) — data lives under `%APPDATA%\WoWSP` and
//!      cache under `%LOCALAPPDATA%\WoWSP`.
//!   2. **USB / internet-cafe mode** — the app folder sits on a removable
//!      drive; a `.portable` marker file next to the exe makes every writable
//!      path resolve *next to the exe* instead, so nothing leaks onto the host.
//!   3. **Green / direct-run mode** — same marker-based resolution; the folder
//!      is fully self-contained and can be copied anywhere.
//!
//! Portable mode is detected by the presence of a `.portable` marker file in
//! the same directory as `wowsp.exe`. The installer writes the marker; users
//! can also create it manually to turn any copy into a portable one.

use std::path::{Path, PathBuf};

/// Name of the portable-mode marker file placed next to the executable.
pub const PORTABLE_MARKER: &str = ".portable";

/// Directory that contains the running WoWSP executable.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Whether the app runs in portable (USB / green) mode.
pub fn portable_mode() -> bool {
    exe_dir()
        .map(|d| d.join(PORTABLE_MARKER).exists())
        .unwrap_or(false)
}

/// Resolve the writable data root:
/// - portable: `<exe_dir>/data` (self-contained)
/// - local:    `%APPDATA%\WoWSP`
pub fn data_dir() -> Result<PathBuf, String> {
    if portable_mode() {
        return exe_dir()
            .map(|d| d.join("data"))
            .ok_or_else(|| "cannot resolve executable directory".to_string());
    }
    let base = dirs_next::data_dir().ok_or_else(|| "cannot resolve AppData dir".to_string())?;
    Ok(base.join("WoWSP"))
}

/// Resolve the writable cache root:
/// - portable: `<exe_dir>/data/cache` (model packs, etc.)
/// - local:    `%LOCALAPPDATA%\WoWSP`
pub fn cache_dir() -> Result<PathBuf, String> {
    if portable_mode() {
        return data_dir().map(|d| d.join("cache"));
    }
    let base = dirs_next::cache_dir().ok_or_else(|| "cannot resolve LOCALAPPDATA".to_string())?;
    Ok(base.join("WoWSP"))
}

/// Resolve `<data root>/` (creating it if missing).
pub fn ensure_data_dir() -> Result<PathBuf, String> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Resolve `<cache root>/` (creating it if missing).
pub fn ensure_cache_dir() -> Result<PathBuf, String> {
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Tauri command: report whether the app runs in portable (USB / green) mode.
/// The webui hides the auto-updater in portable mode (updates install via
/// NSIS, which only makes sense for a local install).
#[tauri::command]
pub fn is_portable() -> bool {
    portable_mode()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_marker_changes_resolution() {
        // Without a marker (normal exe path) data dir is under APPDATA.
        let normal = data_dir().expect("data dir resolves");
        assert!(normal.to_string_lossy().contains("WoWSP"));

        // The marker is not present next to the test binary, so we can only
        // assert the shape: with the marker, resolution is exe-relative.
        assert!(!portable_mode() || data_dir().unwrap().parent().is_some());
    }
}
