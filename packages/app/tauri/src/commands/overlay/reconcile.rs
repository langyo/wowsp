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
    battle: i64,
    game_rect: Option<Rect>,
) -> bool {
    pin_table_detected
        && pin_battle == battle
        && game_rect.is_some_and(|r| rect_same_within(&r, pin_rect))
}

/// Pure: does this `row_players` payload count as "no trusted row→name
/// mapping"? Both `None` (recognition off, or the pipeline bailed) and a
/// vec where EVERY row failed to match (honest silence — text was read but
/// nothing stuck to the roster) leave the chips without trusted
/// attribution: the pending badge and the recognition catch-up stay on for
/// both.
pub(super) fn mapping_untrusted(players: &Option<Vec<Option<String>>>) -> bool {
    match players {
        None => true,
        Some(v) => v.iter().all(Option::is_none),
    }
}

/// Pure: does this payload leave at least one row WITHOUT a name? A
/// partially-matched mapping is trusted enough to render (the matched chips
/// are correct), but the unmatched rows are exactly the chips stuck on "…"
/// — the recognition catch-up stays armed on them so a later OCR read can
/// still fill the gaps. Strictly includes [`mapping_untrusted`].
pub(super) fn mapping_incomplete(players: &Option<Vec<Option<String>>>) -> bool {
    match players {
        None => true,
        Some(v) => v.iter().any(Option::is_none),
    }
}

/// Pure catch-up gate (unit-testable; time, engine availability and the
/// stale flag are injected by the caller): run a recognition catch-up pass
/// when a CONFIRMED pin is on screen and its row→name mapping needs a
/// fresh OCR read — because it still lacks a trusted mapping (absent, or
/// an all-`None` read: nothing matched), because rows are still unnamed
/// (a partial match leaves those chips on "…" until a later read names
/// them), or because the pin is STALE (the sink probe flipped alive flags;
/// the old mapping is battle-accurate but the rows re-sorted, so the
/// mapping must be re-read to confirm the new order) — while recognition
/// is enabled and the throttle says a pass may run.
///
/// Keeping the gate armed on an incomplete pin cannot oscillate: a
/// deterministic re-read of a row OCR cannot name yields the same
/// `None` again, the payload compares equal to the pin's mapping,
/// `should_transplant_rows` stays false and the pass re-emits nothing —
/// it only re-spends the (Tab-hold-only) capture budget.
pub(super) fn should_catch_up_recognition(
    pin: Option<&OverlayAnchor>,
    stale: bool,
    recognizer_on: bool,
    throttle_elapsed: bool,
) -> bool {
    pin.is_some_and(|p| p.table_detected && (mapping_incomplete(&p.row_players) || stale))
        && recognizer_on
        && throttle_elapsed
}

/// Pure move-replacement mapping carry (unit-tested): the anchor a layout
/// move should pin — `fresh`'s geometry with the OLD pin's row→name
/// mapping carried over when fresh has nothing better. The in-battle panel
/// shifts as a whole when HUD phases change, but the ROSTER is fixed for
/// the battle: the fresh detection's OCR has usually not even landed yet
/// (`row_players_pending` → the overlay would flash "recognizing
/// roster…"), while the pin's mapping is battle-accurate — rows re-sort
/// only when ships sink, and the sink fast-probe tracks exactly that.
///
/// - fresh carries its own trusted mapping → keep it (it is newer);
/// - the grids disagree on row count → never index-guess: fresh stays
///   unmapped;
/// - the pin has no trusted mapping (absent / all-`None`) → nothing worth
///   carrying.
pub(super) fn carry_mapping_into_fresh(
    fresh: &OverlayAnchor,
    pinned: &OverlayAnchor,
) -> OverlayAnchor {
    let mut out = fresh.clone();
    if !mapping_untrusted(&fresh.row_players) {
        return out;
    }
    let same_grid = out.row_centers.len() == pinned.row_centers.len();
    if same_grid && !mapping_untrusted(&pinned.row_players) {
        out.row_players = pinned.row_players.clone();
        out.row_alive = pinned.row_alive.clone();
        out.row_players_pending = pinned.row_players_pending;
    }
    out
}

/// Where a mapping that just landed on the pin came from — decides whether
/// it may clear the sink-lifecycle `stale` flag ([`stale_after_mapping`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MappingOrigin {
    /// This frame's own OCR produced the trusted mapping: the attribution on
    /// screen is CURRENT, so a set stale flag has done its job and clears.
    FreshOcr,
    /// The mapping was CARRIED from the OLD pin
    /// ([`carry_mapping_into_fresh`]): the names are battle-accurate, but
    /// the row order they describe is the PRE-sink one — exactly the
    /// mis-attribution `stale` exists to flag. Carrying it onto new
    /// geometry must never launder the flag away (and must never SET it
    /// either — carrying is not a data change, just a re-print).
    CarriedFromPin,
}

/// Pure stale lifecycle on the OCR side (unit-tested): only a TRUSTED
/// mapping produced by THIS frame's OCR ([`MappingOrigin::FreshOcr`]) means
/// the re-map has caught up — clear the stale flag. A trusted mapping
/// CARRIED from the old pin keeps the flag exactly as it was, and an
/// all-`None` landing (honest silence) or an absent mapping keeps it too:
/// the chips' attribution is still in flux and the fast catch-up must stay
/// armed.
pub(super) fn stale_after_mapping(
    stale: bool,
    mapping: &Option<Vec<Option<String>>>,
    origin: MappingOrigin,
) -> bool {
    if mapping_untrusted(mapping) {
        stale
    } else {
        match origin {
            MappingOrigin::FreshOcr => false,
            MappingOrigin::CarriedFromPin => stale,
        }
    }
}

/// Pure sink decision (unit-tested): did any row's alive flag change
/// between the pin's classification and a fresh strip read? Missing pin
/// data (recognition never ran) or a length mismatch reads as "no change"
/// — the sink channel only fires on comparable, same-grid data, never on a
/// guess.
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
    // Not comparable (recognition never produced a baseline, length
    // mismatch) or the read equals the pin: nothing to do — and a pending
    // candidate was just contradicted by the pin-matching read, so drop it.
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

/// Pure transplant decision (unit-testable): a fresh detection carries a
/// row→name mapping worth copying onto the pinned anchor. ALL of:
///
/// - the fresh anchor is a CONFIRMED table (a fallback detection never
///   touches the pin);
/// - its mapping covers exactly the pinned grid's rows — `row_players` is
///   indexed BY ROW, so a length mismatch means the two grids disagree and
///   the mapping would pin stats onto the wrong rows: dropped;
/// - the mapping actually DIFFERS (absent→present catch-up, an all-`None`
///   read landing for the first time, or a re-sort after sinks) — identical
///   mappings are dropped so a pass that found nothing new never re-emits
///   the anchor. The comparison includes `row_alive`: a ship can sink
///   WITHOUT moving rows (it already sat at its group's tail), and that
///   alive flip must still reach the overlay and the tab-order event.
pub(super) fn should_transplant_rows(fresh: &OverlayAnchor, pinned: &OverlayAnchor) -> bool {
    fresh.table_detected
        && fresh.row_players.as_ref().map(Vec::len) == Some(pinned.row_centers.len())
        && (fresh.row_players != pinned.row_players || fresh.row_alive != pinned.row_alive)
}

/// Pure transplant: the pinned anchor with `fresh`'s row→name mapping and
/// alive flags (and pending flag) copied in — every geometry field untouched
/// (the mapping is indexed by row, and the rows themselves did not move).
/// `None` when [`should_transplant_rows`] says there is nothing to
/// transplant.
pub(super) fn transplant_row_players(
    pinned: &OverlayAnchor,
    fresh: &OverlayAnchor,
) -> Option<OverlayAnchor> {
    if !should_transplant_rows(fresh, pinned) {
        return None;
    }
    let mut updated = pinned.clone();
    updated.row_players = fresh.row_players.clone();
    updated.row_alive = fresh.row_alive.clone();
    // Pending survives an all-`None` transplant (honest silence is not a
    // trusted mapping — the badge and the catch-up stay on); only a
    // mapping that matched at least one row clears it.
    updated.row_players_pending = mapping_untrusted(&updated.row_players);
    Some(updated)
}

/// Build the [`TAB_ORDER_EVENT`] payload from a placed anchor: the rows'
/// matched names in on-screen order plus their alive flags, split into the
/// ally/enemy blocks at the ROSTER's relation count. `None` when the anchor
/// carries no trusted mapping (fewer than one matched row) — the event then
/// has nothing honest to say and is not emitted at all.
///
/// The split uses the roster's own relation counts rather than the detection
/// grid's `ally_rows`: tempArenaInfo.json is STATIC for the whole battle, so
/// the relation count cannot drift mid-battle — it is exactly the block
/// boundary the panel's own two sub-tables draw. Rows beyond the roster's
/// ally count belong to the enemy block; unmatched rows are inert for the
/// consumer (it matches by name).
pub(super) fn tab_order_from_anchor(
    anchor: &OverlayAnchor,
    info: &wowsp_tauri_shared::ArenaInfo,
) -> Option<TabRowOrder> {
    let names = anchor.row_players.as_ref()?;
    if mapping_untrusted(&anchor.row_players) {
        return None;
    }
    let alive = anchor.row_alive.as_ref();
    let row = |i: usize| TabRowPlayer {
        name: names.get(i).cloned().flatten(),
        alive: alive.and_then(|a| a.get(i).copied()).unwrap_or(true),
    };
    let allies_n = info.vehicles.iter().filter(|v| v.relation <= 1).count();
    // Slice bounds: the ally block is the roster count capped at the
    // mapping length (a shorter mapping truncates the block rather than
    // spilling), the enemy block is everything after it up to the mapping.
    let ally_end = allies_n.min(names.len());
    Some(TabRowOrder {
        date_time: info.date_time.clone(),
        battle: super::arena_info::last_arena_stamp(),
        allies: (0..ally_end).map(row).collect(),
        enemies: (ally_end..names.len()).map(row).collect(),
    })
}

/// One revalidation pass over the pinned anchor while the overlay is shown:
/// re-run the capture + detector against the live frame and reconcile the
/// pin with it. Two outcomes change the pin (re-emitting the anchor):
///
/// - the table MOVED at row scale (`overlay_detect::anchor_meaningfully_moved`)
///   → the pin is replaced by [`carry_mapping_into_fresh`]: fresh geometry,
///   fresh recognition when trusted, otherwise the old pin's trusted
///   mapping carried over — a HUD-phase move must not flash "recognizing
///   roster…" for the seconds the fresh OCR takes to land;
/// - the geometry is unchanged but the row→name mapping CHANGED
///   ([`transplant_row_players`] — first recognition landing after the pin
///   because the arena roster file was late, or a re-read after sinks
///   re-sorted the rows) → only `row_players` / `row_alive` /
///   `row_players_pending` are transplanted onto the pin, geometry
///   untouched.
///
/// Every other outcome — a failed capture, a fallback detection, sub-pitch
/// jitter, an identical mapping — keeps the pin and emits nothing, so this
/// pass can never make the chips wander. Status reports are only touched by
/// the move-replacement (whose row count may change); a transplant keeps the
/// `detected` state and merely re-renders the chips. `last_revalidate` is
/// bumped unconditionally: the pass costs a full capture attempt regardless
/// of its outcome. A trusted mapping landing from FRESH OCR clears the FSM's
/// stale flag ([`MappingOrigin::FreshOcr`]); a mapping CARRIED from the old
/// pin onto a moved grid does not — it still describes the pre-sink row
/// order, so the stale flag survives until this frame's own OCR confirms
/// the new order.
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
        // Fresh geometry + the best available mapping (see
        // `carry_mapping_into_fresh`), re-keyed to the CURRENT battle +
        // window geometry: the fresh anchor was computed from THIS frame,
        // so it belongs to this geometry.
        let carried = carry_mapping_into_fresh(&fresh, &pinned);
        fsm.pinned_anchor = Some(PinnedAnchor {
            battle: super::arena_info::last_arena_stamp(),
            game_rect: rect_from_win32(g.rect),
            anchor: carried.clone(),
        });
        // Only a trusted mapping produced by THIS frame's OCR clears the
        // stale flag. When the replacement CARRIED the old pin's mapping
        // (fresh recognition not landed yet), the on-screen row order still
        // describes the pre-sink state — the flag must survive the move so
        // the accelerated catch-up keeps chasing until fresh OCR confirms
        // the new order. (A carried mapping never SETS the flag either.)
        let fresh_ocr = !mapping_untrusted(&fresh.row_players);
        let origin = if fresh_ocr {
            MappingOrigin::FreshOcr
        } else {
            MappingOrigin::CarriedFromPin
        };
        fsm.stale = stale_after_mapping(fsm.stale, &carried.row_players, origin);
        place_and_show(app, &carried, fsm.stale);
        report_status(
            app,
            fsm,
            OverlayState::Detected,
            Some(carried.row_centers.len() as u32),
        );
        return;
    }
    // Geometry unchanged (sub-pitch jitter): only the row→name mapping may
    // have caught up or been re-sorted. Transplant it — and re-emit the
    // anchor so the overlay re-renders its chips — when fresh recognition
    // disagrees with the pin; otherwise emit nothing.
    if let Some(updated) = transplant_row_players(&pinned, &fresh) {
        tracing::info!(
            rows = updated.row_centers.len(),
            matched = updated
                .row_players
                .as_ref()
                .map(|r| r.iter().filter(|n| n.is_some()).count())
                .unwrap_or(0),
            "row recognition caught up — transplanting the mapping onto the pin"
        );
        // A transplant always copies THIS frame's OCR (see
        // `should_transplant_rows`): a trusted landing clears stale.
        fsm.stale = stale_after_mapping(fsm.stale, &updated.row_players, MappingOrigin::FreshOcr);
        if let Some(pin) = fsm.pinned_anchor.as_mut() {
            pin.anchor = updated.clone();
        }
        place_and_show(app, &updated, fsm.stale);
    }
}

/// One SINK FAST-PATH pass (overlay shown + confirmed pin): capture the
/// game window once and read every row's alive flag straight off the
/// PINNED geometry — strip crops + brightest-glyph luma only, no OCR, no
/// detection, no roster read ([`overlay_detect::read_row_alive`]). A
/// settled alive-flag flip (see [`sink_probe_confirm`]: a SINK applies
/// immediately, a pure revival needs two agreeing probes) then:
///
/// - updates the pin's `row_alive` and re-places the anchor (the chips
///   gray out and re-sort; a trusted mapping also re-emits the tab order
///   inside `place_and_show`);
/// - raises the FSM's `stale` flag (wire-visible) — the old row→name
///   mapping describes the pre-sink order;
/// - clears `last_catch_up`, so the OCR re-map fires on the next tick at
///   the accelerated [`SINK_CATCHUP_INTERVAL`] cadence.
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
    // (recognition never produced alive flags, or no cache to gate the band
    // with) must not pay a BitBlt.
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
    let fresh = overlay_detect::read_row_alive(&rgba, w, h, &roster, &rows, split, ally_rows);
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
        return;
    };
    let sunk = alive.iter().filter(|&&v| !v).count();
    // A row's alive flag settled: update the pin and re-place. In the OCR
    // mode the names→rows attribution is stale until the re-read lands, so
    // the pin flags stale and the fast OCR re-map re-derives the (re-sorted)
    // mapping. The INFERRED mode needs no re-read at all: the overlay page
    // re-derives its mapping from the alive vector the moment this anchor
    // lands ([alive by sort rule] ++ [sunk by sort rule] — the same
    // permutation the game just applied), so no stale badge, no remap.
    let inferred =
        super::overlay_config::roster_mode() == super::overlay_config::RosterRecognition::Inferred;
    let mut updated = fsm
        .pinned_anchor
        .as_ref()
        .expect("checked above")
        .anchor
        .clone();
    updated.row_alive = Some(alive);
    if !inferred {
        fsm.stale = true;
        fsm.last_catch_up = None;
    }
    if let Some(pin) = fsm.pinned_anchor.as_mut() {
        pin.anchor = updated.clone();
    }
    place_and_show(app, &updated, !inferred);
    tracing::info!(
        sunk,
        rows = updated.row_centers.len(),
        inferred,
        "sink probe: alive flags changed — pin updated"
    );
}
