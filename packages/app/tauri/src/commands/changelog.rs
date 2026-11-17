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
//!
//! The translation path is deliberately REST-free. Every app release also
//! carries a `release-notes-i18n-<tag>.json` asset (AGENTS.md section 10),
//! and release assets live on the release's own download mount, so its URL
//! is deterministic from the tag alone:
//! `https://github.com/<repo>/releases/download/<tag>/release-notes-i18n-<tag>.json`.
//! Resolving it through `releases/tags/<tag>` would spend one
//! unauthenticated REST call per listed release against a 60/hour/IP
//! budget: ten releases into a section open the budget is gone, GitHub
//! answers 403, and every translation reads as absent (the field bug this
//! module now avoids). That budget belongs to the release LIST alone: the
//! asset URL needs no lookup, and the list payload's own `assets` array
//! already says which releases ship it ([ChangelogRelease::notes_i18n]).
//!
//! The asset itself downloads through the unified download hub
//! (`commands/download_hub.rs`) under the SILENT `changelog-notes` kind
//! instead of a second fetch loop of its own: one engine owns the mirror
//! ladder, the stall bounds and the proxy→direct fallback for every
//! artifact. The hub's part file doubles as the on-disk cache
//! (`%LOCALAPPDATA%/WoWSP/changelog-notes/<tag>.json`, seven days), so
//! repeat views of a release need no network at all and the queue cost
//! stays on the first view. Silence is deliberate — the changelog card
//! keeps carrying its own translating/retry state, so a hub card or toast
//! would report the same fetch twice (docs/en/designs/resources.md).

use anyhow::Error;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use wowsp_tauri_shared::CommandResult;
use wowsp_tauri_shared::download::kind;

use crate::commands::download_hub::{self, DownloadRequest};
use crate::commands::github_mirror;
use crate::commands::network::HttpPair;
use crate::commands::upstream_health;
use crate::paths;

/// This repository, in the `<owner>/<repo>` form every GitHub URL in this
/// module is built from — the ONE place the slug is spelled out.
const REPO_SLUG: &str = "langyo/wowsp";

/// Release-list API of this repo, without query — `fetch_raw_page` appends
/// the paging pair. Built from [`REPO_SLUG`]; a `static` rather than a
/// `const` because stable Rust cannot concatenate a `const` value into a
/// `const` string (`concat!` accepts literals only) — the slug still lives
/// in exactly one place above.
static RELEASES_URL: LazyLock<String> =
    LazyLock::new(|| format!("https://api.github.com/repos/{REPO_SLUG}/releases"));

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

/// How long one downloaded notes asset stays valid on disk. The asset is
/// immutable per tag once published; the EXPECTED later change is the
/// placeholder → translation fill, which re-downloads because a placeholder
/// doc is never cached. (An edit to an already-filled translation stays
/// invisible for up to this window — accepted, against the tiny size of the
/// asset.) A week keeps opening the changelog free.
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Cache subdirectory of the notes assets, one `<tag>.json` per release.
/// It is also the hub's part-file directory: a cache hit and a completed
/// transfer are literally the same file.
const CACHE_DIR: &str = "changelog-notes";

/// Byte bounds of one notes asset. A real doc is a few kilobytes of JSON
/// (seven locale sections); the floor rejects a mirror's 200-with-an-error-
/// page, the ceiling keeps a hostile body from filling the disk.
const I18N_MIN_BYTES: u64 = 256;
const I18N_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Whole-request cap for one asset transfer. The hub's stall bound already
/// fails a silent mirror over to the next candidate within seconds, so this
/// only bounds a merely slow (not dead) ladder.
const I18N_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// One rendered release. `version` is the tag with its `v` stripped so
/// the webui can badge the running build straight against `getVersion()`.
#[derive(Debug, PartialEq, Serialize)]
pub struct ChangelogRelease {
    pub version: String,
    pub published_at: String,
    pub body: String,
    /// Whether the release's own `assets` array carries the translation
    /// asset `i18n_asset_name` builds for its tag. The list API already
    /// returns every release's assets, so knowing this costs no request —
    /// and the webui can render a release that never shipped one as missing
    /// straight from the list instead of calling [`changelog_i18n`] and
    /// reading its failure as "no translation". `false` when the payload
    /// has no assets field or a non-array one (an older API shape).
    pub notes_i18n: bool,
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

fn i18n_asset_name(tag: &str) -> String {
    format!("{I18N_ASSET_PREFIX}{tag}{I18N_ASSET_SUFFIX}")
}

/// The notes asset's download URL, derived from the tag alone. Release
/// assets are mounted on the release's own download route, so no
/// release-detail lookup is needed — and none is wanted: one REST call per
/// listed release would exhaust the 60/hour unauthenticated budget that the
/// release LIST needs.
fn i18n_asset_url(tag: &str) -> String {
    format!(
        "https://github.com/{REPO_SLUG}/releases/download/{tag}/{}",
        i18n_asset_name(tag)
    )
}

/// Normalize the webui's tag argument: it must be a v-prefixed,
/// digit-leading app release tag made of URL-safe characters. The changelog
/// list keeps prerelease tags too, so this accepts the same shapes while
/// rejecting anything that could alter the download URL (or the cache file
/// name) it is interpolated into. The prefix is canonicalized to lowercase
/// `v`: the release download path is case-sensitive, so an uppercase
/// `V0.6.9` would otherwise 404 and read as a fetch failure (and would
/// split the cache under a second file).
fn app_tag(raw: &str) -> Option<String> {
    let tag = raw.trim();
    let bare = tag.strip_prefix(['v', 'V'])?;
    if !bare.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let safe = bare
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    safe.then(|| format!("v{bare}"))
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
/// all-placeholder doc is never cached: set --apply rewrites assets in
/// place, and a cached placeholder would otherwise survive until the cache
/// expired (or, before the disk cache, until an app restart).
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

/// The on-disk cache file of one tag's notes asset — also the hub's part
/// file, so a completed transfer lands exactly where the next view looks.
/// The tag is already canonical and URL-safe (see [`app_tag`]), so it can
/// name the file directly; one flat directory keeps the 7-day cache
/// trivially inspectable.
fn cache_path(tag: &str) -> anyhow::Result<PathBuf> {
    Ok(paths::ensure_cache_dir()?
        .join(CACHE_DIR)
        .join(format!("{tag}.json")))
}

/// Whether a cache file's modification time is still inside [`CACHE_TTL`].
/// Pure so the boundary is testable without touching disk: a future mtime
/// (clock skew, a file restored from a backup) counts as fresh — it cannot
/// be stale, and rejecting it would only force a pointless re-download.
fn cache_is_fresh(modified: SystemTime, now: SystemTime) -> bool {
    match now.duration_since(modified) {
        Ok(age) => age < CACHE_TTL,
        Err(_) => true,
    }
}

/// Serve one tag's notes asset from disk, or `None` when the fetch must
/// happen. The file must be a plausible asset we wrote (a regular file
/// inside the byte cap), carry real translations AND be younger than
/// [`CACHE_TTL`]. Placeholder docs are excluded on purpose: they are
/// expected to change, and pinning one for a week would hide the fill
/// (`set --apply` rewrites the asset in place) — the exact rule the old
/// in-memory session cache had. A stale file is simply left in place: the
/// hub's `resume: false` truncates the part before writing it.
fn cached_doc(path: &Path, tag: &str) -> Option<ChangelogI18n> {
    // A few kilobytes at most — a plain synchronous read is cheaper than
    // the spawn_blocking hop `tokio::fs` would add.
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > I18N_MAX_BYTES {
        return None;
    }
    if !cache_is_fresh(meta.modified().ok()?, SystemTime::now()) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let doc = parse_i18n_doc(&bytes, tag)?;
    has_translation(&doc).then_some(doc)
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
///
/// Each release also reports whether its `assets` array carries the
/// translation asset: the list API already delivers that array, so the
/// webui learns "this release has no notes translation" with zero extra
/// requests. The expected NAME is built from the CANONICAL tag (`v` plus
/// the stripped version — exactly what [`changelog_i18n`] will fetch), and
/// a tag not spelled that way reads false: the command could never reach
/// such an asset, so pointing the webui at it would only loop on errors.
fn parse_page(payload: &serde_json::Value, per_page: usize) -> (Vec<ChangelogRelease>, bool) {
    let raw = payload.as_array();
    let has_more = raw.is_some_and(|a| a.len() >= per_page);
    let releases = raw
        .into_iter()
        .flatten()
        .take(per_page)
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            let version = version_from_tag(tag)?;
            // Only a tag spelled exactly in the canonical lowercase-v form
            // has a reachable notes asset (the command's URL and cache name
            // are built from that form), so any other spelling reads false
            // even when an identically-named asset sits on the release.
            let canonical = format!("v{version}");
            let asset_name = i18n_asset_name(&canonical);
            let notes_i18n = tag == canonical
                && r["assets"].as_array().is_some_and(|assets| {
                    assets
                        .iter()
                        .any(|asset| asset["name"].as_str() == Some(asset_name.as_str()))
                });
            Some(ChangelogRelease {
                version,
                published_at: r["published_at"].as_str().unwrap_or_default().to_string(),
                body: r["body"].as_str().unwrap_or_default().to_string(),
                notes_i18n,
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
    let url = format!(
        "{}?per_page={RAW_PER_PAGE}&page={page}",
        RELEASES_URL.as_str()
    );
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

/// One release's translation asset, downloaded through the unified hub.
///
/// There is no "this release has no translation" outcome here any more: the
/// changelog LIST already told the webui whether the release ships the asset
/// ([ChangelogRelease::notes_i18n], read from the list payload's `assets`
/// array), so the webui only calls this for a release that has one. Every
/// failure — no mirror serving the asset, HTTP 403/5xx, an HTML/error body,
/// a schema/tag mismatch — is therefore a RETRYABLE error, and the contract
/// is a plain `Result<ChangelogI18n>` instead of the old
/// `Result<Option<ChangelogI18n>>` (whose `None` meant "genuinely absent"
/// and could not be told apart from a mirror 404 in the field).
///
/// The transfer is the hub's SILENT `changelog-notes` kind: it rides the
/// same FIFO, mirror ladder, stall bounds and proxy→direct fallback every
/// other artifact does (one engine), while the changelog card keeps
/// rendering its own translating/retry state — no download card, no toast.
/// The hub's part file is the cache: a doc that parses, carries real
/// translations and is younger than the seven-day `CACHE_TTL` is served
/// from disk with no network access at all, so the queue cost stays on the
/// first view of a release.
#[tauri::command]
pub async fn changelog_i18n(app: tauri::AppHandle, tag: String) -> CommandResult<ChangelogI18n> {
    let tag = app_tag(&tag).ok_or_else(|| Error::msg(format!("not an app release tag: {tag}")))?;
    let part = cache_path(&tag)?;
    if let Some(doc) = cached_doc(&part, &tag) {
        return Ok(doc);
    }
    let mut request = DownloadRequest::new(
        &tag,
        kind::CHANGELOG_NOTES,
        github_mirror::candidates(&i18n_asset_url(&tag)),
        part.clone(),
    );
    request.min_bytes = I18N_MIN_BYTES;
    request.max_bytes = Some(I18N_MAX_BYTES);
    request.timeout = Some(I18N_DOWNLOAD_TIMEOUT);
    // No resume and no mirror race: the asset is immutable per tag and only
    // a few kilobytes, so a partial pass is worth less than a clean one and
    // probing every mirror would cost more requests than it saves.
    request.resume = false;
    request.race_window = None;
    let done = download_hub::transfer(Some(&app), request)
        .await
        .map_err(|e| Error::msg(format!("release {tag} notes: {e}")))?;
    let bytes = tokio::fs::read(&done.path)
        .await
        .map_err(|e| Error::msg(format!("release {tag} notes: unreadable download: {e}")))?;
    let Some(doc) = parse_i18n_doc(&bytes, &tag) else {
        // A proxy can answer 200 with an HTML/error page. Do not leave that
        // behind as a "cache" the next view would only parse and drop.
        let _ = tokio::fs::remove_file(&done.path).await;
        return Err(Error::msg(format!(
            "release {tag} notes: unusable translation asset (schema/tag mismatch)"
        ))
        .into());
    };
    if !has_translation(&doc) {
        // Keep the file only when it is worth caching: an all-placeholder doc
        // is expected to change once translations are filled (`set --apply`
        // rewrites the asset in place), so it is returned but NOT kept — the
        // next view re-fetches and sees the fill without an app restart.
        let _ = tokio::fs::remove_file(&done.path).await;
    }
    Ok(doc)
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

    /// One raw release entry with an explicit `assets` array (the list
    /// API's shape) — the notes_i18n assertions' fixture.
    fn release_with_assets(tag: &str, assets: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "published_at": "2026-09-24T04:09:10Z",
            "body": "",
            "assets": assets
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
                notes_i18n: false,
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
                    notes_i18n: false,
                },
                ChangelogRelease {
                    version: "0.4.5".into(),
                    published_at: "2026-09-22T05:43:17Z".into(),
                    body: String::new(),
                    notes_i18n: false,
                },
            ]
        );
    }

    #[test]
    fn parse_page_reads_the_notes_asset_from_the_assets_array() {
        let payload = serde_json::json!([
            // The asset name sits in the release's own assets: the webui may
            // call changelog_i18n for this one.
            release_with_assets(
                "v0.6.9",
                serde_json::json!([
                    {"name": "wowsp_0.6.9_x64-setup.exe"},
                    {"name": "release-notes-i18n-v0.6.9.json"}
                ])
            ),
            // Present but empty: this release ships no translation asset.
            release_with_assets("v0.6.8", serde_json::json!([])),
            // No assets field at all (an older payload shape).
            release("v0.6.7"),
            // A non-array assets value: false, never a panic.
            release_with_assets("v0.6.6", serde_json::json!({"name": "x"})),
            // Another release's asset name does not count: only the
            // canonical tag builds the expected name.
            release_with_assets(
                "v0.6.5",
                serde_json::json!([{"name": "release-notes-i18n-v0.6.4.json"}])
            ),
            // A tag NOT spelled in the canonical lowercase-v form: the
            // command's deterministic URL could never reach it, so the flag
            // stays false even when an asset with the canonical name hangs
            // on the release.
            release_with_assets(
                "V0.6.9",
                serde_json::json!([{"name": "release-notes-i18n-v0.6.9.json"}])
            ),
            release_with_assets(
                "0.6.9",
                serde_json::json!([{"name": "release-notes-i18n-v0.6.9.json"}])
            ),
        ]);
        let (releases, _has_more) = parse_page(&payload, 10);
        let flags: Vec<(&str, bool)> = releases
            .iter()
            .map(|r| (r.version.as_str(), r.notes_i18n))
            .collect();
        assert_eq!(
            flags,
            vec![
                ("0.6.9", true),
                ("0.6.8", false),
                ("0.6.7", false),
                ("0.6.6", false),
                ("0.6.5", false),
                // The non-canonical spellings of 0.6.9, both honestly false.
                ("0.6.9", false),
                ("0.6.9", false),
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
        // The accepted tag is canonicalized to the lowercase-v form: the
        // release download path is case-sensitive, so an uppercase V must
        // never reach it (and would split the cache under a second file).
        assert_eq!(app_tag("V0.6.9").as_deref(), Some("v0.6.9"));
        assert_eq!(app_tag("  V0.6.9 ").as_deref(), Some("v0.6.9"));
        // Bare/infra tags and path-mutating shapes are refused.
        assert_eq!(app_tag("0.6.9"), None);
        assert_eq!(app_tag("res-latest"), None);
        assert_eq!(app_tag("v0.6.9?x"), None);
        assert_eq!(app_tag("v0.6.9/../x"), None);
        assert_eq!(app_tag("v"), None);
    }

    #[test]
    fn i18n_asset_url_is_deterministic_from_the_tag() {
        assert_eq!(
            i18n_asset_url("v0.6.9"),
            "https://github.com/langyo/wowsp/releases/download/v0.6.9/release-notes-i18n-v0.6.9.json"
        );
        // Prerelease tags resolve the same way: the asset name and the tag's
        // download directory always agree — no release-detail lookup can
        // disagree with the tag the command was called with.
        assert_eq!(
            i18n_asset_url("v0.6.9-rc1"),
            "https://github.com/langyo/wowsp/releases/download/v0.6.9-rc1/release-notes-i18n-v0.6.9-rc1.json"
        );
    }

    #[test]
    fn cache_expires_at_exactly_the_seven_day_ttl() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        // Just written, minutes old, and one second inside the window.
        assert!(cache_is_fresh(now, now));
        assert!(cache_is_fresh(now - Duration::from_secs(60), now));
        assert!(cache_is_fresh(
            now - (CACHE_TTL - Duration::from_secs(1)),
            now
        ));
        // The boundary itself is stale: at exactly CACHE_TTL the file must be
        // re-fetched (the comparison is `<`, not `<=`).
        assert!(!cache_is_fresh(now - CACHE_TTL, now));
        assert!(!cache_is_fresh(
            now - Duration::from_secs(30 * 24 * 60 * 60),
            now
        ));
        // A future mtime (clock skew, a restored file) counts as fresh: it
        // cannot be stale, and refusing it would only force a re-download.
        assert!(cache_is_fresh(now + Duration::from_secs(3600), now));
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
