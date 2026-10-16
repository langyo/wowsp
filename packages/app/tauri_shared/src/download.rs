//! The unified resource-download progress channel.
//!
//! Every resource download in the shell (app updates, the resource pack,
//! the data pack, mod-hub packages) streams through ONE event — the
//! download hub (`commands/download_hub.rs`) and its callers push
//! [`DownloadProgress`] payloads on [`DOWNLOAD_PROGRESS_EVENT`], and each
//! webui store subscribes to the single stream, filtering by `kind`/`id`.
//! Transfer phases (`queued`/`race`/`download`) come from the hub; the
//! context that owns the job continues the story with its own phase
//! vocabulary (`apply`/`installing`/`install`/`done`/`error`) on the same
//! channel, so a listener never has to join two streams. A user cancel
//! surfaces through the context's normal failure path (the command
//! rejects with the request's cancel message; `model_pack` additionally
//! reports it on its `error` phase).
//!
//! Pairing transfers (`wowsp://pairing-progress`) deliberately stay on
//! their own multiplexed channel: they pull from a paired device over
//! LAN/relay, not from the GitHub mirror ladder, and share no semantics
//! with the hub.

use serde::{Deserialize, Serialize};

/// The one progress event every resource download emits on.
pub const DOWNLOAD_PROGRESS_EVENT: &str = "wowsp://download-progress";

/// Job kinds — which download context owns the event.
pub mod kind {
    /// App-update installer artifact (`commands/update.rs`).
    pub const UPDATE: &str = "update";
    /// Resource pack (full archive or chain-patch link, `model_pack.rs`).
    pub const RES_PACK: &str = "res-pack";
    /// Baked ship-data kit (`data_pack.rs`).
    pub const DATA_PACK: &str = "data-pack";
    /// One mod-hub catalog package (`mod_catalog.rs`).
    pub const MOD_PACKAGE: &str = "mod-package";
}

/// Phase vocabulary. Hub-owned phases first, then the context-owned
/// continuations — all ride the same event.
pub mod phase {
    /// Waiting in the FIFO queue behind another download (hub).
    pub const QUEUED: &str = "queued";
    /// Mirrors are being probed/raced (hub; indeterminate UI state).
    pub const RACE: &str = "race";
    /// Bytes are streaming onto disk (hub; `received`/`total` move).
    pub const DOWNLOAD: &str = "download";
    /// The pack pass is applying what it downloaded (`model_pack.rs`).
    pub const APPLY: &str = "apply";
    /// A mod install moved to its unpack/write stage (`mod_catalog.rs`).
    pub const INSTALLING: &str = "installing";
    /// The update installer was spawned (`update.rs`).
    pub const INSTALL: &str = "install";
    /// The whole pass succeeded (context).
    pub const DONE: &str = "done";
    /// The pass failed — see `error` (context).
    pub const ERROR: &str = "error";
}

/// One progress tick of the unified download stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Job identity — what UI rows filter on: `"update"`, `"res-pack"`,
    /// `"data-pack"`, or the mod-hub entry id for package downloads.
    pub id: String,
    /// Which context owns the job (see [`kind`]).
    pub kind: String,
    /// Current phase (see [`phase`]).
    pub phase: String,
    /// Bytes committed to disk so far, including any pass-aggregation
    /// base (chain-patch links that already finished).
    pub received: u64,
    /// Total bytes when known, else 0 (indeterminate).
    pub total: u64,
    /// Smoothed transfer rate in bytes/sec while streaming (EWMA over
    /// 500 ms ticks; 0 while not streaming).
    pub speed_bps: f64,
    /// Context-specific extras merged into every event of the job, e.g.
    /// `{segment, segments}` for chain patches or `{package, packages}`
    /// for mod installs.
    pub detail: Option<serde_json::Value>,
    /// Human-readable error on the `error` phase.
    pub error: Option<String>,
}
