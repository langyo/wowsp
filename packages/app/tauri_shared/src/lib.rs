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

/// State of the DESKTOP pairing server (`pairing_start` / `pairing_stop` /
/// `pairing_get_status`). While running, `host`/`port` is the LAN address the
/// phone types in and `pin` the 6-digit code it must enter to obtain a token.
/// Mobile builds always report `{ running: false }` — no server exists there.
///
/// V2 pairing: `pin` carries the WORKER-ALLOCATED pairing code while the
/// built-in internet gateway is reachable (`mode == "relay"`,
/// `relay_online == true`); when the gateway is unreachable the desktop falls
/// back to its locally-generated LAN PIN (`mode == "lan-local"`,
/// `relay_online == false`) and the UI shows a LAN-only hint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub running: bool,
    /// LAN IPv4 of this desktop (first non-loopback), when running.
    #[serde(default)]
    pub host: Option<String>,
    /// Bound TCP port, when running.
    #[serde(default)]
    pub port: Option<u16>,
    /// The 6-digit code shown on the desktop screen: the gateway-allocated
    /// pairing code in relay mode, the locally-generated PIN in LAN-only mode.
    #[serde(default)]
    pub pin: Option<String>,
    /// `"relay"` (internet gateway online) | `"lan-local"` (fallback), when
    /// running.
    #[serde(default)]
    pub mode: Option<String>,
    /// Whether the built-in internet gateway answered with a pairing code.
    #[serde(default)]
    pub relay_online: bool,
    /// Gateway manifest (protocol v2) field: the resolved gateway's
    /// self-described operator (e.g. `"wowsp"`, or a future exchange
    /// provider the built-in address forwards to). `None` in legacy v1
    /// direct mode (no manifest was served) or while the gateway is offline.
    /// Additive + default so older payloads keep parsing.
    #[serde(default)]
    pub provider: Option<String>,
    /// Gateway manifest (protocol v2) field: true when the resolved gateway
    /// was reached by FOLLOWING a manifest `upstream` hop (the fixed built-in
    /// address forwarded to someone else's infrastructure). Always false in
    /// legacy direct mode. Additive + default so older payloads keep parsing.
    #[serde(default)]
    pub via_upstream: bool,
    /// Gateway manifest (protocol v2) field: free-form operator notice from
    /// the manifest (logged by the app, no UI). `None` without a manifest.
    /// Additive + default so older payloads keep parsing.
    #[serde(default)]
    pub notice: Option<String>,
}

/// Success result of `pairing_pair` — the bearer token every subsequent
/// remote call (`pairing_list_remote` / `pairing_pull_replay` /
/// `pairing_pull_gamedata`) sends back to the desktop server. Relay mode
/// also returns the room key (the 64-hex random id the gateway resolved the
/// pairing code to) the session's tunnels are addressed by; LAN mode leaves
/// it `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingToken {
    pub token: String,
    /// Relay room key (64-hex random id), relay mode only.
    #[serde(default)]
    pub room: Option<String>,
}

/// Result of `import_replay_file` / `pairing_pull_replay`: the local path of
/// the replay that landed in the managed replays dir (after filename
/// sanitization + `(1)` dedupe).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPathResult {
    pub path: String,
}

/// Result of `pairing_pull_gamedata`: how many cache files were extracted
/// into the local data dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamedataSyncResult {
    pub files: usize,
}

/// Progress push for one pairing transfer (`wowsp://pairing-progress`, same
/// plumbing as `wowsp://res-progress`). `phase` is `"download"` | `"done"` |
/// `"error"`; one event stream serves every concurrent transfer, so filter by
/// `remoteName` (the `":gamedata:"` sentinel marks the game-data sync).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingProgress {
    /// Remote file name (or the `":gamedata:"` sentinel).
    pub remote_name: String,
    pub phase: String,
    pub received: u64,
    /// Total bytes when known, else 0.
    pub total: u64,
    #[serde(default)]
    pub error: Option<String>,
}

/// Where a pairing call goes. Two transports carry the SAME pairing HTTP
/// protocol (see commands/pairing.rs):
///
/// - `lan` — direct HTTP to the desktop server discovered/typed on the LAN
///   (`host:port`).
/// - `relay` — the same bytes tunneled through the built-in Cloudflare
///   gateway (`packages/pairing-relay`) for cross-network pairing. `room`
///   carries the 64-hex random room key the gateway resolved the pairing
///   code to. It is `None` only on the code-exchange call itself (the
///   gateway resolves the code to the room and the result hands the key
///   back for the session).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PairingTarget {
    /// Direct LAN HTTP to the desktop pairing server.
    Lan { host: String, port: u16 },
    /// HTTP-over-WebSocket-tunnel through the built-in pairing gateway.
    /// `room` is the 64-hex random room key (`None` only for the code
    /// exchange, which resolves it from the 6-digit pairing code).
    Relay { url: String, room: Option<String> },
}

/// Configuration of the desktop's relay host bridge (a HIDDEN setting —
/// there is no UI field; the endpoint is the built-in gateway). Persisted to
/// `pairing-relay-config.json` in the AppData data dir. Enabled by default:
/// the internet gateway is tried on every server start, with automatic
/// LAN-only fallback when unreachable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RelayConfig {
    /// Whether the desktop bridges its pairing server through the built-in
    /// gateway while the server runs (`true` by default).
    pub enabled: bool,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// One desktop seen on the LAN via the UDP discovery broadcast
/// (`wowsp://pairing-discovery` snapshot entry).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    /// Broadcast peer IP — authoritative for reachability (the payload's
    /// self-reported address is never trusted for routing).
    pub host: String,
    /// Pairing server port from the broadcast payload.
    pub port: u16,
    /// Advertised computer name (the desktop's hostname).
    pub name: String,
    /// Seconds since the last broadcast arrived from this host.
    pub last_seen_age_sec: u64,
    /// Worker base URL the desktop advertises when its relay bridge is on —
    /// lets a phone adopt internet mode without typing the URL.
    #[serde(default)]
    pub relay: Option<String>,
}

/// Snapshot pushed on `wowsp://pairing-discovery` whenever the live list
/// changes (throttled to ~1 Hz by the listener).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySnapshot {
    pub hosts: Vec<DiscoveredHost>,
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

/// Screenshot-mode context for the manual-locate picker page: the LAST
/// automatic capture (downscaled to ≤1280 px wide, PNG, base64) plus the
/// guides the detector found on it. When `image_base64` is `None` no usable
/// cached frame exists and the page falls back to the legacy live picker
/// (a transparent window exactly over the game rect). Coordinates are
/// PHYSICAL px relative to the capture origin; the page maps them through
/// its own display scale, so the picker window's DPI never enters the math.
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
    /// Roster attribution mode in force when this anchor was emitted —
    /// `"inferred"` | `"ocr"` | `"off"` (absent = an older backend; the
    /// frontend then keeps its OCR-era behavior). `"inferred"` tells the
    /// overlay page to derive the row→name mapping ITSELF from the arena
    /// roster plus this anchor's `row_alive` (verified Tab sort rule:
    /// `[alive by class+tier] ++ [sunk by class+tier]`), so `row_players`
    /// is deliberately `None` there without meaning "fallback to the index
    /// guess". `"ocr"` carries recognized `row_players` as before; `"off"`
    /// is the historical index mapping.
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
    /// Mirrors [`OverlayAnchor::stale`]: true while the anchored rows' data
    /// just changed (a ship sank) and the row→name re-mapping is catching
    /// up at the accelerated cadence — the main window can badge the panel
    /// "updating". CONSUME ONLY WHILE `state` IS DETECTED: the flag rides
    /// the watcher's pin state across the whole pin lifetime, so a pin
    /// that went stale and was then hidden (Tab released, focus lost) can
    /// report `idle`/`searching` with `stale` still true — on a
    /// non-detected payload the field is residual carry-over, not a
    /// statement about what is (or is not) on screen. It resets with the
    /// next battle / fresh pin.
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
    /// Channel namespace. The audiences the client's BattleController knows:
    /// `battle_common` (all chat), `battle_team` (team chat), `battle_prebattle`
    /// (division chat); anything else is server-specific.
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
    /// Battle counts behind each division winrate (the split tooltips).
    /// `#[serde(default)]` keeps cache files written before these fields
    /// existed deserializable (same rationale as `clan_id`).
    #[serde(default)]
    pub solo_battles: Option<i64>,
    #[serde(default)]
    pub div2_battles: Option<i64>,
    #[serde(default)]
    pub div3_battles: Option<i64>,
}

/// One player name suggestion from the WG account/list autocomplete
/// (live search-as-you-type in the lookup sidebar).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSuggestion {
    pub account_id: i64,
    pub nickname: String,
}

/// 空中小人/水下小人 verdict for one player (Tab overlay seals). Thresholds
/// mirror the frontend compositionStamps() (packages/webui/src/utils/winrate.ts):
/// career battles must exceed 200 and the class share must exceed 20%
/// (strictly greater on both bounds) — see
/// `commands::wg_composition::composition_verdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerComposition {
    pub air: bool,
    pub sub: bool,
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
    /// stream (only present for entityType 14 zones; the first integral f32
    /// in the state — 80..140 m across current maps). The frontend floors
    /// the drawn ring size when absent.
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

/// One file-extension bucket of a texture-override tree's content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureFileKind {
    /// Lowercase extension with any `.bak` toggle suffix stripped (`dds`,
    /// `mfm`, …); files without one count as `none`.
    pub ext: String,
    pub count: u64,
}

/// Structured breakdown of what a texture-override tree actually covers, so
/// the UI can say more than the bare top-level folder name (`content`,
/// `particles`, …). Every value is a language-neutral code the frontend
/// localizes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureAnalysis {
    /// Total files seen under the tree (bounded walk).
    pub file_count: u64,
    /// Extension buckets, largest first (`dds` dominates pure texture packs,
    /// `mfm`/`visual`/`model` mark material & model overrides).
    pub file_kinds: Vec<TextureFileKind>,
    /// Path-signature categories: `gameplay`, `unlocks`, `content`,
    /// `particles`, `spaces`, `texts`, `system`, `camouflage`.
    pub categories: Vec<String>,
    /// Nation folder names under `content/gameplay|unlocks` (`japan`, …).
    pub nations: Vec<String>,
    /// Ship/component class folders under `content/gameplay` — `ship/<class>`
    /// collapses to the class (`battleship`, `gun`, `superstructure`, …).
    pub species: Vec<String>,
    /// Ship/component units parsed from texture file names
    /// (`JSB039_Yamato_1945_Hull_a.dds` → `JSB039 Yamato 1945`), unique by
    /// code, sorted. Empty when the tree carries no recognizable codes.
    pub ships: Vec<String>,
    /// Map folder names directly under `spaces/`.
    pub space_names: Vec<String>,
    /// True when the file budget cut the walk short — counts are lower bounds.
    pub truncated: bool,
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
    /// Structured content breakdown, `kind == Textures` only (see
    /// [`TextureAnalysis`]); `None` for every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_analysis: Option<TextureAnalysis>,
    /// Primary path of the entry relative to the `res_mods/<version>/` root —
    /// the key the enable/uninstall commands take. Manifest-only rows (an
    /// `installed_mods.xml` entry with no matched files) key on the row name.
    pub rel_path: String,
    /// Every root the unit spans (res_mods-relative, disjoint). Directory
    /// paths keep their names; the disabled state lives in the FILES under
    /// them (`.bak` suffix), not in the directory names.
    #[serde(default)]
    pub paths: Vec<String>,
    /// Scan-time notices for this unit — e.g. another installed skin
    /// overriding the same ship id. Absent when empty (wire-compatible
    /// with older payloads).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
    /// Structured breakdown of the override trees in the plan (see
    /// [`TextureAnalysis`]); `None` when the package carries none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_analysis: Option<TextureAnalysis>,
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
    /// Which other installed mods this install overwrote files of (also
    /// mirrored into `warnings`); kept separate so the UI can toast them
    /// without string-matching. Absent when empty so the wire shape of
    /// conflict-free reports stays byte-identical to older builds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
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
    /// Game install this record belongs to (the game root path). Empty on
    /// records written before the field existed — those match any root.
    #[serde(default)]
    pub game_root: String,
}

/// A `bin/<version>/` older than the client's current one whose `res_mods`
/// still carries files — stranded by a game update: invisible to the hub's
/// installed list and not loaded by the client, but still on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleBinInfo {
    pub bin_version: String,
    /// Unit names the scanner recognizes in the stranded tree.
    pub mods: Vec<String>,
    pub file_count: u64,
}

/// What a stale-bin migration did: files moved into the current version's
/// `res_mods`, and files kept as-is because the current tree already had
/// them (the newer install wins, so migrations never overwrite).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub from_version: String,
    pub to_version: String,
    pub moved_files: usize,
    pub skipped_files: usize,
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

/// The single resource pack's LOCAL state (Settings → updates panel).
/// Mirrored by `ResStatus` in the webui api client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResStatus {
    /// Whether at least one pack sub-directory (`models/`, `dogtags/`)
    /// exists and holds an entry.
    pub present: bool,
    /// The content tree hash the cached pack was installed from
    /// (`.res-version.json`). `None` when never hash-stamped.
    pub tree_sha256: Option<String>,
    /// The published-at timestamp that shipped with that tree hash,
    /// ISO-8601 (`None` together with a missing hash).
    pub version: Option<String>,
    /// True when only a LEGACY stamp (`.version` / `.version-dogtags`,
    /// the pre-hash `updated_at` scheme) is on disk — the content hash is
    /// unknowable, so the panel offers a one-time full re-download.
    pub legacy_stamp: bool,
    /// Recursive on-disk size of the pack sub-directories in bytes.
    pub size_bytes: u64,
    /// Whether a pack download/apply is currently in flight.
    pub downloading: bool,
    /// Mobile only: true when the APK-BUNDLED pack is the one serving (no
    /// cache pack, or a cache older than the reported bundled baseline).
    /// Always false on desktop — there is no bundled pack there.
    #[serde(default)]
    pub bundled: bool,
}

/// One link of the chain-patch path a client may apply instead of a full
/// download: the `res-delta-<from>-<to>` release's patch asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResDeltaStep {
    /// Tree hash this patch expects on disk before it applies.
    pub from: String,
    /// Tree hash the pack has after the patch applies.
    pub to: String,
    /// Browser download URL of the `wowsp-res-delta.tar.gz` asset.
    pub url: String,
    /// Asset size in bytes (progress display + mirror sanity check).
    pub size: u64,
}

/// Remote resource-pack state after a `res-latest` manifest lookup
/// (updates panel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResUpdate {
    /// The latest published tree hash, `None` when the manifest could not
    /// be reached (offline / rate-limited / no mirror worked).
    pub latest_tree_sha256: Option<String>,
    /// The latest published-at timestamp (ISO-8601), same reachability
    /// caveat as `latest_tree_sha256`.
    pub latest_version: Option<String>,
    /// True when a `res_download` is possible: the manifest is known AND
    /// the local tree hash differs (or is unknown / legacy-stamped).
    pub update_available: bool,
    /// The chain-patch path from the local tree hash to the latest one.
    /// `Some(steps)` (possibly empty — empty means "full download
    /// required") when the delta tag list was queried successfully;
    /// `None` when that lookup failed (network) and the UI should not
    /// claim either way.
    pub delta_steps: Option<Vec<ResDeltaStep>>,
}

/// Progress push for a resource-pack download (`wowsp://res-progress`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResProgress {
    /// `download | apply | done | error`.
    pub phase: String,
    /// Bytes received so far across the whole pass (download phase only;
    /// chain patches aggregate their sizes into `total`).
    pub received: u64,
    /// Total bytes when known (Content-Length / asset sizes), else 0.
    pub total: u64,
    /// 1-based index of the chain-patch / full-archive segment streaming
    /// (1 for a full download).
    pub segment: u32,
    /// How many segments the pass consists of.
    pub segments: u32,
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

#[cfg(test)]
mod tests {
    //! Wire-contract round-trip tests. The TS side hand-mirrors every type
    //! here (packages/webui/src/api/client.ts, plus the manual-locate picker
    //! in packages/webui/src/manual-locate/main.ts) — these tests pin the
    //! JSON keys serde produces so a dropped `rename_all`, a renamed field,
    //! or a changed `skip_serializing_if` fails CI instead of silently
    //! drifting the IPC contract.
    //!
    //! Scope: EVERY pub type of this crate whose definition or any field
    //! carries a serde attribute (`rename_all`, `rename`, `default`,
    //! `skip_serializing_if`, `alias`, or an enum tag) has a round-trip test
    //! pinning its renamed keys — types with no serde attributes at all are
    //! out of scope by design (nothing on their wire shape can drift through
    //! serde). The wire-critical payloads (replay metadata, arena info,
    //! player stats, pairing/overlay/res status, the mod catalog entry, the
    //! manual-locate context, ...) additionally pin the EXACT top-level key
    //! set via `assert_exact_keys`, so an ADDITIVE field fails too until the
    //! TS mirror learns it.

    use super::*;

    /// Serialize → deserialize → re-serialize must be the identity on the
    /// JSON `Value` level. Returns the wire shape for key assertions.
    fn round_trips<T>(value: T) -> serde_json::Value
    where
        T: Serialize + serde::de::DeserializeOwned,
    {
        let first = serde_json::to_value(&value).expect("serializes");
        let back: T = serde_json::from_value(first.clone()).expect("parses its own shape");
        let second = serde_json::to_value(&back).expect("re-serializes");
        assert_eq!(first, second, "JSON round-trip must be stable");
        first
    }

    /// Pins the EXACT top-level key set: same count, same names. A field
    /// merely ADDED on the Rust side (which a `contains_key` list would
    /// silently ignore, and the TS interface would silently drop) fails
    /// here until the mirror is updated too.
    fn assert_exact_keys(v: &serde_json::Value, keys: &[&str]) {
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), keys.len(), "key set drifted: {v}");
        for key in keys {
            assert!(obj.contains_key(*key), "missing {key} in {v}");
        }
    }

    // ── game detection (client.ts: GameInstall / GameProcessInfo) ──────────

    /// `GameInstallKind::CnKongzhong` is the drift-prone variant: camelCase
    /// yields "cnKongzhong", not "cn_kongzhong" / "CnKongzhong".
    #[test]
    fn game_install_renames_fields_and_enum_variants() {
        let install = GameInstall {
            kind: GameInstallKind::CnKongzhong,
            path: r"C:\Games\WoWS".into(),
            realm: Some("cn".into()),
        };
        let v = round_trips(install);
        assert_eq!(v["kind"], "cnKongzhong");
        assert_eq!(v["path"], r"C:\Games\WoWS");
        assert_eq!(v["realm"], "cn");
        assert_eq!(v.as_object().unwrap().len(), 3);
    }

    #[test]
    fn game_process_info_renames_exe_path_and_matched_install() {
        let info = GameProcessInfo {
            running: true,
            pid: Some(4242),
            kind: Some(GameInstallKind::Steam),
            realm: None,
            exe_path: Some(r"C:\Steam\...\WorldOfWarships64.exe".into()),
            matched_install: None,
        };
        let v = round_trips(info);
        for key in [
            "running",
            "pid",
            "kind",
            "realm",
            "exePath",
            "matchedInstall",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["pid"], 4242);
        assert_eq!(v["exePath"], r"C:\Steam\...\WorldOfWarships64.exe");
    }

    /// Every variant of the detection enum, spelled as the TS union members
    /// (client.ts: `GameInstallKind = GameInstall["kind"]`).
    #[test]
    fn game_install_kind_covers_every_variant() {
        assert_eq!(round_trips(GameInstallKind::Wargaming), "wargaming");
        assert_eq!(round_trips(GameInstallKind::Steam), "steam");
        assert_eq!(round_trips(GameInstallKind::Lesta), "lesta");
        assert_eq!(round_trips(GameInstallKind::Cn360), "cn360");
        assert_eq!(round_trips(GameInstallKind::CnKongzhong), "cnKongzhong");
        assert_eq!(round_trips(GameInstallKind::Manual), "manual");
    }

    // ── replays (client.ts: ReplayMeta / ReplayMetaLite) ────────────────────

    #[test]
    fn replay_meta_renames_every_multi_word_field() {
        let meta = ReplayMeta {
            path: "replays/20250622.wowsreplay".into(),
            match_group: Some("pvp".into()),
            date_time: Some("20250622_152405".into()),
            map_id: Some(15),
            map_name: Some("15_NE_north".into()),
            scenario: Some("domination_3point".into()),
            event_type: Some("PCVE027".into()),
            bot_count: 2,
            vehicles: vec![VehicleEntry {
                id: 7,
                name: ":Bot:".into(),
                relation: 2,
                ship_id: 4282948544,
                ship_name: Some("Montana".into()),
            }],
            raw: serde_json::json!({ "playerName": "recorder" }),
        };
        let v = round_trips(meta);
        for key in [
            "path",
            "matchGroup",
            "dateTime",
            "mapId",
            "mapName",
            "scenario",
            "eventType",
            "botCount",
            "vehicles",
            "raw",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        let vehicle = &v["vehicles"][0];
        assert_eq!(vehicle["shipId"], 4_282_948_544_i64);
        assert_eq!(vehicle["shipName"], "Montana");
        // bot_count is serde-defaulted: an old payload without it parses
        // (the Option fields already default to None; `raw` stays required).
        let legacy = serde_json::json!({ "path": "p", "vehicles": [], "raw": {} });
        assert!(serde_json::from_value::<ReplayMeta>(legacy).is_ok());
    }

    #[test]
    fn replay_meta_lite_renames_own_ship_fields() {
        let lite = ReplayMetaLite {
            path: "r.wowsreplay".into(),
            date_time: Some("20250622".into()),
            match_group: Some("ranked".into()),
            map_name: Some("15_NE_north".into()),
            map_id: Some(15),
            scenario: None,
            event_type: None,
            bot_count: 0,
            own_ship_id: Some(4282948544),
            own_ship_name: Some("Montana".into()),
            player_count: 12,
        };
        let v = round_trips(lite);
        for key in [
            "ownShipId",
            "ownShipName",
            "playerCount",
            "dateTime",
            "matchGroup",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["ownShipId"], 4_282_948_544_i64);
    }

    /// Wire-critical payload: pin the EXACT key set so an additive field
    /// (which the TS interface would silently drop) fails here too.
    #[test]
    fn replay_meta_pins_the_exact_wire_key_set() {
        let v = round_trips(ReplayMeta {
            path: "pin.wowsreplay".into(),
            match_group: Some("clan".into()),
            date_time: Some("20260926_101112".into()),
            map_id: Some(40),
            map_name: Some("spaces/40_Okinawa".into()),
            scenario: Some("domination_3point".into()),
            event_type: Some("PCVE027".into()),
            bot_count: 9,
            vehicles: Vec::new(),
            raw: serde_json::json!({ "pin": true }),
        });
        assert_exact_keys(
            &v,
            &[
                "path",
                "matchGroup",
                "dateTime",
                "mapId",
                "mapName",
                "scenario",
                "eventType",
                "botCount",
                "vehicles",
                "raw",
            ],
        );
    }

    /// Wire-critical payload: pin the EXACT key set of the list view's DTO.
    #[test]
    fn replay_meta_lite_pins_the_exact_wire_key_set() {
        let v = round_trips(ReplayMetaLite {
            path: "pin-lite.wowsreplay".into(),
            date_time: Some("20260926_101113".into()),
            match_group: Some("event".into()),
            map_name: Some("14_ATL_north".into()),
            map_id: Some(14),
            scenario: Some("epic_3point".into()),
            event_type: Some("PCVE999".into()),
            bot_count: 8,
            own_ship_id: Some(4_279_574_672_i64),
            own_ship_name: Some("Kremlin".into()),
            player_count: 7,
        });
        assert_exact_keys(
            &v,
            &[
                "path",
                "dateTime",
                "matchGroup",
                "mapName",
                "mapId",
                "scenario",
                "eventType",
                "botCount",
                "ownShipId",
                "ownShipName",
                "playerCount",
            ],
        );
    }

    // ── pairing (client.ts: PairingStatus / PairingToken / PairingTarget /
    //    PairingProgress / DiscoveredHost) ────────────────────────────────────

    #[test]
    fn pairing_status_renames_relay_online_and_via_upstream() {
        let status = PairingStatus {
            running: true,
            host: Some("192.0.2.10".into()),
            port: Some(51888),
            pin: Some("123456".into()),
            mode: Some("relay".into()),
            relay_online: true,
            provider: Some("wowsp".into()),
            via_upstream: true,
            notice: Some("maintenance".into()),
        };
        let v = round_trips(status);
        for key in [
            "running",
            "host",
            "port",
            "pin",
            "mode",
            "relayOnline",
            "provider",
            "viaUpstream",
            "notice",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["relayOnline"], true);
        assert_eq!(v["viaUpstream"], true);
        // The v2 manifest fields are additive: a v1 payload without them
        // still deserializes (defaults kick in).
        let v1 = serde_json::json!({ "running": false });
        assert!(serde_json::from_value::<PairingStatus>(v1).is_ok());
    }

    #[test]
    fn pairing_token_renames_room() {
        let v = round_trips(PairingToken {
            token: "bearer-1".into(),
            room: Some("a".repeat(64)),
        });
        assert_eq!(v.as_object().unwrap().len(), 2);
        assert_eq!(v["token"], "bearer-1");
        assert_eq!(v["room"], "a".repeat(64));
    }

    /// `PairingTarget` is internally tagged (`kind`) — the TS side is a
    /// discriminated union, so both the tag and the payload field names are
    /// load-bearing.
    #[test]
    fn pairing_target_serializes_as_a_tagged_union() {
        let lan = round_trips(PairingTarget::Lan {
            host: "192.0.2.10".into(),
            port: 51888,
        });
        assert_eq!(lan["kind"], "lan");
        assert_eq!(lan["host"], "192.0.2.10");
        assert_eq!(lan["port"], 51888);

        let relay = round_trips(PairingTarget::Relay {
            url: "https://worker.example.workers.dev".into(),
            room: Some("b".repeat(64)),
        });
        assert_eq!(relay["kind"], "relay");
        assert_eq!(relay["url"], "https://worker.example.workers.dev");
        assert_eq!(relay["room"], "b".repeat(64));
    }

    #[test]
    fn pairing_progress_renames_remote_name() {
        let v = round_trips(PairingProgress {
            remote_name: ":gamedata:".into(),
            phase: "download".into(),
            received: 1024,
            total: 4096,
            error: None,
        });
        for key in ["remoteName", "phase", "received", "total", "error"] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["remoteName"], ":gamedata:");
    }

    #[test]
    fn discovered_host_renames_last_seen_age_sec() {
        let v = round_trips(DiscoveredHost {
            host: "192.0.2.10".into(),
            port: 51888,
            name: "DESKTOP".into(),
            last_seen_age_sec: 3,
            relay: None,
        });
        assert_eq!(v["lastSeenAgeSec"], 3);
        assert_eq!(v.as_object().unwrap().len(), 5);
    }

    /// Container-level `#[serde(default)]`: an EMPTY JSON object parses back
    /// to the relay bridge's default (enabled) — the persisted config is
    /// written before the file schema existed (client.ts: RelayConfig).
    #[test]
    fn relay_config_defaults_from_an_empty_payload() {
        let v = round_trips(RelayConfig::default());
        assert_exact_keys(&v, &["enabled"]);
        assert_eq!(v["enabled"], true);
        let from_empty: RelayConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(from_empty.enabled);
    }

    /// Trivial result DTOs whose camelCase is a no-op today — the attribute
    /// is still load-bearing the day a multi-word field lands. The TS side
    /// inlines `{ path: string }` / `{ files: number }` (client.ts).
    #[test]
    fn pairing_path_and_gamedata_results_round_trip() {
        let v = round_trips(PairingPathResult {
            path: "replays/20260926_101114.wowsreplay".into(),
        });
        assert_exact_keys(&v, &["path"]);
        let v = round_trips(GamedataSyncResult { files: 17 });
        assert_exact_keys(&v, &["files"]);
    }

    /// The discovery event's snapshot wrapper (client.ts: DiscoverySnapshot).
    #[test]
    fn discovery_snapshot_wraps_the_host_list() {
        let v = round_trips(DiscoverySnapshot { hosts: Vec::new() });
        assert_exact_keys(&v, &["hosts"]);
    }

    /// Wire-critical payload: exact key set. (v1 payloads MISSING these keys
    /// must keep parsing via the per-field defaults — see the test above.)
    #[test]
    fn pairing_status_pins_the_exact_wire_key_set() {
        let v = round_trips(PairingStatus {
            running: true,
            host: Some("192.0.2.20".into()),
            port: Some(51999),
            pin: Some("654321".into()),
            mode: Some("lan-local".into()),
            relay_online: false,
            provider: None,
            via_upstream: false,
            notice: None,
        });
        assert_exact_keys(
            &v,
            &[
                "running",
                "host",
                "port",
                "pin",
                "mode",
                "relayOnline",
                "provider",
                "viaUpstream",
                "notice",
            ],
        );
    }

    // ── overlay (client.ts: OverlayState / OverlayStatus) ───────────────────

    /// `OverlayState` is serde-lowercase, not camelCase — the TS side spells
    /// the union members "idle" | "searching" | ... exactly.
    #[test]
    fn overlay_state_serializes_lowercase() {
        assert_eq!(round_trips(OverlayState::Idle), "idle");
        assert_eq!(round_trips(OverlayState::Searching), "searching");
        assert_eq!(round_trips(OverlayState::Detected), "detected");
        assert_eq!(round_trips(OverlayState::Fallback), "fallback");
        assert_eq!(round_trips(OverlayState::Manual), "manual");
    }

    #[test]
    fn overlay_status_nests_the_state_enum() {
        let v = round_trips(OverlayStatus {
            state: OverlayState::Detected,
            rows: Some(12),
            manual: false,
            stale: true,
        });
        assert_eq!(v["state"], "detected");
        assert_eq!(v["rows"], 12);
        assert_eq!(v["manual"], false);
        assert_eq!(v["stale"], true);
    }

    /// Wire-critical payload: exact key set (client.ts: OverlayStatus).
    #[test]
    fn overlay_status_pins_the_exact_wire_key_set() {
        let v = round_trips(OverlayStatus {
            state: OverlayState::Manual,
            rows: None,
            manual: true,
            stale: false,
        });
        assert_exact_keys(&v, &["state", "rows", "manual", "stale"]);
    }

    // ── live arena + manual locate (client.ts: ArenaInfo / CaptureResult /
    //    OverlayAnchor / Rect / TabRow*; manual-locate/main.ts: the context
    //    + guides DTOs) ─────────────────────────────────────────────────────────

    /// The live tempArenaInfo.json mirror of ReplayMeta (client.ts:
    /// ArenaInfo). Wire-critical payload: exact key set, plus the nested
    /// VehicleEntry's (the roster row the whole overlay joins against).
    #[test]
    fn arena_info_renames_match_group_date_time_and_map_name() {
        let arena = ArenaInfo {
            match_group: Some("ranked".into()),
            date_time: Some("20260926_202122".into()),
            map_name: Some("spaces/40_Okinawa".into()),
            scenario: Some("domination_tournament_3point".into()),
            bot_count: 3,
            vehicles: vec![VehicleEntry {
                id: 51_515_151,
                name: "arena-sentinel".into(),
                relation: 0,
                ship_id: 4_180_755_280_i64,
                ship_name: Some("Gearing".into()),
            }],
            raw: serde_json::json!({ "arenaSender": "sentinel" }),
        };
        let v = round_trips(arena);
        assert_exact_keys(
            &v,
            &[
                "matchGroup",
                "dateTime",
                "mapName",
                "scenario",
                "botCount",
                "vehicles",
                "raw",
            ],
        );
        let vehicle = &v["vehicles"][0];
        assert_exact_keys(vehicle, &["id", "name", "relation", "shipId", "shipName"]);
        assert_eq!(vehicle["shipId"], 4_180_755_280_i64);
    }

    /// `anchor` is `#[serde(default)]` WITHOUT `skip_serializing_if`: a
    /// capture with no anchor ships `"anchor": null`, not a missing key —
    /// the TS side types it optional-but-present. The nested OverlayAnchor
    /// pins all eleven chip-alignment keys (client.ts: CaptureResult /
    /// OverlayAnchor).
    #[test]
    fn capture_result_and_overlay_anchor_rename_every_multi_word_field() {
        let anchor = OverlayAnchor {
            game_rect: Rect {
                x: 1,
                y: 2,
                width: 1920,
                height: 1080,
            },
            overlay_rect: Rect {
                x: 3,
                y: 4,
                width: 800,
                height: 600,
            },
            roster_rect: Rect {
                x: 5,
                y: 6,
                width: 700,
                height: 500,
            },
            row_centers: vec![100, 140, 180],
            team_split: 0.5,
            table_detected: true,
            row_players: Some(vec![Some("capture-sentinel".into()), None]),
            row_alive: Some(vec![true, false]),
            row_players_pending: false,
            stale: false,
            roster_mode: "ocr".into(),
        };
        let full = CaptureResult {
            image_base64: "aGVsbG8=".into(),
            roster_rect: Some(Rect {
                x: 11,
                y: 12,
                width: 640,
                height: 480,
            }),
            anchor: Some(anchor),
        };
        let v = round_trips(full);
        assert_exact_keys(&v, &["imageBase64", "rosterRect", "anchor"]);
        assert_exact_keys(
            &v["anchor"],
            &[
                "gameRect",
                "overlayRect",
                "rosterRect",
                "rowCenters",
                "teamSplit",
                "tableDetected",
                "rowPlayers",
                "rowAlive",
                "rowPlayersPending",
                "stale",
                "rosterMode",
            ],
        );
        // An unmatched row keeps its slot as null inside rowPlayers.
        assert!(v["anchor"]["rowPlayers"][1].is_null());

        let bare = CaptureResult {
            image_base64: String::new(),
            roster_rect: None,
            anchor: None,
        };
        let v = round_trips(bare);
        assert_exact_keys(&v, &["imageBase64", "rosterRect", "anchor"]);
        assert!(v["anchor"].is_null());
    }

    /// The picker's snap guides (manual-locate/main.ts:
    /// ManualLocateGuides) — defaults keep absent keys parsing as empty.
    #[test]
    fn manual_locate_guides_renames_table_rect_row_lines_and_seam_x() {
        let v = round_trips(ManualLocateGuides {
            table_rect: Some(Rect {
                x: 21,
                y: 22,
                width: 420,
                height: 330,
            }),
            row_lines: vec![310, 350],
            seam_x: Some(430),
        });
        assert_exact_keys(&v, &["tableRect", "rowLines", "seamX"]);
    }

    /// Wire-critical payload: exact key set of the picker's screenshot-mode
    /// context (manual-locate/main.ts: ManualLocateContext).
    #[test]
    fn manual_locate_context_pins_the_exact_wire_key_set() {
        let ctx = ManualLocateContext {
            image_base64: Some("cGlja2Vy".into()),
            image_width: Some(1280),
            image_height: Some(720),
            phys_width: 2560,
            phys_height: 1440,
            captured_at_ms: Some(1_777_777_777_777),
            captured_game_rect: Some(Rect {
                x: 31,
                y: 32,
                width: 2560,
                height: 1440,
            }),
            guides: ManualLocateGuides {
                table_rect: Some(Rect {
                    x: 33,
                    y: 34,
                    width: 510,
                    height: 405,
                }),
                row_lines: vec![510, 550],
                seam_x: None,
            },
        };
        let v = round_trips(ctx);
        assert_exact_keys(
            &v,
            &[
                "imageBase64",
                "imageWidth",
                "imageHeight",
                "physWidth",
                "physHeight",
                "capturedAtMs",
                "capturedGameRect",
                "guides",
            ],
        );
        assert_eq!(v["physWidth"], 2560);
        assert!(v["guides"]["seamX"].is_null());
    }

    /// Single-word pixel tuple — camelCase is a no-op today; the attribute
    /// still guards the rect against a future multi-word field (client.ts:
    /// Rect).
    #[test]
    fn rect_keeps_the_four_pixel_keys() {
        let v = round_trips(Rect {
            x: 41,
            y: 42,
            width: 43,
            height: 44,
        });
        assert_exact_keys(&v, &["x", "y", "width", "height"]);
    }

    /// The Tab-order event payload (client.ts: TabRowPlayer / TabRowOrder):
    /// `battle` is the arena mtime join key, `name: null` keeps the slot.
    #[test]
    fn tab_row_order_renames_date_time_and_both_sides() {
        let order = TabRowOrder {
            date_time: Some("20260926_232425".into()),
            battle: 1_777_777_778,
            allies: vec![TabRowPlayer {
                name: Some("tab-ally".into()),
                alive: true,
            }],
            enemies: vec![TabRowPlayer {
                name: None,
                alive: false,
            }],
        };
        let v = round_trips(order);
        assert_exact_keys(&v, &["dateTime", "battle", "allies", "enemies"]);
        assert_exact_keys(&v["allies"][0], &["name", "alive"]);
        assert!(v["enemies"][0]["name"].is_null());
    }

    // ── replay stream (client.ts: ReplayStream — skip_serializing_if
    //    cluster) ─────────────────────────────────────────────────────────────

    /// The stream DTO omits every empty optional section: a minimal stream
    /// serializes to `{"trajectories":[...]}` alone, and the TS side reads
    /// the missing keys as absent (not null).
    #[test]
    fn replay_stream_omits_empty_sections() {
        let minimal = ReplayStream {
            trajectories: vec![EntityTrajectory {
                entity_id: 7,
                kind: None,
                samples: vec![PositionSample {
                    time: 1.5,
                    entity_id: 7,
                    vehicle_id: 10513,
                    x: 100.0,
                    y: 0.0,
                    z: -200.0,
                    yaw: 1.25,
                }],
                death_time: None,
                hp_samples: Vec::new(),
                cap_samples: Vec::new(),
                cap_progress: Vec::new(),
            }],
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            weapon_locks: Vec::new(),
            battle_results: None,
            version: None,
            map_name: None,
            camera: Vec::new(),
            net_stats: Vec::new(),
            leaves: std::collections::BTreeMap::new(),
            camera_modes: Vec::new(),
            diagnostics: DiagnosticCounts::default(),
            squadron_creates: Vec::new(),
            squadron_planes: Vec::new(),
            minimap_squadron_adds: Vec::new(),
            minimap_squadron_moves: Vec::new(),
            minimap_squadron_removes: Vec::new(),
            wards: Vec::new(),
            ward_removes: Vec::new(),
            shot_kills: Vec::new(),
            damage_stats: Vec::new(),
            chat_messages: Vec::new(),
            achievements: Vec::new(),
        };
        let v = round_trips(minimal);
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1, "only trajectories survives: {v}");
        assert!(obj.contains_key("trajectories"));
        assert_eq!(obj["trajectories"][0]["samples"][0]["entityId"], 7);

        // A populated stream keeps the renamed optional keys.
        let rich = ReplayStream {
            battle_results: Some(r#"{"personal":{"wins":1}}"#.into()),
            version: Some("0.14.5".into()),
            map_name: Some("40_Okinawa".into()),
            diagnostics: DiagnosticCounts {
                server_ticks: 5,
                ..Default::default()
            },
            ..serde_json::from_value::<ReplayStream>(serde_json::json!({
                "trajectories": []
            }))
            .unwrap()
        };
        let v = round_trips(rich);
        for key in [
            "trajectories",
            "battleResults",
            "version",
            "mapName",
            "diagnostics",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
    }

    /// `EntityKind` hides its unrecovered optional fields entirely (the TS
    /// side types them as optional), and defaults creation_time to -1.
    #[test]
    fn entity_kind_skips_unrecovered_fields() {
        let bare = EntityKind {
            entity_type: 2,
            vehicle_id: 10513,
            initial_x: 1.0,
            initial_y: 2.0,
            initial_z: 3.0,
            creation_time: 10.0,
            ship_id: None,
            radius: None,
            control_point_index: None,
            initial_team: None,
        };
        let v = round_trips(bare);
        for key in [
            "entityType",
            "vehicleId",
            "initialX",
            "initialY",
            "initialZ",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        for absent in ["shipId", "radius", "controlPointIndex", "initialTeam"] {
            assert!(
                !v.as_object().unwrap().contains_key(absent),
                "{absent} leaked"
            );
        }

        let zone = EntityKind {
            entity_type: 14,
            radius: Some(45.0),
            control_point_index: Some(1),
            initial_team: Some(-1),
            ship_id: Some(4282948544),
            ..serde_json::from_value::<EntityKind>(serde_json::json!({
                "entityType": 14,
                "vehicleId": 10513,
                "initialX": 0.0,
                "initialY": 0.0,
                "initialZ": 0.0
            }))
            .unwrap()
        };
        let v = round_trips(zone);
        assert_eq!(v["radius"], 45.0);
        assert_eq!(v["controlPointIndex"], 1);
        assert_eq!(v["initialTeam"], -1);
        assert_eq!(v["shipId"], 4_282_948_544_i64);
        // creation_time defaulted to -1 (pre-replay start), not 0.
        assert_eq!(v["creationTime"], -1.0);
    }

    // ── stream DTOs not fully pinned by the replay_stream test above ────────

    /// The trajectory DTO itself: the three vec streams + `deathTime`
    /// appear ONLY when non-empty/Some (skip_serializing_if), while `kind`
    /// (a plain Option) rides as null. PositionSample / HpSample key sets
    /// pinned nested (client.ts: EntityTrajectory).
    #[test]
    fn entity_trajectory_emits_optional_streams_only_when_present() {
        let minimal = EntityTrajectory {
            entity_id: 51,
            kind: None,
            samples: Vec::new(),
            death_time: None,
            hp_samples: Vec::new(),
            cap_samples: Vec::new(),
            cap_progress: Vec::new(),
        };
        let v = round_trips(minimal);
        assert_exact_keys(&v, &["entityId", "kind", "samples"]);
        assert!(v["kind"].is_null());

        let full = EntityTrajectory {
            entity_id: 52,
            kind: Some(EntityKind {
                entity_type: 4,
                vehicle_id: 7770,
                initial_x: 4.0,
                initial_y: 5.0,
                initial_z: 6.0,
                creation_time: 7.0,
                ship_id: None,
                radius: None,
                control_point_index: None,
                initial_team: None,
            }),
            samples: vec![PositionSample {
                time: 8.5,
                entity_id: 52,
                vehicle_id: 10513,
                x: 100.5,
                y: 0.5,
                z: -200.5,
                yaw: 2.5,
            }],
            death_time: Some(610.5),
            hp_samples: vec![HpSample {
                time: 9.5,
                value: 61_238,
            }],
            cap_samples: vec![HpSample {
                time: 10.5,
                value: 2,
            }],
            cap_progress: vec![HpSample {
                time: 11.5,
                value: 1,
            }],
        };
        let v = round_trips(full);
        assert_exact_keys(
            &v,
            &[
                "entityId",
                "kind",
                "samples",
                "deathTime",
                "hpSamples",
                "capSamples",
                "capProgress",
            ],
        );
        assert_eq!(v["deathTime"], 610.5);
        assert_exact_keys(
            &v["samples"][0],
            &["time", "entityId", "vehicleId", "x", "y", "z", "yaw"],
        );
        assert_exact_keys(&v["hpSamples"][0], &["time", "value"]);
    }

    /// Terminal ballistics (client.ts: ExplosionEvent / ShellLaunchEvent).
    #[test]
    fn explosion_and_shell_launch_events_rename_ids_and_targets() {
        let v = round_trips(ExplosionEvent {
            time: 61.5,
            x: 1.5,
            y: 2.5,
            z: 3.5,
            params_id: 425_001,
        });
        assert_exact_keys(&v, &["time", "x", "y", "z", "paramsId"]);

        let v = round_trips(ShellLaunchEvent {
            time: 62.5,
            owner_id: 63,
            params_id: 425_002,
            salvo_id: 64,
            shot_id: 65,
            x: 4.5,
            y: 5.5,
            z: 6.5,
            target_x: 7.5,
            target_y: 8.5,
            target_z: 9.5,
            server_time_left: 10.5,
            speed: 780.5,
            gun_barrel_id: 66,
        });
        assert_exact_keys(
            &v,
            &[
                "time",
                "ownerId",
                "paramsId",
                "salvoId",
                "shotId",
                "x",
                "y",
                "z",
                "targetX",
                "targetY",
                "targetZ",
                "serverTimeLeft",
                "speed",
                "gunBarrelId",
            ],
        );
    }

    /// Torpedo launches + homing updates (client.ts: TorpedoLaunch /
    /// TorpedoSteer).
    #[test]
    fn torpedo_events_rename_direction_and_target_fields() {
        let v = round_trips(TorpedoLaunch {
            time: 71.5,
            owner_id: 72,
            params_id: 425_003,
            salvo_id: 73,
            shot_id: 74,
            x: 1.25,
            y: 2.25,
            z: 3.25,
            dir_x: 4.25,
            dir_y: 5.25,
            dir_z: 6.25,
            armed: true,
        });
        assert_exact_keys(
            &v,
            &[
                "time", "ownerId", "paramsId", "salvoId", "shotId", "x", "y", "z", "dirX", "dirY",
                "dirZ", "armed",
            ],
        );

        let v = round_trips(TorpedoSteer {
            time: 81.5,
            owner_id: 82,
            shot_id: 83,
            x: 1.75,
            y: 2.75,
            z: 3.75,
            target_yaw: 4.75,
        });
        assert_exact_keys(
            &v,
            &["time", "ownerId", "shotId", "x", "y", "z", "targetYaw"],
        );
    }

    /// Minimap squadron markers + fighter-patrol wards (client.ts:
    /// MinimapSquadron* / WardEvent / WardRemoveEvent).
    #[test]
    fn minimap_squadron_and_ward_events_rename_composite_ids() {
        let v = round_trips(MinimapSquadronAdd {
            time: 91.5,
            plane_id: 92,
            owner_id: 93,
            team_id: 1,
            params_id: 425_004,
            x: 1.5,
            z: 2.5,
        });
        assert_exact_keys(
            &v,
            &["time", "planeId", "ownerId", "teamId", "paramsId", "x", "z"],
        );

        let v = round_trips(MinimapSquadronMove {
            time: 94.5,
            plane_id: 95,
            x: 3.5,
            z: 4.5,
        });
        assert_exact_keys(&v, &["time", "planeId", "x", "z"]);

        let v = round_trips(MinimapSquadronRemove {
            time: 96.5,
            plane_id: 97,
        });
        assert_exact_keys(&v, &["time", "planeId"]);

        let v = round_trips(WardEvent {
            time: 98.5,
            squadron_id: 99,
            owner_id: 100,
            team_id: 0,
            x: 5.5,
            y: 6.5,
            z: 7.5,
            radius: 250.5,
            ward_type: 2,
        });
        assert_exact_keys(
            &v,
            &[
                "time",
                "squadronId",
                "ownerId",
                "teamId",
                "x",
                "y",
                "z",
                "radius",
                "wardType",
            ],
        );

        let v = round_trips(WardRemoveEvent {
            time: 101.5,
            plane_id: 102,
        });
        assert_exact_keys(&v, &["time", "planeId"]);
    }

    /// Projectile kills + server-authoritative damage ticks (client.ts:
    /// ShotKillEvent / DamageStatSample).
    #[test]
    fn shot_kill_and_damage_stat_events_rename_ids_and_totals() {
        let v = round_trips(ShotKillEvent {
            time: 111.5,
            owner_id: 112,
            hit_type: 3,
            shot_id: 113,
            x: 1.5,
            y: 2.5,
            z: 3.5,
        });
        assert_exact_keys(&v, &["time", "ownerId", "hitType", "shotId", "x", "y", "z"]);

        let v = round_trips(DamageStatSample {
            time: 121.5,
            weapon: 17,
            category: 0,
            count: 114,
            total: 115_000.5,
        });
        assert_exact_keys(&v, &["time", "weapon", "category", "count", "total"]);
    }

    /// Recorder lock / camera / netstat timelines (client.ts:
    /// WeaponLockEvent / CameraSample / NetStatsSample).
    #[test]
    fn weapon_lock_camera_and_net_stats_samples_rename_multi_word_fields() {
        let v = round_trips(WeaponLockEvent {
            time: 131.5,
            weapon_type: 132,
            lock_type: 2,
            target_id: 133,
        });
        assert_exact_keys(&v, &["time", "weaponType", "lockType", "targetId"]);

        let v = round_trips(CameraSample {
            time: 141.5,
            rot_x: 0.25,
            rot_y: 0.5,
            rot_z: 0.75,
            rot_w: 1.0,
            x: 8.5,
            y: 9.5,
            z: 10.5,
            fov: 1.25,
        });
        assert_exact_keys(
            &v,
            &["time", "rotX", "rotY", "rotZ", "rotW", "x", "y", "z", "fov"],
        );

        let v = round_trips(NetStatsSample {
            time: 151.5,
            fps: 60,
            ping: 116,
            is_lagging: true,
        });
        assert_exact_keys(&v, &["time", "fps", "ping", "isLagging"]);
    }

    /// Aircraft squadron spawns + per-plane waypoints (client.ts:
    /// SquadronCreate / SquadronPlane).
    #[test]
    fn squadron_events_rename_plane_id_and_formation_index() {
        let v = round_trips(SquadronCreate {
            time: 161.5,
            plane_id: 162,
            params_id: 425_005,
            x: 1.5,
            y: 300.5,
            z: 2.5,
        });
        assert_exact_keys(&v, &["time", "planeId", "paramsId", "x", "y", "z"]);

        let v = round_trips(SquadronPlane {
            time: 171.5,
            plane_id: 172,
            index: 3,
            x: 3.5,
            y: 301.5,
            z: 4.5,
            yaw: 5.5,
        });
        assert_exact_keys(&v, &["time", "planeId", "index", "x", "y", "z", "yaw"]);
    }

    /// Battle chat + achievements (client.ts: ChatEvent / AchievementEvent).
    #[test]
    fn chat_and_achievement_events_rename_player_and_achievement_ids() {
        let v = round_trips(ChatEvent {
            time: 181.5,
            player_id: 117,
            namespace: "battle_team".into(),
            message: "chat-sentinel".into(),
        });
        assert_exact_keys(&v, &["time", "playerId", "namespace", "message"]);

        let v = round_trips(AchievementEvent {
            time: 191.5,
            player_id: 118,
            achievement_id: 425_006,
        });
        assert_exact_keys(&v, &["time", "playerId", "achievementId"]);
    }

    /// The diagnostics block rides `ReplayStream` only when non-default;
    /// every counter is multi-word (client.ts: DiagnosticCounts).
    #[test]
    fn diagnostic_counts_renames_every_counter() {
        let v = round_trips(DiagnosticCounts {
            server_ticks: 201,
            server_timestamps: 202,
            init_flags: 203,
            init_markers: 204,
            base_player_creates: 205,
            create_stubs: 206,
            entity_controls: 207,
            entity_enters: 208,
            camera_modes: 209,
            camera_freelooks: 210,
            sub_controllers: 211,
            cruise_states: 212,
            shot_trackings: 213,
            gun_markers: 214,
        });
        assert_exact_keys(
            &v,
            &[
                "serverTicks",
                "serverTimestamps",
                "initFlags",
                "initMarkers",
                "basePlayerCreates",
                "createStubs",
                "entityControls",
                "entityEnters",
                "cameraModes",
                "cameraFreelooks",
                "subControllers",
                "cruiseStates",
                "shotTrackings",
                "gunMarkers",
            ],
        );
    }

    // ── ship encyclopedia (client.ts: ShipInfo) ─────────────────────────────

    /// `ShipInfo::type_` carries the file's ONLY explicit field rename —
    /// the TS side reads `type` (a reserved word it can't spell otherwise).
    #[test]
    fn ship_info_renames_the_type_field() {
        let ship = ShipInfo {
            ship_id: 4282948544,
            name: "Montana".into(),
            tier: 10,
            type_: "Battleship".into(),
            nation: "usa".into(),
            is_premium: false,
            is_special: false,
            description: "One of the most powerful battleships".into(),
            game_version: "0.11.4".into(),
            default_profile: serde_json::json!({ "hull": { "health": 96300 } }),
            images: ShipImages {
                small: "s.png".into(),
                medium: "m.png".into(),
                large: "l.png".into(),
                contour: "c.png".into(),
            },
        };
        let v = round_trips(ship);
        for key in [
            "shipId",
            "type",
            "isPremium",
            "isSpecial",
            "gameVersion",
            "defaultProfile",
            "images",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["type"], "Battleship");
        assert!(!v.as_object().unwrap().contains_key("type_"));
    }

    // ── snapshots (client.ts: StatsSnapshot) ────────────────────────────────

    #[test]
    fn stats_snapshot_renames_game_version_and_avg_damage() {
        let v = round_trips(StatsSnapshot {
            timestamp: 1_700_000_000,
            game_version: "0.11.4".into(),
            battles: 1234,
            wins: 617,
            winrate: 50.0,
            avg_damage: 61_238.5,
            pr: Some(1500),
        });
        for key in [
            "timestamp",
            "gameVersion",
            "battles",
            "wins",
            "winrate",
            "avgDamage",
            "pr",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["gameVersion"], "0.11.4");
    }

    // ── encyclopedia + per-ship stats + trends (client.ts: GameVersionInfo /
    //    ShipImages / PlayerShipStats / ShipModeStats / ShipServerStats /
    //    ShipCareerTotals / ShipStatsHistoryPoint / Trend* / PatchNote) ────────

    #[test]
    fn game_version_info_renames_game_version_and_ships_total() {
        let v = round_trips(GameVersionInfo {
            game_version: "0.14.5".into(),
            ships_total: 615,
            timestamp: 1_777_777_779,
        });
        assert_exact_keys(&v, &["gameVersion", "shipsTotal", "timestamp"]);
    }

    /// The four WG CDN size keys — single words today, pinned so a fifth
    /// size can't appear without the TS mirror learning it (client.ts:
    /// ShipImages).
    #[test]
    fn ship_images_keeps_the_four_size_keys() {
        let v = round_trips(ShipImages {
            small: "img-small.png".into(),
            medium: "img-medium.png".into(),
            large: "img-large.png".into(),
            contour: "img-contour.png".into(),
        });
        assert_exact_keys(&v, &["small", "medium", "large", "contour"]);
    }

    /// Per-ship table row + its mode breakdown. The breakdown's five mode
    /// keys are always present (defaults don't skip): an unplayed mode
    /// rides as null, not as a missing key (client.ts: PlayerShipStats /
    /// ShipModeStats / ShipModeBreakdown).
    #[test]
    fn player_ship_stats_renames_damage_survival_and_mode_fields() {
        let stats = PlayerShipStats {
            ship_id: 4_180_755_280_i64,
            name: "Gearing".into(),
            battles: 221,
            wins: 122,
            damage_caused: 9_876_543,
            frags: 231,
            survived_battles: 124,
            winrate: 55.25,
            avg_damage: 44_777.5,
            last_battle_time: 1_777_777_780,
            pr: Some(2_450),
            avg_xp: Some(1_515.5),
            modes: Some(ShipModeBreakdown {
                solo: Some(ShipModeStats {
                    battles: 222,
                    wins: 123,
                    damage_caused: 9_876_544,
                    frags: 232,
                    survived_battles: 125,
                    winrate: 55.5,
                    avg_damage: 44_778.5,
                }),
                div2: None,
                div3: None,
                coop: None,
                ranked: None,
            }),
        };
        let v = round_trips(stats);
        assert_exact_keys(
            &v,
            &[
                "shipId",
                "name",
                "battles",
                "wins",
                "damageCaused",
                "frags",
                "survivedBattles",
                "winrate",
                "avgDamage",
                "lastBattleTime",
                "pr",
                "avgXp",
                "modes",
            ],
        );
        assert_exact_keys(&v["modes"], &["solo", "div2", "div3", "coop", "ranked"]);
        assert!(v["modes"]["div2"].is_null());
        assert_exact_keys(
            &v["modes"]["solo"],
            &[
                "battles",
                "wins",
                "damageCaused",
                "frags",
                "survivedBattles",
                "winrate",
                "avgDamage",
            ],
        );
    }

    /// The ship-history file format (ship-history/<realm>_<accountId>.json
    /// points — client.ts: ShipCareerTotals / ShipStatsHistoryPoint).
    #[test]
    fn ship_career_totals_and_history_point_rename_totals() {
        let v = round_trips(ShipCareerTotals {
            ship_id: 4_279_574_672_i64,
            battles: 241,
            wins: 124,
            damage_caused: 8_765_432,
            frags: 242,
            survived_battles: 125,
            last_battle_time: 1_777_777_781,
        });
        assert_exact_keys(
            &v,
            &[
                "shipId",
                "battles",
                "wins",
                "damageCaused",
                "frags",
                "survivedBattles",
                "lastBattleTime",
            ],
        );

        let v = round_trips(ShipStatsHistoryPoint {
            timestamp: 1_777_777_782,
            ships: Vec::new(),
        });
        assert_exact_keys(&v, &["timestamp", "ships"]);
    }

    #[test]
    fn trend_bucket_renames_winrate_extremes_and_snapshot_count() {
        let v = round_trips(TrendBucket {
            version: "0.14.5".into(),
            start_time: 1_777_777_783,
            end_time: 1_777_777_784,
            snapshot_count: 251,
            battle_delta: 252,
            winrate_avg: 52.25,
            winrate_min: 48.5,
            winrate_max: 55.75,
            avg_damage: 88_888.5,
            pr_avg: Some(2_551),
        });
        assert_exact_keys(
            &v,
            &[
                "version",
                "startTime",
                "endTime",
                "snapshotCount",
                "battleDelta",
                "winrateAvg",
                "winrateMin",
                "winrateMax",
                "avgDamage",
                "prAvg",
            ],
        );
    }

    /// Career trend + its hand-maintained patch annotations (client.ts:
    /// TrendResult / PatchNote).
    #[test]
    fn trend_result_and_patch_note_rename_ids_and_dates() {
        let v = round_trips(TrendResult {
            account_id: 525_252_525,
            realm: "na".into(),
            buckets: Vec::new(),
            patches: vec![PatchNote {
                version: "0.14.5".into(),
                date: "2026-09-26".into(),
                ship_ids: vec![4_279_574_672_i64],
                summary: "patch-sentinel".into(),
                changes: vec!["change-sentinel".into()],
            }],
        });
        assert_exact_keys(&v, &["accountId", "realm", "buckets", "patches"]);
        assert_exact_keys(
            &v["patches"][0],
            &["version", "date", "shipIds", "summary", "changes"],
        );
    }

    #[test]
    fn community_trend_renames_ship_id() {
        let v = round_trips(CommunityTrend {
            available: true,
            ship_id: 4_279_574_672_i64,
            buckets: Vec::new(),
        });
        assert_exact_keys(&v, &["available", "shipId", "buckets"]);
    }

    /// The "server average" report (client.ts: ShipServerStats).
    #[test]
    fn ship_server_stats_renames_generated_at_and_from_cache() {
        let v = round_trips(ShipServerStats {
            ship_id: 4_279_574_672_i64,
            avg_damage: 95_252.5,
            avg_frags: 1.25,
            winrate: 50.75,
            generated_at: 1_777_777_785,
            from_cache: true,
        });
        assert_exact_keys(
            &v,
            &[
                "shipId",
                "avgDamage",
                "avgFrags",
                "winrate",
                "generatedAt",
                "fromCache",
            ],
        );
    }

    // ── WG player & clan stats (client.ts: DogTag / PlayerStats /
    //    PlayerSuggestion / PlayerComposition / ClanSuggestion /
    //    ClanMemberStats / ClanMember / ClanInfo) ──────────────────────────────

    #[test]
    fn dog_tag_renames_texture_symbol_and_color_ids() {
        let v = round_trips(DogTag {
            texture_id: 425_101,
            symbol_id: 425_102,
            border_color: 1_111_111_111,
            background_color: 2_222_222_222,
            background_id: 425_103,
        });
        assert_exact_keys(
            &v,
            &[
                "textureId",
                "symbolId",
                "borderColor",
                "backgroundColor",
                "backgroundId",
            ],
        );
    }

    /// Wire-critical payload: exact key set of the player card's data —
    /// 24 keys, every multi-word one renamed (client.ts: PlayerStats).
    #[test]
    fn player_stats_renames_every_deep_stat_field() {
        let stats = PlayerStats {
            account_id: 53_155_353,
            name: "player-sentinel".into(),
            realm: "eu".into(),
            battles: Some(12_345),
            winrate: Some(51.25),
            hidden: false,
            clan_tag: Some("[SENT]".into()),
            clan_id: Some(500_005_001),
            avg_damage: Some(81_234.5),
            avg_xp: Some(1_234.5),
            kd_ratio: Some(2.25),
            survival_rate: Some(33.75),
            hit_rate: Some(28.5),
            pr: Some(2_450),
            ships_played: Some(87),
            leveling_tier: Some(42),
            leveling_points: Some(987_654),
            dog_tag: Some(DogTag {
                texture_id: 1,
                symbol_id: 2,
                border_color: 3,
                background_color: 4,
                background_id: 5,
            }),
            solo_wr: Some(48.5),
            div2_wr: Some(52.25),
            div3_wr: Some(56.75),
            solo_battles: Some(9_001),
            div2_battles: Some(9_002),
            div3_battles: Some(9_003),
        };
        let v = round_trips(stats);
        assert_exact_keys(
            &v,
            &[
                "accountId",
                "name",
                "realm",
                "battles",
                "winrate",
                "hidden",
                "clanTag",
                "clanId",
                "avgDamage",
                "avgXp",
                "kdRatio",
                "survivalRate",
                "hitRate",
                "pr",
                "shipsPlayed",
                "levelingTier",
                "levelingPoints",
                "dogTag",
                "soloWr",
                "div2Wr",
                "div3Wr",
                "soloBattles",
                "div2Battles",
                "div3Battles",
            ],
        );
        assert_eq!(v["clanTag"], "[SENT]");
        assert_eq!(v["div2Wr"], 52.25);
    }

    /// Lookup sidebar autocomplete + the Tab-overlay seal verdicts
    /// (client.ts: PlayerSuggestion / PlayerComposition).
    #[test]
    fn player_suggestion_and_composition_rename_account_id() {
        let v = round_trips(PlayerSuggestion {
            account_id: 53_155_354,
            nickname: "suggest-sentinel".into(),
        });
        assert_exact_keys(&v, &["accountId", "nickname"]);

        let v = round_trips(PlayerComposition {
            air: true,
            sub: false,
        });
        assert_exact_keys(&v, &["air", "sub"]);
    }

    #[test]
    fn clan_suggestion_renames_clan_id_and_members_count() {
        let v = round_trips(ClanSuggestion {
            clan_id: 500_005_002,
            tag: "[CLAN]".into(),
            name: "clan-sentinel".into(),
            members_count: Some(30),
        });
        assert_exact_keys(&v, &["clanId", "tag", "name", "membersCount"]);
    }

    #[test]
    fn clan_member_stats_renames_every_deep_stat_field() {
        let v = round_trips(ClanMemberStats {
            battles: Some(23_456),
            wins: Some(11_234),
            winrate: Some(47.75),
            avg_damage: Some(61_238.5),
            pr: Some(1_501),
            avg_xp: Some(1_100.5),
            kd_ratio: Some(1.25),
            survival_rate: Some(40.25),
            hidden: false,
        });
        assert_exact_keys(
            &v,
            &[
                "battles",
                "wins",
                "winrate",
                "avgDamage",
                "pr",
                "avgXp",
                "kdRatio",
                "survivalRate",
                "hidden",
            ],
        );
    }

    /// A roster row; the nested stats block rides hidden-profile members as
    /// all-null keys, never missing keys (client.ts: ClanMember).
    #[test]
    fn clan_member_renames_account_id_joined_at_and_stats() {
        let member = ClanMember {
            account_id: 53_155_355,
            name: "member-sentinel".into(),
            role: "executive_officer".into(),
            joined_at: Some(1_777_777_786),
            stats: ClanMemberStats::default(),
        };
        let v = round_trips(member);
        assert_exact_keys(&v, &["accountId", "name", "role", "joinedAt", "stats"]);
        assert_exact_keys(
            &v["stats"],
            &[
                "battles",
                "wins",
                "winrate",
                "avgDamage",
                "pr",
                "avgXp",
                "kdRatio",
                "survivalRate",
                "hidden",
            ],
        );
    }

    #[test]
    fn clan_info_renames_totals_and_hidden_count() {
        let clan = ClanInfo {
            clan_id: 500_005_003,
            tag: "[INFO]".into(),
            name: "info-sentinel".into(),
            realm: "asia".into(),
            description: Some("clan-description-sentinel".into()),
            members_count: 2,
            created_at: Some(1_600_000_000),
            members: vec![ClanMember {
                account_id: 53_155_356,
                name: "member-two".into(),
                role: "private".into(),
                joined_at: None,
                stats: ClanMemberStats {
                    battles: Some(1_000),
                    wins: Some(500),
                    winrate: Some(50.0),
                    avg_damage: Some(50_000.5),
                    pr: Some(1_350),
                    avg_xp: Some(1_200.5),
                    kd_ratio: Some(1.5),
                    survival_rate: Some(45.5),
                    hidden: false,
                },
            }],
            total_battles: 1_000,
            total_wins: 500,
            winrate: 50.0,
            avg_damage: 50_000.5,
            avg_pr: Some(1_350),
            hidden_count: 1,
        };
        let v = round_trips(clan);
        assert_exact_keys(
            &v,
            &[
                "clanId",
                "tag",
                "name",
                "realm",
                "description",
                "membersCount",
                "createdAt",
                "members",
                "totalBattles",
                "totalWins",
                "winrate",
                "avgDamage",
                "avgPr",
                "hiddenCount",
            ],
        );
    }

    // ── mod hub (client.ts: ModKind / InstalledMod / CatalogProgress) ───────

    /// `ModKind` mirrors the TS union "voice" | "skin" | ... — single-word
    /// variants under camelCase collapse to lowercase.
    #[test]
    fn mod_kind_serializes_to_the_ts_union_members() {
        assert_eq!(round_trips(ModKind::Voice), "voice");
        assert_eq!(round_trips(ModKind::Skin), "skin");
        assert_eq!(round_trips(ModKind::Script), "script");
        assert_eq!(round_trips(ModKind::Textures), "textures");
        assert_eq!(round_trips(ModKind::Gui), "gui");
        assert_eq!(round_trips(ModKind::Patch), "patch");
    }

    #[test]
    fn installed_mod_skips_texture_analysis_when_absent() {
        let plain = InstalledMod {
            kind: ModKind::Skin,
            name: "Yamato camo".into(),
            detail: Some("PJSB001".into()),
            texture_analysis: None,
            rel_path: "PnFMods/PJSB001".into(),
            paths: vec!["PnFMods/PJSB001".into()],
            disabled: false,
            version: None,
            warnings: Vec::new(),
        };
        let v = round_trips(plain.clone());
        assert!(!v.as_object().unwrap().contains_key("textureAnalysis"));
        // Empty warnings stay off the wire (older payloads have no such
        // field and still deserialize).
        assert!(!v.as_object().unwrap().contains_key("warnings"));
        let legacy = serde_json::json!({
            "kind": "skin",
            "name": "old",
            "detail": null,
            "relPath": "x",
            "paths": [],
            "disabled": false,
            "version": null
        });
        let back: InstalledMod = serde_json::from_value(legacy).unwrap();
        assert!(back.warnings.is_empty());
        let mut warned = plain.clone();
        warned.warnings.push("conflict".into());
        assert_eq!(round_trips(warned)["warnings"][0], "conflict");
        assert_eq!(v["relPath"], "PnFMods/PJSB001");
        assert_eq!(v["kind"], "skin");

        let textured = InstalledMod {
            texture_analysis: Some(TextureAnalysis {
                file_count: 12,
                file_kinds: vec![TextureFileKind {
                    ext: "dds".into(),
                    count: 9,
                }],
                categories: vec!["camouflage".into()],
                nations: Vec::new(),
                species: Vec::new(),
                ships: Vec::new(),
                space_names: Vec::new(),
                truncated: false,
            }),
            ..plain
        };
        let v = round_trips(textured);
        assert!(v.as_object().unwrap().contains_key("textureAnalysis"));
        assert_eq!(v["textureAnalysis"]["fileKinds"][0]["ext"], "dds");
    }

    /// Full breakdown key set — the nested assert above only spot-checks
    /// `fileKinds[0].ext` (client.ts: TextureAnalysis / TextureFileKind).
    #[test]
    fn texture_analysis_renames_every_breakdown_key() {
        let v = round_trips(TextureAnalysis {
            file_count: 261,
            file_kinds: vec![TextureFileKind {
                ext: "mfm".into(),
                count: 262,
            }],
            categories: vec!["spaces".into()],
            nations: vec!["japan".into()],
            species: vec!["battleship".into()],
            ships: vec!["JSB039 Yamato 1945".into()],
            space_names: vec!["20_SO_second_test".into()],
            truncated: true,
        });
        assert_exact_keys(
            &v,
            &[
                "fileCount",
                "fileKinds",
                "categories",
                "nations",
                "species",
                "ships",
                "spaceNames",
                "truncated",
            ],
        );
        assert_exact_keys(&v["fileKinds"][0], &["ext", "count"]);
    }

    /// Result of an enable/disable toggle (client.ts: UnitToggleReport).
    #[test]
    fn unit_toggle_report_renames_rel_path_and_renamed_files() {
        let v = round_trips(UnitToggleReport {
            rel_path: "PnFMods/PJSB018".into(),
            disabled: true,
            renamed_files: 271,
        });
        assert_exact_keys(&v, &["relPath", "disabled", "renamedFiles"]);
    }

    /// Install plan preview + its copy list (client.ts: PackagePlanEntry /
    /// PackagePlan). `textureAnalysis` is skipped when absent, present when
    /// set — same rule as InstalledMod's.
    #[test]
    fn package_plan_and_entries_rename_relative_paths() {
        let entry = PackagePlanEntry {
            from_rel: "PnFMods/PJSB018".into(),
            to_rel: "res_mods/0.14.5/PnFMods/PJSB018".into(),
        };
        let v = round_trips(entry.clone());
        assert_exact_keys(&v, &["fromRel", "toRel"]);

        let plan = PackagePlan {
            kind: ModKind::Voice,
            name: "voice-sentinel".into(),
            detail: Some("banks/sentinel".into()),
            entries: vec![entry],
            warnings: vec!["overwrite".into()],
            texture_analysis: None,
        };
        let v = round_trips(plan.clone());
        assert_exact_keys(&v, &["kind", "name", "detail", "entries", "warnings"]);

        let textured = PackagePlan {
            texture_analysis: Some(TextureAnalysis {
                file_count: 281,
                file_kinds: Vec::new(),
                categories: Vec::new(),
                nations: Vec::new(),
                species: Vec::new(),
                ships: Vec::new(),
                space_names: Vec::new(),
                truncated: false,
            }),
            ..plan
        };
        let v = round_trips(textured);
        assert_exact_keys(
            &v,
            &[
                "kind",
                "name",
                "detail",
                "entries",
                "warnings",
                "textureAnalysis",
            ],
        );
    }

    /// Post-install report (client.ts: InstallReport).
    #[test]
    fn install_report_renames_bin_version_and_wrote_files() {
        let v = round_trips(InstallReport {
            name: "install-sentinel".into(),
            bin_version: "0.14.5".into(),
            wrote_files: 291,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        });
        assert_exact_keys(&v, &["name", "binVersion", "wroteFiles", "warnings"]);
        // A report from a pre-conflicts build (no such field) still
        // deserializes — the field defaults to empty.
        let legacy = serde_json::json!({
            "name": "old",
            "binVersion": "1",
            "wroteFiles": 1,
            "warnings": []
        });
        let back: InstallReport = serde_json::from_value(legacy).unwrap();
        assert_eq!(back.name, "old");
        assert!(back.conflicts.is_empty());
        // Non-empty conflicts serialize under the camelCase name.
        let v = round_trips(InstallReport {
            name: "x".into(),
            bin_version: "1".into(),
            wrote_files: 1,
            warnings: Vec::new(),
            conflicts: vec!["overwrites 2 file(s)".into()],
        });
        assert_eq!(v["conflicts"][0], "overwrites 2 file(s)");
    }

    #[test]
    fn catalog_progress_renames_the_package_pair() {
        let v = round_trips(CatalogProgress {
            id: "aslain".into(),
            phase: "downloading".into(),
            package: 1,
            packages: 3,
            received: 2048,
            total: 8192,
        });
        for key in ["id", "phase", "package", "packages", "received", "total"] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["package"], 1);
        assert_eq!(v["packages"], 3);
    }

    /// The catalog's hash field must stay `sha256` — camelCase must not
    /// touch the digits (client.ts: CatalogPackage).
    #[test]
    fn catalog_package_keeps_the_sha256_key() {
        let v = round_trips(CatalogPackage {
            url: "https://github.com/releases/pkg.zip".into(),
            sha256: "deadbeef".repeat(16),
            size: 3_011,
            name: "pkg-sentinel.zip".into(),
        });
        assert_exact_keys(&v, &["url", "sha256", "size", "name"]);
    }

    /// The hand-written index entries say `desc`; the wire and the TS
    /// mirror say `description` — the alias bridges exactly one way
    /// (client.ts: CatalogEntryI18n).
    #[test]
    fn catalog_entry_i18n_accepts_the_desc_alias() {
        let v = round_trips(CatalogEntryI18n {
            name: "name-sentinel".into(),
            description: "desc-sentinel".into(),
        });
        assert_exact_keys(&v, &["name", "description"]);

        let from_index: CatalogEntryI18n =
            serde_json::from_value(serde_json::json!({ "desc": "alias-sentinel" }))
                .expect("desc alias parses");
        assert_eq!(from_index.description, "alias-sentinel");
        // Both fields default: an empty locale block parses to empty strings.
        assert!(serde_json::from_value::<CatalogEntryI18n>(serde_json::json!({})).is_ok());
    }

    /// Wire-critical payload: exact key set of one `mod-index.json` entry
    /// (client.ts: CatalogEntry).
    #[test]
    fn catalog_entry_renames_localized_names_and_pins_the_key_set() {
        let entry = CatalogEntry {
            id: "sentinel-mod".into(),
            category: "minimap".into(),
            discussion: Some(3_021),
            version: "15.7.0".into(),
            game: ">=15.7 <15.8".into(),
            title: "title-sentinel".into(),
            name_zh: "name-zh-sentinel".into(),
            name_en: "name-en-sentinel".into(),
            description: "description-sentinel".into(),
            author_url: "https://example.example/author".into(),
            packages: vec![CatalogPackage {
                url: "https://github.com/releases/pkg2.zip".into(),
                sha256: "ab".repeat(32),
                size: 3_022,
                name: "pkg2-sentinel.zip".into(),
            }],
            i18n: [(
                "zh-CN".to_string(),
                CatalogEntryI18n {
                    name: "zh-name".into(),
                    description: "zh-desc".into(),
                },
            )]
            .into_iter()
            .collect(),
        };
        let v = round_trips(entry);
        assert_exact_keys(
            &v,
            &[
                "id",
                "category",
                "discussion",
                "version",
                "game",
                "title",
                "nameZh",
                "nameEn",
                "description",
                "authorUrl",
                "packages",
                "i18n",
            ],
        );
        assert_eq!(v["i18n"]["zh-CN"]["name"], "zh-name");
    }

    #[test]
    fn catalog_index_renames_source_version_game_version_and_fetched_at() {
        let v = round_trips(CatalogIndex {
            source_version: "v.15.7.0 #10 (2026.08.30)".into(),
            game_version: "15.7.0".into(),
            fetched_at: "2026-09-26T00:00:00Z".into(),
            mods: Vec::new(),
        });
        assert_exact_keys(&v, &["sourceVersion", "gameVersion", "fetchedAt", "mods"]);
    }

    /// The uninstall/migration ledger record (mods/installed.json;
    /// client.ts: ModInstallRecord).
    #[test]
    fn mod_install_record_renames_bin_version_installed_at_and_restore_dir() {
        let v = round_trips(ModInstallRecord {
            id: "record-sentinel".into(),
            name: "record-name".into(),
            version: "15.7.0".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: Some(3_031),
            bin_version: "0.15.7".into(),
            installed_at: "2026-09-26T12:00:00Z".into(),
            files: vec!["res_mods/0.15.7/gui/unbound/main.xml".into()],
            restore_dir: Some("backups/record-sentinel".into()),
            game_root: "D:/Games/WoWs".into(),
        });
        assert_exact_keys(
            &v,
            &[
                "id",
                "name",
                "version",
                "category",
                "source",
                "discussion",
                "binVersion",
                "installedAt",
                "files",
                "restoreDir",
                "gameRoot",
            ],
        );
    }

    // ── resource pack (client.ts: ResStatus / ResUpdate / ResProgress) ──────

    #[test]
    fn res_status_renames_tree_sha256_and_size_bytes() {
        let v = round_trips(ResStatus {
            present: true,
            tree_sha256: Some("abc123def456".into()),
            version: Some("2026-01-01T00:00:00Z".into()),
            legacy_stamp: false,
            size_bytes: 123_456_789,
            downloading: false,
            bundled: false,
        });
        for key in [
            "present",
            "treeSha256",
            "version",
            "legacyStamp",
            "sizeBytes",
            "downloading",
            "bundled",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["treeSha256"], "abc123def456");
    }

    /// `ResUpdate` is the manifest-LOOKUP-ERROR DTO: an unreachable manifest
    /// serializes as explicit nulls (`latestTreeSha256`/`deltaSteps`), which
    /// the TS side types `?: ... | null` — null must stay on the wire.
    #[test]
    fn res_update_keeps_nulls_for_a_failed_lookup() {
        let failed = ResUpdate {
            latest_tree_sha256: None,
            latest_version: None,
            update_available: false,
            delta_steps: None,
        };
        let v = round_trips(failed);
        // The keys must be PRESENT and null — a dropped field would also
        // index as Null, so pin the key set explicitly.
        for key in [
            "latestTreeSha256",
            "latestVersion",
            "updateAvailable",
            "deltaSteps",
        ] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert!(v["latestTreeSha256"].is_null());
        assert!(v["latestVersion"].is_null());
        assert!(v["deltaSteps"].is_null());

        let ok = ResUpdate {
            latest_tree_sha256: Some("abc123".into()),
            latest_version: Some("2026-01-01T00:00:00Z".into()),
            update_available: true,
            delta_steps: Some(vec![ResDeltaStep {
                from: "abc123".into(),
                to: "def456".into(),
                url: "https://github.com/.../wowsp-res-delta.tar.gz".into(),
                size: 1024,
            }]),
        };
        let v = round_trips(ok);
        assert_eq!(v["latestTreeSha256"], "abc123");
        assert_eq!(v["deltaSteps"][0]["from"], "abc123");
        assert_eq!(v["deltaSteps"][0]["to"], "def456");
    }

    #[test]
    fn res_progress_renames_the_segment_pair() {
        let v = round_trips(ResProgress {
            phase: "error".into(),
            received: 512,
            total: 0,
            segment: 2,
            segments: 4,
            error: Some("download failed".into()),
        });
        for key in ["phase", "received", "total", "segment", "segments", "error"] {
            assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(v["segments"], 4);
        assert_eq!(v["error"], "download failed");
    }

    /// Wire-critical payload: exact key set (the test above only lists
    /// contains_key entries — additive drift must fail here).
    #[test]
    fn res_status_pins_the_exact_wire_key_set() {
        let v = round_trips(ResStatus {
            present: true,
            tree_sha256: Some("feedface".into()),
            version: Some("2026-09-26T00:00:00Z".into()),
            legacy_stamp: true,
            size_bytes: 3_041,
            downloading: false,
            bundled: true,
        });
        assert_exact_keys(
            &v,
            &[
                "present",
                "treeSha256",
                "version",
                "legacyStamp",
                "sizeBytes",
                "downloading",
                "bundled",
            ],
        );
    }

    /// One clearable cache directory row (client.ts: AuxCacheStatus).
    #[test]
    fn aux_cache_status_renames_size_bytes() {
        let v = round_trips(AuxCacheStatus {
            scope: "encyclopedia".into(),
            size_bytes: 3_051,
        });
        assert_exact_keys(&v, &["scope", "sizeBytes"]);
    }
}
