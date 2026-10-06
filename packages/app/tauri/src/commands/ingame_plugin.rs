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

/// The plugin's runtime bridge files (the Main.py side of the file bridge):
/// per-session battle state the plugin rewrites from scratch every run. An
/// install wipes any leftovers, so a dead session's roster and ordering can
/// never survive a reinstall into a tree that carried them in.
const RUNTIME_BRIDGE_FILES: [&str; 7] = [
    "telemetry.json",
    "heartbeat.json",
    "request.json",
    "response.json",
    "roster_raw.json",
    "roster_journal.jsonl",
    "manual_refresh.flag",
];

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
    // Dead session state must not survive the reinstall — these are the
    // plugin's own per-run rewrites (see [`RUNTIME_BRIDGE_FILES`]).
    for file in RUNTIME_BRIDGE_FILES {
        let _ = std::fs::remove_file(mod_dir.join(file));
    }
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
    // The twins shed their runtime files too: a staged build must not open
    // its first session with a dead one's battle state.
    let runtime_rels: Vec<String> = RUNTIME_BRIDGE_FILES
        .iter()
        .map(|file| format!("PnFMods/{MOD_DIR}/{file}"))
        .collect();
    super::mod_hub::preload_mirror::mirror_removed(game_root, &runtime_rels);
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
/// with a standard mod entry (foreign modpacks and the bundled probe
/// alike)? Entry spellings follow the classifier's `find_pnf_main`:
/// `Main.py`, compiled `Main.pyc`, or either's `.bak` twin when disabled —
/// real-world packs ship all four (Aslain's script mods are Main.pyc), and
/// a disabled mod must still keep the shared marker alive or re-enabling
/// it would resurrect a corpse. The marker itself must survive while any
/// does: without it the client stops loading PnF mods entirely, so
/// removing it would silence every OTHER PnF mod too.
pub(crate) fn has_pnf_mods(res_mods: &std::path::Path) -> bool {
    res_mods
        .join("PnFMods")
        .read_dir()
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().is_dir() && super::mod_hub::find_pnf_main(&e.path()).is_some())
        })
        .unwrap_or(false)
}

/// The plugin's live telemetry file for a game root — `None` when the root
/// has no versioned `bin/` layout to hang `res_mods` off.
pub(crate) fn telemetry_file(game_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = super::game_context::res_mods_dir(game_root).ok()?;
    Some(dir.join("PnFMods").join(MOD_DIR).join("telemetry.json"))
}

/// Age cap for emitting a telemetry payload — the same freshness the
/// overlay consumer enforces on `wowsp://ingame-telemetry` (older payloads
/// are dropped there). The poller skips them at the source: the file's
/// existence alone says nothing about the plugin still running, and a dead
/// session's leftover must not reach any consumer as an emit.
const TELEMETRY_STALE_MS: i64 = 30_000;

/// A telemetry payload's `t` stamp (epoch milliseconds). The plugin writes
/// an integer today; the float parse is defensive against older or
/// hand-edited files.
fn payload_epoch_ms(value: &serde_json::Value) -> Option<i64> {
    let t = value.get("t")?;
    t.as_i64().or_else(|| t.as_f64().map(|f| f as i64))
}

/// The emit decision for one parsed payload: fresh only when it carries a
/// `t` no older than [`TELEMETRY_STALE_MS`]. A payload without `t` is
/// stale by definition (the overlay's own gate drops it the same way).
fn payload_fresh(value: &serde_json::Value, now_ms: i64) -> bool {
    match payload_epoch_ms(value) {
        Some(t) => now_ms - t <= TELEMETRY_STALE_MS,
        None => false,
    }
}

/// Spawn the detached telemetry poller: every 2 s it resolves the active
/// game install, reads the plugin's `telemetry.json` (written by the
/// in-game bridge on every alive-set change) and emits
/// `wowsp://ingame-telemetry` to every window when its content changed and
/// is fresh ([`TELEMETRY_STALE_MS`]). Both the live panel and the overlay
/// window listen for the same event — this is the M2 consumer that turns
/// the plugin's observations into authoritative sink marking and TAB
/// ordering.
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
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if !payload_fresh(&value, now_ms) {
                    // Parseable but old (a dead session's leftover): it
                    // entered `last` above, so this logs once per content
                    // and the live rewrite still emits.
                    tracing::debug!("ingame telemetry payload stale — emit skipped");
                    continue;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// PnF presence accepts every real-world entry spelling: plain Main.py,
    /// Aslain's compiled Main.pyc, and either's disabled `.bak` twin — a
    /// disabled mod must still keep the shared loader marker alive.
    #[test]
    fn has_pnf_mods_covers_pyc_and_disabled_spellings() {
        let tmp = std::env::temp_dir().join("wowsp_haspnf");
        let _ = std::fs::remove_dir_all(&tmp);
        let rm = tmp.join("res_mods");
        let mk = |entry: &str| {
            let _ = std::fs::remove_dir_all(&rm);
            std::fs::create_dir_all(rm.join("PnFMods/Mod")).unwrap();
            std::fs::write(rm.join("PnFMods/Mod").join(entry), b"x").unwrap();
            let got = has_pnf_mods(&rm);
            std::fs::remove_dir_all(&rm).unwrap();
            got
        };
        assert!(mk("Main.py"), "plain entry counts");
        assert!(mk("Main.pyc"), "compiled entry counts (Aslain ships these)");
        assert!(mk("Main.py.bak"), "disabled twin counts");
        assert!(mk("Main.pyc.bak"), "disabled compiled twin counts");

        // An empty PnFMods skeleton carries no loadable mod.
        std::fs::create_dir_all(rm.join("PnFMods/Empty")).unwrap();
        assert!(!has_pnf_mods(&rm));
        // No PnFMods at all.
        std::fs::remove_dir_all(rm.join("PnFMods")).unwrap();
        assert!(!has_pnf_mods(&rm));

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// A minimal versioned install: one `bin/<build>` carrying `idx/`,
    /// pinned by `preferences.xml` so `res_mods_dir` resolves without a
    /// real client. The temp tree is recreated fresh on every call.
    fn fixture_game_root(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("wowsp_probe_install_{tag}"));
        let _ = std::fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let build = game.join("bin").join("100");
        std::fs::create_dir_all(build.join("idx")).unwrap();
        std::fs::write(
            game.join("preferences.xml"),
            "<root><last_server_version> 15,8,0,100 </last_server_version></root>",
        )
        .unwrap();
        game
    }

    #[test]
    fn install_wipes_stale_runtime_bridge_files() {
        let game = fixture_game_root("wipe_live");
        let res_mods = super::super::game_context::res_mods_dir(&game).unwrap();
        let probe_dir = res_mods.join("PnFMods").join(MOD_DIR);
        std::fs::create_dir_all(&probe_dir).unwrap();
        std::fs::write(probe_dir.join(MOD_ENTRY), "stale entry").unwrap();
        // Literal names, not [`RUNTIME_BRIDGE_FILES`] itself: the wipe list
        // is the plugin's bridge contract, and dropping a name from the
        // const must fail here.
        let runtime_files = [
            "telemetry.json",
            "heartbeat.json",
            "request.json",
            "response.json",
            "roster_raw.json",
            "roster_journal.jsonl",
            "manual_refresh.flag",
        ];
        assert_eq!(runtime_files, RUNTIME_BRIDGE_FILES);
        for file in runtime_files {
            std::fs::write(probe_dir.join(file), "stale session state").unwrap();
        }

        let mod_dir =
            std::path::PathBuf::from(install_probe_files(&game.to_string_lossy()).unwrap());

        for file in runtime_files {
            assert!(!mod_dir.join(file).exists(), "{file} survived the install");
        }
        // The shipped entry replaced the stranded one.
        assert_eq!(
            std::fs::read(mod_dir.join(MOD_ENTRY)).unwrap(),
            PLUGIN_SOURCE.as_bytes()
        );
        std::fs::remove_dir_all(game.parent().unwrap()).ok();
    }

    #[test]
    fn install_wipes_runtime_files_in_preload_twins() {
        let game = fixture_game_root("wipe_twin");
        // A complete staged build numerically above the pin — the twin the
        // mirror fan-out targets.
        let twin_res_mods = game.join("bin").join("200").join("res_mods");
        let twin_probe = twin_res_mods.join("PnFMods").join(MOD_DIR);
        std::fs::create_dir_all(game.join("bin").join("200").join("idx")).unwrap();
        std::fs::create_dir_all(&twin_probe).unwrap();
        std::fs::write(twin_probe.join(MOD_ENTRY), "twin entry").unwrap();
        std::fs::write(twin_probe.join("telemetry.json"), "stale").unwrap();

        install_probe_files(&game.to_string_lossy()).unwrap();

        assert!(
            !twin_probe.join("telemetry.json").exists(),
            "twin kept the dead session's telemetry"
        );
        // The mirrored copy of the shipped entry is in place.
        assert_eq!(
            std::fs::read(twin_probe.join(MOD_ENTRY)).unwrap(),
            PLUGIN_SOURCE.as_bytes()
        );
        std::fs::remove_dir_all(game.parent().unwrap()).ok();
    }

    #[test]
    fn telemetry_freshness_rules() {
        let now = 1_800_000_000_000i64;
        let fresh = serde_json::json!({ "t": now - 1_000, "players": {} });
        let boundary = serde_json::json!({ "t": now - 30_000, "players": {} });
        let stale = serde_json::json!({ "t": now - 31_000, "players": {} });
        let float_t = serde_json::json!({ "t": (now - 500) as f64, "players": {} });
        let no_stamp = serde_json::json!({ "players": {} });

        assert!(payload_fresh(&fresh, now));
        assert!(payload_fresh(&boundary, now), "exactly the cap is fresh");
        assert!(!payload_fresh(&stale, now));
        assert!(payload_fresh(&float_t, now), "float stamps parse");
        assert_eq!(payload_epoch_ms(&float_t), Some(now - 500));
        assert!(!payload_fresh(&no_stamp, now), "no t — stale by definition");
    }
}
