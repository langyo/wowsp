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

use super::pairing::{GAMEDATA_SENTINEL, emit_progress, http_error};

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

// ── gateway resolution (protocol v2) ────────────────────────────────────────

/// Health-document route (merged liveness + discovery), fetched from
/// `<root>/api/health` with a 5 s timeout and `Cache-Control: no-store`.
const MANIFEST_PATH: &str = "/api/health";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(5);
/// A manifest body beyond this is not ours — treat like a non-200.
const MANIFEST_MAX_BYTES: usize = 64 * 1024;
/// How many `upstream` hops resolution follows before degrading to the
/// initial root (a cycle aborts the same way).
const MAX_UPSTREAM_HOPS: usize = 2;
/// Resolved-gateway cache lifetime — a pairing session resolves once and
/// every later socket of the session reuses the result.
const RESOLUTION_TTL: Duration = Duration::from_secs(300);
/// The persistent host identity file (32 hex chars, created on first use).
const HOST_ID_FILE: &str = "pairing-host-id.txt";

/// The v2 gateway health document. Every field defaults so a
/// partially-shaped JSON body still parses; [`is_gateway_manifest`]
/// separates real documents from foreign 200 responses (captive portals
/// and friends).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayManifest {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    name: String,
    /// The gateway's own version (informational).
    #[serde(default)]
    version: Option<String>,
    /// The minimum client the gateway serves — enforced by
    /// [`client_meets_minimum`] before anything else.
    #[serde(default)]
    min_client_version: Option<String>,
    #[serde(default)]
    protocol: Vec<String>,
    #[serde(default)]
    endpoints: GatewayEndpoints,
    #[serde(default)]
    upstream: Option<String>,
    #[serde(default)]
    features: Vec<String>,
    #[serde(default)]
    notice: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayEndpoints {
    #[serde(default)]
    relay: String,
}

/// A body only counts as a gateway document when it says something
/// gateway-ish — a protocol list or a relay endpoint. Anything else that
/// parses as JSON (e.g. a captive portal's 200) is treated as "no
/// document" so resolution degrades to legacy direct mode instead of
/// erroring.
fn is_gateway_manifest(m: &GatewayManifest) -> bool {
    !m.protocol.is_empty() || !m.endpoints.relay.is_empty()
}

/// Numeric `x.y.z` comparison of dotted versions (any trailing non-numeric
/// suffix on a part is ignored; missing parts count as 0). Returns true
/// when `client` >= `minimum`.
fn client_meets_minimum(client: &str, minimum: &str) -> bool {
    let nums = |v: &str| {
        v.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>()
    };
    let (c, m) = (nums(client), nums(minimum));
    for i in 0..c.len().max(m.len()) {
        let (a, b) = (
            c.get(i).copied().unwrap_or(0),
            m.get(i).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    true
}

/// The outcome of resolving a gateway root through the v2 manifest protocol.
#[derive(Debug, Clone)]
pub(crate) struct GatewayResolution {
    /// The WebSocket base every tunnel of the session dials
    /// (`…/control`, `…/resolve`, `…/data/…` hang off it).
    ws_base: String,
    /// The final manifest when one was served (`None` = legacy v1 direct
    /// mode — no manifest existed).
    manifest: Option<GatewayManifest>,
    /// At least one `upstream` hop was followed to reach the final gateway.
    via_upstream: bool,
}

/// Manifest-derived info the desktop's `PairingStatus` surfaces while a
/// bridge session is live (all defaults in legacy direct mode / offline).
#[derive(Debug, Clone, Default)]
pub struct GatewayInfo {
    pub provider: Option<String>,
    pub via_upstream: bool,
    pub notice: Option<String>,
}

fn gateway_info_of(res: &GatewayResolution) -> GatewayInfo {
    match &res.manifest {
        Some(m) => GatewayInfo {
            provider: (!m.provider.is_empty()).then(|| m.provider.clone()),
            via_upstream: res.via_upstream,
            notice: m.notice.clone(),
        },
        None => GatewayInfo::default(),
    }
}

fn gateway_info_slot() -> &'static Mutex<Option<GatewayInfo>> {
    static SLOT: OnceLock<Mutex<Option<GatewayInfo>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Resolved-gateway info of the CURRENT bridge session (defaults while
/// offline or in legacy direct mode) — feeds `PairingStatus`.
pub fn current_gateway_info() -> GatewayInfo {
    gateway_info_slot()
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

fn store_gateway_info(info: Option<GatewayInfo>) {
    if let Ok(mut slot) = gateway_info_slot().lock() {
        *slot = info;
    }
}

/// One manifest fetch. `Ok(None)` = "no v2 manifest here" (transport error,
/// non-200, oversize or foreign body) — the caller falls back to legacy
/// direct mode; only a clean gateway manifest yields `Ok(Some(..))`.
async fn fetch_manifest(url: &str) -> Result<Option<GatewayManifest>, String> {
    // The SAME shared HTTP client every other outbound request uses: the
    // Android CA-bundle client there, SChannel on the desktop.
    let client = super::network::build_http_client()?;
    let resp = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .timeout(MANIFEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("manifest fetch failed ({e})"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let Ok(body) = resp.bytes().await else {
        return Ok(None);
    };
    if body.len() > MANIFEST_MAX_BYTES {
        return Ok(None);
    }
    match serde_json::from_slice::<GatewayManifest>(&body) {
        Ok(m) if is_gateway_manifest(&m) => Ok(Some(m)),
        _ => Ok(None),
    }
}

fn manifest_url(root: &str) -> String {
    format!("{root}{MANIFEST_PATH}")
}

/// Legacy v1 direct mode: the tunnels dial the root itself over WebSocket.
fn legacy_resolution(root: &str) -> GatewayResolution {
    GatewayResolution {
        ws_base: ws_base_of_root(root),
        manifest: None,
        via_upstream: false,
    }
}

/// Resolve a gateway root (see the module docs for the algorithm). Errors
/// ONLY on an unsupported final protocol — every other failure degrades to
/// legacy direct mode.
async fn resolve_gateway(root_raw: &str) -> Result<GatewayResolution, String> {
    let initial = normalize_relay_root(root_raw)?;
    let mut current = initial.clone();
    let mut seen = vec![initial.clone()];
    let mut via_upstream = false;
    // One manifest fetch per iteration: the initial root plus at most
    // MAX_UPSTREAM_HOPS forwarded ones.
    for _ in 0..=MAX_UPSTREAM_HOPS {
        let manifest = match fetch_manifest(&manifest_url(&current)).await {
            Ok(Some(m)) => m,
            // Fetch failure / non-200 / foreign body → legacy direct mode
            // at the root we were fetching.
            _ => return Ok(legacy_resolution(&current)),
        };
        tracing::debug!(
            provider = %manifest.provider,
            name = %manifest.name,
            healthy = manifest.ok,
            version = ?manifest.version,
            features = ?manifest.features,
            "gateway health document resolved"
        );
        // A gateway that explicitly reports itself unhealthy gets the
        // same treatment as one we could not ask: legacy direct mode at
        // the root (dialing its documented endpoints is not sensible).
        if !manifest.ok {
            tracing::warn!("gateway reports ok:false — legacy direct mode");
            return Ok(legacy_resolution(&current));
        }
        let upstream = manifest
            .upstream
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(upstream) = upstream else {
            return finish_resolution(&current, manifest, via_upstream);
        };
        let next = match normalize_relay_root(upstream) {
            Ok(n) => n,
            Err(_) => {
                tracing::warn!(
                    upstream,
                    "gateway manifest upstream is not a URL — degrading to the built-in root"
                );
                return Ok(legacy_resolution(&initial));
            },
        };
        if seen.contains(&next) {
            tracing::warn!("gateway manifest upstream cycle — degrading to the built-in root");
            return Ok(legacy_resolution(&initial));
        }
        seen.push(next.clone());
        current = next;
        via_upstream = true;
    }
    tracing::warn!(
        "gateway manifest chain exceeds the hop budget — degrading to the built-in root"
    );
    Ok(legacy_resolution(&initial))
}

/// Validate the FINAL health document (minimum-version gate + protocol
/// check + endpoint resolution).
fn finish_resolution(
    root: &str,
    manifest: GatewayManifest,
    via_upstream: bool,
) -> Result<GatewayResolution, String> {
    // The version gate runs FIRST: a too-old app must hear "update the
    // app", never a protocol/endpoint complaint it cannot act on.
    if let Some(min) = manifest
        .min_client_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !client_meets_minimum(env!("CARGO_PKG_VERSION"), min) {
            tracing::warn!(
                client = env!("CARGO_PKG_VERSION"),
                minimum = min,
                "the pairing gateway demands a newer client"
            );
            return Err(CLIENT_TOO_OLD.to_string());
        }
    }
    if !manifest
        .protocol
        .iter()
        .any(|p| p.eq_ignore_ascii_case("v1"))
    {
        tracing::warn!(
            protocol = ?manifest.protocol,
            "the resolved gateway speaks an unsupported pairing protocol"
        );
        return Err(UNSUPPORTED_PROTOCOL.to_string());
    }
    match resolve_relay_endpoint(root, &manifest.endpoints.relay) {
        Ok(ws_base) => Ok(GatewayResolution {
            ws_base,
            manifest: Some(manifest),
            via_upstream,
        }),
        Err(e) => {
            tracing::warn!(error = %e, "manifest relay endpoint unusable — legacy direct mode");
            Ok(legacy_resolution(root))
        },
    }
}

struct CachedResolution {
    res: GatewayResolution,
    at: std::time::Instant,
}

fn resolution_cache() -> &'static Mutex<HashMap<String, CachedResolution>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedResolution>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the gateway ONCE per pairing session: successes are cached for
/// [`RESOLUTION_TTL`] keyed by the normalized root, so every relay operation
/// of a session dials the same resolved endpoint without re-fetching the
/// manifest. Failures (unsupported protocol) are never cached — they must
/// surface on every call.
pub async fn resolve_gateway_cached(root: &str) -> Result<GatewayResolution, String> {
    let key = normalize_relay_root(root)?;
    if let Ok(cache) = resolution_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            if hit.at.elapsed() < RESOLUTION_TTL {
                return Ok(hit.res.clone());
            }
        }
    }
    let res = resolve_gateway(&key).await?;
    if let Ok(mut cache) = resolution_cache().lock() {
        cache.insert(
            key,
            CachedResolution {
                res: res.clone(),
                at: std::time::Instant::now(),
            },
        );
    }
    Ok(res)
}

/// Test surface: drop cached resolutions so a later test binding the same
/// loopback port re-resolves against its own mock.
#[cfg(test)]
fn clear_resolution_cache_for_test() {
    if let Ok(mut cache) = resolution_cache().lock() {
        cache.clear();
    }
}

// ── persistent host identity ────────────────────────────────────────────────

/// The PERSISTENT host identity sent in every v2 hello handshake (`hostId`,
/// 32 hex chars). The gateway's directory keys "one active code per host" by
/// it, so a reconnect replaces the previous code instead of orphaning it.
/// Stored via the appdata helpers (`pairing-host-id.txt`, create-if-missing).
pub fn persistent_host_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        crate::paths::ensure_data_dir()
            .map(|dir| host_id_in(&dir))
            .unwrap_or_else(|_| random_host_id().unwrap_or_else(|_| "0".repeat(32)))
    })
    .clone()
}

/// `persistent_host_id` against an explicit directory (testable core): read
/// a valid id, or mint + persist one.
fn host_id_in(dir: &std::path::Path) -> String {
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
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn random_host_id() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| format!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}

// ── URL / key helpers (all targets, pure) ────────────────────────────────────

/// The gateway ROOT the desktop bridge resolves: the built-in constant
/// unless the development override (`WOWSP_RELAY_URL`) is set to a
/// non-empty value.
pub fn builtin_relay_root() -> String {
    builtin_relay_root_from(std::env::var(RELAY_URL_ENV).ok().as_deref())
}

/// Pure core of [`builtin_relay_root`] (testable without touching the
/// process environment). An unusable override falls back to the built-in
/// root rather than erroring — a bad dev var must not break pairing.
fn builtin_relay_root_from(override_raw: Option<&str>) -> String {
    match override_raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            normalize_relay_root(raw).unwrap_or_else(|_| BUILTIN_RELAY_ROOT_URL.to_string())
        },
        None => BUILTIN_RELAY_ROOT_URL.to_string(),
    }
}

/// Case-insensitive scheme strip (keeps the rest of the URL verbatim).
fn strip_scheme_ci<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    (url.len() >= scheme.len() && url[..scheme.len()].eq_ignore_ascii_case(scheme))
        .then(|| &url[scheme.len()..])
}

/// Normalize any plausible gateway URL into its http(s) ROOT form (the
/// health document is fetched from `<root>/api/health`): `wss:`→`https:`,
/// `ws:`→`http:`, a bare host gets `https://`. A path prefix on the root is
/// allowed (routed gateways). Returns Err on anything that cannot be a
/// gateway origin.
pub fn normalize_relay_root(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("relay URL is empty".to_string());
    }
    let out = if let Some(rest) = strip_scheme_ci(url, "https://") {
        format!("https://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = strip_scheme_ci(url, "wss://") {
        format!("https://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = strip_scheme_ci(url, "http://") {
        format!("http://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = strip_scheme_ci(url, "ws://") {
        format!("http://{}", rest.trim_end_matches('/'))
    } else if url.contains("://") || url.starts_with('/') {
        return Err(format!("unsupported relay URL scheme: {raw}"));
    } else {
        format!("https://{}", url.trim_end_matches('/'))
    };
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty()
        || after_scheme.starts_with('?')
        || after_scheme.starts_with('/')
        || after_scheme.contains("://")
    {
        return Err(format!("unsupported relay URL: {raw}"));
    }
    Ok(out)
}

/// Turn a worker URL into the WebSocket base the tunnels dial: trim, strip a
/// trailing slash, and map the scheme (`https:` → `wss:`, `http:` → `ws:`;
/// a bare host gets `wss:`). Returns Err on anything that cannot plausibly
/// be a worker origin.
pub fn normalize_relay_ws_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("relay URL is empty".to_string());
    }
    let lowered = url.to_ascii_lowercase();
    let out = if let Some(rest) = lowered.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = lowered.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if lowered.starts_with("wss://") || lowered.starts_with("ws://") {
        url.to_string()
    } else if lowered.contains("://") || lowered.starts_with('/') {
        return Err(format!("unsupported relay URL scheme: {raw}"));
    } else {
        format!("wss://{url}")
    };
    // A path prefix is allowed (workers can be routed behind a custom
    // domain path) as long as it stays path-shaped.
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty() || after_scheme.starts_with('?') || after_scheme.contains("://") {
        return Err(format!("unsupported relay URL: {raw}"));
    }
    Ok(out)
}

/// The legacy direct-mode WebSocket base of an (already normalized)
/// root: the relay routes live under `/api/relay` on the same origin.
fn ws_base_of_root(root: &str) -> String {
    let base = if let Some(rest) = root.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = root.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{root}")
    };
    format!("{base}/api/relay")
}

/// Resolve the final manifest's `endpoints.relay` against the root it was
/// served from: a path becomes `<ws-scheme>://<root host><path>` (any path
/// prefix on the root is REPLACED — the endpoint addresses the host), an
/// absolute URL must already be ws/wss (the tunneled protocol is
/// WebSocket-only; `wss` in production, `ws` tolerated for local
/// development against plain loopback gateways).
fn resolve_relay_endpoint(root: &str, relay: &str) -> Result<String, String> {
    let relay = relay.trim();
    if relay.is_empty() {
        return Err("manifest has no relay endpoint".to_string());
    }
    if let Some(rest) = strip_scheme_ci(relay, "wss://") {
        return Ok(format!("wss://{rest}"));
    }
    if let Some(rest) = strip_scheme_ci(relay, "ws://") {
        return Ok(format!("ws://{rest}"));
    }
    if !relay.starts_with('/') {
        return Err(format!(
            "manifest relay endpoint must be a wss URL or a path: {relay}"
        ));
    }
    let after_scheme = root.split_once("://").map(|(_, r)| r).unwrap_or(root);
    let host = after_scheme.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(format!("malformed gateway root: {root}"));
    }
    let scheme = if root.starts_with("https://") {
        "wss"
    } else {
        "ws"
    };
    Ok(format!("{scheme}://{host}{relay}"))
}

/// Random 16-hex-char connection id (OS CSPRNG — getrandom is a direct dep
/// on every target).
fn conn_id() -> Result<String, String> {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| format!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}

/// A pairing code the phone enters must be exactly 6 digits.
fn valid_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

fn control_url(ws_base: &str, room: &str, role: &str) -> String {
    format!("{ws_base}/control?room={room}&role={role}")
}

fn data_url(ws_base: &str, room: &str, conn: &str, side: &str) -> String {
    format!("{ws_base}/data/{room}?conn={conn}&side={side}")
}

/// Validate a room key before it may appear in a URL (the worker enforces
/// the same shape: 64 lowercase hex).
fn valid_room(room: &str) -> bool {
    room.len() == 64
        && room
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// ── WebSocket plumbing ───────────────────────────────────────────────────────

/// The rustls ring provider must be the process default before the first
/// wss connect (tungstenite builds `ClientConfig::builder()`, which panics
/// without one). Android installs it at startup; elsewhere this is a no-op
/// after the first call. Idempotent and lock-free — `install_default` hands
/// back the previous provider if one exists.
fn ensure_ring_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Client socket config: incoming messages/frames capped at
/// [`MAX_INCOMING_FRAME`] (the byte-tunnel contract) — anything larger
/// aborts the read instead of ballooning memory.
fn relay_ws_config() -> Option<WebSocketConfig> {
    Some(
        WebSocketConfig::default()
            .max_message_size(Some(MAX_INCOMING_FRAME))
            .max_frame_size(Some(MAX_INCOMING_FRAME)),
    )
}

async fn ws_connect(url: &str) -> Result<Ws, String> {
    ensure_ring_provider();
    let connect = connect_async_with_config(url, relay_ws_config(), false);
    let (ws, _resp) = tokio::time::timeout(WS_CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| format!("relay connect failed (no handshake within {WS_CONNECT_TIMEOUT:?})"))?
        .map_err(|e| format!("relay connect failed ({e})"))?;
    Ok(ws)
}

/// The keepalive text frame every relay socket pings while idle (a TEXT
/// frame — WS-level pings never reach the worker's Durable Object; the
/// v1 flow tolerated them from day one).
fn keepalive_text() -> tokio_tungstenite::tungstenite::Utf8Bytes {
    json!({ "type": "keepalive" }).to_string().into()
}

/// Spawned 30 s text-ping pumper owning one socket's write half (the read
/// half stays with the caller — split sockets never tear the TCP stream
/// while either half lives). Dropping or shutting the handle makes the task
/// send a best-effort Close and exit.
struct KeepaliveTask {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl KeepaliveTask {
    fn spawn<S>(sink: SplitSink<WebSocketStream<S>, Message>) -> Self
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut sink = sink;
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    _ = tokio::time::sleep(KEEPALIVE_INTERVAL) => {
                        if sink.send(Message::Text(keepalive_text())).await.is_err() {
                            break;
                        }
                    },
                }
            }
            let _ = sink.send(Message::Close(None)).await;
            let _ = sink.flush().await;
        });
        Self { stop, task }
    }

    /// Stop the pumper (it sends Close and exits promptly).
    async fn shutdown(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.task).await;
    }
}

/// Split a connected socket for the keepalive pumper: reads stay with the
/// caller, the pumper holds the write half.
fn park_keepalive(ws: Ws) -> (SplitStream<Ws>, KeepaliveTask) {
    let (sink, stream) = ws.split();
    let ka = KeepaliveTask::spawn(sink);
    (stream, ka)
}

/// Outgoing binary frames are capped at [`MAX_OUTGOING_FRAME`] (the worker
/// rejects larger frames); a larger write is split into consecutive frames —
/// byte-tunnel semantics make the split invisible (frames reassemble on the
/// peer's TCP side).
fn frame_chunks(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.chunks(MAX_OUTGOING_FRAME)
}

async fn send_binary_chunked<S>(ws: &mut S, bytes: &[u8]) -> Result<(), String>
where
    S: futures::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    for chunk in frame_chunks(bytes) {
        ws.send(Message::Binary(chunk.to_vec().into()))
            .await
            .map_err(|e| format!("tunnel send failed ({e})"))?;
    }
    Ok(())
}

/// Control-channel messages (JSON text frames). Both ends of the tunnel
/// agree on exactly these.
#[derive(Debug, Clone, PartialEq)]
enum ControlMsg {
    /// Worker → client: v2 handshake welcome (protocol v1 accepted).
    Welcome,
    /// Worker → client: the host for this room is present.
    Ready,
    /// Worker → client: no host yet, keep waiting.
    Waiting,
    /// Client → worker: please open data conn `id`.
    Open { id: String },
    /// Worker → host: the client wants data conn `id`.
    Conn { id: String },
    /// Host → worker: please allocate a fresh pairing code for this room.
    Allocate,
    /// Worker → host: the freshly allocated pairing code.
    Code { code: String },
    /// Worker → host: code allocation failed (directory error) — the bridge
    /// treats it like a dropped socket and reconnects.
    AllocFailed,
    /// Worker → phone: the room key the resolved code is bound to.
    Room { room: String },
    /// Worker → phone: the code is unknown/expired, or the resolve request
    /// was refused (`reason` — e.g. `rate_limited`).
    ResolveError { reason: Option<String> },
}

impl ControlMsg {
    fn to_text(&self) -> String {
        match self {
            ControlMsg::Welcome => json!({ "type": "welcome" }).to_string(),
            ControlMsg::Ready => json!({ "type": "ready" }).to_string(),
            ControlMsg::Waiting => json!({ "type": "waiting" }).to_string(),
            ControlMsg::Open { id } => json!({ "type": "open", "connId": id }).to_string(),
            ControlMsg::Conn { id } => json!({ "type": "conn", "connId": id }).to_string(),
            ControlMsg::Allocate => json!({ "type": "allocate" }).to_string(),
            ControlMsg::Code { code } => json!({ "type": "code", "code": code }).to_string(),
            ControlMsg::AllocFailed => json!({ "type": "allocFailed" }).to_string(),
            ControlMsg::Room { room } => json!({ "type": "room", "room": room }).to_string(),
            ControlMsg::ResolveError { reason } => match reason {
                Some(r) => json!({ "type": "err", "reason": r }).to_string(),
                None => json!({ "type": "err" }).to_string(),
            },
        }
    }

    fn parse(text: &str) -> Option<ControlMsg> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        match v.get("type")?.as_str()? {
            "welcome" => Some(ControlMsg::Welcome),
            "ready" => Some(ControlMsg::Ready),
            "waiting" => Some(ControlMsg::Waiting),
            "open" => Some(ControlMsg::Open {
                id: v.get("connId")?.as_str()?.to_string(),
            }),
            "conn" => Some(ControlMsg::Conn {
                id: v.get("connId")?.as_str()?.to_string(),
            }),
            "allocate" => Some(ControlMsg::Allocate),
            "code" => Some(ControlMsg::Code {
                code: v.get("code")?.as_str()?.to_string(),
            }),
            "allocFailed" => Some(ControlMsg::AllocFailed),
            "room" => Some(ControlMsg::Room {
                room: v.get("room")?.as_str()?.to_string(),
            }),
            "err" => Some(ControlMsg::ResolveError {
                reason: v.get("reason").and_then(|r| r.as_str()).map(str::to_string),
            }),
            _ => None,
        }
    }
}

/// Pull the next TEXT control message (binary frames and pings are skipped).
async fn next_control<S>(ws: &mut WebSocketStream<S>) -> Result<ControlMsg, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                if let Some(m) = ControlMsg::parse(&t) {
                    return Ok(m);
                }
            },
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(f))) => {
                return Err(format!(
                    "relay control closed ({})",
                    f.as_ref().map(|f| f.code.to_string()).unwrap_or_default()
                ));
            },
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("relay control read failed ({e})")),
            None => return Err("relay control closed".to_string()),
        }
    }
}

/// Outcome of the v2 socket handshake (hello → welcome).
enum HelloOutcome {
    /// The server welcomed us under protocol v1.
    Welcome,
    /// The server skipped the welcome and went straight into the legacy v1
    /// flow — this is the FIRST control message of it (the caller processes
    /// it as if it had just been read).
    First(ControlMsg),
    /// Nothing arrived within [`HELLO_TIMEOUT`] — a legacy v1 server that
    /// ignores unknown text frames; proceed with the v1 flow.
    Silent,
}

/// Perform the v2 handshake on a freshly-opened control/resolve socket:
/// send `hello` (protocol v1, persistent hostId) and await the welcome with
/// legacy tolerance (see [`HelloOutcome`]). NOT used on data sockets —
/// those are byte tunnels.
async fn hello_handshake(ws: &mut Ws) -> Result<HelloOutcome, String> {
    let hello =
        json!({ "type": "hello", "protocol": "v1", "hostId": persistent_host_id() }).to_string();
    ws.send(Message::Text(hello.into()))
        .await
        .map_err(|e| format!("relay hello failed ({e})"))?;
    match tokio::time::timeout(HELLO_TIMEOUT, next_control(ws)).await {
        Ok(Ok(ControlMsg::Welcome)) => Ok(HelloOutcome::Welcome),
        Ok(Ok(other)) => Ok(HelloOutcome::First(other)),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(HelloOutcome::Silent),
    }
}

// ── HTTP-over-tunnel framing ────────────────────────────────────────────────

/// Parsed response head (the request side mirrors the LAN server's
/// `parse_head`).
#[derive(Debug)]
struct ResponseHead {
    status: u16,
    /// Lowercased header name → value.
    headers: Vec<(String, String)>,
}

impl ResponseHead {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn content_length(&self) -> Option<u64> {
        self.header("content-length")?.parse().ok()
    }
}

/// Parse `HTTP/1.1 200 OK\r\n…\r\n\r\n` from the front of `buf`; returns the
/// head and the byte offset just past the blank line.
fn parse_response_head(buf: &[u8]) -> Result<(ResponseHead, usize), String> {
    let text = std::str::from_utf8(buf).map_err(|_| "non-UTF-8 response head".to_string())?;
    let (head, _rest) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "truncated response head".to_string())?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or("empty response")?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed status line: {status_line}"))?;
    if !version.starts_with("HTTP/") {
        return Err(format!("malformed status line: {status_line}"));
    }
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Ok((ResponseHead { status, headers }, head.len() + 4))
}

/// A tunnel response in progress: the data socket's read half plus buffered
/// bytes past the head. The keepalive pumper holds the write half (30 s
/// text pings while the response streams). `remaining` follows
/// Content-Length; `None` (no header — never happens with our server, but a
/// proxy could strip it) means read-until-close.
struct TunnelBody {
    stream: SplitStream<Ws>,
    ka: KeepaliveTask,
    pending: Vec<u8>,
    remaining: Option<u64>,
    closed: bool,
}

impl TunnelBody {
    /// Next body chunk, or None at the end of the response. Chunks arrive
    /// already sized by Content-Length accounting.
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        loop {
            if self.remaining == Some(0) {
                return Ok(None);
            }
            if !self.pending.is_empty() {
                let take = match self.remaining {
                    Some(r) => self.pending.len().min(r as usize),
                    None => self.pending.len(),
                };
                let chunk: Vec<u8> = self.pending.drain(..take).collect();
                if let Some(r) = self.remaining.as_mut() {
                    *r -= take as u64;
                }
                return Ok(Some(chunk));
            }
            if self.closed {
                return if self.remaining == Some(0) || self.remaining.is_none() {
                    Ok(None)
                } else {
                    Err("tunnel closed mid-response".to_string())
                };
            }
            match self.stream.next().await {
                Some(Ok(Message::Binary(b))) => self.pending.extend_from_slice(&b),
                Some(Ok(Message::Text(_))) => {
                    // The peer's 30 s keepalive ping rides the same socket —
                    // expected, skipped.
                },
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => {
                    self.closed = true;
                },
                Some(Err(e)) => return Err(format!("tunnel read failed ({e})")),
                Some(Ok(Message::Frame(_))) => {},
            }
        }
    }

    /// Read the WHOLE body (bounded — /pair and /api/replays only).
    async fn read_all(mut self, cap: usize) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        while let Some(chunk) = self.next_chunk().await? {
            out.extend_from_slice(&chunk);
            if out.len() > cap {
                return Err("relay response too large".to_string());
            }
        }
        Ok(out)
    }

    /// Best-effort close (stop the keepalive pumper, which sends the Close
    /// frame; the read half drops with it).
    async fn close(self) {
        self.ka.shutdown().await;
    }
}

/// Send raw HTTP request bytes on a freshly-opened data socket (chunked to
/// the frame cap), park the keepalive pumper, and parse the response head
/// off the reply.
async fn tunnel_round_trip(
    mut data: Ws,
    request: &[u8],
    head_timeout: Duration,
) -> Result<(ResponseHead, TunnelBody), String> {
    send_binary_chunked(&mut data, request).await?;
    let (mut stream, ka) = park_keepalive(data);
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let head = tokio::time::timeout(head_timeout, async {
        loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                return parse_response_head(&buf[..pos + 4]).map(|(h, _)| (h, pos + 4));
            }
            if buf.len() > MAX_REQUEST_HEAD {
                return Err("relay response head too large".to_string());
            }
            match stream.next().await {
                Some(Ok(Message::Binary(b))) => buf.extend_from_slice(&b),
                Some(Ok(Message::Text(_))) => {},
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => {
                    return Err("tunnel closed before a response".to_string());
                },
                Some(Err(e)) => return Err(format!("tunnel read failed ({e})")),
                Some(Ok(_)) => {},
            }
        }
    })
    .await
    .map_err(|_| "no response within the tunnel deadline".to_string())??;
    let (head, consumed) = head;
    let body = TunnelBody {
        stream,
        ka,
        pending: buf[consumed..].to_vec(),
        remaining: head.content_length(),
        closed: false,
    };
    Ok((head, body))
}

/// A relay socket parked after its v1 handshake: the keepalive pumper owns
/// the write half, the read half is retained UNPOLLED — dropping it early
/// would tear the TCP stream down and with it the room.
struct ParkedControl {
    #[allow(dead_code)] // held alive on purpose — see the struct doc
    reader: SplitStream<Ws>,
    ka: KeepaliveTask,
}

impl ParkedControl {
    /// Politely close (stop the pumper, which sends the Close frame).
    async fn close(self) {
        self.ka.shutdown().await;
    }
}

/// One paired control+data tunnel. The data socket is handed to
/// [`tunnel_round_trip`] (which sends the request and streams the
/// response); the control socket stays parked — one keepalive frame per
/// 30 s keeps the room "live" while the request runs.
struct Tunnel {
    data: Ws,
    control: ParkedControl,
}

/// Open a tunnel to `room`: control channel as client (hello/welcome with
/// legacy tolerance, waiting for the host if needed), then `{type:"open"}`,
/// then the data socket.
async fn open_tunnel(ws_base: &str, room: &str) -> Result<Tunnel, String> {
    if !valid_room(room) {
        return Err("invalid relay room key".to_string());
    }
    let mut control = ws_connect(&control_url(ws_base, room, "client")).await?;
    let mut first: Option<ControlMsg> = None;
    match hello_handshake(&mut control).await {
        Ok(HelloOutcome::Welcome) | Ok(HelloOutcome::Silent) => {},
        Ok(HelloOutcome::First(m)) => first = Some(m),
        Err(e) => return Err(format!("relay handshake failed ({e})")),
    }
    // Wait for the host (bounded): the bridge reconnects within seconds, so
    // "waiting" for longer than READY_TIMEOUT means it is not coming.
    let ready = async {
        if let Some(m) = first {
            if matches!(m, ControlMsg::Ready) {
                return Ok::<(), String>(());
            }
        }
        loop {
            match next_control(&mut control).await? {
                ControlMsg::Ready => return Ok(()),
                _ => continue,
            }
        }
    };
    tokio::time::timeout(READY_TIMEOUT, ready)
        .await
        .map_err(|_| "relay host never became ready".to_string())??;

    let conn = conn_id()?;
    control
        .send(Message::Text(
            ControlMsg::Open { id: conn.clone() }.to_text().into(),
        ))
        .await
        .map_err(|e| format!("relay open failed ({e})"))?;
    let data = ws_connect(&data_url(ws_base, room, &conn, "client")).await?;
    let (reader, ka) = park_keepalive(control);
    Ok(Tunnel {
        data,
        control: ParkedControl { reader, ka },
    })
}

/// Build one tunnel request (Connection: close — the LAN protocol's shape).
fn tunnel_request(method: &str, path: &str, token: Option<&str>, body: Option<&[u8]>) -> Vec<u8> {
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: relay\r\n");
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(b) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("Connection: close\r\n\r\n");
    let mut bytes = req.into_bytes();
    if let Some(b) = body {
        bytes.extend_from_slice(b);
    }
    bytes
}

// ── client operations (all targets) — one per pairing route ─────────────────

/// Resolve a 6-digit pairing code to its room key via the gateway's
/// `/resolve` handshake (WS answered with a single `{"type":"room"}` frame;
/// the v2 hello/welcome runs first with legacy tolerance).
async fn resolve_room(ws_base: &str, code: &str) -> Result<String, String> {
    if !valid_code(code) {
        return Err(GATEWAY_UNREACHABLE.to_string());
    }
    let mut ws = ws_connect(&format!("{ws_base}/resolve?code={code}"))
        .await
        .map_err(|e| format!("resolve failed: {e}"))?;
    let mut first: Option<ControlMsg> = None;
    match hello_handshake(&mut ws).await {
        Ok(HelloOutcome::Welcome) | Ok(HelloOutcome::Silent) => {},
        Ok(HelloOutcome::First(m)) => first = Some(m),
        Err(e) => return Err(format!("resolve failed: {e}")),
    }
    let msg = match first {
        Some(m) => m,
        None => tokio::time::timeout(RESOLVE_TIMEOUT, next_control(&mut ws))
            .await
            .map_err(|_| "resolve timed out".to_string())??,
    };
    let _ = ws.close(None).await;
    match msg {
        ControlMsg::Room { room } => {
            if !valid_room(&room) {
                return Err("gateway resolved a malformed room key".to_string());
            }
            Ok(room)
        },
        ControlMsg::ResolveError { reason } => {
            if reason
                .as_deref()
                .is_some_and(|r| r.eq_ignore_ascii_case("rate_limited"))
            {
                Err(GATEWAY_RATE_LIMITED.to_string())
            } else {
                // Unknown/expired code — same friendly state as an offline
                // gateway.
                Err(GATEWAY_UNREACHABLE.to_string())
            }
        },
        other => Err(format!("unexpected resolve reply ({other:?})")),
    }
}

/// Map connection-phase failures onto the stable "gateway unreachable"
/// marker the frontend turns into a friendly retry state. Post-connection
/// errors (PIN rejected, host gone, timeouts) pass through untouched — and
/// so do the DISTINCT v2 resolution errors (unsupported protocol, rate
/// limited), which must never collapse into "unreachable".
fn gateway_error(err: String) -> String {
    if err.contains("relay connect failed") || err.contains("resolve failed") {
        GATEWAY_UNREACHABLE.to_string()
    } else {
        err
    }
}

/// Pair through the gateway: resolve the 6-digit code the phone entered to
/// its room, then POST /pair through the tunnel. The code doubles as the
/// pin (the desktop accepts it exactly like its local PIN); the resolved
/// room key rides back in the result so the session's later tunnels are
/// addressed without asking the gateway again. `gateway` is the ROOT the
/// session resolves (any spelling — https/wss/http/ws host[:port]).
pub async fn relay_pair(gateway: &str, code: &str) -> Result<PairingToken, String> {
    let code = code.trim();
    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let room = resolve_room(&ws_base, code).await.map_err(gateway_error)?;
    let tunnel = open_tunnel(&ws_base, &room).await.map_err(gateway_error)?;
    let body = json!({ "pin": code }).to_string();
    let req = tunnel_request("POST", "/pair", None, Some(body.as_bytes()));
    let (head, resp) = tunnel_round_trip(tunnel.data, &req, PAIR_TIMEOUT).await?;
    let status = head.status;
    if status != 200 {
        resp.close().await;
        tunnel.control.close().await;
        return Err(http_error_status(status));
    }
    let bytes = resp.read_all(MAX_RESPONSE_BODY).await?;
    tunnel.control.close().await;
    let mut token: PairingToken =
        serde_json::from_slice(&bytes).map_err(|e| format!("pairing response parse: {e}"))?;
    // The room key the session's later tunnels are addressed by.
    token.room = Some(room);
    Ok(token)
}

/// GET /api/replays through the tunnel.
pub async fn relay_list_remote(
    gateway: &str,
    room: &str,
    token: &str,
) -> Result<Vec<ReplayMetaLite>, String> {
    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let tunnel = open_tunnel(&ws_base, room).await?;
    let req = tunnel_request("GET", "/api/replays", Some(token), None);
    let (head, resp) = tunnel_round_trip(tunnel.data, &req, LIST_TIMEOUT).await?;
    let status = head.status;
    if status != 200 {
        resp.close().await;
        tunnel.control.close().await;
        return Err(http_error_status(status));
    }
    let bytes = resp.read_all(MAX_RESPONSE_BODY).await?;
    tunnel.control.close().await;
    serde_json::from_slice(&bytes).map_err(|e| format!("replay list parse: {e}"))
}

/// Local progress emit that tolerates "no AppHandle" (unit tests). Real
/// callers always pass Some.
fn emit_opt(app: Option<&tauri::AppHandle>, progress: &PairingProgress) {
    if let Some(app) = app {
        emit_progress(app, progress);
    }
}

/// GET /api/replay/<name> through the tunnel, streamed to `dest` with the
/// same throttled progress events as the LAN pull.
pub(crate) async fn relay_pull_replay(
    app: Option<&tauri::AppHandle>,
    gateway: &str,
    room: &str,
    token: &str,
    remote_name: &str,
    dest: &std::path::Path,
) -> Result<u64, String> {
    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let tunnel = open_tunnel(&ws_base, room).await?;
    let path = format!(
        "/api/replay/{}",
        super::pairing::encode_path_segment(remote_name)
    );
    let req = tunnel_request("GET", &path, Some(token), None);
    let (head, mut body) = tunnel_round_trip(tunnel.data, &req, LIST_TIMEOUT).await?;
    let status = head.status;
    if status != 200 {
        body.close().await;
        tunnel.control.close().await;
        return Err(http_error_status(status));
    }
    let total = head.content_length().unwrap_or(0);
    use tokio::io::AsyncWriteExt as _;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    let mut last_emit = std::time::Instant::now();
    let result: Result<u64, String> = loop {
        match body.next_chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    break Err(format!("write {}: {e}", dest.display()));
                }
                received += chunk.len() as u64;
                since_emit += chunk.len() as u64;
                if since_emit >= 262_144
                    || (since_emit > 0 && last_emit.elapsed() >= Duration::from_millis(100))
                {
                    since_emit = 0;
                    last_emit = std::time::Instant::now();
                    emit_opt(
                        app,
                        &PairingProgress {
                            remote_name: remote_name.to_string(),
                            phase: "download".into(),
                            received,
                            total,
                            error: None,
                        },
                    );
                }
            },
            Ok(None) => break Ok(received),
            Err(e) => break Err(e),
        }
    };
    if result.is_ok() {
        let _ = file.flush().await;
        body.close().await;
        tunnel.control.close().await;
    }
    result
}

/// GET /api/gamedata through the tunnel — including the LAN client's
/// 503 + Retry-After patience loop — streamed into `dest` with progress
/// events under the `:gamedata:` sentinel.
pub(crate) async fn relay_pull_gamedata(
    app: Option<&tauri::AppHandle>,
    gateway: &str,
    room: &str,
    token: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    const GAMEDATA_PREPARE_BUDGET: Duration = Duration::from_secs(120);
    const RETRY_FALLBACK_SECS: u64 = 2;

    let ws_base = resolve_gateway_cached(gateway).await?.ws_base;
    let started = std::time::Instant::now();
    let (head, mut body) = loop {
        let tunnel = open_tunnel(&ws_base, room).await?;
        let req = tunnel_request("GET", "/api/gamedata", Some(token), None);
        let (head, body) = tunnel_round_trip(tunnel.data, &req, LIST_TIMEOUT).await?;
        tunnel.control.close().await;
        if head.status == 503 && started.elapsed() < GAMEDATA_PREPARE_BUDGET {
            let nap = head
                .header("retry-after")
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|s| (1..=10).contains(s))
                .unwrap_or(RETRY_FALLBACK_SECS);
            tracing::info!(nap_secs = nap, "relay host still building gamedata zip");
            body.close().await;
            tokio::time::sleep(Duration::from_secs(nap)).await;
            continue;
        }
        break (head, body);
    };
    let status = head.status;
    if status == 404 {
        return Err("no game data available on the host".to_string());
    }
    if status != 200 {
        body.close().await;
        return Err(http_error_status(status));
    }
    let total = head.content_length().unwrap_or(0);
    use tokio::io::AsyncWriteExt as _;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    let mut last_emit = std::time::Instant::now();
    let result: Result<(), String> = loop {
        match body.next_chunk().await {
            Ok(Some(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    break Err(format!("write {}: {e}", dest.display()));
                }
                received += chunk.len() as u64;
                since_emit += chunk.len() as u64;
                if since_emit >= 262_144
                    || (since_emit > 0 && last_emit.elapsed() >= Duration::from_millis(100))
                {
                    since_emit = 0;
                    last_emit = std::time::Instant::now();
                    emit_opt(
                        app,
                        &PairingProgress {
                            remote_name: GAMEDATA_SENTINEL.to_string(),
                            phase: "download".into(),
                            received,
                            total,
                            error: None,
                        },
                    );
                }
            },
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    if result.is_ok() {
        let _ = file.flush().await;
        body.close().await;
    }
    result
}

/// Status → the SAME clean strings the LAN client maps (the frontend toasts
/// these verbatim), plus the raw code for anything unanticipated.
fn http_error_status(status: u16) -> String {
    match status {
        400 | 401 | 403 | 404 | 429 | 503 => http_error(
            reqwest::StatusCode::from_u16(status)
                .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
        ),
        _ => format!("HTTP {status}"),
    }
}

// ── config commands (all targets) ────────────────────────────────────────────

pub const RELAY_CONFIG_FILE: &str = "pairing-relay-config.json";

pub fn load_relay_config() -> RelayConfig {
    let Ok(dir) = crate::paths::ensure_data_dir() else {
        return RelayConfig::default();
    };
    std::fs::read_to_string(dir.join(RELAY_CONFIG_FILE))
        .ok()
        .and_then(|r| serde_json::from_str::<RelayConfig>(&r).ok())
        .unwrap_or_default()
}

fn save_relay_config(config: &RelayConfig) -> Result<(), String> {
    let dir = crate::paths::ensure_data_dir()?;
    let path = dir.join(RELAY_CONFIG_FILE);
    let tmp = dir.join(format!("{RELAY_CONFIG_FILE}.tmp"));
    let json = serde_json::to_string(config).map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&tmp, json).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))?;
    Ok(())
}

/// Current relay configuration (hidden setting — no UI field; the toggle
/// exists for support/diagnostics and the tests). Enabled by default.
#[tauri::command]
pub fn pairing_get_relay_config() -> RelayConfig {
    load_relay_config()
}

/// Persist the relay toggle (enabled only — the endpoint is the built-in
/// gateway, not user-configured). On the desktop a running pairing server's
/// bridge is restarted live so the change applies at once.
#[tauri::command]
pub async fn pairing_set_relay(config: RelayConfig) -> Result<(), String> {
    save_relay_config(&config)?;
    #[cfg(desktop)]
    restart_bridge_for_config(&config).await;
    Ok(())
}

#[cfg(desktop)]
async fn restart_bridge_for_config(config: &RelayConfig) {
    host_session_stop().await;
    if !config.enabled {
        return;
    }
    if let Some((port, room)) = super::pairing::server::server_snapshot().await {
        if let Err(e) = host_session_start(&builtin_relay_root(), port, &room).await {
            tracing::warn!(error = %e, "relay host session failed to start");
        }
    }
}

// ── live pairing-code state (desktop) ────────────────────────────────────────

/// The gateway-allocated pairing code for the CURRENT host session, shared
/// between the bridge task (writer) and the pairing server (status display +
/// extra /pair secret). `None` = the gateway has not answered (yet) — the
/// desktop is in LAN-only fallback.
fn code_watch() -> &'static tokio::sync::watch::Sender<Option<String>> {
    static TX: OnceLock<tokio::sync::watch::Sender<Option<String>>> = OnceLock::new();
    TX.get_or_init(|| tokio::sync::watch::channel(None).0)
}

/// The pairing code the desktop currently displays (gateway-allocated), or
/// None while the gateway has not answered — pairing.rs falls back to its
/// locally-generated LAN PIN then.
pub fn current_relay_code() -> Option<String> {
    code_watch().subscribe().borrow().clone()
}

/// Whether the gateway is online for the current session (a code is live).
/// Tests read it directly; production callers read the code via
/// [`current_relay_code`] (None == offline, the LAN-only fallback).
#[cfg_attr(not(test), allow(dead_code))]
pub fn relay_online() -> bool {
    current_relay_code().is_some()
}

fn store_code(code: Option<String>) {
    code_watch().send_if_modified(|current| {
        if *current != code {
            *current = code;
            true
        } else {
            false
        }
    });
}

/// Resolve when the watch holds a code DIFFERENT from `prev` (allocation is
/// always fresh — the directory guarantees uniqueness among live codes), or
/// time out. Used both for the first allocation at server start and for the
/// regenerate button.
async fn wait_for_new_code(prev: Option<&str>, timeout: Duration) -> Result<String, String> {
    let mut rx = code_watch().subscribe();
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let current = rx.borrow().clone();
        if let Some(code) = current {
            if Some(code.as_str()) != prev {
                return Ok(code);
            }
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err("pairing code allocation timed out".to_string());
        }
        if tokio::time::timeout(deadline - now, rx.changed())
            .await
            .is_err()
        {
            return Err("pairing code allocation timed out".to_string());
        }
    }
}

/// Bounded wait for the FIRST allocation of a fresh session.
pub async fn wait_for_code(timeout: Duration) -> Result<String, String> {
    wait_for_new_code(None, timeout).await
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_urls_normalize_to_ws() {
        assert_eq!(
            normalize_relay_ws_url("https://wowsp-pairing.example.workers.dev").unwrap(),
            "wss://wowsp-pairing.example.workers.dev"
        );
        assert_eq!(
            normalize_relay_ws_url("https://wowsp-pairing.example.workers.dev/").unwrap(),
            "wss://wowsp-pairing.example.workers.dev"
        );
        assert_eq!(
            normalize_relay_ws_url("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787"
        );
        // Bare host gets wss.
        assert_eq!(
            normalize_relay_ws_url("  pair.example.org ").unwrap(),
            "wss://pair.example.org"
        );
        // Already-ws URLs pass through.
        assert_eq!(
            normalize_relay_ws_url("ws://127.0.0.1:9000").unwrap(),
            "ws://127.0.0.1:9000"
        );
        // Junk is refused.
        assert!(normalize_relay_ws_url("").is_err());
        assert!(normalize_relay_ws_url("   ").is_err());
        assert!(normalize_relay_ws_url("ftp://x.example").is_err());
    }

    #[test]
    fn relay_roots_normalize_across_schemes() {
        // Every gateway spelling folds onto the http(s) manifest root.
        assert_eq!(
            normalize_relay_root("wss://wowsp.langyo.xyz").unwrap(),
            "https://wowsp.langyo.xyz"
        );
        assert_eq!(
            normalize_relay_root("https://wowsp.langyo.xyz/").unwrap(),
            "https://wowsp.langyo.xyz"
        );
        assert_eq!(
            normalize_relay_root("ws://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_relay_root("http://127.0.0.1:8787/dev").unwrap(),
            "http://127.0.0.1:8787/dev"
        );
        // Bare host gets https (production gateways are always TLS).
        assert_eq!(
            normalize_relay_root(" gateway.example.org ").unwrap(),
            "https://gateway.example.org"
        );
        // Scheme case is irrelevant; the rest is kept verbatim.
        assert_eq!(
            normalize_relay_root("WSS://gw.example.org/Path").unwrap(),
            "https://gw.example.org/Path"
        );
        // Junk is refused.
        assert!(normalize_relay_root("").is_err());
        assert!(normalize_relay_root("ftp://x.example").is_err());
        assert!(normalize_relay_root("https://").is_err());
    }

    #[test]
    fn builtin_gateway_is_the_hardcoded_root_with_dev_override() {
        // No override → the ONE built-in constant.
        assert_eq!(builtin_relay_root_from(None), "https://wowsp.langyo.xyz");
        // Blank/whitespace override → still the built-in root.
        assert_eq!(
            builtin_relay_root_from(Some("")),
            "https://wowsp.langyo.xyz"
        );
        assert_eq!(
            builtin_relay_root_from(Some("   ")),
            "https://wowsp.langyo.xyz"
        );
        // A usable override wins (development against `wrangler dev`) in
        // any spelling.
        assert_eq!(
            builtin_relay_root_from(Some("ws://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            builtin_relay_root_from(Some("http://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
        // A junk override falls back to the built-in root instead of
        // breaking pairing.
        assert_eq!(
            builtin_relay_root_from(Some("ftp://nope")),
            "https://wowsp.langyo.xyz"
        );
    }

    #[test]
    fn manifest_relay_endpoints_resolve_against_the_root() {
        // Path form: the root's host + the manifest path (any root path
        // prefix is REPLACED).
        assert_eq!(
            resolve_relay_endpoint("https://gw.example.org", "/v2/relay-ws").unwrap(),
            "wss://gw.example.org/v2/relay-ws"
        );
        assert_eq!(
            resolve_relay_endpoint("http://127.0.0.1:8787/routed", "/relay-ws").unwrap(),
            "ws://127.0.0.1:8787/relay-ws"
        );
        // Absolute form: used as-is; only ws/wss are the tunnel protocol.
        assert_eq!(
            resolve_relay_endpoint("https://gw.example.org", "wss://other.example.org/x").unwrap(),
            "wss://other.example.org/x"
        );
        assert_eq!(
            resolve_relay_endpoint("https://gw.example.org", "ws://127.0.0.1:9000").unwrap(),
            "ws://127.0.0.1:9000"
        );
        // Missing / non-ws / relative endpoints are refused.
        assert!(resolve_relay_endpoint("https://gw.example.org", "").is_err());
        assert!(resolve_relay_endpoint("https://gw.example.org", "https://x.example").is_err());
        assert!(resolve_relay_endpoint("https://gw.example.org", "relay-ws").is_err());
    }

    #[test]
    fn manifests_parse_leniently_and_gate_on_gateway_shape() {
        let m: GatewayManifest = serde_json::from_str(
            r#"{"provider":"wowsp","name":"gw","protocol":["v1"],
                "endpoints":{"relay":"/relay-ws"},"upstream":null,
                "features":["allocate"],"notice":"hi"}"#,
        )
        .unwrap();
        assert!(is_gateway_manifest(&m));
        assert_eq!(m.provider, "wowsp");
        assert_eq!(m.endpoints.relay, "/relay-ws");
        assert!(m.notice.is_some());

        // Forwarder manifests carry upstream and may omit the endpoint.
        let fwd: GatewayManifest = serde_json::from_str(
            r#"{"provider":"a","name":"fwd","protocol":["v1"],"upstream":"https://b.example"}"#,
        )
        .unwrap();
        assert_eq!(fwd.upstream.as_deref(), Some("https://b.example"));

        // A foreign JSON body parses (all defaults) but is NOT a manifest —
        // resolution must treat it like a 404, not an unsupported protocol.
        let foreign: GatewayManifest = serde_json::from_str(r#"{"captive":"portal"}"#).unwrap();
        assert!(!is_gateway_manifest(&foreign));
        // Garbage fails to parse at all.
        assert!(serde_json::from_str::<GatewayManifest>("<html>").is_err());
    }

    #[test]
    fn manifest_lenient_parse_survives_nulls_but_not_wrong_types() {
        // Explicit nulls on the OPTIONAL (Option-typed) fields are the
        // documented shape; `#[serde(default)]` covers missing fields,
        // but a null against Vec<String> is a wrong type, not a default.
        let m: GatewayManifest = serde_json::from_str(
            r#"{"provider":"wowsp","protocol":["v1"],
                "endpoints":{"relay":"/relay-ws"},
                "upstream":null,"notice":null}"#,
        )
        .unwrap();
        assert!(is_gateway_manifest(&m));
        assert_eq!(m.upstream, None);
        assert_eq!(m.notice, None);
        // A missing `endpoints` object defaults to empty; the protocol
        // list still marks it as a gateway, and the endpoint resolution
        // (tested below) degrades it to legacy direct mode.
        let no_eps: GatewayManifest = serde_json::from_str(r#"{"protocol":["v1"]}"#).unwrap();
        assert!(is_gateway_manifest(&no_eps));
        assert_eq!(no_eps.endpoints.relay, "");
        // Quirk, documented: an ARRAY for `endpoints` parses too (serde's
        // seq-form struct with all-defaulted fields) into an empty relay —
        // the same safe degradation as a missing endpoint, not a foreign
        // body, because the protocol list still marks the doc gateway-ish.
        let arr_eps: GatewayManifest =
            serde_json::from_str(r#"{"protocol":["v1"],"endpoints":[]}"#).unwrap();
        assert!(is_gateway_manifest(&arr_eps));
        assert_eq!(arr_eps.endpoints.relay, "");
        // Same idea for a whole-doc array: with the bool `ok` leading the
        // struct it no longer parses at all (seq-form would need a bool
        // first) — the fetch wrapper treats that as "no manifest"
        // (foreign body → legacy direct mode), the same safe outcome.
        assert!(serde_json::from_str::<GatewayManifest>(r#"["v1"]"#).is_err());

        // WRONG TYPES on any field fail the whole parse — the fetch
        // wrapper then treats the body as "no manifest" (legacy direct
        // mode), never as a usable-but-garbled gateway.
        for bad in [
            r#"{"protocol":["v1"],"provider":42}"#, // number for a string
            r#"{"protocol":"v1"}"#,                 // scalar for the array
            r#"{"protocol":["v1"],"features":null}"#, // null for a Vec field
            r#"{"protocol":["v1"],"endpoints":{"relay":7}}"#, // number for the path
            r#"{"protocol":["v1"],"upstream":true}"#, // bool for Option<String>
            r#"{"protocol":["v1"],"name":["x"]}"#,  // array for a string
        ] {
            assert!(
                serde_json::from_str::<GatewayManifest>(bad).is_err(),
                "wrong-typed manifest {bad} must not parse"
            );
        }
    }

    #[test]
    fn finish_resolution_degrades_gracefully_on_a_bad_endpoint() {
        // A manifest that speaks v1 but carries no usable relay endpoint
        // falls back to LEGACY DIRECT MODE at the same root — never an
        // error, never the unsupported-protocol one.
        let no_endpoint: GatewayManifest =
            serde_json::from_str(r#"{"protocol":["v1"],"endpoints":{"relay":""}}"#).unwrap();
        let res = finish_resolution("https://gw.example.org", no_endpoint, false).unwrap();
        assert!(
            res.manifest.is_none(),
            "degraded resolutions carry no manifest"
        );
        assert_eq!(res.ws_base, "wss://gw.example.org/api/relay");
        assert!(!res.via_upstream);

        // And a manifest without v1 keeps the DISTINCT error.
        let v3: GatewayManifest =
            serde_json::from_str(r#"{"protocol":["v3"],"endpoints":{"relay":"/r"}}"#).unwrap();
        assert_eq!(
            finish_resolution("https://gw.example.org", v3, false).unwrap_err(),
            UNSUPPORTED_PROTOCOL
        );
    }

    #[test]
    fn room_validation_enforces_the_worker_shape() {
        // 64 lowercase hex = the random room ids the desktop mints.
        assert!(valid_room(
            &crate::commands::pairing::server::random_token().unwrap()
        ));
        assert!(!valid_room("deadbeef"));
        assert!(!valid_room("123456"));
    }

    #[test]
    fn pairing_codes_must_be_six_digits() {
        assert!(valid_code("000000"));
        assert!(valid_code("123456"));
        assert!(!valid_code("12345"));
        assert!(!valid_code("1234567"));
        assert!(!valid_code("12a456"));
        assert!(!valid_code(""));
    }

    #[test]
    fn host_ids_are_32_hex_and_persisted() {
        let tmp = super::super::pairing::tests::tempfile_dir();
        let a = host_id_in(&tmp);
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        // Stable across calls (persisted in pairing-host-id.txt).
        assert_eq!(host_id_in(&tmp), a);
        assert!(tmp.join(HOST_ID_FILE).exists());
        // Junk on disk is replaced, not trusted.
        std::fs::write(tmp.join(HOST_ID_FILE), "not-an-id").unwrap();
        let b = host_id_in(&tmp);
        assert_eq!(b.len(), 32);
        assert_ne!(b, "not-an-id");
        // Case-normalized valid ids are reused.
        std::fs::write(tmp.join(HOST_ID_FILE), a.to_ascii_uppercase()).unwrap();
        assert_eq!(host_id_in(&tmp), a);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn frame_chunks_never_exceed_the_tunnel_cap() {
        assert_eq!(frame_chunks(&[]).count(), 0);
        let small = vec![7u8; 1_000];
        let chunks: Vec<&[u8]> = frame_chunks(&small).collect();
        assert_eq!(chunks.len(), 1);
        let big = vec![9u8; MAX_OUTGOING_FRAME * 2 + 5];
        let chunks: Vec<&[u8]> = frame_chunks(&big).collect();
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|c| c.len() <= MAX_OUTGOING_FRAME));
        // Chunking is lossless.
        assert_eq!(chunks.concat(), big);
    }

    #[test]
    fn control_messages_round_trip() {
        for m in [
            ControlMsg::Welcome,
            ControlMsg::Ready,
            ControlMsg::Waiting,
            ControlMsg::Open {
                id: "abc123".into(),
            },
            ControlMsg::Conn {
                id: "def456".into(),
            },
            ControlMsg::Allocate,
            ControlMsg::Code {
                code: "012345".into(),
            },
            ControlMsg::AllocFailed,
            ControlMsg::Room {
                room: "a".repeat(64).into(),
            },
            ControlMsg::ResolveError { reason: None },
            ControlMsg::ResolveError {
                reason: Some("rate_limited".into()),
            },
        ] {
            assert_eq!(ControlMsg::parse(&m.to_text()), Some(m));
        }
        assert_eq!(ControlMsg::parse("junk"), None);
        assert_eq!(ControlMsg::parse(r#"{"type":"nope"}"#), None);
    }

    #[test]
    fn response_heads_parse_with_glued_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"token\":\"x\"";
        let (head, consumed) = parse_response_head(raw).unwrap();
        assert_eq!(head.status, 200);
        assert_eq!(head.header("content-length"), Some("12"));
        assert_eq!(head.header("connection"), Some("close"));
        assert_eq!(consumed, raw.len() - b"{\"token\":\"x\"".len());
        assert!(head.content_length() == Some(12));

        // Truncated head is an error, not a panic.
        assert!(parse_response_head(b"HTTP/1.1 200 OK\r\nConn").is_err());
        assert!(parse_response_head(b"garbage\r\n\r\n").is_err());
    }

    #[test]
    fn tunnel_requests_carry_auth_and_body() {
        let req = tunnel_request("POST", "/pair", None, Some(br#"{"pin":"123456"}"#));
        let text = String::from_utf8(req).unwrap();
        assert!(text.starts_with("POST /pair HTTP/1.1\r\n"));
        assert!(text.contains("Content-Type: application/json\r\n"));
        assert!(text.contains("Content-Length: 16\r\n"));
        assert!(text.ends_with("\r\n\r\n{\"pin\":\"123456\"}"));

        let req = tunnel_request("GET", "/api/replays", Some("tok"), None);
        let text = String::from_utf8(req).unwrap();
        assert!(text.contains("Authorization: Bearer tok\r\n"));
        assert!(text.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn conn_ids_are_random_hex() {
        let a = conn_id().unwrap();
        let b = conn_id().unwrap();
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn connection_failures_map_to_the_gateway_marker() {
        assert_eq!(
            gateway_error("relay connect failed (boom)".into()),
            GATEWAY_UNREACHABLE
        );
        assert_eq!(
            gateway_error("resolve failed: relay connect failed (x)".into()),
            GATEWAY_UNREACHABLE
        );
        // Everything else passes through untouched.
        assert_eq!(gateway_error("invalid PIN".into()), "invalid PIN");
        assert_eq!(
            gateway_error("relay host never became ready".into()),
            "relay host never became ready"
        );
        // The DISTINCT v2 errors never collapse into "unreachable".
        assert_eq!(
            gateway_error(UNSUPPORTED_PROTOCOL.to_string()),
            UNSUPPORTED_PROTOCOL
        );
        assert_eq!(
            gateway_error(GATEWAY_RATE_LIMITED.to_string()),
            GATEWAY_RATE_LIMITED
        );
    }

    // ── end-to-end loopback: mock gateway + LAN server + bridge + client ──
    //
    // A minimal in-process stand-in for the Cloudflare gateway — now with
    // the v2 surface (manifest over plain HTTP on the same port,
    // hello/welcome, upstream forwarding, rate limiting, frame-cap
    // enforcement) — plus the REAL desktop bridge and the REAL tunnel
    // client, pointed at a REAL spawn_on pairing server: allocate a code →
    // resolve it → pair → list → pull must deliver the exact bytes through
    // two WebSocket hops and a TCP bridge.

    /// Serializes the tests that park a session in the process-global host
    /// slot (and the global live-code watch) — cargo runs tests in parallel
    /// threads and the slot is a singleton.
    static HOST_SLOT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// The mock's v2 health-document recipe.
    #[derive(Debug, Clone)]
    struct ManifestSpec {
        provider: String,
        /// e.g. ["v1"]; ["v3"] drives the unsupported-protocol path.
        protocol: Vec<String>,
        /// `endpoints.relay` — a path (resolved against the mock's host) or
        /// an absolute ws URL.
        relay: String,
        notice: Option<String>,
        /// `minClientVersion` — `Some("99.0.0")` drives the too-old path.
        min_client_version: Option<String>,
    }

    impl Default for ManifestSpec {
        fn default() -> Self {
            Self {
                provider: "wowsp-mock".into(),
                protocol: vec!["v1".into()],
                relay: "/relay-ws".into(),
                notice: None,
                min_client_version: None,
            }
        }
    }

    /// Behavior switches of one mock gateway instance.
    #[derive(Debug, Clone)]
    struct MockOptions {
        /// Serve `GET /api/health` (None → 404 → client legacy fallback).
        manifest: Option<ManifestSpec>,
        /// Serve a FORWARDER document whose `upstream` is this root (wins
        /// over `manifest`).
        forward_to: Option<String>,
        /// Answer code resolution with `err / rate_limited`.
        rate_limited: bool,
        /// v2 flavor: answer `hello` with `welcome` (false = legacy v1
        /// worker that ignores hello).
        welcome: bool,
        /// Reject data-socket binary frames above the 256 KiB tunnel cap
        /// (the real worker's byte-tunnel policy).
        enforce_frame_cap: bool,
        /// Serve `echo*` conn ids with an HTTP-framed echo responder (the
        /// chunking round-trip test path).
        echo: bool,
        /// Drop every WebSocket right after the handshake (a pure forwarder
        /// that hosts no rooms of its own).
        ws_dead: bool,
    }

    impl Default for MockOptions {
        fn default() -> Self {
            Self {
                manifest: Some(ManifestSpec::default()),
                forward_to: None,
                rate_limited: false,
                welcome: true,
                enforce_frame_cap: true,
                echo: false,
                ws_dead: false,
            }
        }
    }

    /// Minimal in-process stand-in for the Cloudflare gateway: v2 manifest
    /// over plain HTTP on the SAME port (peek-dispatched before the WS
    /// handshake), the v1 allocate/resolve/control/data protocol with
    /// hello/welcome on top, in-memory room + code map, raw byte pipes.
    /// Serves until the shutdown watch fires.
    mod mock_gateway {
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex as StdMutex};
        use std::time::Duration;

        use futures::{SinkExt, StreamExt};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};
        use tokio::sync::watch;
        use tokio_tungstenite::WebSocketStream;
        use tokio_tungstenite::tungstenite::Message;
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

        use super::{super::MAX_OUTGOING_FRAME, MockOptions};

        type Ws = WebSocketStream<TcpStream>;

        #[derive(Default)]
        struct Pending {
            client: Option<Ws>,
            host_side: Option<Ws>,
        }

        /// Manifest requests seen: (path, sent_no_store_cache_control).
        pub type ManifestHits = Arc<StdMutex<Vec<(String, bool)>>>;

        #[derive(Default)]
        struct Hub {
            /// Where control-client tasks forward {type:"open"} to the host
            /// task (None until the host control connects).
            host_tx: Option<futures::channel::mpsc::UnboundedSender<String>>,
            pending: Arc<StdMutex<HashMap<String, Arc<StdMutex<Pending>>>>>,
            /// Allocated codes: 6-digit code → room key.
            codes: Arc<StdMutex<HashMap<String, String>>>,
            /// Reverse binding room → its ONE active code (mirrors the real
            /// Directory: re-allocating replaces the room's previous code).
            rooms: Arc<StdMutex<HashMap<String, String>>>,
            /// Code mint counter (deterministic, distinct codes per test).
            code_seq: Arc<StdMutex<u32>>,
            /// Plain-HTTP manifest requests, for assertions.
            pub manifest_hits: ManifestHits,
        }

        type SharedHub = Arc<StdMutex<Hub>>;

        pub async fn serve(
            listener: TcpListener,
            shutdown: watch::Receiver<bool>,
            opts: MockOptions,
            manifest_hits: ManifestHits,
        ) {
            let opts = Arc::new(opts);
            let hub: SharedHub = Arc::new(StdMutex::new(Hub {
                manifest_hits,
                ..Hub::default()
            }));
            let mut shutdown = shutdown;
            loop {
                let accepted = tokio::select! {
                    _ = shutdown.changed() => break,
                    res = listener.accept() => res,
                };
                let Ok((stream, _)) = accepted else { continue };
                let hub = hub.clone();
                let opts = opts.clone();
                tokio::spawn(async move { handle(stream, hub, opts).await });
            }
        }

        async fn handle(stream: TcpStream, hub: SharedHub, opts: Arc<MockOptions>) {
            // Same-port dispatch: peek the request line — a plain GET
            // without an Upgrade header is the v2 manifest route; anything
            // else goes to the WebSocket handshake (peek does not consume).
            let mut peek = [0u8; 1024];
            let n = stream.peek(&mut peek).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&peek[..n]).to_ascii_lowercase();
            if head.starts_with("get") && !head.contains("upgrade:") {
                serve_manifest(stream, hub, opts).await;
                return;
            }
            let mut path = String::new();
            let cb = |req: &Request, resp: Response| {
                path.push_str(req.uri().path());
                if let Some(q) = req.uri().query() {
                    path.push('?');
                    path.push_str(q);
                }
                Ok(resp)
            };
            let ws = match tokio_tungstenite::accept_hdr_async(stream, cb).await {
                Ok(w) => w,
                Err(_) => return,
            };
            if opts.ws_dead {
                let mut ws = ws;
                let _ = ws.close(None).await;
                return;
            }
            let no_query = path.split('?').next().unwrap_or("").to_string();
            if no_query.ends_with("/resolve") || no_query == "/resolve" {
                resolve_socket(ws, hub, &path, opts).await;
            } else if no_query.ends_with("/control") || no_query == "/control" {
                if query(&path, "role").as_deref() == Some("host") {
                    let room = query(&path, "room").unwrap_or_default();
                    host_control(ws, hub, room, opts).await;
                } else {
                    client_control(ws, hub, opts).await;
                }
            } else if no_query.contains("/data/") {
                data_socket(ws, hub, &path, opts).await;
            }
        }

        /// Plain-HTTP `GET /api/health` (or 404). Reads the full request
        /// head first — the peek window may have truncated it.
        async fn serve_manifest(mut stream: TcpStream, hub: SharedHub, opts: Arc<MockOptions>) {
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                match stream.read(&mut byte).await {
                    Ok(0) => break,
                    Ok(_) => {
                        buf.push(byte[0]);
                        if buf.ends_with(b"\r\n\r\n") || buf.len() > 8 * 1024 {
                            break;
                        }
                    },
                    Err(_) => return,
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
            if path != "/api/health" {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                return;
            }
            let no_store = head
                .to_ascii_lowercase()
                .contains("cache-control: no-store");
            if let Ok(hub) = hub.lock() {
                hub.manifest_hits.lock().unwrap().push((path, no_store));
            }
            let body = if let Some(up) = &opts.forward_to {
                serde_json::json!({
                    "ok": true,
                    "provider": "wowsp-mock-forwarder",
                    "name": "Mock Forwarder",
                    "version": "0.5.0",
                    "protocol": ["v1"],
                    "endpoints": { "relay": "/relay-ws" },
                    "upstream": up,
                    "features": [],
                    "notice": null
                })
            } else if let Some(m) = &opts.manifest {
                serde_json::json!({
                    "ok": true,
                    "provider": m.provider,
                    "name": "Mock Gateway",
                    "version": "0.5.0",
                    "minClientVersion": m.min_client_version,
                    "protocol": m.protocol,
                    "endpoints": { "relay": m.relay },
                    "upstream": null,
                    "features": ["allocate"],
                    "notice": m.notice
                })
            } else {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                return;
            };
            let body = body.to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        }

        fn query(path: &str, key: &str) -> Option<String> {
            let q = path.split_once('?')?.1;
            q.split('&').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                (k == key).then(|| v.to_string())
            })
        }

        /// Is this text frame a v2 client hello?
        fn is_hello(text: &str) -> bool {
            serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|v| {
                    let t = v.get("type").and_then(|x| x.as_str())?;
                    let proto = v.get("protocol").and_then(|x| x.as_str())?;
                    Some(t == "hello" && proto == "v1")
                })
                .unwrap_or(false)
        }

        /// Phone's code→room handshake: (v2) welcome the hello first, then
        /// one {"type":"room"} frame, or {"type":"err"[, reason]} for an
        /// unknown / rate-limited code.
        async fn resolve_socket(mut ws: Ws, hub: SharedHub, path: &str, opts: Arc<MockOptions>) {
            if opts.welcome {
                if let Ok(Some(Ok(Message::Text(t)))) =
                    tokio::time::timeout(Duration::from_secs(5), ws.next()).await
                {
                    if is_hello(&t) {
                        let _ = ws.send(Message::Text(r#"{"type":"welcome"}"#.into())).await;
                    }
                }
            }
            let code = query(path, "code").unwrap_or_default();
            let frame = if opts.rate_limited {
                serde_json::json!({ "type": "err", "reason": "rate_limited" }).to_string()
            } else {
                let room = hub
                    .lock()
                    .unwrap()
                    .codes
                    .lock()
                    .unwrap()
                    .get(&code)
                    .cloned();
                match room {
                    Some(room) => serde_json::json!({ "type": "room", "room": room }).to_string(),
                    None => serde_json::json!({ "type": "err" }).to_string(),
                }
            };
            if ws.send(Message::Text(frame.into())).await.is_err() {
                return;
            }
            let _ = ws.close(None).await;
        }

        /// Host control channel: (v2) welcome hellos, answers
        /// {type:"allocate"} with a fresh code bound to the host's room,
        /// receives conn ids on a channel, forwards them as JSON signals.
        /// Tolerates keepalive texts. Exits when the socket dies (tx drop
        /// tells client tasks the host is gone).
        async fn host_control(mut ws: Ws, hub: SharedHub, room: String, opts: Arc<MockOptions>) {
            let (tx, mut rx) = futures::channel::mpsc::unbounded::<String>();
            hub.lock().unwrap().host_tx = Some(tx);
            loop {
                tokio::select! {
                    maybe_id = rx.next() => {
                        let Some(id) = maybe_id else { break };
                        let signal =
                            serde_json::json!({ "type": "conn", "connId": id }).to_string();
                        if ws.send(Message::Text(signal.into())).await.is_err() {
                            break;
                        }
                    },
                    read = ws.next() => {
                        match read {
                            Some(Ok(Message::Text(t))) => {
                                let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                                    continue;
                                };
                                match v.get("type").and_then(|x| x.as_str()) {
                                    Some("hello") if opts.welcome => {
                                        let _ = ws
                                            .send(Message::Text(r#"{"type":"welcome"}"#.into()))
                                            .await;
                                    },
                                    Some("allocate") => {
                                        let seq = {
                                            let hub = hub.lock().unwrap();
                                            let mut s = hub.code_seq.lock().unwrap();
                                            *s += 1;
                                            *s
                                        };
                                        let code = format!("{seq:06}");
                                        {
                                            // One active code per host: drop the
                                            // room's previous binding first.
                                            let hub = hub.lock().unwrap();
                                            let mut codes = hub.codes.lock().unwrap();
                                            let mut rooms = hub.rooms.lock().unwrap();
                                            if let Some(old) = rooms.remove(&room) {
                                                codes.remove(&old);
                                            }
                                            codes.insert(code.clone(), room.clone());
                                            rooms.insert(room.clone(), code.clone());
                                        }
                                        let reply = serde_json::json!({
                                            "type": "code", "code": code
                                        })
                                        .to_string();
                                        if ws.send(Message::Text(reply.into())).await.is_err() {
                                            break;
                                        }
                                    },
                                    _ => continue, // keepalive & friends: ignore
                                }
                            },
                            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                            _ => break,
                        }
                    },
                }
            }
            hub.lock().unwrap().host_tx = None;
        }

        /// Client control channel: (v2) welcome the hello, then answer host
        /// presence once, then forward {type:"open"} requests.
        async fn client_control(mut ws: Ws, hub: SharedHub, opts: Arc<MockOptions>) {
            if opts.welcome {
                if let Ok(Some(Ok(Message::Text(t)))) =
                    tokio::time::timeout(Duration::from_secs(5), ws.next()).await
                {
                    if is_hello(&t) {
                        let _ = ws.send(Message::Text(r#"{"type":"welcome"}"#.into())).await;
                    }
                }
            }
            let host_present = hub.lock().unwrap().host_tx.is_some();
            let greeting = if host_present {
                r#"{"type":"ready"}"#
            } else {
                r#"{"type":"waiting"}"#
            };
            if ws.send(Message::Text(greeting.into())).await.is_err() {
                return;
            }
            while let Some(Ok(msg)) = ws.next().await {
                let Message::Text(t) = msg else { continue };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                    continue;
                };
                if v.get("type").and_then(|x| x.as_str()) != Some("open") {
                    continue;
                }
                let Some(id) = v.get("connId").and_then(|c| c.as_str()) else {
                    continue;
                };
                hub.lock()
                    .unwrap()
                    .pending
                    .lock()
                    .unwrap()
                    .entry(id.to_string())
                    .or_default();
                let forward = hub
                    .lock()
                    .unwrap()
                    .host_tx
                    .as_ref()
                    .map(|tx| tx.unbounded_send(id.to_string()).is_ok());
                if forward != Some(true) {
                    // No host to signal — leave the pending entry; the test
                    // tears the room down with the process.
                    return;
                }
            }
        }

        /// Data socket: `echo*` conn ids get the HTTP-framed echo responder
        /// (chunk round-trip test); anything else attaches to the pending
        /// conn, waits (briefly) for the peer side, then pipes raw bytes
        /// until either side closes — rejecting oversized binary frames
        /// when the cap is enforced (the real worker's policy).
        async fn data_socket(ws: Ws, hub: SharedHub, path: &str, opts: Arc<MockOptions>) {
            let conn = query(path, "conn").unwrap_or_default();
            let side = query(path, "side").unwrap_or_default();
            if opts.echo && conn.starts_with("echo") {
                echo_responder(ws, opts).await;
                return;
            }
            let entry = hub
                .lock()
                .unwrap()
                .pending
                .lock()
                .unwrap()
                .get(&conn)
                .cloned();
            let Some(entry) = entry else {
                let mut ws = ws;
                let _ = ws.close(None).await;
                return;
            };
            {
                let mut p = entry.lock().unwrap();
                if side == "client" {
                    p.client = Some(ws);
                } else {
                    p.host_side = Some(ws);
                }
            }
            // Wait for the peer (bounded ~2s), then take both and pipe.
            for _ in 0..100 {
                let ready = {
                    let p = entry.lock().unwrap();
                    p.client.is_some() && p.host_side.is_some()
                };
                if ready {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let pair = {
                let mut p = entry.lock().unwrap();
                (p.client.take(), p.host_side.take())
            };
            if let (Some(client), Some(host)) = pair {
                tokio::spawn(pipe(client, host, opts));
            }
        }

        /// Read exactly one HTTP request (Content-Length framed), then echo
        /// its body back as one big HTTP response in a SINGLE binary frame —
        /// under the 1 MiB inbound cap, well above the 256 KiB outbound one.
        /// Oversized inbound frames abort the socket when the cap is
        /// enforced.
        async fn echo_responder(mut ws: Ws, opts: Arc<MockOptions>) {
            let mut buf: Vec<u8> = Vec::new();
            let mut expected: Option<usize> = None;
            while let Some(Ok(msg)) = ws.next().await {
                match msg {
                    Message::Binary(b) => {
                        if opts.enforce_frame_cap && b.len() > MAX_OUTGOING_FRAME {
                            let _ = ws.close(None).await;
                            return;
                        }
                        buf.extend_from_slice(&b);
                        if expected.is_none() {
                            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                let head = String::from_utf8_lossy(&buf[..pos + 4]).to_string();
                                let cl = head
                                    .lines()
                                    .find_map(|l| {
                                        let (k, v) = l.split_once(':')?;
                                        k.trim()
                                            .eq_ignore_ascii_case("content-length")
                                            .then(|| v.trim().parse::<usize>().ok())?
                                    })
                                    .unwrap_or(0);
                                expected = Some(pos + 4 + cl);
                            }
                        }
                        if let Some(e) = expected {
                            if buf.len() >= e {
                                break;
                            }
                        }
                    },
                    Message::Close(_) => return,
                    _ => {},
                }
            }
            let Some(e) = expected else { return };
            let head_end = buf
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| p + 4)
                .unwrap_or(e);
            let body = &buf[head_end..e];
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let mut frame = resp.into_bytes();
            frame.extend_from_slice(body);
            let _ = ws.send(Message::Binary(frame.into())).await;
            let _ = ws.close(None).await;
        }

        /// Raw byte pipe between the two data sockets (binary frames only;
        /// oversized frames rejected when the cap is enforced).
        async fn pipe(a: Ws, b: Ws, opts: Arc<MockOptions>) {
            let (mut a_sink, mut a_stream) = a.split();
            let (mut b_sink, mut b_stream) = b.split();
            let ab = pipe_half(&mut a_stream, &mut b_sink, &opts);
            let ba = pipe_half(&mut b_stream, &mut a_sink, &opts);
            tokio::join!(ab, ba);
        }

        async fn pipe_half(
            from: &mut futures::stream::SplitStream<Ws>,
            to: &mut futures::stream::SplitSink<Ws, Message>,
            opts: &Arc<MockOptions>,
        ) {
            while let Some(Ok(msg)) = from.next().await {
                match msg {
                    Message::Binary(data) => {
                        if opts.enforce_frame_cap && data.len() > MAX_OUTGOING_FRAME {
                            let _ = to.send(Message::Close(None)).await;
                            break;
                        }
                        if to.send(Message::Binary(data)).await.is_err() {
                            break;
                        }
                    },
                    Message::Close(_) => {
                        let _ = to.send(Message::Close(None)).await;
                        break;
                    },
                    _ => {},
                }
            }
        }
    }

    /// Bind a mock gateway on an ephemeral loopback port; returns its http
    /// root, shutdown sender, serve task, and the manifest-request log.
    struct MockGateway {
        root: String,
        shutdown: tokio::sync::watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
        /// `(path, sent_no_store)` per plain-HTTP manifest request seen.
        manifest_hits: mock_gateway::ManifestHits,
    }

    impl MockGateway {
        async fn start(opts: MockOptions) -> Self {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            Self::start_on(listener, opts).await
        }

        /// Serve on an ALREADY-BOUND listener (tests that need two mocks to
        /// reference each other's root bind both first).
        async fn start_on(listener: tokio::net::TcpListener, opts: MockOptions) -> Self {
            let port = listener.local_addr().unwrap().port();
            let (tx, rx) = tokio::sync::watch::channel(false);
            let manifest_hits: mock_gateway::ManifestHits =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let task = tokio::spawn(mock_gateway::serve(
                listener,
                rx,
                opts,
                manifest_hits.clone(),
            ));
            Self {
                root: format!("http://127.0.0.1:{port}"),
                shutdown: tx,
                task,
                manifest_hits,
            }
        }

        async fn stop(self) {
            let _ = self.shutdown.send(true);
            let _ = self.task.await;
        }
    }

    /// The full v2 loopback: the REAL bridge resolves the mock's manifest,
    /// allocates a code through the resolved endpoint, the code lands in
    /// the live state, the phone-shaped client resolves + pairs with the
    /// code, and the code doubles as an accepted /pair secret on the REAL
    /// server (LAN + relay in one exchange).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn allocate_resolve_pair_and_pull_over_the_tunnel() {
        let _serial = HOST_SLOT_LOCK.lock().await;
        // Defensive: a panicked earlier test could leave the global slot /
        // code watch / resolution cache dirty.
        host_session_stop().await;
        store_code(None);
        clear_resolution_cache_for_test();
        use super::super::pairing;

        // Fixture replay (same shape as pairing's own e2e).
        let tmp = pairing::tests::tempfile_dir();
        let replays = tmp.join("replays");
        std::fs::create_dir_all(&replays).unwrap();
        let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
        let mut bytes: Vec<u8> = vec![0x12, 0x32, 0x34, 0x11];
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        let replay_name = "20260922_101010_Tester_15_NE_north.wowsreplay";
        std::fs::write(replays.join(replay_name), &bytes).unwrap();

        // 1. The REAL pairing server on an ephemeral localhost port, with a
        //    random room id (the v2 shape: rooms are NOT pin-derived).
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let server_port = listener.local_addr().unwrap().port();
        let room = pairing::server::random_token().unwrap();
        let server = pairing::server::spawn_on(listener, replays.clone(), None, "123456", &room)
            .await
            .unwrap();

        // 2. The mock gateway (default v2: manifest + welcome + relay path
        //    + frame-cap enforcement) on another ephemeral port.
        let gateway = MockGateway::start(MockOptions::default()).await;

        // 3. The REAL host bridge, started from the gateway ROOT — it must
        //    resolve the manifest and dial the /relay-ws endpoint. On
        //    connect it asks the gateway to allocate the pairing code; the
        //    code lands in the live state.
        host_session_start(&gateway.root, server_port, &room)
            .await
            .unwrap_or_else(|e| panic!("host session must start: {e}"));
        // Budget covers the v2 hello/welcome round trip plus allocation.
        let code = wait_for_code(std::time::Duration::from_secs(15))
            .await
            .unwrap_or_else(|e| panic!("the mock gateway must allocate a code: {e}"));
        assert_eq!(code.len(), 6, "the gateway mints 6-digit codes");
        assert!(relay_online(), "a live code means the gateway is online");

        // The resolved manifest info surfaced for the status: the mock's
        // provider, direct (no upstream hop).
        let info = current_gateway_info();
        assert_eq!(info.provider.as_deref(), Some("wowsp-mock"));
        assert!(!info.via_upstream);
        assert_eq!(info.notice, None);

        // The health fetch itself: /api/health, requested no-store.
        {
            let hits = gateway.manifest_hits.lock().unwrap();
            assert!(!hits.is_empty(), "the manifest route must have been hit");
            assert!(
                hits.iter()
                    .all(|(p, no_store)| p == "/api/health" && *no_store),
                "manifest requests must send Cache-Control: no-store"
            );
        }

        // 4. Client: resolve + pair WITH THE CODE (never the local pin),
        //    starting from the same root (the session's cached resolution).
        let paired = relay_pair(&gateway.root, &code).await.unwrap();
        assert!(!paired.token.is_empty());
        assert_eq!(
            paired.room.as_deref(),
            Some(room.as_str()),
            "the resolved room rides back"
        );

        // The 6-digit code is also an accepted /pair secret on the REAL
        // server over PLAIN LAN HTTP (what a same-network phone types).
        let lan = reqwest::Client::builder().no_proxy().build().unwrap();
        let r = lan
            .post(format!("http://127.0.0.1:{server_port}/pair"))
            .json(&serde_json::json!({ "pin": code }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "the relay code pairs over the LAN too");
        let body: serde_json::Value = r.json().await.unwrap();
        assert_eq!(
            body["room"],
            serde_json::json!(room),
            "/pair echoes the room key"
        );

        // An unknown-but-well-formed code resolves to the gateway-unreachable
        // marker (the phone's friendly error state), not a raw crash.
        let err = relay_pair(&gateway.root, "000000").await.unwrap_err();
        assert_eq!(err, GATEWAY_UNREACHABLE);
        // A malformed code is rejected before any network I/O.
        let err = relay_pair(&gateway.root, "12a4").await.unwrap_err();
        assert_eq!(err, GATEWAY_UNREACHABLE);

        // 5. List through the tunnel using the stored room key (the same
        //    60s-cycle client the LAN flow shares).
        let list = relay_list_remote(&gateway.root, &room, &paired.token)
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, replay_name);

        // Bad token → clean 401 string.
        let err = relay_list_remote(&gateway.root, &room, "nope")
            .await
            .unwrap_err();
        assert_eq!(err, "invalid or expired token");

        // 6. Pull the replay through the tunnel → exact bytes.
        let dest = tmp.join("pulled.wowsreplay");
        let n = relay_pull_replay(
            None, // no AppHandle in unit tests → progress events skipped
            &gateway.root,
            &room,
            &paired.token,
            replay_name,
            &dest,
        )
        .await
        .unwrap_or_else(|e| panic!("relay pull failed: {e}"));
        assert_eq!(n, bytes.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);

        // 7. Regenerate: a fresh code replaces the old one (single active
        //    code per host), and the OLD code stops resolving.
        let fresh = host_reallocate().await.unwrap();
        assert_ne!(fresh, code, "the gateway must mint a new code");
        assert_eq!(current_relay_code().as_deref(), Some(fresh.as_str()));
        let err = relay_pair(&gateway.root, &code).await.unwrap_err();
        assert_eq!(err, GATEWAY_UNREACHABLE, "the replaced code is dead");
        let paired2 = relay_pair(&gateway.root, &fresh).await.unwrap();
        assert_eq!(paired2.room.as_deref(), Some(room.as_str()));

        // 8. Tear everything down: the live code and gateway info clear
        //    with the session.
        host_session_stop().await;
        assert!(!relay_online(), "stopping the session clears the code");
        assert_eq!(current_relay_code(), None);
        assert_eq!(current_gateway_info().provider, None);
        let _ = server.stop().await;
        gateway.stop().await;
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A gateway with NO manifest (404) is served in LEGACY v1 direct mode:
    /// resolution falls back to `ws://<root>`, the bridge and client still
    /// pair end-to-end, and no provider info surfaces (legacy has none).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn missing_manifest_falls_back_to_legacy_direct_mode() {
        let _serial = HOST_SLOT_LOCK.lock().await;
        host_session_stop().await;
        store_code(None);
        clear_resolution_cache_for_test();
        use super::super::pairing;

        let tmp = pairing::tests::tempfile_dir();
        let replays = tmp.join("replays");
        std::fs::create_dir_all(&replays).unwrap();

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let server_port = listener.local_addr().unwrap().port();
        let room = pairing::server::random_token().unwrap();
        let server = pairing::server::spawn_on(listener, replays.clone(), None, "123456", &room)
            .await
            .unwrap();

        // No manifest, legacy v1 flavor (no hello/welcome either).
        let gateway = MockGateway::start(MockOptions {
            manifest: None,
            welcome: false,
            ..MockOptions::default()
        })
        .await;

        // Resolution degrades to the legacy ws base.
        let res = resolve_gateway_cached(&gateway.root).await.unwrap();
        assert!(res.manifest.is_none());
        assert!(!res.via_upstream);
        assert_eq!(res.ws_base, ws_base_of_root(&gateway.root));
        // …and the fallback was driven by an actual 404 from /api/health.
        assert!(
            !gateway.manifest_hits.lock().unwrap().is_empty(),
            "legacy fallback must still have probed the manifest route"
        );

        // The bridge still pairs through it (hello tolerated in silence).
        host_session_start(&gateway.root, server_port, &room)
            .await
            .unwrap();
        let code = wait_for_code(std::time::Duration::from_secs(15))
            .await
            .unwrap();
        let paired = relay_pair(&gateway.root, &code).await.unwrap();
        assert_eq!(paired.room.as_deref(), Some(room.as_str()));

        // Legacy mode surfaces NO provider info.
        let info = current_gateway_info();
        assert_eq!(info.provider, None);
        assert!(!info.via_upstream);

        host_session_stop().await;
        let _ = server.stop().await;
        gateway.stop().await;
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// One upstream hop: gateway A's manifest forwards to gateway B, and
    /// the whole pairing flow (bridge + phone) runs THROUGH B — A's own
    /// WebSocket surface is dead, so success proves the hop was followed.
    /// The status surfaces B's provider + viaUpstream=true.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn upstream_hop_pairs_through_the_forwarded_gateway() {
        let _serial = HOST_SLOT_LOCK.lock().await;
        host_session_stop().await;
        store_code(None);
        clear_resolution_cache_for_test();
        use super::super::pairing;

        let tmp = pairing::tests::tempfile_dir();
        let replays = tmp.join("replays");
        std::fs::create_dir_all(&replays).unwrap();

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let server_port = listener.local_addr().unwrap().port();
        let room = pairing::server::random_token().unwrap();
        let server = pairing::server::spawn_on(listener, replays.clone(), None, "123456", &room)
            .await
            .unwrap();

        // B: the real exchange behind the hop.
        let b = MockGateway::start(MockOptions {
            manifest: Some(ManifestSpec {
                provider: "wowsp-mock-b".into(),
                notice: Some("maintenance soon".into()),
                ..ManifestSpec::default()
            }),
            ..MockOptions::default()
        })
        .await;
        // A: a pure forwarder — manifest only, every WS connection dropped.
        let a = MockGateway::start(MockOptions {
            forward_to: Some(b.root.clone()),
            ws_dead: true,
            ..MockOptions::default()
        })
        .await;

        // Resolution from A's root lands on B's relay endpoint (an
        // absolute path in B's document REPLACES any base on the host).
        let res = resolve_gateway(&a.root).await.unwrap();
        assert!(res.via_upstream);
        assert_eq!(res.manifest.as_ref().unwrap().provider, "wowsp-mock-b");
        let b_host = b.root.trim_start_matches("http://");
        assert_eq!(res.ws_base, format!("ws://{b_host}/relay-ws"));

        // The bridge + phone pair through the chain (A's WS is dead — only
        // B can carry it).
        host_session_start(&a.root, server_port, &room)
            .await
            .unwrap();
        let code = wait_for_code(std::time::Duration::from_secs(15))
            .await
            .unwrap();
        let paired = relay_pair(&a.root, &code).await.unwrap();
        assert_eq!(paired.room.as_deref(), Some(room.as_str()));
        let list = relay_list_remote(&a.root, &room, &paired.token)
            .await
            .unwrap();
        assert!(list.is_empty());

        // The status carries B's provider, the hop flag, and the notice.
        let info = current_gateway_info();
        assert_eq!(info.provider.as_deref(), Some("wowsp-mock-b"));
        assert!(info.via_upstream);
        assert_eq!(info.notice.as_deref(), Some("maintenance soon"));

        host_session_stop().await;
        let _ = server.stop().await;
        a.stop().await;
        b.stop().await;
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// An upstream CYCLE and an over-long chain both abort resolution and
    /// degrade to legacy direct mode at the INITIAL root.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn upstream_cycles_and_hop_budget_degrade_to_the_initial_root() {
        clear_resolution_cache_for_test();

        // Cycle: A → B → A (both pre-bound so each can point at the other).
        let la = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let lb = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let root_a = format!("http://127.0.0.1:{}", la.local_addr().unwrap().port());
        let root_b = format!("http://127.0.0.1:{}", lb.local_addr().unwrap().port());
        let a = MockGateway::start_on(
            la,
            MockOptions {
                forward_to: Some(root_b.clone()),
                ..MockOptions::default()
            },
        )
        .await;
        let b = MockGateway::start_on(
            lb,
            MockOptions {
                forward_to: Some(root_a.clone()),
                ..MockOptions::default()
            },
        )
        .await;
        let res = resolve_gateway(&root_a).await.unwrap();
        assert!(res.manifest.is_none(), "the cycle aborts manifest mode");
        assert!(!res.via_upstream);
        assert_eq!(res.ws_base, ws_base_of_root(&root_a));
        a.stop().await;
        b.stop().await;

        // Hop budget: A → B → C → (D, never fetched) exceeds the 2-hop
        // limit — even though every hop itself is healthy.
        clear_resolution_cache_for_test();
        let c = MockGateway::start(MockOptions {
            forward_to: Some("http://127.0.0.1:9".into()),
            ..MockOptions::default()
        })
        .await;
        let b2 = MockGateway::start(MockOptions {
            forward_to: Some(c.root.clone()),
            ..MockOptions::default()
        })
        .await;
        let a2 = MockGateway::start(MockOptions {
            forward_to: Some(b2.root.clone()),
            ..MockOptions::default()
        })
        .await;
        let res = resolve_gateway(&a2.root).await.unwrap();
        assert!(res.manifest.is_none(), "the chain is too long");
        assert!(!res.via_upstream);
        assert_eq!(res.ws_base, ws_base_of_root(&a2.root));
        a2.stop().await;
        b2.stop().await;
        c.stop().await;
    }

    /// A final manifest that does not list protocol v1 surfaces the
    /// DISTINCT unsupported-protocol error: the phone's pairing fails with
    /// it (not "gateway unreachable") and the desktop bridge refuses to
    /// start (LAN-only fallback).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unsupported_protocol_fails_resolution_distinctly() {
        let _serial = HOST_SLOT_LOCK.lock().await;
        host_session_stop().await;
        store_code(None);
        clear_resolution_cache_for_test();

        let gateway = MockGateway::start(MockOptions {
            manifest: Some(ManifestSpec {
                protocol: vec!["v3".into()],
                ..ManifestSpec::default()
            }),
            ..MockOptions::default()
        })
        .await;

        // Resolution errors with the distinct marker.
        let err = resolve_gateway_cached(&gateway.root).await.unwrap_err();
        assert_eq!(err, UNSUPPORTED_PROTOCOL);
        // And it is NOT cached — every call re-surfaces it.
        let err = resolve_gateway_cached(&gateway.root).await.unwrap_err();
        assert_eq!(err, UNSUPPORTED_PROTOCOL);

        // The phone's pair path propagates it verbatim.
        let err = relay_pair(&gateway.root, "123456").await.unwrap_err();
        assert_eq!(err, UNSUPPORTED_PROTOCOL);
        assert_ne!(err, GATEWAY_UNREACHABLE);

        // The desktop bridge refuses to start; the relay stays offline.
        let err = host_session_start(&gateway.root, 1, &"a".repeat(64))
            .await
            .unwrap_err();
        assert_eq!(err, UNSUPPORTED_PROTOCOL);
        assert!(!relay_online());
        assert_eq!(current_gateway_info().provider, None);

        gateway.stop().await;
    }

    /// Numeric x.y.z comparison: suffix junk is ignored, missing parts
    /// count as zero, equal strings pass.
    #[test]
    fn client_meets_minimum_compares_dotted_versions() {
        use super::client_meets_minimum as meets;
        assert!(meets("0.5.0", "0.5.0"));
        assert!(meets("0.5.1", "0.5.0"));
        assert!(meets("1.0.0", "0.9.9"));
        assert!(meets("0.5.0", "0.5"));
        assert!(meets("0.5.0", "0.5.0-beta"));
        assert!(meets("0.6.0-rc.1", "0.6.0"));
        assert!(!meets("0.4.9", "0.5.0"));
        assert!(!meets("0.5.0", "0.5.1"));
        assert!(!meets("0.10.0", "1.0.0"));
        // Junk minimum parts degrade to 0 — never strand a client over a
        // malformed field.
        assert!(meets("0.5.0", "not-a-version"));
    }

    /// A gateway whose health document demands a newer client surfaces the
    /// DISTINCT too-old error (never the retryable unreachable marker),
    /// identically on phone and desktop paths.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn min_client_version_gate_fails_distinctly() {
        let _serial = HOST_SLOT_LOCK.lock().await;
        host_session_stop().await;
        store_code(None);
        clear_resolution_cache_for_test();

        let gateway = MockGateway::start(MockOptions {
            manifest: Some(ManifestSpec {
                min_client_version: Some("99.0.0".into()),
                ..ManifestSpec::default()
            }),
            ..MockOptions::default()
        })
        .await;

        let err = resolve_gateway_cached(&gateway.root).await.unwrap_err();
        assert_eq!(err, CLIENT_TOO_OLD);
        assert_ne!(err, GATEWAY_UNREACHABLE);
        assert_ne!(err, UNSUPPORTED_PROTOCOL);
        // Not cached — every call re-surfaces it.
        assert_eq!(
            resolve_gateway_cached(&gateway.root).await.unwrap_err(),
            CLIENT_TOO_OLD
        );
        // The phone's pair path propagates it verbatim.
        assert_eq!(
            relay_pair(&gateway.root, "123456").await.unwrap_err(),
            CLIENT_TOO_OLD
        );
        // The desktop bridge refuses to start.
        assert_eq!(
            host_session_start(&gateway.root, 1, &"a".repeat(64))
                .await
                .unwrap_err(),
            CLIENT_TOO_OLD
        );

        gateway.stop().await;
    }

    /// A minClientVersion the client satisfies is a no-op.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn satisfied_min_client_version_passes() {
        clear_resolution_cache_for_test();
        let gateway = MockGateway::start(MockOptions {
            manifest: Some(ManifestSpec {
                min_client_version: Some("0.1.0".into()),
                ..ManifestSpec::default()
            }),
            ..MockOptions::default()
        })
        .await;
        let res = resolve_gateway_cached(&gateway.root).await.unwrap();
        assert!(res.manifest.is_some());
        gateway.stop().await;
    }

    /// The gateway's directory rate-limiting the phone (`err` +
    /// `reason: rate_limited` on resolve) propagates as the DISTINCT
    /// rate-limit error — not the generic unreachable marker.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn rate_limited_resolve_errors_propagate_distinctly() {
        clear_resolution_cache_for_test();
        let gateway = MockGateway::start(MockOptions {
            rate_limited: true,
            ..MockOptions::default()
        })
        .await;

        let err = relay_pair(&gateway.root, "123456").await.unwrap_err();
        assert_eq!(err, GATEWAY_RATE_LIMITED);
        assert_ne!(err, GATEWAY_UNREACHABLE);

        gateway.stop().await;
    }

    /// The byte-tunnel frame cap, both directions: a >256 KiB request
    /// succeeds because the client CHUNKS its outgoing frames (the
    /// enforcing mock rejects a raw oversized frame), and a ~600 KiB
    /// response arrives in one sub-1-MiB inbound frame.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn oversized_writes_round_trip_via_chunking() {
        clear_resolution_cache_for_test();
        let gateway = MockGateway::start(MockOptions {
            echo: true,
            ..MockOptions::default()
        })
        .await;
        let res = resolve_gateway_cached(&gateway.root).await.unwrap();

        // A 600 KiB request body — well above the 256 KiB frame cap.
        let body: Vec<u8> = (0..600 * 1024).map(|i| (i % 251) as u8).collect();
        let req = tunnel_request("POST", "/echo", None, Some(&body));
        let data = ws_connect(&data_url(&res.ws_base, &"e".repeat(64), "echo1", "client"))
            .await
            .unwrap();
        let (head, resp) = tunnel_round_trip(data, &req, LIST_TIMEOUT)
            .await
            .unwrap_or_else(|e| panic!("chunked round trip must succeed: {e}"));
        assert_eq!(head.status, 200);
        assert_eq!(head.content_length(), Some(body.len() as u64));
        let echoed = resp.read_all(MAX_RESPONSE_BODY).await.unwrap();
        assert_eq!(echoed, body, "the echo body round-trips byte-exact");

        // Negative control: ONE raw oversized frame is rejected by the
        // enforcing mock — the chunker above is what made it pass.
        let mut data = ws_connect(&data_url(&res.ws_base, &"e".repeat(64), "echo2", "client"))
            .await
            .unwrap();
        data.send(Message::Binary(vec![1u8; MAX_OUTGOING_FRAME + 1].into()))
            .await
            .unwrap();
        let saw_close = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match data.next().await {
                    Some(Ok(Message::Close(_))) | None => break true,
                    Some(Ok(_)) => continue,
                    Some(Err(_)) => break true,
                }
            }
        })
        .await;
        assert!(saw_close.is_ok(), "the mock must abort the oversized frame");

        gateway.stop().await;
    }

    /// Gateway unreachable → no code ever lands, relay stays offline (the
    /// desktop's LAN-only fallback). The bridge keeps retrying in the
    /// background and must stop cleanly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dead_gateway_leaves_relay_offline() {
        let _serial = HOST_SLOT_LOCK.lock().await;
        // Defensive: a panicked earlier test could leave the global slot /
        // code watch dirty.
        host_session_stop().await;
        store_code(None);
        clear_resolution_cache_for_test();
        // Port 9 (discard) — nothing listens there; the manifest fetch and
        // every wss connect refuse fast.
        host_session_start("http://127.0.0.1:9", 1, &"a".repeat(64))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        assert!(!relay_online(), "no gateway → no code → LAN-only fallback");
        assert_eq!(current_relay_code(), None);
        host_session_stop().await;
        assert!(!relay_online());
    }
}
