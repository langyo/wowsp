//! `/api/peers` + `/api/peers/announce` — the broadcast server list
//! and the announce handshake (contract §5). All policy is
//! relay-core's (`relay_core::peers`): the public/private URL gates,
//! the announce body gate, the budgets (PEERS_MAX / PEER_TTL_SECS /
//! ANNOUNCE_RATE_PER_HOUR), the own-wins merge and the weak ETag. This
//! module owns the SQLite registry, the liveness callback, the
//! peersUpstream list fetch (at most 1/60 s) and the wire handlers.

use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use relay_core::manifest::CapabilitiesDoc;
use relay_core::peers::{
    PeerRow, PeersDoc, UPSTREAM_CACHE_TTL_SECS, merge_peers, parse_announce_body, peers_doc,
    peers_etag, valid_private_peer_url, valid_public_peer_url,
};

use crate::state::{AppState, UpstreamPeers, client_ip};

/// Liveness callback budget (§5.2 step 2).
const HEALTH_PROBE_TIMEOUT_SECS: u64 = 10;

/// The merged PUBLIC view: own registry rows (§5.3) ∪ the
/// peersUpstream list through relay-core's own-wins merge. This is
/// both the /api/peers body and the sync candidate ladder (§5.4
/// "peers from the list").
pub async fn merged_public_list(app: &Arc<AppState>) -> Vec<PeerRow> {
    let now = app.now();
    let own: Vec<PeerRow> = app
        .store
        .list_peers(now, true)
        .into_iter()
        .filter_map(|row| serde_json::from_str::<PeerRow>(&row.doc).ok())
        .filter(|row| !row.private)
        .collect();
    merge_peers(&own, &upstream_list(app).await)
}

// ── GET /api/peers ─────────────────────────────────────────────────────

pub async fn list(State(app): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let merged = merged_public_list(&app).await;
    let doc: PeersDoc = peers_doc(merged.clone(), app.now() as u64);
    let body = serde_json::to_string(&doc).unwrap_or_default();
    // §5.1: relay-core's weak etag (content-only — generatedAt stays
    // outside the hash so identical content revalidates).
    let etag = peers_etag(&merged);
    let cache = format!("public, max-age={UPSTREAM_CACHE_TTL_SECS}");
    if let Some(inm) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        // Weak comparison: the W/ prefix may or may not ride the
        // client's copy.
        let bare = etag.trim_start_matches("W/");
        if inm.split(',').any(|t| {
            let t = t.trim();
            t == etag || t.trim_start_matches("W/") == bare || format!("W/{t}") == etag
        }) {
            return (
                StatusCode::NOT_MODIFIED,
                [
                    (header::ETAG, etag.clone()),
                    (header::CACHE_CONTROL, cache.clone()),
                ],
                axum::body::Body::empty(),
            )
                .into_response();
        }
    }
    (
        StatusCode::OK,
        [(header::ETAG, etag), (header::CACHE_CONTROL, cache)],
        axum::body::Body::from(body),
    )
        .into_response()
}

/// The peersUpstream list, fetched at most 1/60 s (§5.1). Unreachable
/// upstream → empty (own rows still serve).
async fn upstream_list(app: &Arc<AppState>) -> Vec<PeerRow> {
    {
        let cached = app.upstream_peers.lock().await;
        if let Some(cache) = cached.as_ref() {
            if cache.fetched_at.elapsed().as_secs() < UPSTREAM_CACHE_TTL_SECS {
                return cache
                    .peers
                    .iter()
                    .filter_map(|p| serde_json::from_value::<PeerRow>(p.clone()).ok())
                    .collect();
            }
        }
    }
    let url = app.cfg.resolve_outbound(
        format!("{}/api/peers", app.cfg.peers_upstream.trim_end_matches('/')).as_str(),
    );
    let fetched = match app
        .plain_http
        .get(&url)
        .timeout(std::time::Duration::from_secs(HEALTH_PROBE_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("peers").and_then(|p| p.as_array()).cloned())
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let mut guard = app.upstream_peers.lock().await;
    *guard = Some(UpstreamPeers {
        fetched_at: std::time::Instant::now(),
        peers: fetched.clone(),
    });
    fetched
        .iter()
        .filter_map(|p| serde_json::from_value::<PeerRow>(p.clone()).ok())
        .collect()
}

// ── POST /api/peers/announce ───────────────────────────────────────────

pub async fn announce(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Response {
    // §5.2 step 5: operators may close their registry.
    if !app.cfg.peers_accept_announces {
        return (
            StatusCode::FORBIDDEN,
            [(header::CACHE_CONTROL, "no-store")],
            axum::Json(serde_json::json!({ "error": "announces_disabled" })),
        )
            .into_response();
    }
    let ip = client_ip(&app.cfg, &headers, addr);
    let now = app.now();
    // §5.2 step 4: 10 announces/hour/IP (relay-core budget).
    if let Err(retry) = app.announce_rate.check(&ip, now) {
        let retry_after = retry.to_string();
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::RETRY_AFTER, retry_after.as_str()),
            ],
            axum::Json(serde_json::json!({ "error": "rate_limited" })),
        )
            .into_response();
    }
    // Announce is best-effort (§5.2 step 2): liveness/shape problems
    // are 200 {listed:false}; only a malformed BODY is a 400 (the
    // relay-core gate's own codes).
    let parsed = match parse_announce_body(&String::from_utf8_lossy(&body)) {
        Ok(parsed) => parsed,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                [(header::CACHE_CONTROL, "no-store")],
                axum::Json(serde_json::json!({ "error": e.code() })),
            )
                .into_response();
        },
    };
    // §5.2's public shape first; an http/IP-literal (or otherwise
    // public-ineligible) URL that passes the §5.3 private gate is
    // stored as a private row — never listed.
    let (url, private) = if let Some(normalized) = valid_public_peer_url(&parsed.url) {
        (normalized, false)
    } else if let Some(normalized) = valid_private_peer_url(&parsed.url) {
        (normalized, true)
    } else {
        return listed(false, Some("invalid_url"));
    };

    // §5.2 step 2: liveness callback against {url}/api/health.
    let probe = app
        .cfg
        .resolve_outbound(format!("{url}/api/health").as_str());
    let health = match app
        .plain_http
        .get(&probe)
        .timeout(std::time::Duration::from_secs(HEALTH_PROBE_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp.json::<serde_json::Value>().await.ok(),
        _ => None,
    };
    let Some(health) = health else {
        return listed(false, Some("unreachable"));
    };
    let Some(row) = row_from_health(&health, &url, private, now, parsed.contact.as_deref()) else {
        return listed(false, Some("foreign"));
    };
    app.store.put_peer(&row, now);
    if private {
        listed(false, Some("private_url"))
    } else {
        listed(true, None)
    }
}

/// Build a registry row from the health callback's answer (§5.2 step
/// 2: record the answered capabilities + node id; the announce
/// contact line rides the row's notice).
fn row_from_health(
    health: &serde_json::Value,
    url: &str,
    private: bool,
    now: i64,
    contact: Option<&str>,
) -> Option<PeerRow> {
    let caps = health.get("capabilities")?;
    if !caps.is_object() {
        return None;
    }
    if health.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    let capabilities: CapabilitiesDoc = serde_json::from_value(caps.clone()).ok()?;
    Some(PeerRow {
        url: url.to_string(),
        capabilities,
        role: health
            .pointer("/node/role")
            .and_then(|v| v.as_str())
            .unwrap_or("community")
            .to_string(),
        node_id: health
            .pointer("/node/id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        added_at: now as u64,
        last_seen_at: now as u64,
        notice: contact.map(str::to_string),
        private,
    })
}

fn listed(listed: bool, reason: Option<&str>) -> Response {
    let mut body = serde_json::json!({ "ok": true, "listed": listed });
    if let Some(reason) = reason {
        body["reason"] = serde_json::json!(reason);
    }
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(body),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_docs_reject_foreign_answers() {
        let caps = serde_json::json!({"lookup": true});
        let good = serde_json::json!({
            "ok": true,
            "capabilities": caps,
            "node": { "id": "8f14e45fceea167a5a36dedd4bea2543", "role": "community" },
        });
        let row =
            row_from_health(&good, "https://wowsp.example.org", false, 100, Some("ops")).unwrap();
        assert_eq!(row.node_id, "8f14e45fceea167a5a36dedd4bea2543");
        assert_eq!(row.role, "community");
        assert_eq!(row.notice.as_deref(), Some("ops"));
        assert_eq!(row.added_at, 100);
        // A foreign 200 (no capabilities / not ok) never records.
        assert!(
            row_from_health(
                &serde_json::json!({"ok": true}),
                "https://x",
                false,
                0,
                None
            )
            .is_none()
        );
        assert!(
            row_from_health(
                &serde_json::json!({"ok": false, "capabilities": caps}),
                "https://x",
                false,
                0,
                None
            )
            .is_none()
        );
        assert!(
            row_from_health(
                &serde_json::json!({"capabilities": "yes"}),
                "https://x",
                false,
                0,
                None
            )
            .is_none()
        );
    }

    #[test]
    fn peers_rows_serialize_to_the_contract_shape() {
        let row = PeerRow {
            url: "https://wowsp.example.org".into(),
            capabilities: CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true,
            },
            role: "community".into(),
            node_id: "8f14".into(),
            added_at: 1_732_185_600,
            last_seen_at: 1_732_185_700,
            notice: Some("XX军团节点".into()),
            private: false,
        };
        let json = serde_json::to_string(&row).unwrap();
        for needle in [
            "\"nodeId\":\"8f14\"",
            "\"addedAt\":1732185600",
            "\"lastSeenAt\":1732185700",
        ] {
            assert!(json.contains(needle), "{json}");
        }
    }

    /// The list document is relay-core's — pin the native side to it
    /// (field names + weak-etag stability).
    #[test]
    fn list_docs_and_etags_come_from_relay_core() {
        let row = PeerRow {
            url: "https://a.example.org".into(),
            capabilities: CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true,
            },
            role: "community".into(),
            node_id: "8f14".into(),
            added_at: 1,
            last_seen_at: 2,
            notice: None,
            private: false,
        };
        let doc = peers_doc(vec![row.clone()], 1_732_185_600);
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"generatedAt\":1732185600"));
        assert!(json.contains("\"peers\":"));
        // The etag is stable across re-renderings (content-only).
        assert_eq!(peers_etag(&[row.clone()]), peers_etag(&[row.clone()]));
        assert!(peers_etag(&[row]).starts_with("W/\""));
    }
}
