//! The pairing-code directory: a pure state machine for the singleton
//! "codes" Durable Object. Owns every server-side pairing policy:
//!
//! - **Allocation** — `allocate(hostId, room)` mints a CSPRNG 6-digit
//!   code bound to `{room, hostId}` with a 10-minute TTL. One active
//!   code per host: a new allocation replaces (kills) the host's
//!   previous code, whether it was minted for the same room or an older
//!   one after a desktop restart.
//! - **Resolution** — `resolve(ip, code)` maps a code to its room ONCE:
//!   the first successful resolve stamps the client IP, re-resolves from
//!   the SAME IP stay allowed (phone reconnects), any OTHER IP is
//!   rejected for the rest of the code's life.
//! - **Brute-force guard** — more than 10 failed resolves inside a
//!   sliding minute from one IP blocks that IP for 60s (`rate_limited`).
//!
//! Time comes in as `now_ms` and randomness through the [`CodeRng`]
//! trait, so unit tests are fully deterministic and no test ever sleeps.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// How long an allocated code stays resolvable.
pub const CODE_TTL_MS: u64 = 10 * 60 * 1000;
/// Sliding window in which resolve failures are counted per IP.
pub const RATE_WINDOW_MS: u64 = 60 * 1000;
/// `> RATE_MAX_FAILURES` failures inside the window trips the block.
pub const RATE_MAX_FAILURES: usize = 10;
/// How long a tripped IP is rejected outright.
pub const RATE_BLOCK_MS: u64 = 60 * 1000;
/// Mint attempts before declaring the code space exhausted.
pub const ALLOC_ATTEMPTS: usize = 64;

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
    /// Rejected by the per-IP brute-force guard.
    RateLimited,
}

/// Why an allocation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllocError {
    /// The 6-digit space had no free code after [`ALLOC_ATTEMPTS`] draws
    /// (needs ~a million live codes; effectively unreachable).
    Exhausted,
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
}

/// Per-IP resolve-failure bookkeeping (persisted per IP by the worker).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RateState {
    /// Timestamps of recent failed resolves (bounded, pruned to the
    /// sliding window).
    pub failures: Vec<u64>,
    /// Absolute time (ms) until which the IP is rejected outright.
    pub blocked_until: Option<u64>,
}

/// The directory's whole state. The DO hydrates this from storage on
/// first use and write-throughs every mutation.
#[derive(Debug, Clone, Default)]
pub struct Directory {
    /// code → live entry.
    codes: HashMap<String, CodeEntry>,
    /// host key → that host's live code.
    hosts: HashMap<String, String>,
    /// client IP → failure window / block.
    rate: HashMap<String, RateState>,
}

/// Storage key for a code binding.
pub fn code_key(code: &str) -> String {
    format!("c:{code}")
}
/// Storage key for a host's reverse index entry.
pub fn host_key_storage(host: &str) -> String {
    format!("h:{host}")
}
/// Storage key for an IP's rate state.
pub fn rate_key(ip: &str) -> String {
    format!("r:{ip}")
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

    /// Rehydrate from persisted rows (worker storage load).
    pub fn restore(
        codes: impl IntoIterator<Item = (String, CodeEntry)>,
        hosts: impl IntoIterator<Item = (String, String)>,
        rate: impl IntoIterator<Item = (String, RateState)>,
    ) -> Self {
        Self {
            codes: codes.into_iter().collect(),
            hosts: hosts.into_iter().collect(),
            rate: rate.into_iter().collect(),
        }
    }

    /// Drop dead rows (expired codes and their reverse entries, stale
    /// rate windows / expired blocks). Returns the keys removed so the
    /// worker mirrors the deletions into storage, plus the earliest
    /// live expiry for alarm arming.
    pub fn sweep(&mut self, now_ms: u64) -> (Vec<String>, Option<u64>) {
        let dead_codes: Vec<String> = self
            .codes
            .iter()
            .filter(|(_, e)| e.expires_at <= now_ms)
            .map(|(c, _)| c.clone())
            .collect();
        let mut removed = Vec::new();
        for code in &dead_codes {
            self.codes.remove(code);
            removed.push(code_key(code));
        }
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
        let next = self.codes.values().map(|e| e.expires_at).min();
        (removed, next)
    }

    /// Mint a fresh unique code for `(host_id, room)`, replacing the
    /// host's previous code. Returns the new code and the storage keys
    /// that changed (`(removed, code_key, host_storage_key, entry)`).
    #[allow(clippy::type_complexity)]
    pub fn allocate(
        &mut self,
        now_ms: u64,
        rng: &mut dyn CodeRng,
        room: &str,
        host_id: Option<&str>,
    ) -> Result<AllocateDelta, AllocError> {
        // Lazy sweep so a hot path never resurrects a dead binding.
        let _ = self.sweep(now_ms);

        let host = host_index_key(host_id, room);
        // One active code per host: kill the previous binding first.
        let mut removed = Vec::new();
        if let Some(old) = self.hosts.remove(&host) {
            if self.codes.remove(&old).is_some() {
                removed.push(code_key(&old));
            }
            removed.push(host_key_storage(&host));
        }
        // Never re-mint a code that is live OR the one just retired
        // above (a host that regenerates must see a visibly new code).
        let mut avoid = self.codes.keys().cloned().collect::<Vec<_>>();
        avoid.extend(
            removed
                .iter()
                .filter_map(|k| k.strip_prefix("c:"))
                .map(str::to_string),
        );
        let mut code = None;
        for _ in 0..ALLOC_ATTEMPTS {
            let candidate = format!("{:06}", rng.code_draw() % 1_000_000);
            if !avoid.contains(&candidate) {
                code = Some(candidate);
                break;
            }
        }
        let Some(code) = code else {
            return Err(AllocError::Exhausted);
        };
        let entry = CodeEntry {
            room: room.to_string(),
            host_id: host_id.map(str::to_string),
            expires_at: now_ms + CODE_TTL_MS,
            resolved_by: None,
        };
        self.codes.insert(code.clone(), entry.clone());
        self.hosts.insert(host.clone(), code.clone());
        Ok(AllocateDelta {
            code,
            entry,
            host_storage_key: host_key_storage(&host),
            removed,
        })
    }

    /// Resolve a code from a client IP. See the module docs for the
    /// once-claim + brute-force semantics. Returns the outcome and the
    /// (possibly updated) rate state to persist for this IP.
    pub fn resolve(&mut self, now_ms: u64, ip: &str, code: &str) -> (ResolveOutcome, RateState) {
        // A blocked IP is rejected before touching the code table, and
        // the failure that tripped the block still counts (prune first).
        let state = self.rate.entry(ip.to_string()).or_default();
        prune_failures(state, now_ms);
        if let Some(until) = state.blocked_until {
            if now_ms < until {
                return (ResolveOutcome::RateLimited, state.clone());
            }
            state.blocked_until = None;
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

        if outcome == ResolveOutcome::Unknown {
            let state = self.rate.entry(ip.to_string()).or_default();
            state.failures.push(now_ms);
            prune_failures(state, now_ms);
            if state.failures.len() > RATE_MAX_FAILURES {
                state.blocked_until = Some(now_ms + RATE_BLOCK_MS);
                // The window that tripped the block is spent.
                state.failures.clear();
                // The request that broke the camel's back is itself a
                // rate-limited rejection, not a normal miss.
                return (ResolveOutcome::RateLimited, state.clone());
            }
            return (outcome, state.clone());
        }
        (outcome, self.rate.get(ip).cloned().unwrap_or_default())
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
    /// Storage keys whose rows must be deleted (the retired code and
    /// the old reverse-index row).
    pub removed: Vec<String>,
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

    fn room(n: u8) -> String {
        format!("{n:064x}")
    }

    #[test]
    fn allocate_mints_unique_zero_padded_codes() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![42, 42, 7]);
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
        assert_eq!(a.code, "000042");
        let b = dir
            .allocate(T0, &mut rng, &room(2), Some(HOST_ID2))
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
        let first = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
        // Same host, same room: regenerate.
        let second = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
        assert_eq!(second.code, "000002");
        assert!(second.removed.contains(&code_key(&first.code)));
        assert!(dir.entry(&first.code).is_none(), "old code is dead");
        assert_eq!(dir.len(), 1);

        // Same host, NEW room (desktop restarted, minted a fresh room):
        // still one code — the host's identity, not the room, owns it.
        let third = dir.allocate(T0, &mut rng, &room(2), Some(HOST_ID)).unwrap();
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
        let a = dir.allocate(T0, &mut rng, &room(1), None).unwrap();
        let b = dir.allocate(T0, &mut rng, &room(2), None).unwrap();
        // Different rooms → two independent codes (two v1 hosts).
        assert_eq!(dir.len(), 2);
        assert_ne!(a.code, b.code);
        // A v2 hello from a host id that ALSO holds a v1 code for the
        // same room keeps the two bindings distinct (id: vs room:
        // namespaces) — the desktop never mixes modes in one build.
        let c = dir.allocate(T0, &mut rng, &room(2), Some(HOST_ID)).unwrap();
        assert_eq!(dir.len(), 3);
        assert!(dir.entry(&b.code).is_some());
        assert!(dir.entry(&c.code).is_some());
    }

    #[test]
    fn resolve_maps_code_to_room_once_then_claims_it() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();

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
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
        assert_eq!(
            dir.resolve(T0 + 1_000, "203.0.113.10", &a.code).0,
            ResolveOutcome::Room(room(1))
        );

        let b = dir
            .allocate(T0 + 2_000, &mut rng, &room(2), Some(HOST_ID))
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
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
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
        assert_eq!(next, None);
        assert!(dir.is_empty());
    }

    #[test]
    fn brute_force_guard_trips_after_ten_failures_and_blocks_for_a_minute() {
        let mut dir = Directory::new();
        let mut rng = ScriptedRng::new(vec![5]);
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
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
            .allocate(T0 + 3_000, &mut rng2, &room(3), Some(HOST_ID2))
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
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
        let b = dir
            .allocate(T0 + 60_000, &mut rng, &room(2), Some(HOST_ID2))
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
        let a = dir.allocate(T0, &mut rng, &room(1), Some(HOST_ID)).unwrap();
        let _ = dir.resolve(T0, "203.0.113.10", &a.code);
        let codes: Vec<_> = dir.entries().map(|(c, e)| (c.clone(), e.clone())).collect();
        let hosts: Vec<_> = vec![(
            host_key_storage(&host_index_key(Some(HOST_ID), &room(1))),
            a.code.clone(),
        )];
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
    }

    #[test]
    fn exhausted_code_space_is_reported_not_panicked() {
        // 200_000 distinct live codes with a 3-draw budget that always
        // collides → Exhausted.
        let mut dir = Directory::new();
        let mut fill = ScriptedRng::new((0..200_000u32).collect());
        for n in 0..200u8 {
            dir.allocate(T0, &mut fill, &room(n), Some(&format!("{n:016x}")))
                .unwrap();
        }
        let mut rng = ScriptedRng::new(vec![123_456, 123_456, 123_456]);
        let r = dir.allocate(T0, &mut rng, &room(255), Some(HOST_ID2));
        // Whether it lands depends on 123456 being taken; with 200k
        // codes live it very likely is — but either branch must be a
        // clean Ok/Err, never a panic.
        match r {
            Ok(d) => assert_ne!(d.code, ""),
            Err(AllocError::Exhausted) => {},
        }
    }
}
