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
use wowsp_tauri_shared::{GameVersionInfo, PlayerShipStats, StatsSnapshot};

const WG_APP_ID: &str = "447ec579e994976e39dec0e7d0bac644";

/// Fetch (and cache) a player's per-ship PvP stats. `ship_name_map` is built
/// from the encyclopedia cache so each entry carries a readable name.
#[tauri::command]
pub async fn lookup_player_ship_stats(
    account_id: i64,
    realm: String,
) -> Result<Vec<PlayerShipStats>, String> {
    let cache_file = format!("ship-stats/{realm}_{account_id}.json");
    // We always re-fetch on demand (the player may have played new battles);
    // the cache is just a fallback when the API is unreachable.
    let name_map = load_ship_name_map();

    let result = fetch_ship_stats(account_id, &realm).await;
    let stats = match result {
        Ok(s) => {
            // Persist cache.
            let enriched: Vec<PlayerShipStats> = s
                .iter()
                .map(|raw| {
                    let mut p: PlayerShipStats = raw.into();
                    p.name = name_map.get(&raw.ship_id).cloned().unwrap_or_default();
                    p
                })
                .collect();
            let _ = appdata_write(
                cache_file.clone(),
                serde_json::to_string(&enriched).unwrap_or_default(),
            );
            enriched
        }
        Err(e) => {
            // Fallback to cache if the live API failed.
            if let Ok(Some(raw)) = appdata_read(cache_file) {
                if let Ok(cached) = serde_json::from_str::<Vec<PlayerShipStats>>(&raw) {
                    return Ok(cached);
                }
            }
            return Err(e);
        }
    };
    Ok(stats)
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
    let mut history: Vec<StatsSnapshot> = appdata_read(file.clone())
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
    let _ = appdata_write(file, serde_json::to_string(&history).unwrap_or_default());
    Ok(snap)
}

/// Read the snapshot history for an account (used by the trends module).
pub(crate) fn read_snapshots(realm: &str, account_id: i64) -> Vec<StatsSnapshot> {
    let file = format!("snapshots/{realm}_{account_id}.json");
    appdata_read(file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

// ── WG API fetch ────────────────────────────────────────────────────────

async fn fetch_ship_stats(account_id: i64, realm: &str) -> Result<Vec<RawShipStats>, String> {
    let app_id = std::env::var("WOWSP_WG_APPLICATION_ID").unwrap_or_else(|_| WG_APP_ID.to_string());
    let host = realm_host(realm)?;
    let client = wg_client()?;
    let url = format!(
        "https://api.worldofwarships.{host}/wows/ships/stats/?application_id={app_id}&account_id={account_id}&fields=ship_id,last_battle_time,pvp"
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
        }
    }
}

/// Build a { ship_id → name } map from the encyclopedia cache (best-effort:
/// returns empty map if no version cache exists yet).
fn load_ship_name_map() -> std::collections::HashMap<i64, String> {
    let mut map = std::collections::HashMap::new();
    // Scan all versioned encyclopedia cache files.
    let dir = match appdata_dir() {
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
    if let Ok(Some(raw)) = appdata_read("encyclopedia/info.json".into()) {
        if let Ok(v) = serde_json::from_str::<GameVersionInfo>(&raw) {
            return Ok(v);
        }
    }
    // Fall back to a live fetch via the encyclopedia command's path.
    crate::commands::encyclopedia::get_game_version_pub().await
}

// ── shared helpers (same pattern as encyclopedia.rs) ─────────────────────

fn wg_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("WoWSP/0.1 (https://github.com/celestia-island/wowsp)")
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn realm_host(realm: &str) -> Result<&'static str, String> {
    Ok(match realm {
        "ru" => "ru",
        "eu" => "eu",
        "na" => "com",
        "asia" => "asia",
        other => return Err(format!("unsupported realm '{other}'")),
    })
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn appdata_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs_next::data_dir().ok_or_else(|| "cannot resolve AppData dir".to_string())?;
    let dir = base.join("WoWSP");
    fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

fn appdata_read(file: String) -> Result<Option<String>, String> {
    let path = appdata_dir()?.join(&file);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

fn appdata_write(file: String, content: String) -> Result<(), String> {
    let dir = appdata_dir()?;
    let path = dir.join(&file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, &content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} → {path:?}: {e}"))?;
    Ok(())
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
        // Shape from /wows/ships/stats/ — note pvp subtree.
        let entry = serde_json::json!({
            "ship_id": 4282948544_i64,
            "last_battle_time": 1700000000,
            "pvp": {
                "battles": 100,
                "wins": 55,
                "damage_dealt": 2500000,
                "frags": 80,
                "survived_battles": 30
            }
        });
        let raw = RawShipStats::from_wg(&entry).unwrap();
        assert_eq!(raw.ship_id, 4282948544);
        assert_eq!(raw.battles, 100);
        assert_eq!(raw.wins, 55);
        assert_eq!(raw.damage_caused, 2500000);
        assert_eq!(raw.frags, 80);
        assert_eq!(raw.survived_battles, 30);

        let stats = PlayerShipStats::from(&raw);
        assert!((stats.winrate - 55.0).abs() < 0.01);
        assert!((stats.avg_damage - 25000.0).abs() < 0.1);
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
        let _ = appdata_write(file.clone(), "[]".into());

        for i in 0..3 {
            let mut history: Vec<StatsSnapshot> = appdata_read(file.clone())
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
            let _ = appdata_write(file.clone(), serde_json::to_string(&history).unwrap());
        }

        let final_history: Vec<StatsSnapshot> = appdata_read(file.clone())
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        assert_eq!(final_history.len(), 3, "should have 3 snapshots");
        assert_eq!(final_history[0].battles, 0);
        assert_eq!(final_history[1].battles, 100);
        assert_eq!(final_history[2].battles, 200);

        // Cleanup.
        let path = appdata_dir().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }
}
