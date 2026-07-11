//! In-game overlay commands (milestones M6/M8).
//!
//! Overlay mode (Mode 2 in PLAN.md): a SEPARATE transparent, always-on-top,
//! click-through, decoration-less window is created on top of the game. It
//! loads the same index.html with `?window=overlay`, which makes main.ts mount
//! OverlayApp (no router, no title bar, transparent background). While the user
//! holds `Tab`, WoWSP captures the screen + re-anchors the roster.
//!
//! The overlay window is created lazily by `create_overlay_window` (called once
//! when overlay mode starts) and shown/hidden by `set_overlay_visible` (called
//! on each Tab press/release). The main shell window keeps running underneath.

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
