use super::*;
// ─────────────────────────────────────────────────────────────────────────
// Win32: game window discovery + screen capture
// ─────────────────────────────────────────────────────────────────────────

/// The game's top-level window: handle + on-screen bounds (physical px,
/// already clamped to the window's monitor so the capture and the overlay
/// cover exactly the same region — multi-monitor / negative-origin safe) +
/// the client kind behind it (resolved from the process image; drives the
/// per-client detection profile in `overlay_detect`).
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
pub(super) struct GameWindow {
    pub(super) hwnd: windows::Win32::Foundation::HWND,
    pub(super) rect: windows::Win32::Foundation::RECT,
    pub(super) kind: wowsp_tauri_shared::GameInstallKind,
}

#[cfg(target_os = "windows")]
impl GameWindow {
    pub(super) fn is_alive(&self) -> bool {
        !self.hwnd.0.is_null()
            && unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(self.hwnd)) }
                .as_bool()
    }

    pub(super) fn is_foreground(&self) -> bool {
        (unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }) == self.hwnd
    }
}

/// `RECT` → shared `Rect` (physical px).
#[cfg(target_os = "windows")]
pub(super) fn rect_from_win32(r: windows::Win32::Foundation::RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// The window's monitor DPI scale (1.0 = 96 DPI). The chip layer sizes its
/// fonts in CSS px while every anchor rect is physical, so the overlay's
/// side-pad reserve converts through this (see
/// `overlay_detect::overlay_padding_x`). A failed query (a window already
/// gone) falls back to 1.0 — the unscaled behavior the pads carried before
/// the reserve went DPI-aware.
#[cfg(target_os = "windows")]
pub(super) fn window_dpi_scale(hwnd: windows::Win32::Foundation::HWND) -> f32 {
    let dpi = unsafe { windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 }
}

/// Collect the game's main window: PID via the ToolHelp snapshot (reusing
/// `appdata::find_game_pid`), then the largest visible top-level window of
/// that process. Title-agnostic — Lesta/CN clients localize their titles.
#[cfg(target_os = "windows")]
pub(super) fn find_game_window() -> Option<GameWindow> {
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
    // Client kind for the detection profile: same inference the process
    // watcher uses (exe name/path markers), defaulting to the WG client —
    // the WG profile is also the unknown-client fallback downstream.
    let kind = super::appdata::query_process_image_path(pid)
        .as_deref()
        .and_then(super::appdata::infer_install_from_exe)
        .map(|install| install.kind)
        .unwrap_or(wowsp_tauri_shared::GameInstallKind::Wargaming);
    Some(GameWindow { hwnd, rect, kind })
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

/// Capture with the manual-locate cache refreshed. The picker's reference
/// frame must be THE INSTANT TAB WAS LAST HELD — the roster moment the
/// player actually saw — so the automatic path remembers a capture only
/// while the key is still down, the hold has passed [`TAB_STORE_MIN_HOLD`],
/// AND the frame itself PROVES it shows the team header
/// (detection passes, revalidations, sink probes; the debug capture
/// command included). The hold gate is the cheap pre-filter that skips the
/// first instants of a press, while the table is still fading in; the
/// header check is what makes the rule content-verified rather than merely
/// timing-gated — a stalled watcher tick can hide a release and re-press
/// inside one sample gap, leaving the tracker reporting a minutes-old
/// hold, and only the pixels can overrule that. The same
/// [`overlay_detect::header_bars_present`] check guards the picker's
/// fresh-capture fallback, so every frame this cache accepts is a frame
/// the manual-locate flow itself would trust. `compute_anchor` additionally
/// stores any capture the detector PROVED carries the table, bypassing
/// both gate and check — so the cache converges on a table-bearing frame
/// within one detection even on a short hold. A capture in flight when the
/// key came up is used by the caller but NOT stored, and the cache
/// therefore stays frozen on the last Tab-held frame until the next hold —
/// see `commands/overlay_manual.rs`.
#[cfg(target_os = "windows")]
pub(super) fn capture_game_rgba_cached(
    rect: &windows::Win32::Foundation::RECT,
) -> Option<(Vec<u8>, u32, u32)> {
    let out = capture_game_rgba(rect)?;
    if tab_key_down()
        && tab_held_for().is_some_and(|held| held >= TAB_STORE_MIN_HOLD)
        && overlay_detect::header_bars_present(&out.0, out.1, out.2)
    {
        super::overlay_manual::store_capture(&out.0, out.1, out.2, rect_from_win32(*rect));
    }
    Some(out)
}

/// GDI capture of a screen rect from the virtual-screen DC. Works for
/// borderless / windowed-fullscreen games on any monitor (negative origins
/// included); an exclusive-fullscreen swapchain may BitBlt black — the
/// detector then fails and the caller falls back.
#[cfg(target_os = "windows")]
pub(super) fn capture_game_rgba(
    rect: &windows::Win32::Foundation::RECT,
) -> Option<(Vec<u8>, u32, u32)> {
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
