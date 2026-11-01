//! Per-component shared records (`shared.*`): the ledger home of the
//! runtime component trees every Aslain-dependent pack clones (see
//! `uninstall::SHARED_COMPONENT_ROOTS` — the registry). A pack install
//! SPLITS its written files: shared-component paths are attributed to one
//! UPSERTED record per component root, and the pack record keeps only its
//! private files plus a `shared_roots` dependency edge — the file list is
//! cloned once per component instead of once per pack, and exactly ONE
//! snapshot layer exists per content generation (captured at the
//! generation's own install), never one layer per pack.
//!
//! Dependents are always COMPUTED, never stored: a component's consumers
//! are the records whose `shared_roots` name it (new-style) UNION the
//! records whose inlined `files` map into it (legacy shape, kept forever
//! — no ledger migration). The component record's lifetime is bound to
//! that consumer set: the last consumer out removes it (see
//! `uninstall::last_consumer_cleanup`).

use anyhow::anyhow;

use super::uninstall::{shared_component_root, uninstall_path_key};
use super::*;

// ── Identity ────────────────────────────────────────────────────────────────

/// Ledger-id prefix of a per-component shared record.
pub(crate) const SHARED_RECORD_ID_PREFIX: &str = "shared.";

/// The ledger id of a component's shared record: `shared.<root-slug>`,
/// the slug being the registry root with `/` spelled as `.` (e.g.
/// `pnfmods/ttaromodutils/` → `shared.pnfmods.ttaromodutils`; the
/// `@game/` marker drops its sigil). Stable per component root, unique
/// per root — the upsert key.
pub(crate) fn shared_record_id(root: &str) -> String {
    format!(
        "{SHARED_RECORD_ID_PREFIX}{}",
        root.trim_end_matches('/')
            .trim_start_matches('@')
            .replace('/', ".")
    )
}

/// Is this record id a per-component shared record? Such records never
/// pair with catalog entries, never count as their own consumer, and are
/// filtered from every user-facing records-driven surface.
pub(crate) fn is_shared_record_id(id: &str) -> bool {
    id.starts_with(SHARED_RECORD_ID_PREFIX)
}

/// Human label for a component root — quoted by uninstall-conflict and
/// overwrite warnings exactly like a pack name would be.
pub(crate) fn shared_record_label(root: &str) -> String {
    if root.starts_with("texts/") {
        return format!("Shared TTaro text catalog ({root})");
    }
    match root {
        "pnfmods/ttaromodutils/" => "Shared TTaro runtime (TTaroModUtils)",
        "pnfmods/modforge/" => "Shared TTaro runtime (ModForge)",
        "pnfmods/modsinstaller_" => "Shared Aslain boot installer (ModsInstaller)",
        "gui/ttaro/" => "Shared TTaro GUI tree",
        "gui/ttaro_mod_config/" => "Shared TTaro config tree",
        "gui/unbound2/pnfmods/ttaromodutils" => "Shared TTaro unbound fragments",
        "@game/gettext_x64r.dll" => "Shared gettext runtime (gettext_x64r.dll)",
        _ => return format!("Shared component ({root})"),
    }
    .to_string()
}

// ── Consumers (computed, never stored) ──────────────────────────────────────

/// Does `record` consume the component rooted at `root` (registry
/// spelling)? The union computation: NEW-style records declare the
/// dependency through `shared_roots`; LEGACY records through their
/// inlined shared file paths (the pre-split ledger shape).
pub(crate) fn claims_shared_root(record: &ModInstallRecord, root: &str) -> bool {
    record.shared_roots.iter().any(|r| r == root)
        || record
            .files
            .iter()
            .any(|f| shared_component_root(f).as_deref() == Some(root))
}

// ── Install-time split ──────────────────────────────────────────────────────

/// Commit a freshly-built pack record plus the per-component `shared.*`
/// records for the shared-component files it wrote.
///
/// `pack` arrives exactly as installs built records before the split —
/// full written list, the install's restore dir, the P4 hash maps — and
/// is rewritten in place: private files only, `shared_roots` naming the
/// components it wrote into, no hash maps (they move to the component
/// records), and a restore dir holding only private layers (dropped
/// entirely when no private file was overwritten). Returned as pushed.
///
/// Upsert rule per component root is wholesale replacement — the newest
/// install defines the component's generation — with ONE snapshot layer
/// per generation:
///
/// - No existing record: create it, MOVING this install's captured
///   layers (the pre-overwrite bytes) into its own restore dir.
/// - Existing record, IDENTICAL bytes (same file set under the root,
///   every P4 hash equal): the generation is unchanged — no new layer is
///   captured (the journal's redundant captures are discarded), the
///   existing record keeps its files and layer, only the pack record is
///   added.
/// - Existing record, DIFFERENT bytes (or one that cannot be PROVEN
///   identical — missing hash maps, another bin): rewind it
///   (`rewind_for_reinstall`: surviving consumers keep the live tree at
///   the bytes this install just wrote) and replace it; the journal's
///   captured layers hold the OLD generation's bytes and become the new
///   generation's layer.
pub(crate) fn commit_pack_record(
    installs: &mut Vec<ModInstallRecord>,
    mut pack: ModInstallRecord,
    game_root: &str,
) -> anyhow::Result<ModInstallRecord> {
    // The install's P4 maps, captured BEFORE the rewrite below: the
    // component records inherit exactly these entries (the pack record
    // keeps none), and the identical-generation verdict compares against
    // them.
    let written_hashes = pack.hashes.clone();
    let layer_hashes = pack.snapshot_hashes.clone();
    // Partition the written files per component root (registry spelling;
    // groups keep first-sight order so the ledger stays deterministic)
    // versus private files.
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut private: Vec<String> = Vec::new();
    for rel in pack.files.iter() {
        match shared_component_root(rel) {
            Some(root) => match groups.iter_mut().find(|(r, _)| *r == root) {
                Some((_, files)) => files.push(rel.clone()),
                None => groups.push((root, vec![rel.clone()])),
            },
            None => private.push(rel.clone()),
        }
    }
    pack.shared_roots = groups.iter().map(|(root, _)| root.clone()).collect();
    pack.files = private;
    pack.hashes = None;
    pack.snapshot_hashes = None;

    // Filesystem phase first: the journal's shared-file layers leave the
    // pack's restore dir (moved into per-component dirs, or discarded
    // when the generation is unchanged), so the pack dir that survives
    // describes only private snapshots.
    let pack_restore = pack.restore_dir.as_ref().map(PathBuf::from);
    // Nanosecond stamp: the component dir name must never collide with
    // the one an existing generation's rewind is about to delete, or a
    // rapid follow-up install would eat its own just-moved layers.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // (root, layer dir — None when the generation is unchanged and the
    // captured layers are discarded instead) per component, in group
    // order.
    let mut pending: Vec<(String, Option<PathBuf>)> = Vec::new();
    for (root, files) in &groups {
        let existing = installs.iter().find(|r| {
            r.id == shared_record_id(root) && (r.game_root.is_empty() || r.game_root == game_root)
        });
        let dir = if existing.is_some_and(|r| {
            same_generation(r, &pack.bin_version, root, files, written_hashes.as_ref())
        }) {
            None
        } else {
            Some(mod_hub::restore_root().join(format!(
                    "{stamp}-shared-{}",
                    root.trim_end_matches('/').trim_start_matches('@').replace('/', ".")
                )))
        };
        if let (Some(dir), Some(from)) = (dir.as_ref(), pack_restore.as_deref()) {
            fs::create_dir_all(dir).map_err(|e| anyhow!("create {}: {e}", dir.display()))?;
            relocate_layers(from, files, Some(dir))?;
        } else if let Some(from) = pack_restore.as_deref() {
            // Same generation: the journal captured layers of bytes the
            // existing generation already snapshots — discard them (the
            // snapshot-once guarantee: no per-pack layer copies).
            relocate_layers(from, files, None)?;
        }
        pending.push((root.clone(), dir));
    }
    // A pack restore dir the moves emptied of FILES describes no
    // snapshot — drop it (empty directory shells the moves left behind
    // included) so the record's uninstall never chases ghosts, the same
    // rule the installer applies to an untouched dir.
    if let Some(dir) = pack_restore.as_deref() {
        if !mod_hub::tree_has_files(dir) {
            fs::remove_dir_all(dir).ok();
            pack.restore_dir = None;
        }
    }

    // Ledger phase. The pack record enters FIRST: while an existing
    // generation is rewound below, its shared_roots edge already keeps
    // the component tree alive at the new bytes.
    installs.push(pack.clone());
    for (root, dir) in pending {
        let Some(dir) = dir else {
            continue; // identical generation — the record stays as-is
        };
        let id = shared_record_id(&root);
        if let Some(existing) = installs
            .iter()
            .find(|r| r.id == id && (r.game_root.is_empty() || r.game_root == game_root))
        {
            // Cross-bin replace: the old record's `@game/` entries name
            // the physically-single game-root file this install just
            // rewrote (the new component record is not claimable yet, and
            // a cross-bin record never enters the same-bin claim scans) —
            // protect them so the rewind leaves the fresh bytes instead
            // of deleting the DLL and restoring the old layer over it.
            // Last writer wins; res_mods entries keep the plain rewind
            // (they live under the old record's own, now stale, bin).
            let protect_at_game = if existing.bin_version != pack.bin_version {
                existing
                    .files
                    .iter()
                    .filter(|f| f.starts_with("@game/"))
                    .map(|f| uninstall_path_key(f))
                    .collect()
            } else {
                std::collections::HashSet::new()
            };
            super::uninstall::rewind_for_reinstall_protecting(
                installs,
                &id,
                game_root,
                &protect_at_game,
            )?;
        }
        let files = groups
            .iter()
            .find(|(r, _)| *r == root)
            .map(|(_, f)| f.clone())
            .unwrap_or_default();
        // A component dir the moves left without layers (a brand-new
        // component overwrote nothing) describes no snapshot — never
        // point the record at an empty or missing dir.
        let restore_dir = if dir.is_dir() && mod_hub::tree_has_files(&dir) {
            Some(dir.to_string_lossy().into_owned())
        } else {
            fs::remove_dir_all(&dir).ok();
            None
        };
        installs.push(ModInstallRecord {
            id,
            name: shared_record_label(&root),
            version: pack.version.clone(),
            category: "shared".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: pack.bin_version.clone(),
            installed_at: pack.installed_at.clone(),
            hashes: restrict_hashes(written_hashes.as_ref(), &files),
            snapshot_hashes: restrict_hashes(layer_hashes.as_ref(), &files),
            files,
            restore_dir,
            game_root: pack.game_root.clone(),
            shared_roots: Vec::new(),
        });
    }
    Ok(pack)
}

/// Identical-generation verdict for the upsert: TRUE when the existing
/// component record already describes exactly these files with exactly
/// these written bytes — the incoming install re-ships the SAME
/// generation, so nothing about the component changes. A record keyed at
/// another bin owns physically different files, one without hash maps
/// (or an incoming file that could not be hashed — the maps are
/// advisory) cannot be PROVEN identical, and a differing file set is a
/// different generation by definition: all of those take the
/// replace branch.
fn same_generation(
    existing: &ModInstallRecord,
    bin_version: &str,
    root: &str,
    files: &[String],
    written: Option<&std::collections::HashMap<String, String>>,
) -> bool {
    if existing.bin_version != bin_version {
        return false;
    }
    let mut have: Vec<&String> = existing
        .files
        .iter()
        .filter(|f| shared_component_root(f).as_deref() == Some(root))
        .collect();
    let mut incoming: Vec<&String> = files.iter().collect();
    have.sort_unstable();
    incoming.sort_unstable();
    if have != incoming {
        return false;
    }
    let Some(recorded) = existing.hashes.as_ref() else {
        return false;
    };
    files.iter().all(|rel| {
        let key = uninstall_path_key(rel);
        match (recorded.get(&key), written.and_then(|h| h.get(&key))) {
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
            // An unhashable incoming byte stream is never provably
            // identical — replace and let the new generation own it.
            _ => false,
        }
    })
}

/// Move (or, with `to: None`, delete) the pre-overwrite layers this
/// install captured for one component's files out of the PACK record's
/// restore dir. Layer copies keep the ledger-relative spelling
/// (`@game/…` game-root drops included), so the destination directory is
/// a restore dir in its own right — `restore_tree` walks it unchanged.
/// Files the journal never snapshotted (brand-new paths) have no layer
/// and are skipped.
fn relocate_layers(from: &Path, files: &[String], to: Option<&Path>) -> anyhow::Result<()> {
    for rel in files {
        let layer = from.join(rel);
        if !layer.is_file() {
            continue;
        }
        match to {
            Some(dir) => {
                let dest = dir.join(rel);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
                }
                fs::rename(&layer, &dest)
                    .map_err(|e| anyhow!("move snapshot {}: {e}", layer.display()))?;
            },
            None => {
                fs::remove_file(&layer)
                    .map_err(|e| anyhow!("remove snapshot {}: {e}", layer.display()))?;
            },
        }
    }
    Ok(())
}

/// A pack update that DROPS a component must not strand it: for every
/// root the PREVIOUS same-id record(s) consumed (their `shared_roots`
/// edges union any inlined shared files — legacy shape) that the new pack
/// no longer declares, run the last-consumer cleanup (same helper, same
/// Strict semantics as a dependent's uninstall). With no consumer left,
/// the component record goes with its files and layer — updating
/// everything leaves nothing behind, exactly the pre-split behavior where
/// the old pack's own rewind removed its inlined shared files.
pub(crate) fn drop_removed_shared_roots(
    installs: &mut Vec<ModInstallRecord>,
    previous: &[ModInstallRecord],
    new_roots: &[String],
    game_root: &str,
) -> anyhow::Result<Vec<UninstallReport>> {
    let mut reports = Vec::new();
    for prev in previous {
        let dropped: Vec<String> = super::uninstall::consumed_shared_roots(prev)
            .into_iter()
            .filter(|root| !new_roots.contains(root))
            .collect();
        if dropped.is_empty() {
            continue;
        }
        reports.extend(super::uninstall::last_consumer_cleanup_for_roots(
            installs,
            &dropped,
            &prev.bin_version,
            game_root,
        )?);
    }
    Ok(reports)
}

/// The P4 map entries for exactly one component's files — the map the
/// shared record stores (the pack record keeps none). `None` when the
/// install's map is absent or covers none of the files.
fn restrict_hashes(
    map: Option<&std::collections::HashMap<String, String>>,
    files: &[String],
) -> Option<std::collections::HashMap<String, String>> {
    let map = map?;
    let keys: std::collections::HashSet<String> =
        files.iter().map(|f| uninstall_path_key(f)).collect();
    let restricted: std::collections::HashMap<String, String> = map
        .iter()
        .filter(|(k, _)| keys.contains(*k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    (!restricted.is_empty()).then_some(restricted)
}
