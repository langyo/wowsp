//! Ring cache of the LAST TAB-HELD automatic game captures, backing the
//! screenshot-style manual-locate picker and its image selector — plus the
//! on-disk archive that lets the calibration editor open on those frames
//! long after the game (and WoWSP itself) closed.
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
//! [`GALLERY_CAPACITY`] frames form the picker's image selector row (the
//! calibration editor lets the user draw against any of them, or against a
//! pasted/file screenshot resolved elsewhere) — the "最新画面" button is
//! gone: the gallery IS the newest-ten archive, kept current automatically.
//!
//! Two storage layers:
//!
//! - MEMORY RING: a static [`CAPTURES`] deque written by the watcher thread
//!   (and by the one-shot fresh-capture fallback in `start_manual_locate`,
//!   whose header check proves the table is on screen right then) and read
//!   by the `manual_locate_*` commands on the Tauri async runtime. Frames
//!   are kept RAW (RGBA + size + the game rect they were captured from + a
//!   wall-clock stamp): everything expensive — PNG encoding, guide
//!   detection — runs once, in the command, on a clone. All coordinates in
//!   the cache are PHYSICAL pixels relative to the captured rect (the
//!   clamped game window), so no DPI term is needed anywhere in this
//!   module.
//! - DISK ARCHIVE under the SYSTEM TEMP DIRECTORY
//!   (`%TEMP%/WoWSP/tab-captures`): every store also writes its full-res
//!   PNG + thumbnail + a one-line game-rect sidecar, on a background thread
//!   (encoding a 4K frame costs hundreds of ms — never on the watcher's
//!   path). The ring dies with the app process; the archive does not — the
//!   calibration editor must open on the last battles' frames after game
//!   and app are long closed, so the frames persist like any OS temp cache:
//!   cleanable, but never wiped on game exit. It rolls — the newest
//!   [`GALLERY_CAPACITY`] captures survive, older ones (and anything past
//!   [`CAPTURE_DISK_MAX_AGE`]) the prune deletes on the next store or
//!   gallery read.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
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

/// Captures older than this are ignored by the picker's FRESH path (the
/// battle-flow newest frame): HUD phases move the table within a battle and
/// resolution switches change everything, so a much older frame is a
/// misleading positioning reference. The GALLERY and the stamp-resolved
/// frames are deliberately NOT age-gated — a deliberately chosen archive
/// frame is a valid reference however old.
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

// ─────────────────────────────────────────────────────────────────────────
// Disk archive (system temp dir) — the ring that survives restarts
// ─────────────────────────────────────────────────────────────────────────

/// Archived captures older than this are pruned (by count the archive only
/// ever holds the newest [`GALLERY_CAPACITY`] anyway). Generous on purpose:
/// the frames are a temp-dir cache the OS or the user may clean at any
/// time, but WoWSP itself must not wipe them out from under a calibration
/// session the moment the game closes.
const CAPTURE_DISK_MAX_AGE: Duration = Duration::from_secs(72 * 60 * 60);

/// Root of the on-disk capture archive under the system temp directory.
fn disk_dir() -> PathBuf {
    std::env::temp_dir().join("WoWSP").join("tab-captures")
}

fn disk_frame_path(at_ms: u64) -> PathBuf {
    disk_dir().join(format!("{at_ms}.png"))
}

fn disk_thumb_path(at_ms: u64) -> PathBuf {
    disk_dir().join(format!("{at_ms}.thumb.png"))
}

/// Sidecar one-liner carrying the game-window rect the frame was captured
/// from — the PNG pixels alone cannot restore it, and every downstream
/// consumer keys coordinates on it.
fn disk_meta_path(at_ms: u64) -> PathBuf {
    disk_dir().join(format!("{at_ms}.meta"))
}

/// Stamp parse of an archive file name (`<u64>.png` / `<u64>.thumb.png` /
/// `<u64>.meta`), `None` for anything else (strays the prune deletes).
fn disk_stamp_of(name: &str) -> Option<u64> {
    let stem = name
        .strip_suffix(".png")
        .map(|s| s.strip_suffix(".thumb").unwrap_or(s))
        .or_else(|| name.strip_suffix(".meta"))?;
    stem.parse::<u64>().ok()
}

/// Pure prune policy: which stamps survive in the archive — the newest
/// [`GALLERY_CAPACITY`] stamps no older than [`CAPTURE_DISK_MAX_AGE`]
/// relative to `now_ms`. Everything else the caller deletes.
fn archive_survivors(mut stamps: Vec<u64>, now_ms: u64) -> Vec<u64> {
    stamps.sort_unstable();
    stamps.dedup();
    let cutoff = now_ms.saturating_sub(CAPTURE_DISK_MAX_AGE.as_millis() as u64);
    stamps.retain(|&s| s >= cutoff);
    let drop_count = stamps.len().saturating_sub(GALLERY_CAPACITY);
    stamps.drain(..drop_count);
    stamps
}

/// Encode RGBA pixels as PNG bytes (`None` when the buffer does not fit the
/// dims — never written to the archive).
fn encode_png_bytes(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    use std::io::Cursor;
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
}

/// Atomic byte-file write: `.part` sibling first, then the rename — a
/// concurrent reader (gallery listing) never sees a half-written frame.
fn write_bytes_atomic(path: &PathBuf, bytes: &[u8]) -> bool {
    let mut part = path.clone().into_os_string();
    part.push(".part");
    let part = PathBuf::from(part);
    if std::fs::write(&part, bytes).is_err() {
        return false;
    }
    std::fs::rename(&part, path).is_ok()
}

/// Serialize archive writers AND the prune: stores are throttled to one per
/// [`STORE_MIN_INTERVAL`] so contention is rare, but a wedged encode must
/// not interleave with a prune deleting what it is about to rename.
static DISK_IO_LOCK: Mutex<()> = Mutex::new(());

/// Delete every archive file whose stamp is outside
/// [`archive_survivors`], plus unparseable strays. Best-effort; logs on
/// nothing (a temp cache that cannot be pruned is harmless).
fn prune_disk() {
    let dir = disk_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, Option<u64>)> = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        files.push((ent.path(), disk_stamp_of(name)));
    }
    let stamps: Vec<u64> = files.iter().filter_map(|(_, s)| *s).collect();
    let keep: HashSet<u64> = archive_survivors(stamps, now_ms()).into_iter().collect();
    for (path, stamp) in files {
        let doomed = stamp.is_none_or(|s| !keep.contains(&s));
        if doomed {
            std::fs::remove_file(path).ok();
        }
    }
}

/// Write one capture into the archive and prune it, on a background thread
/// (the ~hundreds-of-ms PNG encode must never ride the watcher's path).
/// Failures log, never propagate — the memory ring stays the running
/// session's source of truth; the archive is its persistence. `thumb` is
/// the pre-rendered (buffer, width, height) triple.
fn spawn_disk_write(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    thumb: (Vec<u8>, u32, u32),
    game_rect: Rect,
    at_ms: u64,
) {
    std::thread::Builder::new()
        .name("tab-capture-disk".into())
        .spawn(move || {
            let Ok(_guard) = DISK_IO_LOCK.lock() else {
                return;
            };
            let dir = disk_dir();
            if std::fs::create_dir_all(&dir).is_err() {
                return;
            }
            let png = encode_png_bytes(&rgba, width, height);
            let thumb_png = encode_png_bytes(&thumb.0, thumb.1, thumb.2);
            if let Some(png) = png {
                if !write_bytes_atomic(&disk_frame_path(at_ms), &png) {
                    tracing::warn!(at = at_ms, "tab-capture archive write failed");
                    return;
                }
            }
            if let Some(thumb_png) = thumb_png {
                write_bytes_atomic(&disk_thumb_path(at_ms), &thumb_png);
            }
            write_bytes_atomic(
                &disk_meta_path(at_ms),
                format!(
                    "{},{},{},{}",
                    game_rect.x, game_rect.y, game_rect.width, game_rect.height
                )
                .as_bytes(),
            );
            prune_disk();
        })
        .ok();
}

/// Fire-and-forget prune (the gallery command's hook): keeps the archive
/// inside its count/age policy even when no new capture ever arrives.
pub(super) fn prune_disk_async() {
    std::thread::Builder::new()
        .name("tab-capture-prune".into())
        .spawn(|| {
            let Ok(_guard) = DISK_IO_LOCK.lock() else {
                return;
            };
            prune_disk();
        })
        .ok();
}

/// One archived capture's metadata (directory listing + sidecar parse — no
/// pixel decoding).
struct DiskEntry {
    at_ms: u64,
    game_rect: Rect,
    thumb: Option<PathBuf>,
}

/// Every archived capture, NEWEST FIRST. Entries with a missing/invalid
/// sidecar are skipped (the frame would have no coordinate identity).
fn disk_entries() -> Vec<DiskEntry> {
    let Ok(entries) = std::fs::read_dir(disk_dir()) else {
        return Vec::new();
    };
    let mut stamps: Vec<u64> = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if let Some(s) = disk_stamp_of(name) {
            stamps.push(s);
        }
    }
    stamps.sort_unstable();
    stamps.dedup();
    stamps.reverse();
    stamps
        .into_iter()
        .filter_map(|at_ms| {
            let meta = std::fs::read_to_string(disk_meta_path(at_ms)).ok()?;
            let mut parts = meta.split(',');
            let nums: Option<Vec<i32>> = parts
                .by_ref()
                .take(4)
                .map(|p| p.trim().parse().ok())
                .collect();
            // A truncated sidecar skips the entry (same contract as a
            // missing one) — never an index panic.
            let nums = nums.filter(|n| n.len() == 4)?;
            let game_rect = Rect {
                x: nums[0],
                y: nums[1],
                width: nums[2],
                height: nums[3],
            };
            if game_rect.width <= 0 || game_rect.height <= 0 {
                return None;
            }
            let thumb_path = disk_thumb_path(at_ms);
            let thumb = thumb_path.exists().then_some(thumb_path);
            Some(DiskEntry {
                at_ms,
                game_rect,
                thumb,
            })
        })
        .collect()
}

/// Decode one archived capture back into the ring-entry shape: PNG pixels
/// plus its sidecar game rect. `None` on any missing/corrupt piece.
fn decode_disk_frame(entry: &DiskEntry) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    let img = image::open(disk_frame_path(entry.at_ms)).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    (w > 0 && h > 0).then_some((img.into_raw(), w, h, entry.at_ms, entry.game_rect))
}

fn load_disk_frame(at_ms: u64) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    let entry = disk_entries().into_iter().find(|e| e.at_ms == at_ms)?;
    decode_disk_frame(&entry)
}

/// Remember `rgba` as the newest automatic capture (one clone — the watcher
/// keeps using its own copy), rate-limited to [`STORE_MIN_INTERVAL`].
/// Returns the stamp of the CACHED frame (the fresh one when stored, the
/// still-recent previous one when throttled) — the picker's age label.
/// Never blocks meaningfully: a wedged lock simply drops the update; a
/// bogus frame is refused outright. Every store also archives the frame to
/// the disk cache (background thread).
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
            rgba: frame.clone(),
            width,
            height,
            thumb: thumb.clone(),
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
    // Archive: full-res PNG + thumb + meta on a background thread, then the
    // count/age prune — the picker's newest-ten gallery outliving sessions.
    spawn_disk_write(
        frame,
        width,
        height,
        (thumb, thumb_width, thumb_height),
        game_rect,
        at,
    );
    at
}

/// Clone of the NEWEST cached frame plus its capture time, when one exists
/// that is still fresh enough AND matches the given game-window SIZE — an
/// origin difference is fine (every downstream coordinate is
/// window-relative), a size difference means a different resolution and the
/// frame is useless as a reference. The disk archive backs the memory ring
/// up (a fresh app process in front of a still-running game resolves its
/// first frame from there), under the SAME freshness + size gates.
pub(super) fn fresh_frame_for(game_rect: &Rect) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    if let Ok(ring) = CAPTURES.lock() {
        if let Some(c) = ring.back() {
            if frame_usable(c, game_rect) {
                return Some((c.rgba.clone(), c.width, c.height, c.at_ms, c.game_rect));
            }
        }
    }
    let cutoff = now_ms().saturating_sub(CAPTURE_MAX_AGE.as_millis() as u64);
    disk_entries()
        .into_iter()
        .find(|e| {
            e.at_ms >= cutoff
                && e.game_rect.width == game_rect.width
                && e.game_rect.height == game_rect.height
        })
        .and_then(|e| load_disk_frame(e.at_ms))
}

/// Clone of the cached frame with the given stamp — the picker's image
/// selector resolving one of the gallery thumbnails back to its full
/// pixels. Deliberately gate-free: a CHOSEN frame is a deliberate reference
/// however old (the calibration editor runs long after its battle ended),
/// and its OWN captured rect travels with it, so no live-window comparison
/// applies. A stamp that exists neither in the ring nor in the archive
/// resolves to `None` (the caller falls back to the newest frame).
pub(super) fn frame_by_stamp(at_ms: u64) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    if let Ok(ring) = CAPTURES.lock() {
        if let Some(c) = ring.iter().rev().find(|c| c.at_ms == at_ms) {
            return Some((c.rgba.clone(), c.width, c.height, c.at_ms, c.game_rect));
        }
    }
    load_disk_frame(at_ms)
}

/// The NEWEST capture regardless of age (ring first, then the disk
/// archive) — the gameless calibration editor's default reference: with the
/// game closed there is no fresh frame by definition, and the newest
/// archived one is the best available. `None` when nothing was ever
/// captured.
pub(super) fn newest_frame_any_age() -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    if let Ok(ring) = CAPTURES.lock() {
        if let Some(c) = ring.back() {
            return Some((c.rgba.clone(), c.width, c.height, c.at_ms, c.game_rect));
        }
    }
    // Newest first, walking to older frames until one decodes — a partial
    // newest entry (a crash mid-write) must not dead-end the gameless
    // editor while older frames sit intact.
    disk_entries().iter().find_map(decode_disk_frame)
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

/// The picker's image selector row: the last [`GALLERY_CAPACITY`] captures,
/// NEWEST FIRST — the memory ring's frames merged with the disk archive's
/// (the archive is what makes the gallery survive restarts and game exits;
/// the ring wins on stamp collisions since its pixels are already hot).
/// No age gate: this IS the newest-ten archive, not a freshness read. The
/// thumbnails were rendered at store time, so this clones a few tens of KB
/// per frame, never the raw buffers (archived frames decode their small
/// thumbnail PNGs, never the full-res ones).
pub(super) fn gallery_entries() -> Vec<GalleryThumb> {
    let mut out: Vec<GalleryThumb> = Vec::new();
    if let Ok(ring) = CAPTURES.lock() {
        out.extend(ring.iter().rev().map(|c| GalleryThumb {
            thumb: c.thumb.clone(),
            thumb_size: (c.thumb_width, c.thumb_height),
            at_ms: c.at_ms,
            phys_size: (c.width, c.height),
            game_rect: c.game_rect,
        }));
    }
    let seen: HashSet<u64> = out.iter().map(|e| e.at_ms).collect();
    for e in disk_entries() {
        if seen.contains(&e.at_ms) {
            continue;
        }
        let Some(thumb_path) = e.thumb else {
            continue;
        };
        let Ok(img) = image::open(&thumb_path) else {
            continue;
        };
        let img = img.to_rgba8();
        let (tw, th) = (img.width(), img.height());
        if tw == 0 || th == 0 {
            continue;
        }
        out.push(GalleryThumb {
            thumb: img.into_raw(),
            thumb_size: (tw, th),
            at_ms: e.at_ms,
            // disk_entries already validated both dims positive.
            phys_size: (e.game_rect.width as u32, e.game_rect.height as u32),
            game_rect: e.game_rect,
        });
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.at_ms));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_survivors_keeps_the_newest_within_age() {
        // A plausible unix-ms "now" — far above the 72h age in ms, so the
        // subtractions below stay in range.
        let now = 1_000_000_000_000u64;
        let age = CAPTURE_DISK_MAX_AGE.as_millis() as u64;
        // Ten fresh stamps all survive…
        let fresh: Vec<u64> = (0..10).map(|i| now - i).collect();
        let mut expected = fresh.clone();
        expected.sort_unstable();
        assert_eq!(archive_survivors(fresh.clone(), now), expected);
        // …an eleventh evicts the OLDEST (count policy)…
        let mut eleven = fresh.clone();
        eleven.push(now - 11);
        assert_eq!(
            archive_survivors(eleven.clone(), now).len(),
            GALLERY_CAPACITY
        );
        assert!(!archive_survivors(eleven, now).contains(&(now - 11)));
        // …stamps past the age policy die even when count would keep them…
        let mut aged = vec![now - age - 1, now - 1];
        assert_eq!(archive_survivors(aged.clone(), now), vec![now - 1]);
        // …the cutoff itself is inclusive (fresh).
        aged.push(now - age);
        assert!(archive_survivors(aged, now).contains(&(now - age)));
        // Duplicates collapse.
        assert_eq!(archive_survivors(vec![now, now, now], now), vec![now]);
    }

    #[test]
    fn disk_stamp_parse_covers_all_three_suffixes() {
        assert_eq!(disk_stamp_of("123.png"), Some(123));
        assert_eq!(disk_stamp_of("123.thumb.png"), Some(123));
        assert_eq!(disk_stamp_of("123.meta"), Some(123));
        assert_eq!(disk_stamp_of("123.png.part"), None);
        assert_eq!(disk_stamp_of("junk.png"), None);
        assert_eq!(disk_stamp_of("123.jpg"), None);
    }

    /// The archive round-trips a frame through disk: write via the same
    /// primitives `spawn_disk_write` uses, then read the stamp back through
    /// `frame_by_stamp` (memory ring empty) with its meta rect intact.
    #[test]
    fn archive_round_trips_frame_and_meta() {
        let dir = disk_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let at = now_ms();
        let (w, h) = (64u32, 32u32);
        let rgba: Vec<u8> = (0..(w * h * 4) as usize).map(|i| (i % 251) as u8).collect();
        let (thumb, tw, th) = downscale_thumb(&rgba, w, h);
        let rect = Rect {
            x: 12,
            y: 34,
            width: w as i32,
            height: h as i32,
        };
        let png = encode_png_bytes(&rgba, w, h).unwrap();
        assert!(write_bytes_atomic(&disk_frame_path(at), &png));
        let thumb_png = encode_png_bytes(&thumb, tw, th).unwrap();
        assert!(write_bytes_atomic(&disk_thumb_path(at), &thumb_png));
        assert!(write_bytes_atomic(
            &disk_meta_path(at),
            format!("{},{},{},{}", rect.x, rect.y, rect.width, rect.height).as_bytes()
        ));
        // Memory ring is empty under the test harness — the read must land
        // on the disk layer.
        let got = frame_by_stamp(at).expect("archived frame resolves");
        assert_eq!(got.1, w);
        assert_eq!(got.2, h);
        assert_eq!(got.4, rect);
        // The gallery lists it with the meta rect as its physical size…
        let gal = gallery_entries();
        let entry = gal.iter().find(|e| e.at_ms == at).expect("gallery entry");
        assert_eq!(entry.game_rect, rect);
        assert_eq!(entry.phys_size, (w, h));
        // …and cleanup removes every file of the stamp again.
        std::fs::remove_file(disk_frame_path(at)).ok();
        std::fs::remove_file(disk_thumb_path(at)).ok();
        std::fs::remove_file(disk_meta_path(at)).ok();
        assert!(frame_by_stamp(at).is_none());
    }
}
