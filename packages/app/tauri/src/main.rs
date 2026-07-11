//! WoWSP Tauri desktop shell entry point.
//!
//! The shell owns no business logic of its own — every capability the webui
//! needs is exposed as a `#[tauri::command]` in `commands/`, and the webui
//! reaches it through the `@wowsp/shared_ui` transport (see
//! `packages/webui/src/transport/`). This mirrors the shittim-chest pattern:
//! Rust holds the privileged operations (registry reads, screen capture, file
//! polling), the webview holds presentation.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod os_prefs;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

fn main() {
    // Initialize structured logging. RUST_LOG overrides the default level.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("wowsp=info,warn")),
        )
        .init();

    tauri::Builder::default()
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
            commands::replay::list_replays,
            commands::arena_info::read_temp_arena_info,
            commands::arena_info::start_arena_watcher,
            commands::arena_info::stop_arena_watcher,
            commands::overlay::capture_game_window,
            commands::overlay::set_overlay_visible,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP tauri application");
}
