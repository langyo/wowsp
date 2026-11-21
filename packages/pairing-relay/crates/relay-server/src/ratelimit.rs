//! Per-IP hourly budget windows (contract §3.5: /api/lookup/* 240/h;
//! §5.2 step 4: announce 10/h) — in-memory-first with a SQLite
//! write-through so a restart inherits the standing window instead of
//! resetting it. Fixed one-hour windows anchored at the first request
//! inside the window (the same shape the Worker's KV counters use).

use std::collections::HashMap;
use std::sync::Mutex;

use crate::store::Store;

/// One budget: `limit` requests per `window_secs`, keyed `"<bucket>:<ip>"`.
pub struct RateLimiter {
    limit: u32,
    window_secs: i64,
    bucket: String,
    windows: Mutex<HashMap<String, Window>>,
    store: Store,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Window {
    count: u32,
    start: i64,
}

impl RateLimiter {
    /// Build (hydrating persisted windows from the store).
    pub fn new(bucket: &str, limit: u32, window_secs: i64, store: Store) -> Self {
        let mut windows = HashMap::new();
        for (key, count, start) in store.load_rates() {
            if let Some(ip) = key.strip_prefix(&format!("{bucket}:")) {
                windows.insert(ip.to_string(), Window { count, start });
            }
        }
        Self {
            limit,
            window_secs,
            bucket: bucket.to_string(),
            windows: Mutex::new(windows),
            store,
        }
    }

    /// Count one request. `Ok(())` when it fits; `Err(retry_after_secs)`
    /// when the IP exhausted this window (the request is NOT counted).
    pub fn check(&self, ip: &str, now: i64) -> Result<(), u64> {
        let mut windows = self.windows.lock().unwrap();
        let window = windows.entry(ip.to_string()).or_insert(Window {
            count: 0,
            start: now,
        });
        if now >= window.start + self.window_secs {
            // The window slid: a fresh one starts here.
            *window = Window {
                count: 0,
                start: now,
            };
        }
        if window.count >= self.limit {
            let retry = (window.start + self.window_secs - now).max(1) as u64;
            return Err(retry);
        }
        window.count += 1;
        if window.count == 1 {
            self.store.delete_rate(&self.key(ip));
        } else {
            self.store
                .put_rate(&self.key(ip), window.count, window.start);
        }
        Ok(())
    }

    fn key(&self, ip: &str) -> String {
        format!("{}:{ip}", self.bucket)
    }

    /// Drop windows that ended before `now` (the periodic sweep).
    pub fn sweep(&self, now: i64) {
        let mut windows = self.windows.lock().unwrap();
        windows.retain(|ip, w| {
            let live = now < w.start + self.window_secs;
            if !live {
                self.store.delete_rate(&self.key(ip));
            }
            live
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter(limit: u32) -> (tempfile::TempDir, RateLimiter) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let rl = RateLimiter::new("lookup", limit, 3600, store);
        (dir, rl)
    }

    #[test]
    fn window_allows_the_limit_then_blocks_with_retry() {
        let (_d, rl) = limiter(2);
        assert!(rl.check("203.0.113.1", 1_000).is_ok());
        assert!(rl.check("203.0.113.1", 1_500).is_ok());
        // Third inside the window: refused, with the full window left.
        assert_eq!(rl.check("203.0.113.1", 2_000), Err(3_600 - 1_000));
        // A different IP has its own window.
        assert!(rl.check("203.0.113.2", 2_000).is_ok());
    }

    #[test]
    fn window_resets_after_the_hour() {
        let (_d, rl) = limiter(1);
        assert!(rl.check("203.0.113.1", 1_000).is_ok());
        assert_eq!(rl.check("203.0.113.1", 4_599), Err(1), "still inside");
        // Exactly window_start + 3600 opens a fresh window…
        assert!(rl.check("203.0.113.1", 1_000 + 3600).is_ok());
        // …whose single slot (limit 1) is now spent.
        assert!(rl.check("203.0.113.1", 1_000 + 3601).is_err());
    }

    #[test]
    fn blocked_requests_do_not_extend_the_window() {
        let (_d, rl) = limiter(1);
        assert!(rl.check("203.0.113.1", 1_000).is_ok());
        // Hammer past the limit — the retry hint still points at the
        // ORIGINAL window end (a flood cannot push it out).
        for t in [2_000i64, 3_000, 4_000] {
            assert_eq!(rl.check("203.0.113.1", t), Err((4_600 - t) as u64));
        }
    }

    #[test]
    fn counters_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        {
            let rl = RateLimiter::new("lookup", 2, 3600, store.clone());
            assert!(rl.check("203.0.113.9", 1_000).is_ok());
            assert!(rl.check("203.0.113.9", 1_100).is_ok());
        }
        // "Restart": a fresh limiter over the same store inherits the
        // exhausted window.
        let rl = RateLimiter::new("lookup", 2, 3600, store);
        assert_eq!(rl.check("203.0.113.9", 1_200), Err(4_600 - 1_200));
    }

    #[test]
    fn sweep_drops_ended_windows_only() {
        let (_d, rl) = limiter(1);
        assert!(rl.check("203.0.113.1", 1_000).is_ok());
        // Not ended yet: the sweep keeps it, the budget stays spent.
        rl.sweep(1_000 + 3599);
        assert_eq!(rl.check("203.0.113.1", 1_000 + 3599), Err(1));
        // Ended: the sweep drops it, the next request starts fresh.
        rl.sweep(1_000 + 3600);
        assert!(rl.check("203.0.113.1", 1_000 + 3601).is_ok());
    }
}
