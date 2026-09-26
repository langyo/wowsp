//! Internet pairing gateway (v2): a Cloudflare Worker rendezvous
//! (`packages/pairing-relay`, deployed by the owner at
//! `wowsp.langyo.xyz` — the same worker also serves the website
//! statically) lets the phone pair from OUTSIDE the desktop's LAN by
//! tunneling the exact same pairing HTTP protocol the LAN server speaks.
//! The gateway is a HIDDEN built-in service — nothing is user-configured;
//! development points it elsewhere via the undocumented `WOWSP_RELAY_URL`
//! environment variable.
//!
//! # Gateway compatibility layer (protocol v2)
//!
//! The built-in address is FIXED and may later FORWARD to someone else's
//! exchange infrastructure, so clients never assume the gateway itself
//! speaks our protocol forever. Before the first socket of a pairing
//! session, both roles RESOLVE the gateway:
//!
//! 1. `GET https://<root>/api/health` (5 s timeout, `no-store`) — the
//!    merged liveness + discovery document. The root starts at the
//!    built-in `https://wowsp.langyo.xyz` (the `WOWSP_RELAY_URL` dev
//!    override replaces it).
//! 2. No document (transport error / 404 / non-200 / foreign body) →
//!    LEGACY DIRECT MODE: the tunnels dial `wss://<root>/api/relay`.
//! 3. A document with `upstream != null` → re-resolve at that URL (at
//!    most 2 hops; a cycle or an over-long chain degrades to legacy
//!    direct mode at the INITIAL root).
//! 4. The final document must pass the `minClientVersion` gate (a
//!    distinct update-the-app error otherwise) and list protocol `v1` —
//!    otherwise a clear unsupported-protocol error surfaces (the desktop
//!    stays LAN-only, the phone shows a distinct toast).
//!    `endpoints.relay` (path or absolute wss URL) becomes the WebSocket
//!    base.
//!
//! The resolved gateway is cached for the pairing session (short TTL), and
//! its `provider` / `viaUpstream` / `notice` fields ride the pairing status.
//!
//! # Wire protocol
//!
//! Every control/resolve socket performs the v2 handshake: the client sends
//! `{"type":"hello","protocol":"v1","hostId":"<32 hex>"}` and awaits a
//! `welcome`. A legacy v1 server that ignores the hello (or goes straight
//! into the v1 flow) is tolerated — whatever arrives first is processed as
//! the v1 flow. `hostId` is a PERSISTIVE random id (`pairing-host-id.txt`)
//! so the gateway's directory can replace our previous active code.
//!
//! Byte-tunnel data sockets cap outgoing binary frames at 256 KiB (larger
//! writes are chunked — the frames reassemble invisibly on the peer's TCP
//! side), accept incoming frames up to 1 MiB, and EVERY relay socket
//! text-pings every 30 s (Cloudflare drops idle proxied connections at
//! ~100 s).
//!
//! # Roles
//!
//! - **CONFIG (all targets)** — `pairing_get_relay_config` /
//!   `pairing_set_relay` persist `RelayConfig { enabled }` to
//!   `pairing-relay-config.json` (same pattern as network-config.json).
//!   Default: enabled — the gateway is tried on every server start; there is
//!   no URL field anymore.
//!
//! - **HOST BRIDGE (desktop)** — while the pairing server runs and the relay
//!   is enabled, a background session resolves the gateway, connects an
//!   outbound wss CONTROL channel as `role=host` (room = a 64-hex random id
//!   minted at server start) and asks the worker to allocate the pairing
//!   code (`{"type":"allocate"}` → `{"type":"code","code":"XXXXXX"}`). The
//!   allocated code becomes the desktop's displayed pairing code (and the
//!   server's extra accepted /pair secret). On a `{type:"conn", connId}`
//!   signal it dials the LOCAL pairing server over loopback TCP
//!   (`127.0.0.1:<port>`) and opens a second data WebSocket for that conn;
//!   from then on bytes are piped verbatim in both directions. No protocol
//!   redesign: a tunneled request is byte-identical to a LAN request.
//!
//! - **CLIENT (all targets — the phone)** — the transport half of the
//!   pairing commands: resolve the 6-digit code to a room
//!   (`WS /resolve?code=…` → `{"type":"room"}`), connect a control channel
//!   as `role=client`, ask for a connection (`{type:"open"}`), open the data
//!   socket, then write raw HTTP request bytes and parse the raw response
//!   off the stream. Progress events, error strings, throttling and the
//!   503-while-building retry loop are the LAN client's, reused.
//!
//! Security posture: rooms are keyed by a random 64-hex id minted on the
//! desktop — never derived from the PIN. The gateway is nonetheless a
//! TRUSTED component: its operator sees every code→room binding and could
//! join a room as a fake host and MITM the /pair exchange — which is why the
//! endpoint is first-party (wowsp.langyo.xyz; a resolved `upstream`
//! inherits that trust by construction, it is reached only through the
//! pinned root's own manifest). Payloads are plain HTTP inside the tunnel,
//! same as the LAN; the token/data sniffing caveat of the LAN server applies
//! verbatim.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};
use wowsp_tauri_shared::{
    PairingProgress, PairingStatus, PairingToken, RelayConfig, ReplayMetaLite,
};

use super::network;
use super::pairing::{self, GAMEDATA_SENTINEL, emit_progress, http_error};

/// The built-in internet-pairing gateway ROOT, in its https spelling — the
/// merged health document is fetched from `<root>/api/health` and the
/// WebSocket base is derived from it. The worker ALSO serves the website
/// statically at this host (Pages+Worker in one service); the owner binds
/// the DNS at deploy time (see packages/pairing-relay/README.md); the
/// webui keeps the same host in its `wss://` spelling
/// (`stores/pairing.ts` PAIRING_GATEWAY_WS) — both normalize to this root.
pub const BUILTIN_RELAY_ROOT_URL: &str = "https://wowsp.langyo.xyz";
/// Undocumented DEVELOPMENT override for the built-in gateway root
/// (never surfaced in any UI; see the worker package README).
pub const RELAY_URL_ENV: &str = "WOWSP_RELAY_URL";

/// Stable error marker the frontend maps to a friendly "gateway
/// unreachable" state: covers both an unreachable gateway and a code the
/// gateway does not know (unknown/expired) — from the phone both mean
/// "check the code and your connection".
pub const GATEWAY_UNREACHABLE: &str = "pairing gateway unreachable or code not found";
/// Stable, DISTINCT error for a resolved gateway whose health document
/// does not list protocol `v1` — the built-in address forwards to
/// infrastructure that no longer speaks a protocol we understand. Must
/// NOT collapse into [`GATEWAY_UNREACHABLE`]: the user cannot fix it by
/// retrying.
pub const UNSUPPORTED_PROTOCOL: &str = "the pairing gateway speaks an unsupported pairing protocol";
/// Stable, DISTINCT error for a gateway whose health document demands a
/// newer client than this build (minClientVersion gate). The only fix is
/// updating the app — surfaced as such, never as a retryable failure.
pub const CLIENT_TOO_OLD: &str = "the pairing gateway requires a newer app version";
/// Stable, DISTINCT error for the gateway's directory rate-limiting us
/// (resolve/control `err` replies carrying `reason: "rate_limited"`).
pub const GATEWAY_RATE_LIMITED: &str =
    "the pairing gateway is rate limiting requests, retry shortly";

/// The desktop pairing server port suffix of a relay worker URL is not a
/// thing — the worker is a single origin. Timeout bounds for the client,
/// mirroring the LAN client's reqwest timeouts.
const PAIR_TIMEOUT: Duration = Duration::from_secs(20);
const LIST_TIMEOUT: Duration = Duration::from_secs(40);
/// Overall cap for waiting out the worker's "no host yet" state (the desktop
/// bridge reconnects within a few seconds; anything longer means it is off).
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Bound for the code→room resolve handshake.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);
/// Bound for the v2 hello→welcome handshake before treating the server as
/// legacy v1 (a legacy worker ignores unknown text frames in silence).
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound for a relay WebSocket connect (TCP + TLS + WS handshake).
/// Cloudflare's edge answers in well under a second; an unbounded await
/// here would let a black-holed route hang a pairing command for the
/// OS-level connect timeout (minutes on some stacks) — this bound turns
/// that into the same "gateway unreachable" error a refused connection
/// produces.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Text-ping interval on EVERY relay socket. Cloudflare drops idle proxied
/// connections at ~100 s; 30 s keeps even multi-minute gamedata pulls warm.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// Byte-tunnel frame cap: outgoing binary frames are chunked to this size
/// (the worker rejects larger frames).
const MAX_OUTGOING_FRAME: usize = 256 * 1024;
/// Incoming frames are accepted up to this size (tungstenite config caps
/// message+frame); anything larger aborts the read.
const MAX_INCOMING_FRAME: usize = 1024 * 1024;
/// Request cap over the tunnel (the LAN server answers 413 beyond 8 KB; the
/// /pair body is the only one with a body).
const MAX_REQUEST_HEAD: usize = 32 * 1024;
const MAX_RESPONSE_BODY: usize = 4 * 1024 * 1024;

mod client;
mod code_state;
mod config;
mod gateway;
mod host_bridge;
mod host_id;
mod tunnel;
mod urls;
mod ws;

#[cfg(test)]
mod tests;

// Command functions and their doc(hidden) sibling macros stay reachable at
// the original `commands::pairing_relay::*` paths (lib.rs `generate_handler!`
// and `commands/pairing.rs` resolve them there).
#[cfg(test)]
use client::gateway_error;
pub use client::{relay_list_remote, relay_pair};
pub(crate) use client::{relay_pull_gamedata, relay_pull_replay};
#[allow(unused_imports)]
pub use code_state::relay_online;
pub use code_state::{current_relay_code, wait_for_code};
use code_state::{store_code, wait_for_new_code};
#[allow(unused_imports)]
pub use config::RELAY_CONFIG_FILE;
pub use config::{
    __cmd__pairing_get_relay_config, __cmd__pairing_set_relay,
    __tauri_command_name_pairing_get_relay_config, __tauri_command_name_pairing_set_relay,
    load_relay_config, pairing_get_relay_config, pairing_set_relay,
};
pub use gateway::current_gateway_info;
pub(super) use gateway::resolve_gateway_cached;
#[cfg(test)]
use gateway::{
    GatewayManifest, clear_resolution_cache_for_test, client_meets_minimum, finish_resolution,
    is_gateway_manifest, resolve_gateway,
};
use gateway::{gateway_info_of, store_gateway_info};
#[cfg(desktop)]
#[allow(unused_imports)]
pub use host_bridge::host_reallocate;
pub use host_bridge::{
    __cmd__pairing_reallocate_code, __tauri_command_name_pairing_reallocate_code,
    pairing_reallocate_code,
};
#[cfg(desktop)]
pub use host_bridge::{host_session_start, host_session_stop};
use host_id::persistent_host_id;
#[cfg(test)]
use host_id::{HOST_ID_FILE, host_id_in};
#[cfg(test)]
use tunnel::parse_response_head;
use tunnel::{open_tunnel, tunnel_request, tunnel_round_trip};
#[cfg(test)]
use urls::builtin_relay_root_from;
pub use urls::{builtin_relay_root, normalize_relay_root, normalize_relay_ws_url};
use urls::{
    conn_id, control_url, data_url, resolve_relay_endpoint, valid_code, valid_room, ws_base_of_root,
};
#[cfg(test)]
use ws::frame_chunks;
use ws::{
    ControlMsg, HelloOutcome, KeepaliveTask, Ws, hello_handshake, keepalive_text, next_control,
    park_keepalive, send_binary_chunked, ws_connect,
};
