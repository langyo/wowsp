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
    synth_table(w, h, rows, 0, 0.92)
}

/// [`synth_header_table`] with the whole table drawn `x_shift` physical
/// px to the (right when positive / left when negative) side — the
/// horizontal-slide scenario the band verify's counter-evidence
/// columns exist to catch.
fn synth_header_table_at(w: u32, h: u32, rows: usize, x_shift: i32) -> (Vec<u8>, Rect, Vec<f32>) {
    synth_table(w, h, rows, x_shift, 0.92)
}

/// [`synth_header_table`] with an explicit row-pitch factor (the ratio
/// measured across real clients spans 0.89–0.95; the fit tests draw
/// the extremes either side of the 0.92 prior).
fn synth_table(
    w: u32,
    h: u32,
    rows: usize,
    x_shift: i32,
    pitch_factor: f32,
) -> (Vec<u8>, Rect, Vec<f32>) {
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
    let tx = ((w as f32 * 0.26) as i32 + x_shift).max(0) as u32;
    let tw = (w as f32 * 0.47) as u32;
    let ty = (h as f32 * 0.22) as u32;
    let seam = tx + tw / 2;
    let bar_h = (h as f32 * 0.028) as u32; // ≈ header bar height
    let pitch = ((bar_h as f32 * pitch_factor) as u32).max(12);
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

/// Lesta (Мир кораблей) scoreboard synth: proportions measured on a real
/// 3072x1920 capture — bars ~26% of the width each with a ~9.5% center
/// seam (WG: ~18-20% bars, ~3% seam), rows exactly one bar-height apart
/// (pitch factor 1.00; WG 0.92), and BOTH name columns left-aligned in
/// their panels (WG's enemy names right-align).
fn synth_lesta_table(w: u32, h: u32, rows: usize) -> (Vec<u8>, Rect, Vec<f32>) {
    let mut img = vec![0u8; (w * h * 4) as usize];
    let mut noise = Noise(0x9abC_def0);
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
    let tx = (w as f32 * 0.176) as u32;
    let tw = (w as f32 * 0.625) as u32;
    let ty = (h as f32 * 0.0875) as u32;
    let bar_h = (h as f32 * 0.0292) as u32;
    let pitch = bar_h; // measured 56/56 px @1920p — factor 1.00
    let green_x1 = tx + (w as f32 * 0.264) as u32;
    let red_x0 = tx + (w as f32 * 0.359) as u32;
    let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
        let i = ((y * w + x) * 4) as usize;
        img[i] = c.0;
        img[i + 1] = c.1;
        img[i + 2] = c.2;
        img[i + 3] = 255;
    };
    // Header bars, white captions punched into the middle (both pass the
    // shared WG predicates: measured rgb(90,153,150) / rgb(160,90,99)).
    let lesta_teal = (90u8, 153, 150);
    let lesta_brick = (160u8, 90, 99);
    for y in ty..ty + bar_h {
        for x in tx..green_x1 {
            put(&mut img, x, y, lesta_teal);
        }
        for x in red_x0..tx + tw {
            put(&mut img, x, y, lesta_brick);
        }
    }
    // Captions near the panels' OUTER edges: the longest colored run of
    // a caption row must stay the seam-hugging segment (the adjacency
    // gate measures green END → red START); the real Lesta captions leave
    // exactly that.
    for y in ty + 2..ty + bar_h - 2 {
        for x in tx + 4..tx + 4 + (green_x1 - tx) / 4 {
            put(&mut img, x, y, (245, 245, 245));
        }
        for x in tx + tw - 4 - (tx + tw - red_x0) / 4..tx + tw - 4 {
            put(&mut img, x, y, (245, 245, 245));
        }
    }
    // Player rows: white name text LEFT-aligned in BOTH panels (measured
    // ally ≈ 0.00-0.33, enemy ≈ 0.58-0.88 of the table rect).
    let name_w = (tw as f32 * 0.20) as u32;
    let mut centers = Vec::new();
    for k in 0..rows {
        let yc = ty as f32 + bar_h as f32 + pitch as f32 * (k as f32 + 0.5);
        centers.push(yc);
        let y0 = yc as u32;
        for y in y0..(y0 + 8).min(ty + bar_h + pitch * (k as u32 + 1)) {
            for x in tx + 4..tx + 4 + name_w {
                put(&mut img, x, y, (240, 240, 240));
            }
            for x in red_x0 + 4..red_x0 + 4 + name_w {
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

/// The Lesta layout is detected with the Lesta profile, and the grid
/// tracks the true row centers (pitch = exactly one bar height).
#[test]
fn detects_lesta_layout_with_the_lesta_profile() {
    let (w, h) = (1600u32, 900u32);
    let rows = 12;
    let (img, _rect, truth) = synth_lesta_table(w, h, rows);
    let det = detect_roster(&img, w, h, (rows, rows), &DetectProfile::LESTA)
        .expect("Lesta table must be detected");
    assert_eq!(det.row_centers.len(), rows * 2);
    // Ally block (first `rows` centers) tracks the synth grid.
    for (got, want) in det.row_centers.iter().take(rows).zip(&truth) {
        assert!(
            (got - *want as i32).abs() <= 3,
            "row center {got} vs truth {want}"
        );
    }
}

/// The WG profile on the Lesta layout is the failure this split exists
/// for: the true pitch (1.00 x bar) sits outside the WG prior's
/// plausibility clamp (0.80..1.05 x 0.92 x bar), so the grid keeps the
/// WG prior and drifts off the bottom rows — the Lesta profile must be
/// measurably tighter.
#[test]
fn wg_profile_drifts_on_the_lesta_layout() {
    let (w, h) = (1600u32, 900u32);
    let rows = 12;
    let (img, _rect, truth) = synth_lesta_table(w, h, rows);
    let det = detect_roster(&img, w, h, (rows, rows), &DetectProfile::WG)
        .expect("detection still anchors (bars pass the shared gates)");
    let lesta_err = det
        .row_centers
        .iter()
        .take(rows)
        .zip(&truth)
        .map(|(got, want)| (got - *want as i32).abs())
        .max()
        .unwrap();
    assert!(
        lesta_err >= 5,
        "WG-prior grid should drift on the Lesta layout (max err {lesta_err}px)"
    );
}

/// Lesta name strips must actually COVER the drawn name columns of the
/// synth (both panels, left-aligned) — pinned as per-row x-overlap, the
/// shape the sink solver's luma/fingerprint reads depend on. The WG
/// enemy window, right-aligned, starts right of the Lesta enemy column.
#[test]
fn lesta_name_strips_cover_the_left_aligned_columns() {
    let (w, h) = (1600u32, 900u32);
    let rows = 6;
    let (img, _rect, _centers) = synth_lesta_table(w, h, rows);
    let det = detect_roster(&img, w, h, (rows, rows), &DetectProfile::LESTA)
        .expect("Lesta table detected");
    // Where the synth drew the names (mirrors synth_lesta_table).
    let tx = (w as f32 * 0.176) as i32;
    let tw = (w as f32 * 0.625) as i32;
    let red_x0 = tx + (w as f32 * 0.359) as i32;
    let name_w = (tw as f32 * 0.20) as i32;
    let ally_names = (tx + 4, tx + 4 + name_w);
    let enemy_names = (red_x0 + 4, red_x0 + 4 + name_w);
    // The DETECTED grid (both blocks: allies then enemies) is what the
    // strip readers run against in production.
    assert_eq!(det.row_centers.len(), rows * 2);
    let table = StripTable {
        roster: &det.rect,
        row_centers: &det.row_centers,
        team_split: det.team_split,
        ally_rows: rows,
    };
    for row in 0..rows {
        let ally = row_name_strip_rect(table, row, &DetectProfile::LESTA)
            .unwrap_or_else(|| panic!("ally strip for row {row}"));
        assert!(
            ally.x <= ally_names.1 && ally.x + ally.width >= ally_names.0,
            "ally strip {ally:?} misses the name column {ally_names:?}"
        );
        let enemy = row_name_strip_rect(table, rows + row, &DetectProfile::LESTA)
            .unwrap_or_else(|| panic!("enemy strip for row {row}"));
        assert!(
            enemy.x <= enemy_names.1 && enemy.x + enemy.width >= enemy_names.0,
            "enemy strip {enemy:?} misses the name column {enemy_names:?}"
        );
    }
    // The WG enemy window misses the Lesta enemy column's left edge.
    let wg_enemy = row_name_strip_rect(table, rows, &DetectProfile::WG).unwrap();
    assert!(
        wg_enemy.x > enemy_names.0,
        "WG enemy strip should start right of the Lesta names ({wg_enemy:?} vs {enemy_names:?})"
    );
}

/// Profile selection: only the Lesta kind gets the Lesta layout.
#[test]
fn detect_profile_selects_by_install_kind() {
    use wowsp_tauri_shared::GameInstallKind;
    assert_eq!(
        DetectProfile::for_kind(&GameInstallKind::Lesta),
        DetectProfile::LESTA
    );
    for kind in [
        GameInstallKind::Wargaming,
        GameInstallKind::Steam,
        GameInstallKind::Cn360,
        GameInstallKind::CnKongzhong,
        GameInstallKind::Manual,
    ] {
        assert_eq!(DetectProfile::for_kind(&kind), DetectProfile::WG);
    }
}

#[test]
fn detects_header_anchored_table_12v12() {
    let (w, h) = (1280u32, 720u32);
    let (img, rect, centers) = synth_header_table(w, h, 12);
    let det =
        detect_roster(&img, w, h, (12, 12), &DetectProfile::WG).expect("table must be detected");
    assert_eq!(det.row_centers.len(), 24, "12 allies + 12 enemies");
    assert!((det.rect.x - rect.x).abs() <= 12, "x: {rect:?} vs {det:?}");
    assert!((det.rect.y - rect.y).abs() <= 12, "y: {rect:?} vs {det:?}");
    assert!(
        (det.rect.width - rect.width).abs() <= 24,
        "w: {rect:?} vs {det:?}"
    );
    for (k, &c) in det.row_centers.iter().take(12).enumerate() {
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
    let det =
        detect_roster(&img, w, h, (6, 6), &DetectProfile::WG).expect("table must be detected");
    assert_eq!(det.row_centers.len(), 12, "6 allies + 6 enemies");
    for (k, &c) in det.row_centers.iter().take(6).enumerate() {
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
    let det = detect_roster(&img, w, h, (5, 5), &DetectProfile::WG)
        .expect("partial table must still anchor");
    // Two blocks: allies + enemies, each the arena hint's count.
    assert_eq!(det.row_centers.len(), 10, "5 + 5 centers");
    for (k, &c) in det.row_centers.iter().take(5).enumerate() {
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
    let png = include_bytes!("../testdata/tab_table_768x480.png");
    let img = image::load_from_memory(png)
        .expect("fixture decodes")
        .to_rgba8();
    let (w, h) = img.dimensions();
    assert_eq!((w, h), (768, 480));
    let rgba = img.into_raw();
    let det = detect_roster(&rgba, w, h, (5, 5), &DetectProfile::WG)
        .expect("real table must be detected");
    assert_eq!(det.row_centers.len(), 10, "5 allies + 5 enemies");
    // Truth (physical px of the source capture ÷ 4): header top 444→111,
    // bars 796..2274 → 199..568.5, row centers ≈ 531/583/635/687/739 ÷ 4.
    let truth: [f32; 5] = [132.75, 145.75, 158.75, 171.75, 184.75];
    for (k, &c) in det.row_centers.iter().take(5).enumerate() {
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

/// The REAL captured frame behind the scenario/operation bug report: a
/// Tab-held WG client in an operation (行动) battle — dimmed scene, 任务/
/// 团队成员 tabs, ONE centered teal "我的团队" header bar measuring only
/// ~23-24% of the frame width (the narrow green-only variant), 7 ally rows,
/// no enemy half. Downscaled to the detector's 800-wide working size from a
/// 2000×1250 capture; the operation table is centered where the two-bar
/// table splits, so the bar's own geometry (not its width) is what the
/// gates key on.
#[test]
fn detects_real_pve_operation_frame() {
    let png = include_bytes!("../testdata/tab_table_pve_800x500.png");
    let img = image::load_from_memory(png)
        .expect("fixture decodes")
        .to_rgba8();
    let (w, h) = img.dimensions();
    assert_eq!((w, h), (800, 500));
    let rgba = img.into_raw();
    let (band, det) = detect_roster_with_band(&rgba, w, h, (7, 0), &DetectProfile::WG)
        .expect("real operation table must be detected");
    assert!(band.red.is_none(), "single-team band carries no red span");
    assert_eq!(det.row_centers.len(), 7, "7 allies, no enemy half");
    assert!(
        det.team_split >= 0.999,
        "single-team split is exactly 1.0, got {}",
        det.team_split
    );
    // Truth (measured on the fixture at working scale): header band top
    // ≈116, green bar ≈ 305..497 (24% wide, center ≈ 50.1% of the frame).
    assert!((band.top as i32 - 116).abs() <= 8, "band top: {}", band.top);
    assert!(
        (band.green.0 as i32 - 305).abs() <= 14,
        "green start: {:?}",
        band.green
    );
    assert!(
        (band.green.1 as i32 - 497).abs() <= 14,
        "green end: {:?}",
        band.green
    );
    assert!(
        (det.rect.x as f32 - 305.0).abs() <= 16.0,
        "x: {:?}",
        det.rect
    );
    assert!(
        (det.rect.y as f32 - 116.0).abs() <= 12.0,
        "y: {:?}",
        det.rect
    );
    // The band detected on the fixture must also verify (the cheap path
    // every later capture takes) and prove header presence for the scene
    // gate.
    assert!(verify_header_band(&rgba, w, h, &band));
    assert!(header_bars_present(&rgba, w, h));
}

#[test]
fn returns_none_without_header_bars() {
    // Bright scene, no table → no teal+brick pair anywhere.
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 0);
    assert!(detect_roster(&img, w, h, (12, 12), &DetectProfile::WG).is_none());
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
    assert!(detect_roster(&img, w, h, (5, 5), &DetectProfile::WG).is_none());
}

/// The MOD scoreboard draws a teal bar in the top-left corner and a
/// brick bar in the top-right corner — same colors as the team headers,
/// and TOGETHER they outscored the real header by area, flinging the
/// anchor to the top of the screen (the live "drift" report). The two
/// bars are ~35% of the width apart; the adjacency gate must reject them.
#[test]
fn mod_scoreboard_corner_bars_are_rejected() {
    let (w, h) = (1280u32, 720u32);
    let (mut img, _, centers) = synth_header_table(w, h, 5);
    let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
        let i = ((y * w + x) * 4) as usize;
        img[i] = c.0;
        img[i + 1] = c.1;
        img[i + 2] = c.2;
        img[i + 3] = 255;
    };
    // Decoy bars in opposite corners at the very top, each 20% wide.
    let bw = w / 5;
    for y in 40..64 {
        for x in 20..20 + bw {
            put(&mut img, x, y, TEAL);
        }
        for x in (w - 20 - bw)..(w - 20) {
            put(&mut img, x, y, BRICK);
        }
    }
    let det = detect_roster(&img, w, h, (5, 5), &DetectProfile::WG).expect("real table must win");
    // The anchor must be on the TABLE (y ≈ 22% of the frame), not the
    // decoy (y ≈ 6%): check the first row center against the drawn rows.
    assert!(
        (det.row_centers[0] as f32 - centers[0]).abs() <= 9.0,
        "{det:?}"
    );
    assert!(
        (det.rect.y as f32 - h as f32 * 0.22).abs() <= 12.0,
        "{det:?}"
    );
}

// ── single-team PVE tables (one centered teal bar, no enemy half) ──

/// Synthetic PVE single-team table over the same kind of noisy scene as
/// [`synth_table`]: ONE teal header bar — the WIDE variant's ~58% of the
/// frame at the 10% left edge — its white team caption punched into the
/// left quarter (so the bar's FIRST quarter-point sample lands inside it —
/// the 2-of-3 sample rule exists for exactly that), and white player-name
/// text on the rows below, LEFT-anchored like the real PVE layout where the
/// nickname column hugs the table's left edge. The background noise stays
/// under the near-white threshold on purpose: a real scene behind the
/// translucent table never reads near-white across the bar's full width,
/// and the white-row-text gate (profile max × `ROW_TEXT_FRACTION`) needs
/// that floor to keep noise rows out of its band extraction. Returns the
/// frame plus the truth rect and the drawn row centers.
fn synth_single_team_table(
    w: u32,
    h: u32,
    rows: usize,
    x_shift: i32,
    with_row_text: bool,
) -> (Vec<u8>, Rect, Vec<f32>) {
    synth_single_team_table_with_bar(w, h, rows, x_shift, with_row_text, 0.58, 0.10)
}

/// Generalized core of [`synth_single_team_table`]: the teal bar's width
/// and left edge are fractions of the frame, so the NARROW centered
/// operation layout can be synthesized with the same caption/rows/noise —
/// the real current WG operation table measures ~23-24% wide with its panel
/// dead-centered (`testdata/tab_table_pve_800x500.png`).
fn synth_single_team_table_with_bar(
    w: u32,
    h: u32,
    rows: usize,
    x_shift: i32,
    with_row_text: bool,
    bar_w_frac: f32,
    bar_x_frac: f32,
) -> (Vec<u8>, Rect, Vec<f32>) {
    let mut img = vec![0u8; (w * h * 4) as usize];
    let mut noise = Noise(0x5011_7ea4);
    for y in 0..h {
        for x in 0..w {
            let l = noise.next_f32(110.0, 165.0) as u8;
            let i = ((y * w + x) * 4) as usize;
            img[i] = l;
            img[i + 1] = l;
            img[i + 2] = l;
            img[i + 3] = 255;
        }
    }
    let tx = ((w as f32 * bar_x_frac) as i32 + x_shift).max(0) as u32;
    let tw = (w as f32 * bar_w_frac) as u32;
    let ty = (h as f32 * 0.22) as u32;
    let bar_h = (h as f32 * 0.028) as u32; // ≈ header bar height
    let pitch = ((bar_h as f32 * 0.92) as u32).max(12);
    let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
        let i = ((y * w + x) * 4) as usize;
        img[i] = c.0;
        img[i + 1] = c.1;
        img[i + 2] = c.2;
        img[i + 3] = 255;
    };
    // ONE teal bar, white caption punched into its left
    // quarter (tw/6 .. tw/6 + tw*28/300 — covers the bar's first
    // quarter-point sample, misses the other two).
    for y in ty..ty + bar_h {
        for x in tx..tx + tw {
            put(&mut img, x, y, TEAL);
        }
    }
    for y in ty + 2..ty + bar_h - 2 {
        for x in tx + tw / 6..tx + tw / 6 + tw * 28 / 300 {
            put(&mut img, x, y, (245, 245, 245));
        }
    }
    // Player rows: white name text, left-anchored (the PVE nickname
    // column).
    let mut centers = Vec::new();
    for k in 0..rows {
        let yc = ty as f32 + bar_h as f32 + pitch as f32 * (k as f32 + 0.5);
        centers.push(yc);
        if with_row_text {
            let y0 = yc as u32;
            for y in y0..(y0 + 8).min(ty + bar_h + pitch * (k as u32 + 1)) {
                for x in tx + 8..tx + 8 + tw * 28 / 100 {
                    put(&mut img, x, y, (240, 240, 240));
                }
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

/// The PVE single-team table must anchor like its two-bar sibling: an
/// ally-only grid from the hint, a truth-accurate rect, and the split
/// at exactly 1.0 (the frontend maps rows without the split; the
/// backend name-strip math needs it to cover the FULL table).
#[test]
fn detects_single_team_pve_table() {
    let (w, h) = (1280u32, 720u32);
    let (img, rect, centers) = synth_single_team_table(w, h, 7, 0, true);
    let det = detect_roster(&img, w, h, (7, 0), &DetectProfile::WG)
        .expect("single-team table must be detected");
    assert_eq!(det.row_centers.len(), 7, "ally hint only — no enemy half");
    assert!((det.rect.x - rect.x).abs() <= 12, "x: {rect:?} vs {det:?}");
    assert!((det.rect.y - rect.y).abs() <= 12, "y: {rect:?} vs {det:?}");
    assert!(
        (det.rect.width - rect.width).abs() <= 24,
        "w: {rect:?} vs {det:?}"
    );
    for (k, &c) in det.row_centers.iter().enumerate() {
        assert!(
            (c as f32 - centers[k]).abs() <= 8.0,
            "row {k}: center {c} vs truth {}",
            centers[k]
        );
    }
    assert_eq!(det.team_split, 1.0, "single-team split is exactly 1.0");
}

/// A lone wide teal bar with NOTHING white below it (a teal water/sky
/// horizon, a mod panel without player names) must not anchor — the
/// white-row-text gate kills the green-only band, for the detector AND
/// for the scene gate ([`header_bars_present`]) alike.
#[test]
fn single_team_band_rejected_without_row_text() {
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_single_team_table(w, h, 7, 0, false);
    assert!(detect_roster(&img, w, h, (7, 0), &DetectProfile::WG).is_none());
    assert!(!header_bars_present(&img, w, h));
}

/// The mod-scoreboard guard must hold for the green-only path too: a
/// brick bar FARTHER right than the adjacency gap rejects every scan
/// row of the teal bar outright — the row must never degrade into a
/// green-only hit and sneak through as a single-team table.
#[test]
fn single_team_band_rejects_far_red_bar() {
    let (w, h) = (1280u32, 720u32);
    let (mut img, _, _) = synth_single_team_table(w, h, 7, 0, true);
    let put = |img: &mut [u8], x: u32, y: u32, c: (u8, u8, u8)| {
        let i = ((y * w + x) * 4) as usize;
        img[i] = c.0;
        img[i + 1] = c.1;
        img[i + 2] = c.2;
        img[i + 3] = 255;
    };
    // Same-row brick bar on the far right: the run is wide enough to
    // qualify (≥ HEADER_MIN_RUN_FRAC) and the gap ≈ 0.16 of the width —
    // beyond HEADER_MAX_BAR_GAP_FRAC.
    let ty = (h as f32 * 0.22) as u32;
    let bar_h = (h as f32 * 0.028) as u32;
    for y in ty..ty + bar_h {
        for x in w * 84 / 100..w * 95 / 100 {
            put(&mut img, x, y, BRICK);
        }
    }
    assert!(detect_roster(&img, w, h, (7, 0), &DetectProfile::WG).is_none());
    assert!(!header_bars_present(&img, w, h));
}

/// The CURRENT operation layout: a ~24%-wide teal bar with its panel
/// DEAD-CENTERED (measured 23-24% wide, center 50.2% on the real capture
/// behind `detects_real_pve_operation_frame`). Under the old width-only
/// gate (≥ 30%) this exact shape was rejected and every scenario Tab hold
/// fell to the centered "table not located" hint — the narrow centered
/// variant must anchor like the wide one.
#[test]
fn detects_narrow_centered_single_team_table() {
    let (w, h) = (1280u32, 720u32);
    let (img, rect, centers) = synth_single_team_table_with_bar(w, h, 7, 0, true, 0.24, 0.38);
    let det = detect_roster(&img, w, h, (7, 0), &DetectProfile::WG)
        .expect("narrow centered single-team table must be detected");
    assert_eq!(det.row_centers.len(), 7, "ally hint only — no enemy half");
    assert!((det.rect.x - rect.x).abs() <= 12, "x: {rect:?} vs {det:?}");
    assert!((det.rect.y - rect.y).abs() <= 12, "y: {rect:?} vs {det:?}");
    assert!(
        (det.rect.width - rect.width).abs() <= 24,
        "w: {rect:?} vs {det:?}"
    );
    for (k, &c) in det.row_centers.iter().enumerate() {
        assert!(
            (c as f32 - centers[k]).abs() <= 8.0,
            "row {k}: center {c} vs truth {}",
            centers[k]
        );
    }
    assert_eq!(det.team_split, 1.0, "single-team split is exactly 1.0");
}

/// The narrow variant's second discriminator is CENTERING, not width: a
/// lone ~24% green bar parked where a two-bar table's ally half sits —
/// spanning 26%..50% of the frame, the exact degraded-PVP geometry whose
/// center offset the real fixture measures at 0.1211 — must NOT be read as
/// a single-team table and silently drop the enemy block; nor may a mod
/// scoreboard's corner bar. Same bar, same rows, only the position
/// changes.
#[test]
fn narrow_green_only_band_rejected_when_off_center() {
    let (w, h) = (1280u32, 720u32);
    // The PVP ally-half position (a red-missed two-bar frame): ~52 px of
    // margin to the 0.08 gate, ~0.8 px to a hypothetical 0.12 gate — this
    // exact case is why the gate is not 0.12.
    let (img, _, _) = synth_single_team_table_with_bar(w, h, 7, 0, true, 0.24, 0.26);
    assert!(detect_roster(&img, w, h, (7, 0), &DetectProfile::WG).is_none());
    assert!(!header_bars_present(&img, w, h));
    // A mod scoreboard's corner bar.
    let (img, _, _) = synth_single_team_table_with_bar(w, h, 7, 0, true, 0.24, 0.05);
    assert!(detect_roster(&img, w, h, (7, 0), &DetectProfile::WG).is_none());
    assert!(!header_bars_present(&img, w, h));
}

/// The cached single-team band verifies on the frame it was detected on
/// and fails on a horizontal slide (mirror of the two-bar verify
/// tests): the interior samples sit on the wide bar either way, so the
/// counter-evidence columns — anchored on the lone bar's right end,
/// there being no red bar — are what catch the drift.
#[test]
fn verify_header_band_accepts_single_team_frame_and_rejects_shift() {
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_single_team_table(w, h, 6, 0, true);
    let (band, _) =
        detect_roster_with_band(&img, w, h, (6, 0), &DetectProfile::WG).expect("detect");
    assert!(band.red.is_none(), "single-team detection yields red: None");
    assert!(verify_header_band(&img, w, h, &band), "same frame verifies");
    // 16 physical px = 8 working px right: the teal bar now covers the
    // cached band's right counter columns.
    let (right, _, _) = synth_single_team_table(w, h, 6, 16, true);
    assert!(
        !verify_header_band(&right, w, h, &band),
        "rightward slide must fail"
    );
    // Same distance left: the bar covers the left counter columns.
    let (left, _, _) = synth_single_team_table(w, h, 6, -16, true);
    assert!(
        !verify_header_band(&left, w, h, &band),
        "leftward slide must fail"
    );
}

/// The rebuild from a cached single-team band emits EXACTLY the ally
/// block — the enemy hint (3 here) must not conjure rows for a half
/// the table does not have — with the split pinned at 1.0.
#[test]
fn rebuild_roster_from_band_single_team_builds_ally_grid_only() {
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_single_team_table(w, h, 7, 0, true);
    let (band, _) =
        detect_roster_with_band(&img, w, h, (7, 0), &DetectProfile::WG).expect("detect");
    assert!(band.red.is_none());
    let rebuilt = rebuild_roster_from_band(&band, w, h, (7, 3), None, &DetectProfile::WG);
    assert_eq!(rebuilt.row_centers.len(), 7, "enemy hint ignored");
    assert_eq!(rebuilt.team_split, 1.0);
}

/// Mirror of the two-bar pin test at 2560x1440 (work scale 4): the
/// unrefined detector can only land on a 4-px grid, so draw the
/// single-team table at an off-grid x — the native refinement must pin
/// the lone bar's edges within 1 px while keeping the split at 1.0.
#[test]
fn native_refinement_pins_single_team_edges() {
    let (w, h) = (2560u32, 1440u32);
    let scale = w.div_ceil(MAX_WORK_WIDTH) as i32;
    let tx = (w as f32 * 0.10) as i32;
    // Pick the nearest x that is NOT a multiple of the work scale.
    let mut off_grid = tx + 1;
    if off_grid.rem_euclid(scale) == 0 {
        off_grid += 1;
    }
    assert_ne!(off_grid.rem_euclid(scale), 0, "fixture must be off-grid");
    let (img, rect, centers) = synth_single_team_table(w, h, 7, off_grid - tx, true);
    assert_eq!(rect.x, off_grid);
    let det =
        detect_roster(&img, w, h, (7, 0), &DetectProfile::WG).expect("table must be detected");
    assert!(
        (det.rect.x - off_grid).abs() <= 1,
        "x: {off_grid} vs {:?}",
        det.rect
    );
    assert!(
        (det.rect.y - rect.y).abs() <= 1,
        "y: {} vs {:?}",
        rect.y,
        det.rect
    );
    for (k, &c) in det.row_centers.iter().enumerate() {
        assert!(
            (c as f32 - centers[k]).abs() <= 3.0,
            "row {k}: {c} vs {}",
            centers[k]
        );
    }
    assert_eq!(det.team_split, 1.0);
}

#[test]
fn rows_follow_the_arena_hint_regardless_of_visible_text() {
    // Pure-geometry semantics: with the header located, the row count is
    // the ARENA hint (12), even when the drawn table only shows 6 text
    // rows — rows are computed, not counted from pixels.
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 6);
    let det =
        detect_roster(&img, w, h, (12, 12), &DetectProfile::WG).expect("header alone must anchor");
    assert_eq!(det.row_centers.len(), 24, "12 + 12 centers");
    // The 6 drawn rows must coincide with grid rows 0..6.
    let pitch = h as f32 * 0.028 * 0.92;
    let first = (h as f32 * 0.22 + h as f32 * 0.028) + pitch * 0.5;
    for (k, &c) in det.row_centers.iter().enumerate().take(6) {
        let truth = first + pitch * k as f32;
        assert!((c as f32 - truth).abs() <= 9.0, "row {k}: {c} vs {truth}");
    }
}

#[test]
fn asymmetrical_battle_gets_two_grids() {
    // 12v6: both sub-tables share the header band, but each side's row
    // count is its OWN — allies get 12 grid rows, enemies 6. The chips
    // mapping relies on centers being allies-block first, then enemies.
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 12);
    let det =
        detect_roster(&img, w, h, (12, 6), &DetectProfile::WG).expect("asym table must anchor");
    assert_eq!(det.row_centers.len(), 18, "12 + 6 centers");
    // Both blocks start at the same first row (shared header).
    let pitch = h as f32 * 0.028 * 0.92;
    let first = (h as f32 * 0.22 + h as f32 * 0.028) + pitch * 0.5;
    assert!((det.row_centers[0] as f32 - first).abs() <= 9.0);
    // Enemy block restarts at the SAME top (the real client stacks both
    // sub-tables from the shared header downward on each side).
    assert!((det.row_centers[12] as f32 - first).abs() <= 9.0);
}

#[test]
fn works_without_arena_hint() {
    // No hint → the detector returns a conservative 5-row grid anchored
    // on the header (real flows always pass the hint).
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 12);
    let det = detect_roster(&img, w, h, (0, 0), &DetectProfile::WG).expect("detect without hint");
    assert_eq!(det.row_centers.len(), 10, "5 + 5 fallback rows: {det:?}");
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
    let rows: Vec<i32> = (0..5).map(|i| 300 + 40 * i + 20).collect();
    let (overlay, anchor) = build_anchor(&game, &roster, rows.clone(), 0.5, false, 1.0);
    assert!(!anchor.table_detected);
    // The overlay window covers ONLY the inflated table area — wider on
    // the sides (chips render OUTSIDE the table) than above/below.
    let pad = overlay_padding(&roster);
    let padx = overlay_padding_x(&roster, 1.0);
    assert!(padx > pad, "side padding must exceed vertical padding");
    assert_eq!(overlay.width, roster.width + 2 * padx);
    assert_eq!(overlay.height, roster.height + 2 * pad);
    assert_eq!(overlay.x, roster.x - padx);
    assert_eq!(overlay.y, roster.y - pad);
    // ...and the anchor coordinates are re-based to ITS origin.
    assert_eq!(anchor.overlay_rect.x, overlay.x);
    assert_eq!(anchor.overlay_rect.y, overlay.y);
    assert_eq!(anchor.overlay_rect.width, overlay.width);
    assert_eq!(anchor.overlay_rect.height, overlay.height);
    assert_eq!(anchor.roster_rect.x, padx);
    assert_eq!(anchor.roster_rect.y, pad);
    for (got, want) in anchor.row_centers.iter().zip(&rows) {
        // Re-based by dy = roster.y − pad (no clamping in this geometry).
        assert_eq!(*got, want - (roster.y - pad));
    }
}

#[test]
fn side_pad_tracks_the_monitor_scale() {
    // A ~1477-px-wide two-column table (the measured 3072×1920 client):
    // the width ratio alone reserves 369 physical px, which on a 150%
    // monitor is ~246 CSS px — well under the ~300 CSS px a loaded chip
    // measures, so every number chip overflowed its side pad and chipFit's
    // clamp pinned them to the window edge (the lost right-alignment on
    // both the random-battle table and the story/PvE single-column one).
    // The DPI-aware reserve must carry the SAME CSS room at any scale.
    let roster = Rect {
        x: 800,
        y: 400,
        width: 1477,
        height: 600,
    };
    let at = |scale: f32| overlay_padding_x(&roster, scale);
    // At DPR 1 the old quarter-width ratio (369) already granted the room,
    // so it keeps winning over the 350 CSS reserve.
    assert_eq!(at(1.0), 369);
    // 150% / 200% monitors: the CSS reserve scales into physical px and
    // outgrows the ratio.
    assert_eq!(at(1.5), 525);
    assert_eq!(at(2.0), 700);
    // The scale never shrinks the reserve below the DPR-1 reserve, and a
    // path that could not query the DPI passes 1.0 (the fallback).
    assert!(at(1.0) >= overlay_padding_x(&roster, 0.5));
    // A wide-enough table still outgrows the reserve on its own (the old
    // quarter-width ratio stays as the growth term)…
    let wide = Rect {
        x: 0,
        y: 0,
        width: 2400,
        height: 600,
    };
    assert_eq!(overlay_padding_x(&wide, 1.0), 600);
    // …and the cap keeps a degenerate DPI from swallowing the screen.
    assert_eq!(overlay_padding_x(&roster, 8.0), 1024);
}

#[test]
fn build_anchor_side_pad_scales_with_dpi() {
    // Same table at DPR 1 vs DPR 2: the window's side reserves double in
    // physical px so the chips keep the same CSS room (game window sized
    // to hold both without the game-window clamp kicking in).
    let game = Rect {
        x: 0,
        y: 0,
        width: 4000,
        height: 1440,
    };
    let roster = Rect {
        x: 900,
        y: 300,
        width: 1200,
        height: 250,
    };
    let rows: Vec<i32> = (0..5).map(|i| 300 + 40 * i + 20).collect();
    let padx1 = overlay_padding_x(&roster, 1.0);
    let padx2 = overlay_padding_x(&roster, 2.0);
    let (overlay1, anchor1) = build_anchor(&game, &roster, rows.clone(), 0.5, true, 1.0);
    let (overlay2, anchor2) = build_anchor(&game, &roster, rows, 0.5, true, 2.0);
    assert_eq!(overlay1.width, roster.width + 2 * padx1);
    assert_eq!(overlay2.width, roster.width + 2 * padx2);
    assert_eq!(overlay2.x, roster.x - padx2);
    // The re-based roster coordinates track the window they describe.
    assert_eq!(anchor2.roster_rect.x, padx2);
    assert_eq!(anchor1.roster_rect.x, padx1);
}

#[test]
fn fallback_roster_hugs_the_center() {
    let (rect, rows) = fallback_roster(2560, 1440, 5);
    assert_eq!(rows.len(), 5);
    assert!(rect.width <= 2560 * 55 / 100);
    // 12-row height floor (~40% of the frame) but never most of it.
    assert!(rect.height >= 1440 * 40 / 100);
    assert!(rect.height <= 1440 * 50 / 100);
    for &c in &rows {
        assert!(c >= rect.y && c <= rect.y + rect.height);
    }
}

#[test]
fn name_strip_rects_split_allies_and_enemies() {
    let roster = Rect {
        x: 1000,
        y: 300,
        width: 1200,
        height: 600,
    };
    // Uniform 50 px pitch, allies rows 0-2, enemies rows 3-5.
    let rows: Vec<i32> = (0..6).map(|i| 340 + 50 * i).collect();
    let ally = row_name_strip_rect(
        StripTable {
            roster: &roster,
            row_centers: &rows,
            team_split: 0.5,
            ally_rows: 3,
        },
        0,
        &DetectProfile::WG,
    )
    .expect("ally strip");
    let enemy = row_name_strip_rect(
        StripTable {
            roster: &roster,
            row_centers: &rows,
            team_split: 0.5,
            ally_rows: 3,
        },
        3,
        &DetectProfile::WG,
    )
    .expect("enemy strip");
    // The halves are MIRRORED (measured on the #372 dumps): ally names
    // hug the left edge of the left half, enemy names the right edge of
    // the right half.
    assert_eq!(ally.x, 1000 + (600.0f32 * 0.02).round() as i32);
    assert_eq!(
        enemy.x + enemy.width,
        (1600.0f32 + 600.0f32 * 0.96).round() as i32,
        "enemy strip hugs its half's outer (right) edge"
    );
    assert_eq!(ally.width, (600.0f32 * 0.38).round() as i32);
    assert_eq!(enemy.width, (600.0f32 * 0.34).round() as i32);
    // Vertical: row center 340 ± 50 × 0.42 → 21 px each way.
    assert_eq!(ally.y, 340 - 21);
    assert_eq!(ally.height, 42);
    // The strip stays inside its own half (does not cross the split).
    assert!(ally.x + ally.width <= 1600);
    assert!(enemy.x >= 1600);
    // Out-of-range rows yield nothing.
    assert!(
        row_name_strip_rect(
            StripTable {
                roster: &roster,
                row_centers: &rows,
                team_split: 0.5,
                ally_rows: 3
            },
            6,
            &DetectProfile::WG
        )
        .is_none()
    );
    assert!(
        row_name_strip_rect(
            StripTable {
                roster: &roster,
                row_centers: &rows,
                team_split: 0.5,
                ally_rows: 3
            },
            100,
            &DetectProfile::WG
        )
        .is_none()
    );
    // ally_rows beyond the emitted rows is degenerate but well-defined:
    // every row stays an ALLY row (the frontend's slice() mapping), so
    // row 5 must still resolve to a LEFT-half strip.
    let degenerate = row_name_strip_rect(
        StripTable {
            roster: &roster,
            row_centers: &rows,
            team_split: 0.5,
            ally_rows: 100,
        },
        5,
        &DetectProfile::WG,
    )
    .expect("ally row");
    assert!(degenerate.x + degenerate.width <= 1600, "left half only");
}

#[test]
fn crop_rgba_extracts_exact_pixels_and_rejects_bad_geometry() {
    let rgba = vec![
        10, 20, 30, 255, 40, 50, 60, 255, //
        70, 80, 90, 255, 100, 110, 120, 255,
    ];
    let (crop, w, h) = crop_rgba(
        &rgba,
        2,
        2,
        &Rect {
            x: 1,
            y: 0,
            width: 1,
            height: 2,
        },
    )
    .unwrap();
    assert_eq!((w, h), (1, 2));
    assert_eq!(crop, vec![40, 50, 60, 255, 100, 110, 120, 255]);
    // Fully outside → nothing; empty rect → nothing; short buffer →
    // nothing (never a panic from the watcher thread).
    let out = Rect {
        x: 5,
        y: 5,
        width: 2,
        height: 2,
    };
    assert!(crop_rgba(&rgba, 2, 2, &out).is_none());
    let empty = Rect {
        x: 1,
        y: 1,
        width: 0,
        height: 4,
    };
    assert!(crop_rgba(&rgba, 2, 2, &empty).is_none());
    assert!(
        crop_rgba(
            &rgba[..4],
            2,
            2,
            &Rect {
                x: 0,
                y: 0,
                width: 2,
                height: 2
            }
        )
        .is_none()
    );
    // Partially outside clamps to the intersection.
    let (crop, w, h) = crop_rgba(
        &rgba,
        2,
        2,
        &Rect {
            x: 1,
            y: 1,
            width: 4,
            height: 4,
        },
    )
    .unwrap();
    assert_eq!((w, h), (1, 1));
    assert_eq!(crop, vec![100, 110, 120, 255]);
}

#[test]
fn name_strips_capture_the_painted_names() {
    // 1280x720 frame; a table in the classic position with 2 ally rows
    // and 2 enemy rows. White "name" pixels are painted ONLY inside the
    // computed strips of rows 0 (ally) and 2 (enemy) — the crops for
    // those rows must read bright, the untouched rows dark.
    let (w, h) = (1280u32, 720u32);
    let mut img = vec![20u8; (w * h * 4) as usize];
    for i in 0..(w * h) as usize {
        img[i * 4 + 3] = 255;
    }
    let roster = Rect {
        x: 320,
        y: 160,
        width: 600,
        height: 300,
    };
    let rows = vec![220, 270, 220, 270];
    let paint = |img: &mut [u8], r: &Rect| {
        for y in r.y..r.y + r.height {
            for x in r.x..r.x + r.width {
                let i = ((y as u32 * w + x as u32) * 4) as usize;
                img[i] = 240;
                img[i + 1] = 240;
                img[i + 2] = 240;
            }
        }
    };
    paint(
        &mut img,
        &row_name_strip_rect(
            StripTable {
                roster: &roster,
                row_centers: &rows,
                team_split: 0.5,
                ally_rows: 2,
            },
            0,
            &DetectProfile::WG,
        )
        .unwrap(),
    );
    paint(
        &mut img,
        &row_name_strip_rect(
            StripTable {
                roster: &roster,
                row_centers: &rows,
                team_split: 0.5,
                ally_rows: 2,
            },
            2,
            &DetectProfile::WG,
        )
        .unwrap(),
    );
    let strips = crop_row_name_strips(
        &img,
        w,
        h,
        StripTable {
            roster: &roster,
            row_centers: &rows,
            team_split: 0.5,
            ally_rows: 2,
        },
        &DetectProfile::WG,
    );
    assert_eq!(strips.len(), 4);
    let mean_luma = |c: &(Vec<u8>, u32, u32)| {
        let (buf, cw, ch) = c;
        let sum: u32 = buf.chunks_exact(4).map(|p| u32::from(p[0])).sum();
        sum / (cw * ch)
    };
    assert!(
        mean_luma(strips[0].as_ref().unwrap()) > 200,
        "ally row 0 painted"
    );
    assert!(
        mean_luma(strips[2].as_ref().unwrap()) > 200,
        "enemy row 0 painted"
    );
    assert!(
        mean_luma(strips[1].as_ref().unwrap()) < 40,
        "ally row 1 untouched"
    );
    assert!(
        mean_luma(strips[3].as_ref().unwrap()) < 40,
        "enemy row 1 untouched"
    );
}

#[test]
fn strip_luma_separates_alive_from_sunk() {
    // Glyph-core luma is the alive/sunk signal: alive rows peak at
    // near-white (≥ ~186 on the 3072x1920 dumps, own-player highlight
    // included), sunk rows at dim gray (≤ ~137). The max statistic must
    // read the glyph cores regardless of the dark strip background.
    let alive = vec![255, 255, 255, 255, 10, 10, 10, 255, 0, 0, 0, 255];
    let sunk = vec![128, 128, 128, 255, 90, 90, 90, 255, 20, 20, 20, 255];
    let dark = vec![10, 10, 10, 255, 0, 0, 0, 255];
    assert!(strip_max_luma(&alive) > 250.0);
    assert!(!row_strip_alive(strip_max_luma(&sunk)), "dim gray → sunk");
    assert!(!row_strip_alive(strip_max_luma(&dark)), "black → sunk");
    assert!(
        row_strip_alive(strip_max_luma(&alive)),
        "near-white → alive"
    );
    // A row reading just under the threshold but well above the sunk
    // population (own-player highlight-dimmed names) stays alive.
    assert!(row_strip_alive(186.0));
    assert!(!row_strip_alive(137.0));
    // An unreadable (empty) strip yields luma 0 — the caller's
    // missing-strip default (alive) is what keeps that honest.
    assert_eq!(strip_max_luma(&[]), 0.0);
}

/// Hand-built anchor for the revalidation move-decision tests (bypasses
/// the detector; grid pitch 42 in the full-grid fixtures).
fn anchor_with(rows: &[i32], detected: bool) -> wowsp_tauri_shared::OverlayAnchor {
    wowsp_tauri_shared::OverlayAnchor {
        game_rect: Rect {
            x: 0,
            y: 0,
            width: 3072,
            height: 1920,
        },
        overlay_rect: Rect {
            x: 500,
            y: 200,
            width: 1500,
            height: 720,
        },
        roster_rect: Rect {
            x: 150,
            y: 40,
            width: 1200,
            height: 620,
        },
        row_centers: rows.to_vec(),
        team_split: 0.5,
        table_detected: detected,
        row_alive: None,
        roster_mode: String::new(),
    }
}

#[test]
fn revalidate_keeps_pin_on_sub_pitch_jitter() {
    let pinned = anchor_with(&[50, 92, 134], true);
    // Half a pitch = 21 px: a 10 px phase-refinement shift is jitter and
    // must keep the pin (the anti-wander guarantee).
    let fresh = anchor_with(&[60, 102, 144], true);
    assert!(!anchor_meaningfully_moved(&pinned, &fresh));
}

#[test]
fn revalidate_replaces_pin_on_row_scale_shift() {
    let pinned = anchor_with(&[50, 92, 134], true);
    // The countdown → combat HUD-phase shift spans several pitches; one
    // full pitch must already trip the threshold.
    let fresh = anchor_with(&[110, 152, 194], true);
    assert!(anchor_meaningfully_moved(&pinned, &fresh));
    // Exactly half a pitch does NOT move (strictly-greater threshold).
    let half = anchor_with(&[71, 113, 155], true);
    assert!(!anchor_meaningfully_moved(&pinned, &half));
}

#[test]
fn revalidate_replaces_pin_on_horizontal_layout_change() {
    // Story-mode (剧情/行动) layout switch: the combat Tab screen collapses
    // the two-team table into ONE centered team table at the same height —
    // every row stays put, the horizontal span halves. The re-based rows
    // cannot see it; the capture-space edges must. team_split stays in the
    // two-bar range so THIS test pins the span branch alone (the kind flip
    // has its own test below).
    let pinned = anchor_with(&[50, 92, 134], true);
    let mut fresh = anchor_with(&[50, 92, 134], true);
    fresh.roster_rect = Rect {
        x: 450,
        y: 40,
        width: 500,
        height: 620,
    };
    assert!(anchor_meaningfully_moved(&pinned, &fresh));
}

#[test]
fn revalidate_keeps_pin_on_sub_pitch_edge_jitter() {
    // The native edge refinement jitters a few px frame to frame — well
    // under the half-pitch threshold (42 / 2 = 21): the pin holds.
    let pinned = anchor_with(&[50, 92, 134], true);
    let mut fresh = anchor_with(&[50, 92, 134], true);
    fresh.roster_rect = Rect {
        x: 158,
        y: 40,
        width: 1192,
        height: 620,
    };
    assert!(!anchor_meaningfully_moved(&pinned, &fresh));
}

#[test]
fn revalidate_replaces_pin_on_team_split_flip() {
    // Green-only single-team table (split exactly 1.0) replacing a two-bar
    // detection (0.30–0.70) is a header-kind change by definition, even
    // with identical rows and span.
    let pinned = anchor_with(&[50, 92, 134], true);
    let mut fresh = anchor_with(&[50, 92, 134], true);
    fresh.team_split = 1.0;
    assert!(anchor_meaningfully_moved(&pinned, &fresh));
}

#[test]
fn revalidate_fresh_fallback_never_replaces_confirmed_pin() {
    let pinned = anchor_with(&[50, 92, 134], true);
    // Detection failed this pass: even a far-away fallback geometry must
    // not replace the confirmed pin.
    let fresh = anchor_with(&[400, 442, 484], false);
    assert!(!anchor_meaningfully_moved(&pinned, &fresh));
}

#[test]
fn revalidate_single_row_grid_uses_the_other_grids_pitch() {
    // Fresh grid has one row but the pinned one has a proper grid: the
    // pinned pitch (42) is the fallback, threshold 21.
    let pinned = anchor_with(&[50, 92, 134], true);
    let moved = anchor_with(&[80], true);
    assert!(anchor_meaningfully_moved(&pinned, &moved), "dy 30 > 21");
    let near = anchor_with(&[60], true);
    assert!(!anchor_meaningfully_moved(&pinned, &near), "dy 10 < 21");
}

#[test]
fn revalidate_degenerate_single_row_grids_fall_back_to_roster_height() {
    // Both grids carry a single row: no first gap anywhere, so the pitch
    // falls back to roster height (620) ÷ row count (1) = 620, threshold
    // 310.
    let pinned = anchor_with(&[100], true);
    let near = anchor_with(&[300], true);
    assert!(!anchor_meaningfully_moved(&pinned, &near), "dy 300 ≤ 310");
    let far = anchor_with(&[500], true);
    assert!(anchor_meaningfully_moved(&pinned, &far), "dy 400 > 310");
}

#[test]
fn revalidate_empty_grids_never_move() {
    let pinned_empty = anchor_with(&[], true);
    let fresh = anchor_with(&[50, 92], true);
    assert!(!anchor_meaningfully_moved(&pinned_empty, &fresh));
    let pinned = anchor_with(&[50, 92], true);
    let fresh_empty = anchor_with(&[], true);
    assert!(!anchor_meaningfully_moved(&pinned, &fresh_empty));
}

#[test]
fn verify_header_band_accepts_cached_frame_and_rejects_moved_table() {
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 6);
    let (band, _) =
        detect_roster_with_band(&img, w, h, (6, 6), &DetectProfile::WG).expect("detect");
    // The frame the band was detected on trivially verifies.
    assert!(verify_header_band(&img, w, h, &band), "same frame verifies");
    // HUD phase moved the table away: paint scene noise over the band's
    // PHYSICAL region (the band lives in working px; the working scale
    // is the same width.div_ceil(MAX_WORK_WIDTH) the detector uses) and
    // the verify must fail — the cached geometry must not anchor this
    // frame.
    let s = w.div_ceil(MAX_WORK_WIDTH).max(1) as usize;
    let mut moved = img.clone();
    let mut noise = Noise(0x5eed_5eed);
    let y0 = band.top.saturating_sub(2) * s;
    let y1 = ((band.top + band.height + 2) * s).min(h as usize);
    for y in y0..y1 {
        for x in 0..w as usize {
            let l = noise.next_f32(125.0, 175.0) as u8;
            let i = (y * w as usize + x) * 4;
            moved[i] = l;
            moved[i + 1] = l;
            moved[i + 2] = l;
        }
    }
    assert!(
        !verify_header_band(&moved, w, h, &band),
        "erased band must fail"
    );
    // A band whose geometry leaves the (tiny) frame is rejected outright
    // rather than half-verified.
    let offscreen = HeaderBand {
        top: h as usize - 1,
        height: band.height,
        green: band.green,
        red: band.red,
    };
    assert!(!verify_header_band(&img, w, h, &offscreen));
}

/// The real captured fixture: the band detected on it must verify on the
/// SAME frame — the cheap path the watcher runs every capture instead of
/// a full detection.
#[test]
fn verify_header_band_passes_on_the_real_fixture() {
    let png = include_bytes!("../testdata/tab_table_768x480.png");
    let img = image::load_from_memory(png)
        .expect("fixture decodes")
        .to_rgba8();
    let (w, h) = img.dimensions();
    let rgba = img.into_raw();
    let (band, _) =
        detect_roster_with_band(&rgba, w, h, (5, 5), &DetectProfile::WG).expect("real detect");
    assert!(verify_header_band(&rgba, w, h, &band), "fixture verifies");
    // And the identical band still verifies when the table content below
    // it changes (rows re-sorted by sinks) — only the BAND region counts.
    let mut shifted = rgba.clone();
    let shift_top = (band.top + band.height + 2).min(h as usize - 1);
    for y in shift_top..h as usize {
        for x in 0..w as usize {
            let i = ((y * w as usize + x) * 4) as usize;
            shifted[i] = 30;
            shifted[i + 1] = 30;
            shifted[i + 2] = 30;
        }
    }
    assert!(
        verify_header_band(&shifted, w, h, &band),
        "band verify ignores everything below the header"
    );
}

/// Horizontal slide of the whole table: the interior quarter-point
/// samples still sit on the (wide) bars, so only the counter-evidence
/// columns OUTSIDE the cached band's ends can catch the drift — the
/// verify must fail so the next capture re-detects the x instead of
/// anchoring chips on the old geometry.
#[test]
fn verify_header_band_rejects_horizontal_shift() {
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 6);
    let (band, _) =
        detect_roster_with_band(&img, w, h, (6, 6), &DetectProfile::WG).expect("detect");
    assert!(verify_header_band(&img, w, h, &band), "baseline verifies");
    // 16 physical px = 8 working px right: the brick bar now covers the
    // cached band's right counter columns.
    let (right, _, _) = synth_header_table_at(w, h, 6, 16);
    assert!(
        !verify_header_band(&right, w, h, &band),
        "rightward slide must fail"
    );
    // Same distance left: the teal bar covers the left counter columns.
    let (left, _, _) = synth_header_table_at(w, h, 6, -16);
    assert!(
        !verify_header_band(&left, w, h, &band),
        "leftward slide must fail"
    );
}

#[test]
fn rebuild_roster_from_band_resizes_the_grid_without_a_rescan() {
    let (w, h) = (1280u32, 720u32);
    let (img, _, _) = synth_header_table(w, h, 12);
    let (band, det) =
        detect_roster_with_band(&img, w, h, (12, 12), &DetectProfile::WG).expect("detect");
    // Same team sizes: the rebuild (here without a measured-pitch hint)
    // matches the detector's grid and rect. Pitch compares within ±1 px:
    // both paths round working-px centers to physical, so a fractional
    // pitch (18.4 working × scale 2) alternates 18/19 deltas.
    let rebuilt = rebuild_roster_from_band(&band, w, h, (12, 12), None, &DetectProfile::WG);
    assert_eq!(rebuilt.row_centers.len(), 24);
    let pitch_det = det.row_centers[1] - det.row_centers[0];
    let pitch_re = rebuilt.row_centers[1] - rebuilt.row_centers[0];
    assert!(
        (pitch_det - pitch_re).abs() <= 1,
        "cached pitch kept verbatim: {pitch_det} vs {pitch_re}"
    );
    assert_eq!(rebuilt.rect.y, det.rect.y);
    assert_eq!(rebuilt.rect.x, det.rect.x);
    // New battle shape on the same window (7v7 after 12v12): the row
    // COUNT follows the new hint, the pitch does not move.
    let small = rebuild_roster_from_band(&band, w, h, (6, 6), None, &DetectProfile::WG);
    assert_eq!(small.row_centers.len(), 12);
    assert!(
        (small.row_centers[1] - small.row_centers[0] - pitch_re).abs() <= 1,
        "rebuild pitch is uniform"
    );
    // Asym counts work per side.
    let asym = rebuild_roster_from_band(&band, w, h, (12, 6), None, &DetectProfile::WG);
    assert_eq!(asym.row_centers.len(), 18);
    // No hint → the same conservative 5+5 grid detect_roster uses.
    let unhinted = rebuild_roster_from_band(&band, w, h, (0, 0), None, &DetectProfile::WG);
    assert_eq!(unhinted.row_centers.len(), 10);
}

/// The rebuild with a MEASURED pitch hint keeps the pitch the frame
/// itself measured — not the constant prior. Drawn table at factor 0.97
/// (prior 0.92) on a 2560x1440 frame, where the ~1.2 px/row difference
/// between the two is unambiguous in the span average.
#[test]
fn rebuild_roster_from_band_keeps_the_measured_pitch() {
    let (w, h) = (2560u32, 1440u32);
    let (img, _, _) = synth_table(w, h, 12, 0, 0.97);
    let (band, det) =
        detect_roster_with_band(&img, w, h, (12, 12), &DetectProfile::WG).expect("detect");
    let measured = measured_pitch_from_centers(&det.row_centers, 12);
    let span = |cs: &[i32]| (cs[cs.len() - 1] - cs[0]) as f32 / (cs.len() - 1) as f32;
    let hinted = rebuild_roster_from_band(&band, w, h, (6, 6), Some(measured), &DetectProfile::WG);
    let prior = rebuild_roster_from_band(&band, w, h, (6, 6), None, &DetectProfile::WG);
    let pitch_hinted = span(&hinted.row_centers[..6]);
    let pitch_prior = span(&prior.row_centers[..6]);
    let pitch_det = span(&det.row_centers[..12]);
    assert!(
        (pitch_hinted - pitch_det).abs() <= 1.0,
        "hinted {pitch_hinted} vs measured {pitch_det}"
    );
    assert!(
        pitch_hinted > pitch_prior + 0.5,
        "hinted pitch {pitch_hinted} must exceed the prior's {pitch_prior}"
    );
}

/// The gap-based pitch fit replaces the constant ratio: tables drawn at
/// pitch factors either side of the 0.92 prior must have EVERY row (the
/// bottom ones included) land on the drawn centers — the old constant
/// accumulated its error downward (a 12-row table drifted ~1 pitch).
#[test]
fn adaptive_pitch_tracks_the_true_row_pitch() {
    for factor in [0.86f32, 0.97f32] {
        let (w, h) = (1280u32, 720u32);
        let (img, _, centers) = synth_table(w, h, 12, 0, factor);
        let det = detect_roster(&img, w, h, (12, 12), &DetectProfile::WG)
            .expect("table must be detected");
        assert_eq!(det.row_centers.len(), 24);
        for (k, &c) in det.row_centers.iter().take(12).enumerate() {
            assert!(
                (c as f32 - centers[k]).abs() <= 3.0,
                "factor {factor}: row {k}: {c} vs {}",
                centers[k]
            );
        }
    }
}

/// The native refinement pins the table edges BETWEEN the working
/// frame's quantization steps: at 2560x1440 the work scale is 4, so the
/// unrefined detector can only ever emit coordinates on a 4-px grid.
/// Draw the table at a deliberately off-grid x — the refined rect must
/// land within 1 px.
#[test]
fn native_refinement_pins_edges_beyond_the_scale_grid() {
    let (w, h) = (2560u32, 1440u32);
    let scale = w.div_ceil(MAX_WORK_WIDTH) as i32;
    let tx = (w as f32 * 0.26) as i32;
    // Pick the nearest x that is NOT a multiple of the work scale.
    let mut off_grid = tx + 1;
    if off_grid.rem_euclid(scale) == 0 {
        off_grid += 1;
    }
    assert_ne!(off_grid.rem_euclid(scale), 0, "fixture must be off-grid");
    let (img, rect, centers) = synth_table(w, h, 6, off_grid - tx, 0.92);
    assert_eq!(rect.x, off_grid);
    let det =
        detect_roster(&img, w, h, (6, 6), &DetectProfile::WG).expect("table must be detected");
    assert!(
        (det.rect.x - off_grid).abs() <= 1,
        "x: {off_grid} vs {:?}",
        det.rect
    );
    assert!(
        (det.rect.y - rect.y).abs() <= 1,
        "y: {} vs {:?}",
        rect.y,
        det.rect
    );
    for (k, &c) in det.row_centers.iter().take(6).enumerate() {
        assert!(
            (c as f32 - centers[k]).abs() <= 3.0,
            "row {k}: {c} vs {}",
            centers[k]
        );
    }
}

/// Degenerate inputs never panic the refinement: an empty grid, a rect
/// outside the frame and a short buffer all come back untouched.
#[test]
fn native_refinement_degrades_to_the_input() {
    let (w, h) = (2560u32, 1440u32);
    let (img, _, _) = synth_header_table(w, h, 6);
    let det = detect_roster(&img, w, h, (6, 6), &DetectProfile::WG).expect("detect");
    let mut empty = det.clone();
    empty.row_centers.clear();
    let out = refine_roster_native(&img, w, h, &empty, det.rect.y + 40);
    assert!(out.row_centers.is_empty());
    // Short buffer → verbatim clone.
    let out = refine_roster_native(&img[..16], w, h, &det, det.rect.y + 40);
    assert_eq!(out.rect, det.rect);
    assert_eq!(out.row_centers, det.row_centers);
}

/// `measured_pitch_from_centers` splits the blocks at the ally count and
/// averages each block's gaps; short blocks read as "no measurement".
#[test]
fn measured_pitch_splits_blocks_and_averages_gaps() {
    // Allies 100/140/180 (pitch 40), enemies 100/175 (pitch 75).
    let centers = vec![100, 140, 180, 100, 175];
    let (l, r) = measured_pitch_from_centers(&centers, 3);
    assert_eq!(l, 40.0);
    assert_eq!(r, 75.0);
    // Single-row blocks → (0, 0): no measurement.
    let (l, r) = measured_pitch_from_centers(&[100, 100], 1);
    assert_eq!((l, r), (0.0, 0.0));
    // Empty → (0, 0).
    assert_eq!(measured_pitch_from_centers(&[], 0), (0.0, 0.0));
}

#[test]
fn read_row_alive_flags_painted_rows_and_defaults_missing_ones_alive() {
    let (w, h) = (1280u32, 720u32);
    let mut img = vec![20u8; (w * h * 4) as usize];
    for i in 0..(w * h) as usize {
        img[i * 4 + 3] = 255;
    }
    let roster = Rect {
        x: 320,
        y: 160,
        width: 600,
        height: 300,
    };
    let rows = vec![220, 270, 220, 270];
    let paint = |img: &mut [u8], r: &Rect| {
        for y in r.y..r.y + r.height {
            for x in r.x..r.x + r.width {
                let i = ((y as u32 * w + x as u32) * 4) as usize;
                img[i] = 240;
                img[i + 1] = 240;
                img[i + 2] = 240;
            }
        }
    };
    // Row 0 (ally) and row 3 (enemy #1) painted bright = alive; rows 1
    // and 2 left dark = sunk. The vec follows row_centers order.
    paint(
        &mut img,
        &row_name_strip_rect(
            StripTable {
                roster: &roster,
                row_centers: &rows,
                team_split: 0.5,
                ally_rows: 2,
            },
            0,
            &DetectProfile::WG,
        )
        .unwrap(),
    );
    paint(
        &mut img,
        &row_name_strip_rect(
            StripTable {
                roster: &roster,
                row_centers: &rows,
                team_split: 0.5,
                ally_rows: 2,
            },
            3,
            &DetectProfile::WG,
        )
        .unwrap(),
    );
    let alive = read_row_alive(
        &img,
        w,
        h,
        StripTable {
            roster: &roster,
            row_centers: &rows,
            team_split: 0.5,
            ally_rows: 2,
        },
        &DetectProfile::WG,
    );
    assert_eq!(alive, vec![true, false, false, true]);
}

// ── strip fingerprint matching (sink attribution) ────────────────────

/// Deterministic pseudo-random generator for synthetic strips.
struct StripNoise(u32);
impl StripNoise {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

/// Render one synthetic name strip: a dark plate, a few random bright
/// "glyph" blobs (the seed fixes their layout — same seed, same text)
/// and per-pixel noise. `bg` shifts the plate's absolute brightness,
/// `glyph_boost` the glyphs' — the whole point is that the FINGERPRINT
/// must not care.
fn synth_strip(seed: u32, w: u32, h: u32, bg: u8, glyph: u8, noise: f32) -> (Vec<u8>, u32, u32) {
    let mut img = vec![0u8; (w * h * 4) as usize];
    let mut rng = StripNoise(seed);
    // 3..7 glyph blobs, each a horizontal run of 2x2..5x5 blocks.
    let blobs = 3 + (seed % 5) as u32;
    for b in 0..blobs {
        let bx = ((b * w) / blobs + (w / blobs) / 3) % w;
        let by = h / 4 + ((seed >> b) % (h / 2).max(1));
        let bw = 2 + ((seed >> (b + 3)) % 4);
        let bh = 2 + ((seed >> (b + 5)) % 3);
        for y in by..(by + bh).min(h) {
            for x in bx..(bx + bw).min(w) {
                let i = ((y * w + x) * 4) as usize;
                img[i] = glyph;
                img[i + 1] = glyph;
                img[i + 2] = glyph;
                img[i + 3] = 255;
            }
        }
    }
    for i in 0..(w * h) as usize {
        let j = i * 4;
        if img[j] == 0 {
            let d = (rng.next() * (noise * 8.0)) as i32;
            let v = (bg as i32 + d).clamp(0, 255) as u8;
            img[j] = v;
            img[j + 1] = v;
            img[j + 2] = v;
        }
        img[j + 3] = 255;
    }
    (img, w, h)
}

fn thumb_of(seed: u32, bg: u8, glyph: u8) -> StripThumb {
    let (img, w, h) = synth_strip(seed, 220, 18, bg, glyph, 1.0);
    strip_thumb(&img, w, h).expect("synthetic strip is fingerprintable")
}

#[test]
fn thumb_ignores_absolute_brightness_but_keeps_shape() {
    let a = thumb_of(0x1234_5678, 40, 230); // bright glyphs on dark plate
    let b = thumb_of(0x1234_5678, 95, 150); // dim glyphs on lighter plate
    let c = thumb_of(0x8765_4321, 40, 230); // different "text"
    assert!(
        thumb_similarity(&a, &b) > STRIP_MATCH_THRESHOLD,
        "same text at different brightness must match (got {})",
        thumb_similarity(&a, &b)
    );
    assert!(
        thumb_similarity(&a, &c) < STRIP_MATCH_THRESHOLD,
        "different texts must not match (got {})",
        thumb_similarity(&a, &c)
    );
}

#[test]
fn sink_victims_solves_a_single_sink_with_shift_and_dimming() {
    // Old: 4 alive [A,B,C,D], 0 sunk. C sinks: new = [A,B,D] ++ [C(dim)].
    let old: Vec<Option<StripThumb>> = (0..4)
        .map(|i| Some(thumb_of(0x1000 + i, 40, 230)))
        .collect();
    let new: Vec<Option<StripThumb>> = vec![
        Some(thumb_of(0x1000, 60, 200)), // A, different background
        Some(thumb_of(0x1001, 60, 200)), // B
        Some(thumb_of(0x1003, 60, 200)), // D
        Some(thumb_of(0x1002, 60, 150)), // C — sunk, dimmed glyphs
    ];
    assert_eq!(sink_victims(&old, &new, 4, 3).unwrap(), vec![2]);
}

#[test]
fn sink_victims_solves_two_sinks_in_one_transition() {
    // Old: [A,B,C,D] all alive; A and C sink: new = [B,D] ++ [A?,C?] —
    // sunk-block order follows the Tab key, so any interleaving of the
    // two victims is structurally valid; both must be identified.
    let old: Vec<Option<StripThumb>> = (0..4)
        .map(|i| Some(thumb_of(0x2000 + i, 40, 230)))
        .collect();
    let new: Vec<Option<StripThumb>> = vec![
        Some(thumb_of(0x2001, 70, 210)), // B
        Some(thumb_of(0x2003, 70, 210)), // D
        Some(thumb_of(0x2002, 70, 140)), // C sunk
        Some(thumb_of(0x2000, 70, 140)), // A sunk
    ];
    let mut v = sink_victims(&old, &new, 4, 2).unwrap();
    v.sort_unstable();
    assert_eq!(v, vec![0, 2]);
}

#[test]
fn sink_victims_rejects_garbage_and_unreadable_rows() {
    let old: Vec<Option<StripThumb>> = (0..3)
        .map(|i| Some(thumb_of(0x3000 + i, 40, 230)))
        .collect();
    // A "new frame" whose rows share nothing with the old ones.
    let garbage: Vec<Option<StripThumb>> = (0..3)
        .map(|i| Some(thumb_of(0x9000 + i, 60, 200)))
        .collect();
    assert!(sink_victims(&old, &garbage, 3, 2).is_none());
    // An unreadable row disqualifies the transition outright.
    let mut hole = garbage.clone();
    hole[1] = None;
    assert!(sink_victims(&old, &hole, 3, 2).is_none());
    // Not a sink transition.
    assert!(sink_victims(&old, &old, 2, 3).is_none());
}

/// The REAL captured Lesta frame behind the Lesta overlay bug report
/// (Мир кораблей client, dark-twilight map, the tabbed 任务/团队成员/小队
/// scoreboard: teal/brick header bars ~35% wide each over left-aligned
/// name columns, a quick-commands hint column left of the table and a
/// consumables strip inside the roster window). Downscaled to the
/// detector's 768-wide working size from the 3072×1920 capture.
///
/// Pins the full pipeline on this layout: the table detects with the
/// LESTA profile at the true row grid, the detected band VERIFIES (the
/// panel bezel keeps header-colored pixels one-two rows past the bar
/// ends — the counter-evidence rule used to read those 3 of 14 rows as a
/// horizontal slide and voided every Lesta geometry cache within three
/// sink probes), and the full-frame presence check passes (the scene
/// gate's OR half — a dead player has no HP bar, as in the source
/// battle).
#[test]
fn detects_and_verifies_the_real_lesta_frame() {
    let png = include_bytes!("../testdata/tab_table_lesta_768x480.png");
    let img = image::load_from_memory(png)
        .expect("fixture decodes")
        .to_rgba8();
    let (w, h) = img.dimensions();
    assert_eq!((w, h), (768, 480));
    let rgba = img.into_raw();

    let (band, det) = detect_roster_with_band(&rgba, w, h, (6, 1), &DetectProfile::LESTA)
        .expect("real Lesta table must be detected");
    assert_eq!(det.row_centers.len(), 7, "6 allies + 1 enemy");
    assert!(
        (det.team_split - 0.5).abs() <= 0.04,
        "two-side split, got {}",
        det.team_split
    );
    // Truth (working px — the fixture IS the detector's working frame):
    // header top ≈231/4, six ally rows one 56px(physical) pitch apart, the
    // lone enemy row aligned with the first ally row.
    let truth: [f32; 7] = [78.25, 92.25, 106.25, 120.5, 134.5, 148.5, 78.75];
    for (k, (&got, want)) in det.row_centers.iter().zip(&truth).enumerate() {
        assert!((got as f32 - want).abs() <= 4.0, "row {k}: {got} vs {want}");
    }
    // The regression half: the band the detector just found must VERIFY —
    // the Lesta panel bezel trips the edge counter-columns on 3 of the 14
    // band rows, which the old absolute `< 2` rule read as a slid table.
    assert!(
        verify_header_band(&rgba, w, h, &band),
        "detected band must verify on the Lesta frame"
    );
    assert!(header_bars_present(&rgba, w, h));
}

/// A genuinely slid table must still fail the verify's edge rule under
/// the proportional threshold: shifting the real Lesta frame's content
/// right by more than a bar's quarter parks the brick bar over the RIGHT
/// counter columns (the teal bar's left edge moves away from its own), so
/// nearly every band row lights a counter column.
#[test]
fn lesta_frame_verify_still_rejects_a_slid_table() {
    let png = include_bytes!("../testdata/tab_table_lesta_768x480.png");
    let img = image::load_from_memory(png)
        .expect("fixture decodes")
        .to_rgba8();
    let (w, h) = img.dimensions();
    let mut rgba = img.into_raw();
    let (band, _) = detect_roster_with_band(&rgba, w, h, (6, 1), &DetectProfile::LESTA)
        .expect("table detected on the original frame");
    // Shift the whole frame right by 24 working px (a third of a bar) —
    // the bars vacate their cached spans and cover the right counters.
    let shift = 24usize;
    let stride = w as usize * 4;
    for y in 0..h as usize {
        let row = y * stride;
        for x in (shift * 4..stride).rev() {
            rgba[row + x] = rgba[row + x - shift * 4];
        }
    }
    assert!(
        !verify_header_band(&rgba, w, h, &band),
        "a slid table must not verify"
    );
}
