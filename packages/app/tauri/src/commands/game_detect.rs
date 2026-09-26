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
//!
//! The sources overlap — a WGC uninstall entry can carry the Steam library's
//! path (WGC adopts Steam installs), the Steam vdf repeats its own root, and
//! one product can register in both registry hives — so every scan ends in
//! [`dedupe_installs`]: one row per real folder, keyed on a
//! case-insensitive normalized path ([`install_path_key`]).

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

    // 4. One row per folder — the sources overlap (see the module docs), and
    // the settings list keys rows by path, so duplicates would render as two
    // "in use" cards for the same directory.
    dedupe_installs(found)
}

/// Case-, separator- and trailing-slash-insensitive identity of an install
/// path. The same folder reaches us under several spellings (registry values
/// keep the installer's casing and trailing `\`, Steam's vdf uses the
/// library's), and Windows filesystems are case-insensitive. Shared with the
/// unified game context for its folder comparisons.
pub(crate) fn install_path_key(path: &str) -> String {
    normalize_path_seps(path).to_lowercase()
}

/// Path with backslash separators and no trailing separator, original casing
/// kept (display/storage-safe; [`install_path_key`] lowercases on top of it).
/// A trimmed drive root keeps its separator so it stays absolute.
fn normalize_path_seps(path: &str) -> String {
    let mut p = path.replace('/', "\\");
    while p.ends_with('\\') {
        p.pop();
    }
    if !p.contains('\\') && p.ends_with(':') {
        p.push('\\');
    }
    p
}

/// Which entry survives when several sources report the same folder. The env
/// pin is the user's explicit choice and always wins; a folder under a Steam
/// library is labelled Steam even when a WGC uninstall entry claims it (WGC
/// registers Steam-managed installs — the phantom 官服 row users saw next to
/// the Steam one); registry-derived kinds follow in channel order.
fn kind_priority(kind: &GameInstallKind) -> u8 {
    match kind {
        GameInstallKind::Manual => 5,
        GameInstallKind::Steam => 4,
        GameInstallKind::Wargaming => 3,
        GameInstallKind::Lesta => 2,
        GameInstallKind::Cn360 | GameInstallKind::CnKongzhong => 1,
    }
}

/// Collapse installs that resolved to the same folder (see
/// [`kind_priority`] for who wins; ties keep first-seen order). The winner
/// inherits a duplicate's realm when it lacks one — same folder means the
/// same `clientrunner.log`, so a duplicate's log-derived realm is strictly
/// better information than nothing.
fn dedupe_installs(installs: Vec<GameInstall>) -> Vec<GameInstall> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out: Vec<GameInstall> = Vec::with_capacity(installs.len());
    for install in installs {
        let key = install_path_key(&install.path);
        match seen.get(&key) {
            Some(&idx) => {
                let kept = &mut out[idx];
                if kind_priority(&install.kind) > kind_priority(&kept.kind) {
                    let old_realm = kept.realm.take();
                    // The winner's whole identity takes over — kind, path
                    // spelling (the registry's trailing `\` loses to the
                    // Steam scan's clean form) and realm.
                    kept.kind = install.kind;
                    kept.path = install.path;
                    kept.realm = install.realm.or(old_realm);
                } else if kept.realm.is_none() {
                    kept.realm = install.realm;
                }
            },
            None => {
                seen.insert(key, out.len());
                out.push(install);
            },
        }
    }
    out
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

/// Does the folder look like a WoWS install root (stub exe present)? Shared
/// with the unified game context, which validates every candidate root.
pub(crate) fn is_game_dir(path: &str) -> bool {
    PathBuf::from(path).join("WorldOfWarships.exe").is_file()
}

/// Walk HKCU + HKLM `...\Uninstall\*`, filter by `PUBLISHER_PATTERNS`, and
/// resolve each entry's install folder ([`uninstall_dir_candidates`], then the
/// `WorldOfWarships.exe` check). Mirrors ApeRadar's
/// `ConfigWindow.AutoDetectGamePath` but matches publishers as substrings (see
/// [`PUBLISHER_PATTERNS`]) and survives entries whose `InstallLocation` the
/// installer left empty. On Steam installs this usually yields nothing (Steam
/// carries no WG publisher key) — `scan_steam_libraries` covers that case;
/// when WGC *does* register the Steam folder, the `steamapps\common` relabel
/// keeps it from masquerading as a second 官服 install.
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
                    let location: String = key.get_value("InstallLocation").unwrap_or_default();
                    let display_icon: String = key.get_value("DisplayIcon").unwrap_or_default();
                    let uninstall_string: String =
                        key.get_value("UninstallString").unwrap_or_default();
                    for dir in uninstall_dir_candidates(&location, &display_icon, &uninstall_string)
                    {
                        // Store the trimmed-spelling form (registry values
                        // often carry a trailing `\`); same folder either way.
                        let dir = normalize_path_seps(&dir);
                        if !is_game_dir(&dir) {
                            continue;
                        }
                        // A WG-registered folder under a Steam library is the
                        // Steam client (WGC adopts Steam installs) — label it
                        // Steam so the list doesn't show a phantom 官服 row
                        // next to the real Steam one.
                        let kind = if install_path_key(&dir).contains("steamapps\\common") {
                            GameInstallKind::Steam
                        } else {
                            kind.clone()
                        };
                        found.push(GameInstall {
                            realm: detect_realm(std::path::Path::new(&dir))
                                .or_else(|| kind_fallback_realm(&kind)),
                            kind,
                            path: dir,
                        });
                        break;
                    }
                }
            }
        }
    }
    found
}

/// Candidate install folders from one Uninstall key, best signal first:
/// `InstallLocation`, then `DisplayIcon`, then `UninstallString`. Installers
/// in the wild sometimes leave `InstallLocation` empty (or one level off the
/// real folder) while the icon / uninstall strings still name the game
/// directory — falling back through the trio recovers those installs instead
/// of dropping them (user-reported misses). Duplicates are removed; every
/// candidate still has to pass the caller's `WorldOfWarships.exe` check.
fn uninstall_dir_candidates(
    install_location: &str,
    display_icon: &str,
    uninstall_string: &str,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: String| {
        // Distinctness by normalized key: the same folder with and without a
        // trailing separator must not survive as two candidates.
        let key = install_path_key(&v);
        if !key.is_empty() && !out.iter().any(|e| install_path_key(e) == key) {
            out.push(v);
        }
    };
    // 1. InstallLocation — used verbatim.
    let location = install_location.trim();
    if !location.is_empty() {
        push(location.to_string());
    }
    // 2. DisplayIcon — points at the game's exe or icon.
    if let Some(dir) = registry_entry_dir(display_icon) {
        push(dir);
    }
    // 3. UninstallString — msiexec lines carry no folder of their own.
    let unins = uninstall_string.trim();
    if !unins.is_empty() && !unins.to_lowercase().starts_with("msiexec") {
        if let Some(dir) = registry_entry_dir(unins) {
            push(dir);
        }
    }
    out
}

/// Interpret an Uninstall-key string (`DisplayIcon` / `UninstallString`) as a
/// folder: strip quotes and the `,-<index>` icon-index suffix, and step up one
/// level when the value names an executable. `None` when nothing folder-shaped
/// remains (bare filenames, drive roots).
fn registry_entry_dir(value: &str) -> Option<String> {
    let v = value.trim();
    // Quoted form with trailing arguments (`"C:\...\unins000.exe" /SILENT`):
    // cut at the closing quote first, or the argument tail makes the whole
    // value fail the exe/folder checks below.
    let v = if let Some(rest) = v.strip_prefix('"') {
        match rest.find('"') {
            Some(i) => &rest[..i],
            None => rest,
        }
    } else {
        v
    };
    let v = v.trim_matches('"');
    // Drop the icon-index suffix (`,0` / `,-1`): cut at the last comma whose
    // remainder parses as a number.
    let v = match v.rfind(',') {
        Some(i) if v[i + 1..].trim_start().parse::<i32>().is_ok() => &v[..i],
        _ => v,
    };
    let v = v.trim().trim_matches('"');
    if !v.contains('\\') {
        return None;
    }
    let lower = v.to_lowercase();
    if lower.ends_with(".exe") || lower.ends_with(".ico") {
        let i = v.rfind('\\')?;
        let dir = &v[..i];
        // `C:\file.exe` steps up to the bare drive — not a folder we accept.
        if !dir.contains('\\') {
            return None;
        }
        Some(dir.to_string())
    } else {
        Some(v.to_string())
    }
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
    let text = std::fs::read_to_string(&vdf).ok();
    Some(steam_library_roots_from_vdf(steam, text.as_deref()))
}

/// Pure core of [`steam_library_roots`]: the Steam install itself plus every
/// distinct `"path"` in the vdf text (`None` text = unreadable vdf → root
/// only). Distinctness is keyed on [`install_path_key`] — Steam's own vdf
/// repeats the install root as entry `"0"`, and some setups list one library
/// twice, which used to scan the same library twice and emit duplicate Steam
/// rows.
fn steam_library_roots_from_vdf(steam: PathBuf, vdf: Option<&str>) -> Vec<PathBuf> {
    let mut roots = vec![steam];
    let Some(text) = vdf else {
        return roots;
    };
    let mut seen: Vec<String> = roots
        .iter()
        .map(|r| install_path_key(&r.to_string_lossy()))
        .collect();
    // The vdf lists each library under `"N" { "path" "..." }`. Pull every
    // quoted `"path"` value.
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"path\"") {
            let val = rest
                .trim_start()
                .trim_start_matches('\t')
                .trim_matches('"')
                .replace("\\\\", "\\");
            if val.is_empty() {
                continue;
            }
            let key = install_path_key(&val);
            if !seen.contains(&key) {
                seen.push(key);
                roots.push(PathBuf::from(val));
            }
        }
    }
    roots
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

    /// `install_path_key` is the dedupe identity: case-, separator- and
    /// trailing-slash-insensitive.
    #[test]
    fn install_path_key_normalizes_case_and_separators() {
        assert_eq!(
            install_path_key("C:\\Games\\World of Warships\\"),
            install_path_key("c:/games/world of warships")
        );
        // A bare drive root keeps its separator (normalize_path_seps must not
        // turn `C:\` into the relative `C:`).
        assert_eq!(install_path_key("C:\\"), "c:\\");
    }

    /// Regression for the duplicate-rows screenshot: the same Steam folder
    /// reported by the WGC uninstall entry (trailing `\`, installer casing)
    /// and twice by the Steam scan collapses into one row, labelled Steam,
    /// keeping first-seen order and inheriting the log-derived realm.
    #[test]
    fn dedupe_installs_collapses_same_folder_and_prefers_steam() {
        let wow = r"C:\Program Files (x86)\Steam\steamapps\common\World of Warships";
        let installs = vec![
            GameInstall {
                kind: GameInstallKind::Manual,
                path: r"D:\Games\WoWS".to_string(),
                realm: None,
            },
            // Registry entry: installer casing + trailing separator.
            GameInstall {
                kind: GameInstallKind::Wargaming,
                path: format!("{wow}\\"),
                realm: Some("asia".to_string()),
            },
            // Steam scan: the same folder, its own casing.
            GameInstall {
                kind: GameInstallKind::Steam,
                path: wow.to_string(),
                realm: Some("asia".to_string()),
            },
            // Duplicate Steam root (lowercased variant spelling).
            GameInstall {
                kind: GameInstallKind::Steam,
                path: wow.to_lowercase(),
                realm: None,
            },
        ];
        let out = dedupe_installs(installs);
        assert_eq!(out.len(), 2);
        // First-seen order preserved (env pin first).
        assert_eq!(out[0].kind, GameInstallKind::Manual);
        assert_eq!(out[0].path, r"D:\Games\WoWS");
        // Steam wins the colliding folder; the trailing separator is gone.
        assert_eq!(out[1].kind, GameInstallKind::Steam);
        assert_eq!(out[1].path, wow);
        assert_eq!(out[1].realm.as_deref(), Some("asia"));
    }

    /// A duplicate's realm fills the winner in when the winner has none
    /// (same folder → same clientrunner.log, so the info is free).
    #[test]
    fn dedupe_installs_inherits_realm_from_duplicate() {
        let installs = vec![
            GameInstall {
                kind: GameInstallKind::Wargaming,
                path: r"C:\Games\WoWS".to_string(),
                realm: None,
            },
            GameInstall {
                kind: GameInstallKind::Lesta,
                path: r"c:\games\wows".to_string(),
                realm: Some("ru".to_string()),
            },
        ];
        let out = dedupe_installs(installs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, GameInstallKind::Wargaming);
        assert_eq!(out[0].realm.as_deref(), Some("ru"));
    }

    /// Registry folder resolution: `InstallLocation` first; `DisplayIcon`
    /// (with icon-index suffix + exe step-up) and `UninstallString` (msiexec
    /// skipped) recover entries with an empty location.
    #[test]
    fn uninstall_dir_candidates_falls_through_the_trio() {
        // Empty InstallLocation → DisplayIcon then UninstallString, deduped.
        assert_eq!(
            uninstall_dir_candidates(
                "",
                r#""C:\Games\WoW\WorldOfWarships.exe",-1"#,
                r#""C:\Games\WoW\unins000.exe""#,
            ),
            vec![r"C:\Games\WoW".to_string()]
        );
        // InstallLocation wins and is used verbatim (trailing sep kept —
        // is_game_dir tolerates it).
        assert_eq!(
            uninstall_dir_candidates(r"C:\Games\WoW\", "", r#""C:\Games\WoW\unins000.exe""#),
            vec![r"C:\Games\WoW\".to_string()]
        );
        // msiexec uninstallers carry no folder.
        assert_eq!(
            uninstall_dir_candidates(
                "",
                "",
                "MsiExec.exe /I{1234ABCD-0000-0000-0000-000000000000}"
            ),
            Vec::<String>::new()
        );
    }

    /// `registry_entry_dir` strips quotes, the `,-N` icon-index suffix, and
    /// steps up from exe/icon files; bare filenames and drive roots are
    /// rejected.
    #[test]
    fn registry_entry_dir_strips_quotes_suffixes_and_exes() {
        assert_eq!(
            registry_entry_dir(r#""C:\Games\WoW\WorldOfWarships.exe",-1"#).as_deref(),
            Some(r"C:\Games\WoW")
        );
        // Quoted uninstaller with trailing arguments — cut at the closing
        // quote, then step up from the exe.
        assert_eq!(
            registry_entry_dir(r#""C:\Games\WoW\unins000.exe" /SILENT"#).as_deref(),
            Some(r"C:\Games\WoW")
        );
        assert_eq!(
            registry_entry_dir(r"C:\Games\WoW\game.ico").as_deref(),
            Some(r"C:\Games\WoW")
        );
        assert_eq!(
            registry_entry_dir(r#""C:\Games\WoW""#).as_deref(),
            Some(r"C:\Games\WoW")
        );
        assert_eq!(registry_entry_dir(r"C:\file.exe"), None);
        assert_eq!(registry_entry_dir("unins000.exe"), None);
        assert_eq!(registry_entry_dir(""), None);
    }

    /// Steam's vdf repeats the install root as entry `"0"` and some setups
    /// list one library twice — the root list must come out distinct, Steam
    /// root first.
    #[test]
    fn steam_library_roots_dedupes_vdf_paths() {
        let vdf = "\"libraryfolders\"\n\
                   {\n\
                   \t\"0\"\n\
                   \t{\n\
                   \t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\
                   \t},\n\
                   \t\"1\"\n\
                   \t{\n\
                   \t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\
                   \t},\n\
                   \t\"2\"\n\
                   \t{\n\
                   \t\t\"path\"\t\t\"d:\\\\steamlibrary\"\n\
                   \t}\n\
                   }";
        let roots =
            steam_library_roots_from_vdf(PathBuf::from(r"C:\Program Files (x86)\Steam"), Some(vdf));
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0], PathBuf::from(r"C:\Program Files (x86)\Steam"));
        assert_eq!(roots[1], PathBuf::from(r"D:\SteamLibrary"));
        // Unreadable vdf → just the Steam root.
        let roots =
            steam_library_roots_from_vdf(PathBuf::from(r"C:\Program Files (x86)\Steam"), None);
        assert_eq!(roots.len(), 1);
    }
}
