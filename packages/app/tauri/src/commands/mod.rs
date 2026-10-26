//! Tauri IPC command modules. Each module groups commands by WoWSP capability.
//!
//! Every command here is the wire boundary between the webui and Rust. Keep
//! signatures thin and DTOs in `wowsp_tauri_shared` so the frontend can mirror
//! them via `@wowsp/shared_ui`.

/// Audit P0-5: the state-changing commands (export writes, installs,
/// pairing server, appdata writes) are callable from the MAIN webview
/// only. The other windows — `overlay`, `aim-card`, `tray-panel` — load
/// trimmed entry pages that never invoke them (the overlay is driven by
/// Rust-emitted events; the tray panel calls exactly one action command),
/// and a compromised overlay webview must not inherit the main window's
/// authority. Commands opt in by taking `window: tauri::Window` and
/// calling this with `window.label()`.
pub(crate) fn ensure_main_window_label(label: &str) -> CommandResult<()> {
    if label == "main" {
        Ok(())
    } else {
        Err(anyhow::anyhow!("command only available in the main window").into())
    }
}

pub mod app_migrations;
pub mod appdata;
pub mod arena_info;
pub mod blacklist;
pub mod changelog;
// Chat-translation settings + provider connectivity test (settings →
// 聊天翻译). Cross-platform: appdata + the proxy-aware HTTP client only.
pub mod chat_translate;
pub mod contribution;
pub mod data_pack;
#[cfg(feature = "ai")]
pub mod decision_ai;
pub mod decision_pack;
#[cfg(feature = "ai")]
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
pub mod ingame_plugin;
pub mod installer;
pub mod logs;
pub mod lookup_error;
pub mod media;
pub mod mod_catalog;
pub mod mod_hub;
pub mod mod_install;
pub mod mod_tags;
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
pub mod probe_arena;
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
use wowsp_tauri_shared::CommandResult;
use wowsp_tauri_shared::RuntimeCapabilities;

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

/// Runtime capability flags the webui probes once at startup. `ai` is a
/// COMPILE-TIME feature (the portable single-exe build passes
/// `--no-default-features --features portable`), so it cannot be inferred
/// from `is_portable` alone: a custom build may also drop the AI feature.
/// `directml_required` marks the Windows AI builds whose installer carries
/// `DirectML.dll` beside the exe; `directml_present`/`directml_bytes` probe
/// the file on every Windows build so a broken install is diagnosable
/// instead of a loader dialog. Only a plausible PE image counts — a
/// zero-byte or truncated file must not read as present.
#[tauri::command]
pub fn get_runtime_capabilities() -> RuntimeCapabilities {
    let directml = probe_directml();
    RuntimeCapabilities {
        ai_inference: cfg!(feature = "ai"),
        portable: crate::paths::portable_mode(),
        directml_required: cfg!(all(windows, feature = "ai")),
        directml_present: directml.is_some(),
        directml_bytes: directml,
    }
}

#[cfg(windows)]
fn probe_directml() -> Option<u64> {
    use std::io::Read;
    // Keep the floor in sync with build_installers.py's stage_directml.
    const MIN_BYTES: u64 = 1_000_000;
    let path = crate::paths::exe_dir()?.join("DirectML.dll");
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() < MIN_BYTES {
        return None;
    }
    let mut magic = [0u8; 2];
    std::fs::File::open(&path)
        .ok()?
        .read_exact(&mut magic)
        .ok()?;
    (magic == *b"MZ").then_some(meta.len())
}

#[cfg(not(windows))]
fn probe_directml() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::{get_build_identity, get_runtime_capabilities};

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

    /// The capability probe must mirror the compiled feature set — the
    /// portable artifact is built with `--no-default-features` and relies
    /// on this flag to disable the AI surfaces.
    #[test]
    fn runtime_capabilities_reflect_the_compiled_features() {
        let caps = get_runtime_capabilities();
        assert_eq!(caps.ai_inference, cfg!(feature = "ai"));
        assert_eq!(caps.directml_required, cfg!(all(windows, feature = "ai")));
    }
}

/// Hard-quit the app. Triggers graceful drain of background tasks, then
/// exits the process. Called from the frontend close-confirm dialog.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    tracing::info!("quit_app: beginning graceful drain + exit");
    graceful_exit(&app);
}

/// The shared teardown behind every deliberate exit: flush the playtime
/// ledger's last heartbeat, begin the graceful drain, then exit. A
/// graceful exit matters as much for the update handoff as for the close
/// dialog — the WebView2 children close with the app, so nothing of this
/// process keeps the install directory pinned against the installer's
/// atomic swap.
pub(crate) fn graceful_exit(app: &tauri::AppHandle) {
    use tauri::Manager;
    // Flush the playtime ledger's last heartbeat before the drain: the open
    // session stays open (the game may outlive the shell) but its recorded
    // end must not fall an entire shutdown behind.
    playtime::flush();
    if let Some(d) = app.try_state::<malkuth::DrainController>() {
        d.begin_drain(malkuth::ShutdownKind::Graceful);
    }
    app.exit(0);
}

#[cfg(test)]
mod window_gate_tests {
    use super::ensure_main_window_label;

    #[test]
    fn mutating_commands_are_main_window_only() {
        assert!(ensure_main_window_label("main").is_ok());
        for label in ["overlay", "aim-card", "tray-panel", "", "main-evil"] {
            assert!(
                ensure_main_window_label(label).is_err(),
                "label {label:?} must not pass the main-window gate"
            );
        }
    }
}
