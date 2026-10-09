//! Rust-side session hub — the single source of truth for "what is running
//! and who is playing", synchronized to EVERY window.
//!
//! Historically the running-process state lived only in the main window (a
//! 3 s poll of `get_game_process`), and the logged-in player was a purely
//! webui-side selection (`accounts.json` + `autoSwitchRealm`, keyed on the
//! realm alone). Two problems fell out of that split:
//!
//! * a second window (the tray panel) had no reactive view of the state —
//!   Pinia stores do not cross webview boundaries, so anything the panel
//!   showed would diverge from the main window within seconds;
//! * on machines with SEVERAL bound accounts on one realm, realm-keyed
//!   auto-switching always landed on the preferred account — the actual
//!   player (the alt someone logged in through the Game Center) could never
//!   be identified, and alt-hopping players desynced the whole app.
//!
//! This module keeps the session state in Rust instead, derives a resolved
//! [`SessionSnapshot`] from three inputs, and broadcasts it as ONE event
//! (`wowsp://session-changed`) that both windows render from:
//!
//! 1. the process poller (below): `GameProcessInfo` every 3 s;
//! 2. the arena watcher (`tempArenaInfo.json`): the local player is the
//!    roster entry with `relation == 0` — the same identity rule the replay
//!    parser uses — which pins the playing account per battle;
//! 3. the in-game plugin bridge roster: exact WG account ids per nickname,
//!    used to UPGRADE the arena nickname match to an id match when the
//!    plugin is installed (nickname renames then can't fool the match).
//!
//! The webui still owns `accounts.json`; this module reads it back
//! (mtime-cached) purely to match observations against the bound profiles,
//! and the `sync_active_account` command lets the main window push its
//! selection changes immediately instead of waiting for the file refresh.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{
    AccountProfile, PlayingAccount, PlayingSource, SessionPlayer, SessionSnapshot,
};

/// Tauri event emitted to ALL windows whenever the resolved snapshot
/// (process / playing / active / display) changes — never per tick.
pub const SESSION_EVENT: &str = "wowsp://session-changed";

/// The webui-owned account registry file (read back, never written here).
const ACCOUNTS_FILE: &str = "accounts.json";

/// Process-poll cadence. Same order as the main window's `getGameProcess`
/// poll; the two pollers coexist (the webui store also feeds the mock
/// backend in browser dev, where no Rust events exist).
#[cfg(desktop)]
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Everything the hub tracks. `plugin_ids` and the accounts cache are
/// inputs, not part of the broadcast snapshot.
struct SessionState {
    process: wowsp_tauri_shared::GameProcessInfo,
    /// Invalidates observations resolving outside the state lock when the
    /// poller changes clients, including a switch away and back to one PID.
    process_generation: u64,
    playing: Option<PlayingAccount>,
    /// The webui's active selection, mirrored through `sync_active_account`
    /// and adopted from `accounts.json` on refresh: `(realm, account_id)`.
    active: Option<(String, i64)>,
    /// nickname → account id, from the in-game plugin bridge's most recent
    /// request roster (cleared implicitly — every request replaces it).
    plugin_ids: Vec<(String, i64)>,
    /// Parsed `accounts.json` profiles, refreshed when the file's mtime
    /// moves (the webui writes it atomically, tmp + rename).
    accounts: Vec<AccountProfile>,
    accounts_mtime: Option<SystemTime>,
    /// mtime (unix secs) of the roster that produced the current `playing`
    /// identity — the freshness gate for the poll path's re-notes (see
    /// [`note_playing_from_arena`]).
    last_noted_arena_mtime: i64,
    /// Last snapshot handed to [`SESSION_EVENT`] — the dedup gate that keeps
    /// the 3 s poller silent while nothing visible changed.
    last_emitted: Option<SessionSnapshot>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            process: offline_process(),
            process_generation: 0,
            playing: None,
            active: None,
            plugin_ids: Vec::new(),
            accounts: Vec::new(),
            accounts_mtime: None,
            last_noted_arena_mtime: 0,
            last_emitted: None,
        }
    }
}

static STATE: Mutex<Option<SessionState>> = Mutex::new(None);

fn offline_process() -> wowsp_tauri_shared::GameProcessInfo {
    wowsp_tauri_shared::GameProcessInfo {
        running: false,
        pid: None,
        kind: None,
        realm: None,
        exe_path: None,
        matched_install: None,
    }
}

/// Run `f` against the session state, recovering from a poisoned lock (a
/// panic inside a note/poll path must not wedge the hub forever — the state
/// is derived data, rebuildable from the next tick).
fn with_state<R>(f: impl FnOnce(&mut SessionState) -> R) -> R {
    let mut guard = STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = guard.get_or_insert_with(SessionState::new);
    f(state)
}

#[cfg(any(desktop, test))]
fn apply_process_info(state: &mut SessionState, info: wowsp_tauri_shared::GameProcessInfo) {
    if state.process.pid != info.pid || state.process.running != info.running {
        state.process_generation = state.process_generation.wrapping_add(1);
        state.playing = None;
        state.plugin_ids.clear();
        // Keep the last roster's stamp: when process start is unavailable,
        // the same leftover arena file must still fail the freshness gate.
    }
    state.process = info;
}

// ── identity matching (pure core, unit-tested) ──────────────────────────────

/// Match a playing observation against the bound profiles: account id when
/// the plugin bridge provided one (exact), else nickname on the same realm,
/// else a UNIQUE case-insensitive nickname hit (the game preserves case, but
/// the user may have bound the profile with different capitalization).
fn match_account(
    accounts: &[AccountProfile],
    realm: &str,
    nickname: &str,
    account_id: Option<i64>,
) -> Option<AccountProfile> {
    if let Some(id) = account_id.filter(|id| *id > 0) {
        // An observed ID cannot belong to a different same-named binding.
        // Nickname fallback is only for observations without exact identity.
        // Main.py uses zero when accountDBID is unavailable.
        return accounts
            .iter()
            .find(|a| a.realm == realm && a.account_id == id)
            .cloned();
    }
    if let Some(hit) = accounts
        .iter()
        .find(|a| a.realm == realm && a.nickname == nickname)
    {
        return Some(hit.clone());
    }
    let ci_hits: Vec<&AccountProfile> = accounts
        .iter()
        .filter(|a| a.realm == realm && a.nickname.eq_ignore_ascii_case(nickname))
        .collect();
    (ci_hits.len() == 1).then(|| ci_hits[0].clone())
}

/// Resolve what the surfaces should display: the playing observation when
/// one exists (registered or not — an unregistered alt still shows, tagged),
/// else the active selection when it resolves to a bound profile.
fn resolve_display(
    playing: Option<&PlayingAccount>,
    active: Option<&AccountProfile>,
    accounts: &[AccountProfile],
) -> Option<SessionPlayer> {
    if let Some(p) = playing {
        let matched = match_account(accounts, &p.realm, &p.nickname, p.account_id);
        return Some(SessionPlayer {
            account_id: matched.as_ref().map(|m| m.account_id).or(p.account_id),
            nickname: matched
                .as_ref()
                .map(|m| m.nickname.clone())
                .unwrap_or_else(|| p.nickname.clone()),
            realm: p.realm.clone(),
            registered: matched.is_some(),
            playing: true,
        });
    }
    let active = active?;
    accounts
        .iter()
        .find(|a| a.realm == active.realm && a.account_id == active.account_id)
        .map(|a| SessionPlayer {
            account_id: Some(a.account_id),
            nickname: a.nickname.clone(),
            realm: a.realm.clone(),
            registered: true,
            playing: false,
        })
}

/// The active selection as a bound profile (for the snapshot's `active`
/// field — surfaces show its nickname when nothing is playing).
fn active_profile(
    active: Option<&(String, i64)>,
    accounts: &[AccountProfile],
) -> Option<AccountProfile> {
    let (realm, id) = active?;
    accounts
        .iter()
        .find(|a| a.realm == *realm && a.account_id == *id)
        .cloned()
}

/// Build the current broadcast snapshot.
fn snapshot_of(state: &SessionState) -> SessionSnapshot {
    let active = active_profile(state.active.as_ref(), &state.accounts);
    SessionSnapshot {
        process: state.process.clone(),
        playing: state.playing.clone(),
        display: resolve_display(state.playing.as_ref(), active.as_ref(), &state.accounts),
        active,
    }
}

/// Emit [`SESSION_EVENT`] when the snapshot changed since the last emit.
/// Compute, compare, bookkeeping AND the emit itself happen under the lock:
/// emitting after release would let two racing updaters deliver a stale
/// snapshot after a fresher one AND desync `last_emitted` from what the
/// windows actually saw. `emit` is sync, thread-safe and never re-enters
/// session state, so holding the mutex across it is safe. A failed emit
/// rolls `last_emitted` back so the next change-bearing tick retries.
fn broadcast_if_changed(app: &AppHandle) {
    let mut guard = STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = guard.get_or_insert_with(SessionState::new);
    let snapshot = snapshot_of(state);
    if state.last_emitted.as_ref() == Some(&snapshot) {
        return;
    }
    match app.emit(SESSION_EVENT, &snapshot) {
        Ok(()) => {
            state.last_emitted = Some(snapshot);
        },
        Err(e) => {
            tracing::warn!(error = %e, "emit session-changed failed");
            state.last_emitted = None;
        },
    }
}

// ── observation hooks (arena watcher + plugin bridge) ───────────────────────

/// The local player's name in a battle roster: the `relation == 0` entry,
/// skipping the game's bot/scripted markers (a real player's slot is what
/// identifies the logged-in account — bots share the id space in ops).
pub(crate) fn local_player_of(vehicles: &[wowsp_tauri_shared::VehicleEntry]) -> Option<&str> {
    vehicles
        .iter()
        .filter(|v| v.relation == 0)
        .map(|v| v.name.as_str())
        .find(|name| {
            !name.is_empty()
                && !name.starts_with(':')
                && !name.starts_with("IDS_")
                && !name.starts_with('#')
        })
}

/// Realm of the RUNNING client (empty-realm filter applied by the caller):
/// the poller's matched install when it resolved one, else a realm re-read
/// from the running process's own root. Never consults the
/// persisted-active/scan fallback tiers — an observation may only ever be
/// attributed to a process that is actually alive.
fn running_realm() -> Option<String> {
    use super::game_context::{RootPreference, RootSource};
    super::game_context::resolve_root(RootPreference::PreferRunning)
        .filter(|r| matches!(r.source, RootSource::RunningProcess))
        .and_then(|r| super::game_detect::detect_realm(&r.root))
}

/// Clock skew absorbed when comparing the roster's mtime against the
/// process creation time (different clocks/file systems round differently).
const ARENA_FRESHNESS_SKEW_SECS: i64 = 5;

/// Note the playing identity from a battle roster (the arena watcher's
/// event path — battle start is the one moment the logged-in account becomes
/// observable on the wire; the poll path re-notes on its 3 s cadence).
///
/// `arena_dir` names the replays folder the roster was read FROM. On
/// multi-instance machines the live page may watch a client that is NOT the
/// preferred one, so the observation is attributed to the process OWNING
/// that folder (realm off its own root, freshness gate against ITS start
/// time). A dir NO running process claims drops the note — attributing a
/// foreign dir's roster to the preferred process would pin another client's
/// account to the wrong cluster; without a dir (the backend-preferred poll
/// path) the preferred process answers, exactly as before.
///
/// Freshness gates, in order:
/// * no client running → drop (a `tempArenaInfo.json` that survives the
///   game — crash / hard kill — is re-read by the poll paths forever, and
///   without this gate it would resurrect the identity the exit transition
///   just cleared);
/// * `arena_mtime` older than the attributing process's creation time →
///   drop (the roster predates this client session: a crash leftover seen
///   right after relaunch, before any new battle was written);
/// * no process start available → fall back to "strictly newer than the
///   last noted roster" (fresh WoWSP mid-game notes once, then the same
///   file never re-notes).
///
/// The realm + process-start resolution runs BEFORE the state lock (it
/// walks the process list and reads clientrunner.log); the id upgrade looks
/// up the plugin bridge's nickname→id map. Broadcasts when the resolved
/// snapshot moved.
pub(crate) fn note_playing_from_arena(
    app: &AppHandle,
    nickname: &str,
    arena_mtime: Option<i64>,
    arena_dir: Option<&std::path::Path>,
) {
    // Attribute the roster. Three cases:
    // * dir given and a running process OWNS it (same-folder compare after
    //   stripping the trailing `replays` segment) → attribute to THAT
    //   process. The validated chain answers first (the rule
    //   `running_root_matching` established); a raw-root fallback finds
    //   stub-less installs the validated chain deliberately hides (the note
    //   can still be refused downstream — record_arena_player keeps the
    //   poller's own running view as its final gate).
    // * dir given and UNCLAIMED → drop the note entirely: attributing a
    //   foreign dir's roster to the preferred process would pin another
    //   client's account to the wrong cluster — exactly what this lookup
    //   exists to prevent.
    // * no dir (the backend-preferred poll path) → the preferred-process
    //   fallback below, exactly as before.
    let dir_owner = match arena_dir.map(arena_game_root) {
        Some(Some(root)) => {
            let procs = super::game_context::running_processes();
            let pid = procs
                .iter()
                .find(|p| {
                    p.validated_root
                        .as_deref()
                        .is_some_and(|r| super::game_context::same_folder(r, &root))
                })
                .or_else(|| {
                    procs.iter().find(|p| {
                        p.raw_root
                            .as_deref()
                            .is_some_and(|r| super::game_context::same_folder(r, &root))
                    })
                })
                .map(|p| p.pid);
            match pid {
                Some(pid) => Some((pid, root)),
                None => {
                    tracing::debug!(
                        dir = %root,
                        "no running client owns the arena dir — dropped"
                    );
                    return;
                },
            }
        },
        Some(None) => return, // not a `<root>/replays` shape — unattributable
        None => None,
    };
    let (realm, gate_pid, observed_generation) = match dir_owner {
        Some((pid, root)) => {
            // The owner is running by construction, so the "no client
            // running" gate cannot apply here; the realm must come off the
            // OWNER's root — the preferred process's realm would attribute
            // another client's account to the wrong cluster.
            let Some(realm) = super::game_detect::detect_realm(std::path::Path::new(&root))
                .filter(|r| !r.is_empty())
            else {
                return;
            };
            let generation = with_state(|state| state.process_generation);
            (realm, Some(pid), generation)
        },
        None => {
            let (running, known, pid, generation) = with_state(|state| {
                (
                    state.process.running,
                    state.process.realm.clone(),
                    state.process.pid,
                    state.process_generation,
                )
            });
            if !running {
                return;
            }
            let realm = known.or_else(running_realm).filter(|r| !r.is_empty());
            let Some(realm) = realm else {
                return;
            };
            (realm, pid, generation)
        },
    };
    if let Some(m) = arena_mtime {
        if let Some(start) = gate_pid.and_then(super::appdata::query_process_start_unix) {
            if m < start - ARENA_FRESHNESS_SKEW_SECS {
                tracing::debug!(
                    mtime = m,
                    process_start = start,
                    "arena roster predates the attributing client — dropped"
                );
                return;
            }
        }
    }
    let noted = with_state(|state| {
        record_arena_player(state, observed_generation, realm, nickname, arena_mtime)
    });
    if noted {
        broadcast_if_changed(app);
    }
}

/// The game root an arena/replays directory belongs to: strip ONE trailing
/// `replays` path component (case-insensitive — Windows folders), tolerating
/// stray separators. `None` when the dir is not a `<root>/replays` shape.
fn arena_game_root(dir: &std::path::Path) -> Option<String> {
    let s = dir.to_str()?;
    let norm = s.trim_end_matches(['/', '\\']);
    let cut = norm.rfind(['/', '\\'])?;
    let (root, leaf) = norm.split_at(cut);
    if !leaf
        .trim_start_matches(['/', '\\'])
        .eq_ignore_ascii_case("replays")
    {
        return None;
    }
    let root = root.trim_end_matches(['/', '\\']);
    (!root.is_empty()).then(|| root.to_string())
}

fn record_arena_player(
    state: &mut SessionState,
    observed_generation: u64,
    realm: String,
    nickname: &str,
    arena_mtime: Option<i64>,
) -> bool {
    // Realm/process-start resolution runs outside the mutex. A poll may
    // have retired its source in the meantime; do not revive that identity
    // or let its timestamp suppress the new client's next observation.
    if !state.process.running || state.process_generation != observed_generation {
        return false;
    }
    if let Some(m) = arena_mtime {
        if m <= state.last_noted_arena_mtime {
            return false;
        }
        state.last_noted_arena_mtime = m;
    }
    let account_id = state
        .plugin_ids
        .iter()
        .find(|(name, _)| name == nickname)
        .map(|(_, id)| *id);
    let next = PlayingAccount {
        realm,
        nickname: nickname.to_string(),
        account_id,
        source: PlayingSource::Arena,
    };
    let changed = state.playing.as_ref() != Some(&next);
    if changed {
        state.playing = Some(next);
    }
    changed
}

/// Note the plugin bridge's latest request roster (nickname → exact account
/// id). Never broadcasts on its own — the ids only matter once an arena
/// observation names the local player, and the poller picks the resulting
/// snapshot change up within one tick.
pub(crate) fn note_plugin_roster(rows: &[(String, Option<i64>)]) {
    with_state(|state| {
        let next: Vec<(String, i64)> = rows
            .iter()
            .filter_map(|(name, id)| id.map(|id| (name.clone(), id)))
            .collect();
        state.plugin_ids = next;
        // An already-noted playing identity may gain its exact id now.
        if let Some(p) = state.playing.as_mut() {
            if p.account_id.is_none() {
                p.account_id = state
                    .plugin_ids
                    .iter()
                    .find(|(name, _)| name == &p.nickname)
                    .map(|(_, id)| *id);
            }
        }
    });
}

// ── accounts.json read-back (mtime-cached) ─────────────────────────────────

/// The webui's persisted registry shape. Only the fields the hub consumes
/// are declared; `preferred` is irrelevant to identity resolution.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsFile {
    #[serde(default)]
    accounts: Vec<AccountProfile>,
    #[serde(default)]
    active_account_id: Option<i64>,
    #[serde(default)]
    active_realm: Option<String>,
}

/// Re-read `accounts.json` when its mtime moved, and adopt the file's active
/// selection (the webui persists + syncs it; the file is the backstop when
/// the sync invoke is still in flight — e.g. right after app start, before
/// the main window loaded its stores).
fn refresh_accounts(state: &mut SessionState) {
    let Ok(dir) = super::appdata::appdata_dir_path() else {
        return;
    };
    let path = dir.join(ACCOUNTS_FILE);
    let Ok(meta) = std::fs::metadata(&path) else {
        // Registry gone (user unbound everything) — drop the stale views.
        if state.accounts_mtime.is_some() {
            state.accounts.clear();
            state.accounts_mtime = None;
            state.active = None;
        }
        return;
    };
    let Ok(mtime) = meta.modified() else {
        return;
    };
    if state.accounts_mtime == Some(mtime) {
        return;
    }
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    match serde_json::from_str::<AccountsFile>(&raw) {
        Ok(file) => {
            state.accounts = file.accounts;
            if let (Some(realm), Some(id)) = (file.active_realm, file.active_account_id) {
                if !realm.is_empty() {
                    state.active = Some((realm, id));
                }
            }
            state.accounts_mtime = Some(mtime);
        },
        Err(e) => {
            // A mid-write read should be impossible (atomic rename), but a
            // hand-edited file must not turn the 3 s tick into a warn-per-
            // tick firehose: pin the cache to this mtime (keep the last
            // known data) and re-read only when the file moves again — the
            // webui's next persist heals it.
            tracing::warn!(error = %e, "accounts.json unreadable — keeping last known");
            state.accounts_mtime = Some(mtime);
        },
    }
}

// ── commands ────────────────────────────────────────────────────────────────

/// Current session snapshot (one invoke; live updates arrive via
/// [`SESSION_EVENT`]). Async so the mtime-gated accounts re-read never runs
/// on the webview IPC thread.
#[tauri::command]
pub async fn get_session_state() -> SessionSnapshot {
    with_state(|state| {
        refresh_accounts(state);
        snapshot_of(state)
    })
}

/// The main window mirrors its active-account selection here so the session
/// hub (and with it every other window) sees the change immediately instead
/// of on the next accounts.json refresh. `None` clears the mirror.
#[tauri::command]
pub fn sync_active_account(
    app: AppHandle,
    realm: Option<String>,
    account_id: Option<i64>,
) -> Result<(), String> {
    with_state(|state| {
        state.active = match (realm, account_id) {
            (Some(r), Some(id)) if !r.is_empty() => Some((r, id)),
            _ => None,
        };
    });
    broadcast_if_changed(&app);
    Ok(())
}

// ── process poller ──────────────────────────────────────────────────────────

/// Spawn the session poller (desktop setup): every tick, refresh the
/// accounts cache, recompute the running-process info, clear the playing
/// identity when the client exited, poll the battle roster for the playing
/// identity (the hub's INDEPENDENT feed — it must not depend on any webview
/// surface: the overlay's arena watcher only runs in table mode "detect",
/// the live view's poll only while /live is open), and broadcast on any
/// snapshot change. The first tick runs immediately so an early
/// `get_session_state` (tray panel opening) never sees a stale offline
/// process. Never spawned on mobile — no tray panel, no game process and no
/// arena file to feed it.
#[cfg(desktop)]
pub fn spawn_session_poller(app: AppHandle) -> Result<(), String> {
    std::thread::Builder::new()
        .name("wowsp-session".into())
        .spawn(move || {
            // The roster mtime this loop last parsed — the parse gate (the
            // file only changes when a battle starts). Reset whenever the
            // running PID changes so a new client session (or a transient
            // offline blip) re-reads the current file; the hub's own
            // freshness gate still decides whether it re-notes.
            let mut arena_parsed_mtime: i64 = 0;
            let mut prev_pid: Option<u32> = None;
            loop {
                let installs = super::game_context::cached_scan();
                let info = super::appdata::compute_process_info(&installs);
                // The playtime tracker rides the same 3 s heartbeat: opens,
                // heartbeats and closes the client's playtime session in the
                // AppData ledger (commands/playtime.rs).
                super::playtime::observe(&info);
                if info.pid != prev_pid {
                    arena_parsed_mtime = 0;
                    prev_pid = info.pid;
                }
                with_state(|state| {
                    refresh_accounts(state);
                    apply_process_info(state, info.clone());
                });
                if info.running {
                    if let Some((name, mtime)) =
                        super::arena_info::newer_arena_local_player(arena_parsed_mtime)
                    {
                        arena_parsed_mtime = mtime;
                        // The poller's arena read follows the backend-preferred
                        // dir (newer_arena_local_player), so the note attributes to
                        // the preferred process.
                        note_playing_from_arena(&app, &name, Some(mtime), None);
                    }
                }
                broadcast_if_changed(&app);
                std::thread::sleep(POLL_INTERVAL);
            }
        })
        .map(|_| ())
        .map_err(|e| format!("failed to spawn the session poller thread: {e}"))
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::PlayingSource;

    #[test]
    fn arena_game_root_strips_one_trailing_replays_component() {
        use std::path::Path;
        assert_eq!(
            arena_game_root(Path::new(r"C:\Games\Steam\replays")),
            Some(r"C:\Games\Steam".to_string())
        );
        // Case-insensitive leaf, stray separators tolerated.
        assert_eq!(
            arena_game_root(Path::new("D:/Korabli/Replays/")),
            Some("D:/Korabli".to_string())
        );
        // Not a replays folder / no parent / drive root — no owner.
        assert_eq!(arena_game_root(Path::new(r"C:\Games\bin64")), None);
        assert_eq!(arena_game_root(Path::new("replays")), None);
        assert_eq!(arena_game_root(Path::new("/replays")), None);
    }

    fn account(id: i64, nickname: &str, realm: &str) -> AccountProfile {
        AccountProfile {
            account_id: id,
            nickname: nickname.to_string(),
            realm: realm.to_string(),
        }
    }

    fn process(pid: u32, realm: &str) -> wowsp_tauri_shared::GameProcessInfo {
        wowsp_tauri_shared::GameProcessInfo {
            running: true,
            pid: Some(pid),
            realm: Some(realm.to_string()),
            ..offline_process()
        }
    }

    #[test]
    fn exact_unbound_id_never_adopts_a_same_named_bound_account() {
        let accounts = vec![
            account(1, "ReusedName", "asia"),
            account(99, "Elsewhere", "eu"),
        ];
        for nickname in ["ReusedName", "REUSEDNAME"] {
            let playing = PlayingAccount {
                realm: "asia".into(),
                nickname: nickname.into(),
                account_id: Some(99),
                source: PlayingSource::Arena,
            };
            let display = resolve_display(Some(&playing), None, &accounts).unwrap();
            assert_eq!(
                display.account_id,
                Some(99),
                "the observed ID is authoritative"
            );
            assert!(
                !display.registered,
                "the same-name binding is another account"
            );
            assert_eq!(display.nickname, nickname);
        }
    }

    #[test]
    fn unknown_plugin_id_retains_nickname_fallback() {
        let accounts = vec![account(10, "Main", "asia")];
        // Main.py sends zero when the game has not provided accountDBID.
        for account_id in [None, Some(0)] {
            let playing = PlayingAccount {
                realm: "asia".into(),
                nickname: "MAIN".into(),
                account_id,
                source: PlayingSource::Arena,
            };
            let display = resolve_display(Some(&playing), None, &accounts).unwrap();
            assert_eq!(display.account_id, Some(10));
            assert!(display.registered);
        }
    }

    #[test]
    fn process_switch_retires_playing_identity_without_an_offline_tick() {
        let mut state = SessionState::new();
        state.process = process(1, "asia");
        state.accounts = vec![account(10, "Main", "asia")];
        state.active = Some(("asia".into(), 10));
        state.plugin_ids = vec![("Alt".into(), 20)];
        assert!(record_arena_player(
            &mut state,
            0,
            "asia".into(),
            "Alt",
            Some(500)
        ));
        apply_process_info(&mut state, process(2, "eu"));
        assert!(
            state.playing.is_none(),
            "the new client has no known login yet"
        );
        assert!(
            state.plugin_ids.is_empty(),
            "plugin IDs belong to the old client"
        );
        assert_eq!(state.last_noted_arena_mtime, 500);
        assert_eq!(snapshot_of(&state).display.unwrap().account_id, Some(10));
        let generation = state.process_generation;
        assert!(!record_arena_player(
            &mut state,
            generation,
            "eu".into(),
            "OldFile",
            Some(500)
        ));
    }

    #[test]
    fn late_arena_observation_cannot_restore_a_retired_process() {
        for replacement in [process(2, "eu"), offline_process()] {
            let mut state = SessionState::new();
            state.process = process(1, "asia");
            let observed_generation = state.process_generation;
            // The poller changes clients while the arena hook resolves the
            // old process's realm/start time outside the state lock.
            apply_process_info(&mut state, replacement);
            assert!(!record_arena_player(
                &mut state,
                observed_generation,
                "asia".into(),
                "Old",
                Some(500)
            ));
            assert!(state.playing.is_none());
            assert_eq!(
                state.last_noted_arena_mtime, 0,
                "a rejected observation cannot advance the gate"
            );
            if state.process.running {
                let generation = state.process_generation;
                assert!(record_arena_player(
                    &mut state,
                    generation,
                    "eu".into(),
                    "New",
                    Some(100)
                ));
                assert_eq!(state.playing.as_ref().unwrap().nickname, "New");
            }
        }
    }

    #[test]
    fn an_old_observation_stays_retired_after_switching_back_to_its_pid() {
        for intermediate in [process(2, "eu"), offline_process()] {
            let mut state = SessionState::new();
            state.process = process(1, "asia");
            let observed_generation = state.process_generation;
            apply_process_info(&mut state, intermediate);
            apply_process_info(&mut state, process(1, "asia"));
            assert!(!record_arena_player(
                &mut state,
                observed_generation,
                "asia".into(),
                "Old",
                Some(500)
            ));
            assert!(state.playing.is_none());
        }
    }

    #[test]
    fn unchanged_process_retains_its_identity_and_roster_gate() {
        let mut state = SessionState::new();
        state.process = process(1, "asia");
        state.plugin_ids = vec![("Main".into(), 10)];
        record_arena_player(&mut state, 0, "asia".into(), "Main", Some(500));
        let playing = state.playing.clone();
        apply_process_info(&mut state, process(1, "asia"));
        assert_eq!(state.playing, playing);
        assert_eq!(state.plugin_ids, vec![("Main".into(), 10)]);
        assert_eq!(state.last_noted_arena_mtime, 500);
        assert!(!record_arena_player(
            &mut state,
            0,
            "asia".into(),
            "Stale",
            Some(500)
        ));
    }

    /// Two alts bound on the SAME realm: nickname matching picks the one
    /// actually playing, not the realm's preferred account.
    #[test]
    fn nickname_match_picks_the_playing_alt() {
        let accounts = vec![
            account(1, "MainTank", "asia"),
            account(2, "AltDestroyer", "asia"),
            account(3, "OtherRealm", "eu"),
        ];
        let got = match_account(&accounts, "asia", "AltDestroyer", None).expect("matched");
        assert_eq!(got.account_id, 2);
        // A different realm's same-named account never matches.
        assert!(match_account(&accounts, "eu", "AltDestroyer", None).is_none());
    }

    /// An exact account id wins over nickname (renames can't desync). Two
    /// bindings with the SAME nickname are a stale rebind (WG nicknames are
    /// unique per realm), so the exact tier just takes the first.
    #[test]
    fn account_id_takes_precedence() {
        let accounts = vec![account(1, "OldName", "ru"), account(2, "OldName", "ru")];
        let got = match_account(&accounts, "ru", "OldName", Some(2)).expect("matched");
        assert_eq!(got.account_id, 2);
        let got = match_account(&accounts, "ru", "OldName", None).expect("first hit");
        assert_eq!(got.account_id, 1);
    }

    /// Case-insensitive matching only when UNIQUE — capitalization drift in
    /// a hand-bound profile resolves, ambiguity stays unresolved.
    #[test]
    fn case_insensitive_only_when_unique() {
        let accounts = vec![account(1, "mainTank", "na")];
        let got = match_account(&accounts, "na", "MainTank", None).expect("matched");
        assert_eq!(got.account_id, 1);
        let both = vec![account(1, "MainTank", "na"), account(2, "maintank", "na")];
        assert!(match_account(&both, "na", "MAINTANK", None).is_none());
    }

    /// Display resolution: a registered playing account renders registered;
    /// an unbound alt still renders (tagged unregistered); with nothing
    /// playing the active selection shows; nothing at all renders nothing.
    #[test]
    fn display_prefers_playing_then_active() {
        let accounts = vec![account(1, "Main", "asia"), account(2, "Alt", "asia")];
        let playing = PlayingAccount {
            realm: "asia".into(),
            nickname: "Alt".into(),
            account_id: None,
            source: PlayingSource::Arena,
        };
        let display = resolve_display(Some(&playing), None, &accounts).expect("playing resolves");
        assert_eq!(display.account_id, Some(2));
        assert!(display.registered && display.playing);

        let stranger = PlayingAccount {
            realm: "asia".into(),
            nickname: "SomeoneElse".into(),
            account_id: None,
            source: PlayingSource::Arena,
        };
        let display = resolve_display(Some(&stranger), None, &accounts).expect("shows");
        assert_eq!(display.account_id, None);
        assert!(!display.registered && display.playing);
        assert_eq!(display.nickname, "SomeoneElse");

        let active = account(1, "Main", "asia");
        let display = resolve_display(None, Some(&active), &accounts).expect("active shows");
        assert_eq!(display.account_id, Some(1));
        assert!(display.registered && !display.playing);

        assert!(resolve_display(None, None, &accounts).is_none());
    }

    /// The active mirror only projects a bound profile.
    #[test]
    fn active_profile_requires_bound_account() {
        let accounts = vec![account(1, "Main", "asia")];
        assert!(active_profile(Some(&("asia".into(), 1)), &accounts).is_some());
        assert!(active_profile(Some(&("asia".into(), 9)), &accounts).is_none());
        assert!(active_profile(None, &accounts).is_none());
    }

    /// The relation-0 extraction skips bots and scripted markers but takes
    /// the first real player.
    #[test]
    fn local_player_skips_markers() {
        use wowsp_tauri_shared::VehicleEntry;
        let mk = |name: &str, relation: i64| VehicleEntry {
            id: 0,
            name: name.to_string(),
            relation,
            ship_id: 0,
            ship_name: None,
        };
        let vehicles = vec![mk(":Bot:", 0), mk("RealPlayer", 0), mk("Enemy", 2)];
        assert_eq!(local_player_of(&vehicles), Some("RealPlayer"));
        assert_eq!(local_player_of(&[]), None);
    }
    /// The accounts registry parses the webui's exact on-disk shape
    /// (camelCase keys, optional fields).
    #[test]
    fn accounts_file_parses_webui_shape() {
        let raw = r#"{
            "accounts": [
                {"accountId": 123, "nickname": "Tester", "realm": "asia"},
                {"accountId": 456, "nickname": "Ру", "realm": "ru"}
            ],
            "activeAccountId": 456,
            "activeRealm": "ru",
            "preferred": {"asia": 123}
        }"#;
        let file: AccountsFile = serde_json::from_str(raw).expect("parses");
        assert_eq!(file.accounts.len(), 2);
        assert_eq!(file.accounts[1].nickname, "Ру");
        assert_eq!(file.active_account_id, Some(456));
        assert_eq!(file.active_realm.as_deref(), Some("ru"));
        // Empty/absent fields default — a fresh install with no file yet.
        let empty: AccountsFile = serde_json::from_str("{}").expect("empty parses");
        assert!(empty.accounts.is_empty());
        assert!(empty.active_account_id.is_none());
    }
}
