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
use std::sync::Mutex;

use crate::paths;

/// The seal kinds RatingStamp knows, in canonical order (career verdicts,
/// then the composition tags with their 老人 veteran tiers, then the merged
/// 空中神人 / 水下神人 / 空中小猴 / 水下小猴 seals). A custom picture is
/// stored as `<kind>.<ext>`; any other file name in the folder is ignored.
const STAMP_KINDS: [&str; 12] = [
    "miracle",
    "ape",
    "maggot",
    "rat",
    "air",
    "sub",
    "airVeteran",
    "subVeteran",
    "airMiracle",
    "subMiracle",
    "airApe",
    "subApe",
];
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

// All windows share the same folder. Keep its one-file-per-kind state
// consistent across imports, resets, and listings; the picker and source
// copy run outside this short filesystem transaction.
static STAMP_FILES_GATE: Mutex<()> = Mutex::new(());

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
    IMAGE_EXTENSIONS.contains(&ext.as_str())
}

fn is_valid_kind(kind: &str) -> bool {
    STAMP_KINDS.contains(&kind)
}

/// The custom picture currently set for `kind`, if any. Only the canonical
/// extension order below can exist per kind (import clears the others).
fn find_stamp_file(dir: &Path, kind: &str) -> Option<PathBuf> {
    for ext in IMAGE_EXTENSIONS {
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
    list_stamps_in(&dir)
}

fn list_stamps_in(dir: &Path) -> Result<Vec<StampOverride>, String> {
    let _gate = STAMP_FILES_GATE.lock().unwrap_or_else(|e| e.into_inner());
    Ok(STAMP_KINDS
        .iter()
        .filter_map(|kind| find_stamp_file(dir, kind))
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

/// Owns an exclusive staging directory and any old images moved into it.
/// Backups are removed only after commit or successful rollback. A failed
/// rollback leaves them here for recovery instead of silently losing data.
struct StampFiles {
    dir: PathBuf,
    backups: Vec<(PathBuf, PathBuf)>,
}

impl StampFiles {
    fn new(parent: &Path) -> Result<Self, String> {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|e| format!("stamp staging entropy: {e}"))?;
        let dir = parent.join(format!(".stamp-{}", hex::encode(nonce)));
        std::fs::create_dir(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
        Ok(Self {
            dir,
            backups: Vec::new(),
        })
    }

    fn stage_previous(
        &mut self,
        parent: &Path,
        kind: &str,
        keep: Option<&Path>,
    ) -> Result<(), String> {
        for ext in IMAGE_EXTENSIONS {
            let original = parent.join(format!("{kind}.{ext}"));
            if keep == Some(original.as_path()) {
                continue;
            }
            match std::fs::symlink_metadata(&original) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("inspect {original:?}: {e}")),
                Ok(meta) if !meta.file_type().is_file() => {
                    return Err(format!("stamp is not a regular file: {original:?}"));
                },
                Ok(_) => {},
            }
            let backup = self.dir.join(format!("{kind}.{ext}"));
            std::fs::rename(&original, &backup)
                .map_err(|e| format!("preserve {original:?}: {e}"))?;
            self.backups.push((original, backup));
        }
        Ok(())
    }

    fn rollback(&mut self, error: String) -> String {
        let mut unrestored = Vec::new();
        let mut failures = Vec::new();
        for (original, backup) in self.backups.drain(..).rev() {
            if let Err(e) = std::fs::rename(&backup, &original) {
                failures.push(format!("restore {original:?}: {e}"));
                unrestored.push((original, backup));
            }
        }
        self.backups = unrestored;
        if failures.is_empty() {
            error
        } else {
            format!(
                "{error}; {}; previous images preserved in {:?}",
                failures.join("; "),
                self.dir
            )
        }
    }

    fn commit(&mut self) {
        self.backups.clear();
    }
}

impl Drop for StampFiles {
    fn drop(&mut self) {
        if self.backups.is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn import_stamp_with(
    dir: &Path,
    kind: &str,
    src: &Path,
    ext: &str,
    publish: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<StampOverride, String> {
    let dest = dir.join(format!("{kind}.{ext}"));
    let mut work = StampFiles::new(dir)?;
    let part = work.dir.join("image.part");
    std::fs::copy(src, &part).map_err(|e| format!("copy stamp image: {e}"))?;
    let _gate = STAMP_FILES_GATE.lock().unwrap_or_else(|e| e.into_inner());
    // Keep the same-extension destination until atomic replacement. Other
    // extensions must be removable before publishing, or listing could
    // continue selecting the old image after a reported successful import.
    let result = work
        .stage_previous(dir, kind, Some(&dest))
        .and_then(|()| publish(&part, &dest).map_err(|e| format!("publish stamp image: {e}")));
    if let Err(error) = result {
        return Err(work.rollback(error));
    }
    work.commit();
    Ok(StampOverride {
        kind: kind.into(),
        path: dest.to_string_lossy().into_owned(),
    })
}

/// Native image-picker → copy the picked file into the stamps dir as
/// `<kind>.<ext>` (a failed replacement preserves the previous picture,
/// and a successful one leaves exactly one file). Returns the entry, or `None`
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
        let entry = tokio::task::spawn_blocking(move || {
            import_stamp_with(&dir, &kind, &src, &ext, |from, to| {
                std::fs::rename(from, to)
            })
        })
        .await
        .map_err(|e| format!("stamp copy task failed: {e}"))??;
        Ok(Some(entry))
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
    reset_stamp_in(&dir, &kind)
}

fn reset_stamp_in(dir: &Path, kind: &str) -> Result<(), String> {
    let mut work = StampFiles::new(dir)?;
    let _gate = STAMP_FILES_GATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(error) = work.stage_previous(dir, kind, None) {
        return Err(work.rollback(error));
    }
    work.commit();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let mut nonce = [0; 16];
            getrandom::fill(&mut nonce).unwrap();
            let root = std::env::temp_dir().join(format!("wowsp-stamps-{}", hex::encode(nonce)));
            std::fs::create_dir(&root).unwrap();
            std::fs::create_dir(root.join("stamps")).unwrap();
            Self(root)
        }

        fn dir(&self) -> PathBuf {
            self.0.join("stamps")
        }

        fn source(&self, ext: &str) -> PathBuf {
            let path = self.0.join(format!("source.{ext}"));
            std::fs::write(&path, format!("new {ext}")).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn import(dir: &Path, src: &Path, ext: &str) -> Result<StampOverride, String> {
        import_stamp_with(dir, "rat", src, ext, |from, to| std::fs::rename(from, to))
    }

    #[test]
    fn concurrent_imports_cannot_remove_each_others_published_image() {
        use std::{sync::mpsc, thread, time::Duration};

        let fixture = Fixture::new();
        let first_dir = fixture.dir();
        let first_src = fixture.source("png");
        let second_dir = fixture.dir();
        let second_src = fixture.source("jpg");
        let (published_tx, published_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = thread::spawn(move || {
            import_stamp_with(&first_dir, "rat", &first_src, "png", |from, to| {
                std::fs::rename(from, to)?;
                published_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        published_rx.recv().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let second = thread::spawn(move || {
            let result = import(&second_dir, &second_src, "jpg");
            done_tx.send(()).unwrap();
            result
        });
        // The old implementation completes the second cleanup before the first
        // resumes; a serialized import must wait until the first commits.
        let _ = done_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        let listing = list_stamps_in(&fixture.dir()).unwrap();
        assert_eq!(listing.len(), 1, "successful imports must leave one image");
        assert_eq!(std::fs::read(&listing[0].path).unwrap(), b"new jpg");
    }

    #[test]
    fn failed_publish_preserves_the_previous_image() {
        let fixture = Fixture::new();
        let old = fixture.dir().join("rat.png");
        std::fs::write(&old, b"old").unwrap();
        let result = import_stamp_with(
            &fixture.dir(),
            "rat",
            &fixture.source("jpg"),
            "jpg",
            |_, _| Err(std::io::Error::other("synthetic publish failure")),
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(old).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(fixture.dir()).unwrap().count(), 1);
    }

    #[test]
    fn reset_cannot_finish_inside_an_uncommitted_import() {
        use std::{sync::mpsc, thread, time::Duration};

        let fixture = Fixture::new();
        let dir = fixture.dir();
        let src = fixture.source("png");
        let (published_tx, published_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let importing = thread::spawn(move || {
            import_stamp_with(&dir, "rat", &src, "png", |from, to| {
                std::fs::rename(from, to)?;
                published_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        published_rx.recv().unwrap();
        let dir = fixture.dir();
        let (done_tx, done_rx) = mpsc::channel();
        let resetting = thread::spawn(move || {
            let result = reset_stamp_in(&dir, "rat");
            done_tx.send(()).unwrap();
            result
        });
        let reset_finished_early = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
        release_tx.send(()).unwrap();
        importing.join().unwrap().unwrap();
        resetting.join().unwrap().unwrap();
        assert!(
            !reset_finished_early,
            "reset must wait for the import transaction"
        );
        assert!(list_stamps_in(&fixture.dir()).unwrap().is_empty());
    }

    #[test]
    fn import_replaces_other_extensions_and_reset_is_idempotent() {
        let fixture = Fixture::new();
        std::fs::write(fixture.dir().join("rat.png"), b"old").unwrap();
        std::fs::write(fixture.dir().join("rat.gif"), b"legacy").unwrap();
        import(&fixture.dir(), &fixture.source("jpg"), "jpg").unwrap();
        assert_eq!(std::fs::read_dir(fixture.dir()).unwrap().count(), 1);
        assert_eq!(
            std::fs::read(fixture.dir().join("rat.jpg")).unwrap(),
            b"new jpg"
        );
        reset_stamp_in(&fixture.dir(), "rat").unwrap();
        reset_stamp_in(&fixture.dir(), "rat").unwrap();
        assert!(list_stamps_in(&fixture.dir()).unwrap().is_empty());
    }

    #[test]
    fn listing_waits_until_a_replacement_commits() {
        use std::{sync::mpsc, thread, time::Duration};

        let fixture = Fixture::new();
        std::fs::write(fixture.dir().join("rat.png"), b"old").unwrap();
        let dir = fixture.dir();
        let src = fixture.source("jpg");
        let (staged_tx, staged_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let importing = thread::spawn(move || {
            import_stamp_with(&dir, "rat", &src, "jpg", |from, to| {
                staged_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::fs::rename(from, to)
            })
        });
        staged_rx.recv().unwrap();
        let dir = fixture.dir();
        let (done_tx, done_rx) = mpsc::channel();
        let reading = thread::spawn(move || {
            let result = list_stamps_in(&dir);
            done_tx.send(()).unwrap();
            result
        });
        let read_finished_early = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
        release_tx.send(()).unwrap();
        importing.join().unwrap().unwrap();
        let listing = reading.join().unwrap().unwrap();
        assert!(
            !read_finished_early,
            "listing must not observe a half-committed replacement"
        );
        assert_eq!(listing.len(), 1);
        assert_eq!(std::fs::read(&listing[0].path).unwrap(), b"new jpg");
    }

    #[test]
    fn reset_does_not_remove_a_directory_named_like_an_image() {
        let fixture = Fixture::new();
        let old = fixture.dir().join("rat.png");
        std::fs::write(&old, b"old").unwrap();
        let unexpected = fixture.dir().join("rat.jpg");
        std::fs::create_dir(&unexpected).unwrap();
        std::fs::write(unexpected.join("keep.txt"), b"user file").unwrap();
        assert!(reset_stamp_in(&fixture.dir(), "rat").is_err());
        assert_eq!(std::fs::read(old).unwrap(), b"old");
        assert_eq!(
            std::fs::read(unexpected.join("keep.txt")).unwrap(),
            b"user file"
        );
    }

    #[cfg(windows)]
    #[test]
    fn failed_rollback_keeps_the_backup_and_reports_its_location() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = Fixture::new();
        std::fs::write(fixture.dir().join("rat.png"), b"old").unwrap();
        let mut locked = None;
        let mut recovery = None;
        let result = import_stamp_with(
            &fixture.dir(),
            "rat",
            &fixture.source("jpg"),
            "jpg",
            |part, _| {
                let workspace = part.parent().unwrap().to_path_buf();
                locked = Some(
                    std::fs::OpenOptions::new()
                        .read(true)
                        .share_mode(1)
                        .open(workspace.join("rat.png"))
                        .unwrap(),
                );
                recovery = Some(workspace);
                Err(std::io::Error::other("synthetic publish failure"))
            },
        );
        drop(locked);
        let error = result.err().unwrap();
        let recovery = recovery.unwrap();
        assert!(error.contains("previous images preserved"));
        assert!(error.contains(recovery.file_name().unwrap().to_str().unwrap()));
        assert_eq!(std::fs::read(recovery.join("rat.png")).unwrap(), b"old");
        assert!(!fixture.dir().join("rat.jpg").exists());
    }

    #[cfg(windows)]
    #[test]
    fn locked_previous_extension_rejects_import_without_hiding_new_image() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = Fixture::new();
        let old = fixture.dir().join("rat.png");
        std::fs::write(&old, b"old").unwrap();
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&old)
            .unwrap();
        let result = import(&fixture.dir(), &fixture.source("jpg"), "jpg");
        drop(locked);
        assert!(
            result.is_err(),
            "must not report success while listing still resolves the old image"
        );
        assert_eq!(std::fs::read(old).unwrap(), b"old");
        assert!(!fixture.dir().join("rat.jpg").exists());
    }

    #[cfg(windows)]
    #[test]
    fn failed_reset_preserves_every_previous_extension() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = Fixture::new();
        let old = fixture.dir().join("rat.png");
        let other = fixture.dir().join("rat.jpg");
        std::fs::write(&old, b"old").unwrap();
        std::fs::write(&other, b"legacy").unwrap();
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&other)
            .unwrap();
        let result = reset_stamp_in(&fixture.dir(), "rat");
        drop(locked);
        assert!(result.is_err());
        assert_eq!(std::fs::read(old).unwrap(), b"old");
        assert_eq!(std::fs::read(other).unwrap(), b"legacy");
    }

    #[test]
    fn seal_kinds_are_the_canonical_twelve() {
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
