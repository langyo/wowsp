//! Tauri command wrapper for the replay header read — the IPC surface that
//! stayed in the app crate when the pure header parsing moved to
//! `wowsp_replay_core::meta` (wave 4a). Everything else in this file's
//! former home (`commands/replay/meta.rs`) moved with the lib.

use anyhow::anyhow;
use std::fs;

use wowsp_replay_core::meta::{extract_descriptor_json, meta_from_raw};
use wowsp_tauri_shared::{CommandResult, ReplayMeta};

/// Read + parse the header of one `.wowsreplay` file into a [`ReplayMeta`].
///
/// `path` must point at an existing file. On any structural problem (missing
/// magic, truncated header, unparseable JSON) the raw JSON block is still
/// returned when recoverable, so the frontend can render whatever it can.
///
/// Async command + [`tokio::task::spawn_blocking`]: reading + decrypting the
/// descriptor block is real file I/O + CPU work, which must never run on the
/// UI thread (Tauri 2 synchronous commands do) — same rule as
/// [`super::listing::pick_replay_files`].
#[tauri::command]
pub async fn read_replay_header(path: String) -> CommandResult<ReplayMeta> {
    tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| anyhow!("read {path}: {e}"))?;
        let json = extract_descriptor_json(&bytes).ok_or_else(|| {
            anyhow!("{path}: not a valid wowsreplay (magic mismatch or truncated)")
        })?;
        let raw: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| anyhow!("parse descriptor JSON: {e}"))?;
        Ok(meta_from_raw(path, raw))
    })
    .await
    .map_err(|e| anyhow!("replay header task failed: {e}"))?
}
