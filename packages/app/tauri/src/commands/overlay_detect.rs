//! Team-list (roster) region detector for the in-game overlay (Mode 2 / M8).
//!
//! Pure image analysis over an RGBA screenshot of the game window — no Win32
//! types in here, so the whole pipeline is unit-testable against synthetic
//! frames (see the tests at the bottom).
//!
//! Detection strategy (calibrated against real captures): the Tab table is a
//! TRANSLUCENT panel — dark on dark maps, light on bright maps — so
//! luminance projections are unreliable. The two team HEADER bars, however,
//! are solid saturated color in every mode and every map: green ("my team",
//! left half) and red (enemy, right half). The locator anchors on those two
//! bars for the table's x-range and top edge, derives the row pitch from the
//! header height (header ≈ 27 px, row pitch ≈ 40 px at 1080p → ×1.45), and
//! lays out `expected_players` row centers.
//!
//! The battle-scene gate (bottom) is deliberately permissive: the health bar
//! OR a few ship-icon blobs anywhere in the top band — port, login and
//! loading screens have neither, so the gate only has to exclude those.
//! Roster layouts differ between PvP / scenarios / co-op, so the icon probe
//! is position-agnostic by design.

use wowsp_tauri_shared::Rect;

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
const ICON_MIN_W: u32 = 10;
const ICON_MAX_W: u32 = 120;
const ICON_MIN_H: u32 = 3;
const ICON_MAX_H: u32 = 48;
/// Bright threshold for icon pixels (silhouettes are near-white).
const ICON_LUMA: u8 = 165;
/// The gate is intentionally permissive: ANY single feature — the health
/// bar OR a couple of ship-icon blobs — is enough to call it the battle
/// scene, because port / login / loading screens have none of them.
const ICON_BLOBS_MIN: u32 = 3;
/// (y, x_start, x_end) bright run collected by the icon scanner.
type IconRun = (u32, u32, u32);
/// One scan row's longest green and red runs (header search).
type HeaderRuns = (Option<(u32, u32)>, Option<(u32, u32)>);
/// The best header row seen so far: (y, green range, red range, total width).
type BestHeader = (u32, (u32, u32), (u32, u32), u32);

/// Team-header search band (fraction of frame height). The Tab table's
/// green/red header bars sit around ~23-26% on a 1080p client.
const HEADER_Y0_FRAC: f32 = 0.10;
const HEADER_Y1_FRAC: f32 = 0.45;
/// Header x-search range (the table spans the middle ~47% of the frame).
const HEADER_X0_FRAC: f32 = 0.15;
const HEADER_X1_FRAC: f32 = 0.85;
/// A header bar must be at least this wide (real: ~23% of frame width).
const HEADER_MIN_RUN_FRAC: f32 = 0.08;
/// Row pitch relative to the header height (calibrated: 27 px header,
/// ~40 px row pitch at 1080p).
const PITCH_PER_HEADER: f32 = 1.45;

/// Detector output: everything needed to anchor the overlay chips, in
/// physical pixels relative to the capture (game window) origin.
#[derive(Debug, Clone)]
pub(crate) struct DetectedRoster {
    /// The team-list panel rectangle.
    pub rect: Rect,
    /// Vertical center of each mapped player row, top to bottom.
    pub row_centers: Vec<i32>,
    /// Allies/enemies column split as a fraction (0-1) of the rect width.
    pub team_split: f32,
}

// ─────────────────────────────────────────────────────────────────────────
// Team-table locator (header-anchored)
// ─────────────────────────────────────────────────────────────────────────

/// Locate the team table via its green/red header bars.
///
/// `expected_players` is the per-team player count from `tempArenaInfo.json`
/// (0 = unknown); it decides how many rows the table has.
pub(crate) fn detect_roster(
    rgba: &[u8],
    width: u32,
    height: u32,
    expected_players: usize,
) -> Option<DetectedRoster> {
    if width < 64 || height < 64 {
        return None;
    }
    let px = |x: u32, y: u32| -> (u8, u8, u8) {
        let i = ((y * width + x) * 4) as usize;
        (rgba[i], rgba[i + 1], rgba[i + 2])
    };
    let is_header_green = |c: (u8, u8, u8)| {
        let (r, g, b) = (u16::from(c.0), u16::from(c.1), u16::from(c.2));
        g > 110 && g > r + 30 && g > b + 25
    };
    let is_header_red = |c: (u8, u8, u8)| {
        let (r, g, b) = (u16::from(c.0), u16::from(c.1), u16::from(c.2));
        r > 140 && r > g + 50 && r > b + 40
    };

    let min_run = (width as f32 * HEADER_MIN_RUN_FRAC) as u32;
    let y0 = (height as f32 * HEADER_Y0_FRAC) as u32;
    let y1 = (height as f32 * HEADER_Y1_FRAC).min(height as f32 - 1.0) as u32;
    let x0 = (width as f32 * HEADER_X0_FRAC) as u32;
    let x1 = (width as f32 * HEADER_X1_FRAC).min(width as f32 - 1.0) as u32;
    if x1 <= x0 || y1 <= y0 {
        return None;
    }

    // Scan the header band for the row carrying BOTH the longest green run
    // and the longest red run.
    let mut best: Option<BestHeader> = None;
    for y in y0..y1 {
        let (gr, rr) = longest_two_runs(&px, x0, x1, y, &is_header_green, &is_header_red);
        if let (Some(g), Some(r)) = (gr, rr) {
            if g.1 - g.0 >= min_run && r.1 - r.0 >= min_run {
                let total = (g.1 - g.0) + (r.1 - r.0);
                if best.is_none_or(|(_, _, _, t)| total > t) {
                    best = Some((y, g, r, total));
                }
            }
        }
    }
    let (hy, (gx0, gx1), (rx0, rx1), _) = best?;

    // Header height: scan down at the green run's center until it stops
    // being header-green.
    let cx = (gx0 + gx1) / 2;
    let mut header_h = 0u32;
    let mut y = hy;
    while y < height - 1 && is_header_green(px(cx, y)) {
        header_h += 1;
        y += 1;
    }
    if !(6..=height / 8).contains(&header_h) {
        return None;
    }

    // Table geometry. Row pitch is calibrated off the header height, which
    // scales with the client's UI scale.
    let pitch = header_h as f32 * PITCH_PER_HEADER;
    let header_bottom = hy + header_h;
    let max_bottom = height * 92 / 100;
    let rows = if expected_players > 0 {
        expected_players
    } else {
        let fit = ((max_bottom - header_bottom) as f32 / pitch) as usize;
        fit.clamp(2, 15)
    };
    let table_h = header_h + (pitch * rows as f32) as u32;
    if header_bottom as f32 + pitch * rows as f32 > height as f32 {
        return None;
    }

    let rect = Rect {
        x: gx0 as i32,
        y: hy as i32,
        width: (rx1 - gx0) as i32,
        height: table_h as i32,
    };
    let row_centers = (0..rows)
        .map(|i| (header_bottom as f32 + pitch * (i as f32 + 0.5)).round() as i32)
        .collect();
    let seam = (gx1 + rx0) as f32 / 2.0;
    let team_split = (seam - gx0 as f32) / (rx1 - gx0) as f32;

    Some(DetectedRoster {
        rect,
        row_centers,
        team_split: team_split.clamp(0.3, 0.7),
    })
}

/// One scan row: find the longest green run and the longest red run
/// (x ranges, end-exclusive). Independent scans — the bars are far apart.
fn longest_two_runs(
    px: &impl Fn(u32, u32) -> (u8, u8, u8),
    x0: u32,
    x1: u32,
    y: u32,
    green: &impl Fn((u8, u8, u8)) -> bool,
    red: &impl Fn((u8, u8, u8)) -> bool,
) -> HeaderRuns {
    let mut best_g: Option<(u32, u32)> = None;
    let mut best_r: Option<(u32, u32)> = None;
    let mut cur_g: Option<(u32, u32)> = None;
    let mut cur_r: Option<(u32, u32)> = None;
    for x in x0..x1 {
        let c = px(x, y);
        if green(c) {
            cur_g = Some(match cur_g {
                Some((s, _)) => (s, x),
                None => (x, x),
            });
        } else if let Some((s, e)) = cur_g.take() {
            if best_g.is_none_or(|(bs, be)| e - s > be - bs) {
                best_g = Some((s, e));
            }
        }
        if red(c) {
            cur_r = Some(match cur_r {
                Some((s, _)) => (s, x),
                None => (x, x),
            });
        } else if let Some((s, e)) = cur_r.take() {
            if best_r.is_none_or(|(bs, be)| e - s > be - bs) {
                best_r = Some((s, e));
            }
        }
    }
    if let Some((s, e)) = cur_g {
        if best_g.is_none_or(|(bs, be)| e - s > be - bs) {
            best_g = Some((s, e));
        }
    }
    if let Some((s, e)) = cur_r {
        if best_r.is_none_or(|(bs, be)| e - s > be - bs) {
            best_r = Some((s, e));
        }
    }
    (best_g, best_r)
}

// ─────────────────────────────────────────────────────────────────────────
// Battle-scene gate
// ─────────────────────────────────────────────────────────────────────────

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
        // Permissive by design: ANY single feature — the health bar OR a
        // couple of ship-icon blobs — is enough to call it the battle
        // scene, because port / login / loading screens have none of them.
        self.hp_bar || self.icon_blobs >= ICON_BLOBS_MIN
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
    let is_green =
        |c: (u8, u8, u8)| c.1 > 90 && c.1 as u16 > c.0 as u16 + 25 && c.1 as u16 > c.2 as u16 + 25;

    // ── HP bar: longest horizontal run of green in the bottom-left region ──
    let x0 = width * 2 / 100;
    let x1 = (width * 25 / 100).min(width.saturating_sub(1));
    let y0 = height * 70 / 100;
    let y1 = (height * 95 / 100).min(height.saturating_sub(1));
    if x1 <= x0 || y1 <= y0 {
        return none;
    }
    let mut hp_found = false;
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

    let icon_blobs = count_icon_blobs(
        &px,
        width * 2 / 100,
        (width * 98 / 100).min(width.saturating_sub(1)),
        height * 8 / 100,
        (height * 35 / 100).min(height.saturating_sub(1)),
    );
    SceneProbe {
        hp_bar: hp_found,
        icon_blobs,
    }
}

/// Gate helper: the full HUD must be present.
pub(crate) fn detect_battle_scene(rgba: &[u8], width: u32, height: u32) -> bool {
    probe_battle_scene(rgba, width, height).detected()
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
    let mut runs: Vec<IconRun> = Vec::new();
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

    const W: u32 = 1920;
    const H: u32 = 1080;
    /// Table geometry per the real 1080p client (fractions of the frame).
    const TX: u32 = W * 26 / 100; // 499
    const TW: u32 = W * 47 / 100; // 902
    const TY: u32 = H * 23 / 100; // 248
    const HEADER_H: u32 = 28;
    const ROW_PITCH: u32 = 40;
    const ROWS: usize = 5;

    /// Bright noisy scene (day map) + the translucent LIGHT table with its
    /// green/red header bars — the exact frame shape that defeated the old
    /// dark-projection detector.
    fn realistic_frame() -> Vec<u8> {
        let mut img = vec![0u8; (W * H * 4) as usize];
        let mut noise = Noise(0xfeed_beef);
        for y in 0..H {
            for x in 0..W {
                let i = ((y * W + x) * 4) as usize;
                let l = noise.next_f32(125.0, 175.0) as u8;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
            let i = ((y * W + x) * 4) as usize;
            img[i] = c.0;
            img[i + 1] = c.1;
            img[i + 2] = c.2;
            img[i + 3] = 255;
        };
        let seam = TX + TW / 2;
        // Light translucent body (the scene seen through a whitish panel).
        let body_h = HEADER_H + ROWS as u32 * ROW_PITCH;
        for y in TY..TY + body_h {
            for x in TX..TX + TW {
                if x.abs_diff(seam) < 8 {
                    continue;
                }
                let shade = (150 + ((y - TY) / ROW_PITCH % 2) * 12) as u8;
                put(&mut img, x, y, (shade, shade, shade.saturating_add(4)));
            }
        }
        // Solid green / red header bars.
        for y in TY..TY + HEADER_H {
            for x in TX + 4..seam - 8 {
                put(&mut img, x, y, (63, 174, 109));
            }
            for x in seam + 8..TX + TW - 4 {
                put(&mut img, x, y, (224, 106, 90));
            }
        }
        img
    }

    #[test]
    fn detects_header_anchored_table_5v5() {
        let img = realistic_frame();
        let det = detect_roster(&img, W, H, 5).expect("table must be detected");
        let r = det.rect;
        assert!(
            (r.x as f32 - TX as f32).abs() <= W as f32 * 0.02,
            "x: {r:?}"
        );
        assert!(
            (r.y as f32 - TY as f32).abs() <= H as f32 * 0.02,
            "y: {r:?}"
        );
        assert_eq!(det.row_centers.len(), 5);
        for &c in &det.row_centers {
            assert!(
                c > (TY + HEADER_H) as i32 && c < (TY + HEADER_H + ROWS as u32 * ROW_PITCH) as i32,
                "center {c} outside the row band"
            );
        }
        assert!(
            (det.team_split - 0.5).abs() <= 0.08,
            "split {}",
            det.team_split
        );
    }

    #[test]
    fn caps_rows_to_expected() {
        let img = realistic_frame();
        let det = detect_roster(&img, W, H, 3).expect("detect");
        assert_eq!(det.row_centers.len(), 3);
    }

    #[test]
    fn returns_none_without_headers() {
        let mut img = vec![0u8; (W * H * 4) as usize];
        let mut noise = Noise(0x1234_5678);
        for y in 0..H {
            for x in 0..W {
                let i = ((y * W + x) * 4) as usize;
                let l = noise.next_f32(125.0, 175.0) as u8;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        assert!(detect_roster(&img, W, H, 12).is_none());
    }

    #[test]
    fn works_without_arena_hint() {
        let img = realistic_frame();
        let det = detect_roster(&img, W, H, 0).expect("detect without hint");
        assert!(det.row_centers.len() >= 2);
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

    #[test]
    fn battle_scene_rejected_without_hud() {
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        // Smooth bright gradient — a sky-like scene without HUD features.
        // (Real scenes are smooth; the gate must not fire on one.)
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let l = (120 + (x * 40 / w) + (y * 30 / h)) as u8;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        assert!(!detect_battle_scene(&img, w, h));
    }

    #[test]
    fn battle_scene_passes_on_any_single_feature() {
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let l = (120 + (x * 40 / w) + (y * 30 / h)) as u8;
                img[i] = l;
                img[i + 1] = l;
                img[i + 2] = l;
                img[i + 3] = 255;
            }
        }
        // Ship icons alone (a few blobs, no HP bar) are enough.
        for (bx, by) in [(400u32, 120u32), (700, 160), (1000, 110)] {
            for y in by..by + 10 {
                for x in bx..bx + 30 {
                    let i = ((y * w + x) * 4) as usize;
                    img[i] = 210;
                    img[i + 1] = 214;
                    img[i + 2] = 218;
                }
            }
        }
        assert!(detect_battle_scene(&img, w, h));
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
