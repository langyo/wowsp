//! Player-marker wire DTOs (玩家标记 — the LOCAL, user-built list).
//!
//! Strictly local data: the list lives only on the user's machine, is built
//! by hand (or from in-app row actions), and never leaves it — no upload,
//! no share, no sync. Marking colors are the user's personal judgments:
//! red = problematic player, yellow = suspected cheater, purple = suspected
//! hidden-stats veteran.

use serde::{Deserialize, Serialize};

/// The three marker colors and their meanings (the dot tooltip copies
/// these). Serialized lowercase everywhere (wire + markers.json).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkerColor {
    /// 有问题的玩家 (griefer / bot / toxic).
    Red,
    /// 疑似作弊玩家.
    Yellow,
    /// 疑似隐藏水表的大佬 (skilled player with a hidden profile).
    Purple,
}

/// One marked player. The NICKNAME is the key (the user adds players by
/// name — case-insensitive match against battle rosters); the account id
/// rides along when it was resolved at add time and sharpens the match
/// (rename-proof) when both sides know it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerEntry {
    pub nickname: String,
    pub color: MarkerColor,
    /// Optional free-form note (why this player is marked).
    #[serde(default)]
    pub note: Option<String>,
    /// Resolved account id when known (WG/Lesta/CN resolution all provide
    /// it); optional — nickname matching covers everything else.
    #[serde(default)]
    pub account_id: Option<i64>,
    /// Unix seconds of when the marker was added.
    #[serde(default)]
    pub created_at: i64,
}

// ── ApeRadar (海猴雷达) import ─────────────────────────────────────────────
// The old external tool (upstream zylalx1/ApeRadar, a C#/WPF app) kept its
// watch list ("特别关注名单") in %LOCALAPPDATA%\ApeRadar\WatchList.json as
// { "RU": { "<accountId>": { "name": …, "status": … } }, … }. The commands
// in app/tauri parse that file into these DTOs; the wizard maps statuses
// onto marker colors ("Negtive" → red, "Cheater" → yellow; "Positive" has
// no WoWSP counterpart and is offered as excluded).

/// One parsed watch-list entry: the JSON key was the account id (a string;
/// a non-numeric key parses to None) and the value carried the nickname
/// plus the raw status name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApeRadarWatchPlayer {
    pub account_id: Option<i64>,
    /// The roster nickname (the watch list always carried one).
    pub name: String,
    /// Raw ApeRadar status name — "Negtive", "Cheater" or "Positive";
    /// anything else stays verbatim and the wizard treats it as unknown.
    pub status: String,
}

/// One server block of the watch list ("RU" / "EU" / "NA" / "ASIA" /
/// "CN"), carrying only the well-formed entries (nameless rows are
/// dropped at parse time — the marker list is keyed by nickname).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApeRadarWatchServer {
    /// Upper-case server key exactly as ApeRadar wrote it.
    pub server: String,
    pub players: Vec<ApeRadarWatchPlayer>,
}

/// A parsed WatchList.json: the source path plus every server block that
/// held at least one entry (empty blocks are dropped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApeRadarWatchList {
    pub path: String,
    pub servers: Vec<ApeRadarWatchServer>,
}

/// One marker for the batch import command — the same per-item upsert
/// semantics as markers_add (an arriving account id replaces, a None keeps
/// the stored one), applied to a whole batch with ONE atomic write and
/// ONE change event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerImportItem {
    pub nickname: String,
    pub color: MarkerColor,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub account_id: Option<i64>,
}

/// The batch import's outcome: the refreshed full list (disk stays the
/// truth, exactly like markers_add's return) plus the per-item counters
/// the wizard's summary toast shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerImportResult {
    pub list: Vec<MarkerEntry>,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
}
