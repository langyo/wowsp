//! Reusable World of Warships replay decoding core — everything pure about
//! the replay format, split out of the Tauri app crate (wave 4a) so the
//! `replay-corpus` maintainer CLI can decode the drained archive with the
//! exact same code the app's replay views ride.
//!
//! Module map (moved wholesale from `wowsp_tauri::commands`):
//! - [`meta`]            — container framing + descriptor/roster parsing
//!   (the header path), incl. the Lesta roster synthesis and the packet
//!   stream locator.
//! - [`packets`]         — packet-stream decoding: decrypt → inflate → the
//!   frame walk producing [`DecodedReplay`] (positions, entity kinds,
//!   battle-effect events).
//! - [`method_tables`] / [`method_tables_lesta`] — the per-version (WG) and
//!   per-family (Lesta) Avatar client-method id tables the decoder gates
//!   EntityMethod streams on.
//! - [`caps`]            — capture-zone geometry lifted off a decoded
//!   replay ([`caps::cap_points_of`]).
//!
//! The app shell keeps its Tauri command wrappers (`wowsp_tauri::
//! commands::replay`) and re-exports this crate's modules under their
//! historical paths, so nothing about the IPC surface changes.

pub mod caps;
pub mod meta;
pub mod method_tables;
pub mod method_tables_lesta;
pub mod packets;

pub use packets::{DecodedReplay, PropertyChange, decode_replay, decode_replay_partial};

/// Whether `ext` is the Lesta (Мир кораблей) replay container extension.
/// Case-insensitive. Inline of the app crate's per-client compat registry
/// helper (`wowsp_tauri::commands::game_client::is_lesta_replay_extension`)
/// so this lib carries no app glue — the extension spelling IS the family
/// marker the decoder's Lesta method table keys on.
pub fn is_lesta_replay_extension(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("korablireplay")
}
