//! Ranked battle stats from the WG `/wows/seasons/` API.
//!
//! Three endpoints:
//!   - `/wows/seasons/info/` — list of ranked seasons with per-season
//!     metadata (start/finish timestamps, per-league ship-tier windows).
//!   - `/wows/seasons/accountinfo/` — a player's per-season ranked stats
//!     (battles, wins, rank, stars, damage, etc.).
//!   - `/wows/seasons/shipstats/` — a player's PER-SHIP per-season ranked
//!     stats (the ship breakdown behind the season modal's ship table).
//!
//! The data is returned as raw serde_json::Value because WG's ranked response
//! is deeply nested (seasons → shipType → pvp_solo/pvp_div3 → stats). The
//! frontend extracts what it needs; we just fetch + cache.

use anyhow::{Result, anyhow};

use serde::Deserialize;
use std::collections::HashMap;

use wowsp_tauri_shared::CommandResult;

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

/// Build a reqwest client pair for WG API calls (proxy policy + direct
/// twin via network.rs).
fn wg_clients() -> Result<crate::commands::network::HttpPair> {
    crate::commands::network::HttpPair::build(|b| b.timeout(std::time::Duration::from_secs(15)))
        .map_err(|e| anyhow!("build reqwest client: {e}"))
}

/// One league's ship-tier window inside a season, from the seasons/info
/// metadata (`leagues.<n>.{min_ship_tier, max_ship_tier}`). A season
/// designates a different tier band per league (Gold often X+, Silver
/// VIII–IX, Bronze VI–VII), so the frontend's league filter maps a pick
/// onto this range instead of hosting a free tier slider.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedLeagueTiers {
    /// League number: 1 = Gold, 2 = Silver, 3 = Bronze.
    pub league: i32,
    pub min_tier: i32,
    pub max_tier: i32,
}

/// Per-season metadata the timeline UI needs beyond the player's stats:
/// the season's run window (unix seconds) and the league→tier map.
#[derive(Debug, Clone, Default)]
pub(crate) struct SeasonMeta {
    pub start_at: Option<i64>,
    pub finish_at: Option<i64>,
    pub leagues: Vec<RankedLeagueTiers>,
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
    /// League number of the best rank (1 = Gold, 2 = Silver, 3 = Bronze) —
    /// the localization key the frontend renders the rank display from
    /// (`best_rank_display` stays as the raw English fallback).
    pub best_league: Option<i32>,
    /// Human-readable rank display, e.g. "Gold 3", "Silver 7", "Bronze 10".
    /// Derived from the league (1=gold, 2=silver, 3=bronze) + rank number.
    pub best_rank_display: Option<String>,
    /// Season start (unix seconds) from the seasons/info metadata; null
    /// when the metadata was unavailable (the CN arm's best-effort fetch).
    pub start_at: Option<i64>,
    /// Season end (unix seconds) — see `start_at`.
    pub finish_at: Option<i64>,
    /// League→tier windows of this season (empty when metadata is missing).
    pub leagues: Vec<RankedLeagueTiers>,
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

/// Fetch a player's ranked stats (every listed season unless a window is
/// given).
///
/// Calls `/wows/seasons/info/` to get the season IDs + metadata, then
/// `/wows/seasons/accountinfo/` for the player's data. Returns a flat list
/// of per-season summaries (most recent first). `season_count = None`
/// covers EVERY season the API lists — the flatten drops the unplayed
/// ones — so a long ranked history stays complete; `Some(n)` keeps the
/// old "n most recent" window (clamped to 1..=30).
#[tauri::command]
pub async fn get_ranked_stats(
    account_id: i64,
    realm: String,
    season_count: Option<i64>,
) -> CommandResult<Vec<RankedSeasonStats>> {
    let window = season_count.map(|c| c.clamp(1, 30) as usize);
    // The CN cluster has no seasons API, but its vortex detail endpoint
    // embeds the same seasons/rank_info trees — `wg_api_cn::ranked_stats`
    // normalizes and flattens them through the shared path below (with a
    // best-effort metadata fetch from the international API for the date
    // labels).
    if realm == "cn" {
        return Ok(super::wg_api_cn::ranked_stats(account_id, window).await?);
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let clients = wg_clients()?;

    // 1. Get season IDs (sorted descending = most recent first) plus each
    //    season's metadata (run window + league tier windows).
    let seasons_url = format!("https://{host}/wows/seasons/info/?application_id={app_id}");
    let seasons_resp: WgResponse<HashMap<i64, serde_json::Value>> =
        super::upstream_health::recorded_get(&clients, host, "seasons/info", seasons_url)
            .await?
            .json()
            .await
            .map_err(|e| anyhow!("seasons/info parse: {e}"))?;
    if seasons_resp.status != "ok" {
        return Err(anyhow!(
            "seasons/info: {}",
            seasons_resp
                .error
                .and_then(|e| e.message)
                .unwrap_or_default()
        )
        .into());
    }
    let mut season_ids: Vec<i64> = Vec::new();
    let mut metas: HashMap<i64, SeasonMeta> = HashMap::new();
    if let Some(d) = seasons_resp.data.as_ref() {
        for (sid, v) in d {
            season_ids.push(*sid);
            metas.insert(*sid, parse_season_meta(v));
        }
    }
    season_ids.sort_by(|a, b| b.cmp(a)); // descending
    let recent_ids: Vec<i64> = match window {
        Some(n) => season_ids.into_iter().take(n).collect(),
        None => season_ids, // every listed season; unplayed ones drop in the flatten
    };
    if recent_ids.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Get the player's ranked stats for those seasons.
    let id_str: Vec<String> = recent_ids.iter().map(|i| i.to_string()).collect();
    let stats_url = format!(
        "https://{host}/wows/seasons/accountinfo/?application_id={app_id}&account_id={account_id}&season_id={}",
        id_str.join(",")
    );
    let stats_resp: WgResponse<serde_json::Value> =
        super::upstream_health::recorded_get(&clients, host, "seasons/accountinfo", stats_url)
            .await?
            .json()
            .await
            .map_err(|e| anyhow!("seasons/accountinfo parse: {e}"))?;
    if stats_resp.status != "ok" {
        return Err(anyhow!(
            "seasons/accountinfo: {}",
            stats_resp.error.and_then(|e| e.message).unwrap_or_default()
        )
        .into());
    }

    // 3. Flatten the nested response into per-season summaries.
    let player = stats_resp
        .data
        .as_ref()
        .and_then(|d| d.get(account_id.to_string()));
    let Some(player) = player.filter(|p| !p.is_null()) else {
        return Ok(Vec::new());
    };
    Ok(flatten_ranked_seasons(player, &recent_ids, &metas))
}

/// Season metadata (dates + league tier windows) for the CN cluster: it has
/// no `/wows/seasons/**` API, so the metadata comes from the ASIA arm —
/// the same convention `encyclopedia_host` uses, since season ids and their
/// schedules are cluster-wide. Best-effort by design: any failure yields an
/// empty map and the UI just hides the date labels / league filter. The
/// answer is memoized for an hour — the metadata is per-season static and
/// the CN ranked load otherwise pays one extra roundtrip per fetch.
pub(crate) async fn cn_season_metas() -> HashMap<i64, SeasonMeta> {
    const MEMO_TTL: std::time::Duration = std::time::Duration::from_secs(3600);
    static MEMO: std::sync::Mutex<Option<(std::time::Instant, HashMap<i64, SeasonMeta>)>> =
        std::sync::Mutex::new(None);
    if let Some((at, metas)) = MEMO.lock().map(|m| m.clone()).unwrap_or(None) {
        if at.elapsed() < MEMO_TTL {
            return metas;
        }
    }
    let metas = fetch_cn_season_metas().await;
    if let Ok(mut memo) = MEMO.lock() {
        if !metas.is_empty() {
            // A failed probe (empty map) is not memoized — the next ranked
            // load retries; a live one holds for the hour.
            *memo = Some((std::time::Instant::now(), metas.clone()));
        }
    }
    metas
}

/// The uncached CN metadata probe. See [`cn_season_metas`].
async fn fetch_cn_season_metas() -> HashMap<i64, SeasonMeta> {
    let Ok(host) = super::wg_realm::api_host("asia") else {
        return HashMap::new();
    };
    let app_id = super::wg_realm::application_id("asia");
    let Ok(clients) = wg_clients() else {
        return HashMap::new();
    };
    let url = format!("https://{host}/wows/seasons/info/?application_id={app_id}");
    let Ok(resp) = super::upstream_health::recorded_get(&clients, host, "seasons/info", url).await
    else {
        return HashMap::new();
    };
    let Ok(parsed) = resp
        .json::<WgResponse<HashMap<i64, serde_json::Value>>>()
        .await
    else {
        return HashMap::new();
    };
    let mut metas = HashMap::new();
    if parsed.status == "ok" {
        if let Some(d) = parsed.data {
            for (sid, v) in d {
                metas.insert(sid, parse_season_meta(&v));
            }
        }
    }
    metas
}

/// Fetch a player's per-ship per-season ranked stats — the ship breakdown
/// behind the season modal's ship table.
///
/// International realms read the undocumented-but-stable
/// `/wows/seasons/shipstats/` endpoint: one entry per ship the player ever
/// fielded in ranked, each carrying that ship's stats per season
/// (`seasons.<id>."0".{rank_solo, rank_div2, rank_div3}`). The solo/div
/// mode nodes are merged here so the frontend receives one flat
/// ship×season list.
///
/// CN has no arm for this (the vortex mirror aggregates per ship TYPE only,
/// never per ship), so it returns an empty list — the frontend falls back
/// to the career ranked split of its per-ship table for that realm.
#[tauri::command]
pub async fn get_ranked_ship_stats(
    account_id: i64,
    realm: String,
) -> CommandResult<Vec<RankedShipSeasonStats>> {
    if realm == "cn" {
        return Ok(Vec::new());
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let clients = wg_clients()?;
    let url = format!(
        "https://{host}/wows/seasons/shipstats/?application_id={app_id}&account_id={account_id}"
    );
    let resp: WgResponse<serde_json::Value> =
        super::upstream_health::recorded_get(&clients, host, "seasons/shipstats", url)
            .await?
            .json()
            .await
            .map_err(|e| anyhow!("seasons/shipstats parse: {e}"))?;
    if resp.status != "ok" {
        return Err(anyhow!(
            "seasons/shipstats: {}",
            resp.error.and_then(|e| e.message).unwrap_or_default()
        )
        .into());
    }
    let entries = resp
        .data
        .as_ref()
        .and_then(|d| d.get(account_id.to_string()));
    let Some(entries) = entries.filter(|e| !e.is_null()) else {
        return Ok(Vec::new());
    };
    Ok(flatten_ranked_ship_seasons(entries))
}

/// One battle-mode slice of a ship's season (solo / div2 / div3 ranked) —
/// enough for the frontend's mode-filter chips to work truthfully on the
/// season slice.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedShipModeSplit {
    pub battles: i64,
    pub wins: i64,
}

/// One ship's ranked stats in one season — the season modal's ship-table
/// row. The rank_solo/rank_div2/rank_div3 mode nodes arrive merged into
/// the totals, with the per-mode splits alongside (`div2`/`div3` are null
/// unless actually played).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedShipSeasonStats {
    pub ship_id: i64,
    pub season_id: i64,
    pub battles: i64,
    pub wins: i64,
    pub losses: i64,
    pub damage_dealt: i64,
    pub frags: i64,
    pub survived_battles: i64,
    pub planes_killed: i64,
    pub xp: i64,
    pub max_damage: i64,
    pub max_xp: i64,
    pub solo: RankedShipModeSplit,
    pub div2: Option<RankedShipModeSplit>,
    pub div3: Option<RankedShipModeSplit>,
}

/// Flatten the `/wows/seasons/shipstats/` per-ship entries into one
/// ship×season row per (ship, season) with merged battle modes. Rows with
/// zero battles (empty mode nodes) are dropped; output is deterministic
/// (season desc, then battles desc). Pure — unit-tested.
pub(crate) fn flatten_ranked_ship_seasons(
    entries: &serde_json::Value,
) -> Vec<RankedShipSeasonStats> {
    let mut out: Vec<RankedShipSeasonStats> = Vec::new();
    let Some(list) = entries.as_array() else {
        return out;
    };
    for entry in list {
        let Some(ship_id) = entry.get("ship_id").and_then(|v| v.as_i64()) else {
            continue;
        };
        let Some(seasons) = entry.get("seasons").and_then(|v| v.as_object()) else {
            continue;
        };
        for (sid, types) in seasons {
            let Ok(season_id) = sid.parse::<i64>() else {
                continue;
            };
            // The ship-type level is "0" (all types) in practice; merge
            // whatever type groups appear so nothing is silently dropped.
            let Some(types) = types.as_object() else {
                continue;
            };
            // The per-mode maps (rank_solo / rank_div2 / rank_div3) of every
            // (practically single) ship-type group, plus the flat list of
            // the stats nodes they hold.
            let groups: Vec<&serde_json::Map<String, serde_json::Value>> =
                types.values().filter_map(|t| t.as_object()).collect();
            let nodes: Vec<&serde_json::Value> = groups.iter().flat_map(|g| g.values()).collect();
            let battles: i64 = nodes
                .iter()
                .map(|m| m.get("battles").and_then(|v| v.as_i64()).unwrap_or(0))
                .sum();
            if battles == 0 {
                continue;
            }
            let sum = |key: &str| -> i64 {
                nodes
                    .iter()
                    .map(|m| m.get(key).and_then(|v| v.as_i64()).unwrap_or(0))
                    .sum()
            };
            // Maxima are per-battle records — a max is merged with max,
            // never with a sum (div2/div3 nodes would inflate them).
            let max_of = |key: &str| -> i64 {
                nodes
                    .iter()
                    .map(|m| m.get(key).and_then(|v| v.as_i64()).unwrap_or(0))
                    .max()
                    .unwrap_or(0)
            };
            let split = |key: &str| -> Option<RankedShipModeSplit> {
                let node = groups
                    .iter()
                    .find_map(|g| g.get(key))
                    .filter(|n| !n.is_null())?;
                Some(RankedShipModeSplit {
                    battles: node.get("battles").and_then(|v| v.as_i64()).unwrap_or(0),
                    wins: node.get("wins").and_then(|v| v.as_i64()).unwrap_or(0),
                })
            };
            out.push(RankedShipSeasonStats {
                ship_id,
                season_id,
                battles,
                wins: sum("wins"),
                losses: sum("losses"),
                damage_dealt: sum("damage_dealt"),
                frags: sum("frags"),
                survived_battles: sum("survived_battles"),
                planes_killed: sum("planes_killed"),
                xp: sum("xp"),
                max_damage: max_of("max_damage_dealt"),
                max_xp: max_of("max_xp"),
                solo: split("rank_solo").unwrap_or(RankedShipModeSplit {
                    battles: 0,
                    wins: 0,
                }),
                div2: split("rank_div2").filter(|s| s.battles > 0),
                div3: split("rank_div3").filter(|s| s.battles > 0),
            });
        }
    }
    out.sort_by(|a, b| {
        b.season_id
            .cmp(&a.season_id)
            .then(b.battles.cmp(&a.battles))
    });
    out
}

/// Curated league→tier windows for the early seasons of the ranked rework
/// (ids 1001–1011), whose upstream `seasons/info` metadata is untrustworthy:
/// WG serves every league of those seasons as the full ship-tier span
/// (min 1, max 10), which never matched the actual season design — a real
/// league window spans one or two tiers. The values below are the official
/// per-season rules from the Wargaming/Lesta season documentation (the EN
/// `Ship:Ranked_Battles` wiki article's season sections, cross-checked
/// against the RU wiki's per-season articles and the 0.9.12 / 0.10.10 patch
/// notes; the two wikis agree on every season). From Season 12 on the
/// upstream metadata is trustworthy (Season 12's upstream values equal the
/// wiki's rule exactly), so those seasons stay upstream-fed.
///
/// League numbers: 1 = Gold, 2 = Silver, 3 = Bronze; tier 11 = supership
/// (Seasons 5 and 9 admitted superships alongside the tier-X windows).
fn curated_league_tiers(season_id: i64) -> Option<Vec<RankedLeagueTiers>> {
    // (league, min tier, max tier) per season.
    let rows: &[(i32, i32, i32)] = match season_id {
        // S1 (rework pilot): Bronze VIII, Silver IX–X, Gold X.
        1001 => &[(1, 10, 10), (2, 9, 10), (3, 8, 8)],
        // S2: Bronze VIII–IX, Silver IX–X, Gold X.
        1002 => &[(1, 10, 10), (2, 9, 10), (3, 8, 9)],
        // S3: Bronze VI–VII, Silver VIII–IX, Gold X.
        1003 => &[(1, 10, 10), (2, 8, 9), (3, 6, 7)],
        // S4: Bronze VI, Silver VIII, Gold X.
        1004 => &[(1, 10, 10), (2, 8, 8), (3, 6, 6)],
        // S5: tier X + superships in every league.
        1005 => &[(1, 10, 11), (2, 10, 11), (3, 10, 11)],
        // S6: Bronze VI–VII, Silver VIII–IX, Gold X.
        1006 => &[(1, 10, 10), (2, 8, 9), (3, 6, 7)],
        // S7: VIII–IX across the board.
        1007 => &[(1, 8, 9), (2, 8, 9), (3, 8, 9)],
        // S8: tier X across the board, 6v6.
        1008 => &[(1, 10, 10), (2, 10, 10), (3, 10, 10)],
        // S9: Bronze V, Silver VI–VII, Gold X + superships.
        1009 => &[(1, 10, 11), (2, 6, 7), (3, 5, 5)],
        // S10: Bronze VI, Silver VIII, Gold IX–X.
        1010 => &[(1, 9, 10), (2, 8, 8), (3, 6, 6)],
        // S11: Bronze VIII–IX, Silver VIII–IX, Gold X.
        1011 => &[(1, 10, 10), (2, 8, 9), (3, 8, 9)],
        _ => return None,
    };
    Some(
        rows.iter()
            .map(|(league, min, max)| RankedLeagueTiers {
                league: *league,
                min_tier: *min,
                max_tier: *max,
            })
            .collect(),
    )
}

/// Parse one `/wows/seasons/info/` data value into the metadata the UI
/// needs. Tolerates missing fields (older seasons, partial responses) —
/// everything degrades to None/empty. Pure — unit-tested.
pub(crate) fn parse_season_meta(v: &serde_json::Value) -> SeasonMeta {
    let start_at = v.get("start_at").and_then(|x| x.as_i64());
    let finish_at = v.get("finish_at").and_then(|x| x.as_i64());
    let mut leagues: Vec<RankedLeagueTiers> = Vec::new();
    if let Some(obj) = v.get("leagues").and_then(|x| x.as_object()) {
        for (k, l) in obj {
            let Ok(league) = k.parse::<i32>() else {
                continue;
            };
            // The UI's league filter only knows the three metals.
            if !(1..=3).contains(&league) {
                continue;
            }
            let min = l.get("min_ship_tier").and_then(|x| x.as_i64());
            let max = l.get("max_ship_tier").and_then(|x| x.as_i64());
            if let (Some(min), Some(max)) = (min, max) {
                let (min, max) = (min as i32, max as i32);
                if (1..=11).contains(&min) && (1..=11).contains(&max) {
                    leagues.push(RankedLeagueTiers {
                        league,
                        min_tier: min.min(max),
                        max_tier: min.max(max),
                    });
                }
            }
        }
        leagues.sort_by_key(|l| l.league);
    }
    // Seasons 1–11's upstream league windows are the bogus full 1–10 span
    // for every league (see `curated_league_tiers`) — replace them with the
    // documented season rules wholesale.
    if let Some(curated) = v
        .get("season_id")
        .and_then(|x| x.as_i64())
        .and_then(curated_league_tiers)
    {
        leagues = curated;
    }
    SeasonMeta {
        start_at,
        finish_at,
        leagues,
    }
}

/// Flatten the WG-shaped ranked trees of one player node into per-season
/// summaries, most recent first. Shared by the WG seasons API path and the
/// CN vortex path (`wg_api_cn::ranked_stats` feeds a synthetic node with the
/// same `seasons` / `rank_info` layout). Seasons without playable stats are
/// skipped. Pure — unit-tested.
pub(crate) fn flatten_ranked_seasons(
    player: &serde_json::Value,
    recent_ids: &[i64],
    metas: &HashMap<i64, SeasonMeta>,
) -> Vec<RankedSeasonStats> {
    let seasons_data = player.get("seasons");
    let rank_info = player.get("rank_info");
    let mut out = Vec::new();
    for sid in recent_ids {
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
        let meta = metas.get(sid);

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
            best_league: rank.as_ref().map(|r| r.2),
            best_rank_display: rank.map(|r| format_rank_display(r.2, r.1)),
            start_at: meta.and_then(|m| m.start_at),
            finish_at: meta.and_then(|m| m.finish_at),
            leagues: meta.map(|m| m.leagues.clone()).unwrap_or_default(),
        });
    }
    out
}

/// Extract (current_rank, best_rank, best_league) from the rank_info structure.
///
/// Verified against the live API: `rank_info.<seasonId>.<sprint>.<league>.{rank,
/// rank_best, sprint_number, …}` — the OUTER key is the sprint index (0-based),
/// the INNER key is the league (1 = Gold, 2 = Silver, 3 = Bronze).
///
/// "Best" = the highest league reached, then the best (lowest) rank inside it
/// (Silver 9 outranks Bronze 1, matching community sites). "Current" = the
/// snapshot from the latest sprint with activity. Zero ranks are placeholders
/// (the CN vortex answers with all-zero nodes, e.g. under a "-1" sprint key)
/// and never count as data.
fn extract_rank(rank_info: Option<&serde_json::Value>, season_id: &str) -> Option<(i32, i32, i32)> {
    let season = rank_info?.get(season_id)?;
    let mut best_league: Option<i32> = None;
    let mut best_rank = i32::MAX;
    let mut latest: Option<(i32, i32, i32)> = None; // (sprint, league, rank)

    if let Some(sprints) = season.as_object() {
        for (sprint_key, leagues) in sprints {
            let sprint_no: i32 = sprint_key.parse().unwrap_or(0);
            if let Some(league_obj) = leagues.as_object() {
                for (league_key, info) in league_obj {
                    let league: i32 = league_key.parse().unwrap_or(99);
                    let rb = info
                        .get("rank_best")
                        .and_then(|v| v.as_i64())
                        .filter(|v| *v > 0)
                        .map(|v| v as i32);
                    let r = info
                        .get("rank")
                        .and_then(|v| v.as_i64())
                        .filter(|v| *v > 0)
                        .map(|v| v as i32);
                    if let Some(rb) = rb {
                        // Lower league number = better (1 gold > 2 silver > 3 bronze);
                        // within a league, lower rank number = better.
                        if best_league
                            .is_none_or(|bl| league < bl || (league == bl && rb < best_rank))
                        {
                            best_league = Some(league);
                            best_rank = rb;
                        }
                    }
                    if let Some(rr) = r {
                        // The latest sprint with any data; within a sprint the
                        // furthest league (lowest number) is where they ended.
                        if latest.is_none_or(|(_, l, _)| league < l)
                            || latest.is_none_or(|(s, _, _)| sprint_no > s)
                        {
                            latest = Some((sprint_no, league, rr));
                        }
                    }
                }
            }
        }
    }

    let bl = best_league?;
    Some((
        latest.map(|(_, _, r)| r).unwrap_or(best_rank),
        best_rank,
        bl,
    ))
}

fn get_i64(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_skips_empty_seasons_and_names_the_rest() {
        let player = serde_json::json!({
            "seasons": {
                "1030": { "0": { "rank_solo": { "battles": 53, "wins": 33 } } },
                "1029": { "0": { "rank_solo": { "battles": 108, "wins": 54 } } },
                // a season key with no playable stats is skipped, not
                // zero-filled (matches how WG omits unplayed seasons)
                "1028": {}
            },
            "rank_info": { "1030": { "1": { "2": { "rank": 9, "rank_best": 9 } } } }
        });
        let out = flatten_ranked_seasons(&player, &[1030, 1029, 1028], &HashMap::new());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].season_id, 1030);
        assert_eq!(out[0].season_name, "Season 30");
        assert_eq!(out[0].battles, 53);
        assert_eq!(out[0].wins, 33);
        assert_eq!(out[0].best_rank_display.as_deref(), Some("Silver 9"));
        assert_eq!(out[0].best_league, Some(2));
        // No metadata served → the date/league fields stay empty.
        assert_eq!(out[0].start_at, None);
        assert!(out[0].leagues.is_empty());
        assert!(!out.iter().any(|s| s.season_id == 1028));
    }

    #[test]
    fn flatten_attaches_season_metadata() {
        let player = serde_json::json!({
            "seasons": { "1030": { "0": { "rank_solo": { "battles": 53, "wins": 33 } } } },
            "rank_info": {}
        });
        let mut metas = HashMap::new();
        metas.insert(
            1030,
            SeasonMeta {
                start_at: Some(1_752_624_000),
                finish_at: Some(1_757_404_800),
                leagues: vec![
                    RankedLeagueTiers {
                        league: 1,
                        min_tier: 9,
                        max_tier: 10,
                    },
                    RankedLeagueTiers {
                        league: 3,
                        min_tier: 6,
                        max_tier: 6,
                    },
                ],
            },
        );
        let out = flatten_ranked_seasons(&player, &[1030], &metas);
        assert_eq!(out[0].start_at, Some(1_752_624_000));
        assert_eq!(out[0].finish_at, Some(1_757_404_800));
        assert_eq!(out[0].leagues.len(), 2);
        assert_eq!(out[0].leagues[0].league, 1);
    }

    #[test]
    fn extract_rank_ignores_zero_placeholder_nodes() {
        // The CN vortex embeds all-zero nodes (e.g. under a "-1" sprint key);
        // zero ranks must never win best/latest.
        let info = serde_json::json!({
            "1024": {
                "-1": { "0": { "rank": 0, "rank_best": 0 } },
                "1": { "3": { "rank": 5, "rank_best": 5 } },
                "2": { "3": { "rank": 10, "rank_best": 0 } }
            }
        });
        let rank = extract_rank(Some(&info), "1024").expect("rank from real sprints");
        assert_eq!(rank, (10, 5, 3)); // current, best, league (3 = Bronze)
        // A season with only placeholder nodes yields nothing at all.
        let zeros = serde_json::json!({ "1025": { "-1": { "0": { "rank": 0, "rank_best": 0 } } } });
        assert!(extract_rank(Some(&zeros), "1025").is_none());
    }

    #[test]
    fn parse_season_meta_reads_dates_and_tier_windows() {
        let meta = parse_season_meta(&serde_json::json!({
            "season_id": 1030,
            "start_at": 1_752_624_000,
            "finish_at": 1_757_404_800,
            "leagues": {
                "2": { "min_ship_tier": 7, "max_ship_tier": 8 },
                "1": { "min_ship_tier": 9, "max_ship_tier": 10 },
                "9": { "min_ship_tier": 1, "max_ship_tier": 11 }
            }
        }));
        assert_eq!(meta.start_at, Some(1_752_624_000));
        assert_eq!(meta.finish_at, Some(1_757_404_800));
        // Sorted by league number; unknown league keys and out-of-range
        // tiers are dropped (the filter only knows 1-3 and tiers 1-11).
        assert_eq!(meta.leagues.len(), 2);
        assert_eq!(meta.leagues[0].league, 1);
        assert_eq!(meta.leagues[0].min_tier, 9);
        assert_eq!(meta.leagues[1].league, 2);
        assert_eq!(meta.leagues[1].max_tier, 8);
        // Missing/empty nodes degrade to an empty meta.
        let empty = parse_season_meta(&serde_json::json!({}));
        assert_eq!(empty.start_at, None);
        assert!(empty.leagues.is_empty());
    }

    #[test]
    fn parse_season_meta_overrides_bogus_league_windows_with_curated_rules() {
        // What WG actually serves for seasons 1–11: every league claims the
        // full ship-tier span. The curated season rules must replace that.
        let meta = parse_season_meta(&serde_json::json!({
            "season_id": 1008,
            "start_at": 1_657_762_800,
            "finish_at": 1_664_946_000,
            "leagues": {
                "1": { "min_ship_tier": 1, "max_ship_tier": 10 },
                "2": { "min_ship_tier": 1, "max_ship_tier": 10 },
                "3": { "min_ship_tier": 1, "max_ship_tier": 10 }
            }
        }));
        let win = |lg: i32| {
            meta.leagues
                .iter()
                .find(|l| l.league == lg)
                .map(|l| (l.min_tier, l.max_tier))
        };
        // Season 8 ran tier X in every league, 6v6.
        assert_eq!(win(1), Some((10, 10)));
        assert_eq!(win(2), Some((10, 10)));
        assert_eq!(win(3), Some((10, 10)));

        // Season 9's leagues ran wildly different bands (Gold X +
        // superships, Silver VI–VII, Bronze V) — none of it upstream-served.
        let meta = parse_season_meta(&serde_json::json!({
            "season_id": 1009,
            "leagues": { "1": { "min_ship_tier": 1, "max_ship_tier": 10 } }
        }));
        let win = |lg: i32| {
            meta.leagues
                .iter()
                .find(|l| l.league == lg)
                .map(|l| (l.min_tier, l.max_tier))
        };
        assert_eq!(win(1), Some((10, 11))); // superships read as tier 11
        assert_eq!(win(2), Some((6, 7)));
        assert_eq!(win(3), Some((5, 5)));
    }

    #[test]
    fn parse_season_meta_keeps_upstream_windows_from_season_twelve_on() {
        // Season 12's upstream metadata matches the historical rule (tier X
        // everywhere) and later seasons are trustworthy — no curated rows
        // exist for them, so upstream wins.
        let meta = parse_season_meta(&serde_json::json!({
            "season_id": 1030,
            "leagues": {
                "1": { "min_ship_tier": 9, "max_ship_tier": 10 },
                "2": { "min_ship_tier": 7, "max_ship_tier": 8 },
                "3": { "min_ship_tier": 6, "max_ship_tier": 6 }
            }
        }));
        assert_eq!(meta.leagues.len(), 3);
        assert_eq!(meta.leagues[1].min_tier, 7);

        // A payload without a season id keeps upstream data too.
        let meta = parse_season_meta(&serde_json::json!({
            "leagues": { "1": { "min_ship_tier": 9, "max_ship_tier": 10 } }
        }));
        assert_eq!(meta.leagues.len(), 1);
    }

    #[test]
    fn curated_league_windows_stay_sane() {
        // Every curated season carries all three metals with one/two-tier
        // windows (tier 11 = superships riding along with X). A wider span
        // than that is the upstream garbage this table exists to replace.
        for sid in 1001..=1011 {
            let rows = curated_league_tiers(sid).expect("curated rows");
            assert_eq!(rows.len(), 3, "season {sid}");
            for r in rows {
                assert!((1..=11).contains(&r.min_tier) && (1..=11).contains(&r.max_tier));
                assert!(r.min_tier <= r.max_tier);
                assert!(
                    r.max_tier - r.min_tier <= 2,
                    "season {sid} league {} spans {}",
                    r.league,
                    r.max_tier - r.min_tier
                );
            }
        }
        // Season 12+ stay upstream-fed.
        assert!(curated_league_tiers(1012).is_none());
        assert!(curated_league_tiers(999).is_none());
    }

    #[test]
    fn ship_seasons_merge_modes_and_skip_zero_rows() {
        let entries = serde_json::json!([
            {
                "account_id": 1,
                "ship_id": 4286461936i64,
                "seasons": {
                    "1015": { "0": {
                        "rank_solo": { "battles": 40, "wins": 24, "damage_dealt": 1_610_611, "frags": 43, "max_damage_dealt": 210_000, "max_xp": 3_000, "xp": 94_480, "survived_battles": 18, "planes_killed": 213 },
                        "rank_div2": null,
                        "rank_div3": {}
                    } },
                    "1014": { "0": { "rank_solo": { "battles": 10, "wins": 4 } } }
                }
            },
            // A ship whose only node is empty never surfaces.
            { "ship_id": 111, "seasons": { "1015": { "0": { "rank_solo": {} } } } },
            // Division battles merge into the solo ones and keep their own
            // splits (the frontend's mode chips read them).
            { "ship_id": 222, "seasons": { "1013": { "0": {
                "rank_solo": { "battles": 10, "wins": 5 },
                "rank_div3": { "battles": 2, "wins": 2, "damage_dealt": 50_000, "max_damage_dealt": 40_000 }
            } } } }
        ]);
        let out = flatten_ranked_ship_seasons(&entries);
        assert_eq!(out.len(), 3);
        // Deterministic order: season desc, then battles desc.
        assert_eq!(out[0].ship_id, 4286461936);
        assert_eq!(out[0].season_id, 1015);
        assert_eq!(out[0].battles, 40);
        assert_eq!(out[0].max_damage, 210_000);
        assert_eq!(out[0].solo.battles, 40);
        assert_eq!(out[0].div2, None);
        // Season 1014 sorts ahead of 1013 despite fewer battles.
        assert_eq!(out[1].ship_id, 4286461936);
        assert_eq!(out[1].season_id, 1014);
        assert_eq!(out[1].solo.battles, 10);
        assert_eq!(out[2].ship_id, 222);
        assert_eq!(out[2].season_id, 1013);
        assert_eq!(out[2].battles, 12);
        assert_eq!(out[2].wins, 7);
        assert_eq!(out[2].damage_dealt, 50_000);
        // The per-battle record takes the MAX across modes, not the sum.
        assert_eq!(out[2].max_damage, 40_000);
        assert_eq!(out[2].solo.battles, 10);
        assert_eq!(out[2].div3.as_ref().map(|s| s.battles), Some(2));
        // A non-array payload yields nothing.
        assert!(flatten_ranked_ship_seasons(&serde_json::json!(null)).is_empty());
    }
}
