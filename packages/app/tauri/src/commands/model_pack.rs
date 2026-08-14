//! Model-pack downloader: fetches baked GLB models from GitHub Releases on
//! first launch and caches them in AppData. Subsequent launches skip the
//! download as long as the cached asset upload timestamp is unchanged.
//!
//! Tag convention:
//!   `res-latest`           — newest pack (primary download target)
//!   `res-latest-old-1`     — previous pack (fallback)
//!   `res-latest-old-2`     — two versions back (final fallback)
//!
//! The frontend calls `ensure_model_pack()` once at startup; the returned
//! cache directory is passed to Three.js GLTFLoader via `convertFileSrc`.

use std::fs;
use std::io;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use reqwest::Client;
use tar::Archive;

const REPO: &str = "langyo/wowsp";
const ASSET_NAME: &str = "wowsp-models.tar.gz";

fn models_cache_dir() -> Result<PathBuf, String> {
    crate::paths::ensure_cache_dir()
}

fn version_file() -> Result<PathBuf, String> {
    Ok(models_cache_dir()?.join(".version"))
}

fn cached_version() -> Option<String> {
    fs::read_to_string(version_file().ok()?).ok()
}

fn write_cached_version(version: &str) -> Result<(), String> {
    let dir = models_cache_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    fs::write(version_file()?, version).map_err(|e| format!("write version: {e}"))
}

/// Resolve a GitHub Release asset download URL + upload timestamp for a tag.
/// The timestamp is the cache version: the tag stays fixed (res-latest) across
/// packs, so the asset's updated_at is what tells an already-installed app a
/// new pack was published.
async fn release_asset_info(client: &Client, tag: &str) -> Result<(String, String), String> {
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
        if name == ASSET_NAME {
            let download_url = asset["browser_download_url"]
                .as_str()
                .ok_or_else(|| format!("asset {ASSET_NAME} missing download_url"))?
                .to_string();
            let updated_at = asset["updated_at"].as_str().unwrap_or("").to_string();
            return Ok((download_url, updated_at));
        }
    }
    Err(format!("asset {ASSET_NAME} not found in release {tag}"))
}

/// Download and extract the model pack from an asset URL.
async fn download_and_extract(url: &str, dest: &PathBuf, client: &Client) -> Result<(), String> {
    tracing::info!(url, "downloading model pack");

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

    // Remove existing models so we don't accumulate stale files.
    let models_root = dest.join("models");
    if models_root.exists() {
        fs::remove_dir_all(&models_root).map_err(|e| format!("clean models dir: {e}"))?;
    }
    fs::create_dir_all(&models_root).map_err(|e| format!("create models dir: {e}"))?;

    let gz = GzDecoder::new(cursor);
    let mut archive = Archive::new(gz);
    archive
        .unpack(dest)
        .map_err(|e| format!("extract model pack: {e}"))?;

    tracing::info!(url, "model pack extracted");
    Ok(())
}

/// Ensure the model pack is present in the local cache.
///
/// Returns the cache root directory (the parent of `models/`) so the frontend
/// can construct paths like `<cache>/models/ships/Yamato.glb`.
///
/// Lookup order: res-latest, then res-latest-old-1, then res-latest-old-2.
/// The cache version is the asset upload timestamp (not the fixed tag), so a
/// re-published pack is re-downloaded on the next launch.
#[tauri::command]
pub async fn ensure_model_pack() -> Result<String, String> {
    let cache_dir = models_cache_dir()?;
    let client = crate::commands::network::build_http_client()?;
    let tags = ["res-latest", "res-latest-old-1", "res-latest-old-2"];

    // If the latest asset version already matches the cache, skip the download.
    // The cache version is the asset upload timestamp (not the fixed tag), so a
    // re-published res-latest is re-downloaded on the next launch.
    if let Ok((_url, version)) = release_asset_info(&client, tags[0]).await {
        if cached_version().as_deref() == Some(version.as_str()) {
            tracing::info!(?cache_dir, "model pack up to date");
            return Ok(cache_dir.to_string_lossy().to_string());
        }
    }

    // Download + extract, trying each tag in order.
    let mut last_err = String::from("no model-pack tags available");
    for tag in tags {
        match release_asset_info(&client, tag).await {
            Err(e) => {
                tracing::warn!(?e, tag, "model-pack resolve failed");
                last_err = e;
            },
            Ok((url, version)) => match download_and_extract(&url, &cache_dir, &client).await {
                Ok(()) => {
                    write_cached_version(&version)?;
                    return Ok(cache_dir.to_string_lossy().to_string());
                },
                Err(e) => {
                    tracing::warn!(?e, tag, "model-pack download failed");
                    last_err = e;
                },
            },
        }
    }

    Err(format!("failed to download model pack from any tag: {last_err}"))
}
