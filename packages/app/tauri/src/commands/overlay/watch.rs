use super::*;
// ─────────────────────────────────────────────────────────────────────────
// Tab watcher
// ─────────────────────────────────────────────────────────────────────────

/// Handle of the running Tab watcher thread (if any).
static TAB_WATCHER: Mutex<Option<TabWatcher>> = Mutex::new(None);

struct TabWatcher {
    stop: Arc<AtomicBool>,
    /// Detached thread handle — never joined (see `start_overlay_tab_watch`).
    #[allow(dead_code)]
    handle: std::thread::JoinHandle<()>,
}

/// Start the global Tab watcher (idempotent). It polls `GetAsyncKeyState`
/// (purely passive — no hook installed) and, while the game window is the
/// foreground window, anchors + shows the overlay on Tab down and hides it on
/// Tab up / focus loss.
#[tauri::command]
pub async fn start_overlay_tab_watch(app: AppHandle) -> Result<(), String> {
    let mut guard = TAB_WATCHER
        .lock()
        .map_err(|e| format!("watcher lock: {e}"))?;
    if guard
        .as_ref()
        .is_some_and(|w| !w.stop.load(Ordering::Relaxed))
    {
        return Ok(()); // already running
    }
    // Drop any stale watcher WITHOUT joining it: joining under the lock
    // deadlocks if the old thread is itself waiting on a main-thread window
    // dispatch. The stop flag makes it exit within one poll interval; the
    // detached handle is simply dropped.
    *guard = None;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = std::thread::Builder::new()
        .name("overlay-tab-watch".into())
        .spawn(move || watch_tab_loop(app, thread_stop))
        .map_err(|e| format!("spawn tab watcher: {e}"))?;
    *guard = Some(TabWatcher { stop, handle });
    tracing::info!("overlay tab watcher started");
    Ok(())
}

/// Stop the Tab watcher.
#[tauri::command]
pub async fn stop_overlay_tab_watch() -> Result<(), String> {
    let mut guard = TAB_WATCHER
        .lock()
        .map_err(|e| format!("watcher lock: {e}"))?;
    if let Some(w) = guard.take() {
        w.stop.store(true, Ordering::Relaxed);
        // Leave the thread to exit on its own next tick; joining here would
        // block the IPC thread for up to one poll interval otherwise.
    }
    // Watcher teardown drops pending commands with it — same semantics as
    // the old manual-anchor teardown: a ManualAnchorSet that lost the race
    // against overlay-mode teardown must not re-arm itself in the NEXT
    // overlay session, and a stale BattleChanged is re-derived anyway (the
    // fresh watcher reads the arena stamp per tick).
    if let Ok(mut q) = WATCH_COMMANDS.lock() {
        q.clear();
    }
    tracing::info!("overlay tab watcher stopped");
    Ok(())
}

/// A table anchor pinned to ONE battle (arena stamp) and one game-window
/// geometry: while both hold, every Tab press reuses this anchor verbatim —
/// per-press re-detection drifted frame to frame and the chips wandered.
/// The pin is not blind, though: while the overlay stays shown it is
/// re-validated every [`ANCHOR_REVALIDATE_INTERVAL`] and replaced when the
/// panel itself moved at row scale (HUD phase changes shift the whole table;
/// see the constant's comment) — otherwise the countdown position would be
/// kept all battle long.
#[cfg(target_os = "windows")]
pub(super) struct PinnedAnchor {
    pub(super) battle: i64,
    pub(super) game_rect: Rect,
    pub(super) anchor: OverlayAnchor,
}

/// Geometry-cache identity: the game window's SIZE and its style bits —
/// deliberately NOT its origin. The cached band/grid is CAPTURE-relative
/// (the capture always covers the clamped game rect), so a pure window
/// MOVE leaves the pixel geometry identical and re-detecting would only
/// burn a full scan (and flicker a re-acquisition). A size change — real
/// resize, or the monitor-edge clamp biting differently — or a window-MODE
/// switch (borderless ↔ windowed can keep the outer size while
/// `GWL_STYLE`/`GWL_EXSTYLE` change) retires the cache.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct GeometryKey {
    pub(super) game_size: (i32, i32),
    pub(super) style_bits: u64,
}

/// One full detection's worth of pixel geometry, cached per game-window
/// mode: the located header band, the roster grid detected WITH it (same
/// frame, phase refinement included) and the team sizes the grid was built
/// for. Every later capture first verifies the band cheaply
/// ([`overlay_detect::verify_header_band`]); a pass reuses the cached grid
/// verbatim, a team-size change rebuilds from the band, and repeated
/// misses retire the entry.
#[cfg(target_os = "windows")]
pub(super) struct GeometryCacheEntry {
    pub(super) key: GeometryKey,
    pub(super) band: overlay_detect::HeaderBand,
    pub(super) roster: overlay_detect::DetectedRoster,
    pub(super) team_sizes: (usize, usize),
}

/// All mutable watcher state in ONE struct (the loop's single-owner state
/// machine): the want-visible bookkeeping, the pin, the manual anchor, the
/// cadence stamps, the status mirror, the sink fast-path's stale flag and
/// the geometry cache. The loop owns it exclusively; commands and cadenced
/// passes mutate it through `&mut` — no other thread writes any of it, so
/// the status mirror's dedup is exact (the old scattered statics + direct
/// emits had none of those guarantees).
#[cfg(target_os = "windows")]
#[derive(Default)]
pub(super) struct WatchFsm {
    /// Whether the overlay window is logically shown (the watcher placed it
    /// and has not hidden it since).
    pub(super) overlay_shown: bool,
    pub(super) pinned_anchor: Option<PinnedAnchor>,
    /// Whether the CURRENTLY shown overlay is the manual anchor's placement
    /// (vs an automatic detection): gates the one-shot manual place_and_show
    /// so a live manual anchor does not re-place every 30 ms tick.
    pub(super) manual_shown: bool,
    pub(super) manual_anchor: Option<ManualAnchor>,
    /// Cached game-window resolution (handle + clamp time).
    pub(super) cached_game: Option<(GameWindow, Instant)>,
    /// When the last game-window SCAN ran — bounds find_game_window() even
    /// when it keeps failing (each call takes a full Toolhelp process
    /// snapshot; a failing lookup retried every poll tick would peg a core).
    pub(super) last_scan: Option<Instant>,
    /// When the last capture ATTEMPT ran (success or failure) — bounds the
    /// expensive BitBlt + detector work even under frantic Tab tapping.
    pub(super) last_capture_attempt: Option<Instant>,
    /// When the last hide was sent — spaces out the hide retries.
    pub(super) last_hide: Option<Instant>,
    /// When the last battle-state refresh ran.
    pub(super) last_state_refresh: Option<Instant>,
    /// When the last pinned-anchor revalidation ran.
    pub(super) last_revalidate: Option<Instant>,
    /// When the last recognition CATCH-UP pass ran.
    pub(super) last_catch_up: Option<Instant>,
    /// When the last sink fast-probe ran (independent of every other stamp:
    /// the probe is deliberately far cheaper and faster than a revalidate).
    pub(super) last_sink_check: Option<Instant>,
    /// Mirror of the LAST `wowsp://overlay-status` payload emitted (None =
    /// nothing emitted yet). report_status() drops reports identical to it,
    /// so the per-tick status pushes are edge events, not level events.
    pub(super) last_status: Option<OverlayStatus>,
    /// True when the pin's row data just changed under the chips (the sink
    /// probe flipped alive flags) and the row→name re-map is still catching
    /// up: rides the wire on every status + anchor emission until a trusted
    /// mapping lands.
    pub(super) stale: bool,
    /// Pending sink-probe REVIVAL candidate (pure-debounce state, see
    /// [`sink_probe_confirm`]): a probe read that only flipped sunk rows
    /// back to alive — almost always a single-frame glare/explosion
    /// artifact — waits here for the NEXT probe to agree before the pin is
    /// updated. `None` when nothing is pending.
    pub(super) sink_candidate: Option<(Vec<bool>, Instant)>,
    /// Per-game-window-mode table geometry (see [`GeometryCacheEntry`]).
    pub(super) geometry_cache: Option<GeometryCacheEntry>,
    /// Consecutive band-verify misses on the current cache entry.
    pub(super) geometry_verify_fails: u32,
}

/// Push a detection-status report to ALL windows — but only when it differs
/// from the last emitted one: the tick runs at ~30 Hz and its branches
/// re-enter every poll, while the consumer (the live-battle panel badge)
/// wants edge events, not level events. `fsm.last_status` is the mirror of
/// what already went out (`None` = nothing emitted yet). The watcher loop
/// is the ONLY emitter — the manual-anchor commands arrive through the FIFO
/// queue and are reported from `apply_watch_command` here — so the mirror
/// covers every emission and the dedup is exact.
///
/// While a manual anchor is STORED (armed, whatever its liveness), every
/// automatic report carries `manual: true` and the anchor's row count: the
/// panel's green manual badge + clear button must survive Idle/Searching
/// transitions, because the anchor itself does — it re-anchors on the same
/// battle's next Tab hold. The payload's `stale` mirrors the FSM's
/// pin-staleness flag (a stale flip carries no state transition, which is
/// exactly why the pin path reports every tick and lets this dedup decide).
#[cfg(target_os = "windows")]
pub(super) fn report_status(
    app: &AppHandle,
    fsm: &mut WatchFsm,
    state: OverlayState,
    rows: Option<u32>,
) {
    let manual_rows = stored_manual_rows(fsm.manual_anchor.as_ref());
    let manual = manual_rows.is_some() || state == OverlayState::Manual;
    let status = OverlayStatus {
        state,
        rows: rows.or(manual_rows.filter(|_| manual)),
        manual,
        stale: fsm.stale,
    };
    if fsm.last_status == Some(status) {
        return;
    }
    fsm.last_status = Some(status);
    if let Err(e) = app.emit(OVERLAY_STATUS_EVENT, status) {
        tracing::warn!(error = %e, "emit overlay-status failed");
    }
}

/// The watcher loop — see the module docs for the interaction contract.
#[cfg(target_os = "windows")]
fn watch_tab_loop(app: AppHandle, stop: Arc<AtomicBool>) {
    // All mutable watcher state lives in ONE machine: a panicked tick leaves
    // a coherent struct behind, and the catch_unwind boundary passes a
    // single `&mut` through instead of a dozen loose locals.
    let mut fsm = WatchFsm::default();

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // A panicked tick must not kill the thread: a dead watcher can no
        // longer observe the Tab release and the overlay would stay on
        // screen forever. The next tick re-syncs all state.
        let tick = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            watch_tab_tick(&app, &mut fsm);
        }));
        if tick.is_err() {
            tracing::warn!("tab watcher tick panicked — continuing on the next tick");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    // Never leave the overlay behind when the watcher dies.
    if fsm.overlay_shown {
        hide_overlay(&app);
    }
    // Nor a stale badge in the main window: drop the panel to idle (a no-op
    // when the last emitted state already was idle). The manual anchor and
    // the stale flag are cleared FIRST — they live in this FSM and die with
    // the loop — so the exit report already carries manual: false.
    fsm.manual_anchor = None;
    fsm.stale = false;
    report_status(&app, &mut fsm, OverlayState::Idle, None);
}

/// Apply one FIFO command to the FSM. Pure-ish (no emit, no AppHandle) so
/// the ordering semantics are unit-testable; returns the status report the
/// caller should emit, if any.
#[cfg(target_os = "windows")]
pub(super) fn apply_watch_command(
    fsm: &mut WatchFsm,
    cmd: WatchCommand,
) -> Option<(OverlayState, Option<u32>)> {
    match cmd {
        WatchCommand::ManualAnchorSet {
            rect,
            game_rect,
            battle,
            team_sizes,
        } => {
            fsm.manual_anchor = Some(ManualAnchor {
                battle,
                game_rect,
                rect,
                team_sizes,
            });
            tracing::info!(battle, "manual roster anchor armed");
            // Immediate panel feedback (green "manually located" badge + the
            // button flips to "clear") — the same payload the old direct
            // emit produced, now ordered through the loop. report_status's
            // dedup swallows the loop's own re-report when the chips place.
            Some((
                OverlayState::Manual,
                Some((team_sizes.0 + team_sizes.1) as u32),
            ))
        },
        WatchCommand::ManualAnchorCleared => {
            if fsm.manual_anchor.take().is_some() {
                tracing::info!("manual anchor cleared by user");
            }
            // Report the state the overlay is ACTUALLY in — an unconditional
            // "searching" would stick forever while hidden (the hide branch
            // only runs while shown), and a live automatic pin means the
            // chips are still anchored (no Detected→Searching flicker).
            let state = if !fsm.overlay_shown {
                OverlayState::Idle
            } else if fsm
                .pinned_anchor
                .as_ref()
                .is_some_and(|p| p.anchor.table_detected)
            {
                OverlayState::Detected
            } else {
                OverlayState::Searching
            };
            Some((state, None))
        },
        WatchCommand::BattleChanged => {
            // A new battle voids the pin outright (its geometry belongs to
            // the old HUD phase and its row order to the old roster). The
            // geometry cache deliberately SURVIVES: same window rect+style
            // means the same pixel geometry, and a new battle shape is
            // rebuilt from the cached band without a rescan.
            let had_pin = fsm.pinned_anchor.take().is_some();
            fsm.stale = false;
            fsm.sink_candidate = None;
            fsm.last_catch_up = None;
            fsm.last_revalidate = None;
            fsm.last_sink_check = None;
            tracing::info!(had_pin, "arena stamp changed — pin voided by FIFO command");
            // No immediate report: the next tick re-derives the honest state
            // (Searching while acquiring, Idle while hidden) and reports it
            // through the dedup mirror.
            None
        },
    }
}

/// Drain the whole command queue in FIFO order, applying each to the FSM
/// and emitting the command-driven status reports. Runs at the top of every
/// tick so the tick's own decisions always see the queued inputs applied.
#[cfg(target_os = "windows")]
fn drain_watch_commands(app: &AppHandle, fsm: &mut WatchFsm) {
    loop {
        let cmd = WATCH_COMMANDS.lock().ok().and_then(|mut q| q.pop_front());
        let Some(cmd) = cmd else {
            break;
        };
        if let Some((state, rows)) = apply_watch_command(fsm, cmd) {
            report_status(app, fsm, state, rows);
        }
    }
}

/// One poll iteration of the Tab watcher (factored out so the loop can wrap
/// it in `catch_unwind`).
#[cfg(target_os = "windows")]
fn watch_tab_tick(app: &AppHandle, fsm: &mut WatchFsm) {
    // FIFO command pipeline first: every cross-thread input (manual anchor
    // set/clear, arena battle change) lands in push order before this tick's
    // own decisions read the state.
    drain_watch_commands(app, fsm);

    // Resolve the game window: cached while valid, rescanned at most
    // once per HWND_REFRESH — including the not-found case.
    let game = match fsm.cached_game {
        Some((g, at)) if at.elapsed() < HWND_REFRESH && g.is_alive() => Some(g),
        _ if fsm.last_scan.is_none_or(|t| t.elapsed() >= HWND_REFRESH) => {
            fsm.last_scan = Some(Instant::now());
            let found = find_game_window();
            fsm.cached_game = found.map(|g| (g, Instant::now()));
            found
        },
        _ => fsm
            .cached_game
            .filter(|(g, _)| g.is_alive())
            .map(|(g, _)| g),
    };

    let focused_on_game = game.is_some_and(|g| g.is_foreground());
    let tab_down = tab_key_down();

    // Table-anchoring switch (`overlay-config.toml`, written by the
    // settings modal): `table: "off"` disables the WHOLE Tab overlay.
    // The webui never creates the overlay window + watcher while it is
    // off and tears them down on the off edge; this cached read is the
    // Rust-side belt-and-suspenders — a stray tick (or a stale watcher
    // outliving the webui's teardown) must never show the window
    // against the setting, and an already-shown one hides again as soon
    // as `want_visible` flips false below.
    let table_off = super::overlay_config::table_overlay_off();

    // WANT-VISIBLE state machine instead of press-edge triggering: the
    // previous edge-only model did all its work exactly once per press,
    // so a single failed capture (transient scene-probe miss, rate-limit
    // window) meant the overlay stayed down until Tab was released and
    // pressed again — rapid tapping then felt permanently dead ("按不出
    // 来了"). Here, holding Tab with the game focused DURING a battle is
    // the standing want; each rate-limit window retries acquisition
    // until it succeeds.
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    if focused_on_game
        && tab_down
        && !battle_known
        && fsm
            .last_state_refresh
            .is_none_or(|t| t.elapsed() >= STATE_REFRESH)
    {
        fsm.last_state_refresh = Some(Instant::now());
        battle_known = super::arena_info::refresh_battle_state();
        tracing::debug!(battle_known, "tab held: refreshed battle state");
    }
    // The manual-locate picker covers the game and owns the pointer:
    // while it exists the overlay must never fight it for screen space,
    // and it is torn down when the game window disappears underneath it.
    let picker_open = app.get_webview_window(MANUAL_LOCATE_LABEL).is_some();
    if picker_open && game.is_none() {
        destroy_manual_locate_window(app);
    }

    let battle = super::arena_info::last_arena_stamp();
    let game_rect = game.map(|g| rect_from_win32(g.rect));
    // MANUAL anchor first: while a user-drawn box is in force for THIS
    // battle on THIS game-window geometry, it replaces the entire
    // automatic machine for the tick — no capture, no detector, no pin.
    // The 5 s revalidation never touches it (there is nothing to
    // re-detect about a hand-drawn box), and hiding the overlay does
    // not expire it (the same battle's next Tab hold re-places it). It
    // shares the auto path's preconditions (game focused + Tab held +
    // battle known), minus the picker.
    let manual_active = if !picker_open && focused_on_game && tab_down && battle_known && !table_off
    {
        match manual_anchor_check(fsm.manual_anchor.as_ref(), battle, game_rect) {
            ManualAnchorCheck::Live(m, r) => Some((m, r)),
            ManualAnchorCheck::Stale => {
                // New battle, or the game window moved/resized: expire
                // silently back to the automatic flow (the panel status
                // flips via the normal searching/idle reports).
                tracing::info!(battle, "manual anchor expired — back to auto detection");
                fsm.manual_anchor = None;
                None
            },
            // Nothing stored — or no game rect this tick to judge the
            // window-geometry half with.
            ManualAnchorCheck::Inert => None,
        }
    } else {
        None
    };

    let want_visible = focused_on_game && tab_down && battle_known && !picker_open && !table_off;
    if let Some((m, manual_game)) = manual_active {
        // Place ONCE per manual hold, not every 30 ms tick.
        if !fsm.overlay_shown || !fsm.manual_shown {
            let anchor = build_manual_anchor(&m, manual_game);
            // Manual placement is fully current data — any leftover stale
            // flag from a previous automatic pin does not apply to it.
            fsm.stale = false;
            place_and_show(app, &anchor, false);
            report_status(
                app,
                fsm,
                OverlayState::Manual,
                Some(anchor.row_centers.len() as u32),
            );
            fsm.overlay_shown = true;
            fsm.manual_shown = true;
            fsm.last_hide = None;
        }
        // The manual anchor owns this tick: neither the automatic
        // acquisition path below nor the hide-retry branch may touch
        // the overlay while it stays live.
        return;
    }
    fsm.manual_shown = false;
    if want_visible {
        // A CONFIRMED pin valid for the CURRENT battle + game-window
        // geometry is the only "done" state (see `pin_matches` for the
        // exact keys). Resolving it FIRST — before any status decision —
        // is the no-flicker rule: the old tick reported Searching at the
        // top of this branch and only then looked for a reusable pin, so
        // every Tab re-press flashed "locating…" for one tick before the
        // chips came back.
        let pin_valid = fsm.pinned_anchor.as_ref().is_some_and(|p| {
            pin_matches(
                p.battle,
                &p.game_rect,
                p.anchor.table_detected,
                battle,
                game_rect,
            )
        });
        let held = held_status(
            pin_valid,
            fsm.last_status
                .as_ref()
                .is_some_and(|s| s.state == OverlayState::Fallback),
        );
        if held == HeldStatus::Pin {
            let g = game.expect("want_visible implies a resolved game window");
            let pin = fsm.pinned_anchor.as_ref().expect("pin_valid implies a pin");
            let anchor = pin.anchor.clone();
            if !fsm.overlay_shown {
                // Re-show this battle's pin verbatim — no capture, no
                // Searching detour, the chips are where they were.
                place_and_show(app, &anchor, fsm.stale);
                fsm.overlay_shown = true;
                fsm.last_hide = None;
                // The anchor on screen is fresh as of NOW: start the
                // revalidation clock here so the first re-check waits a
                // full interval instead of firing on the next tick.
                fsm.last_revalidate = Some(Instant::now());
            }
            // Status EVERY tick of the pin path (deduped by the mirror): a
            // stale flip — sink detected, or the OCR re-map landing — is a
            // payload change with no state transition to carry it.
            report_status(
                app,
                fsm,
                OverlayState::Detected,
                Some(anchor.row_centers.len() as u32),
            );
            // Cadenced work while the pin is up — at most ONE capture per
            // tick, priority: sink probe (cheapest, most time-critical) →
            // recognition catch-up → full revalidation. A branch that fires
            // bumps only its own stamp, so the others simply run on a later
            // tick (their `due` conditions stay armed).
            if fsm
                .last_sink_check
                .is_none_or(|t| t.elapsed() >= SINK_CHECK_INTERVAL)
            {
                sink_check_pass(app, fsm, &g);
            } else if should_catch_up_recognition(
                Some(&anchor),
                fsm.stale,
                row_recognize::ocr_active(),
                fsm.last_catch_up.is_none_or(|t| {
                    t.elapsed()
                        >= if fsm.stale {
                            SINK_CATCHUP_INTERVAL
                        } else {
                            CAPTURE_MIN_INTERVAL
                        }
                }),
            ) {
                // The pin needs its row→name mapping (re)read: run the SAME
                // revalidation pass at the (stale-accelerated) catch-up
                // cadence instead of waiting the full 5 s — the fresh pass
                // both re-checks the geometry and carries a new row→name
                // mapping for the transplant inside. The pass bumps
                // last_revalidate itself, so the two cadences never stack.
                fsm.last_catch_up = Some(Instant::now());
                revalidate_pinned_anchor(app, fsm, Some(g));
            } else if fsm
                .last_revalidate
                .is_none_or(|t| t.elapsed() >= ANCHOR_REVALIDATE_INTERVAL)
            {
                // Periodically re-check the pin against a live detection —
                // the panel moves as a whole when HUD phases change
                // (countdown → combat) and neither pin key (arena stamp,
                // window rect) can see it.
                revalidate_pinned_anchor(app, fsm, Some(g));
            }
        } else {
            // ACQUISITION: no pin matched this battle + geometry — the one
            // arm where Searching (or the Fallback continuation) is honest.
            // The unambiguous "tried and failed" signal is the centered
            // fallback hint being what's on screen (it is emitted only from
            // the places below that put/keep the hint up, and every hide
            // resets it to Idle); everything else reads as Searching, and
            // report_status dedups the per-tick re-pushes.
            if held == HeldStatus::Fallback {
                report_status(app, fsm, OverlayState::Fallback, None);
            } else {
                report_status(app, fsm, OverlayState::Searching, None);
            }
            let Some(g) = game else {
                return;
            };
            if !fsm
                .last_capture_attempt
                .is_none_or(|t| t.elapsed() >= CAPTURE_MIN_INTERVAL)
            {
                tracing::debug!("tab held: capture rate-limited, waiting");
                return;
            }
            fsm.last_capture_attempt = Some(Instant::now());
            let computed = compute_anchor(&g, fsm);
            if let Some(anchor) = computed.as_ref().filter(|a| a.table_detected) {
                fsm.pinned_anchor = Some(PinnedAnchor {
                    battle,
                    game_rect: rect_from_win32(g.rect),
                    anchor: anchor.clone(),
                });
                // A fresh pin restarts the stale lifecycle: brand-new
                // recognition, nothing to re-map yet.
                fsm.stale = false;
                fsm.sink_candidate = None;
                fsm.last_sink_check = Some(Instant::now());
            }
            if let Some(anchor) = computed {
                // Place when the overlay is not up yet, or when a
                // CONFIRMED anchor must replace the on-screen hint;
                // re-placing an identical fallback hint every rate-limit
                // window would only churn the event pipe.
                if !fsm.overlay_shown || anchor.table_detected {
                    place_and_show(app, &anchor, fsm.stale);
                }
                // Status: what is on screen NOW. A confirmed anchor pins
                // the chips (detected + row count); a fallback anchor is
                // (or would re-place) the centered hint. place_and_show
                // may skip a redundant re-place of the hint, but the
                // hint staying up is still Fallback — and the mirror
                // dedup swallows the no-op anyway.
                if anchor.table_detected {
                    report_status(
                        app,
                        fsm,
                        OverlayState::Detected,
                        Some(anchor.row_centers.len() as u32),
                    );
                } else {
                    report_status(app, fsm, OverlayState::Fallback, None);
                }
                fsm.overlay_shown = true;
                fsm.last_hide = None;
                // The anchor on screen is fresh as of NOW (a new pin, or
                // this battle's pin re-shown): start the revalidation
                // clock here so the first re-check waits a full interval
                // instead of firing on the next tick.
                fsm.last_revalidate = Some(Instant::now());
            }
            // A failed acquisition while ALREADY shown keeps the old
            // anchor on screen — the previous behavior of hiding here
            // made a single failed re-capture blink the overlay off.
        }
    } else if fsm.overlay_shown {
        // Keep re-sending the hide while the overlay should be down:
        // each attempt posts one async Win32 command + one event, and
        // any single one can be lost; both are idempotent. Retries stop
        // once the window reports itself actually hidden.
        if fsm.last_hide.is_none_or(|t| t.elapsed() >= HIDE_RETRY) {
            hide_overlay(app);
            // Overlay going down — drop the panel badge to idle. The
            // mirror dedup keeps the hide-retry re-sends from emitting
            // this more than once.
            report_status(app, fsm, OverlayState::Idle, None);
            fsm.last_hide = Some(Instant::now());
            if !overlay_window_visible(app) {
                fsm.overlay_shown = false;
            }
        }
    }
}

/// Whether the overlay window currently reports as visible (false when it is
/// missing). Used to stop the hide-retry loop once the hide really landed,
/// and by `clear_manual_roster_rect` to pick the honest post-clear state.
#[cfg(target_os = "windows")]
fn overlay_window_visible(app: &AppHandle) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|win| win.hwnd().ok())
        .map(|hwnd| unsafe { IsWindowVisible(windows::Win32::Foundation::HWND(hwnd.0)).as_bool() })
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn overlay_window_visible(_app: &AppHandle) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
fn watch_tab_loop(_app: AppHandle, _stop: Arc<AtomicBool>) {}
