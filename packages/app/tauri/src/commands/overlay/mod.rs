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
//! While the overlay STAYS shown, the pinned anchor is additionally
//! re-validated every [`ANCHOR_REVALIDATE_INTERVAL`] against a fresh
//! detection and replaced when the table moved at row scale — the in-battle
//! panel shifts as a whole when HUD phases change (countdown → combat), and
//! a battle-pinned anchor would otherwise keep the countdown position for
//! the entire battle. The same pass now also RECONCILES the row→name
//! recognition: while a pin's mapping is incomplete (no trusted mapping yet
//! — the arena roster file landed after the pin, or an all-`None` OCR read
//! matched nothing — or a partial match left some rows unnamed, which are
//! exactly the chips stuck on "…") it re-runs at the capture rate limit
//! ([`CAPTURE_MIN_INTERVAL`]) instead of
//! the full 5 s, and whenever a fresh detection disagrees with the pin's
//! mapping — first recognition landing late, or sunk ships re-sorting the
//! rows — only the mapping is transplanted onto the pin (geometry
//! untouched) and the anchor is re-emitted, so the chips re-render with
//! correct attribution without ever wandering. When the pin's geometry IS
//! replaced (the table moved at row scale), the replacement carries the OLD
//! pin's trusted row→name mapping on the fresh grid
//! ([`carry_mapping_into_fresh`]) — the roster is fixed for the battle, so
//! re-attributing the chips from scratch on every HUD-phase move would only
//! flash "recognizing roster…" for nothing.
//!
//! Three further mechanisms keep the chips honest without flicker:
//!
//! - SINGLE STATE OWNER: every cross-thread input (manual anchor set/clear,
//!   a fresh `tempArenaInfo.json` voiding the pin) enters a FIFO command
//!   queue ([`WatchCommand`]) that the watcher loop drains at the top of
//!   each tick. The loop's state machine ([`WatchFsm`]) is the only state
//!   owner and the only `overlay-status` emitter, so command ordering is
//!   deterministic and the last-status dedup mirror covers every emission.
//! - GEOMETRY CACHE: the table's pixel geometry is fully detected once per
//!   game-window mode (rect + style bits, [`GeometryKey`]) and cached;
//!   every later capture only re-verifies the cached header band
//!   ([`overlay_detect::verify_header_band`], band-area cost) and reuses
//!   the cached grid — a new battle shape on the same window is rebuilt
//!   from the band without a rescan. Three consecutive verify misses (a
//!   HUD-phase table move) retire the cache and re-arm a full detection.
//! - SINK FAST-PATH: while the overlay is up, a light probe
//!   ([`overlay_detect::read_row_alive`] — strip luma, no OCR) runs every
//!   [`SINK_CHECK_INTERVAL`] at the pinned geometry; an alive-flag flip
//!   immediately updates the pin, re-places the chips (they gray out and
//!   re-sort), re-emits the tab order and raises the wire's `stale` flag
//!   while the OCR re-map chases at the accelerated
//!   [`SINK_CATCHUP_INTERVAL`] cadence. The flip is direction-sensitive
//!   ([`sink_probe_confirm`]): a SINK applies at once, while a pure
//!   REVIVAL flip — usually one frame of glare/explosion pushing a sunk
//!   row's strip over the luma threshold — must survive two consecutive
//!   probes before the pin believes it.
//!
//! Every STATE CHANGE of this machine — idle (overlay hidden) ↔
//! searching/fallback (acquiring without a confirmed pin, the fallback
//! variant meaning the centered hint is what's on screen) ↔ detected
//! (chips anchored) ↔ manual (chips anchored to a user-drawn box) — is
//! additionally broadcast to ALL windows as
//! `wowsp://overlay-status` (payload [`OverlayStatus`]). The main window's
//! live-battle panel badges the detection state from it. Transitions only:
//! the watcher keeps a loop-local mirror of the last emitted status and
//! drops no-op reports, so the ~30 Hz poll can never flood the event pipe.
//! Within one (battle, game-window rect) a Detected state never degrades
//! back to Searching: the pin-reuse path reports Detected directly instead
//! of flashing "locating…" before every Tab press.
//!
//! The MANUAL LOCATE flow (`start_manual_locate` → the drag-box picker
//! window → `set_manual_roster_rect`) lets the player anchor the chips by
//! hand when auto detection keeps missing: a dedicated, INTERACTIVE
//! transparent window covers the game rect, the player drags a rectangle
//! over the team table, and the selection is stored as a [`ManualAnchor`].
//! While it stays valid (same battle stamp + same game-window rect) the
//! watcher uses it INSTEAD of running the detector — no capture, no OCR,
//! no pin, and the 5 s revalidation deliberately never touches it. A new
//! battle or a moved/resized game window silently expires it back to the
//! automatic flow; hiding the overlay does NOT.
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
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use wowsp_tauri_shared::{
    CaptureResult, ManualLocateContext, ManualLocateGuides, OverlayAnchor, OverlayState,
    OverlayStatus, Rect, TabRowOrder, TabRowPlayer,
};

use super::{
    appdata, arena_info, overlay_config, overlay_detect, overlay_manual, row_recognize, tab_dump,
};

/// Label of the dedicated overlay window (distinct from "main").
const OVERLAY_LABEL: &str = "overlay";

/// Label of the manual-locate picker window (screenshot-style drag box).
/// A SEPARATE window from [`OVERLAY_LABEL`]: it must RECEIVE mouse + keyboard
/// input (never click-through) while the overlay chips window must never.
const MANUAL_LOCATE_LABEL: &str = "manual-locate";

/// Minimum accepted size (physical px) of a manual roster selection, per
/// axis — anything smaller cannot carry a readable table row.
const MANUAL_MIN_SIZE: i32 = 32;

/// Tauri event carrying the latest anchor to the overlay webview.
pub const OVERLAY_ANCHOR_EVENT: &str = "wowsp://overlay-anchor";

/// Tauri event toggling the overlay page's OWN visibility (HTML-level hide).
/// Emitted straight from the watcher thread — no main-thread queue involved —
/// so the page content vanishes even when the native window hide below is
/// delayed by a busy main thread. This is the load-bearing hide; the native
/// one only stops the (already invisible) webview from painting.
pub const OVERLAY_VISIBILITY_EVENT: &str = "wowsp://overlay-visibility";

/// Tauri event carrying the DETECTION-STATE machine to all windows (main
/// window's live-battle panel badge). Transition-only — see `report_status`.
pub const OVERLAY_STATUS_EVENT: &str = "wowsp://overlay-status";

/// Tauri event carrying the in-game Tab panel's CURRENT row order (names in
/// on-screen order + per-row alive flags) to ALL windows. Emitted from
/// `place_and_show` whenever the placed anchor carries a TRUSTED row→name
/// mapping — the initial pin, a layout-move replacement, or a mapping
/// transplant after sunk ships re-sorted the rows. The main window's
/// live-battle panel reorders its roster columns from it, so the software's
/// list mirrors exactly what the player sees while holding Tab.
pub const TAB_ORDER_EVENT: &str = "wowsp://tab-order";

/// Watcher poll period — fast enough that ≤30 ms of Tab latency is
/// imperceptible, slow enough that two cheap Win32 calls are noise.
const POLL_INTERVAL: Duration = Duration::from_millis(30);
/// While the overlay is logically shown but Tab is up / the game lost the
/// foreground, the hide is RE-SENT at this period: a single edge-triggered
/// hide queues exactly one main-thread task, and when that task is delayed
/// or lost the overlay used to stay on screen forever (seen in live testing
/// — "hidden" logged, window still visible). Idempotent and cheap here.
const HIDE_RETRY: Duration = Duration::from_millis(300);
/// Battle-state refresh cadence while Tab is held but no battle is known —
/// bounds the replay-tree walk inside `refresh_battle_state`.
const STATE_REFRESH: Duration = Duration::from_secs(2);
/// Rate limit for capture attempts (GDI `BitBlt(CAPTUREBLT)` + detector
/// work is expensive): a fresh Tab press reuses the cached anchor inside
/// this window and is refused a new capture until it elapses — so frantic
/// tapping or a focus flicker while holding Tab caps at ~0.67 captures/s.
const CAPTURE_MIN_INTERVAL: Duration = Duration::from_millis(1500);
/// While the overlay is shown, the pinned anchor is re-validated at this
/// cadence: a full BitBlt + detection pass re-runs and replaces the pin only
/// when the table moved at row scale (`overlay_detect::
/// anchor_meaningfully_moved`). The pin's two keys (arena stamp + window
/// rect) cannot see the panel moving WITHIN one window: the in-battle Tab
/// panel shifts as a whole when HUD phases change — the countdown "waiting
/// players" layout sits ~190 px (≈ 3.7 row pitches at 3072x1920) above the
/// combat layout once the score bar / quick-commands HUD appears — so
/// without this check the chips stayed on the countdown position for the
/// entire battle. Revalidation IS a capture attempt in cost, so it is
/// throttled to the CAPTURE_MIN_INTERVAL order of magnitude; 5 s bounds the
/// chip misplacement to seconds while adding no work when the overlay is
/// hidden.
const ANCHOR_REVALIDATE_INTERVAL: Duration = Duration::from_secs(5);
/// A capture is only attempted while the most recent battle roster
/// (tempArenaInfo.json mtime) is younger than this — Tab in port or long
/// after a battle stays a no-op.
const ARENA_FRESHNESS_SECS: u64 = 30 * 60;
/// How often the cached game HWND is re-resolved.
const HWND_REFRESH: Duration = Duration::from_secs(2);
/// How often the arena watcher's target dir is re-checked against the
/// resolved replay dir (follows the running client on multi-install
/// machines). Same order as HWND_REFRESH — both take a Toolhelp snapshot.
const WATCH_DIR_REFRESH: Duration = Duration::from_secs(2);
/// While the overlay is shown with a confirmed pin, the SINK FAST-PATH runs
/// at this cadence: one capture + a per-row strip-luma read (no OCR, no
/// detection) at the pinned geometry. A ship sinking re-sorts the in-game
/// panel's rows within a second — far faster than the 5 s revalidation — so
/// the chips gray out and re-sort in step with the game.
const SINK_CHECK_INTERVAL: Duration = Duration::from_millis(500);
/// Recognition catch-up cadence while the pin is STALE (the sink probe just
/// flipped alive flags and the row→name mapping needs re-reading): a full
/// OCR pass runs every 500 ms instead of the usual [`CAPTURE_MIN_INTERVAL`]
/// so the re-map lands within a second or two of the sink. The stale flag
/// clears as soon as a trusted mapping produced by FRESH OCR lands — a move
/// replacement that merely CARRIES the old pin's mapping keeps the flag
/// (the carried order still describes the pre-sink rows).
const SINK_CATCHUP_INTERVAL: Duration = Duration::from_millis(500);
/// Consecutive header-band verify misses before the geometry cache is
/// retired and the next capture runs a full detection again. One miss is a
/// HUD-phase table move (or a transient scene change) — cheap ticks skip
/// the full scan and wait; three in a row mean the cached position is dead.
/// While a pin is shown the sink probe's 500 ms cadence normally
/// accumulates the misses in ~1 s; in the acquisition arm they accumulate
/// per rate-limited capture attempt instead.
const GEOMETRY_VERIFY_MAX_FAILS: u32 = 3;
/// How long an unconfirmed sink-probe REVIVAL candidate (see
/// [`sink_probe_confirm`]) stays confirmable: two agreeing probes at the
/// normal [`SINK_CHECK_INTERVAL`] cadence land ~500 ms apart; past this TTL
/// the candidate expires and the next flip starts a fresh two-probe count.
/// Generous enough to ride out a skipped probe, tight enough that a stale
/// reading can never confirm a much later flip.
const SINK_CANDIDATE_TTL: Duration = Duration::from_millis(1500);

mod capture;
mod game_window;
mod manual;
mod placement;
mod reconcile;
mod watch;
mod watch_commands;
mod window;

#[cfg(test)]
mod tests;

// Tauri command wrappers stay reachable at the original module path: the
// `generate_handler!` entries in `lib.rs` resolve both the command function
// and its doc(hidden) sibling macros (`__cmd__*` / `__tauri_command_name_*`)
// through `commands::overlay::*`, so those paths are re-exported verbatim.
pub use capture::{
    __cmd__capture_game_window, __tauri_command_name_capture_game_window, capture_game_window,
};
use capture::{compute_anchor, encode_png};
use game_window::{
    GameWindow, capture_game_rgba, capture_game_rgba_cached, find_game_window, rect_from_win32,
};
pub use manual::{
    __cmd__cancel_manual_locate, __cmd__clear_manual_roster_rect, __cmd__manual_locate_context,
    __cmd__set_manual_roster_rect, __cmd__start_manual_locate,
    __tauri_command_name_cancel_manual_locate, __tauri_command_name_clear_manual_roster_rect,
    __tauri_command_name_manual_locate_context, __tauri_command_name_set_manual_roster_rect,
    __tauri_command_name_start_manual_locate, cancel_manual_locate, clear_manual_roster_rect,
    manual_locate_context, set_manual_roster_rect, start_manual_locate,
};
use manual::{
    ManualAnchor, ManualAnchorCheck, build_manual_anchor, destroy_manual_locate_window,
    manual_anchor_check, rect_same_within, stored_manual_rows,
};
#[cfg(test)]
use manual::{manual_row_centers, validate_manual_selection};
use placement::{hide_overlay, place_and_show, reassert_topmost, show_async, tab_key_down};
use reconcile::{
    HeldStatus, held_status, mapping_untrusted, pin_matches, revalidate_pinned_anchor,
    should_catch_up_recognition, sink_check_pass, tab_order_from_anchor,
};
#[cfg(test)]
use reconcile::{
    MappingOrigin, alive_changed, carry_mapping_into_fresh, mapping_incomplete,
    should_transplant_rows, sink_probe_confirm, stale_after_mapping, transplant_row_players,
};
#[cfg(test)]
use watch::apply_watch_command;
pub use watch::{
    __cmd__start_overlay_tab_watch, __cmd__stop_overlay_tab_watch,
    __tauri_command_name_start_overlay_tab_watch, __tauri_command_name_stop_overlay_tab_watch,
    start_overlay_tab_watch, stop_overlay_tab_watch,
};
use watch::{GeometryCacheEntry, GeometryKey, PinnedAnchor, WatchFsm, report_status};
use watch_commands::WATCH_COMMANDS;
pub(super) use watch_commands::{WatchCommand, push_watch_command};
pub use window::{
    __cmd__create_overlay_window, __cmd__destroy_overlay_window, __cmd__overlay_ocr_available,
    __cmd__set_overlay_visible, __tauri_command_name_create_overlay_window,
    __tauri_command_name_destroy_overlay_window, __tauri_command_name_overlay_ocr_available,
    __tauri_command_name_set_overlay_visible, create_overlay_window, destroy_overlay_window,
    overlay_ocr_available, set_overlay_visible,
};
