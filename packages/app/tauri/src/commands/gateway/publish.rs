use anyhow::{Result, anyhow, bail};

use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use wowsp_tauri_shared::{
    ArenaInfo, CommandResult, GatewayBattleFrame, GatewayBattleHead, GatewayBattleSelf,
    GatewayBattleVehicle, GatewayClientConfig, GatewaySessionTicket, PlayingAccount,
};

use super::*;
// ── desktop publisher (gateway-push §3.3/§5) ─────────────────────────────────

/// Text-ping interval on the pub socket — the relay sockets' 30 s (the
/// server pings too; any traffic keeps Cloudflare's ~100 s idle drop away).
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// How often the publisher checks the session hub's running flag for the
/// game-exit teardown (bye + close when the battle window ends).
const PROCESS_POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Reconnect backoff ceiling (the host bridge's 30 s).
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Bound for the server's hello frame.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// One battle event ≤ 64 KiB (the server rejects larger frames with close
/// 1009 — gateway-push §3.3).
pub(super) const MAX_BATTLE_FRAME_BYTES: usize = 64 * 1024;
/// Persistent publisher identity file (the `pairing-host-id.txt` pattern).
const HOST_ID_FILE: &str = "gateway-host-id.txt";

/// Handle to the running publisher session. `battles` is the arena hook's
/// enqueue target; `route` is the channel this session publishes to (the
/// frame builder stamps it on every frame).
struct PublishSession {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
    battles: tokio::sync::mpsc::UnboundedSender<String>,
    route: String,
}

fn publish_slot() -> &'static Mutex<Option<PublishSession>> {
    static SLOT: OnceLock<Mutex<Option<PublishSession>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Serializes start/stop so two racing calls never leak a task.
fn publish_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::const_new(()))
}

/// Whether the pub socket is live (hello seen). The arena hook's cheap
/// first gate before it builds a frame.
static PUBLISH_ONLINE: AtomicBool = AtomicBool::new(false);

// ── persistent publisher identity ────────────────────────────────────────────

/// The PERSISTENT publisher identity (32 hex, `gateway-host-id.txt`): the
/// worker keys "one publisher per channel" by it, so a reconnect with the
/// same id replaces this desktop's previous socket instead of being
/// refused as a second host (a DIFFERENT host id takes the channel over).
fn persistent_gateway_host_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        crate::paths::ensure_data_dir()
            .map(|dir| gateway_host_id_in(&dir))
            .unwrap_or_else(|_| random_host_id().unwrap_or_else(|_| "0".repeat(32)))
    })
    .clone()
}

/// `persistent_gateway_host_id` against an explicit directory (testable
/// core): read a valid id, or mint + persist one.
pub(super) fn gateway_host_id_in(dir: &std::path::Path) -> String {
    let path = dir.join(HOST_ID_FILE);
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim();
        if valid_host_id(t) {
            return t.to_ascii_lowercase();
        }
    }
    let id = random_host_id().unwrap_or_else(|_| "0".repeat(32));
    let _ = std::fs::write(&path, &id);
    id
}

fn valid_host_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn random_host_id() -> Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}

// ── battle frame builder (gateway-push §3.3) ─────────────────────────────────

/// Build the battle frame from an `ArenaInfo` (the `raw` block is
/// DROPPED — the wire mirrors the typed head + vehicles 1:1), the channel
/// route and the identity resolution:
///
/// * realm — the session hub's `PlayingAccount`, else the route's realm
///   segment, else the running install's realm (unregistered alt);
/// * `self.accountId` — the playing account's id when the hub knows one,
///   else the route's id segment;
/// * `self.name` — the roster's `relation == 0` player.
pub(super) fn build_battle_frame(
    info: &ArenaInfo,
    route: &str,
    playing: Option<&PlayingAccount>,
    running_realm: Option<&str>,
) -> GatewayBattleFrame {
    let realm = playing
        .and_then(|p| (!p.realm.trim().is_empty()).then(|| p.realm.trim().to_string()))
        .or_else(|| {
            let realm = super::session::route_realm(route);
            (!realm.is_empty()).then(|| realm.to_string())
        })
        .or_else(|| running_realm.map(str::to_string))
        .unwrap_or_default();
    let account_id = playing
        .and_then(|p| p.account_id.filter(|id| *id > 0))
        .or_else(|| super::session::route_account_id(route));
    let name = super::super::session::local_player_of(&info.vehicles)
        .unwrap_or_default()
        .to_string();
    GatewayBattleFrame {
        frame_type: "battle".into(),
        realm,
        route: route.to_string(),
        self_player: GatewayBattleSelf { name, account_id },
        battle: GatewayBattleHead {
            date_time: info.date_time.clone(),
            match_group: info.match_group.clone(),
            map_name: info.map_name.clone(),
            scenario: info.scenario.clone(),
            event_type: info.event_type.clone(),
            bot_count: info.bot_count,
            scripted_unit_count: info.scripted_unit_count,
            vehicles: info
                .vehicles
                .iter()
                .map(|v| GatewayBattleVehicle {
                    id: v.id,
                    name: v.name.clone(),
                    relation: v.relation,
                    ship_id: v.ship_id,
                    ship_name: v.ship_name.clone(),
                })
                .collect(),
        },
    }
}

/// Serialize a battle frame under the 64 KiB wire cap. An oversize frame
/// is an error (dropped, never sent — the server would close 1009).
pub(super) fn serialize_battle_frame(frame: &GatewayBattleFrame) -> Result<String> {
    let text = serde_json::to_string(frame).map_err(|e| anyhow!("battle frame serialize: {e}"))?;
    if text.len() > MAX_BATTLE_FRAME_BYTES {
        bail!(
            "gateway battle frame exceeds the 64 KiB cap ({} bytes)",
            text.len()
        );
    }
    Ok(text)
}

/// The `deliver_arena` hook (desktop): after a Battle decision — or the
/// RosterHeal that fills an empty first read, which must republish the
/// FULLER frame — enqueue one serialized battle frame on the live
/// publisher. Non-blocking by design (unbounded try-send; a full or absent
/// publisher means the service is off/offline and the battle simply is
/// not pushed).
pub(crate) fn on_arena_delivery(info: &ArenaInfo) {
    if !super::config::load_gateway_config().enabled {
        return;
    }
    if !PUBLISH_ONLINE.load(Ordering::Relaxed) {
        return;
    }
    let Some(session) = publish_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|s| (s.battles.clone(), s.route.clone()))
    else {
        return;
    };
    let (tx, route) = session;
    let playing = super::super::session::playing_identity();
    let running_realm = super::super::session::running_process_realm();
    let frame = build_battle_frame(info, &route, playing.as_ref(), running_realm.as_deref());
    match serialize_battle_frame(&frame) {
        Ok(text) => {
            // try-send: the publisher's loop reads the channel off its
            // select; a dropped receiver means the session is retiring.
            let _ = tx.send(text);
        },
        Err(e) => tracing::warn!(error = %e, "gateway battle frame dropped"),
    }
}

// ── session lifecycle ─────────────────────────────────────────────────────────

/// Start (or replace) the publisher session. The route comes from the
/// webui (it derives `r:<realm>:<accountId>` off the session hub); the
/// turnstile token, when the deployment demands one, likewise enters
/// through the webui — an attempt without it emits the `captcha` phase
/// and stops (the webui re-calls with a token).
async fn start_publish(
    app: tauri::AppHandle,
    config: GatewayClientConfig,
    route: String,
    turnstile_token: Option<String>,
    password: Option<String>,
) -> Result<()> {
    let _gate = publish_gate().lock().await;
    stop_publish().await;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (battle_tx, battle_rx) = tokio::sync::mpsc::unbounded_channel();
    let root = config.root;
    let task = tokio::spawn(publish_loop(
        app,
        root,
        route.clone(),
        turnstile_token,
        password,
        shutdown_rx,
        battle_rx,
    ));
    *publish_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(PublishSession {
        shutdown: shutdown_tx,
        task,
        battles: battle_tx,
        route,
    });
    Ok(())
}

/// Stop the publisher session (publish_stop, service disable, replace).
pub(crate) async fn stop_publish() {
    let _gate = publish_gate().lock().await;
    let joined = publish_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    PUBLISH_ONLINE.store(false, Ordering::Relaxed);
    if let Some(session) = joined {
        let _ = session.shutdown.send(true);
        super::super::pairing::await_shutdown(session.task, Duration::from_secs(3)).await;
    }
}

/// The publisher state machine (gateway-push §5):
///
/// 1. resolve health → captcha/password demands (`captcha` phase stops
///    clean — the token enters through the webui);
/// 2. exchange a ticket (the stable §9 markers on refusal);
/// 3. connect the pub socket (persistent hostId in the query), keepalive
///    every 30 s, forward the arena hook's frames;
/// 4. on game EXIT (session hub process flag falling) send `bye` +
///    close, then park until the game runs again and reconnect;
/// 5. on a dropped socket, reconnect with a fresh session when the
///    credentials are reusable (no Turnstile token demanded) — a burnt
///    single-use Turnstile token instead re-emits the `captcha` phase
///    and ends (the webui re-calls with a fresh one).
async fn publish_loop(
    app: tauri::AppHandle,
    root: String,
    route: String,
    turnstile_token: Option<String>,
    password: Option<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    mut battles: tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    let host_id = persistent_gateway_host_id();
    let mut backoff = Duration::from_secs(1);
    'session: loop {
        if *shutdown.borrow() {
            emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
            return;
        }
        emit_state(&app, "pub", Some(&route), PHASE_RESOLVING, None);
        let health = match super::health::fetch_gateway_health(&root).await {
            Ok((_, doc)) => doc,
            Err(e) => {
                emit_state(&app, "pub", Some(&route), PHASE_ERROR, Some(e.to_string()));
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
                emit_state(
                    &app,
                    "pub",
                    Some(&route),
                    PHASE_CAPTCHA,
                    Some("gateway requires a captcha token".into()),
                );
                return;
            },
            super::session::CredentialReadiness::NeedPassword => {
                emit_state(
                    &app,
                    "pub",
                    Some(&route),
                    PHASE_ERROR,
                    Some("gateway requires a password".into()),
                );
                return;
            },
        }
        let ticket: GatewaySessionTicket = match super::session::open_gateway_session(
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
                emit_state(&app, "pub", Some(&route), phase, Some(detail));
                return;
            },
        };
        emit_state(&app, "pub", Some(&route), PHASE_CONNECTING, None);
        let url = match pub_ws_url(&root, &route, &ticket.ticket, &host_id) {
            Ok(u) => u,
            Err(e) => {
                emit_state(&app, "pub", Some(&route), PHASE_ERROR, Some(e.to_string()));
                return;
            },
        };
        let mut ws = match pairing_relay::relay_ws_connect(&url).await {
            Ok(ws) => ws,
            Err(e) => {
                // The ticket is burnt either way; without a Turnstile
                // demand a fresh session may retry after a backoff.
                if !health.auth.turnstile.required {
                    tracing::debug!(error = %e, "gateway pub connect failed; retrying");
                    if park_backoff(&mut shutdown, backoff).await {
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                        continue 'session;
                    }
                    emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
                    return;
                }
                emit_state(
                    &app,
                    "pub",
                    Some(&route),
                    PHASE_ERROR,
                    Some(format!("gateway publish connect failed: {e}")),
                );
                return;
            },
        };
        backoff = Duration::from_secs(1);
        // Await the server hello (a battle snapshot may follow it — the
        // publisher simply tolerates whatever text arrives). A socket
        // that dies this fast parks on the backoff before retrying — a
        // broken server must not turn the loop into a hot spin.
        match tokio::time::timeout(HELLO_TIMEOUT, ws.next()).await {
            Ok(Some(Ok(_))) => {},
            Ok(Some(Err(e))) => {
                tracing::debug!(error = %e, "gateway pub hello read failed");
                if !park_backoff(&mut shutdown, backoff).await {
                    emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
                    return;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue 'session;
            },
            Ok(None) | Err(_) => {
                tracing::debug!("gateway pub closed before hello");
                if !park_backoff(&mut shutdown, backoff).await {
                    emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
                    return;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue 'session;
            },
        }
        PUBLISH_ONLINE.store(true, Ordering::Relaxed);
        emit_state(&app, "pub", Some(&route), PHASE_ONLINE, None);
        // Game-exit teardown arms only once a running client was seen: a
        // publisher started from port must not tear down on the first
        // poll of an already-exited game.
        let mut exit_armed = super::super::session::process_running();
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => {
                    let _ = ws.send(Message::Text(r#"{"type":"bye"}"#.into())).await;
                    let _ = ws.close(None).await;
                    PUBLISH_ONLINE.store(false, Ordering::Relaxed);
                    emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
                    return;
                },
                frame = battles.recv() => {
                    let Some(text) = frame else { break };
                    if ws.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                },
                msg = ws.next() => {
                    match msg {
                        // The pub socket's inbound traffic (hello echo,
                        // keepalives) only keeps the socket warm.
                        Some(Ok(Message::Text(_))) => {},
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Ok(_)) => {},
                        Some(Err(_)) => break,
                    }
                },
                _ = tokio::time::sleep(KEEPALIVE_INTERVAL) => {
                    let _ = ws.send(Message::Text(pairing_relay::relay_keepalive_text())).await;
                },
                _ = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {
                    let running = super::super::session::process_running();
                    if exit_armed && !running {
                        // The battle window ended: bye + close, then park
                        // until the game runs again (gateway-push §5.3).
                        let _ = ws.send(Message::Text(r#"{"type":"bye"}"#.into())).await;
                        let _ = ws.close(None).await;
                        PUBLISH_ONLINE.store(false, Ordering::Relaxed);
                        emit_state(
                            &app,
                            "pub",
                            Some(&route),
                            PHASE_STOPPED,
                            Some("game exited".into()),
                        );
                        loop {
                            tokio::select! {
                                biased;
                                _ = shutdown.changed() => {
                                    emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
                                    return;
                                },
                                _ = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {
                                    if super::super::session::process_running() {
                                        // A fresh Turnstile token is needed
                                        // for the new session — the webui
                                        // re-calls the start command.
                                        if health.auth.turnstile.required {
                                            emit_state(
                                                &app,
                                                "pub",
                                                Some(&route),
                                                PHASE_CAPTCHA,
                                                Some("re-authorization needed".into()),
                                            );
                                            return;
                                        }
                                        continue 'session;
                                    }
                                },
                            }
                        }
                    }
                    exit_armed |= running;
                },
            }
        }
        // The socket dropped mid-session.
        PUBLISH_ONLINE.store(false, Ordering::Relaxed);
        if *shutdown.borrow() {
            emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
            return;
        }
        if health.auth.turnstile.required {
            // The single-use token is burnt; a fresh one must come from
            // the webui widget.
            emit_state(
                &app,
                "pub",
                Some(&route),
                PHASE_CAPTCHA,
                Some("re-authorization needed".into()),
            );
            return;
        }
        if park_backoff(&mut shutdown, backoff).await {
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue 'session;
        }
        emit_state(&app, "pub", Some(&route), PHASE_STOPPED, None);
        return;
    }
}

/// Sleep out the reconnect backoff, waking early on shutdown. Returns
/// `true` to retry, `false` when shutdown won.
async fn park_backoff(
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
    backoff: Duration,
) -> bool {
    tokio::select! {
        _ = shutdown.changed() => false,
        _ = tokio::time::sleep(backoff) => true,
    }
}

/// Start (or replace) the desktop publisher for the session hub's route
/// (`r:<realm>:<accountId>`, derived by the webui). Fails fast when the
/// mobile service is disabled or the route is malformed; every other
/// outcome rides the `wowsp://gateway-state` phases.
#[tauri::command]
pub async fn gateway_publish_start(
    app: tauri::AppHandle,
    route: String,
    turnstile_token: Option<String>,
    password: Option<String>,
) -> CommandResult<()> {
    let config = super::config::load_gateway_config();
    if !config.enabled {
        return Err(anyhow!("gateway push service is disabled in settings").into());
    }
    if !super::session::valid_route(&route) {
        return Err(anyhow!("gateway route is malformed: {route}").into());
    }
    start_publish(app, config, route, turnstile_token, password).await?;
    Ok(())
}

/// Stop the publisher (sends `{"type":"bye"}` first so the channel's
/// snapshot retires instead of waiting out the idle TTL).
#[tauri::command]
pub async fn gateway_publish_stop() -> CommandResult<()> {
    stop_publish().await;
    Ok(())
}
