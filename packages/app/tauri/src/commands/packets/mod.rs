//! Thin re-export shim: the replay packet-stream decoder moved to
//! `wowsp_replay_core::packets` (wave 4a). Historical `commands::packets::*`
//! paths (the replay stream/cap-layout views, the replay test suite,
//! `generate_handler` plumbing) keep resolving unchanged; new consumers
//! should depend on the lib crate directly.

pub use wowsp_replay_core::packets::*;
