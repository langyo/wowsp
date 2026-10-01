//! WoWSP Tauri shell bootstrap.
//!
//! The shell owns no business logic of its own — every capability the webui
//! needs is exposed as a `#[tauri::command]` in `commands/`, and the webui
//! reaches it through the `@wowsp/shared_ui` transport (see
//! `packages/webui/src/transport/`). This mirrors the shittim-chest pattern:
//! Rust holds the privileged operations (registry reads, screen capture, file
//! polling), the webview holds presentation.
//!
//! The bootstrap lives in a lib (not the bin) so the desktop binary
//! (`src/main.rs`) and the Android entry point (`#[tauri::mobile_entry_point]`,
//! which requires a cdylib/staticlib) share one code path — the standard
//! Tauri v2 mobile layout.
//!
//! Lifecycle: a `malkuth::DrainController` coordinates graceful shutdown.
//! Ctrl-C (via `malkuth::SignalExitSource`) and the main window's close
//! button both begin a graceful drain, so background tasks (arena watcher,
//! overlay capture) get a chance to wind down before the process exits.

// Desktop-only helpers (overlay capture stack, registry scans, pickers,
// portable-mode marker, …) compile on mobile as intentionally-dead code —
// their call sites are cfg-gated. Keep the mobile check output honest but
// quiet; the desktop build still enforces dead_code.
#![cfg_attr(mobile, allow(dead_code))]

mod commands;
mod logging;
mod os_prefs;
mod paths;
mod settings_store;
#[cfg(feature = "test-harness")]
mod test_harness;

use tauri::Manager;
#[cfg(desktop)]
use tauri::{Emitter, WindowEvent};

/// Error strings every desktop-only command returns on mobile. The frontend
/// transport surfaces command errors as rejected promises; the mobile UI
/// phases key off these markers to swap in platform-native flows instead.
pub mod mobile_unsupported {
    /// Overlay / game-capture surface (no second window, no game window on a
    /// phone).
    pub const OVERLAY: &str = "overlay is not supported on mobile";
    /// Native file/folder pickers (rfd has no Android backend).
    pub const PICKER: &str = "native file picker is not supported on mobile";
    /// Desktop pairing server (the phone is a CLIENT — it pairs to desktops,
    /// it never serves).
    pub const PAIRING: &str = "pairing server is not supported on mobile";
    /// Image clipboard write (arboard has no Android backend; the phone app's
    /// share flow falls back to the webview clipboard API or a save dialog).
    pub const CLIPBOARD_IMAGE: &str = "image clipboard is not supported on mobile";
}

/// App bootstrap shared by the desktop bin and the Android entry point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging with a compact, readable format:
    //   wowsp 00:05:32 INFO module_name  message
    // RUST_LOG overrides the default level. The target (module path) is
    // shown so you can tell wowsp's own logs apart from Tauri/reqwest/etc.
    // On desktop this also attaches the daily-rolling UTF-8 file sink the
    // settings' 问题反馈 section ships (see src/logging.rs).
    logging::init();

    // Android swaps reqwest onto rustls (see the manifest's android target
    // table): `rustls-no-provider` compiles no default crypto provider, so
    // install ring as the process default before any HTTPS client is built.
    // Desktop keeps native-tls (SChannel) and never runs this.
    #[cfg(target_os = "android")]
    {
        // install_default returns the previously-installed provider (if any)
        // — it carries no Display, so log the plain fact.
        if rustls::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            tracing::warn!("rustls ring provider already installed");
        }
    }

    // ── Graceful-shutdown coordinator (malkuth) ──────────────────────────
    //
    // Same usage as shittim-chest: a DrainController fans out a single drain
    // signal to every background task. Ctrl-C arrives through malkuth's
    // SignalExitSource; the window close button triggers drain from the
    // WindowEvent handler below.
    let drain = malkuth::DrainController::new();
    {
        let drain_for_signals = drain.clone();
        // SignalExitSource is Unix-only in full (SIGHUP/SIGQUIT), but ships a
        // Ctrl-C fallback on Windows. Run it on a side thread so it never
        // blocks the Tauri event loop.
        std::thread::Builder::new()
            .name("wowsp-signals".into())
            .spawn(move || {
                use malkuth::ExitSource;
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to build signal runtime; Ctrl-C will use default handler");
                        return;
                    }
                };
                rt.block_on(malkuth::signals::SignalExitSource.wait(drain_for_signals));
            })
            .expect("spawn signal thread");
    }

    // Corner preference last pushed to DWM for the main window (true =
    // system default / rounded): the window starts windowed, i.e. rounded.
    // Lets the resize handler below skip redundant DWM calls during the
    // per-frame Resized storm of an interactive drag.
    #[cfg(target_os = "windows")]
    let corner_rounded = std::sync::atomic::AtomicBool::new(true);

    tauri::Builder::default()
        // Default-browser hand-off for http(s) URLs (open_external) —
        // mobile-supported, replaces the Windows-only ShellExecuteW path.
        .plugin(tauri_plugin_opener::init())
        // Remote ship portraits ride the proxy-aware, disk-cached `media`
        // scheme instead of the webview hitting the WG CDN directly (see
        // commands::media + webui utils/media.ts).
        .register_asynchronous_uri_scheme_protocol("media", commands::media::handler)
        .manage(drain)
        .on_window_event(move |window, event| {
            // Close button → minimize to tray (the tray panel's "Quit" is the
            // real exit). The arena watcher / overlay capture wind down on the
            // real drain triggered by that quit. Desktop only: mobile has no
            // tray, so the system back gesture simply closes the app.
            #[cfg(desktop)]
            {
                // The tray panel hides — never closes — on blur and on
                // programmatic close requests: it is a persistent popup
                // anchored to the tray icon, and destroying it would give
                // every toggle the first-show webview load cost back. The
                // stamped hide (tray_panel::hide_panel) is what lets a tray
                // click right after the blur read as the toggle-OFF half.
                if window.label() == commands::tray_panel::TRAY_PANEL_LABEL {
                    match event {
                        WindowEvent::Focused(false) => {
                            commands::tray_panel::hide_panel(window.app_handle());
                        },
                        WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            commands::tray_panel::hide_panel(window.app_handle());
                        },
                        _ => {},
                    }
                    return;
                }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Only the main window routes to the quit-confirm dialog.
                    // Tauri raises CloseRequested for programmatic close() too
                    // (same path as a user-initiated close), so without this
                    // label check the overlay teardown that runs a few seconds
                    // after startup (realm resolved → destroy + recreate) would
                    // pop the quit dialog in the main webview.
                    if window.label() != "main" {
                        return;
                    }
                    // Prevent the default close. Emit an event to the frontend,
                    // which shows a confirm dialog (quit vs. minimize to tray).
                    tracing::info!(window = %window.label(), "window close requested → emitting close-requested event to frontend");
                    api.prevent_close();
                    let _ = window.app_handle().emit("close-requested", ());
                }
            }
            // Maximized borderless windows keep DWM's rounded corners on
            // Windows 11 (DWM only squares them for windows with a real
            // caption), leaving a notch in each corner of the maximized
            // frame. Only the main window is a resizable frameless surface —
            // the overlay pins DONOTROUND for good in overlay.rs.
            #[cfg(target_os = "windows")]
            {
                if let WindowEvent::Resized(_) = event {
                    if window.label() == "main" {
                        sync_window_corner_rounding(window, &corner_rounded);
                    }
                }
            }
            // On mobile both blocks above compile out; touch the params so the
            // closure stays warning-free.
            #[cfg(mobile)]
            {
                let _ = (window, event);
            }
        })
        .setup(|app| {
            // Path resolution needs the Tauri PathResolver on Android (see
            // paths.rs); capture the AppHandle globally before anything asks
            // for a data/cache dir.
            paths::init(app.handle().clone());

            // The in-game plugin's telemetry poller (commands/ingame_plugin):
            // broadcasts wowsp://ingame-telemetry to both surfaces — the
            // authoritative sink/order source when the roster mode is
            // "plugin" (see docs/en/designs/ingame-stats-plugin.md).
            commands::ingame_plugin::spawn_telemetry_poller(app.handle().clone());
            // The session hub's process poller (commands/session): the
            // Rust-side source of truth for "what is running / who is
            // playing", broadcast to every window as wowsp://session-changed.
            // Desktop only — mobile has no tray panel, no game process and
            // no arena watcher to feed it.
            #[cfg(desktop)]
            commands::session::spawn_session_poller(app.handle().clone());
            {
                let (data_dir, cache_dir) = (paths::data_dir(), paths::cache_dir());
                tracing::debug!(?data_dir, ?cache_dir, "writable roots resolved");
            }

            // The frontend loads 3D models through the asset protocol from
            // the model-pack cache (paths.rs conventions: %LOCALAPPDATA%\WoWSP
            // for local installs, <exe_dir>/data/cache for portable). The
            // static scope in tauri.conf.json only covers the local layout,
            // so allow the resolved cache dir here too — otherwise portable
            // installs render every convertFileSrc URL as a scope denial
            // and the holographic map silently loses all its models.
            match paths::cache_dir() {
                Ok(dir) => {
                    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
                        tracing::warn!(error = %e, ?dir, "asset scope: allow cache dir failed");
                    }
                },
                Err(e) => tracing::warn!(error = %e, "asset scope: cache dir unresolved"),
            }
            // Same deal for the custom wallpaper library (<data_dir>/wallpapers
            // — Roaming AppData locally, exe-relative in portable mode): the
            // static scope only covers the local layout, so allow the resolved
            // dir here or portable installs can't render imported backgrounds.
            match paths::data_dir().map(|d| d.join("wallpapers")) {
                Ok(dir) => {
                    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
                        tracing::warn!(error = %e, ?dir, "asset scope: allow wallpapers dir failed");
                    }
                },
                Err(e) => tracing::warn!(error = %e, "asset scope: data dir unresolved"),
            }
            // Seed OS preferences (locale + color scheme) into the webview
            // BEFORE any page JS runs, so the first paint matches the OS theme.
            let prefs = os_prefs::detect();
            let js = os_prefs::initialization_script(&prefs);
            if let Some(w) = app.handle().webview_windows().values().next() {
                // ── Taskbar + program icon (desktop) ─────────────────────
                // Set the window icon FIRST, before eval/center — both of
                // those may trigger a paint, and we want the correct icon
                // visible from the very first frame.
                //
                // The .ico embedded at build time (resource 32512) carries
                // all 7 standard sizes, but Windows caches by exe path;
                // in dev mode repeated rebuilds produce a stale low-res
                // entry.  `set_icon` at runtime overrides the live HICON
                // with a freshly‑decoded 256×256 image (ICON_BIG for
                // Alt-Tab / title bar, ICON_SMALL for the taskbar).
                // Runs in both dev & release (harmless no-op in release).
                // Requires tauri's image-png feature, which rides the
                // desktop-only target table — mobile skips the icon dance.
                #[cfg(desktop)]
                {
                    let icon_path = app
                        .path()
                        .resource_dir()
                        .ok()
                        .map(|d| d.join("icons/128x128@2x.png"))
                        .filter(|p| p.exists());
                    let dev_path = std::env::current_dir()
                        .map(|d| d.join("icons/128x128@2x.png"))
                        .ok()
                        .filter(|p| p.exists());
                    if let Some(p) = icon_path.as_ref().or(dev_path.as_ref()) {
                        if let Ok(img) = tauri::image::Image::from_path(p) {
                            if let Err(e) = w.set_icon(img) {
                                tracing::warn!(error = %e, "runtime set_icon failed");
                            }
                        }
                    }
                }

                let _ = w.eval(&js);
                // `center` is desktop-only (no window positioning on a
                // single-surface mobile layout).
                #[cfg(desktop)]
                let _ = w.center();
            }

            // ── Dev-only test control server ──────────────────────────────
            // When built with `--features test-harness`, spawn a localhost
            // HTTP server that external Python scripts use to drive eval_js +
            // capture_main_window for visual regression testing. The entire
            // module is feature-gated and is NEVER compiled into release
            // builds (cargo tauri build does not pass the feature).
            #[cfg(feature = "test-harness")]
            {
                let app_handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("wowsp-test-harness".into())
                    .spawn(move || test_harness::run(app_handle))
                    .expect("spawn test-harness thread");
            }

            // ── System tray (desktop) ────────────────────────────────────
            // The hikari-rendered tray panel (commands/tray_panel.rs) IS the
            // tray menu: ANY click (left or right — right is the habitual
            // "open tray menu" button on Windows) toggles it, and the panel
            // carries the old menu's actions (show / hide / quit, quit with
            // the graceful drain). No native menu is attached: one can't
            // have the native popup AND a custom panel on the same button,
            // and a mixed left/right split read as "half of it is still the
            // old UI" (user-reported). Escape hatch if the panel webview
            // ever fails to create: double-click still restores the main
            // window, and its close dialog offers quit. The close button
            // (above) triggers that frontend confirm dialog.
            #[cfg(desktop)]
            {
                let is_zh = prefs.locale.starts_with("zh");
                let tooltip = if is_zh {
                    "WoWSP — 战舰世界战况面板"
                } else {
                    "WoWSP — World of WarShip Panel"
                };

                // ── Tray icon (small, for notification area) ──────────
                // Windows tray icons are tiny: 16×16 at 100% DPI, 20×20 at
                // 125%, 24×24 at 150%, 32×32 at 200%. Using the default window
                // icon (256×256) forces a brutal downscale → blur. Provide a
                // purpose-sized tray source, compiled in and PNG-decoded up
                // front — never read from CWD-relative paths that don't exist
                // when installed.
                let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/32x32.png"
                ))
                .expect("embedded tray icon decodes");

                let _tray = tauri::tray::TrayIconBuilder::new()
                    .icon(tray_icon)
                    .tooltip(tooltip)
                    .on_tray_icon_event(|tray, event| {
                        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                        match event {
                            // Left OR right click → the hikari tray panel
                            // (session status + actions), anchored to the
                            // icon.
                            TrayIconEvent::Click {
                                button: MouseButton::Left | MouseButton::Right,
                                button_state: MouseButtonState::Up,
                                position,
                                rect,
                                ..
                            } => commands::tray_panel::toggle_from_tray(
                                tray.app_handle(),
                                &position,
                                &rect,
                            ),
                            // Double click keeps its legacy meaning: restore
                            // the main window. The panel (which the first
                            // click of the pair may have opened) closes so
                            // the two surfaces never overlap.
                            TrayIconEvent::DoubleClick { .. } => {
                                let app = tray.app_handle();
                                commands::tray_panel::hide_panel(app);
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.unminimize();
                                    let _ = w.set_focus();
                                }
                            },
                            _ => {},
                        }
                    })
                    .build(app)?;
            }

            // Debug-only e2e helper: bring the pairing server up at launch so
            // an emulator/device test can pair without driving the desktop UI
            // (the PIN is printed to the tracing log by the server).
            #[cfg(all(debug_assertions, desktop))]
            if std::env::var("WOWSP_AUTOSTART_PAIRING").is_ok() {
                match tauri::async_runtime::block_on(commands::pairing::pairing_start()) {
                    Ok(status) => {
                        tracing::info!(?status, "pairing server autostarted via WOWSP_AUTOSTART_PAIRING");
                    }
                    Err(e) => tracing::warn!(error = %e, "WOWSP_AUTOSTART_PAIRING failed"),
                }
            }

            // Debug-only helper: open the tray panel at launch (anchored to
            // the primary work area's bottom-right) so manual/visual checks
            // don't need a real tray click. Deferred + retried: startup focus
            // churn (the main webview finishing its load) blur-hides an
            // instantly-shown panel, so the show is re-asserted for a few
            // seconds until it sticks — debug_show is a no-op while visible.
            #[cfg(all(debug_assertions, desktop))]
            if std::env::var("WOWSP_AUTOSTART_TRAY_PANEL").is_ok() {
                let handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("wowsp-traypanel-autopen".into())
                    .spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1200));
                        for _ in 0..8 {
                            let opened = handle.clone();
                            let _ = handle.run_on_main_thread(move || {
                                commands::tray_panel::debug_show(&opened);
                            });
                            std::thread::sleep(std::time::Duration::from_millis(700));
                        }
                    })
                    .expect("spawn tray panel autopen thread");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_os_preferences,
            paths::is_portable,
            commands::appdata::appdata_read,
            commands::appdata::appdata_write,
            commands::appdata::appdata_delete,
            commands::appdata::is_game_running,
            commands::appdata::get_game_process,
            // Session hub (commands/session.rs): snapshot + the main window's
            // active-account mirror push.
            commands::session::get_session_state,
            commands::session::sync_active_account,
            // The tray panel's action buttons (desktop only — the panel
            // window itself is tray-bound).
            #[cfg(desktop)]
            commands::tray_panel::tray_panel_action,
            commands::game_detect::detect_game_install,
            commands::game_detect::set_game_path,
            commands::game_detect::pick_game_folder,
            commands::res_mods::ribbon_skin_dir,
            commands::replay::read_replay_header,
            commands::replay::read_replay_positions,
            commands::replay::list_replays,
            commands::replay::list_replays_meta,
            commands::replay::pick_replay_files,
            commands::arena_info::read_temp_arena_info,
            commands::arena_info::start_arena_watcher,
            commands::arena_info::stop_arena_watcher,
            commands::overlay::capture_game_window,
            // No overlay WINDOW on mobile at all — the whole feature assumes
            // a second always-on-top surface over a live game window.
            #[cfg(desktop)]
            commands::overlay::create_overlay_window,
            commands::overlay::destroy_overlay_window,
            commands::overlay::set_overlay_visible,
            commands::overlay::start_overlay_tab_watch,
            commands::overlay::stop_overlay_tab_watch,
            commands::overlay::start_manual_locate,
            commands::overlay::cancel_manual_locate,
            commands::overlay::set_manual_roster_rect,
            commands::overlay::clear_manual_roster_rect,
            // Desktop only (the main window's manual-locate picker layer
            // never renders on mobile, so no stand-in is mirrored).
            #[cfg(desktop)]
            commands::overlay::manual_locate_context,
            commands::network::get_network_config,
            commands::installer::installer_language,
            commands::overlay_config::get_overlay_config,
            commands::overlay_config::set_overlay_config,
            // The 游戏内展示 bridge — desktop only, same reasoning as the
            // overlay window (it answers the in-game plugin's stats
            // requests; no game client runs on the phone build).
            #[cfg(desktop)]
            commands::ingame_bridge::ingame_bridge_start,
            #[cfg(desktop)]
            commands::ingame_bridge::ingame_bridge_stop,
            commands::game_config::get_game_config,
            commands::game_config::set_game_config,
            commands::open_external::open_external,
            commands::network::set_network_config,
            // Mobile replay acquisition + desktop pairing (all targets — the
            // start/stop server commands answer with the mobile marker, the
            // client commands run anywhere, a desktop can pull from another
            // desktop).
            commands::pairing::import_replay_file,
            commands::pairing::pairing_start,
            commands::pairing::pairing_stop,
            commands::pairing::pairing_get_status,
            commands::pairing::pairing_pair,
            commands::pairing::pairing_list_remote,
            commands::pairing::pairing_pull_replay,
            commands::pairing::pairing_pull_gamedata,
            // LAN auto-discovery (phone listener; the desktop broadcaster is
            // tied to the pairing server lifecycle inside pairing_start).
            commands::pairing_discovery::pairing_discovery_start,
            commands::pairing_discovery::pairing_discovery_stop,
            // Internet relay configuration (hidden setting — no UI field; the
            // endpoint is the built-in gateway) + code regeneration.
            commands::pairing_relay::pairing_get_relay_config,
            commands::pairing_relay::pairing_set_relay,
            commands::pairing_relay::pairing_reallocate_code,
            commands::wg_api::lookup_player_stats,
            commands::wg_api::lookup_players_stats_batch,
            commands::wg_api::clear_roster_stats_cache,
            commands::wg_composition::lookup_players_composition,
            commands::wg_api::suggest_players,
            commands::wg_api::suggest_clans,
            commands::wg_api::lookup_clan_info,
            commands::encyclopedia::get_game_version,
            commands::encyclopedia::get_ship_encyclopedia,
            commands::ship_stats::lookup_player_ship_stats,
            commands::ship_stats::read_ship_stats_history,
            commands::ship_stats::snapshot_player_stats,
            commands::gameparams::get_ship_gameparams,
            commands::gameparams::get_upgrade_prices,
            commands::game_maps::list_game_maps,
            commands::data_pack::data_pack_info,
            commands::data_pack::get_ship_kit,
            commands::data_pack::refresh_data_pack,
            commands::model_pack::ensure_res_pack,
            commands::model_pack::res_cache_root,
            commands::model_pack::res_report_bundled,
            commands::model_pack::get_res_status,
            commands::model_pack::check_res_update,
            commands::model_pack::res_download,
            commands::model_pack::res_cancel,
            commands::model_pack::clear_res,
            commands::model_pack::aux_cache_overview,
            commands::model_pack::clear_aux_cache,
            commands::wallpaper::wallpaper_list,
            commands::wallpaper::wallpaper_import,
            commands::wallpaper::wallpaper_remove,
            commands::stamps::stamp_list,
            commands::stamps::stamp_import,
            commands::stamps::stamp_reset,
            commands::supporters::get_supporter_avatars,
            commands::trends::get_player_trend,
            commands::trends::get_patches,
            commands::trends::get_community_ship_trend,
            commands::trends::get_ship_server_stats,
            commands::screenshot::capture_main_window,
            commands::exports::pick_export_path,
            commands::exports::write_export_bytes,
            commands::exports::copy_image_to_clipboard,
            commands::mod_hub::mod_hub_scan_installed,
            commands::mod_hub::mod_hub_classify_path,
            commands::mod_hub::mod_hub_install,
            commands::mod_hub::mod_hub_set_unit_enabled,
            commands::mod_hub::mod_hub_uninstall_unit,
            commands::mod_hub::mod_hub_stale_versions,
            commands::mod_hub::mod_hub_migrate_stale_bin,
            commands::mod_hub::mod_hub_migration_plan,
            commands::mod_hub::mod_hub_migration_execute,
            commands::mod_hub::mod_hub_safe_mode,
            commands::mod_hub::mod_hub_set_safe_mode,
            commands::mod_catalog::mod_hub_reconcile,
            commands::mod_catalog::mod_catalog_refresh,
            commands::mod_catalog::mod_catalog_install,
            commands::mod_catalog::mod_catalog_uninstall,
            commands::mod_catalog::mod_hub_records,
            commands::mod_install::install_overlay_mod,
            commands::mod_install::uninstall_overlay_mod,
            commands::mod_install::is_overlay_mod_installed,
            commands::ingame_plugin::ingame_plugin_status,
            commands::ingame_plugin::ingame_plugin_install,
            commands::ingame_plugin::ingame_plugin_uninstall,
            commands::ranked::get_ranked_stats,
            // Changelog feed for the settings' 更新日志 section — GitHub
            // Releases via the mirror ladder; platform-neutral (the phone
            // app serves the same feed).
            commands::changelog::changelog_list,
            // Diagnostics-log surface for the settings' 问题反馈 section:
            // folder overview, explorer reveal of the newest log, tail
            // read, and the feedback zip bundle. Platform-neutral commands
            // (on mobile the file sink never attaches, so they answer
            // empty/`no log files yet` and the section hides anyway).
            commands::logs::logs_overview,
            commands::logs::logs_reveal_latest,
            commands::logs::logs_read_tail,
            commands::logs::logs_export_bundle,
            // Self-update ships a Windows NSIS installer artifact; mobile has
            // no installer flow (store updates instead) — the frontend hides
            // the updater on mobile.
            #[cfg(windows)]
            commands::update::update_check,
            #[cfg(windows)]
            commands::update::update_download,
            #[cfg(windows)]
            commands::update::update_cancel,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP tauri application");
}

/// Square the main window's corners while it is maximized, restore the system
/// default when it is not.
///
/// Windows 11 rounds the corners of every top-level window through DWM, but it
/// only squares them back on its own for windows it tracks as maximized — the
/// decorated ones. `decorations: false` windows keep the rounding through a
/// maximize, so the maximized frame ends up with a notch in each corner where
/// the desktop bleeds through. Push the corner preference explicitly instead:
/// `DONOTROUND` while maximized, `DEFAULT` (honors the user's OS-wide corner
/// setting) once restored. Overlay windows never pass through here — they pin
/// `DONOTROUND` permanently in overlay.rs.
#[cfg(target_os = "windows")]
fn sync_window_corner_rounding(win: &tauri::Window, rounded: &std::sync::atomic::AtomicBool) {
    use std::sync::atomic::Ordering;
    use windows::Win32::Graphics::Dwm::{
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT, DWMWCP_DONOTROUND, DwmSetWindowAttribute,
    };

    let should_round = !win.is_maximized().unwrap_or(false);
    if rounded.load(Ordering::Relaxed) == should_round {
        return;
    }
    let preference = if should_round {
        DWMWCP_DEFAULT
    } else {
        DWMWCP_DONOTROUND
    };
    if let Ok(hwnd) = win.hwnd() {
        let pushed = unsafe {
            DwmSetWindowAttribute(
                windows::Win32::Foundation::HWND(hwnd.0),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &(preference.0) as *const _ as *const core::ffi::c_void,
                4,
            )
        };
        // Commit the cache only after a successful push: a failure (e.g. the
        // attribute is unsupported pre-Win11) leaves the cache stale so the
        // next Resized retries instead of desyncing.
        if pushed.is_ok() {
            rounded.store(should_round, Ordering::Relaxed);
        }
    }
}
