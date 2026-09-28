use super::*;
// ─────────────────────────────────────────────────────────────────────────
// Manual locate (screenshot-style drag box)
// ─────────────────────────────────────────────────────────────────────────

/// Per-edge tolerance (physical px) for "same game-window geometry" checks
/// (pin validity, manual-anchor validity): DWM extended-frame bounds flap by
/// a pixel or two across fullscreen transitions and focus switches WITHOUT
/// the table moving relative to the window, and the exact-equality checks
/// silently expired pins/anchors on it — a manual box the user just drew
/// died to an invisible 1-px change.
const RECT_JITTER_TOLERANCE_PX: i32 = 4;

/// True when two game-window rects are the same geometry up to harmless
/// DWM jitter (each edge within [`RECT_JITTER_TOLERANCE_PX`]).
pub(super) fn rect_same_within(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() <= RECT_JITTER_TOLERANCE_PX
        && (a.y - b.y).abs() <= RECT_JITTER_TOLERANCE_PX
        && (a.width - b.width).abs() <= RECT_JITTER_TOLERANCE_PX
        && (a.height - b.height).abs() <= RECT_JITTER_TOLERANCE_PX
}

/// A user-drawn roster box, valid for ONE battle (arena stamp) on ONE
/// game-window geometry. Held in the watcher's FSM ([`WatchFsm::
/// manual_anchor`]): while the battle stamp and the game rect both still
/// match, every Tab hold anchors the chips to this box instead of running
/// the detector.
#[derive(Debug, Clone)]
pub(super) struct ManualAnchor {
    /// Arena stamp (tempArenaInfo.json mtime) the box was drawn under — a
    /// new battle invalidates it.
    pub(super) battle: i64,
    /// Game-window rect at draw time (physical screen px) — a moved or
    /// resized game window invalidates it (up to the jitter tolerance —
    /// see [`rect_same_within`]).
    pub(super) game_rect: Rect,
    /// The selection itself, PHYSICAL px relative to the game window's
    /// top-left corner (exactly what the picker webview submits).
    pub(super) rect: Rect,
    /// (allies, enemies) of the roster at draw time — drives the row-grid
    /// derivation. Frozen here so a roster re-read mid-battle cannot
    /// silently move chips the user just placed.
    pub(super) team_sizes: (usize, usize),
}

/// Outcome of checking the stored manual anchor against the CURRENT battle
/// stamp + game-window rect.
#[derive(Debug, Clone)]
pub(super) enum ManualAnchorCheck {
    /// In force — carries a clone plus the matched game rect (which is
    /// therefore known to be `Some`).
    Live(ManualAnchor, Rect),
    /// Stored but expired: the battle changed, or the game window
    /// moved/resized. The watcher drops it and falls back to the automatic
    /// flow.
    Stale,
    /// Nothing stored — or no game-window rect THIS tick to judge against.
    /// The second case is deliberately NOT `Stale`: a transient HWND
    /// resolution miss must not nuke a box the user just drew.
    Inert,
}

/// Pure decision: does a stored manual anchor still apply to this battle on
/// this game-window geometry? The anchor lives in the watcher FSM, so the
/// stored value is passed in directly and the decision stays unit-testable
/// without cross-test static state.
pub(super) fn manual_anchor_check(
    stored: Option<&ManualAnchor>,
    battle: i64,
    game_rect: Option<Rect>,
) -> ManualAnchorCheck {
    let Some(m) = stored else {
        return ManualAnchorCheck::Inert;
    };
    if m.battle != battle {
        return ManualAnchorCheck::Stale;
    }
    match game_rect {
        Some(r) if rect_same_within(&r, &m.game_rect) => ManualAnchorCheck::Live(m.clone(), r),
        Some(_) => ManualAnchorCheck::Stale,
        None => ManualAnchorCheck::Inert,
    }
}

/// Total row count of a stored manual anchor, when one is armed (any
/// liveness — the watcher only expires it on the focused+Tab path). Drives
/// the `manual` flag on automatic status reports: while the anchor survives
/// an Idle/Searching transition, the panel's manual badge + clear button
/// must survive it with it.
pub(super) fn stored_manual_rows(stored: Option<&ManualAnchor>) -> Option<u32> {
    stored.map(|m| (m.team_sizes.0 + m.team_sizes.1) as u32)
}

/// Pure: validate a picker submission (game-relative physical px) against
/// the game rect.
pub(super) fn validate_manual_selection(sel: &Rect, game: &Rect) -> Result<(), String> {
    if sel.width <= MANUAL_MIN_SIZE || sel.height <= MANUAL_MIN_SIZE {
        return Err(format!(
            "selection {}x{} too small (min {}x{} px per axis)",
            sel.width, sel.height, MANUAL_MIN_SIZE, MANUAL_MIN_SIZE
        ));
    }
    if sel.x < 0 || sel.y < 0 || sel.x + sel.width > game.width || sel.y + sel.height > game.height
    {
        return Err(format!(
            "selection ({},{})+{}x{} escapes the game window {}x{}",
            sel.x, sel.y, sel.width, sel.height, game.width, game.height
        ));
    }
    Ok(())
}

/// Pure: derive the chip-row centers from a manual selection. Each team's
/// rows spread EVENLY over the FULL selection height at the pitch of the
/// LARGER team (`height / max(allies, enemies)`): the in-game panel renders
/// two side-by-side columns, the taller one fills the box, and row `i` of a
/// side sits at `y + pitch * (i + 0.5)`. The two blocks are concatenated
/// allies-first (the [`OverlayAnchor`] block order); a shorter enemy side
/// simply ends early.
pub(super) fn manual_row_centers(rect: &Rect, team_sizes: (usize, usize)) -> Vec<i32> {
    let tallest = team_sizes.0.max(team_sizes.1).max(1) as i32;
    let pitch = rect.height as f64 / tallest as f64;
    let mut centers = Vec::with_capacity(team_sizes.0 + team_sizes.1);
    for count in [team_sizes.0, team_sizes.1] {
        for i in 0..count as i64 {
            centers.push(rect.y + (pitch * (i as f64 + 0.5)).round() as i32);
        }
    }
    centers
}

/// Build the chip-layer anchor from a live manual anchor: the selection is
/// treated exactly like a DETECTED roster rect (padded, re-based to the
/// overlay window origin by the shared `overlay_detect::build_anchor`), with
/// a 0.5 team split (two side-by-side columns). `row_alive` stays `None`
/// ON PURPOSE: the luma pass is not run on a hand-drawn box — the per-row
/// player count comes from the roster and need not match the drawn rows.
/// The overlay page names the rows itself from the
/// verified sort rule (the drawn grid mirrors the roster's team sizes, the
/// same closed-set contract the automatic flow deduces from).
pub(super) fn build_manual_anchor(m: &ManualAnchor, game_screen: Rect) -> OverlayAnchor {
    let rows = manual_row_centers(&m.rect, m.team_sizes);
    let (_, anchor) = overlay_detect::build_anchor(&game_screen, &m.rect, rows, 0.5, true);
    anchor
}

/// Open-state of the manual-locate picker LAYER inside the main window (no
/// dedicated window exists anymore — the main window's webui renders the
/// cached-frame picker as a full-cover sub-window). Set by
/// `start_manual_locate`, cleared by every close path (submit / cancel /
/// clear / force-close) so the watcher's `picker_open` gate and the
/// game-gone teardown keep working without a window to query.
static PICKER_OPEN: AtomicBool = AtomicBool::new(false);

/// True while the main window's manual-locate picker layer is open.
pub(super) fn manual_locate_open() -> bool {
    PICKER_OPEN.load(Ordering::SeqCst)
}

/// Force-close the picker layer from the backend (the game window vanished
/// underneath it, or overlay mode ended): clears the open flag and tells the
/// main window to unmount the layer. No-op when nothing is open.
pub(super) fn force_close_manual_locate(app: &AppHandle) {
    if PICKER_OPEN.swap(false, Ordering::SeqCst) {
        if let Err(e) = app.emit(MANUAL_LOCATE_CLOSE_EVENT, ()) {
            tracing::warn!(error = %e, "emit manual-locate-close failed");
        }
    }
}

/// Open the manual-locate picker INSIDE the main window. The main window's
/// webui renders the cached-frame picker as a full-cover sub-window layer
/// (see `ManualLocateOverlay`); this command is the backend gate + open
/// flag — no window is built here anymore.
///
/// Gates, decided before the layer opens:
///
/// - a fresh battle roster exists (same gate as the Tab watcher, with the
///   same cheap synchronous refresh on a stale cache);
/// - the game window resolves;
/// - a usable picker frame exists — the fresh cached automatic capture, or
///   a FRESH capture showing the team header (the player is holding Tab
///   in-game) — see `usable_picker_frame`, shared with
///   `manual_locate_context` so the two decisions cannot drift apart.
///
/// A refused gate returns a STABLE ERROR CODE the webui localizes into the
/// toast it shows next to the shake: `"no-battle"` / `"no-game"` /
/// `"no-frame"`. No frame → refused: without a frame there is nothing to
/// box, and the old live-overlay fallback (a transparent window exactly
/// over the game) is gone together with the dedicated picker window.
///
/// Single-instance by construction: the layer is webui state, and a call
/// while it is open just re-runs the gates and re-arms the flag.
#[tauri::command]
pub async fn start_manual_locate() -> Result<(), String> {
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    if !battle_known {
        battle_known = super::arena_info::refresh_battle_state();
    }
    if !battle_known {
        tracing::warn!("manual locate refused: no fresh battle roster");
        return Err("no-battle".into());
    }
    #[cfg(target_os = "windows")]
    {
        let Some(game) = find_game_window() else {
            tracing::warn!("manual locate refused: game window not found");
            return Err("no-game".into());
        };
        if usable_picker_frame(&game).is_none() {
            tracing::warn!("manual locate refused: no usable cached frame");
            return Err("no-frame".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // No game window off-Windows (same answer the window gate would
        // give): the picker has nothing to anchor against.
        tracing::warn!("manual locate refused: game window not found (non-windows)");
        return Err("no-game".into());
    }
    PICKER_OPEN.store(true, Ordering::SeqCst);
    tracing::info!("manual-locate picker layer opened in the main window");
    Ok(())
}

/// The frame the picker should anchor against, resolved the SAME way by
/// `start_manual_locate` (open gate) and `manual_locate_context` (payload
/// build): the fresh cached automatic capture when one matches the current
/// game window, else — only when a FRESH capture shows the team header (the
/// player is holding Tab in-game; a frame WITHOUT the table is useless as a
/// positioning reference and must not evict a good cache entry) — that
/// capture, stored and returned. Windows-only.
#[cfg(target_os = "windows")]
fn usable_picker_frame(game: &GameWindow) -> Option<(Vec<u8>, u32, u32, u64, Rect)> {
    let game_rect = rect_from_win32(game.rect);
    if let Some(frame) = super::overlay_manual::fresh_frame_for(&game_rect) {
        return Some(frame);
    }
    let (rgba, w, h) = capture_game_rgba(&game.rect)?;
    if !overlay_detect::header_bars_present(&rgba, w, h) {
        return None;
    }
    let at_ms = super::overlay_manual::store_capture(&rgba, w, h, game_rect);
    Some((rgba, w, h, at_ms, game_rect))
}

/// Build the screenshot-mode context the main window's picker layer loads
/// with: the cached automatic capture (downscaled to ≤1280 px wide, PNG,
/// base64) plus the guides the detector finds on it RIGHT NOW (table rect,
/// row lines, team seam). All heavy work runs once here, on a clone — the
/// watcher's hot path never pays for the picker. No usable frame →
/// all-None fields and the layer shows its "no frame" state (retry /
/// close). Desktop only (the picker layer never exists on mobile).
#[tauri::command]
pub async fn manual_locate_context() -> Result<ManualLocateContext, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(game) = find_game_window() else {
            return Ok(ManualLocateContext::default());
        };
        // Same resolver the open gate ran (cache first, fresh-with-table-
        // header fallback) — see `usable_picker_frame`.
        let Some((rgba, w, h, at_ms, captured_rect)) = usable_picker_frame(&game) else {
            return Ok(ManualLocateContext::default());
        };
        let team_sizes = super::arena_info::last_known_team_sizes();
        let guides = match overlay_detect::detect_roster_with_band(&rgba, w, h, team_sizes) {
            Some((_, det)) => {
                let seam = (det.rect.x as f64 + f64::from(det.rect.width) * det.team_split as f64)
                    .round() as i32;
                ManualLocateGuides {
                    table_rect: Some(det.rect),
                    row_lines: det.row_centers,
                    seam_x: Some(seam),
                }
            },
            None => ManualLocateGuides::default(),
        };
        let (image_base64, image_width, image_height) = encode_picker_image(&rgba, w, h);
        Ok(ManualLocateContext {
            image_base64,
            image_width,
            image_height,
            phys_width: w,
            phys_height: h,
            captured_at_ms: Some(at_ms),
            captured_game_rect: Some(captured_rect),
            guides,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(ManualLocateContext::default())
    }
}

/// Transport encoding of the picker's background: integer-factor box-average
/// downscale to at most 1280 px wide (the factor keeps the physical→image
/// mapping exact), PNG, base64. `None` when encoding fails.
#[cfg(target_os = "windows")]
fn encode_picker_image(rgba: &[u8], w: u32, h: u32) -> (Option<String>, Option<u32>, Option<u32>) {
    const PICKER_IMAGE_MAX_WIDTH: u32 = 1280;
    let (buf, nw, nh) = if w > PICKER_IMAGE_MAX_WIDTH {
        let factor = w.div_ceil(PICKER_IMAGE_MAX_WIDTH);
        let nw = w / factor;
        let nh = h / factor;
        let mut out = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
                let n = factor * factor;
                for dy in 0..factor {
                    for dx in 0..factor {
                        let i = (((y * factor + dy) * w + x * factor + dx) * 4) as usize;
                        sr += u32::from(rgba[i]);
                        sg += u32::from(rgba[i + 1]);
                        sb += u32::from(rgba[i + 2]);
                    }
                }
                let o = ((y * nw + x) * 4) as usize;
                out[o] = (sr / n).min(255) as u8;
                out[o + 1] = (sg / n).min(255) as u8;
                out[o + 2] = (sb / n).min(255) as u8;
                out[o + 3] = 255;
            }
        }
        (out, nw, nh)
    } else {
        (rgba.to_vec(), w, h)
    };
    let png = encode_png(&buf, nw, nh);
    if png.is_empty() {
        return (None, None, None);
    }
    (
        Some(base64::engine::general_purpose::STANDARD.encode(png)),
        Some(nw),
        Some(nh),
    )
}

/// Cancel the manual-locate picker without storing anything (the layer's
/// Cancel button / Esc): just clears the open flag — the main window
/// unmounts the layer itself.
#[tauri::command]
pub async fn cancel_manual_locate() -> Result<(), String> {
    PICKER_OPEN.store(false, Ordering::SeqCst);
    Ok(())
}

/// Submit the picker's selection (physical px relative to the game window
/// origin): validate it and enqueue it as a FIFO command — the watcher loop
/// arms the manual anchor and reports the manual badge from there (within
/// one poll interval). The anchor takes effect on the next Tab hold.
#[tauri::command]
pub async fn set_manual_roster_rect(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    let sel = Rect {
        x,
        y,
        width,
        height,
    };
    // Battle gate — same freshness rule as the Tab watcher.
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    if !battle_known {
        battle_known = super::arena_info::refresh_battle_state();
    }
    if !battle_known {
        return Err("no fresh battle roster — manual locate unavailable".into());
    }
    let team_sizes = super::arena_info::last_known_team_sizes();
    if team_sizes.0.max(team_sizes.1) == 0 {
        return Err("battle roster team sizes unknown — cannot derive rows".into());
    }
    #[cfg(target_os = "windows")]
    let game_rect = rect_from_win32(find_game_window().ok_or("game window not found")?.rect);
    #[cfg(not(target_os = "windows"))]
    let game_rect = Rect {
        x: 0,
        y: 0,
        width: i32::MAX,
        height: i32::MAX,
    };
    validate_manual_selection(&sel, &game_rect)?;
    let battle = super::arena_info::last_arena_stamp();
    // No direct status emit here (the old immediate Manual report): the
    // watcher loop applies this command FIFO within one poll interval and
    // emits the identical payload from the single emitter — same panel
    // feedback, but ordered against every other watcher transition.
    push_watch_command(WatchCommand::ManualAnchorSet {
        rect: sel,
        game_rect,
        battle,
        team_sizes,
    });
    // Success — the picker's job is done: clear the open flag (the main
    // window closes the layer on this Ok response) so the watcher's
    // `picker_open` gate releases immediately.
    PICKER_OPEN.store(false, Ordering::SeqCst);
    tracing::info!(
        battle,
        sel = format!("{}x{} at ({},{})", sel.width, sel.height, sel.x, sel.y),
        allies = team_sizes.0,
        enemies = team_sizes.1,
        "manual roster anchor queued"
    );
    Ok(())
}

/// Drop the manual anchor (the live-battle panel's "clear locate" button)
/// via the FIFO pipeline: the watcher loop clears the anchor and reports
/// the state the overlay is ACTUALLY in — visible with a live automatic
/// pin → detected, visible without one → searching, hidden (Tab up / game
/// unfocused) → idle. An unconditional "searching" would stick forever —
/// the watcher's hide branch only runs while the overlay is shown, so
/// nothing would ever demote the badge afterwards. Also closes the picker
/// layer if one is somehow still open.
#[tauri::command]
pub async fn clear_manual_roster_rect(app: AppHandle) -> Result<(), String> {
    push_watch_command(WatchCommand::ManualAnchorCleared);
    force_close_manual_locate(&app);
    Ok(())
}
