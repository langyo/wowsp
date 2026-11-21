//! End-to-end integration tests: the real router on a loopback
//! listener, a mock allowlisted upstream, a second server instance for
//! the peers handshake, and a real WebSocket round trip through the
//! battle-push namespace. The wire expectations come from
//! docs/en/designs/cache-mesh.md (the contract).

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use relay_server::config::Config;
use relay_server::state::AppState;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

// ── harness ────────────────────────────────────────────────────────────

struct Server {
    addr: std::net::SocketAddr,
    #[allow(dead_code)]
    dir: tempfile::TempDir,
    app: Arc<AppState>,
    handle: tokio::task::JoinHandle<()>,
    client: reqwest::Client,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Bind :0, serve the full router. `extra` mutates the config before
/// init (overrides, upstreams, …).
async fn spawn_server(mut extra: impl FnMut(&mut Config)) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::default();
    cfg.data_dir = dir.path().to_path_buf();
    cfg.peers_upstream = "http://127.0.0.1:1".into(); // unreachable by default
    extra(&mut cfg);
    let app = AppState::init(cfg).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = relay_server::build_router(app.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    Server {
        addr,
        dir,
        app,
        handle,
        client: reqwest::Client::new(),
    }
}

fn url(s: &Server, path: &str) -> String {
    format!("http://{}/{}", s.addr, path)
}

/// A mock upstream standing in for an allowlisted host (the
/// UPSTREAM_OVERRIDE seam — test-only by design, see README).
async fn spawn_mock_upstream() -> (std::net::SocketAddr, Arc<std::sync::Mutex<Vec<String>>>) {
    let hits: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let hits_get = hits.clone();
    let hits_post = hits.clone();
    let app = axum::Router::new()
        .route(
            "/api/accounts/{id}",
            axum::routing::get(
                move |axum::extract::Path(id): axum::extract::Path<String>| {
                    let hits = hits_get.clone();
                    async move {
                        hits.lock().unwrap().push(format!("GET /api/accounts/{id}"));
                        (
                            [(axum::http::header::CONTENT_TYPE, "application/json")],
                            format!(r#"{{"id":"{id}","hidden":false}}"#),
                        )
                    }
                },
            ),
        )
        .route(
            "/api/accounts/search/{q}",
            axum::routing::post(move |body: String| {
                let hits = hits_post.clone();
                async move {
                    hits.lock()
                        .unwrap()
                        .push(format!("POST /api/accounts/search {body}"));
                    (
                        [(axum::http::header::CONTENT_TYPE, "application/json")],
                        format!(r#"{{"echo":{body}}}"#),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, hits)
}

// ── health + capabilities ──────────────────────────────────────────────

#[tokio::test]
async fn health_carries_capabilities_and_node_doc() {
    let s = spawn_server(|cfg| {
        cfg.public_url = Some("https://wowsp.example.org".into());
        cfg.notice = Some("integration".into());
    })
    .await;
    let resp = s.client.get(url(&s, "api/health")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("cache-control").unwrap(),
        "no-store",
        "health never caches"
    );
    let doc: Value = resp.json().await.unwrap();
    assert_eq!(doc["ok"], true);
    assert_eq!(doc["provider"], "wowsp-gateway");
    assert_eq!(doc["notice"], "integration");
    assert_eq!(doc["capabilities"]["gateway"], true);
    assert_eq!(doc["capabilities"]["lookup"], true);
    assert_eq!(doc["capabilities"]["peers"], true);
    assert_eq!(doc["capabilities"]["blocks"], true);
    assert_eq!(doc["node"]["role"], "community");
    assert_eq!(doc["node"]["sync"], true);
    assert_eq!(doc["node"]["peersUpstream"], "http://127.0.0.1:1");
    assert_eq!(doc["node"]["id"].as_str().unwrap().len(), 32);
    // /gateway/health answers the gateway namespace doc too.
    let resp = s
        .client
        .get(url(&s, "gateway/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let gdoc: Value = resp.json().await.unwrap();
    assert_eq!(gdoc["gateway"], "v1");
    assert_eq!(gdoc["auth"]["password"]["required"], false);
    // Maintainer-only namespaces stay 404.
    for path in ["api/digests/app", "api/feedback/submit", "api/sponsors"] {
        let resp = s.client.get(url(&s, path)).send().await.unwrap();
        assert_eq!(resp.status(), 404, "{path}");
    }
}

// ── lookup: miss → store → hit ─────────────────────────────────────────

#[tokio::test]
async fn lookup_miss_then_hit_with_headers_and_block_routes() {
    let (upstream_addr, hits) = spawn_mock_upstream().await;
    let s = spawn_server(|cfg| {
        cfg.upstream_override.insert(
            "vortex.wowsgame.cn".into(),
            format!("http://{upstream_addr}"),
        );
    })
    .await;

    let target = "https://vortex.wowsgame.cn/api/accounts/42";
    // First fetch: miss (provenance, age 0, vortex account TTL 120 s).
    let resp = s
        .client
        .get(url(&s, "api/lookup/fetch"))
        .query(&[("url", target)])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("x-wowsp-cache").unwrap(), "miss");
    assert_eq!(resp.headers().get("age").unwrap(), "0");
    assert_eq!(
        resp.headers().get("cache-control").unwrap(),
        "public, max-age=120",
        "vortex account paths cache 120 s (§3.3)"
    );
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json"
    );
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["id"], "42");
    assert_eq!(hits.lock().unwrap().len(), 1, "the mock upstream saw it");

    // Second fetch: a hit, same bytes, provenance headers.
    let resp = s
        .client
        .get(url(&s, "api/lookup/fetch"))
        .query(&[("url", target)])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("x-wowsp-cache").unwrap(), "hit");
    let age: u64 = resp
        .headers()
        .get("age")
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(age <= 120, "age is within the TTL");
    let body2: Value = resp.json().await.unwrap();
    assert_eq!(body2, body);
    assert_eq!(hits.lock().unwrap().len(), 1, "no second upstream call");

    // The block routes expose the SAME content under its CID
    // (relay-core's cache-key derivation — the seam module is gone).
    let cid = relay_core::lookup::cid_of_request("GET", target, None);
    let resp = s
        .client
        .get(url(&s, &format!("api/blocks/{cid}")))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let env: Value = resp.json().await.unwrap();
    assert_eq!(env["v"], 1);
    assert_eq!(env["status"], 200);
    assert_eq!(env["upstream"], "vortex.wowsgame.cn");
    assert_eq!(env["ttl"], 120);
    assert!(env["bodyB64"].as_str().is_some_and(|b| !b.is_empty()));

    // /raw decodes the body bytes with the stored content type…
    let resp = s
        .client
        .get(url(&s, &format!("api/blocks/{cid}/raw")))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/json"
    );
    let text = resp.text().await.unwrap();
    assert!(text.contains(r#""id":"42""#), "{text}");

    // …and /ipfs/<cid> is the alias of /raw (§4.2).
    let resp = s
        .client
        .get(url(&s, &format!("ipfs/{cid}")))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert!(resp.text().await.unwrap().contains(r#""id":"42""#));

    // Unknown CIDs 404.
    let resp = s
        .client
        .get(url(&s, "api/blocks/bafywrong"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);

    // A POST forwards the body verbatim and keys the cache by it.
    let resp = s
        .client
        .post(url(&s, "api/lookup/fetch"))
        .query(&[("url", "https://vortex.wowsgame.cn/api/accounts/search/abc")])
        .header("content-type", "application/json")
        .body(r#"{"q":"abc"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("x-wowsp-cache").unwrap(), "miss");
    assert_eq!(
        resp.headers().get("cache-control").unwrap(),
        "public, max-age=600",
        "vortex account-search paths cache 600 s (§3.3)"
    );
    let echoed: Value = resp.json().await.unwrap();
    assert_eq!(echoed["echo"], json!({"q": "abc"}));
    // Same body again → hit; a different body → a different CID → miss.
    let r2 = s
        .client
        .post(url(&s, "api/lookup/fetch"))
        .query(&[("url", "https://vortex.wowsgame.cn/api/accounts/search/abc")])
        .body(r#"{"q":"abc"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(r2.headers().get("x-wowsp-cache").unwrap(), "hit");
    let r3 = s
        .client
        .post(url(&s, "api/lookup/fetch"))
        .query(&[("url", "https://vortex.wowsgame.cn/api/accounts/search/abc")])
        .body(r#"{"q":"xyz"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(r3.headers().get("x-wowsp-cache").unwrap(), "miss");
}

#[tokio::test]
async fn lookup_refuses_non_allowlisted_hosts() {
    let s = spawn_server(|_| {}).await;
    for bad in [
        "https://evil.example.org/api",
        "http://vortex.wowsgame.cn/api",      // not https
        "https://sub.vortex.wowsgame.cn/api", // not the exact host
        "https://api.github.com/repos",       // content host, not stats
        "https://127.0.0.1:8788/x",           // IP literal
    ] {
        let resp = s
            .client
            .get(url(&s, "api/lookup/fetch"))
            .query(&[("url", bad)])
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403, "{bad}");
        let v: Value = resp.json().await.unwrap();
        assert_eq!(v["error"], "forbidden_host", "{bad}");
    }
    // Missing url → 400.
    let resp = s
        .client
        .get(url(&s, "api/lookup/fetch"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn lookup_rate_limit_trips_with_retry_after() {
    let (upstream_addr, _hits) = spawn_mock_upstream().await;
    let s = spawn_server(|cfg| {
        cfg.lookup_rate_per_hour = 3;
        cfg.upstream_override.insert(
            "vortex.wowsgame.cn".into(),
            format!("http://{upstream_addr}"),
        );
    })
    .await;
    for n in 0..3 {
        let resp = s
            .client
            .get(url(&s, "api/lookup/fetch"))
            .query(&[(
                "url",
                &format!("https://vortex.wowsgame.cn/api/accounts/{n}"),
            )])
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200, "request {n} fits the budget");
    }
    let resp = s
        .client
        .get(url(&s, "api/lookup/fetch"))
        .query(&[("url", "https://vortex.wowsgame.cn/api/accounts/3")])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 429);
    assert!(resp.headers().get("retry-after").is_some());
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v["error"], "rate_limited");
}

// ── peers: announce + list merge ───────────────────────────────────────

#[tokio::test]
async fn peers_announce_liveness_then_list_and_etag() {
    // B is the announce target (its /api/health is the liveness probe).
    let b = spawn_server(|_| {}).await;
    // A accepts the announce; its peersUpstream points at B so the
    // upstream-merge half is exercised too (B lists nothing public).
    let a = spawn_server(|cfg| {
        cfg.peers_upstream = format!("http://{}/", b.addr);
        // The public-shape URL resolves to B through the override seam.
        cfg.upstream_override
            .insert("mesh-test.example".into(), format!("http://{}/", b.addr));
    })
    .await;

    // A public-shape announce: https + name, liveness via the override.
    let resp = a
        .client
        .post(url(&a, "api/peers/announce"))
        .json(&json!({ "url": "https://mesh-test.example", "contact": "ops" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["listed"], true, "live wowsp node with a public URL lists");

    // It appears in the list with B's capabilities + node id.
    let resp = a.client.get(url(&a, "api/peers")).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("cache-control").unwrap(),
        "public, max-age=60"
    );
    let etag = resp.headers().get("etag").cloned().unwrap();
    // relay-core's weak etag (content-only hash, §5.1).
    assert!(etag.to_str().unwrap().starts_with("W/\""));
    let list: Value = resp.json().await.unwrap();
    assert_eq!(list["v"], 1);
    let peers = list["peers"].as_array().unwrap();
    let entry = peers
        .iter()
        .find(|p| p["url"] == "https://mesh-test.example")
        .expect("announced peer is listed");
    assert_eq!(entry["capabilities"]["lookup"], true);
    assert_eq!(entry["role"], "community");
    assert_eq!(entry["nodeId"], b.app.node_id);
    assert!(entry["addedAt"].as_i64().is_some());

    // If-None-Match with the strong etag → 304, no body.
    let resp = a
        .client
        .get(url(&a, "api/peers"))
        .header(reqwest::header::IF_NONE_MATCH, etag)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 304);

    // An http URL (a LAN node) is accepted but listed:false (§5.3).
    let resp = a
        .client
        .post(url(&a, "api/peers/announce"))
        .json(&json!({ "url": format!("http://{}/", b.addr) }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v["listed"], false);
    assert_eq!(v["reason"], "private_url");

    // An unreachable node is best-effort refused listing (200, no error).
    let resp = a
        .client
        .post(url(&a, "api/peers/announce"))
        .json(&json!({ "url": "https://dead.example" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v["listed"], false);
    assert_eq!(v["reason"], "unreachable");

    // And with announces disabled the endpoint 403s (§5.2 step 5).
    let c = spawn_server(|cfg| {
        cfg.peers_accept_announces = false;
    })
    .await;
    let resp = c
        .client
        .post(url(&c, "api/peers/announce"))
        .json(&json!({ "url": "https://mesh-test.example" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);
}

// ── gateway: session → pub/sub round trip ──────────────────────────────

async fn ws_connect(
    s: &Server,
    path: &str,
    query: &[(&str, &str)],
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let q: Vec<String> = query
        .iter()
        .map(|(k, v)| format!("{k}={}", v.replace(':', "%3A")))
        .collect();
    let ws_url = format!("ws://{}/{}?{}", s.addr, path, q.join("&"));
    let (stream, _resp) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    stream
}

async fn mint_ticket(s: &Server, route: &str) -> String {
    let resp = s
        .client
        .post(url(&s, "gateway/session"))
        .json(&json!({ "route": route }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "open node mints freely");
    let v: Value = resp.json().await.unwrap();
    v["ticket"].as_str().unwrap().to_string()
}

/// The next text frame, skipping keepalives.
async fn next_text<S>(ws: &mut S) -> String
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(msg) = ws.next().await {
        if let Ok(Message::Text(text)) = msg {
            let s = text.to_string();
            if s.contains(r#""keepalive""#) {
                continue;
            }
            return s;
        }
    }
    panic!("stream ended waiting for a text frame")
}

#[tokio::test]
async fn gateway_pub_sub_fanout_and_one_publisher_replacement() {
    let s = spawn_server(|_| {}).await;
    let route = "r:asia:42";

    // Session gate sanity first.
    let resp = s
        .client
        .post(url(&s, "gateway/session"))
        .body("{ not json")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    let pub1 = mint_ticket(&s, route).await;
    let sub_ticket = mint_ticket(&s, route).await;

    // Publisher connects: hello(role=pub) → subs(0).
    let mut host = ws_connect(
        &s,
        "gateway/pub",
        &[
            ("route", route),
            ("ticket", &pub1),
            ("hostId", "aa11223344556677"),
        ],
    )
    .await;
    let hello = next_text(&mut host).await;
    assert_eq!(hello, r#"{"type":"hello","gateway":"v1","role":"pub"}"#);
    let subs = next_text(&mut host).await;
    assert_eq!(subs, r#"{"type":"subs","online":0}"#);

    // Subscriber connects: hello → host online → (no snapshot yet).
    let mut phone = ws_connect(
        &s,
        "gateway/sub",
        &[("route", route), ("ticket", &sub_ticket)],
    )
    .await;
    let sub_hello = next_text(&mut phone).await;
    assert_eq!(sub_hello, r#"{"type":"hello","gateway":"v1","role":"sub"}"#);
    let host_up = next_text(&mut phone).await;
    assert_eq!(host_up, r#"{"type":"host","online":true}"#);
    // The publisher's count ticked to 1.
    let subs = next_text(&mut host).await;
    assert_eq!(subs, r#"{"type":"subs","online":1}"#);

    // A battle frame fans out verbatim (≤ 64 KiB).
    let battle = r#"{"type":"battle","route":"r:asia:42","vehicles":[]}"#;
    host.send(Message::Text(battle.into())).await.unwrap();
    let got = next_text(&mut phone).await;
    assert_eq!(got, battle, "fan-out is verbatim");

    // A cold subscriber joins mid-battle: hello → host up → snapshot.
    let sub2_ticket = mint_ticket(&s, route).await;
    let mut phone2 = ws_connect(
        &s,
        "gateway/sub",
        &[("route", route), ("ticket", &sub2_ticket)],
    )
    .await;
    assert_eq!(next_text(&mut phone2).await, sub_hello);
    assert_eq!(next_text(&mut phone2).await, host_up);
    let snapshot = next_text(&mut phone2).await;
    assert_eq!(snapshot, battle, "the retained snapshot is replayed");

    // One-publisher replacement: a second pub with a DIFFERENT hostId
    // takes the slot; the first socket closes 1000 "replaced".
    let pub2 = mint_ticket(&s, route).await;
    let mut host2 = ws_connect(
        &s,
        "gateway/pub",
        &[
            ("route", route),
            ("ticket", &pub2),
            ("hostId", "bb11223344556677"),
        ],
    )
    .await;
    assert_eq!(next_text(&mut host2).await, hello);
    // host1 sees the close frame with the contract's reason.
    loop {
        match host.next().await {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 1000);
                assert_eq!(frame.reason.as_str(), "replaced by a new host");
                break;
            },
            Some(Ok(Message::Text(t))) => {
                let t = t.to_string();
                assert!(
                    t.contains(r#""subs""#) || t.contains("keepalive"),
                    "only count chatter may precede the close: {t}"
                );
                continue;
            },
            other => panic!("expected close, got {other:?}"),
        }
    }
    // The new host's frames still fan out to the phones. The
    // replacement first rebroadcasts host-presence (online: true) to
    // every subscriber, then the battle frames flow.
    let battle2 = r#"{"type":"battle","route":"r:asia:42","seq":2}"#;
    host2.send(Message::Text(battle2.into())).await.unwrap();
    assert_eq!(next_text(&mut phone).await, host_up);
    assert_eq!(next_text(&mut phone).await, battle2);
    assert_eq!(next_text(&mut phone2).await, host_up);
    assert_eq!(next_text(&mut phone2).await, battle2);

    // bye ends the battle: fans out verbatim.
    host2
        .send(Message::Text(r#"{"type":"bye"}"#.into()))
        .await
        .unwrap();
    let bye = next_text(&mut phone).await;
    assert_eq!(bye, r#"{"type":"bye"}"#);
}

#[tokio::test]
async fn gateway_tickets_are_single_use_and_bound() {
    let s = spawn_server(|_| {}).await;
    let route = "r:eu:7";
    let ticket = mint_ticket(&s, route).await;

    // A bad route never gets a ticket.
    let resp = s
        .client
        .post(url(&s, "gateway/session"))
        .json(&json!({ "route": "nope" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // Spend the ticket on a sub upgrade…
    let mut ws = ws_connect(&s, "gateway/sub", &[("route", route), ("ticket", &ticket)]).await;
    let hello = next_text(&mut ws).await;
    assert!(hello.contains(r#"role":"sub"#));

    // …and the ticket is burnt: a second upgrade with it is refused
    // before the WS handshake (plain 401).
    let ws_url = format!(
        "ws://{}/gateway/sub?route={}&ticket={}",
        s.addr,
        route.replace(':', "%3A"),
        ticket
    );
    let err = tokio_tungstenite::connect_async(&ws_url).await.unwrap_err();
    assert!(
        matches!(
            &err,
            tokio_tungstenite::tungstenite::Error::Http(resp)
                if resp.status().as_u16() == 401
        ),
        "expected HTTP 401, got {err}"
    );
}

/// The SUBSCRIBER socket also gets server-side keepalive pings (the
/// review's HIGH finding — a silently-dead sub must be reaped, not
/// parked on one of the 32 seats). Short interval override so the ping
/// arrives within the test budget.
#[tokio::test]
async fn gateway_sub_receives_server_keepalives() {
    let s = spawn_server(|cfg| {
        cfg.keepalive_interval_ms = 300;
    })
    .await;
    let route = "r:sa:55";
    let ticket = mint_ticket(&s, route).await;
    let mut ws = ws_connect(&s, "gateway/sub", &[("route", route), ("ticket", &ticket)]).await;
    // Drain hello + host presence (keepalives skipped by next_text)…
    let _hello = next_text(&mut ws).await;
    let _host = next_text(&mut ws).await;
    // …then a raw read MUST observe the keepalive text frame within a
    // few interval ticks (the sub loop pings BOTH directions per
    // gateway-push.md).
    let ping = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) if text.to_string().contains("keepalive") => {
                    return text.to_string();
                },
                Some(Ok(_)) => continue,
                other => panic!("stream ended or errored before a keepalive: {other:?}"),
            }
        }
    })
    .await
    .expect("a keepalive frame arrived within 10 s");
    assert_eq!(ping, r#"{"type":"keepalive"}"#);
}

#[tokio::test]
async fn gateway_oversize_battle_frame_closes_1009() {
    let s = spawn_server(|_| {}).await;
    let route = "r:na:1";
    let ticket = mint_ticket(&s, route).await;
    let mut host = ws_connect(&s, "gateway/pub", &[("route", route), ("ticket", &ticket)]).await;
    let _hello = next_text(&mut host).await;
    let _subs = next_text(&mut host).await;

    // 64 KiB is the cap; one byte over closes 1009.
    let mut giant = String::from(r#"{"type":"battle","pad":""#);
    giant.push_str(&"x".repeat(65_537 - giant.len() - 2));
    giant.push('\"');
    giant.push('}');
    assert_eq!(giant.len(), 65_537);
    host.send(Message::Text(giant.into())).await.unwrap();
    loop {
        match host.next().await {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 1009);
                break;
            },
            Some(Ok(_)) => continue,
            other => panic!("expected 1009 close, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn gateway_password_lockout_flow() {
    let s = spawn_server(|cfg| {
        cfg.gateway_password = Some("test-password".into());
    })
    .await;
    let route = "r:asia:9";
    // Missing password → 400 missing_password.
    let resp = s
        .client
        .post(url(&s, "gateway/session"))
        .json(&json!({ "route": route }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v["error"], "missing_password");

    // Wrong password → 403 password; the 5th failure inside the window
    // locks the IP → 429 with retryAfter.
    for n in 0..5 {
        let resp = s
            .client
            .post(url(&s, "gateway/session"))
            .json(&json!({ "route": route, "password": "wrong" }))
            .send()
            .await
            .unwrap();
        if n < 4 {
            assert_eq!(resp.status(), 403, "failure {n}");
        } else {
            assert_eq!(resp.status(), 429, "the 5th failure locks");
            let v: Value = resp.json().await.unwrap();
            assert_eq!(v["error"], "rate_limited");
            assert!(v["retryAfter"].as_u64().is_some());
        }
    }

    // While locked even the CORRECT password is refused 429.
    let resp = s
        .client
        .post(url(&s, "gateway/session"))
        .json(&json!({ "route": route, "password": "test-password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 429);

    // The health document advertises the password demand.
    let resp = s
        .client
        .get(url(&s, "gateway/health"))
        .send()
        .await
        .unwrap();
    let doc: Value = resp.json().await.unwrap();
    assert_eq!(doc["auth"]["password"]["required"], true);
    assert_eq!(doc["auth"]["turnstile"]["required"], false);
}

// ── pull-through sync between two instances ────────────────────────────

#[tokio::test]
async fn sync_pulls_a_block_from_a_peer_on_local_miss() {
    // U faces the real (mocked) upstream; V has NO upstream path — if
    // V's lookup answers, it can only be through the mesh.
    let (upstream_addr, _hits) = spawn_mock_upstream().await;
    let u = spawn_server(|cfg| {
        cfg.public_url = Some("https://mesh-u.example".into());
        cfg.upstream_override.insert(
            "vortex.wowsgame.cn".into(),
            format!("http://{upstream_addr}"),
        );
    })
    .await;
    let target = "https://vortex.wowsgame.cn/api/accounts/77";
    // Warm U's cache.
    let resp = u
        .client
        .get(url(&u, "api/lookup/fetch"))
        .query(&[("url", target)])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // V: unreachable direct upstream, sync ON, peersUpstream → U.
    let v = spawn_server(|cfg| {
        cfg.peers_upstream = format!("http://{}/", u.addr);
        cfg.upstream_override
            .insert("mesh-u.example".into(), format!("http://{}/", u.addr));
    })
    .await;
    // V learns U from U's list (U's public self row, §5.1).
    let resp = v.client.get(url(&v, "api/peers")).send().await.unwrap();
    let list: Value = resp.json().await.unwrap();
    assert!(
        list["peers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["url"] == "https://mesh-u.example"),
        "V learns U from U's list"
    );

    // V's lookup: local miss → peer pull from U → peer-hit.
    let resp = v
        .client
        .get(url(&v, "api/lookup/fetch"))
        .query(&[("url", target)])
        .send()
        .await
        .unwrap();
    let status = resp.status();
    assert_eq!(
        status,
        200,
        "cache={:?}",
        resp.headers()
            .get("x-wowsp-cache")
            .and_then(|v| v.to_str().ok())
    );
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["id"], "77");
    // …and V kept a local copy: the next request is a plain hit.
    let resp = v
        .client
        .get(url(&v, "api/lookup/fetch"))
        .query(&[("url", target)])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.headers().get("x-wowsp-cache").unwrap(), "hit");
}

#[tokio::test]
async fn sweep_removes_expired_peer_rows() {
    let b = spawn_server(|_| {}).await;
    let a = spawn_server(|_| {}).await;
    // One row past its 48 h TTL, one fresh (§5.2 step 3). Rows are
    // relay-core PeerRows now.
    let row = |url: &str, at: i64| relay_core::peers::PeerRow {
        url: url.to_string(),
        capabilities: relay_core::manifest::CapabilitiesDoc {
            gateway: true,
            lookup: true,
            peers: true,
            blocks: true,
        },
        role: "community".into(),
        node_id: b.app.node_id.clone(),
        added_at: at as u64,
        last_seen_at: at as u64,
        notice: None,
        private: false,
    };
    let aged = a.app.now() - 47 * 3600;
    let fresh = a.app.now() - 1;
    a.app
        .store
        .put_peer(&row("https://aged.example", aged), aged);
    a.app
        .store
        .put_peer(&row("https://fresh.example", fresh), fresh);
    let removed = a.app.store.sweep_peers(a.app.now() + 2 * 3600);
    assert_eq!(removed, 1, "only the past-TTL row goes");
    let peers = a.app.store.list_peers(a.app.now() + 2 * 3600, true);
    assert!(peers.iter().all(|p| p.url != "https://aged.example"));
    assert!(peers.iter().any(|p| p.url == "https://fresh.example"));
}
