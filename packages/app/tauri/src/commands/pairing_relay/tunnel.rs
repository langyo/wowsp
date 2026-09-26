use super::*;
// ── HTTP-over-tunnel framing ────────────────────────────────────────────────

/// Parsed response head (the request side mirrors the LAN server's
/// `parse_head`).
#[derive(Debug)]
pub(super) struct ResponseHead {
    pub(super) status: u16,
    /// Lowercased header name → value.
    headers: Vec<(String, String)>,
}

impl ResponseHead {
    pub(super) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub(super) fn content_length(&self) -> Option<u64> {
        self.header("content-length")?.parse().ok()
    }
}

/// Parse `HTTP/1.1 200 OK\r\n…\r\n\r\n` from the front of `buf`; returns the
/// head and the byte offset just past the blank line.
pub(super) fn parse_response_head(buf: &[u8]) -> Result<(ResponseHead, usize), String> {
    let text = std::str::from_utf8(buf).map_err(|_| "non-UTF-8 response head".to_string())?;
    let (head, _rest) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "truncated response head".to_string())?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or("empty response")?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed status line: {status_line}"))?;
    if !version.starts_with("HTTP/") {
        return Err(format!("malformed status line: {status_line}"));
    }
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Ok((ResponseHead { status, headers }, head.len() + 4))
}

/// A tunnel response in progress: the data socket's read half plus buffered
/// bytes past the head. The keepalive pumper holds the write half (30 s
/// text pings while the response streams). `remaining` follows
/// Content-Length; `None` (no header — never happens with our server, but a
/// proxy could strip it) means read-until-close.
pub(super) struct TunnelBody {
    stream: SplitStream<Ws>,
    ka: KeepaliveTask,
    pending: Vec<u8>,
    remaining: Option<u64>,
    closed: bool,
}

impl TunnelBody {
    /// Next body chunk, or None at the end of the response. Chunks arrive
    /// already sized by Content-Length accounting.
    pub(super) async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        loop {
            if self.remaining == Some(0) {
                return Ok(None);
            }
            if !self.pending.is_empty() {
                let take = match self.remaining {
                    Some(r) => self.pending.len().min(r as usize),
                    None => self.pending.len(),
                };
                let chunk: Vec<u8> = self.pending.drain(..take).collect();
                if let Some(r) = self.remaining.as_mut() {
                    *r -= take as u64;
                }
                return Ok(Some(chunk));
            }
            if self.closed {
                return if self.remaining == Some(0) || self.remaining.is_none() {
                    Ok(None)
                } else {
                    Err("tunnel closed mid-response".to_string())
                };
            }
            match self.stream.next().await {
                Some(Ok(Message::Binary(b))) => self.pending.extend_from_slice(&b),
                Some(Ok(Message::Text(_))) => {
                    // The peer's 30 s keepalive ping rides the same socket —
                    // expected, skipped.
                },
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => {
                    self.closed = true;
                },
                Some(Err(e)) => return Err(format!("tunnel read failed ({e})")),
                Some(Ok(Message::Frame(_))) => {},
            }
        }
    }

    /// Read the WHOLE body (bounded — /pair and /api/replays only).
    pub(super) async fn read_all(mut self, cap: usize) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        while let Some(chunk) = self.next_chunk().await? {
            out.extend_from_slice(&chunk);
            if out.len() > cap {
                return Err("relay response too large".to_string());
            }
        }
        Ok(out)
    }

    /// Best-effort close (stop the keepalive pumper, which sends the Close
    /// frame; the read half drops with it).
    pub(super) async fn close(self) {
        self.ka.shutdown().await;
    }
}

/// Send raw HTTP request bytes on a freshly-opened data socket (chunked to
/// the frame cap), park the keepalive pumper, and parse the response head
/// off the reply.
pub(super) async fn tunnel_round_trip(
    mut data: Ws,
    request: &[u8],
    head_timeout: Duration,
) -> Result<(ResponseHead, TunnelBody), String> {
    send_binary_chunked(&mut data, request).await?;
    let (mut stream, ka) = park_keepalive(data);
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let head = tokio::time::timeout(head_timeout, async {
        loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                return parse_response_head(&buf[..pos + 4]).map(|(h, _)| (h, pos + 4));
            }
            if buf.len() > MAX_REQUEST_HEAD {
                return Err("relay response head too large".to_string());
            }
            match stream.next().await {
                Some(Ok(Message::Binary(b))) => buf.extend_from_slice(&b),
                Some(Ok(Message::Text(_))) => {},
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => {
                    return Err("tunnel closed before a response".to_string());
                },
                Some(Err(e)) => return Err(format!("tunnel read failed ({e})")),
                Some(Ok(_)) => {},
            }
        }
    })
    .await
    .map_err(|_| "no response within the tunnel deadline".to_string())??;
    let (head, consumed) = head;
    let body = TunnelBody {
        stream,
        ka,
        pending: buf[consumed..].to_vec(),
        remaining: head.content_length(),
        closed: false,
    };
    Ok((head, body))
}

/// A relay socket parked after its v1 handshake: the keepalive pumper owns
/// the write half, the read half is retained UNPOLLED — dropping it early
/// would tear the TCP stream down and with it the room.
pub(super) struct ParkedControl {
    #[allow(dead_code)] // held alive on purpose — see the struct doc
    reader: SplitStream<Ws>,
    ka: KeepaliveTask,
}

impl ParkedControl {
    /// Politely close (stop the pumper, which sends the Close frame).
    pub(super) async fn close(self) {
        self.ka.shutdown().await;
    }
}

/// One paired control+data tunnel. The data socket is handed to
/// [`tunnel_round_trip`] (which sends the request and streams the
/// response); the control socket stays parked — one keepalive frame per
/// 30 s keeps the room "live" while the request runs.
pub(super) struct Tunnel {
    pub(super) data: Ws,
    pub(super) control: ParkedControl,
}

/// Open a tunnel to `room`: control channel as client (hello/welcome with
/// legacy tolerance, waiting for the host if needed), then `{type:"open"}`,
/// then the data socket.
pub(super) async fn open_tunnel(ws_base: &str, room: &str) -> Result<Tunnel, String> {
    if !valid_room(room) {
        return Err("invalid relay room key".to_string());
    }
    let mut control = ws_connect(&control_url(ws_base, room, "client")).await?;
    let mut first: Option<ControlMsg> = None;
    match hello_handshake(&mut control).await {
        Ok(HelloOutcome::Welcome) | Ok(HelloOutcome::Silent) => {},
        Ok(HelloOutcome::First(m)) => first = Some(m),
        Err(e) => return Err(format!("relay handshake failed ({e})")),
    }
    // Wait for the host (bounded): the bridge reconnects within seconds, so
    // "waiting" for longer than READY_TIMEOUT means it is not coming.
    let ready = async {
        if let Some(m) = first {
            if matches!(m, ControlMsg::Ready) {
                return Ok::<(), String>(());
            }
        }
        loop {
            match next_control(&mut control).await? {
                ControlMsg::Ready => return Ok(()),
                _ => continue,
            }
        }
    };
    tokio::time::timeout(READY_TIMEOUT, ready)
        .await
        .map_err(|_| "relay host never became ready".to_string())??;

    let conn = conn_id()?;
    control
        .send(Message::Text(
            ControlMsg::Open { id: conn.clone() }.to_text().into(),
        ))
        .await
        .map_err(|e| format!("relay open failed ({e})"))?;
    let data = ws_connect(&data_url(ws_base, room, &conn, "client")).await?;
    let (reader, ka) = park_keepalive(control);
    Ok(Tunnel {
        data,
        control: ParkedControl { reader, ka },
    })
}

/// Build one tunnel request (Connection: close — the LAN protocol's shape).
pub(super) fn tunnel_request(
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&[u8]>,
) -> Vec<u8> {
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: relay\r\n");
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(b) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("Connection: close\r\n\r\n");
    let mut bytes = req.into_bytes();
    if let Some(b) = body {
        bytes.extend_from_slice(b);
    }
    bytes
}
