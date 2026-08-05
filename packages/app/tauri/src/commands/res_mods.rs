//! res_mods ribbon-skin discovery.
//!
//! The game lets mods replace HUD art via `res_mods/<version>/gui/ribbons/`.
//! The replay viewer prefers those skins at runtime and falls back to the
//! bundled art (packages/webui/src/res/images/ribbons). This module finds the
//! res_mods ribbons directory under a game install (the deepest one wins —
//! res_mods may hold several versioned mod folders).

use std::path::{Path, PathBuf};

/// Locate the deepest `gui/ribbons` directory under `game_path/res_mods`.
/// Returns None when the game has no res_mods ribbon skins installed.
#[tauri::command]
pub fn ribbon_skin_dir(game_path: String) -> Option<String> {
    let root = Path::new(&game_path).join("res_mods");
    if !root.is_dir() {
        return None;
    }
    let mut best: Option<(usize, PathBuf)> = None;
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n == "ribbons") && p.parent().is_some_and(|g| g.file_name().is_some_and(|n| n == "gui")) {
                    let depth = p.components().count();
                    if best.as_ref().is_none_or(|(d, _)| depth > *d) {
                        best = Some((depth, p.clone()));
                    }
                }
                stack.push(p);
            }
        }
    }
    best.map(|(_, p)| p.to_string_lossy().into_owned())
}
