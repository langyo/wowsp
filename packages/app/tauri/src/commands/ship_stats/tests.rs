use anyhow::anyhow;

use std::fs;

use super::appdata::{appdata_dir_path, read_appdata_json, write_appdata_json};
use super::history::*;
use super::lookup::*;
use super::raw::*;
use super::scanner::*;
use super::stream::*;
use super::trends::ExpectedValues;
use super::wg_api::PrAlgo;
use wowsp_tauri_shared::{PlayerShipStats, ShipStatsHistoryPoint, StatsSnapshot};

struct HistoryFixture(std::path::PathBuf);

impl HistoryFixture {
    fn new() -> Self {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let dir = std::env::temp_dir().join(format!("wowsp-history-{}", hex::encode(nonce)));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, file: &str, bytes: &[u8]) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
}

impl Drop for HistoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn history_snapshot(timestamp: i64) -> StatsSnapshot {
    StatsSnapshot {
        timestamp,
        game_version: "test-version".into(),
        battles: timestamp,
        wins: timestamp / 2,
        winrate: 50.0,
        avg_damage: 10_000.0,
        pr: None,
    }
}

#[test]
fn persistence_snapshot_preserves_unparseable_history() {
    let fixture = HistoryFixture::new();
    let file = "snapshots/test_1.json";
    for original in [b"[{broken history".as_slice(), &[0xff]] {
        fixture.write(file, original);
        let result = append_snapshot_in(&fixture.0, "test", 1, history_snapshot(1));
        assert_eq!(fs::read(fixture.0.join(file)).unwrap(), original);
        assert!(result.is_err());
    }
}

#[test]
fn persistence_ship_history_preserves_unparseable_history() {
    let fixture = HistoryFixture::new();
    let file = "ship-history/test_1.json";
    for original in [b"[{broken history".as_slice(), &[0xff]] {
        fixture.write(file, original);
        let result = append_ship_history_in(&fixture.0, "test", 1, &[mk_stats(1, 100)], 1);
        assert_eq!(fs::read(fixture.0.join(file)).unwrap(), original);
        assert!(result.is_err());
    }
}

#[cfg(windows)]
#[test]
fn persistence_read_failure_cannot_replace_existing_history() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = HistoryFixture::new();
    let file = "snapshots/test_1.json";
    let original = serde_json::to_vec(&vec![history_snapshot(1)]).unwrap();
    fixture.write(file, &original);
    // Deny reads but allow replace/delete: a failed read is not evidence
    // that no history exists, even if the subsequent write can succeed.
    let lock = fs::OpenOptions::new()
        .write(true)
        .share_mode(0x2 | 0x4)
        .open(fixture.0.join(file))
        .unwrap();
    let result = append_snapshot_in(&fixture.0, "test", 1, history_snapshot(2));
    drop(lock);
    assert_eq!(fs::read(fixture.0.join(file)).unwrap(), original);
    assert!(result.is_err());
    append_snapshot_in(&fixture.0, "test", 1, history_snapshot(2)).unwrap();
    let history: Vec<StatsSnapshot> =
        serde_json::from_slice(&fs::read(fixture.0.join(file)).unwrap()).unwrap();
    assert_eq!(history.len(), 2, "a later retry retains the old point");
}

#[cfg(windows)]
#[test]
fn persistence_snapshot_reports_failed_publish() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = HistoryFixture::new();
    let file = "snapshots/test_1.json";
    let original = serde_json::to_vec(&vec![history_snapshot(1)]).unwrap();
    fixture.write(file, &original);
    // Read succeeds, but the destination cannot be replaced while open.
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1)
        .open(fixture.0.join(file))
        .unwrap();
    let result = append_snapshot_in(&fixture.0, "test", 1, history_snapshot(2));
    drop(lock);
    assert_eq!(fs::read(fixture.0.join(file)).unwrap(), original);
    assert!(
        result.is_err(),
        "the command must not report an unsaved snapshot"
    );
}

#[test]
fn persistence_concurrent_snapshots_retain_both_updates() {
    use std::sync::mpsc;
    use std::time::Duration;
    let fixture = HistoryFixture::new();
    let file = "snapshots/test_1.json";
    append_snapshot_in(&fixture.0, "test", 1, history_snapshot(0)).unwrap();
    let (loaded, first_loaded) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let first_dir = fixture.0.clone();
    let first = std::thread::spawn(move || {
        update_history_in(&first_dir, file, |history: &mut Vec<StatsSnapshot>| {
            loaded.send(()).unwrap();
            wait.recv().unwrap();
            history.push(history_snapshot(1));
        })
    });
    first_loaded.recv_timeout(Duration::from_secs(5)).unwrap();
    let (started, second_started) = mpsc::channel();
    let (done, second_done) = mpsc::channel();
    let second_dir = fixture.0.clone();
    let second = std::thread::spawn(move || {
        started.send(()).unwrap();
        let result = append_snapshot_in(&second_dir, "test", 1, history_snapshot(2));
        done.send(()).unwrap();
        result
    });
    second_started.recv_timeout(Duration::from_secs(5)).unwrap();
    // With the old read/write gap this second update completes while the
    // first still holds an older snapshot, which then overwrites it.
    let overtook = second_done.recv_timeout(Duration::from_millis(250)).is_ok();
    release.send(()).unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap().unwrap();
    let history: Vec<StatsSnapshot> =
        serde_json::from_slice(&fs::read(fixture.0.join(file)).unwrap()).unwrap();
    assert_eq!(history.len(), 3, "neither concurrent append may disappear");
    assert!(
        !overtook,
        "read-modify-write must finish as one transaction"
    );
}

#[test]
fn persistence_snapshot_caps_existing_history_without_losing_latest() {
    let fixture = HistoryFixture::new();
    let file = "snapshots/test_1.json";
    let original: Vec<_> = (0..500).map(history_snapshot).collect();
    fixture.write(file, &serde_json::to_vec(&original).unwrap());
    append_snapshot_in(&fixture.0, "test", 1, history_snapshot(500)).unwrap();
    let history: Vec<StatsSnapshot> =
        serde_json::from_slice(&fs::read(fixture.0.join(file)).unwrap()).unwrap();
    assert_eq!(history.len(), 500);
    assert_eq!(history.first().unwrap().timestamp, 1);
    assert_eq!(history.last().unwrap().timestamp, 500);
}

#[test]
fn ship_stats_session_cache_roundtrip_clear_and_cap() {
    // Unique ids so the shared process-lifetime map stays isolated from
    // any other test touching it in the same binary.
    let raw = vec![RawShipStats {
        ship_id: 987_654_321,
        battles: 10,
        wins: 6,
        damage_caused: 100_000,
        frags: 4,
        survived_battles: 3,
        last_battle_time: 0,
        xp: 0,
        modes: None,
    }];
    assert!(ship_stats_session_get("eu", 987_654_321).is_none());
    let epoch = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
    ship_stats_session_insert("eu", 987_654_321, &raw, epoch);
    let hit = ship_stats_session_get("eu", 987_654_321).expect("inserted");
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].ship_id, 987_654_321);
    // Keyed per realm: another realm's answer is a different entry.
    assert!(ship_stats_session_get("na", 987_654_321).is_none());
    // The manual refresh wipes the whole map.
    clear_ship_stats_session_cache();
    assert!(ship_stats_session_get("eu", 987_654_321).is_none());
    // The cap evicts everything at once (the client caches' policy): the
    // MAX+1-th insert sees a full map and clears it first.
    clear_ship_stats_session_cache();
    let epoch = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
    for id in 0..=SHIP_STATS_SESSION_MAX as i64 {
        ship_stats_session_insert("eu", id, &[], epoch);
    }
    assert!(ship_stats_session_get("eu", 0).is_none());
    assert!(ship_stats_session_get("eu", SHIP_STATS_SESSION_MAX as i64).is_some());

    // A fetch that started BEFORE a clear must not land afterwards (the
    // manual refresh stays forced against in-flight rounds).
    clear_ship_stats_session_cache();
    let stale = SHIP_SESSION_EPOCH.load(std::sync::atomic::Ordering::Acquire);
    clear_ship_stats_session_cache();
    ship_stats_session_insert("eu", 987_654_322, &raw, stale);
    assert!(ship_stats_session_get("eu", 987_654_322).is_none());

    // Leave the process-lifetime map clean for whichever test runs next.
    clear_ship_stats_session_cache();
    assert!(ship_stats_session_get("eu", 987_654_321).is_none());
}

/// Live vortex shape (the per-mode merge's output): pvp subtree plus the
/// mode splits, all with vortex counter names. Pins the top-level
/// career, the solo/div/coop/ranked buckets and the PR anchor mapping.
#[test]
fn raw_ship_stats_from_vortex_parses_full_breakdown() {
    let node = serde_json::json!({
        "pvp": {
            "battles_count": 100, "wins": 55, "damage_dealt": 2500000,
            "frags": 80, "survived": 30, "xp": 900000
        },
        "pvp_solo": { "battles_count": 60, "wins": 30, "damage_dealt": 1500000, "frags": 45, "survived": 18 },
        "pvp_div2": { "battles_count": 30, "wins": 18, "damage_dealt": 750000, "frags": 25, "survived": 9 },
        "pvp_div3": { "battles_count": 10, "wins": 7, "damage_dealt": 250000, "frags": 10, "survived": 3 },
        "pve": { "battles_count": 5, "wins": 4, "damage_dealt": 100000, "frags": 6, "survived": 2 },
        "rank_solo": { "battles_count": 12, "wins": 6, "damage_dealt": 300000, "frags": 10, "survived": 4 },
        "rank_div2": { "battles_count": 8, "wins": 5, "damage_dealt": 200000, "frags": 7, "survived": 3 },
        "rank_div3": null
    });
    let raw = RawShipStats::from_vortex(4282948544, &node).unwrap();
    assert_eq!(raw.ship_id, 4282948544);
    assert_eq!(raw.battles, 100);
    assert_eq!(raw.wins, 55);
    assert_eq!(raw.damage_caused, 2500000);
    assert_eq!(raw.frags, 80);
    assert_eq!(raw.survived_battles, 30);
    assert_eq!(raw.xp, 900000);

    let stats = PlayerShipStats::from(&raw);
    assert!((stats.winrate - 55.0).abs() < 0.01);
    assert!((stats.avg_damage - 25000.0).abs() < 0.1);
    assert!((stats.avg_xp.unwrap() - 9000.0).abs() < 0.1);
    // Same anchors as the account PR: 55% falls between 52%→1350 and
    // 56%→1750, i.e. 1350 + 3/4*400 = 1650.
    assert_eq!(stats.pr, Some(1650));

    let modes = stats.modes.as_ref().expect("modes present");
    let solo = modes.solo.as_ref().unwrap();
    assert_eq!(solo.battles, 60);
    assert!((solo.winrate - 50.0).abs() < 0.01);
    let ranked = modes.ranked.as_ref().unwrap();
    assert_eq!(ranked.battles, 20, "rank_solo + rank_div2 merged");
    assert_eq!(ranked.wins, 11);
    assert!((ranked.winrate - 55.0).abs() < 0.01);
    assert_eq!(modes.coop.as_ref().unwrap().battles, 5);
}

#[test]
fn raw_ship_stats_without_modes_yields_none_breakdown() {
    let node = serde_json::json!({
        "pvp": { "battles_count": 10, "wins": 5, "damage_dealt": 100000, "frags": 5, "survived": 2 }
    });
    let raw = RawShipStats::from_vortex(1, &node).unwrap();
    assert!(raw.modes.is_none());
    let stats = PlayerShipStats::from(&raw);
    assert!(stats.modes.is_none());
    assert_eq!(stats.avg_xp, None, "no xp served → None");
}

/// The vortex serves no last_battle_time; the carry-forward keeps the
/// previous disk write's stamps so the date-range career fallback keeps
/// filtering on recency. Ships the previous write never saw stay 0.
#[test]
fn carry_last_battle_times_fills_zeros_from_the_previous_write() {
    let mut raw = vec![zeroed_raw(1), zeroed_raw(2)];
    // mk_stats carries last_battle_time 1_700_000_000 — the stored stamp.
    let prev = vec![mk_stats(1, 100)];
    carry_last_battle_times(&mut raw, &prev);
    assert_eq!(raw[0].last_battle_time, 1_700_000_000);
    assert_eq!(raw[1].last_battle_time, 0, "a never-seen ship stays 0");
    // A non-zero fresh stamp is never overwritten.
    raw[0].last_battle_time = 42;
    carry_last_battle_times(&mut raw, &prev);
    assert_eq!(raw[0].last_battle_time, 42);
    // Nothing previous on disk at all — a no-op.
    carry_last_battle_times(&mut raw, &[]);
    assert_eq!(raw[0].last_battle_time, 42);
}

#[test]
fn raw_ship_stats_skips_zero_battles() {
    let node = serde_json::json!({
        "pvp": { "battles_count": 0, "wins": 0, "damage_dealt": 0, "frags": 0, "survived": 0 }
    });
    assert!(RawShipStats::from_vortex(1, &node).is_none());
}

#[test]
fn raw_ship_stats_skips_null_pvp() {
    assert!(RawShipStats::from_vortex(1, &serde_json::json!({ "pvp": null })).is_none());
}

#[test]
fn raw_ship_stats_from_vortex_parses_cn_shape() {
    // Historical live shape of the (now summary-only) list endpoint's
    // nodes: the ship id comes from the map key and pvp carries vortex
    // names; sparse counters arrived as null. Mode splits use the same
    // battle-type keys with vortex counter names.
    let node = serde_json::json!({
        "pvp": { "battles_count": 91, "wins": 31, "damage_dealt": null, "frags": null, "xp": 400000 },
        "pve": { "battles_count": 2, "wins": 1 },
        "pvp_solo": { "battles_count": 50, "wins": 17, "damage_dealt": 1000000 }
    });
    let raw = RawShipStats::from_vortex(4285445840, &node).unwrap();
    assert_eq!(raw.ship_id, 4285445840);
    assert_eq!(raw.battles, 91);
    assert_eq!(raw.wins, 31);
    assert_eq!(raw.damage_caused, 0);
    assert_eq!(raw.frags, 0);
    assert_eq!(raw.survived_battles, 0);
    assert_eq!(raw.last_battle_time, 0);
    assert_eq!(raw.xp, 400000, "the legacy xp spelling still feeds xp");
    let modes = raw.modes.as_ref().expect("modes present");
    assert_eq!(modes.solo.as_ref().unwrap().battles, 50);
    assert!((modes.solo.as_ref().unwrap().winrate - 34.0).abs() < 0.01);
    assert_eq!(modes.coop.as_ref().unwrap().battles, 2);
    assert!(modes.ranked.is_none(), "no ranked nodes served");
    // Missing / null / zero-battle nodes are skipped like the WG path.
    assert!(RawShipStats::from_vortex(1, &serde_json::json!({})).is_none());
    assert!(RawShipStats::from_vortex(1, &serde_json::json!({ "pvp": null })).is_none());
    let zero = serde_json::json!({ "pvp": { "battles_count": 0, "wins": 0 } });
    assert!(RawShipStats::from_vortex(1, &zero).is_none());
}

/// Live regression (player 容易摆烂, id 7048255122, ship 白露
/// 4077795024 — the report that exposed the bug): every per-mode node
/// serves three XP totals — `original_exp` (base), `premium_exp` (the
/// bonus part) and `exp` (the boost-multiplied total). Dividing `exp`
/// by battles rendered an average XP of 16,088 against the ship's own
/// `max_exp` of 2,753 — a per-battle average above the per-battle max,
/// impossible. The base total must win whenever it is served.
#[test]
fn raw_ship_stats_from_vortex_reads_base_xp_not_boosted_total() {
    let node = serde_json::json!({
        "pvp": {
            "battles_count": 117, "wins": 68, "losses": 49,
            "damage_dealt": 5851737, "frags": 159,
            "exp": 1882275, "premium_exp": 246377,
            "original_exp": 153130, "max_exp": 2753
        }
    });
    let raw = RawShipStats::from_vortex(4077795024, &node).unwrap();
    assert_eq!(raw.xp, 153130, "base original_exp feeds xp");
    let stats = PlayerShipStats::from(&raw);
    assert!((stats.avg_xp.unwrap() - 153130.0 / 117.0).abs() < 0.01);
    assert!(
        stats.avg_xp.unwrap() < 2753.0,
        "average XP stays under the node's max_exp"
    );
}

/// Live shape (player Evelyine, id 7048272283, ship 4065212112) of the
/// per-mode bulk endpoints: the merge rebuilds the battle-type node the
/// parser consumes, the base-XP `original_exp` feeds xp (the
/// boost-multiplied `exp` total is ignored), a failed split degrades to
/// a missing breakdown entry, and zero-pvp ships are skipped.
#[test]
fn merge_vortex_mode_maps_rebuilds_per_ship_nodes() {
    let pvp = serde_json::json!({
        "status": "ok",
        "data": { "7048272283": { "statistics": {
            "4065212112": { "pvp": {
                "battles_count": 536, "wins": 379, "losses": 157,
                "damage_dealt": 32873159, "frags": 582, "survived": 253,
                "exp": 9480131, "premium_exp": 1265910,
                "original_exp": 767064, "max_exp": 2857
            } },
            "3760142032": { "pvp": {} }
        } } }
    });
    let rank_solo = serde_json::json!({
        "status": "ok",
        "data": { "7048272283": { "statistics": {
            "4065212112": { "rank_solo": {
                "battles_count": 76, "wins": 50,
                "damage_dealt": 3977644, "frags": 90, "survived": 30
            } }
        } } }
    });
    let rows = merge_vortex_mode_maps(
        7048272283,
        vec![
            ("pvp", Ok(pvp)),
            (
                "pvp_div2",
                Err::<serde_json::Value, _>(anyhow!("vortex ships: HTTP 503")),
            ),
            ("rank_solo", Ok(rank_solo)),
        ],
    )
    .expect("merge succeeds");
    assert_eq!(rows.len(), 1, "a ship with no served battles is skipped");
    let r = &rows[0];
    assert_eq!(r.ship_id, 4065212112);
    assert_eq!(r.battles, 536);
    assert_eq!(r.wins, 379);
    assert_eq!(r.damage_caused, 32873159);
    assert_eq!(r.frags, 582);
    assert_eq!(r.survived_battles, 253);
    assert_eq!(
        r.xp, 767064,
        "base original_exp feeds xp, not the boosted exp total"
    );
    let modes = r.modes.as_ref().expect("ranked split present");
    assert_eq!(modes.ranked.as_ref().unwrap().battles, 76);
    assert!((modes.ranked.as_ref().unwrap().winrate - 65.78).abs() < 0.01);
    assert!(modes.solo.is_none(), "failed split degraded to missing");
    let stats = PlayerShipStats::from(r);
    assert!((stats.avg_damage - 32873159.0 / 536.0).abs() < 0.01);
    assert!((stats.avg_xp.unwrap() - 767064.0 / 536.0).abs() < 0.01);
}

/// The pvp core is load-bearing: its failure must surface (so the caller
/// falls back to its cache), while a hidden profile's ok-without-
/// statistics answer stays the empty-list "hidden" marker, never an
/// error.
#[test]
fn merge_vortex_mode_maps_requires_pvp_core_but_tolerates_hidden() {
    let err = merge_vortex_mode_maps(
        1,
        vec![(
            "pvp",
            Err::<serde_json::Value, _>(anyhow!("vortex ships: HTTP 500")),
        )],
    )
    .expect_err("pvp failure must surface");
    assert!(err.to_string().contains("vortex ships"));
    let hidden = serde_json::json!({
        "status": "ok",
        "data": { "1": { "name": "ghost", "hidden_profile": true } }
    });
    let rows =
        merge_vortex_mode_maps(1, vec![("pvp", Ok(hidden))]).expect("hidden is not an error");
    assert!(rows.is_empty());
    // A split-only ship (pvp missing from the data map entirely) keeps
    // its row: the co-op bucket answers future scopes and the ranked
    // bucket answers 排位 today, with the pvp career reading as zero.
    let split_only = serde_json::json!({
        "status": "ok",
        "data": { "1": { "statistics": {
            "42": { "pve": { "battles_count": 5, "wins": 4, "damage_dealt": 100000 } }
        } } }
    });
    let rows = merge_vortex_mode_maps(1, vec![("pve", Ok(split_only))]).expect("ok");
    assert_eq!(rows.len(), 1, "a co-op-only ship keeps its row");
    let r = &rows[0];
    assert_eq!(r.ship_id, 42);
    assert_eq!(r.battles, 0, "the pvp career stays zero");
    assert_eq!(r.modes.as_ref().unwrap().coop.as_ref().unwrap().battles, 5);
}

/// Zero-pvp ships that still carry ranked battles keep their row — the
/// regression that emptied the 单船+排位 view for ranked-only ships
/// (and whole co-op rosters) when rows were dropped on
/// `pvp.battles == 0` alone.
#[test]
fn zero_pvp_rows_survive_on_other_mode_battles() {
    let vortex_node = serde_json::json!({
        "rank_solo": { "battles_count": 7, "wins": 5, "damage_dealt": 140000 }
    });
    let raw = RawShipStats::from_vortex(4282948544, &vortex_node)
        .expect("pvp-less vortex node with ranked battles survives");
    assert_eq!(raw.battles, 0);
    assert_eq!(raw.wins, 0);
    assert_eq!(raw.damage_caused, 0);
    assert_eq!(
        raw.modes.as_ref().unwrap().ranked.as_ref().unwrap().battles,
        7
    );
    // The display conversion reads a zero-pvp row as 0% / 0 damage —
    // the randoms view's `battles > 0` gate keeps it out of aggregates.
    let stats = PlayerShipStats::from(&raw);
    assert_eq!(stats.battles, 0);
    assert_eq!(stats.winrate, 0.0);

    // No pvp AND no other mode → still dropped (an unplayed ship the
    // vortex map happened to carry).
    let empty = serde_json::json!({ "pvp": { "battles_count": 0, "wins": 0 } });
    assert!(RawShipStats::from_vortex(1, &empty).is_none());
}

/// Defensive-branch coverage for the merge: a non-numeric ship-id key is
/// skipped without affecting its siblings, a null mode node yields no
/// entry (not an empty one), and the three ranked splits fed as separate
/// mode documents combine into the single ranked bucket exactly like
/// the WG path's integration test.
#[test]
fn merge_vortex_mode_maps_skips_noise_and_combines_ranked_splits() {
    let pvp = serde_json::json!({
        "status": "ok",
        "data": { "7": { "statistics": {
            "42": { "pvp": {
                "battles_count": 100, "wins": 55, "damage_dealt": 2500000,
                "frags": 80, "survived": 30, "xp": 900000
            } },
            "garbage": { "pvp": { "battles_count": 1, "wins": 1 } },
            "43": { "pvp": null }
        } } }
    });
    let rank_solo = serde_json::json!({
        "status": "ok",
        "data": { "7": { "statistics": {
            "42": { "rank_solo": { "battles_count": 12, "wins": 6, "damage_dealt": 300000 } }
        } } }
    });
    let rank_div2 = serde_json::json!({
        "status": "ok",
        "data": { "7": { "statistics": {
            "42": { "rank_div2": { "battles_count": 8, "wins": 5, "damage_dealt": 200000 } }
        } } }
    });
    let rows = merge_vortex_mode_maps(
        7,
        vec![
            ("pvp", Ok(pvp)),
            ("rank_solo", Ok(rank_solo)),
            ("rank_div2", Ok(rank_div2)),
        ],
    )
    .expect("merge succeeds");
    assert_eq!(rows.len(), 1, "garbage key and null pvp node add no rows");
    let modes = rows[0].modes.as_ref().expect("breakdown present");
    let ranked = modes.ranked.as_ref().expect("ranked bucket");
    assert_eq!(ranked.battles, 20, "rank_solo + rank_div2 merged");
    assert_eq!(ranked.wins, 11);
    assert_eq!(ranked.damage_caused, 500000);
}

fn mk_stats(ship_id: i64, battles: i64) -> PlayerShipStats {
    PlayerShipStats {
        ship_id,
        name: String::new(),
        battles,
        wins: battles / 2,
        damage_caused: battles * 10_000,
        frags: battles,
        survived_battles: battles / 3,
        winrate: 50.0,
        avg_damage: 10_000.0,
        last_battle_time: 1_700_000_000,
        pr: None,
        avg_xp: None,
        modes: None,
    }
}

/// Per-row PR follows the selected algorithm: winrate recomputes the
/// anchor mapping; expected needs the table AND the ship's entry, and
/// yields None otherwise (no silent fallback to the other algorithm).
#[test]
fn apply_pr_algo_switches_formula_per_algorithm() {
    let mut p = mk_stats(4282948544, 100);
    // mk_stats rows sit at 50% WR → between the 47%→750 and 52%→1350
    // anchors: 750 + 3/5·600 = 1110.
    apply_pr_algo(&mut p, PrAlgo::Winrate, &None);
    assert_eq!(p.pr, Some(1110));
    // Expected with no table (download failed / offline) → None ("--").
    apply_pr_algo(&mut p, PrAlgo::Expected, &None);
    assert_eq!(p.pr, None);
    // Expected with the ship in the table: mk_stats counters (50% WR,
    // 10k avg damage, 1.0 frags/battle) exactly meet these expected
    // values → the 1150 at-expected anchor.
    let table = std::collections::HashMap::from([(
        4282948544_i64,
        ExpectedValues {
            average_damage_dealt: 10_000.0,
            average_frags: 1.0,
            win_rate: 50.0,
        },
    )]);
    apply_pr_algo(&mut p, PrAlgo::Expected, &Some(table.clone()));
    assert_eq!(p.pr, Some(1150));
    // A ship missing from the table → None even with the table loaded.
    let mut other = mk_stats(999, 10);
    apply_pr_algo(&mut other, PrAlgo::Expected, &Some(table));
    assert_eq!(other.pr, None);
}

fn zeroed_raw(ship_id: i64) -> RawShipStats {
    RawShipStats {
        ship_id,
        battles: 10,
        wins: 5,
        damage_caused: 100_000,
        frags: 5,
        survived_battles: 2,
        last_battle_time: 0,
        xp: 0,
        modes: None,
    }
}

fn read_history_file(file: &str) -> Vec<ShipStatsHistoryPoint> {
    read_appdata_json(file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Points within the merge window replace the latest point; points beyond
/// it append; the JSON round-trips with camelCase fields intact.
#[test]
fn ship_history_appends_and_merges() {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file = format!("ship-history/test_{ts}.json");
    let _ = write_appdata_json(&file, "[]");

    let t0: i64 = 1_700_000_000;
    append_ship_history("test", ts as i64, &[mk_stats(1, 100)], t0);
    // Same session (< 6h apart) — merges into one point, latest timestamp.
    append_ship_history("test", ts as i64, &[mk_stats(1, 110)], t0 + 3600);
    // Exactly HISTORY_MERGE_SECS later — the window is exclusive, so this
    // appends rather than merges.
    append_ship_history(
        "test",
        ts as i64,
        &[mk_stats(1, 120)],
        t0 + 3600 + HISTORY_MERGE_SECS,
    );
    // Next day — appends another point.
    append_ship_history("test", ts as i64, &[mk_stats(1, 130)], t0 + 90_000);

    let history = read_history_file(&file);
    assert_eq!(history.len(), 3, "only same-session points merge");
    assert_eq!(history[0].timestamp, t0 + 3600);
    assert_eq!(history[0].ships.len(), 1);
    assert_eq!(history[0].ships[0].ship_id, 1);
    assert_eq!(history[0].ships[0].battles, 110);
    assert_eq!(history[0].ships[0].last_battle_time, 1_700_000_000);
    assert_eq!(history[1].timestamp, t0 + 3600 + HISTORY_MERGE_SECS);
    assert_eq!(history[2].timestamp, t0 + 90_000);
    assert_eq!(history[2].ships[0].battles, 130);

    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

/// Empty stats (hidden profile / transient WG hiccup) must never be
/// recorded — an empty baseline would later turn the whole career into
/// "recent" deltas, silently resurrecting the original bug.
#[test]
fn ship_history_ignores_empty_stats() {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file = format!("ship-history/test_{ts}.json");
    let _ = write_appdata_json(&file, "[]");

    let t0: i64 = 1_700_000_000;
    // Empty fetch inside the merge window — must not wipe the good point.
    append_ship_history("test", ts as i64, &[mk_stats(1, 100)], t0);
    append_ship_history("test", ts as i64, &[], t0 + 60);

    let history = read_history_file(&file);
    assert_eq!(history.len(), 1, "empty fetch must be ignored");
    assert_eq!(history[0].timestamp, t0);
    assert_eq!(history[0].ships[0].battles, 100);

    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

/// Rows with battles but zero damage AND kills (what a partially broken
/// upstream returns — the 2026-09 CN vortex regression) must never enter
/// the history: diffing against one later would resurrect the whole
/// career total as a "recent" delta.
#[test]
fn ship_history_skips_poisoned_rows() {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file = format!("ship-history/test_{ts}.json");
    let _ = write_appdata_json(&file, "[]");

    let t0: i64 = 1_700_000_000;
    let poisoned = |ship_id: i64, battles: i64| {
        let mut s = mk_stats(ship_id, battles);
        s.damage_caused = 0;
        s.frags = 0;
        s
    };
    // Healthy ship 1 + poisoned ship 2 → only ship 1 is recorded.
    append_ship_history("test", ts as i64, &[mk_stats(1, 100), poisoned(2, 50)], t0);

    let history = read_history_file(&file);
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0].ships.len(),
        1,
        "poisoned row must not be recorded"
    );
    assert_eq!(history[0].ships[0].ship_id, 1);

    // An all-poisoned fetch records nothing at all: no new point inside
    // the merge window, and the stored point stays untouched.
    append_ship_history("test", ts as i64, &[poisoned(3, 10)], t0 + 60);
    let history = read_history_file(&file);
    assert_eq!(history.len(), 1, "all-poisoned fetch must be ignored");
    assert_eq!(history[0].timestamp, t0, "stored point must not be touched");
    assert_eq!(history[0].ships[0].ship_id, 1);

    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

/// A merge in which a ship's fresh row is poisoned must keep that ship's
/// previously stored totals instead of regressing the baseline to a
/// zero-counter row.
#[test]
fn ship_history_merge_keeps_stored_totals_for_poisoned_refresh() {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file = format!("ship-history/test_{ts}.json");
    let _ = write_appdata_json(&file, "[]");

    let t0: i64 = 1_700_000_000;
    append_ship_history("test", ts as i64, &[mk_stats(2, 40)], t0);
    // Same session (< 6h apart) → merges into the stored point. Ship 1
    // arrives healthy, ship 2 comes back poisoned.
    let mut poisoned2 = mk_stats(2, 55);
    poisoned2.damage_caused = 0;
    poisoned2.frags = 0;
    append_ship_history("test", ts as i64, &[mk_stats(1, 10), poisoned2], t0 + 3600);

    let history = read_history_file(&file);
    assert_eq!(history.len(), 1);
    let by_ship: std::collections::HashMap<i64, _> =
        history[0].ships.iter().map(|s| (s.ship_id, s)).collect();
    assert_eq!(by_ship[&1].battles, 10, "healthy fresh row is recorded");
    assert_eq!(
        by_ship[&2].battles, 40,
        "poisoned refresh must keep the stored healthy totals",
    );
    assert_eq!(by_ship[&2].damage_caused, 40 * 10_000);

    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

/// A retained zero-pvp row (ranked/co-op ship the vortex merge keeps)
/// must never enter a history point, and a merge must keep the stored
/// healthy totals for that ship instead of regressing them to zero —
/// the same treatment poisoned rows get.
#[test]
fn ship_history_keeps_stored_totals_against_zero_battle_rows() {
    let ts: i64 = 1_790_000_000;
    let file = format!("ship-history/test_{ts}.json");
    let _ = write_appdata_json(&file, "[]");

    let t0: i64 = 1_700_000_000;
    append_ship_history("test", ts, &[mk_stats(2, 40)], t0);
    // Same session → merge; ship 2 comes back as a zero-pvp row.
    let mut zero = mk_stats(2, 0);
    zero.damage_caused = 0;
    zero.frags = 0;
    append_ship_history("test", ts, &[mk_stats(1, 10), zero], t0 + 3600);

    let history = read_history_file(&file);
    assert_eq!(history.len(), 1);
    let by_ship: std::collections::HashMap<i64, _> =
        history[0].ships.iter().map(|s| (s.ship_id, s)).collect();
    assert_eq!(by_ship[&1].battles, 10, "healthy fresh row is recorded");
    assert_eq!(
        by_ship[&2].battles, 40,
        "zero-pvp refresh keeps the stored totals"
    );

    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

/// The history file is capped at HISTORY_MAX_POINTS, dropping the oldest.
#[test]
fn ship_history_caps_at_max_points() {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file = format!("ship-history/test_{ts}.json");
    let _ = write_appdata_json(&file, "[]");

    let t0: i64 = 1_700_000_000;
    for i in 0..(HISTORY_MAX_POINTS as i64 + 5) {
        // Step beyond the merge window so every point appends.
        append_ship_history("test", ts as i64, &[mk_stats(1, i)], t0 + i * 7 * 3600);
    }

    let history = read_history_file(&file);
    assert_eq!(history.len(), HISTORY_MAX_POINTS);
    // The oldest 5 points were dropped; the survivor with the smallest
    // timestamp is the 6th point written (battles = 5).
    assert_eq!(history[0].ships[0].battles, 5);
    assert_eq!(
        history.last().unwrap().ships[0].battles,
        HISTORY_MAX_POINTS as i64 + 4,
    );

    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

/// Snapshot append: write 3 snapshots, read back, expect length 3 in order.
/// This exercises the read→push→write path directly (the async command
/// wraps the same logic).
#[test]
fn snapshot_appends_not_overwrites() {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let file = format!("snapshots/test_{ts}.json");
    // Start clean.
    let _ = write_appdata_json(&file, "[]");

    for i in 0..3 {
        let mut history: Vec<StatsSnapshot> = read_appdata_json(&file)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        history.push(StatsSnapshot {
            timestamp: i,
            game_version: "0.1.0".into(),
            battles: i * 100,
            wins: i * 50,
            winrate: 50.0,
            avg_damage: 1000.0 * (i + 1) as f32,
            pr: Some(1500),
        });
        let _ = write_appdata_json(&file, &serde_json::to_string(&history).unwrap());
    }

    let final_history: Vec<StatsSnapshot> = read_appdata_json(&file)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    assert_eq!(final_history.len(), 3, "should have 3 snapshots");
    assert_eq!(final_history[0].battles, 0);
    assert_eq!(final_history[1].battles, 100);
    assert_eq!(final_history[2].battles, 200);

    // Cleanup.
    let path = appdata_dir_path().unwrap().join(&file);
    let _ = fs::remove_file(&path);
}

// ── Incremental container scanner ──────────────────────────────────

/// Drain a scanner over `doc` fed in `chunk`-sized pieces; returns the
/// (key, parsed value object) pairs in arrival order.
fn scan_in_chunks(
    kind: ContainerKind,
    path: Vec<&str>,
    doc: &str,
    chunk: usize,
) -> Vec<(Option<i64>, serde_json::Value)> {
    let path: Vec<String> = path.iter().map(|s| s.to_string()).collect();
    let bytes = doc.as_bytes();
    let mut scanner = ContainerScanner::new(kind, path);
    let mut out = Vec::new();
    let mut fed = 0;
    while fed < bytes.len() {
        fed = (fed + chunk).min(bytes.len());
        for entry in scanner.feed(&bytes[..fed]) {
            let value = serde_json::from_slice(&bytes[entry.start..entry.end]).unwrap();
            out.push((entry.key, value));
        }
    }
    out
}

const VORTEX_DOC: &str = r#"{"status": "ok", "data": {"7048296264": {"statistics": {
        "4280203248": {"pvp": {"battles_count": 46, "wins": 21, "damage_dealt": 3000000, "frags": 30, "survived": 12, "original_exp": 50000}},
        "3539908400": {"pvp": {"battles_count": 164, "wins": 79, "damage_dealt": 11510490, "frags": 70, "survived": 55, "original_exp": 180000}},
        "3543054128": {"pvp": null}
    }}}, "meta": {"count": 3}}"#;

#[test]
fn scanner_reads_vortex_map_in_one_piece() {
    let entries = scan_in_chunks(
        ContainerKind::Map,
        vec!["data", "7048296264", "statistics"],
        VORTEX_DOC,
        VORTEX_DOC.len(),
    );
    assert_eq!(entries.len(), 3, "null pvp node still yields its entry");
    assert_eq!(entries[0].0, Some(4280203248));
    assert_eq!(
        entries[0].1.get("pvp").and_then(|p| p.get("battles_count")),
        Some(&serde_json::json!(46))
    );
    assert_eq!(entries[2].0, Some(3543054128));
    assert!(entries[2].1.get("pvp").unwrap().is_null());
}

/// The property that matters most: EVERY chunking of the same byte
/// stream must yield the identical entry list — including splitting
/// mid-string, mid-escape, mid-number and mid-brace. The bounds
/// (1..=13 / 1..=11 below) straddle the docs' longest tokens, so every
/// token type sees splits inside itself.
#[test]
fn scanner_chunking_is_chunk_size_invariant() {
    let reference = scan_in_chunks(
        ContainerKind::Map,
        vec!["data", "7048296264", "statistics"],
        VORTEX_DOC,
        VORTEX_DOC.len(),
    );
    for chunk in 1..=13 {
        let entries = scan_in_chunks(
            ContainerKind::Map,
            vec!["data", "7048296264", "statistics"],
            VORTEX_DOC,
            chunk,
        );
        assert_eq!(entries.len(), reference.len(), "chunk size {chunk}");
        for (a, b) in entries.iter().zip(&reference) {
            assert_eq!(a.0, b.0, "chunk size {chunk}");
            assert_eq!(a.1, b.1, "chunk size {chunk}");
        }
    }
}

#[test]
fn scanner_entries_parse_into_partial_rows() {
    // The exact composition the streaming path uses: scanner entries
    // fed STRAIGHT into from_vortex (the entry IS the battle-type
    // node — re-wrapping it under another "pvp" hides the counters a
    // depth too deep and parses every entry to None).
    let entries = scan_in_chunks(
        ContainerKind::Map,
        vec!["data", "7048296264", "statistics"],
        VORTEX_DOC,
        3,
    );
    let rows: Vec<RawShipStats> = entries
        .iter()
        .filter_map(|(key, node)| RawShipStats::from_vortex(key.expect("ship ids parse"), node))
        .collect();
    assert_eq!(rows.len(), 2, "null-pvp entry parses to no row");
    assert_eq!(rows[0].ship_id, 4280203248);
    assert_eq!(rows[0].battles, 46);
    assert_eq!(rows[0].wins, 21);
    assert_eq!(rows[0].damage_caused, 3000000);
    assert_eq!(rows[0].xp, 50000);
    assert_eq!(rows[1].ship_id, 3539908400);
    assert_eq!(rows[1].battles, 164);
}

/// A truncated stream must yield only the entries whose closing brace
/// already arrived — never a phantom or a mis-sliced one.
#[test]
fn scanner_truncation_yields_only_complete_entries() {
    let doc = VORTEX_DOC;
    for cut in 1..doc.len() {
        let entries = scan_in_chunks(
            ContainerKind::Map,
            vec!["data", "7048296264", "statistics"],
            &doc[..cut],
            doc.len(),
        );
        let full = entries
            .iter()
            .filter(|(_, v)| v.get("pvp").is_some())
            .count();
        assert!(
            entries.len() <= 3,
            "cut {cut}: no more than the three real entries"
        );
        // Every yielded entry must parse to a node that carries the
        // expected key set (i.e. slices landed on real boundaries).
        for (key, value) in &entries {
            assert!(key.is_some(), "cut {cut}: keys parse");
            assert!(
                value.get("pvp").is_some(),
                "cut {cut}: entries carry the pvp subtree"
            );
        }
        let _ = full;
    }
}

/// Strings containing braces, quotes, escapes and the literal text of
/// the path keys must not confuse the structure walk.
#[test]
fn scanner_survives_hostile_strings() {
    let doc = r#"{"status":"ok","data":{"42":{"statistics":{
            "111":{"pvp":{"battles_count":5,"note":"has } brace and , comma and \" quote and statistics text"}},
            "222":{"pvp":{"battles_count":7,"note":"backslash \\\\ escape"}}
        },"other":1}},"meta":{}}"#;
    let entries = scan_in_chunks(ContainerKind::Map, vec!["data", "42", "statistics"], doc, 7);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].0, Some(111));
    // The JSON source carries four backslashes → two decoded.
    assert_eq!(
        entries[1].1.pointer("/pvp/note").and_then(|v| v.as_str()),
        Some("backslash \\\\ escape")
    );
}

/// An error envelope (or hidden profile) never contains the target
/// container — zero entries, scanner parked harmlessly.
#[test]
fn scanner_finds_nothing_in_error_or_hidden_docs() {
    let error_doc = r#"{"status": "error", "error": {"code": 404, "message": "NOT_FOUND"}}"#;
    assert!(
        scan_in_chunks(
            ContainerKind::Map,
            vec!["data", "1", "statistics"],
            error_doc,
            3
        )
        .is_empty()
    );

    let hidden_doc = r#"{"status": "ok", "data": {"1": {"statistics": {}}}}"#;
    assert!(
        scan_in_chunks(
            ContainerKind::Map,
            vec!["data", "1", "statistics"],
            hidden_doc,
            5
        )
        .is_empty()
    );
}

const WG_DOC: &str = r#"{"status":"ok","data":{"2020566935":[
        {"ship_id":3765352144,"last_battle_time":1791700000,"pvp":{"battles":120,"wins":60,"damage_dealt":9000000,"frags":90,"survived_battles":40,"xp":150000}},
        {"ship_id":3543054128,"last_battle_time":0,"pvp":null,"pve":{"battles":3,"wins":3,"damage_dealt":90000,"frags":1,"survived_battles":2}}
    ]},"meta":{"page_total":1}}"#;

#[test]
fn scanner_reads_wg_array_and_parses_rows() {
    let entries = scan_in_chunks(ContainerKind::Array, vec!["data", "2020566935"], WG_DOC, 5);
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|(k, _)| k.is_none()));
    let rows: Vec<RawShipStats> = entries
        .iter()
        .filter_map(|(_, v)| RawShipStats::from_wg(v))
        .collect();
    assert_eq!(rows.len(), 2, "zero-pvp pve row keeps its place");
    assert_eq!(rows[0].ship_id, 3765352144);
    assert_eq!(rows[0].battles, 120);
    assert_eq!(rows[0].xp, 150000);
    assert_eq!(rows[0].last_battle_time, 1791700000);
    assert_eq!(rows[1].battles, 0);
    assert_eq!(
        rows[1]
            .modes
            .as_ref()
            .unwrap()
            .coop
            .as_ref()
            .unwrap()
            .battles,
        3
    );
}

#[test]
fn scanner_wg_chunking_invariant() {
    let reference = scan_in_chunks(
        ContainerKind::Array,
        vec!["data", "2020566935"],
        WG_DOC,
        WG_DOC.len(),
    );
    for chunk in 1..=11 {
        let entries = scan_in_chunks(
            ContainerKind::Array,
            vec!["data", "2020566935"],
            WG_DOC,
            chunk,
        );
        assert_eq!(entries.len(), reference.len(), "chunk {chunk}");
        for (a, b) in entries.iter().zip(&reference) {
            assert_eq!(a.1, b.1, "chunk {chunk}");
        }
    }
}

// ── Dual-path race ─────────────────────────────────────────────────

/// The wire contract with the frontend's ShipStatsProgress interface:
/// camelCase field names (an un-renamed struct silently breaks every
/// consumer — `accountId` reads undefined and partial rows land on a
/// key nothing matches).
#[test]
fn progress_payload_serializes_camelcase() {
    let payload = ShipStatsProgress {
        realm: "asia".into(),
        account_id: 42,
        phase: "partial",
        source: "vortex:pvp".into(),
        rows: Some(Vec::new()),
    };
    let raw = serde_json::to_string(&payload).unwrap();
    assert!(
        raw.contains("\"accountId\""),
        "camelCase on the wire: {raw}"
    );
    assert!(raw.contains("\"rows\""), "rows serialize on partial: {raw}");
    let no_rows = serde_json::to_string(&ShipStatsProgress {
        realm: "cn".into(),
        account_id: 1,
        phase: "slow",
        source: "official".into(),
        rows: None,
    })
    .unwrap();
    assert!(
        !no_rows.contains("\"rows\""),
        "rows skipped when absent: {no_rows}"
    );
}

#[tokio::test]
async fn race_prefers_a_fast_healthy_primary_and_signals_abandon() {
    let abandoned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let a2 = abandoned.clone();
    let out = race_dual_path(
        async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Ok(vec![RawShipStats {
                ship_id: 1,
                ..zero_raw()
            }])
        },
        async {
            Ok(vec![
                RawShipStats {
                    ship_id: 2,
                    ..zero_raw()
                },
                RawShipStats {
                    ship_id: 3,
                    ..zero_raw()
                },
            ])
        },
        |_| panic!("racer rows must not surface when the primary wins"),
        move || a2.store(true, std::sync::atomic::Ordering::Release),
    )
    .await
    .unwrap();
    assert_eq!(out.iter().map(|r| r.ship_id).collect::<Vec<_>>(), [2, 3]);
    // The dropped racer still gets its terminal signal.
    assert!(abandoned.load(std::sync::atomic::Ordering::Acquire));
}

#[tokio::test]
async fn race_surfaces_racer_rows_and_prefers_late_primary() {
    let surfaced = std::sync::Arc::new(std::sync::Mutex::new(Vec::<i64>::new()));
    let s2 = surfaced.clone();
    let out = race_dual_path(
        async {
            Ok(vec![RawShipStats {
                ship_id: 9,
                ..zero_raw()
            }])
        },
        async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Ok(vec![RawShipStats {
                ship_id: 10,
                ..zero_raw()
            }])
        },
        move |rows| s2.lock().unwrap().extend(rows.iter().map(|r| r.ship_id)),
        || panic!("the racer settled on its own — no abandonment here"),
    )
    .await
    .unwrap();
    assert_eq!(*surfaced.lock().unwrap(), [9], "racer rows surfaced once");
    assert_eq!(out.iter().map(|r| r.ship_id).collect::<Vec<_>>(), [10]);
}

#[tokio::test]
async fn race_falls_back_to_racer_rows_when_primary_fails() {
    let out = race_dual_path(
        async {
            Ok(vec![RawShipStats {
                ship_id: 9,
                ..zero_raw()
            }])
        },
        async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Err(anyhow!("primary died"))
        },
        |_| {},
        || panic!("the racer is awaited to completion here, not abandoned"),
    )
    .await
    .unwrap();
    assert_eq!(out.iter().map(|r| r.ship_id).collect::<Vec<_>>(), [9]);
}

#[tokio::test]
async fn race_racer_rescues_a_failed_primary() {
    let out = race_dual_path(
        async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Ok(vec![RawShipStats {
                ship_id: 7,
                ..zero_raw()
            }])
        },
        async { Err(anyhow!("primary died")) },
        |_| {},
        || panic!("the racer is awaited to completion here, not abandoned"),
    )
    .await
    .unwrap();
    assert_eq!(out.iter().map(|r| r.ship_id).collect::<Vec<_>>(), [7]);
}

#[tokio::test]
async fn race_fails_only_when_both_arms_fail() {
    let err = race_dual_path(
        async { Err::<Vec<RawShipStats>, _>(anyhow!("racer died")) },
        async { Err(anyhow!("primary died")) },
        |_| {},
        || panic!("racer must not be abandoned when both arms fail"),
    )
    .await
    .unwrap_err();
    // Either error text is acceptable — the primary's shape is used.
    assert!(!err.to_string().is_empty());
}

#[tokio::test]
async fn race_ignores_a_failed_racer() {
    let out = race_dual_path(
        async { Err::<Vec<RawShipStats>, _>(anyhow!("racer died")) },
        async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            Ok(vec![RawShipStats {
                ship_id: 4,
                ..zero_raw()
            }])
        },
        |_| {},
        || panic!("racer settled on its own — no abandonment"),
    )
    .await
    .unwrap();
    assert_eq!(out.iter().map(|r| r.ship_id).collect::<Vec<_>>(), [4]);
}

fn zero_raw() -> RawShipStats {
    RawShipStats {
        ship_id: 0,
        battles: 0,
        wins: 0,
        damage_caused: 0,
        frags: 0,
        survived_battles: 0,
        last_battle_time: 0,
        xp: 0,
        modes: None,
    }
}

#[test]
fn stream_cap_rejects_oversized_bodies() {
    // The byte cap exists so a broken/hostile source cannot balloon the
    // process memory through the stall-tolerant reader: past the cap the
    // read must fail with a source-named error (the caller's racer/cache
    // fallback then applies), never grow the buffer.
    ensure_stream_cap(0, "vortex:pvp").unwrap();
    ensure_stream_cap(SHIP_STREAM_MAX_BYTES, "vortex:pvp").unwrap();
    let err = ensure_stream_cap(SHIP_STREAM_MAX_BYTES + 1, "vortex:pvp")
        .expect_err("over-cap body must fail");
    let text = format!("{err:#}");
    assert!(
        text.contains("vortex:pvp") && text.contains("size cap"),
        "error names source and cap: {text}"
    );
    assert!(text.contains("64"), "error states the cap value: {text}");
}
