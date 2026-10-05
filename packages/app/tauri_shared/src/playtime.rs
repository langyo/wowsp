//! Playtime DTOs (commands/playtime.rs → client.ts `PlaytimeOverview`).
//!
//! The tracker watches the running WoWS client (via the session poller's
//! 3 s heartbeat), records per-session/per-day playtime locally, and — on
//! the very first run, when no ledger exists yet — seeds the career TOTAL
//! from the Steam client's own recorded hours when the game came from
//! Steam. The per-day series always stays local: Steam only exposes a
//! career total, never its distribution, so the imported backlog rides a
//! separate field the UI footnotes instead of inventing daily buckets.

use serde::{Deserialize, Serialize};

/// Where the historical total came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaytimeSource {
    /// Local tracking only — no external source was found (non-Steam
    /// client, or the Steam lookup came up empty).
    Local,
    /// The career total was seeded from the Steam client's own recorded
    /// playtime at first run.
    Steam,
}

/// One local calendar day's playtime (`YYYY-MM-DD` → seconds). Days without
/// any playtime are simply absent from the series.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytimeDay {
    pub date: String,
    pub seconds: u64,
}

/// The most recent (or currently running) game launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytimeLaunch {
    /// Unix seconds when the client process started.
    pub start: i64,
    /// Seconds from the start to the last heartbeat (to the process exit
    /// when the launch already finished).
    pub duration_seconds: u64,
    /// True while the client process is still alive (the duration keeps
    /// growing).
    pub running: bool,
}

/// The playtime page's full data payload: career totals (imported backlog
/// included), record statistics computed from the local sessions, and the
/// local per-day series for the trend chart and the heatmap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytimeOverview {
    pub source: PlaytimeSource,
    /// Undated backlog imported at first run (Steam's recorded hours).
    /// Counts toward `total_seconds` only — never toward `daily`.
    pub imported_total_seconds: u64,
    /// Unix seconds when the import happened (absent without an import).
    pub imported_at: Option<i64>,
    /// Sum of the locally tracked sessions.
    pub local_total_seconds: u64,
    /// `local_total_seconds + imported_total_seconds`.
    pub total_seconds: u64,
    /// Observed game launches (local tracking only — an imported backlog
    /// carries no launch history).
    pub launch_count: u64,
    /// Local days with any playtime.
    pub days_played: u64,
    /// First local day with playtime (`YYYY-MM-DD`).
    pub first_tracked_day: Option<String>,
    /// Longest run of consecutive local days with playtime.
    pub longest_streak_days: u64,
    /// Inclusive bounds of that streak (present iff `longest_streak_days > 0`).
    pub longest_streak_start: Option<String>,
    pub longest_streak_end: Option<String>,
    /// Longest single client session (start → exit).
    pub longest_session_seconds: u64,
    /// Local day that session started on.
    pub longest_session_date: Option<String>,
    /// Longest single local day total.
    pub longest_day_seconds: u64,
    pub longest_day_date: Option<String>,
    /// Most recent (or currently running) launch.
    pub last_launch: Option<PlaytimeLaunch>,
    /// Local per-day series, ascending by date, days with playtime only.
    pub daily: Vec<PlaytimeDay>,
}
