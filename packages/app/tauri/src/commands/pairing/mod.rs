//! Mobile ↔ desktop pairing: LAN replay acquisition + game-data sync.
//!
//! Two roles live in this module:
//!
//! - **SERVER (desktop only, `#[cfg(desktop)]`)** — a deliberately tiny
//!   hand-rolled HTTP/1.1 server on the existing tokio runtime. The phone
//!   picks the desktop from the live discovery list (see
//!   commands/pairing_discovery.rs) — or types its address by hand — enters
//!   the 6-digit PIN shown in the desktop settings, and receives a bearer
//!   token for the data routes:
//!
//!   ```text
//!   POST /pair              {"pin": "123456"}        → 200 {"token": "..."}
//!                                                      429 while throttled
//!                                                      (per-IP), 415
//!                                                      without the JSON
//!                                                      content type
//!   GET  /api/ping                                   → 200 {"ok": true}
//!   GET  /api/replays        (Bearer)                → 200 [ReplayMetaLite…]
//!   GET  /api/replay/<name>  (auth)                  → 200 replay bytes
//!   GET  /api/gamedata       (auth)                  → 200 zip of the
//!                                                      gameparams/encyclopedia
//!                                                      AppData caches;
//!                                                      503 + Retry-After
//!                                                      while the zip is
//!                                                      still being built
//!   anything else                                     → 404
//!   ```
//!
//!   Requests carrying an `Origin` header or a foreign `Host` are 403'd
//!   (browsers and DNS-rebinding pages are not clients of this
//!   protocol).
//!
//!   No framework, no new dependency: requests are tiny JSON or file streams,
//!   every response is `Connection: close`, and the whole thing must keep
//!   compiling for cargo-deny without new licenses. Enumeration reuses
//!   [`super::replay::scan_replays_meta`] — the same WALK PRIMITIVE the local
//!   list command uses, never a duplicate. The ROOT set differs on purpose:
//!   this server enumerates the resolved default replay dir (the active
//!   client's `replays/` folder, or the phone's managed dir) because the
//!   remote names it hands out are relative to that one root, while the
//!   local rail scans every detected client
//!   (`list_replays_meta { all: true }`). While the server runs, the UDP
//!   discovery broadcaster announces it and — unless disabled in the hidden
//!   relay config — the gateway host bridge (commands/pairing_relay/)
//!   tunnels the same routes through the built-in Cloudflare gateway,
//!   displaying the gateway-allocated pairing code.
//!
//! - **CLIENT (all targets)** — `pairing_pair` / `pairing_list_remote` /
//!   `pairing_pull_replay` / `pairing_pull_gamedata` over a
//!   [`PairingTarget`]: direct LAN HTTP via reqwest (through
//!   [`super::network::http_client_builder`] so the Android rustls trust
//!   setup applies), or the same protocol bytes tunneled through the built-in
//!   gateway (the phone resolves its pairing code to a room first). Pulls
//!   report progress on `wowsp://pairing-progress` with the
//!   same throttling as the resource-pack downloads (~256 KB or ~100 ms,
//!   whatever comes first).
//!
//! Security posture (LAN pairing, v3): the server binds 0.0.0.0 on purpose
//! — reaching any phone on the LAN is the feature, which by construction
//! means anyone on that LAN can also connect. In place: the PIN and the
//! bearer tokens are drawn from the OS CSPRNG (`getrandom`); a token is a
//! 256-bit hex value compared in constant time, accepted ONLY as
//! `Authorization: Bearer` (the old `?token=` query leg is gone), and
//! minted fresh by EVERY successful `/pair` — the minting REVOKES all
//! earlier tokens (one active pairing session per server run) and each
//! token expires 24 h after minting, its lifetime sliding forward while
//! the session stays active. Wrong PINs are throttled PER PEER IP (5
//! consecutive failures → 429 for a 10 s window; a correct PIN resets
//! that IP's counter; the gateway tunnel's connections all arrive from
//! 127.0.0.1 and own their entry, so a LAN flood cannot lock out a
//! tunneled phone or vice versa; the per-IP map is capped at 256 entries
//! with idle eviction). Served connections are capped at 64 concurrent
//! (semaphore permit per connection) and every response WRITE is
//! individually stall-bounded at 30 s — a reader that stops reading is
//! dropped, a progressing transfer is never cut. Requests carrying an
//! `Origin` header or a foreign `Host` hostname are rejected with 403
//! (DNS-rebinding bait), `/pair` demands `Content-Type: application/json`
//! (415), and the gateway-assigned pairing code is a secret only in its
//! 6-digit shape. File routes only touch paths the enumeration itself
//! produced. NOT in place: plain HTTP means the token and the transferred
//! data are sniffable and replayable by anyone on the LAN — the per-IP
//! throttle slows PIN guessing (10^6 keyspace, ~5 attempts per 10 s
//! window per source) but does nothing about a sniffed token, and the
//! 24 h expiry bounds only the window. Never expose this port beyond the
//! trusted LAN.

// ── module layout ───────────────────────────────────────────────────────────
// `store`    — the managed replays dir + filename handling + the import command.
// `client`   — the phone-side client commands (pair / list / pull replay).
// `gamedata` — the game-data zip pull + guarded extraction.
// `server`   — the desktop-side LAN HTTP server (cfg(desktop)).
// `tests`    — the unit suite (moved with the code it tests).

mod client;
mod gamedata;
mod store;

/// The desktop-side pairing server. Everything inside is `#[cfg(desktop)]`.
#[cfg(desktop)]
pub(crate) mod server;

#[cfg(test)]
pub(crate) mod tests;

// The mobile stand-ins below bail with the marker — cfg-scoped so the
// desktop build (which never names the macro) carries no unused import.
#[cfg(mobile)]
use anyhow::anyhow;

// Sibling command modules reached by this module's children through their
// unchanged `super::<name>::...` paths (this facade re-exports the names one
// level down, so every call site kept its original text).
pub(crate) use super::{exports, network, replay};

// `GamedataWorkspace` lives in `gamedata`; `server.rs` and the test suite
// reach it through the unchanged `super::GamedataWorkspace` path (facade
// re-export one level down).
#[cfg(any(desktop, test))]
use self::gamedata::GamedataWorkspace;

use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{CommandResult, PairingProgress, PairingStatus};

/// Progress event channel. Pairing transfers deliberately keep their own
/// multiplexed stream (they pull from a paired device over LAN/relay, not
/// the GitHub mirror ladder the unified download hub serves).
pub const PAIRING_PROGRESS_EVENT: &str = "wowsp://pairing-progress";
/// Sentinel `remoteName` marking the game-data zip sync on the shared
/// progress stream (no single "file" name to key on otherwise).
pub const GAMEDATA_SENTINEL: &str = ":gamedata:";

/// A stop budget must not detach the task: it could still publish old-session
/// state or retain sockets after a replacement session starts.
pub(super) async fn await_shutdown(
    mut task: tokio::task::JoinHandle<()>,
    budget: std::time::Duration,
) {
    if tokio::time::timeout(budget, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

// ── progress plumbing (all targets) ─────────────────────────────────────────

/// Emit one progress event (mirrors model_pack's emit_progress).
pub(crate) fn emit_progress(app: &AppHandle, progress: &PairingProgress) {
    let _ = app.emit(PAIRING_PROGRESS_EVENT, progress);
}

// ── start / stop / status commands ──────────────────────────────────────────

/// Error marker for the mobile stand-ins (R1's mobile_unsupported style).
#[cfg(mobile)]
use crate::mobile_unsupported::PAIRING as PAIRING_SERVER_UNSUPPORTED;

/// Start the desktop pairing server. Mobile answers with the unsupported
/// marker (the settings section that calls this is desktop-only anyway).
#[tauri::command]
pub async fn pairing_start(window: tauri::Window) -> CommandResult<PairingStatus> {
    crate::commands::ensure_main_window_label(window.label())?;
    #[cfg(mobile)]
    {
        return Err(anyhow!(PAIRING_SERVER_UNSUPPORTED).into());
    }
    #[cfg(desktop)]
    {
        Ok(server::pairing_start().await?)
    }
}

/// Stop the desktop pairing server.
#[tauri::command]
pub async fn pairing_stop(window: tauri::Window) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    #[cfg(mobile)]
    {
        return Err(anyhow!(PAIRING_SERVER_UNSUPPORTED).into());
    }
    #[cfg(desktop)]
    {
        Ok(server::pairing_stop().await?)
    }
}

/// Settings entry (audit M-1 residual): drop every live bearer token —
/// paired phones must re-pair — WITHOUT stopping the server.
#[tauri::command]
pub async fn pairing_forget_devices(window: tauri::Window) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    #[cfg(mobile)]
    {
        return Err(anyhow!(PAIRING_SERVER_UNSUPPORTED).into());
    }
    #[cfg(desktop)]
    {
        Ok(server::pairing_forget_devices().await?)
    }
}

/// Current server state. Always `{ running: false }` on mobile.
#[tauri::command]
pub fn pairing_get_status() -> PairingStatus {
    #[cfg(mobile)]
    {
        PairingStatus {
            running: false,
            host: None,
            port: None,
            pin: None,
            mode: None,
            relay_online: false,
            provider: None,
            via_upstream: false,
            notice: None,
        }
    }
    #[cfg(desktop)]
    {
        server::current_status()
    }
}

// Tauri command surface. `generate_handler!` in `src/lib.rs` resolves both the
// command fn and its doc(hidden) sibling macros (`__cmd__*` /
// `__tauri_command_name_*`) through `commands::pairing::*`, exactly like
// `commands/mod_hub/mod.rs` — so those paths are re-exported verbatim.
pub use client::{
    __cmd__pairing_list_remote, __cmd__pairing_pair, __cmd__pairing_pull_replay,
    __tauri_command_name_pairing_list_remote, __tauri_command_name_pairing_pair,
    __tauri_command_name_pairing_pull_replay, pairing_list_remote, pairing_pair,
    pairing_pull_replay,
};
pub use gamedata::{
    __cmd__pairing_pull_gamedata, __tauri_command_name_pairing_pull_gamedata, pairing_pull_gamedata,
};
pub use store::{
    __cmd__import_replay_file, __tauri_command_name_import_replay_file, import_replay_file,
};

// pub(crate) surface consumed through direct `pairing::...` paths by
// sibling command modules (pairing_relay; gameparams' test suite; call
// sites unchanged).
pub(crate) use client::{encode_path_segment, http_error};
#[cfg(test)]
pub(crate) use gamedata::extract_gamedata_zip;
