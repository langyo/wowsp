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
