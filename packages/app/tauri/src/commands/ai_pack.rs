//! The AI model channel: decision models published on Hugging Face.
//!
//! Design contract: docs/en/designs/ai-models.md. The channel replaces the
//! hand-copied decisions pack with one signed manifest fetched through the
//! mirror context (user endpoints, then the built-in mainland mirrors, then
//! the official route), and per-file downloads pinned to the manifest's Hub
//! commit:
//!
//!   1. fetch manifest.json, verify its Ed25519 signature against the
//!      compile-time pinned digest keys, apply the seq ratchet;
//!   2. download every runtime file to a staging tree, sha256-verified by
//!      the download hub;
//!   3. recompute the content tree hash and validate every ONNX file
//!      (kind + widths + feature set) BEFORE the live pack is replaced;
//!   4. swap the directory atomically, write the stamp and the freshness
//!      ledger entry.
//!
//! The channel is compiled only with the ai feature: a portable build has
//! no ONNX Runtime and must never install models it cannot run.

use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::download::{kind, phase};
use wowsp_tauri_shared::{
    AiPackCheck, AiPackFileInfo, AiPackModelState, AiPackStatus, CommandResult,
    DOWNLOAD_PROGRESS_EVENT, DownloadProgress,
};

use super::download_hub::{self, DownloadRequest};
use super::mirror::{MirrorContext, huggingface};
use super::network::HttpPair;
use super::release_digest::{PINNED_DIGEST_KEYS, verify_doc_signature};
use super::upstream_health;
use crate::paths;

/// The public model repository the publisher writes (scripts/publish_ai_models.py).
const AI_REPO: &str = "langyo/wowsp-d1";
/// The unified download-progress job id for the whole install pass.
const JOB_ID: &str = "ai-models";
/// The manifest file name in the Hub repository.
const MANIFEST_NAME: &str = "manifest.json";
/// Staging / backup / stamp names under the cache root (the stamp lives
/// beside decisions/ so the content tree stays pure).
const STAGING_DIR: &str = ".ai-staging";
const BACKUP_DIR: &str = ".decisions-backup";
const STAMP_FILE: &str = ".ai-version.json";
/// The resource pack's stamp: its treeSha256 is what the manifest's
/// resTreeSha256 is compared against before installing LOS rasters.
const RES_STAMP_FILE: &str = ".res-version.json";
/// One map's LOS raster destination suffix.
const LOS_SUFFIX: &str = "/terrain_los.npz";
const PART_PREFIX: &str = ".ai-part-";
/// One manifest fetch's ceiling; a dead endpoint fails over quickly.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A single file's whole-transfer cap; the hub's stall bound does the early
/// failure work.
const FILE_TIMEOUT: Duration = Duration::from_secs(900);

/// The four deployed models and their featurizer contract. A release that
/// declares anything else is refused before a byte is downloaded.
const MODEL_CONTRACT: [(&str, &str, &str); 4] = [
    ("fire_model.onnx", "fire-two-head", "fire-v1"),
    ("move_model.onnx", "move-sectors-17", "move-v1"),
    ("advice_fire_model.onnx", "advice-fire-attrs", "advice-e24"),
    ("torpedo_model.onnx", "torpedo-three-head", "torpedo-e26d"),
];

/// The two models every release must carry (the optional advice/torpedo
/// models may be absent, but never mis-declared).
const REQUIRED_MODELS: [&str; 2] = ["fire_model.onnx", "move_model.onnx"];

/// The data file the advice router needs.
const ATTRS_FILE: &str = "ship_attributes.json";

/// In-flight install bookkeeping (single-flight: one install pass at a time).
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Resets the single-flight flag on every exit path, including early errors.
struct ActiveGuard;

impl ActiveGuard {
    fn acquire() -> anyhow::Result<Self> {
        if DOWNLOAD_ACTIVE.swap(true, Ordering::SeqCst) {
            bail!("an AI model download is already running");
        }
        Ok(Self)
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// The signed runtime manifest (scripts/publish_ai_models.py emits it).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiManifest {
    format: u32,
    seq: u64,
    version: String,
    revision: String,
    source: AiManifestSource,
    files: Vec<AiManifestFile>,
    tree_sha256: String,
    #[serde(default)]
    res_tree_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiManifestSource {
    #[allow(dead_code)]
    repo: String,
    #[allow(dead_code)]
    commit: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiManifestFile {
    path: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    feature_set: Option<String>,
}

/// The local stamp written after a successful install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStamp {
    schema: u32,
    seq: u64,
    version: String,
    revision: String,
    tree_sha256: String,
    manifest_sha256: String,
    key_id: String,
    installed_at: String,
    /// The published release shipped LOS rasters, but the installed resource
    /// pack no longer matches the manifest's resTreeSha256, so they were
    /// skipped. The stamp still records the release's treeSha256.
    #[serde(default)]
    los_skipped: bool,
    /// The res pack tree the release's LOS rasters were baked against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    res_tree_sha256: Option<String>,
}

impl AiStamp {
    fn path(cache: &Path) -> PathBuf {
        cache.join(STAMP_FILE)
    }

    fn read(cache: &Path) -> Option<Self> {
        let raw = fs::read_to_string(Self::path(cache)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn write(&self, cache: &Path) -> anyhow::Result<()> {
        let raw = serde_json::to_string(self)?;
        fs::write(Self::path(cache), raw)
            .map_err(|e| anyhow!("write {}: {e}", Self::path(cache).display()))
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn file_sha256(path: &Path) -> anyhow::Result<String> {
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(path).map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)
            .map_err(|e| anyhow!("read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn is_los_path(path: &str) -> bool {
    path.ends_with(LOS_SUFFIX)
}

/// The installed resource pack stamp's tree hash (None when no pack is
/// installed or the stamp is unreadable).
fn installed_res_tree(cache: &Path) -> Option<String> {
    let raw = fs::read_to_string(cache.join(RES_STAMP_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("treeSha256")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Whether the manifest's LOS rasters were baked against a resource pack
/// other than the installed one (the app then installs the models but skips
/// the LOS files, see docs/en/designs/ai-models.md section 6.7).
fn los_mismatch(manifest: &AiManifest, cache: &Path) -> bool {
    match manifest.res_tree_sha256.as_deref() {
        None => false,
        Some(expected) => installed_res_tree(cache).as_deref() != Some(expected),
    }
}

/// The files one install pass transfers: every manifest file, or — when the
/// res pack no longer matches the baked rasters — everything but LOS.
fn files_to_install(manifest: &AiManifest, skip_los: bool) -> Vec<&AiManifestFile> {
    manifest
        .files
        .iter()
        .filter(|file| !(skip_los && is_los_path(&file.path)))
        .collect()
}

/// Hash over an explicit file table (sorted path + sha256 pairs), exactly
/// the publisher's formula: sha256 over path NUL sha256 LF lines.
fn tree_hash_over(rows: impl IntoIterator<Item = (String, String)>) -> String {
    let mut rows: Vec<(String, String)> = rows.into_iter().collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (path, sha) in rows {
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update(sha.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

fn ensure_plain_dest(path: &str) -> anyhow::Result<()> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        bail!("manifest file path {path:?} is not a plain relative path");
    }
    if !huggingface::is_valid_path(path) {
        bail!("manifest file path {path:?} has an unsafe segment");
    }
    Ok(())
}

/// The Hub repository path of one destination file (the publisher layout:
/// onnx/ for models, attrs/ for the routing table, los/<map>/ for rasters).
fn repo_path_for(dest: &str) -> anyhow::Result<String> {
    if MODEL_CONTRACT.iter().any(|(name, _, _)| *name == dest) {
        return Ok(format!("onnx/{dest}"));
    }
    if dest == ATTRS_FILE {
        return Ok("attrs/ship_attributes.json".to_string());
    }
    if dest.ends_with("/terrain_los.npz") && huggingface::is_valid_path(dest) {
        return Ok(format!("los/{dest}"));
    }
    bail!("manifest lists a file this channel does not know: {dest:?}");
}

/// Validate the manifest's feature contract before any download starts.
fn check_contract(manifest: &AiManifest) -> anyhow::Result<()> {
    if manifest.format != 1 {
        bail!("unsupported AI manifest format {}", manifest.format);
    }
    if manifest.seq == 0 {
        bail!("AI manifest seq must be positive");
    }
    if !huggingface::is_valid_repo(&manifest.source.repo) {
        bail!("AI manifest names an invalid source repo");
    }
    if manifest.tree_sha256.len() != 64 {
        bail!("AI manifest treeSha256 is not a sha256");
    }
    if let Some(res_tree) = &manifest.res_tree_sha256 {
        if res_tree.len() != 64 {
            bail!("AI manifest resTreeSha256 is not a sha256");
        }
    }
    let mut seen: Vec<&str> = Vec::new();
    for file in &manifest.files {
        ensure_plain_dest(&file.path)?;
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("AI manifest file {:?} has an invalid sha256", file.path);
        }
        if file.size == 0 {
            bail!("AI manifest file {:?} has zero size", file.path);
        }
        if let Some((_, expected_kind, expected_set)) = MODEL_CONTRACT
            .iter()
            .find(|(name, _, _)| *name == file.path)
        {
            if file.kind.as_deref() != Some(*expected_kind) {
                bail!(
                    "AI manifest file {:?} declares kind {:?} (expected {:?})",
                    file.path,
                    file.kind,
                    expected_kind
                );
            }
            if file.feature_set.as_deref() != Some(*expected_set) {
                bail!(
                    "AI manifest file {:?} declares feature set {:?} (expected {:?}) - this app cannot run it",
                    file.path,
                    file.feature_set,
                    expected_set
                );
            }
        } else if file.path == ATTRS_FILE {
            if file.kind.is_some() || file.feature_set.is_some() {
                bail!(
                    "AI manifest data file {:?} must not declare a model contract",
                    file.path
                );
            }
        } else if file.path.ends_with("/terrain_los.npz") {
            // LOS rasters are opaque data; the app checks the resource-pack
            // tree separately at consume time.
        } else {
            bail!("AI manifest lists an unsupported file {:?}", file.path);
        }
        seen.push(&file.path);
    }
    for required in REQUIRED_MODELS {
        if !seen.contains(&required) {
            bail!("AI manifest is missing the required model {required}");
        }
    }
    if seen.len() != manifest.files.len() {
        bail!("AI manifest lists a file twice");
    }
    Ok(())
}

/// The pin the manifest names for its files.
fn pinned_revision(manifest: &AiManifest) -> anyhow::Result<&str> {
    if !huggingface::is_valid_revision(&manifest.revision) {
        bail!(
            "AI manifest revision {:?} is not a usable Hub ref",
            manifest.revision
        );
    }
    Ok(&manifest.revision)
}

/// Fetch and authenticate the rolling manifest. Candidates come from the
/// mirror context; the first one whose bytes verify against the pinned
/// digest keys wins. Returns the manifest, the serving endpoint, the raw
/// manifest sha256 and the signing key id.
async fn fetch_manifest() -> anyhow::Result<(AiManifest, String, String, String)> {
    let context = MirrorContext::load();
    let resource = huggingface::HfResource::manifest(AI_REPO)?;
    let sources = context.huggingface_candidates(&resource);
    if sources.is_empty() {
        bail!("no Hugging Face endpoint configured for the AI model channel");
    }
    let pair = HttpPair::build(|b| b)?;
    let mut last_error = String::from("no endpoint attempted");
    for source in sources {
        let host = upstream_health::host_of_url(&source.url).to_string();
        let attempt = tokio::time::timeout(
            MANIFEST_TIMEOUT,
            upstream_health::send_with_fallback(&pair, &host, "ai-pack", |client| {
                client
                    .get(&source.url)
                    .header("User-Agent", "WoWSP-ai-pack/1.0")
                    .header("Cache-Control", "no-cache")
                    .timeout(MANIFEST_TIMEOUT)
            }),
        )
        .await;
        let response = match attempt {
            Err(_) => {
                last_error = format!("{}: timed out", source.url);
                continue;
            },
            Ok(Err(e)) => {
                last_error = format!("{}: {e}", source.url);
                continue;
            },
            Ok(Ok(response)) => response,
        };
        if !response.status().is_success() {
            last_error = format!("{}: HTTP {}", source.url, response.status());
            continue;
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => {
                last_error = format!("{}: read body: {e}", source.url);
                continue;
            },
        };
        let manifest_sha = sha256_hex(&bytes);
        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(e) => {
                last_error = format!("{}: parse manifest: {e}", source.url);
                continue;
            },
        };
        if let Err(e) = verify_doc_signature(&value, PINNED_DIGEST_KEYS) {
            last_error = format!("{}: manifest signature: {e}", source.url);
            continue;
        }
        let key_id = value
            .get("key_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let manifest: AiManifest = match serde_json::from_value(value) {
            Ok(manifest) => manifest,
            Err(e) => {
                last_error = format!("{}: manifest shape: {e}", source.url);
                continue;
            },
        };
        if let Err(e) = check_contract(&manifest) {
            last_error = format!("{}: {e}", source.url);
            continue;
        }
        tracing::info!(%manifest_sha, seq = manifest.seq, endpoint = %source.url, "AI model manifest fetched");
        return Ok((manifest, source.url, manifest_sha, key_id));
    }
    Err(anyhow!(
        "the AI model manifest could not be fetched: {last_error}"
    ))
}

/// Local install state (stamp + on-disk inventory); no network.
fn local_status(cache: &Path) -> AiPackStatus {
    let stamp = AiStamp::read(cache);
    let dir = cache.join("decisions");
    let size_bytes = super::model_pack::dir_size(&dir);
    let mut models = Vec::new();
    for name in [
        "fire_model.onnx",
        "move_model.onnx",
        "advice_fire_model.onnx",
        "torpedo_model.onnx",
        ATTRS_FILE,
    ] {
        let path = dir.join(name);
        let meta = fs::metadata(&path).ok();
        models.push(AiPackModelState {
            path: name.to_string(),
            present: meta.as_ref().is_some_and(|m| m.is_file() && m.len() > 0),
            size_bytes: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    let mut los_maps = 0u32;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let raster = entry.path().join("terrain_los.npz");
                if fs::metadata(&raster)
                    .map(|m| m.is_file() && m.len() > 0)
                    .unwrap_or(false)
                {
                    los_maps += 1;
                }
            }
        }
    }
    let installed = stamp.is_some() && size_bytes > 0;
    AiPackStatus {
        installed,
        seq: stamp.as_ref().map(|s| s.seq),
        version: stamp.as_ref().map(|s| s.version.clone()),
        tree_sha256: stamp.as_ref().map(|s| s.tree_sha256.clone()),
        revision: stamp.as_ref().map(|s| s.revision.clone()),
        installed_at: stamp.as_ref().map(|s| s.installed_at.clone()),
        size_bytes,
        los_maps,
        los_skipped: stamp.as_ref().map(|s| s.los_skipped).unwrap_or(false),
        models,
    }
}

fn emit(
    app: Option<&AppHandle>,
    progress_phase: &str,
    received: u64,
    total: u64,
    detail: Option<serde_json::Value>,
    error: Option<String>,
) {
    let Some(app) = app else {
        return;
    };
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            id: JOB_ID.to_string(),
            kind: kind::AI_MODELS.to_string(),
            phase: progress_phase.to_string(),
            received,
            total,
            speed_bps: 0.0,
            detail,
            error,
        },
    );
}

/// Local install state for the resources card (no network).
#[tauri::command]
pub fn ai_pack_status() -> CommandResult<AiPackStatus> {
    let cache = paths::ensure_cache_dir()?;
    Ok(local_status(&cache))
}

/// One authenticated remote-manifest check. Records the freshness ledger's
/// checkedAt on success and reports whether a different content tree is
/// published. Never downloads.
#[tauri::command]
pub async fn ai_pack_check() -> CommandResult<AiPackCheck> {
    let cache = paths::ensure_cache_dir()?;
    let current = local_status(&cache);
    let (manifest, endpoint, manifest_sha, _key_id) = fetch_manifest().await?;
    if let Some(installed_seq) = current.seq {
        if manifest.seq < installed_seq {
            return Err(anyhow!(
                "published AI manifest seq {} is older than the installed seq {installed_seq} (rollback refused)",
                manifest.seq
            )
            .into());
        }
    }
    let checked_at = now_rfc3339();
    super::resources::record_ledger_external(
        "decisions-pack",
        Some(manifest.tree_sha256.clone()),
        Some(manifest.version.clone()),
        true,
    );
    let los_tree_mismatch = los_mismatch(&manifest, &cache);
    // A pack installed while the res pack was stale is missing its LOS tree;
    // once the user updates the res pack the same release becomes installable
    // again, so the card must offer the download.
    let los_missing = current.los_skipped && !los_tree_mismatch;
    let total_bytes = manifest.files.iter().map(|f| f.size).sum();
    let update_available =
        current.tree_sha256.as_deref() != Some(manifest.tree_sha256.as_str()) || los_missing;
    let files = manifest
        .files
        .iter()
        .map(|f| AiPackFileInfo {
            path: f.path.clone(),
            size: f.size,
            sha256: f.sha256.clone(),
            kind: f.kind.clone(),
            feature_set: f.feature_set.clone(),
        })
        .collect();
    Ok(AiPackCheck {
        current,
        latest_seq: manifest.seq,
        latest_version: manifest.version,
        latest_tree_sha256: manifest.tree_sha256,
        latest_revision: manifest.revision,
        total_bytes,
        los_included: manifest.res_tree_sha256.is_some(),
        los_mismatch: los_tree_mismatch,
        files,
        endpoint,
        manifest_sha256: manifest_sha,
        checked_at,
        update_available,
    })
}

/// Cancel the running install pass (the hub reports the cancel through the
/// normal error path). Safe when nothing is running.
#[tauri::command]
pub fn ai_pack_cancel() -> CommandResult<()> {
    download_hub::cancel(kind::AI_MODELS, JOB_ID);
    Ok(())
}

/// Validate the staged ONNX files against the declared contract. Compiled
/// with the ai feature only, so the loaders below are always available.
fn validate_staged_models(staging: &Path, manifest: &AiManifest) -> anyhow::Result<()> {
    for file in &manifest.files {
        // LOS rasters are opaque data (and may be skipped on a res-pack
        // mismatch); only the ONNX contract is checked here.
        if is_los_path(&file.path) {
            continue;
        }
        let path = staging.join(&file.path);
        let bytes = fs::read(&path).map_err(|e| anyhow!("read staged {}: {e}", path.display()))?;
        match file.path.as_str() {
            "fire_model.onnx" => {
                let model =
                    super::decision_score::ScoreModel::from_bytes("ai pack fire model", &bytes)?;
                if !matches!(
                    model.kind(),
                    super::decision_score::ScoreModelKind::FireTwoHead
                ) {
                    bail!("fire_model.onnx is not a two-head fire model");
                }
                let widths = model.widths();
                if widths
                    != (
                        24,
                        super::decision_score::ENTITY_DIM_V2,
                        super::decision_score::GLOBAL_DIM_V2,
                    )
                {
                    bail!("fire_model.onnx widths {widths:?} do not match this build");
                }
            },
            "move_model.onnx" => {
                let model =
                    super::decision_score::ScoreModel::from_bytes("ai pack move model", &bytes)?;
                match model.kind() {
                    super::decision_score::ScoreModelKind::MoveSectors { sectors: 17 } => {},
                    other => {
                        bail!("move_model.onnx is not the 17-class movement model ({other:?})")
                    },
                }
            },
            "advice_fire_model.onnx" => {
                let model = super::decision_ai::DecisionModel::from_bytes(
                    super::decision_ai::DecisionModelSource::Pack,
                    "ai pack advice model",
                    &bytes,
                )?;
                match model.kind() {
                    super::decision_ai::DecisionModelKind::Fire24 { attr_dim, .. }
                        if *attr_dim > 0 => {},
                    other => bail!(
                        "advice_fire_model.onnx is not an attribute-routed fire model ({other:?})"
                    ),
                }
            },
            "torpedo_model.onnx" => {
                let model =
                    super::decision_score::ScoreModel::from_bytes("ai pack torpedo model", &bytes)?;
                let widths = model.widths();
                if widths.0 != 24
                    || widths.1 != super::decision_score::ENTITY_DIM_V2
                    || widths.2 != super::decision_score::TORP_GLOBAL_DIM_V2
                {
                    bail!("torpedo_model.onnx widths {widths:?} do not match this build");
                }
                if !matches!(
                    model.kind(),
                    super::decision_score::ScoreModelKind::FireTwoHead
                        | super::decision_score::ScoreModelKind::FireThreeHead
                ) {
                    bail!("torpedo_model.onnx is not a two/three-head torpedo model");
                }
            },
            _ => {},
        }
    }
    Ok(())
}

/// Recompute the content tree hash from the staged files.
fn staged_tree_hash(staging: &Path, files: &[&AiManifestFile]) -> anyhow::Result<String> {
    let mut rows = Vec::with_capacity(files.len());
    for file in files {
        let path = staging.join(&file.path);
        let sha = file_sha256(&path)?;
        if !sha.eq_ignore_ascii_case(&file.sha256) {
            bail!(
                "staged {} does not match the manifest sha256 ({sha} vs {})",
                file.path,
                file.sha256
            );
        }
        rows.push((file.path.clone(), sha));
    }
    Ok(tree_hash_over(rows))
}

/// Download, verify and install the published model pack. User-initiated;
/// the old pack keeps serving until every check passed and the swap happens.
#[tauri::command]
pub async fn ai_pack_download(app: AppHandle) -> CommandResult<()> {
    let _guard = ActiveGuard::acquire()?;
    download_hub::clear_pending(kind::AI_MODELS, JOB_ID);
    let cache = paths::ensure_cache_dir()?;
    let installed = local_status(&cache);
    let (manifest, _endpoint, manifest_sha, key_id) = fetch_manifest().await?;
    if let Some(installed_seq) = installed.seq {
        if manifest.seq < installed_seq {
            return Err(anyhow!(
                "published AI manifest seq {} is older than the installed seq {installed_seq} (rollback refused)",
                manifest.seq
            )
            .into());
        }
    }
    let revision = pinned_revision(&manifest)?.to_string();
    // LOS rasters baked against a different res pack would describe terrain
    // the user cannot see; install the models and skip the raster tree.
    let skip_los = los_mismatch(&manifest, &cache);
    let install_files = files_to_install(&manifest, skip_los);
    let total_bytes: u64 = install_files.iter().map(|f| f.size).sum();
    let file_count = install_files.len();

    let staging = cache.join(STAGING_DIR);
    let backup = cache.join(BACKUP_DIR);
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| anyhow!("create {}: {e}", staging.display()))?;
    if let Ok(entries) = fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(PART_PREFIX) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    emit(
        Some(&app),
        phase::VERIFY,
        0,
        total_bytes,
        Some(serde_json::json!({ "file": MANIFEST_NAME, "files": file_count })),
        None,
    );

    let context = MirrorContext::load();
    let mut received = 0u64;
    for (index, file) in install_files.iter().enumerate() {
        let repo_path = repo_path_for(&file.path)?;
        let resource = huggingface::HfResource::new(AI_REPO, &revision, &repo_path)?;
        let sources: Vec<String> = context
            .huggingface_candidates(&resource)
            .into_iter()
            .map(|source| source.url)
            .collect();
        if sources.is_empty() {
            return Err(anyhow!("no endpoint candidate for {}", file.path).into());
        }
        let dest = staging.join(&file.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
        }
        let part = cache.join(format!("{PART_PREFIX}{}", &file.sha256[..16]));
        let detail = serde_json::json!({
            "file": file.path,
            "index": index,
            "files": file_count,
        });
        let mut request = DownloadRequest::new(JOB_ID, kind::AI_MODELS, sources, part.clone());
        request.min_bytes = file.size;
        request.max_bytes = Some(file.size);
        request.expected_sha256 = Some(file.sha256.clone());
        request.timeout = Some(FILE_TIMEOUT);
        request.stall_timeout = Some(Duration::from_secs(30));
        request.resume = true;
        request.cancel_msg = "AI model download cancelled".to_string();
        request.base_received = received;
        request.base_total = total_bytes;
        request.total_hint = file.size;
        request.detail = Some(detail);
        let done = download_hub::transfer(Some(&app), request).await?;
        fs::rename(&done.path, &dest)
            .map_err(|e| anyhow!("move {} into staging: {e}", done.path.display()))?;
        received = received.saturating_add(file.size);
    }

    emit(
        Some(&app),
        phase::APPLY,
        received,
        total_bytes,
        Some(serde_json::json!({ "step": "verify" })),
        None,
    );
    // The signed manifest already fixed every file's sha256; the tree hash
    // adds set-level integrity. On a LOS skip the installed subset can never
    // equal the full release tree, so compare it against the subset hash
    // derived from the same signed file table.
    let expected_tree = if skip_los {
        tree_hash_over(
            install_files
                .iter()
                .map(|file| (file.path.clone(), file.sha256.clone())),
        )
    } else {
        manifest.tree_sha256.clone()
    };
    let tree_sha256 = staged_tree_hash(&staging, &install_files)?;
    if !tree_sha256.eq_ignore_ascii_case(&expected_tree) {
        return Err(anyhow!(
            "staged tree hash {tree_sha256} does not match the expected {expected_tree}"
        )
        .into());
    }
    validate_staged_models(&staging, &manifest)?;

    let decisions = cache.join("decisions");
    let _ = fs::remove_dir_all(&backup);
    if decisions.exists() {
        fs::rename(&decisions, &backup).map_err(|e| {
            anyhow!(
                "move the installed pack aside ({}): {e}",
                decisions.display()
            )
        })?;
    }
    if let Err(e) = fs::rename(&staging, &decisions) {
        if backup.exists() {
            let _ = fs::rename(&backup, &decisions);
        }
        return Err(anyhow!("publish the staged pack: {e}").into());
    }
    let stamp = AiStamp {
        schema: 1,
        seq: manifest.seq,
        version: manifest.version.clone(),
        revision: revision.clone(),
        // The release identity (full tree) stays the stamp's tree hash even
        // when the LOS subset was skipped: check/update compare releases.
        tree_sha256: manifest.tree_sha256.clone(),
        manifest_sha256: manifest_sha.clone(),
        key_id,
        installed_at: now_rfc3339(),
        los_skipped: skip_los,
        res_tree_sha256: manifest.res_tree_sha256.clone(),
    };
    if let Err(e) = stamp.write(&cache) {
        let _ = fs::rename(&decisions, &staging);
        if backup.exists() {
            let _ = fs::rename(&backup, &decisions);
        }
        return Err(e.into());
    }
    let _ = fs::remove_dir_all(&backup);
    super::resources::record_ledger_external(
        "decisions-pack",
        Some(manifest.tree_sha256.clone()),
        Some(manifest.version.clone()),
        true,
    );
    emit(
        Some(&app),
        phase::DONE,
        total_bytes,
        total_bytes,
        Some(serde_json::json!({
            "seq": manifest.seq,
            "treeSha256": manifest.tree_sha256,
            "losSkipped": skip_los,
        })),
        None,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_with(files: Vec<AiManifestFile>) -> AiManifest {
        AiManifest {
            format: 1,
            seq: 3,
            version: "2026-11-09T00:00:00Z".to_string(),
            revision: "a1bae028c41641ecb1715aa3c318e8d320c322f2".to_string(),
            source: AiManifestSource {
                repo: "langyo/wowsp".to_string(),
                commit: "b4a0d38f65ba6ca5499510a4516f2f1be03e6f90".to_string(),
            },
            files,
            tree_sha256: "a".repeat(64),
            res_tree_sha256: None,
        }
    }

    fn model_file(name: &str, kind: &str, feature_set: &str) -> AiManifestFile {
        AiManifestFile {
            path: name.to_string(),
            sha256: "b".repeat(64),
            size: 10,
            kind: Some(kind.to_string()),
            feature_set: Some(feature_set.to_string()),
        }
    }

    fn file(name: &str) -> AiManifestFile {
        AiManifestFile {
            path: name.to_string(),
            sha256: "c".repeat(64),
            size: 4,
            kind: None,
            feature_set: None,
        }
    }

    #[test]
    fn contract_accepts_the_published_shape() {
        let manifest = manifest_with(vec![
            model_file("fire_model.onnx", "fire-two-head", "fire-v1"),
            model_file("move_model.onnx", "move-sectors-17", "move-v1"),
            model_file("advice_fire_model.onnx", "advice-fire-attrs", "advice-e24"),
            model_file("torpedo_model.onnx", "torpedo-three-head", "torpedo-e26d"),
            file("ship_attributes.json"),
            file("50_Gold_harbor/terrain_los.npz"),
        ]);
        check_contract(&manifest).expect("published shape");
    }

    #[test]
    fn contract_rejects_missing_required_or_unknown_models() {
        let missing = manifest_with(vec![model_file(
            "fire_model.onnx",
            "fire-two-head",
            "fire-v1",
        )]);
        assert!(check_contract(&missing).is_err(), "move model is required");

        let unknown = manifest_with(vec![
            model_file("fire_model.onnx", "fire-two-head", "fire-v1"),
            model_file("move_model.onnx", "move-sectors-17", "move-v1"),
            file("rogue.bin"),
        ]);
        assert!(
            check_contract(&unknown).is_err(),
            "unknown files are refused"
        );

        let wrong_set = manifest_with(vec![
            model_file("fire_model.onnx", "fire-two-head", "fire-v9"),
            model_file("move_model.onnx", "move-sectors-17", "move-v1"),
        ]);
        assert!(check_contract(&wrong_set).is_err(), "feature set mismatch");
    }

    #[test]
    fn repo_paths_follow_the_publisher_layout() {
        assert_eq!(
            repo_path_for("fire_model.onnx").unwrap(),
            "onnx/fire_model.onnx"
        );
        assert_eq!(
            repo_path_for("ship_attributes.json").unwrap(),
            "attrs/ship_attributes.json"
        );
        assert_eq!(
            repo_path_for("42_Neighbors/terrain_los.npz").unwrap(),
            "los/42_Neighbors/terrain_los.npz"
        );
        assert!(repo_path_for("rogue.bin").is_err());
    }

    #[test]
    fn plain_dest_rejects_escapes() {
        assert!(ensure_plain_dest("fire_model.onnx").is_ok());
        assert!(ensure_plain_dest("42_Neighbors/terrain_los.npz").is_ok());
        assert!(ensure_plain_dest("../fire_model.onnx").is_err());
        assert!(ensure_plain_dest("/abs/fire_model.onnx").is_err());
        assert!(ensure_plain_dest("a\\b").is_err());
    }

    #[test]
    fn staged_tree_hash_matches_the_publisher_formula() {
        let dir = std::env::temp_dir().join(format!("wowsp-ai-pack-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fire_model.onnx"), b"abc").unwrap();
        let sha = file_sha256(&dir.join("fire_model.onnx")).unwrap();
        let mut manifest = manifest_with(vec![AiManifestFile {
            path: "fire_model.onnx".to_string(),
            sha256: sha.clone(),
            size: 3,
            kind: Some("fire-two-head".to_string()),
            feature_set: Some("fire-v1".to_string()),
        }]);
        let expected = sha256_hex(format!("fire_model.onnx\0{sha}\n").as_bytes());
        manifest.tree_sha256 = expected.clone();
        let files: Vec<&AiManifestFile> = manifest.files.iter().collect();
        let got = staged_tree_hash(&dir, &files).expect("tree hash");
        assert_eq!(got, expected);
        let missing_manifest = manifest_with(vec![file("missing.onnx")]);
        let missing: Vec<&AiManifestFile> = missing_manifest.files.iter().collect();
        assert!(staged_tree_hash(&dir, &missing).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn los_files_are_skipped_on_a_resource_pack_mismatch() {
        let dir = std::env::temp_dir().join(format!("wowsp-ai-los-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = manifest_with(vec![
            model_file("fire_model.onnx", "fire-two-head", "fire-v1"),
            model_file("move_model.onnx", "move-sectors-17", "move-v1"),
            file("42_Neighbors/terrain_los.npz"),
        ]);
        // A manifest with a res-pin but no pack stamp: rasters gated, models stay.
        let mut gated = manifest.clone();
        gated.res_tree_sha256 = Some("e".repeat(64));
        assert!(los_mismatch(&gated, &dir));
        let files = files_to_install(&gated, true);
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| !is_los_path(&f.path)));
        assert_eq!(files_to_install(&gated, false).len(), 3);

        // A stamp carrying the manifest's tree clears the mismatch.
        let tree = "d".repeat(64);
        std::fs::write(
            dir.join(RES_STAMP_FILE),
            format!("{{\"treeSha256\":\"{tree}\"}}"),
        )
        .unwrap();
        let mut matching = manifest.clone();
        matching.res_tree_sha256 = Some(tree);
        assert!(!los_mismatch(&matching, &dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
