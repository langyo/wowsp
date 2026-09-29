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

/// The embedded plugin source — the same bytes
/// `scripts/install_ingame_probe.py` copies, so a probe installed by the
/// script and one installed here are byte-identical.
const PLUGIN_SOURCE: &str = include_str!("../../../../ingame-plugin/src/Main.py");

/// Loader marker content: the game only scans `res_mods` for mods when this
/// 0-byte file exists; some modpacks (Aslain) ship it already.
const LOADER_MARKER: &str = "PnFModsLoader.py";

/// Install the plugin into the active install: `PnFMods/WoWSPProbe/Main.py`
/// plus the 0-byte loader marker when missing. Gated like every res_mods
/// mutation (mod-hub gate, game closed, res_mods active). Idempotent — an
/// existing Main.py is overwritten in place (a broken install can be
/// reinstalled over).
#[tauri::command]
pub async fn ingame_plugin_install(game_root: String) -> Result<String, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    super::mod_hub::ensure_res_mods_active(&game_root)?;
    let dir = super::game_context::res_mods_dir(std::path::Path::new(&game_root))?;
    let mod_dir = dir.join("PnFMods").join(MOD_DIR);
    std::fs::create_dir_all(&mod_dir).map_err(|e| format!("create {}: {e}", mod_dir.display()))?;
    let entry = mod_dir.join(MOD_ENTRY);
    std::fs::write(&entry, PLUGIN_SOURCE).map_err(|e| format!("write {}: {e}", entry.display()))?;
    let loader = dir.join(LOADER_MARKER);
    if !loader.exists() {
        std::fs::write(&loader, "").map_err(|e| format!("write {}: {e}", loader.display()))?;
    }
    tracing::info!(dir = %mod_dir.display(), "ingame plugin installed");
    Ok(mod_dir.to_string_lossy().into_owned())
}

/// Remove the plugin files. Idempotent. The loader marker is deleted only
/// when it is the 0-byte file this install layout uses AND no other PnF
/// mod remains that would rely on it — a marker another modpack created
/// (or needs) must survive.
#[tauri::command]
pub async fn ingame_plugin_uninstall(game_root: String) -> Result<(), String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    super::mod_hub::ensure_res_mods_active(&game_root)?;
    let dir = super::game_context::res_mods_dir(std::path::Path::new(&game_root))?;
    let mod_dir = dir.join("PnFMods").join(MOD_DIR);
    if mod_dir.is_dir() {
        std::fs::remove_dir_all(&mod_dir)
            .map_err(|e| format!("remove {}: {e}", mod_dir.display()))?;
    }
    let loader = dir.join(LOADER_MARKER);
    let pnf = dir.join("PnFMods");
    let other_mods = pnf
        .read_dir()
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().is_dir() && e.path().join(MOD_ENTRY).is_file())
        })
        .unwrap_or(false);
    if !other_mods && loader.is_file() && std::fs::metadata(&loader).is_ok_and(|m| m.len() == 0) {
        let _ = std::fs::remove_file(&loader);
    }
    tracing::info!(dir = %dir.display(), "ingame plugin uninstalled");
    Ok(())
}
