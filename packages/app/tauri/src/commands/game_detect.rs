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

/// Walk HKCU + HKLM `...\Uninstall\*`, filter by `WG_PUBLISHERS`, validate
/// each `InstallLocation`. Mirrors ApeRadar's `ConfigWindow.AutoDetectGamePath`.
/// On Steam installs this yields nothing (Steam carries no WG publisher key) —
/// `scan_steam_libraries` covers that case.
fn scan_registry_uninstall_keys() -> Vec<GameInstall> {
    let mut found = Vec::new();
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        for hive in [
            RegKey::predef(HKEY_CURRENT_USER),
            RegKey::predef(HKEY_LOCAL_MACHINE),
        ] {
            for path in [
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ] {
                let Ok(uninstall) = hive.open_subkey(path) else {
                    continue;
                };
                for sub in uninstall.enum_keys().flatten() {
                    let Ok(key) = uninstall.open_subkey(&sub) else {
                        continue;
                    };
                    let publisher: String = key.get_value("Publisher").unwrap_or_default();
                    if !WG_PUBLISHERS.contains(&publisher.as_str()) {
                        continue;
                    }
                    let loc: String = key.get_value("InstallLocation").unwrap_or_default();
                    if is_game_dir(&loc) {
                        let root = PathBuf::from(&loc);
                        found.push(GameInstall {
                            kind: publisher_kind(&publisher),
                            path: loc,
                            realm: detect_realm(&root),
                        });
                    }
                }
            }
        }
    }
    let _ = WG_PUBLISHERS;
    found
}

/// Map a registry publisher string to a [`GameInstallKind`].
fn publisher_kind(publisher: &str) -> GameInstallKind {
    if publisher.contains("360") {
        GameInstallKind::Cn360
    } else if publisher.contains("Lesta") {
        GameInstallKind::Lesta
    } else {
        GameInstallKind::Wargaming
    }
}

/// Parse Steam's `libraryfolders.vdf` + `appmanifest_{STEAM_APPID}.acf` to
/// locate a Steam-installed World of Warships. The Steam app carries no
/// Wargaming publisher registry entry, so this is the only way to detect it.
fn scan_steam_libraries() -> Vec<GameInstall> {
    let mut found = Vec::new();
    // 1. Find the Steam install + every library root from libraryfolders.vdf.
    let Some(libs) = steam_library_roots() else {
        return found;
    };
    for lib in libs {
        // 2. Each library's steamapps/ may hold the appmanifest.
        let manifest = lib
            .join("steamapps")
            .join(format!("appmanifest_{STEAM_APPID}.acf"));
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        // 3. installdir is a quoted value in the .acf; join under common/.
        let Some(install_dir) = vdf_value(&text, "installdir") else {
            continue;
        };
        let game_root = lib.join("steamapps").join("common").join(&install_dir);
        let exe = game_root.join("WorldOfWarships.exe");
        if !exe.is_file() {
            continue;
        }
        found.push(GameInstall {
            kind: GameInstallKind::Steam,
            path: game_root.to_string_lossy().into_owned(),
            realm: detect_realm(&game_root),
        });
    }
    found
}

/// Discover Steam library roots by parsing `libraryfolders.vdf`. Looks for the
/// Steam install under the well-known Windows locations, then enumerates every
/// `"path"` entry in the vdf.
fn steam_library_roots() -> Option<Vec<PathBuf>> {
    let steam = resolve_steam_install()?;
    let vdf = steam.join("steamapps").join("libraryfolders.vdf");
    let Ok(text) = std::fs::read_to_string(&vdf) else {
        return Some(vec![steam]);
    };
    // The vdf lists each library under `"N" { "path" "..." }`. Pull every
    // quoted `"path"` value.
    let mut roots = vec![steam];
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"path\"") {
            let val = rest
                .trim_start()
                .trim_start_matches('\t')
                .trim_matches('"')
                .replace("\\\\", "\\");
            if !val.is_empty() {
                roots.push(PathBuf::from(val));
            }
        }
    }
    Some(roots)
}

/// Locate the Steam install. Well-known Windows paths first; falls back to the
/// `SteamPath` registry value under `HKCU\Software\Valve\Steam`.
fn resolve_steam_install() -> Option<PathBuf> {
    for candidate in [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"] {
        let p = PathBuf::from(candidate);
        if p.join("steamapps").is_dir() {
            return Some(p);
        }
    }
    // Registry fallback.
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(val) = hkcu
            .open_subkey("Software\\Valve\\Steam")
            .and_then(|k| k.get_value::<String, _>("SteamPath"))
        {
            let p = PathBuf::from(val);
            if p.join("steamapps").is_dir() {
                return Some(p);
            }
        }
    }
    None
}

/// Read the last `Selected realm: <x>` line from the game's
/// `profile/clientrunner.log` (same logic as ApeRadar's `Server.AutoDetectServer`).
fn detect_realm(game_root: &std::path::Path) -> Option<String> {
    let log = game_root.join("profile").join("clientrunner.log");
    let Ok(text) = std::fs::read_to_string(&log) else {
        return None;
    };
    text.lines()
        .rev()
        .find_map(|l| {
            l.split("Selected realm:")
                .nth(1)
                .map(|s| s.trim().to_owned())
        })
        .filter(|s| !s.is_empty())
}

/// A toy VDF value reader: finds `"key"\t"value"` and returns the value. Good
/// enough for appmanifest.acf / libraryfolders.vdf which use the simple subset.
fn vdf_value(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&needle) {
            let val = rest.trim_start().trim_matches('"');
            if !val.is_empty() {
                return Some(val.replace("\\\\", "\\"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_steam_install_on_this_machine() {
        let installs = scan_steam_libraries();
        if installs.is_empty() {
            eprintln!("[steam-scan] no Steam WOWS install on this machine — ok");
            return;
        }
        for i in &installs {
            eprintln!(
                "[steam-scan] found {:?}: {} (realm {:?})",
                i.kind, i.path, i.realm
            );
        }
        // The one we expect on the dev machine:
        assert!(
            installs
                .iter()
                .any(|i| i.path.ends_with("World of Warships") && i.kind == GameInstallKind::Steam),
            "expected a Steam WOWS install ending in 'World of Warships'"
        );
        // Realm must be detected from clientrunner.log.
        assert!(
            installs.iter().any(|i| i.realm.as_deref() == Some("asia")),
            "expected realm=asia from clientrunner.log"
        );
    }

    #[test]
    fn vdf_value_extracts_quoted() {
        let acf = "\"AppState\"\n{\n\"installdir\"\t\t\"World of Warships\"\n}";
        assert_eq!(
            vdf_value(acf, "installdir").as_deref(),
            Some("World of Warships")
        );
    }
}
