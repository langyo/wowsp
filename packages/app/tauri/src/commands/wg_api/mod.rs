//! Wargaming / Lesta Public API client (milestone M9).
//!
//! Looks up a player by name on a given realm and returns a compact stats
//! summary (battles, winrate, hidden flag, clan tag). The application_id is
//! the well-known public WG app id (same one ApeRadar ships — it is meant for
//! client-side use and rate-limited per IP, not secret); the Lesta-run RU
//! cluster needs its own id, both resolved by `wg_realm::application_id`.
//!
//! Endpoints (per realm, hosts from `wg_realm::api_host` — realm "ru" targets
//! the Lesta API on korabli.su since api.worldofwarships.ru 301s to the EU
//! API root and answers METHOD_NOT_FOUND for every method):
//!   list    GET https://<api_host>/wows/account/list/?application_id=..&search=<name>
//!   stats   GET https://<api_host>/wows/account/info/?application_id=..&account_id=<id>
//!           &extra=statistics.pvp_solo,statistics.pvp_div2,statistics.pvp_div3,
//!                  statistics.rank_solo,statistics.rank_div2,statistics.rank_div3
//!           (the division splits and the ranked splits are extra-gated —
//!           unrequested nodes are omitted from the response entirely)
//!   clan    GET https://<api_host>/wows/clans/accountinfo/?application_id=..&account_id=<id>
//!   clans   GET https://<api_host>/wows/clans/list/?application_id=..&search=<tag|name>
//!   claninfo GET https://<api_host>/wows/clans/info/?application_id=..&clan_id=<id>&extra=members
//!
//! Realm → host suffix: ru→korabli.su (Lesta), eu→eu, na→com, asia→asia.
//! The cn realm (wowsgame.cn, 360-operated) has no WG public API — every
//! command below routes realm "cn" to the vortex-based `wg_api_cn` module
//! instead of the shared host resolution.
//!
//! The two INTERACTIVE commands (`lookup_player_stats` / `lookup_clan_info`)
//! reject with the structured [`super::lookup_error::LookupError`] payload —
//! the lookup UI localizes "not found" per kind and surfaces the official
//! error message — while the batch/suggest commands keep plain `String`
//! errors (their consumers render "no data", never a reason). `From<String>`
//! bridges the shared plumbing into the structured type.

// ── module layout ───────────────────────────────────────────────────────────
// `roster`      — player stats lookups + the live-roster batch (session cache,
//                 name/id resolution, cross-server Clan-Battles probes).
// `clans`       — clan lookups, the autocomplete pair, member roster assembly.
// `shared`      — request plumbing: query encoding, nickname verification,
//                 one-shot account helpers, WG text/dog-tag parsing, wire DTOs.
// `stats_math`  — PvpStats extraction, the PR proxy family, PrAlgo, expected PR.
// `tests`       — the unit suite (moved with the code it tests).

mod clans;
mod roster;
mod shared;
mod stats_math;

#[cfg(test)]
mod tests;

// Sibling command modules reached by this module's children through their
// unchanged `super::<name>::...` paths (this facade re-exports the names one
// level down, so every call site kept its original text).
pub(crate) use super::{lookup_error, ship_stats, trends, upstream_health, wg_api_cn, wg_realm};

// Tauri command surface. `generate_handler!` in `src/lib.rs` resolves both the
// command fn and its doc(hidden) sibling macros (`__cmd__*` /
// `__tauri_command_name_*`) through `commands::wg_api::*`, exactly like
// `commands/mod_hub/mod.rs` — so those paths are re-exported verbatim.
pub use clans::{
    __cmd__lookup_clan_info, __cmd__suggest_clans, __cmd__suggest_players,
    __tauri_command_name_lookup_clan_info, __tauri_command_name_suggest_clans,
    __tauri_command_name_suggest_players, lookup_clan_info, suggest_clans, suggest_players,
};
pub use roster::{
    __cmd__clear_roster_stats_cache, __cmd__lookup_player_stats, __cmd__lookup_players_stats_batch,
    __tauri_command_name_clear_roster_stats_cache, __tauri_command_name_lookup_player_stats,
    __tauri_command_name_lookup_players_stats_batch, clear_roster_stats_cache, lookup_player_stats,
    lookup_players_stats_batch,
};

// pub(crate) surface consumed through direct `wg_api::...` paths by sibling
// command modules (ingame_bridge / ship_stats / wg_composition / wg_api_cn;
// call sites unchanged).
pub(crate) use clans::clan_suggestion_of;
pub(crate) use roster::{
    apply_batch_pr_algo, lookup_roster, roster_cache_get, roster_cache_insert,
};
pub(crate) use shared::{
    account_list_one, decode_wg_text, encode_query, nickname_matches, parse_dog_tag,
};
pub(crate) use stats_math::{
    ExpectedPrRow, PrAlgo, PvpStats, account_expected_pr_for, compute_pr, expected_ship_pr,
    rating_from_winrate,
};
