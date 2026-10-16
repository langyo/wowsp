//! Pre-release mirror fan-out — the second half of Steam's pre-release
//! story (the first half is the `preferences.xml` pin, see
//! `game_context::preferences_active_build`).
//!
//! Steam stages the NEXT version's complete `bin/<build>/` days before the
//! client switches to it, and the pin only flips when the new build has
//! actually RUN once — so between the live switch and that first launch
//! neither build is provably "next". Instead of guessing, every res_mods
//! mutation mirrors its file changes into the pre-release twins
//! ([`crate::commands::game_context::preload_bin_dirs`]): whichever build
//! the client loads next, the mods are already in place. Once the pin
//! flips, the previous bin shows up in the stale-bin banner and the
//! existing reclaim flow cleans it — mirroring never has to predict the
//! switch.
//!
//! All mirror writes are best effort. A pre-release tree is a convenience
//! copy of the live one, so a mirror failure warns and never fails,
//! blocks or rolls back the live operation that triggered it — and never
//! enters the install journal or the ledger (records stay keyed at the
//! live bin; the reclaim migration re-points them after the switch).

use super::*;

// ── twin discovery ──────────────────────────────────────────────────────────

/// The pre-release twins as `(bin version, res_mods)` pairs — see
/// [`preload_res_mods`] for the filtering rules.
pub(crate) fn preload_bins(game_root: &str) -> Vec<(String, PathBuf)> {
    let root = Path::new(game_root);
    let key_of = |p: &Path| crate::commands::game_detect::install_path_key(&p.to_string_lossy());
    let live_key = crate::commands::game_context::res_mods_dir(root)
        .ok()
        .map(|p| key_of(&p));
    crate::commands::game_context::preload_bin_dirs(root)
        .into_iter()
        .filter(|(_, dir)| !disabled_res_mods(dir).exists())
        .map(|(_, dir)| {
            let version = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            (version, dir.join("res_mods"))
        })
        .filter(|(_, rm)| live_key.as_ref().is_none_or(|k| *k != key_of(rm)))
        .collect()
}

/// `res_mods` dirs of the pre-release twins under `game_root`, skipping
/// bins whose res_mods is safe-mode quarantined (that bin opted out of mod
/// management wholesale). Empty when no pin exists or nothing complete sits
/// above it. The live bin itself never qualifies: with a stale pin (the
/// recorded build no longer on disk) the fallback selection can BE the
/// highest bin above the pin, and mirroring a tree onto itself must not
/// even be attempted.
pub(crate) fn preload_res_mods(game_root: &str) -> Vec<PathBuf> {
    preload_bins(game_root)
        .into_iter()
        .map(|(_, rm)| rm)
        .collect()
}

// ── fan-out operations ──────────────────────────────────────────────────────

/// What one [`mirror_written`] fan-out did: the twins that received the
/// files (bin version strings, for the install report's positive note) and
/// the warnings for twins that could not be fully synced.
pub(crate) struct MirrorOutcome {
    pub synced_bins: Vec<String>,
    pub warnings: Vec<String>,
}

/// Copy the just-written live files into every pre-release twin. A twin
/// must end up holding the SAME copy the live bin runs, so existing twin
/// files at those paths are overwritten (the unified "one mod, both bins"
/// install); files a twin carries beyond the written set are left alone.
/// `@game/` payloads live in the version-independent game root and are
/// skipped. See [`MirrorOutcome`] for what comes back.
pub(crate) fn mirror_written(
    game_root: &str,
    primary: &Path,
    rel_paths: &[String],
) -> MirrorOutcome {
    let mut outcome = MirrorOutcome {
        synced_bins: Vec::new(),
        warnings: Vec::new(),
    };
    for (version, mirror) in preload_bins(game_root) {
        let mut failed = 0usize;
        let mut copied = 0usize;
        for rel in rel_paths {
            if rel.starts_with("@game/") {
                continue;
            }
            let src = primary.join(rel);
            if !src.is_file() {
                continue;
            }
            let dst = mirror.join(rel);
            let Some(parent) = dst.parent() else { continue };
            if fs::create_dir_all(parent).is_err() || fs::copy(&src, &dst).is_err() {
                failed += 1;
            } else {
                copied += 1;
            }
        }
        if failed > 0 {
            outcome.warnings.push(format!(
                "pre-release copy incomplete under {} ({} file(s) skipped)",
                mirror.display(),
                failed
            ));
        } else if copied > 0 {
            outcome.synced_bins.push(version);
        }
    }
    outcome
}

/// Apply a live↔`.bak` toggle to the mirrored copies, so a mod disabled
/// before the switch does not come back alive after it. Missing twin files
/// are skipped silently — the twin only mirrors what was ever installed
/// into it. Best effort by the module rules above.
pub(crate) fn mirror_set_state(game_root: &str, rel_paths: &[String], enabled: bool) {
    for mirror in preload_res_mods(game_root) {
        let _ = super::unit_ops::set_paths_state(&mirror, rel_paths, enabled);
    }
}

/// The loader-marker invariant applied to every twin: PnF content ⇒ the
/// `PnFModsLoader.py` marker, the same rule the live tree enforces (the
/// client loads PnF mods only while it exists). A twin's fresh marker
/// transplants the LIVE tree's marker bytes — a foreign pack shipping real
/// loader content keeps it byte-identical across the switch; the standard
/// 0-byte marker is the fallback. Idempotent.
pub(crate) fn ensure_loader_markers(game_root: &str) {
    let live_bytes = crate::commands::game_context::res_mods_dir(Path::new(game_root))
        .ok()
        .and_then(|live| fs::read(live.join("PnFModsLoader.py")).ok());
    for mirror in preload_res_mods(game_root) {
        if mirror.join("PnFMods").is_dir() && !mirror.join("PnFModsLoader.py").is_file() {
            let _ = fs::write(
                mirror.join("PnFModsLoader.py"),
                live_bytes.as_deref().unwrap_or(b""),
            );
        }
    }
}

/// Remove the mirrored copies (live files, `.bak` twins and whole
/// directories) so an uninstall does not resurrect the mod after the
/// switch. The shared 0-byte `PnFModsLoader.py` marker is never taken out
/// here — like the live uninstall's plain file loop, the marker belongs to
/// the tree, not to one mod. Best effort by the module rules above.
pub(crate) fn mirror_removed(game_root: &str, rel_paths: &[String]) {
    for mirror in preload_res_mods(game_root) {
        for rel in rel_paths {
            if rel.starts_with("@game/") || rel == "PnFModsLoader.py" {
                continue;
            }
            let path = mirror.join(rel);
            let twin = sibling_with_suffix(&path, ".bak");
            if path.is_file() {
                let _ = fs::remove_file(&path);
            }
            if twin.is_file() {
                let _ = fs::remove_file(&twin);
            }
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
            }
        }
        super::unit_ops::prune_empty_parents(&mirror, rel_paths);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Twin discovery: complete staged bins above the pin, minus the
    /// safe-mode-quarantined one; nothing without a pin.
    #[test]
    fn preload_res_mods_pick_bins_above_the_pin() {
        let tmp = std::env::temp_dir().join("wowsp_preload_discover");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/100/idx")).unwrap();
        fs::create_dir_all(game.join("bin/200/idx")).unwrap();
        fs::create_dir_all(game.join("bin/300/idx")).unwrap();
        fs::create_dir_all(game.join("bin/300/res_mods.wowsp-disabled")).unwrap();
        fs::create_dir_all(game.join("bin/400")).unwrap();
        fs::create_dir_all(game.join("bin/500/idx")).unwrap();
        fs::write(
            game.join("preferences.xml"),
            "<root><last_server_version> 15,8,0,200 </last_server_version></root>",
        )
        .unwrap();

        let twins = preload_res_mods(&game.to_string_lossy());
        // 100 is below the pin, 200 IS the pin, 300 is quarantined, 400
        // carries no idx — only 500 qualifies.
        assert_eq!(twins.len(), 1, "{twins:?}");
        assert!(
            twins[0].ends_with("bin/500/res_mods") || twins[0].ends_with(r"bin\500\res_mods"),
            "{twins:?}"
        );

        // Without a pin "future" is undefined — no twins, no mirroring.
        fs::remove_file(game.join("preferences.xml")).unwrap();
        assert!(preload_res_mods(&game.to_string_lossy()).is_empty());

        fs::remove_dir_all(&tmp).ok();
    }
}
