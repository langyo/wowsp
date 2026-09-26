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

pub(super) async fn ws_connect(url: &str) -> Result<Ws, String> {
    ensure_ring_provider();
    let connect = connect_async_with_config(url, relay_ws_config(), false);
    let (ws, _resp) = tokio::time::timeout(WS_CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| format!("relay connect failed (no handshake within {WS_CONNECT_TIMEOUT:?})"))?
        .map_err(|e| format!("relay connect failed ({e})"))?;
    Ok(ws)
}

/// The keepalive text frame every relay socket pings while idle (a TEXT
/// frame — WS-level pings never reach the worker's Durable Object; the
/// v1 flow tolerated them from day one).
pub(super) fn keepalive_text() -> tokio_tungstenite::tungstenite::Utf8Bytes {
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

pub(super) async fn send_binary_chunked<S>(ws: &mut S, bytes: &[u8]) -> Result<(), String>
where
    S: futures::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    for chunk in frame_chunks(bytes) {
        ws.send(Message::Binary(chunk.to_vec().into()))
            .await
            .map_err(|e| format!("tunnel send failed ({e})"))?;
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
pub(super) async fn next_control<S>(ws: &mut WebSocketStream<S>) -> Result<ControlMsg, String>
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
                return Err(format!(
                    "relay control closed ({})",
                    f.as_ref().map(|f| f.code.to_string()).unwrap_or_default()
                ));
            },
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("relay control read failed ({e})")),
            None => return Err("relay control closed".to_string()),
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
pub(super) async fn hello_handshake(ws: &mut Ws) -> Result<HelloOutcome, String> {
    let hello =
        json!({ "type": "hello", "protocol": "v1", "hostId": persistent_host_id() }).to_string();
    ws.send(Message::Text(hello.into()))
        .await
        .map_err(|e| format!("relay hello failed ({e})"))?;
    match tokio::time::timeout(HELLO_TIMEOUT, next_control(ws)).await {
        Ok(Ok(ControlMsg::Welcome)) => Ok(HelloOutcome::Welcome),
        Ok(Ok(other)) => Ok(HelloOutcome::First(other)),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(HelloOutcome::Silent),
    }
}
