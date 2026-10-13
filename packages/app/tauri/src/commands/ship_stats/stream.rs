//! The dual-path per-ship fetch (vortex per-mode primary + official WG-API
//! racer), the stall-tolerant streaming body reader and the partial-row
//! progress events. Split from the former single-file `commands/ship_stats.rs`.

use anyhow::{Result, anyhow, bail};

use futures::stream::{self, StreamExt};
use wowsp_tauri_shared::PlayerShipStats;

use super::lookup::apply_pr_algo;
use super::raw::RawShipStats;
use super::scanner::{ContainerKind, ContainerScanner};
use super::trends::ExpectedValues;
use super::wg_api::PrAlgo;

// ── Dual-path fetch: vortex primary, official racer ────────────────────
//
// Both arms ALWAYS fly together on non-CN realms:
//
//   - vortex per-mode bulk endpoints — the primary. The only source of the
//     mode-split fields (ranked/solo/div/co-op buckets), but its per-ship
//     documents run to hundreds of KB and the host crawls at ~12 KB/s with
//     20–30s TTFB during the degradations observed since 2026-10-09.
//   - the WG API `/wows/ships/stats/` — the racer. The endpoint stopped
//     serving the mode-split fields (observed live 2026-10: `fields=…pvp_
//     solo,pvp_div2,…` answers only `ship_id,last_battle_time,pvp` on every
//     cluster), but the career-pvp table still answers, and on a small
//     document that often completes first.
//
// Whichever arm finishes first fills the table (the racer's rows ship as a
// partial-rows event); vortex keeps running for the splits and its answer
// wins when it lands. A vortex failure falls back to the racer's rows, and
// only both arms failing fails the fetch (then the caller's disk-cache
// fallback applies). Both arms read through the same stall-tolerant body
// reader, so "slow but flowing" streams keep going instead of dying at a
// 15s whole-request timeout — see [`read_body_streamed`].

/// Event carrying streaming progress for one per-ship fetch. The phases:
/// `"partial"` — rows ready, the lookup table fills progressively;
/// `"slow"` — the source crossed [`SHIP_STREAM_SLOW_SIGNAL`] while still
/// flowing (the chrome's degraded-loading chip); `"done"` / `"aborted"` —
/// the source settled, the chip stands down. `source` names the transport
/// (`"vortex:pvp"`, `"vortex:rank_solo"`, `"official"`, …).
pub(crate) const SHIP_STATS_PROGRESS_EVENT: &str = "wowsp://ship-stats-progress";

/// Everything the streaming layer needs to push partial rows: a capture of
/// the command's name map, PR algorithm and expected table, plus the app
/// handle the progress events ride. Built once per
/// `lookup_player_ship_stats`; internal callers (`fetch_expected_pr_rows`)
/// pass `None` and the whole progress layer degrades to a no-op.
pub(super) struct PartialContext {
    pub(super) app: Option<tauri::AppHandle>,
    pub(super) realm: String,
    pub(super) account_id: i64,
    pub(super) name_map: std::collections::HashMap<i64, String>,
    pub(super) algo: PrAlgo,
    pub(super) expected: Option<std::collections::HashMap<i64, ExpectedValues>>,
}

/// Wire shape of the `wowsp://ship-stats-progress` payload. camelCase on
/// the wire to match the frontend's `ShipStatsProgress` interface — see
/// the serialization test pinning the field names.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShipStatsProgress {
    pub(super) realm: String,
    pub(super) account_id: i64,
    pub(super) phase: &'static str,
    pub(super) source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) rows: Option<Vec<PlayerShipStats>>,
}

impl PartialContext {
    /// The command's enrichment, verbatim — partial rows and the final
    /// answer render through the same transform.
    pub(super) fn enrich(&self, raw: &RawShipStats) -> PlayerShipStats {
        let mut p: PlayerShipStats = raw.into();
        p.name = self.name_map.get(&raw.ship_id).cloned().unwrap_or_default();
        apply_pr_algo(&mut p, self.algo, &self.expected);
        p
    }

    fn emit_progress(&self, phase: &'static str, source: &str, rows: Option<Vec<PlayerShipStats>>) {
        let Some(app) = &self.app else { return };
        let payload = ShipStatsProgress {
            realm: self.realm.clone(),
            account_id: self.account_id,
            phase,
            source: source.to_string(),
            rows,
        };
        use tauri::Emitter;
        if let Err(e) = app.emit(SHIP_STATS_PROGRESS_EVENT, &payload) {
            tracing::warn!(error = %e, "emit ship-stats progress failed");
        }
    }
}

/// A slow body stops being an error only while bytes keep arriving: this is
/// the ceiling on one UNPRODUCTIVE read (no bytes for this long → abort),
/// taking over from the old 15s whole-request timeout that killed every
/// large document the moment a degradation began.
const SHIP_STREAM_STALL: std::time::Duration = std::time::Duration::from_secs(15);
/// Hard ceiling on one document's TOTAL download — a crawl that never
/// stalls hard must still end, or a query lane leaks for good.
const SHIP_STREAM_HARD_CAP: std::time::Duration = std::time::Duration::from_secs(180);
/// Hard ceiling on one document's SIZE alongside the time caps: the buffer
/// grows with every chunk and nothing else bounds it, so a host streaming
/// garbage at link speed could balloon the process for the whole hard-cap
/// window (180s of a fast link is gigabytes). The largest legit per-mode
/// vortex document observed runs to single-digit megabytes; past the cap the
/// source is declaring itself broken and the read fails into the caller's
/// racer/cache fallback like any other transport failure.
pub(super) const SHIP_STREAM_MAX_BYTES: usize = 64 * 1024 * 1024;
/// How long a source may stream before the chrome flags it degraded —
/// matches the historical 15s timeout: past this point still flowing is
/// officially "slow but receiving".
const SHIP_STREAM_SLOW_SIGNAL: std::time::Duration = std::time::Duration::from_secs(15);
/// One partial-rows event per this many newly parsed ships (each event
/// re-serializes every row so far, so the cadence stays flat as a document
/// grows).
const SHIP_PARTIAL_BATCH: usize = 25;

/// One document's running byte count against [`SHIP_STREAM_MAX_BYTES`].
/// Pure so the guard is unit-testable without HTTP — the read loop checks
/// it BEFORE extending the buffer, so an oversized body fails without ever
/// holding the excess in memory.
pub(super) fn ensure_stream_cap(next_len: usize, source: &str) -> Result<()> {
    if next_len > SHIP_STREAM_MAX_BYTES {
        bail!(
            "{source}: body exceeded the {}MB size cap",
            SHIP_STREAM_MAX_BYTES / (1024 * 1024)
        );
    }
    Ok(())
}
/// Read one response body with stall-tolerant pacing: any [`SHIP_STREAM_-
/// STALL`] gap without bytes aborts, but a body that keeps trickling may
/// take up to [`SHIP_STREAM_HARD_CAP`] in total. Crossing
/// [`SHIP_STREAM_SLOW_SIGNAL`] emits the `"slow"` phase once — including
/// while the FIRST byte is still pending, so a 30s TTFB is flagged the
/// moment it passes 15s, not only after data arrives. `on_chunk` sees every
/// appended chunk together with the full buffer so far (the incremental
/// scanners ride it). Terminal phases are the CALLER's business (see
/// [`with_terminal_progress`]) so every exit path of a source emits exactly
/// one.
async fn read_body_streamed(
    mut resp: reqwest::Response,
    ctx: Option<&PartialContext>,
    source: &str,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<Vec<u8>> {
    let started = std::time::Instant::now();
    let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut slow_signalled = false;
    let slow_deadline = tokio::time::Instant::from_std(started + SHIP_STREAM_SLOW_SIGNAL);
    loop {
        // Fuse a one-shot slow deadline into the read: it fires while the
        // body is still pending (the TTFB case); once lit (here or on a
        // chunk arrival below) the branch disables itself.
        let await_slow = !slow_signalled;
        let slow_timer = tokio::time::sleep_until(slow_deadline);
        tokio::pin!(slow_timer);
        let chunk = tokio::select! {
            c = tokio::time::timeout(SHIP_STREAM_STALL, resp.chunk()) => c,
            _ = &mut slow_timer, if await_slow => {
                slow_signalled = true;
                if let Some(ctx) = ctx {
                    ctx.emit_progress("slow", source, None);
                }
                continue;
            },
        };
        match chunk {
            Ok(Ok(Some(bytes))) => {
                if started.elapsed() > SHIP_STREAM_HARD_CAP {
                    bail!(
                        "{source}: hard cap {}s exceeded",
                        SHIP_STREAM_HARD_CAP.as_secs()
                    );
                }
                ensure_stream_cap(buffer.len() + bytes.len(), source)?;
                buffer.extend_from_slice(&bytes);
                on_chunk(&buffer);
                if !slow_signalled && started.elapsed() >= SHIP_STREAM_SLOW_SIGNAL {
                    slow_signalled = true;
                    if let Some(ctx) = ctx {
                        ctx.emit_progress("slow", source, None);
                    }
                }
            },
            Ok(Ok(None)) => return Ok(buffer),
            Ok(Err(e)) => bail!("{source} body: {e}"),
            Err(_) => {
                bail!(
                    "{source} body: no bytes for {}s",
                    SHIP_STREAM_STALL.as_secs()
                )
            },
        }
    }
}

/// Wrap one source's whole fetch so it emits exactly one terminal progress
/// phase (`"done"` / `"aborted"`) whatever the outcome — the chrome's chip
/// keys off slow→terminal transitions and must never be left hanging.
async fn with_terminal_progress<T>(
    ctx: Option<&PartialContext>,
    source: &str,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let result = fut.await;
    if let Some(ctx) = ctx {
        ctx.emit_progress(
            if result.is_ok() { "done" } else { "aborted" },
            source,
            None,
        );
    }
    result
}

/// The dual-path race, split out so the ordering semantics are testable
/// without HTTP: both futures are polled concurrently;
///   - vortex finishing Ok first is the healthy path — the racer's result
///     is dropped unfinished, and `on_racer_abandoned` runs so its source
///     still gets a terminal signal (it may already have crossed "slow";
///     a source dropped mid-flight must not leave the chip hanging);
///   - the racer finishing Ok first surfaces its rows via `on_racer_rows`,
///     then vortex keeps running: its Ok wins (the splits), its Err falls
///     back to the racer's rows;
///   - vortex Err first still awaits the racer (it may rescue the fetch);
///   - the racer Err first is ignored — vortex decides alone.
///
/// Only the future that did NOT settle at the select is ever awaited
/// afterwards — re-polling a completed pinned future is undefined, so each
/// branch consumes exactly the one result it owns.
pub(super) async fn race_dual_path(
    racer: impl std::future::Future<Output = Result<Vec<RawShipStats>>>,
    primary: impl std::future::Future<Output = Result<Vec<RawShipStats>>>,
    mut on_racer_rows: impl FnMut(&[RawShipStats]),
    mut on_racer_abandoned: impl FnMut(),
) -> Result<Vec<RawShipStats>> {
    /// Which arm settled first at the select — carries that arm's result
    /// out; the OTHER arm stays pending for its branch to await.
    enum Settled {
        Racer(Result<Vec<RawShipStats>>),
        Primary(Result<Vec<RawShipStats>>),
    }
    tokio::pin!(racer, primary);
    let first = tokio::select! {
        r = &mut racer => Settled::Racer(r),
        p = &mut primary => Settled::Primary(p),
    };
    match first {
        Settled::Primary(primary_result) => match primary_result {
            // Vortex fast and healthy — the racer is dropped unfinished;
            // give its source a terminal signal first.
            Ok(rows) => {
                on_racer_abandoned();
                Ok(rows)
            },
            // Vortex failed; the still-running racer may rescue the fetch.
            Err(primary_err) => match racer.await {
                Ok(racer_rows) => Ok(racer_rows),
                Err(_) => Err(primary_err),
            },
        },
        Settled::Racer(racer_result) => match racer_result {
            Ok(racer_rows) => {
                on_racer_rows(&racer_rows);
                // Vortex keeps running for the splits; its Err falls back
                // to the racer's already-answered table.
                match primary.await {
                    Ok(primary_rows) => Ok(primary_rows),
                    Err(_) => Ok(racer_rows),
                }
            },
            // The racer failed early — vortex decides alone.
            Err(_) => primary.await,
        },
    }
}

/// Fetch a player's per-ship stats: the vortex per-mode arms everywhere,
/// plus the official WG-API racer on every realm that has one (CN never
/// had a WG-style API — vortex only there). See the section header for the
/// race semantics and [`read_body_streamed`] for the degraded-transport
/// behavior.
pub(super) async fn fetch_ship_stats(
    account_id: i64,
    realm: &str,
    mode_splits: bool,
    ctx: Option<&PartialContext>,
) -> Result<Vec<RawShipStats>> {
    let racer = async {
        if realm == "cn" {
            // No official arm exists on the CN cluster — park the racer on
            // an error the race treats as "racer unavailable".
            Err(anyhow!("official arm unavailable on cn"))
        } else {
            fetch_ship_stats_official(account_id, realm, ctx).await
        }
    };
    let primary = fetch_ship_stats_vortex(account_id, realm, mode_splits, ctx);
    let on_racer_rows = |rows: &[RawShipStats]| {
        if let Some(ctx) = ctx {
            let enriched: Vec<PlayerShipStats> = rows.iter().map(|r| ctx.enrich(r)).collect();
            ctx.emit_progress("partial", "official", Some(enriched));
        }
    };
    // The healthy path drops the racer mid-flight; its source may already
    // have crossed "slow", and a dropped source emits no terminal of its
    // own — stand it down here so the chip cannot stick.
    let on_racer_abandoned = || {
        if let Some(ctx) = ctx {
            ctx.emit_progress("done", "official", None);
        }
    };
    race_dual_path(racer, primary, on_racer_rows, on_racer_abandoned).await
}

/// Vortex per-battle-type bulk endpoints
/// `GET https://vortex.<cluster>/api/accounts/<id>/ships/<battle_type>/`.
///
/// The CN cluster's WG-style API never existed and the international
/// clusters' `/wows/ships/stats/` lost its mode splits (see
/// [`fetch_ship_stats`]), so EVERY realm reads here. Each response's
/// `data.<id>.statistics` is a ship_id-keyed map whose nodes carry that one
/// battle type's subtree with vortex field names, so merging the per-mode
/// maps rebuilds the battle-type node shape [`RawShipStats::from_vortex`]
/// consumes.
///
/// `pvp` is the only mode the row itself needs — callers that only
/// aggregate account totals (the expected-PR rows) skip the other seven
/// requests via `mode_splits = false`. A `pvp` transport failure fails the
/// whole fetch (the caller's cache fallback then kicks in); a split
/// failure only narrows that mode's breakdown, the same tolerance the WG
/// path applied to absent fields. A hidden profile answers ok with no
/// statistics map at all — the empty list that yields is the "hidden"
/// marker, not an error.
const SHIP_MODE_CORE: &str = "pvp";
const SHIP_MODE_SPLITS: [&str; 7] = [
    "pvp_solo",
    "pvp_div2",
    "pvp_div3",
    "pve",
    "rank_solo",
    "rank_div2",
    "rank_div3",
];
/// Parallel per-mode requests — all eight fly at once. The frontend paces
/// whole ACCOUNTS (three lanes per window across its query pipelines, one
/// pipeline message per player, with cross-window single-flight dedupe in
/// front), so widening a single player's modes to full parallelism resolves
/// that player's list in one request round-trip (the per-player arrival
/// cadence rides it) while the cross-account width stays bounded by that
/// same pacing. The vortex service is unauthenticated and tolerates this
/// politely.
const SHIP_MODE_CONCURRENCY: usize = 8;

async fn fetch_ship_stats_vortex(
    account_id: i64,
    realm: &str,
    mode_splits: bool,
    ctx: Option<&PartialContext>,
) -> Result<Vec<RawShipStats>> {
    let host = super::wg_realm::vortex_host(realm).map_err(anyhow::Error::msg)?;
    // The stream client: no whole-request timeout — the per-mode documents
    // are the big ones a degraded host serves at a crawl, and
    // [`read_body_streamed`] enforces the pacing instead.
    let client = super::wg_api_cn::vortex_stream_client().map_err(anyhow::Error::msg)?;
    let modes: Vec<&'static str> = if mode_splits {
        std::iter::once(SHIP_MODE_CORE)
            .chain(SHIP_MODE_SPLITS)
            .collect()
    } else {
        vec![SHIP_MODE_CORE]
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
                fetch_vortex_ships_mode(client, host, account_id, mode, ctx).await,
            )
        });
    }
    let results: Vec<(&str, Result<serde_json::Value>)> = stream::iter(tasks)
        .buffered(SHIP_MODE_CONCURRENCY)
        .collect()
        .await;
    merge_vortex_mode_maps(account_id, results)
}

/// Fetch one cluster's per-mode ships document and validate its envelope.
/// Takes the client owned (a cheap clone) and the host/mode as `'static`
/// names so the spawned future is `Send` without higher-ranked lifetime
/// proof over borrowed parameters. The body rides the stall-tolerant
/// reader; the `pvp` core additionally streams through the incremental
/// scanner so partial rows surface while a slow document is mid-flight.
async fn fetch_vortex_ships_mode(
    client: reqwest::Client,
    host: &'static str,
    account_id: i64,
    mode: &'static str,
    ctx: Option<&PartialContext>,
) -> Result<serde_json::Value> {
    let source = format!("vortex:{mode}");
    let terminal_source = source.clone();
    with_terminal_progress(ctx, &terminal_source, async move {
        let url = format!("https://{host}/api/accounts/{account_id}/ships/{mode}/");
        let resp = super::upstream_health::recorded_get(&client, host, "vortex ships", url)
            .await
            .map_err(anyhow::Error::msg)?;
        if !resp.status().is_success() {
            bail!("vortex ships: HTTP {}", resp.status());
        }
        let body = if mode == SHIP_MODE_CORE {
            match ctx {
                Some(ctx) => read_body_scanned_vortex(ctx, &source, resp, account_id).await?,
                None => read_body_streamed(resp, None, &source, |_| {}).await?,
            }
        } else {
            read_body_streamed(resp, ctx, &source, |_| {}).await?
        };
        let v: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| anyhow!("vortex ships parse: {e}"))?;
        if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
            let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
            bail!("vortex ships: {err}");
        }
        Ok(v)
    })
    .await
}

/// The pvp core's body read with the incremental scanner attached: every
/// complete ship entry the scanner yields is parsed (`from_vortex` over
/// the entry's own node) and emitted in enriched batches, so the lookup
/// table fills while the document crawls in. The caller's full-document
/// parse afterwards stays authoritative — a scanner desync can only
/// misshape the transient partials, never the merged answer.
async fn read_body_scanned_vortex(
    ctx: &PartialContext,
    source: &str,
    resp: reqwest::Response,
    account_id: i64,
) -> Result<Vec<u8>> {
    let mut scanner = ContainerScanner::new(
        ContainerKind::Map,
        vec![
            "data".to_string(),
            account_id.to_string(),
            "statistics".to_string(),
        ],
    );
    let mut parsed: Vec<RawShipStats> = Vec::new();
    let mut last_emitted = 0usize;
    let body = read_body_streamed(resp, Some(ctx), source, |buf: &[u8]| {
        for entry in scanner.feed(buf) {
            let Some(id) = entry.key else { continue };
            let Ok(node) =
                serde_json::from_slice::<serde_json::Value>(&buf[entry.start..entry.end])
            else {
                continue;
            };
            // The statistics entry IS the battle-type node shape from_vortex
            // consumes (`{"pvp": {...}, ...}`) — no re-wrapping (a second
            // `pvp` layer hides the counters one depth too deep and parses
            // every entry to None).
            if let Some(raw) = RawShipStats::from_vortex(id, &node) {
                parsed.push(raw);
            }
        }
        if parsed.len() - last_emitted >= SHIP_PARTIAL_BATCH {
            last_emitted = parsed.len();
            let rows: Vec<PlayerShipStats> = parsed.iter().map(|r| ctx.enrich(r)).collect();
            ctx.emit_progress("partial", source, Some(rows));
        }
    })
    .await?;
    // Flush the tail — a small account's last batch never crosses the
    // threshold on its own.
    if parsed.len() > last_emitted {
        let rows: Vec<PlayerShipStats> = parsed.iter().map(|r| ctx.enrich(r)).collect();
        ctx.emit_progress("partial", source, Some(rows));
    }
    Ok(body)
}

/// The official WG-API racer (`/wows/ships/stats/`): career pvp counters
/// and `last_battle_time` per ship, no mode splits (the endpoint dropped
/// them live 2026-10 — see the section header). Gets the same
/// stall-tolerant streaming and incremental scan as the vortex arm, so a
/// crawling response still fills the table progressively. Long lists
/// paginate; pages beyond the first are fetched sequentially and appended
/// (bounded — a runaway page_total must not loop the racer forever).
async fn fetch_ship_stats_official(
    account_id: i64,
    realm: &str,
    ctx: Option<&PartialContext>,
) -> Result<Vec<RawShipStats>> {
    with_terminal_progress(ctx, "official", async move {
        let app_id = super::wg_realm::application_id(realm);
        let host = super::wg_realm::api_host(realm).map_err(anyhow::Error::msg)?;
        let client = super::wg_api_cn::vortex_stream_client().map_err(anyhow::Error::msg)?;
        let fields = "ship_id,last_battle_time,pvp,pvp_solo,pvp_div2,pvp_div3,pve,\
                      rank_solo,rank_div2,rank_div3";
        const MAX_PAGES: usize = 8;
        let mut out: Vec<RawShipStats> = Vec::new();
        let mut partial_state = OfficialPartialState {
            parsed: Vec::new(),
            last_emitted: 0,
        };
        let mut page_total = 1usize;
        // A while, not `for page in 1..=page_total`: the range would freeze
        // page_total at its pre-loop value and never fetch page 2+.
        let mut page = 1usize;
        while page <= page_total {
            let mut url = format!(
                "https://{host}/wows/ships/stats/?application_id={app_id}\
                 &account_id={account_id}&fields={fields}"
            );
            if page > 1 {
                url.push_str(&format!("&page_no={page}"));
            }
            let resp = super::upstream_health::recorded_get(&client, host, "ships/stats", url)
                .await
                .map_err(anyhow::Error::msg)?;
            if !resp.status().is_success() {
                bail!("ships/stats: HTTP {}", resp.status());
            }
            let body =
                read_body_scanned_official(ctx, resp, account_id, &mut partial_state).await?;
            let v: serde_json::Value =
                serde_json::from_slice(&body).map_err(|e| anyhow!("ships/stats parse: {e}"))?;
            if v.get("status").and_then(|s| s.as_str()) != Some("ok") {
                let err = v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown");
                bail!("ships/stats: {err}");
            }
            if page == 1 {
                page_total = v
                    .get("meta")
                    .and_then(|m| m.get("page_total"))
                    .and_then(|p| p.as_u64())
                    .unwrap_or(1)
                    .min(MAX_PAGES as u64) as usize;
            }
            // data is { "<accountId>": [ { ship_id, pvp: {...}, ... }, ... ]
            let arr = v
                .get("data")
                .and_then(|d| d.get(account_id.to_string()))
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default();
            for entry in arr {
                if let Some(raw) = RawShipStats::from_wg(&entry) {
                    out.push(raw);
                }
            }
            page += 1;
        }
        Ok(out)
    })
    .await
}

/// Per-fetch (cross-page) partial state for the official arm's scanner:
/// page 2's events must carry page 1's rows too, or the progressive table
/// would shrink mid-pagination.
struct OfficialPartialState {
    parsed: Vec<RawShipStats>,
    last_emitted: usize,
}

/// The racer's body read with the incremental scanner attached (mirror of
/// [`read_body_scanned_vortex`] over the WG array shape). No progress
/// context → plain buffered read with the same stall tolerance.
async fn read_body_scanned_official(
    ctx: Option<&PartialContext>,
    resp: reqwest::Response,
    account_id: i64,
    state: &mut OfficialPartialState,
) -> Result<Vec<u8>> {
    let Some(ctx) = ctx else {
        return read_body_streamed(resp, None, "official", |_| {}).await;
    };
    let mut scanner = ContainerScanner::new(
        ContainerKind::Array,
        vec!["data".to_string(), account_id.to_string()],
    );
    let OfficialPartialState {
        parsed,
        last_emitted,
    } = state;
    let body = read_body_streamed(resp, Some(ctx), "official", |buf: &[u8]| {
        for entry in scanner.feed(buf) {
            let Ok(node) =
                serde_json::from_slice::<serde_json::Value>(&buf[entry.start..entry.end])
            else {
                continue;
            };
            if let Some(raw) = RawShipStats::from_wg(&node) {
                parsed.push(raw);
            }
        }
        if parsed.len() - *last_emitted >= SHIP_PARTIAL_BATCH {
            *last_emitted = parsed.len();
            let rows: Vec<PlayerShipStats> = parsed.iter().map(|r| ctx.enrich(r)).collect();
            ctx.emit_progress("partial", "official", Some(rows));
        }
    })
    .await?;
    if parsed.len() > *last_emitted {
        let rows: Vec<PlayerShipStats> = parsed.iter().map(|r| ctx.enrich(r)).collect();
        ctx.emit_progress("partial", "official", Some(rows));
    }
    Ok(body)
}
/// Merge the per-mode statistics maps into per-ship battle-type nodes and
/// parse them. Pure so the merge rule is unit-testable without HTTP. The
/// ship id lives in the map key; a deterministic (id-sorted) order falls
/// out of the BTreeMap, keeping cache writes and history diffs stable.
pub(super) fn merge_vortex_mode_maps(
    account_id: i64,
    results: Vec<(&str, Result<serde_json::Value>)>,
) -> Result<Vec<RawShipStats>> {
    let mut merged: std::collections::BTreeMap<i64, serde_json::Map<String, serde_json::Value>> =
        std::collections::BTreeMap::new();
    for (mode, result) in results {
        let v = match result {
            Ok(v) => v,
            // The pvp core failing is a real outage — surface it so the
            // caller falls back to its cache instead of reading the empty
            // list as a hidden profile.
            Err(e) if mode == SHIP_MODE_CORE => return Err(e),
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
