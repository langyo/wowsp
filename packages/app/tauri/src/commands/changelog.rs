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
//!
//! Streaming is progressive: each call returns one visible batch plus the
//! raw-page cursor to continue from — the webui loads the first batch on
//! section open and refills as the user scrolls (see stores/changelog.ts).

use anyhow::Error;
use serde::Serialize;
use std::time::Duration;

use wowsp_tauri_shared::CommandResult;

use crate::commands::github_mirror;
use crate::commands::network::HttpPair;
use crate::commands::upstream_health;

/// Release-list API of this repo, without query — `fetch_raw_page` appends
/// the paging pair.
const RELEASES_URL: &str = "https://api.github.com/repos/langyo/wowsp/releases";

/// Visible batch the webui asks for per load: large enough to fill the
/// pane, small enough that scrolling to history actually has to fetch it.
const RELEASES_PER_PAGE: usize = 10;

/// Raw page size requested from GitHub: equal to the visible batch. A
/// full page only IMPLIES a next one — the rare exact-boundary end (the
/// last page exactly full) costs one extra empty fetch, never a dropped
/// release. GitHub pages carry no item cursor, so the fancier scheme (a
/// one-item peek beyond the batch) would silently drop that item at
/// every full-page boundary.
const RAW_PER_PAGE: usize = RELEASES_PER_PAGE;

/// Raw-page budget per command call: a window stuffed with infra releases
/// (the res-delta edges, mod-hub) must refill the visible batch without
/// spinning unbounded.
const RAW_PAGE_BUDGET: u32 = 3;

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

/// One streamed batch of the feed. `has_more` + `next_page` are the
/// continuation the webui hands straight back into the next call:
/// `next_page` is a RAW-page cursor (extra pages are consumed behind the
/// scenes when a window runs dense with infra releases), not a release
/// count — 0 once the list is exhausted.
#[derive(Debug, PartialEq, Serialize)]
pub struct ChangelogPage {
    pub releases: Vec<ChangelogRelease>,
    pub has_more: bool,
    pub next_page: u32,
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

/// Distill ONE raw page of `per_page` requested items: a full page only
/// IMPLIES a next one (`has_more`), the infra-tag filter of
/// `version_from_tag` runs over the whole window, and the API's
/// newest-first order is preserved. An exact-boundary end (last page
/// exactly full) surfaces as one more empty, `has_more: false` page —
/// a wasted fetch, never a dropped release.
fn parse_page(payload: &serde_json::Value, per_page: usize) -> (Vec<ChangelogRelease>, bool) {
    let raw = payload.as_array();
    let has_more = raw.is_some_and(|a| a.len() >= per_page);
    let releases = raw
        .into_iter()
        .flatten()
        .take(per_page)
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            let version = version_from_tag(r["tag_name"].as_str()?)?;
            Some(ChangelogRelease {
                version,
                published_at: r["published_at"].as_str().unwrap_or_default().to_string(),
                body: r["body"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect();
    (releases, has_more)
}

/// Fetch one raw page through the mirror ladder. Errors reach the webui
/// store verbatim — the section renders its retry state on them.
async fn fetch_raw_page(clients: &HttpPair, page: u32) -> anyhow::Result<serde_json::Value> {
    let url = format!("{RELEASES_URL}?per_page={RAW_PER_PAGE}&page={page}");
    let mut last_err = String::from("no mirror attempted for the changelog");
    for candidate in github_mirror::candidates(&url) {
        let host = upstream_health::host_of_url(&candidate).to_string();
        let resp =
            match upstream_health::send_with_fallback(clients, &host, "changelog", |client| {
                client
                    .get(&candidate)
                    .header("User-Agent", "WoWSP-changelog/1.0")
                    .header("Accept", "application/vnd.github+json")
                    .timeout(FETCH_TIMEOUT)
            })
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
            Ok(v) if v.is_array() => return Ok(v),
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
    Err(Error::msg(last_err))
}

/// Stream one visible batch: raw pages walk the mirror ladder until the
/// batch is full or GitHub says the list ended. `page` is the raw cursor
/// the previous call returned (the section's first load passes 1); a
/// dead/black-holing configured proxy must not stall the section behind
/// per-mirror timeouts — the transport failure hands the host to the
/// direct twin at once (see upstream_health::send_with_fallback).
#[tauri::command]
pub async fn changelog_list(page: u32) -> CommandResult<ChangelogPage> {
    let clients = HttpPair::build(|b| b)?;
    let mut releases: Vec<ChangelogRelease> = Vec::new();
    let mut has_more = false;
    // Invariant: after every fetch, `next_raw` is one PAST the last page
    // consumed — every exit path below then reports the exact resume
    // cursor, no skipped pages.
    let mut next_raw = page.max(1);
    for _ in 0..RAW_PAGE_BUDGET {
        // The ladder's accumulated failure text is a plain String under
        // the hood — the msg bridge renders it byte-identically through
        // CommandError.
        let payload = fetch_raw_page(&clients, next_raw).await?;
        next_raw += 1;
        let (batch, more) = parse_page(&payload, RELEASES_PER_PAGE);
        releases.extend(batch);
        has_more = more;
        if !has_more || releases.len() >= RELEASES_PER_PAGE {
            break;
        }
    }
    Ok(ChangelogPage {
        has_more,
        next_page: if has_more { next_raw } else { 0 },
        releases,
    })
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

    fn release(tag: &str) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "published_at": "2026-09-24T04:09:10Z",
            "body": "## What's Changed"
        })
    }

    #[test]
    fn parse_page_full_window_implies_a_next_page() {
        // A window of 2 that came back full: both entries enter the
        // distillation (the infra release eats one slot — intended) and
        // the fullness itself answers "maybe more" — the cursor keeps
        // moving, no entry is ever left behind.
        let payload = serde_json::json!([release("v0.4.6"), release("res-latest")]);
        let (releases, has_more) = parse_page(&payload, 2);
        assert!(has_more);
        assert_eq!(
            releases,
            vec![ChangelogRelease {
                version: "0.4.6".into(),
                published_at: "2026-09-24T04:09:10Z".into(),
                body: "## What's Changed".into(),
            }],
        );
    }

    #[test]
    fn parse_page_short_window_ends_the_list() {
        // Fewer entries than requested: the list ends here — no
        // continuation, and every entry still lands.
        let payload = serde_json::json!([release("v0.4.6"), release("v0.4.5")]);
        let (releases, has_more) = parse_page(&payload, 3);
        assert!(!has_more);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].version, "0.4.6");
        assert_eq!(releases[1].version, "0.4.5");
    }

    #[test]
    fn parse_page_keeps_order_and_drops_infra_and_drafts() {
        let payload = serde_json::json!([
            release("v0.4.6"),
            {
                "tag_name": "res-latest",
                "name": "Model Pack (latest)",
                "published_at": "2026-09-24T00:00:00Z",
                "body": "Baked ship & map GLB models."
            },
            {"tag_name": "v0.4.6-rc1", "draft": true, "body": "invisible"},
            {
                "tag_name": "v0.4.5",
                "published_at": "2026-09-22T05:43:17Z",
                "body": ""
            },
        ]);
        let (releases, _has_more) = parse_page(&payload, 10);
        assert_eq!(
            releases,
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
    fn parse_page_skips_tagless_and_tolerates_non_arrays() {
        let payload = serde_json::json!([{"name": "tagless"}]);
        assert_eq!(parse_page(&payload, 10), (vec![], false));
        assert_eq!(
            parse_page(&serde_json::json!({"message": "nope"}), 10),
            (vec![], false)
        );
        assert_eq!(parse_page(&serde_json::Value::Null, 10), (vec![], false));
        // An exhausted tail page: empty and terminal.
        assert_eq!(parse_page(&serde_json::json!([]), 10), (vec![], false));
    }
}
