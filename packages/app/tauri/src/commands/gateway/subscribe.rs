use anyhow::anyhow;

use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tauri::Emitter as _;
use tokio_tungstenite::tungstenite::Message;

use wowsp_tauri_shared::CommandResult;

use super::*;
// ── subscriber (all targets — the phone, gateway-push §3.3/§6/§9) ─────────────

/// Text-ping interval — the relay sockets' 30 s (the server pings too).
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// Bound for the server's hello frame.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// Handle to the running subscriber session (one per device — the phone
/// subscribes to its OWN active account's channel).
struct SubscribeSession {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

fn subscribe_slot() -> &'static Mutex<Option<SubscribeSession>> {
    static SLOT: OnceLock<Mutex<Option<SubscribeSession>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Serializes start/stop so two racing calls never leak a task.
fn subscribe_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::const_new(()))
}

/// The subscriber state machine (gateway-push §6): resolve health →
/// captcha/password demands (`captcha` phase stops clean — the webui's
/// bottom-sheet widget re-calls with a token) → ticket exchange → sub
/// socket → every received text frame is re-emitted to the webui as a
/// `wowsp://gateway-battle` event, VERBATIM (`battle` frames AND the
/// `host` presence flips — the live view filters by `type`; the
/// server's keepalives are skipped). No auto-reconnect: a dropped socket
/// emits `error` and the waiting screen's connect button restarts it.
async fn subscribe_loop(
    app: tauri::AppHandle,
    root: String,
    route: String,
    turnstile_token: Option<String>,
    password: Option<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let emit = |phase: &str, detail: Option<String>| {
        emit_state(&app, "sub", Some(&route), phase, detail);
    };
    if *shutdown.borrow() {
        emit(PHASE_STOPPED, None);
        return;
    }
    emit(PHASE_RESOLVING, None);
    let health = match super::health::fetch_gateway_health(&root).await {
        Ok((_, doc)) => doc,
        Err(e) => {
            emit(PHASE_ERROR, Some(e.to_string()));
            return;
        },
    };
    match super::session::credential_readiness(
        &health,
        turnstile_token.as_deref(),
        password.as_deref(),
    ) {
        super::session::CredentialReadiness::Ready => {},
        super::session::CredentialReadiness::NeedCaptcha => {
            emit(
                PHASE_CAPTCHA,
                Some("gateway requires a captcha token".into()),
            );
            return;
        },
        super::session::CredentialReadiness::NeedPassword => {
            emit(PHASE_ERROR, Some("gateway requires a password".into()));
            return;
        },
    }
    let ticket = match super::session::open_gateway_session(
        &root,
        &route,
        turnstile_token.as_deref(),
        password.as_deref(),
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            let detail = e.to_string();
            let phase = if detail == GATEWAY_CAPTCHA_FAILED {
                PHASE_CAPTCHA
            } else {
                PHASE_ERROR
            };
            emit(phase, Some(detail));
            return;
        },
    };
    emit(PHASE_CONNECTING, None);
    let url = match sub_ws_url(&root, &route, &ticket.ticket) {
        Ok(u) => u,
        Err(e) => {
            emit(PHASE_ERROR, Some(e.to_string()));
            return;
        },
    };
    let mut ws = match pairing_relay::relay_ws_connect(&url).await {
        Ok(ws) => ws,
        Err(e) => {
            emit(
                PHASE_ERROR,
                Some(format!("gateway subscribe connect failed: {e}")),
            );
            return;
        },
    };
    // The server sends hello, then the host presence, then the live
    // snapshot (if any) — all forwarded below; hello itself just marks
    // the socket live.
    match tokio::time::timeout(HELLO_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(_))) => {},
        Ok(Some(Err(e))) => {
            emit(PHASE_ERROR, Some(format!("gateway subscribe dropped: {e}")));
            return;
        },
        Ok(None) | Err(_) => {
            emit(
                PHASE_ERROR,
                Some("gateway subscribe closed before hello".into()),
            );
            return;
        },
    }
    emit(PHASE_ONLINE, None);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                let _ = ws.close(None).await;
                emit(PHASE_STOPPED, None);
                return;
            },
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        // Forward VERBATIM as a JSON object: the live view
                        // maps the battle frames into its roster store and
                        // flips its waiting hint on host presence. The
                        // server's keepalive pings never reach the webui;
                        // a non-JSON text frame cannot be delivered as an
                        // object and is dropped with a note.
                        match serde_json::from_str::<serde_json::Value>(text.as_str()) {
                            // The server's keepalive pings never reach the
                            // webui; everything else forwards verbatim.
                            Ok(frame)
                                if frame.get("type").and_then(|t| t.as_str())
                                    == Some("keepalive") => {},
                            Ok(frame) => {
                                let _ = app.emit(GATEWAY_BATTLE_EVENT, frame);
                            },
                            Err(_) => {
                                tracing::debug!(
                                    "gateway sub received a non-JSON text frame; dropped"
                                );
                            },
                        }
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                    Some(Ok(Message::Close(_))) | None => {
                        emit(PHASE_ERROR, Some("gateway subscription ended".into()));
                        return;
                    },
                    Some(Ok(_)) => {},
                    Some(Err(e)) => {
                        emit(PHASE_ERROR, Some(format!("gateway subscribe read failed: {e}")));
                        return;
                    },
                }
            },
            _ = tokio::time::sleep(KEEPALIVE_INTERVAL) => {
                let _ = ws.send(Message::Text(pairing_relay::relay_keepalive_text())).await;
            },
        }
    }
}

/// Start (or replace) the subscriber for the phone's OWN active account
/// channel (`r:<realm>:<accountId>` — realm + account equality IS the
/// same-account confirmation). All outcomes ride the
/// `wowsp://gateway-state` phases (`role: "sub"`).
#[tauri::command]
pub async fn gateway_subscribe_start(
    app: tauri::AppHandle,
    root: String,
    route: String,
    turnstile_token: Option<String>,
    password: Option<String>,
) -> CommandResult<()> {
    if !super::session::valid_route(&route) {
        return Err(anyhow!("gateway route is malformed: {route}").into());
    }
    let root = normalize_root(&root)?;
    let _gate = subscribe_gate().lock().await;
    stop_subscribe().await;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(subscribe_loop(
        app,
        root,
        route,
        turnstile_token,
        password,
        shutdown_rx,
    ));
    *subscribe_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(SubscribeSession {
        shutdown: shutdown_tx,
        task,
    });
    Ok(())
}

/// Stop the subscriber.
#[tauri::command]
pub async fn gateway_subscribe_stop() -> CommandResult<()> {
    let _gate = subscribe_gate().lock().await;
    stop_subscribe().await;
    Ok(())
}

/// Stop half shared with `gateway_set_config` (already gated).
pub(super) async fn stop_subscribe() {
    let joined = subscribe_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(session) = joined {
        let _ = session.shutdown.send(true);
        super::super::pairing::await_shutdown(session.task, Duration::from_secs(3)).await;
    }
}
