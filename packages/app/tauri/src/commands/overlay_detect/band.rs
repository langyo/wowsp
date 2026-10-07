use super::pixel::{
    downscale_rgba, is_header_green, is_header_red, is_text_white, longest_run_span,
};
use super::profile::DetectProfile;
use super::roster::{DetectedRoster, finish_roster, grid_origin};
use super::*;

/// One located team-header band — the cacheable geometry half of
/// [`detect_roster`]. All coordinates are WORKING px (the downscaled
/// analysis frame; `scale = width.div_ceil(MAX_WORK_WIDTH)` maps them back
/// to physical), spans end-exclusive. Carries the measured BAR HEIGHT too:
/// the row pitch is derived from it (the profile's pitch prior), so band + height
/// is everything [`rebuild_roster_from_band`] needs to re-emit a grid
/// without rescanning the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HeaderBand {
    /// Top scan row carrying both bars.
    pub top: usize,
    /// Header-bar height in working px.
    pub height: usize,
    /// Green (ally) bar horizontal span.
    pub green: (usize, usize),
    /// Red (enemy) bar horizontal span. `None` marks the single-team PVE
    /// variant: the table opens with ONE centered teal bar and no enemy
    /// half at all (see [`find_header_band`] for the acceptance gates a
    /// green-only band must pass).
    pub red: Option<(usize, usize)>,
}

/// Locate the team-header band: a thick run of consecutive scan rows each
/// carrying the teal bar plus EITHER the adjacent brick bar (the classic
/// two-team Tab table) OR nothing at all (the single-team PVE table, whose
/// lone teal bar is centered on the frame). Single-row anchoring was
/// fragile (a stray water horizon could outscore the real header), so the
/// band must be [`HEADER_MIN_ROWS`] rows thick and every run stays
/// SINGLE-KIND (a two-bar row and a green-only row never share a run).
///
/// The best TWO-BAR run (by total bar area) wins whenever one exists; a
/// GREEN-ONLY run is the fallback, accepted only after the gates on its
/// union green span:
///
/// 1. WIDTH — the lone bar is admitted in one of two variants. The WIDE
///    variant (the older layout, bar ~55-65% of the frame) passes the
///    position-agnostic [`GREEN_ONLY_MIN_W_FRAC`] floor. The NARROW variant
///    — the WG client's current operation table measures only ~23-24% —
///    must additionally sit dead-centered ([`GREEN_ONLY_NARROW_MIN_W_FRAC`]
///    width + [`GREEN_ONLY_MAX_CENTER_OFF_FRAC`]): the centered panel is
///    what separates it from a lone PVP green bar of the same width (the
///    ally half of a centered two-bar table, whose center sits a quarter of
///    the TABLE width — measured 0.1211 of the frame — left of the frame
///    center) and from mod scoreboards' corner bars. Two-bar bands are NOT
///    width-gated: their adjacency + pair signature already suffices.
/// 2. ROW TEXT — the frame below the band must carry ≥ 2 white text bands
///    ([`green_only_has_row_text`]): the PVE table always lists player
///    names under its bar, while teal water/sky horizons and mod panels
///    without name rows don't. This gate also protects
///    [`header_bars_present`], which delegates here.
///
/// A red bar present but NOT adjacent (gap beyond [`HEADER_MAX_BAR_GAP_FRAC`])
/// rejects the scan row outright — the mod scoreboard's corner bars must
/// never degrade into a green-only hit. Returns [`HeaderBand`] (band top +
/// bar height + spans; `red: None` marks the single-team variant).
pub(crate) fn find_header_band(px: &[u8], w: usize, h: usize) -> Option<HeaderBand> {
    let y_lo = (h as f32 * HEADER_SCAN_TOP_FRAC) as usize;
    let y_hi = ((h as f32 * HEADER_SCAN_BOTTOM_FRAC) as usize).min(h);
    let min_run = ((w as f32 * HEADER_MIN_RUN_FRAC) as usize).max(HEADER_MIN_RUN_PX);
    let max_gap = (w as f32 * HEADER_MAX_BAR_GAP_FRAC) as usize;
    /// One scan-row hit: (bar y, green span, red span), spans end-exclusive.
    /// `red: None` marks a GREEN-ONLY row (single-team PVE header variant).
    type HeaderHit = (usize, (usize, usize), Option<(usize, usize)>);
    // Per-row classification: green bar + (adjacent red bar | nothing).
    let row_hit = |y: usize| -> Option<HeaderHit> {
        let g = longest_run_span(px, w, y, is_header_green).filter(|g| g.1 - g.0 >= min_run)?;
        match longest_run_span(px, w, y, is_header_red).filter(|r| r.1 - r.0 >= min_run) {
            // ADJACENCY: the real table's two header bars hug the central
            // seam (gap ≈ 2 working px). The mod scoreboard's teal/brick
            // bars sit in the screen's opposite corners — same colors, same
            // heights, HUGE gap — and kept outscoring the real header by
            // area, flinging the anchor to the top of the screen (the live
            // "drift"). A pair whose gap exceeds a fraction of the width
            // rejects the WHOLE row: never a two-bar hit, and never a
            // degraded green-only hit either.
            Some(r) if r.0.abs_diff(g.1) <= max_gap => Some((y, g, Some(r))),
            Some(_) => None,
            None => Some((y, g, None)),
        }
    };
    let mut run: Vec<HeaderHit> = Vec::new();
    // Best thick run per kind, owned (NOT borrowed from `run` — the borrow
    // would fight the `run.clear()` reset below). Slot 0 = green-only,
    // slot 1 = two-bar; the bool-as-index keeps the flush shared.
    let mut best: [(Option<Vec<HeaderHit>>, usize); 2] = std::array::from_fn(|_| (None, 0));
    let flush = |run: &mut Vec<HeaderHit>, best: &mut [(Option<Vec<HeaderHit>>, usize); 2]| {
        if run.len() >= HEADER_MIN_ROWS {
            let slot = run[0].2.is_some() as usize;
            let area: usize = run
                .iter()
                .map(|(_, g, r)| (g.1 - g.0) + r.map_or(0, |r| r.1 - r.0))
                .sum();
            if area > best[slot].1 {
                best[slot].1 = area;
                best[slot].0 = Some(std::mem::take(run));
            }
        }
        run.clear();
    };
    for y in y_lo..y_hi {
        match row_hit(y) {
            Some(hit) => {
                // A run must stay single-KIND: mixing two-bar and green-only
                // rows would blur which gates the band deserves, so a kind
                // change flushes the run and starts a new one.
                if run
                    .last()
                    .is_some_and(|prev| prev.2.is_some() != hit.2.is_some())
                {
                    flush(&mut run, &mut best);
                }
                run.push(hit);
            },
            None => flush(&mut run, &mut best),
        }
    }
    flush(&mut run, &mut best);
    // Two-bar always wins if present; the green-only run is the gated
    // fallback (both gates computed on the union green span across the
    // band's rows).
    let mut chosen = best[1].0.take();
    if chosen.is_none()
        && let Some(rows) = best[0].0.take()
    {
        let (gx0, gx1) = rows.iter().fold((usize::MAX, 0), |(s, e), (_, g, _)| {
            (s.min(g.0), e.max(g.1))
        });
        let width = (gx1 - gx0) as f32 / w as f32;
        let center_off = ((gx0 + gx1) as f32 / 2.0 - w as f32 / 2.0).abs() / w as f32;
        let wide_variant = width >= GREEN_ONLY_MIN_W_FRAC;
        let narrow_centered =
            width >= GREEN_ONLY_NARROW_MIN_W_FRAC && center_off <= GREEN_ONLY_MAX_CENTER_OFF_FRAC;
        if (wide_variant || narrow_centered)
            && green_only_has_row_text(px, w, h, rows[0].0, (gx0, gx1))
        {
            chosen = Some(rows);
        }
    }
    let band_rows = chosen?;
    // Anchor row = the band's first row; spans = widest green/red extents
    // across the band (caption text punches holes into individual rows).
    let top = band_rows[0].0;
    let (gx0, gx1) = band_rows.iter().fold((usize::MAX, 0), |(s, e), (_, g, _)| {
        (s.min(g.0), e.max(g.1))
    });
    // Single-KIND runs: either every row carries the red span or none does.
    let red = if band_rows[0].2.is_some() {
        let (rx0, rx1) = band_rows
            .iter()
            .filter_map(|(_, _, r)| *r)
            .fold((usize::MAX, 0), |(s, e), r| (s.min(r.0), e.max(r.1)));
        Some((rx0, rx1))
    } else {
        None
    };
    Some(HeaderBand {
        top,
        height: header_bar_height(px, w, h, top, (gx0, gx1), red),
        green: (gx0, gx1),
        red,
    })
}

/// The ROW-TEXT gate for a GREEN-ONLY header candidate: the frame below the
/// band must carry at least TWO white text bands over the bar's span. The
/// single-team PVE table always lists player names directly under its teal
/// bar, while the false positives this variant invites — teal water/sky
/// horizons, mod panels without a name column — show none. Band extraction
/// mirrors [`fit_row_grid`] exactly (threshold = [`ROW_TEXT_FRACTION`] of
/// the profile max, bands ≥ [`ROW_BAND_MIN_H`] rows) over the same
/// [`ROW_SCAN_MAX_SPAN_FRAC`] window the full detector profiles.
fn green_only_has_row_text(
    px: &[u8],
    w: usize,
    h: usize,
    top: usize,
    green: (usize, usize),
) -> bool {
    let height = header_bar_height(px, w, h, top, green, None);
    let prof_top = (top + height).min(h);
    let prof_cap = (prof_top + (h as f32 * ROW_SCAN_MAX_SPAN_FRAC) as usize).min(h);
    if prof_cap <= prof_top {
        return false;
    }
    let rgb = |x: usize, y: usize| -> (i16, i16, i16) {
        let i = (y * w + x) * 3;
        (px[i] as i16, px[i + 1] as i16, px[i + 2] as i16)
    };
    let mut profile = vec![0u32; prof_cap - prof_top];
    for (dy, slot) in profile.iter_mut().enumerate() {
        let y = prof_top + dy;
        let mut n = 0u32;
        for x in green.0..green.1 {
            let (r, g, b) = rgb(x, y);
            if is_text_white(r, g, b) {
                n += 1;
            }
        }
        *slot = n;
    }
    let prof_max = profile.iter().copied().max().unwrap_or(0);
    if prof_max == 0 {
        return false;
    }
    let thr = prof_max as f32 * ROW_TEXT_FRACTION;
    let mut bands = 0usize;
    let mut band_start: Option<usize> = None;
    let mut flush = |band_start: &mut Option<usize>, dy: usize| {
        if let Some(s) = band_start.take()
            && dy - s >= ROW_BAND_MIN_H
        {
            bands += 1;
        }
    };
    for (dy, &v) in profile.iter().enumerate() {
        let in_band = v as f32 > thr;
        if in_band && band_start.is_none() {
            band_start = Some(dy);
        }
        if !in_band {
            flush(&mut band_start, dy);
        }
    }
    flush(&mut band_start, profile.len());
    bands >= 2
}

/// Header-bar height: scan down from the band top; a row stays "header"
/// while ≥2 of the bar sample columns ([`header_samples`]) read bar color
/// (or the white captions punched into them). Continuation checks the BAR
/// colors only — counting white here would let the scan bleed into the
/// first player-name row sitting right under the bar whenever a sample
/// lands inside the name text. The same sample columns are what
/// [`verify_header_band`] re-checks on later captures.
fn header_bar_height(
    px: &[u8],
    w: usize,
    h: usize,
    top: usize,
    green: (usize, usize),
    red: Option<(usize, usize)>,
) -> usize {
    let rgb = |x: usize, y: usize| -> (i16, i16, i16) {
        let i = (y * w + x) * 3;
        (px[i] as i16, px[i + 1] as i16, px[i + 2] as i16)
    };
    let samples = header_samples(green, red);
    let is_bar_color = |x: usize, y: usize| -> bool {
        let (r, g, b) = rgb(x, y);
        is_header_green(r, g, b) || is_header_red(r, g, b)
    };
    let mut hh = 0usize;
    let mut miss = 0usize;
    for y in top..((top + h / 6).min(h)) {
        if samples.iter().filter(|&&x| is_bar_color(x, y)).count() >= 2 {
            hh = y - top + 1;
            miss = 0;
        } else {
            miss += 1;
            if miss >= 2 {
                break;
            }
        }
    }
    hh.clamp(HEADER_MIN_H, (h / 10).max(HEADER_MIN_H))
}

/// The bar sample columns shared by the height scan and the band
/// verification: two-bar bands keep the historical six (3 per bar, at the
/// quarter points); a GREEN-ONLY (single-team PVE) band carries three
/// columns at the green bar's quarter points. Both consumers keep the
/// "≥ 2 sample hits per row" rule: the white team caption sits in the left
/// ~quarter of the bar, so 2-of-3 tolerates exactly one sample landing
/// inside it — the same one-caption-hole margin the six-column rule has on
/// two-bar bands.
fn header_samples(green: (usize, usize), red: Option<(usize, usize)>) -> Vec<usize> {
    let green = [
        green.0 + (green.1 - green.0) / 4,
        green.0 + (green.1 - green.0) / 2,
        green.0 + (green.1 - green.0) * 3 / 4,
    ];
    match red {
        Some(red) => green
            .into_iter()
            .chain([
                red.0 + (red.1 - red.0) / 4,
                red.0 + (red.1 - red.0) / 2,
                red.0 + (red.1 - red.0) * 3 / 4,
            ])
            .collect(),
        None => green.to_vec(),
    }
}

/// Full-frame header presence check — the strongest "inside a battle" proof
/// (the team-header bars exist ONLY on the in-battle Tab table: the classic
/// teal+brick pair, or the single-team PVE variant's lone teal bar
/// accepted under [`find_header_band`]'s width + white-row-text gates —
/// the text gate in particular keeps teal water/sky horizons from reading
/// as a table). The HUD probe dims badly (holding Tab darkens the frame and
/// real dimmed captures measure 2 icon clusters / a 12px HP run against
/// thresholds of 5 / 48), so the scene gate accepts EITHER evidence.
pub(crate) fn header_bars_present(rgba: &[u8], width: u32, height: u32) -> bool {
    let scale = width.div_ceil(MAX_WORK_WIDTH).max(1);
    let (px, w, h) = downscale_rgba(rgba, width, height, scale);
    if w < 64 || h < 64 {
        return false;
    }
    find_header_band(&px, w, h).is_some()
}

/// Box-average one scale×scale source block into a working-px RGB triplet —
/// the EXACT per-pixel formula of [`downscale_rgba`], computed on demand so
/// a band verification never has to materialize the whole working frame.
fn sample_working(rgba: &[u8], width: u32, scale: u32, x: usize, y: usize) -> (i16, i16, i16) {
    let sw = scale as usize;
    let n = scale * scale;
    let fw = width as usize;
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
    (
        (sr / n).min(255) as i16,
        (sg / n).min(255) as i16,
        (sb / n).min(255) as i16,
    )
}

/// Counter-evidence columns sit this many working px OUTSIDE each end of
/// the cached header band (see [`verify_header_band`]): close enough that
/// any real horizontal slide of the table puts a bar over them, far enough
/// that a pixel or two of edge anti-aliasing on an unmoved table cannot.
const BAND_EDGE_COUNTER_OFFSETS_PX: usize = 2;

/// Cheap re-verification of a cached detection: sample ONLY the cached
/// header band region (the bar sample columns ([`header_samples`]) × the
/// band's rows — the same points the height scan used) and confirm the
/// teal/brick team-header colors are still there, PLUS a few
/// counter-evidence columns just outside the band's left/right ends.
/// O(band area) with no full-frame downscale: this is what every capture
/// pays INSTEAD of a full `detect_roster` while the cached geometry is
/// trusted. Single-team PVE bands (`red: None`) verify the same way over
/// their three green-bar sample columns.
///
/// The positive half alone proves "the bars are still HERE" but not "the
/// table did not slide horizontally": the bars are ~24% of the width each
/// and the sample columns sit at their quarter points, so a shift of a few
/// pixels keeps every interior sample on bar color. The counter columns
/// (1–2 working px outside each end) must stay bar-COLOR-FREE — a maximal
/// color run's neighborhood is by construction not bar color on the frame
/// the band was detected on — and a shift lights them on essentially every
/// band row. Failure of either half means the table moved or the scene
/// changed: the cached geometry must not anchor that frame. A lone noisy
/// counter row is tolerated (the positive half has the same tolerance for
/// caption text punching holes); two or more mean the band drifted.
pub(crate) fn verify_header_band(rgba: &[u8], width: u32, height: u32, band: &HeaderBand) -> bool {
    let scale = width.div_ceil(MAX_WORK_WIDTH).max(1);
    let w_work = (width / scale) as usize;
    let h_work = (height / scale) as usize;
    if w_work < 64 || h_work < 64 {
        return false;
    }
    // Only the green span must be non-empty: a single-team PVE band
    // legitimately carries `red: None`.
    if band.green.1 <= band.green.0 {
        return false;
    }
    let bar_color_at = |x: usize, y: usize| -> bool {
        x < w_work && {
            let (r, g, b) = sample_working(rgba, width, scale, x, y);
            is_header_green(r, g, b) || is_header_red(r, g, b)
        }
    };
    let samples = header_samples(band.green, band.red);
    let rows = band.height.max(1);
    let mut hits = 0usize;
    for dy in 0..rows {
        let y = band.top + dy;
        if y >= h_work {
            break;
        }
        let bar_hits = samples.iter().filter(|&&sx| bar_color_at(sx, y)).count();
        if bar_hits >= 2 {
            hits += 1;
        }
    }
    // Counter-evidence columns outside both ends of the band (a bar at the
    // frame's edge simply loses that side's columns — nothing to contradict
    // there). The right side anchors on the band's right edge: the red bar's
    // end when it exists, the lone green bar's end on single-team bands.
    let band_right = band.red.map_or(band.green.1, |(_, rx1)| rx1);
    let mut counter_cols = Vec::with_capacity(4);
    for off in 1..=BAND_EDGE_COUNTER_OFFSETS_PX {
        if band.green.0 >= off {
            counter_cols.push(band.green.0 - off);
        }
        counter_cols.push(band_right + off);
    }
    let mut counter_rows = 0usize;
    for dy in 0..rows {
        let y = band.top + dy;
        if y >= h_work {
            break;
        }
        if counter_cols.iter().any(|&x| bar_color_at(x, y)) {
            counter_rows += 1;
        }
    }
    // At least half the cached band rows must still read as header bars.
    // A perfect score is not required (the white captions punch holes into
    // individual rows — the height scan tolerates the same), but a moved or
    // vanished table loses most rows at once. AND the band edges must stay
    // clean: header-colored columns outside the cached band mean the table
    // slid horizontally (the interior samples above would miss it) and the
    // cached x must be re-detected.
    hits * 2 >= rows && counter_rows < 2
}

/// Geometric rebuild of the row grid from a CACHED header band for NEW team
/// sizes (the next battle is 7v7 after a 12v12 on the same game window):
/// same band origin and pitch, row count from the new roster. No frame scan
/// and no white-text phase refinement — the cached pitch is trusted (the
/// refinement's frame-to-frame jitter is exactly what the pin exists to
/// suppress). `measured_pitch` (physical px, per side, from
/// [`measured_pitch_from_centers`] on the cached detection) keeps the pitch
/// the previous frame actually measured instead of the constant prior;
/// `None` (or a non-positive value) falls back to the profile's
/// [`DetectProfile::pitch_per_header`] prior. The geometry matches
/// [`detect_roster`]'s unrefined grid because both go through
/// [`grid_origin`] / [`finish_roster`].
pub(crate) fn rebuild_roster_from_band(
    band: &HeaderBand,
    width: u32,
    height: u32,
    team_sizes: (usize, usize),
    measured_pitch: Option<(f32, f32)>,
    profile: &DetectProfile,
) -> DetectedRoster {
    let scale = width.div_ceil(MAX_WORK_WIDTH).max(1);
    let h_work = (height / scale) as usize;
    let (prof_top, pitch_const, _) = grid_origin(*band, h_work, profile);
    let pitch_of = |measured: Option<f32>| -> f32 {
        measured
            .filter(|p| *p > 0.0)
            .map(|p| p / scale as f32)
            .unwrap_or(pitch_const)
    };
    let pitch_l = pitch_of(measured_pitch.map(|(l, _)| l));
    let pitch_r = pitch_of(measured_pitch.map(|(_, r)| r));
    // Row counts: the arena hint is authoritative; without any hint the
    // same conservative 5-row grid the full detector falls back to.
    let rows_wanted = |hint: usize| if hint > 0 { hint } else { 5 };
    let first_l = prof_top as f32 + pitch_l * 0.5;
    let first_r = prof_top as f32 + pitch_r * 0.5;
    let mut centers: Vec<f32> = (0..rows_wanted(team_sizes.0))
        .map(|i| first_l + pitch_l * i as f32)
        .collect();
    // GREEN-ONLY (single-team PVE) band: no enemy half exists — the rebuild
    // emits the ally block ONLY, whatever the hint's enemy count says.
    if band.red.is_some() {
        centers.extend((0..rows_wanted(team_sizes.1)).map(|i| first_r + pitch_r * i as f32));
    }
    finish_roster(*band, h_work, scale, centers, pitch_l.max(pitch_r))
}

/// Per-side row pitch (physical px) measured off a previous detection's row
/// centers: the mean consecutive-row gap of each block (allies first, then
/// enemies). Feeds [`rebuild_roster_from_band`] so a cache rebuild keeps the
/// pitch the frame itself measured. A block with fewer than two rows yields
/// 0.0 — the caller's "no measurement" — rather than a guess.
pub(crate) fn measured_pitch_from_centers(row_centers: &[i32], ally_rows: usize) -> (f32, f32) {
    let side = |lo: usize, hi: usize| -> f32 {
        let Some(blk) = row_centers.get(lo..hi) else {
            return 0.0;
        };
        if blk.len() < 2 {
            return 0.0;
        }
        blk.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<i32>() as f32 / (blk.len() - 1) as f32
    };
    let hi_l = ally_rows.min(row_centers.len());
    (side(0, hi_l), side(hi_l, row_centers.len()))
}

// ─────────────────────────────────────────────────────────────────────────
// Native-resolution refinement (sub-working-pixel accuracy)
// ─────────────────────────────────────────────────────────────────────────

/// Base search radius (physical px) around each work-frame-derived edge —
/// the radius scales with the downscale factor on top of this (the working
/// frame's quantization error is up to one `scale`-px step per edge).
const NATIVE_REFINE_RADIUS: i32 = 4;

/// Re-measure the table's anchor features at FULL resolution inside a small
/// ROI around a work-frame detection. Everything upstream ran on the ≤800-px
/// working frame and maps back with `× scale` rounding — on a 3072-px
/// capture (scale 4) that alone quantizes every edge and row center onto a
/// 4-px grid, which read on screen as "the chips sit a couple of px off the
/// table". This pass polishes, in order:
///
/// - the header band's top and bottom, via ROW-MEAN colors over each bar's
///   span (averaging the whole span dilutes the white captions punched into
///   the bars, so the means still classify with the same predicates);
/// - the table's left/right edges and the team seam, via COLUMN-MEAN colors
///   over the refined band rows — except on single-team PVE detections
///   (`team_split` 1.0), where the whole rect width is ONE green bar: the
///   header-row test runs the green mean alone, the column pass collects
///   the green span only, and no seam/split update happens (the split
///   stays 1.0);
/// - the row grid, shifted by the header-bottom delta (its origin hangs off
///   the band's bottom edge).
///
/// Every refinement is clamped to the ROI and silently keeps the incoming
/// value whenever its feature is not found or fails a sanity check — a
/// noisy or partially occluded frame degrades to the work-frame answer,
/// never jumps somewhere else. Pure over the RGBA frame (unit-testable).
pub(crate) fn refine_roster_native(
    rgba: &[u8],
    width: u32,
    height: u32,
    det: &DetectedRoster,
    header_bottom_prior: i32,
) -> DetectedRoster {
    let fw = width as i64;
    let fh = height as i64;
    let scale = width.div_ceil(MAX_WORK_WIDTH).max(1) as i64;
    let radius: i64 = i64::from(NATIVE_REFINE_RADIUS) + 2 * scale;
    if det.rect.width <= 0
        || det.rect.height <= 0
        || det.row_centers.is_empty()
        || rgba.len() < (width as usize) * (height as usize) * 4
    {
        return det.clone();
    }
    let px = |x: i64, y: i64| -> Option<(i32, i32, i32)> {
        if !(0..fw).contains(&x) || !(0..fh).contains(&y) {
            return None;
        }
        let i = ((y * fw + x) * 4) as usize;
        Some((rgba[i] as i32, rgba[i + 1] as i32, rgba[i + 2] as i32))
    };
    /// Mean color over a sampled pixel line, capped at ~96 samples so long
    /// spans stay cheap. `len` is the line's full length (drives the stride).
    fn mean_of(
        pts: impl Iterator<Item = (i64, i64)>,
        len: i64,
        px: &impl Fn(i64, i64) -> Option<(i32, i32, i32)>,
    ) -> Option<(i32, i32, i32)> {
        if len <= 0 {
            return None;
        }
        let step = (len / 96).max(1) as usize;
        let (mut sr, mut sg, mut sb, mut n) = (0i64, 0i64, 0i64, 0i64);
        for (a, b) in pts.step_by(step) {
            if let Some((r, g, bl)) = px(a, b) {
                sr += i64::from(r);
                sg += i64::from(g);
                sb += i64::from(bl);
                n += 1;
            }
        }
        (n > 0).then(|| ((sr / n) as i32, (sg / n) as i32, (sb / n) as i32))
    }
    let row_mean = |y: i64, x0: i64, x1: i64| mean_of((x0..x1).map(|x| (x, y)), x1 - x0, &px);
    let col_mean = |x: i64, y0: i64, y1: i64| mean_of((y0..y1).map(|y| (x, y)), y1 - y0, &px);
    let is_green = |c: (i32, i32, i32)| is_header_green(c.0 as i16, c.1 as i16, c.2 as i16);
    let is_red = |c: (i32, i32, i32)| is_header_red(c.0 as i16, c.1 as i16, c.2 as i16);

    // Bar spans for the row means, from the detected rect + split (the seam
    // approximation only shifts which columns feed each mean — a couple of
    // columns of the wrong bar dilute away in it). GREEN-ONLY (single-team
    // PVE) detections report team_split exactly 1.0: the whole rect width
    // IS one bar, so the header-row test classifies a single green row-mean
    // and the column pass below collects the green span only.
    let single_team = det.team_split >= 0.999;
    let split = det.team_split.clamp(0.25, 0.75) as f64;
    let gx0 = det.rect.x as i64;
    let gx1 = (det.rect.x as f64 + det.rect.width as f64 * split) as i64;
    let rx1 = (det.rect.x + det.rect.width) as i64;
    let is_header_row = |y: i64| -> bool {
        if single_team {
            row_mean(y, gx0, rx1).is_some_and(is_green)
        } else {
            matches!(
                (row_mean(y, gx0, gx1), row_mean(y, gx1, rx1)),
                (Some(g), Some(r)) if is_green(g) && is_red(r)
            )
        }
    };

    // ── Header band top + bottom (the row grid hangs off the bottom) ──────
    let y_lo = (det.rect.y as i64 - radius).max(0);
    let y_scan_hi = (i64::from(header_bottom_prior) + radius)
        .min(fh)
        .max(y_lo + 1);
    let mut new_top = det.rect.y as i64;
    let mut new_bottom_excl = i64::from(header_bottom_prior);
    if let Some(t0) = (y_lo..y_scan_hi).find(|&y| is_header_row(y)) {
        let mut end = t0; // last header row, inclusive
        let mut miss = 0i32;
        for y in t0 + 1..y_scan_hi {
            if is_header_row(y) {
                end = y;
                miss = 0;
            } else {
                miss += 1;
                if miss >= 2 {
                    break;
                }
            }
        }
        // A band thinner than two working rows is noise, not the header.
        if end - t0 + 1 >= 2 * scale {
            new_top = t0;
            new_bottom_excl = end + 1;
        }
    }

    // ── Left/right edges + seam via column means over the band rows ───────
    let col_class = |x: i64| -> u8 {
        match col_mean(x, new_top, new_bottom_excl) {
            Some(c) if is_green(c) => 1,
            Some(c) if is_red(c) => 2,
            _ => 0,
        }
    };
    let x_lo = (det.rect.x as i64 - radius).max(0);
    let x_hi = (i64::from(det.rect.x + det.rect.width) + radius).min(fw);
    // EXTREMES, not contiguous runs: the white captions punched into the
    // middle of each bar leave a >100-column non-bar hole, so run extension
    // would clip the bars at the caption. First/last classified columns are
    // the bar edges (the surrounding scene is not bar-colored by the same
    // predicates the detector itself uses).
    let mut green_span: Option<(i64, i64)> = None;
    let mut red_span: Option<(i64, i64)> = None;
    for x in x_lo..x_hi {
        match col_class(x) {
            1 => {
                green_span = Some(match green_span {
                    Some((a, b)) => (a, b.max(x)),
                    None => (x, x),
                });
            },
            // Green-only frames collect no red span: a stray red column (HUD
            // decoration) must not flip the update into the two-bar branch.
            2 if !single_team => {
                red_span = Some(match red_span {
                    Some((a, b)) => (a.min(x), b.max(x)),
                    None => (x, x),
                });
            },
            _ => {},
        }
    }

    let mut out = det.clone();
    if single_team {
        // Single-team x/width update: same width sanity check as the
        // two-bar path, but there is no seam to hug and no split to update
        // (the lone bar IS the table; the split stays exactly 1.0).
        if let Some((gl, gr)) = green_span {
            let new_width = gr - gl + 1;
            if new_width > 0 && (new_width - i64::from(det.rect.width)).abs() <= 2 * radius {
                out.rect.x = gl as i32;
                out.rect.width = new_width as i32;
            }
        }
    } else if let (Some((gl, gr)), Some((rl, rr))) = (green_span, red_span) {
        let new_width = rr - gl + 1;
        let bars_hug = rl - gr <= (0.06 * f64::from(det.rect.width)).max(2.0 * scale as f64) as i64;
        if new_width > 0 && (new_width - i64::from(det.rect.width)).abs() <= 2 * radius && bars_hug
        {
            let seam = (gr + rl) as f64 / 2.0;
            let split_new = ((seam - gl as f64) / new_width as f64) as f32;
            out.rect.x = gl as i32;
            out.rect.width = new_width as i32;
            if (0.30..=0.70).contains(&split_new) {
                out.team_split = split_new;
            }
        }
    }
    // Top edge + the grid shift from the header-bottom delta (clamped to the
    // ROI; a bottom that moved farther than that is a different feature).
    let dy_top = (new_top - i64::from(det.rect.y)).clamp(-radius, radius) as i32;
    if dy_top != 0 && det.rect.height - dy_top > 0 {
        out.rect.y = (det.rect.y + dy_top).max(0);
        out.rect.height -= dy_top;
    }
    let delta = (new_bottom_excl - i64::from(header_bottom_prior)).clamp(-radius, radius) as i32;
    if delta != 0 {
        out.row_centers = det
            .row_centers
            .iter()
            .map(|c| (*c as f32 + delta as f32).round() as i32)
            .collect();
    }
    out
}
