use super::profile::DetectProfile;
use super::*;

/// Vertical half-extent of one row's name strip as a fraction of the row
/// pitch. One row's glyphs sit well inside ±0.5 pitch; staying under it
/// keeps the neighboring rows' text out of the crop (mis-pitching by half a
/// row is exactly the wrong-name failure this pipeline fights).
const NAME_STRIP_HALF_PITCH_FRAC: f32 = 0.42;

/// One detected table's strip-reading geometry, bundled to keep the strip
/// readers' argument lists flat: the roster rect, its row centers and the
/// ally/enemy split + block size the strip placement keys on.
#[derive(Clone, Copy)]
pub(crate) struct StripTable<'a> {
    pub(crate) roster: &'a Rect,
    pub(crate) row_centers: &'a [i32],
    pub(crate) team_split: f32,
    pub(crate) ally_rows: usize,
}

/// One row's name-strip crop rectangle, PHYSICAL px relative to the CAPTURE
/// (game window) origin — the same space `detect_roster` emits. `row` indexes
/// `row_centers` (allies block first, then enemies — the anchor's order);
/// `ally_rows` is the ally-block size (the roster's relation ≤ 1 count) and
/// decides which half the row's strip sits in: allied names render in the
/// left half, enemy names in the right half of the team split. Returns `None`
/// for out-of-range rows and degenerate geometry.
pub(crate) fn row_name_strip_rect(
    table: StripTable<'_>,
    row: usize,
    profile: &DetectProfile,
) -> Option<Rect> {
    let (roster, row_centers, team_split, ally_rows) = (
        table.roster,
        table.row_centers,
        table.team_split,
        table.ally_rows,
    );
    if row >= row_centers.len() {
        return None;
    }
    // Block bounds within row_centers: allies [0, ally_rows), enemies
    // [ally_rows, len). The split mirrors the frontend mapping (rows sliced
    // at the roster's ally count) — a grid longer than the roster simply has
    // an empty second block.
    let (b0, b1) = if row < ally_rows {
        (0, ally_rows.min(row_centers.len()))
    } else {
        (ally_rows, row_centers.len())
    };
    if b1 <= b0 {
        return None;
    }
    let split = team_split.clamp(0.0, 1.0);
    let (half_x0, half_w, x0_frac, x1_frac) = if row < ally_rows {
        (
            roster.x as f32,
            roster.width as f32 * split,
            profile.ally_strip_x0_frac,
            profile.ally_strip_x1_frac,
        )
    } else {
        (
            roster.x as f32 + roster.width as f32 * split,
            roster.width as f32 * (1.0 - split),
            profile.enemy_strip_x0_frac,
            profile.enemy_strip_x1_frac,
        )
    };
    if half_w <= 0.0 {
        return None;
    }
    let x0 = (half_x0 + half_w * x0_frac).round() as i32;
    let x1 = (half_x0 + half_w * x1_frac).round() as i32;
    // Row pitch from the row's own block neighbors (the two sub-tables can
    // pitch differently); a single-row block falls back to a coarse
    // roster-height estimate — rare (1v1), and the crop is frame-clamped
    // either way.
    let pitch = if b1 - b0 >= 2 {
        if row + 1 < b1 {
            (row_centers[row + 1] - row_centers[row]).abs()
        } else {
            (row_centers[row] - row_centers[row - 1]).abs()
        }
    } else {
        (roster.height / (b1 - b0 + 1) as i32).max(1)
    } as f32;
    let half_pitch = pitch.max(1.0) * NAME_STRIP_HALF_PITCH_FRAC;
    let cy = row_centers[row] as f32;
    let y0 = (cy - half_pitch).round() as i32;
    let y1 = (cy + half_pitch).round() as i32;
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some(Rect {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
    })
}

/// Copy a sub-rectangle of an RGBA frame into a fresh, tightly-packed
/// buffer. Clamps to the frame; returns `None` for empty results, negative
/// overflow, or a buffer that does not back the given dimensions — the
/// pipeline treats that as "no crop" rather than guessing or panicking.
pub(crate) fn crop_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    rect: &Rect,
) -> Option<(Vec<u8>, u32, u32)> {
    if rect.width <= 0 || rect.height <= 0 {
        return None;
    }
    if rgba.len() < (width as usize) * (height as usize) * 4 {
        return None;
    }
    let fx = width as i64;
    let fy = height as i64;
    let x0 = (rect.x as i64).clamp(0, fx);
    let y0 = (rect.y as i64).clamp(0, fy);
    let x1 = (rect.x as i64 + rect.width as i64).clamp(0, fx);
    let y1 = (rect.y as i64 + rect.height as i64).clamp(0, fy);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let cw = (x1 - x0) as usize;
    let ch = (y1 - y0) as usize;
    let mut out = vec![0u8; cw * ch * 4];
    for row in 0..ch {
        let src = ((y0 as usize + row) * width as usize + x0 as usize) * 4;
        let dst = row * cw * 4;
        out[dst..dst + cw * 4].copy_from_slice(&rgba[src..src + cw * 4]);
    }
    Some((out, cw as u32, ch as u32))
}

/// Brightest-pixel luma of an RGBA name-strip crop — the "is this row
/// alive?" signal. The Tab panel renders alive players' nicknames in
/// near-white glyphs and sunk players' in dim gray, so the strip's MAXIMUM
/// luma (the glyph cores, immune to the dark background) separates the two
/// states cleanly: measured on the #372 tab dumps at 3072x1920, sunk rows
/// peak at ≤ ~137 while every alive row — including the player's own
/// highlight-dimmed row — reaches ≥ ~186. The 95th percentile behaves the
/// same but adds nothing; the max is the cheaper and better-separated
/// statistic.
pub(crate) fn strip_max_luma(crop_rgba: &[u8]) -> f32 {
    crop_rgba
        .chunks_exact(4)
        .map(|p| 0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2]))
        .fold(0.0f32, f32::max)
}

/// Luma midpoint between the measured populations (sunk ≤ ~137, alive
/// ≥ ~186 on 3072x1920 dumps; a half-resolution capture halves neither —
/// glyphs saturate at 255 either way). Rows at or above it read as alive.
pub(crate) const SUNK_ROW_MAX_LUMA: f32 = 160.0;

/// Classify one row's strip: alive unless the brightest glyph core stayed
/// clearly under the near-white alive population. Pure companion of
/// [`strip_max_luma`] so the threshold decision is unit-testable alone.
pub(crate) fn row_strip_alive(max_luma: f32) -> bool {
    max_luma >= SUNK_ROW_MAX_LUMA
}

/// Name-strip crops for every row of a detected table, in `row_centers`
/// order. Elements are `None` for rows whose strip leaves the frame — the
/// sink solver treats those as unfingerprintable, never guesses.
pub(crate) fn crop_row_name_strips(
    rgba: &[u8],
    width: u32,
    height: u32,
    table: StripTable<'_>,
    profile: &DetectProfile,
) -> Vec<Option<(Vec<u8>, u32, u32)>> {
    (0..table.row_centers.len())
        .map(|row| {
            row_name_strip_rect(table, row, profile)
                .and_then(|rect| crop_rgba(rgba, width, height, &rect))
        })
        .collect()
}

/// Per-row alive flags read off the CURRENT frame at the given roster
/// geometry — no OCR, no detection, no roster read: one name-strip crop per
/// row classified by its brightest-glyph luma ([`strip_max_luma`] +
/// [`row_strip_alive`]). This is the Tab watcher's SINK FAST-PATH: cheap
/// enough to run a few times per second while the overlay is up, so a ship
/// sinking is seen in ~500 ms instead of waiting for the next full
/// revalidation. Unreadable rows default to alive — a missing strip must
/// never read as "sunk".
pub(crate) fn read_row_alive(
    rgba: &[u8],
    width: u32,
    height: u32,
    table: StripTable<'_>,
    profile: &DetectProfile,
) -> Vec<bool> {
    crop_row_name_strips(rgba, width, height, table, profile)
        .into_iter()
        .map(|strip| match strip {
            Some((buf, _, _)) => row_strip_alive(strip_max_luma(&buf)),
            None => true,
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────
// Name-strip fingerprint matching (the sink attribution engine)
// ─────────────────────────────────────────────────────────────────────────

/// Fingerprint grid resolution for one name strip. Wide and short, like
/// the strips themselves: 48x12 keeps glyph-shape detail at a fraction of
/// the raw crop's cost and makes thumbs from different captures directly
/// comparable (the pooling maps any strip size onto the same grid).
pub(crate) const STRIP_THUMB_W: usize = 48;
pub(crate) const STRIP_THUMB_H: usize = 12;

/// One name strip's occupancy fingerprint: per grid cell the FRACTION of
/// pixels above the strip's own binarization threshold (0.0..1.0). The
/// per-strip adaptive threshold is what makes this comparable across
/// frames — the Tab table's translucent plate rides over whatever the
/// scene behind it shows, so absolute luma drifts between Tab holds while
/// the glyph coverage pattern does not.
pub(crate) type StripThumb = [f32; STRIP_THUMB_W * STRIP_THUMB_H];

/// Minimum soft-IoU for two thumbs to count as the SAME row content, and
/// the margin the structural checks tolerate. Calibrated against synthetic
/// strips: same text at different background brightness + noise lands well
/// above it, different texts well below (see the tests below).
pub(crate) const STRIP_MATCH_THRESHOLD: f32 = 0.55;

/// Build one strip's occupancy fingerprint: Otsu-threshold the luma
/// histogram (glyphs are the bright population, the table plate the dark
/// one — whichever absolute levels the scene behind the plate produces),
/// then pool the binary mask onto the fixed grid. Returns `None` for an
/// empty crop (the caller treats the row as unfingerprintable, never as a
/// match).
pub(crate) fn strip_thumb(crop_rgba: &[u8], cw: u32, ch: u32) -> Option<StripThumb> {
    if cw == 0 || ch == 0 || crop_rgba.len() < (cw as usize) * (ch as usize) * 4 {
        return None;
    }
    // 256-bin luma histogram over the strip.
    let mut hist = [0u32; 256];
    let mut luma = Vec::with_capacity((cw as usize) * (ch as usize));
    for p in crop_rgba.chunks_exact(4) {
        let l = (0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2]))
            .round()
            .clamp(0.0, 255.0) as u8;
        hist[l as usize] += 1;
        luma.push(l);
    }
    let total = (cw as usize) * (ch as usize);
    // Otsu: maximize the between-class variance over all split points.
    let mut sum_all = 0u64;
    for (v, n) in hist.iter().enumerate() {
        sum_all += (v as u64) * (*n as u64);
    }
    let (mut best_t, mut best_var, mut w0, mut sum0) = (0u8, -1.0f32, 0u64, 0u64);
    for t in 0..256u32 {
        w0 += u64::from(hist[t as usize]);
        if w0 == 0 || w0 as usize == total {
            continue;
        }
        sum0 += u64::from(t) * u64::from(hist[t as usize]);
        let w1 = total as u64 - w0;
        let m0 = sum0 as f32 / w0 as f32;
        let m1 = (sum_all - sum0) as f32 / w1 as f32;
        let var = (w0 as f32 * w1 as f32) * (m0 - m1) * (m0 - m1);
        if var > best_var {
            best_var = var;
            best_t = t as u8;
        }
    }
    // Pool the thresholded mask onto the fixed grid. Cell occupancy is the
    // fraction of its pixels above the threshold — a soft, sub-pixel-tolerant
    // shape descriptor rather than a hard bitmap.
    let mut thumb = [0f32; STRIP_THUMB_W * STRIP_THUMB_H];
    for gy in 0..STRIP_THUMB_H {
        let y0 = (gy * ch as usize) / STRIP_THUMB_H;
        let y1 = (((gy + 1) * ch as usize) / STRIP_THUMB_H).max(y0 + 1);
        for gx in 0..STRIP_THUMB_W {
            let x0 = (gx * cw as usize) / STRIP_THUMB_W;
            let x1 = (((gx + 1) * cw as usize) / STRIP_THUMB_W).max(x0 + 1);
            let (mut on, mut cnt) = (0u32, 0u32);
            for y in y0..y1.min(ch as usize) {
                for x in x0..x1.min(cw as usize) {
                    cnt += 1;
                    if luma[y * cw as usize + x] > best_t {
                        on += 1;
                    }
                }
            }
            thumb[gy * STRIP_THUMB_W + gx] = if cnt == 0 {
                0.0
            } else {
                on as f32 / cnt as f32
            };
        }
    }
    Some(thumb)
}

/// Soft IoU between two thumbs: Σmin / Σmax over the occupancy grids. 1.0
/// for identical shapes, ~0 for disjoint ones; robust to small sub-pixel
/// shifts because neighboring cells share fractional coverage. Two
/// (near-)empty strips read as identical — an empty strip carries no
/// identity, and the STRUCTURAL solver below is what prevents that from
/// misattributing anything.
pub(crate) fn thumb_similarity(a: &StripThumb, b: &StripThumb) -> f32 {
    let (mut inter, mut union) = (0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b.iter()) {
        inter += (*x).min(*y);
        union += (*x).max(*y);
    }
    if union < 1e-6 { 1.0 } else { inter / union }
}

/// Solve ONE side's sink transition from strip fingerprints: which of the
/// OLD alive rows (indices into this side's block) hold the players that
/// just sank.
///
/// The game re-sorts on every sink ([alive by Tab key] ++ [sunk by Tab
/// key]), so the new frame's strips are the old ones REARRANGED: the new
/// alive block is the old alive block minus the victims (order preserved),
/// and each victim's strip — binarized, so its new DIM rendering still
/// matches its old bright one — reappears inside the new sunk block. The
/// solver exploits exactly that structure:
///
/// 1. every NEW SUNK row must match some OLD row (a victim's old alive
///    row, or an already-sunk row that kept its place) above the
///    threshold;
/// 2. the claimed old-ALIVE rows are the victims — their count must equal
///    the alive-count drop, with no double claims;
/// 3. the claims on old-SUNK rows must stay in increasing order (both
///    blocks re-sort by the same key, so survivors keep their relative
///    order);
/// 4. the new ALIVE block must match the old alive block minus the
///    victims, cell for cell.
///
/// Any violation — glare-distorted strips, a multi-ship rewrite the
/// pattern cannot explain, an unreadable row — returns `None`, and the
/// caller falls back to the range candidates for that transition. Never a
/// guess.
pub(crate) fn sink_victims(
    old: &[Option<StripThumb>],
    new: &[Option<StripThumb>],
    old_alive: usize,
    new_alive: usize,
) -> Option<Vec<usize>> {
    if old.len() != new.len() || old_alive > old.len() || new_alive > new.len() {
        return None;
    }
    let n = old.len();
    if new_alive >= old_alive {
        return None; // not a sink transition (revive or unchanged)
    }
    let victims_n = old_alive - new_alive;
    if old.iter().any(Option::is_none) || new.iter().any(Option::is_none) {
        return None;
    }
    let old: Vec<&StripThumb> = old.iter().map(|t| t.as_ref().expect("checked")).collect();
    let new: Vec<&StripThumb> = new.iter().map(|t| t.as_ref().expect("checked")).collect();

    // 1+2: match every new sunk row to its best old row; claims on old
    // alive rows are the victims.
    let mut victims: Vec<usize> = Vec::with_capacity(victims_n);
    let mut sunk_claims: Vec<usize> = Vec::with_capacity(n - old_alive);
    for (_j, nj) in new.iter().enumerate().skip(new_alive) {
        let (mut best, mut best_s) = (usize::MAX, -1.0f32);
        for (i, o) in old.iter().enumerate() {
            let s = thumb_similarity(nj, o);
            if s > best_s {
                best_s = s;
                best = i;
            }
        }
        if best_s < STRIP_MATCH_THRESHOLD {
            return None;
        }
        if best < old_alive {
            if victims.contains(&best) {
                return None; // two new rows claim the same victim
            }
            victims.push(best);
        } else {
            sunk_claims.push(best);
        }
    }
    if victims.len() != victims_n {
        return None;
    }
    // 3: already-sunk survivors keep their relative order.
    if !sunk_claims.windows(2).all(|w| w[0] < w[1]) {
        return None;
    }
    // 4: the new alive block is the old alive block minus the victims.
    let expected: Vec<usize> = (0..old_alive).filter(|i| !victims.contains(i)).collect();
    for (j, e) in expected.iter().enumerate() {
        if thumb_similarity(new[j], old[*e]) < STRIP_MATCH_THRESHOLD {
            return None;
        }
    }
    Some(victims)
}
