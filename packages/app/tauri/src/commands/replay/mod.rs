//! Replay header parsing — WG `.wowsreplay` and the Lesta (Мир кораблей)
//! `.korablireplay` container.
//!
//! File layout (both clients — the Lesta container keeps the WG framing
//! byte-for-byte, only its block payload set differs):
//!   4 bytes  magic       = `{0x12, 0x32, 0x34, 0x11}`
//!   4 bytes  block_count = little-endian u32
//!   ...      blocks      = `block_count` × (4-byte LE length + payload)
//!   ...      packets     = encrypted/zlib packet stream (`packets`)
//!
//! WG writes 3 blocks, the first carrying the match-descriptor JSON with the
//! roster inline (`vehicles`). Lesta writes 4:
//!   - block[0] — the match descriptor JSON. Same core keys as WG
//!     (`matchGroup`, `mapId`, `mapDisplayName`, `scenario`,
//!     `clientVersionFromExe`, ...), but NO `vehicles` roster;
//!   - block[1] — the roster JSON: `playersPublicInfo` maps account id →
//!     positional array ([0] id — negative = bot, [1] name (same
//!     `:Name:` / `IDS_*` / `#Name` bot markers as WG), [6] team 0/1,
//!     [7] shipId in the WG numeric format);
//!   - block[2] — ASCII `"<accountDBID>.<arenaUniqueID>"`, pinning the
//!     recorder's account id;
//!   - block[3] — 32 ASCII hex chars, an integrity checksum (not a key;
//!     ignored).
//!
//! A descriptor without `vehicles` gets its roster synthesized from [1] +
//! [2] ([`lesta_roster`]); relations, bot/scripted counts and the recorder's
//! ship then follow the WG rules unchanged.
//!
//! The packet stream behind the blocks is also the exact WG scheme (same
//! Blowfish key + XOR chain + zlib, [`packets::decode_replay`]), so
//! trajectories decode unchanged. Fixed-layout packets (positions, entity
//! create/destroy, player position) are version-independent;
//! EntityMethod-id-gated features run under the Lesta Avatar method table
//! ([`crate::commands::method_tables_lesta`]) selected by the container
//! family — Lesta's `clientVersionFromExe` ("26,10,0,...") sits above every
//! WG table, so version-keyed lookup would cross-wire those streams. Lesta
//! recordings additionally carry NO `onArenaStateReceived` and NO chat
//! broadcast at all (verified across 26.10 captures): the arena roster is
//! synthesized from the block[1] roster plus the EntityCreate shipId scan
//! ([`synthesize_lesta_arena_players`]), with each ship's starting health
//! recovered from the create state, and the chat stream stays empty — no
//! sanctioned local chat source exists either (the Mods API exposes no chat
//! event; both clients ship their game scripts encrypted, so Lesta's
//! CHAT_MESSAGE_BLOB converter can't be read offline; the client writes no
//! battle-chat log to disk), so chat-bearing Lesta recordings, should they
//! turn out to exist, are the only remaining path.
//!
//! The dual-format reader also accepts the bare-JSON variant the client
//! writes as `tempArenaInfo.json` (same logic ApeRadar's
//! `FileUtils.ReadTempArenaInfoFile` uses).

// ── module layout ───────────────────────────────────────────────────────────
// `meta`     — container framing + descriptor/roster parsing (the header path).
// `streams`  — packet-stream decoding: positions, live snapshots, HP anchoring.
// `listing`  — replay directory walks + the list/pick commands.
// `tests`    — the unit suite (moved with the code it tests).

mod listing;
mod meta;
mod streams;

#[cfg(test)]
mod tests;

// Sibling command modules reached by this module's children through their
// unchanged `super::<name>::...` paths (this facade re-exports the names one
// level down, so every call site kept its original text).
pub(crate) use super::{game_client, game_context, game_detect, packets, probe_roster};

// Tauri command surface. `generate_handler!` in `src/lib.rs` resolves both the
// command fn and its doc(hidden) sibling macros (`__cmd__*` /
// `__tauri_command_name_*`) through `commands::replay::*`, exactly like
// `commands/mod_hub/mod.rs` — so those paths are re-exported verbatim.
pub use listing::{
    __cmd__list_replays, __cmd__list_replays_meta, __cmd__pick_replay_files,
    __tauri_command_name_list_replays, __tauri_command_name_list_replays_meta,
    __tauri_command_name_pick_replay_files, list_replays, list_replays_meta, pick_replay_files,
};
pub use meta::{
    __cmd__read_replay_header, __tauri_command_name_read_replay_header, read_replay_header,
};
pub use streams::{
    __cmd__live_temp_replay, __cmd__read_live_replay_snapshot, __cmd__read_replay_positions,
    __tauri_command_name_live_temp_replay, __tauri_command_name_read_live_replay_snapshot,
    __tauri_command_name_read_replay_positions, live_temp_replay, read_live_replay_snapshot,
    read_replay_positions,
};

// pub surface reused by `arena_info` (the live tempArenaInfo.json shares the
// replay's dual-format header).
pub use meta::{extract_descriptor_json_pub, meta_from_raw_pub};

// pub(crate) surface consumed through direct `replay::...` paths by sibling
// command modules (arena_info / playtime / pairing; call sites unchanged).
pub(crate) use listing::{resolve_replay_dir, scan_replays_meta, walk_replays};
pub(crate) use meta::{
    is_bot_nickname, is_operation_battle, is_scripted_unit_nickname, lite_from_path,
};
