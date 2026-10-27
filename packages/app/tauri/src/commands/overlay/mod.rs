//! In-game overlay commands (milestones M6/M8).
//!
//! Overlay mode (Mode 2 in PLAN.md): a SEPARATE transparent, always-on-top,
//! click-through, decoration-less window sits on top of the game. It loads
//! the separate pre-rendered `overlay.html` page, bootstrapped by
//! `src/overlay/main.ts` as bare DOM (no router, no title bar, transparent
//! background).
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
//! the entire battle.
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
//!   game-window mode (size + style bits + client kind, [`GeometryKey`]) and
//!   cached; every later capture only re-verifies the cached header band
//!   ([`overlay_detect::verify_header_band`], band-area cost) and reuses
//!   the cached grid — a new battle shape on the same window is rebuilt
//!   from the band without a rescan. Three consecutive verify misses (a
//!   HUD-phase table move) retire the cache and re-arm a full detection.
//! - CALIBRATION STORE (`calibration.rs`): the geometry cache's persistent
//!   sibling. Each client install keeps its own file under the appdata
//!   root (`overlay-anchors/`), with PvP and PvE layouts in SEPARATE
//!   entries — and once [`calibration::STABLE_PRESSES_TO_CERTIFY`]
//!   consecutive Tab presses have verified the stored band (each press
//!   casts one vote), the entry is CERTIFIED: the watcher stops
//!   scheduling the periodic anchor revalidations (the sink probe's band
//!   gate keeps watching reactively, so a genuine table move still drops
//!   the cache and restarts the streak). Certification — and the entry
//!   itself — expire when the game window moves or is resized/re-styled,
//!   the client install or kind changes, or the hardware screen
//!   configuration (monitor layout / resolution / DPI fingerprint)
//!   changes; the store then re-detects and re-accumulates votes.
//! - SINK FAST-PATH: while the overlay is up, a light probe
//!   ([`overlay_detect::crop_row_name_strips`] — strip luma + occupancy
//!   fingerprints, no OCR) runs every [`SINK_CHECK_INTERVAL`] at the
//!   pinned geometry; an alive-flag flip immediately updates the pin,
//!   re-places the chips (they gray out and re-sort). The flip is
//!   direction-sensitive ([`sink_probe_confirm`]): a SINK applies at once,
//!   while a pure REVIVAL flip — usually one frame of glare/explosion
//!   pushing a sunk row's strip over the luma threshold — must survive two
//!   consecutive probes before the pin believes it. A confirmed sink ALSO
//!   emits [`SINK_ATTRIB_EVENT`]: the strip fingerprints are diffed across
//!   the transition ([`overlay_detect::sink_victims`]) to name WHO sank —
//!   the game re-sorts [alive by Tab key] ++ [sunk by Tab key], so each
//!   victim's binarized strip reappears dimmed in the sunk block — and the
//!   consumers (overlay page + live panel) keep their layouts exact
//!   instead of falling back to an un-flagged full order.
//! - PRESENTATION VERIFY (`diag.rs`): a transparent layered window whose
//!   content never reaches the screen is indistinguishable from "nothing
//!   happened" for the player while every app-side signal stays green
//!   (feedback 2026-10-23, Optimum11). On a cadenced subset of shows the
//!   watcher asks the page to paint a solid corner marker
//!   ([`OVERLAY_VERIFY_EVENT`]) and photographs the overlay rect's corner
//!   with a LAYERED-INCLUSIVE capture (`CAPTUREBLT`): marker found = the
//!   window's pixels really reach the screen; repeated misses broadcast a
//!   Failed verdict through [`OVERLAY_DIAG_EVENT`], carrying the page's own
//!   paint report plus the registry/DWM risk flags (MPO disabled,
//!   transparency effects off, HAGS off, DWM-cloaked, WebView2 runtime
//!   version) as advisory context for the fix checklist.
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
//! The MANUAL LOCATE flow (`start_manual_locate` → the main window's
//! cached-frame picker sub-window → `set_manual_roster_rect`) lets the
//! player anchor the chips by hand when auto detection keeps missing: the
//! main window's webui renders a full-cover picker layer over a CACHED game
//! frame (the detector's own last capture), the player drags a rectangle
//! over the team table, and the selection is stored as a [`ManualAnchor`].
//! While it stays valid (same battle stamp + same game-window rect) the
//! watcher uses it INSTEAD of running the detector — no capture, no OCR,
//! no pin, and the 5 s revalidation deliberately never touches it. A new
//! battle or a moved/resized game window silently expires it back to the
//! automatic flow; hiding the overlay does NOT.
//!
//! The overlay windows are created lazily by `create_overlay_window` (called
//! once when overlay mode starts, hidden) and destroyed by
//! `destroy_overlay_window` (when the game exits or overlay mode is turned
//! off). The main shell window keeps running underneath.
//!
//! THREE windows serve this ONE mode, all described by ONE registry
//! ([OVERLAY_WINDOWS], each entry an [OverlayWindowSpec]): the table window
//! (`overlay`, everything above), the AIM CARD (`aim-card`) — the
//! transparent window that hangs below the game window's center (the
//! crosshair) while a battle is on and Tab is up, showing the aimed
//! player's stats — and the CHAT PANEL (`chat-overlay`): the bottom-left
//! chat-translation panel shown on a Tab hold when its own switch is on.
//! Each window has its OWN switch in `overlay-config.toml` (`table` /
//! `aim_card` / `chat_panel`): the switches are independent — any being on
//! keeps the mode (windows + watcher) up, each suppressing only its own
//! window, and only all-off tears the mode down (the webui lifecycle's
//! decision). The card's data is the in-game probe's per-tick `aim` verdict
//! (telemetry.json, relayed to the page by the telemetry poller's
//! `wowsp://ingame-telemetry` event); the page resolves the name through the
//! same WG batch command the table page uses, so the surfaces share one
//! session cache. The watcher owns the native windows only (the per-tick
//! passes in `watch_tab_tick`, decided by the pure
//! [`watch::schedule_windows`] scheduler): the card is shown while the battle
//! is on and `aim_card` is on, hidden while Tab is held (the table owns the
//! screen then), placed at the game center + the configured hang
//! (overlay-config's `aim_card_hang_px`, default 60 logical px); the chat
//! panel is shown on a Tab hold while `chat_panel` is on, parked at the game
//! window's bottom-left (`placement::chat_rect`). What each page DRAWS is
//! its own data-driven decision — the native visibility and the content
//! never gate each other.
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
    CaptureResult, ManualLocateContext, ManualLocateGuides, OverlayAnchor, OverlayDiag,
    OverlayPaintKind, OverlayPresentation, OverlayState, OverlayStatus, Rect,
};

use super::{appdata, arena_info, overlay_config, overlay_detect, overlay_manual, tab_dump};

/// Label of the dedicated overlay window (distinct from "main").
const OVERLAY_LABEL: &str = "overlay";

/// Label of the aim-card window — the SECOND transparent overlay window
/// serving the one overlay mode: it hangs below the game window's center
/// (the crosshair) during battles and shows the aimed player's stats, fed
/// by the in-game probe's telemetry `aim` verdict. Created and destroyed
/// together with the table window ([`create_overlay_window`] /
/// [`destroy_overlay_window`]); the watcher drives its visibility and
/// placement.
const AIM_CARD_LABEL: &str = "aim-card";

/// The aim card's creation size (logical px) — one name/ship line plus the
/// metric chip line. Placement resizes the window to the DPI-scaled
/// physical rect on every game-window change anyway; this only sizes the
/// first paint.
const AIM_CARD_LOGICAL_SIZE: (f64, f64) = (380.0, 120.0);

/// Label of the THIRD transparent overlay window: the chat-translation
/// panel. Shown on a Tab hold while its `chat_panel` switch is on, parked at
/// the game window's bottom-left; the page's content is driven entirely by
/// the chat-translate pipeline's events (this module only owns the native
/// window). Listed in `capabilities/secondary.json` like its siblings.
const CHAT_LABEL: &str = "chat-overlay";

/// First-paint size (logical px) of the anchor-driven TABLE window. The
/// detector resizes the window to the table's physical rect on every show;
/// this only sizes the hidden pre-created window (and its WebView2 surface
/// before the first detection).
const TABLE_LOGICAL_SIZE: (f64, f64) = (420.0, 320.0);

/// The chat panel's logical size (DPI-scaled at placement): wide enough for
/// a chat line plus its translation, tall enough for a short stack of
/// lines. Placement resizes the window to the DPI-scaled physical rect on
/// every game-window change anyway; this only sizes the first paint.
const CHAT_LOGICAL_SIZE: (f64, f64) = (520.0, 240.0);

/// One transparent overlay window serving the overlay mode — the resource
/// registry's key. The mode has THREE top-level transparent windows; every
/// create/destroy/place/show/hide path is keyed off this kind so a new
/// window is registered once instead of being special-cased across the
/// watcher, window management and teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OverlayWindowKind {
    /// The hold-Tab stat table (ANCHOR-placed: sized and positioned by the
    /// detected team table, not by a fixed logical size).
    Table,
    /// The aimed-player stats card (spec-placed below the crosshair).
    AimCard,
    /// The chat-translation panel (spec-placed at the game window's
    /// bottom-left; shown on a Tab hold).
    Chat,
}

/// One entry of [OVERLAY_WINDOWS]: the immutable facts every window manager
/// needs. Placement is NOT described here — each kind keeps its own rect
/// math (`placement::aim_card_rect` / `placement::chat_rect` / the detected
/// anchor) because the inputs differ (hang config, anchor); this spec only
/// owns identity, creation and the creation-time size.
#[derive(Debug, Clone, Copy)]
pub(crate) struct OverlayWindowSpec {
    pub(crate) kind: OverlayWindowKind,
    /// Tauri window label (also the `capabilities/secondary.json` entry —
    /// a label missing there loses its event permission).
    pub(crate) label: &'static str,
    /// OS title of the window (never visible — the windows are
    /// decorationless — but it is what desktop window enumeration reports).
    pub(crate) title: &'static str,
    /// App-relative page path the window loads.
    pub(crate) url_path: &'static str,
    /// The window's fixed logical size when [`Self::fixed_size`] is true.
    pub(crate) logical_size: Option<(f64, f64)>,
    /// True when the window is positioned at a spec-derived rect (a
    /// DPI-scaled logical size): the aim card and the chat panel. The table
    /// window is ANCHOR-sized instead — its creation size is only a first
    /// paint, and placement resizes it to the detected table rect.
    pub(crate) fixed_size: bool,
}

/// The overlay mode's complete window set, in creation/teardown order: the
/// table window first (the mode's primary window), then the two spec-placed
/// companions. Keep this list and `capabilities/secondary.json` in sync.
pub(crate) const OVERLAY_WINDOWS: &[OverlayWindowSpec] = &[
    OverlayWindowSpec {
        kind: OverlayWindowKind::Table,
        label: OVERLAY_LABEL,
        title: "WoWSP Overlay",
        url_path: "/overlay.html",
        logical_size: None,
        fixed_size: false,
    },
    OverlayWindowSpec {
        kind: OverlayWindowKind::AimCard,
        label: AIM_CARD_LABEL,
        title: "WoWSP Aim Card",
        url_path: "/aimcard.html",
        logical_size: Some(AIM_CARD_LOGICAL_SIZE),
        fixed_size: true,
    },
    OverlayWindowSpec {
        kind: OverlayWindowKind::Chat,
        label: CHAT_LABEL,
        title: "WoWSP Chat Panel",
        url_path: "/chat.html",
        logical_size: Some(CHAT_LOGICAL_SIZE),
        fixed_size: true,
    },
];

impl OverlayWindowKind {
    /// The registry entry for this kind (every kind is registered exactly
    /// once — see `OVERLAY_WINDOWS`).
    pub(crate) fn spec(self) -> &'static OverlayWindowSpec {
        OVERLAY_WINDOWS
            .iter()
            .find(|spec| spec.kind == self)
            .expect("every OverlayWindowKind has a registry entry")
    }
}

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

/// Tauri event telling the main window to force-close its manual-locate
/// picker layer (the game window vanished underneath it, or overlay mode
/// ended). Emitted only from `force_close_manual_locate`; the layer's own
/// submit/cancel paths close without this event.
pub const MANUAL_LOCATE_CLOSE_EVENT: &str = "wowsp://manual-locate-close";

/// Tauri event carrying one sink transition's ROW ATTRIBUTION to ALL
/// windows: for each side, the pre-sink alive-row indices whose players
/// just sank, solved by fingerprint-matching the Tab table's name strips
/// across the sink (see the sink fast-path in `reconcile.rs`). Emitted
/// BEFORE the updated anchor of the same pass, so a consumer can resolve
/// the indices against its pre-sink layout first and re-derive an exact
/// one when the anchor lands. An unsolved side carries an empty vec — the
/// consumer degrades that side (keeps its full order un-flagged) instead
/// of guessing.
pub const SINK_ATTRIB_EVENT: &str = "wowsp://sink-attrib";

/// Tauri event asking the overlay page to paint the one-shot PRESENTATION
/// VERIFY marker (see `diag.rs`): a solid magenta square pinned to the
/// window's corner, kept on screen briefly while the watcher photographs
/// the corner with a layered-inclusive capture. Payload is `true`; the
/// page removes the marker on its own timer and on any visibility drop.
pub const OVERLAY_VERIFY_EVENT: &str = "wowsp://overlay-verify";

/// Tauri event broadcasting the presentation-verify VERDICT (payload
/// [`OverlayDiag`]) to all windows — transition-only (the watcher mirrors
/// the last broadcast verdict). The main window's live-battle panel and
/// the overlay settings section badge the failed verdict and its risk
/// flags from it.
pub const OVERLAY_DIAG_EVENT: &str = "wowsp://overlay-diag";

/// Tauri event carrying translated battle-chat lines to the chat overlay
/// window. Emitted by the chat-translate pipeline as results land (never
/// fetched on the Tab path — the panel reveals a pre-rendered buffer); the
/// chat page is event-only like the other secondary windows.
///
/// This PR ships the CONTRACT, not the emitter: the chat-translate service
/// lands later, so no code path references these two constants yet. They
/// still live here (the overlay module owns the window family's event
/// vocabulary) and are `pub` for that emitter.
#[allow(dead_code)]
pub const CHAT_TRANSLATE_EVENT: &str = "wowsp://chat-translate";

/// Tauri event carrying the chat panel's display prefs (currently the
/// configured max line count), so a settings flip re-shapes the live panel
/// without a window reload. Same contract-only stance as
/// [`CHAT_TRANSLATE_EVENT`].
#[allow(dead_code)]
pub const CHAT_PREFS_EVENT: &str = "wowsp://chat-prefs";

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
/// this window and is refused a new capture until it elapses — so the
/// steady-state cadence caps at ~0.67 captures/s (the first moments of a
/// hold retry faster, see [`CAPTURE_YOUNG_RETRY_INTERVAL`]).
const CAPTURE_MIN_INTERVAL: Duration = Duration::from_millis(1500);
/// Acquisition retry interval while the current Tab hold is younger than
/// [`CAPTURE_MIN_INTERVAL`]. The first capture of a hold lands ~30 ms after
/// the press — before the game has faded the table in — so in the modes
/// with a visible fade (operations) it can only fail, and the full 1.5 s
/// cadence would then park the next attempt past the end of a short
/// glance: every press produced nothing. While the hold is young the
/// watcher retries on this shorter cadence — bounded to
/// `CAPTURE_MIN_INTERVAL / CAPTURE_YOUNG_RETRY_INTERVAL` extra captures per
/// hold, and a successful detection pins and leaves the arm entirely — so
/// the first success lands as soon as the table is actually up.
const CAPTURE_YOUNG_RETRY_INTERVAL: Duration = Duration::from_millis(400);
/// A frame enters the manual-locate cache only once Tab has been held this
/// long (see `capture_game_rgba_cached`): real captures taken right after
/// the press still show an un-dimmed, table-less scene (the game fades the
/// table in) — an old build stored exactly that pre-fade instant on every
/// short hold and the picker then offered a bright, table-less frame as
/// "the Tab-held moment". This gate is deliberately longer than the fade,
/// but it is only the CHEAP PRE-FILTER: the frame must also prove it shows
/// the team header before it is stored, because a stalled watcher tick can
/// hide a release and re-press inside one sample gap and re-open the
/// pre-fade window. Frames the detector PROVED carry the table bypass both
/// (see `compute_anchor`), and a hold that yields neither simply keeps the
/// previous frame.
const TAB_STORE_MIN_HOLD: Duration = Duration::from_millis(1200);
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
/// The SLOWED revalidation cadence for CERTIFIED geometry (overlay review
/// H-1): certification used to stand the periodic arm down entirely, so a
/// right-band/wrong-GRID cache (the band verify passes, the rows below it
/// sit elsewhere) misaligned chips for a whole battle with no self-heal.
/// Certified entries now re-detect once a minute instead of never — the
/// steady-state cost is one capture+detect per minute while Tab is held,
/// and a grid drift heals within that bound.
const CERTIFIED_REVALIDATE_INTERVAL: Duration = Duration::from_secs(60);
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
/// How often the hardware screen fingerprint is recomputed while a game
/// window is resolved (see `game_window::screen_fingerprint`): one monitor
/// enumeration per couple of seconds bounds the cost, while a
/// dock/undock/rescale retires every anchor-calibration entry within this
/// window.
const SCREEN_FINGERPRINT_REFRESH: Duration = Duration::from_secs(2);
/// How long after an armed show the presentation-verify capture waits (see
/// `diag.rs`): the page paints the corner marker synchronously in its event
/// loop, so the slack only needs to cover event delivery plus one present —
/// a half second also survives a first-press-racing-page-load.
const VERIFY_SETTLE: Duration = Duration::from_millis(500);

mod calibration;
mod capture;
mod diag;
mod game_window;
mod manual;
mod paste;
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
use calibration::CalibrationCtx;
pub use calibration::{
    __cmd__overlay_calibration_list, __cmd__set_calibration_anchor,
    __tauri_command_name_overlay_calibration_list, __tauri_command_name_set_calibration_anchor,
    overlay_calibration_list, set_calibration_anchor,
};
pub use capture::{
    __cmd__capture_game_window, __tauri_command_name_capture_game_window, capture_game_window,
};
use capture::{compute_anchor, encode_png};
pub use diag::{
    __cmd__get_overlay_diag, __cmd__report_overlay_paint, __tauri_command_name_get_overlay_diag,
    __tauri_command_name_report_overlay_paint, get_overlay_diag, report_overlay_paint,
};
use diag::{VerifyMachine, apply_verify_verdict, maybe_arm_verify, verify_marker_on_screen};
use game_window::{
    GameWindow, capture_game_rgba, capture_game_rgba_cached, capture_screen_rect, find_game_window,
    rect_from_win32, screen_fingerprint, window_dpi_scale,
};
pub use manual::{
    __cmd__cancel_manual_locate, __cmd__clear_manual_roster_rect, __cmd__manual_locate_context,
    __cmd__manual_locate_context_for, __cmd__manual_locate_gallery, __cmd__set_manual_roster_rect,
    __cmd__start_calibration_locate, __cmd__start_manual_locate,
    __tauri_command_name_cancel_manual_locate, __tauri_command_name_clear_manual_roster_rect,
    __tauri_command_name_manual_locate_context, __tauri_command_name_manual_locate_context_for,
    __tauri_command_name_manual_locate_gallery, __tauri_command_name_set_manual_roster_rect,
    __tauri_command_name_start_calibration_locate, __tauri_command_name_start_manual_locate,
    cancel_manual_locate, clear_manual_roster_rect, manual_locate_context,
    manual_locate_context_for, manual_locate_gallery, set_manual_roster_rect,
    start_calibration_locate, start_manual_locate,
};
use manual::{
    ManualAnchor, ManualAnchorCheck, build_manual_anchor, force_close_manual_locate,
    manual_anchor_check, manual_locate_open, rect_same_within, stored_manual_rows,
};
#[cfg(test)]
use manual::{manual_row_centers, validate_manual_selection};
#[cfg(target_os = "windows")]
use paste::{PasteEvent, PasteMonitor};
#[cfg(target_os = "windows")]
use placement::epoch_ms;
use placement::{
    hide_aim_card, hide_chat, hide_overlay, place_aim_card, place_and_show, place_chat,
    reassert_topmost, show_aim_card, show_async, show_chat, tab_held_for, tab_key_down,
};
use reconcile::{HeldStatus, held_status, pin_matches, revalidate_pinned_anchor, sink_check_pass};
#[cfg(test)]
use reconcile::{alive_changed, sink_probe_confirm};
#[cfg(test)]
use watch::apply_watch_command;
pub use watch::{
    __cmd__start_overlay_tab_watch, __cmd__stop_overlay_tab_watch,
    __tauri_command_name_start_overlay_tab_watch, __tauri_command_name_stop_overlay_tab_watch,
    start_overlay_tab_watch, stop_overlay_tab_watch,
};
use watch::{
    GeometryCacheEntry, GeometryKey, PinnedAnchor, StripBaseline, WatchFsm, report_status,
};
use watch_commands::WATCH_COMMANDS;
pub(super) use watch_commands::{WatchCommand, push_watch_command};
pub use window::{
    __cmd__create_overlay_window, __cmd__destroy_overlay_window, __cmd__set_overlay_visible,
    __tauri_command_name_create_overlay_window, __tauri_command_name_destroy_overlay_window,
    __tauri_command_name_set_overlay_visible, create_overlay_window, destroy_overlay_window,
    set_overlay_visible,
};
