//! Mobile ↔ desktop pairing: LAN replay acquisition + game-data sync.
//!
//! Two roles live in this module:
//!
//! - **SERVER (desktop only, `#[cfg(desktop)]`)** — a deliberately tiny
//!   hand-rolled HTTP/1.1 server on the existing tokio runtime. The phone
//!   picks the desktop from the live discovery list (see
//!   commands/pairing_discovery.rs) — or types its address by hand — enters
//!   the 6-digit PIN shown in the desktop settings, and receives a bearer
//!   token for the data routes:
//!
//!   ```text
//!   POST /pair              {"pin": "123456"}        → 200 {"token": "..."}
//!                                                      429 while throttled
//!   GET  /api/ping                                   → 200 {"ok": true}
//!   GET  /api/replays        (Bearer / ?token=)      → 200 [ReplayMetaLite…]
//!   GET  /api/replay/<name>  (auth)                  → 200 replay bytes
//!   GET  /api/gamedata       (auth)                  → 200 zip of the
//!                                                      gameparams/encyclopedia
//!                                                      AppData caches;
//!                                                      503 + Retry-After
//!                                                      while the zip is
//!                                                      still being built
//!   anything else                                     → 404
//!   ```
//!
//!   No framework, no new dependency: requests are tiny JSON or file streams,
//!   every response is `Connection: close`, and the whole thing must keep
//!   compiling for cargo-deny without new licenses. Enumeration reuses
//!   [`super::replay::scan_replays_meta`] — the SAME walk the local list
//!   command uses, never a duplicate. While the server runs, the UDP
//!   discovery broadcaster announces it and — unless disabled in the hidden
//!   relay config — the gateway host bridge (commands/pairing_relay.rs)
//!   tunnels the same routes through the built-in Cloudflare gateway,
//!   displaying the gateway-allocated pairing code.
//!
//! - **CLIENT (all targets)** — `pairing_pair` / `pairing_list_remote` /
//!   `pairing_pull_replay` / `pairing_pull_gamedata` over a
//!   [`PairingTarget`]: direct LAN HTTP via reqwest (through
//!   [`super::network::http_client_builder`] so the Android rustls trust
//!   setup applies), or the same protocol bytes tunneled through the built-in
//!   gateway (the phone resolves its pairing code to a room first). Pulls
//!   report progress on `wowsp://pairing-progress` with the
//!   same throttling as the resource-pack downloads (~256 KB or ~100 ms,
//!   whatever comes first).
//!
//! Security posture (LAN pairing, v2): the server binds 0.0.0.0 on purpose
//! — reaching any phone on the LAN is the feature, which by construction
//! means anyone on that LAN can also connect. In place: the PIN and the
//! bearer token are drawn from the OS CSPRNG (`getrandom`), the token is a
//! 256-bit hex compared in constant time, wrong PINs are throttled (5
//! consecutive failures → 429 for a 10 s window; a correct PIN resets the
//! counter), request head+body must fully arrive within 60 s (slowloris
//! bound) while response streaming is deliberately unbounded so large
//! pulls are never cut mid-stream, and file routes only touch paths the
//! enumeration itself produced. NOT in place: plain HTTP means the token
//! and the transferred data are sniffable and replayable by anyone on the
//! LAN — the throttle slows PIN guessing (10^6 keyspace, a burst of ~5
//! attempts per 10 s window) but does nothing about a sniffed token.
//! Never expose this port beyond the trusted LAN.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{
    GamedataSyncResult, PairingPathResult, PairingProgress, PairingStatus, PairingTarget,
    PairingToken, ReplayMetaLite,
};

/// Progress event channel (mirrors `wowsp://res-progress` plumbing).
pub const PAIRING_PROGRESS_EVENT: &str = "wowsp://pairing-progress";
/// Sentinel `remoteName` marking the game-data zip sync on the shared
/// progress stream (no single "file" name to key on otherwise).
pub const GAMEDATA_SENTINEL: &str = ":gamedata:";

// ── managed replays dir + filename handling (all targets) ───────────────────

/// The directory imported / pulled replays land in — the SAME directory the
/// local listing reads, so a file that arrives is immediately visible:
/// - desktop: the resolved default replay dir (explicit env override → the
///   unified game context's user-scoped order: persisted active install →
///   running client → first detected install);
/// - mobile: `<app_data>/replays` (there is no game install on a phone).
pub(crate) fn managed_replays_dir() -> Result<PathBuf, String> {
    let dir = super::replay::resolve_replay_dir(None)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Reduce a caller-supplied "file name" to a safe single path component and
/// normalize the extension. Strips any directory components (the basename
/// wins), replaces Windows-forbidden / control characters with `_`, and
/// appends the `.wowsreplay` suffix when missing. Rejects empty names,
/// dotfiles and pure dot-junk.
pub fn sanitize_replay_name(raw: &str) -> Result<String, String> {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if base.is_empty() || base.starts_with('.') || base.chars().all(|c| c == '.') {
        return Err("invalid replay file name".to_string());
    }
    let mut cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Length cap (chars, not bytes — the suffix is ASCII so this is safe):
    // keep room for the extension.
    let max_len = 180 + ".wowsreplay".len();
    if cleaned.chars().count() > max_len {
        cleaned = cleaned.chars().take(max_len).collect();
    }
    if !cleaned.to_ascii_lowercase().ends_with(".wowsreplay") {
        cleaned.push_str(".wowsreplay");
    }
    Ok(cleaned)
}

/// `name (1).ext`, `name (2).ext`, … — first free slot wins. The final
/// fallback (1000 collisions) stamps the epoch millis to stay unique.
pub fn dedupe_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    for i in 1..1000u32 {
        let cand = dir.join(format!("{stem} ({i}).{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!(
        "{stem}-{}.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        ext
    ))
}

/// Write replay bytes into the managed dir: sanitize → dedupe → write.
/// Returns the final local path.
fn store_replay_bytes(dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<String, String> {
    let name = sanitize_replay_name(raw_name)?;
    let path = dedupe_path(dir, &name);
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Import one `.wowsreplay` picked through the webui's HTML file input into
/// the managed replays dir. The bytes travel as a RAW IPC body (same
/// mechanism as `write_export_bytes` — a multi-MB replay as a JSON number
/// array would balloon the IPC message); the file name rides the
/// percent-encoded `x-replay-name` header. Registered on ALL targets: the
/// desktop writes into its own default replay dir so the local list sees the
/// import too, mobile into `<app_data>/replays`.
#[tauri::command]
pub async fn import_replay_file(
    request: tauri::ipc::Request<'_>,
) -> Result<PairingPathResult, String> {
    let encoded = request
        .headers()
        .get("x-replay-name")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing x-replay-name header".to_string())?;
    let name = super::exports::percent_decode(encoded)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("expected raw body (pass a Uint8Array to invokeRaw)".into()),
    };
    tokio::task::spawn_blocking(move || {
        let dir = managed_replays_dir()?;
        let len = bytes.len();
        let path = store_replay_bytes(&dir, &name, &bytes)?;
        tracing::info!(path = %path, bytes = len, "replay imported");
        Ok(PairingPathResult { path })
    })
    .await
    .map_err(|e| format!("replay import task failed: {e}"))?
}

// ── progress plumbing (all targets) ─────────────────────────────────────────

/// Emit one progress event (mirrors model_pack's emit_progress).
pub(crate) fn emit_progress(app: &AppHandle, progress: &PairingProgress) {
    let _ = app.emit(PAIRING_PROGRESS_EVENT, progress);
}

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
async fn stream_to_file(
    app: &AppHandle,
    resp: &mut reqwest::Response,
    dest: &Path,
    remote_name: &str,
) -> Result<u64, String> {
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create {}: {e}", dest.display()))?;
    use tokio::io::AsyncWriteExt;
    let mut received = 0u64;
    let mut since_emit = 0u64;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download: {e}"))? {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {}: {e}", dest.display()))?;
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
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(received)
}

// ── client commands (all targets) ───────────────────────────────────────────

/// Normalize a host typed by the user: trim, strip an accidental
/// `http(s)://` prefix (the protocol is fixed plain-HTTP v1).
fn clean_host(host: &str) -> String {
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
fn lan_parts(target: &PairingTarget) -> Result<(String, u16), String> {
    match target {
        PairingTarget::Lan { host, port } => {
            let host = clean_host(host);
            if host.is_empty() {
                return Err("empty host".to_string());
            }
            Ok((host, *port))
        },
        PairingTarget::Relay { .. } => Err("this call needs a LAN target".to_string()),
    }
}

/// `(ws base, room)` of a relay target — the room key is REQUIRED here (only
/// `pairing_pair` may derive it, from the pin it is handed).
fn relay_parts(target: &PairingTarget) -> Result<(String, String), String> {
    match target {
        PairingTarget::Lan { .. } => Err("this call needs a relay target".to_string()),
        PairingTarget::Relay { url, room } => {
            let room = room
                .clone()
                .filter(|r| !r.is_empty())
                .ok_or_else(|| "relay session missing its room key".to_string())?;
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
pub async fn pairing_pair(target: PairingTarget, pin: String) -> Result<PairingToken, String> {
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
                .map_err(|e| format!("cannot reach {host}:{port} ({e})"))?;
            if !resp.status().is_success() {
                return Err(http_error(resp.status()));
            }
            let mut token = resp
                .json::<PairingToken>()
                .await
                .map_err(|e| format!("pairing response parse: {e}"))?;
            token.room = None;
            Ok(token)
        },
        PairingTarget::Relay { url, .. } => {
            let ws_base = crate::commands::pairing_relay::normalize_relay_ws_url(url)?;
            crate::commands::pairing_relay::relay_pair(&ws_base, pin.trim()).await
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
) -> Result<Vec<ReplayMetaLite>, String> {
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
                .map_err(|e| format!("cannot reach {host}:{port} ({e})"))?;
            if !resp.status().is_success() {
                return Err(http_error(resp.status()));
            }
            resp.json::<Vec<ReplayMetaLite>>()
                .await
                .map_err(|e| format!("replay list parse: {e}"))
        },
        PairingTarget::Relay { .. } => {
            let (ws_base, room) = relay_parts(&target)?;
            crate::commands::pairing_relay::relay_list_remote(&ws_base, &room, &token).await
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
) -> Result<PairingPathResult, String> {
    if remote_name.is_empty() {
        return Err("empty remote name".to_string());
    }
    let local_name = sanitize_replay_name(&remote_name)?;
    let dir = managed_replays_dir()?;
    let final_path = dedupe_path(&dir, &local_name);
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
                .map_err(|e| format!("cannot reach {host}:{port} ({e})"))?;
            if !resp.status().is_success() {
                return Err(http_error(resp.status()));
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

/// Shared tail of both pull paths: finalize the `.part` file, emit the
/// terminal progress event, clean up on failure.
async fn finish_replay_pull(
    app: AppHandle,
    received: Result<u64, String>,
    part: PathBuf,
    final_path: PathBuf,
    remote_name: String,
) -> Result<PairingPathResult, String> {
    match received {
        Ok(n) => {
            std::fs::rename(&part, &final_path)
                .map_err(|e| format!("finalize {}: {e}", final_path.display()))?;
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
            let _ = std::fs::remove_file(&part);
            emit_progress(
                &app,
                &PairingProgress {
                    remote_name: remote_name.clone(),
                    phase: "error".into(),
                    received: 0,
                    total: 0,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        },
    }
}

/// Download the desktop's game-data caches (a zip of `<data>/gameparams/**`
/// + `<data>/encyclopedia/**`) and extract them into the local data dir,
/// merging over what is already there. Progress rides the same
/// `wowsp://pairing-progress` stream under the `":gamedata:"` sentinel.
///
/// The host builds the zip in the background when its server starts, so the
/// first GET can legitimately answer 503 + Retry-After — retried here with
/// patient naps (honoring Retry-After, bounded by a 120 s total budget)
/// while the wizard shows its existing "syncing" state.
#[tauri::command]
pub async fn pairing_pull_gamedata(
    app: AppHandle,
    target: PairingTarget,
    token: String,
) -> Result<GamedataSyncResult, String> {
    /// Total client-side budget for waiting out a "zip still building" 503
    /// from the host. Generous (the desktop deflates a few hundred MB) but
    /// finite, so a wedged build surfaces as an error instead of a hang.
    const GAMEDATA_PREPARE_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);
    /// Fallback nap between 503 retries when the host sent no usable
    /// Retry-After (seconds). Matches the server's own hint.
    const GAMEDATA_RETRY_AFTER_FALLBACK_SECS: u64 = 2;

    let cache = crate::paths::ensure_cache_dir()?;
    let part = cache.join("pairing-gamedata.zip.part");
    let started = std::time::Instant::now();

    let status_is_success = match &target {
        PairingTarget::Lan { .. } => {
            let (host, port) = lan_parts(&target)?;
            let client = super::network::build_http_client()?;
            let url = format!("http://{host}:{port}/api/gamedata");
            let resp = loop {
                let resp = client
                    .get(&url)
                    .bearer_auth(&token)
                    .timeout(std::time::Duration::from_secs(3600))
                    .send()
                    .await
                    .map_err(|e| format!("cannot reach {host}:{port} ({e})"))?;
                if resp.status().as_u16() == 503 && started.elapsed() < GAMEDATA_PREPARE_BUDGET {
                    let nap = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .filter(|s| (1..=10).contains(s))
                        .unwrap_or(GAMEDATA_RETRY_AFTER_FALLBACK_SECS);
                    tracing::info!(nap_secs = nap, "host still building gamedata zip, retrying");
                    tokio::time::sleep(std::time::Duration::from_secs(nap)).await;
                    continue;
                }
                break resp;
            };
            let status = resp.status();
            if status.as_u16() == 404 {
                // The desktop has no game-data caches yet — clean, expected.
                return Err("no game data available on the host".to_string());
            }
            if !status.is_success() {
                return Err(http_error(status));
            }
            let mut resp = resp;
            stream_to_file(&app, &mut resp, &part, GAMEDATA_SENTINEL)
                .await
                .map(|_| ())
        },
        PairingTarget::Relay { .. } => {
            let (ws_base, room) = relay_parts(&target)?;
            crate::commands::pairing_relay::relay_pull_gamedata(
                Some(&app),
                &ws_base,
                &room,
                &token,
                &part,
            )
            .await
        },
    };

    if let Err(e) = status_is_success {
        let _ = std::fs::remove_file(&part);
        emit_progress(
            &app,
            &PairingProgress {
                remote_name: GAMEDATA_SENTINEL.to_string(),
                phase: "error".into(),
                received: 0,
                total: 0,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }
    let data_dir = crate::paths::ensure_data_dir()?;
    let extract = {
        let part = part.clone();
        tokio::task::spawn_blocking(move || extract_gamedata_zip(&part, &data_dir))
            .await
            .map_err(|e| format!("gamedata extract task failed: {e}"))?
    };
    let _ = std::fs::remove_file(&part);
    match extract {
        Ok(files) => {
            emit_progress(
                &app,
                &PairingProgress {
                    remote_name: GAMEDATA_SENTINEL.to_string(),
                    phase: "done".into(),
                    received: 0,
                    total: files as u64,
                    error: None,
                },
            );
            tracing::info!(files, "gamedata sync done");
            Ok(GamedataSyncResult { files })
        },
        Err(e) => {
            emit_progress(
                &app,
                &PairingProgress {
                    remote_name: GAMEDATA_SENTINEL.to_string(),
                    phase: "error".into(),
                    received: 0,
                    total: 0,
                    error: Some(e.clone()),
                },
            );
            Err(e)
        },
    }
}

/// Zip-slip-safe extraction of the game-data zip into the data dir
/// (merge/overwrite). Entry names must be relative, stay inside the
/// destination, and use forward slashes only per the zip spec: `enclosed_name`
/// rejects `..` and absolute components, and the RAW name check rejects
/// backslashes — necessary because on Windows `enclosed_name()` normalizes
/// separators, so a hostile packer could otherwise smuggle `..\` components
/// past a naive display-string check (and legit nested entries must NOT be
/// rejected for the normalization either).
pub(crate) fn extract_gamedata_zip(archive: &Path, dest: &Path) -> Result<usize, String> {
    let file =
        std::fs::File::open(archive).map_err(|e| format!("open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("read {}: {e}", archive.display()))?;
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.name().contains('\\') || entry.name().contains(':') {
            tracing::warn!(entry = entry.name(), "gamedata zip: skipping unsafe entry");
            continue;
        }
        let Some(rel) = entry.enclosed_name() else {
            tracing::warn!(entry = entry.name(), "gamedata zip: skipping unsafe entry");
            continue;
        };
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir {}: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut fout =
            std::fs::File::create(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut fout)
            .map_err(|e| format!("extract {}: {e}", out.display()))?;
        extracted += 1;
    }
    Ok(extracted)
}

// ── start / stop / status commands ──────────────────────────────────────────

/// Error marker for the mobile stand-ins (R1's mobile_unsupported style).
#[cfg(mobile)]
use crate::mobile_unsupported::PAIRING as PAIRING_SERVER_UNSUPPORTED;

/// Start the desktop pairing server. Mobile answers with the unsupported
/// marker (the settings section that calls this is desktop-only anyway).
#[tauri::command]
pub async fn pairing_start() -> Result<PairingStatus, String> {
    #[cfg(mobile)]
    {
        return Err(PAIRING_SERVER_UNSUPPORTED.to_string());
    }
    #[cfg(desktop)]
    {
        server::pairing_start().await
    }
}

/// Stop the desktop pairing server.
#[tauri::command]
pub async fn pairing_stop() -> Result<(), String> {
    #[cfg(mobile)]
    {
        return Err(PAIRING_SERVER_UNSUPPORTED.to_string());
    }
    #[cfg(desktop)]
    {
        server::pairing_stop().await
    }
}

/// Current server state. Always `{ running: false }` on mobile.
#[tauri::command]
pub fn pairing_get_status() -> PairingStatus {
    #[cfg(mobile)]
    {
        PairingStatus {
            running: false,
            host: None,
            port: None,
            pin: None,
            mode: None,
            relay_online: false,
            provider: None,
            via_upstream: false,
            notice: None,
        }
    }
    #[cfg(desktop)]
    {
        server::current_status()
    }
}

/// The desktop-side pairing server. Everything below is `#[cfg(desktop)]`.
#[cfg(desktop)]
pub(crate) mod server {
    use std::net::{Ipv4Addr, TcpListener as StdListener};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, OnceLock};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{Mutex, watch};

    use super::super::exports::percent_decode;
    use super::super::replay;
    use crate::paths;
    use wowsp_tauri_shared::PairingStatus;

    /// Preferred port (cosmetic — the phone's saved entry stays valid across
    /// restarts); falls back to an ephemeral one when taken.
    const PREFERRED_PORT: u16 = 58041;
    /// Header block cap; anything larger is not one of our requests.
    const MAX_HEAD: usize = 32 * 1024;
    /// `/pair` body cap (the PIN JSON is ~30 bytes).
    const MAX_BODY: usize = 8 * 1024;
    /// Per-REQUEST deadline (slowloris bound): the head plus any request
    /// body must fully arrive within this window. Response streaming is
    /// deliberately UNbounded — the gamedata zip and big replay pulls take
    /// minutes, and the client already allows itself 3600 s.
    const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    /// Consecutive wrong PINs that trip the /pair lockout.
    const PIN_MAX_FAILURES: u32 = 5;
    /// How long a tripped /pair lockout lasts (anchored at the failure that
    /// tripped it; a correct PIN resets the counter).
    const PIN_BLOCK_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);
    /// How long /api/gamedata waits for the background zip build before
    /// answering 503 + Retry-After (a request that lands moments before
    /// completion still gets served instead of bounced).
    const GAMEDATA_BUILD_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    /// Retry-After (seconds) the 503 carries while the zip is building.
    const GAMEDATA_RETRY_AFTER_SECS: u64 = 2;

    // ── state ────────────────────────────────────────────────────────────────

    #[derive(Default)]
    struct ServerState {
        running: bool,
        host: String,
        port: u16,
        pin: String,
        /// The 64-hex random room id for this run (relay v2: minted here,
        /// shared with the gateway bridge and echoed in /pair responses —
        /// never derived from the pin).
        room: String,
        shutdown: Option<watch::Sender<bool>>,
        task: Option<tokio::task::JoinHandle<()>>,
    }

    fn status_of(st: &ServerState) -> PairingStatus {
        if st.running {
            // Relay v2: while the built-in gateway has answered with a
            // pairing code, THAT code is what the desktop displays (and the
            // phone types). Offline gateway → the locally-generated LAN PIN
            // + a LAN-only status the UI hints on.
            let code = crate::commands::pairing_relay::current_relay_code();
            let relay_online = code.is_some();
            // Gateway manifest info (provider / viaUpstream / notice) rides
            // the status only while the gateway is actually online.
            let gw = crate::commands::pairing_relay::current_gateway_info();
            PairingStatus {
                running: true,
                host: Some(st.host.clone()),
                port: Some(st.port),
                pin: Some(code.unwrap_or_else(|| st.pin.clone())),
                mode: Some(if relay_online { "relay" } else { "lan-local" }.into()),
                relay_online,
                provider: relay_online.then(|| gw.provider.clone()).flatten(),
                via_upstream: relay_online && gw.via_upstream,
                notice: relay_online.then(|| gw.notice.clone()).flatten(),
            }
        } else {
            PairingStatus {
                running: false,
                host: None,
                port: None,
                pin: None,
                mode: None,
                relay_online: false,
                provider: None,
                via_upstream: false,
                notice: None,
            }
        }
    }

    fn state() -> &'static Mutex<ServerState> {
        static SERVER: OnceLock<Mutex<ServerState>> = OnceLock::new();
        SERVER.get_or_init(|| Mutex::new(ServerState::default()))
    }

    pub fn current_status() -> PairingStatus {
        status_of(&state().blocking_lock())
    }

    /// Async twin of `current_status` for call sites already inside a tokio
    /// worker (async commands): `blocking_lock` panics there on tokio 1.x.
    pub async fn current_status_async() -> PairingStatus {
        let st = state().lock().await;
        status_of(&st)
    }

    /// `(port, room)` while the server is running — the relay host session
    /// needs both (the gateway room is the run's random 64-hex id; the
    /// bridge dials 127.0.0.1:port for tunnel conns).
    pub async fn server_snapshot() -> Option<(u16, String)> {
        let st = state().lock().await;
        st.running.then(|| (st.port, st.room.clone()))
    }

    /// Everything the connection handlers need; shared via Arc. The token is
    /// readable from the state snapshot for diagnostics — kept here only.
    struct Shared {
        pin: String,
        token: String,
        /// The run's random room id, echoed in the /pair success body so a
        /// relay phone can address its later tunnels without asking the
        /// gateway again (LAN phones ignore it).
        room: String,
        replay_root: PathBuf,
        /// Game-data zip availability for THIS server run: `Building` until
        /// the background build spawned at start finishes, then the final
        /// result (None = no caches on this desktop → the route 404s).
        gamedata: watch::Receiver<GamedataState>,
        /// /pair brute-force throttle (see [`PinThrottle`]). Std mutex: the
        /// critical sections are two integer writes, never held across an
        /// await. Fresh per server run.
        pin_throttle: std::sync::Mutex<PinThrottle>,
        shutdown: watch::Receiver<bool>,
    }

    /// One-shot state of the background game-data zip build.
    #[derive(Clone)]
    enum GamedataState {
        Building,
        Ready(Result<Option<PathBuf>, String>),
    }

    /// PIN brute-force throttle, dependency-free and pure so the behavior is
    /// unit-testable: after [`PIN_MAX_FAILURES`] consecutive wrong PINs the
    /// exchange rejects EVERY attempt (correct PIN included — the check runs
    /// before the comparison) until a [`PIN_BLOCK_WINDOW`] has passed since
    /// the failure that tripped the limit. A correct PIN resets the counter;
    /// failures keep accumulating across expired windows, so a persistent
    /// guesser settles into one guess per window.
    #[derive(Default)]
    struct PinThrottle {
        consecutive_failures: u32,
        blocked_until: Option<std::time::Instant>,
    }

    impl PinThrottle {
        /// `Ok(())`, or the remaining duration of the current lockout.
        fn check(&self, now: std::time::Instant) -> Result<(), std::time::Duration> {
            match self.blocked_until {
                Some(until) if now < until => Err(until - now),
                _ => Ok(()),
            }
        }

        fn record_failure(&mut self, now: std::time::Instant) {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            if self.consecutive_failures >= PIN_MAX_FAILURES {
                self.blocked_until = Some(now + PIN_BLOCK_WINDOW);
            }
        }

        fn record_success(&mut self) {
            self.consecutive_failures = 0;
            self.blocked_until = None;
        }
    }

    /// Handle to a running server (also the test surface): the minted token
    /// plus the shutdown signal.
    pub struct ServerHandle {
        #[allow(dead_code)] // read via Debug/diagnostics in tests
        pub token: String,
        shutdown: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    impl ServerHandle {
        /// Signal shutdown and WAIT for the accept loop to exit, so a
        /// restart on the same port cannot race the old listener.
        pub async fn stop(self) {
            let _ = self.shutdown.send(true);
            let _ = self.task.await;
        }
    }

    // ── start / stop ────────────────────────────────────────────────────────

    pub async fn pairing_start() -> Result<PairingStatus, String> {
        // Fast path: already running (idempotent start).
        {
            let st = state().lock().await;
            if st.running {
                return Ok(status_of(&st));
            }
        }
        let listener = bind_listener().await?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("pairing port: {e}"))?
            .port();
        let host = lan_ipv4();
        let pin = random_digits(6)?;
        let token = random_token()?;
        // Relay v2 room identity: a fresh random 64-hex id per run — the
        // gateway binds its allocated pairing code to THIS id; nothing is
        // ever derived from the pin.
        let room = random_token()?;
        let replay_root = replay::resolve_replay_dir(None)?;
        // Game-data zip: rebuilt on every start so the phone never sees a
        // stale cache snapshot (existing semantics), cached for this server
        // run — but built IN THE BACKGROUND so the status (and the settings
        // toggle behind it) returns immediately: a few hundred MB of
        // per-ship JSON deflates on the blocking pool while /api/gamedata
        // answers 503 + Retry-After until the zip lands.
        let (gd_tx, gd_rx) = watch::channel(GamedataState::Building);
        tokio::spawn(async move {
            let res = build_gamedata_zip().await;
            match &res {
                Ok(Some(p)) => {
                    tracing::info!(zip = %p.display(), "pairing gamedata zip ready");
                },
                Ok(None) => {
                    tracing::info!("pairing: no game-data caches, /api/gamedata will 404");
                },
                Err(e) => tracing::warn!(error = %e, "pairing gamedata zip build failed"),
            }
            let _ = gd_tx.send(GamedataState::Ready(res));
        });
        let (tx, rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            pin: pin.clone(),
            token: token.clone(),
            room: room.clone(),
            replay_root,
            gamedata: gd_rx,
            pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
            shutdown: rx,
        });
        let task = tokio::spawn(serve(listener, shared));
        {
            let mut st = state().lock().await;
            // A concurrent start won the race — stop ours and report theirs.
            if st.running {
                drop(st);
                ServerHandle {
                    token,
                    shutdown: tx,
                    task,
                }
                .stop()
                .await;
                let st = state().lock().await;
                return Ok(status_of(&st));
            }
            st.running = true;
            st.host = host;
            st.port = port;
            st.pin = pin;
            st.room = room.clone();
            st.shutdown = Some(tx);
            st.task = Some(task);
        }
        // Sidecars, strictly AFTER the state-lock win so a lost race never
        // leaves them running: the UDP discovery broadcaster and — unless
        // disabled in the hidden config — the relay host bridge toward the
        // built-in gateway. Discovery no longer advertises a relay URL:
        // the endpoint is built into both apps.
        if let Err(e) = crate::commands::pairing_discovery::broadcast_start(port, None) {
            tracing::warn!(error = %e, "discovery broadcaster failed to start");
        }
        let relay_cfg = crate::commands::pairing_relay::load_relay_config();
        if relay_cfg.enabled {
            let root = crate::commands::pairing_relay::builtin_relay_root();
            if let Err(e) =
                crate::commands::pairing_relay::host_session_start(&root, port, &room).await
            {
                tracing::warn!(error = %e, "relay host session failed to start");
            }
            // Bounded wait so the status returned to the UI already carries
            // the gateway-allocated code when the gateway answers. A timeout
            // just means LAN-only for now: the bridge keeps retrying in the
            // background and the next status refresh picks the code up.
            if let Err(e) =
                crate::commands::pairing_relay::wait_for_code(std::time::Duration::from_secs(10))
                    .await
            {
                tracing::info!(error = %e, "relay gateway unreachable — LAN-only pairing for now");
            }
        } else {
            tracing::info!("internet gateway disabled by config — LAN-only pairing");
        }
        let st = state().lock().await;
        tracing::info!(host = %st.host, port, mode = ?status_of(&st).mode, "pairing server started");
        Ok(status_of(&st))
    }

    pub async fn pairing_stop() -> Result<(), String> {
        let joined = {
            let mut st = state().lock().await;
            st.running = false;
            st.host.clear();
            st.pin.clear();
            st.room.clear();
            st.port = 0;
            st.shutdown.take().zip(st.task.take())
        };
        if let Some((tx, task)) = joined {
            let _ = tx.send(true);
            // Bounded wait: the accept loop only parks on accept/shutdown, so
            // it exits immediately; the bound guards against a pathological
            // in-flight request hanging stop forever.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), task).await;
        }
        crate::commands::pairing_discovery::broadcast_stop().await;
        crate::commands::pairing_relay::host_session_stop().await;
        tracing::info!("pairing server stopped");
        Ok(())
    }

    /// Preferred port first, ephemeral fallback.
    async fn bind_listener() -> Result<TcpListener, String> {
        match TcpListener::bind(("0.0.0.0", PREFERRED_PORT)).await {
            Ok(l) => Ok(l),
            Err(_) => TcpListener::bind(("0.0.0.0", 0))
                .await
                .map_err(|e| format!("bind pairing server: {e}")),
        }
    }

    /// First non-loopback IPv4 via the UDP-connect trick: connecting a UDP
    /// socket sends nothing but makes the OS pick the default-route
    /// interface; its local address is the LAN IP the phone can reach. The
    /// notional peer uses the RFC 5737 documentation block so no real host
    /// is ever contacted. Falls back to loopback (pairing a desktop to
    /// itself still works then).
    fn lan_ipv4() -> String {
        std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .ok()
            .and_then(|s| {
                s.connect("192.0.2.1:80").ok()?;
                s.local_addr().ok()
            })
            .map(|a| a.ip().to_string())
            .unwrap_or_else(|| "127.0.0.1".to_string())
    }

    /// Random n-digit PIN from OS entropy. `getrandom` is the CSPRNG
    /// interface (already in the dependency tree via tempfile/uuid; direct
    /// here so the pairing secrets never depend on wall-clock/pid hashing —
    /// those are guessable to within nanoseconds by an observer on the same
    /// machine). The u64-modulo bias for n=6 is ~5e-14 relative — noise
    /// next to the 10^6 keyspace a throttle already guards.
    pub(super) fn random_digits(n: usize) -> Result<String, String> {
        let mut buf = [0u8; 8];
        getrandom::fill(&mut buf).map_err(|e| format!("os entropy: {e}"))?;
        let v = u64::from_be_bytes(buf);
        let modulus = 10u64.pow(n as u32);
        Ok(format!("{:0width$}", v % modulus, width = n))
    }

    /// 256-bit bearer token / room id from OS entropy, hex-encoded (64
    /// chars). `pub(crate)`: the relay module's tests mint room ids with it.
    pub(crate) fn random_token() -> Result<String, String> {
        let mut buf = [0u8; 32];
        getrandom::fill(&mut buf).map_err(|e| format!("os entropy: {e}"))?;
        Ok(hex::encode(buf))
    }

    /// Build the game-data zip (AppData `gameparams/**` + `encyclopedia/**`)
    /// into the cache dir. Returns None when no source dir exists (fresh
    /// desktop) — the route then answers 404 and the phone shows a clean
    /// "no game data" toast. Runs on the blocking pool; a few hundred MB of
    /// per-ship JSON deflate in seconds there without stalling the runtime.
    /// Outcome logging lives in the spawn wrapper in [`pairing_start`].
    async fn build_gamedata_zip() -> Result<Option<PathBuf>, String> {
        let data = paths::ensure_data_dir()?;
        let sources = vec![data.join("gameparams"), data.join("encyclopedia")];
        let existing: Vec<PathBuf> = sources.into_iter().filter(|d| d.is_dir()).collect();
        if existing.is_empty() {
            return Ok(None);
        }
        let cache = paths::ensure_cache_dir()?;
        let dest = cache.join("pairing-gamedata.zip");
        let out = {
            let dest = dest.clone();
            tokio::task::spawn_blocking(move || write_gamedata_zip(&existing, &dest))
                .await
                .map_err(|e| format!("gamedata zip task failed: {e}"))?
        };
        match out {
            Ok(0) => Ok(None), // dirs existed but were empty — same as missing
            Ok(_) => Ok(Some(dest)),
            Err(e) => Err(e),
        }
    }

    /// Zip every file under `sources` with its dir name as the zip root
    /// (`gameparams/…`, `encyclopedia/…`) so extraction merges cleanly into
    /// the phone's data dir. Returns the file count.
    pub(super) fn write_gamedata_zip(sources: &[PathBuf], dest: &Path) -> Result<usize, String> {
        let tmp = dest.with_extension("zip.part");
        let file =
            std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut count = 0usize;
        for source in sources {
            let root_name = source
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if root_name.is_empty() {
                continue;
            }
            let mut stack = vec![source.clone()];
            while let Some(dir) = stack.pop() {
                let Ok(rd) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for ent in rd.flatten() {
                    let path = ent.path();
                    if path.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    let Ok(rel) = path.strip_prefix(source) else {
                        continue;
                    };
                    // Forward-slash zip name (zip spec) under the source
                    // dir's name — matches the extractor's merge layout.
                    let name = format!("{root_name}/{}", rel.to_string_lossy().replace('\\', "/"));
                    zip.start_file(name.as_str(), opts)
                        .map_err(|e| format!("zip add {name}: {e}"))?;
                    let mut f = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
                    std::io::copy(&mut f, &mut zip).map_err(|e| format!("zip write: {e}"))?;
                    count += 1;
                }
            }
        }
        zip.finish()
            .map_err(|e| format!("finalize gamedata zip: {e}"))?;
        std::fs::rename(&tmp, dest).map_err(|e| format!("finalize {}: {e}", dest.display()))?;
        Ok(count)
    }

    // ── HTTP core ────────────────────────────────────────────────────────────

    /// Test surface: start serving on an ALREADY-BOUND listener with explicit
    /// replay root / gamedata zip / room id (the command path derives all of
    /// those from the app dirs). Must be called inside a tokio runtime. Only
    /// tests call this — the command path binds its own listener — hence the
    /// allow.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn spawn_on(
        listener: StdListener,
        replay_root: PathBuf,
        gamedata_zip: Option<PathBuf>,
        pin: &str,
        room: &str,
    ) -> Result<ServerHandle, String> {
        // Adopting a std listener into tokio REQUIRES non-blocking mode —
        // a blocking socket makes accept() park the runtime thread
        // synchronously (on a current-thread test runtime that deadlocks
        // everything; on the multi-thread app runtime it stalls a worker).
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("listener nonblocking: {e}"))?;
        let listener =
            TcpListener::from_std(listener).map_err(|e| format!("adopt listener: {e}"))?;
        let token = random_token()?;
        // The test surface serves an ALREADY-BUILT zip (or none at all) —
        // the Building/503 path belongs to the command start, which spawns
        // the real background build.
        let (gd_tx, gd_rx) = watch::channel(GamedataState::Ready(Ok(gamedata_zip)));
        drop(gd_tx); // state is terminal; nothing more to signal
        let (tx, rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            pin: pin.to_string(),
            token: token.clone(),
            room: room.to_string(),
            replay_root,
            gamedata: gd_rx,
            pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
            shutdown: rx,
        });
        let task = tokio::spawn(serve(listener, shared));
        Ok(ServerHandle {
            token,
            shutdown: tx,
            task,
        })
    }

    async fn serve(listener: TcpListener, shared: Arc<Shared>) {
        tracing::info!(addr = ?listener.local_addr(), "pairing server listening");
        loop {
            let mut shutdown = shared.shutdown.clone();
            let accepted = tokio::select! {
                _ = shutdown.changed() => break,
                res = listener.accept() => res,
            };
            let (stream, peer) = match accepted {
                Ok(x) => x,
                Err(e) => {
                    tracing::warn!(error = %e, "pairing accept failed");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                },
            };
            let shared = shared.clone();
            tokio::spawn(async move {
                // NO timeout wrapper: handle_conn bounds only the request
                // reading internally; the response may stream for minutes.
                if let Err(e) = handle_conn(stream, &shared).await {
                    tracing::warn!(%peer, error = %e, "pairing connection dropped");
                }
            });
        }
        tracing::info!("pairing server accept loop exited");
    }

    /// One parsed request (head + lowercase header list). The body is read
    /// separately by the only route that has one. `pub(super)` fields so the
    /// parse unit test (pairing::tests) can assert on them.
    pub(super) struct Request {
        pub(super) method: String,
        /// Percent-decoded path (no query).
        pub(super) path: String,
        /// `?a=b` pairs (percent-decoded).
        pub(super) query: Vec<(String, String)>,
        /// Lowercased header name → value.
        pub(super) headers: Vec<(String, String)>,
        pub(super) content_length: usize,
    }

    impl Request {
        pub(super) fn query_param(&self, key: &str) -> Option<&str> {
            self.query
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        }

        fn header(&self, name: &str) -> Option<&str> {
            let lower = name.to_ascii_lowercase();
            self.headers
                .iter()
                .find(|(k, _)| *k == lower)
                .map(|(_, v)| v.as_str())
        }

        /// `Authorization: Bearer <token>` (case-insensitive scheme).
        pub(super) fn bearer_token(&self) -> Option<&str> {
            self.header("authorization").and_then(|v| {
                let v = v.trim();
                let rest = v
                    .strip_prefix("Bearer ")
                    .or_else(|| v.strip_prefix("bearer "))?;
                Some(rest.trim())
            })
        }
    }

    /// Read + parse one whole request — head AND body — bounded by
    /// `deadline` (slowloris protection: a client trickling either one gets
    /// cut). Only the response that follows is allowed to run unbounded.
    /// Returns the parsed request plus the fully-read body (empty for
    /// bodyless routes; an over-cap /pair body is left unread so the
    /// handler can answer 413 without ever receiving it). reqwest sends
    /// the tiny `/pair` JSON body glued to the head in the same TCP
    /// segment, so bytes buffered after the head MUST be consumed as body
    /// before the socket is touched again. `pub(super)` so the deadline
    /// behavior is unit-testable with a short window.
    pub(super) async fn read_request(
        stream: &mut TcpStream,
        deadline: std::time::Duration,
    ) -> Result<(Request, Vec<u8>), String> {
        tokio::time::timeout(deadline, read_request_inner(stream))
            .await
            .map_err(|_| format!("request not fully received within {deadline:?}"))?
    }

    async fn read_request_inner(stream: &mut TcpStream) -> Result<(Request, Vec<u8>), String> {
        let mut buf: Vec<u8> = Vec::with_capacity(512);
        let mut chunk = [0u8; 4096];
        let (req, mut leftover) = loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let req = parse_head(&buf[..pos])?;
                let leftover = buf.split_off(pos + 4);
                break (req, leftover);
            }
            if buf.len() > MAX_HEAD {
                return Err("request head too large".to_string());
            }
            let n = stream
                .read(&mut chunk)
                .await
                .map_err(|e| format!("read request: {e}"))?;
            if n == 0 {
                return Err("connection closed mid-request".to_string());
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        // /pair is the only route with a body, and only a within-cap one is
        // worth reading — the handler 413s the rest without consuming it.
        let mut body: Vec<u8> = Vec::new();
        if req.method == "POST" && req.path == "/pair" && req.content_length <= MAX_BODY {
            let buffered = leftover.len().min(req.content_length);
            body.extend_from_slice(&leftover[..buffered]);
            leftover.drain(..buffered);
            if body.len() < req.content_length {
                let mut rest = vec![0u8; req.content_length - body.len()];
                stream
                    .read_exact(&mut rest)
                    .await
                    .map_err(|e| format!("read pair body: {e}"))?;
                body.extend_from_slice(&rest);
            }
        }
        // Anything else glued after the head is pipelined junk on a
        // Connection: close protocol — dropped.
        Ok((req, body))
    }

    /// Parse the head block (everything before CRLFCRLF) into a [`Request`].
    pub(super) fn parse_head(head: &[u8]) -> Result<Request, String> {
        let text = std::str::from_utf8(head).map_err(|_| "non-UTF-8 request".to_string())?;
        let mut lines = text.split("\r\n");
        let request_line = lines.next().ok_or("empty request")?;
        let mut parts = request_line.split(' ');
        let method = parts.next().unwrap_or("").to_ascii_uppercase();
        let target = parts.next().ok_or("missing request target")?;
        if method.is_empty() || parts.next().is_none() {
            return Err("malformed request line".to_string());
        }
        // Split query off the target, percent-decode the path.
        let (raw_path, raw_query) = match target.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (target, None),
        };
        let path = percent_decode(raw_path)?;
        let query = raw_query
            .unwrap_or("")
            .split('&')
            .filter(|s| !s.is_empty())
            .map(|pair| match pair.split_once('=') {
                Some((k, v)) => Ok((percent_decode(k)?, percent_decode(v)?)),
                None => Ok((percent_decode(pair)?, String::new())),
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut headers = Vec::new();
        let mut content_length = 0usize;
        for line in lines {
            if line.is_empty() {
                continue;
            }
            let Some((k, v)) = line.split_once(':') else {
                continue;
            };
            let key = k.trim().to_ascii_lowercase();
            let value = v.trim().to_string();
            if key == "content-length" {
                content_length = value
                    .parse()
                    .map_err(|_| "bad content-length".to_string())?;
            }
            headers.push((key, value));
        }
        Ok(Request {
            method,
            path,
            query,
            headers,
            content_length,
        })
    }

    /// Constant-time-ish equality (LAN toy, but habits are free): length
    /// first, then every byte compared with accumulated XOR.
    pub(super) fn token_eq(a: &str, b: &str) -> bool {
        let (a, b) = (a.as_bytes(), b.as_bytes());
        if a.len() != b.len() {
            return false;
        }
        let mut diff = 0u8;
        for (x, y) in a.iter().zip(b.iter()) {
            diff |= x ^ y;
        }
        diff == 0
    }

    /// Serve one connection: read, route, respond, close. The REQUEST phase
    /// (head + body) is deadline-bounded inside [`read_request`] —
    /// slowloris protection; the routing/response phase is deliberately
    /// unbounded so multi-hundred-MB streams are never cut mid-transfer.
    /// Routes are resolved BEFORE the auth check so unknown paths 404
    /// regardless of token state (the route set is public knowledge; hiding
    /// it behind a 401 buys nothing on a LAN toy and muddies client error
    /// mapping).
    async fn handle_conn(mut stream: TcpStream, shared: &Shared) -> Result<(), String> {
        let (req, body) = read_request(&mut stream, REQUEST_TIMEOUT).await?;
        let authed = req
            .bearer_token()
            .or_else(|| req.query_param("token"))
            .is_some_and(|t| token_eq(t, &shared.token));

        let method = req.method.clone();
        let path = req.path.clone();

        if method == "POST" && path == "/pair" {
            return handle_pair(&mut stream, shared, &req, body).await;
        }
        if method == "GET" && path == "/api/ping" {
            return respond_json(&mut stream, 200, "OK", &serde_json::json!({ "ok": true }))
                .await
                .map_err(|e| e.to_string());
        }

        let replay_name = if method == "GET" && path.starts_with("/api/replay/") {
            Some(path.strip_prefix("/api/replay/").unwrap_or("").to_string())
        } else {
            None
        };
        let known = (method == "GET" && path == "/api/replays")
            || replay_name.is_some()
            || (method == "GET" && path == "/api/gamedata");
        if !known {
            return respond_json(
                &mut stream,
                404,
                "Not Found",
                &serde_json::json!({ "error": "not found" }),
            )
            .await
            .map_err(|e| e.to_string());
        }
        if !authed {
            return respond_json(
                &mut stream,
                401,
                "Unauthorized",
                &serde_json::json!({ "error": "invalid or expired token" }),
            )
            .await
            .map_err(|e| e.to_string());
        }
        if method == "GET" && path == "/api/replays" {
            return handle_replays(&mut stream, shared).await;
        }
        if let Some(name) = replay_name {
            return handle_replay_file(&mut stream, shared, &name).await;
        }
        handle_gamedata(&mut stream, shared).await
    }

    async fn handle_pair(
        stream: &mut TcpStream,
        shared: &Shared,
        req: &Request,
        body: Vec<u8>,
    ) -> Result<(), String> {
        if req.content_length > MAX_BODY {
            return respond_json(
                stream,
                413,
                "Payload Too Large",
                &serde_json::json!({ "error": "pair body too large" }),
            )
            .await
            .map_err(|e| e.to_string());
        }
        let pin = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("pin").and_then(|p| p.as_str()).map(str::to_string))
            .unwrap_or_default();
        // Throttle BEFORE the comparison: within a tripped window even the
        // CORRECT PIN is rejected — otherwise the lockout would leak when
        // the guessing stops. The guard is dropped at the end of this
        // statement (std mutexes must never ride an await).
        let blocked_for = shared_throttle(shared)
            .check(std::time::Instant::now())
            .err();
        if let Some(remaining) = blocked_for {
            let retry_after = remaining.as_secs().max(1);
            tracing::warn!(retry_after_secs = retry_after, "pairing: PIN lockout hit");
            return respond_json_extra(
                stream,
                429,
                "Too Many Requests",
                &[("Retry-After", retry_after.to_string())],
                &serde_json::json!({ "error": "too many PIN attempts" }),
            )
            .await
            .map_err(|e| e.to_string());
        }
        // Relay v2: the gateway-allocated pairing code is an accepted secret
        // alongside the local PIN — a same-network phone types whatever the
        // desktop displays (the code while the gateway is online), and the
        // tunnel phone always types the code.
        let relay_code = crate::commands::pairing_relay::current_relay_code();
        let pin_ok = token_eq(&pin, &shared.pin)
            || relay_code.is_some_and(|code| !code.is_empty() && token_eq(&pin, &code));
        if !pin_ok {
            shared_throttle(shared).record_failure(std::time::Instant::now());
            tracing::warn!("pairing: rejected PIN attempt");
            return respond_json(
                stream,
                403,
                "Forbidden",
                &serde_json::json!({ "error": "invalid PIN" }),
            )
            .await
            .map_err(|e| e.to_string());
        }
        shared_throttle(shared).record_success();
        // The room id rides along: relay phones address their later tunnels
        // by it (LAN phones ignore it).
        respond_json(
            stream,
            200,
            "OK",
            &serde_json::json!({ "token": shared.token, "room": shared.room }),
        )
        .await
        .map_err(|e| e.to_string())
    }

    /// Lock the PIN throttle, treating a poisoned lock as recoverable (the
    /// guarded state is two integers; a panicked writer loses nothing but
    /// the last update).
    fn shared_throttle(shared: &Shared) -> std::sync::MutexGuard<'_, PinThrottle> {
        shared
            .pin_throttle
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Root-relative remote name (forward slashes) for one enumerated path.
    fn remote_name(root: &Path, path: &str) -> String {
        Path::new(path)
            .strip_prefix(root)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| {
                Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string())
            })
    }

    /// `scan_replays_meta` on the blocking pool — even with `lite_from_path`
    /// reading only the bounded first block, a 200-entry listing is real
    /// disk work that must never stall async runtime workers (the async
    /// `list_replays_meta` command wraps the same scan in its own
    /// `spawn_blocking`; the hand-rolled server has to do it itself).
    async fn scan_remote(
        replay_root: PathBuf,
    ) -> Result<(PathBuf, Vec<wowsp_tauri_shared::ReplayMetaLite>), String> {
        let dir = replay_root.to_string_lossy().into_owned();
        tokio::task::spawn_blocking(move || replay::scan_replays_meta(Some(dir), None))
            .await
            .map_err(|e| format!("replay scan task failed: {e}"))?
    }

    async fn handle_replays(stream: &mut TcpStream, shared: &Shared) -> Result<(), String> {
        let (root, entries) = scan_remote(shared.replay_root.clone()).await?;
        let projected: Vec<serde_json::Value> = entries
            .iter()
            .map(|e| {
                let mut v = serde_json::to_value(e).unwrap_or(serde_json::Value::Null);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "path".into(),
                        serde_json::Value::String(remote_name(&root, &e.path)),
                    );
                }
                v
            })
            .collect();
        respond_json(stream, 200, "OK", &serde_json::Value::Array(projected))
            .await
            .map_err(|e| e.to_string())
    }

    /// Serve one replay file. `name` must match an entry of the CURRENT
    /// enumeration (root-relative, forward slashes) — the route never touches
    /// the filesystem by user-supplied spelling, so traversal cannot reach
    /// anything the listing itself doesn't already show. Belt-and-braces the
    /// obvious junk anyway.
    async fn handle_replay_file(
        stream: &mut TcpStream,
        shared: &Shared,
        name: &str,
    ) -> Result<(), String> {
        if name.is_empty()
            || name.contains("..")
            || name.contains('\\')
            || name.starts_with('/')
            || name.contains(':')
        {
            return respond_json(
                stream,
                404,
                "Not Found",
                &serde_json::json!({ "error": "replay not found" }),
            )
            .await
            .map_err(|e| e.to_string());
        }
        let (root, entries) = scan_remote(shared.replay_root.clone()).await?;
        let Some(entry) = entries
            .iter()
            .find(|e| remote_name(&root, &e.path) == name)
            .map(|e| PathBuf::from(&e.path))
        else {
            return respond_json(
                stream,
                404,
                "Not Found",
                &serde_json::json!({ "error": "replay not found" }),
            )
            .await
            .map_err(|e| e.to_string());
        };
        serve_file(stream, &entry, "application/octet-stream").await
    }

    /// Serve the game-data zip. The zip is built in the background when the
    /// server starts; a request that lands while it is still building waits
    /// a bounded [`GAMEDATA_BUILD_WAIT`] for completion (a near-miss gets
    /// served instead of bounced) and then answers 503 + Retry-After so the
    /// phone can nap and come back.
    async fn handle_gamedata(stream: &mut TcpStream, shared: &Shared) -> Result<(), String> {
        handle_gamedata_with_wait(stream, shared, GAMEDATA_BUILD_WAIT).await
    }

    /// The route above with the wait bound injectable for tests.
    async fn handle_gamedata_with_wait(
        stream: &mut TcpStream,
        shared: &Shared,
        wait: std::time::Duration,
    ) -> Result<(), String> {
        let mut rx = shared.gamedata.clone();
        let current = rx.borrow().clone();
        let state = match current {
            GamedataState::Building => {
                match tokio::time::timeout(wait, rx.changed()).await {
                    // Build finished inside the bound — serve the outcome.
                    Ok(Ok(())) => rx.borrow().clone(),
                    // Build task died without reporting — surface as 500.
                    Ok(Err(_)) => {
                        GamedataState::Ready(Err("game-data build task died".to_string()))
                    },
                    // Still building after the bound — tell the phone to nap.
                    Err(_) => GamedataState::Building,
                }
            },
            ready => ready,
        };
        match state {
            GamedataState::Building => respond_json_extra(
                stream,
                503,
                "Service Unavailable",
                &[("Retry-After", GAMEDATA_RETRY_AFTER_SECS.to_string())],
                &serde_json::json!({ "error": "game data zip is still being prepared" }),
            )
            .await
            .map_err(|e| e.to_string()),
            GamedataState::Ready(Err(e)) => respond_json(
                stream,
                500,
                "Internal Server Error",
                &serde_json::json!({ "error": e }),
            )
            .await
            .map_err(|e| e.to_string()),
            GamedataState::Ready(Ok(None)) => respond_json(
                stream,
                404,
                "Not Found",
                &serde_json::json!({ "error": "no game data available" }),
            )
            .await
            .map_err(|e| e.to_string()),
            GamedataState::Ready(Ok(Some(zip))) if zip.is_file() => {
                serve_file(stream, &zip, "application/zip").await
            },
            // Zip vanished under us (cache wiped mid-run) — same clean 404.
            GamedataState::Ready(Ok(Some(_))) => respond_json(
                stream,
                404,
                "Not Found",
                &serde_json::json!({ "error": "no game data available" }),
            )
            .await
            .map_err(|e| e.to_string()),
        }
    }

    /// Stream a file with Content-Length + Connection: close.
    async fn serve_file(
        stream: &mut TcpStream,
        path: &Path,
        content_type: &str,
    ) -> Result<(), String> {
        let len = std::fs::metadata(path)
            .map_err(|e| format!("stat {}: {e}", path.display()))?
            .len();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| format!("write head: {e}"))?;
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        tokio::io::copy(&mut file, stream)
            .await
            .map_err(|e| format!("stream {}: {e}", path.display()))?;
        stream.flush().await.map_err(|e| format!("flush: {e}"))?;
        let _ = stream.shutdown().await;
        Ok(())
    }

    async fn respond_json(
        stream: &mut TcpStream,
        status: u16,
        reason: &str,
        body: &serde_json::Value,
    ) -> std::io::Result<()> {
        respond_json_extra(stream, status, reason, &[], body).await
    }

    /// `respond_json` plus extra response headers (used for Retry-After on
    /// the 429/503 answers).
    async fn respond_json_extra(
        stream: &mut TcpStream,
        status: u16,
        reason: &str,
        extra: &[(&str, String)],
        body: &serde_json::Value,
    ) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        let mut head = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
            bytes.len()
        );
        for (name, value) in extra {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("Connection: close\r\n\r\n");
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&bytes).await?;
        stream.flush().await
    }

    // ── server-internal unit tests (visible only in here, where the
    // private state lives) ────────────────────────────────────────────────

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Connected localhost TCP pair: (server side, client side).
        async fn tcp_pair() -> (TcpStream, TcpStream) {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let client = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            let (server, _) = listener.accept().await.unwrap();
            (server, client)
        }

        fn test_shared(gamedata: watch::Receiver<GamedataState>) -> Arc<Shared> {
            let (_shutdown_tx, shutdown_rx) = watch::channel(false);
            Arc::new(Shared {
                pin: "123456".to_string(),
                token: "test-token".to_string(),
                room: "a".repeat(64),
                replay_root: std::env::temp_dir(),
                gamedata,
                pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
                shutdown: shutdown_rx,
            })
        }

        #[test]
        fn pin_throttle_locks_after_burst_and_resets_on_success() {
            let mut throttle = PinThrottle::default();
            let t0 = std::time::Instant::now();
            assert!(throttle.check(t0).is_ok());
            for i in 1..=4 {
                throttle.record_failure(t0);
                assert!(throttle.check(t0).is_ok(), "{i} failures must not lock yet");
            }
            // Fifth failure trips the window — check fails even at the same
            // instant, and the lockout is bounded by the window length.
            throttle.record_failure(t0);
            let remaining = throttle.check(t0).unwrap_err();
            assert!(!remaining.is_zero());
            assert!(remaining <= PIN_BLOCK_WINDOW);
            // Window expired → open again…
            let later = t0 + PIN_BLOCK_WINDOW + std::time::Duration::from_secs(1);
            assert!(throttle.check(later).is_ok());
            // …but failures accumulate across windows: ONE more re-trips.
            throttle.record_failure(later);
            assert!(throttle.check(later).is_err());
            // A correct PIN clears everything.
            throttle.record_success();
            assert!(throttle.check(std::time::Instant::now()).is_ok());
        }

        /// CSPRNG SHAPE only (lengths/charset/distribution sanity) — never
        /// concrete values.
        #[test]
        fn csprng_pin_and_token_shapes() {
            let pins: Vec<String> = (0..24).map(|_| random_digits(6).unwrap()).collect();
            for pin in &pins {
                assert_eq!(pin.len(), 6);
                assert!(pin.bytes().all(|b| b.is_ascii_digit()));
            }
            // 24 draws over a 10^6 keyspace: all-equal has probability
            // ~1e-138, so distinctness is a safe distribution canary.
            let distinct =
                std::collections::HashSet::<&str>::from_iter(pins.iter().map(String::as_str));
            assert!(distinct.len() > 1);
            // Widths zero-pad (v % 10^n can be small).
            assert_eq!(random_digits(4).unwrap().len(), 4);

            let tokens: Vec<String> = (0..2).map(|_| random_token().unwrap()).collect();
            for token in &tokens {
                assert_eq!(token.len(), 64);
                assert!(
                    token
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                );
            }
            assert_ne!(tokens[0], tokens[1]);
        }

        #[tokio::test]
        async fn complete_request_with_glued_body_parses() {
            let (mut server, mut client) = tcp_pair().await;
            use tokio::io::AsyncWriteExt;
            let body = br#"{"pin":"123456"}"#;
            let head = format!(
                "POST /pair HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            // Head and body in one flight — reqwest's exact shape.
            client.write_all(head.as_bytes()).await.unwrap();
            client.write_all(body).await.unwrap();
            let (req, read_body) = read_request(&mut server, std::time::Duration::from_secs(5))
                .await
                .unwrap();
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/pair");
            assert_eq!(req.content_length, body.len());
            assert_eq!(read_body, body.to_vec());
        }

        #[tokio::test]
        async fn trickled_head_hits_the_request_deadline() {
            let (mut server, mut client) = tcp_pair().await;
            use tokio::io::AsyncWriteExt;
            // A slowloris: partial head, then the client stalls forever.
            client
                .write_all(b"POST /pair HTTP/1.1\r\nContent-Len")
                .await
                .unwrap();
            let started = std::time::Instant::now();
            let res = read_request(&mut server, std::time::Duration::from_millis(150)).await;
            assert!(res.is_err(), "trickled head must be cut");
            assert!(
                started.elapsed() >= std::time::Duration::from_millis(140),
                "the deadline, not a parse error, must fire"
            );
        }

        #[tokio::test]
        async fn gamedata_waits_for_the_build_then_serves() {
            // Request lands while Building; the zip arrives within the
            // bound → the SAME response serves the bytes.
            let tmp = super::super::tests::tempfile_dir();
            let src = tmp.join("gameparams");
            std::fs::create_dir_all(&src).unwrap();
            std::fs::write(src.join("a.json"), b"GP-A").unwrap();
            let zip_path = tmp.join("gd.zip");
            assert_eq!(write_gamedata_zip(&[src], &zip_path).unwrap(), 1);
            let (tx, rx) = watch::channel(GamedataState::Building);
            let shared = test_shared(rx);
            let (mut server, mut client) = tcp_pair().await;
            let handler = tokio::spawn(async move {
                handle_gamedata_with_wait(&mut server, &shared, std::time::Duration::from_secs(5))
                    .await
            });
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            tx.send(GamedataState::Ready(Ok(Some(zip_path.clone()))))
                .unwrap();
            handler.await.unwrap().unwrap();

            use tokio::io::AsyncReadExt;
            let mut raw = Vec::new();
            client.read_to_end(&mut raw).await.unwrap();
            let text = String::from_utf8_lossy(&raw).to_string();
            assert!(text.starts_with("HTTP/1.1 200 OK"), "got: {text}");
            assert!(text.contains("Content-Type: application/zip"));
            let expected = std::fs::read(&zip_path).unwrap();
            assert_eq!(&raw[raw.len() - expected.len()..], &expected[..]);
            let _ = std::fs::remove_dir_all(&tmp);
        }

        #[tokio::test]
        async fn gamedata_answers_503_retry_after_while_building() {
            // Build never finishes within the (shortened) bound → 503 with
            // a usable Retry-After, not a hang and not an error.
            let (tx, rx) = watch::channel(GamedataState::Building);
            let shared = test_shared(rx);
            let (mut server, mut client) = tcp_pair().await;
            handle_gamedata_with_wait(&mut server, &shared, std::time::Duration::from_millis(120))
                .await
                .unwrap();
            // The route's caller (the connection task) owns the stream and
            // drops it after the response — closing our side is what makes
            // the client's read_to_end see EOF.
            drop(tx);
            drop(server);

            use tokio::io::AsyncReadExt;
            let mut raw = Vec::new();
            client.read_to_end(&mut raw).await.unwrap();
            let text = String::from_utf8_lossy(&raw).to_string();
            assert!(text.starts_with("HTTP/1.1 503"), "got: {text}");
            assert!(text.contains(&format!("Retry-After: {GAMEDATA_RETRY_AFTER_SECS}")));
            assert!(text.contains("still being prepared"));
        }

        #[tokio::test]
        async fn gamedata_surfaces_a_dead_build_task() {
            // Sender dropped without a result → clean 500, never a hang.
            let (tx, rx) = watch::channel(GamedataState::Building);
            drop(tx);
            let shared = test_shared(rx);
            let (mut server, mut client) = tcp_pair().await;
            handle_gamedata_with_wait(&mut server, &shared, std::time::Duration::from_secs(5))
                .await
                .unwrap();
            drop(server);

            use tokio::io::AsyncReadExt;
            let mut raw = Vec::new();
            client.read_to_end(&mut raw).await.unwrap();
            let text = String::from_utf8_lossy(&raw).to_string();
            assert!(text.starts_with("HTTP/1.1 500"), "got: {text}");
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Shared with the nested `server::tests` module and the relay module's
    /// loopback test.
    pub(crate) fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-pairing-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── pure helpers ─────────────────────────────────────────────────────────

    #[test]
    fn sanitize_strips_paths_and_normalizes_extension() {
        assert_eq!(
            sanitize_replay_name("20250622_152405_Hotaka.wowsreplay").unwrap(),
            "20250622_152405_Hotaka.wowsreplay"
        );
        // Path components collapse to the basename; missing suffix appends.
        assert_eq!(
            sanitize_replay_name("/tmp/evil/20250622_x.wowsreplay").unwrap(),
            "20250622_x.wowsreplay"
        );
        assert_eq!(
            sanitize_replay_name("..\\..\\20250622_y.wowsreplay").unwrap(),
            "20250622_y.wowsreplay"
        );
        assert_eq!(
            sanitize_replay_name("20250622_z").unwrap(),
            "20250622_z.wowsreplay"
        );
        // Case-insensitive suffix match keeps the original casing.
        assert_eq!(
            sanitize_replay_name("20250622_w.WowsReplay").unwrap(),
            "20250622_w.WowsReplay"
        );
        // Windows-forbidden characters are replaced, not passed through.
        assert_eq!(
            sanitize_replay_name("a<b>:c\"|d?e*.wowsreplay").unwrap(),
            "a_b__c__d_e_.wowsreplay"
        );
        // Junk names are rejected outright.
        assert!(sanitize_replay_name("").is_err());
        assert!(sanitize_replay_name("   ").is_err());
        assert!(sanitize_replay_name("..").is_err());
        assert!(sanitize_replay_name(".hidden.wowsreplay").is_err());
        assert!(sanitize_replay_name(".").is_err());
    }

    #[test]
    fn dedupe_suffixes_before_extension() {
        let tmp = tempfile_dir();
        let first = dedupe_path(&tmp, "20250622_x.wowsreplay");
        assert_eq!(first, tmp.join("20250622_x.wowsreplay"));
        std::fs::write(&first, b"1").unwrap();
        let second = dedupe_path(&tmp, "20250622_x.wowsreplay");
        assert_eq!(second, tmp.join("20250622_x (1).wowsreplay"));
        std::fs::write(&second, b"2").unwrap();
        assert_eq!(
            dedupe_path(&tmp, "20250622_x.wowsreplay"),
            tmp.join("20250622_x (2).wowsreplay")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn store_replay_bytes_round_trip_and_dedupes() {
        let tmp = tempfile_dir();
        let p1 = store_replay_bytes(&tmp, "20250622_a.wowsreplay", b"bytes-a").unwrap();
        let p2 = store_replay_bytes(&tmp, "20250622_a.wowsreplay", b"bytes-a2").unwrap();
        assert_ne!(p1, p2);
        assert!(p1.ends_with("20250622_a.wowsreplay"));
        assert!(p2.ends_with("20250622_a (1).wowsreplay"));
        assert!(std::fs::read(&p1).unwrap() == b"bytes-a");
        // A smuggled path lands as the basename.
        let p3 = store_replay_bytes(&tmp, "C:\\games\\20250622_b.wowsreplay", b"b").unwrap();
        assert!(p3.ends_with("20250622_b.wowsreplay"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn path_segment_encoding_round_trips() {
        assert_eq!(encode_path_segment("abc-DEF_1.2~"), "abc-DEF_1.2~");
        assert_eq!(encode_path_segment("a b/c"), "a%20b%2Fc");
        assert_eq!(
            super::super::exports::percent_decode(&encode_path_segment(
                "20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay"
            ))
            .unwrap(),
            "20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay"
        );
        // Non-ASCII names survive the URL layer.
        assert_eq!(
            super::super::exports::percent_decode(&encode_path_segment("源.wowsreplay")).unwrap(),
            "源.wowsreplay"
        );
    }

    #[test]
    fn host_cleaning_strips_scheme_and_slashes() {
        assert_eq!(clean_host(" 192.0.2.10 "), "192.0.2.10");
        assert_eq!(clean_host("http://192.0.2.10/"), "192.0.2.10");
        assert_eq!(clean_host("https://192.0.2.10"), "192.0.2.10");
    }

    #[cfg(desktop)]
    #[test]
    fn gamedata_zip_round_trip_and_zip_slip_safety() {
        use std::io::Write;

        let tmp = tempfile_dir();
        let src = tmp.join("gameparams");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.json"), b"{\"a\":1}").unwrap();
        std::fs::write(src.join("sub").join("b.json"), b"{\"b\":2}").unwrap();
        let zip_path = tmp.join("gd.zip");
        let n = server::write_gamedata_zip(&[src.clone()], &zip_path).unwrap();
        assert_eq!(n, 2);

        let dest = tmp.join("dest");
        let extracted = extract_gamedata_zip(&zip_path, &dest).unwrap();
        assert_eq!(extracted, 2);
        assert_eq!(
            std::fs::read(dest.join("gameparams").join("a.json")).unwrap(),
            b"{\"a\":1}"
        );
        assert_eq!(
            std::fs::read(dest.join("gameparams").join("sub").join("b.json")).unwrap(),
            b"{\"b\":2}"
        );

        // Hostile zip: entries escaping the destination are skipped, never
        // written outside it.
        let evil = tmp.join("evil.zip");
        let file = std::fs::File::create(&evil).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("ok.txt", opts).unwrap();
        w.write_all(b"ok").unwrap();
        w.start_file("../evil.txt", opts).unwrap();
        w.write_all(b"evil").unwrap();
        w.finish().unwrap();
        let out_dir = tmp.join("out2");
        let extracted = extract_gamedata_zip(&evil, &out_dir).unwrap();
        assert_eq!(extracted, 1);
        assert!(out_dir.join("ok.txt").is_file());
        assert!(!tmp.join("evil.txt").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(desktop)]
    #[test]
    fn parses_request_heads() {
        let req = server::parse_head(
            b"GET /api/replays?token=abc%20d HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok123\r\nContent-Length: 5\r\n",
        )
        .unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/api/replays");
        assert_eq!(req.query_param("token"), Some("abc d"));
        assert_eq!(req.bearer_token(), Some("tok123"));
        assert_eq!(req.content_length, 5);

        assert!(server::parse_head(b"garbage").is_err());
        assert!(server::parse_head(b"GET\r\n\r\n").is_err());
        assert!(server::parse_head(b"POST /pair HTTP/1.1\r\nContent-Length: abc\r\n\r\n").is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn constant_time_compare_behaves() {
        // The property under test is ordinary equality; the constant-time
        // aspect is by construction (see token_eq).
        assert!(server::token_eq("abcdef", "abcdef"));
        assert!(!server::token_eq("abcdef", "abcdeg"));
        assert!(!server::token_eq("abc", "abcd"));
    }

    // ── end-to-end localhost smoke: pair → list → pull → gamedata → restart ──

    #[cfg(desktop)]
    #[tokio::test]
    async fn pairing_server_end_to_end() {
        // Fixture replay (magic + one JSON block, same shape as replay.rs's
        // synthetic test).
        let tmp = tempfile_dir();
        let replays = tmp.join("replays");
        std::fs::create_dir_all(&replays).unwrap();
        let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
        let mut bytes: Vec<u8> = vec![0x12, 0x32, 0x34, 0x11];
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        let replay_name = "20250622_152405_Hotaka_15_NE_north.wowsreplay";
        std::fs::write(replays.join(replay_name), &bytes).unwrap();

        // Gamedata sources.
        let gd = tmp.join("gd");
        std::fs::create_dir_all(gd.join("gameparams")).unwrap();
        std::fs::create_dir_all(gd.join("encyclopedia")).unwrap();
        std::fs::write(gd.join("gameparams").join("a.json"), b"GP-A").unwrap();
        std::fs::write(gd.join("encyclopedia").join("b.json"), b"ENC-B").unwrap();
        let zip_path = tmp.join("gamedata.zip");
        assert_eq!(
            server::write_gamedata_zip(
                &[gd.join("gameparams"), gd.join("encyclopedia")],
                &zip_path
            )
            .unwrap(),
            2
        );

        // Bind on an ephemeral localhost port and start serving.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let room = server::random_token().unwrap();
        let handle = server::spawn_on(
            listener,
            replays.clone(),
            Some(zip_path.clone()),
            "123456",
            &room,
        )
        .await
        .unwrap();

        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        // ping needs no auth.
        let ping: serde_json::Value = client
            .get(format!("{base}/api/ping"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ping["ok"], serde_json::json!(true));

        // Unknown route → 404.
        let r = client.get(format!("{base}/nope")).send().await.unwrap();
        assert_eq!(r.status(), 404);

        // Wrong PIN → 403 + "invalid PIN".
        let r = client
            .post(format!("{base}/pair"))
            .json(&serde_json::json!({ "pin": "000000" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403);
        let body: serde_json::Value = r.json().await.unwrap();
        assert_eq!(body["error"], "invalid PIN");

        // Data routes without a token → 401 with the clean string.
        let r = client
            .get(format!("{base}/api/replays"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        let body: serde_json::Value = r.json().await.unwrap();
        assert_eq!(body["error"], "invalid or expired token");

        // Right PIN mints the token; the body now also echoes the run's
        // room key (relay phones address later tunnels by it).
        let paired: PairingToken = client
            .post(format!("{base}/pair"))
            .json(&serde_json::json!({ "pin": "123456" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let token = paired.token;
        assert!(!token.is_empty());
        assert_eq!(paired.room.as_deref(), Some(room.as_str()));

        // Token also works via ?token=.
        let r = client
            .get(format!("{base}/api/replays?token={token}"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);

        // List: same DTO as list_replays_meta, path projected to the name.
        let list: Vec<serde_json::Value> = client
            .get(format!("{base}/api/replays"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["path"], serde_json::json!(replay_name));
        assert_eq!(list[0]["mapName"], "15_NE_north");

        // Traversal-looking names are refused before any FS access.
        let r = client
            .get(format!("{base}/api/replay/..%2F..%2Fsecret"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);

        // Pull streams the exact fixture bytes.
        let pulled = client
            .get(format!(
                "{base}/api/replay/{}",
                encode_path_segment(replay_name)
            ))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(pulled.status(), 200);
        assert_eq!(
            pulled
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<usize>().ok()),
            Some(bytes.len())
        );
        let got = pulled.bytes().await.unwrap();
        assert_eq!(&got[..], &bytes[..]);

        // Gamedata zip downloads and extracts cleanly.
        let r = client
            .get(format!("{base}/api/gamedata"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let zip_bytes = r.bytes().await.unwrap();
        let zip_file = tmp.join("pulled.zip");
        std::fs::write(&zip_file, &zip_bytes).unwrap();
        let dest = tmp.join("extracted");
        assert_eq!(extract_gamedata_zip(&zip_file, &dest).unwrap(), 2);
        assert_eq!(
            std::fs::read(dest.join("gameparams").join("a.json")).unwrap(),
            b"GP-A"
        );

        // Stop → port actually freed → restart cleanly (proving the shutdown
        // really ends the old task).
        handle.stop().await;
        let listener2 = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        let handle2 = server::spawn_on(listener2, replays.clone(), None, "654321", &room)
            .await
            .unwrap();
        let paired2: PairingToken = client
            .post(format!("{base}/pair"))
            .json(&serde_json::json!({ "pin": "654321" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_ne!(paired2.token, token);
        // Without gamedata the route now 404s.
        let r = client
            .get(format!("{base}/api/gamedata"))
            .bearer_auth(&paired2.token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);

        // PIN throttle: five consecutive wrong PINs lock the exchange for
        // a 10 s window — the sixth attempt gets 429 + Retry-After even
        // when it carries the CORRECT pin (the check runs before the
        // comparison). No sleep needed: assert the lock, then stop.
        for _ in 0..5 {
            let r = client
                .post(format!("{base}/pair"))
                .json(&serde_json::json!({ "pin": "000000" }))
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), 403);
        }
        let r = client
            .post(format!("{base}/pair"))
            .json(&serde_json::json!({ "pin": "654321" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 429);
        let retry_after = r
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        assert!(retry_after.is_some_and(|s| (1..=10).contains(&s)));
        let body: serde_json::Value = r.json().await.unwrap();
        assert_eq!(body["error"], "too many PIN attempts");

        handle2.stop().await;

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
