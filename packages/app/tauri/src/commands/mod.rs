//! Tauri IPC command modules. Each module groups commands by WoWSP capability.
//!
//! Every command here is the wire boundary between the webui and Rust. Keep
//! signatures thin and DTOs in `wowsp_tauri_shared` so the frontend can mirror
//! them via `@wowsp/shared_ui`.

pub mod appdata;
pub mod arena_info;
pub mod encyclopedia;
pub mod game_detect;
pub mod gameparams;
pub mod mod_install;
pub mod model_pack;
pub mod overlay;
pub mod packets;
pub mod ranked;
pub mod replay;
pub mod screenshot;
pub mod ship_stats;
pub mod trends;
pub mod wg_api;

use crate::os_prefs::OsPreferences;

/// Sync convenience: hand the cached OS prefs (detected at startup) to the
/// webui without an extra detect round-trip.
#[tauri::command]
pub fn get_os_preferences() -> OsPreferences {
    crate::os_prefs::detect()
}

/// Hard-quit the app. Triggers graceful drain of background tasks, then
/// exits the process. Called from the frontend close-confirm dialog.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    use tauri::Manager;
    tracing::info!("quit_app: beginning graceful drain + exit");
    if let Some(d) = app.try_state::<malkuth::DrainController>() {
        d.begin_drain(malkuth::ShutdownKind::Graceful);
    }
    app.exit(0);
}
