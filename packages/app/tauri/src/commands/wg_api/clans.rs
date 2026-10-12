//! Clan lookups and the lookup sidebar's autocomplete pair
//! (`suggest_players` / `suggest_clans`), plus the per-member roster assembly
//! behind `lookup_clan_info`. Split from the former single-file
//! `commands/wg_api.rs`.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;
use wowsp_tauri_shared::{ClanInfo, ClanMember, ClanMemberStats, ClanSuggestion, PlayerSuggestion};

use super::lookup_error::LookupError;
use super::shared::{
    AccountListEntry, WgResponse, account_nickname_by_id, decode_wg_text, encode_query,
};
use super::stats_math::{PrAlgo, PvpStats, get_i64};

/// Minimum length for a substring autocomplete query (WG rejects shorter
/// searches). Numeric UID queries bypass this gate.
const MIN_SEARCH_CHARS: usize = 3;

/// Clan affiliation for one account from the clans/accountinfo map.
pub(super) struct ClanTagInfo {
    pub(super) tag: String,
    pub(super) clan_id: Option<i64>,
}

/// Clan tags (+ clan ids) for a list of account ids in one request.
/// Best-effort: any failure yields an empty map (clan tag is display sugar,
/// never fatal).
pub(super) async fn fetch_clan_info_for_accounts(
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
    let Some(resp) = super::upstream_health::best_effort_get(
        client,
        host,
        "clans/accountinfo",
        format!(
            "https://{host}/wows/clans/accountinfo/?application_id={app_id}&account_id={id_list}&extra=clan"
        ),
    )
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
    let resp = super::upstream_health::recorded_get(
        &client,
        host,
        "account/list",
        format!(
            "https://{host}/wows/account/list/?application_id={app_id}&search={}&limit=10",
            encode_query(&q)
        ),
    )
    .await?
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
    let resp = super::upstream_health::recorded_get(
        &client,
        host,
        "clans/list",
        format!(
            "https://{host}/wows/clans/list/?application_id={app_id}&search={}&limit=10",
            encode_query(&q)
        ),
    )
    .await?
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
    let resp = super::upstream_health::recorded_get(
        client,
        host,
        "clans/info",
        format!(
            "https://{host}/wows/clans/info/?application_id={app_id}&clan_id={cid}&extra=members"
        ),
    )
    .await?;
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
/// clan-wide aggregate endpoint. `pr_algo` selects the member PR algorithm;
/// under "expected" the roster answers PR=None (see `clan_info_from_response`).
/// Rejects with a structured [`LookupError`] like the player lookup.
#[tauri::command]
pub async fn lookup_clan_info(
    clan_id: i64,
    realm: String,
    pr_algo: Option<String>,
) -> Result<ClanInfo, LookupError> {
    let algo = PrAlgo::from_param(pr_algo.as_deref());
    if realm == "cn" {
        return super::wg_api_cn::lookup_clan_info(clan_id, algo).await;
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm)?;
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let node = fetch_clan_node(&client, &app_id, host, clan_id)
        .await?
        .ok_or_else(|| LookupError::not_found_clan(clan_id.to_string(), realm.clone()))?;

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
        let resp = super::upstream_health::recorded_get(
            &client,
            host,
            "account/info",
            format!(
                "https://{host}/wows/account/info/?application_id={app_id}&account_id={id_list}\
                 &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3"
            ),
        )
        .await?;
        let parsed: WgResponse<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("account/info parse: {e}"))?;
        if parsed.status != "ok" {
            return Err(LookupError::api(format!(
                "account/info: {}",
                parsed.error.message.unwrap_or_default()
            )));
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
        algo,
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
///
/// Under `PrAlgo::Expected` every member PR is None: the expected algorithm
/// needs per-ship rows per member, and a ships/stats fetch for every roster
/// row would multiply the request budget by the member count. The roster
/// renders "--" rather than a winrate proxy the player card wouldn't agree
/// with (same call on the CN roster).
pub(super) fn clan_info_from_response(
    clan_id: i64,
    realm: &str,
    clan_node: &serde_json::Value,
    roster: &serde_json::Value,
    pr_algo: PrAlgo,
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
        let pvp = if pr_algo == PrAlgo::Expected {
            let mut pvp = pvp;
            pvp.stats.pr = None;
            pvp
        } else {
            pvp
        };
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
/// One entry of the clans/list autocomplete response.
#[derive(Deserialize)]
pub(super) struct ClanListEntry {
    pub(super) clan_id: i64,
    pub(super) tag: String,
    pub(super) name: String,
    #[serde(default)]
    pub(super) members_count: Option<i64>,
}
