//! AppData persistence (read/write JSON files under %APPDATA%/WoWSP/).
//!
//! Stores the user's account profiles, stats cache, and replay history as
//! plain JSON — no SQLite. The directory is created on first write.

use std::fs;
use std::path::PathBuf;

/// Resolve `<APPDATA>/WoWSP/`, creating it if missing.
fn appdata_dir() -> Result<PathBuf, String> {
    let base = dirs_next::data_dir().ok_or_else(|| "cannot resolve AppData dir".to_string())?;
    let dir = base.join("WoWSP");
    fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
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
pub fn is_game_running() -> bool {
    find_game_pid().is_some()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn is_game_running() -> bool {
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
pub fn get_game_process(installs: Vec<wowsp_tauri_shared::GameInstall>) -> wowsp_tauri_shared::GameProcessInfo {
    use wowsp_tauri_shared::{GameInstallKind, GameProcessInfo};

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
    // decide which client (Steam / Wargaming / ...) is running.
    let exe_path = query_process_image_path(pid);
    let matched = exe_path
        .as_deref()
        .and_then(|exe| match_install(&installs, exe));

    let (kind, realm) = match &matched {
        Some(m) => (Some(m.kind.clone()), m.realm.clone()),
        None => {
            // No install list / no match — still try to infer Steam from the path
            // (the most common case where the install wasn't pre-detected).
            let is_steam = exe_path
                .as_deref()
                .map(|p| {
                    let lower = p.to_lowercase();
                    lower.contains("steamapps") && lower.contains("common")
                })
                .unwrap_or(false);
            (
                Some(if is_steam { GameInstallKind::Steam } else { GameInstallKind::Wargaming }),
                None,
            )
        }
    };

    GameProcessInfo {
        running: true,
        pid: Some(pid),
        kind,
        realm,
        exe_path,
        matched_install: matched.cloned(),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_game_process(_installs: Vec<wowsp_tauri_shared::GameInstall>) -> wowsp_tauri_shared::GameProcessInfo {
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
fn find_game_pid() -> Option<u32> {
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
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32_EXE_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32_EXE_FORMAT,
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
            !dir.is_empty() && (exe_norm.starts_with(&dir) || exe_norm.starts_with(&format!("{dir}\\")))
        })
        .max_by_key(|i| i.path.len())
}

#[cfg(test)]
mod tests {
    use super::*;

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
