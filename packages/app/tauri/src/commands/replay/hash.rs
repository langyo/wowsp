//! Streaming content hash of one replay file — the share sheet's replay
//! fingerprint (the last six hex chars of the file's SHA-256 identify the
//! battle in the copied long image).
//!
//! Split from [`listing`] like [`reveal`]: the walk/list module stays a
//! directory scan, and this module owns the one validated read.

use anyhow::{anyhow, bail, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;

use wowsp_tauri_shared::CommandResult;

/// SHA-256 of the replay file's bytes, lowercase hex (64 chars). The webui
/// renders the tail as the replay's short fingerprint.
///
/// The path arrives from the webui but is validated like untrusted input
/// (the [`super::reveal`] policy): it must name an EXISTING replay file —
/// both clients' extensions — and is canonicalized before the read. The
/// hash streams the file on the blocking pool (replays are multi-MB; hashing
/// must not stall the async runtime or the UI).
#[tauri::command]
pub async fn replay_content_hash(path: String) -> CommandResult<String> {
    let file = resolve_replay_file(&path)?;
    Ok(tokio::task::spawn_blocking(move || hash_file(&file))
        .await
        .map_err(|e| anyhow!("replay hash task: {e}"))??)
}

/// The validated + canonicalized file behind [`replay_content_hash`] —
/// split out so the guards are unit-testable without a runtime handle.
fn resolve_replay_file(raw: &str) -> Result<PathBuf> {
    if raw.is_empty() {
        bail!("empty replay path");
    }
    let path = std::path::Path::new(raw);
    let is_replay = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(super::game_client::is_replay_extension);
    if !is_replay {
        bail!("not a replay file: {raw}");
    }
    let meta = std::fs::metadata(path).map_err(|e| anyhow!("stat {raw}: {e}"))?;
    if !meta.is_file() {
        bail!("not a file: {raw}");
    }
    dunce::canonicalize(path).map_err(|e| anyhow!("resolve {raw}: {e}"))
}

/// Streaming SHA-256 over one file (64 KiB windows).
fn hash_file(path: &std::path::Path) -> Result<String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| anyhow!("read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize() {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_target_rejects_empty_and_non_replay_paths() {
        assert!(resolve_replay_file("").is_err());
        assert!(resolve_replay_file("C:/Games/replays/clip.txt").is_err());
        // A dotfile-style bare extension is not a replay either.
        assert!(resolve_replay_file("C:/Games/replays/.wowsreplay").is_err());
    }

    #[test]
    fn hashes_the_file_bytes() {
        let tmp = std::env::temp_dir().join("wowsp_replay_content_hash_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("20250622_152405_Hotaka_15_NE_north.wowsreplay");
        std::fs::write(&file, b"wowsp").unwrap();

        let target = resolve_replay_file(&file.to_string_lossy()).unwrap();
        assert_eq!(
            hash_file(&target).unwrap(),
            "4e77cd87945e2a7b04f550cab34c60d139a3d310b96a86761caee4a9bbcd3109"
        );
        // Lesta's container extension hashes the same way.
        let lesta = tmp.join("20250622_152405.korablireplay");
        std::fs::write(&lesta, b"wowsp").unwrap();
        let target = resolve_replay_file(&lesta.to_string_lossy()).unwrap();
        assert_eq!(hash_file(&target).unwrap().len(), 64);

        std::fs::remove_dir_all(&tmp).ok();
    }
}
