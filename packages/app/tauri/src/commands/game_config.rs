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
//! first-launch prompt exactly as before.
//!
//! The file also carries the user's PINNED EXTRA REPLAY FOLDERS (the 游玩
//! 时间 view's 录像来源 manager) — folders scanned alongside each client's
//! own `replays/` by [`super::game_context::replay_roots`]. That list owns
//! its own commands ([`add_replay_dir`] / [`remove_replay_dir`]) instead of
//! riding `set_game_config`, so the active-path setter can never clobber it
//! and vice versa; both are read-modify-write of the same flat file, and a
//! user racing one against the other is last-writer-wins on the racing
//! field only (atomic tmp+rename means never a torn file — same policy as
//! the playtime battle cache).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::GameInstall;

use crate::paths;
use crate::settings_store::{self, SettingsSource};

pub const GAME_CONFIG_FILE: &str = "game-config.toml";
/// Pre-TOML persistence (webui store wrote this via `appdata_write`) — read
/// once, then retired.
const LEGACY_GAME_CONFIG_FILE: &str = "game-config.json";

/// Header prepended to the canonical file. Part of the canonical text used
/// for the heal-write comparison, like in `commands/network`.
const FILE_HEADER: &str = "# WoWSP game configuration. active-path = the game install folder the app\n\
                           # reads (empty/absent = prompt on next start). Invalid values are reset.\n\
                           # replay-dirs = extra replay folders scanned alongside each client's own.\n";

/// The on-disk shape: the active install path plus the pinned extra replay
/// folders, flat. (TOML cannot serialize a bare null, hence the skip; the
/// IPC response keeps `activePath: null`. An empty folder list stays
/// unwritten so pre-list files keep their canonical text.)
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameConfigFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    replay_dirs: Vec<String>,
}

/// IPC shape returned to the webui store.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameConfigResponse {
    pub active_path: Option<String>,
    pub replay_dirs: Vec<String>,
}

/// Sanitize a stored path: trim, and treat empty strings as "no path" — a
/// blank value would otherwise re-trigger validation churn every boot while
/// behaving exactly like an absent one.
fn sanitize_path(path: Option<String>) -> Option<String> {
    path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty())
}

/// Sanitize the pinned replay-folder list: trim, drop blanks, and collapse
/// spellings of one folder (`game_detect::install_path_key` — the same
/// identity the scan roots dedupe by), keeping first-seen order. Existence
/// is deliberately NOT required: a folder on a temporarily-unplugged drive
/// must keep its slot, not silently vanish from the config (the scan walks
/// a missing root as empty and it lights up again when the drive returns).
fn sanitize_replay_dirs(dirs: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    dirs.into_iter()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .filter(|d| seen.insert(super::game_detect::install_path_key(d)))
        .collect()
}

fn canonical_toml(file: &GameConfigFile) -> Result<String, String> {
    let body = toml::to_string(file).map_err(|e| format!("serialize game config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// Shared read core: TOML first, legacy JSON second, tolerant parse of
/// either, then the heal-write when the disk does not already hold the
/// canonical text (JSON→TOML migration and invalid-value correction are the
/// same code path). Returns the sanitized file (both fields); unset or
/// garbage answers the default.
fn load_from(dir: &Path) -> GameConfigFile {
    let loaded = settings_store::load_raw(dir, GAME_CONFIG_FILE, LEGACY_GAME_CONFIG_FILE);
    let Some(raw) = loaded.raw else {
        return GameConfigFile::default();
    };
    // Both formats deserialized through the same struct: the legacy JSON
    // carried `activePath` (camelCase), the TOML carries the same keys.
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<GameConfigFile>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<GameConfigFile>(&raw).ok()
        },
    };
    let file = match parsed {
        Some(f) => GameConfigFile {
            active_path: sanitize_path(f.active_path),
            replay_dirs: sanitize_replay_dirs(f.replay_dirs),
        },
        None => GameConfigFile::default(),
    };
    if let Ok(canonical) = canonical_toml(&file) {
        settings_store::heal(
            dir,
            GAME_CONFIG_FILE,
            LEGACY_GAME_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    file
}

/// Testable write core: canonical TOML → atomic write → retire the legacy
/// JSON twin (only after the write succeeded).
fn set_file_from(dir: &Path, file: &GameConfigFile) {
    let Ok(canonical) = canonical_toml(file) else {
        return;
    };
    if settings_store::store(dir, GAME_CONFIG_FILE, &canonical).is_ok() {
        settings_store::retire_legacy_json(dir, LEGACY_GAME_CONFIG_FILE);
    }
}

/// The remembered active-install path (null when unset). Runs the
/// migration/heal pass on the way past, so an upgraded install's stale JSON
/// is converted on the very first startup render.
#[tauri::command]
pub fn get_game_config() -> Result<GameConfigResponse, String> {
    let dir = paths::ensure_data_dir()?;
    let file = load_from(&dir);
    Ok(GameConfigResponse {
        active_path: file.active_path,
        replay_dirs: file.replay_dirs,
    })
}

/// Remember (or clear) the active-install path. The value is sanitized
/// before it lands on disk — only ever a trimmed non-empty string or
/// nothing. The pinned replay-folder list survives untouched (one field
/// per command; see the module docs).
#[tauri::command]
pub fn set_game_config(active_path: Option<String>) -> Result<GameConfigResponse, String> {
    let active_path = sanitize_path(active_path);
    tracing::info!(?active_path, "active game install changed");
    let dir = paths::ensure_data_dir()?;
    let mut file = load_from(&dir);
    file.active_path = active_path;
    set_file_from(&dir, &file);
    Ok(GameConfigResponse {
        active_path: file.active_path,
        replay_dirs: file.replay_dirs,
    })
}

/// Pin one more replay folder for the ledger + rail scans. Validation is
/// part of the add (not left to the scan): the folder must exist, and it
/// must not overlap any root the scan already covers — a folder nesting
/// inside (or containing) a client's `replays/`, the resolved default dir
/// or another pinned folder would either double-count or silently
/// contribute nothing, so it is rejected with the reason instead.
/// `roots` = every root the scan would use today (already including the
/// pinned folders, so list-internal overlap is caught by the same check).
fn add_replay_dir_in(
    dir: &Path,
    path: &str,
    roots: &[(PathBuf, Option<GameInstall>)],
) -> Result<GameConfigResponse, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("空的录像目录路径".into());
    }
    let candidate = PathBuf::from(path);
    let meta =
        std::fs::metadata(&candidate).map_err(|e| format!("无法读取该路径（{e}）：{path}"))?;
    if !meta.is_dir() {
        return Err(format!("所选路径不是文件夹：{path}"));
    }
    if roots
        .iter()
        .any(|(r, _)| super::game_context::replay_roots_overlap(r, &candidate))
    {
        return Err(format!(
            "该目录已在扫描范围内（与现有客户端或已添加的目录重叠）：{path}"
        ));
    }
    let mut file = load_from(dir);
    file.replay_dirs.push(path.to_string());
    file.replay_dirs = sanitize_replay_dirs(std::mem::take(&mut file.replay_dirs));
    set_file_from(dir, &file);
    tracing::info!(path, "replay dir pinned");
    Ok(GameConfigResponse {
        active_path: file.active_path,
        replay_dirs: file.replay_dirs,
    })
}

/// The 游玩时间 view's 录像来源 manager: pin one more replay folder into
/// the scan. Async + spawn_blocking — the overlap validation needs today's
/// scan roots (a registry/Steam walk) and a folder stat.
#[tauri::command]
pub async fn add_replay_dir(path: String) -> Result<GameConfigResponse, String> {
    tokio::task::spawn_blocking(move || {
        let dir = paths::ensure_data_dir()?;
        let roots = super::game_context::replay_roots();
        add_replay_dir_in(&dir, &path, &roots)
    })
    .await
    .map_err(|e| format!("add replay dir task failed: {e}"))?
}

/// Unpin a replay folder (exact list row, any spelling). The folder's
/// already-counted battles stay in the ledger — removal stops future scans,
/// it does not rewrite history (see `commands/playtime.rs`).
#[tauri::command]
pub fn remove_replay_dir(path: String) -> Result<GameConfigResponse, String> {
    let dir = paths::ensure_data_dir()?;
    let file = remove_replay_dir_in(&dir, &path);
    Ok(GameConfigResponse {
        active_path: file.active_path,
        replay_dirs: file.replay_dirs,
    })
}

/// Removal core (hermetic to `dir`): drop the list row whose path identity
/// (`install_path_key`) matches, write only when something actually left.
fn remove_replay_dir_in(dir: &Path, path: &str) -> GameConfigFile {
    let key = super::game_detect::install_path_key(path.trim());
    let mut file = load_from(dir);
    let before = file.replay_dirs.len();
    file.replay_dirs
        .retain(|d| super::game_detect::install_path_key(d) != key);
    if file.replay_dirs.len() != before {
        tracing::info!(path, "replay dir unpinned");
        set_file_from(dir, &file);
    }
    file
}

/// The sanitized persisted active-install path for a given data dir — the
/// read-only view the unified game context (`commands::game_context`) uses,
/// so backend fallbacks and the webui selection agree on ONE install.
/// `None` when unset, unreadable or garbage.
pub(crate) fn persisted_active_path(dir: &Path) -> Option<String> {
    load_from(dir).active_path
}

/// The sanitized pinned extra-replay-folder list — the read-only view
/// `replay_roots` merges into the scan.
pub(crate) fn persisted_replay_dirs(dir: &Path) -> Vec<String> {
    load_from(dir).replay_dirs
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
            load_from(&dir).active_path.as_deref(),
            Some(r"C:\Games\World of Warships")
        );
        assert!(!dir.join(LEGACY_GAME_CONFIG_FILE).exists());
        let toml_text = std::fs::read_to_string(dir.join(GAME_CONFIG_FILE)).unwrap();
        assert!(toml_text.contains("activePath"));

        // Clearing the path rewrites canonical (empty) and stays stable.
        let mut file = load_from(&dir);
        file.active_path = None;
        set_file_from(&dir, &file);
        assert_eq!(load_from(&dir).active_path, None);
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
        assert_eq!(load_from(&dir).active_path, None);
        let healed = std::fs::read_to_string(dir.join(GAME_CONFIG_FILE)).unwrap();
        assert_eq!(healed, canonical_toml(&GameConfigFile::default()).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pinned replay folders: a real folder adds to the list (and lands in
    /// the TOML), an overlapping spelling of the same folder collapses, and
    /// `set_game_config`-style active-path writes never clobber the list.
    #[test]
    fn replay_dirs_add_dedupe_and_survive_path_writes() {
        let dir = temp_dir("replay-dirs");
        let replays = dir.join("archive-replays");
        std::fs::create_dir_all(&replays).unwrap();
        let roots: Vec<(PathBuf, Option<GameInstall>)> = Vec::new();

        let resp = add_replay_dir_in(&dir, &replays.to_string_lossy(), &roots).unwrap();
        assert_eq!(resp.replay_dirs.len(), 1);
        assert!(
            std::fs::read_to_string(dir.join(GAME_CONFIG_FILE))
                .unwrap()
                .contains("replayDirs")
        );

        // A differently-spelled duplicate of the same folder collapses to
        // one entry (same identity rule the scan roots dedupe by).
        let odd = format!("{}\\", replays.to_string_lossy().to_lowercase());
        let resp = add_replay_dir_in(&dir, &odd, &roots).unwrap();
        assert_eq!(resp.replay_dirs.len(), 1, "same-folder spelling collapses");

        // An active-path write (set_game_config's read-modify-write) keeps
        // the pinned list intact.
        let mut file = load_from(&dir);
        file.active_path = Some(r"C:\Games\WoWS".into());
        set_file_from(&dir, &file);
        let file = load_from(&dir);
        assert_eq!(file.active_path.as_deref(), Some(r"C:\Games\WoWS"));
        assert_eq!(file.replay_dirs.len(), 1);

        // Unpinning by yet another spelling empties the list (and drops the
        // key from the canonical TOML).
        let resp = remove_replay_dir_in(&dir, &replays.to_string_lossy());
        assert!(resp.replay_dirs.is_empty());
        assert!(
            !std::fs::read_to_string(dir.join(GAME_CONFIG_FILE))
                .unwrap()
                .contains("replayDirs")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Add-time validation: a missing path, a plain file and a folder that
    /// overlaps an already-scanned root are all rejected with the reason.
    #[test]
    fn replay_dir_adds_validate_existence_and_overlap() {
        let dir = temp_dir("replay-dirs-validate");
        let replays = dir.join("wows-replays");
        std::fs::create_dir_all(&replays).unwrap();
        let file_path = dir.join("plain.txt");
        std::fs::write(&file_path, b"x").unwrap();
        let roots: Vec<(PathBuf, Option<GameInstall>)> = Vec::new();

        assert!(add_replay_dir_in(&dir, r"Z:\definitely\not\here", &roots).is_err());
        assert!(add_replay_dir_in(&dir, &file_path.to_string_lossy(), &roots).is_err());

        // A root already covering the folder (here: a parent of it) rejects
        // the add — the scan would walk it twice.
        let covering = dir.to_string_lossy().into_owned();
        let roots = vec![(PathBuf::from(&covering), None)];
        assert!(add_replay_dir_in(&dir, &replays.to_string_lossy(), &roots).is_err());
        // And the empty string is rejected without touching the disk.
        assert!(add_replay_dir_in(&dir, "  ", &roots).is_err());
        assert!(load_from(&dir).replay_dirs.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
