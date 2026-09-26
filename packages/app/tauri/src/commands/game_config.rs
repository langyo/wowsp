//! The active game-install path — the one piece of game configuration the
//! webui persists outside of WG API data. Formerly a webui-owned
//! `game-config.json` (`{ "activePath": … }`) written raw through
//! `appdata_write`; now a flat TOML file owned by these typed commands, so
//! the path value is sanitized on every read and write (see `settings_store`
//! for the shared migration/heal policy).
//!
//! The webui `config` store is the only consumer: `load()` seeds its
//! remembered path from [`get_game_config`], `persist()` funnels through
//! [`set_game_config`]. `detect()` re-resolves the stored path against a
//! fresh install scan on the next boot, so a stale path degrades to the
//! first-launch prompt exactly as before — the file only ever carries a
//! string-or-nothing.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths;
use crate::settings_store::{self, SettingsSource};

pub const GAME_CONFIG_FILE: &str = "game-config.toml";
/// Pre-TOML persistence (webui store wrote this via `appdata_write`) — read
/// once, then retired.
const LEGACY_GAME_CONFIG_FILE: &str = "game-config.json";

/// Header prepended to the canonical file. Part of the canonical text used
/// for the heal-write comparison, like in `commands/network`.
const FILE_HEADER: &str = "# WoWSP game configuration. active-path = the game install folder the app\n\
                           # reads (empty/absent = prompt on next start). Invalid values are reset.\n";

/// The on-disk shape: one optional path, flat. (TOML cannot serialize a bare
/// null, hence the skip; the IPC response keeps `activePath: null`.)
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameConfigFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_path: Option<String>,
}

/// IPC shape returned to the webui store.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameConfigResponse {
    pub active_path: Option<String>,
}

/// Sanitize a stored path: trim, and treat empty strings as "no path" — a
/// blank value would otherwise re-trigger validation churn every boot while
/// behaving exactly like an absent one.
fn sanitize_path(path: Option<String>) -> Option<String> {
    path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty())
}

fn canonical_toml(active_path: Option<&str>) -> Result<String, String> {
    let file = GameConfigFile {
        active_path: active_path.map(str::to_string),
    };
    let body = toml::to_string(&file).map_err(|e| format!("serialize game config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// Shared read core: TOML first, legacy JSON second, tolerant parse of
/// either, then the heal-write when the disk does not already hold the
/// canonical text (JSON→TOML migration and invalid-value correction are the
/// same code path). Returns the sanitized path, `None` when unset/garbage.
fn load_from(dir: &Path) -> Option<String> {
    let loaded = settings_store::load_raw(dir, GAME_CONFIG_FILE, LEGACY_GAME_CONFIG_FILE);
    let raw = loaded.raw?;
    // Both formats deserialized through the same struct: the legacy JSON
    // carried `activePath` (camelCase), the TOML carries the same key.
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<GameConfigFile>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<GameConfigFile>(&raw).ok()
        },
    };
    let active_path = sanitize_path(parsed.unwrap_or_default().active_path);
    if let Ok(canonical) = canonical_toml(active_path.as_deref()) {
        settings_store::heal(
            dir,
            GAME_CONFIG_FILE,
            LEGACY_GAME_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    active_path
}

/// The remembered active-install path (null when unset). Runs the
/// migration/heal pass on the way past, so an upgraded install's stale JSON
/// is converted on the very first startup render.
#[tauri::command]
pub fn get_game_config() -> Result<GameConfigResponse, String> {
    let dir = paths::ensure_data_dir()?;
    Ok(GameConfigResponse {
        active_path: load_from(&dir),
    })
}

/// Remember (or clear) the active-install path. The value is sanitized
/// before it lands on disk — only ever a trimmed non-empty string or
/// nothing.
#[tauri::command]
pub fn set_game_config(active_path: Option<String>) -> Result<GameConfigResponse, String> {
    let active_path = sanitize_path(active_path);
    let dir = paths::ensure_data_dir()?;
    set_from(&dir, active_path.clone());
    Ok(GameConfigResponse { active_path })
}

/// The sanitized persisted active-install path for a given data dir — the
/// read-only view the unified game context (`commands::game_context`) uses,
/// so backend fallbacks and the webui selection agree on ONE install.
/// `None` when unset, unreadable or garbage.
pub(crate) fn persisted_active_path(dir: &Path) -> Option<String> {
    load_from(dir)
}

/// Testable write core: sanitize → canonical TOML → atomic write → retire
/// the legacy JSON twin (only after the write succeeded).
fn set_from(dir: &Path, active_path: Option<String>) {
    let Ok(canonical) = canonical_toml(active_path.as_deref()) else {
        return;
    };
    if settings_store::store(dir, GAME_CONFIG_FILE, &canonical).is_ok() {
        settings_store::retire_legacy_json(dir, LEGACY_GAME_CONFIG_FILE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-gamecfg-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The legacy webui file migrates verbatim (paths with backslashes and
    /// spaces intact) and is retired after the TOML write; a cleared path
    /// writes the bare header-only canonical file.
    #[test]
    fn migrates_legacy_json_path() {
        let dir = temp_dir("migrate");
        std::fs::write(
            dir.join(LEGACY_GAME_CONFIG_FILE),
            r#"{"activePath":"C:\\Games\\World of Warships"}"#,
        )
        .unwrap();
        assert_eq!(
            load_from(&dir).as_deref(),
            Some(r"C:\Games\World of Warships")
        );
        assert!(!dir.join(LEGACY_GAME_CONFIG_FILE).exists());
        let toml_text = std::fs::read_to_string(dir.join(GAME_CONFIG_FILE)).unwrap();
        assert!(toml_text.contains("activePath"));

        // Clearing the path rewrites canonical (empty) and stays stable.
        set_from(&dir, Some("".into()));
        assert_eq!(load_from(&dir), None);
        let cleared = std::fs::read_to_string(dir.join(GAME_CONFIG_FILE)).unwrap();
        assert!(!cleared.contains("activePath"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Garbage / wrong-typed values heal to "no path" on disk; a canonical
    /// file round-trips and is not rewritten.
    #[test]
    fn garbage_heals_to_unset() {
        let dir = temp_dir("garbage");
        std::fs::write(dir.join(GAME_CONFIG_FILE), "activePath = 42\n").unwrap();
        assert_eq!(load_from(&dir), None);
        let healed = std::fs::read_to_string(dir.join(GAME_CONFIG_FILE)).unwrap();
        assert_eq!(healed, canonical_toml(None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
