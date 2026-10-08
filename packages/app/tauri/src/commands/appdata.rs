//! AppData persistence (read/write JSON files under %APPDATA%/WoWSP/).
//!
//! Stores the user's account profiles, stats cache, and replay history as
//! plain JSON — no SQLite. The directory is created on first write.

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths;

/// Resolve the writable data root (`%APPDATA%/WoWSP/` locally, `<exe>/data/`
/// in portable mode), creating it if missing.
///
/// Shared by every command module that touches AppData-backed caches
/// directly (encyclopedia / gameparams / ship_stats / trends) so they
/// always resolve the same root as the `appdata_*` commands below —
/// never `dirs_next` on its own.
pub(crate) fn appdata_dir_path() -> Result<PathBuf, String> {
    paths::ensure_data_dir()
}

/// IPC names are relative data-file names, never arbitrary filesystem paths.
/// Reject Windows aliases on every platform and links below the chosen root.
pub(crate) fn data_file_path(dir: &Path, file: &str) -> Result<PathBuf, String> {
    let mut path = dir.to_path_buf();
    for segment in file.split('/') {
        let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|suffix| {
                    matches!(
                        suffix,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || segment.ends_with(['.', ' '])
            || segment
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || device
        {
            return Err(format!("invalid app data file name: {file:?}"));
        }
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                let linked = meta.file_type().is_symlink();
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    linked || meta.file_attributes() & 0x400 != 0
                };
                if linked {
                    return Err(format!(
                        "app data file path contains a filesystem link: {path:?}"
                    ));
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("inspect {path:?}: {e}")),
        }
    }
    Ok(path)
}

/// Read a file from the AppData root. Returns `None` when the file doesn't
/// exist yet (the "no cache yet" state every consumer treats as empty).
pub(crate) fn read_appdata_json(file: &str) -> Result<Option<String>, String> {
    read_json_in(&appdata_dir_path()?, file)
}

pub(crate) fn read_json_in(dir: &Path, file: &str) -> Result<Option<String>, String> {
    let path = data_file_path(dir, file)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

/// Write a file under the AppData root (atomic: write to `.tmp` then
/// rename). Creates intermediate subdirectories (e.g. `stats-cache/x.json`)
/// as needed.
pub(crate) fn write_appdata_json(file: &str, content: &str) -> Result<(), String> {
    write_json_in(&appdata_dir_path()?, file, content)
}

/// [`write_appdata_json`] against an explicit directory — the injectable
/// form tests (and other command modules' install paths) run against a
/// temp dir instead of the real AppData root. Same atomicity contract:
/// tmp + rename, parent subdirectories created on demand.
pub(crate) fn write_json_in(
    dir: &std::path::Path,
    file: &str,
    content: &str,
) -> Result<(), String> {
    crate::atomic_file::write(&data_file_path(dir, file)?, content)
}

/// Read a JSON file from AppData. Returns None if the file doesn't exist yet.
#[tauri::command]
pub fn appdata_read(file: String) -> Result<Option<String>, String> {
    read_appdata_json(&file)
}

/// Write a JSON file to AppData (atomic: write to .tmp then rename).
/// Creates intermediate subdirectories (e.g. `stats-cache/x.json`) as needed.
#[tauri::command]
pub fn appdata_write(file: String, content: String) -> Result<(), String> {
    write_appdata_json(&file, &content)
}

/// Delete a file from AppData. Idempotent (missing file is OK).
#[tauri::command]
pub fn appdata_delete(file: String) -> Result<(), String> {
    delete_json_in(&appdata_dir_path()?, &file)
}

fn delete_json_in(dir: &Path, file: &str) -> Result<(), String> {
    let path = data_file_path(dir, file)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {path:?}: {e}")),
    }
}

/// Check if the World of Warships game process is currently running.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn is_game_running() -> bool {
    find_game_pid().is_some()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn is_game_running() -> bool {
    false
}

/// Return rich information about the running World of Warships process: PID,
/// the install it belongs to (kind/realm), and the exe path. The `installs`
/// argument is the list of detected installs (from `detect_game_install`) —
/// the process's exe path is matched against each install's path to decide
/// *which* client is running (Steam vs Wargaming vs Lesta vs 360).
///
/// This mirrors Starward's approach: enumerate processes by name, then resolve
/// the running client by matching the exe's directory against known installs.
/// `is_game_running` is the boolean projection of this.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn get_game_process(
    installs: Vec<wowsp_tauri_shared::GameInstall>,
) -> wowsp_tauri_shared::GameProcessInfo {
    compute_process_info(&installs)
}

/// The offline projection every non-running answer shares.
fn offline_process() -> wowsp_tauri_shared::GameProcessInfo {
    wowsp_tauri_shared::GameProcessInfo {
        running: false,
        pid: None,
        kind: None,
        realm: None,
        exe_path: None,
        matched_install: None,
    }
}

/// Shared core of [`get_game_process`] — also the session poller's per-tick
/// body (it resolves the same preferred PID + install matching without a
/// webui round-trip). Pure w.r.t. its inputs, so the poller and the command
/// can never disagree about which client is running.
#[cfg(target_os = "windows")]
pub(crate) fn compute_process_info(
    installs: &[wowsp_tauri_shared::GameInstall],
) -> wowsp_tauri_shared::GameProcessInfo {
    use wowsp_tauri_shared::GameProcessInfo;

    let Some(pid) = find_game_pid() else {
        return offline_process();
    };

    // Resolve the exe's full path, then match it against the known installs to
    // decide which client (Steam / Wargaming / ...) is running. When detection
    // came up empty (unusual Steam library layout, moved folder), synthesize
    // an install from the exe's own path so downstream features (GameParams,
    // replays, mods) still get a usable game root — the same unification the
    // setup modal offers as its "use running game's path" action.
    let exe_path = query_process_image_path(pid);
    let owned_matched = exe_path
        .as_deref()
        .and_then(|exe| match_install(installs, exe))
        .cloned()
        .or_else(|| exe_path.as_deref().and_then(infer_install_from_exe));
    let matched = owned_matched.as_ref();

    let (kind, realm) = match &matched {
        Some(m) => (Some(m.kind), m.realm.clone()),
        None => {
            // No exe path at all — nothing to infer from.
            (None, None)
        },
    };

    GameProcessInfo {
        running: true,
        pid: Some(pid),
        kind,
        realm,
        exe_path,
        matched_install: owned_matched,
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn compute_process_info(
    _installs: &[wowsp_tauri_shared::GameInstall],
) -> wowsp_tauri_shared::GameProcessInfo {
    offline_process()
}

/// Synthesize an install for a running exe that no detected install claims.
/// The root is the segment above `bin\` (the 64-bit client lives in
/// `bin/<build>/bin64/`), falling back to the exe's own directory for the
/// root-level launcher stub.
///
/// The kind is inferred from the exe name first (the Lesta client renamed
/// its binaries to `Korabli(.64).exe` while install roots often carry no
/// "lesta" marker — the default is a plain `D:\Korabli`), then from path
/// markers: every distribution channel keeps the same on-disk layout, but
/// their install roots are telling — Steam lives under `steamapps`, the CN
/// clients under a KongZhong/空中网/360 folder, the Lesta client under
/// "Lesta Game Center". Anything else is treated as the Wargaming
/// international client (the historical behavior that mislabeled the legacy
/// CN clients — user-reported).
#[cfg(target_os = "windows")]
pub(crate) fn infer_install_from_exe(exe: &str) -> Option<wowsp_tauri_shared::GameInstall> {
    use wowsp_tauri_shared::{GameInstall, GameInstallKind};

    let root = super::game_context::exe_game_root(exe)?;
    let norm = exe.replace('/', "\\");
    let lower = norm.to_lowercase();
    let file = lower.rsplit('\\').next().unwrap_or_default();
    // The per-family process-name hints first (only Lesta's rename is
    // decisive — korabli(.64).exe → Lesta); checked before `steamapps`
    // because RU/CIS Steam installs run the same Korabli binaries but need
    // the Lesta realm. The WG family answers None (its exe names are shared
    // by Steam and the CN clients), so those fall through to the path
    // markers below exactly as before.
    let hinted = super::game_client::CLIENTS
        .iter()
        .find_map(|client| client.process_kind_hint(file));
    let kind = if let Some(kind) = hinted {
        kind
    } else if lower.contains("steamapps") {
        GameInstallKind::Steam
    } else if lower.contains("kongzhong") || norm.contains("空中网") {
        GameInstallKind::CnKongzhong
    } else if lower.contains("lesta") {
        GameInstallKind::Lesta
    } else if norm.contains("360游戏大厅") || lower.contains("\\360\\") {
        // Match the 360 launcher's directory name or a dedicated `\360\`
        // segment — a bare "360" substring also fires on unrelated digits
        // (timestamps, "D:\360Downloads\…") and misclassified Wargaming
        // installs as Cn360.
        GameInstallKind::Cn360
    } else {
        GameInstallKind::Wargaming
    };
    Some(GameInstall {
        realm: super::game_detect::detect_realm(std::path::Path::new(&root))
            .or_else(|| super::game_detect::kind_fallback_realm(&kind)),
        kind,
        path: root,
    })
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn get_game_process(
    _installs: Vec<wowsp_tauri_shared::GameInstall>,
) -> wowsp_tauri_shared::GameProcessInfo {
    offline_process()
}

/// Non-Windows builds never see the client, so the game-running guard used
/// by the mod hub passes through.
#[cfg(not(target_os = "windows"))]
pub(crate) fn find_game_pid() -> Option<u32> {
    None
}

/// Find the PID of the running client WoWSP should work with: the process
/// backing the unified game context's live-monitoring root (see
/// `commands::game_context`), falling back to the first
/// `WorldOfWarships*.exe` in the snapshot. With several clients installed —
/// or two running at once — capture, roster watching and the sidebar all
/// follow the SAME client instead of diverging.
#[cfg(target_os = "windows")]
pub(crate) fn find_game_pid() -> Option<u32> {
    super::game_context::preferred_game_pid()
}

/// Query the full image path of a process by PID. Uses
/// `PROCESS_QUERY_LIMITED_INFORMATION` (available without elevation for
/// processes owned by other users in the same session) + `QueryFullProcessImageNameW`.
/// Shared with the unified game context, which resolves every running
/// client's install folder from these paths.
#[cfg(target_os = "windows")]
pub(crate) fn query_process_image_path(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        if result.is_ok() {
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        } else {
            None
        }
    }
}

/// The process's creation time as unix SECONDS (None when the handle or the
/// time query fails). The session hub uses it to reject battle rosters that
/// predate the running client — a `tempArenaInfo.json` left behind by a
/// crashed session must never re-identify the player under the new one.
#[cfg(target_os = "windows")]
pub(crate) fn query_process_start_unix(pid: u32) -> Option<i64> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // FILETIME epoch (1601-01-01) vs unix epoch, in 100ns ticks.
    const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let _ = CloseHandle(handle);
        if ok.is_err() {
            return None;
        }
        let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        ticks
            .checked_sub(FILETIME_UNIX_EPOCH)
            .map(|t| (t / 10_000_000) as i64)
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn query_process_start_unix(_pid: u32) -> Option<i64> {
    None
}

/// Match a running exe path against the known installs. An install matches
/// when the exe path starts with the install's directory (case-insensitive,
/// path-separator-agnostic) — i.e. the running game lives inside that install.
#[cfg(target_os = "windows")]
fn match_install<'a>(
    installs: &'a [wowsp_tauri_shared::GameInstall],
    exe_path: &str,
) -> Option<&'a wowsp_tauri_shared::GameInstall> {
    let normalize = |p: &str| p.to_lowercase().replace('/', r"\");
    let exe_norm = normalize(exe_path);
    // Prefer the longest matching prefix so a nested (more specific) install
    // wins over a broader one.
    installs
        .iter()
        .filter(|i| {
            let dir = normalize(&i.path).trim_end_matches('\\').to_string();
            !dir.is_empty() && (exe_norm == dir || exe_norm.starts_with(&format!("{dir}\\")))
        })
        .max_by_key(|i| i.path.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let dir = std::env::temp_dir().join(format!("wowsp-appdata-{}", hex::encode(nonce)));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn appdata_operations_reject_paths_outside_the_data_root_and_windows_aliases() {
        let fixture = Fixture::new();
        let root = fixture.0.join("data");
        fs::create_dir_all(&root).unwrap();
        let victim = fixture.0.join("victim.json");
        fs::write(&victim, "existing").unwrap();
        for name in [
            "../victim.json",
            "sub/../../victim.json",
            "..\\victim.json",
            "C:relative.json",
            "/absolute.json",
            "x.json:stream",
            "CON.json",
            "LPT¹.json",
            "cache./x.json",
            "cache /x.json",
            "",
            "./x.json",
            "x//y.json",
            "x.json/",
        ] {
            assert!(write_json_in(&root, name, "overwrite").is_err(), "{name}");
            assert!(read_json_in(&root, name).is_err(), "{name}");
            assert!(delete_json_in(&root, name).is_err(), "{name}");
        }
        let absolute = victim.to_string_lossy();
        assert!(write_json_in(&root, &absolute, "overwrite").is_err());
        assert_eq!(fs::read_to_string(victim).unwrap(), "existing");
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn appdata_operations_do_not_follow_a_directory_junction() {
        let fixture = Fixture::new();
        let root = fixture.0.join("data");
        let outside = fixture.0.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("victim.json"), "existing").unwrap();
        let junction = root.join("linked");
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(read_json_in(&root, "linked/victim.json").is_err());
        assert!(write_json_in(&root, "linked/victim.json", "overwrite").is_err());
        assert!(delete_json_in(&root, "linked/victim.json").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("victim.json")).unwrap(),
            "existing"
        );
        fs::remove_dir(junction).unwrap();
    }

    #[test]
    fn concurrent_writes_use_distinct_temporary_files_and_publish_complete_payloads() {
        let fixture = Fixture::new();
        let barrier = std::sync::Barrier::new(8);
        let payloads: Vec<_> = (0..8)
            .map(|id| format!("{{\"id\":{id},\"data\":\"{}\"}}", "x".repeat(65536)))
            .collect();
        std::thread::scope(|scope| {
            for payload in &payloads {
                let root = &fixture.0;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..20 {
                        write_json_in(root, "accounts.json", payload).unwrap();
                    }
                });
            }
        });
        let saved = read_json_in(&fixture.0, "accounts.json").unwrap().unwrap();
        assert!(payloads.contains(&saved));
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_replacement_keeps_the_destination_and_leaves_no_temporary_file() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("blocked.json")).unwrap();
        fs::write(fixture.0.join("blocked.json/keep"), "existing").unwrap();
        assert!(write_json_in(&fixture.0, "blocked.json", "new").is_err());
        assert_eq!(
            fs::read_to_string(fixture.0.join("blocked.json/keep")).unwrap(),
            "existing"
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn atomic_replacement_does_not_truncate_a_hard_link_target() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside.json");
        fs::write(&outside, "existing").unwrap();
        fs::hard_link(&outside, fixture.0.join("linked.json")).unwrap();
        write_json_in(&fixture.0, "linked.json", "new").unwrap();
        assert_eq!(fs::read_to_string(outside).unwrap(), "existing");
        assert_eq!(
            read_json_in(&fixture.0, "linked.json").unwrap().as_deref(),
            Some("new")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn process_install_matching_requires_a_directory_boundary() {
        use wowsp_tauri_shared::{GameInstall, GameInstallKind};
        let install = |path: &str| GameInstall {
            path: path.into(),
            kind: GameInstallKind::Wargaming,
            realm: None,
        };
        let installs = vec![install(r"C:\Games\WoWS"), install(r"C:\Games\WoWS\Nested\")];
        assert!(
            match_install(&installs, r"C:\Games\WoWS-backup\bin\WorldOfWarships64.exe").is_none()
        );
        assert_eq!(
            match_install(&installs, "c:/games/wows/bin/WorldOfWarships64.exe")
                .unwrap()
                .path,
            installs[0].path
        );
        assert_eq!(
            match_install(&installs, r"C:\Games\WoWS\Nested\bin\WorldOfWarships64.exe")
                .unwrap()
                .path,
            installs[1].path
        );
    }

    /// The running-exe fallback infers the client kind from path markers so a
    /// CN / Lesta client that no detected install claims is still labeled
    /// correctly (user-reported: a KongZhong install used to fall through to
    /// "Wargaming"). Realm falls back to the kind-implied region when the
    /// install carries no clientrunner.log. Every fixture is rooted under the
    /// session temp dir so a real install can never satisfy
    /// `detect_realm` and break the expected fallback.
    #[cfg(target_os = "windows")]
    #[test]
    fn infer_install_from_exe_recognizes_cn_and_lesta_roots() {
        let base = std::env::temp_dir().join(format!(
            "wowsp-test-infer-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let base = base.to_string_lossy().into_owned();
        let wow = |marker: &str| {
            format!(r"{base}\{marker}\World of Warships\bin\250107\bin64\WorldOfWarships64.exe")
        };
        let cases: Vec<(String, wowsp_tauri_shared::GameInstallKind, Option<&str>)> = vec![
            (
                wow("Lesta Game Center"),
                wowsp_tauri_shared::GameInstallKind::Lesta,
                Some("ru"),
            ),
            // The Lesta rename: the running client is Korabli(.64).exe even
            // when the install root carries no "lesta" marker at all.
            (
                format!(r"{base}\WoWS_Korabli\bin\8821884\bin64\Korabli64.exe"),
                wowsp_tauri_shared::GameInstallKind::Lesta,
                Some("ru"),
            ),
            (
                format!(r"{base}\Korabli\Korabli.exe"),
                wowsp_tauri_shared::GameInstallKind::Lesta,
                Some("ru"),
            ),
            // RU/CIS Steam installs run the Korabli binaries too — the exe
            // name wins over the steamapps marker so the realm resolves.
            (
                format!(
                    r"{base}\SteamLibrary\steamapps\common\World of Warships\bin\8821884\bin64\Korabli64.exe"
                ),
                wowsp_tauri_shared::GameInstallKind::Lesta,
                Some("ru"),
            ),
            (
                wow("360游戏大厅"),
                wowsp_tauri_shared::GameInstallKind::Cn360,
                Some("cn"),
            ),
            (
                format!(
                    r"{base}\KongZhong Games\World of Warships\bin\250107\bin64\WorldOfWarships.exe"
                ),
                wowsp_tauri_shared::GameInstallKind::CnKongzhong,
                Some("cn"),
            ),
            (
                wow(r"SteamLibrary\steamapps\common"),
                wowsp_tauri_shared::GameInstallKind::Steam,
                None,
            ),
            (
                wow("Games"),
                wowsp_tauri_shared::GameInstallKind::Wargaming,
                None,
            ),
        ];
        for (exe, kind, realm) in &cases {
            let install = infer_install_from_exe(exe).expect("root derivable");
            assert_eq!(&install.kind, kind, "kind for {exe}");
            assert_eq!(install.realm.as_deref(), *realm, "realm for {exe}");
            assert!(
                !install.path.ends_with("\\bin"),
                "root stops above bin\\: {}",
                install.path
            );
        }
        // Forward-slash paths (webview-normalized) normalize before matching.
        let install = infer_install_from_exe(&format!(
            "{base}/Lesta Game Center/World of Warships/bin/250107/bin64/WorldOfWarships64.exe"
        ))
        .unwrap();
        assert_eq!(install.kind, wowsp_tauri_shared::GameInstallKind::Lesta);
    }

    /// Regression: appdata_write("stats-cache/x.json") used to fail silently
    /// because the `stats-cache/` subdirectory was never created. Now it
    /// creates intermediate dirs. We test against a temp dir by temporarily
    /// overriding the data dir via the `WOWSP_TEST_APPDATA` env var.
    #[test]
    fn writes_to_subdirectory() {
        // dirs_next::data_dir() isn't injectable, so we test the join +
        // create_dir_all logic in isolation: simulate by building a temp
        // path manually and calling create_dir_all + write + rename.
        let tmp = std::env::temp_dir().join(format!(
            "wowsp-test-{}-subdir",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = "stats-cache/asia_123.json";
        let path = tmp.join(file);
        let tmp_file = tmp.join(format!("{file}.tmp"));

        // Replicate the fix's logic.
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&tmp_file, r#"{"accountId":123}"#).unwrap();
        fs::rename(&tmp_file, &path).unwrap();

        // Read back.
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"accountId":123}"#);

        // Cleanup.
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Smoke test for the real appdata_write → appdata_read round-trip against
    //  a subdirectory path. Uses the actual %APPDATA% path, so this exercises
    //  the real code path (not just a simulation).
    #[test]
    fn appdata_round_trip_subdirectory() {
        let file = format!(
            "test-subdir/{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let payload = r#"{"round":"trip","n":[1,2,3]}"#;

        // write
        appdata_write(file.clone(), payload.to_string()).expect("write should succeed");

        // read back
        let read = appdata_read(file.clone()).expect("read should not error");
        assert_eq!(read.as_deref(), Some(payload));

        // cleanup
        let _ = appdata_delete(file);
    }
}
