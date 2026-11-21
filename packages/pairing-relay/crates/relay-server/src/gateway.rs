//! `/gateway/*` — the battle-push namespace (gateway-push.md semantics,
//! ported per contract §7): relay-core's state machines drive everything
//! and the Durable Objects are replaced by in-process structures —
//! tickets + password lockout in a `Mutex<AuthState>` (the GatewayAuth
//! DO), one `ChannelHub` per route id (the GatewayChannel DO) with a
//! tokio broadcast channel for fan-out, the `battle:<route>` KV mirror
//! becoming the SQLite `battle_snapshots` table. Handler order, frame
//! spellings, caps and retention are relay-core's — this module never
//! re-decides policy.

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use relay_core::gateway::{
    AuthState, CredentialMissing, FrameVerdict, GatewayVars, TICKET_TTL_MS, TicketKind,
    battle_frame_verdict, battle_route, check_credentials, frame_kind, health_doc, hello_frame,
    host_frame, keepalive_frame, password_matches, subs_frame, valid_route_id, valid_ticket,
};
use relay_core::valid_host_id;
use tokio::sync::mpsc;

use crate::state::{AppState, ChannelHub, HostCommand, SystemTicketRng, client_ip, now_ms};

/// Cloudflare's Turnstile siteverify endpoint (same call the worker
/// makes; reuse of relay-core's body builder keeps one door).
const SITEVERIFY: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/// Siteverify round-trip budget.
const SITEVERIFY_TIMEOUT_SECS: u64 = 10;
/// WS close codes (contract §3.3).
const CLOSE_MESSAGE_TOO_BIG: u16 = 1009;
const CLOSE_NORMAL: u16 = 1000;

/// The deployment's gateway config (relay-core's GatewayVars).
pub fn gateway_vars(app: &AppState) -> GatewayVars {
    GatewayVars::from_raw(
        trimmed(&app.cfg.turnstile_sitekey),
        trimmed(&app.cfg.gateway_password).is_some(),
        trimmed(&app.cfg.notice),
    )
}

/// Blank values mean "off" for every optional gateway knob.
fn trimmed(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

// ── GET /gateway/health ────────────────────────────────────────────────

pub async fn health(State(app): State<Arc<AppState>>) -> Response {
    let doc = health_doc(&gateway_vars(&app));
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "public, max-age=60"),
        ],
        serde_json::to_string(&doc).unwrap_or_default(),
    )
        .into_response()
}

// ── POST /gateway/session ──────────────────────────────────────────────

/// Mirror of the worker's gate order (§3.2): route id → IP lock gate
/// (429) → credential presence (400) → Turnstile siteverify (403) →
/// password constant-time compare (403, counted) → ticket (200).
pub async fn session(
    State(app): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Response {
    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "bad_json"),
    };
    let field = |name: &str| {
        payload
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let Some(route) = field("route") else {
        return err(StatusCode::BAD_REQUEST, "bad_route");
    };
    if !valid_route_id(route) {
        return err(StatusCode::BAD_REQUEST, "bad_route");
    }
    let turnstile_token = field("cf-turnstile-response");
    let password = field("password");
    let ip = client_ip(&app.cfg, &headers, addr);
    let vars = gateway_vars(&app);
    let now = now_ms();

    // 1. Password lockout gate — before the siteverify call so a locked
    //    IP cannot burn third-party quota.
    if let Some(retry_ms) = app.auth.lock().unwrap().lock_remaining(now, &ip) {
        return rate_limited(retry_ms.div_ceil(1000));
    }

    // 2. Presence of exactly what health demands.
    if let Err(missing) = check_credentials(&vars, turnstile_token, password) {
        return match missing {
            CredentialMissing::Turnstile => err(StatusCode::BAD_REQUEST, "missing_captcha"),
            CredentialMissing::Password => err(StatusCode::BAD_REQUEST, "missing_password"),
        };
    }

    // 3. Turnstile siteverify.
    let mut turnstile_ok = false;
    if vars.turnstile_required() {
        let Some(secret) = app
            .cfg
            .turnstile_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return err(StatusCode::SERVICE_UNAVAILABLE, "maintenance");
        };
        let body = relay_core::feedback::turnstile_verify_body(
            secret,
            turnstile_token.unwrap_or_default(),
            &ip,
        );
        let verdict = match app
            .plain_http
            .post(SITEVERIFY)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(body)
            .timeout(std::time::Duration::from_secs(SITEVERIFY_TIMEOUT_SECS))
            .send()
            .await
        {
            Ok(resp) => resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or(serde_json::Value::Null),
            Err(_) => return err(StatusCode::BAD_GATEWAY, "captcha_unreachable"),
        };
        if !relay_core::feedback::turnstile_passed(&verdict) {
            return err(StatusCode::FORBIDDEN, "captcha");
        }
        turnstile_ok = true;
    }

    // 4. Password — constant-time compare; a failure is counted and the
    //    5th inside the window locks (relay-core's AuthState).
    let mut password_ok = false;
    if vars.password_required {
        let expected = app.cfg.gateway_password.as_deref().unwrap_or_default();
        if !password_matches(expected, password.unwrap_or_default()) {
            let lock = app.auth.lock().unwrap().password_failed(now_ms(), &ip);
            if let Some(retry_ms) = lock {
                return rate_limited(retry_ms.div_ceil(1000));
            }
            return err(StatusCode::FORBIDDEN, "password");
        }
        password_ok = true;
    }

    // 5. Mint the single-use, route-bound ticket (120 s TTL).
    let kind = TicketKind::from_flags(turnstile_ok, password_ok);
    let mut rng = SystemTicketRng;
    let (ticket, _entry) = app
        .auth
        .lock()
        .unwrap()
        .mint(now_ms(), &mut rng, route, kind);
    if !valid_ticket(&ticket) {
        return err(StatusCode::SERVICE_UNAVAILABLE, "ticket_unavailable");
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        serde_json::json!({
            "ticket": ticket,
            "route": route,
            "ttl": TICKET_TTL_MS / 1000,
        })
        .to_string(),
    )
        .into_response()
}

/// Deterministic mint helper (unit tests drive it with relay-core's
/// ScriptedTicketRng to pin the gate order).
pub fn mint_ticket(
    auth: &mut AuthState,
    now: u64,
    rng: &mut dyn relay_core::gateway::TicketRng,
    route: &str,
    kind: TicketKind,
) -> String {
    auth.mint(now, rng, route, kind).0
}

// ── WS upgrades ────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct PubQuery {
    route: Option<String>,
    ticket: Option<String>,
    #[serde(rename = "hostId")]
    host_id: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct SubQuery {
    route: Option<String>,
    ticket: Option<String>,
}

/// WS /gateway/pub?route=&ticket=[&hostId=] — validate, consume the
/// single-use ticket HERE (a later channel refusal still burns it),
/// then run the publisher loop.
pub async fn pub_upgrade(
    State(app): State<Arc<AppState>>,
    ConnectInfo(_addr): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<PubQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(route) = q.route.filter(|r| valid_route_id(r)) else {
        return plain_err(StatusCode::BAD_REQUEST, "bad route id");
    };
    let Some(ticket) = q.ticket.filter(|t| valid_ticket(t)) else {
        return plain_err(StatusCode::BAD_REQUEST, "bad ticket");
    };
    if let Some(host_id) = q.host_id.as_deref() {
        if !valid_host_id(host_id) {
            return plain_err(StatusCode::BAD_REQUEST, "bad host id");
        }
    }
    // Single-use spend no matter the outcome (relay-core's AuthState).
    let outcome = app.auth.lock().unwrap().consume(now_ms(), &ticket, &route);
    if outcome.is_err() {
        return plain_err(StatusCode::UNAUTHORIZED, "invalid ticket");
    }
    ws.on_upgrade(move |socket| pub_socket(app, route, q.host_id, socket))
}

/// WS /gateway/sub?route=&ticket= — same consume-then-run flow.
pub async fn sub_upgrade(
    State(app): State<Arc<AppState>>,
    ConnectInfo(_addr): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<SubQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(route) = q.route.filter(|r| valid_route_id(r)) else {
        return plain_err(StatusCode::BAD_REQUEST, "bad route id");
    };
    let Some(ticket) = q.ticket.filter(|t| valid_ticket(t)) else {
        return plain_err(StatusCode::BAD_REQUEST, "bad ticket");
    };
    let outcome = app.auth.lock().unwrap().consume(now_ms(), &ticket, &route);
    if outcome.is_err() {
        return plain_err(StatusCode::UNAUTHORIZED, "invalid ticket");
    }
    // Cheap pre-check of the 32-subscriber cap (relay-core's ceiling);
    // the authoritative join happens once the handshake completed.
    let hub = hub_for(&app, &route);
    if hub.chan.lock().unwrap().sub_count() >= relay_core::gateway::MAX_SUBSCRIBERS {
        return plain_err(StatusCode::CONFLICT, "subscriber limit reached");
    }
    ws.on_upgrade(move |socket| sub_socket(app, route, socket))
}

fn hub_for(app: &Arc<AppState>, route: &str) -> Arc<ChannelHub> {
    app.channels
        .entry(route.to_string())
        .or_insert_with(|| Arc::new(ChannelHub::new()))
        .clone()
}

// ── the publisher loop (the GatewayChannel DO's host half) ─────────────

async fn pub_socket(
    app: Arc<AppState>,
    route: String,
    host_id: Option<String>,
    mut socket: WebSocket,
) {
    let hub = hub_for(&app, &route);
    let now = now_ms();

    // Register under the policy state, sweeping any expired snapshot
    // first (relay-core's ChannelState owns both decisions).
    let snapshot = {
        let mut chan = hub.chan.lock().unwrap();
        let _replaced = chan.host_connect(host_id.as_deref());
        chan.sweep(now);
        chan.snapshot().cloned()
    };
    // One publisher per channel: the newcomer replaces whoever held the
    // slot — close the old socket with 1000 "replaced by a new host".
    let (tx, mut rx) = mpsc::unbounded_channel::<HostCommand>();
    if let Some(old) = hub.host.lock().unwrap().replace(tx.clone()) {
        let _ = old.send(HostCommand::Close(
            CLOSE_NORMAL,
            "replaced by a new host".into(),
        ));
    }
    // hello → retained snapshot → host-online to subscribers → current
    // subscriber count (same frame sequence as the channel DO).
    let _ = socket.send(Message::Text(hello_frame("pub").into())).await;
    if let Some(snap) = snapshot {
        let _ = socket.send(Message::Text(snap.frame.into())).await;
    }
    let _ = hub.fanout.send(host_frame(true));
    let count = hub.chan.lock().unwrap().sub_count();
    let _ = tx.send(HostCommand::Frame(subs_frame(count)));

    let mut keepalive = tokio::time::interval(std::time::Duration::from_millis(
        app.cfg.keepalive_interval_ms,
    ));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(HostCommand::Frame(frame)) => {
                    if socket.send(Message::Text(frame.into())).await.is_err() {
                        break;
                    }
                },
                Some(HostCommand::Close(code, reason)) => {
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                },
                None => break,
            },
            _ = keepalive.tick() => {
                // Server-side keepalive (contract: 30 s both directions).
                if socket.send(Message::Text(keepalive_frame().into())).await.is_err() {
                    break;
                }
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let text = text.as_str().to_string();
                    match frame_kind(&text) {
                        Some("battle") => {
                            // 64 KiB cap → close 1009 (relay-core verdict).
                            if let FrameVerdict::TooLarge { .. } =
                                battle_frame_verdict(text.len())
                            {
                                let _ = socket
                                    .send(Message::Close(Some(CloseFrame {
                                        code: CLOSE_MESSAGE_TOO_BIG,
                                        reason: "battle frame too large".into(),
                                    })))
                                    .await;
                                break;
                            }
                            // A battle frame naming another route would
                            // corrupt subscribers' rosters — dropped.
                            if battle_route(&text).is_some_and(|claimed| claimed != route) {
                                continue;
                            }
                            let now = now_ms();
                            let deadline = hub.chan.lock().unwrap().publish(now, text.clone());
                            app.store
                                .put_snapshot(&route, &text, now as i64, deadline as i64);
                            let _ = hub.fanout.send(text);
                        },
                        Some("bye") => {
                            let now = now_ms();
                            let (deadline, row) = {
                                let mut chan = hub.chan.lock().unwrap();
                                let deadline = chan.bye(now);
                                (deadline, chan.snapshot().cloned())
                            };
                            if let Some(row) = row {
                                if let Some(deadline) = deadline {
                                    app.store.put_snapshot(
                                        &route,
                                        &row.frame,
                                        now as i64,
                                        deadline as i64,
                                    );
                                }
                            }
                            let _ = hub.fanout.send(text);
                        },
                        _ => {}, // tolerated chatter (keepalive included)
                    }
                },
                Some(Ok(_)) => {}, // binary frames tolerated, ignored
                Some(Err(_)) | None => break,
            },
        }
    }

    // Teardown: only the REGISTERED host announces offline — a replaced
    // host exiting must not shadow its successor.
    let was_host = {
        let mut host_slot = hub.host.lock().unwrap();
        let still = host_slot.as_ref().is_some_and(|cur| cur.same_channel(&tx));
        if still {
            *host_slot = None;
            hub.chan.lock().unwrap().host_gone();
        }
        still
    };
    if was_host {
        let _ = hub.fanout.send(host_frame(false));
    }
    maybe_drop_hub(&app, &route, &hub);
}

// ── the subscriber loop (the channel DO's fan-out half) ────────────────

async fn sub_socket(app: Arc<AppState>, route: String, mut socket: WebSocket) {
    let hub = hub_for(&app, &route);
    let now = now_ms();

    // Authoritative join (the HTTP-time check was only a guard).
    let full = hub.chan.lock().unwrap().sub_join().is_err();
    if full {
        // Full: refuse immediately (the DO's 409 equivalent).
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: "subscriber limit reached".into(),
            })))
            .await;
        maybe_drop_hub(&app, &route, &hub);
        return;
    }

    // Subscribe BEFORE reading the snapshot (under the same policy
    // lock a publish needs): a frame published concurrently is queued
    // by the broadcast channel and delivered right after the initial
    // burst — no gap, at worst one harmless duplicate state snapshot.
    let (mut bcast, snapshot) = {
        let mut chan = hub.chan.lock().unwrap();
        let rx = hub.fanout.subscribe();
        chan.sweep(now);
        (rx, chan.snapshot().cloned())
    };
    let host_up = hub.host.lock().unwrap().is_some();

    // hello → host presence → live snapshot, else the SQLite mirror's
    // stale copy (the battle:<route> KV mirror stand-in).
    let _ = socket.send(Message::Text(hello_frame("sub").into())).await;
    let _ = socket.send(Message::Text(host_frame(host_up).into())).await;
    if let Some(snap) = snapshot {
        let _ = socket.send(Message::Text(snap.frame.into())).await;
    } else if let Some(stale) = app.store.get_snapshot(&route, now as i64) {
        let _ = socket.send(Message::Text(stale.into())).await;
    }
    // A phone just joined: tell the publisher (tray indicator).
    notify_host_subs(&hub);

    // Server-side keepalive for the SUBSCRIBER too (gateway-push.md:
    // 30 s pings both directions — the worker pings both roles). A
    // silently-dead sub would otherwise hold one of the 32 seats
    // forever; the send error reaps it.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_millis(
        app.cfg.keepalive_interval_ms,
    ));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if socket.send(Message::Text(keepalive_frame().into())).await.is_err() {
                    break;
                }
            },
            frame = bcast.recv() => match frame {
                Ok(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // A slow subscriber missed frames — its roster is
                    // stale; close so the client resubscribes fresh.
                    let _ = socket
                        .send(Message::Close(Some(CloseFrame {
                            code: 1011,
                            reason: "subscriber lagged".into(),
                        })))
                        .await;
                    break;
                },
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                // Inbound text is tolerated (30 s keepalives) and never
                // forwarded; the loop exists to notice the close.
                Some(Ok(_)) => {},
                Some(Err(_)) | None => break,
            },
        }
    }

    // Teardown: free the seat, keep the publisher's count honest.
    hub.chan.lock().unwrap().sub_leave();
    notify_host_subs(&hub);
    maybe_drop_hub(&app, &route, &hub);
}

/// Tell the live publisher how many phones hold seats (host-only frame).
fn notify_host_subs(hub: &Arc<ChannelHub>) {
    let count = hub.chan.lock().unwrap().sub_count();
    if let Some(tx) = hub.host.lock().unwrap().as_ref() {
        let _ = tx.send(HostCommand::Frame(subs_frame(count)));
    }
}

/// Drop the map entry when a hub holds neither publisher nor seats
/// (bounds memory on public nodes that see many route ids).
fn maybe_drop_hub(app: &Arc<AppState>, route: &str, hub: &Arc<ChannelHub>) {
    let empty = hub.chan.lock().unwrap().sub_count() == 0 && hub.host.lock().unwrap().is_none();
    if empty {
        app.channels.remove_if(route, |_, v| Arc::ptr_eq(v, hub));
    }
}

// ── shared response helpers (worker shapes) ────────────────────────────

/// JSON error body in the worker's gateway shape ({"ok":false,…}).
fn err(status: StatusCode, code: &str) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::Json(serde_json::json!({ "ok": false, "error": code })),
    )
        .into_response()
}

/// Plain-text upgrade gate errors (the worker's Response::error shape —
/// the WS clients key on the status code).
fn plain_err(status: StatusCode, text: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        text.to_string(),
    )
        .into_response()
}

/// 429 with the contract's retryAfter — in the body AND the standard
/// Retry-After header.
fn rate_limited(retry_after_secs: u64) -> Response {
    let retry_after = retry_after_secs.to_string();
    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
            (header::RETRY_AFTER, retry_after.as_str()),
        ],
        axum::Json(serde_json::json!({
            "ok": false,
            "error": "rate_limited",
            "retryAfter": retry_after_secs,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::gateway::{ConsumeError, ScriptedTicketRng};

    const T0: u64 = 1_700_000_000_000;

    fn bytes(n: u8) -> [u8; 16] {
        [n; 16]
    }

    fn app_with(password: Option<&str>) -> Arc<AppState> {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::Config::default();
        cfg.data_dir = dir.path().to_path_buf();
        cfg.gateway_password = password.map(str::to_string);
        AppState::init(cfg).unwrap()
    }

    /// The session gate order, driven through relay-core's exact
    /// machines: ticket mint determinism (ScriptedTicketRng) + the
    /// lockout ordering (5 failures → 429 before password compares).
    #[test]
    fn session_gate_order_lockout_before_password() {
        let app = app_with(Some("hunter2"));
        let vars = gateway_vars(&app);
        assert!(vars.password_required);
        assert!(!vars.turnstile_required(), "no sitekey configured");

        // Gate 2 order: presence before verification — a missing
        // password is a 400 before any compare happens; a present one
        // passes the presence gate (the compare itself is step 4).
        assert_eq!(
            check_credentials(&vars, None, None),
            Err(CredentialMissing::Password)
        );
        assert_eq!(check_credentials(&vars, None, Some("pw")), Ok(()));

        // 5 wrong passwords inside the window trip the 300 s lock…
        let ip = "203.0.113.9";
        for n in 0..4 {
            assert_eq!(
                app.auth.lock().unwrap().password_failed(T0 + n, ip),
                None,
                "failure {} does not lock",
                n + 1
            );
        }
        assert_eq!(
            app.auth.lock().unwrap().password_failed(T0 + 4, ip),
            Some(300_000),
            "5th failure locks for 300 s"
        );
        // …and the gate reports it BEFORE any password compare (the
        // session handler consults lock_remaining first): the lock runs
        // until T0+4+300_000, so at T0+5 it has 299_999 ms left.
        assert_eq!(
            app.auth.lock().unwrap().lock_remaining(T0 + 5, ip),
            Some(299_999)
        );
        // Even the CORRECT password stays refused while locked.
        assert!(vars.password_required);
        assert!(password_matches("hunter2", "hunter2"));
        assert_eq!(
            app.auth.lock().unwrap().lock_remaining(T0 + 5, ip),
            Some(299_999)
        );
    }

    /// Ticket mint determinism + single-use through the mint/consume
    /// seam the session handler uses.
    #[test]
    fn tickets_are_deterministic_single_use_and_route_bound() {
        let app = app_with(None);
        let mut auth = app.auth.lock().unwrap();
        let mut rng = ScriptedTicketRng::new(vec![bytes(7)]);
        let t = mint_ticket(&mut auth, T0, &mut rng, "r:asia:1", TicketKind::None);
        assert_eq!(t, "07".repeat(16), "ScriptedTicketRng drives the mint");
        assert!(valid_ticket(&t));
        // Single-use: first spend consumes, second refuses.
        assert_eq!(auth.consume(T0, &t, "r:asia:1"), Ok(()));
        assert_eq!(auth.consume(T0, &t, "r:asia:1"), Err(ConsumeError::Unknown));
        // A fresh ticket minted for another route refuses ours.
        let mut rng2 = ScriptedTicketRng::new(vec![bytes(8)]);
        let u = mint_ticket(&mut auth, T0, &mut rng2, "r:eu:2", TicketKind::None);
        assert_eq!(
            auth.consume(T0, &u, "r:asia:1"),
            Err(ConsumeError::RouteMismatch)
        );
    }

    /// The password-less open node mints freely (TicketKind::None).
    #[test]
    fn open_node_mints_none_kind_tickets() {
        let app = app_with(None);
        let vars = gateway_vars(&app);
        assert!(!vars.password_required);
        assert_eq!(check_credentials(&vars, None, None), Ok(()));
        let mut auth = app.auth.lock().unwrap();
        let mut rng = ScriptedTicketRng::new(vec![bytes(3)]);
        let t = mint_ticket(&mut auth, T0, &mut rng, "r:na:9", TicketKind::None);
        assert_eq!(auth.consume(T0 + TICKET_TTL_MS - 1, &t, "r:na:9"), Ok(()));
        assert_eq!(TICKET_TTL_MS, 120_000, "the contract's 120 s TTL");
    }
}
