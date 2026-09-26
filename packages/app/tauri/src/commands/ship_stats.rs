//! Per-player per-ship stats + career stat snapshots (milestone M10).
//!
//! Two concerns:
//!   1. `/wows/ships/stats/` — the player's PvP stats broken down by ship.
//!      Cached to `ship-stats/<realm>_<accountId>.json`. Ship names are
//!      back-filled from the encyclopedia cache when available.
//!   2. Snapshots — on each account-level lookup we append a timestamped
//!      career-summary point to `snapshots/<realm>_<accountId>.json`. This
//!      time series is what the trends module buckets by game version.

use std::fs;

use serde::Deserialize;
use wowsp_tauri_shared::{
    GameVersionInfo, PlayerShipStats, ShipCareerTotals, ShipModeBreakdown, ShipModeStats,
    ShipStatsHistoryPoint, StatsSnapshot,
};

use super::appdata::{appdata_dir_path, read_appdata_json, write_appdata_json};
use super::trends::ExpectedValues;
use super::wg_api::{ExpectedPrRow, PrAlgo};

/// Fetch (and cache) a player's per-ship PvP stats. `ship_name_map` is built
/// from the encyclopedia cache so each entry carries a readable name.
/// `pr_algo` selects the per-ship PR algorithm ("winrate" default /
/// "expected" = wows-numbers against the server-average table); see
/// [`apply_pr_algo`].
#[tauri::command]
pub async fn lookup_player_ship_stats(
    account_id: i64,
    realm: String,
    pr_algo: Option<String>,
) -> Result<Vec<PlayerShipStats>, String> {
    let algo = PrAlgo::from_param(pr_algo.as_deref());
    let cache_file = format!("ship-stats/{realm}_{account_id}.json");
    // We always re-fetch on demand (the player may have played new battles);
    // the cache is just a fallback when the API is unreachable.
    let name_map = load_ship_name_map();
    // Expected algorithm: load the wows-numbers table once for the whole
    // list (downloaded on cache miss, see `trends`). None when it can't be
    // loaded — every row then renders "--" instead of failing the lookup.
    // The winrate algorithm skips this entirely: zero extra cost.
    let expected_table = if algo == PrAlgo::Expected {
        super::trends::load_expected_values().await
    } else {
        None
    };

    let result = fetch_ship_stats(account_id, &realm).await;
    let stats = match result {
        Ok(s) => {
            // Persist cache.
            let enriched: Vec<PlayerShipStats> = s
                .iter()
                .map(|raw| {
                    let mut p: PlayerShipStats = raw.into();
                    p.name = name_map.get(&raw.ship_id).cloned().unwrap_or_default();
                    apply_pr_algo(&mut p, algo, &expected_table);
                    p
                })
                .collect();
            let _ = write_appdata_json(
                &cache_file,
                &serde_json::to_string(&enriched).unwrap_or_default(),
            );
            // Also append a per-ship history point so later lookups can
            // derive real "recent N days" deltas (WG has no per-battle API).
            append_ship_history(&realm, account_id, &enriched, now_ts());
            enriched
        },
        Err(e) => {
            // Fallback to cache if the live API failed. The cache may have
            // been written under the other PR algorithm; both algorithms are
            // pure functions of the stored counters, so re-derive instead of
            // serving a stale mixed rating.
            if let Ok(Some(raw)) = read_appdata_json(&cache_file) {
                if let Ok(mut cached) = serde_json::from_str::<Vec<PlayerShipStats>>(&raw) {
                    for p in &mut cached {
                        apply_pr_algo(p, algo, &expected_table);
                    }
                    return Ok(cached);
                }
            }
            return Err(e);
        },
    };
    Ok(stats)
}

/// Re-derive one row's PR for the selected algorithm from the row's own
/// counters. Winrate recomputes the historical anchor mapping (identical to
/// what the `From` conversion produced); expected applies the wows-numbers
/// formula against the loaded table — a missing table or a ship absent from
/// it yields None ("--"), never a silent fallback to the other algorithm.
fn apply_pr_algo(
    p: &mut PlayerShipStats,
    algo: PrAlgo,
    expected_table: &Option<std::collections::HashMap<i64, ExpectedValues>>,
) {
    p.pr = match algo {
        PrAlgo::Winrate => Some(super::wg_api::rating_from_winrate(p.winrate)),
        PrAlgo::Expected => expected_table
            .as_ref()
            .and_then(|table| table.get(&p.ship_id))
            .and_then(|ev| {
                super::wg_api::expected_ship_pr(p.battles, p.damage_caused, p.frags, p.wins, ev)
            }),
    };
}

/// Per-ship PvP (randoms) totals for the account-level expected PR — the
/// same fetch `lookup_player_ship_stats` performs, without the name
/// enrichment or cache/history writes (the caller only needs the counters).
pub(crate) async fn fetch_expected_pr_rows(
    account_id: i64,
    realm: &str,
) -> Result<Vec<ExpectedPrRow>, String> {
    Ok(fetch_ship_stats(account_id, realm)
        .await?
        .iter()
        .map(|s| ExpectedPrRow {
            ship_id: s.ship_id,
            battles: s.battles,
            damage: s.damage_caused,
            frags: s.frags,
            wins: s.wins,
        })
        .collect())
}

/// Points landing within this window of the latest history point replace it —
/// a flurry of same-session lookups would otherwise pile up near-identical
/// points and crowd out the genuinely old baselines a 30d range needs.
const HISTORY_MERGE_SECS: i64 = 6 * 3600;
/// Cap the history file. Generous on purpose: a heavy user querying 4×/day
/// needs ~120 points just to keep a 30d baseline, so 240 covers that with
/// headroom (~8 months of daily lookups, low MBs even at roster size).
const HISTORY_MAX_POINTS: usize = 240;

/// Append (or merge) a per-ship history point to
/// `ship-history/<realm>_<accountId>.json`. Best-effort: a history write
/// failure must never fail the lookup itself. `timestamp` is injectable for
/// tests; the command path passes `now_ts()`.
///
/// Empty stats are ignored: a hidden profile (or a transient WG hiccup)
/// returning an empty list must never become a baseline — an empty baseline
/// would turn the player's whole career into "recent" deltas later.
fn append_ship_history(realm: &str, account_id: i64, stats: &[PlayerShipStats], timestamp: i64) {
    if stats.is_empty() {
        return;
    }
    let file = format!("ship-history/{realm}_{account_id}.json");
    let mut history: Vec<ShipStatsHistoryPoint> = read_appdata_json(&file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let merges_with_last = history
        .last()
        .is_some_and(|last| timestamp - last.timestamp < HISTORY_MERGE_SECS);
    if merges_with_last {
        let last = history.last_mut().expect("is_some_and checked for Some");
        last.timestamp = timestamp;
        last.ships = stats.iter().map(career_totals).collect();
    } else {
        history.push(ShipStatsHistoryPoint {
            timestamp,
            ships: stats.iter().map(career_totals).collect(),
        });
    }
    if history.len() > HISTORY_MAX_POINTS {
        let drop = history.len() - HISTORY_MAX_POINTS;
        history.drain(0..drop);
    }
    let _ = write_appdata_json(&file, &serde_json::to_string(&history).unwrap_or_default());
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

    let file = format!("snapshots/{realm}_{account_id}.json");
    let mut history: Vec<StatsSnapshot> = read_appdata_json(&file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    history.push(snap.clone());
    // Cap at 500 snapshots (~years of daily lookups) to bound file growth.
    if history.len() > 500 {
        let drop = history.len() - 500;
        history.drain(0..drop);
    }
    let _ = write_appdata_json(&file, &serde_json::to_string(&history).unwrap_or_default());
    Ok(snap)
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

// ── WG API fetch ────────────────────────────────────────────────────────

async fn fetch_ship_stats(account_id: i64, realm: &str) -> Result<Vec<RawShipStats>, String> {
    if realm == "cn" {
        return fetch_ship_stats_cn(account_id).await;
    }
    let app_id = super::wg_realm::application_id(realm);
    let host = super::wg_realm::api_host(realm)?;
    let client = wg_client()?;
    let url = format!(
        "https://{host}/wows/ships/stats/?application_id={app_id}&account_id={account_id}\
         &fields=ship_id,last_battle_time,pvp,pvp_solo,pvp_div2,pvp_div3,pve,\
         rank_solo,rank_div2,rank_div3"
    );
    let resp: WgResponse<serde_json::Value> = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("ships/stats request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("ships/stats parse: {e}"))?;
    if resp.status != "ok" {
        return Err(format!(
            "ships/stats: {}",
            resp.error.message.unwrap_or_default()
        ));
    }
    // data is { "<accountId>": [ { ship_id, pvp: {...}, ... }, ... ] }
    let key = account_id.to_string();
    let arr: Vec<serde_json::Value> = match resp.data {
        Some(d) => d
            .get(&key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let mut out = Vec::new();
    for entry in arr {
        if let Some(raw) = RawShipStats::from_wg(&entry) {
            out.push(raw);
        }
    }
    Ok(out)
}

/// CN arm: the vortex per-ship endpoint
/// `GET https://vortex.wowsgame.cn/api/accounts/<id>/ships/`. Its
/// `data.<id>.statistics` is a ship_id-keyed map of battle-type nodes with
/// vortex field names (battles_count, survived, …); the ship id lives in the
/// map key and no last_battle_time is served.
async fn fetch_ship_stats_cn(account_id: i64) -> Result<Vec<RawShipStats>, String> {
    let host = super::wg_realm::vortex_host("cn")?;
    let client = super::wg_api_cn::vortex_client()?;
    let url = format!("https://{host}/api/accounts/{account_id}/ships/");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("CN ships request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("CN ships: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("CN ships parse: {e}"))?;
    if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        return Err(format!("CN ships: {err}"));
    }
    // A hidden profile answers ok with an empty statistics map.
    let stats_map = v
        .get("data")
        .and_then(|d| d.get(account_id.to_string()))
        .and_then(|p| p.get("statistics"))
        .and_then(|s| s.as_object());
    let mut out = Vec::new();
    if let Some(map) = stats_map {
        for (ship_id, node) in map {
            let Some(id) = ship_id.parse::<i64>().ok() else {
                continue;
            };
            if let Some(raw) = RawShipStats::from_vortex(id, node) {
                out.push(raw);
            }
        }
    }
    Ok(out)
}

/// Intermediate struct — raw WG fields before we compute winrate/avg_damage
/// and back-fill the ship name.
#[derive(Clone, Debug)]
struct RawShipStats {
    ship_id: i64,
    battles: i64,
    wins: i64,
    damage_caused: i64,
    frags: i64,
    survived_battles: i64,
    last_battle_time: i64,
    /// Total XP in randoms (WG name `xp`); 0 when not served.
    xp: i64,
    /// Per-mode breakdown. None when no battle-type node is served at all.
    modes: Option<ShipModeBreakdown>,
}

/// How a battle-type node spells its counter fields.
#[derive(Clone, Copy)]
enum ModeDialect {
    /// WG `/wows/ships/stats/`: `battles` / `survived_battles`.
    Wg,
    /// CN vortex: `battles_count` / `survived`.
    Vortex,
}

fn mode_from_node(node: Option<&serde_json::Value>, dialect: ModeDialect) -> Option<ShipModeStats> {
    let v = node.filter(|v| !v.is_null())?;
    let (battles_key, survived_key) = match dialect {
        ModeDialect::Wg => ("battles", "survived_battles"),
        ModeDialect::Vortex => ("battles_count", "survived"),
    };
    let battles = v.get(battles_key).and_then(|x| x.as_i64())?;
    if battles <= 0 {
        return None;
    }
    let field = |key: &str| v.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
    let wins = field("wins");
    let damage = field("damage_dealt");
    Some(ShipModeStats {
        battles,
        wins,
        damage_caused: damage,
        frags: field("frags"),
        survived_battles: field(survived_key),
        winrate: 100.0 * wins as f32 / battles as f32,
        avg_damage: damage as f32 / battles as f32,
    })
}

/// Combine the three ranked division nodes (rank_solo/div2/div3) into one
/// ranked bucket. None when the ship has no ranked battles on any node.
fn combine_modes(parts: [Option<ShipModeStats>; 3]) -> Option<ShipModeStats> {
    let present: Vec<ShipModeStats> = parts.into_iter().flatten().collect();
    if present.is_empty() {
        return None;
    }
    let battles = present.iter().map(|m| m.battles).sum::<i64>();
    if battles <= 0 {
        return None;
    }
    let wins = present.iter().map(|m| m.wins).sum::<i64>();
    let damage = present.iter().map(|m| m.damage_caused).sum::<i64>();
    Some(ShipModeStats {
        battles,
        wins,
        damage_caused: damage,
        frags: present.iter().map(|m| m.frags).sum(),
        survived_battles: present.iter().map(|m| m.survived_battles).sum(),
        winrate: 100.0 * wins as f32 / battles as f32,
        avg_damage: damage as f32 / battles as f32,
    })
}

impl RawShipStats {
    fn from_wg(entry: &serde_json::Value) -> Option<Self> {
        let pvp = entry.get("pvp")?;
        if pvp.is_null() {
            return None;
        }
        let battles = pvp.get("battles")?.as_i64()?;
        if battles == 0 {
            return None;
        }
        let solo = mode_from_node(entry.get("pvp_solo"), ModeDialect::Wg);
        let div2 = mode_from_node(entry.get("pvp_div2"), ModeDialect::Wg);
        let div3 = mode_from_node(entry.get("pvp_div3"), ModeDialect::Wg);
        let coop = mode_from_node(entry.get("pve"), ModeDialect::Wg);
        let ranked = combine_modes([
            mode_from_node(entry.get("rank_solo"), ModeDialect::Wg),
            mode_from_node(entry.get("rank_div2"), ModeDialect::Wg),
            mode_from_node(entry.get("rank_div3"), ModeDialect::Wg),
        ]);
        let has_modes = [
            solo.is_some(),
            div2.is_some(),
            div3.is_some(),
            coop.is_some(),
            ranked.is_some(),
        ];
        Some(Self {
            ship_id: entry.get("ship_id")?.as_i64()?,
            battles,
            wins: pvp.get("wins").and_then(|v| v.as_i64()).unwrap_or(0),
            damage_caused: pvp
                .get("damage_dealt")
                .or_else(|| pvp.get("damage_caused"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            frags: pvp.get("frags").and_then(|v| v.as_i64()).unwrap_or(0),
            survived_battles: pvp
                .get("survived_battles")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            last_battle_time: entry
                .get("last_battle_time")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            xp: pvp.get("xp").and_then(|v| v.as_i64()).unwrap_or(0),
            modes: if has_modes.iter().any(|&b| b) {
                Some(ShipModeBreakdown {
                    solo,
                    div2,
                    div3,
                    coop,
                    ranked,
                })
            } else {
                None
            },
        })
    }

    /// CN vortex per-ship node: a battle-type map whose `pvp` entry carries
    /// vortex field names and the ship id comes from the enclosing map key.
    /// Several counters (damage, frags, survival) are served as null on ships
    /// the player barely touched — they degrade to 0, same tolerance as the
    /// WG path. No last_battle_time is served at all.
    fn from_vortex(ship_id: i64, node: &serde_json::Value) -> Option<Self> {
        let pvp = node.get("pvp").filter(|v| !v.is_null())?;
        let battles = pvp.get("battles_count")?.as_i64()?;
        if battles == 0 {
            return None;
        }
        let field = |node: &serde_json::Value, key: &str| {
            node.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
        };
        let solo = mode_from_node(node.get("pvp_solo"), ModeDialect::Vortex);
        let div2 = mode_from_node(node.get("pvp_div2"), ModeDialect::Vortex);
        let div3 = mode_from_node(node.get("pvp_div3"), ModeDialect::Vortex);
        let coop = mode_from_node(node.get("pve"), ModeDialect::Vortex);
        let ranked = combine_modes([
            mode_from_node(node.get("rank_solo"), ModeDialect::Vortex),
            mode_from_node(node.get("rank_div2"), ModeDialect::Vortex),
            mode_from_node(node.get("rank_div3"), ModeDialect::Vortex),
        ]);
        let has_modes = [
            solo.is_some(),
            div2.is_some(),
            div3.is_some(),
            coop.is_some(),
            ranked.is_some(),
        ];
        Some(Self {
            ship_id,
            battles,
            wins: field(pvp, "wins"),
            damage_caused: field(pvp, "damage_dealt"),
            frags: field(pvp, "frags"),
            survived_battles: field(pvp, "survived"),
            last_battle_time: 0,
            xp: field(pvp, "xp"),
            modes: if has_modes.iter().any(|&b| b) {
                Some(ShipModeBreakdown {
                    solo,
                    div2,
                    div3,
                    coop,
                    ranked,
                })
            } else {
                None
            },
        })
    }
}

impl From<&RawShipStats> for PlayerShipStats {
    fn from(r: &RawShipStats) -> Self {
        let winrate = if r.battles > 0 {
            100.0 * r.wins as f32 / r.battles as f32
        } else {
            0.0
        };
        let avg_damage = if r.battles > 0 {
            r.damage_caused as f32 / r.battles as f32
        } else {
            0.0
        };
        PlayerShipStats {
            ship_id: r.ship_id,
            name: String::new(), // back-filled by caller
            battles: r.battles,
            wins: r.wins,
            damage_caused: r.damage_caused,
            frags: r.frags,
            survived_battles: r.survived_battles,
            winrate,
            avg_damage,
            last_battle_time: r.last_battle_time,
            // Same winrate→PR anchors as the account-level card, applied to
            // this ship's randoms winrate.
            pr: Some(super::wg_api::rating_from_winrate(winrate)),
            avg_xp: if r.xp > 0 && r.battles > 0 {
                Some(r.xp as f32 / r.battles as f32)
            } else {
                None
            },
            modes: r.modes.clone(),
        }
    }
}

/// Build a { ship_id → name } map from the encyclopedia cache (best-effort:
/// returns empty map if no version cache exists yet).
fn load_ship_name_map() -> std::collections::HashMap<i64, String> {
    let mut map = std::collections::HashMap::new();
    // Scan all versioned encyclopedia cache files.
    let dir = match appdata_dir_path() {
        Ok(d) => d.join("encyclopedia"),
        Err(_) => return map,
    };
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return map,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Skip info.json (it's the version metadata, not a ships list).
        if path.file_name().and_then(|n| n.to_str()) == Some("info.json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // CachedShips shape (we don't import the struct to avoid coupling;
        // just grab the ships array).
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(ships) = v.get("ships").and_then(|s| s.as_array()) {
                for ship in ships {
                    if let (Some(id), Some(name)) = (
                        ship.get("ship_id").and_then(|v| v.as_i64()),
                        ship.get("name").and_then(|v| v.as_str()),
                    ) {
                        map.insert(id, name.to_string());
                    }
                }
            }
        }
    }
    map
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

// ── shared helpers (same pattern as encyclopedia.rs) ─────────────────────

fn wg_client() -> Result<reqwest::Client, String> {
    crate::commands::network::build_http_client()
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct WgResponse<T> {
    status: String,
    data: Option<T>,
    #[serde(default)]
    error: WgError,
}
#[derive(Deserialize, Default)]
struct WgError {
    message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_ship_stats_from_wg_parses() {
        // Shape from /wows/ships/stats/ — note pvp subtree + mode splits.
        let entry = serde_json::json!({
            "ship_id": 4282948544_i64,
            "last_battle_time": 1700000000,
            "pvp": {
                "battles": 100,
                "wins": 55,
                "damage_dealt": 2500000,
                "frags": 80,
                "survived_battles": 30,
                "xp": 900000
            },
            "pvp_solo": { "battles": 60, "wins": 30, "damage_dealt": 1500000, "frags": 45, "survived_battles": 18 },
            "pvp_div2": { "battles": 30, "wins": 18, "damage_dealt": 750000, "frags": 25, "survived_battles": 9 },
            "pvp_div3": { "battles": 10, "wins": 7, "damage_dealt": 250000, "frags": 10, "survived_battles": 3 },
            "pve": { "battles": 5, "wins": 4, "damage_dealt": 100000, "frags": 6, "survived_battles": 2 },
            "rank_solo": { "battles": 12, "wins": 6, "damage_dealt": 300000, "frags": 10, "survived_battles": 4 },
            "rank_div2": { "battles": 8, "wins": 5, "damage_dealt": 200000, "frags": 7, "survived_battles": 3 },
            "rank_div3": null
        });
        let raw = RawShipStats::from_wg(&entry).unwrap();
        assert_eq!(raw.ship_id, 4282948544);
        assert_eq!(raw.battles, 100);
        assert_eq!(raw.wins, 55);
        assert_eq!(raw.damage_caused, 2500000);
        assert_eq!(raw.frags, 80);
        assert_eq!(raw.survived_battles, 30);
        assert_eq!(raw.xp, 900000);

        let stats = PlayerShipStats::from(&raw);
        assert!((stats.winrate - 55.0).abs() < 0.01);
        assert!((stats.avg_damage - 25000.0).abs() < 0.1);
        assert!((stats.avg_xp.unwrap() - 9000.0).abs() < 0.1);
        // Same anchors as the account PR: 55% falls between 52%→1350 and
        // 56%→1750, i.e. 1350 + 3/4*400 = 1650.
        assert_eq!(stats.pr, Some(1650));

        let modes = stats.modes.as_ref().expect("modes present");
        let solo = modes.solo.as_ref().unwrap();
        assert_eq!(solo.battles, 60);
        assert!((solo.winrate - 50.0).abs() < 0.01);
        let ranked = modes.ranked.as_ref().unwrap();
        assert_eq!(ranked.battles, 20, "rank_solo + rank_div2 merged");
        assert_eq!(ranked.wins, 11);
        assert!((ranked.winrate - 55.0).abs() < 0.01);
        assert_eq!(modes.coop.as_ref().unwrap().battles, 5);
    }

    #[test]
    fn raw_ship_stats_without_modes_yields_none_breakdown() {
        let entry = serde_json::json!({
            "ship_id": 1,
            "pvp": { "battles": 10, "wins": 5, "damage_dealt": 100000, "frags": 5, "survived_battles": 2 }
        });
        let raw = RawShipStats::from_wg(&entry).unwrap();
        assert!(raw.modes.is_none());
        let stats = PlayerShipStats::from(&raw);
        assert!(stats.modes.is_none());
        assert_eq!(stats.avg_xp, None, "no xp served → None");
    }

    #[test]
    fn raw_ship_stats_skips_zero_battles() {
        let entry = serde_json::json!({
            "ship_id": 1,
            "pvp": { "battles": 0, "wins": 0, "damage_dealt": 0, "frags": 0, "survived_battles": 0 }
        });
        assert!(RawShipStats::from_wg(&entry).is_none());
    }

    #[test]
    fn raw_ship_stats_skips_null_pvp() {
        let entry = serde_json::json!({ "ship_id": 1, "pvp": null });
        assert!(RawShipStats::from_wg(&entry).is_none());
    }

    #[test]
    fn raw_ship_stats_from_vortex_parses_cn_shape() {
        // Live-response shape: the ship id comes from the map key and pvp
        // carries vortex names; sparse counters arrive as null. Mode splits
        // use the same battle-type keys with vortex counter names.
        let node = serde_json::json!({
            "pvp": { "battles_count": 91, "wins": 31, "damage_dealt": null, "frags": null, "xp": 400000 },
            "pve": { "battles_count": 2, "wins": 1 },
            "pvp_solo": { "battles_count": 50, "wins": 17, "damage_dealt": 1000000 }
        });
        let raw = RawShipStats::from_vortex(4285445840, &node).unwrap();
        assert_eq!(raw.ship_id, 4285445840);
        assert_eq!(raw.battles, 91);
        assert_eq!(raw.wins, 31);
        assert_eq!(raw.damage_caused, 0);
        assert_eq!(raw.frags, 0);
        assert_eq!(raw.survived_battles, 0);
        assert_eq!(raw.last_battle_time, 0);
        assert_eq!(raw.xp, 400000);
        let modes = raw.modes.as_ref().expect("modes present");
        assert_eq!(modes.solo.as_ref().unwrap().battles, 50);
        assert!((modes.solo.as_ref().unwrap().winrate - 34.0).abs() < 0.01);
        assert_eq!(modes.coop.as_ref().unwrap().battles, 2);
        assert!(modes.ranked.is_none(), "no ranked nodes served");
        // Missing / null / zero-battle nodes are skipped like the WG path.
        assert!(RawShipStats::from_vortex(1, &serde_json::json!({})).is_none());
        assert!(RawShipStats::from_vortex(1, &serde_json::json!({ "pvp": null })).is_none());
        let zero = serde_json::json!({ "pvp": { "battles_count": 0, "wins": 0 } });
        assert!(RawShipStats::from_vortex(1, &zero).is_none());
    }

    fn mk_stats(ship_id: i64, battles: i64) -> PlayerShipStats {
        PlayerShipStats {
            ship_id,
            name: String::new(),
            battles,
            wins: battles / 2,
            damage_caused: battles * 10_000,
            frags: battles,
            survived_battles: battles / 3,
            winrate: 50.0,
            avg_damage: 10_000.0,
            last_battle_time: 1_700_000_000,
            pr: None,
            avg_xp: None,
            modes: None,
        }
    }

    /// Per-row PR follows the selected algorithm: winrate recomputes the
    /// anchor mapping; expected needs the table AND the ship's entry, and
    /// yields None otherwise (no silent fallback to the other algorithm).
    #[test]
    fn apply_pr_algo_switches_formula_per_algorithm() {
        let mut p = mk_stats(4282948544, 100);
        // mk_stats rows sit at 50% WR → between the 47%→750 and 52%→1350
        // anchors: 750 + 3/5·600 = 1110.
        apply_pr_algo(&mut p, PrAlgo::Winrate, &None);
        assert_eq!(p.pr, Some(1110));
        // Expected with no table (download failed / offline) → None ("--").
        apply_pr_algo(&mut p, PrAlgo::Expected, &None);
        assert_eq!(p.pr, None);
        // Expected with the ship in the table: mk_stats counters (50% WR,
        // 10k avg damage, 1.0 frags/battle) exactly meet these expected
        // values → the 1150 at-expected anchor.
        let table = std::collections::HashMap::from([(
            4282948544_i64,
            ExpectedValues {
                average_damage_dealt: 10_000.0,
                average_frags: 1.0,
                win_rate: 50.0,
            },
        )]);
        apply_pr_algo(&mut p, PrAlgo::Expected, &Some(table.clone()));
        assert_eq!(p.pr, Some(1150));
        // A ship missing from the table → None even with the table loaded.
        let mut other = mk_stats(999, 10);
        apply_pr_algo(&mut other, PrAlgo::Expected, &Some(table));
        assert_eq!(other.pr, None);
    }

    fn read_history_file(file: &str) -> Vec<ShipStatsHistoryPoint> {
        read_appdata_json(file)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Points within the merge window replace the latest point; points beyond
    /// it append; the JSON round-trips with camelCase fields intact.
    #[test]
    fn ship_history_appends_and_merges() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = format!("ship-history/test_{ts}.json");
        let _ = write_appdata_json(&file, "[]");

        let t0: i64 = 1_700_000_000;
        append_ship_history("test", ts as i64, &[mk_stats(1, 100)], t0);
        // Same session (< 6h apart) — merges into one point, latest timestamp.
        append_ship_history("test", ts as i64, &[mk_stats(1, 110)], t0 + 3600);
        // Exactly HISTORY_MERGE_SECS later — the window is exclusive, so this
        // appends rather than merges.
        append_ship_history(
            "test",
            ts as i64,
            &[mk_stats(1, 120)],
            t0 + 3600 + HISTORY_MERGE_SECS,
        );
        // Next day — appends another point.
        append_ship_history("test", ts as i64, &[mk_stats(1, 130)], t0 + 90_000);

        let history = read_history_file(&file);
        assert_eq!(history.len(), 3, "only same-session points merge");
        assert_eq!(history[0].timestamp, t0 + 3600);
        assert_eq!(history[0].ships.len(), 1);
        assert_eq!(history[0].ships[0].ship_id, 1);
        assert_eq!(history[0].ships[0].battles, 110);
        assert_eq!(history[0].ships[0].last_battle_time, 1_700_000_000);
        assert_eq!(history[1].timestamp, t0 + 3600 + HISTORY_MERGE_SECS);
        assert_eq!(history[2].timestamp, t0 + 90_000);
        assert_eq!(history[2].ships[0].battles, 130);

        let path = appdata_dir_path().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }

    /// Empty stats (hidden profile / transient WG hiccup) must never be
    /// recorded — an empty baseline would later turn the whole career into
    /// "recent" deltas, silently resurrecting the original bug.
    #[test]
    fn ship_history_ignores_empty_stats() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = format!("ship-history/test_{ts}.json");
        let _ = write_appdata_json(&file, "[]");

        let t0: i64 = 1_700_000_000;
        // Empty fetch inside the merge window — must not wipe the good point.
        append_ship_history("test", ts as i64, &[mk_stats(1, 100)], t0);
        append_ship_history("test", ts as i64, &[], t0 + 60);

        let history = read_history_file(&file);
        assert_eq!(history.len(), 1, "empty fetch must be ignored");
        assert_eq!(history[0].timestamp, t0);
        assert_eq!(history[0].ships[0].battles, 100);

        let path = appdata_dir_path().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }

    /// The history file is capped at HISTORY_MAX_POINTS, dropping the oldest.
    #[test]
    fn ship_history_caps_at_max_points() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = format!("ship-history/test_{ts}.json");
        let _ = write_appdata_json(&file, "[]");

        let t0: i64 = 1_700_000_000;
        for i in 0..(HISTORY_MAX_POINTS as i64 + 5) {
            // Step beyond the merge window so every point appends.
            append_ship_history("test", ts as i64, &[mk_stats(1, i)], t0 + i * 7 * 3600);
        }

        let history = read_history_file(&file);
        assert_eq!(history.len(), HISTORY_MAX_POINTS);
        // The oldest 5 points were dropped; the survivor with the smallest
        // timestamp is the 6th point written (battles = 5).
        assert_eq!(history[0].ships[0].battles, 5);
        assert_eq!(
            history.last().unwrap().ships[0].battles,
            HISTORY_MAX_POINTS as i64 + 4,
        );

        let path = appdata_dir_path().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }

    /// Snapshot append: write 3 snapshots, read back, expect length 3 in order.
    /// This exercises the read→push→write path directly (the async command
    /// wraps the same logic).
    #[test]
    fn snapshot_appends_not_overwrites() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = format!("snapshots/test_{ts}.json");
        // Start clean.
        let _ = write_appdata_json(&file, "[]");

        for i in 0..3 {
            let mut history: Vec<StatsSnapshot> = read_appdata_json(&file)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            history.push(StatsSnapshot {
                timestamp: i,
                game_version: "0.1.0".into(),
                battles: i * 100,
                wins: i * 50,
                winrate: 50.0,
                avg_damage: 1000.0 * (i + 1) as f32,
                pr: Some(1500),
            });
            let _ = write_appdata_json(&file, &serde_json::to_string(&history).unwrap());
        }

        let final_history: Vec<StatsSnapshot> = read_appdata_json(&file)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        assert_eq!(final_history.len(), 3, "should have 3 snapshots");
        assert_eq!(final_history[0].battles, 0);
        assert_eq!(final_history[1].battles, 100);
        assert_eq!(final_history[2].battles, 200);

        // Cleanup.
        let path = appdata_dir_path().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }
}
