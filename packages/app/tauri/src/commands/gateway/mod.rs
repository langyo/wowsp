//! Account-routed gateway push (docs/en/designs/gateway-push.md) — the
//! Rust client half, both roles.
//!
//! The gateway replaces the pairing CODE with a ROUTE ENTRY: the base URL
//! of a Cloudflare Worker deployment (`packages/pairing-relay`'s wasm
//! under `/gateway/*`). The desktop PUBLISHES every battle it detects to
//! the channel of its playing account (`r:<realm>:<accountId>`); the
//! phone — after confirming the same account — SUBSCRIBES and renders the
//! pushed battles through the same live components. Both sockets live in
//! Rust commands (the webui never dials a gateway WebSocket, the same
//! rule the code-relay follows).
//!
//! # Handshake (gateway-push §3, §5, §6)
//!
//! 1. `GET {root}/health` (5 s timeout, `no-store`, 64 KiB cap) — the
//!    deployment document (protocol `v1`, `minClientVersion`, credential
//!    demands). Failures map onto the stable error markers of §9:
//!    `gateway unreachable or health document invalid` /
//!    `gateway speaks an unsupported gateway protocol` /
//!    `gateway requires a newer app version`.
//! 2. If the deployment demands a Turnstile token the caller has none of,
//!    the role emits the `captcha` phase and STOPS — the token always
//!    enters through the webui (the widget renders there); the webui
//!    re-calls the start command with it.
//! 3. `POST {root}/session` exchanges the credentials for a single-use
//!    ticket (≤ 120 s), consumed by the first WS upgrade.
//! 4. WS `(wss)://{root}/pub?route=&ticket=[&hostId=]` (desktop) or
//!    `/sub?route=&ticket=` (phone) with the relay sockets' 30 s text
//!    keepalive and frame caps; battle frames are capped at 64 KiB
//!    (the server rejects larger with close 1009).
//!
//! # URL policy
//!
//! The route entry reuses the pairing relay's URL policy VERBATIM
//! (`pairing_relay::urls`): https/wss enforced, plain http/ws only on
//! explicit loopback hosts (dev against `wrangler dev`), any path prefix
//! allowed (the official entry lives under `/gateway/`).
//!
//! # Roles
//!
//! - **CONFIG (all targets)** — `gateway_get_config` /
//!   `gateway_set_config` persist `GatewayClientConfig { root, enabled }`
//!   to `gateway-config.json` (the `pairing-relay-config.json` pattern).
//!   `enabled` is the desktop's mobile-service toggle, default OFF.
//! - **HEALTH + SESSION (all targets)** — `gateway_get_health` /
//!   `gateway_open_session`: the shared handshake steps, usable directly
//!   by the webui (the phone's captcha sheet drives them step by step).
//! - **PUBLISHER (desktop)** — `gateway_publish_start` /
//!   `gateway_publish_stop` (`publish.rs`): the pub socket, fed by the
//!   `deliver_arena` Battle/RosterHeal hook through an mpsc channel.
//! - **SUBSCRIBER (all targets — the phone)** —
//!   `gateway_subscribe_start` / `gateway_subscribe_stop`
//!   (`subscribe.rs`): the sub socket; every received text frame is
//!   re-emitted to the webui as a `wowsp://gateway-battle` event.
//! - **SELF-HOST WIZARD (desktop)** — `gateway_selfhost_probe` /
//!   `gateway_selfhost_step` (`selfhost.rs`): toolchain probe + the
//!   wrangler-driven deploy steps, streamed as
//!   `wowsp://gateway-selfhost` events.
//!
//! Security posture: the route entry is user-configured (official default
//! `https://wowsp.langyo.xyz/gateway/`), TLS-enforced except loopback
//! dev; the Turnstile token and optional password cross the wire exactly
//! once per session exchange (`POST /session`, the worker's siteverify +
//! constant-time compare) and are never logged; the phone's received
//! frames pass through verbatim (the live view renders them through the
//! same ArenaInfo mapping it uses locally).

use anyhow::{Result, anyhow};

use wowsp_tauri_shared::GatewayStateEvent;

use super::pairing_relay;

// ── stable error markers (gateway-push §9 — the exact rejection strings) ────

/// Health fetch/parse failure of any kind (transport error, non-200,
/// oversize or foreign body).
pub const GATEWAY_UNREACHABLE: &str = "gateway unreachable or health document invalid";
/// A resolved gateway whose health document does not speak protocol `v1`.
pub const GATEWAY_UNSUPPORTED: &str = "gateway speaks an unsupported gateway protocol";
/// A gateway whose health document demands a newer client than this build.
pub const GATEWAY_TOO_OLD: &str = "gateway requires a newer app version";
/// The Turnstile exchange was refused (bad/expired token, or the gateway
/// could not reach siteverify — a retry with a fresh token is the remedy).
pub const GATEWAY_CAPTCHA_FAILED: &str = "gateway captcha verification failed";
/// The password exchange was refused.
pub const GATEWAY_PASSWORD_REJECTED: &str = "gateway password rejected";

/// The rate-limit rejection carries its retry budget: `N` = seconds.
pub fn gateway_rate_limited(retry_after_secs: u64) -> String {
    format!("gateway rate limited, retry after {retry_after_secs}s")
}

// ── events (gateway-push §9) ─────────────────────────────────────────────────

/// Role lifecycle phases, emitted on `wowsp://gateway-state`.
pub const GATEWAY_STATE_EVENT: &str = "wowsp://gateway-state";
/// Received battle frames (phone side), forwarded verbatim.
pub const GATEWAY_BATTLE_EVENT: &str = "wowsp://gateway-battle";
/// Self-host wizard output stream.
pub const GATEWAY_SELFHOST_EVENT: &str = "wowsp://gateway-selfhost";

pub const PHASE_RESOLVING: &str = "resolving";
pub const PHASE_CAPTCHA: &str = "captcha";
pub const PHASE_CONNECTING: &str = "connecting";
pub const PHASE_ONLINE: &str = "online";
pub const PHASE_ERROR: &str = "error";
pub const PHASE_STOPPED: &str = "stopped";

/// Emit one `wowsp://gateway-state` event (tolerates a missing emitter in
/// unit tests — real callers always pass a live `AppHandle`).
pub(crate) fn emit_state(
    app: &tauri::AppHandle,
    role: &str,
    route: Option<&str>,
    phase: &str,
    detail: Option<String>,
) {
    use tauri::Emitter as _;
    let _ = app.emit(
        GATEWAY_STATE_EVENT,
        GatewayStateEvent {
            role: role.to_string(),
            route: route.map(str::to_string),
            phase: phase.to_string(),
            detail,
        },
    );
}

// ── URL derivation (the relay URL policy, one spelling for the gateway) ─────

/// Normalize a route entry with the pairing relay's policy (https
/// enforced, loopback http tolerated, trailing slash trimmed, wss spellings
/// folded onto https). Every gateway command normalizes its root through
/// here before building a URL.
pub(crate) fn normalize_root(raw: &str) -> Result<String> {
    pairing_relay::normalize_relay_root(raw).map_err(|e| anyhow!("gateway route entry: {e}"))
}

/// The WebSocket base of an (already normalized) route entry: scheme
/// mapped https→wss / http→ws, path prefix kept. Plain ws survives only
/// on loopback roots (the relay's `enforce_wss_base` gate).
pub(crate) fn gateway_ws_base(root: &str) -> Result<String> {
    pairing_relay::normalize_relay_ws_url(root).map_err(|e| anyhow!("gateway route entry: {e}"))
}

/// Desktop publisher socket URL: `{ws-base}/pub?route=&ticket=[&hostId=]`.
/// `hostId` is the persistent publisher identity (32 hex) — a reconnect
/// with the same id replaces this publisher's previous socket cleanly, a
/// DIFFERENT host id takes the channel over (gateway-push §3.3).
#[cfg(desktop)]
pub(crate) fn pub_ws_url(root: &str, route: &str, ticket: &str, host_id: &str) -> Result<String> {
    Ok(format!(
        "{base}/pub?route={route}&ticket={ticket}&hostId={host_id}",
        base = gateway_ws_base(root)?
    ))
}

/// Subscriber socket URL: `{ws-base}/sub?route=&ticket=`.
pub(crate) fn sub_ws_url(root: &str, route: &str, ticket: &str) -> Result<String> {
    Ok(format!(
        "{base}/sub?route={route}&ticket={ticket}",
        base = gateway_ws_base(root)?
    ))
}

mod config;
mod health;
#[cfg(desktop)]
pub(crate) mod publish;
#[cfg(desktop)]
mod selfhost;
mod session;
mod subscribe;

#[cfg(test)]
mod tests;

// The command fns stay reachable at `commands::gateway::*` for lib.rs's
// `generate_handler!` (the submodules are private; the re-exports carry
// the `#[tauri::command]` macro twins along, the pairing_relay pattern).
pub use config::{
    __cmd__gateway_get_config, __cmd__gateway_set_config, __tauri_command_name_gateway_get_config,
    __tauri_command_name_gateway_set_config, gateway_get_config, gateway_set_config,
};
pub use health::{
    __cmd__gateway_get_health, __tauri_command_name_gateway_get_health, gateway_get_health,
};
#[cfg(desktop)]
pub use publish::{
    __cmd__gateway_publish_start, __cmd__gateway_publish_stop,
    __tauri_command_name_gateway_publish_start, __tauri_command_name_gateway_publish_stop,
    gateway_publish_start, gateway_publish_stop,
};
#[cfg(desktop)]
pub use selfhost::{
    __cmd__gateway_selfhost_probe, __cmd__gateway_selfhost_step,
    __tauri_command_name_gateway_selfhost_probe, __tauri_command_name_gateway_selfhost_step,
    gateway_selfhost_probe, gateway_selfhost_step,
};
pub use session::{
    __cmd__gateway_open_session, __tauri_command_name_gateway_open_session, gateway_open_session,
};
pub use subscribe::{
    __cmd__gateway_subscribe_start, __cmd__gateway_subscribe_stop,
    __tauri_command_name_gateway_subscribe_start, __tauri_command_name_gateway_subscribe_stop,
    gateway_subscribe_start, gateway_subscribe_stop,
};
