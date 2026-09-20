//! Composition stamps ("空中小人 / 水下小人") for the Tab overlay roster.
//!
//! The overlay batch lookup (`wg_api::lookup_players_stats_batch`) is
//! deliberately a fast path — it never pulls per-ship rows (see the comment
//! on [`super::wg_api::apply_batch_pr_algo`]). Rendering the composition
//! seals needs exactly those rows, so this command lives on its own and is
//! called by the overlay only when it decides to show seals:
//!
//!   name → account id (same account/list + exact-match pattern as the
//!          stats batch, bounded by `BATCH_CONCURRENCY`),
//!   → ONE `/wows/ships/stats/` per account (the transport-agnostic
//!          `ship_stats::fetch_expected_pr_rows`, which also serves the CN
//!          vortex),
//!   → ship_id → class resolution (offline encyclopedia caches first, WG
//!          `encyclopedia/ships/?ship_id=` batches on miss),
//!   → the threshold verdict (pure, unit-tested, mirrors the frontend
//!          `compositionStamps` in `packages/webui/src/utils/winrate.ts`).
//!
//! Verdicts are cached per process lifetime (`COMPOSITION_CACHE`): a career
//! composition does not change within a battle, and barely ever across
//! battles, while the overlay page re-queries the same roster names on every
//! new fight.
//!
//! Ship classes are realm-independent (ship ids and encyclopedia payloads
//! are cluster-wide identical — see `wg_realm::encyclopedia_host`), so the
//! class cache is keyed by ship id alone; the verdict cache is keyed by
//! (realm, account id) because ids are only unique per cluster.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use wowsp_tauri_shared::PlayerComposition;

use super::wg_api::ExpectedPrRow;
use super::wg_realm;

/// Concurrency cap for the per-name and per-account request waves — mirrors
/// `wg_api::BATCH_CONCURRENCY` (WG rate-limits ~20 req/s per IP; the CN
/// vortex service is unauthenticated and gets the same politeness).
const BATCH_CONCURRENCY: usize = 4;

/// Career battles a player must EXCEED before any seal can show — and the
/// class share must EXCEED 20%. Both bounds strictly greater; the values and
/// the strictness mirror the frontend `compositionStamps()` defaults
/// (`minBattles = 200`, `minShare = 0.2`) exactly.
const MIN_CAREER_BATTLES: i64 = 200;
const MIN_CLASS_SHARE_PERCENT: i64 = 20;

/// WG `encyclopedia/ships/` accepts at most 100 `ship_id` values per request
/// (same cap the docs put on the parameter).
const ENCY_SHIP_IDS_PER_REQUEST: usize = 100;

/// Process-lifetime composition verdicts, keyed by (realm, account id).
/// Successful verdicts AND definitive "no data" Nones are cached; transient
/// transport failures are NOT (they answer None for this call but retry on
/// the next battle, so one WG hiccup cannot blank a seal for the session).
type CompositionCache = HashMap<(String, i64), Option<PlayerComposition>>;
static COMPOSITION_CACHE: std::sync::LazyLock<std::sync::Mutex<CompositionCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Process-lifetime ship_id → class map ("AirCarrier" / "Submarine" / …).
/// `Some(class)` for resolved ids; `None` only for ids a SUCCESSFUL
/// encyclopedia response did not contain (closed-test / removed ships), so
/// a failed fetch is retried later instead of poisoning the session.
static SHIP_TYPE_CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<i64, Option<String>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Composition seals for a batch of roster names. Returns one entry per
/// input name, in order; `None` = not found / hidden or insufficient data /
/// that player's lookup failed — the overlay renders "no stamp" and a single
/// failed row never fails the whole batch.
#[tauri::command]
pub async fn lookup_players_composition(
    names: Vec<String>,
    realm: String,
) -> Result<Vec<Option<PlayerComposition>>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }

    // 1. name → account id. Per-name failures (transport error, no exact
    //    match) degrade to None for that slot — unlike the stats batch,
    //    which fails wholesale so the frontend backoff can retry a
    //    rate-limited sweep, a seal is decoration and must never take the
    //    roster panel down with it.
    let total = names.len();
    let ids = resolve_account_ids(&realm, names).await?;

    // 2. Cached verdicts skip the heavy per-account fetch. The cheap
    //    name→id resolution still runs every call — the cache exists to skip
    //    the multi-hundred-KB ships/stats response, not one account/list.
    let mut results: Vec<Option<PlayerComposition>> = vec![None; total];
    let mut pending: Vec<(usize, i64)> = Vec::new();
    {
        let cache = COMPOSITION_CACHE
            .lock()
            .map_err(|e| format!("composition cache lock: {e}"))?;
        for (slot, id) in ids.iter().enumerate() {
            let Some(id) = id else { continue };
            match cache.get(&(realm.clone(), *id)) {
                // PlayerComposition is Copy — a plain deref moves the verdict.
                Some(cached) => results[slot] = *cached,
                None => pending.push((slot, *id)),
            }
        }
    }
    if pending.is_empty() {
        return Ok(results);
    }

    // 3. ONE ships/stats fetch per uncached account. `Ok(vec![])` = hidden
    //    profile (or an account with no randoms) → definitive None; `Err` =
    //    transport failure → None for this call, retried next battle.
    let fetched: Vec<(usize, i64, Option<Vec<ExpectedPrRow>>)> = {
        let realm_ref = &realm;
        stream::iter(pending)
            .map(|(slot, id)| async move {
                let rows = super::ship_stats::fetch_expected_pr_rows(id, realm_ref)
                    .await
                    .ok();
                (slot, id, rows)
            })
            .buffered(BATCH_CONCURRENCY)
            .collect()
            .await
    };

    // 4. Resolve classes once for the union of ship ids across the whole
    //    batch, then compute the verdicts.
    let mut ship_ids: HashSet<i64> = HashSet::new();
    for (_, _, rows) in &fetched {
        let Some(rows) = rows else { continue };
        for row in rows {
            ship_ids.insert(row.ship_id);
        }
    }
    let types = resolve_ship_types(&realm, &ship_ids.iter().copied().collect::<Vec<_>>()).await;

    let mut fresh: Vec<((String, i64), Option<PlayerComposition>)> = Vec::new();
    for (slot, id, rows) in fetched {
        match rows {
            // Hidden profile / no randoms — definitive, cache the None.
            Some(rows) if rows.is_empty() => {
                fresh.push(((realm.clone(), id), None));
            },
            Some(rows) => {
                let verdict = composition_from_rows(&rows, &types);
                fresh.push(((realm.clone(), id), Some(verdict)));
                results[slot] = Some(verdict);
            },
            // Transport failure — answer None but leave the slot uncached so
            // the next battle retries instead of sealing the session.
            None => {},
        }
    }
    if !fresh.is_empty() {
        let mut cache = COMPOSITION_CACHE
            .lock()
            .map_err(|e| format!("composition cache lock: {e}"))?;
        cache.extend(fresh);
    }
    Ok(results)
}

/// Resolve every name to its account id (input order preserved). Consumes
/// `names` — owned items keep the per-item futures lifetime-free (the same
/// reason `wg_api::lookup_players_stats_batch` consumes its input, and a
/// tauri command wrapper rejects the borrowed-stream variant). Global
/// failures (bad realm, client build) error the whole call; per-name
/// failures answer `None`.
async fn resolve_account_ids(realm: &str, names: Vec<String>) -> Result<Vec<Option<i64>>, String> {
    // CN routes to the vortex search (browser-UA client, see `wg_api_cn`);
    // every other realm to the WG account/list endpoint.
    if realm == "cn" {
        let cn_client = super::wg_api_cn::vortex_client()?;
        let client_ref = &cn_client;
        Ok(stream::iter(names)
            .map(|name| async move {
                super::wg_api_cn::account_list_one(client_ref, &name)
                    .await
                    .ok()
                    .flatten()
                    .map(|e| e.account_id)
            })
            .buffered(BATCH_CONCURRENCY)
            .collect()
            .await)
    } else {
        let app_id = wg_realm::application_id(realm);
        let host = wg_realm::api_host(realm)?;
        let client = crate::commands::network::http_client_builder()?
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        // Shared references (Copy) — each future captures its own copy, so
        // the closure stays movable (an owned capture would move the first
        // future's state out of the closure).
        let client_ref = &client;
        let app_id_ref = &app_id;
        Ok(stream::iter(names)
            .map(|name| async move {
                // Same exact-match guard as the stats batch: a lookalike's
                // data must never leak into a roster row.
                super::wg_api::account_list_one(client_ref, app_id_ref, host, &name)
                    .await
                    .ok()
                    .flatten()
                    .map(|e| e.account_id)
            })
            .buffered(BATCH_CONCURRENCY)
            .collect()
            .await)
    }
}

/// Ship classes for a batch of ship ids: session cache → offline encyclopedia
/// caches → one batched WG `encyclopedia/ships/` sweep. Ids the online sweep
/// could not resolve come back `None` (unknown class — they still count
/// toward the career total, exactly like the frontend's `typeOf` fallback).
async fn resolve_ship_types(realm: &str, ship_ids: &[i64]) -> HashMap<i64, Option<String>> {
    let mut out: HashMap<i64, Option<String>> = HashMap::with_capacity(ship_ids.len());
    let mut missing: Vec<i64> = Vec::new();
    {
        let cache = SHIP_TYPE_CACHE
            .lock()
            .map_err(|e| format!("ship type cache lock: {e}"));
        match cache {
            Ok(cache) => {
                for &id in ship_ids {
                    match cache.get(&id) {
                        Some(ty) => {
                            out.insert(id, ty.clone());
                        },
                        None => missing.push(id),
                    }
                }
            },
            // A poisoned cache must not take the seals down — treat as empty.
            Err(_) => missing.extend_from_slice(ship_ids),
        }
    }
    if missing.is_empty() {
        return out;
    }

    // Offline first: the versioned encyclopedia caches `get_ship_encyclopedia`
    // persists carry every ship's class. Zero network, covers the common case
    // (any user who opened a player page has at least one cache file).
    let want: HashSet<i64> = missing.iter().copied().collect();
    let offline = offline_ship_types(&want);
    let mut unfetched: Vec<i64> = Vec::new();
    let mut resolved: Vec<(i64, Option<String>)> = Vec::new();
    for id in missing {
        match offline.get(&id) {
            Some(ty) => resolved.push((id, Some(ty.clone()))),
            None => unfetched.push(id),
        };
    }

    // Online sweep for the rest, chunked to the WG ship_id-list cap. A
    // successful response resolves found ids AND definitively marks the
    // absent ones (closed-test / removed ships); a failed request resolves
    // nothing and is retried on a later call.
    for chunk in unfetched.chunks(ENCY_SHIP_IDS_PER_REQUEST) {
        if let Ok(types) = fetch_ship_types_online(realm, chunk).await {
            for &id in chunk {
                resolved.push((id, types.get(&id).cloned()));
            }
        }
    }

    let mut cache = match SHIP_TYPE_CACHE.lock() {
        Ok(cache) => cache,
        // Same poisoned-cache tolerance as above.
        Err(_) => {
            return {
                for (id, ty) in &resolved {
                    out.insert(*id, ty.clone());
                }
                out
            };
        },
    };
    for (id, ty) in resolved {
        out.insert(id, ty.clone());
        cache.insert(id, ty);
    }
    out
}

/// One `encyclopedia/ships/` request for a ≤100-id chunk, asking only for the
/// class field. Returns {ship_id → class} for the ids the response carried.
/// The CN cluster has no encyclopedia endpoint — `encyclopedia_host` already
/// serves it from the ASIA API (ids are cluster-wide identical).
async fn fetch_ship_types_online(realm: &str, ids: &[i64]) -> Result<HashMap<i64, String>, String> {
    let app_id = wg_realm::application_id(realm);
    let host = wg_realm::encyclopedia_host(realm)?;
    let id_list = ids
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let client = crate::commands::network::http_client_builder()?
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!(
        "https://{host}/wows/encyclopedia/ships/?application_id={app_id}\
         &ship_id={id_list}&language=en&fields=ship_id,type"
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("encyclopedia/ships request: {e}"))?;
    let parsed: WgResponse = resp
        .json()
        .await
        .map_err(|e| format!("encyclopedia/ships parse: {e}"))?;
    if parsed.status != "ok" {
        return Err(format!(
            "encyclopedia/ships: {}",
            parsed.error.message.unwrap_or_default()
        ));
    }
    Ok(parsed
        .data
        .as_ref()
        .map(parse_ency_type_map)
        .unwrap_or_default())
}

/// Minimal response envelope — the full `WgResponse<T>` lives inside the
/// sibling modules; the seals sweep only needs status + data + error.
#[derive(serde::Deserialize)]
struct WgResponse {
    status: String,
    data: Option<serde_json::Value>,
    #[serde(default)]
    error: WgError,
}

#[derive(serde::Deserialize, Default)]
struct WgError {
    message: Option<String>,
}

/// Parse the `data` object of an encyclopedia/ships response (a
/// ship_id-keyed map of ship nodes) down to {ship_id → class}. Pure so the
/// real wire shape is unit-tested without HTTP.
fn parse_ency_type_map(data: &serde_json::Value) -> HashMap<i64, String> {
    let mut map = HashMap::new();
    if let Some(obj) = data.as_object() {
        for (key, node) in obj {
            if let (Ok(id), Some(ty)) = (
                key.parse::<i64>(),
                node.get("type").and_then(|t| t.as_str()),
            ) {
                map.insert(id, ty.to_owned());
            }
        }
    }
    map
}

/// Scan the on-disk encyclopedia caches for the wanted ids. Same best-effort
/// convention as `ship_stats::load_ship_name_map` (any version, any language
/// file; missing dir or malformed file degrades to fewer hits) — but through
/// `crate::paths` so portable installs resolve the same root the caches were
/// written to.
fn offline_ship_types(want: &HashSet<i64>) -> HashMap<i64, String> {
    let mut map = HashMap::new();
    let Ok(dir) = crate::paths::ensure_data_dir() else {
        return map;
    };
    let Ok(entries) = fs::read_dir(dir.join("encyclopedia")) else {
        return map;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // info.json is version metadata, not a ships list.
        if path.file_name().and_then(|n| n.to_str()) == Some("info.json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let ships = v.get("ships").and_then(|s| s.as_array());
        for ship in ships.into_iter().flatten() {
            let (Some(id), Some(ty)) = (
                ship.get("ship_id").and_then(|v| v.as_i64()),
                ship.get("type").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            if want.contains(&id) {
                map.insert(id, ty.to_owned());
            }
        }
    }
    map
}

/// Verdict from one account's per-ship randoms rows. `types` may lack ids or
/// carry `None` for them — unknown-class ships count toward the career total
/// but never toward a seal, byte-for-byte the frontend's
/// `compositionStamps(ships, typeOf)` behavior.
pub(crate) fn composition_from_rows(
    rows: &[ExpectedPrRow],
    types: &HashMap<i64, Option<String>>,
) -> PlayerComposition {
    // The rows are the same pvp-only per-ship set the account card's ship
    // distribution reads, so the career total matches the frontend verdict
    // for the same player (both sides sum the per-ship randoms battles).
    let mut career = 0i64;
    let mut air = 0i64;
    let mut sub = 0i64;
    for row in rows {
        career += row.battles;
        match types.get(&row.ship_id).and_then(|t| t.as_deref()) {
            Some("AirCarrier") => air += row.battles,
            Some("Submarine") => sub += row.battles,
            _ => {},
        }
    }
    composition_verdict(career, air, sub)
}

/// The threshold rule, shared shape with the frontend `compositionStamps()`
/// (packages/webui/src/utils/winrate.ts): `career <= 200` → no seal, else
/// `air / career > 0.2` / `sub / career > 0.2` — strictly greater on both
/// bounds. The percent cross-multiplication is the exact integer form of the
/// frontend's float division (battle counts are integers well below 2^53, so
/// `air * 100 > 20 * career` and `air / career > 0.2` can never disagree).
pub(crate) fn composition_verdict(
    career_battles: i64,
    air_battles: i64,
    sub_battles: i64,
) -> PlayerComposition {
    if career_battles <= MIN_CAREER_BATTLES {
        return PlayerComposition::default();
    }
    PlayerComposition {
        air: air_battles * 100 > MIN_CLASS_SHARE_PERCENT * career_battles,
        sub: sub_battles * 100 > MIN_CLASS_SHARE_PERCENT * career_battles,
    }
}

#[cfg(test)]
mod tests {
    use super::super::wg_api::{encode_query, nickname_matches};
    use super::*;

    fn row(ship_id: i64, battles: i64) -> ExpectedPrRow {
        ExpectedPrRow {
            ship_id,
            battles,
            damage: 0,
            frags: 0,
            wins: 0,
        }
    }

    // ── threshold verdict (mirrors webui compositionStamps) ───────────────

    #[test]
    fn verdict_requires_career_battles_strictly_above_200() {
        // At the bound — no seal (frontend: `career <= minBattles`).
        assert_eq!(
            composition_verdict(200, 200, 200),
            PlayerComposition {
                air: false,
                sub: false
            }
        );
        assert_eq!(
            composition_verdict(199, 199, 199),
            PlayerComposition::default()
        );
        assert_eq!(composition_verdict(0, 0, 0), PlayerComposition::default());
        // One battle past the bound a 100%-CV career qualifies.
        assert!(composition_verdict(201, 201, 0).air);
        assert!(composition_verdict(201, 0, 201).sub);
    }

    #[test]
    fn verdict_requires_share_strictly_above_20_percent() {
        // Exactly 20% of 1000 = 200 — NOT above the bound (frontend: `air /
        // career > minShare` with floats; 200/1000 = 0.2 is not > 0.2).
        assert_eq!(
            composition_verdict(1000, 200, 200),
            PlayerComposition {
                air: false,
                sub: false
            }
        );
        // 201/1000 crosses it.
        assert!(composition_verdict(1000, 201, 0).air);
        assert!(composition_verdict(1000, 0, 201).sub);
        // Just below: 40/201 ≈ 19.9% stays unsealed.
        assert!(!composition_verdict(201, 40, 40).air);
    }

    #[test]
    fn verdict_judges_air_and_sub_independently() {
        let v = composition_verdict(1000, 500, 10);
        assert!(v.air);
        assert!(!v.sub);
        let v = composition_verdict(1000, 10, 500);
        assert!(!v.air);
        assert!(v.sub);
    }

    // ── per-ship rows → verdict ───────────────────────────────────────────

    #[test]
    fn composition_from_rows_counts_career_and_classes() {
        // 300 BB battles + 150 CV + 60 SS over a 510-battle career: only the
        // CV share (150/510 ≈ 29.4%) crosses 20%.
        let types = HashMap::from([
            (1i64, Some("Battleship".to_string())),
            (2i64, Some("AirCarrier".to_string())),
            (3i64, Some("Submarine".to_string())),
        ]);
        let rows = [row(1, 300), row(2, 150), row(3, 60)];
        let v = composition_from_rows(&rows, &types);
        assert!(v.air);
        assert!(!v.sub);
    }

    #[test]
    fn composition_from_rows_treats_unknown_class_as_career_only() {
        // Missing entry AND explicit None both count the battles toward the
        // career total but never toward a seal — the frontend `typeOf`
        // fallback (`?? null`) behaves identically.
        let types = HashMap::from([(2i64, Some("AirCarrier".to_string()))]);
        let rows = [row(999, 300), row(2, 50)];
        // 300 unknown + 50 CV: career 350 (> 200), CV share 50/350 ≈ 14%.
        let v = composition_from_rows(&rows, &types);
        assert_eq!(
            v,
            PlayerComposition {
                air: false,
                sub: false
            }
        );
        // The unknown 300 alone can never produce a seal…
        let v = composition_from_rows(&[row(999, 300)], &types);
        assert_eq!(v, PlayerComposition::default());
    }

    // ── encyclopedia response parsing ─────────────────────────────────────

    #[test]
    fn parse_ency_type_map_reads_wg_ship_id_keyed_shape() {
        // Shape lifted from a real /wows/encyclopedia/ships/?ship_id=…
        // response: data keys are ship-id strings, each node carries `type`.
        let raw = serde_json::json!({
            "4282948544": { "ship_id": 4282948544_i64, "type": "Battleship" },
            "4279762472": { "type": "AirCarrier" },
            "4285445840": { "type": "Submarine" }
        });
        let map = parse_ency_type_map(&raw);
        assert_eq!(map.get(&4282948544).map(String::as_str), Some("Battleship"));
        assert_eq!(map.get(&4279762472).map(String::as_str), Some("AirCarrier"));
        assert_eq!(map.get(&4285445840).map(String::as_str), Some("Submarine"));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn parse_ency_type_map_skips_malformed_nodes() {
        let raw = serde_json::json!({
            "1": { "type": "Destroyer" },
            "not-a-number": { "type": "Cruiser" },
            "3": { "type": null },
            "4": {}
        });
        let map = parse_ency_type_map(&raw);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get(&1).map(String::as_str), Some("Destroyer"));
    }

    #[test]
    fn parse_ency_type_map_handles_empty_and_null_data() {
        assert!(parse_ency_type_map(&serde_json::json!({})).is_empty());
        assert!(parse_ency_type_map(&serde_json::Value::Null).is_empty());
    }

    // ── wire format ───────────────────────────────────────────────────────

    #[test]
    fn player_composition_round_trips_camel_case() {
        let v = PlayerComposition {
            air: true,
            sub: false,
        };
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json, serde_json::json!({ "air": true, "sub": false }));
        let back: PlayerComposition = serde_json::from_value(json).unwrap();
        assert_eq!(back, v);
    }

    // ── name resolution guards (shared rule, local smoke check) ───────────

    #[test]
    fn exact_match_rule_still_rejects_prefix_lookalikes() {
        // The seal path reuses `wg_api::nickname_matches` via the shared
        // resolvers; pin the contract here so a relaxation upstream is caught.
        assert!(nickname_matches("Player_2077", "player_2077"));
        assert!(!nickname_matches("Play", "Player_2077"));
    }

    #[test]
    fn encode_query_is_reused_for_search_terms() {
        // CN vortex search embeds the raw nickname in the path segment — the
        // shared encoder must keep encoding path-structural characters.
        assert_eq!(encode_query("公/会"), "%E5%85%AC%2F%E4%BC%9A");
    }
}
