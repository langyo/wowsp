//! Publish the bundled resource snapshot without consuming the previous cache
//! or the shipped payload until all trees and their version stamp are ready.
//!
//! The shun-built installer delivers the model/dog-tag pack inside the
//! install directory (payload files, nothing more); the app publishes it
//! into its cache root on first launch via [`relocate_shipped`] — run
//! synchronously before the UI boots so the pack-aware views never race
//! the relocation. A failed run logs and retries on the next launch.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const TREES: [&str; 2] = ["models", "dogtags"];
const STAMP: &str = ".res-version.json";

struct Workspace {
    path: PathBuf,
    preserve: bool,
}

impl Workspace {
    fn create(cache: &Path) -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let path = cache.join(format!(
                ".installer-res-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        preserve: false,
                    });
                },
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "resource staging directory collision",
        ))
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    let linked = meta.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        linked || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    linked
}

/// Copy only regular files and directories, propagating every entry error.
/// Staging must own independent file contents: a locked payload can survive
/// cleanup, and a later installer may overwrite that leftover source path.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if is_link(&meta) {
        return Err(io::Error::other(format!(
            "resource path is a filesystem link: {}",
            from.display()
        )));
    }
    if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        fs::copy(from, to)?;
    } else {
        return Err(io::Error::other(format!(
            "resource path is not a regular file: {}",
            from.display()
        )));
    }
    Ok(())
}

/// The stamp leaves first and is published last. On a normal I/O failure,
/// restore every original tree before restoring its stamp. A failed rollback
/// keeps its backup directory and leaves the cache unstamped for recovery.
fn publish(cache: &Path, staged: &Path, backup: &Path) -> Result<(), String> {
    let mut saved = Vec::new();
    let mut installed = Vec::new();
    let result = (|| -> io::Result<()> {
        for name in [STAMP, "models", "dogtags"] {
            if metadata(&cache.join(name))?.is_some() {
                fs::rename(cache.join(name), backup.join(name))?;
                saved.push(name);
            }
        }
        for name in ["models", "dogtags", STAMP] {
            if metadata(&staged.join(name))?.is_some() {
                fs::rename(staged.join(name), cache.join(name))?;
                installed.push(name);
            }
        }
        Ok(())
    })();
    let Err(error) = result else { return Ok(()) };
    let mut rollback_errors = Vec::new();
    for name in installed.into_iter().rev() {
        if let Err(e) = fs::rename(cache.join(name), staged.join(name)) {
            rollback_errors.push(format!("remove replacement {name}: {e}"));
        }
    }
    for name in saved.into_iter().rev() {
        if name == STAMP && !rollback_errors.is_empty() {
            continue;
        }
        if let Err(e) = fs::rename(backup.join(name), cache.join(name)) {
            rollback_errors.push(format!("restore {name}: {e}"));
        }
    }
    if rollback_errors.is_empty() {
        Err(format!("relocate resource pack: {error}"))
    } else {
        Err(format!(
            "relocate resource pack: {error}; {}; original files retained at {}",
            rollback_errors.join("; "),
            backup.display()
        ))
    }
}

pub(crate) fn relocate(
    install_dir: &Path,
    cache: &Path,
    stamp: Option<&[u8]>,
) -> Result<(), String> {
    let inspect = || -> io::Result<Vec<&str>> {
        let mut shipped = Vec::new();
        for name in TREES {
            if let Some(meta) = metadata(&install_dir.join(name))? {
                if !meta.is_dir() || is_link(&meta) {
                    return Err(io::Error::other(format!(
                        "invalid bundled resource directory: {name}"
                    )));
                }
                shipped.push(name);
            }
        }
        Ok(shipped)
    };
    let shipped = inspect().map_err(|e| e.to_string())?;
    if shipped.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let cache = fs::canonicalize(cache).map_err(|e| e.to_string())?;
    let install_dir = fs::canonicalize(install_dir).map_err(|e| e.to_string())?;
    let in_place = install_dir == cache;
    for name in TREES {
        let target = cache.join(name);
        if let Some(meta) = metadata(&target).map_err(|e| e.to_string())? {
            if !meta.is_dir() || is_link(&meta) {
                return Err(format!(
                    "invalid resource cache directory: {}",
                    target.display()
                ));
            }
        }
        // An unusual install directory inside a cache tree must not move the
        // install itself into the recovery backup, nor recursively clone staging.
        if !in_place
            && (install_dir.starts_with(&target) || cache.starts_with(install_dir.join(name)))
        {
            return Err("resource source and destination directories overlap".into());
        }
    }
    if let Some(meta) = metadata(&cache.join(STAMP)).map_err(|e| e.to_string())? {
        if !meta.is_file() || is_link(&meta) {
            return Err("invalid resource cache version file".into());
        }
    }
    let mut work = Workspace::create(&cache).map_err(|e| e.to_string())?;
    let staged = work.path.join("new");
    let backup = work.path.join("old");
    fs::create_dir(&staged).map_err(|e| e.to_string())?;
    fs::create_dir(&backup).map_err(|e| e.to_string())?;
    for name in &shipped {
        copy_tree(&install_dir.join(name), &staged.join(name)).map_err(|e| e.to_string())?;
    }
    if let Some(stamp) = stamp {
        fs::write(staged.join(STAMP), stamp).map_err(|e| e.to_string())?;
    }
    if let Err(e) = publish(&cache, &staged, &backup) {
        // Only unfinished rollback owns irreplaceable original data here.
        work.preserve = fs::read_dir(&backup)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(true);
        return Err(e);
    }
    if !in_place {
        for name in shipped {
            // Cleanup is best-effort after commit. A locked payload remains a
            // redundant source copy; it cannot invalidate the published pack.
            let _ = fs::remove_dir_all(install_dir.join(name));
        }
    }
    Ok(())
}

/// First-launch publication of the installer-shipped pack: relocates the
/// `models/` + `dogtags/` trees from beside the executable into the cache
/// root (see [`crate::paths::cache_dir`]), stamps the cache with the
/// shipped `wowsp-res-stamp.json`, and drops the bootstrap-only `webview2/`
/// subtree the -webview2 flavor carried. A no-op (one cheap metadata
/// probe) when the payload shipped no pack — lite installs and every
/// later launch pay nothing.
pub fn relocate_shipped() -> Result<(), String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("locate the running executable: {e}"))?
        .parent()
        .ok_or("the executable has no parent directory")?
        .to_path_buf();
    // An in-place layout (the app lives inside its own cache root) has
    // nothing to relocate: the trees ARE the cache. Relocating would
    // re-copy ~500 MB on every launch and stamp-downgrade a newer
    // downloaded pack back to the shipped one.
    if crate::paths::cache_dir()? == exe_dir {
        return Ok(());
    }
    let shipped = TREES.iter().any(|name| exe_dir.join(name).is_dir());
    if !shipped {
        // The webview2/ bootstrap subtree rides the -webview2 flavor even
        // though the payload carries no pack distinction — drop it
        // regardless, best-effort.
        let _ = fs::remove_dir_all(exe_dir.join("webview2"));
        return Ok(());
    }
    let stamp = fs::read(exe_dir.join("wowsp-res-stamp.json")).ok();
    let cache = crate::paths::cache_dir()?;
    relocate(&exe_dir, &cache, stamp.as_deref())?;
    let _ = fs::remove_dir_all(exe_dir.join("webview2"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(Workspace);

    impl Fixture {
        fn new() -> Self {
            Self(Workspace::create(&std::env::temp_dir()).unwrap())
        }

        fn install(&self) -> PathBuf {
            self.0.path.join("install")
        }
        fn cache(&self) -> PathBuf {
            self.install().join("data/cache")
        }

        fn prepare(&self) {
            for name in TREES {
                fs::create_dir_all(self.install().join(name)).unwrap();
                fs::write(self.install().join(name).join("new.bin"), b"new").unwrap();
                fs::create_dir_all(self.cache().join(name)).unwrap();
                fs::write(self.cache().join(name).join("old.bin"), b"old").unwrap();
            }
            fs::write(self.cache().join(STAMP), b"old stamp").unwrap();
        }

        fn assert_original(&self) {
            for name in TREES {
                assert_eq!(
                    fs::read(self.cache().join(name).join("old.bin")).unwrap(),
                    b"old"
                );
                assert!(!self.cache().join(name).join("new.bin").exists());
                assert_eq!(
                    fs::read(self.install().join(name).join("new.bin")).unwrap(),
                    b"new"
                );
            }
            assert_eq!(fs::read(self.cache().join(STAMP)).unwrap(), b"old stamp");
        }
    }

    #[test]
    fn empty_tree_rejects_an_uncreatable_destination() {
        let fixture = Fixture::new();
        let source = fixture.0.path.join("source");
        let target = fixture.0.path.join("target");
        fs::create_dir(&source).unwrap();
        fs::write(&target, b"existing file").unwrap();
        assert!(copy_tree(&source, &target).is_err());
        assert!(source.is_dir());
        assert_eq!(fs::read(&target).unwrap(), b"existing file");
    }

    #[test]
    fn invalid_second_destination_keeps_first_tree_source_and_stamp() {
        let fixture = Fixture::new();
        fixture.prepare();
        fs::remove_dir_all(fixture.cache().join("dogtags")).unwrap();
        fs::write(fixture.cache().join("dogtags"), b"blocked destination").unwrap();
        assert!(relocate(&fixture.install(), &fixture.cache(), Some(b"new stamp")).is_err());
        assert_eq!(
            fs::read(fixture.cache().join("models/old.bin")).unwrap(),
            b"old"
        );
        assert_eq!(
            fs::read(fixture.cache().join("dogtags")).unwrap(),
            b"blocked destination"
        );
        assert_eq!(fs::read(fixture.cache().join(STAMP)).unwrap(), b"old stamp");
        for name in TREES {
            assert_eq!(
                fs::read(fixture.install().join(name).join("new.bin")).unwrap(),
                b"new"
            );
        }
    }

    #[test]
    fn successful_relocation_replaces_both_trees_before_consuming_sources() {
        let fixture = Fixture::new();
        fixture.prepare();
        relocate(&fixture.install(), &fixture.cache(), Some(b"new stamp")).unwrap();
        for name in TREES {
            assert_eq!(
                fs::read(fixture.cache().join(name).join("new.bin")).unwrap(),
                b"new"
            );
            assert!(!fixture.cache().join(name).join("old.bin").exists());
            assert!(!fixture.install().join(name).exists());
        }
        assert_eq!(fs::read(fixture.cache().join(STAMP)).unwrap(), b"new stamp");
        assert_eq!(fs::read_dir(fixture.cache()).unwrap().count(), 3);
    }

    #[test]
    fn unknown_hash_and_omitted_tree_do_not_keep_old_snapshot_metadata() {
        let fixture = Fixture::new();
        fixture.prepare();
        fs::remove_dir_all(fixture.install().join("dogtags")).unwrap();
        relocate(&fixture.install(), &fixture.cache(), None).unwrap();
        assert_eq!(
            fs::read(fixture.cache().join("models/new.bin")).unwrap(),
            b"new"
        );
        assert!(!fixture.cache().join("dogtags").exists());
        assert!(!fixture.cache().join(STAMP).exists());
    }

    #[test]
    fn lite_payload_leaves_an_existing_pack_unchanged() {
        let fixture = Fixture::new();
        fixture.prepare();
        for name in TREES {
            fs::remove_dir_all(fixture.install().join(name)).unwrap();
        }
        relocate(
            &fixture.install(),
            &fixture.cache(),
            Some(b"irrelevant stamp"),
        )
        .unwrap();
        assert_eq!(fs::read(fixture.cache().join(STAMP)).unwrap(), b"old stamp");
        for name in TREES {
            assert_eq!(
                fs::read(fixture.cache().join(name).join("old.bin")).unwrap(),
                b"old"
            );
        }
    }

    #[test]
    fn cache_at_the_install_root_does_not_delete_its_published_trees() {
        let fixture = Fixture::new();
        fixture.prepare();
        relocate(&fixture.install(), &fixture.install(), Some(b"new stamp")).unwrap();
        for name in TREES {
            assert_eq!(
                fs::read(fixture.install().join(name).join("new.bin")).unwrap(),
                b"new"
            );
        }
        assert_eq!(
            fs::read(fixture.install().join(STAMP)).unwrap(),
            b"new stamp"
        );
    }

    #[cfg(windows)]
    #[test]
    fn locked_original_never_produces_a_mixed_stamped_snapshot() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        fixture.prepare();
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(fixture.cache().join("models/old.bin"))
            .unwrap();
        let result = relocate(&fixture.install(), &fixture.cache(), Some(b"new stamp"));
        // Windows may allow renaming a parent while a child is in use. Either
        // complete replacement or a fully restored original is valid, never merge.
        if result.is_ok() {
            assert_eq!(fs::read(fixture.cache().join(STAMP)).unwrap(), b"new stamp");
            assert!(!fixture.cache().join("models/old.bin").exists());
            assert_eq!(
                fs::read(fixture.cache().join("models/new.bin")).unwrap(),
                b"new"
            );
        } else {
            fixture.assert_original();
        }
    }

    #[cfg(windows)]
    #[test]
    fn source_read_failure_keeps_both_original_trees_and_stamp() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        fixture.prepare();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(fixture.install().join("dogtags/new.bin"))
            .unwrap();
        assert!(relocate(&fixture.install(), &fixture.cache(), Some(b"new stamp")).is_err());
        drop(lock);
        fixture.assert_original();
        assert_eq!(fs::read_dir(fixture.cache()).unwrap().count(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn retained_locked_payload_cannot_mutate_the_published_cache() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        fixture.prepare();
        let source = fixture.install().join("models/new.bin");
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&source)
            .unwrap();
        relocate(&fixture.install(), &fixture.cache(), Some(b"new stamp")).unwrap();
        assert!(source.is_file(), "the open source cannot be deleted yet");
        drop(lock);
        fs::write(&source, b"next installer payload").unwrap();
        assert_eq!(
            fs::read(fixture.cache().join("models/new.bin")).unwrap(),
            b"new"
        );
        assert_eq!(fs::read(fixture.cache().join(STAMP)).unwrap(), b"new stamp");
    }

    #[cfg(windows)]
    #[test]
    fn stamp_publication_failure_rolls_back_every_tree() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        fixture.prepare();
        let staged = fixture.0.path.join("new");
        let backup = fixture.0.path.join("old");
        fs::create_dir(&staged).unwrap();
        fs::create_dir(&backup).unwrap();
        for name in TREES {
            copy_tree(&fixture.install().join(name), &staged.join(name)).unwrap();
        }
        fs::write(staged.join(STAMP), b"new stamp").unwrap();
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(staged.join(STAMP))
            .unwrap();
        assert!(publish(&fixture.cache(), &staged, &backup).is_err());
        fixture.assert_original();
        assert_eq!(fs::read_dir(backup).unwrap().count(), 0);
    }
}
