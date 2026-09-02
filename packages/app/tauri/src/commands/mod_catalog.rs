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

/// Direct download first, then the updater's CN mirror prefixes.
fn index_urls() -> Vec<String> {
    let path = "langyo/wowsp/releases/download/mod-hub/mod-index.json";
    vec![
        format!("https://github.com/{path}"),
        format!("https://ghp.ci/https://github.com/{path}"),
        format!("https://gh-proxy.com/https://github.com/{path}"),
        format!("https://ghfast.top/https://github.com/{path}"),
        format!("https://ghproxy.net/https://github.com/{path}"),
    ]
}

fn data_file(rel: &str) -> Result<PathBuf, String> {
    let dir = paths::ensure_data_dir()?;
    Ok(dir.join(rel))
}

// ── Index fetch / parse ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn mod_catalog_refresh(force: bool) -> Result<CatalogIndex, String> {
    if !force {
        if let Some(cached) = load_cached_index() {
            return Ok(cached);
        }
    }
    let index = fetch_index().await?;
    let path = data_file(INDEX_CACHE_FILE)?;
    let json = serde_json::to_string(&index).map_err(|e| format!("serialize index: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("write cache: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename cache: {e}"))?;
    Ok(index)
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
struct Ledger {
    #[serde(default)]
    installs: Vec<ModInstallRecord>,
}

fn load_ledger() -> Ledger {
    fs::read_to_string(data_file(LEDGER_FILE).unwrap_or_default())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_ledger(ledger: &Ledger) -> Result<(), String> {
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
    let work = std::env::temp_dir().join(format!(
        "wowsp-modhub-{}-{}",
        entry.id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    fs::create_dir_all(&work).map_err(|e| format!("create workdir: {e}"))?;

    let mut received_total = 0u64;
    let total = entry.packages.iter().map(|p| p.size).sum::<u64>().max(1);
    for (i, pkg) in entry.packages.iter().enumerate() {
        let resp = client
            .get(&pkg.url)
            .send()
            .await
            .map_err(|e| format!("download {}: {e}", pkg.name))?;
        if !resp.status().is_success() {
            return Err(format!("download {}: HTTP {}", pkg.name, resp.status()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("download {}: {e}", pkg.name))?;
        if !pkg.sha256.is_empty() {
            let digest = hex::encode(Sha256::digest(&bytes));
            if digest != pkg.sha256.to_ascii_lowercase() {
                return Err(format!(
                    "{} failed the SHA-256 check ({} != {}); the package on the release is damaged or was swapped",
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
        let dest = work.join(format!("{i:02}-{}", pkg.name));
        fs::write(&dest, &bytes).map_err(|e| format!("write {}: {e}", pkg.name))?;
        received_total += bytes.len() as u64;
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

    // Unpack + classify + write are blocking fs work — keep them off the
    // async runtime threads.
    let unpack_id = entry.id.clone();
    let unpack_root = game_root.clone();
    let unpack_pkgs = entry.packages.clone();
    let unpack_work = work.clone();
    let (report, written, restore_dir) = tauri::async_runtime::spawn_blocking(move || {
        unpack_and_install(&unpack_id, &unpack_work, &unpack_root, &unpack_pkgs)
    })
    .await
    .map_err(|e| format!("install task: {e}"))??;

    let mut ledger = load_ledger();
    ledger.installs.retain(|r| r.id != entry.id);
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

    fs::remove_dir_all(&work).ok();
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

    let game = Path::new(game_root);
    let res_mods_src = extract_root.join("res_mods");
    let (applied, loose) = if res_mods_src.is_dir() {
        let plan = mod_hub::classify_package(&res_mods_src)?;
        let applied = mod_hub::install_plan(&res_mods_src, game_root, &plan)?;
        (applied, loose_root_files(&extract_root)?)
    } else {
        let plan = mod_hub::classify_package(&extract_root)?;
        let applied = mod_hub::install_plan(&extract_root, game_root, &plan)?;
        (applied, Vec::new())
    };

    // Loose game-root payloads (gettext_x64r.dll …), ledger-recorded under an
    // `@game/` prefix so uninstall can find them again.
    let mut written = applied.written;
    let mut restore_dir = applied.restore_dir;
    for name in loose {
        let src = extract_root.join(&name);
        let dest = game.join(&name);
        if dest.is_file() {
            // The `@game/` subdir mirrors the res_mods snapshots inside the
            // same restore dir, so one uninstall restores both roots.
            let dir = match restore_dir.clone() {
                Some(dir) => dir,
                None => {
                    let dir = mod_hub::restore_root().join(format!(
                        "{}-{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis(),
                        sanitize_for_restore(&applied.report.name)
                    ));
                    fs::create_dir_all(&dir).ok();
                    restore_dir = Some(dir.clone());
                    dir
                },
            };
            let snap = dir.join("@game").join(&name);
            if let Some(parent) = snap.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::copy(&dest, &snap).ok();
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::copy(&src, &dest).map_err(|e| format!("copy {}: {e}", dest.display()))?;
        written.push(format!("@game/{name}"));
    }

    Ok((applied.report, written, restore_dir))
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

fn sanitize_for_restore(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
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
pub fn mod_catalog_uninstall(mod_id: String, game_root: String) -> Result<UninstallReport, String> {
    let mut ledger = load_ledger();
    let report = uninstall_from_ledger(&mut ledger.installs, &mod_id, &game_root)?;
    save_ledger(&ledger)?;
    tracing::info!(id = %report.id, removed = report.removed_files, restored = report.restored_files, "mod_catalog_uninstall done");
    Ok(report)
}

/// Uninstall core, split from the command so tests can drive it against a
/// plain record list. Removes recorded files (`@game/` entries from the game
/// root, the rest from res_mods), restores snapshots, drops the record.
fn uninstall_from_ledger(
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
        let path = match rel.strip_prefix("@game/") {
            Some(rest) => Path::new(game_root).join(rest),
            None => res_mods.join(rel),
        };
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
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
        assert_eq!(removed.restored_files, 2);
        // The overwrite victim comes back (install #1's copy); the DLL had no
        // earlier original, so it is simply gone.
        // The overwrite victims come back (install #1's copies) — uninstall
        // rewinds the LAST install, it does not blindly delete.
        assert!(res_mods.join("ime_config.xml").is_file());
        assert_eq!(
            fs::read(res_mods.join("ime_config.xml")).unwrap(),
            b"<ime/>"
        );
        assert_eq!(fs::read(tmp.join("game/gettext_x64r.dll")).unwrap(), b"dll");
        assert!(installs.is_empty());

        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
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
