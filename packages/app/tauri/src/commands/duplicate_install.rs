//! Duplicate-install hygiene (Windows): the pre-0.6.26 silent-update bug
//! could deliver a SECOND install to the pinned default location while
//! the player's real install lived elsewhere, and both copies stay on
//! the machine afterwards (the ARP entry names only whichever registered
//! last). This module detects that leftover through the same ARP entry —
//! `InstallLocation` pointing at a directory that is not the running
//! exe's own — and drives its cleanup: the webui asks once per launch
//! (unless told not to, see [`DuplicateInstallConfig`]) and this side
//! runs the leftover's own `uninstall.exe --silent --uninstall`, then
//! re-registers the RUNNING install and restores its launcher presence
//! (the uninstaller deletes the shared ARP key and the product's `.lnk`
//! files on its way out — the shun uninstaller only ever uninstalls the
//! directory it sits in and kills no processes, so the running app
//! itself is never touched).
//!
//! The detection deliberately reports only ARP-backed leftovers: the
//! running copy's own registration is not a duplicate, a registered
//! directory that no longer exists pins nothing, and a portable copy
//! coexisting with an installed one is a legitimate setup (the whole
//! lane is skipped in portable mode — as it is in debug builds, whose
//! exe lives in `target/`, never beside a real install).
//!
//! A registered location at a bare drive root, anywhere inside the game
//! tree, or with a game folder among its DIRECT children (a WoWSP parked
//! in a shared games root the game later installed into) is never
//! offered for removal either: the leftover's own `uninstall.exe` sweeps
//! the directory it sits in (the shun builds shipped before 0.6.30
//! swept it wholesale), so "cleaning up" such an install deletes the
//! game with it — exactly what hit players who once installed WoWSP
//! into the game folder and later installed elsewhere while the ARP
//! entry kept naming the game folder. The refusal lives in detection
//! AND is re-checked in the uninstall command itself.

use anyhow::{Result, anyhow, bail};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

use crate::paths;
use crate::settings_store::{self, SettingsSource};

/// The product identity the installer registered (shun.toml's `product`).
const PRODUCT: &str = "WoWSP";
/// The install manifest's `main-exe` — the file that makes a directory
/// look like a WoWSP install.
const MAIN_EXE: &str = "wowsp.exe";
/// The uninstaller shun drops beside the payload.
const UNINSTALLER: &str = "uninstall.exe";
/// The publisher the installer writes into ARP (shun.toml's `publisher`).
const PUBLISHER: &str = "langyo";

/// CREATE_NO_WINDOW: the spawned uninstaller must never flash a console.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const DUPLICATE_INSTALL_CONFIG_FILE: &str = "duplicate-install.toml";
/// No historical build ever persisted a JSON twin — the name exists only
/// so the shared load/heal plumbing keeps its two-file shape (it stays
/// NotFound forever, which every step treats as a no-op).
const LEGACY_DUPLICATE_INSTALL_CONFIG_FILE: &str = "duplicate-install.json";

/// Header prepended to the canonical config file (see network.rs's twin).
const FILE_HEADER: &str = "# WoWSP duplicate-install cleanup settings. promptEnabled = true | false.\n\
     # Invalid values are reset to the defaults by the app.\n";

/// The user-facing behavior switch: whether launches check for (and ask
/// about) a leftover install. The startup prompt's 不再提示 checkbox and
/// the settings section's toggle both write this one flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateInstallConfig {
    #[serde(default = "default_prompt_enabled")]
    pub prompt_enabled: bool,
}

fn default_prompt_enabled() -> bool {
    true
}

impl Default for DuplicateInstallConfig {
    fn default() -> Self {
        Self {
            prompt_enabled: true,
        }
    }
}

/// The on-disk shape (a dedicated struct only for the header discipline
/// the other config files follow).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateInstallConfigTomlFile {
    prompt_enabled: bool,
}

fn canonical_toml(config: &DuplicateInstallConfig) -> Result<String> {
    let file = DuplicateInstallConfigTomlFile {
        prompt_enabled: config.prompt_enabled,
    };
    let body =
        toml::to_string(&file).map_err(|e| anyhow!("serialize duplicate-install config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// Load the persisted config; a missing or unparsable file is simply the
/// default (the prompt stays on).
pub fn load_config() -> DuplicateInstallConfig {
    match paths::ensure_data_dir() {
        Ok(dir) => load_config_from(&dir),
        Err(_) => DuplicateInstallConfig::default(),
    }
}

fn load_config_from(dir: &Path) -> DuplicateInstallConfig {
    let loaded = settings_store::load_raw(
        dir,
        DUPLICATE_INSTALL_CONFIG_FILE,
        LEGACY_DUPLICATE_INSTALL_CONFIG_FILE,
    );
    let Some(raw) = loaded.raw else {
        return DuplicateInstallConfig::default();
    };
    // One tolerant parser per source format; a parse failure is just
    // another flavor of "invalid config" and lands on the default.
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<DuplicateInstallConfig>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<DuplicateInstallConfig>(&raw).ok()
        },
    };
    let config = parsed.unwrap_or_default();
    if let Ok(canonical) = canonical_toml(&config) {
        settings_store::heal(
            dir,
            DUPLICATE_INSTALL_CONFIG_FILE,
            LEGACY_DUPLICATE_INSTALL_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    config
}

#[tauri::command]
pub fn get_duplicate_install_config() -> CommandResult<DuplicateInstallConfig> {
    Ok(load_config())
}

#[tauri::command]
pub fn set_duplicate_install_config(
    config: DuplicateInstallConfig,
) -> CommandResult<DuplicateInstallConfig> {
    let dir = paths::ensure_data_dir()?;
    let canonical = canonical_toml(&config)?;
    settings_store::store(&dir, DUPLICATE_INSTALL_CONFIG_FILE, &canonical)?;
    settings_store::retire_legacy_json(&dir, LEGACY_DUPLICATE_INSTALL_CONFIG_FILE);
    tracing::info!(
        prompt_enabled = config.prompt_enabled,
        "duplicate-install config saved"
    );
    Ok(config)
}

// ── Detection ─────────────────────────────────────────────────────────────

/// A leftover install the webui may offer to remove.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateInstall {
    /// The registered install location (absolute).
    pub path: String,
    /// The ARP DisplayVersion of that install, when it recorded one.
    pub version: Option<String>,
    /// Whether `<path>\uninstall.exe` exists — without it the automatic
    /// removal cannot run and the UI degrades to showing the path.
    pub has_uninstaller: bool,
}

/// One ARP registration of the product: the location it names plus the
/// metadata the dialog shows.
#[derive(Debug, Clone, PartialEq)]
struct RegisteredInstall {
    location: String,
    version: Option<String>,
    /// True when the entry lives under HKLM (machine-scope install); the
    /// re-registration after a cleanup writes the same hive.
    machine: bool,
}

/// The ARP subkey path the installer registers the product under (the
/// same layout shun writes; product names with `\` cannot occur here).
fn arp_key(product: &str) -> String {
    format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product}")
}

/// Read the product's ARP registration — HKCU first (the per-user lane
/// WoWSP installs use), then HKLM. `None` when no entry exists.
fn read_registered_install(product: &str) -> Option<RegisteredInstall> {
    use std::ffi::OsString;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

    [(HKEY_CURRENT_USER, false), (HKEY_LOCAL_MACHINE, true)]
        .into_iter()
        .find_map(|(hive, machine)| {
            let key = winreg::RegKey::predef(hive)
                .open_subkey_with_flags(arp_key(product), KEY_READ)
                .ok()?;
            let location: OsString = key.get_value("InstallLocation").ok()?;
            let location = location.to_string_lossy().trim().to_string();
            if location.is_empty() {
                return None;
            }
            let version: Option<String> = key
                .get_value::<String, _>("DisplayVersion")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            Some(RegisteredInstall {
                location,
                version,
                machine,
            })
        })
}

/// Case/separator-insensitive comparison key for two directory spellings
/// (`C:\Apps\WoWSP` vs `c:\apps\wowsp\`): lowercased, trailing separators
/// and the canonicalize `\\?\` prefix stripped.
fn path_key(path: &str) -> String {
    let trimmed = path
        .trim()
        .trim_start_matches(r"\\?\")
        .trim_end_matches(['\\', '/']);
    trimmed.to_ascii_lowercase()
}

/// The game root at or above `dir` (`dir` itself when it IS one) — the
/// same stub-exe identification the scanner validates real installs with
/// ([`super::game_detect::is_game_dir`]). An uninstaller spawned in any
/// folder inside the game tree sweeps game files on its way out, so such
/// a location can never be a removable leftover.
fn game_root_at_or_above(dir: &Path) -> Option<PathBuf> {
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if super::game_detect::is_game_dir(&current.to_string_lossy()) {
            return Some(current.to_path_buf());
        }
        cursor = current.parent();
    }
    None
}

/// A direct child of `dir` that is a game root — a WoWSP install parked
/// in a shared games root the game (WGC defaults to its own subfolder)
/// later landed in. Sweeping the parent takes the game with it, so this
/// shape refuses removal too. A false refusal costs a cleanup prompt;
/// a missed one costs the game.
fn game_root_child(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && super::game_detect::is_game_dir(&path.to_string_lossy()))
}

/// Whether an uninstaller sweeping `dir` could reach game files or a
/// whole drive: `dir` is a bare drive root, sits at/inside a game root,
/// or carries a game root among its direct children.
fn sweep_reaches_beyond_wowsp(dir: &Path) -> bool {
    dir.parent().is_none() || game_root_at_or_above(dir).is_some() || game_root_child(dir).is_some()
}

/// The pure core of the check: the registered install is a leftover worth
/// offering for removal when it is NOT where the running exe lives, the
/// directory still exists, and it actually contains the app (a deleted
/// install's stale registration pins nothing).
fn detect_duplicate(
    current_dir: Option<&Path>,
    registered: Option<&RegisteredInstall>,
) -> Option<DuplicateInstall> {
    let current = current_dir?;
    let registered = registered?;
    if path_key(&registered.location) == path_key(&current.to_string_lossy()) {
        return None; // the registration is us — nothing is left over
    }
    let dir = Path::new(&registered.location);
    // Absolute only: a hand-edited relative value would resolve against
    // the process CWD — which for a GUI launch is the exe's own folder,
    // i.e. exactly the install that must never be offered for removal.
    if !dir.is_absolute() || !dir.is_dir() || !dir.join(MAIN_EXE).is_file() {
        return None;
    }
    // A drive-root, in-game-tree, or game-hosting folder is never a
    // removable leftover: the leftover's own uninstaller sweeps the
    // directory it sits in (pre-0.6.30 shun swept it wholesale), so
    // removing an install registered there would delete the game (or
    // the drive's contents) with it.
    if sweep_reaches_beyond_wowsp(dir) {
        tracing::warn!(
            location = %registered.location,
            "registered install sits at a drive root or inside/beside a game folder — removal refused"
        );
        return None;
    }
    Some(DuplicateInstall {
        path: registered.location.clone(),
        version: registered.version.clone(),
        has_uninstaller: dir.join(UNINSTALLER).is_file(),
    })
}

/// Whether the startup check runs at all: debug builds live in `target/`
/// (their "current dir" is never a real install, so every installed copy
/// would read as a leftover), a release run out of `target\release` would
/// misread the same way (the gate below requires the RUNNING dir to be
/// install-shaped — carry the uninstaller the installer always drops —
/// which no build directory ever is), and a portable copy next to an
/// installed one is a legitimate setup, not residue.
fn check_applicable() -> bool {
    !cfg!(debug_assertions)
        && !paths::portable_mode()
        && paths::exe_dir().is_some_and(|dir| dir.join(UNINSTALLER).is_file())
}

/// The detection command. `None` means "no leftover install" — including
/// every inapplicable lane above, so the frontend needs no platform
/// knowledge beyond calling it.
#[tauri::command]
pub fn duplicate_install_check() -> CommandResult<Option<DuplicateInstall>> {
    if !check_applicable() {
        return Ok(None);
    }
    let current = paths::exe_dir();
    let registered = read_registered_install(PRODUCT);
    let found = detect_duplicate(current.as_deref(), registered.as_ref());
    if let Some(found) = &found {
        tracing::info!(path = %found.path, "duplicate install detected");
    }
    Ok(found)
}

// ── Removal ───────────────────────────────────────────────────────────────

/// Run the leftover's own uninstaller silently, then re-register the
/// running install (the uninstaller deletes the shared ARP key — without
/// the re-registration "Apps & Features" would lose WoWSP entirely).
/// Blocking work runs on the blocking pool; the command resolves when the
/// leftover is gone, so the frontend's button simply shows a spinner.
#[tauri::command]
pub async fn duplicate_install_uninstall() -> CommandResult<()> {
    duplicate_install_uninstall_inner()
        .await
        .map_err(Into::into)
}

async fn duplicate_install_uninstall_inner() -> Result<()> {
    use std::os::windows::process::CommandExt;

    if !check_applicable() {
        bail!("the running copy is not an installed build — nothing to clean");
    }
    let current = paths::exe_dir()
        .ok_or_else(|| anyhow!("cannot locate the running executable's directory"))?;
    let registered = read_registered_install(PRODUCT)
        .ok_or_else(|| anyhow!("no second WoWSP installation is registered"))?;
    let duplicate = detect_duplicate(Some(&current), Some(&registered))
        .ok_or_else(|| anyhow!("no second WoWSP installation is registered"))?;
    let uninstaller = PathBuf::from(&duplicate.path).join(UNINSTALLER);
    if !uninstaller.is_file() {
        bail!(
            "the leftover install at {} carries no uninstaller",
            duplicate.path
        );
    }
    // Defense in depth: whatever detection concluded, never hand an
    // uninstaller its own directory to sweep when that directory could
    // reach beyond WoWSP — a drive root, a folder inside the game tree,
    // or one hosting a game root among its children (the uninstaller
    // deletes the directory it sits in, pre-0.6.30 shun builds
    // wholesale).
    if sweep_reaches_beyond_wowsp(Path::new(&duplicate.path)) {
        bail!(
            "the leftover install at {} sits at a drive root or inside/beside a game folder — refusing to run its uninstaller; nothing was removed",
            duplicate.path
        );
    }
    // The uninstaller sweeps the SHARED launcher surfaces on its way out
    // (the ARP key and the product's Start-menu/desktop `.lnk`s — they
    // name the leftover, but the running install's launchers share the
    // file names). Capture the launcher presence BEFORE the run so the
    // re-registration below can restore exactly what existed.
    let menu_existed = shun::targets::shortcuts::start_menu_shortcut_exists(PRODUCT);
    let desktop_existed = shun::targets::shortcuts::desktop_shortcut_exists(PRODUCT);
    tracing::info!(path = %duplicate.path, "removing duplicate install");
    let spawned = uninstaller.display().to_string();
    let exit = tokio::task::spawn_blocking(move || {
        std::process::Command::new(&uninstaller)
            .args(["--silent", "--uninstall"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    })
    .await
    .map_err(|e| anyhow!("join uninstaller: {e}"))?
    .map_err(|e| anyhow!("spawn uninstaller {spawned}: {e}"))?;
    if !exit.success() {
        bail!(
            "the uninstaller for {} failed (exit {})",
            duplicate.path,
            exit.code().map(|c| c.to_string()).unwrap_or_default()
        );
    }
    // The key the uninstaller just deleted described the leftover; point
    // a fresh one at the running install so the Apps list keeps a working
    // uninstall entry, then restore the launchers the sweep removed
    // (presence-resolved: a launcher the player had kept comes back, a
    // deleted one stays deleted — the same contract the headless update
    // lane applies). Both steps are best-effort beyond existence: a
    // failure here must not fail the completed cleanup.
    let exe = current.join(MAIN_EXE);
    if exe.is_file() && current.join(UNINSTALLER).is_file() {
        let version = env!("CARGO_PKG_VERSION").to_string();
        if let Err(e) =
            register_install_entry(PRODUCT, registered.machine, &current, &version, &exe)
        {
            tracing::warn!("re-register the running install failed: {e:#}");
        }
        let aumid = shun::targets::install::default_aumid(Some(PUBLISHER), PRODUCT);
        if let Err(e) = shun::targets::shortcuts::apply_shortcut_choices(
            &aumid,
            PRODUCT,
            MAIN_EXE,
            Some(desktop_existed),
            Some(menu_existed),
            &current.to_string_lossy(),
        ) {
            tracing::warn!("restore the running install's launchers failed: {e}");
        }
    } else {
        tracing::warn!(
            dir = %current.display(),
            "running dir carries no uninstaller — ARP entry left absent after the cleanup"
        );
    }
    tracing::info!("duplicate install removed and the running install re-registered");
    Ok(())
}

/// Write the product's ARP entry for the running install — the core of the
/// field set shun's WindowsRegistration writes (see its targets/install.rs;
/// EstimatedSize stays absent — the Apps list simply shows no size until
/// the next real install refreshes it).
fn register_install_entry(
    product: &str,
    machine: bool,
    dir: &Path,
    version: &str,
    exe: &Path,
) -> Result<()> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let root = if machine {
        RegKey::predef(HKEY_LOCAL_MACHINE)
    } else {
        RegKey::predef(HKEY_CURRENT_USER)
    };
    let (key, _) = root
        .create_subkey(arp_key(product))
        .map_err(|e| anyhow!("create ARP key: {e}"))?;
    // Owned locals: winreg's ToRegValue covers String/OsString, and the
    // by-reference call shape below then has exactly one spelling.
    let name = product.to_string();
    let version = version.to_string();
    let publisher = PUBLISHER.to_string();
    let location = dir.as_os_str().to_os_string();
    let icon = exe.as_os_str().to_os_string();
    let uninstaller = dir.join(UNINSTALLER);
    let quoted = format!("\"{}\" /uninstall", uninstaller.display());
    key.set_value("DisplayName", &name)
        .and_then(|()| key.set_value("DisplayVersion", &version))
        .and_then(|()| key.set_value("Publisher", &publisher))
        .and_then(|()| key.set_value("InstallLocation", &location))
        .and_then(|()| key.set_value("DisplayIcon", &icon))
        .and_then(|()| key.set_value("UninstallString", &quoted))
        .and_then(|()| key.set_value("ModifyPath", &quoted))
        .and_then(|()| key.set_value("RepairString", &quoted))
        .map_err(|e| anyhow!("write ARP values: {e}"))?;
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch dir under the temp root, removed on drop.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-dup-install-tests-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn registered_at(location: &str) -> RegisteredInstall {
        RegisteredInstall {
            location: location.to_string(),
            version: Some("0.5.9".to_string()),
            machine: false,
        }
    }

    /// A directory that looks like an install (main exe + uninstaller).
    fn fake_install(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MAIN_EXE), b"MZ").unwrap();
        std::fs::write(dir.join(UNINSTALLER), b"MZ").unwrap();
        dir
    }

    #[test]
    fn a_registered_other_install_is_a_duplicate() {
        let root = scratch("other-install");
        let current = fake_install(&root.0, "current");
        let leftover = fake_install(&root.0, "leftover");
        let found = detect_duplicate(
            Some(&current),
            Some(&registered_at(leftover.to_string_lossy().as_ref())),
        )
        .unwrap();
        assert_eq!(found.path, leftover.to_string_lossy());
        assert_eq!(found.version.as_deref(), Some("0.5.9"));
        assert!(found.has_uninstaller);
    }

    #[test]
    fn own_registration_is_not_a_duplicate() {
        let root = scratch("own-registration");
        let current = fake_install(&root.0, "current");
        // Case and trailing separator differences must not matter.
        let spelled = format!("{}\\", current.to_string_lossy().to_uppercase());
        assert_eq!(
            detect_duplicate(Some(&current), Some(&registered_at(&spelled))),
            None
        );
    }

    #[test]
    fn a_dead_or_empty_registration_pins_nothing() {
        let root = scratch("dead-registration");
        let current = fake_install(&root.0, "current");
        // Directory gone (the install was deleted by hand).
        assert_eq!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(
                    root.0.join("deleted").to_string_lossy().as_ref()
                ))
            ),
            None
        );
        // Directory exists but holds no app binary (not an install).
        std::fs::create_dir_all(root.0.join("empty-dir")).unwrap();
        assert_eq!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(
                    root.0.join("empty-dir").to_string_lossy().as_ref()
                ))
            ),
            None
        );
        // No current dir / no registration at all.
        assert_eq!(detect_duplicate(None, Some(&registered_at(r"D:\X"))), None);
        assert_eq!(detect_duplicate(Some(&current), None), None);
        // A relative registration must never resolve against the CWD.
        assert_eq!(
            detect_duplicate(Some(&current), Some(&registered_at("."))),
            None
        );
    }

    #[test]
    fn an_install_without_uninstaller_reports_no_auto_removal() {
        let root = scratch("no-uninstaller");
        let current = fake_install(&root.0, "current");
        let bare = root.0.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join(MAIN_EXE), b"MZ").unwrap();
        let found = detect_duplicate(
            Some(&current),
            Some(&registered_at(bare.to_string_lossy().as_ref())),
        )
        .unwrap();
        assert!(!found.has_uninstaller);
    }

    #[test]
    fn a_game_folder_registration_is_never_a_duplicate() {
        let root = scratch("game-folder-registration");
        let current = fake_install(&root.0, "current");
        // The pre-guard install shape that deleted players' game folders:
        // WoWSP (exe + uninstaller) sitting IN the game folder, with the
        // ARP entry still naming it after the player reinstalled elsewhere.
        let game = fake_install(&root.0, "game");
        std::fs::write(game.join("WorldOfWarships.exe"), b"MZ").unwrap();
        assert_eq!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(game.to_string_lossy().as_ref()))
            ),
            None
        );
        // One level deeper (an install parked inside bin\ or any game
        // subfolder) is refused the same way — its uninstaller would sweep
        // a chunk of the game.
        let nested = game.join("bin").join("WoWSP");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(MAIN_EXE), b"MZ").unwrap();
        std::fs::write(nested.join(UNINSTALLER), b"MZ").unwrap();
        assert_eq!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(nested.to_string_lossy().as_ref()))
            ),
            None
        );
        // The Lesta stub spelling refuses too.
        let lesta = fake_install(&root.0, "lesta-game");
        std::fs::write(lesta.join("Korabli.exe"), b"MZ").unwrap();
        assert_eq!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(lesta.to_string_lossy().as_ref()))
            ),
            None
        );
        // The shared-games-root shape: WoWSP parked where the game later
        // installed itself one level down — sweeping the parent (what the
        // leftover's own uninstaller does) would take the game with it.
        let host = fake_install(&root.0, "host");
        let game = host.join("World of Warships");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("WorldOfWarships.exe"), b"MZ").unwrap();
        assert_eq!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(host.to_string_lossy().as_ref()))
            ),
            None
        );
    }

    #[test]
    fn an_install_beside_the_game_tree_stays_a_duplicate() {
        // A folder NEXT TO the game root is not inside the game tree — the
        // refusal must not swallow legitimate leftovers.
        let root = scratch("beside-game-tree");
        let current = fake_install(&root.0, "current");
        let game = root.0.join("World of Warships");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("WorldOfWarships.exe"), b"MZ").unwrap();
        let leftover = fake_install(&root.0, "leftover");
        assert!(
            detect_duplicate(
                Some(&current),
                Some(&registered_at(leftover.to_string_lossy().as_ref()))
            )
            .is_some()
        );
    }

    #[test]
    fn path_key_normalizes_case_separators_and_prefixes() {
        assert_eq!(path_key(r"\\?\C:\Apps\WoWSP\"), path_key(r"c:\apps\wowsp"),);
        assert_ne!(path_key(r"C:\Apps\WoWSP"), path_key(r"C:\Apps\WoWSP2"));
    }

    #[test]
    fn config_defaults_to_the_prompt_and_parses_both_shapes() {
        // Missing file → default-on.
        let root = scratch("config-missing");
        assert!(load_config_from(&root.0).prompt_enabled);
        // TOML with the flag off round-trips.
        let root = scratch("config-toml");
        std::fs::write(
            root.0.join(DUPLICATE_INSTALL_CONFIG_FILE),
            "promptEnabled = false\n",
        )
        .unwrap();
        assert!(!load_config_from(&root.0).prompt_enabled);
        // Garbage heals back to the default.
        let root = scratch("config-garbage");
        std::fs::write(root.0.join(DUPLICATE_INSTALL_CONFIG_FILE), "{ not toml").unwrap();
        assert!(load_config_from(&root.0).prompt_enabled);
        // JSON twin spelling (the shared loader's second format — it only
        // reads the legacy name when the TOML file is absent).
        let root = scratch("config-json");
        std::fs::write(
            root.0.join(LEGACY_DUPLICATE_INSTALL_CONFIG_FILE),
            "{\"promptEnabled\":false}",
        )
        .unwrap();
        assert!(!load_config_from(&root.0).prompt_enabled);
    }

    #[test]
    fn canonical_toml_carries_the_header_and_flag() {
        let text = canonical_toml(&DuplicateInstallConfig {
            prompt_enabled: false,
        })
        .unwrap();
        assert!(text.starts_with("# WoWSP duplicate-install cleanup settings."));
        assert!(text.contains("promptEnabled = false"));
    }

    /// HKCU round-trip under a throwaway product key (never the real
    /// "WoWSP" registration — cleaned up on drop).
    struct ArpScratch(String);

    impl Drop for ArpScratch {
        fn drop(&mut self) {
            use winreg::enums::HKEY_CURRENT_USER;
            let _ = winreg::RegKey::predef(HKEY_CURRENT_USER).delete_subkey(arp_key(&self.0));
        }
    }

    #[test]
    fn arp_registration_round_trips() {
        let product = format!("WoWSP-DupTest-{pid}", pid = std::process::id());
        let _guard = ArpScratch(product.clone());
        let root = scratch("arp-roundtrip");
        let dir = fake_install(&root.0, "install");
        let exe = dir.join(MAIN_EXE);
        register_install_entry(&product, false, &dir, "9.9.9", &exe).unwrap();
        let read = read_registered_install(&product).unwrap();
        assert_eq!(path_key(&read.location), path_key(&dir.to_string_lossy()));
        assert_eq!(read.version.as_deref(), Some("9.9.9"));
        assert!(!read.machine);
    }
}
