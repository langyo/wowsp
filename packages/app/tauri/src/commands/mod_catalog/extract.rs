//! Bounded zip extraction with the audit-M11 budgets (split from
//! mod_catalog.rs).

use anyhow::{anyhow, bail};

use super::*;

/// Audit M-11 budgets for one catalog-package extraction: hostile or
/// corrupt archives may declare tiny compressed sizes and inflate to
/// gigabytes (compression bombs) or carry absurd entry counts. Both caps
/// are generous against real mod packages (largest shipped pack ≈ 1.2 GB
/// across a few thousand files).
const EXTRACT_MAX_ENTRIES: usize = 20_000;
const EXTRACT_MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Cap for ONE extracted file (no legit mod file approaches this).
const EXTRACT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Test seam: tiny budgets so the cap paths are reachable without
/// multi-GB fixtures (the `TEST_RESTORE_ROOT` pattern).
#[cfg(test)]
pub(crate) static TEST_EXTRACT_CAPS: std::sync::Mutex<Option<(usize, u64, u64)>> =
    std::sync::Mutex::new(None);

/// The active extraction budgets (entries, per-file bytes, total bytes).
fn extract_caps() -> (usize, u64, u64) {
    #[cfg(test)]
    if let Some(caps) = TEST_EXTRACT_CAPS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return caps;
    }
    (
        EXTRACT_MAX_ENTRIES,
        EXTRACT_MAX_FILE_BYTES,
        EXTRACT_MAX_TOTAL_BYTES,
    )
}

/// Zip-slip-safe extraction; visited paths are collected for diagnostics.
pub(crate) fn extract_zip(
    archive: &Path,
    dest: &Path,
    visited: &mut Vec<String>,
) -> anyhow::Result<()> {
    let file = fs::File::open(archive).map_err(|e| anyhow!("open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| anyhow!("read {}: {e}", archive.display()))?;
    let (max_entries, max_file, max_total) = extract_caps();
    if zip.len() > max_entries {
        bail!("archive carries too many entries ({})", zip.len());
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| anyhow!("entry {i} of {}: {e}", archive.display()))?;
        // enclosed_name rejects `..` and absolute components.
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        // Early abort on an entry that DECLARES more than the per-file
        // budget (audit M-11 residual): honest headers save the per-file
        // write before it starts. A lying header is fine — the binding
        // boundary is the counted copy below, which rides ACTUAL bytes
        // (a declared compression ratio is not the gate: highly
        // compressible legit content ratios 1000:1 and must stay allowed).
        if entry.size() > max_file {
            bail!(
                "catalog entry {} declares {} bytes over the per-file extraction cap",
                rel.display(),
                entry.size()
            );
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| anyhow!("mkdir {}: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| anyhow!("mkdir {}: {e}", parent.display()))?;
        }
        let mut fout =
            fs::File::create(&out).map_err(|e| anyhow!("create {}: {e}", out.display()))?;
        // Counted copy: the declared entry size is untrusted, so the cap
        // rides the ACTUAL bytes leaving the decoder. A breach aborts (and
        // the failed install's rollback cleans the partial tree).
        let mut written = 0u64;
        let mut buf = [0u8; 256 * 1024];
        loop {
            let n = entry
                .read(&mut buf)
                .map_err(|e| anyhow!("extract {}: {e}", out.display()))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > max_file {
                bail!("{} exceeds the per-file extraction cap", out.display());
            }
            fout.write_all(&buf[..n])
                .map_err(|e| anyhow!("extract {}: {e}", out.display()))?;
        }
        total += written;
        if total > max_total {
            bail!("archive exceeds the total extraction cap");
        }
        if let Ok(rel) = out.strip_prefix(dest) {
            visited.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}
