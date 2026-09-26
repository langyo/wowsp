use super::*;

/// The exact game rect the anchors below were drawn against.
fn game_rect() -> Rect {
    Rect {
        x: -1280,
        y: 216,
        width: 2560,
        height: 1440,
    }
}

fn manual_anchor(battle: i64, rect: Rect) -> ManualAnchor {
    ManualAnchor {
        battle,
        game_rect: rect,
        rect: Rect {
            x: 640,
            y: 300,
            width: 1200,
            height: 620,
        },
        team_sizes: (7, 7),
    }
}

/// DWM frame-bounds jitter (±1–4 px, no real move) must NOT expire a
/// manual anchor the user just drew — the old exact-equality check died
/// to it silently.
#[test]
fn manual_anchor_survives_dwm_jitter() {
    let m = manual_anchor(42, game_rect());
    for (dx, dy) in [(0, 1), (2, -2), (-4, 0), (3, 3)] {
        let mut jittered = game_rect();
        jittered.x += dx;
        jittered.y += dy;
        assert!(
            matches!(
                manual_anchor_check(Some(&m), 42, Some(jittered)),
                ManualAnchorCheck::Live(_, _)
            ),
            "jitter ({dx},{dy}) must keep the anchor live"
        );
    }
}

#[test]
fn manual_anchor_expires_on_real_moves_and_new_battles() {
    let m = manual_anchor(42, game_rect());
    // A real move (beyond the tolerance) and a resize both expire.
    let mut moved = game_rect();
    moved.x += 40;
    assert!(matches!(
        manual_anchor_check(Some(&m), 42, Some(moved)),
        ManualAnchorCheck::Stale
    ));
    let mut resized = game_rect();
    resized.width -= 120;
    assert!(matches!(
        manual_anchor_check(Some(&m), 42, Some(resized)),
        ManualAnchorCheck::Stale
    ));
    // New battle expires regardless of the rect.
    assert!(matches!(
        manual_anchor_check(Some(&m), 43, Some(game_rect())),
        ManualAnchorCheck::Stale
    ));
    // Nothing stored / no rect this tick stay inert (never stale).
    assert!(matches!(
        manual_anchor_check(None, 42, Some(game_rect())),
        ManualAnchorCheck::Inert
    ));
    assert!(matches!(
        manual_anchor_check(Some(&m), 42, None),
        ManualAnchorCheck::Inert
    ));
}

/// Pin validity mirrors the manual anchor's: jitter keeps it, a real
/// move or a new battle voids it (re-arming the Searching report).
#[test]
fn pin_validity_uses_the_jitter_tolerance() {
    let r = game_rect();
    let mut jitter = r;
    jitter.y -= 3;
    assert!(pin_matches(7, &r, true, 7, Some(jitter)));
    let mut moved = r;
    moved.x -= 12;
    assert!(!pin_matches(7, &r, true, 7, Some(moved)));
    assert!(!pin_matches(7, &r, true, 8, Some(r)));
    assert!(!pin_matches(7, &r, false, 7, Some(r)));
    assert!(!pin_matches(7, &r, true, 7, None));
}

/// Hand-built anchor for the recognition catch-up / transplant tests:
/// only the fields those decisions read are varied.
fn anchor_with_players(
    rows: usize,
    detected: bool,
    players: Option<Vec<Option<String>>>,
    pending: bool,
) -> OverlayAnchor {
    OverlayAnchor {
        game_rect: Rect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        },
        overlay_rect: Rect {
            x: 100,
            y: 100,
            width: 1200,
            height: 500,
        },
        roster_rect: Rect {
            x: 150,
            y: 24,
            width: 900,
            height: 400,
        },
        row_centers: vec![50; rows],
        team_split: 0.5,
        table_detected: detected,
        row_players: players,
        row_alive: None,
        row_players_pending: pending,
        stale: false,
        roster_mode: String::new(),
    }
}

#[test]
fn mapping_untrusted_needs_at_least_one_match() {
    // Absent payload (recognition off / pipeline bailed) and an all-None
    // read (text seen, nothing matched) are both "no trusted mapping";
    // one matched row is enough to trust it.
    assert!(mapping_untrusted(&None));
    assert!(mapping_untrusted(&Some(vec![None, None])));
    assert!(!mapping_untrusted(&Some(vec![Some("Alpha".into()), None])));
}

/// Anchor with BOTH a name mapping and an alive vector — the shape
/// `compute_anchor` now produces and `tab_order_from_anchor` consumes.
fn anchor_with_state(
    rows: usize,
    players: Option<Vec<Option<String>>>,
    alive: Option<Vec<bool>>,
) -> OverlayAnchor {
    let mut a = anchor_with_players(rows, true, players, false);
    a.row_alive = alive;
    a
}

/// Minimal roster: relation ≤ 1 = allies, > 1 = enemies — the split
/// `tab_order_from_anchor` keys on.
fn arena_roster(names: &[(&str, i64)]) -> wowsp_tauri_shared::ArenaInfo {
    wowsp_tauri_shared::ArenaInfo {
        match_group: Some("pvp".into()),
        date_time: Some("18.09.2026 16:17:19".into()),
        map_name: None,
        scenario: None,
        bot_count: 0,
        vehicles: names
            .iter()
            .map(|&(name, relation)| wowsp_tauri_shared::VehicleEntry {
                id: name.len() as i64,
                name: name.into(),
                relation,
                ship_id: 0,
                ship_name: None,
            })
            .collect(),
        raw: serde_json::Value::Null,
    }
}

#[test]
fn tab_order_splits_blocks_at_the_roster_relation_count() {
    // 3 allies + 2 enemies in the roster; the mapping's rows are split at
    // the SAME boundary, keeping on-screen order inside each block.
    let info = arena_roster(&[
        ("Alpha", 0),
        ("Bravo", 1),
        ("Charlie", 1),
        ("Delta", 2),
        ("Echo", 2),
    ]);
    let anchor = anchor_with_state(
        5,
        Some(vec![
            Some("Charlie".into()),
            Some("Alpha".into()),
            None,
            Some("Echo".into()),
            Some("Delta".into()),
        ]),
        Some(vec![true, false, true, false, true]),
    );
    let order = tab_order_from_anchor(&anchor, &info).expect("trusted mapping");
    assert_eq!(order.date_time.as_deref(), Some("18.09.2026 16:17:19"));
    let ally_names: Vec<_> = order.allies.iter().map(|r| r.name.clone()).collect();
    let enemy_names: Vec<_> = order.enemies.iter().map(|r| r.name.clone()).collect();
    assert_eq!(
        ally_names,
        [Some("Charlie".into()), Some("Alpha".into()), None]
    );
    assert_eq!(enemy_names, [Some("Echo".into()), Some("Delta".into())]);
    // Alive flags ride along per row — sunk Alpha (row 1) and sunk Echo
    // (row 3) carry false.
    assert_eq!(
        order.allies.iter().map(|r| r.alive).collect::<Vec<_>>(),
        [true, false, true]
    );
    assert_eq!(
        order.enemies.iter().map(|r| r.alive).collect::<Vec<_>>(),
        [false, true]
    );
}

#[test]
fn tab_order_requires_a_trusted_mapping() {
    let info = arena_roster(&[("Alpha", 0), ("Delta", 2)]);
    // No mapping at all (recognition off / manual anchor): nothing to say.
    assert!(tab_order_from_anchor(&anchor_with_state(2, None, None), &info).is_none());
    // All-None mapping (honest silence): still nothing to say.
    assert!(
        tab_order_from_anchor(
            &anchor_with_state(2, Some(vec![None, None]), Some(vec![true, true])),
            &info
        )
        .is_none()
    );
}

#[test]
fn tab_order_defaults_missing_alive_flags_to_alive() {
    // A mapping without an alive vector (older payload shape) must never
    // mark players sunk by accident.
    let info = arena_roster(&[("Alpha", 0), ("Delta", 2)]);
    let anchor = anchor_with_state(
        2,
        Some(vec![Some("Alpha".into()), Some("Delta".into())]),
        None,
    );
    let order = tab_order_from_anchor(&anchor, &info).expect("trusted mapping");
    assert!(order.allies[0].alive && order.enemies[0].alive);
}

#[test]
fn tab_order_drops_rows_beyond_the_roster_blocks() {
    // A detector overcount (mapping longer than the roster) must not
    // shrink or misplace the ALLY block: it stays exactly the roster's
    // relation ≤ 1 count, and every further row belongs to the enemy
    // block (the frontend matches by name, so unmatched rows are inert).
    let info = arena_roster(&[("Alpha", 0), ("Delta", 2)]);
    let anchor = anchor_with_state(
        4,
        Some(vec![
            Some("Alpha".into()),
            None,
            Some("Delta".into()),
            Some("Ghost".into()),
        ]),
        Some(vec![true, true, true, true]),
    );
    let order = tab_order_from_anchor(&anchor, &info).expect("trusted mapping");
    assert_eq!(
        order.allies.len(),
        1,
        "ally block is exactly the roster count"
    );
    assert_eq!(order.allies[0].name, Some("Alpha".into()));
    assert_eq!(
        order.enemies.len(),
        3,
        "remaining rows land in the enemy block"
    );
    assert_eq!(order.enemies[0].name, None);
    assert_eq!(order.enemies[1].name, Some("Delta".into()));
    assert_eq!(order.enemies[2].name, Some("Ghost".into()));
}

#[test]
fn transplant_copies_alive_flags_and_re_emits_on_alive_flip() {
    // A ship sinking WITHOUT re-sorting the rows (it already sat at its
    // group tail) changes only row_alive — that flip alone must count as
    // a transplant-worthy difference so the overlay and the tab-order
    // event both hear about it.
    let pinned = anchor_with_state(
        2,
        Some(vec![Some("Alpha".into()), Some("Delta".into())]),
        Some(vec![true, true]),
    );
    let fresh = anchor_with_state(
        2,
        Some(vec![Some("Alpha".into()), Some("Delta".into())]),
        Some(vec![true, false]),
    );
    let updated = transplant_row_players(&pinned, &fresh).expect("alive flip transplants");
    assert_eq!(updated.row_alive, Some(vec![true, false]));
    // Identical names AND identical alive flags → nothing to transplant.
    assert!(transplant_row_players(&updated, &fresh).is_none());
}

#[test]
fn transplant_needs_confirmed_equal_length_changed_mapping() {
    let pinned = anchor_with_players(2, true, None, true);
    // First recognition landing on an unchanged grid → transplant.
    let fresh = anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
    let updated = transplant_row_players(&pinned, &fresh).expect("catch-up maps");
    assert_eq!(
        updated.row_players,
        Some(vec![Some("Alpha".into()), None]),
        "the mapping is copied verbatim"
    );
    assert!(!updated.row_players_pending, "a mapping clears pending");
    // Geometry is untouched — only the mapping fields move.
    assert_eq!(updated.row_centers, pinned.row_centers);
    assert_eq!(updated.roster_rect, pinned.roster_rect);
    assert_eq!(updated.overlay_rect, pinned.overlay_rect);
    assert_eq!(updated.game_rect, pinned.game_rect);
    assert_eq!(updated.team_split, pinned.team_split);
    assert!(updated.table_detected);
    // Identical mapping → nothing to re-emit.
    let fresh_same = anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
    let pinned_mapped = transplant_row_players(&pinned, &fresh).unwrap();
    assert!(transplant_row_players(&pinned_mapped, &fresh_same).is_none());
    // A re-sort (different mapping, same length) DOES transplant.
    let re_sorted = anchor_with_players(2, true, Some(vec![None, Some("Alpha".into())]), false);
    assert!(transplant_row_players(&pinned_mapped, &re_sorted).is_some());
    // Length mismatch (grids disagree) → dropped, never mis-pinned.
    let wrong_len =
        anchor_with_players(3, true, Some(vec![Some("Alpha".into()), None, None]), false);
    assert!(transplant_row_players(&pinned, &wrong_len).is_none());
    // Fallback detection never touches the pin.
    let fallback = anchor_with_players(2, false, Some(vec![None, None]), false);
    assert!(transplant_row_players(&pinned, &fallback).is_none());
    // A fresh pass that recognized nothing carries no mapping either.
    let no_mapping = anchor_with_players(2, true, None, true);
    assert!(transplant_row_players(&pinned, &no_mapping).is_none());
    assert!(should_transplant_rows(&fresh, &pinned));
    assert!(!should_transplant_rows(&no_mapping, &pinned));

    // An all-None read (text seen, nothing matched) transplants onto a
    // mapping-less pin — honest silence replaces the index guess — but
    // the result is still NOT a trusted mapping: pending stays true.
    let all_none = anchor_with_players(2, true, Some(vec![None, None]), false);
    let silenced =
        transplant_row_players(&pinned, &all_none).expect("an all-None read still lands");
    assert_eq!(silenced.row_players, Some(vec![None, None]));
    assert!(
        silenced.row_players_pending,
        "an all-None mapping is not trusted"
    );
    // A deterministic all-None re-read compares equal → no transplant,
    // no re-emit: keeping catch-up armed on an all-None pin cannot
    // oscillate.
    assert!(transplant_row_players(&silenced, &all_none).is_none());
    // A later read that matches something transplants…
    let recovered_pin = anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
    let recovered = transplant_row_players(&silenced, &recovered_pin)
        .expect("a partial match improves an all-None mapping");
    // …and a mapping with at least one match clears pending.
    assert!(!recovered.row_players_pending);
}

#[test]
fn catch_up_gate_needs_pin_pending_stale_engine_and_throttle() {
    let pending_pin = anchor_with_players(2, true, None, true);
    // An all-None mapping (text read, nothing matched) is NOT ready —
    // catch-up stays armed for it too.
    let all_none_pin = anchor_with_players(2, true, Some(vec![None, None]), false);
    // A PARTIAL match names one row but leaves the other on "…": trusted
    // enough to render, yet the catch-up stays armed so the unnamed row
    // gets re-read instead of dotting for the whole battle.
    let partial_pin = anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
    let ready_pin = anchor_with_players(
        2,
        true,
        Some(vec![Some("Alpha".into()), Some("Beta".into())]),
        false,
    );
    let fallback_pin = anchor_with_players(2, false, None, false);
    // Pending (absent, all-None or partially-named mapping) + engine on +
    // throttle elapsed → run the catch-up pass.
    assert!(should_catch_up_recognition(
        Some(&pending_pin),
        false,
        true,
        true
    ));
    assert!(should_catch_up_recognition(
        Some(&all_none_pin),
        false,
        true,
        true
    ));
    assert!(should_catch_up_recognition(
        Some(&partial_pin),
        false,
        true,
        true
    ));
    // …but not without the engine, the throttle, a pin, a confirmed
    // table, or once a fully-named mapping has landed.
    assert!(!should_catch_up_recognition(
        Some(&pending_pin),
        false,
        false,
        true
    ));
    assert!(!should_catch_up_recognition(
        Some(&pending_pin),
        false,
        true,
        false
    ));
    assert!(!should_catch_up_recognition(None, false, true, true));
    assert!(!should_catch_up_recognition(
        Some(&ready_pin),
        false,
        true,
        true
    ));
    assert!(!should_catch_up_recognition(
        Some(&fallback_pin),
        false,
        true,
        true
    ));
    // STALE (the sink probe just flipped alive flags) arms the gate even
    // on a trusted mapping: the mapping is battle-accurate but describes
    // the PRE-sink row order — the re-read confirms the new order.
    assert!(should_catch_up_recognition(
        Some(&ready_pin),
        true,
        true,
        true
    ));
    // …still gated by the engine, the throttle, the pin and the table.
    assert!(!should_catch_up_recognition(
        Some(&ready_pin),
        true,
        false,
        true
    ));
    assert!(!should_catch_up_recognition(
        Some(&ready_pin),
        true,
        true,
        false
    ));
    assert!(!should_catch_up_recognition(None, true, true, true));
    assert!(!should_catch_up_recognition(
        Some(&fallback_pin),
        true,
        true,
        true
    ));
}

#[test]
fn mapping_incomplete_needs_every_row_named() {
    assert!(mapping_incomplete(&None));
    assert!(mapping_incomplete(&Some(vec![None, None])));
    assert!(mapping_incomplete(&Some(vec![Some("Alpha".into()), None])));
    assert!(!mapping_incomplete(&Some(vec![Some("Alpha".into())])));
    // Strictly stricter than the trust bar: everything untrusted is
    // incomplete, while a partial match is trusted AND incomplete.
    assert!(!mapping_untrusted(&Some(vec![Some("Alpha".into()), None])));
}

#[test]
fn manual_row_centers_split_two_even_blocks() {
    let rect = Rect {
        x: 100,
        y: 200,
        width: 500,
        height: 300,
    };
    // 3 allies vs 2 enemies: the pitch comes from the TALLER side
    // (300 / 3 = 100), allies fill the box, the enemy block ends early.
    let rows = manual_row_centers(&rect, (3, 2));
    assert_eq!(rows.len(), 5, "allies block + enemies block");
    // Allies: y + pitch * (i + 0.5).
    assert_eq!(&rows[..3], &[250, 350, 450]);
    // Enemies share the same pitch and box, just fewer rows.
    assert_eq!(&rows[3..], &[250, 350]);
}

#[test]
fn manual_row_centers_handles_asymmetric_and_minimal() {
    let rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    // 12v6: pitch = 1080 / 12 = 90; 18 rows total.
    let rows = manual_row_centers(&rect, (12, 6));
    assert_eq!(rows.len(), 18);
    assert_eq!(rows[0], 45);
    assert_eq!(rows[11], 45 + 90 * 11);
    assert_eq!(rows[12], 45, "enemy block restarts at the first row center");

    // Degenerate (0, 0) roster: no rows at all (the command path
    // rejects an empty roster before an anchor is ever stored).
    let rows = manual_row_centers(&rect, (0, 0));
    assert!(rows.is_empty());
}

#[test]
fn manual_selection_validation_bounds() {
    let game = Rect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };
    // Happy path.
    let sel = Rect {
        x: 600,
        y: 300,
        width: 1200,
        height: 500,
    };
    assert!(validate_manual_selection(&sel, &game).is_ok());
    // Too small (per axis).
    let tiny = Rect {
        x: 10,
        y: 10,
        width: 20,
        height: 400,
    };
    assert!(validate_manual_selection(&tiny, &game).is_err());
    // Escapes the game window.
    let outside = Rect {
        x: 2000,
        y: 300,
        width: 1200,
        height: 500,
    };
    assert!(validate_manual_selection(&outside, &game).is_err());
    // Negative origin.
    let negative = Rect {
        x: -5,
        y: 10,
        width: 1200,
        height: 500,
    };
    assert!(validate_manual_selection(&negative, &game).is_err());
}

#[test]
fn manual_anchor_check_liveness_and_staleness() {
    let game = Rect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };
    let stored = ManualAnchor {
        battle: 111,
        game_rect: game,
        rect: Rect {
            x: 600,
            y: 300,
            width: 1200,
            height: 500,
        },
        team_sizes: (12, 12),
    };
    let armed = Some(&stored);

    // Same battle + same window → live.
    assert!(matches!(
        manual_anchor_check(armed, 111, Some(game)),
        ManualAnchorCheck::Live(_, r) if r == game
    ));
    // New battle → stale.
    assert!(matches!(
        manual_anchor_check(armed, 222, Some(game)),
        ManualAnchorCheck::Stale
    ));
    // Window moved → stale.
    let moved = Rect {
        x: 10,
        y: 0,
        width: 2560,
        height: 1440,
    };
    assert!(matches!(
        manual_anchor_check(armed, 111, Some(moved)),
        ManualAnchorCheck::Stale
    ));
    // No game rect this tick → inert (NOT stale: a transient HWND miss
    // must not nuke the box).
    assert!(matches!(
        manual_anchor_check(armed, 111, None),
        ManualAnchorCheck::Inert
    ));

    // While stored, the anchor's row total backs the automatic status
    // reports' manual flag (the panel badge survives Idle/Searching).
    assert_eq!(stored_manual_rows(armed), Some(24)); // 12 + 12

    // Empty store → inert, and no manual rows to report.
    assert!(matches!(
        manual_anchor_check(None, 111, Some(game)),
        ManualAnchorCheck::Inert
    ));
    assert_eq!(stored_manual_rows(None), None);
}

#[test]
fn build_manual_anchor_rebases_to_the_overlay_origin() {
    let game = Rect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };
    let m = ManualAnchor {
        battle: 7,
        game_rect: game,
        rect: Rect {
            x: 600,
            y: 300,
            width: 1200,
            height: 250,
        },
        team_sizes: (5, 5),
    };
    let anchor = build_manual_anchor(&m, game);
    // A manual anchor is always a CONFIRMED table.
    assert!(anchor.table_detected);
    // row_players stays None on purpose — no OCR on a hand-drawn box.
    assert!(anchor.row_players.is_none());
    assert_eq!(anchor.row_centers.len(), 10);
    // The overlay window covers the selection inflated by the shared
    // padding, and the anchor coordinates are re-based to ITS origin
    // (same contract as the auto detector's anchor): game-relative
    // centers 325..525 (pitch 250/5 = 50) shift up by dy = rect.y - pad.
    let pad = overlay_detect::overlay_padding(&m.rect);
    let padx = overlay_detect::overlay_padding_x(&m.rect);
    let dy = m.rect.y - pad; // 300 - 31 = 269
    assert_eq!(anchor.row_centers[0], 325 - dy);
    assert_eq!(anchor.row_centers[4], 525 - dy);
    assert_eq!(
        anchor.row_centers[5],
        325 - dy,
        "enemy block shares the grid"
    );
    assert_eq!(anchor.overlay_rect.x, m.rect.x - padx);
    assert_eq!(anchor.overlay_rect.y, m.rect.y - pad);
    assert_eq!(anchor.roster_rect.x, padx);
    assert_eq!(anchor.roster_rect.y, pad);
    assert_eq!(anchor.team_split, 0.5);
}

// ── Status no-flicker rule ────────────────────────────────────────────

#[test]
fn detected_pin_never_degrades_to_searching() {
    let game = Rect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };
    // With a pin valid for the current battle + rect the report is
    // ALWAYS the pin path (Detected) — a Tab re-press within one battle
    // must not flash Searching before the chips come back.
    assert!(pin_matches(7, &game, true, 7, Some(game)));
    assert_eq!(held_status(true, false), HeldStatus::Pin);
    // Even a leftover Fallback label cannot outrank a live pin.
    assert_eq!(held_status(true, true), HeldStatus::Pin);
    // Battle changed → the pin is void, Searching (or the fallback
    // continuation) is the honest report.
    assert!(!pin_matches(7, &game, true, 8, Some(game)));
    assert_eq!(held_status(false, false), HeldStatus::Searching);
    // Game rect changed (moved/resized window) → same.
    let moved = Rect {
        x: 5,
        y: 0,
        width: 2560,
        height: 1440,
    };
    assert!(!pin_matches(7, &game, true, 7, Some(moved)));
    assert!(!pin_matches(7, &game, true, 7, None), "no rect to match");
    // A fallback anchor never counts as a pin (hint keeps acquiring).
    assert!(!pin_matches(7, &game, false, 7, Some(game)));
    // Fallback continuation: the hint is on screen, keep labeling it.
    assert_eq!(held_status(false, true), HeldStatus::Fallback);
}

// ── Move replacement carries the old mapping ─────────────────────────

#[test]
fn carry_mapping_into_fresh_rules() {
    let pinned = anchor_with_state(
        3,
        Some(vec![Some("Alpha".into()), None, Some("Delta".into())]),
        Some(vec![true, false, true]),
    );
    // HUD phase moved the table: fresh grid (different centers), fresh
    // OCR NOT landed yet (pending).
    let fresh_geometry = anchor_with_players(3, true, None, true);
    let carried = carry_mapping_into_fresh(&fresh_geometry, &pinned);
    assert!(
        !mapping_untrusted(&carried.row_players),
        "the battle-accurate mapping is carried onto the moved grid"
    );
    assert_eq!(
        carried.row_players, pinned.row_players,
        "names copied verbatim"
    );
    assert_eq!(carried.row_alive, pinned.row_alive, "alive flags copied");
    assert!(!carried.row_players_pending, "pending cleared with it");
    // Fresh GEOMETRY is kept: centers come from the moved detection.
    assert_eq!(carried.row_centers, fresh_geometry.row_centers);
    // Fresh carries its own trusted mapping → kept (it is newer).
    let fresh_mapped =
        anchor_with_players(3, true, Some(vec![Some("Bravo".into()), None, None]), false);
    let kept = carry_mapping_into_fresh(&fresh_mapped, &pinned);
    assert_eq!(kept.row_players, fresh_mapped.row_players);
    // Grid length mismatch → never index-guess: fresh stays unmapped.
    let fresh_other_grid = anchor_with_players(4, true, None, true);
    let skipped = carry_mapping_into_fresh(&fresh_other_grid, &pinned);
    assert!(mapping_untrusted(&skipped.row_players));
    // Pin has no trusted mapping (None / all-None) → nothing to carry.
    let unmapped_pin = anchor_with_players(3, true, None, true);
    let nothing = carry_mapping_into_fresh(&fresh_geometry, &unmapped_pin);
    assert!(mapping_untrusted(&nothing.row_players));
    let silent_pin = anchor_with_players(3, true, Some(vec![None, None, None]), false);
    assert!(mapping_untrusted(
        &carry_mapping_into_fresh(&fresh_geometry, &silent_pin).row_players
    ));
}

// ── Stale lifecycle ──────────────────────────────────────────────────

#[test]
fn stale_lifecycle_set_on_sink_cleared_by_trusted_landing() {
    // Sink probe flips alive flags → stale rises…
    let before = Some(vec![true, true, false]);
    let after = vec![true, true, true];
    assert!(alive_changed(before.as_deref(), &after), "a flip fires");
    // …and the OCR side of the lifecycle clears it exactly when a
    // TRUSTED mapping produced by THIS FRAME's OCR lands; an all-None
    // landing (honest silence) keeps the flag and the fast catch-up
    // armed.
    let trusted = Some(vec![Some("Alpha".into()), None, Some("Delta".into())]);
    let all_none = Some(vec![None, None, None]);
    assert!(!stale_after_mapping(
        true,
        &trusted,
        MappingOrigin::FreshOcr
    ));
    assert!(stale_after_mapping(
        true,
        &all_none,
        MappingOrigin::FreshOcr
    ));
    assert!(stale_after_mapping(true, &None, MappingOrigin::FreshOcr));
    // A trusted landing keeps stale cleared; a missing mapping never
    // sets it on its own.
    assert!(!stale_after_mapping(
        false,
        &trusted,
        MappingOrigin::FreshOcr
    ));
    assert!(!stale_after_mapping(false, &None, MappingOrigin::FreshOcr));
}

#[test]
fn carried_mapping_never_touches_the_stale_flag() {
    // A mapping CARRIED from the old pin onto a moved grid still
    // describes the PRE-sink row order — it must not launder a set
    // stale flag, and carrying is not a data change, so it must not
    // set one either. Only this frame's own OCR may clear.
    let trusted = Some(vec![Some("Alpha".into()), None, Some("Delta".into())]);
    let all_none = Some(vec![None, None, None]);
    assert!(
        stale_after_mapping(true, &trusted, MappingOrigin::CarriedFromPin),
        "carry + stale → stays stale"
    );
    assert!(
        !stale_after_mapping(false, &trusted, MappingOrigin::CarriedFromPin),
        "carry + fresh → stays fresh (never sets)"
    );
    // Untrusted mappings keep the flag regardless of origin.
    assert!(stale_after_mapping(
        true,
        &all_none,
        MappingOrigin::CarriedFromPin
    ));
    assert!(!stale_after_mapping(
        false,
        &all_none,
        MappingOrigin::CarriedFromPin
    ));
    assert!(stale_after_mapping(
        true,
        &None,
        MappingOrigin::CarriedFromPin
    ));
}

#[test]
fn alive_changed_only_fires_on_comparable_data() {
    // No baseline (recognition never ran) → never fires.
    assert!(!alive_changed(None, &[true, false]));
    // Length mismatch (different grids) → never fires.
    assert!(!alive_changed(Some(&[true]), &[true, false]));
    // Identical vectors → no change.
    assert!(!alive_changed(Some(&[true, false]), &[true, false]));
    // Any single flipped row fires (a ship sank, or a row re-read).
    assert!(alive_changed(Some(&[true, true]), &[true, false]));
    assert!(alive_changed(Some(&[false, false]), &[false, true]));
}

#[test]
fn sink_probe_applies_sinks_now_and_debounces_revivals() {
    let t0 = Instant::now();
    // Two sunk rows so several distinct pure-revival reads exist.
    let pinned = [true, false, false];
    // A SINK (alive→false) applies on the FIRST probe, candidate cleared.
    let (apply, cand) = sink_probe_confirm(Some(&pinned), None, &[false, false, false], t0);
    assert_eq!(apply.as_deref(), Some(&[false, false, false][..]));
    assert!(cand.is_none(), "sinks never arm a candidate");

    // A pure REVIVAL (glare on a sunk row) only arms a candidate.
    let revived_a = [true, true, false];
    let (apply, cand) = sink_probe_confirm(Some(&pinned), None, &revived_a, t0);
    assert_eq!(apply, None, "first revival read is not applied");
    let (cvec, cseen) = cand.expect("revival arms a candidate");
    assert_eq!(cvec, revived_a.to_vec());

    // A second agreeing probe within the TTL confirms it.
    let t1 = t0 + SINK_CANDIDATE_TTL;
    let (apply, cand) = sink_probe_confirm(Some(&pinned), Some((&cvec, cseen)), &revived_a, t1);
    assert_eq!(apply.as_deref(), Some(&[true, true, false][..]));
    assert!(cand.is_none(), "confirmation clears the candidate");

    // A DISAGREEING revival re-read resets the count to the newest
    // reading (the first glare described a different row)…
    let revived_b = [true, false, true];
    let (apply, cand) = sink_probe_confirm(Some(&pinned), Some((&cvec, cseen)), &revived_b, t1);
    assert_eq!(apply, None, "conflicting reads stay unapplied");
    let (nv, ns) = cand.expect("the newest reading re-arms the candidate");
    assert_eq!(nv, revived_b.to_vec());
    assert_eq!(ns, t1);
    // …and the re-armed candidate still needs its own second probe.
    let (apply, _) = sink_probe_confirm(Some(&pinned), Some((&nv, ns)), &revived_a, t1);
    assert_eq!(apply, None);

    // A read matching the pin drops a pending candidate (the glare
    // never repeated — nothing happened).
    let (apply, cand) = sink_probe_confirm(Some(&pinned), Some((&nv, ns)), &pinned, t1);
    assert_eq!(apply, None);
    assert!(cand.is_none(), "pin-matching read resets the debounce");

    // An EXPIRED candidate does not confirm a later agreeing read.
    let late = t0 + SINK_CANDIDATE_TTL + Duration::from_millis(1);
    let (apply, cand) = sink_probe_confirm(Some(&pinned), Some((&cvec, cseen)), &revived_a, late);
    assert_eq!(apply, None, "past the TTL the count restarts");
    assert_eq!(cand.unwrap().0, revived_a.to_vec());

    // Non-comparable data (no baseline / length mismatch) is quiet and
    // clears any pending candidate.
    let (apply, cand) = sink_probe_confirm(None, Some((&cvec, cseen)), &revived_a, t1);
    assert_eq!(apply, None);
    assert!(cand.is_none());
    let (apply, cand) = sink_probe_confirm(Some(&[true]), Some((&cvec, cseen)), &revived_a, t1);
    assert_eq!(apply, None);
    assert!(cand.is_none());
}

// ── FIFO command pipeline ────────────────────────────────────────────

#[test]
fn watch_command_queue_is_fifo() {
    // The queue must hand commands back strictly in push order — the
    // watcher loop's state transitions (and the badge order) depend on
    // it. Bounded too: the oldest command drops past the cap.
    let first = WatchCommand::ManualAnchorCleared;
    let second = WatchCommand::BattleChanged;
    push_watch_command(first);
    push_watch_command(second);
    let drained: Vec<WatchCommand> = WATCH_COMMANDS.lock().unwrap().drain(..).collect();
    assert_eq!(drained.len(), 2, "test owns the whole queue");
    assert!(matches!(drained[0], WatchCommand::ManualAnchorCleared));
    assert!(matches!(drained[1], WatchCommand::BattleChanged));
}

#[cfg(target_os = "windows")]
#[test]
fn watch_commands_apply_in_fifo_order_to_the_fsm() {
    let game = Rect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };
    let mut fsm = WatchFsm::default();
    // Set then clear, in order: the anchor must end up GONE (a direct
    // unordered application could leave it armed).
    let r1 = apply_watch_command(
        &mut fsm,
        WatchCommand::ManualAnchorSet {
            rect: Rect {
                x: 600,
                y: 300,
                width: 1200,
                height: 500,
            },
            game_rect: game,
            battle: 42,
            team_sizes: (5, 5),
        },
    );
    assert!(fsm.manual_anchor.is_some(), "set arms the anchor");
    assert_eq!(
        r1,
        Some((OverlayState::Manual, Some(10))),
        "the set reports the manual badge immediately"
    );
    // Clear while hidden → Idle report (an unconditional Searching
    // would stick forever — the hide branch only runs while shown).
    let r2 = apply_watch_command(&mut fsm, WatchCommand::ManualAnchorCleared);
    assert!(fsm.manual_anchor.is_none(), "clear disarms the anchor");
    assert_eq!(r2, Some((OverlayState::Idle, None)));
    // Clear while shown WITHOUT a pin → Searching.
    fsm.overlay_shown = true;
    let r3 = apply_watch_command(&mut fsm, WatchCommand::ManualAnchorCleared);
    assert_eq!(r3, Some((OverlayState::Searching, None)));
    // Clear while shown WITH a confirmed pin → Detected (no flicker).
    fsm.pinned_anchor = Some(PinnedAnchor {
        battle: 42,
        game_rect: game,
        anchor: anchor_with_players(10, true, None, true),
    });
    let r4 = apply_watch_command(&mut fsm, WatchCommand::ManualAnchorCleared);
    assert_eq!(r4, Some((OverlayState::Detected, None)));

    // BattleChanged voids the pin and the stale flag but KEEPS the
    // geometry cache (same window mode → same pixel geometry).
    fsm.stale = true;
    fsm.geometry_cache = Some(GeometryCacheEntry {
        key: GeometryKey {
            game_size: (game.width, game.height),
            style_bits: 1,
        },
        band: overlay_detect::HeaderBand {
            top: 10,
            height: 5,
            green: (20, 30),
            red: (30, 40),
        },
        roster: overlay_detect::DetectedRoster {
            rect: game,
            row_centers: vec![1, 2, 3],
            team_split: 0.5,
        },
        team_sizes: (5, 5),
    });
    assert!(
        apply_watch_command(&mut fsm, WatchCommand::BattleChanged).is_none(),
        "the next tick re-derives the honest state"
    );
    assert!(fsm.pinned_anchor.is_none(), "pin voided");
    assert!(!fsm.stale, "stale reset with the pin");
    assert!(
        fsm.geometry_cache.is_some(),
        "the cache survives battle changes by design"
    );
}
