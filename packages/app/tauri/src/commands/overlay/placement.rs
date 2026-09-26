use super::*;
/// Physical state of the Tab key (true = down), regardless of focus.
#[cfg(target_os = "windows")]
pub(super) fn tab_key_down() -> bool {
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
pub(super) fn place_and_show(app: &AppHandle, anchor: &OverlayAnchor, stale: bool) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        tracing::warn!("overlay window missing — cannot show (was it destroyed?)");
        return;
    };
    let mut payload = anchor.clone();
    payload.stale = stale;
    // The attribution mode rides on EVERY emitted anchor (single emit point,
    // manual anchors included): the overlay page branches on it per render,
    // so a settings flip applies from the next Tab press on — no window
    // reload, no extra event.
    payload.roster_mode = super::overlay_config::roster_mode().as_str().to_string();
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
        HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SetWindowPos,
    };
    unsafe {
        // ASYNCWINDOWPOS is load-bearing: without it a cross-thread
        // SetWindowPos SYNCHRONOUSLY posts to the owning thread and waits;
        // a main thread busy with WebView2 resize work then stalls THIS
        // watcher thread — Tab polling stops, and rapid pressing feels
        // permanently dead.
        //
        // HWND_TOPMOST (re-asserted on EVERY show, instead of the previous
        // SWP_NOZORDER "leave the band alone") is load-bearing too: the
        // topmost bit set at window CREATION does not survive ordinary use —
        // switching windows, Alt-Tab and the game re-entering its own
        // topmost/fullscreen state all reorder the topmost band, and once
        // the overlay sits below the game it stays there: every later show
        // would place a window nobody can see. Re-stamping the band here
        // makes the first Tab press after any of that put the chips back on
        // top. SWP_NOACTIVATE still keeps the game focused (never steal it).
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            r.x,
            r.y,
            r.width.max(1),
            r.height.max(1),
            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE,
        );
        show_async(hwnd);
    }
}

/// Async no-activate show — `ShowWindowAsync` posts to the window's own
/// thread and returns at once (the sync `ShowWindow` from a foreign thread
/// can block on that thread's message queue).
#[cfg(target_os = "windows")]
pub(super) fn show_async(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindowAsync};
    unsafe {
        let _ = ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
    }
}

/// Geometry-free twin of the band re-assert inside [`place_and_show_async`]
/// (move/resize/activate all left alone) for show paths that only need the
/// window brought to the top of the topmost band.
#[cfg(target_os = "windows")]
pub(super) fn reassert_topmost(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
        SWP_NOSIZE, SetWindowPos,
    };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn place_and_show(_app: &AppHandle, _anchor: &OverlayAnchor, _stale: bool) {}

/// Hide the overlay: HTML-level hide FIRST (the event reaches the page
/// directly from this thread), then the async native hide. Both idempotent —
/// the watcher re-sends the whole thing every [`HIDE_RETRY`] while Tab is up.
#[cfg(target_os = "windows")]
pub(super) fn hide_overlay(app: &AppHandle) {
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
pub(super) fn hide_overlay(_app: &AppHandle) {}
