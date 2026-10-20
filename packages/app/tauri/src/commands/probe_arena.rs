//! Probe-driven battle detection — the arena pipeline's stand-in for
//! clients that never write `tempArenaInfo.json`.
//!
//! The whole live-battle pipeline (the /live roster panel, the overlay
//! window's arena-info event, the Tab watcher's `arena_seen_within` gate,
//! the session hub's player attribution) keys on the game writing
//! `tempArenaInfo.json` when a battle loads. The 2026-10-20 field report
//! (Steam build 13357625, realm asia): six battles in one day — replays
//! written, the in-game probe's telemetry stream alive with a stabilized
//! roster every battle — while the `replays/` arena file's mtime never
//! moved off its months-old leftover. That build class simply does not
//! write the file, so every file-watching surface (this app's, and the
//! legacy radars' that watch the same path) starves while the client is
//! perfectly detectable through the ONE channel that lives inside the
//! game: the WoWSPProbe mod.
//!
//! This module turns the probe's telemetry frames into that missing
//! battle signal. The telemetry poller
//! (`ingame_plugin::spawn_telemetry_poller`) hands every FRESH frame here
//! ([`note_telemetry`]); a frame with a non-empty `players` map under a
//! NEW `battle` session id marks a battle, the roster is synthesized from
//! the probe's own `roster_raw.json` (the same projection the Lesta
//! vehicle-less arena shape already consumes — see `probe_roster`) and
//! the battle is recorded in the registry with a ONE-SHOT ownership
//! verdict: the FILE pipeline owns the battle when the dir's freshest
//! arena file postdates the battle's start window (a client that writes
//! the file wrote THIS battle's at load, minutes of skew from the
//! probe's stabilization stamp — see
//! [`arena_info::arena_file_owns_battle`]); only a file-less battle is
//! handed back for serving (`arena_info::serve_probe_battle` records it
//! through the file path's own bookkeeping and emits the same
//! `wowsp://arena-info` event). The verdict is sticky per battle, so a
//! healthy client never sees the probe's copy over its file's (a
//! duplicate serve would re-key the page's new-battle transitions on a
//! DIFFERENT `dateTime` and degrade the mode/map fields), and the read
//! fallback stands down for file-owned battles entirely — including the
//! 360 CN shape, where the file is deleted at battle end and only the
//! recorded verdict remembers the file delivered that battle.
//!
//! Liveness mirrors the file's delete-on-end semantics through the
//! probe's own writes: the quit-clear (a `players` map PRESENT and
//! empty) ends the battle, a crashed client stops rewriting the file
//! (→ stale after [`LIVE_GRACE_MS`], the same cap the telemetry poller
//! enforces). The read fallback ([`live_battle_for_dir`]) answers only
//! while the battle is live, so the /live page's absent-read branch
//! keeps its honest waiting/ended states exactly as it does around a
//! real file.

use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use wowsp_tauri_shared::ArenaInfo;

/// How long after the last fresh telemetry frame a recorded battle stays
/// live for the read fallback — the poller's own `TELEMETRY_STALE_MS`
/// cap: a client that stopped writing frames is out of the battle (quit,
/// crash), exactly like a deleted arena file.
const LIVE_GRACE_MS: i64 = 30_000;

/// The registry's answer for a battle the poller just synthesized:
/// either the file pipeline owns it (nothing to serve, ever, for this
/// battle) or the synthesized roster is the app's only battle source and
/// the caller must serve it through `arena_info`.
pub(crate) enum NewProbeBattle {
    /// The dir's freshest arena file postdates the battle's start window
    /// — a file-writing client is mid-battle with its own file; the
    /// probe's copy must stay out of the way (see the module docs).
    FileOwned,
    /// No usable arena file behind this battle — the registry holds the
    /// synthesized roster; the caller CLAIMS it
    /// (`try_claim_serve`) and serves through `arena_info`.
    Serve,
}

/// One install's current probe battle. Keyed by the install path key (the
/// same normalization the served-stamp map uses), so the exe-derived root
/// the poller walks and the install-scan spelling an arena dir strips
/// down to are the same entry.
struct ProbeBattle {
    /// The probe's session stamp (`battle` in the telemetry frame, epoch
    /// milliseconds as a string) — the battle's identity for new/old
    /// transitions, and the stamp the synthesized roster is dated with.
    battle_id: String,
    /// The battle's start in unix SECONDS (`battle_id` / 1000) — the
    /// arena stamp the read/serve paths record against
    /// `LAST_ARENA_MTIME`, monotone with file mtimes so a real arena file
    /// from a later battle still wins the forward-only guards.
    stamp_unix: i64,
    /// The synthesized roster snapshot. Stable for the battle: built once
    /// on the first frame (the probe's session only exists once its
    /// roster stabilized, so late loaders are the exception, not the
    /// rule) — and the store keys the page's "new battle" transitions on
    /// `dateTime`, so a per-poll rebuild would churn the battle realm
    /// latch for nothing.
    info: ArenaInfo,
    /// The freshest frame's `t` (epoch ms) — the liveness clock.
    last_seen_ms: i64,
    /// Set by the quit-clear (a PRESENT, empty `players` map) and by
    /// liveness expiry at read time. Sticky: the probe never reuses a
    /// session stamp after its quit (quit clears the session before the
    /// clear-frame write), so an ended battle only ever comes back as a
    /// NEW battle id — a same-id frame after the clear is a probe build
    /// violating that invariant, not a resurrection.
    ended: bool,
    /// The one-shot ownership verdict (see [`NewProbeBattle::FileOwned`]).
    /// Sticky for the battle: the file's write happens at battle load,
    /// before the probe's first telemetry frame, so the first frame's
    /// look is conclusive; a later deletion (the 360 CN battle-end shape)
    /// must not flip a file-owned battle into a probe-served one.
    file_owned: bool,
    /// Whether `arena_info::serve_probe_battle` already delivered this
    /// battle — the read fallback re-SERVES nothing (the emit must fire
    /// once per battle; the pages' own polls keep their copies fresh off
    /// the returned value).
    served: bool,
}

static BATTLES: LazyLock<std::sync::Mutex<std::collections::HashMap<String, ProbeBattle>>> =
    LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn lock_battles() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, ProbeBattle>>
{
    BATTLES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Fold one FRESH telemetry frame into the registry. Returns the verdict
/// when this frame is a battle's first sighting — the caller serves the
/// `Serve` arm through `arena_info` (the serve itself needs the AppHandle
/// and stays out of this registry core so it remains unit-testable). A
/// quit-clear frame (the `players` map PRESENT and empty) ends the
/// recorded battle; a frame whose `players` map is ABSENT (the probe's
/// fail-safe payload — a mid-battle exception that skipped the roster
/// loop) touches nothing: it is an outage frame, not a battle-end signal,
/// and treating it as one would flicker the /live page's ended flag
/// mid-battle.
pub(crate) fn note_telemetry(
    root: &Path,
    frame: &serde_json::Value,
    now_ms: i64,
) -> Option<NewProbeBattle> {
    let key = super::game_detect::install_path_key(&root.to_string_lossy());
    let battle_id = frame.get("battle").and_then(|v| v.as_str()).unwrap_or("");
    let players = frame.get("players").and_then(|v| v.as_object());
    let frame_t = frame
        .get("t")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(now_ms);
    let mut battles = lock_battles();
    // Any frame under the CURRENT battle id refreshes the battle's
    // liveness clock — the write itself is proof the client and probe
    // are alive. This includes the probe's fail-safe shape (battle id,
    // NO players map — a mid-battle exception skipped the roster loop):
    // that frame must neither end the battle (an outage, not a quit) nor
    // let it expire while the stream keeps flowing.
    if let Some(battle) = battles.get_mut(&key) {
        if !battle_id.is_empty() && battle.battle_id == battle_id {
            battle.last_seen_ms = frame_t;
            return None;
        }
    }
    let live_battle = !battle_id.is_empty() && players.is_some_and(|m| !m.is_empty());
    if !live_battle {
        if players.is_some() {
            // The quit-clear: `players` PRESENT and empty (or a
            // battle-less payload) — the battle is over.
            if let Some(battle) = battles.get_mut(&key) {
                battle.ended = true;
            }
        }
        return None;
    }
    // A NEW battle session: the stamp is the probe's own session ms.
    let stamp_ms: i64 = match battle_id.parse() {
        Ok(v) if v > 0 => v,
        _ => {
            // A non-numeric session id (a future probe build's scheme):
            // nothing can be dated or freshness-gated off it — record
            // nothing rather than mis-stamping the battle. Debug level:
            // this evaluates on EVERY frame of such a battle.
            tracing::debug!(root = %root.display(), battle_id, "probe battle id is not an epoch stamp — probe-arena synthesis skipped");
            return None;
        },
    };
    let stamp_unix = stamp_ms / 1000;
    let self_name = frame
        .pointer("/self/name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let Some(vehicles) =
        super::probe_roster::synthesize_from_probe(root, self_name.as_deref(), stamp_unix)
    else {
        // No usable roster behind this battle YET (probe not installed, or
        // a records-dead build class whose roster_raw never refreshed —
        // the freshness gate in synthesize_from_probe refuses a previous
        // battle's file). Nothing is recorded, so every later frame of the
        // same battle retries — a roster arriving late still synthesizes.
        // Debug level for that same reason (one line per 1–2 s frame, not
        // a WARN per battle: the probe-health layer's BattleWithout-
        // Telemetry / RosterFallback lines are the battle-level verdicts).
        tracing::debug!(
            root = %root.display(),
            battle_id,
            "probe battle without a usable roster_raw — probe-arena synthesis skipped"
        );
        return None;
    };
    let info = synthesize_arena_info(vehicles, self_name.as_deref(), stamp_unix, battle_id);
    // The one-shot ownership verdict. The probe's stamp lands at roster
    // stabilization, a full map-load AFTER a writing client dropped its
    // file — skew-scale windows cannot bridge that gap, so the verdict is
    // "did this dir see ANY file battle inside the load window around
    // this battle's start", sticky for the battle's lifetime.
    let replays_dir = super::game_context::replays_dir(root);
    let file_owned = super::arena_info::arena_file_owns_battle(&replays_dir, stamp_unix);
    battles.insert(
        key,
        ProbeBattle {
            battle_id: battle_id.to_string(),
            stamp_unix,
            info: info.clone(),
            last_seen_ms: frame_t,
            ended: false,
            file_owned,
            served: false,
        },
    );
    Some(if file_owned {
        NewProbeBattle::FileOwned
    } else {
        NewProbeBattle::Serve
    })
}

/// Build the [`ArenaInfo`] the pipeline consumes off the probe's roster.
/// `date_time` is formatted in the arena file's own local-time layout
/// (`DD.MM.YYYY HH:MM:SS` — `useBattleClock` parses exactly that) from the
/// battle stamp, so it is stable for the whole battle and unique per
/// battle: the frontend's new-battle transitions and the battle-realm
/// latch key on that stability. `match_group`/map fields stay `None` —
/// the probe does not bridge them, and every consumer already tolerates
/// their absence (the mode pill falls back through its layered keys).
fn synthesize_arena_info(
    vehicles: Vec<wowsp_tauri_shared::VehicleEntry>,
    self_name: Option<&str>,
    stamp_unix: i64,
    battle_id: &str,
) -> ArenaInfo {
    // The same mode-classifier counts the Lesta synthesis branch of
    // `read_arena_file` computes — the frontend's bot-fold labels and
    // operation gates key on them.
    let bot_count = vehicles
        .iter()
        .filter(|v| super::replay::is_bot_nickname(&v.name))
        .count() as u32;
    let scripted_unit_count = vehicles
        .iter()
        .filter(|v| super::replay::is_scripted_unit_nickname(&v.name))
        .count() as u32;
    let date_time = chrono::DateTime::<chrono::Local>::from(
        SystemTime::UNIX_EPOCH + Duration::from_secs(stamp_unix.max(0) as u64),
    )
    .format("%d.%m.%Y %H:%M:%S")
    .to_string();
    let raw = serde_json::json!({
        // The arena file's own field name for the local player — the same
        // anchor the Lesta synthesis reads off the real file.
        "playerName": self_name,
        "source": "wowsp-probe",
        "battle": battle_id,
    });
    ArenaInfo {
        match_group: None,
        date_time: Some(date_time),
        map_name: None,
        scenario: None,
        event_type: None,
        bot_count,
        scripted_unit_count,
        vehicles,
        raw,
    }
}

/// The live probe battle behind an arena dir, as the read fallback needs
/// it: the roster snapshot and the stamp. FILE-OWNED battles never appear
/// here (both lookups filter them — see the module docs).
pub(crate) struct LiveProbeBattle {
    pub(crate) info: ArenaInfo,
    pub(crate) stamp_unix: i64,
}

/// The read-side fallback lookup: the LIVE probe battle behind an arena
/// dir, if one exists. `dir` is the dir the caller resolved/reads for the
/// arena file (a `<root>/replays` shape); the registry entry must belong
/// to the same install, so an env-pinned or another install's dir never
/// borrows a foreign battle. Ended battles and silent probes (no fresh
/// frame within [`LIVE_GRACE_MS`]) answer `None` — the caller's
/// absent-read branch then flags the battle ended/keeps waiting exactly
/// as it does around a deleted arena file. A `file_owned` battle is the
/// caller's None (the file pipeline owns it — see the module docs).
pub(crate) fn live_battle_for_dir(dir: &Path, now_ms: i64) -> Option<LiveProbeBattle> {
    let root = super::session::arena_game_root(dir)?;
    let key = super::game_detect::install_path_key(&root);
    let battles = lock_battles();
    let battle = battles.get(&key)?;
    if battle.ended || battle.file_owned || now_ms - battle.last_seen_ms > LIVE_GRACE_MS {
        return None;
    }
    Some(LiveProbeBattle {
        info: battle.info.clone(),
        stamp_unix: battle.stamp_unix,
    })
}

/// Atomically claim a live battle's ONE serve. The serve must fire
/// exactly once per battle, but two threads reach for it independently —
/// the telemetry poller's new-battle handoff and any read path's first
/// fallback poll — so the check-and-set happens under the registry
/// mutex: exactly one caller gets the snapshot (and the duty); the other
/// gets `None` and simply returns what `live_battle_for_dir` already
/// serves. A file-owned or ended battle is never claimable.
pub(crate) fn try_claim_serve(dir: &Path, now_ms: i64) -> Option<LiveProbeBattle> {
    let root = super::session::arena_game_root(dir)?;
    let key = super::game_detect::install_path_key(&root);
    let mut battles = lock_battles();
    let battle = battles.get_mut(&key)?;
    if battle.ended
        || battle.file_owned
        || battle.served
        || now_ms - battle.last_seen_ms > LIVE_GRACE_MS
    {
        return None;
    }
    battle.served = true;
    Some(LiveProbeBattle {
        info: battle.info.clone(),
        stamp_unix: battle.stamp_unix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal install whose `res_mods_dir` resolves: one numeric
    /// `bin/<build>` (the plain-newest fallback of `latest_bin_dir` needs
    /// no `idx/`), carrying the probe's roster file.
    fn fixture_root(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("wowsp_probe_arena_{tag}"));
        let _ = std::fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let probe = game
            .join("bin")
            .join("100")
            .join("res_mods")
            .join("PnFMods/WoWSPProbe");
        std::fs::create_dir_all(&probe).unwrap();
        game
    }

    fn write_roster(root: &Path, players: serde_json::Value) {
        let dir = super::super::game_context::res_mods_dir(root).unwrap();
        std::fs::write(
            dir.join("PnFMods/WoWSPProbe/roster_raw.json"),
            serde_json::json!({ "t": 1, "players": players }).to_string(),
        )
        .unwrap();
    }

    fn frame(battle: &str, t_ms: i64, players: usize) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = (0..players)
            .map(|i| (format!("p{i}"), serde_json::json!(true)))
            .collect();
        serde_json::json!({
            "t": t_ms, "battle": battle, "players": map,
            "self": { "name": "langyo", "realm": "asia" },
        })
    }

    // Every fixture roots its registry key in a UNIQUE temp install, so
    // the process-global map needs no cross-test clearing (cargo runs
    // test functions on parallel threads — a shared clear() would race).

    /// The happy path of the report's shape: telemetry frames flow, the
    /// first frame of a battle synthesizes the roster off roster_raw, and
    /// the read fallback serves the dir until the battle ends.
    #[test]
    fn synthesizes_and_serves_a_probe_battle() {
        let root = fixture_root("serve");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9, "isBot": false },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9, "isBot": false },
            }),
        );
        // First frame of battle A: new battle, roster synthesized. No
        // arena file anywhere near it — the Serve verdict.
        let served = note_telemetry(
            &root,
            &frame("1792496000000", 1792496001000, 4),
            1792496001000,
        );
        assert!(
            matches!(served, Some(NewProbeBattle::Serve)),
            "no arena file exists — must be a Serve verdict"
        );
        let live = live_battle_for_dir(&root.join("replays"), 1792496001000)
            .expect("the synthesized battle is live in the registry");
        let info = live.info;
        assert_eq!(live.stamp_unix, 1_792_496_000);
        assert_eq!(info.vehicles.len(), 2);
        assert_eq!(
            info.vehicles
                .iter()
                .find(|v| v.name == "langyo")
                .unwrap()
                .relation,
            0,
            "the telemetry self anchor splits the sides"
        );
        let date_time = info.date_time.as_deref().unwrap();
        assert!(
            date_time.len() == 19 && date_time.contains('.'),
            "the arena file's local-time layout: {date_time}"
        );
        // The read fallback serves the install's replays dir while live.
        let replays = root.join("replays");
        let read = live_battle_for_dir(&replays, 1792496001000).expect("live battle serves");
        assert_eq!(
            read.info.date_time, info.date_time,
            "stable across the battle"
        );
        // Same-battle frames neither re-synthesize nor end it.
        assert!(
            note_telemetry(
                &root,
                &frame("1792496000000", 1792496010000, 4),
                1792496010000
            )
            .is_none()
        );
        assert!(live_battle_for_dir(&replays, 1792496010000).is_some());
        // The serve claim is exactly-once: the first caller wins it, the
        // second (a racing read path) gets None and keeps its snapshot.
        let claim = try_claim_serve(&replays, 1792496020000).expect("the first claim wins");
        assert_eq!(claim.info.date_time, info.date_time);
        assert!(
            try_claim_serve(&replays, 1792496020001).is_none(),
            "the serve claim is once per battle"
        );
        assert!(live_battle_for_dir(&replays, 1792496020001).is_some());
        // The quit-clear ends it; the dir reads as absent again.
        assert!(note_telemetry(&root, &frame("", 1792496900000, 0), 1792496900000).is_none());
        assert!(live_battle_for_dir(&replays, 1792496900000).is_none());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    /// A fresh arena file in the dir claims the battle — the verdict is
    /// FileOwned, and the read fallback exposes the flag so the file
    /// pipeline keeps the battle (the duplicate-serve hazard: the probe's
    /// stamp trails the file's write by the whole map load).
    #[test]
    fn fresh_arena_file_claims_the_battle() {
        let root = fixture_root("fileowned");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9 },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9 },
            }),
        );
        // The file-writing client's shape: the arena file dropped at
        // battle load, the probe's first frame a minute later.
        let replays = root.join("replays");
        std::fs::create_dir_all(&replays).unwrap();
        std::fs::write(replays.join("tempArenaInfo.json"), b"{}").unwrap();
        let load = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_495_940);
        let file = std::fs::File::options()
            .write(true)
            .open(replays.join("tempArenaInfo.json"))
            .unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(load))
            .unwrap();
        let verdict = note_telemetry(
            &root,
            &frame("1792496000000", 1792496000000, 4),
            1792496000000,
        )
        .expect("the battle synthesizes a verdict");
        assert!(
            matches!(verdict, NewProbeBattle::FileOwned),
            "a file battle 60s before the probe stamp owns the battle"
        );
        assert!(
            live_battle_for_dir(&replays, 1792496000000).is_none(),
            "the read fallback stands down for a file-owned battle"
        );
        assert!(
            try_claim_serve(&replays, 1792496000000).is_none(),
            "a file-owned battle is never claimable"
        );
        // ...and keeps standing down after the file is deleted (the 360
        // CN battle-end shape): the verdict is sticky. The refresh frame
        // keeps the battle inside its liveness grace.
        note_telemetry(
            &root,
            &frame("1792496000000", 1792496020000, 4),
            1792496020000,
        );
        std::fs::remove_file(replays.join("tempArenaInfo.json")).unwrap();
        assert!(
            live_battle_for_dir(&replays, 1792496020000).is_none(),
            "the verdict survives the file's deletion — still stood down"
        );
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    /// The probe's fail-safe frame (a mid-battle exception) carries the
    /// battle id but NO players map — an outage frame, not a battle end:
    /// the battle must stay live.
    #[test]
    fn fail_safe_frame_without_players_does_not_end_the_battle() {
        let root = fixture_root("failsafe");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9 },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9 },
            }),
        );
        note_telemetry(
            &root,
            &frame("1792496000000", 1792496000000, 4),
            1792496000000,
        );
        let outage = serde_json::json!({
            "t": 1792496050000i64, "battle": "1792496000000",
            "sortKeys": {}, "rosterOrder": [], "shipNames": {},
            "self": { "name": "", "realm": "" }, "identity": {},
        });
        assert!(note_telemetry(&root, &outage, 1792496050000).is_none());
        assert!(
            live_battle_for_dir(&root.join("replays"), 1792496050000).is_some(),
            "an outage frame must not end a live battle"
        );
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    /// A silent probe (client gone) expires out of the read fallback even
    /// without a quit-clear frame.
    #[test]
    fn silent_probe_expires_from_the_read_fallback() {
        let root = fixture_root("expire");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9 },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9 },
            }),
        );
        note_telemetry(
            &root,
            &frame("1792496000000", 1792496000000, 4),
            1792496000000,
        );
        let replays = root.join("replays");
        assert!(live_battle_for_dir(&replays, 1792496000000 + LIVE_GRACE_MS).is_some());
        assert!(
            live_battle_for_dir(&replays, 1792496000000 + LIVE_GRACE_MS + 1).is_none(),
            "past the grace the battle is over"
        );
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    /// The report's stale-file hazard in reverse: a battle whose
    /// roster_raw predates it (the records-dead build class never
    /// refreshes the file) must NOT borrow the previous battle's roster.
    #[test]
    fn refuses_a_stale_roster_file() {
        let root = fixture_root("stale");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9 },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9 },
            }),
        );
        // Pin the roster file minutes into the past.
        let dir = super::super::game_context::res_mods_dir(&root).unwrap();
        let roster = dir.join("PnFMods/WoWSPProbe/roster_raw.json");
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_490_000);
        let file = std::fs::File::options().write(true).open(&roster).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert!(
            note_telemetry(
                &root,
                &frame("1792496000000", 1792496000000, 4),
                1792496000000
            )
            .is_none(),
            "a roster from a previous battle is refused"
        );
        assert!(live_battle_for_dir(&root.join("replays"), 1792496000000).is_none());
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    /// The fallback is per-install: another root's dir (a differently
    /// keyed install, or a dir that is not a `<root>/replays` shape)
    /// never borrows the battle.
    #[test]
    fn fallback_is_scoped_to_the_battle_install() {
        let root = fixture_root("scope");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9 },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9 },
            }),
        );
        note_telemetry(
            &root,
            &frame("1792496000000", 1792496000000, 4),
            1792496000000,
        );
        let other = fixture_root("scope_other");
        assert!(
            live_battle_for_dir(&other.join("replays"), 1792496000000).is_none(),
            "another install's dir does not serve this battle"
        );
        assert!(
            live_battle_for_dir(&root.join("bin").join("100"), 1792496000000).is_none(),
            "a dir that is not a <root>/replays shape resolves no root"
        );
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
        std::fs::remove_dir_all(other.parent().unwrap()).ok();
    }

    /// The next battle in the same client session synthesizes fresh (new
    /// battle id), with its own date_time.
    #[test]
    fn next_battle_re_synthesizes() {
        let root = fixture_root("next");
        write_roster(
            &root,
            serde_json::json!({
                "1": { "name": "langyo", "accountDBID": 1, "teamId": 1, "shipParamsId": 9 },
                "2": { "name": "Foe", "accountDBID": 2, "teamId": 2, "shipParamsId": 9 },
            }),
        );
        assert!(matches!(
            note_telemetry(
                &root,
                &frame("1792496000000", 1792496000000, 4),
                1792496000000
            ),
            Some(NewProbeBattle::Serve)
        ));
        let first = live_battle_for_dir(&root.join("replays"), 1792496000000)
            .expect("first battle synthesizes")
            .info;
        // Battle ends, second battle starts an hour later.
        note_telemetry(&root, &frame("", 1792497000000, 0), 1792497000000);
        assert!(matches!(
            note_telemetry(
                &root,
                &frame("1792499600000", 1792499600000, 4),
                1792499600000
            ),
            Some(NewProbeBattle::Serve)
        ));
        let second = live_battle_for_dir(&root.join("replays"), 1792499600000)
            .expect("the next battle synthesizes")
            .info;
        assert_ne!(first.date_time, second.date_time);
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }
}
