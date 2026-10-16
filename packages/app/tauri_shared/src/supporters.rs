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
