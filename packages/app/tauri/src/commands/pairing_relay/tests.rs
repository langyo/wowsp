use super::*;

#[test]
fn relay_urls_normalize_to_ws() {
    assert_eq!(
        normalize_relay_ws_url("https://wowsp-pairing.example.workers.dev").unwrap(),
        "wss://wowsp-pairing.example.workers.dev"
    );
    assert_eq!(
        normalize_relay_ws_url("https://wowsp-pairing.example.workers.dev/").unwrap(),
        "wss://wowsp-pairing.example.workers.dev"
    );
    assert_eq!(
        normalize_relay_ws_url("http://127.0.0.1:8787").unwrap(),
        "ws://127.0.0.1:8787"
    );
    // Bare host gets wss.
    assert_eq!(
        normalize_relay_ws_url("  pair.example.org ").unwrap(),
        "wss://pair.example.org"
    );
    // Already-ws URLs pass through.
    assert_eq!(
        normalize_relay_ws_url("ws://127.0.0.1:9000").unwrap(),
        "ws://127.0.0.1:9000"
    );
    // Junk is refused.
    assert!(normalize_relay_ws_url("").is_err());
    assert!(normalize_relay_ws_url("   ").is_err());
    assert!(normalize_relay_ws_url("ftp://x.example").is_err());
}

#[test]
fn relay_roots_normalize_across_schemes() {
    // Every gateway spelling folds onto the http(s) manifest root.
    assert_eq!(
        normalize_relay_root("wss://wowsp.langyo.xyz").unwrap(),
        "https://wowsp.langyo.xyz"
    );
    assert_eq!(
        normalize_relay_root("https://wowsp.langyo.xyz/").unwrap(),
        "https://wowsp.langyo.xyz"
    );
    assert_eq!(
        normalize_relay_root("ws://127.0.0.1:8787").unwrap(),
        "http://127.0.0.1:8787"
    );
    assert_eq!(
        normalize_relay_root("http://127.0.0.1:8787/dev").unwrap(),
        "http://127.0.0.1:8787/dev"
    );
    // Bare host gets https (production gateways are always TLS).
    assert_eq!(
        normalize_relay_root(" gateway.example.org ").unwrap(),
        "https://gateway.example.org"
    );
    // Scheme case is irrelevant; the rest is kept verbatim.
    assert_eq!(
        normalize_relay_root("WSS://gw.example.org/Path").unwrap(),
        "https://gw.example.org/Path"
    );
    // Junk is refused.
    assert!(normalize_relay_root("").is_err());
    assert!(normalize_relay_root("ftp://x.example").is_err());
    assert!(normalize_relay_root("https://").is_err());
}

#[test]
fn builtin_gateway_is_the_hardcoded_root_with_dev_override() {
    // No override → the ONE built-in constant.
    assert_eq!(builtin_relay_root_from(None), "https://wowsp.langyo.xyz");
    // Blank/whitespace override → still the built-in root.
    assert_eq!(
        builtin_relay_root_from(Some("")),
        "https://wowsp.langyo.xyz"
    );
    assert_eq!(
        builtin_relay_root_from(Some("   ")),
        "https://wowsp.langyo.xyz"
    );
    // A usable override wins (development against `wrangler dev`) in
    // any spelling.
    assert_eq!(
        builtin_relay_root_from(Some("ws://127.0.0.1:8787")),
        "http://127.0.0.1:8787"
    );
    assert_eq!(
        builtin_relay_root_from(Some("http://127.0.0.1:8787")),
        "http://127.0.0.1:8787"
    );
    // A junk override falls back to the built-in root instead of
    // breaking pairing.
    assert_eq!(
        builtin_relay_root_from(Some("ftp://nope")),
        "https://wowsp.langyo.xyz"
    );
}

#[test]
fn manifest_relay_endpoints_resolve_against_the_root() {
    // Path form: the root's host + the manifest path (any root path
    // prefix is REPLACED).
    assert_eq!(
        resolve_relay_endpoint("https://gw.example.org", "/v2/relay-ws").unwrap(),
        "wss://gw.example.org/v2/relay-ws"
    );
    assert_eq!(
        resolve_relay_endpoint("http://127.0.0.1:8787/routed", "/relay-ws").unwrap(),
        "ws://127.0.0.1:8787/relay-ws"
    );
    // Absolute form: used as-is; only ws/wss are the tunnel protocol.
    assert_eq!(
        resolve_relay_endpoint("https://gw.example.org", "wss://other.example.org/x").unwrap(),
        "wss://other.example.org/x"
    );
    assert_eq!(
        resolve_relay_endpoint("https://gw.example.org", "ws://127.0.0.1:9000").unwrap(),
        "ws://127.0.0.1:9000"
    );
    // Missing / non-ws / relative endpoints are refused.
    assert!(resolve_relay_endpoint("https://gw.example.org", "").is_err());
    assert!(resolve_relay_endpoint("https://gw.example.org", "https://x.example").is_err());
    assert!(resolve_relay_endpoint("https://gw.example.org", "relay-ws").is_err());
}

#[test]
fn manifests_parse_leniently_and_gate_on_gateway_shape() {
    let m: GatewayManifest = serde_json::from_str(
        r#"{"provider":"wowsp","name":"gw","protocol":["v1"],
            "endpoints":{"relay":"/relay-ws"},"upstream":null,
            "features":["allocate"],"notice":"hi"}"#,
    )
    .unwrap();
    assert!(is_gateway_manifest(&m));
    assert_eq!(m.provider, "wowsp");
    assert_eq!(m.endpoints.relay, "/relay-ws");
    assert!(m.notice.is_some());

    // Forwarder manifests carry upstream and may omit the endpoint.
    let fwd: GatewayManifest = serde_json::from_str(
        r#"{"provider":"a","name":"fwd","protocol":["v1"],"upstream":"https://b.example"}"#,
    )
    .unwrap();
    assert_eq!(fwd.upstream.as_deref(), Some("https://b.example"));

    // A foreign JSON body parses (all defaults) but is NOT a manifest —
    // resolution must treat it like a 404, not an unsupported protocol.
    let foreign: GatewayManifest = serde_json::from_str(r#"{"captive":"portal"}"#).unwrap();
    assert!(!is_gateway_manifest(&foreign));
    // Garbage fails to parse at all.
    assert!(serde_json::from_str::<GatewayManifest>("<html>").is_err());
}

#[test]
fn manifest_lenient_parse_survives_nulls_but_not_wrong_types() {
    // Explicit nulls on the OPTIONAL (Option-typed) fields are the
    // documented shape; `#[serde(default)]` covers missing fields,
    // but a null against Vec<String> is a wrong type, not a default.
    let m: GatewayManifest = serde_json::from_str(
        r#"{"provider":"wowsp","protocol":["v1"],
            "endpoints":{"relay":"/relay-ws"},
            "upstream":null,"notice":null}"#,
    )
    .unwrap();
    assert!(is_gateway_manifest(&m));
    assert_eq!(m.upstream, None);
    assert_eq!(m.notice, None);
    // A missing `endpoints` object defaults to empty; the protocol
    // list still marks it as a gateway, and the endpoint resolution
    // (tested below) degrades it to legacy direct mode.
    let no_eps: GatewayManifest = serde_json::from_str(r#"{"protocol":["v1"]}"#).unwrap();
    assert!(is_gateway_manifest(&no_eps));
    assert_eq!(no_eps.endpoints.relay, "");
    // Quirk, documented: an ARRAY for `endpoints` parses too (serde's
    // seq-form struct with all-defaulted fields) into an empty relay —
    // the same safe degradation as a missing endpoint, not a foreign
    // body, because the protocol list still marks the doc gateway-ish.
    let arr_eps: GatewayManifest =
        serde_json::from_str(r#"{"protocol":["v1"],"endpoints":[]}"#).unwrap();
    assert!(is_gateway_manifest(&arr_eps));
    assert_eq!(arr_eps.endpoints.relay, "");
    // Same idea for a whole-doc array: with the bool `ok` leading the
    // struct it no longer parses at all (seq-form would need a bool
    // first) — the fetch wrapper treats that as "no manifest"
    // (foreign body → legacy direct mode), the same safe outcome.
    assert!(serde_json::from_str::<GatewayManifest>(r#"["v1"]"#).is_err());

    // WRONG TYPES on any field fail the whole parse — the fetch
    // wrapper then treats the body as "no manifest" (legacy direct
    // mode), never as a usable-but-garbled gateway.
    for bad in [
        r#"{"protocol":["v1"],"provider":42}"#, // number for a string
        r#"{"protocol":"v1"}"#,                 // scalar for the array
        r#"{"protocol":["v1"],"features":null}"#, // null for a Vec field
        r#"{"protocol":["v1"],"endpoints":{"relay":7}}"#, // number for the path
        r#"{"protocol":["v1"],"upstream":true}"#, // bool for Option<String>
        r#"{"protocol":["v1"],"name":["x"]}"#,  // array for a string
    ] {
        assert!(
            serde_json::from_str::<GatewayManifest>(bad).is_err(),
            "wrong-typed manifest {bad} must not parse"
        );
    }
}

#[test]
fn finish_resolution_degrades_gracefully_on_a_bad_endpoint() {
    // A manifest that speaks v1 but carries no usable relay endpoint
    // falls back to LEGACY DIRECT MODE at the same root — never an
    // error, never the unsupported-protocol one.
    let no_endpoint: GatewayManifest =
        serde_json::from_str(r#"{"protocol":["v1"],"endpoints":{"relay":""}}"#).unwrap();
    let res = finish_resolution("https://gw.example.org", no_endpoint, false).unwrap();
    assert!(
        res.manifest.is_none(),
        "degraded resolutions carry no manifest"
    );
    assert_eq!(res.ws_base, "wss://gw.example.org/api/relay");
    assert!(!res.via_upstream);

    // And a manifest without v1 keeps the DISTINCT error.
    let v3: GatewayManifest =
        serde_json::from_str(r#"{"protocol":["v3"],"endpoints":{"relay":"/r"}}"#).unwrap();
    assert_eq!(
        finish_resolution("https://gw.example.org", v3, false).unwrap_err(),
        UNSUPPORTED_PROTOCOL
    );
}

#[test]
fn room_validation_enforces_the_worker_shape() {
    // 64 lowercase hex = the random room ids the desktop mints.
    assert!(valid_room(
        &crate::commands::pairing::server::random_token().unwrap()
    ));
    assert!(!valid_room("deadbeef"));
    assert!(!valid_room("123456"));
}

#[test]
fn pairing_codes_must_be_six_digits() {
    assert!(valid_code("000000"));
    assert!(valid_code("123456"));
    assert!(!valid_code("12345"));
    assert!(!valid_code("1234567"));
    assert!(!valid_code("12a456"));
    assert!(!valid_code(""));
}

#[test]
fn host_ids_are_32_hex_and_persisted() {
    let tmp = super::super::pairing::tests::tempfile_dir();
    let a = host_id_in(&tmp);
    assert_eq!(a.len(), 32);
    assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    // Stable across calls (persisted in pairing-host-id.txt).
    assert_eq!(host_id_in(&tmp), a);
    assert!(tmp.join(HOST_ID_FILE).exists());
    // Junk on disk is replaced, not trusted.
    std::fs::write(tmp.join(HOST_ID_FILE), "not-an-id").unwrap();
    let b = host_id_in(&tmp);
    assert_eq!(b.len(), 32);
    assert_ne!(b, "not-an-id");
    // Case-normalized valid ids are reused.
    std::fs::write(tmp.join(HOST_ID_FILE), a.to_ascii_uppercase()).unwrap();
    assert_eq!(host_id_in(&tmp), a);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn frame_chunks_never_exceed_the_tunnel_cap() {
    assert_eq!(frame_chunks(&[]).count(), 0);
    let small = vec![7u8; 1_000];
    let chunks: Vec<&[u8]> = frame_chunks(&small).collect();
    assert_eq!(chunks.len(), 1);
    let big = vec![9u8; MAX_OUTGOING_FRAME * 2 + 5];
    let chunks: Vec<&[u8]> = frame_chunks(&big).collect();
    assert_eq!(chunks.len(), 3);
    assert!(chunks.iter().all(|c| c.len() <= MAX_OUTGOING_FRAME));
    // Chunking is lossless.
    assert_eq!(chunks.concat(), big);
}

#[test]
fn control_messages_round_trip() {
    for m in [
        ControlMsg::Welcome,
        ControlMsg::Ready,
        ControlMsg::Waiting,
        ControlMsg::Open {
            id: "abc123".into(),
        },
        ControlMsg::Conn {
            id: "def456".into(),
        },
        ControlMsg::Allocate,
        ControlMsg::Code {
            code: "012345".into(),
        },
        ControlMsg::AllocFailed,
        ControlMsg::Room {
            room: "a".repeat(64).into(),
        },
        ControlMsg::ResolveError { reason: None },
        ControlMsg::ResolveError {
            reason: Some("rate_limited".into()),
        },
    ] {
        assert_eq!(ControlMsg::parse(&m.to_text()), Some(m));
    }
    assert_eq!(ControlMsg::parse("junk"), None);
    assert_eq!(ControlMsg::parse(r#"{"type":"nope"}"#), None);
}

#[test]
fn response_heads_parse_with_glued_body() {
    let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"token\":\"x\"";
    let (head, consumed) = parse_response_head(raw).unwrap();
    assert_eq!(head.status, 200);
    assert_eq!(head.header("content-length"), Some("12"));
    assert_eq!(head.header("connection"), Some("close"));
    assert_eq!(consumed, raw.len() - b"{\"token\":\"x\"".len());
    assert!(head.content_length() == Some(12));

    // Truncated head is an error, not a panic.
    assert!(parse_response_head(b"HTTP/1.1 200 OK\r\nConn").is_err());
    assert!(parse_response_head(b"garbage\r\n\r\n").is_err());
}

#[test]
fn tunnel_requests_carry_auth_and_body() {
    let req = tunnel_request("POST", "/pair", None, Some(br#"{"pin":"123456"}"#));
    let text = String::from_utf8(req).unwrap();
    assert!(text.starts_with("POST /pair HTTP/1.1\r\n"));
    assert!(text.contains("Content-Type: application/json\r\n"));
    assert!(text.contains("Content-Length: 16\r\n"));
    assert!(text.ends_with("\r\n\r\n{\"pin\":\"123456\"}"));

    let req = tunnel_request("GET", "/api/replays", Some("tok"), None);
    let text = String::from_utf8(req).unwrap();
    assert!(text.contains("Authorization: Bearer tok\r\n"));
    assert!(text.ends_with("Connection: close\r\n\r\n"));
}

#[test]
fn conn_ids_are_random_hex() {
    let a = conn_id().unwrap();
    let b = conn_id().unwrap();
    assert_eq!(a.len(), 16);
    assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
}

#[test]
fn connection_failures_map_to_the_gateway_marker() {
    assert_eq!(
        gateway_error("relay connect failed (boom)".into()),
        GATEWAY_UNREACHABLE
    );
    assert_eq!(
        gateway_error("resolve failed: relay connect failed (x)".into()),
        GATEWAY_UNREACHABLE
    );
    // Everything else passes through untouched.
    assert_eq!(gateway_error("invalid PIN".into()), "invalid PIN");
    assert_eq!(
        gateway_error("relay host never became ready".into()),
        "relay host never became ready"
    );
    // The DISTINCT v2 errors never collapse into "unreachable".
    assert_eq!(
        gateway_error(UNSUPPORTED_PROTOCOL.to_string()),
        UNSUPPORTED_PROTOCOL
    );
    assert_eq!(
        gateway_error(GATEWAY_RATE_LIMITED.to_string()),
        GATEWAY_RATE_LIMITED
    );
}

// ── end-to-end loopback: mock gateway + LAN server + bridge + client ──
//
// A minimal in-process stand-in for the Cloudflare gateway — now with
// the v2 surface (manifest over plain HTTP on the same port,
// hello/welcome, upstream forwarding, rate limiting, frame-cap
// enforcement) — plus the REAL desktop bridge and the REAL tunnel
// client, pointed at a REAL spawn_on pairing server: allocate a code →
// resolve it → pair → list → pull must deliver the exact bytes through
// two WebSocket hops and a TCP bridge.

/// Serializes the tests that park a session in the process-global host
/// slot (and the global live-code watch) — cargo runs tests in parallel
/// threads and the slot is a singleton.
static HOST_SLOT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The mock's v2 health-document recipe.
#[derive(Debug, Clone)]
struct ManifestSpec {
    provider: String,
    /// e.g. ["v1"]; ["v3"] drives the unsupported-protocol path.
    protocol: Vec<String>,
    /// `endpoints.relay` — a path (resolved against the mock's host) or
    /// an absolute ws URL.
    relay: String,
    notice: Option<String>,
    /// `minClientVersion` — `Some("99.0.0")` drives the too-old path.
    min_client_version: Option<String>,
}

impl Default for ManifestSpec {
    fn default() -> Self {
        Self {
            provider: "wowsp-mock".into(),
            protocol: vec!["v1".into()],
            relay: "/relay-ws".into(),
            notice: None,
            min_client_version: None,
        }
    }
}

/// Behavior switches of one mock gateway instance.
#[derive(Debug, Clone)]
struct MockOptions {
    /// Serve `GET /api/health` (None → 404 → client legacy fallback).
    manifest: Option<ManifestSpec>,
    /// Serve a FORWARDER document whose `upstream` is this root (wins
    /// over `manifest`).
    forward_to: Option<String>,
    /// Answer code resolution with `err / rate_limited`.
    rate_limited: bool,
    /// v2 flavor: answer `hello` with `welcome` (false = legacy v1
    /// worker that ignores hello).
    welcome: bool,
    /// Reject data-socket binary frames above the 256 KiB tunnel cap
    /// (the real worker's byte-tunnel policy).
    enforce_frame_cap: bool,
    /// Serve `echo*` conn ids with an HTTP-framed echo responder (the
    /// chunking round-trip test path).
    echo: bool,
    /// Drop every WebSocket right after the handshake (a pure forwarder
    /// that hosts no rooms of its own).
    ws_dead: bool,
}

impl Default for MockOptions {
    fn default() -> Self {
        Self {
            manifest: Some(ManifestSpec::default()),
            forward_to: None,
            rate_limited: false,
            welcome: true,
            enforce_frame_cap: true,
            echo: false,
            ws_dead: false,
        }
    }
}

/// Minimal in-process stand-in for the Cloudflare gateway: v2 manifest
/// over plain HTTP on the SAME port (peek-dispatched before the WS
/// handshake), the v1 allocate/resolve/control/data protocol with
/// hello/welcome on top, in-memory room + code map, raw byte pipes.
/// Serves until the shutdown watch fires.
mod mock_gateway {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    use futures::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::watch;
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    use super::{super::MAX_OUTGOING_FRAME, MockOptions};

    type Ws = WebSocketStream<TcpStream>;

    #[derive(Default)]
    struct Pending {
        client: Option<Ws>,
        host_side: Option<Ws>,
    }

    /// Manifest requests seen: (path, sent_no_store_cache_control).
    pub type ManifestHits = Arc<StdMutex<Vec<(String, bool)>>>;

    #[derive(Default)]
    struct Hub {
        /// Where control-client tasks forward {type:"open"} to the host
        /// task (None until the host control connects).
        host_tx: Option<futures::channel::mpsc::UnboundedSender<String>>,
        pending: Arc<StdMutex<HashMap<String, Arc<StdMutex<Pending>>>>>,
        /// Allocated codes: 6-digit code → room key.
        codes: Arc<StdMutex<HashMap<String, String>>>,
        /// Reverse binding room → its ONE active code (mirrors the real
        /// Directory: re-allocating replaces the room's previous code).
        rooms: Arc<StdMutex<HashMap<String, String>>>,
        /// Code mint counter (deterministic, distinct codes per test).
        code_seq: Arc<StdMutex<u32>>,
        /// Plain-HTTP manifest requests, for assertions.
        pub manifest_hits: ManifestHits,
    }

    type SharedHub = Arc<StdMutex<Hub>>;

    pub async fn serve(
        listener: TcpListener,
        shutdown: watch::Receiver<bool>,
        opts: MockOptions,
        manifest_hits: ManifestHits,
    ) {
        let opts = Arc::new(opts);
        let hub: SharedHub = Arc::new(StdMutex::new(Hub {
            manifest_hits,
            ..Hub::default()
        }));
        let mut shutdown = shutdown;
        loop {
            let accepted = tokio::select! {
                _ = shutdown.changed() => break,
                res = listener.accept() => res,
            };
            let Ok((stream, _)) = accepted else { continue };
            let hub = hub.clone();
            let opts = opts.clone();
            tokio::spawn(async move { handle(stream, hub, opts).await });
        }
    }

    async fn handle(stream: TcpStream, hub: SharedHub, opts: Arc<MockOptions>) {
        // Same-port dispatch: peek the request line — a plain GET
        // without an Upgrade header is the v2 manifest route; anything
        // else goes to the WebSocket handshake (peek does not consume).
        let mut peek = [0u8; 1024];
        let n = stream.peek(&mut peek).await.unwrap_or(0);
        let head = String::from_utf8_lossy(&peek[..n]).to_ascii_lowercase();
        if head.starts_with("get") && !head.contains("upgrade:") {
            serve_manifest(stream, hub, opts).await;
            return;
        }
        let mut path = String::new();
        let cb = |req: &Request, resp: Response| {
            path.push_str(req.uri().path());
            if let Some(q) = req.uri().query() {
                path.push('?');
                path.push_str(q);
            }
            Ok(resp)
        };
        let ws = match tokio_tungstenite::accept_hdr_async(stream, cb).await {
            Ok(w) => w,
            Err(_) => return,
        };
        if opts.ws_dead {
            let mut ws = ws;
            let _ = ws.close(None).await;
            return;
        }
        let no_query = path.split('?').next().unwrap_or("").to_string();
        if no_query.ends_with("/resolve") || no_query == "/resolve" {
            resolve_socket(ws, hub, &path, opts).await;
        } else if no_query.ends_with("/control") || no_query == "/control" {
            if query(&path, "role").as_deref() == Some("host") {
                let room = query(&path, "room").unwrap_or_default();
                host_control(ws, hub, room, opts).await;
            } else {
                client_control(ws, hub, opts).await;
            }
        } else if no_query.contains("/data/") {
            data_socket(ws, hub, &path, opts).await;
        }
    }

    /// Plain-HTTP `GET /api/health` (or 404). Reads the full request
    /// head first — the peek window may have truncated it.
    async fn serve_manifest(mut stream: TcpStream, hub: SharedHub, opts: Arc<MockOptions>) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match stream.read(&mut byte).await {
                Ok(0) => break,
                Ok(_) => {
                    buf.push(byte[0]);
                    if buf.ends_with(b"\r\n\r\n") || buf.len() > 8 * 1024 {
                        break;
                    }
                },
                Err(_) => return,
            }
        }
        let head = String::from_utf8_lossy(&buf).to_string();
        let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
        if path != "/api/health" {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            return;
        }
        let no_store = head
            .to_ascii_lowercase()
            .contains("cache-control: no-store");
        if let Ok(hub) = hub.lock() {
            hub.manifest_hits.lock().unwrap().push((path, no_store));
        }
        let body = if let Some(up) = &opts.forward_to {
            serde_json::json!({
                "ok": true,
                "provider": "wowsp-mock-forwarder",
                "name": "Mock Forwarder",
                "version": "0.5.0",
                "protocol": ["v1"],
                "endpoints": { "relay": "/relay-ws" },
                "upstream": up,
                "features": [],
                "notice": null
            })
        } else if let Some(m) = &opts.manifest {
            serde_json::json!({
                "ok": true,
                "provider": m.provider,
                "name": "Mock Gateway",
                "version": "0.5.0",
                "minClientVersion": m.min_client_version,
                "protocol": m.protocol,
                "endpoints": { "relay": m.relay },
                "upstream": null,
                "features": ["allocate"],
                "notice": m.notice
            })
        } else {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                )
                .await;
            return;
        };
        let body = body.to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes()).await;
    }

    fn query(path: &str, key: &str) -> Option<String> {
        let q = path.split_once('?')?.1;
        q.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == key).then(|| v.to_string())
        })
    }

    /// Is this text frame a v2 client hello?
    fn is_hello(text: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| {
                let t = v.get("type").and_then(|x| x.as_str())?;
                let proto = v.get("protocol").and_then(|x| x.as_str())?;
                Some(t == "hello" && proto == "v1")
            })
            .unwrap_or(false)
    }

    /// Phone's code→room handshake: (v2) welcome the hello first, then
    /// one {"type":"room"} frame, or {"type":"err"[, reason]} for an
    /// unknown / rate-limited code.
    async fn resolve_socket(mut ws: Ws, hub: SharedHub, path: &str, opts: Arc<MockOptions>) {
        if opts.welcome {
            if let Ok(Some(Ok(Message::Text(t)))) =
                tokio::time::timeout(Duration::from_secs(5), ws.next()).await
            {
                if is_hello(&t) {
                    let _ = ws.send(Message::Text(r#"{"type":"welcome"}"#.into())).await;
                }
            }
        }
        let code = query(path, "code").unwrap_or_default();
        let frame = if opts.rate_limited {
            serde_json::json!({ "type": "err", "reason": "rate_limited" }).to_string()
        } else {
            let room = hub
                .lock()
                .unwrap()
                .codes
                .lock()
                .unwrap()
                .get(&code)
                .cloned();
            match room {
                Some(room) => serde_json::json!({ "type": "room", "room": room }).to_string(),
                None => serde_json::json!({ "type": "err" }).to_string(),
            }
        };
        if ws.send(Message::Text(frame.into())).await.is_err() {
            return;
        }
        let _ = ws.close(None).await;
    }

    /// Host control channel: (v2) welcome hellos, answers
    /// {type:"allocate"} with a fresh code bound to the host's room,
    /// receives conn ids on a channel, forwards them as JSON signals.
    /// Tolerates keepalive texts. Exits when the socket dies (tx drop
    /// tells client tasks the host is gone).
    async fn host_control(mut ws: Ws, hub: SharedHub, room: String, opts: Arc<MockOptions>) {
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<String>();
        hub.lock().unwrap().host_tx = Some(tx);
        loop {
            tokio::select! {
                maybe_id = rx.next() => {
                    let Some(id) = maybe_id else { break };
                    let signal =
                        serde_json::json!({ "type": "conn", "connId": id }).to_string();
                    if ws.send(Message::Text(signal.into())).await.is_err() {
                        break;
                    }
                },
                read = ws.next() => {
                    match read {
                        Some(Ok(Message::Text(t))) => {
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                                continue;
                            };
                            match v.get("type").and_then(|x| x.as_str()) {
                                Some("hello") if opts.welcome => {
                                    let _ = ws
                                        .send(Message::Text(r#"{"type":"welcome"}"#.into()))
                                        .await;
                                },
                                Some("allocate") => {
                                    let seq = {
                                        let hub = hub.lock().unwrap();
                                        let mut s = hub.code_seq.lock().unwrap();
                                        *s += 1;
                                        *s
                                    };
                                    let code = format!("{seq:06}");
                                    {
                                        // One active code per host: drop the
                                        // room's previous binding first.
                                        let hub = hub.lock().unwrap();
                                        let mut codes = hub.codes.lock().unwrap();
                                        let mut rooms = hub.rooms.lock().unwrap();
                                        if let Some(old) = rooms.remove(&room) {
                                            codes.remove(&old);
                                        }
                                        codes.insert(code.clone(), room.clone());
                                        rooms.insert(room.clone(), code.clone());
                                    }
                                    let reply = serde_json::json!({
                                        "type": "code", "code": code
                                    })
                                    .to_string();
                                    if ws.send(Message::Text(reply.into())).await.is_err() {
                                        break;
                                    }
                                },
                                _ => continue, // keepalive & friends: ignore
                            }
                        },
                        Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                        _ => break,
                    }
                },
            }
        }
        hub.lock().unwrap().host_tx = None;
    }

    /// Client control channel: (v2) welcome the hello, then answer host
    /// presence once, then forward {type:"open"} requests.
    async fn client_control(mut ws: Ws, hub: SharedHub, opts: Arc<MockOptions>) {
        if opts.welcome {
            if let Ok(Some(Ok(Message::Text(t)))) =
                tokio::time::timeout(Duration::from_secs(5), ws.next()).await
            {
                if is_hello(&t) {
                    let _ = ws.send(Message::Text(r#"{"type":"welcome"}"#.into())).await;
                }
            }
        }
        let host_present = hub.lock().unwrap().host_tx.is_some();
        let greeting = if host_present {
            r#"{"type":"ready"}"#
        } else {
            r#"{"type":"waiting"}"#
        };
        if ws.send(Message::Text(greeting.into())).await.is_err() {
            return;
        }
        while let Some(Ok(msg)) = ws.next().await {
            let Message::Text(t) = msg else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                continue;
            };
            if v.get("type").and_then(|x| x.as_str()) != Some("open") {
                continue;
            }
            let Some(id) = v.get("connId").and_then(|c| c.as_str()) else {
                continue;
            };
            hub.lock()
                .unwrap()
                .pending
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_default();
            let forward = hub
                .lock()
                .unwrap()
                .host_tx
                .as_ref()
                .map(|tx| tx.unbounded_send(id.to_string()).is_ok());
            if forward != Some(true) {
                // No host to signal — leave the pending entry; the test
                // tears the room down with the process.
                return;
            }
        }
    }

    /// Data socket: `echo*` conn ids get the HTTP-framed echo responder
    /// (chunk round-trip test); anything else attaches to the pending
    /// conn, waits (briefly) for the peer side, then pipes raw bytes
    /// until either side closes — rejecting oversized binary frames
    /// when the cap is enforced (the real worker's policy).
    async fn data_socket(ws: Ws, hub: SharedHub, path: &str, opts: Arc<MockOptions>) {
        let conn = query(path, "conn").unwrap_or_default();
        let side = query(path, "side").unwrap_or_default();
        if opts.echo && conn.starts_with("echo") {
            echo_responder(ws, opts).await;
            return;
        }
        let entry = hub
            .lock()
            .unwrap()
            .pending
            .lock()
            .unwrap()
            .get(&conn)
            .cloned();
        let Some(entry) = entry else {
            let mut ws = ws;
            let _ = ws.close(None).await;
            return;
        };
        {
            let mut p = entry.lock().unwrap();
            if side == "client" {
                p.client = Some(ws);
            } else {
                p.host_side = Some(ws);
            }
        }
        // Wait for the peer (bounded ~2s), then take both and pipe.
        for _ in 0..100 {
            let ready = {
                let p = entry.lock().unwrap();
                p.client.is_some() && p.host_side.is_some()
            };
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pair = {
            let mut p = entry.lock().unwrap();
            (p.client.take(), p.host_side.take())
        };
        if let (Some(client), Some(host)) = pair {
            tokio::spawn(pipe(client, host, opts));
        }
    }

    /// Read exactly one HTTP request (Content-Length framed), then echo
    /// its body back as one big HTTP response in a SINGLE binary frame —
    /// under the 1 MiB inbound cap, well above the 256 KiB outbound one.
    /// Oversized inbound frames abort the socket when the cap is
    /// enforced.
    async fn echo_responder(mut ws: Ws, opts: Arc<MockOptions>) {
        let mut buf: Vec<u8> = Vec::new();
        let mut expected: Option<usize> = None;
        while let Some(Ok(msg)) = ws.next().await {
            match msg {
                Message::Binary(b) => {
                    if opts.enforce_frame_cap && b.len() > MAX_OUTGOING_FRAME {
                        let _ = ws.close(None).await;
                        return;
                    }
                    buf.extend_from_slice(&b);
                    if expected.is_none() {
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..pos + 4]).to_string();
                            let cl = head
                                .lines()
                                .find_map(|l| {
                                    let (k, v) = l.split_once(':')?;
                                    k.trim()
                                        .eq_ignore_ascii_case("content-length")
                                        .then(|| v.trim().parse::<usize>().ok())?
                                })
                                .unwrap_or(0);
                            expected = Some(pos + 4 + cl);
                        }
                    }
                    if let Some(e) = expected {
                        if buf.len() >= e {
                            break;
                        }
                    }
                },
                Message::Close(_) => return,
                _ => {},
            }
        }
        let Some(e) = expected else { return };
        let head_end = buf
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|p| p + 4)
            .unwrap_or(e);
        let body = &buf[head_end..e];
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut frame = resp.into_bytes();
        frame.extend_from_slice(body);
        let _ = ws.send(Message::Binary(frame.into())).await;
        let _ = ws.close(None).await;
    }

    /// Raw byte pipe between the two data sockets (binary frames only;
    /// oversized frames rejected when the cap is enforced).
    async fn pipe(a: Ws, b: Ws, opts: Arc<MockOptions>) {
        let (mut a_sink, mut a_stream) = a.split();
        let (mut b_sink, mut b_stream) = b.split();
        let ab = pipe_half(&mut a_stream, &mut b_sink, &opts);
        let ba = pipe_half(&mut b_stream, &mut a_sink, &opts);
        tokio::join!(ab, ba);
    }

    async fn pipe_half(
        from: &mut futures::stream::SplitStream<Ws>,
        to: &mut futures::stream::SplitSink<Ws, Message>,
        opts: &Arc<MockOptions>,
    ) {
        while let Some(Ok(msg)) = from.next().await {
            match msg {
                Message::Binary(data) => {
                    if opts.enforce_frame_cap && data.len() > MAX_OUTGOING_FRAME {
                        let _ = to.send(Message::Close(None)).await;
                        break;
                    }
                    if to.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                },
                Message::Close(_) => {
                    let _ = to.send(Message::Close(None)).await;
                    break;
                },
                _ => {},
            }
        }
    }
}

/// Bind a mock gateway on an ephemeral loopback port; returns its http
/// root, shutdown sender, serve task, and the manifest-request log.
struct MockGateway {
    root: String,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
    /// `(path, sent_no_store)` per plain-HTTP manifest request seen.
    manifest_hits: mock_gateway::ManifestHits,
}

impl MockGateway {
    async fn start(opts: MockOptions) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        Self::start_on(listener, opts).await
    }

    /// Serve on an ALREADY-BOUND listener (tests that need two mocks to
    /// reference each other's root bind both first).
    async fn start_on(listener: tokio::net::TcpListener, opts: MockOptions) -> Self {
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::watch::channel(false);
        let manifest_hits: mock_gateway::ManifestHits =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let task = tokio::spawn(mock_gateway::serve(
            listener,
            rx,
            opts,
            manifest_hits.clone(),
        ));
        Self {
            root: format!("http://127.0.0.1:{port}"),
            shutdown: tx,
            task,
            manifest_hits,
        }
    }

    async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

/// The full v2 loopback: the REAL bridge resolves the mock's manifest,
/// allocates a code through the resolved endpoint, the code lands in
/// the live state, the phone-shaped client resolves + pairs with the
/// code, and the code doubles as an accepted /pair secret on the REAL
/// server (LAN + relay in one exchange).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn allocate_resolve_pair_and_pull_over_the_tunnel() {
    let _serial = HOST_SLOT_LOCK.lock().await;
    // Defensive: a panicked earlier test could leave the global slot /
    // code watch / resolution cache dirty.
    host_session_stop().await;
    store_code(None);
    clear_resolution_cache_for_test();
    use super::super::pairing;

    // Fixture replay (same shape as pairing's own e2e).
    let tmp = pairing::tests::tempfile_dir();
    let replays = tmp.join("replays");
    std::fs::create_dir_all(&replays).unwrap();
    let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
    let mut bytes: Vec<u8> = vec![0x12, 0x32, 0x34, 0x11];
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(json.as_bytes());
    let replay_name = "20260922_101010_Tester_15_NE_north.wowsreplay";
    std::fs::write(replays.join(replay_name), &bytes).unwrap();

    // 1. The REAL pairing server on an ephemeral localhost port, with a
    //    random room id (the v2 shape: rooms are NOT pin-derived).
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let server_port = listener.local_addr().unwrap().port();
    let room = pairing::server::random_token().unwrap();
    let server = pairing::server::spawn_on(listener, replays.clone(), None, "123456", &room)
        .await
        .unwrap();

    // 2. The mock gateway (default v2: manifest + welcome + relay path
    //    + frame-cap enforcement) on another ephemeral port.
    let gateway = MockGateway::start(MockOptions::default()).await;

    // 3. The REAL host bridge, started from the gateway ROOT — it must
    //    resolve the manifest and dial the /relay-ws endpoint. On
    //    connect it asks the gateway to allocate the pairing code; the
    //    code lands in the live state.
    host_session_start(&gateway.root, server_port, &room)
        .await
        .unwrap_or_else(|e| panic!("host session must start: {e}"));
    // Budget covers the v2 hello/welcome round trip plus allocation.
    let code = wait_for_code(std::time::Duration::from_secs(15))
        .await
        .unwrap_or_else(|e| panic!("the mock gateway must allocate a code: {e}"));
    assert_eq!(code.len(), 6, "the gateway mints 6-digit codes");
    assert!(relay_online(), "a live code means the gateway is online");

    // The resolved manifest info surfaced for the status: the mock's
    // provider, direct (no upstream hop).
    let info = current_gateway_info();
    assert_eq!(info.provider.as_deref(), Some("wowsp-mock"));
    assert!(!info.via_upstream);
    assert_eq!(info.notice, None);

    // The health fetch itself: /api/health, requested no-store.
    {
        let hits = gateway.manifest_hits.lock().unwrap();
        assert!(!hits.is_empty(), "the manifest route must have been hit");
        assert!(
            hits.iter()
                .all(|(p, no_store)| p == "/api/health" && *no_store),
            "manifest requests must send Cache-Control: no-store"
        );
    }

    // 4. Client: resolve + pair WITH THE CODE (never the local pin),
    //    starting from the same root (the session's cached resolution).
    let paired = relay_pair(&gateway.root, &code).await.unwrap();
    assert!(!paired.token.is_empty());
    assert_eq!(
        paired.room.as_deref(),
        Some(room.as_str()),
        "the resolved room rides back"
    );

    // The 6-digit code is also an accepted /pair secret on the REAL
    // server over PLAIN LAN HTTP (what a same-network phone types).
    let lan = reqwest::Client::builder().no_proxy().build().unwrap();
    let r = lan
        .post(format!("http://127.0.0.1:{server_port}/pair"))
        .json(&serde_json::json!({ "pin": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "the relay code pairs over the LAN too");
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(
        body["room"],
        serde_json::json!(room),
        "/pair echoes the room key"
    );

    // An unknown-but-well-formed code resolves to the gateway-unreachable
    // marker (the phone's friendly error state), not a raw crash.
    let err = relay_pair(&gateway.root, "000000").await.unwrap_err();
    assert_eq!(err, GATEWAY_UNREACHABLE);
    // A malformed code is rejected before any network I/O.
    let err = relay_pair(&gateway.root, "12a4").await.unwrap_err();
    assert_eq!(err, GATEWAY_UNREACHABLE);

    // 5. List through the tunnel using the stored room key (the same
    //    60s-cycle client the LAN flow shares).
    let list = relay_list_remote(&gateway.root, &room, &paired.token)
        .await
        .unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, replay_name);

    // Bad token → clean 401 string.
    let err = relay_list_remote(&gateway.root, &room, "nope")
        .await
        .unwrap_err();
    assert_eq!(err, "invalid or expired token");

    // 6. Pull the replay through the tunnel → exact bytes.
    let dest = tmp.join("pulled.wowsreplay");
    let n = relay_pull_replay(
        None, // no AppHandle in unit tests → progress events skipped
        &gateway.root,
        &room,
        &paired.token,
        replay_name,
        &dest,
    )
    .await
    .unwrap_or_else(|e| panic!("relay pull failed: {e}"));
    assert_eq!(n, bytes.len() as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);

    // 7. Regenerate: a fresh code replaces the old one (single active
    //    code per host), and the OLD code stops resolving.
    let fresh = host_reallocate().await.unwrap();
    assert_ne!(fresh, code, "the gateway must mint a new code");
    assert_eq!(current_relay_code().as_deref(), Some(fresh.as_str()));
    let err = relay_pair(&gateway.root, &code).await.unwrap_err();
    assert_eq!(err, GATEWAY_UNREACHABLE, "the replaced code is dead");
    let paired2 = relay_pair(&gateway.root, &fresh).await.unwrap();
    assert_eq!(paired2.room.as_deref(), Some(room.as_str()));

    // 8. Tear everything down: the live code and gateway info clear
    //    with the session.
    host_session_stop().await;
    assert!(!relay_online(), "stopping the session clears the code");
    assert_eq!(current_relay_code(), None);
    assert_eq!(current_gateway_info().provider, None);
    let _ = server.stop().await;
    gateway.stop().await;
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A gateway with NO manifest (404) is served in LEGACY v1 direct mode:
/// resolution falls back to `ws://<root>`, the bridge and client still
/// pair end-to-end, and no provider info surfaces (legacy has none).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_manifest_falls_back_to_legacy_direct_mode() {
    let _serial = HOST_SLOT_LOCK.lock().await;
    host_session_stop().await;
    store_code(None);
    clear_resolution_cache_for_test();
    use super::super::pairing;

    let tmp = pairing::tests::tempfile_dir();
    let replays = tmp.join("replays");
    std::fs::create_dir_all(&replays).unwrap();

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let server_port = listener.local_addr().unwrap().port();
    let room = pairing::server::random_token().unwrap();
    let server = pairing::server::spawn_on(listener, replays.clone(), None, "123456", &room)
        .await
        .unwrap();

    // No manifest, legacy v1 flavor (no hello/welcome either).
    let gateway = MockGateway::start(MockOptions {
        manifest: None,
        welcome: false,
        ..MockOptions::default()
    })
    .await;

    // Resolution degrades to the legacy ws base.
    let res = resolve_gateway_cached(&gateway.root).await.unwrap();
    assert!(res.manifest.is_none());
    assert!(!res.via_upstream);
    assert_eq!(res.ws_base, ws_base_of_root(&gateway.root));
    // …and the fallback was driven by an actual 404 from /api/health.
    assert!(
        !gateway.manifest_hits.lock().unwrap().is_empty(),
        "legacy fallback must still have probed the manifest route"
    );

    // The bridge still pairs through it (hello tolerated in silence).
    host_session_start(&gateway.root, server_port, &room)
        .await
        .unwrap();
    let code = wait_for_code(std::time::Duration::from_secs(15))
        .await
        .unwrap();
    let paired = relay_pair(&gateway.root, &code).await.unwrap();
    assert_eq!(paired.room.as_deref(), Some(room.as_str()));

    // Legacy mode surfaces NO provider info.
    let info = current_gateway_info();
    assert_eq!(info.provider, None);
    assert!(!info.via_upstream);

    host_session_stop().await;
    let _ = server.stop().await;
    gateway.stop().await;
    let _ = std::fs::remove_dir_all(&tmp);
}

/// One upstream hop: gateway A's manifest forwards to gateway B, and
/// the whole pairing flow (bridge + phone) runs THROUGH B — A's own
/// WebSocket surface is dead, so success proves the hop was followed.
/// The status surfaces B's provider + viaUpstream=true.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upstream_hop_pairs_through_the_forwarded_gateway() {
    let _serial = HOST_SLOT_LOCK.lock().await;
    host_session_stop().await;
    store_code(None);
    clear_resolution_cache_for_test();
    use super::super::pairing;

    let tmp = pairing::tests::tempfile_dir();
    let replays = tmp.join("replays");
    std::fs::create_dir_all(&replays).unwrap();

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let server_port = listener.local_addr().unwrap().port();
    let room = pairing::server::random_token().unwrap();
    let server = pairing::server::spawn_on(listener, replays.clone(), None, "123456", &room)
        .await
        .unwrap();

    // B: the real exchange behind the hop.
    let b = MockGateway::start(MockOptions {
        manifest: Some(ManifestSpec {
            provider: "wowsp-mock-b".into(),
            notice: Some("maintenance soon".into()),
            ..ManifestSpec::default()
        }),
        ..MockOptions::default()
    })
    .await;
    // A: a pure forwarder — manifest only, every WS connection dropped.
    let a = MockGateway::start(MockOptions {
        forward_to: Some(b.root.clone()),
        ws_dead: true,
        ..MockOptions::default()
    })
    .await;

    // Resolution from A's root lands on B's relay endpoint (an
    // absolute path in B's document REPLACES any base on the host).
    let res = resolve_gateway(&a.root).await.unwrap();
    assert!(res.via_upstream);
    assert_eq!(res.manifest.as_ref().unwrap().provider, "wowsp-mock-b");
    let b_host = b.root.trim_start_matches("http://");
    assert_eq!(res.ws_base, format!("ws://{b_host}/relay-ws"));

    // The bridge + phone pair through the chain (A's WS is dead — only
    // B can carry it).
    host_session_start(&a.root, server_port, &room)
        .await
        .unwrap();
    let code = wait_for_code(std::time::Duration::from_secs(15))
        .await
        .unwrap();
    let paired = relay_pair(&a.root, &code).await.unwrap();
    assert_eq!(paired.room.as_deref(), Some(room.as_str()));
    let list = relay_list_remote(&a.root, &room, &paired.token)
        .await
        .unwrap();
    assert!(list.is_empty());

    // The status carries B's provider, the hop flag, and the notice.
    let info = current_gateway_info();
    assert_eq!(info.provider.as_deref(), Some("wowsp-mock-b"));
    assert!(info.via_upstream);
    assert_eq!(info.notice.as_deref(), Some("maintenance soon"));

    host_session_stop().await;
    let _ = server.stop().await;
    a.stop().await;
    b.stop().await;
    let _ = std::fs::remove_dir_all(&tmp);
}

/// An upstream CYCLE and an over-long chain both abort resolution and
/// degrade to legacy direct mode at the INITIAL root.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upstream_cycles_and_hop_budget_degrade_to_the_initial_root() {
    clear_resolution_cache_for_test();

    // Cycle: A → B → A (both pre-bound so each can point at the other).
    let la = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let lb = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let root_a = format!("http://127.0.0.1:{}", la.local_addr().unwrap().port());
    let root_b = format!("http://127.0.0.1:{}", lb.local_addr().unwrap().port());
    let a = MockGateway::start_on(
        la,
        MockOptions {
            forward_to: Some(root_b.clone()),
            ..MockOptions::default()
        },
    )
    .await;
    let b = MockGateway::start_on(
        lb,
        MockOptions {
            forward_to: Some(root_a.clone()),
            ..MockOptions::default()
        },
    )
    .await;
    let res = resolve_gateway(&root_a).await.unwrap();
    assert!(res.manifest.is_none(), "the cycle aborts manifest mode");
    assert!(!res.via_upstream);
    assert_eq!(res.ws_base, ws_base_of_root(&root_a));
    a.stop().await;
    b.stop().await;

    // Hop budget: A → B → C → (D, never fetched) exceeds the 2-hop
    // limit — even though every hop itself is healthy.
    clear_resolution_cache_for_test();
    let c = MockGateway::start(MockOptions {
        forward_to: Some("http://127.0.0.1:9".into()),
        ..MockOptions::default()
    })
    .await;
    let b2 = MockGateway::start(MockOptions {
        forward_to: Some(c.root.clone()),
        ..MockOptions::default()
    })
    .await;
    let a2 = MockGateway::start(MockOptions {
        forward_to: Some(b2.root.clone()),
        ..MockOptions::default()
    })
    .await;
    let res = resolve_gateway(&a2.root).await.unwrap();
    assert!(res.manifest.is_none(), "the chain is too long");
    assert!(!res.via_upstream);
    assert_eq!(res.ws_base, ws_base_of_root(&a2.root));
    a2.stop().await;
    b2.stop().await;
    c.stop().await;
}

/// A final manifest that does not list protocol v1 surfaces the
/// DISTINCT unsupported-protocol error: the phone's pairing fails with
/// it (not "gateway unreachable") and the desktop bridge refuses to
/// start (LAN-only fallback).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unsupported_protocol_fails_resolution_distinctly() {
    let _serial = HOST_SLOT_LOCK.lock().await;
    host_session_stop().await;
    store_code(None);
    clear_resolution_cache_for_test();

    let gateway = MockGateway::start(MockOptions {
        manifest: Some(ManifestSpec {
            protocol: vec!["v3".into()],
            ..ManifestSpec::default()
        }),
        ..MockOptions::default()
    })
    .await;

    // Resolution errors with the distinct marker.
    let err = resolve_gateway_cached(&gateway.root).await.unwrap_err();
    assert_eq!(err, UNSUPPORTED_PROTOCOL);
    // And it is NOT cached — every call re-surfaces it.
    let err = resolve_gateway_cached(&gateway.root).await.unwrap_err();
    assert_eq!(err, UNSUPPORTED_PROTOCOL);

    // The phone's pair path propagates it verbatim.
    let err = relay_pair(&gateway.root, "123456").await.unwrap_err();
    assert_eq!(err, UNSUPPORTED_PROTOCOL);
    assert_ne!(err, GATEWAY_UNREACHABLE);

    // The desktop bridge refuses to start; the relay stays offline.
    let err = host_session_start(&gateway.root, 1, &"a".repeat(64))
        .await
        .unwrap_err();
    assert_eq!(err, UNSUPPORTED_PROTOCOL);
    assert!(!relay_online());
    assert_eq!(current_gateway_info().provider, None);

    gateway.stop().await;
}

/// Numeric x.y.z comparison: suffix junk is ignored, missing parts
/// count as zero, equal strings pass.
#[test]
fn client_meets_minimum_compares_dotted_versions() {
    use super::client_meets_minimum as meets;
    assert!(meets("0.5.0", "0.5.0"));
    assert!(meets("0.5.1", "0.5.0"));
    assert!(meets("1.0.0", "0.9.9"));
    assert!(meets("0.5.0", "0.5"));
    assert!(meets("0.5.0", "0.5.0-beta"));
    assert!(meets("0.6.0-rc.1", "0.6.0"));
    assert!(!meets("0.4.9", "0.5.0"));
    assert!(!meets("0.5.0", "0.5.1"));
    assert!(!meets("0.10.0", "1.0.0"));
    // Junk minimum parts degrade to 0 — never strand a client over a
    // malformed field.
    assert!(meets("0.5.0", "not-a-version"));
}

/// A gateway whose health document demands a newer client surfaces the
/// DISTINCT too-old error (never the retryable unreachable marker),
/// identically on phone and desktop paths.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn min_client_version_gate_fails_distinctly() {
    let _serial = HOST_SLOT_LOCK.lock().await;
    host_session_stop().await;
    store_code(None);
    clear_resolution_cache_for_test();

    let gateway = MockGateway::start(MockOptions {
        manifest: Some(ManifestSpec {
            min_client_version: Some("99.0.0".into()),
            ..ManifestSpec::default()
        }),
        ..MockOptions::default()
    })
    .await;

    let err = resolve_gateway_cached(&gateway.root).await.unwrap_err();
    assert_eq!(err, CLIENT_TOO_OLD);
    assert_ne!(err, GATEWAY_UNREACHABLE);
    assert_ne!(err, UNSUPPORTED_PROTOCOL);
    // Not cached — every call re-surfaces it.
    assert_eq!(
        resolve_gateway_cached(&gateway.root).await.unwrap_err(),
        CLIENT_TOO_OLD
    );
    // The phone's pair path propagates it verbatim.
    assert_eq!(
        relay_pair(&gateway.root, "123456").await.unwrap_err(),
        CLIENT_TOO_OLD
    );
    // The desktop bridge refuses to start.
    assert_eq!(
        host_session_start(&gateway.root, 1, &"a".repeat(64))
            .await
            .unwrap_err(),
        CLIENT_TOO_OLD
    );

    gateway.stop().await;
}

/// A minClientVersion the client satisfies is a no-op.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn satisfied_min_client_version_passes() {
    clear_resolution_cache_for_test();
    let gateway = MockGateway::start(MockOptions {
        manifest: Some(ManifestSpec {
            min_client_version: Some("0.1.0".into()),
            ..ManifestSpec::default()
        }),
        ..MockOptions::default()
    })
    .await;
    let res = resolve_gateway_cached(&gateway.root).await.unwrap();
    assert!(res.manifest.is_some());
    gateway.stop().await;
}

/// The gateway's directory rate-limiting the phone (`err` +
/// `reason: rate_limited` on resolve) propagates as the DISTINCT
/// rate-limit error — not the generic unreachable marker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rate_limited_resolve_errors_propagate_distinctly() {
    clear_resolution_cache_for_test();
    let gateway = MockGateway::start(MockOptions {
        rate_limited: true,
        ..MockOptions::default()
    })
    .await;

    let err = relay_pair(&gateway.root, "123456").await.unwrap_err();
    assert_eq!(err, GATEWAY_RATE_LIMITED);
    assert_ne!(err, GATEWAY_UNREACHABLE);

    gateway.stop().await;
}

/// The byte-tunnel frame cap, both directions: a >256 KiB request
/// succeeds because the client CHUNKS its outgoing frames (the
/// enforcing mock rejects a raw oversized frame), and a ~600 KiB
/// response arrives in one sub-1-MiB inbound frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_writes_round_trip_via_chunking() {
    clear_resolution_cache_for_test();
    let gateway = MockGateway::start(MockOptions {
        echo: true,
        ..MockOptions::default()
    })
    .await;
    let res = resolve_gateway_cached(&gateway.root).await.unwrap();

    // A 600 KiB request body — well above the 256 KiB frame cap.
    let body: Vec<u8> = (0..600 * 1024).map(|i| (i % 251) as u8).collect();
    let req = tunnel_request("POST", "/echo", None, Some(&body));
    let data = ws_connect(&data_url(&res.ws_base, &"e".repeat(64), "echo1", "client"))
        .await
        .unwrap();
    let (head, resp) = tunnel_round_trip(data, &req, LIST_TIMEOUT)
        .await
        .unwrap_or_else(|e| panic!("chunked round trip must succeed: {e}"));
    assert_eq!(head.status, 200);
    assert_eq!(head.content_length(), Some(body.len() as u64));
    let echoed = resp.read_all(MAX_RESPONSE_BODY).await.unwrap();
    assert_eq!(echoed, body, "the echo body round-trips byte-exact");

    // Negative control: ONE raw oversized frame is rejected by the
    // enforcing mock — the chunker above is what made it pass.
    let mut data = ws_connect(&data_url(&res.ws_base, &"e".repeat(64), "echo2", "client"))
        .await
        .unwrap();
    data.send(Message::Binary(vec![1u8; MAX_OUTGOING_FRAME + 1].into()))
        .await
        .unwrap();
    let saw_close = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match data.next().await {
                Some(Ok(Message::Close(_))) | None => break true,
                Some(Ok(_)) => continue,
                Some(Err(_)) => break true,
            }
        }
    })
    .await;
    assert!(saw_close.is_ok(), "the mock must abort the oversized frame");

    gateway.stop().await;
}

/// Gateway unreachable → no code ever lands, relay stays offline (the
/// desktop's LAN-only fallback). The bridge keeps retrying in the
/// background and must stop cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dead_gateway_leaves_relay_offline() {
    let _serial = HOST_SLOT_LOCK.lock().await;
    // Defensive: a panicked earlier test could leave the global slot /
    // code watch dirty.
    host_session_stop().await;
    store_code(None);
    clear_resolution_cache_for_test();
    // Port 9 (discard) — nothing listens there; the manifest fetch and
    // every wss connect refuse fast.
    host_session_start("http://127.0.0.1:9", 1, &"a".repeat(64))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    assert!(!relay_online(), "no gateway → no code → LAN-only fallback");
    assert_eq!(current_relay_code(), None);
    host_session_stop().await;
    assert!(!relay_online());
}
