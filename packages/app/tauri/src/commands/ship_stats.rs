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

use futures::stream::{self, StreamExt};
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
///
/// `session_cache` opts a caller into the process-wide read-through cache
/// (the in-flight single-flight, see [`raw_ship_stats_shared`], applies to
/// every caller) — the
/// roster surfaces (the main window's live panel AND the Tab overlay
/// window) pass it so both windows share ONE WG request per player per
/// process instead of each re-fetching the other's answers. Default
/// (None/false) keeps the historical always-fresh contract the per-ship
/// detail panel relies on.
#[tauri::command]
pub async fn lookup_player_ship_stats(
    account_id: i64,
    realm: String,
    pr_algo: Option<String>,
    session_cache: Option<bool>,
) -> Result<Vec<PlayerShipStats>, String> {
    let algo = PrAlgo::from_param(pr_algo.as_deref());
    let cache_file = format!("ship-stats/{realm}_{account_id}.json");
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
    let enrich = |raw: &RawShipStats| -> PlayerShipStats {
        let mut p: PlayerShipStats = raw.into();
        p.name = name_map.get(&raw.ship_id).cloned().unwrap_or_default();
        apply_pr_algo(&mut p, algo, &expected_table);
        p
    };

    // Session read-through (roster surfaces): the raw counters are shared
    // verbatim; PR is a pure function of them and is re-derived per the
    // caller's algorithm, so both PR calibers ride one cached fetch.
    if session_cache.unwrap_or(false) {
        if let Some(raw) = ship_stats_session_get(&realm, account_id) {
            return Ok(raw.iter().map(&enrich).collect());
        }
    }

    // The shared single-writer fetch: concurrent callers (either window)
    // join the ONE in-flight request instead of stacking duplicate WG
    // hits; a success lands in the session cache before the round closes.
    let result = raw_ship_stats_shared(&realm, account_id).await;
    let stats = match result {
        Ok(s) => {
            // Persist cache.
            let enriched: Vec<PlayerShipStats> = s.iter().map(&enrich).collect();
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

// ── Shared per-ship data source (one writer, many readers) ─────────────
//
// The main window's roster pipeline and the Tab overlay window are separate
// JS contexts that each ask for the same players' per-ship lists every
// battle. Mirroring the roster batch's process-lifetime cache (see
// ROSTER_STATS_CACHE in wg_api.rs), the RAW counters live here behind:
//
//   - an in-flight single-flight: the first caller per (realm, account)
//     becomes THE writer and holds the per-key lock while the WG request
//     is out; callers arriving mid-flight wait on the same lock and read
//     the round's shared answer — never a duplicate concurrent request;
//   - a session cache: one process-wide answer per player, served to
//     `session_cache` callers with PR re-derived per their algorithm.
//     Wiped together with the roster cache by the manual "refresh stats"
//     button (clear_roster_stats_cache), so a forced refresh stays forced.
//
// Non-session callers (the per-ship detail panel) skip the cache read but
// still join an in-flight round when one exists — exact-concurrency
// deduplication only, keeping their always-fresh contract intact.

/// Process-lifetime RAW per-ship answers, keyed (realm, account_id). The
/// raw counters predate the PR algorithm; enrichment is a pure per-caller
/// transform (see the command above).
type ShipStatsSessionCache =
    std::collections::HashMap<(String, i64), std::sync::Arc<Vec<RawShipStats>>>;
static SHIP_STATS_SESSION: std::sync::LazyLock<std::sync::Mutex<ShipStatsSessionCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Session generation, bumped by every clear: a fetch that STARTED before
/// the clear must not land its (pre-refresh) answer afterwards — the
/// writer captures the epoch and the insert compares it.
static SHIP_SESSION_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Session-entry cap, mirroring the frontend caches this serves — a long
/// session's rosters must not grow the map without bound; the whole-map
/// clear keeps the eviction trivial (same policy as the client caches).
const SHIP_STATS_SESSION_MAX: usize = 1000;

/// One in-flight raw-fetch round: `Some` once the round's writer finished;
/// waiters read the shared answer (success OR failure) after the lock.
type ShipFetchRound =
    std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<Result<Vec<RawShipStats>, String>>>>>;
static SHIP_FETCH_INFLIGHT: std::sync::LazyLock<
    tokio::sync::Mutex<std::collections::HashMap<(String, i64), ShipFetchRound>>,
> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

/// Session-cache read for `session_cache` callers. Infallible on a poisoned
/// lock (degrades to a cache miss → a fresh fetch).
fn ship_stats_session_get(
    realm: &str,
    account_id: i64,
) -> Option<std::sync::Arc<Vec<RawShipStats>>> {
    let cache = SHIP_STATS_SESSION.lock().ok()?;
    cache.get(&(realm.to_string(), account_id)).cloned()
}

/// Store one player's RAW answer. Every actual network fetch lands here —
/// including the detail panel's fresh fetches (the cache is only SERVED to
/// opt-in callers, so inserting is always safe). `round_epoch` is the
/// session epoch the fetch STARTED under: a clear that happened mid-flight
/// (the manual refresh) makes the insert a no-op, so a forced refresh
/// stays forced even against a round that was already out.
fn ship_stats_session_insert(realm: &str, account_id: i64, raw: &[RawShipStats], round_epoch: u64) {
    if let Ok(mut cache) = SHIP_STATS_SESSION.lock() {
        // Compare under the map lock: a clear completing between an outer
        // check and the insert would otherwise let one stale pre-refresh
        // answer slip into the freshly wiped cache.
        if round_epoch != SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        if cache.len() >= SHIP_STATS_SESSION_MAX {
            cache.clear();
        }
        cache.insert(
            (realm.to_string(), account_id),
            std::sync::Arc::new(raw.to_vec()),
        );
    }
}

/// Wiped together with the roster batch cache by the manual "refresh
/// stats" button — both windows' next ship-scoped view then re-fetches for
/// real instead of answering each other's pre-refresh round. The epoch
/// bump additionally invalidates any fetch still in flight (its result
/// will no longer land in the cache), and the in-flight map is drained
/// (best-effort try_lock — the epoch bump already guards anything that
/// slips past) so post-refresh callers avoid joining a pre-refresh round.
pub(crate) fn clear_ship_stats_session_cache() {
    SHIP_SESSION_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Release);
    if let Ok(mut cache) = SHIP_STATS_SESSION.lock() {
        cache.clear();
    }
    if let Ok(mut inflight) = SHIP_FETCH_INFLIGHT.try_lock() {
        inflight.clear();
    }
}

/// The single-writer raw fetch. The first caller per key becomes the round's
/// writer (holding the per-key lock across the WG request); concurrent
/// callers clone the round handle, wait on the lock, then read the shared
/// answer. The round leaves the map once complete — later calls either
/// serve from the session cache (inserted by the writer before the round
/// closes, so no window exists where a newcomer re-fetches) or, for
/// always-fresh callers, start a genuinely new round.
async fn raw_ship_stats_shared(realm: &str, account_id: i64) -> Result<Vec<RawShipStats>, String> {
    let key = (realm.to_string(), account_id);
    let round = {
        let mut map = SHIP_FETCH_INFLIGHT.lock().await;
        map.entry(key.clone()).or_default().clone()
    };
    let mut guard = round.lock().await;
    if let Some(shared) = guard.as_ref().cloned() {
        // A waiter that read a COMPLETED round removes it from the map when
        // it is still the live entry — a writer dropped between finishing
        // and its own removal would otherwise strand the round forever (and
        // always-fresh callers would keep joining the stale answer).
        drop(guard);
        remove_live_round(&key, &round).await;
        return match shared.as_ref() {
            Ok(raw) => Ok(raw.clone()),
            Err(e) => Err(e.clone()),
        };
    }
    // We are this round's single writer.
    let round_epoch = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
    let result = fetch_ship_stats(account_id, realm, true).await;
    if let Ok(raw) = &result {
        ship_stats_session_insert(realm, account_id, raw, round_epoch);
    }
    *guard = Some(std::sync::Arc::new(result.clone()));
    drop(guard);
    // Remove only OUR round: an unconditional delete could drop a NEWER
    // round's entry (installed after a waiter cleaned ours or a clear
    // drained the map) and briefly allow a duplicate concurrent fetch.
    remove_live_round(&key, &round).await;
    result
}

/// Remove `round` from the in-flight map iff it is still the live entry
/// for `key` (Arc identity) — shared by the writer and waiter paths, so a
/// finished round can never delete a NEWER round's entry (which would
/// briefly allow a duplicate concurrent fetch).
async fn remove_live_round(key: &(String, i64), round: &ShipFetchRound) {
    let mut map = SHIP_FETCH_INFLIGHT.lock().await;
    if map
        .get(key)
        .is_some_and(|live| std::sync::Arc::ptr_eq(live, round))
    {
        map.remove(key);
    }
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
/// pvp core of the fetch `lookup_player_ship_stats` performs (the mode
/// splits are skipped: the caller only needs the counters), without the
/// name enrichment or cache/history writes.
pub(crate) async fn fetch_expected_pr_rows(
    account_id: i64,
    realm: &str,
) -> Result<Vec<ExpectedPrRow>, String> {
    Ok(fetch_ship_stats(account_id, realm, false)
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
/// would turn the player's whole career into "recent" deltas later. Rows
/// whose counters are impossible are dropped for the same reason (see
/// [`is_poisoned_career_row`]).
fn append_ship_history(realm: &str, account_id: i64, stats: &[PlayerShipStats], timestamp: i64) {
    if stats.is_empty() {
        return;
    }
    let mut fresh: Vec<ShipCareerTotals> = Vec::with_capacity(stats.len());
    let mut poisoned_ids: Vec<i64> = Vec::new();
    for row in stats.iter().map(career_totals) {
        if is_poisoned_career_row(&row) {
            poisoned_ids.push(row.ship_id);
        } else {
            fresh.push(row);
        }
    }
    // Nothing healthy came back — record nothing, same reasoning as the
    // empty check above.
    if fresh.is_empty() {
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
    let _ = write_appdata_json(&file, &serde_json::to_string(&history).unwrap_or_default());
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

async fn fetch_ship_stats(
    account_id: i64,
    realm: &str,
    mode_splits: bool,
) -> Result<Vec<RawShipStats>, String> {
    if realm == "cn" {
        return fetch_ship_stats_cn(account_id, mode_splits).await;
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

/// CN arm: the vortex per-battle-type bulk endpoints
/// `GET https://vortex.wowsgame.cn/api/accounts/<id>/ships/<battle_type>/`.
///
/// The ship *list* endpoint (`/api/accounts/<id>/ships/`) was reworked by
/// the service (observed live 2026-09) to serve only summary counters —
/// battles/wins/losses/premium_exp per battle type — with damage, frags,
/// survival and XP gone, which used to render every CN row as
/// "data anomaly" (battles > 0, damage 0). The full counters moved to the
/// per-battle-type bulk endpoints above (the same family the official
/// profile site lazy-loads per ship as `/ships/<shipId>/<battleType>/`).
/// Each response's `data.<id>.statistics` is a ship_id-keyed map whose
/// nodes carry that one battle type's subtree with vortex field names, so
/// merging the per-mode maps rebuilds exactly the battle-type node shape
/// [`RawShipStats::from_vortex`] has always consumed.
///
/// `pvp` is the only mode the row itself needs — callers that only
/// aggregate account totals (the expected-PR rows) skip the other seven
/// requests via `mode_splits = false`. A `pvp` transport failure fails the
/// whole fetch (the caller's cache fallback then kicks in); a split
/// failure only narrows that mode's breakdown, the same tolerance the WG
/// path applies to absent fields. A hidden profile answers ok with no
/// statistics map at all — the empty list that yields is the "hidden"
/// marker, not an error.
const CN_SHIP_MODE_CORE: &str = "pvp";
const CN_SHIP_MODE_SPLITS: [&str; 7] = [
    "pvp_solo",
    "pvp_div2",
    "pvp_div3",
    "pve",
    "rank_solo",
    "rank_div2",
    "rank_div3",
];
/// Parallel per-mode requests, capped politely like the CN batch resolver
/// (the vortex service is unauthenticated).
const CN_SHIP_MODE_CONCURRENCY: usize = 4;

async fn fetch_ship_stats_cn(
    account_id: i64,
    mode_splits: bool,
) -> Result<Vec<RawShipStats>, String> {
    let host = super::wg_realm::vortex_host("cn")?;
    let client = super::wg_api_cn::vortex_client()?;
    let modes: Vec<&'static str> = if mode_splits {
        std::iter::once(CN_SHIP_MODE_CORE)
            .chain(CN_SHIP_MODE_SPLITS)
            .collect()
    } else {
        vec![CN_SHIP_MODE_CORE]
    };
    // Built with a plain loop instead of a `.map(|mode| …)` closure: the
    // tauri command boundary type-checks this future at higher rank, where
    // a closure over a `&str` trips rustc's "closure is not general
    // enough". Each task owns its client clone; the collected future then
    // holds no borrows of this scope at all.
    let mut tasks = Vec::with_capacity(modes.len());
    for mode in modes {
        let client = client.clone();
        tasks.push(async move {
            (
                mode,
                fetch_cn_ships_mode(client, host, account_id, mode).await,
            )
        });
    }
    let results: Vec<(&str, Result<serde_json::Value, String>)> = stream::iter(tasks)
        .buffered(CN_SHIP_MODE_CONCURRENCY)
        .collect()
        .await;
    merge_cn_mode_maps(account_id, results)
}

/// Fetch one CN per-mode ships document and validate its envelope. Takes
/// the client owned (a cheap clone) and the host/mode as `'static` names so
/// the spawned future is `Send` without higher-ranked lifetime proof over
/// borrowed parameters.
async fn fetch_cn_ships_mode(
    client: reqwest::Client,
    host: &'static str,
    account_id: i64,
    mode: &'static str,
) -> Result<serde_json::Value, String> {
    let url = format!("https://{host}/api/accounts/{account_id}/ships/{mode}/");
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
    Ok(v)
}

/// Merge the per-mode statistics maps into per-ship battle-type nodes and
/// parse them. Pure so the merge rule is unit-testable without HTTP. The
/// ship id lives in the map key; a deterministic (id-sorted) order falls
/// out of the BTreeMap, keeping cache writes and history diffs stable.
fn merge_cn_mode_maps(
    account_id: i64,
    results: Vec<(&str, Result<serde_json::Value, String>)>,
) -> Result<Vec<RawShipStats>, String> {
    let mut merged: std::collections::BTreeMap<i64, serde_json::Map<String, serde_json::Value>> =
        std::collections::BTreeMap::new();
    for (mode, result) in results {
        let v = match result {
            Ok(v) => v,
            // The pvp core failing is a real outage — surface it so the
            // caller falls back to its cache instead of reading the empty
            // list as a hidden profile.
            Err(e) if mode == CN_SHIP_MODE_CORE => return Err(e),
            // A split failing only narrows the mode breakdown.
            Err(_) => continue,
        };
        let stats_map = v
            .get("data")
            .and_then(|d| d.get(account_id.to_string()))
            .and_then(|p| p.get("statistics"))
            .and_then(|s| s.as_object());
        if let Some(map) = stats_map {
            for (ship_id, node) in map {
                let Some(id) = ship_id.parse::<i64>().ok() else {
                    continue;
                };
                if let Some(mode_node) = node.get(mode).filter(|m| !m.is_null()) {
                    merged
                        .entry(id)
                        .or_default()
                        .insert(mode.to_string(), mode_node.clone());
                }
            }
        }
    }
    Ok(merged
        .into_iter()
        .filter_map(|(id, node)| RawShipStats::from_vortex(id, &serde_json::Value::Object(node)))
        .collect())
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
    /// vortex field names and the ship id comes from the enclosing map key
    /// (the CN transport rebuilds this shape by merging the per-mode bulk
    /// endpoints — see `fetch_ship_stats_cn`). Counters absent from a node
    /// degrade to 0, same tolerance as the WG path; XP is the base-XP total
    /// `original_exp` (see the xp read below for why the vortex `exp` is
    /// never divided by battles). No last_battle_time is served at all.
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
            // Base XP only. The vortex `exp` is the boost-multiplied total
            // (premium account + economic bonuses): measured live on the 360
            // cluster, exp/battles exceeded the node's own `max_exp` on 384
            // of 397 ships — a per-battle average above the per-battle max,
            // impossible — and rendered absurd average-XP figures for boost-heavy CN
            // players. `original_exp` is the base-XP total matching what the
            // WG realms serve as `xp`; the legacy list-endpoint spelling
            // `xp` (pre-2026 shape) was base-XP too and stays the fallback.
            xp: pvp
                .get("original_exp")
                .and_then(|v| v.as_i64())
                .or_else(|| pvp.get("xp").and_then(|v| v.as_i64()))
                .unwrap_or(0),
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
    fn ship_stats_session_cache_roundtrip_clear_and_cap() {
        // Unique ids so the shared process-lifetime map stays isolated from
        // any other test touching it in the same binary.
        let raw = vec![RawShipStats {
            ship_id: 987_654_321,
            battles: 10,
            wins: 6,
            damage_caused: 100_000,
            frags: 4,
            survived_battles: 3,
            last_battle_time: 0,
            xp: 0,
            modes: None,
        }];
        assert!(ship_stats_session_get("eu", 987_654_321).is_none());
        let epoch = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
        ship_stats_session_insert("eu", 987_654_321, &raw, epoch);
        let hit = ship_stats_session_get("eu", 987_654_321).expect("inserted");
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].ship_id, 987_654_321);
        // Keyed per realm: another realm's answer is a different entry.
        assert!(ship_stats_session_get("na", 987_654_321).is_none());
        // The manual refresh wipes the whole map.
        clear_ship_stats_session_cache();
        assert!(ship_stats_session_get("eu", 987_654_321).is_none());
        // The cap evicts everything at once (the client caches' policy): the
        // MAX+1-th insert sees a full map and clears it first.
        clear_ship_stats_session_cache();
        let epoch = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
        for id in 0..=SHIP_STATS_SESSION_MAX as i64 {
            ship_stats_session_insert("eu", id, &[], epoch);
        }
        assert!(ship_stats_session_get("eu", 0).is_none());
        assert!(ship_stats_session_get("eu", SHIP_STATS_SESSION_MAX as i64).is_some());

        // A fetch that started BEFORE a clear must not land afterwards (the
        // manual refresh stays forced against in-flight rounds).
        clear_ship_stats_session_cache();
        let stale = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
        clear_ship_stats_session_cache();
        ship_stats_session_insert("eu", 987_654_322, &raw, stale);
        assert!(ship_stats_session_get("eu", 987_654_322).is_none());

        // Leave the process-lifetime map clean for whichever test runs next.
        clear_ship_stats_session_cache();
        assert!(ship_stats_session_get("eu", 987_654_321).is_none());
    }

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
        // Historical live shape of the (now summary-only) list endpoint's
        // nodes: the ship id comes from the map key and pvp carries vortex
        // names; sparse counters arrived as null. Mode splits use the same
        // battle-type keys with vortex counter names.
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
        assert_eq!(raw.xp, 400000, "the legacy xp spelling still feeds xp");
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

    /// Live regression (player 容易摆烂, id 7048255122, ship 白露
    /// 4077795024 — the report that exposed the bug): every per-mode node
    /// serves three XP totals — `original_exp` (base), `premium_exp` (the
    /// bonus part) and `exp` (the boost-multiplied total). Dividing `exp`
    /// by battles rendered an average XP of 16,088 against the ship's own
    /// `max_exp` of 2,753 — a per-battle average above the per-battle max,
    /// impossible. The base total must win whenever it is served.
    #[test]
    fn raw_ship_stats_from_vortex_reads_base_xp_not_boosted_total() {
        let node = serde_json::json!({
            "pvp": {
                "battles_count": 117, "wins": 68, "losses": 49,
                "damage_dealt": 5851737, "frags": 159,
                "exp": 1882275, "premium_exp": 246377,
                "original_exp": 153130, "max_exp": 2753
            }
        });
        let raw = RawShipStats::from_vortex(4077795024, &node).unwrap();
        assert_eq!(raw.xp, 153130, "base original_exp feeds xp");
        let stats = PlayerShipStats::from(&raw);
        assert!((stats.avg_xp.unwrap() - 153130.0 / 117.0).abs() < 0.01);
        assert!(
            stats.avg_xp.unwrap() < 2753.0,
            "average XP stays under the node's max_exp"
        );
    }

    /// Live shape (player Evelyine, id 7048272283, ship 4065212112) of the
    /// per-mode bulk endpoints: the merge rebuilds the battle-type node the
    /// parser consumes, the base-XP `original_exp` feeds xp (the
    /// boost-multiplied `exp` total is ignored), a failed split degrades to
    /// a missing breakdown entry, and zero-pvp ships are skipped.
    #[test]
    fn merge_cn_mode_maps_rebuilds_per_ship_nodes() {
        let pvp = serde_json::json!({
            "status": "ok",
            "data": { "7048272283": { "statistics": {
                "4065212112": { "pvp": {
                    "battles_count": 536, "wins": 379, "losses": 157,
                    "damage_dealt": 32873159, "frags": 582, "survived": 253,
                    "exp": 9480131, "premium_exp": 1265910,
                    "original_exp": 767064, "max_exp": 2857
                } },
                "3760142032": { "pvp": {} }
            } } }
        });
        let rank_solo = serde_json::json!({
            "status": "ok",
            "data": { "7048272283": { "statistics": {
                "4065212112": { "rank_solo": {
                    "battles_count": 76, "wins": 50,
                    "damage_dealt": 3977644, "frags": 90, "survived": 30
                } }
            } } }
        });
        let rows = merge_cn_mode_maps(
            7048272283,
            vec![
                ("pvp", Ok(pvp)),
                (
                    "pvp_div2",
                    Err::<serde_json::Value, String>("CN ships: HTTP 503".to_string()),
                ),
                ("rank_solo", Ok(rank_solo)),
            ],
        )
        .expect("merge succeeds");
        assert_eq!(rows.len(), 1, "the zero-pvp ship is skipped");
        let r = &rows[0];
        assert_eq!(r.ship_id, 4065212112);
        assert_eq!(r.battles, 536);
        assert_eq!(r.wins, 379);
        assert_eq!(r.damage_caused, 32873159);
        assert_eq!(r.frags, 582);
        assert_eq!(r.survived_battles, 253);
        assert_eq!(
            r.xp, 767064,
            "base original_exp feeds xp, not the boosted exp total"
        );
        let modes = r.modes.as_ref().expect("ranked split present");
        assert_eq!(modes.ranked.as_ref().unwrap().battles, 76);
        assert!((modes.ranked.as_ref().unwrap().winrate - 65.78).abs() < 0.01);
        assert!(modes.solo.is_none(), "failed split degraded to missing");
        let stats = PlayerShipStats::from(r);
        assert!((stats.avg_damage - 32873159.0 / 536.0).abs() < 0.01);
        assert!((stats.avg_xp.unwrap() - 767064.0 / 536.0).abs() < 0.01);
    }

    /// The pvp core is load-bearing: its failure must surface (so the caller
    /// falls back to its cache), while a hidden profile's ok-without-
    /// statistics answer stays the empty-list "hidden" marker, never an
    /// error.
    #[test]
    fn merge_cn_mode_maps_requires_pvp_core_but_tolerates_hidden() {
        let err = merge_cn_mode_maps(
            1,
            vec![(
                "pvp",
                Err::<serde_json::Value, String>("CN ships: HTTP 500".to_string()),
            )],
        )
        .expect_err("pvp failure must surface");
        assert!(err.contains("CN ships"));
        let hidden = serde_json::json!({
            "status": "ok",
            "data": { "1": { "name": "ghost", "hidden_profile": true } }
        });
        let rows =
            merge_cn_mode_maps(1, vec![("pvp", Ok(hidden))]).expect("hidden is not an error");
        assert!(rows.is_empty());
        // Splits alone (pvp missing from the data map entirely) yield no
        // rows either — a pvp-less node never parses.
        let split_only = serde_json::json!({
            "status": "ok",
            "data": { "1": { "statistics": {
                "42": { "pve": { "battles_count": 5, "wins": 4, "damage_dealt": 100000 } }
            } } }
        });
        let rows = merge_cn_mode_maps(1, vec![("pve", Ok(split_only))]).expect("ok");
        assert!(rows.is_empty(), "no pvp node parses to no row");
    }

    /// Defensive-branch coverage for the merge: a non-numeric ship-id key is
    /// skipped without affecting its siblings, a null mode node yields no
    /// entry (not an empty one), and the three ranked splits fed as separate
    /// mode documents combine into the single ranked bucket exactly like
    /// the WG path's integration test.
    #[test]
    fn merge_cn_mode_maps_skips_noise_and_combines_ranked_splits() {
        let pvp = serde_json::json!({
            "status": "ok",
            "data": { "7": { "statistics": {
                "42": { "pvp": {
                    "battles_count": 100, "wins": 55, "damage_dealt": 2500000,
                    "frags": 80, "survived": 30, "xp": 900000
                } },
                "garbage": { "pvp": { "battles_count": 1, "wins": 1 } },
                "43": { "pvp": null }
            } } }
        });
        let rank_solo = serde_json::json!({
            "status": "ok",
            "data": { "7": { "statistics": {
                "42": { "rank_solo": { "battles_count": 12, "wins": 6, "damage_dealt": 300000 } }
            } } }
        });
        let rank_div2 = serde_json::json!({
            "status": "ok",
            "data": { "7": { "statistics": {
                "42": { "rank_div2": { "battles_count": 8, "wins": 5, "damage_dealt": 200000 } }
            } } }
        });
        let rows = merge_cn_mode_maps(
            7,
            vec![
                ("pvp", Ok(pvp)),
                ("rank_solo", Ok(rank_solo)),
                ("rank_div2", Ok(rank_div2)),
            ],
        )
        .expect("merge succeeds");
        assert_eq!(rows.len(), 1, "garbage key and null pvp node add no rows");
        let modes = rows[0].modes.as_ref().expect("breakdown present");
        let ranked = modes.ranked.as_ref().expect("ranked bucket");
        assert_eq!(ranked.battles, 20, "rank_solo + rank_div2 merged");
        assert_eq!(ranked.wins, 11);
        assert_eq!(ranked.damage_caused, 500000);
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

    /// Rows with battles but zero damage AND kills (what a partially broken
    /// upstream returns — the 2026-09 CN vortex regression) must never enter
    /// the history: diffing against one later would resurrect the whole
    /// career total as a "recent" delta.
    #[test]
    fn ship_history_skips_poisoned_rows() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = format!("ship-history/test_{ts}.json");
        let _ = write_appdata_json(&file, "[]");

        let t0: i64 = 1_700_000_000;
        let poisoned = |ship_id: i64, battles: i64| {
            let mut s = mk_stats(ship_id, battles);
            s.damage_caused = 0;
            s.frags = 0;
            s
        };
        // Healthy ship 1 + poisoned ship 2 → only ship 1 is recorded.
        append_ship_history("test", ts as i64, &[mk_stats(1, 100), poisoned(2, 50)], t0);

        let history = read_history_file(&file);
        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].ships.len(),
            1,
            "poisoned row must not be recorded"
        );
        assert_eq!(history[0].ships[0].ship_id, 1);

        // An all-poisoned fetch records nothing at all: no new point inside
        // the merge window, and the stored point stays untouched.
        append_ship_history("test", ts as i64, &[poisoned(3, 10)], t0 + 60);
        let history = read_history_file(&file);
        assert_eq!(history.len(), 1, "all-poisoned fetch must be ignored");
        assert_eq!(history[0].timestamp, t0, "stored point must not be touched");
        assert_eq!(history[0].ships[0].ship_id, 1);

        let path = appdata_dir_path().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }

    /// A merge in which a ship's fresh row is poisoned must keep that ship's
    /// previously stored totals instead of regressing the baseline to a
    /// zero-counter row.
    #[test]
    fn ship_history_merge_keeps_stored_totals_for_poisoned_refresh() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file = format!("ship-history/test_{ts}.json");
        let _ = write_appdata_json(&file, "[]");

        let t0: i64 = 1_700_000_000;
        append_ship_history("test", ts as i64, &[mk_stats(2, 40)], t0);
        // Same session (< 6h apart) → merges into the stored point. Ship 1
        // arrives healthy, ship 2 comes back poisoned.
        let mut poisoned2 = mk_stats(2, 55);
        poisoned2.damage_caused = 0;
        poisoned2.frags = 0;
        append_ship_history("test", ts as i64, &[mk_stats(1, 10), poisoned2], t0 + 3600);

        let history = read_history_file(&file);
        assert_eq!(history.len(), 1);
        let by_ship: std::collections::HashMap<i64, _> =
            history[0].ships.iter().map(|s| (s.ship_id, s)).collect();
        assert_eq!(by_ship[&1].battles, 10, "healthy fresh row is recorded");
        assert_eq!(
            by_ship[&2].battles, 40,
            "poisoned refresh must keep the stored healthy totals",
        );
        assert_eq!(by_ship[&2].damage_caused, 40 * 10_000);

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
