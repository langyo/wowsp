use std::fs;
use std::path::PathBuf;

use super::game_client::is_replay_extension;
use super::listing::*;
use super::meta::*;
use super::streams::*;
use wowsp_tauri_shared::{GameInstall, GameInstallKind, VehicleEntry};

/// The Lesta arena synthesis joins roster entries to ship entities by
/// unique EntityCreate shipId, pairs COMPLETE same-config groups by the
/// game's team-blocked spawn order (see the synthesis's group comment),
/// marks the recorder via relation 0, carries the create-state starting
/// health through, and leaves an already-decoded arena list untouched.
#[test]
fn lesta_arena_synthesis_joins_unique_and_pairs_complete_mirrors() {
    let kind = |eid: i32, ship_id: Option<i64>, max_health: Option<u32>| {
        (
            eid,
            wowsp_tauri_shared::EntityKind {
                entity_type: 2,
                vehicle_id: 0,
                initial_x: 0.0,
                initial_y: 0.0,
                initial_z: 0.0,
                creation_time: 0.0,
                ship_id,
                max_health,
                radius: None,
                control_point_index: None,
                initial_team: None,
            },
        )
    };
    let kinds: std::collections::BTreeMap<_, _> = [
        kind(10, Some(101), Some(42_500)),
        kind(11, Some(102), Some(12_000)),
        kind(12, Some(103), Some(9_999)),
        kind(13, Some(103), Some(9_999)),
        kind(14, None, None),
    ]
    .into();
    let mut arena = Vec::new();
    let roster = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 101,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":Bot:".into(),
            relation: 1,
            ship_id: 102,
            ship_name: None,
        },
        VehicleEntry {
            id: 3,
            name: "foe-a".into(),
            relation: 2,
            ship_id: 103,
            ship_name: None,
        },
        VehicleEntry {
            id: 4,
            name: "foe-b".into(),
            relation: 2,
            ship_id: 103,
            ship_name: None,
        },
        VehicleEntry {
            id: 5,
            name: "no-ship".into(),
            relation: 1,
            ship_id: 0,
            ship_name: None,
        },
    ];
    synthesize_lesta_arena_players(&mut arena, &kinds, &roster, None);
    // The mirrored 103 pair (two roster entries, two entities) now
    // PAIRS by spawn order — blocks monotone (joined: team-0 only), so
    // k-th entity takes the k-th candidate (relation, id ascending);
    // shipId-less entity 14 and the ship_id-0 entry join nothing.
    assert_eq!(arena.len(), 4);
    let me = arena.iter().find(|p| p.is_self).unwrap();
    assert_eq!((me.entity_id, me.team_id, me.player_id), (10, 0, 1));
    assert_eq!(me.max_health, 42_500);
    let bot = arena.iter().find(|p| p.player_id == -2).unwrap();
    assert_eq!((bot.entity_id, bot.team_id, bot.is_bot), (11, 0, true));
    assert_eq!(bot.max_health, 12_000);
    let foe_a = arena.iter().find(|p| p.player_id == 3).unwrap();
    assert_eq!((foe_a.entity_id, foe_a.team_id), (12, 1));
    let foe_b = arena.iter().find(|p| p.player_id == 4).unwrap();
    assert_eq!((foe_b.entity_id, foe_b.team_id), (13, 1));
    // The ship_id-0 roster entry still joins nothing.
    assert!(!arena.iter().any(|p| p.player_id == 5));
}

/// An arena list that already decoded (WG path) or an empty roster keeps
/// the synthesis a no-op.
fn entity_kind_with_ship(ship: i64) -> wowsp_tauri_shared::EntityKind {
    wowsp_tauri_shared::EntityKind {
        entity_type: 2,
        vehicle_id: 0,
        initial_x: 0.0,
        initial_y: 0.0,
        initial_z: 0.0,
        creation_time: 0.0,
        ship_id: if ship > 0 { Some(ship) } else { None },
        max_health: Some(1000),
        control_point_index: None,
        initial_team: None,
        radius: None,
    }
}

/// Regenerate the webui live-calibration fixture from a local LESTA
/// replay (.korablireplay — a WG replay would decode a stream the
/// calibration test's ground truth does not match):
/// the decoded LiveSelfStream of `WOWSP_TEST_REPLAY` is written to
/// `WOWSP_CALIB_FIXTURE` (see liveSelfCalibration.test.ts — the
/// fixture is gitignored, so fresh clones skip the calibration until
/// this runs against a local capture).
#[test]
#[ignore = "writes a local fixture from a machine-specific replay path"]
fn regenerate_live_calibration_fixture() {
    let Some(path) = std::env::var_os("WOWSP_TEST_REPLAY") else {
        panic!("set WOWSP_TEST_REPLAY=<replay file> and WOWSP_CALIB_FIXTURE=<out.json>");
    };
    let Some(out) = std::env::var_os("WOWSP_CALIB_FIXTURE") else {
        panic!("set WOWSP_CALIB_FIXTURE=<out.json>");
    };
    let bytes = fs::read(&path).unwrap();
    let stream = live_snapshot_from_bytes(&path.to_string_lossy(), &bytes);
    let json = serde_json::to_string(&stream).unwrap();
    fs::write(&out, json).unwrap();
}

#[test]
fn lesta_arena_synthesis_anchors_self_and_unambiguates_the_mirror() {
    // The live-calibration scenario: two identical ship configs on
    // the field (the recorder + a same-config enemy), so the config-id
    // join alone cannot tell them apart — the recorder's anchor must
    // place the relation-0 entry while the OTHER config holder joins
    // uniquely once the anchor is removed from the candidates.
    let mut kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> =
        std::collections::BTreeMap::new();
    for eid in [10i32, 20] {
        kinds.insert(eid, entity_kind_with_ship(101));
    }
    kinds.insert(30, entity_kind_with_ship(103));
    let roster = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 101,
            ship_name: None,
        },
        VehicleEntry {
            id: 2,
            name: "mirror".into(),
            relation: 2,
            ship_id: 101,
            ship_name: None,
        },
        VehicleEntry {
            id: 3,
            name: "other".into(),
            relation: 2,
            ship_id: 103,
            ship_name: None,
        },
    ];
    let mut arena = Vec::new();
    synthesize_lesta_arena_players(&mut arena, &kinds, &roster, Some(10));
    let me = arena.iter().find(|p| p.is_self).expect("self anchored");
    assert_eq!(me.entity_id, 10);
    assert_eq!(me.player_id, 1);
    // The mirror joined the REMAINING entity with its config id.
    let mirror = arena
        .iter()
        .find(|p| p.name == "mirror")
        .expect("mirror joined");
    assert_eq!(mirror.entity_id, 20);
    assert_eq!(mirror.team_id, 1);
    // And the unrelated enemy joined normally.
    assert!(arena.iter().any(|p| p.entity_id == 30 && p.name == "other"));
}

/// The co-op mirror shape (the 2026-10-09 Nassau/Phoenix pairs): every
/// bot config fields ONE ally and ONE enemy, so the complete group must
/// pair by spawn order — the ally block's lower entity id takes the
/// ally candidate, the enemy's the enemy candidate — while an
/// interleaved joined-block layout (the guard's counterfactual) keeps
/// the group skipped, and an incomplete group (3 entities, 2
/// candidates) never guesses.
#[test]
fn lesta_arena_synthesis_pairs_complete_config_groups_by_spawn_order() {
    let mut kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> = [
        (10, entity_kind_with_ship(100)),
        (20, entity_kind_with_ship(200)),
        (30, entity_kind_with_ship(200)),
        (40, entity_kind_with_ship(201)),
    ]
    .into();
    let mut arena = Vec::new();
    let roster = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 100,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":AllyBot:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":FoeBot:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":Foe2:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    // The recorder anchors entity 10; the unique 201 config joins
    // entity 40 on the enemy side; the mirrored 200 group pairs
    // 20 -> ally (team 0), 30 -> foe (team 1).
    synthesize_lesta_arena_players(&mut arena, &kinds, &roster, Some(10));
    assert_eq!(arena.len(), 4);
    let ally = arena.iter().find(|p| p.player_id == -2).unwrap();
    assert_eq!(
        (ally.entity_id, ally.team_id, ally.name.as_str()),
        (20, 0, ":AllyBot:")
    );
    let foe = arena.iter().find(|p| p.player_id == -3).unwrap();
    assert_eq!(
        (foe.entity_id, foe.team_id, foe.name.as_str()),
        (30, 1, ":FoeBot:")
    );
    let foe2 = arena.iter().find(|p| p.player_id == -4).unwrap();
    assert_eq!((foe2.entity_id, foe2.team_id), (40, 1));

    // Guard counterfactual: the unique-rule enemy (entity 5, ship 201)
    // sits BELOW the anchored ally 10, so the joined evidence reads as
    // an enemies-first layout — but the 200 group's entities (20, 30)
    // both land ABOVE that enemy block while the roster needs one on
    // each side, and the post-pairing orientation check rejects the
    // layout: the group stays unjoined.
    kinds.insert(5, entity_kind_with_ship(201));
    kinds.remove(&40);
    let mut guarded = Vec::new();
    let roster_guard = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 100,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":AllyBot:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":FoeBot:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":Foe2:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    synthesize_lesta_arena_players(&mut guarded, &kinds, &roster_guard, Some(10));
    // Entity 5 (ship 201) is the only 201 carrier — the unique rule
    // joins it on the enemy side at id 5 < the anchored ally 10; the
    // 200 group's entities cannot respect that block layout, so it
    // stays out.
    assert_eq!(guarded.len(), 2);
    assert!(
        guarded
            .iter()
            .all(|p| p.entity_id == 10 || p.entity_id == 5)
    );

    // Incomplete group: three entities on one config with two
    // candidates pair nothing (an order-based partial guess would
    // mis-name one of them).
    let mut triple: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> = [
        (10, entity_kind_with_ship(100)),
        (40, entity_kind_with_ship(200)),
        (50, entity_kind_with_ship(200)),
        (60, entity_kind_with_ship(200)),
    ]
    .into();
    triple.insert(70, entity_kind_with_ship(201));
    let mut incomplete = Vec::new();
    let roster_triple = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 100,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":A:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":B:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":C:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    synthesize_lesta_arena_players(&mut incomplete, &triple, &roster_triple, Some(10));
    assert_eq!(incomplete.len(), 2);
    assert!(
        incomplete
            .iter()
            .all(|p| p.entity_id == 10 || p.entity_id == 70)
    );

    // Incomplete group, candidates > entities: two entities on one
    // config with three roster candidates pair nothing either — the
    // counts must match exactly in both directions.
    let mut pair: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> = [
        (10, entity_kind_with_ship(100)),
        (40, entity_kind_with_ship(200)),
        (50, entity_kind_with_ship(200)),
    ]
    .into();
    pair.insert(70, entity_kind_with_ship(201));
    let mut over = Vec::new();
    let roster_over = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 100,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":A:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":B:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -5,
            name: ":D:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":C:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    synthesize_lesta_arena_players(&mut over, &pair, &roster_over, Some(10));
    assert_eq!(over.len(), 2);
    assert!(over.iter().all(|p| p.entity_id == 10 || p.entity_id == 70));

    // Single-sided layout ((None, Some) guard arm): no team-0 entry
    // joined at all — a lone enemy entity is the only join evidence.
    // No contradicting blocks, so the complete 200 group still pairs.
    let oneside_kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> = [
        (40, entity_kind_with_ship(200)),
        (50, entity_kind_with_ship(200)),
        (70, entity_kind_with_ship(201)),
    ]
    .into();
    let mut oneside = Vec::new();
    let roster_oneside = vec![
        VehicleEntry {
            id: -2,
            name: ":A:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":B:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":C:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    synthesize_lesta_arena_players(&mut oneside, &oneside_kinds, &roster_oneside, None);
    // Ship 201 joins :C: uniquely on the enemy side; the mirrored 200
    // group pairs by order (40 -> ally :A: team 0, 50 -> foe :B:
    // team 1) — the single-side arm permits it (no team-0 block to
    // contradict).
    assert_eq!(oneside.len(), 3);
    let a = oneside.iter().find(|p| p.player_id == -2).unwrap();
    assert_eq!((a.entity_id, a.team_id), (40, 0));
    let b = oneside.iter().find(|p| p.player_id == -3).unwrap();
    assert_eq!((b.entity_id, b.team_id), (50, 1));
    let c = oneside.iter().find(|p| p.player_id == -4).unwrap();
    assert_eq!((c.entity_id, c.team_id), (70, 1));

    // Post-pairing re-check: the pre-guard passed on the joined
    // evidence (10 < 30), but the group's OWN insertions broke the
    // blocks (a paired ally at 40 above the existing enemy floor 30) —
    // the just-pushed entries pop and the group stays unjoined.
    let pop_kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> = [
        (10, entity_kind_with_ship(100)),
        (30, entity_kind_with_ship(201)),
        (40, entity_kind_with_ship(200)),
        (50, entity_kind_with_ship(200)),
    ]
    .into();
    let mut popped = Vec::new();
    let roster_popped = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 100,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":A:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":B:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":C:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    synthesize_lesta_arena_players(&mut popped, &pop_kinds, &roster_popped, Some(10));
    assert_eq!(popped.len(), 2);
    assert!(
        popped
            .iter()
            .all(|p| p.entity_id == 10 || p.entity_id == 30)
    );
}

/// The reversed spawn orientation (the 2026-10-13 53_Shoreside capture):
/// the ENEMY block spawned below the ally block, with the anchored
/// recorder sitting high in the ally block and each mirrored config
/// straddling the boundary (one entity per block). The joined evidence
/// (anchored ally 90 above the unique-joined enemy 30) selects the
/// enemies-first orientation, so the group's lower entity takes the
/// ENEMY candidate — the allies-first reading would paint both pairs
/// in the wrong colors.
#[test]
fn lesta_arena_synthesis_pairs_mirror_groups_when_enemies_spawn_first() {
    let kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> = [
        (20, entity_kind_with_ship(200)),
        (30, entity_kind_with_ship(201)),
        (80, entity_kind_with_ship(200)),
        (90, entity_kind_with_ship(100)),
    ]
    .into();
    let roster = vec![
        VehicleEntry {
            id: 1,
            name: "me".into(),
            relation: 0,
            ship_id: 100,
            ship_name: None,
        },
        VehicleEntry {
            id: -2,
            name: ":AllyBot:".into(),
            relation: 1,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -3,
            name: ":FoeBot:".into(),
            relation: 2,
            ship_id: 200,
            ship_name: None,
        },
        VehicleEntry {
            id: -4,
            name: ":Foe2:".into(),
            relation: 2,
            ship_id: 201,
            ship_name: None,
        },
    ];
    let mut arena = Vec::new();
    synthesize_lesta_arena_players(&mut arena, &kinds, &roster, Some(90));
    assert_eq!(arena.len(), 4);
    let me = arena.iter().find(|p| p.is_self).unwrap();
    assert_eq!((me.entity_id, me.team_id), (90, 0));
    // The unique 201 joins the low enemy entity; the mirrored 200 group
    // straddles the blocks — 20 (enemy block) takes :FoeBot:, 80 (ally
    // block) takes :AllyBot:.
    let foe = arena.iter().find(|p| p.player_id == -3).unwrap();
    assert_eq!((foe.entity_id, foe.team_id), (20, 1));
    let ally = arena.iter().find(|p| p.player_id == -2).unwrap();
    assert_eq!((ally.entity_id, ally.team_id), (80, 0));
    let foe2 = arena.iter().find(|p| p.player_id == -4).unwrap();
    assert_eq!((foe2.entity_id, foe2.team_id), (30, 1));
}

#[test]
fn lesta_arena_synthesis_is_noop_when_unneeded() {
    let kinds: std::collections::BTreeMap<_, wowsp_tauri_shared::EntityKind> =
        std::collections::BTreeMap::new();
    let mut arena = Vec::new();
    synthesize_lesta_arena_players(&mut arena, &kinds, &[], None);
    assert!(arena.is_empty());

    let mut populated = vec![wowsp_tauri_shared::ArenaPlayer {
        entity_id: 1,
        team_id: 0,
        player_id: 7,
        ship_params_id: 42,
        max_health: 100,
        name: "wg".into(),
        is_bot: false,
        avatar_id: None,
        is_self: true,
    }];
    let before: Vec<_> = populated
        .iter()
        .map(|p| (p.entity_id, p.player_id, p.max_health))
        .collect();
    synthesize_lesta_arena_players(
        &mut populated,
        &kinds,
        &[VehicleEntry {
            id: 9,
            name: "x".into(),
            relation: 0,
            ship_id: 1,
            ship_name: None,
        }],
        None,
    );
    let after: Vec<_> = populated
        .iter()
        .map(|p| (p.entity_id, p.player_id, p.max_health))
        .collect();
    assert_eq!(after, before);
}

/// HP property detection picks the index whose series behave like HP
/// (start full, plausible magnitude, no wild upward jumps) under either
/// int or float interpretation, regardless of game version.
#[test]
fn detect_hp_property_scores_by_magnitude() {
    let mut kinds = std::collections::BTreeMap::new();
    kinds.insert(
        1,
        wowsp_tauri_shared::EntityKind {
            entity_type: 2,
            vehicle_id: 7770,
            initial_x: 0.0,
            initial_y: 0.0,
            initial_z: 0.0,
            creation_time: 0.0,
            ship_id: None,
            max_health: None,
            radius: None,
            control_point_index: None,
            initial_team: None,
        },
    );
    let change =
        |property_index: u32, value: u32, size: u8| super::super::packets::PropertyChange {
            time: 0.0,
            entity_id: 1,
            property_index,
            value,
            size,
        };
    // Float HP at 28 (14.5 layout), int noise at 20 (starts full but jumps
    // +86% in one step -> rejected).
    let hp = |v: f32| change(28, v.to_bits(), 4);
    let props = std::collections::BTreeMap::from([(
        1,
        vec![
            hp(70011.0),
            hp(65500.0),
            hp(60100.0),
            hp(52300.0),
            change(20, 31454, 2),
            change(20, 4603, 2),
            change(20, 31737, 2),
            change(20, 31736, 2),
        ],
    )]);
    assert_eq!(detect_hp_property(&kinds, &props), (28, HpValueKind::Float));

    // Int HP at 21 (0.11.x-style integer stream, smooth decline).
    let props_int = std::collections::BTreeMap::from([(
        1,
        vec![
            change(21, 20340, 4),
            change(21, 19800, 4),
            change(21, 18500, 4),
            change(21, 17000, 4),
        ],
    )]);
    assert_eq!(
        detect_hp_property(&kinds, &props_int),
        (21, HpValueKind::Int)
    );

    // No plausible HP anywhere -> default (20, Int).
    let props_none = std::collections::BTreeMap::from([(1, vec![change(7, 5, 1)])]);
    assert_eq!(
        detect_hp_property(&kinds, &props_none),
        (20, HpValueKind::Int)
    );
}

/// Streams that first report a damaged reading get the arena starting
/// health prepended at t=0; streams already opening full, entities the
/// arena does not know, and empty streams stay untouched.
#[test]
fn anchor_hp_streams_prepends_starting_health() {
    let sample = |time: f32, value: u32| wowsp_tauri_shared::HpSample { time, value };
    let arena = |entity_id: i32, max_health: u32| wowsp_tauri_shared::ArenaPlayer {
        entity_id,
        team_id: 0,
        player_id: 0,
        ship_params_id: 0,
        max_health,
        name: String::new(),
        is_bot: false,
        avatar_id: None,
        is_self: false,
    };
    // Damaged first reading at t=151.6 (the L-20 replay's own sub).
    let mut hp_map = std::collections::BTreeMap::from([
        (1, vec![sample(151.6, 9_168), sample(330.7, 8_541)]),
        // Already opens at the starting health: no duplicate anchor.
        (2, vec![sample(30.2, 69_650), sample(90.0, 66_000)]),
        // Not in the arena: nothing to anchor from.
        (3, vec![sample(120.0, 500)]),
        // Zero max_health entry is not a usable anchor.
        (4, vec![sample(80.0, 300)]),
    ]);
    let players = vec![arena(1, 14_000), arena(2, 69_650), arena(4, 0)];
    anchor_hp_streams(&mut hp_map, &players);
    let head = |eid: i32| hp_map.get(&eid).map(|s| (s[0].time, s[0].value));
    assert_eq!(
        head(1),
        Some((0.0, 14_000)),
        "damaged stream gains a full-health t=0 anchor"
    );
    assert_eq!(hp_map.get(&1).map(Vec::len), Some(3));
    assert_eq!(
        head(2),
        Some((30.2, 69_650)),
        "already-full stream is not duplicated"
    );
    assert_eq!(
        head(3),
        Some((120.0, 500)),
        "arena-unknown entity stays untouched"
    );
    assert_eq!(
        head(4),
        Some((80.0, 300)),
        "zero max-health entry anchors nothing"
    );
    // An empty stream stays empty (no-damage ships keep the frontend's
    // full-health initial label).
    let mut empty_map = std::collections::BTreeMap::from([(5, Vec::new())]);
    anchor_hp_streams(&mut empty_map, &[arena(5, 23_200)]);
    assert!(empty_map.get(&5).is_some_and(Vec::is_empty));
}

/// Synthetic replay: magic + 1 block + a tiny JSON descriptor. Verifies the
/// block-count format is parsed correctly (the bug the skeleton had).
#[test]
fn parses_synthetic_replay_header() {
    let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&REPLAY_MAGIC);
    bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(json.as_bytes());
    let extracted = extract_descriptor_json(&bytes).expect("must extract JSON");
    assert!(extracted.contains("15_NE_north"));
    let raw: serde_json::Value = serde_json::from_str(&extracted).unwrap();
    let meta = meta_from_raw("20250622_152405_x.wowsreplay".into(), raw);
    assert_eq!(meta.map_name.as_deref(), Some("15_NE_north"));
    assert_eq!(meta.map_id, Some(8));
    assert_eq!(meta.match_group.as_deref(), Some("pvp"));
    // dateTime now retains the full YYYYMMDD_HHMMSS from the filename.
    assert_eq!(meta.date_time.as_deref(), Some("20250622_152405"));
}

/// Datetime parser keeps the time-of-day segment and tolerates a date-only
/// filename (older clients / renamed files).
#[test]
fn datetime_parser_keeps_time_or_date() {
    assert_eq!(
        parse_datetime_from_filename("20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay")
            .as_deref(),
        Some("20250622_152405"),
    );
    assert_eq!(
        parse_datetime_from_filename("20250622_someother.wowsreplay").as_deref(),
        Some("20250622"),
    );
    assert!(parse_datetime_from_filename("replay.wowsreplay").is_none());
}

/// The lite projection counts players and finds the recorder's ship
/// (relation == 0) without retaining the roster or raw JSON.
#[test]
fn lite_from_raw_finds_own_ship() {
    let json = r#"{"matchGroup":"ranked","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[
            {"id":1,"name":"Alpha","relation":0,"shipId":4182828960},
            {"id":2,"name":"Bravo","relation":1,"shipId":4286591792},
            {"id":3,"name":"Enemy","relation":2,"shipId":4292851696}
        ]}"#;
    let raw: serde_json::Value = serde_json::from_str(json).unwrap();
    let lite = lite_from_raw(
        "20250622_152405_x.wowsreplay".into(),
        Some("20250622_152405".into()),
        raw,
    );
    assert_eq!(lite.match_group.as_deref(), Some("ranked"));
    assert_eq!(lite.map_name.as_deref(), Some("15_NE_north"));
    assert_eq!(lite.player_count, 3);
    assert_eq!(lite.own_ship_id, Some(4182828960));
    assert_eq!(lite.player_name.as_deref(), Some("Alpha"));
}

/// Unique temp file path for `lite_from_path` tests (this crate has no
/// tempfile dev-dependency): the system temp dir + the given base + a
/// per-process counter. The counter rides AFTER the base so a base that
/// opens with `YYYYMMDD_HHMMSS` still parses as the filename datetime.
/// Callers remove the file when done.
fn temp_replay_path(base: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("{base}_{n}.wowsreplay"))
}

/// The walk surfaces both clients' containers (`.wowsreplay` and the
/// Lesta `.korablireplay`) but never either client's live temp file.
#[test]
fn walk_replays_lists_both_containers_and_skips_temps() {
    let dir = std::env::temp_dir().join(format!(
        "wowsp-test-walk-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for name in [
        "20261001_024940_PRSB910-Kremlin_15_NE_north.wowsreplay",
        "20261001_031102_PRSB910-Kremlin_15_NE_north.korablireplay",
        "temp.wowsreplay",
        "temp.korablireplay",
        "tempArenaInfo.json",
        "notes.txt",
    ] {
        std::fs::write(dir.join(name), b"x").unwrap();
    }
    let mut out = Vec::new();
    walk_replays(&dir, &mut out);
    let mut names: Vec<_> = out
        .iter()
        .map(|e| e.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "20261001_024940_PRSB910-Kremlin_15_NE_north.wowsreplay".to_string(),
            "20261001_031102_PRSB910-Kremlin_15_NE_north.korablireplay".to_string(),
        ]
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// An omitted `limit` caps nothing: the scan lists EVERY replay in the
/// tree — root files and version-archive subfolder files alike. 205
/// root files + 1 archived = 206; the retired implicit 200-cap would
/// have dropped six of these entries after its mtime-desc truncation,
/// which is exactly how archived history used to vanish.
#[test]
fn scan_replays_meta_without_limit_keeps_version_archives() {
    let dir = std::env::temp_dir().join(format!(
        "wowsp-test-scan-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("14.5.0.0")).unwrap();
    for i in 0..205 {
        std::fs::write(dir.join(format!("20250101_{:06}_a.wowsreplay", i)), b"x").unwrap();
    }
    std::fs::write(
        dir.join("14.5.0.0")
            .join("20250622_152405_archived.wowsreplay"),
        b"x",
    )
    .unwrap();
    let (root, entries) = scan_replays_meta(Some(dir.to_string_lossy().into_owned()), None)
        .unwrap_or_else(|e| panic!("scan failed: {e}"));
    assert_eq!(root, dir);
    assert_eq!(entries.len(), 206);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Extension test is case-insensitive and covers both spellings.
#[test]
fn is_replay_extension_matches_both_clients() {
    assert!(is_replay_extension("wowsreplay"));
    assert!(is_replay_extension("korablireplay"));
    assert!(is_replay_extension("WoWsRePlay"));
    assert!(!is_replay_extension("json"));
    assert!(!is_replay_extension(""));
}

/// `lite_from_path` fills the summary fields from the FIRST block only:
/// the descriptor parses even though a fat (here: garbage) packet stream
/// follows, because the bounded header read never touches it.
#[test]
fn lite_from_path_reads_bounded_first_block() {
    let path = temp_replay_path("20250622_152405_lite");
    let json = r#"{"matchGroup":"ranked","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[
            {"id":1,"name":"Alpha","relation":0,"shipId":4182828960},
            {"id":2,"name":"Bravo","relation":1,"shipId":4286591792}
        ]}"#;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&REPLAY_MAGIC);
    bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(json.as_bytes());
    // Stand-in for the encrypted packet stream a real replay carries —
    // several MB in production, never read by the listing path.
    bytes.extend_from_slice(&[0u8; 4096]);
    std::fs::write(&path, &bytes).expect("write temp replay");
    let lite = lite_from_path(&path);
    let _ = std::fs::remove_file(&path);
    assert_eq!(lite.date_time.as_deref(), Some("20250622_152405"));
    assert_eq!(lite.match_group.as_deref(), Some("ranked"));
    assert_eq!(lite.map_name.as_deref(), Some("15_NE_north"));
    assert_eq!(lite.map_id, Some(8));
    assert_eq!(lite.player_count, 2);
    assert_eq!(lite.own_ship_id, Some(4182828960));
    // No `playerName` in this descriptor — the relation-0 roster name
    // stands in as the recorder's identity.
    assert_eq!(lite.player_name.as_deref(), Some("Alpha"));
    // A single-dir scan tags nothing: the owner is only known to the
    // all-clients scan (see the tagging test below).
    assert!(lite.install_path.is_none());
    assert!(lite.install_kind.is_none());
    assert!(lite.install_realm.is_none());
}

/// The recorder's nickname wins from the descriptor's own `playerName`
/// (the CN client fills it with the account name), and a blank value
/// falls back to the relation-0 roster entry — a header that carries
/// neither answers `None` instead of an empty identity.
#[test]
fn lite_from_raw_prefers_descriptor_player_name_with_roster_fallback() {
    let raw = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();
    let vehicles = r#""vehicles":[{"id":1,"name":"langyo","relation":0,"shipId":7}]"#;

    let named = lite_from_raw(
        "a.wowsreplay".into(),
        Some("20261008_003254".into()),
        raw(&format!(r#"{{"playerName":"神楽坂柚咲",{vehicles}}}"#)),
    );
    assert_eq!(named.player_name.as_deref(), Some("神楽坂柚咲"));

    let blank = lite_from_raw(
        "b.wowsreplay".into(),
        None,
        raw(&format!(r#"{{"playerName":"   ",{vehicles}}}"#)),
    );
    assert_eq!(blank.player_name.as_deref(), Some("langyo"));

    let headerless = lite_from_raw("c.wowsreplay".into(), None, raw(r#"{"matchGroup":"pvp"}"#));
    assert!(headerless.player_name.is_none());
    assert!(headerless.own_ship_id.is_none());
}

/// The all-clients scan walks every root it is handed and stamps each
/// entry with that root's owning install — kind + realm + path — while
/// files under an unowned root stay untagged (they belong to no client
/// to label or filter by). The newest-first mtime order and the
/// explicit limit apply across the whole set, not per root.
#[test]
fn scan_roots_meta_tags_entries_with_their_owning_install() {
    let dir = std::env::temp_dir().join(format!(
        "wowsp-test-all-roots-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let steam_replays = dir.join("steam").join("replays");
    let cn_replays = dir.join("cn360").join("replays");
    let loose = dir.join("loose");
    for root in [&steam_replays, &cn_replays, &loose] {
        std::fs::create_dir_all(root).unwrap();
    }
    // Write each file and PIN its mtime one day apart: the scan's
    // newest-first order (and the cap test below) keys on mtime, and a
    // CI runner's filesystem can stamp three rapid writes with the SAME
    // timestamp — the stable sort would then fall back to insertion
    // order and "newest survived the cap" would depend on write order.
    let write_stamped = |path: PathBuf, at: std::time::SystemTime| {
        std::fs::write(&path, b"not a replay").unwrap();
        // Write access, not the read-only `File::open` — Windows denies
        // setting the modified time through a read-only handle.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    };
    let day =
        |n: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000 + n * 86_400);
    write_stamped(steam_replays.join("20261001_100000_a.wowsreplay"), day(0));
    write_stamped(cn_replays.join("20261002_100000_b.wowsreplay"), day(1));
    write_stamped(loose.join("20261003_100000_c.wowsreplay"), day(2));

    let install = |kind: GameInstallKind, path: &std::path::Path, realm: &str| GameInstall {
        kind,
        path: path.to_string_lossy().into_owned(),
        realm: Some(realm.to_string()),
    };
    let roots = vec![
        (
            steam_replays.clone(),
            Some(install(GameInstallKind::Steam, &dir.join("steam"), "asia")),
        ),
        (
            cn_replays.clone(),
            Some(install(GameInstallKind::Cn360, &dir.join("cn360"), "cn")),
        ),
        (loose.clone(), None),
    ];
    let entries = scan_roots_meta(&roots, None);
    assert_eq!(entries.len(), 3, "every root contributes its files");
    let by_name = |needle: &str| {
        entries
            .iter()
            .find(|e| e.path.contains(needle))
            .unwrap_or_else(|| panic!("missing {needle}"))
    };
    let steam = by_name("20261001_100000_a");
    assert_eq!(steam.install_realm.as_deref(), Some("asia"));
    assert_eq!(steam.install_kind, Some(GameInstallKind::Steam));
    assert_eq!(
        steam.install_path.as_deref(),
        Some(dir.join("steam").to_string_lossy().as_ref())
    );
    let cn = by_name("20261002_100000_b");
    assert_eq!(cn.install_realm.as_deref(), Some("cn"));
    assert_eq!(cn.install_kind, Some(GameInstallKind::Cn360));
    let untagged = by_name("20261003_100000_c");
    assert!(untagged.install_path.is_none());
    assert!(untagged.install_kind.is_none());
    assert!(untagged.install_realm.is_none());

    // The cap applies to the whole set AFTER the newest-first sort, so a
    // capped scan keeps the freshest files (the archived-history trap the
    // single-root scan's contract calls out) — and 0 answers nothing,
    // exactly like the single-root scan's `.take(0)`.
    let capped = scan_roots_meta(&roots, Some(1));
    assert_eq!(capped.len(), 1);
    assert!(
        capped[0].path.contains("20261003_100000_c"),
        "the newest file survived the cap: {}",
        capped[0].path
    );
    assert!(scan_roots_meta(&roots, Some(0)).is_empty());
    // Identical roots listed twice must not duplicate entries.
    let doubled = {
        let mut both = roots.clone();
        both.push(roots[0].clone());
        scan_roots_meta(&both, None)
    };
    assert_eq!(doubled.len(), 3, "one file, one entry");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A file truncated mid-prologue (4 bytes) falls back to the path +
/// filename-datetime lite entry — listed, never a panic.
#[test]
fn lite_from_path_falls_back_on_truncated_file() {
    let path = temp_replay_path("20250701_101010_trunc");
    std::fs::write(&path, REPLAY_MAGIC).expect("write truncated replay");
    let lite = lite_from_path(&path);
    let _ = std::fs::remove_file(&path);
    assert_eq!(lite.path, path.to_string_lossy());
    assert_eq!(lite.date_time.as_deref(), Some("20250701_101010"));
    assert_eq!(lite.match_group, None);
    assert_eq!(lite.map_name, None);
    assert_eq!(lite.map_id, None);
    assert_eq!(lite.bot_count, 0);
    assert_eq!(lite.player_count, 0);
    assert_eq!(lite.own_ship_id, None);
}

/// Unique temp path with the Lesta `.korablireplay` extension (the same
/// per-process counter scheme as [`temp_replay_path`]; the filename
/// datetime parser reads the base name either way).
fn temp_korabli_path(base: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("{base}_{n}.korablireplay"))
}

/// A synthetic Lesta `.korablireplay` modeled on the real container: the
/// WG framing with the Lesta 4-block payload set — [0] descriptor
/// (modeled on the real schema, NO `vehicles`), [1] roster JSON whose
/// `playersPublicInfo` positional arrays mirror the verified positions
/// ([0] id, [1] name, [2] clanDBID, [3] clan tag, [6] team, [7] shipId,
/// [9] realm, [15] max HP), [2] recorder marker (parameterized so the
/// fallback test can corrupt it), [3] checksum hex. The roster mixes all
/// four relation cases: the recorder, a same-team human, an enemy
/// `:Bot:` and an enemy `IDS_OP_X` scripted unit.
fn write_synthetic_lesta_replay(path: &std::path::Path, recorder_marker: &str) {
    let descriptor = r#"{"matchGroup":"cooperative","mapDisplayName":"28_naval_mission",
            "mapId":17,"mapName":"spaces/28_naval_mission","scenario":"domination_sandbox_3point_alt_5-6_coop",
            "eventType":"","gameType":"CooperativeBattle","clientVersionFromExe":"26,10,0,8867689",
            "playerName":"langyo","playerVehicle":"PRSB505-Oktyabrskaya-Revolutsiya"}"#;
    let roster = r#"{"accountDBID":1000000001,"arenaUniqueID":1234567890123456,
            "keepUntilTime":0,"playersPublicInfo":{
            "1000000001":[1000000001,"langyo",0,"",0,-1,1,3340711376,0,"RU",[],0,0,-1,0,42500],
            "88240732":[88240732,"karasik60",0,"",0,-1,1,3765352400,0,"RU",[],0,0,-1,0,29400],
            "-268475967":[-268475967,":Bot:",0,"",0,-1,0,4184815568,0,"RU",[],0,0,-1,0,41200],
            "-624526534":[-624526534,"IDS_OP_X",0,"",0,-1,0,4179539408,0,"RU",[],0,0,-1,0,65400]}}"#;
    let checksum = "53BB63FBD4C37D37CF945F0BD78B1EAC";
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&REPLAY_MAGIC);
    bytes.extend_from_slice(&4u32.to_le_bytes()); // Lesta writes 4 blocks
    for block in [descriptor, roster, recorder_marker, checksum] {
        bytes.extend_from_slice(&(block.len() as u32).to_le_bytes());
        bytes.extend_from_slice(block.as_bytes());
    }
    // Stand-in for the encrypted packet stream (identical WG scheme).
    bytes.extend_from_slice(&[0u8; 64]);
    std::fs::write(path, &bytes).expect("write synthetic korablireplay");
}

/// A Lesta descriptor (no `vehicles`) synthesizes the roster from
/// block[1]'s `playersPublicInfo` with block[2] pinning the recorder:
/// relations come out exactly 0/1/2, and the existing bot/scripted
/// classifiers apply unchanged (Lesta kept WG's bot markers).
#[test]
fn lesta_header_synthesizes_roster_from_blocks() {
    let path = temp_korabli_path("20261001_025958_lesta");
    write_synthetic_lesta_replay(&path, "1000000001.1234567890123456");
    // The same internals read_replay_header runs.
    let bytes = std::fs::read(&path).unwrap();
    let json = extract_descriptor_json(&bytes).expect("descriptor block");
    let raw: serde_json::Value = serde_json::from_str(&json).unwrap();
    let meta = meta_from_raw(path.to_string_lossy().into_owned(), raw);
    let _ = std::fs::remove_file(&path);
    assert_eq!(meta.match_group.as_deref(), Some("cooperative"));
    assert_eq!(meta.map_name.as_deref(), Some("28_naval_mission"));
    assert_eq!(meta.vehicles.len(), 4);
    let by_name = |n: &str| meta.vehicles.iter().find(|v| v.name == n).unwrap();
    // block[2] pins the recorder (team 1 here); its team are allies.
    assert_eq!(by_name("langyo").relation, 0);
    assert_eq!(by_name("karasik60").relation, 1);
    assert_eq!(by_name(":Bot:").relation, 2);
    assert_eq!(by_name("IDS_OP_X").relation, 2);
    assert_eq!(by_name("langyo").ship_id, 3340711376);
    assert_eq!(by_name("IDS_OP_X").id, -624526534);
    // `:Bot:` and `IDS_OP_X` are both bot nicknames; only the latter is
    // a scripted unit.
    assert_eq!(meta.bot_count, 2);
    assert_eq!(meta.scripted_unit_count, 1);
}

/// The lite projection over a Lesta container carries the full summary:
/// descriptor fields plus the synthesized roster's counts and recorder.
#[test]
fn lite_from_path_parses_synthetic_lesta_replay() {
    let path = temp_korabli_path("20261001_025958_lesta_lite");
    write_synthetic_lesta_replay(&path, "1000000001.1234567890123456");
    let lite = lite_from_path(&path);
    let _ = std::fs::remove_file(&path);
    assert_eq!(lite.date_time.as_deref(), Some("20261001_025958"));
    assert_eq!(lite.match_group.as_deref(), Some("cooperative"));
    assert_eq!(lite.map_name.as_deref(), Some("28_naval_mission"));
    assert_eq!(
        lite.scenario.as_deref(),
        Some("domination_sandbox_3point_alt_5-6_coop")
    );
    assert_eq!(lite.own_ship_id, Some(3340711376));
    assert_eq!(lite.player_name.as_deref(), Some("langyo"));
    // The `IDS_OP_X` scripted unit sits out; the `:Bot:` fill counts.
    assert_eq!(lite.player_count, 3);
    assert_eq!(lite.bot_count, 2);
    assert_eq!(lite.scripted_unit_count, 1);
}

/// An unparseable block[2] marker falls back to matching the
/// descriptor's `playerName` against the roster names — the recorder
/// still resolves (and with no name match either, the first positive-id
/// entry would).
#[test]
fn lesta_roster_falls_back_to_player_name_when_marker_unparseable() {
    let path = temp_korabli_path("20261001_025958_lesta_fb");
    write_synthetic_lesta_replay(&path, "not-an-id");
    let lite = lite_from_path(&path);
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        lite.own_ship_id,
        Some(3340711376),
        "playerName langyo pins the recorder when the marker fails"
    );
    assert_eq!(lite.player_name.as_deref(), Some("langyo"));
    assert_eq!(lite.player_count, 3);
}

/// A Lesta container missing its roster block entirely (fewer blocks
/// than the marker read needs) degrades to the descriptor-only entry —
/// never a failed parse.
#[test]
fn lesta_roster_degrades_to_empty_when_blocks_missing() {
    let path = temp_korabli_path("20261001_025958_lesta_thin");
    let descriptor =
        r#"{"matchGroup":"cooperative","mapDisplayName":"28_naval_mission","mapId":17}"#;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&REPLAY_MAGIC);
    bytes.extend_from_slice(&1u32.to_le_bytes()); // descriptor only
    bytes.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
    bytes.extend_from_slice(descriptor.as_bytes());
    std::fs::write(&path, &bytes).expect("write thin korablireplay");
    let lite = lite_from_path(&path);
    let _ = std::fs::remove_file(&path);
    assert_eq!(lite.match_group.as_deref(), Some("cooperative"));
    assert_eq!(lite.map_name.as_deref(), Some("28_naval_mission"));
    assert_eq!(lite.player_count, 0, "no roster block — empty roster");
    assert_eq!(lite.own_ship_id, None);
}

/// The newest finished `.korablireplay` under `dir` (`None` when the
/// directory is missing or holds no finished container).
fn newest_lesta_replay_in(dir: &str) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for ent in fs::read_dir(dir).ok()?.flatten() {
        let path = ent.path();
        let is_container = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(is_replay_extension)
            && path.file_name().and_then(|n| n.to_str()) != Some("temp.korablireplay");
        if !is_container {
            continue;
        }
        if let Ok(mtime) = ent.metadata().and_then(|m| m.modified()) {
            if newest.as_ref().is_none_or(|(best, _)| mtime > *best) {
                newest = Some((mtime, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

/// Ground-truth validation of the Lesta container crack against the
/// real replays on this machine: takes the newest
/// `D:\WoWS_Korabli\replays\*.korablireplay` (or the file pinned by
/// `WOWSP_TEST_REPLAY`) and runs BOTH the header-parse internals
/// (roster synthesis from `playersPublicInfo`) and the full
/// packet-stream decode (Blowfish + zlib + frames — the unmodified WG
/// framing with the Lesta method/position tables). Skips when no Lesta
/// replay is found. Run locally with
/// `cargo test -p wowsp_tauri --lib -- --ignored lesta`.
#[test]
#[ignore = "needs the real Lesta replays on this machine"]
fn decodes_the_real_lesta_replays_on_this_machine() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY")
        .ok()
        .map(PathBuf::from)
        .or_else(|| newest_lesta_replay_in(r"D:\WoWS_Korabli\replays"))
    else {
        return; // no pinned file, no Lesta client or empty dir — skip
    };
    // Header internals (what read_replay_header runs).
    let bytes = fs::read(&path).unwrap();
    let json = extract_descriptor_json(&bytes).expect("descriptor JSON");
    let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor parses");
    let meta = meta_from_raw(path.to_string_lossy().into_owned(), raw);
    assert!(
        meta.match_group.as_deref().is_some_and(|m| !m.is_empty()),
        "matchGroup must parse"
    );
    assert!(
        meta.map_name.as_deref().is_some_and(|m| !m.is_empty()),
        "map name must parse"
    );
    assert!(
        !meta.vehicles.is_empty(),
        "roster must synthesize from playersPublicInfo"
    );
    let own = meta
        .vehicles
        .iter()
        .find(|v| v.relation == 0)
        .expect("recorder entry (relation 0)");
    assert!(own.ship_id > 0, "recorder's shipId must resolve");
    assert!(meta.vehicles.len() >= 2, "player_count >= 2");
    eprintln!(
        "[lesta] {}  map={}  {} players  own={} ({}), bots={} scripted={}",
        path.display(),
        meta.map_name.clone().unwrap_or_default(),
        meta.vehicles.len(),
        own.name,
        own.ship_id,
        meta.bot_count,
        meta.scripted_unit_count
    );
    // Full packet path (what read_replay_positions runs): decrypt +
    // inflate + frames → non-empty trajectories. The roster's shipIds
    // ride along as the entity→player join candidates.
    let stream = packet_stream_after_blocks(&bytes).expect("packet stream after 4 blocks");
    let candidates: std::collections::HashSet<u32> =
        meta.vehicles.iter().map(|v| v.ship_id as u32).collect();
    let version = meta
        .raw
        .get("clientVersionFromExe")
        .and_then(|x| x.as_str());
    let decoded =
        super::super::packets::decode_replay(stream, &candidates, version, true).expect("decode");
    // The 26.10 regression this pins: the recorder's own ship rides the
    // 0x2e self stream — when that arm is missing the own trajectory
    // stays empty and the playback view shows no self ship ("看不到自己").
    let own_eid = decoded.recorder_ship.expect("recorder ship must resolve");
    let own_samples = decoded
        .positions
        .get(&own_eid)
        .map(|v| v.len())
        .unwrap_or(0);
    assert!(
        own_samples > 0,
        "recorder's own ship must carry position samples (roster shipId {})",
        own.ship_id
    );
    eprintln!("[lesta] own ship entity {own_eid}: {own_samples} samples");
    let grouped = group_by_entity(decoded);
    assert!(
        !grouped.trajectories.is_empty(),
        "trajectories must decode from the packet stream"
    );
    let positioned = grouped
        .trajectories
        .iter()
        .filter(|t| !t.samples.is_empty())
        .count();
    assert!(positioned > 0, "at least one entity must have positions");
    eprintln!(
        "[lesta] {} trajectories ({} with position samples)",
        grouped.trajectories.len(),
        positioned
    );
}

/// Custom-room bot rosters (`:Name:` nicknames) are counted; plain PvP
/// rosters and nicknames that merely CONTAIN a colon are not. Shape mirrors
/// a real training-room descriptor (matchGroup stays "pvp" there — the
/// frontend relabels it from botCount + the tournament scenario).
#[test]
fn bot_count_fills_from_colon_nicknames() {
    let room = r#"{"matchGroup":"pvp","scenario":"domination_tournament_3point","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":":Tirpitz:","relation":1,"shipId":2},
            {"id":3,"name":":Pohl:","relation":1,"shipId":2},
            {"id":4,"name":":Sturdee:","relation":1,"shipId":2},
            {"id":5,"name":":Yegorov:","relation":2,"shipId":3},
            {"id":6,"name":":Bouvet:","relation":2,"shipId":3},
            {"id":7,"name":":Revel:","relation":2,"shipId":3}
        ]}"#;
    let raw: serde_json::Value = serde_json::from_str(room).unwrap();
    let meta = meta_from_raw("x.wowsreplay".into(), raw.clone());
    let lite = lite_from_raw("x.wowsreplay".into(), None, raw);
    assert_eq!(meta.bot_count, 6);
    assert_eq!(lite.bot_count, 6);
    assert_eq!(lite.player_count, 7);

    let plain = r#"{"matchGroup":"pvp","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"we:ird","relation":2,"shipId":2},
            {"id":3,"name":":","relation":2,"shipId":2}
        ]}"#;
    let raw: serde_json::Value = serde_json::from_str(plain).unwrap();
    let meta = meta_from_raw("x.wowsreplay".into(), raw);
    assert_eq!(meta.bot_count, 0);
}

/// Operation rosters mix scripted units (`IDS_*` keys, `#Name` scenario
/// style) with `:Name:` filler bots — shape from the live ASIA escort-op
/// arena (`matchGroup: "pve"`, `LOW_LVL_OPERATION_1_LVL_2`). Both halves
/// are counted so the frontend classifier can tell the operation from
/// plain co-op, whose rosters carry `:Name:` bots only.
#[test]
fn scripted_unit_count_splits_operation_rosters() {
    let op = r##"{"matchGroup":"pve","scenario":"LOW_LVL_OPERATION_1_LVL_2","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_15_ALLY_FLAGSHIP","relation":1,"shipId":2},
            {"id":3,"name":"IDS_OP_15_DUMMY_01","relation":1,"shipId":2},
            {"id":4,"name":"#Krebs","relation":2,"shipId":3},
            {"id":5,"name":":Revel:","relation":2,"shipId":3},
            {"id":6,"name":"#Aylard","relation":2,"shipId":3}
        ]}"##;
    let raw: serde_json::Value = serde_json::from_str(op).unwrap();
    let meta = meta_from_raw("x.wowsreplay".into(), raw.clone());
    let lite = lite_from_raw("x.wowsreplay".into(), None, raw);
    assert_eq!(meta.bot_count, 5);
    assert_eq!(meta.scripted_unit_count, 4);
    assert_eq!(lite.bot_count, 5);
    assert_eq!(lite.scripted_unit_count, 4);
    // Listed players only: the human recorder plus the `:Revel:` co-op
    // fill; the four scripted units sit out.
    assert_eq!(lite.player_count, 2);

    // Plain co-op: `:Name:` bots only — scripted count stays zero.
    let coop = r#"{"matchGroup":"pve","scenario":"domination_3point","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":":Yumashev:","relation":2,"shipId":3},
            {"id":3,"name":":WGR_bot:","relation":2,"shipId":3}
        ]}"#;
    let raw: serde_json::Value = serde_json::from_str(coop).unwrap();
    let meta = meta_from_raw("x.wowsreplay".into(), raw);
    assert_eq!(meta.bot_count, 2);
    assert_eq!(meta.scripted_unit_count, 0);
}

/// is_operation_battle — the Rust mirror of the frontend's classifier
/// (utils/modeColors.ts `isOperationBattle`): the descriptor
/// fingerprints decide, the tutorial family stays excluded, and the
/// roster scan is the last resort for arena files whose descriptor
/// carries no scenario. The live scripted-unit filtering (arena_info's
/// `note_arena_seen`) keys on it, so the shapes here mirror the
/// frontend's rosterSides tests.
#[test]
fn operation_classifier_mirrors_the_frontend() {
    let roster = |json: &str| {
        let raw: serde_json::Value = serde_json::from_str(json).unwrap();
        meta_from_raw("x.wowsreplay".into(), raw).vehicles
    };
    // The story op (PCVO011_OP_10 Chumphon) — the scenario fingerprint
    // alone decides.
    let story = roster(
        r#"{"matchGroup":"pve","scenario":"PCVO011_OP_10_s10_USS_CL","vehicles":[
            {"id":1,"name":"ShigureKira","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_10_09_GAMBLE","relation":1,"shipId":2},
            {"id":3,"name":"IDS_OP_10_EN_0101","relation":2,"shipId":3}
        ]}"#,
    );
    assert!(is_operation_battle(Some("pve"), None, None, &story));
    assert!(is_operation_battle(
        None,
        None,
        Some("PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL"),
        &story
    ));
    // The tutorial family stays excluded — its scripted units field as
    // real team rows, so the live surfaces keep them listed.
    let tutorial = roster(
        r#"{"matchGroup":"pve","scenario":"LOW_LVL_OPERATION_3_LVL_5A","vehicles":[
            {"id":1,"name":"ShigureKira","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_17_ALLY_FLAGSHIP","relation":1,"shipId":2},
            {"id":3,"name":"IDS_EN_01","relation":2,"shipId":3}
        ]}"#,
    );
    assert!(!is_operation_battle(
        Some("pve"),
        Some("LOW_LVL_OPERATION_3_LVL_5A"),
        None,
        &tutorial
    ));
    assert!(!is_operation_battle(
        Some("pve"),
        Some("first_battle"),
        None,
        &tutorial
    ));
    let escort = roster(
        r#"{"matchGroup":"pve","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_15_DUMMY_01","relation":1,"shipId":2}
        ]}"#,
    );
    assert!(!is_operation_battle(Some("pve"), None, None, &escort));
    // The roster scan is the last resort: pve + IDS_OP_* names with no
    // scenario fingerprint anywhere.
    let bare = roster(
        r#"{"matchGroup":"pve","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":"IDS_OP_09_FLAGMAN_NAME","relation":1,"shipId":2}
        ]}"#,
    );
    assert!(is_operation_battle(Some("pve"), None, None, &bare));
    // PvP / plain co-op never classify as operations.
    let coop = roster(
        r#"{"matchGroup":"pve","scenario":"domination_3point","vehicles":[
            {"id":1,"name":"langyo","relation":0,"shipId":1},
            {"id":2,"name":":Yumashev:","relation":2,"shipId":3}
        ]}"#,
    );
    assert!(!is_operation_battle(Some("pvp"), None, None, &coop));
    assert!(!is_operation_battle(
        Some("pve"),
        Some("domination_3point"),
        None,
        &coop
    ));
}

/// If a real replay is available on this machine, parse it end-to-end.
#[test]
fn parses_real_replay_if_present() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return; // no real replay on this machine — skip
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let json =
        extract_descriptor_json(&bytes).unwrap_or_else(|| panic!("no descriptor JSON in {path}"));
    let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor must be JSON");
    let meta = meta_from_raw(path.clone(), raw);
    assert!(!meta.vehicles.is_empty(), "roster must not be empty");
    assert!(meta.map_name.is_some(), "mapDisplayName must be present");
    eprintln!(
        "[real-replay] {}  map={}, {} players",
        path,
        meta.map_name.unwrap(),
        meta.vehicles.len()
    );
}

/// Diagnostic: dump a real replay's header + trajectories to JSON, used to
/// feed the mock backend (`scripts/mock/fixtures/replay_dump.json`) so the
/// holographic map can render a real match in a browser. Run with
/// `WOWSP_TEST_REPLAY=<path> [WOWSP_DUMP_OUT=out.json]`.
#[tokio::test]
async fn dump_replay_json() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let meta = read_replay_header(path.clone()).await.expect("header");
    let stream = read_replay_positions(path.clone())
        .await
        .expect("positions");
    // Raw per-entity property timelines for offline analysis (score
    // hunting, property-index identification).
    let bytes = std::fs::read(&path).unwrap();
    let pstream = packet_stream_after_blocks(&bytes).expect("packet stream");
    let mut candidates = std::collections::HashSet::new();
    let mut cver: Option<String> = None;
    if let Some(json) = extract_descriptor_json(&bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            cver = raw
                .get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            if let Some(arr) = raw.get("vehicles").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(id) = v.get("shipId").and_then(|x| x.as_u64()) {
                        candidates.insert(id as u32);
                    }
                }
            }
        }
    }
    let lesta = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(crate::commands::game_client::is_lesta_replay_extension);
    let decoded =
        crate::commands::packets::decode_replay(pstream, &candidates, cver.as_deref(), lesta)
            .expect("decode");
    // (entityType, methodId) histogram with arg-length stats.
    let mut histo: std::collections::BTreeMap<(i16, i32), (u32, u32, f32, f32)> =
        std::collections::BTreeMap::new();
    for (t, eid, mid, alen) in &decoded.method_histogram {
        let et = decoded.kinds.get(eid).map(|k| k.entity_type).unwrap_or(-1);
        let e = histo.entry((et, *mid)).or_insert((0, *alen, *t, *t));
        e.0 += 1;
        e.1 = e.1.max(*alen);
        e.3 = e.3.max(*t);
    }
    let mut props = std::collections::BTreeMap::new();
    for (eid, changes) in &decoded.properties {
        props.insert(
            eid.to_string(),
            changes
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "t": c.time, "p": c.property_index, "v": c.value, "s": c.size,
                    })
                })
                .collect::<Vec<_>>(),
        );
    }
    let histo_json: serde_json::Value = histo
            .iter()
            .map(|((et, mid), (n, maxlen, t0, t1))| {
                // raw arg samples for this (entityType, method) — the args
                // are per-entity, so collect from any sampled entity.
                let mut samples: Vec<String> = Vec::new();
                for ((eid2, mid2), blobs) in &decoded.method_arg_samples {
                    if *mid2 != *mid { continue; }
                    let et2 = decoded.kinds.get(eid2).map(|k| k.entity_type).unwrap_or(-1);
                    if et2 != *et { continue; }
                    for b in blobs {
                        samples.push(b.iter().map(|x| format!("{x:02x}")).collect::<String>());
                    }
                    if samples.len() >= 4 { break; }
                }
                serde_json::json!({ "et": et, "mid": mid, "n": n, "maxLen": maxlen, "t0": t0, "t1": t1, "args": samples })
            })
            .collect::<Vec<_>>()
            .into();
    let out = serde_json::json!({
        "properties": props,
        "methods": histo_json,
        "meta": meta,
        "trajectories": stream.trajectories,
        "shellLaunches": stream.shell_launches,
        "explosions": stream.explosions,
        "torpedoes": stream.torpedoes,
        "torpedoSteers": stream.torpedo_steers,
        "weaponLocks": stream.weapon_locks,
        "battleResults": stream.battle_results,
        "version": stream.version,
        "mapName": stream.map_name,
        "camera": stream.camera,
        "netStats": stream.net_stats,
        "leaves": stream.leaves,
        "cameraModes": stream.camera_modes,
        "diagnostics": stream.diagnostics,
        "squadronCreates": stream.squadron_creates,
        "squadronPlanes": stream.squadron_planes,
        "minimapSquadronAdds": stream.minimap_squadron_adds,
        "minimapSquadronMoves": stream.minimap_squadron_moves,
        "minimapSquadronRemoves": stream.minimap_squadron_removes,
        "wards": stream.wards,
        "wardRemoves": stream.ward_removes,
        "shotKills": stream.shot_kills,
        "damageStats": stream.damage_stats,
        "chatMessages": stream.chat_messages,
        "achievements": stream.achievements,
        "arenaPlayers": stream.arena_players,
        "weatherTransitions": stream.weather_transitions,
        "weatherNotifications": stream.weather_notifications,
        "selfTeam": stream.self_team,
    });
    let out_path =
        std::env::var("WOWSP_DUMP_OUT").unwrap_or_else(|_| "replay_dump.json".to_string());
    std::fs::write(&out_path, serde_json::to_string(&out).unwrap()).unwrap();
    eprintln!("dumped to {out_path}");
}

/// The live temp container is legitimately read mid-write: every state
/// before the game has flushed a complete header + packet region must
/// yield the EMPTY snapshot, never an error — the self view stays on its
/// syncing state and retries on the next size change. Pinned shapes:
/// nothing on disk, magic only, a declared-but-missing block table, a
/// complete header over a zero-filled packet region.
#[test]
fn live_snapshot_tolerates_midwrite_containers() {
    let assert_empty = |bytes: &[u8]| {
        let snap = live_snapshot_from_bytes("temp.wowsreplay", bytes);
        assert!(snap.trajectories.is_empty());
        assert!(snap.shot_kills.is_empty());
        assert!(snap.damage_stats.is_empty());
        assert!(snap.battle_results.is_none());
    };
    // The file exists but the game has not written a byte yet (or the
    // next battle just truncated it).
    assert_empty(&[]);
    // Magic flushed, block table not.
    assert_empty(&REPLAY_MAGIC);
    let mut count_only = REPLAY_MAGIC.to_vec();
    count_only.extend_from_slice(&3u32.to_le_bytes());
    assert_empty(&count_only);
    // Block count + a declared block length whose payload has not
    // landed (the declaration runs past EOF).
    let mut declared = REPLAY_MAGIC.to_vec();
    declared.extend_from_slice(&1u32.to_le_bytes());
    declared.extend_from_slice(&64u32.to_le_bytes());
    declared.extend_from_slice(b"{\"a\"");
    assert_empty(&declared);
    // Header complete (one small JSON block) but the packet region is
    // still pre-allocated zero fill.
    let mut zero_fill = REPLAY_MAGIC.to_vec();
    zero_fill.extend_from_slice(&1u32.to_le_bytes());
    zero_fill.extend_from_slice(&2u32.to_le_bytes());
    zero_fill.extend_from_slice(b"{}");
    zero_fill.extend_from_slice(&[0u8; 4096]);
    assert_empty(&zero_fill);
}

/// A container whose header walks cleanly but carries no frames yet
/// decodes to the empty snapshot — through the CLEAN path, not the
/// downgrade: the strict packet layer accepts the same bytes, which
/// pins the claim the helper's empty result makes.
#[test]
fn live_snapshot_reads_header_only_container() {
    let mut bytes = REPLAY_MAGIC.to_vec();
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(b"{}");
    let stream = packet_stream_after_blocks(&bytes).expect("header walks");
    assert!(
        super::super::packets::decode_replay_partial(
            stream,
            &std::collections::HashSet::new(),
            None,
            false
        )
        .is_ok(),
        "an empty packet region must decode cleanly"
    );
    assert!(
        live_snapshot_from_bytes("temp.wowsreplay", &bytes)
            .trajectories
            .is_empty()
    );
}

/// The tolerant live helper must not soften the STRICT reader: the same
/// mid-write shape that yields an empty live snapshot is a hard error on
/// the finished-replay decode — a completed replay that fails to parse
/// must surface, never read as "still being written".
#[test]
fn strict_decode_keeps_hard_error_for_zero_fill() {
    let mut zero_fill = REPLAY_MAGIC.to_vec();
    zero_fill.extend_from_slice(&1u32.to_le_bytes());
    zero_fill.extend_from_slice(&2u32.to_le_bytes());
    zero_fill.extend_from_slice(b"{}");
    zero_fill.extend_from_slice(&[0u8; 4096]);
    let stream = packet_stream_after_blocks(&zero_fill).expect("header walks");
    assert!(
        super::super::packets::decode_replay(
            stream,
            &std::collections::HashSet::new(),
            None,
            false
        )
        .is_err(),
        "strict decode must reject a zero-filled packet region"
    );
    assert!(
        live_snapshot_from_bytes("temp.wowsreplay", &zero_fill)
            .trajectories
            .is_empty(),
        "the live path keeps its empty-snapshot downgrade"
    );
}

/// Diagnostic: serialize the REAL IPC payload (serde_json over the whole
/// ReplayStream, exactly what Tauri's IPC codec emits) for a real replay,
/// asserting the weather timelines survive the wire. Run with
/// `WOWSP_TEST_REPLAY=path/to/replay.wowsreplay`.
#[tokio::test]
async fn dump_replay_stream_ipc_json() {
    let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
        return;
    };
    let stream = read_replay_positions(path.clone()).await.expect("stream");
    let json = serde_json::to_string(&stream).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&json).expect("reparse");
    let tr = v.get("weatherTransitions").and_then(|x| x.as_array());
    let no = v.get("weatherNotifications").and_then(|x| x.as_array());
    eprintln!(
        "IPC json: weatherTransitions={} weatherNotifications={} (snake_case leak: {})",
        tr.map_or(0, |a| a.len()),
        no.map_or(0, |a| a.len()),
        v.get("weather_transitions").is_some()
    );
    if let Some(a) = tr {
        for t in a {
            eprintln!("  tr: {}", serde_json::to_string(t).unwrap_or_default());
        }
    }
    // The keys must exist on the wire (camelCase, no snake_case twin) for
    // ANY replay; the non-empty check only holds for weather matches —
    // point WOWSP_TEST_REPLAY at a cyclone/storm replay to see data.
    assert!(tr.is_some(), "weatherTransitions key missing on the wire");
    assert!(no.is_some(), "weatherNotifications key missing on the wire");
    assert!(
        !v.get("weather_transitions").is_some(),
        "snake_case field leaked onto the wire"
    );
}
