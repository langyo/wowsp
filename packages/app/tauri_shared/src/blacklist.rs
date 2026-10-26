//! Blacklist-sync wire DTOs (WG / Lesta OpenID login + the
//! `private.grouped_contacts.blocked` pull).
//!
//! The sync is strictly READ-ONLY: it mirrors the signed-in account's own
//! in-game blacklist into a local snapshot that the webui can render (the
//! settings list) and match against battle rosters (the ship-marker dot).
//! There is no write path by design — the public API exposes none.

use serde::{Deserialize, Serialize};

/// Which API family the credentials belong to. `ru` is the Lesta-run
/// cluster (api.korabli.su, `/mk/**` + Lesta app id); every other synced
/// realm is Wargaming (`/wgn/**`). The CN cluster has no public API and
/// never participates in this feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlacklistPlatform {
    Wargaming,
    Lesta,
}

impl BlacklistPlatform {
    /// Lowercase wire tag, also used in log fields and snapshot files.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wargaming => "wargaming",
            Self::Lesta => "lesta",
        }
    }
}

/// Credential state for one realm, as the settings page renders it. The
/// access token itself never crosses back over the IPC boundary — only its
/// expiry (the settings page shows "re-login due" from this).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistAuthState {
    /// The realm the QUESTION was asked about (not the bound one).
    pub realm: String,
    pub platform: Option<BlacklistPlatform>,
    /// True only when the stored credentials belong to THIS realm and the
    /// token has not expired yet.
    pub logged_in: bool,
    pub account_id: Option<i64>,
    pub nickname: Option<String>,
    /// Unix seconds; `None` when not logged in.
    pub expires_at: Option<i64>,
}

/// One blocked player from the synced snapshot. `nickname` is `None`
/// when the batch resolution sweep could not answer for the id (transient
/// API failure) — the UI renders the bare id then.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistEntry {
    pub account_id: i64,
    #[serde(default)]
    pub nickname: Option<String>,
}

/// The synced mirror of one realm's in-game blacklist, persisted as JSON
/// under the appdata root (`blacklist-sync.json`) and served to the webui
/// verbatim. The game remains the source of truth: every sync REPLACES the
/// entries wholesale, and the game's own auto-unblocking (deleted/banned
/// accounts disappearing from contacts) simply shows up as removals on the
/// next pull.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistSnapshot {
    pub realm: String,
    pub platform: BlacklistPlatform,
    /// The account whose blacklist was pulled (the OpenID identity).
    pub account_id: i64,
    pub nickname: Option<String>,
    /// Unix seconds of the last successful pull.
    pub last_synced_at: i64,
    pub entries: Vec<BlacklistEntry>,
    /// Ids the nickname sweep could not resolve this run (they keep any
    /// previously-known nickname inside `entries`; this counter is for the
    /// settings page's "N not resolved" note).
    pub unresolved: usize,
}

/// Outcome of one sync run — the settings page's per-run feedback line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistSyncReport {
    pub realm: String,
    pub ok: bool,
    pub fetched: usize,
    /// Entries whose nickname resolved (may include names carried over
    /// from a previous snapshot; see `BlacklistSnapshot::unresolved`).
    pub resolved: usize,
    /// Human-readable failure reason when `ok == false`.
    #[serde(default)]
    pub message: Option<String>,
}

/// User-tunable sync knobs (`blacklist-config.toml`, settings-store
/// conventions apply: tolerant parse, healed defaults).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlacklistSyncConfig {
    /// Pull automatically while the app runs. The schedule lives in the
    /// webui (one timer per app lifetime); the backend only records the
    /// preference and clamps the interval.
    pub auto_sync: bool,
    /// Hours between automatic pulls. Clamped to 1..=168 on load.
    pub interval_hours: u32,
}

impl Default for BlacklistSyncConfig {
    fn default() -> Self {
        Self {
            auto_sync: true,
            interval_hours: 24,
        }
    }
}
