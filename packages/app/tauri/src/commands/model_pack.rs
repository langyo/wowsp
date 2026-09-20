//! Resource-pack downloader + cache manager.
//!
//! Packs (each a top-level `<dir>/` subtree of its tar.gz):
//!   `models`    baked GLB models (~1.2 GB)    → 3D ships/maps/planes
//!   `dogtags`   dog-tag map + part PNGs (~3 MB)
//!   `decisions` decision-AI model + LOS rasters (G4; small, MBs)
//!
//! The `decisions` pack's on-disk layout (what the release asset MUST
//! contain — see the release-side notes at the bottom of this comment):
//!   decisions/fire_model.onnx                  trained fire model (E9 export)
//!   decisions/<map short name>/terrain_los.npz E4 LOS rasters, one dir per
//!                                              map ("spaces/50_Gold_harbor"
//!                                              → decisions/50_Gold_harbor/)
//!
//! Tag convention (shared by every pack):
//!   `res-latest`           — newest pack (primary download target)
//!   `res-latest-old-1`     — previous pack (fallback)
//!   `res-latest-old-2`     — two versions back (final fallback)
//!
//! The asset's `updated_at` on the release IS the pack's sync version: it is
//! stamped into `<cache>/.version[-dogtags]` after a download, and
//! `check_pack_updates` diffs it against the current `res-latest` stamp so
//! the Settings → cache-management panel can show "update available" without
//! downloading anything.
//!
//! Every GitHub URL (api.github.com metadata AND github.com asset downloads)
//! is tried through a candidate list: the user-configured mirror
//! (Settings → cache management, stored in network-config.json) first, then a
//! direct connection, then the built-in ghproxy-style mirrors — so mainland
//! China networks can pin a working prefix instead of waiting out the dead
//! direct attempt.
//!
//! `ensure_*` keeps its historical fire-and-forget contract for the startup /
//! on-demand paths (skip when the stamp matches, installer-shipped pack
//! counts as present), while `pack_download` is the panel's explicit
//! download: streaming, progress events (`wowsp://pack-progress`) and
//! cancellable.
//!
//! # `decisions` pack: pre-release + release-side notes (G4)
//!
//! The `decisions` pack is registered here but NOT yet published to any
//! release — there is no trained model worth shipping until G5 (the
//! experiment pipeline produced `out/fire_model/fp32.onnx` from a single
//! replay as a delivery proof, not a model). The graceful pre-release
//! behaviour falls out of the existing code paths:
//!   * `get_pack_status` is pure local state → `{id: "decisions",
//!     present: false, version: None, …}`, no network, no panic;
//!   * `check_pack_updates` resolves the asset per pack and flattens any
//!     lookup failure (404 release / missing asset / offline) to
//!     `remote_version: None` + `update_available: false` — a missing
//!     `wowsp-decisions.tar.gz` asset is indistinguishable from being
//!     offline, so it can never be misreported as an update;
//!   * `pack_download("decisions")` WOULD fail with "failed to resolve
//!     wowsp-decisions.tar.gz: asset … not found" — the panel only enables
//!     the download button when `update_available` is true, which is false
//!     pre-release, so the error is unreachable from the UI.
//!
//! Publishing (release side, `scripts/release_models.py` — to be extended
//! when G5 lands, do NOT ship the single-replay proof model):
//!   1. collect the trained `fire_model.onnx` (E9 export: inputs
//!      entity[1,24,10] / global_feat[1,14] / mask[1,24], outputs
//!      logitA/logitB) and the E4 LOS rasters baked per distributed map;
//!   2. stage a top-level `decisions/` directory containing
//!      `fire_model.onnx` plus one `<map short name>/terrain_los.npz` per
//!      map (the E12 `los_for_replay` lookup convention);
//!   3. `tar -czf wowsp-decisions.tar.gz -C <stage parent> decisions` and
//!      upload it onto the rotating `res-latest` release alongside the
//!      models/dogtags assets (same tag ladder, same `updated_at` stamp
//!      semantics — see `release_models.py` for the rotation ritual).
//!
//! The runtime consumer is `commands::decision_ai` (model, via the pack
//! cache ladder) and `commands::decision_serve` (LOS rasters, via the same
//! `<dir>/<map>/terrain_los.npz` lookup).

use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use flate2::read::GzDecoder;
use reqwest::Client;
use tar::Archive;
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{AuxCacheStatus, PackProgress, PackStatus, PackUpdate};

use crate::paths;

const REPO: &str = "langyo/wowsp";
const RELEASE_TAGS: [&str; 3] = ["res-latest", "res-latest-old-1", "res-latest-old-2"];
pub const PACK_PROGRESS_EVENT: &str = "wowsp://pack-progress";

/// Built-in ghproxy-style mirror prefixes (the same set the updater races
/// and mod-catalog falls back to). Tried AFTER a direct connection so they
/// only carry traffic the direct route cannot.
const BUILTIN_MIRRORS: [&str; 4] = [
    "https://ghp.ci/",
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://ghproxy.net/",
];

/// One downloadable pack's identity: cache layout + release asset.
struct PackSpec {
    /// Cache-management id: `models` | `dogtags` | `decisions`.
    id: &'static str,
    /// Release asset file name.
    asset: &'static str,
    /// Version-stamp file under the cache root.
    version_file: &'static str,
    /// Top-level directory inside the archive AND the cache.
    subdir: &'static str,
}

const PACKS: [PackSpec; 3] = [
    PackSpec {
        id: "models",
        asset: "wowsp-models.tar.gz",
        version_file: ".version",
        subdir: "models",
    },
    PackSpec {
        id: "dogtags",
        asset: "wowsp-dogtags.tar.gz",
        version_file: ".version-dogtags",
        subdir: "dogtags",
    },
    // G4 decisions pack — see the module docs for the pre-release behaviour
    // and the release-side packaging recipe.
    PackSpec {
        id: "decisions",
        asset: "wowsp-decisions.tar.gz",
        version_file: ".version-decisions",
        subdir: "decisions",
    },
];

fn spec_by_id(id: &str) -> Result<&'static PackSpec, String> {
    PACKS
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("unknown pack id: {id}"))
}

/// In-flight download bookkeeping: which pack is downloading (single-flight)
/// plus a cooperative cancel flag the panel sets mid-stream.
static DOWNLOAD_ACTIVE: Mutex<Option<String>> = Mutex::new(None);
static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

fn is_downloading(id: &str) -> bool {
    DOWNLOAD_ACTIVE
        .lock()
        .ok()
        .map(|g| g.as_deref() == Some(id))
        .unwrap_or(false)
}

fn cache_root() -> Result<PathBuf, String> {
    paths::ensure_cache_dir()
}

fn cached_version(cache: &Path, spec: &PackSpec) -> Option<String> {
    fs::read_to_string(cache.join(spec.version_file))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn write_cached_version(cache: &Path, spec: &PackSpec, version: &str) -> Result<(), String> {
    fs::create_dir_all(cache).map_err(|e| format!("create cache dir: {e}"))?;
    fs::write(cache.join(spec.version_file), version)
        .map_err(|e| format!("write version stamp: {e}"))
}

/// Candidate URLs for a GitHub URL: the user-configured mirror first, then
/// direct, then the built-in mirrors.
fn mirror_candidates(url: &str) -> Vec<String> {
    let cfg = super::network::load_config();
    candidates_with_mirror(cfg.github_mirror.as_deref(), url)
}

fn candidates_with_mirror(user_mirror: Option<&str>, url: &str) -> Vec<String> {
    let mut out = Vec::with_capacity(2 + BUILTIN_MIRRORS.len());
    if let Some(m) = user_mirror.map(str::trim).filter(|m| !m.is_empty()) {
        out.push(format!("{}/{url}", m.trim_end_matches('/')));
    }
    out.push(url.to_string());
    out.extend(BUILTIN_MIRRORS.iter().map(|m| format!("{m}{url}")));
    out
}

/// Resolve a GitHub release asset's download URL + `updated_at` stamp,
/// trying every mirror candidate (user-configured mirror, direct, built-ins)
/// before giving up.
async fn release_asset_info(
    client: &Client,
    tag: &str,
    asset_name: &str,
) -> Result<(String, String), String> {
    let api_url = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
    let mut last_err = format!("no mirror attempted for {tag}");
    for url in mirror_candidates(&api_url) {
        match release_asset_info_at(client, &url, asset_name).await {
            Ok(info) => return Ok(info),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// One API attempt: GET the release JSON at `api_url`, find the asset.
async fn release_asset_info_at(
    client: &Client,
    api_url: &str,
    asset_name: &str,
) -> Result<(String, String), String> {
    let resp: serde_json::Value = client
        .get(api_url)
        .header("User-Agent", "WoWSP-model-pack/1.0")
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("fetch release: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse release: {e}"))?;
    let assets = resp["assets"]
        .as_array()
        .ok_or_else(|| "release has no assets".to_string())?;
    for asset in assets {
        if asset["name"].as_str() == Some(asset_name) {
            let download_url = asset["browser_download_url"]
                .as_str()
                .ok_or_else(|| "asset missing download_url".to_string())?
                .to_string();
            let updated_at = asset["updated_at"].as_str().unwrap_or("").to_string();
            return Ok((download_url, updated_at));
        }
    }
    Err(format!("asset {asset_name} not found"))
}

/// Recursive directory size in bytes (0 when absent).
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

/// Whether a directory exists and holds at least one entry.
fn dir_populated(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// Emit a progress event when a handle is available (ensure_* paths run
/// headless without one).
fn emit_progress(app: Option<&AppHandle>, progress: &PackProgress) {
    if let Some(app) = app {
        let _ = app.emit(PACK_PROGRESS_EVENT, progress);
    }
}

/// Stream `url` into `dest`, emitting throttled download progress and
/// honouring the cancel flag. The generous overall timeout only caps a
/// stalled transfer — a healthy slow link streams well within it.
async fn download_to_file(
    client: &Client,
    url: &str,
    dest: &Path,
    id: &str,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let mut resp = client
        .get(url)
        .timeout(Duration::from_secs(3600))
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{url}: {e}"))? {
        if DOWNLOAD_CANCEL.load(Ordering::Relaxed) {
            let _ = fs::remove_file(dest);
            return Err("cancelled".to_string());
        }
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        received += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        if since_emit >= 262_144 {
            since_emit = 0;
            emit_progress(
                app,
                &PackProgress {
                    id: id.to_string(),
                    phase: "download".into(),
                    received,
                    total,
                    error: None,
                },
            );
        }
    }
    file.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Wipe `dest/<subdir>` and unpack the tar.gz at `archive` into `dest`.
/// Unpack the tar.gz at `archive` into `dest/<subdir>` WITHOUT ever leaving
/// `dest/<subdir>` in a partial state: the archive is unpacked into a
/// sibling STAGING directory first and only swapped in after a complete
/// extraction — a cancel or a corrupt archive leaves the previous pack (if
/// any) fully intact. Runs on the blocking pool (a ~1.2 GB unpack must not
/// stall the async runtime).
fn extract_pack_blocking(archive: &Path, dest: &Path, subdir: &str) -> Result<(), String> {
    let staging = dest.join(format!(".{subdir}.staging"));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("clean staging dir: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;
    let unpack = || -> Result<(), String> {
        let file = File::open(archive).map_err(|e| format!("open archive: {e}"))?;
        let gz = GzDecoder::new(file);
        let mut tar = Archive::new(gz);
        tar.set_preserve_permissions(true);
        tar.unpack(&staging)
            .map_err(|e| format!("extract resource pack: {e}"))
    };
    if let Err(e) = unpack() {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    // Swap the staged pack in. Both directories sit under the same cache
    // root, so the rename cannot cross volumes.
    let staged = staging.join(subdir);
    let final_dir = dest.join(subdir);
    if !staged.is_dir() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("archive layout: no top-level {subdir}/ directory"));
    }
    if final_dir.exists() {
        if let Err(e) = fs::remove_dir_all(&final_dir) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("replace old {subdir} dir: {e}"));
        }
    }
    if let Err(e) = fs::rename(&staged, &final_dir) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("move staged {subdir} into place: {e}"));
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(())
}

/// Download + install one pack. Emits progress events when `app` is given.
/// Resolves the asset across the tag ladder (res-latest first) and the
/// download across the mirror ladder. Caller holds the single-flight guard.
async fn install_pack(
    spec: &PackSpec,
    app: Option<&AppHandle>,
    client: &Client,
) -> Result<(), String> {
    // Resolve the newest available asset across the tag ladder.
    let mut resolved: Option<(String, String)> = None;
    let mut last_err = String::from("no release tags available");
    for tag in RELEASE_TAGS {
        match release_asset_info(client, tag, spec.asset).await {
            Ok(info) => {
                resolved = Some(info);
                break;
            },
            Err(e) => last_err = e,
        }
    }
    let Some((download_url, version)) = resolved else {
        return Err(format!("failed to resolve {}: {last_err}", spec.asset));
    };

    let cache = cache_root()?;
    let tmp = cache.join(format!(".pack-{}.download", spec.id));
    emit_progress(
        app,
        &PackProgress {
            id: spec.id.to_string(),
            phase: "download".into(),
            received: 0,
            total: 0,
            error: None,
        },
    );
    // Mirror ladder for the asset itself; a dying mirror restarts the
    // progress stream from zero on the next candidate.
    let mut last_err = String::from("no mirror attempted");
    let mut downloaded = false;
    for url in mirror_candidates(&download_url) {
        match download_to_file(client, &url, &tmp, spec.id, app).await {
            Ok(()) => {
                downloaded = true;
                break;
            },
            Err(e) => {
                if e == "cancelled" {
                    let _ = fs::remove_file(&tmp);
                    return Err(e);
                }
                last_err = e;
            },
        }
    }
    if !downloaded {
        let _ = fs::remove_file(&tmp);
        return Err(format!("download {}: {last_err}", spec.asset));
    }

    emit_progress(
        app,
        &PackProgress {
            id: spec.id.to_string(),
            phase: "extract".into(),
            received: 0,
            total: 0,
            error: None,
        },
    );
    // A cancel that lands mid-extract lets the (complete) archive finish
    // unpacking — the swap-based extractor never leaves a partial pack, so
    // aborting here would only waste the downloaded bytes.
    let archive = tmp.clone();
    let dest = cache.clone();
    let subdir = spec.subdir.to_string();
    let extracted =
        tokio::task::spawn_blocking(move || extract_pack_blocking(&archive, &dest, &subdir))
            .await
            .map_err(|e| format!("extract task: {e}"))
            .and_then(|r| r);
    let _ = fs::remove_file(&tmp);
    extracted?;
    write_cached_version(&cache, spec, &version)?;
    emit_progress(
        app,
        &PackProgress {
            id: spec.id.to_string(),
            phase: "done".into(),
            received: 0,
            total: 0,
            error: None,
        },
    );
    Ok(())
}

/// Ensure one pack is present in the local cache (startup / on-demand path,
/// no progress events).
///
/// Returns the cache root directory (the parent of `models/` / `dogtags/`)
/// so the frontend can construct paths like `<root>/models/ships/X.glb`.
///
/// Fast path when the cached stamp already matches `res-latest`. When no
/// release is reachable, an installer-shipped `<subdir>/` beside the cache
/// still counts as present (the shun installer stages models/ that way).
async fn ensure_pack(spec: &PackSpec) -> Result<String, String> {
    let cache = cache_root()?;
    let client = crate::commands::network::build_http_client()?;

    // Resolve the newest stamp once; reused after the guard wait so a
    // download that finished meanwhile is detected with a LOCAL compare.
    // An unreachable release flattens to None — the flow below then simply
    // attempts the install and falls back to the shipped pack.
    let latest_stamp = release_asset_info(&client, RELEASE_TAGS[0], spec.asset)
        .await
        .ok()
        .map(|(_, version)| version);
    // If the latest asset version already matches the cache, skip the download.
    if let Some(version) = latest_stamp.as_deref() {
        if cached_version(&cache, spec).as_deref() == Some(version) {
            tracing::info!(?cache, subdir = spec.subdir, "resource pack up to date");
            return Ok(cache.to_string_lossy().to_string());
        }
    }

    // Route through the SAME single-flight guard the panel download uses, so
    // a startup/on-demand ensure never installs concurrently with a panel
    // download (both write the same temp archive + pack directory). While
    // another download holds the guard, sleep and retry — and once ACQUIRED,
    // re-check the stamp: a download that finished while we waited may have
    // landed the pack already (cheap local compare against the stamp fetched
    // above — no extra API call). Patience is bounded (~2 minutes) so a
    // stuck download falls through to the shipped-pack / error fallbacks
    // below instead of hanging forever.
    const WAIT_SLOT: Duration = Duration::from_millis(750);
    const WAIT_SLOTS: u32 = 160;
    // Ownership flag: the release below may only clear the guard when THIS
    // call acquired it — a timed-out wait must never release a slot that a
    // still-running panel download of the same pack legitimately holds.
    let mut held = false;
    let mut waited: u32 = 0;
    let installed = loop {
        let blocked_by = {
            let mut guard = DOWNLOAD_ACTIVE.lock().map_err(|_| "lock poisoned")?;
            match guard.as_deref() {
                Some(active) => Some(active.to_string()),
                None => {
                    DOWNLOAD_CANCEL.store(false, Ordering::Relaxed);
                    *guard = Some(spec.id.to_string());
                    held = true;
                    None
                },
            }
        };
        match blocked_by {
            None => {
                // Another download may have landed this exact pack while we
                // were waiting for the guard — one LOCAL stamp compare
                // settles it without another API round-trip.
                if let Some(version) = latest_stamp.as_deref() {
                    if cached_version(&cache, spec).as_deref() == Some(version) {
                        tracing::info!(
                            subdir = spec.subdir,
                            "pack landed by a concurrent download"
                        );
                        break Ok(());
                    }
                }
                break install_pack(spec, None, &client).await;
            },
            Some(active) => {
                waited += 1;
                if waited >= WAIT_SLOTS {
                    break Err(format!(
                        "another pack download ({active}) stayed in flight for too long"
                    ));
                }
                tracing::info!(active, "pack download in flight, waiting");
                tokio::time::sleep(WAIT_SLOT).await;
            },
        }
    };

    // Release the single-flight slot ONLY when this call acquired it.
    if held {
        if let Ok(mut guard) = DOWNLOAD_ACTIVE.lock() {
            if guard.as_deref() == Some(spec.id) {
                *guard = None;
            }
        }
    }

    // Installer-shipped pack: the shun installer stages models/ beside the
    // cache. When no release is reachable (offline machine), serve what
    // shipped instead of failing — otherwise the frontend would fall back to
    // empty publicDir placeholders.
    if installed.is_err() && dir_populated(&cache.join(spec.subdir)) {
        tracing::warn!(?cache, "using installer-shipped resource pack");
        return Ok(cache.to_string_lossy().to_string());
    }

    installed.map(|(): ()| cache.to_string_lossy().to_string())
}

// ── Cache-management commands (Settings panel) ───────────────────────────

/// Local state of every pack: presence, sync version, on-disk size,
/// in-flight download flag. No network, but the size walk over a ~1.2 GB
/// tree runs on the blocking pool so the IPC thread stays responsive.
#[tauri::command]
pub async fn get_pack_status() -> Result<Vec<PackStatus>, String> {
    let cache = cache_root()?;
    let statuses = tokio::task::spawn_blocking(move || -> Vec<PackStatus> {
        PACKS
            .iter()
            .map(|spec| {
                let dir = cache.join(spec.subdir);
                PackStatus {
                    id: spec.id.to_string(),
                    present: dir_populated(&dir),
                    version: cached_version(&cache, spec),
                    size_bytes: dir_size(&dir),
                    downloading: is_downloading(spec.id),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| format!("status task: {e}"))?;
    Ok(statuses)
}

/// Remote pack state: the `res-latest` asset stamp per pack plus whether it
/// differs from the cached stamp (i.e. an update is available). Offline /
/// rate-limited lookups surface as `remote_version: None` instead of an
/// error so the panel can still render local state.
#[tauri::command]
pub async fn check_pack_updates() -> Result<Vec<PackUpdate>, String> {
    let cache = cache_root()?;
    let client = crate::commands::network::build_http_client()?;
    let mut out = Vec::with_capacity(PACKS.len());
    for spec in &PACKS {
        let remote = release_asset_info(&client, RELEASE_TAGS[0], spec.asset)
            .await
            .ok()
            .map(|(_, updated_at)| updated_at);
        let update_available = match (&remote, cached_version(&cache, spec)) {
            // Remote known and different (or nothing cached yet) → update.
            (Some(r), cached) => cached.as_deref() != Some(r.as_str()),
            // Remote unknown → we cannot promise an update.
            (None, _) => false,
        };
        out.push(PackUpdate {
            id: spec.id.to_string(),
            remote_version: remote,
            update_available,
        });
    }
    Ok(out)
}

/// Explicit download (initial or update) of one pack, streaming progress
/// through `wowsp://pack-progress`. Single-flight: a second call while any
/// pack is downloading is rejected.
#[tauri::command]
pub async fn pack_download(id: String, app: AppHandle) -> Result<(), String> {
    let spec = spec_by_id(&id)?;
    // Build the client BEFORE taking the guard — an early error here must
    // not leak the single-flight slot.
    let client = crate::commands::network::build_http_client()?;
    {
        let mut guard = DOWNLOAD_ACTIVE.lock().map_err(|_| "lock poisoned")?;
        if let Some(active) = guard.as_deref() {
            return Err(format!("a pack download is already in flight ({active})"));
        }
        // Clear any stale cancel request from a previous interaction; the
        // flag is intentionally NOT reset at the end of a download — the
        // next download's start (here or in ensure_pack) clears it instead,
        // so a late reset can never erase a cancel aimed at a NEW download.
        DOWNLOAD_CANCEL.store(false, Ordering::Relaxed);
        *guard = Some(spec.id.to_string());
    }
    let result = install_pack(spec, Some(&app), &client).await;
    if let Err(e) = &result {
        emit_progress(
            Some(&app),
            &PackProgress {
                id: spec.id.to_string(),
                phase: "error".into(),
                received: 0,
                total: 0,
                error: Some(e.clone()),
            },
        );
    }
    if let Ok(mut guard) = DOWNLOAD_ACTIVE.lock() {
        if guard.as_deref() == Some(spec.id) {
            *guard = None;
        }
    }
    result
}

/// Cancel the in-flight pack download (cooperative: checked between chunks
/// and before the version stamp is written).
#[tauri::command]
pub fn pack_cancel() -> Result<(), String> {
    DOWNLOAD_CANCEL.store(true, Ordering::Relaxed);
    Ok(())
}

/// Delete one pack's cache directory + version stamp. Refused while the
/// pack is downloading. The recursive delete runs on the blocking pool so a
/// ~1.2 GB tree removal cannot freeze the IPC thread.
#[tauri::command]
pub async fn clear_pack(id: String) -> Result<(), String> {
    let spec = spec_by_id(&id)?;
    if is_downloading(spec.id) {
        return Err(format!("pack {id} is downloading — cancel it first"));
    }
    let cache = cache_root()?;
    let dir = cache.join(spec.subdir);
    let stamp = cache.join(spec.version_file);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
        }
        if stamp.exists() {
            let _ = fs::remove_file(&stamp);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("clear task: {e}"))?
}

// ── Auxiliary caches (Settings panel) ────────────────────────────────────

/// Clearable auxiliary cache directories. Scopes under the DATA dir are all
/// re-downloadable derived data; `image-cache` (ship portraits) lives under
/// the cache dir. User data (stats, ship history, accounts, mod ledger) is
/// deliberately NOT listed.
fn aux_cache_dir(scope: &str) -> Result<PathBuf, String> {
    match scope {
        "image-cache" => Ok(paths::ensure_cache_dir()?.join("image-cache")),
        "gameparams" => Ok(paths::ensure_data_dir()?.join("gameparams")),
        "encyclopedia" => Ok(paths::ensure_data_dir()?.join("encyclopedia")),
        "community" => Ok(paths::ensure_data_dir()?.join("community")),
        other => Err(format!("unknown cache scope: {other}")),
    }
}

/// Sizes of every clearable auxiliary cache directory.
#[tauri::command]
pub async fn aux_cache_overview() -> Result<Vec<AuxCacheStatus>, String> {
    let scopes = tokio::task::spawn_blocking(|| -> Vec<AuxCacheStatus> {
        ["image-cache", "gameparams", "encyclopedia", "community"]
            .iter()
            .map(|scope| {
                let size = aux_cache_dir(scope).map(|d| dir_size(&d)).unwrap_or(0);
                AuxCacheStatus {
                    scope: scope.to_string(),
                    size_bytes: size,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| format!("overview task: {e}"))?;
    Ok(scopes)
}

/// Wipe one auxiliary cache directory (contents only — the directory itself
/// is kept so owners never see a missing-dir state). Deletes run on the
/// blocking pool: recursive removals can take seconds on Windows and a sync
/// command would freeze the IPC thread.
#[tauri::command]
pub async fn clear_aux_cache(scope: String) -> Result<(), String> {
    let dir = aux_cache_dir(&scope)?;
    if !dir.exists() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let entries: Vec<PathBuf> = fs::read_dir(&dir)
            .map_err(|e| format!("read {dir:?}: {e}"))?
            .flatten()
            .map(|e| e.path())
            .collect();
        for entry in entries {
            if entry.is_dir() {
                fs::remove_dir_all(&entry).map_err(|e| format!("remove {entry:?}: {e}"))?;
            } else {
                let _ = fs::remove_file(&entry);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("clear task: {e}"))?
}

// ── Startup / on-demand ensure commands ──────────────────────────────────

/// Baked GLB model pack (Three.js ships/maps). See module docs.
#[tauri::command]
pub async fn ensure_model_pack() -> Result<String, String> {
    ensure_pack(&PACKS[0]).await
}

/// Dog-tag pack (player-avatar map + part PNGs overlaying the bundled
/// snapshot, so medals from newer game clients render without an app
/// release). See module docs.
#[tauri::command]
pub async fn ensure_dogtag_pack() -> Result<String, String> {
    ensure_pack(&PACKS[1]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSET: &str = "https://github.com/langyo/wowsp/x.tar.gz";

    #[test]
    fn mirror_candidates_put_user_mirror_first() {
        let urls = candidates_with_mirror(Some("https://ghfast.top"), ASSET);
        assert_eq!(
            urls[0],
            "https://ghfast.top/https://github.com/langyo/wowsp/x.tar.gz"
        );
        assert_eq!(urls[1], ASSET);
        assert!(urls.len() >= 6);
    }

    #[test]
    fn mirror_candidates_trim_a_trailing_slash() {
        let urls = candidates_with_mirror(Some("https://gh-proxy.com/"), ASSET);
        assert_eq!(
            urls[0],
            "https://gh-proxy.com/https://github.com/langyo/wowsp/x.tar.gz"
        );
    }

    #[test]
    fn mirror_candidates_without_config_start_direct() {
        let urls = candidates_with_mirror(None, ASSET);
        assert_eq!(urls[0], ASSET);
        assert_eq!(urls.len(), 5);
    }

    #[test]
    fn pack_ids_roundtrip() {
        assert_eq!(spec_by_id("models").unwrap().subdir, "models");
        assert_eq!(spec_by_id("dogtags").unwrap().subdir, "dogtags");
        assert_eq!(spec_by_id("decisions").unwrap().subdir, "decisions");
        assert_eq!(
            spec_by_id("decisions").unwrap().asset,
            "wowsp-decisions.tar.gz"
        );
        assert_eq!(
            spec_by_id("decisions").unwrap().version_file,
            ".version-decisions"
        );
        assert!(spec_by_id("nope").is_err());
    }

    /// The PACKS table must stay internally consistent and aligned with the
    /// index-based `ensure_*` commands: unique ids/assets/stamps/subdirs,
    /// every subdir prefixed by its asset's pack family, and the first two
    /// entries pinned to the ids the ensure commands hardcode.
    #[test]
    fn packs_table_is_consistent() {
        let mut ids: Vec<&str> = PACKS.iter().map(|p| p.id).collect();
        let mut assets: Vec<&str> = PACKS.iter().map(|p| p.asset).collect();
        let mut stamps: Vec<&str> = PACKS.iter().map(|p| p.version_file).collect();
        let mut subdirs: Vec<&str> = PACKS.iter().map(|p| p.subdir).collect();
        for (label, vals) in [
            ("id", &mut ids),
            ("asset", &mut assets),
            ("stamp", &mut stamps),
            ("subdir", &mut subdirs),
        ] {
            let n = vals.len();
            vals.sort_unstable();
            vals.dedup();
            assert_eq!(vals.len(), n, "duplicate pack {label}s: {vals:?}");
        }
        for p in &PACKS {
            assert_eq!(
                p.asset,
                format!("wowsp-{}.tar.gz", p.id),
                "asset naming convention"
            );
            // The pack installs into `<cache>/<subdir>/` and stamps into
            // `<cache>/<version_file>` — a collision would make packs
            // clobber each other's state.
            assert_ne!(p.version_file, p.subdir);
        }
        // ensure_model_pack / ensure_dogtag_pack index into PACKS by position.
        assert_eq!(PACKS[0].id, "models");
        assert_eq!(PACKS[1].id, "dogtags");
    }
}
