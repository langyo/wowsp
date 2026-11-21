//! SQLite storage — the native stand-in for the Workers KV/DO seams
//! (contract §7: "SQLite + memory"). One `wowsp-server.db` in the data
//! dir, WAL mode, single connection behind a std Mutex (single-writer is
//! the documented scale here: a stats cache node bounded by the per-IP
//! hourly budget). Tables:
//!
//! - `blocks` — cached lookup envelopes keyed by CID (§4); `expires_at`
//!   is `fetchedAt + ttl + 24 h` (the late-peer-hit grace, §4.3).
//! - `peers` — the announce registry (§5.2): 48 h TTL, private rows
//!   stored but never listed (§5.3), 128-row cap.
//! - `battle_snapshots` — the `battle:<route>` KV-mirror stand-in: the
//!   last battle frame per route, served to cold subscribers within its
//!   retention window (relay-core snapshot policy).
//! - `rate_counters` — hourly per-IP windows, in-memory-first with a
//!   write-through here so a restart keeps the budget honest (§3.5).

use std::path::Path;
use std::sync::Mutex;

use relay_core::peers::{PEER_TTL_SECS, PEERS_MAX};
use rusqlite::Connection;

/// One registry row as stored: the FULL relay-core PeerRow JSON in the
/// doc column (single source for the wire shape) plus indexed columns
/// the SQL layer needs (privacy flag, TTL window, eviction order).
#[derive(Debug, Clone, PartialEq)]
pub struct PeerRecord {
    pub url: String,
    /// Serialized relay_core::peers::PeerRow.
    pub doc: String,
    pub private: bool,
    pub added_at: i64,
    pub last_seen_at: i64,
}

/// i64 spelling of relay-core's row lifetime for the SQL predicates.
const PEER_TTL_SECS_I64: i64 = PEER_TTL_SECS as i64;

/// Handle to the database; cheap to clone behind an Arc.
#[derive(Clone)]
pub struct Store {
    conn: std::sync::Arc<Mutex<Connection>>,
}

impl Store {
    /// Open (creating directories + schema as needed). WAL keeps readers
    /// unblocked while the single writer works.
    pub fn open(data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let conn = Connection::open(data_dir.join("wowsp-server.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5_000)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS blocks (
                 cid          TEXT PRIMARY KEY,
                 envelope     BLOB NOT NULL,
                 expires_at   INTEGER NOT NULL,
                 request_line TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS peers (
                 url          TEXT PRIMARY KEY,
                 doc          TEXT NOT NULL,
                 private      INTEGER NOT NULL,
                 added_at     INTEGER NOT NULL,
                 last_seen_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS battle_snapshots (
                 route      TEXT PRIMARY KEY,
                 frame      BLOB NOT NULL,
                 updated_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rate_counters (
                 key          TEXT PRIMARY KEY,
                 count        INTEGER NOT NULL,
                 window_start INTEGER NOT NULL
             );",
        )?;
        Ok(Self {
            conn: std::sync::Arc::new(Mutex::new(conn)),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        let Ok(conn) = self.conn.lock() else {
            return None;
        };
        f(&conn).ok()
    }

    // ── blocks (§4) ───────────────────────────────────────────────────

    /// Store one envelope row (INSERT OR REPLACE — a refresh rewrites).
    /// `request_line` is the canonical line the CID was derived from, so
    /// serving re-verifies the content addressing on PEER-sourced rows
    /// (§4.2: a lying peer's row fails the hash check and is dropped).
    pub fn put_block(&self, cid: &str, envelope: &str, expires_at: i64, request_line: &str) {
        let _ = self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO blocks (cid, envelope, expires_at, request_line)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![cid, envelope.as_bytes(), expires_at, request_line],
            )
        });
    }

    /// Fetch one row (the grace window is the READER's decision: the
    /// lookup path checks fetchedAt+ttl itself, the block routes serve
    /// anything still stored — late peer hits, §4.3).
    pub fn get_block(&self, cid: &str) -> Option<(String, i64, String)> {
        self.with(|c| {
            c.query_row(
                "SELECT envelope, expires_at, request_line FROM blocks WHERE cid = ?1",
                rusqlite::params![cid],
                |row| {
                    let blob: Vec<u8> = row.get(0)?;
                    Ok((
                        String::from_utf8_lossy(&blob).into_owned(),
                        row.get(1)?,
                        row.get(2)?,
                    ))
                },
            )
        })
    }

    /// Drop a row that failed its content check (§4.2: dropped, never
    /// served).
    pub fn delete_block(&self, cid: &str) {
        let _ =
            self.with(|c| c.execute("DELETE FROM blocks WHERE cid = ?1", rusqlite::params![cid]));
    }

    /// Drop rows past their grace window; returns how many went.
    pub fn sweep_blocks(&self, now: i64) -> usize {
        self.with(|c| {
            c.execute(
                "DELETE FROM blocks WHERE expires_at <= ?1",
                rusqlite::params![now],
            )
        })
        .unwrap_or(0)
    }

    // ── peers (§5) ────────────────────────────────────────────────────

    /// Upsert a registry row: re-announcing refreshes lastSeenAt/doc but
    /// keeps addedAt (§5.2 step 3), then enforces relay-core's 128-row
    /// cap by evicting the oldest lastSeenAt rows.
    pub fn put_peer(&self, row: &relay_core::peers::PeerRow, now: i64) {
        let doc = serde_json::to_string(row).unwrap_or_default();
        let _ = self.with(|c| {
            c.execute(
                "INSERT INTO peers (url, doc, private, added_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(url) DO UPDATE SET
                   doc = excluded.doc,
                   private = excluded.private,
                   last_seen_at = excluded.last_seen_at",
                rusqlite::params![
                    row.url,
                    doc,
                    row.private as i64,
                    row.added_at.min(now as u64) as i64
                ],
            )
        });
        self.enforce_peer_cap();
    }

    /// List rows still inside their 48 h TTL (§5.2 step 3; privacy
    /// filtering happens in relay-core's merge, §5.3, so the local
    /// parse reads everything). Ordered freshest-first.
    pub fn list_peers(&self, now: i64, include_private: bool) -> Vec<PeerRecord> {
        let privacy_clause = if include_private {
            ""
        } else {
            "AND private = 0"
        };
        let sql = format!(
            "SELECT url, doc, private, added_at, last_seen_at FROM peers
             WHERE last_seen_at > ?1 {privacy_clause}
             ORDER BY last_seen_at DESC"
        );
        self.with(|c| {
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![now - PEER_TTL_SECS_I64], |row| {
                Ok(PeerRecord {
                    url: row.get(0)?,
                    doc: row.get(1)?,
                    private: row.get::<_, i64>(2)? != 0,
                    added_at: row.get(3)?,
                    last_seen_at: row.get(4)?,
                })
            })?;
            rows.collect()
        })
        .unwrap_or_default()
    }

    fn enforce_peer_cap(&self) {
        let _ = self.with(|c| {
            c.execute(
                "DELETE FROM peers WHERE url IN (
                     SELECT url FROM peers ORDER BY last_seen_at DESC
                     LIMIT -1 OFFSET ?1
                 )",
                rusqlite::params![PEERS_MAX as i64],
            )
        });
    }

    /// Drop rows past their 48 h TTL (the periodic sweep; reads also
    /// lazy-filter, this just reclaims space).
    pub fn sweep_peers(&self, now: i64) -> usize {
        self.with(|c| {
            c.execute(
                "DELETE FROM peers WHERE last_seen_at <= ?1",
                rusqlite::params![now - PEER_TTL_SECS_I64],
            )
        })
        .unwrap_or(0)
    }

    // ── battle snapshots (the battle:<route> mirror, §7) ─────────────

    pub fn put_snapshot(&self, route: &str, frame: &str, updated_at: i64, expires_at: i64) {
        let _ = self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO battle_snapshots
                   (route, frame, updated_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![route, frame.as_bytes(), updated_at, expires_at],
            )
        });
    }

    /// The retained frame for a route, if still inside its window (the
    /// cold-subscriber path; retention policy is relay-core's).
    pub fn get_snapshot(&self, route: &str, now: i64) -> Option<String> {
        self.with(|c| {
            c.query_row(
                "SELECT frame FROM battle_snapshots WHERE route = ?1 AND expires_at > ?2",
                rusqlite::params![route, now],
                |row| {
                    let blob: Vec<u8> = row.get(0)?;
                    Ok(String::from_utf8_lossy(&blob).into_owned())
                },
            )
        })
    }

    pub fn sweep_snapshots(&self, now: i64) -> usize {
        self.with(|c| {
            c.execute(
                "DELETE FROM battle_snapshots WHERE expires_at <= ?1",
                rusqlite::params![now],
            )
        })
        .unwrap_or(0)
    }

    // ── rate counters (§3.5, §5.2 step 4) ────────────────────────────

    /// Persist one window (called from the in-memory limiter's
    /// write-through).
    pub fn put_rate(&self, key: &str, count: u32, window_start: i64) {
        let _ = self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO rate_counters (key, count, window_start)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![key, count, window_start],
            )
        });
    }

    /// Load every counter (startup hydration).
    pub fn load_rates(&self) -> Vec<(String, u32, i64)> {
        self.with(|c| {
            let mut stmt = c.prepare("SELECT key, count, window_start FROM rate_counters")?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect()
        })
        .unwrap_or_default()
    }

    pub fn delete_rate(&self, key: &str) {
        let _ = self.with(|c| {
            c.execute(
                "DELETE FROM rate_counters WHERE key = ?1",
                rusqlite::params![key],
            )
        });
    }

    /// Drop windows that ended before `now` (the periodic sweep).
    pub fn sweep_rates(&self, now: i64, window_secs: i64) -> usize {
        self.with(|c| {
            c.execute(
                "DELETE FROM rate_counters WHERE window_start + ?1 <= ?2",
                rusqlite::params![window_secs, now],
            )
        })
        .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn blocks_round_trip_and_sweep() {
        let (_d, s) = tmp();
        s.put_block("cidA", "{\"v\":1}", 1_000, "GET https://x/");
        assert_eq!(
            s.get_block("cidA"),
            Some(("{\"v\":1}".into(), 1_000, "GET https://x/".into()))
        );
        assert_eq!(s.get_block("cidB"), None);
        s.delete_block("cidA");
        assert_eq!(s.get_block("cidA"), None);
        s.put_block("cidA", "{\"v\":1}", 1_000, "GET https://x/");
        assert_eq!(s.sweep_blocks(1_000), 1, "expires_at <= now goes");
        assert_eq!(s.get_block("cidA"), None);
    }

    /// A store-level row builder for the tests below.
    fn peer_row(url: &str, private: bool, now: i64) -> relay_core::peers::PeerRow {
        relay_core::peers::PeerRow {
            url: url.to_string(),
            capabilities: relay_core::manifest::CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true,
            },
            role: "community".into(),
            node_id: "8f14e45fceea167a5a36dedd4bea2543".into(),
            added_at: now as u64,
            last_seen_at: now as u64,
            notice: None,
            private,
        }
    }

    #[test]
    fn peers_upsert_keeps_added_at_and_refreshes_last_seen() {
        let (_d, s) = tmp();
        s.put_peer(&peer_row("https://a.example", false, 100), 100);
        let mut newer = peer_row("https://a.example", false, 300);
        newer.node_id = "ff".repeat(16);
        s.put_peer(&newer, 300);
        let rows = s.list_peers(400, true);
        assert_eq!(rows.len(), 1);
        // The doc column carries the FULL relay-core row.
        let doc: relay_core::peers::PeerRow = serde_json::from_str(&rows[0].doc).unwrap();
        assert_eq!(doc.node_id, "ff".repeat(16));
        assert_eq!(rows[0].added_at, 100, "re-announce keeps addedAt");
        assert_eq!(rows[0].last_seen_at, 300);
        // 48 h lazy expiry on read (counted from the refreshed
        // lastSeenAt = 300).
        assert!(s.list_peers(300 + PEER_TTL_SECS as i64, true).is_empty());
        assert_eq!(s.list_peers(300 + PEER_TTL_SECS as i64 - 1, true).len(), 1);
    }

    #[test]
    fn private_rows_are_excluded_from_the_public_view() {
        let (_d, s) = tmp();
        s.put_peer(&peer_row("https://pub.example", false, 100), 100);
        s.put_peer(&peer_row("http://lan.example", true, 100), 100);
        assert_eq!(s.list_peers(100, false).len(), 1);
        assert_eq!(s.list_peers(100, true).len(), 2);
    }

    #[test]
    fn peer_cap_evicts_the_stalest_rows() {
        let (_d, s) = tmp();
        for n in 0..(PEERS_MAX + 5) {
            s.put_peer(
                &peer_row(&format!("https://p{n}.example"), false, n as i64),
                n as i64,
            );
        }
        assert_eq!(s.list_peers(10_000, true).len(), PEERS_MAX);
        // The five oldest went.
        assert!(
            s.list_peers(10_000, true)
                .iter()
                .all(|r| r.last_seen_at >= 5)
        );
    }

    #[test]
    fn snapshots_window_filter() {
        let (_d, s) = tmp();
        s.put_snapshot("r:asia:1", "frame", 0, 500);
        assert_eq!(s.get_snapshot("r:asia:1", 499), Some("frame".into()));
        assert_eq!(s.get_snapshot("r:asia:1", 500), None, "expiry is exclusive");
        assert_eq!(s.get_snapshot("r:eu:2", 0), None);
    }

    #[test]
    fn rate_counters_persist_and_sweep() {
        let (_d, s) = tmp();
        s.put_rate("lookup:1.2.3.4", 7, 100);
        assert_eq!(s.load_rates(), vec![("lookup:1.2.3.4".into(), 7, 100)]);
        s.delete_rate("lookup:1.2.3.4");
        assert!(s.load_rates().is_empty());
        s.put_rate("lookup:5.6.7.8", 1, 100);
        assert_eq!(s.sweep_rates(100 + 3600, 3600), 1);
        assert!(s.load_rates().is_empty());
    }
}
