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

    // Crash-resume gate: an unfinished marker means the PREVIOUS purge
    // never completed — its backup still describes work in flight, and a
    // second rename would strand another half-state on top of it. The
    // user resolves the old one first (resume, mark done, or delete).
    if let Some(name) = purge_backups::any_unfinished(&game_root)? {
        return Err(anyhow!(
            "the previous purge never finished — backup {name} still carries its state marker; resume it or mark it done in the purge-backup list first"
        )
        .into());
    }

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

    // Crash-resume marker (purge_backups): everything the flow is about
    // to do, written into the backup the rename just created. Its
    // presence is the "unfinished" verdict until the flow removes it at
    // the end — so an app exit mid-reinstall leaves a resumable state
    // instead of a stranded mystery dir.
    let mut marker = purge_backups::PurgeMarkerState {
        mode: if adopt_foreign {
            "adopt-foreign"
        } else {
            "wowsp-only"
        }
        .to_string(),
        planned: mine
            .iter()
            .filter(|record| record.source == "mod-hub")
            .map(purge_backups::PurgePlanUnit::of_record)
            .collect(),
        done: Vec::new(),
        known: mine
            .iter()
            .filter(|record| record.source != "mod-hub")
            .map(|record| record.name.clone())
            .collect(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Err(e) = purge_backups::write_marker(&backup, &marker) {
        // The rename already happened — aborting now would strand a worse
        // state than a purge without crash-resume info. Degrade loudly.
        tracing::warn!(
            error = %e,
            backup = %backup.display(),
            "write purge marker failed — the flow runs without crash-resume state"
        );
    }

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
                Ok(_) => {
                    // Progress persistence (purge_backups): each completed
                    // unit folds into the marker immediately, so a crash
                    // mid-loop resumes from the exact frontier. A failed
                    // write is logged — it only costs crash-resume
                    // fidelity, never the install itself.
                    if let Some(unit) = marker.planned.iter().find(|u| u.id == id).cloned() {
                        marker.done.push(unit);
                        if let Err(e) = purge_backups::write_marker(&backup, &marker) {
                            tracing::warn!(
                                error = %e,
                                backup = %backup.display(),
                                "persist purge progress failed — the marker lags behind"
                            );
                        }
                    }
                    reinstalled.push(name);
                },
                Err(e) => skipped.push(PurgeSkip {
                    name,
                    reason: e.to_string(),
                }),
            }
        }
    }

    // Partial-failure policy: a planned reinstall that could not complete
    // leaves the flow unfinished ON PURPOSE — the marker stays (done[] is
    // exact, the failed units remain pending) and the adoption pass waits
    // for a fully successful resume, because re-running adoption over a
    // half-reinstalled state would duplicate its ledger rows. The user
    // resolves the marker through the backups surface: resume once the
    // cause is fixed, or dismiss to waive it (plain snapshot).
    let partial = !skipped.is_empty();
    let adopted_names = if partial {
        Vec::new()
    } else {
        // Adoption pass: copy the recognized units of the old tree back
        // and register them as WoWSP local installs (shared with the
        // resume — see adopt_and_register).
        let known_names: Vec<String> = marker.known.clone();
        let catalog_names: Vec<String> = marker.done.iter().map(|unit| unit.name.clone()).collect();
        adopt_and_register(
            &game_root,
            &bin_version,
            &backup,
            &live,
            &known_names,
            &catalog_names,
            adopt_foreign,
        )
        .await?
    };

    // The whole flow finished — the marker goes, and the backup becomes a
    // plain snapshot. A partial run keeps it for the resume above.
    if !partial {
        purge_backups::remove_marker(&backup);
    }

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

/// The adoption tail the purge and the resume share: copy the recognized
/// units of the backup back into the live tree and register them as WoWSP
/// local installs (ledger + wowsp.toml rows). `catalog_names` are the
/// units a verified reinstall already placed — adoption never overwrites
/// those. Returns the adopted display names.
async fn adopt_and_register(
    game_root: &str,
    bin_version: &str,
    backup: &Path,
    live: &Path,
    known_names: &[String],
    catalog_names: &[String],
    adopt_foreign: bool,
) -> anyhow::Result<Vec<String>> {
    let backup_for_adopt = backup.to_path_buf();
    let live_for_adopt = live.to_path_buf();
    let known = known_names.to_vec();
    let catalog = catalog_names.to_vec();
    let adopted = tauri::async_runtime::spawn_blocking(move || {
        adopt_units(
            &backup_for_adopt,
            &live_for_adopt,
            &known,
            &catalog,
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
            bin_version: bin_version.to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            files: unit.files,
            restore_dir: None,
            game_root: game_root.to_string(),
            hashes: None,
            snapshot_hashes: None,
        };
        let res_mods = manifest::res_mods_of(game_root, &record.bin_version);
        manifest::hub_apply(manifest::ManifestOp::UpsertManaged {
            res_mods,
            id: record.id.clone(),
            entry: super::manifest::WowspManifest::entry_from_record(&record),
        });
        ledger.installs.push(record);
        adopted_names.push(name);
    }
    mod_catalog::ledger::save_ledger(&ledger)?;
    Ok(adopted_names)
}

/// Finish an interrupted purge: the backup's marker (purge_backups) names
/// what the flow planned and what already completed, and the remainder
/// goes through the SAME verified install path the purge used. A fully
/// successful pass runs the adoption pass (registering the recognized
/// leftovers) and removes the marker; a partial one keeps the marker at
/// the exact frontier — whatever completed stays recorded, the failed
/// units remain pending for the next resume, and adoption waits so it
/// never duplicates rows over a half-reinstalled state.
///
/// Tolerant of the incident shape (purge_backups::ensure_live_tree_resumeable):
/// after a crash mid-reinstall the live tree carries exactly the done
/// units' files — every one claimed by its ledger row — and that state
/// resumes. A live file NO done row claims (a half-written unit whose row
/// never landed, a stray leftover) refuses: that half-state routes to a
/// fresh purge, which re-backs-up it and reinstalls clean.
#[tauri::command]
pub async fn mod_hub_purge_backup_resume(
    window: tauri::Window,
    game_root: String,
    dir_name: String,
    app: tauri::AppHandle,
) -> CommandResult<purge_backups::PurgeResumeReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    super::ensure_known_game_root(&game_root)?;
    super::ensure_game_closed(&game_root)?;
    super::ensure_res_mods_active(&game_root)?;
    let _gate = mod_catalog::mod_hub_gate().await;

    let backup = purge_backups::resolve_backup(&game_root, &dir_name)?;
    let mut marker = purge_backups::read_marker(&backup)?;
    let (bin_version, ver_dir) = super::latest_bin_version(&game_root)
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {game_root}/bin"))?;
    let live = ver_dir.join("res_mods");
    if !live.is_dir() {
        return Err(anyhow!("res_mods not found — there is nothing to resume into").into());
    }
    // Tolerant resume decision: the done units' files on disk are exactly
    // the expected post-crash state; anything unclaimed refuses with the
    // dismiss-plus-fresh-purge verdict.
    let ledger = mod_catalog::ledger::load_ledger();
    purge_backups::ensure_live_tree_resumeable(
        &game_root,
        &bin_version,
        &live,
        &marker,
        &ledger.installs,
    )?;
    // The ledger rows are LEFT ALONE on purpose: the done units' rows
    // describe exactly the files the decision just verified (dropping
    // them would orphan the reinstall the resume builds on), and a pending
    // unit's own same-id row — should one survive from before the purge —
    // is rewound by install_inner itself.

    let adopt_foreign = marker.mode == "adopt-foreign";
    let resumed_done = marker.done.len();
    let mut reinstalled: Vec<String> = Vec::new();
    let mut skipped: Vec<PurgeSkip> = Vec::new();
    for unit in purge_backups::pending_units(&marker) {
        let root = game_root.clone();
        let app_handle = app.clone();
        match mod_catalog::install::mod_catalog_install_inner(
            unit.id.clone(),
            root,
            app_handle,
            unit.preset.clone(),
        )
        .await
        {
            Ok(_) => {
                // Same progress persistence as the purge loop: the marker
                // stays at the exact frontier of what completed (a failed
                // write is logged — it only costs crash-resume fidelity,
                // never the install itself).
                marker.done.push(unit.clone());
                if let Err(e) = purge_backups::write_marker(&backup, &marker) {
                    tracing::warn!(
                        error = %e,
                        backup = %backup.display(),
                        "persist resume progress failed — the marker lags behind"
                    );
                }
                reinstalled.push(unit.name.clone());
            },
            Err(e) => skipped.push(PurgeSkip {
                name: unit.name.clone(),
                reason: e.to_string(),
            }),
        }
    }

    // Same partial-failure policy as the purge: units that failed again
    // keep the flow unfinished (the marker stays at the exact frontier,
    // done[] up to date) and the adoption pass waits — re-running it over
    // a half-reinstalled state would duplicate its ledger rows. A fully
    // successful pass adopts and finishes.
    let partial = !skipped.is_empty();
    let adopted_names = if partial {
        Vec::new()
    } else {
        // Adoption pass, over everything the (interrupted + resumed) flow
        // reinstalled: the backup's recognized units come back as WoWSP
        // local installs unless a catalog reinstall already replaced them.
        let known_names: Vec<String> = marker.known.clone();
        let catalog_names: Vec<String> = marker.done.iter().map(|unit| unit.name.clone()).collect();
        adopt_and_register(
            &game_root,
            &bin_version,
            &backup,
            &live,
            &known_names,
            &catalog_names,
            adopt_foreign,
        )
        .await?
    };

    // The resume finished the flow — the marker goes. A partial run keeps
    // it (whatever completed is persisted), and an adoption failure above
    // bubbles up with the marker still in place at the reinstall
    // frontier — exactly the crash-resume contract.
    if !partial {
        purge_backups::remove_marker(&backup);
    }

    let report = purge_backups::PurgeResumeReport {
        resumed_done,
        reinstalled,
        adopted: adopted_names,
        skipped,
        backup_path: backup.to_string_lossy().into_owned(),
    };
    tracing::warn!(
        root = %game_root,
        resumed_done = report.resumed_done,
        reinstalled = report.reinstalled.len(),
        adopted = report.adopted.len(),
        skipped = report.skipped.len(),
        backup = %report.backup_path,
        "mod_hub_purge_backup_resume finished"
    );
    Ok(report)
}
