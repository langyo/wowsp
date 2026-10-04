use super::*;
/// What the want-visible branch reports this tick (pure, unit-tested — the
/// no-flicker rule lives here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HeldStatus {
    /// A pin valid for THIS battle + game rect is (being) shown: Detected,
    /// never the tick-top Searching flash.
    Pin,
    /// The centered fallback hint is what's on screen; keep labeling it so
    /// the consumer sees one continuous "hint" episode instead of
    /// hint↔searching churn while the scene gate keeps failing.
    Fallback,
    /// Acquiring without a pin — honest Searching.
    Searching,
}

/// Pure status decision for the want-visible path: with a valid pin the
/// report is Detected — ALWAYS. Searching/Fallback only report on the
/// acquisition arm, i.e. when no pin matched the current (battle,
/// game-window rect). Falling back to Searching is therefore exactly the
/// event that voids a pin: a BattleChanged command / arena-stamp mismatch,
/// a changed game rect, a cleared manual anchor, watcher stop, or the
/// table switch — never a mundane Tab re-press within one battle.
pub(super) fn held_status(pin_valid: bool, fallback_on_screen: bool) -> HeldStatus {
    if pin_valid {
        HeldStatus::Pin
    } else if fallback_on_screen {
        HeldStatus::Fallback
    } else {
        HeldStatus::Searching
    }
}

/// Pure pin-validity rule (unit-testable): the pin applies to THIS battle
/// on THIS game-window geometry and is a confirmed table detection. A new
/// battle (arena stamp moved), a real window move/resize (beyond the DWM
/// jitter tolerance — see [`rect_same_within`]), or a fallback anchor void
/// it — and voiding it is exactly what re-arms the Searching report.
pub(super) fn pin_matches(
    pin_battle: i64,
    pin_rect: &Rect,
    pin_table_detected: bool,
    pin_kind: wowsp_tauri_shared::GameInstallKind,
    battle: i64,
    game_rect: Option<Rect>,
    game_kind: Option<wowsp_tauri_shared::GameInstallKind>,
) -> bool {
    pin_table_detected
        && pin_battle == battle
        && game_kind == Some(pin_kind)
        && game_rect.is_some_and(|r| rect_same_within(&r, pin_rect))
}

/// Pure sink decision (unit-tested): did any row's alive flag change
/// between the pin's classification and a fresh strip read? Missing pin
/// data (no luma baseline) or a length mismatch reads as "no change"
/// — the sink channel only fires on comparable, same-grid data, never on
/// a guess.
pub(super) fn alive_changed(pinned: Option<&[bool]>, fresh: &[bool]) -> bool {
    match pinned {
        Some(p) => p.len() == fresh.len() && p.iter().zip(fresh).any(|(a, b)| a != b),
        None => false,
    }
}

/// Outcome pair of one sink probe against the pinned alive state
/// ([`sink_probe_confirm`]): what to apply to the pin NOW, and the candidate
/// state to carry into the next probe (`None` = nothing pending).
type SinkProbeResult = (Option<Vec<bool>>, Option<(Vec<bool>, Instant)>);

/// Pure sink-probe hysteresis (unit-tested; time injected): sinks apply
/// IMMEDIATELY, revives need two agreeing probes.
///
/// A sinking ship must re-sort the chips within a probe interval (the
/// user-facing point of the fast path), so any alive→false flip applies at
/// once. A false→true flip, however, is almost always a single-frame
/// artifact — an explosion flash or water glare pushing a SUNK row's name
/// strip over the alive-luma threshold — and applying it would flip a chip
/// back to colored for one probe and re-sort the rows around nothing. So a
/// pure-revive read is only CANDIDATE-armed; it applies when the NEXT probe
/// (≈ [`SINK_CHECK_INTERVAL`] later, within [`SINK_CANDIDATE_TTL`]) reads
/// the same vector. Any disagreeing read — the pin itself, a different
/// vector, an expired candidate — resets the count to the newest reading.
///
/// Returns `(apply_now, next_candidate)`: `apply_now` is the alive vector
/// to write onto the pin (already re-placed by the caller), `next_candidate`
/// the debounce state for the following probe.
pub(super) fn sink_probe_confirm(
    pinned: Option<&[bool]>,
    candidate: Option<(&[bool], Instant)>,
    fresh: &[bool],
    now: Instant,
) -> SinkProbeResult {
    // Not comparable (no baseline, length mismatch) or the read equals the
    // pin: nothing to do — and a pending candidate was just contradicted by
    // the pin-matching read, so drop it.
    if !alive_changed(pinned, fresh) {
        return (None, None);
    }
    let pinned = pinned.unwrap_or_default();
    // Any alive→false flip is a genuine sink signal: apply immediately.
    if pinned.iter().zip(fresh).any(|(a, b)| *a && !*b) {
        return (Some(fresh.to_vec()), None);
    }
    // Pure revival: confirm only a second, consistent reading.
    if let Some((c, first_seen)) = candidate
        && c == fresh
        && now.duration_since(first_seen) <= SINK_CANDIDATE_TTL
    {
        return (Some(fresh.to_vec()), None);
    }
    // First observation, a differing re-read, or an expired candidate:
    // (re)arm with this reading and apply nothing yet.
    (None, Some((fresh.to_vec(), now)))
}

/// One revalidation pass over the pinned anchor while the overlay is shown:
/// re-run the capture + detector against the live frame and reconcile the
/// pin with it. The ONE outcome that changes the pin: the table MOVED at
/// row scale (`overlay_detect::anchor_meaningfully_moved`) — the pin is
/// replaced by the fresh detection's geometry, re-keyed to the CURRENT
/// battle + window geometry (the fresh anchor was computed from THIS
/// frame, so it belongs to this geometry; the sink baseline dies with the
/// old grid, see `sink_check_pass`).
///
/// Every other outcome — a failed capture, a fallback detection, sub-pitch
/// jitter — keeps the pin and emits nothing, so this pass can never make
/// the chips wander. `last_revalidate` is bumped unconditionally: the pass
/// costs a full capture attempt regardless of its outcome.
///
/// Note that `compute_anchor` already drops a tab dump on every CONFIRMED
/// detection (`tab_dump`): the pass that discovers a NEW layout leaves a
/// ground-truth artifact for it, deduped per (battle, layout) by the
/// anchor's first row.
#[cfg(target_os = "windows")]
pub(super) fn revalidate_pinned_anchor(
    app: &AppHandle,
    fsm: &mut WatchFsm,
    game: Option<GameWindow>,
) {
    fsm.last_revalidate = Some(Instant::now());
    let Some(g) = game else {
        return;
    };
    let Some(pinned) = fsm.pinned_anchor.as_ref().map(|p| p.anchor.clone()) else {
        return;
    };
    let Some(fresh) = compute_anchor(&g, fsm) else {
        tracing::debug!("anchor revalidation: capture/detection failed — pin kept");
        return;
    };
    if overlay_detect::anchor_meaningfully_moved(&pinned, &fresh) {
        tracing::info!(
            pinned_first_row = pinned.row_centers.first().copied().unwrap_or(0),
            fresh_first_row = fresh.row_centers.first().copied().unwrap_or(0),
            "panel layout shifted — replacing the pinned anchor"
        );
        // The strip baseline describes the OLD grid's pixels: void it so
        // the next sink probe re-baselines before diffing again.
        fsm.strip_baseline = None;
        fsm.pinned_anchor = Some(PinnedAnchor {
            battle: super::arena_info::last_arena_stamp(),
            game_rect: rect_from_win32(g.rect),
            kind: g.kind,
            anchor: fresh.clone(),
        });
        place_and_show(app, &fresh);
        report_status(
            app,
            fsm,
            OverlayState::Detected,
            Some(fresh.row_centers.len() as u32),
        );
    }
}

/// One SINK FAST-PATH pass (overlay shown + confirmed pin): capture the
/// game window once and read every row's alive flag straight off the
/// PINNED geometry — strip crops + brightest-glyph luma, plus the
/// occupancy fingerprints the sink solver below diffs, no OCR, no
/// detection, no roster read ([`overlay_detect::crop_row_name_strips`]).
/// A settled alive-flag flip (see [`sink_probe_confirm`]: a SINK applies
/// immediately, a pure revival needs two agreeing probes) then:
///
/// - solves the victims (see [`overlay_detect::sink_victims`]) and emits
///   [`SINK_ATTRIB_EVENT`] BEFORE the anchor of the same pass, so the
///   consumers resolve the row indices against their pre-sink layouts;
/// - updates the pin's `row_alive` and re-places the anchor (the chips
///   gray out and re-sort — the page re-derives the exact layout from the
///   attribution plus the alive vector).
///
/// The pass shares the geometry cache's band verify: a frame whose header
/// band is NOT at the cached spot is a geometry event (HUD phase moved the
/// table), not a sink signal — it still counts a verify miss so a dead
/// cache is retired quickly. Guard failures (no pin alive data, no cache)
/// cost nothing: the probe is deliberately silent unless it can be sure.
#[cfg(target_os = "windows")]
pub(super) fn sink_check_pass(app: &AppHandle, fsm: &mut WatchFsm, game: &GameWindow) {
    fsm.last_sink_check = Some(Instant::now());
    // Everything decided BEFORE the capture: a pass with nothing comparable
    // (no luma baseline yet, or no cache to gate the band with) must not
    // pay a BitBlt.
    {
        let Some(pin) = fsm.pinned_anchor.as_ref() else {
            return;
        };
        if pin.anchor.row_alive.is_none() {
            return;
        }
        if fsm.geometry_cache.is_none() {
            return;
        }
    }
    let Some((rgba, w, h)) = capture_game_rgba_cached(&game.rect) else {
        return;
    };
    let profile = overlay_detect::DetectProfile::for_kind(&game.kind);
    let (roster, rows, split, ally_rows) = {
        let pin = fsm.pinned_anchor.as_ref().expect("checked above");
        let anchor = &pin.anchor;
        // The pin's anchor is OVERLAY-relative; shift it back into
        // capture-relative coordinates (the overlay window's origin inside
        // the game rect).
        let dy = anchor.overlay_rect.y - pin.game_rect.y;
        let mut roster = anchor.roster_rect;
        roster.x += anchor.overlay_rect.x - pin.game_rect.x;
        roster.y += dy;
        let rows: Vec<i32> = anchor.row_centers.iter().map(|c| c + dy).collect();
        // The ally-block count the strips key on: the roster is static for
        // the battle, so the current atomic read is the same value the grid
        // was built from. RACE WINDOW (accepted): a BattleChanged command
        // can land between this read and the next tick's FIFO drain, so
        // this ONE probe may split the strips with the NEW roster's ally
        // count against the OLD pin's grid. Worst case is a single
        // mis-split probe (unreadable strips default to alive — no false
        // "sunk"), and the drain voids the pin at the top of the very next
        // tick, so nothing downstream can build on it. Self-healing by
        // ordering; not worth a lock.
        let ally_rows = super::arena_info::last_known_team_sizes().0;
        (roster, rows, anchor.team_split, ally_rows)
    };
    // Band gate — O(band area). The table not being at the cached spot is
    // NOT a sink signal; it does count toward the cache's miss budget.
    let band_ok = fsm
        .geometry_cache
        .as_ref()
        .is_some_and(|c| overlay_detect::verify_header_band(&rgba, w, h, &c.band));
    if !band_ok {
        fsm.geometry_verify_fails += 1;
        if fsm.geometry_verify_fails >= GEOMETRY_VERIFY_MAX_FAILS {
            tracing::info!(
                fails = fsm.geometry_verify_fails,
                "sink probe: header band verify kept failing — geometry cache dropped"
            );
            fsm.geometry_cache = None;
            fsm.geometry_verify_fails = 0;
            // Three misses ≈ the table itself moved (HUD phase switch):
            // force the next tick's revalidation pass instead of waiting
            // out the regular 5 s cadence with misplaced chips.
            fsm.last_revalidate = None;
        }
        return;
    }
    fsm.geometry_verify_fails = 0;
    // One strip crop serves BOTH channels: the luma classification (alive
    // flags, as before) and the occupancy fingerprints the sink solver
    // diffs across this transition.
    let strips = overlay_detect::crop_row_name_strips(
        &rgba,
        w,
        h,
        overlay_detect::StripTable {
            roster: &roster,
            row_centers: &rows,
            team_split: split,
            ally_rows,
        },
        &profile,
    );
    let fresh: Vec<bool> = strips
        .iter()
        .map(|s| match s {
            Some((buf, _, _)) => {
                overlay_detect::row_strip_alive(overlay_detect::strip_max_luma(buf))
            },
            None => true,
        })
        .collect();
    let new_thumbs: Vec<Option<overlay_detect::StripThumb>> = strips
        .iter()
        .map(|s| match s {
            Some((buf, cw, ch)) => overlay_detect::strip_thumb(buf, *cw, *ch),
            None => None,
        })
        .collect();
    let battle = super::arena_info::last_arena_stamp();
    let baseline_usable = fsm.strip_baseline.as_ref().is_some_and(|b| {
        b.battle == battle && b.row_centers == rows && b.thumbs.len() == strips.len()
    });
    let pinned_alive = fsm
        .pinned_anchor
        .as_ref()
        .and_then(|p| p.anchor.row_alive.clone());
    // Hysteresis: sinks apply at once, pure revives wait for a second
    // agreeing probe (see `sink_probe_confirm`).
    let (apply_now, next_candidate) = sink_probe_confirm(
        pinned_alive.as_deref(),
        fsm.sink_candidate.as_ref().map(|(v, t)| (v.as_slice(), *t)),
        &fresh,
        Instant::now(),
    );
    fsm.sink_candidate = next_candidate;
    let Some(alive) = apply_now else {
        // No settled flip: the baseline still tracks the latest frame so
        // the NEXT transition diffs against fresh thumbs.
        fsm.strip_baseline = Some(StripBaseline {
            battle,
            row_centers: rows,
            thumbs: new_thumbs,
        });
        return;
    };
    // Sink attribution: diff this side's old-vs-new strips around the
    // alive-count drop. A side the solver cannot explain contributes an
    // EMPTY vec — the consumer degrades that side, never guesses.
    let mut attrib = wowsp_tauri_shared::SinkAttribution {
        ally_rows: Vec::new(),
        enemy_rows: Vec::new(),
    };
    let old_thumbs: Option<&Vec<Option<overlay_detect::StripThumb>>> =
        baseline_usable.then_some(&fsm.strip_baseline.as_ref().expect("checked").thumbs);
    let side = |range: std::ops::Range<usize>| -> Vec<u32> {
        let Some(old) = old_thumbs else {
            return Vec::new();
        };
        let Some(prev_alive) = pinned_alive.as_deref() else {
            return Vec::new();
        };
        // The applied vector must be BLOCKWISE on this side ([T…T F…F]):
        // the game's re-sorted layout always is, so a non-blockwise read
        // (a glare frame darkening one alive row mid-block) is NOT a sink
        // layout — attributing it would name the wrong victim. Skip: the
        // consumer degrades to ranges on the count mismatch instead.
        let blockwise = !alive[range.clone()]
            .iter()
            .zip(alive[range.clone()].iter().skip(1))
            .any(|(a, b)| !*a && *b);
        if !blockwise {
            return Vec::new();
        }
        let old_side: Vec<Option<overlay_detect::StripThumb>> =
            range.clone().map(|i| old[i]).collect();
        let new_side: Vec<Option<overlay_detect::StripThumb>> =
            range.clone().map(|i| new_thumbs[i]).collect();
        let count = |v: &[bool]| v[range.clone()].iter().filter(|&&a| a).count();
        let (was, now) = (count(prev_alive), count(&alive));
        // sink_victims indexes the SIDE slices above, so its results are
        // already block-relative — SinkAttribution's contract. Adding
        // range.start back (the pre-fix code) made enemy rows absolute
        // full-grid indices, which both consumers resolve against their
        // enemy-only alive order: every enemy attribution missed the list
        // and degraded the side to candidate ranges.
        overlay_detect::sink_victims(&old_side, &new_side, was, now)
            .unwrap_or_default()
            .into_iter()
            .map(|i| i as u32)
            .collect()
    };
    let n = strips.len();
    attrib.ally_rows = side(0..ally_rows.min(n));
    attrib.enemy_rows = side(ally_rows.min(n)..n);
    if let Err(e) = app.emit(super::SINK_ATTRIB_EVENT, &attrib) {
        tracing::warn!(error = %e, "emit sink-attrib failed");
    }
    // The new frame becomes the diff baseline for the next transition.
    fsm.strip_baseline = Some(StripBaseline {
        battle,
        row_centers: rows,
        thumbs: new_thumbs,
    });
    let sunk = alive.iter().filter(|&&v| !v).count();
    // A row's alive flag settled: update the pin and re-place. The overlay
    // page re-derives its mapping from the sink attribution above plus the
    // alive vector the moment this anchor lands ([alive by sort key] ++
    // [sunk by sort key] — the same permutation the game just applied), so
    // there is no re-map to chase and no stale badge to raise.
    let mut updated = fsm
        .pinned_anchor
        .as_ref()
        .expect("checked above")
        .anchor
        .clone();
    updated.row_alive = Some(alive);
    if let Some(pin) = fsm.pinned_anchor.as_mut() {
        pin.anchor = updated.clone();
    }
    place_and_show(app, &updated);
    tracing::info!(
        sunk,
        rows = updated.row_centers.len(),
        attributed = attrib.ally_rows.len() + attrib.enemy_rows.len(),
        "sink probe: alive flags changed — pin updated"
    );
}
