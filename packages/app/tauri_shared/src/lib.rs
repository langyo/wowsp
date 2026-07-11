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
    pub samples: Vec<PositionSample>,
}
