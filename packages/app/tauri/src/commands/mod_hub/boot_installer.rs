//! The Aslain boot re-installer — detection and the disarm action.
//!
//! Aslain's modpack ships `PnFMods/ModsInstaller_<version>` as a PnFMods
//! mod whose `Main.py` re-runs the modpack installer at EVERY game start,
//! re-applying its descriptor XMLs (`mods/*.xml` inside the unit). WoWSP's
//! own catalog packs bundle the very same tree (it is in the
//! shared-component registry, see `mod_catalog::uninstall`'s
//! `SHARED_COMPONENT_ROOTS`), so after WoWSP rewrites a shared tree the
//! next boot silently re-applies Aslain's side and the two ledgers stop
//! recognizing each other — WoWSP's signature checks start failing with
//! "signature time is invalid" / "constants.json missing" (the loader-health
//! verdicts) while Aslain's manifest keeps claiming rows WoWSP already cut.
//!
//! This module answers "is that unit in the tree, and WHAT would it
//! re-apply?" (the read command feeding the Resources strip) and provides
//! DISARM: remove every family unit plus cut every manifest row it would
//! re-apply, so the next game start has nothing to re-apply.

use anyhow::anyhow;

use wowsp_tauri_shared::{BootInstallerDisarmReport, BootInstallerInfo, CommandResult};

use super::installed_units::{classify_installed_root, unit_files};
use super::scan_installed::scan_root;
use super::*;

/// The boot re-installer's PnFMods family prefix — the same spelling as the
/// shared-component registry root ("the family prefix, not a pinned
/// version": Aslain bumps the digit per release, ModsInstaller_4_3_1,
/// ModsInstaller_4_4_0, …), kept here so detection, the purge-adoption skip
/// and any future surface agree on ONE rule.
pub(crate) const BOOT_INSTALLER_PREFIX: &str = "pnfmods/modsinstaller_";

/// The directory-name half of the same prefix (what a PnFMods child is
/// compared against, case-insensitively).
const BOOT_INSTALLER_DIR_PREFIX: &str = "modsinstaller_";

/// Is this res_mods-relative root part of a boot re-installer unit?
/// Lowercase + forward-slash normalized, like the registry keys.
pub(crate) fn is_boot_installer_path(rel: &str) -> bool {
    rel.to_ascii_lowercase()
        .replace('\\', "/")
        .starts_with(BOOT_INSTALLER_PREFIX)
}

/// Every boot re-installer family directory of the tree —
/// `(dir name, absolute path)`, name-sorted (deterministic across
/// rescans). A leftover older version beside the current one (game update
/// mid-release, a partial installer run) is a family member exactly like
/// the live one: every dir re-applies at boot.
fn boot_installer_dirs(res_mods: &Path) -> Vec<(String, PathBuf)> {
    let mut dirs: Vec<(String, PathBuf)> = fs::read_dir(res_mods.join("PnFMods"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|ent| ent.path().is_dir())
        .map(|ent| (ent.file_name().to_string_lossy().into_owned(), ent.path()))
        .filter(|(name, _)| {
            name.to_ascii_lowercase()
                .starts_with(BOOT_INSTALLER_DIR_PREFIX)
        })
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    dirs
}

/// The live tree's boot re-installer footprint, when one exists: EVERY
/// `PnFMods/ModsInstaller_*` family directory contributes its descriptor
/// names (the rows re-applied at every game start); `unit_rel_path` and
/// `version` speak the alphabetically first dir, and the manifest rows
/// are the ones currently pairing with the union (any descriptor, or a
/// family dir's own name — some installs carry a row for the installer
/// itself).
pub(crate) fn detect_boot_installer(res_mods: &Path) -> Option<BootInstallerInfo> {
    let family = boot_installer_dirs(res_mods);
    let (first, _) = family.first()?.clone();

    let mut descriptors: Vec<String> = family
        .iter()
        .flat_map(|(_, dir)| descriptor_names(dir))
        .collect();
    descriptors.sort();
    descriptors.dedup();
    // Rows the installer would re-apply AND the ledger currently knows
    // about. Case-insensitive: Windows file ownership is.
    let mut wanted: std::collections::BTreeSet<String> =
        descriptors.iter().map(|d| d.to_ascii_lowercase()).collect();
    for (name, _) in &family {
        wanted.insert(name.to_ascii_lowercase());
    }
    let manifest_rows: Vec<String> = super::scan_installed::parse_installed_manifest(res_mods)
        .into_iter()
        .filter(|row| wanted.contains(&row.name.to_ascii_lowercase()))
        .map(|row| row.name)
        .collect();

    // The version digit encoded in the directory name
    // ("ModsInstaller_4_3_1" → "4_3_1"); the family prefix is 14 chars in
    // any casing, so a plain skip lands after the underscore.
    let suffix: String = first
        .chars()
        .skip(BOOT_INSTALLER_DIR_PREFIX.len())
        .collect();
    Some(BootInstallerInfo {
        version: (!suffix.is_empty()).then_some(suffix),
        unit_rel_path: format!("PnFMods/{first}"),
        descriptors,
        manifest_rows,
    })
}

/// File names (stems) of `mods/*.xml` inside the unit — the rows the
/// installer re-applies. `.bak` twins count under their live stems, sorted
/// for deterministic rescans.
fn descriptor_names(unit_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(unit_dir.join("mods")) else {
        return out;
    };
    for ent in entries.flatten() {
        if !ent.path().is_file() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        let stem_len = if lower.ends_with(".xml.bak") {
            name.len() - ".xml.bak".len()
        } else if lower.ends_with(".xml") {
            name.len() - ".xml".len()
        } else {
            continue;
        };
        let stem = name[..stem_len].to_string();
        if !stem.is_empty() {
            out.push(stem);
        }
    }
    out.sort();
    out
}

/// Read side: does the live tree carry the boot re-installer, and what
/// would it re-apply? `None` when no `PnFMods/ModsInstaller_*` unit exists
/// (the Resources strip hides itself on `None`).
#[tauri::command]
pub fn mod_hub_boot_installer(game_root: String) -> CommandResult<Option<BootInstallerInfo>> {
    let res_mods = scan_root(&game_root)?;
    Ok(detect_boot_installer(&res_mods))
}

/// DISARM — remove every boot re-installer family unit and cut every
/// manifest row it would re-apply, so the next game start re-applies
/// nothing. Classified units go through the shared unit-uninstall path
/// (file removal, ledger unwind with snapshot restores, mirror cleanup,
/// the unit's own manifest row); because that ledger unwind can RESTORE
/// the very bytes the removal just deleted (see the sweep note in the
/// core), a second pass hard-removes every family dir still on disk.
/// Guards sit in the core so tests can drive the refusals (unknown root,
/// safe mode) without a window: the command layer adds the main-window
/// label gate and the mod-hub mutex exactly like every other mutation.
#[tauri::command]
pub async fn mod_hub_disarm_boot_installer(
    window: tauri::Window,
    game_root: String,
) -> CommandResult<BootInstallerDisarmReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    super::ensure_known_game_root(&game_root)?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    let report = disarm_boot_installer_core(&game_root)?;
    tracing::info!(
        root = %game_root,
        removed = report.removed_files,
        rows = report.cut_rows,
        "boot re-installer disarmed"
    );
    Ok(report)
}

/// The disarm core, split from the command so tests drive it without the
/// async gate or a window (the same seam as
/// `restore_pnf_loader_marker_core`). Refuses exactly like every other
/// res_mods mutation: game closed, no safe-mode quarantine — then hands the
/// REAL ledger to the inner disarm.
pub(crate) fn disarm_boot_installer_core(
    game_root: &str,
) -> anyhow::Result<BootInstallerDisarmReport> {
    super::ensure_game_closed(game_root)?;
    super::ensure_res_mods_active(game_root)?;
    let res_mods = scan_root(game_root)?;
    let mut ledger = super::mod_catalog::load_ledger();
    let report = disarm_boot_installer_in(game_root, &res_mods, &mut ledger.installs)?;
    super::mod_catalog::save_ledger(&ledger)?;
    Ok(report)
}

/// The disarm over an in-memory record list — the seam the tests drive
/// (the same shape `uninstall_unit_core` established). Removes EVERY
/// family unit, sweeps what the ledger unwind restores, cuts the rows.
pub(crate) fn disarm_boot_installer_in(
    game_root: &str,
    res_mods: &Path,
    installs: &mut Vec<ModInstallRecord>,
) -> anyhow::Result<BootInstallerDisarmReport> {
    let family = boot_installer_dirs(res_mods);
    if family.is_empty() {
        return Err(anyhow!(
            "no PnFMods/ModsInstaller_* unit found under res_mods — nothing to disarm"
        ));
    }

    // The row set to cut, derived BEFORE anything is removed (the sweep
    // below deletes the descriptor files themselves): every family dir's
    // descriptors plus every family dir name, lowercased.
    let mut wanted: std::collections::BTreeSet<String> = family
        .iter()
        .flat_map(|(_, dir)| descriptor_names(dir))
        .map(|d| d.to_ascii_lowercase())
        .collect();
    for (name, _) in &family {
        wanted.insert(name.to_ascii_lowercase());
    }

    let mut removed = 0usize;
    // Preferred path: every family dir the scanner classifies as a unit
    // (they carry Main.py) goes through the FULL unit uninstall — same as
    // the foreign pane's uninstall button, including the ledger unwind and
    // the unit's own manifest row. Disjoint trees, so the uninstalls are
    // independent; each may trim/unwind ledger records claiming its files.
    let units: Vec<InstalledMod> = classify_installed_root(res_mods, None)
        .into_iter()
        .filter(|u| u.paths.iter().any(|p| is_boot_installer_path(p)))
        .collect();
    for unit in units {
        let report = super::unit_ops::uninstall_unit_core(game_root, res_mods, &unit, installs)?;
        removed += report.removed_files;
    }

    // RESURRECTION SWEEP (round-2 audit): the ledger unwind above RESTORES
    // snapshot layers for record files the unit covered — in the flagship
    // ordering (Aslain's install first, then a WoWSP pack bundling
    // pnfmods/modsinstaller_) those layers ARE Aslain's Main.py and
    // descriptor XMLs, so the tree the uninstall just deleted comes
    // straight back. Hard-remove every family dir still (again) on disk;
    // the same pass also covers the degenerate no-entry-script shape no
    // unit uninstall ever touched.
    for (name, dir) in &family {
        if !dir.is_dir() {
            continue;
        }
        let rel = format!("PnFMods/{name}");
        removed += unit_files(res_mods, &rel).len();
        fs::remove_dir_all(dir).map_err(|e| anyhow!("remove {}: {e}", dir.display()))?;
        super::unit_ops::prune_empty_parents(res_mods, std::slice::from_ref(&rel));
        super::preload_mirror::mirror_removed(game_root, std::slice::from_ref(&rel));
    }

    // Cut every manifest row the installer would re-apply (the units' own
    // rows may already have gone with the uninstalls above — this sweep is
    // idempotent, an already-cut row simply matches nothing).
    let cut_rows = super::unit_ops::remove_manifest_entries_where(res_mods, |name| {
        wanted.contains(&name.to_ascii_lowercase())
    });

    Ok(BootInstallerDisarmReport {
        removed_files: removed,
        cut_rows,
    })
}
