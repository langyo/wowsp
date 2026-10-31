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

/// Where a wire marker row came from: the user's own local judgment, or an
/// automatic match against the cloud ban list (yuyuko, CN-only — see
/// commands/markers/cloud.rs). Only the merged wire view ever sets Cloud;
/// markers.json never persists a source, so an absent value always means a
/// plain local entry (#[serde(default)] keeps old files loading).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkerSource {
    Local,
    Cloud,
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
    /// Provenance on the WIRE view only: Some(Cloud) when this row is an
    /// automatic cloud-ban match merged into markers_list. Never persisted
    /// (markers.json stays purely local) and never serialized for local
    /// entries, so existing files and wire payloads are byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MarkerSource>,
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

// ── Cloud ban-list matches (云端封禁名单) ────────────────────────────────────
// The yuyuko community service (wows.shinoaki.com, the API behind
// wows.mgaia.top/#/banLike) answers a per-account ban-history query; a
// record whose namesake count is exactly 1 marks the player as a SUSPECTED
// banned cheater — mapped onto the yellow marker (疑似作弊). Strictly a
// read-only cloud lookup: nothing is uploaded, matches are cached locally
// and merged into the markers_list wire view only (see
// commands/markers/cloud.rs for the whole pipeline).

/// One ban record from the cloud list (yuyuko's voList item, field names
/// verbatim from the wire: BanName / UserName / BanTime / RecordTime /
/// BanNameNamesake).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBanRecord {
    /// The officially published banned name (官方公布的封禁名).
    #[serde(default)]
    pub ban_name: Option<String>,
    /// A historical username the service saw for this identity.
    #[serde(default)]
    pub user_name: Option<String>,
    /// The ban date as the service reports it (preformatted string).
    #[serde(default)]
    pub ban_time: Option<String>,
    /// When the service recorded this entry (preformatted string).
    #[serde(default)]
    pub record_time: Option<String>,
    /// How many usernames share the ban name — exactly 1 is the service's
    /// own "matched" signal (see wowsCheaterViewer's reading of the API).
    #[serde(default)]
    pub namesake: i64,
}

/// One cached cloud-ban answer, keyed by account id in ban-list.json.
/// Negative answers are cached too (a clean player stays clean for the
/// cache TTL, so a battle never re-bills the community service).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBanEntry {
    pub account_id: i64,
    /// The roster nickname the player carried when last queried (the
    /// merged marker row matches by BOTH nickname and id, mirroring the
    /// local-entry contract).
    pub nickname: String,
    /// Whether the answer was a match (any record with namesake == 1).
    pub matched: bool,
    /// Every record the service returned (the tooltip lists them).
    pub records: Vec<CloudBanRecord>,
    /// Unix seconds of the query that produced this entry.
    pub fetched_at: i64,
}

/// Wire view of one MATCHED player for the settings list (tooltip details
/// + the dismiss state) — composed from the cache at read time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBanMatch {
    pub account_id: i64,
    pub nickname: String,
    /// Always true here — unmatched entries never reach the wire list.
    pub matched: bool,
    /// Whether the user dismissed this cloud match locally (a dismissed
    /// match leaves the merged marker list until undone).
    pub dismissed: bool,
    pub records: Vec<CloudBanRecord>,
    pub fetched_at: i64,
}

/// One roster player passed to cloud_ban_check — the arena row's id+name
/// pair (the id is the query key, the nickname seeds the cache entry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBanPlayer {
    pub account_id: i64,
    pub nickname: String,
}

/// cloud_ban_check's outcome — counters for logging/diagnostics; the UI
/// rides the markers-changed event instead of the numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBanCheckResult {
    /// True when the feature is off / the realm is not CN / nothing to
    /// do / another check is already in flight (the busy gate).
    pub skipped: bool,
    /// How many ids actually went over the wire.
    pub queried: usize,
    /// Whether the cache changed (and the markers-changed event fired).
    pub changed: bool,
}

/// The ban-list toggle (ban-list.toml projection).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBanConfig {
    pub enabled: bool,
}
