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
use tauri::Emitter;

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
    /// Installed but NOT the bytes this app ships (an older build, or a
    /// hand-edited file): the UI offers a one-click update. The in-game
    /// version string is pinned at 0.1.0 by owner decision, so the content
    /// hash is the only reliable freshness signal.
    pub outdated: bool,
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
    let entry = dir.join("PnFMods").join(MOD_DIR).join(MOD_ENTRY);
    let installed = entry.is_file();
    let outdated = installed
        && match std::fs::read(&entry) {
            Ok(bytes) => {
                use sha2::{Digest, Sha256};
                let mut current = Sha256::new();
                current.update(PLUGIN_SOURCE.as_bytes());
                let mut on_disk = Sha256::new();
                on_disk.update(&bytes);
                current.finalize()[..] != on_disk.finalize()[..]
            },
            Err(_) => true, // unreadable is un-updatable — treat as stale
        };
    Ok(IngamePluginStatus {
        installed,
        outdated,
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

/// The plugin's live telemetry file for a game root — `None` when the root
/// has no versioned `bin/` layout to hang `res_mods` off.
pub(crate) fn telemetry_file(game_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = super::game_context::res_mods_dir(game_root).ok()?;
    Some(dir.join("PnFMods").join(MOD_DIR).join("telemetry.json"))
}

/// Spawn the detached telemetry poller: every 2 s it resolves the active
/// game install, reads the plugin's `telemetry.json` (written by the
/// in-game bridge on every alive-set change) and emits
/// `wowsp://ingame-telemetry` to every window when its content changed.
/// Both the live panel and the overlay window listen for the same event —
/// this is the M2 consumer that turns the plugin's observations into
/// authoritative sink marking and TAB ordering. Failures are silent: the
/// poller is a pure best-effort publisher (no plugin / no game / parse
/// hiccup all degrade to "no event this tick").
pub fn spawn_telemetry_poller(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("ingame-telemetry-poll".into())
        .spawn(move || {
            let mut last: Option<String> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let root = super::game_context::resolve_root(
                    super::game_context::RootPreference::PreferRunning,
                )
                .map(|r| r.root);
                let Some(root) = root else {
                    continue;
                };
                let Some(path) = telemetry_file(&root) else {
                    continue;
                };
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let raw = raw.trim().to_owned();
                if raw.is_empty() || raw.len() > 262_144 || last.as_deref() == Some(raw.as_str()) {
                    continue;
                }
                // Only emit parseable JSON: a half-written file (the plugin
                // rewrites whole, but the reader can still race the write)
                // must not poison `last` — otherwise the good rewrite would
                // be swallowed as "unchanged" while windows never saw it.
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                last = Some(raw);
                if let Err(e) = app.emit("wowsp://ingame-telemetry", value) {
                    tracing::warn!(error = %e, "emit ingame-telemetry failed");
                }
            }
        });
}
