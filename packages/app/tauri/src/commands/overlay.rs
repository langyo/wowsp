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
//! the entire battle. The same pass now also RECONCILES the row→name
//! recognition: while a pin still lacks a trusted mapping (the arena roster
//! file landed after the pin, or an all-`None` OCR read matched nothing) it
//! re-runs at the capture rate limit ([`CAPTURE_MIN_INTERVAL`]) instead of
//! the full 5 s, and whenever a fresh detection disagrees with the pin's
//! mapping — first recognition landing late, or sunk ships re-sorting the
//! rows — only the mapping is transplanted onto the pin (geometry
//! untouched) and the anchor is re-emitted, so the chips re-render with
//! correct attribution without ever wandering. When the pin's geometry IS
//! replaced (the table moved at row scale), the replacement carries the OLD
//! pin's trusted row→name mapping on the fresh grid
//! ([`carry_mapping_into_fresh`]) — the roster is fixed for the battle, so
//! re-attributing the chips from scratch on every HUD-phase move would only
//! flash "recognizing roster…" for nothing.
//!
//! Three further mechanisms keep the chips honest without flicker:
//!
//! - SINGLE STATE OWNER: every cross-thread input (manual anchor set/clear,
//!   a fresh `tempArenaInfo.json` voiding the pin) enters a FIFO command
//!   queue ([`WatchCommand`]) that the watcher loop drains at the top of
//!   each tick. The loop's state machine ([`WatchFsm`]) is the only state
//!   owner and the only `overlay-status` emitter, so command ordering is
//!   deterministic and the last-status dedup mirror covers every emission.
//! - GEOMETRY CACHE: the table's pixel geometry is fully detected once per
//!   game-window mode (rect + style bits, [`GeometryKey`]) and cached;
//!   every later capture only re-verifies the cached header band
//!   ([`overlay_detect::verify_header_band`], band-area cost) and reuses
//!   the cached grid — a new battle shape on the same window is rebuilt
//!   from the band without a rescan. Three consecutive verify misses (a
//!   HUD-phase table move) retire the cache and re-arm a full detection.
//! - SINK FAST-PATH: while the overlay is up, a light probe
//!   ([`overlay_detect::read_row_alive`] — strip luma, no OCR) runs every
//!   [`SINK_CHECK_INTERVAL`] at the pinned geometry; an alive-flag flip
//!   immediately updates the pin, re-places the chips (they gray out and
//!   re-sort), re-emits the tab order and raises the wire's `stale` flag
//!   while the OCR re-map chases at the accelerated
//!   [`SINK_CATCHUP_INTERVAL`] cadence. The flip is direction-sensitive
//!   ([`sink_probe_confirm`]): a SINK applies at once, while a pure
//!   REVIVAL flip — usually one frame of glare/explosion pushing a sunk
//!   row's strip over the luma threshold — must survive two consecutive
//!   probes before the pin believes it.
//!
//! Every STATE CHANGE of this machine — idle (overlay hidden) ↔
//! searching/fallback (acquiring without a confirmed pin, the fallback
//! variant meaning the centered hint is what's on screen) ↔ detected
//! (chips anchored) ↔ manual (chips anchored to a user-drawn box) — is
//! additionally broadcast to ALL windows as
//! `wowsp://overlay-status` (payload [`OverlayStatus`]). The main window's
//! live-battle panel badges the detection state from it. Transitions only:
//! the watcher keeps a loop-local mirror of the last emitted status and
//! drops no-op reports, so the ~30 Hz poll can never flood the event pipe.
//! Within one (battle, game-window rect) a Detected state never degrades
//! back to Searching: the pin-reuse path reports Detected directly instead
//! of flashing "locating…" before every Tab press.
//!
//! The MANUAL LOCATE flow (`start_manual_locate` → the drag-box picker
//! window → `set_manual_roster_rect`) lets the player anchor the chips by
//! hand when auto detection keeps missing: a dedicated, INTERACTIVE
//! transparent window covers the game rect, the player drags a rectangle
//! over the team table, and the selection is stored as a [`ManualAnchor`].
//! While it stays valid (same battle stamp + same game-window rect) the
//! watcher uses it INSTEAD of running the detector — no capture, no OCR,
//! no pin, and the 5 s revalidation deliberately never touches it. A new
//! battle or a moved/resized game window silently expires it back to the
//! automatic flow; hiding the overlay does NOT.
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
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use wowsp_tauri_shared::{
    CaptureResult, OverlayAnchor, OverlayState, OverlayStatus, Rect, TabRowOrder, TabRowPlayer,
};

use super::{overlay_detect, row_recognize};

/// Label of the dedicated overlay window (distinct from "main").
const OVERLAY_LABEL: &str = "overlay";

/// Label of the manual-locate picker window (screenshot-style drag box).
/// A SEPARATE window from [`OVERLAY_LABEL`]: it must RECEIVE mouse + keyboard
/// input (never click-through) while the overlay chips window must never.
const MANUAL_LOCATE_LABEL: &str = "manual-locate";

/// Minimum accepted size (physical px) of a manual roster selection, per
/// axis — anything smaller cannot carry a readable table row.
const MANUAL_MIN_SIZE: i32 = 32;

/// Tauri event carrying the latest anchor to the overlay webview.
pub const OVERLAY_ANCHOR_EVENT: &str = "wowsp://overlay-anchor";

/// Tauri event toggling the overlay page's OWN visibility (HTML-level hide).
/// Emitted straight from the watcher thread — no main-thread queue involved —
/// so the page content vanishes even when the native window hide below is
/// delayed by a busy main thread. This is the load-bearing hide; the native
/// one only stops the (already invisible) webview from painting.
pub const OVERLAY_VISIBILITY_EVENT: &str = "wowsp://overlay-visibility";

/// Tauri event carrying the DETECTION-STATE machine to all windows (main
/// window's live-battle panel badge). Transition-only — see `report_status`.
pub const OVERLAY_STATUS_EVENT: &str = "wowsp://overlay-status";

/// Tauri event carrying the in-game Tab panel's CURRENT row order (names in
/// on-screen order + per-row alive flags) to ALL windows. Emitted from
/// `place_and_show` whenever the placed anchor carries a TRUSTED row→name
/// mapping — the initial pin, a layout-move replacement, or a mapping
/// transplant after sunk ships re-sorted the rows. The main window's
/// live-battle panel reorders its roster columns from it, so the software's
/// list mirrors exactly what the player sees while holding Tab.
pub const TAB_ORDER_EVENT: &str = "wowsp://tab-order";

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
/// While the overlay is shown with a confirmed pin, the SINK FAST-PATH runs
/// at this cadence: one capture + a per-row strip-luma read (no OCR, no
/// detection) at the pinned geometry. A ship sinking re-sorts the in-game
/// panel's rows within a second — far faster than the 5 s revalidation — so
/// the chips gray out and re-sort in step with the game.
const SINK_CHECK_INTERVAL: Duration = Duration::from_millis(500);
/// Recognition catch-up cadence while the pin is STALE (the sink probe just
/// flipped alive flags and the row→name mapping needs re-reading): a full
/// OCR pass runs every 500 ms instead of the usual [`CAPTURE_MIN_INTERVAL`]
/// so the re-map lands within a second or two of the sink. The stale flag
/// clears as soon as a trusted mapping produced by FRESH OCR lands — a move
/// replacement that merely CARRIES the old pin's mapping keeps the flag
/// (the carried order still describes the pre-sink rows).
const SINK_CATCHUP_INTERVAL: Duration = Duration::from_millis(500);
/// Consecutive header-band verify misses before the geometry cache is
/// retired and the next capture runs a full detection again. One miss is a
/// HUD-phase table move (or a transient scene change) — cheap ticks skip
/// the full scan and wait; three in a row mean the cached position is dead.
/// While a pin is shown the sink probe's 500 ms cadence normally
/// accumulates the misses in ~1 s; in the acquisition arm they accumulate
/// per rate-limited capture attempt instead.
const GEOMETRY_VERIFY_MAX_FAILS: u32 = 3;
/// How long an unconfirmed sink-probe REVIVAL candidate (see
/// [`sink_probe_confirm`]) stays confirmable: two agreeing probes at the
/// normal [`SINK_CHECK_INTERVAL`] cadence land ~500 ms apart; past this TTL
/// the candidate expires and the next flip starts a fresh two-probe count.
/// Generous enough to ride out a skipped probe, tight enough that a stale
/// reading can never confirm a much later flip.
const SINK_CANDIDATE_TTL: Duration = Duration::from_millis(1500);

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
    // Manual-locate leftovers must not outlive overlay mode: the open picker
    // window is torn down here, and the stored anchor lives in the watcher's
    // FSM ([`WatchFsm::manual_anchor`]) — it dies with the loop thread that
    // `stop_overlay_tab_watch` signals below, whose loop-exit idle report
    // clears the anchor first so it already carries manual: false.
    destroy_manual_locate_window(&app);
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
// Manual locate (screenshot-style drag box)
// ─────────────────────────────────────────────────────────────────────────

/// A user-drawn roster box, valid for ONE battle (arena stamp) on ONE
/// game-window geometry. Held in the watcher's FSM ([`WatchFsm::
/// manual_anchor`]): while the battle stamp and the game rect both still
/// match, every Tab hold anchors the chips to this box instead of running
/// the detector.
#[derive(Debug, Clone)]
struct ManualAnchor {
    /// Arena stamp (tempArenaInfo.json mtime) the box was drawn under — a
    /// new battle invalidates it.
    battle: i64,
    /// Game-window rect at draw time (physical screen px) — a moved or
    /// resized game window invalidates it.
    game_rect: Rect,
    /// The selection itself, PHYSICAL px relative to the game window's
    /// top-left corner (exactly what the picker webview submits).
    rect: Rect,
    /// (allies, enemies) of the roster at draw time — drives the row-grid
    /// derivation. Frozen here so a roster re-read mid-battle cannot
    /// silently move chips the user just placed.
    team_sizes: (usize, usize),
}

/// Outcome of checking the stored manual anchor against the CURRENT battle
/// stamp + game-window rect.
#[derive(Debug, Clone)]
enum ManualAnchorCheck {
    /// In force — carries a clone plus the matched game rect (which is
    /// therefore known to be `Some`).
    Live(ManualAnchor, Rect),
    /// Stored but expired: the battle changed, or the game window
    /// moved/resized. The watcher drops it and falls back to the automatic
    /// flow.
    Stale,
    /// Nothing stored — or no game-window rect THIS tick to judge against.
    /// The second case is deliberately NOT `Stale`: a transient HWND
    /// resolution miss must not nuke a box the user just drew.
    Inert,
}

/// Pure decision: does a stored manual anchor still apply to this battle on
/// this game-window geometry? The anchor lives in the watcher FSM, so the
/// stored value is passed in directly and the decision stays unit-testable
/// without cross-test static state.
fn manual_anchor_check(
    stored: Option<&ManualAnchor>,
    battle: i64,
    game_rect: Option<Rect>,
) -> ManualAnchorCheck {
    let Some(m) = stored else {
        return ManualAnchorCheck::Inert;
    };
    if m.battle != battle {
        return ManualAnchorCheck::Stale;
    }
    match game_rect {
        Some(r) if r == m.game_rect => ManualAnchorCheck::Live(m.clone(), r),
        Some(_) => ManualAnchorCheck::Stale,
        None => ManualAnchorCheck::Inert,
    }
}

/// Total row count of a stored manual anchor, when one is armed (any
/// liveness — the watcher only expires it on the focused+Tab path). Drives
/// the `manual` flag on automatic status reports: while the anchor survives
/// an Idle/Searching transition, the panel's manual badge + clear button
/// must survive it with it.
fn stored_manual_rows(stored: Option<&ManualAnchor>) -> Option<u32> {
    stored.map(|m| (m.team_sizes.0 + m.team_sizes.1) as u32)
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-thread watcher commands (FIFO pipeline)
// ─────────────────────────────────────────────────────────────────────────

/// Cross-thread inputs to the Tab watcher, drained FIFO by the loop at the
/// top of every tick. Producers (the manual-locate commands on the Tauri
/// async runtime, the arena watcher thread) never touch watcher state
/// directly and never emit `overlay-status` themselves: the loop applies
/// the commands in push order and is the single state owner + status
/// emitter. That kills two live races of the old direct-emit design —
/// out-of-order state application (a manual set landing between a tick's
/// read and write) and a direct emit resurrecting a badge the loop had just
/// corrected (the loop's dedup mirror never saw those emissions).
pub(super) enum WatchCommand {
    /// The manual-locate picker confirmed a box: arm the manual anchor for
    /// THIS battle on THIS game-window geometry.
    ManualAnchorSet {
        rect: Rect,
        game_rect: Rect,
        battle: i64,
        team_sizes: (usize, usize),
    },
    /// The user cleared the manual anchor.
    ManualAnchorCleared,
    /// A NEW battle's `tempArenaInfo.json` landed (arena mtime moved) — the
    /// current pin, if any, is void.
    BattleChanged,
}

/// FIFO command queue between the command threads and the watcher loop
/// (same static pattern as the old manual-anchor store).
static WATCH_COMMANDS: Mutex<VecDeque<WatchCommand>> = Mutex::new(VecDeque::new());

/// Hard queue bound. Protects the targets where the (Windows-only) watcher
/// loop never runs and nothing drains the queue, and a wedged loop, from
/// unbounded growth — every command is latest-state-wins in spirit, so
/// dropping the oldest under flood loses nothing that matters.
const WATCH_COMMANDS_MAX: usize = 64;

/// Enqueue a watcher command, FIFO.
pub(super) fn push_watch_command(cmd: WatchCommand) {
    if let Ok(mut q) = WATCH_COMMANDS.lock() {
        if q.len() >= WATCH_COMMANDS_MAX {
            q.pop_front();
        }
        q.push_back(cmd);
    }
}

/// Pure: validate a picker submission (game-relative physical px) against
/// the game rect.
fn validate_manual_selection(sel: &Rect, game: &Rect) -> Result<(), String> {
    if sel.width <= MANUAL_MIN_SIZE || sel.height <= MANUAL_MIN_SIZE {
        return Err(format!(
            "selection {}x{} too small (min {}x{} px per axis)",
            sel.width, sel.height, MANUAL_MIN_SIZE, MANUAL_MIN_SIZE
        ));
    }
    if sel.x < 0 || sel.y < 0 || sel.x + sel.width > game.width || sel.y + sel.height > game.height
    {
        return Err(format!(
            "selection ({},{})+{}x{} escapes the game window {}x{}",
            sel.x, sel.y, sel.width, sel.height, game.width, game.height
        ));
    }
    Ok(())
}

/// Pure: derive the chip-row centers from a manual selection. Each team's
/// rows spread EVENLY over the FULL selection height at the pitch of the
/// LARGER team (`height / max(allies, enemies)`): the in-game panel renders
/// two side-by-side columns, the taller one fills the box, and row `i` of a
/// side sits at `y + pitch * (i + 0.5)`. The two blocks are concatenated
/// allies-first (the [`OverlayAnchor`] block order); a shorter enemy side
/// simply ends early.
fn manual_row_centers(rect: &Rect, team_sizes: (usize, usize)) -> Vec<i32> {
    let tallest = team_sizes.0.max(team_sizes.1).max(1) as i32;
    let pitch = rect.height as f64 / tallest as f64;
    let mut centers = Vec::with_capacity(team_sizes.0 + team_sizes.1);
    for count in [team_sizes.0, team_sizes.1] {
        for i in 0..count as i64 {
            centers.push(rect.y + (pitch * (i as f64 + 0.5)).round() as i32);
        }
    }
    centers
}

/// Build the chip-layer anchor from a live manual anchor: the selection is
/// treated exactly like a DETECTED roster rect (padded, re-based to the
/// overlay window origin by the shared `overlay_detect::build_anchor`), with
/// a 0.5 team split (two side-by-side columns). `row_players` stays `None`
/// ON PURPOSE: the OCR pipeline is not run on a hand-drawn box — the per-row
/// player count comes from the roster and need not match the drawn rows, so
/// an index guess could pin the wrong stats onto chips. Honest silence (no
/// chips on an off-count row) beats confidently wrong data.
fn build_manual_anchor(m: &ManualAnchor, game_screen: Rect) -> OverlayAnchor {
    let rows = manual_row_centers(&m.rect, m.team_sizes);
    let (_, anchor) = overlay_detect::build_anchor(&game_screen, &m.rect, rows, 0.5, true);
    anchor
}

/// Destroy the picker window if present (any teardown path: confirm,
/// cancel, overlay-mode end, game exit). Pure programmatic teardown —
/// `destroy()`, not `close()`, for the same reason as
/// `destroy_overlay_window`.
fn destroy_manual_locate_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MANUAL_LOCATE_LABEL)
        && let Err(e) = win.destroy()
    {
        tracing::warn!(error = %e, "destroy manual-locate window failed");
    }
}

/// Kill the DWM 1px border + rounded corners on the borderless transparent
/// picker (same visual fix as `post_create_window_setup`) — but deliberately
/// WITHOUT the click-through (`set_ignore_cursor_events`) and the
/// NOACTIVATE/TOOLWINDOW ex-styles: the picker must receive mouse + keyboard
/// input and may take focus (Enter/Esc are part of the flow).
#[cfg(target_os = "windows")]
fn post_create_manual_window_setup(win: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND, DwmSetWindowAttribute,
    };
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
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
fn post_create_manual_window_setup(_win: &tauri::WebviewWindow) {}

/// Open the manual-locate picker: a transparent, always-on-top, INTERACTIVE
/// window placed exactly over the game rect (same Win32 geometry source as
/// the Tab watcher), where the player drag-boxes the team table.
/// Single-instance — a call while one is open is a no-op. Requires a fresh
/// battle roster and a resolvable game window.
#[tauri::command]
pub async fn start_manual_locate(app: AppHandle, locale: Option<String>) -> Result<(), String> {
    if app.get_webview_window(MANUAL_LOCATE_LABEL).is_some() {
        return Ok(()); // already open
    }
    // Same battle-known gate as the Tab watcher, with the same cheap
    // synchronous refresh on a stale cache.
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    if !battle_known {
        battle_known = super::arena_info::refresh_battle_state();
    }
    if !battle_known {
        return Err("no fresh battle roster — manual locate unavailable".into());
    }
    #[cfg(target_os = "windows")]
    let game_rect = rect_from_win32(find_game_window().ok_or("game window not found")?.rect);
    #[cfg(not(target_os = "windows"))]
    let game_rect = Rect {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    };

    // Same pre-rendered static page pattern as the overlay window (no Vue,
    // instant first paint); the locale picks the hint/button copy.
    let mut url = "/manual-locate.html".to_string();
    if let Some(l) = locale.as_deref().filter(|l| !l.is_empty()) {
        url.push_str("?locale=");
        url.push_str(l);
    }
    let win = WebviewWindowBuilder::new(&app, MANUAL_LOCATE_LABEL, WebviewUrl::App(url.into()))
        .title("WoWSP Manual Locate")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false) // shown once placed over the game rect
        .build()
        .map_err(|e| format!("create manual-locate window: {e}"))?;
    post_create_manual_window_setup(&win);
    // Physical-pixel alignment with the game rect — the same rect the
    // watcher BitBlts and places the overlay at. The one-shot interactive
    // flow can afford Tauri's main-thread dispatch (unlike the watcher's
    // hot path, which uses direct async Win32 calls).
    let _ = win.set_position(tauri::PhysicalPosition::new(game_rect.x, game_rect.y));
    let _ = win.set_size(tauri::PhysicalSize::new(
        game_rect.width.max(1) as u32,
        game_rect.height.max(1) as u32,
    ));
    win.show().map_err(|e| format!("show manual-locate: {e}"))?;
    let _ = win.set_focus();
    tracing::info!(
        rect = format!(
            "{}x{} at ({},{})",
            game_rect.width, game_rect.height, game_rect.x, game_rect.y
        ),
        "manual-locate picker opened"
    );
    Ok(())
}

/// Cancel + destroy the manual-locate picker without storing anything
/// (the picker page's Cancel button / Esc).
#[tauri::command]
pub async fn cancel_manual_locate(app: AppHandle) -> Result<(), String> {
    destroy_manual_locate_window(&app);
    Ok(())
}

/// Submit the picker's selection (physical px relative to the game window
/// origin): validate it and enqueue it as a FIFO command — the watcher loop
/// arms the manual anchor and reports the manual badge from there (within
/// one poll interval). The anchor takes effect on the next Tab hold.
#[tauri::command]
pub async fn set_manual_roster_rect(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let sel = Rect {
        x,
        y,
        width,
        height,
    };
    // Battle gate — same freshness rule as the Tab watcher.
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    if !battle_known {
        battle_known = super::arena_info::refresh_battle_state();
    }
    if !battle_known {
        return Err("no fresh battle roster — manual locate unavailable".into());
    }
    let team_sizes = super::arena_info::last_known_team_sizes();
    if team_sizes.0.max(team_sizes.1) == 0 {
        return Err("battle roster team sizes unknown — cannot derive rows".into());
    }
    #[cfg(target_os = "windows")]
    let game_rect = rect_from_win32(find_game_window().ok_or("game window not found")?.rect);
    #[cfg(not(target_os = "windows"))]
    let game_rect = Rect {
        x: 0,
        y: 0,
        width: i32::MAX,
        height: i32::MAX,
    };
    validate_manual_selection(&sel, &game_rect)?;
    let battle = super::arena_info::last_arena_stamp();
    // No direct status emit here (the old immediate Manual report): the
    // watcher loop applies this command FIFO within one poll interval and
    // emits the identical payload from the single emitter — same panel
    // feedback, but ordered against every other watcher transition.
    push_watch_command(WatchCommand::ManualAnchorSet {
        rect: sel,
        game_rect,
        battle,
        team_sizes,
    });
    // Success — the picker's job is done; it must not linger as a zombie.
    destroy_manual_locate_window(&app);
    tracing::info!(
        battle,
        sel = format!("{}x{} at ({},{})", sel.width, sel.height, sel.x, sel.y),
        allies = team_sizes.0,
        enemies = team_sizes.1,
        "manual roster anchor queued"
    );
    Ok(())
}

/// Drop the manual anchor (the live-battle panel's "clear locate" button)
/// via the FIFO pipeline: the watcher loop clears the anchor and reports
/// the state the overlay is ACTUALLY in — visible with a live automatic
/// pin → detected, visible without one → searching, hidden (Tab up / game
/// unfocused) → idle. An unconditional "searching" would stick forever —
/// the watcher's hide branch only runs while the overlay is shown, so
/// nothing would ever demote the badge afterwards. Also closes the picker
/// if one is somehow still open.
#[tauri::command]
pub async fn clear_manual_roster_rect(app: AppHandle) -> Result<(), String> {
    push_watch_command(WatchCommand::ManualAnchorCleared);
    destroy_manual_locate_window(&app);
    Ok(())
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
struct PinnedAnchor {
    battle: i64,
    game_rect: Rect,
    anchor: OverlayAnchor,
}

/// Geometry-cache identity: the game window's rect AND its style bits. The
/// rect alone misses a window-MODE switch (borderless ↔ windowed can keep
/// the outer rect identical); `GWL_STYLE`/`GWL_EXSTYLE` change with it, so
/// either mismatch retires the cache.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GeometryKey {
    game_rect: Rect,
    style_bits: u64,
}

/// One full detection's worth of pixel geometry, cached per game-window
/// mode: the located header band, the roster grid detected WITH it (same
/// frame, phase refinement included) and the team sizes the grid was built
/// for. Every later capture first verifies the band cheaply
/// ([`overlay_detect::verify_header_band`]); a pass reuses the cached grid
/// verbatim, a team-size change rebuilds from the band, and repeated
/// misses retire the entry.
#[cfg(target_os = "windows")]
struct GeometryCacheEntry {
    key: GeometryKey,
    band: overlay_detect::HeaderBand,
    roster: overlay_detect::DetectedRoster,
    team_sizes: (usize, usize),
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
struct WatchFsm {
    /// Whether the overlay window is logically shown (the watcher placed it
    /// and has not hidden it since).
    overlay_shown: bool,
    pinned_anchor: Option<PinnedAnchor>,
    /// Whether the CURRENTLY shown overlay is the manual anchor's placement
    /// (vs an automatic detection): gates the one-shot manual place_and_show
    /// so a live manual anchor does not re-place every 30 ms tick.
    manual_shown: bool,
    manual_anchor: Option<ManualAnchor>,
    /// Cached game-window resolution (handle + clamp time).
    cached_game: Option<(GameWindow, Instant)>,
    /// When the last game-window SCAN ran — bounds find_game_window() even
    /// when it keeps failing (each call takes a full Toolhelp process
    /// snapshot; a failing lookup retried every poll tick would peg a core).
    last_scan: Option<Instant>,
    /// When the last capture ATTEMPT ran (success or failure) — bounds the
    /// expensive BitBlt + detector work even under frantic Tab tapping.
    last_capture_attempt: Option<Instant>,
    /// When the last hide was sent — spaces out the hide retries.
    last_hide: Option<Instant>,
    /// When the last battle-state refresh ran.
    last_state_refresh: Option<Instant>,
    /// When the last pinned-anchor revalidation ran.
    last_revalidate: Option<Instant>,
    /// When the last recognition CATCH-UP pass ran.
    last_catch_up: Option<Instant>,
    /// When the last sink fast-probe ran (independent of every other stamp:
    /// the probe is deliberately far cheaper and faster than a revalidate).
    last_sink_check: Option<Instant>,
    /// Mirror of the LAST `wowsp://overlay-status` payload emitted (None =
    /// nothing emitted yet). report_status() drops reports identical to it,
    /// so the per-tick status pushes are edge events, not level events.
    last_status: Option<OverlayStatus>,
    /// True when the pin's row data just changed under the chips (the sink
    /// probe flipped alive flags) and the row→name re-map is still catching
    /// up: rides the wire on every status + anchor emission until a trusted
    /// mapping lands.
    stale: bool,
    /// Pending sink-probe REVIVAL candidate (pure-debounce state, see
    /// [`sink_probe_confirm`]): a probe read that only flipped sunk rows
    /// back to alive — almost always a single-frame glare/explosion
    /// artifact — waits here for the NEXT probe to agree before the pin is
    /// updated. `None` when nothing is pending.
    sink_candidate: Option<(Vec<bool>, Instant)>,
    /// Per-game-window-mode table geometry (see [`GeometryCacheEntry`]).
    geometry_cache: Option<GeometryCacheEntry>,
    /// Consecutive band-verify misses on the current cache entry.
    geometry_verify_fails: u32,
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
fn report_status(app: &AppHandle, fsm: &mut WatchFsm, state: OverlayState, rows: Option<u32>) {
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
fn apply_watch_command(
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

    // Table-anchoring switch (`overlay-config.json`, written by the
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
                row_recognize::recognizer_enabled(),
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

/// What the want-visible branch reports this tick (pure, unit-tested — the
/// no-flicker rule lives here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeldStatus {
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
fn held_status(pin_valid: bool, fallback_on_screen: bool) -> HeldStatus {
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
/// battle (arena stamp moved), a moved/resized game window, or a fallback
/// anchor void it — and voiding it is exactly what re-arms the Searching
/// report.
fn pin_matches(
    pin_battle: i64,
    pin_rect: &Rect,
    pin_table_detected: bool,
    battle: i64,
    game_rect: Option<Rect>,
) -> bool {
    pin_table_detected && pin_battle == battle && game_rect.is_some_and(|r| r == *pin_rect)
}

/// Pure: does this `row_players` payload count as "no trusted row→name
/// mapping"? Both `None` (recognition off, or the pipeline bailed) and a
/// vec where EVERY row failed to match (honest silence — text was read but
/// nothing stuck to the roster) leave the chips without trusted
/// attribution: the pending badge and the recognition catch-up stay on for
/// both.
fn mapping_untrusted(players: &Option<Vec<Option<String>>>) -> bool {
    match players {
        None => true,
        Some(v) => v.iter().all(Option::is_none),
    }
}

/// Pure catch-up gate (unit-testable; time, engine availability and the
/// stale flag are injected by the caller): run a recognition catch-up pass
/// when a CONFIRMED pin is on screen and its row→name mapping needs a
/// fresh OCR read — either because it still lacks a trusted mapping
/// (absent, or an all-`None` read: nothing matched) or because the pin is
/// STALE (the sink probe flipped alive flags; the old mapping is
/// battle-accurate but the rows re-sorted, so the mapping must be re-read
/// to confirm the new order) — while recognition is enabled and the
/// throttle says a pass may run.
///
/// Keeping the gate armed on an all-`None` pin cannot oscillate: a
/// deterministic re-read is again all-`None`, compares equal to the pin's
/// mapping, `should_transplant_rows` stays false and the pass re-emits
/// nothing.
fn should_catch_up_recognition(
    pin: Option<&OverlayAnchor>,
    stale: bool,
    recognizer_on: bool,
    throttle_elapsed: bool,
) -> bool {
    pin.is_some_and(|p| p.table_detected && (mapping_untrusted(&p.row_players) || stale))
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
fn carry_mapping_into_fresh(fresh: &OverlayAnchor, pinned: &OverlayAnchor) -> OverlayAnchor {
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
enum MappingOrigin {
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
fn stale_after_mapping(
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
fn alive_changed(pinned: Option<&[bool]>, fresh: &[bool]) -> bool {
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
fn sink_probe_confirm(
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
fn should_transplant_rows(fresh: &OverlayAnchor, pinned: &OverlayAnchor) -> bool {
    fresh.table_detected
        && fresh.row_players.as_ref().map(Vec::len) == Some(pinned.row_centers.len())
        && (fresh.row_players != pinned.row_players || fresh.row_alive != pinned.row_alive)
}

/// Pure transplant: the pinned anchor with `fresh`'s row→name mapping and
/// alive flags (and pending flag) copied in — every geometry field untouched
/// (the mapping is indexed by row, and the rows themselves did not move).
/// `None` when [`should_transplant_rows`] says there is nothing to
/// transplant.
fn transplant_row_players(pinned: &OverlayAnchor, fresh: &OverlayAnchor) -> Option<OverlayAnchor> {
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
fn tab_order_from_anchor(
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
fn revalidate_pinned_anchor(app: &AppHandle, fsm: &mut WatchFsm, game: Option<GameWindow>) {
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
fn sink_check_pass(app: &AppHandle, fsm: &mut WatchFsm, game: &GameWindow) {
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
    let Some((rgba, w, h)) = capture_game_rgba(&game.rect) else {
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
    // A row's alive flag settled: update the pin, re-place (chips gray out
    // + re-sort + tab-order re-emitted when the mapping is trusted), flag
    // stale, and arm the fast OCR re-map.
    let mut updated = fsm
        .pinned_anchor
        .as_ref()
        .expect("checked above")
        .anchor
        .clone();
    updated.row_alive = Some(alive);
    fsm.stale = true;
    fsm.last_catch_up = None;
    if let Some(pin) = fsm.pinned_anchor.as_mut() {
        pin.anchor = updated.clone();
    }
    place_and_show(app, &updated, true);
    tracing::info!(
        sunk,
        rows = updated.row_centers.len(),
        "sink probe: alive flags changed — pin updated, stale, fast re-map armed"
    );
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

/// Physical state of the Tab key (true = down), regardless of focus.
#[cfg(target_os = "windows")]
fn tab_key_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_TAB};
    let state = unsafe { GetAsyncKeyState(VK_TAB.0 as i32) };
    (state as u16) & 0x8000 != 0
}

/// Place the overlay window over the game rect, push the anchor to the
/// webview, then show without activating. `stale` rides on the emitted
/// anchor (the FSM's current pin-staleness flag): true tells the overlay
/// page the row data just changed and the name re-map is in flight.
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
fn place_and_show(app: &AppHandle, anchor: &OverlayAnchor, stale: bool) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        tracing::warn!("overlay window missing — cannot show (was it destroyed?)");
        return;
    };
    let mut payload = anchor.clone();
    payload.stale = stale;
    if let Err(e) = app.emit(OVERLAY_ANCHOR_EVENT, &payload) {
        tracing::warn!(error = %e, "emit overlay-anchor failed");
    }
    // Mirror the on-screen row order to ALL windows (main window's
    // live-battle panel) whenever this anchor carries a TRUSTED mapping —
    // absent or all-unmatched mappings have nothing honest to say, and
    // skipping them also skips the arena read. The read is one small file
    // on the watcher thread, at most once per placed anchor — the same
    // cadence `row_recognize` already reads it at; without a roster there
    // is no battle identity to stamp the order with, so the event is
    // simply skipped.
    if !mapping_untrusted(&payload.row_players) {
        match super::arena_info::read_arena_snapshot() {
            Some((info, _)) => {
                if let Some(order) = tab_order_from_anchor(&payload, &info)
                    && let Err(e) = app.emit(TAB_ORDER_EVENT, &order)
                {
                    tracing::warn!(error = %e, "emit tab-order failed");
                }
            },
            None => tracing::debug!("tab-order skipped: no readable tempArenaInfo.json"),
        }
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
        &payload.overlay_rect,
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
fn place_and_show(_app: &AppHandle, _anchor: &OverlayAnchor, _stale: bool) {}

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

/// Capture the game window, resolve the table geometry (via the FSM's
/// per-game-window-mode cache when it verifies; a full detection otherwise)
/// and return the anchor for the chip layer. Falls back to a conservative
/// centered table when detection fails but a battle roster is known — stats
/// must still be readable. Fallback geometry never enters the cache.
#[cfg(target_os = "windows")]
fn compute_anchor(game: &GameWindow, fsm: &mut WatchFsm) -> Option<OverlayAnchor> {
    let team_sizes = super::arena_info::last_known_team_sizes();
    let Some((rgba, w, h)) = capture_game_rgba(&game.rect) else {
        tracing::warn!("game window capture returned no pixels");
        return None;
    };
    if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
        dump_capture(&rgba, w, h);
    }
    // ── Geometry cache: the full-frame scan runs ONCE per game-window mode;
    //    every later capture only re-verifies the cached header band (band-
    //    area cost) and reuses the cached grid. The cache deliberately
    //    survives battle changes — same window rect+style means the same
    //    pixel geometry, and a new battle shape rebuilds from the band.
    //    Resolved BEFORE the scene gate: a verified band IS the in-scene
    //    proof, so cache-hit frames pay no probe scan and no full-frame
    //    band search at all.
    let key = GeometryKey {
        game_rect: rect_from_win32(game.rect),
        style_bits: window_style_bits(game.hwnd),
    };
    let mut verify_missed = false;
    let mut band_verified = false;
    let cached = 'cache: {
        let Some(cache) = fsm.geometry_cache.as_mut() else {
            break 'cache None;
        };
        if cache.key != key {
            // The window moved / resized / changed style: everything about
            // the cached geometry is void — full re-detection on this frame.
            tracing::info!("game window mode changed — roster geometry cache voided");
            fsm.geometry_cache = None;
            fsm.geometry_verify_fails = 0;
            break 'cache None;
        }
        if overlay_detect::verify_header_band(&rgba, w, h, &cache.band) {
            fsm.geometry_verify_fails = 0;
            band_verified = true;
            if cache.team_sizes == team_sizes {
                break 'cache Some(cache.roster.clone());
            }
            // Same window, different battle shape (7v7 after 12v12):
            // rebuild the grid from the still-valid band — geometry, no
            // frame scan.
            let det = overlay_detect::rebuild_roster_from_band(&cache.band, w, h, team_sizes);
            cache.roster = det.clone();
            cache.team_sizes = team_sizes;
            break 'cache Some(det);
        }
        // The band is NOT at the cached spot on this frame — a HUD-phase
        // table move (or a scene change). The cached geometry must not
        // anchor this frame; count the miss and fall through. After
        // GEOMETRY_VERIFY_MAX_FAILS consecutive misses the cache is
        // declared dead so the full detector can re-acquire.
        fsm.geometry_verify_fails += 1;
        if fsm.geometry_verify_fails >= GEOMETRY_VERIFY_MAX_FAILS {
            tracing::info!(
                fails = fsm.geometry_verify_fails,
                "header band verify kept failing — roster geometry cache dropped"
            );
            fsm.geometry_cache = None;
            fsm.geometry_verify_fails = 0;
        } else {
            verify_missed = true;
        }
        break 'cache None;
    };
    if verify_missed {
        // Band verify missed but the cache is not (yet) declared dead: skip
        // BOTH the gate's full scans and the detection for THIS frame — the
        // next capture (sink probe 500 ms / catch-up 1.5 s / revalidate 5 s
        // / acquisition 1.5 s) re-judges cheaply. A full-frame band search
        // here would find the MOVED table, but rescanning every frame is
        // exactly the cost this cache exists to avoid; the strike counter
        // is the last-resort re-arm.
        return None;
    }
    // Scene gate (only reached for frames that will actually be detected:
    // a verified band or no cache). The HUD probe (HP bar + ship icons)
    // only renders inside the 3D scene, but holding Tab DIMS the whole
    // frame and real captures show it then finds as few as 2 icon clusters
    // (threshold 5) or a 12px HP run (threshold 48) — it kept rejecting
    // real battles. So the probe is only the SECOND opinion: the header
    // detection itself is the strongest possible in-scene proof (the
    // teal/brick team-header bars exist ONLY on the in-battle Tab table),
    // and either one passes. With a verified cached band this whole block
    // is skipped — the band verify already proved it.
    if !band_verified {
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
    }
    let (roster_rel, rows, split, detected) = if let Some(det) = cached {
        (det.rect, det.row_centers, det.team_split, true)
    } else {
        match overlay_detect::detect_roster_with_band(&rgba, w, h, team_sizes) {
            Some((band, det)) => {
                // Confirmed detection → (re)fill the cache. Fallback
                // geometry never enters it (table_detected == false never
                // pins, so it would never be reused by a pin path anyway).
                fsm.geometry_cache = Some(GeometryCacheEntry {
                    key,
                    band,
                    roster: det.clone(),
                    team_sizes,
                });
                fsm.geometry_verify_fails = 0;
                (det.rect, det.row_centers, det.team_split, true)
            },
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
        }
    };
    // Row → player-name recognition. Runs on the DETECTED capture-relative
    // geometry, before build_anchor re-bases it to the overlay origin; ON by
    // default (WOWSP_ROW_RECOGNIZER, engine `windows-ocr`) and a no-op then
    // only when it fails — the anchor keeps row_players = None, which the
    // frontend reads as the historical index mapping. Explicitly disabled
    // with the settings switch (`overlay-config.json` `roster: "off"`) or
    // the env (`off` / `null`). Every failure inside degrades to None and
    // must never disturb the anchor flow. `ally_rows` is the SAME
    // team_sizes read the detection grid above was built from — the single
    // source of truth for the pipeline's block split. The payload carries
    // BOTH the matched names and the per-row alive/sunk classification read
    // off the same name strips (sunk rows render dim gray).
    let row_state = if detected {
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
    anchor.row_players = row_state.as_ref().map(|s| s.names.clone());
    anchor.row_alive = row_state.map(|s| s.alive);
    // Pending flag: recognition is ENABLED but this anchor carries no
    // trusted row→name mapping yet — the arena roster was not ready, OCR
    // read nothing, or no row's text matched the roster (an all-`None` vec
    // is honest silence, NOT a trusted mapping). The overlay shows its
    // "recognizing roster" badge and the watcher keeps re-running
    // recognition (catch-up) until something actually matches. Manual
    // anchors never reach this code and keep the serde-default false; with
    // recognition off the engine gate is false as well.
    anchor.row_players_pending =
        row_recognize::recognizer_enabled() && mapping_untrusted(&anchor.row_players);
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

/// Pack `GWL_STYLE` + `GWL_EXSTYLE` into one geometry-cache key component:
/// a window-mode switch (borderless ↔ windowed) can theoretically keep the
/// outer rect identical while the styles change — the style bits turn that
/// into a cache miss too.
#[cfg(target_os = "windows")]
fn window_style_bits(hwnd: windows::Win32::Foundation::HWND) -> u64 {
    use windows::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW};
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        ((style as u64) << 32) | (ex as u64 & 0xffff_ffff)
    }
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

// ─────────────────────────────────────────────────────────────────────────
// Tests (pure manual-anchor logic — no Win32, no window needed)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
        let fresh_same =
            anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
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
        let recovered_pin =
            anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
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
        let ready_pin = anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
        let fallback_pin = anchor_with_players(2, false, None, false);
        // Pending (absent or all-None mapping) + engine on + throttle
        // elapsed → run the catch-up pass.
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
        // …but not without the engine, the throttle, a pin, a confirmed
        // table, or once a trusted mapping has landed.
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
        let (apply, cand) =
            sink_probe_confirm(Some(&pinned), Some((&cvec, cseen)), &revived_a, late);
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
                game_rect: game,
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
}
