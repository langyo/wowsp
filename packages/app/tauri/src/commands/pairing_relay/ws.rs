use anyhow::{Result, anyhow};

use super::*;
// ── WebSocket plumbing ───────────────────────────────────────────────────────

/// The rustls ring provider must be the process default before the first
/// wss connect (tungstenite builds `ClientConfig::builder()`, which panics
/// without one). Android installs it at startup; elsewhere this is a no-op
/// after the first call. Idempotent and lock-free — `install_default` hands
/// back the previous provider if one exists.
fn ensure_ring_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(super) type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Client socket config: incoming messages/frames capped at
/// [`MAX_INCOMING_FRAME`] (the byte-tunnel contract) — anything larger
/// aborts the read instead of ballooning memory.
fn relay_ws_config() -> Option<WebSocketConfig> {
    Some(
        WebSocketConfig::default()
            .max_message_size(Some(MAX_INCOMING_FRAME))
            .max_frame_size(Some(MAX_INCOMING_FRAME)),
    )
}

// ── Proxy-aware dialing ─────────────────────────────────────────────────────
//
// The relay/gateway/pairing tunnels used to dial every WebSocket DIRECTLY,
// ignoring the Settings -> Network proxy — so on networks where the proxy
// is the only way out, every wss connect failed while the HTTP families
// worked. The dialer now builds the TCP leg through the configured proxy
// (HTTP CONNECT or a SOCKS5 handshake), lets tokio-tungstenite do the
// TLS + WebSocket handshake over whichever stream landed, and shares the
// HTTP chain's per-host direct-preference marks: a dead proxy demotes the
// host to direct for the TTL instead of paying a connect timeout on every
// reconnect. Loopback targets never ride the proxy (same rule as
// http_builder_for).

use crate::commands::upstream_health;

/// Host + port a tunnel dial resolves to.
struct TargetAddr {
    host: String,
    port: u16,
}

/// One parsed proxy endpoint. `socks5h` is folded onto `socks5` here:
// both spellings mean "let the proxy resolve the name", and the
// handshake below always sends the domain (ATYP 0x03) for non-IP hosts.
struct ProxyEndpoint {
    kind: ProxyKind,
    host: String,
    port: u16,
    user: Option<String>,
    password: Option<String>,
}

enum ProxyKind {
    Http,
    Socks5,
}

fn parse_proxy_endpoint(raw: &str) -> Result<ProxyEndpoint> {
    let url = reqwest::Url::parse(raw).map_err(|e| anyhow!("proxy url: {e}"))?;
    let kind = match url.scheme().to_ascii_lowercase().as_str() {
        "http" => ProxyKind::Http,
        "socks5" | "socks5h" => ProxyKind::Socks5,
        "https" => {
            return Err(anyhow!(
                "https-scheme proxies cannot carry the websocket tunnel yet"
            ));
        },
        other => return Err(anyhow!("unsupported proxy scheme {other}")),
    };
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("proxy url has no host"))?
        .to_string();
    let port = url.port().unwrap_or(match kind {
        ProxyKind::Http => 8080,
        ProxyKind::Socks5 => 1080,
    });
    let user = match url.username() {
        "" => None,
        u => Some(u.to_string()),
    };
    let password = url.password().map(str::to_string);
    Ok(ProxyEndpoint {
        kind,
        host,
        port,
        user,
        password,
    })
}

/// The TCP leg: through the configured proxy when one is in effect (and
/// the target is not loopback, and the host is not already demoted to
/// direct), direct otherwise.
async fn dial_transport(url: &str, config: &network::NetworkConfig) -> Result<TcpStream> {
    let parsed = reqwest::Url::parse(url).map_err(|e| anyhow!("relay url: {e}"))?;
    let host = parsed.host_str().unwrap_or_default().to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let target = TargetAddr {
        host: host.clone(),
        port,
    };

    if let Some(proxy_url) = network::effective_proxy(config) {
        if !upstream_health::is_loopback_host(&host) && !upstream_health::host_prefers_direct(&host)
        {
            // A proxy URL that cannot carry the tunnel (e.g. an
            // https-scheme proxy) falls back WITHOUT a demotion mark:
            // the mark is shared with the HTTP chain, whose https proxy
            // may be perfectly healthy. Only a DIALED tunnel failing
            // demotes the host.
            let tunneled = match parse_proxy_endpoint(&proxy_url) {
                Err(parse_err) => Err((parse_err, false)),
                Ok(_) => tunnel_through_proxy(&proxy_url, &target)
                    .await
                    .map_err(|e| (e, true)),
            };
            return match tunneled {
                Ok(stream) => Ok(stream),
                Err((err, dialed)) => {
                    if dialed {
                        tracing::info!(
                            host = %host,
                            error = %err,
                            "ws proxy transport failed — falling back to the direct path"
                        );
                        upstream_health::mark_host_direct_preferred(&host);
                    } else {
                        tracing::info!(
                            host = %host,
                            error = %err,
                            "ws proxy cannot carry the tunnel — dialing direct"
                        );
                    }
                    direct_tcp(&target).await
                },
            };
        }
    }
    direct_tcp(&target).await
}

async fn direct_tcp(target: &TargetAddr) -> Result<TcpStream> {
    TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|e| anyhow!("relay connect failed ({e})"))
}

/// Establish the tunnel leg: connect the proxy, then speak its greeting
/// (HTTP CONNECT or SOCKS5) for `target`. The returned stream is the raw
/// tunnel — TLS is the handshake layer's business.
async fn tunnel_through_proxy(proxy_url: &str, target: &TargetAddr) -> Result<TcpStream> {
    let endpoint = parse_proxy_endpoint(proxy_url)?;
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(|e| anyhow!("proxy connect failed ({e})"))?;
    match endpoint.kind {
        ProxyKind::Http => http_connect(stream, &endpoint, target).await,
        ProxyKind::Socks5 => socks5_handshake(stream, &endpoint, target).await,
    }
}

/// HTTP CONNECT through the proxy (RFC 7231 tunnel establishment). Any
/// non-200 head is a refusal. Basic proxy auth rides the request when the
/// proxy URL carries credentials.
async fn http_connect<S>(mut stream: S, endpoint: &ProxyEndpoint, target: &TargetAddr) -> Result<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut request = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n",
        host = target.host,
        port = target.port,
    );
    if endpoint.user.is_some() || endpoint.password.is_some() {
        use base64::Engine as _;
        let user = endpoint.user.clone().unwrap_or_default();
        let password = endpoint.password.clone().unwrap_or_default();
        let creds = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {creds}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| anyhow!("proxy write failed ({e})"))?;

    let mut buf: Vec<u8> = Vec::with_capacity(512);
    let mut chunk = [0u8; 256];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| anyhow!("proxy read failed ({e})"))?;
        if n == 0 {
            return Err(anyhow!("proxy closed during CONNECT"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8 * 1024 {
            return Err(anyhow!("proxy CONNECT response head too large"));
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head.lines().next().unwrap_or_default();
    // The SECOND whitespace token must be exactly 200: a bare
    // contains(" 200") would also accept reason phrases carrying the
    // digits ("504 Gateway Timeout after 2000ms"). Other 2xx codes are
    // rejected too — conservative, and no proxy in the wild answers
    // CONNECT with 201.
    let status_ok = status.starts_with("HTTP/") && status.split_whitespace().nth(1) == Some("200");
    if !status_ok {
        return Err(anyhow!("proxy refused CONNECT: {}", status.trim()));
    }
    Ok(stream)
}

/// SOCKS5 (RFC 1928) with optional username/password auth (RFC 1929).
/// Non-IP targets are always sent as domains (ATYP 0x03) — the proxy
/// resolves the name, which is also what the socks5h spelling promises.
async fn socks5_handshake<S>(
    mut stream: S,
    endpoint: &ProxyEndpoint,
    target: &TargetAddr,
) -> Result<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    async fn read_exact<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
        stream: &mut S,
        buf: &mut [u8],
    ) -> Result<()> {
        stream
            .read_exact(buf)
            .await
            .map(|_| ())
            .map_err(|e| anyhow!("socks5 proxy closed ({e})"))
    }

    let has_auth = endpoint.user.is_some() || endpoint.password.is_some();
    // Greeting: ver, nmethods, methods (0x00 no-auth, 0x02 user/pass).
    let greeting: &[u8] = if has_auth {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    stream
        .write_all(greeting)
        .await
        .map_err(|e| anyhow!("socks5 write failed ({e})"))?;
    let mut selection = [0u8; 2];
    read_exact(&mut stream, &mut selection).await?;
    if selection[0] != 0x05 {
        return Err(anyhow!("not a socks5 proxy"));
    }
    match selection[1] {
        0x00 => {},
        0x02 if has_auth => {
            let user = endpoint.user.clone().unwrap_or_default();
            let password = endpoint.password.clone().unwrap_or_default();
            if user.len() > 255 || password.len() > 255 {
                return Err(anyhow!("socks5 credentials too long"));
            }
            let mut auth = Vec::with_capacity(3 + user.len() + password.len());
            auth.push(0x01);
            auth.push(user.len() as u8);
            auth.extend_from_slice(user.as_bytes());
            auth.push(password.len() as u8);
            auth.extend_from_slice(password.as_bytes());
            stream
                .write_all(&auth)
                .await
                .map_err(|e| anyhow!("socks5 write failed ({e})"))?;
            let mut verdict = [0u8; 2];
            read_exact(&mut stream, &mut verdict).await?;
            if verdict[1] != 0x00 {
                return Err(anyhow!("socks5 authentication failed"));
            }
        },
        0xFF => return Err(anyhow!("socks5 proxy accepts no offered auth method")),
        other => return Err(anyhow!("socks5 proxy chose unsupported auth 0x{other:02x}")),
    }

    // Connect request: ver, cmd=connect, rsv, atyp, addr, port.
    let mut request = vec![0x05, 0x01, 0x00];
    // reqwest::Url keeps IPv6 literals bracketed ("[2001:db8::1]") —
    // strip the brackets so the IP ATYP arms are reachable instead of
    // shipping the bracketed form as an unresolvable domain.
    let bare_host = target.host.trim_start_matches('[').trim_end_matches(']');
    match bare_host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            request.push(0x01);
            request.extend_from_slice(&v4.octets());
        },
        Ok(std::net::IpAddr::V6(v6)) => {
            request.push(0x04);
            request.extend_from_slice(&v6.octets());
        },
        Err(_) => {
            let name = target.host.as_bytes();
            if name.len() > 255 {
                return Err(anyhow!("socks5 target name too long"));
            }
            request.push(0x03);
            request.push(name.len() as u8);
            request.extend_from_slice(name);
        },
    }
    request.extend_from_slice(&target.port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|e| anyhow!("socks5 write failed ({e})"))?;

    let mut reply = [0u8; 4];
    read_exact(&mut stream, &mut reply).await?;
    if reply[1] != 0x00 {
        return Err(anyhow!("socks5 connect failed (reply 0x{:02x})", reply[1]));
    }
    // Skip the bound address so the stream starts at the tunnel's first
    // byte — anything the proxy sends belongs to the tunnel itself.
    let extra = match reply[3] {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut len = [0u8; 1];
            read_exact(&mut stream, &mut len).await?;
            len[0] as usize + 2
        },
        other => return Err(anyhow!("socks5 reply has unknown atyp 0x{other:02x}")),
    };
    let mut bound = vec![0u8; extra];
    read_exact(&mut stream, &mut bound).await?;
    Ok(stream)
}

pub(crate) async fn ws_connect(url: &str) -> Result<Ws> {
    ws_connect_with(url, &network::load_config()).await
}

/// The testable core: dial the transport under an explicit network
/// config, then run the WebSocket (and, for wss, TLS) handshake over
/// whichever stream landed.
pub(super) async fn ws_connect_with(url: &str, config: &network::NetworkConfig) -> Result<Ws> {
    ensure_ring_provider();
    let fut = async {
        let stream = dial_transport(url, config).await?;
        client_async_tls_with_config(url, stream, relay_ws_config(), None)
            .await
            .map_err(|e| anyhow!("relay connect failed ({e})"))
    };
    let (ws, _resp) = tokio::time::timeout(WS_CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| {
            anyhow!("relay connect failed (no handshake within {WS_CONNECT_TIMEOUT:?})")
        })??;
    Ok(ws)
}

/// Dial through ONE explicit proxy URL, skipping the policy layer
/// (loopback exemption, direct preference) — the machinery entry the
/// tunnel tests drive.
#[cfg(test)]
pub(super) async fn ws_connect_via(url: &str, proxy_url: &str) -> Result<Ws> {
    ensure_ring_provider();
    let parsed = reqwest::Url::parse(url).map_err(|e| anyhow!("relay url: {e}"))?;
    let target = TargetAddr {
        host: parsed.host_str().unwrap_or_default().to_string(),
        port: parsed.port_or_known_default().unwrap_or(80),
    };
    let fut = async {
        let stream = tunnel_through_proxy(proxy_url, &target).await?;
        client_async_tls_with_config(url, stream, relay_ws_config(), None)
            .await
            .map_err(|e| anyhow!("relay connect failed ({e})"))
    };
    let (ws, _resp) = tokio::time::timeout(WS_CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| {
            anyhow!("relay connect failed (no handshake within {WS_CONNECT_TIMEOUT:?})")
        })??;
    Ok(ws)
}

/// The keepalive text frame every relay socket pings while idle (a TEXT
/// frame — WS-level pings never reach the worker's Durable Object; the
/// v1 flow tolerated them from day one).
pub(crate) fn keepalive_text() -> tokio_tungstenite::tungstenite::Utf8Bytes {
    json!({ "type": "keepalive" }).to_string().into()
}

/// Spawned 30 s text-ping pumper owning one socket's write half (the read
/// half stays with the caller — split sockets never tear the TCP stream
/// while either half lives). Dropping or shutting the handle makes the task
/// send a best-effort Close and exit.
pub(super) struct KeepaliveTask {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl KeepaliveTask {
    fn spawn<S>(sink: SplitSink<WebSocketStream<S>, Message>) -> Self
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut sink = sink;
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    _ = tokio::time::sleep(KEEPALIVE_INTERVAL) => {
                        if sink.send(Message::Text(keepalive_text())).await.is_err() {
                            break;
                        }
                    },
                }
            }
            let _ = sink.send(Message::Close(None)).await;
            let _ = sink.flush().await;
        });
        Self { stop, task }
    }

    /// Stop the pumper (it sends Close and exits promptly).
    pub(super) async fn shutdown(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.task).await;
    }
}

/// Split a connected socket for the keepalive pumper: reads stay with the
/// caller, the pumper holds the write half.
pub(super) fn park_keepalive(ws: Ws) -> (SplitStream<Ws>, KeepaliveTask) {
    let (sink, stream) = ws.split();
    let ka = KeepaliveTask::spawn(sink);
    (stream, ka)
}

/// Outgoing binary frames are capped at [`MAX_OUTGOING_FRAME`] (the worker
/// rejects larger frames); a larger write is split into consecutive frames —
/// byte-tunnel semantics make the split invisible (frames reassemble on the
/// peer's TCP side).
pub(super) fn frame_chunks(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.chunks(MAX_OUTGOING_FRAME)
}

pub(super) async fn send_binary_chunked<S>(ws: &mut S, bytes: &[u8]) -> Result<()>
where
    S: futures::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    for chunk in frame_chunks(bytes) {
        ws.send(Message::Binary(chunk.to_vec().into()))
            .await
            .map_err(|e| anyhow!("tunnel send failed ({e})"))?;
    }
    Ok(())
}

/// Control-channel messages (JSON text frames). Both ends of the tunnel
/// agree on exactly these.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum ControlMsg {
    /// Worker → client: v2 handshake welcome (protocol v1 accepted).
    Welcome,
    /// Worker → client: the host for this room is present.
    Ready,
    /// Worker → client: no host yet, keep waiting.
    Waiting,
    /// Client → worker: please open data conn `id`.
    Open { id: String },
    /// Worker → host: the client wants data conn `id`.
    Conn { id: String },
    /// Host → worker: please allocate a fresh pairing code for this room.
    Allocate,
    /// Worker → host: the freshly allocated pairing code.
    Code { code: String },
    /// Worker → host: code allocation failed (directory error) — the bridge
    /// treats it like a dropped socket and reconnects.
    AllocFailed,
    /// Worker → phone: the room key the resolved code is bound to.
    Room { room: String },
    /// Worker → phone: the code is unknown/expired, or the resolve request
    /// was refused (`reason` — e.g. `rate_limited`).
    ResolveError { reason: Option<String> },
}

impl ControlMsg {
    pub(super) fn to_text(&self) -> String {
        match self {
            ControlMsg::Welcome => json!({ "type": "welcome" }).to_string(),
            ControlMsg::Ready => json!({ "type": "ready" }).to_string(),
            ControlMsg::Waiting => json!({ "type": "waiting" }).to_string(),
            ControlMsg::Open { id } => json!({ "type": "open", "connId": id }).to_string(),
            ControlMsg::Conn { id } => json!({ "type": "conn", "connId": id }).to_string(),
            ControlMsg::Allocate => json!({ "type": "allocate" }).to_string(),
            ControlMsg::Code { code } => json!({ "type": "code", "code": code }).to_string(),
            ControlMsg::AllocFailed => json!({ "type": "allocFailed" }).to_string(),
            ControlMsg::Room { room } => json!({ "type": "room", "room": room }).to_string(),
            ControlMsg::ResolveError { reason } => match reason {
                Some(r) => json!({ "type": "err", "reason": r }).to_string(),
                None => json!({ "type": "err" }).to_string(),
            },
        }
    }

    pub(super) fn parse(text: &str) -> Option<ControlMsg> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        match v.get("type")?.as_str()? {
            "welcome" => Some(ControlMsg::Welcome),
            "ready" => Some(ControlMsg::Ready),
            "waiting" => Some(ControlMsg::Waiting),
            "open" => Some(ControlMsg::Open {
                id: v.get("connId")?.as_str()?.to_string(),
            }),
            "conn" => Some(ControlMsg::Conn {
                id: v.get("connId")?.as_str()?.to_string(),
            }),
            "allocate" => Some(ControlMsg::Allocate),
            "code" => Some(ControlMsg::Code {
                code: v.get("code")?.as_str()?.to_string(),
            }),
            "allocFailed" => Some(ControlMsg::AllocFailed),
            "room" => Some(ControlMsg::Room {
                room: v.get("room")?.as_str()?.to_string(),
            }),
            "err" => Some(ControlMsg::ResolveError {
                reason: v.get("reason").and_then(|r| r.as_str()).map(str::to_string),
            }),
            _ => None,
        }
    }
}

/// Pull the next TEXT control message (binary frames and pings are skipped).
pub(super) async fn next_control<S>(ws: &mut WebSocketStream<S>) -> Result<ControlMsg>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                if let Some(m) = ControlMsg::parse(&t) {
                    return Ok(m);
                }
            },
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(f))) => {
                return Err(anyhow!(
                    "relay control closed ({})",
                    f.as_ref().map(|f| f.code.to_string()).unwrap_or_default()
                ));
            },
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(anyhow!("relay control read failed ({e})")),
            None => return Err(anyhow!("relay control closed")),
        }
    }
}

/// Outcome of the v2 socket handshake (hello → welcome).
pub(super) enum HelloOutcome {
    /// The server welcomed us under protocol v1.
    Welcome,
    /// The server skipped the welcome and went straight into the legacy v1
    /// flow — this is the FIRST control message of it (the caller processes
    /// it as if it had just been read).
    First(ControlMsg),
    /// Nothing arrived within [`HELLO_TIMEOUT`] — a legacy v1 server that
    /// ignores unknown text frames; proceed with the v1 flow.
    Silent,
}

/// Perform the v2 handshake on a freshly-opened control/resolve socket:
/// send `hello` (protocol v1, persistent hostId) and await the welcome with
/// legacy tolerance (see [`HelloOutcome`]). NOT used on data sockets —
/// those are byte tunnels.
pub(super) async fn hello_handshake(ws: &mut Ws) -> Result<HelloOutcome> {
    let hello =
        json!({ "type": "hello", "protocol": "v1", "hostId": persistent_host_id() }).to_string();
    ws.send(Message::Text(hello.into()))
        .await
        .map_err(|e| anyhow!("relay hello failed ({e})"))?;
    match tokio::time::timeout(HELLO_TIMEOUT, next_control(ws)).await {
        Ok(Ok(ControlMsg::Welcome)) => Ok(HelloOutcome::Welcome),
        Ok(Ok(other)) => Ok(HelloOutcome::First(other)),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(HelloOutcome::Silent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::duplex;

    fn endpoint(kind: ProxyKind, user: Option<&str>, password: Option<&str>) -> ProxyEndpoint {
        ProxyEndpoint {
            kind,
            host: "proxy.example".to_string(),
            port: 1080,
            user: user.map(str::to_string),
            password: password.map(str::to_string),
        }
    }

    fn target() -> TargetAddr {
        TargetAddr {
            host: "relay.example".to_string(),
            port: 443,
        }
    }

    /// Read until the end of an HTTP-shaped head on one duplex end, reply
    /// `response`, and hand the captured request back.
    async fn duplex_http_peer(
        response: &'static str,
    ) -> (
        tokio::io::DuplexStream,
        tokio::sync::oneshot::Receiver<String>,
    ) {
        let (client, mut server) = duplex(64);
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 256];
            loop {
                let n = server.read(&mut chunk).await.expect("peer read");
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&buf).to_string());
            server
                .write_all(response.as_bytes())
                .await
                .expect("peer write");
        });
        (client, rx)
    }

    #[test]
    fn proxy_endpoint_parses_defaults_and_rejects() {
        let http = parse_proxy_endpoint("http://proxy.example").expect("http");
        assert!(matches!(http.kind, ProxyKind::Http));
        assert_eq!(http.port, 8080, "http default port");
        assert!(http.user.is_none() && http.password.is_none());

        let socks = parse_proxy_endpoint("socks5h://u:p@proxy.example:7891").expect("socks");
        assert!(matches!(socks.kind, ProxyKind::Socks5));
        assert_eq!(socks.port, 7891);
        assert_eq!(socks.user.as_deref(), Some("u"));
        assert_eq!(socks.password.as_deref(), Some("p"));

        assert!(parse_proxy_endpoint("https://proxy.example").is_err());
        assert!(parse_proxy_endpoint("ftp://proxy.example").is_err());
    }

    #[tokio::test]
    async fn http_connect_sends_absolute_form_and_accepts_200() {
        let (stream, rx) = duplex_http_peer("HTTP/1.1 200 Connection established\r\n\r\n").await;
        let out = http_connect(stream, &endpoint(ProxyKind::Http, None, None), &target())
            .await
            .expect("tunnel");
        drop(out);
        let request = rx.await.expect("captured");
        assert!(request.starts_with("CONNECT relay.example:443 HTTP/1.1\r\n"));
        assert!(request.contains("Host: relay.example:443\r\n"));
        assert!(!request.contains("Proxy-Authorization"));
    }

    #[tokio::test]
    async fn http_connect_carries_basic_auth() {
        let (stream, rx) = duplex_http_peer("HTTP/1.1 200 Connection established\r\n\r\n").await;
        let out = http_connect(
            stream,
            &endpoint(ProxyKind::Http, Some("user"), Some("pass")),
            &target(),
        )
        .await
        .expect("tunnel");
        drop(out);
        let request = rx.await.expect("captured");
        assert!(request.contains("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"));
    }

    #[tokio::test]
    async fn http_connect_rejects_non_200() {
        let (stream, _rx) = duplex_http_peer("HTTP/1.1 407 Proxy Auth Required\r\n\r\n").await;
        let err = http_connect(stream, &endpoint(ProxyKind::Http, None, None), &target())
            .await
            .expect_err("refused");
        assert!(err.to_string().contains("refused CONNECT"), "{err}");
    }

    /// Scripted SOCKS5 peer: capture every request byte, drive the chosen
    /// script of replies, and report the connect request back.
    async fn duplex_socks5_peer(
        reply_greeting: &'static [u8],
        reply_auth: Option<&'static [u8]>,
        reply_connect: &'static [u8],
    ) -> (
        tokio::io::DuplexStream,
        tokio::sync::oneshot::Receiver<Vec<u8>>,
    ) {
        let (client, mut server) = duplex(64);
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            // greeting: ver, nmethods, then that many method bytes.
            let mut pre = [0u8; 2];
            server.read_exact(&mut pre).await.expect("greeting pre");
            let mut methods = vec![0u8; pre[1] as usize];
            server
                .read_exact(&mut methods)
                .await
                .expect("greeting methods");
            server
                .write_all(reply_greeting)
                .await
                .expect("greeting write");
            if let Some(auth_reply) = reply_auth {
                // auth request: ver, ulen, user..., plen, pass... — read
                // one byte at a time is overkill; read 2 then the rest.
                let mut pre = [0u8; 2];
                server.read_exact(&mut pre).await.expect("auth pre");
                let mut rest = vec![0u8; pre[1] as usize];
                server.read_exact(&mut rest).await.expect("auth user");
                let mut plen = [0u8; 1];
                server.read_exact(&mut plen).await.expect("auth plen");
                let mut pass = vec![0u8; plen[0] as usize];
                server.read_exact(&mut pass).await.expect("auth pass");
                server.write_all(auth_reply).await.expect("auth write");
            }
            // connect request: ver, cmd, rsv, atyp — then the address.
            let mut req_head = [0u8; 4];
            server.read_exact(&mut req_head).await.expect("req head");
            let mut captured = req_head.to_vec();
            let addr_len = match req_head[3] {
                0x01 => 4,
                0x04 => 16,
                0x03 => {
                    let mut l = [0u8; 1];
                    server.read_exact(&mut l).await.expect("domain len");
                    captured.push(l[0]);
                    l[0] as usize
                },
                other => panic!("bad atyp {other}"),
            };
            let mut rest = vec![0u8; addr_len + 2];
            server.read_exact(&mut rest).await.expect("req rest");
            captured.extend_from_slice(&rest);
            let _ = tx.send(captured);
            server.write_all(reply_connect).await.expect("reply write");
        });
        (client, rx)
    }

    #[tokio::test]
    async fn socks5_no_auth_sends_domain_target() {
        let (stream, rx) = duplex_socks5_peer(
            &[0x05, 0x00],
            None,
            &[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0x00, 0x00],
        )
        .await;
        let out = socks5_handshake(stream, &endpoint(ProxyKind::Socks5, None, None), &target())
            .await
            .expect("tunnel");
        drop(out);
        let req = rx.await.expect("captured");
        assert_eq!(
            &req[..4],
            &[0x05, 0x01, 0x00, 0x03][..],
            "connect, domain atyp"
        );
        assert_eq!(req[4] as usize, "relay.example".len());
        assert_eq!(&req[5..5 + req[4] as usize], b"relay.example");
        assert_eq!(&req[req.len() - 2..], &[0x01, 0xBB][..], "port 443");
    }

    #[tokio::test]
    async fn socks5_user_pass_auth_round_trips() {
        let (stream, rx) = duplex_socks5_peer(
            &[0x05, 0x02],
            Some(&[0x01, 0x00]),
            &[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0x00, 0x00],
        )
        .await;
        let out = socks5_handshake(
            stream,
            &endpoint(ProxyKind::Socks5, Some("user"), Some("pass")),
            &target(),
        )
        .await
        .expect("tunnel");
        drop(out);
        let req = rx.await.expect("captured");
        assert_eq!(&req[..4], &[0x05, 0x01, 0x00, 0x03][..]);
    }

    #[tokio::test]
    async fn socks5_failure_reply_is_an_error() {
        let (stream, _rx) = duplex_socks5_peer(
            &[0x05, 0x00],
            None,
            &[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0x00, 0x00],
        )
        .await;
        let err = socks5_handshake(stream, &endpoint(ProxyKind::Socks5, None, None), &target())
            .await
            .expect_err("refused");
        assert!(err.to_string().contains("socks5 connect failed"), "{err}");
    }

    fn manual_config(proxy: String) -> network::NetworkConfig {
        network::NetworkConfig {
            mode: network::ProxyMode::Manual,
            proxy: Some(proxy),
            ..network::NetworkConfig::default()
        }
    }

    /// A refused proxy port demotes the host to the direct path for the
    /// TTL window (shared marks with the HTTP chain).
    #[tokio::test]
    async fn dead_proxy_demotes_the_host() {
        let dead = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            drop(listener);
            addr
        };
        let host = "ws-demote-test.invalid";
        let cfg = manual_config(format!("http://{dead}"));
        let url = format!("wss://{host}/api/relay");
        let first = dial_transport(&url, &cfg).await;
        assert!(first.is_err(), "the invalid host cannot resolve either way");
        assert!(
            upstream_health::host_prefers_direct(host),
            "the proxy failure demotes the host"
        );
        // Second dial: the mark is fresh, so the proxy arm is skipped
        // entirely — same terminal error, one dead-proxy attempt less.
        let second = dial_transport(&url, &cfg).await;
        assert!(second.is_err());
    }

    /// Loopback targets never ride the proxy (same rule as the HTTP
    /// chain) and never burn a demotion mark.
    #[tokio::test]
    async fn loopback_target_dials_direct() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let dead = {
            let refused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let a = refused.local_addr().unwrap();
            drop(refused);
            a
        };
        let cfg = manual_config(format!("http://{dead}"));
        let stream = dial_transport(&format!("ws://{addr}/"), &cfg)
            .await
            .expect("loopback dials direct despite the manual proxy");
        drop(stream);
        drop(listener);
        assert!(!upstream_health::host_prefers_direct("127.0.0.1"));
    }

    /// End to end over a REAL local pair: an HTTP proxy stub (CONNECT +
    /// bidirectional bridge) and a ws:// echo server, dialed through
    /// ws_connect_via — the machinery entry the policy layer wraps.
    #[tokio::test]
    async fn ws_over_http_proxy_end_to_end() {
        let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_addr = ws_listener.local_addr().unwrap();
        let ws_task = tokio::spawn(async move {
            let (sock, _) = ws_listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            if let Some(Ok(Message::Text(t))) = ws.next().await {
                ws.send(Message::Text(t)).await.unwrap();
            }
            let _ = ws.close(None).await;
        });

        let px_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let px_addr = px_listener.local_addr().unwrap();
        let px_task = tokio::spawn(async move {
            let (mut sock, _) = px_listener.accept().await.unwrap();
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 512];
            loop {
                let n = sock.read(&mut chunk).await.unwrap();
                if n == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buf);
            let target = head
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .expect("CONNECT target")
                .to_string();
            sock.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let mut upstream = tokio::net::TcpStream::connect(&target).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
        });

        let url = format!("ws://{ws_addr}/");
        let proxy = format!("http://{px_addr}");
        let mut ws = ws_connect_via(&url, &proxy)
            .await
            .expect("ws over the proxy");
        ws.send(Message::Text("ping".into())).await.unwrap();
        match ws.next().await {
            Some(Ok(Message::Text(t))) => assert_eq!(t.as_str(), "ping"),
            other => panic!("no echo: {other:?}"),
        }
        // Teardown is best-effort and BOUNDED: the assertions above are
        // the verdict, and a half-closed copy_bidirectional pair can
        // otherwise linger on Windows loopback for minutes.
        let _ = ws.close(None).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), ws_task).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), px_task).await;
    }
}
