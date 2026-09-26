use super::*;
// ── desktop host bridge ──────────────────────────────────────────────────────

/// Handle to the running host session. `alloc_req` asks the bridge loop to
/// mint a fresh code (the regenerate button / config restarts).
struct HostSession {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
    alloc_req: tokio::sync::mpsc::UnboundedSender<()>,
}

fn host_slot() -> &'static Mutex<Option<HostSession>> {
    static ST: OnceLock<Mutex<Option<HostSession>>> = OnceLock::new();
    ST.get_or_init(|| Mutex::new(None))
}

/// Start the host bridge session (desktop only; called from pairing_start
/// when the relay is enabled, and from pairing_set_relay on a live server).
/// Idempotent — an existing session is left running. The gateway ROOT is
/// resolved through the v2 manifest protocol first (cached per session); an
/// unsupported protocol fails the start (the desktop stays LAN-only), every
/// other resolution failure degrades to legacy direct mode. The room is the
/// 64-hex random id minted by the pairing server for this run.
#[cfg(desktop)]
pub async fn host_session_start(
    relay_root: &str,
    local_port: u16,
    room: &str,
) -> Result<(), String> {
    {
        let st = host_slot().lock().unwrap_or_else(|p| p.into_inner());
        if st.is_some() {
            return Ok(());
        }
    }
    if !valid_room(room) {
        return Err("invalid relay room key".to_string());
    }
    let resolution = resolve_gateway_cached(relay_root).await?;
    let info = gateway_info_of(&resolution);
    if let Some(notice) = &info.notice {
        tracing::info!(notice = %notice, "gateway operator notice");
    }
    store_gateway_info(Some(info));
    let ws_base = resolution.ws_base;
    let (tx, rx) = tokio::sync::watch::channel(false);
    let (alloc_tx, alloc_rx) = tokio::sync::mpsc::unbounded_channel();
    let room = room.to_string();
    let task = tokio::spawn(async move {
        host_bridge_loop(ws_base, local_port, room, rx, alloc_rx).await;
    });
    // A concurrent start won the race — retire ours (in a SEPARATE lock
    // scope: a std mutex guard must never ride an await) before parking
    // the new session.
    let raced = host_slot().lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(existing) = raced {
        let _ = existing.shutdown.send(true);
        let _ = existing.task.await;
    }
    *host_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(HostSession {
        shutdown: tx,
        task,
        alloc_req: alloc_tx,
    });
    tracing::info!("relay host session started");
    Ok(())
}

/// Stop the host bridge session (pairing_stop / live config change).
#[cfg(desktop)]
pub async fn host_session_stop() {
    let joined = host_slot().lock().unwrap_or_else(|p| p.into_inner()).take();
    store_code(None);
    store_gateway_info(None);
    if let Some(session) = joined {
        let _ = session.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(3), session.task).await;
        tracing::info!("relay host session stopped");
    }
}

/// Ask the running bridge for a FRESH pairing code (the desktop's
/// regenerate button): the worker replaces the room's old code (one active
/// code per host) and the new one lands in the live state + status.
#[cfg(desktop)]
pub async fn host_reallocate() -> Result<String, String> {
    let alloc = host_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|s| s.alloc_req.clone());
    let Some(tx) = alloc else {
        return Err("the internet relay session is not running".to_string());
    };
    let prev = current_relay_code();
    tx.send(())
        .map_err(|_| "relay session stopped".to_string())?;
    wait_for_new_code(prev.as_deref(), Duration::from_secs(15)).await
}

/// Regenerate the pairing code (desktop command): asks the gateway for a
/// fresh code over the live control WS and reports the new status (whose
/// `pin` now carries the new code).
#[tauri::command]
pub async fn pairing_reallocate_code() -> Result<PairingStatus, String> {
    #[cfg(mobile)]
    {
        return Err(crate::mobile_unsupported::PAIRING.to_string());
    }
    #[cfg(desktop)]
    {
        host_reallocate().await?;
        Ok(super::pairing::server::current_status_async().await)
    }
}

/// The control-channel loop: connect (with backoff), run the v2
/// hello/welcome handshake (legacy tolerance), ask for a pairing code,
/// answer conn signals, keepalive the room every 30 s; on any drop,
/// reconnect until shutdown.
#[cfg(desktop)]
async fn host_bridge_loop(
    ws_base: String,
    local_port: u16,
    room: String,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    mut alloc_req: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if *shutdown.borrow() {
            break;
        }
        let control = match tokio::time::timeout(Duration::from_secs(15), async {
            let mut ws = ws_connect(&control_url(&ws_base, &room, "host")).await?;
            match hello_handshake(&mut ws).await {
                Ok(HelloOutcome::Welcome) | Ok(HelloOutcome::Silent) => Ok((ws, None)),
                Ok(HelloOutcome::First(m)) => Ok((ws, Some(m))),
                Err(e) => Err(e),
            }
        })
        .await
        {
            Ok(Ok((ws, first))) => {
                // A v2 gateway may already have traffic queued behind the
                // welcome — process the first legacy message, if any.
                if let Some(m) = first {
                    match m {
                        ControlMsg::Code { code } => {
                            store_code(Some(code));
                            tracing::info!("pairing code allocated by the relay gateway");
                        },
                        ControlMsg::Conn { id } => {
                            tokio::spawn(bridge_one(ws_base.clone(), room.clone(), id, local_port));
                        },
                        _ => {},
                    }
                }
                ws
            },
            Ok(Err(e)) => {
                tracing::debug!(error = %e, "relay host connect failed; retrying");
                tokio::select! {
                    _ = shutdown.changed() => break,
                    _ = tokio::time::sleep(backoff) => {},
                }
                backoff = (backoff * 2).min(Duration::from_secs(30));
                continue;
            },
            Err(_) => {
                tracing::debug!("relay host connect timed out; retrying");
                continue;
            },
        };
        backoff = Duration::from_secs(1);
        tracing::info!("relay host control channel connected");
        let mut control = control;
        // Ask the worker for a fresh pairing code every time the control
        // channel is up (a reconnect also means the old code died with the
        // old room).
        if let Err(e) = control
            .send(Message::Text(ControlMsg::Allocate.to_text().into()))
            .await
        {
            tracing::debug!(error = %e, "relay host allocate send failed; reconnecting");
            continue;
        }
        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    let _ = control.close(None).await;
                    return;
                },
                // A fresh-sleep-in-arm keepalive: only fires when the
                // channel is otherwise idle for a full interval — any traffic
                // restarts the timer. The TEXT frame both refreshes the
                // room's idle TTL (WS-level pings never reach the DO) and
                // keeps Cloudflare's ~100s idle proxy drop at bay.
                _ = tokio::time::sleep(KEEPALIVE_INTERVAL) => {
                    let _ = control.send(Message::Text(keepalive_text())).await;
                },
                req = alloc_req.recv() => {
                    let Some(()) = req else {
                        // The session's request sender is gone — treat like
                        // a dropped socket so the outer loop parks on the
                        // shutdown watch instead of spinning.
                        break;
                    };
                    let _ = control
                        .send(Message::Text(ControlMsg::Allocate.to_text().into()))
                        .await;
                },
                msg = next_control(&mut control) => {
                    match msg {
                        Ok(ControlMsg::Code { code }) => {
                            store_code(Some(code));
                            // Never log the code itself.
                            tracing::info!("pairing code allocated by the relay gateway");
                        },
                        Ok(ControlMsg::AllocFailed) => {
                            tracing::warn!("relay code allocation failed; reconnecting");
                            break;
                        },
                        Ok(ControlMsg::Conn { id }) => {
                            tokio::spawn(bridge_one(
                                ws_base.clone(), room.clone(), id, local_port,
                            ));
                        },
                        Ok(_) => {},
                        Err(e) => {
                            tracing::debug!(error = %e, "relay host control dropped; reconnecting");
                            break;
                        },
                    }
                },
            }
        }
        // The channel is gone: the displayed code is dead with it.
        store_code(None);
        // Fell out of the inner loop — reconnect after a beat.
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tokio::time::sleep(backoff) => {},
        }
    }
}

/// Bridge one signaled connection: loopback TCP to the local pairing server
/// + a data WebSocket; bytes pipe verbatim until either side closes.
#[cfg(desktop)]
async fn bridge_one(ws_base: String, room: String, conn: String, local_port: u16) {
    let tcp = match tokio::time::timeout(
        Duration::from_secs(5),
        TcpStream::connect(("127.0.0.1", local_port)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        _ => {
            tracing::warn!(conn = %conn, "relay bridge: local server unreachable");
            return;
        },
    };
    let ws = match ws_connect(&data_url(&ws_base, &room, &conn, "host")).await {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!(conn = %conn, error = %e, "relay bridge: data connect failed");
            return;
        },
    };
    tracing::debug!(conn = %conn, "relay bridge: tunnel established");
    pipe_ws_tcp(ws, tcp).await;
}

/// Bidirectional byte pipe between a data WebSocket and a TCP stream. A TCP
/// EOF sends a Close downstream (the LAN server closes responses); a WS
/// close shuts the TCP write half so the server sees the end of its request.
/// Both directions chunk outgoing binary frames to the tunnel cap and text
/// ping every 30 s while idle (the phone's keepalives arrive as Text frames
/// and are skipped downstream).
async fn pipe_ws_tcp<S>(ws: WebSocketStream<S>, tcp: TcpStream)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut ws_sink, mut ws_stream) = ws.split();
    let (mut tcp_read, mut tcp_write) = tcp.into_split();

    // Downstream (WS → TCP): the request arrives in one frame, usually. Runs
    // on its own task so the current task can own the upstream direction.
    let up = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_stream.next().await {
            match msg {
                Message::Binary(b) => {
                    if tcp_write.write_all(&b).await.is_err() {
                        break;
                    }
                },
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Frame(_) => {},
            }
        }
        // End of the request — the LAN server reads Content-Length, so a
        // graceful shutdown of the write half suffices.
        let _ = tcp_write.shutdown().await;
    });

    // Upstream (TCP → WS): EOF (server done) → Close downstream. The
    // keepalive text ping only fires while the response stream is idle.
    let mut buf = vec![0u8; 16 * 1024];
    let mut idle_since = tokio::time::Instant::now();
    loop {
        let read = tcp_read.read(&mut buf);
        tokio::select! {
            res = read => match res {
                Ok(0) => {
                    let _ = ws_sink.send(Message::Close(None)).await;
                    break;
                },
                Ok(n) => {
                    if send_binary_chunked(&mut ws_sink, &buf[..n]).await.is_err() {
                        break;
                    }
                    idle_since = tokio::time::Instant::now();
                },
                Err(_) => break,
            },
            _ = tokio::time::sleep_until(idle_since + KEEPALIVE_INTERVAL) => {
                if ws_sink.send(Message::Text(keepalive_text())).await.is_err() {
                    break;
                }
                idle_since = tokio::time::Instant::now();
            },
        }
    }
    let _ = up.await;
}
