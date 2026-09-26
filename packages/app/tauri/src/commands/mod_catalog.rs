//! Mod Hub online catalog (milestone M10.3/10.2 app side).
//!
//! The plugin list is `mod-index.json`, published as an asset of this repo's
//! `mod-hub` release (`scripts/mod_hub_publish.py` builds and uploads it; the
//! crawl indexer in `scripts/mod_index.py` produces the same shape from
//! community-authored threads). Each entry carries per-package SHA-256 hashes,
//! so install = download → verify → unzip → reuse the local classifier +
//! installer from [`super::mod_hub`], then record every written file in
//! `mods/installed.json` for uninstall and (later) game-update migration.
//!
//! Downloads go through the global proxy-aware client; GitHub release assets
//! are also reachable through the same CN mirrors the updater uses.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use wowsp_tauri_shared::{
    CatalogEntry, CatalogEntryI18n, CatalogIndex, CatalogPackage, CatalogProgress, InstallReport,
    ModInstallRecord,
};

use super::mod_hub;
use crate::paths;

const INDEX_CACHE_FILE: &str = "mod-catalog.json";
const LEDGER_FILE: &str = "mods/installed.json";
pub const CATALOG_PROGRESS_EVENT: &str = "wowsp://mod-catalog-progress";

/// How long a cached `mod-catalog.json` is served without a re-fetch. A
/// stale index whose package hashes drifted from the release is the classic
/// "every install fails the SHA-256 check" trap; refetching keeps them in
/// step while still working offline (a failed refresh falls back to cache).
const INDEX_CACHE_TTL_HOURS: i64 = 6;

/// Index candidates: the shared GitHub mirror ladder (user mirror first,
/// then the official route, then the built-in prefixes).
fn index_urls() -> Vec<String> {
    super::github_mirror::candidates(
        "https://github.com/langyo/wowsp/releases/download/mod-hub/mod-index.json",
    )
}

/// Download candidates for a release asset: the same shared ladder. Non-
/// GitHub URLs are returned unchanged (single candidate).
fn download_candidates(url: &str) -> Vec<String> {
    super::github_mirror::candidates(url)
}

/// Serializes every mod-hub mutation (catalog install / uninstall, `.bak`
/// toggles, unit uninstall): the guard is held across ledger writes and
/// res_mods renames so parallel commands cannot interleave them. Network
/// downloads stay outside the gate, so several installs still download in
/// parallel and only their disk side serializes.
static MOD_HUB_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) async fn mod_hub_gate() -> tokio::sync::MutexGuard<'static, ()> {
    MOD_HUB_GATE.lock().await
}

fn data_file(rel: &str) -> Result<PathBuf, String> {
    let dir = paths::ensure_data_dir()?;
    Ok(dir.join(rel))
}

// ── Index fetch / parse ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn mod_catalog_refresh(force: bool) -> Result<CatalogIndex, String> {
    let mut cached = if force { None } else { load_cached_index() };
    if let Some(index) = cached.as_ref() {
        // A cache written by an older app build can lack the i18n maps
        // (schema drifted when threads gained the wowsp:i18n block);
        // such a copy is stale by definition. A fresh-enough cache is
        // served as-is; an expired one is refreshed (but stays the
        // offline fallback if the fetch fails below).
        let localized = index.mods.iter().any(|m| !m.i18n.is_empty()) || index.mods.is_empty();
        let fresh = fetched_recently(&index.fetched_at);
        if localized && fresh {
            return Ok(index.clone());
        }
        if !localized && !index.mods.is_empty() {
            tracing::info!("cached mod catalog predates i18n — refetching");
            cached = None;
        }
    }
    let fetched = fetch_index().await;
    match fetched {
        Ok(index) => {
            let path = data_file(INDEX_CACHE_FILE)?;
            let json =
                serde_json::to_string(&index).map_err(|e| format!("serialize index: {e}"))?;
            let tmp = path.with_extension("json.tmp");
            fs::write(&tmp, json).map_err(|e| format!("write cache: {e}"))?;
            fs::rename(&tmp, &path).map_err(|e| format!("rename cache: {e}"))?;
            Ok(index)
        },
        Err(e) => match cached {
            Some(index) => {
                tracing::warn!(error = %e, "catalog refresh failed — serving the stale cache");
                Ok(index)
            },
            None => Err(e),
        },
    }
}

/// Whether the index's fetch stamp is younger than the cache TTL.
fn fetched_recently(fetched_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(fetched_at)
        .map(|t| Utc::now().signed_duration_since(t).num_hours() < INDEX_CACHE_TTL_HOURS)
        .unwrap_or(false)
}

fn load_cached_index() -> Option<CatalogIndex> {
    let raw = fs::read_to_string(data_file(INDEX_CACHE_FILE).ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

async fn fetch_index() -> Result<CatalogIndex, String> {
    let client = super::network::build_http_client()?;
    let mut last_err = String::from("no index url attempted");
    for url in index_urls() {
        let resp = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await;
        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("{url}: HTTP {}", r.status());
                continue;
            },
            Err(e) => {
                last_err = format!("{url}: {e}");
                continue;
            },
        };
        match resp.bytes().await {
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(raw) => {
                    let mut index = parse_index(&raw)?;
                    index.fetched_at = Utc::now().to_rfc3339();
                    return Ok(index);
                },
                Err(e) => last_err = format!("{url}: parse: {e}"),
            },
            Err(e) => last_err = format!("{url}: read: {e}"),
        }
    }
    Err(format!("catalog index unreachable: {last_err}"))
}

#[derive(Deserialize)]
struct RawIndex {
    #[serde(default)]
    source: Option<RawSource>,
    #[serde(default)]
    mods: std::collections::HashMap<String, RawMod>,
}

#[derive(Deserialize)]
struct RawSource {
    #[serde(default)]
    content_version: Option<String>,
    #[serde(default)]
    game_version: Option<String>,
}

#[derive(Deserialize)]
struct RawMod {
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    discussion: Option<u64>,
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    versions: std::collections::HashMap<String, RawVersion>,
}

#[derive(Clone, Deserialize)]
struct RawVersion {
    #[serde(default)]
    game: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name_en: Option<String>,
    #[serde(default)]
    name_zh: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    i18n: std::collections::HashMap<String, RawI18n>,
    /// Present in the publisher index; not rendered in-app (CSP blocks the
    /// remote image host), kept deserializable so the shape stays documented.
    #[serde(default)]
    #[allow(dead_code)]
    preview: Option<String>,
    #[serde(default)]
    author_url: Option<String>,
    #[serde(default)]
    packages: Option<Vec<RawPackage>>,
}

#[derive(Clone, Deserialize)]
struct RawI18n {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    desc: Option<String>,
}

#[derive(Clone, Deserialize)]
struct RawPackage {
    url: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    name: Option<String>,
}

/// Tolerant `mod-index.json` → DTO: community-crawled indexes fill fewer
/// fields than the publisher's; entries without packages are not installable
/// and get dropped here so the UI only ever renders actionable rows.
fn parse_index(raw: &serde_json::Value) -> Result<CatalogIndex, String> {
    let raw: RawIndex =
        serde_json::from_value(raw.clone()).map_err(|e| format!("index shape: {e}"))?;
    let mut mods = Vec::new();
    for (id, m) in raw.mods {
        let latest = match m.latest.clone() {
            Some(v) => v,
            None => match m.versions.keys().max() {
                Some(v) => v.clone(),
                None => continue,
            },
        };
        let Some(ver) = m.versions.get(&latest) else {
            continue;
        };
        let packages: Vec<CatalogPackage> = ver
            .packages
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                let name = p.name.unwrap_or_else(|| {
                    p.url
                        .rsplit('/')
                        .next()
                        .unwrap_or("package.zip")
                        .to_string()
                });
                CatalogPackage {
                    url: p.url,
                    sha256: p.sha256.unwrap_or_default(),
                    size: p.size.unwrap_or(0),
                    name,
                }
            })
            .collect();
        if packages.is_empty() {
            continue;
        }
        mods.push(CatalogEntry {
            id: id.clone(),
            category: m.category.unwrap_or_else(|| "aux".into()),
            discussion: m.discussion,
            version: latest,
            game: ver.game.clone().unwrap_or_else(|| "*".into()),
            title: ver.title.clone().unwrap_or_else(|| id.clone()),
            name_zh: ver.name_zh.clone().unwrap_or_default(),
            name_en: ver
                .name_en
                .clone()
                .unwrap_or_else(|| ver.title.clone().unwrap_or_else(|| id.clone())),
            description: ver.description.clone().unwrap_or_default(),
            author_url: ver.author_url.clone().unwrap_or_default(),
            i18n: ver
                .i18n
                .iter()
                .map(|(lang, text)| {
                    (
                        lang.clone(),
                        CatalogEntryI18n {
                            name: text.name.clone().unwrap_or_default(),
                            description: text.desc.clone().unwrap_or_default(),
                        },
                    )
                })
                .collect(),
            packages,
        });
    }
    mods.sort_by(|a, b| a.category.cmp(&b.category).then(a.id.cmp(&b.id)));
    let source = raw.source.unwrap_or(RawSource {
        content_version: None,
        game_version: None,
    });
    Ok(CatalogIndex {
        source_version: source
            .content_version
            .unwrap_or_else(|| "community crawl".into()),
        game_version: source.game_version.unwrap_or_else(|| "*".into()),
        fetched_at: Utc::now().to_rfc3339(),
        mods,
    })
}

// ── Install ledger ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct Ledger {
    #[serde(default)]
    pub(crate) installs: Vec<ModInstallRecord>,
}

pub(crate) fn load_ledger() -> Ledger {
    fs::read_to_string(data_file(LEDGER_FILE).unwrap_or_default())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_ledger(ledger: &Ledger) -> Result<(), String> {
    let path = data_file(LEDGER_FILE)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create ledger dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(ledger).map_err(|e| format!("serialize ledger: {e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("write ledger: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename ledger: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn mod_hub_records() -> Result<Vec<ModInstallRecord>, String> {
    Ok(load_ledger().installs)
}

// ── Install ─────────────────────────────────────────────────────────────────

/// Drop-guard for the per-install temp work dir: every early `?` return
/// cleans up after itself instead of leaking archives into %TEMP%.
struct WorkDir(PathBuf);

impl Drop for WorkDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

#[tauri::command]
pub async fn mod_catalog_install(
    mod_id: String,
    game_root: String,
    app: AppHandle,
) -> Result<InstallReport, String> {
    let index = load_cached_index()
        .ok_or_else(|| "catalog not loaded yet — refresh the online list first".to_string())?;
    let entry = index
        .mods
        .iter()
        .find(|m| m.id == mod_id)
        .ok_or_else(|| format!("{mod_id} is not in the cached catalog"))?
        .clone();

    // Fail fast when the game is running — mutating res_mods under a live
    // client tears half-loaded mods.
    mod_hub::ensure_game_closed()?;

    let progress = |p: CatalogProgress| {
        let _ = app.emit(CATALOG_PROGRESS_EVENT, &p);
    };
    progress(CatalogProgress {
        id: entry.id.clone(),
        phase: "downloading".into(),
        package: 0,
        packages: entry.packages.len() as u32,
        received: 0,
        total: entry.packages.iter().map(|p| p.size).sum(),
    });

    let client = super::network::build_http_client()?;
    let work = WorkDir(std::env::temp_dir().join(format!(
        "wowsp-modhub-{}-{}",
        entry.id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    )));
    fs::create_dir_all(&work.0).map_err(|e| format!("create workdir: {e}"))?;

    let mut received_total = 0u64;
    let total = entry.packages.iter().map(|p| p.size).sum::<u64>().max(1);
    for (i, pkg) in entry.packages.iter().enumerate() {
        // GitHub direct first, then the CN mirrors — a plain `github.com`
        // download 404s/timeout for many CN users, which used to fail every
        // install even though the catalog itself had loaded through a mirror.
        let candidates = download_candidates(&pkg.url);
        let mut bytes: Option<Vec<u8>> = None;
        let mut last_err = String::from("no mirror attempted");
        for url in &candidates {
            let mut since_emit = 0u64;
            let id = entry.id.clone();
            let packages = entry.packages.len() as u32;
            // A mirror dying mid-transfer must not keep its bytes counted —
            // rewind so the retry does not inflate the progress bar.
            let attempt_start = received_total;
            let result = fetch_package(&client, url, |n| {
                received_total += n;
                since_emit += n;
                if since_emit >= 262_144 {
                    since_emit = 0;
                    progress(CatalogProgress {
                        id: id.clone(),
                        phase: "downloading".into(),
                        package: (i + 1) as u32,
                        packages,
                        received: received_total,
                        total,
                    });
                }
            })
            .await;
            match result {
                Ok(data) => {
                    bytes = Some(data);
                    break;
                },
                Err(e) => {
                    received_total = attempt_start;
                    last_err = e;
                },
            }
        }
        let Some(bytes) = bytes else {
            return Err(format!("download {}: {last_err}", pkg.name));
        };
        if !pkg.sha256.is_empty() {
            let digest = hex::encode(Sha256::digest(&bytes));
            if digest != pkg.sha256.to_ascii_lowercase() {
                return Err(format!(
                    "{} failed the SHA-256 check ({} != {}); refresh the catalog and retry — the cached index may be stale, or the package on the release is damaged",
                    pkg.name, digest, pkg.sha256
                ));
            }
        }
        if pkg.size > 0 && bytes.len() != pkg.size as usize {
            return Err(format!(
                "{} downloaded {} bytes but the catalog lists {}",
                pkg.name,
                bytes.len(),
                pkg.size
            ));
        }
        let dest = work.0.join(format!("{i:02}-{}", pkg.name));
        fs::write(&dest, &bytes).map_err(|e| format!("write {}: {e}", pkg.name))?;
        progress(CatalogProgress {
            id: entry.id.clone(),
            phase: "downloading".into(),
            package: (i + 1) as u32,
            packages: entry.packages.len() as u32,
            received: received_total,
            total,
        });
    }

    progress(CatalogProgress {
        id: entry.id.clone(),
        phase: "installing".into(),
        package: entry.packages.len() as u32,
        packages: entry.packages.len() as u32,
        received: received_total,
        total,
    });

    // Serialize the disk side (unpack, res_mods writes, ledger) while other
    // installs may still be in their download phase. The game guard runs
    // again here: the client may have been launched while the download ran.
    let _gate = mod_hub_gate().await;
    mod_hub::ensure_game_closed()?;

    let mut ledger = load_ledger();
    // Unpack + classify + write are blocking fs work — keep them off the
    // async runtime threads.
    let unpack_id = entry.id.clone();
    let unpack_root = game_root.clone();
    let unpack_pkgs = entry.packages.clone();
    let unpack_work = work.0.clone();
    let (outcome, mut ledger) = tauri::async_runtime::spawn_blocking(move || {
        // Reinstall = rewind first: restore the vanilla files the previous
        // install snapshotted and delete its recorded files, so the new
        // version starts from a clean baseline — files dropped by the new
        // package don't linger, and the snapshots point at VANILLA originals
        // instead of chaining onto the previous mod (chained snapshots used
        // to make uninstall restore the previous mod's files).
        let mut failure = None;
        if ledger.installs.iter().any(|r| r.id == unpack_id) {
            if let Err(e) = uninstall_from_ledger(&mut ledger.installs, &unpack_id, &unpack_root) {
                failure = Some(e);
            }
        }
        let outcome = match failure {
            Some(e) => Err(e),
            None => unpack_and_install(&unpack_id, &unpack_work, &unpack_root, &unpack_pkgs),
        };
        (outcome, ledger)
    })
    .await
    .map_err(|e| format!("install task: {e}"))?;
    let (report, written, restore_dir) = match outcome {
        Ok(done) => done,
        Err(e) => {
            // The rewind already changed the ledger even though the unpack
            // failed — persist it so the on-disk ledger does not describe
            // files that are already gone.
            if let Err(se) = save_ledger(&ledger) {
                tracing::warn!(error = %se, "ledger save failed after failed install");
            }
            return Err(e);
        },
    };

    // Say whose files this install clobbered (the journal already
    // snapshotted them — this is the visibility half of the conflict
    // policy the design doc promises).
    let mut report = report;
    let conflicts =
        mod_hub::conflict_warnings(&written, &ledger.installs, &entry.id, &report.bin_version);
    report.conflicts = conflicts.clone();
    report.warnings.extend(conflicts);

    ledger.installs.push(ModInstallRecord {
        id: entry.id.clone(),
        name: report.name.clone(),
        version: entry.version.clone(),
        category: entry.category.clone(),
        source: "mod-hub".into(),
        discussion: entry.discussion,
        bin_version: report.bin_version.clone(),
        installed_at: Utc::now().to_rfc3339(),
        files: written,
        restore_dir: restore_dir
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    });
    save_ledger(&ledger)?;

    drop(_gate);

    progress(CatalogProgress {
        id: entry.id.clone(),
        phase: "done".into(),
        package: entry.packages.len() as u32,
        packages: entry.packages.len() as u32,
        received: received_total,
        total,
    });
    tracing::info!(id = %entry.id, version = %entry.version, "mod_catalog_install done");
    Ok(report)
}

/// Stream one package URL into memory. Downloads previously buffered via
/// `bytes()` with no timeout: a stalled connection hung the install forever
/// and the progress bar never moved. Emits each chunk length so the caller
/// keeps the cross-package received counter and can push progress while a
/// big single archive is still arriving.
async fn fetch_package(
    client: &reqwest::Client,
    url: &str,
    mut on_chunk: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    let mut resp = client
        .get(url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{url}: {e}"))? {
        on_chunk(chunk.len() as u64);
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Extract every package archive (part order = index order) into `work`, then
/// run the shared classify → install pipeline. Returns the report plus the
/// written-file list (res_mods-relative, `@game/`-prefixed for game-root
/// files) and restore snapshot dir for the ledger.
///
/// Aslain packages are laid out against the game root: the payload lives under
/// `res_mods/…` (→ `bin/<ver>/res_mods/…`), and a few text mods ship a loose
/// DLL that belongs in the game root itself.
fn unpack_and_install(
    mod_id: &str,
    work: &Path,
    game_root: &str,
    packages: &[CatalogPackage],
) -> Result<(InstallReport, Vec<String>, Option<PathBuf>), String> {
    let extract_root = work.join("unpacked");
    fs::create_dir_all(&extract_root).map_err(|e| format!("create unpack dir: {e}"))?;
    let mut files = Vec::new();
    for (i, _pkg) in packages.iter().enumerate() {
        let archive = work.join(format!("{i:02}-{}", packages[i].name));
        extract_zip(&archive, &extract_root, &mut files)?;
    }
    // The unpacked tree must still look like a mod; reuse the same classifier
    // the local-folder flow uses so both paths agree on what is installable.
    if files.is_empty() {
        return Err(format!(
            "{mod_id}: the packages unpacked to nothing recognizable (archive layout drifted from the catalog)"
        ));
    }

    let res_mods_src = extract_root.join("res_mods");
    let (plan_root, loose) = if res_mods_src.is_dir() {
        // Aslain packages are laid out against the game root: the payload
        // lives under `res_mods/…`, and a few text mods ship a loose DLL
        // that belongs in the game root itself. Both go through the same
        // journaled install (snapshots + rollback).
        let loose: Vec<PathBuf> = loose_root_files(&extract_root)?
            .into_iter()
            .map(|name| extract_root.join(name))
            .collect();
        (res_mods_src, loose)
    } else {
        (extract_root.clone(), Vec::new())
    };
    let plan = mod_hub::classify_package(&plan_root)?;
    let applied = mod_hub::install_plan_with_loose(&plan_root, game_root, &plan, &loose)?;

    Ok((applied.report, applied.written, applied.restore_dir))
}

/// Files sitting at the zip root next to `res_mods/` (game-root payloads).
/// Only native payloads are carried over — readme/log noise at the zip root
/// is ignored rather than dumped into the game directory.
fn loose_root_files(extract_root: &Path) -> Result<Vec<String>, String> {
    let mut loose = Vec::new();
    for ent in fs::read_dir(extract_root)
        .map_err(|e| format!("read {}: {e}", extract_root.display()))?
        .flatten()
    {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let is_payload = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("dll") || ext.eq_ignore_ascii_case("exe"));
        if is_payload {
            loose.push(ent.file_name().to_string_lossy().into_owned());
        }
    }
    loose.sort();
    Ok(loose)
}

/// Zip-slip-safe extraction; visited paths are collected for diagnostics.
fn extract_zip(archive: &Path, dest: &Path, visited: &mut Vec<String>) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("read {}: {e}", archive.display()))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("entry {i} of {}: {e}", archive.display()))?;
        // enclosed_name rejects `..` and absolute components.
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("mkdir {}: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut fout =
            fs::File::create(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut fout)
            .map_err(|e| format!("extract {}: {e}", out.display()))?;
        if let Ok(rel) = out.strip_prefix(dest) {
            visited.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

// ── Uninstall ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    pub id: String,
    pub name: String,
    pub removed_files: usize,
    pub restored_files: usize,
}

#[tauri::command]
pub async fn mod_catalog_uninstall(
    mod_id: String,
    game_root: String,
) -> Result<UninstallReport, String> {
    let _gate = mod_hub_gate().await;
    mod_hub::ensure_game_closed()?;
    let mut ledger = load_ledger();
    let report = uninstall_from_ledger(&mut ledger.installs, &mod_id, &game_root)?;
    save_ledger(&ledger)?;
    tracing::info!(id = %report.id, removed = report.removed_files, restored = report.restored_files, "mod_catalog_uninstall done");
    Ok(report)
}

/// Uninstall core, split from the command so tests can drive it against a
/// plain record list. Removes recorded files (`@game/` entries from the game
/// root, the rest from res_mods), restores snapshots, drops the record.
pub(crate) fn uninstall_from_ledger(
    installs: &mut Vec<ModInstallRecord>,
    mod_id: &str,
    game_root: &str,
) -> Result<UninstallReport, String> {
    let Some(record) = installs.iter().find(|r| r.id == mod_id).cloned() else {
        return Err(format!("{mod_id} has no install record"));
    };

    // The files may live under an older bin/<version> after a game update —
    // clean up where they were actually written.
    let res_mods = Path::new(game_root)
        .join("bin")
        .join(&record.bin_version)
        .join("res_mods");
    let mut removed = 0usize;
    for rel in &record.files {
        // The loader marker is shared and never deleted by the plain file
        // loop — a foreign (non-empty) one must survive even the last
        // uninstall; our own 0-byte placeholder is dropped by the
        // ref-count pass below once the last user is gone.
        if rel == "PnFModsLoader.py" {
            continue;
        }
        let path = match rel.strip_prefix("@game/") {
            Some(rest) => Path::new(game_root).join(rest),
            None => res_mods.join(rel),
        };
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
            removed += 1;
        }
        // A disabled mod's files live under `.bak` twins — they must not
        // survive the uninstall as ghost payloads the next scan resurrects.
        let twin = mod_hub::sibling_with_suffix(&path, ".bak");
        if twin.is_file() {
            fs::remove_file(&twin).map_err(|e| format!("remove {}: {e}", twin.display()))?;
            removed += 1;
        }
    }
    if res_mods.is_dir() {
        // Prune directories this mod emptied (never above res_mods itself).
        let mut dirs: Vec<PathBuf> = record
            .files
            .iter()
            .filter(|rel| !rel.starts_with("@game/"))
            .filter_map(|rel| res_mods.join(rel).parent().map(|p| p.to_path_buf()))
            .collect();
        dirs.sort();
        dirs.dedup();
        for dir in dirs.into_iter().rev() {
            let _ = fs::remove_dir(dir); // succeeds only when empty
        }
    }

    // Bring back whatever this install had snapshotted over.
    let mut restored = 0usize;
    if let Some(dir) = record.restore_dir.as_ref() {
        let restore = PathBuf::from(dir);
        if restore.is_dir() {
            restored = restore_tree(&restore, &res_mods, Path::new(game_root))?;
            fs::remove_dir_all(&restore).ok();
        }
    }

    installs.retain(|r| r.id != mod_id);

    // The 0-byte loader marker is a shared component: when the last record
    // referencing it is gone, drop our placeholder — a non-empty loader
    // shipped with a real modpack (Aslain & co.) is never ours to touch.
    if record.files.iter().any(|f| f == "PnFModsLoader.py")
        && !installs
            .iter()
            .any(|r| r.files.iter().any(|f| f == "PnFModsLoader.py"))
    {
        let loader = res_mods.join("PnFModsLoader.py");
        let is_placeholder = loader.metadata().map(|m| m.len() == 0).unwrap_or(false);
        if is_placeholder {
            fs::remove_file(&loader).map_err(|e| format!("remove {}: {e}", loader.display()))?;
            removed += 1;
            tracing::info!("removed the shared PnFModsLoader.py placeholder");
        }
    }
    Ok(UninstallReport {
        id: record.id,
        name: record.name,
        removed_files: removed,
        restored_files: restored,
    })
}

/// Copy a snapshot tree back: entries under `@game/` land in the game root,
/// everything else in res_mods. Returns the restored file count.
fn restore_tree(from: &Path, res_mods: &Path, game_root: &Path) -> Result<usize, String> {
    let mut count = 0usize;
    let mut stack = vec![from.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for ent in fs::read_dir(&dir)
            .map_err(|e| format!("read {}: {e}", dir.display()))?
            .flatten()
        {
            let src = ent.path();
            if src.is_dir() {
                stack.push(src);
                continue;
            }
            let Ok(rel) = src.strip_prefix(from) else {
                continue;
            };
            let dest = if let Ok(rest) = rel.strip_prefix("@game") {
                let rest = rest.to_string_lossy();
                let rest = rest.trim_start_matches(['/', '\\']);
                game_root.join(rest)
            } else {
                res_mods.join(rel)
            };
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            fs::copy(&src, &dest).map_err(|e| format!("restore {}: {e}", dest.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zip, data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extracts_zip_and_records_paths() {
        let tmp = std::env::temp_dir().join("wowsp_zipx_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        zip_fixture(
            &tmp.join("pack.zip"),
            &[
                ("res_mods/gui/a.png", b"a"),
                ("res_mods/ime_config.xml", b"<x/>"),
            ],
        );
        let dest = tmp.join("out");
        let mut visited = Vec::new();
        extract_zip(&tmp.join("pack.zip"), &dest, &mut visited).unwrap();
        assert!(dest.join("res_mods/gui/a.png").is_file());
        assert!(dest.join("res_mods/ime_config.xml").is_file());
        assert_eq!(visited.len(), 2);

        // `..`-escaping entries are skipped, not followed.
        zip_fixture(
            &tmp.join("evil.zip"),
            &[("../evil.txt", b"x"), ("ok.txt", b"y")],
        );
        let mut visited2 = Vec::new();
        extract_zip(&tmp.join("evil.zip"), &tmp.join("out2"), &mut visited2).unwrap();
        assert!(!tmp.join("evil.txt").exists());
        assert_eq!(visited2, vec!["ok.txt"]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn unpack_and_install_full_pipeline() {
        // Exercises the whole catalog install leg without network: two part
        // archives -> unpack -> res_mods peel -> classify -> install, plus a
        // loose game-root DLL, with the written list the ledger stores.
        let tmp = std::env::temp_dir().join("wowsp_catalog_pipeline");
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        fs::create_dir_all(&work).unwrap();
        zip_fixture(
            &work.join("00-part1.zip"),
            &[
                ("res_mods/gui/x/a.png", b"a"),
                ("res_mods/ime_config.xml", b"<ime/>"),
            ],
        );
        // Real-shape game-root payload (gettext_x64r.dll on text mods).
        zip_fixture(&work.join("01-part2.zip"), &[("gettext_x64r.dll", b"dll")]);
        // Downloaded files land as `<index>-<asset name>` (see the install
        // command), so the packages carry bare asset names here.
        let mk = |name: &str| CatalogPackage {
            url: format!("https://example.com/{name}"),
            sha256: String::new(),
            size: 0,
            name: name.into(),
        };
        let packages = vec![mk("part1.zip"), mk("part2.zip")];
        let game = tmp.join("game/bin/1");
        fs::create_dir_all(&game).unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));

        let (report, written, restore) =
            unpack_and_install("test-mod", &work, &game_root, &packages).unwrap();
        assert_eq!(report.bin_version, "1");
        let res_mods = tmp.join("game/bin/1/res_mods");
        assert!(res_mods.join("gui/x/a.png").is_file());
        assert!(res_mods.join("ime_config.xml").is_file());
        assert!(tmp.join("game/gettext_x64r.dll").is_file());
        assert!(written.contains(&"ime_config.xml".to_string()));
        assert!(written.contains(&"gui/x/a.png".to_string()));
        assert!(written.contains(&"@game/gettext_x64r.dll".to_string()));
        assert!(restore.is_none(), "fresh install overwrites nothing");

        // Re-install over it: the overwritten originals must be snapshotted.
        let (_report2, _written2, restore2) =
            unpack_and_install("test-mod", &work, &game_root, &packages).unwrap();
        let restore2 = restore2.expect("second install snapshots overwritten files");
        assert!(restore2.join("ime_config.xml").is_file());
        assert!(restore2.join("@game/gettext_x64r.dll").is_file());

        // Uninstall removes both roots and restores the snapshots.
        let mut installs = vec![ModInstallRecord {
            id: "test-mod".into(),
            name: "test".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: written,
            restore_dir: Some(restore2.to_string_lossy().into_owned()),
        }];
        let removed = uninstall_from_ledger(&mut installs, "test-mod", &game_root).unwrap();
        assert_eq!(removed.removed_files, 3);
        // All three overwrite victims (both res_mods files + the game-root
        // DLL) come back as install #1's copies: nested snapshots now
        // actually happen — the old best-effort copy silently skipped them
        // whenever the snapshot parent directory did not exist yet.
        assert_eq!(removed.restored_files, 3);
        assert!(res_mods.join("ime_config.xml").is_file());
        assert_eq!(
            fs::read(res_mods.join("ime_config.xml")).unwrap(),
            b"<ime/>"
        );
        assert!(res_mods.join("gui/x/a.png").is_file());
        assert_eq!(fs::read(tmp.join("game/gettext_x64r.dll")).unwrap(), b"dll");
        assert!(installs.is_empty());

        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    #[test]
    fn uninstall_removes_disabled_bak_twins() {
        // A mod disabled through the hub lives as `.bak` twins; uninstalling
        // it must remove those too — otherwise the next scan resurrects a
        // ghost unit and the files linger in res_mods forever.
        let tmp = std::env::temp_dir().join("wowsp_twin_uninstall");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods/gui");
        fs::create_dir_all(&rm).unwrap();
        fs::write(rm.join("a.png.bak"), b"disabled").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mut installs = vec![ModInstallRecord {
            id: "m".into(),
            name: "M".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/a.png".into()],
            restore_dir: None,
        }];
        let report = uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(report.removed_files, 1);
        assert!(!rm.join("a.png.bak").exists());
        assert!(installs.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn reinstall_rewinds_to_vanilla_baseline() {
        // The catalog install rewinds the previous record before writing the
        // new one. This test drives the exact sequence the command performs:
        // after v1 → rewind → v2, the final uninstall must restore the
        // VANILLA file, not v1's modded copy (the old chained-snapshot bug).
        let tmp = std::env::temp_dir().join("wowsp_rewind_reinstall");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("ime_config.xml"), b"vanilla").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));

        let run = |work: &Path, ime: &[u8], gui: &str| {
            fs::create_dir_all(work).unwrap();
            zip_fixture(
                &work.join("00-part1.zip"),
                &[("res_mods/ime_config.xml", ime), (gui.as_ref(), b"g")],
            );
            let packages = vec![CatalogPackage {
                url: "https://example.com/part1.zip".into(),
                sha256: String::new(),
                size: 0,
                name: "part1.zip".into(),
            }];
            unpack_and_install("m", work, &game_root, &packages).unwrap()
        };

        // v1 adds a file the v2 package drops — leftovers must not survive.
        let (_r1, written1, restore1) = run(&tmp.join("work1"), b"v1", "res_mods/gui/keep1.png");
        let mut installs = vec![ModInstallRecord {
            id: "m".into(),
            name: "m".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: written1,
            restore_dir: restore1.map(|p| p.to_string_lossy().into_owned()),
        }];

        // Reinstall: rewind the old record first (exactly what
        // `mod_catalog_install` now does before unpacking the new version).
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(fs::read(game.join("ime_config.xml")).unwrap(), b"vanilla");
        assert!(
            !game.join("gui/keep1.png").exists(),
            "dropped files must go"
        );

        let (_r2, written2, restore2) = run(&tmp.join("work2"), b"v2", "res_mods/gui/keep2.png");
        installs.push(ModInstallRecord {
            id: "m".into(),
            name: "m".into(),
            version: "2".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: written2,
            restore_dir: restore2.map(|p| p.to_string_lossy().into_owned()),
        });

        // Final uninstall rewinds to VANILLA, not to v1.
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(fs::read(game.join("ime_config.xml")).unwrap(), b"vanilla");
        assert!(!game.join("gui/keep2.png").exists());

        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    #[test]
    fn uninstall_drops_shared_loader_only_when_last() {
        // The 0-byte loader marker is ref-counted across records; a
        // non-empty foreign loader is never ours to remove.
        let tmp = std::env::temp_dir().join("wowsp_loader_refcount");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(rm.join("PnFMods/A")).unwrap();
        fs::create_dir_all(rm.join("PnFMods/B")).unwrap();
        fs::write(rm.join("PnFMods/A/Main.py"), b"a").unwrap();
        fs::write(rm.join("PnFMods/B/Main.py"), b"b").unwrap();
        fs::write(rm.join("PnFModsLoader.py"), b"").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, main: &str| ModInstallRecord {
            id: id.into(),
            name: id.into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec![format!("PnFMods/{main}/Main.py"), "PnFModsLoader.py".into()],
            restore_dir: None,
        };
        let mut installs = vec![mk("a", "A"), mk("b", "B")];
        uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert!(rm.join("PnFModsLoader.py").is_file(), "still ref-counted");
        uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert!(!rm.join("PnFModsLoader.py").exists(), "last user gone");

        // A foreign (non-empty) loader survives even the last uninstall.
        fs::create_dir_all(rm.join("PnFMods/A")).unwrap();
        fs::write(rm.join("PnFModsLoader.py"), b"# Aslain").unwrap();
        let mut installs = vec![mk("c", "A")];
        fs::write(rm.join("PnFMods/A/Main.py"), b"a").unwrap();
        uninstall_from_ledger(&mut installs, "c", &game_root).unwrap();
        assert!(rm.join("PnFModsLoader.py").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn parses_publisher_index_shape() {
        let raw = serde_json::json!({
            "schema": 1,
            "source": {"content_version": "v.15.7.0 #10", "game_version": "15.7.0"},
            "mods": {
                "ui-timers-shot-timer": {
                    "id": "ui-timers-shot-timer",
                    "category": "battle",
                    "discussion": 111,
                    "latest": "15.7.0.10",
                    "game": ">=15.7 <15.8",
                    "versions": {
                        "15.7.0.10": {
                            "game": ">=15.7 <15.8",
                            "title": "Shot Timer",
                            "name_en": "Shot Timer",
                            "name_zh": "开火后倒计时20s",
                            "i18n": {
                                "zh-CN": {"name": "开火后倒计时20s", "desc": "主炮开火被点亮后按 20 秒倒计时提示灭点。"},
                                "ja-JP": {"name": "射撃後タイマー", "desc": "主砲発射後に20秒のカウントダウンを表示。"}
                            },
                            "packages": [
                                {"url": "https://github.com/x/a.zip", "sha256": "aa", "size": 10, "name": "a.zip"}
                            ]
                        }
                    }
                },
                "empty-mod": {"latest": "1", "versions": {"1": {"title": "no packages"}}}
            }
        });
        let index = parse_index(&raw).unwrap();
        assert_eq!(index.source_version, "v.15.7.0 #10");
        assert_eq!(index.game_version, "15.7.0");
        assert_eq!(index.mods.len(), 1, "package-less entries are dropped");
        let m = &index.mods[0];
        assert_eq!(m.id, "ui-timers-shot-timer");
        assert_eq!(m.name_zh, "开火后倒计时20s");
        assert_eq!(m.discussion, Some(111));
        assert_eq!(m.packages[0].size, 10);
        assert_eq!(m.i18n.len(), 2, "both locales survive the round-trip");
        assert_eq!(m.i18n["ja-JP"].name, "射撃後タイマー");
    }

    #[test]
    fn ledger_roundtrips() {
        // Ledger file location follows the app data dir; write through the
        // same helpers the commands use so the shape stays in lock-step.
        let ledger = Ledger {
            installs: vec![ModInstallRecord {
                id: "x".into(),
                name: "X".into(),
                version: "1".into(),
                category: "battle".into(),
                source: "mod-hub".into(),
                discussion: Some(9),
                bin_version: "1".into(),
                installed_at: "2026-01-01T00:00:00Z".into(),
                files: vec!["a.xml".into()],
                restore_dir: None,
            }],
        };
        let json = serde_json::to_string_pretty(&ledger).unwrap();
        let back: Ledger = serde_json::from_str(&json).unwrap();
        assert_eq!(back.installs[0].id, "x");
        assert_eq!(back.installs[0].files, vec!["a.xml"]);
    }
}
