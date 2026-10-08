//! Tauri IPC command modules. Each module groups commands by WoWSP capability.
//!
//! Every command here is the wire boundary between the webui and Rust. Keep
//! signatures thin and DTOs in `wowsp_tauri_shared` so the frontend can mirror
//! them via `@wowsp/shared_ui`.

pub mod app_migrations;
pub mod appdata;
pub mod arena_info;
pub mod changelog;
pub mod data_pack;
pub mod download_hub;
pub mod encyclopedia;
pub mod exports;
pub mod game_client;
pub mod game_config;
pub mod game_context;
pub mod game_detect;
pub mod game_maps;
pub mod gameparams;
pub mod github_mirror;
pub mod mod_tags;
// The 游戏内展示 bridge: answers the in-game plugin's request.json with
// stats rows (desktop only — no game client runs on the phone build).
#[cfg(desktop)]
pub mod ingame_bridge;
pub mod ingame_plugin;
pub mod installer;
pub mod logs;
pub mod lookup_error;
pub mod media;
pub mod method_tables;
pub mod method_tables_lesta;
pub mod mod_catalog;
pub mod mod_hub;
pub mod mod_install;
pub mod model_pack;
pub mod network;
pub mod open_external;
#[cfg(desktop)]
pub mod overlay;
#[cfg(mobile)]
/// Mobile stand-ins for the overlay command surface. The desktop module
/// (src/commands/overlay.rs) is a game-window capture stack — GDI BitBlt,
/// Win32 styling, a second always-on-top webview — none of which exists on a
/// phone. The registered commands stay available (the webui transport calls
/// them unconditionally) but answer with the clean
/// [`crate::mobile_unsupported::OVERLAY`] marker so the mobile UI can hide
/// the feature. `create_overlay_window` is NOT mirrored: it is desktop-only
/// in the invoke handler (no overlay window may exist on mobile).
pub mod overlay {
    use crate::mobile_unsupported::OVERLAY;

    #[tauri::command]
    pub async fn destroy_overlay_window() -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn set_overlay_visible(_visible: bool) -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn start_overlay_tab_watch() -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn stop_overlay_tab_watch() -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn start_manual_locate() -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn cancel_manual_locate() -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn set_manual_roster_rect(
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
    ) -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn clear_manual_roster_rect() -> Result<(), String> {
        Err(OVERLAY.into())
    }

    #[tauri::command]
    pub async fn capture_game_window() -> Result<wowsp_tauri_shared::CaptureResult, String> {
        Err(OVERLAY.into())
    }
}
pub mod overlay_config;
#[cfg(desktop)]
pub mod overlay_detect;
#[cfg(desktop)]
pub mod overlay_manual;
pub mod packets;
pub mod pairing;
// LAN UDP discovery for pairing (desktop broadcaster + phone listener).
pub mod pairing_discovery;
// Internet pairing relay: Cloudflare Worker tunnel (config + desktop host
// bridge + phone client transport).
pub mod pairing_relay;
pub mod playtime;
pub mod probe_roster;
pub mod ranked;
pub mod replay;
pub mod res_mods;
#[cfg(desktop)]
pub mod screenshot;
// Session hub: the Rust-side source of truth for "what is running / who is
// playing", broadcast to every window (see commands/session.rs).
pub mod session;
pub mod ship_stats;
pub mod stamps;
pub mod supporters;
// The tray panel webview window (tray.html) — desktop only, like the tray
// itself.
pub mod tab_dump;
#[cfg(desktop)]
pub mod tray_panel;
pub mod trends;
#[cfg(windows)]
pub mod update;
pub mod wallpaper;
pub mod wg_api;
pub mod wg_api_cn;
pub mod wg_composition;
pub mod wg_realm;

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
    // Flush the playtime ledger's last heartbeat before the drain: the open
    // session stays open (the game may outlive the shell) but its recorded
    // end must not fall an entire shutdown behind.
    playtime::flush();
    tracing::info!("quit_app: beginning graceful drain + exit");
    if let Some(d) = app.try_state::<malkuth::DrainController>() {
        d.begin_drain(malkuth::ShutdownKind::Graceful);
    }
    app.exit(0);
}
