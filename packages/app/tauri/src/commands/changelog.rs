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
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};
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

/// The per-release translation asset attached to every app release:
/// release-notes-i18n-<tag>.json (schema 1: tag + generated_at + sections).
/// The release BODY stays English; this asset carries the seven locales
/// (AGENTS.md section 10).
const I18N_ASSET_PREFIX: &str = "release-notes-i18n-";
const I18N_ASSET_SUFFIX: &str = ".json";
const I18N_SCHEMA: u64 = 1;
const I18N_FETCH_TIMEOUT: Duration = Duration::from_secs(25);

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

#[derive(Debug, Deserialize)]
struct RawI18nDoc {
    schema: u64,
    tag: String,
    sections: BTreeMap<String, String>,
}

/// One release's translation sections as served to the webui. `tag` is
/// the v-prefixed release tag; `sections` maps a locale to its markdown.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangelogI18n {
    pub tag: String,
    pub sections: BTreeMap<String, String>,
}

/// Session cache: release-notes assets are immutable per tag, so one
/// successful fetch is enough for the whole app run.
static I18N_CACHE: LazyLock<Mutex<BTreeMap<String, ChangelogI18n>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn i18n_asset_name(tag: &str) -> String {
    format!("{I18N_ASSET_PREFIX}{tag}{I18N_ASSET_SUFFIX}")
}

/// Normalize the webui's tag argument: it must be a v-prefixed,
/// digit-leading app release tag made of URL-safe characters. The changelog
/// list keeps prerelease tags too, so this accepts the same shapes while
/// rejecting anything that could alter the API path it is interpolated into.
fn app_tag(raw: &str) -> Option<String> {
    let tag = raw.trim();
    let bare = tag.strip_prefix(['v', 'V'])?;
    if !bare.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let safe = bare
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    safe.then(|| tag.to_string())
}

/// Pull the release-notes asset download URL out of one release-detail
/// payload. Releases without the asset (older releases) answer None.
fn i18n_asset_url_from_release(payload: &serde_json::Value, tag: &str) -> Option<String> {
    // Shape-check the detail payload first: a mirror can answer 200 with a
    // JSON error object, which must not read as "this release has no asset".
    if payload.get("tag_name").and_then(|name| name.as_str()) != Some(tag) {
        return None;
    }
    let want = i18n_asset_name(tag);
    let url = payload
        .get("assets")?
        .as_array()?
        .iter()
        .find(|asset| asset.get("name").and_then(|name| name.as_str()) == Some(want.as_str()))
        .and_then(|asset| asset.get("browser_download_url"))
        .and_then(|url| url.as_str())?;
    // Release asset URLs live on github.com; a payload pointing anywhere
    // else is not a payload this command should feed into the ladder.
    url.starts_with("https://github.com/")
        .then(|| url.to_string())
}

fn parse_i18n_doc(bytes: &[u8], tag: &str) -> Option<ChangelogI18n> {
    let doc: RawI18nDoc = serde_json::from_slice(bytes).ok()?;
    if doc.schema != I18N_SCHEMA || doc.tag != tag || doc.sections.is_empty() {
        return None;
    }
    Some(ChangelogI18n {
        tag: doc.tag,
        sections: doc.sections,
    })
}

/// Whether the doc carries at least one non-placeholder section. An
/// all-placeholder doc is not cached: set --apply rewrites assets in place,
/// and a cached placeholder would otherwise survive until an app restart.
fn has_translation(doc: &ChangelogI18n) -> bool {
    doc.sections.values().any(|content| {
        let first = content
            .split('\n')
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim_start();
        !first.starts_with('🚧')
    })
}

/// Resolve the release-notes asset URL by walking the mirror ladder to the
/// release-detail endpoint and shape-checking each candidate's payload, so a
/// proxy's 200-with-a-JSON-error body moves the ladder on instead of
/// reading as "this release has no asset".
async fn fetch_release_asset_url(clients: &HttpPair, tag: &str) -> anyhow::Result<Option<String>> {
    let detail_url = format!("{RELEASES_URL}/tags/{tag}");
    let mut last_err = String::from("no mirror attempted");
    for candidate in github_mirror::candidates(&detail_url) {
        let host = upstream_health::host_of_url(&candidate).to_string();
        let resp =
            match upstream_health::send_with_fallback(clients, &host, "changelog-i18n", |client| {
                client
                    .get(&candidate)
                    .header("User-Agent", "WoWSP-changelog/1.0")
                    .header("Accept", "application/vnd.github+json")
                    .timeout(I18N_FETCH_TIMEOUT)
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
        match resp.json::<serde_json::Value>().await {
            Ok(payload) => {
                let shaped = payload.get("tag_name").and_then(|name| name.as_str()) == Some(tag)
                    && payload
                        .get("assets")
                        .is_some_and(|assets| assets.is_array());
                if !shaped {
                    last_err = format!("{candidate}: unexpected release detail payload");
                    continue;
                }
                return Ok(i18n_asset_url_from_release(&payload, tag));
            },
            Err(e) => {
                last_err = format!("{candidate}: invalid JSON: {e}");
                continue;
            },
        }
    }
    Err(Error::msg(last_err))
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

/// Walk the mirror ladder for one GitHub URL and decode its JSON body.
/// Every candidate failure is accumulated; the last one is the error the
/// caller sees (the ladder never stops on a single dead mirror).
async fn fetch_ladder_json(
    clients: &HttpPair,
    url: &str,
    label: &str,
    accept: &str,
) -> anyhow::Result<serde_json::Value> {
    let mut last_err = String::from("no mirror attempted");
    for candidate in github_mirror::candidates(url) {
        let host = upstream_health::host_of_url(&candidate).to_string();
        let resp = match upstream_health::send_with_fallback(clients, &host, label, |client| {
            client
                .get(&candidate)
                .header("User-Agent", "WoWSP-changelog/1.0")
                .header("Accept", accept)
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
        match resp.json::<serde_json::Value>().await {
            Ok(payload) => return Ok(payload),
            Err(e) => {
                last_err = format!("{candidate}: invalid JSON: {e}");
                continue;
            },
        }
    }
    Err(Error::msg(last_err))
}

/// Fetch one raw page through the mirror ladder. Only a JSON array is a
/// usable release list (a proxy can answer 200 with a JSON error object);
/// anything else moves the ladder on instead of rendering an empty feed.
async fn fetch_raw_page(clients: &HttpPair, page: u32) -> anyhow::Result<serde_json::Value> {
    let url = format!("{RELEASES_URL}?per_page={RAW_PER_PAGE}&page={page}");
    let payload =
        fetch_ladder_json(clients, &url, "changelog", "application/vnd.github+json").await?;
    if payload.is_array() {
        Ok(payload)
    } else {
        Err(Error::msg(
            "unexpected changelog payload: not a release list",
        ))
    }
}

/// Walk the mirror ladder until one candidate serves a VALID i18n doc for
/// `tag`. A proxy can answer 200 with an HTML/error body, so the doc is
/// parsed per candidate and the ladder moves on instead of accepting the
/// first 200 it sees.
async fn fetch_i18n_doc(clients: &HttpPair, url: &str, tag: &str) -> anyhow::Result<ChangelogI18n> {
    let mut last_err = String::from("no mirror attempted");
    for candidate in github_mirror::candidates(url) {
        let host = upstream_health::host_of_url(&candidate).to_string();
        let resp =
            match upstream_health::send_with_fallback(clients, &host, "changelog-i18n", |client| {
                client
                    .get(&candidate)
                    .header("User-Agent", "WoWSP-changelog/1.0")
                    .timeout(I18N_FETCH_TIMEOUT)
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
        match resp.bytes().await {
            Ok(bytes) => match parse_i18n_doc(&bytes, tag) {
                Some(doc) => return Ok(doc),
                None => {
                    last_err = format!("{candidate}: unusable i18n doc (schema/tag mismatch)");
                    continue;
                },
            },
            Err(e) => {
                last_err = format!("{candidate}: body read failed: {e}");
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

/// One release's translation asset: None when the release has no i18n
/// asset (older releases). Transport failures and unusable payloads/doc
/// surface as errors; the webui changelog store swallows both and keeps
/// rendering the English body.
#[tauri::command]
pub async fn changelog_i18n(tag: String) -> CommandResult<Option<ChangelogI18n>> {
    let tag = app_tag(&tag).ok_or_else(|| Error::msg(format!("not an app release tag: {tag}")))?;
    if let Ok(cache) = I18N_CACHE.lock() {
        if let Some(hit) = cache.get(&tag) {
            return Ok(Some(hit.clone()));
        }
    }
    let clients = HttpPair::build(|b| b)?;
    let Some(asset_url) = fetch_release_asset_url(&clients, &tag).await? else {
        return Ok(None);
    };
    let doc = fetch_i18n_doc(&clients, &asset_url, &tag).await?;
    // Only cache docs with real content: an all-placeholder doc is expected
    // to change once translations are filled (set --apply rewrites the
    // asset), and the webui refresh must see the update without a restart.
    if has_translation(&doc) {
        if let Ok(mut cache) = I18N_CACHE.lock() {
            cache.insert(tag, doc.clone());
        }
    }
    Ok(Some(doc))
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

    #[test]
    fn app_tag_accepts_safe_v_prefixed_app_tags() {
        assert_eq!(app_tag("v0.6.9").as_deref(), Some("v0.6.9"));
        assert_eq!(app_tag("  v0.6.9 ").as_deref(), Some("v0.6.9"));
        // The changelog list keeps prerelease tags too; they must resolve here.
        assert_eq!(app_tag("v0.6.9-rc1").as_deref(), Some("v0.6.9-rc1"));
        assert_eq!(app_tag("v0.6").as_deref(), Some("v0.6"));
        // Bare/infra tags and path-mutating shapes are refused.
        assert_eq!(app_tag("0.6.9"), None);
        assert_eq!(app_tag("res-latest"), None);
        assert_eq!(app_tag("v0.6.9?x"), None);
        assert_eq!(app_tag("v0.6.9/../x"), None);
        assert_eq!(app_tag("v"), None);
    }

    fn i18n_payload(tag: &str) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "assets": [
                {"name": "latest", "browser_download_url": "https://github.com/x/latest"},
                {"name": format!("release-notes-i18n-{tag}.json"),
                 "browser_download_url": "https://github.com/x/notes.json"},
            ],
        })
    }

    #[test]
    fn i18n_asset_url_selection() {
        assert_eq!(
            i18n_asset_url_from_release(&i18n_payload("v0.6.9"), "v0.6.9").as_deref(),
            Some("https://github.com/x/notes.json")
        );
        assert_eq!(
            i18n_asset_url_from_release(&i18n_payload("v0.6.9"), "v0.6.8"),
            None
        );
        assert_eq!(
            i18n_asset_url_from_release(&serde_json::json!({"assets": []}), "v0.6.9"),
            None
        );
        assert_eq!(
            i18n_asset_url_from_release(&serde_json::json!({"message": "nope"}), "v0.6.9"),
            None
        );
        let wrong_tag = serde_json::json!({
            "tag_name": "v0.6.8",
            "assets": [{"name": "release-notes-i18n-v0.6.9.json",
                        "browser_download_url": "https://github.com/x/notes.json"}],
        });
        assert_eq!(i18n_asset_url_from_release(&wrong_tag, "v0.6.9"), None);
        let foreign_host = serde_json::json!({
            "tag_name": "v0.6.9",
            "assets": [{"name": "release-notes-i18n-v0.6.9.json",
                        "browser_download_url": "https://evil.example/notes.json"}],
        });
        assert_eq!(i18n_asset_url_from_release(&foreign_host, "v0.6.9"), None);
    }

    #[test]
    fn placeholder_only_docs_are_not_cacheable() {
        let placeholders = ChangelogI18n {
            tag: "v0.6.9".into(),
            sections: BTreeMap::from([
                ("zh-CN".to_string(), "🚧 未翻译".to_string()),
                ("ja-JP".to_string(), "🚧 未翻訳".to_string()),
            ]),
        };
        assert!(!has_translation(&placeholders));
        let translated = ChangelogI18n {
            tag: "v0.6.9".into(),
            sections: BTreeMap::from([
                ("zh-CN".to_string(), "## 更新内容".to_string()),
                ("ja-JP".to_string(), "🚧 未翻訳".to_string()),
            ]),
        };
        assert!(has_translation(&translated));
    }

    #[test]
    fn i18n_doc_requires_matching_schema_and_tag() {
        let good = "{\"schema\":1,\"tag\":\"v0.6.9\",\"sections\":{\"zh-CN\":\"## 更新内容\"}}";
        let parsed = parse_i18n_doc(good.as_bytes(), "v0.6.9").expect("valid doc");
        assert_eq!(parsed.tag, "v0.6.9");
        assert_eq!(
            parsed.sections.get("zh-CN").map(String::as_str),
            Some("## 更新内容")
        );
        assert!(parse_i18n_doc(good.as_bytes(), "v0.6.8").is_none());
        let future = "{\"schema\":2,\"tag\":\"v0.6.9\",\"sections\":{\"zh-CN\":\"x\"}}";
        assert!(parse_i18n_doc(future.as_bytes(), "v0.6.9").is_none());
        let empty = "{\"schema\":1,\"tag\":\"v0.6.9\",\"sections\":{}}";
        assert!(parse_i18n_doc(empty.as_bytes(), "v0.6.9").is_none());
        assert!(parse_i18n_doc(b"not json", "v0.6.9").is_none());
        assert_eq!(i18n_asset_name("v0.6.9"), "release-notes-i18n-v0.6.9.json");
    }
}
