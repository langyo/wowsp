//! Player markers (玩家标记) — the LOCAL, user-built list of players the
//! user marks with one of three colors (red = 有问题的玩家, yellow = 疑似
//! 作弊玩家, purple = 疑似隐藏水表的大佬). The list is strictly local: no
//! account login, no server sync, no upload. The former WG/Lesta OpenID
//! pipeline was removed — the WG portals dropped their public login API
//! (METHOD_NOT_FOUND probed 2026-10-26 on every international gateway) and
//! the CN cluster never had one; see tauri_shared::markers for the color
//! semantics.
//!
//! File under the appdata root:
//!   markers.json    the local list (data-cache JSON convention)
//!
//! Matching is by NICKNAME (unicode case-insensitive, the roster's exact
//! name) with an optional account-id sharpening — so the markers work on
//! EVERY realm (including CN, whose stats route through the vortex
//! endpoints) with no login anywhere.
//!
//! The cloud sub-module (cloud.rs) layers an AUTOMATIC yellow match on
//! top: CN rosters queried against the yuyuko community ban list are
//! merged into the markers_list wire view with source = "cloud" — never
//! written to markers.json, always losing to a local entry.

mod aperadar;
mod cloud;
mod store;

#[cfg(test)]
mod tests;

pub use aperadar::{
    __cmd__aperadar_watchlist_pick, __cmd__aperadar_watchlist_read, __cmd__aperadar_watchlist_scan,
    __tauri_command_name_aperadar_watchlist_pick, __tauri_command_name_aperadar_watchlist_read,
    __tauri_command_name_aperadar_watchlist_scan, aperadar_watchlist_pick, aperadar_watchlist_read,
    aperadar_watchlist_scan,
};
pub use cloud::{
    __cmd__cloud_ban_check, __cmd__cloud_ban_dismiss, __cmd__cloud_ban_get_config,
    __cmd__cloud_ban_list, __cmd__cloud_ban_set_config, __tauri_command_name_cloud_ban_check,
    __tauri_command_name_cloud_ban_dismiss, __tauri_command_name_cloud_ban_get_config,
    __tauri_command_name_cloud_ban_list, __tauri_command_name_cloud_ban_set_config,
    cloud_ban_check, cloud_ban_dismiss, cloud_ban_get_config, cloud_ban_list, cloud_ban_set_config,
};
pub use store::{
    __cmd__markers_add, __cmd__markers_import, __cmd__markers_list, __cmd__markers_remove,
    __tauri_command_name_markers_add, __tauri_command_name_markers_import,
    __tauri_command_name_markers_list, __tauri_command_name_markers_remove, markers_add,
    markers_import, markers_list, markers_remove,
};
