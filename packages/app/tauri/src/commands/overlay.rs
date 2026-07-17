//! In-game overlay commands (milestones M6/M8).
//!
//! Overlay mode (Mode 2 in PLAN.md): a SEPARATE transparent, always-on-top,
//! click-through, decoration-less window is created on top of the game. It
//! loads the same index.html with `?window=overlay`, which makes main.ts mount
//! OverlayApp (no router, no title bar, transparent background). While the user
//! holds `Tab`, WoWSP captures the screen and renders a live roster overlay.
//!
//! The overlay window is created lazily by `create_overlay_window` (called once
//! when overlay mode starts) and shown/hidden by `set_overlay_visible` (called
//! on each Tab press/release). The main shell window keeps running underneath.
//!
//! Screen capture uses `GetDC(NULL)` + `BitBlt` of the primary monitor into a
//! BGRA buffer, PNG-encoded. Roster re-anchoring (detecting the team-list region
//! and repositioning the overlay) is a follow-up.

use base64::Engine;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use wowsp_tauri_shared::CaptureResult;

/// Label of the dedicated overlay window (distinct from "main").
const OVERLAY_LABEL: &str = "overlay";

/// Create the transparent overlay window if it doesn't exist yet. Idempotent —
/// a second call just returns without recreating. The window starts hidden;
/// show it with `set_overlay_visible(true)`.
#[tauri::command]
pub fn create_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(()); // already exists
    }
    let url = WebviewUrl::App("/?window=overlay".into());
    let win = WebviewWindowBuilder::new(&app, OVERLAY_LABEL, url)
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
    // Center it for now; M8 will reposition based on the detected team-list rect.
    let _ = win.center();
    Ok(())
}

/// Destroy the overlay window (when overlay mode ends).
#[tauri::command]
pub fn destroy_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.close().map_err(|e| format!("close overlay: {e}"))?;
    }
    Ok(())
}

/// Show or hide the overlay window. Requires `create_overlay_window` to have
/// been called first.
#[tauri::command]
pub fn set_overlay_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return Err("overlay window not created — call create_overlay_window first".into());
    };
    if visible {
        win.show().map_err(|e| format!("show overlay: {e}"))?;
        let _ = win.set_focus();
    } else {
        win.hide().map_err(|e| format!("hide overlay: {e}"))?;
    }
    Ok(())
}

/// Capture the primary monitor and return it as base64 PNG, plus the estimated
/// roster rectangle. The roster is centered on screen (where WoWS places the
/// scoreboard on Tab); 50% width × 80% height is a conservative default.
#[tauri::command]
pub fn capture_game_window() -> Result<CaptureResult, String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    let w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let h = unsafe { GetSystemMetrics(SM_CYSCREEN) };

    let png = capture_screen_png()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(CaptureResult {
        image_base64: b64,
        roster_rect: Some(wowsp_tauri_shared::Rect {
            x: w / 4,
            y: (h as f32 * 0.1) as i32,
            width: w / 2,
            height: (h as f32 * 0.8) as i32,
        }),
    })
}

#[cfg(target_os = "windows")]
fn capture_screen_png() -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, RGBQUAD, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err("GetDC(NULL) returned invalid HDC".into());
    }

    let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };

    let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if mem_dc.is_invalid() {
        unsafe { let _ = ReleaseDC(None, screen_dc); }
        return Err("CreateCompatibleDC failed".into());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
    if bitmap.is_invalid() {
        unsafe {
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("CreateCompatibleBitmap failed".into());
    }

    let bitmap_gdi = bitmap.into();
    let old_bitmap = unsafe { SelectObject(mem_dc, bitmap_gdi) };
    if old_bitmap.is_invalid() {
        unsafe {
            let _ = DeleteObject(bitmap_gdi);
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("SelectObject failed".into());
    }

    if unsafe { BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), 0, 0, SRCCOPY) }.is_err() {
        unsafe {
            let _ = SelectObject(mem_dc, old_bitmap);
            let _ = DeleteObject(bitmap_gdi);
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("BitBlt failed".into());
    }

    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
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

    let mut pixels: Vec<u8> = vec![0u8; (width as usize) * (height as usize) * 4];
    let got = unsafe {
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bi,
            DIB_RGB_COLORS,
        )
    };
    if got == 0 {
        unsafe {
            let _ = SelectObject(mem_dc, old_bitmap);
            let _ = DeleteObject(bitmap_gdi);
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);
        }
        return Err("GetDIBits failed".into());
    }

    unsafe {
        let _ = SelectObject(mem_dc, old_bitmap);
        let _ = DeleteObject(bitmap_gdi);
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
    }

    // Swizzle BGRA → RGBA; force alpha opaque (BitBlt gives 0 in alpha).
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
        chunk[3] = 255;
    }

    let img = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
        .ok_or_else(|| "failed to create image buffer".to_string())?;
    let mut png_buf = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_buf),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("PNG encode: {e}"))?;

    Ok(png_buf)
}

#[cfg(not(target_os = "windows"))]
fn capture_screen_png() -> Result<Vec<u8>, String> {
    Err("screen capture is Windows-only".into())
}
