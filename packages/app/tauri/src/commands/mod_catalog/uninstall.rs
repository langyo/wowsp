//! Uninstall: validation, ledger removal, tree restore (split from
//! mod_catalog.rs).

use anyhow::anyhow;

use super::*;

// ── Uninstall ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    pub id: String,
    pub name: String,
    pub removed_files: usize,
    pub restored_files: usize,
}

/// Windows file spelling and the disabled twin refer to one ownership slot.
/// Path keys normalize case and separators so a record's `/` spelling and a
/// snapshot's OS-native `\` spelling compare equal.
pub(crate) fn uninstall_path_key(name: &str) -> String {
    let mut key = name.to_ascii_lowercase().replace('\\', "/");
    if key.ends_with(".bak") {
        key.truncate(key.len() - 4);
    }
    key
}

/// Records are appended in installation order. A newer overlapping install
/// snapshots this record's bytes; removing the older layer first would both
/// clobber the current owner and leave a snapshot that resurrects it later.
pub(crate) fn validate_uninstall_order(
    installs: &[ModInstallRecord],
    mod_id: &str,
    game_root: &str,
) -> anyhow::Result<()> {
    let record = installs
        .iter()
        .find(|r| r.id == mod_id && (r.game_root.is_empty() || r.game_root == game_root))
        .ok_or_else(|| anyhow!("{mod_id} has no install record"))?;
    validate_file_removal_order(installs, mod_id, game_root, &record.files)
}

/// A unit trim removes only part of a record. Apply the same ownership
/// check to that subset without treating its untouched files as removals.
pub(crate) fn validate_file_removal_order(
    installs: &[ModInstallRecord],
    mod_id: &str,
    game_root: &str,
    files: &[String],
) -> anyhow::Result<()> {
    let position = installs
        .iter()
        .position(|r| r.id == mod_id && (r.game_root.is_empty() || r.game_root == game_root))
        .ok_or_else(|| anyhow!("{mod_id} has no install record"))?;
    let record = &installs[position];
    // Uninstall also removes pre-release mirror copies. A newer record at
    // another bin can own those same physical paths, even though the plain
    // recorded-bin and claimed-live-bin loops would leave its files alone.
    let removes_mirrors = !mod_hub::preload_mirror::preload_res_mods(game_root).is_empty();
    for newer in &installs[position + 1..] {
        if !newer.game_root.is_empty() && newer.game_root != game_root {
            continue;
        }
        // Duplicate records of the SAME catalog id (an anomaly older builds
        // could append) are one logical install and leave together — neither
        // may deadlock the other's removal through this guard.
        if newer.id == record.id {
            continue;
        }
        let claimed: std::collections::HashSet<_> =
            newer.files.iter().map(|f| uninstall_path_key(f)).collect();
        for rel in files {
            if rel == "PnFModsLoader.py" {
                continue; // The loader has a separate shared-owner policy.
            }
            if !rel.starts_with("@game/")
                && record.bin_version != newer.bin_version
                && !removes_mirrors
            {
                continue;
            }
            if claimed.contains(&uninstall_path_key(rel)) {
                // The name alone must identify the blocker in the UI; the id
                // is the fallback handle when a record's name is missing from
                // the list the user sees.
                let who = if newer.name == newer.id {
                    format!("\"{}\"", newer.name)
                } else {
                    format!("\"{}\" (id {})", newer.name, newer.id)
                };
                return Err(anyhow!(
                    "\"{}\" shares {rel} with newer installed {who} — uninstall {who} first to preserve its files and restore snapshots",
                    record.name
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mod_catalog_uninstall(
    window: tauri::Window,
    mod_id: String,
    game_root: String,
) -> CommandResult<UninstallReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    let _gate = mod_hub_gate().await;
    mod_hub::ensure_game_closed(&game_root)?;
    mod_hub::ensure_res_mods_active(&game_root)?;
    let mut ledger = load_ledger();
    let report = uninstall_from_ledger(&mut ledger.installs, &mod_id, &game_root)?;
    save_ledger(&ledger)?;
    tracing::info!(id = %report.id, removed = report.removed_files, restored = report.restored_files, "mod_catalog_uninstall done");
    Ok(report)
}

/// How a rewind treats files that another ledger record also claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RewindMode {
    /// A user uninstall: the strict ownership ordering guard applies and every
    /// recorded file is removed or restored.
    Strict,
    /// A reinstall (the catalog install and the local same-name flow): the
    /// record is being replaced, so a file another record on the SAME game
    /// root and bin_version still claims is left to that owner instead of
    /// blocking the update. A record keyed at another bin_version owns
    /// physically different files under a different bin, so it protects
    /// nothing here - protecting its spelling would instead leave stale files
    /// behind after a game update.
    Reinstall,
}

/// Ownership keys another record on the same game root and bin still claims.
/// Duplicate records of the same catalog id are one logical install and are
/// rewound together, so they protect nothing.
fn shared_claims(
    installs: &[ModInstallRecord],
    record: &ModInstallRecord,
    game_root: &str,
) -> std::collections::HashSet<String> {
    installs
        .iter()
        .filter(|r| r.id != record.id)
        .filter(|r| r.bin_version == record.bin_version)
        .filter(|r| r.game_root.is_empty() || r.game_root == game_root)
        .flat_map(|r| r.files.iter())
        .map(|rel| uninstall_path_key(rel))
        .collect()
}

/// Uninstall core, split from the command so tests can drive it against a
/// plain record list. Removes recorded files (`@game/` entries from the game
/// root, the rest from res_mods), restores snapshots, drops the record.
pub(crate) fn uninstall_from_ledger(
    installs: &mut Vec<ModInstallRecord>,
    mod_id: &str,
    game_root: &str,
) -> anyhow::Result<UninstallReport> {
    rewind_from_ledger(installs, mod_id, game_root, RewindMode::Strict)
}

/// Reinstall-mode rewind: like [`uninstall_from_ledger`], but the strict
/// ordering guard is skipped and files another record on the same game root
/// and bin_version also claims are neither removed nor restored from this
/// record's snapshot - their bytes belong to that owner. Same-family mods
/// legitimately share support-package files, so the strict guard used to
/// block those updates forever.
pub(crate) fn rewind_for_reinstall(
    installs: &mut Vec<ModInstallRecord>,
    mod_id: &str,
    game_root: &str,
) -> anyhow::Result<UninstallReport> {
    rewind_from_ledger(installs, mod_id, game_root, RewindMode::Reinstall)
}

fn rewind_from_ledger(
    installs: &mut Vec<ModInstallRecord>,
    mod_id: &str,
    game_root: &str,
    mode: RewindMode,
) -> anyhow::Result<UninstallReport> {
    if mode == RewindMode::Strict {
        validate_uninstall_order(installs, mod_id, game_root)?;
    }
    // The ledger is global: the same catalog id can exist for several game
    // installs. Operate on THIS root's record (pre-field empty stamps
    // match every root, preserving the old single-install behavior).
    let Some(record) = installs
        .iter()
        .find(|r| r.id == mod_id && (r.game_root.is_empty() || r.game_root == game_root))
        .cloned()
    else {
        return Err(anyhow!("{mod_id} has no install record"));
    };
    let protected: std::collections::HashSet<String> = match mode {
        RewindMode::Strict => std::collections::HashSet::new(),
        RewindMode::Reinstall => shared_claims(installs, &record, game_root),
    };
    let mut kept_shared = 0usize;

    // The files may live under an older bin/<version> after a game update —
    // clean up where they were actually written.
    let res_mods = Path::new(game_root)
        .join("bin")
        .join(&record.bin_version)
        .join("res_mods");
    let mut removed = 0usize;
    for rel in &record.files {
        // The loader marker is shared and never deleted by the plain file
        // loop — a foreign (non-empty) one must survive even the last
        // uninstall; our own 0-byte placeholder is dropped by the
        // ref-count pass below once the last user is gone.
        if rel == "PnFModsLoader.py" {
            continue;
        }
        // Reinstall mode: another record on this root and bin owns the file;
        // leave its bytes (and its snapshot restore) alone.
        if protected.contains(&uninstall_path_key(rel)) {
            kept_shared += 1;
            continue;
        }
        let path = match rel.strip_prefix("@game/") {
            Some(rest) => Path::new(game_root).join(rest),
            None => res_mods.join(rel),
        };
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| anyhow!("remove {}: {e}", path.display()))?;
            removed += 1;
        }
        // A disabled mod's files live under `.bak` twins — they must not
        // survive the uninstall as ghost payloads the next scan resurrects.
        let twin = mod_hub::sibling_with_suffix(&path, ".bak");
        if twin.is_file() {
            fs::remove_file(&twin).map_err(|e| anyhow!("remove {}: {e}", twin.display()))?;
            removed += 1;
        }
    }
    if res_mods.is_dir() {
        // Prune directories this mod emptied (never above res_mods itself).
        let mut dirs: Vec<PathBuf> = record
            .files
            .iter()
            .filter(|rel| !rel.starts_with("@game/"))
            .filter_map(|rel| res_mods.join(rel).parent().map(|p| p.to_path_buf()))
            .collect();
        dirs.sort();
        dirs.dedup();
        for dir in dirs.into_iter().rev() {
            let _ = fs::remove_dir(dir); // succeeds only when empty
        }
    }
    // Pre-release twins lose the same files (see preload_mirror) — one
    // hook covers every caller: the mod-list uninstall, unit uninstalls
    // and the same-name reinstall rewind. A reinstall keeps files another
    // record on this root and bin owns, so their mirrored copies stay too.
    match mode {
        RewindMode::Strict => mod_hub::preload_mirror::mirror_removed(game_root, &record.files),
        RewindMode::Reinstall => {
            let mirrored: Vec<String> = record
                .files
                .iter()
                .filter(|rel| !protected.contains(&uninstall_path_key(rel)))
                .cloned()
                .collect();
            mod_hub::preload_mirror::mirror_removed(game_root, &mirrored);
        },
    }
    // A record still keyed at an older bin after the pin flipped: the
    // pre-release fan-out put its copies into the bin the client NOW
    // loads — remove them there too, or the mod survives its own
    // uninstall. Paths another record keyed at the live bin claims belong
    // to that record and stay.
    if let Some((live_bin, live_rm)) =
        crate::commands::game_context::latest_bin_dir(Path::new(game_root))
            .map(|(v, dir)| (v.to_string(), dir.join("res_mods")))
    {
        if live_bin != record.bin_version {
            let claimed: std::collections::HashSet<String> = installs
                .iter()
                .filter(|r| r.bin_version == live_bin)
                .filter(|r| r.game_root.is_empty() || r.game_root == game_root)
                .flat_map(|r| r.files.iter())
                .map(|rel| uninstall_path_key(rel))
                .collect();
            for rel in &record.files {
                if rel.starts_with("@game/")
                    || rel == "PnFModsLoader.py"
                    || claimed.contains(&uninstall_path_key(rel))
                {
                    continue;
                }
                let live_copy = live_rm.join(rel);
                for path in [
                    live_copy.clone(),
                    mod_hub::sibling_with_suffix(&live_copy, ".bak"),
                ] {
                    if path.is_file() && fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
            }
            // The live manifest keeps its own row for the mirrored copies —
            // drop it (idempotent when the row is already gone).
            manifest::hub_apply(manifest::ManifestOp::RemoveManaged {
                res_mods: live_rm,
                id: record.id.clone(),
            });
        }
    }

    if mode == RewindMode::Reinstall && kept_shared > 0 {
        tracing::info!(
            id = %record.id,
            bin = %record.bin_version,
            kept = kept_shared,
            "reinstall rewind kept files another install on this root owns"
        );
    }

    // Bring back whatever this install had snapshotted over. A reinstall keeps
    // shared files at their owner's bytes, so their snapshot entries are not
    // restored either.
    let mut restored = 0usize;
    if let Some(dir) = record.restore_dir.as_ref() {
        let restore = PathBuf::from(dir);
        if restore.is_dir() {
            restored = restore_tree(&restore, &res_mods, Path::new(game_root), &protected)?;
            fs::remove_dir_all(&restore).ok();
        }
    }

    installs.retain(|r| !(r.id == mod_id && (r.game_root.is_empty() || r.game_root == game_root)));
    // The shared manifest loses the row too (its `[tools.*]` tables and any
    // other entries survive; an empty manifest file removes itself).
    manifest::hub_apply(manifest::ManifestOp::RemoveManaged {
        res_mods: manifest::res_mods_of(game_root, &record.bin_version),
        id: record.id.clone(),
    });

    // The 0-byte loader marker is a shared component: when the last record
    // referencing it is gone, drop our placeholder — a non-empty loader
    // shipped with a real modpack (Aslain & co.) is never ours to touch,
    // and neither is one whose tree still carries foreign PnF mods: the
    // client only scans res_mods while the marker exists, so removing it
    // would silence every OTHER PnF mod with this uninstall.
    if record.files.iter().any(|f| f == "PnFModsLoader.py")
        && !installs
            .iter()
            .any(|r| r.files.iter().any(|f| f == "PnFModsLoader.py"))
        && !ingame_plugin::has_pnf_mods(&res_mods)
    {
        let loader = res_mods.join("PnFModsLoader.py");
        let is_placeholder = loader.metadata().map(|m| m.len() == 0).unwrap_or(false);
        if is_placeholder {
            fs::remove_file(&loader).map_err(|e| anyhow!("remove {}: {e}", loader.display()))?;
            removed += 1;
            tracing::info!("removed the shared PnFModsLoader.py placeholder");
        }
    }
    Ok(UninstallReport {
        id: record.id,
        name: record.name,
        removed_files: removed,
        restored_files: restored,
    })
}

/// Copy a snapshot tree back: entries under `@game/` land in the game root,
/// everything else in res_mods. Paths in `protected` are skipped (a reinstall
/// keeps files another record owns, so its snapshot must not overwrite them).
/// Returns the restored file count.
fn restore_tree(
    from: &Path,
    res_mods: &Path,
    game_root: &Path,
    protected: &std::collections::HashSet<String>,
) -> anyhow::Result<usize> {
    let mut count = 0usize;
    let mut stack = vec![from.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for ent in fs::read_dir(&dir)
            .map_err(|e| anyhow!("read {}: {e}", dir.display()))?
            .flatten()
        {
            let src = ent.path();
            if src.is_dir() {
                stack.push(src);
                continue;
            }
            let Ok(rel) = src.strip_prefix(from) else {
                continue;
            };
            if protected.contains(&uninstall_path_key(&rel.to_string_lossy())) {
                continue;
            }
            let dest = if let Ok(rest) = rel.strip_prefix("@game") {
                let rest = rest.to_string_lossy();
                let rest = rest.trim_start_matches(['/', '\\']);
                game_root.join(rest)
            } else {
                res_mods.join(rel)
            };
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| anyhow!("mkdir {}: {e}", parent.display()))?;
            }
            fs::copy(&src, &dest).map_err(|e| anyhow!("restore {}: {e}", dest.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

// ── Ledger reconciliation ────────────────────────────────────────────────────
