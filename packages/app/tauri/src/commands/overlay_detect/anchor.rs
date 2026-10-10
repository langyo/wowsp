use super::*;

/// Vertical padding (physical px) added above/below the detected table when
/// sizing the overlay window.
pub(crate) fn overlay_padding(roster: &Rect) -> i32 {
    (roster.height / 8).clamp(24, 96)
}

/// The chip layer's worst-case side reserve in CSS px. The chips anchor at
/// the table's edge and grow OUTWARD with `white-space: nowrap`; the widest
/// steady-state face (four dot-joined numbers with their localized battle
/// unit, plus a four-character career seal and its gap) measures ~20 font
/// heights ≈ 300 CSS px at the chip font cap (15 CSS px), and the pad must
/// also carry the anchor gap plus the fit pass's overhang tolerance. 350 is
/// that worst case with headroom; candidate-RANGE chips (several players'
/// numbers slash-joined) deliberately exceed it — chipFit trims their seals
/// and clamps them last, which is the designed degradation for a row that
/// has no right to a fixed pad.
const SIDE_PAD_CSS_PX: f32 = 350.0;

/// Horizontal padding (physical px): WIDER than vertical because the stat
/// chips render OUTSIDE the table's left/right edges (inside they cover the
/// ship names) — the window must reserve a full chip width per side. The
/// reserve is DPI-AWARE: chip fonts are CSS px (the overlay page sizes them
/// off the row pitch, capped at 15) while every rect here is physical, so
/// the same visual chip occupies `scale ×` more physical pixels on a
/// scaled monitor and a pad picked in raw physical px silently starves the
/// chips there. It did exactly that: the old `width / 4` heuristic with a
/// fixed 320–560 physical envelope left 246 CSS px of room on a 150%
/// monitor's random-battle table (1477 physical px wide → 369 physical pad
/// → 246 CSS) against a ~300 CSS px chip — every loaded number chip
/// overflowed its side pad and chipFit's last-resort clamp pinned them to
/// the window edge, each at its own width, so the chip column lost the
/// table-edge alignment outright (both on the two-column table and on the
/// story/PvE single-column one, where the narrow table drove the pad onto
/// its 320 floor). The reserve is therefore `SIDE_PAD_CSS_PX × scale`,
/// still grown by a quarter of the table width when the layout is wide
/// enough to afford more, and the window's own game-window clamp keeps the
/// wider request from overreaching the screen. Past the covered reserve
/// chipFit trims seals first and only then slides the chip back over the
/// table's outer column, so an under-padded window degrades visibly (lost
/// seals) before it degrades badly.
pub(crate) fn overlay_padding_x(roster: &Rect, dpi_scale: f32) -> i32 {
    ((SIDE_PAD_CSS_PX * dpi_scale.max(1.0)).round() as i32)
        .max(roster.width / 4)
        .min(1024)
}

/// Build the overlay-window anchor from a detection relative to the game
/// window: the overlay covers ONLY the table area (inflated by padding), and
/// every coordinate is re-based to the overlay window's origin. `dpi_scale`
/// is the game window's monitor scale (1.0 = 96 DPI — read off the game
/// HWND by `window_dpi_scale` in `commands::overlay::game_window`); the
/// side pad converts the chip layer's CSS reserve into this rect's physical
/// pixels with it. Returns the anchor plus the overlay rect in SCREEN
/// coordinates for window placement.
pub(crate) fn build_anchor(
    game_screen: &Rect,
    roster_rel: &Rect,
    mut row_centers: Vec<i32>,
    team_split: f32,
    table_detected: bool,
    dpi_scale: f32,
) -> (Rect, wowsp_tauri_shared::OverlayAnchor) {
    let pad = overlay_padding(roster_rel);
    let padx = overlay_padding_x(roster_rel, dpi_scale);
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

/// The anchor's roster rect LEFT/RIGHT edges in capture coordinates
/// (game-window-relative). `roster_rect` is re-based to the overlay window's
/// origin at build time, and that origin is laid down a fixed pad to the left
/// of the table — overlay-relative coordinates are pad-relative and cancel a
/// whole-panel move, so the move test recovers the absolute geometry with
/// `overlay_rect − game_rect` (the overlay origin inside the capture).
fn capture_roster_span(a: &wowsp_tauri_shared::OverlayAnchor) -> (i32, i32) {
    let left = a.roster_rect.x + a.overlay_rect.x - a.game_rect.x;
    (left, left + a.roster_rect.width)
}

/// Whether a fresh detection of the SAME battle relocated the table enough to
/// justify replacing the pinned anchor. A fallback anchor
/// (`table_detected == false`) never replaces a confirmed pin, and
/// degenerate grids never count as movement. Three move shapes count:
///
/// - VERTICAL: the first row moved by more than half a row pitch (see
///   [`ANCHOR_MOVE_HALF_PITCH`]) — the panel moving as a WHOLE when HUD
///   phases change (the countdown "waiting players" layout sits ~190 px ≈
///   3.7 row pitches above the combat layout at 3072x1920), sunk re-sorts.
/// - HORIZONTAL: the table's left or right edge (capture coordinates, see
///   [`capture_roster_span`]) moved beyond the same half-pitch threshold —
///   the layout switch the row test is blind to, because the re-based rows
///   move WITH the panel. Seen live on the story/operation (剧情/行动)
///   battles: the early Tab screen pins the two-team table, then the combat
///   screen collapses to the single centered team table at the same height —
///   every row stays put while the table halves in width, so without this
///   test the chips kept hanging in the empty space of the phantom second
///   column for the whole battle.
/// - KIND: a team-split flip. `team_split` is exactly 1.0 only on the
///   green-only single-team PVE table and 0.30–0.70 on the two-bar one
///   ([`super::roster::finish_roster`]), so a flip is a header-kind change
///   by definition.
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
    let threshold = pitch * ANCHOR_MOVE_HALF_PITCH;
    let dy = (fresh.row_centers[0] - pinned.row_centers[0]).abs() as f32;
    if dy > threshold {
        return true;
    }
    let (pinned_l, pinned_r) = capture_roster_span(pinned);
    let (fresh_l, fresh_r) = capture_roster_span(fresh);
    let dx = (fresh_l - pinned_l).abs().max((fresh_r - pinned_r).abs()) as f32;
    if dx > threshold {
        return true;
    }
    (pinned.team_split >= 0.999) != (fresh.team_split >= 0.999)
}

// ─────────────────────────────────────────────────────────────────────────
// Row name-strip cropping (the sink solver's fingerprint input)
// ─────────────────────────────────────────────────────────────────────────
