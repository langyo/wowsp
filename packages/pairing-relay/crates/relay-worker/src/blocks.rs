//! The content-addressed block store (design contract:
//! docs/en/designs/cache-mesh.md §4) — `GET /api/blocks/<cid>`,
//! `/api/blocks/<cid>/raw`, `/ipfs/<cid>` and the storage seam the
//! lookup handler fills through. Policy lives in
//! [`relay_core::lookup`]; this module owns the R2 plumbing.
//!
//! Storage layout: ONE R2 object per CID in the LOOKUP_R2 bucket —
//! key = the BARE CID (no `blocks/` prefix and no extension; §4.1's
//! one-file-per-CID shape is about the NATIVE server's on-disk tree,
//! where each CID is a file under `blocks/` whose content is the
//! envelope JSON — the R2 bucket is dedicated, so the prefix would be
//! redundant), body = the envelope JSON. R2 replaced the original KV
//! layout for quota economics (review finding 1b): block fills are
//! WRITE traffic, and the free KV namespace budget (1000 writes/day,
//! shared with the feedback pipeline) cannot absorb them — R2's free
//! tier (1M class-A ops/month) can. The edge Cache API still fronts
//! every hot read, so serves stay off storage entirely when warm.
//!
//! TTL semantics (§4.3, lazy — deliberately NO cron): a row lives
//! until its TTL + 24 h grace; an expired read is treated as a MISS
//! and the object is deleted best-effort right then, and any later
//! refill overwrites the key anyway. Rows are CID-verified at ingress
//! (peer rows fail closed in lookup.rs); serving re-checks the belt —
//! a stored `line` that does not hash to the requested CID is a 404,
//! never served. A row without a `line` anchor is served on
//! local-store trust.
//!
//! CORS-open (public data), `cache-control: public, max-age=60` — the
//! blocks family is the cold path; the lookup route fronts everything
//! hot with the edge Cache API.

use relay_core::lookup::{self, LookupEnvelope};
use worker::*;

use crate::feedback::err;

/// The block store's R2 binding (wrangler.toml, bucket
/// wowsp-lookup-blocks).
const BLOCKS_R2: &str = "LOOKUP_R2";
/// Default response content-type (§3.4).
const DEFAULT_CONTENT_TYPE: &str = "application/json";

/// Load one block row: R2 get → parse → grace check → CID re-check.
/// `None` = absent, corrupt, past its TTL+grace, or mismatched — all
/// are a miss to the callers (lookup treats it as a cold miss, the
/// blocks routes as 404).
pub(crate) async fn load_block(env: &Env, cid: &str) -> Option<LookupEnvelope> {
    let bucket = env.bucket(BLOCKS_R2).ok()?;
    let object = bucket.get(cid).execute().await.ok()??;
    let body = object.body()?.bytes().await.ok()?;
    let envelope = serde_json::from_slice::<LookupEnvelope>(&body).ok()?;
    // §4.3 lazy expiry: past TTL + grace the row is gone; the delete
    // is best-effort (a failed delete only costs a later overwrite).
    let now_secs = (Date::now().as_millis() / 1000) as u64;
    if envelope
        .fetched_at
        .saturating_add(envelope.ttl)
        .saturating_add(lookup::BLOCK_GRACE_SECS)
        <= now_secs
    {
        let _ = bucket.delete(cid).await;
        return None;
    }
    match &envelope.line {
        // The §4.2 belt: the stored line must hash to the CID the
        // caller asked for. (Ingress already refused unverifiable
        // PEER rows; this catches a misplaced/mis-keyed local row.)
        Some(line) if !lookup::cid_verify(cid, line) => None,
        _ => Some(envelope),
    }
}

/// Store one block row (overwrite-and-lazy-expire, §4.3). Failures
/// are swallowed — callers serve from memory regardless.
pub(crate) async fn store_block(env: &Env, cid: &str, envelope: &LookupEnvelope) {
    let Ok(bucket) = env.bucket(BLOCKS_R2) else {
        return;
    };
    let Ok(json) = serde_json::to_vec(envelope) else {
        return;
    };
    let _ = bucket.put(cid.to_string(), json).execute().await;
}

/// GET /api/blocks/<cid> — the envelope JSON itself (§4.2).
pub async fn handle_block_get(req: Request, env: Env, cid: &str) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Get => {},
        _ => return err(405, "method_not_allowed"),
    }
    let Some(envelope) = load_block(&env, cid).await else {
        return err(404, "unknown_block");
    };
    let mut resp = Response::from_json(&envelope)?;
    decorate(&mut resp)?;
    Ok(resp)
}

/// GET /api/blocks/<cid>/raw — the decoded body bytes with the stored
/// content-type (§4.2).
pub async fn handle_block_raw(req: Request, env: Env, cid: &str) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Get => {},
        _ => return err(405, "method_not_allowed"),
    }
    serve_body(&env, cid).await
}

/// GET /ipfs/<cid> — the IPFS-gateway alias of /raw (§4.2): every
/// wowsp server is literally an IPFS HTTP gateway for its blocks.
pub async fn handle_ipfs(req: Request, env: Env, cid: &str) -> Result<Response> {
    handle_block_raw(req, env, cid).await
}

/// Shared body-serving path of /raw and /ipfs.
async fn serve_body(env: &Env, cid: &str) -> Result<Response> {
    let Some(envelope) = load_block(env, cid).await else {
        return err(404, "unknown_block");
    };
    let Some(body) = envelope.body() else {
        // A corrupt base64 member is a corrupt row — same answer as a
        // missing one, so no client retries it.
        return err(404, "unknown_block");
    };
    let status = if (200..=299).contains(&envelope.status) {
        envelope.status
    } else {
        // A stored non-2xx upstream answer is never minted by this
        // implementation (the lookup route 502s those); if one lands
        // here anyway, serve the bytes as a plain 200 — the status is
        // metadata, the content is what the CID addresses.
        200
    };
    let mut resp = Response::from_bytes(body)?.with_status(status);
    let headers = resp.headers_mut();
    headers.set(
        "Content-Type",
        if envelope.content_type.is_empty() {
            DEFAULT_CONTENT_TYPE
        } else {
            &envelope.content_type
        },
    )?;
    decorate(&mut resp)?;
    Ok(resp)
}

/// The family's shared response decoration: CORS-open + a one-minute
/// public cap (§3.4's reasoning; blocks are immutable per CID, so the
/// cap only bounds how long a deleted row lingers in shared caches).
fn decorate(resp: &mut Response) -> Result<()> {
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Cache-Control", "public, max-age=60")?;
    Ok(())
}

/// CORS preflight (the lookup client may be a browser).
fn cors_preflight() -> Result<Response> {
    let mut resp = Response::empty()?.with_status(204);
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS")?;
    headers.set("Access-Control-Max-Age", "600")?;
    Ok(resp)
}
