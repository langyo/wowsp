//! The phone-side client commands: PIN pairing, remote replay listing and
//! pull, plus the LAN/relay target helpers and download plumbing they share.
//! Split from the former single-file `commands/pairing.rs`.

use anyhow::{Result, anyhow, bail};

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use wowsp_tauri_shared::{
    CommandResult, PairingPathResult, PairingProgress, PairingTarget, PairingToken, ReplayMetaLite,
};

use super::emit_progress;
use super::store::{managed_replays_dir, sanitize_replay_name, write_replay_file};

/// Percent-encode a path segment for the pairing URL (everything outside the
/// unreserved set escapes, so `/` and friends never smuggle structure).
pub(crate) fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            },
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
/// Stream a response body into `dest`, emitting throttled download progress
/// (~every 256 KB or 100 ms) under `remote_name`. Same shape as model_pack's
/// download_to_file, minus the sha verification (the pairing protocol has no
/// manifest to verify against).
pub(super) async fn stream_to_file(
    app: &AppHandle,
    resp: &mut reqwest::Response,
    dest: &Path,
    remote_name: &str,
) -> Result<u64> {
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| anyhow!("create {}: {e}", dest.display()))?;
    use tokio::io::AsyncWriteExt;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| anyhow!("download: {e}"))? {
        file.write_all(&chunk)
            .await
            .map_err(|e| anyhow!("write {}: {e}", dest.display()))?;
        received += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        if since_emit >= 262_144
            || (since_emit > 0 && last_emit.elapsed() >= std::time::Duration::from_millis(100))
        {
            since_emit = 0;
            last_emit = std::time::Instant::now();
            emit_progress(
                app,
                &PairingProgress {
                    remote_name: remote_name.to_string(),
                    phase: "download".into(),
                    received,
                    total,
                    error: None,
                },
            );
        }
    }
    file.flush().await.map_err(|e| anyhow!("flush: {e}"))?;
    Ok(received)
}

// ── client commands (all targets) ───────────────────────────────────────────

/// Normalize a host typed by the user: trim, strip an accidental
/// `http(s)://` prefix (the protocol is fixed plain-HTTP v1).
pub(super) fn clean_host(host: &str) -> String {
    let h = host.trim();
    h.strip_prefix("https://")
        .or_else(|| h.strip_prefix("http://"))
        .unwrap_or(h)
        .trim_end_matches('/')
        .to_string()
}

/// Map a pairing-server error response onto the clean strings the frontend
/// toasts (the web mock and the Rust server agree on these).
pub(crate) fn http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 => "invalid or expired token".to_string(),
        403 => "invalid PIN".to_string(),
        404 => "not found on the host".to_string(),
        429 => "too many attempts, wait a moment and retry".to_string(),
        503 => "the host is still preparing game data".to_string(),
        _ => format!("HTTP {status}"),
    }
}

// ── target helpers (LAN vs relay dispatch) ───────────────────────────────────

/// `(host, port)` of a LAN target.
pub(super) fn lan_parts(target: &PairingTarget) -> Result<(String, u16)> {
    match target {
        PairingTarget::Lan { host, port } => {
            let host = clean_host(host);
            if host.is_empty() {
                bail!("empty host");
            }
            Ok((host, *port))
        },
        PairingTarget::Relay { .. } => bail!("this call needs a LAN target"),
    }
}

/// `(ws base, room)` of a relay target — the room key is REQUIRED here (only
/// `pairing_pair` may derive it, from the pin it is handed).
pub(super) fn relay_parts(target: &PairingTarget) -> Result<(String, String)> {
    match target {
        PairingTarget::Lan { .. } => bail!("this call needs a relay target"),
        PairingTarget::Relay { url, room } => {
            let room = room
                .clone()
                .filter(|r| !r.is_empty())
                .ok_or_else(|| anyhow!("relay session missing its room key"))?;
            Ok((
                crate::commands::pairing_relay::normalize_relay_ws_url(url)?,
                room,
            ))
        },
    }
}

/// PIN exchange: prove a human read the desktop's screen, obtain the bearer
/// token for the data routes. Wrong PIN → `Err("invalid PIN")` (matching the
/// web mock's string so the UI shows the same toast either way). Relay mode
/// derives the room key from the pin and hands it back in the result so the
/// session's later tunnels can be addressed without re-asking for the pin.
#[tauri::command]
pub async fn pairing_pair(target: PairingTarget, pin: String) -> CommandResult<PairingToken> {
    match &target {
        PairingTarget::Lan { .. } => {
            let (host, port) = lan_parts(&target)?;
            let client = super::network::build_http_client()?;
            let url = format!("http://{host}:{port}/pair");
            let resp = client
                .post(&url)
                .json(&serde_json::json!({ "pin": pin }))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| anyhow!("cannot reach {host}:{port} ({e})"))?;
            if !resp.status().is_success() {
                return Err(anyhow!("{}", http_error(resp.status())).into());
            }
            let mut token = resp
                .json::<PairingToken>()
                .await
                .map_err(|e| anyhow!("pairing response parse: {e}"))?;
            token.room = None;
            Ok(token)
        },
        PairingTarget::Relay { url, .. } => {
            let ws_base = crate::commands::pairing_relay::normalize_relay_ws_url(url)?;
            Ok(crate::commands::pairing_relay::relay_pair(&ws_base, pin.trim()).await?)
        },
    }
}

/// List the paired desktop's replays — same `ReplayMetaLite` DTO the local
/// `list_replays_meta` returns, with `path` projected onto the remote name
/// (root-relative, forward slashes) that `pairing_pull_replay` takes back.
#[tauri::command]
pub async fn pairing_list_remote(
    target: PairingTarget,
    token: String,
) -> CommandResult<Vec<ReplayMetaLite>> {
    match &target {
        PairingTarget::Lan { .. } => {
            let (host, port) = lan_parts(&target)?;
            let client = super::network::build_http_client()?;
            let resp = client
                .get(format!("http://{host}:{port}/api/replays"))
                .bearer_auth(&token)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| anyhow!("cannot reach {host}:{port} ({e})"))?;
            if !resp.status().is_success() {
                return Err(anyhow!("{}", http_error(resp.status())).into());
            }
            Ok(resp
                .json::<Vec<ReplayMetaLite>>()
                .await
                .map_err(|e| anyhow!("replay list parse: {e}"))?)
        },
        PairingTarget::Relay { .. } => {
            let (ws_base, room) = relay_parts(&target)?;
            Ok(crate::commands::pairing_relay::relay_list_remote(&ws_base, &room, &token).await?)
        },
    }
}

/// Monotonic suffix for in-flight download parts: two concurrent pulls whose
/// sanitized LOCAL names collide (subdir flattening can do it) must never
/// write the same `.part` file.
fn part_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Pull one remote replay into the managed replays dir. Byte progress rides
/// `wowsp://pairing-progress` (filter by `remoteName`); the promise resolves
/// with the local path once done.
#[tauri::command]
pub async fn pairing_pull_replay(
    app: AppHandle,
    target: PairingTarget,
    token: String,
    remote_name: String,
) -> CommandResult<PairingPathResult> {
    if remote_name.is_empty() {
        return Err(anyhow!("empty remote name").into());
    }
    let local_name = sanitize_replay_name(&remote_name)?;
    let dir = managed_replays_dir()?;
    let final_path = dir.join(&local_name);
    let seq = part_seq();
    let part = final_path.with_file_name(format!(
        "{}.{seq}.part",
        final_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| local_name.clone())
    ));

    match &target {
        PairingTarget::Lan { .. } => {
            let (host, port) = lan_parts(&target)?;
            let client = super::network::build_http_client()?;
            let resp = client
                .get(format!(
                    "http://{host}:{port}/api/replay/{}",
                    encode_path_segment(&remote_name)
                ))
                .bearer_auth(&token)
                .timeout(std::time::Duration::from_secs(3600))
                .send()
                .await
                .map_err(|e| anyhow!("cannot reach {host}:{port} ({e})"))?;
            if !resp.status().is_success() {
                return Err(anyhow!("{}", http_error(resp.status())).into());
            }
            let mut resp = resp;
            let received = stream_to_file(&app, &mut resp, &part, &remote_name).await;
            finish_replay_pull(app, received, part, final_path, remote_name).await
        },
        PairingTarget::Relay { .. } => {
            let (ws_base, room) = relay_parts(&target)?;
            let received = crate::commands::pairing_relay::relay_pull_replay(
                Some(&app),
                &ws_base,
                &room,
                &token,
                &remote_name,
                &part,
            )
            .await;
            finish_replay_pull(app, received, part, final_path, remote_name).await
        },
    }
}

/// Copy a completed download into a newly reserved file. Both files live in
/// the replay directory, but a no-replace hard link is not available on every
/// supported filesystem (for example removable game drives).
pub(super) fn finalize_replay_part(part: &Path, proposed_path: &Path) -> Result<PathBuf> {
    let dir = proposed_path
        .parent()
        .ok_or_else(|| anyhow!("missing replay directory"))?;
    let name = proposed_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("invalid replay file name"))?;
    let mut source =
        std::fs::File::open(part).map_err(|e| anyhow!("read {}: {e}", part.display()))?;
    let result = write_replay_file(dir, name, |dest| {
        std::io::copy(&mut source, dest).map(|_| ())
    });
    drop(source);
    if result.is_ok() {
        let _ = std::fs::remove_file(part);
    }
    result
}

/// Shared tail of both pull paths: finalize the `.part` file, emit the
/// terminal progress event, clean up on failure (including finalization).
async fn finish_replay_pull(
    app: AppHandle,
    received: Result<u64>,
    part: PathBuf,
    final_path: PathBuf,
    remote_name: String,
) -> CommandResult<PairingPathResult> {
    let result = match received {
        Ok(n) => {
            let source = part.clone();
            tokio::task::spawn_blocking(move || finalize_replay_part(&source, &final_path))
                .await
                .map_err(|e| anyhow!("replay finalization task failed: {e}"))
                .and_then(|result| result)
                .map(|path| (n, path))
        },
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&part);
    match result {
        Ok((n, final_path)) => {
            emit_progress(
                &app,
                &PairingProgress {
                    remote_name: remote_name.clone(),
                    phase: "done".into(),
                    received: n,
                    total: n,
                    error: None,
                },
            );
            tracing::info!(remote = %remote_name, bytes = n, "pairing pull done");
            Ok(PairingPathResult {
                path: final_path.to_string_lossy().into_owned(),
            })
        },
        Err(e) => {
            emit_progress(
                &app,
                &PairingProgress {
                    remote_name: remote_name.clone(),
                    phase: "error".into(),
                    received: 0,
                    total: 0,
                    // The event payload needs an owned String and anyhow
                    // errors are not Clone — the Display text (identical to
                    // the historical message) is what the UI toasts.
                    error: Some(e.to_string()),
                },
            );
            Err(e.into())
        },
    }
}
