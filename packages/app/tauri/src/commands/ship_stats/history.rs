//! Persistence: per-ship history points, career stat snapshots and the gated
//! read-modify-write helper both files share. Split from the former
//! single-file `commands/ship_stats.rs`.

use wowsp_tauri_shared::{
    GameVersionInfo, PlayerShipStats, ShipCareerTotals, ShipStatsHistoryPoint, StatsSnapshot,
};

use super::appdata::{appdata_dir_path, read_appdata_json};
use super::now_ts;

/// Points landing within this window of the latest history point replace it —
/// a flurry of same-session lookups would otherwise pile up near-identical
/// points and crowd out the genuinely old baselines a 30d range needs.
pub(super) const HISTORY_MERGE_SECS: i64 = 6 * 3600;
/// Cap the history file. Generous on purpose: a heavy user querying 4×/day
/// needs ~120 points just to keep a 30d baseline, so 240 covers that with
/// headroom (~8 months of daily lookups, low MBs even at roster size).
pub(super) const HISTORY_MAX_POINTS: usize = 240;

/// Append (or merge) a per-ship history point to
/// `ship-history/<realm>_<accountId>.json`. Best-effort: a history write
/// failure must never fail the lookup itself. `timestamp` is injectable for
/// tests; the command path passes `now_ts()`.
///
/// Empty stats are ignored: a hidden profile (or a transient WG hiccup)
/// returning an empty list must never become a baseline — an empty baseline
/// would turn the player's whole career into "recent" deltas later. Rows
/// whose counters are impossible are dropped for the same reason (see
/// [`is_poisoned_career_row`]). Zero-pvp rows the vortex retention keeps
/// (ranked/co-op ships) route the same way: they carry no randoms totals,
/// so they never become a baseline row and a merge keeps the stored
/// healthy totals instead of regressing them to zero.
pub(super) fn append_ship_history(
    realm: &str,
    account_id: i64,
    stats: &[PlayerShipStats],
    timestamp: i64,
) {
    let result = appdata_dir_path()
        .and_then(|dir| append_ship_history_in(&dir, realm, account_id, stats, timestamp));
    if let Err(error) = result {
        tracing::warn!(%error, "could not append per-ship history");
    }
}

pub(super) fn append_ship_history_in(
    dir: &std::path::Path,
    realm: &str,
    account_id: i64,
    stats: &[PlayerShipStats],
    timestamp: i64,
) -> Result<(), String> {
    if stats.is_empty() {
        return Ok(());
    }
    let mut fresh: Vec<ShipCareerTotals> = Vec::with_capacity(stats.len());
    let mut poisoned_ids: Vec<i64> = Vec::new();
    for row in stats.iter().map(career_totals) {
        if row.battles <= 0 || is_poisoned_career_row(&row) {
            poisoned_ids.push(row.ship_id);
        } else {
            fresh.push(row);
        }
    }
    // Nothing healthy came back — record nothing, same reasoning as the
    // empty check above.
    if fresh.is_empty() {
        return Ok(());
    }
    let file = format!("ship-history/{realm}_{account_id}.json");
    update_history_in(dir, &file, |history: &mut Vec<ShipStatsHistoryPoint>| {
        let merges_with_last = history
            .last()
            .is_some_and(|last| timestamp - last.timestamp < HISTORY_MERGE_SECS);
        if merges_with_last {
            let last = history.last_mut().expect("is_some_and checked for Some");
            last.timestamp = timestamp;
            // Fresh totals replace their stored row; a ship whose fresh row is
            // poisoned keeps its previously stored totals instead of regressing
            // the baseline to a zero-counter row.
            let previous = std::mem::take(&mut last.ships);
            last.ships = fresh
                .into_iter()
                .chain(
                    previous
                        .into_iter()
                        .filter(|stored| poisoned_ids.contains(&stored.ship_id)),
                )
                .collect();
        } else {
            history.push(ShipStatsHistoryPoint {
                timestamp,
                ships: fresh,
            });
        }
        if history.len() > HISTORY_MAX_POINTS {
            let drop = history.len() - HISTORY_MAX_POINTS;
            history.drain(0..drop);
        }
    })
}

/// Keep each history read-modify-write together. Atomic replacement alone
/// cannot stop concurrent appends from reading and then overwriting the same
/// old array. Only local file work runs under this gate, never a WG request.
static HISTORY_WRITE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) fn update_history_in<T: serde::de::DeserializeOwned + serde::Serialize>(
    dir: &std::path::Path,
    file: &str,
    update: impl FnOnce(&mut Vec<T>),
) -> Result<(), String> {
    let _writer = HISTORY_WRITE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    // Only a missing file starts fresh. A read/parse failure must preserve
    // the existing history, including a temporarily locked Windows file.
    let mut history = match super::appdata::read_json_in(dir, file)? {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|error| format!("parse history {file}: {error}"))?
        },
        None => Vec::new(),
    };
    update(&mut history);
    let raw = serde_json::to_string(&history)
        .map_err(|error| format!("serialize history {file}: {error}"))?;
    super::appdata::write_json_in(dir, file, &raw)
}

/// A career row with battles recorded but zero damage AND zero kills cannot
/// be genuine — any played battle deals damage or scores kills. Such rows
/// are what a partially broken upstream returns (the 2026-09 CN vortex
/// regression shipped `battles_count` with null counter fields). Recording
/// one poisons every future range view: the frontend's range stats diff
/// current totals against the baseline, so a zero-counter baseline
/// resurrects the whole career total as the "recent" delta while battles
/// stay a true small delta.
fn is_poisoned_career_row(row: &ShipCareerTotals) -> bool {
    row.battles > 0 && row.damage_caused == 0 && row.frags == 0
}

fn career_totals(s: &PlayerShipStats) -> ShipCareerTotals {
    ShipCareerTotals {
        ship_id: s.ship_id,
        battles: s.battles,
        wins: s.wins,
        damage_caused: s.damage_caused,
        frags: s.frags,
        survived_battles: s.survived_battles,
        last_battle_time: s.last_battle_time,
    }
}

/// Read the per-ship history points for an account. The frontend picks the
/// latest point at or before a date-range cutoff as the baseline and shows
/// current − baseline as the real "recent N days" stats.
#[tauri::command]
pub async fn read_ship_stats_history(
    account_id: i64,
    realm: String,
) -> Result<Vec<ShipStatsHistoryPoint>, String> {
    let file = format!("ship-history/{realm}_{account_id}.json");
    Ok(read_appdata_json(&file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

/// Append a career-stat snapshot for the given account. Called by the frontend
/// after a successful `lookup_player_stats`. Reads the current game version,
/// stamps it onto the snapshot, and appends (never overwrites) the snapshot
/// array. Returns the snapshot that was written.
#[tauri::command]
pub async fn snapshot_player_stats(
    account_id: i64,
    realm: String,
    battles: Option<i64>,
    wins: Option<i64>,
    winrate: Option<f32>,
    avg_damage: Option<f32>,
    pr: Option<i64>,
) -> Result<StatsSnapshot, String> {
    let version = match get_game_version_cached().await {
        Ok(v) => v.game_version,
        Err(_) => "unknown".to_string(),
    };
    let snap = StatsSnapshot {
        timestamp: now_ts(),
        game_version: version,
        battles: battles.unwrap_or(0),
        wins: wins.unwrap_or(0),
        winrate: winrate.unwrap_or(0.0),
        avg_damage: avg_damage.unwrap_or(0.0),
        pr,
    };

    append_snapshot_in(&appdata_dir_path()?, &realm, account_id, snap.clone())?;
    Ok(snap)
}

pub(super) fn append_snapshot_in(
    dir: &std::path::Path,
    realm: &str,
    account_id: i64,
    snap: StatsSnapshot,
) -> Result<(), String> {
    let file = format!("snapshots/{realm}_{account_id}.json");
    update_history_in(dir, &file, |history: &mut Vec<StatsSnapshot>| {
        history.push(snap);
        // Cap at 500 snapshots (~years of daily lookups) to bound file growth.
        if history.len() > 500 {
            let drop = history.len() - 500;
            history.drain(0..drop);
        }
    })
}

/// Read the snapshot history for an account (used by the trends module).
pub(crate) fn read_snapshots(realm: &str, account_id: i64) -> Vec<StatsSnapshot> {
    let file = format!("snapshots/{realm}_{account_id}.json");
    read_appdata_json(&file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}
async fn get_game_version_cached() -> Result<GameVersionInfo, String> {
    // Delegate to the encyclopedia module's command logic by calling the
    // cache path directly first, then the live API.
    if let Ok(Some(raw)) = read_appdata_json("encyclopedia/info.json") {
        if let Ok(v) = serde_json::from_str::<GameVersionInfo>(&raw) {
            return Ok(v);
        }
    }
    // Fall back to a live fetch via the encyclopedia command's path.
    crate::commands::encyclopedia::get_game_version_pub().await
}
