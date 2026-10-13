//! Player stats lookups and the live-roster batch: the process-lifetime
//! session cache, the name/id resolution passes (home realm + cross-server
//! Clan-Battles probes) and the `PlayerStats` assembly. Split from the former
//! single-file `commands/wg_api.rs`.

use anyhow::{Result, anyhow};

use std::collections::HashMap;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use wowsp_tauri_shared::{CommandResult, PlayerStats};

use super::clans::{ClanTagInfo, fetch_clan_info_for_accounts};
use super::lookup_error::LookupError;
use super::shared::{
    AccountListEntry, WgResponse, account_list_one, account_nickname_by_id, encode_query,
    nickname_matches, parse_dog_tag, pick_verified_entry,
};
use super::stats_math::{PrAlgo, PvpStats, account_expected_pr_for};

/// Concurrency cap for the batch name→account resolution. WG public API
/// rate-limits ~20 req/s per IP; 4 in-flight keeps a full 24-player roster
/// inside a couple of waves without tripping it.
const BATCH_CONCURRENCY: usize = 4;

/// Exact-name search hits carried per roster name into the account/info
/// sweep. The search index keeps STALE entries: an account renamed away
/// stays listed under its old nickname, and a freed nickname can later be
/// claimed by another account — so the first exact hit is not always the
/// account that actually bears the name (ghost + live pairs observed in
/// the wild). Three slots cover such pairs with margin while a full
/// 24-name roster stays far under the info endpoint's 100-id cap.
const EXACT_HIT_CANDIDATES: usize = 3;

/// account/info ids accepted per request (the endpoint's documented cap).
/// The batch's candidate ids stay well under one chunk; the cap only
/// guards pathological caller input.
const WG_INFO_IDS_PER_REQUEST: usize = 100;

/// Process-lifetime roster answers, keyed (realm, name) — see the batch
/// command's doc comment. Values are PRE-algo base stats; `None` (not
/// found) is cached too, mirroring the client-side caches this serves.
type RosterStatsCache = HashMap<(String, String), Option<PlayerStats>>;
static ROSTER_STATS_CACHE: std::sync::LazyLock<std::sync::Mutex<RosterStatsCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Cached answer for one roster name — `Some(None)` is a cached MISS, an
/// absent entry still needs resolving. Infallible on a poisoned lock (the
/// critical sections are trivial clones, and degrading to a cache miss
/// just re-fetches). Shared by the WG and CN batch arms.
pub(crate) fn roster_cache_get(realm: &str, name: &str) -> Option<Option<PlayerStats>> {
    let cache = ROSTER_STATS_CACHE.lock().ok()?;
    cache.get(&(realm.to_string(), name.to_string())).cloned()
}

/// Wipe the process-lifetime roster cache — the manual "refresh stats"
/// button clears this before re-queueing the roster so the batch is a true
/// from-scratch request instead of instant session-cache answers. The
/// per-ship session cache (the ship-scoped roster source both windows
/// share — see ship_stats.rs) rides along, so a forced refresh stays
/// forced there too.
#[tauri::command]
pub fn clear_roster_stats_cache() -> CommandResult<()> {
    if let Ok(mut cache) = ROSTER_STATS_CACHE.lock() {
        cache.clear();
    }
    super::ship_stats::clear_ship_stats_session_cache();
    Ok(())
}

/// Store one roster name's PRE-algo answer. See [`roster_cache_get`].
pub(crate) fn roster_cache_insert(realm: &str, name: &str, stats: Option<PlayerStats>) {
    if let Ok(mut cache) = ROSTER_STATS_CACHE.lock() {
        cache.insert((realm.to_string(), name.to_string()), stats);
    }
}

/// Look up one player's stats by name on the given realm. `pr_algo` selects
/// the PR algorithm ("winrate" default / "expected" = wows-numbers); see
/// [`PrAlgo`]. Rejects with a structured [`LookupError`] so the UI can
/// localize "not found" and show the official API's error detail.
#[tauri::command]
pub async fn lookup_player_stats(
    name: String,
    realm: String,
    pr_algo: Option<String>,
) -> Result<PlayerStats, LookupError> {
    // Field-report anchor: successful lookups log nothing anywhere on this
    // path, so a "the app dies when I query X" report could not be told
    // apart from "the lookup never ran" (the 2026-10-13 crash triage paid
    // for that gap). One line at each end — the QUERY'S LENGTH, never the
    // nickname itself, matching the roster batch's count-only discipline.
    let algo = PrAlgo::from_param(pr_algo.as_deref());
    let lookup_started = std::time::Instant::now();
    let query_len = name.trim().chars().count();
    tracing::info!(
        realm = %realm,
        algo = ?algo,
        query_len,
        "interactive stats lookup started"
    );
    if realm == "cn" {
        return super::wg_api_cn::lookup_player_stats(name, algo).await;
    }
    let app_id = super::wg_realm::application_id(&realm);
    let host = super::wg_realm::api_host(&realm).map_err(|e| LookupError::from(e.to_string()))?;
    let vortex_host =
        super::wg_realm::vortex_host(&realm).map_err(|e| LookupError::from(e.to_string()))?;
    // Per-request timeout — a hung connection must not block a UI lookup
    // indefinitely.
    let client = crate::commands::network::http_client_builder()
        .map_err(|e| LookupError::from(e.to_string()))?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1. Resolve the query to an account. A purely numeric query is a UID
    //    ("nickname or UID" search): hit account/info directly and only fall
    //    back to the name search when the id doesn't resolve (numeric-looking
    //    nicknames are rare but exist). `resolved_by_uid` marks the direct
    //    path — its nickname came live from account/info, so the ghost
    //    guard below has nothing to add.
    let mut resolved_by_uid = false;
    let entry = match name.trim().parse::<i64>() {
        // anyhow→LookupError boundary: the structured rejection keeps its
        // `From<String>` bridge, so the anyhow error renders through its
        // Display (the historical message) on the way in.
        Ok(uid) if uid > 0 => {
            match account_nickname_by_id(&client, &app_id, host, uid)
                .await
                .map_err(|e| e.to_string())?
            {
                Some(nickname) => {
                    resolved_by_uid = true;
                    Some(AccountListEntry {
                        account_id: uid,
                        nickname,
                    })
                },
                None => account_list_one(&client, &app_id, host, &name).await?,
            }
        },
        _ => account_list_one(&client, &app_id, host, &name).await?,
    }
    .ok_or_else(|| LookupError::not_found_account(name.clone(), realm.clone()))?;

    // 2-4. account/info, clan tag and Vortex dog tag only need the account
    //    id — run the three requests concurrently instead of serially.
    let info_fut = async {
        // pvp_solo/div2/div3 and the rank_* splits are extra-gated: without
        // the `extra` param the API omits them entirely (division winrates
        // render "—", ranked stats vanish).
        let url = format!(
            "https://{host}/wows/account/info/?application_id={app_id}&account_id={}\
             &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3,\
             statistics.rank_solo,statistics.rank_div2,statistics.rank_div3",
            entry.account_id
        );
        let resp = super::upstream_health::recorded_get(&client, host, "account/info", url)
            .await
            .map_err(|e| e.to_string())?;
        resp.json::<WgResponse<serde_json::Value>>()
            .await
            .map_err(|e| format!("account/info parse: {e}"))
    };
    let clan_fut =
        async { fetch_clan_info_for_accounts(&client, &app_id, host, &[entry.account_id]).await };
    let dog_tag_fut = async {
        let resp = super::upstream_health::best_effort_get(
            &client,
            vortex_host,
            "vortex dog tag",
            format!("https://{vortex_host}/api/accounts/{}", entry.account_id),
        )
        .await?;
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

    // Ghost guard: the search index keeps stale entries under names their
    // account renamed away (and freed names other accounts later claimed),
    // and account_list_one takes the first exact hit. account/info answers
    // the LIVE nickname — when it disagrees with the query, the resolved
    // account is a dormant ghost, and "not found" beats pinning a
    // stranger's (possibly hidden) profile on the card. The UID fast path
    // already answered a live nickname; nothing to verify there.
    if !resolved_by_uid {
        let live = info
            .data
            .as_ref()
            .and_then(|d| d.get(entry.account_id.to_string()))
            .and_then(|v| v.get("nickname"))
            .and_then(|n| n.as_str());
        if let Some(live) = live {
            if !nickname_matches(&name, live) {
                return Err(LookupError::not_found_account(name, realm));
            }
        }
    }

    // Expected algorithm: replace the winrate proxy with the wows-numbers PR
    // aggregated over the player's per-ship randoms (one extra ships/stats
    // request — see `account_expected_pr_for`). Computed before the assembly
    // below consumes `entry`/`realm`. Unavailable inputs (expected table or
    // ship rows) yield None — the card renders "--", the lookup itself must
    // not fail over a rating.
    let expected_pr = if algo == PrAlgo::Expected {
        account_expected_pr_for(&realm, entry.account_id).await
    } else {
        None
    };
    // Hidden profiles return null statistics; player_stats_from_info surfaces
    // that as hidden=true.
    let mut stats = player_stats_from_info(entry, realm, info.data.as_ref(), &clan_map);
    stats.dog_tag = dog_tag;
    if algo == PrAlgo::Expected {
        stats.pr = expected_pr;
        // Same school-consistency guard as the batch (apply_batch_pr_algo):
        // the expected algorithm has no ranked per-ship path, so the
        // winrate-proxy ranked/global PRs must not ride along on the same
        // card.
        stats.ranked_pr = None;
        stats.global_pr = None;
    }
    tracing::info!(
        realm = %stats.realm,
        account_id = stats.account_id,
        hidden = stats.hidden,
        elapsed_ms = lookup_started.elapsed().as_millis() as u64,
        "interactive stats lookup finished"
    );
    Ok(stats)
}

/// Look up many players in one shot (live-roster fast path): N× account/list
/// resolved with bounded parallelism, then ONE account/info and ONE
/// clans/accountinfo for all resolved ids combined. Returns one entry per input name,
/// in order; `None` = account not found, no exact-name match, or the lookup
/// failed — roster UIs render that as "no data" rather than failing the
/// whole panel.
///
/// Answers are memoized per process, keyed (realm, name): the main window
/// and the in-game overlay each fire the same roster names every battle,
/// and without the shared cache each re-fetches the other's answers —
/// twice the WG request storm per battle, which is how the shared per-IP
/// rate limit ends up starving both windows mid-session. Values are the
/// PRE-algo base stats (`apply_batch_pr_algo` runs per response, so both
/// PR algorithms share one cache). Cached session-long, mirroring the
/// client-side caches it serves: neither window refreshes roster stats
/// mid-session today either.
///
/// Name resolution additionally verifies the search index's exact hits
/// against account/info's LIVE nickname (see [`pick_verified_entry`]):
/// the index keeps stale entries under names their account renamed away,
/// and an innocent-looking exact match can be a dormant ghost — the rosters
/// then show a stranger's (possibly hidden) profile, the false "hidden
/// stats" reports.
///
/// `pr_algo` selects the PR algorithm. Under "expected" every entry answers
/// PR=None (see [`apply_batch_pr_algo`]): the roster line then renders its
/// "—" fallback instead of a winrate proxy the player card wouldn't agree
/// with.
///
/// `cross_realm` enables the cross-server Clan-Battles pass — CW rosters
/// can field players from the other WG clusters, whose names the home
/// cluster cannot explain (see [`lookup_roster`]). Omitted/None keeps the
/// historical single-realm behavior; adopted entries carry their true
/// realm in [`PlayerStats::realm`].
#[tauri::command]
pub async fn lookup_players_stats_batch(
    names: Vec<String>,
    realm: String,
    pr_algo: Option<String>,
    cross_realm: Option<bool>,
) -> CommandResult<Vec<Option<PlayerStats>>> {
    let algo = PrAlgo::from_param(pr_algo.as_deref());
    if names.is_empty() {
        return Ok(Vec::new());
    }
    if realm == "cn" {
        return Ok(super::wg_api_cn::lookup_players_stats_batch(names, algo).await?);
    }
    Ok(lookup_roster(names, Vec::new(), realm, cross_realm.unwrap_or(false), algo).await?)
}

/// The WG clusters that can interleave rosters in cross-server Clan
/// Battles (the live arena file carries no realm per player — only
/// nicknames — so a foreign opponent is indistinguishable from a
/// not-found name until the other clusters are asked). Lesta (ru) and CN
/// (cn) run isolated account pools that never meet the WG clusters, so a
/// home realm outside the pool disables the cross pass outright.
const CROSS_REALM_POOL: [&str; 3] = ["eu", "na", "asia"];

/// How recent a candidate's `last_battle_time` must be (unix seconds
/// before "now") to count as "this account is playing right now" evidence
/// in [`pick_cross_realm_hit`]. Clan Battles queue back-to-back within a
/// session; a foreign same-name account that last played days ago is a
/// namesake, not the roster player.
const CROSS_RECENT_WINDOW_SECS: i64 = 6 * 3600;

/// The cross-realm probe set for a home realm: the other WG clusters, or
/// empty when the home realm's matchmaking never meets foreign players.
/// Pure — unit-tested.
pub(crate) fn cross_probe_realms(home: &str) -> Vec<String> {
    if CROSS_REALM_POOL.contains(&home) {
        CROSS_REALM_POOL
            .iter()
            .filter(|probe| **probe != home)
            .map(|probe| probe.to_string())
            .collect()
    } else {
        Vec::new()
    }
}

/// The roster resolution core shared by the batch command above and the
/// in-game bridge (`ingame_bridge`). `ids` optionally carries each name's
/// WG account id (the plugin's roster rows have them; index-aligned, None
/// where absent). An id that verifies against the LIVE nickname is exact —
/// and for a slot WITH an id that exactness rules everything: a cached or
/// name-searched answer belonging to a DIFFERENT account is a namesake and
/// must never preempt the id evidence (cache hits are checked against the
/// id, and the name path runs for such slots only as a last-resort
/// fallback for ids the API cannot verify anywhere). `cross_realm` enables
/// the cross-server Clan-Battles pass: slots the home realm cannot explain
/// are probed on the other WG clusters. Slots the home realm DID resolve
/// (id-less slots only) never join the pass, so a same-realm battle
/// answers exactly as before.
pub(crate) async fn lookup_roster(
    names: Vec<String>,
    ids: Vec<Option<i64>>,
    realm: String,
    cross_realm: bool,
    algo: PrAlgo,
) -> Result<Vec<Option<PlayerStats>>> {
    // CN runs its own API surface (`wg_api_cn`, vortex + clanbase) with no
    // id-based path — ids and the cross-server pass are WG-cluster
    // concepts. The command above routes here after its own CN check, so
    // this guard exists for the in-game bridge, which calls in directly.
    if realm == "cn" {
        return super::wg_api_cn::lookup_players_stats_batch(names, algo).await;
    }
    // Per-request timeout so one hung connection can't stall the roster all
    // battle long.
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow!("http client: {e}"))?;

    // The slot's exact account id, when the caller has one (> 0).
    let slot_id =
        |slot: usize| -> Option<i64> { ids.get(slot).copied().flatten().filter(|id| *id > 0) };

    // 0. Session cache: answer the hits on the spot, resolve only the
    //    misses. Slots track the original positions so the response order
    //    keeps matching the input order. Values are PRE-algo; the algorithm
    //    pass at the very end shapes the response copies.
    //    An id-carrying slot trusts a cached hit only when it IS that
    //    account — anything else under the same nickname is a namesake.
    let mut answers: Vec<Option<PlayerStats>> = vec![None; names.len()];
    let mut misses: Vec<(usize, String)> = Vec::new();
    for (slot, name) in names.iter().enumerate() {
        let id_trusted = match slot_id(slot) {
            Some(id) => {
                answers[slot] = roster_cache_get(&realm, name)
                    .flatten()
                    .filter(|st| st.account_id == id);
                answers[slot].is_some()
            },
            None => match roster_cache_get(&realm, name) {
                Some(cached) => {
                    answers[slot] = cached;
                    true
                },
                None => false,
            },
        };
        if !id_trusted {
            misses.push((slot, name.clone()));
        }
    }

    // 1+2. Id-carrying slots resolve by id ONLY (home cluster first): a
    //      home name-search answer for them could only be a different,
    //      same-named account. Id-less slots take the classic name path.
    //      Both paths share the merged info/clan sweep below.
    let mut id_misses: Vec<(usize, String, i64)> = Vec::new();
    let mut name_misses: Vec<(usize, String)> = Vec::new();
    for (slot, name) in &misses {
        match slot_id(*slot) {
            Some(id) => id_misses.push((*slot, name.clone(), id)),
            None => name_misses.push((*slot, name.clone())),
        }
    }
    if !id_misses.is_empty() {
        // A home-realm transport/API failure rejects the batch like the
        // name path below — the bridge's FAILURE_BACKOFF then retries
        // instead of the request settling as permanent "no data".
        let hits = match resolve_ids_on_realm(&client, &realm, &id_misses).await {
            Ok(hits) => hits,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    realm = %realm,
                    names = id_misses.len(),
                    "roster id resolution failed"
                );
                return Err(e);
            },
        };
        id_misses.retain(|(slot, name, _)| match hits.get(slot) {
            Some(stats) => {
                roster_cache_insert(&realm, name, Some(stats.clone()));
                answers[*slot] = Some(stats.clone());
                false
            },
            None => true,
        });
    }
    if !name_misses.is_empty() {
        let miss_names: Vec<String> = name_misses.iter().map(|(_, n)| n.clone()).collect();
        let resolved = match resolve_names_on_realm(&client, &realm, &miss_names).await {
            Ok(resolved) => resolved,
            Err(e) => {
                // The frontend retries with backoff and then re-probes slowly, but
                // a field report needs the failure HERE: until this line existed a
                // dead-battle report had zero server-side evidence.
                tracing::warn!(
                    error = %e,
                    realm = %realm,
                    names = miss_names.len(),
                    "roster stats batch failed"
                );
                return Err(e);
            },
        };
        for ((slot, name), stats) in name_misses.iter().zip(resolved) {
            roster_cache_insert(&realm, name, stats.clone());
            if stats.is_some() {
                answers[*slot] = stats;
            }
        }
    }

    // 3. Cross-server Clan-Battles pass. Only slots the home cluster FAILED
    //    to explain participate, so the common same-realm battle costs
    //    nothing extra and a home-realm answer is never second-guessed.
    if cross_realm {
        let probes = cross_probe_realms(&realm);
        let unresolved: Vec<usize> = (0..names.len())
            .filter(|&slot| answers[slot].is_none())
            .collect();
        if !probes.is_empty() && !unresolved.is_empty() {
            // 3a. Foreign id probe for id-carrying slots (exact): a
            //     verified id + LIVE-nickname pair on any cluster IS the
            //     player — WG account ids are only unique per realm, but
            //     the nickname check rejects every wrong cluster's
            //     same-numbered stranger. First verifying cluster wins; two
            //     clusters agreeing on BOTH the id and the nickname would
            //     be an unresolvable same-numbered namesake pair, too rare
            //     to trade the near-certain hit for a None.
            let mut id_entries: Vec<(usize, String, i64)> = unresolved
                .iter()
                .filter_map(|&slot| {
                    let id = slot_id(slot)?;
                    Some((slot, names[slot].clone(), id))
                })
                .collect();
            if !id_entries.is_empty() {
                for probe in &probes {
                    // Session-cache consult first (keyed (probe, name)): a
                    // CW rematch against the same clan answers the foreign
                    // ids with zero WG calls, mirroring the name probe.
                    let cached_hits: HashMap<usize, PlayerStats> = id_entries
                        .iter()
                        .filter_map(|(slot, name, id)| {
                            roster_cache_get(probe, name)
                                .flatten()
                                .filter(|st| st.account_id == *id)
                                .map(|st| (*slot, st))
                        })
                        .collect();
                    id_entries.retain(|(slot, _, _)| match cached_hits.get(slot) {
                        Some(stats) => {
                            answers[*slot] = Some(stats.clone());
                            false
                        },
                        None => true,
                    });
                    if id_entries.is_empty() {
                        break;
                    }
                    // Probe failures degrade (the cache consult above plus
                    // the name probe below still get their chance).
                    let hits = resolve_ids_on_realm(&client, probe, &id_entries)
                        .await
                        .unwrap_or_default();
                    id_entries.retain(|(slot, name, _)| match hits.get(slot) {
                        Some(stats) => {
                            roster_cache_insert(probe, name, Some(stats.clone()));
                            answers[*slot] = Some(stats.clone());
                            false
                        },
                        None => true,
                    });
                    if id_entries.is_empty() {
                        break;
                    }
                }
            }

            // 3b. Foreign name probe for whatever is still unexplained —
            //     id-less slots, plus id-carrying ones no cluster could
            //     verify (their ids may be synthetic, so they fall back to
            //     name semantics; a candidate that DOES bear their exact id
            //     still wins outright in the decision below). Each probe
            //     realm shares the session cache keyed by its own realm, so
            //     a re-met cross-server enemy answers from cache; a probe
            //     failure degrades to "not on this realm" instead of
            //     failing the batch.
            let still: Vec<usize> = unresolved
                .into_iter()
                .filter(|&slot| answers[slot].is_none())
                .collect();
            if !still.is_empty() {
                let mut per_slot: Vec<Vec<RealmHit>> =
                    (0..names.len()).map(|_| Vec::new()).collect();
                for probe in &probes {
                    let mut live: Vec<(usize, String)> = Vec::new();
                    for &slot in &still {
                        if answers[slot].is_some() {
                            continue;
                        }
                        match roster_cache_get(probe, &names[slot]) {
                            Some(Some(cached)) => per_slot[slot].push(RealmHit { stats: cached }),
                            Some(None) => {},
                            None => live.push((slot, names[slot].clone())),
                        }
                    }
                    if live.is_empty() {
                        continue;
                    }
                    let live_names: Vec<String> = live.iter().map(|(_, n)| n.clone()).collect();
                    match resolve_names_on_realm(&client, probe, &live_names).await {
                        Ok(resolved) => {
                            for ((slot, name), stats) in live.iter().zip(resolved) {
                                roster_cache_insert(probe, name, stats.clone());
                                if let Some(stats) = stats {
                                    per_slot[*slot].push(RealmHit { stats });
                                }
                            }
                        },
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                realm = %probe,
                                names = live.len(),
                                "cross-realm roster probe failed"
                            );
                        },
                    }
                }
                let now: i64 = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                for slot in still {
                    if answers[slot].is_some() {
                        continue;
                    }
                    let hits = std::mem::take(&mut per_slot[slot]);
                    // An exact-id candidate beats every heuristic.
                    let decided = slot_id(slot)
                        .and_then(|id| {
                            hits.iter()
                                .find(|h| h.stats.account_id == id)
                                .map(|h| RealmHit {
                                    stats: h.stats.clone(),
                                })
                        })
                        .or_else(|| pick_cross_realm_hit(now, hits));
                    if let Some(hit) = decided {
                        // Already cached under its own realm by the probe
                        // pass above — only the answer slot moves.
                        answers[slot] = Some(hit.stats);
                    }
                }
            }
        }
    }

    // 4. Last-resort HOME name fallback for id-carrying slots no cluster
    //    could verify by id — a transient account/info failure above, or a
    //    plugin id the API does not know. A candidate bearing the exact id
    //    is adopted outright; a plain verified hit only when this battle
    //    cannot be cross-server (in a roster that CAN field foreign
    //    players, an unexplained home namesake must not stand in for the
    //    foreign player — no data beats wrong data; a home realm with an
    //    empty probe set, like Lesta, can never be cross-server).
    //    Errors degrade: every other path already had its chance.
    let id_fallback: Vec<(usize, String)> = (0..names.len())
        .filter(|&slot| answers[slot].is_none() && slot_id(slot).is_some())
        .map(|slot| (slot, names[slot].clone()))
        .collect();
    let can_be_cross = cross_realm && !cross_probe_realms(&realm).is_empty();
    if !id_fallback.is_empty() {
        let fb_names: Vec<String> = id_fallback.iter().map(|(_, n)| n.clone()).collect();
        if let Ok(resolved) = resolve_names_on_realm(&client, &realm, &fb_names).await {
            for ((slot, name), stats) in id_fallback.iter().zip(resolved) {
                roster_cache_insert(&realm, name, stats.clone());
                let Some(stats) = stats else {
                    continue;
                };
                let exact_id = slot_id(*slot).is_some_and(|id| stats.account_id == id);
                if exact_id || !can_be_cross {
                    answers[*slot] = Some(stats);
                }
            }
        }
    }

    for stats in answers.iter_mut().flatten() {
        apply_batch_pr_algo(stats, algo);
    }
    Ok(answers)
}

/// One name's verified hit on one probe realm — the cross-server decision's
/// input. `stats.realm` names the cluster that produced the entry.
pub(super) struct RealmHit {
    pub(super) stats: PlayerStats,
}

/// Decide which probe realm's verified hit is the player actually on the
/// roster when more than one cluster bears the exact nickname (every probe
/// already live-verified the nickname, so each candidate IS a real holder
/// of that name somewhere — several can exist because nicknames are unique
/// only per realm).
///
/// 1. A lone hit needs no arbitration.
/// 2. Clan Battles are clan teams: when any hit is clanned, clanless ones
///    are namesakes (a hit that never joined a clan cannot be fielded in
///    CW; a real player who LEFT the clan after the season is accepted as
///    a miss here rather than risk the reverse).
/// 3. The roster player is in a battle right now, so their previous battle
///    ended within the session — a strictly-newer `last_battle_time`
///    inside [`CROSS_RECENT_WINDOW_SECS`] of `now` wins.
/// 4. Anything still tied is genuinely ambiguous: None — no data beats a
///    coin flip between strangers.
///
/// Pure — unit-tested.
pub(super) fn pick_cross_realm_hit(now: i64, mut hits: Vec<RealmHit>) -> Option<RealmHit> {
    if hits.len() <= 1 {
        return hits.into_iter().next();
    }
    if hits.iter().any(|h| h.stats.clan_id.is_some()) {
        hits.retain(|h| h.stats.clan_id.is_some());
    }
    if hits.len() == 1 {
        return hits.into_iter().next();
    }
    let window_start = now - CROSS_RECENT_WINDOW_SECS;
    let newest_in_window = hits
        .iter()
        .filter_map(|h| h.stats.last_battle_time)
        .filter(|t| *t >= window_start)
        .max();
    if let Some(newest) = newest_in_window {
        let fresh: Vec<RealmHit> = hits
            .into_iter()
            .filter(|h| h.stats.last_battle_time == Some(newest))
            .collect();
        if fresh.len() == 1 {
            return fresh.into_iter().next();
        }
    }
    None
}

/// Name → stats resolution on ONE realm: the account/list fan-out, the
/// merged account/info + clan sweep, and the live-nickname verify. Shared
/// by the home pass and every cross-realm probe — callers own caching and
/// failure policy (the home pass fails the batch on error; probes
/// degrade). Answer order matches `names`.
async fn resolve_names_on_realm(
    client: &reqwest::Client,
    realm: &str,
    names: &[String],
) -> Result<Vec<Option<PlayerStats>>> {
    let app_id = super::wg_realm::application_id(realm);
    let host = super::wg_realm::api_host(realm)?;

    // 1. name → account, bounded-parallel. Every exact-prefix hit is kept
    //    (capped — see [`EXACT_HIT_CANDIDATES`]): the first hit is not
    //    always the live account, the live-nickname check below needs the
    //    alternatives to pick from. A rate-limited / failed list response
    //    fails the whole batch — it must not degrade into "not found" (the
    //    frontend would cache that).
    let results: Vec<Result<Vec<AccountListEntry>>> = {
        let client_ref = client;
        stream::iter(names.iter().cloned())
            .map(|name| {
                let url = format!(
                    "https://{host}/wows/account/list/?application_id={app_id}&search={}&limit=10",
                    encode_query(&name)
                );
                async move {
                    let resp =
                        super::upstream_health::recorded_get(client_ref, host, "account/list", url)
                            .await?;
                    let list = resp
                        .json::<WgResponse<Vec<AccountListEntry>>>()
                        .await
                        .map_err(|e| anyhow!("account/list parse: {e}"))?;
                    if list.status != "ok" {
                        anyhow::bail!("account/list: {}", list.error.message.unwrap_or_default());
                    }
                    // Same exact-match guard as account_list_one: only the
                    // queried account's name qualifies — a lookalike's
                    // stats must not leak into the roster batch.
                    Ok(list
                        .data
                        .map(|d| {
                            d.into_iter()
                                .filter(|found| nickname_matches(&name, &found.nickname))
                                .take(EXACT_HIT_CANDIDATES)
                                .collect()
                        })
                        .unwrap_or_default())
                }
            })
            .buffered(BATCH_CONCURRENCY)
            .collect()
            .await
    };
    // anyhow errors are not Clone, so the first failure is MOVED out of the
    // collected vec (Display-identical to the historical cloned String).
    if results.iter().any(Result::is_err) {
        return Err(results.into_iter().find_map(Result::err).unwrap());
    }
    let candidates: Vec<Vec<AccountListEntry>> =
        results.into_iter().map(|r| r.unwrap_or_default()).collect();

    // 2+3. ONE account/info + ONE clan-tag lookup for the whole set (the
    //       endpoints accept comma-joined id lists); independent, so run
    //       them concurrently. The info sweep carries EVERY candidate id —
    //       ghosts included — so the live-nickname pick has its data; the
    //       id list stays capped well under the endpoint's 100-id cap
    //       (24 names × 3 candidates), chunked defensively regardless.
    let mut ids: Vec<i64> = Vec::new();
    for cands in &candidates {
        for entry in cands {
            if !ids.contains(&entry.account_id) {
                ids.push(entry.account_id);
            }
        }
    }
    let (info, clan_map) = if ids.is_empty() {
        (Ok(None), HashMap::new())
    } else {
        let info_fut = async { fetch_account_info_chunked(client, &app_id, host, &ids).await };
        let clan_fut = async { fetch_clan_info_for_accounts(client, &app_id, host, &ids).await };
        let (info, clan_map) = tokio::join!(info_fut, clan_fut);
        (info, clan_map)
    };
    let info_data: Option<serde_json::Value> = info?;

    // 4. Verify each name's candidates against the LIVE nicknames and
    //    build its stats.
    Ok(names
        .iter()
        .zip(candidates)
        .map(|(name, cands)| {
            pick_verified_entry(&cands, name, info_data.as_ref()).map(|entry| {
                player_stats_from_info(entry, realm.to_string(), info_data.as_ref(), &clan_map)
            })
        })
        .collect())
}

/// Id → stats resolution on ONE realm (the in-game bridge path — the
/// plugin's roster rows carry the exact WG account ids). ONE merged
/// account/info + ONE clans sweep for the whole set; an id answers only
/// when its LIVE nickname still equals the roster name, so a
/// same-numbered account on the wrong cluster can never leak through.
/// Errors propagate: the HOME pass rejects the batch on them (the bridge's
/// backoff then retries), while the cross-realm probe call sites degrade
/// on the same signal — each caller owns its failure policy.
async fn resolve_ids_on_realm(
    client: &reqwest::Client,
    realm: &str,
    entries: &[(usize, String, i64)],
) -> Result<HashMap<usize, PlayerStats>> {
    let mut out: HashMap<usize, PlayerStats> = HashMap::new();
    if entries.is_empty() {
        return Ok(out);
    }
    let app_id = super::wg_realm::application_id(realm);
    let host = super::wg_realm::api_host(realm)?;
    let ids: Vec<i64> = entries.iter().map(|(_, _, id)| *id).collect();
    let info_fut = async { fetch_account_info_chunked(client, &app_id, host, &ids).await };
    let clan_fut = async { fetch_clan_info_for_accounts(client, &app_id, host, &ids).await };
    let (info, clan_map) = tokio::join!(info_fut, clan_fut);
    let info_data = info?;
    for (slot, name, id) in entries {
        let live = info_data
            .as_ref()
            .and_then(|d| d.get(id.to_string()))
            .and_then(|v| v.get("nickname"))
            .and_then(|n| n.as_str());
        let Some(live) = live else {
            continue;
        };
        if !nickname_matches(name, live) {
            continue;
        }
        out.insert(
            *slot,
            player_stats_from_info(
                AccountListEntry {
                    account_id: *id,
                    nickname: live.to_owned(),
                },
                realm.to_string(),
                info_data.as_ref(),
                &clan_map,
            ),
        );
    }
    Ok(out)
}

/// The merged, extra-gated account/info sweep over a candidate id list
/// (chunks of [`WG_INFO_IDS_PER_REQUEST`]), combined into one id-keyed
/// map. Shared by the name-resolution and id-resolution paths. A WG
/// app-level failure (e.g. rate limit) rejects — the home batch lets the
/// frontend's backoff own the retry instead of silently caching
/// hidden=true for everyone.
async fn fetch_account_info_chunked(
    client: &reqwest::Client,
    app_id: &str,
    host: &str,
    ids: &[i64],
) -> Result<Option<serde_json::Value>> {
    // Same extra-gated division splits as the single lookup; the
    // per-chunk results merge into one id-keyed map.
    let mut roster = serde_json::Map::new();
    for chunk in ids.chunks(WG_INFO_IDS_PER_REQUEST) {
        let id_list = chunk
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let resp = super::upstream_health::recorded_get(
            client,
            host,
            "account/info",
            format!(
                "https://{host}/wows/account/info/?application_id={app_id}&account_id={id_list}\
                 &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3,\
                 statistics.rank_solo,statistics.rank_div2,statistics.rank_div3"
            ),
        )
        .await?;
        let parsed = resp
            .json::<WgResponse<serde_json::Value>>()
            .await
            .map_err(|e| anyhow!("account/info parse: {e}"))?;
        if parsed.status != "ok" {
            anyhow::bail!("account/info: {}", parsed.error.message.unwrap_or_default());
        }
        if let Some(data) = parsed.data.and_then(|d| d.as_object().cloned()) {
            roster.extend(data);
        }
    }
    Ok(Some(serde_json::Value::Object(roster)))
}

/// Batch-roster PR policy. The expected algorithm needs each player's
/// per-ship randoms rows (`account_expected_pr_for` — ONE ships/stats fetch
/// per account, the heaviest per-account endpoint WG serves), and a battle
/// roster hands this command up to 24 human names at once: wiring it in
/// would multiply the request budget by the roster size every single battle
/// (several MB and several extra seconds on this live-roster fast path,
/// whose whole contract is speed). That is the same per-row multiplication
/// `lookup_clan_info` documents and rejects, so the batch answers PR=None
/// under `Expected` and the roster renders its "—" fallback — never a
/// winrate proxy the player card wouldn't agree with. Full-card lookups
/// (`lookup_player_stats`) still aggregate the expected PR per player.
/// Shared with the CN batch arm (`wg_api_cn::lookup_players_stats_batch`).
pub(crate) fn apply_batch_pr_algo(stats: &mut PlayerStats, algo: PrAlgo) {
    if algo == PrAlgo::Expected {
        stats.pr = None;
        // The expected algorithm has no ranked per-ship path either — the
        // same never-a-different-school argument as `pr` above. The global
        // blend builds on those winrate-proxy ratings, so it sits out too.
        stats.ranked_pr = None;
        stats.global_pr = None;
    }
}

/// Build a `PlayerStats` from the batch account/info response map. The dog
/// tag is always None here — roster panels render WR/PR only, and the per-id
/// Vortex calls would dominate the request budget.
pub(super) fn player_stats_from_info(
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
        last_battle_time: player_node
            .and_then(|v| v.get("last_battle_time"))
            .and_then(|v| v.as_i64()),
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
        solo_battles: p.solo_battles,
        div2_battles: p.div2_battles,
        div3_battles: p.div3_battles,
        ranked_battles: p.ranked.battles,
        ranked_winrate: p.ranked.winrate,
        ranked_avg_damage: p.ranked.avg_damage,
        ranked_pr: p.ranked.pr,
        global_battles: p.global.battles,
        global_winrate: p.global.winrate,
        global_avg_damage: p.global.avg_damage,
        global_pr: p.global.pr,
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
