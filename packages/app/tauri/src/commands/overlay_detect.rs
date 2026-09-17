//! Team-list (roster) region detector for the in-game overlay (Mode 2 / M8).
//!
//! Pure image analysis over an RGBA screenshot of the game window — no Win32
//! types in here, so the whole pipeline is unit-testable against synthetic
//! frames (see the tests at the bottom).
//!
//! The WoWS team list (the Tab view) is a wide, dark, translucent panel drawn
//! over the 3D scene, with evenly pitched horizontal separators between player
//! rows. The detector exploits exactly those two cues:
//!
//!   1. row / column dark-fraction projections → the panel rectangle, plus a
//!      "darker than its surroundings" guard against dark night maps;
//!   2. row-wise vertical-gradient energy → separator peaks → row pitch by
//!      autocorrelation → phase-aligned row centers;
//!   3. a smoothed column-luminance minimum near the middle → the
//!      allies / enemies column split.
//!
//! Every tunable is a named constant. They were calibrated against synthetic
//! frames; real captures can be dumped with `WOWSP_DEBUG_CAPTURE` (see
//! overlay.rs) to refine them.

use wowsp_tauri_shared::Rect;

/// Downscaled working width — caps the analysis cost on QHD/4K captures.
const MAX_WORK_WIDTH: u32 = 800;
/// Luminance below which a pixel counts as "dark" (the panel background).
const DARK_LUMA: u8 = 96;
/// Fraction of dark pixels a row needs (over the full capture width) to count
/// as a panel row. The real Tab table spans only ~47% of the screen width and
/// its ship-silhouette column is bright, so player rows measure ~0.35 — the
/// threshold must stay well below that (the night-map guard rejects dark
/// scenes, so low here is safe).
const ROW_DARK_FRAC: f32 = 0.30;
/// Same for columns, measured over the scanned rows.
const COL_DARK_FRAC: f32 = 0.60;
/// Row gap (fraction of capture height) tolerated while growing the panel
/// band — the bright green/red team-header bars are ~2.5% of the height.
const ROW_GAP_FRAC: f32 = 0.04;
/// Column gap (fraction of capture width) bridged while growing the column
/// band — the bright ship-silhouette column (~8% of the frame width) and the
/// thin central seam punch holes into an otherwise contiguous table band.
const COL_GAP_FRAC: f32 = 0.09;
/// The panel must be at most this fraction of the mean luminance of the scene
/// strips directly above and below it (night-map guard).
const PANEL_CONTRAST_RATIO: f32 = 0.80;
/// Row-pitch search range at working (downscaled) resolution.
const MIN_PITCH: usize = 8;
const MAX_PITCH: usize = 64;
/// Minimum plausible panel share of the capture (the real table is ~47% of
/// the width and ~16% of the height on a 1080p client; 5v5 can dip lower).
const MIN_WIDTH_FRAC: f32 = 0.20;
const MIN_HEIGHT_FRAC: f32 = 0.10;
/// Maximum plausible panel share (a band covering ~everything is a dark
/// scene, not a table).
const MAX_WIDTH_FRAC: f32 = 0.98;
const MAX_HEIGHT_FRAC: f32 = 0.95;

/// Detector output: everything needed to anchor the overlay chips, in
/// physical pixels relative to the capture (game window) origin.
#[derive(Debug, Clone)]
pub(crate) struct DetectedRoster {
    /// The team-list panel rectangle.
    pub rect: Rect,
    /// Vertical center of each mapped player row, top to bottom. Header rows
    /// detected above the first player row are trimmed away (see
    /// [`TRIM_TO_EXPECTED`]); length ≤ `expected_players` when that hint is
    /// available.
    pub row_centers: Vec<i32>,
    /// Allies/enemies column split as a fraction (0–1) of the rect width.
    pub team_split: f32,
}

/// Detect the team-list panel and its row grid in an RGBA frame.
///
/// `expected_players` is the per-team player count from `tempArenaInfo.json`
/// (0 = unknown). It is used to trim detected header rows off the top and to
/// sanity-check the row count; passing 0 keeps the detector permissive.
pub(crate) fn detect_roster(
    rgba: &[u8],
    width: u32,
    height: u32,
    expected_players: usize,
) -> Option<DetectedRoster> {
    let scale = width.div_ceil(MAX_WORK_WIDTH).max(1);
    let (lum, w, h) = downscale_luma(rgba, width, height, scale);
    if w < 32 || h < 32 {
        return None;
    }

    // ── Pass 1: row band over the full width ─────────────────────────────
    let row_dark = dark_fractions_rows(&lum, w, h, 0, w);
    let (mut y0, mut y1) =
        longest_band(&row_dark, ROW_DARK_FRAC, (h as f32 * ROW_GAP_FRAC) as usize)?;
    if !band_is_plausible(y1 - y0, h, MIN_HEIGHT_FRAC, MAX_HEIGHT_FRAC) {
        return None;
    }

    // ── Pass 2: column band within the row band (prefer one covering the
    //    horizontal center — HUD panels hug the screen edges) ─────────────
    let col_dark = dark_fractions_cols(&lum, w, y0, y1);
    let (x0, x1) = best_column_band(&col_dark)?;
    if !band_is_plausible(x1 - x0, w, MIN_WIDTH_FRAC, MAX_WIDTH_FRAC) {
        return None;
    }

    // ── Pass 3: tighten the row band over the column band only ───────────
    let row_dark2 = dark_fractions_rows(&lum, w, h, x0, x1);
    let (ty0, ty1) = longest_band(
        &row_dark2,
        ROW_DARK_FRAC,
        (h as f32 * ROW_GAP_FRAC) as usize,
    )?;
    if band_is_plausible(ty1 - ty0, h, MIN_HEIGHT_FRAC, MAX_HEIGHT_FRAC) {
        y0 = ty0;
        y1 = ty1;
    }

    // Night-map guard: the panel must be clearly darker than the scene right
    // above and below it (same columns). Skipped when the band touches the
    // capture edge (no reference strip available).
    if !panel_is_contrasted(&lum, w, x0, x1, y0, y1) {
        return None;
    }

    // ── Row separators → pitch → phase-aligned row centers ────────────────
    let centers_work = detect_row_centers(&lum, w, x0, x1, y0, y1, expected_players);
    let centers_work = centers_work?;
    if centers_work.len() < 2 {
        return None;
    }

    // ── Team split: smoothed column-luminance minimum near the middle ─────
    let team_split = detect_team_split(&lum, w, x0, x1, y0, y1);

    let to_phys = |v: usize| (v as f32 * scale as f32).round() as i32;
    Some(DetectedRoster {
        rect: Rect {
            x: to_phys(x0),
            y: to_phys(y0),
            width: to_phys(x1 - x0),
            height: to_phys(y1 - y0),
        },
        row_centers: centers_work
            .iter()
            .map(|&c| (c * scale as f32).round() as i32)
            .collect(),
        team_split,
    })
}

/// Box-filter downscale to a grayscale luminance image.
fn downscale_luma(rgba: &[u8], width: u32, height: u32, scale: u32) -> (Vec<u8>, usize, usize) {
    let w = width / scale;
    let h = height / scale;
    let mut lum = vec![0u8; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            let mut n = 0u32;
            for dy in 0..scale {
                for dx in 0..scale {
                    let px = ((y * scale + dy) * width + x * scale + dx) as usize * 4;
                    if px + 2 < rgba.len() {
                        let r = rgba[px] as u32;
                        let g = rgba[px + 1] as u32;
                        let b = rgba[px + 2] as u32;
                        sum += (r * 299 + g * 587 + b * 114) / 1000;
                        n += 1;
                    }
                }
            }
            lum[(y * w + x) as usize] = (sum / n.max(1)).min(255) as u8;
        }
    }
    (lum, w as usize, h as usize)
}

/// Per-row dark-pixel fraction, over columns `[x0, x1)`.
fn dark_fractions_rows(lum: &[u8], w: usize, h: usize, x0: usize, x1: usize) -> Vec<f32> {
    let cols = (x1 - x0).max(1) as f32;
    (0..h)
        .map(|y| {
            let mut dark = 0u32;
            for x in x0..x1 {
                if lum[y * w + x] < DARK_LUMA {
                    dark += 1;
                }
            }
            dark as f32 / cols
        })
        .collect()
}

/// Per-column dark-pixel fraction, over rows `[y0, y1)`.
fn dark_fractions_cols(lum: &[u8], w: usize, y0: usize, y1: usize) -> Vec<f32> {
    let rows = (y1 - y0).max(1) as f32;
    (0..w)
        .map(|x| {
            let mut dark = 0u32;
            for y in y0..y1 {
                if lum[y * w + x] < DARK_LUMA {
                    dark += 1;
                }
            }
            dark as f32 / rows
        })
        .collect()
}

/// Longest run of values ≥ `threshold`, bridging gaps up to `max_gap`.
/// Returns `(start, end)` with end exclusive.
fn longest_band(vals: &[f32], threshold: f32, max_gap: usize) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut run_start: Option<usize> = None;
    let mut gap = 0usize;
    for (i, &v) in vals.iter().enumerate() {
        if v >= threshold {
            if run_start.is_none() {
                run_start = Some(i);
            }
            gap = 0;
        } else if run_start.is_some() {
            gap += 1;
            if gap > max_gap {
                let s = run_start.unwrap();
                // Compare band LENGTHS (end - start), never raw endpoints —
                // the previous band can end before this run starts.
                if best.is_none_or(|(bs, be)| i - gap + 1 - s > be - bs) {
                    best = Some((s, i - gap + 1));
                }
                run_start = None;
            }
        }
    }
    if let Some(s) = run_start {
        if best.is_none_or(|(bs, be)| vals.len() - s > be - bs) {
            best = Some((s, vals.len()));
        }
    }
    best
}

/// Among the column bands, prefer one covering the horizontal center whose
/// length is within 80% of the absolute longest — the team list is centered,
/// while HUD widgets (minimap, chat) hug the edges.
fn best_column_band(col_dark: &[f32]) -> Option<(usize, usize)> {
    fn flush(best: &mut Option<(usize, usize)>, s: usize, e: usize) {
        if best.is_none_or(|(bs, be)| e - s > be - bs) {
            *best = Some((s, e));
        }
    }
    // Bridge gaps up to ~5% of the width: the ship-silhouette column and the
    // thin seam between the two team sub-tables both punch bright holes into
    // an otherwise contiguous band.
    let max_gap = ((col_dark.len() as f32 * COL_GAP_FRAC) as usize).max(2);
    let longest = longest_band(col_dark, COL_DARK_FRAC, max_gap)?;
    let center = col_dark.len() / 2;
    if longest.0 <= center && center < longest.1 {
        return Some(longest);
    }
    // Scan bands again, keeping the best centered one.
    let mut best: Option<(usize, usize)> = None;
    let mut run_start: Option<usize> = None;
    let mut gap = 0usize;
    for (i, &v) in col_dark.iter().enumerate() {
        if v >= COL_DARK_FRAC {
            if run_start.is_none() {
                run_start = Some(i);
            }
            gap = 0;
        } else if run_start.is_some() {
            gap += 1;
            if gap > max_gap {
                let s = run_start.unwrap();
                flush(&mut best, s, i - gap + 1);
                run_start = None;
            }
        }
    }
    if let Some(s) = run_start {
        flush(&mut best, s, col_dark.len());
    }
    // Centered preference: keep a centered band at ≥80% of the longest.
    if let Some((s, e)) = best {
        if s <= center && center < e && e - s >= (longest.1 - longest.0) * 4 / 5 {
            return Some((s, e));
        }
    }
    Some(longest)
}

fn band_is_plausible(len: usize, total: usize, min_frac: f32, max_frac: f32) -> bool {
    let frac = len as f32 / total as f32;
    frac >= min_frac && frac <= max_frac
}

/// The panel must be clearly darker than the scene strips immediately above
/// and below it (same columns). Fails → this is a dark scene, not a table.
fn panel_is_contrasted(lum: &[u8], w: usize, x0: usize, x1: usize, y0: usize, y1: usize) -> bool {
    let strip = ((y1 - y0) / 6).clamp(4, 32);
    let mean = |ya: usize, yb: usize| -> Option<f32> {
        if ya >= yb {
            return None;
        }
        let mut sum = 0u64;
        let mut n = 0u64;
        for y in ya..yb {
            for x in x0..x1 {
                sum += lum[y * w + x] as u64;
                n += 1;
            }
        }
        if n == 0 {
            None
        } else {
            Some(sum as f32 / n as f32)
        }
    };
    let Some(inside) = mean(y0, y1) else {
        return false;
    };
    let above = mean(y0.saturating_sub(strip), y0);
    let below = mean(y1, (y1 + strip).min(lum.len() / w));
    let outside = match (above, below) {
        (Some(a), Some(b)) => (a + b) / 2.0,
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => return true, // band touches both edges — no reference
    };
    inside < outside * PANEL_CONTRAST_RATIO
}

/// Separator-line analysis: vertical-gradient energy per row → pitch via
/// autocorrelation → best phase → row centers (working resolution).
fn detect_row_centers(
    lum: &[u8],
    w: usize,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    expected_players: usize,
) -> Option<Vec<f32>> {
    let band_h = y1 - y0;
    if band_h < MIN_PITCH * 2 {
        return None;
    }
    // E[y] = Σ |L[y+1] − L[y]| over the panel columns (y relative to y0).
    // Scans through the band's LAST row too, so the panel's bottom border —
    // itself a separator — is not cut off at the band edge.
    let mut energy = vec![0f32; band_h];
    let h = lum.len() / w;
    for (yi, slot) in energy.iter_mut().enumerate() {
        let y = y0 + yi;
        if y + 1 >= h {
            break;
        }
        let mut e = 0u32;
        for x in x0..x1 {
            e += lum[y * w + x].abs_diff(lum[(y + 1) * w + x]) as u32;
        }
        *slot = e as f32;
    }

    // Pitch by autocorrelation, with harmonic resolution. With a fractional
    // true pitch (e.g. 18.46 px), integer-lag autocorrelation drifts out of
    // phase after a few rows, so the 2× harmonic can OUTSCORE the fundamental
    // (it drifts only half as fast). Resolve downwards: whenever half the
    // current lag still scores a substantial share, the true pitch is the
    // half and the current lag is a harmonic.
    let max_lag = MAX_PITCH.min(band_h / 2);
    if max_lag <= MIN_PITCH {
        return None;
    }
    let mut scores = vec![0f32; max_lag + 1];
    let mut best_score = 0f32;
    for lag in MIN_PITCH..=max_lag {
        let mut s = 0f32;
        for yi in 0..band_h - lag {
            s += energy[yi] * energy[yi + lag];
        }
        s /= (band_h - lag) as f32;
        scores[lag] = s;
        best_score = best_score.max(s);
    }
    let best_lag = (MIN_PITCH..=max_lag).max_by(|&a, &b| {
        scores[a]
            .partial_cmp(&scores[b])
            .unwrap_or(std::cmp::Ordering::Equal)
    })?;
    let mut auto_pitch = best_lag;
    while auto_pitch / 2 >= MIN_PITCH && scores[auto_pitch / 2] >= scores[auto_pitch] * 0.55 {
        auto_pitch /= 2;
    }

    // Candidate pitches. Plain autocorrelation is unreliable on SHORT bands:
    // a 5v5 roster yields a ~60-row band whose table-edge spikes can outscore
    // the ~12-row fundamental. When the arena hint gives the expected row
    // count, band/expected enters as a peer candidate and the better-scoring
    // one wins.
    let mut candidates = vec![auto_pitch];
    if expected_players >= 3 {
        let p = (band_h as f32 / expected_players as f32).round() as usize;
        if (MIN_PITCH..=max_lag).contains(&p) && p != auto_pitch {
            candidates.push(p);
        }
    }

    // Baseline-subtract (moving average over half the largest candidate) so
    // the phase score is driven by the separator peaks, not by luminance
    // drift.
    let half = candidates.iter().map(|&c| c / 2).max().unwrap_or(1).max(1);
    let base: Vec<f32> = (0..band_h)
        .map(|yi| {
            let lo = yi.saturating_sub(half);
            let hi = (yi + half).min(band_h);
            energy[lo..hi].iter().sum::<f32>() / (hi - lo) as f32
        })
        .collect();
    let norm: Vec<f32> = energy.iter().zip(&base).map(|(e, b)| e - b).collect();

    // Evaluate every candidate pitch at its best phase; keep the winner. A
    // period must repeat at least three times across the band — a two-line
    // grid is degenerate (it just pairs the band's truncation spikes).
    let mut pitch = candidates[0];
    let mut best_phase = 0usize;
    let mut best_phase_score = f32::MIN;
    for &cand in &candidates {
        for phase in 0..cand {
            let mut s = 0f32;
            let mut n = 0usize;
            let mut yi = phase;
            while yi < band_h {
                s += norm[yi];
                n += 1;
                yi += cand;
            }
            if n < 3 || s <= best_phase_score {
                continue;
            }
            best_phase_score = s;
            best_phase = phase;
            pitch = cand;
        }
    }

    // Peak-pick around each grid line so centers track the real separators
    // rather than the ideal grid. The window is ±2·pitch/5 — wide enough to
    // absorb the drift when the true pitch is fractional (autocorrelation
    // only tests integer lags), narrower than half a pitch so adjacent lines
    // never share a window.
    let win = (pitch * 2 / 5).max(1);
    let mut seps: Vec<usize> = Vec::new();
    let mut yi = best_phase;
    while yi < band_h {
        let lo = yi.saturating_sub(win);
        let hi = (yi + win).min(band_h);
        let (mut mi, mut mv) = (yi, norm[yi]);
        for (k, &v) in norm[lo..hi].iter().enumerate() {
            if v > mv {
                mv = v;
                mi = lo + k;
            }
        }
        if mv > 0.0 {
            seps.push(mi);
        }
        yi += pitch;
    }
    seps.sort_unstable();
    seps.dedup();

    // Rows = gaps between consecutive separators.
    let mut centers: Vec<f32> = seps
        .windows(2)
        .map(|pair| (pair[0] as f32 + pair[1] as f32) / 2.0)
        .collect();

    // Trim header rows off the top when the arena hint says there are fewer
    // players than detected rows (the table leads with a column-title row).
    if expected_players > 0 {
        while centers.len() > expected_players {
            centers.remove(0);
        }
        // Far fewer rows than players → misdetection; caller falls back.
        if centers.len() + 2 < expected_players {
            return None;
        }
    } else if centers.len() < 3 {
        return None;
    }

    // Back to capture-origin coordinates.
    Some(centers.into_iter().map(|c| c + y0 as f32).collect())
}

/// Allies/enemies split: the vertical seam between the two team sub-tables.
/// A seam (divider line / gap) is a column with unusually high vertical-edge
/// energy relative to the flat panel background, so we take the smoothed
/// column-gradient maximum in the middle ±10% of the panel. Falls back to
/// 0.5 when the middle is featureless (or the seam is off-center).
fn detect_team_split(lum: &[u8], w: usize, x0: usize, x1: usize, y0: usize, y1: usize) -> f32 {
    let cols = x1 - x0;
    if cols < 16 {
        return 0.5;
    }
    // Column-wise mean horizontal gradient over the body rows.
    let ya = y0 + 2;
    let yb = y1.saturating_sub(2);
    if yb <= ya {
        return 0.5;
    }
    let rows = (yb - ya) as f32;
    let mut grad = vec![0f32; cols - 1];
    for i in 0..cols - 1 {
        let mut sum = 0u32;
        for y in ya..yb {
            sum += lum[y * w + x0 + i].abs_diff(lum[y * w + x0 + i + 1]) as u32;
        }
        grad[i] = sum as f32 / rows;
    }
    // Smooth with a ~3%-width box filter.
    let radius = (cols / 33).max(2);
    let smooth: Vec<f32> = (0..grad.len())
        .map(|i| {
            let lo = i.saturating_sub(radius);
            let hi = (i + radius).min(grad.len());
            grad[lo..hi].iter().sum::<f32>() / (hi - lo) as f32
        })
        .collect();
    // Search the middle ±10% for the strongest seam.
    let lo = (cols as f32 * 0.40) as usize;
    let hi = ((cols as f32 * 0.60) as usize + 1).min(smooth.len());
    let (mut bi, mut bv) = (cols / 2, f32::MIN);
    for (i, &v) in smooth[lo..hi].iter().enumerate() {
        if v > bv {
            bv = v;
            bi = lo + i;
        }
    }
    // Featureless middle (flat gradient everywhere) → default split.
    let median = {
        let mut sorted = smooth.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        sorted[sorted.len() / 2]
    };
    if bv < median * 1.5 {
        return 0.5;
    }
    bi as f32 / cols as f32
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

    /// Paint an RGBA frame: bright noisy scene, optional dark panel with a
    /// header row + `rows` player rows separated by bright lines.
    fn synth(w: u32, h: u32, panel: Option<(u32, u32, u32, u32)>, player_rows: usize) -> Vec<u8> {
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut noise = Noise(0x1234_5678);
        let put = |img: &mut [u8], x: u32, y: u32, luma: u8| {
            let i = ((y * w + x) * 4) as usize;
            img[i] = luma.saturating_add(4);
            img[i + 1] = luma;
            img[i + 2] = luma.saturating_sub(4);
            img[i + 3] = 255;
        };
        for y in 0..h {
            for x in 0..w {
                let l = noise.next_f32(125.0, 175.0) as u8;
                put(&mut img, x, y, l);
            }
        }
        if let Some((px, py, pw, ph)) = panel {
            for y in py..py + ph {
                for x in px..px + pw {
                    put(&mut img, x, y, 42);
                }
            }
            // Header + player rows: separators between them, bright lines.
            let n = player_rows + 1;
            for k in 0..=n {
                let sy = py + (ph as usize * k / n) as u32;
                for x in px..px + pw {
                    for d in 0..2 {
                        if sy + d < py + ph {
                            put(&mut img, x, sy + d, 95);
                        }
                    }
                }
            }
            // Team seam: brighter vertical divider at the panel center.
            let seam = px + pw / 2;
            for y in py..py + ph {
                for d in 0..2 {
                    if seam + d < px + pw {
                        put(&mut img, seam + d, y, 90);
                    }
                }
            }
        }
        img
    }

    #[test]
    fn detects_centered_panel_12v12() {
        // 1920×1080, panel 960×720 at (480,150): header + 12 player rows.
        let img = synth(1920, 1080, Some((480, 150, 960, 720)), 12);
        let det = detect_roster(&img, 1920, 1080, 12).expect("panel must be detected");
        let r = det.rect;
        assert!((r.x - 480).abs() <= 9, "x: {r:?}");
        assert!((r.y - 150).abs() <= 9, "y: {r:?}");
        assert!((r.width - 960).abs() <= 18, "w: {r:?}");
        assert!((r.height - 720).abs() <= 18, "h: {r:?}");
        assert_eq!(det.row_centers.len(), 12, "header trimmed, 12 players");
        // True row k (0-based, after header): center = 150 + 720*(k+1.5)/13.
        for (k, &c) in det.row_centers.iter().enumerate() {
            let truth = 150.0 + 720.0 * (k as f32 + 1.5) / 13.0;
            assert!(
                (c as f32 - truth).abs() <= 8.0,
                "row {k}: center {c} vs truth {truth}"
            );
        }
        assert!(
            (det.team_split - 0.5).abs() <= 0.08,
            "split: {}",
            det.team_split
        );
    }

    #[test]
    fn detects_smaller_capture_6v6() {
        // 1280×720, panel 768×432 at (256,80): header + 6 player rows.
        let img = synth(1280, 720, Some((256, 80, 768, 432)), 6);
        let det = detect_roster(&img, 1280, 720, 6).expect("panel must be detected");
        assert_eq!(det.row_centers.len(), 6);
        let r = det.rect;
        assert!((r.x - 256).abs() <= 6, "x: {r:?}");
        assert!((r.width - 768).abs() <= 12, "w: {r:?}");
    }

    #[test]
    fn returns_none_without_panel() {
        let img = synth(1280, 720, None, 0);
        assert!(detect_roster(&img, 1280, 720, 12).is_none());
    }

    #[test]
    fn returns_none_on_uniformly_dark_scene() {
        // Same geometry but the whole frame is dark → contrast guard must
        // reject it (this is a night map, not a table).
        let mut img = synth(1280, 720, None, 0);
        for chunk in img.chunks_exact_mut(4) {
            chunk[0] = 38;
            chunk[1] = 40;
            chunk[2] = 42;
            chunk[3] = 255;
        }
        assert!(detect_roster(&img, 1280, 720, 12).is_none());
    }

    #[test]
    fn works_without_arena_hint() {
        let img = synth(1920, 1080, Some((480, 150, 960, 720)), 12);
        let det = detect_roster(&img, 1920, 1080, 0).expect("detect without hint");
        // No trim → header + 12 rows = 13 centers.
        assert_eq!(det.row_centers.len(), 13);
    }

    /// A frame mimicking the REAL WoWS Tab table: two sub-tables with a thin
    /// bright seam, bright green/red team-header bars, a bright ship-silhouette
    /// column in each sub-table, and bright separator lines — over a bright
    /// scene. The very shape that made the first calibration miss (row dark
    /// fraction ~0.35, table height ~16%) and fell back to the scattered
    /// default anchor.
    #[test]
    fn detects_realistic_wows_table() {
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        let mut noise = Noise(0xfeed_beef);
        let put = |img: &mut [u8], x: u32, y: u32, luma: u8| {
            let i = ((y * w + x) * 4) as usize;
            img[i] = luma.saturating_add(4);
            img[i + 1] = luma;
            img[i + 2] = luma.saturating_sub(4);
            img[i + 3] = 255;
        };
        for y in 0..h {
            for x in 0..w {
                let l = noise.next_f32(125.0, 175.0) as u8;
                put(&mut img, x, y, l);
            }
        }
        // Table geometry (fractions of the frame, matching the real client):
        let tx = (w as f32 * 0.26) as u32; // 333
        let tw = (w as f32 * 0.47) as u32; // 602
        let ty = (h as f32 * 0.22) as u32; // 158
        let th = (h as f32 * 0.17) as u32; // 122
        let seam = tx + tw / 2;
        let rows = 5usize;
        // Sub-table body (both halves), alternating slight shading.
        for y in ty..ty + th {
            for x in tx..tx + tw {
                let shade = if ((y - ty) / 12) % 2 == 0 { 46 } else { 58 };
                if x.abs_diff(seam) < 4 {
                    continue; // bright scene shows through the seam
                }
                put(&mut img, x, y, shade);
            }
        }
        // Bright green/red team-header bars on top of each half.
        for y in ty..ty + 10 {
            for x in tx..seam - 3 {
                put(&mut img, x, y, 150);
            }
            for x in seam + 3..tx + tw {
                put(&mut img, x, y, 150);
            }
        }
        // Bright ship-silhouette column in the middle of each sub-table.
        for y in ty + 12..ty + th {
            for x in (tx + tw / 8)..(tx + tw / 8 + tw / 6) {
                put(&mut img, x, y, 130);
            }
            for x in (seam + 4 + tw / 8)..(seam + 4 + tw / 8 + tw / 6) {
                if x < tx + tw {
                    put(&mut img, x, y, 130);
                }
            }
        }
        // 2px bright separators between rows (rows+1 lines incl. bottom).
        for k in 1..=rows {
            let sy = ty + 10 + ((th - 10) as usize * k / (rows + 1)) as u32;
            for x in tx..tx + tw {
                if x.abs_diff(seam) < 4 {
                    continue;
                }
                for d in 0..2 {
                    if sy + d < ty + th {
                        put(&mut img, x, sy + d, 110);
                    }
                }
            }
        }

        let det = detect_roster(&img, w, h, 5).expect("realistic table must be detected");
        let r = det.rect;
        assert!(
            (r.x as f32 - tx as f32).abs() <= w as f32 * 0.02,
            "x off: {r:?}"
        );
        assert!(
            (r.y as f32 - ty as f32).abs() <= h as f32 * 0.03,
            "y off: {r:?}"
        );
        assert_eq!(det.row_centers.len(), 5, "rows: {:?}", det.row_centers);
        // Row centers must sit INSIDE the table band (the fallback spread
        // would put them across 70% of the frame height).
        for &c in &det.row_centers {
            assert!(
                c >= ty as i32 && c <= (ty + th) as i32,
                "center {c} outside table {ty}..{}",
                ty + th
            );
        }
        assert!(
            (det.team_split - 0.5).abs() <= 0.08,
            "split {}",
            det.team_split
        );
    }

    #[test]
    fn rejects_row_count_mismatch() {
        // Panel drawn with 6 rows but the arena says 12 → far fewer rows than
        // players → None (caller falls back to the default anchor).
        let img = synth(1280, 720, Some((256, 80, 768, 432)), 6);
        assert!(detect_roster(&img, 1280, 720, 12).is_none());
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
        // Score bars per the real client: teal (friendly) x 27-43% and
        // orange (enemy) x 54-70%, both at y ≈ 8-11% — floating over the
        // sky, NO dark backing strip.
        for y in 58..90 {
            for x in 350..550 {
                put(&mut img, x, y, (57, 240, 200));
            }
            for x in 700..900 {
                put(&mut img, x, y, (245, 140, 26));
            }
        }
        assert!(detect_battle_scene(&img, w, h));
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
/// The scoreboard is TWO floating segmented bars over the sky — teal
/// (friendly, x ~27-44%, y ~8-11%) and orange (enemy, x ~54-70%) — with
/// white score text between them. No dark backing strip exists, so the
/// probe matches the bars themselves.
const SCORE_BAR_MIN_RUN: u32 = 32;

/// True when the frame carries the in-battle HUD: the bottom-left health bar
/// plus the top-center scoreboard strip with its teal/orange score bars.
/// None of these render outside the 3D scene — port, login and loading
/// screens all fail this probe — so it gates the whole overlay.
/// Components of the battle-HUD probe, logged on failure so real captures
/// can be tuned from the dev console alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SceneProbe {
    /// Long green run in the bottom-left corner (health bar).
    pub hp_bar: bool,
    /// Teal segmented bar top-center-left (friendly score/damage).
    pub teal_bar: bool,
    /// Orange segmented bar top-center-right (enemy score/damage).
    pub orange_bar: bool,
}

impl SceneProbe {
    pub(crate) fn detected(&self) -> bool {
        self.hp_bar && self.teal_bar && self.orange_bar
    }
}

pub(crate) fn probe_battle_scene(rgba: &[u8], width: u32, height: u32) -> SceneProbe {
    let none = SceneProbe {
        hp_bar: false,
        teal_bar: false,
        orange_bar: false,
    };
    let px = |x: u32, y: u32| -> (u8, u8, u8) {
        let i = ((y * width + x) * 4) as usize;
        (rgba[i], rgba[i + 1], rgba[i + 2])
    };
    let is_green =
        |c: (u8, u8, u8)| c.1 > 90 && c.1 as u16 > c.0 as u16 + 25 && c.1 as u16 > c.2 as u16 + 25;

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
                if is_green(px(x, y)) {
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

    // ── Score bars: teal (friendly) left of the score, orange (enemy) right.
    // Both sit in a narrow band around 8-12% of the frame height; both are
    // ALWAYS present together in battle, so requiring both keeps false
    // positives (single-sided teal UI accents) out.
    let sy0 = height * 4 / 100;
    let sy1 = (height * 16 / 100).min(height);
    if sy1 <= sy0 {
        return SceneProbe {
            hp_bar: true,
            ..none
        };
    }
    let teal_found = colored_run(
        &px,
        width * 25 / 100,
        width * 48 / 100,
        sy0,
        sy1,
        // Teal/cyan family: green AND blue clearly above red (the real bar
        // is #39F0C8-like, so g ≈ b — do NOT require g ≥ b + 15).
        |(r, g, b)| g > 120 && b > 90 && g as u16 > r as u16 + 30 && b as u16 > r as u16 + 20,
    );
    let orange_found = colored_run(
        &px,
        width * 52 / 100,
        width * 75 / 100,
        sy0,
        sy1,
        |(r, g, _b)| r > 110 && r as u16 > g as u16 + 40,
    );
    SceneProbe {
        hp_bar: true,
        teal_bar: teal_found,
        orange_bar: orange_found,
    }
}

/// Gate helper: the full HUD must be present.
pub(crate) fn detect_battle_scene(rgba: &[u8], width: u32, height: u32) -> bool {
    probe_battle_scene(rgba, width, height).detected()
}

/// Longest horizontal run of pixels passing `pred` in the region; true when
/// it reaches `min_run` physical px.
fn colored_run(
    px: &impl Fn(u32, u32) -> (u8, u8, u8),
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
    pred: impl Fn((u8, u8, u8)) -> bool,
) -> bool {
    if x1 <= x0 || y1 <= y0 {
        return false;
    }
    for y in (y0..y1).step_by(SCENE_STEP as usize) {
        let mut run = 0u32;
        let mut best = 0u32;
        for x in (x0..x1).step_by(SCENE_STEP as usize) {
            if pred(px(x, y)) {
                run += SCENE_STEP;
                best = best.max(run);
            } else {
                run = 0;
            }
        }
        if best >= SCORE_BAR_MIN_RUN {
            return true;
        }
    }
    false
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
