use super::*;
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

/// Whether the Windows OCR engine could be built on this machine (an
/// installed OCR language pack) — the settings UI probes this once to offer
/// the `ocr` roster mode or gray it out. Desktop only (no overlay on
/// mobile), `false` everywhere the engine does not exist.
#[tauri::command]
pub async fn overlay_ocr_available() -> bool {
    row_recognize::engine_available()
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
            let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
            // Same band re-assert every other show path does (see
            // [`place_and_show_async`]): a preview shown from the settings
            // window must land on top of the game, not behind it.
            reassert_topmost(hwnd);
            show_async(hwnd);
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
