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
/// probe. Shared with `ingame_bridge` (the same directory hosts the
/// request/response mailbox).
pub(crate) const MOD_DIR: &str = "WoWSPProbe";
const MOD_ENTRY: &str = "Main.py";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngamePluginStatus {
    /// Whether the plugin's entry file exists in the install's res_mods.
    pub installed: bool,
    /// Installed but NOT the bytes this app ships (an older build, a
    /// missing unbound view, or a hand-edited file): the UI offers a
    /// one-click update. The in-game version string is pinned at 0.1.0 by
    /// owner decision, so the content hashes over the whole shipped set
    /// (Main.py + view) are the only reliable freshness signal.
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
        && !(file_fresh(
            &dir,
            &format!("PnFMods/{MOD_DIR}/{MOD_ENTRY}"),
            PLUGIN_SOURCE,
        ) && file_fresh(&dir, VIEW_DEST, PLUGIN_VIEW));
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

/// The visible half of the 游戏内展示 view mode: the unbound 2 view, auto
/// discovered + mounted by the game from `gui/unbound2/mods/` — the folder
/// every working battle view on real installs lives in (radar_timer,
/// shot_timer, …). A `ForgeBlueprints/` manifest was tried first and never
/// worked: those XMLs are installer-only metadata the game ignores, and
/// `gui/unbound2/PnFMods/` is outside the scan set. No view file means the
/// plugin stays a telemetry-only probe.
const PLUGIN_VIEW: &str = include_str!("../../../../ingame-plugin/src/WoWSPProbe.unbound");
const VIEW_DEST: &str = "gui/unbound2/mods/WoWSPProbe.unbound";
/// The layout #694 shipped, retired by this fix — an install (or update)
/// over it removes both leftovers.
const LEGACY_VIEW_DEST: &str = "gui/unbound2/PnFMods/WoWSPProbe.unbound";
const LEGACY_MOUNT_DEST: &str = "ForgeBlueprints/WoWSPProbe.xml";

/// The probe's entry file inside a SPECIFIC res_mods tree — the presence
/// probe for callers that inspect something other than the active install
/// (the mod hub's stale-bin migration looks at stranded old-version trees).
pub(crate) fn probe_entry(res_mods: &std::path::Path) -> std::path::PathBuf {
    res_mods.join("PnFMods").join(MOD_DIR).join(MOD_ENTRY)
}

/// Whether `rel` (res_mods-relative, forward slashes) belongs to the
/// probe's own file set — the current layout's subtree and view, the
/// retired #694 layout's leftovers, `.bak` twins included. The stale-bin
/// migration excludes these from its generic file move and reinstalls the
/// embedded bytes instead: an upgrade is exactly the moment the shipped
/// copy should win over whatever stranded build the old bin carried.
pub(crate) fn is_probe_path(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.starts_with(&format!("pnfmods/{}/", MOD_DIR.to_ascii_lowercase())) {
        return true;
    }
    // A `.bak` twin of an extra path (the view, disabled by whatever unit
    // claimed it) is a probe file too — it must neither ride the migration
    // move nor outlive the uninstall.
    let bare = lower.strip_suffix(".bak").unwrap_or(lower.as_str());
    PROBE_EXTRA_PATHS
        .iter()
        .any(|p| bare == p.to_ascii_lowercase())
}

/// The probe's files OUTSIDE its PnFMods subtree, res_mods-relative: the
/// view file of the current layout plus the retired #694 leftovers.
/// Companions to the `PnFMods/<MOD_DIR>/` subtree for callers (the
/// stale-bin migration) that remove or carry the probe's whole file set.
pub(crate) const PROBE_EXTRA_PATHS: [&str; 3] = [VIEW_DEST, LEGACY_VIEW_DEST, LEGACY_MOUNT_DEST];

/// The probe's `wowsp.toml` managed row — the single source of truth for
/// the install core and the migration's disabled-state restore.
pub(crate) fn probe_managed_entry(enabled: bool) -> super::mod_hub::manifest::ManagedEntry {
    super::mod_hub::manifest::ManagedEntry {
        name: "WoWSP In-Game Tab Stats Plugin".into(),
        version: "0.1.0".into(),
        category: "battle".into(),
        source: "bundled".into(),
        preset: None,
        enabled,
        installed_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Rewrite the probe's managed row as ENABLED — a plain install rewrites
/// live files, so a stale disabled label from a pre-update toggle must
/// not survive. Upsert alone preserves the previous toggle bit, so the
/// row is removed first. (Writing DISABLED goes through the unit toggle's
/// `SetEnabled` path instead — see `unit_ops::set_bundled_plugin_enabled`.)
pub(crate) fn replace_probe_row_enabled(res_mods: &std::path::Path) {
    use super::mod_hub::manifest::{self, ManifestOp};
    manifest::hub_apply(ManifestOp::RemoveManaged {
        res_mods: res_mods.to_path_buf(),
        id: "battle.ingame.stats".into(),
    });
    manifest::hub_apply(ManifestOp::UpsertManaged {
        res_mods: res_mods.to_path_buf(),
        id: "battle.ingame.stats".into(),
        entry: probe_managed_entry(true),
    });
}

/// Whether `res_mods/<rel>` carries exactly `expected`'s bytes. Missing,
/// unreadable and divergent files are all "not fresh" — the freshness
/// signal behind the settings UI's one-click update.
fn file_fresh(dir: &std::path::Path, rel: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    match std::fs::read(dir.join(rel)) {
        Ok(bytes) => {
            let mut wanted = Sha256::new();
            wanted.update(expected.as_bytes());
            let mut on_disk = Sha256::new();
            on_disk.update(&bytes);
            wanted.finalize()[..] == on_disk.finalize()[..]
        },
        Err(_) => false,
    }
}

/// Loader marker content: the game only scans `res_mods` for mods when this
/// 0-byte file exists; some modpacks (Aslain) ship it already.
const LOADER_MARKER: &str = "PnFModsLoader.py";

/// Install the plugin into the active install: `PnFMods/WoWSPProbe/Main.py`
/// plus the game-scanned unbound view of the in-game display mode, and the
/// 0-byte loader marker when missing. Gated like every res_mods mutation
/// (mod-hub gate, game closed, res_mods active). Idempotent — existing
/// files are overwritten in place (a broken install can be reinstalled
/// over), and the #694 layout's leftovers are removed.
#[tauri::command]
pub async fn ingame_plugin_install(game_root: String) -> Result<String, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    super::mod_hub::ensure_res_mods_active(&game_root)?;
    install_probe_files(&game_root)
}

/// Install core, split from the command so the mod hub's stale-bin
/// migration can reuse it mid-migration: the migrator already holds the
/// mod-hub gate, verified the game is closed and res_mods is active — so
/// this core takes none of those locks (re-taking the gate would deadlock).
pub(crate) fn install_probe_files(game_root: &str) -> Result<String, String> {
    let dir = super::game_context::res_mods_dir(std::path::Path::new(game_root))?;
    let mod_dir = dir.join("PnFMods").join(MOD_DIR);
    std::fs::create_dir_all(&mod_dir).map_err(|e| format!("create {}: {e}", mod_dir.display()))?;
    let entry = mod_dir.join(MOD_ENTRY);
    std::fs::write(&entry, PLUGIN_SOURCE).map_err(|e| format!("write {}: {e}", entry.display()))?;
    // The view lands under its own res_mods subtree — this install's own
    // first-party file, no shared paths.
    let view_dest = dir.join(VIEW_DEST);
    if let Some(parent) = view_dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&view_dest, PLUGIN_VIEW)
        .map_err(|e| format!("write {}: {e}", view_dest.display()))?;
    // The #694 layout's leftovers (installer-only mount manifest + an
    // unscanned view path) are this install's own files — remove them so
    // an update can't leave a stale half-layout behind.
    for rel in [LEGACY_VIEW_DEST, LEGACY_MOUNT_DEST] {
        let dest = dir.join(rel);
        if dest.is_file() {
            let _ = std::fs::remove_file(&dest);
        }
    }
    let loader = dir.join(LOADER_MARKER);
    if !loader.exists() {
        std::fs::write(&loader, "").map_err(|e| format!("write {}: {e}", loader.display()))?;
    }
    // The pre-release twins get the plugin too (see preload_mirror) — the
    // marker ride-along is what keeps twins scannable after the switch.
    for warning in super::mod_hub::preload_mirror::mirror_written(
        game_root,
        &dir,
        &[
            format!("PnFMods/{MOD_DIR}/{MOD_ENTRY}"),
            VIEW_DEST.to_string(),
            LOADER_MARKER.to_string(),
        ],
    )
    .warnings
    {
        tracing::warn!("{warning}");
    }
    // wowsp.toml contract: the plugin is a managed unit (bundled source)
    // and its `[tools]` table gets the documented defaults — existing keys,
    // hand-tuned or from a previous install, are never overwritten.
    {
        use std::collections::BTreeMap;
        let mut defaults = BTreeMap::new();
        defaults.insert("panel_fade_ticks".to_string(), 3i64);
        defaults.insert("journal_limit".to_string(), 300i64);
        super::mod_hub::manifest::hub_apply(super::mod_hub::manifest::ManifestOp::SeedTool {
            res_mods: dir.clone(),
            tool: "battle.ingame.stats".into(),
            defaults,
        });
        // Replace the row outright: this install rewrites live files, so a
        // stale disabled label from a pre-update toggle must not survive.
        replace_probe_row_enabled(&dir);
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
    // The view is this layout's own file (plus the #694 leftovers) —
    // always removed with the mod, their `.bak` twins included (a foreign
    // file at the same path is not ours to touch, but the first-party
    // names make that collision theoretical).
    for rel in PROBE_EXTRA_PATHS {
        for suffix in ["", ".bak"] {
            let dest = dir.join(format!("{rel}{suffix}"));
            if dest.is_file() {
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    let loader = dir.join(LOADER_MARKER);
    if !has_pnf_mods(&dir)
        && loader.is_file()
        && std::fs::metadata(&loader).is_ok_and(|m| m.len() == 0)
    {
        let _ = std::fs::remove_file(&loader);
    }
    // Twin copies go with the live ones (the twin's own loader marker is
    // shared-tree bookkeeping and stays — see preload_mirror).
    let mut probe_paths: Vec<String> = PROBE_EXTRA_PATHS.iter().map(|p| p.to_string()).collect();
    probe_paths.push(format!("PnFMods/{MOD_DIR}"));
    super::mod_hub::preload_mirror::mirror_removed(&game_root, &probe_paths);
    // The managed row goes with the files; the tool's config table stays
    // (a reinstall should find the user's tuning where they left it).
    super::mod_hub::manifest::hub_apply(super::mod_hub::manifest::ManifestOp::RemoveManaged {
        res_mods: dir.clone(),
        id: "battle.ingame.stats".into(),
    });
    tracing::info!(dir = %dir.display(), "ingame plugin uninstalled");
    Ok(())
}

/// Does the tree still carry any PnF mod — a directory under `PnFMods`
/// with the standard mod entry file (foreign modpacks and the bundled
/// probe alike)? The shared 0-byte loader marker must survive while any
/// does: without it the client stops scanning `res_mods` entirely, so
/// removing it would silence every OTHER PnF mod too.
pub(crate) fn has_pnf_mods(res_mods: &std::path::Path) -> bool {
    res_mods
        .join("PnFMods")
        .read_dir()
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().is_dir() && e.path().join(MOD_ENTRY).is_file())
        })
        .unwrap_or(false)
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
/// authoritative sink marking and TAB ordering.
///
/// The poller is otherwise a best-effort publisher, but the CHAIN has been
/// hard to diagnose from the field (a silent gap anywhere looks identical
/// to "the feature is broken"), so state transitions log: file acquired /
/// lost, and every emit at DEBUG with the alive count.
pub fn spawn_telemetry_poller(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("ingame-telemetry-poll".into())
        .spawn(move || {
            let mut last: Option<String> = None;
            let mut had_file = false;
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
                    if had_file {
                        had_file = false;
                        tracing::info!(
                            "ingame telemetry stream lost (file gone) — resuming inference"
                        );
                    }
                    continue;
                };
                if !had_file {
                    had_file = true;
                    tracing::info!(path = %path.display(), "ingame telemetry stream acquired");
                }
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
                let alive = value
                    .get("players")
                    .and_then(|p| p.as_object())
                    .map(|m| m.len())
                    .unwrap_or(0);
                tracing::debug!(alive, "ingame telemetry emitted");
                if let Err(e) = app.emit("wowsp://ingame-telemetry", value) {
                    tracing::warn!(error = %e, "emit ingame-telemetry failed");
                }
            }
        });
}
