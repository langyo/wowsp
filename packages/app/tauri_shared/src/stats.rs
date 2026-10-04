use serde::{Deserialize, Serialize};

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
    /// Clan id the player belongs to, if any — the jump key from a player
    /// card to the clan view. `#[serde(default)]` keeps old cache files
    /// (written before this field existed) deserializable.
    #[serde(default)]
    pub clan_id: Option<i64>,

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
    /// Battle counts behind each division winrate (the split tooltips).
    /// `#[serde(default)]` keeps cache files written before these fields
    /// existed deserializable (same rationale as `clan_id`).
    #[serde(default)]
    pub solo_battles: Option<i64>,
    #[serde(default)]
    pub div2_battles: Option<i64>,
    #[serde(default)]
    pub div3_battles: Option<i64>,

    // ── Ranked (排位) career stats ──────────────────────────────────────
    /// Career ranked battles (rank_solo + rank_div2 + rank_div3 on the WG
    /// realms; the summed seasons tree on CN). Consumed by the Tab overlay's
    /// ranked stats source; None = never played ranked / hidden profile.
    #[serde(default)]
    pub ranked_battles: Option<i64>,
    /// Career ranked winrate, percent (0–100).
    #[serde(default)]
    pub ranked_winrate: Option<f32>,
    /// Average damage per ranked battle.
    #[serde(default)]
    pub ranked_avg_damage: Option<f32>,
    /// Community PR proxy over the ranked splits (same ApeRadar-style
    /// weighted-winrate formula as the overall `pr`).
    #[serde(default)]
    pub ranked_pr: Option<i64>,

    // ── Global (全局 = randoms + ranked merged) career stats ───────────
    /// Combined career battles (randoms + ranked). For an account that
    /// never played ranked this equals `battles`; None = hidden profile /
    /// no stats at all. Consumed by the stats-source "global" mode on the
    /// roster surfaces.
    #[serde(default)]
    pub global_battles: Option<i64>,
    /// Combined career winrate, percent (0–100) — the battles-weighted
    /// blend of the two modes.
    #[serde(default)]
    pub global_winrate: Option<f32>,
    /// Combined average damage per battle.
    #[serde(default)]
    pub global_avg_damage: Option<f32>,
    /// PR proxy over the two modes' division splits merged bucket-for-
    /// bucket (see the backend's `global_career_of`); None under the
    /// expected PR algorithm.
    #[serde(default)]
    pub global_pr: Option<i64>,

    /// Unix time of the account's last finished battle (WG account/info's
    /// `last_battle_time`). The roster batch uses it to arbitrate
    /// same-nickname accounts across realms in cross-server Clan Battles
    /// (the roster player is in a battle RIGHT NOW, so their previous one
    /// ended within the session); `#[serde(default)]` keeps older cache
    /// files deserializable, and the CN arm leaves it None.
    #[serde(default)]
    pub last_battle_time: Option<i64>,
}

/// One player name suggestion from the WG account/list autocomplete
/// (live search-as-you-type in the lookup sidebar).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSuggestion {
    pub account_id: i64,
    pub nickname: String,
}

/// 空中小人/水下小人 verdict for one player (Tab overlay seals). Thresholds
/// mirror the frontend compositionStamps() (packages/webui/src/utils/winrate.ts):
/// career battles must exceed 200 and the class share must exceed 20%
/// (strictly greater on both bounds) — see
/// `commands::wg_composition::composition_verdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayerComposition {
    pub air: bool,
    pub sub: bool,
}

/// One clan suggestion from the WG clans/list autocomplete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanSuggestion {
    pub clan_id: i64,
    /// Short clan tag (rendered as [TAG]).
    pub tag: String,
    /// Full clan name.
    pub name: String,
    pub members_count: Option<i64>,
}

/// Per-member PvP summary inside a clan roster — the same deep-stat set the
/// player card shows, minus the per-ship table (that stays on the player
/// page; it would need one WG request per member). Hidden profiles yield
/// `hidden=true` with all stats None.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClanMemberStats {
    pub battles: Option<i64>,
    pub wins: Option<i64>,
    /// Winrate, percent (0–100).
    pub winrate: Option<f32>,
    pub avg_damage: Option<f32>,
    /// Community PR proxy (same formula as the player card; CN rosters
    /// expose no division splits, so there it falls back to the overall
    /// winrate).
    pub pr: Option<i64>,
    pub avg_xp: Option<f32>,
    pub kd_ratio: Option<f32>,
    /// Survival rate, percent (0–100).
    pub survival_rate: Option<f32>,
    pub hidden: bool,
}

/// One clan member (roster row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanMember {
    pub account_id: i64,
    /// Player nickname (resolved via a batched account/info call).
    pub name: String,
    /// WG role key: commander / executive_officer / recruitment_officer /
    /// private / … (mapped to a label on the frontend).
    pub role: String,
    /// Join timestamp, epoch seconds.
    pub joined_at: Option<i64>,
    pub stats: ClanMemberStats,
}

/// Clan overview card: WG clans/info metadata + the roster with per-member
/// PvP stats (names and stats resolved in ONE batched account/info call —
/// members ≤ 50, and the endpoint accepts up to 100 ids per request).
/// Aggregate fields are computed across visible (non-hidden) members.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanInfo {
    pub clan_id: i64,
    pub tag: String,
    pub name: String,
    /// Realm the lookup hit: ru / eu / na / asia.
    pub realm: String,
    pub description: Option<String>,
    pub members_count: i64,
    /// Clan creation timestamp, epoch seconds.
    pub created_at: Option<i64>,
    pub members: Vec<ClanMember>,
    /// Sum over visible members.
    pub total_battles: i64,
    /// Sum over visible members.
    pub total_wins: i64,
    /// total_wins / total_battles, percent (0–100). 0 when no visible stats.
    pub winrate: f32,
    /// Sum of damage / total_battles (community-style clan average).
    pub avg_damage: f32,
    /// Mean PR proxy across visible members that have one (None when no
    /// visible member has stats).
    pub avg_pr: Option<i64>,
    /// Members whose profile is hidden (no PvP stats).
    pub hidden_count: i64,
}
