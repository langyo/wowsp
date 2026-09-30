//! The 游戏内展示 view mode's backend half: answer the in-game plugin's
//! `request.json` with stats rows (protocol v1, see
//! `docs/en/designs/ingame-stats-plugin.md`). The plugin renders nothing
//! on its own initiative — it writes a request once per stable battle
//! roster (plus manual refreshes) and polls `response.json` while busy;
//! this worker is the companion that used to be missing.
//!
//! Lifecycle mirrors the overlay window: the webui's `useOverlayLifecycle`
//! starts the bridge when the game runs AND the view mode is `"ingame"`
//! ([`super::overlay_config::ingame_view_mode`]), and stops it otherwise.
//! The overlay modes never answer — that is what keeps the in-game panel
//! off when the transparent window is the chosen display.
//!
//! Per cycle (1 s):
//! 1. resolve the running client (`PreferRunning`), locate its
//!    `PnFMods/WoWSPProbe` dir and detect the realm from the install;
//! 2. read `request.json` (the plugin rewrites it whole; a half-write
//!    fails the parse and is retried next cycle) and dedupe it by
//!    `(session, created)` so an answered request is never re-queried;
//! 3. run the SAME batch lookup the overlay page uses (session cache
//!    shared, so overlay-mode battles already fought cost nothing here);
//! 4. write `response.json` with a monotonically increasing `revision`
//!    (the plugin rejects anything ≤ its last applied revision) and the
//!    column labels for the current app locale.
//!
//! On start, a `manual_refresh.flag` stamp pokes a mid-battle plugin
//! (one that already wrote a request while the bridge was off) to
//! re-request within its 10 s window, so flipping the view mode adopts
//! the running battle instead of waiting for the next one.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::watch;

use wowsp_tauri_shared::PlayerStats;

/// Bridge files, all in the plugin's own directory — the same layout
/// `packages/ingame-plugin/src/Main.py` reads and writes.
const REQUEST_FILE: &str = "request.json";
const RESPONSE_FILE: &str = "response.json";
const MANUAL_FLAG: &str = "manual_refresh.flag";

const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How long a failed lookup blocks a retry of the SAME request — rate
/// limiting or network hiccups must not turn the 1 s loop into a request
/// storm; the plugin's own 180 s busy timeout bounds the wait either way.
const FAILURE_BACKOFF: Duration = Duration::from_secs(30);

/// The plugin's request (protocol v1). Only the fields this side consumes
/// are declared; `players` order is preserved into the response rows.
#[derive(Debug, Deserialize)]
struct BridgeRequest {
    session: String,
    #[serde(default)]
    created: f64,
    #[serde(default)]
    players: Vec<BridgeRequestPlayer>,
}

#[derive(Debug, Deserialize)]
struct BridgeRequestPlayer {
    #[serde(default)]
    name: String,
    /// The plugin's roster rows carry the exact WG account id (Main.py's
    /// `account_id`) — retained so the session hub can upgrade an
    /// arena-nickname match to an id match. Older plugins omit it.
    #[serde(default)]
    account_id: Option<i64>,
}

/// One `response.json` row (protocol v1): `wr`/`pr` stay `null` when the
/// lookup found nothing — the plugin passes them through and the unbound
/// template renders its `--` fallback.
fn stats_row(name: &str, stats: Option<&PlayerStats>) -> serde_json::Value {
    let Some(stats) = stats else {
        return row_from(name, None, None, None, false);
    };
    row_from(name, stats.winrate, stats.pr, stats.battles, stats.hidden)
}

/// Pure row builder (the testable core of [`stats_row`]): one decimal on
/// `wr`, matching the overlay page's rendering precision.
fn row_from(
    name: &str,
    wr: Option<f32>,
    pr: Option<i64>,
    battles: Option<i64>,
    hidden: bool,
) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        // One decimal, matching the overlay page's rendering precision.
        // Widened to f64 BEFORE rounding: f32 52.3 carries binary dust
        // (52.29999923706055) that would leak into the JSON verbatim.
        "wr": wr.map(|w| ((w as f64) * 10.0).round() / 10.0),
        "pr": pr,
        "state": if hidden { "hidden" } else if wr.is_none() && pr.is_none() && battles.is_none() { "none" } else { "ok" },
        "bf": { "battles": battles, "ishidden": hidden },
    })
}

/// Column labels for the unbound template's header, in the app locale:
/// zh-CN simplified, zh-TW traditional, everything else compact Latin.
fn labels_for(locale: &str) -> serde_json::Value {
    if locale.starts_with("zh-TW") {
        serde_json::json!({ "wr": "勝率", "pr": "PR", "ally": "隊友", "enemy": "敵方" })
    } else if locale.starts_with("zh") {
        serde_json::json!({ "wr": "胜率", "pr": "PR", "ally": "队友", "enemy": "敌方" })
    } else {
        serde_json::json!({ "wr": "WR", "pr": "PR", "ally": "Allies", "enemy": "Enemies" })
    }
}

/// The plugin directory of the currently running install, when one is
/// running and has a res_mods layout to host it.
fn plugin_dir() -> Option<PathBuf> {
    let resolved =
        super::game_context::resolve_root(super::game_context::RootPreference::PreferRunning)?;
    let res_mods = super::game_context::res_mods_dir(&resolved.root).ok()?;
    Some(res_mods.join(super::ingame_plugin::MOD_DIR))
}

/// Monotonic per-process response revision — the plugin's staleness gate.
static REVISION: AtomicU64 = AtomicU64::new(1);

/// The running worker's shutdown channel. `None` = not running; the mutex
/// makes start/stop races serialize.
static WORKER: Mutex<Option<watch::Sender<bool>>> = Mutex::new(None);

/// Start the bridge worker (idempotent). `locale` picks the response's
/// column labels; a mid-battle plugin is poked to re-request.
#[tauri::command]
pub fn ingame_bridge_start(locale: Option<String>) -> Result<(), String> {
    let mut guard = WORKER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_some() {
        return Ok(());
    }
    // Adopt a battle that may already be running: the plugin re-requests
    // within its 10 s window when it sees a fresh stamp.
    poke_manual_refresh();
    let (tx, rx) = watch::channel(false);
    tauri::async_runtime::spawn(bridge_loop(rx, locale.unwrap_or_default()));
    *guard = Some(tx);
    tracing::info!("ingame bridge started");
    Ok(())
}

/// Stop the bridge worker (idempotent when not running).
#[tauri::command]
pub fn ingame_bridge_stop() -> Result<(), String> {
    let mut guard = WORKER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(tx) = guard.take() {
        let _ = tx.send(true);
        tracing::info!("ingame bridge stopped");
    }
    Ok(())
}

/// Stamp `manual_refresh.flag` (epoch SECONDS — the plugin's freshness
/// window compares against `time.time()`, not milliseconds). Best-effort:
/// no running install or no plugin dir simply skips the poke.
fn poke_manual_refresh() {
    let Some(dir) = plugin_dir() else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(e) = std::fs::write(dir.join(MANUAL_FLAG), stamp.to_string()) {
        tracing::warn!(error = %e, "ingame bridge manual poke failed");
    }
}

/// The worker body. Every failure inside the loop is logged and retried on
/// the next tick — a transient game exit or unreadable file must never
/// kill the bridge for the rest of the session.
async fn bridge_loop(mut shutdown: watch::Receiver<bool>, locale: String) {
    // (session, created) of the last request this worker answered, plus
    // when its lookup last failed (the retry backoff gate).
    let mut answered: Option<(String, f64)> = None;
    let mut last_failure: Option<std::time::Instant> = None;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {},
            _ = shutdown.changed() => break,
        }
        let cycle = bridge_cycle(&locale, answered.as_ref(), last_failure).await;
        answered = cycle.answered;
        last_failure = cycle.last_failure;
    }
}

/// The outcome of one bridge cycle — the loop's evolving dedupe/backoff
/// state, replaced wholesale so the select! skeleton stays a skeleton.
struct CycleState {
    answered: Option<(String, f64)>,
    last_failure: Option<std::time::Instant>,
}

async fn bridge_cycle(
    locale: &str,
    answered: Option<&(String, f64)>,
    last_failure: Option<std::time::Instant>,
) -> CycleState {
    let unchanged = || CycleState {
        answered: answered.cloned(),
        last_failure,
    };
    // Belt-and-suspenders against a stale webui state machine: the worker
    // re-reads the config every cycle (TTL-cached), so a view mode flipped
    // away from "ingame" silences the answers within ~2 s even if the
    // matching stop call never arrives.
    if !super::overlay_config::ingame_view_mode() {
        return unchanged();
    }
    let Some(dir) = plugin_dir() else {
        return unchanged();
    };
    let Ok(raw) = std::fs::read_to_string(dir.join(REQUEST_FILE)) else {
        return unchanged();
    };
    let Ok(request) = serde_json::from_str::<BridgeRequest>(&raw) else {
        // A half-written file (the plugin rewrites whole) — next tick.
        return unchanged();
    };
    if request.session.is_empty() || request.players.is_empty() {
        return unchanged();
    }
    // Feed the session hub's nickname→id map BEFORE the answered/backoff
    // gates: the roster is the freshest identity data in the cycle even
    // when the stats answer is a deduped repeat (see commands/session.rs).
    super::session::note_plugin_roster(
        &request
            .players
            .iter()
            .map(|p| (p.name.clone(), p.account_id))
            .collect::<Vec<_>>(),
    );
    let key = (request.session.clone(), request.created);
    if answered == Some(&key) {
        return unchanged();
    }
    if last_failure.is_some_and(|at| at.elapsed() < FAILURE_BACKOFF) {
        return unchanged();
    }
    // The realm of the RUNNING install decides which WG API answers; an
    // unknown realm is skipped rather than guessed (a wrong-realm lookup
    // answers every player "not found" and would pin that junk into the
    // session cache).
    let realm = {
        let resolved =
            super::game_context::resolve_root(super::game_context::RootPreference::PreferRunning);
        match resolved.and_then(|r| super::game_detect::detect_realm(&r.root)) {
            Some(realm) => realm,
            None => return unchanged(),
        }
    };
    // One filter, two consumers: the lookup's input order and the row zip
    // below MUST be the same list — zipping against the unfiltered players
    // would shift every row after a dropped empty name onto the wrong
    // player.
    let players: Vec<&BridgeRequestPlayer> = request
        .players
        .iter()
        .filter(|p| !p.name.is_empty())
        .collect();
    if players.is_empty() {
        return unchanged();
    }
    let names: Vec<String> = players.iter().map(|p| p.name.clone()).collect();
    let stats = match super::wg_api::lookup_players_stats_batch(names, realm, None).await {
        Ok(stats) => stats,
        Err(e) => {
            tracing::warn!(error = %e, session = %request.session, "ingame bridge lookup failed");
            return CycleState {
                answered: answered.cloned(),
                last_failure: Some(std::time::Instant::now()),
            };
        },
    };
    let rows: Vec<serde_json::Value> = players
        .into_iter()
        .zip(stats)
        .map(|(p, s)| stats_row(&p.name, s.as_ref()))
        .collect();
    let revision = REVISION.fetch_add(1, Ordering::Relaxed);
    let response = serde_json::json!({
        "version": 1,
        "session": request.session,
        "revision": revision,
        "busy": false,
        "rows": rows,
        "labels": labels_for(locale),
    });
    // The plugin's read contract: whole file, trailing newline, < 256 KiB.
    if let Err(e) = std::fs::write(dir.join(RESPONSE_FILE), format!("{response}\n")) {
        tracing::warn!(error = %e, "ingame bridge response write failed");
        // Same backoff as a failed lookup: a pathological filesystem must
        // not turn the 1 s loop into a warn-per-second log firehose.
        return CycleState {
            answered: answered.cloned(),
            last_failure: Some(std::time::Instant::now()),
        };
    }
    tracing::info!(
        session = %request.session,
        revision,
        rows = rows.len(),
        "ingame bridge answered"
    );
    CycleState {
        answered: Some(key),
        last_failure: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Row shapes: found players carry wr/pr/state/bf, unknown ones stay
    /// null-rowed so the template renders its fallback.
    #[test]
    fn rows_shape_found_and_missing() {
        let row = row_from("a", Some(52.34), Some(1450), Some(8213), false);
        assert_eq!(row["wr"], serde_json::json!(52.3));
        assert_eq!(row["pr"], serde_json::json!(1450));
        assert_eq!(row["state"], "ok");
        assert_eq!(row["bf"]["battles"], 8213);
        assert_eq!(row["bf"]["ishidden"], false);
        let missing = row_from("b", None, None, None, false);
        assert_eq!(missing["wr"], serde_json::Value::Null);
        assert_eq!(missing["pr"], serde_json::Value::Null);
        assert_eq!(missing["state"], "none");
    }

    /// Hidden profiles flag `state=hidden` + `ishidden=true` (the plugin's
    /// protocol field) while keeping the same row shape.
    #[test]
    fn rows_shape_hidden() {
        let row = row_from("h", None, None, None, true);
        assert_eq!(row["state"], "hidden");
        assert_eq!(row["bf"]["ishidden"], true);
    }

    /// Labels: zh-CN simplified, zh-TW traditional, everything else Latin.
    #[test]
    fn labels_follow_locale() {
        assert_eq!(labels_for("zh-CN")["wr"], "胜率");
        assert_eq!(labels_for("zh-TW")["ally"], "隊友");
        assert_eq!(labels_for("en")["wr"], "WR");
        assert_eq!(labels_for("")["enemy"], "Enemies");
    }

    /// The request parser tolerates the plugin's exact output shape and
    /// preserves player order (the response rows must line up with it).
    #[test]
    fn request_parses_plugin_shape() {
        let raw = serde_json::json!({
            "version": 1,
            "created": 1690000000.0,
            "session": "1690000000000",
            "manual": false,
            "players": [
                { "name": "alpha", "account_id": 1, "avatar_id": 2, "ship_id": 3 },
                { "name": "beta", "account_id": 4, "avatar_id": 5, "ship_id": 6 }
            ]
        });
        let req: BridgeRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(req.session, "1690000000000");
        assert_eq!(req.players.len(), 2);
        assert_eq!(req.players[0].name, "alpha");
        assert_eq!(req.players[1].name, "beta");
    }
}
