//! Shared DTOs between the WoWSP Tauri shell (Rust) and the webui (TypeScript).
//!
//! Every struct here crosses the Tauri IPC boundary, so field naming uses
//! `#[serde(rename_all = "camelCase")]` to match TypeScript conventions and
//! the `@wowsp/shared_ui` barrel the frontend consumes. Keep this crate the
//! single source of truth for the wire format — when a field changes here,
//! regenerate the TS bindings (planned: ts-rs) and update the webui types.

mod arena;
pub mod download;
mod encyclopedia;
mod game;
mod mod_hub;
mod overlay;
mod pairing;
mod playtime;
mod replay;
mod resource;
mod stats;
mod stream;
mod supporters;

pub use arena::*;
pub use download::*;
pub use encyclopedia::*;
pub use game::*;
pub use mod_hub::*;
pub use overlay::*;
pub use pairing::*;
pub use playtime::*;
pub use replay::*;
pub use resource::*;
pub use stats::*;
pub use stream::*;
pub use supporters::*;

#[cfg(test)]
mod tests;
