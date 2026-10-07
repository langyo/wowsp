//! Unified game-install context — the single backend entry point for "which
//! World of Warships folder is WoWSP working with right now".
//!
//! Historically every feature derived its own root: the arena watcher and the
//! replay defaults each fell back to the FIRST auto-detected install
//! (`scan_game_installs().next()` — plain registry enumeration order), the
//! webui passed its own selection explicitly, and the folder of the client
//! that was actually RUNNING was never consulted. On machines with several
//! installs (WGC + Steam + CN clients) live monitoring then watched the wrong
//! `replays/` folder forever — the resolved dir was cached for the whole
//! process lifetime and the notify watcher never re-resolved.
//!
//! This module owns the priority chain instead. Two orders exist, one per
//! operation class:
//!
//! * [`RootPreference::PreferRunning`] — live monitoring (arena roster,
//!   battle state): the running client's folder is the only one that receives
//!   `tempArenaInfo.json`, so the process list wins, then the persisted
//!   active install, then the first detected install.
//! * [`RootPreference::PreferActive`] — everything user-scoped (replay
//!   listing defaults, pairing imports): the persisted active install wins,
//!   then the running client, then the first detected install.
//!
//! When several clients run at once, the one matching the persisted active
//! path is preferred; otherwise the first found. The env pins
//! (`WOWSP_GAME_PATH` / `WOWSP_REPLAY_DIR`) stay above both chains where the
//! old resolvers already honored them (developer / test seams).
//!
//! Sub-path derivation lives here too, so "replays folder", "current
//! `bin/<build>` dir" and "res_mods target" have exactly one implementation:
//! replay monitoring, GameParams unpacking, map inventory and every mod
//! installer all consume these helpers instead of re-deriving their own.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use wowsp_tauri_shared::{GameInstall, GameInstallKind};

// The process-image test moved into the per-client compat registry
// (commands/game_client.rs) — keep the plain-name call sites below (and this
// module's process-name tests) working unchanged. Windows-only outside the
// tests (the snapshot is Windows-only); the tests match names on every
// target.
#[cfg(any(target_os = "windows", test))]
use super::game_client::is_game_process_name;

/// Which root wins when several installs exist on the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootPreference {
    /// The client that is RUNNING right now (live battle data is written by
    /// that process) — falls back to the persisted active install, then the
    /// first detected install.
    PreferRunning,
    /// The install the user selected (persisted active path) — falls back to
    /// the running client, then the first detected install.
    PreferActive,
}

/// Where a resolved root came from (diagnostics + tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootSource {
    /// A running `WorldOfWarships*.exe` process's own folder.
    RunningProcess,
    /// The persisted `game-config.toml` active path.
    ActiveConfig,
    /// The first install of the auto-detection scan.
    DetectedScan,
}

/// A validated game root plus its provenance.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedRoot {
    pub root: PathBuf,
    pub source: RootSource,
}

impl ResolvedRoot {
    fn running(root: &str) -> Self {
        Self {
            root: PathBuf::from(root),
            source: RootSource::RunningProcess,
        }
    }

    fn active(root: &str) -> Self {
        Self {
            root: PathBuf::from(root),
            source: RootSource::ActiveConfig,
        }
    }
}

/// Resolve the game root per `preference`. Every tier is validated
/// (`WorldOfWarships.exe` must exist) before it is used.
pub(crate) fn resolve_root(preference: RootPreference) -> Option<ResolvedRoot> {
    let running = running_roots();
    let active = persisted_active_path();
    let resolved = resolve_head(&running, active.as_deref(), preference).or_else(|| {
        // Last tier: the auto-detected install list. Cached — the scan walks
        // the registry and every Steam library, while the resolution itself
        // runs on the 3 s roster poll.
        cached_scan().first().map(|install| ResolvedRoot {
            root: PathBuf::from(&install.path),
            source: RootSource::DetectedScan,
        })
    });
    if let Some(r) = &resolved {
        // Trace-level (off by default): multi-install routing questions are
        // exactly what this provenance answers.
        tracing::trace!(
            source = ?r.source,
            root = %r.root.display(),
            "game root resolved"
        );
    }
    resolved
}

/// The running/active tiers of [`resolve_root`] as a pure core, so the
/// priority order is unit-testable without real processes or a config file.
fn resolve_head(
    running: &[(u32, String)],
    active: Option<&str>,
    preference: RootPreference,
) -> Option<ResolvedRoot> {
    // Several clients running at once: prefer the one the user persisted as
    // active (same folder, any spelling) so capture, roster and stats all
    // follow the SAME client; otherwise the first found.
    let pick_running = || {
        active
            .and_then(|a| running.iter().find(|(_, root)| same_folder(root, a)))
            .or_else(|| running.first())
    };
    match preference {
        RootPreference::PreferRunning => pick_running()
            .map(|(_, root)| ResolvedRoot::running(root))
            .or_else(|| active.map(ResolvedRoot::active)),
        RootPreference::PreferActive => active
            .map(ResolvedRoot::active)
            .or_else(|| pick_running().map(|(_, root)| ResolvedRoot::running(root))),
    }
}

/// The PID the overlay capture / process report should use: the process
/// backing [`resolve_root`] with [`RootPreference::PreferRunning`]. Every
/// `find_game_pid` consumer follows the same client the arena watcher reads
/// — with two clients running, chips and roster can no longer come from
/// different installs. `None` when no validated client process exists (with
/// `PreferRunning`, a non-process root implies the process list was empty).
pub(crate) fn preferred_game_pid() -> Option<u32> {
    let running = running_roots();
    let active = persisted_active_path();
    let resolved = resolve_head(&running, active.as_deref(), RootPreference::PreferRunning)?;
    // The running root was built verbatim from one of `running`'s strings,
    // so exact Path equality finds its producing entry.
    running
        .iter()
        .find(|(_, root)| resolved.root == Path::new(root))
        .map(|(pid, _)| *pid)
}

/// The running process whose install folder IS `root` (same-folder compare),
/// when any. The mod-mutation guard uses this so a DIFFERENT client's
/// process does not block res_mods work on this tree.
pub(crate) fn running_root_matching(root: &str) -> Option<(u32, String)> {
    running_roots()
        .into_iter()
        .find(|(_, running_root)| same_folder(running_root, root))
}

/// All running game-client processes whose implied folder validates as a
/// game install: `(pid, game_root)`. A process whose image path cannot be
/// queried, or whose root lacks a stub exe
/// (`game_detect::is_game_dir`), is invisible here BY DESIGN — everything
/// downstream (capture, roster, guards) keys on validated folders, so an
/// exotic/partial tree is treated as "not running" rather than routing work
/// to a bogus root. The exe-path query is Windows-only, so non-Windows
/// targets (the mobile build) always see an empty list here.
fn running_roots() -> Vec<(u32, String)> {
    #[cfg(target_os = "windows")]
    {
        snapshot_game_pids()
            .into_iter()
            .filter_map(|pid| {
                let exe = super::appdata::query_process_image_path(pid)?;
                let root = exe_game_root(&exe)?;
                super::game_detect::is_game_dir(&root).then_some((pid, root))
            })
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// The game root implied by a process image path: the segment above `\bin\`
/// (the 64-bit client lives in `bin/<build>/bin64/`), falling back to the
/// exe's own directory for the root-level launcher stub. No validation —
/// callers decide what counts as usable.
pub(crate) fn exe_game_root(exe: &str) -> Option<String> {
    let norm = exe.replace('/', "\\");
    let root = match norm.rfind("\\bin\\") {
        Some(i) => norm[..i].to_string(),
        None => {
            let i = norm.rfind('\\')?;
            norm[..i].to_string()
        },
    };
    (!root.is_empty()).then_some(root)
}

/// Case-, separator- and trailing-slash-insensitive folder identity for two
/// path spellings (same normalization as the install scan's dedupe key).
pub(crate) fn same_folder(a: &str, b: &str) -> bool {
    super::game_detect::install_path_key(a) == super::game_detect::install_path_key(b)
}

/// The persisted active-install path (`game-config.toml`), sanitized; `None`
/// when unset or unreadable. Read-only view over the same load the
/// `get_game_config` command performs.
fn persisted_active_path() -> Option<String> {
    let dir = crate::paths::data_dir().ok()?;
    super::game_config::persisted_active_path(&dir)
        .filter(|path| super::game_detect::is_game_dir(path))
}

/// Scan cache TTL: long enough to keep the 3 s roster poll from re-walking
/// the registry + Steam libraries, short enough that a just-installed or
/// just-removed client does not stick in the fallback chain.
const SCAN_TTL: Duration = Duration::from_secs(5);

static SCAN_CACHE: Mutex<Option<(Instant, Vec<GameInstall>)>> = Mutex::new(None);

/// [`super::game_detect::scan_game_installs`] with a short TTL. The
/// `detect_game_install` command keeps the uncached scan (the settings UI
/// re-detect button must see fresh state); the session poller shares this
/// cache so the two 3 s cadences cost one registry walk per TTL window.
pub(crate) fn cached_scan() -> Vec<GameInstall> {
    let mut guard = SCAN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, installs)) = guard.as_ref() {
        if at.elapsed() < SCAN_TTL {
            return installs.clone();
        }
    }
    let installs = super::game_detect::scan_game_installs();
    *guard = Some((Instant::now(), installs.clone()));
    installs
}

// ── sub-path derivation ─────────────────────────────────────────────────────

/// Numeric `bin/<build>` dirs of an install, ascending by build number.
fn numeric_bin_dirs(root: &Path) -> Vec<(u64, PathBuf)> {
    let mut dirs: Vec<(u64, PathBuf)> = std::fs::read_dir(root.join("bin"))
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| {
                    let build = e.file_name().to_string_lossy().parse::<u64>().ok()?;
                    Some((build, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    dirs.sort_unstable_by_key(|(build, _)| *build);
    dirs
}

/// Cached pin read — see [`preferences_active_build`].
static PIN_CACHE: Mutex<Option<PinCacheEntry>> = Mutex::new(None);

#[derive(Clone)]
struct PinCacheEntry {
    root_key: String,
    len: u64,
    mtime: std::time::SystemTime,
    build: Option<u64>,
}

/// The build the client itself records as live: `preferences.xml`'s
/// `<last_server_version>` carries the running build as its trailing
/// component (`15,8,0,13187581` → `13187581`). Wargaming pre-releases the
/// NEXT version's complete `bin/<build>/` on Steam days before the client
/// switches to it, so the newest dir on disk is regularly NOT the build
/// the game loads — while this marker only moves when the client actually
/// connects from that build. Known limitation: right after the live
/// switch but before the client's first launch the pin still names the
/// previous build, so installs land there once and the stale-bin banner
/// recovers them after the first launch flips the pin.
///
/// The file is re-read only when its stat changes — the bridge loop and
/// telemetry poller hit this every 1–2 s, and the client rewrites the
/// file exactly when the pin can move. `None` when the file is missing,
/// unreadable mid-rewrite (never cached — retried on the next call) or
/// carries no parseable tag.
fn preferences_active_build(root: &Path) -> Option<u64> {
    let path = root.join("preferences.xml");
    let meta = std::fs::metadata(&path).ok()?;
    let mtime = meta.modified().ok()?;
    let root_key = super::game_detect::install_path_key(&root.to_string_lossy());
    {
        let guard = PIN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.as_ref() {
            if entry.root_key == root_key && entry.len == meta.len() && entry.mtime == mtime {
                return entry.build;
            }
        }
    }
    let Ok(content) = std::fs::read_to_string(&path) else {
        return None;
    };
    let build = parse_last_server_build(&content);
    let mut guard = PIN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(PinCacheEntry {
        root_key,
        len: meta.len(),
        mtime,
        build,
    });
    build
}

/// The pin out of preferences.xml content. Tag matching is
/// ASCII-case-insensitive and attribute-tolerant, matching the other
/// hand-rolled XML probes in this crate (`game_detect`); anything
/// unexpected misses so the caller falls back to disk shape.
fn parse_last_server_build(content: &str) -> Option<u64> {
    // ASCII lowercasing preserves byte offsets, so indices found in the
    // lowered copy address the original safely.
    let lower = content.to_ascii_lowercase();
    let open = lower.find("<last_server_version")?;
    let value_at = open + lower[open..].find('>')? + 1;
    let close = lower[value_at..].find("</last_server_version")? + value_at;
    content[value_at..close]
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim()
        .parse::<u64>()
        .ok()
}

/// The preferences-pinned build among `dirs`, when the client records one
/// that actually exists on disk (a stale pin from an un-launched update
/// changes nothing).
fn pinned_build_dir(dirs: &[(u64, PathBuf)], root: &Path) -> Option<(u64, PathBuf)> {
    let pinned = preferences_active_build(root)?;
    dirs.iter().find(|(build, _)| *build == pinned).cloned()
}

/// The newest `bin/<build>/` that ships an `idx/` directory — the build the
/// client actually runs from, with the `preferences.xml` pin taking
/// precedence (Steam pre-release bins sit numerically above the live
/// build; see [`preferences_active_build`]). A pin without `idx/` is
/// skipped rather than trusted — the VFS readers cannot use it. Steam
/// installs keep several partially downloaded builds around and only some
/// carry the index files the VFS needs (same rule as
/// `scripts/extract/_common.py`). Consumers: GameParams unpack, map
/// inventory.
pub(crate) fn latest_bin_dir_with_idx(root: &Path) -> Option<(u32, PathBuf)> {
    let dirs = numeric_bin_dirs(root);
    if let Some((build, dir)) = pinned_build_dir(&dirs, root) {
        if let Ok(build) = u32::try_from(build) {
            if dir.join("idx").is_dir() {
                return Some((build, dir));
            }
        }
    }
    dirs.iter()
        .rev()
        // Skip u32-unrepresentable (contrived) build names instead of
        // swallowing the whole result — the next-highest idx build is still
        // the right answer for the VFS readers.
        .find_map(|(build, dir)| {
            let b = u32::try_from(*build).ok()?;
            dir.join("idx").is_dir().then_some((b, dir.clone()))
        })
}

/// The `bin/<build>` dir mods must target: the build the client itself
/// records as live (`preferences.xml` pin — a mod dropped into a pre-
/// released build the client never loads is invisible), else the newest
/// idx-carrying build, falling back to the plain newest numeric dir —
/// res_mods writes must still land somewhere on trees whose builds all
/// lack `idx/` (dev fixtures, partial unpacks). Consumers: overlay mod
/// installer, mod hub, catalog.
pub(crate) fn latest_bin_dir(root: &Path) -> Option<(u64, PathBuf)> {
    let dirs = numeric_bin_dirs(root);
    if let Some(pinned) = pinned_build_dir(&dirs, root) {
        return Some(pinned);
    }
    dirs.iter()
        .rev()
        .find(|(_, dir)| dir.join("idx").is_dir())
        .cloned()
        .or_else(|| dirs.last().cloned())
}

/// The NEXT version's complete `bin/<build>/` dirs Steam pre-released
/// above the pinned live build: numerically above the pin and carrying
/// `idx/` (a staged dir without index files is a partial download, not a
/// switch candidate). Consumers: the pre-release mirror fan-out
/// (`mod_hub/preload_mirror.rs`), which copies every mod mutation into
/// these twins so the version switch finds the mods already in place.
/// Empty without a pin — "future" is undefined when the client has never
/// run and there is no live build to be above.
pub(crate) fn preload_bin_dirs(root: &Path) -> Vec<(u64, PathBuf)> {
    let Some(pinned) = preferences_active_build(root) else {
        return Vec::new();
    };
    numeric_bin_dirs(root)
        .into_iter()
        .filter(|(build, _)| *build > pinned)
        .filter(|(_, dir)| dir.join("idx").is_dir())
        .collect()
}

/// The res_mods target under the newest usable build of an install.
pub(crate) fn res_mods_dir(root: &Path) -> Result<PathBuf, String> {
    let (_, ver_dir) = latest_bin_dir(root)
        .ok_or_else(|| format!("no numeric bin/<version> under {}\\bin", root.display()))?;
    Ok(ver_dir.join("res_mods"))
}

/// The replays folder of an install root — where `tempArenaInfo.json` and
/// finished `.wowsreplay` files live.
pub(crate) fn replays_dir(root: &Path) -> PathBuf {
    root.join("replays")
}

// ── replay roots (every client's replays folder) ────────────────────────────

/// Dedupe identity for scan roots — the same normalization the install scan
/// uses (`game_detect::install_path_key`): case-, separator- and
/// trailing-slash-insensitive, so the registry's, the Steam vdf's and the
/// env pin's spellings of one folder collapse. Purely string-based (no
/// canonicalize I/O), so it never fails. A root reachable only through a
/// differently-spelled symlink or junction stays distinct here — the
/// pathological outcome is the same physical folder being walked (and its
/// replays counted) twice, an accepted edge for the zero-I/O identity.
fn replay_root_key(path: &Path) -> String {
    super::game_detect::install_path_key(&path.to_string_lossy())
}

/// True when two replay roots are the same folder or nested inside one
/// another (the resolved default dir can BE an install's `replays/` or live
/// under its root in a different spelling).
pub(crate) fn replay_roots_overlap(a: &Path, b: &Path) -> bool {
    let (a, b) = (replay_root_key(a), replay_root_key(b));
    a == b || a.starts_with(&format!("{b}\\")) || b.starts_with(&format!("{a}\\"))
}

/// Every replay root the app scans as a whole: each detected install's
/// `replays/` folder (owner = that install), plus the resolved default
/// replay dir when it is not already covered by an install root. That extra
/// root belongs to a KNOWN-but-UNSCANNED install — a manual/portable game
/// folder the webui lets the user pin, or (only when no usable persisted
/// pick exists, since the extra root resolves the ACTIVE install first) a
/// raw running client — and is tagged as such, so its rows carry the
/// identity the client menus and filters key on instead of falling into the
/// anonymous bucket. Ownerless roots stay ownerless: the mobile managed dir
/// always, and an env pin (`WOWSP_REPLAY_DIR`) unless it happens to be a
/// candidate install's own `replays/` folder. On mobile the install scan
/// finds nothing (no registry / Steam libraries to walk; at most an
/// env-pinned path), so the managed dir is the only root.
///
/// One implementation for both multi-client consumers — the playtime battle
/// ledger (`playtime_battles`) and the replay rail's all-clients scan
/// (`list_replays_meta { all: true }`) — so "which folders count as a
/// client's replays" can never drift between them.
pub(crate) fn replay_roots() -> Vec<(PathBuf, Option<GameInstall>)> {
    let mut roots: Vec<(PathBuf, Option<GameInstall>)> = Vec::new();
    for install in cached_scan() {
        let dir = replays_dir(Path::new(&install.path));
        // Two installs resolving to overlapping folders (nested roots from
        // overlapping detection sources) must not double-count replays.
        if roots.iter().any(|(r, _)| replay_roots_overlap(r, &dir)) {
            continue;
        }
        roots.push((dir, Some(install)));
    }
    if let Ok(extra) = super::replay::resolve_replay_dir(None) {
        if !roots.iter().any(|(r, _)| replay_roots_overlap(r, &extra)) {
            let owner = unscanned_install_owning(&extra);
            roots.push((extra, owner));
        }
    }
    roots
}

/// The install a default-resolved replay root belongs to when that install
/// is NOT in the auto-detection scan: the persisted active pick or a running
/// client whose own `replays/` folder is this root. Such an install reaches
/// the app only through the user's manual pin (or a raw process). The
/// candidate gathering is the shell; the decision is [`owner_among`], a pure
/// core so it is unit-testable without real processes or a config file.
fn unscanned_install_owning(replays: &Path) -> Option<GameInstall> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(active) = persisted_active_path() {
        candidates.push(active);
    }
    candidates.extend(running_roots().into_iter().map(|(_, root)| root));
    owner_among(&candidates, replays, &cached_scan())
}

/// Pure core of [`unscanned_install_owning`]: the first candidate root whose
/// `replays/` folder IS `replays` (same or nested spelling, path identity as
/// everywhere else), reported as [`GameInstallKind::Manual`]. The realm is
/// read off the install's own `clientrunner.log` when it carries one
/// (`game_detect::detect_realm`), so the tag this scan stamps matches the
/// label the config store shows for the same manual pick instead of reading
/// as a bare kind on one surface and "Manual · RU" on the other. `None` when
/// no candidate claims the folder (the phone's managed dir, `WOWSP_REPLAY_DIR`
/// pins) or when every claiming candidate is already in `scanned` (then
/// `replay_roots`' install loop covered the root, and tagging here would
/// double it).
fn owner_among(
    candidates: &[String],
    replays: &Path,
    scanned: &[GameInstall],
) -> Option<GameInstall> {
    candidates.iter().find_map(|root| {
        if !replay_roots_overlap(&replays_dir(Path::new(root)), replays) {
            return None;
        }
        let scanned_already = scanned.iter().any(|install| {
            super::game_detect::install_path_key(&install.path)
                == super::game_detect::install_path_key(root)
        });
        (!scanned_already).then(|| GameInstall {
            kind: GameInstallKind::Manual,
            realm: super::game_detect::detect_realm(Path::new(root)),
            path: root.clone(),
        })
    })
}

// ── process enumeration ─────────────────────────────────────────────────────

/// PIDs of every running game client — the Wargaming/Steam builds run
/// `WorldOfWarships(.64).exe`, the Lesta (Мир кораблей) build runs
/// `Korabli(.64).exe` (see [`super::game_client`]).
#[cfg(target_os = "windows")]
fn snapshot_game_pids() -> Vec<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    let mut pids = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return pids;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_err() {
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
            return pids;
        }
        loop {
            let name = String::from_utf16_lossy(&entry.szExeFile[..])
                .trim_end_matches('\0')
                .to_lowercase();
            if is_game_process_name(&name) {
                pids.push(entry.th32ProcessID);
            }
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    pids
}

#[cfg(not(target_os = "windows"))]
fn snapshot_game_pids() -> Vec<u32> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replay-root identity is spelled the way the install scan spells
    /// folders: same folder, different casing / separators / trailing slash
    /// collapse, and nesting counts in BOTH directions (an install root vs
    /// its own `replays/`, whichever order the roots arrive in) — that is
    /// what keeps one folder from being walked twice. Sibling folders that
    /// merely share a prefix stay distinct.
    #[test]
    fn replay_roots_overlap_is_symmetric_across_spellings_and_nesting() {
        let replays = Path::new(r"C:\Games\World of Warships\replays");
        assert!(replay_roots_overlap(
            replays,
            Path::new(r"c:/games/world of warships\replays")
        ));
        assert!(replay_roots_overlap(
            Path::new(r"C:\Games\World of Warships"),
            replays
        ));
        assert!(replay_roots_overlap(
            replays,
            Path::new(r"C:\Games\World of Warships")
        ));
        assert!(!replay_roots_overlap(
            replays,
            Path::new(r"C:\Games\World of Warships 2\replays")
        ));
    }

    /// A replay root the auto-scan never reported — the user's manual pin
    /// (`game-config.toml` active path, or a raw running client) — is owned
    /// by that install as a `Manual` one, so its rows carry the identity the
    /// client menus and filters key on. Roots nobody claims (the phone's
    /// managed dir, an env pin) stay ownerless, and an install the scan
    /// already lists is not claimed here: the install loop covered it.
    #[test]
    fn owner_among_tags_unscanned_installs_only() {
        let manual = r"D:\Portable\World of Warships".to_string();
        let scanned_path = r"C:\Games\WoWS".to_string();
        let scanned = vec![GameInstall {
            kind: GameInstallKind::Steam,
            path: scanned_path.clone(),
            realm: Some("asia".into()),
        }];

        let owned = owner_among(
            &[manual.clone(), scanned_path.clone()],
            Path::new(r"D:\Portable\World of Warships\replays"),
            &scanned,
        )
        .expect("the manual candidate owns its replays folder");
        assert_eq!(owned.kind, GameInstallKind::Manual);
        assert_eq!(owned.path, manual);
        // No clientrunner.log under the synthetic root, so the realm stays
        // undetected — the same state a realm-less real install reports.
        assert!(owned.realm.is_none(), "no log, no realm");

        // Different spellings of the same folder still identify.
        assert!(
            owner_among(
                &[r"d:/portable/world of warships".to_string()],
                Path::new(r"D:\Portable\World of Warships\replays\"),
                &[],
            )
            .is_some()
        );

        // An install the scan already lists must not be re-tagged (the
        // install loop walked its replays folder already).
        assert!(
            owner_among(
                &[scanned_path],
                Path::new(r"C:\Games\WoWS\replays"),
                &scanned,
            )
            .is_none()
        );

        // A root no candidate claims stays ownerless (managed dir / env pin).
        assert!(owner_among(&[manual], Path::new(r"D:\Replays"), &scanned,).is_none());
    }

    /// PreferRunning picks the running client over the persisted active
    /// install — the roster is written by whichever process is live.
    #[test]
    fn prefer_running_takes_process_over_active() {
        let running = vec![(7u32, r"C:\Games\ClientB".to_string())];
        let got = resolve_head(
            &running,
            Some(r"C:\Games\ClientA"),
            RootPreference::PreferRunning,
        )
        .expect("resolved");
        assert_eq!(got.root, Path::new(r"C:\Games\ClientB"));
        assert_eq!(got.source, RootSource::RunningProcess);
    }

    /// PreferActive is the user-scoped order: persisted selection first, the
    /// running client only fills the gap.
    #[test]
    fn prefer_active_takes_selection_over_process() {
        let running = vec![(7u32, r"C:\Games\ClientB".to_string())];
        let got = resolve_head(
            &running,
            Some(r"C:\Games\ClientA"),
            RootPreference::PreferActive,
        )
        .expect("resolved");
        assert_eq!(got.root, Path::new(r"C:\Games\ClientA"));
        assert_eq!(got.source, RootSource::ActiveConfig);
    }

    /// With BOTH clients running at once, the one matching the persisted
    /// selection wins so capture and roster follow the same client.
    #[test]
    fn multiple_running_prefers_active_matched_process() {
        let running = vec![
            (11u32, r"C:\Games\ClientA\".to_string()),
            (22u32, r"c:/games/clientb".to_string()),
        ];
        let got = resolve_head(
            &running,
            Some(r"C:\Games\ClientB"),
            RootPreference::PreferRunning,
        )
        .expect("resolved");
        assert_eq!(got.source, RootSource::RunningProcess);
        assert_eq!(got.root, Path::new(r"c:/games/clientb"));
    }

    /// Folder identity is spelling-insensitive (case, separators, trailing
    /// slash) — registry, Steam vdf and the exe path never agree on those.
    #[test]
    fn same_folder_ignores_spelling() {
        assert!(same_folder(
            r"C:\Games\World of Warships\",
            "c:/games/world of warships"
        ));
        assert!(!same_folder(r"C:\Games\ClientA", r"C:\Games\ClientB"));
    }

    /// The exe→root inference: above `\bin\`, else the exe's own folder.
    #[test]
    fn exe_game_root_strips_bin_segment() {
        assert_eq!(
            exe_game_root(r"C:\Games\WoWS\bin\12668706\bin64\WorldOfWarships64.exe").as_deref(),
            Some(r"C:\Games\WoWS")
        );
        assert_eq!(
            exe_game_root(r"C:\Games\WoWS\WorldOfWarships.exe").as_deref(),
            Some(r"C:\Games\WoWS")
        );
        assert_eq!(exe_game_root("bare.exe"), None);
    }

    /// bin/<build> selection: idx-carrying builds win over a higher numeric
    /// dir without idx; with no idx anywhere the numeric max survives (mods
    /// must still land somewhere); the strict idx variant returns None then.
    #[test]
    fn latest_bin_dir_prefers_idx_carriers() {
        let tmp = std::env::temp_dir().join(format!(
            "wowsp-ctx-bins-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("bin/100")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/200/idx")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/300")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/notaversion")).unwrap();

        let (build, dir) = latest_bin_dir(&tmp).expect("resolved");
        assert_eq!(build, 200);
        assert!(dir.ends_with("200"));

        let strict = latest_bin_dir_with_idx(&tmp).expect("resolved");
        assert_eq!(strict.0, 200);

        // No idx anywhere: numeric max for mods, None for the VFS readers.
        std::fs::remove_dir_all(tmp.join("bin/200/idx")).unwrap();
        let (build, _) = latest_bin_dir(&tmp).expect("resolved");
        assert_eq!(build, 300);
        assert!(latest_bin_dir_with_idx(&tmp).is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// Preload detection: complete (idx-carrying) bins strictly above the
    /// pin; nothing below it, nothing partial, nothing without a pin.
    #[test]
    fn preload_bins_are_complete_dirs_above_the_pin() {
        let tmp = std::env::temp_dir().join(format!(
            "wowsp-ctx-preload-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("bin/100/idx")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/200/idx")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/250")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/300/idx")).unwrap();
        std::fs::write(
            tmp.join("preferences.xml"),
            "<root><last_server_version> 15,8,0,200 </last_server_version></root>",
        )
        .unwrap();

        let preload = preload_bin_dirs(&tmp);
        assert_eq!(preload.len(), 1, "{preload:?}");
        assert_eq!(preload[0].0, 300);

        std::fs::remove_file(tmp.join("preferences.xml")).unwrap();
        assert!(preload_bin_dirs(&tmp).is_empty());

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// The preferences.xml pin decides which build everything targets: with
    /// the next version's complete bin dirs pre-released on Steam ABOVE the
    /// pinned build, both selectors keep targeting the pinned one; a pin
    /// naming a build the tree does not carry falls back to disk shape.
    #[test]
    fn preferences_pin_beats_prerelease_bin_dirs() {
        let tmp = std::env::temp_dir().join(format!(
            "wowsp-ctx-prefpin-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("bin/100/idx")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/200/idx")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/300/idx")).unwrap();
        std::fs::write(
            tmp.join("preferences.xml"),
            "<root>\n\t<last_server_version>\t15,8,0,200\t</last_server_version>\n</root>\n",
        )
        .unwrap();

        let (build, dir) = latest_bin_dir(&tmp).expect("resolved");
        assert_eq!(build, 200);
        assert!(dir.ends_with("200"));
        let strict = latest_bin_dir_with_idx(&tmp).expect("resolved");
        assert_eq!(strict.0, 200);

        // A pin the tree cannot satisfy changes nothing.
        std::fs::write(
            tmp.join("preferences.xml"),
            "<root><last_server_version> 16,0,0,999 </last_server_version></root>",
        )
        .unwrap();
        assert_eq!(latest_bin_dir(&tmp).expect("resolved").0, 300);
        assert_eq!(latest_bin_dir_with_idx(&tmp).expect("resolved").0, 300);

        // A pinned build without idx/ still takes mod writes (the client
        // runs it), but the strict VFS variant skips it for an idx carrier.
        std::fs::remove_dir_all(tmp.join("bin/300/idx")).unwrap();
        std::fs::write(
            tmp.join("preferences.xml"),
            "<root><last_server_version>16,0,0,300</last_server_version></root>",
        )
        .unwrap();
        assert_eq!(latest_bin_dir(&tmp).expect("resolved").0, 300);
        assert_eq!(latest_bin_dir_with_idx(&tmp).expect("resolved").0, 200);

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// The pin parser reads what real clients write (tab-indented comma
    /// quad) plus tolerant variants (attributes, casing), and stays
    /// silent on anything else.
    #[test]
    fn preferences_pin_parser_shapes() {
        use super::parse_last_server_build as parse;

        // The real client's shape: tab-indented, CRLF file, comma quad.
        assert_eq!(
            parse(
                "<p>\r\n\t\t<last_server_version>\t15,8,0,13187581\t</last_server_version>\r\n</p>"
            ),
            Some(13187581)
        );
        assert_eq!(
            parse("<last_server_version>200</last_server_version>"),
            Some(200)
        );
        // Tolerant variants: attributes on the tag, uppercased spelling.
        assert_eq!(
            parse(r#"<last_server_version active="1">15,9,1,13357625</last_server_version>"#),
            Some(13357625)
        );
        assert_eq!(
            parse("<LAST_SERVER_VERSION>15,8,0,13187581</LAST_SERVER_VERSION>"),
            Some(13187581)
        );
        // Misses fall back to disk shape.
        assert_eq!(
            parse("<last_server_version>15,8,0,not-a-build</last_server_version>"),
            None
        );
        assert_eq!(parse("<last_server_version/>"), None);
        assert_eq!(parse("<preferences></preferences>"), None);
        assert_eq!(parse(""), None);
    }

    /// res_mods_dir joins onto the selected build dir and reports the root
    /// it failed on.
    #[test]
    fn res_mods_dir_derives_from_latest_build() {
        let tmp = std::env::temp_dir().join("wowsp-ctx-resmods");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("bin/42/idx")).unwrap();
        let dir = res_mods_dir(&tmp).expect("resolved");
        assert!(dir.ends_with(r"bin\42\res_mods") || dir.ends_with("bin/42/res_mods"));
        let err = res_mods_dir(std::path::Path::new(
            r"C:\definitely\not\a\game\wowsp-ctx-none",
        ))
        .unwrap_err();
        assert!(err.contains("bin"), "unexpected error text: {err}");
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// The full chain falls through to the first detected install when
    /// neither a process nor a persisted selection exists.
    #[test]
    fn scan_tier_is_last_resort() {
        // resolve_head is the pure tier; the scan tier is exercised through
        // resolve_root which needs a real machine scan — here we only pin
        // the pure tier's miss shape.
        assert!(resolve_head(&[], None, RootPreference::PreferRunning).is_none());
        assert!(resolve_head(&[], None, RootPreference::PreferActive).is_none());
    }

    /// An active path that is only reachable when nothing runs must not
    /// shadow a later running candidate in the PreferRunning order, and a
    /// running candidate must survive a MISSING active path in both orders.
    #[test]
    fn running_candidate_survives_missing_active() {
        let running = vec![(3u32, r"D:\Steam\WoWS".to_string())];
        for preference in [RootPreference::PreferRunning, RootPreference::PreferActive] {
            let got = resolve_head(&running, None, preference).expect("resolved");
            assert_eq!(got.root, Path::new(r"D:\Steam\WoWS"));
            assert_eq!(got.source, RootSource::RunningProcess);
        }
    }

    /// The strict idx variant skips u32-unrepresentable build names instead
    /// of failing outright (the next-highest idx carrier wins).
    #[test]
    fn with_idx_skips_oversized_build_names() {
        let tmp = std::env::temp_dir().join(format!(
            "wowsp-ctx-oversized-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("bin/9999999999/idx")).unwrap();
        std::fs::create_dir_all(tmp.join("bin/200/idx")).unwrap();
        let (build, _) = latest_bin_dir_with_idx(&tmp).expect("resolved");
        assert_eq!(build, 200);
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// Every client build's process name matches — WG/Steam
    /// (`WorldOfWarships(.64).exe`) and Lesta (`Korabli(.64).exe`) — while
    /// lookalikes (the launcher, a renamed copy) do not.
    #[test]
    fn game_process_names_cover_wg_and_lesta_builds() {
        for name in [
            "worldofwarships.exe",
            "worldofwarships64.exe",
            "korabli.exe",
            "korabli64.exe",
        ] {
            assert!(is_game_process_name(name), "{name} should match");
        }
        for lookalike in [
            "wgc.exe",
            "lgc.exe",
            "korabli_launcher.exe",
            "worldofwarships_monitor.exe",
            "",
        ] {
            assert!(
                !is_game_process_name(lookalike),
                "{lookalike} must not match"
            );
        }
    }
}
