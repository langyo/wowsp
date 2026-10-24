//! Package install: resolve, download, extract-place, journal + the
//! preview/reveal commands (split from mod_catalog.rs).

use anyhow::{anyhow, bail};

use super::*;

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
        )
        .into());
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
    for (i, pkg) in packages.iter().enumerate() {
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
                pkg.name, done.bytes, pkg.size
            )
            .into());
        }
        let dest = package_archive(&work.0, i);
        tokio::fs::rename(&done.path, &dest)
            .await
            .map_err(|e| anyhow!("assemble {}: {e}", dest.display()))?;
        received_total += done.bytes;
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
    let (report, written, restore_dir) = match outcome {
        Ok(done) => done,
        Err(e) => {
            // The rewind already changed the ledger even though the unpack
            // failed — persist it so the on-disk ledger does not describe
            // files that are already gone.
            if let Err(se) = save_ledger(&ledger) {
                tracing::warn!(error = %se, "ledger save failed after failed install");
            }
            return Err(e.into());
        },
    };

    // Say whose files this install clobbered (the journal already
    // snapshotted them — this is the visibility half of the conflict
    // policy the design doc promises).
    let mut report = report;
    let conflicts = mod_hub::conflict_warnings(
        &written,
        &ledger.installs,
        &entry.id,
        &report.bin_version,
        &game_root,
    );
    report.conflicts = conflicts.clone();
    report.warnings.extend(conflicts);

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
        files: written,
        restore_dir: restore_dir
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        game_root: game_root.clone(),
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
    tracing::info!(id = %entry.id, version = %entry.version, "mod_catalog_install done");
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
        received_total += done.bytes;
        tokio::fs::rename(&done.path, work.0.join(format!("pkg-{i:02}.zip")))
            .await
            .map_err(|e| anyhow!("assemble package {i}: {e}"))?;
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
/// before rewinding an existing install. Returns the report plus the
/// written-file list (res_mods-relative, `@game/`-prefixed for game-root
/// files) and restore snapshot dir for the ledger. `display_name` replaces
/// the classifier's directory label as the plan/report/record name (see
/// [`entry_display_name`]).
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
) -> anyhow::Result<(InstallReport, Vec<String>, Option<PathBuf>)> {
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
        // append wrote one per game root); uninstall_from_ledger sweeps
        // them together, so collect each id ONCE or the second call
        // would fail on "no install record" mid-rewind.
        if (r.game_root.is_empty() || r.game_root == game_root)
            && rewind_ids.contains(&r.id.as_str())
            && !installed_variants.contains(&r.id)
        {
            installed_variants.push(r.id.clone());
        }
    }
    for id in &installed_variants {
        uninstall_from_ledger(installs, id, game_root)?;
    }
    let applied = mod_hub::install_plan_with_loose(&plan_root, game_root, &plan, &loose)?;

    Ok((applied.report, applied.written, applied.restore_dir))
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
