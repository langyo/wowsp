use super::installed_units::{classify_installed_root, unit_covers, unit_files};
use super::scan_installed::{parse_installed_manifest, scan_root};
use super::*;

// ── Unit enable / uninstall ─────────────────────────────────────────────────

#[tauri::command]
pub async fn mod_hub_set_unit_enabled(
    game_root: String,
    rel_path: String,
    enabled: bool,
) -> Result<UnitToggleReport, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    ensure_res_mods_active(&game_root)?;
    let (bin_version, ver_dir) = latest_bin_version(&game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let res_mods = ver_dir.join("res_mods");
    if !res_mods.is_dir() {
        return Err("res_mods directory not found".into());
    }
    let unit = classify_installed_root(&res_mods)
        .into_iter()
        .find(|u| u.rel_path == rel_path)
        .ok_or_else(|| format!("no installed plugin at {rel_path}"))?;
    if unit.paths.is_empty() {
        return Err(format!("{rel_path} has no files to toggle"));
    }
    // Disabling a shared catch-all group (all of `content/`, every loose gui
    // file, …) that also carries files of a catalog-recorded mod living
    // elsewhere would leave that mod half-active — a registered PnF payload
    // whose textures or unbound fragments just vanished is a load-time
    // crash. Refuse and point at the mod's own entry instead.
    if !enabled {
        let ledger = super::mod_catalog::load_ledger();
        if let Some(other) = ledger
            .installs
            .iter()
            // Stale records from an older bin/<version> — or another game
            // install entirely — never describe what the current client
            // loads; they must not block the toggle.
            .filter(|r| r.bin_version == bin_version)
            .filter(|r| r.game_root.is_empty() || r.game_root == game_root)
            .find(|r| half_disable_violation(r, &unit.paths))
        {
            return Err(format!(
                "\"{}\" shares this group with \"{}\", which also installs files outside it — disabling the group would leave that mod half-active. Disable or uninstall \"{}\" from its own entry instead.",
                unit.name, other.name, other.name
            ));
        }
    }
    let renamed = set_paths_state(&res_mods, &unit.paths, enabled)?;
    // The pre-release twins take the same live/.bak state — a mod disabled
    // before the version switch must not come back alive after it.
    super::preload_mirror::mirror_set_state(&game_root, &unit.paths, enabled);
    // Keep wowsp.toml's enabled flags in step for records this unit covers
    // COMPLETELY (partial overlap would leave the row's state ambiguous —
    // the half-disable guard above already refused that direction). The
    // records also backfill rows for installs that predate the manifest.
    {
        let ledger = super::mod_catalog::load_ledger();
        let mut covered: Vec<ModInstallRecord> = ledger
            .installs
            .iter()
            .filter(|r| r.bin_version == bin_version)
            .filter(|r| r.game_root.is_empty() || r.game_root == game_root)
            .filter(|r| {
                r.files
                    .iter()
                    .any(|f| !f.starts_with("@game/") && unit_covers(&unit.paths, f))
            })
            .filter(|r| !half_disable_violation(r, &unit.paths))
            .cloned()
            .collect();
        // The bundled in-game plugin has no ledger record by design — its
        // manifest row is maintained here directly.
        if unit_covers(&unit.paths, &bundled_plugin_entry()) {
            covered.push(bundled_plugin_record());
        }
        super::manifest::hub_apply(super::manifest::ManifestOp::SetEnabled {
            res_mods: res_mods.clone(),
            records: covered,
            enabled,
        });
    }
    tracing::info!(rel = %rel_path, enabled, renamed, "mod_hub_set_unit_enabled done");
    Ok(UnitToggleReport {
        rel_path,
        disabled: !enabled,
        renamed_files: renamed,
    })
}

/// Catalog id of the bundled in-game stats plugin (no ledger record —
/// its wowsp.toml row is maintained at the mutation points that touch it).
pub(crate) const BUNDLED_PLUGIN_ID: &str = "battle.ingame.stats";

/// The plugin's presence probe (mirrors ingame_plugin.rs): the entry file
/// the unit tree must cover for the bundled row to apply.
fn bundled_plugin_entry() -> String {
    format!("PnFMods/{}/Main.py", super::super::ingame_plugin::MOD_DIR)
}

/// A synthetic record describing the bundled plugin for toggle sync (the
/// manifest row it backfills/maintains).
fn bundled_plugin_record() -> ModInstallRecord {
    ModInstallRecord {
        id: BUNDLED_PLUGIN_ID.into(),
        name: "WoWSP In-Game Tab Stats Plugin".into(),
        version: "0.1.0".into(),
        category: "battle".into(),
        source: "bundled".into(),
        discussion: None,
        preset: None,
        bin_version: String::new(),
        installed_at: String::new(),
        files: vec![bundled_plugin_entry()],
        restore_dir: None,
        game_root: String::new(),
    }
}

/// Sync the bundled in-game plugin's wowsp.toml row to a new enabled
/// state — the manifest tail of the unit toggle, split out for the
/// stale-bin migration's probe carry-over (which re-applies a stranded
/// DISABLED verdict after reinstalling the files fresh).
pub(crate) fn set_bundled_plugin_enabled(res_mods: &Path, enabled: bool) {
    super::manifest::hub_apply(super::manifest::ManifestOp::SetEnabled {
        res_mods: res_mods.to_path_buf(),
        records: vec![bundled_plugin_record()],
        enabled,
    });
}

/// Would toggling `paths` OFF disable only part of this record's mod? True
/// when some of its files live under the paths and others do not (files
/// outside the group — or in the game root — would stay live).
pub(crate) fn half_disable_violation(record: &ModInstallRecord, paths: &[String]) -> bool {
    let mut inside = false;
    let mut outside = false;
    for f in &record.files {
        if f.starts_with("@game/") {
            outside = true;
        } else if unit_covers(paths, f) {
            inside = true;
        } else {
            outside = true;
        }
    }
    inside && outside
}

/// Rename every file of a unit between live names and `.bak` twins
/// (disabling appends the suffix, enabling strips it). Existing targets are
/// skipped, never clobbered; a partially-applied state heals on the next
/// toggle in the same direction. Returns how many files moved.
pub(crate) fn set_paths_state(
    res_mods: &Path,
    paths: &[String],
    enabled: bool,
) -> Result<usize, String> {
    let mut renamed = 0usize;
    for rel in paths {
        for file in unit_files(res_mods, rel) {
            let Some(name) = file.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            let target = if enabled {
                if !name.ends_with(".bak") {
                    continue;
                }
                file.with_file_name(&name[..name.len() - 4])
            } else {
                if name.ends_with(".bak") {
                    continue;
                }
                file.with_file_name(format!("{name}.bak"))
            };
            if target.exists() {
                continue;
            }
            fs::rename(&file, &target).map_err(|e| format!("rename {}: {e}", file.display()))?;
            renamed += 1;
        }
    }
    Ok(renamed)
}

#[tauri::command]
pub async fn mod_hub_uninstall_unit(
    game_root: String,
    rel_path: String,
) -> Result<super::mod_catalog::UninstallReport, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    ensure_res_mods_active(&game_root)?;
    let res_mods = scan_root(&game_root)?;
    if !res_mods.is_dir() {
        return Err("res_mods directory not found".into());
    }
    let unit = classify_installed_root(&res_mods)
        .into_iter()
        .find(|u| u.rel_path == rel_path)
        .ok_or_else(|| format!("no installed plugin at {rel_path}"))?;

    let mut ledger = super::mod_catalog::load_ledger();
    let report = uninstall_unit_core(&game_root, &res_mods, &unit, &mut ledger.installs)?;
    super::mod_catalog::save_ledger(&ledger)?;
    Ok(report)
}

/// Everything [`mod_hub_uninstall_unit`] does once the unit is resolved —
/// split out so tests can drive it against an in-memory record list instead
/// of the real ledger. Deletes the unit's files directly FIRST, then lets
/// the ledger records restore their vanilla snapshots (whose targets may
/// well be paths this unit had overwritten — deleting first means the
/// restore actually lands instead of being wiped by the tree removal),
/// prunes emptied parents and syncs Aslain's manifest when the unit came
/// from it.
pub(crate) fn uninstall_unit_core(
    game_root: &str,
    res_mods: &Path,
    unit: &InstalledMod,
    installs: &mut Vec<ModInstallRecord>,
) -> Result<super::mod_catalog::UninstallReport, String> {
    let mut removed = 0usize;
    let mut restored = 0usize;

    // Everything the ledger did not know about goes away directly — live
    // paths and their `.bak` twins alike. Ledger-covered files are also
    // removed here; the ledger pass below tolerates already-missing files
    // and only counts what it still finds.
    if !unit.paths.is_empty() {
        for rel in &unit.paths {
            let path = res_mods.join(rel);
            let twin = if rel.ends_with(".bak") {
                res_mods.join(&rel[..rel.len() - 4])
            } else {
                res_mods.join(format!("{rel}.bak"))
            };
            if path.is_dir() {
                removed += unit_files(res_mods, rel).len();
                fs::remove_dir_all(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
            } else if path.is_file() {
                fs::remove_file(&path).ok();
                removed += 1;
            }
            if twin.is_file() {
                fs::remove_file(&twin).ok();
                removed += 1;
            }
        }
        prune_empty_parents(res_mods, &unit.paths);
        // The mirrored copies go with the live ones (see preload_mirror).
        super::preload_mirror::mirror_removed(game_root, &unit.paths);
    }

    // Ledger records overlapping the unit: a record whose files the unit
    // covers completely gets the full uninstall (restore + drop). A record
    // that also owns files OUTSIDE the unit — another mod sharing this
    // folder tree — is trimmed to match instead: the old behavior silently
    // uninstalled that whole mod, deleting files the user never asked about
    // and leaving a half-removed plugin behind.
    let mut idx = 0usize;
    while idx < installs.len() {
        let (all_covered, id, covered) = {
            let record = &installs[idx];
            // Another install's records are not ours to uninstall or trim.
            if !record.game_root.is_empty() && record.game_root != game_root {
                idx += 1;
                continue;
            }
            let covered: Vec<String> = record
                .files
                .iter()
                .filter(|f| !f.starts_with("@game/") && unit_covers(&unit.paths, f))
                .cloned()
                .collect();
            (
                record
                    .files
                    .iter()
                    .all(|f| f.starts_with("@game/") || unit_covers(&unit.paths, f)),
                record.id.clone(),
                covered,
            )
        };
        if covered.is_empty() {
            idx += 1;
            continue;
        }
        if all_covered {
            let report = super::mod_catalog::uninstall_from_ledger(installs, &id, game_root)?;
            removed += report.removed_files;
            restored += report.restored_files;
        } else {
            let (r, s) = trim_covered_files(&mut installs[idx], &covered, game_root)?;
            removed += r;
            restored += s;
            if installs[idx].files.is_empty() {
                installs.remove(idx);
            } else {
                idx += 1;
            }
        }
    }

    // Keep the foreign installer's manifest describing reality: when the
    // unit's name matches one of its rows the row goes with the files —
    // anchored Aslain units (versionless rows included, or a foreign-pane
    // uninstall would zombie-loop them) and units whose install replaced
    // a row's files alike. No matching row → the call is a no-op.
    remove_manifest_entry(res_mods, &unit.name);
    // The bundled in-game plugin's unit carries no ledger record — drop its
    // wowsp.toml row here too or it would outlive its files.
    if unit_covers(&unit.paths, &bundled_plugin_entry()) {
        super::manifest::hub_apply(super::manifest::ManifestOp::RemoveManaged {
            res_mods: res_mods.to_path_buf(),
            id: BUNDLED_PLUGIN_ID.to_string(),
        });
    }

    tracing::info!(rel = %unit.rel_path, removed, restored, "uninstall_unit_core done");
    Ok(super::mod_catalog::UninstallReport {
        id: unit.rel_path.clone(),
        name: unit.name.clone(),
        removed_files: removed,
        restored_files: restored,
    })
}

/// Remove directories a unit emptied, walking each root's parents up to (and
/// excluding) the res_mods root itself. `remove_dir` only succeeds on empty
/// directories, so shared parents with other units survive.
pub(crate) fn prune_empty_parents(res_mods: &Path, paths: &[String]) {
    for rel in paths {
        let mut dir = res_mods.join(rel).parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            if d == res_mods || !d.starts_with(res_mods) {
                break;
            }
            if fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
}

/// Remove a unit's covered files from a partially-overlapping ledger record:
/// deletes those files (plus their `.bak` twins), restores only their
/// snapshots, and trims them from the record so it keeps describing the files
/// it still owns. Drops the record (and its restore dir) when nothing is
/// left. Returns (removed, restored) counts.
fn trim_covered_files(
    record: &mut ModInstallRecord,
    covered: &[String],
    game_root: &str,
) -> Result<(usize, usize), String> {
    let res_mods = Path::new(game_root)
        .join("bin")
        .join(&record.bin_version)
        .join("res_mods");
    let mut removed = 0usize;
    let mut restored = 0usize;
    // The unit pass above usually removed these trees already; disabled
    // twins and stragglers are caught here.
    for rel in covered {
        for path in [res_mods.join(rel), res_mods.join(format!("{rel}.bak"))] {
            if path.is_file() {
                fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
                removed += 1;
            }
        }
    }
    // Bring back the vanilla files this record snapshotted under the covered
    // paths, and drop those snapshots so the surviving record's restore dir
    // describes only its remaining files.
    if let Some(dir) = record.restore_dir.as_ref() {
        let restore = PathBuf::from(dir);
        if restore.is_dir() {
            let mut restored_snaps: Vec<PathBuf> = Vec::new();
            let mut stack = vec![restore.clone()];
            while let Some(d) = stack.pop() {
                let Ok(entries) = fs::read_dir(&d) else {
                    continue;
                };
                for ent in entries.flatten() {
                    let p = ent.path();
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    let Ok(rel) = p.strip_prefix(&restore) else {
                        continue;
                    };
                    if rel.starts_with("@game") {
                        continue;
                    }
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if !covered.contains(&rel) {
                        continue;
                    }
                    let dest = res_mods.join(&rel);
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("create {}: {e}", parent.display()))?;
                    }
                    fs::copy(&p, &dest).map_err(|e| format!("restore {}: {e}", dest.display()))?;
                    restored += 1;
                    restored_snaps.push(p);
                }
            }
            for p in restored_snaps {
                let _ = fs::remove_file(&p);
            }
        }
    }
    record.files.retain(|f| !covered.contains(f));
    if record.files.is_empty() {
        if let Some(dir) = record.restore_dir.as_ref() {
            let _ = fs::remove_dir_all(PathBuf::from(dir));
        }
        record.restore_dir = None;
    }
    Ok((removed, restored))
}

/// Drop one `<mod name="…"/>` row from Aslain's manifest after its unit was
/// uninstalled. Best effort: a failed rewrite leaves the manifest untouched.
fn remove_manifest_entry(res_mods: &Path, name: &str) {
    let path = res_mods.join("installed_mods.xml");
    let Ok(body) = fs::read_to_string(&path) else {
        return;
    };
    let spans: Vec<(usize, usize)> = parse_installed_manifest(res_mods)
        .into_iter()
        .filter(|e| e.name == name)
        .map(|e| e.span)
        .collect();
    if spans.is_empty() {
        return;
    }
    let mut out = String::with_capacity(body.len());
    let mut cursor = 0usize;
    for (start, end) in spans {
        if start < cursor {
            continue;
        }
        out.push_str(&body[cursor..start]);
        cursor = end;
    }
    out.push_str(&body[cursor..]);
    // Atomic rewrite: a crash mid-write must not corrupt the manifest other
    // tools (Aslain's installer) also depend on.
    let tmp = path.with_file_name("installed_mods.xml.tmp");
    fs::write(&tmp, &out)
        .and_then(|_| fs::rename(&tmp, &path))
        .ok();
}

/// Cut every Aslain-manifest row the scan-time pairing assigns to
/// `entry_id` — the registration half of "register & reinstall": once
/// WoWSP installs over a foreign copy, the foreign installer's own ledger
/// must stop claiming the unit (the next scan re-anchors the files under
/// the WoWSP record and sweeps the `[foreign.*]` row). The row set comes
/// from the SAME best-match verdict the scan badges the UI with, so only
/// rows the user saw as this entry's copies are touched. Returns how many
/// rows were cut — attempted, that is: the rewrite is best-effort, a
/// failed one leaves the row for the next retry to cut.
pub(crate) fn remove_manifest_entries_for_entry(
    res_mods: &Path,
    catalog: &wowsp_tauri_shared::CatalogIndex,
    entry_id: &str,
) -> usize {
    let names = super::foreign::aslain_rows_for_entry(res_mods, catalog, entry_id);
    for name in &names {
        remove_manifest_entry(res_mods, name);
    }
    names.len()
}

/// Uninstall a ModStation unit: its whole tree under
/// `bin/<version>/mods/` — the only place the station installs, and a
/// tree the res_mods unit-ops never see (which is why foreign-pane
/// actions route here instead of through `mod_hub_uninstall_unit`).
/// Gated on the game being closed like every mutation, but NOT on
/// `ensure_res_mods_active`: safe mode's quarantine renames res_mods
/// only, and this tree is outside it.
#[tauri::command]
pub async fn mod_hub_uninstall_modstation_unit(
    game_root: String,
    key: String,
) -> Result<(), String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    let (_, ver_dir) = latest_bin_version(&game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let dir = super::foreign::modstation_dir_for_key(&ver_dir.join("mods"), &key)
        .ok_or_else(|| format!("no ModStation unit keyed {key:?}"))?;
    fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    tracing::info!(dir = %dir.display(), "modstation unit uninstalled");
    Ok(())
}
