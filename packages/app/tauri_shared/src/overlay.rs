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
    /// [split, 1].
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

/// Payload of the `wowsp://sink-attrib` event: for ONE confirmed sink
/// transition, the rows whose players just left the alive block — solved by
/// fingerprint-matching the Tab table's name strips across the sink (the
/// game re-sorts [alive by Tab key] ++ [sunk by Tab key], so each victim's
/// strip reappears dimmed inside the sunk block; see the watcher's sink
/// fast-path). Indices are rows of the side's block in the PRE-sink alive
/// order — the consumer resolves them against its own layout (the decompiled
/// Tab sort key keeps that layout exact), then adds the named players to its
/// sunk set. An empty vec on a side means "no attribution for that side"
/// (unreadable strips / an unexplained rewrite): the consumer must degrade
/// that side to candidate ranges, never guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkAttribution {
    /// Ally side (relation ≤ 1): pre-sink alive-row indices of the players
    /// that just sank.
    pub ally_rows: Vec<u32>,
    /// Enemy side (relation > 1): same, for the enemy block.
    pub enemy_rows: Vec<u32>,
}
