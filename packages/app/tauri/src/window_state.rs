//! Main-window geometry memory — reopen the window where the player left it.
//!
//! The player drags and resizes the main window to taste; the shell persists
//! that geometry (<data>/window-state.json, physical pixels) and reapplies it
//! on the next launch, so the app comes back exactly where it was closed.
//! The restore is *validated* against the desktop that greets it this time,
//! because a remembered position can go stale in two ordinary ways: the
//! monitor it lived on was unplugged (the whole coordinate range vanished),
//! or the window was closed hanging off the edge of the desktop. Both are
//! handled by [`sanitize`]:
//!
//! - A window that still lands on some monitor keeps its position, nudged by
//!   the minimal shift that pulls any overhanging edge back inside the
//!   combined desktop (the union of every monitor's work area — side by side,
//!   that is the summed widths of all screens).
//! - A window that lands on NO monitor (screen gone, or closed fully
//!   off-screen) is relocated into the monitor nearest its remembered spot,
//!   fully inside that monitor's work area — visible and grabbable, never
//!   beyond the reachable desktop.
//! - The size is bounded both ways: never below 800×600 (mirroring the
//!   tauri.conf.json minWidth/minHeight pair) and never beyond the combined
//!   desktop, so a remembered 4K-window cannot swallow a laptop screen and a
//!   remembered thumbprint cannot reopen unusable.
//!
//! Recording is event-driven from the shell's `on_window_event` hook (see
//! `record`): move/resize update an in-memory snapshot, flushed to disk at
//! most every `SAVE_DEBOUNCE` (interactive drags fire dozens of events a
//! second) and always on close requests and process exit (`flush_now` from
//! the `RunEvent::Exit` hook), via the same atomic replace every other data
//! file uses. While maximized only the flag is updated — the last normal
//! geometry survives, so un-maximizing after a restore still lands where the
//! player expects. Minimized windows are never recorded (Windows reports a
//! (-32000, -32000) position for them, which would poison the state).
//!
//! This is the WoWSP-local copy of the facility; the generalised, publishable
//! half lands in the upstream hikari-host crate (same `sanitize` contract),
//! and this module retires in favour of it once that crate ships a release
//! the workspace consumes — the same route the close guard took
//! (langyo/wowsp#1628 → langyo/wowsp#1641).

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{WebviewWindow, Window, WindowEvent};

use crate::atomic_file;

/// Persisted-geometry file name inside the data dir (see `paths::data_dir`).
const STATE_FILE: &str = "window-state.json";

/// The smallest restored geometry. Mirrors the main window's
/// `minWidth`/`minHeight` in tauri.conf.json — the OS enforces the pair
/// during interactive resizes, [`sanitize`] enforces it on restore.
pub(crate) const MIN_WIDTH: u32 = 800;
pub(crate) const MIN_HEIGHT: u32 = 600;

/// Minimum spacing between two disk flushes. Interactive drags and resizes
/// fire a `Moved`/`Resized` event per frame; the file only needs the final
/// geometry, and the close/exit flush always captures the last word.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(800);

// ── Pure geometry core ─────────────────────────────────────────────────────
//
// Everything below `ScreenLayout`'s `probe` is plain arithmetic on rects, so
// the restore policy is unit-testable without a window manager. Coordinates
// are PHYSICAL pixels in the desktop-wide coordinate space (negative x/y are
// ordinary — monitors left of / above the primary), and edge math runs in
// i64 so a maximally-placed window cannot overflow.

/// A monitor's usable rectangle (its work area — the full bounds minus the
/// taskbar), in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl ScreenRect {
    /// Exclusive right edge (`x + width`), in the widened math domain.
    fn right(self) -> i64 {
        self.x as i64 + self.width as i64
    }

    /// Exclusive bottom edge (`y + height`), in the widened math domain.
    fn bottom(self) -> i64 {
        self.y as i64 + self.height as i64
    }

    /// Whether a window rect placed at (`x`, `y`) with `w`×`h` overlaps
    /// this screen at all — the "is the remembered spot still reachable"
    /// test. Touching edges only (zero overlap) does NOT count.
    fn overlaps(self, x: i64, y: i64, w: i64, h: i64) -> bool {
        x < self.right() && (self.x as i64) < x + w && y < self.bottom() && (self.y as i64) < y + h
    }

    /// Squared distance between this screen and a window rect (0 when they
    /// overlap) — the "which monitor deserves the relocated window" metric.
    /// Accumulated in i128: a hand-edited state file can carry i32::MAX
    /// coordinates against an opposite-sign monitor, and that square
    /// overflows i64.
    fn distance_sq(self, x: i64, y: i64, w: i64, h: i64) -> i128 {
        let dx = (self.x as i64 - (x + w)).max(x - self.right()).max(0);
        let dy = (self.y as i64 - (y + h)).max(y - self.bottom()).max(0);
        i128::from(dx) * i128::from(dx) + i128::from(dy) * i128::from(dy)
    }
}

/// The desktop the restore runs against: every monitor's work area plus
/// which entry is the primary (the tie-break when a lost window is equidistant
/// from two screens).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScreenLayout {
    pub(crate) screens: Vec<ScreenRect>,
    pub(crate) primary: usize,
}

impl ScreenLayout {
    /// The combined desktop: the bounding box of every monitor. A window
    /// cannot usefully be larger than this, and nothing outside it is
    /// reachable — side-by-side monitors make its width the summed width of
    /// all screens.
    fn bounds(&self) -> ScreenRect {
        let left = self.screens.iter().map(|s| s.x as i64).min().unwrap_or(0);
        let top = self.screens.iter().map(|s| s.y as i64).min().unwrap_or(0);
        let right = self.screens.iter().map(|s| s.right()).max().unwrap_or(0);
        let bottom = self.screens.iter().map(|s| s.bottom()).max().unwrap_or(0);
        ScreenRect {
            x: left as i32,
            y: top as i32,
            width: (right - left).max(0) as u32,
            height: (bottom - top).max(0) as u32,
        }
    }

    /// The monitor a lost window relocates into: nearest by rect distance,
    /// ties broken toward the primary screen, then toward the earlier entry.
    fn nearest(&self, x: i64, y: i64, w: i64, h: i64) -> ScreenRect {
        let mut best = self.screens[0];
        let mut best_key = (i128::MAX, usize::MAX, usize::MAX);
        for (idx, screen) in self.screens.iter().enumerate() {
            let key = (
                screen.distance_sq(x, y, w, h),
                usize::from(idx != self.primary),
                idx,
            );
            if key < best_key {
                best_key = key;
                best = *screen;
            }
        }
        best
    }
}

/// The persisted main-window geometry (physical pixels; `x`/`y` is the
/// OUTER position, matching what `Window::outer_position` reports and
/// `Window::set_position` accepts).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub(crate) struct WindowGeometry {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) maximized: bool,
}

/// Validate a remembered geometry against the desktop that greets it.
///
/// Returns `None` when there is no screen to validate against (a monitor
/// probe that answered nothing); the caller then applies the raw geometry as
/// a best effort. Otherwise the returned geometry is fully inside the
/// combined desktop, on a reachable monitor, sized between the 800×600 floor
/// and the combined-desktop ceiling.
pub(crate) fn sanitize(saved: WindowGeometry, layout: &ScreenLayout) -> Option<WindowGeometry> {
    if layout.screens.is_empty() {
        return None;
    }
    let bounds = layout.bounds();

    // Size first: floor at the config minimum, ceiling at the combined
    // desktop. A desktop SMALLER than the floor (a sub-800×600 screen) wins —
    // a fully visible window beats an on-paper minimum the screen cannot
    // show; the OS-level min constraint still holds for interactive resizes.
    let width = clamp_dim(saved.width as i64, MIN_WIDTH as i64, bounds.width as i64);
    let height = clamp_dim(saved.height as i64, MIN_HEIGHT as i64, bounds.height as i64);

    let want_x = saved.x as i64;
    let want_y = saved.y as i64;

    // Position: keep the remembered spot when any monitor is still under it,
    // shifting only by what overhangs the combined desktop. Otherwise the
    // window is unreachable (unplugged monitor, closed off-screen) and
    // relocates into the nearest monitor, clamped fully inside its work area.
    let (x, y) = if layout
        .screens
        .iter()
        .any(|s| s.overlaps(want_x, want_y, width, height))
    {
        (
            clamp_pos(want_x, bounds.x as i64, bounds.right() - width),
            clamp_pos(want_y, bounds.y as i64, bounds.bottom() - height),
        )
    } else {
        let target = layout.nearest(want_x, want_y, width, height);
        (
            clamp_pos(want_x, target.x as i64, target.right() - width),
            clamp_pos(want_y, target.y as i64, target.bottom() - height),
        )
    };

    Some(WindowGeometry {
        x: x as i32,
        y: y as i32,
        width: width as u32,
        height: height as u32,
        maximized: saved.maximized,
    })
}

/// Clamp a dimension into [`min`, `max`]; when the ceiling itself is below
/// the floor (a desktop smaller than 800×600) the ceiling wins.
fn clamp_dim(want: i64, min: i64, max: i64) -> i64 {
    if max < min { max } else { want.clamp(min, max) }
}

/// Clamp a coordinate so a `dim` sized window fits inside [`low`,
/// `high`]; when the window is wider than the range it pins to `low`
/// (left/top aligned — the OS clips what cannot fit).
fn clamp_pos(want: i64, low: i64, high: i64) -> i64 {
    want.clamp(low, high.max(low))
}

// ── Desktop probe & persistence ────────────────────────────────────────────

/// Probe the live desktop through a window handle: every monitor's work
/// area, with the primary marked.
pub(crate) fn probe_layout(window: &WebviewWindow) -> Result<ScreenLayout> {
    let monitors = window
        .available_monitors()
        .map_err(|e| anyhow!("enumerate monitors: {e}"))?;
    let primary = window.primary_monitor().ok().flatten().map(|m| {
        (
            m.position().x,
            m.position().y,
            m.size().width,
            m.size().height,
        )
    });
    let mut screens = Vec::with_capacity(monitors.len());
    let mut primary_idx = 0;
    for monitor in &monitors {
        let area = monitor.work_area();
        if Some((
            monitor.position().x,
            monitor.position().y,
            monitor.size().width,
            monitor.size().height,
        )) == primary
        {
            primary_idx = screens.len();
        }
        screens.push(ScreenRect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        });
    }
    Ok(ScreenLayout {
        screens,
        primary: primary_idx,
    })
}

/// Where the persisted geometry lives.
fn state_path() -> Result<PathBuf> {
    crate::paths::data_dir().map(|dir| dir.join(STATE_FILE))
}

/// Read the persisted geometry. `None` = first launch (or a corrupt/unreadable
/// file, which logs and falls back to the centered default — never a crash).
fn load(path: &Path) -> Option<WindowGeometry> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::warn!(error = %err, ?path, "window state unreadable; falling back to centered default");
            return None;
        },
    };
    match serde_json::from_slice(&bytes) {
        Ok(geometry) => Some(geometry),
        Err(err) => {
            tracing::warn!(error = %err, ?path, "window state corrupt; falling back to centered default");
            None
        },
    }
}

// ── Live tracking (the save side) ─────────────────────────────────────────

/// In-memory snapshot between disk flushes. Guarded by a static mutex: the
/// window-event hook, close requests and the exit hook run on different
/// threads of the Tauri event loop.
struct Memory {
    geometry: WindowGeometry,
    last_flush: Instant,
}

static MEMORY: Mutex<Option<Memory>> = Mutex::new(None);

/// Feed one window event of the MAIN window into the tracker. Called from
/// the shell's `on_window_event` hook; every other label and every
/// non-geometry event is ignored.
pub(crate) fn record(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {},
        // A close request is intercepted (close guard / tray-minimize) or
        // honoured, but either way the geometry just stopped changing — the
        // flush must not wait out the debounce.
        WindowEvent::CloseRequested { .. } => return flush_now(),
        _ => return,
    }

    // Minimized windows report a (-32000, -32000) position on Windows;
    // recording that would poison the state for the next launch.
    // NOTE the asymmetry with restore(): Tauri maps set_size onto the
    // INNER size while position is outer. The main window is frameless
    // (decorations: false) where inner == outer on Windows, so recording
    // outer_size keeps save/restore symmetric here; a future decorated
    // surface would want inner_size instead.
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }

    let maximized = window.is_maximized().unwrap_or(false);
    let mut memory = MEMORY.lock().unwrap_or_else(|e| e.into_inner());
    let entry = memory.get_or_insert_with(|| Memory {
        // First event of the session: seed with this very geometry.
        geometry: WindowGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized,
        },
        last_flush: Instant::now(),
    });
    if maximized {
        // Keep the last NORMAL geometry: the maximized frame is the OS's
        // business, and it is what an un-maximize after restore returns to.
        entry.geometry.maximized = true;
    } else {
        entry.geometry = WindowGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized: false,
        };
    }
    if entry.last_flush.elapsed() >= SAVE_DEBOUNCE {
        flush_entry(entry);
    }
}

/// Flush the tracked geometry NOW (close requests, process exit). A no-op
/// when nothing was ever recorded — first launch without a move keeps the
/// file it already has (or stays absent), which is exactly right.
pub(crate) fn flush_now() {
    let mut memory = MEMORY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = memory.as_mut() {
        flush_entry(entry);
    }
}

/// Write one snapshot through the atomic replace, throttled by the caller.
fn flush_entry(entry: &mut Memory) {
    let outcome = state_path().and_then(|path| {
        let json = serde_json::to_string(&entry.geometry)
            .map_err(|e| anyhow!("serialize window state: {e}"))?;
        atomic_file::write(&path, &json)
    });
    // Throttle failures the same as successes: a read-only data dir must not
    // re-attempt a write on every drag frame.
    entry.last_flush = Instant::now();
    if let Err(err) = outcome {
        tracing::warn!(error = %err, "window state save failed");
    }
}

// ── Restore (the load side) ───────────────────────────────────────────────

/// Apply the remembered geometry to the main window. `Ok(false)` = nothing
/// remembered (first launch): the caller centers. A monitor probe that
/// answers nothing applies the raw geometry unvalidated — the position was
/// reachable when it was saved, and there is no desktop evidence against it.
pub(crate) fn restore(window: &WebviewWindow) -> Result<bool> {
    let path = state_path()?;
    let Some(saved) = load(&path) else {
        return Ok(false);
    };
    let geometry = match probe_layout(window) {
        Ok(layout) => sanitize(saved, &layout).unwrap_or(saved),
        Err(err) => {
            tracing::warn!(error = %err, "monitor probe failed; applying saved geometry unvalidated");
            saved
        },
    };
    // Size before position: the position clamps against the new size.
    window
        .set_size(tauri::PhysicalSize::new(geometry.width, geometry.height))
        .map_err(|e| anyhow!("restore window size: {e}"))?;
    window
        .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))
        .map_err(|e| anyhow!("restore window position: {e}"))?;
    if geometry.maximized {
        window
            .maximize()
            .map_err(|e| anyhow!("restore maximized state: {e}"))?;
    }
    tracing::debug!(?geometry, "main window geometry restored");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: i32, y: i32, width: u32, height: u32) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn geometry(x: i32, y: i32, width: u32, height: u32) -> WindowGeometry {
        WindowGeometry {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    fn single_screen() -> ScreenLayout {
        ScreenLayout {
            screens: vec![screen(0, 0, 1920, 1040)],
            primary: 0,
        }
    }

    fn side_by_side() -> ScreenLayout {
        ScreenLayout {
            screens: vec![screen(0, 0, 1920, 1040), screen(1920, 0, 2560, 1400)],
            primary: 0,
        }
    }

    /// A window fully on a screen that still exists comes back EXACTLY as
    /// saved — restore must be invisible to the player.
    #[test]
    fn on_screen_geometry_is_kept_verbatim() {
        let saved = geometry(100, 50, 1280, 820);
        assert_eq!(sanitize(saved, &single_screen()), Some(saved));
    }

    /// A window spanning two monitors is legitimate and stays put.
    #[test]
    fn spanning_two_screens_is_kept() {
        let saved = geometry(1500, 100, 1000, 600);
        assert_eq!(sanitize(saved, &side_by_side()), Some(saved));
    }

    /// Negative coordinates are ordinary (a monitor left of the primary) and
    /// restore verbatim.
    #[test]
    fn negative_coordinates_restore_verbatim() {
        let layout = ScreenLayout {
            screens: vec![screen(-1920, 0, 1920, 1040), screen(0, 0, 1920, 1040)],
            primary: 1,
        };
        let saved = geometry(-1900, 30, 1280, 820);
        assert_eq!(sanitize(saved, &layout), Some(saved));
    }

    /// A window overhanging the desktop edge is pulled back by exactly the
    /// overhang — minimal shift, same screen.
    #[test]
    fn overhanging_edge_is_pulled_back_minimally() {
        // 1920-wide screen, window at x=1500 w=800 → 380px past the edge.
        let fixed = sanitize(geometry(1500, 0, 800, 600), &single_screen()).unwrap();
        assert_eq!(
            (fixed.x, fixed.y, fixed.width, fixed.height),
            (1120, 0, 800, 600)
        );
        // Same from the top: y=-100 lands at 0.
        let fixed = sanitize(geometry(10, -100, 800, 600), &single_screen()).unwrap();
        assert_eq!(fixed.y, 0);
    }

    /// The unplugged-monitor case: the second screen is GONE and the window
    /// that lived on it relocates fully inside the remaining (nearest)
    /// screen.
    #[test]
    fn unplugged_monitor_relocates_onto_the_nearest_screen() {
        let alone = single_screen();
        // Saved at x=2400 (on the now-missing 2560-wide second monitor).
        let fixed = sanitize(geometry(2400, 100, 1280, 820), &alone).unwrap();
        // Clamped into the primary's work area, fully visible.
        assert_eq!(fixed.x, 1920 - 1280);
        assert_eq!((fixed.y, fixed.width, fixed.height), (100, 1280, 820));
    }

    /// A window closed fully off-screen (none of it on any monitor) is the
    /// same case as the unplugged monitor: relocate, fully visible.
    #[test]
    fn fully_off_screen_relocates() {
        let fixed = sanitize(geometry(-5000, 4000, 800, 600), &side_by_side()).unwrap();
        // Fully inside one of the screens' work areas.
        assert!(fixed.x >= 0 && fixed.x + fixed.width as i32 <= 1920);
        assert!(fixed.y >= 0 && fixed.y + fixed.height as i32 <= 1040);
    }

    /// Between two monitors there can be a hole with real coordinates on
    /// no screen; a window saved there relocates to the NEAREST screen
    /// (rect distance decides, not coordinate ranges).
    #[test]
    fn hole_between_screens_relocates_to_the_nearest() {
        // A 1480px gap between the two screens; the 1280-wide window fits in
        // it on no screen and sits nearer the first screen's right edge.
        let layout = ScreenLayout {
            screens: vec![screen(0, 0, 1920, 1040), screen(3400, 0, 1920, 1040)],
            primary: 0,
        };
        let fixed = sanitize(geometry(2000, 200, 1280, 820), &layout).unwrap();
        assert_eq!((fixed.x, fixed.y), (1920 - 1280, 200));
    }

    /// Equidistant relocation ties break toward the primary screen.
    #[test]
    fn relocation_tie_breaks_to_primary() {
        // Two screens stacked with a gap; the lost window sits exactly
        // halfway between them, so only the primary flag breaks the tie.
        let layout = ScreenLayout {
            screens: vec![screen(-960, 0, 1920, 1040), screen(-960, 2200, 1920, 1040)],
            primary: 1,
        };
        let fixed = sanitize(geometry(-960, 1320, 800, 600), &layout).unwrap();
        // Landed fully inside the PRIMARY (lower) screen.
        assert_eq!((fixed.x, fixed.y), (-960, 2200));
    }

    /// The 800×600 floor applies on restore — a thumbprint-sized memory
    /// reopens usable.
    #[test]
    fn undersized_geometry_is_raised_to_the_minimum() {
        let fixed = sanitize(geometry(10, 10, 320, 200), &single_screen()).unwrap();
        assert_eq!((fixed.width, fixed.height), (MIN_WIDTH, MIN_HEIGHT));
        // Position re-clamps against the larger size (fits, so unchanged).
        assert_eq!((fixed.x, fixed.y), (10, 10));
    }

    /// The combined desktop is the ceiling — a 4K-sized memory cannot swallow
    /// a laptop screen (side-by-side layouts: the summed width; height stays
    /// the tallest single screen).
    #[test]
    fn oversized_geometry_is_capped_at_the_combined_desktop() {
        let fixed = sanitize(geometry(0, 0, 6000, 4000), &side_by_side()).unwrap();
        // 1920 + 2560 wide, max(1040, 1400) tall.
        assert_eq!((fixed.width, fixed.height), (4480, 1400));
    }

    /// A desktop physically smaller than the 800×600 floor (sub-netbook
    /// screens, some VMs) sizes to the desktop instead — fully visible beats
    /// an on-paper minimum.
    #[test]
    fn tiny_desktop_wins_over_the_minimum() {
        let layout = ScreenLayout {
            screens: vec![screen(0, 0, 640, 480)],
            primary: 0,
        };
        let fixed = sanitize(geometry(0, 0, 800, 600), &layout).unwrap();
        assert_eq!((fixed.width, fixed.height), (640, 480));
    }

    /// A window bigger than the monitor it relocates into pins to that
    /// monitor's top-left (the OS clips the overhang).
    #[test]
    fn relocation_of_an_oversized_window_pins_to_the_screen_edge() {
        let alone = single_screen();
        let fixed = sanitize(geometry(5000, 0, 2400, 900), &alone).unwrap();
        assert_eq!((fixed.x, fixed.y), (0, 0));
    }

    /// No monitors answered the probe: no opinion (the caller applies the
    /// raw geometry).
    #[test]
    fn empty_layout_is_none() {
        let layout = ScreenLayout {
            screens: vec![],
            primary: 0,
        };
        assert_eq!(sanitize(geometry(10, 10, 1280, 820), &layout), None);
    }

    /// The maximized flag survives sanitize untouched — position and size
    /// are the NORMAL geometry the un-maximize returns to.
    #[test]
    fn maximized_flag_passes_through() {
        let saved = WindowGeometry {
            x: 5,
            y: 5,
            width: 1280,
            height: 820,
            maximized: true,
        };
        let fixed = sanitize(saved, &single_screen()).unwrap();
        assert!(fixed.maximized);
        assert_eq!(
            (fixed.x, fixed.y, fixed.width, fixed.height),
            (5, 5, 1280, 820)
        );
    }

    /// A floor-raise forces the position re-clamp at the desktop's
    /// right/bottom edge: a 100×100 memory at (1700, 900) grows to 800×600
    /// and shifts to stay fully visible.
    #[test]
    fn floor_raise_re_clamps_the_position() {
        let fixed = sanitize(geometry(1700, 900, 100, 100), &single_screen()).unwrap();
        assert_eq!(
            (fixed.x, fixed.y, fixed.width, fixed.height),
            (1120, 440, 800, 600)
        );
    }

    /// Touching an edge is NOT overlapping: a window exactly adjacent to the
    /// only screen (zero shared pixels) relocates like a gone-monitor window.
    #[test]
    fn edge_touching_is_not_overlapping() {
        let fixed = sanitize(geometry(1920, 0, 1280, 820), &single_screen()).unwrap();
        assert_eq!((fixed.x, fixed.y), (640, 0));
    }

    /// A gone monitor under a MAXIMIZED memory relocates the normal geometry
    /// AND keeps the flag: restore maximizes onto the remaining screen.
    #[test]
    fn maximized_gone_monitor_relocates_and_keeps_the_flag() {
        let saved = WindowGeometry {
            x: 2400,
            y: 100,
            width: 1280,
            height: 820,
            maximized: true,
        };
        let fixed = sanitize(saved, &single_screen()).unwrap();
        assert!(fixed.maximized);
        assert_eq!(
            (fixed.x, fixed.y, fixed.width, fixed.height),
            (640, 100, 1280, 820)
        );
    }

    /// The persisted shape is a flat JSON object (human-inspectable in a
    /// support bundle) and round-trips.
    #[test]
    fn geometry_round_trips_through_json() {
        let geometry = WindowGeometry {
            x: -1920,
            y: 42,
            width: 1280,
            height: 820,
            maximized: true,
        };
        let json = serde_json::to_string(&geometry).unwrap();
        assert_eq!(
            json,
            "{\"x\":-1920,\"y\":42,\"width\":1280,\"height\":820,\"maximized\":true}"
        );
        assert_eq!(
            serde_json::from_str::<WindowGeometry>(&json).unwrap(),
            geometry
        );
    }
}
