//! The managed replays dir + filename handling (sanitize / dedupe / reserve)
//! and the webui's raw-body import command. Split from the former single-file
//! `commands/pairing.rs`.

use std::path::{Path, PathBuf};

use wowsp_tauri_shared::PairingPathResult;

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

pub(super) fn write_replay_file(
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
pub(super) fn store_replay_bytes(
    dir: &Path,
    raw_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
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
