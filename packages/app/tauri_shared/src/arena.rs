use crate::replay::VehicleEntry;
use serde::{Deserialize, Serialize};

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
    /// Battle-script id, e.g. "PCVE027" — mirrors `ReplayMeta::event_type`.
    #[serde(default)]
    pub event_type: Option<String>,
    /// Roster entries with the client's `:Name:` bot nickname style — see
    /// [`ReplayMeta::bot_count`].
    #[serde(default)]
    pub bot_count: u32,
    /// Scripted-unit roster entries (`IDS_*` / `#Name`) — see
    /// [`ReplayMeta::scripted_unit_count`]. The live panel needs it to label
    /// the mode before any replay of the battle exists.
    #[serde(default)]
    pub scripted_unit_count: u32,
    pub vehicles: Vec<VehicleEntry>,
    pub raw: serde_json::Value,
}
