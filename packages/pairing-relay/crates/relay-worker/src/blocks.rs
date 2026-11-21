//! GET /api/blocks/<cid>, /api/blocks/<cid>/raw and /ipfs/<cid> — the
//! content-addressed block store's read side (design contract:
//! docs/en/designs/cache-mesh.md §4.2). Thin I/O over
//! [`relay_core::lookup`]'s envelope: the KV row `blk:<cid>` IS the
//! envelope, minted by the lookup handler (this store's write side) or
//! by a peer pull-through — both verified at ingress against the CID
//! (`cid_verify`), so serving only re-checks the belt: a row whose
//! `line` does not hash to the requested CID is treated as absent
//! (404), never served. A row without a `line` anchor (foreign or
//! hand-maintained) is served on local-store trust — content
//! verification targets peer-sourced rows (`lookup.rs` drops those
//! fail-closed at ingress).
//!
//! CORS-open (public data), `cache-control: public, max-age=60` — the
//! blocks family is the cold path; the lookup route fronts everything
//! hot with the edge Cache API.

use relay_core::lookup::{self, LookupEnvelope};
use worker::*;

use crate::feedback::err;

/// The block store's KV binding (wrangler.toml, over the shared
/// namespace).
const KV: &str = "LOOKUP_KV";
/// Pre-cache-mesh selfhosts have no LOOKUP_KV binding — their block
/// rows, if any, live under the feedback namespace.
const KV_FALLBACK: &str = "FEEDBACK_KV";

/// Load (and serve-verify) one block row. `None` = absent, corrupt
/// or CID-mismatched — all three are a 404 to the caller.
async fn load_block(env: &Env, cid: &str) -> Option<LookupEnvelope> {
    let kv = match env.kv(KV) {
        Ok(kv) => kv,
        Err(_) => env.kv(KV_FALLBACK).ok()?,
    };
    let key = format!("{}{cid}", lookup::BLOCK_KEY_PREFIX);
    let raw = kv.get(&key).text().await.ok().flatten()?;
    let envelope: LookupEnvelope = serde_json::from_str(&raw).ok()?;
    match &envelope.line {
        // The §4.2 belt: the stored line must hash to the CID the
        // caller asked for. (Ingress already refused unverifiable
        // PEER rows; this catches a misplaced/mis-keyed local row.)
        Some(line) if !lookup::cid_verify(cid, line) => None,
        _ => Some(envelope),
    }
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
    serve_body(&req, &env, cid).await
}

/// GET /ipfs/<cid> — the IPFS-gateway alias of /raw (§4.2): every
/// wowsp server is literally an IPFS HTTP gateway for its blocks.
pub async fn handle_ipfs(req: Request, env: Env, cid: &str) -> Result<Response> {
    handle_block_raw(req, env, cid).await
}

/// Shared body-serving path of /raw and /ipfs.
async fn serve_body(_req: &Request, env: &Env, cid: &str) -> Result<Response> {
    let Some(envelope) = load_block(env, cid).await else {
        return err(404, "unknown_block");
    };
    let Some(body) = envelope.body() else {
        // A corrupt base64 member is a corrupt row — same answer as a
        // missing one, so no client retries it.
        return err(404, "unknown_block");
    };
    let mut resp =
        Response::from_bytes(body)?.with_status(if (200..=299).contains(&envelope.status) {
            envelope.status
        } else {
            // A stored non-2xx upstream answer is never minted by this
            // implementation (the lookup route 502s those); if one
            // lands here anyway, serve the bytes as a plain 200 — the
            // status is metadata, the content is what the CID
            // addresses.
            200
        });
    let headers = resp.headers_mut();
    headers.set(
        "Content-Type",
        if envelope.content_type.is_empty() {
            "application/json"
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
