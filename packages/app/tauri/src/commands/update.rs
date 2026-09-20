//! Shun-config-driven auto-update with a mirror-race download engine.
//!
//! The update-watch config (`[package.metadata.shun.update]`) is embedded at
//! build time (see `build.rs`) — the same table drives the installer shell's
//! delivery pipeline. Every mirror source is probed **in parallel** through
//! the proxy-aware client (10 s cap each): resolution follows the source's
//! `releases/latest` redirect and reads the version straight out of the
//! final tag URL (`…/releases/tag/v0.3.0` → `0.3.0`), so the published tag
//! IS the version truth — nothing has to be uploaded alongside a release
//! for clients to notice it. The legacy `latest` marker file stays as a
//! compatibility fallback for mirrors that serve the download mount but
//! mangle the tag-page redirect. The first source to resolve a version wins
//! the resolution ([`resolve_latest`], used by `update_check`).
//!
//! `update_download` goes further: every source that resolved the version
//! enters a parallel **artifact race** — one streaming task per mirror, each
//! writing its own `.part` file. After a 10 s race window the leader (most
//! bytes) keeps its connection while the losers are cancelled; if the leader
//! then dies, a runner-up is resumed from its part-file offset via a Range
//! request (no Range support → restart from byte 0). The winner's part file
//! becomes `WoWSP-update-<version>-<pid>.exe`, spawned detached with
//! `--silent --dir=<install dir>` — the artifact names
//! `scripts/build_installers.py` produces are `WoWSP_<version>_x64-installer.exe`
//! (full) / `WoWSP_<version>_x64-installer-lite.exe` (lite installs; see
//! `artifact_url`) under each mirror base.
//! The hardened installer kills the running app and installs over its
//! directory, so the frontend treats the command's promise never resolving
//! (app death) or resolving (installer spawned) as success by design; the
//! only visible failure modes are `Err` strings (`"update cancelled"` maps
//! to a clean frontend reset).
//!
//! Progress flows to the webui as `update-progress` events:
//! `{ phase: "race", sources_alive }` while probes settle, then
//! `{ phase: "race" | "download", percent, speed_bps }` while the artifact
//! streams (speed is an EWMA over 500 ms ticks), and finally
//! `{ phase: "install", percent: 100 }` right before the spawn.

use futures::StreamExt;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

use crate::commands::network::build_http_client;

/// Update-watch table embedded by `build.rs` from
/// `[package.metadata.shun.update]` in this crate's Cargo.toml.
const SHUN_UPDATE_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-update.json"));

/// The running app's version, embedded by `build.rs` from
/// `CARGO_PKG_VERSION` (the workspace version).
const APP_VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/app-version.txt"));

/// Set while an update download is in flight: double triggers (auto banner +
/// manual button) collapse into the first pass instead of racing the same
/// temp artifact.
static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Set by [`update_cancel`] (the banner's 取消 button): every streaming
/// loop checks it per chunk and tears the pass down, deleting all part
/// files. Reset at the start of each attempt.
static UPDATE_CANCEL: AtomicBool = AtomicBool::new(false);

/// An installer is hundreds of MB; anything smaller is a mirror error page.
const MIN_INSTALLER_BYTES: u64 = 1_000_000;

/// Per-source cap on the version probe: a slow or dead mirror simply times
/// out instead of stalling the race.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the parallel artifact race runs before the leader (most bytes)
/// is picked and the losers are cancelled.
const RACE_WINDOW: Duration = Duration::from_secs(10);

/// Progress-event cadence: percent ticks and the EWMA speed sample both run
/// on this clock so the webview isn't flooded per chunk.
const PROGRESS_TICK: Duration = Duration::from_millis(500);

/// How long a cancelled racer gets to flush + close its part file before it
/// is hard-aborted.
const FLUSH_GRACE: Duration = Duration::from_secs(2);

/// Smoothing factor for the displayed download speed (EWMA over the per-tick
/// bytes/sec samples).
const SPEED_EWMA_ALPHA: f64 = 0.3;

/// The frontend maps this exact error to a clean reset (banner back to the
/// idle prompt, update still available).
const CANCEL_MSG: &str = "update cancelled";

/// The installer artifact URL under a mirror base — the exact name
/// `scripts/build_installers.py::emit` produces. A lite install (no bundled
/// model pack) updates with the `-lite` artifact so a slim install never
/// silently balloons to the full payload; the flavor is staged by the
/// installer as `wowsp-flavor.txt` beside the app exe. Dev/unmarked builds
/// use the suffix-less full artifact.
fn artifact_url(base: &str, version: &str) -> String {
    artifact_url_for_flavor(base, version, &app_flavor())
}

/// `artifact_url` with an explicit flavor — the pure, testable core.
fn artifact_url_for_flavor(base: &str, version: &str, flavor: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let suffix = if flavor == "lite" { "-lite" } else { "" };
    format!("{base}/WoWSP_{version}_x64-installer{suffix}.exe")
}

/// The install flavor marker staged by the installer shell next to the app
/// (`wowsp-flavor.txt`, values like `full` / `full-webview2` / `lite`).
/// Empty when absent (plain cargo build / older installers).
fn app_flavor() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("wowsp-flavor.txt")))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The parsed update-watch config (mirrors `shun::config::UpdateWatchConfig`;
/// re-declared locally so the JSON shape stays explicit at the use site).
#[derive(Debug, serde::Deserialize)]
struct WatchConfig {
    sources: Vec<String>,
    files: Vec<String>,
}

fn watch_config() -> Result<WatchConfig, String> {
    serde_json::from_str::<WatchConfig>(SHUN_UPDATE_JSON)
        .map_err(|e| format!("embedded shun-update.json: {e}"))
}

// ── Pure helpers (unit-tested below, no network) ─────────────────────────

/// Index of the largest byte count; ties go to the first slot (marker
/// arrival order), an empty slice has no leader.
fn pick_leader(bytes: &[u64]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, b) in bytes.iter().enumerate() {
        match best {
            Some(j) if bytes[j] >= *b => {},
            _ => best = Some(i),
        }
    }
    best
}

/// Instantaneous speed in bytes/sec over the elapsed window; a zero window
/// yields 0 instead of infinity.
fn speed_bps(delta: u64, elapsed: Duration) -> f64 {
    if elapsed.is_zero() {
        0.0
    } else {
        delta as f64 / elapsed.as_secs_f64()
    }
}

/// Exponential moving average: `prev + alpha * (sample - prev)`. Seeded at
/// 0 the estimate climbs toward a steady sample without ever overshooting.
fn ewma(prev: f64, sample: f64, alpha: f64) -> f64 {
    prev + alpha * (sample - prev)
}

// ── Source race (resolution) ─────────────────────────────────────────────

/// The `releases/latest` page URL for a source. Sources point at the
/// download mount (`…/releases/latest/download`); stripping the suffix
/// lands on the redirecting page whose final URL names the latest release
/// tag — version truth that needs no separately-uploaded marker file.
/// A source without the suffix is used as-is (its tag probe then simply
/// fails and the marker fallback takes over).
fn tag_url_from_source(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    match trimmed.strip_suffix("/download") {
        Some(page) => page.to_string(),
        None => trimmed.to_string(),
    }
}

/// The bare version carried by a post-redirect release URL:
/// `…/releases/tag/v0.3.0?x=1` → `0.3.0`. `None` when the URL never landed
/// on a tag page (proxy followed internally, error page, …).
fn version_from_redirect(url: &str) -> Option<String> {
    let (path, _) = url.split_once(['?', '#']).unwrap_or((url, ""));
    let tag = path.rsplit_once("/tag/")?.1;
    let tag = tag.trim_end_matches('/').trim();
    let version = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    (!version.is_empty()).then(|| version.to_string())
}

/// GET `{base}/{marker}` and return the trimmed body — the candidate
/// version. 200 + non-empty text makes the source reachable.
async fn probe_marker(
    client: &reqwest::Client,
    base: &str,
    marker: &str,
) -> Result<String, String> {
    let url = format!("{}/{}", base.trim().trim_end_matches('/'), marker);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("probe {url}: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "probe {url}: unexpected status {}",
            response.status()
        ));
    }
    let version = response
        .text()
        .await
        .map_err(|e| format!("probe {url}: {e}"))?
        .trim()
        .to_string();
    if version.is_empty() {
        return Err(format!("`latest` marker at {url} is empty"));
    }
    Ok(version)
}

/// Resolve the latest version by following the source's `releases/latest`
/// redirect and reading the tag out of the final URL. The body is never
/// read — the redirected URL is the payload, then the connection drops.
async fn probe_tag(client: &reqwest::Client, base: &str) -> Result<String, String> {
    let url = tag_url_from_source(base);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("probe {url}: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "probe {url}: unexpected status {}",
            response.status()
        ));
    }
    let final_url = response.url().to_string();
    drop(response);
    version_from_redirect(&final_url)
        .ok_or_else(|| format!("probe {url}: redirect landed on a non-tag URL: {final_url}"))
}

/// Resolve the latest version from one source. The tag redirect is the
/// primary mechanism — it needs nothing but the release itself, so a
/// forgotten marker file can never hide a published release. The legacy
/// `latest` marker file stays as the compatibility fallback for mirrors
/// that proxy the download mount but mangle the tag-page redirect.
async fn probe_source(
    client: &reqwest::Client,
    base: &str,
    marker: &str,
) -> Result<String, String> {
    match probe_tag(client, base).await {
        Ok(version) => Ok(version),
        Err(tag_err) => probe_marker(client, base, marker)
            .await
            .map_err(|marker_err| format!("tag probe: {tag_err}; marker probe: {marker_err}")),
    }
}

/// One mirror that resolved the latest version. `index` is the position in
/// the configured sources list (used for the part-file name).
struct SourceCandidate {
    index: usize,
    base: String,
    version: String,
}

/// Probe every source concurrently, each capped at [`PROBE_TIMEOUT`]. With
/// `collect_all` the pass waits for every probe (bounded by the cap) so all
/// reachable mirrors can enter the artifact race; without it the first
/// resolution wins and the remaining probes are cancelled by drop. Either
/// way `candidates` is in resolution-arrival order — the first entry is the
/// winner. Emits `{ phase: "race", sources_alive }` as probes settle when a
/// window is given (the download flow), so the webui can render the racing
/// state.
async fn race_sources(
    client: &reqwest::Client,
    sources: &[String],
    marker: &str,
    window: Option<&tauri::WebviewWindow>,
    collect_all: bool,
) -> Result<Vec<SourceCandidate>, String> {
    let mut probes: futures::stream::FuturesUnordered<_> = sources
        .iter()
        .enumerate()
        .map(|(index, base)| async move {
            let probe = tokio::time::timeout(PROBE_TIMEOUT, probe_source(client, base, marker))
                .await
                .map_err(|_| format!("probe {base}: timed out after {}s", PROBE_TIMEOUT.as_secs()));
            (index, base.clone(), probe)
        })
        .collect();

    let mut alive = sources.len();
    let mut candidates: Vec<SourceCandidate> = Vec::new();
    while let Some((index, base, probe)) = probes.next().await {
        alive = alive.saturating_sub(1);
        if let Some(window) = window {
            let _ = window.emit(
                "update-progress",
                serde_json::json!({ "phase": "race", "sources_alive": alive }),
            );
        }
        if let Ok(Ok(version)) = probe {
            candidates.push(SourceCandidate {
                index,
                base,
                version,
            });
            if !collect_all {
                break;
            }
        }
    }
    drop(probes); // cancels still-pending probes at their await points

    if candidates.is_empty() {
        return Err("no update source reachable".to_string());
    }
    Ok(candidates)
}

/// Resolves the fastest mirror (first version resolution to arrive),
/// returning the latest version plus the installer artifact URL under the
/// winning source.
async fn resolve_latest() -> Result<(String, String), String> {
    let watch = watch_config()?;
    let marker = watch
        .files
        .first()
        .ok_or_else(|| "no marker file declared in the update sources".to_string())?;
    let client = build_http_client()?;
    let candidates = race_sources(&client, &watch.sources, marker, None, false).await?;
    let winner = &candidates[0];
    Ok((
        winner.version.clone(),
        artifact_url(&winner.base, &winner.version),
    ))
}

// ── Version comparison ───────────────────────────────────────────────────

/// Segment-wise version comparison: split on `.`, parse each segment as u64
/// (non-numeric counts as 0), zero-pad the shorter side; strictly greater
/// wins. `0.1` equals `0.1.0`; `0.1` beats `0.0.9`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|seg| seg.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let mut candidate = parse(candidate);
    let mut current = parse(current);
    let len = candidate.len().max(current.len());
    candidate.resize(len, 0);
    current.resize(len, 0);
    candidate > current
}

/// Version-check answer for the webui updater store.
#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub available: bool,
    pub version: Option<String>,
}

/// Check the mirrors for a version newer than the running build. Errors are
/// returned as `Err` — the webui store surfaces them silently (AboutModal
/// only); the startup auto-check must never nag the user.
#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    let (version, _artifact_url) = resolve_latest().await?;
    let available = is_newer(&version, APP_VERSION);
    Ok(UpdateInfo {
        current: APP_VERSION.to_string(),
        available,
        version: available.then_some(version),
    })
}

// ── Artifact race (download) ─────────────────────────────────────────────

/// Shared per-race counters: byte counts per racer slot plus lifecycle
/// flags, written by the racer tasks and polled by the orchestrator.
struct RaceState {
    total: Option<u64>,
    bytes: Vec<u64>,
    finished: Vec<bool>,
    failed: Vec<bool>,
}

impl RaceState {
    fn new(slots: usize) -> Self {
        Self {
            total: None,
            bytes: vec![0; slots],
            finished: vec![false; slots],
            failed: vec![false; slots],
        }
    }
}

type SharedState = Arc<Mutex<RaceState>>;

/// Point-in-time copy for the orchestrator's tick loops — no locks are held
/// across awaits.
struct RaceSnapshot {
    total: Option<u64>,
    bytes: Vec<u64>,
    finished: Vec<bool>,
    failed: Vec<bool>,
}

fn snapshot(state: &SharedState) -> RaceSnapshot {
    let s = state.lock().expect("race state mutex poisoned");
    RaceSnapshot {
        total: s.total,
        bytes: s.bytes.clone(),
        finished: s.finished.clone(),
        failed: s.failed.clone(),
    }
}

impl RaceSnapshot {
    /// Byte counts with dead racers zeroed out — leader picks and progress
    /// percentages only count racers that can still finish the file.
    fn alive_bytes(&self) -> Vec<u64> {
        self.bytes
            .iter()
            .zip(&self.failed)
            .map(|(b, f)| if *f { 0 } else { *b })
            .collect()
    }

    /// How many racers already settled (finished or failed).
    fn settled(&self) -> usize {
        self.finished
            .iter()
            .chain(self.failed.iter())
            .filter(|f| **f)
            .count()
    }
}

/// EWMA speed tracker + throttled percent/speed payloads for the download
/// loops. Call [`ProgressTracker::payload`] at most once per tick.
struct ProgressTracker {
    last_bytes: u64,
    last_tick: Instant,
    speed: f64,
}

impl ProgressTracker {
    fn new() -> Self {
        Self {
            last_bytes: 0,
            last_tick: Instant::now(),
            speed: 0.0,
        }
    }

    /// Fold the leader's current byte count into the EWMA and build the
    /// `update-progress` payload (percent clamped to 0-100; 0 while the
    /// total size is unknown).
    fn payload(&mut self, leader_bytes: u64, total: Option<u64>, phase: &str) -> serde_json::Value {
        let now = Instant::now();
        let dt = now.saturating_duration_since(self.last_tick);
        if dt >= PROGRESS_TICK {
            let sample = speed_bps(leader_bytes.saturating_sub(self.last_bytes), dt);
            self.speed = ewma(self.speed, sample, SPEED_EWMA_ALPHA);
            self.last_bytes = leader_bytes;
            self.last_tick = now;
        }
        let percent = total.filter(|t| *t > 0).map_or(0.0, |t| {
            (leader_bytes as f64 / t as f64 * 100.0).clamp(0.0, 100.0)
        });
        serde_json::json!({ "phase": phase, "percent": percent, "speed_bps": self.speed })
    }
}

/// Emit one progress event from a snapshot: during the race window the
/// phase is `"race"` (the webui shows the indeterminate racing strip), after
/// it `"download"`.
fn emit_progress(
    window: &tauri::WebviewWindow,
    tracker: &mut ProgressTracker,
    snap: &RaceSnapshot,
    racing: bool,
) {
    let leader_bytes = snap.alive_bytes().into_iter().max().unwrap_or(0);
    let phase = if racing { "race" } else { "download" };
    let payload = tracker.payload(leader_bytes, snap.total, phase);
    let _ = window.emit("update-progress", payload);
}

/// One streaming racer: download `url` into its own part file, reporting
/// bytes into [`RaceState`]. Exits early (flushing + closing the part file)
/// when its race-loser flag or the global user-cancel flag is set.
async fn run_racer(
    client: reqwest::Client,
    url: String,
    part_path: std::path::PathBuf,
    slot: usize,
    state: SharedState,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            if let Ok(mut s) = state.lock() {
                s.failed[slot] = true;
            }
            return Err(format!("fetch {url}: {e}"));
        },
    };
    if response.status() != reqwest::StatusCode::OK {
        if let Ok(mut s) = state.lock() {
            s.failed[slot] = true;
        }
        return Err(format!(
            "fetch {url}: unexpected status {}",
            response.status()
        ));
    }
    if let Ok(mut s) = state.lock() {
        // All sources must agree on the size; the first report wins.
        if let Some(len) = response.content_length() {
            if s.total.is_none_or(|t| t == 0) {
                s.total = Some(len);
            }
        }
    }
    let mut file = match tokio::fs::File::create(&part_path).await {
        Ok(f) => f,
        Err(e) => {
            if let Ok(mut s) = state.lock() {
                s.failed[slot] = true;
            }
            return Err(format!("create {}: {e}", part_path.display()));
        },
    };

    let mut downloaded: u64 = 0;
    loop {
        // Per-chunk cancellation: race loser (own flag) or user cancel.
        if cancel.load(Ordering::SeqCst) || UPDATE_CANCEL.load(Ordering::SeqCst) {
            break;
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    if let Ok(mut s) = state.lock() {
                        s.failed[slot] = true;
                    }
                    return Err(format!("write {}: {e}", part_path.display()));
                }
                downloaded += chunk.len() as u64;
                if let Ok(mut s) = state.lock() {
                    s.bytes[slot] = downloaded;
                }
            },
            Ok(None) => {
                let _ = file.flush().await;
                drop(file);
                if let Ok(mut s) = state.lock() {
                    s.finished[slot] = true;
                }
                return Ok(());
            },
            Err(e) => {
                let _ = file.flush().await;
                if let Ok(mut s) = state.lock() {
                    s.failed[slot] = true;
                }
                return Err(format!("download {url}: {e}"));
            },
        }
    }
    // Cancelled: flush + close so the orchestrator can delete the part file
    // or resume from its on-disk length.
    let _ = file.flush().await;
    drop(file);
    Ok(())
}

/// Tear racers down: signal first (lets a mid-write chunk flush), then
/// hard-abort any straggler so nothing outlives the pass.
async fn stop_racers(racers: &mut [RacerHandle]) {
    for rh in racers.iter() {
        rh.cancel.store(true, Ordering::SeqCst);
    }
    for rh in racers.iter_mut() {
        if tokio::time::timeout(FLUSH_GRACE, &mut rh.handle)
            .await
            .is_err()
        {
            rh.handle.abort();
        }
    }
}

struct RacerHandle {
    slot: usize,
    cancel: Arc<AtomicBool>,
    handle: tokio::task::JoinHandle<Result<(), String>>,
}

/// Sequential fallback: resume `part_path` from its on-disk length via a
/// Range request (a plain 200 means the mirror ignored Range → restart from
/// byte 0), streaming with per-chunk user-cancel checks and progress events.
async fn resume_or_download(
    client: &reqwest::Client,
    url: &str,
    part_path: &std::path::Path,
    slot: usize,
    state: &SharedState,
    window: &tauri::WebviewWindow,
    tracker: &mut ProgressTracker,
) -> Result<(), String> {
    if UPDATE_CANCEL.load(Ordering::SeqCst) {
        return Err(CANCEL_MSG.to_string());
    }
    let total = snapshot(state).total;
    let mut offset = tokio::fs::metadata(part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if total.is_some_and(|t| t > 0 && offset >= t) {
        // This runner-up finished right as the race closed — nothing to fetch.
        if let Ok(mut s) = state.lock() {
            s.finished[slot] = true;
        }
        return Ok(());
    }

    let mut response = if offset > 0 {
        client
            .get(url)
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .send()
            .await
            .map_err(|e| format!("fetch {url}: {e}"))?
    } else {
        client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("fetch {url}: {e}"))?
    };
    let ranged = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if response.status() != reqwest::StatusCode::OK && !ranged {
        return Err(format!(
            "fetch {url}: unexpected status {}",
            response.status()
        ));
    }
    if offset > 0 && !ranged {
        // Mirror ignored the Range header (plain 200) → restart from byte 0.
        offset = 0;
    }
    let mut file = if offset > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(part_path)
            .await
    } else {
        tokio::fs::File::create(part_path).await
    }
    .map_err(|e| format!("open {}: {e}", part_path.display()))?;

    let mut downloaded = offset;
    let mut last_emit = Instant::now();
    loop {
        if UPDATE_CANCEL.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            drop(file);
            if let Ok(mut s) = state.lock() {
                s.failed[slot] = true;
            }
            return Err(CANCEL_MSG.to_string());
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("write {}: {e}", part_path.display()))?;
                downloaded += chunk.len() as u64;
                if let Ok(mut s) = state.lock() {
                    s.bytes[slot] = downloaded;
                }
                if last_emit.elapsed() >= PROGRESS_TICK {
                    last_emit = Instant::now();
                    let payload = tracker.payload(downloaded, total, "download");
                    let _ = window.emit("update-progress", payload);
                }
            },
            Ok(None) => {
                file.flush()
                    .await
                    .map_err(|e| format!("write {}: {e}", part_path.display()))?;
                drop(file);
                if let Ok(mut s) = state.lock() {
                    s.finished[slot] = true;
                }
                return Ok(());
            },
            Err(e) => {
                let _ = file.flush().await;
                if let Ok(mut s) = state.lock() {
                    s.failed[slot] = true;
                }
                return Err(format!("download {url}: {e}"));
            },
        }
    }
}

/// Best-effort removal of this attempt's `.part` files (all of them, or all
/// but one). Files still open on Windows fail to delete and are left for
/// the OS temp dir to reclaim.
async fn cleanup_part_files(version: &str, keep: Option<&std::path::Path>) {
    let prefix = format!("WoWSP-update-{version}-{}-", std::process::id());
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.starts_with(&prefix) && name.ends_with(".part") && Some(path.as_path()) != keep {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Download the new installer and hand it to the OS. All mirrors that
/// returned the marker race in parallel (10 s window); the fastest keeps
/// streaming while the rest are cancelled. Emits `update-progress` events
/// (`race` → `download` phases with percent + speed) while streaming and
/// one final `{ phase: "install", percent: 100 }` right before the
/// installer is spawned; returns after that spawn — the hardened installer
/// then kills this app, installs over its directory and relaunches the new
/// build, so the webui treats the unresolved promise / app exit as success
/// by design.
#[tauri::command]
pub async fn update_download(window: tauri::WebviewWindow) -> Result<(), String> {
    // Collapse double triggers (banner + About button) into one pass.
    if UPDATE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = update_download_inner(&window).await;
    UPDATE_IN_FLIGHT.store(false, Ordering::SeqCst);
    result
}

async fn update_download_inner(window: &tauri::WebviewWindow) -> Result<(), String> {
    // A fresh attempt starts with a clean cancel flag (the previous pass
    // may have been cancelled by the user).
    UPDATE_CANCEL.store(false, Ordering::SeqCst);

    // ── Phase 1: mirror resolution race ────────────────────────────────
    // Every source is probed in parallel with a 10 s cap each; all that
    // resolve the latest version (in arrival order) enter the artifact race.
    let watch = watch_config()?;
    let marker = watch
        .files
        .first()
        .ok_or_else(|| "no marker file declared in the update sources".to_string())?;
    let client = build_http_client()?;
    let candidates = race_sources(&client, &watch.sources, marker, Some(window), true).await?;
    // Stale-mirror guard: a mirror still serving an older release would
    // fetch a different artifact file — only sources agreeing with the
    // winner stay in the race.
    let version = candidates[0].version.clone();
    let racers: Vec<&SourceCandidate> =
        candidates.iter().filter(|c| c.version == version).collect();

    // PID-suffixed temp names: two app instances must not race one file.
    let temp = std::env::temp_dir();
    let pid = std::process::id();
    let part_path = |source_index: usize| {
        temp.join(format!("WoWSP-update-{version}-{pid}-{source_index}.part"))
    };
    let installer_path = temp.join(format!("WoWSP-update-{version}-{pid}.exe"));

    // ── Phase 2: artifact race ──────────────────────────────────────────
    // One streaming task per source, each into its own part file, sharing
    // byte counters through RaceState.
    let slot_count = racers.len();
    let state: SharedState = Arc::new(Mutex::new(RaceState::new(slot_count)));
    let mut racer_handles: Vec<RacerHandle> = Vec::with_capacity(slot_count);
    for (slot, racer) in racers.iter().enumerate() {
        let cancel = Arc::new(AtomicBool::new(false));
        let handle = tokio::spawn(run_racer(
            client.clone(),
            artifact_url(&racer.base, &version),
            part_path(racer.index),
            slot,
            Arc::clone(&state),
            Arc::clone(&cancel),
        ));
        racer_handles.push(RacerHandle {
            slot,
            cancel,
            handle,
        });
    }

    let mut tracker = ProgressTracker::new();
    let start = Instant::now();
    let leader_slot = loop {
        tokio::time::sleep(PROGRESS_TICK).await;
        if UPDATE_CANCEL.load(Ordering::SeqCst) {
            stop_racers(&mut racer_handles).await;
            cleanup_part_files(&version, None).await;
            return Err(CANCEL_MSG.to_string());
        }
        let snap = snapshot(&state);
        // A racer that already completed the whole file ends the window now.
        if let Some(slot) = snap.finished.iter().position(|f| *f) {
            break slot;
        }
        let racing = start.elapsed() < RACE_WINDOW;
        emit_progress(window, &mut tracker, &snap, racing);
        if !racing || snap.settled() == slot_count {
            // Window closed (or every racer died early): most bytes wins
            // among the racers that are still alive; ties go to the first.
            match pick_leader(&snap.alive_bytes()) {
                Some(slot) => break slot,
                None => {
                    stop_racers(&mut racer_handles).await;
                    cleanup_part_files(&version, None).await;
                    return Err("all update sources failed during download".to_string());
                },
            }
        }
    };

    // Cancel the losers; the leader's connection keeps going.
    let mut losers: Vec<RacerHandle> = Vec::new();
    let mut leader_handle = None;
    for rh in racer_handles {
        if rh.slot == leader_slot {
            leader_handle = Some(rh.handle);
        } else {
            rh.cancel.store(true, Ordering::SeqCst);
            losers.push(rh);
        }
    }
    let leader_handle = leader_handle.expect("leader slot maps to a spawned racer");

    // ── Phase 3: leader continuation ────────────────────────────────────
    // If the leader hasn't finished within the window it keeps streaming
    // with the losers cancelled; progress events keep flowing (now in the
    // "download" phase) and a user cancel tears everything down.
    loop {
        let snap = snapshot(&state);
        if snap.finished[leader_slot] || snap.failed[leader_slot] {
            break;
        }
        if UPDATE_CANCEL.load(Ordering::SeqCst) {
            leader_handle.abort();
            for rh in &losers {
                rh.handle.abort();
            }
            cleanup_part_files(&version, None).await;
            return Err(CANCEL_MSG.to_string());
        }
        emit_progress(window, &mut tracker, &snap, false);
        tokio::time::sleep(PROGRESS_TICK).await;
    }

    let leader_ok = match leader_handle.await {
        Ok(Ok(())) => snapshot(&state).finished[leader_slot],
        _ => false,
    };
    let mut winning_slot = leader_slot;
    if !leader_ok {
        // The leader died mid-stream: walk the runner-ups in marker-arrival
        // order, each resumed from its part-file offset via a Range request
        // (no Range support → restart from byte 0 on that source).
        let mut recovered: Option<usize> = None;
        let mut cancelled = false;
        for (slot, racer) in racers.iter().enumerate().take(slot_count) {
            if slot == leader_slot {
                continue;
            }
            match resume_or_download(
                &client,
                &artifact_url(&racer.base, &version),
                &part_path(racer.index),
                slot,
                &state,
                window,
                &mut tracker,
            )
            .await
            {
                Ok(()) => {
                    recovered = Some(slot);
                    break;
                },
                Err(msg) if msg == CANCEL_MSG => {
                    cancelled = true;
                    break;
                },
                Err(_) => continue,
            }
        }
        match recovered {
            Some(slot) => winning_slot = slot,
            None => {
                for rh in &losers {
                    rh.handle.abort();
                }
                cleanup_part_files(&version, None).await;
                return Err(if cancelled {
                    CANCEL_MSG.to_string()
                } else {
                    "all update sources failed during download".to_string()
                });
            },
        }
    }

    // ── Assemble ────────────────────────────────────────────────────────
    // Give the cancelled losers a moment to flush + close their part files,
    // then hard-abort stragglers: no file handle may be open across the
    // installer spawn (Windows os error 32).
    for mut rh in losers {
        if tokio::time::timeout(FLUSH_GRACE, &mut rh.handle)
            .await
            .is_err()
        {
            rh.handle.abort();
        }
    }
    let winning_part = part_path(racers[winning_slot].index);
    let size = tokio::fs::metadata(&winning_part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if size <= MIN_INSTALLER_BYTES {
        cleanup_part_files(&version, None).await;
        return Err(format!(
            "downloaded installer is only {size} bytes — the mirror returned an error page, not the {version} artifact"
        ));
    }
    // The winner's part file becomes the installer. Retry briefly: a
    // racer's tokio-side file close can land just after its task returns.
    let mut renamed = tokio::fs::rename(&winning_part, &installer_path).await;
    for _ in 0..3 {
        if renamed.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        renamed = tokio::fs::rename(&winning_part, &installer_path).await;
    }
    renamed.map_err(|e| format!("assemble {}: {e}", installer_path.display()))?;
    cleanup_part_files(&version, None).await;

    let _ = window.emit(
        "update-progress",
        serde_json::json!({ "phase": "download", "percent": 100.0 }),
    );

    // Install over the directory the running exe lives in; the hardened
    // installer takes it from here — it kills this app, extracts, leaves
    // every launcher untouched (they point at the same exe) and relaunches
    // the new build. No shortcut flags ride along: updates never touch
    // shortcuts.
    let install_dir = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .parent()
        .ok_or_else(|| "current exe has no parent directory".to_string())?
        .to_path_buf();
    // Tell the webui the install phase started even though the spawned
    // installer may kill this app before the command's promise settles.
    let _ = window.emit(
        "update-progress",
        serde_json::json!({ "phase": "install", "percent": 100 }),
    );
    std::process::Command::new(&installer_path)
        .args(["--silent", &format!("--dir={}", install_dir.display())])
        .spawn()
        .map_err(|e| format!("spawn installer {}: {e}", installer_path.display()))?;

    Ok(())
}

/// The banner's 取消 button: flag the in-flight pass so every streaming
/// loop tears it down on the next chunk boundary (part files deleted,
/// `Err("update cancelled")` returned — the frontend maps that to a clean
/// reset with the update still available). A no-op between passes.
#[tauri::command]
pub fn update_cancel() -> Result<(), String> {
    UPDATE_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_patch_is_detected() {
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.1"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1", "0.1.0"));
        assert!(!is_newer("0.1.0.0", "0.1"));
    }

    #[test]
    fn shorter_version_zero_pads() {
        // 0.1 vs 0.0.9: 0 == 0, 1 > 0 → newer.
        assert!(is_newer("0.1", "0.0.9"));
        assert!(!is_newer("0.0", "0.0.9"));
    }

    #[test]
    fn non_numeric_segments_count_as_zero() {
        assert!(is_newer("0.2.0-beta", "0.1.9")); // 0.2.0 > 0.1.9
        assert!(!is_newer("0.1.0-rc", "0.1")); // 0.1.0 == 0.1.0 ("rc" → 0)
        // Tags after a second dot just segment further ("0.1.0-rc.1" →
        // 0.1.0.1, newer than 0.1.0.0). The `latest` marker only ever
        // carries plain release tags, so no semver-prerelease ordering is
        // attempted here — the simple rule is the design.
        assert!(is_newer("0.1.0-rc.1", "0.1"));
        assert!(!is_newer("abc", "0.0.1")); // 0.0.0 < 0.0.1
    }

    #[test]
    fn major_bump_wins_over_patch() {
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn embedded_config_has_latest_marker_and_sources() {
        let watch = watch_config().expect("embedded config parses");
        assert!(!watch.sources.is_empty(), "at least one mirror source");
        assert!(watch.sources.iter().all(|s| s.starts_with("https://")));
        assert_eq!(watch.files, vec!["latest".to_string()]);
    }

    #[test]
    fn app_version_is_a_clean_semver() {
        assert_eq!(APP_VERSION.trim(), APP_VERSION, "no stray whitespace");
        assert!(
            APP_VERSION.split('.').count() >= 2,
            "version carries at least major.minor: {APP_VERSION}"
        );
    }

    #[test]
    fn artifact_url_matches_build_script_emission() {
        // Unmarked (dev / full) installs fetch the suffix-less artifact.
        assert_eq!(
            artifact_url_for_flavor(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.1.0",
                ""
            ),
            "https://github.com/langyo/wowsp/releases/latest/download/WoWSP_0.1.0_x64-installer.exe"
        );
        // Lite installs fetch the -lite artifact their installer shipped as.
        assert_eq!(
            artifact_url_for_flavor(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.1.0",
                "lite"
            ),
            "https://github.com/langyo/wowsp/releases/latest/download/WoWSP_0.1.0_x64-installer-lite.exe"
        );
        // Trailing slashes and stray whitespace on a mirror base are trimmed.
        assert_eq!(
            artifact_url_for_flavor("https://mirror.example.test/files/", "1.2.3", ""),
            "https://mirror.example.test/files/WoWSP_1.2.3_x64-installer.exe"
        );
    }

    #[test]
    fn pick_leader_selects_the_max_first_on_ties() {
        assert_eq!(pick_leader(&[]), None, "empty race has no leader");
        assert_eq!(pick_leader(&[7]), Some(0));
        assert_eq!(pick_leader(&[1, 3, 2]), Some(1));
        assert_eq!(pick_leader(&[5, 5, 4]), Some(0), "ties go to the first");
        assert_eq!(pick_leader(&[0, 9, 9]), Some(1));
        assert_eq!(pick_leader(&[0, 0, 0]), Some(0));
    }

    #[test]
    fn tag_url_strips_the_download_mount() {
        // Configured sources end in /releases/latest/download — the tag
        // probe wants the redirecting page one step up.
        assert_eq!(
            tag_url_from_source("https://github.com/langyo/wowsp/releases/latest/download"),
            "https://github.com/langyo/wowsp/releases/latest"
        );
        // Trailing slashes are trimmed first either way.
        assert_eq!(
            tag_url_from_source(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download/"
            ),
            "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest"
        );
        // A source without the suffix is passed through untouched (its tag
        // probe fails and the marker fallback takes over).
        assert_eq!(
            tag_url_from_source("https://mirror.example.test/files/"),
            "https://mirror.example.test/files"
        );
    }

    #[test]
    fn version_from_redirect_reads_the_tag_segment() {
        // The canonical GitHub redirect target.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/tag/v0.3.0"),
            Some("0.3.0".to_string())
        );
        // A mirror that re-hosts the redirect keeps the same path shape.
        assert_eq!(
            version_from_redirect(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/tag/v1.2.3"
            ),
            Some("1.2.3".to_string())
        );
        // Query strings and trailing slashes must not leak into the version.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/tag/v0.3.0?ref=xx/"),
            Some("0.3.0".to_string())
        );
        // A tag without the v prefix still parses.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/tag/0.4.0"),
            Some("0.4.0".to_string())
        );
        // Non-tag landings (proxy followed internally, error page, plain
        // source echo) resolve nothing — the marker fallback then decides.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/latest"),
            None
        );
        assert_eq!(
            version_from_redirect(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download"
            ),
            None
        );
        assert_eq!(
            version_from_redirect("https://example.test/tag/"),
            None,
            "empty tag name"
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
        // Seeded at 0, a steady sample converges upward toward it.
        let mut estimate = 0.0;
        for _ in 0..30 {
            let next = ewma(estimate, 100.0, SPEED_EWMA_ALPHA);
            assert!(next >= estimate, "EWMA must be monotonic while climbing");
            assert!(next <= 100.0, "EWMA must not overshoot the sample");
            estimate = next;
        }
        assert!((estimate - 100.0).abs() < 0.01, "converges to the sample");
        // First tick from the zero seed: alpha fraction of the sample.
        assert!((ewma(0.0, 100.0, 0.3) - 30.0).abs() < 1e-9);
        // Flat input stays flat; alpha = 1 passes the sample through.
        assert!((ewma(40.0, 40.0, 0.3) - 40.0).abs() < 1e-9);
        assert!((ewma(50.0, 80.0, 1.0) - 80.0).abs() < 1e-9);
    }
}
