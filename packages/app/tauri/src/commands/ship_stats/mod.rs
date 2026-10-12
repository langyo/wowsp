//! Per-player per-ship stats + career stat snapshots (milestone M10).
//!
//! Two concerns:
//!   1. The vortex per-mode ships endpoints — the player's stats broken
//!      down by ship and battle type (see [`fetch_ship_stats`]). Cached to
//!      `ship-stats/<realm>_<accountId>.json`. Ship names are back-filled
//!      from the encyclopedia cache when available.
//!   2. Snapshots — on each account-level lookup we append a timestamped
//!      career-summary point to `snapshots/<realm>_<accountId>.json`. This
//!      time series is what the trends module buckets by game version.

// ── module layout ───────────────────────────────────────────────────────────
// `lookup`  — the per-ship stats command + the session cache/single-flight.
// `history` — per-ship history points + career snapshots (persistence).
// `stream`  — the dual-path fetch (vortex + official racer), streaming bodies.
// `scanner` — the incremental JSON container scanner behind partial rows.
// `raw`     — RawShipStats parsing (vortex/WG dialects) + the name map.
// `tests`   — the unit suite (moved with the code it tests).

mod history;
mod lookup;
mod raw;
mod scanner;
mod stream;

#[cfg(test)]
mod tests;

// Sibling command modules reached by this module's children through their
// unchanged `super::<name>::...` paths (this facade re-exports the names one
// level down, so every call site kept its original text).
pub(crate) use super::{appdata, trends, upstream_health, wg_api, wg_api_cn, wg_realm};

// Tauri command surface. `generate_handler!` in `src/lib.rs` resolves both the
// command fn and its doc(hidden) sibling macros (`__cmd__*` /
// `__tauri_command_name_*`) through `commands::ship_stats::*`, exactly like
// `commands/mod_hub/mod.rs` — so those paths are re-exported verbatim.
pub use history::{
    __cmd__read_ship_stats_history, __cmd__snapshot_player_stats,
    __tauri_command_name_read_ship_stats_history, __tauri_command_name_snapshot_player_stats,
    read_ship_stats_history, snapshot_player_stats,
};
pub use lookup::{
    __cmd__lookup_player_ship_stats, __tauri_command_name_lookup_player_ship_stats,
    lookup_player_ship_stats,
};

// pub(crate) surface consumed through direct `ship_stats::...` paths by
// sibling command modules (trends / wg_api / wg_composition; call sites
// unchanged).
pub(crate) use history::read_snapshots;
pub(crate) use lookup::{clear_ship_stats_session_cache, fetch_expected_pr_rows};

// ── shared helpers (same pattern as encyclopedia.rs) ─────────────────────

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
