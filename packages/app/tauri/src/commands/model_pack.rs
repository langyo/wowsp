//! Single resource-pack downloader + cache manager (game-engine style).
//!
//! The app binary and the resource pack version INDEPENDENTLY, the way a
//! game splits its engine from its assets:
//!
//!   app binary → GitHub `v*` tags (see `commands/update.rs`)
//!   resource pack → the fixed `res-latest` release, versioned by a
//!     content tree hash + published-at timestamp carried in a small
//!     `wowsp-res.json` manifest asset
//!
//! The full pack (`wowsp-res.tar.gz`, top-level `models/` + `dogtags/`)
//! is content-addressed: its version hash is computed over the sorted
//! per-file sha256 manifest of the tree, so republishing identical content
//! keeps clients current and any change is detectable without trusting
//! upload timestamps. The hash's LAST 6 hex chars are what the Settings →
//! updates panel shows.
//!
//! Chain patches: every publish also uploads a `res-delta-<from>-<to>`
//! release whose `wowsp-res-delta.tar.gz` carries the changed/added files
//! plus a removal list (the Python publisher keeps the newest three
//! deltas). `check_res_update` walks the delta tag list and returns the
//! patch chain from the local tree hash to the latest one — at most the
//! three retained links; anything older falls back to a full download.
//!
//! Every GitHub URL is tried through a candidate list: the user-configured
//! mirror (Settings → updates, stored in network-config.toml) first, then a
//! direct connection, then the built-in ghproxy-style mirrors — so mainland
//! China networks can pin a working prefix instead of waiting out the dead
//! direct attempt.
//!
//! Extraction and patch application prepare a separate `.res-staging`
//! tree while the current pack keeps serving. Publishing backs up the old
//! directories and version stamp, restoring them on an I/O failure. A
//! cancelled or corrupt delta never changes the old pack's bytes.
//!
//! `ensure_res_pack` keeps its historical fire-and-forget contract for the
//! startup / on-demand paths (skip when the hash matches; an installer-
//! shipped or legacy-stamped pack counts as present), while `res_download`
//! is the panel's explicit download: streaming through the unified
//! download hub, progress events on `wowsp://download-progress`
//! (kind "res-pack") and cancellable.
//!
//! ## Mobile (Android/iOS app build)
//!
//! The phone APK ships the pack INSIDE its read-only assets (the webui
//! build keeps the baked GLBs via `WOWSP_MOBILE_BUNDLE=1`, and the dist
//! carries the pack's `wowsp-res.json` manifest at its root). Serving
//! precedence: the app-cache pack when one was downloaded AND it is not
//! older than the bundled baseline; otherwise the bundled same-origin
//! assets (`/models/...`, `/dogtags/...` — the webui constructs those
//! URLs itself when no cache root is wired). Consequences:
//!
//!   - `ensure_res_pack` NEVER downloads on mobile (a first launch must
//!     not surprise the user with a ~1.2 GB pull) — it hands out the
//!     serving cache root or the `MOBILE_BUNDLED_IN_USE` marker.
//!   - the bundled baseline (tree hash + version) cannot be read from the
//!     read-only APK assets portably, so the WEBUI reports it once at
//!     startup via `res_report_bundled` after fetching the same-origin
//!     `/wowsp-res.json`; the shell keeps it in a static.
//!   - `res_download` installs the FULL archive only — chain patches
//!     would have to read the patched tree's base files out of the
//!     read-only APK assets when the base is the bundle. A cache-based
//!     base could patch in theory; v1 keeps mobile full-download-only.
//!   - `clear_res` deletes the cache, and the bundle takes over again —
//!     clearing can never brick the app.

use std::fs;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use flate2::read::GzDecoder;
use reqwest::Client;
use sha2::{Digest, Sha256};
use tar::Archive;
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::download::{kind, phase};
use wowsp_tauri_shared::{DOWNLOAD_PROGRESS_EVENT, DownloadProgress, ResStatus, ResUpdate};

use crate::commands::download_hub::{self, DownloadRequest};
use crate::paths;

const REPO: &str = "langyo/wowsp";
/// The fixed, single release tag the resource pack publishes under.
const RES_TAG: &str = "res-latest";
/// Full-pack asset name (top-level `models/` + `dogtags/`).
const RES_ARCHIVE: &str = "wowsp-res.tar.gz";
/// The manifest asset: tree hash + published-at + asset sha256.
const RES_MANIFEST: &str = "wowsp-res.json";
/// Delta releases are tagged `res-delta-<from-hash>-<to-hash>` and carry a
/// single `wowsp-res-delta.tar.gz` asset.
const DELTA_TAG_PREFIX: &str = "res-delta-";
const DELTA_ARCHIVE: &str = "wowsp-res-delta.tar.gz";
/// The delta manifest file inside a delta archive.
const DELTA_MANIFEST_FILE: &str = "delta-manifest.json";
/// Files inside a delta archive live under this prefix.
const DELTA_FILES_PREFIX: &str = "files";

/// Cache sub-directories the pack owns (the archive's top level).
const SUBDIRS: [&str; 2] = ["models", "dogtags"];

/// Local version stamp (JSON: `{treeSha256, version}`) under the cache root.
const VERSION_FILE: &str = ".res-version.json";
/// Legacy per-pack stamps from the pre-hash scheme — presence of either
/// without `.res-version.json` marks the cache as "hash unknown".
const LEGACY_STAMPS: [&str; 2] = [".version", ".version-dogtags"];

/// Staging roots the installer flow uses under the cache directory.
const STAGING_DIR: &str = ".res-staging";
const BACKUP_DIR: &str = ".res-backup";
const PACK_TMP: &str = ".res-pack.download";
const DELTA_TMP: &str = ".res-delta.download";
const DELTA_STAGING_DIR: &str = ".res-delta-staging";

/// The unified download hub's job id for every pack archive transfer
/// (full download and each chain-patch link — cancels address the pass
/// by it).
const JOB_ID: &str = "res-pack";

/// In-flight download bookkeeping (single-flight — there is exactly one
/// pack now; the whole install pass, transfer + apply, holds it).
static DOWNLOAD_ACTIVE: Mutex<bool> = Mutex::new(false);

/// Marker `ensure_res_pack` answers with on mobile when the APK bundle (not
/// a downloaded cache pack) is serving — the webui treats it as "nothing to
/// wire, same-origin assets cover everything".
#[cfg(mobile)]
pub const MOBILE_BUNDLED_IN_USE: &str = "mobile: bundled resource pack in use";

// ── Mobile bundled baseline ────────────────────────────────────────────────

/// The APK-bundled pack's identity, reported once by the webui at startup
/// (it fetches the same-origin `/wowsp-res.json` shipped in the APK and
/// hands the tree hash + published-at over — the shell cannot read the
/// read-only APK assets portably, the webui can).
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(mobile), allow(dead_code))] // exercised by unit tests on desktop
struct BundledBaseline {
    tree_sha256: String,
    version: String,
}

/// First report wins: the APK's manifest is immutable for the lifetime of
/// the install, so a second (buggy) report is ignored rather than racing.
static BUNDLED_BASELINE: Mutex<Option<BundledBaseline>> = Mutex::new(None);

#[cfg_attr(not(mobile), allow(dead_code))] // exercised by unit tests on desktop
fn bundled_baseline() -> Option<BundledBaseline> {
    BUNDLED_BASELINE.lock().ok().and_then(|g| g.clone())
}

/// Webui → shell handoff of the bundled baseline (mobile). Pure bookkeeping
/// on desktop (stored, never consulted), so the same command shape serves
/// both targets.
#[tauri::command]
pub fn res_report_bundled(tree_sha256: String, version: String) -> Result<(), String> {
    let is_hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_hash(&tree_sha256) || version.trim().is_empty() {
        return Err(format!(
            "invalid bundled baseline (treeSha256 len {}, version {:?})",
            tree_sha256.len(),
            version
        ));
    }
    let mut guard = BUNDLED_BASELINE.lock().map_err(|_| "lock poisoned")?;
    if guard.is_none() {
        *guard = Some(BundledBaseline {
            tree_sha256: tree_sha256.to_ascii_lowercase(),
            version,
        });
    }
    Ok(())
}

/// Whether the local cache pack may serve over the bundled baseline.
/// Versions are the publisher's ISO-8601 published-at stamps, so a plain
/// string compare orders them. No baseline reported → a populated cache
/// serves; no local stamp → only an identical hash saves it (otherwise the
/// newer bundle wins — app updates refresh the bundle, not the cache).
#[cfg_attr(not(mobile), allow(dead_code))] // exercised by unit tests on desktop
fn cache_supersedes_baseline(local: &LocalVersion, base: Option<&BundledBaseline>) -> bool {
    match base {
        None => true,
        Some(b) => match local.version.as_deref() {
            Some(v) => v >= b.version.as_str(),
            None => local.tree_sha256.as_deref() == Some(b.tree_sha256.as_str()),
        },
    }
}

/// The serving local state: the cache stamp on desktop; on mobile, nothing
/// when the bundle outranks the cache (a stale cache must neither shortcut
/// a download as "current" nor be handed out as the serving root).
fn effective_local_version(cache: &Path) -> LocalVersion {
    let local = read_local_version(cache);
    #[cfg(mobile)]
    {
        if !cache_supersedes_baseline(&local, bundled_baseline().as_ref()) {
            return LocalVersion::default();
        }
    }
    local
}

/// Mobile serving decision: `Some(cache_root)` when a downloaded pack is
/// current enough to serve, `None` when the APK bundle serves (or nothing
/// does). A populated but UNSTAMPED cache never serves on mobile — only
/// `res_download` writes this cache, and it always stamps.
#[cfg(mobile)]
fn mobile_serving_root() -> Result<Option<String>, String> {
    let cache = cache_root()?;
    if !dir_populated(&cache.join("models")) {
        return Ok(None);
    }
    let local = read_local_version(&cache);
    if local.tree_sha256.is_none() {
        return Ok(None);
    }
    if !cache_supersedes_baseline(&local, bundled_baseline().as_ref()) {
        return Ok(None);
    }
    Ok(Some(cache.to_string_lossy().to_string()))
}

fn is_downloading() -> bool {
    DOWNLOAD_ACTIVE.lock().map(|g| *g).unwrap_or(false)
}

// ── Local version stamp ───────────────────────────────────────────────────

/// The hash-stamped local state, read from `.res-version.json`.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalVersion {
    tree_sha256: Option<String>,
    version: Option<String>,
}

fn cache_root() -> Result<PathBuf, String> {
    paths::ensure_cache_dir()
}

fn read_local_version(cache: &Path) -> LocalVersion {
    fs::read_to_string(cache.join(VERSION_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_local_version(cache: &Path, tree_sha256: &str, version: &str) -> Result<(), String> {
    let raw = serde_json::json!({ "treeSha256": tree_sha256, "version": version }).to_string();
    fs::write(cache.join(VERSION_FILE), raw).map_err(|e| format!("write version stamp: {e}"))
}

/// Whether a LEGACY stamp exists without a hash stamp — the cache predates
/// the hash scheme and its content hash is unknowable.
fn has_legacy_stamp(cache: &Path) -> bool {
    read_local_version(cache).tree_sha256.is_none()
        && LEGACY_STAMPS.iter().any(|s| cache.join(s).is_file())
}

// ── Remote manifest + delta discovery ─────────────────────────────────────

/// The `wowsp-res.json` manifest published alongside the full archive.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResManifest {
    tree_sha256: String,
    version: String,
    asset_sha256: String,
    #[serde(default)]
    asset_size: u64,
}

/// One edge of the delta graph, parsed from a `res-delta-<from>-<to>` tag
/// plus its patch asset.
#[derive(Debug, Clone)]
struct DeltaEdge {
    from: String,
    to: String,
    url: String,
    size: u64,
}

impl From<&DeltaEdge> for wowsp_tauri_shared::ResDeltaStep {
    fn from(e: &DeltaEdge) -> Self {
        wowsp_tauri_shared::ResDeltaStep {
            from: e.from.clone(),
            to: e.to.clone(),
            url: e.url.clone(),
            size: e.size,
        }
    }
}

fn release_download_url(asset: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/{RES_TAG}/{asset}")
}

/// Download the manifest asset (a small JSON file) across the mirror
/// ladder. `Cache-Control: no-cache` keeps mirror-cached copies from
/// pinning an old version into the check.
async fn fetch_manifest(client: &Client) -> Result<ResManifest, String> {
    let url = release_download_url(RES_MANIFEST);
    let mut last_err = format!("no mirror attempted for {RES_MANIFEST}");
    for candidate in super::github_mirror::candidates(&url) {
        match client
            .get(&candidate)
            .header("User-Agent", "WoWSP-resource-pack/2.0")
            .header("Cache-Control", "no-cache")
            .timeout(Duration::from_secs(30))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(body) => match serde_json::from_str::<ResManifest>(&body) {
                    Ok(m) => return Ok(m),
                    Err(e) => last_err = format!("parse manifest from {candidate}: {e}"),
                },
                Err(e) => last_err = format!("read manifest from {candidate}: {e}"),
            },
            Ok(resp) => last_err = format!("{candidate}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{candidate}: {e}"),
        }
    }
    Err(last_err)
}

/// Split a `res-delta-<from>-<to>` tag into its two full tree hashes.
/// Anything malformed (wrong prefix, non-hex, wrong length) is ignored —
/// unknown tag shapes must never break the chain walk.
fn parse_delta_tag(tag: &str) -> Option<(String, String)> {
    let rest = tag.strip_prefix(DELTA_TAG_PREFIX)?;
    let (from, to) = rest.split_once('-')?;
    let is_hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_hash(from) || !is_hash(to) {
        return None;
    }
    Some((from.to_string(), to.to_string()))
}

/// Query the repo's release list and collect every delta edge whose patch
/// asset exists. The list API is paged; one page of 100 comfortably holds
/// the app releases plus the three retained deltas.
async fn fetch_delta_edges(client: &Client) -> Result<Vec<DeltaEdge>, String> {
    let api_url = format!("https://api.github.com/repos/{REPO}/releases?per_page=100");
    let mut last_err = String::from("no mirror attempted for release list");
    for candidate in super::github_mirror::candidates(&api_url) {
        let resp: serde_json::Value = match client
            .get(&candidate)
            .header("User-Agent", "WoWSP-resource-pack/2.0")
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    last_err = format!("parse release list from {candidate}: {e}");
                    continue;
                },
            },
            Ok(r) => {
                last_err = format!("{candidate}: HTTP {}", r.status());
                continue;
            },
            Err(e) => {
                last_err = format!("{candidate}: {e}");
                continue;
            },
        };
        let mut edges = Vec::new();
        for release in resp.as_array().into_iter().flatten() {
            let Some(tag) = release["tag_name"].as_str() else {
                continue;
            };
            let Some((from, to)) = parse_delta_tag(tag) else {
                continue;
            };
            for asset in release["assets"].as_array().into_iter().flatten() {
                if asset["name"].as_str() == Some(DELTA_ARCHIVE) {
                    if let Some(url) = asset["browser_download_url"].as_str() {
                        edges.push(DeltaEdge {
                            from: from.clone(),
                            to: to.clone(),
                            url: url.to_string(),
                            size: asset["size"].as_u64().unwrap_or(0),
                        });
                    }
                }
            }
        }
        return Ok(edges);
    }
    Err(last_err)
}

/// Walk the delta graph from `local` to `latest` and return the shortest
/// chain (BFS — the publisher retains only a linear run, but the walk
/// stays correct for any shape). Empty when `local == latest`; the graph
/// may simply have no path (→ full download).
fn delta_chain(edges: &[DeltaEdge], local: &str, latest: &str) -> Vec<DeltaEdge> {
    if local == latest {
        return Vec::new();
    }
    // BFS over indices into `edges`, tracking each hop's predecessor.
    let mut prev: Vec<Option<usize>> = vec![None; edges.len()];
    let mut queue: Vec<usize> = edges
        .iter()
        .enumerate()
        .filter(|(_, e)| e.from == local)
        .map(|(i, _)| i)
        .collect();
    let mut head = 0;
    let mut goal: Option<usize> = queue.iter().copied().find(|i| edges[*i].to == latest);
    while head < queue.len() && goal.is_none() {
        let cur = queue[head];
        head += 1;
        for (i, e) in edges.iter().enumerate() {
            if e.from == edges[cur].to && prev[i].is_none() && !queue.contains(&i) {
                prev[i] = Some(cur);
                queue.push(i);
                if e.to == latest {
                    goal = Some(i);
                    break;
                }
            }
        }
    }
    let Some(mut idx) = goal else {
        return Vec::new();
    };
    let mut chain = Vec::new();
    loop {
        chain.push(edges[idx].clone());
        match prev[idx] {
            Some(p) => idx = p,
            None => break,
        }
    }
    chain.reverse();
    chain
}

// ── Disk helpers ──────────────────────────────────────────────────────────

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

/// A manifest path is safe when it is relative, normalizes inside the pack
/// root, and never touches the staging control files.
fn safe_rel_path(path: &str) -> bool {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(':')
        || path.contains("..")
    {
        return false;
    }
    Path::new(path).components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

/// sha256 of one file, streaming.
fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("hash {}: {e}", path.display()))?;
    Ok(hex::encode(hasher.finalize()))
}

/// One pack-pass progress tick on the unified `wowsp://download-progress`
/// channel (`kind: "res-pack"`); no-op for headless callers (the ensure_*
/// startup paths run without a handle).
#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: Option<&AppHandle>,
    progress_phase: &str,
    received: u64,
    total: u64,
    segment: u32,
    segments: u32,
    error: Option<String>,
) {
    if let Some(app) = app {
        let _ = app.emit(
            DOWNLOAD_PROGRESS_EVENT,
            DownloadProgress {
                id: JOB_ID.to_string(),
                kind: kind::RES_PACK.to_string(),
                phase: progress_phase.to_string(),
                received,
                total,
                speed_bps: 0.0,
                detail: Some(serde_json::json!({ "segment": segment, "segments": segments })),
                error,
            },
        );
    }
}

/// Transfer one archive through the unified download hub: the shared
/// mirror ladder, a single writer into the part file, cross-pass resume
/// for the content-addressed full pack, and a mirror dying mid-stream
/// failing over to the next candidate FROM THE COMMITTED OFFSET (the
/// progress bar no longer restarts from zero on a mirror switch). The
/// generous overall timeout only caps a stalled transfer — a healthy slow
/// link streams well within it. `segment`/`segments`/`base_*` carry the
/// multi-segment progress aggregation (full download = segment 1 of 1; a
/// chain patch = its index over the pass total).
#[allow(clippy::too_many_arguments)]
async fn download_archive(
    app: Option<&AppHandle>,
    url: &str,
    dest: &Path,
    expected_sha256: Option<&str>,
    expected_size: u64,
    resume: bool,
    segment: u32,
    segments: u32,
    base_received: u64,
    base_total: u64,
) -> Result<(), String> {
    download_hub::transfer(
        app,
        DownloadRequest {
            expected_sha256: expected_sha256.map(str::to_string),
            timeout: Some(Duration::from_secs(3600)),
            resume,
            base_received,
            base_total,
            total_hint: expected_size,
            detail: Some(serde_json::json!({ "segment": segment, "segments": segments })),
            ..DownloadRequest::new(
                JOB_ID,
                kind::RES_PACK,
                super::github_mirror::candidates(url),
                dest.to_path_buf(),
            )
        },
    )
    .await
    .map(|_| ())
}

// ── Staging / publication ─────────────────────────────────────────────────

/// Clone regular pack files without removing the serving tree. Hard links
/// avoid copying the whole pack when supported; delta writes must replace
/// their destination rather than truncating a shared inode.
fn clone_pack_tree(from: &Path, to: &Path) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(from).map_err(|e| format!("inspect {}: {e}", from.display()))?;
    let linked = meta.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || meta.file_attributes() & 0x400 != 0
    };
    if linked {
        return Err(format!(
            "resource pack contains a filesystem link: {}",
            from.display()
        ));
    }
    if meta.is_dir() {
        fs::create_dir(to).map_err(|e| format!("create {}: {e}", to.display()))?;
        for entry in fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))? {
            let entry = entry.map_err(|e| format!("read directory entry: {e}"))?;
            clone_pack_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        if fs::hard_link(from, to).is_err() {
            fs::copy(from, to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        }
    } else {
        return Err(format!(
            "resource pack contains a non-file entry: {}",
            from.display()
        ));
    }
    Ok(())
}

fn stage_existing_pack(cache: &Path) -> Result<PathBuf, String> {
    let staging = cache.join(STAGING_DIR);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("clean staging dir: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;
    for subdir in SUBDIRS {
        let from = cache.join(subdir);
        if !from.exists() {
            continue;
        }
        if let Err(e) = clone_pack_tree(&from, &staging.join(subdir)) {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    }
    Ok(staging)
}

/// Publish the directories and their stamp together, retaining originals
/// until all renames succeed. The stamp is removed first and published last
/// so an interrupted commit cannot advertise a complete new pack.
fn swap_staging_in(cache: &Path, staging: &Path) -> Result<(), String> {
    if !staging.join(VERSION_FILE).is_file() {
        return Err("staged resource pack has no version stamp".into());
    }
    let backup = cache.join(BACKUP_DIR);
    // The stamp is published last. Its presence means a previous commit
    // finished (or failed before touching the old tree), so a backup left
    // only by cleanup failure can now be retried safely.
    if backup.exists() && cache.join(VERSION_FILE).is_file() {
        fs::remove_dir_all(&backup).map_err(|e| format!("clean committed resource backup: {e}"))?;
    }
    // Never delete an earlier recovery copy to make room for a retry.
    fs::create_dir(&backup)
        .map_err(|e| format!("create resource backup {}: {e}", backup.display()))?;
    let mut saved = Vec::new();
    let mut published = Vec::new();
    let outcome = (|| -> Result<(), String> {
        for name in [VERSION_FILE, SUBDIRS[0], SUBDIRS[1]] {
            let old = cache.join(name);
            if old
                .try_exists()
                .map_err(|e| format!("inspect {name}: {e}"))?
            {
                fs::rename(&old, backup.join(name)).map_err(|e| format!("back up {name}: {e}"))?;
                saved.push(name);
            }
        }
        for name in [SUBDIRS[0], SUBDIRS[1], VERSION_FILE] {
            let new = staging.join(name);
            if new
                .try_exists()
                .map_err(|e| format!("inspect staged {name}: {e}"))?
            {
                fs::rename(&new, cache.join(name)).map_err(|e| format!("publish {name}: {e}"))?;
                published.push(name);
            }
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        let mut rollback_errors = Vec::new();
        for name in published.into_iter().rev() {
            if let Err(e) = fs::rename(cache.join(name), staging.join(name)) {
                rollback_errors.push(format!("unpublish {name}: {e}"));
            }
        }
        for name in saved.into_iter().rev() {
            if name == VERSION_FILE && !rollback_errors.is_empty() {
                // Leave a damaged tree unstamped, with its original stamp
                // in the retained backup alongside any unrestored data.
                continue;
            }
            if let Err(e) = fs::rename(backup.join(name), cache.join(name)) {
                rollback_errors.push(format!("restore {name}: {e}"));
            }
        }
        if rollback_errors.is_empty() {
            let _ = fs::remove_dir(&backup);
            return Err(error);
        }
        return Err(format!(
            "{error}; recovery retained in {}: {}",
            backup.display(),
            rollback_errors.join("; ")
        ));
    }
    // The new pack and its stamp are now committed. A locked old file must
    // not turn a successful update into a rollback or erase the backup.
    if let Err(e) = fs::remove_dir_all(&backup) {
        tracing::warn!("resource backup cleanup {}: {e}", backup.display());
    }
    Ok(())
}

/// Unpack the full-pack tar.gz into `staging` (top-level `models/` +
/// `dogtags/`). Runs on the blocking pool — a ~1.2 GB unpack must not
/// stall the async runtime.
fn unpack_full_blocking(archive: &Path, staging: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let gz = GzDecoder::new(file);
    let mut tar = Archive::new(gz);
    tar.set_preserve_permissions(true);
    tar.unpack(staging)
        .map_err(|e| format!("extract resource pack: {e}"))?;
    if !staging.join("models").is_dir() {
        return Err("archive layout: no top-level models/ directory".to_string());
    }
    Ok(())
}

/// The `delta-manifest.json` inside a delta archive.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaManifest {
    from: String,
    to: String,
    #[serde(default)]
    changed: Vec<DeltaEntry>,
    #[serde(default)]
    removed: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeltaEntry {
    path: String,
    sha256: String,
}

/// Apply one extracted delta (`delta_dir`, holding the delta manifest and
/// the `files/**` payload) to the staged tree. Every changed file is
/// verified against its manifest sha256 BEFORE being copied over the
/// staging tree, and every listed path is validated to stay inside the
/// pack root.
fn apply_delta_blocking(
    delta_dir: &Path,
    staging: &Path,
    expect_from: &str,
    expect_to: &str,
) -> Result<(), String> {
    let manifest_raw = fs::read_to_string(delta_dir.join(DELTA_MANIFEST_FILE))
        .map_err(|e| format!("read {DELTA_MANIFEST_FILE}: {e}"))?;
    let manifest: DeltaManifest = serde_json::from_str(&manifest_raw)
        .map_err(|e| format!("parse {DELTA_MANIFEST_FILE}: {e}"))?;
    if manifest.from != expect_from || manifest.to != expect_to {
        return Err(format!(
            "delta mismatch: archive is {}→{} but the chain expects {expect_from}→{expect_to}",
            manifest.from, manifest.to
        ));
    }
    for entry in &manifest.changed {
        if !safe_rel_path(&entry.path) {
            return Err(format!("unsafe path in delta: {}", entry.path));
        }
        let src = delta_dir.join(DELTA_FILES_PREFIX).join(&entry.path);
        if !src.is_file() {
            return Err(format!("delta missing file: {}", entry.path));
        }
        let got = file_sha256(&src)?;
        if !got.eq_ignore_ascii_case(&entry.sha256) {
            return Err(format!("delta file hash mismatch: {}", entry.path));
        }
        let dest = staging.join(&entry.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        // Staging may share this inode with the serving pack. Unlink only
        // our staged name before copying so a later failed link/cancel can
        // discard staging without having modified the original bytes.
        if dest.exists() {
            fs::remove_file(&dest).map_err(|e| format!("replace staged {}: {e}", entry.path))?;
        }
        fs::copy(&src, &dest).map_err(|e| format!("apply {}: {e}", entry.path))?;
    }
    for path in &manifest.removed {
        if !safe_rel_path(path) {
            return Err(format!("unsafe removal path in delta: {path}"));
        }
        let target = staging.join(path);
        if target.is_file() {
            fs::remove_file(&target).map_err(|e| format!("remove {path}: {e}"))?;
        }
    }
    Ok(())
}

/// Unpack a delta archive into a fresh directory and return it.
fn unpack_delta_blocking(archive: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| format!("clean delta staging: {e}"))?;
    }
    fs::create_dir_all(dest).map_err(|e| format!("create delta staging: {e}"))?;
    let file = File::open(archive).map_err(|e| format!("open delta archive: {e}"))?;
    let gz = GzDecoder::new(file);
    let mut tar = Archive::new(gz);
    tar.set_preserve_permissions(true);
    tar.unpack(dest).map_err(|e| format!("extract delta: {e}"))
}

// ── Install passes ────────────────────────────────────────────────────────

/// Full download + install: fetch the archive (hash-verified), stage it,
/// swap it in, stamp the version. Caller holds the single-flight guard.
async fn full_install(manifest: &ResManifest, app: Option<&AppHandle>) -> Result<(), String> {
    let cache = cache_root()?;
    let tmp = cache.join(PACK_TMP);
    emit_progress(app, phase::DOWNLOAD, 0, manifest.asset_size, 1, 1, None);
    let asset_url = release_download_url(RES_ARCHIVE);
    // The full archive is content-addressed (manifest sha256) — the part
    // file is a safe resume base for a retry of the same version.
    download_archive(
        app,
        &asset_url,
        &tmp,
        Some(&manifest.asset_sha256),
        manifest.asset_size,
        true,
        1,
        1,
        0,
        0,
    )
    .await?;

    emit_progress(app, phase::APPLY, 0, 0, 1, 1, None);
    // A cancel that lands mid-extract lets the (already verified) archive
    // finish unpacking and publishing; cancellation does not interrupt the
    // commit/rollback sequence. A full pack is a complete snapshot, so it
    // starts in an empty staging tree and drops files the new version omits.
    let staging = cache.join(STAGING_DIR);
    if staging.exists() {
        if let Err(e) = fs::remove_dir_all(&staging) {
            return Err(format!("clean staging dir: {e}"));
        }
    }
    fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;
    let archive = tmp.clone();
    let cache_for_task = cache.clone();
    let tree_sha256 = manifest.tree_sha256.clone();
    let version = manifest.version.clone();
    let outcome = tokio::task::spawn_blocking({
        let staging = staging.clone();
        move || -> Result<(), String> {
            unpack_full_blocking(&archive, &staging)?;
            write_local_version(&staging, &tree_sha256, &version)?;
            swap_staging_in(&cache_for_task, &staging)
        }
    })
    .await
    .map_err(|e| format!("extract task: {e}"))
    .and_then(|r| r);
    // Staging holds only new files. Originals remain in the serving cache
    // or, if rollback itself failed, in the separate recovery backup.
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&tmp);
    outcome?;
    emit_progress(app, phase::DONE, 0, 0, 1, 1, None);
    Ok(())
}

/// Chain-patch install: stage the existing tree, download + verify + apply
/// every delta link, swap back in, stamp the final hash. Caller holds the
/// single-flight guard.
async fn delta_install(
    chain: &[DeltaEdge],
    manifest: &ResManifest,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let cache = cache_root()?;
    let staging = tokio::task::spawn_blocking({
        let cache = cache.clone();
        move || stage_existing_pack(&cache)
    })
    .await
    .map_err(|e| format!("stage resource pack: {e}"))??;

    let result = async {
        let delta_tmp = cache.join(DELTA_TMP);
        let delta_dir = cache.join(DELTA_STAGING_DIR);
        let base_total: u64 = chain.iter().map(|e| e.size).sum();
        let mut done_bytes = 0u64;
        let segments = chain.len() as u32;
        for (idx, edge) in chain.iter().enumerate() {
            let segment = idx as u32 + 1;
            // The delta archive itself is not pre-hashed on the wire;
            // every file inside it IS, and apply verifies each one. The
            // scratch part name is shared by every link of the chain, so
            // no resume base is carried between segments.
            download_archive(
                app,
                &edge.url,
                &delta_tmp,
                None,
                edge.size,
                false,
                segment,
                segments,
                done_bytes,
                // received accumulates over the whole chain, so the
                // total must too: chain total minus this segment (the
                // segment's own Content-Length completes it).
                base_total.saturating_sub(edge.size),
            )
            .await?;
            emit_progress(
                app,
                phase::APPLY,
                done_bytes + edge.size,
                base_total,
                segment,
                segments,
                None,
            );
            let outcome = tokio::task::spawn_blocking({
                let delta_tmp = delta_tmp.clone();
                let delta_dir = delta_dir.clone();
                let staging = staging.clone();
                let from = edge.from.clone();
                let to = edge.to.clone();
                move || -> Result<(), String> {
                    unpack_delta_blocking(&delta_tmp, &delta_dir)?;
                    apply_delta_blocking(&delta_dir, &staging, &from, &to)
                }
            })
            .await
            .map_err(|e| format!("apply task: {e}"))
            .and_then(|r| r);
            outcome?;
            done_bytes += edge.size;
            let _ = fs::remove_file(&delta_tmp);
            let _ = fs::remove_dir_all(&delta_dir);
        }
        write_local_version(&staging, &manifest.tree_sha256, &manifest.version)?;
        swap_staging_in(&cache, &staging)?;
        let _ = fs::remove_dir_all(&staging);
        emit_progress(app, phase::DONE, 0, 0, segments, segments, None);
        Ok::<(), String>(())
    }
    .await;

    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(cache.join(DELTA_TMP));
        let _ = fs::remove_dir_all(cache.join(DELTA_STAGING_DIR));
    }
    result
}

/// Shared body of `res_download` and `ensure_res_pack`: resolve the local
/// hash + remote manifest, then run a full or chain-patch install. The
/// `prefer_delta` flag distinguishes the panel path (chain when possible)
/// from the startup path (full install only — it only runs when the pack
/// is missing anyway); mobile passes `false` unconditionally (the chain
/// base may be the read-only bundle — see the module docs).
async fn install_latest(
    app: Option<&AppHandle>,
    client: &Client,
    prefer_delta: bool,
) -> Result<(), String> {
    let cache = cache_root()?;
    let manifest = fetch_manifest(client).await?;
    let local = effective_local_version(&cache);
    if let Some(hash) = local.tree_sha256.as_deref() {
        if hash == manifest.tree_sha256 {
            // Already current — the panel seeds a progress entry before
            // invoking, so close it out (a silent Ok would strand the UI
            // on a dead progress bar until restart).
            emit_progress(app, phase::DONE, 0, 0, 1, 1, None);
            return Ok(());
        }
    }
    // Chain patches require a known local hash AND a healthy staged tree —
    // a missing models/ directory means the stamp is stale and the chain
    // would patch a ghost. A failed delta-tag lookup downgrades to the
    // full archive (the manifest itself is clearly reachable here, so the
    // full download is viable; rate-limited api.github.com must not block
    // a download the mirrors could serve).
    if prefer_delta && local.tree_sha256.is_some() && dir_populated(&cache.join("models")) {
        match fetch_delta_edges(client).await {
            Ok(edges) => {
                let chain = delta_chain(
                    &edges,
                    local.tree_sha256.as_deref().unwrap_or(""),
                    &manifest.tree_sha256,
                );
                if !chain.is_empty() {
                    tracing::info!(steps = chain.len(), "applying resource-pack chain patches");
                    return delta_install(&chain, &manifest, app).await;
                }
            },
            Err(e) => tracing::warn!("delta discovery failed, falling back to full: {e}"),
        }
    }
    full_install(&manifest, app).await
}

/// Ensure the resource pack is present (startup / on-demand path, no
/// progress events).
///
/// Returns the cache root directory (the parent of `models/` /
/// `dogtags/`) so the frontend can construct paths like
/// `<root>/models/ships/X.glb`.
///
/// Fast path when the cached hash matches the manifest. Hash-unknown
/// states (legacy stamps, installer-shipped packs) count as PRESENT but
/// are never silently re-pulled — the updates panel surfaces them. When no
/// manifest is reachable, whatever is on disk still serves (offline
/// machines fall back to the installer-shipped pack).
async fn ensure_pack() -> Result<String, String> {
    // Mobile: the APK bundle exists by construction — ensure NEVER pulls a
    // ~1.2 GB archive on first launch. Hand out the serving cache root when
    // a downloaded update is current enough to serve; otherwise answer with
    // the bundled-in-use marker so the webui keeps its same-origin URLs.
    #[cfg(mobile)]
    {
        return match mobile_serving_root()? {
            Some(root) => Ok(root),
            None => Err(MOBILE_BUNDLED_IN_USE.to_string()),
        };
    }
    // Desktop path continues below (compiled out on mobile).
    #[cfg(not(mobile))]
    {
        let cache = cache_root()?;
        let client = crate::commands::network::build_http_client()?;

        // Route through the SAME single-flight guard the panel download uses.
        // While another download holds the guard, sleep and retry — once
        // ACQUIRED, the install pass re-resolves everything locally against
        // the freshest manifest, so a download that finished meanwhile is
        // detected as a no-op. Patience is bounded (~2 minutes) so a stuck
        // download falls through to the on-disk fallback below instead of
        // hanging forever.
        const WAIT_SLOT: Duration = Duration::from_millis(750);
        const WAIT_SLOTS: u32 = 160;
        let mut held = false;
        let mut waited: u32 = 0;
        let installed = loop {
            let blocked = {
                let mut guard = DOWNLOAD_ACTIVE.lock().map_err(|_| "lock poisoned")?;
                if *guard {
                    true
                } else {
                    *guard = true;
                    held = true;
                    false
                }
            };
            if !blocked {
                // The pack may have landed while we waited for the guard —
                // one manifest fetch + local hash compare settles it.
                let manifest = fetch_manifest(&client).await.ok();
                let local = read_local_version(&cache);
                if let (Some(m), Some(h)) = (&manifest, local.tree_sha256.as_deref()) {
                    if h == m.tree_sha256 {
                        tracing::info!(?cache, "resource pack up to date");
                        break Ok(());
                    }
                }
                // Hash-unknown but populated → keep it, the panel offers the
                // one-time migration download; only a MISSING pack pulls the
                // full archive here.
                if dir_populated(&cache.join("models")) {
                    tracing::info!(
                        ?cache,
                        "resource pack present (hash unknown) — deferring to panel"
                    );
                    break Ok(());
                }
                // Same stale-cancel hygiene as res_download: the
                // automatic pass must not inherit a cancel aimed at an
                // earlier, already-finished pass.
                download_hub::clear_pending(kind::RES_PACK, JOB_ID);
                break install_latest(None, &client, false).await;
            }
            waited += 1;
            if waited >= WAIT_SLOTS {
                break Err("a resource-pack download stayed in flight for too long".to_string());
            }
            tracing::info!("resource-pack download in flight, waiting");
            tokio::time::sleep(WAIT_SLOT).await;
        };

        if held {
            if let Ok(mut guard) = DOWNLOAD_ACTIVE.lock() {
                *guard = false;
            }
        }

        // Offline / failed install: an installer-shipped or legacy pack on
        // disk still serves — otherwise the frontend falls back to the
        // embedded publicDir snapshot.
        if installed.is_err() && dir_populated(&cache.join("models")) {
            tracing::warn!(
                ?cache,
                "using on-disk resource pack (install failed or offline)"
            );
            return Ok(cache.to_string_lossy().to_string());
        }

        installed.map(|(): ()| cache.to_string_lossy().to_string())
    }
}

// ── Updates-panel commands (Settings) ─────────────────────────────────────

/// Local state of the pack: presence, hash stamp, size, in-flight flag.
/// No network; the size walk over a ~1.2 GB tree runs on the blocking
/// pool so the IPC thread stays responsive.
///
/// Mobile: the EFFECTIVE serving identity — the cache stamp when a
/// downloaded pack serves, the reported bundled baseline otherwise (a
/// stale cache is shadowed by the bundle). `present` counts the bundle,
/// so a bundled-only install never reports a missing pack.
#[tauri::command]
pub async fn get_res_status() -> Result<ResStatus, String> {
    let cache = cache_root()?;
    let status = tokio::task::spawn_blocking(move || -> ResStatus {
        let local = read_local_version(&cache);
        let cache_populated = SUBDIRS.iter().any(|s| dir_populated(&cache.join(s)));

        #[cfg(mobile)]
        {
            let base = bundled_baseline();
            let cache_serves = cache_populated && cache_supersedes_baseline(&local, base.as_ref());
            let (tree_sha256, version) = if cache_serves {
                (
                    local.tree_sha256.clone().filter(|h| !h.is_empty()),
                    local.version.clone().filter(|v| !v.is_empty()),
                )
            } else {
                base.as_ref()
                    .map(|b| (Some(b.tree_sha256.clone()), Some(b.version.clone())))
                    .unwrap_or((None, None))
            };
            ResStatus {
                present: cache_populated || base.is_some(),
                tree_sha256,
                version,
                legacy_stamp: has_legacy_stamp(&cache),
                size_bytes: SUBDIRS.iter().map(|s| dir_size(&cache.join(s))).sum(),
                downloading: is_downloading(),
                bundled: !cache_serves,
            }
        }

        #[cfg(not(mobile))]
        ResStatus {
            present: cache_populated,
            tree_sha256: local.tree_sha256.filter(|h| !h.is_empty()),
            version: local.version.filter(|v| !v.is_empty()),
            legacy_stamp: has_legacy_stamp(&cache),
            size_bytes: SUBDIRS.iter().map(|s| dir_size(&cache.join(s))).sum(),
            downloading: is_downloading(),
            bundled: false,
        }
    })
    .await
    .map_err(|e| format!("status task: {e}"))?;
    Ok(status)
}

/// Remote state: manifest hash/timestamp, whether a download is possible,
/// and the chain-patch path (empty chain = full download required; `None`
/// = delta lookup failed, UI stays silent about it).
///
/// Mobile: the comparison base is the EFFECTIVE serving hash (cache when
/// current, bundled baseline otherwise), and an available update always
/// reports an empty chain — mobile installs are full-download-only (the
/// chain base may be the read-only bundle), so the delta graph is never
/// even queried.
#[tauri::command]
pub async fn check_res_update() -> Result<ResUpdate, String> {
    let cache = cache_root()?;
    let client = crate::commands::network::build_http_client()?;
    let manifest = fetch_manifest(&client).await.ok();
    let local = read_local_version(&cache);

    // The serving identity: plain cache stamp on desktop; on mobile a
    // cache outranked by the bundle is invisible (the bundle's hash is
    // what an update must be compared against and supersede).
    #[cfg(mobile)]
    let local_hash: Option<String> = {
        let base = bundled_baseline();
        let cache_serves = dir_populated(&cache.join("models"))
            && local.tree_sha256.is_some()
            && cache_supersedes_baseline(&local, base.as_ref());
        if cache_serves {
            local.tree_sha256
        } else {
            base.map(|b| b.tree_sha256)
        }
    };
    #[cfg(not(mobile))]
    let local_hash: Option<String> = local.tree_sha256;

    let (latest_tree, latest_version, update_available) = match &manifest {
        Some(m) => {
            let differs = local_hash.as_deref() != Some(m.tree_sha256.as_str());
            (
                Some(m.tree_sha256.clone()),
                Some(m.version.clone()),
                differs,
            )
        },
        None => (None, None, false),
    };

    #[cfg(mobile)]
    let delta_steps = if update_available {
        // Definitive: a full download is the only mobile path.
        Some(Vec::new())
    } else {
        None
    };

    #[cfg(not(mobile))]
    let delta_steps =
        if update_available && local_hash.is_some() && dir_populated(&cache.join("models")) {
            match fetch_delta_edges(&client).await {
                Ok(edges) => {
                    let chain = delta_chain(
                        &edges,
                        local_hash.as_deref().unwrap_or(""),
                        manifest
                            .as_ref()
                            .map(|m| m.tree_sha256.as_str())
                            .unwrap_or(""),
                    );
                    Some(chain.iter().map(Into::into).collect())
                },
                Err(e) => {
                    tracing::warn!("delta discovery failed: {e}");
                    None
                },
            }
        } else if update_available {
            // No local hash (fresh / legacy cache) — a full download is the
            // only path, state that definitively.
            Some(Vec::new())
        } else {
            None
        };
    Ok(ResUpdate {
        latest_tree_sha256: latest_tree,
        latest_version,
        update_available,
        delta_steps,
    })
}

/// Explicit download (initial, migration or update) of the pack, streaming
/// progress through the unified `wowsp://download-progress` channel. Prefers the chain-patch path
/// when one exists; falls back to the hash-verified full archive. Mobile
/// skips the chain entirely (full download only — see module docs).
/// Single-flight: a second call while a pass is in flight is rejected.
#[tauri::command]
pub async fn res_download(app: AppHandle) -> Result<(), String> {
    // Build the client BEFORE taking the guard — an early error here must
    // not leak the single-flight slot.
    let client = crate::commands::network::build_http_client()?;
    {
        let mut guard = DOWNLOAD_ACTIVE.lock().map_err(|_| "lock poisoned")?;
        if *guard {
            return Err("a resource-pack download is already in flight".to_string());
        }
        *guard = true;
    }
    // Drop a stale cancel pressed while no pass was registered (e.g.
    // during the previous pass's apply tail) - THIS attempt is
    // user-initiated and must not inherit it.
    download_hub::clear_pending(kind::RES_PACK, JOB_ID);
    // cfg! keeps one code path; the mobile false is folded at compile time.
    let result = install_latest(Some(&app), &client, !cfg!(mobile)).await;
    if let Err(e) = &result {
        emit_progress(Some(&app), phase::ERROR, 0, 0, 0, 0, Some(e.clone()));
    }
    if let Ok(mut guard) = DOWNLOAD_ACTIVE.lock() {
        *guard = false;
    }
    result
}

/// Cancel the in-flight pack pass (cooperative: the hub's streaming loop
/// stops at the next chunk boundary and KEEPS the part file as the resume
/// base of a later retry; an apply phase that is already running finishes
/// — the swap-based installer never leaves a partial pack, so aborting it
/// locally would only discard completed work).
#[tauri::command]
pub fn res_cancel() -> Result<(), String> {
    download_hub::cancel(kind::RES_PACK, JOB_ID);
    Ok(())
}

/// Delete the pack's cache sub-directories + version stamp. Refused while
/// a pass is in flight. The recursive delete runs on the blocking pool so
/// a ~1.2 GB tree removal cannot freeze the IPC thread. On mobile this
/// only ever deletes the DOWNLOADED update copy — the APK bundle takes
/// over serving immediately afterwards, so clearing can never brick the
/// app.
#[tauri::command]
pub async fn clear_res() -> Result<(), String> {
    if is_downloading() {
        return Err("resource pack is downloading — cancel it first".to_string());
    }
    let cache = cache_root()?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        for name in SUBDIRS
            .iter()
            .map(|s| s.to_string())
            .chain([STAGING_DIR, DELTA_STAGING_DIR, BACKUP_DIR].map(|s| s.to_string()))
        {
            let dir = cache.join(&name);
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| format!("remove {name}: {e}"))?;
            }
        }
        for file in [VERSION_FILE, PACK_TMP, DELTA_TMP] {
            let p = cache.join(file);
            if p.is_file() {
                let _ = fs::remove_file(&p);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("clear task: {e}"))?
}

// ── Auxiliary caches (Settings panel) ─────────────────────────────────────

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
pub async fn aux_cache_overview() -> Result<Vec<wowsp_tauri_shared::AuxCacheStatus>, String> {
    let scopes = tokio::task::spawn_blocking(|| -> Vec<wowsp_tauri_shared::AuxCacheStatus> {
        ["image-cache", "gameparams", "encyclopedia", "community"]
            .iter()
            .map(|scope| {
                let size = aux_cache_dir(scope).map(|d| dir_size(&d)).unwrap_or(0);
                wowsp_tauri_shared::AuxCacheStatus {
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

// ── Startup / on-demand ensure command ────────────────────────────────────

/// The single resource pack (GLB models + dog-tag parts). See module docs.
#[tauri::command]
pub async fn ensure_res_pack() -> Result<String, String> {
    ensure_pack().await
}

/// Local-only model-pack cache root: the cache dir once the pack is on
/// disk (`models/` populated), `None` otherwise. Wiring the asset protocol
/// through this skips the remote manifest check `ensure_res_pack` performs
/// — a present pack serves models without touching the network.
///
/// Mobile: the same question narrowed to "does the downloaded update
/// serve?" — a stale (older-than-bundle) or unstamped cache yields `None`
/// and the webui keeps its same-origin bundled URLs.
#[tauri::command]
pub async fn res_cache_root() -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        return mobile_serving_root();
    }
    #[cfg(not(mobile))]
    {
        let cache = cache_root()?;
        if dir_populated(&cache.join("models")) {
            Ok(Some(cache.to_string_lossy().to_string()))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PackFixture(PathBuf);

    impl PackFixture {
        fn new() -> Self {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let root = std::env::temp_dir().join(format!("wowsp-pack-{}", hex::encode(nonce)));
            fs::create_dir_all(root.join("models")).unwrap();
            fs::create_dir(root.join("dogtags")).unwrap();
            fs::write(root.join("models/a.glb"), b"old-a").unwrap();
            fs::write(root.join("models/b.glb"), b"old-b").unwrap();
            fs::write(root.join("dogtags/old.png"), b"old-tag").unwrap();
            write_local_version(&root, &hash(1), "old").unwrap();
            Self(root)
        }

        fn delta(&self, name: &str, corrupt_second: bool) -> PathBuf {
            let delta = self.0.join(name);
            fs::create_dir_all(delta.join("files/models")).unwrap();
            fs::write(delta.join("files/models/a.glb"), b"new-a").unwrap();
            fs::write(delta.join("files/models/b.glb"), b"new-b").unwrap();
            let digest = |name: &str| file_sha256(&delta.join("files/models").join(name)).unwrap();
            let manifest = serde_json::json!({
                "from": hash(1), "to": hash(2),
                "changed": [
                    {"path": "models/a.glb", "sha256": digest("a.glb")},
                    {"path": "models/b.glb", "sha256": if corrupt_second { hash(0) } else { digest("b.glb") }}
                ],
                "removed": ["dogtags/old.png"]
            });
            fs::write(delta.join(DELTA_MANIFEST_FILE), manifest.to_string()).unwrap();
            delta
        }

        fn assert_original(&self) {
            assert_eq!(fs::read(self.0.join("models/a.glb")).unwrap(), b"old-a");
            assert_eq!(fs::read(self.0.join("models/b.glb")).unwrap(), b"old-b");
            assert_eq!(
                fs::read(self.0.join("dogtags/old.png")).unwrap(),
                b"old-tag"
            );
            assert_eq!(read_local_version(&self.0).tree_sha256, Some(hash(1)));
        }
    }

    impl Drop for PackFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn corrupt_delta_preserves_the_serving_pack_and_its_stamp() {
        let fixture = PackFixture::new();
        let staging = stage_existing_pack(&fixture.0).unwrap();
        fixture.assert_original();
        let delta = fixture.delta("bad-delta", true);
        assert!(apply_delta_blocking(&delta, &staging, &hash(1), &hash(2)).is_err());
        // The first entry was applied before the second entry failed.
        assert_eq!(fs::read(staging.join("models/a.glb")).unwrap(), b"new-a");
        fs::remove_dir_all(staging).unwrap();
        fixture.assert_original();
    }

    #[test]
    fn cancellation_between_delta_links_discards_changes_and_removals() {
        let fixture = PackFixture::new();
        let staging = stage_existing_pack(&fixture.0).unwrap();
        let delta = fixture.delta("good-delta", false);
        apply_delta_blocking(&delta, &staging, &hash(1), &hash(2)).unwrap();
        assert!(!staging.join("dogtags/old.png").exists());
        fixture.assert_original();
        // A cancelled or failed download of the next link discards staging.
        fs::remove_dir_all(staging).unwrap();
        fixture.assert_original();
    }

    #[test]
    fn completed_delta_publishes_the_pack_and_stamp_together() {
        let fixture = PackFixture::new();
        let staging = stage_existing_pack(&fixture.0).unwrap();
        let delta = fixture.delta("good-delta", false);
        apply_delta_blocking(&delta, &staging, &hash(1), &hash(2)).unwrap();
        write_local_version(&staging, &hash(2), "new").unwrap();
        swap_staging_in(&fixture.0, &staging).unwrap();
        assert_eq!(fs::read(fixture.0.join("models/a.glb")).unwrap(), b"new-a");
        assert_eq!(fs::read(fixture.0.join("models/b.glb")).unwrap(), b"new-b");
        assert!(!fixture.0.join("dogtags/old.png").exists());
        assert_eq!(read_local_version(&fixture.0).tree_sha256, Some(hash(2)));
        assert!(!fixture.0.join(BACKUP_DIR).exists());
    }

    #[cfg(windows)]
    #[test]
    fn publish_failure_restores_all_original_directories_and_stamp() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = PackFixture::new();
        let staging = stage_existing_pack(&fixture.0).unwrap();
        let delta = fixture.delta("good-delta", false);
        apply_delta_blocking(&delta, &staging, &hash(1), &hash(2)).unwrap();
        write_local_version(&staging, &hash(2), "new").unwrap();
        // Fail the LAST publish step, after both new directories landed.
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(staging.join(VERSION_FILE))
            .unwrap();
        assert!(swap_staging_in(&fixture.0, &staging).is_err());
        fixture.assert_original();
        assert!(!fixture.0.join(BACKUP_DIR).exists());
        drop(lock);
    }

    #[test]
    fn full_snapshot_removes_an_omitted_old_subdirectory() {
        let fixture = PackFixture::new();
        let staging = fixture.0.join(STAGING_DIR);
        fs::create_dir_all(staging.join("models")).unwrap();
        fs::write(staging.join("models/new.glb"), b"new").unwrap();
        write_local_version(&staging, &hash(2), "new").unwrap();
        swap_staging_in(&fixture.0, &staging).unwrap();
        assert!(!fixture.0.join("models/a.glb").exists());
        assert!(!fixture.0.join("dogtags").exists());
        assert_eq!(read_local_version(&fixture.0).tree_sha256, Some(hash(2)));
    }

    #[test]
    fn incomplete_recovery_backup_is_not_deleted_by_a_retry() {
        let fixture = PackFixture::new();
        let backup = fixture.0.join(BACKUP_DIR);
        fs::create_dir(&backup).unwrap();
        fs::rename(fixture.0.join(VERSION_FILE), backup.join(VERSION_FILE)).unwrap();
        let staging = stage_existing_pack(&fixture.0).unwrap();
        write_local_version(&staging, &hash(2), "new").unwrap();
        assert!(swap_staging_in(&fixture.0, &staging).is_err());
        assert_eq!(read_local_version(&backup).tree_sha256, Some(hash(1)));
        assert!(fixture.0.join("models/a.glb").is_file());
        assert!(!fixture.0.join(VERSION_FILE).exists());
    }

    fn edge(from: &str, to: &str) -> DeltaEdge {
        DeltaEdge {
            from: from.to_string(),
            to: to.to_string(),
            url: format!("https://example.invalid/{from}-{to}"),
            size: 10,
        }
    }

    fn hash(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    #[test]
    fn delta_tags_parse_into_hash_pairs() {
        let tag = format!("res-delta-{}-{}", hash(1), hash(2));
        assert_eq!(parse_delta_tag(&tag), Some((hash(1), hash(2))));
    }

    #[test]
    fn delta_tags_reject_malformed_shapes() {
        assert_eq!(parse_delta_tag("res-latest"), None);
        assert_eq!(parse_delta_tag("res-delta-short-short"), None);
        assert_eq!(parse_delta_tag(&format!("res-delta-{}-xyz", hash(1))), None);
        assert_eq!(
            parse_delta_tag(&format!("res-delta-{}-{}-extra", hash(1), hash(2))),
            None
        );
    }

    #[test]
    fn delta_chain_walks_a_linear_run() {
        let edges = vec![edge(&hash(1), &hash(2)), edge(&hash(2), &hash(3))];
        let chain = delta_chain(&edges, &hash(1), &hash(3));
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].from, hash(1));
        assert_eq!(chain[1].to, hash(3));
        // Already current → empty chain.
        assert!(delta_chain(&edges, &hash(3), &hash(3)).is_empty());
        // Local hash outside the chain → no path (→ full download).
        assert!(delta_chain(&edges, &hash(9), &hash(3)).is_empty());
    }

    #[test]
    fn safe_rel_path_blocks_traversal() {
        assert!(safe_rel_path("models/ships/1.glb"));
        assert!(safe_rel_path("dogtags/PCNP053.png"));
        assert!(!safe_rel_path(""));
        assert!(!safe_rel_path("/models/x.glb"));
        assert!(!safe_rel_path("\\models\\x.glb"));
        assert!(!safe_rel_path("models/../../escape.glb"));
        assert!(!safe_rel_path("C:/models/x.glb"));
    }

    #[test]
    fn local_version_roundtrips_as_camel_case() {
        let dir = std::env::temp_dir().join(format!("wowsp-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        write_local_version(&dir, &hash(7), "2026-09-21T00:00:00Z").unwrap();
        let v = read_local_version(&dir);
        assert_eq!(v.tree_sha256.as_deref(), Some(hash(7).as_str()));
        assert_eq!(v.version.as_deref(), Some("2026-09-21T00:00:00Z"));
        fs::remove_dir_all(&dir).unwrap();
    }

    fn baseline(version: &str) -> BundledBaseline {
        BundledBaseline {
            tree_sha256: hash(3),
            version: version.to_string(),
        }
    }

    fn local(hash_opt: Option<String>, version: Option<String>) -> LocalVersion {
        LocalVersion {
            tree_sha256: hash_opt,
            version,
        }
    }

    #[test]
    fn cache_supersedes_when_no_baseline_is_reported() {
        // Unknown bundle (older APK without the manifest) — a downloaded
        // cache serves unconditionally.
        assert!(cache_supersedes_baseline(&local(None, None), None));
        assert!(cache_supersedes_baseline(
            &local(Some(hash(9)), Some("2026-01-01T00:00:00Z".into())),
            None
        ));
    }

    #[test]
    fn cache_supersedes_by_published_at_ordering() {
        let base = baseline("2026-06-01T00:00:00Z");
        // Newer cache stamp wins.
        assert!(cache_supersedes_baseline(
            &local(Some(hash(1)), Some("2026-06-02T00:00:00Z".into())),
            Some(&base)
        ));
        // Same stamp (the identical pack) wins.
        assert!(cache_supersedes_baseline(
            &local(Some(hash(3)), Some("2026-06-01T00:00:00Z".into())),
            Some(&base)
        ));
        // Older cache loses to the newer bundle (app update refreshed it).
        assert!(!cache_supersedes_baseline(
            &local(Some(hash(1)), Some("2026-05-31T23:59:59Z".into())),
            Some(&base)
        ));
    }

    #[test]
    fn unstamped_cache_only_survives_an_identical_hash() {
        let base = baseline("2026-06-01T00:00:00Z");
        // Same tree hash, missing version — treat as the same pack.
        assert!(cache_supersedes_baseline(
            &local(Some(hash(3)), None),
            Some(&base)
        ));
        // Different tree hash, no version to order by — bundle wins.
        assert!(!cache_supersedes_baseline(
            &local(Some(hash(1)), None),
            Some(&base)
        ));
    }

    #[test]
    fn res_report_bundled_rejects_malformed_input() {
        assert!(res_report_bundled("short".into(), "2026-06-01T00:00:00Z".into()).is_err());
        assert!(
            res_report_bundled(
                format!("{:x}", 0xdeadbeef_u32),
                "2026-06-01T00:00:00Z".into()
            )
            .is_err()
        );
        assert!(res_report_bundled(hash(1), "".into()).is_err());
        assert!(res_report_bundled(hash(1), "   ".into()).is_err());
    }
}
