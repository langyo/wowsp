use serde::{Deserialize, Serialize};

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
