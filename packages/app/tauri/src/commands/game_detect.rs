//! Game-install detection.
//!
//! Principle (adapted from ApeRadar `ConfigWindow.AutoDetectGamePath`):
//! scan the Windows Uninstall registry for known Wargaming-family publishers
//! (see [`PUBLISHER_PATTERNS`] — substring matching so the legacy KongZhong
//! CN client and publisher-string variants are covered too), read each
//! entry's `InstallLocation`, and accept it when a root stub exe from
//! [`GAME_ROOT_STUBS`] exists there. WoWSP additionally walks Steam library
//! folders for `appmanifest_552990.acf` (Steam appid 552990 = World of
//! Warships) and reads Lesta Game Center's own bookkeeping under
//! `%ProgramData%\Lesta\GameCenter` ([`scan_lesta_game_center`]) — the two
//! cases ApeRadar does not cover. A user can also pin a manual path.
//!
//! All distribution channels share the same on-disk layout (a root stub exe,
//! `bin/<build>/bin64/` game binaries, `profile/`, `replays/`); only the
//! launcher, the stub's name (the Lesta client renamed theirs to
//! `Korabli.exe` when Lesta Games split from Wargaming) and the registry
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

/// Root stub executables that identify a WoWS install folder. The Lesta
/// (Мир кораблей) client kept the WG on-disk layout but renamed the stub to
/// `Korabli.exe` when Lesta Games split from Wargaming — its 64-bit game
/// binary is `bin/<build>/bin64/Korabli64.exe` where the WG builds keep
/// `WorldOfWarships.exe` / `WorldOfWarships64.exe`. Any one hit makes the
/// folder a game root.
const GAME_ROOT_STUBS: &[&str] = &["WorldOfWarships.exe", "Korabli.exe"];

/// Auto-detect every World of Warships install on this machine: the
/// `WOWSP_GAME_PATH` env pin, then the Uninstall-registry walk
/// ([`scan_registry_uninstall_keys`], `HKCU` + `HKLM`
/// `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` filtered by
/// [`PUBLISHER_PATTERNS`]), then Lesta Game Center's own game index
/// ([`scan_lesta_game_center`]), then the Steam `libraryfolders.vdf` +
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

    // 3. Lesta Game Center's own game index — the Uninstall walk above only
    //    catches a Lesta install when its (optional) uninstall entry exists
    //    and is well-formed; LGC's preferences.xml / apps files always are.
    found.extend(scan_lesta_game_center());

    // 4. Steam scan.
    found.extend(scan_steam_libraries());

    // 5. One row per folder — the sources overlap (see the module docs), and
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
    let installs = scan_game_installs();
    // Logged at the command (not inside the sync core) so internal callers
    // resolving replay/arena dirs don't spam the log with repeated scans.
    tracing::info!(count = installs.len(), "game install scan complete");
    for install in &installs {
        tracing::debug!(kind = ?install.kind, realm = ?install.realm, path = %install.path, "game install detected");
    }
    installs
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
    let install = validate_manual_path(&path)?;
    tracing::info!(path = %install.path, kind = ?install.kind, "game path pinned manually");
    Ok(install)
}

/// Shared validation for the picker + manual-path command: the folder must
/// contain a root stub exe ([`GAME_ROOT_STUBS`]); realm is read from
/// clientrunner.log when available.
fn validate_manual_path(path: &str) -> Result<GameInstall, String> {
    if !is_game_dir(path) {
        return Err(format!(
            "所选目录不像《战舰世界》安装目录（缺少 WorldOfWarships.exe，莱服客户端为 Korabli.exe）：{path}"
        ));
    }
    Ok(GameInstall {
        kind: GameInstallKind::Manual,
        realm: detect_realm(&PathBuf::from(path)),
        path: path.to_string(),
    })
}

/// Does the folder look like a WoWS install root (a stub exe from
/// [`GAME_ROOT_STUBS`] present)? Shared with the unified game context,
/// which validates every candidate root.
pub(crate) fn is_game_dir(path: &str) -> bool {
    let dir = PathBuf::from(path);
    GAME_ROOT_STUBS.iter().any(|exe| dir.join(exe).is_file())
}

/// Walk HKCU + HKLM `...\Uninstall\*`, filter by `PUBLISHER_PATTERNS`, and
/// resolve each entry's install folder ([`uninstall_dir_candidates`], then the
/// [`is_game_dir`] stub check). Mirrors ApeRadar's
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
                        let kind = registry_folder_kind(&dir, kind);
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

/// Kind of a registry-resolved install folder. Two overrides on top of the
/// publisher-derived kind: a folder under a Steam library is the Steam
/// client (WGC adopts Steam installs — label it Steam so the list doesn't
/// show a phantom 官服 row next to the real Steam one), and a Korabli-only
/// root is the Lesta build no matter which channel registered it (the
/// RU/CIS Steam region serves that build; [`kind_priority`] ranks Steam
/// above Lesta, so this relabel — not dedupe — is what keeps the row's
/// realm fallback on `ru`).
fn registry_folder_kind(dir: &str, publisher_kind: GameInstallKind) -> GameInstallKind {
    if lesta_build_dir(std::path::Path::new(dir)) {
        GameInstallKind::Lesta
    } else if install_path_key(dir).contains("steamapps\\common") {
        GameInstallKind::Steam
    } else {
        publisher_kind
    }
}

/// Candidate install folders from one Uninstall key, best signal first:
/// `InstallLocation`, then `DisplayIcon`, then `UninstallString`. Installers
/// in the wild sometimes leave `InstallLocation` empty (or one level off the
/// real folder) while the icon / uninstall strings still name the game
/// directory — falling back through the trio recovers those installs instead
/// of dropping them (user-reported misses). Duplicates are removed; every
/// candidate still has to pass the caller's stub-exe check.
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
        .map(|(_, kind)| *kind)
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

// ── Lesta Game Center ───────────────────────────────────────────────────────

/// Detect installs managed by Lesta Game Center (LGC — the launcher Lesta
/// Games built from WGC's code when it took over the RU realm; same
/// `%ProgramData%\…\GameCenter` data layout). LGC does not reliably expose
/// the game folder through the Windows Uninstall hive (its `LGC-*` entries
/// are optional and shaped around the launcher's own uninstaller), so read
/// the launcher's own bookkeeping instead — verified against a real LGC
/// install:
///
/// * `preferences.xml` — one `<working_dir>` per `<game>` under
///   `<games_manager>`, plus `<current_game>` / `<active_game>` pointers;
/// * `apps\<game-id>\<hash>` — one-line files mirroring each managed game's
///   install root (`mk.ru.production` = Мир кораблей, the WoWS RU client).
///
/// The index lists every Lesta game (Мир танков too), so every candidate
/// still passes [`is_game_dir`] — only the Korabli-named WoWS root survives.
fn scan_lesta_game_center() -> Vec<GameInstall> {
    let Some(center) = std::env::var_os("PROGRAMDATA")
        .map(|base| PathBuf::from(base).join("Lesta").join("GameCenter"))
    else {
        return Vec::new();
    };
    scan_lesta_game_center_at(&center)
}

/// Testable core of [`scan_lesta_game_center`] against an explicit LGC data
/// directory (the real one lives under the machine's `%ProgramData%`).
fn scan_lesta_game_center_at(center: &std::path::Path) -> Vec<GameInstall> {
    let mut candidates = Vec::new();
    if let Ok(xml) = std::fs::read_to_string(center.join("preferences.xml")) {
        candidates.extend(lgc_xml_dir_values(&xml));
    }
    candidates.extend(lgc_apps_paths(center));

    // The two indexes repeat the same folder (preferences.xml AND the apps
    // file both point at every managed game), so collapse here — the scan is
    // one source and must emit one row per folder.
    dedupe_installs(
        candidates
            .into_iter()
            .filter_map(|raw| {
                let dir = normalize_path_seps(raw.trim());
                is_game_dir(&dir).then(|| GameInstall {
                    realm: detect_realm(std::path::Path::new(&dir))
                        .or_else(|| kind_fallback_realm(&GameInstallKind::Lesta)),
                    kind: GameInstallKind::Lesta,
                    path: dir,
                })
            })
            .collect(),
    )
}

/// Install roots recorded in LGC's `preferences.xml`: every `<working_dir>`
/// (one per managed game) plus the `<current_game>` / `<active_game>`
/// pointers. Same folder in practice — the pointer survives even when a
/// `<game>` entry is pruned mid-reinstall — so distinctness is keyed on
/// [`install_path_key`] like every other multi-source candidate list.
fn lgc_xml_dir_values(xml: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |val: String| {
        let key = install_path_key(&val);
        if !key.is_empty() && !out.iter().any(|e| install_path_key(e) == key) {
            out.push(val);
        }
    };
    for tag in ["working_dir", "current_game", "active_game"] {
        for val in xml_tag_values(xml, tag) {
            push(val);
        }
    }
    out
}

/// LGC's per-game index: every managed game keeps a one-line file at
/// `apps\<game-id>\<hash>` whose content is the install root.
fn lgc_apps_paths(center: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(apps) = std::fs::read_dir(center.join("apps")) else {
        return out;
    };
    for game_dir in apps.flatten() {
        let Ok(entries) = std::fs::read_dir(game_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            // LGC writes a bare path with no newline; strip a possible BOM so
            // `D:\…` does not become `\u{feff}D:\…`.
            let line = text
                .lines()
                .next()
                .unwrap_or("")
                .trim_start_matches('\u{feff}')
                .trim();
            if !line.is_empty() {
                out.push(line.to_string());
            }
        }
    }
    out
}

/// A toy XML text extractor: the inner text of every `<tag>…</tag>`
/// occurrence. LGC's preferences.xml is machine-written flat XML where the
/// tags we read never nest or carry attributes, so no real parser is
/// warranted (same stance as [`vdf_value`]). Only `&amp;` is unescaped —
/// the one entity legal inside a Windows path.
fn xml_tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let body = &rest[start + open.len()..];
        let Some(end) = body.find(&close) else {
            break;
        };
        let val = body[..end].trim().replace("&amp;", "&");
        if !val.is_empty() {
            out.push(val);
        }
        rest = &body[end + close.len()..];
    }
    out
}

/// Parse Steam's `libraryfolders.vdf` + `appmanifest_{STEAM_APPID}.acf` to
/// locate a Steam-installed World of Warships. The Steam app carries no
/// Wargaming publisher registry entry, so this is the only way to detect it.
/// In the RU/CIS Steam region appid 552990 serves the Lesta build (Мир
/// кораблей, `Korabli.exe` stub) — those installs keep the Lesta kind so the
/// realm falls back to `ru` instead of the Steam kind's none.
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
        if !is_game_dir(&game_root.to_string_lossy()) {
            continue;
        }
        let kind = if lesta_build_dir(&game_root) {
            GameInstallKind::Lesta
        } else {
            GameInstallKind::Steam
        };
        found.push(GameInstall {
            realm: detect_realm(&game_root).or_else(|| kind_fallback_realm(&kind)),
            kind,
            path: game_root.to_string_lossy().into_owned(),
        });
    }
    found
}

/// A folder whose only root stub is `Korabli.exe` is a Lesta build of the
/// client — the RU/CIS Steam distribution and any LGC install. Used to keep
/// the Lesta kind (realm `ru`) on folders the Steam/registry scans found.
fn lesta_build_dir(dir: &std::path::Path) -> bool {
    dir.join("Korabli.exe").is_file() && !dir.join("WorldOfWarships.exe").is_file()
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

    /// Live-machine smoke test (the Lesta mirror of
    /// [`detects_steam_install_on_this_machine`]): prints what the LGC scan
    /// finds on this machine. Soft-passes when no Lesta install exists.
    #[test]
    fn lesta_game_center_scan_on_this_machine() {
        let installs = scan_lesta_game_center();
        if installs.is_empty() {
            eprintln!("[lgc-scan] no Lesta install on this machine — ok");
            return;
        }
        for i in &installs {
            eprintln!(
                "[lgc-scan] found {:?}: {} (realm {:?})",
                i.kind, i.path, i.realm
            );
        }
        assert!(
            installs
                .iter()
                .all(|i| i.kind == GameInstallKind::Lesta && i.realm.as_deref() == Some("ru")),
            "every LGC-sourced install carries the Lesta kind and realm ru"
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

    /// Unique-per-run scratch dir under the system temp root.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The Lesta (Мир кораблей) client renamed the root stub to
    /// `Korabli.exe` — a folder carrying only that exe must still validate as
    /// a game install (this rename is why Lesta installs went undetected).
    #[test]
    fn is_game_dir_accepts_the_lesta_renamed_stub() {
        let root = scratch_dir("lesta-stub");
        let path = root.to_string_lossy().into_owned();
        assert!(!is_game_dir(&path));
        std::fs::write(root.join("Korabli.exe"), b"stub").unwrap();
        assert!(is_game_dir(&path));

        let wg = scratch_dir("wg-stub");
        std::fs::write(wg.join("WorldOfWarships.exe"), b"stub").unwrap();
        assert!(is_game_dir(&wg.to_string_lossy()));

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&wg).unwrap();
    }

    /// `lesta_build_dir`: Korabli-only → Lesta build; either spelling with
    /// `WorldOfWarships.exe` present → not (a WG install that also carries
    /// stray Lesta files keeps its WG identity).
    #[test]
    fn lesta_build_dir_requires_korabli_without_the_wg_stub() {
        let lesta = scratch_dir("lesta-build");
        std::fs::write(lesta.join("Korabli.exe"), b"stub").unwrap();
        assert!(lesta_build_dir(&lesta));

        let wg = scratch_dir("wg-build");
        std::fs::write(wg.join("WorldOfWarships.exe"), b"stub").unwrap();
        assert!(!lesta_build_dir(&wg));

        let both = scratch_dir("both-stubs");
        std::fs::write(both.join("WorldOfWarships.exe"), b"stub").unwrap();
        std::fs::write(both.join("Korabli.exe"), b"stub").unwrap();
        assert!(!lesta_build_dir(&both));

        for d in [lesta, wg, both] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn xml_tag_values_extracts_every_occurrence() {
        let xml = "<games>\
                   <game><working_dir>D:\\Korabli</working_dir></game>\
                   <game><working_dir></working_dir></game>\
                   <game><working_dir>E:\\WoWS</working_dir></game>\
                   </games>\
                   <current_game>D:\\Korabli</current_game>";
        assert_eq!(
            xml_tag_values(xml, "working_dir"),
            vec![r"D:\Korabli".to_string(), r"E:\WoWS".to_string()]
        );
        assert_eq!(
            xml_tag_values(xml, "current_game"),
            vec![r"D:\Korabli".to_string()]
        );
        // Absent tags and unterminated ones yield nothing.
        assert!(xml_tag_values(xml, "selectedGames").is_empty());
        assert!(xml_tag_values("<working_dir>D:\\X", "working_dir").is_empty());
        // `&amp;` is unescaped (`&` is the one entity legal in a path).
        assert_eq!(
            xml_tag_values("<working_dir>D:\\A &amp; B</working_dir>", "working_dir"),
            vec![r"D:\A & B".to_string()]
        );
    }

    /// The registry relabel: a steamapps folder becomes Steam, a Korabli-only
    /// root becomes Lesta even under a steamapps path (RU/CIS Steam region),
    /// anything else keeps the publisher-derived kind.
    #[test]
    fn registry_folder_kind_relabels_steam_and_lesta_builds() {
        let base = scratch_dir("relabel");
        let steam_wg = base.join(r"SteamLibrary\steamapps\common\World of Warships");
        std::fs::create_dir_all(&steam_wg).unwrap();
        std::fs::write(steam_wg.join("WorldOfWarships.exe"), b"stub").unwrap();
        let lesta_root = base.join("Korabli");
        std::fs::create_dir_all(&lesta_root).unwrap();
        std::fs::write(lesta_root.join("Korabli.exe"), b"stub").unwrap();
        let lesta_under_steam = base.join(r"SteamLibrary\steamapps\common\Korabli");
        std::fs::create_dir_all(&lesta_under_steam).unwrap();
        std::fs::write(lesta_under_steam.join("Korabli.exe"), b"stub").unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();

        // Plain WG publisher entry, plain folder → keeps the publisher kind.
        assert_eq!(
            registry_folder_kind(&s(&base.join("plain")), GameInstallKind::Wargaming),
            GameInstallKind::Wargaming
        );
        // WG-registered Steam folder → Steam (the phantom-官服 fix).
        assert_eq!(
            registry_folder_kind(&s(&steam_wg), GameInstallKind::Wargaming),
            GameInstallKind::Steam
        );
        // Korabli-only root → Lesta — publisher kind irrelevant, and even
        // inside a Steam library.
        assert_eq!(
            registry_folder_kind(&s(&lesta_root), GameInstallKind::Lesta),
            GameInstallKind::Lesta
        );
        assert_eq!(
            registry_folder_kind(&s(&lesta_under_steam), GameInstallKind::Wargaming),
            GameInstallKind::Lesta
        );

        std::fs::remove_dir_all(&base).unwrap();
    }

    /// `<working_dir>` per game plus the current/active pointers collapse to
    /// one entry per distinct folder.
    #[test]
    fn lgc_xml_dir_values_merges_pointer_tags_without_duplicates() {
        let xml = "<games_manager><games>\
                   <game><working_dir>D:\\Korabli</working_dir></game>\
                   <game><working_dir>D:\\Games\\Korabli</working_dir></game>\
                   </games>\
                   <current_game>d:\\korabli\\</current_game>\
                   <active_game>D:\\Korabli</active_game></games_manager>";
        assert_eq!(
            lgc_xml_dir_values(xml),
            vec![r"D:\Korabli".to_string(), r"D:\Games\Korabli".to_string()]
        );
    }

    /// `apps\<game-id>\<hash>` files carry a bare install-root line each;
    /// empty/garbage files and missing dirs yield nothing.
    #[test]
    fn lgc_apps_paths_reads_one_line_path_files() {
        let center = scratch_dir("lgc-apps");
        let game = center.join("apps").join("mk.ru.production");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("d6a9e1b5beef"), "D:\\WoWS_Korabli").unwrap();
        std::fs::write(game.join("empty"), "").unwrap();
        let other = center.join("apps").join("wn.ru.production");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("aaa"), "D:\\Tanki\n").unwrap();

        // read_dir order is not contractual — compare as a sorted set.
        let mut paths = lgc_apps_paths(&center);
        paths.sort();
        assert_eq!(
            paths,
            vec![r"D:\Tanki".to_string(), r"D:\WoWS_Korabli".to_string()]
        );
        // No apps tree at all.
        assert!(lgc_apps_paths(&scratch_dir("lgc-no-apps")).is_empty());
        std::fs::remove_dir_all(&center).unwrap();
    }

    /// End-to-end LGC scan: preferences.xml + the apps index both point at a
    /// real Korabli-stub folder (realm falls back to `ru`); Lesta's other
    /// games (Мир танков) and dangling pointers are filtered out.
    #[test]
    fn scan_lesta_game_center_at_finds_korabli_root_and_skips_other_games() {
        let center = scratch_dir("lgc-center");
        let wows = scratch_dir("lgc-wows");
        let tanks = scratch_dir("lgc-tanks");
        std::fs::write(wows.join("Korabli.exe"), b"stub").unwrap();
        std::fs::write(tanks.join("Tanki.exe"), b"stub").unwrap();

        let wows_str = wows.to_string_lossy().into_owned();
        let tanks_str = tanks.to_string_lossy().into_owned();
        std::fs::write(
            center.join("preferences.xml"),
            format!(
                "<protocol name=\"preferences\" version=\"3.26\">\
                 <application><games_manager><games>\
                 <game><working_dir>{wows_str}</working_dir></game>\
                 <game><working_dir>{tanks_str}</working_dir></game>\
                 </games><current_game>{wows_str}</current_game></games_manager>\
                 </application></protocol>"
            ),
        )
        .unwrap();
        let apps = center.join("apps").join("mk.ru.production");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join("d6a9e1b5beef"), &wows_str).unwrap();
        // A dangling pointer (an uninstalled game) must be filtered out, not
        // panic the scan.
        let gone = center.join("apps").join("wt.ru.production");
        std::fs::create_dir_all(&gone).unwrap();
        std::fs::write(gone.join("deadbeef"), "D:\\Does\\Not\\Exist").unwrap();

        let installs = scan_lesta_game_center_at(&center);
        assert_eq!(installs.len(), 1, "only the Korabli-stub folder survives");
        assert_eq!(installs[0].kind, GameInstallKind::Lesta);
        assert_eq!(installs[0].path, wows_str);
        assert_eq!(installs[0].realm.as_deref(), Some("ru"));

        // An LGC dir with no bookkeeping at all is an empty result, not an
        // error.
        assert!(scan_lesta_game_center_at(&scratch_dir("lgc-empty")).is_empty());

        std::fs::remove_dir_all(&center).unwrap();
        std::fs::remove_dir_all(&wows).unwrap();
        std::fs::remove_dir_all(&tanks).unwrap();
    }
}
