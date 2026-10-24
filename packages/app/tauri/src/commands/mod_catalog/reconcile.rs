//! Reconcile: orphan healing, junk-name sweeps, alive checks (split
//! from mod_catalog.rs).

use super::*;

/// What [`mod_hub_reconcile`] cleaned up.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    /// Ghost records removed — every file they listed is gone from disk
    /// (manual cleanup, lost bin dir, …), so they only distorted the UI's
    /// "installed" badges.
    pub dropped_records: usize,
    /// Snapshot dirs no record references anymore (dropped records, failed
    /// installs of older builds) — deleted to stop them piling up.
    pub removed_restore_dirs: usize,
    /// Records whose junk classifier label ("res_mods"/"unpacked") was
    /// re-resolved to the catalog title — the frontend refreshes its records
    /// snapshot on this too.
    pub healed_names: usize,
}

/// How long an unreferenced snapshot dir must have sat untouched before
/// the reconcile garbage-collects it.
const ORPHAN_RESTORE_GRACE: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Drop ledger records whose files no longer exist on disk and garbage-
/// collect restore dirs nothing references. Safe-mode aware: a quarantined
/// `res_mods.wowsp-disabled` still counts as "the files exist".
#[tauri::command]
pub async fn mod_hub_reconcile(
    window: tauri::Window,
    game_root: String,
) -> CommandResult<ReconcileReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    // Audit H-3: reconcile MUTATES the root's res_mods (heals wowsp.toml,
    // removes stale loader markers, prunes restore dirs) — the webview's
    // game_root must name an install the backend knows.
    mod_hub::ensure_known_game_root(&game_root)?;
    let _gate = mod_hub_gate().await;
    let mut ledger = load_ledger();
    let mut report = reconcile_core(&game_root, &mut ledger.installs);
    report.healed_names = heal_record_names(&mut ledger.installs, load_cached_index().as_ref());
    if report.dropped_records > 0 || report.healed_names > 0 {
        save_ledger(&ledger)?;
    }
    tracing::info!(
        dropped = report.dropped_records,
        restore_dirs = report.removed_restore_dirs,
        healed = report.healed_names,
        "ledger reconciled"
    );
    Ok(report)
}

/// Ledger names older installs recorded by mistake: the classifier's
/// directory labels leaked into records before the catalog title was stamped
/// on (see [`entry_display_name`]). Every conflict message quotes these
/// names, so a blocked uninstall read `"res_mods" shares … with newer
/// installed "res_mods"` and the instructed remedy was impossible to follow.
fn is_junk_record_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("res_mods") || name.eq_ignore_ascii_case("unpacked")
}

/// Re-resolve junk record names against the cached catalog index, by id.
/// Records no entry answers to (delisted ids, foreign/local payloads) keep
/// their name — there is nothing better to say about them. Returns how many
/// records were healed.
pub(crate) fn heal_record_names(
    installs: &mut [ModInstallRecord],
    index: Option<&CatalogIndex>,
) -> usize {
    let Some(index) = index else {
        return 0;
    };
    let mut healed = 0usize;
    for record in installs.iter_mut() {
        if !is_junk_record_name(&record.name) {
            continue;
        }
        let Some(entry) = index.mods.iter().find(|m| m.id == record.id) else {
            continue;
        };
        let name = entry_display_name(entry);
        if name != record.name {
            record.name = name;
            healed += 1;
        }
    }
    healed
}

pub(crate) fn reconcile_core(
    game_root: &str,
    installs: &mut Vec<ModInstallRecord>,
) -> ReconcileReport {
    reconcile_core_with_grace(game_root, installs, ORPHAN_RESTORE_GRACE)
}

/// [`reconcile_core`] with an explicit orphan-snapshot grace window (tests
/// pass zero).
pub(crate) fn reconcile_core_with_grace(
    game_root: &str,
    installs: &mut Vec<ModInstallRecord>,
    grace: std::time::Duration,
) -> ReconcileReport {
    let mut dropped = 0usize;
    let mut ghosts: Vec<(String, String, bool)> = Vec::new();
    installs.retain(|r| {
        // Records stamped with a DIFFERENT game install are not ours to
        // judge — the ledger is global, and checking them against this
        // root would drop another install's mods as ghosts. Pre-field
        // records (empty stamp) match every root, preserving the old
        // single-install behavior.
        if !r.game_root.is_empty() && r.game_root != game_root {
            return true;
        }
        if record_alive(game_root, r) {
            true
        } else {
            dropped += 1;
            // The ghost's wowsp.toml row goes with it (removed after the
            // ledger verdict settles); the third flag remembers whether
            // it referenced the shared loader marker (see below).
            ghosts.push((
                r.id.clone(),
                r.bin_version.clone(),
                r.files.iter().any(|f| f == "PnFModsLoader.py"),
            ));
            false
        }
    });
    for (id, bin, _) in &ghosts {
        manifest::hub_apply(manifest::ManifestOp::RemoveManaged {
            res_mods: manifest::res_mods_of(game_root, bin),
            id: id.clone(),
        });
    }
    // A dropped ghost may have been the last record referencing the shared
    // loader marker — apply the same ref-count policy as a full uninstall
    // (0-byte placeholder only, never while foreign PnF content survives)
    // so the marker does not outlive every PnF mod it served.
    let loader_referenced = || {
        installs
            .iter()
            .any(|r| r.files.iter().any(|f| f == "PnFModsLoader.py"))
    };
    for (_, bin, owned_loader) in &ghosts {
        if !owned_loader || loader_referenced() {
            continue;
        }
        let res_mods = Path::new(game_root).join("bin").join(bin).join("res_mods");
        if ingame_plugin::has_pnf_mods(&res_mods) {
            continue;
        }
        let loader = res_mods.join("PnFModsLoader.py");
        if loader.metadata().map(|m| m.len() == 0).unwrap_or(false)
            && fs::remove_file(&loader).is_ok()
        {
            tracing::info!(bin = %bin, "reconcile removed the orphaned loader placeholder");
        }
    }
    // Dust sweep of the LIVE bin, not ghost-gated: the loader-owning record
    // may have left the placeholder behind when it was fully uninstalled
    // while other PnF content still lived (`has_pnf_mods` correctly kept
    // the marker then) — once that content is gone too, no record names the
    // marker anymore, so no future ghost ever will either. Same guards:
    // ours (0-byte) only, and never while PnF content survives.
    if !loader_referenced() {
        if let Some((_, ver_dir)) =
            crate::commands::game_context::latest_bin_dir(Path::new(game_root))
        {
            let res_mods = ver_dir.join("res_mods");
            let loader = res_mods.join("PnFModsLoader.py");
            if !ingame_plugin::has_pnf_mods(&res_mods)
                && loader.metadata().map(|m| m.len() == 0).unwrap_or(false)
                && fs::remove_file(&loader).is_ok()
            {
                tracing::info!("reconcile swept the orphaned loader placeholder");
            }
        }
    }
    // Snapshot dirs are shared across installs: only collect orphans no
    // record ANYWHERE still references, and give fresh ones a grace
    // window — a just-failed install's snapshots may be the only vanilla
    // copies of what it already overwrote.
    let referenced: std::collections::HashSet<PathBuf> = installs
        .iter()
        .filter_map(|r| r.restore_dir.as_ref())
        .map(PathBuf::from)
        .collect();
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    if let Ok(entries) = fs::read_dir(mod_hub::restore_root()) {
        for ent in entries.flatten() {
            let dir = ent.path();
            // A future mtime (clock skew) counts as fresh — better to keep
            // an orphan one cycle too long than to eat a just-failed
            // install's only vanilla copies.
            let fresh = dir
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_none_or(|age| age < grace);
            if dir.is_dir()
                && !referenced.contains(&dir)
                && !fresh
                && fs::remove_dir_all(&dir).is_ok()
            {
                removed += 1;
            }
        }
    }
    ReconcileReport {
        dropped_records: dropped,
        removed_restore_dirs: removed,
        healed_names: 0,
    }
}

/// Does any file this record lists still exist? `@game/` entries resolve
/// against the game root (bin-independent); the rest against the record's
/// own `bin/<version>/res_mods`, falling back to its safe-mode twin.
/// The shared `PnFModsLoader.py` marker never counts: no unit owns it, so
/// unit uninstalls used to strand records trimmed down to just that file —
/// and a record whose only surviving "file" is the shared marker describes
/// no installed mod at all (it would keep badging the entry as installed
/// and hide its install button). The marker itself is ref-counted by the
/// uninstall path, not by record aliveness.
fn record_alive(game_root: &str, record: &ModInstallRecord) -> bool {
    if record.files.is_empty() {
        return false;
    }
    let base = Path::new(game_root).join("bin").join(&record.bin_version);
    let live = base.join("res_mods");
    let off = base.join(format!("res_mods{}", mod_hub::SAFE_MODE_SUFFIX));
    record
        .files
        .iter()
        .filter(|f| f.as_str() != "PnFModsLoader.py")
        .any(|f| match f.strip_prefix("@game/") {
            Some(rest) => Path::new(game_root).join(rest).is_file(),
            // A disabled mod's files live under `.bak` twins — they count
            // too, or every toggled-off mod would reconcile away.
            None => {
                live.join(f).is_file()
                    || off.join(f).is_file()
                    || live.join(format!("{f}.bak")).is_file()
                    || off.join(format!("{f}.bak")).is_file()
            },
        })
}
