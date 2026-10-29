//! Purge + reinstall: the "every mod on disk must come from WoWSP" reset.
//!
//! The Aslain/ModStation pack left behind files nobody here can vouch for —
//! and a foreign pack one game version stale is the classic crash source
//! (see `version_guard`). This command answers the nuclear option: move the
//! WHOLE `res_mods` tree aside (nothing is deleted until the user holds the
//! backup path), then rebuild the tree through WoWSP's own bookkeeping:
//!
//! - catalog units reinstall through the verified download path (same
//!   scheme/preset they were installed with);
//! - units recognized in the old tree are COPIED BACK and registered as
//!   WoWSP `local` installs (ledger + `wowsp.toml` rows) — that is the
//!   "adopt the third-party mods under our rules" scope;
//! - with `mode = wowsp-only` only the units our ledger already knew are
//!   copied back; unknown (foreign) units die with the backup.
//!
//! Units whose payload is not reconstructible are reported, never silently
//! dropped.

use anyhow::anyhow;
use std::fs;
use std::path::{Path, PathBuf};

use super::super::mod_catalog;
use super::scan_installed;
use super::*;
use wowsp_tauri_shared::{CommandResult, PurgeReinstallReport, PurgeSkip};

/// Filesystem-safe slug for a generated local-install id.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if out.ends_with('-') || out.is_empty() {
            continue;
        } else {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// How many files a tree carries (best-effort: an unreadable subdir stops
/// counting it, never aborts the purge).
fn count_files(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => total += count_files(&path),
            Ok(_) => total += 1,
            Err(_) => {},
        }
    }
    total
}

/// The on-disk half: move the whole res_mods tree aside and recreate an
/// empty one. Returns (backup dir, live res_mods dir, moved file count).
pub(crate) fn purge_res_mods_core(game_root: &str) -> anyhow::Result<(PathBuf, PathBuf, usize)> {
    let (_, ver_dir) = super::latest_bin_version(game_root)
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {game_root}/bin"))?;
    let live = ver_dir.join("res_mods");
    if !live.is_dir() {
        return Err(anyhow!("res_mods not found — there is nothing to purge"));
    }
    let removed = count_files(&live);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut backup = ver_dir.join(format!("res_mods.wowsp-purge-{stamp}"));
    let mut suffix = 1u32;
    while backup.exists() {
        backup = ver_dir.join(format!("res_mods.wowsp-purge-{stamp}-{suffix}"));
        suffix += 1;
    }
    fs::rename(&live, &backup).map_err(|e| anyhow!("move res_mods aside: {e}"))?;
    fs::create_dir_all(&live).map_err(|e| anyhow!("recreate res_mods: {e}"))?;
    Ok((backup, live, removed))
}

/// One recognized unit copied back from the backup tree.
pub(crate) struct AdoptedUnit {
    pub(crate) name: String,
    /// Files written, res_mods-relative.
    pub(crate) files: Vec<String>,
}

/// Copy one res_mods-relative path from the backup into the live tree,
/// returning the files actually written (destinations the catalog
/// reinstalls already took are skipped — the fresh verified copy wins).
fn copy_unit(
    backup: &Path,
    live: &Path,
    rel: &str,
    written: &mut Vec<String>,
) -> anyhow::Result<()> {
    let src = backup.join(rel);
    if src.is_dir() {
        copy_dir(backup, live, &src, written)
    } else if src.is_file() {
        let dst = live.join(rel);
        if dst.exists() {
            return Ok(());
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&src, &dst).map_err(|e| anyhow!("copy {}: {e}", src.display()))?;
        written.push(rel.replace('\\', "/"));
        Ok(())
    } else {
        Ok(())
    }
}

fn copy_dir(
    backup: &Path,
    live: &Path,
    dir: &Path,
    written: &mut Vec<String>,
) -> anyhow::Result<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let rel = path
            .strip_prefix(backup)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if rel.is_empty() {
            continue;
        }
        if meta.is_dir() {
            copy_dir(backup, live, &path, written)?;
        } else if meta.is_file() {
            let dst = live.join(&rel);
            if dst.exists() {
                continue;
            }
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&path, &dst).map_err(|e| anyhow!("copy {}: {e}", path.display()))?;
            written.push(rel);
        }
    }
    Ok(())
}

/// Every recognized unit of the backup tree that should be put back:
/// `known_names` are the units our ledger already recorded (always adopted);
/// `adopt_foreign` additionally takes every other recognized unit.
pub(crate) fn adopt_units(
    backup: &Path,
    live: &Path,
    known_names: &[String],
    catalog_names: &[String],
    adopt_foreign: bool,
) -> anyhow::Result<Vec<AdoptedUnit>> {
    let mut out: Vec<AdoptedUnit> = Vec::new();
    for candidate in scan_installed::gather_candidates(backup) {
        let name_lower = candidate.name.to_ascii_lowercase();
        // A unit the catalog reinstall just replaced is never copied back.
        if catalog_names
            .iter()
            .any(|n| n.to_ascii_lowercase().trim() == name_lower)
        {
            continue;
        }
        let known = known_names
            .iter()
            .any(|n| n.to_ascii_lowercase().trim() == name_lower);
        if !known && !adopt_foreign {
            continue;
        }
        let mut files: Vec<String> = Vec::new();
        for path in &candidate.paths {
            copy_unit(backup, live, path, &mut files)?;
        }
        if files.is_empty() {
            continue;
        }
        out.push(AdoptedUnit {
            name: candidate.name,
            files,
        });
    }
    Ok(out)
}

/// Move every mod out of the load path, then rebuild the tree through
/// WoWSP's bookkeeping (catalog reinstalls + adoption of the recognized
/// units of the old tree).
#[tauri::command]
pub async fn mod_hub_purge_reinstall(
    window: tauri::Window,
    game_root: String,
    app: tauri::AppHandle,
    // "wowsp-only" (default) keeps only units our ledger knows; "adopt-foreign"
    // also takes over every other recognized third-party unit.
    mode: Option<String>,
) -> CommandResult<PurgeReinstallReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    super::ensure_known_game_root(&game_root)?;
    super::ensure_game_closed(&game_root)?;
    super::ensure_res_mods_active(&game_root)?;
    let adopt_foreign = mode.as_deref() == Some("adopt-foreign");
    let _gate = mod_catalog::mod_hub_gate().await;

    // Snapshot the ledger rows for THIS install before anything moves.
    let ledger = mod_catalog::ledger::load_ledger();
    let mine: Vec<ModInstallRecord> = ledger
        .installs
        .iter()
        .filter(|record| {
            record.game_root.is_empty() || record.game_root.eq_ignore_ascii_case(&game_root)
        })
        .cloned()
        .collect();
    let (bin_version, _) = super::latest_bin_version(&game_root)
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {game_root}/bin"))?;

    let root_for_purge = game_root.clone();
    let (backup, live, removed_files) =
        tauri::async_runtime::spawn_blocking(move || purge_res_mods_core(&root_for_purge))
            .await
            .map_err(|e| anyhow!("purge task failed: {e}"))??;

    // The old ledger describes files that no longer exist: drop the rows,
    // and let the reinstalls / adoptions write fresh ones.
    let mut ledger = mod_catalog::ledger::load_ledger();
    ledger.installs.retain(|record| {
        !(record.game_root.is_empty() || record.game_root.eq_ignore_ascii_case(&game_root))
    });
    mod_catalog::ledger::save_ledger(&ledger)?;

    let mut reinstalled: Vec<String> = Vec::new();
    let mut skipped: Vec<PurgeSkip> = Vec::new();
    for record in &mine {
        if record.source == "mod-hub" {
            let id = record.id.clone();
            let name = record.name.clone();
            let root = game_root.clone();
            let app_handle = app.clone();
            match mod_catalog::install::mod_catalog_install_inner(
                id.clone(),
                root,
                app_handle,
                record.preset.clone(),
            )
            .await
            {
                Ok(_) => reinstalled.push(name),
                Err(e) => skipped.push(PurgeSkip {
                    name,
                    reason: e.to_string(),
                }),
            }
        }
    }

    // Adoption pass: copy the recognized units of the old tree back and
    // register them as WoWSP local installs.
    let known_names: Vec<String> = mine
        .iter()
        .filter(|record| record.source != "mod-hub")
        .map(|record| record.name.clone())
        .collect();
    let catalog_names: Vec<String> = reinstalled.clone();
    let backup_for_adopt = backup.clone();
    let live_for_adopt = live.clone();
    let adopted = tauri::async_runtime::spawn_blocking(move || {
        adopt_units(
            &backup_for_adopt,
            &live_for_adopt,
            &known_names,
            &catalog_names,
            adopt_foreign,
        )
    })
    .await
    .map_err(|e| anyhow!("adopt task failed: {e}"))??;

    let mut ledger = mod_catalog::ledger::load_ledger();
    let mut adopted_names: Vec<String> = Vec::new();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    for (index, unit) in adopted.into_iter().enumerate() {
        let name = unit.name.clone();
        let record = ModInstallRecord {
            id: format!("local-{stamp}-{index}-{}", slug(&name)),
            name: name.clone(),
            version: String::new(),
            category: "local".into(),
            source: "local".into(),
            preset: None,
            discussion: None,
            bin_version: bin_version.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            files: unit.files,
            restore_dir: None,
            game_root: game_root.clone(),
        };
        let res_mods = manifest::res_mods_of(&game_root, &record.bin_version);
        manifest::hub_apply(manifest::ManifestOp::UpsertManaged {
            res_mods,
            id: record.id.clone(),
            entry: super::manifest::WowspManifest::entry_from_record(&record),
        });
        ledger.installs.push(record);
        adopted_names.push(name);
    }
    mod_catalog::ledger::save_ledger(&ledger)?;

    let report = PurgeReinstallReport {
        removed_files,
        reinstalled,
        adopted: adopted_names,
        skipped,
        backup_path: Some(backup.to_string_lossy().into_owned()),
    };
    tracing::warn!(
        root = %game_root,
        removed_files = report.removed_files,
        reinstalled = report.reinstalled.len(),
        adopted = report.adopted.len(),
        skipped = report.skipped.len(),
        mode = ?mode,
        backup = ?report.backup_path,
        "mod_hub_purge_reinstall finished"
    );
    Ok(report)
}
