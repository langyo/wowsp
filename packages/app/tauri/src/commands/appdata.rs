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
#[tauri::command]
pub fn appdata_write(file: String, content: String) -> Result<(), String> {
    let dir = appdata_dir()?;
    let path = dir.join(&file);
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
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_err() {
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
            return false;
        }
        loop {
            let name = String::from_utf16_lossy(&entry.szExeFile[..])
                .trim_end_matches('\0')
                .to_lowercase();
            if name == "worldofwarships.exe" || name == "worldofwarships64.exe" {
                let _ = windows::Win32::Foundation::CloseHandle(snapshot);
                return true;
            }
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    false
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn is_game_running() -> bool {
    false
}
