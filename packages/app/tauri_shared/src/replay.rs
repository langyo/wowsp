use serde::{Deserialize, Serialize};

use crate::game::GameInstallKind;

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
    /// Roster entries whose nickname is the client's bot style (`:Name:`
    /// bots, `IDS_*` / `#Name` scripted units).
    /// Factual count only — official co-op / asymmetric battles fill bots the
    /// same way, so deciding "custom room with bots" from it (pvp-family match
    /// group or tournament scenario) is the frontend classifier's job.
    #[serde(default)]
    pub bot_count: u32,
    /// Roster entries whose nickname is a scripted-unit key (`IDS_*`) or the
    /// `#Name` scenario style — the operation (行动) half of `bot_count`.
    /// Plain co-op / random fills carry `:Name:` bots only, so a non-zero
    /// count inside a pve-family match group marks an operation even when the
    /// descriptor carries no operation fingerprint (the low-level escort op
    /// arrives as `matchGroup: "pve"` with a mixed `IDS_*` + `:Name:`
    /// roster). Factual count only — the frontend mode classifier turns it
    /// into the operation label.
    #[serde(default)]
    pub scripted_unit_count: u32,
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
    /// Scripted-unit roster entries (`IDS_*` / `#Name`) — see
    /// [`ReplayMeta::scripted_unit_count`]. The list view needs it because a
    /// lite entry carries no roster to scan.
    #[serde(default)]
    pub scripted_unit_count: u32,
    /// The recording player's ship id — the roster entry with `relation == 0`.
    /// Used to render the per-replay holographic ship preview.
    pub own_ship_id: Option<i64>,
    /// The RECORDING PLAYER's nickname — the descriptor's `playerName`, or
    /// the relation-0 roster entry's `name` when the descriptor omits it
    /// (both clients name roster slots after the player, never the ship, so
    /// this is an identity, not a hull). The list card titles each replay
    /// with it and the rail's player filter groups by it, which is what
    /// keeps a client shared by several accounts tellable apart.
    #[serde(default)]
    pub player_name: Option<String>,
    /// Number of LISTED players in the roster — everyone except the scripted
    /// scenario NPCs (`IDS_*` / `#Name`); the `:Name:` co-op bot fills count.
    /// Matches the frontend's player lists (utils/rosterSides): story-mode
    /// ally flagships are scenario NPCs, not roster players.
    pub player_count: usize,
    /// The install the file was found under — its root path, kind and realm
    /// — when the scan root belongs to a detected client. This is the
    /// replay's SERVER identity: an all-clients scan tags every row with it
    /// so the rail can label each card (ASIA / CN / RU) and filter by
    /// client, while a single-dir scan leaves them as the root allows.
    /// All `None` for files under an unowned root (the mobile managed dir,
    /// an env-pinned folder).
    #[serde(default)]
    pub install_path: Option<String>,
    #[serde(default)]
    pub install_kind: Option<GameInstallKind>,
    #[serde(default)]
    pub install_realm: Option<String>,
}
