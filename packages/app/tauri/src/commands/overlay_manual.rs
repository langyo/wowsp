//! Ring cache of the LAST TAB-HELD automatic game captures, backing the
//! screenshot-style manual-locate picker and its image selector.
//!
//! The Tab watcher captures the game window several times a second while the
//! overlay is up (`compute_anchor`, the sink fast-path). Until now those
//! frames were used and dropped; the manual-locate flow wants the LAST one
//! as a positioning reference — and specifically the frame from the instant
//! Tab was last held (the roster moment the player actually saw), NOT
//! whatever was on screen most recently: `capture_game_rgba_cached` stores
//! only while the key is down AND past a short hold gate (the overlay's
//! `TAB_STORE_MIN_HOLD`, which skips the pre-fade-in instants of a press),
//! and `compute_anchor` stores any capture the detector PROVED carries the
//! table — so a capture that lands after the release, or before the table
//! rendered, never evicts the reference, while every detected roster does
//! refresh it. The newest frame stays the picker's DEFAULT; the last
//! [`GALLERY_CAPACITY`] frames additionally form the picker's image
//! selector row (the calibration editor lets the user draw against any of
//! them, or against a pasted/file screenshot resolved elsewhere).
//!
//! The cache is a static ring written by the watcher thread (and by the
//! one-shot fresh-capture fallback in `start_manual_locate`, whose
//! header check proves the table is on screen right then) and read by the
//! `manual_locate_*` commands on the Tauri async runtime. Frames
//! are kept RAW (RGBA + size + the game rect they were captured from + a
//! wall-clock stamp): everything expensive — PNG encoding, guide detection —
//! runs once, in the command, on a clone. All coordinates in the cache are
//! PHYSICAL pixels relative to the captured rect (the clamped game window),
//! so no DPI term is needed anywhere in this module.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use wowsp_tauri_shared::Rect;

/// One cached capture: RAW pixels plus the identity needed to judge
/// validity, plus a TINY pre-rendered thumbnail (≤160 px wide) so the
/// gallery command never clones a raw multi-megabyte buffer per frame.
struct LastCapture {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    thumb: Vec<u8>,
    thumb_width: u32,
    thumb_height: u32,
    /// Game-window rect (physical screen px) the frame was BitBlt from.
    game_rect: Rect,
    /// Wall-clock capture time (unix ms) — the picker shows the age.
    at_ms: u64,
}

/// Thumbnail width cap (physical px). Integer-factor box-average keeps the
/// mapping exact; the buffer is a few tens of KB per frame.
const THUMB_MAX_WIDTH: u32 = 160;

/// Integer-factor box-average downscale of an RGBA buffer (same math as the
/// picker image encoder, kept local so this module owns its memory story).
fn downscale_thumb(rgba: &[u8], w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    if w == 0 || h == 0 {
        return (Vec::new(), 0, 0);
    }
    if w <= THUMB_MAX_WIDTH {
        return (rgba.to_vec(), w, h);
    }
    let factor = w.div_ceil(THUMB_MAX_WIDTH);
    let (nw, nh) = (w / factor, h / factor);
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
            let n = factor * factor;
            for dy in 0..factor {
                for dx in 0..factor {
                    let i = (((y * factor + dy) * w + x * factor + dx) * 4) as usize;
                    sr += u32::from(rgba[i]);
                    sg += u32::from(rgba[i + 1]);
                    sb += u32::from(rgba[i + 2]);
                }
            }
            let o = ((y * nw + x) * 4) as usize;
            out[o] = (sr / n).min(255) as u8;
            out[o + 1] = (sg / n).min(255) as u8;
            out[o + 2] = (sb / n).min(255) as u8;
            out[o + 3] = 255;
        }
    }
    (out, nw, nh)
}

/// The capture ring, NEWEST LAST. [`GALLERY_CAPACITY`] frames at most.
static CAPTURES: Mutex<VecDeque<LastCapture>> = Mutex::new(VecDeque::new());

/// Captures older than this are ignored by the picker: HUD phases move the
/// table within a battle and resolution switches change everything, so a
/// much older frame is a misleading positioning reference.
const CAPTURE_MAX_AGE: Duration = Duration::from_secs(10 * 60);

/// Minimum spacing between cached stores. The watcher captures up to ~2 Hz
/// (sink probes) while Tab is held and naively caching every frame clones
/// ~24 MB a pop on 4K — the picker only needs a FEW RECENT frames, so one
/// store every few seconds keeps the ring fresh at a fraction of the
/// allocation traffic.
const STORE_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// How many recent frames the picker's image selector offers. Ten covers a
/// whole battle's HUD phases at the store cadence. Aged frames are DROPPED
/// on every store (not merely hidden from reads), so the ring's steady
/// memory is bounded by the battles the player actually holds Tab through.
const GALLERY_CAPACITY: usize = 10;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn still_fresh(c: &LastCapture) -> bool {
    now_ms().saturating_sub(c.at_ms) <= CAPTURE_MAX_AGE.as_millis() as u64
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
        let Ok(ring) = CAPTURES.lock() else {
            return at;
        };
        let due = ring
            .back()
            .is_none_or(|c| at.saturating_sub(c.at_ms) >= STORE_MIN_INTERVAL.as_millis() as u64);
        if !due {
            return ring.back().map(|c| c.at_ms).unwrap_or(at);
        }
    }
    let frame = rgba.to_vec();
    let (thumb, thumb_width, thumb_height) = downscale_thumb(rgba, width, height);
    if let Ok(mut ring) = CAPTURES.lock() {
        // Drop aged frames for real — the ring only ever holds what a
        // battle's Tab holds actually produced.
        ring.retain(still_fresh);
        ring.push_back(LastCapture {
            rgba: frame,
            width,
            height,
            thumb,
            thumb_width,
            thumb_height,
            game_rect,
            at_ms: at,
        });
        while ring.len() > GALLERY_CAPACITY {
            ring.pop_front();
        }
        // Visible in the dev console: the picker's reference frame was
        // refreshed (at most once per STORE_MIN_INTERVAL while Tab is held).
        tracing::info!(
            width,
            height,
            cached = ring.len(),
            "manual-locate capture cache updated"
        );
    }
    at
}

/// Clone of the NEWEST cached frame plus its capture time, when one exists
/// that is still fresh enough AND matches the given game-window SIZE — an
/// origin difference is fine (every downstream coordinate is
/// window-relative), a size difference means a different resolution and the
/// frame is useless as a reference.
pub(super) fn fresh_frame_for(game_rect: &Rect) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    let ring = CAPTURES.lock().ok()?;
    let c = ring.back()?;
    frame_usable(c, game_rect).then(|| (c.rgba.clone(), c.width, c.height, c.at_ms, c.game_rect))
}

/// Clone of the cached frame with the given stamp — the picker's image
/// selector resolving one of the gallery thumbnails back to its full
/// pixels. Same freshness and size gates as [`fresh_frame_for`]; a stamp
/// that no longer exists (aged out or replaced) resolves to `None` and the
/// caller falls back to the newest frame.
pub(super) fn frame_by_stamp(
    at_ms: u64,
    game_rect: &Rect,
) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    let ring = CAPTURES.lock().ok()?;
    let c = ring.iter().rev().find(|c| c.at_ms == at_ms)?;
    frame_usable(c, game_rect).then(|| (c.rgba.clone(), c.width, c.height, c.at_ms, c.game_rect))
}

fn frame_usable(c: &LastCapture, game_rect: &Rect) -> bool {
    still_fresh(c) && c.game_rect.width == game_rect.width && c.game_rect.height == game_rect.height
}

/// One gallery entry's payload: the ready-made thumbnail buffer + its
/// pixel size, the capture stamp, the capture's PHYSICAL size and the
/// game rect it was captured from.
pub(super) struct GalleryThumb {
    pub(super) thumb: Vec<u8>,
    pub(super) thumb_size: (u32, u32),
    pub(super) at_ms: u64,
    pub(super) phys_size: (u32, u32),
    pub(super) game_rect: Rect,
}

/// Every cached frame's ready-made THUMBNAIL plus its metadata, NEWEST
/// FIRST — the picker's image selector row. The thumbnails were rendered
/// at store time, so this clones a few tens of KB per frame, never the
/// raw buffers.
pub(super) fn gallery_entries() -> Vec<GalleryThumb> {
    let Ok(ring) = CAPTURES.lock() else {
        return Vec::new();
    };
    ring.iter()
        .rev()
        .filter(|c| still_fresh(c))
        .map(|c| GalleryThumb {
            thumb: c.thumb.clone(),
            thumb_size: (c.thumb_width, c.thumb_height),
            at_ms: c.at_ms,
            phys_size: (c.width, c.height),
            game_rect: c.game_rect,
        })
        .collect()
}
