//! Mobile replay import — the surviving sliver of the retired PIN
//! pairing mode (2026-11-13).
//!
//! History: this module used to host the full phone↔desktop pairing
//! stack — the desktop LAN HTTP server with its 6-digit PIN handshake,
//! the phone-side client commands (pair / list / pull replay / pull
//! gamedata), the internet relay bridge (commands/pairing_relay/, the
//! gateway-allocated pairing code) and the LAN UDP discovery pair. The
//! account-routed gateway push (#1544) made the desktop code display
//! — and with it every surface that could start the pairing server —
//! obsolete, so the whole handshake became unreachable dead code and
//! was retired end to end. Live-stats pairing is the challenge-based
//! account handshake in commands/gateway/ (docs/en/designs/
//! gateway-push.md); the phone acquires replays by picking files
//! through `import_replay_file` below.
//!
//! What remains is the MANAGED REPLAYS DIR machinery (`store`): the
//! directory imported replays land in (the same directory the local
//! listing reads) plus the filename handling (sanitize / dedupe /
//! reserve) the import command needs.

// ── module layout ───────────────────────────────────────────────────────────
// `store` — the managed replays dir + filename handling + the import command.
// `tests` — the unit suite (moved with the code it tests).

mod store;

#[cfg(test)]
pub(crate) mod tests;

// Sibling command modules reached by this module's children through their
// unchanged `super::<name>::...` paths (this facade re-exports the names one
// level down, so every call site kept its original text).
pub(crate) use super::{exports, replay};

// Tauri command surface. `generate_handler!` in `src/lib.rs` resolves both the
// command fn and its doc(hidden) sibling macros (`__cmd__*` /
// `__tauri_command_name_*`) through `commands::pairing::*` — so those paths
// are re-exported verbatim.
pub use store::{
    __cmd__import_replay_file, __tauri_command_name_import_replay_file, import_replay_file,
};
