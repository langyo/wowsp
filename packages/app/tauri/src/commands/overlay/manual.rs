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
/// a 0.5 team split (two side-by-side columns). `row_players` stays `None`
/// ON PURPOSE: the OCR pipeline is not run on a hand-drawn box — the per-row
/// player count comes from the roster and need not match the drawn rows, so
/// an index guess could pin the wrong stats onto chips. Honest silence (no
/// chips on an off-count row) beats confidently wrong data. In the inferred
/// mode the overlay page goes one better and names the rows itself from the
/// verified sort rule (the drawn grid mirrors the roster's team sizes, the
/// same closed-set contract the automatic flow deduces from).
pub(super) fn build_manual_anchor(m: &ManualAnchor, game_screen: Rect) -> OverlayAnchor {
    let rows = manual_row_centers(&m.rect, m.team_sizes);
    let (_, anchor) = overlay_detect::build_anchor(&game_screen, &m.rect, rows, 0.5, true);
    anchor
}

/// Destroy the picker window if present (any teardown path: confirm,
/// cancel, overlay-mode end, game exit). Pure programmatic teardown —
/// `destroy()`, not `close()`, for the same reason as
/// `destroy_overlay_window`.
pub(super) fn destroy_manual_locate_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MANUAL_LOCATE_LABEL)
        && let Err(e) = win.destroy()
    {
        tracing::warn!(error = %e, "destroy manual-locate window failed");
    }
}

/// Kill the DWM 1px border + rounded corners on the borderless transparent
/// picker (same visual fix as `post_create_window_setup`) — but deliberately
/// WITHOUT the click-through (`set_ignore_cursor_events`) and the
/// NOACTIVATE/TOOLWINDOW ex-styles: the picker must receive mouse + keyboard
/// input and may take focus (Enter/Esc are part of the flow).
#[cfg(target_os = "windows")]
fn post_create_manual_window_setup(win: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND, DwmSetWindowAttribute,
    };
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                &(DWMNCRP_DISABLED.0) as *const _ as *const core::ffi::c_void,
                4,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &(DWMWCP_DONOTROUND.0) as *const _ as *const core::ffi::c_void,
                4,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn post_create_manual_window_setup(_win: &tauri::WebviewWindow) {}

/// Open the manual-locate picker. Two modes, decided before the window is
/// shown:
///
/// - SCREENSHOT mode (preferred): a usable cached automatic capture exists
///   (fresh + size-matched), or a FRESH capture shows the team header (the
///   player is holding Tab in-game). The picker shows that frame with the
///   detector's guides overlaid — see `manual_locate_context` — sized to
///   the game monitor's WORK area, so the player boxes a STATIC, undimmed
///   table without juggling Tab, focus and a transparent overlay.
/// - LIVE mode (legacy fallback): no usable frame. The picker is a
///   transparent, always-on-top, INTERACTIVE window placed exactly over
///   the game rect, where the player drag-boxes the live table.
///
/// Single-instance — a call while one is open is a no-op. Requires a fresh
/// battle roster and a resolvable game window.
#[tauri::command]
pub async fn start_manual_locate(app: AppHandle, locale: Option<String>) -> Result<(), String> {
    if app.get_webview_window(MANUAL_LOCATE_LABEL).is_some() {
        return Ok(()); // already open
    }
    // Same battle-known gate as the Tab watcher, with the same cheap
    // synchronous refresh on a stale cache.
    let mut battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
    if !battle_known {
        battle_known = super::arena_info::refresh_battle_state();
    }
    if !battle_known {
        return Err("no fresh battle roster — manual locate unavailable".into());
    }
    #[cfg(target_os = "windows")]
    let game = find_game_window().ok_or("game window not found")?;
    #[cfg(target_os = "windows")]
    let game_rect = rect_from_win32(game.rect);
    #[cfg(not(target_os = "windows"))]
    let game_rect = Rect {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    };

    // Screenshot mode when a usable picker frame resolves — see
    // `usable_picker_frame` (shared with the context command so the two
    // decisions cannot drift apart).
    #[cfg(target_os = "windows")]
    let screenshot_mode = usable_picker_frame(&game).is_some();
    #[cfg(not(target_os = "windows"))]
    let screenshot_mode = false;

    // Same pre-rendered static page pattern as the overlay window (no Vue,
    // instant first paint); the locale picks the hint/button copy, and the
    // decided MODE rides along so the page can tell "no frame because the
    // backend chose live" from "frame lost between the two calls" (the
    // latter closes itself — see the page's boot).
    let mut url = "/manual-locate.html".to_string();
    let mut sep = "?";
    if let Some(l) = locale.as_deref().filter(|l| !l.is_empty()) {
        url.push_str(sep);
        url.push_str("locale=");
        url.push_str(l);
        sep = "&";
    }
    if screenshot_mode {
        url.push_str(sep);
        url.push_str("mode=shot");
    }
    let win = WebviewWindowBuilder::new(&app, MANUAL_LOCATE_LABEL, WebviewUrl::App(url.into()))
        .title("WoWSP Manual Locate")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false) // shown once placed
        .build()
        .map_err(|e| format!("create manual-locate window: {e}"))?;
    post_create_manual_window_setup(&win);
    if screenshot_mode {
        if let Err(e) = place_picker_window(&win, &game_rect) {
            // Never leave a hidden zombie behind: the single-instance guard
            // above would treat it as "already open" and silently swallow
            // every later manual-locate click until restart.
            destroy_manual_locate_window(&app);
            return Err(e);
        }
    } else {
        // Live mode: physical-pixel alignment with the game rect — the same
        // rect the watcher BitBlts and places the overlay at, so page CSS
        // px × devicePixelRatio map 1:1 onto the game's framebuffer.
        let _ = win.set_position(tauri::PhysicalPosition::new(game_rect.x, game_rect.y));
        let _ = win.set_size(tauri::PhysicalSize::new(
            game_rect.width.max(1) as u32,
            game_rect.height.max(1) as u32,
        ));
    }
    if let Err(e) = win.show() {
        // Same no-zombie rule as the placement failure above.
        destroy_manual_locate_window(&app);
        return Err(format!("show manual-locate: {e}"));
    }
    let _ = win.set_focus();
    tracing::info!(
        rect = format!(
            "{}x{} at ({},{})",
            game_rect.width, game_rect.height, game_rect.x, game_rect.y
        ),
        screenshot_mode,
        "manual-locate picker opened"
    );
    Ok(())
}

/// The frame the picker should anchor against, resolved the SAME way by
/// `start_manual_locate` (mode decision) and `manual_locate_context`
/// (payload build): the fresh cached automatic capture when one matches the
/// current game window, else — only when a FRESH capture shows the team
/// header (the player is holding Tab in-game; a frame WITHOUT the table is
/// useless as a positioning reference and must not evict a good cache
/// entry) — that capture, stored and returned. Windows-only.
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

/// Size + place the SCREENSHOT-mode picker on the game's monitor: the frame
/// fitted into the monitor's WORK area (never over the taskbar), plus room
/// for the page's toolbar. Everything in PHYSICAL px on purpose — the picker
/// may sit on a different-scale monitor than the shell window, and the page
/// maps its coordinates through its own CSS box (see `manual_locate_context`),
/// so no logical/DPI unit is involved anywhere on this path.
#[cfg(target_os = "windows")]
fn place_picker_window(win: &tauri::WebviewWindow, game_rect: &Rect) -> Result<(), String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

    unsafe {
        let pt = POINT {
            x: game_rect.x + game_rect.width / 2,
            y: game_rect.y + game_rect.height / 2,
        };
        let monitor = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut dpi_x = 96u32;
        let mut dpi_y = 96u32;
        let scale = if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y).is_ok()
        {
            f32::from(dpi_x as u16) / 96.0
        } else {
            1.0
        };
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let (wx, wy, ww, wh) = if GetMonitorInfoW(monitor, &mut mi).as_bool() {
            (
                mi.rcWork.left,
                mi.rcWork.top,
                mi.rcWork.right - mi.rcWork.left,
                mi.rcWork.bottom - mi.rcWork.top,
            )
        } else {
            (game_rect.x, game_rect.y, game_rect.width, game_rect.height)
        };
        let margin = (48.0 * scale).round() as i32;
        let toolbar = (44.0 * scale).round() as i32;
        let avail_w = (ww - 2 * margin).max(320);
        let avail_h = (wh - 2 * margin - toolbar).max(200);
        let fit = (f64::from(avail_w) / f64::from(game_rect.width.max(1)))
            .min(f64::from(avail_h) / f64::from(game_rect.height.max(1)))
            .min(1.0);
        let win_w = ((f64::from(game_rect.width) * fit).round() as i32).max(320);
        let win_h = ((f64::from(game_rect.height) * fit).round() as i32 + toolbar).max(240);
        let x = wx + (ww - win_w) / 2;
        let y = wy + (wh - win_h) / 2;
        win.set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| format!("place manual-locate: {e}"))?;
        win.set_size(tauri::PhysicalSize::new(
            win_w.max(1) as u32,
            win_h.max(1) as u32,
        ))
        .map_err(|e| format!("size manual-locate: {e}"))?;
    }
    Ok(())
}

/// Build the screenshot-mode context the picker page loads with: the cached
/// automatic capture (downscaled to ≤1280 px wide, PNG, base64) plus the
/// guides the detector finds on it RIGHT NOW (table rect, row lines, team
/// seam). All heavy work runs once here, on a clone — the watcher's hot
/// path never pays for the picker. No usable frame → all-None fields and
/// the page runs the legacy live picker. Desktop only (the picker page
/// itself never exists on mobile).
#[tauri::command]
pub async fn manual_locate_context() -> Result<ManualLocateContext, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(game) = find_game_window() else {
            return Ok(ManualLocateContext::default());
        };
        // Same resolver `start_manual_locate` based its window placement on
        // (cache first, fresh-with-table-header fallback) — see
        // `usable_picker_frame`.
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

/// Cancel + destroy the manual-locate picker without storing anything
/// (the picker page's Cancel button / Esc).
#[tauri::command]
pub async fn cancel_manual_locate(app: AppHandle) -> Result<(), String> {
    destroy_manual_locate_window(&app);
    Ok(())
}

/// Submit the picker's selection (physical px relative to the game window
/// origin): validate it and enqueue it as a FIFO command — the watcher loop
/// arms the manual anchor and reports the manual badge from there (within
/// one poll interval). The anchor takes effect on the next Tab hold.
#[tauri::command]
pub async fn set_manual_roster_rect(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
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
    // Success — the picker's job is done; it must not linger as a zombie.
    destroy_manual_locate_window(&app);
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
/// if one is somehow still open.
#[tauri::command]
pub async fn clear_manual_roster_rect(app: AppHandle) -> Result<(), String> {
    push_watch_command(WatchCommand::ManualAnchorCleared);
    destroy_manual_locate_window(&app);
    Ok(())
}
