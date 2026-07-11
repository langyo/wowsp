//! In-game overlay commands.
//!
//! Overlay mode (Mode 2 in PLAN.md): a transparent always-on-top window sits
//! over the game. While the user holds `Tab`, WoWSP captures the game window,
//! runs a lightweight detector to find the central team-list region, and
//! re-anchors the rendered roster to sit on top of it. Release `Tab` and the
//! overlay hides.
//!
//! Status: **skeleton**. `capture_game_window` and `set_overlay_visible` are
//! stubbed with TODOs; the real Win32 capture (`BitBlt` of the game window's
//! DC) + detector + window show/hide land in milestones M6–M8.

use base64::Engine;
use wowsp_tauri_shared::CaptureResult;

/// Capture the game window and return it as base64 PNG bytes, plus (TODO) the
/// detected roster rectangle in screen coordinates.
///
/// TODO(M8): locate the World of Warships window by class name, `GetWindowDC`,
/// `BitBlt` into a DIB, encode to PNG via `image`, and run the team-list
/// detector to populate `roster_rect`.
#[tauri::command]
pub fn capture_game_window() -> Result<CaptureResult, String> {
    // Skeleton: return a 1×1 transparent PNG so the frontend plumbing works
    // end-to-end before the real capture lands.
    let png = tiny_png();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(CaptureResult {
        image_base64: b64,
        roster_rect: None,
    })
}

/// Show or hide the overlay window. TODO(M6): create a second transparent,
/// always-on-top, click-through window on startup and toggle its visibility
/// here. For now this is a no-op stub the frontend can call.
#[tauri::command]
pub fn set_overlay_visible(_app: tauri::AppHandle, _visible: bool) -> Result<(), String> {
    Ok(())
}

/// A minimal valid 1×1 transparent PNG, for the capture skeleton.
fn tiny_png() -> Vec<u8> {
    // Pre-computed 1×1 RGBA PNG (transparent). Avoids pulling a full encoder
    // call into the skeleton hot path.
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
