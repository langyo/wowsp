use anyhow::anyhow;
use wowsp_tauri_shared::CommandResult;

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
pub async fn start_overlay_tab_watch(app: AppHandle) -> CommandResult<()> {
    let mut guard = TAB_WATCHER
        .lock()
        .map_err(|e| anyhow!("watcher lock: {e}"))?;
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
        .map_err(|e| anyhow!("spawn tab watcher: {e}"))?;
    *guard = Some(TabWatcher { stop, handle });
    tracing::info!("overlay tab watcher started");
    Ok(())
}

/// Stop the Tab watcher.
#[tauri::command]
pub async fn stop_overlay_tab_watch() -> CommandResult<()> {
    let mut guard = TAB_WATCHER
        .lock()
        .map_err(|e| anyhow!("watcher lock: {e}"))?;
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
    /// Client kind the pin was detected under — a pin acquired while the
    /// kind resolution briefly failed (it defaults to Wargaming) must not
    /// survive into a correctly-resolved session: the two profiles' row
    /// grids differ, and only the FIRST row center moves little enough for
    /// the move check to notice.
    pub(super) kind: wowsp_tauri_shared::GameInstallKind,
    /// Strip-layout profile the pin's `row_alive` was read under (see
    /// `overlay_detect::resolve_wg_strip_profile`). The sink fast-path
    /// keys its strip crops on THIS, not on the geometry cache's — the
    /// cache can die and refill with a flipped resolution mid-battle
    /// (an aberrant frame), and the pin's own luma vector + strip
    /// baseline must stay mutually consistent whatever the cache does.
    pub(super) profile: overlay_detect::DetectProfile,
    pub(super) anchor: OverlayAnchor,
}

/// Geometry-cache identity: the game window's SIZE, its style bits and the
/// client KIND — deliberately NOT its origin. The cached band/grid is
/// CAPTURE-relative (the capture always covers the clamped game rect), so a
/// pure window MOVE leaves the pixel geometry identical and re-detecting
/// would only burn a full scan (and flicker a re-acquisition). A size change
/// — real resize, or the monitor-edge clamp biting differently — a window-
/// MODE switch (borderless ↔ windowed can keep the outer size while
/// `GWL_STYLE`/`GWL_EXSTYLE` change) or a different client (the Lesta
/// scoreboard pitches differently than WG's at the same window size — the
/// cached grid would be systematically wrong) retires the cache.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct GeometryKey {
    pub(super) game_size: (i32, i32),
    pub(super) style_bits: u64,
    pub(super) kind: wowsp_tauri_shared::GameInstallKind,
}

/// One full detection's worth of pixel geometry, cached per game-window
/// mode: the located header band, the roster grid detected WITH it (same
/// frame, phase refinement included), the team sizes the grid was built
/// for, and the strip-layout profile the detection RESOLVED for that table
/// (classic WG vs the next-generation rework share the header geometry, so
/// the layout is measured once per detection and every strip read while
/// the cache lives reuses it — see
/// `overlay_detect::resolve_wg_strip_profile`). Every later capture first
/// verifies the band cheaply ([`overlay_detect::verify_header_band`]); a
/// pass reuses the cached grid verbatim, a team-size change rebuilds from
/// the band, and repeated misses retire the entry.
#[cfg(target_os = "windows")]
pub(super) struct GeometryCacheEntry {
    pub(super) key: GeometryKey,
    pub(super) band: overlay_detect::HeaderBand,
    pub(super) roster: overlay_detect::DetectedRoster,
    pub(super) team_sizes: (usize, usize),
    pub(super) profile: overlay_detect::DetectProfile,
}

/// The sink fast-path's fingerprint baseline: the name-strip thumbs of the
/// LAST probe, keyed to the battle + capture-relative grid they were read
/// at. The sink solver diffs the next probe's strips against it to name
/// WHO sank (`overlay_detect::sink_victims`); a grid or battle change voids
/// it (the thumbs would describe other pixels).
#[cfg(target_os = "windows")]
pub(super) struct StripBaseline {
    pub(super) battle: i64,
    pub(super) row_centers: Vec<i32>,
    pub(super) thumbs: Vec<Option<overlay_detect::StripThumb>>,
}

/// All mutable watcher state in ONE struct (the loop's single-owner state
/// machine): the want-visible bookkeeping, the pin, the manual anchor, the
/// cadence stamps, the status mirror, the sink fast-path's baseline and
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
    /// When the last arena-watcher dir re-check ran (see `watch_tab_tick`).
    pub(super) last_watcher_dir_check: Option<Instant>,
    /// Mirror of the game window's presence for the CURRENT session — the
    /// edge detector the per-tick declaration arm runs on (the actual
    /// declaration latch is [`Self::table_declared`]): flips true when a
    /// game window is acquired and false when it is lost, so each new
    /// session re-arms the probe's wowsp.toml declaration exactly once.
    pub(super) declared_overlay_mode: bool,
    /// Whether the CURRENT game session has actually had `declare_overlay_mode`
    /// applied. Decoupled from [`Self::declared_overlay_mode`]: with the two
    /// window switches independent, the aim card can keep the watcher alive
    /// through a table-off stretch of the same session, and the table's
    /// declaration must then (re-)run when the table switch flips back on —
    /// a watcher restart no longer guarantees that edge.
    pub(super) table_declared: bool,
    /// When the last pinned-anchor revalidation ran.
    pub(super) last_revalidate: Option<Instant>,
    /// When the last sink fast-probe ran (independent of every other stamp:
    /// the probe is deliberately far cheaper and faster than a revalidate).
    pub(super) last_sink_check: Option<Instant>,
    /// Mirror of the LAST `wowsp://overlay-status` payload emitted (None =
    /// nothing emitted yet). report_status() drops reports identical to it,
    /// so the per-tick status pushes are edge events, not level events.
    pub(super) last_status: Option<OverlayStatus>,
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
    /// The sink fast-path's strip-fingerprint baseline (see
    /// [`StripBaseline`]) — the previous probe's thumbs at the pinned grid.
    pub(super) strip_baseline: Option<StripBaseline>,
    /// Persistent anchor calibration (see `calibration.rs`): the loaded
    /// per-client store, the screen fingerprint, the battle class the
    /// cached geometry belongs to and the per-press stability vote.
    pub(super) calibration: CalibrationCtx,
    /// When the hardware screen fingerprint was last recomputed.
    pub(super) last_screen_check: Option<Instant>,
    /// Whether the aim-card window (the second transparent overlay window —
    /// the crosshair target-stats card) is logically shown. The card's want
    /// is "its `aim_card` switch on, battle active, game focused, Tab up,
    /// no picker layer": while Tab is held the table overlay owns the
    /// screen, and in port there is nothing to aim at. The card PAGE decides
    /// its own content visibility from the telemetry aim verdict; this flag
    /// only drives the native window.
    pub(super) aim_card_shown: bool,
    /// Game rect and hang the aim card was last placed at — placement is
    /// skipped while NEITHER the game window nor the `aim_card_hang_px`
    /// setting has changed (a settings flip re-places the card even on an
    /// unmoved game window). `None` forces the next show to place first.
    pub(super) aim_card_placed: Option<(Rect, i32)>,
    /// Whether the chat-translation panel window (the THIRD transparent
    /// overlay window) is logically shown. Its want is "its `chat_panel`
    /// switch on, battle active, game focused, Tab held, no picker layer,
    /// the in-game chat input NOT focused": the panel appears while the
    /// player holds Tab and is hidden otherwise. The PAGE decides its own
    /// content from the chat-translate events; this flag only drives the
    /// native window.
    pub(super) chat_shown: bool,
    /// Game rect the chat panel was last placed at — placement is skipped
    /// while the game window has not moved (a settings flip does not change
    /// the panel's geometry, only its content). `None` forces the next show
    /// to place first.
    pub(super) chat_placed: Option<Rect>,
    /// Presentation-verify state machine (see `diag.rs`): which shows owe a
    /// marker check and the current broadcast verdict. Reset to default
    /// (Unverified) when the screen configuration changes.
    pub(super) verify: VerifyMachine,
    /// When the armed verify capture is due (armed at a show by
    /// `maybe_arm_verify`, consumed by the tick's verify pass; cleared on
    /// hide so a released Tab never lands a verdict). `None` = idle.
    pub(super) verify_due: Option<Instant>,
    /// Mirror of the last broadcast presentation verdict (the
    /// `overlay-diag` emit dedup, same stance as `last_status`).
    pub(super) last_diag: Option<OverlayPresentation>,
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
/// battle's next Tab hold.
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
    };
    if fsm.last_status == Some(status) {
        return;
    }
    fsm.last_status = Some(status);
    if let Err(e) = app.emit(OVERLAY_STATUS_EVENT, status) {
        tracing::warn!(error = %e, "emit overlay-status failed");
    }
}

/// Declare the overlay view mode in the probe's wowsp.toml table
/// (`barcode = 1`): the probe re-reads the table at every battle start, so
/// its unbound view renders the capture side channel's barcode strips while
/// the overlay mode owns the screen. (The probe's former `panel` half — the
/// in-game stats tables — is gone with the retired in-game display mode; no
/// app build answers the probe's stats requests anymore.) Only touches an
/// install that actually carries the probe.
#[cfg(target_os = "windows")]
fn declare_overlay_mode() {
    let Some(resolved) = super::super::game_context::resolve_root(
        super::super::game_context::RootPreference::PreferRunning,
    ) else {
        return;
    };
    let Ok(res_mods) = super::super::game_context::res_mods_dir(&resolved.root) else {
        return;
    };
    let probe = res_mods
        .join("PnFMods")
        .join(super::super::ingame_plugin::MOD_DIR);
    if !probe.join(super::super::ingame_plugin::MOD_ENTRY).is_file() {
        return;
    }
    super::super::mod_hub::manifest::hub_apply(
        super::super::mod_hub::manifest::ManifestOp::SetToolValues {
            res_mods,
            tool: "battle.ingame.stats".into(),
            values: [("barcode".to_string(), 1i64)].into_iter().collect(),
        },
    );
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
        if let Err(payload) = tick {
            // The panic hook already logged the message + location as an
            // ERROR; mirror the payload here too so this watcher-specific
            // marker line is self-sufficient in a feedback log (the 2026-10
            // bundle's storms carried no payload and were undiagnosable).
            let panic = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_string());
            tracing::warn!(%panic, "tab watcher tick panicked — continuing on the next tick");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    // Never leave the overlays behind when the watcher dies.
    if fsm.overlay_shown {
        hide_overlay(&app);
    }
    if fsm.aim_card_shown {
        hide_aim_card(&app);
    }
    if fsm.chat_shown {
        hide_chat(&app);
    }
    // Nor a leftover badge in the main window: drop the panel to idle (a
    // no-op when the last emitted state already was idle). The manual anchor
    // is cleared FIRST — it lives in this FSM and dies with the loop — so
    // the exit report already carries manual: false.
    fsm.manual_anchor = None;
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
            fsm.sink_candidate = None;
            fsm.last_revalidate = None;
            fsm.last_sink_check = None;
            fsm.strip_baseline = None;
            tracing::info!(had_pin, "arena stamp changed — pin voided by FIFO command");
            // No immediate report: the next tick re-derives the honest state
            // (Searching while acquiring, Idle while hidden) and reports it
            // through the dedup mirror.
            None
        },
        WatchCommand::CalibrationStoreChanged { client_key } => {
            // The settings calibration editor wrote this client's store:
            // reload it when the watcher is bound to the same client and
            // forget the battle-class alignment so the next battle-known
            // tick re-seeds the geometry cache from the fresh entries.
            if fsm.calibration.client_key.as_deref() == Some(client_key.as_str()) {
                fsm.calibration.force_reload();
                fsm.calibration.cache_class = None;
                tracing::info!(client = %client_key, "anchor calibration reloaded after an editor write");
            }
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

/// Cadence of the NEXT acquisition retry for the current hold: the short
/// young-hold interval while the hold is younger than the steady-state
/// cap, the cap itself once the hold matured (or no hold is observed —
/// `None` from a wedged tracker reads as "not young"). See
/// [`CAPTURE_YOUNG_RETRY_INTERVAL`] for why the young cadence exists.
#[cfg(target_os = "windows")]
pub(super) fn acquisition_retry_interval(held: Option<Duration>) -> Duration {
    if held.is_some_and(|held| held < CAPTURE_MIN_INTERVAL) {
        CAPTURE_YOUNG_RETRY_INTERVAL
    } else {
        CAPTURE_MIN_INTERVAL
    }
}

/// One tick's inputs for the transparent-window scheduler ([schedule_windows]).
/// Pure flags — the whole point of factoring them out is that the three
/// windows' visibility rules can be unit-tested without Win32, a game
/// window or a watcher loop.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OverlayContext {
    /// The game window is the foreground window (the overlay never shows
    /// over another app).
    pub(super) focused_on_game: bool,
    /// The physical Tab key is down (the watcher's 30 ms poll).
    pub(super) tab_down: bool,
    /// A battle roster is known (`arena_seen_within`) — port time shows
    /// nothing.
    pub(super) battle_known: bool,
    /// The main window's manual-locate picker layer is open (the player is
    /// re-drawing the anchor box).
    pub(super) picker_open: bool,
    /// The table window's own switch is off (`overlay-config.toml` `table`).
    pub(super) table_off: bool,
    /// The aim card's own switch is on AND the battle class allows it (PvE /
    /// all-AI enemy battles fold their gates into this flag so the pure
    /// scheduler keeps one switch per window).
    pub(super) aim_card_on: bool,
    /// The chat panel's own switch is on (`overlay-config.toml`
    /// `chat_panel`).
    pub(super) chat_panel_on: bool,
    /// The game's battle-chat INPUT currently owns the keyboard. Reserved
    /// for the probe/chat bridge's chat-input signal — this build has no
    /// chat-input source, so the watcher passes `false`; the scheduler
    /// already honors it so a real source can flip it without touching the
    /// show/hide branches.
    pub(super) chat_input_focused: bool,
}

/// The windows the window manager should keep visible for one tick — the
/// output side of [schedule_windows].
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WindowWants {
    pub(super) table: bool,
    pub(super) aim_card: bool,
    pub(super) chat: bool,
}

/// The ONE visibility decision for all three transparent overlay windows
/// (pure — unit-tested). Table and aim-card rules are the historical
/// formulas, unchanged; the chat panel joins them with its own switch and
/// its own Tab-held (rather than Tab-up) gate — it is INDEPENDENT of
/// `table_off` (a table-off player keeps the translation panel) and of the
/// aim card's battle-class gates.
#[cfg(any(target_os = "windows", test))]
pub(super) fn schedule_windows(ctx: OverlayContext) -> WindowWants {
    WindowWants {
        // The hold-Tab stat table: the historical want (battle known, game
        // focused, Tab held, no picker, table switch not off).
        table: ctx.focused_on_game
            && ctx.tab_down
            && ctx.battle_known
            && !ctx.picker_open
            && !ctx.table_off,
        // The crosshair stats card: the historical want (battle known, game
        // focused, Tab UP, card switch effective, no picker).
        aim_card: ctx.focused_on_game
            && ctx.battle_known
            && ctx.aim_card_on
            && !ctx.picker_open
            && !ctx.tab_down,
        // The chat-translation panel: Tab HELD (the player is looking at
        // the table/chat) during a battle, its own switch on, no picker and
        // no in-game chat input stealing the keyboard.
        chat: ctx.focused_on_game
            && ctx.battle_known
            && !ctx.picker_open
            && ctx.chat_panel_on
            && ctx.tab_down
            && !ctx.chat_input_focused,
    }
}

/// Whether the game's battle-chat input currently owns the keyboard.
///
/// PLACEHOLDER: this build has no chat-input source (the probe/chat bridge
/// cannot report it yet), so the scheduler's gate stays open. Kept as a
/// named function instead of an inline `false` so the wiring point is
/// auditable when a real signal lands.
#[cfg(target_os = "windows")]
fn chat_input_focused() -> bool {
    false
}

/// Assemble the persistent calibration's LIVE identity for this moment:
/// the bound client + battle class + screen fingerprint, plus the window's
/// current origin/size/style/kind. `None` while the watcher has not
/// resolved a client or recorded a battle class — every calibration op is
/// then a no-op (plain uncached detection).
#[cfg(target_os = "windows")]
pub(super) fn live_calibration_key(
    fsm: &WatchFsm,
    game: &GameWindow,
) -> Option<calibration::LiveKey> {
    let class = fsm.calibration.cache_class?;
    let rect = rect_from_win32(game.rect);
    fsm.calibration.live_key(
        class,
        &game.kind,
        (rect.x, rect.y),
        (rect.width, rect.height),
        super::capture::window_style_bits(game.hwnd),
    )
}

/// Pure cadence decision for the pinned-anchor revalidation (unit-tested).
/// Three arms:
///
/// - FORCED (`last == None` — the cache was just dropped): always run. A
///   certified geometry must still heal itself when the sink probe's band
///   gate proves the table moved.
/// - PERIODIC (5 s cadence): the historical watchdog while the geometry
///   is NOT yet certified.
/// - PERIODIC-SLOW (60 s cadence): once CERTIFIED stable the watchdog
///   slows down instead of standing down (review H-1) — a grid-level
///   drift the band verify cannot see still heals within a minute.
pub(super) fn revalidate_due(last: Option<Instant>, certified: bool, now: Instant) -> bool {
    match last {
        None => true,
        Some(at) => {
            let interval = if certified {
                super::CERTIFIED_REVALIDATE_INTERVAL
            } else {
                ANCHOR_REVALIDATE_INTERVAL
            };
            now.duration_since(at) >= interval
        },
    }
}

/// Re-align the in-memory geometry cache to a battle-class change (PvP ↔
/// PvE tables are different layouts with independently calibrated
/// coordinates): seed the cache from the new class's STORED entry when the
/// window mode matches, otherwise drop the old class's cache — its band
/// would only buy three failed verifies before the full scan anyway.
#[cfg(target_os = "windows")]
pub(super) fn align_geometry_cache_to_class(
    fsm: &mut WatchFsm,
    game: &GameWindow,
    class: calibration::BattleClass,
) {
    let rect = rect_from_win32(game.rect);
    let key = GeometryKey {
        game_size: (rect.width, rect.height),
        style_bits: super::capture::window_style_bits(game.hwnd),
        kind: game.kind,
    };
    let seeded = fsm
        .calibration
        .seed_geometry(class, &game.kind, key.game_size, key.style_bits)
        .map(|(band, roster, team_sizes, profile)| GeometryCacheEntry {
            key,
            band,
            roster,
            team_sizes,
            profile,
        });
    match seeded {
        Some(cache) => {
            tracing::info!(class = ?class, "geometry cache seeded from the stored anchor calibration");
            fsm.geometry_cache = Some(cache);
        },
        None => {
            if fsm.geometry_cache.is_some() {
                tracing::info!(
                    class = ?class,
                    "battle class changed — geometry cache dropped (no matching calibration entry)"
                );
            }
            fsm.geometry_cache = None;
        },
    }
    fsm.geometry_verify_fails = 0;
}

/// One poll iteration of the Tab watcher (factored out so the loop can wrap
/// it in `catch_unwind`).
#[cfg(target_os = "windows")]
fn watch_tab_tick(app: &AppHandle, fsm: &mut WatchFsm) {
    // FIFO command pipeline first: every cross-thread input (manual anchor
    // set/clear, arena battle change) lands in push order before this tick's
    // own decisions read the state.
    drain_watch_commands(app, fsm);

    // Follow the running client: every WATCH_DIR_REFRESH the watcher's target
    // is compared against the freshly resolved replay dir, so launching a
    // different install mid-session re-points the roster source without a
    // window teardown. Throttled like the game-window scan — the resolution
    // takes a Toolhelp process snapshot too.
    if fsm
        .last_watcher_dir_check
        .is_none_or(|t| t.elapsed() >= WATCH_DIR_REFRESH)
    {
        fsm.last_watcher_dir_check = Some(Instant::now());
        super::arena_info::refresh_watcher_target(app);
    }

    // Resolve the game window: cached while valid, rescanned at most
    // once per HWND_REFRESH — including the not-found case. (The cached
    // entry is CLONED out — GameWindow carries the install key as a
    // String — a per-tick allocation the poll rate easily affords.)
    let game = match fsm.cached_game.as_ref() {
        Some((g, at)) if at.elapsed() < HWND_REFRESH && g.is_alive() => Some(g.clone()),
        _ if fsm.last_scan.is_none_or(|t| t.elapsed() >= HWND_REFRESH) => {
            fsm.last_scan = Some(Instant::now());
            let found = find_game_window();
            fsm.cached_game = found.clone().map(|g| (g, Instant::now()));
            found
        },
        _ => fsm
            .cached_game
            .as_ref()
            .filter(|(g, _)| g.is_alive())
            .map(|(g, _)| g.clone()),
    };

    // Anchor-calibration bookkeeping (per-client persistent geometry, see
    // `calibration.rs`): bind the store to the running install, and keep
    // the hardware screen fingerprint fresh — a changed layout retires
    // every entry (they stop matching) and detection re-arms.
    if let Some(g) = game.as_ref() {
        fsm.calibration.bind_client(&g.install_key);
        if fsm
            .last_screen_check
            .is_none_or(|t| t.elapsed() >= SCREEN_FINGERPRINT_REFRESH)
        {
            fsm.last_screen_check = Some(Instant::now());
            let fingerprint = screen_fingerprint();
            if fingerprint != fsm.calibration.screen {
                tracing::info!(
                    screen = %fingerprint,
                    "screen configuration changed — anchor calibration re-armed"
                );
                fsm.calibration.screen = fingerprint;
                // A changed monitor layout can also change the composition
                // path — the presentation verdict is stale until
                // re-verified. Clearing the dedup mirror too means the
                // re-walk's Failed transition (should the fault persist)
                // broadcasts again instead of being swallowed.
                fsm.verify = VerifyMachine::default();
                fsm.last_diag = None;
            }
        }
    }

    let focused_on_game = game.as_ref().is_some_and(|g| g.is_foreground());
    let tab_down = tab_key_down();
    // One stability vote per Tab PRESS episode: the key coming up re-arms
    // the vote so a long hold cannot certify its own geometry (see
    // `CalibrationCtx::note_stable`).
    if !tab_down {
        fsm.calibration.hold_counted = false;
    }

    // PRESENTATION VERIFY pass (see `diag.rs`): the capture for a show that
    // armed it. Runs before the show/hide branches AND gates on Tab still
    // being down — a quick release races the page's marker teardown, and
    // that must drop the armed check (rescheduled at the next show), never
    // score a miss against a window nobody can see. A failed capture is
    // likewise inconclusive: nothing is scored, the next show re-arms.
    if let Some(due) = fsm.verify_due
        && Instant::now() >= due
    {
        fsm.verify_due = None;
        if tab_down
            && fsm.overlay_shown
            && let Some(marker_found) = verify_marker_on_screen(app)
        {
            tracing::debug!(marker_found, "overlay presentation verify capture");
            apply_verify_verdict(app, fsm, marker_found);
        }
    }

    // Overlay switches (`overlay-config.toml`, written by the settings
    // modal): `table: "off"` keeps the transparent Tab TABLE window down
    // while `aim_card: false` keeps the stats card down — the two window
    // switches are independent, and the webui keeps the watcher + windows
    // up while either is on. These cached reads are the Rust-side
    // belt-and-suspenders — a stray tick (or a stale watcher outliving the
    // webui's teardown) must never show a window against its setting, and
    // an already-shown one hides again as soon as its want flag flips
    // false below.
    let table_off = super::overlay_config::table_overlay_off();
    let aim_card_on = super::overlay_config::aim_card_shown();
    // The card's hang below the crosshair (logical px) — read in the same
    // pass so the placement key below covers a settings change, not just a
    // game-window move (the TTL cache makes this another mutex memcpy).
    let aim_hang = super::overlay_config::aim_card_hang_px();
    // The chat panel's own switch (schema v2 `chat_panel`): the watcher
    // consults it every tick like the other window switches, so a settings
    // flip applies live without a window lifecycle change.
    let chat_panel_on = super::overlay_config::chat_panel_on();

    // Declare the OVERLAY view mode in the probe's wowsp.toml (barcode = 1
    // — the capture side channel's strips own the screen): the probe
    // re-reads the table at every battle start. The declaration arms once
    // per game session, and a table-off stretch does NOT consume it — with
    // the two window switches independent, the aim card can keep this
    // watcher alive through an off period, so a table flip back on
    // mid-session must (re-)declare right here instead of waiting for a
    // watcher restart that no longer happens. Skipped entirely while the
    // table switch is off — the barcode strips serve the table's capture
    // pipeline only, and the aim card reads the probe's telemetry without
    // them.
    if game.is_some() != fsm.declared_overlay_mode {
        fsm.declared_overlay_mode = game.is_some();
        fsm.table_declared = false;
    }
    if fsm.declared_overlay_mode && !table_off && !fsm.table_declared {
        declare_overlay_mode();
        fsm.table_declared = true;
    }

    // WANT-VISIBLE state machine instead of press-edge triggering: the
    // previous edge-only model did all its work exactly once per press,
    // so a single failed capture (transient scene-probe miss, rate-limit
    // window) meant the overlay stayed down until Tab was released and
    // pressed again — rapid tapping then felt permanently dead ("按不出
    // 来了"). Here, holding Tab with the game focused DURING a battle is
    // the standing want; each rate-limit window retries acquisition
    // until it succeeds.
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    // A recorded battle with an EMPTY roster (the Lesta shape until the
    // in-game probe's roster file warms up) is not done acquiring either:
    // keep the same refresh cadence re-reading until the synthesis fills
    // the roster (refresh_battle_state re-emits the event when it does).
    let roster_pending = battle_known && super::arena_info::last_known_team_sizes() == (0, 0);
    if focused_on_game
        && tab_down
        && (!battle_known || roster_pending)
        && fsm
            .last_state_refresh
            .is_none_or(|t| t.elapsed() >= STATE_REFRESH)
    {
        fsm.last_state_refresh = Some(Instant::now());
        // A failed re-read (mid-rewrite) must not flip an ALREADY known
        // battle to unknown for one tick — that would blink the overlay
        // off while Tab is held; the pending-roster retry continues on
        // the next cadence tick either way.
        battle_known |= super::arena_info::refresh_battle_state(app);
        tracing::debug!(battle_known, "tab held: refreshed battle state");
    }
    // The manual-locate picker layer is open in the main window: the
    // stored-anchor path stands down for the tick (the user is re-picking
    // the box), and when the game window disappears underneath the layer it
    // is force-closed (open flag + close event to the main window).
    let mut picker_open = manual_locate_open();
    if picker_open && game.is_none() {
        force_close_manual_locate(app);
        picker_open = false;
    } else if picker_open && focused_on_game && tab_down {
        // The user is holding Tab IN the game — asking for the table — while
        // the picker flag still stands. The layer lives in the main window
        // and cannot be interacted with while the game is foreground, so
        // the flag here is a STALE one (a fire-and-forget `cancelManualLocate`
        // IPC that never landed, a webview reload mid-pick, a settings modal
        // closed around the layer): `want_visible` gates on `!picker_open`,
        // so a stale flag reads as "Tab does nothing" for the rest of the
        // session — the game stays up, the game-gone force-close never
        // fires. Close the layer and let this hold through. (A half-drawn
        // box from an Alt-Tab mid-pick is lost with it — accepted: under a
        // standing flag this same hold showed nothing at all.)
        tracing::info!("stale manual-locate picker flag force-closed on a Tab hold in game");
        force_close_manual_locate(app);
        picker_open = false;
    }

    // WINDOW SCHEDULER — the ONE visibility decision for all three
    // transparent windows (pure; see `schedule_windows`). The historical
    // table + aim-card wants and the chat panel's new one are derived here
    // in one place so a later window cannot drift into its own ad-hoc
    // formula. The aim card's battle-class gates (PvE / all-AI enemy — see
    // the pass comment below) fold into `aim_card_on` here, so the
    // scheduler keeps one switch per window while the branch behaviour stays
    // exactly the historical one. `chat_input_focused` is the reserved
    // in-game-chat-input placeholder (this build has no source for it).
    let wants = schedule_windows(OverlayContext {
        focused_on_game,
        tab_down,
        battle_known,
        picker_open,
        table_off,
        aim_card_on: aim_card_on
            && !super::arena_info::last_battle_pve()
            && !super::arena_info::last_enemy_all_ai(),
        chat_panel_on,
        chat_input_focused: chat_input_focused(),
    });

    // AIM-CARD pass — the second transparent window serving the one overlay
    // mode: shown while a battle is active and the game is focused and its
    // OWN switch (`aim_card`, read above) is on — independent of the table
    // switch, so a table-off player may still run the card. Hidden while
    // Tab is held (the table overlay owns the screen then), the picker is
    // open, or the battle is gone. PvE battles keep it down for their WHOLE
    // duration (`arena_info::last_battle_pve`, the anchor calibration's own
    // class flag), and so does any battle whose ENEMY side reads entirely
    // AI (`arena_info::last_enemy_all_ai` — asymmetric fills and rooms
    // deliberately set vs bots ride this one, whatever their matchGroup
    // string says): the crosshair can only lock AI ships there — co-op
    // bots or scripted operation units — so the card would hang a raw bot
    // name over dash placeholders with nothing real to look up. A MIXED
    // enemy side (event PvEvP: bots AND humans) keeps the window up; the
    // page-side per-aim gate (telemetry `bots` + the AI-name styles)
    // filters those AI targets by name. Placement hangs
    // the card below the game
    // window's center (the crosshair) by the configured hang
    // (`aim_card_hang_px`, read above with the switches) and follows every
    // game-window move AND every settings change; the PAGE decides its own
    // content visibility from the telemetry aim verdict, so this only
    // drives the native window and costs a few flag compares per idle tick.
    // The decision itself is the window scheduler's (`schedule_windows`
    // above); its `aim_card_on` input carries the battle-class gates folded
    // in, so this branch is exactly the historical behaviour.
    if wants.aim_card {
        if let Some(g) = game.as_ref() {
            let rect = rect_from_win32(g.rect);
            // A moved/resized game window OR a changed hang re-places; a
            // no-op placement (window not created yet — creation is async)
            // must not stamp the cache, or the card would stay unplaced
            // after creation.
            let placed_at = (rect, aim_hang);
            if fsm.aim_card_placed.as_ref() != Some(&placed_at)
                && place_aim_card(app, &rect, window_dpi_scale(g.hwnd), aim_hang)
            {
                fsm.aim_card_placed = Some(placed_at);
            }
            if !fsm.aim_card_shown && app.get_webview_window(AIM_CARD_LABEL).is_some() {
                show_aim_card(app);
                fsm.aim_card_shown = true;
            }
        }
    } else if fsm.aim_card_shown {
        hide_aim_card(app);
        fsm.aim_card_shown = false;
    }

    // CHAT-PANEL pass — the THIRD transparent window: the bottom-left
    // chat-translation panel, shown while the player HOLDS Tab during a
    // battle and its own `chat_panel` switch is on. It is independent of
    // the table switch (a table-off player keeps the panel) and of the aim
    // card's battle-class gates (the panel is useful in PvE too). Placement
    // parks the window at the game window's bottom-left (see
    // `placement::chat_rect`) and follows every game-window move; the PAGE
    // decides its own content from the chat-translate events, so this pass
    // only drives the native window and costs a few flag compares per idle
    // tick.
    if wants.chat {
        if let Some(g) = game.as_ref() {
            let rect = rect_from_win32(g.rect);
            // A moved/resized game window re-places; a no-op placement
            // (window not created yet — creation is async) must not stamp
            // the cache, or the panel would stay unplaced after creation.
            if fsm.chat_placed.as_ref() != Some(&rect)
                && place_chat(app, &rect, window_dpi_scale(g.hwnd))
            {
                fsm.chat_placed = Some(rect);
            }
            if !fsm.chat_shown && app.get_webview_window(CHAT_LABEL).is_some() {
                show_chat(app);
                fsm.chat_shown = true;
            }
        }
    } else if fsm.chat_shown {
        hide_chat(app);
        fsm.chat_shown = false;
    }

    let battle = super::arena_info::last_arena_stamp();
    let game_rect = game.as_ref().map(|g| rect_from_win32(g.rect));
    let game_kind = game.as_ref().map(|g| g.kind);
    // Battle-class tracking for the anchor calibration (PvP and PvE keep
    // independent entries — their Tab tables are different layouts). On a
    // class CHANGE the in-memory geometry cache is re-seeded from the new
    // class's stored entry (or dropped when none matches: the other
    // class's band would only buy three failed verifies), so the first
    // press of the new class verifies a band instead of scanning — or
    // scans once and re-stores.
    if let Some(g) = game.as_ref().filter(|_| battle_known && !table_off) {
        let class = calibration::BattleClass::current();
        if fsm.calibration.cache_class != Some(class) {
            fsm.calibration.cache_class = Some(class);
            align_geometry_cache_to_class(fsm, g, class);
        }
    }
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

    // The table window's want: the window scheduler's historical formula
    // (battle known, game focused, Tab held, no picker, table switch on) —
    // see `schedule_windows`. Manual anchors gate on the same want below.
    let want_visible = wants.table;
    if let Some((m, manual_game)) = manual_active {
        // Place ONCE per manual hold, not every 30 ms tick.
        if !fsm.overlay_shown || !fsm.manual_shown {
            let dpi_scale = game.map_or(1.0, |g| window_dpi_scale(g.hwnd));
            let anchor = build_manual_anchor(&m, manual_game, dpi_scale);
            place_and_show(app, &anchor);
            maybe_arm_verify(app, fsm);
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
                p.kind,
                battle,
                game_rect,
                game_kind,
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
                place_and_show(app, &anchor);
                maybe_arm_verify(app, fsm);
                fsm.overlay_shown = true;
                fsm.last_hide = None;
                // The anchor on screen is fresh as of NOW: start the
                // revalidation clock here so the first re-check waits a
                // full interval instead of firing on the next tick.
                fsm.last_revalidate = Some(Instant::now());
            }
            // Status EVERY tick of the pin path (deduped by the mirror).
            report_status(
                app,
                fsm,
                OverlayState::Detected,
                Some(anchor.row_centers.len() as u32),
            );
            // Cadenced work while the pin is up — at most ONE capture per
            // tick, priority: sink probe (cheapest, most time-critical) →
            // full revalidation. A branch that fires
            // bumps only its own stamp, so the others simply run on a later
            // tick (their `due` conditions stay armed). The revalidation
            // arm stands down while the geometry is CERTIFIED stable —
            // see `revalidate_due` (a forced pass, `last_revalidate ==
            // None`, still runs: the sink probe's band gate must always be
            // able to heal a genuinely moved table).
            let calibrated = live_calibration_key(fsm, &g)
                .as_ref()
                .is_some_and(|k| fsm.calibration.certified(k));
            if fsm
                .last_sink_check
                .is_none_or(|t| t.elapsed() >= SINK_CHECK_INTERVAL)
            {
                sink_check_pass(app, fsm, &g);
            } else if revalidate_due(fsm.last_revalidate, calibrated, Instant::now()) {
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
            let retry = acquisition_retry_interval(tab_held_for());
            if !fsm
                .last_capture_attempt
                .is_none_or(|t| t.elapsed() >= retry)
            {
                tracing::debug!("tab held: capture rate-limited, waiting");
                return;
            }
            fsm.last_capture_attempt = Some(Instant::now());
            let computed = compute_anchor(&g, fsm);
            if let Some((anchor, profile)) = computed.as_ref().filter(|(a, _)| a.table_detected) {
                fsm.pinned_anchor = Some(PinnedAnchor {
                    battle,
                    game_rect: rect_from_win32(g.rect),
                    kind: g.kind,
                    profile: *profile,
                    anchor: anchor.clone(),
                });
                // A fresh pin restarts the sink lifecycle. The strip
                // baseline dies with it — its thumbs belong to the old
                // grid.
                fsm.sink_candidate = None;
                fsm.strip_baseline = None;
                fsm.last_sink_check = Some(Instant::now());
            }
            if let Some((anchor, _)) = computed {
                // Place when the overlay is not up yet, or when a
                // CONFIRMED anchor must replace the on-screen hint;
                // re-placing an identical fallback hint every rate-limit
                // window would only churn the event pipe.
                if !fsm.overlay_shown || anchor.table_detected {
                    place_and_show(app, &anchor);
                    maybe_arm_verify(app, fsm);
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
            // The window is going down — any armed presentation verify is
            // void (its capture would race the marker teardown).
            fsm.verify_due = None;
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
