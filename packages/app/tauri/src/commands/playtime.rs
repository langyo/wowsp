//! Playtime tracking (游玩时间统计) — WoWSP's own offline ledger of how long
//! the World of Warships client runs.
//!
//! Design (mirrors the session hub's shape — one static `Mutex<Option<_>>`,
//! a dedicated tick source, and a single command as the wire surface):
//!
//! * The session poller (commands/session.rs) feeds every 3 s process
//!   snapshot into [`observe`]. A running client opens a session backdated
//!   to the process's creation time (the same "Steam counts the process,
//!   not the battles" convention Steam's own playtime uses), heartbeats it
//!   while it lives, and closes it on exit. Heartbeats persist at most once
//!   a minute — the crash-loss window is one flush, never a whole evening.
//! * The historical career total used to be seeded by scanning the Steam
//!   client's `userdata/<account>/config/localconfig.vdf`; that scan (and
//!   its retryable import command) has been REMOVED — battle counts now
//!   come from replay files ([`playtime_battles`]). Ledgers that already
//!   imported a Steam backlog keep honoring it: it rides
//!   `imported_total_seconds` and the overview keeps reporting the `steam`
//!   `source`, so no user's recorded history is lost.
//! * The webui reads the time ledger through [`playtime_overview`] and the
//!   replay-derived battle ledger through [`playtime_battles`]. The imported
//!   backlog is undated, so it rides `imported_total_seconds` and never
//!   leaks into the per-day series — the charts only ever show locally
//!   observed days.
//!
//! The ledger (`playtime.json`, AppData root) stays Rust-owned: the webui
//! never reads or writes it directly, unlike `accounts.json`.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use wowsp_tauri_shared::{
    GameInstall, PlaytimeBattle, PlaytimeBattles, PlaytimeDay, PlaytimeLaunch, PlaytimeOverview,
    PlaytimeSource, ReplayMetaLite,
};

/// The ledger file under the AppData root (atomic writes via the shared
/// tmp+rename helper, like every other JSON store).
const PLAYTIME_FILE: &str = "playtime.json";

/// Minimum gap between two heartbeat flushes while a session is open.
const HEARTBEAT_FLUSH_SECS: i64 = 60;

/// Slack when deciding whether an open session belongs to the CURRENT game
/// process: a session started before the running process's creation time by
/// more than this many seconds belongs to a previous run (WoWSP died while
/// the game kept running, the game restarted, WoWSP came back).
const PROCESS_SWITCH_SLACK_SECS: i64 = 60;

/// One observed client run: `[start, end]` in unix seconds. An OPEN
/// session's `end` is its last heartbeat (kept ≥ `start` at all times).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaytimeSession {
    start: i64,
    end: i64,
}

impl PlaytimeSession {
    fn duration(&self) -> u64 {
        u64::try_from(self.end.saturating_sub(self.start)).unwrap_or(0)
    }
}

/// The on-disk ledger. `#[serde(default)]` keeps forward compatibility: a
/// future field heals to its default on read instead of discarding every
/// recorded session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PlaytimeStore {
    version: u32,
    /// Which path seeded the career total (["steam", "local"]).
    source: PlaytimeSource,
    imported_total_seconds: u64,
    imported_at: Option<i64>,
    /// Closed sessions in close order.
    sessions: Vec<PlaytimeSession>,
    /// The session of a client that is running right now (or whose exit was
    /// never observed because WoWSP quit first — the next launch re-adopts
    /// or closes it, see [`observe`]).
    open: Option<PlaytimeSession>,
    /// Number of observed game launches.
    launches: u64,
}

impl Default for PlaytimeStore {
    fn default() -> Self {
        Self {
            version: 1,
            source: PlaytimeSource::Local,
            imported_total_seconds: 0,
            imported_at: None,
            sessions: Vec::new(),
            open: None,
            launches: 0,
        }
    }
}

struct PlaytimeState {
    store: PlaytimeStore,
    /// Last successful persist (unix secs) — the heartbeat throttle clock.
    last_persist: i64,
    dirty: bool,
    /// Consecutive not-running snapshots (the exit debounce, see
    /// [`observe_transition`]).
    misses: u32,
}

static STATE: Mutex<Option<PlaytimeState>> = Mutex::new(None);

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Run `f` against the tracker state, recovering from a poisoned lock (a
/// panic in one tick must not lose the whole ledger).
fn with_state<R>(f: impl FnOnce(&mut PlaytimeState) -> R) -> R {
    let mut guard = STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = guard.get_or_insert_with(|| PlaytimeState {
        store: load_store(),
        last_persist: 0,
        dirty: false,
        misses: 0,
    });
    f(state)
}

/// Read the ledger, creating (and seeding) it on first run. The fresh file
/// is written back immediately so the once-only import cannot repeat after
/// a crash.
fn load_store() -> PlaytimeStore {
    match super::appdata::read_appdata_json(PLAYTIME_FILE) {
        Ok(Some(raw)) => match serde_json::from_str::<PlaytimeStore>(&raw) {
            Ok(store) => store,
            Err(e) => {
                tracing::warn!(error = %e, "playtime.json unreadable — starting a fresh ledger");
                fresh_store()
            },
        },
        Ok(None) => fresh_store(),
        Err(e) => {
            tracing::warn!(error = %e, "playtime.json unreadable — starting a fresh ledger");
            fresh_store()
        },
    }
}

/// A brand-new ledger: plain defaults, persisted immediately. (The first-run
/// Steam seed is gone with the historical-scan removal — see the module
/// docs; only the persist-once shape survives so a crash cannot re-run any
/// first-run logic.)
fn fresh_store() -> PlaytimeStore {
    let store = PlaytimeStore::default();
    if let Err(e) = persist_store(&store) {
        tracing::warn!(error = %e, "could not write the fresh playtime ledger");
    }
    store
}

fn persist_store(store: &PlaytimeStore) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|e| format!("serialize playtime: {e}"))?;
    super::appdata::write_appdata_json(PLAYTIME_FILE, &json)
}

// ── observation (fed by the session poller) ────────────────────────────────

/// Gap between two ticks that reads as "the machine slept or the poller
/// stalled" (a healthy cadence is [`POLL_INTERVAL`]-shaped, 3 s): the open
/// session splits at its last heartbeat instead of crediting the gap as
/// playtime.
const GAP_SPLIT_SECS: i64 = 120;

/// Fold one process snapshot into the ledger. Cheap per tick: no I/O unless
/// a state transition happened or the minute-long heartbeat came due.
pub(super) fn observe(info: &wowsp_tauri_shared::GameProcessInfo) {
    let now = now_unix();
    with_state(|state| {
        // Windows resolves the true creation time; other targets count from
        // the first observation.
        let proc_start = if info.running {
            info.pid.and_then(super::appdata::query_process_start_unix)
        } else {
            None
        };
        let (transition, heartbeat) = observe_transition(
            &mut state.store,
            info.running,
            proc_start,
            now,
            &mut state.misses,
        );
        state.dirty |= transition || heartbeat;
        if state.dirty && (transition || now - state.last_persist >= HEARTBEAT_FLUSH_SECS) {
            persist(state, now);
        }
    });
}

/// The PURE fold of one poller snapshot into the ledger — every decision
/// about sessions happens here so the state machine is unit-testable (the
/// static/IO wrapper above only injects the clock and the process start).
///
/// Returns whether a transition (open / close / split) happened and whether
/// the open session heartbeated. `misses` counts consecutive not-running
/// snapshots across calls.
fn observe_transition(
    store: &mut PlaytimeStore,
    running: bool,
    proc_start: Option<i64>,
    now: i64,
    misses: &mut u32,
) -> (bool, bool) {
    let mut transition = false;
    let mut heartbeat = false;
    if running {
        *misses = 0;
        let proc_start = proc_start.map(|s| s.min(now));
        match store.open {
            Some(mut open) => {
                let from_previous_run =
                    proc_start.is_some_and(|s| open.start < s - PROCESS_SWITCH_SLACK_SECS);
                if from_previous_run {
                    // The open session belongs to a client run that already
                    // ended (WoWSP was down when it did): close it on its own
                    // heartbeat, start a fresh session at the new start —
                    // floored at the closed session's end so two overlapping
                    // clients (or a crash in between) can never resurrect
                    // already-counted time either.
                    close_open(store);
                    let floor = store.sessions.last().map(|s| s.end).unwrap_or(0);
                    let start = proc_start.map_or(now, |s| s.max(floor));
                    open_session(store, start, now, proc_start);
                    transition = true;
                } else if now > open.end {
                    if now - open.end > GAP_SPLIT_SECS {
                        // The machine slept (or the poller stalled) with the
                        // client open: close on the RECORDED heartbeat — the
                        // gap is not playtime — and start counting anew. The
                        // split halves belong to one game run, so the launch
                        // counter must not move.
                        close_open(store);
                        open_session(store, now, now, proc_start);
                        transition = true;
                    } else {
                        open.end = now;
                        store.open = Some(open);
                        heartbeat = true;
                    }
                }
            },
            None => {
                // Re-open backdated to the process creation time, but never
                // earlier than the previous session's end: the poller's
                // snapshot can blip offline for a tick (ToolHelp transiently
                // failing under process churn), and a blip that sneaked past
                // the debounce must not resurrect already-counted time.
                let floor = store.sessions.last().map(|s| s.end).unwrap_or(0);
                let start = proc_start.map_or(now, |s| s.max(floor));
                open_session(store, start, now, proc_start);
                transition = true;
            },
        }
    } else {
        *misses += 1;
        // Debounce: ONE not-running snapshot must not close a live session —
        // the process snapshot transiently fails exactly around game
        // launch/exit churn, and a close+reopen there would double-count the
        // whole session. Two consecutive misses (≈6 s) read as a real exit.
        if *misses >= 2 && store.open.is_some() {
            close_open(store);
            transition = true;
        }
    }
    (transition, heartbeat)
}

/// Open a fresh session at `start` (end anchored at the observation tick
/// `now`), counting a launch only when the session is NOT a continuation of
/// the process run the previous closed session belonged to — blip splits
/// and sleep splits re-open the SAME run and must not inflate the launch
/// counter.
fn open_session(store: &mut PlaytimeStore, start: i64, now: i64, proc_start: Option<i64>) {
    let continuation = proc_start.is_some_and(|s| {
        store
            .sessions
            .last()
            .is_some_and(|last| last.start >= s - PROCESS_SWITCH_SLACK_SECS)
    });
    store.open = Some(PlaytimeSession {
        start,
        end: now.max(start),
    });
    if !continuation {
        store.launches += 1;
    }
}

/// Move the open session (if any) into the closed list. A sub-second
/// phantom (a polling blip) is dropped entirely. Launches are counted when
/// sessions OPEN (see [`open_session`]), never here — the close path cannot
/// distinguish a real exit from a blip split.
fn close_open(store: &mut PlaytimeStore) {
    if let Some(open) = store.open.take() {
        if open.duration() > 0 {
            store.sessions.push(open);
        }
    }
}

fn persist(state: &mut PlaytimeState, now: i64) {
    match persist_store(&state.store) {
        Ok(()) => {
            state.last_persist = now;
            state.dirty = false;
        },
        Err(e) => tracing::warn!(error = %e, "playtime persist failed — will retry next tick"),
    }
}

/// Persist-on-quit hook (quit_app): flush the ledger so the crash-loss
/// window never spans a clean shutdown. The open session intentionally
/// STAYS open — the game may outlive the shell, and the next launch
/// re-adopts (client still running) or closes it (client gone) on its
/// recorded heartbeat.
pub(crate) fn flush() {
    let now = now_unix();
    with_state(|state| {
        if state.dirty {
            persist(state, now);
        }
    });
}

// ── overview (the command's pure core) ─────────────────────────────────────

/// Split `[start, end]` at the timezone's local midnights into
/// (`YYYY-MM-DD`, seconds-on-that-day) segments. Generic over the timezone
/// so tests pin the geometry with a fixed offset while the runtime passes
/// `Local` (DST-aware per timestamp).
fn split_session_days<Tz: TimeZone>(start: i64, end: i64, tz: &Tz) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = Vec::new();
    if end <= start {
        return out;
    }
    let mut t = start;
    loop {
        let Some(dt) = tz.timestamp_opt(t, 0).single() else {
            break;
        };
        let key = format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day());
        let Some(next_day) = dt.date_naive().succ_opt() else {
            break;
        };
        let midnight = next_day
            .and_hms_opt(0, 0, 0)
            .and_then(|n| tz.from_local_datetime(&n).single())
            .map(|m| m.timestamp());
        match midnight {
            // Normal midnight in the future: credit up to it and roll over.
            Some(nm) if nm > t => {
                let seg_end = end.min(nm);
                out.push((key, (seg_end - t) as u64));
                if seg_end >= end {
                    break;
                }
                t = seg_end;
            },
            // Ambiguous / skipped midnight (DST edges) or a degenerate
            // clock: dump the remainder onto the current day rather than
            // looping forever.
            _ => {
                out.push((key, (end - t) as u64));
                break;
            },
        }
    }
    out
}

/// Longest run of consecutive calendar days in an ascending, distinct,
/// `YYYY-MM-DD`-formatted date list → (length, inclusive range).
fn longest_streak(dates: &[String]) -> (u64, Option<(String, String)>) {
    let mut best: u64 = 0;
    let mut best_range: Option<(String, String)> = None;
    let mut run: u64 = 0;
    let mut run_start: Option<chrono::NaiveDate> = None;
    let mut prev: Option<chrono::NaiveDate> = None;
    for raw in dates {
        let Ok(day) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") else {
            continue;
        };
        let continues = prev.is_some_and(|p| p.succ_opt() == Some(day));
        run = if continues { run + 1 } else { 1 };
        if !continues {
            run_start = Some(day);
        }
        if run > best {
            best = run;
            best_range = Some((
                run_start
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| raw.clone()),
                raw.clone(),
            ));
        }
        prev = Some(day);
    }
    (best, best_range)
}

/// The command's pure core: ledger → wire DTO. `now` bounds open sessions.
fn overview_of<Tz: TimeZone>(store: &PlaytimeStore, now: i64, tz: &Tz) -> PlaytimeOverview {
    let mut days: BTreeMap<String, u64> = BTreeMap::new();
    let mut local_total: u64 = 0;
    let mut longest_session: Option<(PlaytimeSession, u64)> = None;

    let mut consider = |session: &PlaytimeSession, days: &mut BTreeMap<String, u64>| {
        // A future-dated end (a stale clock) is clamped to `now` ONCE here,
        // so the totals, the longest-session record and the per-day split
        // always share one duration.
        let end = session.end.min(now).max(session.start);
        let duration = u64::try_from(end - session.start).unwrap_or(0);
        if duration == 0 {
            return;
        }
        local_total += duration;
        if longest_session.is_none_or(|(_, best)| duration > best) {
            longest_session = Some((*session, duration));
        }
        for (day, secs) in split_session_days(session.start, end, tz) {
            *days.entry(day).or_insert(0) += secs;
        }
    };
    for session in &store.sessions {
        consider(session, &mut days);
    }
    if let Some(open) = &store.open {
        consider(open, &mut days);
    }

    let daily: Vec<PlaytimeDay> = days
        .iter()
        .filter(|(_, secs)| **secs > 0)
        .map(|(date, secs)| PlaytimeDay {
            date: date.clone(),
            seconds: *secs,
        })
        .collect();
    let longest_day = daily
        .iter()
        .max_by_key(|d| d.seconds)
        .cloned()
        .unwrap_or(PlaytimeDay {
            date: String::new(),
            seconds: 0,
        });
    let played_dates: Vec<String> = daily.iter().map(|d| d.date.clone()).collect();
    let (streak_days, streak_range) = longest_streak(&played_dates);

    // The most recent launch: the open session while the client runs, else
    // the latest closed one by start time.
    let last_launch = store
        .open
        .map(|s| PlaytimeLaunch {
            start: s.start,
            duration_seconds: u64::try_from(s.end.min(now).saturating_sub(s.start)).unwrap_or(0),
            running: true,
        })
        .or_else(|| {
            store
                .sessions
                .iter()
                .max_by_key(|s| s.start)
                .map(|s| PlaytimeLaunch {
                    start: s.start,
                    duration_seconds: s.duration(),
                    running: false,
                })
        });

    PlaytimeOverview {
        source: store.source,
        imported_total_seconds: store.imported_total_seconds,
        imported_at: store.imported_at,
        local_total_seconds: local_total,
        total_seconds: local_total + store.imported_total_seconds,
        launch_count: store.launches,
        days_played: daily.len() as u64,
        first_tracked_day: daily.first().map(|d| d.date.clone()),
        longest_streak_days: streak_days,
        longest_streak_start: streak_range.as_ref().map(|(s, _)| s.clone()),
        longest_streak_end: streak_range.as_ref().map(|(_, e)| e.clone()),
        longest_session_seconds: longest_session.map(|(_, d)| d).unwrap_or(0),
        longest_session_date: longest_session.map(|(s, _)| day_key_of(s.start, tz)),
        longest_day_seconds: longest_day.seconds,
        longest_day_date: if longest_day.seconds > 0 {
            Some(longest_day.date)
        } else {
            None
        },
        last_launch,
        daily,
    }
}

/// The `YYYY-MM-DD` key of a unix timestamp in `tz` ("" when the timestamp
/// is not representable — a corrupt ledger must not panic the command).
fn day_key_of<Tz: TimeZone>(ts: i64, tz: &Tz) -> String {
    tz.timestamp_opt(ts, 0)
        .single()
        .map(|dt| format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day()))
        .unwrap_or_default()
}

/// Current ledger → wire DTO (the command body).
fn current_overview() -> PlaytimeOverview {
    let now = now_unix();
    with_state(|state| overview_of(&state.store, now, &Local))
}

/// The playtime page's full payload. Cross-platform: on mobile (no session
/// poller, no Steam) it answers the freshly created local ledger.
#[tauri::command]
pub fn playtime_overview() -> PlaytimeOverview {
    current_overview()
}

// ── battle ledger (replay-derived battle counts) ────────────────────────────

/// The battle-ledger disk cache under the AppData root: parsed replay
/// headers keyed by absolute path, so a scan over an unchanged replays tree
/// reads no headers at all (a few hundred replays × the descriptor block is
/// real I/O, and the playtime view re-scans on every open).
const BATTLES_CACHE_FILE: &str = "playtime-battles-cache.json";

/// One cached header parse. Identity = the file's `len` + `mtime_ms` — a
/// hit requires BOTH to match the file's current stat, so any ordinary
/// edit, rewrite or copy (a new size or a moved mtime) re-parses. The one
/// accepted stale corner is a same-length replacement landing within the
/// same millisecond; the game writes each replay exactly once, so that
/// never happens in practice.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BattleCacheEntry {
    len: u64,
    mtime_ms: u64,
    lite: ReplayMetaLite,
}

/// The cache file's shape. `#[serde(default)]` keeps forward compatibility:
/// a field added later heals to its default instead of discarding the cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BattleCache {
    version: u32,
    /// Absolute replay path → its cached parse.
    entries: BTreeMap<String, BattleCacheEntry>,
}

/// Bump when a cached parse's SEMANTICS change (not on every field added —
/// `#[serde(default)]` heals those). v2: `player_count` counts listed
/// players only (scripted scenario NPCs sit out), so v1 caches that carry
/// NPC-inclusive counts must re-parse.
const BATTLES_CACHE_VERSION: u32 = 2;

impl Default for BattleCache {
    fn default() -> Self {
        Self {
            version: BATTLES_CACHE_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

/// Load the cache; an unreadable or corrupt file answers empty (a broken
/// cache only costs a re-parse, never a failed command). A version mismatch
/// discards just as cheaply — the entries re-parse on the next scan.
fn load_battle_cache() -> BattleCache {
    match super::appdata::read_appdata_json(BATTLES_CACHE_FILE) {
        Ok(Some(raw)) => match serde_json::from_str::<BattleCache>(&raw) {
            Ok(cache) if cache.version == BATTLES_CACHE_VERSION => cache,
            Ok(_) => {
                tracing::info!("playtime battle cache version stale — rescanning");
                BattleCache::default()
            },
            Err(e) => {
                tracing::warn!(error = %e, "playtime battle cache unreadable — rescanning");
                BattleCache::default()
            },
        },
        _ => BattleCache::default(),
    }
}

/// Persist the cache atomically (tmp + rename via the shared appdata
/// helper). Two concurrent `playtime_battles` invokes racing this write are
/// BENIGN by design: both scans see the same disk state, so the last
/// writer's file is at worst missing the other's just-upserted entries
/// (re-parsed next run) — never a torn or interleaved file. No mutex
/// needed.
fn save_battle_cache(cache: &BattleCache) -> Result<(), String> {
    let json = serde_json::to_string(cache).map_err(|e| format!("serialize battle cache: {e}"))?;
    super::appdata::write_appdata_json(BATTLES_CACHE_FILE, &json)
}

/// Dedupe identity for scan roots — the same normalization the install scan
/// uses (`game_detect::install_path_key`): case-, separator- and
/// trailing-slash-insensitive, so the registry's, the Steam vdf's and the
/// env pin's spellings of one folder collapse. Purely string-based (no
/// canonicalize I/O), so it never fails. A root reachable only through a
/// differently-spelled symlink or junction stays distinct here — the
/// pathological outcome is the same physical folder being walked (and its
/// battles counted) twice, an accepted edge for the zero-I/O identity.
fn battle_root_key(path: &Path) -> String {
    super::game_detect::install_path_key(&path.to_string_lossy())
}

/// True when two replay roots are the same folder or nested inside one
/// another (the resolved default dir can BE an install's `replays/` or live
/// under its root in a different spelling).
fn battle_roots_overlap(a: &Path, b: &Path) -> bool {
    let (a, b) = (battle_root_key(a), battle_root_key(b));
    a == b || a.starts_with(&format!("{b}\\")) || b.starts_with(&format!("{a}\\"))
}

/// Every root the battle ledger scans: each detected install's `replays/`
/// folder (owner = that install), plus the resolved default replay dir
/// (owner = none — the mobile managed dir or an env pin) when it is not
/// already covered by an install root. On mobile the install scan finds
/// nothing (no registry / Steam libraries to walk; at most an env-pinned
/// path), so the managed dir is the ledger's only root.
fn battle_roots() -> Vec<(PathBuf, Option<GameInstall>)> {
    let mut roots: Vec<(PathBuf, Option<GameInstall>)> = Vec::new();
    for install in super::game_context::cached_scan() {
        let dir = super::game_context::replays_dir(Path::new(&install.path));
        // Two installs resolving to overlapping folders (nested roots from
        // overlapping detection sources) must not double-count replays.
        if roots.iter().any(|(r, _)| battle_roots_overlap(r, &dir)) {
            continue;
        }
        roots.push((dir, Some(install)));
    }
    if let Ok(extra) = super::replay::resolve_replay_dir(None) {
        if !roots.iter().any(|(r, _)| battle_roots_overlap(r, &extra)) {
            roots.push((extra, None));
        }
    }
    roots
}

/// Project one parsed replay header (plus its scan root's owning install)
/// onto the wire row. Unowned files (the resolved default dir outside every
/// install) still count as battles — they just carry the root path itself
/// and no kind/realm.
fn battle_of(root: &Path, owner: &Option<GameInstall>, lite: &ReplayMetaLite) -> PlaytimeBattle {
    PlaytimeBattle {
        install_path: owner
            .as_ref()
            .map(|i| i.path.clone())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        kind: owner.as_ref().map(|i| i.kind),
        realm: owner.as_ref().and_then(|i| i.realm.clone()),
        date_time: lite.date_time.clone(),
        match_group: lite.match_group.clone(),
        scenario: lite.scenario.clone(),
        event_type: lite.event_type.clone(),
        bot_count: lite.bot_count,
        scripted_unit_count: lite.scripted_unit_count,
        own_ship_id: lite.own_ship_id,
        own_ship_name: lite.own_ship_name.clone(),
        player_count: lite.player_count,
    }
}

/// The command's pure core: walk every root, parse (or reuse the cached
/// parse of) each replay header, and answer one battle row per file. Also
/// maintains `cache` in place — upserting fresh parses and pruning entries
/// whose file was not seen this run — so the caller can diff the cache and
/// decide the write-back.
///
/// Per-file failures never fail the scan: `replay::lite_from_path` already
/// degrades to a path + filename-datetime row when the header is
/// unparseable (a corrupt or foreign container), and a file vanishing
/// mid-walk only loses its row.
fn battles_from_roots(
    roots: &[(PathBuf, Option<GameInstall>)],
    cache: &mut BattleCache,
) -> Vec<PlaytimeBattle> {
    let mut battles = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (root, owner) in roots {
        let mut walked = Vec::new();
        super::replay::walk_replays(root, &mut walked);
        for file in walked {
            let key = file.path.to_string_lossy().into_owned();
            seen.insert(key.clone());
            let mtime_ms = file
                .mtime
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            // Hit only when the file's identity is unchanged: same length
            // AND same mtime. Anything else re-parses (and re-upserts).
            let lite = match cache.entries.get(&key) {
                Some(hit) if hit.len == file.len && hit.mtime_ms == mtime_ms => hit.lite.clone(),
                _ => {
                    let lite = super::replay::lite_from_path(&file.path);
                    cache.entries.insert(
                        key.clone(),
                        BattleCacheEntry {
                            len: file.len,
                            mtime_ms,
                            lite: lite.clone(),
                        },
                    );
                    lite
                },
            };
            battles.push(battle_of(root, owner, &lite));
        }
    }
    // Prune entries whose file disappeared (a replay deleted or a root
    // uninstalled) so the cache cannot grow unboundedly across years.
    cache.entries.retain(|path, _| seen.contains(path));
    // `date_time` ascending, undatable files sinking last (stable, so the
    // walk order keeps ties deterministic within one timestamp).
    battles.sort_by(|a, b| match (&a.date_time, &b.date_time) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    battles
}

/// The 游玩时间 view's battle ledger: one row per completed replay across
/// every detected install's `replays/` folder (plus the resolved default
/// dir when no install owns it). Header parses are cached on disk
/// (`playtime-battles-cache.json`, len + mtime keyed) so an unchanged tree
/// costs a stat walk only.
///
/// Async command + [`tokio::task::spawn_blocking`]: the recursive walk +
/// per-file header reads are blocking I/O that must never run on the UI
/// thread — same rule as `replay::list_replays_meta`. Cross-platform:
/// mobile has no installs to scan, so the managed replays dir is the
/// ledger's only root.
#[tauri::command]
pub async fn playtime_battles() -> Result<PlaytimeBattles, String> {
    tokio::task::spawn_blocking(|| {
        let mut cache = load_battle_cache();
        let roots = battle_roots();
        // "Changed" = the cache serialization differs after the run — an
        // upsert (new/edited replay) or a prune (a deleted one). An
        // unchanged tree writes nothing back.
        let before =
            serde_json::to_string(&cache).map_err(|e| format!("serialize battle cache: {e}"))?;
        let battles = battles_from_roots(&roots, &mut cache);
        let after =
            serde_json::to_string(&cache).map_err(|e| format!("serialize battle cache: {e}"))?;
        if before != after {
            // A failed cache write must not fail the ledger — the rows are
            // already correct; only the next scan re-parses.
            if let Err(e) = save_battle_cache(&cache) {
                tracing::warn!(error = %e, "playtime battle cache persist failed");
            }
        }
        Ok(PlaytimeBattles { battles })
    })
    .await
    .map_err(|e| format!("playtime battles task failed: {e}"))?
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use wowsp_tauri_shared::GameInstallKind;

    /// +08:00 — a fixed offset so the day-split geometry is pinned no
    /// matter which timezone the test machine runs in.
    const TZ: FixedOffset = match FixedOffset::east_opt(8 * 3600) {
        Some(tz) => tz,
        None => unreachable!(),
    };

    /// 2026-10-05 20:00 local (+08:00) = 12:00 UTC.
    fn ts(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        chrono::NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap()
            .and_local_timezone(TZ)
            .single()
            .unwrap()
            .timestamp()
    }

    #[test]
    fn day_split_credits_each_local_midnight() {
        // 23:00 → next day 01:00: one hour on each side.
        let got = split_session_days(ts(2026, 10, 5, 23, 0), ts(2026, 10, 6, 1, 0), &TZ);
        assert_eq!(
            got,
            vec![
                ("2026-10-05".to_string(), 3600),
                ("2026-10-06".to_string(), 3600),
            ]
        );
        // A single-day session lands entirely on its own day.
        let got = split_session_days(ts(2026, 10, 5, 9, 0), ts(2026, 10, 5, 10, 30), &TZ);
        assert_eq!(got, vec![("2026-10-05".to_string(), 5400)]);
        // Degenerate input stays empty.
        assert!(split_session_days(100, 100, &TZ).is_empty());
        assert!(split_session_days(200, 100, &TZ).is_empty());
        // A long multi-day session splits every midnight.
        let got = split_session_days(ts(2026, 10, 4, 12, 0), ts(2026, 10, 7, 12, 0), &TZ);
        assert_eq!(
            got,
            vec![
                ("2026-10-04".to_string(), 12 * 3600),
                ("2026-10-05".to_string(), 24 * 3600),
                ("2026-10-06".to_string(), 24 * 3600),
                ("2026-10-07".to_string(), 12 * 3600),
            ]
        );
    }

    #[test]
    fn streak_finds_the_longest_consecutive_run() {
        let (n, range) = longest_streak(&[
            "2026-06-01".into(),
            "2026-06-02".into(),
            "2026-06-03".into(),
            "2026-06-07".into(),
            "2026-06-08".into(),
        ]);
        assert_eq!(n, 3);
        assert_eq!(range, Some(("2026-06-01".into(), "2026-06-03".into())));
        // A single day is a streak of one; an empty list is none.
        assert_eq!(longest_streak(&["2026-10-05".into()]).0, 1);
        assert_eq!(longest_streak(&[]), (0, None));
        // A corrupt key never panics — it just doesn't count.
        assert_eq!(longest_streak(&["garbage".into()]), (0, None));
    }

    #[test]
    fn overview_aggregates_totals_records_and_series() {
        // 2026-10-05 22:30 → 2026-10-06 00:30 (+08:00), plus one short run.
        let store = PlaytimeStore {
            sessions: vec![
                PlaytimeSession {
                    start: ts(2026, 10, 5, 22, 30),
                    end: ts(2026, 10, 6, 0, 30),
                },
                PlaytimeSession {
                    start: ts(2026, 10, 6, 9, 0),
                    end: ts(2026, 10, 6, 9, 40),
                },
            ],
            launches: 2,
            imported_total_seconds: 100,
            source: PlaytimeSource::Steam,
            imported_at: Some(7),
            ..PlaytimeStore::default()
        };
        let now = ts(2026, 10, 6, 10, 0);
        let o = overview_of(&store, now, &TZ);
        assert_eq!(o.local_total_seconds, 2 * 3600 + 40 * 60);
        assert_eq!(o.total_seconds, o.local_total_seconds + 100);
        assert_eq!(o.launch_count, 2);
        assert_eq!(o.days_played, 2);
        assert_eq!(o.first_tracked_day.as_deref(), Some("2026-10-05"));
        assert_eq!(
            o.daily,
            vec![
                PlaytimeDay {
                    date: "2026-10-05".into(),
                    seconds: 5400,
                },
                PlaytimeDay {
                    date: "2026-10-06".into(),
                    seconds: 2 * 3600 + 40 * 60 - 5400,
                },
            ]
        );
        assert_eq!(o.longest_session_seconds, 2 * 3600);
        assert_eq!(o.longest_session_date.as_deref(), Some("2026-10-05"));
        // 10-05 carries 5400s (22:30→24:00) vs 10-06's 1800+2400s — the
        // earlier day wins.
        assert_eq!(o.longest_day_seconds, o.daily[0].seconds);
        assert_eq!(o.longest_day_date.as_deref(), Some("2026-10-05"));
        assert_eq!(o.longest_streak_days, 2);
        assert_eq!(
            o.longest_streak_start.as_deref(),
            Some("2026-10-05"),
            "the streak spans both days, not the later single-day run's neighbour"
        );
        assert_eq!(o.longest_streak_end.as_deref(), Some("2026-10-06"));
        let last = o.last_launch.expect("closed launches exist");
        assert!(!last.running);
        assert_eq!(last.start, ts(2026, 10, 6, 9, 0));
        assert_eq!(last.duration_seconds, 40 * 60);
        // The imported backlog never leaks into the per-day series.
        assert_eq!(
            o.daily.iter().map(|d| d.seconds).sum::<u64>(),
            o.local_total_seconds
        );
    }

    #[test]
    fn overview_covers_the_open_session_and_records_it_as_running() {
        let start = ts(2026, 10, 5, 20, 0);
        let now = start + 900;
        let store = PlaytimeStore {
            open: Some(PlaytimeSession { start, end: now }),
            ..PlaytimeStore::default()
        };
        let o = overview_of(&store, now, &TZ);
        assert_eq!(o.local_total_seconds, 900);
        let last = o.last_launch.expect("open session is the last launch");
        assert!(last.running);
        assert_eq!(last.duration_seconds, 900);
        assert_eq!(o.launch_count, 0, "a still-open launch is not counted yet");
        // An open session's future-dated end (a stale clock) is clamped.
        let store = PlaytimeStore {
            open: Some(PlaytimeSession {
                start,
                end: now + 10_000,
            }),
            ..PlaytimeStore::default()
        };
        assert_eq!(overview_of(&store, now, &TZ).local_total_seconds, 900);
    }

    // ── the observe() state machine (pure: injected clock + proc start) ────

    /// Drive [`observe_transition`] through a scripted tick sequence of
    /// `(running, proc_start, now)` snapshots.
    fn drive(store: &mut PlaytimeStore, ticks: &[(bool, Option<i64>, i64)]) {
        let mut misses: u32 = 0;
        for &(running, start, now) in ticks {
            observe_transition(store, running, start, now, &mut misses);
        }
    }

    #[test]
    fn a_single_offline_tick_never_closes_a_live_session() {
        let t0 = ts(2026, 10, 5, 20, 0);
        let mut store = PlaytimeStore::default();
        drive(
            &mut store,
            &[
                (true, Some(t0), t0 + 3),
                (false, None, t0 + 6), // the ToolHelp blip
                (true, Some(t0), t0 + 9),
            ],
        );
        let open = store.open.expect("the blip must not close the session");
        assert_eq!(open.duration(), 9, "heartbeats resumed on the same run");
        assert_eq!(store.launches, 1, "one launch, opened at the first tick");
        assert!(store.sessions.is_empty());
    }

    #[test]
    fn a_blip_past_the_debounce_never_double_counts_or_mints_launches() {
        let t0 = ts(2026, 10, 5, 20, 0);
        let mut store = PlaytimeStore::default();
        // Live 60s, TWO consecutive misses (close), live again on the SAME
        // process, real exit: the split halves must tile the wall clock
        // exactly — no resurrected time, no phantom launch.
        drive(
            &mut store,
            &[
                (true, Some(t0), t0 + 60),
                (false, None, t0 + 63),
                (false, None, t0 + 66),    // second miss → close at t0+60
                (true, Some(t0), t0 + 69), // reopen, floored at t0+60
                (false, None, t0 + 72),
                (false, None, t0 + 75), // real exit → close at t0+69
            ],
        );
        assert!(store.open.is_none());
        assert_eq!(store.launches, 1, "the split was one game run");
        let total: u64 = store.sessions.iter().map(|s| s.duration()).sum();
        assert_eq!(total, 69, "sessions tile [t0, t0+69) with no overlap");
        assert_eq!(store.sessions.len(), 2);
        assert_eq!(
            store.sessions[0],
            PlaytimeSession {
                start: t0,
                end: t0 + 60
            }
        );
        assert_eq!(
            store.sessions[1],
            PlaytimeSession {
                start: t0 + 60,
                end: t0 + 69
            }
        );
    }

    #[test]
    fn a_sleep_gap_splits_instead_of_crediting_the_gap() {
        let t0 = ts(2026, 10, 5, 20, 0);
        let mut store = PlaytimeStore::default();
        drive(
            &mut store,
            &[
                (true, Some(t0), t0 + 60),
                // One hour later (machine slept): the gap must vanish.
                (true, Some(t0), t0 + 60 + 3600),
                (false, None, t0 + 60 + 3610),
                (false, None, t0 + 60 + 3613),
            ],
        );
        assert!(store.open.is_none());
        assert_eq!(store.launches, 1, "the split was one game run");
        let total: u64 = store.sessions.iter().map(|s| s.duration()).sum();
        assert_eq!(total, 60, "the sleep gap is not playtime");
    }

    #[test]
    fn a_client_restart_while_wowsp_was_down_opens_a_fresh_counted_run() {
        let t_old = ts(2026, 10, 4, 20, 0);
        let t_new = t_old + 8000; // the new client's creation time
        let mut store = PlaytimeStore {
            open: Some(PlaytimeSession {
                start: t_old,
                end: t_old + 100,
            }),
            ..PlaytimeStore::default()
        };
        drive(&mut store, &[(true, Some(t_new), t_new + 3)]);
        let open = store.open.expect("a fresh session opened for the new run");
        assert_eq!(
            open.start, t_new,
            "anchored at the new process, not the stale one"
        );
        assert_eq!(store.launches, 1, "the new run counts its launch");
        assert_eq!(
            store.sessions.last().map(|s| s.end),
            Some(t_old + 100),
            "the stale session closed on its own heartbeat"
        );
    }

    // ── the battle ledger (pure core: injected roots + cache) ─────────────

    /// The replay container magic — mirror of replay.rs's private
    /// `REPLAY_MAGIC`, kept in lock-step (a mismatched prefix is exactly how
    /// the corrupt-container stand-in below degrades to a path-only row).
    const TEST_REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];

    /// Write a synthetic WG-format replay (the exact framing replay.rs's
    /// `read_block` parses): magic + 1-block count LE + block length
    /// LE + descriptor JSON, with a stand-in packet stream trailing (which
    /// the bounded header read never touches). Same byte pattern as
    /// replay.rs's `lite_from_path_reads_bounded_first_block` fixture.
    fn write_synthetic_replay(path: &std::path::Path, descriptor: &str) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&TEST_REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
        bytes.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
        bytes.extend_from_slice(descriptor.as_bytes());
        bytes.extend_from_slice(&[0u8; 64]); // stand-in packet stream
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, &bytes).expect("write synthetic replay");
    }

    /// Unique temp replay root per test (this crate has no tempfile
    /// dev-dependency), the same pattern replay.rs's walk tests use.
    fn temp_battle_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wowsp-test-battles-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn battles_count_rows_tag_their_install_and_sort_by_datetime() {
        let dir = temp_battle_dir("owned");
        write_synthetic_replay(
            &dir.join("20261002_111111_PJSB719-Hotaka_15_NE_north.wowsreplay"),
            r#"{"matchGroup":"ranked","vehicles":[]}"#,
        );
        write_synthetic_replay(
            &dir.join("20261001_024940_PRSB910-Kremlin_15_NE_north.wowsreplay"),
            r#"{"matchGroup":"pvp","vehicles":[
                {"id":1,"name":"langyo","relation":0,"shipId":4182828960},
                {"id":2,"name":":Sturdee:","relation":2,"shipId":2}
            ]}"#,
        );
        // A datetime-less filename still counts, sinking to the end; a
        // non-replay file never does.
        write_synthetic_replay(&dir.join("renamed.wowsreplay"), r#"{"matchGroup":"pvp"}"#);
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();

        let steam = GameInstall {
            kind: GameInstallKind::Steam,
            path: r"C:\Games\WoWS".into(),
            realm: Some("eu".into()),
        };
        let mut cache = BattleCache::default();
        let battles = battles_from_roots(&[(dir.clone(), Some(steam))], &mut cache);
        assert_eq!(battles.len(), 3, "every replay container is one battle");
        // Ascending by filename datetime; the undatable row sinks last.
        assert_eq!(battles[0].date_time.as_deref(), Some("20261001_024940"));
        assert_eq!(battles[1].date_time.as_deref(), Some("20261002_111111"));
        assert_eq!(battles[2].date_time, None);
        for b in &battles {
            // Owner tagging: the exact GameInstall.path string + kind/realm.
            assert_eq!(b.install_path, r"C:\Games\WoWS");
            assert_eq!(b.kind, Some(GameInstallKind::Steam));
            assert_eq!(b.realm.as_deref(), Some("eu"));
        }
        assert_eq!(battles[0].match_group.as_deref(), Some("pvp"));
        assert_eq!(battles[0].bot_count, 1);
        assert_eq!(battles[0].player_count, 2);
        assert_eq!(battles[0].own_ship_id, Some(4182828960));
        assert_eq!(battles[0].own_ship_name.as_deref(), Some("langyo"));
        assert_eq!(battles[1].match_group.as_deref(), Some("ranked"));
        // The scan upserted every seen file into the cache.
        assert_eq!(cache.entries.len(), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unowned_roots_answer_rows_without_kind_or_realm() {
        let dir = temp_battle_dir("unowned");
        write_synthetic_replay(
            &dir.join("20261005_210000_solo.wowsreplay"),
            r#"{"matchGroup":"pvp"}"#,
        );
        let mut cache = BattleCache::default();
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert_eq!(battles.len(), 1);
        let b = &battles[0];
        // No owning install: the root's own path stands in, kind/realm stay
        // absent — the frontend scopes these rows only by date.
        assert_eq!(b.install_path, dir.to_string_lossy());
        assert_eq!(b.kind, None);
        assert_eq!(b.realm, None);
        assert_eq!(b.date_time.as_deref(), Some("20261005_210000"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A datetime-named container whose bytes are NOT the replay framing
    /// (any corrupt or foreign file — real Lesta `.korablireplay` containers
    /// parse fine now): the header read fails and the row degrades to date +
    /// empty descriptor fields — still a battle.
    #[test]
    fn an_unparseable_container_still_counts_with_its_filename_datetime() {
        let dir = temp_battle_dir("lesta");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("20260930_080000_PRSB910-Kremlin_XX.korablireplay"),
            b"lesta binary framing",
        )
        .unwrap();
        let mut cache = BattleCache::default();
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert_eq!(battles.len(), 1);
        let b = &battles[0];
        assert_eq!(b.date_time.as_deref(), Some("20260930_080000"));
        assert_eq!(b.match_group, None);
        assert_eq!(b.scenario, None);
        assert_eq!(b.event_type, None);
        assert_eq!(b.bot_count, 0);
        assert_eq!(b.scripted_unit_count, 0);
        assert_eq!(b.own_ship_id, None);
        assert_eq!(b.own_ship_name, None);
        assert_eq!(b.player_count, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A synthetic Lesta `.korablireplay` — WG framing with the Lesta
    /// 4-block payload set (descriptor WITHOUT vehicles / roster
    /// `playersPublicInfo` positional arrays / recorder marker / checksum).
    /// Minimalist mirror of replay.rs's private synthetic-lesta fixture
    /// (kept in lock-step with it): the recorder plus one enemy `:Bot:`.
    fn write_synthetic_lesta_replay(path: &std::path::Path) {
        let descriptor = r#"{"matchGroup":"cooperative","mapDisplayName":"28_naval_mission","mapId":17,
            "playerName":"langyo","clientVersionFromExe":"26,10,0,8867689"}"#;
        let roster = r#"{"playersPublicInfo":{
            "1000000001":[1000000001,"langyo",0,"",0,-1,1,3340711376,0,"RU",[],0,0,-1,0,42500],
            "-268475967":[-268475967,":Bot:",0,"",0,-1,0,4184815568,0,"RU",[],0,0,-1,0,41200]}}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&TEST_REPLAY_MAGIC);
        bytes.extend_from_slice(&4u32.to_le_bytes()); // Lesta writes 4 blocks
        for block in [
            descriptor,
            roster,
            "1000000001.1234567890123456",
            "53BB63FBD4C37D37CF945F0BD78B1EAC",
        ] {
            bytes.extend_from_slice(&(block.len() as u32).to_le_bytes());
            bytes.extend_from_slice(block.as_bytes());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, &bytes).expect("write synthetic korablireplay");
    }

    /// Integration: the battle ledger reads Lesta containers through the
    /// same `lite_from_path` projection as WG replays — the row carries a
    /// non-null match_group and own_ship_id (roster synthesized from
    /// block[1]/block[2] inside replay.rs).
    #[test]
    fn battles_scan_parses_lesta_containers() {
        let dir = temp_battle_dir("lesta-real");
        write_synthetic_lesta_replay(&dir.join("20261001_025958_PRSB505_x.korablireplay"));
        let mut cache = BattleCache::default();
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert_eq!(battles.len(), 1);
        let b = &battles[0];
        assert_eq!(b.date_time.as_deref(), Some("20261001_025958"));
        assert_eq!(b.match_group.as_deref(), Some("cooperative"));
        assert_eq!(b.own_ship_id, Some(3340711376));
        assert_eq!(b.own_ship_name.as_deref(), Some("langyo"));
        assert_eq!(b.player_count, 2);
        assert_eq!(b.bot_count, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Cache semantics: a hit (len + mtime BOTH matching) answers the STORED
    /// parse verbatim — proven by a deliberately mismatching field no
    /// on-disk re-read could produce — and any identity drift re-parses.
    #[test]
    fn a_cache_hit_answers_the_stored_parse_without_rereading() {
        let dir = temp_battle_dir("hit");
        let path = dir.join("20261003_120000_cache_hit.wowsreplay");
        write_synthetic_replay(&path, r#"{"matchGroup":"pvp","vehicles":[]}"#);
        let key = path.to_string_lossy().into_owned();
        let meta = std::fs::metadata(&path).unwrap();
        let mtime_ms = meta
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let mut cache = BattleCache::default();
        cache.entries.insert(
            key.clone(),
            BattleCacheEntry {
                len: meta.len(),
                mtime_ms,
                lite: ReplayMetaLite {
                    path: key.clone(),
                    date_time: Some("20261003_120000".into()),
                    match_group: Some("cached".into()),
                    map_name: None,
                    map_id: None,
                    scenario: None,
                    event_type: None,
                    bot_count: 0,
                    scripted_unit_count: 0,
                    own_ship_id: None,
                    own_ship_name: None,
                    player_count: 0,
                },
            },
        );
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert_eq!(
            battles[0].match_group.as_deref(),
            Some("cached"),
            "the cached parse wins over the on-disk descriptor — no re-read"
        );
        // An mtime drift (stale identity) forces the re-parse.
        cache.entries.get_mut(&key).unwrap().mtime_ms = 1;
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert_eq!(battles[0].match_group.as_deref(), Some("pvp"));
        assert_eq!(
            cache.entries.get(&key).unwrap().mtime_ms,
            mtime_ms,
            "the miss upserted the fresh identity"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Prune semantics: a previously cached path that no longer exists on
    /// disk disappears from the cache after a scan (the file's row goes too).
    #[test]
    fn entries_for_vanished_files_are_pruned_after_a_scan() {
        let dir = temp_battle_dir("prune");
        write_synthetic_replay(
            &dir.join("20261004_100000_gone.wowsreplay"),
            r#"{"matchGroup":"pvp"}"#,
        );
        let mut cache = BattleCache::default();
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert_eq!(battles.len(), 1);
        assert_eq!(cache.entries.len(), 1);
        std::fs::remove_file(dir.join("20261004_100000_gone.wowsreplay")).unwrap();
        let battles = battles_from_roots(&[(dir.clone(), None)], &mut cache);
        assert!(battles.is_empty());
        assert!(cache.entries.is_empty(), "the vanished file was pruned");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn battle_roots_overlap_is_symmetric_across_spellings_and_nesting() {
        let replays = Path::new(r"C:\Games\World of Warships\replays");
        // Same folder, different casing / separators / trailing slash.
        assert!(battle_roots_overlap(
            replays,
            Path::new(r"c:/games/world of warships\replays\")
        ));
        // Nesting counts in both directions (an install root vs its own
        // `replays/`, whichever order the roots arrive in).
        assert!(battle_roots_overlap(
            Path::new(r"C:\Games\World of Warships"),
            replays
        ));
        assert!(battle_roots_overlap(
            replays,
            Path::new(r"C:\Games\World of Warships")
        ));
        // Sibling folders that merely share a prefix stay distinct.
        assert!(!battle_roots_overlap(
            replays,
            Path::new(r"C:\Games\World of Warships 2\replays")
        ));
    }
}
