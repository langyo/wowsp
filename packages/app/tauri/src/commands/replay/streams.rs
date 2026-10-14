//! Packet-stream decoding: finished-replay position trajectories, the live
//! temp-container snapshots, HP detection/anchoring and the Lesta arena
//! synthesis. Split from the former single-file `commands/replay.rs`; the
//! post-decode assembly half (HP detection/anchoring, the Lesta arena
//! synthesis, entity grouping) then moved on to the decoding core (wave 5a,
//! `wowsp_replay_core::assemble`) and is re-exported below.

use anyhow::anyhow;
use std::fs;

use wowsp_tauri_shared::{CommandResult, VehicleEntry};

use super::meta::{extract_descriptor_json, roster_from_raw};

/// Decode the packet stream of one `.wowsreplay` and return per-entity
/// position trajectories (milestone M3) annotated with each entity's creation
/// metadata (entity-create: type / vehicleId / initial position) so the
/// frontend can filter ships from capture zones / avatars.
///
/// Async command + [`tokio::task::spawn_blocking`]: the full Blowfish decrypt
/// + zlib inflate of a real match's packet stream is seconds-scale CPU work —
/// it runs on the blocking pool so the UI thread never stalls (same rule as
/// [`pick_replay_files`]).
#[tauri::command]
pub async fn read_replay_positions(
    path: String,
) -> CommandResult<wowsp_tauri_shared::ReplayStream> {
    Ok(tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| anyhow!("read {path}: {e}"))?;
        let stream = packet_stream_after_blocks(&bytes)
            .ok_or_else(|| anyhow!("{path}: not a valid wowsreplay (no packet stream)"))?;
        // The container's family picks the entity-method id table (Lesta's
        // version keys sit above every WG table — version-keyed lookup would
        // cross-wire the method-gated streams; see method_tables_lesta).
        let lesta = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(super::game_client::is_lesta_replay_extension);
        // Roster shipIds — the candidate set used to recover each entity's
        // shipId from its EntityCreate state stream (the only reliable
        // entity -> player join key). Goes through the shared roster source
        // so a Lesta container (whose descriptor carries no vehicles array)
        // contributes its synthesized roster just the same; the roster itself
        // is kept for the Lesta arena synthesis below.
        let mut candidates = std::collections::HashSet::new();
        let mut client_version: Option<String> = None;
        let mut roster: Vec<VehicleEntry> = Vec::new();
        if let Some(json) = extract_descriptor_json(&bytes) {
            if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
                client_version = raw
                    .get("clientVersionFromExe")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                roster = roster_from_raw(std::path::Path::new(&path), &raw);
                for v in &roster {
                    // 0 is the degenerate "no shipId in the entry" default —
                    // offering it would let a 4-zero-byte window in any
                    // EntityCreate state label an entity with a bogus id.
                    if v.ship_id > 0 {
                        candidates.insert(v.ship_id as u32);
                    }
                }
            }
        }
        let mut decoded =
            super::packets::decode_replay(stream, &candidates, client_version.as_deref(), lesta)?;
        if lesta {
            // BEFORE grouping: the synthesis fills `arena_players` with the
            // state-recovered starting health, so the HP anchoring and the
            // recorder-team slot inside `group_by_entity` treat it exactly
            // like a decoded WG arena state.
            synthesize_lesta_arena_players(
                &mut decoded.arena_players,
                &decoded.kinds,
                &roster,
                decoded.recorder_ship,
            );
        }
        Ok::<_, anyhow::Error>(group_by_entity(decoded))
    })
    .await
    .map_err(|e| anyhow!("replay positions task failed: {e}"))??)
}

/// The running client's in-progress replay container (`temp.wowsreplay` /
/// `temp.korablireplay`), as surfaced to the live self-stats view. `size` is
/// the current byte length — the frontend re-decodes only when it grew, so
/// the (seconds-scale) snapshot decode never re-runs on a quiescent file.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LiveTempReplay {
    pub path: String,
    pub size: u64,
}

/// Locate the live battle's in-progress replay container. Resolves the
/// RUNNING install first (the file belongs to whichever client is actually
/// in a match — the same live-order rule as the roster/telemetry pipelines),
/// then checks each family's `temp.<ext>` name in its replays folder and
/// returns the most recently modified hit. `None` when no game root resolves
/// or no temp container exists (no battle in progress).
#[tauri::command]
pub async fn live_temp_replay() -> CommandResult<Option<LiveTempReplay>> {
    Ok(tokio::task::spawn_blocking(|| {
        let Some(root) =
            super::game_context::resolve_root(super::game_context::RootPreference::PreferRunning)
        else {
            return Ok::<_, anyhow::Error>(None);
        };
        let dir = super::game_context::replays_dir(&root.root);
        let mut best: Option<(std::time::SystemTime, LiveTempReplay)> = None;
        for ext in super::game_client::replay_extensions() {
            let path = dir.join(format!("temp.{ext}"));
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(t, _)| modified >= *t) {
                best = Some((
                    modified,
                    LiveTempReplay {
                        path: path.to_string_lossy().into_owned(),
                        size: meta.len(),
                    },
                ));
            }
        }
        Ok(best.map(|(_, live)| live))
    })
    .await
    .map_err(|e| anyhow!("live temp replay task failed: {e}"))??)
}

/// Decode the CURRENTLY WRITING `temp.wowsreplay` into the same
/// [`ReplayStream`] shape as [`read_replay_positions`], tolerating the torn
/// tail the game is mid-append on (see `decode_replay_partial`). Called
/// repeatedly by the live self-stats view while its tab is open; damage
/// totals, hits, achievements and HP timelines all stream cumulatively, so
/// every call is a complete "battle so far" snapshot, not a delta.
///
/// Mid-write states are the NORMAL first reads, not errors (see
/// [`live_snapshot_from_bytes`]) — the view keeps its syncing state and
/// re-polls as the file grows.
#[tauri::command]
pub async fn read_live_replay_snapshot(
    path: String,
) -> CommandResult<wowsp_tauri_shared::LiveSelfStream> {
    Ok(tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| anyhow!("read {path}: {e}"))?;
        Ok::<_, anyhow::Error>(live_snapshot_from_bytes(&path, &bytes))
    })
    .await
    .map_err(|e| anyhow!("live replay snapshot task failed: {e}"))??)
}
/// Byte length of the last live-temp read that failed to decode — the
/// downgrade below warns once per growth step instead of once per 5 s poll.
static LAST_LIVE_DECODE_FAILURE_LEN: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(u64::MAX);

/// Parse one live-temp-container read into the slim self-stats snapshot.
///
/// The game writes the container progressively — right after the file is
/// (re)created (battle start, loading screen, the next battle truncating the
/// previous file), the magic/header blocks are not fully on disk yet, and a
/// pre-allocated packet region may still read back as zero fill. Mid-write
/// is the NORMAL first-read state, not corruption: it yields the EMPTY
/// snapshot (the view stays on its syncing state and re-polls on the next
/// size change) instead of surfacing an RpcError for a file that is simply
/// incomplete. A valid prefix behind a torn tail still decodes (see
/// `inflate_zlib_partial`, which keeps the prefix on InvalidData too) —
/// only a stream with nothing decodable downgrades to empty.
///
/// Mirrors the finished-replay path's prologue (roster candidates, version,
/// the Lesta arena synthesis) so the live and settled snapshots agree on
/// identity and starting health; the strict finished-replay reader keeps
/// its hard error for the same shapes (see [`read_replay_positions`]): a
/// completed replay that fails to parse must surface, never masquerade as
/// "still being written".
pub(super) fn live_snapshot_from_bytes(
    path: &str,
    bytes: &[u8],
) -> wowsp_tauri_shared::LiveSelfStream {
    use std::sync::atomic::Ordering;

    let Some(stream) = packet_stream_after_blocks(bytes) else {
        tracing::debug!(
            path,
            len = bytes.len(),
            "live temp replay header not flushed yet; empty snapshot"
        );
        return wowsp_tauri_shared::LiveSelfStream::default();
    };
    let lesta = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(super::game_client::is_lesta_replay_extension);
    let mut candidates = std::collections::HashSet::new();
    let mut client_version: Option<String> = None;
    let mut roster: Vec<VehicleEntry> = Vec::new();
    if let Some(json) = extract_descriptor_json(bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            client_version = raw
                .get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            roster = roster_from_raw(std::path::Path::new(path), &raw);
            if roster.is_empty() {
                // The Lesta LIVE descriptor carries no roster at all (the
                // block[1] playersPublicInfo only lands when the battle
                // settles). The in-game probe's roster file is fresh and
                // complete mid-battle — without it the entity-create ship
                // ids never resolve, the self join fails, and the live
                // view stays on its waiting state for the whole fight
                // (2026-10-08 field session).
                // The freshness gate anchors on the temp container's
                // CREATION time: its mtime advances with every append, and
                // the probe's write-once roster would go "stale" against it
                // in any quiet phase >5 s, silently dropping the roster
                // mid-battle (created() falls back to modified() on
                // filesystems without birth time).
                let battle_start = fs::metadata(path)
                    .and_then(|m| m.created().or_else(|_| m.modified()))
                    .ok();
                if let Some(synth) = super::probe_roster::synthesize_for_arena_since(
                    std::path::Path::new(path),
                    raw.get("playerName").and_then(|v| v.as_str()),
                    battle_start,
                ) {
                    tracing::info!(
                        players = synth.len(),
                        "live temp replay roster synthesized from the in-game probe"
                    );
                    roster = synth;
                }
            }
            for v in &roster {
                if v.ship_id > 0 {
                    candidates.insert(v.ship_id as u32);
                }
            }
        }
    }
    let decoded = match super::packets::decode_replay_partial(
        stream,
        &candidates,
        client_version.as_deref(),
        lesta,
    ) {
        Ok(decoded) => decoded,
        // Nothing decodable yet (the packet region is still zero fill, or
        // its first block is mid-flush) — the same mid-write class as the
        // unwritten header; the next size growth gets a fresh attempt. A
        // systematic failure (new client framing, a changed key) shows up
        // here at every growth step, so it warns once per step instead of
        // hiding at debug level for the whole battle.
        Err(e) => {
            if LAST_LIVE_DECODE_FAILURE_LEN.swap(bytes.len() as u64, Ordering::Relaxed)
                != bytes.len() as u64
            {
                tracing::warn!(
                    path,
                    len = bytes.len(),
                    error = %e,
                    "live temp replay not decodable yet; empty snapshot"
                );
            }
            return wowsp_tauri_shared::LiveSelfStream::default();
        },
    };
    // The shared post-decode tail — Lesta arena synthesis BEFORE grouping
    // (so the HP anchoring and the recorder-team slot treat it exactly like
    // a decoded WG arena state), the trajectory grouping, then the slim
    // projection. Lives in the decoding core and is shared with the settled
    // corpus bench (wowsp_replay_core::assemble::finish_self_stream), so
    // the live and settled snapshots agree by construction.
    wowsp_replay_core::assemble::finish_self_stream(decoded, lesta, &roster)
}

/// Skip the magic + JSON header blocks and return a slice over the encrypted
/// packet stream. Shared by header parsing and position decoding — moved to
/// the decoding core (wave 4a) and re-exported here so the historical
/// `super::streams::packet_stream_after_blocks` paths keep resolving.
pub(super) use wowsp_replay_core::meta::packet_stream_after_blocks;

/// Post-decode assembly — the HP property detection, the HP-stream
/// anchoring, the Lesta arena synthesis and the per-entity trajectory
/// grouping — moved to the decoding core (wave 5a) so the settled-battle
/// corpus bench (`wowsp_replay_core::assemble::live_self_stream_from_settled`)
/// rides the exact same code the app's replay views use, and re-exported
/// here so the historical `super::streams::<fn>` paths (call sites + the
/// test suite) keep resolving, same pattern as
/// [`packet_stream_after_blocks`] above.
pub(super) use wowsp_replay_core::assemble::{group_by_entity, synthesize_lesta_arena_players};

/// The assembly helpers the live command paths reach only THROUGH
/// [`group_by_entity`] — kept nameable at the historical
/// `super::streams::<fn>` paths for the replay test suite's direct pins.
#[cfg(test)]
pub(super) use wowsp_replay_core::assemble::{HpValueKind, anchor_hp_streams, detect_hp_property};
