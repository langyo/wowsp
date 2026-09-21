//! CN realm lookups over the vortex endpoints backing profile.wowsgame.cn.
//!
//! The CN cluster (wowsgame.cn, operated by 360) has no WG public API —
//! `/wows/**` doesn't exist there. Its player/clan stats are served by the
//! same anonymous vortex endpoints the official profile site calls
//! (verified against the live service):
//!
//!   search  GET https://vortex.wowsgame.cn/api/accounts/search/<name>/?limit=10
//!   suggest GET https://vortex.wowsgame.cn/api/accounts/search/autocomplete/<name>/
//!   info    GET https://vortex.wowsgame.cn/api/accounts/<id>/
//!   clan    GET https://vortex.wowsgame.cn/api/accounts/<id>/clans/   (404 = no clan)
//!   ships   GET https://vortex.wowsgame.cn/api/accounts/<id>/ships/   (ship_stats.rs)
//!   clan    GET https://clans.wowsgame.cn/api/clanbase/<id>/claninfo/
//!   roster  GET https://clans.wowsgame.cn/api/members/<id>/?battle_type=pvp
//!   clans   GET https://clans.wowsgame.cn/api/search/autocomplete/?search=<q>&type=clans
//!
//! Vortex field names differ from the WG API (`battles_count` vs `battles`,
//! `shots_by_main` vs `main_battery.shots`, `survived` vs
//! `survived_battles`, stats nested under `statistics.basic` for leveling…),
//! so every response is normalized into the WG account/info shape first and
//! the downstream parsers (`PvpStats::extract`, the dog-tag helper) are
//! reused verbatim — one extraction path, two transports.
//!
//! Server quirks handled here:
//!   - queries shorter than 3 characters answer `{"status":"error","error":"Bad
//!     Request"}` (the official profile site enforces the same 3–24 floor in
//!     its own UI); the interactive lookups surface them as a structured
//!     account-not-found error (see `lookup_error`),
//!   - the clan endpoint answers 404 for clanless accounts (the API realms
//!     return an empty object instead),
//!   - occasional 503s on autocomplete degrade to an empty suggestion list.

use std::time::Duration;

use futures::stream::{self, StreamExt};
use wowsp_tauri_shared::{
    ClanInfo, ClanMember, ClanMemberStats, ClanSuggestion, PlayerStats, PlayerSuggestion,
};

use super::lookup_error::LookupError;
use super::wg_api::{PrAlgo, PvpStats, compute_pr, encode_query, nickname_matches, parse_dog_tag};
use super::wg_realm;

/// Concurrency cap for the batch name→account resolution, mirroring the WG
/// path (the vortex service is unauthenticated; modest parallelism keeps a
/// full roster polite).
const BATCH_CONCURRENCY: usize = 4;

/// Minimum length for a CN search query — the server rejects shorter ones
/// with a plain `Bad Request` (same floor the official profile site applies).
const MIN_SEARCH_CHARS: usize = 3;

/// The vortex endpoints apply a basic browser check; a non-browser UA risks
/// rejection. The global WoWSP client UA is overridden per-request family
/// here so only the CN transport is affected.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// Shared CN vortex HTTP client (browser UA + the global proxy policy).
/// Also used by `ship_stats` for its per-ship endpoint.
pub(crate) fn vortex_client() -> Result<reqwest::Client, String> {
    crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// GET one JSON document from the CN vortex/clans hosts. Non-2xx is an error
/// (the clan endpoint's meaningful 404 is tolerated by its own caller).
async fn get_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("CN vortex request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("CN vortex: HTTP {status}"));
    }
    resp.json()
        .await
        .map_err(|e| format!("CN vortex parse: {e}"))
}

fn vortex_status(v: &serde_json::Value) -> Option<&str> {
    v.get("status").and_then(|s| s.as_str())
}

// ── normalization: vortex → WG account/info shape ─────────────────────────

/// Map one vortex `data["<id>"]` player node onto the WG account/info shape
/// consumed by `PvpStats::extract` / `leveling_of` / `parse_dog_tag`:
///
///   name             → nickname
///   statistics.basic → leveling_tier / leveling_points (WG keeps them top-level)
///   statistics.pvp   → battles_count→battles, survived→survived_battles,
///                      win_and_survived→survived_wins, exp→xp,
///                      shots_by_main/hits_by_main→main_battery.{shots,hits}
///   pvp_solo/div2/div3 battles_count→battles
///   statistics.seasons → same per-mode mapping (WG seasons API shape:
///                      seasons.<id>.<shipType>.<mode>) for `ranked`
///   statistics.rank_info → passed through (fields already match WG)
///
/// A hidden profile (`hidden_profile: true`) and an empty statistics node
/// (fresh account) both normalize to `statistics: {pvp: null}` — the same
/// "hidden" marker the WG path derives from null stats.
fn normalize_player(node: &serde_json::Value) -> serde_json::Value {
    let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let hidden = node
        .get("hidden_profile")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let statistics = node.get("statistics").filter(|v| !v.is_null());
    let basic = statistics
        .and_then(|s| s.get("basic"))
        .filter(|v| !v.is_null());
    let rank_info = statistics
        .and_then(|s| s.get("rank_info"))
        .filter(|v| !v.is_null());
    let seasons = statistics.and_then(|s| s.get("seasons"));
    let stats_json = if hidden {
        serde_json::json!({ "pvp": serde_json::Value::Null })
    } else {
        serde_json::json!({
            "pvp": normalize_pvp(statistics.and_then(|s| s.get("pvp"))),
            "pvp_solo": normalize_div(statistics.and_then(|s| s.get("pvp_solo"))),
            "pvp_div2": normalize_div(statistics.and_then(|s| s.get("pvp_div2"))),
            "pvp_div3": normalize_div(statistics.and_then(|s| s.get("pvp_div3"))),
            // Ranked trees, shaped like the WG seasons API so the shared
            // flatten in `ranked` consumes them verbatim (rank_info passes
            // through as-is: its rank/rank_best fields already match).
            "rank_info": rank_info.cloned().unwrap_or(serde_json::Value::Null),
            "seasons": normalize_seasons(seasons),
        })
    };
    serde_json::json!({
        "nickname": name,
        "leveling_tier": basic.and_then(|b| b.get("leveling_tier")).and_then(|v| v.as_i64()),
        "leveling_points": basic.and_then(|b| b.get("leveling_points")).and_then(|v| v.as_i64()),
        "statistics": stats_json,
        "dog_tag": node.get("dog_tag").filter(|v| !v.is_null()),
    })
}

/// Map one vortex battle-type stats node onto the WG `statistics.pvp` shape.
/// Missing/null/empty nodes (never played, or hidden) stay null — the WG
/// extraction treats that as "no data".
fn normalize_pvp(pvp: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(p) = pvp.filter(|v| !v.is_null() && v.as_object().is_some_and(|o| !o.is_empty()))
    else {
        return serde_json::Value::Null;
    };
    serde_json::json!({
        "battles": get_i64(p, "battles_count"),
        "wins": get_i64(p, "wins"),
        "losses": get_i64(p, "losses"),
        "damage_dealt": get_i64(p, "damage_dealt"),
        "frags": get_i64(p, "frags"),
        "xp": get_i64(p, "exp"),
        "survived_battles": get_i64(p, "survived"),
        "survived_wins": get_i64(p, "win_and_survived"),
        "planes_killed": get_i64(p, "planes_killed"),
        "main_battery": {
            "shots": get_i64(p, "shots_by_main"),
            "hits": get_i64(p, "hits_by_main"),
        },
        "max_damage_dealt": get_i64(p, "max_damage_dealt"),
        "max_xp": get_i64(p, "max_exp"),
        "max_frags": get_i64(p, "max_frags"),
    })
}

/// Map one vortex division-split node (pvp_solo / pvp_div2 / pvp_div3) onto
/// the WG `{battles, wins}` shape. Null nodes stay null.
fn normalize_div(div: Option<&serde_json::Value>) -> serde_json::Value {
    match div.filter(|v| !v.is_null()) {
        Some(d) => serde_json::json!({
            "battles": get_i64(d, "battles_count"),
            "wins": get_i64(d, "wins"),
        }),
        None => serde_json::Value::Null,
    }
}

/// Map the vortex ranked-seasons tree onto the WG seasons API shape:
/// `seasons.<id>.<shipType>.<mode>` with each mode node run through
/// `normalize_pvp` (same vortex field names as the account pvp node). Nodes
/// that are empty (`{}` = never played that mode) normalize to null — the
/// flatten in `ranked` skips those like it skips missing WG seasons.
fn normalize_seasons(seasons: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(seasons) = seasons.and_then(|v| v.as_object()) else {
        return serde_json::Value::Null;
    };
    let mut out = serde_json::Map::with_capacity(seasons.len());
    for (sid, ships) in seasons {
        let Some(ships) = ships.as_object() else {
            continue;
        };
        let mut ships_out = serde_json::Map::with_capacity(ships.len());
        for (ship_type, modes) in ships {
            let Some(modes) = modes.as_object() else {
                continue;
            };
            let mut modes_out = serde_json::Map::with_capacity(modes.len());
            for (mode, node) in modes {
                modes_out.insert(mode.clone(), normalize_pvp(Some(node)));
            }
            ships_out.insert(ship_type.clone(), serde_json::Value::Object(modes_out));
        }
        out.insert(sid.clone(), serde_json::Value::Object(ships_out));
    }
    serde_json::Value::Object(out)
}

fn get_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

// ── account resolution ────────────────────────────────────────────────────

/// One resolved CN account (vortex search result or a direct id hit).
/// Fields are crate-visible so `wg_composition` can reuse the resolver.
pub(crate) struct CnAccountRef {
    pub(crate) account_id: i64,
    pub(crate) nickname: String,
}

/// Search one nickname on the CN vortex (limit=10) and resolve the EXACT
/// account out of the prefix hits — [`exact_hit`]. `Ok(None)` covers "no
/// match", "no exact hit" and "unsearchable query" — the server rejects
/// anything shorter than 3 characters with `Bad Request` (two-character
/// Chinese nicknames cannot be searched on the official profile site either;
/// they stay reachable by numeric id through `resolve_entry`). Shared with
/// `wg_composition`'s batch resolution.
pub(crate) async fn account_list_one(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<CnAccountRef>, String> {
    let host = wg_realm::vortex_host("cn")?;
    let url = format!(
        "https://{host}/api/accounts/search/{}/?limit=10",
        encode_query(name)
    );
    let v = get_json(client, &url).await?;
    if vortex_status(&v) != Some("ok") {
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        if err == "Bad Request" {
            return Ok(None);
        }
        return Err(format!("CN account search: {err}"));
    }
    let hit = v
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| exact_hit(name, a));
    // exact_hit already requires a name; entries without a spa_id are still
    // skipped here, not defaulted — account_id 0 would just probe a nonsense
    // URL downstream.
    Ok(hit.and_then(|e| {
        Some(CnAccountRef {
            account_id: get_i64(&e, "spa_id")?,
            nickname: e.get("name")?.as_str()?.to_owned(),
        })
    }))
}

/// Pick the search hit whose name IS the queried nickname (trimmed,
/// case-insensitive) — the vortex search is a prefix query whose top hit is
/// not contractually the exact account, so a same-prefix lookalike must
/// never be resolved. Pure so the rule is unit-testable without HTTP.
fn exact_hit(name: &str, entries: &[serde_json::Value]) -> Option<serde_json::Value> {
    entries
        .iter()
        .find(|e| {
            e.get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| nickname_matches(name, n))
        })
        .cloned()
}

/// Fetch and normalize one account info node. `Ok(None)` = unknown id — the
/// live service answers those with HTTP 404 +
/// `{"status":"error","error":"Not Found"}` (a 200 whose `data` omits the id
/// key is also tolerated).
async fn account_info(
    client: &reqwest::Client,
    account_id: i64,
) -> Result<Option<serde_json::Value>, String> {
    let host = wg_realm::vortex_host("cn")?;
    let url = format!("https://{host}/api/accounts/{account_id}/");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("CN vortex request: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("CN vortex: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("CN vortex parse: {e}"))?;
    if vortex_status(&v) != Some("ok") {
        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        if err == "Not Found" {
            return Ok(None);
        }
        return Err(format!("CN account info: {err}"));
    }
    Ok(v.get("data")
        .and_then(|d| d.get(account_id.to_string()))
        .filter(|n| !n.is_null())
        .map(normalize_player))
}

/// Resolve a query (nickname or numeric id) to one account. Numeric queries
/// hit the info endpoint directly and only fall back to the name search when
/// the id doesn't resolve (numeric-looking nicknames are rare but exist).
async fn resolve_entry(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<CnAccountRef>, String> {
    let entry = match name.trim().parse::<i64>() {
        Ok(uid) if uid > 0 => match account_info(client, uid).await? {
            Some(node) => Some(CnAccountRef {
                account_id: uid,
                nickname: node
                    .get("nickname")
                    .and_then(|n| n.as_str())
                    .unwrap_or_default()
                    .to_owned(),
            }),
            None => account_list_one(client, name).await?,
        },
        _ => account_list_one(client, name).await?,
    };
    Ok(entry)
}

/// Clan affiliation for one account from the vortex clans endpoint. The CN
/// service answers 404 for clanless accounts (the API realms return an empty
/// object), so any non-2xx means "no clan" — best-effort, never fatal.
async fn clan_for_account(
    client: &reqwest::Client,
    account_id: i64,
) -> Option<(String, Option<i64>)> {
    let host = wg_realm::vortex_host("cn").ok()?;
    let resp = client
        .get(format!("https://{host}/api/accounts/{account_id}/clans/"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let data = v.get("data")?;
    let tag = data
        .get("clan")
        .and_then(|c| c.get("tag"))
        .and_then(|t| t.as_str())?
        .to_owned();
    if tag.is_empty() {
        return None;
    }
    Some((tag, data.get("clan_id").and_then(|i| i.as_i64())))
}

// ── player stats assembly ─────────────────────────────────────────────────

/// Build a `PlayerStats` from a normalized player node. Shared by the single
/// lookup and the batch path (mirrors `player_stats_from_info`).
fn player_stats_of(
    entry: CnAccountRef,
    node: &serde_json::Value,
    clan: Option<(String, Option<i64>)>,
    with_dog_tag: bool,
) -> PlayerStats {
    let stats_node = node.get("statistics");
    let p = PvpStats::extract(stats_node);
    let hidden = stats_node.is_none_or(|s| s.get("pvp").is_none_or(|p2| p2.is_null()));
    PlayerStats {
        account_id: entry.account_id,
        name: entry.nickname,
        realm: "cn".to_string(),
        battles: p.battles,
        winrate: p.winrate,
        hidden,
        clan_tag: clan.as_ref().map(|(tag, _)| tag.clone()),
        clan_id: clan.and_then(|(_, id)| id),
        avg_damage: p.avg_damage,
        avg_xp: p.avg_xp,
        kd_ratio: p.kd_ratio,
        survival_rate: p.survival_rate,
        hit_rate: p.hit_rate,
        pr: p.pr,
        ships_played: p.ships_played,
        leveling_tier: node
            .get("leveling_tier")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32),
        leveling_points: node.get("leveling_points").and_then(|v| v.as_i64()),
        dog_tag: if with_dog_tag {
            node.get("dog_tag").and_then(parse_dog_tag)
        } else {
            None
        },
        solo_wr: p.solo_wr,
        div2_wr: p.div2_wr,
        div3_wr: p.div3_wr,
        solo_battles: p.solo_battles,
        div2_battles: p.div2_battles,
        div3_battles: p.div3_battles,
    }
}

/// Resolve + fully assemble one player. `Ok(None)` = not found (or an
/// unsearchable short nickname); transport-level failures propagate. The
/// edge case where the account vanishes between search hit and info fetch
/// rejects with a structured account-not-found [`LookupError`] — shared
/// with the batch path, which degrades it back to its message string
/// (rosters render "no data", never a reason).
async fn lookup_one(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<PlayerStats>, LookupError> {
    let Some(entry) = resolve_entry(client, name).await? else {
        return Ok(None);
    };
    let (info, clan) = tokio::join!(
        account_info(client, entry.account_id),
        clan_for_account(client, entry.account_id)
    );
    let node = info?.ok_or_else(|| LookupError::not_found_account(name, "cn"))?;
    Ok(Some(player_stats_of(entry, &node, clan, true)))
}

/// CN arm of `wg_api::lookup_player_stats`. The expected PR algorithm works
/// here too: the vortex serves the per-ship endpoint
/// (`fetch_expected_pr_rows` routes "cn" to it), so the CN card aggregates
/// the wows-numbers PR exactly like the API realms — one transport-agnostic
/// code path. Rejects with a structured [`LookupError`] like the WG arm.
pub(crate) async fn lookup_player_stats(
    name: String,
    algo: PrAlgo,
) -> Result<PlayerStats, LookupError> {
    let client = vortex_client()?;
    let mut stats = lookup_one(&client, &name)
        .await?
        .ok_or_else(|| LookupError::not_found_account(name.clone(), "cn"))?;
    // Unavailable inputs (expected table or ship rows) yield None — the card
    // renders "--"; the lookup itself must not fail over a rating.
    if algo == PrAlgo::Expected {
        stats.pr = super::wg_api::account_expected_pr_for("cn", stats.account_id).await;
    }
    Ok(stats)
}

/// CN arm of `wg_api::lookup_players_stats_batch`. One full lookup per name
/// with bounded parallelism (the vortex service has no multi-id batch
/// endpoints). Any transport failure fails the whole batch — same contract
/// as the WG path, so the frontend's retry backoff kicks in instead of
/// caching "no data". Under the expected algorithm every entry answers
/// PR=None for the same request-budget reason as the WG arm (see
/// `wg_api::apply_batch_pr_algo`).
pub(crate) async fn lookup_players_stats_batch(
    names: Vec<String>,
    algo: PrAlgo,
) -> Result<Vec<Option<PlayerStats>>, String> {
    let client = vortex_client()?;
    let results: Vec<Result<Option<PlayerStats>, LookupError>> = {
        let client_ref = &client;
        stream::iter(names)
            .map(|name| async move { lookup_one(client_ref, &name).await })
            .buffered(BATCH_CONCURRENCY)
            .collect()
            .await
    };
    if let Some(Err(e)) = results.iter().find(|r| r.is_err()) {
        // The batch keeps the plain-String contract (its consumers render
        // "no data", never a reason) — the structured error degrades to its
        // historical message.
        return Err(e.to_string());
    }
    Ok(results
        .into_iter()
        .map(|r| {
            r.unwrap_or(None).map(|mut stats| {
                super::wg_api::apply_batch_pr_algo(&mut stats, algo);
                stats
            })
        })
        .collect())
}

/// CN arm of `wg_api::suggest_players`: prefix autocomplete over the vortex
/// service. Short queries return an empty vec; an occasional 503 degrades to
/// an empty list too (the popup renders a hint, not an error).
pub(crate) async fn suggest_players(search: String) -> Result<Vec<PlayerSuggestion>, String> {
    let q = search.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let client = vortex_client()?;
    // UID fast path: resolve the id directly; a numeric string that is NOT a
    // valid id yields no suggestions.
    if let Ok(uid) = q.parse::<i64>() {
        if uid > 0 {
            if let Some(node) = account_info(&client, uid).await? {
                return Ok(vec![PlayerSuggestion {
                    account_id: uid,
                    nickname: node
                        .get("nickname")
                        .and_then(|n| n.as_str())
                        .unwrap_or_default()
                        .to_owned(),
                }]);
            }
            return Ok(Vec::new());
        }
    }
    if q.chars().count() < MIN_SEARCH_CHARS {
        return Ok(Vec::new());
    }
    let host = wg_realm::vortex_host("cn")?;
    let url = format!(
        "https://{host}/api/accounts/search/autocomplete/{}/",
        encode_query(&q)
    );
    // Transient transport failures (503s are documented on the CN
    // autocomplete) degrade to "no suggestions" — the popup renders a hint,
    // not an error.
    let v = match get_json(&client, &url).await {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    if vortex_status(&v) != Some("ok") {
        return Ok(Vec::new());
    }
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .take(10)
                .filter_map(|e| {
                    Some(PlayerSuggestion {
                        account_id: get_i64(e, "spa_id")?,
                        nickname: e.get("name")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

// ── clans ─────────────────────────────────────────────────────────────────

/// CN arm of `wg_api::suggest_clans`: the clans autocomplete endpoint. The
/// CN response wraps the list in `search_autocomplete_result` (no
/// status/data envelope) and carries no member count.
pub(crate) async fn suggest_clans(search: String) -> Result<Vec<ClanSuggestion>, String> {
    let q = search.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let client = vortex_client()?;
    // Numeric query = clan id resolved directly via claninfo.
    if let Ok(clan_id) = q.parse::<i64>() {
        if clan_id > 0 {
            if let Some(node) = clan_info_node(&client, clan_id).await? {
                return Ok(vec![super::wg_api::clan_suggestion_of(clan_id, &node)]);
            }
            return Ok(Vec::new());
        }
    }
    if q.chars().count() < MIN_SEARCH_CHARS {
        return Ok(Vec::new());
    }
    let host = wg_realm::cn_clans_host();
    let url = format!(
        "https://{host}/api/search/autocomplete/?search={}&type=clans",
        encode_query(&q)
    );
    let v = get_json(&client, &url).await?;
    let list = v
        .get("search_autocomplete_result")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|c| {
            Some(ClanSuggestion {
                clan_id: get_i64(c, "id")?,
                tag: c.get("tag")?.as_str()?.to_owned(),
                name: c.get("name")?.as_str()?.to_owned(),
                members_count: None,
            })
        })
        .take(10)
        .collect())
}

/// Fetch the clanview/clan metadata node for one clan id. `Ok(None)` when the
/// clan doesn't exist — unknown ids answer HTTP 200 with an all-null clan
/// node (occasionally a bare 404), so existence is decided by a non-empty
/// tag rather than the status line.
async fn clan_info_node(
    client: &reqwest::Client,
    clan_id: i64,
) -> Result<Option<serde_json::Value>, String> {
    let host = wg_realm::cn_clans_host();
    let url = format!("https://{host}/api/clanbase/{clan_id}/claninfo/");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("CN clans request: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("CN clans: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("CN clans parse: {e}"))?;
    let node = v.get("clanview").and_then(|c| c.get("clan"));
    Ok(node
        .filter(|c| {
            c.get("tag")
                .and_then(|t| t.as_str())
                .is_some_and(|t| !t.is_empty())
        })
        .cloned())
}

/// CN arm of `wg_api::lookup_clan_info`: claninfo for the metadata plus the
/// members endpoint for the roster. The members response carries pre-aggregated
/// per-member stats (battles/wr/avg damage/avg xp/frags per battle) instead
/// of raw WG counters — survival and K/D inputs aren't served, so those stay
/// `None` rather than being approximated. Rejects with a structured
/// [`LookupError`] like the WG arm.
pub(crate) async fn lookup_clan_info(clan_id: i64, algo: PrAlgo) -> Result<ClanInfo, LookupError> {
    let client = vortex_client()?;
    let clan_node = clan_info_node(&client, clan_id)
        .await?
        .ok_or_else(|| LookupError::not_found_clan(clan_id.to_string(), "cn"))?;

    // Roster (best-effort: a failed members fetch still renders the card).
    let host = wg_realm::cn_clans_host();
    let members_url = format!("https://{host}/api/members/{clan_id}/?battle_type=pvp");
    let members: Vec<serde_json::Value> = match get_json(&client, &members_url).await {
        Ok(v) => v
            .get("items")
            .and_then(|i| i.as_array())
            .cloned()
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Ok(clan_info_from_cn(clan_id, &clan_node, &members, algo))
}

// ── ranked ────────────────────────────────────────────────────────────────

/// CN arm of `ranked::get_ranked_stats`. CN exposes no `/wows/seasons/`
/// endpoints, but the vortex detail endpoint carries the same ranked trees —
/// `statistics.seasons.<id>.<shipType>.<mode>` and `statistics.rank_info` —
/// already normalized into the WG shape by `normalize_player`, so the shared
/// flatten consumes them verbatim. Season ids come from the player's own
/// seasons map (there is no seasons/info metadata endpoint to list them);
/// the id convention matches WG (1001 = Season 1), which the season naming
/// in the flatten relies on.
pub(crate) async fn ranked_stats(
    account_id: i64,
    season_count: usize,
) -> Result<Vec<super::ranked::RankedSeasonStats>, String> {
    let client = vortex_client()?;
    let node = account_info(&client, account_id)
        .await?
        .ok_or_else(|| format!("no account found for id {account_id} on cn"))?;
    let statistics = node.get("statistics");
    let seasons = statistics
        .and_then(|s| s.get("seasons"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let mut season_ids: Vec<i64> = seasons
        .as_object()
        .map(|o| o.keys().filter_map(|k| k.parse::<i64>().ok()).collect())
        .unwrap_or_default();
    season_ids.sort_by(|a, b| b.cmp(a)); // descending = most recent first
    season_ids.truncate(season_count);

    let player = serde_json::json!({
        "seasons": seasons,
        "rank_info": statistics
            .and_then(|s| s.get("rank_info"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    });
    Ok(super::ranked::flatten_ranked_seasons(&player, &season_ids))
}

/// Assemble a `ClanInfo` from the CN claninfo + members responses. Pure —
/// unit-tested. `created_at` arrives as an ISO-8601 local timestamp (no zone
/// designator); it is read as UTC, which is plenty for a creation-date
/// display. Join dates are not served (only "days in clan" counts), so
/// `joined_at` stays `None`.
fn clan_info_from_cn(
    clan_id: i64,
    clan_node: &serde_json::Value,
    members: &[serde_json::Value],
    pr_algo: PrAlgo,
) -> ClanInfo {
    let mut roster = Vec::with_capacity(members.len());
    let (mut total_battles, mut total_wins, mut total_damage) = (0i64, 0i64, 0f64);
    let mut hidden_count = 0i64;
    let mut member_prs: Vec<i64> = Vec::new();

    for m in members {
        let id = get_i64(m, "id").unwrap_or(0);
        let name = m
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_owned();
        // The CN roster nests the role under {name: "commander"|…} — the same
        // role keys the WG API uses, so the frontend mapping applies as-is.
        let role = m
            .get("role")
            .and_then(|r| r.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("private")
            .to_owned();
        // Hidden = the explicit per-member flag, or no usable PvP counters
        // (hidden members answer with nulls; zero-battle rows would only
        // produce empty stats, so they fold into hidden too).
        let battles = get_i64(m, "battles_count").filter(|b| *b > 0);
        let is_hidden = m
            .get("is_hidden_statistics")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let stats = if battles.is_some() && !is_hidden {
            let winrate = m
                .get("wins_percentage")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32);
            let avg_damage = m
                .get("damage_per_battle")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32);
            let avg_xp = m
                .get("exp_per_battle")
                .and_then(|v| v.as_f64())
                .map(|v| v as f32);
            // CN rosters expose only the overall winrate — feed it through
            // as the solo bucket (no division splits to blend). `battles`
            // is always Some in this branch (guarded above); zip keeps that
            // invariant explicit instead of papering over it with a default.
            // Under the expected algorithm the roster carries no per-ship
            // rows to aggregate (the members endpoint serves pre-aggregated
            // counters only; per-member expected PR would need one ships
            // fetch per row) — PR stays None, mirroring the WG roster.
            let pr = if pr_algo == PrAlgo::Expected {
                None
            } else {
                winrate
                    .zip(battles)
                    .and_then(|(wr, b)| compute_pr(Some((wr, b)), None, None))
            };
            if let Some(pr) = pr {
                member_prs.push(pr);
            }
            total_battles += battles.unwrap_or(0);
            total_wins += winrate
                .and_then(|wr| battles.map(|b| (wr * b as f32 / 100.0).round() as i64))
                .unwrap_or(0);
            total_damage += avg_damage
                .map(|d| d * battles.unwrap_or(0) as f32)
                .unwrap_or(0.0) as f64;
            ClanMemberStats {
                battles,
                wins: None,
                winrate,
                avg_damage,
                pr,
                avg_xp,
                kd_ratio: None,
                survival_rate: None,
                hidden: false,
            }
        } else {
            hidden_count += 1;
            ClanMemberStats {
                hidden: true,
                ..Default::default()
            }
        };
        roster.push(ClanMember {
            account_id: id,
            name,
            role,
            joined_at: None,
            stats,
        });
    }

    let winrate = if total_battles > 0 {
        100.0 * total_wins as f32 / total_battles as f32
    } else {
        0.0
    };
    let avg_damage = if total_battles > 0 {
        (total_damage / total_battles as f64) as f32
    } else {
        0.0
    };
    let avg_pr = (!member_prs.is_empty())
        .then(|| (member_prs.iter().sum::<i64>() as f64 / member_prs.len() as f64).round() as i64);

    ClanInfo {
        clan_id,
        tag: clan_node
            .get("tag")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        name: clan_node
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        realm: "cn".to_string(),
        // CN descriptions arrive as plain text; the decoder is entity-idempotent
        // and normalizes whitespace the same way the WG path does.
        description: clan_node
            .get("description")
            .and_then(|v| v.as_str())
            .map(super::wg_api::decode_wg_text),
        members_count: clan_node
            .get("members_count")
            .and_then(|v| v.as_i64())
            .unwrap_or(members.len() as i64),
        created_at: clan_node
            .get("created_at")
            .and_then(|v| v.as_str())
            .and_then(parse_cn_timestamp),
        members: roster,
        total_battles,
        total_wins,
        winrate,
        avg_damage,
        avg_pr,
        hidden_count,
    }
}

/// Parse the CN claninfo `created_at` ("2020-10-21T03:45:18.364106" — no
/// zone designator) into epoch seconds. None when unparseable.
fn parse_cn_timestamp(raw: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|dt| dt.and_utc().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_hit_picks_queried_nickname_out_of_prefix_hits() {
        let hits = serde_json::json!([
            { "spa_id": 1, "name": "川S-大叔其实不是大叔" },
            { "spa_id": 2, "name": " 川s-大叔 " },
            { "spa_id": 3 }
        ]);
        // Exact nickname wins regardless of hit order, padding or case.
        let picked = exact_hit("川S-大叔", hits.as_array().unwrap()).expect("exact hit");
        assert_eq!(picked["spa_id"], 2);
        // A prefix query that matches several entries exactly-resolves none —
        // a lookalike must never be resolved as the queried account.
        assert!(exact_hit("川S", hits.as_array().unwrap()).is_none());
        // Name-less entries can never be verified, only skipped.
        let nameless = serde_json::json!([{ "spa_id": 3 }]);
        assert!(exact_hit("川S-大叔其实不是大叔", nameless.as_array().unwrap()).is_none());
    }

    /// Live-response fixture (player 川S-大叔其实不是大叔, id 7050428536):
    /// full statistics subtree with vortex field names.
    #[test]
    fn normalize_player_maps_vortex_fields_to_wg_shape() {
        let vortex_node = serde_json::json!({
            "name": "川S-大叔其实不是大叔",
            "created_at": 1475157219.0,
            "activated_at": 1475157219.0,
            "hidden_profile": null,
            "visibility_settings": false,
            "dog_tag": {
                "texture_id": 4293282736_u64, "symbol_id": 4274998192_u64,
                "border_color_id": 4283911088_u64, "background_color_id": 4293577648_u64,
                "background_id": 4293905328_u64
            },
            "statistics": {
                "basic": { "leveling_tier": 17, "leveling_points": 16953, "karma": 0, "last_battle_time": 1702903865 },
                "pvp": {
                    "battles_count": 16196, "wins": 8337, "losses": 7854,
                    "damage_dealt": 931503342, "frags": 10673,
                    "survived": 5000, "win_and_survived": 4000,
                    "shots_by_main": 2852109, "hits_by_main": 845434,
                    "planes_killed": 28902, "exp": 37473902
                },
                "pvp_solo": { "battles_count": 16193, "wins": 8335, "damage_dealt": 931270926, "frags": 10671 },
                "pvp_div2": { "battles_count": 3, "wins": 2, "damage_dealt": 232416, "frags": 2 },
                "pvp_div3": null
            }
        });
        let node = normalize_player(&vortex_node);
        assert_eq!(node.get("nickname").unwrap(), "川S-大叔其实不是大叔");
        assert_eq!(node.get("leveling_tier").unwrap(), 17);
        assert_eq!(node.get("leveling_points").unwrap(), 16953);

        // The normalized node feeds the shared WG extractor verbatim.
        let p = PvpStats::extract(node.get("statistics"));
        assert_eq!(p.battles, Some(16196));
        assert!((p.winrate.unwrap() - 51.477).abs() < 0.01);
        assert!((p.avg_damage.unwrap() - 57514.4).abs() < 1.0);
        // 5000 survived / 16196 battles; 845434 hits / 2852109 main shots;
        // 10673 frags / (16196 - 5000) deaths; 8335 solo wins / 16193.
        assert!((p.survival_rate.unwrap() - 30.872).abs() < 0.01);
        assert!((p.hit_rate.unwrap() - 29.636).abs() < 0.01);
        assert!((p.kd_ratio.unwrap() - 0.9526).abs() < 0.001);
        assert!(p.pr.is_some());
        assert!((p.solo_wr.unwrap() - 51.4728).abs() < 0.01);
        assert!((p.div2_wr.unwrap() - 66.67).abs() < 0.01);
        assert_eq!(p.div3_wr, None);
        assert_eq!(p.solo_battles, Some(16193));
        assert_eq!(p.div2_battles, Some(3));
        assert_eq!(p.div3_battles, None);

        // Dog tag parses through the shared helper.
        assert!(node.get("dog_tag").and_then(parse_dog_tag).is_some());
    }

    /// The vortex ranked trees must survive normalization in the WG seasons
    /// API shape so `ranked::flatten_ranked_seasons` consumes them (this is
    /// what feeds the CN ranked cards).
    #[test]
    fn normalize_player_maps_ranked_trees_to_wg_shape() {
        let vortex_node = serde_json::json!({
            "name": "青空雪舞",
            "statistics": {
                "rank_info": {
                    "1024": {
                        "-1": { "0": { "rank": 0, "rank_best": 0 } },
                        "1": { "3": { "rank": 5, "rank_best": 5 } }
                    }
                },
                "seasons": {
                    "1024": { "0": { "rank_solo": {
                        "battles_count": 6, "wins": 6, "losses": 0,
                        "damage_dealt": 31424, "frags": 1,
                        "exp": 19922, "max_exp": 8831,
                        "max_damage_dealt": 11000, "survived": 1, "planes_killed": 1
                    } } },
                    // an unplayed season's empty mode node collapses to null
                    "1002": { "0": { "rank_solo": {} } }
                }
            }
        });
        let node = normalize_player(&vortex_node);
        let st = node.get("statistics").unwrap();
        // rank_info passes through untouched.
        assert_eq!(st.pointer("/rank_info/1024/1/3/rank").unwrap(), 5);
        // seasons: vortex field names map onto the WG ones.
        assert_eq!(st.pointer("/seasons/1024/0/rank_solo/battles").unwrap(), 6);
        assert_eq!(st.pointer("/seasons/1024/0/rank_solo/wins").unwrap(), 6);
        assert_eq!(
            st.pointer("/seasons/1024/0/rank_solo/max_xp").unwrap(),
            8831
        );
        assert!(st.pointer("/seasons/1002/0/rank_solo").unwrap().is_null());

        // The synthetic node `ranked_stats` feeds the shared flatten with is
        // exactly these trees — run it through end-to-end.
        let player = serde_json::json!({
            "seasons": st.get("seasons").cloned().unwrap(),
            "rank_info": st.get("rank_info").cloned().unwrap(),
        });
        let out = super::super::ranked::flatten_ranked_seasons(&player, &[1024, 1002]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].season_name, "Season 24");
        assert_eq!((out[0].battles, out[0].wins), (6, 6));
    }

    /// Live-response fixture (player saber, id 7047835131): a never-played
    /// account whose statistics only carries mastery_sign.
    #[test]
    fn normalize_player_marks_empty_statistics_hidden() {
        let vortex_node = serde_json::json!({
            "name": "saber",
            "created_at": 1590411566.0,
            "statistics": { "mastery_sign": "No_Sign" },
            "visibility_settings": false
        });
        let node = normalize_player(&vortex_node);
        let p = PvpStats::extract(node.get("statistics"));
        assert_eq!(p.battles, None);
        let hidden = node
            .get("statistics")
            .is_none_or(|s| s.get("pvp").is_none_or(|p2| p2.is_null()));
        assert!(hidden);
    }

    #[test]
    fn normalize_player_forces_hidden_when_flagged() {
        let vortex_node = serde_json::json!({
            "name": "ghost",
            "hidden_profile": true,
            "statistics": { "pvp": { "battles_count": 10, "wins": 5 } }
        });
        let node = normalize_player(&vortex_node);
        assert!(
            node.get("statistics")
                .unwrap()
                .get("pvp")
                .unwrap()
                .is_null()
        );
    }

    #[test]
    fn clan_info_from_cn_assembles_roster_and_aggregates() {
        // Live-response shapes: claninfo wraps the clan under clanview.clan
        // with an ISO created_at; members carry pre-aggregated stats and a
        // nested role object.
        let clan_node = serde_json::json!({
            "tag": "海军", "name": "达州舰队", "members_count": 3,
            "created_at": "2020-10-21T03:45:18.364106",
            "description": "公告 招人中"
        });
        let members = serde_json::json!([
            { "id": 7048253916i64, "name": "☆种花家的兔子☆",
              "role": { "order": 0, "rank": 10, "name": "commander" },
              "battles_count": 8857, "wins_percentage": 46.96849949192729,
              "damage_per_battle": 45121.68826916563, "frags_per_battle": 0.54,
              "exp_per_battle": 1029.68, "is_hidden_statistics": false },
            { "id": 7047867818i64, "name": "吃面包的狮子",
              "role": { "order": 1, "rank": 9, "name": "executive_officer" },
              "battles_count": 6334, "wins_percentage": 48.75276286706662,
              "damage_per_battle": 43875.23223871172,
              "exp_per_battle": 1038.92, "is_hidden_statistics": false },
            { "id": 7052530625i64, "name": "星空之匙",
              "role": { "order": 10, "rank": 2, "name": "private" },
              "battles_count": null, "wins_percentage": null,
              "is_hidden_statistics": true }
        ]);
        let info = clan_info_from_cn(
            7000008303,
            &clan_node,
            members.as_array().unwrap(),
            PrAlgo::Winrate,
        );
        assert_eq!(info.clan_id, 7000008303);
        assert_eq!(info.tag, "海军");
        assert_eq!(info.name, "达州舰队");
        assert_eq!(info.realm, "cn");
        assert_eq!(info.description.as_deref(), Some("公告 招人中"));
        assert_eq!(info.created_at, Some(1603251918));
        assert_eq!(info.members.len(), 3);
        assert_eq!(info.hidden_count, 1);
        // Aggregates only count the two visible members.
        assert_eq!(info.total_battles, 8857 + 6334);
        // f32-rounds of the fixture percentages above (same math the
        // implementation runs, kept short for the excessive-precision lint).
        let expected_wins = (46.9685_f32 * 8857.0_f32 / 100.0_f32).round() as i64
            + (48.752_76_f32 * 6334.0_f32 / 100.0_f32).round() as i64;
        assert_eq!(info.total_wins, expected_wins);
        assert!(info.avg_pr.is_some());
        let commander = info
            .members
            .iter()
            .find(|m| m.account_id == 7048253916)
            .unwrap();
        assert_eq!(commander.role, "commander");
        assert_eq!(commander.joined_at, None);
        assert!((commander.stats.winrate.unwrap() - 46.97).abs() < 0.01);
        assert!(commander.stats.pr.is_some());
        assert_eq!(commander.stats.kd_ratio, None);
        let ghost = info
            .members
            .iter()
            .find(|m| m.account_id == 7052530625)
            .unwrap();
        assert!(ghost.stats.hidden);
        assert_eq!(ghost.stats.battles, None);
    }

    #[test]
    fn clan_info_from_cn_honors_explicit_hidden_flag() {
        // A member that played battles but carries is_hidden_statistics=true
        // counts as hidden even though the counters arrived.
        let clan_node = serde_json::json!({ "tag": "X", "name": "X", "members_count": 2 });
        let members = serde_json::json!([
            { "id": 1, "name": "a", "role": { "name": "private" },
              "battles_count": 100, "wins_percentage": 50.0,
              "damage_per_battle": 1000.0, "is_hidden_statistics": true },
            { "id": 2, "name": "b", "role": { "name": "private" },
              "battles_count": 100, "wins_percentage": 50.0,
              "damage_per_battle": 1000.0, "is_hidden_statistics": false }
        ]);
        let info = clan_info_from_cn(7, &clan_node, members.as_array().unwrap(), PrAlgo::Winrate);
        assert_eq!(info.hidden_count, 1);
        assert_eq!(info.total_battles, 100);
        let hidden = info.members.iter().find(|m| m.account_id == 1).unwrap();
        assert!(hidden.stats.hidden);
        let visible = info.members.iter().find(|m| m.account_id == 2).unwrap();
        assert!(!visible.stats.hidden);
    }

    #[test]
    fn clan_info_from_cn_tolerates_empty_roster() {
        let clan_node = serde_json::json!({
            "tag": "CN", "name": "ChinaStar", "members_count": 1
        });
        let info = clan_info_from_cn(7000004205, &clan_node, &[], PrAlgo::Winrate);
        assert_eq!(info.members.len(), 0);
        assert_eq!(info.members_count, 1);
        assert_eq!(info.winrate, 0.0);
        assert_eq!(info.avg_pr, None);
        assert_eq!(info.created_at, None);
    }

    #[test]
    fn parse_cn_timestamp_handles_fractional_seconds() {
        assert_eq!(
            parse_cn_timestamp("2020-10-21T03:45:18.364106"),
            Some(1603251918)
        );
        assert_eq!(parse_cn_timestamp("2020-10-21T03:45:18"), Some(1603251918));
        assert_eq!(parse_cn_timestamp("not-a-date"), None);
    }

    #[test]
    fn clan_info_from_cn_expected_algo_yields_no_pr() {
        // The members endpoint has no per-ship rows, so the expected
        // algorithm answers None — same contract as the WG roster.
        let clan_node = serde_json::json!({ "tag": "X", "name": "X", "members_count": 1 });
        let members = serde_json::json!([
            { "id": 1, "name": "a", "role": { "name": "private" },
              "battles_count": 100, "wins_percentage": 50.0,
              "damage_per_battle": 1000.0, "is_hidden_statistics": false }
        ]);
        let info = clan_info_from_cn(7, &clan_node, members.as_array().unwrap(), PrAlgo::Expected);
        assert_eq!(info.members[0].stats.pr, None);
        assert_eq!(info.avg_pr, None);
        // The default algorithm keeps the winrate-mapped PR.
        let info = clan_info_from_cn(7, &clan_node, members.as_array().unwrap(), PrAlgo::Winrate);
        assert!(info.members[0].stats.pr.is_some());
    }
}
