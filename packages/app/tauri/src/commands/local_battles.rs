//! Local battle log — authoritative per-battle results derived from LOCAL
//! replay files.
//!
//! The water-table range views (1d / 7d / custom) used to infer a range from
//! cumulative snapshot deltas: a ship with no baseline row (first battle after
//! a cache gap, a fresh install) silently dropped out and the range came back
//! empty. Every completed replay the client writes carries the server's
//! BattleResults (0x22) payload, so this module decodes the local replay
//! corpus once per file and answers the real per-battle rows for the requested
//! account — the same authority the post-battle screen shows.
//!
//! Shape (mirrors commands/playtime.rs's replay battle ledger):
//!
//! * The walk reuses [`super::replay::walk_replays`] over
//!   [`super::game_context::replay_roots`] — every detected install's
//!   `replays/` folder, the resolved default dir and the user's pinned extra
//!   folders — so "which folders count as replays" can never drift from the
//!   playtime ledger and the replay rail.
//! * Candidates are filtered BEFORE the expensive packet-stream decode: the
//!   filename timestamp must sit in `[from - 1d, to + 1d]` (the filename is
//!   the only timestamp a replay carries) and the header lite's match group
//!   must be a water-table mode ("pvp" / "ranked", case-insensitive) — an
//!   operation / brawl / clan replay never pays the full decode.
//! * Successful decodes are cached on disk (`local-battle-log.json`, len +
//!   mtime keyed) together with the recorder's account id, so a later query
//!   (another window, a refresh, another account) answers cached rows instead
//!   of decoding the same files again. A FAILED decode is never cached — the
//!   next call retries it.
//! * At most [`DECODE_BUDGET`] fresh decodes run per call; the rest is
//!   reported as `pending` and a follow-up call continues, cache hits making
//!   every later round cheaper. The whole scan is blocking I/O under
//!   [`tokio::task::spawn_blocking`], never on the UI thread, and the
//!   load → scan → write-back sequence is serialized by one scan gate.
//!
//! The cache is DERIVED data (a replay's payload is the truth), so an
//! unreadable/stale cache file rebuilds instead of failing the range view —
//! unlike the playtime ledger's permanent history, which must never be reset.

use anyhow::{Result, anyhow};

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use wowsp_tauri_shared::{CommandResult, LocalBattle, LocalBattleLog};

/// The decode cache under the AppData root.
const CACHE_FILE: &str = "local-battle-log.json";
/// Bump when a cached row's SEMANTICS change (the extraction indices, the win
/// rule, the value sources) — a stale cache re-decodes once.
const CACHE_VERSION: u32 = 1;
/// Fresh full decodes allowed per call. A window with more candidates than
/// this answers what it has (`pending` = the rest) so one call never blocks
/// the UI thread pool for minutes; the webui's follow-up rounds finish the
/// corpus, and every already-decoded file is a cache hit from then on.
const DECODE_BUDGET: u32 = 24;
/// Slack around the requested window when matching by filename timestamp: the
/// unix range is computed in the frontend from a different clock/timezone
/// source than the replay filename's LOCAL wall time, so a candidate exactly
/// on the boundary still gets decoded; the final row filter below applies the
/// exact `[from_sec, to_sec]` window.
const WINDOW_SLACK_SECS: i64 = 86_400;
/// The match groups whose battles the water table counts (random + ranked).
const WATER_TABLE_MODES: [&str; 2] = ["pvp", "ranked"];

// ── BattleResults (0x22) player-array layout ───────────────────────────────
// Mirror of packages/webui/src/features/replay/postBattle.ts (the in-repo
// authority, re-verified against 126 replays / 417 players on client 15.8).
// A 14.x-era array is < 500 entries and its late fields sit 15 slots earlier —
// the 15.2 client inserted a 15-field block before `exp`.
const LEGACY_LAYOUT_MAX_LEN: usize = 500;
const LATE_SHIFT_MIN_INDEX: usize = 404;
const LATE_INDEX_SHIFT: usize = 15;

/// Team slot (0/1 = the two battle sides).
const INDEX_TEAM: usize = 6;
/// GameParams ship id.
const INDEX_SHIP: usize = 7;
/// `true` when the recorder's ship was not destroyed.
const INDEX_SURVIVED: usize = 21;
/// Ships sunk.
const INDEX_FRAGS: usize = 32;
/// Settlement base XP (late field — legacy layout shifts it back 15).
const INDEX_EXP: usize = 404;
/// Battle damage dealt (late field — legacy layout shifts it back 15).
const INDEX_DAMAGE: usize = 426;
/// The winning team id inside `commonList` (empirically verified against
/// real 15.x captures: equals the recorder's team exactly on wins).
const INDEX_COMMON_WINNER: usize = 3;

// ── persistent decode cache ────────────────────────────────────────────────

/// One decoded replay row plus the identity the wire row deliberately drops:
/// the cache answers every account's query, so a decode once paid must not be
/// tied to the account that happened to trigger it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedBattle {
    #[serde(flatten)]
    row: LocalBattle,
    /// `battleResults.accountDBID` — the account that recorded this replay.
    recorder_account_id: i64,
}

/// One cached decode. Identity = the file's `len` + `mtime_ms` (BOTH must
/// match the current stat), so any ordinary edit, rewrite or copy re-decodes.
/// The accepted stale corner is a same-length replacement within the same
/// millisecond — the game writes each replay exactly once, so that never
/// happens in practice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    len: u64,
    mtime_ms: u64,
    battle: CachedBattle,
}

/// The cache file: absolute replay path → its decoded row. The cache is not a
/// history — only live files are ever answered — so stale entries cost a few
/// hundred bytes, never correctness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BattleCache {
    version: u32,
    #[serde(default)]
    entries: std::collections::BTreeMap<String, CacheEntry>,
}

impl Default for BattleCache {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            entries: std::collections::BTreeMap::new(),
        }
    }
}

impl BattleCache {
    /// Whether the cached decode of `path` still matches its on-disk identity.
    fn hit(&self, path: &Path, len: u64, mtime_ms: u64) -> Option<&CacheEntry> {
        self.entries
            .get(&path.to_string_lossy().into_owned())
            .filter(|entry| entry.len == len && entry.mtime_ms == mtime_ms)
    }
}

fn load_cache_in(dir: &Path) -> Result<BattleCache> {
    let raw = match super::appdata::read_json_in(dir, CACHE_FILE) {
        Ok(Some(raw)) => raw,
        Ok(None) => return Ok(BattleCache::default()),
        // Derived data: an unreadable cache file (locked by a scanner, denied
        // by permissions) must not fail the range view — rebuild it from the
        // replays instead, exactly like a damaged payload below.
        Err(error) => {
            tracing::warn!(%error, "local battle log cache unreadable — rebuilding it from replays");
            return Ok(BattleCache::default());
        },
    };
    match serde_json::from_str::<BattleCache>(&raw) {
        Ok(cache) if cache.version == CACHE_VERSION => Ok(cache),
        Ok(cache) => {
            tracing::info!(
                version = cache.version,
                "local battle log cache schema stale — rebuilding it from replays"
            );
            Ok(BattleCache::default())
        },
        // Derived data: a damaged cache means every row re-decodes once, never
        // that the range view fails (see the module docs).
        Err(error) => {
            tracing::warn!(%error, "local battle log cache unreadable — rebuilding it from replays");
            Ok(BattleCache::default())
        },
    }
}

fn save_cache_in(dir: &Path, cache: &BattleCache) -> Result<()> {
    let json = serde_json::to_string(cache)
        .map_err(|e| anyhow!("serialize local battle log cache: {e}"))?;
    super::appdata::write_json_in(dir, CACHE_FILE, &json)
}

// ── candidate discovery (cheap filters before the full decode) ─────────────

/// One replay file that passed the pre-decode filters, with everything needed
/// to build its wire row after the packet-stream decode.
struct Candidate {
    path: PathBuf,
    len: u64,
    mtime_ms: u64,
    /// Filename timestamp in unix seconds.
    timestamp: i64,
    /// The filename's raw `YYYYMMDD[_HHMMSS]` date string (the wire row's
    /// `date_time`, the same form the replay list shows).
    date_time: String,
    /// Header-lite mode/date fields (the wire contract sources them from the
    /// replay header, not from BattleResults).
    match_group: Option<String>,
    scenario: Option<String>,
    event_type: Option<String>,
}

/// The filename timestamp (`YYYYMMDD_HHMMSS`) as unix seconds. A replay's only
/// timestamp source is its LOCAL-time filename.
fn timestamp_of(date_time: &str) -> Option<i64> {
    let (date, time) = date_time.split_once('_').unwrap_or((date_time, "000000"));
    let naive = NaiveDateTime::parse_from_str(&format!("{date}_{time}"), "%Y%m%d_%H%M%S").ok()?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(stamp) => Some(stamp.timestamp()),
        // Ambiguous fall-back hour: either instant is within the ±1 day slack,
        // pick the earliest for determinism.
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp()),
        // Wall time inside the DST spring-forward gap has no local instant; a
        // UTC reading still lands within the slack instead of losing the file.
        chrono::LocalResult::None => Some(naive.and_utc().timestamp()),
    }
}

fn filename_timestamp(path: &Path) -> Option<(i64, String)> {
    let date_time = super::replay::parse_datetime_from_filename(&path.to_string_lossy())?;
    timestamp_of(&date_time).map(|timestamp| (timestamp, date_time))
}

/// Random and ranked only (case-insensitive): everything else — operations,
/// brawls, clan battles, events — is not part of the water-table range views
/// and must never pay the full decode.
fn is_water_table_mode(match_group: Option<&str>) -> bool {
    match_group.is_some_and(|mode| {
        WATER_TABLE_MODES
            .iter()
            .any(|water_table| mode.eq_ignore_ascii_case(water_table))
    })
}

/// Walk every root and keep the files worth decoding, in a DETERMINISTIC order
/// (path-ascending; the filesystem walk order is not): a budget-limited call
/// and its follow-up then decode the same files in the same order.
fn walk_candidates(roots: &[PathBuf], from_sec: i64, to_sec: i64) -> (u32, Vec<Candidate>) {
    let mut files = Vec::new();
    for root in roots {
        super::replay::walk_replays(root, &mut files);
    }
    let scanned = files.len() as u32;
    let earliest = from_sec.saturating_sub(WINDOW_SLACK_SECS);
    let latest = to_sec.saturating_add(WINDOW_SLACK_SECS);
    let mut candidates = Vec::new();
    for file in files {
        // Filename first: a file outside the (slack-widened) window never
        // costs even a header read.
        let Some((timestamp, date_time)) = filename_timestamp(&file.path) else {
            continue;
        };
        if timestamp < earliest || timestamp > latest {
            continue;
        }
        let lite = super::replay::lite_from_path(&file.path);
        if !is_water_table_mode(lite.match_group.as_deref()) {
            continue;
        }
        candidates.push(Candidate {
            path: file.path,
            len: file.len,
            mtime_ms: file
                .mtime
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
            timestamp,
            date_time,
            match_group: lite.match_group,
            scenario: lite.scenario,
            event_type: lite.event_type,
        });
    }
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    (scanned, candidates)
}

// ── BattleResults extraction ───────────────────────────────────────────────

/// A JSON number as an integer (the client writes integers; a float or a
/// string-encoded id must not silently drop the row).
fn number_i64(value: &serde_json::Value) -> Option<i64> {
    if let Some(int) = value.as_i64() {
        return Some(int);
    }
    if let Some(float) = value.as_f64() {
        return float.is_finite().then(|| float.round() as i64);
    }
    value.as_str().and_then(|text| text.trim().parse().ok())
}

/// The recorder's own positional results array. `playersPublicInfo` maps
/// account-id strings to CLIENT_PUBLIC_RESULTS arrays; the recorder's entry is
/// normally keyed by its accountDBID, and the array's index 0 repeats that id
/// — accept either form so an unusual client keying still resolves.
fn self_result_row(
    players: &serde_json::Map<String, serde_json::Value>,
    recorder: i64,
) -> Option<&Vec<serde_json::Value>> {
    if let Some(row) = players
        .get(&recorder.to_string())
        .and_then(serde_json::Value::as_array)
    {
        return Some(row);
    }
    players.values().find_map(|value| {
        let row = value.as_array()?;
        (row.first().and_then(number_i64) == Some(recorder)).then_some(row)
    })
}

/// Project one replay's BattleResults JSON onto the wire row (with the
/// recorder identity the cache needs). `None` for a payload without a usable
/// recorder entry — it is not an authoritative local battle and is not cached.
fn extract_battle(raw: &str, candidate: &Candidate) -> Option<CachedBattle> {
    let document: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = document.as_object()?;
    let recorder = object.get("accountDBID").and_then(number_i64)?;
    let players = object.get("playersPublicInfo")?.as_object()?;
    let row = self_result_row(players, recorder)?;
    // Legacy (< 15.2) layout: arrays shorter than the cap sit their late
    // fields LATE_INDEX_SHIFT slots earlier (see the constants above).
    let legacy = row.len() < LEGACY_LAYOUT_MAX_LEN;
    let late = |index: usize| {
        if legacy && index >= LATE_SHIFT_MIN_INDEX {
            index - LATE_INDEX_SHIFT
        } else {
            index
        }
    };
    let team = row
        .get(INDEX_TEAM)
        .and_then(number_i64)
        .filter(|team| (0..=2).contains(team))
        .map(|team| team as i32);
    // `commonList[3]` is the winning team id; a win is only decidable when
    // both sides are a real team slot (0/1) — a draw / spectator / missing
    // list answers null, never a guessed boolean.
    let won = match (
        object
            .get("commonList")
            .and_then(serde_json::Value::as_array)
            .and_then(|list| list.get(INDEX_COMMON_WINNER))
            .and_then(number_i64),
        team,
    ) {
        (Some(winner), Some(team)) if matches!(winner, 0 | 1) && matches!(team, 0 | 1) => {
            Some(winner == i64::from(team))
        },
        _ => None,
    };
    Some(CachedBattle {
        row: LocalBattle {
            timestamp: candidate.timestamp,
            date_time: candidate.date_time.clone(),
            match_group: candidate.match_group.clone(),
            scenario: candidate.scenario.clone(),
            event_type: candidate.event_type.clone(),
            ship_id: row
                .get(INDEX_SHIP)
                .and_then(number_i64)
                .filter(|ship_id| *ship_id > 0),
            team,
            won,
            damage: row
                .get(late(INDEX_DAMAGE))
                .and_then(number_i64)
                .unwrap_or(0),
            frags: row.get(INDEX_FRAGS).and_then(number_i64).unwrap_or(0),
            survived: row
                .get(INDEX_SURVIVED)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            exp: row.get(late(INDEX_EXP)).and_then(number_i64),
        },
        recorder_account_id: recorder,
    })
}

/// Full decode of one candidate: packet stream → BattleResults → wire row.
/// `Ok(None)` when the replay decodes but carries no usable result payload
/// (legacy pre-12.6 captures have no BattleResults packet at all).
fn decode_battle(candidate: &Candidate) -> Result<Option<CachedBattle>> {
    let path = candidate.path.to_string_lossy();
    let stream = super::replay::decode_replay_stream_sync(&path)?;
    let Some(raw) = stream.battle_results.as_deref() else {
        return Ok(None);
    };
    Ok(extract_battle(raw, candidate))
}

// ── scan core ──────────────────────────────────────────────────────────────

/// Push a cached/decoded row onto the answer when it belongs to this query:
/// recorded by the requested account and inside the exact requested window.
fn push_row(
    battles: &mut Vec<LocalBattle>,
    battle: &CachedBattle,
    account_id: i64,
    from_sec: i64,
    to_sec: i64,
) {
    if battle.recorder_account_id != account_id {
        return;
    }
    if battle.row.timestamp < from_sec || battle.row.timestamp > to_sec {
        return;
    }
    battles.push(battle.row.clone());
}

/// The scan's pure core: walk, prefilter, answer cached rows, spend the decode
/// budget on fresh candidates and upsert successful decodes into `cache`.
fn scan_in(
    cache: &mut BattleCache,
    roots: &[PathBuf],
    account_id: i64,
    from_sec: i64,
    to_sec: i64,
    decode_budget: u32,
) -> LocalBattleLog {
    let (scanned, candidates) = walk_candidates(roots, from_sec, to_sec);
    let mut battles: Vec<LocalBattle> = Vec::new();
    let mut decoded = 0u32;
    let mut cache_hits = 0u32;
    let mut pending = 0u32;
    let mut budget = decode_budget;
    for candidate in candidates {
        if let Some(hit) = cache.hit(&candidate.path, candidate.len, candidate.mtime_ms) {
            cache_hits += 1;
            push_row(&mut battles, &hit.battle, account_id, from_sec, to_sec);
            continue;
        }
        if budget == 0 {
            pending += 1;
            continue;
        }
        budget -= 1;
        match decode_battle(&candidate) {
            Ok(Some(battle)) => {
                decoded += 1;
                push_row(&mut battles, &battle, account_id, from_sec, to_sec);
                cache.entries.insert(
                    candidate.path.to_string_lossy().into_owned(),
                    CacheEntry {
                        len: candidate.len,
                        mtime_ms: candidate.mtime_ms,
                        battle,
                    },
                );
            },
            // Not cached either way: the next call retries the file.
            Ok(None) => tracing::debug!(
                path = %candidate.path.display(),
                "local battle log: replay carries no BattleResults row"
            ),
            Err(error) => tracing::debug!(
                path = %candidate.path.display(),
                %error,
                "local battle log: replay decode failed — retrying on a later call"
            ),
        }
    }
    // Ascending by timestamp (stable, so equal stamps keep the deterministic
    // path order) — the order the range views plot.
    battles.sort_by_key(|battle| battle.timestamp);
    LocalBattleLog {
        battles,
        scanned,
        decoded,
        cache_hits,
        pending,
    }
}

/// Serialize every load → scan → write-back: two concurrent calls (two
/// windows, or the webui's follow-up rounds) must not clobber each other's
/// fresh cache entries. The command already runs this blocking work on the
/// blocking thread pool.
static LOCAL_BATTLE_SCAN_GATE: Mutex<()> = Mutex::new(());

/// Load the cache, scan the roots and write the cache back only when a decode
/// changed it.
fn scan_cached(
    dir: &Path,
    roots: &[PathBuf],
    account_id: i64,
    from_sec: i64,
    to_sec: i64,
    decode_budget: u32,
) -> Result<LocalBattleLog> {
    let _scan = LOCAL_BATTLE_SCAN_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut cache = load_cache_in(dir)?;
    let before = serde_json::to_string(&cache)
        .map_err(|e| anyhow!("serialize local battle log cache: {e}"))?;
    let log = scan_in(
        &mut cache,
        roots,
        account_id,
        from_sec,
        to_sec,
        decode_budget,
    );
    let after = serde_json::to_string(&cache)
        .map_err(|e| anyhow!("serialize local battle log cache: {e}"))?;
    if before != after {
        // Derived data — a failed write costs the next call its cache hits but
        // must never fail the range view.
        if let Err(error) = save_cache_in(dir, &cache) {
            tracing::warn!(%error, "local battle log cache write failed — answering uncached rows");
        }
    }
    Ok(log)
}

/// The blocking body of the command: resolve the AppData root and the replay
/// roots, then run the gated scan.
fn scan_local_battles(account_id: i64, from_sec: i64, to_sec: i64) -> Result<LocalBattleLog> {
    let dir = super::appdata::appdata_dir_path()?;
    let roots: Vec<PathBuf> = super::game_context::replay_roots()
        .into_iter()
        .map(|(root, _owner)| root)
        .collect();
    scan_cached(&dir, &roots, account_id, from_sec, to_sec, DECODE_BUDGET)
}

/// Per-battle results for one account in `[from_sec, to_sec]`, decoded from
/// the LOCAL replay corpus (random + ranked). The water-table range views'
/// authoritative source; see the module docs for the cache/filter/budget
/// rules. Async command + [`tokio::task::spawn_blocking`]: the recursive walk,
/// the header reads and the packet-stream decodes are blocking I/O that must
/// never run on the UI thread.
#[tauri::command]
pub async fn read_local_battle_log(
    account_id: i64,
    realm: String,
    from_sec: i64,
    to_sec: i64,
) -> CommandResult<LocalBattleLog> {
    if to_sec < from_sec {
        return Err(
            anyhow!("invalid local battle log window: to {to_sec} < from {from_sec}").into(),
        );
    }
    // `realm` scopes nothing locally today (the account id filters the rows);
    // it rides the contract so a future cross-realm client can scope the scan
    // roots without a wire change.
    tracing::debug!(account_id, %realm, from_sec, to_sec, "local battle log scan requested");
    tokio::task::spawn_blocking(move || scan_local_battles(account_id, from_sec, to_sec))
        .await
        .map_err(|error| anyhow!("local battle log task failed: {error}"))?
        .map_err(Into::into)
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::{SystemTime, UNIX_EPOCH};

    /// Unique temp directory per test (this crate has no tempfile dev-dep),
    /// the same nonce pattern the playtime ledger tests use.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("wowsp-local-battles-{tag}-{nonce}"));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A local wall-clock timestamp (the implementation reads a replay
    /// filename as LOCAL time, so the fixtures use the same clock).
    fn local_ts(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("unambiguous local time")
            .timestamp()
    }

    /// A minimal wowsreplay container: magic + one descriptor block + a
    /// stand-in (undecodable) packet stream — the fixture the playtime ledger
    /// tests use. Decoding it always fails, which is exactly what the
    /// budget / no-negative-cache tests need.
    fn write_synthetic_replay(path: &Path, descriptor: &str) {
        const TEST_REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&TEST_REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
        bytes.extend_from_slice(descriptor.as_bytes());
        bytes.extend_from_slice(&[0u8; 64]);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).expect("write synthetic replay");
    }

    fn candidate_fixture() -> Candidate {
        Candidate {
            path: PathBuf::from("20261026_191309_PBSD108-Lightning_45_Zigzag.wowsreplay"),
            len: 100,
            mtime_ms: 1,
            timestamp: local_ts(2026, 10, 26, 19, 13),
            date_time: "20261026_191309".into(),
            match_group: Some("pvp".into()),
            scenario: Some("domination_3point".into()),
            event_type: None,
        }
    }

    /// Build a BattleResults (0x22) payload with ONE positional player array;
    /// `configure` sets the statistics slots the extraction reads.
    fn battle_results_json(
        recorder: i64,
        row_len: usize,
        winner: i64,
        configure: impl FnOnce(&mut Vec<serde_json::Value>),
    ) -> String {
        let mut row = vec![serde_json::Value::from(0); row_len];
        row[0] = recorder.into();
        row[1] = "langyo".into();
        configure(&mut row);
        let mut players = serde_json::Map::new();
        players.insert(recorder.to_string(), serde_json::Value::Array(row));
        serde_json::json!({
            "accountDBID": recorder,
            "commonList": [0, 0, 0, winner],
            "playersPublicInfo": players,
        })
        .to_string()
    }

    fn cached_battle(recorder: i64, timestamp: i64, date_time: &str) -> CachedBattle {
        CachedBattle {
            row: LocalBattle {
                timestamp,
                date_time: date_time.into(),
                match_group: Some("pvp".into()),
                scenario: None,
                event_type: None,
                ship_id: Some(4_182_828_960),
                team: Some(0),
                won: Some(true),
                damage: 1_000,
                frags: 1,
                survived: true,
                exp: Some(100),
            },
            recorder_account_id: recorder,
        }
    }

    // ── extraction ─────────────────────────────────────────────────────────

    #[test]
    fn extraction_reads_the_modern_layout_slots() {
        let candidate = candidate_fixture();
        let recorder = 2_035_526_744_i64;
        let raw = battle_results_json(recorder, 538, 1, |row| {
            row[6] = 1.into();
            row[7] = 4_182_828_960_i64.into();
            row[21] = true.into();
            row[32] = 3.into();
            row[404] = 1_500.into();
            row[426] = 101_234.into();
            // The legacy slots must be ignored on a modern-length array.
            row[389] = 7.into();
            row[411] = 9.into();
        });
        let battle = extract_battle(&raw, &candidate).expect("authoritative battle row");
        assert_eq!(battle.recorder_account_id, recorder);
        let row = battle.row;
        assert_eq!(row.timestamp, candidate.timestamp);
        assert_eq!(row.date_time, "20261026_191309");
        assert_eq!(row.match_group.as_deref(), Some("pvp"));
        assert_eq!(row.scenario.as_deref(), Some("domination_3point"));
        assert_eq!(row.ship_id, Some(4_182_828_960));
        assert_eq!(row.team, Some(1));
        assert_eq!(row.won, Some(true));
        assert_eq!(row.damage, 101_234);
        assert_eq!(row.frags, 3);
        assert!(row.survived);
        assert_eq!(row.exp, Some(1_500));
    }

    #[test]
    fn extraction_shifts_late_fields_on_the_legacy_layout() {
        let candidate = candidate_fixture();
        let recorder = 2_035_526_744_i64;
        // A 14.x-era array (485 entries): the late fields sit 15 slots earlier
        // and the modern positions hold the inserted block's zero fields.
        let raw = battle_results_json(recorder, 485, 0, |row| {
            row[6] = 0.into();
            row[7] = 4_182_828_960_i64.into();
            row[21] = false.into();
            row[32] = 2.into();
            row[389] = 640.into();
            row[411] = 55_555.into();
        });
        let battle = extract_battle(&raw, &candidate).expect("authoritative battle row");
        assert_eq!(battle.row.won, Some(true));
        assert_eq!(battle.row.damage, 55_555);
        assert_eq!(battle.row.exp, Some(640));
        assert_eq!(battle.row.frags, 2);
        assert!(!battle.row.survived);
    }

    #[test]
    fn win_draw_and_unknown_outcomes_answer_only_decidable_wins() {
        let candidate = candidate_fixture();
        let recorder = 42;
        let with_team = |team: i64, winner: i64| {
            battle_results_json(recorder, 538, winner, |row| row[6] = team.into())
        };
        // commonList[3] equals the recorder's team -> win.
        assert_eq!(
            extract_battle(&with_team(0, 0), &candidate)
                .expect("row")
                .row
                .won,
            Some(true)
        );
        assert_eq!(
            extract_battle(&with_team(1, 0), &candidate)
                .expect("row")
                .row
                .won,
            Some(false)
        );
        // `commonList[3]` outside 0/1 (draw / no winner) -> undecidable.
        assert_eq!(
            extract_battle(&with_team(0, 2), &candidate)
                .expect("row")
                .row
                .won,
            None
        );
        // A spectator slot is not a side of the battle -> undecidable.
        assert_eq!(
            extract_battle(&with_team(2, 0), &candidate)
                .expect("row")
                .row
                .won,
            None
        );
        // A payload without commonList -> undecidable.
        let mut document: serde_json::Value =
            serde_json::from_str(&with_team(0, 0)).expect("valid json");
        document
            .as_object_mut()
            .expect("object")
            .remove("commonList");
        assert_eq!(
            extract_battle(&serde_json::to_string(&document).unwrap(), &candidate)
                .expect("row")
                .row
                .won,
            None
        );
    }

    #[test]
    fn extraction_requires_the_recorder_entry() {
        let candidate = candidate_fixture();
        // playersPublicInfo lists another account only, and its array's index
        // 0 repeats that other id: no authoritative recorder row.
        let raw = serde_json::json!({
            "accountDBID": 42,
            "commonList": [0, 0, 0, 0],
            "playersPublicInfo": { "77": [77, "other"] },
        })
        .to_string();
        assert!(extract_battle(&raw, &candidate).is_none());

        // A string-encoded accountDBID still resolves (some dumps stringify
        // ids) — number_i64 accepts it.
        let raw = serde_json::json!({
            "accountDBID": "42",
            "commonList": [0, 0, 0, 0],
            "playersPublicInfo": { "42": [42, "langyo", 0, 0, 0, 0, 0, 0] },
        })
        .to_string();
        let battle = extract_battle(&raw, &candidate).expect("row");
        assert_eq!(battle.recorder_account_id, 42);
        assert_eq!(battle.row.ship_id, None);
        assert_eq!(battle.row.team, Some(0));
    }

    // ── cache ─────────────────────────────────────────────────────────────

    #[test]
    fn cache_round_trips_and_rebuilds_damaged_files() {
        let dir = TempDir::new("cache");
        let candidate = candidate_fixture();
        let raw = battle_results_json(1, 538, 0, |row| {
            row[6] = 0.into();
            row[32] = 1.into();
            row[426] = 1_000.into();
        });
        let battle = extract_battle(&raw, &candidate).expect("row");
        let key = candidate.path.to_string_lossy().into_owned();
        let mut cache = BattleCache::default();
        cache.entries.insert(
            key.clone(),
            CacheEntry {
                len: candidate.len,
                mtime_ms: candidate.mtime_ms,
                battle: battle.clone(),
            },
        );
        save_cache_in(&dir.0, &cache).expect("save cache");

        let loaded = load_cache_in(&dir.0).expect("load cache");
        assert_eq!(loaded.version, CACHE_VERSION);
        assert_eq!(
            loaded.entries.get(&key),
            Some(&CacheEntry {
                len: candidate.len,
                mtime_ms: candidate.mtime_ms,
                battle,
            })
        );
        assert!(
            loaded
                .hit(&candidate.path, candidate.len, candidate.mtime_ms)
                .is_some()
        );
        // Either identity half moving must miss (the file was rewritten).
        assert!(
            loaded
                .hit(&candidate.path, candidate.len + 1, candidate.mtime_ms)
                .is_none()
        );
        assert!(
            loaded
                .hit(&candidate.path, candidate.len, candidate.mtime_ms + 1)
                .is_none()
        );

        // The cache is derived data: damaged / stale files rebuild empty
        // instead of failing the range view.
        for damaged in [b"not json".as_slice(), b"{\"version\":1,".as_slice()] {
            std::fs::write(dir.0.join(CACHE_FILE), damaged).unwrap();
            assert!(load_cache_in(&dir.0).expect("recover").entries.is_empty());
        }
        std::fs::write(dir.0.join(CACHE_FILE), br#"{"version":99,"entries":{}}"#).unwrap();
        assert!(load_cache_in(&dir.0).expect("recover").entries.is_empty());
        std::fs::remove_file(dir.0.join(CACHE_FILE)).unwrap();
        assert!(load_cache_in(&dir.0).expect("missing").entries.is_empty());
    }

    // ── candidate filters ─────────────────────────────────────────────────

    #[test]
    fn candidates_keep_only_the_slack_window_and_water_table_modes() {
        let root = TempDir::new("window");
        write_synthetic_replay(
            &root
                .0
                .join("20261026_120000_PBSD108-Lightning_45_Zigzag.wowsreplay"),
            r#"{"matchGroup":"pvp","scenario":"domination_3point"}"#,
        );
        write_synthetic_replay(
            &root
                .0
                .join("20261026_130000_PBSD107-Jervis_41_Conquest.wowsreplay"),
            r#"{"matchGroup":"Ranked"}"#,
        );
        // In the slack window, but not a water-table mode.
        write_synthetic_replay(
            &root
                .0
                .join("20261026_140000_PGSC017-Admiral-Scheer_42_Neighbors.wowsreplay"),
            r#"{"matchGroup":"clan"}"#,
        );
        // Outside the slack window on both sides.
        write_synthetic_replay(
            &root
                .0
                .join("20261001_120000_PBSD108-Lightning_45_Zigzag.wowsreplay"),
            r#"{"matchGroup":"pvp"}"#,
        );
        write_synthetic_replay(
            &root
                .0
                .join("20261120_120000_PBSD108-Lightning_45_Zigzag.wowsreplay"),
            r#"{"matchGroup":"pvp"}"#,
        );
        // No parsable filename timestamp.
        write_synthetic_replay(
            &root.0.join("not-a-dated-replay.wowsreplay"),
            r#"{"matchGroup":"pvp"}"#,
        );

        let from = local_ts(2026, 10, 26, 0, 0);
        let to = local_ts(2026, 10, 27, 0, 0);
        let (scanned, candidates) = walk_candidates(&[root.0.clone()], from, to);
        assert_eq!(scanned, 6, "the walk sees every replay file");
        assert_eq!(candidates.len(), 2, "only pvp/ranked inside the window");
        assert_eq!(candidates[0].date_time, "20261026_120000");
        assert_eq!(candidates[0].timestamp, local_ts(2026, 10, 26, 12, 0));
        assert_eq!(candidates[0].scenario.as_deref(), Some("domination_3point"));
        assert_eq!(candidates[1].date_time, "20261026_130000");
        assert!(
            candidates[1]
                .match_group
                .as_deref()
                .is_some_and(|mode| mode.eq_ignore_ascii_case("ranked"))
        );
    }

    #[test]
    fn non_water_table_replays_never_pay_a_decode() {
        let root = TempDir::new("modes");
        // Both files are undecodable (no packet stream): a decode attempt
        // would spend the budget and surface as a failure counter.
        write_synthetic_replay(
            &root.0.join("20261026_120000_event.wowsreplay"),
            r#"{"matchGroup":"event"}"#,
        );
        write_synthetic_replay(
            &root.0.join("20261026_130000_pve.wowsreplay"),
            r#"{"matchGroup":"pve"}"#,
        );
        let appdata = TempDir::new("modes-appdata");
        let log = scan_cached(
            &appdata.0,
            &[root.0.clone()],
            42,
            local_ts(2026, 10, 26, 0, 0),
            local_ts(2026, 10, 27, 0, 0),
            8,
        )
        .expect("scan");
        assert_eq!(log.scanned, 2);
        assert_eq!(log.decoded, 0);
        assert_eq!(log.cache_hits, 0);
        assert_eq!(log.pending, 0);
        assert!(log.battles.is_empty());
        assert!(
            !appdata.0.join(CACHE_FILE).exists(),
            "nothing decoded -> no cache write"
        );
    }

    // ── scan / budget / cache behaviour ───────────────────────────────────

    #[test]
    fn failed_decodes_are_never_cached() {
        let root = TempDir::new("fail");
        write_synthetic_replay(
            &root
                .0
                .join("20261026_120000_PBSD108-Lightning_45_Zigzag.wowsreplay"),
            r#"{"matchGroup":"pvp"}"#,
        );
        let appdata = TempDir::new("fail-appdata");
        let from = local_ts(2026, 10, 26, 0, 0);
        let to = local_ts(2026, 10, 27, 0, 0);
        let first = scan_cached(&appdata.0, &[root.0.clone()], 42, from, to, 8).expect("scan");
        assert_eq!((first.decoded, first.cache_hits, first.pending), (0, 0, 0));
        // No negative cache: the next call spends the budget on the same file
        // again (the retry-later contract) instead of answering it.
        let second = scan_cached(&appdata.0, &[root.0.clone()], 42, from, to, 8).expect("scan");
        assert_eq!(second.decoded, 0);
        assert_eq!(second.cache_hits, 0);
        assert!(!appdata.0.join(CACHE_FILE).exists());
    }

    #[test]
    fn decode_budget_answers_cached_rows_and_reports_pending() {
        let root = TempDir::new("budget");
        let appdata = TempDir::new("budget-appdata");
        let from = local_ts(2026, 10, 26, 0, 0);
        let to = local_ts(2026, 10, 27, 0, 0);
        let mut cache = BattleCache::default();
        let mut seeded = Vec::new();
        for minute in 0..6 {
            let path = root.0.join(format!(
                "20261026_12{minute:02}00_PBSD108-Lightning_45_Zigzag.wowsreplay"
            ));
            write_synthetic_replay(&path, r#"{"matchGroup":"pvp"}"#);
            seeded.push(path);
        }
        // An earlier call decoded five of the six. Three belong to the queried
        // account inside the window, one to another account, and one is out of
        // the window — the cache answers all five, the query keeps three.
        let seed = |cache: &mut BattleCache, path: &Path, battle: CachedBattle| {
            let meta = std::fs::metadata(path).expect("stat replay");
            let mtime_ms = meta
                .modified()
                .expect("mtime")
                .duration_since(UNIX_EPOCH)
                .expect("after epoch")
                .as_millis() as u64;
            cache.entries.insert(
                path.to_string_lossy().into_owned(),
                CacheEntry {
                    len: meta.len(),
                    mtime_ms,
                    battle,
                },
            );
        };
        for (minute, path) in seeded.iter().enumerate().take(3) {
            seed(
                &mut cache,
                path,
                cached_battle(42, local_ts(2026, 10, 26, 12, minute as u32), "seeded"),
            );
        }
        seed(
            &mut cache,
            &seeded[3],
            cached_battle(42, local_ts(2025, 1, 1, 0, 0), "out-of-window"),
        );
        seed(
            &mut cache,
            &seeded[4],
            cached_battle(7, local_ts(2026, 10, 26, 12, 4), "other-account"),
        );
        save_cache_in(&appdata.0, &cache).expect("seed cache");

        // Budget 1: the five cached candidates are free; the sixth is skipped
        // (and reported) once the single fresh decode is spent on it.
        let log = scan_cached(&appdata.0, &[root.0.clone()], 42, from, to, 1).expect("scan");
        assert_eq!(log.scanned, 6);
        assert_eq!(
            log.decoded, 0,
            "the fresh decode fails on the synthetic file"
        );
        assert_eq!(log.cache_hits, 5);
        assert_eq!(log.pending, 0);
        assert_eq!(
            log.battles.len(),
            3,
            "account + window filter the cache rows"
        );
        assert!(
            log.battles
                .windows(2)
                .all(|pair| pair[0].timestamp <= pair[1].timestamp)
        );

        // Budget 0: only the cache is consulted, the one undecoded candidate is
        // pending — the shape the webui's follow-up rounds consume.
        let cached_only =
            scan_cached(&appdata.0, &[root.0.clone()], 42, from, to, 0).expect("scan");
        assert_eq!(cached_only.cache_hits, 5);
        assert_eq!(cached_only.pending, 1);
        assert_eq!(cached_only.decoded, 0);
    }

    /// Manual validation against a real replay folder (never runs in CI):
    /// `WOWSP_TEST_REPLAY_DIR` plus `WOWSP_TEST_ACCOUNT_ID` select the
    /// corpus/account, `WOWSP_TEST_FROM_SEC` / `WOWSP_TEST_TO_SEC` bound the
    /// window. Run with
    /// `cargo test -p wowsp_tauri local_battles -- --ignored --nocapture`.
    #[ignore = "needs WOWSP_TEST_REPLAY_DIR pointing at a folder of real replays"]
    #[test]
    fn real_replay_corpus_decodes_local_battle_rows() {
        let Ok(root) = std::env::var("WOWSP_TEST_REPLAY_DIR") else {
            eprintln!("skipped: set WOWSP_TEST_REPLAY_DIR");
            return;
        };
        let Ok(account) = std::env::var("WOWSP_TEST_ACCOUNT_ID") else {
            eprintln!("skipped: set WOWSP_TEST_ACCOUNT_ID");
            return;
        };
        let account: i64 = account
            .parse()
            .expect("WOWSP_TEST_ACCOUNT_ID must be an integer");
        let env_i64 = |name: &str, fallback: i64| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(fallback)
        };
        let from_sec = env_i64("WOWSP_TEST_FROM_SEC", 0);
        let to_sec = env_i64("WOWSP_TEST_TO_SEC", i64::MAX / 2);
        let appdata = TempDir::new("corpus");
        let log = scan_cached(
            &appdata.0,
            &[PathBuf::from(&root)],
            account,
            from_sec,
            to_sec,
            4_096,
        )
        .expect("scan the real corpus");
        for battle in &log.battles {
            println!(
                "{} ship={:?} team={:?} won={:?} damage={} frags={} survived={} exp={:?}",
                battle.date_time,
                battle.ship_id,
                battle.team,
                battle.won,
                battle.damage,
                battle.frags,
                battle.survived,
                battle.exp
            );
        }
        println!(
            "scanned={} decoded={} cache_hits={} pending={} battles={}",
            log.scanned,
            log.decoded,
            log.cache_hits,
            log.pending,
            log.battles.len()
        );
        assert_eq!(log.pending, 0, "the validation budget decodes everything");
        // The successful decodes were persisted, so the real corpus exercises
        // the whole cache round trip: the second call pays no decode and
        // answers the identical rows.
        let entries = load_cache_in(&appdata.0)
            .expect("reload cache")
            .entries
            .len();
        assert_eq!(entries, log.decoded as usize, "every decode was persisted");
        let cached = scan_cached(
            &appdata.0,
            &[PathBuf::from(&root)],
            account,
            from_sec,
            to_sec,
            4_096,
        )
        .expect("cached scan");
        assert_eq!(cached.decoded, 0, "the second call must not decode again");
        assert_eq!(cached.cache_hits, log.decoded, "the persisted rows answer");
        assert_eq!(
            cached.battles, log.battles,
            "the cache answers the same rows"
        );
    }
}
