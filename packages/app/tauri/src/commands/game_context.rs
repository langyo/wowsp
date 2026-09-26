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

use wowsp_tauri_shared::GameInstall;

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

/// All running `WorldOfWarships*.exe` processes whose implied folder
/// validates as a game install: `(pid, game_root)`. A process whose image
/// path cannot be queried, or whose root lacks the `WorldOfWarships.exe`
/// stub, is invisible here BY DESIGN — everything downstream (capture,
/// roster, guards) keys on validated folders, so an exotic/partial tree is
/// treated as "not running" rather than routing work to a bogus root. The
/// exe-path query is Windows-only, so non-Windows targets (the mobile
/// build) always see an empty list here.
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
/// re-detect button must see fresh state).
fn cached_scan() -> Vec<GameInstall> {
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

/// The newest `bin/<build>/` that ships an `idx/` directory — the build the
/// client actually runs from. Steam installs keep several partially
/// downloaded builds around and only some carry the index files the VFS
/// needs (same rule as `scripts/extract/_common.py`). Consumers: GameParams
/// unpack, map inventory.
pub(crate) fn latest_bin_dir_with_idx(root: &Path) -> Option<(u32, PathBuf)> {
    numeric_bin_dirs(root)
        .iter()
        .rev()
        // Skip u32-unrepresentable (contrived) build names instead of
        // swallowing the whole result — the next-highest idx build is still
        // the right answer for the VFS readers.
        .find_map(|(build, dir)| {
            let b = u32::try_from(*build).ok()?;
            dir.join("idx").is_dir().then_some((b, dir.clone()))
        })
}

/// The `bin/<build>` dir mods must target: the newest idx-carrying build
/// (a mod dropped into a build dir the client never loads is invisible),
/// falling back to the plain newest numeric dir — res_mods writes must still
/// land somewhere on trees whose builds all lack `idx/` (dev fixtures,
/// partial unpacks). Consumers: overlay mod installer, mod hub, catalog.
pub(crate) fn latest_bin_dir(root: &Path) -> Option<(u64, PathBuf)> {
    let dirs = numeric_bin_dirs(root);
    dirs.iter()
        .rev()
        .find(|(_, dir)| dir.join("idx").is_dir())
        .cloned()
        .or_else(|| dirs.last().cloned())
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

// ── process enumeration ─────────────────────────────────────────────────────

/// PIDs of every running `WorldOfWarships.exe` / `WorldOfWarships64.exe`.
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
            if name == "worldofwarships.exe" || name == "worldofwarships64.exe" {
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
}
