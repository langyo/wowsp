//! The game-data sync: the `/api/gamedata` pull command, the private scratch
//! workspace it streams into, and the guarded zip extraction into the local
//! cache trees. Split from the former single-file `commands/pairing.rs`.

use anyhow::{Result, anyhow, bail};

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use wowsp_tauri_shared::{CommandResult, GamedataSyncResult, PairingProgress, PairingTarget};

use super::client::{http_error, lan_parts, relay_parts, stream_to_file};
use super::{GAMEDATA_SENTINEL, emit_progress};

/// Private scratch space for one server snapshot or client pull. Blocking
/// builders/extractors retain an Arc so cancellation cannot remove their files
/// while they are still using them, or let a later run reuse their paths.
pub(super) struct GamedataWorkspace(pub(super) PathBuf);

impl GamedataWorkspace {
    pub(super) fn create(cache: &Path) -> Result<Self> {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| anyhow!("gamedata workspace entropy: {e}"))?;
        let path = cache.join(format!("pairing-gamedata-{}", hex::encode(nonce)));
        std::fs::create_dir(&path).map_err(|e| anyhow!("create {}: {e}", path.display()))?;
        Ok(Self(path))
    }

    pub(super) fn archive(&self) -> PathBuf {
        self.0.join("pairing-gamedata.zip")
    }

    pub(super) fn part(&self) -> PathBuf {
        self.archive().with_extension("zip.part")
    }
}

impl Drop for GamedataWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
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
) -> CommandResult<GamedataSyncResult> {
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
                    .map_err(|e| anyhow!("cannot reach {host}:{port} ({e})"))?;
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
                return Err(anyhow!("no game data available on the host").into());
            }
            if !status.is_success() {
                return Err(anyhow!("{}", http_error(status)).into());
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
                // The event payload needs an owned String and anyhow errors
                // are not Clone — the Display text (identical to the
                // historical message) is what the UI toasts.
                error: Some(e.to_string()),
            },
        );
        return Err(e.into());
    }
    let data_dir = crate::paths::ensure_data_dir()?;
    let extract = {
        let workspace = workspace.clone();
        tokio::task::spawn_blocking(move || extract_gamedata_zip(&workspace.part(), &data_dir))
            .await
            .map_err(|e| anyhow!("gamedata extract task failed: {e}"))?
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
                    error: Some(e.to_string()),
                },
            );
            Err(e.into())
        },
    }
}

/// The pairing protocol exports only these two cache trees. Validate the
/// raw ZIP spelling before Path normalizes it, including Windows aliases
/// (trailing dots/spaces and DOS device names), on every platform.
pub(super) fn gamedata_entry_path(name: &str, is_dir: bool) -> Option<PathBuf> {
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
fn gamedata_parent(root: &Path, rel: &Path) -> Result<PathBuf> {
    let mut dir = root.to_path_buf();
    for part in rel.components() {
        dir.push(part);
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && !gamedata_link(&meta) => {},
            Ok(_) => bail!("unsafe gamedata directory: {}", dir.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&dir).map_err(|e| anyhow!("mkdir {}: {e}", dir.display()))?;
            },
            Err(e) => bail!("inspect {}: {e}", dir.display()),
        }
    }
    Ok(dir)
}

/// Merge only gameparams/** and encyclopedia/** from the paired host.
/// Unrelated app data, Windows path aliases and filesystem links are never
/// writable through this protocol. Each file is verified by the ZIP reader
/// before replacing its old cache entry, preserving it on CRC/read failure.
pub(crate) fn extract_gamedata_zip(archive: &Path, dest: &Path) -> Result<usize> {
    let file =
        std::fs::File::open(archive).map_err(|e| anyhow!("open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| anyhow!("read {}: {e}", archive.display()))?;
    std::fs::create_dir_all(dest).map_err(|e| anyhow!("mkdir {}: {e}", dest.display()))?;
    let root = dest
        .canonicalize()
        .map_err(|e| anyhow!("resolve {}: {e}", dest.display()))?;
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| anyhow!("zip entry {i}: {e}"))?;
        let Some(rel) = gamedata_entry_path(entry.name(), entry.is_dir()) else {
            tracing::warn!(entry = entry.name(), "gamedata zip: skipping unsafe entry");
            continue;
        };
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!("gamedata zip contains a symbolic link: {}", entry.name());
        }
        if entry.is_dir() {
            gamedata_parent(&root, &rel)?;
            continue;
        }
        let parent = gamedata_parent(&root, rel.parent().unwrap_or(Path::new("")))?;
        let out = root.join(&rel);
        match std::fs::symlink_metadata(&out) {
            Ok(meta) if !meta.is_file() || gamedata_link(&meta) => {
                bail!("unsafe gamedata file: {}", out.display());
            },
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                bail!("inspect {}: {e}", out.display());
            },
            _ => {},
        }
        // A fresh sibling plus rename also avoids truncating another file
        // when an existing cache entry happens to be a hard link.
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| anyhow!("gamedata temp entropy: {e}"))?;
        let temp = parent.join(format!(".wowsp-gamedata-{}.part", hex::encode(nonce)));
        let mut fout = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| anyhow!("create {}: {e}", temp.display()))?;
        let result = (|| -> Result<()> {
            std::io::copy(&mut entry, &mut fout)
                .map_err(|e| anyhow!("extract {}: {e}", out.display()))?;
            drop(fout);
            std::fs::rename(&temp, &out).map_err(|e| anyhow!("replace {}: {e}", out.display()))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result?;
        extracted += 1;
    }
    Ok(extracted)
}
