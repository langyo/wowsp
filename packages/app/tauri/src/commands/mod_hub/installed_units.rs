use super::scan_installed::{UnitCandidate, gather_candidates, parse_installed_manifest};
use super::*;

/// Classify one installed res_mods root into typed plugin units. When
/// Aslain's `installed_mods.xml` manifest exists, its rows are the
/// authoritative plugin list: filesystem groups attach to rows by name
/// similarity, leftover groups stay standalone, and rows with no matched
/// files become manifest-only rows so the list still mirrors the installer.
pub(crate) fn classify_installed_root(res_mods: &Path) -> Vec<InstalledMod> {
    let cands = gather_candidates(res_mods);
    let manifest = parse_installed_manifest(res_mods);

    // Best manifest row per candidate. Exact name beats containment beats a
    // long shared prefix; ties go to the lexicographically smaller row name.
    let mut owner: Vec<Option<usize>> = vec![None; cands.len()];
    for (ci, cand) in cands.iter().enumerate() {
        let mut best: Option<(i64, usize)> = None;
        for (mi, m) in manifest.iter().enumerate() {
            let score = manifest_name_score(&m.name, &cand.name);
            let better = match best {
                None => score > 0,
                Some((bs, bi)) => {
                    score > bs || (score == bs && score > 0 && manifest[bi].name > m.name)
                },
            };
            if better {
                best = Some((score, mi));
            }
        }
        owner[ci] = best.map(|(_, mi)| mi);
    }

    let mut mods = Vec::new();

    // Manifest rows in file order first.
    for (mi, m) in manifest.iter().enumerate() {
        let owned: Vec<&UnitCandidate> = cands
            .iter()
            .enumerate()
            .filter(|(ci, _)| owner[*ci] == Some(mi))
            .map(|(_, c)| c)
            .collect();
        let mut paths: Vec<String> = owned.iter().flat_map(|c| c.paths.iter().cloned()).collect();
        paths.sort();
        let kind = owned
            .iter()
            .map(|c| c.kind)
            .min_by_key(|k| *k as u8)
            .unwrap_or(ModKind::Patch);
        let detail = owned.iter().find_map(|c| c.detail.clone());
        let texture_analysis = owned.iter().find_map(|c| c.analysis.clone());
        mods.push(InstalledMod {
            kind,
            name: m.name.clone(),
            detail,
            texture_analysis,
            // Manifest-only rows key on the (unique) row name instead of a
            // path so uninstall can still resolve — and clean — them.
            rel_path: paths.first().cloned().unwrap_or_else(|| m.name.clone()),
            disabled: unit_disabled_state(res_mods, &paths),
            paths,
            version: m.version.clone(),
            warnings: Vec::new(),
        });
    }

    // Leftover filesystem groups keep their heuristic identity.
    for (ci, cand) in cands.iter().enumerate() {
        if owner[ci].is_some() {
            continue;
        }
        let disabled = unit_disabled_state(res_mods, &cand.paths);
        mods.push(InstalledMod {
            kind: cand.kind,
            name: cand.name.clone(),
            detail: cand.detail.clone(),
            texture_analysis: cand.analysis.clone(),
            rel_path: cand.paths.first().cloned().unwrap_or_default(),
            paths: cand.paths.clone(),
            disabled,
            version: None,
            warnings: Vec::new(),
        });
    }

    // Two installed skins overriding the same ship id conflict — exactly
    // one can win and the other's files linger as dead weight. Say so on
    // every unit involved (the module doc's oldest unresolved hazard).
    let mut ship_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for m in &mods {
        if m.kind == ModKind::Skin && !m.disabled {
            if let Some(id) = &m.detail {
                *ship_counts.entry(id.clone()).or_default() += 1;
            }
        }
    }
    for m in &mut mods {
        if m.kind == ModKind::Skin && !m.disabled {
            if let Some(id) = &m.detail {
                if ship_counts.get(id).is_some_and(|n| *n > 1) {
                    m.warnings.push(format!(
                        "another installed skin also overrides ship {id} — only one can take effect"
                    ));
                }
            }
        }
    }

    mods.sort_by(|a, b| {
        (a.kind as u8)
            .cmp(&(b.kind as u8))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    mods
}

/// Similarity between an `installed_mods.xml` row name and a filesystem
/// group's base name — Aslain rows rarely match folder names verbatim
/// (`SmokeMarker` → `PnFMods/SmokeMarkerPy`, `BattleFrame_TorpedoDetection`
/// → `gui/unbound2/!battleframe`, `TTaroModConfig` → `gui/ttaro_mod_config`).
/// Both sides normalize to lowercase alphanumerics; an exact match wins,
/// then substring containment, then a shared prefix of at least eight
/// characters (so `BattleFrame_Torpedoes` still groups under
/// `BattleFrame_TorpedoDetection` while unrelated short names stay apart).
fn manifest_name_score(mod_name: &str, base: &str) -> i64 {
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase()
    };
    let m = norm(mod_name);
    if m.len() < 4 {
        return 0;
    }
    let b = norm(base);
    // PnF payload folders conventionally append `Py` (SmokeMarkerPy).
    let b_bare = if b.len() > 4 && b.ends_with("py") {
        b[..b.len() - 2].to_string()
    } else {
        String::new()
    };
    let mut best = 0i64;
    for cand in [b.as_str(), b_bare.as_str()] {
        if cand.len() < 4 {
            continue;
        }
        if cand == m {
            return 10_000;
        }
        if (cand.contains(&m) || m.contains(cand)) && cand.len().min(m.len()) >= 6 {
            best = best.max((cand.len().min(m.len()) * 2) as i64);
        }
        let prefix = m
            .bytes()
            .zip(cand.bytes())
            .take_while(|(mc, bc)| mc == bc)
            .count();
        if prefix >= 8 {
            best = best.max(prefix as i64);
        }
    }
    best
}

/// Prefer the live `file` in `dir`, fall back to its `.bak` twin. Returns
/// the existing path plus whether it is the disabled variant.
pub(crate) fn existing_with_bak(dir: &Path, file: &str) -> (Option<PathBuf>, bool) {
    let live = dir.join(file);
    if live.is_file() {
        return (Some(live), false);
    }
    let bak = dir.join(format!("{file}.bak"));
    if bak.is_file() {
        return (Some(bak), true);
    }
    (None, false)
}

/// Display name of a patch file: the `.bak` suffix is a toggle marker, not
/// part of the mod name.
pub(crate) fn display_file_name(name: &str) -> String {
    name.strip_suffix(".bak").unwrap_or(name).to_string()
}

/// Every file a unit root covers: the root itself when it is a file,
/// otherwise its recursive contents.
pub(crate) fn unit_files(res_mods: &Path, rel: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![res_mods.join(rel)];
    while let Some(path) = stack.pop() {
        if path.is_file() {
            files.push(path);
            continue;
        }
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                files.push(p);
            }
        }
    }
    files
}

/// A unit counts as disabled when it has files and every one of them is a
/// `.bak` twin.
fn unit_disabled_state(res_mods: &Path, paths: &[String]) -> bool {
    let mut total = 0usize;
    let mut bak = 0usize;
    for rel in paths {
        for file in unit_files(res_mods, rel) {
            total += 1;
            if file.to_string_lossy().ends_with(".bak") {
                bak += 1;
            }
        }
    }
    total > 0 && bak == total
}

/// Does any unit root cover a res_mods-relative file? Directory roots cover
/// their subtree; file roots compare with the `.bak` suffix neutralized so
/// ledger-recorded names match disabled twins.
pub(crate) fn unit_covers(paths: &[String], file_rel: &str) -> bool {
    let bare = file_rel.strip_suffix(".bak").unwrap_or(file_rel);
    paths.iter().any(|p| {
        let p_bare = p.strip_suffix(".bak").unwrap_or(p);
        bare == p_bare
            || bare.starts_with(&format!("{p_bare}/"))
            || file_rel.starts_with(&format!("{p}/"))
    })
}
