//! Tauri IPC command modules. Each module groups commands by WoWSP capability.
//!
//! Every command here is the wire boundary between the webui and Rust. Keep
//! signatures thin and DTOs in `wowsp_tauri_shared` so the frontend can mirror
//! them via `@wowsp/shared_ui`.

pub mod app_migrations;
pub mod appdata;
pub mod arena_info;
pub mod changelog;
pub mod contribution;
pub mod data_pack;
pub mod decision_ai;
pub mod decision_serve;
pub mod decision_tick;
pub mod download_hub;
pub mod encyclopedia;
pub mod exports;
pub mod fire_dataset;
pub mod game_client;
pub mod game_config;
pub mod game_context;
pub mod game_detect;
pub mod game_maps;
pub mod gameparams;
pub mod github_mirror;
pub mod tactics_profile;
// Consent-gated hardware & environment report for the feedback bundle
// (see the module docs for the privacy flow + elevated self-relaunch).
pub mod hardware_info;
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
/// (src/commands/overlay/) is a game-window capture stack — GDI BitBlt,
/// Win32 styling, a second always-on-top webview — none of which exists on a
/// phone. The registered commands stay available (the webui transport calls
/// them unconditionally) but answer with the clean
/// [`crate::mobile_unsupported::OVERLAY`] marker so the mobile UI can hide
/// the feature. `create_overlay_window` is NOT mirrored: it is desktop-only
/// in the invoke handler (no overlay window may exist on mobile).
pub mod overlay {
    use anyhow::anyhow;

    use wowsp_tauri_shared::CommandResult;

    use crate::mobile_unsupported::OVERLAY;

    #[tauri::command]
    pub async fn destroy_overlay_window() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn set_overlay_visible(_visible: bool) -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn start_overlay_tab_watch() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn stop_overlay_tab_watch() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn start_manual_locate() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn cancel_manual_locate() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn set_manual_roster_rect(
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
        _frame_game_rect: Option<wowsp_tauri_shared::Rect>,
    ) -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn manual_locate_context_for(
        _source: Option<wowsp_tauri_shared::ManualLocateSource>,
    ) -> CommandResult<wowsp_tauri_shared::ManualLocateContext> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn manual_locate_gallery()
    -> CommandResult<Vec<wowsp_tauri_shared::ManualLocateGalleryFrame>> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn start_calibration_locate() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn overlay_calibration_list()
    -> CommandResult<Vec<wowsp_tauri_shared::CalibrationClientInfo>> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn set_calibration_anchor(
        _client_key: String,
        _class: String,
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
        _source: Option<wowsp_tauri_shared::ManualLocateSource>,
    ) -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn clear_manual_roster_rect() -> CommandResult<()> {
        Err(anyhow!(OVERLAY).into())
    }

    #[tauri::command]
    pub async fn capture_game_window() -> CommandResult<wowsp_tauri_shared::CaptureResult> {
        Err(anyhow!(OVERLAY).into())
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
pub mod release_digest;
pub mod replay;
pub mod replay_probe;
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
pub mod terrain_los;
#[cfg(desktop)]
pub mod tray_panel;
pub mod trends;
// Duplicate-install hygiene: detect (and offer to remove) the leftover a
// pre-0.6.26 silent update could leave on the default path. Windows only,
// like the updater whose bug it cleans up after.
#[cfg(windows)]
pub mod duplicate_install;
#[cfg(windows)]
pub mod update;
// Per-host upstream health registry behind the title bar's fault chip.
pub mod upstream_health;
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

/// Debug-build identity stamp (`branch:hash7`) for the title bar's version
/// subtitle, resolved at compile time by build.rs from the git checkout —
/// it pins which branch and commit a running debug binary came from (the
/// same convention as the celestia family's panel build stamp). Release
/// builds answer "" so the suffix never ships: build.rs only exports the
/// env var for the debug profile, hence `option_env!`.
#[tauri::command]
pub fn get_build_identity() -> &'static str {
    if cfg!(debug_assertions) {
        option_env!("WOWSP_BUILD_IDENTITY").unwrap_or_default()
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::get_build_identity;

    /// The stamp shape the title bar contract promises: `branch:hash7+`
    /// (git lengthens the short hash on prefix collisions; uppercase hex
    /// is accepted, matching build.rs's resolver-side validation).
    fn is_well_formed(stamp: &str) -> bool {
        match stamp.split_once(':') {
            Some((branch, hash)) => {
                !branch.is_empty()
                    && (7..=40).contains(&hash.len())
                    && hash.chars().all(|c| c.is_ascii_hexdigit())
            },
            None => false,
        }
    }

    #[test]
    fn stamp_shape_contract() {
        assert!(is_well_formed("master:05b69ad"));
        assert!(is_well_formed("feat/titlebar-build-identity:2CB4E90"));
        // 40-char full hash.
        assert!(is_well_formed(
            "detached:0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(!is_well_formed(""));
        assert!(!is_well_formed("master"));
        assert!(!is_well_formed("master:"));
        assert!(!is_well_formed(":05b69ad"));
        assert!(!is_well_formed("master:05b69"));
        assert!(!is_well_formed("master:05b69zz"));
    }

    /// The live stamp — debug builds resolve it from the git checkout at
    /// compile time, release builds carry none — must hold the shape the
    /// frontend renders verbatim next to the version.
    #[test]
    fn live_stamp_is_well_formed_when_present() {
        let stamp = get_build_identity();
        if !stamp.is_empty() {
            assert!(is_well_formed(stamp), "malformed build stamp: {stamp}");
        }
    }
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
