use super::super::ingame_plugin;
use super::installed_units::classify_installed_root;
use super::*;

// ── Stale bin detection & migration ─────────────────────────────────────────

/// Older `bin/<version>/` directories whose `res_mods` still carries files.
/// After a game update the client only loads `bin/<latest>`, so those mods
/// vanish from the hub's installed list while staying on disk — surfacing
/// them is the first step of the migration flow (mod-hub.md §4).
#[tauri::command]
pub fn mod_hub_stale_versions(game_root: String) -> Result<Vec<StaleBinInfo>, String> {
    let Some((latest, _)) = latest_bin_version(&game_root) else {
        return Ok(Vec::new());
    };
    let Ok(latest_num) = latest.parse::<u64>() else {
        return Ok(Vec::new());
    };
    let bin = Path::new(&game_root).join("bin");
    let mut out = Vec::new();
    for ent in fs::read_dir(&bin)
        .map_err(|e| format!("read {}: {e}", bin.display()))?
        .flatten()
    {
        let name = ent.file_name().to_string_lossy().into_owned();
        let Ok(num) = name.parse::<u64>() else {
            continue;
        };
        if num >= latest_num {
            continue;
        }
        let res_mods = ent.path().join("res_mods");
        if !res_mods.is_dir() {
            continue;
        }
        let file_count = count_tree_files(&res_mods);
        if file_count == 0 {
            continue;
        }
        let mods = classify_installed_root(&res_mods)
            .into_iter()
            .filter(|m| !m.paths.is_empty())
            .map(|m| m.name)
            .collect();
        let probe_installed = stranded_probe(&res_mods) != StrandedProbe::Absent;
        out.push(StaleBinInfo {
            bin_version: name,
            mods,
            file_count,
            probe_installed,
        });
    }
    // Newest stale bin first — numeric, so bin/10 sorts after bin/2 and the
    // one-button migrate always moves the freshest leftovers (which then
    // win keep-new conflicts against older strays).
    out.sort_by_key(|i| std::cmp::Reverse(i.bin_version.parse::<u64>().unwrap_or(0)));
    Ok(out)
}

fn count_tree_files(root: &Path) -> u64 {
    let mut count = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                count += 1;
            }
        }
    }
    count
}

// ── In-game probe carry-over ───────────────────────────────────────────────
// The bundled in-game stats plugin (PnFMods/WoWSPProbe) lives in res_mods,
// so a game update strands it with every other mod. Unlike them it never
// rides the generic move: a migration reinstalls the EMBEDDED bytes into
// the current bin (an upgrade is exactly when the shipped copy should win
// over whatever build the old bin carried) and re-seeds the loader marker
// and wowsp.toml managed row like a plain install. A stranded copy the
// user had DISABLED (.bak twins only) comes back disabled — a migration
// must never silently re-enable a mod the user turned off. A probe the
// CURRENT bin already carries (reinstalled or re-toggled after the
// update) outranks the stranded copy and is left untouched.

/// What the stale tree carries of the in-game probe plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StrandedProbe {
    /// No probe files at all — nothing to carry over.
    Absent,
    /// Live entry file: the probe was enabled when the update stranded it.
    Live,
    /// Only a `.bak` twin: the probe had been toggled off in the mod hub.
    Disabled,
}

fn stranded_probe(res_mods: &Path) -> StrandedProbe {
    let entry = ingame_plugin::probe_entry(res_mods);
    if entry.is_file() {
        return StrandedProbe::Live;
    }
    if sibling_with_suffix(&entry, ".bak").is_file() {
        return StrandedProbe::Disabled;
    }
    StrandedProbe::Absent
}

/// Delete the probe's own files from the stale tree — the pre-sweep for
/// the blind migration (the wizard's execute deletes them per-file through
/// the same [`ingame_plugin::is_probe_path`] filter). Returns how many
/// files actually went so the report can count them as cleaned up.
fn remove_probe_paths(res_mods: &Path) -> usize {
    let mut removed = 0usize;
    let mod_dir = res_mods.join("PnFMods").join(ingame_plugin::MOD_DIR);
    if mod_dir.is_dir() {
        let counted = count_tree_files(&mod_dir) as usize;
        if fs::remove_dir_all(&mod_dir).is_ok() {
            removed += counted;
        }
    }
    for rel in ingame_plugin::PROBE_EXTRA_PATHS {
        for suffix in ["", ".bak"] {
            let p = res_mods.join(format!("{rel}{suffix}"));
            if p.is_file() && fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Reinstall the probe into the CURRENT bin after a migration carried the
/// rest of the stale tree over — unless the current bin already carries
/// one: the user may have reinstalled (or re-toggled) the plugin after the
/// update while the old bin still lingered, and that live verdict outranks
/// the stranded copy's. Returns whether the plugin sits in the current bin
/// once the migration is done (reinstalled, or already present and left
/// untouched); an install failure is logged but not fatal — the mods are
/// already moved (the sweep is not transactional) and the plugin's own
/// surfaces (live view, settings) re-offer a plain install.
fn reinstall_stranded_probe(game_root: &str, dst: &Path, state: StrandedProbe) -> bool {
    match stranded_probe(dst) {
        StrandedProbe::Live => {
            tracing::info!("current bin already carries a live probe — left untouched");
            return true;
        },
        StrandedProbe::Disabled => {
            tracing::info!("current bin already carries a disabled probe — left untouched");
            return true;
        },
        StrandedProbe::Absent => {},
    }
    if let Err(e) = ingame_plugin::install_probe_files(game_root) {
        tracing::warn!(error = %e, "in-game probe reinstall after migration failed");
        return false;
    }
    if state == StrandedProbe::Disabled {
        // The STRANDED copy had been toggled off: re-apply that verdict —
        // .bak the files (exactly what the hub's unit toggle does to the
        // same tree) and sync the managed row the same way the toggle does.
        let mod_rel = format!("PnFMods/{}", ingame_plugin::MOD_DIR);
        let _ = super::unit_ops::set_paths_state(dst, std::slice::from_ref(&mod_rel), false);
        super::unit_ops::set_bundled_plugin_enabled(dst, false);
        // The freshly mirrored twin copies got the ENABLED bytes — they take
        // the same verdict (see preload_mirror).
        super::preload_mirror::mirror_set_state(game_root, &[mod_rel], false);
    }
    true
}

/// Move a stranded old-version `res_mods` into the current one. Conflict
/// policy is keep-new: a file the current tree already has (live or as a
/// disabled `.bak` twin) is left untouched — the newer install wins, so a
/// migration can never overwrite or roll back what the player currently
/// runs. Ledger records are re-pointed at the new version so their uninstall
/// still finds the files.
#[tauri::command]
pub async fn mod_hub_migrate_stale_bin(
    game_root: String,
    from_version: String,
) -> Result<MigrateReport, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    ensure_res_mods_active(&game_root)?;
    migrate_stale_bin_core(&game_root, &from_version)
}

/// Migration wizard step 1 — classify the stale tree (read-only) so the
/// user reviews duplicates, superseded files and per-file keep decisions
/// before anything moves.
#[tauri::command]
pub async fn mod_hub_migration_plan(
    game_root: String,
    from_version: String,
) -> Result<MigrationPlan, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    ensure_res_mods_active(&game_root)?;
    migration_plan_core(&game_root, &from_version)
}

/// Migration wizard step 2 — apply the reviewed plan: `keep` lists the
/// decide-bucket paths (res_mods-relative, forward slashes) the user chose
/// to carry over, `ignore` the ones marked "leave alone"; everything else
/// in the stale tree is cleaned up.
#[tauri::command]
pub async fn mod_hub_migration_execute(
    game_root: String,
    from_version: String,
    keep: Vec<String>,
    ignore: Vec<String>,
) -> Result<MigrateReport, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    ensure_res_mods_active(&game_root)?;
    migration_execute_core(&game_root, &from_version, &keep, &ignore)
}

/// Migration core (split from the command so tests drive it without the
/// async gate).
pub(crate) fn migrate_stale_bin_core(
    game_root: &str,
    from_version: &str,
) -> Result<MigrateReport, String> {
    let (latest, src, dst) = stale_migration_pair(game_root, from_version)?;
    // Captured before the sweep: the stale wowsp.toml is bookkeeping (the
    // merge below decides what survives), not a movable mod file.
    let stale_manifest_raw = super::manifest::read_raw(&src);
    // Probe carry-over: its state is captured and its files removed BEFORE
    // the sweep (the generic move must not strand an outdated copy in the
    // destination); the reinstall happens once the manifest merge settled.
    // The sweep runs even when no entry file marks the probe present, so a
    // stray extra (the view alone, a legacy-layout leftover) never rides
    // the move either — mirroring the wizard's per-file filter.
    let probe = stranded_probe(&src);
    let mut skipped = remove_probe_paths(&src);
    fs::create_dir_all(&dst).map_err(|e| format!("create {}: {e}", dst.display()))?;

    let mut moved = 0usize;
    let mut moved_rels: Vec<String> = Vec::new();
    migrate_tree(&src, &dst, "", &mut moved, &mut skipped, &mut moved_rels)?;
    // A fully migrated res_mods disappears entirely (empty-only remove, so
    // leftovers survive when files were kept).
    let _ = fs::remove_dir(&src);
    ensure_loader_marker(&dst);
    // Reclaimed files reach the pre-release twins too (see preload_mirror).
    for warning in super::preload_mirror::mirror_written(game_root, &dst, &moved_rels).warnings {
        tracing::warn!("{warning}");
    }
    super::preload_mirror::ensure_loader_markers(game_root);

    // Stranded ledger records now describe files in the current bin.
    let mut ledger = super::mod_catalog::load_ledger();
    if repoint_records(&mut ledger.installs, from_version, &latest, game_root) {
        super::mod_catalog::save_ledger(&ledger)?;
    }
    // Fold the stale manifest into the current bin: toggle states carry
    // over, fields refresh from the re-pointed ledger, tool configs union.
    super::manifest::hub_apply(super::manifest::ManifestOp::MergeAfterMigration {
        stale_raw: stale_manifest_raw,
        to_res_mods: dst.clone(),
        records: ledger.installs.clone(),
        game_root: game_root.to_string(),
        bin_version: latest.clone(),
    });
    let probe_reinstalled =
        probe != StrandedProbe::Absent && reinstall_stranded_probe(game_root, &dst, probe);
    tracing::info!(from = %from_version, to = %latest, moved, skipped, probe_reinstalled, "stale bin migrated");
    Ok(MigrateReport {
        from_version: from_version.to_string(),
        to_version: latest,
        moved_files: moved,
        skipped_files: skipped,
        ignored_files: 0,
        probe_reinstalled,
    })
}

/// Validate the (stale → current) pair every migration path goes through:
/// numeric versions on both sides (a hand-made leading-zero dir `bin/01`
/// next to `bin/1` must be recognized as the current version, or src would
/// equal dst and the keep-new probe would eat the current tree), the stale
/// version strictly older than the latest, and a `res_mods` actually present
/// under the stale bin. Returns `(latest version, stale res_mods, current
/// res_mods)` without touching the disk beyond those probes.
fn stale_migration_pair(
    game_root: &str,
    from_version: &str,
) -> Result<(String, PathBuf, PathBuf), String> {
    let from_num = from_version
        .parse::<u64>()
        .map_err(|_| format!("{from_version:?} is not a numeric bin version"))?;
    let (latest, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    if from_num >= latest.parse::<u64>().unwrap_or(u64::MAX) {
        return Err(format!(
            "{from_version} is the current version — nothing to migrate"
        ));
    }
    let src = Path::new(game_root)
        .join("bin")
        .join(from_version)
        .join("res_mods");
    if !src.is_dir() {
        return Err(format!("no res_mods under bin/{from_version}"));
    }
    let dst = ver_dir.join("res_mods");
    Ok((latest, src, dst))
}

/// Per-install bookkeeping that must never migrate: Aslain's manifest and
/// loader markers describe the OLD install, and this app's own ledger lives
/// in the data dir, not the game tree. They are deleted outright, in both
/// the plan (absent from every bucket) and the execute sweep — the loader
/// MARKER is then re-created empty at the destination when the migrated
/// tree carries PnF content ([`ensure_loader_marker`]).
fn is_migration_bookkeeping(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if name.eq_ignore_ascii_case("installed_mods.xml")
        || name.eq_ignore_ascii_case("PnFModsLoader.py")
        || name.to_ascii_lowercase().starts_with("wowsp.toml")
    {
        return true;
    }
    let mut parts = rel.rsplitn(2, '/');
    let _file = parts.next();
    matches!(parts.next(), Some(parent) if parent.eq_ignore_ascii_case("mods"))
        && name.eq_ignore_ascii_case("installed.json")
}

/// A migrated destination carrying PnF content must also carry the
/// `PnFModsLoader.py` marker — the client only scans `res_mods` for mods
/// while that (0-byte) file exists, the same rule the install journal
/// applies (`install.rs`). The sweep itself cannot guarantee it: the wizard
/// deletes a source marker as bookkeeping, and keep-new may drop a marker
/// whose destination counterpart already existed.
fn ensure_loader_marker(res_mods: &Path) {
    if !res_mods.join("PnFMods").is_dir() {
        return;
    }
    let marker = res_mods.join("PnFModsLoader.py");
    if !marker.is_file() {
        let _ = fs::write(&marker, b"");
    }
}

/// SHA-256 of a file's bytes — the content equality half of the duplicate
/// probe (size is checked first because it is free).
fn file_sha256(path: &Path) -> Result<[u8; 32], String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(Sha256::digest(&bytes).into())
}

/// Every file under `root`, as forward-slash `root`-relative paths.
fn collect_tree_files(root: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .map_err(|e| format!("relativize {}: {e}", p.display()))?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// The wizard's plan: bucket every file of the stale tree by what execution
/// will do — duplicate (identical content in the destination: delete),
/// superseded (same path, different content: the newer destination copy
/// wins, delete the stale one) or decide (stale-only: the user chooses).
/// Read-only by design — planning must never mutate the game tree.
pub(crate) fn migration_plan_core(
    game_root: &str,
    from_version: &str,
) -> Result<MigrationPlan, String> {
    let (latest, src, dst) = stale_migration_pair(game_root, from_version)?;
    let mut plan = MigrationPlan {
        from_version: from_version.to_string(),
        to_version: latest,
        duplicate: Vec::new(),
        superseded: Vec::new(),
        decide: Vec::new(),
    };
    for rel in collect_tree_files(&src)? {
        if is_migration_bookkeeping(&rel) || ingame_plugin::is_probe_path(&rel) {
            // Bookkeeping never reaches a bucket (deleted outright at
            // execute time) — and neither do the probe's own files: the
            // execute step reinstalls fresh embedded bytes instead, so
            // offering them as keep/ignore decisions would be a lie.
            continue;
        }
        let size = match fs::metadata(src.join(&rel)) {
            Ok(m) => m.len(),
            // Vanished between the walk and the probe — a plan built on a
            // file that no longer exists would offer a no-op decision.
            Err(_) => continue,
        };
        let file = PlanFile {
            path: rel.clone(),
            size,
            identity: None,
        };
        let counterpart = dst.join(&rel);
        let bucket = if counterpart.is_file() {
            let same = fs::metadata(&counterpart).is_ok_and(|m| m.len() == size)
                && file_sha256(&counterpart) == file_sha256(&src.join(&rel));
            if same {
                &mut plan.duplicate
            } else {
                &mut plan.superseded
            }
        } else {
            // A stale-only file (or a destination DIRECTORY parked on the
            // same path — the move would fail, so the stale copy must go).
            &mut plan.decide
        };
        bucket.push(file);
    }
    Ok(plan)
}

/// Recursive keep-new move. Same-volume renames per file; directories the
/// move emptied are removed on the way out (post-order), so a fully
/// migrated `res_mods` disappears entirely. Successfully moved files are
/// collected as forward-slash `dst`-relative paths (`moved_rels`) so the
/// caller can fan them out to the pre-release twins.
fn migrate_tree(
    src: &Path,
    dst: &Path,
    prefix: &str,
    moved: &mut usize,
    skipped: &mut usize,
    moved_rels: &mut Vec<String>,
) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(src) else {
        return Ok(());
    };
    for ent in entries.flatten() {
        let s = ent.path();
        let d = dst.join(ent.file_name());
        let name = ent.file_name().to_string_lossy().into_owned();
        if s.is_dir() {
            let child_prefix = format!("{prefix}{name}/");
            migrate_tree(&s, &d, &child_prefix, moved, skipped, moved_rels)?;
            let _ = fs::remove_dir(&s); // succeeds only when empty
            continue;
        }
        // Aslain's manifest is per-install bookkeeping — transplanting it
        // would resurrect rows for files the current tree never got. It
        // dies with the stranded directory instead. wowsp.toml likewise:
        // its surviving content is merged by the caller (captured before
        // this sweep), never transplanted verbatim.
        if name.eq_ignore_ascii_case("installed_mods.xml")
            || name.to_ascii_lowercase().starts_with("wowsp.toml")
        {
            let _ = fs::remove_file(&s);
            *skipped += 1;
            continue;
        }
        // Keep-new: the current tree already has this file — live, as a
        // disabled twin, or as the live counterpart of this stranded twin —
        // so the (older) stranded copy is dropped. Migrating a lone `.bak`
        // next to a live file would silently break later toggles.
        let bare = name.strip_suffix(".bak").unwrap_or(&name).to_string();
        let live = d.with_file_name(&bare);
        if d.is_file() || sibling_with_suffix(&d, ".bak").is_file() || live.is_file() {
            let _ = fs::remove_file(&s);
            *skipped += 1;
            continue;
        }
        if let Some(parent) = d.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        fs::rename(&s, &d).map_err(|e| format!("move {}: {e}", s.display()))?;
        moved_rels.push(format!("{prefix}{name}"));
        *moved += 1;
    }
    Ok(())
}

/// Post-order empty-directory sweep of the migrated stale tree — the file
/// sweep leaves the directory skeleton behind, and only a fully emptied
/// `res_mods` should disappear (leftover files survive).
fn prune_empty_dirs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for ent in entries.flatten() {
        let p = ent.path();
        if p.is_dir() {
            prune_empty_dirs(&p);
            let _ = fs::remove_dir(&p); // succeeds only when empty
        }
    }
}

/// Wizard execute core: applies the reviewed plan. Everything not in `keep`
/// (duplicates, superseded, dropped decide files, bookkeeping) is deleted
/// from the stale tree; `ignore` files are left exactly where they are —
/// neither moved nor deleted, so the stale bin survives them and the banner
/// keeps counting them until a later migration handles them. Kept files move
/// under the same keep-new rule the blind migration had — re-probed NOW,
/// because the destination may have changed since planning — and anything
/// the current tree already has is dropped instead of overwritten. Ledger
/// records re-point at the new bin.
pub(crate) fn migration_execute_core(
    game_root: &str,
    from_version: &str,
    keep: &[String],
    ignore: &[String],
) -> Result<MigrateReport, String> {
    let (latest, src, dst) = stale_migration_pair(game_root, from_version)?;
    // Captured before the sweep (see migrate_stale_bin_core): wowsp.toml is
    // bookkeeping here, its surviving content is merged after the move.
    let stale_manifest_raw = super::manifest::read_raw(&src);
    let probe = stranded_probe(&src);
    fs::create_dir_all(&dst).map_err(|e| format!("create {}: {e}", dst.display()))?;
    let keep: BTreeSet<String> = keep.iter().map(|k| k.replace('\\', "/")).collect();
    let ignore: BTreeSet<String> = ignore.iter().map(|k| k.replace('\\', "/")).collect();

    let mut moved = 0usize;
    let mut skipped = 0usize;
    let mut ignored = 0usize;
    let mut moved_rels: Vec<String> = Vec::new();
    for rel in collect_tree_files(&src)? {
        let s = src.join(&rel);
        // Bookkeeping dies even when the plan listed it as keepable or
        // ignored — resurrecting it would corrupt the install ledger. The
        // probe's own files die with it: the reinstall below writes fresh
        // embedded bytes, and a stranded (possibly outdated or disabled)
        // copy must never ride the move or be left as an "ignore" resident.
        if is_migration_bookkeeping(&rel) || ingame_plugin::is_probe_path(&rel) {
            let _ = fs::remove_file(&s);
            skipped += 1;
            continue;
        }
        // Ignored: untouched, and NOT counted as cleaned up — the file is
        // still stranded, the stale-bin banner must keep seeing it. Wins
        // over `keep` (the wizard keeps the sets disjoint; belt and braces).
        if ignore.contains(&rel) {
            ignored += 1;
            continue;
        }
        if !keep.contains(&rel) {
            let _ = fs::remove_file(&s);
            skipped += 1;
            continue;
        }
        let d = dst.join(&rel);
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let bare = name.strip_suffix(".bak").unwrap_or(&name).to_string();
        let live = d.with_file_name(&bare);
        // Keep-new, re-checked at execute time: a destination file (live or
        // as a disabled twin) that appeared since planning must never be
        // overwritten or handed a stranded `.bak` sibling.
        if d.is_file() || sibling_with_suffix(&d, ".bak").is_file() || live.is_file() {
            let _ = fs::remove_file(&s);
            skipped += 1;
            tracing::info!(
                path = %rel,
                "destination appeared since planning — stale copy dropped"
            );
            continue;
        }
        if let Some(parent) = d.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        fs::rename(&s, &d).map_err(|e| format!("move {}: {e}", s.display()))?;
        moved_rels.push(rel.clone());
        moved += 1;
    }
    prune_empty_dirs(&src);
    // A fully migrated res_mods disappears entirely (empty-only remove, so
    // leftovers survive when files were kept).
    let _ = fs::remove_dir(&src);
    ensure_loader_marker(&dst);
    // Kept files reach the pre-release twins too (see preload_mirror).
    for warning in super::preload_mirror::mirror_written(game_root, &dst, &moved_rels).warnings {
        tracing::warn!("{warning}");
    }
    super::preload_mirror::ensure_loader_markers(game_root);

    let mut ledger = super::mod_catalog::load_ledger();
    if repoint_records(&mut ledger.installs, from_version, &latest, game_root) {
        super::mod_catalog::save_ledger(&ledger)?;
    }
    super::manifest::hub_apply(super::manifest::ManifestOp::MergeAfterMigration {
        stale_raw: stale_manifest_raw,
        to_res_mods: dst.clone(),
        records: ledger.installs.clone(),
        game_root: game_root.to_string(),
        bin_version: latest.clone(),
    });
    let probe_reinstalled =
        probe != StrandedProbe::Absent && reinstall_stranded_probe(game_root, &dst, probe);
    tracing::info!(
        from = %from_version,
        to = %latest,
        moved,
        skipped,
        ignored,
        probe_reinstalled,
        "stale bin migrated (wizard)"
    );
    Ok(MigrateReport {
        from_version: from_version.to_string(),
        to_version: latest,
        moved_files: moved,
        skipped_files: skipped,
        ignored_files: ignored,
        probe_reinstalled,
    })
}

/// Re-point THIS install's records from one bin version to another.
/// Records of other game installs (non-empty `game_root` stamp that does
/// not match) keep their version — the ledger is global, and re-pointing
/// a foreign record would strand it in a version its files do not live
/// in. Returns whether anything changed.
pub(crate) fn repoint_records(
    installs: &mut [ModInstallRecord],
    from: &str,
    to: &str,
    game_root: &str,
) -> bool {
    let mut touched = false;
    for record in installs.iter_mut() {
        if record.bin_version == from
            && (record.game_root.is_empty() || record.game_root == game_root)
        {
            record.bin_version = to.to_string();
            touched = true;
        }
    }
    touched
}

/// Which other installed mods the freshly written files overlap — the
/// design doc's conflict policy made real: later installs win, but the
/// report must say whose files they clobbered (the overwrite itself is
/// already snapshotted, so a later uninstall restores them).
pub(crate) fn conflict_warnings(
    written: &[String],
    installs: &[ModInstallRecord],
    exclude_id: &str,
    bin_version: &str,
    game_root: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    for record in installs {
        if record.id == exclude_id
            || record.bin_version != bin_version
            || (!record.game_root.is_empty() && record.game_root != game_root)
        {
            continue;
        }
        let hits = written.iter().filter(|w| record.files.contains(*w)).count();
        if hits > 0 {
            out.push(format!(
                "overwrites {hits} file(s) also installed by {:?}",
                record.name
            ));
        }
    }
    out
}
