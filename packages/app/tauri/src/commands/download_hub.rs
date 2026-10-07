//! The unified resource-download subsystem.
//!
//! Every artifact the app pulls from its GitHub-mirror ladder — the app
//! update installer, the resource pack (full archive and chain-patch
//! links), the baked data pack and mod-hub packages — downloads through
//! this hub instead of each command rolling its own engine. The hub's
//! contract:
//!
//! - **FIFO queue**: jobs run strictly one at a time in arrival order,
//!   so exactly one download writes disk at any moment (a download can
//!   never contend with another for the platter or the mirror ladder).
//! - **Many readers, one writer**: mirrors are read in parallel (the
//!   optional race window probes every source at once; failover walks
//!   the ladder), but a single code path owns the part file. A dying
//!   mirror fails the attempt over to the next candidate FROM THE
//!   COMMITTED OFFSET — the progress bar can no longer restart from 0
//!   mid-download (the failure mode that used to read as "downloaded to
//!   100%, then started over").
//! - **Resume across passes**: the part file survives a failed or
//!   cancelled pass (only a verified success or a content change
//!   removes/reseeds it), so a retry continues where the last attempt
//!   died. The caller names the part file and owns its lifecycle; the
//!   hub only demands it be stable while retries can happen.
//! - **One progress channel**: `wowsp://download-progress` carries
//!   [`DownloadProgress`] for every context; UIs subscribe once and
//!   filter by kind/id.
//!
//! Deliberately NOT routed through the hub: pairing transfers (they pull
//! from a paired device over LAN/relay, not the mirror ladder, and keep
//! their own multiplexed `wowsp://pairing-progress` channel) and the
//! media image cache (latency-critical tiny fetches that must never
//! queue behind a ~1.2 GB pack).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use wowsp_tauri_shared::download::phase;
use wowsp_tauri_shared::{DOWNLOAD_PROGRESS_EVENT, DownloadProgress};

use super::network::build_http_client;

/// Progress-event cadence: the percent tick and the EWMA speed sample
/// both run on this clock so the webview isn't flooded per chunk.
const PROGRESS_TICK: Duration = Duration::from_millis(500);

/// Smoothing factor for the displayed download speed (EWMA over the
/// per-tick bytes/sec samples).
const SPEED_EWMA_ALPHA: f64 = 0.3;

/// How much of the body each race probe reads before judging the mirror
/// (1 MiB is enough to rank throughput without buffering the artifact).
const RACE_PROBE_BYTES: u64 = 1024 * 1024;

/// A job waiting in the FIFO queue behind a running download is
/// announced with this one-shot event (the UI can show "queued").
static HUB_BUSY: AtomicBool = AtomicBool::new(false);

/// Monotonic job-key counter — cancels address jobs by id, several jobs
/// may share an id over time (mod packages reuse the entry id).
static JOB_SEQ: AtomicU64 = AtomicU64::new(0);

// ── Public request shape ──────────────────────────────────────────────────

/// One download job for [`transfer`].
#[derive(Debug, Clone)]
pub struct DownloadRequest {
    /// Job identity for events and cancels: `"update"`, `"res-pack"`,
    /// `"data-pack"`, or the mod-hub entry id for packages.
    pub id: String,
    /// Context owning the job (see `wowsp_tauri_shared::download::kind`).
    pub kind: String,
    /// Mirror ladder, preferred order. The race window (when enabled)
    /// reorders it by measured throughput; failover then walks it.
    pub sources: Vec<String>,
    /// The single part file the writer appends to. Must be stable across
    /// retries of the same artifact (that is what makes resume safe).
    pub part: PathBuf,
    /// Floor on a completed transfer: a body shorter than this is a
    /// mirror error page, not the artifact.
    pub min_bytes: u64,
    /// Ceiling on the transfer (data-pack cap); `None` = unbounded.
    pub max_bytes: Option<u64>,
    /// sha256 of the WHOLE file; verified streaming (prefix included
    /// when resuming). A mismatch deletes the part — the bytes cannot be
    /// trusted, the next pass starts clean.
    pub expected_sha256: Option<String>,
    /// Per-request total cap (reqwest `timeout` covers the whole request
    /// including the body stream). `None` = only the client's connect
    /// timeout applies.
    pub timeout: Option<Duration>,
    /// `Some(window)` → probe every source in parallel first and reorder
    /// the ladder by throughput (the update installer's race). `None` →
    /// straight ladder order.
    pub race_window: Option<Duration>,
    /// Whether an existing part file is a valid resume base. True only
    /// when the part is content-addressed (versioned name or verified
    /// sha); a shared scratch name (delta links) must restart clean.
    pub resume: bool,
    /// Error text returned (and shown) when the user cancels the job.
    pub cancel_msg: String,
    /// Progress aggregation base: bytes earlier segments of the same pass
    /// already committed (chain patches, multi-package installs).
    pub base_received: u64,
    /// Aggregation base for `total` (the pass total minus this segment).
    pub base_total: u64,
    /// Total-size fallback when the server sends none (manifest asset
    /// sizes); 0 = unknown.
    pub total_hint: u64,
    /// Static per-job detail merged into every progress event
    /// (`{segment, segments}` / `{package, packages}`).
    pub detail: Option<serde_json::Value>,
}

impl DownloadRequest {
    /// A request with the context-independent defaults filled in.
    #[must_use]
    pub fn new(id: &str, kind: &str, sources: Vec<String>, part: PathBuf) -> Self {
        Self {
            id: id.to_string(),
            kind: kind.to_string(),
            sources,
            part,
            min_bytes: 0,
            max_bytes: None,
            expected_sha256: None,
            timeout: None,
            race_window: None,
            resume: false,
            cancel_msg: "download cancelled".to_string(),
            base_received: 0,
            base_total: 0,
            total_hint: 0,
            detail: None,
        }
    }
}

/// What [`transfer`] hands back: the completed part file and its size.
/// The caller renames/installs it — the hub never touches destinations.
#[derive(Debug, Clone)]
pub struct TransferDone {
    pub bytes: u64,
    pub path: PathBuf,
}

// ── Hub plumbing: FIFO worker + cancel registry ───────────────────────────

type CancelMap = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

struct Hub {
    tx: tokio::sync::mpsc::UnboundedSender<Job>,
}

static HUB: OnceLock<Hub> = OnceLock::new();
static CANCELS: OnceLock<CancelMap> = OnceLock::new();
static PENDING_CANCELS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn cancels() -> &'static CancelMap {
    CANCELS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn hub() -> &'static Hub {
    HUB.get_or_init(|| {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(worker(rx));
        Hub { tx }
    })
}

struct Job {
    req: DownloadRequest,
    app: Option<AppHandle>,
    cancel: Arc<AtomicBool>,
    waiter: tokio::sync::oneshot::Sender<Result<TransferDone, String>>,
    /// Registry key — distinct from `req.id` so repeated ids (mod
    /// packages) never collide in the cancel map.
    key: String,
}

/// Queue one download and resolve with its outcome. Jobs run strictly in
/// arrival order; [`cancel`] tears a queued or running job down
/// cooperatively. `app` is `None` for headless callers (startup ensure
/// paths): the transfer runs, the progress events are simply not emitted.
pub async fn transfer(
    app: Option<&AppHandle>,
    req: DownloadRequest,
) -> Result<TransferDone, String> {
    let hub = hub();
    let (waiter, done) = tokio::sync::oneshot::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let key = format!(
        "{}/{}#{}",
        req.kind,
        req.id,
        JOB_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    if let Ok(mut map) = cancels().lock() {
        map.insert(key.clone(), Arc::clone(&cancel));
    }
    // Consume a cancel pressed while this pass was still resolving
    // (probes / manifest fetches run before the job is queued): the job
    // dies the moment the worker dequeues it, like the static flag the
    // old per-command engines used.
    {
        let scope = format!("{}/{}", req.kind, req.id);
        let consumed = match pending_cancels().lock() {
            Ok(mut pending) => pending.remove(&scope),
            Err(_) => false,
        };
        if consumed {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    if let Some(app) = app.filter(|_| HUB_BUSY.load(Ordering::SeqCst)) {
        // Someone else's download owns the pipe — say so once so the UI
        // can render a waiting state instead of a frozen bar. `received`
        // is segment-local here; `emit` adds the pass's aggregation base.
        emit(Some(app), &req, phase::QUEUED, 0, 0, 0.0, None);
    }
    let sent = hub.tx.send(Job {
        req,
        app: app.cloned(),
        cancel,
        waiter,
        key: key.clone(),
    });
    if sent.is_err() {
        // The worker is gone (runtime shutdown) — drop the registry entry
        // so the key cannot leak.
        if let Ok(mut map) = cancels().lock() {
            map.remove(&key);
        }
        return Err("download hub worker is gone".to_string());
    }
    match done.await {
        Ok(result) => result,
        Err(_) => Err("download job was dropped by the hub worker".to_string()),
    }
}

/// Flag the queued or running job(s) under `(kind, id)` for
/// cancellation. The running attempt stops at the next chunk boundary,
/// keeps its part file (resume base for a later retry) and fails with
/// the request's `cancel_msg`; a still-queued job fails the moment it is
/// dequeued. When no job is registered yet — the caller's resolve phase
/// (version probes, manifest fetches) runs BEFORE `transfer` — the
/// request is remembered and consumed by the next `transfer` under the
/// same key, so a cancel pressed during resolution is never lost.
/// The kind scopes the match: a mod-hub entry literally named "update"
/// must never cancel the app-update pass.
pub fn cancel(kind: &str, id: &str) {
    let scope = format!("{kind}/{id}");
    let prefix = format!("{scope}#");
    if let Ok(map) = cancels().lock() {
        let mut matched = false;
        for (key, flag) in map.iter() {
            if key.starts_with(&prefix) {
                flag.store(true, Ordering::SeqCst);
                matched = true;
            }
        }
        if !matched {
            // No live job under this scope — leave a sticky request for
            // the resolve phase that precedes the next transfer.
            if let Ok(mut pending) = pending_cancels().lock() {
                pending.insert(scope);
            }
        }
    }
}

/// Scopes with a cancel requested while no job was registered (consumed
/// by the next [`transfer`] under the same scope).
fn pending_cancels() -> &'static Mutex<std::collections::HashSet<String>> {
    PENDING_CANCELS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Drop a stale pending cancel for `(kind, id)`. Every cancellable pass
/// calls this at its ENTRY — before its resolve phase — so a cancel that
/// landed while no job existed (pressed during the previous pass's
/// apply/assemble tail, after its job was deregistered) can never poison
/// THIS user-initiated attempt. Cancels pressed after the entry — during
/// resolution or the transfer itself — are unaffected: they target the
/// pass that is now visibly running.
pub fn clear_pending(kind: &str, id: &str) {
    let scope = format!("{kind}/{id}");
    if let Ok(mut pending) = pending_cancels().lock() {
        pending.remove(&scope);
    }
}

async fn worker(mut rx: tokio::sync::mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = rx.recv().await {
        HUB_BUSY.store(true, Ordering::SeqCst);
        // Run the body in its own task: a panic inside one download must
        // fail that job, not kill the queue (every later job would hang).
        let ran = tokio::spawn(run_transfer(
            job.app.clone(),
            job.req.clone(),
            Arc::clone(&job.cancel),
        ))
        .await;
        let result = match ran {
            Ok(r) => r,
            Err(e) => Err(format!("download task panicked: {e}")),
        };
        HUB_BUSY.store(false, Ordering::SeqCst);
        if let Ok(mut map) = cancels().lock() {
            map.remove(&job.key);
        }
        let _ = job.waiter.send(result);
    }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/// Parse a `Content-Range: bytes <start>-<end>/<len|*>` header value.
/// `None` on any other shape; `Some((start, None))` for an unknown total.
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let value = value.trim().strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    if end < start {
        return None;
    }
    let total = match total.trim() {
        "*" => None,
        n => Some(n.parse().ok()?),
    };
    Some((start, total))
}

/// The 416 flavour of Content-Range — `bytes */<total>` — carries no
/// range, only the size the request failed against.
fn parse_unsatisfiable_total(value: &str) -> Option<u64> {
    let value = value.trim().strip_prefix("bytes */")?;
    value.trim().parse().ok()
}

/// Instantaneous speed in bytes/sec over the elapsed window; a zero
/// window yields 0 instead of infinity.
fn speed_bps(delta: u64, elapsed: Duration) -> f64 {
    if elapsed.is_zero() {
        0.0
    } else {
        delta as f64 / elapsed.as_secs_f64()
    }
}

/// Exponential moving average: `prev + alpha * (sample - prev)`. Seeded
/// at 0 the estimate climbs toward a steady sample without overshooting.
fn ewma(prev: f64, sample: f64, alpha: f64) -> f64 {
    prev + alpha * (sample - prev)
}

/// Probe score for the race window: bytes/second; failures rank last
/// forever (they stay ladder-ordered last-resort failovers).
fn probe_score(result: Option<(u64, Duration)>) -> f64 {
    result.map_or(f64::NEG_INFINITY, |(bytes, elapsed)| {
        speed_bps(bytes, elapsed)
    })
}

/// Ladder order after probing: successful probes by throughput (ties
/// keep ladder order), failures after in ladder order.
fn order_by_probe(results: &[Option<(u64, Duration)>]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..results.len()).collect();
    order.sort_by(|&a, &b| {
        probe_score(results[b])
            .partial_cmp(&probe_score(results[a]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    order
}

// ── Progress emission ─────────────────────────────────────────────────────

/// EWMA speed tracker shared across the failover attempts of one job.
/// A mirror switch to the NEXT offset keeps the window open (the rate
/// stays continuous); any REGRESSION of the byte counter (a 200-restart,
/// a rollback, a sha-mismatch restart) re-seeds it via [`reset`] so the
/// old anchor cannot saturate every delta to zero.
struct SpeedTracker {
    last_bytes: u64,
    last_tick: Instant,
    speed: f64,
}

impl SpeedTracker {
    /// Tracker for a resumed pass: the anchor is the on-disk resume base,
    /// so the first tick's delta covers only the NEWLY fetched bytes (a
    /// zero anchor would bill the whole pre-existing prefix to the first
    /// window and paint a huge speed spike).
    fn new_seeded(anchor: u64) -> Self {
        Self {
            last_bytes: anchor,
            last_tick: Instant::now(),
            speed: 0.0,
        }
    }

    /// Re-seed after the byte counter REGRESSED (a 200-restart or a
    /// mismatch rollback): the old window's anchor would saturate every
    /// delta to zero until the counter climbs past it again.
    fn reset(&mut self) {
        self.last_bytes = 0;
        self.last_tick = Instant::now();
        self.speed = 0.0;
    }

    /// Fold the committed byte count into the EWMA (sampled at most once
    /// per [`PROGRESS_TICK`]) and return the current estimate.
    fn sample(&mut self, committed: u64) -> f64 {
        let now = Instant::now();
        let dt = now.saturating_duration_since(self.last_tick);
        if dt >= PROGRESS_TICK {
            let sample = speed_bps(committed.saturating_sub(self.last_bytes), dt);
            self.speed = ewma(self.speed, sample, SPEED_EWMA_ALPHA);
            self.last_bytes = committed;
            self.last_tick = now;
        }
        self.speed
    }
}

fn emit(
    app: Option<&AppHandle>,
    req: &DownloadRequest,
    phase_name: &str,
    received: u64,
    total: u64,
    speed_bps: f64,
    error: Option<String>,
) {
    let Some(app) = app else { return };
    let progress = DownloadProgress {
        id: req.id.clone(),
        kind: req.kind.clone(),
        phase: phase_name.to_string(),
        received: req.base_received + received,
        total: if total > 0 { req.base_total + total } else { 0 },
        speed_bps,
        detail: req.detail.clone(),
        error,
    };
    let _ = app.emit(DOWNLOAD_PROGRESS_EVENT, progress);
}

// ── The transfer engine ───────────────────────────────────────────────────

/// Run one job: optional race → ladder walk with per-attempt atomic
/// rollback → verification. The part file keeps its pre-pass length on
/// every failure path (that is the resume base of the next try).
async fn run_transfer(
    app: Option<AppHandle>,
    req: DownloadRequest,
    cancel: Arc<AtomicBool>,
) -> Result<TransferDone, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(req.cancel_msg.clone());
    }
    let client = build_http_client()?;

    if let Some(parent) = req.part.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
    }

    // Resume base: the on-disk part length when the request vouches for
    // its content (versioned name or verified sha); otherwise a fresh
    // start (a scratch part may hold a previous, different artifact).
    let mut committed = 0u64;
    if req.resume {
        committed = tokio::fs::metadata(&req.part)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
    } else if tokio::fs::try_exists(&req.part).await.unwrap_or(false) {
        truncate_part(&req.part, 0).await?;
    }
    let mut hasher = Sha256::new();
    if req.expected_sha256.is_some() && committed > 0 {
        hash_prefix(&req.part, committed, &mut hasher).await?;
    }

    let sources = match req.race_window.filter(|_| req.sources.len() > 1) {
        Some(window) => {
            race_reorder(&client, &req.sources, committed, window, app.as_ref(), &req).await
        },
        None => req.sources.clone(),
    };

    let mut tracker = SpeedTracker::new_seeded(committed);
    let mut last_err = String::from("no mirror attempted");
    for url in &sources {
        if cancel.load(Ordering::SeqCst) {
            return Err(req.cancel_msg.clone());
        }
        let attempt_start = committed;
        let hasher_snapshot = hasher.clone();
        let mut restarted = false;
        match attempt(
            &client,
            url,
            &req,
            &cancel,
            app.as_ref(),
            &mut committed,
            &mut hasher,
            &mut tracker,
            &mut restarted,
        )
        .await
        {
            Ok(()) => {
                if let Some(expected) = &req.expected_sha256 {
                    // Finalize a CLONE: a mismatch is treated as one more
                    // failed attempt (a stale mirror cache can be outrun
                    // by the next candidate), so the running hasher must
                    // survive for the retry.
                    let got = hex::encode(hasher.clone().finalize());
                    if !got.eq_ignore_ascii_case(expected) {
                        last_err = format!(
                            "sha256 mismatch (got {}, expected {expected}) — likely a truncated or corrupted mirror copy",
                            &got[..got.len().min(12)]
                        );
                        // The bytes on disk (resume prefix included) are
                        // untrustworthy: drop the whole part so the next
                        // candidate restarts from byte 0 clean.
                        let _ = tokio::fs::remove_file(&req.part).await;
                        committed = 0;
                        hasher = Sha256::new();
                        tracker.reset();
                        continue;
                    }
                }
                // Terminal download event: the only moment received may
                // equal total — the file is complete and verified.
                emit(
                    app.as_ref(),
                    &req,
                    phase::DOWNLOAD,
                    committed,
                    committed,
                    tracker.sample(committed),
                    None,
                );
                tracing::info!(id = %req.id, bytes = committed, "download complete");
                return Ok(TransferDone {
                    bytes: committed,
                    path: req.part.clone(),
                });
            },
            Err(e) if e == req.cancel_msg => {
                // A cancelled attempt keeps its bytes — they are the
                // resume base of the next try.
                return Err(e);
            },
            Err(e) => {
                // Roll the part back to a consistent pre-attempt state so
                // the next mirror appends onto clean bytes. A normal
                // failure rewinds to the attempt's start offset (the
                // resume base stays valid); an attempt that RESTARTED from
                // byte 0 (mirror ignored Range) already discarded that
                // base — rewinding to `attempt_start` would only extend
                // the file with a zero-filled hole, so it rewinds to 0
                // with a fresh hasher instead. `committed` follows the
                // file in both cases: a later ranged GET must never start
                // beyond what is actually on disk.
                let rollback_to = if restarted { 0 } else { attempt_start };
                truncate_part(&req.part, rollback_to).await?;
                hasher = if restarted {
                    Sha256::new()
                } else {
                    hasher_snapshot
                };
                committed = rollback_to;
                tracker.reset();
                last_err = e;
            },
        }
    }
    Err(format!("download {}: {last_err}", req.id))
}

/// One mirror attempt: a ranged GET from `committed`, streamed to the
/// part file (the single writer). Fails without corrupting the part —
/// the caller truncates back to the attempt's start offset on error
/// (byte 0 when this attempt reports `restarted`, see there).
#[allow(clippy::too_many_arguments)]
async fn attempt(
    client: &reqwest::Client,
    url: &str,
    req: &DownloadRequest,
    cancel: &Arc<AtomicBool>,
    app: Option<&AppHandle>,
    committed: &mut u64,
    hasher: &mut Sha256,
    tracker: &mut SpeedTracker,
    restarted: &mut bool,
) -> Result<(), String> {
    let mut request = client.get(url);
    if *committed > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={}-", *committed));
    }
    if let Some(timeout) = req.timeout {
        request = request.timeout(timeout);
    }
    let mut response = request.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();

    let mut local_restarted = false;
    let total: Option<u64> = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let header = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let (start, total) = parse_content_range(header)
            .ok_or_else(|| format!("{url}: unparseable Content-Range `{header}`"))?;
        if start != *committed {
            return Err(format!(
                "{url}: mirror resumed at byte {start}, expected {committed}"
            ));
        }
        total
    } else if status == reqwest::StatusCode::OK {
        // A plain 200 over a resume request: the mirror ignored Range —
        // the body starts at byte 0 and the part must restart clean.
        local_restarted = *committed > 0;
        response.content_length()
    } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // "Offset beyond the end of the file": a previous pass already
        // pulled the whole artifact and only the follow-up (rename /
        // install) failed. Nothing more to stream — accept the part as
        // complete. Guards: the min-bytes floor keeps error pages out,
        // and the 416's `Content-Range: bytes */<total>` (RFC SHOULD, not
        // MUST) must confirm the size — mandatory when no sha256 can
        // catch a truncated body afterwards (the app updater has none:
        // accepting a header-less 416 there could spawn a cut-off
        // installer).
        let declared = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_unsatisfiable_total);
        let size_confirmed = declared.is_some_and(|t| t == *committed);
        let sha_backstops = req.expected_sha256.is_some();
        if *committed >= req.min_bytes && (size_confirmed || (declared.is_none() && sha_backstops))
        {
            return Ok(());
        }
        return Err(format!("{url}: HTTP 416 at offset {committed}"));
    } else {
        return Err(format!("{url}: HTTP {status}"));
    };
    if let Some(max) = req.max_bytes {
        if let Some(declared) = total {
            if declared > max {
                return Err(format!(
                    "{url}: {declared} bytes exceeds the {max}-byte cap"
                ));
            }
        }
    }
    // Only a SERVER-declared size is enforced (short read / overshoot);
    // the caller's total_hint is display-only — catalog sizes can be
    // KiB-rounded, and a rounded hint must not fail an honest body.
    let server_total = total.filter(|t| *t > 0);
    let total = server_total.or(if req.total_hint > 0 {
        Some(req.total_hint)
    } else {
        None
    });

    if local_restarted {
        truncate_part(&req.part, 0).await?;
        *committed = 0;
        *hasher = Sha256::new();
        tracker.reset();
        *restarted = true;
    }

    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&req.part)
        .await
        .map_err(|e| format!("open {}: {e}", req.part.display()))?;

    let mut last_emit = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            drop(file);
            return Err(req.cancel_msg.clone());
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if let Some(max) = req.max_bytes {
                    if *committed + chunk.len() as u64 > max {
                        return Err(format!("{url}: body exceeds the {max}-byte cap"));
                    }
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("write {}: {e}", req.part.display()))?;
                if req.expected_sha256.is_some() {
                    hasher.update(&chunk);
                }
                *committed += chunk.len() as u64;
                if server_total.is_some_and(|t| *committed > t) {
                    // More bytes than the mirror declared: a mixed/garbage
                    // body — fail the attempt before it corrupts further.
                    return Err(format!("{url}: stream exceeded its declared size"));
                }
                if last_emit.elapsed() >= PROGRESS_TICK {
                    last_emit = Instant::now();
                    // While a sha256 still has to confirm the body, the
                    // tick must never claim received == total — a
                    // mismatch restart would briefly repaint the
                    // "finished, then restarted" picture this hub exists
                    // to kill. Only the terminal event (post-verify)
                    // shows the full count.
                    let shown = match (&req.expected_sha256, total) {
                        (Some(_), Some(t)) if *committed >= t => t.saturating_sub(1),
                        _ => *committed,
                    };
                    emit(
                        app,
                        req,
                        phase::DOWNLOAD,
                        shown,
                        total.unwrap_or(0),
                        tracker.sample(*committed),
                        None,
                    );
                }
            },
            Ok(None) => {
                file.flush()
                    .await
                    .map_err(|e| format!("flush {}: {e}", req.part.display()))?;
                drop(file);
                if let Some(t) = server_total.filter(|t| *committed != *t) {
                    return Err(format!("{url}: short read — {committed} of {t} bytes"));
                }
                if *committed < req.min_bytes {
                    return Err(format!(
                        "{url}: {} bytes is below the {}-byte floor — the mirror returned an error page, not the artifact",
                        *committed, req.min_bytes
                    ));
                }
                return Ok(());
            },
            Err(e) => {
                let _ = file.flush().await;
                drop(file);
                return Err(format!("{url}: {e}"));
            },
        }
    }
}

// ── Race window ───────────────────────────────────────────────────────────

/// One parallel probe: open a ranged GET and read up to
/// [`RACE_PROBE_BYTES`] or the window, whichever ends first. Returns the
/// bytes read and how long they took (the throughput proxy for
/// ordering). `None` = the source did not serve usable bytes in time.
async fn probe_source(
    client: &reqwest::Client,
    url: &str,
    offset: u64,
    window: Duration,
) -> Option<(u64, Duration)> {
    let started = Instant::now();
    let probe = async {
        let mut request = client.get(url);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let mut response = request.send().await.ok()?;
        let status = response.status();
        if status != reqwest::StatusCode::OK && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return None;
        }
        let mut read = 0u64;
        while read < RACE_PROBE_BYTES {
            match response.chunk().await {
                Ok(Some(chunk)) => read += chunk.len() as u64,
                Ok(None) => break,
                Err(_) => return None,
            }
        }
        Some(read)
    };
    let read = tokio::time::timeout(window, probe).await.ok().flatten()?;
    Some((read, started.elapsed()))
}

/// Probe every source in parallel and reorder the ladder by throughput.
/// Emits one `race` event first so the UI can render the indeterminate
/// racing state while the probes settle.
async fn race_reorder(
    client: &reqwest::Client,
    sources: &[String],
    offset: u64,
    window: Duration,
    app: Option<&AppHandle>,
    req: &DownloadRequest,
) -> Vec<String> {
    emit(app, req, phase::RACE, offset, 0, 0.0, None);
    let mut probes: futures::stream::FuturesUnordered<_> = sources
        .iter()
        .enumerate()
        .map(|(idx, url)| async move {
            let result = probe_source(client, url, offset, window).await;
            (idx, result)
        })
        .collect();
    let mut results: Vec<Option<(u64, Duration)>> = vec![None; sources.len()];
    while let Some((idx, result)) = probes.next().await {
        results[idx] = result;
    }
    order_by_probe(&results)
        .into_iter()
        .map(|i| sources[i].clone())
        .collect()
}

// ── Disk helpers ──────────────────────────────────────────────────────────

/// Cut the part file down to `len` bytes (a no-op when it already is).
async fn truncate_part(part: &Path, len: u64) -> Result<(), String> {
    let current = tokio::fs::metadata(part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if current == len {
        return Ok(());
    }
    // tokio's File lacks set_len; go through std (truncation is a cheap
    // O(1) operation on NTFS and the mobile filesystems alike).
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(part)
        .map_err(|e| format!("open {}: {e}", part.display()))?;
    file.set_len(len)
        .map_err(|e| format!("truncate {}: {e}", part.display()))?;
    Ok(())
}

/// Feed the first `len` bytes of an existing file into the hasher so a
/// resumed transfer verifies the WHOLE file, prefix included.
async fn hash_prefix(part: &Path, len: u64, hasher: &mut Sha256) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(part)
        .await
        .map_err(|e| format!("open {}: {e}", part.display()))?;
    let mut remaining = len;
    let mut buf = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let want = buf.len().min(remaining as usize);
        let read = file
            .read(&mut buf[..want])
            .await
            .map_err(|e| format!("read {}: {e}", part.display()))?;
        if read == 0 {
            return Err(format!(
                "part {} shrank while hashing its resume prefix",
                part.display()
            ));
        }
        hasher.update(&buf[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_parses_shapes() {
        assert_eq!(
            parse_content_range("bytes 100-999/1234"),
            Some((100, Some(1234)))
        );
        assert_eq!(parse_content_range("bytes 0-99/*"), Some((0, None)));
        assert_eq!(parse_content_range(" bytes 5-9/10 "), Some((5, Some(10))));
        assert_eq!(parse_content_range("bytes 10-5/20"), None, "end < start");
        assert_eq!(parse_content_range("bytes abc-9/20"), None);
        assert_eq!(parse_content_range("items 1-2/3"), None);
        assert_eq!(parse_content_range(""), None);
    }

    #[test]
    fn probe_order_ranks_throughput_then_keeps_failures_last() {
        let a = Duration::from_secs(2);
        let b = Duration::from_secs(1);
        // Fastest probe first, ties keep ladder order.
        assert_eq!(
            order_by_probe(&[Some((10, a)), Some((10, b)), None]),
            vec![1, 0, 2]
        );
        assert_eq!(order_by_probe(&[None, None]), vec![0, 1]);
        // Equal throughput → ladder order.
        assert_eq!(order_by_probe(&[Some((5, a)), Some((5, a))]), vec![0, 1]);
        // More bytes in the same window wins.
        assert_eq!(
            order_by_probe(&[Some((100, a)), Some((900, a))]),
            vec![1, 0]
        );
    }

    #[test]
    fn speed_bps_divides_bytes_by_seconds() {
        assert!((speed_bps(1_500, Duration::from_millis(500)) - 3_000.0).abs() < f64::EPSILON);
        assert_eq!(speed_bps(0, Duration::from_secs(1)), 0.0);
        assert_eq!(speed_bps(100, Duration::ZERO), 0.0, "zero window, no inf");
    }

    #[test]
    fn ewma_seeded_at_zero_climbs_without_overshooting() {
        let mut estimate = 0.0;
        for _ in 0..30 {
            let next = ewma(estimate, 100.0, SPEED_EWMA_ALPHA);
            assert!(next >= estimate, "EWMA must be monotonic while climbing");
            assert!(next <= 100.0, "EWMA must not overshoot the sample");
            estimate = next;
        }
        assert!((estimate - 100.0).abs() < 0.01, "converges to the sample");
        assert!((ewma(0.0, 100.0, 0.3) - 30.0).abs() < 1e-9);
        assert!((ewma(50.0, 80.0, 1.0) - 80.0).abs() < 1e-9);
    }

    #[test]
    fn request_defaults_are_conservative() {
        let req = DownloadRequest::new(
            wowsp_tauri_shared::download::kind::UPDATE,
            wowsp_tauri_shared::download::kind::UPDATE,
            vec!["https://example.invalid/a.exe".into()],
            PathBuf::from("a.part"),
        );
        assert!(
            !req.resume,
            "resume is opt-in — scratch names restart clean"
        );
        assert_eq!(req.min_bytes, 0);
        assert_eq!(req.cancel_msg, "download cancelled");
        assert!(req.race_window.is_none());
    }
}
