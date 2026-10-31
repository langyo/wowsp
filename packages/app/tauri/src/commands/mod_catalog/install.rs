//! Package install: resolve, download, extract-place, journal + the
//! preview/reveal commands (split from mod_catalog.rs).

use anyhow::{anyhow, bail};

use super::*;
use sha2::{Digest, Sha256};

/// Whether a downloaded package's byte length is consistent with the
/// catalog's listed size. Publisher indexes list byte-exact sizes, but the
/// community crawl can only carry whole-KiB values — and hand-authored
/// thread bodies round EITHER way: the publisher template floors
/// (`max(1, size_bytes // 1024)` KB, real payload in
/// `[listed, listed + 1 KiB)`), while Explorer/Finder-style listings round
/// up (real payload in `(listed - 1 KiB, listed]` — e.g. an azur-lane
/// ribbon skin of 362136 bytes listed as 354 KB = 362496). The real payload
/// is therefore accepted within 1 KiB on either side of the listed value;
/// a full KiB or more off in either direction means a truncated transfer
/// or a different payload. Every sub-KiB asset clamps to "1 KB" (1024)
/// under both conventions, which the same window covers. The SHA-256 check
/// (when present) stays the authoritative integrity gate; a zero listed
/// size means "unknown".
pub(crate) fn size_within_catalog(actual: usize, listed: u64) -> bool {
    if listed == 0 {
        return true;
    }
    let actual = actual as u64;
    actual > 0 && actual + 1024 > listed && actual < listed + 1024
}

// ── Install ─────────────────────────────────────────────────────────────────

/// Drop-guard for the per-install temp work dir: every early `?` return
/// cleans up after itself instead of leaking archives into %TEMP%.
/// (Field + constructor are crate-visible for the test suite's
/// temp-dir fixtures.)
pub(crate) struct WorkDir(pub(crate) PathBuf);

impl WorkDir {
    pub(crate) fn create(temp: &Path) -> anyhow::Result<Self> {
        // Catalog identifiers are display data, never filesystem paths.
        // Create the directory exclusively before arming its cleanup guard.
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|e| anyhow!("create workdir name: {e}"))?;
        let path = temp.join(format!("wowsp-modhub-{}", hex::encode(nonce)));
        fs::create_dir(&path).map_err(|e| anyhow!("create workdir: {e}"))?;
        Ok(Self(path))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

/// Download and extraction share this private ordinal name. Asset labels
/// from the catalog may contain separators, aliases or reserved names.
pub(crate) fn package_archive(work: &Path, index: usize) -> PathBuf {
    work.join(format!("{index:02}.zip"))
}

/// The package list a named scheme resolves to: a preset id fully replaces
/// the entry's default list (a scheme IS a different prebuilt payload, not
/// an overlay); None/empty resolves to the default list (which mirrors the
/// first preset). Shared by install and the read-only file preview.
pub(crate) fn resolve_entry_packages(
    entry: &CatalogEntry,
    preset: Option<&str>,
) -> anyhow::Result<Vec<CatalogPackage>> {
    match preset.filter(|p| !p.is_empty()) {
        Some(pid) => entry
            .presets
            .iter()
            .find(|p| p.id == pid)
            .map(|p| p.packages.clone())
            .ok_or_else(|| anyhow!("{} has no preset `{pid}`", entry.id)),
        None => Ok(entry.packages.clone()),
    }
}

#[tauri::command]
pub async fn mod_catalog_install(
    window: tauri::Window,
    mod_id: String,
    game_root: String,
    app: AppHandle,
    // Named scheme to install (see CatalogPreset); None/empty resolves to
    // the entry's default package list (which mirrors the first preset).
    preset: Option<String>,
) -> CommandResult<InstallReport> {
    crate::commands::ensure_main_window_label(window.label())?;
    // Wrapped so every post-guard failure (download, unpack, ledger) lands in
    // one warn line naming the mod and the client root. Those failures used
    // to be log-invisible, which made user reports impossible to diagnose.
    let log_id = mod_id.clone();
    let log_root = game_root.clone();
    match mod_catalog_install_inner(mod_id, game_root, app, preset).await {
        Ok(report) => Ok(report),
        Err(e) => {
            tracing::warn!(id = %log_id, game_root = %log_root, error = %e, "mod_catalog_install failed");
            Err(e.into())
        },
    }
}

pub(crate) async fn mod_catalog_install_inner(
    mod_id: String,
    game_root: String,
    app: AppHandle,
    preset: Option<String>,
) -> anyhow::Result<InstallReport> {
    // Every failure of this command is otherwise log-invisible (its early
    // guards return before any download or install line) — the entry line
    // keeps "the user pressed install" distinguishable from "the UI never
    // offered the button".
    tracing::info!(id = %mod_id, preset = ?preset, "mod_catalog_install begin");
    // Drop a stale cancel pressed while no job was registered (during the
    // previous pass's unpack tail) — this attempt is user-initiated.
    download_hub::clear_pending(kind::MOD_PACKAGE, &mod_id);
    let index = load_cached_index()
        .ok_or_else(|| anyhow!("catalog not loaded yet — refresh the online list first"))?;
    let entry = index
        .mods
        .iter()
        .find(|m| m.id == mod_id)
        .ok_or_else(|| anyhow!("{mod_id} is not in the cached catalog"))?
        .clone();
    if entry.delisted {
        return Err(anyhow!(
            "{mod_id} has been delisted from the catalog — its discussion thread is closed"
        ));
    }
    // A scheme IS a different prebuilt payload, not an overlay: the chosen
    // preset's packages fully replace the default list for this install.
    let packages: Vec<CatalogPackage> = resolve_entry_packages(&entry, preset.as_deref())?;

    // Fail fast when the TARGET client is running — mutating res_mods under
    // a live client tears half-loaded mods (root-scoped: another install's
    // process elsewhere does not hold this tree open).
    // Fail fast when the game is running — mutating res_mods under a live
    // client tears half-loaded mods.
    mod_hub::ensure_game_closed(&game_root)?;
    mod_hub::ensure_res_mods_active(&game_root)?;

    // Version-compat guard, before the first byte moves: the entry's
    // published game range against the version the client's own pin
    // records. A pack one or more game versions stale is the classic
    // silent crash source (stale prebuilt panel/ship-bar overrides on a
    // newer binary — see version_guard's module docs), so a mismatch is
    // logged here and rides the install report once the install lands.
    let client_game_version = if game_root.is_empty() {
        None
    } else {
        crate::commands::game_context::preferences_active_game_version(std::path::Path::new(
            &game_root,
        ))
    };
    let version_warning =
        version_guard::compat_warning(&entry.game, client_game_version.as_deref());
    if let (Some(warning), Some(client)) = (&version_warning, client_game_version.as_deref()) {
        tracing::warn!(id = %entry.id, game = %entry.game, client, "{warning}");
    }

    // Every package must be pinned and officially hosted before the first
    // byte moves (an unverifiable package must not half-install a mod).
    let expected_sha256 = packages
        .iter()
        .map(checked_package_sha256)
        .collect::<anyhow::Result<Vec<_>>>()?;

    let package_count = packages.len() as u32;
    let total = packages.iter().map(|p| p.size).sum::<u64>().max(1);
    emit_progress(&app, &entry.id, phase::DOWNLOAD, 0, package_count, 0, total);

    let work = WorkDir::create(&std::env::temp_dir())?;

    // Every package streams through the unified download hub: mirror
    // ladder (GitHub direct first, then the CN mirrors — a plain
    // `github.com` download 404s/timeout for many CN users, which used to
    // fail every install even though the catalog itself had loaded
    // through a mirror), streaming sha256 verification and a mirror
    // dying mid-transfer failing over FROM THE COMMITTED OFFSET. Packages
    // FIFO-queue behind whatever else is downloading instead of
    // contending for the disk.
    let mut received_total = 0u64;
    // Download savings evidence: how many packages (and bytes) came from the
    // content-addressed cache instead of the network.
    let mut cache_hits = 0u32;
    let mut cache_bytes = 0u64;
    for (i, pkg) in packages.iter().enumerate() {
        let dest = package_archive(&work.0, i);
        // Content-addressed hit: shared support packages recur across dozens
        // of catalog entries, so a hash-verified cached archive is reused
        // instead of downloading the same bytes again for every mod and every
        // client.
        let cached = super::pkg_cache::copy_hit(&expected_sha256[i], &dest).then(|| {
            std::fs::metadata(&dest)
                .map(|m| m.len())
                .unwrap_or(pkg.size)
        });
        let bytes = match cached {
            Some(bytes) => {
                cache_hits += 1;
                cache_bytes += bytes;
                bytes
            },
            None => {
                let done = download_hub::transfer(
                    Some(&app),
                    DownloadRequest {
                        expected_sha256: Some(expected_sha256[i].clone()),
                        timeout: Some(std::time::Duration::from_secs(600)),
                        base_received: received_total,
                        // Actual byte counts accumulate over the pass; the total
                        // is the catalog's (KiB-rounded) sum minus this package.
                        base_total: total.saturating_sub(pkg.size),
                        total_hint: pkg.size,
                        detail: Some(serde_json::json!({
                            "package": (i + 1) as u32,
                            "packages": package_count,
                        })),
                        ..DownloadRequest::new(
                            &entry.id,
                            kind::MOD_PACKAGE,
                            download_candidates(&pkg.url),
                            package_archive(&work.0, i).with_extension("part"),
                        )
                    },
                )
                .await
                .map_err(|e| {
                    // The hub's anyhow error crosses through its Display (the
                    // historical message) — same text the String arm produced.
                    let e = e.to_string();
                    if e.contains("sha256 mismatch") {
                        anyhow!(
                            "{} failed the SHA-256 check; refresh the catalog and retry — the cached index may be stale, or the package on the release is damaged ({e})",
                            pkg.name
                        )
                    } else {
                        anyhow!("download {}: {e}", pkg.name)
                    }
                })?;
                if !size_within_catalog(done.bytes as usize, pkg.size) {
                    return Err(anyhow!(
                        "{} downloaded {} bytes, outside the catalog's listed {} (KiB-rounded) — refresh the catalog and retry; the cached index may be stale",
                        pkg.name,
                        done.bytes,
                        pkg.size
                    ));
                }
                tokio::fs::rename(&done.path, &dest)
                    .await
                    .map_err(|e| anyhow!("assemble {}: {e}", dest.display()))?;
                // Cache the verified archive for the next install (best effort:
                // a cache failure must never fail the install).
                super::pkg_cache::store(&expected_sha256[i], &dest);
                done.bytes
            },
        };
        received_total += bytes;
        emit_progress(
            &app,
            &entry.id,
            phase::DOWNLOAD,
            (i + 1) as u32,
            package_count,
            received_total,
            total,
        );
    }

    emit_progress(
        &app,
        &entry.id,
        phase::INSTALLING,
        package_count,
        package_count,
        received_total,
        total,
    );

    // Serialize the disk side (unpack, res_mods writes, ledger) while other
    // installs may still be in their download phase. The game guard runs
    // again here: the client may have been launched while the download ran.
    let _gate = mod_hub_gate().await;
    mod_hub::ensure_game_closed(&game_root)?;
    mod_hub::ensure_res_mods_active(&game_root)?;

    let mut ledger = load_ledger();
    // Unpack + classify + write are blocking fs work — keep them off the
    // async runtime threads.
    let unpack_id = entry.id.clone();
    let unpack_name = entry_display_name(&entry);
    let unpack_root = game_root.clone();
    let unpack_pkgs = packages.clone();
    let unpack_work = work.0.clone();
    let unpack_supersedes: Vec<String> = entry
        .supersedes
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let (outcome, mut ledger) = tauri::async_runtime::spawn_blocking(move || {
        let outcome = unpack_and_install(
            &unpack_id,
            &unpack_name,
            &unpack_work,
            &unpack_root,
            &unpack_pkgs,
            &unpack_supersedes,
            &mut ledger.installs,
        );
        (outcome, ledger)
    })
    .await
    .map_err(|e| anyhow!("install task: {e}"))?;
    let unpacked = match outcome {
        Ok(done) => done,
        Err(e) => {
            // The rewind already changed the ledger even though the unpack
            // failed — persist it so the on-disk ledger does not describe
            // files that are already gone.
            if let Err(se) = save_ledger(&ledger) {
                tracing::warn!(error = %se, "ledger save failed after failed install");
            }
            return Err(e);
        },
    };

    // Say whose files this install clobbered (the journal already
    // snapshotted them — this is the visibility half of the conflict
    // policy the design doc promises).
    let mut report = unpacked.report;
    let conflicts = mod_hub::conflict_warnings(
        &unpacked.written,
        &ledger.installs,
        &entry.id,
        &report.bin_version,
        &game_root,
    );
    report.conflicts = conflicts.clone();
    report.warnings.extend(conflicts);
    // The version-compat verdict computed before the download: pinned onto
    // the report the report pane renders verbatim, after the conflicts,
    // so a stale-pack install can never look clean.
    if let Some(warning) = version_warning {
        report.warnings.push(warning);
    }

    ledger.installs.push(ModInstallRecord {
        id: entry.id.clone(),
        name: report.name.clone(),
        version: entry.version.clone(),
        category: entry.category.clone(),
        source: "mod-hub".into(),
        preset: preset.clone().filter(|p| !p.is_empty()),
        discussion: entry.discussion,
        bin_version: report.bin_version.clone(),
        installed_at: Utc::now().to_rfc3339(),
        files: unpacked.written,
        restore_dir: unpacked
            .restore_dir
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        game_root: game_root.clone(),
        hashes: unpacked.hashes,
        snapshot_hashes: unpacked.snapshot_hashes,
    });
    // The shared on-disk manifest mirrors the record (id, scheme, …).
    let record = ledger.installs.last().expect("record pushed above");
    let record_res_mods = manifest::res_mods_of(&game_root, &record.bin_version);
    manifest::hub_apply(manifest::ManifestOp::UpsertManaged {
        res_mods: record_res_mods.clone(),
        id: record.id.clone(),
        entry: WowspManifest::entry_from_record(record),
    });
    save_ledger(&ledger)?;

    // Registration half of "register & reinstall": an install over a
    // foreign copy takes ownership. The foreign installer's Aslain
    // manifest rows pairing with this entry (the same verdict the scan
    // badged the UI with) are cut so its ledger stops claiming the unit,
    // and a paired ModStation tree is removed — the client loads BOTH
    // mods/ and res_mods, so leaving it would run two active copies of
    // the same mod. Best-effort by design: the WoWSP record above is
    // already durable, and a leftover foreign row/tree resurfaces in the
    // foreign pane for a retry.
    let took_rows = mod_hub::remove_manifest_entries_for_entry(&record_res_mods, &index, &entry.id);
    if took_rows > 0 {
        tracing::info!(rows = took_rows, id = %entry.id, "foreign manifest rows taken over");
    }
    let mods_dir = std::path::Path::new(&game_root)
        .join("bin")
        .join(&record.bin_version)
        .join("mods");
    for dir in mod_hub::foreign::modstation_dirs_for_entry(&mods_dir, &index, &entry.id) {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => tracing::info!(dir = %dir.display(), "modstation twin copy removed"),
            Err(e) => {
                tracing::warn!(dir = %dir.display(), error = %e, "modstation twin copy removal failed")
            },
        }
    }

    drop(_gate);

    emit_progress(
        &app,
        &entry.id,
        phase::DONE,
        package_count,
        package_count,
        received_total,
        total,
    );
    tracing::info!(
        id = %entry.id,
        version = %entry.version,
        cached_packages = cache_hits,
        cached_bytes = cache_bytes,
        "mod_catalog_install done"
    );
    Ok(report)
}

/// Read-only "what would this entry touch?" preview for the file-list
/// window: downloads the (preset-resolved) packages through the unified
/// hub — the same mirror ladder, sha256 verification and resume an install
/// gets — extracts each into its OWN temp dir and runs the classifier
/// there, so `res_mods` is never read or written. Per-package
/// classification is exactly what the ledger cannot reconstruct: installs
/// extract everything into one merged root before classifying once.
#[tauri::command]
pub async fn mod_catalog_preview_files(
    mod_id: String,
    game_root: String,
    preset: Option<String>,
    app: AppHandle,
) -> CommandResult<CatalogFilePreview> {
    tracing::info!(id = %mod_id, preset = ?preset, "mod_catalog_preview_files begin");
    let index = load_cached_index()
        .ok_or_else(|| anyhow!("catalog not loaded yet — refresh the online list first"))?;
    let entry = index
        .mods
        .iter()
        .find(|m| m.id == mod_id)
        .ok_or_else(|| anyhow!("{mod_id} is not in the cached catalog"))?
        .clone();
    if entry.delisted {
        return Err(anyhow!(
            "{mod_id} has been delisted from the catalog — its discussion thread is closed"
        )
        .into());
    }
    let packages = resolve_entry_packages(&entry, preset.as_deref())?;
    // Same trust chain as an install: every package must be pinned by the
    // verified index and hosted on this repo's release download tree
    // before the first byte moves (see checked_package_sha256).
    let expected_sha256 = packages
        .iter()
        .map(checked_package_sha256)
        .collect::<anyhow::Result<Vec<_>>>()?;
    // Preview progress rides the same bus and kind as installs but under a
    // distinct id, so no install spinner ever lights up for a
    // look-but-don't-touch pass (the UI filters by id).
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

    let work = WorkDir::create(&std::env::temp_dir())?;
    let mut received_total = 0u64;
    for (i, pkg) in packages.iter().enumerate() {
        let archive = work.0.join(format!("pkg-{i:02}.zip"));
        // Same content-addressed cache as an install: a preview of a sibling
        // entry that shares a package costs no download at all.
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
                            work.0.join(format!("pkg-{i:02}.zip.part")),
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

    // Extraction + classification are blocking fs work — keep them off the
    // async runtime threads, mirroring the install's spawn_blocking tail.
    // The WorkDir guard rides along into the closure, so the whole temp
    // tree (zips + unpacked roots) is dropped the moment the pass ends.
    let classified = tauri::async_runtime::spawn_blocking(move || -> Vec<PackageFilePreview> {
        packages
            .iter()
            .enumerate()
            .map(|(i, pkg)| {
                let archive = work.0.join(format!("pkg-{i:02}.zip"));
                let root = work.0.join(format!("pkg-{i:02}"));
                let mut visited = Vec::new();
                let outcome = extract_zip(&archive, &root, &mut visited).and_then(|()| {
                    // Same layout resolution an install applies: a package
                    // laid out against the game root classifies from its
                    // `res_mods/` folder, and its loose root DLLs are
                    // game-root drops (`@game/…` — the window's second tree).
                    let (plan_root, loose_names) = package_install_layout(&root)?;
                    let plan = mod_hub::classify_package(&plan_root)
                        .map_err(|e| anyhow!("classify failed: {e}"))?;
                    let mut files = mod_hub::collect_plan_files(&plan_root, &plan)?;
                    for name in loose_names {
                        files.push(format!("@game/{name}"));
                    }
                    files.sort();
                    files.dedup();
                    Ok(PackageFilePreview {
                        name: pkg.name.clone(),
                        size: pkg.size,
                        files,
                        warnings: plan.warnings,
                    })
                });
                match outcome {
                    Ok(preview) => preview,
                    Err(e) => PackageFilePreview {
                        name: pkg.name.clone(),
                        size: pkg.size,
                        files: Vec::new(),
                        warnings: vec![e.to_string()],
                    },
                }
            })
            .collect()
    })
    .await
    .map_err(|e| anyhow!("preview task: {e}"))?;

    emit_progress(
        &app,
        &progress_id,
        phase::DONE,
        package_count,
        package_count,
        received_total,
        total,
    );
    let bin_version = if game_root.is_empty() {
        String::new()
    } else {
        mod_hub::latest_bin_version(&game_root)
            .map(|(v, _)| v)
            .unwrap_or_default()
    };
    tracing::info!(id = %mod_id, packages = classified.len(), "mod_catalog_preview_files done");
    Ok(CatalogFilePreview {
        bin_version,
        packages: classified,
    })
}

/// One safe path component: non-empty, no separators, no traversal. The
/// webui only ever passes ledger-scanned values, but the reveal command
/// validates its arguments like untrusted input anyway.
pub(crate) fn validate_path_segment(seg: &str) -> anyhow::Result<&str> {
    if seg.is_empty()
        || seg == "."
        || seg == ".."
        || seg.contains(['/', '\\'])
        || seg.contains('\0')
    {
        bail!("illegal path segment `{seg}`");
    }
    Ok(seg)
}

/// Open a unit's on-disk folder in the OS file manager: the game root's
/// `bin/<version>/res_mods` plus an optional res_mods-relative sub-path.
/// An empty bin version resolves to the client's current one; the resolved
/// directory must exist, so a stale ledger record says so instead of
/// opening an unrelated folder.
#[tauri::command]
pub fn mod_hub_reveal_path(
    game_root: String,
    bin_version: Option<String>,
    rel_path: Option<String>,
    app: AppHandle,
) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;

    // Audit H-3 (read-side): the resolved directory is handed to the system
    // file manager — only roots the backend knows may be revealed.
    mod_hub::ensure_known_game_root(&game_root)?;
    let bin = match bin_version.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => validate_path_segment(v)?.to_string(),
        None => mod_hub::latest_bin_version(&game_root)
            .map(|(v, _)| v)
            .ok_or_else(|| anyhow!("no bin version found under {game_root}"))?,
    };
    let mut dir = Path::new(&game_root)
        .join("bin")
        .join(&bin)
        .join("res_mods");
    for seg in rel_path.as_deref().unwrap_or("").split('/') {
        dir = dir.join(validate_path_segment(seg)?);
    }
    if !dir.is_dir() {
        return Err(anyhow!(
            "{} does not exist on disk — the unit may have been uninstalled",
            dir.display()
        )
        .into());
    }
    tracing::info!(path = %dir.display(), "mod_hub_reveal_path");
    Ok(app
        .opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| anyhow!("open {}: {e}", dir.display()))?)
}

/// The name a catalog install's record carries: the entry's Chinese title
/// when published, else the index's own fallback chain. The pipeline classifies
/// the unpacked tree through [`mod_hub::classify_package`], which names the
/// plan after the directory it inspects — "res_mods" for game-root layouts,
/// "unpacked" for flat ones. Those labels used to leak into the ledger, and
/// every uninstall-conflict message quotes record names, so a blocked
/// reinstall read `"res_mods" shares … with newer installed "res_mods"` —
/// two names nobody could find in the UI.
pub(crate) fn entry_display_name(entry: &CatalogEntry) -> String {
    if !entry.name_zh.is_empty() {
        entry.name_zh.clone()
    } else if !entry.title.is_empty() {
        entry.title.clone()
    } else if !entry.name_en.is_empty() {
        entry.name_en.clone()
    } else {
        entry.id.clone()
    }
}

/// Extract every package archive (part order = index order) into `work`, then
/// run the shared classify → install pipeline. Validate the full replacement
/// before rewinding an existing install. Returns the applied plan — the
/// user-facing report, the written-file list (res_mods-relative,
/// `@game/`-prefixed for game-root files), the restore snapshot dir and
/// the shared-component content hashes — everything the ledger record
/// needs. `display_name` replaces the classifier's directory label as the
/// plan/report/record name (see [`entry_display_name`]).
///
/// Aslain packages are laid out against the game root: the payload lives under
/// `res_mods/…` (→ `bin/<ver>/res_mods/…`), and a few text mods ship a loose
/// DLL that belongs in the game root itself.
pub(crate) fn unpack_and_install(
    mod_id: &str,
    display_name: &str,
    work: &Path,
    game_root: &str,
    packages: &[CatalogPackage],
    // Folded style family: the legacy variant ids this entry supersedes
    // (empty for unfolded entries). Family styles are mutually exclusive
    // variants of one HUD element, so the rewind spans them too.
    supersede_ids: &[String],
    installs: &mut Vec<ModInstallRecord>,
) -> anyhow::Result<mod_hub::PlanApply> {
    let extract_root = work.join("unpacked");
    fs::create_dir_all(&extract_root).map_err(|e| anyhow!("create unpack dir: {e}"))?;
    let mut files = Vec::new();
    for i in 0..packages.len() {
        let archive = package_archive(work, i);
        extract_zip(&archive, &extract_root, &mut files)?;
    }
    // The unpacked tree must still look like a mod; reuse the same classifier
    // the local-folder flow uses so both paths agree on what is installable.
    if files.is_empty() {
        return Err(anyhow!(
            "{mod_id}: the packages unpacked to nothing recognizable (archive layout drifted from the catalog)"
        ));
    }

    let (plan_root, loose_names) = package_install_layout(&extract_root)?;
    let loose: Vec<PathBuf> = loose_names
        .iter()
        .map(|name| extract_root.join(name))
        .collect();
    let mut plan = mod_hub::classify_package(&plan_root)?;
    // The classifier named the plan after the directory it inspected; the
    // record, the report and the conflict messages must speak the catalog
    // title instead (see [`entry_display_name`]).
    if !display_name.is_empty() {
        plan.name = display_name.to_string();
    }
    mod_hub::validate_plan(&plan)?;
    // Rewind only once all archives and the classified plan are usable.
    // Corrupt or unsupported replacement packages must leave the installed
    // version, its ledger record and its restore snapshots untouched.
    let mut rewind_ids: Vec<&str> = vec![mod_id];
    for id in supersede_ids {
        if id != mod_id && !rewind_ids.contains(&id.as_str()) {
            rewind_ids.push(id.as_str());
        }
    }
    let mut installed_variants: Vec<String> = Vec::new();
    for r in installs.iter() {
        // Duplicate same-id records are a legacy-ledger quirk (an older
        // append wrote one per game root); rewind_for_reinstall sweeps them
        // together, so collect each id ONCE or the second call would fail on
        // "no install record" mid-rewind.
        if (r.game_root.is_empty() || r.game_root == game_root)
            && rewind_ids.contains(&r.id.as_str())
            && !installed_variants.contains(&r.id)
        {
            installed_variants.push(r.id.clone());
        }
    }
    // Records after the FIRST rewound one are the newer owners whose stale
    // snapshots must follow the replacement's bytes (see
    // refresh_newer_snapshots). Starting at the first match also covers a
    // legacy duplicate same-id record with an owner sitting between the two.
    let newer_owners = newer_owner_records(installs, &rewind_ids, game_root);
    // Reinstall rewind: a file another record on this root and bin still owns
    // stays at that owner's bytes instead of failing the update.
    for id in &installed_variants {
        rewind_for_reinstall(installs, id, game_root)?;
    }
    let mut applied = mod_hub::install_plan_with_loose(&plan_root, game_root, &plan, &loose)?;
    // Best effort: keep the newer owners' snapshots of the files this install
    // just rewrote in sync, so their uninstall restores the current bytes.
    let refreshed = refresh_newer_snapshots(
        game_root,
        &applied.report.bin_version,
        &applied.written,
        &newer_owners,
    );
    // A refreshed layer now holds the bytes this install just wrote — keep
    // the owners' stored layer hashes in step so their uninstalls do not
    // misread the refresh as tampering (best effort, like the refresh).
    if let Some(written_hashes) = applied.hashes.as_ref() {
        sync_snapshot_hashes(installs, &refreshed, written_hashes);
    }
    // Mixed-version shared-tree signal (advisory): the bytes this install
    // just wrote versus the content hashes other live records stored for
    // the same shared-component files — differing bytes warn through the
    // report's existing warning channel, identical bytes stay silent. The
    // written-bytes map computed at install time is reused verbatim.
    if let Some(written_hashes) = applied.hashes.as_ref() {
        applied.report.warnings.extend(shared_divergence_warnings(
            installs,
            mod_id,
            game_root,
            &applied.report.bin_version,
            written_hashes,
        ));
    }

    Ok(applied)
}

/// Records that sit AFTER the first rewound one in ledger order - the "newer
/// owners" the strict uninstall guard protects. Their snapshot of a shared
/// file may hold the bytes a reinstall is about to replace, so the caller
/// refreshes those snapshots afterwards. Records rewound together (mod_id and
/// its superseded variants) are excluded; records of another game root never
/// match.
pub(crate) fn newer_owner_records(
    installs: &[ModInstallRecord],
    rewound_ids: &[&str],
    game_root: &str,
) -> Vec<ModInstallRecord> {
    let Some(cut) = installs.iter().position(|r| {
        (r.game_root.is_empty() || r.game_root == game_root) && rewound_ids.contains(&r.id.as_str())
    }) else {
        return Vec::new();
    };
    installs
        .iter()
        .skip(cut + 1)
        .filter(|r| !rewound_ids.contains(&r.id.as_str()))
        .filter(|r| r.game_root.is_empty() || r.game_root == game_root)
        .cloned()
        .collect()
}

/// Refresh a NEWER record's pre-overwrite snapshot of a shared file after a
/// reinstall of its older owner replaced the bytes. Only records after the
/// rewound one qualify: an older record's snapshot may hold the vanilla
/// original, so overwriting it with the updated mod's bytes would corrupt its
/// uninstall restore. A record keyed at another bin_version owns physically
/// different files, so it is skipped too. Best effort - a failed refresh only
/// logs and never fails the install. Shared by the catalog install and the
/// local same-name reinstall. Returns the (owner id, written rel) pairs it
/// actually refreshed, so callers can keep the owners' `snapshot_hashes`
/// in step with the new layer bytes (see [`sync_snapshot_hashes`]).
pub(crate) fn refresh_newer_snapshots(
    game_root: &str,
    bin_version: &str,
    written: &[String],
    newer_owners: &[ModInstallRecord],
) -> Vec<(String, String)> {
    if newer_owners.is_empty() {
        return Vec::new();
    }
    let res_mods = Path::new(game_root)
        .join("bin")
        .join(bin_version)
        .join("res_mods");
    let mut refreshed = Vec::new();
    for owner in newer_owners {
        if owner.bin_version != bin_version {
            continue;
        }
        let Some(dir) = owner.restore_dir.as_ref() else {
            continue;
        };
        let restore = Path::new(dir);
        if !restore.is_dir() {
            continue;
        }
        let claimed: std::collections::HashSet<String> = owner
            .files
            .iter()
            .map(|rel| super::uninstall::uninstall_path_key(rel))
            .collect();
        for rel in written {
            if !claimed.contains(&super::uninstall::uninstall_path_key(rel)) {
                continue;
            }
            let (snapshot, source) = match rel.strip_prefix("@game/") {
                Some(rest) => (
                    restore.join("@game").join(rest),
                    Path::new(game_root).join(rest),
                ),
                None => (restore.join(rel), res_mods.join(rel)),
            };
            // Only refresh snapshots that already exist: a file this owner
            // never overwrote has nothing to keep in sync.
            if !snapshot.is_file() || !source.is_file() {
                continue;
            }
            match fs::copy(&source, &snapshot) {
                Ok(_) => refreshed.push((owner.id.clone(), rel.clone())),
                Err(e) => tracing::debug!(
                    snapshot = %snapshot.display(),
                    error = %e,
                    "shared snapshot refresh failed (install continues)"
                ),
            }
        }
    }
    if !refreshed.is_empty() {
        tracing::info!(
            refreshed = refreshed.len(),
            "refreshed newer owners' snapshots of rewritten shared files"
        );
    }
    refreshed
}

// ── Shared-file content hashes ───────────────────────────────────────────────

/// Per-file budget for shared-component hashing. The shared runtime trees
/// are small (scripts, configs, one DLL); a file past this cap is skipped
/// with a warning instead of hashed — the hashes are advisory handoff
/// metadata and must never make an install or uninstall expensive.
const SHARED_HASH_CAP_BYTES: u64 = 64 * 1024 * 1024;

/// Stream one file's SHA-256 (lowercase hex) without loading it whole.
/// `None` — never an error — when the file is missing, unreadable, or past
/// [`SHARED_HASH_CAP_BYTES`] (skip-and-warn): every caller treats hashing
/// as advisory. Shared by the install-time hash computation, the restore
/// verification and the divergence check.
pub(crate) fn sha256_capped(path: &Path) -> Option<String> {
    let unreadable = |what: &str, e: &std::io::Error| {
        tracing::debug!(path = %path.display(), error = %e, "hash source {what}");
    };
    let len = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(e) => {
            unreadable("unreadable", &e);
            return None;
        },
    };
    if len > SHARED_HASH_CAP_BYTES {
        tracing::warn!(
            path = %path.display(),
            cap = SHARED_HASH_CAP_BYTES,
            "shared-file hash skipped: file exceeds the cap"
        );
        return None;
    }
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            unreadable("unreadable", &e);
            return None;
        },
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                unreadable("read failed", &e);
                return None;
            },
        }
    }
    Some(hex::encode(hasher.finalize()))
}

/// Resolve a ledger-relative path against the install it belongs to
/// (`@game/…` drops at the game root, everything else under
/// `bin/<version>/res_mods`).
fn written_file_path(game_root: &str, bin_version: &str, rel: &str) -> PathBuf {
    match rel.strip_prefix("@game/") {
        Some(rest) => Path::new(game_root).join(rest),
        None => Path::new(game_root)
            .join("bin")
            .join(bin_version)
            .join("res_mods")
            .join(rel),
    }
}

/// Content hashes for a fresh record's SHARED-COMPONENT files: after the
/// install wrote its files, every written path that belongs to a shared
/// component tree (see [`super::uninstall::is_shared_component_path`]) is
/// hashed so later handoffs can prove what bytes this record put on disk.
/// Keys use the normalized ledger spelling
/// ([`super::uninstall::uninstall_path_key`]); private files never get an
/// entry, and `None` (not an empty map) is returned when the install
/// touched no shared component — such records keep `hashes: None`.
pub(crate) fn shared_file_hashes(
    game_root: &str,
    bin_version: &str,
    written: &[String],
) -> Option<std::collections::HashMap<String, String>> {
    let mut hashes = std::collections::HashMap::new();
    for rel in written
        .iter()
        .filter(|rel| super::uninstall::is_shared_component_path(rel))
    {
        if let Some(hex) = sha256_capped(&written_file_path(game_root, bin_version, rel)) {
            hashes.insert(super::uninstall::uninstall_path_key(rel), hex);
        }
    }
    (!hashes.is_empty()).then_some(hashes)
}

/// Capture-time hashes of the RESTORE LAYERS this install took: for every
/// shared-component file the journal snapshotted (a restore-dir copy
/// exists), the LAYER copy's bytes are hashed — the pre-overwrite content
/// an uninstall will put back. This is deliberately a SEPARATE map from
/// [`shared_file_hashes`]: a healthy layer's bytes differ from what the
/// install wrote by definition, so verifying a restore against the
/// written-bytes map would skip every ordinary restore. Files with no
/// captured layer (brand-new shared files) get no entry; `None` when no
/// shared layer exists at all.
pub(crate) fn snapshot_layer_hashes(
    written: &[String],
    restore_dir: &Path,
) -> Option<std::collections::HashMap<String, String>> {
    let mut hashes = std::collections::HashMap::new();
    for rel in written
        .iter()
        .filter(|rel| super::uninstall::is_shared_component_path(rel))
    {
        let layer = restore_dir.join(rel);
        if !layer.is_file() {
            continue;
        }
        if let Some(hex) = sha256_capped(&layer) {
            hashes.insert(super::uninstall::uninstall_path_key(rel), hex);
        }
    }
    (!hashes.is_empty()).then_some(hashes)
}

/// Keep a record's [`snapshot_hashes`] truthful when a later install
/// refreshes one of its layers: `refresh_newer_snapshots` copies the new
/// live bytes over the layer copy, so the stored layer hash must follow.
/// Only existing entries are updated — records without the map (legacy,
/// or nothing captured) keep restoring unverified. Reuses the installer's
/// written-bytes map (the refreshed layer now holds exactly those bytes),
/// so nothing is hashed twice.
pub(crate) fn sync_snapshot_hashes(
    installs: &mut [ModInstallRecord],
    refreshed: &[(String, String)],
    written_hashes: &std::collections::HashMap<String, String>,
) {
    for (owner_id, rel) in refreshed {
        let key = super::uninstall::uninstall_path_key(rel);
        let Some(current) = written_hashes.get(&key) else {
            continue;
        };
        for record in installs.iter_mut().filter(|r| r.id == *owner_id) {
            if let Some(map) = record.snapshot_hashes.as_mut() {
                if map.contains_key(&key) {
                    map.insert(key.clone(), current.clone());
                }
            }
        }
    }
}

/// Divergence warning at the shared-file handoff: after THIS install
/// wrote its files, a shared-component file another live record claims
/// WITH a stored hash that no longer matches is the mixed-version
/// shared-tree signal — two packs shipping different builds of the same
/// runtime component. Takes the install's ALREADY-COMPUTED written-bytes
/// map (see [`shared_file_hashes`]) so nothing is hashed twice. One
/// warning per file, naming the file and both record ids; same-bytes
/// reinstalls and claimers without hashes stay silent, and records keyed
/// at another bin or game root own different physical files and never
/// compare. Advisory only: the report warning is the whole effect,
/// nothing is refused.
pub(crate) fn shared_divergence_warnings(
    installs: &[ModInstallRecord],
    own_id: &str,
    game_root: &str,
    bin_version: &str,
    written_hashes: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (key, actual) in written_hashes {
        for claimer in installs {
            if claimer.id == own_id
                || claimer.bin_version != bin_version
                || (!claimer.game_root.is_empty() && claimer.game_root != game_root)
            {
                continue;
            }
            let Some(recorded) = claimer.hashes.as_ref().and_then(|hashes| hashes.get(key)) else {
                continue;
            };
            // Same-bytes reinstalls (and hex-case drift) stay silent.
            if recorded.eq_ignore_ascii_case(actual) {
                continue;
            }
            tracing::warn!(
                file = %key,
                claimer = %claimer.id,
                install = %own_id,
                recorded = %recorded,
                "shared-component bytes diverged between installed records"
            );
            out.push(format!(
                "shared component file {key} was rewritten with different bytes (install {own_id}) — they no longer match the hash recorded by \"{}\" (id {}); the shared runtime tree is now mixed-version",
                claimer.name, claimer.id
            ));
            break;
        }
    }
    out
}

/// Files sitting at the zip root next to `res_mods/` (game-root payloads).
/// Only native libraries are carried over (text mods ship
/// `gettext_x64r.dll`) — readme/log noise at the zip root is ignored rather
/// than dumped into the game directory, and so is any executable: no
/// catalog package ships one, and a root `.exe` could replace the game's
/// own binaries. The packages themselves are only installed after the
/// index-pinned sha256 check (see [`checked_package_sha256`]).
/// Where a package's installable payload lives, and which root-level files
/// are game-root drops: Aslain packages are laid out against the game root —
/// the payload lives under `res_mods/…`, and a few text mods ship a loose
/// DLL that belongs in the game root itself. Both the install path and the
/// file-list preview resolve through this helper so they always agree on
/// the layout (the preview lists the drops as `@game/…`).
pub(crate) fn package_install_layout(
    extract_root: &Path,
) -> anyhow::Result<(PathBuf, Vec<String>)> {
    let res_mods_src = extract_root.join("res_mods");
    if res_mods_src.is_dir() {
        Ok((res_mods_src, loose_root_files(extract_root)?))
    } else {
        Ok((extract_root.to_path_buf(), Vec::new()))
    }
}

pub(crate) fn loose_root_files(extract_root: &Path) -> anyhow::Result<Vec<String>> {
    let mut loose = Vec::new();
    for ent in fs::read_dir(extract_root)
        .map_err(|e| anyhow!("read {}: {e}", extract_root.display()))?
        .flatten()
    {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let is_payload = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"));
        if is_payload {
            loose.push(ent.file_name().to_string_lossy().into_owned());
        }
    }
    loose.sort();
    Ok(loose)
}
