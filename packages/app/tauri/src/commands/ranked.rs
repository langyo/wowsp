//! Ranked battle stats from the WG `/wows/seasons/` API.
//!
//! Two endpoints:
//!   - `/wows/seasons/info/` — list of ranked seasons (metadata only).
//!   - `/wows/seasons/accountinfo/` — a player's per-season ranked stats
//!     (battles, wins, rank, stars, damage, etc.).
//!
//! The data is returned as raw serde_json::Value because WG's ranked response
//! is deeply nested (seasons → shipType → pvp_solo/pvp_div3 → stats). The
//! frontend extracts what it needs; we just fetch + cache.

use serde::Deserialize;
use std::collections::HashMap;

/// Minimal WG API response envelope (status + data + optional error).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgResponse<T> {
    status: String,
    data: Option<T>,
    error: Option<WgError>,
}

#[derive(Deserialize, Default)]
struct WgError {
    message: Option<String>,
}

/// Shared WG application ID (same as wg_api.rs).
const WG_APP_ID: &str = "447ec579e994976e39dec0e7d0bac644";

/// Resolve a realm key to its WG API host.
fn realm_host(realm: &str) -> Result<&'static str, String> {
    match realm {
        "ru" => Ok("ru"),
        "eu" => Ok("eu"),
        "na" => Ok("com"),
        "asia" => Ok("asia"),
        _ => Err(format!("unknown realm: {realm}")),
    }
}

/// Build a reqwest client for WG API calls.
fn wg_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))
}

/// A player's ranked stats across seasons. The `seasons` map is keyed by
/// season ID, then by ship-type group ("0" = all types), then by battle mode
/// ("rank_solo" / "rank_div3"). We flatten the most useful fields.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedSeasonStats {
    pub season_id: i64,
    /// Human-readable season name, e.g. "Season 29". Derived from the
    /// season_id (WG API returns null for the name field).
    pub season_name: String,
    pub battles: i64,
    pub wins: i64,
    pub losses: i64,
    pub damage_dealt: i64,
    pub frags: i64,
    pub max_damage: i64,
    pub max_xp: i64,
    pub survived_battles: i64,
    pub planes_killed: i64,
    /// Current rank in the latest sprint (null if not played this season).
    pub current_rank: Option<i32>,
    /// Best rank achieved this season.
    pub best_rank: Option<i32>,
    /// Human-readable rank display, e.g. "Gold 3", "Silver 7", "Bronze 10".
    /// Derived from the league (1=gold, 2=silver, 3=bronze) + rank number.
    pub best_rank_display: Option<String>,
}

/// Map a league number (1/2/3) to its metal name.
fn league_name(league: i32) -> &'static str {
    match league {
        1 => "Gold",
        2 => "Silver",
        3 => "Bronze",
        _ => "Unknown",
    }
}

/// Format a rank display string: "Gold 3" or "Silver 10".
fn format_rank_display(league: i32, rank: i32) -> String {
    format!("{} {}", league_name(league), rank)
}

/// Fetch a player's ranked stats for the most recent N seasons.
///
/// Calls `/wows/seasons/info/` to get the season IDs, then
/// `/wows/seasons/accountinfo/` for the player's data. Returns a flat list
/// of per-season summaries (most recent first).
#[tauri::command]
pub async fn get_ranked_stats(
    account_id: i64,
    realm: String,
    season_count: Option<i64>,
) -> Result<Vec<RankedSeasonStats>, String> {
    let app_id = std::env::var("WOWSP_WG_APPLICATION_ID").unwrap_or_else(|_| WG_APP_ID.to_string());
    let host = realm_host(&realm)?;
    let client = wg_client()?;
    let n = season_count.unwrap_or(5).min(30) as usize;

    // 1. Get season IDs (sorted descending = most recent first).
    let seasons_url =
        format!("https://api.worldofwarships.{host}/wows/seasons/info/?application_id={app_id}");
    let seasons_resp: WgResponse<HashMap<i64, serde_json::Value>> = client
        .get(&seasons_url)
        .send()
        .await
        .map_err(|e| format!("seasons/info request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("seasons/info parse: {e}"))?;
    if seasons_resp.status != "ok" {
        return Err(format!(
            "seasons/info: {}",
            seasons_resp
                .error
                .and_then(|e| e.message)
                .unwrap_or_default()
        ));
    }
    let mut season_ids: Vec<i64> = seasons_resp
        .data
        .as_ref()
        .map(|d| d.keys().copied().collect())
        .unwrap_or_default();
    season_ids.sort_by(|a, b| b.cmp(a)); // descending
    let recent_ids: Vec<i64> = season_ids.into_iter().take(n).collect();
    if recent_ids.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Get the player's ranked stats for those seasons.
    let id_str: Vec<String> = recent_ids.iter().map(|i| i.to_string()).collect();
    let stats_url = format!(
        "https://api.worldofwarships.{host}/wows/seasons/accountinfo/?application_id={app_id}&account_id={account_id}&season_id={}",
        id_str.join(",")
    );
    let stats_resp: WgResponse<serde_json::Value> = client
        .get(&stats_url)
        .send()
        .await
        .map_err(|e| format!("seasons/accountinfo request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("seasons/accountinfo parse: {e}"))?;
    if stats_resp.status != "ok" {
        return Err(format!(
            "seasons/accountinfo: {}",
            stats_resp.error.and_then(|e| e.message).unwrap_or_default()
        ));
    }

    // 3. Flatten the nested response into per-season summaries.
    let player = stats_resp
        .data
        .as_ref()
        .and_then(|d| d.get(account_id.to_string()));
    let player = match player {
        Some(p) if !p.is_null() => p,
        _ => return Ok(Vec::new()),
    };

    let seasons_data = player.get("seasons");
    let rank_info = player.get("rank_info");
    let mut out = Vec::new();
    for sid in &recent_ids {
        let sid_str = sid.to_string();
        // Stats are under seasons.<id>.<shipType>.<mode>
        // Use shipType "0" (all) + mode "rank_solo" as the primary stats.
        let season_node = seasons_data.and_then(|s| s.get(&sid_str));
        let stats = season_node
            .and_then(|s| s.get("0")) // shipType "0" = all
            .and_then(|s| s.get("rank_solo")); // primary mode
        let stats = match stats {
            Some(s) if !s.is_null() => s,
            _ => continue, // no ranked data for this season
        };

        // Rank info: rank_info.<id>.<league>.<sprint>.{rank, rank_best}
        // Returns (current_rank, best_rank, best_league).
        let rank = extract_rank(rank_info, &sid_str);

        // Derive season name. WG API returns null for the name field, but
        // the community convention maps season IDs: 1001-1010 = seasons 1-10,
        // 1011-1020 = seasons 11-20, etc. Formula: (id - 1000).
        let season_num = sid - 1000;
        let season_name = format!("Season {}", season_num);

        out.push(RankedSeasonStats {
            season_id: *sid,
            season_name,
            battles: get_i64(stats, "battles"),
            wins: get_i64(stats, "wins"),
            losses: get_i64(stats, "losses"),
            damage_dealt: get_i64(stats, "damage_dealt"),
            frags: get_i64(stats, "frags"),
            max_damage: get_i64(stats, "max_damage_dealt"),
            max_xp: get_i64(stats, "max_xp"),
            survived_battles: get_i64(stats, "survived_battles"),
            planes_killed: get_i64(stats, "planes_killed"),
            current_rank: rank.as_ref().map(|r| r.0),
            best_rank: rank.as_ref().map(|r| r.1),
            best_rank_display: rank.map(|r| format_rank_display(r.2, r.1)),
        });
    }
    Ok(out)
}

/// Extract (current_rank, best_rank, best_league) from the rank_info structure.
/// Structure: rank_info.<seasonId>.<league>.<sprint>.{rank, rank_best}
/// league 1=Gold, 2=Silver, 3=Bronze. Returns the best (lowest-number = highest)
/// rank + its league.
fn extract_rank(rank_info: Option<&serde_json::Value>, season_id: &str) -> Option<(i32, i32, i32)> {
    let season = rank_info?.get(season_id)?;
    let mut best_current: Option<i32> = None;
    let mut best_ever: Option<i32> = None;
    let mut best_league: i32 = 3; // default to bronze (worst)
    if let Some(obj) = season.as_object() {
        for (league_str, sprints) in obj {
            let league: i32 = league_str.parse().unwrap_or(3);
            if let Some(sprint_obj) = sprints.as_object() {
                for (_sprint, info) in sprint_obj {
                    let r = info.get("rank").and_then(|v| v.as_i64()).map(|v| v as i32);
                    let rb = info
                        .get("rank_best")
                        .and_then(|v| v.as_i64())
                        .map(|v| v as i32);
                    if let Some(r) = r {
                        best_current = Some(best_current.map_or(r, |c| c.min(r)));
                    }
                    if let Some(rb) = rb {
                        // Track the best (lowest) rank + the league it was in.
                        // Lower league number = better league (1=gold > 2=silver > 3=bronze).
                        if best_ever.is_none_or(|b| rb < b || (rb == b && league < best_league)) {
                            best_ever = Some(rb);
                            best_league = league;
                        }
                    }
                }
            }
        }
    }
    match (best_current, best_ever) {
        (Some(c), Some(b)) => Some((c, b, best_league)),
        _ => None,
    }
}

fn get_i64(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}
