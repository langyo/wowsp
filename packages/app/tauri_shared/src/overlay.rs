use serde::{Deserialize, Serialize};

/// Result of a Tab-triggered screen capture + roster-region detection in
/// overlay mode. The frontend uses `anchor` to place the per-row stat chips.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// PNG bytes of the captured game window, base64-encoded for IPC.
    /// Empty in normal operation — the anchor carries everything the frontend
    /// needs, and shipping a full-screen PNG per Tab press would be wasteful.
    /// Populated only by the debug capture path.
    pub image_base64: String,
    /// Detected team-list region in screen pixels, or `None` if not found.
    pub roster_rect: Option<Rect>,
    /// Full anchoring info (rows + team split); `None` when detection failed.
    #[serde(default)]
    pub anchor: Option<OverlayAnchor>,
}

/// Alignment guides the detector found on the manual-locate picker's cached
/// frame, in PHYSICAL px relative to the capture's origin (the game window's
/// top-left corner at capture time). The picker overlays them as snap
/// targets for the drag box. All fields default-empty: a frame the detector
/// could not read simply runs without guides.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualLocateGuides {
    /// The detected table rectangle (header bar top → last row bottom,
    /// green bar left → red bar right).
    #[serde(default)]
    pub table_rect: Option<Rect>,
    /// Vertical center of each detected row — horizontal guide lines.
    #[serde(default)]
    pub row_lines: Vec<i32>,
    /// The allies/enemies seam — a vertical guide line.
    #[serde(default)]
    pub seam_x: Option<i32>,
}

/// Context for the manual-locate picker layer in the MAIN window: the LAST
/// automatic capture (downscaled to ≤1280 px wide, PNG, base64) plus the
/// guides the detector found on it. When `image_base64` is `None` no usable
/// cached frame exists and the layer shows its "no cached frame" retry
/// state. Coordinates are PHYSICAL px relative to the capture origin; the
/// layer maps them through its own display scale, so the app window's DPI
/// never enters the math.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualLocateContext {
    /// Base64 PNG of the cached frame (no data-URL prefix).
    #[serde(default)]
    pub image_base64: Option<String>,
    /// PNG pixel size of `image_base64` (present iff the image is).
    #[serde(default)]
    pub image_width: Option<u32>,
    #[serde(default)]
    pub image_height: Option<u32>,
    /// Capture size in PHYSICAL px — the coordinate space of `guides` and
    /// the space the submitted selection maps back to. Zero when no image.
    #[serde(default)]
    pub phys_width: u32,
    #[serde(default)]
    pub phys_height: u32,
    /// Wall-clock capture time (unix ms) — the picker shows the age.
    #[serde(default)]
    pub captured_at_ms: Option<u64>,
    /// Game-window rect (physical screen px) the frame was captured from —
    /// diagnostics; the selection itself is window-relative.
    #[serde(default)]
    pub captured_game_rect: Option<Rect>,
    /// Pre-detected alignment guides on the cached frame.
    #[serde(default)]
    pub guides: ManualLocateGuides,
}

/// Which image the manual-locate picker (or the calibration editor behind
/// it) should anchor against. The default — no source — is the newest
/// automatic capture; a `frame` source resolves one of the gallery's cached
/// captures by its stamp; an `image` source is a user-supplied PNG
/// (pasted or picked from a file), base64 without a data-URL prefix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualLocateSource {
    /// `"frame"` or `"image"`; anything else resolves to the newest cache.
    #[serde(default)]
    pub kind: String,
    /// Gallery stamp of the `frame` source.
    #[serde(default)]
    pub at_ms: Option<u64>,
    /// Base64 PNG of the `image` source.
    #[serde(default)]
    pub image_base64: Option<String>,
}

/// One entry of the picker's image selector row: a recent automatic
/// capture's thumbnail (downscaled to ≤320 px wide) plus the metadata
/// needed to resolve it back to full pixels (see
/// [`ManualLocateSource::kind = "frame"`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualLocateGalleryFrame {
    /// Wall-clock capture time (unix ms) — the selector's label and the
    /// frame's identity.
    pub at_ms: u64,
    /// Base64 PNG thumbnail (no data-URL prefix).
    pub image_base64: String,
    /// Thumbnail pixel size.
    pub image_width: u32,
    pub image_height: u32,
    /// Capture size in PHYSICAL px — the coordinate space selections map
    /// back to.
    pub phys_width: u32,
    pub phys_height: u32,
    /// Game-window rect (physical screen px) the frame was captured from.
    pub game_rect: Rect,
}

/// One battle-class entry of the anchor calibration, as the settings
/// calibration list shows it. Coordinates are capture-relative (game-window
/// relative) physical px — the "key feature points" the detector anchored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationEntryInfo {
    /// `"pvp"` or `"pve"`.
    pub class: String,
    /// Game-window ORIGIN (physical screen px) the entry was measured at.
    pub game_origin: (i32, i32),
    /// Game-window SIZE (physical px).
    pub game_size: (i32, i32),
    /// Monitor-configuration fingerprint at measurement time.
    pub screen: String,
    /// Certified (stable across presses) — the watcher skips its periodic
    /// re-detection while this holds.
    pub certified: bool,
    /// Hand-drawn in the calibration editor (vs auto-measured).
    pub manual: bool,
    /// The stored band kept failing verification — kept only as the remap
    /// fallback's proportional prior.
    pub suspect: bool,
    /// Consecutive stable presses counted so far.
    pub stable_presses: u32,
    /// The table rectangle, game-window relative.
    pub roster_rect: Rect,
    /// Row centers, game-window relative.
    pub row_centers: Vec<i32>,
    /// Allies/enemies column split (1.0 = single-team PvE layout).
    pub team_split: f32,
    /// Team sizes the grid was built for.
    pub team_sizes: (u32, u32),
}

/// One client's calibration file as the settings list shows it: PvP and PvE
/// entries are independent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationClientInfo {
    /// Install-identity key (the install root path) — also the display
    /// name of the client.
    pub client_key: String,
    /// Client family (Wargaming / Steam / Lesta / …).
    pub kind: String,
    pub pvp: Option<CalibrationEntryInfo>,
    pub pve: Option<CalibrationEntryInfo>,
    /// File modification time (unix ms), when known.
    pub updated_at_ms: Option<u64>,
}

/// Everything the overlay window needs to align its stat chips with the
/// in-game team list, produced by the roster detector on each Tab press.
///
/// The overlay window is NOT the full game rect — it covers only the team
/// table area (inflated by padding), so all chip coordinates are PHYSICAL
/// pixels relative to the OVERLAY window's own top-left corner (which Rust
/// places at `overlayRect`). The frontend divides by `devicePixelRatio` to
/// get CSS pixels.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAnchor {
    /// Game-window rect in PHYSICAL screen coordinates (diagnostics only).
    pub game_rect: Rect,
    /// The overlay window's own rect in PHYSICAL screen coordinates — where
    /// Rust placed it (the table area of the game window, inflated).
    pub overlay_rect: Rect,
    /// Detected team-list rect, physical px relative to the OVERLAY window's
    /// top-left corner.
    pub roster_rect: Rect,
    /// Vertical center of each player row, physical px relative to the
    /// OVERLAY window's top-left corner, top to bottom. Header rows are
    /// trimmed and the count capped at the roster's team size (when the
    /// arena hint is known), so the frontend can map players by index.
    pub row_centers: Vec<i32>,
    /// Horizontal position of the allies/enemies column split as a fraction
    /// (0.0–1.0) of the roster rect width. Allies occupy [0, split), enemies
    /// [split, 1]. EXACTLY 1.0 marks the single-team PVE table (the green-only
    /// header — scenario / co-op / operations layouts): there IS no enemy
    /// column and the grid carries the ally rows only. The overlay page uses
    /// that 1.0 as the layout half of its "story" aux gate (no "bot" chips,
    /// no radar/hydro/smoke intel lines), with plain co-op battles excluded
    /// descriptor-side (`isCoopBattle`) — a co-op team's bot-fill labels and
    /// consumable spread stay meaningful. Two-bar tables clamp to
    /// [0.30, 0.70].
    pub team_split: f32,
    /// False when the anchor comes from the fallback geometry (battle HUD is
    /// up but the team table itself was not located): the page then renders
    /// a "table not located" hint box instead of stat chips.
    #[serde(default)]
    pub table_detected: bool,
    /// Per-row player names read off the on-screen table, matched against the
    /// arena roster (closed set). Same length and order as `row_centers`
    /// (allies block first, enemies after); element `k` names the player
    /// sitting in row `k`, or is `None` when that row's name was not
    /// recognized. The names are the roster's own nickname strings — exactly
    /// the keys the frontend's stats cache uses.
    ///
    /// Per-row ALIVE classification read off the name strips: the in-game
    /// Tab panel renders sunk players' rows in dim gray, so a strip whose
    /// brightest text pixel stays well under the alive rows' near-white
    /// glyphs marks that row sunk (`false`). Same length and order as
    /// `row_centers`; `true` = alive (also the default for rows whose strip
    /// could not be read — a missing strip must never read as "sunk").
    /// `None` when the luma read did not run (fallback anchors, the `off`
    /// roster mode).
    #[serde(default)]
    pub row_alive: Option<Vec<bool>>,
    /// Roster attribution mode in force when this anchor was emitted —
    /// `"inferred"` (the default) | `"off"`. `"inferred"` tells the overlay
    /// page to derive the row→name mapping ITSELF from the arena roster
    /// plus this anchor's `row_alive` (the client's own Tab sort key,
    /// recovered from the decompiled scripts — see the webui's
    /// utils/shipClass) with the sink-attribution tracker keeping it exact
    /// mid-battle. `"off"` is the historical index mapping.
    #[serde(default)]
    pub roster_mode: String,
}

/// An axis-aligned rectangle in screen pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Lifecycle of the in-game Tab-table detection, as observed by the overlay
/// Tab watcher. Broadcast on every STATE CHANGE to all windows via
/// `wowsp://overlay-status` so the main window's live-battle panel can badge
/// whether the overlay chips are currently anchored. Serde-lowercase to match
/// the event-payload string conventions of the other cross-window events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayState {
    /// Overlay hidden — no battle known, Tab up, or game unfocused.
    Idle,
    /// Battle known and acquisition running, but no confirmed table pin yet
    /// and the centered fallback hint is NOT on screen (nothing shown, or
    /// the scene gate / rate limit is holding the attempt back).
    Searching,
    /// A confirmed table detection is on screen — chips are anchored, and
    /// `OverlayStatus::rows` carries the row count.
    Detected,
    /// The centered "table not located" hint is on screen instead of chips.
    Fallback,
    /// The overlay sits at a user-drawn (manual-locate) position: chips are
    /// anchored to a box the player dragged over the game window. `rows`
    /// carries the row count, same as `Detected`.
    Manual,
}

/// Payload of the `wowsp://overlay-status` event, pushed by the overlay Tab
/// watcher whenever the detection state TRANSITIONS (never per tick — the
/// watcher dedups against a loop-local mirror).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatus {
    pub state: OverlayState,
    /// Number of anchored player rows while `state` is detected/manual
    /// (`None` in every other state).
    pub rows: Option<u32>,
    /// True while a user-picked (manually located) anchor is in force —
    /// the manual-locate flow's drag-box replaces the auto detector until
    /// the battle or the game-window geometry changes (or the user clears
    /// it). Every automatic state carries `false`.
    pub manual: bool,
}

/// What the overlay page last reported it painted — the page's own ground
/// truth, sent to the backend through the `report_overlay_paint` command
/// after every VISIBLE render and carried ADVISORILY on every diag
/// broadcast (the presentation verdict itself comes from the marker
/// channel alone; this report tells the human reading the diagnostics
/// what the page BELIEVED was on screen — feedback 2026-10-23,
/// Optimum11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlayPaintKind {
    /// The centered "locating / not located" hint card.
    Hint,
    /// Table detected but the roster data has not landed yet — the honest
    /// waiting card that replaced the old empty-body branch.
    WaitingRoster,
    /// Per-player stat chips (the payload's row count is the rendered chip
    /// count; `None` when the render produced no row chips at all).
    Chips,
}

/// Verdict of the overlay window's presentation verify pass (see the
/// watcher's `diag` module): whether the transparent layered window's
/// content actually reaches the screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPresentation {
    /// No verify completed yet (fresh session, or the screen configuration
    /// changed and re-armed it).
    #[default]
    Unverified,
    /// The verify marker was found in a layered-inclusive screen capture —
    /// the composition path works.
    Certified,
    /// Repeated verifies found nothing on screen — the composition path is
    /// broken on this system; the diag payload's risk flags carry the
    /// likely suspects.
    Failed,
}

/// Payload of the `wowsp://overlay-diag` event, pushed when the
/// presentation verdict TRANSITIONS (never per tick). The risk flags are
/// advisory context read at emit time — they attach to a CONFIRMED
/// verdict and are never standalone alarms (a disabled MPO alone does not
/// mean anything is broken on a given machine).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDiag {
    pub presentation: OverlayPresentation,
    /// The page's last reported paint (`None` before any report landed).
    pub paint: Option<OverlayPaintKind>,
    /// The row count that paint report carried (the rendered chip count
    /// while `paint` is chips; `None` otherwise / before any report).
    pub paint_rows: Option<u32>,
    /// Evergreen WebView2 runtime version (registry `pv`), `None` when no
    /// runtime is findable — the app ships none of its own
    /// (`webviewInstallMode: skip`), so a stripped OS image is a real
    /// risk exactly for the transparent-window mode.
    pub webview2_version: Option<String>,
    /// Multi-Plane Overlay disabled (`OverlayTestMode = 5`) — a common
    /// gaming tweak that reroutes DWM composition.
    pub mpo_disabled: bool,
    /// System "transparency effects" switched off.
    pub transparency_effects_off: bool,
    /// Hardware-accelerated GPU scheduling disabled (`HwSchMode = 1`).
    pub hags_off: bool,
    /// The overlay window reports as DWM-cloaked.
    pub cloaked: bool,
    /// The last roster-detection refusal's machine-readable reason
    /// (overlay review H-2): `None` while every detection succeeds. The
    /// label is stable (`"no_header_bars"` &c.) — the diagnostics page
    /// renders it verbatim alongside its age.
    pub detect_failure: Option<String>,
    /// Seconds since that refusal was recorded (`None` with the reason).
    pub detect_failure_age_sec: Option<u64>,
}

/// Payload of the `wowsp://sink-attrib` event: for ONE confirmed sink
/// transition, the rows whose players just left the alive block — solved by
/// fingerprint-matching the Tab table's name strips across the sink (the
/// game re-sorts [alive by Tab key] ++ [sunk by Tab key], so each victim's
/// strip reappears dimmed inside the sunk block; see the watcher's sink
/// fast-path). Indices are rows of the side's block in the PRE-sink alive
/// order — the consumer resolves them against its own layout (the decompiled
/// Tab sort key keeps that layout exact), then adds the named players to its
/// sunk set. An empty vec on a side means "no attribution for that side"
/// (unreadable strips / an unexplained rewrite): the consumer degrades
/// that side — it keeps the full order un-flagged — rather than guessing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkAttribution {
    /// Ally side (relation ≤ 1): pre-sink alive-row indices of the players
    /// that just sank.
    pub ally_rows: Vec<u32>,
    /// Enemy side (relation > 1): same, for the enemy block.
    pub enemy_rows: Vec<u32>,
}
