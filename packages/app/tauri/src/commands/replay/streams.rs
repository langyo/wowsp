//! Packet-stream decoding: finished-replay position trajectories, the live
//! temp-container snapshots, HP detection/anchoring and the Lesta arena
//! synthesis. Split from the former single-file `commands/replay.rs`; the
//! post-decode assembly half (HP detection/anchoring, the Lesta arena
//! synthesis, entity grouping) then moved on to the decoding core (wave 5a,
//! `wowsp_replay_core::assemble`) and is re-exported below.

use anyhow::anyhow;
use std::fs;

use wowsp_tauri_shared::{CommandResult, PlayerBuild, VehicleEntry};

use super::meta::{extract_descriptor_json, roster_from_raw};

/// Shared decode prologue (review M-3): file bytes → packet stream →
/// container family → descriptor (client version + roster shipId
/// candidates) → core decode → Lesta arena synthesis. The grouped
/// wrappers ([`read_replay_positions`] / [`decode_replay_stream_sync`])
/// and the cap-layout lifter (`cap_layouts::caps_of_replay`) all ride
/// this — the cap lifter's former hand-rolled copy passed no version and
/// no roster candidates, so the version-gated layouts (the arena join
/// included) never fired there.
/// Returns the decoded replay plus the descriptor roster: the exit layer
/// needs the roster relations to project the decode-layer build set onto the
/// ally-only IPC surface ([`ally_builds_from`]).
pub(crate) fn decode_replay_file_decoded(
    path: &std::path::Path,
) -> anyhow::Result<(wowsp_replay_core::DecodedReplay, Vec<VehicleEntry>)> {
    // Review M-6: the full decode legitimately buffers the whole file,
    // but a pairing-pulled "replay" can claim any size — refuse past the
    // bound before the read (the largest real capture is a few dozen MB;
    // 512 MiB is two orders of headroom).
    const MAX_DECODE_FILE_BYTES: u64 = 512 * 1024 * 1024;
    let meta = fs::metadata(path).map_err(|e| anyhow!("read {}: {e}", path.display()))?;
    if meta.len() > MAX_DECODE_FILE_BYTES {
        return Err(anyhow!(
            "{}: {} bytes exceeds the {} MiB replay decode ceiling",
            path.display(),
            meta.len(),
            MAX_DECODE_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(path).map_err(|e| anyhow!("read {}: {e}", path.display()))?;
    let stream = packet_stream_after_blocks(&bytes).ok_or_else(|| {
        anyhow!(
            "{}: not a valid wowsreplay (no packet stream)",
            path.display()
        )
    })?;
    // The container's family picks the entity-method id table (Lesta's
    // version keys sit above every WG table — version-keyed lookup would
    // cross-wire the method-gated streams; see method_tables_lesta).
    let lesta = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(super::game_client::is_lesta_replay_extension);
    // Roster shipIds — the candidate set used to recover each entity's
    // shipId from its EntityCreate state stream (the only reliable
    // entity → player join key). Goes through the shared roster source
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
            roster = roster_from_raw(path, &raw);
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
    Ok((decoded, roster))
}

/// Project the decode-layer vehicle builds onto the IPC DTO for the recorder's
/// SIDE only.
///
/// Product decision (user): enemy loadouts are never displayed, even though the
/// replay carries them (the decode layer keeps both teams for completeness and
/// tests). This exit is the single place that enforces the rule: a build whose
/// roster entry has relation > 1 (the other team / spectator) is dropped here.
/// A ship id that appears on BOTH sides (mirror picks share one shipId) makes
/// the join ambiguous, so that build is dropped too rather than risk showing an
/// enemy loadout as an ally's. Builds that join no roster entry are dropped
/// (unknown player identity).
fn ally_builds_from(
    decoded: &wowsp_replay_core::DecodedReplay,
    roster: &[VehicleEntry],
) -> Vec<PlayerBuild> {
    ally_builds_for(&decoded.vehicle_builds, roster)
}

/// The roster-relation join behind [`ally_builds_from`] (split out so the
/// exit-filter tests can feed synthetic builds without a full decode).
pub(super) fn ally_builds_for(
    builds: &[wowsp_replay_core::VehicleBuildRaw],
    roster: &[VehicleEntry],
) -> Vec<PlayerBuild> {
    builds
        .iter()
        .filter_map(|raw| {
            let ship_id = i64::from(raw.ship_params_id);
            let matches: Vec<&VehicleEntry> =
                roster.iter().filter(|v| v.ship_id == ship_id).collect();
            let first = matches.first()?;
            if matches.iter().any(|v| v.relation != first.relation) {
                // Mirror pick: the same ship id is on both sides. The join
                // cannot tell whose build this is, so it never reaches IPC.
                return None;
            }
            if first.relation > 1 {
                return None;
            }
            // Attribute the player name only when a UNIQUE ally roster entry
            // plays this ship; two teammates on the same hull keep the build
            // (entity_id still joins the trajectory) but stay anonymous
            // rather than mis-attributed.
            let name = if matches.iter().filter(|v| v.relation <= 1).count() == 1 {
                Some(first.name.clone())
            } else {
                None
            };
            Some(PlayerBuild {
                name,
                entity_id: raw.entity_id,
                ship_params_id: raw.ship_params_id,
                units: raw.units.clone(),
                modernization: raw.modernization.clone(),
                exteriors: raw.exteriors.clone(),
                abilities: raw.abilities.clone(),
                ensigns: raw.ensigns.clone(),
                ecoboosts: raw.ecoboosts.clone(),
                crew_params_id: raw.crew_params_id,
                is_in_adaptation: raw.is_in_adaptation,
                learned_skills: raw.learned_skills.clone(),
            })
        })
        .collect()
}

/// Decode the packet stream of one `.wowsreplay` and return per-entity
/// position trajectories (milestone M3) annotated with each entity's creation
/// metadata (entity-create: type / vehicleId / initial position) so the
/// frontend can filter ships from capture zones / avatars.
///
/// Async command + [`tokio::task::spawn_blocking`]: the full Blowfish decrypt
/// + zlib inflate of a real match's packet stream is seconds-scale CPU work —
/// it runs on the blocking pool so the UI thread never stalls (same rule as
/// [`pick_replay_files`]).
///
/// WIRE FORMAT: the response is a RAW [`tauri::ipc::Response`] carrying the
/// whole [`wowsp_tauri_shared::ReplayStream`] as MessagePack (rmp-serde
/// `to_vec_named` honours the same camelCase / skip_serializing_if attrs the
/// old JSON codec used, so the decoded object shape is identical). A
/// 20-minute 24-ship match was ~10 MB of JSON; the packer cuts the wire to
/// roughly half and the webui's MessagePack decode replaces JSON.parse of
/// that whole string. The browser-dev/mock transports keep answering JSON
/// for this command (same object shape) — only the Tauri transport decodes
/// bytes (see transport.invokeBin in the webui).
#[tauri::command]
pub async fn read_replay_positions(path: String) -> CommandResult<tauri::ipc::Response> {
    let stream = tokio::task::spawn_blocking(move || {
        let (decoded, roster) = decode_replay_file_decoded(std::path::Path::new(&path))?;
        let ally_builds = ally_builds_from(&decoded, &roster);
        let mut stream = group_by_entity(decoded);
        stream.ally_builds = ally_builds;
        Ok::<_, anyhow::Error>(stream)
    })
    .await
    .map_err(|e| anyhow!("replay positions task failed: {e}"))??;
    let bytes = rmp_serde::to_vec_named(&stream)
        .map_err(|e| anyhow!("replay stream msgpack encode: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Smoke-screen lifecycles of one `.wowsreplay` (experiment E8): every
/// entityType-4 SmokeScreen entity with its spawn position, the radius /
/// height walked out of the EntityCreate state, and the observed dissipation
/// time (EntityLeave/Destroy). Served separately from
/// `read_replay_positions` — the stream's own consumers never need it.
/// Sync decode of one replay's full stream — the shared body behind
/// `read_replay_positions` and the decision commands' direct calls (which
/// cannot await the async command). Blocks the calling thread; the commands
/// wrap it in `spawn_blocking`.
pub(crate) fn decode_replay_stream_sync(
    path: &str,
) -> anyhow::Result<wowsp_tauri_shared::ReplayStream> {
    let (decoded, roster) = decode_replay_file_decoded(std::path::Path::new(path))?;
    let ally_builds = ally_builds_from(&decoded, &roster);
    let mut stream = group_by_entity(decoded);
    stream.ally_builds = ally_builds;
    Ok(stream)
}

/// Sync smoke-screen decode (experiment E8) — same preamble as
/// [`decode_replay_stream_sync`], keeping the two paths identical.
pub(crate) fn read_smoke_screens_sync(
    path: &str,
) -> anyhow::Result<Vec<wowsp_tauri_shared::SmokeScreenEvent>> {
    // Same decode-size ceiling as the shared prologue (review M-6).
    const MAX_DECODE_FILE_BYTES: u64 = 512 * 1024 * 1024;
    let meta = fs::metadata(path).map_err(|e| anyhow!("read {path}: {e}"))?;
    if meta.len() > MAX_DECODE_FILE_BYTES {
        return Err(anyhow!(
            "{path}: {} bytes exceeds the {} MiB replay decode ceiling",
            meta.len(),
            MAX_DECODE_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(path).map_err(|e| anyhow!("read {path}: {e}"))?;
    let stream = packet_stream_after_blocks(&bytes)
        .ok_or_else(|| anyhow!("{path}: not a valid wowsreplay (no packet stream)"))?;
    let lesta = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(super::game_client::is_lesta_replay_extension);
    let mut candidates = std::collections::HashSet::new();
    let mut client_version: Option<String> = None;
    if let Some(json) = extract_descriptor_json(&bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            client_version = raw
                .get("clientVersionFromExe")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            for v in roster_from_raw(std::path::Path::new(path), &raw) {
                if v.ship_id > 0 {
                    candidates.insert(v.ship_id as u32);
                }
            }
        }
    }
    let decoded =
        super::packets::decode_replay(stream, &candidates, client_version.as_deref(), lesta)?;
    Ok(decoded.smoke_screens)
}

#[tauri::command]
pub async fn read_replay_smoke_screens(
    path: String,
) -> CommandResult<Vec<wowsp_tauri_shared::SmokeScreenEvent>> {
    Ok(
        tokio::task::spawn_blocking(move || read_smoke_screens_sync(&path))
            .await
            .map_err(|e| anyhow!("replay smoke task failed: {e}"))??,
    )
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
        // Same decode-size ceiling as the settled paths (review M-6): a
        // game-written temp file never approaches it, so this only ever
        // rejects a corrupted-loop read, never a live battle.
        const MAX_DECODE_FILE_BYTES: u64 = 512 * 1024 * 1024;
        let meta = fs::metadata(&path).map_err(|e| anyhow!("read {path}: {e}"))?;
        if meta.len() > MAX_DECODE_FILE_BYTES {
            return Err(anyhow!(
                "{path}: {} bytes exceeds the {} MiB replay decode ceiling",
                meta.len(),
                MAX_DECODE_FILE_BYTES / (1024 * 1024)
            ));
        }
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
    // The ally-only build projection must happen BEFORE the decode output is
    // moved into the shared post-decode tail (grouping consumes it).
    let ally_builds = ally_builds_from(&decoded, &roster);
    let mut snapshot = wowsp_replay_core::assemble::finish_self_stream(decoded, lesta, &roster);
    snapshot.ally_builds = ally_builds;
    snapshot
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
