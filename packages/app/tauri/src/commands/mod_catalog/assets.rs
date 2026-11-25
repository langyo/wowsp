//! Online-catalog payload staging + asset serving: the mod-hub detail pane's
//! preview facility for entries that are NOT installed. One staging store per
//! catalog id lives under the cache dir:
//!
//!   <cache>/mod-preview/<safe id>/  — marker.json + merged/ (+ transient
//!                                pkg-XX.zip / pkg-XX/ / raw/ during a restage)
//!
//! [mod_catalog_stage_assets] is the heavy pass: it downloads the entry's
//! (preset-resolved) packages through the unified hub exactly like the
//! file-list preview does (content-addressed cache first, mirror ladder,
//! streaming sha256, progress id "preview:<id>"), then merges every package
//! into ONE plain res_mods-shaped tree under merged/. The fast path skips
//! straight to listing when marker.json still describes the asked-for
//! (id, version, preset, package sha set) and merged/ is present.
//!
//! The staging mirrors the install pipeline's unpack tail EXACTLY — split
//! extraction (one tree per package), the extract module's FIRST-WINS
//! [merge_package_trees] (the first copy wins a duplicated target,
//! byte-identical duplicates collapse, differing duplicates are reported as
//! conflicts — nothing silently last-wins), then ONE classification of the
//! merged tree drives a junk-filtered payload copy into merged/ — so a
//! preview always shows what an install actually writes. The final copy
//! itself stays staging-local instead of reusing mod_hub's
//! copy_tree/InstallJournal: those drag rollback snapshots, restore
//! generations and res_mods/game-root bookkeeping a throwaway preview store
//! must not create. The junk policy is shared, not duplicated: the copy
//! admits exactly the destinations [mod_hub::collect_plan_files] lists — the
//! same junk predicate (junk::is_junk_rel) the install copy loop consults,
//! so the staged tree carries precisely the files the file-list window
//! promises, minus the @game root drops (loose DLLs are not previewable
//! payload). Single-file plan entries (root .xml patches) are copied
//! directly: the classifier only emits *.xml names there, which the junk
//! predicate can never brand.
//!
//! [mod_catalog_list_assets] and [mod_catalog_read_asset] are the light
//! local halves: list the merged tree's previewable files and serve one
//! file as a browser-ready payload through the mod_hub asset helpers — the
//! SAME facility the installed/layer panes use, so image/audio/video/model
//! rows and the .wem transcode behave identically everywhere.

use anyhow::{anyhow, bail};

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use super::mod_hub::assets::{AssetFileInfo, AssetPayload};
use super::*;

/// Sibling staging stores kept after a prune: beyond the six newest (by
/// marker stagedAt) are removed, never the store this pass just wrote.
const KEEP_STAGED_STORES: usize = 6;

/// On-disk marker of a completed stage: what the merged/ tree was built
/// from. A store whose marker disagrees with the current ask (a newer entry
/// version, a different scheme, a re-published package) is stale and is
/// rebuilt from scratch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageMarker {
    id: String,
    version: String,
    /// The effective scheme (None = the entry's default list — an empty
    /// frontend string normalizes to None, matching resolve_entry_packages).
    preset: Option<String>,
    /// sha256 of every merged package, in package order.
    packages: Vec<String>,
    /// Stage completion time (unix millis) — drives the sibling prune.
    staged_at: u64,
}

/// The staging store of one catalog id under an explicit cache root (the
/// testable core of the path resolution; the command passes
/// paths::ensure_cache_dir()). Ids are remote catalog display data —
/// safe_component keeps them path-shaped.
fn staging_dir_in(cache: &Path, mod_id: &str) -> PathBuf {
    cache
        .join("mod-preview")
        .join(mod_hub::layer::safe_component(mod_id))
}

fn merged_dir_in(staging: &Path) -> PathBuf {
    staging.join("merged")
}

/// The merged tree a marker vouches for the ASKED-FOR scheme, or the
/// user-readable "not staged / staged for another scheme" errors both light
/// commands answer with. The preset gate keeps a scheme switch from serving
/// the previous scheme's payload as if it were current.
fn staged_merged_dir(staging: &Path, preset: Option<&str>) -> anyhow::Result<PathBuf> {
    let marker = read_stage_marker(staging)
        .ok_or_else(|| anyhow!("catalog payload not staged yet — download the preview first"))?;
    if marker.preset.as_deref() != preset {
        bail!("catalog payload was staged for another scheme — download the preview again");
    }
    let merged = merged_dir_in(staging);
    if !merged.is_dir() {
        bail!("catalog payload not staged yet — download the preview first");
    }
    Ok(merged)
}

fn read_stage_marker(staging: &Path) -> Option<StageMarker> {
    let raw = fs::read_to_string(staging.join("marker.json")).ok()?;
    match serde_json::from_str::<StageMarker>(&raw) {
        Ok(marker) => Some(marker),
        Err(e) => {
            tracing::warn!(error = %e, "catalog preview marker unreadable — restaging");
            None
        },
    }
}

/// Does this marker describe exactly the asked-for stage? (id, version,
/// effective scheme, every package sha in order) — anything else restages.
fn marker_matches(
    marker: &StageMarker,
    id: &str,
    version: &str,
    preset: Option<&str>,
    shas: &[String],
) -> bool {
    marker.id == id
        && marker.version == version
        && marker.preset.as_deref() == preset
        && marker.packages.len() == shas.len()
        && marker.packages.iter().zip(shas).all(|(a, b)| a == b)
}

fn write_stage_marker(
    staging: &Path,
    id: &str,
    version: &str,
    preset: Option<&str>,
    shas: &[String],
) -> anyhow::Result<()> {
    let marker = StageMarker {
        id: id.to_string(),
        version: version.to_string(),
        preset: preset.map(str::to_string),
        packages: shas.to_vec(),
        staged_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    write_stage_marker_at(staging, &marker)
}

fn write_stage_marker_at(staging: &Path, marker: &StageMarker) -> anyhow::Result<()> {
    let path = staging.join("marker.json");
    let raw = serde_json::to_string_pretty(marker)?;
    fs::write(&path, raw).map_err(|e| anyhow!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Prune sibling staging stores beyond the newest [KEEP_STAGED_STORES] by
/// marker stagedAt. The store this pass just wrote (current) is never
/// considered for removal; a sibling whose marker is missing or unreadable
/// sorts as oldest (it is stale debris either way). Returns how many
/// siblings were removed.
fn prune_stale_stages(root: &Path, current: &Path) -> anyhow::Result<usize> {
    let mut siblings: Vec<(PathBuf, u64)> = Vec::new();
    for ent in fs::read_dir(root)
        .map_err(|e| anyhow!("read {}: {e}", root.display()))?
        .flatten()
    {
        let path = ent.path();
        if !path.is_dir() || path == current {
            continue;
        }
        let staged_at = read_stage_marker(&path).map(|m| m.staged_at).unwrap_or(0);
        siblings.push((path, staged_at));
    }
    siblings.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut pruned = 0usize;
    for (path, _) in siblings.iter().skip(KEEP_STAGED_STORES) {
        if fs::remove_dir_all(path).is_ok() {
            pruned += 1;
        }
    }
    Ok(pruned)
}

/// The file mover for one plan entry of the MERGED tree: single mapped file
/// or subtree walk, lazy destination directories, junk destinations skipped
/// (the plan's junk-filtered destination list decides — the same predicate
/// the install copy loop consults). Plain copies, no journal: the merged
/// payload is throwaway staging nothing here needs to roll back, and the
/// first-wins merge upstream means no target is double-written.
fn copy_into_merged(
    from: &Path,
    to: &Path,
    merged: &Path,
    allowed: &HashSet<String>,
) -> anyhow::Result<usize> {
    if !from.exists() {
        return Err(anyhow!("{} does not exist", from.display()));
    }
    if from.is_file() {
        // A single-file plan entry is a root .xml patch (the classifier's
        // only file-shaped emission); its destination cannot be junk, so it
        // is copied without the set lookup.
        fs::create_dir_all(to.parent().unwrap_or(to))
            .map_err(|e| anyhow!("create {}: {e}", to.display()))?;
        fs::copy(from, to).map_err(|e| anyhow!("copy {}: {e}", from.display()))?;
        return Ok(1);
    }
    let mut copied = 0usize;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        let read = fs::read_dir(&src).map_err(|e| anyhow!("read {}: {e}", src.display()))?;
        for ent in read.flatten() {
            let s = ent.path();
            let d = dst.join(ent.file_name());
            if s.is_dir() {
                stack.push((s, d));
                continue;
            }
            let dest = d
                .strip_prefix(merged)
                .map_err(|e| anyhow!("{} escapes the merged tree: {e}", d.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            if !allowed.contains(&dest) {
                // Junk destination (or a file the classifier never planned —
                // a root-level stray): an install would never write it, so
                // the preview store must not keep it.
                continue;
            }
            fs::create_dir_all(d.parent().unwrap_or(&d))
                .map_err(|e| anyhow!("create {}: {e}", d.display()))?;
            fs::copy(&s, &d).map_err(|e| anyhow!("copy {}: {e}", s.display()))?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// The blocking half of a stage pass, mirroring unpack_and_install's
/// unpack tail exactly: split extraction (one tree per package), the
/// extract module's FIRST-WINS [merge_package_trees] into a raw merged
/// tree (first copy wins a duplicated target, identical duplicates
/// collapse, differing duplicates are reported — nothing silently
/// last-wins), then ONE classification of that merged root drives the
/// junk-filtered payload copy into merged/. Per-package classification
/// could plan differently than the install's single one, so the preview
/// never classifies per package. Transients (split trees, archives, the
/// raw merge tree) are dropped — the store keeps only marker.json +
/// merged/. Any failure aborts the whole pass (a partially merged payload
/// must never carry a marker), leaving a marker-less store the next
/// attempt wipes.
fn stage_archives_blocking(
    staging: &Path,
    mod_id: &str,
    archives: &[PathBuf],
    packages: &[CatalogPackage],
) -> anyhow::Result<()> {
    // Split extraction: one tree per package (the same split an install
    // extracts before its merge).
    let pkg_dirs: Vec<PathBuf> = (0..archives.len())
        .map(|i| staging.join(format!("pkg-{i:02}")))
        .collect();
    let raw = staging.join("raw");
    // Drop every transient (merged-source tree, split trees, archives), so
    // even an extract abort never leaves half-processed debris behind.
    let cleanup = |raw: &Path, pkg_dirs: &[PathBuf], archives: &[PathBuf]| {
        let _ = fs::remove_dir_all(raw);
        for dir in pkg_dirs {
            let _ = fs::remove_dir_all(dir);
        }
        for archive in archives {
            let _ = fs::remove_file(archive);
        }
    };
    for (i, archive) in archives.iter().enumerate() {
        let mut visited = Vec::new();
        if let Err(e) = super::extract_zip(archive, &pkg_dirs[i], &mut visited) {
            cleanup(&raw, &pkg_dirs, archives);
            return Err(anyhow!("extract {}: {e}", packages[i].name));
        }
    }
    // The install's exact merge: the FIRST package's copy wins a duplicated
    // target, byte-identical duplicates collapse silently, differing
    // duplicates come back as conflicts (case-folded rel identity — Windows
    // paths are case-insensitive).
    let raw = staging.join("raw");
    let (written, conflicts) = super::merge_package_trees(&pkg_dirs, &raw)?;
    for conflict in &conflicts {
        // AssetFileInfo has no warnings channel; the file-list window
        // already surfaces the full story (kept package vs ignored one).
        tracing::info!(
            rel = %conflict.rel,
            kept_package = conflict.first_package,
            ignored_package = conflict.later_package,
            "catalog preview merge kept the first package's copy"
        );
    }
    // Install parity guard: a merged tree with no files means the package
    // set unpacked to nothing recognizable (same refusal shape as the
    // install's own guard).
    if written.is_empty() {
        cleanup(&raw, &pkg_dirs, archives);
        bail!(
            "{mod_id}: the packages unpacked to nothing recognizable (archive layout drifted from the catalog)"
        );
    }
    // ONE classification of the merged root — the same resolution an
    // install applies before it writes — drives the junk-filtered payload
    // copy into merged/ (loose root DLLs stay @game drops, never staged).
    let merged = merged_dir_in(staging);
    let stage_payload = |raw: &Path, merged: &Path| -> anyhow::Result<usize> {
        let (plan_root, _loose) = super::install::package_install_layout(raw)?;
        let plan = mod_hub::classify_package(&plan_root)?;
        let allowed: HashSet<String> = mod_hub::collect_plan_files(&plan_root, &plan)?
            .into_iter()
            .collect();
        fs::create_dir_all(merged).map_err(|e| anyhow!("create {}: {e}", merged.display()))?;
        let mut copied = 0usize;
        for entry in &plan.entries {
            let from = if entry.from_rel == "." {
                plan_root.to_path_buf()
            } else {
                plan_root.join(&entry.from_rel)
            };
            let to = merged.join(&entry.to_rel);
            copied += copy_into_merged(&from, &to, merged, &allowed)?;
        }
        Ok(copied)
    };
    let copied_total = match stage_payload(&raw, &merged) {
        Ok(copied) => copied,
        Err(e) => {
            cleanup(&raw, &pkg_dirs, archives);
            return Err(e);
        },
    };
    cleanup(&raw, &pkg_dirs, archives);
    tracing::info!(
        files = copied_total,
        conflicts = conflicts.len(),
        "catalog preview stage merged (first-wins, install parity)"
    );
    Ok(())
}

/// The cached-index entry a stage pass answers for, with the delisted
/// refusal mirrored from the install/preview pair (a withdrawn mod is not
/// downloadable, whichever pane asks).
fn resolve_stage_entry(index: &CatalogIndex, mod_id: &str) -> anyhow::Result<CatalogEntry> {
    let entry = index
        .mods
        .iter()
        .find(|m| m.id == mod_id)
        .ok_or_else(|| anyhow!("{mod_id} is not in the cached catalog"))?
        .clone();
    if entry.delisted {
        bail!("{mod_id} has been delisted from the catalog — its discussion thread is closed");
    }
    Ok(entry)
}

/// List the staged store's previewable files (the light half; no network).
fn list_staged_assets(staging: &Path, preset: Option<&str>) -> anyhow::Result<Vec<AssetFileInfo>> {
    let merged = staged_merged_dir(staging, preset)?;
    Ok(mod_hub::assets::list_assets_under(&merged, &merged))
}

/// Serve one staged file as a browser-ready payload (the read core: the
/// same contained resolution + shared read path the read command wraps).
fn read_staged_asset(
    staging: &Path,
    preset: Option<&str>,
    rel_path: &str,
) -> anyhow::Result<AssetPayload> {
    let merged = staged_merged_dir(staging, preset)?;
    let path =
        mod_hub::assets::resolve_contained_file(&merged, rel_path, "the catalog preview store")?;
    mod_hub::assets::read_asset_at(&path, rel_path)
}

/// Stage (or reuse) the catalog entry's merged preview payload and return
/// its previewable file list. The heavy pass — every other preview surface
/// (installed units, layer stores) reads local bytes; only the online
/// catalog may download, so the whole download/extract tail lives here.
#[tauri::command]
pub async fn mod_catalog_stage_assets(
    app: AppHandle,
    mod_id: String,
    preset: Option<String>,
) -> CommandResult<Vec<AssetFileInfo>> {
    tracing::info!(id = %mod_id, preset = ?preset, "mod_catalog_stage_assets begin");
    let index = load_cached_index()
        .ok_or_else(|| anyhow!("catalog not loaded yet — refresh the online list first"))?;
    let entry = resolve_stage_entry(&index, &mod_id)?;
    let packages: Vec<CatalogPackage> =
        super::install::resolve_entry_packages(&entry, preset.as_deref())?;
    // Same trust chain as an install: every package must be pinned by the
    // verified index and hosted on this repo's release download tree
    // before the first byte moves (see checked_package_sha256).
    let expected_sha256 = packages
        .iter()
        .map(checked_package_sha256)
        .collect::<anyhow::Result<Vec<_>>>()?;
    // resolve_entry_packages treats None and the empty string identically;
    // the marker stores the EFFECTIVE scheme so both spellings fast-path.
    let effective_preset = preset.clone().filter(|p| !p.is_empty());

    let cache = paths::ensure_cache_dir()?;
    let staging = staging_dir_in(&cache, &mod_id);

    // Fast path: an existing marker describing this exact ask plus a live
    // merged tree — no download, no extract, just the listing.
    if let Some(marker) = read_stage_marker(&staging) {
        if marker_matches(
            &marker,
            &entry.id,
            &entry.version,
            effective_preset.as_deref(),
            &expected_sha256,
        ) && merged_dir_in(&staging).is_dir()
        {
            tracing::info!(id = %mod_id, "mod_catalog_stage_assets fast path");
            return Ok(list_staged_assets(&staging, effective_preset.as_deref())?);
        }
    }

    // Same progress bus and id the file-list preview uses, so the pane's
    // existing preview spinner covers the stage pass too.
    let progress_id = format!("preview:{}", entry.id);
    download_hub::clear_pending(kind::MOD_PACKAGE, &progress_id);
    let package_count = packages.len() as u32;
    let total = packages.iter().map(|p| p.size).sum::<u64>().max(1);
    emit_progress(
        &app,
        &progress_id,
        phase::DOWNLOAD,
        0,
        package_count,
        0,
        total,
    );

    // Restage = clean slate: the previous generation (stale marker, merged
    // tree, half-pass debris) must not leak into the new one.
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| anyhow!("clear {}: {e}", staging.display()))?;
    }
    fs::create_dir_all(&staging).map_err(|e| anyhow!("create {}: {e}", staging.display()))?;

    let mut received_total = 0u64;
    for (i, pkg) in packages.iter().enumerate() {
        let archive = staging.join(format!("pkg-{i:02}.zip"));
        // Same content-addressed cache as an install: a sibling entry that
        // shares a package costs no download at all.
        let cached = super::pkg_cache::copy_hit(&expected_sha256[i], &archive).then(|| {
            std::fs::metadata(&archive)
                .map(|m| m.len())
                .unwrap_or(pkg.size)
        });
        let bytes = match cached {
            Some(bytes) => bytes,
            None => {
                let done = download_hub::transfer(
                    Some(&app),
                    DownloadRequest {
                        expected_sha256: Some(expected_sha256[i].clone()),
                        timeout: Some(std::time::Duration::from_secs(600)),
                        base_received: received_total,
                        base_total: total.saturating_sub(pkg.size),
                        total_hint: pkg.size,
                        detail: Some(serde_json::json!({
                            "package": (i + 1) as u32,
                            "packages": package_count,
                        })),
                        ..DownloadRequest::new(
                            &progress_id,
                            kind::MOD_PACKAGE,
                            download_candidates(&pkg.url),
                            staging.join(format!("pkg-{i:02}.zip.part")),
                        )
                    },
                )
                .await
                .map_err(|e| anyhow!("download {}: {e}", pkg.name))?;
                tokio::fs::rename(&done.path, &archive)
                    .await
                    .map_err(|e| anyhow!("assemble package {i}: {e}"))?;
                // Best effort: the next install/preview of a sibling entry
                // reuses these verified bytes.
                super::pkg_cache::store(&expected_sha256[i], &archive);
                done.bytes
            },
        };
        received_total += bytes;
        emit_progress(
            &app,
            &progress_id,
            phase::DOWNLOAD,
            (i + 1) as u32,
            package_count,
            received_total,
            total,
        );
    }
    emit_progress(
        &app,
        &progress_id,
        phase::INSTALLING,
        package_count,
        package_count,
        received_total,
        total,
    );

    // Extraction + merge are blocking fs work — keep them off the async
    // runtime threads, mirroring the preview's spawn_blocking tail.
    let stage_staging = staging.clone();
    let stage_archives: Vec<PathBuf> = (0..packages.len())
        .map(|i| staging.join(format!("pkg-{i:02}.zip")))
        .collect();
    let stage_mod_id = mod_id.clone();
    let stage_packages = packages.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stage_archives_blocking(
            &stage_staging,
            &stage_mod_id,
            &stage_archives,
            &stage_packages,
        )
    })
    .await
    .map_err(|e| anyhow!("stage task: {e}"))??;
    write_stage_marker(
        &staging,
        &entry.id,
        &entry.version,
        effective_preset.as_deref(),
        &expected_sha256,
    )?;
    if let Some(root) = staging.parent() {
        let pruned = prune_stale_stages(root, &staging)?;
        if pruned > 0 {
            tracing::debug!(pruned, "pruned stale catalog preview stores");
        }
    }
    emit_progress(
        &app,
        &progress_id,
        phase::DONE,
        package_count,
        package_count,
        received_total,
        total,
    );
    let assets = list_staged_assets(&staging, effective_preset.as_deref())?;
    tracing::info!(id = %mod_id, files = assets.len(), "mod_catalog_stage_assets done");
    Ok(assets)
}

/// List the staged store of one catalog id for the asked-for scheme (light
/// local listing; a scheme mismatch reads as not-staged so the pane offers
/// its download again).
#[tauri::command]
pub fn mod_catalog_list_assets(
    mod_id: String,
    preset: Option<String>,
) -> CommandResult<Vec<AssetFileInfo>> {
    let preset = preset.filter(|p| !p.is_empty());
    let staging = staging_dir_in(&paths::ensure_cache_dir()?, &mod_id);
    Ok(list_staged_assets(&staging, preset.as_deref())?)
}

/// Serve one staged file as a browser-ready payload — the SAME facility the
/// installed/layer panes use: contained resolution against the merged tree,
/// then the shared read path (images thumbnail to PNG data URLs, native
/// audio streams as-is, .wem transcodes on demand; video/model are refused
/// there by design).
#[tauri::command]
pub fn mod_catalog_read_asset(
    mod_id: String,
    preset: Option<String>,
    rel_path: String,
) -> CommandResult<AssetPayload> {
    let preset = preset.filter(|p| !p.is_empty());
    let staging = staging_dir_in(&paths::ensure_cache_dir()?, &mod_id);
    Ok(read_staged_asset(&staging, preset.as_deref(), &rel_path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, data: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, data).unwrap();
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

    fn pkg_fixture(sha: &str) -> CatalogPackage {
        serde_json::from_value(serde_json::json!({
            "url": "u", "sha256": sha, "size": 1, "name": "p.zip"
        }))
        .unwrap()
    }

    fn entry_fixture(id: &str, version: &str, delisted: bool) -> CatalogEntry {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "category": "port",
            "version": version,
            "game": ">=15.0",
            "title": id,
            "nameZh": id,
            "nameEn": id,
            "description": "fixture",
            "delisted": delisted,
            "packages": [{
                "url": "https://github.com/langyo/wowsp/releases/download/mod-hub/p.zip",
                "sha256": "aa".repeat(32),
                "size": 1,
                "name": "p.zip"
            }]
        }))
        .unwrap()
    }

    fn index_fixture(entries: Vec<CatalogEntry>) -> CatalogIndex {
        CatalogIndex {
            source_version: "test".into(),
            game_version: "15.7.0".into(),
            fetched_at: "2026-01-01T00:00:00Z".into(),
            source_sha256: String::new(),
            mods: entries,
        }
    }

    fn marker_json(staging: &Path, staged_at: u64) {
        let marker = StageMarker {
            id: "m".into(),
            version: "1".into(),
            preset: None,
            packages: vec!["x".into()],
            staged_at,
        };
        write_stage_marker_at(staging, &marker).unwrap();
    }

    /// The blocking stage pass mirrors an install's unpack tail: TWO
    /// packages both laid out under res_mods/ merge into one raw tree, whose
    /// res_mods/ wrapper peels ONCE — the single classification of the
    /// merged root is what drives the copy (a per-package plan never runs).
    /// A duplicated target keeps the FIRST package's bytes (the differing
    /// duplicate is dropped and logged), an identical duplicate collapses
    /// silently, junk destinations never land, unplanned strays stay out,
    /// and NOTHING but marker.json + merged/ survives the pass (split trees,
    /// archives and the raw merge tree are all transient). A corrupt
    /// archive aborts the whole pass.
    #[test]
    fn stage_merges_first_wins_like_an_install() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_blocking");
        let _ = fs::remove_dir_all(&tmp);
        let staging = tmp.join("store");
        fs::create_dir_all(&staging).unwrap();
        zip_fixture(
            &staging.join("pkg-00.zip"),
            &[
                ("res_mods/gui/x.png", b"first"),
                ("res_mods/gui/shared.xml", b"<a/>"),
            ],
        );
        zip_fixture(
            &staging.join("pkg-01.zip"),
            &[
                ("res_mods/gui/x.png", b"second"),
                ("res_mods/gui/shared.xml", b"<a/>"),
                ("res_mods/gui/new.png", b"new"),
                ("res_mods/gui/screenshots/promo.png", b"promo"),
                ("res_mods/readme.txt", b"stray"),
            ],
        );
        let pkgs = vec![pkg_fixture("a"), pkg_fixture("b")];
        let archives = vec![staging.join("pkg-00.zip"), staging.join("pkg-01.zip")];
        stage_archives_blocking(&staging, "dup.mod", &archives, &pkgs).unwrap();

        let merged = staging.join("merged");
        assert_eq!(
            fs::read(merged.join("gui/x.png")).unwrap(),
            b"first",
            "the first package's copy wins a duplicated target"
        );
        assert_eq!(
            fs::read(merged.join("gui/shared.xml")).unwrap(),
            b"<a/>",
            "an identical duplicate collapses to the one copy"
        );
        assert!(merged.join("gui/new.png").is_file());
        assert!(
            !merged.join("gui/screenshots").exists(),
            "junk destinations are never written"
        );
        assert!(!merged.join("readme.txt").exists(), "strays never staged");
        for name in ["pkg-00", "pkg-01", "raw", "pkg-00.zip", "pkg-01.zip"] {
            assert!(!staging.join(name).exists(), "{name} must be transient");
        }

        // A corrupt archive aborts the whole pass (no silent partial stage).
        fs::write(staging.join("pkg-00.zip"), b"not a zip").unwrap();
        let err =
            stage_archives_blocking(&staging, "dup.mod", &[staging.join("pkg-00.zip")], &pkgs)
                .unwrap_err();
        assert!(err.to_string().contains("p.zip"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// A direct-laid-out package (no res_mods/ wrapper) classifies at its
    /// root exactly like an install's single-tree resolution.
    #[test]
    fn stage_direct_layout_package_resolves_at_its_root() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_direct");
        let _ = fs::remove_dir_all(&tmp);
        let staging = tmp.join("store");
        fs::create_dir_all(&staging).unwrap();
        zip_fixture(&staging.join("pkg-00.zip"), &[("gui/d.png", b"d")]);
        let archives = vec![staging.join("pkg-00.zip")];
        stage_archives_blocking(&staging, "direct.mod", &archives, &[pkg_fixture("a")]).unwrap();
        assert!(staging.join("merged/gui/d.png").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    /// A bare-voice package (root mod.xml + loose .wem) classifies with the
    /// from_rel "." wrapper: the whole package root lands under its
    /// banks/mods destination, mod.xml included — the voice pane's scenario
    /// titles come from it.
    #[test]
    fn stage_bare_voice_wrapper_lands_under_its_bank() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_voice");
        let _ = fs::remove_dir_all(&tmp);
        let staging = tmp.join("store");
        fs::create_dir_all(&staging).unwrap();
        zip_fixture(
            &staging.join("pkg-00.zip"),
            &[("mod.xml", b"<Name>QA_Voice</Name>"), ("line.wem", b"wem")],
        );
        let archives = vec![staging.join("pkg-00.zip")];
        stage_archives_blocking(&staging, "voice.mod", &archives, &[pkg_fixture("a")]).unwrap();
        let merged = staging.join("merged");
        assert!(
            merged.join("banks/mods/QA_Voice/line.wem").is_file(),
            "bare-voice wrapper lands under its bank"
        );
        assert!(merged.join("banks/mods/QA_Voice/mod.xml").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    /// An archive set that merges to nothing is refused with the install's
    /// own refusal shape — and leaves no payload, no transients (the store
    /// stays marker-less, so the next attempt wipes it).
    #[test]
    fn stage_empty_merge_refuses_with_the_install_shape() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_empty");
        let _ = fs::remove_dir_all(&tmp);
        let staging = tmp.join("store");
        fs::create_dir_all(&staging).unwrap();
        // A zero-entry archive extracts to an empty split tree.
        zip_fixture(&staging.join("pkg-00.zip"), &[]);
        fs::create_dir_all(staging.join("pkg-00")).unwrap();
        let archives = vec![staging.join("pkg-00.zip")];
        let err = stage_archives_blocking(&staging, "empty.mod", &archives, &[pkg_fixture("a")])
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("the packages unpacked to nothing recognizable"),
            "{err}"
        );
        assert!(!staging.join("raw").exists());
        assert!(!staging.join("pkg-00").exists());
        assert!(!staging.join("merged").exists());
        fs::remove_dir_all(&tmp).ok();
    }

    /// Marker logic: a marker describing the exact ask is the fast path
    /// (no restage); a version, scheme or package-set difference restages,
    /// and the empty-string scheme normalizes to the default scheme.
    #[test]
    fn marker_fast_path_matches_and_mismatches_restage() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_marker");
        let _ = fs::remove_dir_all(&tmp);
        let staging = tmp.join("store");
        fs::create_dir_all(&staging).unwrap();
        let shas = vec!["sha-a".to_string(), "sha-b".to_string()];
        write_stage_marker_at(
            &staging,
            &StageMarker {
                id: "m".into(),
                version: "1".into(),
                preset: None,
                packages: shas.clone(),
                staged_at: 42,
            },
        )
        .unwrap();
        let marker = read_stage_marker(&staging).expect("marker readable");
        assert_eq!(marker.staged_at, 42);

        assert!(marker_matches(&marker, "m", "1", None, &shas));
        // An empty scheme normalizes to the default BEFORE this check (the
        // command filters it) — a raw Some("") is a different ask.
        assert!(!marker_matches(&marker, "m", "1", Some(""), &shas));
        // Version drift.
        assert!(!marker_matches(&marker, "m", "2", None, &shas));
        // Scheme drift.
        assert!(!marker_matches(&marker, "m", "1", Some("dark"), &shas));
        // Re-published package (sha set drift), in order.
        assert!(!marker_matches(
            &marker,
            "m",
            "1",
            None,
            &["sha-a".into(), "sha-c".into()]
        ));
        assert!(!marker_matches(&marker, "m", "1", None, &["sha-a".into()]));
        // Another id.
        assert!(!marker_matches(&marker, "other", "1", None, &shas));

        // End to end: write_stage_marker stamps now and round-trips.
        write_stage_marker(&staging, "m", "3", Some("dark"), &["sha".into()]).unwrap();
        let written = read_stage_marker(&staging).unwrap();
        assert_eq!((written.id.as_str(), written.version.as_str()), ("m", "3"));
        assert_eq!(written.preset.as_deref(), Some("dark"));
        assert!(written.staged_at >= 42);
        fs::remove_dir_all(&tmp).ok();
    }

    /// The prune keeps the six newest sibling stores plus the store this
    /// pass just wrote; older ones (and marker-less debris) go.
    #[test]
    fn prune_keeps_the_six_newest_stores() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_prune");
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("mod-preview");
        fs::create_dir_all(&root).unwrap();
        for (i, at) in [101u64, 102, 103, 104, 105, 106, 107, 108]
            .iter()
            .enumerate()
        {
            let dir = root.join(format!("mod-{i}"));
            fs::create_dir_all(dir.join("merged")).unwrap();
            marker_json(&dir, *at);
        }
        // Marker-less debris sorts as oldest.
        fs::create_dir_all(root.join("debris")).unwrap();
        let current = root.join("mod-current");
        fs::create_dir_all(current.join("merged")).unwrap();
        marker_json(&current, 999);

        assert_eq!(prune_stale_stages(&root, &current).unwrap(), 3);
        let mut kept: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();
        assert_eq!(
            kept,
            vec![
                "mod-2",
                "mod-3",
                "mod-4",
                "mod-5",
                "mod-6",
                "mod-7",
                "mod-current"
            ],
            "the six newest siblings plus the current store survive"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// The light halves: listing before a stage errors with the user-facing
    /// sentence; a delisted id refuses at the resolve core; a staged store
    /// serves a synthesized PNG as a data URL while a ".." rel is rejected.
    #[test]
    fn light_halves_gate_list_read_and_delisted() {
        let tmp = std::env::temp_dir().join("wowsp_cat_stage_light");
        let _ = fs::remove_dir_all(&tmp);

        // Delisted refusal + unknown id at the resolve core.
        let index = index_fixture(vec![
            entry_fixture("live.mod", "2", false),
            entry_fixture("dead.mod", "1", true),
        ]);
        assert_eq!(
            resolve_stage_entry(&index, "live.mod").unwrap().version,
            "2"
        );
        let err = resolve_stage_entry(&index, "dead.mod").unwrap_err();
        assert!(err.to_string().contains("delisted"), "{err}");
        let err = resolve_stage_entry(&index, "ghost.mod").unwrap_err();
        assert!(
            err.to_string().contains("not in the cached catalog"),
            "{err}"
        );

        // Listing before a stage: marker-less store errors.
        let staging = tmp.join("store");
        fs::create_dir_all(staging.join("merged")).unwrap();
        let err = list_staged_assets(&staging, None).unwrap_err();
        assert!(
            err.to_string()
                .contains("catalog payload not staged yet — download the preview first"),
            "{err}"
        );

        // A staged store: marker + merged, PNG + voice line + scene titles.
        let merged = staging.join("merged");
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 255]));
        image::DynamicImage::ImageRgba8(img)
            .save(merged.join("pic.png"))
            .unwrap();
        touch(
            &merged.join("banks/mods/QA Voice/mod.xml"),
            b"<AudioModification.xml><ExternalEvent><Name>Play_VO_X</Name>\
              <Container><Path><FilesList><File><Name>line.wem</Name></File>\
              </FilesList></Path></Container></ExternalEvent></AudioModification.xml>",
        );
        touch(&merged.join("banks/mods/QA Voice/line.wem"), b"wem");
        marker_json(&staging, 7);

        let list = list_staged_assets(&staging, None).unwrap();
        let rels: Vec<&str> = list.iter().map(|f| f.rel.as_str()).collect();
        assert!(rels.contains(&"pic.png"), "{rels:?}");
        assert!(rels.contains(&"banks/mods/QA Voice/line.wem"), "{rels:?}");
        let wem = list.iter().find(|f| f.ext == "wem").unwrap();
        assert_eq!(wem.scene_event.as_deref(), Some("Play_VO_X"));

        let payload = read_staged_asset(&staging, None, "pic.png").unwrap();
        assert!(payload.data_url.starts_with("data:image/png;base64,"));

        // A scheme mismatch reads as not-staged: the pane offers its download
        // again instead of serving the other scheme's payload.
        let err = list_staged_assets(&staging, Some("dark")).unwrap_err();
        assert!(err.to_string().contains("another scheme"), "{err}");
        let err = read_staged_asset(&staging, Some("dark"), "pic.png").unwrap_err();
        assert!(err.to_string().contains("another scheme"), "{err}");

        // Traversal never escapes the merged tree (an escape twin sits next
        // to it on disk).
        touch(&tmp.join("escape.png"), b"escape");
        assert!(read_staged_asset(&staging, None, "../escape.png").is_err());
        assert!(read_staged_asset(&staging, None, "gui/../../escape.png").is_err());
        fs::remove_dir_all(&tmp).ok();
    }
}
