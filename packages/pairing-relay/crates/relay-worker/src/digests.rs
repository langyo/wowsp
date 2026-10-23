//! GET /api/digests/<channel>[/<tag>] — the release-digest endpoint
//! (see relay_core::digests for the policy). SERVED lookups never reach
//! this handler anymore: every doc-carrying channel is negated out of
//! run_worker_first (wrangler.toml — per channel, never a blanket
//! negation), and the build-generated `_redirects` (exact-path rules
//! from the tracked digests tree, see scripts/build_worker_site.py)
//! maps the extensionless client paths onto the .json docs — pure
//! static asset traffic, zero worker invocations.
//!
//! This handler serves the channels WITHOUT docs, which stay
//! worker-first: the published-channel gate answers the gated,
//! edge-cached 404 — the app's absent-channel signal. That is also why
//! the negation must stay scoped: with the SPA not_found_handling an
//! UNNEGATED asset miss serves the shell HTML (200 text/html) and
//! never reaches this code, so a blanket !/api/digests* would replace
//! the 404 with a 229KB HTML 200 (the 2026-10-23 follow-up fix);
//! scripts/build_worker_site.py fails the build when a channel has
//! docs but no negation entries.
//!
//! The 2026-10-22 incident retired the KV-backed store: a fleet of app
//! clients polling never-published channels turned every request into
//! a guaranteed KV miss and burned the free tier's daily read quota.
//! The static path spends nothing at all; this fallback costs, per edge
//! colo and cache TTL, one asset fetch (free, unmetered) — and
//! identical GETs (any query string) collapse into the cached response
//! before the read budget is even consulted.

use relay_core::digests::{self, DigestDoc};
use worker::*;

/// The [assets] binding (wrangler.toml `binding = "ASSETS"` under
/// `[assets]`) the docs are fetched through. A fetch on it resolves by
/// path against the uploaded assets; a miss is a 404 here (the SPA
/// fallback never applies — and is defensively refused below).
const ASSETS: &str = "ASSETS";

/// Serve one digest request. `channel`/`tag` are the raw path segments
/// from the router.
pub async fn handle(req: Request, env: Env, channel: &str, tag: Option<&str>) -> Result<Response> {
    if req.method() != Method::Get {
        return Response::error("method not allowed", 405);
    }
    if !digests::valid_channel(channel) {
        return Response::error("unknown digest channel", 400);
    }
    if tag.is_some_and(|t| !digests::valid_tag(t)) {
        return Response::error("bad digest tag", 400);
    }
    let path = match tag {
        Some(tag) => digests::doc_url(channel, tag),
        None => digests::latest_url(channel),
    };
    // The edge cache key is the clean client path on a synthetic host:
    // query strings are client noise (the incident's cache-busting
    // shape), and the key must be stable across colos' spellings.
    let cache = Cache::default();
    let cache_key = format!("https://digests.edge{path}");
    if let Ok(Some(cached)) = cache.get(cache_key.clone(), true).await {
        return Ok(cached);
    }
    // Only channels with docs actually published into the tracked
    // digests tree may spend the read budget and the asset fetch;
    // every other valid channel answers 404 from the binary (see
    // relay_core::digests::parse_published_channels).
    let published = env
        .var("DIGEST_PUBLISHED_CHANNELS")
        .ok()
        .map(|v| v.to_string());
    if !digests::parse_published_channels(published.as_deref())
        .iter()
        .any(|c| c == channel)
    {
        return cached_404(&cache, &cache_key, 600).await;
    }
    // Audit M-10: the updater polls this route — a scripted flood with
    // random query strings must not drain the shared budget (now spent
    // on cache misses only, which an edge-cached flood never reaches).
    if !crate::replay::spend_public_read(&env, "digests", &crate::feedback::client_ip(&req)).await?
    {
        return crate::replay::err_retry(429, "rate_limited", 600);
    }
    let fetcher = match env.assets(ASSETS) {
        Ok(fetcher) => fetcher,
        Err(_) => return Response::error("digest store not configured on this gateway", 503),
    };
    // The client path is route-only (it IS the channel directory on the
    // assets layer); the real files carry their `.json` names.
    let asset_path = match tag {
        Some(tag) => digests::doc_asset_path(channel, tag),
        None => digests::latest_asset_path(channel),
    };
    let mut asset = fetcher
        .fetch(format!("https://wowsp.langyo.xyz{asset_path}"), None)
        .await?;
    let content_type = asset
        .headers()
        .get("content-type")
        .unwrap_or_default();
    // A miss answers 404 — and the SPA fallback, should the assets
    // layer ever apply it to binding fetches, arrives as HTML: refuse
    // that shape loudly instead of serving a shell to an API client.
    if asset.status_code() != 200
        || content_type.as_deref().is_some_and(|v| v.contains("text/html"))
    {
        return cached_404(&cache, &cache_key, 600).await;
    }
    let doc: DigestDoc = match serde_json::from_slice(&asset.bytes().await?).ok() {
        Some(doc) => doc,
        None => return Response::error("stored digest document failed validation", 500),
    };
    if !digests::doc_is_sane(&doc, channel) {
        // Corruption or tampering in the store itself: refuse loudly
        // rather than serve an unverifiable doc.
        return Response::error("stored digest document failed validation", 500);
    }
    let mut resp = Response::from_json(&doc)?;
    // Publishes are rare; a five-minute client-side cap keeps the
    // endpoint off the hot path without serving stale-on-refresh.
    resp.headers_mut()
        .set("cache-control", "public, max-age=300")?;
    // Best-effort edge fill: a failed put only costs the next request
    // a fresh asset fetch.
    let _ = cache.put(cache_key, resp.cloned()?).await;
    Ok(resp)
}

/// The terminal miss (unknown/unpublished channel or tag): the same
/// body a missing doc always had, cached at the edge for ten minutes
/// so a flood of misses costs nothing beyond the request itself.
async fn cached_404(cache: &Cache, cache_key: &str, max_age: u64) -> Result<Response> {
    let mut resp = Response::error("no digest published for this channel", 404)?;
    resp.headers_mut()
        .set("Cache-Control", &format!("public, max-age={max_age}"))?;
    let _ = cache.put(cache_key.to_string(), resp.cloned()?).await;
    Ok(resp)
}
