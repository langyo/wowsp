//! IPC-boundary adapter for anyhow-based command errors.
//!
//! Tauri commands must return errors that satisfy `Into<tauri::ipc::InvokeError>`,
//! and the only blanket implementation Tauri offers requires the error type to be
//! `Serialize`. `anyhow::Error` is not `Serialize`, and the orphan rule forbids
//! implementing `From<anyhow::Error> for InvokeError` on Tauri's type — while this
//! repo's error policy is anyhow end-to-end for all internal flow (no per-module
//! error enums). The one sanctioned bridge is this newtype: commands return
//! [`CommandResult`], the `From<anyhow::Error>` conversion keeps every `?` call
//! site working unchanged, and the `Serialize` impl emits the error's `Display`
//! as a plain JSON string — byte-identical to the historical `Result<T, String>`
//! wire contract, which the webui consumes by rendering rejections as plain
//! strings. `Display` deliberately shows only the outermost anyhow message, never
//! the `{:#}` chain, so a future wave that adds `.context()` must weigh the change
//! against that frontend-visible message.

use anyhow::Error as AnyhowError;
use std::fmt;

/// An [`AnyhowError`] wrapped for the Tauri IPC boundary (see the module docs).
#[derive(Debug)]
pub struct CommandError(AnyhowError);

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Outermost anyhow message only — NOT the `{:#}` chain: the webui
        // string-matches parts of this text.
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for CommandError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source()
    }
}

impl From<AnyhowError> for CommandError {
    fn from(err: AnyhowError) -> Self {
        Self(err)
    }
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Plain string, matching the historical `Result<T, String>` IPC
        // contract byte-for-byte.
        serializer.serialize_str(&self.0.to_string())
    }
}

/// The result type every Tauri command returns across the app.
pub type CommandResult<T> = std::result::Result<T, CommandError>;
