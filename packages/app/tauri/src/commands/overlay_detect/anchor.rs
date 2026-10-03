use super::*;

/// Vertical padding (physical px) added above/below the detected table when
/// sizing the overlay window.
pub(crate) fn overlay_padding(roster: &Rect) -> i32 {
    (roster.height / 8).clamp(24, 96)
}

/// Horizontal padding (physical px): WIDER than vertical because the stat
/// chips render OUTSIDE the table's left/right edges (inside they cover the
/// ship names) — the window must reserve a full chip width per side. The
/// four-char seals recut onto one line (3:1 faces) roughly tripled each
/// wide seal's footprint versus the old 2x2 face, so the floor rides up
/// with them: at 150 px a hidden-profile 过街老鼠 chip (or any chip with a
/// career + air + sub set) lost its outer seal flank.
pub(crate) fn overlay_padding_x(roster: &Rect) -> i32 {
    (roster.width / 4).clamp(240, 440)
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
    let padx = overlay_padding_x(roster_rel);
    // Overlay rect in screen px: the table area inflated by the padding,
    // clamped to stay inside the game window (multi-monitor safe — the game
    // rect is already monitor-clamped).
    let ox = (game_screen.x + roster_rel.x - padx).max(game_screen.x);
    let oy = (game_screen.y + roster_rel.y - pad).max(game_screen.y);
    let orx = game_screen.x + roster_rel.x + roster_rel.width + padx;
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
        // The luma pass fills `row_alive` afterwards when it ran
        // (manual/automatic alike).
        row_alive: None,
        // Set to the live settings mode at EMIT time (place_and_show) —
        // construction-time anchors are mode-agnostic.
        roster_mode: String::new(),
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
    let height = (frame_h * 8 / 100)
        .max((expected as i32 * frame_h * 5 / 100).max(frame_h * 16 / 100))
        // 12-row floor, same reasoning as MIN_WINDOW_ROWS: the fallback
        // window must be able to carry a full 12v12 table's hint box.
        .max(frame_h * 40 / 100);
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

// ─────────────────────────────────────────────────────────────────────────
// Pinned-anchor revalidation (pure decision — unit-testable)
// ─────────────────────────────────────────────────────────────────────────

/// Move threshold for replacing a pinned anchor: the fresh first row must sit
/// more than HALF a row pitch away from the pinned one. Detector jitter (the
/// per-side phase refinement shifts the grid by fractions of a pitch frame to
/// frame) stays under it and keeps the pin — the whole point of the pin is
/// that the chips never wander. A real layout switch crosses it: the panel
/// moves as a WHOLE when HUD phases change (the countdown "waiting players"
/// layout sits ~190 px ≈ 3.7 row pitches above the combat layout at
/// 3072x1920) and sunk ships re-sort the rows.
const ANCHOR_MOVE_HALF_PITCH: f32 = 0.5;

/// Effective row pitch for the move test: the FRESH grid's first gap
/// (`row_centers[1] − row_centers[0]`); grids with fewer than two rows fall
/// back to the pinned grid's gap, then to roster height ÷ row count.
/// Returns 0.0 when nothing yields a positive pitch (the caller then never
/// reports movement).
fn anchor_row_pitch(
    fresh: &wowsp_tauri_shared::OverlayAnchor,
    pinned: &wowsp_tauri_shared::OverlayAnchor,
) -> f32 {
    let first_gap =
        |a: &wowsp_tauri_shared::OverlayAnchor| match (a.row_centers.first(), a.row_centers.get(1))
        {
            (Some(&r0), Some(&r1)) => (r1 - r0).abs() as f32,
            _ => 0.0,
        };
    let pitch = match first_gap(fresh) {
        p if p > 0.0 => p,
        _ => match first_gap(pinned) {
            p if p > 0.0 => p,
            // Degenerate single-row grids on both sides: a coarse pitch from
            // the taller roster rect over the longer row count.
            _ => {
                let rows = fresh.row_centers.len().max(pinned.row_centers.len()).max(1) as f32;
                fresh.roster_rect.height.max(pinned.roster_rect.height) as f32 / rows
            },
        },
    };
    if pitch > 0.0 { pitch } else { 0.0 }
}

/// Whether a fresh detection of the SAME battle relocated the table enough to
/// justify replacing the pinned anchor: the first row moved by more than half
/// a row pitch (see [`ANCHOR_MOVE_HALF_PITCH`]). A fallback anchor
/// (`table_detected == false`) never replaces a confirmed pin, and
/// degenerate grids never count as movement.
pub(crate) fn anchor_meaningfully_moved(
    pinned: &wowsp_tauri_shared::OverlayAnchor,
    fresh: &wowsp_tauri_shared::OverlayAnchor,
) -> bool {
    // A fallback anchor ("table not located" geometry) must never replace a
    // pin that was itself a confirmed detection.
    if !fresh.table_detected || pinned.row_centers.is_empty() || fresh.row_centers.is_empty() {
        return false;
    }
    let pitch = anchor_row_pitch(fresh, pinned);
    if pitch <= 0.0 {
        return false;
    }
    let dy = (fresh.row_centers[0] - pinned.row_centers[0]).abs() as f32;
    dy > pitch * ANCHOR_MOVE_HALF_PITCH
}

// ─────────────────────────────────────────────────────────────────────────
// Row name-strip cropping (the sink solver's fingerprint input)
// ─────────────────────────────────────────────────────────────────────────
