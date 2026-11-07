//! Bounded zip extraction with the audit-M11 budgets (split from
//! mod_catalog.rs).

use anyhow::{anyhow, bail};
use std::collections::HashMap;
use std::collections::hash_map::Entry;

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
    let (max_entries, max_file, max_total) = extract_caps();
    extract_zip_with_budgets(archive, dest, visited, max_entries, max_file, max_total)
}

/// [`extract_zip`] with explicit audit-M11 budgets. Split out so tests can
/// extract with the DEFAULT budgets without touching the process-global
/// `TEST_EXTRACT_CAPS` seam: that mutex is flipped by the caps test between
/// calls, and re-entering it from a held guard would deadlock (the caps test
/// deliberately releases it around every extraction).
fn extract_zip_with_budgets(
    archive: &Path,
    dest: &Path,
    visited: &mut Vec<String>,
    max_entries: usize,
    max_file: u64,
    max_total: u64,
) -> anyhow::Result<()> {
    let file = fs::File::open(archive).map_err(|e| anyhow!("open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| anyhow!("read {}: {e}", archive.display()))?;
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

/// One target path written by more than one package of the same catalog
/// entry with DIFFERENT bytes: the FIRST package's copy is kept on disk and
/// every later differing copy is dropped. The historic single-tree
/// extraction silently kept the LAST copy instead — the live ShipIdentity
/// case (2026-11-04) blanked a port ship name when a reduced variant
/// overwrote the complete `ShipIdentity.unbound`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageConflict {
    /// Target path relative to the package tree root, forward slashes
    /// (e.g. `res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound`).
    pub(crate) rel: String,
    /// Index (in package order) of the package whose bytes were kept.
    pub(crate) first_package: usize,
    /// Index (in package order) of the package whose copy was ignored.
    pub(crate) later_package: usize,
}

/// Every regular file under `root` as `(forward-slash rel, absolute path)`,
/// sorted by rel for deterministic order. Link-shaped entries abort the walk
/// through `mod_hub::ensure_plain_source_entry` — the same trust boundary
/// the local-folder installer applies to a source tree.
fn package_files_sorted(root: &Path) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let mut files = Vec::new();
    collect_regular_files(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn collect_regular_files(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> anyhow::Result<()> {
    let entries = fs::read_dir(dir).map_err(|e| anyhow!("read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| anyhow!("read {}: {e}", dir.display()))?;
        let path = entry.path();
        mod_hub::ensure_plain_source_entry(&path)?;
        let meta =
            fs::symlink_metadata(&path).map_err(|e| anyhow!("inspect {}: {e}", path.display()))?;
        if meta.is_dir() {
            collect_regular_files(root, &path, files)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| anyhow!("relative path of {}: {e}", path.display()))?;
            files.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
    Ok(())
}

/// Whether two files carry identical bytes; streams in chunks so a
/// multi-hundred-MB package file never lands in memory whole.
fn same_file_bytes(a: &Path, b: &Path) -> anyhow::Result<bool> {
    let len_a = fs::metadata(a)
        .map_err(|e| anyhow!("inspect {}: {e}", a.display()))?
        .len();
    let len_b = fs::metadata(b)
        .map_err(|e| anyhow!("inspect {}: {e}", b.display()))?
        .len();
    if len_a != len_b {
        return Ok(false);
    }
    let mut fa = fs::File::open(a).map_err(|e| anyhow!("open {}: {e}", a.display()))?;
    let mut fb = fs::File::open(b).map_err(|e| anyhow!("open {}: {e}", b.display()))?;
    let mut buf_a = [0u8; 64 * 1024];
    let mut buf_b = [0u8; 64 * 1024];
    loop {
        let n = fa
            .read(&mut buf_a)
            .map_err(|e| anyhow!("read {}: {e}", a.display()))?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut buf_b[..n])
            .map_err(|e| anyhow!("read {}: {e}", b.display()))?;
        if buf_a[..n] != buf_b[..n] {
            return Ok(false);
        }
    }
}

/// Copy every package tree into `dest` WITHOUT letting a later package
/// silently overwrite an earlier one: the first copy of a target wins,
/// byte-identical duplicates collapse to one copy, and differing duplicates
/// are reported for the caller's warning channel. `dest` must be a fresh
/// (empty) directory.
///
/// NOTE: this re-copies every extracted byte into the merged tree, so a
/// large package set pays roughly 2x temp-disk I/O (split trees + merged
/// tree). Accepted for now: the merged tree is what classification and the
/// install work on, and the alternative (classifying per package and
/// diffing plans) would have to reproduce the classifier's root-peeling to
/// compare identical targets correctly.
///
/// Returns the tree-relative written rels (forward slashes, deterministic
/// package-then-rel order) and the conflicts found.
pub(crate) fn merge_package_trees(
    pkg_dirs: &[PathBuf],
    dest: &Path,
) -> anyhow::Result<(Vec<String>, Vec<PackageConflict>)> {
    fs::create_dir_all(dest).map_err(|e| anyhow!("create {}: {e}", dest.display()))?;
    let mut written: Vec<String> = Vec::new();
    let mut conflicts: Vec<PackageConflict> = Vec::new();
    // Case-folded rel -> index of the package whose bytes currently sit at
    // dest/<rel>: Windows paths are case-insensitive, so two packages writing
    // `res_mods/GUI/Shared.xml` and `res_mods/gui/shared.xml` hit the SAME
    // file on disk and must count as one target.
    let mut first_owner: HashMap<String, usize> = HashMap::new();
    for (index, pkg_dir) in pkg_dirs.iter().enumerate() {
        for (rel, source) in package_files_sorted(pkg_dir)? {
            let out = dest.join(&rel);
            match fs::metadata(&out) {
                Ok(meta) if meta.is_file() => {
                    if !same_file_bytes(&out, &source)? {
                        let first_package = first_owner
                            .get(&rel.to_ascii_lowercase())
                            .copied()
                            .unwrap_or(0);
                        conflicts.push(PackageConflict {
                            first_package,
                            later_package: index,
                            rel,
                        });
                    }
                },
                Ok(_) => bail!(
                    "package set writes conflicting entries: {rel} is a file in package {index} but a directory in the tree already merged"
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if let Some(parent) = out.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| anyhow!("mkdir {}: {e}", parent.display()))?;
                    }
                    fs::copy(&source, &out).map_err(|e| {
                        anyhow!("copy {} -> {}: {e}", source.display(), out.display())
                    })?;
                    written.push(rel.clone());
                    first_owner.insert(rel.to_ascii_lowercase(), index);
                },
                Err(e) => return Err(anyhow!("inspect {}: {e}", out.display())),
            }
        }
    }
    Ok((written, conflicts))
}

/// Compare already-extracted package trees for the same duplicate-target
/// conflicts `merge_package_trees` reports, WITHOUT writing a merged copy
/// (the file-list preview keeps each package tree for its own
/// classification row; only the comparison is needed there). Same
/// first-wins semantics: later packages are compared against the first
/// package that wrote the rel.
pub(crate) fn detect_package_conflicts(
    pkg_dirs: &[PathBuf],
) -> anyhow::Result<Vec<PackageConflict>> {
    // Case-folded rel -> (first package index, its source file): the same
    // Windows case-insensitive target identity the merge uses.
    let mut first_owner: HashMap<String, (usize, PathBuf)> = HashMap::new();
    let mut conflicts: Vec<PackageConflict> = Vec::new();
    for (index, pkg_dir) in pkg_dirs.iter().enumerate() {
        for (rel, source) in package_files_sorted(pkg_dir)? {
            match first_owner.entry(rel.to_ascii_lowercase()) {
                Entry::Vacant(slot) => {
                    slot.insert((index, source));
                },
                Entry::Occupied(slot) => {
                    let (first_index, first_source) = slot.get();
                    if !same_file_bytes(first_source, &source)? {
                        conflicts.push(PackageConflict {
                            first_package: *first_index,
                            later_package: index,
                            rel,
                        });
                    }
                },
            }
        }
    }
    Ok(conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("wowsp-dupguard-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zip, data).unwrap();
        }
        zip.finish().unwrap();
    }

    /// Build one real zip per package, extract each into its own tree (the
    /// install path's split step) and return the tree roots. Extraction uses
    /// the DEFAULT audit-M11 budgets directly: the caps test flips the
    /// process-global TEST_EXTRACT_CAPS seam between calls, so racing it
    /// through extract_zip would fail these tests spuriously.
    fn split_packages(tmp: &Path, packages: &[&[(&str, &[u8])]]) -> Vec<PathBuf> {
        let mut roots = Vec::new();
        for (i, entries) in packages.iter().enumerate() {
            let archive = tmp.join(format!("pkg-{i:02}.zip"));
            zip_fixture(&archive, entries);
            let root = tmp.join(format!("pkg-{i:02}"));
            extract_zip_with_budgets(
                &archive,
                &root,
                &mut Vec::new(),
                EXTRACT_MAX_ENTRIES,
                EXTRACT_MAX_FILE_BYTES,
                EXTRACT_MAX_TOTAL_BYTES,
            )
            .unwrap();
            roots.push(root);
        }
        roots
    }

    #[test]
    fn merge_package_trees_collapses_identical_duplicates() {
        let tmp = tmp_dir("identical");
        let roots = split_packages(
            &tmp,
            &[
                &[
                    (
                        "res_mods/gui/unbound2/!shipidentity/shared.unbound",
                        b"same bytes",
                    ),
                    ("res_mods/gui/a.png", b"a"),
                ],
                &[
                    (
                        "res_mods/gui/unbound2/!shipidentity/shared.unbound",
                        b"same bytes",
                    ),
                    ("res_mods/gui/b.png", b"b"),
                ],
            ],
        );
        let dest = tmp.join("merged");
        let (written, conflicts) = merge_package_trees(&roots, &dest).unwrap();
        assert!(
            conflicts.is_empty(),
            "identical bytes are not a conflict: {conflicts:?}"
        );
        assert_eq!(
            written.len(),
            3,
            "one collapsed shared copy + two extras: {written:?}"
        );
        assert_eq!(
            fs::read(dest.join("res_mods/gui/unbound2/!shipidentity/shared.unbound")).unwrap(),
            b"same bytes"
        );
        assert!(dest.join("res_mods/gui/a.png").is_file());
        assert!(dest.join("res_mods/gui/b.png").is_file());
        // Detection (the preview path) agrees with the merge.
        assert!(detect_package_conflicts(&roots).unwrap().is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn merge_package_trees_keeps_first_copy_and_reports_conflict() {
        let tmp = tmp_dir("conflict");
        let roots = split_packages(
            &tmp,
            &[
                &[
                    (
                        "res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound",
                        b"complete table",
                    ),
                    ("res_mods/gui/only-a.png", b"a"),
                ],
                &[
                    (
                        "res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound",
                        b"reduced table",
                    ),
                    ("res_mods/gui/only-b.png", b"b"),
                ],
            ],
        );
        let dest = tmp.join("merged");
        let (written, conflicts) = merge_package_trees(&roots, &dest).unwrap();
        assert_eq!(
            fs::read(dest.join("res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound"))
                .unwrap(),
            b"complete table",
            "the FIRST package's bytes stay on disk"
        );
        assert_eq!(
            written.len(),
            3,
            "the ignored duplicate is not written: {written:?}"
        );
        assert_eq!(conflicts.len(), 1, "{conflicts:?}");
        assert_eq!(
            conflicts[0].rel,
            "res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound"
        );
        assert_eq!(conflicts[0].first_package, 0);
        assert_eq!(conflicts[0].later_package, 1);
        // Detection (the preview path) reports the same conflict.
        let detected = detect_package_conflicts(&roots).unwrap();
        assert_eq!(detected, conflicts);
        fs::remove_dir_all(&tmp).ok();
    }

    /// Windows resolves `res_mods/GUI/Shared.xml` and
    /// `res_mods/gui/shared.xml` to the SAME file, so differing bytes under a
    /// case-only spelling change are still one conflicting target (not two
    /// written files). Windows-only semantics, hence the cfg gate.
    #[cfg(windows)]
    #[test]
    fn merge_package_trees_treats_case_variants_as_one_target() {
        let tmp = tmp_dir("case");
        let roots = split_packages(
            &tmp,
            &[
                &[("res_mods/GUI/Shared.xml", b"first bytes")],
                &[("res_mods/gui/shared.xml", b"later bytes")],
            ],
        );
        let dest = tmp.join("merged");
        let (written, conflicts) = merge_package_trees(&roots, &dest).unwrap();
        assert_eq!(written.len(), 1, "one target on disk: {written:?}");
        assert_eq!(conflicts.len(), 1, "{conflicts:?}");
        assert_eq!(conflicts[0].first_package, 0);
        assert_eq!(conflicts[0].later_package, 1);
        assert_eq!(conflicts[0].rel, "res_mods/gui/shared.xml");
        assert_eq!(
            fs::read(dest.join("res_mods/GUI/Shared.xml")).unwrap(),
            b"first bytes",
            "the first package's bytes stay on disk"
        );
        // Detection (the preview path) reports the same conflict.
        let detected = detect_package_conflicts(&roots).unwrap();
        assert_eq!(detected.len(), 1, "{detected:?}");
        assert_eq!(detected[0].first_package, 0);
        assert_eq!(detected[0].later_package, 1);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn merge_package_trees_copies_non_overlapping_packages() {
        let tmp = tmp_dir("disjoint");
        let roots = split_packages(
            &tmp,
            &[
                &[("res_mods/gui/a.png", b"a"), ("res_mods/a.xml", b"<a/>")],
                &[("res_mods/gui/b.png", b"b"), ("res_mods/b.xml", b"<b/>")],
            ],
        );
        let dest = tmp.join("merged");
        let (written, conflicts) = merge_package_trees(&roots, &dest).unwrap();
        assert!(conflicts.is_empty(), "{conflicts:?}");
        assert_eq!(written.len(), 4, "{written:?}");
        for rel in [
            "res_mods/gui/a.png",
            "res_mods/a.xml",
            "res_mods/gui/b.png",
            "res_mods/b.xml",
        ] {
            assert!(dest.join(rel).is_file(), "{rel} missing");
        }
        assert_eq!(fs::read(dest.join("res_mods/gui/a.png")).unwrap(), b"a");
        assert_eq!(fs::read(dest.join("res_mods/b.xml")).unwrap(), b"<b/>");
        assert!(detect_package_conflicts(&roots).unwrap().is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    /// The install leg end to end: the merged tree is what gets classified,
    /// and a differing duplicate must surface as an install-report warning
    /// naming both packages while the FIRST package's bytes stay installed
    /// (the live ShipIdentity failure shape).
    #[test]
    fn unpack_and_install_reports_duplicate_target_conflict() {
        let tmp = tmp_dir("install-conflict");
        let work = tmp.join("work");
        fs::create_dir_all(&work).unwrap();
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let rel = "res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound";
        zip_fixture(
            &package_archive(&work, 0),
            &[(rel, b"complete table"), ("res_mods/gui/a.png", b"a")],
        );
        zip_fixture(
            &package_archive(&work, 1),
            &[(rel, b"reduced table"), ("res_mods/gui/b.png", b"b")],
        );
        let mk = |name: &str| CatalogPackage {
            url: format!("https://example.com/{name}"),
            sha256: String::new(),
            size: 0,
            name: name.into(),
        };
        let packages = vec![mk("part1.zip"), mk("part2.zip")];
        let applied = unpack_and_install(
            "dup-mod",
            "Dup mod",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .unwrap();
        let res_mods = game.join("bin/1/res_mods");
        assert_eq!(
            fs::read(res_mods.join("gui/unbound2/!shipidentity/ShipIdentity.unbound")).unwrap(),
            b"complete table",
            "the first package's bytes are the installed ones"
        );
        assert!(res_mods.join("gui/a.png").is_file());
        assert!(res_mods.join("gui/b.png").is_file());
        let warnings = &applied.report.warnings;
        let warning = warnings
            .iter()
            .find(|w| w.contains("conflicting duplicate target"))
            .unwrap_or_else(|| panic!("no duplicate-target warning: {warnings:?}"));
        assert!(warning.contains(rel), "{warning}");
        assert!(warning.contains("part1.zip kept"), "{warning}");
        assert!(warning.contains("part2.zip ignored"), "{warning}");
        fs::remove_dir_all(&tmp).ok();
    }
}
