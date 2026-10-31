//! Stranded purge-backup recovery: the surface for the
//! 'res_mods.wowsp-purge-<stamp>' trees 'mod_hub_purge_reinstall' leaves
//! behind.
//!
//! The purge itself is not transactional: it moves the whole res_mods
//! aside, drops the root's ledger rows, reinstalls the catalog units and
//! adopts the recognized leftovers — an app exit anywhere between the
//! rename and the last step strands the backup next to a half-rebuilt
//! live tree with no surface to finish or undo it (the 2026-10-31
//! incident: three stranded backups, an empty res_mods, ledger rows
//! gone). This module makes the flow crash-resumable:
//!
//! - the purge writes a 'wowsp-purge-state.json' marker INTO the backup it
//!   just created (scope, planned units, completed units, known locals)
//!   and keeps it current after every reinstall — the marker's PRESENCE
//!   is the "unfinished" verdict, because a completed flow removes it;
//! - 'mod_hub_purge_backups' lists every backup with its marker state;
//! - 'purge::mod_hub_purge_backup_resume' walks the remaining units
//!   through the same verified install path the purge used;
//! - delete refuses while the marker is unfinished; dismiss removes ONLY
//!   the marker (the files stay — a plain completed backup);
//! - restore-merge folds a COMPLETED backup's files back into the live
//!   tree under the stale-bin migration's keep-new rule (the live copy
//!   always wins), so an abandoned purge can be undone file-by-file
//!   instead of by hand — it refuses while the marker is unfinished, like
//!   delete (resolve first: resume or dismiss). Bookkeeping
//!   ('installed_mods.xml', 'wowsp.toml', the loader marker) and the
//!   bundled probe never transplant — the same rules 'stale_migration'
//!   applies.

use anyhow::anyhow;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::{CommandResult, PurgeSkip};

use super::super::ingame_plugin;
use super::stale_migration::{
    collect_tree_files, dest_owns_keep_new, ensure_loader_marker, is_migration_bookkeeping,
};
use super::*;

/// The unfinished-purge marker, written inside a fresh backup dir and
/// removed when the whole flow finishes. Its PRESENCE is the "unfinished"
/// verdict (a crash mid-flow leaves it behind; a completed flow deletes
/// it), so a backup without one is just a backup.
pub(crate) const MARKER_NAME: &str = "wowsp-purge-state.json";

/// Directory-name prefix of every purge backup.
const BACKUP_PREFIX: &str = "res_mods.wowsp-purge-";

/// Upper bound of the list command's per-backup file walk — an abandoned
/// integration-pack backup can carry six-digit file counts; the UI only
/// needs to know "at least this many".
const FILE_COUNT_CAP: u64 = 200_000;

// ── Wire shapes (app-crate side, mirroring the shared crate's pattern) ──────

/// One catalog unit a purge planned to reinstall — the marker's unit
/// shape. The id is the anchor (the resume feeds it back through the
/// verified install path); name and preset ride along because the purge
/// already dropped the ledger rows that carried them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PurgePlanUnit {
    pub id: String,
    pub name: String,
    /// Install-time scheme the unit carried (see CatalogPreset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
}

impl PurgePlanUnit {
    pub(crate) fn of_record(record: &ModInstallRecord) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            preset: record.preset.clone(),
        }
    }
}

/// The unfinished-purge state marker ('wowsp-purge-state.json'): what the
/// flow planned, what completed, and which locals its adoption pass
/// re-registers on resume.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeMarkerState {
    /// 'wowsp-only' or 'adopt-foreign' — the purge scope the user picked.
    pub mode: String,
    /// Catalog units the flow set out to reinstall.
    pub planned: Vec<PurgePlanUnit>,
    /// Units that completed (updated after each reinstall).
    pub done: Vec<PurgePlanUnit>,
    /// Local (non-catalog) unit names the ledger knew — the adoption pass
    /// copies those back and re-registers them once reinstalls settle.
    #[serde(default)]
    pub known: Vec<String>,
    /// RFC3339 stamp of the moment the purge started.
    pub started_at: String,
}

/// One 'res_mods.wowsp-purge-*' backup directory, as the webui sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeBackup {
    /// Bare directory name (the list/delete/dismiss/restore key).
    pub dir_name: String,
    /// Absolute path of the backup tree.
    pub path: String,
    /// Unix seconds parsed from the directory name.
    pub stamp: u64,
    /// Files inside (bounded walk — see FILE_COUNT_CAP).
    pub file_count: u64,
    /// The unfinished-purge marker file exists. A backup without it is a
    /// completed purge (today's behavior — just a backup).
    pub has_marker: bool,
    /// Parsed marker payload; None when absent or unreadable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<PurgeMarkerState>,
}

/// Result of finishing an interrupted purge
/// ('purge::mod_hub_purge_backup_resume').
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResumeReport {
    /// Units the marker already carried as done before this resume.
    pub resumed_done: usize,
    /// Units this resume reinstalled from the catalog.
    pub reinstalled: Vec<String>,
    /// Units copied back from the backup and registered as WoWSP local
    /// installs (the adoption pass).
    pub adopted: Vec<String>,
    /// Units that could not be reinstalled.
    pub skipped: Vec<PurgeSkip>,
    /// Where the backup tree lives.
    pub backup_path: String,
}

/// Result of restore-merging a purge backup into the live res_mods.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeBackupRestoreReport {
    /// Backup files copied into the live tree.
    pub merged_files: usize,
    /// Files not transplanted: live-owned conflicts plus bookkeeping and
    /// probe files (which never transplant).
    pub skipped_files: usize,
    /// The live tree already owned these paths (keep-new) — the signal
    /// that the backup was kept.
    pub conflict_files: usize,
    /// A conflict-free merge consumed the backup dir; a conflicted one
    /// kept it whole for manual resolution.
    pub backup_removed: bool,
}

// ── Marker IO ───────────────────────────────────────────────────────────────

/// Where the marker lives inside a backup dir.
pub(crate) fn marker_path(backup: &Path) -> PathBuf {
    backup.join(MARKER_NAME)
}

/// Does the unfinished-purge marker exist? Presence alone decides
/// "unfinished" — a torn or corrupt marker still counts (its backup must
/// not be deletable as "completed" while its purge state is unknown).
pub(crate) fn marker_exists(backup: &Path) -> bool {
    marker_path(backup).is_file()
}

/// Write the marker (create or refresh) into a backup dir. Atomic by
/// construction: the bytes land in a temp sibling first and the final
/// name appears through a rename, so a crash mid-write can never leave a
/// truncated marker that a later resume would misread as state.
pub(crate) fn write_marker(backup: &Path, state: &PurgeMarkerState) -> anyhow::Result<()> {
    let json =
        serde_json::to_string_pretty(state).map_err(|e| anyhow!("serialize purge marker: {e}"))?;
    let final_path = marker_path(backup);
    let tmp = super::sibling_with_suffix(&final_path, ".wowsp-part");
    fs::write(&tmp, json).map_err(|e| anyhow!("write purge marker: {e}"))?;
    fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        anyhow!("commit purge marker: {e}")
    })
}

/// Parse the marker. Errors when absent (nothing to resume) or corrupt
/// (the state is unknown — dismiss or delete, never guess).
pub(crate) fn read_marker(backup: &Path) -> anyhow::Result<PurgeMarkerState> {
    let raw = fs::read(marker_path(backup)).map_err(|e| anyhow!("read purge marker: {e}"))?;
    serde_json::from_slice(&raw).map_err(|e| anyhow!("parse purge marker: {e}"))
}

/// Remove the marker — the flow finished, the backup becomes a plain
/// snapshot. Best-effort: the caller already completed the real work.
pub(crate) fn remove_marker(backup: &Path) {
    let _ = fs::remove_file(marker_path(backup));
}

/// What a resume still has to reinstall: planned minus done, keyed by id,
/// in planned order.
pub(crate) fn pending_units(marker: &PurgeMarkerState) -> Vec<PurgePlanUnit> {
    marker
        .planned
        .iter()
        .filter(|u| !marker.done.iter().any(|d| d.id == u.id))
        .cloned()
        .collect()
}

/// The tolerant-resume decision (the 2026-10-31 incident shape): after a
/// crash mid-reinstall the live tree is NOT empty — it carries the files
/// of the units the loop finished before dying, each with the ledger row
/// the same verified install wrote. That state is exactly resumable: the
/// decision PROCEEDS when every live res_mods file is claimed by a ledger
/// row of THIS root+bin whose unit id sits in the marker's done[] (the
/// row and the files landed together, so the coverage proves provenance).
/// Any file outside that set — a half-written unit whose row never
/// landed, a stray leftover, anything predating the purge — REFUSES: a
/// half-state of unknown provenance routes to a fresh purge (which
/// re-backs-up the half state and reinstalls clean), never to installs
/// layered over it. An EMPTY live tree always proceeds (the crash
/// happened before the first install completed).
pub(crate) fn ensure_live_tree_resumeable(
    game_root: &str,
    bin_version: &str,
    live: &Path,
    marker: &PurgeMarkerState,
    installs: &[ModInstallRecord],
) -> anyhow::Result<()> {
    let live_files = bounded_tree_rels(live)?;
    if live_files.is_empty() {
        return Ok(());
    }
    // The allowed set: files claimed by rows of THIS root+bin whose unit
    // id is in done[]. '@game/'-prefixed entries live outside res_mods and
    // are irrelevant to this walk. Case-insensitive membership (Windows
    // filesystem semantics; rows and walk derive from the same paths the
    // installs wrote).
    let done_ids: std::collections::HashSet<String> = marker
        .done
        .iter()
        .map(|u| u.id.to_ascii_lowercase())
        .collect();
    let allowed: std::collections::HashSet<String> = installs
        .iter()
        .filter(|r| done_ids.contains(&r.id.to_ascii_lowercase()))
        .filter(|r| r.game_root.is_empty() || r.game_root.eq_ignore_ascii_case(game_root))
        .filter(|r| r.bin_version == bin_version)
        .flat_map(|r| r.files.iter().cloned())
        .filter(|f| !f.starts_with("@game/"))
        .map(|f| f.to_ascii_lowercase())
        .collect();
    if live_files
        .iter()
        .all(|f| allowed.contains(&f.to_ascii_lowercase()))
    {
        return Ok(());
    }
    Err(anyhow!(
        "the live res_mods carries files no completed unit of this purge claims — this half-state cannot be resumed safely: mark the backup done, then run a fresh purge (it moves the half state into a new backup and reinstalls clean)"
    ))
}

/// Bounded walk of a tree as forward-slash root-relative paths. Errors
/// when the tree carries more than FILE_COUNT_CAP files — a resumable
/// live tree holds only reinstalled catalog units, so an oversized walk
/// is itself a 'not the expected shape' verdict and must refuse
/// conservatively instead of deciding on a truncated list.
fn bounded_tree_rels(root: &Path) -> anyhow::Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| anyhow!("read {}: {e}", dir.display()))?;
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let rel = p
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel.is_empty() {
                continue;
            }
            out.push(rel);
            if out.len() >= FILE_COUNT_CAP as usize {
                return Err(anyhow!(
                    "the live res_mods carries more than {FILE_COUNT_CAP} files — not a resumable state; mark the backup done and run a fresh purge"
                ));
            }
        }
    }
    Ok(out)
}

// ── Backup discovery ────────────────────────────────────────────────────────

/// 'res_mods.wowsp-purge-<unix-stamp>' (or '...-<stamp>-<n>', the
/// same-second collision suffix) to the stamp. None for anything else.
fn parse_stamp(dir_name: &str) -> Option<u64> {
    let rest = dir_name.strip_prefix(BACKUP_PREFIX)?;
    let first = rest.split('-').next()?;
    first.parse::<u64>().ok()
}

/// Every purge-backup directory under this root's bin tree — normally
/// only the current version dir carries one, but a game update strands
/// older ones exactly like the safe-mode twins.
fn backup_dirs(game_root: &str) -> anyhow::Result<Vec<PathBuf>> {
    let bin = Path::new(game_root).join("bin");
    let mut out = Vec::new();
    let versions = fs::read_dir(&bin).map_err(|e| anyhow!("read {}: {e}", bin.display()))?;
    for ver in versions.flatten() {
        if !ver.path().is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(ver.path()) else {
            continue;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() && parse_stamp(&ent.file_name().to_string_lossy()).is_some() {
                out.push(path);
            }
        }
    }
    Ok(out)
}

/// Resolve a webui-supplied dir_name to an existing backup directory.
/// The name must be a well-formed purge-backup name (no separators, no
/// '..', a parseable stamp) AND an actual directory under this root's
/// bin tree — the webview's word is never the write boundary (audit H-3).
pub(crate) fn resolve_backup(game_root: &str, dir_name: &str) -> anyhow::Result<PathBuf> {
    if dir_name.contains(['/', '\\']) || dir_name.contains("..") || parse_stamp(dir_name).is_none()
    {
        return Err(anyhow!("{dir_name:?} is not a purge backup directory name"));
    }
    backup_dirs(game_root)?
        .into_iter()
        .find(|p| p.file_name().is_some_and(|n| n == dir_name))
        .ok_or_else(|| anyhow!("no purge backup named {dir_name} under {game_root}/bin"))
}

/// The new-purge gate: does ANY backup under this root still carry the
/// unfinished marker? Returns the first offender's dir name. Marker-file
/// presence only — a corrupt marker blocks too (its state is unknown).
pub(crate) fn any_unfinished(game_root: &str) -> anyhow::Result<Option<String>> {
    for backup in backup_dirs(game_root)? {
        if marker_exists(&backup) {
            let name = backup
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Bounded file count of a backup tree (see FILE_COUNT_CAP).
fn bounded_file_count(root: &Path) -> u64 {
    let mut count = 0u64;
    let mut stack = vec![root.to_path_buf()];
    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                count += 1;
            }
            if count >= FILE_COUNT_CAP {
                break 'walk;
            }
        }
    }
    count
}

// ── List ────────────────────────────────────────────────────────────────────

/// Every purge backup of this install, newest first, with its marker
/// state. Read-only.
#[tauri::command]
pub fn mod_hub_purge_backups(game_root: String) -> CommandResult<Vec<PurgeBackup>> {
    super::ensure_known_game_root(&game_root)?;
    Ok(list_backups(&game_root)?)
}

pub(crate) fn list_backups(game_root: &str) -> anyhow::Result<Vec<PurgeBackup>> {
    let mut out: Vec<PurgeBackup> = Vec::new();
    for backup in backup_dirs(game_root)? {
        let dir_name = backup
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push(PurgeBackup {
            stamp: parse_stamp(&dir_name).unwrap_or(0),
            file_count: bounded_file_count(&backup),
            has_marker: marker_exists(&backup),
            marker: read_marker(&backup).ok(),
            dir_name,
            path: backup.to_string_lossy().into_owned(),
        });
    }
    // Newest first (stamp desc). Same-second collisions break the tie by
    // name desc, so the suffixed '...-<stamp>-1' twin — created AFTER the
    // base name — sorts first.
    out.sort_by(|a, b| {
        b.stamp
            .cmp(&a.stamp)
            .then_with(|| b.dir_name.cmp(&a.dir_name))
    });
    Ok(out)
}

// ── Delete / dismiss ────────────────────────────────────────────────────────

/// Permanently delete a COMPLETED purge backup. Refuses while the
/// unfinished marker is present — that backup still describes recovery
/// work in flight (resume it or dismiss the marker first). Takes the
/// mod-hub gate like every mutating command: a delete racing a resume or
/// restore-merge would destroy the source tree the other flow reads.
#[tauri::command]
pub async fn mod_hub_purge_backup_delete(
    window: tauri::Window,
    game_root: String,
    dir_name: String,
) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    super::ensure_known_game_root(&game_root)?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    Ok(delete_backup(&game_root, &dir_name)?)
}

pub(crate) fn delete_backup(game_root: &str, dir_name: &str) -> anyhow::Result<()> {
    let backup = resolve_backup(game_root, dir_name)?;
    if marker_exists(&backup) {
        return Err(anyhow!(
            "this backup's purge never finished — resume it or mark it done before deleting the files"
        ));
    }
    fs::remove_dir_all(&backup).map_err(|e| anyhow!("delete {}: {e}", backup.display()))
}

/// Remove ONLY the unfinished marker: the backup keeps every file and
/// becomes a plain completed snapshot (the user waived the resume). Takes
/// the mod-hub gate like every mutating command: a dismiss racing a
/// resume would delete the very state the resume is driving.
#[tauri::command]
pub async fn mod_hub_purge_backup_dismiss(
    window: tauri::Window,
    game_root: String,
    dir_name: String,
) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    super::ensure_known_game_root(&game_root)?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    Ok(dismiss_marker(&game_root, &dir_name)?)
}

pub(crate) fn dismiss_marker(game_root: &str, dir_name: &str) -> anyhow::Result<()> {
    let backup = resolve_backup(game_root, dir_name)?;
    if !marker_exists(&backup) {
        return Err(anyhow!(
            "backup {dir_name:?} has no unfinished-purge marker — nothing to dismiss"
        ));
    }
    fs::remove_file(marker_path(&backup))
        .map_err(|e| anyhow!("remove the marker of {dir_name:?}: {e}"))
}

// ── Restore-merge ───────────────────────────────────────────────────────────

/// Fold a COMPLETED backup's files back into the live res_mods under the
/// stale-bin migration's keep-new rule: a path the live tree already
/// owns (live file, disabled '.bak' twin, or a twin's live counterpart)
/// is NEVER overwritten — the newer live copy wins. Refuses while the
/// unfinished marker is present, exactly like delete — an unfinished
/// backup must be resolved first (resume it, or dismiss the marker and
/// waive the reinstall) before its files merge back. Bookkeeping
/// ('installed_mods.xml', 'wowsp.toml', 'mods/installed.json', the
/// loader marker) and the bundled probe never transplant: a manifest
/// would resurrect rows for files the live tree never got, and the
/// loader marker is re-created from the backup's own bytes only when
/// the merge lands PnF content with no marker (the migration's exact
/// rule). The merge COPIES (a conflicted backup stays whole — it is the
/// user's only copy); only a conflict-free merge consumes the backup dir.
#[tauri::command]
pub async fn mod_hub_purge_backup_restore(
    window: tauri::Window,
    game_root: String,
    dir_name: String,
) -> CommandResult<PurgeBackupRestoreReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    super::ensure_known_game_root(&game_root)?;
    super::ensure_game_closed(&game_root)?;
    super::ensure_res_mods_active(&game_root)?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    Ok(restore_backup(&game_root, &dir_name)?)
}

pub(crate) fn restore_backup(
    game_root: &str,
    dir_name: &str,
) -> anyhow::Result<PurgeBackupRestoreReport> {
    let backup = resolve_backup(game_root, dir_name)?;
    if marker_exists(&backup) {
        return Err(anyhow!(
            "this backup's purge never finished — resume it or mark it done before merging its files back"
        ));
    }
    let (_, ver_dir) = super::latest_bin_version(game_root)
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {game_root}/bin"))?;
    let live = ver_dir.join("res_mods");
    fs::create_dir_all(&live).map_err(|e| anyhow!("create {}: {e}", live.display()))?;
    // Captured BEFORE the merge: the backup's own loader bytes (see the
    // module doc — transplanted only for freshly marked PnF content).
    let backup_loader = fs::read(backup.join("PnFModsLoader.py")).ok();

    let mut merged = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;
    let mut merged_rels: Vec<String> = Vec::new();
    for rel in collect_tree_files(&backup)? {
        if is_migration_bookkeeping(&rel) || ingame_plugin::is_probe_path(&rel) {
            skipped += 1;
            continue;
        }
        let dst = live.join(&rel);
        if dest_owns_keep_new(&dst) {
            conflicts += 1;
            skipped += 1;
            continue;
        }
        let src = backup.join(&rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
        }
        fs::copy(&src, &dst).map_err(|e| anyhow!("copy {}: {e}", src.display()))?;
        merged_rels.push(rel);
        merged += 1;
    }
    let backup_removed = conflicts == 0;
    if backup_removed {
        fs::remove_dir_all(&backup).map_err(|e| anyhow!("delete {}: {e}", backup.display()))?;
    }
    ensure_loader_marker(&live, backup_loader.as_deref());
    // Merged files reach the pre-release twins too (see preload_mirror) —
    // the same fan-out the stale-bin migration runs after its sweep.
    for warning in super::preload_mirror::mirror_written(game_root, &live, &merged_rels).warnings {
        tracing::warn!("{warning}");
    }
    super::preload_mirror::ensure_loader_markers(game_root);
    tracing::info!(
        backup = %dir_name,
        merged,
        skipped,
        conflicts,
        backup_removed,
        "purge backup restore-merged"
    );
    Ok(PurgeBackupRestoreReport {
        merged_files: merged,
        skipped_files: skipped,
        conflict_files: conflicts,
        backup_removed,
    })
}
