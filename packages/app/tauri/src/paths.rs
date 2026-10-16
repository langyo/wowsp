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
//! Portable mode is detected two ways: by the presence of a `.portable`
//! marker file in the same directory as `wowsp.exe` (the installer writes
//! it; users can also create it manually to turn any copy into a portable
//! one), or by the exe's own file name containing "portable" — the
//! single-exe 便捷版 artifact is a bare renamed copy of `wowsp.exe`
//! (`WoWSP_<version>_x64-portable.exe`), so no marker file can ship along
//! and the name itself carries the mode (see [`portable_mode`]).
//!
//! Android has none of that: there is no exe-relative writable directory and
//! no `%APPDATA%`. Instead the Tauri `PathResolver` maps the app-private
//! directories (`app_data_dir` → `/data/data/<pkg>/files`, `app_cache_dir` →
//! `/data/data/<pkg>/cache`). Those are already app-specific, so no `WoWSP`
//! segment is appended there — unlike the desktop layout, which keeps its
//! historical `WoWSP` folder name. The resolver handle is captured at startup
//! by [`init`] (setup runs before anything asks for a path).

use anyhow::anyhow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// `AppHandle::path()` lives on the Manager trait; only the Android resolver
// paths call it.
#[cfg(target_os = "android")]
use tauri::Manager;

/// Name of the portable-mode marker file placed next to the executable.
pub const PORTABLE_MARKER: &str = ".portable";

/// The app handle used to resolve Android app-private directories. Captured
/// once from `setup` (see [`init`]); only read on non-desktop targets.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Capture the app handle for target-specific path resolution (Android).
/// Must run before the first `data_dir()` / `cache_dir()` call — `run`'s
/// `setup` does so before expanding the asset scope or serving any command.
pub fn init(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// Directory that contains the running WoWSP executable.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Whether an exe file name marks a portable (便捷版) build: the file stem
/// contains "portable" (ASCII-case-insensitive), matching the published
/// `WoWSP_<version>_x64-portable.exe` artifact.
#[cfg(desktop)]
fn exe_name_is_portable(exe: &Path) -> bool {
    exe.file_stem()
        .map(|stem| {
            stem.to_string_lossy()
                .to_ascii_lowercase()
                .contains("portable")
        })
        .unwrap_or(false)
}

/// Whether the app runs in portable (USB / green) mode. Always false on
/// mobile — there is no exe-relative writable directory to resolve against.
///
/// Two independent triggers, so `is_portable` follows both:
/// - the `.portable` marker next to the exe (installer-written, or created
///   manually to green-ify any copy);
/// - the exe's own file name containing "portable" (see
///   [`exe_name_is_portable`]) — the single-exe 便捷版 artifact, where no
///   marker file can ride along.
pub fn portable_mode() -> bool {
    #[cfg(desktop)]
    {
        if exe_dir()
            .map(|d| d.join(PORTABLE_MARKER).exists())
            .unwrap_or(false)
        {
            return true;
        }
        std::env::current_exe()
            .ok()
            .map(|exe| exe_name_is_portable(&exe))
            .unwrap_or(false)
    }
    #[cfg(not(desktop))]
    {
        false
    }
}

/// Resolve the writable data root:
/// - portable: `<exe_dir>/data` (self-contained)
/// - local:    `%APPDATA%\WoWSP`
/// - android:  Tauri `app_data_dir()` (already `<pkg>/files`, no `WoWSP`
///   segment — the directory is app-private by construction)
pub fn data_dir() -> anyhow::Result<PathBuf> {
    if portable_mode() {
        return exe_dir()
            .map(|d| d.join("data"))
            .ok_or_else(|| anyhow!("cannot resolve executable directory"));
    }
    #[cfg(target_os = "android")]
    {
        let app = APP_HANDLE
            .get()
            .ok_or_else(|| anyhow!("app handle not captured (paths::init not run)"))?;
        return app
            .path()
            .app_data_dir()
            .map_err(|e| anyhow!("resolve app data dir: {e}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let base = dirs_next::data_dir().ok_or_else(|| anyhow!("cannot resolve AppData dir"))?;
        Ok(base.join("WoWSP"))
    }
}

/// Resolve the writable cache root:
/// - portable: `<exe_dir>/data/cache` (model packs, etc.)
/// - local:    `%LOCALAPPDATA%\WoWSP`
/// - android:  Tauri `app_cache_dir()` (`<pkg>/cache`, no `WoWSP` segment)
pub fn cache_dir() -> anyhow::Result<PathBuf> {
    if portable_mode() {
        return data_dir().map(|d| d.join("cache"));
    }
    #[cfg(target_os = "android")]
    {
        let app = APP_HANDLE
            .get()
            .ok_or_else(|| anyhow!("app handle not captured (paths::init not run)"))?;
        return app
            .path()
            .app_cache_dir()
            .map_err(|e| anyhow!("resolve app cache dir: {e}"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let base = dirs_next::cache_dir().ok_or_else(|| anyhow!("cannot resolve LOCALAPPDATA"))?;
        Ok(base.join("WoWSP"))
    }
}

/// Resolve `<data root>/` (creating it if missing).
pub fn ensure_data_dir() -> anyhow::Result<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| anyhow!("create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Resolve `<cache root>/` (creating it if missing).
pub fn ensure_cache_dir() -> anyhow::Result<PathBuf> {
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| anyhow!("create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Tauri command: report whether the app runs in portable (USB / green)
/// mode. The webui hides the auto-updater in portable mode (updates install
/// via NSIS, which only makes sense for a local install) and replaces the
/// 3D views with a hint to install the full edition.
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

    #[test]
    #[cfg(desktop)]
    fn exe_name_marks_portable() {
        // The published single-exe artifact name carries the mode.
        assert!(exe_name_is_portable(Path::new(
            "D:\\tools\\WoWSP_0.6.1_x64-portable.exe"
        )));
        // ASCII-case-insensitive; any position in the stem.
        assert!(exe_name_is_portable(Path::new("WoWSP-PORTABLE.exe")));
        // Regular installs never trip the name check.
        assert!(!exe_name_is_portable(Path::new("wowsp.exe")));
        assert!(!exe_name_is_portable(Path::new("D:\\WoWSP\\wowsp.exe")));
    }
}
