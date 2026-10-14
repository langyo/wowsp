//! Replay-share contribution DTOs (commands/contribution/ ↔ webui
//! api/modules/contribution.ts). Wire truth is CONTRACT-replay-share.md —
//! the shapes here mirror §1 (wanted ruleset), §2 (replay facts), §4
//! (personal routes) and §9 (the Rust command surface) verbatim; every
//! camelCase field name is the IPC/HTTP spelling both sides pin.

use serde::{Deserialize, Serialize};

/// Progress channel the background share pipeline narrates its queue
/// snapshot on (the mirror of `wowsp://download-progress`).
pub const CONTRIBUTION_PROGRESS_EVENT: &str = "wowsp://contribution-progress";

/// The five realm codes the identity picker and every realm-carrying wire
/// field accept (canonical lowercase — contract §2/§3).
pub const REALMS: [&str; 5] = ["ru", "eu", "na", "asia", "cn"];

/// The ship-class spellings a facts claim may carry (contract §2); `null`
/// means "unknown / not claimed".
pub const SHIP_CLASSES: [&str; 5] = [
    "AirCarrier",
    "Battleship",
    "Cruiser",
    "Destroyer",
    "Submarine",
];

/// Queue stage names (contract §9) — plain `&'static str` consts so the
/// wire stays a JSON string, same style as `download::phase`.
pub mod stage {
    pub const IDLE: &str = "idle";
    pub const PLAN: &str = "plan";
    pub const CHECK: &str = "check";
    pub const MINE: &str = "mine";
    pub const PACK: &str = "pack";
    pub const UPLOAD: &str = "upload";
    pub const DONE: &str = "done";
    pub const ERROR: &str = "error";
}

/// Self-declared contributor identity (no account binding): one of the
/// five realm codes plus the credited nickname (3..=24 chars, no control
/// characters — validated on the Rust side before it may be saved).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionIdentity {
    pub realm: String,
    pub name: String,
}

/// The collection watermark (contract §1): bytes currently staged across
/// all contributors against the plan's total budget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub staged_bytes: u64,
    pub limit_bytes: u64,
    pub accepting: bool,
}

/// One server-authoritative acceptance rule. Absent or empty arrays mean
/// "any" for that dimension (the matcher mirrors this exactly); `max_count`
/// absent = unlimited; `collected` counts distinct accepted replays ever
/// matched to the rule so drain never reopens a closed rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WantedRule {
    /// Matches `^[a-z0-9-]{1,64}$` (server-enforced; mirrored client-side
    /// for defensive display only).
    pub id: String,
    #[serde(default)]
    pub collected: u64,
    #[serde(default)]
    pub max_count: Option<u64>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub maps: Vec<String>,
    /// Canonical match-group keys (`standard` etc. — the same strings the
    /// replay list filter uses).
    #[serde(default)]
    pub modes: Vec<String>,
    #[serde(default)]
    pub scenarios: Vec<String>,
    #[serde(default)]
    pub realms: Vec<String>,
    #[serde(default)]
    pub ship_classes: Vec<String>,
    #[serde(default)]
    pub ship_ids: Vec<i64>,
    #[serde(default)]
    pub tiers: Vec<u8>,
    #[serde(default)]
    pub player_count_min: Option<u32>,
    #[serde(default)]
    pub player_count_max: Option<u32>,
    #[serde(default)]
    pub bot_max: Option<u32>,
    /// Dot-numeric lower bound (`14.5.0` ≥ `14.0` — component-wise
    /// numeric compare, missing components counting as 0).
    #[serde(default)]
    pub client_version_min: Option<String>,
}

/// The cached `GET /api/replays/wanted` document (absent/empty rules =
/// collection CLOSED).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WantedDoc {
    pub ruleset_version: u32,
    /// Null while the collection is closed (no KV ruleset) or the ruleset
    /// omits the stamp — the server serializes the absence explicitly.
    #[serde(default)]
    pub updated_at: Option<String>,
    pub watermark: Watermark,
    #[serde(default)]
    pub rules: Vec<WantedRule>,
}

/// One of the contributor's currently staged replays (`GET /mine`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedEntry {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
}

/// The cached `GET /api/replays/mine` document; a fresh contributor (404)
/// heals to the empty shape.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MineDoc {
    pub staged: Vec<StagedEntry>,
    pub archive_bytes: u64,
    pub credit_count: u32,
}

/// The per-replay claim minus the three identity/size fields the upload
/// manifest member carries alongside (contract §4 spells the embedded
/// facts as "ReplayFacts without sha256/fileName/sizeBytes").
///
/// Nullability mirrors the contract Â§2 wire exactly: scenario, shipClass
/// and tier may be null; map/mode/realm are required strings (a claim that
/// cannot fill them fails plausibility and never leaves the client);
/// ownShipId is a plain number; clientVersion/battleTime are strings where
/// the empty value means "unknown" (the server tolerates empty and its
/// matcher then fails any version bound).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFactsCore {
    /// The client's `mapDisplayName` spelling (the replay list filter key).
    pub map: String,
    /// Canonical match-group key (`standard` etc.).
    pub mode: String,
    pub scenario: Option<String>,
    pub realm: String,
    pub own_ship_id: u64,
    pub ship_class: Option<String>,
    pub tier: Option<u8>,
    pub player_count: u32,
    pub bot_count: u32,
    /// Empty = unknown (a rule bounding the version then cannot match).
    pub client_version: String,
    /// RFC3339 UTC; empty = undatable file name.
    pub battle_time: String,
}

/// Client-claimed per-replay facts (contract §2). `#[serde(flatten)]`
/// keeps the §2 wire shape flat (sha256/fileName/sizeBytes + the core
/// fields) while [`ReplayFactsCore`] alone embeds into manifest members.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFacts {
    /// 64 lowercase hex chars.
    pub sha256: String,
    /// ≤128 chars, path-free.
    pub file_name: String,
    /// Plausibility window 1024..=67108864.
    pub size_bytes: u64,
    #[serde(flatten)]
    pub core: ReplayFactsCore,
}

/// Share-plan verdict for one candidate (contract §4 precedence:
/// duplicate > own_staged > accept > unwanted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionVerdict {
    Accept,
    OwnStaged,
    Duplicate,
    Unwanted,
}

/// One planner input row: the webui enriches the ship class/tier from its
/// ship catalog (the replay header carries only the ship id), Rust reads
/// everything else off the file itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCandidate {
    pub path: String,
    #[serde(default)]
    pub ship_class: Option<String>,
    #[serde(default)]
    pub tier: Option<u8>,
}

/// One planner output row (verdict-merged: known-hash cache, cached mine
/// set, and the wanted-ruleset match).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub facts: ReplayFacts,
    pub verdict: ContributionVerdict,
    #[serde(default)]
    pub rule_id: Option<String>,
    pub file_name: String,
}

/// Per-item terminal outcome of a started share run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueOutcome {
    Accepted,
    Duplicate,
    Unwanted,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueResult {
    pub sha256: String,
    pub file_name: String,
    pub outcome: QueueOutcome,
}

/// The queue snapshot both `contribution_queue` and every
/// `wowsp://contribution-progress` event carry (contract §9). `stage` uses
/// the [`stage`] string consts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub running: bool,
    pub stage: String,
    pub total_items: u32,
    pub done_items: u32,
    pub total_bytes: u64,
    pub current_bytes: u64,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub results: Vec<QueueResult>,
}

impl Default for QueueSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            stage: stage::IDLE.to_string(),
            total_items: 0,
            done_items: 0,
            total_bytes: 0,
            current_bytes: 0,
            message: None,
            results: Vec::new(),
        }
    }
}

/// The settings' status-card view of the local share state (contract §9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionState {
    pub identity: Option<ContributionIdentity>,
    #[serde(default)]
    pub consent_version: Option<u32>,
    #[serde(default)]
    pub anon_id: Option<String>,
    pub has_upload_token: bool,
    #[serde(default)]
    pub credit_count: u32,
    #[serde(default)]
    pub staged_count: u32,
    #[serde(default)]
    pub staged_bytes: u64,
    #[serde(default)]
    pub last_sync_at: Option<String>,
}
