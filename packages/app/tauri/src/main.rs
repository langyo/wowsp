//! WoWSP desktop binary — a thin wrapper around the lib bootstrap
//! (`wowsp_tauri::run`, see `src/lib.rs`). The real entry point lives in the
//! lib so the Android build (a cdylib with `#[tauri::mobile_entry_point]`)
//! and this desktop bin share one code path.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wowsp_tauri::run()
}
