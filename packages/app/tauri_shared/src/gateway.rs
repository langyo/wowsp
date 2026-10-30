//! Gateway-push wire types (docs/en/designs/gateway-push.md §3, §9).
//!
//! The desktop/phone gateway client speaks to a Cloudflare Worker route
//! entry (`{root}/health`, `{root}/session`, `{root}/pub`,
//! `{root}/sub`). Everything crossing the Tauri IPC boundary — the
//! persisted client config, the health document, session tickets, the
//! state/battle events and the self-host wizard payloads — lives here so
//! the webui mirrors one source of truth.

use serde::{Deserialize, Serialize};

/// The built-in (official deployment) route entry the client config
/// defaults to. The URL policy (`commands::pairing_relay::urls`) trims
/// the trailing slash on normalize; both spellings address the same
/// worker routes.
pub const BUILTIN_GATEWAY_ROOT_URL: &str = "https://wowsp.langyo.xyz/gateway/";

/// Persisted gateway client configuration (`gateway-config.json` in the
/// appdata dir, same pattern as `pairing-relay-config.json`). `root` is
/// the NORMALIZED route entry every endpoint hangs off; `enabled` is the
/// desktop's mobile-service toggle (default OFF — push only happens for
/// users who opted in).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayClientConfig {
    pub root: String,
    pub enabled: bool,
}

impl Default for GatewayClientConfig {
    fn default() -> Self {
        Self {
            root: BUILTIN_GATEWAY_ROOT_URL.to_string(),
            enabled: false,
        }
    }
}

/// `GET {root}/health` deployment document (gateway-push §3.1). Every
/// field is leniently defaulted so a partially-shaped body still parses —
/// the client-side validator separates a foreign 200 (captive portal)
/// from a real gateway document.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayHealthDoc {
    /// Protocol generation, `"v1"` — anything newer is unsupported.
    pub gateway: String,
    /// Minimum app version the deployment serves (the same gate the
    /// pairing relay's health document carries).
    pub min_client_version: Option<String>,
    pub auth: GatewayAuthDoc,
    /// Optional operator notice (logged, no dedicated UI).
    pub notice: Option<String>,
}

/// Credential demands of a deployment (health doc `auth` block).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayAuthDoc {
    pub turnstile: GatewayTurnstileDoc,
    pub password: GatewayPasswordDoc,
}

/// Turnstile gating. `sitekey` is OMITTED (not null) when Turnstile is
/// off — the widget only mounts when `required` and the sitekey exist.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayTurnstileDoc {
    pub required: bool,
    pub sitekey: Option<String>,
}

/// Password gating (the deployment's `GATEWAY_PASSWORD` secret).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayPasswordDoc {
    pub required: bool,
}

/// `POST {root}/session` success body (the fields the client consumes;
/// the worker also echoes `route`, ignored here).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySessionTicket {
    /// Single-use ticket (32 lowercase hex), consumed at the first WS
    /// upgrade.
    pub ticket: String,
    /// Ticket lifetime in seconds (≤ 120).
    pub ttl: u64,
}

/// Payload of the `wowsp://gateway-state` event: one role's lifecycle
/// phase. `phase` is `"resolving" | "captcha" | "connecting" |
/// "online" | "error" | "stopped"`; `detail` carries the stable error
/// marker (or a short reason) on `error`/`captcha`/`stopped`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStateEvent {
    /// `"pub"` (desktop publisher) | `"sub"` (phone subscriber).
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Live subscriber count on the publisher's channel — host-only
    /// telemetry the worker pushes on every join/leave (`subs` frame).
    /// Only the `pub` role carries it; the tray's phone-linked
    /// indicator reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscribers: Option<u32>,
}

/// Snapshot of the desktop publisher's current link state — what the
/// tray panel reads on mount (the `wowsp://gateway-state` event only
/// covers transitions that happened while it was listening).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPublishStatus {
    /// The mobile service is switched on (config `enabled`).
    pub enabled: bool,
    /// `true` while the publisher's socket holds the channel.
    pub active: bool,
    /// The channel route of the current/last session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    /// The last emitted lifecycle phase for the `pub` role.
    pub phase: String,
    /// The last known phone count (0 while none is linked).
    pub subscribers: u32,
}

/// The local player block of a battle frame (gateway-push §3.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayBattleSelf {
    /// Local player nickname (the roster's `relation == 0` entry).
    pub name: String,
    /// Account id when known (session hub identity or the route id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<i64>,
}

/// One roster entry of a battle frame — the app's `VehicleEntry` shape
/// 1:1 minus nothing (`id`/`name`/`relation`/`shipId`/`shipName`),
/// so the phone maps it into its roster store without translation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayBattleVehicle {
    pub id: i64,
    pub name: String,
    /// `0` = self, `1` = ally, `2+` = enemy — teams derive from it,
    /// exactly like the local arena roster.
    pub relation: i64,
    pub ship_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_name: Option<String>,
}

/// The battle block of a battle frame — the app's `ArenaInfo` head
/// fields 1:1 minus `raw`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayBattleHead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default)]
    pub bot_count: u32,
    #[serde(default)]
    pub scripted_unit_count: u32,
    #[serde(default)]
    pub vehicles: Vec<GatewayBattleVehicle>,
}

/// A battle frame (`{"type":"battle",…}`, gateway-push §3.3): what the
/// desktop publisher sends on every NEW battle (and the roster-heal
/// republish) and the phone's live view renders through the existing
/// ArenaInfo-shaped components.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GatewayBattleFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub realm: String,
    pub route: String,
    #[serde(rename = "self")]
    pub self_player: GatewayBattleSelf,
    pub battle: GatewayBattleHead,
}

/// `gateway_selfhost_probe` result: the toolchain the self-host wizard
/// found on PATH. Every missing piece is `None` — the wizard offers to
/// install it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SelfhostEnv {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npx_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rustc: Option<String>,
    /// `Some("wasm32-unknown-unknown")` when the Rust wasm32 target is
    /// installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wasm_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_build: Option<String>,
    /// Whether `npx wrangler whoami` resolved an authenticated session.
    pub wrangler_authed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// `gateway_selfhost_step` result — which step ran plus the fields that
/// step produces (`kvId` for kv-ensure, `url`/`health` for
/// deploy/verify, `account` for list-zones).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SelfhostStepResult {
    pub step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<GatewayHealthDoc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// Payload of the `wowsp://gateway-selfhost` wizard stream: one output
/// line (`stream = "stdout" | "stderr"`) or the step's completion
/// (`stream = "done"` with the optional `result`). Wrangler's own
/// output passes through verbatim — it never prints the CF token
/// (AGENTS.md §7; the login state lives in wrangler's own profile).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySelfhostEvent {
    pub step: String,
    pub stream: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<SelfhostStepResult>,
}
