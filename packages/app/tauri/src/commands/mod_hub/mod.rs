//! Mod Hub package classification & install (milestone M10 groundwork).
//!
//! Classifies real-world WoWS plugin packages into the taxonomy from
//! `docs/<lang>/designs/mod-formats.md` and installs them under
//! `bin/<latest>/res_mods/`, following the Aslain layout convention so both
//! installers coexist.
//!
//! Format facts encoded here come from inspecting 22 distributed packages:
//!
//! - Voice banks live at `banks/mods/<name>/mod.xml` (+ `.wem`). Some packs
//!   ship uppercase `Mods`, so all matches are case-insensitive. "Bare" packs
//!   (a root `AudioModification` xml + loose `.wem`) must be wrapped into a
//!   `banks/mods/<name>/` folder; the xml `<Name>` becomes the in-game
//!   voice-over selector label.
//! - PnF skins register via `Main.py` calling `contentSdk.registerShipMod('<ShipId>')`;
//!   two skins for the same ship id conflict. The loader marker
//!   `PnFModsLoader.py` is a 0-byte placeholder the game requires — many packs
//!   omit it, so installs create it when missing.
//! - Rest are plain override trees (`content/`, `gui/…`) or single config
//!   patches (`ime_config.xml`).
//!
//! Archives (.zip/.7z) land with M10.2's unpack step — this round accepts
//! already-unpacked directories and returns a structured error for files.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use wowsp_tauri_shared::{
    InstallReport, InstalledMod, MigrateReport, MigrationPlan, ModInstallRecord, ModKind,
    PackagePlan, PackagePlanEntry, PlanFile, StaleBinInfo, TextureAnalysis, UnitToggleReport,
};

/// What [`install_plan`] did, beyond the user-facing report: the exact files
/// written (res_mods-relative) and where overwritten originals were snapshotted.
pub(crate) struct PlanApply {
    pub report: InstallReport,
    pub written: Vec<String>,
    /// Directory holding pre-overwrite copies, `None` when nothing was replaced.
    pub restore_dir: Option<PathBuf>,
}

/// Locate the numeric `bin/<version>/` dir mods must target — the unified
/// game context's rule (preferences.xml pin preferred, then idx-carrying
/// build, numeric fallback), kept as a thin local shim returning
/// `(version name, dir)` for the call sites.
fn latest_bin_version(game_root: &str) -> Option<(String, PathBuf)> {
    super::game_context::latest_bin_dir(std::path::Path::new(game_root))
        .map(|(n, p)| (n.to_string(), p))
}

/// Extract `<Name>value</Name>` of the first such tag (ASCII-case-insensitive).
fn first_xml_tag(body: &str, tag: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let start = lower.find(&open)? + open.len();
    let close = lower[start..].find(&format!("</{}>", tag.to_ascii_lowercase()))?;
    Some(body[start..start + close].trim().to_string())
}

/// Pull `registerShipMod('<arg>')` out of a PnF `Main.py`. Byte-level so it
/// also works on compiled `Main.pyc` payloads — real Aslain packs ship
/// bytecode, and the marshal format keeps string constants as plain bytes.
fn registered_ship_id_bytes(body: &[u8]) -> Option<String> {
    let needle = b"registerShipMod";
    let at = body.windows(needle.len()).position(|w| w == needle)?;
    let rest = &body[at + needle.len()..];
    let quote = *rest.iter().find(|b| **b == b'\'' || **b == b'"')?;
    let rest = &rest[rest.iter().position(|b| *b == quote)? + 1..];
    let end = rest.iter().position(|b| *b == quote)?;
    let id = &rest[..end];
    if id.is_ascii() {
        Some(String::from_utf8_lossy(id).trim().to_string())
    } else {
        None
    }
}

/// The PnF entry script, under any real-world spelling: `Main.py`,
/// compiled `Main.pyc`, either with a `.bak` twin when disabled.
fn find_pnf_main(dir: &Path) -> Option<PathBuf> {
    for name in ["Main.py", "Main.pyc"] {
        if let (Some(path), _) = existing_with_bak(dir, name) {
            return Some(path);
        }
    }
    None
}

/// Refuse to mutate a game tree while THAT client is live: the game holds
/// its res_mods files open and re-reads them at every battle load, so
/// mid-session writes, renames and deletes leave torn half-installed mods —
/// the classic "the mod manager crashed my game" report. Aslain's installer
/// guards the same way (it warns when the game is running before touching
/// files). Root-scoped: a DIFFERENT client running elsewhere on a
/// multi-install machine does not hold this tree open and must not block
/// work on it (the unified game context resolves which folder each running
/// process belongs to).
pub(crate) fn ensure_game_closed(game_root: &str) -> Result<(), String> {
    if let Some((pid, root)) = super::game_context::running_root_matching(game_root) {
        return Err(format!(
            "World of Warships is running from {root} (pid {pid}) — close that client before installing, uninstalling or toggling mods"
        ));
    }
    Ok(())
}

/// In-flight copy suffix: a file must never land in the game tree half
/// written (the client would load a truncated mod), so every write goes
/// `<dest>.wowsp-part` first and is renamed into place.
const PART_SUFFIX: &str = ".wowsp-part";

/// Safe-mode quarantine suffix: enabling safe mode renames the current
/// `res_mods` to `res_mods.wowsp-disabled` — one atomic move takes every
/// mod (including the overlay stub and Aslain leftovers) out of the load
/// path so the player can bisect "is it the mods or the game?".
pub(crate) const SAFE_MODE_SUFFIX: &str = ".wowsp-disabled";

/// The quarantined twin of a version dir's `res_mods`.
pub(crate) fn disabled_res_mods(ver_dir: &Path) -> PathBuf {
    ver_dir.join(format!("res_mods{SAFE_MODE_SUFFIX}"))
}

/// Is safe mode visible anywhere — the current version's `res_mods`
/// quarantined, OR a twin stranded in an old version dir by a game update
/// that happened while safe mode was on? Either way the game is running
/// without those mods and the UI must offer to bring them back.
pub(crate) fn safe_mode_active(game_root: &str) -> bool {
    latest_bin_version(game_root).is_some_and(|(_, ver_dir)| disabled_res_mods(&ver_dir).is_dir())
        || !quarantined_twins(game_root).is_empty()
}

/// Every quarantined `res_mods.wowsp-disabled` under `bin/` — normally just
/// the current one, but a game update while safe mode was on strands the
/// twin in the old version dir. Returns (bin name, twin path).
fn quarantined_twins(game_root: &str) -> Vec<(String, PathBuf)> {
    let bin = Path::new(game_root).join("bin");
    let Ok(entries) = fs::read_dir(&bin) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|ent| {
            let twin = disabled_res_mods(&ent.path());
            twin.is_dir()
                .then(|| (ent.file_name().to_string_lossy().into_owned(), twin))
        })
        .collect()
}

/// Safe-mode core (split from the command so tests drive it directly).
/// Returns the new active state.
pub(crate) fn set_safe_mode_core(game_root: &str, enabled: bool) -> Result<bool, String> {
    let (_, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let live = ver_dir.join("res_mods");
    let off = disabled_res_mods(&ver_dir);
    if enabled {
        if off.is_dir() {
            return Err("safe mode is already active".into());
        }
        if !live.is_dir() {
            return Err("res_mods not found — there is nothing to quarantine".into());
        }
        fs::rename(&live, &off).map_err(|e| {
            format!(
                "quarantine {}: {e} (is the game or antivirus holding files?)",
                off.display()
            )
        })?;
    } else {
        if live.exists() && off.exists() {
            return Err(format!(
                "both {} and its quarantined copy exist — move the newer one aside manually",
                live.display()
            ));
        }
        if off.is_dir() {
            fs::rename(&off, &live).map_err(|e| format!("restore {}: {e}", live.display()))?;
        }
        // A game update while safe mode was on strands the twin in the old
        // version dir — restore those too, or the quarantine would outlive
        // the UI's safe-mode state entirely.
        for (bin, twin) in quarantined_twins(game_root) {
            let live = twin.with_file_name("res_mods");
            if live.exists() {
                tracing::warn!(
                    bin = %bin,
                    "res_mods and its quarantined twin both exist — keeping the twin at {}",
                    twin.display()
                );
                continue;
            }
            fs::rename(&twin, &live).map_err(|e| format!("restore {}: {e}", live.display()))?;
        }
    }
    Ok(disabled_res_mods(&ver_dir).is_dir())
}

/// Mutating commands refuse while `res_mods` is quarantined: writes would
/// land in a fresh `res_mods` and drift apart from the quarantined tree,
/// and leaving safe mode would then fail on the rename.
pub(crate) fn ensure_res_mods_active(game_root: &str) -> Result<(), String> {
    if safe_mode_active(game_root) {
        return Err(
            "safe mode is active — turn mods back on before installing, uninstalling or toggling them".into(),
        );
    }
    Ok(())
}

/// Which tree a destination belongs to — res_mods files are ledger-recorded
/// bare, game-root payloads under the `@game/` prefix.
#[derive(Clone, Copy)]
enum Place {
    ResMods,
    GameRoot,
}

/// One committed file write plus what it replaced, so a failure anywhere in
/// the install can rewind everything.
struct JournalAction {
    dest: PathBuf,
    /// Snapshot inside the restore dir; `None` means the file is brand new.
    snapshot: Option<PathBuf>,
}

/// Install journal. Snapshots every file about to be overwritten (a failed
/// snapshot aborts the install instead of clobbering an unrestorable
/// original), writes through temp+rename so no file is ever observed half
/// copied, and rewinds every action when any step fails — leaving the game
/// tree exactly as it was instead of a half-installed mod.
struct InstallJournal {
    res_mods: PathBuf,
    game_root: PathBuf,
    restore_dir: PathBuf,
    actions: Vec<JournalAction>,
    /// Destinations already written this install — the dedup set for `place`
    /// (integration packs reach tens of thousands of files, so this must not
    /// be a linear scan). A failed place aborts the whole install, so a
    /// claimed-but-unwritten dest never matters.
    placed: std::collections::HashSet<PathBuf>,
    /// Ledger-relative names (`a/b.xml`, `@game/foo.dll`) of placed files.
    written: Vec<String>,
}

impl InstallJournal {
    fn place(&mut self, src: &Path, dest: &Path, place: Place) -> Result<(), String> {
        // Duplicate destinations within one install (overlapping plan
        // entries): the first write already owns the file.
        if !self.placed.insert(dest.to_path_buf()) {
            return Ok(());
        }
        let snapshot = if dest.is_file() {
            Some(self.snapshot(dest, place)?)
        } else {
            None
        };
        let tmp = sibling_with_suffix(dest, PART_SUFFIX);
        if let Err(e) = fs::copy(src, &tmp) {
            // A partial temp copy must not linger in the game tree.
            let _ = fs::remove_file(&tmp);
            return Err(format!("copy {}: {e}", src.display()));
        }
        if let Err(e) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("place {}: {e}", dest.display()));
        }
        self.record(dest, place);
        self.actions.push(JournalAction {
            dest: dest.to_path_buf(),
            snapshot,
        });
        Ok(())
    }

    /// Create a brand-new empty file (the PnF loader marker) through the same
    /// temp+rename path, snapshotting whatever unexpectedly sits there.
    fn place_empty(&mut self, dest: &Path, place: Place) -> Result<(), String> {
        if dest.is_file() || !self.placed.insert(dest.to_path_buf()) {
            return Ok(());
        }
        let tmp = sibling_with_suffix(dest, PART_SUFFIX);
        fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        if let Err(e) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("place {}: {e}", dest.display()));
        }
        self.record(dest, place);
        self.actions.push(JournalAction {
            dest: dest.to_path_buf(),
            snapshot: None,
        });
        Ok(())
    }

    /// Which tree does a destination live in, as (root, snapshot subdir)?
    fn place_roots(&self, place: Place) -> (PathBuf, Option<&'static str>) {
        match place {
            Place::ResMods => (self.res_mods.clone(), None),
            Place::GameRoot => (self.game_root.clone(), Some("@game")),
        }
    }

    /// Copy an existing target aside before it gets clobbered. Unlike the old
    /// best-effort behavior, a failure is fatal: overwriting a file we cannot
    /// restore would lose the user's original forever.
    fn snapshot(&self, dest: &Path, place: Place) -> Result<PathBuf, String> {
        let (root, prefix) = self.place_roots(place);
        let rel = dest
            .strip_prefix(&root)
            .map_err(|_| format!("{} is outside the game tree", dest.display()))?;
        let rel = match prefix {
            Some(p) => Path::new(p).join(rel),
            None => rel.to_path_buf(),
        };
        let snap = self.restore_dir.join(&rel);
        if !snap.is_file() {
            if let Some(parent) = snap.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            fs::copy(dest, &snap).map_err(|e| {
                format!(
                    "snapshot {}: {e} — refusing to overwrite without a backup",
                    dest.display()
                )
            })?;
            tracing::debug!(from = %dest.display(), to = %snap.display(), "restore snapshot");
        }
        Ok(snap)
    }

    fn record(&mut self, dest: &Path, place: Place) {
        let (root, prefix) = self.place_roots(place);
        if let Ok(rel) = dest.strip_prefix(&root) {
            let name = rel.to_string_lossy().replace('\\', "/");
            self.written.push(match prefix {
                Some(p) => format!("{p}/{name}"),
                None => name,
            });
        }
    }

    /// Undo every action, newest first: snapshotted files come back, brand-
    /// new files disappear. Keeps rewinding past individual failures and
    /// reports the first error; empty directories the install created are
    /// pruned afterwards.
    fn rollback(mut self) -> Result<(), String> {
        let mut parents: Vec<PathBuf> = self
            .actions
            .iter()
            .filter_map(|a| a.dest.parent().map(|p| p.to_path_buf()))
            .collect();
        parents.sort();
        parents.dedup();
        let mut first_err: Option<String> = None;
        for action in std::mem::take(&mut self.actions).into_iter().rev() {
            let outcome = match &action.snapshot {
                Some(snap) if snap.is_file() => {
                    if let Some(parent) = action.dest.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    fs::copy(snap, &action.dest)
                        .map(|_| ())
                        .map_err(|e| format!("restore {}: {e}", action.dest.display()))
                },
                _ => match fs::remove_file(&action.dest) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(format!("remove {}: {e}", action.dest.display())),
                },
            };
            if let Err(e) = outcome {
                first_err.get_or_insert(e);
            }
        }
        // Directories the install created: remove_dir only succeeds on empty
        // ones, so anything another mod uses survives.
        for dir in parents.into_iter().rev() {
            if dir.starts_with(&self.res_mods) && dir != self.res_mods {
                let _ = fs::remove_dir(&dir);
            }
        }
        match first_err {
            Some(e) => Err(format!("rollback incomplete: {e}")),
            None => Ok(()),
        }
    }
}

pub(crate) fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Copy a subtree (or a single mapped file) through the journal.
fn copy_tree(from: &Path, to: &Path, journal: &mut InstallJournal) -> Result<usize, String> {
    if !from.exists() {
        return Err(format!("{} does not exist", from.display()));
    }
    if from.is_file() {
        fs::create_dir_all(to.parent().unwrap_or(to))
            .map_err(|e| format!("create {}: {e}", to.display()))?;
        journal.place(from, to, Place::ResMods)?;
        return Ok(1);
    }
    fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let mut count = 0usize;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        for ent in fs::read_dir(&src)
            .map_err(|e| format!("read {}: {e}", src.display()))?
            .flatten()
        {
            let s = ent.path();
            let d = dst.join(ent.file_name());
            if s.is_dir() {
                fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
                stack.push((s, d));
            } else {
                journal.place(&s, &d, Place::ResMods)?;
                count += 1;
            }
        }
    }
    Ok(count)
}

pub(crate) mod assets;
mod classify;
pub(crate) mod foreign;
mod install;
mod installed_units;
pub(crate) mod manifest;
mod model_preview;
pub(crate) mod preload_mirror;
mod safe_mode;
mod scan_installed;
mod stale_migration;
mod texture_analysis;
mod unit_ops;

#[cfg(test)]
mod tests;

// Foundation helper that moved one directory level down with its callers: the
// original file defined it below `find_pnf_main`, the split keeps it in
// `installed_units` and imports it back for the foundation's own caller.
use self::installed_units::existing_with_bak;

// Sibling command module reached by this module's children through their
// unchanged `super::mod_catalog::...` paths (this facade re-exports the name
// one level down, so every call site kept its original text).
pub(crate) use super::mod_catalog;

// Tauri command surface. `generate_handler!` in `src/lib.rs` resolves both the
// command fn and its doc(hidden) sibling macros (`__cmd__*` /
// `__tauri_command_name_*`) through `commands::mod_hub::*`, exactly like
// `commands/overlay/mod.rs` — so those paths are re-exported verbatim.
pub use assets::{
    __cmd__mod_hub_list_assets, __cmd__mod_hub_read_asset,
    __tauri_command_name_mod_hub_list_assets, __tauri_command_name_mod_hub_read_asset,
    mod_hub_list_assets, mod_hub_read_asset,
};
pub use classify::{
    __cmd__mod_hub_classify_path, __tauri_command_name_mod_hub_classify_path, mod_hub_classify_path,
};
pub use install::{__cmd__mod_hub_install, __tauri_command_name_mod_hub_install, mod_hub_install};
pub use model_preview::{
    __cmd__mod_hub_read_model, __tauri_command_name_mod_hub_read_model, mod_hub_read_model,
};
pub use safe_mode::{
    __cmd__mod_hub_safe_mode, __tauri_command_name_mod_hub_safe_mode, mod_hub_safe_mode,
};
pub use safe_mode::{
    __cmd__mod_hub_set_safe_mode, __tauri_command_name_mod_hub_set_safe_mode, mod_hub_set_safe_mode,
};
pub use scan_installed::{
    __cmd__mod_hub_foreign_units, __tauri_command_name_mod_hub_foreign_units, mod_hub_foreign_units,
};
pub use scan_installed::{
    __cmd__mod_hub_scan_installed, __tauri_command_name_mod_hub_scan_installed,
    mod_hub_scan_installed,
};
pub use stale_migration::{
    __cmd__mod_hub_migrate_stale_bin, __tauri_command_name_mod_hub_migrate_stale_bin,
    mod_hub_migrate_stale_bin,
};
pub use stale_migration::{
    __cmd__mod_hub_migration_execute, __tauri_command_name_mod_hub_migration_execute,
    mod_hub_migration_execute,
};
pub use stale_migration::{
    __cmd__mod_hub_migration_plan, __tauri_command_name_mod_hub_migration_plan,
    mod_hub_migration_plan,
};
pub use stale_migration::{
    __cmd__mod_hub_stale_versions, __tauri_command_name_mod_hub_stale_versions,
    mod_hub_stale_versions,
};
pub use unit_ops::{
    __cmd__mod_hub_set_unit_enabled, __tauri_command_name_mod_hub_set_unit_enabled,
    mod_hub_set_unit_enabled,
};
pub use unit_ops::{
    __cmd__mod_hub_uninstall_unit, __tauri_command_name_mod_hub_uninstall_unit,
    mod_hub_uninstall_unit,
};

// pub(crate) surface consumed through direct `mod_hub::...` paths by
// `mod_catalog` (call sites unchanged).
pub(crate) use classify::classify_package;
pub(crate) use install::{install_plan_with_loose, restore_root};
pub(crate) use stale_migration::conflict_warnings;

// Helpers used only by this module's own test suite (so they stay invisible to
// the non-test build, keeping `cargo clippy --lib -D warnings` quiet).
#[cfg(test)]
pub(crate) use classify::UNSUPPORTED_ARCHIVE;
#[cfg(test)]
pub(crate) use install::{check_plan_rel, install_plan, local_record, test_restore_root_in};
#[cfg(test)]
pub(crate) use installed_units::classify_installed_root;
#[cfg(test)]
pub(crate) use scan_installed::scan_root;
#[cfg(test)]
pub(crate) use stale_migration::{
    migrate_stale_bin_core, migration_execute_core, migration_plan_core, repoint_records,
};
#[cfg(test)]
pub(crate) use texture_analysis::ship_unit_name;
#[cfg(test)]
pub(crate) use unit_ops::{half_disable_violation, set_paths_state, uninstall_unit_core};
