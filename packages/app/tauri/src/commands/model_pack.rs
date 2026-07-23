//! Model-pack downloader: fetches baked GLB models from GitHub Releases on
//! first launch and caches them in AppData. Subsequent launches skip the
//! download as long as the cache version tag matches the release tag.
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
const FALLBACK_TAGS: &[&str] = &["res-latest-old-1", "res-latest-old-2"];

fn models_cache_dir() -> Result<PathBuf, String> {
    let base = dirs_next::cache_dir()
        .ok_or_else(|| "cannot resolve LOCALAPPDATA".to_string())?;
    Ok(base.join("WoWSP"))
}

fn version_file() -> Result<PathBuf, String> {
    Ok(models_cache_dir()?.join(".version"))
}

fn cached_version() -> Option<String> {
    fs::read_to_string(version_file().ok()?).ok()
}

fn write_cached_version(tag: &str) -> Result<(), String> {
    let dir = models_cache_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create cache dir: {e}"))?;
    fs::write(version_file()?, tag).map_err(|e| format!("write version: {e}"))
}

/// Resolve a GitHub Release asset download URL for a given tag.
async fn release_asset_url(client: &Client, tag: &str) -> Result<String, String> {
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

    let assets = resp["assets"].as_array().ok_or_else(|| {
        format!("release {tag} has no assets")
    })?;

    for asset in assets {
        let name = asset["name"].as_str().unwrap_or("");
        if name == ASSET_NAME {
            return asset["browser_download_url"]
                .as_str()
                .ok_or_else(|| format!("asset {ASSET_NAME} missing download_url"))
                .map(|s| s.to_string());
        }
    }
    Err(format!("asset {ASSET_NAME} not found in release {tag}"))
}

/// Download and extract the model pack from a release tag.
async fn download_and_extract(tag: &str, dest: &PathBuf) -> Result<(), String> {
    let client = Client::new();

    let asset_url = release_asset_url(&client, tag).await?;
    tracing::info!(tag, url = %asset_url, "downloading model pack");

    let response = client
        .get(&asset_url)
        .header("User-Agent", "WoWSP-model-pack/1.0")
        .send()
        .await
        .map_err(|e| format!("download {tag}: {e}"))?;

    let body = response
        .bytes()
        .await
        .map_err(|e| format!("read response {tag}: {e}"))?;
    let cursor = io::Cursor::new(&body[..]);

    // Remove existing models so we don't accumulate stale files.
    let models_root = dest.join("models");
    if models_root.exists() {
        fs::remove_dir_all(&models_root)
            .map_err(|e| format!("clean models dir: {e}"))?;
    }
    fs::create_dir_all(&models_root)
        .map_err(|e| format!("create models dir: {e}"))?;

    let gz = GzDecoder::new(cursor);
    let mut archive = Archive::new(gz);
    archive
        .unpack(dest)
        .map_err(|e| format!("extract model pack: {e}"))?;

    write_cached_version(tag)?;
    tracing::info!(tag, "model pack extracted");

    Ok(())
}

/// Ensure the model pack is present in the local cache.
///
/// Returns the cache root directory (the parent of `models/`) so the frontend
/// can construct paths like `<cache>/models/ships/Yamato.glb`.
///
/// Lookup order:
///   1. Check [cached_version] — if matching the latest tag, skip download.
///   2. Try `res-latest` tag.
///   3. Fall back to `res-latest-old-1`, then `res-latest-old-2`.
#[tauri::command]
pub async fn ensure_model_pack() -> Result<String, String> {
    let primary_tag = "res-latest";
    let cache_dir = models_cache_dir()?;

    // Already cached and version matches? Skip.
    if let Some(cached) = cached_version() {
        if cached == primary_tag {
            tracing::info!(?cache_dir, "model pack up to date");
            return Ok(cache_dir.to_string_lossy().to_string());
        }
    }

    // Try primary tag first.
    if let Err(e) = download_and_extract(primary_tag, &cache_dir).await {
        tracing::warn!(?e, "primary model-pack download failed, trying fallbacks");

        // Try fallback tags in order.
        let mut ok = false;
        for tag in FALLBACK_TAGS {
            match download_and_extract(tag, &cache_dir).await {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(e2) => {
                    tracing::warn!(?e2, tag, "fallback model-pack download failed");
                }
            }
        }
        if !ok {
            return Err(format!(
                "failed to download model pack from any tag. Primary: {e}. \
                 Fallbacks exhausted."
            ));
        }
    }

    Ok(cache_dir.to_string_lossy().to_string())
}
