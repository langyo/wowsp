//! Game-install detection.
//!
//! Principle (adapted from ApeRadar `ConfigWindow.AutoDetectGamePath`):
//! scan the Windows Uninstall registry for known Wargaming-family publishers
//! (see [`PUBLISHER_PATTERNS`] — substring matching so the legacy KongZhong
//! CN client and publisher-string variants are covered too), read each
//! entry's `InstallLocation`, and accept it when `WorldOfWarships.exe` exists
//! there. WoWSP additionally walks Steam library folders for
//! `appmanifest_552990.acf` (Steam appid 552990 = World of Warships) — the
//! case ApeRadar does not cover. A user can also pin a manual path.
//!
//! All four distribution channels share the same on-disk layout
//! (`WorldOfWarships.exe` stub at the root, `bin/<build>/bin64/` game
//! binaries, `profile/`, `replays/`); only the launcher and the registry
//! publisher differ, so kind/realm resolution below leans on those two
//! signals plus the log-derived realm.

use std::path::PathBuf;

use wowsp_tauri_shared::{GameInstall, GameInstallKind};

/// Publisher substring patterns mapped to the install kind they identify.
/// Matched case-insensitively against the Windows Uninstall key's `Publisher`
/// value. Substring rather than exact equality (ApeRadar's approach): the
/// four distribution channels spell their publisher differently across
/// installer generations — the CN region registered "KongZhong …" / "空中网"
/// before 360 took over, and 360's own entries vary ("360.cn"), so an exact
/// list silently drops the legacy clients (user-reported: a KongZhong
/// install fell through to the running-process heuristic and got mislabeled).
const PUBLISHER_PATTERNS: &[(&str, GameInstallKind)] = &[
    ("wargaming", GameInstallKind::Wargaming),
    ("lesta", GameInstallKind::Lesta),
    ("kongzhong", GameInstallKind::CnKongzhong),
    ("空中网", GameInstallKind::CnKongzhong),
    ("360", GameInstallKind::Cn360),
];

/// Steam appid for World of Warships.
const STEAM_APPID: &str = "552990";

/// Auto-detect every World of Warships install on this machine: the
/// `WOWSP_GAME_PATH` env pin, then the Uninstall-registry walk
/// ([`scan_registry_uninstall_keys`], `HKCU` + `HKLM`
/// `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` filtered by
/// [`PUBLISHER_PATTERNS`]), then the Steam `libraryfolders.vdf` +
/// `appmanifest_<appid>.acf` parse ([`scan_steam_libraries`]).
/// Sync scan core — also used by internal callers (replay/arena dir
/// resolution) that cannot await.
pub(crate) fn scan_game_installs() -> Vec<GameInstall> {
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

    // 2. Registry scan (official / Lesta / 360 / legacy KongZhong).
    found.extend(scan_registry_uninstall_keys());

    // 3. Steam scan.
    found.extend(scan_steam_libraries());

    found
}

// Async so the registry + Steam scan runs on the Tauri async runtime — a
// sync command would execute it inline on the main/UI thread.
#[tauri::command]
pub async fn detect_game_install() -> Vec<GameInstall> {
    scan_game_installs()
}

/// Open a native folder picker and validate the choice as a WoWS install.
/// Returns `None` when the user cancels the dialog (not an error), and an
/// install (with realm, when clientrunner.log is present) on success.
///
/// The manual-location entry: the first-launch prompt and the ship-detail
/// error state both route here when auto-detection comes up empty.
#[tauri::command]
pub async fn pick_game_folder() -> Result<Option<GameInstall>, String> {
    // Mobile: no native folder picker (and no game install to point at) —
    // the first-launch flow uses a different entry on phones.
    #[cfg(mobile)]
    {
        return Err(crate::mobile_unsupported::PICKER.into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread.
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Select the World of Warships install folder")
                .pick_folder()
        })
        .await
        .map_err(|e| format!("文件夹选择器任务异常退出：{e}"))?;

        let Some(path) = picked else {
            return Ok(None);
        };
        let path = path.to_string_lossy().into_owned();
        validate_manual_path(&path).map(Some)
    }
}

/// Pin a user-chosen path as the active install (no validation beyond the
/// exe existing).
#[tauri::command]
pub async fn set_game_path(path: String) -> Result<GameInstall, String> {
    validate_manual_path(&path)
}

/// Shared validation for the picker + manual-path command: the folder must
/// contain `WorldOfWarships.exe`; realm is read from clientrunner.log when
/// available.
fn validate_manual_path(path: &str) -> Result<GameInstall, String> {
    if !is_game_dir(path) {
        return Err(format!(
            "所选目录不像《战舰世界》安装目录（缺少 WorldOfWarships.exe）：{path}"
        ));
    }
    Ok(GameInstall {
        kind: GameInstallKind::Manual,
        realm: detect_realm(&PathBuf::from(path)),
        path: path.to_string(),
    })
}

fn is_game_dir(path: &str) -> bool {
    PathBuf::from(path).join("WorldOfWarships.exe").is_file()
}

/// Walk HKCU + HKLM `...\Uninstall\*`, filter by `PUBLISHER_PATTERNS`, validate
/// each `InstallLocation`. Mirrors ApeRadar's `ConfigWindow.AutoDetectGamePath`
/// but matches publishers as substrings (see [`PUBLISHER_PATTERNS`]).
/// On Steam installs this yields nothing (Steam carries no WG publisher key) —
/// `scan_steam_libraries` covers that case.
// The pushes live in a windows-only block, so the binding is `mut` on Windows
// only (non-Windows keeps the function as an empty-result stub).
#[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
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
                    let Some(kind) = publisher_kind(&publisher) else {
                        continue;
                    };
                    let loc: String = key.get_value("InstallLocation").unwrap_or_default();
                    if is_game_dir(&loc) {
                        let root = PathBuf::from(&loc);
                        found.push(GameInstall {
                            kind: kind.clone(),
                            path: loc,
                            realm: detect_realm(&root).or_else(|| kind_fallback_realm(&kind)),
                        });
                    }
                }
            }
        }
    }
    found
}

/// Map a registry publisher string to a [`GameInstallKind`] (case-insensitive
/// substring match against [`PUBLISHER_PATTERNS`]; `None` = not a WG-family
/// publisher).
fn publisher_kind(publisher: &str) -> Option<GameInstallKind> {
    let lower = publisher.to_lowercase();
    PUBLISHER_PATTERNS
        .iter()
        .find(|(pat, _)| lower.contains(pat))
        .map(|(_, kind)| kind.clone())
}

/// Realm implied by the client kind alone, used when the install carries no
/// readable `profile/clientrunner.log` (the CN clients ship their own
/// launchers whose log spelling has never been verified against the
/// international client; a missing log must not leave the region unknown —
/// the CN/Lesta stat backends key on the realm). The log-derived realm always
/// wins when present.
pub(crate) fn kind_fallback_realm(kind: &GameInstallKind) -> Option<String> {
    match kind {
        GameInstallKind::Cn360 | GameInstallKind::CnKongzhong => Some("cn".to_string()),
        GameInstallKind::Lesta => Some("ru".to_string()),
        GameInstallKind::Wargaming | GameInstallKind::Steam | GameInstallKind::Manual => None,
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
/// Lower-cased defensively: every realm consumer (WG host resolution, the CN
/// vortex dispatch, encyclopedia cache keys) expects the canonical lowercase
/// code. Returns `None` when the log is missing/unreadable — the CN clients
/// (360 / legacy KongZhong) and Lesta ship their own launchers, so that log
/// is not guaranteed to exist for them; [`kind_fallback_realm`] fills those
/// gaps from the detected client kind.
/// `pub(crate)`: the process watcher also reads realms for synthesized
/// installs (running exe that no detected install claims).
pub(crate) fn detect_realm(game_root: &std::path::Path) -> Option<String> {
    let log = game_root.join("profile").join("clientrunner.log");
    let Ok(text) = std::fs::read_to_string(&log) else {
        return None;
    };
    text.lines()
        .rev()
        .find_map(|l| {
            l.split("Selected realm:")
                .nth(1)
                .map(|s| s.trim().to_lowercase())
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

    #[test]
    fn publisher_kind_covers_all_channels_and_variants() {
        // Canonical strings (ApeRadar's exact list) still map.
        assert_eq!(
            publisher_kind("Wargaming.net"),
            Some(GameInstallKind::Wargaming)
        );
        assert_eq!(
            publisher_kind("Wargaming Group Limited"),
            Some(GameInstallKind::Wargaming)
        );
        assert_eq!(publisher_kind("Lesta Games"), Some(GameInstallKind::Lesta));
        assert_eq!(publisher_kind("360.cn"), Some(GameInstallKind::Cn360));
        // Legacy / variant spellings the exact list used to drop.
        assert_eq!(
            publisher_kind("KongZhong Corporation"),
            Some(GameInstallKind::CnKongzhong)
        );
        assert_eq!(
            publisher_kind("kongzhong games"),
            Some(GameInstallKind::CnKongzhong)
        );
        assert_eq!(publisher_kind("空中网"), Some(GameInstallKind::CnKongzhong));
        // Case-insensitive on the ASCII forms.
        assert_eq!(publisher_kind("lesta games"), Some(GameInstallKind::Lesta));
        // Non-WG publishers are rejected (exact-match list had this for free).
        assert_eq!(publisher_kind("Valve Corporation"), None);
        assert_eq!(publisher_kind(""), None);
    }

    #[test]
    fn kind_fallback_realm_fills_cn_and_lesta_only() {
        assert_eq!(
            kind_fallback_realm(&GameInstallKind::Cn360).as_deref(),
            Some("cn")
        );
        assert_eq!(
            kind_fallback_realm(&GameInstallKind::CnKongzhong).as_deref(),
            Some("cn")
        );
        assert_eq!(
            kind_fallback_realm(&GameInstallKind::Lesta).as_deref(),
            Some("ru")
        );
        // International clients have no kind-implied realm: the log decides.
        assert_eq!(kind_fallback_realm(&GameInstallKind::Wargaming), None);
        assert_eq!(kind_fallback_realm(&GameInstallKind::Steam), None);
        assert_eq!(kind_fallback_realm(&GameInstallKind::Manual), None);
    }

    /// `detect_realm` reads the last `Selected realm:` line, lower-cased, from
    /// `<root>/profile/clientrunner.log`; missing log → None.
    #[test]
    fn detect_realm_reads_last_line_and_falls_back_to_none() {
        let root = std::env::temp_dir().join(format!(
            "wowsp-test-realm-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let profile = root.join("profile");
        std::fs::create_dir_all(&profile).unwrap();

        // No log yet.
        assert_eq!(detect_realm(&root), None);

        let log = profile.join("clientrunner.log");
        std::fs::write(
            &log,
            "2026-09-18 10:00:00 [INFO] Starting\n\
             Selected realm: ASIA\n\
             2026-09-18 10:01:00 restarting\n\
             Selected realm: CN\n",
        )
        .unwrap();
        assert_eq!(detect_realm(&root).as_deref(), Some("cn"));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
