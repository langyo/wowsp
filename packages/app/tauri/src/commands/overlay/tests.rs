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
/// Hand-built anchor for the watcher tests: only the fields those
/// decisions read are varied.
fn anchor_with(rows: usize, detected: bool, alive: Option<Vec<bool>>) -> OverlayAnchor {
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
        row_alive: alive,
        roster_mode: String::new(),
    }
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
    // row_alive stays None on purpose — no luma read on a hand-drawn box.
    assert!(anchor.row_alive.is_none());
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

// ── Stale lifecycle ──────────────────────────────────────────────────

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
        anchor: anchor_with(10, true, None),
    });
    let r4 = apply_watch_command(&mut fsm, WatchCommand::ManualAnchorCleared);
    assert_eq!(r4, Some((OverlayState::Detected, None)));

    // BattleChanged voids the pin but KEEPS the geometry cache (same
    // window mode → same pixel geometry).
    fsm.geometry_cache = Some(GeometryCacheEntry {
        key: GeometryKey {
            game_size: (game.width, game.height),
            style_bits: 1,
        },
        band: overlay_detect::HeaderBand {
            top: 10,
            height: 5,
            green: (20, 30),
            red: Some((30, 40)),
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
    assert!(
        fsm.geometry_cache.is_some(),
        "the cache survives battle changes by design"
    );
}
