//! GET /api/digests/<channel>[/<tag>] — the release-digest endpoint
//! (see relay_core::digests for the policy). The doc is read from the
//! dedicated `DIGESTS` KV namespace; this handler owns nothing but the
//! validation → KV read mapping, so every rule stays unit-testable in
//! relay-core.
//!
//! Until the namespace is created and the binding uncommented in
//! wrangler.toml (README ▶ Deploy), the route answers 503 — the app
//! treats that exactly like any other relay-channel failure and falls
//! back to api.github.com.

use relay_core::digests::{self, DigestDoc};
use worker::*;

/// The KV binding this route reads (wrangler.toml `[[kv_namespaces]]`).
const KV: &str = "DIGESTS";

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
    let kv = match env.kv(KV) {
        Ok(kv) => kv,
        Err(_) => {
            return Response::error("digest store not configured on this gateway", 503)
        },
    };
    let key = match tag {
        Some(tag) => digests::kv_key(channel, tag),
        None => digests::kv_latest_key(channel),
    };
    let doc: Option<DigestDoc> = kv.get(&key).json().await?;
    let Some(doc) = doc else {
        return Response::error("no digest published for this channel", 404);
    };
    if !digests::doc_is_sane(&doc, channel) {
        // Corruption or tampering in the store itself: refuse loudly
        // rather than serve an unverifiable doc.
        return Response::error("stored digest document failed validation", 500);
    }
    let mut resp = Response::from_json(&doc)?;
    // Publishes are rare; a five-minute client-side cap keeps the
    // endpoint off the hot path without serving stale-on-refresh.
    resp.headers_mut().set("cache-control", "public, max-age=300")?;
    Ok(resp)
}
