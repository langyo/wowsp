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
//!
//! Trust boundary (audit H-3): a local install's source is anchored to the
//! native folder picker ([`pick_source`]) — classify and install only accept
//! paths a dialog handed out this session — and the picked tree is copied
//! through [`copy_tree`], which refuses link-shaped reparse points via
//! [`ensure_plain_source_entry`]: symlinks and directory junctions (the
//! name-surrogate tags) are rejected, while cloud placeholders (OneDrive &
//! co, the `0x9000_xxxx` tag family) pass and hydrate normally on read. The
//! grant decides WHICH folder may be read; the no-follow walk decides WHAT
//! inside it may be read, so a package cannot use a link to pull files from
//! outside the previewed tree into `res_mods` (nor loop the copy through a
//! junction cycle).

use anyhow::anyhow;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use wowsp_tauri_shared::{
    InstallReport, InstalledMod, MigrateReport, MigrationPlan, ModInstallRecord, ModKind,
    PackagePlan, PackagePlanEntry, PlanFile, PnfLoaderStatus, StaleBinInfo, TextureAnalysis,
    UnitToggleReport,
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
pub(crate) fn latest_bin_version(game_root: &str) -> Option<(String, PathBuf)> {
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
pub(crate) fn find_pnf_main(dir: &Path) -> Option<PathBuf> {
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
///
/// The root itself must also be one the BACKEND knows (audit H-3): the
/// webview used to be able to name any `game_root`, making its word the
/// write boundary for installs, uninstalls and safe-mode renames. The
/// accepted set mirrors exactly what the webui's own install selector can
/// show: a detected install (registry / Steam / Lesta / env pin), the
/// persisted active install, or a running client's folder.
pub(crate) fn ensure_game_closed(game_root: &str) -> anyhow::Result<()> {
    ensure_known_game_root(game_root)?;
    if let Some((pid, root)) = super::game_context::running_root_matching(game_root) {
        return Err(anyhow!(
            "World of Warships is running from {root} (pid {pid}) — close that client before installing, uninstalling or toggling mods"
        ));
    }
    Ok(())
}

/// Is `game_root` an install the backend itself knows about? Delegates the
/// spelling-insensitive comparison to the game context's shared identity
/// check.
fn known_game_root(game_root: &str) -> bool {
    // Test seam first: command-level tests drive real temp roots the
    // scanner can never see (the same pattern as `TEST_RESTORE_ROOT`).
    #[cfg(test)]
    if test_known_roots()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .any(|known| super::game_context::same_folder(known, game_root))
    {
        return true;
    }
    // 1. Detected installs (env pin, registry, Lesta Game Center, Steam).
    //    The TTL-cached scan shares the session poller's cache — a mutating
    //    command must not pay a fresh registry walk.
    if super::game_context::cached_scan()
        .iter()
        .any(|install| super::game_context::same_folder(&install.path, game_root))
    {
        return true;
    }
    // 2. The persisted active install — the webui's `config.activeInstall`,
    //    which is where the mod hub's install selector comes from. The
    //    getter filters on `is_game_dir`, so this slot can only ever name a
    //    directory that actually looks like an install.
    if let Some(active) = super::game_context::persisted_active_path() {
        if super::game_context::same_folder(&active, game_root) {
            return true;
        }
    }
    // 3. A running client's matched folder (its own guard below rejects it
    //    for mutation, but the read-side commands only pass the root check).
    super::game_context::running_root_matching(game_root).is_some()
}

/// Command-level tests register their synthetic roots here so the known
/// root guard accepts them deterministically — never dependent on the
/// 5-second scan cache's timing.
#[cfg(test)]
pub(crate) fn test_allow_game_root(root: &str) {
    test_known_roots()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(root.to_string());
}

#[cfg(test)]
fn test_known_roots() -> &'static std::sync::Mutex<Vec<String>> {
    static ROOTS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Reject `game_root` values the backend cannot vouch for. Split from
/// [`ensure_game_closed`] so future read-side callers can take the root
/// check without the closed check.
pub(crate) fn ensure_known_game_root(game_root: &str) -> anyhow::Result<()> {
    if known_game_root(game_root) {
        return Ok(());
    }
    Err(anyhow!(
        "unknown game install root: {game_root} — pick an install the app detected or set as the active install"
    ))
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
pub(crate) fn set_safe_mode_core(game_root: &str, enabled: bool) -> anyhow::Result<bool> {
    let (_, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {game_root}/bin"))?;
    let live = ver_dir.join("res_mods");
    let off = disabled_res_mods(&ver_dir);
    if enabled {
        if off.is_dir() {
            return Err(anyhow!("safe mode is already active"));
        }
        if !live.is_dir() {
            return Err(anyhow!(
                "res_mods not found — there is nothing to quarantine"
            ));
        }
        fs::rename(&live, &off).map_err(|e| {
            anyhow!(
                "quarantine {}: {e} (is the game or antivirus holding files?)",
                off.display()
            )
        })?;
    } else {
        if live.exists() && off.exists() {
            return Err(anyhow!(
                "both {} and its quarantined copy exist — move the newer one aside manually",
                live.display()
            ));
        }
        if off.is_dir() {
            fs::rename(&off, &live).map_err(|e| anyhow!("restore {}: {e}", live.display()))?;
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
            fs::rename(&twin, &live).map_err(|e| anyhow!("restore {}: {e}", live.display()))?;
        }
    }
    Ok(disabled_res_mods(&ver_dir).is_dir())
}

/// Mutating commands refuse while `res_mods` is quarantined: writes would
/// land in a fresh `res_mods` and drift apart from the quarantined tree,
/// and leaving safe mode would then fail on the rename.
pub(crate) fn ensure_res_mods_active(game_root: &str) -> anyhow::Result<()> {
    if safe_mode_active(game_root) {
        return Err(anyhow!(
            "safe mode is active — turn mods back on before installing, uninstalling or toggling them"
        ));
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
    fn place(&mut self, src: &Path, dest: &Path, place: Place) -> anyhow::Result<()> {
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
            return Err(anyhow!("copy {}: {e}", src.display()));
        }
        if let Err(e) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(anyhow!("place {}: {e}", dest.display()));
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
    fn place_empty(&mut self, dest: &Path, place: Place) -> anyhow::Result<()> {
        if dest.is_file() || !self.placed.insert(dest.to_path_buf()) {
            return Ok(());
        }
        let tmp = sibling_with_suffix(dest, PART_SUFFIX);
        fs::File::create(&tmp).map_err(|e| anyhow!("create {}: {e}", tmp.display()))?;
        if let Err(e) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(anyhow!("place {}: {e}", dest.display()));
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
    fn snapshot(&self, dest: &Path, place: Place) -> anyhow::Result<PathBuf> {
        let (root, prefix) = self.place_roots(place);
        let rel = dest
            .strip_prefix(&root)
            .map_err(|_| anyhow!("{} is outside the game tree", dest.display()))?;
        let rel = match prefix {
            Some(p) => Path::new(p).join(rel),
            None => rel.to_path_buf(),
        };
        let snap = self.restore_dir.join(&rel);
        if !snap.is_file() {
            if let Some(parent) = snap.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
            }
            fs::copy(dest, &snap).map_err(|e| {
                anyhow!(
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
    fn rollback(mut self) -> anyhow::Result<()> {
        let mut parents: Vec<PathBuf> = self
            .actions
            .iter()
            .filter_map(|a| a.dest.parent().map(|p| p.to_path_buf()))
            .collect();
        parents.sort();
        parents.dedup();
        let mut first_err: Option<anyhow::Error> = None;
        for action in std::mem::take(&mut self.actions).into_iter().rev() {
            let outcome = match &action.snapshot {
                Some(snap) if snap.is_file() => {
                    if let Some(parent) = action.dest.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    fs::copy(snap, &action.dest)
                        .map(|_| ())
                        .map_err(|e| anyhow!("restore {}: {e}", action.dest.display()))
                },
                _ => match fs::remove_file(&action.dest) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(anyhow!("remove {}: {e}", action.dest.display())),
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
            Some(e) => Err(anyhow!("rollback incomplete: {e}")),
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

/// `FILE_ATTRIBUTE_REPARSE_POINT` — set on every entry whose metadata carries
/// a reparse tag (symlinks, junctions, cloud placeholders, …).
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// `IO_REPARSE_TAG_SYMLINK` — the tag behind file and directory symlinks.
#[cfg_attr(not(windows), allow(dead_code))] // production caller is Windows-only
pub(crate) const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;

/// `IO_REPARSE_TAG_MOUNT_POINT` — directory junctions and volume mount points.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

/// Does a reparse tag block the source-tree copy?
///
/// Only LINK-shaped tags redirect the walk to a target the user never picked:
/// [`IO_REPARSE_TAG_SYMLINK`] and [`IO_REPARSE_TAG_MOUNT_POINT`] (junctions and
/// volume mount points). Every other tag is data the OS resolves in place on
/// read — most importantly the OneDrive/cloud-placeholder family
/// (`0x9000_xxxx`): a package folder that lives in a synced tree is ordinary
/// files to the user, and the copy hydrates them on demand. Refusing the whole
/// reparse bit instead (the previous rule) made legitimate cloud-backed mod
/// folders uninstallable.
///
/// A pure tag classifier on purpose: the Windows query below supplies the tag,
/// and the decision itself is unit-tested without a filesystem.
#[cfg_attr(not(windows), allow(dead_code))] // production caller is Windows-only
pub(crate) fn reparse_tag_blocks_copy(tag: u32) -> bool {
    matches!(tag, IO_REPARSE_TAG_SYMLINK | IO_REPARSE_TAG_MOUNT_POINT)
}

#[cfg(windows)]
/// `FSCTL_GET_REPARSE_POINT` — `CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 42,
/// METHOD_BUFFERED, FILE_ANY_ACCESS)`. Spelled out here because the binding
/// lives behind the `Win32_System_Ioctl` metadata feature while this walk needs
/// exactly one IOCTL; the value is the one the Windows SDK defines.
const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;

#[cfg(windows)]
/// `HRESULT_FROM_WIN32(ERROR_NOT_A_REPARSE_POINT)` (error 4390 = 0x1126).
const HRESULT_NOT_A_REPARSE_POINT: u32 = 0x8007_1126;

#[cfg(windows)]
/// What the no-follow reparse query found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReparseVerdict {
    /// Not a reparse point (the attribute bit raced or aged away).
    Plain,
    /// The entry reparse tag.
    Tag(u32),
}

#[cfg(windows)]
/// Query one entry reparse tag WITHOUT following it: open a metadata handle
/// with `FILE_FLAG_OPEN_REPARSE_POINT` (plus `FILE_FLAG_BACKUP_SEMANTICS` so
/// directories open too) and ask `FSCTL_GET_REPARSE_POINT`; the returned
/// `REPARSE_DATA_BUFFER` starts with the tag as a little-endian u32.
///
/// Failure policy: `ERROR_NOT_A_REPARSE_POINT` means the entry stopped being a
/// reparse point between the attribute read and this query — a plain entry, not
/// an error. Any other failure leaves the entry link shape unknown, so the
/// caller must refuse it (fail closed) and the error says why.
fn reparse_points_at_copy(path: &Path) -> anyhow::Result<ReparseVerdict> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::IO::DeviceIoControl;
    use windows::core::HSTRING;

    let wide = HSTRING::from(path.as_os_str());
    // FILE_READ_ATTRIBUTES is the documented minimum for a reparse query and
    // does not hydrate a cloud file; no write access is ever requested.
    let handle: HANDLE = unsafe {
        CreateFileW(
            &wide,
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .map_err(|e| {
        anyhow!(
            "open source entry {} for a reparse query: {e}",
            path.display()
        )
    })?;
    // MAXIMUM_REPARSE_DATA_BUFFER_SIZE: a symlink/junction payload always fits,
    // so a successful IOCTL leaves the tag in the first four bytes.
    let mut buffer = vec![0u8; 16 * 1024];
    let mut returned = 0u32;
    let outcome = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_GET_REPARSE_POINT,
            None,
            0,
            Some(buffer.as_mut_ptr().cast()),
            buffer.len() as u32,
            Some(&mut returned),
            None,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    match outcome {
        Ok(()) if returned >= 4 => Ok(ReparseVerdict::Tag(u32::from_le_bytes([
            buffer[0], buffer[1], buffer[2], buffer[3],
        ]))),
        Ok(()) => Err(anyhow!(
            "reparse query on {} returned {returned} bytes (need the 4-byte tag)",
            path.display()
        )),
        Err(e) if e.code().0 as u32 == HRESULT_NOT_A_REPARSE_POINT => Ok(ReparseVerdict::Plain),
        Err(e) => Err(anyhow!(
            "query reparse tag of {}: {e} (refusing an entry whose link shape is unknown)",
            path.display()
        )),
    }
}

/// Trust boundary for every source-tree walk (classify and install): inspect
/// `path` WITHOUT following links and refuse entries that could redirect the
/// walk. Cross-platform that means a symlink; on Windows it means any
/// name-surrogate reparse point (symlink, directory junction, mount point) plus
/// anything whose reparse tag cannot be resolved (fail closed).
///
/// Cloud placeholders (OneDrive and friends, the `0x9000_xxxx` tag family) are
/// NOT links: the file contents hydrate from the cloud on read, which is
/// exactly what copying a picked package expects. They pass.
///
/// Check-then-copy is not atomic: this guards hostile package CONTENT, not a
/// local process racing the install (which already holds the same-user write
/// access the install itself has).
pub(crate) fn ensure_plain_source_entry(path: &Path) -> anyhow::Result<()> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| anyhow!("inspect source entry {}: {e}", path.display()))?;
    // `is_symlink` on Windows is the name-surrogate test (symlink AND
    // junction), so links are refused before any tag query is needed.
    if meta.file_type().is_symlink() {
        return Err(anyhow!(
            "refusing source entry {}: it is a link (symlink/junction) — link-shaped reparse points are never installed",
            path.display()
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            match reparse_points_at_copy(path)? {
                ReparseVerdict::Plain => {},
                ReparseVerdict::Tag(tag) if reparse_tag_blocks_copy(tag) => {
                    return Err(anyhow!(
                        "refusing source entry {}: link reparse tag {tag:#010X} is never installed",
                        path.display()
                    ));
                },
                // Cloud placeholder and co: ordinary data, hydrated on read.
                ReparseVerdict::Tag(_) => {},
            }
        }
    }
    Ok(())
}

/// Copy a subtree (or a single mapped file) through the journal. Every source
/// entry is inspected without following links ([`ensure_plain_source_entry`]):
/// a link-shaped reparse point (symlink/junction) anywhere under the picked
/// folder aborts the copy with the entry named, before its target bytes can be
/// read; cloud placeholders pass and hydrate while they are copied.
fn copy_tree(from: &Path, to: &Path, journal: &mut InstallJournal) -> anyhow::Result<usize> {
    if !from.exists() {
        return Err(anyhow!("{} does not exist", from.display()));
    }
    ensure_plain_source_entry(from)?;
    if from.is_file() {
        fs::create_dir_all(to.parent().unwrap_or(to))
            .map_err(|e| anyhow!("create {}: {e}", to.display()))?;
        journal.place(from, to, Place::ResMods)?;
        return Ok(1);
    }
    fs::create_dir_all(to).map_err(|e| anyhow!("create {}: {e}", to.display()))?;
    let mut count = 0usize;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        for ent in fs::read_dir(&src)
            .map_err(|e| anyhow!("read {}: {e}", src.display()))?
            .flatten()
        {
            let s = ent.path();
            ensure_plain_source_entry(&s)?;
            let d = dst.join(ent.file_name());
            if s.is_dir() {
                fs::create_dir_all(&d).map_err(|e| anyhow!("create {}: {e}", d.display()))?;
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
pub(crate) mod pick_source;
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
pub use pick_source::{
    __cmd__mod_hub_pick_source, __tauri_command_name_mod_hub_pick_source, mod_hub_pick_source,
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
    __cmd__mod_hub_pnf_loader_status, __tauri_command_name_mod_hub_pnf_loader_status,
    mod_hub_pnf_loader_status,
};
pub use scan_installed::{
    __cmd__mod_hub_restore_pnf_loader_marker,
    __tauri_command_name_mod_hub_restore_pnf_loader_marker, mod_hub_restore_pnf_loader_marker,
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
    __cmd__mod_hub_uninstall_modstation_unit,
    __tauri_command_name_mod_hub_uninstall_modstation_unit, mod_hub_uninstall_modstation_unit,
};
pub use unit_ops::{
    __cmd__mod_hub_uninstall_unit, __tauri_command_name_mod_hub_uninstall_unit,
    mod_hub_uninstall_unit,
};

// pub(crate) surface consumed through direct `mod_hub::...` paths by
// `mod_catalog` (call sites unchanged).
pub(crate) use classify::{classify_package, collect_plan_files};
pub(crate) use install::{install_plan_with_loose, restore_root, validate_plan};
pub(crate) use stale_migration::conflict_warnings;
pub(crate) use unit_ops::remove_manifest_entries_for_entry;

// Helpers used only by this module's own test suite (so they stay invisible to
// the non-test build, keeping `cargo clippy --lib -D warnings` quiet).
#[cfg(test)]
pub(crate) use classify::{UNSUPPORTED_ARCHIVE, classify_path};
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
