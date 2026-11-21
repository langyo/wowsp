//! Cache-mesh client surface (docs/en/designs/cache-mesh.md §6).
//!
//! The stats lookups crawl where the game is played — in CN the vortex
//! transport can take 30 s+ at evening peak. The cache mesh turns one
//! player's slow fetch into everyone's cache hit: a WoWSP server
//! (official node, a legion's self-host, a community deployment) answers
//! `GET|POST /api/lookup/fetch?url=…` from its store before the client
//! ever dials the upstream itself. This module holds the client side:
//!
//!   - the §6.2 transport hook ([`send_via_cache_mesh`]) — called by
//!     `upstream_health::send_with_fallback` BEFORE the proxy→direct
//!     chain, it walks the ordered server list and returns the first 2xx
//!     answer as-if-upstream (content-type passthrough, §3.4); every miss
//!     falls through to the unchanged chain. No call site anywhere else
//!     changes — the overlay and streaming paths all funnel through the
//!     same choke point.
//!   - the `stats_cache_probe` command (§6.3, the github_mirror_probe
//!     pattern): one row per server root — `GET {root}/api/health`,
//!     manifest + capabilities parsed leniently (§2: absent capabilities
//!     = gateway-only, `lookup: false`).
//!   - the `stats_cache_autodiscover` command (§6.1): subscribe the
//!     official `GET /api/peers` broadcast list, keep the lookup-capable
//!     rows, verify the top entries by probing, answer the verified roots.
//!     Result cached in memory 6 h; the transport hook appends the cached
//!     list AFTER the user's own servers (never before, §6.1).
//!
//! Server roots come from `NetworkConfig` (network.rs) — https-only with
//! the loopback plain-http exception, sanitized like the mirror ladders.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde::Deserialize;

use wowsp_tauri_shared::{
    CacheNodeHealthDoc, CapabilitiesDoc, CommandResult, OFFICIAL_CACHE_SERVER_URL,
    StatsCacheProbeRow,
};

use crate::commands::network::HttpPair;

/// `GET /api/health` probe budget (§6.3). The document is tiny and
/// edge-cached — same class the gateway health fetch allows.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// A health body beyond this is not ours (gateway health parity).
const PROBE_MAX_BYTES: usize = 64 * 1024;

/// `GET /api/peers` budget (§5.1: cache-control max-age=60, CORS-open).
const PEERS_TIMEOUT: Duration = Duration::from_secs(6);
/// A peers body beyond this is not a broadcast list.
const PEERS_MAX_BYTES: usize = 256 * 1024;
/// How many community candidates autodiscover verifies (§6.1: "probes the
/// top entries and uses up to 3 verified community nodes").
const AUTODISCOVER_PROBE_TOP: usize = 3;
/// How long an autodiscovered list stays fresh (§6.1 "periodically
/// subscribes" — hours-scale, so the official node is never hammered).
const AUTODISCOVER_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Floor between background refresh kicks: an empty result (no community
/// nodes — a legitimate state) must not re-kick a walk on every request.
const AUTODISCOVER_KICK_FLOOR: Duration = Duration::from_secs(10 * 60);

/// The §6.2 transport-hook budget per cache-server attempt.
pub(crate) const LOOKUP_BUDGET: Duration = Duration::from_secs(6);
/// §3.1: a POST forwards its body verbatim only up to 8 KiB — anything
/// larger (or streaming, unreadable for re-encoding) skips the mesh and
/// rides the direct chain.
pub(crate) const LOOKUP_BODY_MAX_BYTES: usize = 8 * 1024;

// ── probe (§6.3) ─────────────────────────────────────────────────────────────

/// Probe ONE server root: `GET {root}/api/health` through the
/// proxy→direct chain, parse the manifest leniently. Never fails — every
/// failure shape lands in its row (the github_mirror_probe pattern).
pub(crate) async fn probe_server(pair: &HttpPair, root: &str) -> StatsCacheProbeRow {
    let url = format!("{root}/api/health");
    let host = super::upstream_health::host_of_url(&url).to_string();
    let started = Instant::now();
    let sent =
        super::upstream_health::send_proxy_direct_chain(pair, &host, "cache-probe", |client| {
            client
                .get(&url)
                .header(reqwest::header::CACHE_CONTROL, "no-store")
                .timeout(PROBE_TIMEOUT)
        })
        .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let row = |error: Option<String>| StatsCacheProbeRow {
        url: root.to_string(),
        ok: error.is_none(),
        latency_ms,
        capabilities: None,
        error,
    };
    match sent {
        Err(e) => row(Some(format!("{e}"))),
        Ok(resp) if !resp.status().is_success() => {
            row(Some(format!("unexpected status {}", resp.status())))
        },
        Ok(resp) => match resp.bytes().await {
            Err(e) => row(Some(format!("body read: {e}"))),
            Ok(body) if body.len() > PROBE_MAX_BYTES => {
                row(Some("health document too large".into()))
            },
            Ok(body) => match serde_json::from_slice::<CacheNodeHealthDoc>(&body) {
                Err(e) => row(Some(format!("health parse: {e}"))),
                Ok(doc) => StatsCacheProbeRow {
                    url: root.to_string(),
                    ok: true,
                    latency_ms,
                    // §2: an alive node without a capabilities object is an
                    // old deployment / foreign 200 — gateway-only, spelled
                    // out as lookup=false instead of a null block so the
                    // settings pane renders one shape.
                    capabilities: Some(doc.capabilities.unwrap_or(CapabilitiesDoc {
                        gateway: true,
                        lookup: false,
                        peers: false,
                        blocks: false,
                    })),
                    error: None,
                },
            },
        },
    }
}

/// `#[tauri::command]`: reachability probe over the cache-server ladder.
/// Default rows = the configured servers; an explicit list probes exactly
/// those roots (the pane's "test all" sends its visible rows, saved or
/// not). All probes run concurrently so one dead root cannot stretch the
/// wait past a single timeout; the command itself never fails — every
/// failure lands in its row.
#[tauri::command]
pub async fn stats_cache_probe(
    urls: Option<Vec<String>>,
) -> CommandResult<Vec<StatsCacheProbeRow>> {
    // Rows echo the roots verbatim — the pane folds pills by url key, so a
    // normalized-but-different string would orphan them. Values from the
    // config are already sanitized; an invalid draft root simply probes
    // its own failure.
    let targets: Vec<String> = match urls {
        Some(list) => {
            let mut seen: Vec<String> = Vec::with_capacity(list.len());
            for root in list {
                let trimmed = root.trim().trim_end_matches('/').to_string();
                if !trimmed.is_empty() && !seen.iter().any(|s| s.eq_ignore_ascii_case(&trimmed)) {
                    seen.push(trimmed);
                }
            }
            seen
        },
        None => super::network::load_config().stats_cache_servers,
    };
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let pair = HttpPair::build(|b| b)?;
    Ok(futures::future::join_all(targets.iter().map(|root| {
        let pair = &pair;
        async move { probe_server(pair, root).await }
    }))
    .await)
}

// ── autodiscover (§6.1, §5.1) ────────────────────────────────────────────────

/// `GET /api/peers` broadcast list (§5.1) — rows kept as raw values and
/// parsed PER-ROW leniently below: one malformed entry in a list this
/// client never writes must not zero the whole walk.
#[derive(Deserialize)]
struct PeersDoc {
    #[serde(default)]
    peers: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct PeerRow {
    url: String,
    #[serde(default)]
    capabilities: Option<CapabilitiesDoc>,
}

/// In-memory autodiscovery state: the verified roots, when they were
/// fetched, and when a refresh was last ATTEMPTED. The transport hook
/// reads this from the request path — it must never block on the network,
/// so refreshes are kicked in the background and rate-limited by
/// [`AUTODISCOVER_KICK_FLOOR`] alone (no in-flight flag: a spawned walk
/// that panics or dies with the runtime simply never stores, and the
/// floor's expiry re-arms the next kick — the state self-heals).
struct AutodiscoverState {
    urls: Vec<String>,
    fetched_at: Option<Instant>,
    attempt_at: Option<Instant>,
}

static AUTODISCOVERED: LazyLock<std::sync::Mutex<AutodiscoverState>> = LazyLock::new(|| {
    std::sync::Mutex::new(AutodiscoverState {
        urls: Vec::new(),
        fetched_at: None,
        attempt_at: None,
    })
});

/// Publish a discovery result: non-empty walks advance the 6 h stamp;
/// empty walks (nothing found, or the walk itself failed) leave the
/// previous list in place instead of pinning an empty one for hours.
fn store_autodiscovered(urls: Vec<String>) {
    let mut state = AUTODISCOVERED.lock().unwrap_or_else(|p| p.into_inner());
    if !urls.is_empty() {
        state.fetched_at = Some(Instant::now());
        state.urls = urls;
    }
}

/// The autodiscovered community roots the transport hook appends AFTER
/// the user's own list (§6.1). Cache-served only — when the cache is
/// stale a best-effort background refresh is kicked (rate-limited by
/// [`AUTODISCOVER_KICK_FLOOR`], and only where a tokio runtime exists,
/// so unit tests calling the pure planning helpers never spawn).
pub(crate) fn autodiscovered_servers() -> Vec<String> {
    let (urls, kick) = {
        let mut state = AUTODISCOVERED.lock().unwrap_or_else(|p| p.into_inner());
        let stale = state
            .fetched_at
            .is_none_or(|at| at.elapsed() >= AUTODISCOVER_TTL);
        let recent_attempt = state
            .attempt_at
            .is_some_and(|at| at.elapsed() < AUTODISCOVER_KICK_FLOOR);
        let kick = stale && !recent_attempt;
        if kick {
            state.attempt_at = Some(Instant::now());
        }
        (state.urls.clone(), kick)
    };
    if kick && tokio::runtime::Handle::try_current().is_ok() {
        tracing::debug!("cache mesh: autodiscover cache stale — kicking a background refresh");
        tokio::spawn(async move {
            match HttpPair::build(|b| b) {
                Ok(pair) => store_autodiscovered(discover_mesh_servers(&pair).await),
                Err(e) => {
                    tracing::debug!(error = %e, "cache mesh: background autodiscover client build failed");
                },
            }
        });
    }
    urls
}

/// One live walk (§6.1): subscribe the official broadcast list
/// (`GET {OFFICIAL_CACHE_SERVER_URL}/api/peers`), keep the
/// lookup-capable rows, verify the top entries with the health probe,
/// answer the verified roots in list order.
async fn discover_mesh_servers(pair: &HttpPair) -> Vec<String> {
    let url = format!("{OFFICIAL_CACHE_SERVER_URL}/api/peers");
    let host = super::upstream_health::host_of_url(&url).to_string();
    let sent = tokio::time::timeout(
        PEERS_TIMEOUT,
        super::upstream_health::send_proxy_direct_chain(pair, &host, "cache-peers", |client| {
            client.get(&url).timeout(PEERS_TIMEOUT)
        }),
    )
    .await;
    let resp = match sent {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "cache mesh: peers list fetch failed");
            return Vec::new();
        },
        Err(_) => {
            tracing::debug!("cache mesh: peers list fetch timed out");
            return Vec::new();
        },
    };
    if !resp.status().is_success() {
        tracing::debug!(
            status = resp.status().as_u16(),
            "cache mesh: peers list non-2xx"
        );
        return Vec::new();
    }
    let body = match resp.bytes().await {
        Ok(body) => body,
        Err(e) => {
            tracing::debug!(error = %e, "cache mesh: peers list body read failed");
            return Vec::new();
        },
    };
    if body.len() > PEERS_MAX_BYTES {
        return Vec::new();
    }
    let doc = match serde_json::from_slice::<PeersDoc>(&body) {
        Ok(doc) => doc,
        Err(e) => {
            tracing::debug!(error = %e, "cache mesh: peers list parse failed");
            return Vec::new();
        },
    };
    // Capability filter (§6.1): only lookup nodes serve stats; dedupe in
    // list order (the official node's ordering is its own ranking). Rows
    // that fail to parse (or carry no usable url) are skipped, not fatal.
    let mut candidates: Vec<String> = Vec::new();
    for raw in doc.peers {
        let Ok(peer) = serde_json::from_value::<PeerRow>(raw) else {
            continue;
        };
        // Same URL policy the config ladder holds (§6.1): bare hosts gain
        // https://, plain http survives only on loopback — a broadcast row
        // must not smuggle a weaker root past the sanitize the user's own
        // list goes through.
        let Ok(root) = super::gateway::urls::normalize_https_root(&peer.url) else {
            continue;
        };
        if !peer
            .capabilities
            .is_some_and(|capabilities| capabilities.lookup)
        {
            continue;
        }
        if !candidates.iter().any(|c| c.eq_ignore_ascii_case(&root)) {
            candidates.push(root);
        }
    }
    if candidates.is_empty() {
        return Vec::new();
    }
    // Verify the top entries: the broadcast row may be stale, the health
    // probe is the live truth (a node that dropped lookup since is cut).
    let verified = futures::future::join_all(
        candidates
            .iter()
            .take(AUTODISCOVER_PROBE_TOP)
            .map(|root| async move { probe_server(pair, root).await }),
    )
    .await;
    verified
        .into_iter()
        .filter(|row| row.ok && row.capabilities.is_some_and(|c| c.lookup))
        .map(|row| row.url)
        .collect()
}

/// `#[tauri::command]`: discover community cache nodes now — subscribe
/// the official broadcast list, verify the top lookup-capable candidates,
/// answer the verified roots (a list-only PREVIEW: nothing is auto-added
/// to the user's config; the transport hook appends the cached list on
/// its own while `stats_peer_autodiscover` is on). A fresh 6 h cache
/// answers without a network walk.
#[tauri::command]
pub async fn stats_cache_autodiscover() -> CommandResult<Vec<String>> {
    {
        let mut state = AUTODISCOVERED.lock().unwrap_or_else(|p| p.into_inner());
        let fresh = state
            .fetched_at
            .is_some_and(|at| at.elapsed() < AUTODISCOVER_TTL);
        if fresh && !state.urls.is_empty() {
            return Ok(state.urls.clone());
        }
        state.attempt_at = Some(Instant::now());
    }
    let pair = HttpPair::build(|b| b)?;
    let urls = discover_mesh_servers(&pair).await;
    store_autodiscovered(urls.clone());
    Ok(urls)
}

// ── transport hook (§6.2) ────────────────────────────────────────────────────

/// The §6.2 hook `upstream_health::send_with_fallback` calls BEFORE its
/// proxy→direct chain. Inspects the request the caller's `build` closure
/// produces (method + full URL + a buffered POST body); when the URL is
/// an allowlisted stats URL (§3.2) and the mesh is on, walks the ordered
/// server list. `Some(response)` = a cache server answered 2xx and the
/// response returns as-if-upstream (the node passes the original
/// content-type through, §3.4); `None` = not the hook's business (or
/// every server missed) and the caller's chain runs unchanged.
pub(crate) async fn send_via_cache_mesh(
    pair: &HttpPair,
    host: &str,
    label: &str,
    build: &impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
) -> Option<reqwest::Response> {
    // Cheap pre-gate on the host param (no I/O, no request build): only
    // stats-family traffic ever reaches the inspection below.
    if !super::upstream_health::is_stats_host(host) {
        return None;
    }
    // Build the request ONCE against the direct twin purely to inspect it
    // — the real chain re-runs `build` itself (the replayable rule).
    let inspect = build(pair.direct()).build().ok()?;
    let url = inspect.url().to_string();
    let (servers, encoded_url) = super::upstream_health::stats_cache_lookup_target(&url)?;
    let method = inspect.method().clone();
    // §3.1 mirrors GET|POST only; a streaming body (unreadable bytes) or
    // one past the 8 KiB forward cap skips the mesh.
    if method != reqwest::Method::GET && method != reqwest::Method::POST {
        return None;
    }
    let has_body = inspect.body().is_some();
    let body = inspect
        .body()
        .as_ref()
        .and_then(|body| body.as_bytes())
        .map(<[u8]>::to_vec);
    // A PRESENT body we cannot read back (a stream, not buffered bytes)
    // must never be re-sent empty — the mesh would answer a different
    // request. Skip it (§3.1 forwards bodies verbatim).
    if has_body && body.is_none() {
        return None;
    }
    if body
        .as_ref()
        .is_some_and(|bytes| bytes.len() > LOOKUP_BODY_MAX_BYTES)
    {
        return None;
    }
    let content_type = inspect
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned();
    let plan = LookupPlan {
        servers: &servers,
        encoded_url: &encoded_url,
        method: &method,
        body: body.as_deref(),
        content_type: content_type.as_ref(),
    };
    lookup_via_servers(pair, host, label, &plan).await
}

/// The §6.2 walk's inputs — the ordered server roots plus everything the
/// re-built `{server}/api/lookup/fetch?url=…` request needs to mirror
/// the original (method, buffered body ≤ 8 KiB, content-type).
pub(crate) struct LookupPlan<'a> {
    servers: &'a [String],
    encoded_url: &'a str,
    method: &'a reqwest::Method,
    body: Option<&'a [u8]>,
    content_type: Option<&'a reqwest::header::HeaderValue>,
}

/// The §6.2 walk proper — testable core with the plan injected (the live
/// path derives it from the config). For each server in order:
/// `GET|POST {server}/api/lookup/fetch?url=…` through the PLAIN
/// proxy→direct chain (never the hooked one — a server root that is
/// itself a stats host must not re-enter the mesh), 6 s budget per
/// attempt; the first 2xx returns carrying the §3.4 provenance header
/// (force-set when a non-conformant node omitted it, so upstream-health
/// accounting can always tell a mesh-served row from an upstream one).
pub(crate) async fn lookup_via_servers(
    pair: &HttpPair,
    host: &str,
    label: &str,
    plan: &LookupPlan<'_>,
) -> Option<reqwest::Response> {
    for server in plan.servers {
        let fetch_url = format!("{server}/api/lookup/fetch?url={}", plan.encoded_url);
        let server_host = super::upstream_health::host_of_url(server).to_string();
        let attempt = tokio::time::timeout(
            LOOKUP_BUDGET,
            super::upstream_health::send_proxy_direct_chain(pair, &server_host, label, |client| {
                let request = if *plan.method == reqwest::Method::POST {
                    client.post(&fetch_url)
                } else {
                    client.get(&fetch_url)
                };
                let request = match plan.body {
                    Some(bytes) => request.body(bytes.to_vec()),
                    None => request,
                };
                let request = match plan.content_type {
                    Some(value) => request.header(reqwest::header::CONTENT_TYPE, value.clone()),
                    None => request,
                };
                request.timeout(LOOKUP_BUDGET)
            }),
        )
        .await;
        match attempt {
            Ok(Ok(resp)) if resp.status().is_success() => {
                tracing::debug!(server, host, label, "cache mesh served the lookup");
                let mut resp = resp;
                if !resp
                    .headers()
                    .contains_key(reqwest::header::HeaderName::from_static("x-wowsp-cache"))
                {
                    resp.headers_mut().insert(
                        reqwest::header::HeaderName::from_static("x-wowsp-cache"),
                        reqwest::header::HeaderValue::from_static("hit"),
                    );
                }
                return Some(resp);
            },
            Ok(Ok(resp)) => tracing::debug!(
                server,
                host,
                label,
                status = resp.status().as_u16(),
                "cache server answered non-2xx — next server"
            ),
            Ok(Err(e)) => {
                tracing::debug!(server, host, label, error = %e, "cache server transport failed — next server")
            },
            Err(_) => tracing::debug!(server, host, label, "cache server timed out — next server"),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal HTTP/1.1 stub with request capture: answers `len`
    /// sequential connections with the given status/body, recording each
    /// request line + body so the tests can assert what the mesh actually
    /// sent (the percent-encoded `?url=`, the forwarded POST bytes).
    fn capturing_stub(
        len: usize,
        status: &'static str,
        content_type: &'static str,
        body: &'static str,
    ) -> (
        std::net::SocketAddr,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("stub bind");
        let addr = listener.local_addr().expect("stub addr");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_thread = seen.clone();
        let handle = std::thread::spawn(move || {
            for _ in 0..len {
                let (mut stream, _) = listener.accept().expect("stub accept");
                let mut buf = [0u8; 8192];
                let read = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
                let text = String::from_utf8_lossy(&buf[..read]).to_string();
                seen_thread
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(text);
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });
        (addr, seen, handle)
    }

    fn stub_pair() -> HttpPair {
        HttpPair::from_clients(
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("healthy"),
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("direct"),
            false,
        )
    }

    /// A cache hit returns the node's 2xx body as-if-upstream, carrying
    /// the §3.4 provenance header (force-set here — the stub does not
    /// send one), and the request hit the contract route with the
    /// percent-encoded upstream URL in the `?url=` slot.
    #[tokio::test]
    async fn lookup_hits_the_contract_route_and_marks_provenance() {
        let (addr, seen, server) = capturing_stub(1, "200 OK", "application/json", "{\"ok\":true}");
        let pair = stub_pair();
        let servers = vec![format!("http://{addr}")];
        let plan = LookupPlan {
            servers: &servers,
            encoded_url: "https%3A%2F%2Fvortex.wowsgame.cn%2Fapi%2Faccounts%2Fsearch%2Fx%2F%3Flimit%3D10",
            method: &reqwest::Method::GET,
            body: None,
            content_type: None,
        };
        let resp = lookup_via_servers(&pair, "vortex.wowsgame.cn", "probe", &plan)
            .await
            .expect("the stub cache server serves the lookup");
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("x-wowsp-cache")
                .and_then(|v| v.to_str().ok()),
            Some("hit"),
            "a mesh-served row always carries the provenance header"
        );
        assert_eq!(
            resp.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        let requests = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0].starts_with(
                "GET /api/lookup/fetch?url=https%3A%2F%2Fvortex.wowsgame.cn%2Fapi%2Faccounts%2Fsearch%2Fx%2F%3Flimit%3D10 "
            ),
            "the request rode the contract route with the encoded url: {}",
            requests[0]
        );
        server.join().expect("stub served");
    }

    /// A POST forwards its buffered body verbatim (§3.1) with the original
    /// content-type, and the response keeps the node's own provenance
    /// spelling (here sent by the stub — not overwritten).
    #[tokio::test]
    async fn lookup_forwards_post_body_and_content_type() {
        let (addr, seen, server) = capturing_stub(1, "200 OK", "application/json", "[]");
        let pair = stub_pair();
        let payload = br#"{"search":"name"}"#;
        let content_type = reqwest::header::HeaderValue::from_static("application/json");
        let servers = [format!("http://{addr}")];
        let plan = LookupPlan {
            servers: &servers,
            encoded_url: "https%3A%2F%2Fapi.korabli.su%2Fwows%2Faccount%2Flist%2F",
            method: &reqwest::Method::POST,
            body: Some(payload),
            content_type: Some(&content_type),
        };
        let resp = lookup_via_servers(&pair, "api.korabli.su", "probe", &plan)
            .await
            .expect("the stub serves the POST lookup");
        assert_eq!(resp.status(), 200);
        let requests = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0].starts_with("POST /api/lookup/fetch?url="),
            "{}",
            requests[0]
        );
        assert!(
            requests[0].contains("content-type: application/json"),
            "{}",
            requests[0]
        );
        assert!(
            requests[0].ends_with(r#"{"search":"name"}"#),
            "the body forwarded verbatim: {}",
            requests[0]
        );
        server.join().expect("stub served");
    }

    /// §6.2 fall-through: a non-2xx answer moves to the NEXT server, and
    /// only when every server missed does the hook hand the request back
    /// to the caller's chain (None).
    #[tokio::test]
    async fn lookup_falls_through_non_2xx_to_the_next_server() {
        // One dead port (connection refused) + one 502 stub + one 200 stub:
        // the walk must survive both failure shapes and land on the third.
        // ONE connection: walk1's live attempt lands here exactly once
        // (the dead root never connects; walk2's success hits its own
        // stub) — a second accept() would block the join below forever.
        let (addr, seen, server) = capturing_stub(1, "502 Bad Gateway", "application/json", "{}");
        let dead_root = "http://127.0.0.1:9".to_string();
        let servers = vec![dead_root.clone(), format!("http://{addr}")];
        let pair = stub_pair();
        let plan = LookupPlan {
            servers: &servers,
            encoded_url: "https%3A%2F%2Fclans.wowsgame.cn%2Fapi%2Fclan%2Fbattle%2F",
            method: &reqwest::Method::GET,
            body: None,
            content_type: None,
        };
        let resp = lookup_via_servers(&pair, "clans.wowsgame.cn", "probe", &plan).await;
        assert!(
            resp.is_none(),
            "both live attempts answered 502 → fall through"
        );
        drop(plan);
        drop(servers);
        server.join().expect("stub served");
        assert_eq!(
            seen.lock().unwrap_or_else(|p| p.into_inner()).len(),
            1,
            "the dead root was skipped, the live attempt answered 502"
        );

        // The same walk with a 200 at the end of the ladder succeeds.
        let (ok_addr, ok_seen, ok_server) = capturing_stub(1, "200 OK", "application/json", "{}");
        let ok_servers = vec![dead_root, format!("http://{ok_addr}")];
        let ok_plan = LookupPlan {
            servers: &ok_servers,
            encoded_url: "https%3A%2F%2Fclans.wowsgame.cn%2Fapi%2Fclan%2Fbattle%2F",
            method: &reqwest::Method::GET,
            body: None,
            content_type: None,
        };
        let resp = lookup_via_servers(&pair, "clans.wowsgame.cn", "probe", &ok_plan)
            .await
            .expect("the 200 server at the end serves the lookup");
        assert_eq!(resp.status(), 200);
        assert_eq!(ok_seen.lock().unwrap_or_else(|p| p.into_inner()).len(), 1);
        ok_server.join().expect("stub served");
    }

    /// An empty server list is a no-op (the hook hands the request back).
    #[tokio::test]
    async fn lookup_with_no_servers_is_none() {
        let pair = stub_pair();
        let empty: [String; 0] = [];
        let plan = LookupPlan {
            servers: &empty,
            encoded_url: "https%3A%2F%2Fvortex.wowsgame.cn%2F",
            method: &reqwest::Method::GET,
            body: None,
            content_type: None,
        };
        assert!(
            lookup_via_servers(&pair, "vortex.wowsgame.cn", "probe", &plan)
                .await
                .is_none()
        );
    }

    /// The probe core folds every failure shape into its row — an
    /// unreachable root reports ok=false with the error text, never a
    /// command failure.
    #[tokio::test]
    async fn probe_row_reports_an_unreachable_root() {
        let pair = stub_pair();
        let row = probe_server(&pair, "http://127.0.0.1:9").await;
        assert_eq!(row.url, "http://127.0.0.1:9");
        assert!(!row.ok);
        assert!(row.error.is_some());
        assert_eq!(row.capabilities, None);
    }

    /// The probe parses a full §2 manifest with capabilities.
    #[tokio::test]
    async fn probe_row_parses_the_health_manifest() {
        let (addr, _seen, server) = capturing_stub(
            1,
            "200 OK",
            "application/json",
            r#"{"ok":true,"name":"WoWSP Gateway","version":"0.5.0","capabilities":{"gateway":true,"lookup":true,"peers":true,"blocks":true}}"#,
        );
        let pair = stub_pair();
        let row = probe_server(&pair, &format!("http://{addr}")).await;
        assert!(row.ok, "error: {:?}", row.error);
        assert_eq!(
            row.capabilities,
            Some(CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true
            })
        );
        server.join().expect("stub served");
    }

    /// The probe treats a capabilities-less manifest as gateway-only
    /// (§2): the row is ok (the node IS alive) with lookup=false spelled
    /// out — never a null block.
    #[tokio::test]
    async fn probe_row_spells_gateway_only_as_lookup_false() {
        let (addr, _seen, server) = capturing_stub(
            1,
            "200 OK",
            "application/json",
            r#"{"ok":true,"name":"Old Gateway","version":"0.1.0"}"#,
        );
        let pair = stub_pair();
        let row = probe_server(&pair, &format!("http://{addr}")).await;
        assert!(row.ok);
        assert_eq!(
            row.capabilities,
            Some(CapabilitiesDoc {
                gateway: true,
                lookup: false,
                peers: false,
                blocks: false
            })
        );
        server.join().expect("stub served");
    }
}
