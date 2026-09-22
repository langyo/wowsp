//! LAN auto-discovery for mobile pairing: the desktop announces itself, the
//! phone listens — nobody types an IP or a port anymore.
//!
//! Two halves, one protocol:
//!
//! - **BROADCASTER (desktop, `#[cfg(desktop)]`)** — while the pairing server
//!   runs, a task sends one JSON datagram every [`BROADCAST_INTERVAL`] to
//!   `255.255.255.255:[DISCOVERY_PORT]`:
//!
//!   ```json
//!   {"magic":"wowsp-pairing-v1","name":"DESKTOP-PC","port":58041}
//!   ```
//!
//!   (a `relay` field is reserved but currently always omitted — the
//!   phone's built-in gateway constant makes advertising it unnecessary.)
//!   The task's lifecycle is exactly the server's: started from
//!   `pairing_start`, stopped from `pairing_stop` — no leaks across restarts.
//!
//! - **LISTENER (all targets)** — `pairing_discovery_start` /
//!   `pairing_discovery_stop` run a UDP listener on `0.0.0.0:58042` that
//!   validates the magic, keys entries by `(peer IP, port)` — the peer IP
//!   comes from the datagram envelope, never from the payload, so a spoofed
//!   `host` field cannot route the phone anywhere — tracks last-seen times,
//!   drops entries silent for more than [`HOST_TTL`], and pushes the full
//!   current list on `wowsp://pairing-discovery` whenever it changes
//!   (throttled to ~1 Hz). The frontend MUST stop the listener when the
//!   wizard closes (the stop command also does it, belt-and-braces).
//!
//! Both directions share the pure core below ([`parse_broadcast`],
//! [`DiscoveryTable`]) so the behavior is unit-testable without sockets.

use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{DiscoveredHost, DiscoverySnapshot};

/// UDP port the broadcaster targets and the listener binds. Distinct from
/// the pairing HTTP port (58041) so a desktop can run both roles at once.
pub const DISCOVERY_PORT: u16 = 58042;
/// Magic prefix every valid datagram carries — junk (other apps' broadcasts,
/// port scans) is dropped before any JSON parse.
pub const DISCOVERY_MAGIC: &str = "wowsp-pairing-v1";
/// Broadcast cadence — fast enough that a freshly-opened wizard fills within
/// ~2 s, slow enough to be invisible on a LAN.
pub const BROADCAST_INTERVAL: Duration = Duration::from_secs(2);
/// A host whose last broadcast is older than this falls off the list (two
/// missed broadcasts + slack).
pub const HOST_TTL: Duration = Duration::from_secs(7);
/// Emission throttle: identical-looking churn (lastSeenAgeSec ticking) must
/// not flood the webview; only real membership changes are pushed, at most
/// once per this window.
pub const EMIT_THROTTLE: Duration = Duration::from_millis(1000);
/// Event channel the listener pushes [`DiscoverySnapshot`] snapshots on.
pub const DISCOVERY_EVENT: &str = "wowsp://pairing-discovery";

/// The broadcast payload. `relay` is a reserved display-only field — the
/// phone's built-in gateway constant makes advertising it unnecessary, so
/// broadcasts currently always omit it (kept for forward compatibility).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastPayload {
    pub magic: String,
    pub name: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
}

/// Parse one broadcast datagram. Anything without the exact magic, a sane
/// name (≤ 64 chars, no control characters) and a non-reserved port is junk
/// → None.
pub fn parse_broadcast(bytes: &[u8]) -> Option<BroadcastPayload> {
    let payload = serde_json::from_slice::<BroadcastPayload>(bytes).ok()?;
    if payload.magic != DISCOVERY_MAGIC {
        return None;
    }
    let name = payload.name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(|c| c.is_control()) {
        return None;
    }
    if payload.port == 0 {
        return None;
    }
    Some(BroadcastPayload {
        magic: payload.magic,
        name: name.to_string(),
        port: payload.port,
        // A claimed relay URL is display-only aid on the phone; it is never
        // connected to without the user confirming it in internet mode.
        relay: payload
            .relay
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty()),
    })
}

/// Mutable discovery state behind the listener loop (pure, unit-testable):
/// entries keyed by `(peer IP, port)`, pruned by silence, snapshot-ed for
/// the event, and an emit throttle gate.
#[derive(Default)]
pub struct DiscoveryTable {
    entries: Vec<TableEntry>,
    last_emit: Option<std::time::Instant>,
    dirty: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct TableEntry {
    host: String,
    port: u16,
    name: String,
    last_seen: std::time::Instant,
    relay: Option<String>,
}

impl DiscoveryTable {
    /// Record a broadcast from `peer` (its IP is the routing truth). A known
    /// (host, port) refreshes last-seen and re-learns the name; unknown pairs
    /// are appended.
    pub fn observe(&mut self, peer: SocketAddr, payload: &BroadcastPayload) {
        let host = peer.ip().to_string();
        let now = std::time::Instant::now();
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.host == host && e.port == payload.port)
        {
            e.name = payload.name.clone();
            e.relay = payload.relay.clone();
            e.last_seen = now;
        } else {
            self.entries.push(TableEntry {
                host,
                port: payload.port,
                name: payload.name.clone(),
                last_seen: now,
                relay: payload.relay.clone(),
            });
        }
        self.dirty = true;
    }

    /// Drop hosts silent for longer than [`HOST_TTL`].
    pub fn prune(&mut self) {
        let before = self.entries.len();
        let now = std::time::Instant::now();
        self.entries
            .retain(|e| now.duration_since(e.last_seen) <= HOST_TTL);
        if self.entries.len() != before {
            self.dirty = true;
        }
    }

    /// Current list, oldest-seen first (stable ordering keeps the UI list
    /// from jumping around between snapshots).
    pub fn snapshot(&self) -> DiscoverySnapshot {
        let mut hosts: Vec<DiscoveredHost> = self
            .entries
            .iter()
            .map(|e| DiscoveredHost {
                host: e.host.clone(),
                port: e.port,
                name: e.name.clone(),
                last_seen_age_sec: e.last_seen.elapsed().as_secs(),
                relay: e.relay.clone(),
            })
            .collect();
        hosts.sort_by(|a, b| a.host.cmp(&b.host).then(a.port.cmp(&b.port)));
        DiscoverySnapshot { hosts }
    }

    /// Whether a snapshot should be pushed now: something changed AND the
    /// throttle window has elapsed.
    pub fn should_emit(&mut self) -> bool {
        if !self.dirty {
            return false;
        }
        let now = std::time::Instant::now();
        if let Some(t) = self.last_emit {
            if now.duration_since(t) < EMIT_THROTTLE {
                return false;
            }
        }
        self.last_emit = Some(now);
        self.dirty = false;
        true
    }

    /// Entry count (test surface).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

// ── desktop broadcaster ──────────────────────────────────────────────────────

/// The desktop's own advertised name: hostname env vars first (both shells
/// set them), then a fixed fallback — no new dependency for a label.
#[cfg(desktop)]
fn computer_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "WoWSP Desktop".to_string());
    let name = name.trim();
    if name.is_empty() {
        "WoWSP Desktop".to_string()
    } else {
        name.chars().take(64).collect()
    }
}

#[cfg(desktop)]
struct BroadcastState {
    /// Server port the datagrams advertise (diagnostics only; the payload
    /// was built from it at start).
    #[allow(dead_code)]
    port: u16,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[cfg(desktop)]
fn broadcast_state() -> &'static Mutex<Option<BroadcastState>> {
    static ST: OnceLock<Mutex<Option<BroadcastState>>> = OnceLock::new();
    ST.get_or_init(|| Mutex::new(None))
}

/// Start the UDP broadcaster (desktop server lifecycle hook). Idempotent: a
/// running broadcaster is left alone — the caller restarts it only through
/// an explicit [`broadcast_stop`] first (server stop/start does exactly that).
#[cfg(desktop)]
pub fn broadcast_start(port: u16, relay_url: Option<String>) -> Result<(), String> {
    let mut st = broadcast_state().lock().unwrap_or_else(|p| p.into_inner());
    if st.is_some() {
        return Ok(());
    }
    let socket = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("bind discovery broadcaster: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("discovery broadcast flag: {e}"))?;
    // Nonblocking is what tokio's from_std adoption requires; the socket
    // is only ever written to, so no read timeout applies.
    socket.set_nonblocking(true).ok();
    let socket = tokio::net::UdpSocket::from_std(socket)
        .map_err(|e| format!("adopt discovery broadcaster: {e}"))?;

    let payload = BroadcastPayload {
        magic: DISCOVERY_MAGIC.to_string(),
        name: computer_name(),
        port,
        relay: relay_url,
    };
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    let target = (std::net::Ipv4Addr::BROADCAST, DISCOVERY_PORT);

    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(BROADCAST_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = rx.changed() => break,
                _ = interval.tick() => {
                    // Fire and forget: a LAN with no listener drops this on
                    // the floor; failures (no route to broadcast on some
                    // VPNs) are logged once per attempt and never fatal.
                    if let Err(e) = socket.send_to(&bytes, target).await {
                        tracing::debug!(error = %e, "discovery broadcast send failed");
                    }
                },
            }
        }
    });
    *st = Some(BroadcastState {
        port,
        shutdown: tx,
        task,
    });
    tracing::info!(
        port,
        discovery_port = DISCOVERY_PORT,
        "discovery broadcaster started"
    );
    Ok(())
}

/// Stop the broadcaster (server stop / restart race cleanup).
#[cfg(desktop)]
pub async fn broadcast_stop() {
    let joined = broadcast_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(st) = joined {
        let _ = st.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), st.task).await;
        tracing::info!("discovery broadcaster stopped");
    }
}

// ── listener commands (all targets — the phone runs this; a desktop pairing
//    to another desktop may too) ───────────────────────────────────────────────

struct ListenerState {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

fn listener_state() -> &'static Mutex<Option<ListenerState>> {
    static ST: OnceLock<Mutex<Option<ListenerState>>> = OnceLock::new();
    ST.get_or_init(|| Mutex::new(None))
}

/// Start the discovery listener. Idempotent while running. The emitted
/// snapshots land on [`DISCOVERY_EVENT`]; the caller (wizard) must call
/// `pairing_discovery_stop` on close.
#[tauri::command]
pub fn pairing_discovery_start(app: AppHandle) -> Result<(), String> {
    let mut st = listener_state().lock().unwrap_or_else(|p| p.into_inner());
    if st.is_some() {
        return Ok(());
    }
    let socket = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT))
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("discovery port {DISCOVERY_PORT} is already in use")
            } else {
                format!("bind discovery listener: {e}")
            }
        })?;
    // tokio's from_std adoption requires a nonblocking socket; recv_from
    // then parks on readiness, so no read timeout is involved.
    socket
        .set_nonblocking(true)
        .map_err(|e| format!("discovery listener nonblocking: {e}"))?;
    let socket = tokio::net::UdpSocket::from_std(socket)
        .map_err(|e| format!("adopt discovery listener: {e}"))?;

    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let mut table = DiscoveryTable::default();
        // recv_from parks until a datagram arrives (readiness-driven), so
        // the shutdown watch in the select stays live between datagrams.
        let mut buf = [0u8; 1024];
        loop {
            tokio::select! {
                _ = rx.changed() => break,
                res = socket.recv_from(&mut buf) => {
                    match res {
                        Ok((n, peer)) => {
                            if let Some(payload) = parse_broadcast(&buf[..n]) {
                                table.observe(peer, &payload);
                            }
                        },
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            // Defensive: tokio's readiness-driven recv_from
                            // reports "pending" instead of WouldBlock, so
                            // this arm only exists to keep any future
                            // spurious WouldBlock from spinning.
                        },
                        Err(e) => {
                            tracing::debug!(error = %e, "discovery recv failed");
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        },
                    }
                },
            }
            table.prune();
            if table.should_emit() {
                let _ = app.emit(DISCOVERY_EVENT, table.snapshot());
            } else {
                // Hold the CPU back even when nothing changed.
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        tracing::info!("discovery listener stopped");
    });
    *st = Some(ListenerState { shutdown: tx, task });
    tracing::info!(port = DISCOVERY_PORT, "discovery listener started");
    Ok(())
}

/// Stop the discovery listener and release the port. Graceful first
/// (the task parks on the shutdown watch between datagrams), with an
/// abort fallback so a wedged loop can never pin the port.
#[tauri::command]
pub async fn pairing_discovery_stop() -> Result<(), String> {
    let joined = listener_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(st) = joined {
        let _ = st.shutdown.send(true);
        let mut task = st.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task)
            .await
            .is_err()
        {
            task.abort();
            tracing::warn!("discovery listener loop overran its stop budget — aborted");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn payload_json(name: &str, port: u16) -> Vec<u8> {
        serde_json::to_vec(&BroadcastPayload {
            magic: DISCOVERY_MAGIC.to_string(),
            name: name.to_string(),
            port,
            relay: None,
        })
        .unwrap()
    }

    fn peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)), 53511)
    }

    #[test]
    fn broadcast_payload_round_trips() {
        let p = parse_broadcast(&payload_json("DESKTOP-ABC", 58041)).unwrap();
        assert_eq!(p.name, "DESKTOP-ABC");
        assert_eq!(p.port, 58041);
        assert_eq!(p.relay, None);

        // With the optional relay field.
        let bytes = serde_json::to_vec(&BroadcastPayload {
            magic: DISCOVERY_MAGIC.to_string(),
            name: "PC".into(),
            port: 58041,
            relay: Some("https://wowsp-pairing.example.workers.dev".into()),
        })
        .unwrap();
        let p = parse_broadcast(&bytes).unwrap();
        assert_eq!(
            p.relay.as_deref(),
            Some("https://wowsp-pairing.example.workers.dev")
        );
    }

    #[test]
    fn broadcast_junk_is_rejected() {
        // Wrong magic (another app's payload).
        let bytes = br#"{"magic":"sonos","name":"x","port":1}"#;
        assert!(parse_broadcast(bytes).is_none());
        // Not JSON.
        assert!(parse_broadcast(b"hello").is_none());
        // Missing fields.
        assert!(parse_broadcast(br#"{"magic":"wowsp-pairing-v1"}"#).is_none());
        // Zero port.
        assert!(parse_broadcast(&payload_json("PC", 0)).is_none());
        // Empty / control-char / oversized names.
        assert!(parse_broadcast(&payload_json("   ", 58041)).is_none());
        assert!(parse_broadcast(&payload_json("bad\nname", 58041)).is_none());
        assert!(parse_broadcast(&payload_json(&"x".repeat(65), 58041)).is_none());
    }

    #[test]
    fn table_dedupes_by_host_and_port() {
        let mut t = DiscoveryTable::default();
        let p1 = parse_broadcast(&payload_json("FIRST", 58041)).unwrap();
        let p2 = parse_broadcast(&payload_json("SECOND", 58041)).unwrap();
        t.observe(peer(), &p1);
        t.observe(peer(), &p2);
        assert_eq!(t.len(), 1, "same (host, port) must refresh, not duplicate");
        let snap = t.snapshot();
        assert_eq!(snap.hosts.len(), 1);
        assert_eq!(snap.hosts[0].name, "SECOND");
        assert_eq!(snap.hosts[0].host, "192.0.2.10");

        // A different port is a different server.
        t.observe(
            peer(),
            &parse_broadcast(&payload_json("SECOND", 1234)).unwrap(),
        );
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn table_emits_only_on_change_and_throttles() {
        let mut t = DiscoveryTable::default();
        assert!(!t.should_emit(), "nothing observed → nothing emitted");
        t.observe(
            peer(),
            &parse_broadcast(&payload_json("PC", 58041)).unwrap(),
        );
        assert!(t.should_emit(), "first observation is a change");
        assert!(!t.should_emit(), "throttled inside the window");
        assert!(!t.should_emit());
        // Time travel past the throttle: still no emit without a change.
        t.last_emit = Some(std::time::Instant::now() - EMIT_THROTTLE - Duration::from_millis(1));
        assert!(!t.should_emit(), "no change → no emit even past the window");
    }

    #[test]
    fn table_prunes_silent_hosts() {
        let mut t = DiscoveryTable::default();
        t.observe(
            peer(),
            &parse_broadcast(&payload_json("PC", 58041)).unwrap(),
        );
        // Not yet silent.
        t.prune();
        assert_eq!(t.len(), 1);
        // Silent past the TTL.
        t.entries[0].last_seen = std::time::Instant::now() - HOST_TTL - Duration::from_secs(1);
        t.prune();
        assert_eq!(t.len(), 0, "silent host must fall off the list");
        assert!(t.should_emit(), "the drop is a change worth emitting");
    }
}
