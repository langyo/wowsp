use super::*;
// ── client operations (all targets) — one per pairing route ─────────────────

/// Resolve a 6-digit pairing code to its room key via the gateway's
/// `/resolve` handshake (WS answered with a single `{"type":"room"}` frame;
/// the v2 hello/welcome runs first with legacy tolerance).
async fn resolve_room(ws_base: &str, code: &str) -> Result<String, String> {
    if !valid_code(code) {
        return Err(GATEWAY_UNREACHABLE.to_string());
    }
    let mut ws = ws_connect(&format!("{ws_base}/resolve?code={code}"))
        .await
        .map_err(|e| format!("resolve failed: {e}"))?;
    let mut first: Option<ControlMsg> = None;
    match hello_handshake(&mut ws).await {
        Ok(HelloOutcome::Welcome) | Ok(HelloOutcome::Silent) => {},
        Ok(HelloOutcome::First(m)) => first = Some(m),
        Err(e) => return Err(format!("resolve failed: {e}")),
    }
    let msg = match first {
        Some(m) => m,
        None => tokio::time::timeout(RESOLVE_TIMEOUT, next_control(&mut ws))
            .await
            .map_err(|_| "resolve timed out".to_string())??,
    };
    let _ = ws.close(None).await;
    match msg {
        ControlMsg::Room { room } => {
            if !valid_room(&room) {
                return Err("gateway resolved a malformed room key".to_string());
            }
            Ok(room)
        },
        ControlMsg::ResolveError { reason } => {
            if reason
                .as_deref()
                .is_some_and(|r| r.eq_ignore_ascii_case("rate_limited"))
            {
                Err(GATEWAY_RATE_LIMITED.to_string())
            } else {
                // Unknown/expired code — same friendly state as an offline
                // gateway.
                Err(GATEWAY_UNREACHABLE.to_string())
            }
        },
        other => Err(format!("unexpected resolve reply ({other:?})")),
    }
}

/// Map connection-phase failures onto the stable "gateway unreachable"
/// marker the frontend turns into a friendly retry state. Post-connection
/// errors (PIN rejected, host gone, timeouts) pass through untouched — and
/// so do the DISTINCT v2 resolution errors (unsupported protocol, rate
/// limited), which must never collapse into "unreachable".
pub(super) fn gateway_error(err: String) -> String {
    if err.contains("relay connect failed") || err.contains("resolve failed") {
        GATEWAY_UNREACHABLE.to_string()
    } else {
        err
    }
}

/// Pair through the gateway: resolve the 6-digit code the phone entered to
/// its room, then POST /pair through the tunnel. The code doubles as the
/// pin (the desktop accepts it exactly like its local PIN); the resolved
/// room key rides back in the result so the session's later tunnels are
/// addressed without asking the gateway again. `gateway` is the ROOT the
/// session resolves (any spelling — https/wss/http/ws host[:port]).
pub async fn relay_pair(gateway: &str, code: &str) -> Result<PairingToken, String> {
    let code = code.trim();
    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let room = resolve_room(&ws_base, code).await.map_err(gateway_error)?;
    let tunnel = open_tunnel(&ws_base, &room).await.map_err(gateway_error)?;
    let body = json!({ "pin": code }).to_string();
    let req = tunnel_request("POST", "/pair", None, Some(body.as_bytes()));
    let (head, resp) = tunnel_round_trip(tunnel.data, &req, PAIR_TIMEOUT).await?;
    let status = head.status;
    if status != 200 {
        resp.close().await;
        tunnel.control.close().await;
        return Err(http_error_status(status));
    }
    let bytes = resp.read_all(MAX_RESPONSE_BODY).await?;
    tunnel.control.close().await;
    let mut token: PairingToken =
        serde_json::from_slice(&bytes).map_err(|e| format!("pairing response parse: {e}"))?;
    // The room key the session's later tunnels are addressed by.
    token.room = Some(room);
    Ok(token)
}

/// GET /api/replays through the tunnel.
pub async fn relay_list_remote(
    gateway: &str,
    room: &str,
    token: &str,
) -> Result<Vec<ReplayMetaLite>, String> {
    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let tunnel = open_tunnel(&ws_base, room).await?;
    let req = tunnel_request("GET", "/api/replays", Some(token), None);
    let (head, resp) = tunnel_round_trip(tunnel.data, &req, LIST_TIMEOUT).await?;
    let status = head.status;
    if status != 200 {
        resp.close().await;
        tunnel.control.close().await;
        return Err(http_error_status(status));
    }
    let bytes = resp.read_all(MAX_RESPONSE_BODY).await?;
    tunnel.control.close().await;
    serde_json::from_slice(&bytes).map_err(|e| format!("replay list parse: {e}"))
}

/// Local progress emit that tolerates "no AppHandle" (unit tests). Real
/// callers always pass Some.
fn emit_opt(app: Option<&tauri::AppHandle>, progress: &PairingProgress) {
    if let Some(app) = app {
        emit_progress(app, progress);
    }
}

/// GET /api/replay/<name> through the tunnel, streamed to `dest` with the
/// same throttled progress events as the LAN pull.
pub(crate) async fn relay_pull_replay(
    app: Option<&tauri::AppHandle>,
    gateway: &str,
    room: &str,
    token: &str,
    remote_name: &str,
    dest: &std::path::Path,
) -> Result<u64, String> {
    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let tunnel = open_tunnel(&ws_base, room).await?;
    let path = format!(
        "/api/replay/{}",
        super::pairing::encode_path_segment(remote_name)
    );
    let req = tunnel_request("GET", &path, Some(token), None);
    let (head, mut body) = tunnel_round_trip(tunnel.data, &req, LIST_TIMEOUT).await?;
    let status = head.status;
    if status != 200 {
        body.close().await;
        tunnel.control.close().await;
        return Err(http_error_status(status));
    }
    let total = head.content_length().unwrap_or(0);
    use tokio::io::AsyncWriteExt as _;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    let mut last_emit = std::time::Instant::now();
    let result: Result<u64, String> = loop {
        match body.next_chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    break Err(format!("write {}: {e}", dest.display()));
                }
                received += chunk.len() as u64;
                since_emit += chunk.len() as u64;
                if since_emit >= 262_144
                    || (since_emit > 0 && last_emit.elapsed() >= Duration::from_millis(100))
                {
                    since_emit = 0;
                    last_emit = std::time::Instant::now();
                    emit_opt(
                        app,
                        &PairingProgress {
                            remote_name: remote_name.to_string(),
                            phase: "download".into(),
                            received,
                            total,
                            error: None,
                        },
                    );
                }
            },
            Ok(None) => break Ok(received),
            Err(e) => break Err(e),
        }
    };
    if result.is_ok() {
        let _ = file.flush().await;
        body.close().await;
        tunnel.control.close().await;
    }
    result
}

/// GET /api/gamedata through the tunnel — including the LAN client's
/// 503 + Retry-After patience loop — streamed into `dest` with progress
/// events under the `:gamedata:` sentinel.
pub(crate) async fn relay_pull_gamedata(
    app: Option<&tauri::AppHandle>,
    gateway: &str,
    room: &str,
    token: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    const GAMEDATA_PREPARE_BUDGET: Duration = Duration::from_secs(120);
    const RETRY_FALLBACK_SECS: u64 = 2;

    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let started = std::time::Instant::now();
    let (head, mut body) = loop {
        let tunnel = open_tunnel(&ws_base, room).await?;
        let req = tunnel_request("GET", "/api/gamedata", Some(token), None);
        let (head, body) = tunnel_round_trip(tunnel.data, &req, LIST_TIMEOUT).await?;
        tunnel.control.close().await;
        if head.status == 503 && started.elapsed() < GAMEDATA_PREPARE_BUDGET {
            let nap = head
                .header("retry-after")
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|s| (1..=10).contains(s))
                .unwrap_or(RETRY_FALLBACK_SECS);
            tracing::info!(nap_secs = nap, "relay host still building gamedata zip");
            body.close().await;
            tokio::time::sleep(Duration::from_secs(nap)).await;
            continue;
        }
        break (head, body);
    };
    let status = head.status;
    if status == 404 {
        return Err("no game data available on the host".to_string());
    }
    if status != 200 {
        body.close().await;
        return Err(http_error_status(status));
    }
    let total = head.content_length().unwrap_or(0);
    use tokio::io::AsyncWriteExt as _;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    let mut last_emit = std::time::Instant::now();
    let result: Result<(), String> = loop {
        match body.next_chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    break Err(format!("write {}: {e}", dest.display()));
                }
                received += chunk.len() as u64;
                since_emit += chunk.len() as u64;
                if since_emit >= 262_144
                    || (since_emit > 0 && last_emit.elapsed() >= Duration::from_millis(100))
                {
                    since_emit = 0;
                    last_emit = std::time::Instant::now();
                    emit_opt(
                        app,
                        &PairingProgress {
                            remote_name: GAMEDATA_SENTINEL.to_string(),
                            phase: "download".into(),
                            received,
                            total,
                            error: None,
                        },
                    );
                }
            },
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    if result.is_ok() {
        let _ = file.flush().await;
        body.close().await;
    }
    result
}

/// Status → the SAME clean strings the LAN client maps (the frontend toasts
/// these verbatim), plus the raw code for anything unanticipated.
fn http_error_status(status: u16) -> String {
    match status {
        400 | 401 | 403 | 404 | 429 | 503 => http_error(
            reqwest::StatusCode::from_u16(status)
                .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
        ),
        _ => format!("HTTP {status}"),
    }
}
