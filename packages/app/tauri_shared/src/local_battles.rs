//! Local-battle-log DTOs (commands/local_battles.rs → webui
//! api/modules/localBattles.ts).
//!
//! The water-table range views (1d / 7d / custom) need PER-BATTLE results for
//! the local player; the official endpoints only carry cumulative counters, so
//! a range used to be inferred from snapshot deltas (empty or wrong whenever a
//! baseline row was missing or stale). Every completed replay the client
//! writes carries the server's authoritative BattleResults (0x22) payload —
//! these DTOs hand that decoded ledger to the webui.

use serde::{Deserialize, Serialize};

/// One completed local battle, decoded from a replay file's BattleResults
/// (0x22) payload and attributed to the account that recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBattle {
    /// Unix seconds of the filename timestamp (the replay header carries no
    /// timestamp of its own; the client names the file with LOCAL battle
    /// start time).
    pub timestamp: i64,
    /// The same timestamp in the filename's raw `YYYYMMDD[_HHMMSS]` form —
    /// the display date the replay list already uses.
    pub date_time: String,
    /// Replay header fields: match group ("pvp" / "ranked" for the rows kept
    /// here), scenario name and battle-script id.
    pub match_group: Option<String>,
    pub scenario: Option<String>,
    pub event_type: Option<String>,
    /// GameParams ship id the recorder played (playersPublicInfo index 7).
    pub ship_id: Option<i64>,
    /// Team slot (index 6; 0/1 for the two battle sides).
    pub team: Option<i32>,
    /// `commonList[3]` (the winning team id) equals the recorder's team.
    /// `None` when either side is missing/out of the 0/1 range (a draw or a
    /// payload whose commonList carries no winner).
    pub won: Option<bool>,
    /// Battle damage dealt (index 426; legacy layout 411).
    pub damage: i64,
    /// Ships sunk (index 32).
    pub frags: i64,
    /// The recorder's ship was not destroyed (index 21).
    pub survived: bool,
    /// Settlement base XP (index 404; legacy layout 389) — absent when the
    /// payload's player array is too short for the field.
    pub exp: Option<i64>,
}

/// Reply of the `read_local_battle_log` command: the decoded battle rows plus
/// the scan telemetry the refresh pill uses to report progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBattleLog {
    /// Battles recorded by the requested account, in `[from_sec, to_sec]`,
    /// ascending by timestamp.
    pub battles: Vec<LocalBattle>,
    /// Replay files walked under every scan root this call.
    pub scanned: u32,
    /// Fresh full decodes that produced a battle row this call (cached ones
    /// are not decoded again).
    pub decoded: u32,
    /// In-window replay candidates answered from the persistent decode cache.
    pub cache_hits: u32,
    /// In-window candidates left undecoded because the per-call decode budget
    /// ran out — a later call continues from the persistent cache.
    pub pending: u32,
}
