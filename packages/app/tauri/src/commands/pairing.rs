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
//!   [`super::replay::scan_replays_meta`] — the same WALK PRIMITIVE the local
//!   list command uses, never a duplicate. The ROOT set differs on purpose:
//!   this server enumerates the resolved default replay dir (the active
//!   client's `replays/` folder, or the phone's managed dir) because the
//!   remote names it hands out are relative to that one root, while the
//!   local rail scans every detected client
//!   (`list_replays_meta { all: true }`). While the server runs, the UDP
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

/// Progress event channel. Pairing transfers deliberately keep their own
/// multiplexed stream (they pull from a paired device over LAN/relay, not
/// the GitHub mirror ladder the unified download hub serves).
pub const PAIRING_PROGRESS_EVENT: &str = "wowsp://pairing-progress";
/// Sentinel `remoteName` marking the game-data zip sync on the shared
/// progress stream (no single "file" name to key on otherwise).
pub const GAMEDATA_SENTINEL: &str = ":gamedata:";

/// A stop budget must not detach the task: it could still publish old-session
/// state or retain sockets after a replacement session starts.
pub(super) async fn await_shutdown(
    mut task: tokio::task::JoinHandle<()>,
    budget: std::time::Duration,
) {
    if tokio::time::timeout(budget, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

/// Private scratch space for one server snapshot or client pull. Blocking
/// builders/extractors retain an Arc so cancellation cannot remove their files
/// while they are still using them, or let a later run reuse their paths.
struct GamedataWorkspace(PathBuf);

impl GamedataWorkspace {
    fn create(cache: &Path) -> Result<Self, String> {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| format!("gamedata workspace entropy: {e}"))?;
        let path = cache.join(format!("pairing-gamedata-{}", hex::encode(nonce)));
        std::fs::create_dir(&path).map_err(|e| format!("create {}: {e}", path.display()))?;
        Ok(Self(path))
    }

    fn archive(&self) -> PathBuf {
        self.0.join("pairing-gamedata.zip")
    }

    fn part(&self) -> PathBuf {
        self.archive().with_extension("zip.part")
    }
}

impl Drop for GamedataWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

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
/// appends the `.wowsreplay` suffix when missing (the Lesta client's
/// `.korablireplay` containers keep their own extension — the replay
/// pipeline parses both containers natively, and the extension is what the
/// listing and mode classifiers key off). Rejects
/// empty names, dotfiles and pure dot-junk.
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
    // Length cap (chars, not bytes — the suffixes are ASCII so this is
    // safe): keep room for the longest extension.
    let max_len = 180 + ".korablireplay".len();
    if cleaned.chars().count() > max_len {
        cleaned = cleaned.chars().take(max_len).collect();
    }
    let lower = cleaned.to_ascii_lowercase();
    if !lower.ends_with(".wowsreplay") && !lower.ends_with(".korablireplay") {
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

/// Atomically claim a free name. A name selected before a download (or an
/// import on another blocking thread) is only a hint, never permission to
/// replace a file that appeared in the meantime.
fn reserve_replay_file(dir: &Path, name: &str) -> Result<(PathBuf, std::fs::File), String> {
    for _ in 0..1000 {
        let path = dedupe_path(dir, name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("create {}: {e}", path.display())),
        }
    }
    Err("could not reserve a unique replay file name".into())
}

fn write_replay_file(
    dir: &Path,
    name: &str,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<PathBuf, String> {
    let (path, mut file) = reserve_replay_file(dir, name)?;
    let result = write(&mut file);
    drop(file);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&path);
        return Err(format!("write {}: {e}", path.display()));
    }
    Ok(path)
}

/// Write replay bytes into a newly reserved file in the managed dir.
fn store_replay_bytes(dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<String, String> {
    let name = sanitize_replay_name(raw_name)?;
    let path = write_replay_file(dir, &name, |file| std::io::Write::write_all(file, bytes))?;
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

/// Copy a completed download into a newly reserved file. Both files live in
/// the replay directory, but a no-replace hard link is not available on every
/// supported filesystem (for example removable game drives).
fn finalize_replay_part(part: &Path, proposed_path: &Path) -> Result<PathBuf, String> {
    let dir = proposed_path.parent().ok_or("missing replay directory")?;
    let name = proposed_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid replay file name")?;
    let mut source =
        std::fs::File::open(part).map_err(|e| format!("read {}: {e}", part.display()))?;
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
    received: Result<u64, String>,
    part: PathBuf,
    final_path: PathBuf,
    remote_name: String,
) -> Result<PairingPathResult, String> {
    let result = match received {
        Ok(n) => {
            let source = part.clone();
            tokio::task::spawn_blocking(move || finalize_replay_part(&source, &final_path))
                .await
                .map_err(|e| format!("replay finalization task failed: {e}"))
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
    let workspace = std::sync::Arc::new(GamedataWorkspace::create(&cache)?);
    let part = workspace.part();
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
        let workspace = workspace.clone();
        tokio::task::spawn_blocking(move || extract_gamedata_zip(&workspace.part(), &data_dir))
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

/// The pairing protocol exports only these two cache trees. Validate the
/// raw ZIP spelling before Path normalizes it, including Windows aliases
/// (trailing dots/spaces and DOS device names), on every platform.
fn gamedata_entry_path(name: &str, is_dir: bool) -> Option<PathBuf> {
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return None;
    }
    let name = if is_dir {
        name.strip_suffix('/')?
    } else {
        name
    };
    let parts: Vec<&str> = name.split('/').collect();
    if !matches!(parts.first().copied(), Some("gameparams" | "encyclopedia"))
        || (!is_dir && parts.len() < 2)
    {
        return None;
    }
    for part in &parts {
        if part.is_empty() || part.ends_with('.') || part.ends_with(' ') {
            return None;
        }
        let base = part.split('.').next()?.to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                base.strip_prefix(prefix).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            })
        {
            return None;
        }
    }
    Some(PathBuf::from(name))
}

fn gamedata_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points need the same treatment as
        // symlinks; is_symlink alone does not cover every reparse tag.
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Create only plain directories below the canonical extraction root.
/// Existing links must never redirect a cache write into another tree.
fn gamedata_parent(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let mut dir = root.to_path_buf();
    for part in rel.components() {
        dir.push(part);
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && !gamedata_link(&meta) => {},
            Ok(_) => return Err(format!("unsafe gamedata directory: {}", dir.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
            },
            Err(e) => return Err(format!("inspect {}: {e}", dir.display())),
        }
    }
    Ok(dir)
}

/// Merge only gameparams/** and encyclopedia/** from the paired host.
/// Unrelated app data, Windows path aliases and filesystem links are never
/// writable through this protocol. Each file is verified by the ZIP reader
/// before replacing its old cache entry, preserving it on CRC/read failure.
pub(crate) fn extract_gamedata_zip(archive: &Path, dest: &Path) -> Result<usize, String> {
    let file =
        std::fs::File::open(archive).map_err(|e| format!("open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("read {}: {e}", archive.display()))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    let root = dest
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", dest.display()))?;
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        let Some(rel) = gamedata_entry_path(entry.name(), entry.is_dir()) else {
            tracing::warn!(entry = entry.name(), "gamedata zip: skipping unsafe entry");
            continue;
        };
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "gamedata zip contains a symbolic link: {}",
                entry.name()
            ));
        }
        if entry.is_dir() {
            gamedata_parent(&root, &rel)?;
            continue;
        }
        let parent = gamedata_parent(&root, rel.parent().unwrap_or(Path::new("")))?;
        let out = root.join(&rel);
        match std::fs::symlink_metadata(&out) {
            Ok(meta) if !meta.is_file() || gamedata_link(&meta) => {
                return Err(format!("unsafe gamedata file: {}", out.display()));
            },
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("inspect {}: {e}", out.display()));
            },
            _ => {},
        }
        // A fresh sibling plus rename also avoids truncating another file
        // when an existing cache entry happens to be a hard link.
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| format!("gamedata temp entropy: {e}"))?;
        let temp = parent.join(format!(".wowsp-gamedata-{}.part", hex::encode(nonce)));
        let mut fout = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("create {}: {e}", temp.display()))?;
        let result = (|| -> Result<(), String> {
            std::io::copy(&mut entry, &mut fout)
                .map_err(|e| format!("extract {}: {e}", out.display()))?;
            drop(fout);
            std::fs::rename(&temp, &out).map_err(|e| format!("replace {}: {e}", out.display()))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result?;
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
    use std::net::Ipv4Addr;
    #[cfg(test)]
    use std::net::TcpListener as StdListener;
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

    /// Server state and its global sidecars change as one lifecycle operation.
    /// The relay-config command takes this same gate before restarting a bridge.
    pub(crate) fn lifecycle_gate() -> &'static Mutex<()> {
        static GATE: Mutex<()> = Mutex::const_new(());
        &GATE
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
        /// Keep this run's ready snapshot alive until all handlers retire.
        _gamedata_workspace: Option<Arc<super::GamedataWorkspace>>,
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

    /// Handle to a fixture server: the minted token plus its shutdown signal.
    #[cfg(test)]
    pub struct ServerHandle {
        #[allow(dead_code)] // read via Debug/diagnostics in tests
        pub token: String,
        shutdown: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    #[cfg(test)]
    impl ServerHandle {
        /// Signal shutdown and WAIT for the accept loop to exit, so a
        /// restart on the same port cannot race the old listener.
        pub async fn stop(self) {
            let _ = self.shutdown.send(true);
            let _ = self.task.await;
        }
    }

    // ── start / stop ────────────────────────────────────────────────────────

    async fn prepare_server() -> Result<ServerState, String> {
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
        let workspace = Arc::new(super::GamedataWorkspace::create(
            &paths::ensure_cache_dir()?
        )?);
        let build_workspace = workspace.clone();
        tokio::spawn(async move {
            let res = build_gamedata_zip(build_workspace).await;
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
            _gamedata_workspace: Some(workspace),
            pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
            shutdown: rx,
        });
        let task = tokio::spawn(serve(listener, shared));
        Ok(ServerState {
            running: true,
            host,
            port,
            pin,
            room,
            shutdown: Some(tx),
            task: Some(task),
        })
    }

    /// Returns whether a new run started; idempotent calls must not repeat the
    /// optional gateway-code wait when an existing run is already available.
    async fn start_with<P, S, F>(
        state: &Mutex<ServerState>,
        gate: &Mutex<()>,
        prepare: P,
        start_sidecars: S,
    ) -> Result<bool, String>
    where
        P: std::future::Future<Output = Result<ServerState, String>>,
        S: FnOnce(u16, String) -> F,
        F: std::future::Future<Output = ()>,
    {
        let _lifecycle = gate.lock().await;
        let mut st = state.lock().await;
        if st.running {
            return Ok(false);
        }
        // Keep publication adjacent to preparation: once it spawns the serve
        // task there is no await at which cancellation could orphan that task.
        *st = prepare.await?;
        let (port, room) = (st.port, st.room.clone());
        drop(st);
        start_sidecars(port, room).await;
        Ok(true)
    }

    async fn start_sidecars(port: u16, room: String) {
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
        } else {
            tracing::info!("internet gateway disabled by config — LAN-only pairing");
        }
    }

    pub async fn pairing_start() -> Result<PairingStatus, String> {
        let started =
            start_with(state(), lifecycle_gate(), prepare_server(), start_sidecars).await?;
        if started && crate::commands::pairing_relay::load_relay_config().enabled {
            // Waiting for a code does not mutate lifecycle state; let stop run
            // while the gateway is offline, and wake this wait when it stops.
            let shutdown = state()
                .lock()
                .await
                .shutdown
                .as_ref()
                .map(|s| s.subscribe());
            // Bounded wait so the status returned to the UI already carries
            // the gateway-allocated code when the gateway answers. A timeout
            // just means LAN-only for now: the bridge keeps retrying in the
            // background and the next status refresh picks the code up.
            if let Some(mut shutdown) = shutdown {
                if !*shutdown.borrow() {
                    tokio::select! {
                        biased;
                        _ = shutdown.changed() => {},
                        result = crate::commands::pairing_relay::wait_for_code(std::time::Duration::from_secs(10)) => {
                            if let Err(e) = result {
                                tracing::info!(error = %e, "relay gateway unreachable — LAN-only pairing for now");
                            }
                        },
                    }
                }
            }
        }
        let st = state().lock().await;
        tracing::info!(host = %st.host, port = st.port, mode = ?status_of(&st).mode, "pairing server started");
        Ok(status_of(&st))
    }

    async fn stop_with(
        state: &Mutex<ServerState>,
        gate: &Mutex<()>,
        stop_sidecars: impl std::future::Future<Output = ()>,
    ) {
        let _lifecycle = gate.lock().await;
        let joined = {
            let mut st = state.lock().await;
            let old = std::mem::take(&mut *st);
            old.shutdown.zip(old.task)
        };
        if let Some((tx, task)) = joined {
            let _ = tx.send(true);
            // Bounded wait: the accept loop only parks on accept/shutdown, so
            // it exits immediately; the bound guards against a pathological
            // in-flight request hanging stop forever.
            super::await_shutdown(task, std::time::Duration::from_secs(5)).await;
        }
        stop_sidecars.await;
    }

    pub async fn pairing_stop() -> Result<(), String> {
        stop_with(state(), lifecycle_gate(), async {
            crate::commands::pairing_discovery::broadcast_stop().await;
            crate::commands::pairing_relay::host_session_stop().await;
        })
        .await;
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
    async fn build_gamedata_zip(
        workspace: Arc<super::GamedataWorkspace>,
    ) -> Result<Option<PathBuf>, String> {
        let data = paths::ensure_data_dir()?;
        let sources = vec![data.join("gameparams"), data.join("encyclopedia")];
        let existing: Vec<PathBuf> = sources.into_iter().filter(|d| d.is_dir()).collect();
        if existing.is_empty() {
            return Ok(None);
        }
        let dest = workspace.archive();
        let out = {
            tokio::task::spawn_blocking(move || write_gamedata_zip(&existing, &workspace.archive()))
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
    /// those from the app dirs). Must be called inside a tokio runtime.
    #[cfg(test)]
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
            _gamedata_workspace: None,
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
        let mut shutdown = shared.shutdown.clone();
        let mut connections = tokio::task::JoinSet::new();
        loop {
            if *shutdown.borrow() {
                break;
            }
            let accepted = tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                _ = connections.join_next(), if !connections.is_empty() => continue,
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
            connections.spawn(async move {
                // NO timeout wrapper: handle_conn bounds only the request
                // reading internally; the response may stream for minutes.
                if let Err(e) = handle_conn(stream, &shared).await {
                    tracing::warn!(%peer, error = %e, "pairing connection dropped");
                }
            });
        }
        // Closing the listener alone leaves accepted sockets authorized with
        // the old PIN/token. Stop owns and joins every request/response task.
        connections.shutdown().await;
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
    /// reading only the bounded first block, an unbounded full-tree listing
    /// (every archived version subfolder included) is real disk work that
    /// must never stall async runtime workers (the async
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
                _gamedata_workspace: None,
                pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
                shutdown: shutdown_rx,
            })
        }

        fn fixture_state(port: u16) -> ServerState {
            ServerState {
                running: true,
                host: "127.0.0.1".into(),
                port,
                pin: "123456".into(),
                room: "a".repeat(64),
                ..ServerState::default()
            }
        }

        #[tokio::test]
        async fn repeated_start_keeps_the_existing_run_without_restarting_sidecars() {
            let state = Mutex::new(fixture_state(1));
            let gate = Mutex::new(());
            let started = start_with(
                &state,
                &gate,
                async { panic!("a running server must not be prepared again") },
                |_, _| async { panic!("a running sidecar must not restart") },
            )
            .await
            .unwrap();
            assert!(!started, "an idempotent start skips the first-code wait");
            assert_eq!(state.lock().await.port, 1);
        }

        #[tokio::test]
        async fn stop_waits_for_pending_sidecar_start_before_retiring_the_run() {
            use std::sync::atomic::{AtomicBool, Ordering};
            let state = Mutex::new(ServerState::default());
            let gate = Mutex::new(());
            let sidecar = AtomicBool::new(false);
            let (release, ready) = tokio::sync::oneshot::channel();
            let start = start_with(
                &state,
                &gate,
                async { Ok(fixture_state(1)) },
                |_, _| async {
                    ready.await.unwrap();
                    sidecar.store(true, Ordering::SeqCst);
                },
            );
            tokio::pin!(start);
            // The real start core has published the server, but its gateway
            // setup is still awaiting an external result.
            assert!(futures::poll!(&mut start).is_pending());
            assert!(state.lock().await.running);
            let stop = stop_with(&state, &gate, async {
                sidecar.store(false, Ordering::SeqCst);
            });
            tokio::pin!(stop);
            assert!(
                futures::poll!(&mut stop).is_pending(),
                "stop must not pass pending setup"
            );
            release.send(()).unwrap();
            start.await.unwrap();
            stop.await;
            assert!(!state.lock().await.running);
            assert!(!sidecar.load(Ordering::SeqCst));
        }

        #[tokio::test]
        async fn restart_waits_until_old_stop_has_retired_all_sidecars() {
            use std::sync::atomic::{AtomicU16, Ordering};
            let gate = Mutex::new(());
            let sidecar_port = AtomicU16::new(1);
            let (release, retired) = tokio::sync::oneshot::channel();
            let (shutdown, _receiver) = watch::channel(false);
            let mut old = fixture_state(1);
            old.shutdown = Some(shutdown);
            old.task = Some(tokio::spawn(async {
                retired.await.unwrap();
            }));
            let state = Mutex::new(old);
            let stop = stop_with(&state, &gate, async {
                sidecar_port.store(0, Ordering::SeqCst);
            });
            tokio::pin!(stop);
            assert!(futures::poll!(&mut stop).is_pending());
            assert!(!state.lock().await.running);
            let start = start_with(&state, &gate, async { Ok(fixture_state(2)) }, |port, _| {
                let sidecar_port = &sidecar_port;
                async move {
                    sidecar_port.store(port, Ordering::SeqCst);
                }
            });
            tokio::pin!(start);
            assert!(
                futures::poll!(&mut start).is_pending(),
                "restart must not overtake cleanup"
            );
            release.send(()).unwrap();
            stop.await;
            start.await.unwrap();
            assert_eq!(state.lock().await.port, 2);
            assert_eq!(sidecar_port.load(Ordering::SeqCst), 2);
        }

        #[tokio::test]
        async fn stop_budget_aborts_and_joins_a_stalled_session() {
            let owner = Arc::new(());
            let worker_owner = owner.clone();
            let (release, stalled) = tokio::sync::oneshot::channel::<()>();
            let (started, running) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _owner = worker_owner;
                started.send(()).unwrap();
                let _ = stalled.await;
            });
            running.await.unwrap();
            super::super::await_shutdown(task, std::time::Duration::from_millis(10)).await;
            assert_eq!(
                Arc::strong_count(&owner),
                1,
                "stop must not detach the old worker"
            );
            assert!(
                release.send(()).is_err(),
                "cancelled session must be gone before stop returns"
            );
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
        async fn stopping_server_revokes_an_already_accepted_pair_request() {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let (_gd_tx, gd_rx) = watch::channel(GamedataState::Ready(Ok(None)));
            let (shutdown, stopped) = watch::channel(false);
            let mut shared = test_shared(gd_rx);
            Arc::get_mut(&mut shared).unwrap().shutdown = stopped;
            let task = tokio::spawn(serve(listener, shared.clone()));
            let mut client = TcpStream::connect(address).await.unwrap();
            let body = br#"{"pin":"123456"}"#;
            let head = format!(
                "POST /pair HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            client.write_all(head.as_bytes()).await.unwrap();
            client.write_all(&body[..1]).await.unwrap();
            // The serve loop and this test each hold one Arc. A third proves
            // a handler accepted the socket before shutdown, without sleeps.
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while Arc::strong_count(&shared) < 3 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            shutdown.send(true).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap();
            // Completing a request with the old PIN after stop must not mint
            // a still-usable session token on the old accepted socket.
            let _ = client.write_all(&body[1..]).await;
            let mut response = Vec::new();
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.read_to_end(&mut response),
            )
            .await;
            assert!(
                response.is_empty(),
                "stopped server answered: {}",
                String::from_utf8_lossy(&response)
            );
            assert_eq!(
                Arc::strong_count(&shared),
                1,
                "stop must join every handler"
            );
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
        // The Lesta container keeps its own extension — the replay pipeline
        // parses it natively; the extension itself is meaningful metadata.
        assert_eq!(
            sanitize_replay_name("20261001_024940_Kremlin.korablireplay").unwrap(),
            "20261001_024940_Kremlin.korablireplay"
        );
        assert_eq!(
            sanitize_replay_name("20261001_024940_Kremlin.KorabliReplay").unwrap(),
            "20261001_024940_Kremlin.KorabliReplay"
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
    fn replay_pulls_with_colliding_names_preserve_both_downloads() {
        let tmp = tempfile_dir();
        // Both transfers selected the same destination before either finished.
        let proposed = tmp.join("same.wowsreplay");
        let first = tmp.join("same.1.part");
        let second = tmp.join("same.2.part");
        std::fs::write(&first, b"first replay").unwrap();
        std::fs::write(&second, b"second replay").unwrap();
        let first_path = finalize_replay_part(&first, &proposed).unwrap();
        let second_path = finalize_replay_part(&second, &proposed).unwrap();
        assert_eq!(std::fs::read(&first_path).unwrap(), b"first replay");
        assert_eq!(std::fs::read(&second_path).unwrap(), b"second replay");
        assert_ne!(first_path, second_path);
        assert!(!first.exists() && !second.exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn replay_pull_preserves_file_created_during_download() {
        let tmp = tempfile_dir();
        let proposed = tmp.join("same.wowsreplay");
        let part = tmp.join("same.1.part");
        std::fs::write(&part, b"downloaded replay").unwrap();
        // A normal game recording or file import lands while the pull runs.
        std::fs::write(&proposed, b"local recording").unwrap();
        let downloaded = finalize_replay_part(&part, &proposed).unwrap();
        assert_eq!(std::fs::read(&proposed).unwrap(), b"local recording");
        assert_eq!(std::fs::read(&downloaded).unwrap(), b"downloaded replay");
        assert_ne!(downloaded, proposed);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn replay_write_failure_removes_only_its_reserved_file() {
        let tmp = tempfile_dir();
        let existing = tmp.join("same.wowsreplay");
        std::fs::write(&existing, b"existing replay").unwrap();
        let result = write_replay_file(&tmp, "same.wowsreplay", |file| {
            std::io::Write::write_all(file, b"incomplete")?;
            Err(std::io::Error::other("simulated storage failure"))
        });
        assert!(result.unwrap_err().contains("simulated storage failure"));
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing replay");
        assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn replay_parallel_writers_claim_different_files() {
        let tmp = tempfile_dir();
        let barrier = std::sync::Barrier::new(2);
        let paths = std::thread::scope(|scope| {
            let writers: Vec<_> = [b"first replay".as_slice(), b"second replay".as_slice()]
                .into_iter()
                .map(|bytes| {
                    let dir = &tmp;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        write_replay_file(dir, "same.wowsreplay", |file| {
                            barrier.wait();
                            std::io::Write::write_all(file, bytes)
                        })
                        .unwrap()
                    })
                })
                .collect();
            writers
                .into_iter()
                .map(|writer| writer.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_ne!(paths[0], paths[1]);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"first replay");
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"second replay");
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
    fn restarted_gamedata_build_does_not_replace_an_earlier_snapshot() {
        let tmp = tempfile_dir();
        let first = GamedataWorkspace::create(&tmp).unwrap();
        let second = GamedataWorkspace::create(&tmp).unwrap();
        let source = tmp.join("gameparams");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("a.json"), b"first server snapshot").unwrap();
        server::write_gamedata_zip(std::slice::from_ref(&source), &first.archive()).unwrap();
        let original = std::fs::read(first.archive()).unwrap();
        std::fs::write(source.join("a.json"), b"second server snapshot").unwrap();
        server::write_gamedata_zip(&[source], &second.archive()).unwrap();
        assert_eq!(
            std::fs::read(first.archive()).unwrap(),
            original,
            "a later server run must not replace an earlier session's archive"
        );
        assert_ne!(std::fs::read(second.archive()).unwrap(), original);
        let first_dir = first.0.clone();
        let second_dir = second.0.clone();
        drop(first);
        assert!(!first_dir.exists());
        assert!(second.archive().is_file());
        drop(second);
        assert!(!second_dir.exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn gamedata_workspace_outlives_a_cancelled_call_until_its_worker_finishes() {
        let tmp = tempfile_dir();
        let workspace = std::sync::Arc::new(GamedataWorkspace::create(&tmp).unwrap());
        let original_dir = workspace.0.clone();
        let replacement = GamedataWorkspace::create(&tmp).unwrap();
        std::fs::write(replacement.part(), b"new session bytes").unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker_workspace = workspace.clone();
        let worker = tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            std::fs::write(worker_workspace.part(), b"old build finishes").unwrap();
        });
        started_rx.await.unwrap();
        // Stopping the session/cancelling the caller cannot stop an already
        // running blocking job. Its owned workspace stays until it exits.
        drop(workspace);
        assert!(original_dir.is_dir());
        finish_tx.send(()).unwrap();
        worker.await.unwrap();
        assert!(!original_dir.exists());
        assert_eq!(
            std::fs::read(replacement.part()).unwrap(),
            b"new session bytes"
        );
        drop(replacement);
        std::fs::remove_dir(&tmp).unwrap();
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
        w.start_file("gameparams/ok.txt", opts).unwrap();
        w.write_all(b"ok").unwrap();
        w.start_file("../evil.txt", opts).unwrap();
        w.write_all(b"evil").unwrap();
        w.start_file("settings.json", opts).unwrap();
        w.write_all(b"replacement settings").unwrap();
        w.start_file("mods/installed.json", opts).unwrap();
        w.write_all(b"replacement ledger").unwrap();
        w.finish().unwrap();
        let out_dir = tmp.join("out2");
        std::fs::create_dir_all(&out_dir).unwrap();
        std::fs::write(out_dir.join("settings.json"), b"original settings").unwrap();
        let extracted = extract_gamedata_zip(&evil, &out_dir).unwrap();
        assert_eq!(extracted, 1);
        assert!(out_dir.join("gameparams/ok.txt").is_file());
        assert!(!tmp.join("evil.txt").exists());
        assert!(!out_dir.join("mods").exists());
        assert_eq!(
            std::fs::read(out_dir.join("settings.json")).unwrap(),
            b"original settings"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn gamedata_names_allow_only_cache_trees_without_platform_aliases() {
        for name in ["gameparams/a.json", "encyclopedia/asia/船.json"] {
            assert_eq!(gamedata_entry_path(name, false), Some(PathBuf::from(name)));
        }
        assert_eq!(
            gamedata_entry_path("gameparams/", true),
            Some(PathBuf::from("gameparams"))
        );
        for name in [
            "settings.json",
            "mods/installed.json",
            "gameparams",
            "gameparams.json/a",
            "gameparams/../settings.json",
            "gameparams/.. /settings.json",
            "gameparams/./a.json",
            "gameparams//a.json",
            "gameparams/a/",
            "gameparams/a\\b.json",
            "gameparams/a:stream",
            "gameparams/a.json.",
            "gameparams/a.json ",
            "gameparams/NUL.json",
            "gameparams/com1/x",
            "gameparams/LPT².json",
            "gameparams/a\0.json",
            "/gameparams/a.json",
            "C:/gameparams/a.json",
        ] {
            assert_eq!(gamedata_entry_path(name, false), None, "{name:?}");
        }
    }

    #[test]
    fn gamedata_rejects_archive_symlinks() {
        let tmp = tempfile_dir();
        let archive = tmp.join("cache.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        writer
            .add_symlink(
                "gameparams/link",
                "../../outside",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.finish().unwrap();
        let dest = tmp.join("dest");
        let error = extract_gamedata_zip(&archive, &dest).unwrap_err();
        assert!(error.contains("symbolic link"), "{error}");
        assert!(!dest.join("gameparams/link").exists());
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn gamedata_rejects_existing_directory_junction() {
        use std::io::Write;
        use std::os::windows::process::CommandExt;

        let tmp = tempfile_dir();
        let dest = tmp.join("dest");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("a.json"), b"original").unwrap();
        let link = dest.join("gameparams");
        // Junction creation needs neither administrator privileges nor
        // Developer Mode. Pass paths as data, never as PowerShell source.
        let created = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:WOWSP_TEST_LINK -Target $env:WOWSP_TEST_TARGET -ErrorAction Stop | Out-Null",
            ])
            .env("WOWSP_TEST_LINK", &link)
            .env("WOWSP_TEST_TARGET", &outside)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "{}",
            String::from_utf8_lossy(&created.stderr)
        );
        let archive = tmp.join("cache.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        writer
            .start_file(
                "gameparams/a.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"replacement").unwrap();
        writer.finish().unwrap();
        let result = extract_gamedata_zip(&archive, &dest);
        let contents = std::fs::read(outside.join("a.json")).unwrap();
        // Unlink the junction itself before recursively cleaning the fixture.
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(tmp).unwrap();
        assert!(result.is_err(), "junction must not be followed: {result:?}");
        assert_eq!(contents, b"original");
    }

    #[test]
    fn gamedata_replacement_does_not_modify_hard_link_target() {
        use std::io::Write;
        let tmp = tempfile_dir();
        let dest = tmp.join("dest");
        std::fs::create_dir_all(dest.join("gameparams")).unwrap();
        let original = tmp.join("original.json");
        std::fs::write(&original, b"original").unwrap();
        let target = dest.join("gameparams/a.json");
        std::fs::hard_link(&original, &target).unwrap();
        let archive = tmp.join("cache.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        writer
            .start_file(
                "gameparams/a.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"updated").unwrap();
        writer.finish().unwrap();
        assert_eq!(extract_gamedata_zip(&archive, &dest).unwrap(), 1);
        assert_eq!(std::fs::read(&target).unwrap(), b"updated");
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn gamedata_corrupt_entry_preserves_existing_cache() {
        use std::io::Write;
        let tmp = tempfile_dir();
        let dest = tmp.join("dest");
        std::fs::create_dir_all(dest.join("gameparams")).unwrap();
        let target = dest.join("gameparams/a.json");
        std::fs::write(&target, b"original").unwrap();
        let archive = tmp.join("cache.zip");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("gameparams/a.json", options).unwrap();
        writer.write_all(b"synthetic-cache-payload").unwrap();
        writer.finish().unwrap();
        let mut bytes = std::fs::read(&archive).unwrap();
        let offset = bytes
            .windows(b"synthetic-cache-payload".len())
            .position(|b| b == b"synthetic-cache-payload")
            .unwrap();
        bytes[offset] ^= 1; // Leave the original CRC in the central directory.
        std::fs::write(&archive, bytes).unwrap();
        assert!(extract_gamedata_zip(&archive, &dest).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(
            std::fs::read_dir(dest.join("gameparams")).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(tmp).unwrap();
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
