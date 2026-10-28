//! ApeRadar (海猴雷达) WatchList.json — the import wizard's source.
//!
//! The old external tool kept its watch list ("特别关注名单") at
//! %LOCALAPPDATA%\ApeRadar\WatchList.json (very old builds wrote it beside
//! the exe; the manual picker covers those). The shape is fixed:
//!
//! ```json
//! { "RU": { "2010353714": { "name": "Player", "status": "Negtive" } },
//!   "EU": {}, "NA": {}, "ASIA": {}, "CN": {} }
//! ```
//!
//! Statuses: "Negtive" (the red problem-player mark — sic, the upstream
//! typo), "Cheater", "Positive". Parsing stays status-agnostic: unknown
//! names survive verbatim and the wizard decides what maps onto a marker
//! color. User data is never written here — the module only reads.

use anyhow::{Result, anyhow};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use wowsp_tauri_shared::{
    ApeRadarWatchList, ApeRadarWatchPlayer, ApeRadarWatchServer, CommandResult,
};

/// The watch-list location every ApeRadar build since the user-data split
/// writes (AppPaths.WatchListFile in the old source). None on platforms
/// without %LOCALAPPDATA% — absence is the normal case, never an error.
fn default_watchlist_path() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("ApeRadar").join("WatchList.json"))
}

/// One raw player entry: both fields optional because the old tool's own
/// reader tolerated anything (hand-edited files included).
#[derive(Debug, Deserialize)]
struct RawPlayer {
    name: Option<String>,
    status: Option<String>,
}

/// The raw file shape: server → (accountId → entry). BTreeMap on both
/// levels so the parse is order-independent and deterministic.
type RawWatchList = BTreeMap<String, BTreeMap<String, RawPlayer>>;

/// Parse one WatchList.json. Nameless entries are skipped (the marker list
/// is keyed by nickname); empty server blocks are dropped; a non-numeric
/// account-id key keeps the entry with accountId None.
pub(crate) fn parse_watchlist(path: &Path) -> Result<ApeRadarWatchList> {
    let raw_text =
        std::fs::read_to_string(path).map_err(|e| anyhow!("read {}: {e}", path.display()))?;
    let raw: RawWatchList =
        serde_json::from_str(&raw_text).map_err(|e| anyhow!("parse WatchList.json: {e}"))?;
    let mut servers = Vec::new();
    for (server, entries) in raw {
        let mut players = Vec::new();
        for (id_key, entry) in entries {
            let name = entry.name.filter(|n| !n.trim().is_empty());
            let Some(name) = name else { continue };
            players.push(ApeRadarWatchPlayer {
                account_id: id_key.parse::<i64>().ok(),
                name,
                status: entry.status.unwrap_or_default(),
            });
        }
        if players.is_empty() {
            continue;
        }
        players.sort_by_key(|p| p.name.to_lowercase());
        servers.push(ApeRadarWatchServer { server, players });
    }
    Ok(ApeRadarWatchList {
        path: path.to_string_lossy().into_owned(),
        servers,
    })
}

/// Look for the old ApeRadar watch list at its default location. Null = not
/// installed / nothing marked yet (the wizard then offers the manual
/// picker). A present-but-broken file IS an error — silently pretending an
/// unparseable list does not exist would invite re-importing from a healed
/// (empty) rewrite later.
#[tauri::command]
pub fn aperadar_watchlist_scan() -> CommandResult<Option<ApeRadarWatchList>> {
    let Some(path) = default_watchlist_path() else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(parse_watchlist(&path)?))
}

/// Parse an explicitly picked WatchList.json (the manual path: old builds
/// kept the file beside the exe, and portable installs live anywhere).
#[tauri::command]
pub fn aperadar_watchlist_read(path: String) -> CommandResult<ApeRadarWatchList> {
    Ok(parse_watchlist(&PathBuf::from(path))?)
}

/// Native single-select dialog for a WatchList.json anywhere on disk.
/// Null = the user cancelled. Desktop-only like every other native picker.
#[tauri::command]
pub async fn aperadar_watchlist_pick() -> CommandResult<Option<String>> {
    // Mobile: no ApeRadar there — the settings section keeps the wizard
    // desktop-only on its own; this stand-in guards the raw invoke.
    #[cfg(mobile)]
    {
        return Err(anyhow::anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread.
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Select ApeRadar WatchList.json")
                .add_filter("ApeRadar watch list", &["json"])
                .pick_file()
        })
        .await
        .map_err(|e| anyhow!("watch-list picker task failed: {e}"))?;
        Ok(picked.map(|p| p.to_string_lossy().into_owned()))
    }
}
