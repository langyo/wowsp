//! Tauri IPC command modules. Each module groups commands by WoWSP capability.
//!
//! Every command here is the wire boundary between the webui and Rust. Keep
//! signatures thin and DTOs in `wowsp_tauri_shared` so the frontend can mirror
//! them via `@wowsp/shared_ui`.

pub mod appdata;
pub mod arena_info;
pub mod game_detect;
pub mod mod_install;
pub mod overlay;
pub mod packets;
pub mod replay;
pub mod wg_api;

use crate::os_prefs::OsPreferences;

/// Sync convenience: hand the cached OS prefs (detected at startup) to the
/// webui without an extra detect round-trip.
#[tauri::command]
pub fn get_os_preferences() -> OsPreferences {
    crate::os_prefs::detect()
}
