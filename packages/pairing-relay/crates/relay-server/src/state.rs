//! Shared server state — the in-process stand-ins for the Workers
//! KV/Durable-Object seams (contract §7): the gateway-auth DO becomes a
//! `Mutex<AuthState>`, the per-route channel DOs become
//! `DashMap<String, Arc<ChannelHub>>` hubs with tokio broadcast fan-out,
//! and the KV stores become the SQLite layer (`crate::store`). All
//! POLICY still lives in relay-core; these structures only hold sockets,
//! channels and rows.

use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use relay_core::gateway::AuthState;
use tokio::sync::{broadcast, mpsc};

use crate::config::Config;
use crate::ratelimit::RateLimiter;
use crate::store::Store;

/// The caller's IP for the per-IP budgets and the gateway password
/// lockout. By default (TRUST_PROXY=false) it is the SOCKET address —
/// X-Forwarded-For / X-Real-IP are client-spoofable whenever the
/// server is directly exposed, and a forged header resets every
/// budget. With TRUST_PROXY=true (only valid behind a reverse proxy
/// that OVERWRITES the headers) the X-Real-IP header wins, then the
/// FIRST X-Forwarded-For hop.
pub fn client_ip(
    cfg: &Config,
    headers: &axum::http::HeaderMap,
    addr: std::net::SocketAddr,
) -> String {
    if !cfg.trust_proxy {
        return addr.ip().to_string();
    }
    if let Some(rip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if !rip.trim().is_empty() {
            return rip.trim().to_string();
        }
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            let first = first.trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    addr.ip().to_string()
}

/// Whole-process application state behind an Arc.
pub struct AppState {
    pub cfg: Config,
    pub store: Store,
    /// Stable per-deployment id (32 lowercase hex; contract §2 node.id).
    pub node_id: String,
    /// HTTP client for ALLOWLISTED stats upstreams: same-host redirects
    /// only (§3.2), per-request timeouts and the browser UA.
    pub upstream_http: reqwest::Client,
    /// HTTP client for everything else (peers upstream, peer sync,
    /// Turnstile siteverify, announce liveness callbacks).
    pub plain_http: reqwest::Client,
    /// The gateway-auth DO stand-in: tickets + per-IP password lockout.
    pub auth: Mutex<AuthState>,
    /// The per-route channel DOs stand-in (gateway.rs drives the hubs).
    pub channels: DashMap<String, Arc<ChannelHub>>,
    /// The subscribed upstream server list, refreshed at most 1/60 s
    /// (§5.1).
    pub upstream_peers: tokio::sync::Mutex<Option<UpstreamPeers>>,
    /// Per-IP hourly budgets: /api/lookup/* (§3.5) and announce (§5.2).
    pub lookup_rate: RateLimiter,
    pub announce_rate: RateLimiter,
}

/// Cached copy of the peersUpstream list fetch.
pub struct UpstreamPeers {
    pub fetched_at: std::time::Instant,
    pub peers: Vec<serde_json::Value>,
}

/// CSPRNG over the host OS entropy source — the native side of
/// relay-core's `TicketRng` seam (the worker uses workerd's
/// crypto.getRandomValues via getrandom's wasm_js backend).
pub struct SystemTicketRng;

impl relay_core::gateway::TicketRng for SystemTicketRng {
    fn ticket_bytes(&mut self) -> [u8; 16] {
        let mut buf = [0u8; 16];
        getrandom::fill(&mut buf).expect("host OS entropy source unavailable");
        buf
    }
}

/// One command for a host socket's writer (the hub talks to the live
/// publisher exclusively through this channel).
pub enum HostCommand {
    /// Send one text frame verbatim.
    Frame(String),
    /// Close the socket (one-publisher replacement, oversize frame).
    Close(u16, String),
}

/// One route's fan-out hub: relay-core's `ChannelState` carries the
/// policy (host slot, snapshot retention, sub cap); the broadcast
/// channel fans frames out to subscribers; `host` addresses the live
/// publisher's socket loop.
pub struct ChannelHub {
    pub chan: Mutex<relay_core::gateway::ChannelState>,
    pub host: Mutex<Option<mpsc::UnboundedSender<HostCommand>>>,
    pub fanout: broadcast::Sender<String>,
}

impl ChannelHub {
    pub fn new() -> Self {
        let (fanout, _) = broadcast::channel(1024);
        Self {
            chan: Mutex::new(relay_core::gateway::ChannelState::default()),
            host: Mutex::new(None),
            fanout,
        }
    }
}

impl Default for ChannelHub {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    /// Build the whole state: storage, ids, HTTP clients, hydrated rate
    /// windows, and (when PUBLIC_URL is set) the self row in the local
    /// registry (§5.1 own-table view; the row is private when the URL is
    /// http/IP-literal, §5.3).
    pub fn init(cfg: Config) -> anyhow::Result<Arc<Self>> {
        // reqwest is built with rustls-no-provider: install the ring
        // provider (aws-lc, the default rustls provider, drags in a C/
        // NASM build with nothing to show for it here). Idempotent —
        // every AppState::init and the test binary share one process.
        let _ = rustls::crypto::ring::default_provider().install_default();
        std::fs::create_dir_all(&cfg.data_dir)?;
        let store = Store::open(&cfg.data_dir)?;
        let node_id = load_or_mint_node_id(&cfg)?;
        let lookup_rate = RateLimiter::new("lookup", cfg.lookup_rate_per_hour, 3600, store.clone());
        let announce_rate = RateLimiter::new(
            "announce",
            relay_core::peers::ANNOUNCE_RATE_PER_HOUR.min(u32::MAX as u64) as u32,
            3600,
            store.clone(),
        );

        // Same-host-redirect-only policy for the allowlisted upstream
        // fetches (§3.2): cross-host hops refuse (reqwest error → 502).
        let upstream_http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let previous = attempt.previous();
                if previous.is_empty() {
                    return attempt.follow();
                }
                if previous.len() >= 10 {
                    return attempt.error("too many redirects");
                }
                if attempt.url().host_str() != previous[0].host_str() {
                    attempt.error("cross-host redirect refused")
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        let plain_http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()?;

        let state = Arc::new(Self {
            cfg,
            store,
            node_id,
            upstream_http,
            plain_http,
            auth: Mutex::new(AuthState::new()),
            channels: DashMap::new(),
            upstream_peers: tokio::sync::Mutex::new(None),
            lookup_rate,
            announce_rate,
        });
        state.seed_self_row();
        Ok(state)
    }

    /// Record THIS node in its own registry table so its /api/peers view
    /// leads with itself (an LAN fleet pointing peersUpstream here learns
    /// the node's capabilities + id that way). No-op without PUBLIC_URL.
    /// The URL gates are relay-core's (§5.2 public / §5.3 private).
    fn seed_self_row(&self) {
        let Some(url) = self.cfg.public_url.clone() else {
            return;
        };
        let (url, private) =
            if let Some(normalized) = relay_core::peers::valid_public_peer_url(url.trim()) {
                (normalized, false)
            } else if let Some(normalized) = relay_core::peers::valid_private_peer_url(url.trim()) {
                (normalized, true)
            } else {
                return;
            };
        let now = now_secs();
        let row = relay_core::peers::PeerRow {
            url: url.clone(),
            capabilities: relay_core::manifest::CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true,
            },
            role: self.cfg.role.clone(),
            node_id: self.node_id.clone(),
            added_at: now as u64,
            last_seen_at: now as u64,
            notice: self.cfg.notice.clone(),
            private,
        };
        self.store.put_peer(&row, now);
    }

    /// Unix seconds.
    pub fn now(&self) -> i64 {
        now_secs()
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Load (or mint once) the 32-hex node id from the data-dir file
/// (contract §2: stable per deployment, random, persisted; not a secret).
fn load_or_mint_node_id(cfg: &Config) -> anyhow::Result<String> {
    let path = cfg.data_dir.join(&cfg.node_id_file);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let id = text.trim().to_ascii_lowercase();
        if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(id);
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("host OS entropy source unavailable");
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(&path, &id)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_is_minted_once_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::default();
        cfg.data_dir = dir.path().to_path_buf();
        let a = load_or_mint_node_id(&cfg).unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        // Second load over the same file returns the SAME id.
        let b = load_or_mint_node_id(&cfg).unwrap();
        assert_eq!(a, b);
        // A corrupt file re-mints rather than failing.
        std::fs::write(dir.path().join(&cfg.node_id_file), "garbage").unwrap();
        let c = load_or_mint_node_id(&cfg).unwrap();
        assert_eq!(c.len(), 32);
        assert_ne!(a, c);
    }

    #[test]
    fn client_ip_ignores_proxy_headers_unless_trusted() {
        let addr: std::net::SocketAddr = "203.0.113.5:1234".parse().unwrap();
        let mut cfg = crate::config::Config::default();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            axum::http::HeaderValue::from_str("198.51.100.7, 203.0.113.1").unwrap(),
        );
        headers.insert(
            "x-real-ip",
            axum::http::HeaderValue::from_str("192.0.2.9").unwrap(),
        );
        // Default: spoofable headers are ignored — the socket address.
        assert_eq!(client_ip(&cfg, &headers, addr), "203.0.113.5");
        // Opt-in (behind an overwriting proxy): X-Real-IP wins…
        cfg.trust_proxy = true;
        assert_eq!(client_ip(&cfg, &headers, addr), "192.0.2.9");
        // …then the first X-Forwarded-For hop.
        headers.remove("x-real-ip");
        assert_eq!(client_ip(&cfg, &headers, addr), "198.51.100.7");
        // No headers at all → the socket address either way.
        headers.clear();
        assert_eq!(client_ip(&cfg, &headers, addr), "203.0.113.5");
    }
}
