//! Filesystem inventory and removal for the out-of-band `decisions` model
//! pack (`<cache>/decisions`). Deliberately independent of the `ai` cargo
//! feature: a build without ONNX Runtime can still report or clear an
//! orphaned pack, and the commands are cheap filesystem reads.
use anyhow::anyhow;
use std::path::{Path, PathBuf};

use wowsp_tauri_shared::{CommandResult, DecisionsPackStatus};

/// The `decisions` pack directory (`<cache>/decisions`).
fn decisions_pack_dir() -> anyhow::Result<PathBuf> {
    crate::paths::cache_dir()
        .map(|dir| dir.join("decisions"))
        .map_err(|e| anyhow!("resolve cache dir: {e}"))
}

/// Inventory of the installed `decisions` pack: model presence/size and the
/// per-map terrain-LOS rasters. Purely a filesystem read — no ORT session is
/// created — and it runs on the blocking pool because the recursive size
/// walk can take seconds on a large pack.
#[tauri::command]
pub async fn decisions_pack_status() -> CommandResult<DecisionsPackStatus> {
    let dir = decisions_pack_dir()?;
    Ok(
        tokio::task::spawn_blocking(move || decisions_pack_status_at(&dir))
            .await
            .map_err(|e| anyhow!("decisions pack status task: {e}"))?,
    )
}

/// Remove the installed `decisions` pack. A model already loaded into the
/// process-wide session stays until restart (see
/// `decision_ai::DecisionModel::load_pack_or_fixture`); the settings row
/// says so.
#[tauri::command]
pub async fn clear_decisions_pack() -> CommandResult<()> {
    let dir = decisions_pack_dir()?;
    if !dir.exists() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow!("remove {}: {e}", dir.display())),
        }
    })
    .await
    .map_err(|e| anyhow!("clear decisions pack task: {e}"))??;
    Ok(())
}

fn decisions_pack_status_at(dir: &Path) -> DecisionsPackStatus {
    // symlink_metadata: a linked pack root must not make the inventory walk
    // outside the cache tree.
    let present = std::fs::symlink_metadata(dir)
        .map(|meta| meta.file_type().is_dir())
        .unwrap_or(false);
    let model = dir.join("fire_model.onnx");
    let mut los_maps = Vec::new();
    if present {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                // file_type() does not follow symlinks/junctions.
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_dir() {
                    continue;
                }
                let path = entry.path();
                if is_nonempty_file(&path.join("terrain_los.npz")) {
                    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                        los_maps.push(name.to_string());
                    }
                }
            }
        }
    }
    los_maps.sort();
    DecisionsPackStatus {
        present,
        dir: dir.to_string_lossy().into_owned(),
        size_bytes: if present {
            super::model_pack::dir_size(dir)
        } else {
            0
        },
        model_present: is_nonempty_file(&model),
        model_bytes: std::fs::symlink_metadata(&model)
            .map(|meta| meta.len())
            .unwrap_or(0),
        los_maps,
    }
}

/// A real (non-symlink) regular file with content. Zero-byte rasters are
/// unusable by `terrain_los::load_npz`, so the inventory must not count them
/// as coverage.
fn is_nonempty_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file() && meta.len() > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The inventory reports the model file and only map dirs that carry a
    /// non-empty `terrain_los.npz`; empty rasters do not count.
    #[test]
    fn status_reports_model_and_nonempty_los_maps() {
        let dir =
            std::env::temp_dir().join(format!("wowsp-decisions-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("map_b")).unwrap();
        std::fs::create_dir_all(dir.join("map_a")).unwrap();
        std::fs::write(dir.join("fire_model.onnx"), [1u8; 4]).unwrap();
        std::fs::write(dir.join("map_a/terrain_los.npz"), [0u8; 8]).unwrap();
        std::fs::write(dir.join("map_b/terrain_los.npz"), []).unwrap();
        std::fs::write(dir.join("map_b/other.bin"), [0u8; 2]).unwrap();

        let status = decisions_pack_status_at(&dir);
        assert!(status.present);
        assert!(status.model_present);
        assert_eq!(status.model_bytes, 4);
        assert_eq!(status.los_maps, vec!["map_a".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing pack is reported absent rather than as an error.
    #[test]
    fn missing_pack_is_reported_absent() {
        let dir =
            std::env::temp_dir().join(format!("wowsp-decisions-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let status = decisions_pack_status_at(&dir);
        assert!(!status.present);
        assert!(!status.model_present);
        assert_eq!(status.size_bytes, 0);
        assert!(status.los_maps.is_empty());
    }
}
