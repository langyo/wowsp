//! The router (contract §9 wire table). This server serves EXACTLY:
//! /api/health, /api/lookup/fetch, /api/blocks/{cid}[/raw], /ipfs/{cid},
//! /api/peers[/announce], /gateway/{health,session,pub,sub} — nothing
//! else. The maintainer-only surfaces (/api/digests, feedback, erp,
//! qqbot, sponsors, replays) stay on the official worker node; unknown
//! paths answer 404 (the capabilities document says nothing more).

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use tower_http::cors::CorsLayer;

use crate::state::AppState;

/// /gateway/session body cap (mirrors the worker's 8 KiB audit shape).
const SESSION_BODY_MAX: usize = 8 * 1024;

pub fn router(app: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/lookup/fetch",
            get(crate::lookup::fetch).post(crate::lookup::fetch).layer(
                axum::extract::DefaultBodyLimit::max(relay_core::lookup::POST_BODY_MAX),
            ),
        )
        .route("/api/blocks/{cid}", get(crate::blocks::envelope_json))
        .route("/api/blocks/{cid}/raw", get(crate::blocks::raw))
        .route("/ipfs/{cid}", get(crate::blocks::ipfs_alias))
        .route("/api/peers", get(crate::peers::list))
        .route(
            "/api/peers/announce",
            post(crate::peers::announce).layer(axum::extract::DefaultBodyLimit::max(
                relay_core::peers::ANNOUNCE_BODY_MAX,
            )),
        )
        .route("/gateway/health", get(crate::gateway::health))
        .route(
            "/gateway/session",
            post(crate::gateway::session)
                .layer(axum::extract::DefaultBodyLimit::max(SESSION_BODY_MAX)),
        )
        .route("/gateway/pub", get(crate::gateway::pub_upgrade))
        .route("/gateway/sub", get(crate::gateway::sub_upgrade))
        .fallback(not_found)
        // The whole surface is public data / gateway plumbing: CORS-open
        // (contract §3.4, §5.1 — the stats family is public).
        .layer(CorsLayer::permissive())
        .with_state(app)
}

/// GET /api/health — relay-core's manifest with this deployment's
/// capability vector + node block (contract §2, the wave-A
/// CapabilitiesDoc/NodeDoc fields). Always `cache-control: no-store`.
pub async fn health(State(app): State<Arc<AppState>>) -> Response {
    let overrides = relay_core::manifest::ManifestOverrides {
        notice: app.cfg.notice.clone().filter(|s| !s.trim().is_empty()),
        capabilities: relay_core::manifest::CapabilitiesDoc {
            gateway: true,
            lookup: true,
            peers: true,
            blocks: true,
        },
        node: relay_core::manifest::NodeDoc {
            id: app.node_id.clone(),
            role: app.cfg.role.clone(),
            sync: app.cfg.sync,
            peers_upstream: Some(app.cfg.peers_upstream.clone()),
        },
    };
    let doc = relay_core::manifest::gateway_manifest(&overrides);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::to_string(&doc).unwrap_or_default(),
    )
        .into_response()
}

/// Everything unknown — including the maintainer-only namespaces that
/// stay on the official node — answers 404.
async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({ "error": "not_found" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> Arc<AppState> {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::Config::default();
        cfg.data_dir = dir.path().to_path_buf();
        AppState::init(cfg).unwrap()
    }

    async fn probe_body(router: &Router, method: &str, path: &str) -> (StatusCode, String) {
        let resp = probe_raw(router, method, path).await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    async fn probe(router: &Router, method: &str, path: &str) -> StatusCode {
        use tower::util::ServiceExt;
        let req = axum::extract::Request::builder()
            .method(method)
            .uri(path)
            .body(axum::body::Body::empty())
            .unwrap();
        router
            .clone()
            .oneshot(req)
            .await
            .expect("router dispatch")
            .status()
    }

    /// The route table matches the contract's §9 wire reference — every
    /// served path present, the maintainer-only namespaces absent.
    #[tokio::test]
    async fn router_serves_exactly_the_contract_surface() {
        let router = router(app());
        for (method, path) in [
            ("GET", "/api/health"),
            ("GET", "/api/lookup/fetch"),
            ("POST", "/api/lookup/fetch"),
            ("GET", "/api/peers"),
            ("POST", "/api/peers/announce"),
            ("GET", "/gateway/health"),
            ("POST", "/gateway/session"),
            ("GET", "/gateway/pub"),
            ("GET", "/gateway/sub"),
        ] {
            // Not 404: the path exists in the table (missing query/WS
            // params yield 4xx from the handler, never the fallback).
            let status = probe(&router, method, path).await;
            assert_ne!(status, StatusCode::NOT_FOUND, "{method} {path} must route");
        }
        // The block routes answer the HANDLER's 404 for an unknown cid
        // (unknown_block) — distinct from the fallback's not_found, which
        // is how the test tells "routed" from "absent".
        for (method, path) in [
            ("GET", "/api/blocks/abc"),
            ("GET", "/api/blocks/abc/raw"),
            ("GET", "/ipfs/abc"),
        ] {
            let (status, body) = probe_body(&router, method, path).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
            assert!(body.contains("unknown_block"), "{method} {path} -> {body}");
        }
        // Unknown + maintainer-only namespaces fall to the 404 fallback.
        for path in [
            "/",
            "/api",
            "/api/digests/app",
            "/api/feedback/submit",
            "/api/feedback/config",
            "/api/erp/login",
            "/api/qqbot/callback",
            "/api/sponsors",
            "/api/replays/wanted",
            "/gateway",
            "/gateway/other",
            "/api/lookup",
            "/api/lookup/other",
            "/api/blocks",
            "/ipfs",
        ] {
            assert_eq!(
                probe(&router, "GET", path).await,
                StatusCode::NOT_FOUND,
                "{path} must 404"
            );
        }
    }

    /// The health document carries the manifest + capabilities + node
    /// block (contract §2) and never caches.
    #[tokio::test]
    async fn health_doc_shape() {
        let router = router(app());
        let resp = probe_raw(&router, "GET", "/api/health").await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let doc: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(doc["ok"], true);
        assert_eq!(doc["provider"], "wowsp-gateway");
        assert_eq!(doc["capabilities"]["gateway"], true);
        assert_eq!(doc["capabilities"]["lookup"], true);
        assert_eq!(doc["capabilities"]["peers"], true);
        assert_eq!(doc["capabilities"]["blocks"], true);
        assert!(doc["node"]["id"].as_str().unwrap().len() == 32);
        assert_eq!(doc["node"]["role"], "community");
        assert_eq!(doc["node"]["sync"], true);
    }

    async fn probe_raw(router: &Router, method: &str, path: &str) -> axum::response::Response {
        use tower::util::ServiceExt;
        let req = axum::extract::Request::builder()
            .method(method)
            .uri(path)
            .body(axum::body::Body::empty())
            .unwrap();
        router.clone().oneshot(req).await.expect("router dispatch")
    }
}
