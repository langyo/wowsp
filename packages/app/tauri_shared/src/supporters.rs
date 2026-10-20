use serde::{Deserialize, Serialize};

/// One supporter's Bilibili avatar resolution (About page's
/// special-thanks cards, `commands/supporters.rs`): `face` is the live or last-cached
/// avatar URL; `None` when neither exists — the frontend then renders
/// the initial-letter fallback.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupporterAvatar {
    pub uid: u64,
    pub face: Option<String>,
}

/// One row of the afdian sponsor list (`commands/supporters.rs` —
/// mirrors the relay worker's public document verbatim; the ordering —
/// current-month paid, then all-time paid, then earliest first payment —
/// is decided server-side and preserved as-is).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SponsorEntry {
    pub user_id: String,
    pub name: String,
    /// https afdian CDN URL, or null (initial-letter fallback).
    pub avatar: Option<String>,
    /// All-time actually-charged total, CNY.
    pub all_sum: f64,
    /// Actually-charged total inside the current calendar month, CNY.
    pub month_sum: f64,
    /// A monthly plan was live when the relay last polled.
    pub active: bool,
    /// Unix seconds.
    pub first_pay: i64,
    /// Unix seconds.
    pub last_pay: i64,
    /// Game ID recognized in an order remark. DORMANT: still served by
    /// the relay, but the UI's chip-to-lookup jump is parked; kept so
    /// re-enabling needs no wire change. Null when no remark carried one.
    pub game_id: Option<String>,
}

/// The sponsor-list document served by the relay's `/api/sponsors`
/// (plus the AppData last-good cache of it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SponsorListDoc {
    /// Unix seconds of the relay poll that produced the document.
    pub updated_at: i64,
    pub sponsors: Vec<SponsorEntry>,
}
