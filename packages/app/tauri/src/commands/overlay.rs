//! In-game overlay commands (milestones M6/M8).
//!
//! Overlay mode (Mode 2 in PLAN.md): a SEPARATE transparent, always-on-top,
//! click-through, decoration-less window sits on top of the game. It loads
//! the same index.html with `?window=overlay`, which makes main.ts mount
//! OverlayApp (no router, no title bar, transparent background).
//!
//! While the user holds `Tab` (with the game window in the foreground), a
//! watcher thread on the Rust side:
//!
//!   1. captures the game window region once (virtual-screen GDI `BitBlt`,
//!      multi-monitor safe — negative origins included);
//!   2. runs the team-list detector (`overlay_detect`) on that frame to find
//!      the table rectangle, the player rows and the team split;
//!   3. repositions the overlay window over the game rect (physical pixels,
//!      DPI-consistent with the webview's `devicePixelRatio`), emits a
//!      `wowsp://overlay-anchor` event with the anchor, and shows the window
//!      WITHOUT activating it (never steals focus from the game);
//!   4. hides the window again on Tab release (or when the game loses the
//!      foreground).
//!
//! The overlay window is created lazily by `create_overlay_window` (called
//! once when overlay mode starts, hidden) and destroyed by
//! `destroy_overlay_window` (when the game exits or overlay mode is turned
//! off). The main shell window keeps running underneath.
//!
//! Threading: every command here is `async` so it runs on the Tauri async
//! runtime, NOT the main/UI thread — sync commands execute inline on the
//! webview IPC (main) thread, and `create_overlay_window` builds an entire
//! WebView2 window, which would stall every queued request during startup.
//! The Tab watcher is a detached `std::thread` that only talks to the shell
//! via thread-safe dispatches (`emit`, `set_position`, …).

use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use wowsp_tauri_shared::{CaptureResult, OverlayAnchor, Rect};

use super::overlay_detect;

/// Label of the dedicated overlay window (distinct from "main").
const OVERLAY_LABEL: &str = "overlay";

/// Tauri event carrying the latest anchor to the overlay webview.
pub const OVERLAY_ANCHOR_EVENT: &str = "wowsp://overlay-anchor";

/// Watcher poll period — fast enough that ≤30 ms of Tab latency is
/// imperceptible, slow enough that two cheap Win32 calls are noise.
const POLL_INTERVAL: Duration = Duration::from_millis(30);
/// Rate limit for capture attempts (GDI `BitBlt(CAPTUREBLT)` + detector
/// work is expensive): a fresh Tab press reuses the cached anchor inside
/// this window and is refused a new capture until it elapses — so frantic
/// tapping or a focus flicker while holding Tab caps at ~0.67 captures/s.
const CAPTURE_MIN_INTERVAL: Duration = Duration::from_millis(1500);
/// A capture is only attempted while the most recent battle roster
/// (tempArenaInfo.json mtime) is younger than this — Tab in port or long
/// after a battle stays a no-op.
const ARENA_FRESHNESS_SECS: u64 = 30 * 60;
/// How often the cached game HWND is re-resolved.
const HWND_REFRESH: Duration = Duration::from_secs(2);

// ─────────────────────────────────────────────────────────────────────────
// Window management
// ─────────────────────────────────────────────────────────────────────────

/// Create the transparent overlay window if it doesn't exist yet. Idempotent —
/// a second call just returns without recreating. The window starts hidden;
/// the Tab watcher shows it. `realm` (when known) is forwarded via the URL so
/// the overlay webview can batch WG lookups without re-detecting the install.
/// Also starts the Tab watcher thread.
#[tauri::command]
pub async fn create_overlay_window(
    app: AppHandle,
    realm: Option<String>,
    locale: Option<String>,
) -> Result<(), String> {
    if app.get_webview_window(OVERLAY_LABEL).is_none() {
        // The overlay window loads a PRE-RENDERED static page (bare HTML +
        // CSS + a tiny vanilla listener, built as a second Vite entry) —
        // no Vue app, no loading state, first paint is instant.
        let mut url = "/overlay.html".to_string();
        let mut sep = "?";
        if let Some(r) = realm.as_deref().filter(|r| !r.is_empty()) {
            url.push_str(sep);
            url.push_str("realm=");
            url.push_str(r);
            sep = "&";
        }
        if let Some(l) = locale.as_deref().filter(|l| !l.is_empty()) {
            url.push_str(sep);
            url.push_str("locale=");
            url.push_str(l);
        }
        let win = WebviewWindowBuilder::new(&app, OVERLAY_LABEL, WebviewUrl::App(url.into()))
            .title("WoWSP Overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false) // start hidden; shown on first Tab press
            .inner_size(420.0, 320.0)
            .build()
            .map_err(|e| format!("create overlay window: {e}"))?;
        post_create_window_setup(&win);
    }
    start_overlay_tab_watch(app).await
}

/// Destroy the overlay window (when overlay mode ends) and stop the watcher.
/// Also stops the arena file watcher — it is owned by the overlay window's
/// store, and closing the webview skips Vue teardown.
#[tauri::command]
pub async fn destroy_overlay_window(app: AppHandle) -> Result<(), String> {
    stop_overlay_tab_watch().await?;
    let _ = super::arena_info::stop_arena_watcher().await;
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.close().map_err(|e| format!("close overlay: {e}"))?;
    }
    Ok(())
}

/// Show or hide the overlay window manually (debug / settings preview). The
/// Tab watcher is the authoritative visibility driver in normal operation.
/// NEVER focuses the overlay — focus must stay on the game while playing.
#[tauri::command]
pub async fn set_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return Err("overlay window not created — call create_overlay_window first".into());
    };
    if visible {
        show_no_activate(&win);
    } else {
        win.hide().map_err(|e| format!("hide overlay: {e}"))?;
    }
    Ok(())
}

/// Click-through + no-activate styling applied right after creation, so the
/// overlay can never eat a click or steal focus from the game.
#[cfg(target_os = "windows")]
fn post_create_window_setup(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_NOACTIVATE,
    };
    let _ = win.set_ignore_cursor_events(true);
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn post_create_window_setup(win: &tauri::WebviewWindow) {
    let _ = win.set_ignore_cursor_events(true);
}

/// Show the overlay without activating it (`SW_SHOWNOACTIVATE`) — tauri's
/// `show()` maps to `SW_SHOW`, which WOULD steal focus from the game.
#[cfg(target_os = "windows")]
fn show_no_activate(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindow};
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    } else {
        let _ = win.show();
    }
}

#[cfg(not(target_os = "windows"))]
fn show_no_activate(win: &tauri::WebviewWindow) {
    let _ = win.show();
}

// ─────────────────────────────────────────────────────────────────────────
// Tab watcher
// ─────────────────────────────────────────────────────────────────────────

/// Handle of the running Tab watcher thread (if any).
static TAB_WATCHER: Mutex<Option<TabWatcher>> = Mutex::new(None);

struct TabWatcher {
    stop: Arc<AtomicBool>,
    /// Detached thread handle — never joined (see `start_overlay_tab_watch`).
    #[allow(dead_code)]
    handle: std::thread::JoinHandle<()>,
}

/// Start the global Tab watcher (idempotent). It polls `GetAsyncKeyState`
/// (purely passive — no hook installed) and, while the game window is the
/// foreground window, anchors + shows the overlay on Tab down and hides it on
/// Tab up / focus loss.
#[tauri::command]
pub async fn start_overlay_tab_watch(app: AppHandle) -> Result<(), String> {
    let mut guard = TAB_WATCHER
        .lock()
        .map_err(|e| format!("watcher lock: {e}"))?;
    if guard
        .as_ref()
        .is_some_and(|w| !w.stop.load(Ordering::Relaxed))
    {
        return Ok(()); // already running
    }
    // Drop any stale watcher WITHOUT joining it: joining under the lock
    // deadlocks if the old thread is itself waiting on a main-thread window
    // dispatch. The stop flag makes it exit within one poll interval; the
    // detached handle is simply dropped.
    *guard = None;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = std::thread::Builder::new()
        .name("overlay-tab-watch".into())
        .spawn(move || watch_tab_loop(app, thread_stop))
        .map_err(|e| format!("spawn tab watcher: {e}"))?;
    *guard = Some(TabWatcher { stop, handle });
    tracing::info!("overlay tab watcher started");
    Ok(())
}

/// Stop the Tab watcher.
#[tauri::command]
pub async fn stop_overlay_tab_watch() -> Result<(), String> {
    let mut guard = TAB_WATCHER
        .lock()
        .map_err(|e| format!("watcher lock: {e}"))?;
    if let Some(w) = guard.take() {
        w.stop.store(true, Ordering::Relaxed);
        // Leave the thread to exit on its own next tick; joining here would
        // block the IPC thread for up to one poll interval otherwise.
    }
    tracing::info!("overlay tab watcher stopped");
    Ok(())
}

/// The watcher loop — see the module docs for the interaction contract.
#[cfg(target_os = "windows")]
fn watch_tab_loop(app: AppHandle, stop: Arc<AtomicBool>) {
    let mut tab_down_prev = false;
    let mut overlay_shown = false;
    let mut cached_anchor: Option<(Instant, OverlayAnchor)> = None;
    let mut cached_game: Option<(GameWindow, Instant)> = None;
    // When the last game-window SCAN ran — bounds find_game_window() even
    // when it keeps failing (each call takes a full Toolhelp process
    // snapshot; a failing lookup retried every poll tick would peg a core).
    let mut last_scan: Option<Instant> = None;
    // When the last capture ATTEMPT ran (success or failure) — bounds the
    // expensive BitBlt(CAPTUREBLT) + detector work even under frantic Tab
    // tapping or a focus-flicker loop while the key is held.
    let mut last_capture_attempt: Option<Instant> = None;

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // A panicked tick must not kill the thread: a dead watcher can no
        // longer observe the Tab release and the overlay would stay on
        // screen forever. The next tick re-syncs all state.
        let tick = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            watch_tab_tick(
                &app,
                &mut tab_down_prev,
                &mut overlay_shown,
                &mut cached_anchor,
                &mut cached_game,
                &mut last_scan,
                &mut last_capture_attempt,
            );
        }));
        if tick.is_err() {
            tracing::warn!("tab watcher tick panicked — continuing on the next tick");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    // Never leave the overlay behind when the watcher dies.
    if overlay_shown {
        hide_overlay(&app);
    }
}

/// One poll iteration of the Tab watcher (factored out so the loop can wrap
/// it in `catch_unwind`).
#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn watch_tab_tick(
    app: &AppHandle,
    tab_down_prev: &mut bool,
    overlay_shown: &mut bool,
    cached_anchor: &mut Option<(Instant, OverlayAnchor)>,
    cached_game: &mut Option<(GameWindow, Instant)>,
    last_scan: &mut Option<Instant>,
    last_capture_attempt: &mut Option<Instant>,
) {
    {
        // Resolve the game window: cached while valid, rescanned at most
        // once per HWND_REFRESH — including the not-found case.
        let game = match &*cached_game {
            Some((g, at)) if at.elapsed() < HWND_REFRESH && g.is_alive() => Some(*g),
            _ if last_scan.is_none_or(|t| t.elapsed() >= HWND_REFRESH) => {
                *last_scan = Some(Instant::now());
                let found = find_game_window();
                *cached_game = found.map(|g| (g, Instant::now()));
                found
            },
            _ => (*cached_game).filter(|(g, _)| g.is_alive()).map(|(g, _)| g),
        };

        let focused_on_game = game.is_some_and(|g| g.is_foreground());
        let tab_down = tab_key_down();

        if focused_on_game && tab_down {
            if !*tab_down_prev {
                // Fresh Tab press — anchor + show. First make sure the
                // battle state is current: one cheap stat/read of
                // tempArenaInfo.json keeps the overlay self-sufficient even
                // when the arena watcher hasn't fired yet or the replay
                // view is closed. This is what lets the overlay show on the
                // pre-battle spawn screen, where the game's own Tab table
                // is not rendered yet but the roster file already exists.
                if !super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS) {
                    let fresh = super::arena_info::refresh_battle_state();
                    tracing::debug!(fresh, "tab press: refreshed battle state");
                }
                let battle_known = super::arena_info::arena_seen_within(ARENA_FRESHNESS_SECS);
                if !battle_known {
                    tracing::info!(
                        "tab press ignored: no battle roster within the freshness window"
                    );
                }
                // Reuse a recent anchor first; otherwise a capture attempt
                // must pass BOTH gates:
                //   1. a battle roster was seen recently (arena freshness —
                //      Tab in port or long after a battle is a no-op);
                //   2. the last attempt is older than CAPTURE_MIN_INTERVAL
                //      (rate limit; the anchor cache lives exactly as long,
                //      so no press ever falls into a "neither" gap).
                let anchor = if !battle_known {
                    None
                } else {
                    match &*cached_anchor {
                        Some((at, a)) if at.elapsed() < CAPTURE_MIN_INTERVAL => Some(a.clone()),
                        _ => None,
                    }
                    .or_else(|| {
                        if !last_capture_attempt.is_none_or(|t| t.elapsed() >= CAPTURE_MIN_INTERVAL)
                        {
                            tracing::debug!("tab press: capture rate-limited, reusing anchor");
                            return None;
                        }
                        let g = game?;
                        *last_capture_attempt = Some(Instant::now());
                        let computed = compute_anchor(&g);
                        *cached_anchor = computed.as_ref().map(|a| (Instant::now(), a.clone()));
                        computed
                    })
                };
                if let Some(anchor) = anchor {
                    place_and_show(app, &anchor);
                    *overlay_shown = true;
                }
            }
        } else if *overlay_shown {
            hide_overlay(app);
            *overlay_shown = false;
        }

        *tab_down_prev = tab_down && focused_on_game;
    }
}

#[cfg(not(target_os = "windows"))]
fn watch_tab_loop(_app: AppHandle, _stop: Arc<AtomicBool>) {}

/// Physical state of the Tab key (true = down), regardless of focus.
#[cfg(target_os = "windows")]
fn tab_key_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_TAB};
    let state = unsafe { GetAsyncKeyState(VK_TAB.0 as i32) };
    (state as u16) & 0x8000 != 0
}

/// Place the overlay window over the game rect, push the anchor to the
/// webview, then show without activating.
///
/// The native placement is QUEUED onto the main thread instead of dispatched
/// blocking: `set_position`/`set_size` from this thread would wait on the
/// main thread while it chews through the WebView2 resize those very calls
/// trigger — and a watcher stuck there can no longer observe the Tab
/// release, leaving the overlay frozen on screen (seen in live testing).
/// Ordering is preserved by the main-thread queue, so a show queued before a
/// hide can never overtake it.
#[cfg(target_os = "windows")]
fn place_and_show(app: &AppHandle, anchor: &OverlayAnchor) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        tracing::warn!("overlay window missing — cannot show (was it destroyed?)");
        return;
    };
    if let Err(e) = app.emit(OVERLAY_ANCHOR_EVENT, anchor) {
        tracing::warn!(error = %e, "emit overlay-anchor failed");
    }
    let r = anchor.overlay_rect;
    let queued = app.run_on_main_thread(move || {
        let _ = win.set_position(tauri::PhysicalPosition::new(r.x, r.y));
        let _ = win.set_size(tauri::PhysicalSize::new(
            r.width.max(1) as u32,
            r.height.max(1) as u32,
        ));
        show_no_activate(&win);
    });
    if let Err(e) = queued {
        tracing::warn!(error = %e, "queue overlay show failed");
    }
    tracing::info!("overlay show queued (tab held)");
}

#[cfg(not(target_os = "windows"))]
fn place_and_show(_app: &AppHandle, _anchor: &OverlayAnchor) {}

fn hide_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        // Queued like `place_and_show` — see the note there: a blocking
        // window call on this thread must never be able to stall the loop.
        let queued = app.run_on_main_thread(move || {
            let _ = win.hide();
        });
        if let Err(e) = queued {
            tracing::warn!(error = %e, "queue overlay hide failed");
        }
        tracing::info!("overlay hide queued (tab released / focus lost)");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Capture + anchor computation
// ─────────────────────────────────────────────────────────────────────────

/// Capture the game window, run the detector, and return the anchor for the
/// chip layer. Falls back to a conservative centered table when detection
/// fails but a battle roster is known — stats must still be readable.
#[cfg(target_os = "windows")]
fn compute_anchor(game: &GameWindow) -> Option<OverlayAnchor> {
    let expected = super::arena_info::last_known_team_size();
    let Some((rgba, w, h)) = capture_game_rgba(&game.rect) else {
        tracing::warn!("game window capture returned no pixels");
        return None;
    };
    if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
        dump_capture(&rgba, w, h);
    }
    // Scene gate: the battle HUD (bottom-left HP bar + top scoreboard) only
    // renders inside the 3D scene. No HUD → not in battle → never show.
    let probe = overlay_detect::probe_battle_scene(&rgba, w, h);
    if !probe.detected() {
        tracing::info!(
            hp_bar = probe.hp_bar,
            icon_blobs = probe.icon_blobs,
            "tab press: battle HUD not found — not in a 3D scene, skipping"
        );
        return None;
    }
    let (roster_rel, rows, split, detected) =
        match overlay_detect::detect_roster(&rgba, w, h, expected) {
            Some(det) => (det.rect, det.row_centers, det.team_split, true),
            None => {
                tracing::info!(
                    expected_players = expected,
                    "team list not detected — using centered fallback table"
                );
                let (r, rows) = overlay_detect::fallback_roster(w as i32, h as i32, expected);
                (r, rows, 0.5, false)
            },
        };
    let (overlay, anchor) = overlay_detect::build_anchor(
        &rect_from_win32(game.rect),
        &roster_rel,
        rows,
        split,
        detected,
    );
    tracing::info!(
        detected,
        overlay = format!(
            "{}x{} at ({},{})",
            overlay.width, overlay.height, overlay.x, overlay.y
        ),
        rows = anchor.row_centers.len(),
        "anchor built"
    );
    Some(anchor)
}

/// Capture the game window region and return it as base64 PNG plus the
/// detected anchor. The image is only encoded when `WOWSP_DEBUG_CAPTURE` is
/// set — normal operation needs nothing but the anchor, and shipping a
/// full-screen PNG on every Tab press would be wasteful.
#[tauri::command]
pub async fn capture_game_window() -> Result<CaptureResult, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(game) = find_game_window() else {
            return Ok(CaptureResult {
                image_base64: String::new(),
                roster_rect: None,
                anchor: None,
            });
        };
        let expected = super::arena_info::last_known_team_size();
        let (anchor, png) = match capture_game_rgba(&game.rect) {
            Some((rgba, w, h)) => {
                let det = if overlay_detect::detect_battle_scene(&rgba, w, h) {
                    match overlay_detect::detect_roster(&rgba, w, h, expected) {
                        Some(d) => Some(
                            overlay_detect::build_anchor(
                                &rect_from_win32(game.rect),
                                &d.rect,
                                d.row_centers,
                                d.team_split,
                                true,
                            )
                            .1,
                        ),
                        None => {
                            let (r, rows) =
                                overlay_detect::fallback_roster(w as i32, h as i32, expected);
                            Some(
                                overlay_detect::build_anchor(
                                    &rect_from_win32(game.rect),
                                    &r,
                                    rows,
                                    0.5,
                                    false,
                                )
                                .1,
                            )
                        },
                    }
                } else {
                    None
                };
                let png = if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
                    encode_png(&rgba, w, h)
                } else {
                    Vec::new()
                };
                (det, png)
            },
            None => (None, Vec::new()),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Ok(CaptureResult {
            image_base64: b64,
            roster_rect: anchor.as_ref().map(|a| a.roster_rect),
            anchor,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(CaptureResult {
            image_base64: String::new(),
            roster_rect: None,
            anchor: None,
        })
    }
}

/// Encode an RGBA buffer as PNG bytes.
#[cfg(target_os = "windows")]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    use std::io::Cursor;
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec());
    let mut out = Cursor::new(Vec::new());
    if let Some(img) = img {
        let _ = image::DynamicImage::ImageRgba8(img).write_to(&mut out, image::ImageFormat::Png);
    }
    out.into_inner()
}

/// Save a debug capture to %APPDATA%/WoWSP for detector calibration.
#[cfg(target_os = "windows")]
fn dump_capture(rgba: &[u8], w: u32, h: u32) {
    let Some(dir) = dirs_next::data_dir() else {
        return;
    };
    let dir = dir.join("WoWSP");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("overlay-capture-{ts}.png"));
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec());
    if let Some(img) = img {
        if let Err(e) = img.save(&path) {
            tracing::warn!(error = %e, "dump debug capture failed");
        } else {
            tracing::info!(path = %path.display(), "debug capture dumped");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Win32: game window discovery + screen capture
// ─────────────────────────────────────────────────────────────────────────

/// The game's top-level window: handle + on-screen bounds (physical px,
/// already clamped to the window's monitor so the capture and the overlay
/// cover exactly the same region — multi-monitor / negative-origin safe).
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
struct GameWindow {
    hwnd: windows::Win32::Foundation::HWND,
    rect: windows::Win32::Foundation::RECT,
}

#[cfg(target_os = "windows")]
impl GameWindow {
    fn is_alive(&self) -> bool {
        !self.hwnd.0.is_null()
            && unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(self.hwnd)) }
                .as_bool()
    }

    fn is_foreground(&self) -> bool {
        (unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }) == self.hwnd
    }
}

/// `RECT` → shared `Rect` (physical px).
#[cfg(target_os = "windows")]
fn rect_from_win32(r: windows::Win32::Foundation::RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// Collect the game's main window: PID via the ToolHelp snapshot (reusing
/// `appdata::find_game_pid`), then the largest visible top-level window of
/// that process. Title-agnostic — Lesta/CN clients localize their titles.
#[cfg(target_os = "windows")]
fn find_game_window() -> Option<GameWindow> {
    use std::ffi::c_void;

    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::BOOL;

    let pid = super::appdata::find_game_pid()?;

    struct Ctx {
        pid: u32,
        best: Option<(HWND, i64)>,
    }
    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let ctx = &mut *(lparam.0 as *mut Ctx);
            let mut win_pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut win_pid));
            if win_pid == ctx.pid
                && IsWindowVisible(hwnd).as_bool()
                && GetWindowTextLengthW(hwnd) > 0
            {
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    let area = (rect.right as i64 - rect.left as i64)
                        * (rect.bottom as i64 - rect.top as i64);
                    if ctx.best.is_none_or(|(_, a)| area > a) {
                        ctx.best = Some((hwnd, area));
                    }
                }
            }
        }
        BOOL(1) // keep enumerating
    }

    let mut ctx = Ctx { pid, best: None };
    unsafe {
        let lparam = &mut ctx as *mut Ctx as *mut c_void;
        let _ = EnumWindows(Some(enum_cb), LPARAM(lparam as isize));
    }
    let (hwnd, _) = ctx.best?;
    let rect = window_bounds_clamped(hwnd)?;
    Some(GameWindow { hwnd, rect })
}

/// Window bounds in physical screen px: DWM extended frame bounds (visible
/// bounds, excludes the invisible resize border) with a `GetWindowRect`
/// fallback, intersected with the window's monitor — so the BitBlt source
/// rect and the overlay window rect always agree on multi-monitor setups
/// with negative origins.
#[cfg(target_os = "windows")]
fn window_bounds_clamped(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<windows::Win32::Foundation::RECT> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rect = RECT::default();
    unsafe {
        let mut dwm = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut dwm as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok()
            && dwm.right > dwm.left
            && dwm.bottom > dwm.top
        {
            rect = dwm;
        } else if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut mi).as_bool() {
            rect.left = rect.left.max(mi.rcMonitor.left);
            rect.top = rect.top.max(mi.rcMonitor.top);
            rect.right = rect.right.min(mi.rcMonitor.right);
            rect.bottom = rect.bottom.min(mi.rcMonitor.bottom);
        }
    }
    if rect.right > rect.left && rect.bottom > rect.top {
        Some(rect)
    } else {
        None
    }
}

/// GDI capture of a screen rect from the virtual-screen DC. Works for
/// borderless / windowed-fullscreen games on any monitor (negative origins
/// included); an exclusive-fullscreen swapchain may BitBlt black — the
/// detector then fails and the caller falls back.
#[cfg(target_os = "windows")]
fn capture_game_rgba(rect: &windows::Win32::Foundation::RECT) -> Option<(Vec<u8>, u32, u32)> {
    use windows::Win32::Graphics::Gdi::*;

    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);

    unsafe {
        let hdc_screen = GetDC(None);
        if hdc_screen.is_invalid() {
            return None;
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        if hdc_mem.is_invalid() {
            let _ = ReleaseDC(None, hdc_screen);
            return None;
        }
        let hbmp = CreateCompatibleBitmap(hdc_screen, width, height);
        if hbmp.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(None, hdc_screen);
            return None;
        }
        let old_bmp = SelectObject(hdc_mem, hbmp.into());

        // CAPTUREBLT pulls in layered windows too; without it regions covered
        // by other layered apps can come back black.
        let rop = ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0);
        let ok = BitBlt(
            hdc_mem,
            0,
            0,
            width,
            height,
            Some(hdc_screen),
            rect.left,
            rect.top,
            rop,
        )
        .is_ok();

        let mut out = None;
        if ok {
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // negative = top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [RGBQUAD::default()],
            };
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let got = GetDIBits(
                hdc_mem,
                hbmp,
                0,
                height as u32,
                Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
                &mut bi,
                DIB_RGB_COLORS,
            );
            if got != 0 {
                // BGRA → RGBA, opaque alpha.
                for chunk in pixels.chunks_exact_mut(4) {
                    chunk.swap(0, 2);
                    chunk[3] = 255;
                }
                out = Some((pixels, width as u32, height as u32));
            }
        }

        let _ = SelectObject(hdc_mem, old_bmp);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(None, hdc_screen);
        out
    }
}
