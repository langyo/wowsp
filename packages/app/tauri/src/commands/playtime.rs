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
//! * First run, when no ledger file exists yet, the career TOTAL is seeded
//!   from the Steam client where possible (`userdata/<account>/config/
//!   localconfig.vdf` → `UserLocalConfigStore/…/apps/<appid>/Playtime`, in
//!   MINUTES — Steam's own accounting for appid 552990). The WG Game
//!   Center / 360 launchers keep no readable playtime record, so non-Steam
//!   installs simply start from zero; the ledger records which path it took
//!   in `source`.
//! * The webui reads everything through [`playtime_overview`]. The imported
//!   backlog is undated, so it rides `imported_total_seconds` and never
//!   leaks into the per-day series — the charts only ever show locally
//!   observed days.
//!
//! The ledger (`playtime.json`, AppData root) stays Rust-owned: the webui
//! never reads or writes it directly, unlike `accounts.json`.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use wowsp_tauri_shared::{PlaytimeDay, PlaytimeLaunch, PlaytimeOverview, PlaytimeSource};

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

/// A brand-new ledger: attempt the once-only Steam seed, then persist.
fn fresh_store() -> PlaytimeStore {
    let mut store = PlaytimeStore::default();
    #[cfg(desktop)]
    if let Some(seconds) = try_import_steam_total() {
        tracing::info!(
            seconds,
            "seeded career playtime total from the Steam client"
        );
        store.source = PlaytimeSource::Steam;
        store.imported_total_seconds = seconds;
        store.imported_at = Some(now_unix());
    }
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

/// Scan the Steam client's userdata for recorded WoWS playtime and import it
/// when it EXCEEDS what the ledger already carries. This is the muscle behind
/// the 游玩时间 view's low-total hint: the first-run seed runs once (and can
/// find nothing on a non-Steam machine), so the user gets an explicit,
/// retryable path instead of a permanent small number. Answers the refreshed overview either way — the webui compares
/// totals for its feedback. Cross-platform command: mobile finds no Steam
/// userdata and answers the unchanged overview.
#[tauri::command]
pub fn playtime_import_steam() -> PlaytimeOverview {
    // Scan OUTSIDE the state lock — the walk reads a handful of files per
    // Steam account and must not stall the 3 s poller's observe path.
    #[cfg(desktop)]
    let scanned = scan_steam_playtime();
    #[cfg(not(desktop))]
    let scanned = None;
    let now = now_unix();
    with_state(|state| {
        if let Some(seconds) = scanned {
            // Steam's number IS the career total: import only when it
            // exceeds the total the ledger would currently report (the
            // local sessions may already exceed a stale Steam record —
            // importing those would double-count), and back the local
            // window OUT of it so the combined total lands exactly on the
            // Steam figure and keeps growing with new local sessions.
            let snapshot = overview_of(&state.store, now, &Local);
            if seconds > snapshot.total_seconds {
                tracing::info!(
                    seconds,
                    total = snapshot.total_seconds,
                    "playtime rescan imported a larger Steam career total"
                );
                state.store.source = PlaytimeSource::Steam;
                state.store.imported_total_seconds = seconds - snapshot.local_total_seconds;
                state.store.imported_at = Some(now);
                if let Err(e) = persist_store(&state.store) {
                    tracing::warn!(error = %e, "playtime rescan persist failed");
                }
            }
        }
        overview_of(&state.store, now, &Local)
    })
}

// ── Steam seed + rescan (desktop only — userdata files live on desktops) ───

/// Descend the real on-disk shape —
/// `UserLocalConfigStore → Software → Valve → Steam → apps → <appid> →
/// Playtime` — and parse the MINUTES value (verified against a live
/// client: `Playtime` counts minutes, `Playtime2wks` likewise; the first
/// cut read it as hours and every sane number tripped the garbage clamp).
/// A file without the `UserLocalConfigStore` wrapper (hand-written or
/// older layouts) falls back to a bare `Software` root. Pure so the
/// descent is unit-tested: the app node is itself a MAP, so the value
/// only ever resolves through its `Playtime` leaf.
#[cfg(desktop)]
fn steam_app_playtime_minutes(map: &Vdf, appid: &str) -> Option<u64> {
    let root = map.get("UserLocalConfigStore").unwrap_or(map);
    root.get("Software")?
        .get("Valve")?
        .get("Steam")?
        .get("apps")?
        .get(appid)?
        .get("Playtime")?
        .as_str()?
        .parse::<u64>()
        .ok()
}

/// Steam's recorded playtime for WoWS (appid 552990), in seconds — the
/// largest figure across EVERY account's `localconfig.vdf`, because the
/// account carrying the hours is not always the one that logged in last
/// (and modern Steam clients no longer write `MostRecent` into
/// `loginusers.vdf` at all, so there is no cheap "current account" to
/// read). Best effort: ANY failure (no Steam, no userdata, unparsable
/// vdf, missing field) returns `None` and the ledger starts local.
#[cfg(desktop)]
fn try_import_steam_total() -> Option<u64> {
    scan_steam_playtime()
}

/// The largest recorded WoWS playtime across every Steam account in a
/// `userdata/` root (seconds; `None` when nothing usable was found).
#[cfg(desktop)]
fn best_steam_playtime_at(userdata: &std::path::Path) -> Option<u64> {
    let entries = std::fs::read_dir(userdata).ok()?;
    let mut best: Option<u64> = None;
    for entry in entries.flatten() {
        let path = entry.path().join("config").join("localconfig.vdf");
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(map) = parse_vdf(&text) else {
            continue;
        };
        let Some(seconds) = steam_app_playtime_minutes(&map, super::game_detect::STEAM_APPID)
            .and_then(playtime_seconds_from_minutes)
        else {
            continue;
        };
        if best.is_none_or(|b| seconds > b) {
            best = Some(seconds);
        }
    }
    best
}

/// [`best_steam_playtime_at`] against the real Steam install's userdata root.
#[cfg(desktop)]
fn scan_steam_playtime() -> Option<u64> {
    let steam = super::game_detect::resolve_steam_install()?;
    best_steam_playtime_at(&steam.join("userdata"))
}

/// Steam counts the per-app playtime in MINUTES. Zero (never launched
/// here) and anything beyond ~114 years of continuous play read as
/// garbage and are rejected — a misparse must never poison the career
/// total.
#[cfg(desktop)]
fn playtime_seconds_from_minutes(minutes: u64) -> Option<u64> {
    if minutes == 0 || minutes > 60_000_000 {
        return None;
    }
    Some(minutes * 60)
}

// ── minimal VDF reader ─────────────────────────────────────────────────────
// Steam's "KeyValues" text format. appmanifest.acf only needs flat line
// lookups (game_detect keeps its toy reader), but localconfig.vdf nests the
// per-app data several levels deep, so this module carries a small real
// parser: quoted tokens, `{ ... }` maps, `\"` `\\` `\n` `\r` `\t` escapes.
// Unquoted tokens are accepted (the format allows them) but Steam's own
// files never write them.

/// A parsed VDF node: a string value or a nested map (insertion-ordered,
/// looked up linearly — these files have tens of keys per level at most).
#[cfg(desktop)]
#[derive(Debug, Clone, PartialEq)]
enum Vdf {
    Str(String),
    Map(Vec<(String, Vdf)>),
}

#[cfg(desktop)]
impl Vdf {
    fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Str(_) => None,
            Vdf::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Map(_) => None,
        }
    }
}

#[cfg(desktop)]
fn parse_vdf(text: &str) -> Option<Vdf> {
    // A UTF-8 BOM would weld itself onto the first key (the Lesta config
    // reader strips one for the same reason); Steam's own files ship
    // BOM-less, but a hand-exported one must not break the root lookup.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let chars: Vec<char> = text.chars().collect();
    let mut pos = 0usize;
    let node = parse_vdf_map(&chars, &mut pos, true)?;
    // Trailing garbage after the root map's close is tolerated (Steam files
    // sometimes end with stray whitespace/comments) — only unterminated
    // input fails.
    Some(node)
}

/// Skip whitespace (VDF writes keys/values tab-indented, CRLF-separated).
#[cfg(desktop)]
fn skip_vdf_ws(chars: &[char], pos: &mut usize) {
    while *pos < chars.len() && chars[*pos].is_whitespace() {
        *pos += 1;
    }
}

/// One `"quoted"` token with VDF escapes (or a bare token up to whitespace /
/// a brace / a quote, for hand-edited files).
#[cfg(desktop)]
fn parse_vdf_token(chars: &[char], pos: &mut usize) -> Option<String> {
    skip_vdf_ws(chars, pos);
    match chars.get(*pos)? {
        '"' => {
            *pos += 1;
            let mut out = String::new();
            loop {
                let c = *chars.get(*pos)?;
                *pos += 1;
                match c {
                    '"' => return Some(out),
                    '\\' => {
                        let esc = *chars.get(*pos)?;
                        *pos += 1;
                        out.push(match esc {
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            other => other, // \\ and \" — anything else passes through
                        });
                    },
                    other => out.push(other),
                }
            }
        },
        c if !c.is_whitespace() && *c != '{' && *c != '}' => {
            let start = *pos;
            while *pos < chars.len()
                && !chars[*pos].is_whitespace()
                && chars[*pos] != '{'
                && chars[*pos] != '}'
                && chars[*pos] != '"'
            {
                *pos += 1;
            }
            Some(chars[start..*pos].iter().collect())
        },
        _ => None,
    }
}

/// Parse a `{ key value ... }` map. At the top level, EOF closes the map;
/// nested maps require their closing `}`.
#[cfg(desktop)]
fn parse_vdf_map(chars: &[char], pos: &mut usize, top: bool) -> Option<Vdf> {
    let mut entries: Vec<(String, Vdf)> = Vec::new();
    loop {
        skip_vdf_ws(chars, pos);
        match chars.get(*pos) {
            None => return top.then_some(Vdf::Map(entries)),
            Some('}') => {
                *pos += 1;
                return Some(Vdf::Map(entries));
            },
            Some(_) => {
                let key = parse_vdf_token(chars, pos)?;
                skip_vdf_ws(chars, pos);
                match chars.get(*pos) {
                    Some('{') => {
                        *pos += 1;
                        let child = parse_vdf_map(chars, pos, false)?;
                        entries.push((key, child));
                    },
                    Some('}') | None => return None, // key without a value
                    Some(_) => {
                        let value = parse_vdf_token(chars, pos)?;
                        entries.push((key, Vdf::Str(value)));
                    },
                }
            },
        }
    }
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

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

    #[test]
    fn playtime_minutes_convert_with_a_sanity_clamp() {
        assert_eq!(playtime_seconds_from_minutes(6_150), Some(369_000));
        assert_eq!(playtime_seconds_from_minutes(60), Some(3600));
        assert_eq!(
            playtime_seconds_from_minutes(0),
            None,
            "never launched here"
        );
        assert_eq!(
            playtime_seconds_from_minutes(60_000_001),
            None,
            "beyond ~114 years of continuous play is a misparse"
        );
    }

    /// The REAL `localconfig.vdf` shape, captured from a live client: the
    /// per-app data sits under a `UserLocalConfigStore` root and
    /// `Playtime` counts MINUTES (as does `Playtime2wks`).
    const LOCAL_CONFIG: &str = r#"
"UserLocalConfigStore"
{
    "Software"
    {
        "Valve"
        {
            "Steam"
            {
                "apps"
                {
                    "552990"
                    {
                        "LastPlayed"     "1791202787"
                        "Playtime2wks"   "866"
                        "Playtime"       "134479"
                        "BadgeData"      "02000000080d"
                    }
                    "753532"
                    {
                        "Playtime"       "0"
                    }
                }
            }
        }
    }
}
"#;

    #[test]
    fn vdf_parser_reads_nested_maps_and_escapes() {
        let map = parse_vdf(LOCAL_CONFIG).expect("parses");
        let apps = map
            .get("UserLocalConfigStore")
            .and_then(|v| v.get("Software"))
            .and_then(|v| v.get("Valve"))
            .and_then(|v| v.get("Steam"))
            .and_then(|v| v.get("apps"))
            .expect("the apps level resolves");
        // The 552990 node is itself a map — as_str() must refuse it, and
        // its leaves must resolve through get().
        let node = apps.get("552990").expect("the app node exists");
        assert_eq!(node.as_str(), None, "a map node is not a string leaf");
        assert_eq!(
            node.get("Playtime").and_then(|v| v.as_str()),
            Some("134479")
        );
        assert_eq!(
            node.get("LastPlayed").and_then(|v| v.as_str()),
            Some("1791202787")
        );
        assert!(apps.get("999999").is_none());

        let escaped = parse_vdf(r#""k" "a\"b\\c\nd""#).expect("parses");
        assert_eq!(escaped.get("k").unwrap().as_str(), Some("a\"b\\c\nd"));
        assert!(
            parse_vdf("\"key\"").is_none(),
            "a key without a value fails"
        );
        assert!(
            parse_vdf("\"a\" \"b\" }").is_some(),
            "trailing junk tolerated"
        );
        assert!(parse_vdf("").is_some(), "an empty file is an empty root");
        // A BOM must not weld itself onto the first key.
        let bom = parse_vdf("\u{feff}\"UserLocalConfigStore\" { }").expect("parses");
        assert!(bom.get("UserLocalConfigStore").is_some());
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

    #[cfg(desktop)]
    #[test]
    fn steam_playtime_minutes_descend_the_real_shape() {
        let map = parse_vdf(LOCAL_CONFIG).expect("parses");
        // The REAL shape: minutes under a UserLocalConfigStore root (the
        // seed's first cut grabbed the app's MAP node for a string; the
        // second cut missed the wrapper and read hours — both silent
        // no-ops this pins out).
        assert_eq!(
            steam_app_playtime_minutes(&map, super::super::game_detect::STEAM_APPID),
            Some(134_479)
        );
        // Another app carries Playtime "0" (never launched — the clamp
        // rejects it later); a missing app has nothing to resolve.
        assert_eq!(steam_app_playtime_minutes(&map, "753532"), Some(0));
        assert_eq!(steam_app_playtime_minutes(&map, "999999"), None);
        // A wrapper-less (hand-written) file falls back to the bare root.
        let bare = parse_vdf(
            r#""Software" { "Valve" { "Steam" { "apps" { "1" { "Playtime" "42" } } } } }"#,
        )
        .expect("parses");
        assert_eq!(steam_app_playtime_minutes(&bare, "1"), Some(42));
    }

    #[cfg(desktop)]
    #[test]
    fn best_steam_playtime_takes_the_largest_account() {
        let tmp = std::env::temp_dir().join(format!(
            "wowsp-test-steam-scan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let write_account = |id: &str, body: &str| {
            let dir = tmp.join(id).join("config");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("localconfig.vdf"), body).unwrap();
        };
        // One account with a wrapper-less stale record, one with the real
        // shape carrying the main hours, both in MINUTES.
        write_account(
            "111",
            r#""Software" { "Valve" { "Steam" { "apps" { "552990" { "Playtime" "150" } } } } }"#,
        );
        write_account(
            "222",
            r#""UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "552990" { "Playtime" "134479" } } } } } }"#,
        );
        // An account with no localconfig at all, and one with a garbage one.
        std::fs::create_dir_all(tmp.join("333").join("config")).unwrap();
        write_account("444", "not a vdf at all {");

        let best = best_steam_playtime_at(&tmp);
        assert_eq!(best, Some(134_479 * 60));

        // An empty userdata root finds nothing.
        let empty = tmp.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(best_steam_playtime_at(&empty), None);
        assert_eq!(best_steam_playtime_at(&tmp.join("missing")), None);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Live-machine smoke (soft-pass without Steam, the same stance as
    /// game_detect's detects_steam_install_on_this_machine): when a real
    /// localconfig.vdf records WoWS, the scan MUST resolve it — this is
    /// the exact path that silently no-oped twice.
    #[cfg(all(desktop, target_os = "windows"))]
    #[test]
    fn resolves_the_real_steam_record_on_this_machine() {
        let Some(best) = scan_steam_playtime() else {
            eprintln!("[steam-scan] no Steam WoWS record on this machine — ok");
            return;
        };
        eprintln!("[steam-scan] resolved {best} seconds from real userdata");
        assert!(best >= 3600, "a real record is at least an hour");
    }
}
