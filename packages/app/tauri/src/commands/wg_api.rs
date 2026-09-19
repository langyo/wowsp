//! Wargaming / Lesta Public API client (milestone M9).
//!
//! Looks up a player by name on a given realm and returns a compact stats
//! summary (battles, winrate, hidden flag, clan tag). The application_id is
//! the well-known public WG app id (same one ApeRadar ships — it is meant for
//! client-side use and rate-limited per IP, not secret); the Lesta-run RU
//! cluster needs its own id, both resolved by `wg_realm::application_id`.
//!
//! Endpoints (per realm, hosts from `wg_realm::api_host` — realm "ru" targets
//! the Lesta API on korabli.su since api.worldofwarships.ru 301s to the EU
//! API root and answers METHOD_NOT_FOUND for every method):
//!   list    GET https://<api_host>/wows/account/list/?application_id=..&search=<name>
//!   stats   GET https://<api_host>/wows/account/info/?application_id=..&account_id=<id>
//!           &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3
//!           (the division splits are extra-gated — unrequested nodes are
//!           omitted from the response entirely)
//!   clan    GET https://<api_host>/wows/clans/accountinfo/?application_id=..&account_id=<id>
//!   clans   GET https://<api_host>/wows/clans/list/?application_id=..&search=<tag|name>
//!   claninfo GET https://<api_host>/wows/clans/info/?application_id=..&clan_id=<id>&extra=members
//!
//! Realm → host suffix: ru→korabli.su (Lesta), eu→eu, na→com, asia→asia.
//! The cn realm (wowsgame.cn, 360-operated) has no WG public API — every
//! command below routes realm "cn" to the vortex-based `wg_api_cn` module
//! instead of the shared host resolution.

use std::collections::HashMap;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use serde::Deserialize;
use wowsp_tauri_shared::{
    ClanInfo, ClanMember, ClanMemberStats, ClanSuggestion, PlayerStats, PlayerSuggestion,
};

/// Concurrency cap for the batch name→account resolution. WG public API
/// rate-limits ~20 req/s per IP; 4 in-flight keeps a full 24-player roster
/// inside a couple of waves without tripping it.
const BATCH_CONCURRENCY: usize = 4;

/// Minimum length for a substring autocomplete query (WG rejects shorter
/// searches). Numeric UID queries bypass this gate.
const MIN_SEARCH_CHARS: usize = 3;

/// Look up one player's stats by name on the given realm.
#[tauri::command]
pub async fn lookup_player_stats(name: String, realm: String) -> Result<PlayerStats, String> {
    if realm == "cn" {
        return super::wg_api_cn::lookup_player_stats(name).await;
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let vortex_host = super::wg_realm::vortex_host(&realm)?;
    // Per-request timeout — a hung connection must not block a UI lookup
    // indefinitely.
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1. Resolve the query to an account. A purely numeric query is a UID
    //    ("nickname or UID" search): hit account/info directly and only fall
    //    back to the name search when the id doesn't resolve (numeric-looking
    //    nicknames are rare but exist).
    let entry = match name.trim().parse::<i64>() {
        Ok(uid) if uid > 0 => match account_nickname_by_id(&client, &app_id, host, uid).await? {
            Some(nickname) => Some(AccountListEntry {
                account_id: uid,
                nickname,
            }),
            None => account_list_one(&client, &app_id, host, &name).await?,
        },
        _ => account_list_one(&client, &app_id, host, &name).await?,
    }
    .ok_or_else(|| format!("no account found for '{name}' on {realm}"))?;

    // 2-4. account/info, clan tag and Vortex dog tag only need the account
    //    id — run the three requests concurrently instead of serially.
    let info_fut = async {
        // pvp_solo/div2/div3 are extra-gated: without the `extra` param the
        // API omits them entirely and the division winrates render as "—".
        let url = format!(
            "https://{host}/wows/account/info/?application_id={app_id}&account_id={}\
             &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3",
            entry.account_id
        );
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("account/info request: {e}"))?;
        resp.json::<WgResponse<serde_json::Value>>()
            .await
            .map_err(|e| format!("account/info parse: {e}"))
    };
    let clan_fut =
        async { fetch_clan_info_for_accounts(&client, &app_id, host, &[entry.account_id]).await };
    let dog_tag_fut = async {
        let resp = client
            .get(format!(
                "https://{vortex_host}/api/accounts/{}",
                entry.account_id
            ))
            .send()
            .await
            .ok()?;
        let vortex: Option<serde_json::Value> = resp.json().await.ok();
        vortex
            .as_ref()
            .and_then(|v| {
                v.get("data")
                    .and_then(|d| d.get(entry.account_id.to_string()))
                    .and_then(|p| p.get("dog_tag"))
                    .filter(|t| !t.is_null())
            })
            .and_then(parse_dog_tag)
    };
    let (info, clan_map, dog_tag) = tokio::join!(info_fut, clan_fut, dog_tag_fut);
    let info: WgResponse<serde_json::Value> = info?;

    // Hidden profiles return null statistics; player_stats_from_info surfaces
    // that as hidden=true.
    let mut stats = player_stats_from_info(entry, realm, info.data.as_ref(), &clan_map);
    stats.dog_tag = dog_tag;
    Ok(stats)
}

/// Look up many players in one shot (live-roster fast path): N× account/list
/// resolved with bounded parallelism, then ONE account/info and ONE
/// clans/accountinfo for all ids combined. Returns one entry per input name,
/// in order; `None` = account not found, no exact-name match, or the lookup
/// failed — roster UIs render that as "no data" rather than failing the
/// whole panel.
#[tauri::command]
pub async fn lookup_players_stats_batch(
    names: Vec<String>,
    realm: String,
) -> Result<Vec<Option<PlayerStats>>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    if realm == "cn" {
        return super::wg_api_cn::lookup_players_stats_batch(names).await;
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    // Per-request timeout so one hung connection can't stall the roster all
    // battle long.
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1. name → account, bounded-parallel. `names` is consumed: owned items
    //    keep the per-item futures lifetime-free (collect() preserves order).
    //    A rate-limited / failed list response fails the whole batch — it
    //    must not degrade into "not found" (the frontend would cache that).
    let total = names.len();
    let results: Vec<Result<Option<AccountListEntry>, String>> = {
        let client_ref = &client;
        stream::iter(names)
            .map(|name| {
                let url = format!(
                    "https://{host}/wows/account/list/?application_id={app_id}&search={}&limit=10",
                    encode_query(&name)
                );
                async move {
                    let resp = client_ref
                        .get(&url)
                        .send()
                        .await
                        .map_err(|e| format!("account/list request: {e}"))?;
                    let list = resp
                        .json::<WgResponse<Vec<AccountListEntry>>>()
                        .await
                        .map_err(|e| format!("account/list parse: {e}"))?;
                    if list.status != "ok" {
                        return Err(format!(
                            "account/list: {}",
                            list.error.message.unwrap_or_default()
                        ));
                    }
                    // Same exact-match guard as account_list_one: pick the
                    // queried account out of the prefix hits — a lookalike's
                    // stats must not leak into the roster batch.
                    Ok(list.data.and_then(|d| {
                        d.into_iter()
                            .find(|found| nickname_matches(&name, &found.nickname))
                    }))
                }
            })
            .buffered(BATCH_CONCURRENCY)
            .collect()
            .await
    };
    if let Some(Err(e)) = results.iter().find(|r| r.is_err()) {
        return Err(e.clone());
    }
    let entries: Vec<Option<AccountListEntry>> =
        results.into_iter().map(|r| r.unwrap_or(None)).collect();

    let ids: Vec<i64> = entries.iter().flatten().map(|e| e.account_id).collect();
    if ids.is_empty() {
        return Ok(vec![None; total]);
    }

    // 2+3. ONE account/info + ONE clan-tag lookup for the whole roster (the
    //       endpoints accept comma-joined id lists); independent, so run
    //       them concurrently.
    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let info_fut = async {
        // Same extra-gated division splits as the single lookup.
        let resp = client
            .get(format!(
                "https://{host}/wows/account/info/?application_id={app_id}&account_id={id_list}\
                 &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3"
            ))
            .send()
            .await
            .map_err(|e| format!("account/info request: {e}"))?;
        let parsed = resp
            .json::<WgResponse<serde_json::Value>>()
            .await
            .map_err(|e| format!("account/info parse: {e}"))?;
        // A WG app-level failure (e.g. rate limit) surfaces as
        // status:"error" — failing the batch lets the frontend's backoff
        // retry handle it instead of silently caching hidden=true for
        // everyone.
        if parsed.status != "ok" {
            return Err(format!(
                "account/info: {}",
                parsed.error.message.unwrap_or_default()
            ));
        }
        Ok(parsed)
    };
    let clan_fut = async { fetch_clan_info_for_accounts(&client, &app_id, host, &ids).await };
    let (info, clan_map) = tokio::join!(info_fut, clan_fut);
    let info: WgResponse<serde_json::Value> = info?;

    Ok(entries
        .into_iter()
        .map(|entry| {
            entry.map(|entry| {
                player_stats_from_info(entry, realm.clone(), info.data.as_ref(), &clan_map)
            })
        })
        .collect())
}

/// Build a `PlayerStats` from the batch account/info response map. The dog
/// tag is always None here — roster panels render WR/PR only, and the per-id
/// Vortex calls would dominate the request budget.
fn player_stats_from_info(
    entry: AccountListEntry,
    realm: String,
    info_data: Option<&serde_json::Value>,
    clan_map: &HashMap<i64, ClanTagInfo>,
) -> PlayerStats {
    let player_node = info_data.and_then(|d| d.get(entry.account_id.to_string()));
    let stats_node = player_node.and_then(|v| v.get("statistics"));
    let p = PvpStats::extract(stats_node);
    let hidden = stats_node.is_none_or(|s| s.get("pvp").is_none_or(|p2| p2.is_null()));
    let (leveling_tier, leveling_points) = leveling_of(player_node);
    let clan = clan_map.get(&entry.account_id);
    PlayerStats {
        account_id: entry.account_id,
        name: entry.nickname,
        realm,
        battles: p.battles,
        winrate: p.winrate,
        hidden,
        clan_tag: clan.map(|c| c.tag.clone()),
        clan_id: clan.and_then(|c| c.clan_id),
        avg_damage: p.avg_damage,
        avg_xp: p.avg_xp,
        kd_ratio: p.kd_ratio,
        survival_rate: p.survival_rate,
        hit_rate: p.hit_rate,
        pr: p.pr,
        ships_played: p.ships_played,
        leveling_tier,
        leveling_points,
        dog_tag: None,
        solo_wr: p.solo_wr,
        div2_wr: p.div2_wr,
        div3_wr: p.div3_wr,
    }
}

/// Service-record tier + points (for rank badge rendering).
fn leveling_of(player_node: Option<&serde_json::Value>) -> (Option<i32>, Option<i64>) {
    let tier = player_node
        .and_then(|v| v.get("leveling_tier"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32);
    let points = player_node
        .and_then(|v| v.get("leveling_points"))
        .and_then(|v| v.as_i64());
    (tier, points)
}

/// Clan affiliation for one account from the clans/accountinfo map.
struct ClanTagInfo {
    tag: String,
    clan_id: Option<i64>,
}

/// Clan tags (+ clan ids) for a list of account ids in one request.
/// Best-effort: any failure yields an empty map (clan tag is display sugar,
/// never fatal).
async fn fetch_clan_info_for_accounts(
    client: &reqwest::Client,
    app_id: &str,
    host: &str,
    ids: &[i64],
) -> HashMap<i64, ClanTagInfo> {
    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let Ok(resp) = client
        .get(format!(
            "https://{host}/wows/clans/accountinfo/?application_id={app_id}&account_id={id_list}&extra=clan"
        ))
        .send()
        .await
    else {
        return HashMap::new();
    };
    let Ok(parsed) = resp.json::<WgResponse<serde_json::Value>>().await else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    if let Some(obj) = parsed.data.as_ref().and_then(|d| d.as_object()) {
        for (k, v) in obj {
            if let Ok(id) = k.parse::<i64>() {
                if let Some(clan) = v.get("clan") {
                    let tag = clan.get("tag").and_then(|t| t.as_str());
                    let clan_id = clan.get("clan_id").and_then(|i| i.as_i64());
                    if let Some(tag) = tag {
                        map.insert(
                            id,
                            ClanTagInfo {
                                tag: tag.to_owned(),
                                clan_id,
                            },
                        );
                    }
                }
            }
        }
    }
    map
}

/// Percent-encode one query component. The `format!`-built request URLs
/// inline user input; Url encodes spaces/unicode but leaves query-structural
/// characters (`&`, `#`, `+`) alone, which would silently truncate or
/// rewrite searches (clan names freely contain `&`). Also used for the CN
/// vortex path segments (it encodes `/` too, which a path segment needs).
pub(crate) fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            },
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A search hit is trusted only when its nickname IS the queried name
/// (trimmed, case-insensitive) — anything else counts as "not found", and
/// another player's stats can never be pinned onto a roster row. Shared by
/// the WG `account/list` path and the CN vortex search, which are both
/// prefix queries whose exact account is not contractually the top hit.
pub(crate) fn nickname_matches(query: &str, found: &str) -> bool {
    query.trim().to_lowercase() == found.trim().to_lowercase()
}

/// account/list (limit=10) — one nickname → account entry. The search is a
/// prefix query, so the exact account is picked out of the hits; Ok(None)
/// when it isn't among them.
async fn account_list_one(
    client: &reqwest::Client,
    app_id: &str,
    host: &str,
    name: &str,
) -> Result<Option<AccountListEntry>, String> {
    let list: WgResponse<Vec<AccountListEntry>> = client
        .get(format!(
            "https://{host}/wows/account/list/?application_id={app_id}&search={}&limit=10",
            encode_query(name)
        ))
        .send()
        .await
        .map_err(|e| format!("account/list request: {e}"))?
        .json()
        .await
        .map_err(|e| format!("account/list parse: {e}"))?;
    if list.status != "ok" {
        return Err(format!(
            "account/list: {}",
            list.error.message.unwrap_or_default()
        ));
    }
    Ok(list
        .data
        .and_then(|d| d.into_iter().find(|e| nickname_matches(name, &e.nickname))))
}

/// account/info for one id → the nickname. Ok(None) when the id doesn't
/// exist (WG returns an empty data object for unknown ids).
async fn account_nickname_by_id(
    client: &reqwest::Client,
    app_id: &str,
    host: &str,
    account_id: i64,
) -> Result<Option<String>, String> {
    let resp = client
        .get(format!(
            "https://{host}/wows/account/info/?application_id={app_id}&account_id={account_id}"
        ))
        .send()
        .await
        .map_err(|e| format!("account/info request: {e}"))?;
    let parsed: WgResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("account/info parse: {e}"))?;
    if parsed.status != "ok" {
        return Err(format!(
            "account/info: {}",
            parsed.error.message.unwrap_or_default()
        ));
    }
    Ok(parsed
        .data
        .as_ref()
        .and_then(|d| d.get(account_id.to_string()))
        .and_then(|v| v.get("nickname"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_owned()))
}

/// Live player-name autocomplete for the lookup sidebar: WG account/list
/// matches by substring as you type. A purely numeric query is treated as an
/// account id and resolved directly via account/info, so both nickname and
/// UID search work. Empty/short queries return an empty vec — the popup
/// renders a hint, not an error.
#[tauri::command]
pub async fn suggest_players(
    search: String,
    realm: String,
) -> Result<Vec<PlayerSuggestion>, String> {
    if realm == "cn" {
        return super::wg_api_cn::suggest_players(search).await;
    }
    let q = search.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // UID fast path: resolve the id directly; a numeric string that is NOT a
    // valid id falls back to the substring search below. Non-positive ids
    // are rejected here — WG would answer a raw 407 error otherwise.
    if let Ok(uid) = q.parse::<i64>() {
        if uid > 0 {
            if let Some(nickname) = account_nickname_by_id(&client, &app_id, host, uid).await? {
                return Ok(vec![PlayerSuggestion {
                    account_id: uid,
                    nickname,
                }]);
            }
        }
    }
    if q.chars().count() < MIN_SEARCH_CHARS {
        return Ok(Vec::new());
    }
    let resp = client
        .get(format!(
            "https://{host}/wows/account/list/?application_id={app_id}&search={}&limit=10",
            encode_query(&q)
        ))
        .send()
        .await
        .map_err(|e| format!("account/list request: {e}"))?
        .json::<WgResponse<Vec<AccountListEntry>>>()
        .await
        .map_err(|e| format!("account/list parse: {e}"))?;
    if resp.status != "ok" {
        return Err(format!(
            "account/list: {}",
            resp.error.message.unwrap_or_default()
        ));
    }
    Ok(resp
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|e| PlayerSuggestion {
            account_id: e.account_id,
            nickname: e.nickname,
        })
        .collect())
}

/// Live clan autocomplete: WG clans/list matches by tag/name substring. A
/// purely numeric query is a clan id resolved directly via clans/info.
#[tauri::command]
pub async fn suggest_clans(search: String, realm: String) -> Result<Vec<ClanSuggestion>, String> {
    if realm == "cn" {
        return super::wg_api_cn::suggest_clans(search).await;
    }
    let q = search.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Numeric query = clan id (non-positive ids skip the fast path — WG
    // would answer a raw 407 error otherwise).
    if let Ok(clan_id) = q.parse::<i64>() {
        if clan_id > 0 {
            if let Some(node) = fetch_clan_node(&client, &app_id, host, clan_id).await? {
                return Ok(vec![clan_suggestion_of(clan_id, &node)]);
            }
        }
    }
    if q.chars().count() < MIN_SEARCH_CHARS {
        return Ok(Vec::new());
    }
    let resp = client
        .get(format!(
            "https://{host}/wows/clans/list/?application_id={app_id}&search={}&limit=10",
            encode_query(&q)
        ))
        .send()
        .await
        .map_err(|e| format!("clans/list request: {e}"))?
        .json::<WgResponse<Vec<ClanListEntry>>>()
        .await
        .map_err(|e| format!("clans/list parse: {e}"))?;
    if resp.status != "ok" {
        return Err(format!(
            "clans/list: {}",
            resp.error.message.unwrap_or_default()
        ));
    }
    Ok(resp
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|c| ClanSuggestion {
            clan_id: c.clan_id,
            tag: c.tag,
            name: c.name,
            members_count: c.members_count,
        })
        .collect())
}

/// clans/info for one clan id (with the members extra). Ok(None) when the
/// clan id doesn't exist (WG returns null data for unknown ids).
async fn fetch_clan_node(
    client: &reqwest::Client,
    app_id: &str,
    host: &str,
    clan_id: i64,
) -> Result<Option<serde_json::Value>, String> {
    let cid = clan_id.to_string();
    let resp = client
        .get(format!(
            "https://{host}/wows/clans/info/?application_id={app_id}&clan_id={cid}&extra=members"
        ))
        .send()
        .await
        .map_err(|e| format!("clans/info request: {e}"))?;
    let parsed: WgResponse<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("clans/info parse: {e}"))?;
    if parsed.status != "ok" {
        return Err(format!(
            "clans/info: {}",
            parsed.error.message.unwrap_or_default()
        ));
    }
    Ok(parsed
        .data
        .as_ref()
        .and_then(|d| d.get(&cid))
        .filter(|v| !v.is_null())
        .cloned())
}

pub(crate) fn clan_suggestion_of(clan_id: i64, node: &serde_json::Value) -> ClanSuggestion {
    ClanSuggestion {
        clan_id,
        tag: node
            .get("tag")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        name: node
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        members_count: node.get("members_count").and_then(|v| v.as_i64()),
    }
}

/// Clan overview: clans/info (metadata + roster roles) plus ONE batched
/// account/info sweep over all member ids (the endpoint accepts up to 100
/// ids per call; WoWS clans cap at ~50 members) resolving nicknames and PvP
/// stats. Aggregate fields are computed across visible members — WG has no
/// clan-wide aggregate endpoint.
#[tauri::command]
pub async fn lookup_clan_info(clan_id: i64, realm: String) -> Result<ClanInfo, String> {
    if realm == "cn" {
        return super::wg_api_cn::lookup_clan_info(clan_id).await;
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let node = fetch_clan_node(&client, &app_id, host, clan_id)
        .await?
        .ok_or_else(|| format!("no clan found for id {clan_id} on {realm}"))?;

    // Roster stats in ≤ ceil(n/100) batched account/info calls.
    let member_ids: Vec<i64> = node
        .get("members_ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    let mut roster = serde_json::Map::new();
    for chunk in member_ids.chunks(100) {
        let id_list = chunk
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        // Same extra-gated division splits as the single/batch lookups;
        // without them roster PR degrades to the overall-WR fallback and
        // disagrees with the player card for the same account.
        let resp = client
            .get(format!(
                "https://{host}/wows/account/info/?application_id={app_id}&account_id={id_list}\
                 &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3"
            ))
            .send()
            .await
            .map_err(|e| format!("account/info request: {e}"))?;
        let parsed: WgResponse<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("account/info parse: {e}"))?;
        if parsed.status != "ok" {
            return Err(format!(
                "account/info: {}",
                parsed.error.message.unwrap_or_default()
            ));
        }
        if let Some(data) = parsed.data.and_then(|d| d.as_object().cloned()) {
            for (k, v) in data {
                roster.insert(k, v);
            }
        }
    }

    Ok(clan_info_from_response(
        clan_id,
        &realm,
        &node,
        &serde_json::Value::Object(roster),
    ))
}

/// Per-member PvP extraction result: the display stats plus the raw damage
/// total used for the clan-wide average.
struct MemberPvp {
    stats: ClanMemberStats,
    damage_dealt: i64,
}

/// Extract one member's stats from their account/info player node.
/// Missing/null statistics (hidden profile) → hidden=true with no stats.
fn member_pvp_of(player_node: Option<&serde_json::Value>) -> MemberPvp {
    let empty = MemberPvp {
        stats: ClanMemberStats {
            hidden: true,
            ..Default::default()
        },
        damage_dealt: 0,
    };
    let statistics = player_node
        .filter(|v| !v.is_null())
        .and_then(|v| v.get("statistics"))
        .filter(|v| !v.is_null());
    let Some(pvp) = statistics
        .and_then(|s| s.get("pvp"))
        .filter(|v| !v.is_null())
    else {
        return empty;
    };
    // Full deep-stat extraction (incl. the community PR proxy) shares the
    // player-card code path; `wins` and the raw damage total are only needed
    // for the roster display and the clan-wide aggregate.
    let p = PvpStats::extract(statistics);
    let wins = get_i64(pvp, "wins");
    let damage = get_i64(pvp, "damage_dealt").or_else(|| get_i64(pvp, "damage_caused"));
    MemberPvp {
        stats: ClanMemberStats {
            battles: p.battles,
            wins,
            winrate: p.winrate,
            avg_damage: p.avg_damage,
            pr: p.pr,
            avg_xp: p.avg_xp,
            kd_ratio: p.kd_ratio,
            survival_rate: p.survival_rate,
            hidden: false,
        },
        damage_dealt: damage.unwrap_or(0),
    }
}

/// Assemble a `ClanInfo` from the clans/info node and the batched
/// account/info roster (id → player node). Pure — unit-tested. Members come
/// from the `members` extra (roles + join dates) with `members_ids` as the
/// fallback when the extra was not requested.
fn clan_info_from_response(
    clan_id: i64,
    realm: &str,
    clan_node: &serde_json::Value,
    roster: &serde_json::Value,
) -> ClanInfo {
    let members_map = clan_node
        .get("members")
        .filter(|v| !v.is_null())
        .and_then(|m| m.as_object());
    let ids: Vec<i64> = members_map
        .map(|m| {
            m.keys()
                .filter_map(|k| k.parse::<i64>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|parsed| !parsed.is_empty())
        .unwrap_or_else(|| {
            clan_node
                .get("members_ids")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                .unwrap_or_default()
        });

    let mut members = Vec::with_capacity(ids.len());
    let (mut total_battles, mut total_wins, mut total_damage) = (0i64, 0i64, 0i64);
    let mut hidden_count = 0i64;
    let mut member_prs: Vec<i64> = Vec::new();
    for &id in &ids {
        let key = id.to_string();
        let member_node = members_map.and_then(|m| m.get(key.as_str()));
        let role = member_node
            .and_then(|m| m.get("role"))
            .and_then(|r| r.as_str())
            .unwrap_or("private")
            .to_owned();
        let joined_at = member_node
            .and_then(|m| m.get("joined_at"))
            .and_then(|j| j.as_i64());
        let player = roster.get(&key).filter(|v| !v.is_null());
        let name = player
            .and_then(|p| p.get("nickname"))
            .and_then(|n| n.as_str())
            .map(|s| s.to_owned())
            .unwrap_or_else(|| format!("#{id}"));
        let pvp = member_pvp_of(player);
        if pvp.stats.hidden {
            hidden_count += 1;
        } else if let Some(pr) = pvp.stats.pr {
            member_prs.push(pr);
        }
        total_battles += pvp.stats.battles.unwrap_or(0);
        total_wins += pvp.stats.wins.unwrap_or(0);
        total_damage += pvp.damage_dealt;
        members.push(ClanMember {
            account_id: id,
            name,
            role,
            joined_at,
            stats: pvp.stats,
        });
    }

    let members_count = clan_node
        .get("members_count")
        .and_then(|v| v.as_i64())
        .unwrap_or(ids.len() as i64);
    let winrate = if total_battles > 0 {
        100.0 * total_wins as f32 / total_battles as f32
    } else {
        0.0
    };
    let avg_damage = if total_battles > 0 {
        total_damage as f32 / total_battles as f32
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
        realm: realm.to_owned(),
        description: clan_node
            .get("description")
            .and_then(|v| v.as_str())
            .map(decode_wg_text),
        members_count,
        created_at: clan_node.get("created_at").and_then(|v| v.as_i64()),
        members,
        total_battles,
        total_wins,
        winrate,
        avg_damage,
        avg_pr,
        hidden_count,
    }
}

/// Named HTML entities that show up in WG-escaped clan text (players type
/// quotes, arrows, dashes); anything outside this table must arrive
/// numeric-encoded or it passes through visibly.
const WG_NAMED_ENTITIES: &[(&str, &str)] = &[
    ("quot", "\""),
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("apos", "'"),
    ("nbsp", "\u{00a0}"),
    ("hellip", "…"),
    ("mdash", "—"),
    ("ndash", "–"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("laquo", "«"),
    ("raquo", "»"),
    ("deg", "°"),
    ("middot", "·"),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
];

/// Parse one entity at the start of `s` (which must begin with '&').
/// Returns the decoded text and the consumed byte length; `None` leaves the
/// '&' literal. Handles named entities plus decimal (`&#39;`) and hex
/// (`&#x27;`) character references — WG encodes newlines as `&#10;` in some
/// descriptions, so control characters decode normally.
fn parse_wg_entity(s: &str) -> Option<(String, usize)> {
    let body = s.strip_prefix('&')?;
    if let Some(rest) = body.strip_prefix('#') {
        let (digits, radix, head) =
            if let Some(rest) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                (rest, 16, 3) // '&' '#' 'x'
            } else {
                (rest, 10, 2) // '&' '#'
            };
        let end = digits.find(';')?;
        if end == 0 {
            return None;
        }
        let num = u32::from_str_radix(&digits[..end], radix).ok()?;
        let ch = char::from_u32(num)?;
        return Some((ch.to_string(), head + end + 1)); // + ';'
    }
    let end = body.find(';')?;
    let name = &body[..end];
    let text = WG_NAMED_ENTITIES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, text)| *text)?;
    Some((text.to_owned(), 2 + end)) // '&' + name + ';'
}

/// Clean a WG-provided rich-text field (clan description) for display:
/// decode HTML entities in a single left-to-right pass (`&amp;quot;`
/// correctly yields `&quot;`, not a double decode; unknown or malformed
/// entities pass through untouched), then normalize whitespace — CRLF/CR to
/// LF and tabs to spaces — so the UI can render the result verbatim with
/// `white-space: pre-line`. Entity-idempotent, so it also serves the CN
/// clan descriptions (plain text) for the whitespace pass alone.
pub(crate) fn decode_wg_text(raw: &str) -> String {
    // Longest decodable form is `&#x10FFFF;` (10 bytes); anything longer is
    // not an entity we care about.
    const MAX_ENTITY: usize = 10;

    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            let end = bytes[i..]
                .iter()
                .position(|&b| b == b'&')
                .map_or(bytes.len(), |p| i + p);
            out.push_str(&raw[i..end]);
            i = end;
            continue;
        }
        // Clamp the window end down to a char boundary — `i + MAX_ENTITY`
        // can land inside a multi-byte character (e.g. "&公会" after a bare
        // '&'), which would panic the slice.
        let mut window_end = raw.len().min(i + MAX_ENTITY);
        while window_end < raw.len() && !raw.is_char_boundary(window_end) {
            window_end -= 1;
        }
        let window = &raw[i..window_end];
        match parse_wg_entity(window) {
            Some((text, consumed)) => {
                out.push_str(&text);
                i += consumed;
            },
            None => {
                out.push('&');
                i += 1;
            },
        }
    }
    out.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\t', " ")
}

/// Parse a dog_tag JSON object from the Vortex API into a DogTag struct.
/// The Vortex response has fields like `texture_id`, `symbol_id`,
/// `border_color_id`, `background_color_id`, `background_id`. The color
/// fields are ARGB-packed u32 values. Standalone medal emblems (patches /
/// unique emblems) carry only `symbol_id` and zero out every other field,
/// so the all-zero tag — an account that never customised anything — is
/// the only shape rejected here.
pub(crate) fn parse_dog_tag(v: &serde_json::Value) -> Option<wowsp_tauri_shared::DogTag> {
    let get_u32 = |key: &str| -> u32 {
        v.get(key)
            .and_then(|x| x.as_u64())
            .map(|x| x as u32)
            .unwrap_or(0)
    };
    let tag = wowsp_tauri_shared::DogTag {
        texture_id: get_u32("texture_id"),
        symbol_id: get_u32("symbol_id"),
        border_color: get_u32("border_color_id"),
        background_color: get_u32("background_color_id"),
        background_id: get_u32("background_id"),
    };
    // Only return if at least one field is non-zero.
    if tag.texture_id != 0
        || tag.symbol_id != 0
        || tag.border_color != 0
        || tag.background_color != 0
        || tag.background_id != 0
    {
        Some(tag)
    } else {
        None
    }
}

/// Extracts deep PvP stats from the WG account/info `statistics.pvp` node.
/// All fields are optional — hidden profiles yield null, and casual accounts
/// may lack division splits. PR is a career rating derived from an
/// ApeRadar-style weighted winrate (see `compute_pr`), not WG's internal
/// hidden score. Also fed with vortex-normalized nodes by `wg_api_cn`.
pub(crate) struct PvpStats {
    pub(crate) battles: Option<i64>,
    pub(crate) winrate: Option<f32>,
    pub(crate) avg_damage: Option<f32>,
    pub(crate) avg_xp: Option<f32>,
    pub(crate) kd_ratio: Option<f32>,
    pub(crate) survival_rate: Option<f32>,
    pub(crate) hit_rate: Option<f32>,
    pub(crate) pr: Option<i64>,
    pub(crate) ships_played: Option<i64>,
    pub(crate) solo_wr: Option<f32>,
    pub(crate) div2_wr: Option<f32>,
    pub(crate) div3_wr: Option<f32>,
}

impl PvpStats {
    pub(crate) fn extract(stats: Option<&serde_json::Value>) -> Self {
        let statistics = stats.filter(|v| !v.is_null());
        let statistics = match statistics {
            Some(s) => s,
            None => return Self::empty(),
        };
        let pvp = statistics.get("pvp").filter(|v| !v.is_null());
        let pvp = match pvp {
            Some(p) => p,
            None => return Self::empty(),
        };

        let battles = get_i64(pvp, "battles");
        let wins = get_i64(pvp, "wins");
        let winrate = match (wins, battles) {
            (Some(w), Some(b)) if b > 0 => Some(100.0 * w as f32 / b as f32),
            _ => None,
        };

        let damage = get_i64(pvp, "damage_dealt").or_else(|| get_i64(pvp, "damage_caused"));
        let avg_damage = match (damage, battles) {
            (Some(d), Some(b)) if b > 0 => Some(d as f32 / b as f32),
            _ => None,
        };

        let xp = get_i64(pvp, "xp");
        let avg_xp = match (xp, battles) {
            (Some(x), Some(b)) if b > 0 => Some(x as f32 / b as f32),
            _ => None,
        };

        let frags = get_i64(pvp, "frags");
        let survived = get_i64(pvp, "survived_battles");
        let kd_ratio = match (frags, battles, survived) {
            (Some(f), Some(b), Some(s)) if b > s => Some(f as f32 / (b - s) as f32),
            _ => None,
        };
        let survival_rate = match (survived, battles) {
            (Some(s), Some(b)) if b > 0 => Some(100.0 * s as f32 / b as f32),
            _ => None,
        };

        // Main battery shots/hits are nested under a "main_battery" sub-object
        // (WG changed the schema: formerly flat main_battery_shots/hits, now
        // main_battery.{shots,hits}). Try both layouts for compatibility.
        let mb = pvp.get("main_battery");
        let shots = mb
            .and_then(|m| get_i64(m, "shots"))
            .or_else(|| get_i64(pvp, "main_battery_shots"));
        let hits = mb
            .and_then(|m| get_i64(m, "hits"))
            .or_else(|| get_i64(pvp, "main_battery_hits"));
        let hit_rate = match (hits, shots) {
            (Some(h), Some(s)) if s > 0 => Some(100.0 * h as f32 / s as f32),
            _ => None,
        };

        let ships_played = get_i64(pvp, "battles").and({
            // ships_played is approximated by counting ship entries — but
            // account/info doesn't include per-ship; we leave it as battles
            // count fallback (the ships/{shipId} endpoint gives the real count
            // in a follow-up call). Set to None for now.
            None::<i64>
        });

        // Career PR: ApeRadar-style weighted winrate over the division
        // splits, falling back to the overall PvP winrate when the account
        // carries no splits.
        let solo = div_stats(statistics, "pvp_solo");
        let div2 = div_stats(statistics, "pvp_div2");
        let div3 = div_stats(statistics, "pvp_div3");
        let pr = compute_pr(solo, div2, div3).or_else(|| match (winrate, battles) {
            (Some(w), Some(b)) if b > 0 => compute_pr(Some((w, b)), None, None),
            _ => None,
        });

        Self {
            battles,
            winrate,
            avg_damage,
            avg_xp,
            kd_ratio,
            survival_rate,
            hit_rate,
            pr,
            ships_played,
            solo_wr: solo.map(|(wr, _)| wr),
            div2_wr: div2.map(|(wr, _)| wr),
            div3_wr: div3.map(|(wr, _)| wr),
        }
    }

    fn empty() -> Self {
        Self {
            battles: None,
            winrate: None,
            avg_damage: None,
            avg_xp: None,
            kd_ratio: None,
            survival_rate: None,
            hit_rate: None,
            pr: None,
            ships_played: None,
            solo_wr: None,
            div2_wr: None,
            div3_wr: None,
        }
    }
}

fn get_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Extracts (winrate %, battles) from a per-division stats node
/// (pvp_solo / pvp_div2 / pvp_div3).
fn div_stats(statistics: &serde_json::Value, key: &str) -> Option<(f32, i64)> {
    let node = statistics.get(key)?;
    if node.is_null() {
        return None;
    }
    let b = node.get("battles")?.as_i64()?;
    let w = node.get("wins")?.as_i64()?;
    if b > 0 {
        Some((100.0 * w as f32 / b as f32, b))
    } else {
        None
    }
}

/// ApeRadar's weighted winrate (see the reference implementation in
/// ApeRadar's ApiUtils.CalcWeightedWinrate): division winrates blended by
/// battle count with fixed multipliers (solo ×5 / div2 ×2 / div3 ×1 —
/// ApeRadar's defaults). Returns the blend in percent, or None when no
/// bucket carries battles.
pub(crate) fn weighted_winrate(
    solo: Option<(f32, i64)>,
    div2: Option<(f32, i64)>,
    div3: Option<(f32, i64)>,
) -> Option<f32> {
    const SOLO_WEIGHT: f32 = 5.0;
    const DIV2_WEIGHT: f32 = 2.0;
    const DIV3_WEIGHT: f32 = 1.0;
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;
    for (wr, battles, mult) in [
        solo.map(|(wr, b)| (wr, b, SOLO_WEIGHT)),
        div2.map(|(wr, b)| (wr, b, DIV2_WEIGHT)),
        div3.map(|(wr, b)| (wr, b, DIV3_WEIGHT)),
    ]
    .into_iter()
    .flatten()
    {
        if battles <= 0 {
            continue;
        }
        let weight = battles as f32 * mult;
        weighted_sum += wr * weight;
        weight_total += weight;
    }
    if weight_total > 0.0 {
        Some(weighted_sum / weight_total)
    } else {
        None
    }
}

/// Winrate (percent) → community PR scale. The anchors put ApeRadar's color
/// lines (47/52/56/60/65%) exactly on the standard PR boundaries
/// (750/1350/1750/2100/2450); piecewise-linear in between, clamped to 0
/// below 35% and extrapolated along the top segment above 65%. Winrate-only
/// by design: the previous damage-term formula saturated at ~40k avg damage
/// and handed even all-red accounts a green ~1600.
const WR_TO_PR_ANCHORS: [(f32, f32); 6] = [
    (35.0, 0.0),
    (47.0, 750.0),
    (52.0, 1350.0),
    (56.0, 1750.0),
    (60.0, 2100.0),
    (65.0, 2450.0),
];

pub(crate) fn rating_from_winrate(wr: f32) -> i64 {
    let lerp = |(x0, y0): (f32, f32), (x1, y1): (f32, f32)| y0 + (wr - x0) / (x1 - x0) * (y1 - y0);
    if wr <= WR_TO_PR_ANCHORS[0].0 {
        return 0;
    }
    for pair in WR_TO_PR_ANCHORS.windows(2) {
        if wr <= pair[1].0 {
            return lerp(pair[0], pair[1]).round() as i64;
        }
    }
    lerp(WR_TO_PR_ANCHORS[4], WR_TO_PR_ANCHORS[5]).round() as i64
}

/// Career PR proxy: ApeRadar's weighted winrate mapped onto the community PR
/// scale (see `rating_from_winrate`). Returns None when no input bucket
/// carries battles. This is a tier-badge score, not WG's hidden internal
/// rating.
pub(crate) fn compute_pr(
    solo: Option<(f32, i64)>,
    div2: Option<(f32, i64)>,
    div3: Option<(f32, i64)>,
) -> Option<i64> {
    Some(rating_from_winrate(weighted_winrate(solo, div2, div3)?))
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
#[derive(Deserialize)]
struct AccountListEntry {
    account_id: i64,
    nickname: String,
}

/// One entry of the clans/list autocomplete response.
#[derive(Deserialize)]
struct ClanListEntry {
    clan_id: i64,
    tag: String,
    name: String,
    #[serde(default)]
    members_count: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dog_tag_accepts_standalone_medal_shape() {
        // Live-response fixture (player 627197848, asia id 2028145456): a
        // standalone medal emblem — the patch artwork rides in symbol_id and
        // every other field is zero.
        let raw = serde_json::json!({
            "texture_id": 0,
            "symbol_id": 4238887856_u64,
            "border_color_id": 0,
            "background_color_id": 0,
            "background_id": 0
        });
        let tag = parse_dog_tag(&raw).expect("standalone medal must parse");
        assert_eq!(tag.symbol_id, 4238887856);
        assert_eq!(tag.background_id, 0);
        assert_eq!(tag.background_color, 0);
        assert_eq!(tag.border_color, 0);
    }

    #[test]
    fn parse_dog_tag_rejects_all_zero_tag() {
        let raw = serde_json::json!({
            "texture_id": 0,
            "symbol_id": 0,
            "border_color_id": 0,
            "background_color_id": 0,
            "background_id": 0
        });
        assert!(parse_dog_tag(&raw).is_none());
    }

    #[test]
    fn parse_dog_tag_accepts_full_custom_tag() {
        let raw = serde_json::json!({
            "texture_id": 4293282736_u64,
            "symbol_id": 4274998192_u64,
            "border_color_id": 4283911088_u64,
            "background_color_id": 4293577648_u64,
            "background_id": 4293905328_u64
        });
        assert!(parse_dog_tag(&raw).is_some());
    }

    #[test]
    fn nickname_matches_accepts_exact_name_ignoring_case_and_padding() {
        assert!(nickname_matches("Player_2077", "Player_2077"));
        assert!(nickname_matches("player_2077", "Player_2077"));
        assert!(nickname_matches("  猎风  ", "猎风"));
        assert!(nickname_matches("Иван", "иван"));
    }

    #[test]
    fn nickname_matches_rejects_prefix_lookalikes() {
        assert!(!nickname_matches("Player", "Player_2077"));
        assert!(!nickname_matches("Player", ""));
        assert!(!nickname_matches("", "Player"));
    }

    #[test]
    fn pvp_stats_extracts_all_fields() {
        // Mirrors the real WG account/info response shape: the top-level is
        // "statistics", with "pvp" as a child. Damage is "damage_dealt" (WG
        // renamed it from "damage_caused"). Main battery shots/hits are nested
        // under a "main_battery" sub-object. Division splits are siblings of
        // "pvp" under "statistics" (pvp_solo / pvp_div2 / pvp_div3).
        let raw = serde_json::json!({
            "pvp": {
                "battles": 1000,
                "wins": 550,
                "damage_dealt": 1_500_000,
                "xp": 1_200_000,
                "frags": 800,
                "survived_battles": 300,
                "main_battery": { "shots": 5000, "hits": 1500 }
            },
            "pvp_solo": { "battles": 600, "wins": 330 },
            "pvp_div2": { "battles": 200, "wins": 110 },
            "pvp_div3": { "battles": 200, "wins": 110 }
        });
        let p = PvpStats::extract(Some(&raw));
        assert_eq!(p.battles, Some(1000));
        assert_eq!(p.winrate, Some(55.0));
        assert_eq!(p.avg_damage, Some(1500.0));
        assert_eq!(p.avg_xp, Some(1200.0));
        // 800 frags / 700 deaths ≈ 1.143
        assert!((p.kd_ratio.unwrap() - 1.143).abs() < 0.01);
        assert_eq!(p.survival_rate, Some(30.0));
        assert_eq!(p.hit_rate, Some(30.0));
        assert_eq!(p.solo_wr, Some(55.0));
        assert_eq!(p.div2_wr, Some(55.0));
        assert_eq!(p.div3_wr, Some(55.0));
        assert!(p.pr.is_some());
    }

    #[test]
    fn pvp_stats_empty_when_null() {
        let raw = serde_json::json!({ "pvp": null });
        let p = PvpStats::extract(Some(&raw));
        assert_eq!(p.battles, None);
        assert_eq!(p.winrate, None);
        assert_eq!(p.pr, None);
    }

    #[test]
    fn pvp_stats_empty_when_no_statistics_node() {
        let p = PvpStats::extract(None);
        assert_eq!(p.battles, None);
    }

    #[test]
    fn compute_pr_returns_none_for_missing_inputs() {
        assert_eq!(compute_pr(None, None, None), None);
        // A bucket with zero battles carries no weight.
        assert_eq!(compute_pr(Some((55.0, 0)), None, None), None);
        assert!(compute_pr(Some((55.0, 100)), None, None).is_some());
    }

    #[test]
    fn rating_from_winrate_lands_on_aperadar_color_lines() {
        assert_eq!(rating_from_winrate(30.0), 0);
        assert_eq!(rating_from_winrate(35.0), 0);
        assert_eq!(rating_from_winrate(47.0), 750);
        assert_eq!(rating_from_winrate(52.0), 1350);
        assert_eq!(rating_from_winrate(56.0), 1750);
        assert_eq!(rating_from_winrate(60.0), 2100);
        assert_eq!(rating_from_winrate(65.0), 2450);
        // All-red accounts must stay red — the old damage-term formula
        // scored them ~1600 (green).
        assert_eq!(rating_from_winrate(40.0), 313);
        assert!(rating_from_winrate(45.0) < 750);
        // Monotonic, with extrapolation above the top anchor.
        assert!(rating_from_winrate(66.0) > 2450);
        assert!(rating_from_winrate(100.0) > rating_from_winrate(90.0));
    }

    #[test]
    fn weighted_winrate_blends_divisions_by_battle_count() {
        // ApeRadar defaults: solo ×5, div2 ×2, div3 ×1.
        let wr = weighted_winrate(Some((50.0, 1000)), Some((60.0, 100)), None).unwrap();
        assert!((wr - 50.3846).abs() < 0.001);
        assert!(weighted_winrate(None, None, None).is_none());
        // Zero-battle buckets carry no weight.
        let wr = weighted_winrate(Some((50.0, 0)), Some((60.0, 10)), None).unwrap();
        assert!((wr - 60.0).abs() < 1e-4);
    }

    #[test]
    fn player_stats_from_info_builds_visible_profile() {
        let info = serde_json::json!({
            "2024711808": {
                "statistics": {
                    "pvp": { "battles": 1000, "wins": 550, "damage_dealt": 1_500_000 },
                    "pvp_solo": { "battles": 600, "wins": 330 }
                },
                "leveling_tier": 12,
                "leveling_points": 3400
            }
        });
        let clan_map = HashMap::from([(
            2024711808i64,
            ClanTagInfo {
                tag: "FOO".to_string(),
                clan_id: Some(500123),
            },
        )]);
        let entry = AccountListEntry {
            account_id: 2024711808,
            nickname: "langyo".to_string(),
        };
        let s = player_stats_from_info(entry, "asia".to_string(), Some(&info), &clan_map);
        assert_eq!(s.name, "langyo");
        assert_eq!(s.winrate, Some(55.0));
        assert!(!s.hidden);
        assert_eq!(s.clan_tag.as_deref(), Some("FOO"));
        assert_eq!(s.clan_id, Some(500123));
        assert_eq!(s.leveling_tier, Some(12));
        assert_eq!(s.avg_damage, Some(1500.0));
        assert!(s.pr.is_some());
        // Batch path never pays for Vortex dog tags.
        assert!(s.dog_tag.is_none());
    }

    #[test]
    fn player_stats_from_info_marks_missing_stats_hidden() {
        // A null player node (id absent from the batch info map) counts as a
        // hidden profile — same rule as the single lookup.
        let entry = AccountListEntry {
            account_id: 7,
            nickname: "ghost".to_string(),
        };
        let s = player_stats_from_info(entry, "eu".to_string(), None, &HashMap::new());
        assert!(s.hidden);
        assert_eq!(s.winrate, None);
        assert_eq!(s.clan_tag, None);
        assert_eq!(s.clan_id, None);
    }

    #[test]
    fn encode_query_leaves_unreserved_alone_and_encodes_structural_chars() {
        assert_eq!(encode_query("Black&White"), "Black%26White");
        assert_eq!(encode_query("a#b"), "a%23b");
        assert_eq!(encode_query("a+b"), "a%2Bb");
        assert_eq!(encode_query("a b"), "a%20b");
        assert_eq!(encode_query("Az-09_.~"), "Az-09_.~");
        // Percent-encoding is byte-based: multi-byte UTF-8 encodes per byte.
        assert_eq!(encode_query("公会"), "%E5%85%AC%E4%BC%9A");
    }

    #[test]
    fn clan_list_entry_parses_wg_shape() {
        let raw = serde_json::json!([{
            "clan_id": 500123,
            "tag": "HOOD",
            "name": "Honored Order Of Death",
            "members_count": 42
        }]);
        let list: Vec<ClanListEntry> = serde_json::from_value(raw).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].clan_id, 500123);
        assert_eq!(list[0].members_count, Some(42));
    }

    #[test]
    fn clan_list_entry_tolerates_missing_members_count() {
        let raw = serde_json::json!([{ "clan_id": 1, "tag": "A", "name": "Alpha" }]);
        let list: Vec<ClanListEntry> = serde_json::from_value(raw).unwrap();
        assert_eq!(list[0].members_count, None);
    }

    #[test]
    fn clan_info_from_response_assembles_roster_and_aggregates() {
        // Mirrors the real clans/info (extra=members) + batched account/info
        // shapes: members carries role/joined_at keyed by id; the roster
        // carries nickname + statistics.pvp per id.
        let clan_node = serde_json::json!({
            "tag": "HOOD",
            "name": "Honored Order Of Death",
            "members_count": 2,
            "created_at": 1_600_000_000,
            "description": "test clan",
            "members_ids": [11, 22],
            "members": {
                "11": { "role": "commander", "joined_at": 1_600_000_001 },
                "22": { "role": "private", "joined_at": 1_600_000_002 }
            }
        });
        let roster = serde_json::json!({
            "11": {
                "nickname": "alpha",
                "statistics": { "pvp": { "battles": 100, "wins": 60, "damage_dealt": 150_000 } }
            },
            "22": { "nickname": "ghost", "statistics": { "pvp": null } }
        });
        let info = clan_info_from_response(500123, "asia", &clan_node, &roster);
        assert_eq!(info.tag, "HOOD");
        assert_eq!(info.realm, "asia");
        assert_eq!(info.members_count, 2);
        assert_eq!(info.created_at, Some(1_600_000_000));
        assert_eq!(info.description.as_deref(), Some("test clan"));
        assert_eq!(info.members.len(), 2);
        // Aggregates only count the visible member.
        assert_eq!(info.total_battles, 100);
        assert_eq!(info.total_wins, 60);
        assert!((info.winrate - 60.0).abs() < 0.01);
        assert!((info.avg_damage - 1500.0).abs() < 0.01);
        assert_eq!(info.hidden_count, 1);
        // Deep stats: the fixture's 60% WR has no division splits, so the
        // overall winrate maps through as the solo bucket → 2100 on the
        // ApeRadar-aligned scale; xp/frags/survival absent → None.
        assert_eq!(info.avg_pr, Some(2100));
        let commander = info.members.iter().find(|m| m.account_id == 11).unwrap();
        assert_eq!(commander.name, "alpha");
        assert_eq!(commander.role, "commander");
        assert_eq!(commander.joined_at, Some(1_600_000_001));
        assert_eq!(commander.stats.winrate, Some(60.0));
        assert_eq!(commander.stats.pr, Some(2100));
        assert_eq!(commander.stats.avg_xp, None);
        assert_eq!(commander.stats.kd_ratio, None);
        assert_eq!(commander.stats.survival_rate, None);
        let ghost = info.members.iter().find(|m| m.account_id == 22).unwrap();
        assert!(ghost.stats.hidden);
        assert_eq!(ghost.stats.battles, None);
    }

    #[test]
    fn clan_roster_pr_uses_weighted_division_splits() {
        // Regression: the roster batch account/info must request the
        // extra-gated division splits so roster PR blends them like the
        // player card instead of degrading to the overall-WR fallback
        // (which made the clan page disagree with the player's own page).
        let clan_node = serde_json::json!({
            "tag": "W",
            "name": "Weighted",
            "members_count": 1,
            "members_ids": [11]
        });
        // solo 48%/5000, div2 58%/1000, div3 60%/500 → overall 50.54% but
        // weighted (×5/×2/×1) ≈48.95% → PR 983, not the 1175 the overall
        // fallback would print.
        let roster = serde_json::json!({
            "11": {
                "nickname": "alpha",
                "statistics": {
                    "pvp": { "battles": 6500, "wins": 3285, "damage_dealt": 130_000_000 },
                    "pvp_solo": { "battles": 5000, "wins": 2400 },
                    "pvp_div2": { "battles": 1000, "wins": 580 },
                    "pvp_div3": { "battles": 500, "wins": 300 }
                }
            }
        });
        let info = clan_info_from_response(9, "eu", &clan_node, &roster);
        let member = &info.members[0];
        assert!((member.stats.winrate.unwrap() - 50.538).abs() < 0.01);
        assert_eq!(member.stats.pr, Some(983));
        assert_ne!(member.stats.pr, Some(1175));
        assert_eq!(info.avg_pr, Some(983));
    }

    #[test]
    fn clan_info_falls_back_to_members_ids_without_extra() {
        // Without extra=members the roles default to private and missing
        // roster entries fall back to "#id" names instead of failing.
        let clan_node = serde_json::json!({
            "tag": "B",
            "name": "Beta",
            "members_count": 1,
            "members_ids": [33]
        });
        let info = clan_info_from_response(7, "eu", &clan_node, &serde_json::json!({}));
        assert_eq!(info.members.len(), 1);
        assert_eq!(info.members[0].name, "#33");
        assert_eq!(info.members[0].role, "private");
        assert!(info.members[0].stats.hidden);
        assert_eq!(info.winrate, 0.0);
        assert_eq!(info.avg_damage, 0.0);
        assert_eq!(info.avg_pr, None);
    }

    #[test]
    fn decode_wg_text_decodes_entities_and_normalizes_whitespace() {
        // The exact artifact from the bug report: WG double-writes quotes
        // around section names in clan descriptions.
        assert_eq!(
            decode_wg_text("&quot; OBJECTIVE&quot;* HAVE FUN"),
            "\u{22} OBJECTIVE\u{22}* HAVE FUN"
        );
        // Named table + decimal + hex numeric references.
        assert_eq!(
            decode_wg_text("a&amp;b&lt;c&gt;d&#39;e&#x27;"),
            "a&b<c>d'e'"
        );
        // nbsp keeps its non-breaking character.
        assert_eq!(decode_wg_text("x&nbsp;y"), "x\u{00a0}y");
        // Single pass: `&amp;quot;` must stay `&quot;` (no double decode).
        assert_eq!(decode_wg_text("&amp;quot;"), "&quot;");
        // Unknown named entity, bare '&', and malformed numeric pass through.
        assert_eq!(decode_wg_text("&frobnicate;"), "&frobnicate;");
        assert_eq!(decode_wg_text("100% & more"), "100% & more");
        assert_eq!(decode_wg_text("&#; &#xZZ;"), "&#; &#xZZ;");
        // Out-of-range numeric reference stays literal.
        assert_eq!(decode_wg_text("&#999999999999;"), "&#999999999999;");
        // Numeric control refs decode (WG uses &#10; for line breaks).
        assert_eq!(decode_wg_text("a&#10;b"), "a\nb");
        // CRLF/CR collapse to LF, tabs to spaces.
        assert_eq!(decode_wg_text("a\r\nb\rc\td"), "a\nb\nc d");
        // Multi-byte text passes through untouched.
        assert_eq!(decode_wg_text("公会招人"), "公会招人");
        // Regression: a bare '&' whose 10-byte entity window would end
        // inside a multi-byte char must clamp, not panic.
        assert_eq!(decode_wg_text("R&D部门招聘"), "R&D部门招聘");
        assert_eq!(decode_wg_text("&éééééé"), "&éééééé");
        // A real entity followed by multi-byte text still decodes when the
        // window gets clamped shorter than MAX_ENTITY.
        assert_eq!(decode_wg_text("&quot;公会"), "\"公会");
    }

    #[test]
    fn clan_info_from_response_decodes_description_entities() {
        // The clans/info description arrives HTML-escaped from WG; the
        // assembled ClanInfo must carry display-ready text.
        let clan_node = serde_json::json!({
            "tag": "HOOD",
            "name": "Hood Detonation Boom Boom Boom",
            "members_count": 1,
            "members_ids": [11],
            "description": "&quot; OBJECTIVE&quot;* HAVE FUN,\r\nClan QQ:123"
        });
        let info = clan_info_from_response(500123, "asia", &clan_node, &serde_json::json!({}));
        assert_eq!(
            info.description.as_deref(),
            Some("\" OBJECTIVE\"* HAVE FUN,\nClan QQ:123")
        );
    }
}
