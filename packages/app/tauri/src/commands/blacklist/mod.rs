//! Blacklist sync — a read-only mirror of the signed-in account's in-game
//! blacklist, fed by the WG / Lesta OpenID login.
//!
//! Endpoints (hosts from `wg_realm::api_host`; realm "ru" is the Lesta
//! cluster on api.korabli.su with paths under /mk, the international realms
//! go through Wargaming's /wgn):
//!   login    GET https://<host>/<wgn|mk>/auth/login/?application_id=..
//!            &redirect_uri=http://127.0.0.1:<port>/callback&expires_at=<unix>
//!            -> the portal redirects with
//!              status=ok&access_token=..&expires_at=..&account_id=..&nickname=..
//!   pull     GET https://<host>/wows/account/info/?application_id=..&account_id=<self>
//!            &extra=private.grouped_contacts&fields=private.grouped_contacts
//!            with the token in the Authorization: Bearer header — the private
//!            block only exists for the token's own account, so a synced
//!            blacklist is always and only the USER's own; keeping the token
//!            out of the URL also keeps it out of reqwest error displays and
//!            the upstream-health failure strings (a query-string token would
//!            leak into both).
//!   sweep    GET https://<host>/wows/account/info/?application_id=..&account_id=<ids csv>
//!            &fields=nickname  (public, no token; <=100 ids per request)
//!
//! The CN cluster has no public API at all (see `wg_realm`), so realm "cn"
//! is rejected by every command here and the webui hides the section.
//!
//! Files under the appdata root (settings-store conventions):
//!   blacklist-auth.toml    the OpenID credential — LOCAL ONLY (§7): the
//!                          token never crosses the IPC boundary or a log line
//!   blacklist-sync.json    the last successful snapshot (entries + metadata)
//!   blacklist-config.toml  auto-sync knobs (enabled + interval)
//!
//! Read-only by design: the public API has no blacklist write method, and
//! the game stays the source of truth — every sync replaces the snapshot
//! wholesale, so the game's own contact churn (e.g. deleted accounts being
//! auto-unblocked) reconciles itself on the next pull. Token renewal
//! (auth/prolongate) is future work; a two-week-old login simply re-runs
//! the login flow when the next sync reports the token expired.

mod auth;
mod sync;

#[cfg(test)]
mod tests;

pub use auth::{
    __cmd__blacklist_auth_cancel, __cmd__blacklist_auth_forget, __cmd__blacklist_auth_start,
    __cmd__blacklist_auth_state, __tauri_command_name_blacklist_auth_cancel,
    __tauri_command_name_blacklist_auth_forget, __tauri_command_name_blacklist_auth_start,
    __tauri_command_name_blacklist_auth_state, blacklist_auth_cancel, blacklist_auth_forget,
    blacklist_auth_start, blacklist_auth_state,
};
pub use sync::{
    __cmd__blacklist_load_config, __cmd__blacklist_save_config, __cmd__blacklist_snapshot,
    __cmd__blacklist_sync_now, __tauri_command_name_blacklist_load_config,
    __tauri_command_name_blacklist_save_config, __tauri_command_name_blacklist_snapshot,
    __tauri_command_name_blacklist_sync_now, blacklist_load_config, blacklist_save_config,
    blacklist_snapshot, blacklist_sync_now,
};
