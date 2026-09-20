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
//! mirror (Settings → updates, stored in network-config.json) first, then a
//! direct connection, then the built-in ghproxy-style mirrors — so mainland
//! China networks can pin a working prefix instead of waiting out the dead
//! direct attempt.
//!
//! Installs are ATOMIC: extraction and patch application happen inside a
//! `.res-staging` directory (existing sub-directories are moved in, patched,
//! then swapped back), so a cancel, corrupt archive or failed check restores
//! the previous pack instead of leaving a half-new/half-old mix — the exact
//! failure mode the legacy `updated_at` overwrite scheme produced.
//!
//! `ensure_res_pack` keeps its historical fire-and-forget contract for the
//! startup / on-demand paths (skip when the hash matches; an installer-
//! shipped or legacy-stamped pack counts as present), while `res_download`
//! is the panel's explicit download: streaming, progress events
//! (`wowsp://res-progress`) and cancellable.

use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use flate2::read::GzDecoder;
use reqwest::Client;
use sha2::{Digest, Sha256};
use tar::Archive;
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{ResProgress, ResStatus, ResUpdate};

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
const PACK_TMP: &str = ".res-pack.download";
const DELTA_TMP: &str = ".res-delta.download";
const DELTA_STAGING_DIR: &str = ".res-delta-staging";

pub const RES_PROGRESS_EVENT: &str = "wowsp://res-progress";

/// Built-in ghproxy-style mirror prefixes (the same set the updater races
/// and mod-catalog falls back to). Tried AFTER a direct connection so they
/// only carry traffic the direct route cannot.
const BUILTIN_MIRRORS: [&str; 4] = [
    "https://ghp.ci/",
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://ghproxy.net/",
];

/// In-flight download bookkeeping (single-flight — there is exactly one
/// pack now) plus a cooperative cancel flag the panel sets mid-stream.
static DOWNLOAD_ACTIVE: Mutex<bool> = Mutex::new(false);
static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

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
    let raw = serde_json::json!({ "treeSha256": tree_sha256, "version": version })
        .to_string();
    fs::write(cache.join(VERSION_FILE), raw)
        .map_err(|e| format!("write version stamp: {e}"))
}

/// Whether a LEGACY stamp exists without a hash stamp — the cache predates
/// the hash scheme and its content hash is unknowable.
fn has_legacy_stamp(cache: &Path) -> bool {
    read_local_version(cache).tree_sha256.is_none()
        && LEGACY_STAMPS
            .iter()
            .any(|s| cache.join(s).is_file())
}

// ── Mirror ladder ─────────────────────────────────────────────────────────

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
    for candidate in mirror_candidates(&url) {
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
    for candidate in mirror_candidates(&api_url) {
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
            let Some(tag) = release["tag_name"].as_str() else { continue };
            let Some((from, to)) = parse_delta_tag(tag) else {
                continue;
            };
            for asset in release["assets"].as_array().into_iter().flatten() {
                if asset["name"].as_str() == Some(DELTA_ARCHIVE) {
                    if let Some(url) = asset["browser_download_url"].as_str() {
                        edges.push(DeltaEdge {
                            from,
                            to,
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
fn delta_chain(
    edges: &[DeltaEdge],
    local: &str,
    latest: &str,
) -> Vec<DeltaEdge> {
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
    let mut goal: Option<usize> = queue
        .iter()
        .copied()
        .find(|i| edges[*i].to == latest);
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

/// Emit a progress event when a handle is available (ensure_* paths run
/// headless without one).
fn emit_progress(app: Option<&AppHandle>, progress: &ResProgress) {
    if let Some(app) = app {
        let _ = app.emit(RES_PROGRESS_EVENT, progress);
    }
}

/// Stream `url` into `dest`, emitting throttled download progress and
/// honouring the cancel flag. When `expected_sha256` is given the stream
/// is hashed and verified, so a truncated or corrupted mirror copy fails
/// BEFORE extraction instead of as a mid-unpack error. The generous overall
/// timeout only caps a stalled transfer — a healthy slow link streams well
/// within it.
async fn download_to_file(
    client: &Client,
    url: &str,
    dest: &Path,
    app: Option<&AppHandle>,
    expected_sha256: Option<&str>,
    expected_size: u64,
    segment: u32,
    segments: u32,
    base_received: u64,
    base_total: u64,
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
    let content_length = resp.content_length().unwrap_or(0);
    let total = if content_length > 0 {
        content_length
    } else {
        expected_size
    };
    let mut file = File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut since_emit = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{url}: {e}"))? {
        if DOWNLOAD_CANCEL.load(Ordering::Relaxed) {
            let _ = fs::remove_file(dest);
            return Err("cancelled".to_string());
        }
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        if expected_sha256.is_some() {
            hasher.update(&chunk);
        }
        received += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        if since_emit >= 262_144 {
            since_emit = 0;
            emit_progress(
                app,
                &ResProgress {
                    phase: "download".into(),
                    received: base_received + received,
                    total: if total > 0 { base_total + total } else { 0 },
                    segment,
                    segments,
                    error: None,
                },
            );
        }
    }
    file.flush().map_err(|e| format!("flush: {e}"))?;
    if let Some(expected) = expected_sha256 {
        let got = hex::encode(hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(dest);
            return Err(format!(
                "{url}: sha256 mismatch (got {}, expected {expected}) — likely a truncated or corrupted mirror copy",
                &got[..got.len().min(12)]
            ));
        }
    }
    Ok(())
}

/// Mirror ladder for one archive download; a dying mirror restarts the
/// progress stream from zero on the next candidate.
async fn download_asset(
    client: &Client,
    url: &str,
    dest: &Path,
    app: Option<&AppHandle>,
    expected_sha256: Option<&str>,
    expected_size: u64,
    segment: u32,
    segments: u32,
    base_received: u64,
    base_total: u64,
) -> Result<(), String> {
    let mut last_err = String::from("no mirror attempted");
    for candidate in mirror_candidates(url) {
        match download_to_file(
            client,
            &candidate,
            dest,
            app,
            expected_sha256,
            expected_size,
            segment,
            segments,
            base_received,
            base_total,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                if e == "cancelled" {
                    let _ = fs::remove_file(dest);
                    return Err(e);
                }
                last_err = e;
            },
        }
    }
    let _ = fs::remove_file(dest);
    Err(format!("download {url}: {last_err}"))
}

// ── Staging / atomic swap ─────────────────────────────────────────────────

/// Move every existing pack sub-directory into a fresh staging root. The
/// renames are same-volume and instant; on failure the caller restores
/// them with [`restore_staging`].
fn move_into_staging(cache: &Path) -> Result<PathBuf, String> {
    let staging = cache.join(STAGING_DIR);
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("clean staging dir: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;
    for subdir in SUBDIRS {
        let from = cache.join(subdir);
        if from.exists() {
            fs::rename(&from, staging.join(subdir))
                .map_err(|e| format!("move {subdir} into staging: {e}"))?;
        }
    }
    Ok(staging)
}

/// Swap the staged sub-directories into the cache root (replacing whatever
/// is there — normally nothing, [`move_into_staging`] took it away).
fn swap_staging_in(cache: &Path, staging: &Path) -> Result<(), String> {
    for subdir in SUBDIRS {
        let staged = staging.join(subdir);
        if !staged.exists() {
            continue;
        }
        let final_dir = cache.join(subdir);
        if final_dir.exists() {
            fs::remove_dir_all(&final_dir)
                .map_err(|e| format!("replace old {subdir} dir: {e}"))?;
        }
        fs::rename(&staged, &final_dir)
            .map_err(|e| format!("move staged {subdir} into place: {e}"))?;
    }
    Ok(())
}

/// Rollback: put staged sub-directories back under the cache root. Only
/// restores directories that are actually missing there — a half-swapped
/// state keeps its already-swapped (newer) halves.
fn restore_staging(cache: &Path, staging: &Path) {
    for subdir in SUBDIRS {
        let staged = staging.join(subdir);
        if staged.exists() && !cache.join(subdir).exists() {
            let _ = fs::rename(&staged, cache.join(subdir));
        }
    }
    let _ = fs::remove_dir_all(staging);
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

/// Apply one extracted delta (`delta_dir`, holding `delta-manifest.json`
/// + `files/**`) to the staged tree. Every changed file is verified
/// against its manifest sha256 BEFORE being copied over the staging tree,
/// and every listed path is validated to stay inside the pack root.
fn apply_delta_blocking(delta_dir: &Path, staging: &Path, expect_from: &str, expect_to: &str) -> Result<(), String> {
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
    tar.unpack(dest)
        .map_err(|e| format!("extract delta: {e}"))
}

// ── Install passes ────────────────────────────────────────────────────────

/// Full download + install: fetch the archive (hash-verified), stage it,
/// swap it in, stamp the version. Caller holds the single-flight guard.
async fn full_install(
    manifest: &ResManifest,
    app: Option<&AppHandle>,
    client: &Client,
) -> Result<(), String> {
    let cache = cache_root()?;
    let tmp = cache.join(PACK_TMP);
    emit_progress(
        app,
        &ResProgress {
            phase: "download".into(),
            received: 0,
            total: manifest.asset_size,
            segment: 1,
            segments: 1,
            error: None,
        },
    );
    download_asset(
        client,
        &release_download_url(RES_ARCHIVE),
        &tmp,
        app,
        Some(&manifest.asset_sha256),
        manifest.asset_size,
        1,
        1,
        0,
        0,
    )
    .await?;

    emit_progress(
        app,
        &ResProgress {
            phase: "apply".into(),
            received: 0,
            total: 0,
            segment: 1,
            segments: 1,
            error: None,
        },
    );
    // A cancel that lands mid-extract lets the (already verified) archive
    // finish unpacking — the swap-based installer never leaves a partial
    // pack, so aborting here would only waste the downloaded bytes. The
    // staging root is a FRESH extraction (not a move-in of the previous
    // tree): a full pack is a complete snapshot, so files the new version
    // dropped must not survive the swap.
    let staging = cache.join(STAGING_DIR);
    if staging.exists() {
        if let Err(e) = fs::remove_dir_all(&staging) {
            return Err(format!("clean staging dir: {e}"));
        }
    }
    fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;
    let archive = tmp.clone();
    let cache_for_task = cache.clone();
    let outcome = tokio::task::spawn_blocking({
        let staging = staging.clone();
        move || -> Result<(), String> {
            unpack_full_blocking(&archive, &staging)?;
            swap_staging_in(&cache_for_task, &staging)
        }
    })
    .await
    .map_err(|e| format!("extract task: {e}"))
    .and_then(|r| r);
    // Either way the staging tree itself is disposable: on success its
    // sub-directories have been renamed into the cache root, on failure
    // the previous pack under the cache root was never touched.
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&tmp);
    outcome?;
    write_local_version(&cache, &manifest.tree_sha256, &manifest.version)?;
    emit_progress(
        app,
        &ResProgress {
            phase: "done".into(),
            received: 0,
            total: 0,
            segment: 1,
            segments: 1,
            error: None,
        },
    );
    Ok(())
}

/// Chain-patch install: stage the existing tree, download + verify + apply
/// every delta link, swap back in, stamp the final hash. Caller holds the
/// single-flight guard.
async fn delta_install(
    chain: &[DeltaEdge],
    manifest: &ResManifest,
    app: Option<&AppHandle>,
    client: &Client,
) -> Result<(), String> {
    let cache = cache_root()?;
    let staging = move_into_staging(&cache)?;

    let result = async {
        let delta_tmp = cache.join(DELTA_TMP);
        let delta_dir = cache.join(DELTA_STAGING_DIR);
        let base_total: u64 = chain.iter().map(|e| e.size).sum();
        let mut done_bytes = 0u64;
        let segments = chain.len() as u32;
        for (idx, edge) in chain.iter().enumerate() {
            let segment = idx as u32 + 1;
            download_asset(
                client,
                &edge.url,
                &delta_tmp,
                app,
                // The delta archive itself is not pre-hashed on the wire;
                // every file inside it IS, and apply verifies each one.
                None,
                edge.size,
                segment,
                segments,
                done_bytes,
                0,
            )
            .await?;
            emit_progress(
                app,
                &ResProgress {
                    phase: "apply".into(),
                    received: done_bytes + edge.size,
                    total: base_total,
                    segment,
                    segments,
                    error: None,
                },
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
        swap_staging_in(&cache, &staging)?;
        write_local_version(&cache, &manifest.tree_sha256, &manifest.version)?;
        let _ = fs::remove_dir_all(&staging);
        emit_progress(
            app,
            &ResProgress {
                phase: "done".into(),
                received: 0,
                total: 0,
                segment: segments,
                segments,
                error: None,
            },
        );
        Ok::<(), String>(())
    }
    .await;

    if result.is_err() {
        restore_staging(&cache, &staging);
        let _ = fs::remove_file(cache.join(DELTA_TMP));
        let _ = fs::remove_dir_all(cache.join(DELTA_STAGING_DIR));
    }
    result
}

/// Shared body of `res_download` and `ensure_res_pack`: resolve the local
/// hash + remote manifest, then run a full or chain-patch install. The
/// `prefer_delta` flag distinguishes the panel path (chain when possible)
/// from the startup path (full install only — it only runs when the pack
/// is missing anyway).
async fn install_latest(
    app: Option<&AppHandle>,
    client: &Client,
    prefer_delta: bool,
) -> Result<(), String> {
    let cache = cache_root()?;
    let manifest = fetch_manifest(client).await?;
    let local = read_local_version(&cache);
    if let Some(hash) = local.tree_sha256.as_deref() {
        if hash == manifest.tree_sha256 {
            return Ok(());
        }
    }
    // Chain patches require a known local hash AND a healthy staged tree —
    // a missing models/ directory means the stamp is stale and the chain
    // would patch a ghost.
    if prefer_delta
        && local.tree_sha256.is_some()
        && dir_populated(&cache.join("models"))
    {
        let edges = fetch_delta_edges(client).await?;
        let chain = delta_chain(&edges, local.tree_sha256.as_deref().unwrap_or(""), &manifest.tree_sha256);
        if !chain.is_empty() {
            tracing::info!(steps = chain.len(), "applying resource-pack chain patches");
            return delta_install(&chain, &manifest, app, client).await;
        }
    }
    full_install(&manifest, app, client).await
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
                DOWNLOAD_CANCEL.store(false, Ordering::Relaxed);
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
                tracing::info!(?cache, "resource pack present (hash unknown) — deferring to panel");
                break Ok(());
            }
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
        tracing::warn!(?cache, "using on-disk resource pack (install failed or offline)");
        return Ok(cache.to_string_lossy().to_string());
    }

    installed.map(|(): ()| cache.to_string_lossy().to_string())
}

// ── Updates-panel commands (Settings) ─────────────────────────────────────

/// Local state of the pack: presence, hash stamp, size, in-flight flag.
/// No network; the size walk over a ~1.2 GB tree runs on the blocking
/// pool so the IPC thread stays responsive.
#[tauri::command]
pub async fn get_res_status() -> Result<ResStatus, String> {
    let cache = cache_root()?;
    let status = tokio::task::spawn_blocking(move || -> ResStatus {
        let local = read_local_version(&cache);
        ResStatus {
            present: SUBDIRS.iter().any(|s| dir_populated(&cache.join(s))),
            tree_sha256: local.tree_sha256.filter(|h| !h.is_empty()),
            version: local.version.filter(|v| !v.is_empty()),
            legacy_stamp: has_legacy_stamp(&cache),
            size_bytes: SUBDIRS.iter().map(|s| dir_size(&cache.join(s))).sum(),
            downloading: is_downloading(),
        }
    })
    .await
    .map_err(|e| format!("status task: {e}"))?;
    Ok(status)
}

/// Remote state: manifest hash/timestamp, whether a download is possible,
/// and the chain-patch path (empty chain = full download required; `None`
/// = delta lookup failed, UI stays silent about it).
#[tauri::command]
pub async fn check_res_update() -> Result<ResUpdate, String> {
    let cache = cache_root()?;
    let client = crate::commands::network::build_http_client()?;
    let manifest = fetch_manifest(&client).await.ok();
    let local = read_local_version(&cache);
    let (latest_tree, latest_version, update_available) = match &manifest {
        Some(m) => {
            let differs = local.tree_sha256.as_deref() != Some(m.tree_sha256.as_str());
            (
                Some(m.tree_sha256.clone()),
                Some(m.version.clone()),
                differs,
            )
        },
        None => (None, None, false),
    };
    let delta_steps = if update_available && local.tree_sha256.is_some() {
        match fetch_delta_edges(&client).await {
            Ok(edges) => {
                let chain = delta_chain(
                    &edges,
                    local.tree_sha256.as_deref().unwrap_or(""),
                    manifest.as_ref().map(|m| m.tree_sha256.as_str()).unwrap_or(""),
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
/// progress through `wowsp://res-progress`. Prefers the chain-patch path
/// when one exists; falls back to the hash-verified full archive.
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
        // Clear any stale cancel request from a previous interaction; the
        // flag is intentionally NOT reset at the end of a download — the
        // next download's start (here or in ensure_res_pack) clears it
        // instead, so a late reset can never erase a cancel aimed at a
        // NEW download.
        DOWNLOAD_CANCEL.store(false, Ordering::Relaxed);
        *guard = true;
    }
    let result = install_latest(Some(&app), &client, true).await;
    if let Err(e) = &result {
        emit_progress(
            Some(&app),
            &ResProgress {
                phase: "error".into(),
                received: 0,
                total: 0,
                segment: 0,
                segments: 0,
                error: Some(e.clone()),
            },
        );
    }
    if let Ok(mut guard) = DOWNLOAD_ACTIVE.lock() {
        *guard = false;
    }
    result
}

/// Cancel the in-flight pack pass (cooperative: checked between chunks and
/// before the version stamp is written).
#[tauri::command]
pub fn res_cancel() -> Result<(), String> {
    DOWNLOAD_CANCEL.store(true, Ordering::Relaxed);
    Ok(())
}

/// Delete the pack's cache sub-directories + version stamp. Refused while
/// a pass is in flight. The recursive delete runs on the blocking pool so
/// a ~1.2 GB tree removal cannot freeze the IPC thread.
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
            .chain(std::iter::once(STAGING_DIR.to_string()))
        {
            let dir = cache.join(&name);
            if dir.exists() {
                fs::remove_dir_all(&dir)
                    .map_err(|e| format!("remove {name}: {e}"))?;
            }
        }
        for file in [VERSION_FILE, PACK_TMP, DELTA_TMP, DELTA_STAGING_DIR] {
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
        assert_eq!(
            parse_delta_tag(&tag),
            Some((hash(1), hash(2)))
        );
    }

    #[test]
    fn delta_tags_reject_malformed_shapes() {
        assert_eq!(parse_delta_tag("res-latest"), None);
        assert_eq!(parse_delta_tag("res-delta-short-short"), None);
        assert_eq!(
            parse_delta_tag(&format!("res-delta-{}-xyz", hash(1))),
            None
        );
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
}
