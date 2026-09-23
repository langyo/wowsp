//! WoWSP pairing gateway — the Cloudflare Worker entry point
//! (Rust → wasm32-unknown-unknown via worker-build).
//!
//! Structure:
//! - [`relay_core`] carries every protocol/policy decision (pure, host
//!   testable — `cargo test -p relay-core`).
//! - this crate is routing + WebSocket glue only. The worker ALSO hosts
//!   the website's static assets (wrangler `[assets]`, served at `/`);
//!   `run_worker_first = ["/api/*"]` means only `/api` reaches this code:
//!   - `GET /api/health` — the merged liveness + discovery document
//!     (server version + minimum client version + relay endpoints;
//!     forwarding-station switch via the `GATEWAY_UPSTREAM` var,
//!     operator notes via `GATEWAY_NOTICE`).
//!   - `WS  /api/relay/control`, `/api/relay/resolve?code=`,
//!     `/api/relay/data/…` — forwarded to the two Durable Objects in
//!     [`directory`] (the singleton code Directory) and [`room`]
//!     (per-room rendezvous + byte pipes).

pub mod directory;
pub mod room;

pub use directory::Directory;
pub use room::Room;

use futures_util::StreamExt;
use relay_core::manifest::{ManifestOverrides, gateway_manifest};
use relay_core::protocol::{InboundFrame, OutboundFrame, error_codes, welcome};
use relay_core::route::{Route, classify};
use relay_core::{valid_code, valid_room};
use worker::{WebsocketEvent, *};

/// Singleton name of the code Directory DO.
const DIRECTORY_NAME: &str = "codes";
/// The resolve socket's server half is capped: the phone reads its
/// answer and closes; anything still open after this is a leak.
const RESOLVE_SOCKET_LIFETIME_MS: u32 = 10_000;

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();

    // The docs are NOT bundled: they live on the GitHub Pages mirror
    // (langyo.github.io/wowsp/docs, the same origin every built asset of
    // the site loads from) so Cloudflare stays out of the heavy-download
    // path. run_worker_first includes /docs so old links land here.
    if path == "/docs" || path.starts_with("/docs/") {
        let target = format!(
            "https://langyo.github.io/wowsp{path}{}",
            url.query().map_or(String::new(), |q| format!("?{q}"))
        );
        return Response::redirect(worker::Url::parse(&target)?);
    }

    let query = url.query().unwrap_or("").to_string();

    match classify(&path, &query) {
        Route::Health => {
            let upstream = env.var("GATEWAY_UPSTREAM").ok().map(|v| v.to_string());
            let notice = env.var("GATEWAY_NOTICE").ok().map(|v| v.to_string());
            let health = gateway_manifest(&ManifestOverrides::from_raw(
                upstream.as_deref(),
                notice.as_deref(),
            ));
            let mut resp = Response::from_json(&health)?;
            resp.headers_mut().set("cache-control", "no-store")?;
            Ok(resp)
        },

        Route::Control { room, role } => {
            let Some(room) = room.filter(|r| valid_room(r)) else {
                return Response::error("bad room key", 400);
            };
            if !matches!(role, Some("host") | Some("client")) {
                return Response::error("bad role", 400);
            }
            let stub = env.durable_object("ROOM")?.id_from_name(room)?.get_stub()?;
            stub.fetch_with_request(req).await
        },

        Route::Resolve { code } => resolve(req, env, code).await,

        Route::Data { room, .. } => {
            if !valid_room(room) {
                return Response::error("bad room key", 400);
            }
            let stub = env.durable_object("ROOM")?.id_from_name(room)?.get_stub()?;
            stub.fetch_with_request(req).await
        },

        Route::NotFound => Response::error("not found", 404),
    }
}

/// The phone's code → room handshake. Rate limiting and the once-claim
/// rule live in the Directory DO; this handler completes the WebSocket
/// handshake in the worker itself and answers with a single frame:
///
/// - success  → `{"type":"room","room":"<64hex>"}` then close
/// - blocked  → `{"type":"error","code":"rate_limited"}` then close
/// - unknown / expired / claimed-by-another-IP / malformed → the
///   handshake is refused with 404/400 (v1 behavior — the phone maps
///   any of these to the same friendly "check the code" state).
async fn resolve(req: Request, env: Env, code: Option<&str>) -> Result<Response> {
    let Some(code) = code.filter(|c| valid_code(c)) else {
        return Response::error("bad code", 400);
    };
    let ip = req
        .headers()
        .get("CF-Connecting-IP")?
        .unwrap_or_else(|| "local".to_string());

    let stub = env
        .durable_object("DIRECTORY")?
        .id_from_name(DIRECTORY_NAME)?
        .get_stub()?;
    let mut lookup = stub
        .fetch_with_str(&format!("https://directory/lookup?code={code}&ip={ip}"))
        .await?;

    let answer = match lookup.status_code() {
        200 => {
            let text = lookup.text().await?;
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("room").and_then(|r| r.as_str()).map(str::to_string))
                .filter(|room| valid_room(room))
                .map(|room| OutboundFrame::Room { room })
        },
        429 => Some(OutboundFrame::Error {
            code: error_codes::RATE_LIMITED.to_string(),
            size: None,
        }),
        _ => None,
    };
    let Some(answer) = answer else {
        return Response::error("unknown code", 404);
    };

    // Complete the WS handshake here (the socket never touches a DO) and
    // deliver the one frame. A v2 phone may have said hello first —
    // answer welcomes on the same socket while it lives.
    let pair = WebSocketPair::new()?;
    let server = pair.server.clone();
    server.accept()?;
    server.send_with_str(answer.to_text())?;

    let reader_socket = server.clone();
    wasm_bindgen_futures::spawn_local(async move {
        let mut events = match reader_socket.events() {
            Ok(events) => events,
            Err(_) => return,
        };
        while let Some(Ok(event)) = events.next().await {
            let WebsocketEvent::Message(msg) = event else {
                break;
            };
            if let Some(text) = msg.text() {
                if matches!(InboundFrame::parse(&text), InboundFrame::Hello { .. }) {
                    let _ = reader_socket.send_with_str(&welcome().to_text());
                }
            }
        }
    });

    let closer = server.clone();
    wasm_bindgen_futures::spawn_local(async move {
        Delay::from(std::time::Duration::from_millis(
            RESOLVE_SOCKET_LIFETIME_MS as u64,
        ))
        .await;
        let _ = closer.close(Some(1000), Some("resolved"));
    });

    Ok(Response::from_websocket(pair.client)?)
}
