//! The mod-tags registry: localized tag definitions (feature markers like
//! licensed / AI-generated, IP origins like Blue Archive) for catalog
//! entries. Ships bundled (`res/mod-tags.json`, compiled in) and refreshes
//! from the `mod-tags` GitHub release asset — the release is the hot
//! channel, so tags can be added or reworded without shipping an app
//! update. Cache TTL is one day; every failure falls back to the newest
//! parseable copy (cached remote, then bundled).

use std::fs;

use wowsp_tauri_shared::CatalogTagIndex;

use crate::paths;

const CACHE_FILE: &str = "mod-tags.json";
const CACHE_TTL_HOURS: i64 = 24;

/// Bundled registry — the seed and the last-resort fallback.
const BUNDLED: &str = include_str!("../../../../../res/mod-tags.json");

fn tag_urls() -> Vec<String> {
    super::github_mirror::candidates(
        "https://github.com/langyo/wowsp/releases/download/mod-tags/mod-tags.json",
    )
}

fn cache_path() -> Result<std::path::PathBuf, String> {
    Ok(paths::ensure_data_dir()?.join(CACHE_FILE))
}

fn parse(raw: &str) -> Option<CatalogTagIndex> {
    // Strict shape: schema 1 with a non-empty tag list. A malformed remote
    // file must never displace a good bundled/cached copy.
    let idx: CatalogTagIndex = serde_json::from_str(raw).ok()?;
    (idx.schema == 1 && !idx.tags.is_empty()).then_some(idx)
}

fn cached_fresh(path: &std::path::Path) -> Option<CatalogTagIndex> {
    let raw = fs::read_to_string(path).ok()?;
    let idx = parse(&raw)?;
    let fetched = fs::metadata(path).ok()?.modified().ok()?;
    let fetched: chrono::DateTime<chrono::Utc> = fetched.into();
    let age_h = chrono::Utc::now()
        .signed_duration_since(fetched)
        .num_hours();
    (age_h < CACHE_TTL_HOURS).then_some(idx)
}

async fn fetch_remote() -> Option<CatalogTagIndex> {
    let client = super::network::build_http_client().ok()?;
    for url in tag_urls() {
        let Ok(resp) = client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(text) = resp.text().await else {
            continue;
        };
        if let Some(idx) = parse(&text) {
            if let Ok(path) = cache_path() {
                // Unique tmp name: two windows fetching concurrently never
                // tear each other's partial writes.
                let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
                if fs::write(&tmp, &text).is_ok() && fs::rename(&tmp, &path).is_ok() {
                    return Some(idx); // cached for the next offline day
                }
            }
            return Some(idx);
        }
        tracing::warn!(url = %url, "remote mod-tags registry rejected (bad shape or empty) — trying next candidate");
    }
    None
}

/// The registry, freshest-first: fresh cache → remote refresh → stale
/// cache → bundled. Read-only for callers; the refresh happens inline on
/// the (rare) expired-cache path.
#[tauri::command]
pub async fn mod_tags() -> Result<CatalogTagIndex, String> {
    let path = cache_path()?;
    if let Some(idx) = cached_fresh(&path) {
        return Ok(idx);
    }
    if let Some(idx) = fetch_remote().await {
        return Ok(idx);
    }
    // Offline / unreachable: whatever the cache holds, else the bundle.
    tracing::warn!("mod-tags refresh failed — serving the newest local copy");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Some(idx) = parse(&raw) {
            return Ok(idx);
        }
    }
    parse(BUNDLED).ok_or_else(|| "bundled mod-tags registry is malformed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_parses() {
        let idx = parse(BUNDLED).expect("bundled registry parses");
        assert_eq!(idx.schema, 1);
        assert!(idx.tags.iter().any(|t| t.id == "ai-generated"));
        assert!(idx.tags.iter().any(|t| t.id == "ip-blue-archive"));
        // Every tag carries a zh-CN and en-US name (the UI's fallback pair).
        for t in &idx.tags {
            assert!(t.i18n.contains_key("en-US"), "{}: missing en-US", t.id);
            assert!(t.i18n.contains_key("zh-CN"), "{}: missing zh-CN", t.id);
        }
    }

    #[test]
    fn malformed_or_empty_registries_are_rejected() {
        assert!(parse("{}").is_none());
        assert!(parse(r#"{"schema": 2, "tags": []}"#).is_none());
        assert!(parse(r#"{"schema": 1, "tags": []}"#).is_none());
        assert!(parse("not json").is_none());
    }
}
