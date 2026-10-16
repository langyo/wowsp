//! The pairing-code directory: a pure state machine for the singleton
//! "codes" Durable Object. Owns every server-side pairing policy:
//!
//! - **Allocation** — `allocate(ip, room, hostId)` mints a CSPRNG 6-digit
//!   code bound to `{room, hostId}` with a 10-minute TTL. One active
//!   code per host AND per room: a new allocation replaces (kills) the
//!   host's previous code, whether it was minted for the same room or an
//!   older one after a desktop restart, and any other code still bound
//!   to the same room (a socket that rotates its `hostId` cannot stack
//!   codes).
//! - **Allocation cap** — every source may hold a bounded number of LIVE
//!   codes, per address tier (see [`ip_tiers`]): an IPv4 address, and an
//!   IPv6 /64, /56 and /48. A replacement retires a code as it mints one,
//!   so regenerating never spends anything; only stacking does.
//! - **Resolution** — `resolve(ip, code)` maps a code to its room ONCE:
//!   the first successful resolve stamps the client IP, re-resolves from
//!   the SAME IP stay allowed (phone reconnects), any OTHER IP is
//!   rejected for the rest of the code's life.
//! - **Brute-force guard** — failed resolves are counted per address
//!   tier inside a sliding minute; a tier over its limit (IPv4 address /
//!   IPv6 /64: 10, /56: 20, /48: 30) is blocked for 60s (`rate_limited`).
//!   There is deliberately no global gate (it would let a handful of
//!   addresses lock every user out); a gateway-wide failure count only
//!   raises an alert for the operator log.
//!
//! Time comes in as `now_ms` and randomness through the [`CodeRng`]
//! trait, so unit tests are fully deterministic and no test ever sleeps.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};

use serde::{Deserialize, Serialize};

/// How long an allocated code stays resolvable.
pub const CODE_TTL_MS: u64 = 10 * 60 * 1000;
/// Sliding window in which resolve failures are counted per tier.
pub const RATE_WINDOW_MS: u64 = 60 * 1000;
/// `> RATE_MAX_FAILURES` failures inside the window from one IPv4
/// address or one IPv6 /64 trips the block.
pub const RATE_MAX_FAILURES: usize = 10;
/// The same for a whole IPv6 /56 (256 /64s).
pub const RATE_MAX_FAILURES_V6_56: usize = 20;
/// The same for a whole IPv6 /48 (65 536 /64s — what a free tunnel
/// broker hands anyone).
pub const RATE_MAX_FAILURES_V6_48: usize = 30;
/// How long a tripped tier is rejected outright.
pub const RATE_BLOCK_MS: u64 = 60 * 1000;
/// Live codes one IPv4 address may hold. Generous on purpose: carrier
/// NAT puts many unrelated desktops behind one address, and each honest
/// desktop holds exactly one code.
pub const LIVE_CODES_V4: usize = 32;
/// Live codes one IPv6 /64 may hold (normally a single subscriber).
pub const LIVE_CODES_V6_64: usize = 8;
/// Live codes one IPv6 /56 may hold.
pub const LIVE_CODES_V6_56: usize = 16;
/// Live codes one IPv6 /48 may hold.
pub const LIVE_CODES_V6_48: usize = 32;
/// Failed resolves per minute, gateway-wide, that raise an operator
/// alert. Never a gate: nothing is refused because of it.
pub const GLOBAL_FAILURE_ALERT: usize = 120;
/// Mint attempts before declaring the code space exhausted.
pub const ALLOC_ATTEMPTS: usize = 64;

/// IPv6 tiers, finest first: (prefix length, failure limit, live codes).
const V6_TIERS: [(u8, usize, usize); 3] = [
    (64, RATE_MAX_FAILURES, LIVE_CODES_V6_64),
    (56, RATE_MAX_FAILURES_V6_56, LIVE_CODES_V6_56),
    (48, RATE_MAX_FAILURES_V6_48, LIVE_CODES_V6_48),
];

/// Randomness source for code minting. The worker implements this over
/// `getrandom` (workerd's `crypto.getRandomValues`); tests inject a
/// deterministic sequence.
pub trait CodeRng {
    /// One uniform draw from `0..1_000_000`.
    fn code_draw(&mut self) -> u32;
}

/// Result of a resolve attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveOutcome {
    /// Success — the room the code is bound to.
    Room(String),
    /// Unknown / expired / malformed code, or a code already claimed by
    /// a different client IP. Indistinguishable on purpose: the phone
    /// gets the same "check the code" state for all of them.
    Unknown,
    /// Rejected by the brute-force guard of one of the client's tiers.
    RateLimited,
}

/// Why an allocation failed. A failed allocation changes nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllocError {
    /// The 6-digit space had no free code after [`ALLOC_ATTEMPTS`] draws
    /// (needs ~a million live codes; effectively unreachable).
    Exhausted,
    /// One of the source's address tiers already holds its maximum of
    /// live codes.
    RateLimited,
}

/// One live code binding (persisted per code by the worker).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeEntry {
    /// The room the code opens.
    pub room: String,
    /// The `hostId` from the host's `hello`, when it sent one.
    pub host_id: Option<String>,
    /// Absolute expiry (ms since epoch).
    pub expires_at: u64,
    /// The IP of the first successful resolver; further IPs are refused
    /// until expiry. `None` until first resolved.
    pub resolved_by: Option<String>,
    /// The IP of the host socket that allocated it — the live-code caps
    /// are counted from this field, so they survive a DO restore. `None`
    /// on rows written before the caps existed (they count nowhere).
    #[serde(default)]
    pub allocated_by: Option<String>,
}

/// Per-tier resolve-failure bookkeeping (persisted per tier bucket by
/// the worker).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RateState {
    /// Timestamps of recent failed resolves (bounded, pruned to the
    /// sliding window).
    pub failures: Vec<u64>,
    /// Absolute time (ms) until which the tier is rejected outright.
    pub blocked_until: Option<u64>,
}

impl RateState {
    /// Nothing worth persisting (the worker deletes such rows).
    pub fn is_empty(&self) -> bool {
        self.failures.is_empty() && self.blocked_until.is_none()
    }

    /// When the row stops mattering: its block lifts and its newest
    /// failure leaves the window. `None` for an empty row.
    pub fn dead_at(&self) -> Option<u64> {
        let block = self.blocked_until;
        let window = self.failures.iter().max().map(|t| t + RATE_WINDOW_MS);
        block.max(window)
    }
}

/// One rate-limit identity of a client address and that tier's limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tier {
    /// The bucket key (`203.0.113.9`, `2001:db8:1:200::/56`, …).
    pub bucket: String,
    /// `> max_failures` failed resolves in the window trips the block.
    pub max_failures: usize,
    /// Live codes the bucket may hold at once.
    pub max_live_codes: usize,
}

/// The rate-limit tiers of a client address, finest first. IPv4 is one
/// tier: its address (no /24 aggregate — carrier NAT already packs many
/// honest users behind one address, and neighbours in a /24 are
/// unrelated customers). IPv6 is its /64, /56 and /48: a single
/// subscriber or a free tunnel broker hands out whole prefixes, so
/// counting per /128 would grant unlimited guesses. IPv4-mapped IPv6
/// counts as the IPv4 it carries, and anything that does not parse (the
/// worker's "local" fallback) is its own single tier.
pub fn ip_tiers(ip: &str) -> Vec<Tier> {
    let single = |bucket: String| {
        vec![Tier {
            bucket,
            max_failures: RATE_MAX_FAILURES,
            max_live_codes: LIVE_CODES_V4,
        }]
    };
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => single(v4.to_string()),
        Ok(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => single(v4.to_string()),
            None => V6_TIERS
                .iter()
                .map(|&(len, max_failures, max_live_codes)| {
                    let mask = u128::MAX << (128 - u32::from(len));
                    let net = Ipv6Addr::from(u128::from(v6) & mask);
                    Tier {
                        bucket: format!("{net}/{len}"),
                        max_failures,
                        max_live_codes,
                    }
                })
                .collect(),
        },
        Err(_) => single(ip.to_string()),
    }
}

/// The directory's whole state. The DO hydrates this from storage on
/// first use and write-throughs every mutation.
#[derive(Debug, Clone, Default)]
pub struct Directory {
    /// code → live entry.
    codes: HashMap<String, CodeEntry>,
    /// host key → that host's live code.
    hosts: HashMap<String, String>,
    /// room → the code bound to it (derived from `codes`, never
    /// persisted on its own).
    rooms: HashMap<String, String>,
    /// tier bucket → live codes allocated from it (derived from
    /// `codes[*].allocated_by`, never persisted on its own).
    live: HashMap<String, usize>,
    /// tier bucket → failure window / block.
    rate: HashMap<String, RateState>,
    /// Gateway-wide failure count of the current minute (alert only).
    alert_window_start: u64,
    alert_count: usize,
    alert_pending: bool,
}

/// Storage key for a code binding.
pub fn code_key(code: &str) -> String {
    format!("c:{code}")
}
/// Storage key for a host's reverse index entry.
pub fn host_key_storage(host: &str) -> String {
    format!("h:{host}")
}
/// Storage key for a tier bucket's rate state (see [`ip_tiers`]).
pub fn rate_key(bucket: &str) -> String {
    format!("r:{bucket}")
}

/// The directory's identity key for a host: the `hello` hostId when the
/// client sent one, else the room (v1 clients). Either way a host holds
/// at most one live code.
pub fn host_index_key(host_id: Option<&str>, room: &str) -> String {
    match host_id {
        Some(id) => format!("id:{id}"),
        None => format!("room:{room}"),
    }
}

impl Directory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rehydrate from persisted rows (worker storage load). The room
    /// index and the live-code counts are rebuilt from the code rows, so
    /// an eviction or redeploy never resets the allocation caps.
    pub fn restore(
        codes: impl IntoIterator<Item = (String, CodeEntry)>,
        hosts: impl IntoIterator<Item = (String, String)>,
        rate: impl IntoIterator<Item = (String, RateState)>,
    ) -> Self {
        let codes: HashMap<String, CodeEntry> = codes.into_iter().collect();
        let rooms = codes
            .iter()
            .map(|(code, e)| (e.room.clone(), code.clone()))
            .collect();
        let mut live = HashMap::new();
        for entry in codes.values() {
            count_live(&mut live, entry, true);
        }
        Self {
            codes,
            hosts: hosts.into_iter().collect(),
            rooms,
            live,
            rate: rate.into_iter().collect(),
            ..Self::default()
        }
    }

    /// Drop dead rows (expired codes and their reverse entries, stale
    /// rate windows / expired blocks). Returns the keys removed so the
    /// worker mirrors the deletions into storage, plus the next deadline
    /// for alarm arming (see [`Directory::next_deadline`]).
    pub fn sweep(&mut self, now_ms: u64) -> (Vec<String>, Option<u64>) {
        let dead_codes: Vec<String> = self
            .codes
            .iter()
            .filter(|(_, e)| e.expires_at <= now_ms)
            .map(|(c, _)| c.clone())
            .collect();
        let mut removed = Vec::new();
        for code in &dead_codes {
            if let Some(entry) = self.codes.remove(code) {
                count_live(&mut self.live, &entry, false);
            }
            removed.push(code_key(code));
        }
        self.rooms.retain(|_, code| self.codes.contains_key(code));
        // Reverse index rows whose code no longer exists (the code row
        // above was the authority; the host row just mirrors it).
        let dead_hosts: Vec<String> = self
            .hosts
            .iter()
            .filter(|(_, code)| !self.codes.contains_key(*code))
            .map(|(h, _)| h.clone())
            .collect();
        for host in &dead_hosts {
            self.hosts.remove(host);
            removed.push(host_key_storage(host));
        }
        // Rate rows with nothing live.
        let dead_rate: Vec<String> = self
            .rate
            .iter()
            .filter(|(_, r)| rate_is_dead(r, now_ms))
            .map(|(ip, _)| ip.clone())
            .collect();
        for ip in &dead_rate {
            self.rate.remove(ip);
            removed.push(rate_key(ip));
        }
        (removed, self.next_deadline())
    }

    /// The earliest moment a sweep has work to do: the first code expiry
    /// or the first rate row going stale, so rate rows are collected even
    /// while no code is live.
    pub fn next_deadline(&self) -> Option<u64> {
        let codes = self.codes.values().map(|e| e.expires_at);
        let rate = self.rate.values().filter_map(RateState::dead_at);
        codes.chain(rate).min()
    }

    /// Mint a fresh unique code for `(host_id, room)` on behalf of the
    /// host socket at `ip`, replacing the host's previous code and any
    /// other code still bound to `room`. Returns the new code and the
    /// storage keys that changed. A failed allocation changes nothing.
    ///
    /// No sweep runs here: an expired-but-unswept row is harmless (resolve
    /// checks the expiry, retirement and collision checks just treat it
    /// as live) and the alarm sweep collects it, so allocation never
    /// scans the whole table.
    pub fn allocate(
        &mut self,
        now_ms: u64,
        rng: &mut dyn CodeRng,
        ip: &str,
        room: &str,
        host_id: Option<&str>,
    ) -> Result<AllocateDelta, AllocError> {
        let host = host_index_key(host_id, room);
        // One active code per host and per room: these die if this
        // allocation succeeds.
        let mut stale: Vec<String> = Vec::new();
        for old in [self.hosts.get(&host), self.rooms.get(room)]
            .into_iter()
            .flatten()
        {
            if !stale.contains(old) {
                stale.push(old.clone());
            }
        }

        // Live-code caps, net of what this call replaces: regenerating
        // (same socket, same room) never spends anything.
        for tier in ip_tiers(ip) {
            let live = self.live.get(&tier.bucket).copied().unwrap_or(0);
            let freed = stale
                .iter()
                .filter_map(|c| self.codes.get(c))
                .filter(|e| allocated_from(e, &tier.bucket))
                .count();
            if live.saturating_sub(freed) >= tier.max_live_codes {
                return Err(AllocError::RateLimited);
            }
        }

        // Mint before touching anything. The stale codes are still in
        // `codes`, so a host that regenerates always sees a visibly new
        // code; the check is a single hash lookup.
        let mut code = None;
        for _ in 0..ALLOC_ATTEMPTS {
            let candidate = format!("{:06}", rng.code_draw() % 1_000_000);
            if !self.codes.contains_key(&candidate) {
                code = Some(candidate);
                break;
            }
        }
        let Some(code) = code else {
            return Err(AllocError::Exhausted);
        };

        let mut removed = Vec::new();
        for old in &stale {
            self.retire(old, &mut removed);
        }
        let entry = CodeEntry {
            room: room.to_string(),
            host_id: host_id.map(str::to_string),
            expires_at: now_ms + CODE_TTL_MS,
            resolved_by: None,
            allocated_by: Some(ip.to_string()),
        };
        count_live(&mut self.live, &entry, true);
        self.codes.insert(code.clone(), entry.clone());
        self.hosts.insert(host.clone(), code.clone());
        self.rooms.insert(room.to_string(), code.clone());
        // The host's reverse-index row is rewritten with the new code, so
        // it must not also be reported as removed (the worker deletes
        // after it writes).
        let host_storage_key = host_key_storage(&host);
        removed.retain(|k| *k != host_storage_key);
        Ok(AllocateDelta {
            code,
            entry,
            host_storage_key,
            removed,
        })
    }

    /// Drop a code binding and the index rows that point at it,
    /// reporting the storage keys to delete.
    fn retire(&mut self, code: &str, removed: &mut Vec<String>) {
        let Some(entry) = self.codes.remove(code) else {
            return;
        };
        removed.push(code_key(code));
        count_live(&mut self.live, &entry, false);
        if self.rooms.get(&entry.room).is_some_and(|c| c == code) {
            self.rooms.remove(&entry.room);
        }
        let host = host_index_key(entry.host_id.as_deref(), &entry.room);
        if self.hosts.get(&host).is_some_and(|c| c == code) {
            self.hosts.remove(&host);
            removed.push(host_key_storage(&host));
        }
    }

    /// Resolve a code from a client IP. See the module docs for the
    /// once-claim + brute-force semantics. Returns the outcome and the
    /// rate rows this call CHANGED, as `(tier bucket, state)` to persist
    /// under [`rate_key`] (an empty state means delete). A refusal of an
    /// already-blocked client changes nothing and writes nothing.
    #[allow(clippy::type_complexity)]
    pub fn resolve(
        &mut self,
        now_ms: u64,
        ip: &str,
        code: &str,
    ) -> (ResolveOutcome, Vec<(String, RateState)>) {
        let tiers = ip_tiers(ip);
        let mut changed: Vec<String> = Vec::new();
        // A blocked tier is rejected before touching the code table, and
        // the failure that tripped the block still counts (prune first).
        let mut blocked = false;
        for tier in &tiers {
            let Some(state) = self.rate.get_mut(&tier.bucket) else {
                continue;
            };
            prune_failures(state, now_ms);
            if let Some(until) = state.blocked_until {
                if now_ms < until {
                    blocked = true;
                    break;
                }
                state.blocked_until = None;
                changed.push(tier.bucket.clone());
            }
        }
        if blocked {
            return (ResolveOutcome::RateLimited, self.rate_rows(changed));
        }

        let outcome = match self.codes.get(code) {
            Some(entry) if entry.expires_at > now_ms => {
                if entry.resolved_by.as_deref() == Some(ip) || entry.resolved_by.is_none() {
                    let room = entry.room.clone();
                    self.codes
                        .get_mut(code)
                        .expect("entry just checked")
                        .resolved_by = Some(ip.to_string());
                    ResolveOutcome::Room(room)
                } else {
                    // Claimed by another phone. Looks identical to an
                    // unknown code to the caller — no oracle about
                    // other people's pairings.
                    ResolveOutcome::Unknown
                }
            },
            _ => ResolveOutcome::Unknown,
        };
        if outcome != ResolveOutcome::Unknown {
            return (outcome, self.rate_rows(changed));
        }

        self.note_global_failure(now_ms);
        let mut tripped = false;
        for tier in &tiers {
            let state = self.rate.entry(tier.bucket.clone()).or_default();
            state.failures.push(now_ms);
            prune_failures(state, now_ms);
            if state.failures.len() > tier.max_failures {
                state.blocked_until = Some(now_ms + RATE_BLOCK_MS);
                // The window that tripped the block is spent.
                state.failures.clear();
                tripped = true;
            }
            if !changed.contains(&tier.bucket) {
                changed.push(tier.bucket.clone());
            }
        }
        // The request that broke the camel's back is itself a
        // rate-limited rejection, not a normal miss.
        let outcome = if tripped {
            ResolveOutcome::RateLimited
        } else {
            ResolveOutcome::Unknown
        };
        (outcome, self.rate_rows(changed))
    }

    /// Current states of the given rate buckets (default when gone).
    fn rate_rows(&self, buckets: Vec<String>) -> Vec<(String, RateState)> {
        buckets
            .into_iter()
            .map(|b| {
                let state = self.rate.get(&b).cloned().unwrap_or_default();
                (b, state)
            })
            .collect()
    }

    /// Count a failed resolve toward the gateway-wide alert (fixed
    /// one-minute windows). Never refuses anything.
    fn note_global_failure(&mut self, now_ms: u64) {
        if now_ms >= self.alert_window_start + RATE_WINDOW_MS {
            self.alert_window_start = now_ms;
            self.alert_count = 0;
        }
        self.alert_count += 1;
        if self.alert_count == GLOBAL_FAILURE_ALERT {
            self.alert_pending = true;
        }
    }

    /// `true` once per minute in which gateway-wide failed resolves
    /// reached [`GLOBAL_FAILURE_ALERT`] — the worker logs it so the
    /// operator sees distributed guessing that no single tier catches.
    pub fn take_failure_alert(&mut self) -> bool {
        std::mem::take(&mut self.alert_pending)
    }

    /// Persisted view of a code binding, if still live (worker helper).
    pub fn entry(&self, code: &str) -> Option<&CodeEntry> {
        self.codes.get(code)
    }

    /// Persisted view of every live code binding.
    pub fn entries(&self) -> impl Iterator<Item = (&String, &CodeEntry)> {
        self.codes.iter()
    }

    /// Number of live codes (tests / diagnostics).
    pub fn len(&self) -> usize {
        self.codes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.codes.is_empty()
    }
}

/// What an [`Directory::allocate`] changed, so the worker can write it
/// through to storage in one shot.
#[derive(Debug, Clone, PartialEq)]
pub struct AllocateDelta {
    /// The minted code.
    pub code: String,
    /// Its binding (TTL-fresh, unclaimed).
    pub entry: CodeEntry,
    /// Storage key for the host's reverse-index row.
    pub host_storage_key: String,
    /// Storage keys whose rows must be deleted (the retired codes and
    /// their reverse-index rows).
    pub removed: Vec<String>,
}

/// Add (or remove) one live code to the counts of every tier of the
/// address that allocated it.
fn count_live(live: &mut HashMap<String, usize>, entry: &CodeEntry, add: bool) {
    let Some(ip) = entry.allocated_by.as_deref() else {
        return;
    };
    for tier in ip_tiers(ip) {
        if add {
            *live.entry(tier.bucket).or_default() += 1;
        } else if let Some(n) = live.get_mut(&tier.bucket) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                live.remove(&tier.bucket);
            }
        }
    }
}

/// Whether `entry` was allocated from an address inside `bucket`.
fn allocated_from(entry: &CodeEntry, bucket: &str) -> bool {
    entry
        .allocated_by
        .as_deref()
        .is_some_and(|ip| ip_tiers(ip).iter().any(|t| t.bucket == bucket))
}

/// Prune failure timestamps that slid out of the window.
fn prune_failures(state: &mut RateState, now_ms: u64) {
    let cutoff = now_ms.saturating_sub(RATE_WINDOW_MS);
    state.failures.retain(|t| *t > cutoff);
}

fn rate_is_dead(state: &RateState, now_ms: u64) -> bool {
    let block_live = state.blocked_until.is_some_and(|until| now_ms < until);
    let cutoff = now_ms.saturating_sub(RATE_WINDOW_MS);
    !block_live && state.failures.iter().all(|t| *t <= cutoff)
}

/// Deterministic RNG for tests: replays a scripted sequence, then
/// repeats the last draw.
#[derive(Debug, Clone)]
pub struct ScriptedRng {
    pub draws: Vec<u32>,
    pub pos: usize,
}

impl ScriptedRng {
    pub fn new(draws: Vec<u32>) -> Self {
        Self { draws, pos: 0 }
    }
}

impl CodeRng for ScriptedRng {
    fn code_draw(&mut self) -> u32 {
        let v = self.draws[self.pos.min(self.draws.len() - 1)];
        self.pos += 1;
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::valid_room;

    const T0: u64 = 1_700_000_000_000;
    const HOST_ID: &str = "deadbeef00112233";
    const HOST_ID2: &str = "deadbeef00112244";
    const HOST_IP: &str = "198.51.100.7";

    fn room(n: u8) -> String {
        format!("{n:064x}")
    }

    #[test]
    fn allocate_mints_unique_zero_padded_codes() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![42, 42, 7]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        assert_eq!(a.code, "000042");
        let b = dir
            .allocate(T0, &mut rng, HOST_IP, &room(2), Some(HOST_ID2))
            .unwrap();
        assert_eq!(b.code, "000007", "second draw collides, third wins");
        assert_ne!(a.code, b.code);
        assert_eq!(dir.len(), 2);
        assert_eq!(a.entry.expires_at, T0 + CODE_TTL_MS);
        assert_eq!(a.entry.room, room(1));
        assert_eq!(a.entry.host_id.as_deref(), Some(HOST_ID));
    }

    #[test]
    fn one_active_code_per_host_replacement_kills_the_old_one() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2, 3]);
        let first = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        // Same host, same room: regenerate.
        let second = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        assert_eq!(second.code, "000002");
        assert!(second.removed.contains(&code_key(&first.code)));
        assert!(dir.entry(&first.code).is_none(), "old code is dead");
        assert_eq!(dir.len(), 1);

        // Same host, NEW room (desktop restarted, minted a fresh room):
        // still one code — the host's identity, not the room, owns it.
        let third = dir
            .allocate(T0, &mut rng, HOST_IP, &room(2), Some(HOST_ID))
            .unwrap();
        assert_eq!(
            third.code, "000003",
            "each allocation mints a visibly fresh code"
        );
        assert!(dir.entry(&second.code).is_none());
        assert_eq!(dir.len(), 1);
        assert_eq!(third.entry.room, room(2));
    }

    #[test]
    fn v1_hosts_without_hello_key_by_room() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2, 3]);
        let a = dir.allocate(T0, &mut rng, HOST_IP, &room(1), None).unwrap();
        let b = dir.allocate(T0, &mut rng, HOST_IP, &room(2), None).unwrap();
        // Different rooms → two independent codes (two v1 hosts).
        assert_eq!(dir.len(), 2);
        assert_ne!(a.code, b.code);
        // A hostId-keyed allocation for a room that already holds a v1
        // code replaces it: one live code per room, whatever the key.
        let c = dir
            .allocate(T0, &mut rng, HOST_IP, &room(2), Some(HOST_ID))
            .unwrap();
        assert_eq!(dir.len(), 2);
        assert!(dir.entry(&b.code).is_none());
        assert!(c.removed.contains(&code_key(&b.code)));
        assert!(dir.entry(&a.code).is_some());
        assert!(dir.entry(&c.code).is_some());
    }

    #[test]
    fn resolve_maps_code_to_room_once_then_claims_it() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();

        // Unknown codes are failures.
        assert_eq!(
            dir.resolve(T0, "203.0.113.9", "999999").0,
            ResolveOutcome::Unknown
        );
        // First successful resolve stamps the IP.
        assert_eq!(
            dir.resolve(T0, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        // Same IP reconnecting: still fine (within TTL).
        assert_eq!(
            dir.resolve(T0 + 5_000, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        // A different IP: rejected, and indistinguishable from unknown.
        assert_eq!(
            dir.resolve(T0 + 6_000, "203.0.113.11", &a.code).0,
            ResolveOutcome::Unknown
        );
        // The claim is persisted on the entry.
        assert_eq!(
            dir.entry(&a.code).unwrap().resolved_by.as_deref(),
            Some("203.0.113.10")
        );
    }

    #[test]
    fn replacement_kills_a_resolved_code_mid_flight() {
        // A phone resolved code A (claim stamped); the desktop then
        // regenerates (or restarts with the same hostId). The old code
        // must stop resolving — for the claiming IP and everyone else —
        // while the replacement works immediately.
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5, 6]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        assert_eq!(
            dir.resolve(T0 + 1_000, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );

        let b = dir
            .allocate(T0 + 2_000, &mut rng, HOST_IP, &room(2), Some(HOST_ID))
            .unwrap();
        assert_ne!(a.code, b.code);
        // The claiming phone itself can no longer reconnect on A…
        assert_eq!(
            dir.resolve(T0 + 3_000, "203.0.113.10", &a.code).0,
            ResolveOutcome::Unknown
        );
        // …nor can a second phone that never saw A.
        assert_eq!(
            dir.resolve(T0 + 3_001, "203.0.113.11", &a.code).0,
            ResolveOutcome::Unknown
        );
        assert!(dir.entry(&a.code).is_none(), "A is swept out of the table");
        // The replacement is live and claims cleanly.
        assert_eq!(
            dir.resolve(T0 + 4_000, "203.0.113.10", &b.code).0,
            ResolveOutcome::Room(room(2))
        );
    }

    #[test]
    fn codes_expire_after_ten_minutes() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        assert_eq!(
            dir.resolve(T0 + CODE_TTL_MS - 1, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        assert_eq!(
            dir.resolve(T0 + CODE_TTL_MS, "203.0.113.10", &a.code).0,
            ResolveOutcome::Unknown,
            "at exactly the TTL the code is dead"
        );
        // Sweep collects the corpse.
        let (removed, next) = dir.sweep(T0 + CODE_TTL_MS);
        assert!(removed.contains(&code_key(&a.code)));
        assert!(dir.is_empty());
        // The miss above left a rate row, which still wants a sweep.
        assert_eq!(next, Some(T0 + CODE_TTL_MS + RATE_WINDOW_MS));
    }

    #[test]
    fn brute_force_guard_trips_after_ten_failures_and_blocks_for_a_minute() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        let ip = "203.0.113.66";

        // 10 failures inside the window: all answered Unknown (guard
        // not yet tripped — the contract says >10/min trips it).
        for i in 0..RATE_MAX_FAILURES {
            assert_eq!(
                dir.resolve(T0 + i as u64 * 100, ip, "999999").0,
                ResolveOutcome::Unknown,
                "failure #{i} must not be rate-limited yet"
            );
        }
        // 11th failure trips the block…
        assert_eq!(
            dir.resolve(T0 + 1_100, ip, "999999").0,
            ResolveOutcome::RateLimited,
            "the tripping failure itself is already rejected"
        );
        // …and even a VALID code is refused while blocked.
        assert_eq!(
            dir.resolve(T0 + 2_000, ip, &a.code).0,
            ResolveOutcome::RateLimited
        );
        // Other IPs are unaffected.
        assert_eq!(
            dir.resolve(T0 + 2_000, "203.0.113.67", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        // After the 60s block the IP resolves normally again — with a
        // FRESH code: the old one is now claimed by the other phone,
        // and the once-claim rule would (correctly) refuse it.
        let mut rng2 = ScriptedRng::new(vec![9]);
        let c = dir
            .allocate(T0 + 3_000, &mut rng2, HOST_IP, &room(3), Some(HOST_ID2))
            .unwrap();
        assert_eq!(
            dir.resolve(T0 + RATE_BLOCK_MS + 2_001, ip, &c.code).0,
            ResolveOutcome::Room(room(3))
        );
        // And the claim-once rule still guards the newly minted code.
        assert_eq!(
            dir.resolve(T0 + RATE_BLOCK_MS + 2_002, "203.0.113.68", &c.code)
                .0,
            ResolveOutcome::Unknown
        );
    }

    #[test]
    fn sliding_window_forgives_slow_trickles() {
        let mut dir = Directory::new();
        let ip = "203.0.113.70";
        // One failure every 7 seconds: never more than ~9 inside a
        // rolling minute — the guard must never trip.
        for i in 0..30u64 {
            let t = T0 + i * 7_000;
            assert_eq!(
                dir.resolve(t, ip, "999999").0,
                ResolveOutcome::Unknown,
                "slow trickle must stay under the radar (t={t})"
            );
        }
    }

    #[test]
    fn sweep_reports_next_deadline_for_the_alarm() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        let b = dir
            .allocate(T0 + 60_000, &mut rng, HOST_IP, &room(2), Some(HOST_ID2))
            .unwrap();
        let (_, next) = dir.sweep(T0 + 1);
        assert_eq!(next, Some(a.entry.expires_at));
        // Sweeping AT a's expiry instant kills it (the TTL is
        // inclusive), so the next deadline is b's.
        let (_, next) = dir.sweep(a.entry.expires_at);
        assert_eq!(next, Some(b.entry.expires_at));
        let (_, next) = dir.sweep(a.entry.expires_at + 1);
        assert_eq!(next, Some(T0 + 60_000 + CODE_TTL_MS));
    }

    #[test]
    fn restore_round_trips_the_persisted_view() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        let _ = dir.resolve(T0, "203.0.113.10", &a.code);
        let codes: Vec<_> = dir.entries().map(|(c, e)| (c.clone(), e.clone())).collect();
        // Host rows come back under their LOGICAL key (the worker strips
        // the "h:" storage prefix before restoring).
        let hosts: Vec<_> = vec![(host_index_key(Some(HOST_ID), &room(1)), a.code.clone())];
        let rate: Vec<_> = vec![(String::from("203.0.113.10"), RateState::default())];

        let mut revived = Directory::restore(codes, hosts, rate);
        // The claim survives a DO eviction + rehydration.
        assert_eq!(
            revived.resolve(T0 + 1_000, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        assert_eq!(
            revived.resolve(T0 + 1_000, "203.0.113.99", &a.code).0,
            ResolveOutcome::Unknown
        );
        assert!(valid_room(&revived.entry(&a.code).unwrap().room));
        // The host index survives too: the same host minting in ANOTHER
        // room (desktop restart) still retires the restored code.
        let b = revived
            .allocate(T0 + 2_000, &mut rng, HOST_IP, &room(2), Some(HOST_ID))
            .unwrap();
        assert!(b.removed.contains(&code_key(&a.code)));
        assert!(revived.entry(&a.code).is_none());
        assert_eq!(revived.len(), 1);
    }

    #[test]
    fn exhausted_code_space_is_reported_and_changes_nothing() {
        let mut dir = Directory::new();
        let held = dir
            .allocate(
                T0,
                &mut ScriptedRng::new(vec![123_456]),
                HOST_IP,
                &room(1),
                Some(HOST_ID),
            )
            .unwrap();
        assert_eq!(held.code, "123456");
        let other = dir
            .allocate(
                T0,
                &mut ScriptedRng::new(vec![7]),
                HOST_IP,
                &room(2),
                Some(HOST_ID2),
            )
            .unwrap();
        // Every draw collides with a live code (the scripted RNG repeats
        // its last draw forever): Exhausted after ALLOC_ATTEMPTS tries.
        let mut stuck = ScriptedRng::new(vec![123_456]);
        assert_eq!(
            dir.allocate(T0 + 1, &mut stuck, HOST_IP, &room(2), Some(HOST_ID2)),
            Err(AllocError::Exhausted)
        );
        assert_eq!(stuck.pos, ALLOC_ATTEMPTS);
        // The failed attempt retired nothing: the host's and the room's
        // existing code are both still live.
        assert!(dir.entry(&other.code).is_some());
        assert!(dir.entry(&held.code).is_some());
        assert_eq!(dir.len(), 2);
    }

    /// A room key for any index (the u8 `room` helper tops out at 255).
    fn room_n(n: u32) -> String {
        format!("{n:064x}")
    }

    fn buckets(ip: &str) -> Vec<String> {
        ip_tiers(ip).into_iter().map(|t| t.bucket).collect()
    }

    #[test]
    fn ipv4_is_one_tier_and_ipv6_is_its_64_56_and_48() {
        assert_eq!(buckets("203.0.113.9"), vec!["203.0.113.9"]);
        assert_eq!(ip_tiers("203.0.113.9")[0].max_failures, RATE_MAX_FAILURES);
        assert_eq!(ip_tiers("203.0.113.9")[0].max_live_codes, LIVE_CODES_V4);
        // No /24 aggregate for IPv4 (carrier NAT neighbours are strangers).
        assert_ne!(buckets("203.0.113.9"), buckets("203.0.113.10"));
        let tiers = ip_tiers("2001:db8:1:2ff::1");
        assert_eq!(
            tiers.iter().map(|t| t.bucket.as_str()).collect::<Vec<_>>(),
            vec![
                "2001:db8:1:2ff::/64",
                "2001:db8:1:200::/56",
                "2001:db8:1::/48"
            ]
        );
        assert_eq!(
            tiers.iter().map(|t| t.max_failures).collect::<Vec<_>>(),
            vec![
                RATE_MAX_FAILURES,
                RATE_MAX_FAILURES_V6_56,
                RATE_MAX_FAILURES_V6_48
            ]
        );
        assert_eq!(
            tiers.iter().map(|t| t.max_live_codes).collect::<Vec<_>>(),
            vec![LIVE_CODES_V6_64, LIVE_CODES_V6_56, LIVE_CODES_V6_48]
        );
        // Every spelling of an address in one /64 lands in the same
        // buckets…
        let net = buckets("2001:db8:1:2::1");
        assert_eq!(buckets("2001:DB8:1:2:ffff:ffff:ffff:fffe"), net);
        assert_eq!(buckets("2001:0db8:0001:0002:0:0:0:9"), net);
        // …the neighbouring /64 shares only the /56 and /48…
        let next = buckets("2001:db8:1:3::1");
        assert_ne!(next[0], net[0]);
        assert_eq!(next[1..], net[1..]);
        // …and another /56 of the same /48 only the /48.
        let far = buckets("2001:db8:1:100::1");
        assert_ne!(far[1], net[1]);
        assert_eq!(far[2], net[2]);
        // IPv4-mapped IPv6 is the IPv4 it carries; fallbacks stay single.
        assert_eq!(buckets("::ffff:203.0.113.9"), vec!["203.0.113.9"]);
        assert_eq!(buckets("local"), vec!["local"]);
    }

    #[test]
    fn brute_force_guard_counts_a_whole_ipv6_64_as_one_client() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        // Ten misses, each from a fresh address inside the same /64.
        for i in 0..RATE_MAX_FAILURES as u16 {
            let ip = format!("2001:db8:1:2::{:x}", i + 1);
            assert_eq!(
                dir.resolve(T0 + u64::from(i), &ip, "999999").0,
                ResolveOutcome::Unknown
            );
        }
        // The eleventh, from yet another address of that /64, trips the
        // block for the whole /64 — even with a valid code.
        let (outcome, rows) = dir.resolve(T0 + 100, "2001:db8:1:2::ff", "999999");
        assert_eq!(outcome, ResolveOutcome::RateLimited);
        assert_eq!(rows.len(), 3, "all three tiers counted the miss");
        assert_eq!(rows[0].0, "2001:db8:1:2::/64");
        assert_eq!(rows[0].1.blocked_until, Some(T0 + 100 + RATE_BLOCK_MS));
        assert_eq!(rows[1].1.blocked_until, None, "the /56 is below its limit");
        let (outcome, rows) = dir.resolve(T0 + 200, "2001:db8:1:2:abcd::1", &a.code);
        assert_eq!(outcome, ResolveOutcome::RateLimited);
        assert!(
            rows.is_empty(),
            "a refusal of a blocked tier writes nothing"
        );
        // The neighbouring /64 is unaffected.
        assert_eq!(
            dir.resolve(T0 + 300, "2001:db8:1:3::1", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
    }

    #[test]
    fn rotating_64s_hits_the_56_then_the_48_limit() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        // One miss from each of 20 /64s inside 2001:db8:1:200::/56: no
        // /64 is anywhere near its limit, the /56 reaches exactly its own.
        let mut t = T0;
        for n in 0..RATE_MAX_FAILURES_V6_56 as u32 {
            t += 1;
            let ip = format!("2001:db8:1:2{n:02x}::1");
            assert_eq!(dir.resolve(t, &ip, "999999").0, ResolveOutcome::Unknown);
        }
        // The 21st trips the /56 — the whole /56 is now refused, even a
        // fresh /64 with a valid code…
        t += 1;
        assert_eq!(
            dir.resolve(t, "2001:db8:1:2fe::1", "999999").0,
            ResolveOutcome::RateLimited
        );
        assert_eq!(
            dir.resolve(t, "2001:db8:1:2fd::1", &a.code).0,
            ResolveOutcome::RateLimited
        );
        // …while another /56 of the same /48 keeps working.
        assert_eq!(
            dir.resolve(t, "2001:db8:1:300::1", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        // Rotating /56s inside the /48: 21 misses are already on the /48;
        // nine more from fresh /56s fill it, the tenth trips it.
        for n in 0..(RATE_MAX_FAILURES_V6_48 - RATE_MAX_FAILURES_V6_56 - 1) as u32 {
            t += 1;
            let ip = format!("2001:db8:1:{:x}00::1", n + 0x10);
            assert_eq!(dir.resolve(t, &ip, "999999").0, ResolveOutcome::Unknown);
        }
        t += 1;
        assert_eq!(
            dir.resolve(t, "2001:db8:1:f000::1", "999999").0,
            ResolveOutcome::RateLimited
        );
        assert_eq!(
            dir.resolve(t, "2001:db8:1:e000::1", "999998").0,
            ResolveOutcome::RateLimited,
            "the whole /48 is blocked"
        );
        // A different /48 is a different client.
        assert_eq!(
            dir.resolve(t, "2001:db8:2::1", "999998").0,
            ResolveOutcome::Unknown
        );
        // Blocks lift after RATE_BLOCK_MS.
        assert_eq!(
            dir.resolve(t + RATE_BLOCK_MS, "2001:db8:1:e000::1", "999998")
                .0,
            ResolveOutcome::Unknown
        );
    }

    #[test]
    fn many_failures_raise_an_alert_but_never_refuse() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        // Spread over distinct IPv4 addresses: no tier trips.
        for n in 0..GLOBAL_FAILURE_ALERT as u32 * 2 {
            let ip = format!("198.18.{}.{}", n / 250, n % 250 + 1);
            assert_eq!(
                dir.resolve(T0 + u64::from(n), &ip, "999999").0,
                ResolveOutcome::Unknown
            );
            if n + 1 == GLOBAL_FAILURE_ALERT as u32 {
                assert!(dir.take_failure_alert(), "alert at the threshold");
            }
        }
        assert!(!dir.take_failure_alert(), "one alert per window");
        // An honest phone is never refused because of the flood.
        assert_eq!(
            dir.resolve(T0 + 1_000, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );
        // A new window can alert again.
        for n in 0..GLOBAL_FAILURE_ALERT as u32 {
            let ip = format!("198.19.{}.{}", n / 250, n % 250 + 1);
            let _ = dir.resolve(T0 + RATE_WINDOW_MS + u64::from(n), &ip, "999999");
        }
        assert!(dir.take_failure_alert());
    }

    #[test]
    fn regenerating_on_one_socket_never_spends_the_live_code_cap() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new((1..=1_000).collect());
        // Far more regenerations than any cap, same host and room.
        for n in 0..(LIVE_CODES_V4 as u64 * 3) {
            dir.allocate(T0 + n, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
                .unwrap();
        }
        assert_eq!(dir.len(), 1);
        assert_eq!(dir.live.get(HOST_IP), Some(&1));
    }

    #[test]
    fn live_codes_are_capped_per_ipv4_address() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new((1..=1_000).collect());
        for n in 0..LIVE_CODES_V4 as u32 {
            dir.allocate(T0, &mut rng, HOST_IP, &room_n(n), None)
                .unwrap();
        }
        // A NEW room from the same address is refused and changes nothing.
        let before = dir.len();
        assert_eq!(
            dir.allocate(T0, &mut rng, HOST_IP, &room_n(999), None),
            Err(AllocError::RateLimited)
        );
        assert_eq!(dir.len(), before);
        // Replacing one of its own codes is still fine (net zero).
        assert!(
            dir.allocate(T0, &mut rng, HOST_IP, &room_n(0), Some(HOST_ID))
                .is_ok()
        );
        // The neighbour address is independent (no /24 aggregate).
        assert!(
            dir.allocate(T0, &mut rng, "198.51.100.8", &room_n(999), None)
                .is_ok()
        );
        // Once codes expire and are swept, the address may mint again.
        let later = T0 + CODE_TTL_MS;
        let _ = dir.sweep(later);
        assert!(
            dir.allocate(later, &mut rng, HOST_IP, &room_n(1_000), None)
                .is_ok()
        );
    }

    #[test]
    fn live_codes_are_capped_per_ipv6_tier() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new((1..=1_000).collect());
        let mut r = 0u32;
        let mut alloc = |dir: &mut Directory, ip: &str| {
            r += 1;
            dir.allocate(T0, &mut rng, ip, &room_n(r), None)
        };
        // One /64 hopping addresses: capped at LIVE_CODES_V6_64.
        for n in 0..LIVE_CODES_V6_64 as u16 {
            alloc(&mut dir, &format!("2001:db8:7:700::{:x}", n + 1)).unwrap();
        }
        assert_eq!(
            alloc(&mut dir, "2001:db8:7:700::ffff"),
            Err(AllocError::RateLimited)
        );
        // Other /64s of the same /56 fill the /56 cap…
        for n in 0..(LIVE_CODES_V6_56 - LIVE_CODES_V6_64) as u32 {
            alloc(&mut dir, &format!("2001:db8:7:7{:02x}::1", n + 1)).unwrap();
        }
        assert_eq!(
            alloc(&mut dir, "2001:db8:7:7ff::1"),
            Err(AllocError::RateLimited)
        );
        // …and other /56s of the same /48 fill the /48 cap.
        for n in 0..(LIVE_CODES_V6_48 - LIVE_CODES_V6_56) as u32 {
            alloc(&mut dir, &format!("2001:db8:7:{:x}00::1", n + 0x10)).unwrap();
        }
        assert_eq!(
            alloc(&mut dir, "2001:db8:7:f000::1"),
            Err(AllocError::RateLimited)
        );
        assert_eq!(dir.len(), LIVE_CODES_V6_48);
        // A different /48 is unaffected.
        assert!(alloc(&mut dir, "2001:db8:8::1").is_ok());
    }

    #[test]
    fn restore_rebuilds_the_live_code_caps() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new((1..=1_000).collect());
        for n in 0..LIVE_CODES_V4 as u32 {
            dir.allocate(T0, &mut rng, HOST_IP, &room_n(n), None)
                .unwrap();
        }
        let codes: Vec<_> = dir.entries().map(|(c, e)| (c.clone(), e.clone())).collect();
        let mut revived = Directory::restore(codes, Vec::new(), Vec::new());
        // An eviction or redeploy does not hand the source a fresh cap.
        assert_eq!(
            revived.allocate(T0 + 1, &mut rng, HOST_IP, &room_n(999), None),
            Err(AllocError::RateLimited)
        );
        // Rows written before the caps existed count nowhere.
        let legacy = CodeEntry {
            allocated_by: None,
            ..revived.entries().next().unwrap().1.clone()
        };
        let legacy_only = Directory::restore(vec![("000999".to_string(), legacy)], [], []);
        assert!(legacy_only.live.is_empty());
    }

    #[test]
    fn rate_rows_keep_the_alarm_armed_without_live_codes() {
        let mut dir = Directory::new();
        let ip = "203.0.113.66";
        for i in 0..=RATE_MAX_FAILURES as u64 {
            let _ = dir.resolve(T0 + i, ip, "999999");
        }
        assert!(dir.is_empty());
        // No codes live, yet the blocked row still has a deadline.
        let block_end = T0 + RATE_MAX_FAILURES as u64 + RATE_BLOCK_MS;
        let (removed, next) = dir.sweep(T0 + 1_000);
        assert!(removed.is_empty());
        assert_eq!(next, Some(block_end));
        // At that deadline the sweep collects the row and goes idle.
        let (removed, next) = dir.sweep(block_end);
        assert_eq!(removed, vec![rate_key(ip)]);
        assert_eq!(next, None);
    }

    #[test]
    fn rotating_host_id_in_one_room_retires_the_previous_code() {
        // A host socket (or anyone dialing the room as host) that swaps
        // its hostId between allocations cannot stack codes on one room.
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2, 3, 4]);
        let first = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        let second = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID2))
            .unwrap();
        assert_eq!(dir.len(), 1);
        assert!(dir.entry(&first.code).is_none());
        // The retired code AND its host's reverse row are reported.
        assert!(second.removed.contains(&code_key(&first.code)));
        assert!(
            second
                .removed
                .contains(&host_key_storage(&host_index_key(Some(HOST_ID), &room(1))))
        );
        // The first hostId no longer owns anything: allocating for it in
        // another room retires nothing of the second host's.
        let third = dir
            .allocate(T0, &mut rng, HOST_IP, &room(2), Some(HOST_ID))
            .unwrap();
        assert!(third.removed.is_empty());
        assert!(dir.entry(&second.code).is_some());
        assert_eq!(dir.len(), 2);
    }

    #[test]
    fn replacement_never_reports_the_rewritten_host_row_as_removed() {
        // The worker writes the new reverse row, then deletes `removed`:
        // listing the host's own row there would erase it from storage
        // and break replacement after a DO eviction.
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2]);
        let first = dir
            .allocate(T0, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        let second = dir
            .allocate(T0, &mut rng, HOST_IP, &room(2), Some(HOST_ID))
            .unwrap();
        assert_eq!(first.host_storage_key, second.host_storage_key);
        assert!(second.removed.contains(&code_key(&first.code)));
        assert!(!second.removed.contains(&second.host_storage_key));
    }

    #[test]
    fn restore_rebuilds_the_room_index() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![1, 2]);
        let a = dir.allocate(T0, &mut rng, HOST_IP, &room(1), None).unwrap();
        let codes: Vec<_> = dir.entries().map(|(c, e)| (c.clone(), e.clone())).collect();
        let mut revived = Directory::restore(codes, Vec::new(), Vec::new());
        // No host rows survived, yet the room's code is still replaced.
        let b = revived
            .allocate(T0 + 1, &mut rng, HOST_IP, &room(1), Some(HOST_ID))
            .unwrap();
        assert!(b.removed.contains(&code_key(&a.code)));
        assert_eq!(revived.len(), 1);
    }
}
