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

    let drain_for_window = drain.clone();

    tauri::Builder::default()
        .manage(drain)
        .on_window_event(move |window, event| {
            // Close button → graceful drain. The arena watcher / overlay
            // capture listen on the drain and wind down before the process
            // exits, so we never leave the game's tempArenaInfo.json poller
            // running or the overlay window stuck on screen.
            if let WindowEvent::CloseRequested { .. } = event {
                tracing::info!(window = %window.label(), "window close requested → graceful drain");
                drain_for_window.begin_drain(malkuth::ShutdownKind::Graceful);
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_os_preferences,
            commands::game_detect::detect_game_install,
            commands::game_detect::set_game_path,
            commands::replay::read_replay_header,
            commands::replay::read_replay_positions,
            commands::replay::list_replays,
            commands::arena_info::read_temp_arena_info,
            commands::arena_info::start_arena_watcher,
            commands::arena_info::stop_arena_watcher,
            commands::overlay::capture_game_window,
            commands::overlay::set_overlay_visible,
            commands::wg_api::lookup_player_stats,
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
