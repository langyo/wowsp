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
//! enters the unified download hub (`commands/download_hub.rs`) as one
//! FIFO-queued job — mirrors are probed in parallel (the race window
//! reorders the ladder by throughput), a single writer streams the
//! artifact into one version-scoped `.part` file, and a dying mirror
//! fails over to the next candidate FROM THE COMMITTED OFFSET. The part
//! file survives failed and cancelled passes, so a retry resumes where
//! the last attempt died instead of re-downloading from byte 0 (the old
//! failure mode: the bar reaches ~100%, the leader dies at EOF, the
//! runner-up restarts from scratch and it reads as "downloaded it
//! twice"). The completed part becomes `WoWSP-update-<version>-<pid>.exe`,
//! spawned detached with `--silent --dir=<install dir>` — the artifact
//! name `scripts/build_installers.py` produces is
//! `WoWSP_<version>_x64-installer-lite.exe` (see `artifact_url`: an app
//! update never re-ships the resource pack, which updates through its own
//! channel), fetched from the release's VERSIONED download tree
//! (`…/releases/download/v<version>/<file>`) — the URL carries both the
//! version and the file name and is immutable per release, so a stale
//! mirror 404s and fails over instead of serving old bytes under the
//! moving `releases/latest/download` mount.
//! Releases also carry the retired bare name
//! `WoWSP_<version>_x64-installer.exe` as a byte-identical lite alias —
//! pre-v0.3.1 updaters fetch exactly that; this build never does.
//! Before any byte is accepted, the installer's sha256 is read from the
//! official release API (`api.github.com`, never a mirror — the `digest`
//! GitHub computes for every release asset) and the hub verifies the
//! stream against it; no reachable digest or a mismatch on every mirror
//! means no installer is spawned.
//! The hardened installer kills the running app and installs over its
//! directory, so the frontend treats the command's promise never resolving
//! (app death) or resolving (installer spawned) as success by design; the
//! only visible failure modes are `Err` strings (`"update cancelled"` maps
//! to a clean frontend reset).
//!
//! Progress flows to the webui on the unified `wowsp://download-progress`
//! channel (`kind: "update"`): `{ phase: "race" }` while probes settle,
//! `{ phase: "download", received, total, speedBps }` while the artifact
//! streams (speed is an EWMA over 500 ms ticks; `received == total` is
//! only ever emitted for a complete, verified file) and finally
//! `{ phase: "install" }` right before the spawn.

use futures::StreamExt;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::download::{kind, phase};
use wowsp_tauri_shared::{DOWNLOAD_PROGRESS_EVENT, DownloadProgress};

use crate::commands::download_hub::{self, DownloadRequest};
use crate::commands::network::build_http_client;

/// Update-watch table embedded by `build.rs` from
/// `[package.metadata.shun.update]` in this crate's Cargo.toml.
const SHUN_UPDATE_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-update.json"));

/// The running app's version, embedded by `build.rs` from
/// `CARGO_PKG_VERSION` (the workspace version).
const APP_VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/app-version.txt"));

/// One pass owns both the installer path and cancellation from resolution
/// through handoff. A cancel between passes cannot affect the next pass.
static UPDATE_PASS: Mutex<Option<Arc<UpdatePass>>> = Mutex::new(None);

#[derive(Default, PartialEq)]
enum UpdateStage {
    #[default]
    Downloading,
    Cancelled,
    Installing,
}

#[derive(Default)]
struct UpdatePass {
    stage: Mutex<UpdateStage>,
    changed: tokio::sync::Notify,
}

impl UpdatePass {
    fn cancel(&self) -> bool {
        let mut stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        if *stage == UpdateStage::Installing {
            return false;
        }
        *stage = UpdateStage::Cancelled;
        self.changed.notify_one();
        true
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if *self.stage.lock().unwrap_or_else(|e| e.into_inner()) == UpdateStage::Cancelled {
            Err(CANCEL_MSG.to_string())
        } else {
            Ok(())
        }
    }

    async fn cancelled(&self) {
        loop {
            let changed = self.changed.notified();
            if self.check_cancelled().is_err() {
                return;
            }
            changed.await;
        }
    }

    /// Only wrap cancellable reads here. In particular, dropping the hub's
    /// waiter would leave its writer alive and let a retry reuse its path.
    async fn run<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        tokio::select! {
            biased;
            () = self.cancelled() => Err(CANCEL_MSG.to_string()),
            result = operation => {
                self.check_cancelled()?;
                result
            },
        }
    }

    /// The last cancellable point. Serialize this transition with cancel:
    /// once handoff starts, a late click must not claim installation stopped.
    fn begin_install(&self) -> Result<(), String> {
        let mut stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        if *stage == UpdateStage::Cancelled {
            return Err(CANCEL_MSG.to_string());
        }
        *stage = UpdateStage::Installing;
        Ok(())
    }
}

struct UpdateGuard<'a> {
    registry: &'a Mutex<Option<Arc<UpdatePass>>>,
    pass: Arc<UpdatePass>,
}

impl<'a> UpdateGuard<'a> {
    fn begin(registry: &'a Mutex<Option<Arc<UpdatePass>>>) -> Option<Self> {
        let mut active = registry.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return None;
        }
        let pass = Arc::new(UpdatePass::default());
        *active = Some(Arc::clone(&pass));
        Some(Self { registry, pass })
    }
}

impl Drop for UpdateGuard<'_> {
    fn drop(&mut self) {
        *self.registry.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// An installer is hundreds of MB; anything smaller is a mirror error page.
const MIN_INSTALLER_BYTES: u64 = 1_000_000;

/// Per-source cap on the version probe: a slow or dead mirror simply times
/// out instead of stalling the race.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the hub's parallel mirror probe runs before the ladder is
/// reordered by measured throughput and the winner streams.
const RACE_WINDOW: Duration = Duration::from_secs(10);

/// The frontend maps this exact error to a clean reset (banner back to the
/// idle prompt, update still available).
const CANCEL_MSG: &str = "update cancelled";

/// The hub job id — cancels and progress events address the pass by it.
const JOB_ID: &str = "update";

/// The installer artifact URL under a mirror base — the exact name
/// `scripts/build_installers.py::emit` produces, under the release's
/// versioned download tree. App updates ALWAYS fetch the `-lite` artifact:
/// the resource pack lives in its own cache and updates through its own
/// hash-versioned channel (see `model_pack.rs`), so an app update never
/// needs to re-ship the ~1.2 GB pack — the full installer is only worth
/// downloading on a fresh install.
///
/// The path carries BOTH the version and the file name
/// (`…/releases/download/v<version>/<file>`), so it is immutable per
/// release: a stale mirror 404s and fails over instead of serving an
/// older release's bytes under the moving `releases/latest/download`
/// mount, and the fetched URL always names the tag it belongs to.
fn artifact_url(base: &str, version: &str) -> String {
    format!(
        "{}/v{version}/{}",
        versioned_download_base(base),
        artifact_name(version)
    )
}

/// The bare installer asset name for a release (see [`artifact_url`]).
fn artifact_name(version: &str) -> String {
    format!("WoWSP_{version}_x64-installer-lite.exe")
}

/// Rewrite a source base into the versioned-download root. Every
/// configured source ends with the `/releases/latest/download` mount
/// (the discovery side: marker fallback + tag-page probe both live one
/// step up); downloads rewrite that tail to the versioned
/// `/releases/download` tree. A base without the suffix is taken as-is —
/// a custom mirror root is then expected to lay out
/// `v<version>/<file>` underneath it.
fn versioned_download_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    match trimmed.strip_suffix("releases/latest/download") {
        Some(head) => format!("{head}releases/download"),
        None => trimmed.to_string(),
    }
}

// ── Artifact integrity (official digest) ─────────────────────────────────

/// The official release API for one tag. Deliberately NOT routed through
/// `github_mirror`: the digest is the trust anchor for installer bytes that
/// may stream from third-party mirrors, so it must come from GitHub itself
/// — a mirror able to serve both the artifact and its hash could forge both.
fn release_api_url(version: &str) -> String {
    format!("https://api.github.com/repos/langyo/wowsp/releases/tags/v{version}")
}

/// Per-attempt cap on the digest lookup (the payload is a few KB).
const DIGEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Attempts at the digest lookup before the update is refused.
const DIGEST_ATTEMPTS: usize = 3;

/// The lowercase sha256 GitHub computed for asset `name` in a release-API
/// payload (`"digest": "sha256:<hex>"`). `None` when the asset is missing,
/// carries no digest, or the digest is not a well-formed sha256.
fn asset_sha256(release: &serde_json::Value, name: &str) -> Option<String> {
    let hex = release["assets"]
        .as_array()?
        .iter()
        .find(|asset| asset["name"].as_str() == Some(name))?["digest"]
        .as_str()?
        .strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

/// Fetch the official sha256 of the installer for `version`. Any failure
/// is an `Err`: an installer that cannot be verified is never spawned.
async fn fetch_official_sha256(client: &reqwest::Client, version: &str) -> Result<String, String> {
    let url = release_api_url(version);
    let name = artifact_name(version);
    let mut last_err = String::new();
    for _ in 0..DIGEST_ATTEMPTS {
        let response = client
            .get(&url)
            .header("User-Agent", "WoWSP-updater")
            .header("Accept", "application/vnd.github+json")
            .timeout(DIGEST_TIMEOUT)
            .send()
            .await;
        let release: serde_json::Value = match response {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    last_err = format!("parse {url}: {e}");
                    continue;
                },
            },
            Ok(r) => {
                last_err = format!("{url}: HTTP {}", r.status());
                continue;
            },
            Err(e) => {
                last_err = format!("{url}: {e}");
                continue;
            },
        };
        return asset_sha256(&release, &name)
            .ok_or_else(|| format!("release v{version} publishes no sha256 digest for {name}"));
    }
    Err(format!(
        "cannot verify the update (official digest unavailable: {last_err}); download it manually from GitHub Releases"
    ))
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

/// One mirror that resolved the latest version.
struct SourceCandidate {
    base: String,
    version: String,
}

/// Probe every source concurrently, each capped at [`PROBE_TIMEOUT`]. With
/// `collect_all` the pass waits for every probe (bounded by the cap) so all
/// reachable mirrors can enter the artifact race; without it the first
/// resolution wins and the remaining probes are cancelled by drop. Either
/// way `candidates` is in resolution-arrival order — the first entry is the
/// winner.
async fn race_sources(
    client: &reqwest::Client,
    sources: &[String],
    marker: &str,
    collect_all: bool,
) -> Result<Vec<SourceCandidate>, String> {
    let mut probes: futures::stream::FuturesUnordered<_> = sources
        .iter()
        .map(|base| async move {
            let probe = tokio::time::timeout(PROBE_TIMEOUT, probe_source(client, base, marker))
                .await
                .map_err(|_| format!("probe {base}: timed out after {}s", PROBE_TIMEOUT.as_secs()));
            (base.clone(), probe)
        })
        .collect();

    let mut candidates: Vec<SourceCandidate> = Vec::new();
    while let Some((base, probe)) = probes.next().await {
        if let Ok(Ok(version)) = probe {
            candidates.push(SourceCandidate { base, version });
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
    let candidates = race_sources(&client, &watch.sources, marker, false).await?;
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
    tracing::info!(latest = %version, current = APP_VERSION, available, "update check complete");
    Ok(UpdateInfo {
        current: APP_VERSION.to_string(),
        available,
        version: available.then_some(version),
    })
}

// ── Artifact download (via the unified download hub) ─────────────────────

fn emit_phase(app: &AppHandle, progress_phase: &str) {
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            id: JOB_ID.to_string(),
            kind: kind::UPDATE.to_string(),
            phase: progress_phase.to_string(),
            received: 0,
            total: 0,
            speed_bps: 0.0,
            detail: None,
            error: None,
        },
    );
}

/// Best-effort removal of stale `.part` leftovers (other versions/pids,
/// and the pre-hub per-racer layout): without this, the temp dir would
/// accumulate one orphaned multi-hundred-MB part per aborted launch.
/// Files still open on Windows fail to delete and are left for the OS
/// temp dir to reclaim.
async fn cleanup_part_files(keep: Option<&std::path::Path>) {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.starts_with("WoWSP-update-")
            && name.ends_with(".part")
            && Some(path.as_path()) != keep
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Download the new installer and hand it to the OS. All mirrors that
/// returned the marker enter the download hub as one job: the hub races
/// the sources, streams through a single writer into the version-scoped
/// part file (resuming across failed/cancelled passes) and walks its
/// ladder on mirror death. On success the part file becomes
/// `WoWSP-update-<version>-<pid>.exe`, spawned with
/// `--silent --dir=<install dir>`; returns after that spawn — the hardened
/// installer then kills this app, installs over its directory and
/// relaunches the new build, so the webui treats the unresolved promise /
/// app exit as success by design.
#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<(), String> {
    // Collapse double triggers (banner + About button) into one pass.
    let Some(guard) = UpdateGuard::begin(&UPDATE_PASS) else {
        return Ok(());
    };
    let result = update_download_inner(&app, &guard.pass).await;
    // Cancellation wins over an API/rename error racing with the click.
    guard.pass.check_cancelled()?;
    result
}

async fn update_download_inner(app: &AppHandle, pass: &UpdatePass) -> Result<(), String> {
    // Drop a stale cancel pressed while no pass was registered (e.g.
    // during the previous pass's installer spawn tail) - THIS attempt is
    // user-initiated and must not inherit it.
    download_hub::clear_pending(kind::UPDATE, JOB_ID);

    // ── Phase 1: mirror resolution race ────────────────────────────────
    // Every source is probed in parallel with a 10 s cap each; all that
    // resolve the latest version (in arrival order) enter the artifact
    // race. The unified channel's race event lets the toast flip to its
    // indeterminate strip while the probes settle.
    let watch = watch_config()?;
    let marker = watch
        .files
        .first()
        .ok_or_else(|| "no marker file declared in the update sources".to_string())?;
    let client = build_http_client()?;
    emit_phase(app, phase::RACE);
    let candidates = pass
        .run(race_sources(&client, &watch.sources, marker, true))
        .await?;
    // Stale-mirror guard: a mirror still serving an older release would
    // fetch a different artifact file — only sources agreeing with the
    // winner stay in the race.
    let version = candidates[0].version.clone();
    let sources: Vec<String> = candidates
        .iter()
        .filter(|c| c.version == version)
        .map(|c| artifact_url(&c.base, &version))
        .collect();
    // The official digest is fetched straight from api.github.com before a
    // single mirror byte is accepted; without it the update is refused.
    let expected_sha256 = pass.run(fetch_official_sha256(&client, &version)).await?;
    tracing::info!(%version, racers = sources.len(), "update download starting");

    // Version-scoped, pid-suffixed temp name: the part survives failed
    // passes (the resume base of the next try — same version, same
    // process) while two app instances never share one file.
    let temp = std::env::temp_dir();
    let pid = std::process::id();
    let part_path = temp.join(format!("WoWSP-update-{version}-{pid}.part"));
    let installer_path = temp.join(format!("WoWSP-update-{version}-{pid}.exe"));
    // Sweep parts of other versions/pids (and the pre-hub multi-racer
    // layout) so the temp dir cannot accumulate one stale part per
    // launch; a running instance's part is held open and simply fails
    // the best-effort delete on Windows.
    cleanup_part_files(Some(&part_path)).await;
    pass.check_cancelled()?;

    // ── Phase 2: queued transfer through the unified download hub ─────
    let transferred = download_hub::transfer(
        Some(app),
        DownloadRequest {
            min_bytes: MIN_INSTALLER_BYTES,
            race_window: Some(RACE_WINDOW),
            resume: true,
            cancel_msg: CANCEL_MSG.to_string(),
            // Verified streaming against GitHub's own digest: a mirror
            // serving tampered or truncated bytes fails the check and the
            // hub moves on to the next candidate.
            expected_sha256: Some(expected_sha256),
            // The transfer stays bounded: an unbounded stream would
            // head-of-line-block every later hub job (pack / mods / data
            // pack) behind a dead connection.
            timeout: Some(Duration::from_secs(7200)),
            ..DownloadRequest::new(JOB_ID, kind::UPDATE, sources, part_path)
        },
    )
    .await;
    pass.check_cancelled()?;
    let done = transferred?;
    tracing::info!(%version, bytes = done.bytes, "installer artifact ready");

    // ── Assemble ────────────────────────────────────────────────────────
    // The completed part becomes the installer. Retry briefly: the
    // writer's tokio-side file close can land just after the hub returns.
    let mut renamed = tokio::fs::rename(&done.path, &installer_path).await;
    for _ in 0..3 {
        if renamed.is_ok() {
            break;
        }
        pass.run(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok(())
        })
        .await?;
        renamed = tokio::fs::rename(&done.path, &installer_path).await;
    }
    renamed.map_err(|e| format!("assemble {}: {e}", installer_path.display()))?;
    cleanup_part_files(None).await;

    // Install over the directory the running exe lives in; the hardened
    // installer takes it from here — it kills this app, extracts, leaves
    // every launcher untouched (they point at the same exe) and relaunches
    // the new build. No shortcut flags ride along: the shun headless
    // lane re-applies the manifest policy (start menu always, desktop
    // asked → checked), refreshing launchers in place — paths are
    // stable, so existing links stay valid.
    let install_dir = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .parent()
        .ok_or_else(|| "current exe has no parent directory".to_string())?
        .to_path_buf();
    // Tell the webui the install phase started even though the spawned
    // installer may kill this app before the command's promise settles.
    pass.begin_install()?;
    emit_phase(app, phase::INSTALL);
    std::process::Command::new(&installer_path)
        .args(["--silent", &format!("--dir={}", install_dir.display())])
        .spawn()
        .map_err(|e| format!("spawn installer {}: {e}", installer_path.display()))?;
    // The last line the running build writes before the installer kills it —
    // when an update reports "nothing happened", this is the fork in the
    // trail: present here means the handoff succeeded.
    tracing::info!(%version, installer = %installer_path.display(), "installer spawned; handing off");

    Ok(())
}

/// The banner's 取消 button: interrupt resolution/digest reads and cancel
/// the hub job, retaining downloaded bytes for a later retry. The pass
/// returns `Err("update cancelled")`, which the frontend treats as a clean
/// reset. A no-op between passes or after installer handoff begins.
#[tauri::command]
pub fn update_cancel() -> Result<(), String> {
    // Keep the registration locked until the hub sees the cancel, so the
    // previous pass cannot leave a pending cancel in a newly started pass.
    let active = UPDATE_PASS.lock().unwrap_or_else(|e| e.into_inner());
    if active.as_ref().is_some_and(|pass| pass.cancel()) {
        tracing::info!("update download cancelled by user");
        download_hub::cancel(kind::UPDATE, JOB_ID);
    }
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_lookup() {
        use tokio::io::AsyncReadExt;

        let pass = UpdatePass::default();
        // A local HTTPS proxy accepts CONNECT but never establishes the
        // tunnel. Exercise the real official-digest request without any
        // external traffic or a test-only alternate trust anchor.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::https(proxy).unwrap())
            .build()
            .unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"CONNECT api.github.com:443 "));
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        let cancel = async {
            ready.await.unwrap();
            assert!(pass.cancel());
        };
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(pass.run(fetch_official_sha256(&client, "0.5.4")), cancel)
        })
        .await;
        server.abort();
        let (result, ()) =
            outcome.expect("cancel must not wait for the lookup's 20-second timeout");
        assert_eq!(result, Err(CANCEL_MSG.to_string()));
    }

    #[tokio::test]
    async fn cancellation_wins_over_a_lookup_error_in_the_same_poll() {
        let pass = UpdatePass::default();
        let result: Result<(), String> = pass
            .run(async {
                assert!(pass.cancel());
                Err("official digest unavailable".to_string())
            })
            .await;
        assert_eq!(result, Err(CANCEL_MSG.to_string()));
    }

    #[tokio::test]
    async fn cancellation_before_lookup_never_polls_the_request() {
        let pass = UpdatePass::default();
        assert!(pass.cancel());
        let result: Result<(), String> = pass
            .run(async { panic!("a cancelled pass must not start another request") })
            .await;
        assert_eq!(result, Err(CANCEL_MSG.to_string()));
    }

    #[tokio::test]
    async fn an_uncancelled_lookup_preserves_integrity_errors() {
        let pass = UpdatePass::default();
        let result: Result<(), String> = pass
            .run(async { Err("release publishes no sha256 digest".to_string()) })
            .await;
        assert_eq!(
            result,
            Err("release publishes no sha256 digest".to_string())
        );
    }

    #[test]
    fn cancelled_pass_cannot_hand_off_to_the_installer() {
        let pass = UpdatePass::default();
        assert!(pass.cancel());
        assert_eq!(pass.begin_install(), Err(CANCEL_MSG.to_string()));
    }

    #[test]
    fn handoff_is_the_last_cancellable_point() {
        let pass = UpdatePass::default();
        pass.begin_install().unwrap();
        assert!(!pass.cancel());
        assert_eq!(pass.check_cancelled(), Ok(()));
    }

    #[test]
    fn retry_gets_a_new_pass_and_an_old_cancel_cannot_reach_it() {
        let registry = Mutex::new(None);
        let first = UpdateGuard::begin(&registry).unwrap();
        assert!(UpdateGuard::begin(&registry).is_none());
        let previous = Arc::clone(&first.pass);
        previous.cancel();
        drop(first);
        let retry = UpdateGuard::begin(&registry).unwrap();
        previous.cancel();
        assert_eq!(retry.pass.check_cancelled(), Ok(()));
    }

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
    fn embedded_sources_match_the_shared_mirror_ladder() {
        // Cargo.toml's `[package.metadata.shun.update]` table and
        // `github_mirror.rs` both declare the official-first mirror list;
        // this test fails when they drift apart.
        let watch = watch_config().expect("embedded config parses");
        assert_eq!(watch.sources, super::super::github_mirror::update_sources());
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
        // App updates always fetch the -lite artifact from the release's
        // VERSIONED download tree — the URL carries both the version and
        // the file name and never rides the moving latest mount.
        assert_eq!(
            artifact_url(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.1.0"
            ),
            "https://github.com/langyo/wowsp/releases/download/v0.1.0/WoWSP_0.1.0_x64-installer-lite.exe"
        );
        // Mirror prefixes ride along: only the mount tail is rewritten.
        assert_eq!(
            artifact_url(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download",
                "0.5.9"
            ),
            "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/download/v0.5.9/WoWSP_0.5.9_x64-installer-lite.exe"
        );
    }

    #[test]
    fn versioned_download_base_rewrites_the_latest_mount() {
        // The configured sources end with the /releases/latest/download
        // mount (the discovery side); downloads rewrite exactly that tail.
        assert_eq!(
            versioned_download_base("https://github.com/langyo/wowsp/releases/latest/download"),
            "https://github.com/langyo/wowsp/releases/download"
        );
        // Trailing slashes and stray whitespace are trimmed before matching.
        assert_eq!(
            versioned_download_base(
                "https://ghfast.top/https://github.com/langyo/wowsp/releases/latest/download/"
            ),
            "https://ghfast.top/https://github.com/langyo/wowsp/releases/download"
        );
        // A base without the mount is taken as a versioned root as-is.
        assert_eq!(
            versioned_download_base("https://mirror.example.test/files/"),
            "https://mirror.example.test/files"
        );
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
    fn release_api_url_targets_github_directly() {
        // The digest source must never be a mirror prefix.
        assert_eq!(
            release_api_url("0.5.4"),
            "https://api.github.com/repos/langyo/wowsp/releases/tags/v0.5.4"
        );
    }

    #[test]
    fn asset_sha256_picks_the_lite_installer_digest() {
        let hex = "5c25dea369c26b8889c1a0dcd8697d0de6f138c12a68721e47479cd9c675116d";
        let release = serde_json::json!({
            "assets": [
                { "name": "latest", "digest": "sha256:8878893c4e9b58612d5d96a468552e495493152ae49a02196c9af550c556e71d" },
                { "name": "WoWSP_0.5.4_x64-installer-lite.exe", "digest": format!("sha256:{}", hex.to_uppercase()) },
                { "name": "WoWSP_0.5.4_x64-installer.exe", "digest": "sha256:05ba4ab13167014d9ed80f99e4ba5d191b20c859b98689425433075dbe779577" },
            ]
        });
        assert_eq!(
            asset_sha256(&release, &artifact_name("0.5.4")),
            Some(hex.to_string()),
            "matched by exact name and normalized to lowercase"
        );
    }

    #[test]
    fn asset_sha256_rejects_missing_or_malformed_digests() {
        let name = artifact_name("0.5.4");
        let with_digest = |digest: serde_json::Value| serde_json::json!({ "assets": [{ "name": name, "digest": digest }] });
        assert_eq!(
            asset_sha256(&serde_json::json!({}), &name),
            None,
            "no assets"
        );
        assert_eq!(
            asset_sha256(&serde_json::json!({ "assets": [{ "name": name }] }), &name),
            None,
            "asset without a digest"
        );
        assert_eq!(
            asset_sha256(&with_digest(serde_json::Value::Null), &name),
            None
        );
        assert_eq!(
            asset_sha256(
                &with_digest("md5:d41d8cd98f00b204e9800998ecf8427e".into()),
                &name
            ),
            None,
            "non-sha256 algorithm"
        );
        assert_eq!(
            asset_sha256(&with_digest("sha256:abc".into()), &name),
            None,
            "short"
        );
        assert_eq!(
            asset_sha256(
                &with_digest(format!("sha256:{}", "z".repeat(64)).into()),
                &name
            ),
            None,
            "non-hex"
        );
        assert_eq!(
            asset_sha256(
                &with_digest(format!("sha256:{}", "a".repeat(64)).into()),
                "other.exe"
            ),
            None,
            "other asset name"
        );
    }
}
