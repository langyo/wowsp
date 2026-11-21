//! `/api/blocks/*` + `/ipfs/*` — the content-addressed store surface
//! (contract §4.2):
//!
//!   GET /api/blocks/<cid>      → the envelope JSON (404 unknown)
//!   GET /api/blocks/<cid>/raw  → decoded body bytes, stored content-type
//!   GET /ipfs/<cid>            → alias of /raw (IPFS gateway convention)
//!
//! Every served row is content-verified: the store recomputes the
//! request-line hash from the row's canonical line and drops the row on
//! mismatch (§4.2 — a lying peer's block can never be served).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

use relay_core::lookup::{LookupEnvelope, cid_verify};

use crate::state::AppState;

/// GET /api/blocks/{cid} — the envelope JSON.
pub async fn envelope_json(State(app): State<Arc<AppState>>, Path(cid): Path<String>) -> Response {
    match verified_row(&app, &cid).await {
        Some((json, _env)) => serve_json(json, "public, max-age=60"),
        None => not_found(),
    }
}

/// GET /api/blocks/{cid}/raw — decoded body bytes with the stored
/// content-type.
pub async fn raw(State(app): State<Arc<AppState>>, Path(cid): Path<String>) -> Response {
    serve_raw(&app, &cid).await
}

/// GET /ipfs/{cid} — the IPFS-gateway alias of /raw (§4.2).
pub async fn ipfs_alias(State(app): State<Arc<AppState>>, Path(cid): Path<String>) -> Response {
    serve_raw(&app, &cid).await
}

async fn serve_raw(app: &Arc<AppState>, cid: &str) -> Response {
    match verified_row(app, cid).await {
        Some((_json, env)) => match env.body() {
            Some(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, &env.content_type)
                .header(header::CACHE_CONTROL, "public, max-age=60")
                .body(axum::body::Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
            None => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        None => not_found(),
    }
}

/// Fetch the row and run the §4.2 content check; a failing row is
/// dropped (deleted) and never served.
async fn verified_row(app: &Arc<AppState>, cid: &str) -> Option<(String, LookupEnvelope)> {
    let (json, _expires_at, request_line) = app.store.get_block(cid)?;
    let env: LookupEnvelope = serde_json::from_str(&json).ok()?;
    if !cid_verify(cid, &request_line) || env.v != 1 {
        app.store.delete_block(cid);
        return None;
    }
    Some((json, env))
}

fn serve_json(json: String, cache_control: &str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, cache_control)
        .body(axum::body::Body::from(json))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({ "ok": false, "error": "unknown_block" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::lookup::{canonical_request_line, cid_of_request};

    /// A row whose stored request line no longer hashes to its CID is
    /// dropped, not served (the §4.2 anti-poisoning check).
    #[tokio::test]
    async fn mismatched_rows_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::Config::default();
        cfg.data_dir = dir.path().to_path_buf();
        let app = crate::state::AppState::init(cfg).unwrap();
        let line = canonical_request_line("GET", "https://vortex.wowsgame.cn/x", None);
        let cid = cid_of_request("GET", "https://vortex.wowsgame.cn/x", None);
        let env = LookupEnvelope::new(
            200,
            "application/json",
            b"[]",
            0,
            120,
            "vortex.wowsgame.cn",
            &line,
        );
        app.store.put_block(
            &cid,
            &serde_json::to_string(&env).unwrap(),
            9_999_999,
            &line,
        );
        assert!(
            verified_row(&app, &cid).await.is_some(),
            "honest row serves"
        );
        // Poison it: wrong request line under the same CID.
        app.store.put_block(
            &cid,
            &serde_json::to_string(&env).unwrap(),
            9_999_999,
            "GET https://elsewhere/",
        );
        assert!(
            verified_row(&app, &cid).await.is_none(),
            "lying row refused"
        );
        assert!(
            app.store.get_block(&cid).is_none(),
            "…and dropped from the store"
        );
    }
}
