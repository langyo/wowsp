//! Custom seal-image overrides (one picture per stamp kind under
//! `<data_dir>/stamps/`).
//!
//! The kind-keyed file name IS the state: a `<kind>.<ext>` file present in
//! the folder means that seal shows the user's picture instead of the
//! bundled glyph, and deleting the file restores the default. No metadata
//! blob — the webui settings' seal customizer and the overlay page both
//! read the same listing, mirroring how commands::wallpaper works for
//! backgrounds.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::paths;

/// The seal kinds RatingStamp knows, in canonical order. A custom picture
/// is stored as `<kind>.<ext>`; any other file name in the folder is
/// ignored.
const STAMP_KINDS: [&str; 6] = ["miracle", "ape", "maggot", "rat", "air", "sub"];

/// The fixed stamp subdirectory of the app data root
/// (`%APPDATA%/WoWSP/stamps/` locally, `<exe>/data/stamps/` in portable
/// mode), created on first use.
fn stamps_dir() -> Result<PathBuf, String> {
    let dir = paths::ensure_data_dir()?.join("stamps");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
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

fn is_valid_kind(kind: &str) -> bool {
    STAMP_KINDS.contains(&kind)
}

/// The custom picture currently set for `kind`, if any. Only the canonical
/// extension order below can exist per kind (import clears the others).
fn find_stamp_file(dir: &Path, kind: &str) -> Option<PathBuf> {
    for ext in ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] {
        let candidate = dir.join(format!("{kind}.{ext}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// One custom seal picture. `kind` doubles as the webui-side stable key;
/// `path` is absolute so the frontend can turn it into an asset-protocol
/// URL.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StampOverride {
    pub kind: String,
    pub path: String,
}

/// List the customized seals, in canonical kind order.
#[tauri::command]
pub fn stamp_list() -> Result<Vec<StampOverride>, String> {
    let dir = stamps_dir()?;
    Ok(STAMP_KINDS
        .iter()
        .filter_map(|kind| find_stamp_file(&dir, kind))
        .map(|path| StampOverride {
            kind: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().into_owned(),
        })
        .collect())
}

/// Native image-picker → copy the picked file into the stamps dir as
/// `<kind>.<ext>` (any previous picture of the same kind is removed first,
/// so one kind maps to exactly one file). Returns the new entry, or `None`
/// when the dialog was cancelled.
#[tauri::command]
pub async fn stamp_import(kind: String) -> Result<Option<StampOverride>, String> {
    if !is_valid_kind(&kind) {
        return Err(format!("invalid stamp kind {kind:?}"));
    }
    // Mobile: no native image picker (rfd has no Android backend) — the
    // seal customizer's photo-picker bytes ride a later mobile phase.
    #[cfg(mobile)]
    {
        return Err(crate::mobile_unsupported::PICKER.into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread (same rule as
    // wallpaper_import).
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Select a seal image")
                .add_filter(
                    "Images",
                    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"],
                )
                .pick_file()
        })
        .await
        .map_err(|e| format!("stamp picker task failed: {e}"))?;

        let Some(src) = picked else {
            return Ok(None);
        };
        // Windows dialogs don't enforce the filter on a manually typed file name
        // — reject anything the listing wouldn't accept instead of importing a
        // stamp that can never resolve.
        let Some(file_name) = src.file_name().and_then(|n| n.to_str()) else {
            return Err("picked file has no usable name".into());
        };
        if !is_image_file(file_name) {
            return Err(format!("unsupported stamp image type: {file_name}"));
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_else(|| "png".into());
        let dir = stamps_dir()?;
        let dest = dir.join(format!("{kind}.{ext}"));
        // Copy via a `.part` temp name so an interrupted/disk-full copy can't
        // leave a corrupt image that the listing would pick up, then rename;
        // drop the kind's other extensions only after the new file is in place.
        let part = dir.join(format!("{kind}.{ext}.part"));
        let dest_clone = dest.clone();
        let part_clone = part.clone();
        tokio::task::spawn_blocking(move || {
            let result = std::fs::copy(&src, &part_clone)
                .map(|_| ())
                .and_then(|()| std::fs::rename(&part_clone, &dest_clone))
                .map_err(|e| format!("copy stamp image: {e}"));
            if result.is_err() {
                let _ = std::fs::remove_file(&part_clone);
            }
            result
        })
        .await
        .map_err(|e| format!("stamp copy task failed: {e}"))??;
        for ext in ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] {
            let other = dir.join(format!("{kind}.{ext}"));
            if other != dest {
                let _ = std::fs::remove_file(&other);
            }
        }
        Ok(Some(StampOverride {
            kind,
            path: dest.to_string_lossy().into_owned(),
        }))
    }
}

/// Delete the custom picture of `kind` — the seal falls back to the bundled
/// glyph. Idempotent (missing file is OK).
#[tauri::command]
pub fn stamp_reset(kind: String) -> Result<(), String> {
    if !is_valid_kind(&kind) {
        return Err(format!("invalid stamp kind {kind:?}"));
    }
    let dir = stamps_dir()?;
    for ext in ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] {
        let path = dir.join(format!("{kind}.{ext}"));
        match std::fs::remove_file(&path) {
            Ok(()) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("remove {path:?}: {e}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_kinds_are_the_canonical_six() {
        for kind in STAMP_KINDS {
            assert!(is_valid_kind(kind));
        }
        assert!(!is_valid_kind("voodoo"));
        assert!(!is_valid_kind(""));
        assert!(!is_valid_kind("Miracle"));
    }

    #[test]
    fn image_extension_allowlist() {
        assert!(is_image_file("rat.png"));
        assert!(is_image_file("rat.JPG"));
        assert!(is_image_file("air.webp"));
        assert!(!is_image_file("notes.txt"));
        assert!(!is_image_file("noext"));
        assert!(!is_image_file("evil.exe"));
    }
}
