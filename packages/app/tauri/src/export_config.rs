//! The replay-clip export DIRECTORY — one persistent folder the export modal
//! writes into, so a clip save never needs a per-file dialog.
//!
//! Stored as a flat TOML file (`export-config.toml`) under the appdata root,
//! read/written through the shared `settings_store` migration + heal policy
//! (same shape as `commands/game_config.rs`): the file is parsed tolerantly,
//! an invalid/absent value heals to the current default, and the canonical
//! text is only rewritten when it actually differs — the steady state costs
//! no write.
//!
//! The value is ALWAYS a usable absolute directory: a stored path that is
//! blank, relative, or no longer on disk falls back to the OS Downloads
//! folder and that fallback is persisted, so the next read is a plain hit and
//! the modal never has to special-case a missing folder. Validation on the
//! write side ([`export_config_set_dir`], and the picker in
//! `commands/exports.rs`) is non-empty + absolute + exists-or-creatable, with
//! `create_dir_all` doing the creating.
//!
//! Grants are NOT this module's business: the picker registers a DIRECTORY
//! grant in `commands/exports.rs` before returning, and
//! [`write_export_bytes`](crate::commands::exports::write_export_bytes)
//! accepts files directly inside a granted folder (see the grant table's
//! docs for the exact rule).

use anyhow::anyhow;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

use crate::paths;
use crate::settings_store::{self, SettingsSource};

/// The canonical settings file under the appdata root.
pub const EXPORT_CONFIG_FILE: &str = "export-config.toml";

/// Legacy twin name for the shared loader/heal pair. No shipped build ever
/// wrote this file — the export directory is new with this module — but the
/// pair's one migration path is name-based, so a future webui-owned JSON (or
/// a downgrade-era file) migrates into the canonical TOML instead of being
/// ignored. Deletion only ever happens after a successful TOML write.
const LEGACY_EXPORT_CONFIG_FILE: &str = "export-config.json";

/// Header prepended to the canonical file (part of the canonical text the
/// heal comparison uses, like the other settings files).
const FILE_HEADER: &str = "# WoWSP replay-export configuration. dir = the folder the export modal\n\
                           # writes clips into (absolute path; empty/invalid/missing = the OS\n\
                           # Downloads folder). Invalid values are reset on the next read.\n";

/// The on-disk shape. A bare null cannot be represented in TOML, hence the
/// skip — an unset value is simply an absent key, and the read path supplies
/// the Downloads fallback.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ExportConfigFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir: Option<String>,
}

/// IPC shape returned to the webui. `dir` is always a usable absolute path —
/// the fallback is resolved (and persisted) before this is handed out.
#[derive(Debug, Serialize)]
pub struct ExportConfig {
    pub dir: String,
}

// ── Defaults + validation ─────────────────────────────────────────────────────

/// The OS Downloads folder — the default the export modal starts from and
/// the fallback whenever the stored value is unusable.
///
/// `dirs-next` is the app's existing `dirs`-family dependency (the
/// maintained fork of `dirs`, already in the tree for `paths.rs`), so this
/// adds no crate: its `download_dir()` is the Windows Downloads known folder
/// (`FOLDERID_Downloads`, so a relocated/OneDrive-redirected Downloads is
/// honoured) and `$HOME/Downloads` elsewhere. The environment variables are a
/// last-resort fallback for a stripped profile where the platform lookup
/// declines.
pub fn default_export_dir() -> anyhow::Result<PathBuf> {
    if let Some(dir) = dirs_next::download_dir() {
        return Ok(dir);
    }
    home_downloads()
}

/// `%USERPROFILE%\Downloads` on Windows, `$HOME/Downloads` elsewhere —
/// only reached when the platform lookup above found nothing.
fn home_downloads() -> anyhow::Result<PathBuf> {
    let (var, hint) = if cfg!(windows) {
        ("USERPROFILE", "%USERPROFILE%")
    } else {
        ("HOME", "$HOME")
    };
    let home = std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| anyhow!("cannot resolve the Downloads folder ({hint} is unset)"))?;
    Ok(home.join("Downloads"))
}

/// Sanitize a stored directory: trim, drop blanks, and drop anything that is
/// not absolute (a relative value would silently resolve against whatever
/// CWD the process happens to have).
fn sanitize_dir(dir: Option<String>) -> Option<String> {
    dir.map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .filter(|d| Path::new(d).is_absolute())
}

/// The write-side validation shared by the typed setter and the picker:
/// trimmed non-empty, absolute, and either an existing directory or a path
/// `create_dir_all` can create. Returns the value as it should be stored.
fn validate_dir(dir: &str) -> anyhow::Result<String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err(anyhow!("export directory is empty"));
    }
    let path = Path::new(dir);
    if !path.is_absolute() {
        return Err(anyhow!("export directory must be an absolute path: {dir}"));
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => {},
        Ok(_) => return Err(anyhow!("export path is not a directory: {dir}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path)
                .map_err(|e| anyhow!("create export directory {dir}: {e}"))?;
        },
        Err(e) => return Err(anyhow!("cannot read export directory {dir}: {e}")),
    }
    Ok(dir.to_string())
}

// ── Persistence cores (hermetic to `dir` — unit-tested below) ────────────────

fn canonical_toml(file: &ExportConfigFile) -> anyhow::Result<String> {
    let body = toml::to_string(file).map_err(|e| anyhow!("serialize export config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// Shared read core: TOML first, legacy JSON second, tolerant parse of
/// either, then the heal-write when the disk does not already hold the
/// canonical text. Returns the sanitized file; unset or garbage answers the
/// default (an absent directory — the caller resolves the fallback).
fn load_from(dir: &Path) -> ExportConfigFile {
    let loaded = settings_store::load_raw(dir, EXPORT_CONFIG_FILE, LEGACY_EXPORT_CONFIG_FILE);
    let Some(raw) = loaded.raw else {
        return ExportConfigFile::default();
    };
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<ExportConfigFile>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<ExportConfigFile>(&raw).ok()
        },
    };
    let file = ExportConfigFile {
        dir: sanitize_dir(parsed.and_then(|f| f.dir)),
    };
    if let Ok(canonical) = canonical_toml(&file) {
        settings_store::heal(
            dir,
            EXPORT_CONFIG_FILE,
            LEGACY_EXPORT_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    file
}

/// Testable write core: canonical TOML → atomic write → retire the legacy
/// JSON twin (only after the write succeeded).
fn set_file_from(dir: &Path, file: &ExportConfigFile) -> anyhow::Result<()> {
    let canonical = canonical_toml(file)?;
    settings_store::store(dir, EXPORT_CONFIG_FILE, &canonical)?;
    settings_store::retire_legacy_json(dir, LEGACY_EXPORT_CONFIG_FILE);
    Ok(())
}

/// The usable export directory for `data_dir`: the stored value when it is
/// still a live absolute directory, else the OS Downloads fallback — created
/// best-effort and persisted, so the next read is a plain hit and the modal
/// always renders a real folder.
fn resolved_dir(data_dir: &Path) -> anyhow::Result<String> {
    let mut file = load_from(data_dir);
    if let Some(dir) = file.dir.as_deref() {
        if Path::new(dir).is_dir() {
            return Ok(dir.to_string());
        }
        // A folder that moved or vanished (unplugged drive, deleted
        // Downloads) degrades to the default instead of an export failure.
        tracing::warn!(
            dir,
            "persisted export directory is unusable; falling back to Downloads"
        );
    }
    let fallback = default_export_dir()?.to_string_lossy().into_owned();
    // Best effort: a read must not fail over a folder it cannot create (the
    // write side creates the parent anyway before writing a clip).
    if let Err(e) = std::fs::create_dir_all(&fallback) {
        tracing::warn!(dir = %fallback, error = %e, "cannot create the default export directory");
    }
    if file.dir.as_deref() != Some(fallback.as_str()) {
        file.dir = Some(fallback.clone());
        set_file_from(data_dir, &file)?;
    }
    Ok(fallback)
}

/// Persist `dir` into the config at `data_dir` after validating it.
fn set_dir_in(data_dir: &Path, dir: &str) -> anyhow::Result<String> {
    let dir = validate_dir(dir)?;
    let mut file = load_from(data_dir);
    file.dir = Some(dir.clone());
    set_file_from(data_dir, &file)?;
    Ok(dir)
}

/// Resolve the appdata root and persist `dir` — the picker's and the typed
/// setter's shared entry point.
pub(crate) fn persist_dir(dir: &str) -> anyhow::Result<String> {
    let data_dir = paths::ensure_data_dir()?;
    set_dir_in(&data_dir, dir)
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The persisted export directory, resolving (and persisting) the Downloads
/// fallback when nothing usable is stored. Runs the migration/heal pass on
/// the way past, so an upgraded install's stale file is converted on the
/// first render of the export modal.
#[tauri::command]
pub async fn export_config_get() -> CommandResult<ExportConfig> {
    Ok(tokio::task::spawn_blocking(|| {
        let data_dir = paths::ensure_data_dir()?;
        Ok::<_, anyhow::Error>(ExportConfig {
            dir: resolved_dir(&data_dir)?,
        })
    })
    .await
    .map_err(|e| anyhow!("export config read task failed: {e}"))??)
}

/// Restore the persisted folder's WRITE GRANT at startup.
///
/// The export folder is either the app's conventional default (the OS
/// Downloads folder — the same exposure class a browser grants for
/// downloads) or a path the user picked through the native folder dialog in
/// an earlier run. The IPC surface deliberately has NO setter (only the
/// native picker may change the folder), so the stored value is always
/// user-consented and re-granting it at startup cannot be turned into an
/// IPC-triggerable arbitrary-write path: the webview chooses nothing here.
pub(crate) fn grant_persisted_dir() -> anyhow::Result<String> {
    let data_dir = paths::ensure_data_dir()?;
    let dir = resolved_dir(&data_dir)?;
    crate::commands::exports::grant_export_dir(&dir);
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-exportcfg-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A relative/blank stored value heals away (to "unset") and the canonical
    /// file on disk carries no `dir` key; a valid absolute path round-trips.
    #[test]
    fn garbage_heals_and_valid_path_round_trips() {
        let dir = temp_dir("garbage");
        std::fs::write(dir.join(EXPORT_CONFIG_FILE), "dir = \"relative/path\"\n").unwrap();
        assert_eq!(load_from(&dir).dir, None);
        assert_eq!(
            std::fs::read_to_string(dir.join(EXPORT_CONFIG_FILE)).unwrap(),
            canonical_toml(&ExportConfigFile::default()).unwrap()
        );

        let target = dir.join("clips");
        std::fs::create_dir_all(&target).unwrap();
        assert_eq!(
            set_dir_in(&dir, &target.to_string_lossy()).unwrap(),
            target.to_string_lossy()
        );
        assert_eq!(
            load_from(&dir).dir.as_deref(),
            Some(target.to_string_lossy().as_ref())
        );
        // The steady state is write-free: a canonical file is not rewritten.
        let before = std::fs::metadata(dir.join(EXPORT_CONFIG_FILE))
            .unwrap()
            .modified()
            .unwrap();
        load_from(&dir);
        assert_eq!(
            std::fs::metadata(dir.join(EXPORT_CONFIG_FILE))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unset config resolves to the OS Downloads folder and PERSISTS it, so
    /// the second read is a plain hit with the same value.
    #[test]
    fn missing_config_falls_back_to_downloads_and_persists() {
        let dir = temp_dir("fallback");
        let expected = default_export_dir().unwrap().to_string_lossy().into_owned();
        assert_eq!(resolved_dir(&dir).unwrap(), expected);
        assert_eq!(load_from(&dir).dir.as_deref(), Some(expected.as_str()));
        assert_eq!(resolved_dir(&dir).unwrap(), expected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stored folder that no longer exists degrades to the fallback (and the
    /// fallback replaces the dead value on disk).
    #[test]
    fn vanished_directory_falls_back_to_downloads() {
        let dir = temp_dir("vanished");
        let dead = dir.join("gone");
        set_dir_in(&dir, &dead.to_string_lossy()).unwrap();
        std::fs::remove_dir_all(&dead).unwrap();
        let expected = default_export_dir().unwrap().to_string_lossy().into_owned();
        assert_eq!(resolved_dir(&dir).unwrap(), expected);
        assert_eq!(load_from(&dir).dir.as_deref(), Some(expected.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Write-side validation: empty, relative and plain-file targets are
    /// refused; a creatable path is created.
    #[test]
    fn set_dir_validates_and_creates() {
        let dir = temp_dir("validate");
        let file_path = dir.join("plain.txt");
        std::fs::write(&file_path, b"x").unwrap();
        assert!(set_dir_in(&dir, "  ").is_err());
        assert!(set_dir_in(&dir, "relative/clips").is_err());
        assert!(set_dir_in(&dir, &file_path.to_string_lossy()).is_err());
        assert!(!dir.join(EXPORT_CONFIG_FILE).exists());

        let fresh = dir.join("nested").join("clips");
        assert_eq!(
            set_dir_in(&dir, &fresh.to_string_lossy()).unwrap(),
            fresh.to_string_lossy()
        );
        assert!(fresh.is_dir(), "create_dir_all ran for the missing folder");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
