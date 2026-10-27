//! Content-addressed cache for catalog packages.
//!
//! Catalog packages are immutable by sha256, and the same handful of support
//! packages (ModsInstaller / ModForge / TTaroModUtils / TeamHP, ...) are
//! referenced by dozens of entries - every "update all" pass used to download
//! those bytes again for every mod and every client. The verified archive is
//! therefore cached once under <app cache dir>/mods/pkg/<sha256>.zip
//! (crate::paths::cache_dir, so portable mode resolves it under
//! <exe>/data/cache) and reused by later installs of any entry that pins the
//! same hash.
//!
//! Safety: a hit is only served after re-hashing the cached file (chunked
//! SHA-256), so a corrupted or truncated cache entry is discarded and the
//! caller falls back to the normal download. The cache never becomes part of
//! the trust chain - the expected hash still comes from the verified catalog
//! index (super::checked_package_sha256), and a miss/store failure is never
//! fatal to an install.

use sha2::{Digest as _, Sha256};
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Best-effort cap on the cache directory. Verified packages are shared and
/// small (a few MB at most); the cap only keeps abandoned families from
/// growing the cache unboundedly. Eviction is oldest-mtime first (LRU).
const MAX_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

/// <app cache dir>/mods/pkg/, created on demand. None when the cache root
/// cannot be resolved or created - every caller then behaves like a miss.
fn cache_root() -> Option<PathBuf> {
    let root = crate::paths::ensure_cache_dir()
        .ok()?
        .join("mods")
        .join("pkg");
    match fs::create_dir_all(&root) {
        Ok(()) => Some(root),
        Err(e) => {
            tracing::debug!(dir = %root.display(), error = %e, "package cache directory unavailable");
            None
        },
    }
}

/// The catalog pins a well-formed sha256 already (checked_package_sha256);
/// this guard keeps a malformed caller argument from becoming a file name.
fn valid_sha(sha: &str) -> Option<String> {
    (sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| sha.to_ascii_lowercase())
}

/// Streaming SHA-256 of one file (None on a read failure).
fn file_sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buf).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Some(hex::encode(hasher.finalize()))
}

/// Bump the cache entry's mtime so the LRU eviction keeps recently used
/// packages (best effort - a failed touch only skews the eviction order).
fn touch(path: &Path) {
    let now = SystemTime::now();
    match fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => {
            let _ = file.set_modified(now);
        },
        Err(e) => tracing::debug!(path = %path.display(), error = %e, "package cache touch failed"),
    }
}

/// Copy the hash-verified cached archive for sha to dest (the install's
/// work-dir archive path). Returns false on a miss or when the cached bytes
/// no longer match their name - the caller then downloads normally.
pub(crate) fn copy_hit(sha: &str, dest: &Path) -> bool {
    cache_root().is_some_and(|root| copy_hit_in(&root, sha, dest))
}

/// copy_hit against an explicit cache root (tests drive their own dir).
pub(crate) fn copy_hit_in(root: &Path, sha: &str, dest: &Path) -> bool {
    let Some(sha) = valid_sha(sha) else {
        return false;
    };
    let cached = root.join(format!("{sha}.zip"));
    if !cached.is_file() {
        return false;
    }
    if file_sha256(&cached).as_deref() != Some(sha.as_str()) {
        tracing::warn!(path = %cached.display(), "discarding corrupt package cache entry");
        let _ = fs::remove_file(&cached);
        return false;
    }
    if let Some(parent) = dest.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            tracing::debug!(dir = %parent.display(), error = %e, "package cache hit could not prepare the install dir");
            return false;
        }
    }
    if let Err(e) = fs::copy(&cached, dest) {
        tracing::warn!(
            from = %cached.display(),
            to = %dest.display(),
            error = %e,
            "package cache copy failed - falling back to the download"
        );
        let _ = fs::remove_file(dest);
        return false;
    }
    touch(&cached);
    tracing::debug!(sha = %sha, "package cache hit");
    true
}

/// Cache the just-verified archive for sha. Best effort: any failure is
/// logged and ignored so an install never fails because its cache did.
pub(crate) fn store(sha: &str, archive: &Path) -> Option<PathBuf> {
    cache_root().and_then(|root| store_in(&root, sha, archive, MAX_CACHE_BYTES))
}

/// store against an explicit cache root and byte cap (tests drive their own
/// dir and a tiny cap).
pub(crate) fn store_in(root: &Path, sha: &str, archive: &Path, max_bytes: u64) -> Option<PathBuf> {
    let sha = valid_sha(sha)?;
    if !archive.is_file() {
        return None;
    }
    if let Err(e) = fs::create_dir_all(root) {
        tracing::warn!(dir = %root.display(), error = %e, "package cache store failed (install continues)");
        return None;
    }
    let cached = root.join(format!("{sha}.zip"));
    // Content-addressed: an existing entry holds the same immutable bytes.
    if cached.is_file() {
        return Some(cached);
    }
    // Copy beside the destination first so a crashed store never leaves a
    // truncated archive under the sha256 name.
    let tmp = root.join(format!(".{sha}.tmp"));
    let stored = fs::copy(archive, &tmp).and_then(|_| fs::rename(&tmp, &cached));
    if let Err(e) = stored {
        let _ = fs::remove_file(&tmp);
        // A concurrent install may have stored the same sha first.
        if cached.is_file() {
            return Some(cached);
        }
        tracing::warn!(sha = %sha, error = %e, "package cache store failed (install continues)");
        return None;
    }
    evict_in(root, max_bytes, &cached);
    Some(cached)
}

/// Drop oldest-by-mtime files until the cache holds at most max_bytes. The
/// keep entry (just stored) is never evicted; stale .tmp leftovers of
/// interrupted stores are removed unconditionally. Returns the removed count.
fn evict_in(root: &Path, max_bytes: u64, keep: &Path) -> usize {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for ent in entries.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("tmp"))
        {
            let _ = fs::remove_file(&path);
            continue;
        }
        total = total.saturating_add(meta.len());
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((mtime, meta.len(), path));
    }
    if total <= max_bytes {
        return 0;
    }
    // LRU: oldest by mtime first; the path is only a deterministic tiebreak.
    files.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));
    let mut removed = 0usize;
    for (_, len, path) in files {
        if total <= max_bytes {
            break;
        }
        if path == *keep {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!(
            removed,
            remaining_bytes = total,
            "evicted old package cache entries"
        );
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("wowsp-pkgcache-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn archive(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn store_then_hit_roundtrip_serves_identical_bytes() {
        let root = tmp("roundtrip");
        let src = archive(&root, "download.zip", b"package payload");
        let sha = sha_of(b"package payload");
        let cache = root.join("cache");
        let cached = store_in(&cache, &sha, &src, MAX_CACHE_BYTES).expect("store succeeds");
        assert!(cached.is_file());
        assert_eq!(
            cached.file_name().unwrap().to_string_lossy(),
            format!("{sha}.zip")
        );

        let dest = root.join("work/00.zip");
        assert!(copy_hit_in(&cache, &sha, &dest));
        assert_eq!(fs::read(&dest).unwrap(), b"package payload");

        // Re-storing the same immutable sha is a no-op that still succeeds.
        assert!(store_in(&cache, &sha, &src, MAX_CACHE_BYTES).is_some());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_cache_entry_is_rejected_and_discarded() {
        let root = tmp("corrupt");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let sha = sha_of(b"the real bytes");
        // A file named for the sha but holding different bytes (truncated
        // download, disk corruption) must never reach the work dir.
        fs::write(cache.join(format!("{sha}.zip")), b"the fake bytes").unwrap();
        let dest = root.join("work/00.zip");
        assert!(!copy_hit_in(&cache, &sha, &dest));
        assert!(!dest.exists());
        assert!(
            !cache.join(format!("{sha}.zip")).exists(),
            "a corrupt entry is removed so the next install re-downloads"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn wrong_sha_never_hits_and_malformed_sha_is_ignored() {
        let root = tmp("wrongsha");
        let cache = root.join("cache");
        let src = archive(&root, "download.zip", b"payload");
        let stored_sha = sha_of(b"payload");
        store_in(&cache, &stored_sha, &src, MAX_CACHE_BYTES).unwrap();

        // Asking for a different sha (catalog drift) must not serve the
        // entry cached under another hash.
        let other_sha = sha_of(b"a different payload");
        assert!(!copy_hit_in(&cache, &other_sha, &root.join("work/00.zip")));
        assert!(cache.join(format!("{stored_sha}.zip")).is_file());

        // Malformed hashes never become cache file names.
        assert!(!copy_hit_in(&cache, "../escape", &root.join("work/01.zip")));
        assert!(
            store_in(&cache, "not-a-sha", &src, MAX_CACHE_BYTES).is_none(),
            "a non-sha argument is refused"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn eviction_drops_oldest_entries_and_keeps_the_just_stored_one() {
        let root = tmp("evict");
        let cache = root.join("cache");
        let payload = [7u8; 128];
        let shas: Vec<String> = (0..3)
            .map(|i| {
                let mut bytes = payload.to_vec();
                bytes.push(i as u8);
                sha_of(&bytes)
            })
            .collect();
        let archives: Vec<PathBuf> = (0..3)
            .map(|i| {
                let mut bytes = payload.to_vec();
                bytes.push(i as u8);
                archive(&root, &format!("{i}.zip"), &bytes)
            })
            .collect();
        // Store all three under a cap that fits only two of them.
        store_in(&cache, &shas[0], &archives[0], MAX_CACHE_BYTES).unwrap();
        store_in(&cache, &shas[1], &archives[1], MAX_CACHE_BYTES).unwrap();
        // Make the eviction order unambiguous: entry 0 is the oldest.
        let set_mtime = |sha: &str, secs: u64| {
            let file = fs::OpenOptions::new()
                .write(true)
                .open(cache.join(format!("{sha}.zip")))
                .unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs))
                .unwrap();
        };
        set_mtime(&shas[0], 100);
        set_mtime(&shas[1], 200);
        store_in(&cache, &shas[2], &archives[2], 2 * 129).unwrap();

        assert!(
            !cache.join(format!("{}.zip", shas[0])).exists(),
            "oldest evicted"
        );
        assert!(cache.join(format!("{}.zip", shas[1])).exists());
        assert!(cache.join(format!("{}.zip", shas[2])).exists());

        // LRU touch: a hit on the older survivor protects it from the next
        // eviction; the untouched one goes instead.
        set_mtime(&shas[1], 100);
        set_mtime(&shas[2], 200);
        assert!(copy_hit_in(&cache, &shas[1], &root.join("work/hit.zip")));
        evict_in(&cache, 129, &root.join("no-keep"));
        assert!(
            cache.join(format!("{}.zip", shas[1])).exists(),
            "touched entry survives"
        );
        assert!(!cache.join(format!("{}.zip", shas[2])).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_temp_files_are_swept_without_counting_against_the_cap() {
        let root = tmp("tmpfiles");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join(".deadbeef.tmp"), b"partial").unwrap();
        let src = archive(&root, "download.zip", b"payload");
        let sha = sha_of(b"payload");
        store_in(&cache, &sha, &src, MAX_CACHE_BYTES).unwrap();
        assert!(!cache.join(".deadbeef.tmp").exists());
        assert!(cache.join(format!("{sha}.zip")).is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
