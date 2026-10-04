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
    /// The row's realm straight off the game's own roster record
    /// (Main.py's `realm`, added with the realm-reporting probe change).
    /// Ground truth: a row that carries one resolves on ITS cluster — no
    /// install/log realm inference, no cross-server guessing for it.
    /// Older plugins omit it.
    #[serde(default)]
    realm: Option<String>,
}

/// Normalize a plugin-reported realm for routing. `None` for anything the
/// API surfaces don't know — a garbage value routes nowhere and the row
/// falls back to the detected-home chain instead of poisoning a request
/// URL. Pure — unit-tested.
pub(crate) fn valid_reported_realm(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "eu" | "na" | "asia" | "ru" | "cn" => Some(raw.trim().to_ascii_lowercase()),
        _ => None,
    }
}

/// Pure core of the bridge's realm routing: split the (already
/// name-filtered) request rows into per-cluster lookup groups by their
/// probe-reported realm. Reported rows group per cluster with the cross
/// pass OFF (the realm is ground truth — probing would be guessing);
/// realm-less rows (older probe build / missing field) form one trailing
/// group on the home realm carrying the caller's cross flag. Group order
/// preserves first-sighting order; slots index the filtered player list.
/// Pure — unit-tested.
fn partition_bridge_groups(
    reported: &[Option<String>],
    home: &str,
    cross: bool,
) -> Vec<(String, Vec<usize>, bool)> {
    let mut groups: Vec<(String, Vec<usize>, bool)> = Vec::new();
    let mut default_slots: Vec<usize> = Vec::new();
    for (idx, row_realm) in reported.iter().enumerate() {
        match row_realm {
            Some(row_realm) => match groups.iter_mut().find(|(g, _, _)| g == row_realm) {
                Some((_, slots, _)) => slots.push(idx),
                None => groups.push((row_realm.clone(), vec![idx], false)),
            },
            None => default_slots.push(idx),
        }
    }
    if !default_slots.is_empty() {
        groups.push((home.to_string(), default_slots, cross));
    }
    groups
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
    Some(plugin_dir_under(&res_mods))
}

/// Pure core of [`plugin_dir`]: the mod lives at
/// `res_mods/PnFMods/WoWSPProbe` — the `PnFMods` segment is load-bearing.
/// Losing it silently reads/writes a directory that never exists (shipped
/// as `res_mods/WoWSPProbe` once; the bridge then answered nothing, with
/// no gate to log the miss — hence this helper being the tested seam).
fn plugin_dir_under(res_mods: &std::path::Path) -> PathBuf {
    res_mods.join("PnFMods").join(super::ingame_plugin::MOD_DIR)
}

/// The realm of a game root, the same chain the process watcher feeds the
/// webui: the launch log first, then the detected-install scan (a Steam
/// client may pick a realm long after its log line scrolled away).
fn detect_bridge_realm(root: &std::path::Path) -> Option<String> {
    super::game_detect::detect_realm(root).or_else(|| {
        let root_str = root.to_string_lossy();
        super::game_context::cached_scan()
            .into_iter()
            .find(|install| super::game_context::same_folder(&install.path, &root_str))
            .and_then(|install| install.realm)
    })
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
    // Realm resolution, in trust order:
    //   1. the LOCAL player's row realm — the probe reports each row's
    //      realm straight off the game's roster records, and the local
    //      player's own cluster IS the home cluster (found via the live
    //      arena file's relation==0 row),
    //   2. the running install's detected realm (launch log, then the
    //      install-kind fallback).
    // An unknown realm is skipped rather than guessed (a wrong-realm
    // lookup answers every player "not found" and would pin that junk
    // into the session cache).
    let root =
        super::game_context::resolve_root(super::game_context::RootPreference::PreferRunning);
    let detected_realm = root.as_ref().and_then(|r| detect_bridge_realm(&r.root));
    let reported: Vec<Option<String>> = players
        .iter()
        .map(|p| p.realm.as_deref().and_then(valid_reported_realm))
        .collect();
    let verified_home = if super::arena_info::arena_seen_within(120) {
        // Freshness gate: a crash-leftover tempArenaInfo.json gets re-read
        // after relaunch (see note_playing_from_arena's rationale), and a
        // STALE local player matching a different-cluster namesake row
        // here would latch a foreign cluster as home for every realm-less
        // row — exactly the wrong-realm junk-pinning this chain refuses.
        // Only an arena the watcher/poller actually saw recently may pin
        // the home cluster; otherwise fall through to the detected realm.
        super::arena_info::read_arena_snapshot().and_then(|(arena, _)| {
            super::session::local_player_of(&arena.vehicles)
                .and_then(|local| players.iter().position(|p| p.name == local))
                .and_then(|idx| reported[idx].clone())
        })
    } else {
        None
    };
    let Some(realm) = verified_home.or(detected_realm) else {
        return unchanged();
    };
    // Cross-server Clan Battles: the roster may carry foreign-realm
    // opponents the home cluster cannot resolve by name. The plugin
    // request carries no battle type, so the live arena file answers it
    // (the battle is running while the bridge serves). Same predicate as
    // the webui surfaces (modeKey's clan bucket): matchGroup CONTAINING
    // "clan", not just the exact value, so the in-game panel and the app
    // windows never disagree on a variant value.
    let cross_realm = root
        .as_ref()
        .and_then(|r| super::arena_info::current_match_group(&r.root))
        .map(|mg| mg.to_ascii_lowercase().contains("clan"))
        .unwrap_or(false);
    // Rows the probe pinned to a cluster resolve THERE — exact, no
    // cross-server pass needed for them; the rest (older probe build /
    // missing field) ride the home realm + the cross pass. One
    // lookup_roster call per cluster keeps each group's cache and request
    // budget on its own realm.
    let groups = partition_bridge_groups(&reported, &realm, cross_realm);
    let algo = super::wg_api::PrAlgo::from_param(None);
    let mut answers: Vec<Option<PlayerStats>> = vec![None; players.len()];
    let mut failure: Option<String> = None;
    for (group_realm, slots, group_cross) in groups {
        let g_names: Vec<String> = slots.iter().map(|&i| players[i].name.clone()).collect();
        let g_ids: Vec<Option<i64>> = slots.iter().map(|&i| players[i].account_id).collect();
        match super::wg_api::lookup_roster(g_names, g_ids, group_realm.clone(), group_cross, algo)
            .await
        {
            Ok(rows) => {
                for (&slot, row) in slots.iter().zip(rows) {
                    answers[slot] = row;
                }
            },
            Err(e) => {
                // The HOME cluster keeps the historical fail-the-request
                // semantics (the backoff below retries — that cluster
                // carries most of the roster). A FOREIGN cluster's outage
                // degrades exactly like the cross-realm probe pass it
                // replaces: those rows render "no data", everyone else
                // keeps their stats — a far-away API being down must not
                // blank the whole in-game panel.
                if group_realm == realm {
                    failure = Some(e);
                    break;
                }
                tracing::warn!(
                    error = %e,
                    realm = %group_realm,
                    rows = slots.len(),
                    session = %request.session,
                    "ingame bridge foreign-realm group degraded"
                );
            },
        }
    }
    let stats = match failure {
        None => answers,
        Some(e) => {
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

    /// The realm-reporting probe change adds a per-row realm — the parser
    /// must accept it AND stay tolerant of the older shape (absent field).
    #[test]
    fn request_parses_reported_realms() {
        let raw = serde_json::json!({
            "version": 1,
            "session": "1690000000000",
            "players": [
                { "name": "alpha", "account_id": 1, "realm": "EU" },
                { "name": "beta", "account_id": 4 }
            ]
        });
        let req: BridgeRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(req.players[0].realm.as_deref(), Some("EU"));
        assert_eq!(req.players[1].realm, None);
        // Routing normalization: known clusters lowercase through, garbage
        // (a value no API surface would answer) routes nowhere.
        assert_eq!(valid_reported_realm(" EU ").as_deref(), Some("eu"));
        assert_eq!(valid_reported_realm("asia").as_deref(), Some("asia"));
        assert_eq!(valid_reported_realm("ru").as_deref(), Some("ru"));
        assert_eq!(valid_reported_realm("cn").as_deref(), Some("cn"));
        assert_eq!(valid_reported_realm(""), None);
        assert_eq!(valid_reported_realm("mars"), None);
    }

    /// Realm routing: reported rows group per cluster (cross off — the
    /// realm is known), realm-less rows trail on the home realm carrying
    /// the cross flag; a fully realm-less roster reduces to the
    /// historical single home-realm call.
    #[test]
    fn partition_groups_routes_reported_realms_and_trails_the_rest() {
        let reported = vec![
            Some("eu".to_string()),
            None,
            Some("asia".to_string()),
            Some("eu".to_string()),
            None,
        ];
        let groups = partition_bridge_groups(&reported, "eu", true);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0], ("eu".to_string(), vec![0, 3], false));
        assert_eq!(groups[1], ("asia".to_string(), vec![2], false));
        assert_eq!(groups[2], ("eu".to_string(), vec![1, 4], true));

        // No probe realms at all → exactly the old single call's shape.
        let plain = partition_bridge_groups(&[None, None], "na", false);
        assert_eq!(plain, vec![("na".to_string(), vec![0, 1], false)]);

        // A foreign-only roster (cross-server CW, every row reported) has
        // no default group to carry the cross flag — nothing to probe.
        let foreign = partition_bridge_groups(
            &[Some("na".to_string()), Some("na".to_string())],
            "eu",
            true,
        );
        assert_eq!(foreign, vec![("na".to_string(), vec![0, 1], false)]);
    }

    /// Regression (shipped once wrong): the mod lives UNDER `PnFMods/` —
    /// a flat `res_mods/WoWSPProbe` path silently matches no file and the
    /// whole bridge idles without a single log line.
    #[test]
    fn plugin_dir_includes_pnfmods_segment() {
        let dir = plugin_dir_under(std::path::Path::new("Z:/game/bin/1/res_mods"));
        let expected = std::path::Path::new("Z:/game/bin/1/res_mods")
            .join("PnFMods")
            .join(super::super::ingame_plugin::MOD_DIR);
        assert_eq!(dir, expected);
        assert!(
            dir.components().any(|c| c.as_os_str() == "PnFMods"),
            "path must carry the PnFMods segment: {dir:?}"
        );
    }
}
