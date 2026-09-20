//! Shared DTOs between the WoWSP Tauri shell (Rust) and the webui (TypeScript).
//!
//! Every struct here crosses the Tauri IPC boundary, so field naming uses
//! `#[serde(rename_all = "camelCase")]` to match TypeScript conventions and
//! the `@wowsp/shared_ui` barrel the frontend consumes. Keep this file the
//! single source of truth for the wire format — when a field changes here,
//! regenerate the TS bindings (planned: ts-rs) and update the webui types.

use serde::{Deserialize, Serialize};

/// How the game was found. The detection logic in `commands::game_detect`
/// scans the Windows Uninstall registry for Wargaming / Lesta / 360 publishers
/// (mirroring ApeRadar's `ConfigWindow.AutoDetectGamePath`) and additionally
/// walks Steam library folders for `appmanifest_552990.acf` — the Steam variant
/// ApeRadar does not cover.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameInstallKind {
    /// Official Wargaming Game Center install.
    Wargaming,
    /// Steam install (appid 552990).
    Steam,
    /// Lesta Games (post-split RU region, korabli.su).
    Lesta,
    /// 360.cn joint-venture CN region (current operator).
    Cn360,
    /// Legacy KongZhong (空中网) CN client — the pre-360 operator. Installers
    /// of that generation register their own publisher string in the Windows
    /// Uninstall registry, distinct from 360's `360.cn`.
    CnKongzhong,
    /// User-pinned manual path.
    Manual,
}

/// A detected (or manually set) World of Warships install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInstall {
    pub kind: GameInstallKind,
    /// Absolute path containing `WorldOfWarships.exe`.
    pub path: String,
    /// Realm parsed from `<path>/profile/clientrunner.log`, when available.
    pub realm: Option<String>,
}

/// Snapshot of the currently-running World of Warships process, with the
/// install (kind/realm) it belongs to resolved by matching the process's exe
/// path against the known installs.
///
/// `is_game_running` (the legacy boolean command) derives from `running`. This
/// richer view lets the sidebar show the PID + which client (Steam / Wargaming
/// / Lesta / 360) is running, mirroring how Starward reports the active game
/// process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProcessInfo {
    pub running: bool,
    /// OS process id of the matched `WorldOfWarships*.exe`, when running.
    pub pid: Option<u32>,
    /// The install kind of the matched install (Steam / Wargaming / ...).
    pub kind: Option<GameInstallKind>,
    /// Realm of the matched install, when known.
    pub realm: Option<String>,
    /// Full path to the running exe, when queryable.
    pub exe_path: Option<String>,
    /// The full install record the process was matched against, when any.
    pub matched_install: Option<GameInstall>,
}

/// Top-level metadata extracted from a `.wowsreplay` header.
///
/// A replay file is laid out as:
///   4 bytes  magic        = `{0x12, 0x32, 0x34, 0x11}`
///   4 bytes  block_count  = little-endian u32, number of data blocks
///   ...      blocks       = `block_count` × (4-byte length + payload)
///   ...      packets      = encrypted/zlib packet stream (Phase 2 decode)
///
/// The FIRST data block is the match-descriptor JSON. Subsequent blocks are
/// extra metadata (usually empty for live replays). Phase 1 reads only the
/// first JSON block; the packet stream decode is milestone M3 in PLAN.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMeta {
    pub path: String,
    /// e.g. `"pvp"`, `"ranked"`, `"clan"`, `"event"`.
    pub match_group: Option<String>,
    /// Parsed from the replay filename (the JSON descriptor has no timestamp),
    /// e.g. `"20250622_152405"`.
    pub date_time: Option<String>,
    /// Internal numeric map id (the client JSON sends `mapId` as a number).
    pub map_id: Option<i64>,
    /// Client display name, e.g. `"15_NE_north"`.
    pub map_name: Option<String>,
    /// Scenario name, e.g. "domination_3point" or "asymm_3point_coop".
    pub scenario: Option<String>,
    /// Battle-script id, e.g. "PCVE027" (EV27AsymCoop = asymmetric).
    pub event_type: Option<String>,
    /// Roster entries whose nickname is the client's bot style (`:Name:`).
    /// Factual count only — official co-op / asymmetric battles fill bots the
    /// same way, so deciding "custom room with bots" from it (pvp-family match
    /// group or tournament scenario) is the frontend classifier's job.
    #[serde(default)]
    pub bot_count: u32,
    /// Per-player roster.
    pub vehicles: Vec<VehicleEntry>,
    /// Raw JSON block preserved for the frontend to render arbitrary fields.
    pub raw: serde_json::Value,
}

/// One player slot in a replay roster. Field names follow the client JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleEntry {
    pub id: i64,
    pub name: String,
    /// `0`/`1` = ally (self + division); `2`+ = enemy. Numeric in the client.
    pub relation: i64,
    /// Client ship id (numeric, sent as JSON number).
    pub ship_id: i64,
    /// Pre-resolved ship display name (looked up from the ships DB), if known.
    pub ship_name: Option<String>,
}

/// Lightweight replay summary for the list view. `list_replays_meta` parses
/// only the descriptor-JSON block (no packet stream) of each file so a few
/// hundred replays can be listed fast. The full `ReplayMeta` (with roster +
/// raw JSON) is returned later by `read_replay_header` when one is opened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMetaLite {
    pub path: String,
    /// Parsed from the replay filename (`YYYYMMDD_HHMMSS`).
    pub date_time: Option<String>,
    /// e.g. `"pvp"`, `"ranked"`, `"clan"`, `"event"`.
    pub match_group: Option<String>,
    /// Client display name, e.g. `"15_NE_north"`.
    pub map_name: Option<String>,
    /// Numeric map id (the client JSON sends `mapId` as a number).
    pub map_id: Option<i64>,
    /// Scenario name, e.g. "domination_3point" or "asymm_3point_coop".
    pub scenario: Option<String>,
    /// Battle-script id, e.g. "PCVE027" (EV27AsymCoop = asymmetric).
    pub event_type: Option<String>,
    /// Roster entries whose nickname is the client's bot style (`:Name:`) —
    /// see [`ReplayMeta::bot_count`].
    #[serde(default)]
    pub bot_count: u32,
    /// The recording player's ship id — the roster entry with `relation == 0`.
    /// Used to render the per-replay holographic ship preview.
    pub own_ship_id: Option<i64>,
    /// The recording player's ship display name, when resolvable.
    pub own_ship_name: Option<String>,
    /// Number of players in the roster.
    pub player_count: usize,
}

/// Snapshot of the live `tempArenaInfo.json` the game writes when a battle
/// loads. Same shape as `ReplayMeta::vehicles`, but streamed live in overlay
/// mode rather than read from a saved replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaInfo {
    pub match_group: Option<String>,
    pub date_time: Option<String>,
    /// Client display name of the map, e.g. "spaces/40_Okinawa".
    pub map_name: Option<String>,
    /// Scenario name, e.g. "domination_tournament_3point" (the tournament
    /// variants are the custom-room fingerprints) — mirrors `ReplayMeta`.
    #[serde(default)]
    pub scenario: Option<String>,
    /// Roster entries with the client's `:Name:` bot nickname style — see
    /// [`ReplayMeta::bot_count`].
    #[serde(default)]
    pub bot_count: u32,
    pub vehicles: Vec<VehicleEntry>,
    pub raw: serde_json::Value,
}

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
    /// Semantics:
    ///   - `None` — recognition unavailable (recognizer disabled or the
    ///     pipeline bailed): the frontend falls back to mapping rows onto
    ///     roster entries by index (the historical behavior);
    ///   - `Some(vec)` — recognition ran. A `None` element marks a row that
    ///     was not recognized/matched: the frontend renders a silent
    ///     placeholder and must NOT fall back to the index guess (the
    ///     in-game panel sorts rows its own way, which is what the matcher
    ///     exists to fix). When EVERY row fails to match, the vec is
    ///     deliberately all `None` — the whole overlay goes silent instead
    ///     of showing index-guessed stats (honest silence over confidently
    ///     wrong data). Such an all-`None` vec is NOT a trusted mapping:
    ///     instead of a confidence gate downgrading it back to `None`, the
    ///     anchor reports `row_players_pending` (below) and the Tab watcher
    ///     keeps re-running recognition until something actually matches.
    #[serde(default)]
    pub row_players: Option<Vec<Option<String>>>,
    /// Per-row ALIVE classification read off the same name strips the
    /// recognizer crops: the in-game Tab panel renders sunk players' rows in
    /// dim gray, so a strip whose brightest text pixel stays well under the
    /// alive rows' near-white glyphs marks that row sunk (`false`). Same
    /// length and order as `row_centers`; `true` = alive (also the default
    /// for rows whose strip could not be read — a missing strip must never
    /// read as "sunk"). `None` when recognition did not run (same gating as
    /// `row_players`).
    #[serde(default)]
    pub row_alive: Option<Vec<bool>>,
    /// True when recognition is ENABLED but this anchor carries no trusted
    /// row→name mapping yet: `row_players` is `None` (the arena roster was
    /// not ready when the table was pinned, or OCR read nothing) OR an
    /// all-`None` vec (every row's text failed to match the roster). The
    /// overlay page shows its "recognizing roster" badge while this is up
    /// and keeps rendering the current chips; the Tab watcher keeps
    /// re-running recognition and transplants the mapping onto the pin when
    /// it arrives. Always `false` for manual anchors (recognition is never
    /// run on a hand-drawn box) and when recognition is off; on a fallback
    /// anchor (table not located) it is meaningless — recognition only runs
    /// on a confirmed detection — and the overlay only badges confirmed
    /// tables anyway.
    #[serde(default)]
    pub row_players_pending: bool,
    /// True when the rows' data JUST changed under the chips (a ship sank —
    /// the sink fast-probe flipped `row_alive`, grayed + re-sorted the
    /// chips) and the row→name re-mapping is still catching up at the
    /// accelerated OCR cadence: the current chips' row attribution may
    /// change again within seconds. Purely informational — consumers keep
    /// rendering the current chips. `#[serde(default)]` keeps older
    /// frontends deserializing the payload unchanged.
    #[serde(default)]
    pub stale: bool,
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
    /// Mirrors [`OverlayAnchor::stale`]: true while the anchored rows' data
    /// just changed (a ship sank) and the row→name re-mapping is catching
    /// up at the accelerated cadence — the main window can badge the panel
    /// "updating". Always `false` in every non-detected state.
    pub stale: bool,
}

/// One row of the in-game Tab panel, as recognized off the live frame:
/// the player sitting in that row (if the row→name matcher resolved it)
/// and whether their ship was still afloat at capture time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRowPlayer {
    /// Roster nickname of the player in this row; `None` when the row's text
    /// was not recognized/matched (the row exists, its occupant is unknown).
    pub name: Option<String>,
    /// False when the row's name strip read as dim gray (sunk ship).
    pub alive: bool,
}

/// Payload of the `wowsp://tab-order` event: the in-game Tab panel's CURRENT
/// row order per side, pushed whenever a recognition pass over a held Tab
/// frame produced a trusted mapping. The in-game panel orders each team as
/// [alive ships sorted by ship class] ++ [sunk ships sorted by ship class]
/// and RE-SORTS live as ships sink — an order tempArenaInfo.json never
/// carries — so this event is the only exact mirror of what the player sees
/// while holding Tab. `name: None` entries keep the row slot (unknown
/// occupant) so consumers can still count positions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRowOrder {
    /// `ArenaInfo::date_time` of the battle the order belongs to — the same
    /// battle identity the frontend's live roster carries, so consumers can
    /// match order to roster.
    pub date_time: Option<String>,
    /// Arena-file mtime stamp (battle identity on the Rust side).
    pub battle: i64,
    /// Ally rows (relation ≤ 1), top to bottom, as shown in-game.
    pub allies: Vec<TabRowPlayer>,
    /// Enemy rows (relation > 1), top to bottom, as shown in-game.
    pub enemies: Vec<TabRowPlayer>,
}

/// One position sample for one entity at one instant — the raw output of M3's
/// packet-stream decoder. WoWS maps are planar: x = east, z = north, y ≈ 0.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionSample {
    /// Seconds since match start.
    pub time: f32,
    /// BigWorld entity id (map to a player via ReplayMeta.vehicles shipId/id).
    pub entity_id: i32,
    pub vehicle_id: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Heading (radians) about the vertical axis.
    pub yaw: f32,
}

/// A per-entity trajectory: the full position timeline for one ship, ready for
/// the holographic map to scrub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityTrajectory {
    pub entity_id: i32,
    /// Metadata from the EntityCreate (0x05) packet: type, vehicleId, initial
    /// position. `None` when the replay never created the entity (rare).
    pub kind: Option<EntityKind>,
    pub samples: Vec<PositionSample>,
    /// Match time (seconds) at which the entity was destroyed (EntityDestroy
    /// 0x06), if it was. `None` = survived the whole match. The frontend freezes
    /// the marker here and tints it grey.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death_time: Option<f32>,
    /// HP timeline from EntityProperty (0x07) packets. Pairs of (time, hp_value).
    /// Empty when the replay contains no HP data for this entity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hp_samples: Vec<HpSample>,
    /// Capture zone property 0 samples (0=neutral, 1=captured by team A, etc.)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cap_samples: Vec<HpSample>,
    /// Capture-zone progress stream from NestedPropertyUpdate (0x23) packets:
    /// 0..1 fraction of the current capture, reset to 0 on ownership change.
    /// This is the game's own progress — much more accurate than simulating
    /// it from ship positions. Only present for capture zones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cap_progress: Vec<HpSample>,
}

/// A single HP snapshot from the replay's property stream.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HpSample {
    pub time: f32,
    pub value: u32,
}

/// An explosion impact observed by the recorder's avatar (`receiveExplosions`,
/// method id version-dependent — see the decoder's method tables). Carries the
/// world-space impact point for shell splash FX; the flight paths themselves
/// come from [`ShellLaunchEvent`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplosionEvent {
    pub time: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// GameParams id of the shell that caused the impact — resolves to the
    /// shell type (HE/AP/SAP) for per-type colors and trails on the frontend.
    pub params_id: u32,
}

/// One artillery shell in flight (`receiveArtilleryShots` on the avatar): the
/// launch position, the server-computed target point, and the remaining flight
/// time — everything needed to draw a true ballistic arc per shell without
/// guessing the shooter from impact points.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellLaunchEvent {
    pub time: f32,
    /// Firing vehicle entity id (joins EntityTrajectory.entityId).
    pub owner_id: i32,
    /// GameParams id of the shell (HE/AP/SAP colour resolution).
    pub params_id: u32,
    /// Salvo id shared by shells fired in one click.
    pub salvo_id: i32,
    /// Per-barrel shot id within the salvo (unique per owner).
    pub shot_id: u16,
    /// Muzzle position (world space).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Server-side aim point (world space) — where this shell will land.
    pub target_x: f32,
    pub target_y: f32,
    pub target_z: f32,
    /// Seconds until impact in the server's time units — divide by 2.75 for
    /// battle seconds (the minimap_renderer reference's calibrated constant:
    /// flight ticks = serverTimeLeft / 2.75).
    pub server_time_left: f32,
    /// Muzzle velocity (m/s).
    pub speed: f32,
    /// Firing barrel index (main vs secondary battery hints).
    pub gun_barrel_id: u16,
}

/// A torpedo launch (`receiveTorpedoes` on the avatar): each fish carries its
/// own spawn point, direction and shot id, so spreads fan out correctly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorpedoLaunch {
    pub time: f32,
    /// Firing vehicle entity id (joins EntityTrajectory.entityId).
    pub owner_id: i32,
    /// GameParams id of the torpedo.
    pub params_id: u32,
    /// Salvo id shared by torpedoes launched together.
    pub salvo_id: i32,
    /// Shot id within the salvo — (owner, shot) uniquely identifies the fish.
    pub shot_id: u16,
    /// Spawn position (world space).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Launch direction (world space, not normalized — magnitude carries the
    /// server's speed coefficient).
    pub dir_x: f32,
    pub dir_y: f32,
    pub dir_z: f32,
    /// Whether the torpedo left the launcher armed.
    pub armed: bool,
}

/// A guidance update for a homing torpedo (`receiveTorpedoDirection`): the
/// current position and target heading of an already-launched acoustic
/// torpedo, letting the viewer bend its track instead of drawing a straight
/// line from the launch point.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorpedoSteer {
    pub time: f32,
    /// Firing vehicle entity id (matches TorpedoLaunch.ownerId).
    pub owner_id: i32,
    /// Shot id (matches TorpedoLaunch.shotId).
    pub shot_id: u16,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Heading the torpedo is turning towards (radians).
    pub target_yaw: f32,
}

/// An aircraft-squadron marker appearing on the minimap
/// (`receive_addMinimapSquadron` on the avatar). The composite plane id packs
/// the owning carrier in its low 32 bits.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapSquadronAdd {
    pub time: f32,
    /// Composite squadron id (low 32 bits: owner vehicle id).
    pub plane_id: u64,
    /// Owning carrier vehicle entity id (joins EntityTrajectory.entityId).
    pub owner_id: i32,
    /// Team id as broadcast (-1 neutral, 0/1 teams).
    pub team_id: i8,
    /// GameParams id of the aircraft type.
    pub params_id: u32,
    /// Squadron position (world space; y = minimap VECTOR2 second component).
    pub x: f32,
    pub z: f32,
}

/// A squadron marker move (`receive_updateMinimapSquadron`): the new squadron
/// position in the same world-space terms as [`MinimapSquadronAdd`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapSquadronMove {
    pub time: f32,
    pub plane_id: u64,
    pub x: f32,
    pub z: f32,
}

/// A squadron marker disappearing (`receive_removeMinimapSquadron`) — landed,
/// shot down, or recalled.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapSquadronRemove {
    pub time: f32,
    pub plane_id: u64,
}

/// A fighter-patrol ward appearing (`receive_wardAdded`): the patrol circle
/// aircraft hold while orbiting. The arg layout gained a trailing `wardType`
/// byte in 13.2.0 — the decoder fills `0` (unknown) on older replays.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WardEvent {
    pub time: f32,
    /// Patrol id (same composite plane-id space as squadron markers).
    pub squadron_id: u64,
    /// Owning carrier vehicle id (joins EntityTrajectory.entityId).
    pub owner_id: i64,
    /// Team id as broadcast (-1 neutral, 0/1 teams).
    pub team_id: i8,
    /// Patrol centre (world space).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Patrol radius in world metres — scene units match world metres.
    pub radius: f32,
    /// Ward kind (13.2.0+); 0 = unknown on older replays.
    pub ward_type: u8,
}

/// A patrol ward disappearing (`receive_wardRemoved`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WardRemoveEvent {
    pub time: f32,
    pub plane_id: u64,
}

/// One projectile kill (`receiveShotKills`): the terminal position of a shell
/// or torpedo that destroyed something. Joins [`ShellLaunchEvent`] /
/// [`TorpedoLaunch`] by (ownerId, shotId) to snap arcs onto the victim and
/// stop in-flight torpedoes at the hit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotKillEvent {
    pub time: f32,
    /// Firing vehicle entity id.
    pub owner_id: i32,
    /// Hit type from the pack (penetration/overpen/... — raw id).
    pub hit_type: u8,
    pub shot_id: u16,
    /// Terminal (impact) position in world space.
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// One cumulative damage-stat tick (`receiveDamageStat` on the recorder's
/// avatar): the server's running total for a single (weapon, category) pair
/// at a battle timestamp. Values are CUMULATIVE and REPLACE the previous
/// entry for the same pair — fold by keeping the latest sample per pair
/// (at or before a given time), never by summing across samples. Only
/// category 0 (enemy) rows count as damage dealt.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageStatSample {
    pub time: f32,
    /// Weapon id (DamageStatWeapon): 1/2 main-gun AP/HE, 7 ship torpedo,
    /// 11/12/28/41-43 aircraft bombs/torps/rockets, 17 burn, 20 flood, ...
    pub weapon: i64,
    /// 0 = enemy (damage dealt), 1 = ally, 2 = spotting, 3 = agro.
    pub category: i64,
    /// Cumulative hit count for the pair.
    pub count: i64,
    /// Cumulative damage total for the pair.
    pub total: f64,
}

/// A weapon-lock state change (`SetWeaponLock`, 0x30): the recorder's own
/// vehicle locking/unlocking a target entity. The lock timeline lets the
/// frontend draw an aim line to the locked ship and prefer it when
/// reconstructing shell flights.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponLockEvent {
    pub time: f32,
    pub weapon_type: u32,
    pub lock_type: u32,
    /// Target entity id (0 when lock_type is not Target).
    pub target_id: i32,
}

/// One camera-state sample (Camera, 0x25): the recorder's own camera pose
/// every tick, usable to replay the original spectating view.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSample {
    pub time: f32,
    pub rot_x: f32,
    pub rot_y: f32,
    pub rot_z: f32,
    pub rot_w: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Field of view in radians.
    pub fov: f32,
}

/// One player network-stat sample (PlayerNetStats, 0x1d).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatsSample {
    pub time: f32,
    pub fps: u8,
    pub ping: u16,
    pub is_lagging: bool,
}

/// An aircraft-squadron creation (`receive_addSquadron` on the avatar): the
/// squadron's game-params id and its spawn position. Method id resolves via
/// the decoder's per-version tables.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronCreate {
    pub time: f32,
    /// Composite plane id (high bits: spawn index, low bits: owner entity).
    pub plane_id: u64,
    /// GameParams id of the aircraft type.
    pub params_id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// One aircraft position sample (`receive_updateSquadron` on the avatar): a
/// per-plane waypoint of the squadron's 3D aerial path. Method id resolves via
/// the decoder's per-version tables.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronPlane {
    pub time: f32,
    pub plane_id: u64,
    /// Position within the squadron formation (0..squadron size) — one
    /// sample per aircraft per update, so `(plane_id, index)` uniquely
    /// identifies a single plane. The frontend renders one model per index.
    pub index: u8,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
}

/// One battle-chat message (`onChatMessage` on the avatar): the server
/// broadcasts every player's chat through the recorder's avatar entity, so the
/// stream carries the whole match's chat timeline. `player_id` joins the
/// descriptor's `vehicles` roster (`vehicle.id` — account DB ids), NOT the
/// vehicle entity ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub time: f32,
    /// Sender's roster player id (descriptor `vehicles[].id`).
    pub player_id: i32,
    /// Channel namespace, e.g. `battle_team` (team chat), `battle_all`….
    pub namespace: String,
    /// Plaintext message body (UTF-8).
    pub message: String,
}

/// One in-battle achievement award (`onAchievementEarned` on the avatar): a
/// player earned a medal/achievement during the match. `achievement_id` is
/// the GameParams Achievement entry id (matches the `playersPublicInfo`
/// achievement list in the battle results; joins the bundled
/// `achievement_names.json` for display names).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementEvent {
    pub time: f32,
    /// Earner's roster player id (descriptor `vehicles[].id`).
    pub player_id: i32,
    /// GameParams Achievement entry id.
    pub achievement_id: u32,
}

/// Everything the holographic replay viewer needs from the packet stream:
/// entity trajectories plus battle-effect events (explosions, torpedo
/// launches) that are broadcast as entity methods rather than entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStream {
    pub trajectories: Vec<EntityTrajectory>,
    /// Artillery launches (`receiveArtilleryShots`) — the primary shell data:
    /// muzzle point, aim point and flight time per projectile.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shell_launches: Vec<ShellLaunchEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub explosions: Vec<ExplosionEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub torpedoes: Vec<TorpedoLaunch>,
    /// Homing-torpedo guidance updates (`receiveTorpedoDirection`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub torpedo_steers: Vec<TorpedoSteer>,
    /// Recorder weapon-lock timeline (SetWeaponLock, 0x30).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weapon_locks: Vec<WeaponLockEvent>,
    /// Raw battle-results payload (BattleResults, 0x22) — the server's post-
    /// battle statistics JSON when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battle_results: Option<String>,
    /// Replay protocol version string (Version, 0x16).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Map name from the Map packet (0x28) when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_name: Option<String>,
    /// Recorder camera timeline (Camera, 0x25) — one pose per tick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub camera: Vec<CameraSample>,
    /// Player network stats (PlayerNetStats, 0x1d) — fps/ping per tick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub net_stats: Vec<NetStatsSample>,
    /// Entity id → last time it left the observed area (EntityLeave, 0x04).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub leaves: std::collections::BTreeMap<i32, f32>,
    /// Camera-mode changes (0x27) — spectating view modes over time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub camera_modes: Vec<HpSample>,
    /// Counts of the remaining decoded system packets (diagnostics).
    #[serde(default, skip_serializing_if = "DiagnosticCounts::is_default")]
    pub diagnostics: DiagnosticCounts,
    /// Aircraft squadrons: spawn events + per-plane position streams from
    /// the avatar's receive_addSquadron / receive_updateSquadron methods.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub squadron_creates: Vec<SquadronCreate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub squadron_planes: Vec<SquadronPlane>,
    /// Minimap squadron markers (receive_add/update/removeMinimapSquadron) —
    /// the 2D trail source the in-game minimap itself uses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub minimap_squadron_adds: Vec<MinimapSquadronAdd>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub minimap_squadron_moves: Vec<MinimapSquadronMove>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub minimap_squadron_removes: Vec<MinimapSquadronRemove>,
    /// Fighter-patrol wards (receive_wardAdded / receive_wardRemoved).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wards: Vec<WardEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ward_removes: Vec<WardRemoveEvent>,
    /// Projectile kills (receiveShotKills) — terminal impact points.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shot_kills: Vec<ShotKillEvent>,
    /// Server-authoritative cumulative damage stats (receiveDamageStat) for
    /// the recorder — exact per-weapon damage (incl. aircraft weapons),
    /// emitted every few seconds during engagements.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub damage_stats: Vec<DamageStatSample>,
    /// Battle chat timeline (avatar onChatMessage) — every player's messages
    /// with match timestamps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chat_messages: Vec<ChatEvent>,
    /// In-battle achievement awards (avatar onAchievementEarned).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub achievements: Vec<AchievementEvent>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCounts {
    pub server_ticks: u32,
    pub server_timestamps: u32,
    pub init_flags: u32,
    pub init_markers: u32,
    pub base_player_creates: u32,
    pub create_stubs: u32,
    pub entity_controls: u32,
    pub entity_enters: u32,
    pub camera_modes: u32,
    pub camera_freelooks: u32,
    pub sub_controllers: u32,
    pub cruise_states: u32,
    pub shot_trackings: u32,
    pub gun_markers: u32,
}

impl DiagnosticCounts {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// Player's dog tag (personalized emblem). Fetched from the WG Vortex API.
/// Colors are ARGB-packed u32 values; texture/symbol/background IDs are
/// entity refs to pattern assets on WG's CDN.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DogTag {
    pub texture_id: u32,
    pub symbol_id: u32,
    /// ARGB-packed border color.
    pub border_color: u32,
    /// ARGB-packed background color.
    pub background_color: u32,
    pub background_id: u32,
}

/// Player stats from the Wargaming public API (milestone M9). All fields are
/// optional because hidden profiles return nulls and some game modes are
/// absent for casual accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStats {
    pub account_id: i64,
    pub name: String,
    /// Realm the lookup hit: ru / eu / na / asia / cn.
    pub realm: String,
    pub battles: Option<i64>,
    /// Account-level overall winrate, percent (0–100).
    pub winrate: Option<f32>,
    /// Hidden profile (no detail stats available).
    pub hidden: bool,
    /// Clan tag, if any.
    pub clan_tag: Option<String>,
    /// Clan id the player belongs to, if any — the jump key from a player
    /// card to the clan view. `#[serde(default)]` keeps old cache files
    /// (written before this field existed) deserializable.
    #[serde(default)]
    pub clan_id: Option<i64>,

    // ── Deep stats (PvP) ────────────────────────────────────────────────
    /// Average damage per battle.
    pub avg_damage: Option<f32>,
    /// Average experience per battle.
    pub avg_xp: Option<f32>,
    /// Kills / deaths ratio (deaths = battles - survived).
    pub kd_ratio: Option<f32>,
    /// Survival rate, percent (0–100).
    pub survival_rate: Option<f32>,
    /// Main battery hit rate, percent (0–100).
    pub hit_rate: Option<f32>,
    /// Personal Rating (community formula proxy: based on avg dmg + wr).
    pub pr: Option<i64>,
    /// Number of distinct ships played.
    pub ships_played: Option<i64>,

    // ── Service record (player level/badge) ─────────────────────────────
    /// WG service record tier (player "level"). Used to render a rank badge
    /// in the UI — higher tier = more decorated badge. Range: 1–100+.
    pub leveling_tier: Option<i32>,
    /// WG service record points (XP towards next tier).
    pub leveling_points: Option<i64>,

    // ── Dog tag (player emblem) ─────────────────────────────────────────
    /// Player's dog tag components, fetched from the WG Vortex API. The dog
    /// tag is the player's personalized emblem shown in-game. Colors are
    /// ARGB-packed u32 values; texture/symbol/background IDs are entity refs
    /// to pattern assets. None if Vortex fetch failed.
    pub dog_tag: Option<DogTag>,

    // ── Per-division winrates ───────────────────────────────────────────
    pub solo_wr: Option<f32>,
    pub div2_wr: Option<f32>,
    pub div3_wr: Option<f32>,
}

/// One player name suggestion from the WG account/list autocomplete
/// (live search-as-you-type in the lookup sidebar).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSuggestion {
    pub account_id: i64,
    pub nickname: String,
}

/// One clan suggestion from the WG clans/list autocomplete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanSuggestion {
    pub clan_id: i64,
    /// Short clan tag (rendered as [TAG]).
    pub tag: String,
    /// Full clan name.
    pub name: String,
    pub members_count: Option<i64>,
}

/// Per-member PvP summary inside a clan roster — the same deep-stat set the
/// player card shows, minus the per-ship table (that stays on the player
/// page; it would need one WG request per member). Hidden profiles yield
/// `hidden=true` with all stats None.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClanMemberStats {
    pub battles: Option<i64>,
    pub wins: Option<i64>,
    /// Winrate, percent (0–100).
    pub winrate: Option<f32>,
    pub avg_damage: Option<f32>,
    /// Community PR proxy (same formula as the player card; CN rosters
    /// expose no division splits, so there it falls back to the overall
    /// winrate).
    pub pr: Option<i64>,
    pub avg_xp: Option<f32>,
    pub kd_ratio: Option<f32>,
    /// Survival rate, percent (0–100).
    pub survival_rate: Option<f32>,
    pub hidden: bool,
}

/// One clan member (roster row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanMember {
    pub account_id: i64,
    /// Player nickname (resolved via a batched account/info call).
    pub name: String,
    /// WG role key: commander / executive_officer / recruitment_officer /
    /// private / … (mapped to a label on the frontend).
    pub role: String,
    /// Join timestamp, epoch seconds.
    pub joined_at: Option<i64>,
    pub stats: ClanMemberStats,
}

/// Clan overview card: WG clans/info metadata + the roster with per-member
/// PvP stats (names and stats resolved in ONE batched account/info call —
/// members ≤ 50, and the endpoint accepts up to 100 ids per request).
/// Aggregate fields are computed across visible (non-hidden) members.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanInfo {
    pub clan_id: i64,
    pub tag: String,
    pub name: String,
    /// Realm the lookup hit: ru / eu / na / asia.
    pub realm: String,
    pub description: Option<String>,
    pub members_count: i64,
    /// Clan creation timestamp, epoch seconds.
    pub created_at: Option<i64>,
    pub members: Vec<ClanMember>,
    /// Sum over visible members.
    pub total_battles: i64,
    /// Sum over visible members.
    pub total_wins: i64,
    /// total_wins / total_battles, percent (0–100). 0 when no visible stats.
    pub winrate: f32,
    /// Sum of damage / total_battles (community-style clan average).
    pub avg_damage: f32,
    /// Mean PR proxy across visible members that have one (None when no
    /// visible member has stats).
    pub avg_pr: Option<i64>,
    /// Members whose profile is hidden (no PvP stats).
    pub hidden_count: i64,
}

/// Entity metadata from an EntityCreate (0x05) packet. The fixed header is
/// readable without the per-version entity DB; the trailing `state` BinaryStream
/// (entity properties) is scanned for the roster shipId (see `ship_id`).
///
/// `entity_type` semantics (empirically observed on WoWS 14.5):
///   2 = vehicle (ships, planes, projectiles — ships have the most position
///       updates, so the frontend filters by sample count to keep only ships)
///   4 = aircraft / squadron
///  11 = player avatar (the camera follower; position 0,0,0)
///  14 = capture zone (static)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityKind {
    pub entity_type: i16,
    /// Per-version constant in current clients (7770 / 10513) — NOT a player
    /// id. Kept for diagnostics only; use `ship_id` for the roster join.
    pub vehicle_id: i32,
    pub initial_x: f32,
    pub initial_y: f32,
    pub initial_z: f32,
    /// Match time (seconds) when this entity was created via EntityCreate.
    /// Entities that existed before the replay started have time -1.0.
    #[serde(default = "default_creation_time")]
    pub creation_time: f32,
    /// Roster shipId recovered from the EntityCreate state stream (the ship's
    /// GameParams id, matching `ReplayMeta.vehicles[].shipId`). This is the
    /// only reliable entity → player join key: `vehicle_id` is a per-version
    /// constant and the entity-id spawn order is not team-grouped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_id: Option<i64>,
    /// Capture-zone radius in metres, recovered from the EntityCreate state
    /// stream (only present for entityType 14 zones). Falls back to 60 on the
    /// frontend when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f32>,
    /// 0-based capture-point index (A=0, B=1, ...) recovered from the
    /// EntityCreate `componentsState.controlPoint` component. Only real
    /// domination points carry it; strike/event InteractiveZones have an
    /// empty componentsState and yield `None`. This is the authoritative
    /// "is a capture point" flag — it ships with the create packet itself,
    /// so it works even when the replay records no ownership/progress
    /// updates afterwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_point_index: Option<i32>,
    /// Initial owning team of a capture zone (0/1 = team, -1 = neutral),
    /// recovered from the InteractiveZone `teamId` property (INT8, the first
    /// property byte of the state stream). Zones owned from match start emit
    /// no capSamples/capProgress updates, so the opening colour must come
    /// from the create state itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_team: Option<i8>,
}

fn default_creation_time() -> f32 {
    -1.0
}

// ═══════════════════════════════════════════════════════════════════════
//  Ship encyclopedia + per-ship stats + trends (milestone M10)
// ═══════════════════════════════════════════════════════════════════════

/// Game version metadata from `/wows/encyclopedia/info/`. Used for cache
/// invalidation (encyclopedia is snapshotted per version) and for bucketing
/// player stat trends by the patch they were played under.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersionInfo {
    pub game_version: String,
    pub ships_total: i64,
    /// Unix epoch seconds when this version info was first cached.
    pub timestamp: i64,
}

/// One ship entry from `/wows/encyclopedia/ships/` (the shipopedia). The
/// `default_profile` is the raw JSON subtree — it's a deep nested object with
/// hull HP, artillery, torpedoes, mobility, concealment, etc., and reshapes
/// between game versions, so we keep it as `serde_json::Value` rather than
/// trying to mirror every field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipInfo {
    pub ship_id: i64,
    pub name: String,
    pub tier: i8,
    /// Ship class: "Battleship" / "Cruiser" / "Destroyer" / "AirCarrier" /
    /// "Submarine".
    #[serde(rename = "type")]
    pub type_: String,
    /// Nation key: "usa" / "japan" / "ussr" / "germany" / "uk" / "france" /
    /// "italy" / "netherlands" / "spain" / "pan_america" / "pan_asia" /
    /// "commonwealth" / "pan_europe" / "arabia".
    pub nation: String,
    pub is_premium: bool,
    pub is_special: bool,
    pub description: String,
    /// The version this entry was cached under (set by the fetcher, not WG).
    pub game_version: String,
    pub default_profile: serde_json::Value,
    /// Ship image URLs from the WG CDN. All optional — not every ship has
    /// every size. `medium` is the primary card image; `contour` is the
    /// side-silhouette used in some UIs; `small`/`large` are alternatives.
    pub images: ShipImages,
}

/// Ship image URLs returned by the WG encyclopedia API. Fields are the
/// standard WG image size keys. Empty string if the size isn't available.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShipImages {
    /// Small portrait (~80×48). For compact lists.
    pub small: String,
    /// Medium portrait (~160×96). Primary card image.
    pub medium: String,
    /// Large portrait (~320×192). For detail views.
    pub large: String,
    /// Side-contour silhouette (~32×32). For minimap-style indicators.
    pub contour: String,
}

/// Per-player per-ship PvP stats from `/wows/ships/stats/`. One entry per ship
/// the player has battled in. `name` is back-filled from the encyclopedia at
/// fetch time (WG doesn't return ship names here, only `ship_id`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerShipStats {
    pub ship_id: i64,
    pub name: String,
    pub battles: i64,
    pub wins: i64,
    pub damage_caused: i64,
    pub frags: i64,
    pub survived_battles: i64,
    pub winrate: f32,
    pub avg_damage: f32,
    pub last_battle_time: i64,
    /// Winrate-only PR proxy for this ship (same anchors as the account PR).
    /// `#[serde(default)]` keeps caches written before the field existed
    /// deserializable.
    #[serde(default)]
    pub pr: Option<i64>,
    /// Average XP per battle (None when the realm API doesn't serve xp).
    #[serde(default)]
    pub avg_xp: Option<f32>,
    /// Per-mode breakdown (random solo/div2/div3, co-op, ranked). None on
    /// realms whose per-ship API doesn't serve battle-type splits.
    #[serde(default)]
    pub modes: Option<ShipModeBreakdown>,
}

/// One battle-type bucket of a [`PlayerShipStats`] entry (random solo /
/// division, co-op, ranked). Raw totals as served by WG plus the derived
/// winrate / average damage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipModeStats {
    pub battles: i64,
    pub wins: i64,
    pub damage_caused: i64,
    pub frags: i64,
    pub survived_battles: i64,
    pub winrate: f32,
    pub avg_damage: f32,
}

/// Per-mode breakdown of a ship's stats. Each field is None when the player
/// never played that mode on the ship, or the realm API doesn't serve the
/// battle-type split at all.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShipModeBreakdown {
    #[serde(default)]
    pub solo: Option<ShipModeStats>,
    #[serde(default)]
    pub div2: Option<ShipModeStats>,
    #[serde(default)]
    pub div3: Option<ShipModeStats>,
    #[serde(default)]
    pub coop: Option<ShipModeStats>,
    #[serde(default)]
    pub ranked: Option<ShipModeStats>,
}

/// Per-ship career totals at one moment — the compact subset of
/// [`PlayerShipStats`] that accumulates monotonically, stored in the
/// ship-stats history so consecutive points yield true per-ship deltas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipCareerTotals {
    pub ship_id: i64,
    pub battles: i64,
    pub wins: i64,
    pub damage_caused: i64,
    pub frags: i64,
    pub survived_battles: i64,
    /// Career last-battle time (Unix seconds) — kept so a delta row can show
    /// "when this ship was last played" without re-joining the live data.
    pub last_battle_time: i64,
}

/// One timestamped point of a player's per-ship career totals. Appended to
/// `ship-history/<realm>_<accountId>.json` on each successful per-ship fetch,
/// so a point at or before a date-range cutoff serves as the baseline for
/// real "recent N days" stats (current totals − baseline totals).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipStatsHistoryPoint {
    /// Unix epoch seconds.
    pub timestamp: i64,
    /// Per-ship career totals at that moment (WG order).
    pub ships: Vec<ShipCareerTotals>,
}

/// One point in a player's career-stat time series. Appended (never
/// overwritten) to `snapshots/<realm>_<accountId>.json` on each lookup, so
/// consecutive snapshots let us derive per-version deltas and trends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    /// Unix epoch seconds.
    pub timestamp: i64,
    /// WG game version string active at snapshot time (e.g. "0.11.4").
    pub game_version: String,
    pub battles: i64,
    pub wins: i64,
    pub winrate: f32,
    pub avg_damage: f32,
    pub pr: Option<i64>,
}

/// Aggregated stats over one version bucket. Computed client-side from the
/// snapshot array by grouping on `game_version`. When only one snapshot falls
/// in a bucket (the common case), avg/min/max are all equal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendBucket {
    pub version: String,
    pub start_time: i64,
    pub end_time: i64,
    pub snapshot_count: i64,
    pub battle_delta: i64,
    pub winrate_avg: f32,
    pub winrate_min: f32,
    pub winrate_max: f32,
    pub avg_damage: f32,
    pub pr_avg: Option<i64>,
}

/// Player career trend across game versions, with patch annotations for
/// context (e.g. "0.11.4 nerfed cruiser radar" overlaid on the winrate dip).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendResult {
    pub account_id: i64,
    pub realm: String,
    pub buckets: Vec<TrendBucket>,
    pub patches: Vec<PatchNote>,
}

/// A patch/balance-change annotation. Ship-specific changes carry `ship_ids`;
/// ship_ids empty means a global change. `summary` is a short headline,
/// `changes` is a bullet list. This is hand-maintained JSON (no automated
/// source) — the schema is the contract, content fills in over time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchNote {
    pub version: String,
    pub date: String,
    pub ship_ids: Vec<i64>,
    pub summary: String,
    pub changes: Vec<String>,
}

/// Community-wide per-ship trend (the "server average winrate over versions"
/// chart). WG's public API doesn't aggregate across players, so version
/// buckets come from a curated cache (`community/<ship_id>.json`, future:
/// written by a server-side aggregator). When available, `buckets` mirrors
/// TrendBucket by version; `available: false` renders the placeholder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityTrend {
    pub available: bool,
    pub ship_id: i64,
    pub buckets: Vec<TrendBucket>,
}

/// Server-wide per-ship averages, from wows-numbers' public expected-values
/// dataset (mean per-battle damage / frags / win rate across the population
/// they track). Fetched live with a 7-day on-disk cache — this is the "全服
/// 均值" report the ship-detail modal's community tab renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipServerStats {
    pub ship_id: i64,
    /// Mean damage per battle across the server sample.
    pub avg_damage: f64,
    /// Mean frags per battle.
    pub avg_frags: f64,
    /// Mean win rate, in percent.
    pub winrate: f64,
    /// Unix seconds the source dataset was generated (wows-numbers `time`).
    pub generated_at: i64,
    /// True when served from the on-disk cache without a network fetch.
    pub from_cache: bool,
}

// ── Mod Hub (M10 groundwork) ────────────────────────────────────────────────

/// Plugin category, derived from on-disk structure signatures — see
/// docs/<lang>/designs/mod-formats.md for the full taxonomy and the real
/// package samples each variant mirrors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModKind {
    /// WWise voice bank (`banks/mods/*` + AudioModification xml).
    Voice,
    /// PnF ship-model/camouflage mod (`PnFMods/*/Main.py` registering a ship).
    Skin,
    /// PnF or Unbound script mod whose `Main.py` registers no ship.
    Script,
    /// Direct file overrides under `content/` (`.dds` textures etc.).
    Textures,
    /// HUD art (`gui/ribbons`, `gui/BFGC/BattleWave`).
    Gui,
    /// Loose config patches (`ime_config.xml` …).
    Patch,
}

/// One classified plugin found installed under `res_mods/<version>/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    pub kind: ModKind,
    pub name: String,
    /// PnF `registerShipMod(...)` ship id for skins; in-game voice-over option
    /// label for banks. `None` when the kind has no secondary identifier.
    pub detail: Option<String>,
    /// Primary path of the entry relative to the `res_mods/<version>/` root —
    /// the key the enable/uninstall commands take. Manifest-only rows (an
    /// `installed_mods.xml` entry with no matched files) key on the row name.
    pub rel_path: String,
    /// Every root the unit spans (res_mods-relative, disjoint). Directory
    /// paths keep their names; the disabled state lives in the FILES under
    /// them (`.bak` suffix), not in the directory names.
    #[serde(default)]
    pub paths: Vec<String>,
    /// True when every file of the unit carries a `.bak` suffix (temporarily
    /// disabled). The scan recognizes `.bak` files so units survive being
    /// disabled and can be re-enabled.
    #[serde(default)]
    pub disabled: bool,
    /// Version reported by Aslain's `installed_mods.xml` when the unit is
    /// backed by a manifest entry. `None` for pure filesystem heuristics.
    #[serde(default)]
    pub version: Option<String>,
}

/// Result of toggling one installed plugin's `.bak` state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitToggleReport {
    pub rel_path: String,
    /// State AFTER the toggle: true = files renamed to `.bak`.
    pub disabled: bool,
    pub renamed_files: usize,
}

/// One subtree copy the install performs: `fromRel` (relative to the package
/// root) lands at `toRel` (relative to the new `res_mods/<version>/`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlanEntry {
    pub from_rel: String,
    pub to_rel: String,
}

/// Install plan for an unpacked plugin directory. Shown to the user before
/// `mod_hub_install` writes anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub kind: ModKind,
    /// Display name: folder name, or the AudioModification `<Name>` /
    /// PnF ship id when the format carries a better one.
    pub name: String,
    /// Kind-specific secondary id (see `InstalledMod::detail`).
    pub detail: Option<String>,
    pub entries: Vec<PackagePlanEntry>,
    /// Non-fatal observations: missing loader marker will be auto-created,
    /// case-variant bank folders (`Mods` vs `mods`), overwrite targets.
    pub warnings: Vec<String>,
}

/// Result of applying a [`PackagePlan`] to a game install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub name: String,
    /// `bin/<version>` the files were written into.
    pub bin_version: String,
    pub wrote_files: usize,
    pub warnings: Vec<String>,
}

// ── Mod Hub online catalog (mirrors scripts/mod_hub_publish.py output) ──────

/// One downloadable package of a catalog entry: a zip re-hosted as an asset of
/// the repo's `mod-hub` release. `sha256` is verified before unpacking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPackage {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub name: String,
}

/// Localized name + one-line description of a catalog entry, keyed by
/// BCP-47 locale in `CatalogEntry::i18n` (source: the `wowsp:i18n` block in
/// the Discussions thread). Consumers fall back to en-US.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryI18n {
    #[serde(default)]
    pub name: String,
    /// Index JSON carries this as `desc` (discussion line format); aliased so
    /// both shapes deserialize.
    #[serde(default, alias = "desc")]
    pub description: String,
}

/// The `latest` version payload of one mod in `mod-index.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    /// `battle | minimap | port | texts`.
    pub category: String,
    /// Discussions thread number carrying the full post (source, hashes).
    pub discussion: Option<u64>,
    pub version: String,
    /// Game-version range string as published, e.g. `>=15.7 <15.8`.
    pub game: String,
    pub title: String,
    pub name_zh: String,
    pub name_en: String,
    pub description: String,
    pub author_url: String,
    pub packages: Vec<CatalogPackage>,
    /// Localized name/description variants; may be empty for older posts.
    #[serde(default)]
    pub i18n: std::collections::HashMap<String, CatalogEntryI18n>,
}

/// Parsed `mod-index.json` — the online plugin list the hub page renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogIndex {
    /// Upstream catalog stamp, e.g. `v.15.7.0 #10 (2026.08.30)`.
    pub source_version: String,
    /// Game marketing version the catalog targets, e.g. `15.7.0`.
    pub game_version: String,
    /// RFC3339 timestamp of when this copy was fetched.
    pub fetched_at: String,
    pub mods: Vec<CatalogEntry>,
}

/// Install book-keeping for one mod, persisted in `mods/installed.json`.
/// Uninstall and the future migration engine both work off this record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub category: String,
    /// `mod-hub` for catalog installs, `local` for folder installs.
    pub source: String,
    pub discussion: Option<u64>,
    /// `bin/<version>` the files were written into.
    pub bin_version: String,
    /// RFC3339 timestamp.
    pub installed_at: String,
    /// Every file written, relative to `res_mods/<bin_version>/`.
    pub files: Vec<String>,
    /// Where pre-overwrite snapshots of replaced files live, if any.
    pub restore_dir: Option<String>,
}

/// Progress push for a catalog install (`wowsp://mod-catalog-progress`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProgress {
    pub id: String,
    /// `downloading | installing | done`.
    pub phase: String,
    /// 1-based index of the package in flight.
    pub package: u32,
    pub packages: u32,
    pub received: u64,
    pub total: u64,
}

/// One resource pack's LOCAL state (Settings → cache management panel).
/// Mirrored by `PackStatus` in the webui api client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    /// `models` | `dogtags`.
    pub id: String,
    /// Whether the pack directory exists and holds at least one entry.
    pub present: bool,
    /// Cached sync version — the GitHub release asset's `updated_at` stamp
    /// the pack was downloaded from. `None` when never downloaded (or an
    /// installer-shipped pack whose version could not be stamped).
    pub version: Option<String>,
    /// Recursive on-disk size of the pack directory in bytes.
    pub size_bytes: u64,
    /// Whether a download for this pack is currently in flight.
    pub downloading: bool,
}

/// Remote pack state after a `res-latest` lookup (cache-management panel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdate {
    /// `models` | `dogtags`.
    pub id: String,
    /// The `res-latest` asset's `updated_at`, `None` when the release could
    /// not be reached (offline / rate-limited / no mirror worked).
    pub remote_version: Option<String>,
    /// Remote version known AND different from the cached stamp. When the
    /// pack is absent this is `true` (i.e. "available to download").
    pub update_available: bool,
}

/// Progress push for a pack download (`wowsp://pack-progress`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProgress {
    /// `models` | `dogtags`.
    pub id: String,
    /// `download | extract | done | error`.
    pub phase: String,
    /// Bytes received so far (download phase only).
    pub received: u64,
    /// Total bytes when the server reported Content-Length, else 0.
    pub total: u64,
    /// Human-readable error on the `error` phase (empty otherwise).
    pub error: Option<String>,
}

/// A clearable auxiliary cache directory (cache-management panel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxCacheStatus {
    /// Machine scope key: `image-cache` | `gameparams` | `encyclopedia` | `community`.
    pub scope: String,
    /// Recursive on-disk size in bytes; 0 when the directory is absent.
    pub size_bytes: u64,
}
