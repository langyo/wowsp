use serde::{Deserialize, Serialize};

/// State of the DESKTOP pairing server (`pairing_start` / `pairing_stop` /
/// `pairing_get_status`). While running, `host`/`port` is the LAN address the
/// phone types in and `pin` the 6-digit code it must enter to obtain a token.
/// Mobile builds always report `{ running: false }` — no server exists there.
///
/// V2 pairing: `pin` carries the WORKER-ALLOCATED pairing code while the
/// built-in internet gateway is reachable (`mode == "relay"`,
/// `relay_online == true`); when the gateway is unreachable the desktop falls
/// back to its locally-generated LAN PIN (`mode == "lan-local"`,
/// `relay_online == false`) and the UI shows a LAN-only hint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub running: bool,
    /// LAN IPv4 of this desktop (first non-loopback), when running.
    #[serde(default)]
    pub host: Option<String>,
    /// Bound TCP port, when running.
    #[serde(default)]
    pub port: Option<u16>,
    /// The 6-digit code shown on the desktop screen: the gateway-allocated
    /// pairing code in relay mode, the locally-generated PIN in LAN-only mode.
    #[serde(default)]
    pub pin: Option<String>,
    /// `"relay"` (internet gateway online) | `"lan-local"` (fallback), when
    /// running.
    #[serde(default)]
    pub mode: Option<String>,
    /// Whether the built-in internet gateway answered with a pairing code.
    #[serde(default)]
    pub relay_online: bool,
    /// Gateway manifest (protocol v2) field: the resolved gateway's
    /// self-described operator (e.g. `"wowsp"`, or a future exchange
    /// provider the built-in address forwards to). `None` in legacy v1
    /// direct mode (no manifest was served) or while the gateway is offline.
    /// Additive + default so older payloads keep parsing.
    #[serde(default)]
    pub provider: Option<String>,
    /// Gateway manifest (protocol v2) field: true when the resolved gateway
    /// was reached by FOLLOWING a manifest `upstream` hop (the fixed built-in
    /// address forwarded to someone else's infrastructure). Always false in
    /// legacy direct mode. Additive + default so older payloads keep parsing.
    #[serde(default)]
    pub via_upstream: bool,
    /// Gateway manifest (protocol v2) field: free-form operator notice from
    /// the manifest (logged by the app, no UI). `None` without a manifest.
    /// Additive + default so older payloads keep parsing.
    #[serde(default)]
    pub notice: Option<String>,
}

/// Success result of `pairing_pair` — the bearer token every subsequent
/// remote call (`pairing_list_remote` / `pairing_pull_replay` /
/// `pairing_pull_gamedata`) sends back to the desktop server. Relay mode
/// also returns the room key (the 64-hex random id the gateway resolved the
/// pairing code to) the session's tunnels are addressed by; LAN mode leaves
/// it `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingToken {
    pub token: String,
    /// Relay room key (64-hex random id), relay mode only.
    #[serde(default)]
    pub room: Option<String>,
}

/// Result of `import_replay_file` / `pairing_pull_replay`: the local path of
/// the replay that landed in the managed replays dir (after filename
/// sanitization + `(1)` dedupe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPathResult {
    pub path: String,
}

/// Result of `pairing_pull_gamedata`: how many cache files were extracted
/// into the local data dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamedataSyncResult {
    pub files: usize,
}

/// Progress push for one pairing transfer (`wowsp://pairing-progress` —
/// pairing keeps its OWN channel, it does not ride the unified download
/// hub). `phase` is `"download"` | `"done"` |
/// `"error"`; one event stream serves every concurrent transfer, so filter by
/// `remoteName` (the `":gamedata:"` sentinel marks the game-data sync).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingProgress {
    /// Remote file name (or the `":gamedata:"` sentinel).
    pub remote_name: String,
    pub phase: String,
    pub received: u64,
    /// Total bytes when known, else 0.
    pub total: u64,
    #[serde(default)]
    pub error: Option<String>,
}

/// Where a pairing call goes. Two transports carry the SAME pairing HTTP
/// protocol (see commands/pairing.rs):
///
/// - `lan` — direct HTTP to the desktop server discovered/typed on the LAN
///   (`host:port`).
/// - `relay` — the same bytes tunneled through the built-in Cloudflare
///   gateway (`packages/pairing-relay`) for cross-network pairing. `room`
///   carries the 64-hex random room key the gateway resolved the pairing
///   code to. It is `None` only on the code-exchange call itself (the
///   gateway resolves the code to the room and the result hands the key
///   back for the session).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PairingTarget {
    /// Direct LAN HTTP to the desktop pairing server.
    Lan { host: String, port: u16 },
    /// HTTP-over-WebSocket-tunnel through the built-in pairing gateway.
    /// `room` is the 64-hex random room key (`None` only for the code
    /// exchange, which resolves it from the 6-digit pairing code).
    Relay { url: String, room: Option<String> },
}

/// Configuration of the desktop's relay host bridge (a HIDDEN setting —
/// there is no UI field; the endpoint is the built-in gateway). Persisted to
/// `pairing-relay-config.json` in the AppData data dir. Enabled by default:
/// the internet gateway is tried on every server start, with automatic
/// LAN-only fallback when unreachable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RelayConfig {
    /// Whether the desktop bridges its pairing server through the built-in
    /// gateway while the server runs (`true` by default).
    pub enabled: bool,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// One desktop seen on the LAN via the UDP discovery broadcast
/// (`wowsp://pairing-discovery` snapshot entry).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    /// Broadcast peer IP — authoritative for reachability (the payload's
    /// self-reported address is never trusted for routing).
    pub host: String,
    /// Pairing server port from the broadcast payload.
    pub port: u16,
    /// Advertised computer name (the desktop's hostname).
    pub name: String,
    /// Seconds since the last broadcast arrived from this host.
    pub last_seen_age_sec: u64,
    /// Worker base URL the desktop advertises when its relay bridge is on —
    /// lets a phone adopt internet mode without typing the URL.
    #[serde(default)]
    pub relay: Option<String>,
}

/// Snapshot pushed on `wowsp://pairing-discovery` whenever the live list
/// changes (throttled to ~1 Hz by the listener).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySnapshot {
    pub hosts: Vec<DiscoveredHost>,
}
