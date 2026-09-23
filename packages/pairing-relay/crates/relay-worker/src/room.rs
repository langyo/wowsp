//! The per-room Durable Object: rendezvous + byte pipes. Policy lives in
//! [`relay_core::room`] (connection cap, frame cap); this module owns
//! the WebSockets and the idle TTL alarm.
//!
//! A room is named by the desktop-minted 64-hex room key. The host
//! bridge holds ONE control socket (30s keepalive text frames keep it
//! past Cloudflare's ~100s proxy idle cutoff and refresh the room's
//! 15-minute idle TTL); phones hold client control sockets and the two
//! data halves of each opened connection.

use std::cell::RefCell;
use std::rc::Rc;

use futures_util::StreamExt;
use relay_core::protocol::{InboundFrame, OutboundFrame, error_codes, welcome};
use relay_core::room::{AttachOutcome, FrameVerdict, OpenError, RoomConns, Side, frame_verdict};
use relay_core::route::{Route, classify};
use relay_core::{valid_conn_id, valid_host_id, valid_room};
use worker::{WebsocketEvent, *};

/// Rooms idle longer than this are torn down by the alarm.
const ROOM_IDLE_TTL_MS: u64 = 15 * 60 * 1000;
/// Singleton name of the code Directory DO.
const DIRECTORY_NAME: &str = "codes";
/// Bytes one direction may buffer while waiting for the peer's data
/// socket to attach (bounded so a dead peer cannot balloon the DO).
const PENDING_CAP_BYTES: usize = relay_core::room::MAX_FRAME_BYTES;
/// WS close code for oversized frames.
const CLOSE_MESSAGE_TOO_BIG: u16 = 1009;
/// WS close code for a peer/room going away.
const CLOSE_GOING_AWAY: u16 = 1001;
/// WS close code for a normal teardown.
const CLOSE_NORMAL: u16 = 1000;

/// Both halves of one data connection, plus early frames buffered while
/// the second half's handshake is still in flight (the phone can win the
/// race against the desktop's data dial by a full round trip — without
/// the buffer its request bytes would vanish).
#[derive(Default)]
struct ConnSockets {
    client: Option<WebSocket>,
    host: Option<WebSocket>,
    client_pending: Vec<u8>,
    host_pending: Vec<u8>,
}

#[derive(Default)]
struct RoomInner {
    room_key: Option<String>,
    host: Option<WebSocket>,
    clients: Vec<WebSocket>,
    sockets: std::collections::HashMap<String, ConnSockets>,
    conns: RoomConns,
}

#[durable_object]
pub struct Room {
    state: State,
    env: Env,
    inner: Rc<RefCell<RoomInner>>,
}

impl DurableObject for Room {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            inner: Rc::new(RefCell::new(RoomInner::default())),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let query = url.query().unwrap_or("").to_string();
        let path = url.path().to_string();
        match classify(&path, &query) {
            Route::Control { room, role } => self.control(room, role).await,
            Route::Data {
                room,
                conn_id,
                side,
            } => self.data(room, conn_id, side).await,
            _ => Response::error("not found", 404),
        }
    }

    /// Idle teardown: close every socket, clear all state. The runtime
    /// evicts the DO shortly after.
    async fn alarm(&self) -> Result<Response> {
        let mut inner = self.inner.borrow_mut();
        if let Some(ws) = inner.host.take() {
            let _ = ws.close(Some(CLOSE_GOING_AWAY), Some("room idle timeout"));
        }
        for ws in inner.clients.drain(..) {
            let _ = ws.close(Some(CLOSE_GOING_AWAY), Some("room idle timeout"));
        }
        for (_, entry) in inner.sockets.drain() {
            for ws in [entry.client, entry.host].into_iter().flatten() {
                let _ = ws.close(Some(CLOSE_GOING_AWAY), Some("room idle timeout"));
            }
        }
        inner.conns.clear();
        inner.room_key = None;
        drop(inner);
        let _ = self.state.storage().delete_alarm().await;
        Response::ok("idle")
    }
}

impl Room {
    /// Refresh the idle TTL (called on connect and on control traffic).
    async fn touch_ttl(&self) {
        let _ = self
            .state
            .storage()
            .set_alarm((Date::now().as_millis() + ROOM_IDLE_TTL_MS) as i64)
            .await;
    }

    // ── control sockets ────────────────────────────────────────────────

    async fn control(&self, room: Option<&str>, role: Option<&str>) -> Result<Response> {
        let Some(room) = room.filter(|r| valid_room(r)) else {
            return Response::error("bad room key", 400);
        };
        let is_host = match role {
            Some("host") => true,
            Some("client") => false,
            _ => return Response::error("bad role", 400),
        };
        self.touch_ttl().await;

        if is_host && self.inner.borrow().host.is_some() {
            return Response::error("room already has a host", 409);
        }

        let pair = WebSocketPair::new()?;
        let server = pair.server.clone();
        server.accept()?;

        if is_host {
            let waiting = {
                let mut inner = self.inner.borrow_mut();
                // Decide the host slot under the same borrow that
                // registers it. The fast-path check above currently
                // spans no await, but nothing enforces that; if one is
                // ever inserted before this point, two concurrent host
                // connects could both pass it and the second would
                // silently replace the first. Re-checking here makes
                // check-then-act atomic on the single-threaded runtime:
                // the loser gets a 409, and its accepted socket is
                // dropped (= closed) along with the unreturned pair.
                if inner.host.is_some() {
                    return Response::error("room already has a host", 409);
                }
                inner.room_key = Some(room.to_string());
                inner.host = Some(server.clone());
                inner.clients.clone()
            };
            // Tell waiting phones the desktop is here.
            for client in waiting {
                let _ = client.send_with_str(&OutboundFrame::Ready.to_text());
            }
            self.spawn_host_reader(server);
        } else {
            let greeting = {
                let mut inner = self.inner.borrow_mut();
                if inner.room_key.is_none() {
                    inner.room_key = Some(room.to_string());
                }
                let host_up = inner.host.is_some();
                inner.clients.push(server.clone());
                if host_up {
                    OutboundFrame::Ready
                } else {
                    OutboundFrame::Waiting
                }
            };
            let _ = server.send_with_str(&greeting.to_text());
            self.spawn_client_reader(server);
        }
        Ok(Response::from_websocket(pair.client)?)
    }

    /// The desktop bridge's control socket: handshakes, code allocation,
    /// conn signals. Any inbound text refreshes the idle TTL.
    fn spawn_host_reader(&self, server: WebSocket) {
        let inner = self.inner.clone();
        let storage = Rc::new(self.state.storage());
        let env = self.env.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let mut host_id: Option<String> = None;
            let mut events = match server.events() {
                Ok(events) => events,
                Err(_) => return,
            };
            while let Some(Ok(event)) = events.next().await {
                let WebsocketEvent::Message(msg) = event else {
                    break;
                };
                let Some(text) = msg.text() else { continue };
                // The bridge keepalives every 30s; every byte keeps the
                // room warm.
                let _ = storage
                    .set_alarm((Date::now().as_millis() + ROOM_IDLE_TTL_MS) as i64)
                    .await;
                match InboundFrame::parse(&text) {
                    InboundFrame::Hello { host_id: id, .. } => {
                        if valid_host_id(&id) {
                            host_id = Some(id);
                        }
                        let _ = server.send_with_str(&welcome().to_text());
                    },
                    InboundFrame::Allocate => {
                        let room = inner.borrow().room_key.clone();
                        let Some(room) = room else { continue };
                        match allocate_via_directory(&env, &room, host_id.as_deref()).await {
                            Ok(code) => {
                                let _ = server
                                    .send_with_str(&OutboundFrame::Code { code, room }.to_text());
                            },
                            Err(_) => {
                                let _ = server.send_with_str(&OutboundFrame::AllocFailed.to_text());
                            },
                        }
                    },
                    _ => {},
                }
            }
            let mut inner = inner.borrow_mut();
            if inner.host.as_ref() == Some(&server) {
                inner.host = None;
            }
        });
    }

    /// A phone's control socket: hello→welcome, {open}→signal the host,
    /// conn-limit rejections.
    fn spawn_client_reader(&self, server: WebSocket) {
        let inner = self.inner.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let mut events = match server.events() {
                Ok(events) => events,
                Err(_) => return,
            };
            while let Some(Ok(event)) = events.next().await {
                let WebsocketEvent::Message(msg) = event else {
                    break;
                };
                let Some(text) = msg.text() else { continue };
                match InboundFrame::parse(&text) {
                    InboundFrame::Hello { .. } => {
                        let _ = server.send_with_str(&welcome().to_text());
                    },
                    InboundFrame::Open { conn_id } => {
                        let (outcome, host) = {
                            let mut inner = inner.borrow_mut();
                            let outcome = inner.conns.open(&conn_id);
                            if outcome.is_ok() {
                                inner.sockets.entry(conn_id.clone()).or_default();
                            }
                            (outcome, inner.host.clone())
                        };
                        match outcome {
                            Ok(()) => {
                                if let Some(host) = host {
                                    let _ = host.send_with_str(
                                        &OutboundFrame::Conn {
                                            conn_id: conn_id.clone(),
                                        }
                                        .to_text(),
                                    );
                                }
                            },
                            Err(OpenError::ConnLimit) => {
                                let _ = server.send_with_str(
                                    &OutboundFrame::Error {
                                        code: error_codes::CONN_LIMIT.to_string(),
                                        size: None,
                                    }
                                    .to_text(),
                                );
                            },
                            // Invalid or duplicate ids: ignore (v1 parity).
                            Err(_) => {},
                        }
                    },
                    _ => {},
                }
            }
            // Gone: unhook and release this phone's pure reservations
            // (opens that never got a data socket).
            let mut inner = inner.borrow_mut();
            inner.clients.retain(|ws| ws != &server);
            let stale: Vec<String> = inner
                .sockets
                .iter()
                .filter(|(_, s)| s.client.is_none() && s.host.is_none())
                .map(|(id, _)| id.clone())
                .collect();
            for id in stale {
                inner.sockets.remove(&id);
                inner.conns.detach(&id);
            }
        });
    }

    // ── data sockets ───────────────────────────────────────────────────

    async fn data(&self, room: &str, conn_id: &str, side: Side) -> Result<Response> {
        if !valid_room(room) || !valid_conn_id(conn_id) {
            return Response::error("bad data route", 400);
        }
        let outcome = {
            let mut inner = self.inner.borrow_mut();
            if inner.room_key.is_none() {
                inner.room_key = Some(room.to_string());
            }
            inner.conns.attach(conn_id, side)
        };
        match outcome {
            AttachOutcome::UnknownId => return Response::error("unknown conn", 404),
            AttachOutcome::SideTaken => return Response::error("conn side already attached", 409),
            AttachOutcome::HalfOpen | AttachOutcome::Paired => {},
        }
        self.touch_ttl().await;

        let pair = WebSocketPair::new()?;
        let server = pair.server.clone();
        server.accept()?;
        {
            let mut inner = self.inner.borrow_mut();
            let entry = inner.sockets.entry(conn_id.to_string()).or_default();
            match side {
                Side::Client => entry.client = Some(server.clone()),
                Side::Host => entry.host = Some(server.clone()),
            }
            flush_pending(&mut inner, conn_id);
        }
        self.spawn_data_reader(conn_id.to_string(), side, server);
        Ok(Response::from_websocket(pair.client)?)
    }

    /// One half of a data pipe: forward binary frames to the peer,
    /// enforce the 256 KiB frame cap, tear the conn down on any close.
    fn spawn_data_reader(&self, conn_id: String, side: Side, server: WebSocket) {
        let inner = self.inner.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let mut events = match server.events() {
                Ok(events) => events,
                Err(_) => return,
            };
            while let Some(Ok(event)) = events.next().await {
                let WebsocketEvent::Message(msg) = event else {
                    break;
                };
                // Text on a data socket is protocol noise — drop it.
                let Some(bytes) = msg.bytes() else { continue };
                match frame_verdict(bytes.len()) {
                    FrameVerdict::Ok => {
                        let peer = peer_socket(&inner.borrow(), &conn_id, side);
                        match peer {
                            Some(peer) => {
                                if peer.send_with_bytes(&bytes).is_err() {
                                    break;
                                }
                            },
                            None => {
                                // Peer socket not attached yet — buffer
                                // (bounded) until its dial completes.
                                let overflowed = {
                                    let mut inner = inner.borrow_mut();
                                    match inner.sockets.get_mut(&conn_id) {
                                        Some(entry) => {
                                            let pending = match side {
                                                Side::Client => &mut entry.client_pending,
                                                Side::Host => &mut entry.host_pending,
                                            };
                                            if pending.len() + bytes.len() > PENDING_CAP_BYTES {
                                                true
                                            } else {
                                                pending.extend_from_slice(&bytes);
                                                false
                                            }
                                        },
                                        None => true,
                                    }
                                };
                                if overflowed {
                                    teardown_conn(&inner, &conn_id);
                                    break;
                                }
                            },
                        }
                    },
                    FrameVerdict::TooLarge { size, .. } => {
                        // Error-close THAT connection with a text notice.
                        let _ = server.send_with_str(
                            &OutboundFrame::Error {
                                code: error_codes::FRAME_TOO_LARGE.to_string(),
                                size: Some(size as u32),
                            }
                            .to_text(),
                        );
                        let _ = server.close(Some(CLOSE_MESSAGE_TOO_BIG), Some("frame too large"));
                        teardown_conn(&inner, &conn_id);
                        break;
                    },
                }
            }
            teardown_conn(&inner, &conn_id);
        });
    }
}

/// The socket of `conn_id`'s OTHER half, if attached.
fn peer_socket(inner: &RoomInner, conn_id: &str, side: Side) -> Option<WebSocket> {
    match side {
        Side::Client => inner.sockets.get(conn_id)?.host.clone(),
        Side::Host => inner.sockets.get(conn_id)?.client.clone(),
    }
}

/// Forward each half's pre-pairing buffer now that both sockets exist.
fn flush_pending(inner: &mut RoomInner, conn_id: &str) {
    let Some(entry) = inner.sockets.get_mut(conn_id) else {
        return;
    };
    if entry.client.is_none() || entry.host.is_none() {
        return;
    }
    let client_pending = std::mem::take(&mut entry.client_pending);
    let host_pending = std::mem::take(&mut entry.host_pending);
    let host = entry.host.clone();
    let client = entry.client.clone();
    if let Some(host) = host {
        let _ = host.send_with_bytes(&client_pending);
    }
    if let Some(client) = client {
        let _ = client.send_with_bytes(&host_pending);
    }
}

/// Kill a data connection: close both sockets, drop the accounting row.
/// Idempotent — the second half's reader arriving here is a no-op.
fn teardown_conn(inner: &RefCell<RoomInner>, conn_id: &str) {
    let mut inner = inner.borrow_mut();
    if let Some(entry) = inner.sockets.remove(conn_id) {
        inner.conns.detach(conn_id);
        for ws in [entry.client, entry.host].into_iter().flatten() {
            let _ = ws.close(Some(CLOSE_NORMAL), Some("peer closed"));
        }
    }
}

/// Ask the singleton Directory DO for a fresh code bound to
/// `(host_id, room)`.
async fn allocate_via_directory(
    env: &Env,
    room: &str,
    host_id: Option<&str>,
) -> Result<String, Error> {
    let stub = env
        .durable_object("DIRECTORY")?
        .id_from_name(DIRECTORY_NAME)?
        .get_stub()?;
    let mut url = format!("https://directory/bind?room={room}");
    if let Some(host_id) = host_id {
        url.push_str("&hostId=");
        url.push_str(host_id);
    }
    let mut resp = stub.fetch_with_str(&url).await?;
    if resp.status_code() != 200 {
        return Err(Error::RustError(format!(
            "directory bind failed ({})",
            resp.status_code()
        )));
    }
    let text = resp.text().await?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| Error::RustError(format!("directory reply parse: {e}")))?;
    parsed
        .get("code")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| Error::RustError("directory returned no code".into()))
}
