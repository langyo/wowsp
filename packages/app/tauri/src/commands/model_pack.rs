//! Resource-pack downloader: fetches generated asset packs from GitHub
//! Releases on first launch and caches them in AppData. Subsequent launches
//! skip the download as long as the cached asset upload timestamp is
//! unchanged.
//!
//! Tag convention (shared by every pack):
//!   `res-latest`           — newest pack (primary download target)
//!   `res-latest-old-1`     — previous pack (fallback)
//!   `res-latest-old-2`     — two versions back (final fallback)
//!
//! Packs (each a top-level `<dir>/` subtree inside its tar.gz):
//!   `wowsp-models.tar.gz`   baked GLB models → `ensure_model_pack()`
//!   `wowsp-dogtags.tar.gz`  dog-tag map + part PNGs → `ensure_dogtag_pack()`
//!
//! The frontend calls the `ensure_*` commands once at startup; the returned
//! cache directory is the pack parent, and assets are served through
//! `convertFileSrc`. Each pack tracks its own `.version` file (`.version` is
//! the historical models file), so refreshing the small dog-tag pack never
//! re-downloads the ~500 MB model pack.

use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use reqwest::Client;
use tar::Archive;

const REPO: &str = "langyo/wowsp";
const MODELS_ASSET: &str = "wowsp-models.tar.gz";
const DOGTAGS_ASSET: &str = "wowsp-dogtags.tar.gz";
const RELEASE_TAGS: [&str; 3] = ["res-latest", "res-latest-old-1", "res-latest-old-2"];

fn cache_dir() -> Result<PathBuf, String> {
    crate::paths::ensure_cache_dir()
}

fn version_file(name: &str) -> Result<PathBuf, String> {
    Ok(cache_dir()?.join(name))
}

fn cached_version(name: &str) -> Option<String> {
    fs::read_to_string(version_file(name).ok()?).ok()
}

fn write_cached_version(name: &str, version: &str) -> Result<(), String> {
    let dir = cache_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    fs::write(version_file(name)?, version).map_err(|e| format!("write version: {e}"))
}

/// Resolve a GitHub Release asset download URL + upload timestamp for a tag.
/// The timestamp is the cache version: the tag stays fixed (res-latest) across
/// packs, so the asset's updated_at is what tells an already-installed app a
/// new pack was published.
async fn release_asset_info(
    client: &Client,
    tag: &str,
    asset_name: &str,
) -> Result<(String, String), String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
    let resp: serde_json::Value = client
        .get(&url)
        .header("User-Agent", "WoWSP-model-pack/1.0")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("fetch release {tag}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse release {tag}: {e}"))?;

    let assets = resp["assets"]
        .as_array()
        .ok_or_else(|| format!("release {tag} has no assets"))?;

    for asset in assets {
        let name = asset["name"].as_str().unwrap_or("");
        if name == asset_name {
            let download_url = asset["browser_download_url"]
                .as_str()
                .ok_or_else(|| format!("asset {asset_name} missing download_url"))?
                .to_string();
            let updated_at = asset["updated_at"].as_str().unwrap_or("").to_string();
            return Ok((download_url, updated_at));
        }
    }
    Err(format!("asset {asset_name} not found in release {tag}"))
}

/// Download and extract a pack from an asset URL. `subdir` is the archive's
/// top-level directory; it is wiped first so stale files never linger.
async fn download_and_extract(
    url: &str,
    dest: &Path,
    subdir: &str,
    client: &Client,
) -> Result<(), String> {
    tracing::info!(url, "downloading resource pack");

    let response = client
        .get(url)
        .header("User-Agent", "WoWSP-model-pack/1.0")
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;

    let body = response
        .bytes()
        .await
        .map_err(|e| format!("read response: {e}"))?;
    let cursor = io::Cursor::new(&body[..]);

    // Remove existing pack contents so we don't accumulate stale files.
    let pack_root = dest.join(subdir);
    if pack_root.exists() {
        fs::remove_dir_all(&pack_root).map_err(|e| format!("clean {subdir} dir: {e}"))?;
    }
    fs::create_dir_all(&pack_root).map_err(|e| format!("create {subdir} dir: {e}"))?;

    let gz = GzDecoder::new(cursor);
    let mut archive = Archive::new(gz);
    archive
        .unpack(dest)
        .map_err(|e| format!("extract resource pack: {e}"))?;

    tracing::info!(url, "resource pack extracted");
    Ok(())
}

/// Ensure one pack is present in the local cache.
///
/// Returns the cache root directory (the parent of `subdir`) so the frontend
/// can construct paths like `<cache>/models/ships/Yamato.glb`.
///
/// Lookup order: res-latest, then res-latest-old-1, then res-latest-old-2.
/// The cache version is the asset upload timestamp (not the fixed tag), so a
/// re-published pack is re-downloaded on the next launch. When no release is
/// reachable, an installer-shipped `<subdir>/` beside the cache still counts
/// as present (the shun installer stages models/ that way).
async fn ensure_pack(asset_name: &str, version_name: &str, subdir: &str) -> Result<String, String> {
    let cache_dir = cache_dir()?;
    let client = crate::commands::network::build_http_client()?;

    // If the latest asset version already matches the cache, skip the download.
    if let Ok((_url, version)) = release_asset_info(&client, RELEASE_TAGS[0], asset_name).await {
        if cached_version(version_name).as_deref() == Some(version.as_str()) {
            tracing::info!(?cache_dir, subdir, "resource pack up to date");
            return Ok(cache_dir.to_string_lossy().to_string());
        }
    }

    // Download + extract, trying each tag in order.
    let mut last_err = format!("no {asset_name} tags available");
    for tag in RELEASE_TAGS {
        match release_asset_info(&client, tag, asset_name).await {
            Err(e) => {
                tracing::warn!(?e, tag, "pack resolve failed");
                last_err = e;
            },
            Ok((url, version)) => {
                match download_and_extract(&url, &cache_dir, subdir, &client).await {
                    Ok(()) => {
                        write_cached_version(version_name, &version)?;
                        return Ok(cache_dir.to_string_lossy().to_string());
                    },
                    Err(e) => {
                        tracing::warn!(?e, tag, "pack download failed");
                        last_err = e;
                    },
                }
            },
        }
    }

    // Installer-shipped pack: the shun installer stages models/ beside the
    // cache. When no release is reachable (offline machine, res-latest not
    // published yet), serve what shipped instead of failing — otherwise the
    // frontend would fall back to empty publicDir placeholders.
    let shipped = fs::read_dir(cache_dir.join(subdir))
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if shipped {
        tracing::warn!(?cache_dir, "using installer-shipped resource pack");
        return Ok(cache_dir.to_string_lossy().to_string());
    }

    Err(format!(
        "failed to download {asset_name} from any tag: {last_err}"
    ))
}

/// Baked GLB model pack (Three.js ships/maps). See module docs.
#[tauri::command]
pub async fn ensure_model_pack() -> Result<String, String> {
    ensure_pack(MODELS_ASSET, ".version", "models").await
}

/// Dog-tag pack (player-avatar map + part PNGs overlaying the bundled
/// snapshot, so medals from newer game clients render without an app
/// release). See module docs.
#[tauri::command]
pub async fn ensure_dogtag_pack() -> Result<String, String> {
    ensure_pack(DOGTAGS_ASSET, ".version-dogtags", "dogtags").await
}
