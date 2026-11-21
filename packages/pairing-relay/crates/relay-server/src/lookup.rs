//! `/api/lookup/fetch` — the stats-cache proxy (contract §3). Every
//! policy decision is relay-core's (`relay_core::lookup`): the host
//! allowlist gate, the canonical request line + CID, the TTL table,
//! the envelope shape, the budgets and the response header spellings.
//! This module owns only the I/O: the per-IP budget, the local block
//! store, the pull-through peer sync, the upstream fetch with its
//! same-host redirect policy, and the streamed pass-through for
//! over-cap bodies (§3.1: stored never, streamed once).

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use relay_core::lookup::{
    BLOCK_GRACE_SECS, BROWSER_UA, LookupEnvelope, STORE_CAP, UPSTREAM_BUDGET_SECS, allowed_host,
    cache_control_public, canonical_request_line, cid_of_request, cid_verify, classify_ttl,
    remaining_max_age, sha256_hex,
};

use crate::state::{AppState, client_ip};

/// `x-wowsp-cache` provenance spellings (§3.4, relay-core constants).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    Miss,
    Hit,
    PeerHit,
}

impl Provenance {
    fn as_str(self) -> &'static str {
        match self {
            Provenance::Miss => relay_core::lookup::CACHE_MISS,
            Provenance::Hit => relay_core::lookup::CACHE_HIT,
            Provenance::PeerHit => relay_core::lookup::CACHE_PEER_HIT,
        }
    }
}

/// Build the proxy response for an envelope we hold in memory (§3.4
/// headers via relay-core helpers).
pub fn envelope_response(env: &LookupEnvelope, now: u64, provenance: Provenance) -> Response {
    let age = env.age(now);
    let remaining = remaining_max_age(env.ttl, age);
    match env.body() {
        Some(bytes) => {
            let builder = Response::builder()
                .status(StatusCode::from_u16(env.status).unwrap_or(StatusCode::OK))
                .header(header::CONTENT_TYPE, &env.content_type)
                .header(relay_core::lookup::CACHE_HEADER, provenance.as_str())
                .header(header::AGE, age.to_string())
                .header(header::CACHE_CONTROL, cache_control_public(remaining))
                .header(header::CONTENT_LENGTH, bytes.len().to_string());
            builder
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        },
        None => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Lookup error rows use the contract's bare shape (§3.1: 403
/// `{"error":"forbidden_host"}`), NOT the gateway's {ok,error} envelope.
fn error_row(status: StatusCode, code: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({ "error": code })),
    )
        .into_response()
}

pub async fn fetch(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    method: axum::http::Method,
    Query(query): Query<HashMap<String, String>>,
    body: bytes::Bytes,
) -> Response {
    let ip = client_ip(&app.cfg, &headers, addr);
    let now = app.now() as u64;

    // §3.5: per-IP hourly budget on /api/lookup/*.
    if let Err(retry) = app.lookup_rate.check(&ip, now as i64) {
        return rate_limited(retry);
    }

    // §3.1 + §3.2: absolute https URL whose authority is one of the 13
    // allowlisted hosts (relay-core's gate — userinfo, non-443 ports and
    // IP literals all refuse).
    let Some(raw_url) = query.get("url").map(String::as_str) else {
        return error_row(StatusCode::BAD_REQUEST, "missing_url");
    };
    let Some(host) = allowed_host(raw_url) else {
        return error_row(StatusCode::FORBIDDEN, "forbidden_host");
    };
    let host = host.to_string();

    // POST forwards the body (≤ POST_BODY_MAX via the route's body
    // limit) verbatim; GET has none. A bodyless POST hashes the EMPTY
    // body (worker parity — CIDs agree across transports for the same
    // request). The canonical line + CID key are relay-core's (§3.3).
    let post_body: Option<&[u8]> = if method == axum::http::Method::POST {
        Some(&body)
    } else {
        None
    };
    let body_sha256 = post_body.map(|b| sha256_hex(b));
    let request_line = canonical_request_line(method.as_str(), raw_url, body_sha256.as_deref());
    let cid = cid_of_request(method.as_str(), raw_url, body_sha256.as_deref());

    // Local store: a row within its TTL is a hit; a stale row falls
    // through to refresh (the grace window keeps it servable to PEERS,
    // §4.3 — the lookup path itself only trusts the TTL window).
    if let Some((envelope_json, _expires_at, stored_line)) = app.store.get_block(&cid) {
        if let Ok(env) = serde_json::from_str::<LookupEnvelope>(&envelope_json) {
            // §4.2: verify the row's content addressing + upstream
            // before serving.
            if cid_verify(&cid, &stored_line) && env.upstream == host && env.is_fresh(now) {
                return envelope_response(&env, now, Provenance::Hit);
            }
        }
    }

    // §5.4: pull-through sync before the real upstream (path carries
    // the local TTL authority).
    let path = reqwest::Url::parse(raw_url)
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    if app.cfg.sync {
        if let Some(env) = crate::sync::pull_through(&app, &cid, &request_line, &host, &path).await
        {
            // pull_through stored the verified copy; the next request
            // is a plain hit.
            return envelope_response(&env, now, Provenance::PeerHit);
        }
    }

    // The real upstream fetch (§3.1 budgets: 15 s total, 8 MiB store
    // cap, browser UA, same-host redirects enforced by the client's
    // redirect policy — cross-host hops surface as errors → 502).
    let upstream_url = app.cfg.resolve_outbound(raw_url);
    let mut req = app
        .upstream_http
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            &upstream_url,
        )
        .timeout(std::time::Duration::from_secs(UPSTREAM_BUDGET_SECS))
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT, "*/*");
    if let Some(body) = post_body {
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| "application/json".to_string());
        req = req
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body.to_vec());
    }
    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(_) => return error_row(StatusCode::BAD_GATEWAY, "upstream_failed"),
    };

    let status = upstream.status().as_u16();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "application/json".to_string());
    // §3.3: the TTL by host + path purpose (relay-core's table).
    let path = reqwest::Url::parse(raw_url)
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    let ttl = classify_ttl(&host, &path);

    // Worker parity: every NON-2xx upstream answer is a uniform 502
    // upstream_failed — error statuses are never cached, never proxied
    // verbatim (the client treats any non-2xx as "fall back to the
    // direct chain", so no information is lost).
    if !(200..300).contains(&status) {
        return error_row(StatusCode::BAD_GATEWAY, "upstream_failed");
    }

    // Already-known oversize → pure streaming pass-through (§3.1).
    let oversize_declared = upstream
        .content_length()
        .is_some_and(|len| len as usize > STORE_CAP);

    if oversize_declared {
        // Streamed once, not stored (§3.1: "pass through UNCACHED").
        let builder = with_miss_provenance(
            Response::builder()
                .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
                .header(header::CONTENT_TYPE, &content_type),
            ttl,
        );
        let stream = upstream_to_body(upstream, None);
        return builder
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    // Buffered-with-cap: store when the body fits, flip to pass-through
    // the moment it does not.
    let finalize = Finalize {
        store: app.store.clone(),
        cid,
        expires_at: now as i64 + ttl as i64 + BLOCK_GRACE_SECS as i64,
        head: EnvelopeHead {
            status,
            content_type,
            fetched_at: now,
            ttl,
            upstream: host,
            line: request_line,
        },
    };
    let builder = with_miss_provenance(
        Response::builder()
            .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
            .header(header::CONTENT_TYPE, finalize.head.content_type.clone()),
        ttl,
    );
    let stream = upstream_to_body(upstream, Some(finalize));
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 429 with the standard Retry-After header (§3.5).
fn rate_limited(retry_after_secs: u64) -> Response {
    let retry_after = retry_after_secs.to_string();
    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::RETRY_AFTER, retry_after.as_str()),
        ],
        axum::Json(serde_json::json!({ "error": "rate_limited" })),
    )
        .into_response()
}

/// Decorate a fresh-upstream response builder with the §3.4 provenance
/// headers (miss + age 0 + the purpose TTL).
fn with_miss_provenance(
    builder: axum::http::response::Builder,
    ttl: u64,
) -> axum::http::response::Builder {
    builder
        .header(relay_core::lookup::CACHE_HEADER, Provenance::Miss.as_str())
        .header(header::AGE, "0")
        .header(header::CACHE_CONTROL, cache_control_public(ttl))
}

/// The immutable envelope fields known before the body streams.
struct EnvelopeHead {
    status: u16,
    content_type: String,
    fetched_at: u64,
    ttl: u64,
    upstream: String,
    line: String,
}

/// Parts needed to store the envelope once a streamed body completes
/// under the cap.
struct Finalize {
    store: crate::store::Store,
    cid: String,
    expires_at: i64,
    head: EnvelopeHead,
}

/// Wrap a reqwest response body into an axum body: buffer up to
/// `STORE_CAP`, store on clean completion (when `finalize` is set),
/// pass through raw once the cap is exceeded (§3.1 "streamed once, not
/// stored").
fn upstream_to_body(
    resp: reqwest::Response,
    finalize: Option<Finalize>,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    struct St {
        resp: reqwest::Response,
        buf: Vec<u8>,
        exceeded: bool,
        finished: bool,
        finalize: Option<Finalize>,
    }
    let st = St {
        resp,
        buf: Vec::new(),
        exceeded: false,
        finished: false,
        finalize,
    };
    futures_util::stream::unfold(st, |mut st| async move {
        if st.finished {
            return None;
        }
        loop {
            match st.resp.chunk().await {
                Ok(Some(chunk)) => {
                    if st.exceeded {
                        return Some((Ok(chunk.to_vec()), st));
                    }
                    st.buf.extend_from_slice(&chunk);
                    if st.buf.len() > STORE_CAP {
                        // Over the cap: emit what we hold and keep
                        // streaming raw — nothing is stored.
                        st.exceeded = true;
                        let out = std::mem::take(&mut st.buf);
                        return Some((Ok(out), st));
                    }
                    // Still buffering — await the next chunk.
                },
                Ok(None) => {
                    st.finished = true;
                    if !st.exceeded {
                        if let Some(f) = st.finalize.take() {
                            let env = LookupEnvelope::new(
                                f.head.status,
                                &f.head.content_type,
                                &st.buf,
                                f.head.fetched_at,
                                f.head.ttl,
                                &f.head.upstream,
                                &f.head.line,
                            );
                            let _ = f.store.put_block(
                                &f.cid,
                                &serde_json::to_string(&env).unwrap_or_default(),
                                f.expires_at,
                                &f.head.line,
                            );
                        }
                    }
                    let out = std::mem::take(&mut st.buf);
                    if out.is_empty() {
                        return None;
                    }
                    return Some((Ok(out), st));
                },
                Err(e) => {
                    st.finished = true;
                    // Mid-body upstream failure: truncate. Nothing stored.
                    return Some((Err(std::io::Error::other(e.to_string())), st));
                },
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::lookup::canonical_request_line;

    fn env(fetched_at: u64, ttl: u64) -> LookupEnvelope {
        LookupEnvelope::new(
            200,
            "application/json",
            b"{\"ok\":true}",
            fetched_at,
            ttl,
            "vortex.wowsgame.cn",
            "GET https://vortex.wowsgame.cn/x",
        )
    }

    #[test]
    fn envelope_serializes_to_the_contract_shape() {
        let json = serde_json::to_string(&env(1_732_185_600, 120)).unwrap();
        for needle in [
            "\"v\":1",
            "\"status\":200",
            "\"contentType\":\"application/json\"",
            "\"fetchedAt\":1732185600",
            "\"ttl\":120",
        ] {
            assert!(json.contains(needle), "{json} missing {needle}");
        }
        assert!(json.contains("\"bodyB64\":\""));
        // Round trip.
        let back: LookupEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env(1_732_185_600, 120));
    }

    #[test]
    fn envelope_response_carries_provenance_and_freshness_headers() {
        let now = 1_000_000;
        let e = env(now - 30, 120);
        let resp = envelope_response(&e, now, Provenance::Hit);
        assert_eq!(resp.status(), StatusCode::OK);
        let h = resp.headers();
        assert_eq!(h.get("x-wowsp-cache").unwrap(), "hit");
        assert_eq!(h.get(header::AGE).unwrap(), "30");
        assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "public, max-age=90");
        assert_eq!(h.get(header::CONTENT_TYPE).unwrap(), "application/json");
        // Expired content clamps max-age at 0.
        let e2 = env(now - 500, 120);
        let resp2 = envelope_response(&e2, now, Provenance::PeerHit);
        assert_eq!(
            resp2.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=0"
        );
        assert_eq!(resp2.headers().get("x-wowsp-cache").unwrap(), "peer-hit");
    }

    #[test]
    fn request_lines_and_cids_come_from_relay_core() {
        // The seam is gone: this crate consumes relay-core directly.
        // A pinned end-to-end check that the line and cid_of_request
        // agree with cid_verify (mesh interop).
        let line = canonical_request_line("GET", "https://vortex.wowsgame.cn/x", None);
        let cid = cid_of_request("GET", "https://vortex.wowsgame.cn/x", None);
        assert!(cid_verify(&cid, &line));
        assert!(!cid_verify(&cid, "GET https://elsewhere/"));
    }
}
