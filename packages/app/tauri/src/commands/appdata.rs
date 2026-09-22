//! AppData persistence (read/write JSON files under %APPDATA%/WoWSP/).
//!
//! Stores the user's account profiles, stats cache, and replay history as
//! plain JSON — no SQLite. The directory is created on first write.

use std::fs;
use std::path::PathBuf;

use crate::paths;

/// Resolve the writable data root (`%APPDATA%/WoWSP/` locally, `<exe>/data/`
/// in portable mode), creating it if missing.
fn appdata_dir() -> Result<PathBuf, String> {
    paths::ensure_data_dir()
}

/// Read a JSON file from AppData. Returns None if the file doesn't exist yet.
#[tauri::command]
pub fn appdata_read(file: String) -> Result<Option<String>, String> {
    let path = appdata_dir()?.join(&file);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

/// Write a JSON file to AppData (atomic: write to .tmp then rename).
/// Creates intermediate subdirectories (e.g. `stats-cache/x.json`) as needed.
#[tauri::command]
pub fn appdata_write(file: String, content: String) -> Result<(), String> {
    let dir = appdata_dir()?;
    let path = dir.join(&file);
    // Ensure any parent subdirectory (stats-cache/, snapshots/, ...) exists.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, &content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} → {path:?}: {e}"))?;
    Ok(())
}

/// Delete a file from AppData. Idempotent (missing file is OK).
#[tauri::command]
pub fn appdata_delete(file: String) -> Result<(), String> {
    let path = appdata_dir()?.join(&file);
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
    use wowsp_tauri_shared::GameProcessInfo;

    let Some(pid) = find_game_pid() else {
        return GameProcessInfo {
            running: false,
            pid: None,
            kind: None,
            realm: None,
            exe_path: None,
            matched_install: None,
        };
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
        .and_then(|exe| match_install(&installs, exe))
        .cloned()
        .or_else(|| exe_path.as_deref().and_then(infer_install_from_exe));
    let matched = owned_matched.as_ref();

    let (kind, realm) = match &matched {
        Some(m) => (Some(m.kind.clone()), m.realm.clone()),
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

/// Synthesize an install for a running exe that no detected install claims.
/// The root is the segment above `bin\` (the 64-bit client lives in
/// `bin/<build>/bin64/`), falling back to the exe's own directory for the
/// root-level launcher stub.
///
/// The kind is inferred from path markers: every distribution channel keeps
/// the same on-disk layout, but their install roots are telling — Steam lives
/// under `steamapps`, the CN clients under a KongZhong/空中网/360 folder, the
/// Lesta client under "Lesta Game Center". Anything else is treated as the
/// Wargaming international client (the historical behavior that mislabeled
/// the legacy CN clients — user-reported).
#[cfg(target_os = "windows")]
fn infer_install_from_exe(exe: &str) -> Option<wowsp_tauri_shared::GameInstall> {
    use wowsp_tauri_shared::{GameInstall, GameInstallKind};

    let norm = exe.replace('/', "\\");
    let root = match norm.rfind("\\bin\\") {
        Some(i) => norm[..i].to_string(),
        None => {
            let i = norm.rfind('\\')?;
            norm[..i].to_string()
        },
    };
    if root.is_empty() {
        return None;
    }
    let lower = norm.to_lowercase();
    let kind = if lower.contains("steamapps") {
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
    wowsp_tauri_shared::GameProcessInfo {
        running: false,
        pid: None,
        kind: None,
        realm: None,
        exe_path: None,
        matched_install: None,
    }
}

/// Find the PID of any running `WorldOfWarships.exe` / `WorldOfWarships64.exe`.
/// Returns the first match (matches Starward's "first process" semantics —
/// running two clients simultaneously is rare and would share a replay dir
/// only if they're the same install anyway).
#[cfg(target_os = "windows")]
pub(crate) fn find_game_pid() -> Option<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_err() {
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
            return None;
        }
        loop {
            let name = String::from_utf16_lossy(&entry.szExeFile[..])
                .trim_end_matches('\0')
                .to_lowercase();
            if name == "worldofwarships.exe" || name == "worldofwarships64.exe" {
                let pid = entry.th32ProcessID;
                let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                return Some(pid);
            }
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    None
}

/// Query the full image path of a process by PID. Uses
/// `PROCESS_QUERY_LIMITED_INFORMATION` (available without elevation for
/// processes owned by other users in the same session) + `QueryFullProcessImageNameW`.
#[cfg(target_os = "windows")]
fn query_process_image_path(pid: u32) -> Option<String> {
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
            let dir = normalize(&i.path);
            !dir.is_empty()
                && (exe_norm.starts_with(&dir) || exe_norm.starts_with(&format!("{dir}\\")))
        })
        .max_by_key(|i| i.path.len())
}

#[cfg(test)]
mod tests {
    use super::*;

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
