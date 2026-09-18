//! In-game overlay commands (milestones M6/M8).
//!
//! Overlay mode (Mode 2 in PLAN.md): a SEPARATE transparent, always-on-top,
//! click-through, decoration-less window sits on top of the game. It loads
//! the same index.html with `?window=overlay`, which makes main.ts mount
//! OverlayApp (no router, no title bar, transparent background).
//!
//! While the user holds `Tab` (with the game window in the foreground), a
//! watcher thread on the Rust side:
//!
//!   1. captures the game window region once (virtual-screen GDI `BitBlt`,
//!      multi-monitor safe — negative origins included);
//!   2. runs the team-list detector (`overlay_detect`) on that frame to find
//!      the table rectangle, the player rows and the team split;
//!   3. repositions the overlay window over the game rect (physical pixels,
//!      DPI-consistent with the webview's `devicePixelRatio`), emits a
//!      `wowsp://overlay-anchor` event with the anchor, and shows the window
//!      WITHOUT activating it (never steals focus from the game);
//!   4. hides the window again on Tab release (or when the game loses the
//!      foreground).
//!
//! While the overlay STAYS shown, the pinned anchor is additionally
//! re-validated every [`ANCHOR_REVALIDATE_INTERVAL`] against a fresh
//! detection and replaced when the table moved at row scale — the in-battle
//! panel shifts as a whole when HUD phases change (countdown → combat), and
//! a battle-pinned anchor would otherwise keep the countdown position for
//! the entire battle.
//!
//! The overlay window is created lazily by `create_overlay_window` (called
//! once when overlay mode starts, hidden) and destroyed by
//! `destroy_overlay_window` (when the game exits or overlay mode is turned
//! off). The main shell window keeps running underneath.
//!
//! Threading: every command here is `async` so it runs on the Tauri async
//! runtime, NOT the main/UI thread — sync commands execute inline on the
//! webview IPC (main) thread, and `create_overlay_window` builds an entire
//! WebView2 window, which would stall every queued request during startup.
//! The Tab watcher is a detached `std::thread` that only talks to the shell
//! via thread-safe dispatches (`emit`, `set_position`, …).

use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use wowsp_tauri_shared::{CaptureResult, OverlayAnchor, Rect};

use super::{overlay_detect, row_recognize};

/// Label of the dedicated overlay window (distinct from "main").
const OVERLAY_LABEL: &str = "overlay";

/// Tauri event carrying the latest anchor to the overlay webview.
pub const OVERLAY_ANCHOR_EVENT: &str = "wowsp://overlay-anchor";

/// Tauri event toggling the overlay page's OWN visibility (HTML-level hide).
/// Emitted straight from the watcher thread — no main-thread queue involved —
/// so the page content vanishes even when the native window hide below is
/// delayed by a busy main thread. This is the load-bearing hide; the native
/// one only stops the (already invisible) webview from painting.
pub const OVERLAY_VISIBILITY_EVENT: &str = "wowsp://overlay-visibility";

/// Watcher poll period — fast enough that ≤30 ms of Tab latency is
/// imperceptible, slow enough that two cheap Win32 calls are noise.
const POLL_INTERVAL: Duration = Duration::from_millis(30);
/// While the overlay is logically shown but Tab is up / the game lost the
/// foreground, the hide is RE-SENT at this period: a single edge-triggered
/// hide queues exactly one main-thread task, and when that task is delayed
/// or lost the overlay used to stay on screen forever (seen in live testing
/// — "hidden" logged, window still visible). Idempotent and cheap here.
const HIDE_RETRY: Duration = Duration::from_millis(300);
/// Battle-state refresh cadence while Tab is held but no battle is known —
/// bounds the replay-tree walk inside `refresh_battle_state`.
const STATE_REFRESH: Duration = Duration::from_secs(2);
/// Rate limit for capture attempts (GDI `BitBlt(CAPTUREBLT)` + detector
/// work is expensive): a fresh Tab press reuses the cached anchor inside
/// this window and is refused a new capture until it elapses — so frantic
/// tapping or a focus flicker while holding Tab caps at ~0.67 captures/s.
const CAPTURE_MIN_INTERVAL: Duration = Duration::from_millis(1500);
/// While the overlay is shown, the pinned anchor is re-validated at this
/// cadence: a full BitBlt + detection pass re-runs and replaces the pin only
/// when the table moved at row scale (`overlay_detect::
/// anchor_meaningfully_moved`). The pin's two keys (arena stamp + window
/// rect) cannot see the panel moving WITHIN one window: the in-battle Tab
/// panel shifts as a whole when HUD phases change — the countdown "waiting
/// players" layout sits ~190 px (≈ 3.7 row pitches at 3072x1920) above the
/// combat layout once the score bar / quick-commands HUD appears — so
/// without this check the chips stayed on the countdown position for the
/// entire battle. Revalidation IS a capture attempt in cost, so it is
/// throttled to the CAPTURE_MIN_INTERVAL order of magnitude; 5 s bounds the
/// chip misplacement to seconds while adding no work when the overlay is
/// hidden.
const ANCHOR_REVALIDATE_INTERVAL: Duration = Duration::from_secs(5);
/// A capture is only attempted while the most recent battle roster
/// (tempArenaInfo.json mtime) is younger than this — Tab in port or long
/// after a battle stays a no-op.
const ARENA_FRESHNESS_SECS: u64 = 30 * 60;
/// How often the cached game HWND is re-resolved.
const HWND_REFRESH: Duration = Duration::from_secs(2);

// ─────────────────────────────────────────────────────────────────────────
// Window management
// ─────────────────────────────────────────────────────────────────────────

/// Create the transparent overlay window if it doesn't exist yet. Idempotent —
/// a second call just returns without recreating. The window starts hidden;
/// the Tab watcher shows it. `realm` (when known) is forwarded via the URL so
/// the overlay webview can batch WG lookups without re-detecting the install.
/// Also starts the Tab watcher thread.
#[tauri::command]
pub async fn create_overlay_window(
    app: AppHandle,
    realm: Option<String>,
    locale: Option<String>,
) -> Result<(), String> {
    if app.get_webview_window(OVERLAY_LABEL).is_none() {
        // The overlay window loads a PRE-RENDERED static page (bare HTML +
        // CSS + a tiny vanilla listener, built as a second Vite entry) —
        // no Vue app, no loading state, first paint is instant.
        let mut url = "/overlay.html".to_string();
        let mut sep = "?";
        if let Some(r) = realm.as_deref().filter(|r| !r.is_empty()) {
            url.push_str(sep);
            url.push_str("realm=");
            url.push_str(r);
            sep = "&";
        }
        if let Some(l) = locale.as_deref().filter(|l| !l.is_empty()) {
            url.push_str(sep);
            url.push_str("locale=");
            url.push_str(l);
        }
        let win = WebviewWindowBuilder::new(&app, OVERLAY_LABEL, WebviewUrl::App(url.into()))
            .title("WoWSP Overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false) // start hidden; shown on first Tab press
            .inner_size(420.0, 320.0)
            .build()
            .map_err(|e| format!("create overlay window: {e}"))?;
        post_create_window_setup(&win);
    }
    start_overlay_tab_watch(app).await
}

/// Destroy the overlay window (when overlay mode ends) and stop the watcher.
/// Also stops the arena file watcher — it is owned by the overlay window's
/// store, and closing the webview skips Vue teardown.
#[tauri::command]
pub async fn destroy_overlay_window(app: AppHandle) -> Result<(), String> {
    stop_overlay_tab_watch().await?;
    let _ = super::arena_info::stop_arena_watcher().await;
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        // destroy(), not close(): close() raises CloseRequested like a
        // user-initiated close (and is subject to close interception),
        // while this is pure programmatic teardown that must always go
        // through.
        win.destroy().map_err(|e| format!("destroy overlay: {e}"))?;
    }
    Ok(())
}

/// Show or hide the overlay window manually (debug / settings preview). The
/// Tab watcher is the authoritative visibility driver in normal operation.
/// NEVER focuses the overlay — focus must stay on the game while playing.
#[tauri::command]
pub async fn set_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return Err("overlay window not created — call create_overlay_window first".into());
    };
    if visible {
        if let Err(e) = app.emit(OVERLAY_VISIBILITY_EVENT, true) {
            tracing::warn!(error = %e, "emit overlay-visibility failed");
        }
        if let Ok(hwnd) = win.hwnd() {
            show_async(windows::Win32::Foundation::HWND(hwnd.0));
        }
    } else {
        if let Err(e) = app.emit(OVERLAY_VISIBILITY_EVENT, false) {
            tracing::warn!(error = %e, "emit overlay-visibility failed");
        }
        win.hide().map_err(|e| format!("hide overlay: {e}"))?;
    }
    Ok(())
}

/// Click-through + no-activate styling applied right after creation, so the
/// overlay can never eat a click or steal focus from the game. Also kills
/// the DWM non-client frame: on Windows 11 every top-level window gets a
/// 1px DWM border (+ rounded corners), and on a fully transparent window
/// that border is the ONLY visible thing — the user saw a floating rectangle
/// outline over the game.
#[cfg(target_os = "windows")]
fn post_create_window_setup(win: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND, DwmSetWindowAttribute,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let _ = win.set_ignore_cursor_events(true);
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            // TOOLWINDOW also keeps the borderless window out of Alt-Tab.
            let _ = SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                &(DWMNCRP_DISABLED.0) as *const _ as *const core::ffi::c_void,
                4,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &(DWMWCP_DONOTROUND.0) as *const _ as *const core::ffi::c_void,
                4,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn post_create_window_setup(win: &tauri::WebviewWindow) {
    let _ = win.set_ignore_cursor_events(true);
}

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
struct PinnedAnchor {
    battle: i64,
    game_rect: Rect,
    anchor: OverlayAnchor,
}

/// The watcher loop — see the module docs for the interaction contract.
#[cfg(target_os = "windows")]
fn watch_tab_loop(app: AppHandle, stop: Arc<AtomicBool>) {
    let mut overlay_shown = false;
    let mut pinned_anchor: Option<PinnedAnchor> = None;
    let mut cached_game: Option<(GameWindow, Instant)> = None;
    // When the last game-window SCAN ran — bounds find_game_window() even
    // when it keeps failing (each call takes a full Toolhelp process
    // snapshot; a failing lookup retried every poll tick would peg a core).
    let mut last_scan: Option<Instant> = None;
    // When the last capture ATTEMPT ran (success or failure) — bounds the
    // expensive BitBlt + detector work even under frantic Tab
    // tapping or a focus-flicker loop while the key is held.
    let mut last_capture_attempt: Option<Instant> = None;
    // When the last hide was sent — spaces out the hide retries.
    let mut last_hide: Option<Instant> = None;
    // When the last battle-state refresh ran — bounds the replay-tree walk
    // inside refresh_battle_state while Tab is held without a known battle.
    let mut last_state_refresh: Option<Instant> = None;
    // When the last pinned-anchor revalidation ran — independent of
    // last_capture_attempt: it throttles the periodic re-check of the pin
    // while the overlay STAYS shown (see ANCHOR_REVALIDATE_INTERVAL).
    let mut last_revalidate: Option<Instant> = None;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // A panicked tick must not kill the thread: a dead watcher can no
        // longer observe the Tab release and the overlay would stay on
        // screen forever. The next tick re-syncs all state.
        let tick = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            watch_tab_tick(
                &app,
                &mut overlay_shown,
                &mut pinned_anchor,
                &mut cached_game,
                &mut last_scan,
                &mut last_capture_attempt,
                &mut last_hide,
                &mut last_state_refresh,
                &mut last_revalidate,
            );
        }));
        if tick.is_err() {
            tracing::warn!("tab watcher tick panicked — continuing on the next tick");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    // Never leave the overlay behind when the watcher dies.
    if overlay_shown {
        hide_overlay(&app);
    }
}

/// One poll iteration of the Tab watcher (factored out so the loop can wrap
/// it in `catch_unwind`).
#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn watch_tab_tick(
    app: &AppHandle,
    overlay_shown: &mut bool,
    pinned_anchor: &mut Option<PinnedAnchor>,
    cached_game: &mut Option<(GameWindow, Instant)>,
    last_scan: &mut Option<Instant>,
    last_capture_attempt: &mut Option<Instant>,
    last_hide: &mut Option<Instant>,
    last_state_refresh: &mut Option<Instant>,
    last_revalidate: &mut Option<Instant>,
) {
    {
        // Resolve the game window: cached while valid, rescanned at most
        // once per HWND_REFRESH — including the not-found case.
        let game = match &*cached_game {
            Some((g, at)) if at.elapsed() < HWND_REFRESH && g.is_alive() => Some(*g),
            _ if last_scan.is_none_or(|t| t.elapsed() >= HWND_REFRESH) => {
                *last_scan = Some(Instant::now());
                let found = find_game_window();
                *cached_game = found.map(|g| (g, Instant::now()));
                found
            },
            _ => (*cached_game).filter(|(g, _)| g.is_alive()).map(|(g, _)| g),
        };

        let focused_on_game = game.is_some_and(|g| g.is_foreground());
        let tab_down = tab_key_down();

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
            && last_state_refresh.is_none_or(|t| t.elapsed() >= STATE_REFRESH)
        {
            *last_state_refresh = Some(Instant::now());
            battle_known = super::arena_info::refresh_battle_state();
            tracing::debug!(battle_known, "tab held: refreshed battle state");
        }
        let want_visible = focused_on_game && tab_down && battle_known;
        if want_visible {
            // A CONFIRMED pin is the only "done" state. Shown WITHOUT one —
            // the centered-fallback hint — must keep acquiring: a Tab press
            // can beat the panel's first render (the scene gate opens on the
            // battle HUD alone), and with the gates below split on
            // `overlay_shown` / `pinned_anchor.is_some()` that hint was a
            // terminal state for the whole hold — acquisition stopped, and
            // revalidation had no pin to re-check, so the hint never
            // recovered even once the table was fully on screen.
            let confirmed_pin = pinned_anchor
                .as_ref()
                .is_some_and(|p| p.anchor.table_detected);
            if !*overlay_shown || !confirmed_pin {
                // BATTLE-PINNED anchor first: once a table was located for
                // THIS battle and this game-window geometry, every later
                // press reuses it verbatim — per-press re-detection measured
                // slightly different header bands frame to frame and the
                // chips visibly wandered ("飘"). The pin lives for the whole
                // battle (arena stamp) or until the window moves/resizes.
                let battle = super::arena_info::last_arena_stamp();
                let game_rect = game.map(|g| rect_from_win32(g.rect));
                let pinned = pinned_anchor.as_ref().filter(|p| {
                    p.battle == battle
                        && game_rect.is_some_and(|r| r == p.game_rect)
                        && p.anchor.table_detected
                });
                let anchor = match pinned {
                    Some(p) => Some(p.anchor.clone()),
                    None => {
                        // Rate-limited acquisition attempt. A FAILED attempt
                        // stays unpinned, so the next tick (after the rate
                        // limit) retries — no release-and-press needed,
                        // whether the overlay is still hidden or sitting on
                        // the hint. Only a CONFIRMED table detection pins;
                        // fallback anchors (hint box) stay unpinned so the
                        // next attempt keeps trying for the real table.
                        let Some(g) = game else {
                            return;
                        };
                        if !last_capture_attempt.is_none_or(|t| t.elapsed() >= CAPTURE_MIN_INTERVAL)
                        {
                            tracing::debug!("tab held: capture rate-limited, waiting");
                            return;
                        }
                        *last_capture_attempt = Some(Instant::now());
                        let computed = compute_anchor(&g);
                        if let Some(anchor) = computed.as_ref().filter(|a| a.table_detected) {
                            *pinned_anchor = Some(PinnedAnchor {
                                battle,
                                game_rect: rect_from_win32(g.rect),
                                anchor: anchor.clone(),
                            });
                        }
                        computed
                    },
                };
                if let Some(anchor) = anchor {
                    // Place when the overlay is not up yet, or when a
                    // CONFIRMED anchor must replace the on-screen hint;
                    // re-placing an identical fallback hint every rate-limit
                    // window would only churn the event pipe.
                    if !*overlay_shown || anchor.table_detected {
                        place_and_show(app, &anchor);
                    }
                    *overlay_shown = true;
                    *last_hide = None;
                    // The anchor on screen is fresh as of NOW (a new pin, or
                    // this battle's pin re-shown): start the revalidation
                    // clock here so the first re-check waits a full interval
                    // instead of firing on the next tick.
                    *last_revalidate = Some(Instant::now());
                }
                // A failed acquisition while ALREADY shown keeps the old
                // anchor on screen — the previous behavior of hiding here
                // made a single failed re-capture blink the overlay off.
            } else if last_revalidate.is_none_or(|t| t.elapsed() >= ANCHOR_REVALIDATE_INTERVAL) {
                // Shown AND pinned (the only way to reach this arm):
                // periodically re-check the pin against a live detection —
                // the panel moves as a whole when HUD phases change
                // (countdown → combat) and neither pin key (arena stamp,
                // window rect) can see it.
                revalidate_pinned_anchor(app, pinned_anchor, game, last_revalidate);
            }
        } else if *overlay_shown {
            // Keep re-sending the hide while the overlay should be down:
            // each attempt posts one async Win32 command + one event, and
            // any single one can be lost; both are idempotent. Retries stop
            // once the window reports itself actually hidden.
            if last_hide.is_none_or(|t| t.elapsed() >= HIDE_RETRY) {
                hide_overlay(app);
                *last_hide = Some(Instant::now());
                if !overlay_window_visible(app) {
                    *overlay_shown = false;
                }
            }
        }
    }
}

/// One revalidation pass over the pinned anchor while the overlay is shown:
/// re-run the capture + detector against the live frame and replace the pin
/// (re-emitting the anchor) only when the table MOVED at row scale
/// (`overlay_detect::anchor_meaningfully_moved`). Every other outcome — a
/// failed capture, a fallback detection, sub-pitch jitter — keeps the pin
/// and emits nothing, so this pass can never make the chips wander.
/// `last_revalidate` is bumped unconditionally: the pass costs a full
/// capture attempt regardless of its outcome.
///
/// Note that `compute_anchor` already drops a tab dump on every CONFIRMED
/// detection (`tab_dump`): the pass that discovers a NEW layout leaves a
/// ground-truth artifact for it, deduped per (battle, layout) by the
/// anchor's first row.
#[cfg(target_os = "windows")]
fn revalidate_pinned_anchor(
    app: &AppHandle,
    pinned_anchor: &mut Option<PinnedAnchor>,
    game: Option<GameWindow>,
    last_revalidate: &mut Option<Instant>,
) {
    *last_revalidate = Some(Instant::now());
    let Some(g) = game else {
        return;
    };
    let Some(pinned) = pinned_anchor.as_ref().map(|p| p.anchor.clone()) else {
        return;
    };
    let Some(fresh) = compute_anchor(&g) else {
        tracing::debug!("anchor revalidation: capture/detection failed — pin kept");
        return;
    };
    if !overlay_detect::anchor_meaningfully_moved(&pinned, &fresh) {
        return;
    }
    tracing::info!(
        pinned_first_row = pinned.row_centers.first().copied().unwrap_or(0),
        fresh_first_row = fresh.row_centers.first().copied().unwrap_or(0),
        "panel layout shifted — replacing the pinned anchor"
    );
    // Re-key the pin to the CURRENT battle + window geometry: the fresh
    // anchor was computed from THIS frame, so it belongs to this geometry.
    *pinned_anchor = Some(PinnedAnchor {
        battle: super::arena_info::last_arena_stamp(),
        game_rect: rect_from_win32(g.rect),
        anchor: fresh.clone(),
    });
    place_and_show(app, &fresh);
}

/// Whether the overlay window currently reports as visible (false when it is
/// missing). Used to stop the hide-retry loop once the hide really landed.
#[cfg(target_os = "windows")]
fn overlay_window_visible(app: &AppHandle) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|win| win.hwnd().ok())
        .map(|hwnd| unsafe { IsWindowVisible(windows::Win32::Foundation::HWND(hwnd.0)).as_bool() })
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn watch_tab_loop(_app: AppHandle, _stop: Arc<AtomicBool>) {}

/// Physical state of the Tab key (true = down), regardless of focus.
#[cfg(target_os = "windows")]
fn tab_key_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_TAB};
    let state = unsafe { GetAsyncKeyState(VK_TAB.0 as i32) };
    (state as u16) & 0x8000 != 0
}

/// Place the overlay window over the game rect, push the anchor to the
/// webview, then show without activating.
///
/// All native window work goes through DIRECT async Win32 calls from this
/// watcher thread (`SetWindowPos` with `SWP_ASYNCWINDOWPOS` +
/// `ShowWindowAsync`) — never the Tauri main-thread queue. `run_on_main_thread`
/// was the second-live-test failure: after a few show/hide cycles the queue
/// backs up behind WebView2 resize work, every queued show/hide sits there,
/// and the next Tab press appears dead ("nothing happens the second time").
/// The async calls post to the window's own message queue and return at once;
/// ordering between a show and a later hide is preserved because both are
/// posted to the same window thread in watcher-loop order.
#[cfg(target_os = "windows")]
fn place_and_show(app: &AppHandle, anchor: &OverlayAnchor) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        tracing::warn!("overlay window missing — cannot show (was it destroyed?)");
        return;
    };
    if let Err(e) = app.emit(OVERLAY_ANCHOR_EVENT, anchor) {
        tracing::warn!(error = %e, "emit overlay-anchor failed");
    }
    // Reveal the page content AFTER the anchor is in (the page repaints
    // while still invisible, then flips visible in one step).
    if let Err(e) = app.emit(OVERLAY_VISIBILITY_EVENT, true) {
        tracing::warn!(error = %e, "emit overlay-visibility failed");
    }
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    place_and_show_async(
        windows::Win32::Foundation::HWND(hwnd.0),
        &anchor.overlay_rect,
    );
    tracing::info!("overlay show posted (tab held)");
}

/// Raw Win32 placement: async `SetWindowPos` + `ShowWindowAsync(SW_SHOWNOACTIVATE)`.
#[cfg(target_os = "windows")]
fn place_and_show_async(hwnd: windows::Win32::Foundation::HWND, r: &Rect) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos,
    };
    unsafe {
        // ASYNCWINDOWPOS is load-bearing: without it a cross-thread
        // SetWindowPos SYNCHRONOUSLY posts to the owning thread and waits;
        // a main thread busy with WebView2 resize work then stalls THIS
        // watcher thread — Tab polling stops, and rapid pressing feels
        // permanently dead.
        let _ = SetWindowPos(
            hwnd,
            None,
            r.x,
            r.y,
            r.width.max(1),
            r.height.max(1),
            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
        );
        show_async(hwnd);
    }
}

/// Async no-activate show — `ShowWindowAsync` posts to the window's own
/// thread and returns at once (the sync `ShowWindow` from a foreign thread
/// can block on that thread's message queue).
#[cfg(target_os = "windows")]
fn show_async(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindowAsync};
    unsafe {
        let _ = ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
    }
}

#[cfg(not(target_os = "windows"))]
fn place_and_show(_app: &AppHandle, _anchor: &OverlayAnchor) {}

/// Hide the overlay: HTML-level hide FIRST (the event reaches the page
/// directly from this thread), then the async native hide. Both idempotent —
/// the watcher re-sends the whole thing every [`HIDE_RETRY`] while Tab is up.
#[cfg(target_os = "windows")]
fn hide_overlay(app: &AppHandle) {
    if let Err(e) = app.emit(OVERLAY_VISIBILITY_EVENT, false) {
        tracing::warn!(error = %e, "emit overlay-visibility failed");
    }
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL)
        && let Ok(hwnd) = win.hwnd()
    {
        use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindowAsync};
        unsafe {
            let _ = ShowWindowAsync(windows::Win32::Foundation::HWND(hwnd.0), SW_HIDE);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn hide_overlay(_app: &AppHandle) {}

// ─────────────────────────────────────────────────────────────────────────
// Capture + anchor computation
// ─────────────────────────────────────────────────────────────────────────

/// Capture the game window, run the detector, and return the anchor for the
/// chip layer. Falls back to a conservative centered table when detection
/// fails but a battle roster is known — stats must still be readable.
#[cfg(target_os = "windows")]
fn compute_anchor(game: &GameWindow) -> Option<OverlayAnchor> {
    let team_sizes = super::arena_info::last_known_team_sizes();
    let Some((rgba, w, h)) = capture_game_rgba(&game.rect) else {
        tracing::warn!("game window capture returned no pixels");
        return None;
    };
    if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
        dump_capture(&rgba, w, h);
    }
    // Scene gate. The HUD probe (HP bar + ship icons) only renders inside
    // the 3D scene, but holding Tab DIMS the whole frame and real captures
    // show it then finds as few as 2 icon clusters (threshold 5) or a 12px
    // HP run (threshold 48) — it kept rejecting real battles. So the probe
    // is only the SECOND opinion: the header detection itself is the
    // strongest possible in-scene proof (the teal/brick team-header bars
    // exist ONLY on the in-battle Tab table), and either one passes.
    let probe = overlay_detect::probe_battle_scene(&rgba, w, h);
    let header_found = overlay_detect::header_bars_present(&rgba, w, h);
    if !probe.detected() && !header_found {
        tracing::info!(
            hp_bar = probe.hp_bar,
            icon_blobs = probe.icon_blobs,
            header_found,
            "tab press: no battle HUD and no team header — not in a 3D scene, skipping"
        );
        return None;
    }
    let (roster_rel, rows, split, detected) =
        match overlay_detect::detect_roster(&rgba, w, h, team_sizes) {
            Some(det) => (det.rect, det.row_centers, det.team_split, true),
            None => {
                tracing::info!(
                    allies = team_sizes.0,
                    enemies = team_sizes.1,
                    "team list not detected — using centered fallback table"
                );
                let expected = team_sizes.0.max(team_sizes.1);
                let (r, rows) = overlay_detect::fallback_roster(w as i32, h as i32, expected);
                (r, rows, 0.5, false)
            },
        };
    // Row → player-name recognition (PR 3a: architecture only). Runs on the
    // DETECTED capture-relative geometry, before build_anchor re-bases it to
    // the overlay origin; off by default (WOWSP_ROW_RECOGNIZER unset) and a
    // no-op then — the anchor keeps row_players = None, which the frontend
    // reads as the historical index mapping. Every failure inside degrades
    // to None and must never disturb the anchor flow. `ally_rows` is the
    // SAME team_sizes read the detection grid above was built from — the
    // single source of truth for the pipeline's block split.
    let row_players = if detected {
        row_recognize::recognize_row_players(&row_recognize::RowFrame {
            rgba: &rgba,
            width: w,
            height: h,
            roster: &roster_rel,
            row_centers: &rows,
            team_split: split,
            ally_rows: team_sizes.0,
        })
    } else {
        None
    };
    let (overlay, mut anchor) = overlay_detect::build_anchor(
        &rect_from_win32(game.rect),
        &roster_rel,
        rows,
        split,
        detected,
    );
    anchor.row_players = row_players;
    tracing::info!(
        detected,
        overlay = format!(
            "{}x{} at ({},{})",
            overlay.width, overlay.height, overlay.x, overlay.y
        ),
        rows = anchor.row_centers.len(),
        "anchor built"
    );
    // Ground-truth dump for the Tab row-order analysis (opt-in via
    // WOWSP_TAB_DUMP_DIR, a no-op by default): the frame the detector just
    // ran on, the arena roster and the anchor, captured at the same instant.
    // CONFIRMED detections dump once per (battle, layout); FAILED detections
    // (the `.miss.` artifacts) dump once per battle, so a scenario where the
    // table cannot be found leaves its frame behind for offline analysis.
    super::tab_dump::maybe_dump_tab_frame(&rgba, w, h, &anchor);
    Some(anchor)
}

/// Capture the game window region and return it as base64 PNG plus the
/// detected anchor. The image is only encoded when `WOWSP_DEBUG_CAPTURE` is
/// set — normal operation needs nothing but the anchor, and shipping a
/// full-screen PNG on every Tab press would be wasteful.
#[tauri::command]
pub async fn capture_game_window() -> Result<CaptureResult, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(game) = find_game_window() else {
            return Ok(CaptureResult {
                image_base64: String::new(),
                roster_rect: None,
                anchor: None,
            });
        };
        let team_sizes = super::arena_info::last_known_team_sizes();
        let (anchor, png) = match capture_game_rgba(&game.rect) {
            Some((rgba, w, h)) => {
                // Same dual-channel scene gate as `compute_anchor`: the HUD
                // probe dims badly while Tab is held; the header bars are
                // the primary evidence.
                let in_scene = overlay_detect::detect_battle_scene(&rgba, w, h)
                    || overlay_detect::header_bars_present(&rgba, w, h);
                let det = if in_scene {
                    match overlay_detect::detect_roster(&rgba, w, h, team_sizes) {
                        Some(d) => Some(
                            overlay_detect::build_anchor(
                                &rect_from_win32(game.rect),
                                &d.rect,
                                d.row_centers,
                                d.team_split,
                                true,
                            )
                            .1,
                        ),
                        None => {
                            let (r, rows) = overlay_detect::fallback_roster(
                                w as i32,
                                h as i32,
                                team_sizes.0.max(team_sizes.1),
                            );
                            Some(
                                overlay_detect::build_anchor(
                                    &rect_from_win32(game.rect),
                                    &r,
                                    rows,
                                    0.5,
                                    false,
                                )
                                .1,
                            )
                        },
                    }
                } else {
                    None
                };
                let png = if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
                    encode_png(&rgba, w, h)
                } else {
                    Vec::new()
                };
                (det, png)
            },
            None => (None, Vec::new()),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Ok(CaptureResult {
            image_base64: b64,
            roster_rect: anchor.as_ref().map(|a| a.roster_rect),
            anchor,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(CaptureResult {
            image_base64: String::new(),
            roster_rect: None,
            anchor: None,
        })
    }
}

/// Encode an RGBA buffer as PNG bytes.
#[cfg(target_os = "windows")]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    use std::io::Cursor;
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec());
    let mut out = Cursor::new(Vec::new());
    if let Some(img) = img {
        let _ = image::DynamicImage::ImageRgba8(img).write_to(&mut out, image::ImageFormat::Png);
    }
    out.into_inner()
}

/// Save a debug capture to %APPDATA%/WoWSP for detector calibration.
#[cfg(target_os = "windows")]
fn dump_capture(rgba: &[u8], w: u32, h: u32) {
    let Some(dir) = dirs_next::data_dir() else {
        return;
    };
    let dir = dir.join("WoWSP");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("overlay-capture-{ts}.png"));
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec());
    if let Some(img) = img {
        if let Err(e) = img.save(&path) {
            tracing::warn!(error = %e, "dump debug capture failed");
        } else {
            tracing::info!(path = %path.display(), "debug capture dumped");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Win32: game window discovery + screen capture
// ─────────────────────────────────────────────────────────────────────────

/// The game's top-level window: handle + on-screen bounds (physical px,
/// already clamped to the window's monitor so the capture and the overlay
/// cover exactly the same region — multi-monitor / negative-origin safe).
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
struct GameWindow {
    hwnd: windows::Win32::Foundation::HWND,
    rect: windows::Win32::Foundation::RECT,
}

#[cfg(target_os = "windows")]
impl GameWindow {
    fn is_alive(&self) -> bool {
        !self.hwnd.0.is_null()
            && unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(self.hwnd)) }
                .as_bool()
    }

    fn is_foreground(&self) -> bool {
        (unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }) == self.hwnd
    }
}

/// `RECT` → shared `Rect` (physical px).
#[cfg(target_os = "windows")]
fn rect_from_win32(r: windows::Win32::Foundation::RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// Collect the game's main window: PID via the ToolHelp snapshot (reusing
/// `appdata::find_game_pid`), then the largest visible top-level window of
/// that process. Title-agnostic — Lesta/CN clients localize their titles.
#[cfg(target_os = "windows")]
fn find_game_window() -> Option<GameWindow> {
    use std::ffi::c_void;

    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::BOOL;

    let pid = super::appdata::find_game_pid()?;

    struct Ctx {
        pid: u32,
        best: Option<(HWND, i64)>,
    }
    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let ctx = &mut *(lparam.0 as *mut Ctx);
            let mut win_pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut win_pid));
            if win_pid == ctx.pid
                && IsWindowVisible(hwnd).as_bool()
                && GetWindowTextLengthW(hwnd) > 0
            {
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    let area = (rect.right as i64 - rect.left as i64)
                        * (rect.bottom as i64 - rect.top as i64);
                    if ctx.best.is_none_or(|(_, a)| area > a) {
                        ctx.best = Some((hwnd, area));
                    }
                }
            }
        }
        BOOL(1) // keep enumerating
    }

    let mut ctx = Ctx { pid, best: None };
    unsafe {
        let lparam = &mut ctx as *mut Ctx as *mut c_void;
        let _ = EnumWindows(Some(enum_cb), LPARAM(lparam as isize));
    }
    let (hwnd, _) = ctx.best?;
    let rect = window_bounds_clamped(hwnd)?;
    Some(GameWindow { hwnd, rect })
}

/// Window bounds in physical screen px: DWM extended frame bounds (visible
/// bounds, excludes the invisible resize border) with a `GetWindowRect`
/// fallback, intersected with the window's monitor — so the BitBlt source
/// rect and the overlay window rect always agree on multi-monitor setups
/// with negative origins.
#[cfg(target_os = "windows")]
fn window_bounds_clamped(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<windows::Win32::Foundation::RECT> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rect = RECT::default();
    unsafe {
        let mut dwm = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut dwm as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
            && dwm.right > dwm.left
            && dwm.bottom > dwm.top
        {
            rect = dwm;
        } else if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut mi).as_bool() {
            rect.left = rect.left.max(mi.rcMonitor.left);
            rect.top = rect.top.max(mi.rcMonitor.top);
            rect.right = rect.right.min(mi.rcMonitor.right);
            rect.bottom = rect.bottom.min(mi.rcMonitor.bottom);
        }
    }
    if rect.right > rect.left && rect.bottom > rect.top {
        Some(rect)
    } else {
        None
    }
}

/// GDI capture of a screen rect from the virtual-screen DC. Works for
/// borderless / windowed-fullscreen games on any monitor (negative origins
/// included); an exclusive-fullscreen swapchain may BitBlt black — the
/// detector then fails and the caller falls back.
#[cfg(target_os = "windows")]
fn capture_game_rgba(rect: &windows::Win32::Foundation::RECT) -> Option<(Vec<u8>, u32, u32)> {
    use windows::Win32::Graphics::Gdi::*;

    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);

    unsafe {
        let hdc_screen = GetDC(None);
        if hdc_screen.is_invalid() {
            return None;
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        if hdc_mem.is_invalid() {
            let _ = ReleaseDC(None, hdc_screen);
            return None;
        }
        let hbmp = CreateCompatibleBitmap(hdc_screen, width, height);
        if hbmp.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(None, hdc_screen);
            return None;
        }
        let old_bmp = SelectObject(hdc_mem, hbmp.into());

        // Plain SRCCOPY — deliberately NOT `| CAPTUREBLT`. CAPTUREBLT pulls
        // LAYERED windows into the frame, and the overlay window itself is
        // layered: the second Tab press within the capture rate-limit window
        // then photographs our own (still fading-out) window over the table
        // and the detector anchors on our own hint box. Without CAPTUREBLT
        // layered windows are simply absent from the BitBlt result.
        let ok = BitBlt(
            hdc_mem,
            0,
            0,
            width,
            height,
            Some(hdc_screen),
            rect.left,
            rect.top,
            SRCCOPY,
        )
        .is_ok();

        let mut out = None;
        if ok {
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // negative = top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD::default()],
            };
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let got = GetDIBits(
                hdc_mem,
                hbmp,
                0,
                height as u32,
                Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
                &mut bi,
                DIB_RGB_COLORS,
            );
            if got != 0 {
                // BGRA → RGBA, opaque alpha.
                for chunk in pixels.chunks_exact_mut(4) {
                    chunk.swap(0, 2);
                    chunk[3] = 255;
                }
                out = Some((pixels, width as u32, height as u32));
            }
        }

        let _ = SelectObject(hdc_mem, old_bmp);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(None, hdc_screen);
        out
    }
}
