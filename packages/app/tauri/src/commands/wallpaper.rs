//! Custom wallpaper library (image files under `<data_dir>/wallpapers/`).
//!
//! The directory IS the wallpaper list: every image the user imported shows
//! up as one custom background on the webui side (id = file name, persisted
//! in localStorage), and deleting the file removes the entry. The built-in
//! solid background lives on the webui side — this module only manages the
//! imported files, so no metadata JSON is needed.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::paths;

/// The fixed wallpaper subdirectory of the app data root
/// (`%APPDATA%/WoWSP/wallpapers/` locally, `<exe>/data/wallpapers/` in
/// portable mode), created on first use.
fn wallpapers_dir() -> Result<PathBuf, String> {
    let dir = paths::ensure_data_dir()?.join("wallpapers");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {:?}: {e}", dir))?;
    Ok(dir)
}

/// Image extensions accepted by the import dialog. Anything else on disk is
/// ignored by the listing (crash leftovers, `desktop.ini`, ...).
fn is_image_file(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif"
    )
}

/// Whether `id` is a bare file name inside the wallpapers dir (no path
/// separators, no parent tricks, image extension) — the only shape
/// [`wallpaper_remove`] accepts.
fn is_valid_wallpaper_id(id: &str) -> bool {
    !id.is_empty()
        && id
            == Path::new(id)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
        && is_image_file(id)
}

/// One user-imported wallpaper image. `id` doubles as the webui-side stable
/// key; `path` is absolute so the frontend can turn it into an asset-protocol
/// URL.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperFile {
    pub id: String,
    pub name: String,
    pub path: String,
}

fn to_entry(path: PathBuf) -> Option<WallpaperFile> {
    let file_name = path.file_name()?.to_str()?.to_string();
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&file_name)
        .to_string();
    Some(WallpaperFile {
        id: file_name,
        name,
        path: path.to_string_lossy().into_owned(),
    })
}

/// List the imported wallpapers, sorted by file name for a stable order.
#[tauri::command]
pub fn wallpaper_list() -> Result<Vec<WallpaperFile>, String> {
    let dir = wallpapers_dir()?;
    let mut ids: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read {dir:?}: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_image_file(n))
        .collect();
    ids.sort();
    Ok(ids
        .into_iter()
        .filter_map(|id| to_entry(dir.join(&id)))
        .collect())
}

/// Native image-picker → copy the picked file into the wallpapers dir under
/// a fresh `wallpaper-<nanos>.<ext>` name (user files keep their originals;
/// renames avoid collisions with same-named imports). Returns the new entry,
/// or `None` when the dialog was cancelled.
#[tauri::command]
pub async fn wallpaper_import() -> Result<Option<WallpaperFile>, String> {
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread (same rule as
    // pick_game_folder / pick_export_path).
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Select a wallpaper image")
            .add_filter(
                "Images",
                &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
            )
            .pick_file()
    })
    .await
    .map_err(|e| format!("wallpaper picker task failed: {e}"))?;

    let Some(src) = picked else {
        return Ok(None);
    };
    // Windows dialogs don't enforce the filter on a manually typed file name
    // — reject anything the listing wouldn't accept instead of importing a
    // wallpaper that can never resolve.
    let Some(file_name) = src.file_name().and_then(|n| n.to_str()) else {
        return Err("picked file has no usable name".into());
    };
    if !is_image_file(file_name) {
        return Err(format!("unsupported wallpaper type: {file_name}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "png".into());
    let dir = wallpapers_dir()?;
    let dest_name = format!(
        "wallpaper-{}.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("clock error: {e}"))?
            .as_nanos(),
        ext
    );
    let dest = dir.join(&dest_name);
    let part = dir.join(format!("{dest_name}.part"));
    // Copy via a `.part` temp name so an interrupted/disk-full copy can't
    // leave a corrupt image that the listing would pick up, then rename.
    tokio::task::spawn_blocking(move || {
        let result = std::fs::copy(&src, &part)
            .map(|_| ())
            .and_then(|()| std::fs::rename(&part, &dest))
            .map_err(|e| format!("copy wallpaper: {e}"));
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        result
    })
    .await
    .map_err(|e| format!("wallpaper copy task failed: {e}"))??;
    Ok(to_entry(dir.join(dest_name)))
}

/// Delete an imported wallpaper by id (bare file name inside the dir).
/// Idempotent (missing file is OK).
#[tauri::command]
pub fn wallpaper_remove(id: String) -> Result<(), String> {
    if !is_valid_wallpaper_id(&id) {
        return Err(format!("invalid wallpaper id {id:?}"));
    }
    let path = wallpapers_dir()?.join(&id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {path:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_extension_allowlist() {
        assert!(is_image_file("a.png"));
        assert!(is_image_file("b.JPG"));
        assert!(is_image_file("c.webp"));
        assert!(!is_image_file("notes.txt"));
        assert!(!is_image_file("noext"));
        assert!(!is_image_file("evil.exe"));
    }

    #[test]
    fn wallpaper_id_must_be_a_bare_image_file_name() {
        assert!(is_valid_wallpaper_id("wallpaper-123.png"));
        // Path traversal and directory components are rejected.
        assert!(!is_valid_wallpaper_id("../secret.png"));
        assert!(!is_valid_wallpaper_id("sub/dir.png"));
        assert!(!is_valid_wallpaper_id(r"C:\Windows\evil.png"));
        // Non-image and empty ids are rejected.
        assert!(!is_valid_wallpaper_id("notes.txt"));
        assert!(!is_valid_wallpaper_id(""));
    }
}
