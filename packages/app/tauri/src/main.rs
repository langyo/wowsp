//! WoWSP Tauri desktop shell entry point.
//!
//! The shell owns no business logic of its own — every capability the webui
//! needs is exposed as a `#[tauri::command]` in `commands/`, and the webui
//! reaches it through the `@wowsp/shared_ui` transport (see
//! `packages/webui/src/transport/`). This mirrors the shittim-chest pattern:
//! Rust holds the privileged operations (registry reads, screen capture, file
//! polling), the webview holds presentation.
//!
//! Lifecycle: a `malkuth::DrainController` coordinates graceful shutdown.
//! Ctrl-C (via `malkuth::SignalExitSource`) and the main window's close
//! button both begin a graceful drain, so background tasks (arena watcher,
//! overlay capture) get a chance to wind down before the process exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod os_prefs;

use std::sync::Arc;

use tauri::{Manager, WindowEvent};
use tracing_subscriber::EnvFilter;

fn main() {
    // Initialize structured logging. RUST_LOG overrides the default level.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("wowsp=info,warn")),
        )
        .init();

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

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(drain)
        .on_window_event(move |window, event| {
            // Close button → minimize to tray (the tray's "Quit" is the real
            // exit). The arena watcher / overlay capture wind down on the real
            // drain triggered by the tray Quit item.
            if let WindowEvent::CloseRequested { api, .. } = event {
                tracing::info!(window = %window.label(), "window close requested → minimize to tray");
                api.prevent_close();
                let _ = window.minimize();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Seed OS preferences (locale + color scheme) into the webview
            // BEFORE any page JS runs, so the first paint matches the OS theme.
            let prefs = os_prefs::detect();
            let js = os_prefs::initialization_script(&prefs);
            if let Some(w) = app.handle().webview_windows().values().next() {
                let _ = w.eval(&js);
                let _ = w.center();
            }

            // ── Auto-test trigger ─────────────────────────────────────────
            // When WOWSP_AUTOTEST=1 is set, wait for the webview to mount, then
            // invoke the frontend test harness via eval. This bypasses URL
            // query-param issues in Tauri's dev URL handling.
            if std::env::var("WOWSP_AUTOTEST").as_deref() == Ok("1") {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if let Some(w) = app_handle.get_webview_window("main") {
                        tracing::info!("triggering frontend autotest harness");
                        let _ = w.eval("if (window.__wowspAutoTest__) { window.__wowspAutoTest__(); } else { console.error('[autotest] harness not loaded yet'); }");
                    }
                });
            }

            // ── System tray ───────────────────────────────────────────────
            // Menu: Show / Hide / Quit. Clicking the tray icon restores the
            // main window. The close button (above) minimizes to tray instead
            // of exiting, so users reach "Quit" here.
            let show = tauri::menu::MenuItem::with_id(app, "show", "Show WoWSP", true, None::<&str>)?;
            let hide = tauri::menu::MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit WoWSP", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &hide, &quit])?;

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("WoWSP — World of WarShip Panel")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    // Double-click (or click on some platforms) → show window.
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => {
                        tracing::info!("tray quit → graceful drain + exit");
                        // Trigger graceful drain so background tasks wind down,
                        // then exit.
                        if let Some(d) = app.try_state::<malkuth::DrainController>() {
                            d.begin_drain(malkuth::ShutdownKind::Graceful);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_os_preferences,
            commands::appdata::appdata_read,
            commands::appdata::appdata_write,
            commands::appdata::appdata_delete,
            commands::appdata::is_game_running,
            commands::game_detect::detect_game_install,
            commands::game_detect::set_game_path,
            commands::replay::read_replay_header,
            commands::replay::read_replay_positions,
            commands::replay::list_replays,
            commands::arena_info::read_temp_arena_info,
            commands::arena_info::start_arena_watcher,
            commands::arena_info::stop_arena_watcher,
            commands::overlay::capture_game_window,
            commands::overlay::create_overlay_window,
            commands::overlay::destroy_overlay_window,
            commands::overlay::set_overlay_visible,
            commands::wg_api::lookup_player_stats,
            commands::encyclopedia::get_game_version,
            commands::encyclopedia::get_ship_encyclopedia,
            commands::ship_stats::lookup_player_ship_stats,
            commands::ship_stats::snapshot_player_stats,
            commands::gameparams::get_ship_gameparams,
            commands::trends::get_player_trend,
            commands::trends::get_patches,
            commands::trends::get_community_ship_trend,
            commands::screenshot::capture_main_window,
            commands::screenshot::eval_js,
            commands::screenshot::trigger_autotest,
            commands::mod_install::install_overlay_mod,
            commands::mod_install::uninstall_overlay_mod,
            commands::mod_install::is_overlay_mod_installed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP tauri application");
}

/// Keep the `Arc` import path explicit for future state holders; the drain is
/// currently managed as `tauri::State<DrainController>` and cloned into the
/// window-event closure above.
#[allow(dead_code)]
type _Shared<T> = Arc<T>;
