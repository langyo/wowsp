//! Game-install detection.
//!
//! Principle (adapted from ApeRadar `ConfigWindow.AutoDetectGamePath`):
//! scan the Windows Uninstall registry for known Wargaming publishers, read
//! each entry's `InstallLocation`, and accept it when `WorldOfWarships.exe`
//! exists there. WoWSP additionally walks Steam library folders for
//! `appmanifest_552990.acf` (Steam appid 552990 = World of Warships) — the case
//! ApeRadar does not cover. A user can also pin a manual path.
//!
//! Status: **skeleton**. The registry + Steam scans are stubbed to return an
//! empty list with a TODO; milestone M1 in PLAN.md fills them in.

use std::path::PathBuf;

use wowsp_tauri_shared::{GameInstall, GameInstallKind};

/// Known publisher strings on the Windows Uninstall keys, covering the four
/// distribution channels. Sourced from ApeRadar's `ConfigWindow.xaml.cs`.
const WG_PUBLISHERS: &[&str] = &[
    "Wargaming.net",
    "Wargaming Group Limited",
    "360.cn",
    "Lesta Games",
];

/// Steam appid for World of Warships.
const STEAM_APPID: &str = "552990";

/// Auto-detect every World of Warships install on this machine.
///
/// TODO(M1): implement the registry walk (`HKCU` + `HKLM`
/// `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`, filter by
/// `WG_PUBLISHERS`, validate `WorldOfWarships.exe`) and the Steam
/// `libraryfolders.vdf` + `appmanifest_<appid>.acf` parse. For now returns
/// whatever is pinned in `WOWSP_GAME_PATH`, or an empty list.
#[tauri::command]
pub fn detect_game_install() -> Vec<GameInstall> {
    let mut found = Vec::new();

    // 1. Env override (developer convenience + manual pin).
    if let Ok(p) = std::env::var("WOWSP_GAME_PATH") {
        if is_game_dir(&p) {
            found.push(GameInstall {
                kind: GameInstallKind::Manual,
                path: p,
                realm: None,
            });
        }
    }

    // 2. Registry scan (official / Lesta / 360). TODO(M1).
    found.extend(scan_registry_uninstall_keys());

    // 3. Steam scan. TODO(M1).
    found.extend(scan_steam_libraries());

    found
}

/// Pin a user-chosen path as the active install (no validation beyond the
/// exe existing).
#[tauri::command]
pub fn set_game_path(path: String) -> Result<GameInstall, String> {
    if !is_game_dir(&path) {
        return Err(format!(
            "{path} does not look like a World of Warships install (missing WorldOfWarships.exe)"
        ));
    }
    Ok(GameInstall {
        kind: GameInstallKind::Manual,
        path,
        realm: None,
    })
}

fn is_game_dir(path: &str) -> bool {
    PathBuf::from(path).join("WorldOfWarships.exe").is_file()
}

/// TODO(M1): walk HKCU + HKLM `...\Uninstall\*`, filter by `WG_PUBLISHERS`,
/// validate each `InstallLocation`. Returns empty for now.
fn scan_registry_uninstall_keys() -> Vec<GameInstall> {
    // Skeleton — the real implementation uses the `winreg` crate:
    //
    //   for hive in [HKCU, HKLM] {
    //       let uninstall = hive.open(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall")?;
    //       for sub in uninstall.enum_keys() {
    //           let key = uninstall.open(sub)?;
    //           let publisher = key.value("Publisher").unwrap_or_default();
    //           if !WG_PUBLISHERS.contains(&publisher.as_str()) { continue; }
    //           let loc = key.value("InstallLocation").unwrap_or_default();
    //           if is_game_dir(&loc) { found.push(...); }
    //       }
    //   }
    let _ = WG_PUBLISHERS;
    Vec::new()
}

/// TODO(M1): parse `<steam>/steamapps/libraryfolders.vdf`, then for each
/// library read `<lib>/steamapps/appmanifest_{STEAM_APPID}.acf`'s
/// `installdir`, and join `bin/<branch>/` to find the exe. Returns empty.
fn scan_steam_libraries() -> Vec<GameInstall> {
    let _ = STEAM_APPID;
    Vec::new()
}
