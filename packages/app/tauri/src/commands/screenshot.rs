//! Main-window screenshot capture (for visual self-verification).
//!
//! Captures the WoWSP main window's client area via the Windows GDI API
//! (`GetDC` + `BitBlt` → top-down BGRA DIB → swizzle to RGBA → PNG), then
//! saves it to a file path and returns the absolute path.
//!
//! Two callers use this: the `capture_main_window` Tauri command (callable
//! from the webview) and the dev-only `test_harness` HTTP control server
//! (callable from external Python). The core `capture_window_png` and
//! `default_screenshot_path` helpers are `pub(crate)` so both reach them.

use std::path::PathBuf;

use tauri::Manager;

/// Capture the main window's client area and save as PNG to `<path>` (or a
/// temp file if `path` is empty). Returns the absolute path of the saved file.
#[tauri::command]
pub fn capture_main_window(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let out_path = if path.is_empty() {
        default_screenshot_path()?
    } else {
        PathBuf::from(path)
    };

    capture_window_png(&win, &out_path)?;
    Ok(out_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn capture_window_png(
    win: &tauri::WebviewWindow,
    out_path: &std::path::Path,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, SetForegroundWindow};

    let hwnd_raw = win.hwnd().map_err(|e| format!("get hwnd: {e}"))?;
    let hwnd = HWND(hwnd_raw.0 as *mut core::ffi::c_void);

    // Bring the window to the foreground so it's not occluded during capture.
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }

    // Read the client rect. If the window is mid-transition (e.g. restoring
    // from minimized, or a wallpaper/telemetry change just happened),
    // GetClientRect can briefly return a degenerate (tiny) rect. Retry up to
    // 5 times with a short sleep to let the window settle — this fixes the
    // intermittent "blank/partial screenshot" failures seen in visual tests.
    let mut rect = windows::Win32::Foundation::RECT::default();
    let mut width: i32 = 0;
    let mut height: i32 = 0;
    for attempt in 0..5 {
        unsafe {
            let _ = GetClientRect(hwnd, &mut rect);
        }
        width = (rect.right - rect.left).max(1);
        height = (rect.bottom - rect.top).max(1);
        // A real WoWSP window is at least ~600×400. Anything smaller means the
        // window isn't ready (minimized, transitioning, or occluded).
        if width >= 600 && height >= 400 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        if attempt == 0 {
            tracing::warn!(
                width,
                height,
                "client rect too small, retrying capture after window settles"
            );
        }
    }

    let mut pixels: Vec<u8>;

    unsafe {
        let hdc_window = GetDC(Some(hwnd));
        if hdc_window.is_invalid() {
            return Err("GetDC failed".into());
        }

        let hdc_mem = CreateCompatibleDC(Some(hdc_window));
        if hdc_mem.is_invalid() {
            let _ = ReleaseDC(Some(hwnd), hdc_window);
            return Err("CreateCompatibleDC failed".into());
        }

        let hbmp = CreateCompatibleBitmap(hdc_window, width, height);
        if hbmp.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(Some(hwnd), hdc_window);
            return Err("CreateCompatibleBitmap failed".into());
        }

        let old_bmp = SelectObject(hdc_mem, hbmp.into());

        // WebView2 renders via DirectComposition, so BitBlt from the window DC
        // captures only a blank surface. PrintWindow with PW_RENDERFULLCONTENT
        // (Windows 8.1+) forces the compositor to paint into our DC.
        let ok = windows::Win32::Storage::Xps::PrintWindow(
            hwnd,
            hdc_mem,
            windows::Win32::Storage::Xps::PRINT_WINDOW_FLAGS(
                windows::Win32::UI::WindowsAndMessaging::PW_RENDERFULLCONTENT,
            ),
        );
        if !ok.as_bool() {
            // Fallback: try BitBlt (works for non-composited windows).
            if BitBlt(
                hdc_mem,
                0,
                0,
                width,
                height,
                Some(hdc_window),
                0,
                0,
                SRCCOPY,
            )
            .is_err()
            {
                let _ = SelectObject(hdc_mem, old_bmp);
                let _ = DeleteObject(hbmp.into());
                let _ = DeleteDC(hdc_mem);
                let _ = ReleaseDC(Some(hwnd), hdc_window);
                return Err("PrintWindow + BitBlt both failed".into());
            }
        }

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

        pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        let got = GetDIBits(
            hdc_mem,
            hbmp,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bi,
            DIB_RGB_COLORS,
        );
        if got == 0 {
            let _ = SelectObject(hdc_mem, old_bmp);
            let _ = DeleteObject(hbmp.into());
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(Some(hwnd), hdc_window);
            return Err("GetDIBits returned 0".into());
        }

        let _ = SelectObject(hdc_mem, old_bmp);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(Some(hwnd), hdc_window);
    }

    // Swizzle BGRA → RGBA; force alpha opaque (BitBlt gives 0 in alpha).
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
        chunk[3] = 255;
    }

    let img = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
        .ok_or_else(|| "failed to create image buffer".to_string())?;
    img.save(out_path).map_err(|e| format!("save PNG: {e}"))?;

    tracing::info!(path = %out_path.display(), width, height, "screenshot saved");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn capture_window_png(
    _win: &tauri::WebviewWindow,
    _out_path: &std::path::Path,
) -> Result<(), String> {
    Err("screenshot capture is Windows-only".into())
}

pub(crate) fn default_screenshot_path() -> Result<PathBuf, String> {
    let dir = dirs_next::data_dir().ok_or_else(|| "cannot resolve data dir".to_string())?;
    let wowsp_dir = dir.join("WoWSP");
    std::fs::create_dir_all(&wowsp_dir).map_err(|e| format!("create {wowsp_dir:?}: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(wowsp_dir.join(format!("screenshot-{ts}.png")))
}
