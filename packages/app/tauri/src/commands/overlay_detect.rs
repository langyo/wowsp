//! Team-list (roster) region detector for the in-game overlay (Mode 2 / M8).
//!
//! Pure image analysis over an RGBA screenshot of the game window — no Win32
//! types in here, so the whole pipeline is unit-testable against synthetic
//! frames and a real captured frame (see the tests at the bottom).
//!
//! The detector is HEADER-ANCHORED: the vanilla Tab table always opens with
//! two solid team-header bars — teal-green "我的团队" on the left, brick-red
//! "敌军" on the right — and each player row below carries near-white name
//! text. Those cues survive every scene: the table itself is translucent, so
//! on bright maps its rows read LIGHT (luma ≈ 125) and any dark-projection
//! approach misfires, while the saturated header bars stay recognisable in
//! both the normal and the Tab-dimmed frame. Measured on a real 1440p
//! client (see `testdata/tab_table_768x480.png`):
//!
//!   header green ≈ rgb(81, 148, 140)   — TEAL: blue ≈ green, not far under
//!   header red   ≈ rgb(167, 121, 114)  — muted brick, r−g ≈ 46
//!   bar width    ≈ 24% of the frame each, seam exactly between them
//!   row text     ≈ pure white, row pitch ≈ 0.95× the bar height
//!
//! Pipeline: find the row carrying both bars → bar spans give the table
//! rectangle and the team split → white-text density bands below the header
//! give the player rows (extended with the median pitch when the arena hint
//! asks for more rows than were visible). Position-agnostic on purpose, so
//! scenario / co-op layouts anchor just as well as random battles.

use wowsp_tauri_shared::Rect;

/// Downscaled working width — caps the analysis cost on QHD/4K captures.
const MAX_WORK_WIDTH: u32 = 800;
/// Vertical band (fractions of the capture height) scanned for the header
/// row. The real table's bars sit at ~23%; pre-battle screens never render
/// them at all.
const HEADER_SCAN_TOP_FRAC: f32 = 0.06;
const HEADER_SCAN_BOTTOM_FRAC: f32 = 0.55;
/// Each header bar must span at least this fraction of the working width —
/// the real bars are ~24% each, water horizons and stray UI stay far below.
const HEADER_MIN_RUN_FRAC: f32 = 0.06;
/// Absolute floor (working px) for the same run, so tiny captures stay sane.
const HEADER_MIN_RUN_PX: usize = 8;
/// The header band must be at least this many consecutive hit rows thick
/// (the real bars are ~14 working px tall; stray same-colored bands —
/// water horizons, mod UI — don't stack that thick).
const HEADER_MIN_ROWS: usize = 3;
/// Header-bar height bounds in working px (the real bar is ~14 px at 800-wide).
const HEADER_MIN_H: usize = 4;
/// White-text density bands below 22% of the row peak are noise (e.g. our
/// own hint box, which GDI captures include as a layered window).
const ROW_TEXT_FRACTION: f32 = 0.22;
/// A text band shorter than this (working px) is anti-aliasing, not a row.
const ROW_BAND_MIN_H: usize = 2;
/// Vertical range below the header scanned for player-row text: bands are
/// first extracted from the conservative window (covers ~5v5–8v8 rosters),
/// then grown to the generous cap when the arena hint asks for more rows.
const ROW_SCAN_WINDOW_FRAC: f32 = 0.30;
const ROW_SCAN_MAX_SPAN_FRAC: f32 = 0.45;
/// Row-pitch bounds in working px (real pitch ≈ 13 at 800-wide).
const MIN_PITCH: f32 = 6.0;
const MAX_PITCH: f32 = 80.0;
/// Player rows found vs the arena hint: more than ±2 off means the bands
/// are not the roster (caller falls back to the centered default).
const ROW_COUNT_TOLERANCE: usize = 2;

/// Detector output: everything needed to anchor the overlay chips, in
/// physical pixels relative to the capture (game window) origin.
#[derive(Debug, Clone)]
pub(crate) struct DetectedRoster {
    /// The team-list rectangle (header bar top → last row bottom,
    /// green bar left → red bar right).
    pub rect: Rect,
    /// Vertical center of each player row, top to bottom. Length equals
    /// `expected_players` when the arena hint was available (short counts
    /// are extended with the median pitch).
    pub row_centers: Vec<i32>,
    /// Allies/enemies column split as a fraction (0–1) of the rect width.
    pub team_split: f32,
}

/// Detect the team-list panel and its row grid in an RGBA frame.
///
/// `expected_players` is the per-team player count from `tempArenaInfo.json`
/// (0 = unknown). It cross-checks the detected text rows and drives the
/// uniform extension of partially occluded rosters.
pub(crate) fn detect_roster(
    rgba: &[u8],
    width: u32,
    height: u32,
    expected_players: usize,
) -> Option<DetectedRoster> {
    let scale = width.div_ceil(MAX_WORK_WIDTH).max(1);
    let (px, w, h) = downscale_rgba(rgba, width, height, scale);
    if w < 64 || h < 64 {
        return None;
    }
    let rgb = |x: usize, y: usize| -> (i16, i16, i16) {
        let i = (y * w + x) * 3;
        (px[i] as i16, px[i + 1] as i16, px[i + 2] as i16)
    };

    // ── 1. Header: a THICK band of consecutive scan rows each carrying the
    //    green AND red bar ─────────────────────────────────────────────────
    // Single-row anchoring was fragile: any stray water horizon or mod UI
    // with one matching row outscored the real header. The real bars are
    // ~55 physical px tall (≈14 working px), so require HEADER_MIN_ROWS
    // consecutive hit rows and pick the best total area among candidates.
    let y_lo = (h as f32 * HEADER_SCAN_TOP_FRAC) as usize;
    let y_hi = ((h as f32 * HEADER_SCAN_BOTTOM_FRAC) as usize).min(h);
    let min_run = ((w as f32 * HEADER_MIN_RUN_FRAC) as usize).max(HEADER_MIN_RUN_PX);
    /// One scan-row hit: (bar y, green span, red span), spans end-exclusive.
    type HeaderHit = (usize, (usize, usize), (usize, usize));
    let mut run: Vec<HeaderHit> = Vec::new();
    // Best thick run so far, owned (NOT borrowed from `run` — the borrow
    // would fight the `run = Vec::new()` reset below).
    let mut best: Option<Vec<HeaderHit>> = None;
    let mut best_area = 0usize;
    let flush =
        |run: &mut Vec<HeaderHit>, best: &mut Option<Vec<HeaderHit>>, best_area: &mut usize| {
            if run.len() >= HEADER_MIN_ROWS {
                let area: usize = run.iter().map(|(_, g, r)| (g.1 - g.0) + (r.1 - r.0)).sum();
                if area > *best_area {
                    *best_area = area;
                    *best = Some(std::mem::take(run));
                }
            }
            run.clear();
        };
    for y in y_lo..y_hi {
        let hit = longest_run_span(&px, w, y, is_header_green)
            .filter(|g| g.1 - g.0 >= min_run)
            .and_then(|g| {
                longest_run_span(&px, w, y, is_header_red)
                    .filter(|r| r.1 - r.0 >= min_run)
                    .map(|r| (y, g, r))
            });
        match hit {
            Some(h) => run.push(h),
            None => flush(&mut run, &mut best, &mut best_area),
        }
    }
    flush(&mut run, &mut best, &mut best_area);
    // Anchor row = the run's first row; spans = widest green/red extents
    // across the run (caption text punches holes into individual rows).
    let run = best?;
    let hy = run[0].0;
    let (gx0, gx1) = run.iter().fold((usize::MAX, 0), |(s, e), (_, g, _)| {
        (s.min(g.0), e.max(g.1))
    });
    let (rx0, rx1) = run.iter().fold((usize::MAX, 0), |(s, e), (_, _, r)| {
        (s.min(r.0), e.max(r.1))
    });

    // ── 2. Header height: scan down from the bar top; a row stays "header"
    //    while ≥2 of 6 sample points across both bars read bar color or the
    //    white bar captions punched into them ─────────────────────────────
    let samples = [
        gx0 + (gx1 - gx0) / 4,
        gx0 + (gx1 - gx0) / 2,
        gx0 + (gx1 - gx0) * 3 / 4,
        rx0 + (rx1 - rx0) / 4,
        rx0 + (rx1 - rx0) / 2,
        rx0 + (rx1 - rx0) * 3 / 4,
    ];
    // Continuation checks the BAR colors only — counting white here would
    // let the scan bleed into the first player-name row sitting right
    // under the bar whenever a sample lands inside the name text.
    let is_bar_color = |x: usize, y: usize| -> bool {
        let (r, g, b) = rgb(x, y);
        is_header_green(r, g, b) || is_header_red(r, g, b)
    };
    let mut hh = 0usize;
    let mut miss = 0usize;
    for y in hy..((hy + h / 6).min(h)) {
        if samples.iter().filter(|&&x| is_bar_color(x, y)).count() >= 2 {
            hh = y - hy + 1;
            miss = 0;
        } else {
            miss += 1;
            if miss >= 2 {
                break;
            }
        }
    }
    let hh = hh.clamp(HEADER_MIN_H, (h / 10).max(HEADER_MIN_H));

    // ── 3. Player rows: white-name density bands below the header ────────
    // The density profile is computed over a generous window, but bands are
    // first extracted from the conservative one — only when the arena hint
    // asks for more rows than were found does the window grow (by the
    // observed pitch) and the extraction run again.
    let prof_top = (hy + hh).min(h);
    let prof_cap = (prof_top + (h as f32 * ROW_SCAN_MAX_SPAN_FRAC) as usize).min(h);
    let mut profile = vec![0u32; prof_cap.saturating_sub(prof_top)];
    for (dy, slot) in profile.iter_mut().enumerate() {
        let y = prof_top + dy;
        let mut n = 0u32;
        for x in gx0..gx1 {
            let (r, g, b) = rgb(x, y);
            if is_text_white(r, g, b) {
                n += 1;
            }
        }
        for x in rx0..rx1 {
            let (r, g, b) = rgb(x, y);
            if is_text_white(r, g, b) {
                n += 1;
            }
        }
        *slot = n;
    }
    let prof_max = *profile.iter().max().unwrap_or(&0);
    if prof_max == 0 {
        return None;
    }
    let thr = prof_max as f32 * ROW_TEXT_FRACTION;
    let extract_bands = |bot: usize| -> Vec<f32> {
        let end = bot.saturating_sub(prof_top).min(profile.len());
        let mut out: Vec<f32> = Vec::new();
        let mut band_start: Option<usize> = None;
        for (dy, &v) in profile[..end].iter().enumerate() {
            if v as f32 > thr {
                if band_start.is_none() {
                    band_start = Some(dy);
                }
            } else if let Some(s) = band_start.take() {
                if dy - s >= ROW_BAND_MIN_H {
                    out.push(prof_top as f32 + (s + dy - 1) as f32 / 2.0);
                }
            }
        }
        if let Some(s) = band_start {
            if profile.len() - s >= ROW_BAND_MIN_H {
                out.push(prof_top as f32 + (s + profile.len() - 1) as f32 / 2.0);
            }
        }
        out
    };
    let win1 = (prof_top + (h as f32 * ROW_SCAN_WINDOW_FRAC) as usize).min(prof_cap);
    let mut centers = extract_bands(win1);
    if expected_players > centers.len() && centers.len() >= 2 {
        let mut diffs: Vec<f32> = centers.windows(2).map(|p| p[1] - p[0]).collect();
        diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pitch0 = diffs[diffs.len() / 2];
        let need_bot = (*centers.last().unwrap()
            + (expected_players - centers.len() + 1) as f32 * pitch0 * 1.25)
            as usize;
        centers = extract_bands(need_bot.min(prof_cap));
    }
    if centers.len() < 2 {
        return None;
    }

    // Median pitch from the observed bands (robust against an occluded row).
    let mut diffs: Vec<f32> = centers.windows(2).map(|p| p[1] - p[0]).collect();
    diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pitch = diffs[diffs.len() / 2];
    if !(MIN_PITCH..=MAX_PITCH).contains(&pitch) {
        return None;
    }

    // ── 4. Cross-check against the arena hint, extend/trim to it ─────────
    if expected_players > 0 {
        if centers.len() + ROW_COUNT_TOLERANCE < expected_players
            || centers.len() > expected_players + ROW_COUNT_TOLERANCE
        {
            return None;
        }
        // Spurious extra bands (our own hint box, HUD text) accumulate toward
        // the bottom — drop from there; occluded real rows are extended
        // downward with the median pitch.
        while centers.len() > expected_players {
            centers.pop();
        }
        let mut last = *centers.last().unwrap();
        while centers.len() < expected_players {
            last += pitch;
            centers.push(last);
        }
    } else if centers.len() < 3 {
        return None;
    }

    // ── 5. Rectangle + team split, back to physical px ────────────────────
    let last = *centers.last().unwrap();
    let y1w = ((last + pitch * 0.75).min(h as f32 - 1.0)) as usize;
    let split_raw =
        ((gx1 + rx0) as f32 * 0.5 - gx0 as f32) / (rx1.saturating_sub(gx0)).max(1) as f32;
    let team_split = if (0.30..=0.70).contains(&split_raw) {
        split_raw
    } else {
        0.5
    };
    let to_phys = |v: usize| (v as f32 * scale as f32).round() as i32;
    Some(DetectedRoster {
        rect: Rect {
            x: to_phys(gx0),
            y: to_phys(hy),
            width: to_phys(rx1.saturating_sub(gx0)),
            height: to_phys(y1w.saturating_sub(hy)),
        },
        row_centers: centers
            .iter()
            .map(|&c| (c * scale as f32).round() as i32)
            .collect(),
        team_split,
    })
}

/// Box-filter downscale to an RGB working image (alpha dropped, opaque).
fn downscale_rgba(rgba: &[u8], width: u32, height: u32, scale: u32) -> (Vec<u8>, usize, usize) {
    let w = (width / scale) as usize;
    let h = (height / scale) as usize;
    let mut out = vec![0u8; w * h * 3];
    let n = scale * scale;
    let sw = scale as usize;
    let fw = width as usize;
    for y in 0..h {
        for x in 0..w {
            let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
            for dy in 0..sw {
                for dx in 0..sw {
                    let i = ((y * sw + dy) * fw + x * sw + dx) * 4;
                    if i + 2 < rgba.len() {
                        sr += rgba[i] as u32;
                        sg += rgba[i + 1] as u32;
                        sb += rgba[i + 2] as u32;
                    }
                }
            }
            let o = (y * w + x) * 3;
            out[o] = (sr / n).min(255) as u8;
            out[o + 1] = (sg / n).min(255) as u8;
            out[o + 2] = (sb / n).min(255) as u8;
        }
    }
    (out, w, h)
}

/// Longest contiguous run of pixels matching `matches` on scan row `y` →
/// `(start, end)` with end exclusive, or None when nothing matches.
fn longest_run_span(
    px: &[u8],
    w: usize,
    y: usize,
    matches: impl Fn(i16, i16, i16) -> bool,
) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut start: Option<usize> = None;
    for x in 0..w {
        let i = (y * w + x) * 3;
        let hit = i + 2 < px.len() && matches(px[i] as i16, px[i + 1] as i16, px[i + 2] as i16);
        if hit {
            if start.is_none() {
                start = Some(x);
            }
        } else if let Some(s) = start.take() {
            if best.is_none_or(|(bs, be)| x - s > be - bs) {
                best = Some((s, x));
            }
        }
    }
    if let Some(s) = start {
        if best.is_none_or(|(bs, be)| w - s > be - bs) {
            best = Some((s, w));
        }
    }
    best
}

/// Vanilla team-header green: TEAL (blue sits at/near green) and clearly
/// green-dominant over red. Measured rgb(81,148,140); also survives the
/// Tab-dim. Water is blue-dominant (b > g) and stays excluded.
fn is_header_green(r: i16, g: i16, b: i16) -> bool {
    g >= r + 25 && g >= 75 && b >= g - 45 && b <= g + 25
}

/// Vanilla team-header red: muted brick rgb(167,121,114) — red-dominant but
/// nowhere near a pure red.
fn is_header_red(r: i16, g: i16, b: i16) -> bool {
    r >= g + 25 && r >= 110 && r >= b + 20
}

/// Near-white, low-saturation pixel (player names, bar captions).
fn is_text_white(r: i16, g: i16, b: i16) -> bool {
    r.min(g).min(b) >= 170 && r.max(g).max(b) - r.min(g).min(b) <= 60
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-noise (xorshift-ish) so tests are reproducible.
    struct Noise(u32);
    impl Noise {
        fn next_f32(&mut self, lo: f32, hi: f32) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            lo + (self.0 as f32 / u32::MAX as f32) * (hi - lo)
        }
    }

    const TEAL: (u8, u8, u8) = (81, 148, 140);
    const BRICK: (u8, u8, u8) = (167, 121, 114);

    /// Bright noisy scene with a vanilla-style Tab table: teal/brick header
    /// bars over each half and white name text on every player row.
    /// Geometry mirrors the real client (~47% × table around 22% from top).
    /// Returns the frame plus the table rect in physical px.
    fn synth_header_table(w: u32, h: u32, rows: usize) -> (Vec<u8>, Rect, Vec<f32>) {
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut noise = Noise(0x1234_5678);
        for y in 0..h {
            for x in 0..w {
                let l = noise.next_f32(125.0, 175.0) as u8;
                let i = ((y * w + x) * 4) as usize;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        let tx = (w as f32 * 0.26) as u32;
        let tw = (w as f32 * 0.47) as u32;
        let ty = (h as f32 * 0.22) as u32;
        let seam = tx + tw / 2;
        let bar_h = (h as f32 * 0.028) as u32; // ≈ header bar height
        let pitch = ((h as f32 * 0.35) as u32 / rows.max(1) as u32).max(16);
        let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
            let i = ((y * w + x) * 4) as usize;
            img[i] = c.0;
            img[i + 1] = c.1;
            img[i + 2] = c.2;
            img[i + 3] = 255;
        };
        let text_w = tw * 28 / 100;
        // Header bars (white caption text punched into the middle). Skipped
        // for the rows==0 frame so that test exercises a bar-less scene.
        if rows > 0 {
            for y in ty..ty + bar_h {
                for x in tx..seam - 3 {
                    put(&mut img, x, y, TEAL);
                }
                for x in seam + 3..tx + tw {
                    put(&mut img, x, y, BRICK);
                }
            }
            for y in ty + 2..ty + bar_h - 2 {
                for x in tx + tw / 6..tx + tw / 6 + text_w / 3 {
                    put(&mut img, x, y, (245, 245, 245));
                }
                for x in seam + tw / 6..seam + tw / 6 + text_w / 3 {
                    put(&mut img, x, y, (245, 245, 245));
                }
            }
        }
        // Player rows: white name text per row on both halves.
        let mut centers = Vec::new();
        for k in 0..rows {
            let yc = ty as f32 + bar_h as f32 + pitch as f32 * (k as f32 + 0.5);
            centers.push(yc);
            let y0 = yc as u32;
            for y in y0..(y0 + 8).min(ty + bar_h + pitch * (k as u32 + 1)) {
                for x in tx + 8..tx + 8 + text_w {
                    put(&mut img, x, y, (240, 240, 240));
                }
                for x in seam + 8..seam + 8 + text_w {
                    put(&mut img, x, y, (240, 240, 240));
                }
            }
        }
        let rect = Rect {
            x: tx as i32,
            y: ty as i32,
            width: tw as i32,
            height: (ty + bar_h + pitch * rows as u32 - ty) as i32,
        };
        (img, rect, centers)
    }

    #[test]
    fn detects_header_anchored_table_12v12() {
        let (w, h) = (1280u32, 720u32);
        let (img, rect, centers) = synth_header_table(w, h, 12);
        let det = detect_roster(&img, w, h, 12).expect("table must be detected");
        assert_eq!(det.row_centers.len(), 12, "one center per row");
        assert!((det.rect.x - rect.x).abs() <= 12, "x: {rect:?} vs {det:?}");
        assert!((det.rect.y - rect.y).abs() <= 12, "y: {rect:?} vs {det:?}");
        assert!(
            (det.rect.width - rect.width).abs() <= 24,
            "w: {rect:?} vs {det:?}"
        );
        for (k, &c) in det.row_centers.iter().enumerate() {
            let truth = centers[k];
            assert!(
                (c as f32 - truth).abs() <= 8.0,
                "row {k}: center {c} vs truth {truth}"
            );
        }
        assert!(
            (det.team_split - 0.5).abs() <= 0.06,
            "split: {}",
            det.team_split
        );
    }

    #[test]
    fn detects_header_anchored_table_6v6() {
        let (w, h) = (1280u32, 720u32);
        let (img, _rect, centers) = synth_header_table(w, h, 6);
        let det = detect_roster(&img, w, h, 6).expect("table must be detected");
        assert_eq!(det.row_centers.len(), 6);
        for (k, &c) in det.row_centers.iter().enumerate() {
            assert!((c as f32 - centers[k]).abs() <= 8.0, "row {k}: {c}");
        }
    }

    #[test]
    fn extends_occluded_rows_to_expected() {
        // Draw 5 rows, hide the text of the bottom two (in-battle an HUD /
        // our own hint box can cover them): the missing rows must be
        // extended with the median pitch, keeping chip mapping complete.
        let (w, h) = (1280u32, 720u32);
        let (mut img, _rect, centers) = synth_header_table(w, h, 5);
        // Paint scene noise over the bottom-two rows' text (both halves).
        let mut noise = Noise(0xfeed_beef);
        for yc in &centers[3..] {
            for y in (*yc as u32).saturating_sub(6)..*yc as u32 + 8 {
                for x in (w * 26 / 100)..(w * 26 / 100 + w * 47 / 100) {
                    let l = noise.next_f32(125.0, 175.0) as u8;
                    let i = ((y * w + x) * 4) as usize;
                    img[i] = l;
                    img[i + 1] = l;
                    img[i + 2] = l;
                }
            }
        }
        let det = detect_roster(&img, w, h, 5).expect("partial table must still anchor");
        assert_eq!(det.row_centers.len(), 5, "extended to the arena hint");
        for (k, &c) in det.row_centers.iter().enumerate() {
            assert!(
                (c as f32 - centers[k]).abs() <= 10.0,
                "row {k}: {c} vs {}",
                centers[k]
            );
        }
    }

    /// The REAL captured frame behind the original bug report (bright map,
    /// Tab-dimmed, translucent light table, teal/brick headers). Downscaled
    /// to the detector's 800-wide working size from a 3072×1920 capture.
    #[test]
    fn detects_real_captured_frame() {
        let png = include_bytes!("testdata/tab_table_768x480.png");
        let img = image::load_from_memory(png)
            .expect("fixture decodes")
            .to_rgba8();
        let (w, h) = img.dimensions();
        assert_eq!((w, h), (768, 480));
        let rgba = img.into_raw();
        let det = detect_roster(&rgba, w, h, 5).expect("real table must be detected");
        assert_eq!(det.row_centers.len(), 5, "occluded rows extended");
        // Truth (physical px of the source capture ÷ 4): header top 444→111,
        // bars 796..2274 → 199..568.5, row centers ≈ 531/583/635/687/739 ÷ 4.
        let truth: [f32; 5] = [132.75, 145.75, 158.75, 171.75, 184.75];
        for (k, &c) in det.row_centers.iter().enumerate() {
            assert!(
                (c as f32 - truth[k]).abs() <= 8.0,
                "row {k}: {c} vs {}",
                truth[k]
            );
        }
        assert!(
            (det.rect.x as f32 - 199.0).abs() <= 8.0,
            "x: {:?}",
            det.rect
        );
        assert!(
            (det.rect.y as f32 - 111.0).abs() <= 8.0,
            "y: {:?}",
            det.rect
        );
        assert!(
            (det.team_split - 0.5).abs() <= 0.04,
            "split: {}",
            det.team_split
        );
    }

    #[test]
    fn returns_none_without_header_bars() {
        // Bright scene, no table → no teal+brick pair anywhere.
        let (w, h) = (1280u32, 720u32);
        let (img, _, _) = synth_header_table(w, h, 0);
        assert!(detect_roster(&img, w, h, 12).is_none());
    }

    #[test]
    fn returns_none_when_only_one_bar_matches() {
        // Green bar without its red twin (e.g. a green horizon band) must
        // not anchor anything.
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut noise = Noise(0x0b1e_5eed);
        for y in 0..h {
            for x in 0..w {
                let l = noise.next_f32(125.0, 175.0) as u8;
                let i = ((y * w + x) * 4) as usize;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        for y in (h * 22 / 100)..(h * 22 / 100 + 14) {
            for x in (w * 26 / 100)..(w * 50 / 100) {
                let i = ((y * w + x) * 4) as usize;
                img[i] = TEAL.0;
                img[i + 1] = TEAL.1;
                img[i + 2] = TEAL.2;
            }
        }
        assert!(detect_roster(&img, w, h, 5).is_none());
    }

    #[test]
    fn rejects_row_count_mismatch() {
        // 6 drawn rows but the arena says 12 → far fewer text bands than
        // players → None (caller falls back to the default anchor).
        let (w, h) = (1280u32, 720u32);
        let (img, _, _) = synth_header_table(w, h, 6);
        assert!(detect_roster(&img, w, h, 12).is_none());
    }

    #[test]
    fn works_without_arena_hint() {
        // Without the arena hint the detector keeps its conservative scan
        // window: a tall 12-row table yields the rows that fit it (always
        // ≥3, the TOP rows, in order) — real flows always pass the hint.
        let (w, h) = (1280u32, 720u32);
        let (img, _, centers) = synth_header_table(w, h, 12);
        let det = detect_roster(&img, w, h, 0).expect("detect without hint");
        assert!(det.row_centers.len() >= 3, "rows: {det:?}");
        for (k, &c) in det.row_centers.iter().enumerate() {
            assert!((c as f32 - centers[k]).abs() <= 8.0, "row {k}: {c}");
        }
    }

    #[test]
    fn battle_scene_detected_on_synthetic_hud() {
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut noise = Noise(0xabc0_ffee);
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let l = noise.next_f32(125.0, 175.0) as u8;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
            let i = ((y * w + x) * 4) as usize;
            img[i] = c.0;
            img[i + 1] = c.1;
            img[i + 2] = c.2;
            img[i + 3] = 255;
        };
        // Bottom-left HP bar: bright green, ~300x12 (real: y ≈ 78%).
        for y in 655..668 {
            for x in 60..360 {
                put(&mut img, x, y, (50, 220, 110));
            }
        }
        // Ship-icon blobs scattered across the top band (fuzzy: exact
        // positions differ per mode; these mimic light silhouettes
        // ~30x10 px at assorted spots).
        for (bx, by) in [
            (300u32, 110u32),
            (520, 150),
            (760, 95),
            (980, 170),
            (1240, 120),
            (1500, 205),
        ] {
            for y in by..by + 10 {
                for x in bx..bx + 30 {
                    put(&mut img, x, y, (210, 214, 218));
                }
            }
        }
        assert!(detect_battle_scene(&img, w, h));
    }

    /// The Tab DIM matters: while the table is open the whole scene (HP bar
    /// included) is darkened to ≈ rgb(28,68,56) — the probe must still see
    /// it, and bluish water must not.
    #[test]
    fn hp_bar_probe_survives_the_tab_dim() {
        let dimmed = (28u8, 68u8, 56u8);
        let (r, g, b) = (dimmed.0 as i16, dimmed.1 as i16, dimmed.2 as i16);
        assert!(is_probe_green(r, g, b), "dimmed HP bar must match");
        let water = (40i16, 80i16, 110i16);
        assert!(!is_probe_green(water.0, water.1, water.2), "water must not");
    }

    #[test]
    fn battle_scene_rejected_without_hud() {
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut noise = Noise(0xdead_f00d);
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let l = noise.next_f32(125.0, 175.0) as u8;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        // Plain bright scene (port / loading) — no HUD anywhere.
        assert!(!detect_battle_scene(&img, w, h));

        // HP bar alone (no scoreboard) is not enough either.
        for y in 655..668 {
            for x in 60..360 {
                let i = ((y * w + x) * 4) as usize;
                img[i] = 50;
                img[i + 1] = 220;
                img[i + 2] = 110;
            }
        }
        assert!(!detect_battle_scene(&img, w, h));
    }

    #[test]
    fn build_anchor_sizes_window_to_the_table_area() {
        let game = Rect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };
        let roster = Rect {
            x: 600,
            y: 300,
            width: 1200,
            height: 250,
        };
        let rows: Vec<i32> = (0..5).map(|i| 300 + 40 * i as i32 + 20).collect();
        let (overlay, anchor) = build_anchor(&game, &roster, rows.clone(), 0.5, false);
        assert!(!anchor.table_detected);
        // The overlay window covers ONLY the inflated table area...
        let pad = overlay_padding(&roster);
        assert_eq!(overlay.width, roster.width + 2 * pad);
        assert_eq!(overlay.height, roster.height + 2 * pad);
        assert_eq!(overlay.x, roster.x - pad);
        assert_eq!(overlay.y, roster.y - pad);
        // ...and the anchor coordinates are re-based to ITS origin.
        assert_eq!(anchor.overlay_rect.x, overlay.x);
        assert_eq!(anchor.overlay_rect.y, overlay.y);
        assert_eq!(anchor.overlay_rect.width, overlay.width);
        assert_eq!(anchor.overlay_rect.height, overlay.height);
        assert_eq!(anchor.roster_rect.x, pad);
        assert_eq!(anchor.roster_rect.y, pad);
        for (got, want) in anchor.row_centers.iter().zip(&rows) {
            // Re-based by dy = roster.y − pad (no clamping in this geometry).
            assert_eq!(*got, want - (roster.y - pad));
        }
    }

    #[test]
    fn fallback_roster_hugs_the_center() {
        let (rect, rows) = fallback_roster(2560, 1440, 5);
        assert_eq!(rows.len(), 5);
        assert!(rect.width <= 2560 * 55 / 100);
        assert!(rect.height <= 1440 * 30 / 100);
        for &c in &rows {
            assert!(c >= rect.y && c <= rect.y + rect.height);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Battle-scene gate
// ─────────────────────────────────────────────────────────────────────────

/// Sample stride over the capture (physical px) for the scene probe.
const SCENE_STEP: u32 = 4;
/// The HP bar is a long run of saturated green in the bottom-left corner.
/// Measured on a real 1080p client: it sits at ~78% of the frame height
/// (x ~3-15%), so the band spans well around it.
const HP_GREEN_MIN_RUN: u32 = 48;
/// Vanilla rosters render small light ship silhouettes across the top of
/// the screen. Detection is deliberately FUZZY and position-agnostic —
/// roster placement differs between PvP / scenarios / co-op — so any icon-
/// sized compact bright blob in the top band counts, wherever it sits.
/// The size bounds reject broad sky/cloud expanses (too wide) and thin
/// text strokes (too short).
const ICON_MIN_W: u32 = 12;
const ICON_MAX_W: u32 = 100;
const ICON_MIN_H: u32 = 4;
const ICON_MAX_H: u32 = 40;
/// Bright threshold for icon pixels (silhouettes are near-white).
const ICON_LUMA: u8 = 170;
/// A full roster stacks many icons (PvP 5v5 -> 10+; scenarios fewer); a
/// handful of ship-shaped blobs means a roster is on screen.
const ICONS_MIN: u32 = 5;

/// Green-dominance test for the HP bar, tolerant of the Tab dim: holding
/// Tab darkens the bar from ≈ rgb(50,220,110) to ≈ rgb(28,68,56), and its
/// vanilla hue is TEAL-ish (blue only slightly under green), so the old
/// `g > b + 25` test matched only the pre-dim frame. Bluish water (blue
/// over green) stays excluded.
fn is_probe_green(r: i16, g: i16, b: i16) -> bool {
    g > 55 && g >= r + 20 && g >= b - 10
}

/// True when the frame carries the in-battle HUD: the bottom-left health bar
/// plus the vanilla team rosters' ship silhouettes across the top.
/// None of these render outside the 3D scene — port, login and loading
/// screens all fail this probe — so it gates the whole overlay.
/// Components of the battle-HUD probe, logged on failure so real captures
/// can be tuned from the dev console alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SceneProbe {
    /// Long green run in the bottom-left corner (health bar).
    pub hp_bar: bool,
    /// Icon-sized bright blobs counted across the whole top band (ship
    /// silhouettes of the team rosters, any roster layout).
    pub icon_blobs: u32,
}

impl SceneProbe {
    pub(crate) fn detected(&self) -> bool {
        self.hp_bar && self.icon_blobs >= ICONS_MIN
    }
}

pub(crate) fn probe_battle_scene(rgba: &[u8], width: u32, height: u32) -> SceneProbe {
    let none = SceneProbe {
        hp_bar: false,
        icon_blobs: 0,
    };
    let px = |x: u32, y: u32| -> (u8, u8, u8) {
        let i = ((y * width + x) * 4) as usize;
        (rgba[i], rgba[i + 1], rgba[i + 2])
    };

    // ── HP bar: longest horizontal run of green in the bottom-left region ──
    let x0 = width * 2 / 100;
    let x1 = (width * 25 / 100).min(width.saturating_sub(1));
    let y0 = height * 70 / 100;
    let y1 = (height * 95 / 100).min(height.saturating_sub(1));
    let mut hp_found = false;
    if x1 > x0 && y1 > y0 {
        'outer: for y in (y0..y1).step_by(SCENE_STEP as usize) {
            let mut run = 0u32;
            let mut best = 0u32;
            for x in (x0..x1).step_by(SCENE_STEP as usize) {
                let (r, g, b) = px(x, y);
                if is_probe_green(r as i16, g as i16, b as i16) {
                    run += SCENE_STEP;
                    best = best.max(run);
                } else {
                    run = 0;
                }
            }
            if best >= HP_GREEN_MIN_RUN {
                hp_found = true;
                break 'outer;
            }
        }
    }
    if !hp_found {
        return none;
    }

    // ── Vanilla rosters: fuzzy ship-icon blobs across the whole top band ──
    // Position-agnostic on purpose: scenario / co-op modes place their
    // rosters differently from random battles, and mods may add their own
    // bars — none of that may break the probe.
    let icon_blobs = count_icon_blobs(
        &px,
        width * 2 / 100,
        (width * 98 / 100).min(width.saturating_sub(1)),
        height * 8 / 100,
        (height * 35 / 100).min(height.saturating_sub(1)),
    );
    SceneProbe {
        hp_bar: true,
        icon_blobs,
    }
}

/// Count compact bright blobs (ship silhouettes) in a region. A blob is a
/// set of bright horizontal runs on adjacent scan rows whose x-ranges
/// overlap; its size must fit the icon bounds, which rejects both broad
/// sky/cloud areas and thin text strokes.
fn count_icon_blobs(
    px: &impl Fn(u32, u32) -> (u8, u8, u8),
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
) -> u32 {
    if x1 <= x0 || y1 <= y0 {
        return 0;
    }
    // Collect bright runs per scan row: (y, x_start, x_end).
    let mut runs: Vec<(u32, u32, u32)> = Vec::new();
    for y in (y0..y1).step_by(SCENE_STEP as usize) {
        let mut cur: Option<(u32, u32)> = None;
        for x in (x0..x1).step_by(SCENE_STEP as usize) {
            let (r, g, b) = px(x, y);
            let luma = (u16::from(r) + u16::from(g) + u16::from(b)) / 3;
            if luma >= u16::from(ICON_LUMA) {
                cur = Some(match cur {
                    Some((s, _)) => (s, x),
                    None => (x, x),
                });
            } else if let Some((s, e)) = cur.take() {
                if e - s >= ICON_MIN_W && e - s <= ICON_MAX_W {
                    runs.push((y, s, e));
                }
            }
        }
        if let Some((s, e)) = cur.take() {
            if e - s >= ICON_MIN_W && e - s <= ICON_MAX_W {
                runs.push((y, s, e));
            }
        }
    }
    runs.sort_by_key(|&(y, xs, _)| (y, xs));

    // Greedy vertical clustering: adjacent rows with overlapping x-ranges
    // belong to the same blob.
    let mut blobs = 0u32;
    let mut open: Option<(u32, u32, u32, u32)> = None; // (y_last, x_min, x_max, y_first)
    for (y, xs, xe) in runs {
        open = match open {
            Some((yl, xmin, xmax, yfirst))
                if y - yl <= SCENE_STEP * 2 && xs <= xmax && xe >= xmin =>
            {
                Some((y, xmin.min(xs), xmax.max(xe), yfirst))
            },
            Some((yl, _xmin, _xmax, yfirst)) => {
                let h = yl - yfirst;
                if (ICON_MIN_H..=ICON_MAX_H).contains(&h) {
                    blobs += 1;
                }
                Some((y, xs, xe, y))
            },
            None => Some((y, xs, xe, y)),
        };
    }
    if let Some((yl, _xmin, _xmax, yfirst)) = open {
        let h = yl - yfirst;
        if (ICON_MIN_H..=ICON_MAX_H).contains(&h) {
            blobs += 1;
        }
    }
    blobs
}

/// Gate helper: the full HUD must be present.
pub(crate) fn detect_battle_scene(rgba: &[u8], width: u32, height: u32) -> bool {
    probe_battle_scene(rgba, width, height).detected()
}

// ─────────────────────────────────────────────────────────────────────────
// Anchor construction (pure — unit-testable without Win32)
// ─────────────────────────────────────────────────────────────────────────

/// Padding (physical px) added around the detected table when sizing the
/// overlay window; chips never render outside it.
pub(crate) fn overlay_padding(roster: &Rect) -> i32 {
    (roster.height / 8).clamp(24, 96)
}

/// Build the overlay-window anchor from a detection relative to the game
/// window: the overlay covers ONLY the table area (inflated by padding), and
/// every coordinate is re-based to the overlay window's origin. Returns the
/// anchor plus the overlay rect in SCREEN coordinates for window placement.
pub(crate) fn build_anchor(
    game_screen: &Rect,
    roster_rel: &Rect,
    mut row_centers: Vec<i32>,
    team_split: f32,
    table_detected: bool,
) -> (Rect, wowsp_tauri_shared::OverlayAnchor) {
    let pad = overlay_padding(roster_rel);
    // Overlay rect in screen px: the table area inflated by the padding,
    // clamped to stay inside the game window (multi-monitor safe — the game
    // rect is already monitor-clamped).
    let ox = (game_screen.x + roster_rel.x - pad).max(game_screen.x);
    let oy = (game_screen.y + roster_rel.y - pad).max(game_screen.y);
    let orx = game_screen.x + roster_rel.x + roster_rel.width + pad;
    let ory = game_screen.y + roster_rel.y + roster_rel.height + pad;
    let overlay = Rect {
        x: ox,
        y: oy,
        width: (orx - ox).min(game_screen.x + game_screen.width - ox),
        height: (ory - oy).min(game_screen.y + game_screen.height - oy),
    };
    // Re-base roster + rows to the overlay origin: overlay-relative =
    // game-relative − (overlay origin − game origin).
    let roster = Rect {
        x: roster_rel.x - (ox - game_screen.x),
        y: roster_rel.y - (oy - game_screen.y),
        width: roster_rel.width,
        height: roster_rel.height,
    };
    let dy = oy - game_screen.y;
    row_centers.iter_mut().for_each(|c| *c -= dy);
    let anchor = wowsp_tauri_shared::OverlayAnchor {
        game_rect: *game_screen,
        overlay_rect: overlay,
        roster_rect: roster,
        row_centers,
        team_split,
        table_detected,
    };
    (overlay, anchor)
}

/// Fallback table geometry when detection fails on a real capture: a
/// centered band matching the real client's proportions (~50% × 24% around
/// 24% from the top) with rows spread per the expected team size. Way
/// tighter than the old full-spread default, so even the fallback hugs the
/// middle of the screen.
pub(crate) fn fallback_roster(frame_w: i32, frame_h: i32, expected: usize) -> (Rect, Vec<i32>) {
    let width = frame_w * 50 / 100;
    let height =
        (frame_h * 8 / 100).max((expected as i32 * frame_h * 5 / 100).max(frame_h * 16 / 100));
    let x = (frame_w - width) / 2;
    let y = frame_h * 24 / 100;
    let top = y + height / 6;
    let bottom = y + height * 95 / 100;
    let step = (bottom - top) / expected.max(1) as i32;
    let rows = (0..expected)
        .map(|i| top + step * i as i32 + step / 2)
        .collect();
    (
        Rect {
            x,
            y,
            width,
            height,
        },
        rows,
    )
}
