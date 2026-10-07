use super::*;

/// Longest sample gap (ms) the tracker still reads as "the same, unbroken
/// key run". The watcher samples every 30 ms and its normal ticks are far
/// shorter than this; a longer gap means samples were missed — a release
/// inside the gap may have gone unseen — so the run is restamped. Both
/// consequences of a restamp are the SAFE direction: a cache store waits
/// longer (the gate is not yet passed) and the acquisition retry re-arms
/// on the short young-hold cadence.
const HOLD_SAMPLE_GAP_MS: u64 = 400;

/// Edge tracker for the physical Tab key: remembers when the current
/// down-period began, so a capture taken in the FIRST instants of a press
/// can be kept out of the manual-locate cache — the game fades the table
/// in (and dims the scene) after the press, and a BitBlt inside that
/// window photographs an un-dimmed, table-less frame (see
/// `capture_game_rgba_cached`). Pure logic, unit-tested without Win32.
///
/// Run continuity is only trusted across CONTIGUOUS samples
/// ([`HOLD_SAMPLE_GAP_MS`]): the watcher can stop across a release (page
/// switch, view-mode flip), and a stamp kept from before the gap would then
/// report an hours-long "hold" on the next press — the old tracker did
/// exactly that, silently re-opening the pre-fade store it exists to close.
/// A stale run is restamped on the next observed press instead.
#[derive(Debug, Default)]
pub(crate) struct TabHoldTracker {
    down_at_ms: Option<u64>,
    /// Arrival time of the last sample — the continuity witness.
    last_seen_ms: Option<u64>,
}

impl TabHoldTracker {
    /// Feed one key sample (stamps the down-edge when a run of `true`
    /// arrives — after a release, or across samples that were not
    /// contiguous — and clears it on `false`); returns the sample
    /// unchanged.
    pub(crate) fn observe(&mut self, down: bool, now_ms: u64) -> bool {
        if down {
            let contiguous = self
                .last_seen_ms
                .is_some_and(|seen| now_ms.saturating_sub(seen) <= HOLD_SAMPLE_GAP_MS);
            // No live edge (fresh press, or one that arrived after a gap the
            // watcher did not cover) → this sample IS the edge.
            if self.down_at_ms.is_none() || !contiguous {
                self.down_at_ms = Some(now_ms);
            }
        } else {
            self.down_at_ms = None;
        }
        self.last_seen_ms = Some(now_ms);
        down
    }

    /// How long the key has been continuously down (`None` while up).
    pub(crate) fn held_for(&self, now_ms: u64) -> Option<Duration> {
        self.down_at_ms
            .map(|at| Duration::from_millis(now_ms.saturating_sub(at)))
    }
}

/// Shared tracker instance, fed by every `tab_key_down()` poll (the watcher
/// ticks at 30 ms, so the down-edge is stamped within one tick).
#[cfg(target_os = "windows")]
static TAB_HOLD: Mutex<TabHoldTracker> = Mutex::new(TabHoldTracker {
    down_at_ms: None,
    last_seen_ms: None,
});

#[cfg(target_os = "windows")]
fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Physical state of the Tab key (true = down), regardless of focus. Every
/// call also feeds [`TabHoldTracker`] so [`tab_held_for`] stays fresh.
#[cfg(target_os = "windows")]
pub(super) fn tab_key_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_TAB};
    let state = unsafe { GetAsyncKeyState(VK_TAB.0 as i32) };
    let down = (state as u16) & 0x8000 != 0;
    if let Ok(mut tracker) = TAB_HOLD.lock() {
        tracker.observe(down, epoch_ms());
    }
    down
}

/// How long Tab has been continuously held right now (`None` while up, or
/// when the lock is wedged — both simply mean "not cacheable yet").
#[cfg(target_os = "windows")]
pub(super) fn tab_held_for() -> Option<Duration> {
    let tracker = TAB_HOLD.lock().ok()?;
    tracker.held_for(epoch_ms())
}

/// Place the overlay window over the game rect, push the anchor to the
/// page, then show without activating.
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
pub(super) fn place_and_show(app: &AppHandle, anchor: &OverlayAnchor) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        tracing::warn!("overlay window missing — cannot show (was it destroyed?)");
        return;
    };
    let mut payload = anchor.clone();
    // The attribution mode rides on EVERY emitted anchor (single emit point,
    // manual anchors included): the overlay page branches on it per render,
    // so a settings flip applies from the next Tab press on — no window
    // reload, no extra event.
    payload.roster_mode = super::overlay_config::roster_mode().as_str().to_string();
    if let Err(e) = app.emit(OVERLAY_ANCHOR_EVENT, &payload) {
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
pub(super) fn place_and_show(_app: &AppHandle, _anchor: &OverlayAnchor) {}

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
