use super::classify::sanitize_dir_name;
use super::stale_migration::conflict_warnings;
use super::*;

// ── Install ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn mod_hub_install(
    source_root: String,
    game_root: String,
    plan: PackagePlan,
) -> Result<InstallReport, String> {
    // Same gate as the catalog install: the plan's copy must not interleave
    // with another install's res_mods writes or a `.bak` rename sweep.
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    ensure_res_mods_active(&game_root)?;
    // Validate BEFORE any rewind happens: an invalid plan must not uninstall
    // the previous version only to fail afterwards.
    validate_plan(&plan)?;
    let src = PathBuf::from(&source_root);
    if !src.is_dir() {
        return Err(format!("package not found: {}", src.display()));
    }
    let mut ledger = super::mod_catalog::load_ledger();
    let (outcome, ledger) = tauri::async_runtime::spawn_blocking(move || {
        // Reinstalling a same-named mod must first rewind its previous
        // record: files the old version shipped would linger under the new
        // one, and chained snapshots used to make a later uninstall restore
        // the previous MOD's files instead of the vanilla original.
        let mut failure = None;
        // Same plan name on THIS install only — a same-named record of
        // another game install is not ours to rewind, and the scoped
        // uninstall would fail the whole install for nothing.
        let old: Vec<String> = ledger
            .installs
            .iter()
            .filter(|r| {
                r.name.eq_ignore_ascii_case(&plan.name)
                    && (r.game_root.is_empty() || r.game_root == game_root)
            })
            .map(|r| r.id.clone())
            .collect();
        for id in old {
            if let Err(e) =
                super::mod_catalog::uninstall_from_ledger(&mut ledger.installs, &id, &game_root)
            {
                failure = Some(e);
                break;
            }
        }
        let outcome = match failure {
            Some(e) => Err(e),
            None => match install_plan(&src, &game_root, &plan) {
                // Local installs are ledger-recorded too, so their uninstall
                // restores whatever vanilla files they overwrote — unrecorded
                // local installs used to leave overwritten originals
                // unrestorable.
                Ok(mut applied) => {
                    let record = local_record(&applied, &plan, &game_root);
                    let id = record.id.clone();
                    // Local installs speak the same wowsp.toml contract as
                    // catalog ones — the manifest row is the shared half of
                    // this record.
                    super::manifest::hub_apply(super::manifest::ManifestOp::UpsertManaged {
                        res_mods: super::manifest::res_mods_of(
                            &game_root,
                            &applied.report.bin_version,
                        ),
                        id: id.clone(),
                        entry: super::manifest::WowspManifest::entry_from_record(&record),
                    });
                    ledger.installs.push(record);
                    // Say whose files this install clobbered (the journal
                    // already snapshotted them).
                    let conflicts = conflict_warnings(
                        &applied.written,
                        &ledger.installs,
                        &id,
                        &applied.report.bin_version,
                        &game_root,
                    );
                    applied.report.conflicts = conflicts.clone();
                    applied.report.warnings.extend(conflicts);
                    Ok(applied)
                },
                Err(e) => Err(e),
            },
        };
        (outcome, ledger)
    })
    .await
    .map_err(|e| format!("install task: {e}"))?;
    let applied = match outcome {
        Ok(applied) => applied,
        Err(e) => {
            // The rewind already changed the ledger even though the install
            // failed — persist it so the on-disk ledger does not describe
            // files that are already gone.
            if let Err(se) = super::mod_catalog::save_ledger(&ledger) {
                tracing::warn!(error = %se, "ledger save failed after failed install");
            }
            return Err(e);
        },
    };
    super::mod_catalog::save_ledger(&ledger)?;
    tracing::info!(
        name = %applied.report.name,
        files = applied.written.len(),
        restore = ?applied.restore_dir,
        "mod_hub_install recorded in ledger"
    );
    Ok(applied.report)
}

/// Ledger record for a local-folder install.
pub(crate) fn local_record(
    applied: &PlanApply,
    plan: &PackagePlan,
    game_root: &str,
) -> ModInstallRecord {
    ModInstallRecord {
        id: format!(
            "local-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            sanitize_dir_name(&plan.name)
        ),
        name: plan.name.clone(),
        version: String::new(),
        category: "local".into(),
        source: "local".into(),
        preset: None,
        discussion: None,
        bin_version: applied.report.bin_version.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        files: applied.written.clone(),
        restore_dir: applied
            .restore_dir
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        game_root: game_root.to_string(),
    }
}

/// Core installer shared by the local-folder command and the online catalog:
/// applies `plan` for `game_root`, recording every written file (res_mods-
/// relative) and snapshotting overwritten originals for later restore. Every
/// write goes through the journal — temp+rename into place, mandatory
/// pre-overwrite snapshots, full rollback on any failure — so a broken
/// install never leaves a half-copied mod in the game tree.
pub(crate) fn install_plan(
    src: &Path,
    game_root: &str,
    plan: &PackagePlan,
) -> Result<PlanApply, String> {
    install_plan_inner(src, game_root, plan, &[])
}

/// [`install_plan`] plus loose game-root payloads (catalog packs shipping a
/// DLL next to their `res_mods/` tree) — journaled in the same transaction,
/// so a failure rolls the game-root copies back with everything else.
pub(crate) fn install_plan_with_loose(
    src: &Path,
    game_root: &str,
    plan: &PackagePlan,
    loose: &[PathBuf],
) -> Result<PlanApply, String> {
    install_plan_inner(src, game_root, plan, loose)
}

fn install_plan_inner(
    src: &Path,
    game_root: &str,
    plan: &PackagePlan,
    loose: &[PathBuf],
) -> Result<PlanApply, String> {
    validate_plan(plan)?;
    if !src.is_dir() {
        return Err(format!("package not found: {}", src.display()));
    }
    let (bin_version, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let res_mods = ver_dir.join("res_mods");

    // Created up front: snapshots are mandatory before any overwrite, so the
    // restore dir must exist before the first file moves.
    let restore_dir = restore_root().join(format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        sanitize_dir_name(&plan.name)
    ));
    fs::create_dir_all(&restore_dir).map_err(|e| format!("create restore dir: {e}"))?;

    let mut journal = InstallJournal {
        res_mods: res_mods.clone(),
        game_root: PathBuf::from(game_root),
        restore_dir: restore_dir.clone(),
        actions: Vec::new(),
        placed: std::collections::HashSet::new(),
        written: Vec::new(),
    };
    let mut warnings = plan.warnings.clone();
    let wrote = {
        let mut wrote = 0usize;
        let mut touched_pnf = false;
        let outcome = (|| -> Result<(), String> {
            for entry in &plan.entries {
                let from = if entry.from_rel == "." {
                    src.to_path_buf()
                } else {
                    src.join(&entry.from_rel)
                };
                let to = res_mods.join(&entry.to_rel);
                wrote += copy_tree(&from, &to, &mut journal)?;
                if entry.from_rel.eq_ignore_ascii_case("PnFMods") {
                    touched_pnf = true;
                }
            }
            // PNF skin installs must leave the 0-byte loader marker behind.
            if touched_pnf {
                let loader = res_mods.join("PnFModsLoader.py");
                if !loader.is_file() {
                    journal.place_empty(&loader, Place::ResMods)?;
                    if !warnings.iter().any(|w| w.contains("PnFModsLoader")) {
                        warnings.push("created missing PnFModsLoader.py".into());
                    }
                }
            }
            // Loose game-root payloads: same journal, same rollback.
            for path in loose {
                let name = path
                    .file_name()
                    .ok_or_else(|| format!("{} has no file name", path.display()))?;
                journal.place(path, &Path::new(game_root).join(name), Place::GameRoot)?;
                wrote += 1;
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => wrote,
            Err(e) => {
                // Put everything back before reporting the failure.
                return match journal.rollback() {
                    Ok(()) => {
                        let _ = fs::remove_dir_all(&restore_dir);
                        Err(e)
                    },
                    Err(rb) => Err(format!(
                        "{e} (rollback incomplete: {rb}; snapshots kept in {})",
                        restore_dir.display()
                    )),
                };
            },
        }
    };
    let mut written = journal.written;

    // An untouched restore dir means nothing was overwritten — drop it so
    // uninstall does not chase ghosts.
    let restore_dir = if restore_root_has_files(&restore_dir) {
        Some(restore_dir)
    } else {
        fs::remove_dir(&restore_dir).ok();
        None
    };
    written.sort();
    tracing::info!(name = %plan.name, wrote, "install_plan done");
    Ok(PlanApply {
        report: InstallReport {
            name: plan.name.clone(),
            bin_version,
            wrote_files: wrote,
            warnings,
            conflicts: Vec::new(),
        },
        written,
        restore_dir,
    })
}

/// Plan paths arrive from the frontend or the catalog pipeline — validate
/// before anything touches the disk: relative only, no `..`, no drive
/// letters, no backslashes. `from_rel` may be `.` (the bare-voice wrapper
/// maps the package root itself); `to_rel` must name a concrete destination
/// under res_mods.
fn validate_plan(plan: &PackagePlan) -> Result<(), String> {
    if plan.entries.is_empty() {
        return Err("plan has no entries".into());
    }
    for entry in &plan.entries {
        check_plan_rel(&entry.from_rel, "fromRel", true)?;
        check_plan_rel(&entry.to_rel, "toRel", false)?;
    }
    Ok(())
}

pub(crate) fn check_plan_rel(rel: &str, field: &str, allow_dot: bool) -> Result<(), String> {
    use std::path::Component;
    if rel.is_empty() || rel.contains('\\') || rel.contains(':') || Path::new(rel).is_absolute() {
        return Err(format!("invalid {field} in plan: {rel:?}"));
    }
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(_) => {},
            Component::CurDir if allow_dot => {},
            _ => return Err(format!("invalid {field} in plan: {rel:?}")),
        }
    }
    Ok(())
}

fn restore_root_has_files(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some())
}

/// `<data>/mods/restore/` — pre-overwrite snapshots, keyed by ts + mod name.
pub(crate) fn restore_root() -> PathBuf {
    // Test seam: unit tests redirect the snapshot root into their own tmp
    // dir — otherwise they write into (and their cleanup wipes) the user's
    // REAL restore dir, and parallel tests race each other's snapshots.
    #[cfg(test)]
    if let Some(dir) = TEST_RESTORE_ROOT.with(|slot| slot.borrow().clone()) {
        fs::create_dir_all(&dir).ok();
        return dir;
    }
    let base = crate::paths::ensure_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("mods")
        .join("restore");
    fs::create_dir_all(&base).ok();
    base
}

#[cfg(test)]
thread_local! {
    static TEST_RESTORE_ROOT: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Point [`restore_root`] at a test-owned directory for the rest of the
/// current thread; dropping the guard restores the real path.
#[cfg(test)]
pub(crate) struct RestoreRootGuard(());

#[cfg(test)]
impl Drop for RestoreRootGuard {
    fn drop(&mut self) {
        TEST_RESTORE_ROOT.with(|slot| *slot.borrow_mut() = None);
    }
}

#[cfg(test)]
pub(crate) fn test_restore_root_in(dir: &Path) -> RestoreRootGuard {
    TEST_RESTORE_ROOT.with(|slot| *slot.borrow_mut() = Some(dir.to_path_buf()));
    RestoreRootGuard(())
}
