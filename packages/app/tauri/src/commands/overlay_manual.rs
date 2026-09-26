//! Cache of the LAST automatic game capture, backing the screenshot-style
//! manual-locate picker.
//!
//! The Tab watcher captures the game window several times a second while the
//! overlay is up (`compute_anchor`, the sink fast-path). Until now those
//! frames were used and dropped; the manual-locate flow wants the LAST one
//! as a positioning reference — the player re-draws the table box against
//! the frame the detector itself just saw, with the detector's guides
//! overlaid, instead of holding Tab in-game and boxing against the live
//! (dimmed, flickering) table through a transparent picker.
//!
//! The cache is a single static slot written by the watcher thread (and by
//! the one-shot fresh-capture fallback in `start_manual_locate`) and read by
//! the `manual_locate_context` command on the Tauri async runtime. Frames
//! are kept RAW (RGBA + size + the game rect they were captured from + a
//! wall-clock stamp): everything expensive — PNG encoding, guide detection —
//! runs once, in the command, on a clone. All coordinates in the cache are
//! PHYSICAL pixels relative to the captured rect (the clamped game window),
//! so no DPI term is needed anywhere in this module.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use wowsp_tauri_shared::Rect;

/// One cached capture: RAW pixels plus the identity needed to judge validity.
struct LastCapture {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    /// Game-window rect (physical screen px) the frame was BitBlt from.
    game_rect: Rect,
    /// Wall-clock capture time (unix ms) — the picker shows the age.
    at_ms: u64,
}

static LAST_CAPTURE: Mutex<Option<LastCapture>> = Mutex::new(None);

/// Captures older than this are ignored by the picker: HUD phases move the
/// table within a battle and resolution switches change everything, so a
/// much older frame is a misleading positioning reference.
const CAPTURE_MAX_AGE: Duration = Duration::from_secs(10 * 60);

/// Minimum spacing between cached stores. The watcher captures up to ~2 Hz
/// (sink probes) while Tab is held and naively caching every frame clones
/// ~24 MB a pop on 4K — the picker only needs a RECENT frame, so one store
/// every few seconds keeps the cache fresh at a fraction of the allocation
/// traffic.
const STORE_MIN_INTERVAL: Duration = Duration::from_secs(2);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Remember `rgba` as the newest automatic capture (one clone — the watcher
/// keeps using its own copy), rate-limited to [`STORE_MIN_INTERVAL`].
/// Returns the stamp of the CACHED frame (the fresh one when stored, the
/// still-recent previous one when throttled) — the picker's age label.
/// Never blocks meaningfully: a wedged lock simply drops the update; a
/// bogus frame is refused outright.
pub(super) fn store_capture(rgba: &[u8], width: u32, height: u32, game_rect: Rect) -> u64 {
    let at = now_ms();
    if width == 0 || height == 0 || rgba.len() < width as usize * height as usize * 4 {
        return at;
    }
    // Throttle check FIRST (the common case at the sink probe's 2 Hz cadence
    // must not pay the ~24 MB clone at all), then clone OUTSIDE the lock —
    // the copy must not extend the lock's hold time for readers either.
    {
        let Ok(slot) = LAST_CAPTURE.lock() else {
            return at;
        };
        let due = slot
            .as_ref()
            .is_none_or(|c| at.saturating_sub(c.at_ms) >= STORE_MIN_INTERVAL.as_millis() as u64);
        if !due {
            return slot.as_ref().map(|c| c.at_ms).unwrap_or(at);
        }
    }
    let frame = rgba.to_vec();
    if let Ok(mut slot) = LAST_CAPTURE.lock() {
        *slot = Some(LastCapture {
            rgba: frame,
            width,
            height,
            game_rect,
            at_ms: at,
        });
    }
    at
}

/// Clone of the cached frame plus its capture time, when one exists that is
/// still fresh enough AND matches the given game-window SIZE — an origin
/// difference is fine (every downstream coordinate is window-relative), a
/// size difference means a different resolution and the frame is useless as
/// a reference.
pub(super) fn fresh_frame_for(game_rect: &Rect) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    let slot = LAST_CAPTURE.lock().ok()?;
    let c = slot.as_ref()?;
    if c.game_rect.width != game_rect.width || c.game_rect.height != game_rect.height {
        return None;
    }
    if now_ms().saturating_sub(c.at_ms) > CAPTURE_MAX_AGE.as_millis() as u64 {
        return None;
    }
    Some((c.rgba.clone(), c.width, c.height, c.at_ms, c.game_rect))
}
