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
//! correct attribution without ever wandering.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use wowsp_tauri_shared::{CaptureResult, OverlayAnchor, OverlayState, OverlayStatus, Rect};

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
    // Manual-locate leftovers must not outlive overlay mode: an open picker
    // window and a stored anchor are both torn down BEFORE the watcher
    // stops, so its loop-exit idle report already carries manual: false.
    destroy_manual_locate_window(&app);
    if take_manual_anchor().is_some() {
        tracing::info!("manual anchor dropped with overlay mode");
    }
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
/// game-window geometry. Stored across Tab presses in [`MANUAL_ANCHOR`]:
/// while the battle stamp and the game rect both still match, every Tab
/// hold anchors the chips to this box instead of running the detector.
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

/// Cross-press manual anchor store (same static pattern as `TAB_WATCHER`).
/// `None` = no manual anchor in force.
static MANUAL_ANCHOR: Mutex<Option<ManualAnchor>> = Mutex::new(None);

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

/// Pure decision: does the stored manual anchor still apply to this battle
/// on this game-window geometry?
fn manual_anchor_check(battle: i64, game_rect: Option<Rect>) -> ManualAnchorCheck {
    let Ok(guard) = MANUAL_ANCHOR.lock() else {
        return ManualAnchorCheck::Inert;
    };
    let Some(m) = guard.as_ref() else {
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

/// Drop the stored manual anchor, whatever the reason (battle/window change,
/// explicit clear, overlay-mode teardown).
fn take_manual_anchor() -> Option<ManualAnchor> {
    let mut guard = MANUAL_ANCHOR.lock().ok()?;
    guard.take()
}

/// Total row count of the STORED manual anchor, when one is armed (any
/// liveness — the watcher only expires it on the focused+Tab path). Drives
/// the `manual` flag on automatic status reports: while the anchor survives
/// an Idle/Searching transition, the panel's manual badge + clear button
/// must survive it with it.
fn manual_anchor_stored_rows() -> Option<u32> {
    let guard = MANUAL_ANCHOR.lock().ok()?;
    guard
        .as_ref()
        .map(|m| (m.team_sizes.0 + m.team_sizes.1) as u32)
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
/// origin): validate it, freeze it as the manual anchor for the CURRENT
/// battle + game geometry, and close the picker. The anchor takes effect on
/// the next Tab hold; the status broadcast flips the live-battle panel to
/// its manual badge immediately.
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
    *MANUAL_ANCHOR
        .lock()
        .map_err(|e| format!("manual anchor lock: {e}"))? = Some(ManualAnchor {
        battle,
        game_rect,
        rect: sel,
        team_sizes,
    });
    // Immediate panel feedback (green "manually located" badge + the button
    // flips to "clear"). The watcher re-emits the identical payload when it
    // actually places the chips, so a lost race costs nothing.
    let rows = (team_sizes.0 + team_sizes.1) as u32;
    if let Err(e) = app.emit(
        OVERLAY_STATUS_EVENT,
        OverlayStatus {
            state: OverlayState::Manual,
            rows: Some(rows),
            manual: true,
        },
    ) {
        tracing::warn!(error = %e, "emit overlay-status failed");
    }
    // Success — the picker's job is done; it must not linger as a zombie.
    destroy_manual_locate_window(&app);
    tracing::info!(
        battle,
        sel = format!("{}x{} at ({},{})", sel.width, sel.height, sel.x, sel.y),
        allies = team_sizes.0,
        enemies = team_sizes.1,
        "manual roster anchor set"
    );
    Ok(())
}

/// Drop the manual anchor (the live-battle panel's "clear locate" button)
/// and report the state the overlay is ACTUALLY in: visible → the automatic
/// flow is searching; hidden (Tab up / game unfocused) → idle. An
/// unconditional "searching" would stick forever — the watcher's hide branch
/// only runs while the overlay is shown, so nothing would ever demote the
/// badge afterwards. Also closes the picker if one is somehow still open.
#[tauri::command]
pub async fn clear_manual_roster_rect(app: AppHandle) -> Result<(), String> {
    if take_manual_anchor().is_some() {
        tracing::info!("manual anchor cleared by user");
    }
    destroy_manual_locate_window(&app);
    let state = if overlay_window_visible(&app) {
        OverlayState::Searching
    } else {
        OverlayState::Idle
    };
    if let Err(e) = app.emit(
        OVERLAY_STATUS_EVENT,
        OverlayStatus {
            state,
            rows: None,
            manual: false,
        },
    ) {
        tracing::warn!(error = %e, "emit overlay-status failed");
    }
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

/// Push a detection-status report to ALL windows — but only when it differs
/// from the last emitted one: the tick runs at ~30 Hz and its branches
/// re-enter every poll, while the consumer (the live-battle panel badge)
/// wants edge events, not level events. `last_status` is the loop-local
/// mirror of what already went out (`None` = nothing emitted yet). Emissions
/// from OUTSIDE the loop (`set_manual_roster_rect` /
/// `clear_manual_roster_rect`) bypass this mirror — a duplicate payload at
/// the consumer is harmless, so the loop just re-emits on its next edge.
///
/// While a manual anchor is STORED (armed, whatever its liveness), every
/// automatic report carries `manual: true` and the anchor's row count: the
/// panel's green manual badge + clear button must survive Idle/Searching
/// transitions, because the anchor itself does — it re-anchors on the same
/// battle's next Tab hold.
#[cfg(target_os = "windows")]
fn report_status(
    app: &AppHandle,
    last_status: &mut Option<OverlayStatus>,
    state: OverlayState,
    rows: Option<u32>,
) {
    let manual_rows = manual_anchor_stored_rows();
    let manual = manual_rows.is_some() || state == OverlayState::Manual;
    let status = OverlayStatus {
        state,
        rows: rows.or(manual_rows.filter(|_| manual)),
        manual,
    };
    if *last_status == Some(status) {
        return;
    }
    *last_status = Some(status);
    if let Err(e) = app.emit(OVERLAY_STATUS_EVENT, status) {
        tracing::warn!(error = %e, "emit overlay-status failed");
    }
}

/// The watcher loop — see the module docs for the interaction contract.
#[cfg(target_os = "windows")]
fn watch_tab_loop(app: AppHandle, stop: Arc<AtomicBool>) {
    let mut overlay_shown = false;
    let mut pinned_anchor: Option<PinnedAnchor> = None;
    // Whether the CURRENTLY shown overlay is the manual anchor's placement
    // (vs an automatic detection): gates the one-shot manual place_and_show
    // so a live manual anchor does not re-place every 30 ms tick.
    let mut manual_shown = false;
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
    // When the last recognition CATCH-UP pass ran. Its own stamp (not
    // last_capture_attempt — that one only gates the acquisition arm, which
    // never runs while a confirmed pin is shown) spaces the faster-than-5 s
    // revalidation passes that keep trying while a pin still lacks its
    // row→name mapping.
    let mut last_catch_up: Option<Instant> = None;
    // Mirror of the LAST `wowsp://overlay-status` payload emitted (None =
    // nothing emitted yet). report_status() drops reports identical to it,
    // so the per-tick status pushes are edge events, not level events.
    let mut last_status: Option<OverlayStatus> = None;

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
                &mut manual_shown,
                &mut cached_game,
                &mut last_scan,
                &mut last_capture_attempt,
                &mut last_hide,
                &mut last_state_refresh,
                &mut last_revalidate,
                &mut last_catch_up,
                &mut last_status,
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
    // Nor a stale badge in the main window: drop the panel to idle (a no-op
    // when the last emitted state already was idle).
    report_status(&app, &mut last_status, OverlayState::Idle, None);
}

/// One poll iteration of the Tab watcher (factored out so the loop can wrap
/// it in `catch_unwind`).
#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn watch_tab_tick(
    app: &AppHandle,
    overlay_shown: &mut bool,
    pinned_anchor: &mut Option<PinnedAnchor>,
    manual_shown: &mut bool,
    cached_game: &mut Option<(GameWindow, Instant)>,
    last_scan: &mut Option<Instant>,
    last_capture_attempt: &mut Option<Instant>,
    last_hide: &mut Option<Instant>,
    last_state_refresh: &mut Option<Instant>,
    last_revalidate: &mut Option<Instant>,
    last_catch_up: &mut Option<Instant>,
    last_status: &mut Option<OverlayStatus>,
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
            && last_state_refresh.is_none_or(|t| t.elapsed() >= STATE_REFRESH)
        {
            *last_state_refresh = Some(Instant::now());
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
        let manual_active =
            if !picker_open && focused_on_game && tab_down && battle_known && !table_off {
                match manual_anchor_check(battle, game_rect) {
                    ManualAnchorCheck::Live(m, r) => Some((m, r)),
                    ManualAnchorCheck::Stale => {
                        // New battle, or the game window moved/resized: expire
                        // silently back to the automatic flow (the panel status
                        // flips via the normal searching/idle reports).
                        tracing::info!(battle, "manual anchor expired — back to auto detection");
                        take_manual_anchor();
                        None
                    },
                    // Nothing stored — or no game rect this tick to judge the
                    // window-geometry half with.
                    ManualAnchorCheck::Inert => None,
                }
            } else {
                None
            };

        let want_visible =
            focused_on_game && tab_down && battle_known && !picker_open && !table_off;
        if let Some((m, manual_game)) = manual_active {
            // Place ONCE per manual hold, not every 30 ms tick.
            if !*overlay_shown || !*manual_shown {
                let anchor = build_manual_anchor(&m, manual_game);
                place_and_show(app, &anchor);
                report_status(
                    app,
                    last_status,
                    OverlayState::Manual,
                    Some(anchor.row_centers.len() as u32),
                );
                *overlay_shown = true;
                *manual_shown = true;
                *last_hide = None;
            }
            // The manual anchor owns this tick: neither the automatic
            // acquisition path below nor the hide-retry branch may touch
            // the overlay while it stays live.
            return;
        }
        *manual_shown = false;
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
                // Status: acquiring without a confirmed pin. The one
                // unambiguous "tried and failed" signal is the centered
                // fallback hint being what's on screen — which is exactly
                // what a Fallback mirror state means (it is emitted only
                // from the two places below that put/keep the hint up, and
                // every hide resets it to Idle). Everything else reads as
                // Searching; report_status dedups the per-tick re-pushes.
                if last_status
                    .as_ref()
                    .is_some_and(|s| s.state == OverlayState::Fallback)
                {
                    report_status(app, last_status, OverlayState::Fallback, None);
                } else {
                    report_status(app, last_status, OverlayState::Searching, None);
                }
                // BATTLE-PINNED anchor first: once a table was located for
                // THIS battle and this game-window geometry, every later
                // press reuses it verbatim — per-press re-detection measured
                // slightly different header bands frame to frame and the
                // chips visibly wandered ("飘"). The pin lives for the whole
                // battle (arena stamp) or until the window moves/resizes.
                // (`battle` / `game_rect` are hoisted to the tick top, where
                // the manual-anchor check above shares them.)
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
                    // Status: what is on screen NOW. A confirmed anchor pins
                    // the chips (detected + row count); a fallback anchor is
                    // (or would re-place) the centered hint. place_and_show
                    // may skip a redundant re-place of the hint, but the
                    // hint staying up is still Fallback — and the mirror
                    // dedup swallows the no-op anyway.
                    if anchor.table_detected {
                        report_status(
                            app,
                            last_status,
                            OverlayState::Detected,
                            Some(anchor.row_centers.len() as u32),
                        );
                    } else {
                        report_status(app, last_status, OverlayState::Fallback, None);
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
            } else if should_catch_up_recognition(
                pinned_anchor.as_ref().map(|p| &p.anchor),
                row_recognize::recognizer_enabled(),
                last_catch_up.is_none_or(|t| t.elapsed() >= CAPTURE_MIN_INTERVAL),
            ) {
                // Recognition is still pending on a CONFIRMED pin (the arena
                // roster landed after the pin, or the first OCR pass read
                // nothing): run the SAME revalidation pass at the capture
                // rate limit instead of waiting the full 5 s — the fresh
                // detection both re-checks the geometry and carries a new
                // row→name mapping for the transplant inside. The pass bumps
                // last_revalidate itself, so the two cadences never stack.
                *last_catch_up = Some(Instant::now());
                revalidate_pinned_anchor(app, pinned_anchor, game, last_revalidate, last_status);
            } else if last_revalidate.is_none_or(|t| t.elapsed() >= ANCHOR_REVALIDATE_INTERVAL) {
                // Shown AND pinned (the only way to reach this arm):
                // periodically re-check the pin against a live detection —
                // the panel moves as a whole when HUD phases change
                // (countdown → combat) and neither pin key (arena stamp,
                // window rect) can see it.
                revalidate_pinned_anchor(app, pinned_anchor, game, last_revalidate, last_status);
            }
        } else if *overlay_shown {
            // Keep re-sending the hide while the overlay should be down:
            // each attempt posts one async Win32 command + one event, and
            // any single one can be lost; both are idempotent. Retries stop
            // once the window reports itself actually hidden.
            if last_hide.is_none_or(|t| t.elapsed() >= HIDE_RETRY) {
                hide_overlay(app);
                // Overlay going down — drop the panel badge to idle. The
                // mirror dedup keeps the hide-retry re-sends from emitting
                // this more than once.
                report_status(app, last_status, OverlayState::Idle, None);
                *last_hide = Some(Instant::now());
                if !overlay_window_visible(app) {
                    *overlay_shown = false;
                }
            }
        }
    }
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

/// Pure catch-up gate (unit-testable; time and engine availability are
/// injected by the caller): run a recognition catch-up pass when a CONFIRMED
/// pin is on screen but still lacks a trusted row→name mapping (absent, or
/// an all-`None` read — nothing matched) while recognition is enabled — and
/// the throttle says a capture may run.
///
/// Keeping the gate armed on an all-`None` pin cannot oscillate: a
/// deterministic re-read is again all-`None`, compares equal to the pin's
/// mapping, `should_transplant_rows` stays false and the pass re-emits
/// nothing.
fn should_catch_up_recognition(
    pin: Option<&OverlayAnchor>,
    recognizer_on: bool,
    throttle_elapsed: bool,
) -> bool {
    pin.is_some_and(|p| p.table_detected && mapping_untrusted(&p.row_players))
        && recognizer_on
        && throttle_elapsed
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
///   the anchor.
fn should_transplant_rows(fresh: &OverlayAnchor, pinned: &OverlayAnchor) -> bool {
    fresh.table_detected
        && fresh.row_players.as_ref().map(Vec::len) == Some(pinned.row_centers.len())
        && fresh.row_players != pinned.row_players
}

/// Pure transplant: the pinned anchor with `fresh`'s row→name mapping and
/// pending flag copied in — every geometry field untouched (the mapping is
/// indexed by row, and the rows themselves did not move). `None` when
/// [`should_transplant_rows`] says there is nothing to transplant.
fn transplant_row_players(pinned: &OverlayAnchor, fresh: &OverlayAnchor) -> Option<OverlayAnchor> {
    if !should_transplant_rows(fresh, pinned) {
        return None;
    }
    let mut updated = pinned.clone();
    updated.row_players = fresh.row_players.clone();
    // Pending survives an all-`None` transplant (honest silence is not a
    // trusted mapping — the badge and the catch-up stay on); only a
    // mapping that matched at least one row clears it.
    updated.row_players_pending = mapping_untrusted(&updated.row_players);
    Some(updated)
}

/// One revalidation pass over the pinned anchor while the overlay is shown:
/// re-run the capture + detector against the live frame and reconcile the
/// pin with it. Two outcomes change the pin (re-emitting the anchor):
///
/// - the table MOVED at row scale (`overlay_detect::anchor_meaningfully_moved`)
///   → the whole pin is replaced by the fresh anchor, which carries its own
///   fresh recognition;
/// - the geometry is unchanged but the row→name mapping CHANGED
///   ([`transplant_row_players`] — first recognition landing after the pin
///   because the arena roster file was late, or a re-detection after sinks
///   re-sorted the rows) → only `row_players` / `row_players_pending` are
///   transplanted onto the pin, geometry untouched.
///
/// Every other outcome — a failed capture, a fallback detection, sub-pitch
/// jitter, an identical mapping — keeps the pin and emits nothing, so this
/// pass can never make the chips wander. Status reports are only touched by
/// the move-replacement (whose row count may change); a transplant keeps the
/// `detected` state and merely re-renders the chips.
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
    last_status: &mut Option<OverlayStatus>,
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
    if overlay_detect::anchor_meaningfully_moved(&pinned, &fresh) {
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
        // The replacement anchor is always CONFIRMED (a fallback fresh anchor
        // can never move past `anchor_meaningfully_moved` against a confirmed
        // pin) — but its row count may differ from the old pin's. report_status
        // dedups, so an unchanged layout costs nothing.
        report_status(
            app,
            last_status,
            OverlayState::Detected,
            Some(fresh.row_centers.len() as u32),
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
        if let Some(pin) = pinned_anchor.as_mut() {
            pin.anchor = updated.clone();
        }
        place_and_show(app, &updated);
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
    // Row → player-name recognition. Runs on the DETECTED capture-relative
    // geometry, before build_anchor re-bases it to the overlay origin; ON by
    // default (WOWSP_ROW_RECOGNIZER, engine `windows-ocr`) and a no-op then
    // only when it fails — the anchor keeps row_players = None, which the
    // frontend reads as the historical index mapping. Explicitly disabled
    // with the settings switch (`overlay-config.json` `roster: "off"`) or
    // the env (`off` / `null`). Every failure inside degrades to None and
    // must never disturb the anchor flow. `ally_rows` is the SAME
    // team_sizes read the detection grid above was built from — the single
    // source of truth for the pipeline's block split.
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
            row_players_pending: pending,
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
    fn catch_up_gate_needs_pin_pending_engine_and_throttle() {
        let pending_pin = anchor_with_players(2, true, None, true);
        // An all-None mapping (text read, nothing matched) is NOT ready —
        // catch-up stays armed for it too.
        let all_none_pin = anchor_with_players(2, true, Some(vec![None, None]), false);
        let ready_pin = anchor_with_players(2, true, Some(vec![Some("Alpha".into()), None]), false);
        let fallback_pin = anchor_with_players(2, false, None, false);
        // Pending (absent or all-None mapping) + engine on + throttle
        // elapsed → run the catch-up pass.
        assert!(should_catch_up_recognition(Some(&pending_pin), true, true));
        assert!(should_catch_up_recognition(Some(&all_none_pin), true, true));
        // …but not without the engine, the throttle, a pin, a confirmed
        // table, or once a trusted mapping has landed.
        assert!(!should_catch_up_recognition(
            Some(&pending_pin),
            false,
            true
        ));
        assert!(!should_catch_up_recognition(
            Some(&pending_pin),
            true,
            false
        ));
        assert!(!should_catch_up_recognition(None, true, true));
        assert!(!should_catch_up_recognition(Some(&ready_pin), true, true));
        assert!(!should_catch_up_recognition(
            Some(&fallback_pin),
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
        *MANUAL_ANCHOR.lock().unwrap() = Some(stored.clone());

        // Same battle + same window → live.
        assert!(matches!(
            manual_anchor_check(111, Some(game)),
            ManualAnchorCheck::Live(_, r) if r == game
        ));
        // New battle → stale.
        assert!(matches!(
            manual_anchor_check(222, Some(game)),
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
            manual_anchor_check(111, Some(moved)),
            ManualAnchorCheck::Stale
        ));
        // No game rect this tick → inert (NOT stale: a transient HWND miss
        // must not nuke the box).
        assert!(matches!(
            manual_anchor_check(111, None),
            ManualAnchorCheck::Inert
        ));

        // While stored, the anchor's row total backs the automatic status
        // reports' manual flag (the panel badge survives Idle/Searching).
        assert_eq!(manual_anchor_stored_rows(), Some(24)); // 12 + 12

        // Empty store → inert, and no manual rows to report.
        *MANUAL_ANCHOR.lock().unwrap() = None;
        assert!(matches!(
            manual_anchor_check(111, Some(game)),
            ManualAnchorCheck::Inert
        ));
        assert_eq!(manual_anchor_stored_rows(), None);
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
}
