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
//! channel) under each mirror base.
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
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Set while an update download is in flight: double triggers (auto banner +
/// manual button) collapse into the first pass instead of racing the same
/// temp artifact.
static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

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
/// `scripts/build_installers.py::emit` produces. App updates ALWAYS fetch
/// the `-lite` artifact: the resource pack lives in its own cache and
/// updates through its own hash-versioned channel (see `model_pack.rs`),
/// so an app update never needs to re-ship the ~1.2 GB pack — the full
/// installer is only worth downloading on a fresh install.
fn artifact_url(base: &str, version: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    format!("{base}/WoWSP_{version}_x64-installer-lite.exe")
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
    if UPDATE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = update_download_inner(&app).await;
    UPDATE_IN_FLIGHT.store(false, Ordering::SeqCst);
    result
}

async fn update_download_inner(app: &AppHandle) -> Result<(), String> {
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
    let candidates = race_sources(&client, &watch.sources, marker, true).await?;
    // Stale-mirror guard: a mirror still serving an older release would
    // fetch a different artifact file — only sources agreeing with the
    // winner stay in the race.
    let version = candidates[0].version.clone();
    let sources: Vec<String> = candidates
        .iter()
        .filter(|c| c.version == version)
        .map(|c| artifact_url(&c.base, &version))
        .collect();
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

    // ── Phase 2: queued transfer through the unified download hub ─────
    let done = download_hub::transfer(
        Some(app),
        DownloadRequest {
            min_bytes: MIN_INSTALLER_BYTES,
            race_window: Some(RACE_WINDOW),
            resume: true,
            cancel_msg: CANCEL_MSG.to_string(),
            // No sha exists for the installer artifact (mirrors publish
            // none), but the transfer stays bounded anyway: an unbounded
            // stream would head-of-line-block every later hub job
            // (pack / mods / data pack) behind a dead connection.
            timeout: Some(Duration::from_secs(7200)),
            ..DownloadRequest::new(JOB_ID, kind::UPDATE, sources, part_path)
        },
    )
    .await?;
    tracing::info!(%version, bytes = done.bytes, "installer artifact ready");

    // ── Assemble ────────────────────────────────────────────────────────
    // The completed part becomes the installer. Retry briefly: the
    // writer's tokio-side file close can land just after the hub returns.
    let mut renamed = tokio::fs::rename(&done.path, &installer_path).await;
    for _ in 0..3 {
        if renamed.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        renamed = tokio::fs::rename(&done.path, &installer_path).await;
    }
    renamed.map_err(|e| format!("assemble {}: {e}", installer_path.display()))?;
    cleanup_part_files(None).await;

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

/// The banner's 取消 button: flag the in-flight hub job so the streaming
/// loop tears it down on the next chunk boundary (the part file is KEPT —
/// it is the resume base of the next attempt), `Err("update cancelled")`
/// is returned — the frontend maps that to a clean reset with the update
/// still available. A no-op between passes.
#[tauri::command]
pub fn update_cancel() -> Result<(), String> {
    tracing::info!("update download cancelled by user");
    download_hub::cancel(kind::UPDATE, JOB_ID);
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
        // App updates always fetch the -lite artifact — the resource pack
        // rides its own update channel, never the installer.
        assert_eq!(
            artifact_url(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.1.0"
            ),
            "https://github.com/langyo/wowsp/releases/latest/download/WoWSP_0.1.0_x64-installer-lite.exe"
        );
        // Trailing slashes and stray whitespace on a mirror base are trimmed.
        assert_eq!(
            artifact_url("https://mirror.example.test/files/", "1.2.3"),
            "https://mirror.example.test/files/WoWSP_1.2.3_x64-installer-lite.exe"
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
}
