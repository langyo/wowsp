//! The per-ship stats command and the shared raw-fetch source behind both
//! windows' ship-scoped rosters: the process-lifetime session cache, the
//! in-flight single-flight, the disk-cache fallback and the PR re-derivation.
//! Split from the former single-file `commands/ship_stats.rs`.

use wowsp_tauri_shared::PlayerShipStats;

use super::appdata::{read_appdata_json, write_appdata_json};
use super::history::append_ship_history;
use super::now_ts;
use super::raw::{RawShipStats, load_ship_name_map};
use super::stream::{PartialContext, fetch_ship_stats};
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
/// window) pass it so both windows share ONE upstream request per player per
/// process instead of each re-fetching the other's answers. Default
/// (None/false) keeps the historical always-fresh contract the per-ship
/// detail panel relies on.
#[tauri::command]
pub async fn lookup_player_ship_stats(
    app: tauri::AppHandle,
    account_id: i64,
    realm: String,
    pr_algo: Option<String>,
    session_cache: Option<bool>,
) -> Result<Vec<PlayerShipStats>, String> {
    let algo = PrAlgo::from_param(pr_algo.as_deref());
    let cache_file = format!("ship-stats/{realm}_{account_id}.json");
    // Expected algorithm: load the wows-numbers table once for the whole
    // list (downloaded on cache miss, see `trends`). None when it can't be
    // loaded — every row then renders "--" instead of failing the lookup.
    // The winrate algorithm skips this entirely: zero extra cost.
    let expected_table = if algo == PrAlgo::Expected {
        super::trends::load_expected_values().await
    } else {
        None
    };
    // The streaming layer's enrichment capture: partial rows pushed while
    // a slow document is still trickling in render through the same name
    // map + PR transform as the final answer (see [`PartialContext`]).
    let ctx = std::sync::Arc::new(PartialContext {
        app: Some(app),
        realm: realm.clone(),
        account_id,
        name_map: load_ship_name_map(),
        algo,
        expected: expected_table,
    });
    let enrich = |raw: &RawShipStats| -> PlayerShipStats { ctx.enrich(raw) };

    // Session read-through (roster surfaces): the raw counters are shared
    // verbatim; PR is a pure function of them and is re-derived per the
    // caller's algorithm, so both PR calibers ride one cached fetch.
    if session_cache.unwrap_or(false) {
        if let Some(raw) = ship_stats_session_get(&realm, account_id) {
            return Ok(raw.iter().map(&enrich).collect());
        }
    }

    // The shared single-writer fetch: concurrent callers (either window)
    // join the ONE in-flight request instead of stacking duplicate
    // hits; a success lands in the session cache before the round closes.
    let result = raw_ship_stats_shared(&realm, account_id, Some(ctx.clone())).await;
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
                        apply_pr_algo(p, ctx.algo, &ctx.expected);
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
//     becomes THE writer and holds the per-key lock while the upstream request
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
pub(super) static SHIP_SESSION_EPOCH: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Session-entry cap, mirroring the frontend caches this serves — a long
/// session's rosters must not grow the map without bound; the whole-map
/// clear keeps the eviction trivial (same policy as the client caches).
pub(super) const SHIP_STATS_SESSION_MAX: usize = 1000;

/// One in-flight raw-fetch round: `Some` once the round's writer finished;
/// waiters read the shared answer (success OR failure) after the lock.
type ShipFetchRound =
    std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<Result<Vec<RawShipStats>, String>>>>>;
static SHIP_FETCH_INFLIGHT: std::sync::LazyLock<
    tokio::sync::Mutex<std::collections::HashMap<(String, i64), ShipFetchRound>>,
> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

/// Session-cache read for `session_cache` callers. Infallible on a poisoned
/// lock (degrades to a cache miss → a fresh fetch).
pub(super) fn ship_stats_session_get(
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
pub(super) fn ship_stats_session_insert(
    realm: &str,
    account_id: i64,
    raw: &[RawShipStats],
    round_epoch: u64,
) {
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
/// writer (holding the per-key lock across the upstream request); concurrent
/// callers clone the round handle, wait on the lock, then read the shared
/// answer. The round leaves the map once complete — later calls either
/// serve from the session cache (inserted by the writer before the round
/// closes, so no window exists where a newcomer re-fetches) or, for
/// always-fresh callers, start a genuinely new round.
///
/// `ctx` is the writer's streaming context: waiters joining the round see
/// the WRITER's partial events (a waiter with a different PR preference
/// gets transient partials in the writer's caliber; the round's final
/// answer re-derives every caller's PR as before, so only the mid-flight
/// preview can differ).
async fn raw_ship_stats_shared(
    realm: &str,
    account_id: i64,
    ctx: Option<std::sync::Arc<PartialContext>>,
) -> Result<Vec<RawShipStats>, String> {
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
    let result = match fetch_ship_stats(account_id, realm, true, ctx.as_deref()).await {
        Ok(mut raw) => {
            // The vortex transport serves no per-ship last_battle_time (the
            // retired WG API did). Carry the previous disk-cache write's
            // stamps forward BEFORE the session insert, so every serving
            // path (session cache, disk cache, direct return) agrees and
            // the date-range career fallback keeps filtering on recency. A
            // ship the previous write never saw stays 0 — the face a
            // brand-new ship always had.
            if !raw.is_empty() {
                let prev = read_prev_ship_stats(realm, account_id);
                carry_last_battle_times(&mut raw, &prev);
            }
            Ok(raw)
        },
        Err(e) => Err(e),
    };
    if let Ok(raw) = &result {
        ship_stats_session_insert(realm, account_id, raw, round_epoch);
    }
    *guard = Some(std::sync::Arc::new(result.clone()));
    drop(guard);
    // Remove only OUR round: an unconditional delete could drop a NEWER
    // round's entry (installed after a waiter cleaned ours or a clear
    // drained the map) and would briefly allow a duplicate concurrent fetch.
    remove_live_round(&key, &round).await;
    result
}

/// The previous disk-cache write for one player, if any (unreadable =
/// none). Shared by the stamp carry-forward and nothing else — the cache
/// FALLBACK path in the command reads the file itself.
fn read_prev_ship_stats(realm: &str, account_id: i64) -> Vec<PlayerShipStats> {
    read_appdata_json(&format!("ship-stats/{realm}_{account_id}.json"))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<PlayerShipStats>>(&raw).ok())
        .unwrap_or_default()
}

/// Zero `last_battle_time` stamps take the previous write's value for the
/// same ship (pure so the carry rule is unit-testable without disk).
pub(super) fn carry_last_battle_times(raw: &mut [RawShipStats], prev: &[PlayerShipStats]) {
    if prev.is_empty() {
        return;
    }
    for row in raw.iter_mut().filter(|r| r.last_battle_time == 0) {
        if let Some(p) = prev.iter().find(|p| p.ship_id == row.ship_id) {
            row.last_battle_time = p.last_battle_time;
        }
    }
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
pub(super) fn apply_pr_algo(
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
    Ok(fetch_ship_stats(account_id, realm, false, None)
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
