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
    /// The PCVO* scripts are the operation-scenario fingerprints (see
    /// [`is_operation_arena`]).
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

/// Whether this battle is an operation scenario (行动模式) rather than a
/// team-vs-team mode. Operations fill `matchGroup: "pve"` like co-op does,
/// and their roster `relation` values follow scenario team SLOTS (escort
/// waves, target ships) instead of the enemy semantics PvP modes give them —
/// every consumer that splits the roster into allies/enemies must special-
/// case this. Fingerprints, in the same spirit as the webui classifier
/// (`webui/src/utils/modeColors.ts`): a PCVO* battle script/scenario, an
/// `_op_`/`_hl_` infix, or scenario units whose nickname keeps the client's
/// `IDS_OP_*` ship name.
///
/// EXCEPT the new-account scripted battles — the tutorial (`FIRST_BATTLE`,
/// matchGroup `intro`) and the low-level escort operation
/// (`LOW_LVL_OPERATION_*`). Both field coop-shaped rosters whose `relation`
/// values ARE enemy semantics (verified against live 360-server arena
/// files: scripted allies sit at relation 1, escort DDs and target dummies
/// at relation 2) and whose in-game Tab table is a normal two-block layout,
/// so they must flow through the ordinary allies/enemies split. Their
/// `IDS_OP_15_*` units would otherwise trip the roster fingerprint below
/// and collapse the whole roster into one allied block.
pub fn is_operation_arena(
    scenario: Option<&str>,
    event_type: Option<&str>,
    vehicles: &[VehicleEntry],
) -> bool {
    if is_new_account_scripted_battle(scenario, event_type, vehicles) {
        return false;
    }
    [scenario, event_type].into_iter().flatten().any(|s| {
        let s = s.to_ascii_lowercase();
        s.starts_with("pcvo") || s.contains("_op_") || s.contains("_hl_")
    }) || vehicles
        .iter()
        .any(|v| v.name.to_ascii_uppercase().starts_with("IDS_OP_"))
}

/// The new-account scripted battles that must NOT take the single-team
/// operation path (see [`is_operation_arena`]). Recognized by their
/// scenario ids (`low_lvl_operation*`, `first_battle`) or, when the arena
/// file carries no scenario, by the escort op's `IDS_OP_15_*` unit names.
fn is_new_account_scripted_battle(
    scenario: Option<&str>,
    event_type: Option<&str>,
    vehicles: &[VehicleEntry],
) -> bool {
    [scenario, event_type].into_iter().flatten().any(|s| {
        let s = s.to_ascii_lowercase();
        s.starts_with("low_lvl_operation") || s == "first_battle"
    }) || vehicles
        .iter()
        .any(|v| v.name.to_ascii_uppercase().starts_with("IDS_OP_15_"))
}
