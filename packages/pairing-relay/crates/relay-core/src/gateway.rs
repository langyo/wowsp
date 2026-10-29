//! Pure policy for the `/gateway/*` account-routed push namespace (the
//! mobile-gateway wave; the authoritative design contract is
//! docs/en/designs/gateway-push.md).
//!
//! Everything here is plain Rust over an injected clock and RNG — the
//! same discipline as [`crate::directory`]: no Cloudflare types, no
//! I/O, fully unit-tested on the host. `relay-worker` (src/gateway.rs)
//! owns the HTTP/WS plumbing plus the two Durable Objects that hydrate
//! these state machines from storage and write every mutation back:
//!
//! - **Health document** — [`health_doc`] renders the deployment config
//!   clients resolve before anything else: which credentials
//!   `/gateway/session` will demand (Turnstile and/or password) and
//!   the minimum client version (contract §3.1).
//! - **Route ids** — [`valid_route_id`] pins the `r:<realm>:<accountId>`
//!   channel id shape with constant-bound scanning (no regex crate).
//! - **Tickets** — [`AuthState`] mints CSPRNG 32-hex tickets bound to
//!   one route with a 120 s TTL and spends each exactly once at the
//!   first WS upgrade (contract §3.2).
//! - **Password lockout** — 5 failed passwords inside a sliding 60 s
//!   window (per client IP) lock the IP for 300 s.
//! - **Channel policy** — [`ChannelState`] carries the one-publisher
//!   rule (a second host with a different persistent host id replaces
//!   the first — the same replacement policy as the directory's
//!   one-code rule), the 64 KiB battle frame cap, last-snapshot
//!   retention (battle lifetime + 5 min grace; a 30 min cap bounds a
//!   host that never sends `bye`), and the 32-subscriber ceiling
//!   (contract §3.3).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The one gateway push protocol version (the health document's and the
/// WS `hello` frame's `gateway` field).
pub const GATEWAY_PROTOCOL_V1: &str = "v1";

/// Minimum client version the gateway namespace serves (health document
/// `minClientVersion`). Bump deliberately, like the relay's
/// `MIN_CLIENT_VERSION`: clients below it get the update-your-app path.
pub const GATEWAY_MIN_CLIENT_VERSION: &str = "0.6.8";

/// Ticket lifetime — single-use, consumed at the first WS upgrade.
pub const TICKET_TTL_MS: u64 = 120_000;
/// Tickets are 16 CSPRNG bytes rendered as 32 lowercase hex chars.
pub const TICKET_HEX_LEN: usize = 32;
/// Mint attempts before falling back to overwriting a collision (a
/// 128-bit CSPRNG collision twice in a row is unreachable; the fallback
/// only exists so minting can never fail).
pub const MINT_ATTEMPTS: usize = 16;

/// Sliding window in which password failures are counted per client IP.
pub const PASSWORD_WINDOW_MS: u64 = 60_000;
/// Failures inside the window that trip the lock — the 5th failure locks.
pub const PASSWORD_MAX_FAILURES: usize = 5;
/// How long a tripped IP lock lasts.
pub const PASSWORD_LOCK_MS: u64 = 300_000;

/// Hard cap on one battle text frame crossing a pub socket. Larger
/// frames are rejected with close code 1009 (contract §3.3).
pub const MAX_BATTLE_FRAME_BYTES: usize = 64 * 1024;
/// How long the last battle snapshot survives after `bye` (a phone
/// reconnecting right at battle end still sees the final state).
pub const SNAPSHOT_GRACE_MS: u64 = 5 * 60_000;
/// Retention cap counted from the last publish when `bye` never arrives
/// (battles run ~20 min; the cap bounds a crashed host's snapshot).
pub const SNAPSHOT_MAX_MS: u64 = 30 * 60_000;
/// KV mirror TTL for the `battle:<route>` row (contract §3.3: 1 h).
pub const SNAPSHOT_KV_TTL_SECS: u64 = 3600;
/// Live subscribers one channel serves; the 33rd is refused.
pub const MAX_SUBSCRIBERS: usize = 32;
/// Keepalive cadence both directions (Cloudflare drops idle proxied
/// sockets at ~100 s, same math as the code-relay sockets).
pub const KEEPALIVE_INTERVAL_MS: u64 = 30_000;

// ── channel ids ────────────────────────────────────────────────────────

/// A channel id: `r:<realm>:<accountId>` with a 2–5 lowercase-ASCII
/// realm and 1–19 ASCII digits of account id (contract §2; real ids are
/// ~9–10 digits, so the digit bound only stops pathological lengths).
/// Constant-bound scanning — a regex crate is not worth a dependency.
pub fn valid_route_id(route: &str) -> bool {
    let Some(rest) = route.strip_prefix("r:") else {
        return false;
    };
    let Some((realm, account)) = rest.split_once(':') else {
        return false;
    };
    (2..=5).contains(&realm.len())
        && realm.bytes().all(|b| b.is_ascii_lowercase())
        && !account.is_empty()
        && account.len() <= 19
        && account.bytes().all(|b| b.is_ascii_digit())
}

/// A session ticket is exactly 32 lowercase hex chars (minted by
/// `/gateway/session`; the shape is checked again at the upgrade so a
/// malformed query never reaches the auth Durable Object).
pub fn valid_ticket(ticket: &str) -> bool {
    ticket.len() == TICKET_HEX_LEN
        && ticket
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ── health document (contract §3.1) ────────────────────────────────────

/// Deployment config derived from worker vars/secrets. Built by the
/// worker via `GatewayVars::from_raw`; drives both the health document
/// and the /session credential checks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GatewayVars {
    /// `GATEWAY_TURNSTILE_SITEKEY` (falling back to the feedback
    /// pipeline's `TURNSTILE_SITEKEY` on the official deployment).
    /// `None`/empty ⇒ Turnstile off.
    pub turnstile_sitekey: Option<String>,
    /// `true` iff the `GATEWAY_PASSWORD` secret is present.
    pub password_required: bool,
    /// `GATEWAY_NOTICE` — free-form operator message (reuses the relay
    /// health doc's var).
    pub notice: Option<String>,
}

impl GatewayVars {
    /// Build from raw environment strings; blank values mean "off".
    pub fn from_raw(sitekey: Option<&str>, password_required: bool, notice: Option<&str>) -> Self {
        Self {
            turnstile_sitekey: sitekey
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            password_required,
            notice: notice
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        }
    }

    /// Turnstile is demanded iff a sitekey is configured.
    pub fn turnstile_required(&self) -> bool {
        self.turnstile_sitekey.is_some()
    }
}

/// `GET /gateway/health` reply — the gateway push namespace's config
/// document (no auth; CORS-open; edge-cached 60 s by the worker).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDoc {
    /// Protocol dialect marker (`"v1"`).
    pub gateway: String,
    /// Minimum client (`x.y.z`) this namespace serves.
    pub min_client_version: String,
    /// Which credentials `/gateway/session` will demand.
    pub auth: HealthAuth,
    /// Optional operator notice (`null` in the common case).
    pub notice: Option<String>,
}

/// Credential demands of the health document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthAuth {
    pub turnstile: HealthTurnstile,
    pub password: HealthPassword,
}

/// Turnstile demand. `sitekey` is omitted entirely when Turnstile is
/// off (a client must not render a challenge for a `null` key).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthTurnstile {
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sitekey: Option<String>,
}

/// Password demand (presence of the `GATEWAY_PASSWORD` secret).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthPassword {
    pub required: bool,
}

/// The health document for the given deployment config.
pub fn health_doc(vars: &GatewayVars) -> HealthDoc {
    HealthDoc {
        gateway: GATEWAY_PROTOCOL_V1.to_string(),
        min_client_version: GATEWAY_MIN_CLIENT_VERSION.to_string(),
        auth: HealthAuth {
            turnstile: HealthTurnstile {
                required: vars.turnstile_required(),
                sitekey: vars.turnstile_sitekey.clone(),
            },
            password: HealthPassword {
                required: vars.password_required,
            },
        },
        notice: vars.notice.clone(),
    }
}

// ── /gateway/session credential policy (contract §3.2) ─────────────────

/// Which demanded credential is missing from a /session request. The
/// worker maps these to 400s before any network verification happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialMissing {
    /// Health demands a Turnstile token; none arrived.
    Turnstile,
    /// Health demands a password; none arrived.
    Password,
}

/// Verify the PRESENCE of exactly what the health document demands
/// (the Turnstile siteverify round trip and the password compare are
/// I/O and live in the worker; extra credentials are ignored — "either
/// credential may be omitted when not required").
pub fn check_credentials(
    vars: &GatewayVars,
    turnstile_token: Option<&str>,
    password: Option<&str>,
) -> Result<(), CredentialMissing> {
    let present = |v: Option<&str>| v.map(str::trim).is_some_and(|s| !s.is_empty());
    if vars.turnstile_required() && !present(turnstile_token) {
        return Err(CredentialMissing::Turnstile);
    }
    if vars.password_required && !present(password) {
        return Err(CredentialMissing::Password);
    }
    Ok(())
}

/// Length-checking constant-time-ish compare for the gateway password —
/// network jitter already dwarfs the timing signal; this is hygiene,
/// not a hard guarantee (same stance as the feedback pipeline's bypass).
pub fn password_matches(expected: &str, given: &str) -> bool {
    expected.len() == given.len()
        && expected
            .bytes()
            .zip(given.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Which credentials a ticket was minted against (recorded on the entry
/// for audit; consume enforces the route binding).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketKind {
    /// Neither credential demanded (open self-host node).
    None,
    /// Turnstile only.
    Turnstile,
    /// Password only.
    Password,
    /// Both.
    Both,
}

impl TicketKind {
    /// The query-string spelling used on the auth DO's /mint route.
    pub fn as_str(self) -> &'static str {
        match self {
            TicketKind::None => "none",
            TicketKind::Turnstile => "turnstile",
            TicketKind::Password => "password",
            TicketKind::Both => "both",
        }
    }

    /// From the flags the worker verified during /session.
    pub fn from_flags(turnstile: bool, password: bool) -> Self {
        match (turnstile, password) {
            (true, true) => TicketKind::Both,
            (true, false) => TicketKind::Turnstile,
            (false, true) => TicketKind::Password,
            (false, false) => TicketKind::None,
        }
    }
}

impl std::str::FromStr for TicketKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "none" => Ok(TicketKind::None),
            "turnstile" => Ok(TicketKind::Turnstile),
            "password" => Ok(TicketKind::Password),
            "both" => Ok(TicketKind::Both),
            _ => Err(()),
        }
    }
}

// ── tickets + password lockout (the GatewayAuth DO's state) ────────────

/// Randomness source for ticket minting; the worker implements this over
/// `getrandom` (workerd's `crypto.getRandomValues`), tests replay a
/// scripted sequence.
pub trait TicketRng {
    /// 16 fresh CSPRNG bytes.
    fn ticket_bytes(&mut self) -> [u8; 16];
}

/// One minted ticket (persisted as `t:<ticket>` in the auth DO).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TicketEntry {
    /// The channel id this ticket may upgrade on.
    pub route: String,
    /// Which credentials were verified to mint it.
    pub kind: TicketKind,
    /// Absolute expiry (ms since epoch).
    pub expires_at: u64,
}

/// Why a ticket could not be spent. `Unknown` deliberately covers
/// malformed, long-gone and already-consumed tickets alike (no oracle
/// about other sessions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsumeError {
    /// Never minted, already spent, or non-existent.
    Unknown,
    /// Minted but past its TTL.
    Expired,
    /// Minted for a different channel.
    RouteMismatch,
}

/// Per-IP password failure bookkeeping (persisted as `p:<ip>`). Same
/// sliding-window shape as the directory's `RateState`, different
/// parameters: 5 failures / 60 s → 300 s lock.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PasswordRate {
    /// Timestamps of recent failed passwords (bounded, pruned to the
    /// sliding window).
    pub failures: Vec<u64>,
    /// Absolute time (ms) until which the IP is refused outright.
    pub locked_until: Option<u64>,
}

impl PasswordRate {
    /// Nothing worth persisting (the DO deletes such rows).
    pub fn is_empty(&self) -> bool {
        self.failures.is_empty() && self.locked_until.is_none()
    }

    /// When the row stops mattering: its lock lifts and its newest
    /// failure leaves the window. `None` for an empty row.
    pub fn dead_at(&self) -> Option<u64> {
        let block = self.locked_until;
        let window = self.failures.iter().map(|t| t + PASSWORD_WINDOW_MS).max();
        block.max(window)
    }

    /// Remaining lock (ms) at `now_ms`, pruning the window first.
    /// `None` when not locked.
    pub fn lock_remaining_ms(&mut self, now_ms: u64) -> Option<u64> {
        self.prune(now_ms);
        self.locked_until
            .filter(|until| *until > now_ms)
            .map(|until| until - now_ms)
    }

    /// Drop failures that slid out of the window and lift expired locks.
    fn prune(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(PASSWORD_WINDOW_MS);
        self.failures.retain(|t| *t > cutoff);
        if self.locked_until.is_some_and(|until| until <= now_ms) {
            self.locked_until = None;
        }
    }
}

/// Storage key for a ticket binding.
pub fn ticket_key(ticket: &str) -> String {
    format!("t:{ticket}")
}

/// Storage key for an IP's password rate row.
pub fn password_key(ip: &str) -> String {
    format!("p:{ip}")
}

/// The auth DO's whole state: live tickets + per-IP password rates.
/// Hydrated from storage on first use, write-through on every mutation
/// (the worker module), exactly like the code directory.
#[derive(Debug, Clone, Default)]
pub struct AuthState {
    tickets: HashMap<String, TicketEntry>,
    passwords: HashMap<String, PasswordRate>,
}

impl AuthState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rehydrate from persisted rows.
    pub fn restore(
        tickets: impl IntoIterator<Item = (String, TicketEntry)>,
        passwords: impl IntoIterator<Item = (String, PasswordRate)>,
    ) -> Self {
        Self {
            tickets: tickets.into_iter().collect(),
            passwords: passwords.into_iter().collect(),
        }
    }

    /// Mint a single-use ticket for `route` (TTL
    /// [`TICKET_TTL_MS`], bound to the route, credential kind
    /// recorded). CSPRNG collisions after [`MINT_ATTEMPTS`] redraws
    /// are unreachable; the final fallback overwrites rather than fail.
    pub fn mint(
        &mut self,
        now_ms: u64,
        rng: &mut dyn TicketRng,
        route: &str,
        kind: TicketKind,
    ) -> (String, TicketEntry) {
        let mut ticket = String::new();
        for _ in 0..MINT_ATTEMPTS {
            let candidate = hex_ticket(&rng.ticket_bytes());
            if !self.tickets.contains_key(&candidate) {
                ticket = candidate;
                break;
            }
        }
        if ticket.is_empty() {
            ticket = hex_ticket(&rng.ticket_bytes());
        }
        let entry = TicketEntry {
            route: route.to_string(),
            kind,
            expires_at: now_ms + TICKET_TTL_MS,
        };
        self.tickets.insert(ticket.clone(), entry.clone());
        (ticket, entry)
    }

    /// Spend a ticket at the WS upgrade. Single-use no matter the
    /// outcome: the row is removed first, so an expired or mismatched
    /// attempt burns it too (no retries, no probing).
    pub fn consume(&mut self, now_ms: u64, ticket: &str, route: &str) -> Result<(), ConsumeError> {
        let Some(entry) = self.tickets.remove(ticket) else {
            return Err(ConsumeError::Unknown);
        };
        if entry.expires_at <= now_ms {
            return Err(ConsumeError::Expired);
        }
        if entry.route != route {
            return Err(ConsumeError::RouteMismatch);
        }
        Ok(())
    }

    /// Remaining password lock (ms) for `ip`, `None` when open. Prunes
    /// the row's window (the caller persists changed rows).
    pub fn lock_remaining(&mut self, now_ms: u64, ip: &str) -> Option<u64> {
        self.passwords
            .get_mut(ip)
            .and_then(|row| row.lock_remaining_ms(now_ms))
    }

    /// Record a failed password from `ip`. Returns the remaining lock
    /// (ms) when this failure leaves the IP locked — the 5th failure
    /// inside the window trips it — else `None`.
    pub fn password_failed(&mut self, now_ms: u64, ip: &str) -> Option<u64> {
        let row = self.passwords.entry(ip.to_string()).or_default();
        if let Some(remaining) = row.lock_remaining_ms(now_ms) {
            // Defensive: a locked IP never reaches the password check
            // (the gate refuses first); if it does, the attempt costs
            // nothing extra but reports the standing lock.
            return Some(remaining);
        }
        row.failures.push(now_ms);
        row.prune(now_ms);
        if row.failures.len() >= PASSWORD_MAX_FAILURES {
            row.locked_until = Some(now_ms + PASSWORD_LOCK_MS);
            row.failures.clear();
        }
        row.lock_remaining_ms(now_ms)
    }

    /// Persisted view of an IP's rate row (worker write-through).
    pub fn password_row(&self, ip: &str) -> Option<&PasswordRate> {
        self.passwords.get(ip)
    }

    /// Drop dead rows (expired tickets, stale password rates). Returns
    /// the storage keys removed plus the next sweep deadline.
    pub fn sweep(&mut self, now_ms: u64) -> (Vec<String>, Option<u64>) {
        let dead_tickets: Vec<String> = self
            .tickets
            .iter()
            .filter(|(_, e)| e.expires_at <= now_ms)
            .map(|(t, _)| t.clone())
            .collect();
        let mut removed = Vec::new();
        for ticket in &dead_tickets {
            self.tickets.remove(ticket);
            removed.push(ticket_key(ticket));
        }
        let dead_rows: Vec<String> = self
            .passwords
            .iter()
            .filter(|(_, row)| password_row_is_dead(row, now_ms))
            .map(|(ip, _)| ip.clone())
            .collect();
        for ip in &dead_rows {
            self.passwords.remove(ip);
            removed.push(password_key(ip));
        }
        (removed, self.next_deadline())
    }

    /// Earliest moment a sweep has work to do.
    pub fn next_deadline(&self) -> Option<u64> {
        self.tickets
            .values()
            .map(|e| e.expires_at)
            .chain(self.passwords.values().filter_map(PasswordRate::dead_at))
            .min()
    }

    /// Number of live tickets (tests / diagnostics).
    pub fn len(&self) -> usize {
        self.tickets.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tickets.is_empty()
    }
}

/// Whether a password row has nothing live left (sweep predicate).
fn password_row_is_dead(row: &PasswordRate, now_ms: u64) -> bool {
    let lock_live = row.locked_until.is_some_and(|until| now_ms < until);
    let cutoff = now_ms.saturating_sub(PASSWORD_WINDOW_MS);
    !lock_live && row.failures.iter().all(|t| *t <= cutoff)
}

/// 16 bytes → 32 lowercase hex chars.
fn hex_ticket(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(TICKET_HEX_LEN);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    out
}

// ── channel policy (the GatewayChannel DO's state) ─────────────────────

/// The last battle snapshot retained for mid-battle joiners (persisted
/// as the channel DO's single `snap` row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotRow {
    /// The battle frame verbatim (its JSON text).
    pub frame: String,
    /// Absolute expiry (ms since epoch) of the retention window.
    pub expires_at: u64,
}

/// Why a subscriber was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubError {
    /// The channel already holds [`MAX_SUBSCRIBERS`] live subscribers.
    Full,
}

/// One channel's policy state. The DO keeps the actual `WebSocket`
/// handles in its own struct and consults this for every decision,
/// mirroring how the Room DO uses [`crate::room::RoomConns`].
#[derive(Debug, Default)]
pub struct ChannelState {
    host_id: Option<String>,
    snapshot: Option<SnapshotRow>,
    subs: usize,
}

impl ChannelState {
    /// Rehydrate from storage, dropping an expired snapshot.
    pub fn restore(snapshot: Option<SnapshotRow>, now_ms: u64) -> Self {
        Self {
            snapshot: snapshot.filter(|s| s.expires_at > now_ms),
            ..Self::default()
        }
    }

    /// Register a publisher. Returns `true` when a DIFFERENT host id
    /// was replaced — the one-publisher-per-channel rule mirrors the
    /// directory's one-code rule: the newcomer always wins, and an id
    /// change is what makes it a replacement rather than a reconnect.
    pub fn host_connect(&mut self, host_id: Option<&str>) -> bool {
        let replaced = self.host_id.is_some() && self.host_id.as_deref() != host_id;
        self.host_id = host_id.map(str::to_string);
        replaced
    }

    /// The current publisher's persistent id, if any.
    pub fn host_id(&self) -> Option<&str> {
        self.host_id.as_deref()
    }

    /// The publisher's socket went away.
    pub fn host_gone(&mut self) {
        self.host_id = None;
    }

    /// A subscriber joined; refused past the cap.
    pub fn sub_join(&mut self) -> Result<(), SubError> {
        if self.subs >= MAX_SUBSCRIBERS {
            return Err(SubError::Full);
        }
        self.subs += 1;
        Ok(())
    }

    /// A subscriber left (close or error).
    pub fn sub_leave(&mut self) {
        self.subs = self.subs.saturating_sub(1);
    }

    /// Live subscriber count.
    pub fn sub_count(&self) -> usize {
        self.subs
    }

    /// Record a published battle frame as the channel snapshot. Retention
    /// starts at the cap ([`SNAPSHOT_MAX_MS`]) because a battle's end
    /// is only known when `bye` arrives.
    pub fn publish(&mut self, now_ms: u64, frame: String) -> u64 {
        let expires_at = now_ms + SNAPSHOT_MAX_MS;
        self.snapshot = Some(SnapshotRow { frame, expires_at });
        expires_at
    }

    /// `bye` arrived: the battle ended. The final snapshot stays for
    /// the grace window, then goes. `None` when no snapshot is held.
    pub fn bye(&mut self, now_ms: u64) -> Option<u64> {
        let snap = self.snapshot.as_mut()?;
        snap.expires_at = now_ms + SNAPSHOT_GRACE_MS;
        Some(snap.expires_at)
    }

    /// The live snapshot, if retention still covers it.
    pub fn snapshot(&self) -> Option<&SnapshotRow> {
        self.snapshot.as_ref()
    }

    /// Drop an expired snapshot; `true` when a row went away.
    pub fn sweep(&mut self, now_ms: u64) -> bool {
        if self
            .snapshot
            .as_ref()
            .is_some_and(|s| s.expires_at <= now_ms)
        {
            self.snapshot = None;
            true
        } else {
            false
        }
    }

    /// When the snapshot retention ends (`None` with no snapshot).
    pub fn retention_deadline(&self) -> Option<u64> {
        self.snapshot.as_ref().map(|s| s.expires_at)
    }
}

/// Verdict on one inbound battle frame by size (64 KiB cap, close 1009
/// on breach — reuses the data sockets' verdict shape).
pub fn battle_frame_verdict(size: usize) -> crate::room::FrameVerdict {
    if size > MAX_BATTLE_FRAME_BYTES {
        crate::room::FrameVerdict::TooLarge {
            size,
            cap: MAX_BATTLE_FRAME_BYTES,
        }
    } else {
        crate::room::FrameVerdict::Ok
    }
}

// ── text frames (contract §3.3) ────────────────────────────────────────

/// The minimal frame tag every gateway text frame carries. Borrowed,
/// zero-copy: frames pass through the channel verbatim and are never
/// re-serialized.
#[derive(Debug, Deserialize)]
struct FrameTag<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(borrow, default)]
    route: Option<&'a str>,
}

/// The `type` field of a JSON text frame, if it parses and tags itself.
/// Non-JSON chatter answers `None` (tolerated, ignored — a busy-talking
/// host must never crash the socket handler).
pub fn frame_kind(text: &str) -> Option<&str> {
    serde_json::from_str::<FrameTag<'_>>(text)
        .ok()
        .map(|tag| tag.kind)
}

/// The `route` field of a `battle` frame (`None` when absent, when
/// the frame is not a battle frame, or when it does not parse). The
/// channel drops frames whose route disagrees with its own — a mismatched
/// frame would corrupt subscribers' rosters.
pub fn battle_route(text: &str) -> Option<&str> {
    let tag: FrameTag<'_> = serde_json::from_str(text).ok()?;
    if tag.kind == "battle" {
        tag.route
    } else {
        None
    }
}

/// The `hello` frame a pub/sub socket receives on connect.
pub fn hello_frame(role: &str) -> String {
    format!(r#"{{"type":"hello","gateway":"{GATEWAY_PROTOCOL_V1}","role":"{role}"}}"#)
}

/// The host-presence frame subscribers receive on transitions.
pub fn host_frame(online: bool) -> String {
    format!(r#"{{"type":"host","online":{online}}}"#)
}

/// The keepalive text frame (both directions, every 30 s).
pub fn keepalive_frame() -> String {
    r#"{"type":"keepalive"}"#.to_string()
}

/// Deterministic RNG for tests: replays a scripted sequence, then
/// repeats the last draw.
#[derive(Debug, Clone)]
pub struct ScriptedTicketRng {
    pub draws: Vec<[u8; 16]>,
    pub pos: usize,
}

impl ScriptedTicketRng {
    pub fn new(draws: Vec<[u8; 16]>) -> Self {
        Self { draws, pos: 0 }
    }
}

impl TicketRng for ScriptedTicketRng {
    fn ticket_bytes(&mut self) -> [u8; 16] {
        let v = self.draws[self.pos.min(self.draws.len() - 1)];
        self.pos += 1;
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000_000;
    const ROUTE: &str = "r:asia:123456";
    const OTHER_ROUTE: &str = "r:eu:42";
    const IP: &str = "203.0.113.9";

    // ── channel ids ────────────────────────────────────────────────────

    #[test]
    fn route_ids_validate_the_contract_shape() {
        for good in ["r:asia:123456", "r:eu:1", "r:na:000000000", "r:sa:7"] {
            assert!(valid_route_id(good), "{good} must pass");
        }
        // Realm is 2–5 lowercase ASCII letters.
        for bad in [
            "r:a:1",
            "r:toolongrealm:1",
            "r:ASIA:1",
            "r:As1a:1",
            "r:as:1:2",
            "r::1",
        ] {
            assert!(!valid_route_id(bad), "{bad} must fail");
        }
        // Account id is 1–19 ASCII digits.
        for bad in [
            "r:asia:",
            "r:asia:x1",
            "r:asia:12a456",
            "r:asia:12345678901234567890",
            "r:asia:-5",
        ] {
            assert!(!valid_route_id(bad), "{bad} must fail");
        }
        // The prefix is exactly "r:".
        for bad in [
            "asia:1",
            "x:asia:1",
            "R:asia:1",
            "rr:asia:1",
            "r;asia:1",
            "",
        ] {
            assert!(!valid_route_id(bad), "{bad} must fail");
        }
    }

    #[test]
    fn tickets_shape_check() {
        assert!(valid_ticket("0123456789abcdef0123456789abcdef"));
        assert!(
            !valid_ticket("0123456789ABCDEF0123456789abcd0f"),
            "uppercase"
        );
        assert!(!valid_ticket("z123456789abcdef0123456789abcde0"));
        assert!(!valid_ticket("0123456789abcdef0123456789abcde")); // 31
        assert!(!valid_ticket(""));
    }

    // ── health document ────────────────────────────────────────────────

    #[test]
    fn health_doc_serializes_to_the_contract_shape() {
        // Turnstile on (official node), password on, notice set.
        let vars = GatewayVars::from_raw(
            Some("0x4AAAAAAFJMAGDRhyraDqpe"),
            true,
            Some("scheduled maintenance soon"),
        );
        let json = serde_json::to_string(&health_doc(&vars)).unwrap();
        assert_eq!(
            json,
            "{\"gateway\":\"v1\",\"minClientVersion\":\"0.6.8\",\"auth\":{\"turnstile\":\
             {\"required\":true,\"sitekey\":\"0x4AAAAAAFJMAGDRhyraDqpe\"},\"password\":\
             {\"required\":true}},\"notice\":\"scheduled maintenance soon\"}"
        );

        // Open self-host node: no sitekey, no password, no notice.
        let vars = GatewayVars::from_raw(None, false, None);
        let json = serde_json::to_string(&health_doc(&vars)).unwrap();
        assert_eq!(
            json,
            "{\"gateway\":\"v1\",\"minClientVersion\":\"0.6.8\",\"auth\":{\"turnstile\":\
             {\"required\":false},\"password\":{\"required\":false}},\"notice\":null}"
        );

        // Round-trip keeps the doc stable.
        let doc = health_doc(&vars);
        let back: HealthDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn health_vars_drop_blank_values() {
        let vars = GatewayVars::from_raw(Some("   "), true, Some(""));
        assert!(!vars.turnstile_required(), "blank sitekey means off");
        assert!(vars.password_required);
        assert_eq!(vars.notice, None);
    }

    // ── /session credential policy ─────────────────────────────────────

    #[test]
    fn credential_presence_enforced_exactly_as_demanded() {
        let locked_down = GatewayVars::from_raw(Some("0xsitekey"), true, None);
        assert_eq!(
            check_credentials(&locked_down, None, Some("pw")),
            Err(CredentialMissing::Turnstile)
        );
        assert_eq!(
            check_credentials(&locked_down, Some("tok"), None),
            Err(CredentialMissing::Password)
        );
        assert_eq!(
            check_credentials(&locked_down, Some("  "), Some("pw")),
            Err(CredentialMissing::Turnstile),
            "a whitespace token is absent"
        );
        assert_eq!(
            check_credentials(&locked_down, Some("tok"), Some("pw")),
            Ok(())
        );

        // Nothing demanded: everything passes, including empty bodies.
        let open = GatewayVars::from_raw(None, false, None);
        assert_eq!(check_credentials(&open, None, None), Ok(()));

        // Extra credentials are ignored, not errors.
        assert_eq!(check_credentials(&open, Some("tok"), Some("pw")), Ok(()));
    }

    #[test]
    fn password_compare_is_exact_and_length_aware() {
        assert!(password_matches("hunter2", "hunter2"));
        assert!(!password_matches("hunter2", "hunter3"));
        assert!(!password_matches("hunter2", "hunter2 "));
        assert!(!password_matches("hunter2", "hunter22"));
        assert!(!password_matches("", "x"));
        assert!(password_matches("", ""));
    }

    // ── tickets ────────────────────────────────────────────────────────

    fn bytes(n: u8) -> [u8; 16] {
        [n; 16]
    }

    #[test]
    fn tickets_mint_single_use_bound_and_ttl() {
        let mut auth = AuthState::new();
        let mut rng = ScriptedTicketRng::new(vec![bytes(1)]);
        let (ticket, entry) = auth.mint(T0, &mut rng, ROUTE, TicketKind::Both);
        assert_eq!(ticket, "01".repeat(16), "16 bytes → 32 lowercase hex");
        assert!(valid_ticket(&ticket));
        assert_eq!(entry.route, ROUTE);
        assert_eq!(entry.kind, TicketKind::Both);
        assert_eq!(entry.expires_at, T0 + TICKET_TTL_MS);
        assert_eq!(TICKET_TTL_MS, 120_000, "the contract's 120 s TTL");

        // Right route spends it; a second spend is unknown.
        assert_eq!(auth.consume(T0, &ticket, ROUTE), Ok(()));
        assert_eq!(
            auth.consume(T0, &ticket, ROUTE),
            Err(ConsumeError::Unknown),
            "single-use even after success"
        );
    }

    #[test]
    fn tickets_refuse_wrong_route_and_expiry() {
        let mut auth = AuthState::new();
        let mut rng = ScriptedTicketRng::new(vec![bytes(7), bytes(8)]);
        let (a, _) = auth.mint(T0, &mut rng, ROUTE, TicketKind::Turnstile);
        let (b, _) = auth.mint(T0, &mut rng, OTHER_ROUTE, TicketKind::Password);

        // Wrong route burns the ticket (no probing retries).
        assert_eq!(
            auth.consume(T0, &a, OTHER_ROUTE),
            Err(ConsumeError::RouteMismatch)
        );
        assert_eq!(auth.consume(T0, &a, ROUTE), Err(ConsumeError::Unknown));

        // Expired burns it too.
        assert_eq!(
            auth.consume(T0 + TICKET_TTL_MS, &b, OTHER_ROUTE),
            Err(ConsumeError::Expired)
        );
        // One ms before expiry still works for a fresh ticket.
        let (c, _) = auth.mint(T0, &mut rng, ROUTE, TicketKind::None);
        assert_eq!(auth.consume(T0 + TICKET_TTL_MS - 1, &c, ROUTE), Ok(()));
    }

    #[test]
    fn ticket_mint_retries_collisions() {
        let mut auth = AuthState::new();
        let mut rng = ScriptedTicketRng::new(vec![bytes(1), bytes(1), bytes(2)]);
        let (a, _) = auth.mint(T0, &mut rng, ROUTE, TicketKind::None);
        assert_eq!(a, "01".repeat(16));
        // The first draw collides with a's ticket; the second wins.
        let (b, _) = auth.mint(T0, &mut rng, ROUTE, TicketKind::None);
        assert_eq!(b, "02".repeat(16));
        assert_eq!(auth.len(), 2);
    }

    #[test]
    fn ticket_sweep_collects_expired_rows() {
        let mut auth = AuthState::new();
        let mut rng = ScriptedTicketRng::new(vec![bytes(1), bytes(2)]);
        auth.mint(T0, &mut rng, ROUTE, TicketKind::None);
        let (b, _) = auth.mint(T0 + 1_000, &mut rng, OTHER_ROUTE, TicketKind::None);

        let (removed, next) = auth.sweep(T0 + TICKET_TTL_MS);
        // a (T0) expired at T0+120_000; b lives until T0+121_000.
        assert_eq!(removed, vec![ticket_key(&"01".repeat(16))]);
        assert_eq!(next, Some(T0 + 1_000 + TICKET_TTL_MS));

        let (removed, next) = auth.sweep(T0 + 1_000 + TICKET_TTL_MS);
        assert_eq!(removed, vec![ticket_key(&b)]);
        assert_eq!(next, None, "nothing left → no deadline");
    }

    // ── password lockout ───────────────────────────────────────────────

    #[test]
    fn password_lock_trips_on_the_fifth_failure_in_the_window() {
        let mut auth = AuthState::new();
        for n in 0..4 {
            assert_eq!(
                auth.password_failed(T0 + n * 1_000, IP),
                None,
                "failure {} does not lock",
                n + 1
            );
        }
        // The 5th failure inside the 60 s window trips the 300 s lock and
        // the request that tripped it is itself refused.
        assert_eq!(
            auth.password_failed(T0 + 4_000, IP),
            Some(PASSWORD_LOCK_MS),
            "5th failure locks for 300 s"
        );
        assert_eq!(PASSWORD_LOCK_MS, 300_000, "the contract's 5 min lock");

        // The gate reports the remaining lock; the window was spent.
        // (The lock runs until T0+4_000+300_000.)
        assert_eq!(auth.lock_remaining(T0 + 5_000, IP), Some(299_000));
        // Failures while locked cost nothing extra.
        assert_eq!(auth.password_failed(T0 + 6_000, IP), Some(298_000));

        // After the lock lifts (it runs until T0+4_000+300_000) the IP
        // starts clean.
        assert_eq!(auth.lock_remaining(T0 + 4_000 + PASSWORD_LOCK_MS, IP), None);
        assert_eq!(
            auth.password_failed(T0 + 4_000 + PASSWORD_LOCK_MS + 1, IP),
            None
        );
        assert_eq!(auth.password_row(IP).unwrap().failures.len(), 1);
    }

    #[test]
    fn password_window_slides() {
        let mut auth = AuthState::new();
        auth.password_failed(T0, IP);
        // Four more failures a full window later: the first one slid out.
        for n in 0..4 {
            assert_eq!(
                auth.password_failed(T0 + PASSWORD_WINDOW_MS + 1 + n, IP),
                None,
                "old failures leave the window"
            );
        }
        assert_eq!(auth.password_row(IP).unwrap().failures.len(), 4);
        // A fifth failure in the NEW window still trips.
        assert_eq!(
            auth.password_failed(T0 + PASSWORD_WINDOW_MS + 5, IP),
            Some(PASSWORD_LOCK_MS)
        );
    }

    #[test]
    fn password_locks_are_per_ip() {
        let mut auth = AuthState::new();
        for _ in 0..5 {
            auth.password_failed(T0, IP);
        }
        assert!(auth.lock_remaining(T0, IP).is_some());
        assert_eq!(
            auth.lock_remaining(T0, "198.51.100.7"),
            None,
            "other IPs are untouched"
        );
    }

    #[test]
    fn password_sweep_and_deadlines() {
        let mut auth = AuthState::new();
        auth.password_failed(T0, IP);
        let row = auth.password_row(IP).unwrap().clone();
        assert_eq!(row.dead_at(), Some(T0 + PASSWORD_WINDOW_MS));

        // Not dead while the window is live.
        assert_eq!(auth.sweep(T0 + 1_000).0, Vec::<String>::new());
        // Dead once the window slides past.
        let (removed, next) = auth.sweep(T0 + PASSWORD_WINDOW_MS + 1);
        assert_eq!(removed, vec![password_key(IP)]);
        assert_eq!(next, None);

        // A locked row outlives its failure window.
        for _ in 0..5 {
            auth.password_failed(T0, IP);
        }
        let row = auth.password_row(IP).unwrap().clone();
        assert_eq!(row.dead_at(), Some(T0 + PASSWORD_LOCK_MS));
        assert_eq!(row.is_empty(), false);
        assert_eq!(
            auth.sweep(T0 + PASSWORD_WINDOW_MS + 1).0,
            Vec::<String>::new(),
            "the lock keeps the row alive"
        );
    }

    // ── channel policy ─────────────────────────────────────────────────

    #[test]
    fn channel_host_replacement_follows_the_one_code_rule() {
        let mut chan = ChannelState::default();
        assert!(!chan.host_connect(Some("deadbeef00112233")));
        assert_eq!(chan.host_id(), Some("deadbeef00112233"));
        // Same id reconnecting (socket restart) is not a replacement.
        assert!(!chan.host_connect(Some("deadbeef00112233")));
        // A DIFFERENT persistent id replaces the first.
        assert!(chan.host_connect(Some("deadbeef00112244")));
        assert_eq!(chan.host_id(), Some("deadbeef00112244"));
        // An anonymous host replaces anyone holding an id.
        assert!(chan.host_connect(None));
        assert_eq!(chan.host_id(), None);
        // A second anonymous host is indistinguishable from the first
        // (no id to differ from), so the flag stays quiet — the socket
        // layer still supersedes the previous connection regardless.
        assert!(!chan.host_connect(None));

        chan.host_gone();
        assert_eq!(chan.host_id(), None);
        // Gone → the next host is a fresh start, not a replacement.
        assert!(!chan.host_connect(Some("deadbeef00112233")));
    }

    #[test]
    fn channel_subscriber_cap_is_32() {
        let mut chan = ChannelState::default();
        for _ in 0..MAX_SUBSCRIBERS {
            chan.sub_join().expect("32 subscribers fit");
        }
        assert_eq!(chan.sub_count(), MAX_SUBSCRIBERS);
        assert_eq!(chan.sub_join().unwrap_err(), SubError::Full);
        chan.sub_leave();
        assert!(chan.sub_join().is_ok());
        // Leaving never underflows.
        for _ in 0..40 {
            chan.sub_leave();
        }
        assert_eq!(chan.sub_count(), 0);
    }

    #[test]
    fn snapshot_retention_covers_the_battle_plus_grace() {
        let mut chan = ChannelState::default();
        let frame = r#"{"type":"battle","realm":"asia"}"#.to_string();

        // Publish arms the max retention (bye is unknown yet).
        let deadline = chan.publish(T0, frame.clone());
        assert_eq!(deadline, T0 + SNAPSHOT_MAX_MS);
        assert_eq!(SNAPSHOT_MAX_MS, 30 * 60_000);
        assert_eq!(chan.snapshot().unwrap().frame, frame);

        // A second battle mid-retention re-arms from its own publish.
        assert_eq!(
            chan.publish(T0 + 60_000, frame.clone()),
            T0 + 60_000 + SNAPSHOT_MAX_MS
        );

        // bye cuts retention to battle-end + grace.
        assert_eq!(
            chan.bye(T0 + 60_000 + 1),
            Some(T0 + 60_000 + 1 + SNAPSHOT_GRACE_MS)
        );
        assert_eq!(SNAPSHOT_GRACE_MS, 5 * 60_000);

        // bye with no snapshot held is a no-op.
        let mut empty = ChannelState::default();
        assert_eq!(empty.bye(T0), None);
    }

    #[test]
    fn snapshot_sweep_drops_expired_rows_only() {
        let mut chan = ChannelState::default();
        chan.publish(T0, "f".to_string());
        assert!(!chan.sweep(T0 + SNAPSHOT_MAX_MS - 1));
        assert!(chan.snapshot().is_some());
        assert!(chan.sweep(T0 + SNAPSHOT_MAX_MS));
        assert!(chan.snapshot().is_none());
        assert_eq!(chan.retention_deadline(), None);
    }

    #[test]
    fn snapshot_restore_drops_expired_rows() {
        let live = SnapshotRow {
            frame: "f".to_string(),
            expires_at: T0 + 1_000,
        };
        let dead = SnapshotRow {
            frame: "g".to_string(),
            expires_at: T0,
        };
        let chan = ChannelState::restore(Some(live), T0);
        assert_eq!(chan.snapshot().unwrap().frame, "f");
        let chan = ChannelState::restore(Some(dead), T0);
        assert!(chan.snapshot().is_none());
    }

    #[test]
    fn battle_frame_cap_is_64_kib_exclusive() {
        assert_eq!(MAX_BATTLE_FRAME_BYTES, 65_536);
        assert_eq!(battle_frame_verdict(0), crate::room::FrameVerdict::Ok);
        assert_eq!(battle_frame_verdict(65_536), crate::room::FrameVerdict::Ok);
        assert_eq!(
            battle_frame_verdict(65_537),
            crate::room::FrameVerdict::TooLarge {
                size: 65_537,
                cap: 65_536
            }
        );
        assert!(matches!(
            battle_frame_verdict(1024 * 1024),
            crate::room::FrameVerdict::TooLarge { .. }
        ));
    }

    // ── text frames ────────────────────────────────────────────────────

    #[test]
    fn frames_serialize_to_the_exact_contract_shape() {
        assert_eq!(
            hello_frame("pub"),
            r#"{"type":"hello","gateway":"v1","role":"pub"}"#
        );
        assert_eq!(
            hello_frame("sub"),
            r#"{"type":"hello","gateway":"v1","role":"sub"}"#
        );
        assert_eq!(host_frame(true), r#"{"type":"host","online":true}"#);
        assert_eq!(host_frame(false), r#"{"type":"host","online":false}"#);
        assert_eq!(keepalive_frame(), r#"{"type":"keepalive"}"#);
    }

    #[test]
    fn frame_kind_tags_and_tolerates_chatter() {
        assert_eq!(frame_kind(r#"{"type":"battle"}"#), Some("battle"));
        assert_eq!(frame_kind(r#"{"type":"bye"}"#), Some("bye"));
        assert_eq!(frame_kind(r#"{"type":"keepalive"}"#), Some("keepalive"));
        assert_eq!(
            frame_kind(r#"{"type":"battle","vehicles":[]}"#),
            Some("battle"),
            "unknown fields do not matter"
        );
        assert_eq!(frame_kind("junk"), None);
        assert_eq!(frame_kind(""), None);
        assert_eq!(frame_kind(r#"{"vehicles":[]}"#), None);
        assert_eq!(frame_kind(r#"{"type":42}"#), None);
    }

    #[test]
    fn battle_route_extracts_only_from_battle_frames() {
        assert_eq!(
            battle_route(r#"{"type":"battle","route":"r:asia:123"}"#),
            Some("r:asia:123")
        );
        // Absent route field.
        assert_eq!(battle_route(r#"{"type":"battle"}"#), None);
        // Non-battle frames never leak a route.
        assert_eq!(battle_route(r#"{"type":"bye","route":"r:asia:123"}"#), None);
        assert_eq!(battle_route("junk"), None);
    }

    #[test]
    fn ticket_kinds_round_trip_their_spellings() {
        assert_eq!(TicketKind::from_flags(true, true), TicketKind::Both);
        assert_eq!(TicketKind::from_flags(true, false), TicketKind::Turnstile);
        assert_eq!(TicketKind::from_flags(false, true), TicketKind::Password);
        assert_eq!(TicketKind::from_flags(false, false), TicketKind::None);
        for kind in [
            TicketKind::None,
            TicketKind::Turnstile,
            TicketKind::Password,
            TicketKind::Both,
        ] {
            assert_eq!(
                kind.as_str().parse::<TicketKind>().unwrap(),
                kind,
                "{} round trips",
                kind.as_str()
            );
            assert_eq!(
                serde_json::to_string(&kind).unwrap(),
                format!("\"{}\"", kind.as_str())
            );
        }
        assert!("nope".parse::<TicketKind>().is_err());
    }
}
