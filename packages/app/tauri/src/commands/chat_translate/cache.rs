//! Chat-translation cache + outbound pacing core (pure, clock-injected).
//!
//! The M1 translation kernel is a pure decision layer: the async wrapper of a
//! later wave drives it with real time and a real HTTP client, while all the
//! stateful rules live here as plain synchronous structs/values this module
//! unit-tests exhaustively:
//!
//! - an LRU of translated lines per battle (capacity [`CACHE_CAPACITY`]),
//!   keyed by the normalized line text + the sorted target set + the
//!   glossary version — a battle switch drops everything ([`CacheCore::reset`]);
//! - in-flight coalescing: two callers asking for the same key at the same
//!   time must run ONE request ([`LookupStart::Owner`] vs
//!   [`LookupStart::Waiter`], resolved by [`CacheCore::finish`] /
//!   [`CacheCore::fail`]);
//! - the outbound gate: a sliding 10-requests-per-minute window and the
//!   2 s → 5 s → 15 s consecutive-failure backoff, both cleared on battle
//!   switch and on the first success.
//!
//! Every time-reading entry point takes the caller's `now_ms` instead of
//! consulting a clock, so tests drive exact timelines. The struct carries no
//! I/O, no locks and no async — the tokio adapter (single-flight map + shared
//! handle) lands with the chat panel wave, which is why the module currently
//! allows dead code in non-test builds.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};

/// LRU capacity per battle (contract §4).
pub(crate) const CACHE_CAPACITY: usize = 256;
/// Sliding rate-limit window, milliseconds.
pub(crate) const RATE_WINDOW_MS: i64 = 60_000;
/// Requests allowed per window.
pub(crate) const RATE_LIMIT: usize = 10;
/// Failure backoff ladder, milliseconds (the last step repeats).
pub(crate) const BACKOFF_STEPS_MS: [i64; 3] = [2_000, 5_000, 15_000];

/// Normalize a chat line for cache keying: trim the ends and collapse every
/// internal whitespace run to one space. Deliberately conservative — emoji or
/// punctuation are content, not noise, and a line the model saw verbatim must
/// map to the same key on a retry.
pub(crate) fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One cache key: the normalized line, the SORTED target-language set (so
/// target order never leaks into the cache) and the glossary version the
/// prompt was built with (a glossary edit invalidates translations that used
/// the old term list).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct CacheKey {
    text: String,
    targets: String,
    glossary_version: u32,
}

impl CacheKey {
    /// Build a key. Target tags are sorted and joined; a duplicate tag is
    /// harmless (the joined form simply contains it twice, and callers pass
    /// the resolved set, which is already unique).
    pub(crate) fn new(text: &str, targets: &[String], glossary_version: u32) -> Self {
        let mut tags: Vec<&str> = targets.iter().map(String::as_str).collect();
        tags.sort_unstable();
        Self {
            text: normalize_text(text),
            targets: tags.join(","),
            glossary_version,
        }
    }
}

/// What [`CacheCore::begin`] tells a caller to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LookupStart {
    /// A finished translation for the key is already cached.
    Cached(String),
    /// The caller owns the request: no entry and no other caller is running
    /// this key. It must end with [`CacheCore::finish`] or
    /// [`CacheCore::fail`].
    Owner,
    /// Another caller is already running this key. The caller must not issue
    /// a request; it re-checks the cache once the owner finishes (the tokio
    /// wrapper awaits the shared handle instead).
    Waiter,
}

/// The per-battle translation cache + outbound gate. See the module docs.
pub(crate) struct CacheCore {
    battle_id: String,
    capacity: usize,
    entries: HashMap<CacheKey, String>,
    /// LRU order: front = least recently used, back = most recently used.
    order: VecDeque<CacheKey>,
    /// Keys with an in-flight request; the value counts the callers that
    /// joined it ([`LookupStart::Waiter`] returns), for observability.
    in_flight: HashMap<CacheKey, usize>,
    /// Send instants inside the sliding window, oldest first.
    sends: VecDeque<i64>,
    /// Consecutive failures since the last success (drives the backoff step).
    consecutive_failures: u32,
    /// Earliest instant the next request may be issued, epoch ms.
    backoff_until: i64,
    hits: u64,
    misses: u64,
}

impl CacheCore {
    /// A fresh core for `battle_id` with the contract capacity.
    pub(crate) fn new(battle_id: &str) -> Self {
        Self::with_capacity(battle_id, CACHE_CAPACITY)
    }

    /// Test seam: the same core with an explicit LRU capacity.
    pub(crate) fn with_capacity(battle_id: &str, capacity: usize) -> Self {
        Self {
            battle_id: battle_id.to_owned(),
            capacity,
            entries: HashMap::new(),
            order: VecDeque::new(),
            in_flight: HashMap::new(),
            sends: VecDeque::new(),
            consecutive_failures: 0,
            backoff_until: 0,
            hits: 0,
            misses: 0,
        }
    }

    /// Switch battles: everything (cache, in-flight marks, rate window,
    /// backoff) belongs to ONE battle, so a new battle id starts clean. A
    /// repeat of the current id is a no-op and keeps the state.
    pub(crate) fn reset(&mut self, battle_id: &str) {
        if self.battle_id == battle_id {
            return;
        }
        self.battle_id = battle_id.to_owned();
        self.entries.clear();
        self.order.clear();
        self.in_flight.clear();
        self.sends.clear();
        self.consecutive_failures = 0;
        self.backoff_until = 0;
        self.hits = 0;
        self.misses = 0;
    }

    /// Current battle id.
    pub(crate) fn battle_id(&self) -> &str {
        &self.battle_id
    }

    /// Ask what to do for `key`: cached value, ownership of a fresh request,
    /// or wait behind an identical in-flight request.
    pub(crate) fn begin(&mut self, key: &CacheKey) -> LookupStart {
        if let Some(value) = self.entries.get(key).cloned() {
            self.hits += 1;
            self.touch(key);
            return LookupStart::Cached(value);
        }
        self.misses += 1;
        if let Some(waiters) = self.in_flight.get_mut(key) {
            *waiters += 1;
            return LookupStart::Waiter;
        }
        self.in_flight.insert(key.clone(), 1);
        LookupStart::Owner
    }

    /// The owner succeeded: store the value (evicting the LRU entry when
    /// full) and drop the in-flight mark.
    pub(crate) fn finish(&mut self, key: &CacheKey, value: &str) {
        self.in_flight.remove(key);
        if self.capacity == 0 {
            return;
        }
        if self.entries.insert(key.clone(), value.to_owned()).is_none() {
            self.order.push_back(key.clone());
        } else {
            self.touch(key);
        }
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    /// The owner failed: drop the in-flight mark so the next caller may
    /// retry (the token bucket/backoff gate still applies before a request).
    pub(crate) fn fail(&mut self, key: &CacheKey) {
        self.in_flight.remove(key);
    }

    /// Move a key to the most-recently-used end of the LRU order.
    fn touch(&mut self, key: &CacheKey) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.clone());
    }

    /// Records a successful request: the failure streak (and its backoff)
    /// clears.
    pub(crate) fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.backoff_until = 0;
    }

    /// Records a failed request and arms the next backoff step
    /// (2 s → 5 s → 15 s, the last repeating).
    pub(crate) fn record_failure(&mut self, now_ms: i64) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let step = BACKOFF_STEPS_MS
            [(self.consecutive_failures as usize - 1).min(BACKOFF_STEPS_MS.len() - 1)];
        self.backoff_until = now_ms.saturating_add(step);
    }

    /// Milliseconds until a request is allowed by the backoff ladder, 0 when
    /// it is not blocking.
    pub(crate) fn backoff_remaining_ms(&self, now_ms: i64) -> i64 {
        (self.backoff_until - now_ms).max(0)
    }

    /// Try to take one slot of the sliding 10-requests-per-minute window.
    /// Returns false while the backoff ladder blocks or the window is full.
    pub(crate) fn try_acquire_send_slot(&mut self, now_ms: i64) -> bool {
        if now_ms < self.backoff_until {
            return false;
        }
        while let Some(&oldest) = self.sends.front() {
            if now_ms - oldest >= RATE_WINDOW_MS {
                self.sends.pop_front();
            } else {
                break;
            }
        }
        if self.sends.len() >= RATE_LIMIT {
            return false;
        }
        self.sends.push_back(now_ms);
        true
    }

    /// Cached entries currently held (test/diagnostic).
    pub(crate) fn cache_len(&self) -> usize {
        self.entries.len()
    }

    /// Callers currently waiting behind in-flight requests (test/diagnostic).
    pub(crate) fn in_flight_count(&self) -> usize {
        self.in_flight.values().sum()
    }

    /// Cache hits since the last battle reset (test/diagnostic).
    pub(crate) fn hits(&self) -> u64 {
        self.hits
    }

    /// Cache misses since the last battle reset (test/diagnostic).
    pub(crate) fn misses(&self) -> u64 {
        self.misses
    }

    /// Consecutive failures since the last success (test/diagnostic).
    pub(crate) fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(text: &str) -> CacheKey {
        CacheKey::new(text, &["ja".to_string(), "zh-TW".to_string()], 7)
    }

    #[test]
    fn normalize_collapses_whitespace_only() {
        assert_eq!(normalize_text("  hello   world \n"), "hello world");
        // Emoji/punctuation are content, not noise.
        assert_eq!(normalize_text(" gg!  🎉 "), "gg! 🎉");
        assert_eq!(normalize_text(""), "");
    }

    #[test]
    fn keys_ignore_target_order_and_trim_text() {
        let a = CacheKey::new(
            "  hello  world ",
            &["ja".to_string(), "zh-TW".to_string()],
            1,
        );
        let b = CacheKey::new("hello world", &["zh-TW".to_string(), "ja".to_string()], 1);
        assert_eq!(a, b);
        let other_glossary =
            CacheKey::new("hello world", &["zh-TW".to_string(), "ja".to_string()], 2);
        assert_ne!(a, other_glossary);
    }

    #[test]
    fn lru_evicts_the_least_recently_used_entry() {
        let mut core = CacheCore::with_capacity("battle", 2);
        let (a, b, c) = (key("a"), key("b"), key("c"));
        assert_eq!(core.begin(&a), LookupStart::Owner);
        core.finish(&a, "A");
        assert_eq!(core.begin(&b), LookupStart::Owner);
        core.finish(&b, "B");
        // Touch A: B becomes the least recently used.
        assert_eq!(core.begin(&a), LookupStart::Cached("A".to_string()));
        assert_eq!(core.begin(&c), LookupStart::Owner);
        core.finish(&c, "C");
        assert_eq!(core.cache_len(), 2);
        assert_eq!(
            core.begin(&b),
            LookupStart::Owner,
            "B must have been evicted"
        );
        assert_eq!(core.begin(&a), LookupStart::Cached("A".to_string()));
        assert_eq!(core.begin(&c), LookupStart::Cached("C".to_string()));
    }

    #[test]
    fn concurrent_same_key_merges_into_one_owner() {
        let mut core = CacheCore::new("battle");
        let k = key("same line");
        assert_eq!(core.begin(&k), LookupStart::Owner);
        assert_eq!(core.begin(&k), LookupStart::Waiter);
        assert_eq!(core.begin(&k), LookupStart::Waiter);
        assert_eq!(core.in_flight_count(), 3);
        core.finish(&k, "translated");
        assert_eq!(core.in_flight_count(), 0);
        assert_eq!(
            core.begin(&k),
            LookupStart::Cached("translated".to_string())
        );
    }

    #[test]
    fn failed_owner_releases_the_key_for_a_retry() {
        let mut core = CacheCore::new("battle");
        let k = key("line");
        assert_eq!(core.begin(&k), LookupStart::Owner);
        core.fail(&k);
        assert_eq!(core.in_flight_count(), 0);
        assert_eq!(core.begin(&k), LookupStart::Owner);
        // A cached value is never overwritten by a second finish race order —
        // finish() is last-write-wins by design (the tokio adapter only calls
        // it from the owner).
        core.finish(&k, "v1");
        assert_eq!(core.begin(&k), LookupStart::Cached("v1".to_string()));
    }

    #[test]
    fn battle_reset_drops_cache_rate_window_and_backoff() {
        let mut core = CacheCore::new("battle-1");
        let k = key("line");
        core.begin(&k);
        core.finish(&k, "v");
        core.record_failure(1_000);
        // The armed 2 s backoff blocks the immediate retry, then expires.
        assert!(!core.try_acquire_send_slot(2_000));
        assert!(core.try_acquire_send_slot(3_000));
        assert!(core.cache_len() > 0);
        // Same id: no-op, state survives.
        core.reset("battle-1");
        assert_eq!(core.cache_len(), 1);
        assert_eq!(core.consecutive_failures(), 1);
        // New id: everything belongs to the old battle.
        core.reset("battle-2");
        assert_eq!(core.battle_id(), "battle-2");
        assert_eq!(core.cache_len(), 0);
        assert_eq!(core.in_flight_count(), 0);
        assert_eq!(core.consecutive_failures(), 0);
        assert_eq!(core.backoff_remaining_ms(1_000), 0);
        let k2 = key("line");
        assert_eq!(core.begin(&k2), LookupStart::Owner);
    }

    #[test]
    fn sliding_window_allows_ten_requests_per_minute() {
        let mut core = CacheCore::new("battle");
        for i in 0..RATE_LIMIT {
            assert!(core.try_acquire_send_slot(i as i64 * 1_000), "slot {i}");
        }
        assert!(!core.try_acquire_send_slot(9_999));
        // The first send (t=0) leaves the window at exactly 60 s.
        assert!(core.try_acquire_send_slot(RATE_WINDOW_MS));
        assert!(!core.try_acquire_send_slot(RATE_WINDOW_MS + 1));
        // A full window later the whole old set is gone.
        assert!(core.try_acquire_send_slot(RATE_WINDOW_MS + 2 * 60_000));
    }

    #[test]
    fn backoff_ladder_is_two_five_fifteen_then_repeats() {
        let mut core = CacheCore::new("battle");
        core.record_failure(1_000);
        assert_eq!(core.backoff_remaining_ms(1_000), 2_000);
        assert!(!core.try_acquire_send_slot(2_000));
        assert!(core.try_acquire_send_slot(3_000));
        core.record_failure(3_000);
        assert_eq!(core.backoff_remaining_ms(3_000), 5_000);
        core.record_failure(8_000);
        assert_eq!(core.backoff_remaining_ms(8_000), 15_000);
        core.record_failure(23_000);
        assert_eq!(
            core.backoff_remaining_ms(23_000),
            15_000,
            "last step repeats"
        );
        // Success clears the streak and the backoff.
        core.record_success();
        assert_eq!(core.consecutive_failures(), 0);
        assert_eq!(core.backoff_remaining_ms(23_000), 0);
        assert!(core.try_acquire_send_slot(23_000));
    }

    #[test]
    fn backoff_blocks_even_with_rate_slots_free() {
        let mut core = CacheCore::new("battle");
        assert!(core.try_acquire_send_slot(0));
        core.record_failure(0);
        assert!(!core.try_acquire_send_slot(1_999));
        assert!(core.try_acquire_send_slot(2_000));
    }

    #[test]
    fn cache_capacity_zero_stores_nothing() {
        let mut core = CacheCore::with_capacity("battle", 0);
        let k = key("line");
        assert_eq!(core.begin(&k), LookupStart::Owner);
        core.finish(&k, "v");
        assert_eq!(core.begin(&k), LookupStart::Owner);
    }
}
