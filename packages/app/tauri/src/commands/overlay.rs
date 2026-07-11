//! In-game overlay commands (milestones M6/M8).
//!
//! Overlay mode (Mode 2 in PLAN.md): a transparent always-on-top window sits
//! over the game. While the user holds `Tab`, WoWSP captures the screen, runs a
//! lightweight detector to find the central team-list region, and re-anchors
//! the rendered roster to sit on top of it. Release `Tab` and the overlay hides.
//!
//! Status:
//!   - `set_overlay_visible` toggles the main window's visibility via the Tauri
//!     webview API. M6 will split this into a SEPARATE transparent click-through
//!     overlay window so the main shell can keep running underneath.
//!   - `capture_game_window` returns a placeholder PNG. The real Win32 BitBlt
//!     capture + team-list detector are TODO(M8): they need a live game frame
//!     to calibrate the template match against, so they land when the overlay
//!     mode is exercised against a running game. The Win32 GDI capture path is
//!     sketched in `capture_primary_screen` behind a TODO so the API surface is
//!     ready.

use base64::Engine;
use wowsp_tauri_shared::CaptureResult;

/// Capture the game window and return it as base64 PNG, plus (TODO) the
/// detected roster rectangle in screen coordinates.
///
/// TODO(M8): the real capture is `GetDC(NULL)` + `BitBlt` of the primary screen
/// into a top-down BGRA DIB, swizzled to RGBA, PNG-encoded via `image`. The
/// team-list detector then runs on that image to populate `roster_rect`. Both
/// need a live game frame to calibrate, so the placeholder keeps the frontend
/// plumbing working end-to-end until then.
#[tauri::command]
pub fn capture_game_window() -> Result<CaptureResult, String> {
    let png = tiny_png();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(CaptureResult {
        image_base64: b64,
        roster_rect: None,
    })
}

/// Show or hide the overlay. Toggles the main window's visibility; M6 will
/// create a separate transparent click-through overlay window and toggle that
/// here so the main shell can stay running underneath.
#[tauri::command]
pub fn set_overlay_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else {
        return Err("main window not found".into());
    };
    if visible {
        win.show().map_err(|e| format!("show: {e}"))?;
    } else {
        win.hide().map_err(|e| format!("hide: {e}"))?;
    }
    Ok(())
}

/// A minimal valid 1×1 transparent PNG placeholder (until the real BitBlt
/// capture lands).
fn tiny_png() -> Vec<u8> {
    static PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, // IHDR
        0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, // IDAT
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
    ];
    PNG.to_vec()
}
