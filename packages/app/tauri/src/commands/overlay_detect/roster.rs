use super::band::{HeaderBand, find_header_band, refine_roster_native};
use super::pixel::{downscale_rgba, is_text_white};
use super::profile::DetectProfile;
use super::*;

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
    /// Exactly 1.0 marks the single-team PVE variant: the table IS one
    /// full-width team, so the backend name-strip math (half width =
    /// `roster.width * split`) covers the whole table — where the PVE
    /// nickname column lives — and the frontend never reads this field
    /// anyway (rows map by the Tab sort key + the row centers).
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
    team_sizes: (usize, usize),
    profile: &DetectProfile,
) -> Option<DetectedRoster> {
    detect_roster_with_band(rgba, width, height, team_sizes, profile).map(|(_, det)| det)
}

/// [`detect_roster`] plus the located [`HeaderBand`] — the cacheable
/// geometry half the Tab watcher stores so later captures only need a cheap
/// band re-verification ([`verify_header_band`]) and a geometric rebuild
/// ([`rebuild_roster_from_band`]) instead of a full-frame scan.
pub(crate) fn detect_roster_with_band(
    rgba: &[u8],
    width: u32,
    height: u32,
    team_sizes: (usize, usize),
    profile: &DetectProfile,
) -> Option<(HeaderBand, DetectedRoster)> {
    let (expected_allies, expected_enemies) = team_sizes;
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
    //    green bar plus either the adjacent red one or nothing at all (see
    //    `find_header_band`; the band's bar height — the row pitch's
    //    source — is measured inside it too) ────────────────────────────────
    let band = find_header_band(&px, w, h)?;
    let (prof_top, pitch, first) = grid_origin(band, h, profile);
    let gx0 = band.green.0;
    let gx1 = band.green.1;

    // ── 2. Player rows by pure GEOMETRY (no pixel row-counting) ───────────
    // Seven anchor points pin the table: THREE on top (green-bar top-left,
    // seam top, red-bar top-right — the header band) and FOUR at the bottom
    // (each sub-table's own bottom corners, derived from ITS row count —
    // asymmetrical battles like 12v6 have two sub-tables of different
    // heights and row pitches). The real row pitch ≈ the header-bar height
    // (measured 52/55 ≈ 0.95 and 48/54 ≈ 0.89 — bars and rows share the
    // same UI scale); each side's grid starts half a pitch under the shared
    // header. White-text bands only fine-tune the PHASE of each side's
    // grid independently (± pitch/3) — they never gate the result.
    // White-text density profiles over the generous window below the header,
    // one per side — used ONLY for the per-side phase refinement below. A
    // GREEN-ONLY (single-team PVE) band has no right half: its enemy
    // profile stays empty and its enemy grid below is forced to zero rows.
    let prof_cap = (prof_top + (h as f32 * ROW_SCAN_MAX_SPAN_FRAC) as usize).min(h);
    let mut profile_l = vec![0u32; prof_cap.saturating_sub(prof_top)];
    let mut profile_r: Vec<u32> = Vec::new();
    for (dy, slot) in profile_l.iter_mut().enumerate() {
        let y = prof_top + dy;
        let mut n = 0u32;
        for x in gx0..gx1 {
            let (r, g, b) = rgb(x, y);
            if is_text_white(r, g, b) {
                n += 1;
            }
        }
        *slot = n;
    }
    if let Some((rx0, rx1)) = band.red {
        profile_r = profile_l.clone();
        for (dy, slot) in profile_r.iter_mut().enumerate() {
            let y = prof_top + dy;
            let mut n = 0u32;
            for x in rx0..rx1 {
                let (r, g, b) = rgb(x, y);
                if is_text_white(r, g, b) {
                    n += 1;
                }
            }
            *slot = n;
        }
    }
    // Row counts: each side's arena hint is authoritative; without any hint
    // fall back to a conservative 5-row grid (real flows always pass it).
    // EXCEPT on a green-only band: there IS no enemy half, so the hint's
    // enemy count must not conjure one (the arena-info path already parks
    // every player of these modes on the ally side — ignore it regardless).
    let rows_wanted = |hint: usize| if hint > 0 { hint } else { 5 };
    let enemies_wanted = if band.red.is_none() {
        0
    } else {
        rows_wanted(expected_enemies)
    };
    let (centers_l, pitch_l) = fit_row_grid(
        rows_wanted(expected_allies),
        &profile_l,
        prof_top,
        first,
        pitch,
    );
    let (centers_r, pitch_r) = fit_row_grid(enemies_wanted, &profile_r, prof_top, first, pitch);
    let mut centers = centers_l;
    centers.extend(centers_r);

    // ── 3. Rectangle + team split, back to physical px — then a NATIVE-
    //    resolution refinement of the anchor features inside a small ROI
    //    (the working frame quantizes every edge to `scale`-px steps; on a
    //    3072-px capture that alone is a ±4-px grid) ────────────────────────
    let det = finish_roster(band, h, scale, centers, pitch_l.max(pitch_r));
    let header_bottom_prior = ((band.top + band.height) as f32 * scale as f32).round() as i32;
    Some((
        band,
        refine_roster_native(rgba, width, height, &det, header_bottom_prior),
    ))
}

/// Fit one side's row grid to its white-text density profile. The PRIOR grid
/// comes from [`grid_origin`] (header-anchored, constant ratio); the text
/// bands then correct it in two steps, in this order:
///
/// 1. PITCH from the bands' consecutive GAPS — index-free, so it is immune
///    to exactly the drift being fixed (with a wrong prior pitch, far-down
///    bands sit closer to the WRONG grid index, and a naive nearest-index
///    assignment would mispair them). Each gap is divided by its nearest
///    integer multiple of the prior pitch (an occluded row leaves a 2× gap);
///    the median of the contributions is the estimate, clamped to a
///    plausible band around the prior.
/// 2. ORIGIN by least squares over the bands re-assigned against the
///    corrected pitch (a half-pitch consistency filter + per-index dedupe
///    keeps strays — HUD text, our own hint box — from voting).
///
/// Fewer than two bands (occlusion, all-sunk dim rows) degrades to the
/// prior grid verbatim; two bands keep the corrected pitch but only shift
/// the phase (the old refinement behavior). Returns the centers and the
/// pitch actually used, both in working px.
pub(crate) fn fit_row_grid(
    rows: usize,
    profile: &[u32],
    prof_top: usize,
    first0: f32,
    pitch0: f32,
) -> (Vec<f32>, f32) {
    let uniform = |first: f32, pitch: f32| -> Vec<f32> {
        (0..rows).map(|i| first + pitch * i as f32).collect()
    };
    if rows == 0 || pitch0 <= 0.0 {
        return (Vec::new(), pitch0);
    }
    let prof_max = profile.iter().copied().max().unwrap_or(0);
    if prof_max == 0 {
        return (uniform(first0, pitch0), pitch0);
    }
    // Text-band centers (working px), half-px resolution.
    let thr = prof_max as f32 * ROW_TEXT_FRACTION;
    let mut bands: Vec<f32> = Vec::new();
    let mut band_start: Option<usize> = None;
    let flush = |band_start: &mut Option<usize>, dy: usize, bands: &mut Vec<f32>| {
        if let Some(s) = band_start.take()
            && dy - s >= ROW_BAND_MIN_H
        {
            bands.push(prof_top as f32 + (s + dy - 1) as f32 / 2.0);
        }
    };
    for (dy, &v) in profile.iter().enumerate() {
        let in_band = v as f32 > thr;
        if in_band && band_start.is_none() {
            band_start = Some(dy);
        }
        if !in_band {
            flush(&mut band_start, dy, &mut bands);
        }
    }
    flush(&mut band_start, profile.len(), &mut bands);
    if bands.len() < 2 {
        return (uniform(first0, pitch0), pitch0);
    }
    // ── Step 1: pitch from consecutive band gaps ──────────────────────────
    let mut contributions: Vec<f32> = bands
        .windows(2)
        .map(|w| {
            let gap = w[1] - w[0];
            let multiples = ((gap / pitch0).round() as i32).max(1) as f32;
            gap / multiples
        })
        .collect();
    contributions.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut pitch = contributions[contributions.len() / 2];
    let plausible = 0.80 * pitch0..=1.05 * pitch0;
    if !plausible.contains(&pitch) {
        pitch = pitch0;
    }
    // ── Step 2: origin by least squares over re-assigned bands ────────────
    let mut pairs: Vec<(f32, f32)> = bands
        .iter()
        .map(|&b| (((b - first0) / pitch).round(), b))
        .filter(|&(k, b)| {
            k >= 0.0 && (k as usize) < rows && (b - (first0 + pitch * k)).abs() <= pitch * 0.45
        })
        .collect();
    // One band per grid row: when strays crowd a real row's index, the band
    // closest to the (corrected-pitch) grid wins.
    pairs.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                (a.1 - (first0 + pitch * a.0))
                    .abs()
                    .partial_cmp(&(b.1 - (first0 + pitch * b.0)).abs())
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    pairs.dedup_by(|a, b| a.0 == b.0);
    if pairs.len() >= 3 {
        let n = pairs.len() as f32;
        let kmean = pairs.iter().map(|(k, _)| k).sum::<f32>() / n;
        let bmean = pairs.iter().map(|(_, b)| b).sum::<f32>() / n;
        let (mut cov, mut var) = (0.0f32, 0.0f32);
        for (k, b) in &pairs {
            cov += (k - kmean) * (b - bmean);
            var += (k - kmean) * (k - kmean);
        }
        if var > 0.0 {
            let fit_pitch = cov / var;
            let fit_first = bmean - fit_pitch * kmean;
            if plausible.contains(&fit_pitch) && (fit_first - first0).abs() <= pitch0 {
                return (uniform(fit_first, fit_pitch), fit_pitch);
            }
        }
        // The slope fit misbehaved (stray-dominated sample): keep the
        // gap-median pitch, refine only the origin as a shared offset.
        let mut offsets: Vec<f32> = pairs
            .iter()
            .map(|(k, b)| b - (first0 + pitch * k))
            .collect();
        offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let shift = offsets[offsets.len() / 2];
        return (uniform(first0 + shift, pitch), pitch);
    }
    if pairs.len() == 2 {
        let mut offsets: Vec<f32> = pairs
            .iter()
            .map(|(k, b)| b - (first0 + pitch * k))
            .collect();
        offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let shift = offsets[offsets.len() / 2];
        return (uniform(first0 + shift, pitch), pitch);
    }
    (uniform(first0, pitch), pitch)
}

/// Pure geometry shared by the full detector and the cache rebuild: header
/// band → the row-grid origin, in working px. `prof_top` is where the
/// player rows start (clamped to the working frame, as the original inline
/// computation was), `pitch` the row pitch prior (header-bar height × the
/// profile's [`DetectProfile::pitch_per_header`] — bars and rows share the
/// UI scale, but the exact ratio is per-client), `first` the first row's
/// center (half a pitch below the header).
pub(crate) fn grid_origin(
    band: HeaderBand,
    h: usize,
    profile: &DetectProfile,
) -> (usize, f32, f32) {
    let prof_top = (band.top + band.height).min(h);
    let pitch = band.height as f32 * profile.pitch_per_header;
    let first = prof_top as f32 + pitch * 0.5;
    (prof_top, pitch, first)
}

/// Shared detector tail (pure): row centers in working px → the physical-px
/// [`DetectedRoster`] (table rect + team split + scaled centers). Used by
/// both the full detection and [`rebuild_roster_from_band`] so the two can
/// never drift apart geometrically. `pitch_eff` is the row pitch the grid
/// actually used (the fitted one, or the constant prior on the rebuild
/// fallback) — it sizes the window-height floor and the bottom padding.
pub(crate) fn finish_roster(
    band: HeaderBand,
    h: usize,
    scale: u32,
    centers: Vec<f32>,
    pitch_eff: f32,
) -> DetectedRoster {
    // Rows start right under the header — profile-independent geometry.
    let prof_top = (band.top + band.height).min(h);
    let last = *centers.last().unwrap_or(&(prof_top as f32));
    // Window height floor: 12v12 is the largest standard roster, and the
    // overlay window must never be shorter than that even when the current
    // battle is smaller — extra height is transparent and click-through, but
    // a short window CLIPS the chips of a larger table (seen live).
    let y1w = (last + pitch_eff * 0.75)
        .max(prof_top as f32 + pitch_eff * MIN_WINDOW_ROWS)
        .min(h as f32 - 1.0) as usize;
    // Rect right edge + team split. GREEN-ONLY (single-team PVE): the
    // table ends at the lone bar's right edge and the split is EXACTLY
    // 1.0 — the PVE table IS one full-width team, so 1.0 makes the backend
    // name-strip math (half width = roster.width * split) cover the whole
    // table (its nickname column sits in the left ~2-40% of that), and the
    // frontend never reads the split (rows map by Tab sort key + centers).
    // The two-bar path keeps the seam-approximation split clamped to a
    // plausible half.
    let (right, team_split) = match band.red {
        Some((rx0, rx1)) => {
            let split_raw = ((band.green.1 + rx0) as f32 * 0.5 - band.green.0 as f32)
                / (rx1.saturating_sub(band.green.0)).max(1) as f32;
            let split = if (0.30..=0.70).contains(&split_raw) {
                split_raw
            } else {
                0.5
            };
            (rx1, split)
        },
        None => (band.green.1, 1.0),
    };
    let to_phys = |v: usize| (v as f32 * scale as f32).round() as i32;
    DetectedRoster {
        rect: Rect {
            x: to_phys(band.green.0),
            y: to_phys(band.top),
            width: to_phys(right.saturating_sub(band.green.0)),
            height: to_phys(y1w.saturating_sub(band.top)),
        },
        row_centers: centers
            .iter()
            .map(|&c| (c * scale as f32).round() as i32)
            .collect(),
        team_split,
    }
}
