//! The changelog feed: GitHub Releases notes for the settings' 更新日志
//! section.
//!
//! The repo keeps no changelog file on disk — merged PRs ARE the history,
//! and release notes live only on the GitHub Releases page. The section
//! therefore streams them from the release-list API through the same
//! mirror ladder every other GitHub fetch walks (user mirror → official
//! route → built-in ghproxy prefixes; mainland reachability). The command
//! is read-only and platform-neutral: no installer, no window surface,
//! just the proxy-aware HTTP client, so the phone app build serves the
//! same feed.

use serde::Serialize;
use std::time::Duration;

use crate::commands::github_mirror;
use crate::commands::network::build_http_client;

/// One page of the release list comfortably covers the app's cadence
/// (several PRs per weekly-ish release; 30 releases ≈ half a year) while
/// keeping the JSON payload small.
const RELEASES_URL: &str = "https://api.github.com/repos/langyo/wowsp/releases?per_page=30";

/// Per-mirror cap: a dead mirror must time out, not stall the section.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// One rendered release. `version` is the tag with its `v` stripped so
/// the webui can badge the running build straight against `getVersion()`.
#[derive(Debug, PartialEq, Serialize)]
pub struct ChangelogRelease {
    pub version: String,
    pub published_at: String,
    pub body: String,
}

/// Normalize a release tag into the plain semver the app reports
/// (`v0.4.5` → `0.4.5`; already-bare tags pass through). The SAME
/// release list also carries the repo's infra releases — the resource
/// pack (`res-latest`), the mod-hub store (`mod-hub`), the retained
/// delta edges (`res-delta-<hex>-<hex>`) — so only digit-leading tags
/// count as app releases (the tag-shape half of
/// `update.rs::version_from_redirect`).
fn version_from_tag(tag: &str) -> Option<String> {
    let bare = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    bare.starts_with(|c: char| c.is_ascii_digit())
        .then(|| bare.to_string())
}

/// Distill the list-API payload: keep the app releases (digit-leading
/// tags), drop drafts as belt-and-braces, and keep the API's newest-first
/// order as the display order.
fn parse_releases(payload: &serde_json::Value) -> Vec<ChangelogRelease> {
    payload
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            let version = version_from_tag(r["tag_name"].as_str()?)?;
            Some(ChangelogRelease {
                version,
                published_at: r["published_at"].as_str().unwrap_or_default().to_string(),
                body: r["body"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// Fetch the release list through the mirror ladder. Errors reach the
/// webui store verbatim — the section renders its retry state on them.
#[tauri::command]
pub async fn changelog_list() -> Result<Vec<ChangelogRelease>, String> {
    let client = build_http_client()?;
    let mut last_err = String::from("no mirror attempted for the changelog");
    for candidate in github_mirror::candidates(RELEASES_URL) {
        let resp = match client
            .get(&candidate)
            .header("User-Agent", "WoWSP-changelog/1.0")
            .header("Accept", "application/vnd.github+json")
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("{candidate}: {e}");
                continue;
            },
        };
        if !resp.status().is_success() {
            last_err = format!("{candidate}: HTTP {}", resp.status());
            continue;
        }
        // A proxy can answer 200 with a JSON error object — only an
        // array is a usable release list, anything else moves the ladder
        // on instead of rendering a silently empty section.
        match resp.json::<serde_json::Value>().await {
            Ok(v) if v.is_array() => return Ok(parse_releases(&v)),
            Ok(_) => {
                last_err = format!("{candidate}: unexpected changelog payload");
                continue;
            },
            Err(e) => {
                last_err = format!("parse releases from {candidate}: {e}");
                continue;
            },
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_keeps_only_app_tags() {
        assert_eq!(version_from_tag("v0.4.5").as_deref(), Some("0.4.5"));
        assert_eq!(version_from_tag("0.4.5").as_deref(), Some("0.4.5"));
        // Infra releases on the same list must never read as app versions.
        assert_eq!(version_from_tag("res-latest"), None);
        assert_eq!(version_from_tag("mod-hub"), None);
        assert_eq!(version_from_tag("res-delta-aa..bb"), None);
    }

    #[test]
    fn parse_keeps_order_and_drops_infra_releases() {
        let payload = serde_json::json!([
            {
                "tag_name": "v0.4.6",
                "name": "WoWSP v0.4.6",
                "published_at": "2026-09-24T04:09:10Z",
                "body": "## What's Changed"
            },
            {
                "tag_name": "res-latest",
                "name": "Model Pack (latest)",
                "published_at": "2026-09-24T00:00:00Z",
                "body": "Baked ship & map GLB models."
            },
            {"tag_name": "v0.4.6-rc1", "draft": true, "body": "invisible"},
            {
                "tag_name": "v0.4.5",
                "name": "WoWSP v0.4.5",
                "published_at": "2026-09-22T05:43:17Z",
                "body": ""
            },
        ]);
        let out = parse_releases(&payload);
        assert_eq!(
            out,
            vec![
                ChangelogRelease {
                    version: "0.4.6".into(),
                    published_at: "2026-09-24T04:09:10Z".into(),
                    body: "## What's Changed".into(),
                },
                ChangelogRelease {
                    version: "0.4.5".into(),
                    published_at: "2026-09-22T05:43:17Z".into(),
                    body: String::new(),
                },
            ]
        );
    }

    #[test]
    fn parse_skips_tagless_and_tolerates_non_arrays() {
        let payload = serde_json::json!([{"name": "tagless"}]);
        assert!(parse_releases(&payload).is_empty());
        assert!(parse_releases(&serde_json::json!({"message": "nope"})).is_empty());
        assert!(parse_releases(&serde_json::Value::Null).is_empty());
    }
}
