//! The tray panel — a small frameless webview window anchored to the tray
//! icon, rendering the hikari-styled session panel (`tray.html`, a third
//! Vite entry beside the main shell and the overlay page).
//!
//! This panel IS the tray menu: any tray-icon click (left or right) toggles
//! it, and it shows the same session state the main window's bottom-left
//! footer does (running client + who is playing — see `commands/session`)
//! plus the old native menu's actions (show / hide / quit). The window is
//! created lazily on the first click and then kept alive hidden, so
//! subsequent toggles are instant.
//!
//! Unlike the overlay it is a normal activatable window: it takes focus on
//! show (so a click anywhere outside — `Focused(false)` in `lib.rs`'s window
//! handler — hides it again) and its buttons work. `WS_EX_TOOLWINDOW` keeps
//! it out of Alt-Tab; `always_on_top` keeps it above the app it floats over.

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Window label (must be listed in `capabilities/default.json`).
pub const TRAY_PANEL_LABEL: &str = "tray-panel";

/// Panel size in LOGICAL px (scaled by the target monitor's factor). Fixed:
/// the content is a compact status + menu list that must never scroll.
const PANEL_LOGICAL: (f64, f64) = (320.0, 372.0);

/// Edge breathing room (physical px) when clamping against the work area.
const WORK_AREA_MARGIN: f64 = 8.0;

/// When the panel was last hidden, and the grace window in which a tray
/// click counts as the toggle-OFF half instead of a fresh open. Clicking
/// the tray while the panel is up first BLURS the panel (the focus-loss
/// hide in `lib.rs`), so by the time the click event arrives the panel is
/// already hidden — without this guard every "close" click would just
/// re-open it.
static LAST_HIDE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const HIDE_GRACE: std::time::Duration = std::time::Duration::from_millis(300);

fn note_hidden() {
    *LAST_HIDE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(std::time::Instant::now());
}

fn hidden_within_grace() -> bool {
    LAST_HIDE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some_and(|at| at.elapsed() < HIDE_GRACE)
}

/// Toggle the panel from a tray-icon click: hide when open (or when the
/// blur-hide just closed it — see [`HIDE_GRACE`]), otherwise (create and)
/// position + show next to the icon. `icon` is the tray icon's physical
/// rect (position + size); `cursor` the click's physical position — the
/// rect carries no orientation info on auto-hidden trays, so the cursor
/// backs the fallback anchor.
pub fn toggle_from_tray(app: &AppHandle, cursor: &PhysicalPosition<f64>, icon: &tauri::Rect) {
    let Some(win) = ensure_tray_panel(app) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        note_hidden();
        return;
    }
    if hidden_within_grace() {
        // The blur-hide already closed the panel right before this click
        // landed — this click IS the toggle-off half; no re-stamp (that
        // would extend the grace window on every click inside it).
        return;
    }
    place_and_show(&win, cursor, icon);
}

/// The panel's copy of the old native menu's actions (its buttons invoke
/// this). `dismiss` is the panel's own Esc/outside-click close. Quit runs
/// the same graceful drain the main window's close dialog does.
#[cfg(desktop)]
#[tauri::command]
pub fn tray_panel_action(app: AppHandle, action: String) -> Result<(), String> {
    match action.as_str() {
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            hide_panel(&app);
            Ok(())
        },
        "hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            hide_panel(&app);
            Ok(())
        },
        "dismiss" => {
            hide_panel(&app);
            Ok(())
        },
        "quit" => {
            tracing::info!("tray panel quit → graceful drain + exit");
            if let Some(d) = app.try_state::<malkuth::DrainController>() {
                d.begin_drain(malkuth::ShutdownKind::Graceful);
            }
            app.exit(0);
            Ok(())
        },
        other => Err(format!("unknown tray panel action: {other}")),
    }
}

/// Hide the panel (blur / Esc / menu action paths) and stamp the hide for
/// [`HIDE_GRACE`].
pub fn hide_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = w.hide();
        note_hidden();
    }
}

/// Debug/dev affordance (the `WOWSP_AUTOSTART_TRAY_PANEL` env var, wired in
/// `lib.rs`'s setup beside the `WOWSP_AUTOSTART_PAIRING` precedent): open the
/// panel WITHOUT a tray click, anchored to the primary work area's
/// bottom-right corner — the same placement a bottom taskbar tray click
/// produces. Manual/visual verification flows only; never compiled into
/// release builds.
#[cfg(all(debug_assertions, desktop))]
pub fn debug_show(app: &AppHandle) {
    let Some(win) = ensure_tray_panel(app) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        return;
    }
    // PRIMARY monitor, not the window's current one: the panel is created
    // hidden, and a hidden window has no monitor attachment yet —
    // current_monitor() answers None and the whole placement would no-op
    // (the panel would stay at its creation-default position, still hidden).
    let Some(monitor) = win.primary_monitor().ok().flatten() else {
        return;
    };
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    let panel = (PANEL_LOGICAL.0 * scale, PANEL_LOGICAL.1 * scale);
    let work = (
        wa.position.x as f64,
        wa.position.y as f64,
        wa.size.width as f64,
        wa.size.height as f64,
    );
    // A synthetic 40×40 tray-icon cell just inside the work area's
    // bottom-right corner: panel_origin opens above it and clamps.
    let icon = (work.0 + work.2 - 60.0, work.1 + work.3 - 60.0, 40.0, 40.0);
    let (x, y) = panel_origin(icon, panel, work);
    let _ = win.set_size(PhysicalSize::new(panel.0, panel.1));
    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = win.show();
    let _ = win.set_focus();
}

/// Create the panel window on first use (idempotent). Starts hidden —
/// [`place_and_show`] positions and reveals it. Errors are logged, not
/// propagated: a failed panel creation must never take the tray click down
/// with it (double-click still restores the main window, whose close dialog
/// carries quit — the escape hatch now that no native menu exists).
fn ensure_tray_panel(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(win) = app.get_webview_window(TRAY_PANEL_LABEL) {
        return Some(win);
    }
    // Seed the OS locale/scheme prefs BEFORE any page JS runs (the main
    // setup only evals the seed into the FIRST window it finds, so a
    // lazily-created panel would otherwise locale-detect from
    // navigator.language alone — see os_prefs + the i18n detect). An
    // initialization SCRIPT rides every navigation, unlike a post-build
    // eval whose ordering against the first load is not guaranteed.
    let prefs = crate::os_prefs::detect();
    let seed = crate::os_prefs::initialization_script(&prefs);
    let win =
        WebviewWindowBuilder::new(app, TRAY_PANEL_LABEL, WebviewUrl::App("/tray.html".into()))
            .title("WoWSP Tray")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .inner_size(PANEL_LOGICAL.0, PANEL_LOGICAL.1)
            .initialization_script(seed)
            .build();
    match win {
        Ok(win) => {
            post_create_setup(&win);
            Some(win)
        },
        Err(e) => {
            tracing::warn!(error = %e, "create tray panel window failed");
            None
        },
    }
}

/// Windows-specific styling: TOOLWINDOW keeps the borderless window out of
/// Alt-Tab; DWM non-client rendering is disabled so the transparent window
/// shows no 1px system border (same rationale as the overlay's setup, minus
/// the click-through/no-activate bits — the panel must accept clicks and
/// focus).
#[cfg(target_os = "windows")]
fn post_create_setup(win: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND, DwmSetWindowAttribute,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_TOOLWINDOW,
    };
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW.0 as isize);
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
fn post_create_setup(_win: &WebviewWindow) {}

/// Position the panel next to the tray icon (inside that monitor's work
/// area) and show + focus it. The monitor is resolved from the CURSOR
/// (always physical px, even when the icon rect reports logical units);
/// all placement math is then physical, scaling the panel's logical size by
/// that monitor's factor.
fn place_and_show(win: &WebviewWindow, cursor: &PhysicalPosition<f64>, icon: &tauri::Rect) {
    let Some(monitor) = win.monitor_from_point(cursor.x, cursor.y).ok().flatten() else {
        // No monitor resolved (exotic multi-monitor teardown moment) — show
        // where the window already is rather than dropping the click.
        let _ = win.show();
        let _ = win.set_focus();
        return;
    };
    let scale = monitor.scale_factor();
    // Anchor rect: the tray icon's own rect (logical → physical when the
    // event reported logical units); on zero-size reports (some auto-hidden
    // trays) a 40×40 cell around the cursor.
    let (ix, iy, iw, ih) = rect_physical(icon, scale);
    let anchor = if iw > 0.0 && ih > 0.0 {
        (ix, iy, iw, ih)
    } else {
        (cursor.x - 20.0, cursor.y - 20.0, 40.0, 40.0)
    };
    let panel = (PANEL_LOGICAL.0 * scale, PANEL_LOGICAL.1 * scale);
    let wa = monitor.work_area();
    let work = (
        wa.position.x as f64,
        wa.position.y as f64,
        wa.size.width as f64,
        wa.size.height as f64,
    );
    let (x, y) = panel_origin(anchor, panel, work);
    let _ = win.set_size(PhysicalSize::new(panel.0, panel.1));
    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = win.show();
    let _ = win.set_focus();
}

/// A tray rect as `(x, y, w, h)` physical px, scaling logical variants by
/// the target monitor's factor.
fn rect_physical(rect: &tauri::Rect, scale: f64) -> (f64, f64, f64, f64) {
    let (x, y) = match &rect.position {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(l) => (l.x * scale, l.y * scale),
    };
    let (w, h) = match &rect.size {
        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
        tauri::Size::Logical(l) => (l.width * scale, l.height * scale),
    };
    (x, y, w, h)
}

/// Pure placement core (unit-tested): center the panel over the icon's
/// horizontal center, open AWAY from the work area's dominant side (trays
/// live at edges — a bottom taskbar means the panel opens ABOVE the icon),
/// then clamp inside the work area.
fn panel_origin(
    icon: (f64, f64, f64, f64),
    panel: (f64, f64),
    work: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (wx, wy, ww, wh) = work;
    let mut x = icon.0 + icon.2 / 2.0 - panel.0 / 2.0;
    x = x.clamp(
        wx + WORK_AREA_MARGIN,
        (wx + ww - panel.0 - WORK_AREA_MARGIN).max(wx + WORK_AREA_MARGIN),
    );
    let icon_center_y = icon.1 + icon.3 / 2.0;
    let open_above = icon_center_y > wy + wh / 2.0;
    let mut y = if open_above {
        icon.1 - panel.1 - WORK_AREA_MARGIN
    } else {
        icon.1 + icon.3 + WORK_AREA_MARGIN
    };
    y = y.clamp(
        wy + WORK_AREA_MARGIN,
        (wy + wh - panel.1 - WORK_AREA_MARGIN).max(wy + WORK_AREA_MARGIN),
    );
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1040.0);
    const PANEL: (f64, f64) = (320.0, 372.0);

    /// Bottom-right tray (the common case): the panel opens ABOVE the icon,
    /// right-aligned with it (clamped off the screen's right edge).
    #[test]
    fn bottom_tray_opens_above_and_clamps_right() {
        let icon = (1880.0, 1000.0, 40.0, 40.0); // bottom edge, taskbar tray
        let (x, y) = panel_origin(icon, PANEL, WORK);
        assert_eq!(y, 1000.0 - 372.0 - 8.0, "opens above the icon");
        assert_eq!(x, 1920.0 - 320.0 - 8.0, "clamped off the right edge");
    }

    /// Top tray (taskbar at the top): the panel opens BELOW the icon.
    #[test]
    fn top_tray_opens_below() {
        let icon = (100.0, 0.0, 40.0, 40.0);
        let (x, y) = panel_origin(icon, PANEL, WORK);
        assert_eq!(y, 40.0 + 8.0, "opens below the icon");
        assert!(x >= 8.0);
    }

    /// A left-side taskbar: the icon sits left-center, the panel opens to
    /// the right of center — i.e. BELOW by the dominant-side rule — and the
    /// horizontal clamp keeps it on screen.
    #[test]
    fn clamps_inside_small_work_area() {
        let work = (0.0, 0.0, 800.0, 600.0);
        let icon = (760.0, 560.0, 32.0, 32.0);
        let (x, y) = panel_origin(icon, PANEL, work);
        assert!(
            x >= 8.0 && x + PANEL.0 <= 800.0 - 8.0 + 0.5,
            "x inside: {x}"
        );
        assert!(
            y >= 8.0 && y + PANEL.1 <= 600.0 - 8.0 + 0.5,
            "y inside: {y}"
        );
    }
}
