//! In-game stats plugin status detection.
//!
//! The plugin (`packages/ingame-plugin`, design in
//! `docs/en/designs/ingame-stats-plugin.md`) is a PnFMods mod the app drops
//! into the game's `res_mods` so live-battle telemetry can flow through a
//! file bridge. This command family feeds the settings UI: the 名单识别
//! "plugin detection" option stays greyed until the mod is present in the
//! active install, and its page button deep-links the GitHub Discussions
//! resource thread.

use serde::Serialize;

/// The plugin's resource thread on langyo/wowsp — the settings page builds
/// `https://github.com/langyo/wowsp/discussions/<n>` from this.
const DISCUSSION_NUMBER: u64 = 640;

/// PnFMods layout written by `scripts/install_ingame_probe.py` (and by the
/// app's own auto-install once M2 lands) — the entry file is the presence
/// probe.
const MOD_DIR: &str = "WoWSPProbe";
const MOD_ENTRY: &str = "Main.py";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngamePluginStatus {
    /// Whether the plugin's entry file exists in the install's res_mods.
    pub installed: bool,
    /// The res_mods directory that was inspected (diagnostics for the UI).
    pub res_mods: String,
    /// GitHub discussion thread backing the plugin's mod-hub page.
    pub discussion: u64,
}

/// Report whether the in-game stats plugin is present in a game install.
/// Read-only — unlike the install commands it takes no mod-hub gate, so the
/// settings page can poll it freely.
#[tauri::command]
pub fn ingame_plugin_status(game_root: String) -> Result<IngamePluginStatus, String> {
    let dir = super::game_context::res_mods_dir(std::path::Path::new(&game_root))?;
    let installed = dir.join("PnFMods").join(MOD_DIR).join(MOD_ENTRY).is_file();
    Ok(IngamePluginStatus {
        installed,
        res_mods: dir.to_string_lossy().into_owned(),
        discussion: DISCUSSION_NUMBER,
    })
}
