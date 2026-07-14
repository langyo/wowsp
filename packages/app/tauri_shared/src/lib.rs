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
    /// 360.cn joint-venture CN region.
    Cn360,
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
    pub vehicles: Vec<VehicleEntry>,
    pub raw: serde_json::Value,
}

/// Result of a Tab-triggered screen capture + roster-region detection in
/// overlay mode. The frontend uses `rosterRect` to anchor the rendered roster.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// PNG bytes of the captured game window, base64-encoded for IPC.
    pub image_base64: String,
    /// Detected team-list region in screen pixels, or `None` if not found.
    pub roster_rect: Option<Rect>,
}

/// An axis-aligned rectangle in screen pixel coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
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

/// Entity metadata from an EntityCreate (0x05) packet. The fixed header is
/// readable without the per-version entity DB; the trailing `state` BinaryStream
/// (entity properties) is skipped.
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
    pub vehicle_id: i32,
    pub initial_x: f32,
    pub initial_y: f32,
    pub initial_z: f32,
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
/// chart). Not available from WG's public API (they don't aggregate across
/// players); wows-numbers has it but no API + blocks scraping. This struct is
/// the placeholder contract — `available: false` until a backend partner is
/// wired in. When available, `buckets` mirrors TrendBucket by version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityTrend {
    pub available: bool,
    pub ship_id: i64,
    pub buckets: Vec<TrendBucket>,
}
