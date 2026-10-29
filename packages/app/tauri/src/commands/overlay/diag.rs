//! Overlay presentation self-diagnostics (feedback 2026-10-23, Optimum11):
//! a transparent layered window whose content never reaches the screen is
//! INDISTINGUISHABLE from "nothing happened" for the player, while every
//! app-side signal (window shown, events emitted, page painted) stays
//! green. This module closes that loop with three cooperating pieces:
//!
//! 1. PAINT REPORTS: the overlay page reports what it last rendered
//!    (hint card / waiting card / chips) through the
//!    [`report_overlay_paint`] command — the page's own ground truth,
//!    carried ADVISORILY on every diag broadcast (the verdict itself never
//!    depends on it — the marker below is the independent channel).
//! 2. PRESENTATION VERIFY: on a cadenced subset of shows the watcher emits
//!    [`OVERLAY_VERIFY_EVENT`], the page paints a solid magenta corner
//!    marker, and the watcher photographs the overlay window's corner box
//!    (its LIVE rect, read at capture time) with a LAYERED-INCLUSIVE
//!    capture (`CAPTUREBLT`). Marker found = the window's pixels really
//!    reach the screen; marker repeatedly missing = the composition path
//!    is broken on this system ([`VerifyMachine`] turns 3 consecutive
//!    misses into a Failed verdict, broadcast through
//!    [`OVERLAY_DIAG_EVENT`] and mirrored into a pull mailbox
//!    ([`LAST_DIAG`]) for late-mounting consumers — the events are
//!    transition-only).
//! 3. RISK FLAGS: registry/DWM state probes (MPO disabled, system
//!    transparency off, HAGS off, DWM-cloaked, WebView2 runtime version)
//!    read at EMIT time and attached to a confirmed verdict — advisory
//!    context for the fix checklist, never standalone alarms (a disabled
//!    MPO alone does not mean anything is broken on a given machine).
//!
//! Honest limits, by design: a `CAPTUREBLT` capture rides DWM's capture
//! path, so a failure specific to the PRESENT path (a hardware overlay
//! plane stacking above the DWM composition) can false-pass here. The
//! marker verdict is therefore "composited", not "photons on the panel"
//! — good enough to catch the broken-driver/broken-runtime/cloaked
//! classes and to exonerate the app; the residue still needs the user's
//! machine.
use super::*;
use wowsp_tauri_shared::CommandResult;

/// The marker's exact paint color (opaque #FF00FF magenta — a color no
/// game HUD uses in a corner padding box; the page paints the same triple,
/// see `.overlay-verify-marker` in overlay.scss). Kept in lockstep with
/// the frontend constant.
pub(crate) const MARKER_RGB: (u8, u8, u8) = (255, 0, 255);
/// Per-channel tolerance for the marker match (opaque GDI pixels come back
/// exact; the slack only absorbs scaling edge blends).
const MARKER_TOLERANCE: i32 = 16;
/// Marker-colored pixels required inside the corner box for a hit (a
/// 10 CSS-px square is ≥100 physical pixels even at 1× DPI).
const MARKER_MIN_PIXELS: usize = 6;
/// Physical size of the top-left corner box scanned for the marker (the
/// page pins the marker at CSS 2px/2px — every DPI scale keeps it inside).
const MARKER_SCAN_BOX: i32 = 48;

/// While [`VerifyMachine`] is certified, re-verify only every Nth show —
/// a cheap standing check that survives the whole certification stance.
const CERTIFIED_RECHECK_SHOWS: u32 = 10;
/// While the verdict is Failed, keep watching for recovery every Nth show
/// (a system tweak reverted mid-session heals without an app restart),
/// without re-scoring a miss every single press.
const FAILED_RETRY_SHOWS: u32 = 5;
/// Consecutive marker misses that turn the verdict Failed.
const VERIFY_FAILS_TO_FLAG: u32 = 3;

// ─────────────────────────────────────────────────────────────────────────
// Paint reports (the page's own ground truth)
// ─────────────────────────────────────────────────────────────────────────

/// One stored paint report (the last cell wins — the page overwrites it
/// after every visible render).
struct PaintReport {
    kind: OverlayPaintKind,
    rows: Option<u32>,
}

/// The page's last paint report (`None` before the first one). Written by
/// the `report_overlay_paint` command (any thread), read by the watcher
/// loop at diag-emit time — a single-cell mailbox, last write wins.
static PAINT_REPORT: Mutex<Option<PaintReport>> = Mutex::new(None);

/// Mirror of the last BROADCAST diag payload (a full snapshot — the risk
/// flags were read at emit time). The `overlay-diag` events are
/// transition-only, so a consumer mounting AFTER a verdict (the red pill's
/// own deep link into the settings section is exactly that) would never
/// see a standing Failed state; `get_overlay_diag` reads this mailbox.
static LAST_DIAG: Mutex<Option<OverlayDiag>> = Mutex::new(None);

/// Record one paint report from the overlay page (see the page's
/// `reportPaint` — called after every VISIBLE render).
///
/// The report is LOGGED on every CHANGE: the 2026-10-29 feedback had the app's
/// signals all green (shows posted, verify marker found, verdict Certified)
/// while the page painted an EMPTY body for a whole battle, and the only
/// place that fact existed was this mailbox — never a log line. A
/// `paint=chips rows=None` entry directly after an arena-info event is that
/// exact failure's fingerprint.
fn note_paint(kind: OverlayPaintKind, rows: Option<u32>) {
    let Ok(mut slot) = PAINT_REPORT.lock() else {
        return;
    };
    let changed = slot
        .as_ref()
        .is_none_or(|report| report.kind != kind || report.rows != rows);
    *slot = Some(PaintReport { kind, rows });
    drop(slot);
    if changed {
        tracing::info!(paint = ?kind, rows, "overlay page paint report changed");
    }
}

/// Snapshot the latest paint report (best effort — a wedged lock reads as
/// "no report" and never blocks the watcher).
fn last_paint() -> Option<(OverlayPaintKind, Option<u32>)> {
    PAINT_REPORT
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|r| (r.kind, r.rows)))
}

/// The overlay page's paint report command. Called from the bare-DOM
/// overlay page after every render while visible; ungated (no main-window
/// label check — only that page knows what it painted).
#[tauri::command]
pub async fn report_overlay_paint(kind: OverlayPaintKind, rows: Option<u32>) -> CommandResult<()> {
    note_paint(kind, rows);
    Ok(())
}

/// The overlay page's uncaught-error channel. An exception thrown inside the
/// page's `render()` leaves an EMPTY body — the window, the marker channel and
/// every Rust-side signal stay green, and the player sees a blank overlay
/// (exactly the 2026-10-29 shape). The page reports the message here so the
/// field log carries the reason instead of only the symptom.
///
/// Rate-limited and sanitized on purpose: an exception inside a render LOOP
/// could otherwise write a line per frame (and roster-controlled text could
/// smuggle newlines into the log), so one line per
/// [`PAGE_ERROR_MIN_INTERVAL`] survives, truncated to
/// [`PAGE_ERROR_MAX_CHARS`] with control characters stripped.
#[tauri::command]
pub async fn report_overlay_page_error(message: String) -> CommandResult<()> {
    note_page_error(&message);
    Ok(())
}

/// At most one page-error line per this window (dropped ones are silent: the
/// first line already names the failure).
const PAGE_ERROR_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
/// Longest page-error message kept (the rest is truncation marker).
const PAGE_ERROR_MAX_CHARS: usize = 400;

/// Record one page error into the log (see `report_overlay_page_error`).
fn note_page_error(message: &str) {
    static LAST_PAGE_ERROR: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let Ok(mut slot) = LAST_PAGE_ERROR.lock() else {
        return;
    };
    let now = std::time::Instant::now();
    if slot.is_some_and(|at| now.duration_since(at) < PAGE_ERROR_MIN_INTERVAL) {
        return;
    }
    *slot = Some(now);
    drop(slot);
    let mut sanitized: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(PAGE_ERROR_MAX_CHARS)
        .collect();
    if message.chars().count() > PAGE_ERROR_MAX_CHARS {
        sanitized.push('…');
    }
    tracing::warn!(error = %sanitized, "overlay page reported an uncaught error");
}

/// Pull the last broadcast diag payload (`None` before any verdict). The
/// consumer-side catch-up for a transition-only event stream: a window
/// mounting after a Failed verdict reads the standing state instead of
/// waiting for a transition that may never re-fire.
#[tauri::command]
pub async fn get_overlay_diag() -> CommandResult<Option<OverlayDiag>> {
    Ok(LAST_DIAG.lock().map(|slot| slot.clone()).ok().flatten())
}

// ─────────────────────────────────────────────────────────────────────────
// Verify machine (pure — unit-tested)
// ─────────────────────────────────────────────────────────────────────────

/// Presentation-verify state machine: which shows owe a check, and how
/// consecutive marker verdicts map onto the broadcast
/// [`OverlayPresentation`]. Lives inside [`WatchFsm`] (the watcher loop's
/// single-owner state), reset to default when the screen configuration
/// changes. Pure logic — no Win32, unit-tested.
#[derive(Debug, Default)]
pub(crate) struct VerifyMachine {
    /// Current broadcast verdict (default [`OverlayPresentation::Unverified`]).
    pub(crate) state: OverlayPresentation,
    /// Consecutive marker misses (any hit resets to 0; saturates).
    fails: u32,
    /// Shows counted since the last verify ARM (the cadence divider for
    /// certified/failed states; unverified verifies every show).
    shows: u32,
}

impl VerifyMachine {
    /// Whether THIS show owes a verify: every show while unverified, then
    /// every [`CERTIFIED_RECHECK_SHOWS`]th while certified and every
    /// [`FAILED_RETRY_SHOWS`]th while failed.
    pub(crate) fn on_show(&mut self) -> bool {
        let interval = match self.state {
            OverlayPresentation::Unverified => 1,
            OverlayPresentation::Certified => CERTIFIED_RECHECK_SHOWS,
            OverlayPresentation::Failed => FAILED_RETRY_SHOWS,
        };
        self.shows = self.shows.saturating_add(1);
        if self.shows >= interval {
            self.shows = 0;
            true
        } else {
            false
        }
    }

    /// Apply one marker verdict; `Some(new_state)` when the verdict
    /// TRANSITIONED (the caller's cue to broadcast), `None` otherwise. A
    /// lone miss never demotes Certified (one lost marker is noise — a
    /// capture raced a hide, a frame not yet presented); only
    /// [`VERIFY_FAILS_TO_FLAG`] consecutive misses do.
    pub(crate) fn on_verdict(&mut self, marker_found: bool) -> Option<OverlayPresentation> {
        self.fails = if marker_found {
            0
        } else {
            self.fails.saturating_add(1).min(VERIFY_FAILS_TO_FLAG)
        };
        let next = if self.fails == 0 {
            OverlayPresentation::Certified
        } else if self.fails >= VERIFY_FAILS_TO_FLAG {
            OverlayPresentation::Failed
        } else {
            self.state
        };
        if next != self.state {
            self.state = next;
            Some(next)
        } else {
            None
        }
    }
}

/// Whether the top-left `MARKER_SCAN_BOX` box of an RGBA frame contains
/// the verify marker (≥ [`MARKER_MIN_PIXELS`] pixels within
/// [`MARKER_TOLERANCE`] per channel of [`MARKER_RGB`]). Pure —
/// unit-tested; the buffer is the capture's top-down RGBA.
pub(crate) fn marker_scan(rgba: &[u8], w: usize, h: usize) -> bool {
    let cols = w.min(MARKER_SCAN_BOX as usize);
    let rows = h.min(MARKER_SCAN_BOX as usize);
    let (mr, mg, mb) = (
        MARKER_RGB.0 as i32,
        MARKER_RGB.1 as i32,
        MARKER_RGB.2 as i32,
    );
    let t = MARKER_TOLERANCE;
    let mut hits = 0;
    for y in 0..rows {
        let row = y * w;
        for x in 0..cols {
            let px = (row + x) * 4;
            if rgba.len() < px + 3 {
                return false;
            }
            let (r, g, b) = (rgba[px] as i32, rgba[px + 1] as i32, rgba[px + 2] as i32);
            if (r - mr).abs() <= t && (g - mg).abs() <= t && (b - mb).abs() <= t {
                hits += 1;
                if hits >= MARKER_MIN_PIXELS {
                    return true;
                }
            }
        }
    }
    false
}

// ─────────────────────────────────────────────────────────────────────────
// The verify pass (Win32)
// ─────────────────────────────────────────────────────────────────────────

/// Arm the presentation verify for a JUST-POSTED show: emit the marker
/// event and schedule the capture ([`VERIFY_SETTLE`] later — the page
/// paints the marker synchronously in its event loop; the slack covers
/// event delivery plus one present). At most ONE arm per Tab hold (the
/// due-slot guard) and only when [`VerifyMachine::on_show`] says this
/// show owes a check; a failed emit leaves nothing armed so the next show
/// retries cleanly. No rect is snapshotted here on purpose: the window
/// may re-place (fallback hint → detected table) inside the settle
/// window, so the capture reads the LIVE window rect instead.
#[cfg(target_os = "windows")]
pub(super) fn maybe_arm_verify(app: &AppHandle, fsm: &mut WatchFsm) {
    if fsm.verify_due.is_some() || !fsm.verify.on_show() {
        return;
    }
    if let Err(e) = app.emit(OVERLAY_VERIFY_EVENT, true) {
        tracing::warn!(error = %e, "emit overlay-verify failed");
        return;
    }
    fsm.verify_due = Some(Instant::now() + VERIFY_SETTLE);
}

/// Run the armed verify capture (called from the tick when due, only while
/// the overlay is still logically shown AND Tab still down — a quick
/// release races the page's marker teardown and must not score a miss).
/// The window's LIVE rect is read here (not a snapshot from arm time): the
/// acquisition path can re-place the window between the arm and the due
/// capture, and a stale corner would score a miss against a healthy
/// machine. `None` = the window is gone or the capture itself failed
/// (inconclusive — never scored).
#[cfg(target_os = "windows")]
pub(super) fn verify_marker_on_screen(app: &AppHandle) -> Option<bool> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let win = app.get_webview_window(OVERLAY_LABEL)?;
    let hwnd = win.hwnd().ok()?;
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { GetWindowRect(windows::Win32::Foundation::HWND(hwnd.0), &mut rect).ok()? };
    let corner = windows::Win32::Foundation::RECT {
        left: rect.left,
        top: rect.top,
        right: rect.left + MARKER_SCAN_BOX,
        bottom: rect.top + MARKER_SCAN_BOX,
    };
    let (rgba, w, h) = capture_screen_rect(&corner, true)?;
    Some(marker_scan(&rgba, w as usize, h as usize))
}

/// Apply a verify verdict inside the tick: transition → broadcast through
/// [`OVERLAY_DIAG_EVENT`] (edge events only — `fsm.last_diag` mirrors the
/// last broadcast verdict).
#[cfg(target_os = "windows")]
pub(super) fn apply_verify_verdict(app: &AppHandle, fsm: &mut WatchFsm, marker_found: bool) {
    if let Some(next) = fsm.verify.on_verdict(marker_found) {
        emit_diag(app, fsm, next);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics broadcast + environment probes
// ─────────────────────────────────────────────────────────────────────────

/// Broadcast one presentation verdict (deduped against `fsm.last_diag`)
/// with the risk flags read at emit time.
#[cfg(target_os = "windows")]
pub(super) fn emit_diag(app: &AppHandle, fsm: &mut WatchFsm, next: OverlayPresentation) {
    if fsm.last_diag == Some(next) {
        return;
    }
    fsm.last_diag = Some(next);
    let diag = collect_diag(app, next);
    if let Ok(mut slot) = LAST_DIAG.lock() {
        *slot = Some(diag.clone());
    }
    if let Err(e) = app.emit(OVERLAY_DIAG_EVENT, diag) {
        tracing::warn!(error = %e, "emit overlay-diag failed");
    }
    tracing::info!(presentation = ?next, "overlay presentation verdict changed");
}

/// Build the diag payload: the page's last paint report + the environment
/// risk probes (registry + DWM — cheap enough to read exactly once per
/// verdict change).
#[cfg(target_os = "windows")]
fn collect_diag(app: &AppHandle, presentation: OverlayPresentation) -> OverlayDiag {
    let (mpo, transparency, hags) = risk_probe_values();
    let (mpo_disabled, transparency_effects_off, hags_off) = risk_flags(mpo, transparency, hags);
    let (paint, paint_rows) = last_paint().map_or((None, None), |(k, r)| (Some(k), r));
    // Detection-layer reason (overlay review H-2): the last refusal the
    // detect gates recorded, `None` while detection keeps succeeding.
    let (detect_failure, detect_failure_age_sec) =
        crate::commands::overlay_detect::detect_failure_snapshot()
            .map_or((None, None), |(label, age)| (Some(label), Some(age)));
    OverlayDiag {
        presentation,
        paint,
        paint_rows,
        webview2_version: webview2_runtime_version(),
        mpo_disabled,
        transparency_effects_off,
        hags_off,
        cloaked: overlay_cloaked(app),
        detect_failure,
        detect_failure_age_sec,
    }
}

/// Pure mapping of the raw registry probe values onto the risk flags —
/// `None` (value absent) keeps its flag FALSE: an absent tweak is the OS
/// default, not a risk signal. Pure — unit-tested.
pub(crate) fn risk_flags(
    mpo: Option<u32>,
    transparency: Option<u32>,
    hags: Option<u32>,
) -> (bool, bool, bool) {
    // OverlayTestMode = 5 is the documented "MPO disabled" tweak value.
    let mpo_disabled = mpo == Some(5);
    // EnableTransparency: 0 = transparency effects off.
    let transparency_off = transparency == Some(0);
    // HwSchMode: 1 = HAGS disabled (2 = enabled; absent = driver default).
    let hags_off = hags == Some(1);
    (mpo_disabled, transparency_off, hags_off)
}

/// Read the three risk probes' raw registry values (best effort).
#[cfg(target_os = "windows")]
fn risk_probe_values() -> (Option<u32>, Option<u32>, Option<u32>) {
    use winreg::RegKey;
    (
        reg_u32(
            &RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE),
            r"SOFTWARE\Microsoft\Windows\Dwm",
            "OverlayTestMode",
        ),
        reg_u32(
            &RegKey::predef(winreg::enums::HKEY_CURRENT_USER),
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "EnableTransparency",
        ),
        reg_u32(
            &RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE),
            r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers",
            "HwSchMode",
        ),
    )
}

/// One DWORD registry read (absent key/value/unauthorized all read as
/// `None` — probes never propagate errors).
#[cfg(target_os = "windows")]
fn reg_u32(root: &winreg::RegKey, path: &str, name: &str) -> Option<u32> {
    root.open_subkey(path).ok()?.get_value::<u32, _>(name).ok()
}

/// The Evergreen WebView2 runtime's version string (`pv` under the
/// EdgeUpdate client key; both the WOW6432Node mirror and the native view,
/// HKCU before HKLM — the per-user install is the common one). `None`
/// when no runtime registers anywhere. The app ships no runtime of its
/// own (`webviewInstallMode: skip`), so a stripped OS image is a real
/// risk exactly for the transparent-window mode.
#[cfg(target_os = "windows")]
fn webview2_runtime_version() -> Option<String> {
    use winreg::RegKey;
    const CLIENT: &str = concat!(
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    );
    const CLIENT_NATIVE: &str = concat!(
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients",
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    );
    for root in [
        winreg::enums::HKEY_CURRENT_USER,
        winreg::enums::HKEY_LOCAL_MACHINE,
    ] {
        let predefined = RegKey::predef(root);
        for path in [CLIENT, CLIENT_NATIVE] {
            if let Ok(key) = predefined.open_subkey(path)
                && let Ok(v) = key.get_value::<String, _>("pv")
                && !v.trim().is_empty()
            {
                return Some(v);
            }
        }
    }
    None
}

/// Whether the overlay window currently reports as DWM-cloaked (a
/// compositor-side "this window is not being displayed" signal — the one
/// explicit OS-level presentation verdict available).
#[cfg(target_os = "windows")]
fn overlay_cloaked(app: &AppHandle) -> bool {
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return false;
    };
    let Ok(hwnd) = win.hwnd() else {
        return false;
    };
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(
            windows::Win32::Foundation::HWND(hwnd.0),
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests (pure logic only — no Win32, no AppHandle)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: usize, h: usize, paint: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
        let mut buf = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                buf.extend_from_slice(&paint(x, y));
            }
        }
        buf
    }

    #[test]
    fn marker_scan_finds_a_corner_blob() {
        // A 10x10 marker at the corner of a 48x48 capture frame.
        let buf = frame(48, 48, |x, y| {
            if x < 10 && y < 10 {
                [255, 0, 255, 255]
            } else {
                [20, 30, 40, 255]
            }
        });
        assert!(marker_scan(&buf, 48, 48));
    }

    #[test]
    fn marker_scan_rejects_a_marker_free_frame() {
        // Game-UI-ish dim teal — far outside the magenta tolerance on
        // every channel (a near-miss color inside the tolerance would be
        // a true marker to the scan, by definition).
        let buf = frame(48, 48, |_, _| [40, 90, 110, 255]);
        assert!(!marker_scan(&buf, 48, 48));
    }

    #[test]
    fn marker_scan_tolerates_scaled_edge_blends() {
        // Half the marker's pixels sit exactly on the color, the rest one
        // step inside the tolerance — a scaled marker's edge ring.
        let buf = frame(48, 48, |x, y| {
            if x < 8 && y < 8 {
                if x < 4 {
                    [255, 0, 255, 255]
                } else {
                    [243, 12, 240, 255]
                }
            } else {
                [0, 0, 0, 255]
            }
        });
        assert!(marker_scan(&buf, 48, 48));
    }

    #[test]
    fn marker_scan_ignores_a_marker_outside_the_corner_box() {
        let buf = frame(64, 48, |x, y| {
            if x >= 56 && y < 8 {
                [255, 0, 255, 255]
            } else {
                [10, 10, 10, 255]
            }
        });
        assert!(!marker_scan(&buf, 64, 48));
    }

    #[test]
    fn verify_machine_certifies_on_first_hit_and_minds_cadence() {
        let mut m = VerifyMachine::default();
        // Unverified: every show owes a check.
        assert!(m.on_show());
        assert_eq!(m.on_verdict(true), Some(OverlayPresentation::Certified));
        // Certified: the next CERTIFIED_RECHECK_SHOWS-1 shows do not.
        for _ in 0..CERTIFIED_RECHECK_SHOWS - 1 {
            assert!(!m.on_show());
        }
        assert!(m.on_show());
    }

    #[test]
    fn verify_machine_flags_only_after_consecutive_misses() {
        let mut m = VerifyMachine::default();
        assert!(m.on_show());
        // One miss from Unverified: no verdict change, nothing broadcast.
        assert_eq!(m.on_verdict(false), None);
        assert_eq!(m.state, OverlayPresentation::Unverified);
        assert_eq!(m.on_verdict(false), None);
        // Third consecutive miss → Failed, broadcast.
        assert_eq!(m.on_verdict(false), Some(OverlayPresentation::Failed));
        // Failed: retries watch for recovery on the FAILED_RETRY_SHOWS cadence.
        for _ in 0..FAILED_RETRY_SHOWS - 1 {
            assert!(!m.on_show());
        }
        assert!(m.on_show());
        assert_eq!(m.on_verdict(true), Some(OverlayPresentation::Certified));
    }

    #[test]
    fn verify_machine_never_demotes_certified_on_a_lone_miss() {
        let mut m = VerifyMachine::default();
        assert!(m.on_show());
        assert_eq!(m.on_verdict(true), Some(OverlayPresentation::Certified));
        // A lone miss (capture raced a hide): stays certified, no broadcast.
        assert_eq!(m.on_verdict(false), None);
        assert_eq!(m.state, OverlayPresentation::Certified);
        // The miss is still COUNTED: two more consecutive misses flag it.
        assert_eq!(m.on_verdict(false), None);
        assert_eq!(m.on_verdict(false), Some(OverlayPresentation::Failed));
    }

    #[test]
    fn verify_machine_interleaved_misses_never_flag() {
        let mut m = VerifyMachine::default();
        for _ in 0..VERIFY_FAILS_TO_FLAG * 3 {
            m.on_verdict(false);
            assert_ne!(m.state, OverlayPresentation::Failed);
            // Any hit resets the miss streak to zero.
            m.on_verdict(true);
        }
    }

    #[test]
    fn risk_flags_map_the_documented_tweak_values() {
        // Absent values (OS defaults) read as no risk.
        assert_eq!(risk_flags(None, None, None), (false, false, false));
        // OverlayTestMode = 5 disables MPO; other values do not.
        assert!(risk_flags(Some(5), None, None).0);
        assert!(!risk_flags(Some(0), None, None).0);
        // EnableTransparency = 0 turns effects off.
        assert!(risk_flags(None, Some(0), None).1);
        assert!(!risk_flags(None, Some(1), None).1);
        // HwSchMode = 1 disables HAGS (2 = enabled).
        assert!(risk_flags(None, None, Some(1)).2);
        assert!(!risk_flags(None, None, Some(2)).2);
    }

    #[test]
    fn paint_report_mailbox_keeps_the_latest() {
        note_paint(OverlayPaintKind::Hint, None);
        note_paint(OverlayPaintKind::Chips, Some(17));
        assert_eq!(last_paint(), Some((OverlayPaintKind::Chips, Some(17))));
        // Best-effort read never panics on a wedged lock (same-cell rewrite).
        note_paint(OverlayPaintKind::WaitingRoster, None);
        assert_eq!(last_paint(), Some((OverlayPaintKind::WaitingRoster, None)));
    }
}
