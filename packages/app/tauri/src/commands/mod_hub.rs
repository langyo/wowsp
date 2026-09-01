//! Mod Hub package classification & install (milestone M10 groundwork).
//!
//! Classifies real-world WoWS plugin packages into the taxonomy from
//! `docs/<lang>/designs/mod-formats.md` and installs them under
//! `bin/<latest>/res_mods/`, following the Aslain layout convention so both
//! installers coexist.
//!
//! Format facts encoded here come from inspecting 22 distributed packages:
//!
//! - Voice banks live at `banks/mods/<name>/mod.xml` (+ `.wem`). Some packs
//!   ship uppercase `Mods`, so all matches are case-insensitive. "Bare" packs
//!   (a root `AudioModification` xml + loose `.wem`) must be wrapped into a
//!   `banks/mods/<name>/` folder; the xml `<Name>` becomes the in-game
//!   voice-over selector label.
//! - PnF skins register via `Main.py` calling `contentSdk.registerShipMod('<ShipId>')`;
//!   two skins for the same ship id conflict. The loader marker
//!   `PnFModsLoader.py` is a 0-byte placeholder the game requires — many packs
//!   omit it, so installs create it when missing.
//! - Rest are plain override trees (`content/`, `gui/…`) or single config
//!   patches (`ime_config.xml`).
//!
//! Archives (.zip/.7z) land with M10.2's unpack step — this round accepts
//! already-unpacked directories and returns a structured error for files.

use std::fs;
use std::path::{Path, PathBuf};

use wowsp_tauri_shared::{InstallReport, InstalledMod, ModKind, PackagePlan, PackagePlanEntry};

/// What [`install_plan`] did, beyond the user-facing report: the exact files
/// written (res_mods-relative) and where overwritten originals were snapshotted.
pub(crate) struct PlanApply {
    pub report: InstallReport,
    pub written: Vec<String>,
    /// Directory holding pre-overwrite copies, `None` when nothing was replaced.
    pub restore_dir: Option<PathBuf>,
}

/// Locate the newest numeric `bin/<version>/` dir. Same rule as the overlay
/// mod installer — the client runs from the highest-numbered version dir.
fn latest_bin_version(game_root: &str) -> Option<(String, PathBuf)> {
    let bin = PathBuf::from(game_root).join("bin");
    let mut newest: Option<(u64, PathBuf)> = None;
    for ent in fs::read_dir(bin).ok()?.flatten() {
        let name = ent.file_name();
        let Ok(num) = name.to_string_lossy().parse::<u64>() else {
            continue;
        };
        if newest.as_ref().is_none_or(|(v, _)| num > *v) {
            newest = Some((num, ent.path()));
        }
    }
    newest.map(|(n, p)| (n.to_string(), p))
}

/// Extract `<Name>value</Name>` of the first such tag (ASCII-case-insensitive).
fn first_xml_tag(body: &str, tag: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let start = lower.find(&open)? + open.len();
    let close = lower[start..].find(&format!("</{}>", tag.to_ascii_lowercase()))?;
    Some(body[start..start + close].trim().to_string())
}

/// Pull `registerShipMod('<arg>')` out of a PnF `Main.py`.
fn registered_ship_id(main_py: &str) -> Option<String> {
    let idx = main_py.find("registerShipMod")?;
    let rest = &main_py[idx..];
    let quote = rest.find(['\'', '"'])?;
    let rest = &rest[quote + 1..];
    let end = rest.find(['\'', '"'])?;
    Some(rest[..end].trim().to_string())
}

/// Copy a subtree (or a single mapped file) recursively, counting writes.
/// `written` collects every file landing under `res_mods` (res_mods-relative);
/// files about to be overwritten are first snapshotted into `restore_dir`.
fn copy_tree(
    from: &Path,
    to: &Path,
    res_mods: &Path,
    restore_dir: &Option<PathBuf>,
    written: &mut Vec<String>,
) -> Result<usize, String> {
    if !from.exists() {
        return Err(format!("{} does not exist", from.display()));
    }
    if from.is_file() {
        fs::create_dir_all(to.parent().unwrap_or(to))
            .map_err(|e| format!("create {}: {e}", to.display()))?;
        snapshot_before_overwrite(to, res_mods, restore_dir);
        fs::copy(from, to).map_err(|e| format!("copy {}: {e}", from.display()))?;
        record_written(to, res_mods, written);
        return Ok(1);
    }
    fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let mut count = 0usize;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        for ent in fs::read_dir(&src)
            .map_err(|e| format!("read {}: {e}", src.display()))?
            .flatten()
        {
            let s = ent.path();
            let d = dst.join(ent.file_name());
            if s.is_dir() {
                fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
                stack.push((s, d));
            } else {
                snapshot_before_overwrite(&d, res_mods, restore_dir);
                fs::copy(&s, &d).map_err(|e| format!("copy {}: {e}", s.display()))?;
                record_written(&d, res_mods, written);
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Copy an existing target aside before it gets clobbered (best effort — a
/// failed snapshot only means that file can't be restored later).
fn snapshot_before_overwrite(target: &Path, res_mods: &Path, restore_dir: &Option<PathBuf>) {
    let (Some(dir), Ok(rel)) = (restore_dir.as_deref(), target.strip_prefix(res_mods)) else {
        return;
    };
    if !target.is_file() {
        return;
    }
    let snap = dir.join(rel);
    if fs::copy(target, &snap).is_ok() {
        tracing::debug!(from = %target.display(), to = %snap.display(), "restore snapshot");
    }
}

fn record_written(written: &Path, res_mods: &Path, out: &mut Vec<String>) {
    if let Ok(rel) = written.strip_prefix(res_mods) {
        out.push(rel.to_string_lossy().replace('\\', "/"));
    }
}

// ── Scan installed ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn mod_hub_scan_installed(game_root: String) -> Result<Vec<InstalledMod>, String> {
    let (_, ver_dir) = latest_bin_version(&game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let res_mods = ver_dir.join("res_mods");
    if !res_mods.is_dir() {
        return Ok(Vec::new());
    }
    Ok(classify_installed_root(&res_mods))
}

/// Classify one installed `res_mods/<version>/` root into typed entries.
fn classify_installed_root(res_mods: &Path) -> Vec<InstalledMod> {
    let mut mods = Vec::new();
    let Ok(top) = fs::read_dir(res_mods) else {
        return mods;
    };
    for entry in top.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();

        if name_str.eq_ignore_ascii_case("PnFModsLoader.py") {
            continue; // marker, not content
        }

        // banks/<any-case>/…/mod.xml — real packs ship both `mods` and `Mods`,
        // and Windows folds them into one physical directory, so walk the
        // actual children instead of probing case variants.
        if name_str.eq_ignore_ascii_case("banks") && entry.path().is_dir() {
            let Ok(bank_roots) = fs::read_dir(entry.path()) else {
                continue;
            };
            for root in bank_roots.flatten() {
                if !root.path().is_dir()
                    || !root
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("mods")
                {
                    continue;
                }
                let Ok(banks) = fs::read_dir(root.path()) else {
                    continue;
                };
                for bank in banks.flatten() {
                    if bank.path().is_dir() && bank.path().join("mod.xml").is_file() {
                        let detail = fs::read_to_string(bank.path().join("mod.xml"))
                            .ok()
                            .and_then(|body| first_xml_tag(&body, "Name"));
                        mods.push(InstalledMod {
                            kind: ModKind::Voice,
                            name: bank.file_name().to_string_lossy().into_owned(),
                            detail,
                            rel_path: format!(
                                "banks/{}/{}",
                                root.file_name().to_string_lossy(),
                                bank.file_name().to_string_lossy()
                            ),
                        });
                    }
                }
            }
            continue;
        }

        // PnFMods/<Name>/Main.py — one entry per skin folder.
        if name_str.eq_ignore_ascii_case("PnFMods") && entry.path().is_dir() {
            let Ok(skins) = fs::read_dir(entry.path()) else {
                continue;
            };
            for skin in skins.flatten() {
                let main_py = skin.path().join("Main.py");
                if !main_py.is_file() {
                    continue;
                }
                let detail = fs::read_to_string(&main_py)
                    .ok()
                    .and_then(|body| registered_ship_id(&body));
                mods.push(InstalledMod {
                    kind: ModKind::Skin,
                    name: skin.file_name().to_string_lossy().into_owned(),
                    detail,
                    rel_path: format!("PnFMods/{}", skin.file_name().to_string_lossy()),
                });
            }
            continue;
        }

        // gui/ribbons + gui/BFGC/BattleWave art.
        if name_str.eq_ignore_ascii_case("gui") && entry.path().is_dir() {
            for known in ["ribbons", "BFGC"] {
                let p = entry.path().join(known);
                if p.is_dir() {
                    mods.push(InstalledMod {
                        kind: ModKind::Gui,
                        name: known.to_string(),
                        detail: None,
                        rel_path: format!("gui/{known}"),
                    });
                }
            }
            continue;
        }

        // Single-file config patches.
        if entry.path().is_file() && name_str.to_ascii_lowercase().ends_with(".xml") {
            mods.push(InstalledMod {
                kind: ModKind::Patch,
                name: name_str.clone(),
                detail: None,
                rel_path: name_str.clone(),
            });
            continue;
        }

        // Anything else under content/ → texture overrides; other unknown
        // top-level dirs are reported as textures too so nothing vanishes.
        if entry.path().is_dir() {
            mods.push(InstalledMod {
                kind: ModKind::Textures,
                name: name_str.clone(),
                detail: None,
                rel_path: name_str,
            });
        }
    }
    mods.sort_by(|a, b| {
        (a.kind as u8)
            .cmp(&(b.kind as u8))
            .then(a.name.cmp(&b.name))
    });
    mods
}

// ── Classify incoming package ───────────────────────────────────────────────

const UNSUPPORTED_ARCHIVE: &str =
    "archive payloads need M10.2 unpack support — extract it to a folder first";

#[tauri::command]
pub fn mod_hub_classify_path(source_path: String) -> Result<PackagePlan, String> {
    let src = Path::new(&source_path);
    // Archives are rejected up front with the unpack hint, whether or not the
    // file exists yet — the caller may be probing a path from a picker.
    let ext = src
        .extension()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .to_string_lossy()
        .into_owned();
    if src.is_file() || matches!(ext.as_str(), "zip" | "7z") {
        return Err(match ext.as_str() {
            "zip" | "7z" => UNSUPPORTED_ARCHIVE.to_string(),
            _ => format!("unsupported package file: {}", src.display()),
        });
    }
    if !src.is_dir() {
        return Err(format!("package not found: {}", src.display()));
    }

    let plan = classify_package(src)?;
    if plan.entries.is_empty() {
        return Err(format!(
            "no recognizable mod structure in {} (see docs/designs/mod-formats.md)",
            src.display()
        ));
    }
    Ok(plan)
}

/// Classify the contents of an unpacked package directory.
pub(crate) fn classify_package(src: &Path) -> Result<PackagePlan, String> {
    let mut plan = classify_package_layout(src)?;

    // Real-world packs often ship behind a single naming-wrapper folder
    // (<系列名>/<本体>/{PnFMods,content,…}, e.g. 莫斯科日奈换色版). When the
    // top level has no signatures but exactly one child directory carries
    // them, re-derive the plan one layer down and shift `fromRel` inward —
    // installs then read payloads relative to the wrapper.
    if plan.entries.is_empty() {
        if let Some(wrapper) = single_wrapper_dir(src) {
            let inner = src.join(&wrapper);
            let candidate = classify_package_layout(&inner)?;
            for entry in candidate.entries {
                plan.entries.push(PackagePlanEntry {
                    from_rel: format!("{}/{}", wrapper, entry.from_rel),
                    to_rel: entry.to_rel,
                });
            }
            if !plan.entries.is_empty() {
                plan.kind = candidate.kind;
                if plan.detail.is_none() {
                    plan.detail = candidate.detail;
                }
                plan.warnings.extend(candidate.warnings);
                plan.warnings
                    .push(format!("unwrapped single-layer folder \"{wrapper}\""));
            }
        }
    }

    Ok(plan)
}

/// The only content of `src` is one subdirectory (ignoring explorer noise) —
/// its name is a candidate wrapper layer.
fn single_wrapper_dir(src: &Path) -> Option<String> {
    let mut dirs = Vec::new();
    for e in fs::read_dir(src).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if lower == "desktop.ini" || lower == "thumbs.db" || lower.ends_with(".txt") {
            continue;
        }
        if !e.path().is_dir() {
            return None;
        }
        dirs.push(name);
    }
    if dirs.len() == 1 { dirs.pop() } else { None }
}

/// Signature-level classification of one directory layout (no wrapper peel).
fn classify_package_layout(src: &Path) -> Result<PackagePlan, String> {
    let entries_raw: Vec<String> = fs::read_dir(src)
        .map_err(|e| format!("read {}: {e}", src.display()))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    let has = |name: &str| entries_raw.iter().any(|n| n.eq_ignore_ascii_case(name));

    // Bare audio pack: root AudioModification xml + loose .wem files.
    if has("mod.xml")
        && entries_raw
            .iter()
            .any(|n| n.to_ascii_lowercase().ends_with(".wem"))
    {
        let body = fs::read_to_string(src.join("mod.xml")).unwrap_or_default();
        let label = first_xml_tag(&body, "Name")
            .or_else(|| src.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "voice-pack".into());
        let safe_bank = sanitize_dir_name(&label);
        return Ok(PackagePlan {
            kind: ModKind::Voice,
            name: label.clone(),
            detail: Some(label),
            entries: vec![PackagePlanEntry {
                from_rel: ".".into(),
                to_rel: format!("banks/mods/{safe_bank}"),
            }],
            warnings: vec!["bare voice pack wrapped into banks/mods".into()],
        });
    }

    let mut plan = PackagePlan {
        kind: ModKind::Textures,
        name: src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        detail: None,
        entries: Vec::new(),
        warnings: Vec::new(),
    };

    let mut kinds_seen: Vec<ModKind> = Vec::new();
    let push_entry =
        |plan: &mut PackagePlan, kinds: &mut Vec<ModKind>, from: &str, to: &str, kind: ModKind| {
            plan.entries.push(PackagePlanEntry {
                from_rel: from.into(),
                to_rel: to.into(),
            });
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        };

    if has("banks") {
        push_entry(&mut plan, &mut kinds_seen, "banks", "banks", ModKind::Voice);
        // Detect nonstandard case (research sample: banks/Mods/…) for a warning.
        for n in &entries_raw {
            if n == "Mods" || n == "MODS" {
                plan.warnings
                    .push("bank folder uses non-lowercase mods/ — copied verbatim".into());
            }
        }
    }
    if has("PnFMods") {
        push_entry(
            &mut plan,
            &mut kinds_seen,
            "PnFMods",
            "PnFMods",
            ModKind::Skin,
        );
        // Parse every skin's Main.py for the ship ids + remember names/details.
        let pnf = src.join("PnFMods");
        if let Ok(skins) = fs::read_dir(&pnf) {
            let mut details: Vec<String> = Vec::new();
            for skin in skins.flatten() {
                let main_py = skin.path().join("Main.py");
                if let Ok(body) = fs::read_to_string(&main_py) {
                    if let Some(id) = registered_ship_id(&body) {
                        details.push(id);
                    }
                }
            }
            if !details.is_empty() {
                plan.kind = ModKind::Skin;
                plan.detail = Some(details.join(", "));
                kinds_seen.retain(|k| *k != ModKind::Textures);
            }
        }
        // The engine needs this 0-byte marker; most packs ship without it.
        let loader_missing = !src.join("PnFModsLoader.py").is_file();
        if loader_missing {
            plan.warnings
                .push("PnFModsLoader.py missing — created automatically on install".into());
        }
    }
    if has("content") {
        push_entry(
            &mut plan,
            &mut kinds_seen,
            "content",
            "content",
            ModKind::Textures,
        );
    }
    if has("gui") {
        push_entry(&mut plan, &mut kinds_seen, "gui", "gui", ModKind::Gui);
    }
    for file in &entries_raw {
        let lower = file.to_ascii_lowercase();
        if lower.ends_with(".xml") && lower != "mod.xml" && src.join(file).is_file() {
            push_entry(&mut plan, &mut kinds_seen, file, file, ModKind::Patch);
        }
    }

    if !kinds_seen.is_empty() {
        plan.kind = kinds_seen[0];
    }
    Ok(plan)
}

/// Filesystem-safe folder slug for auto-wrapped bank names.
fn sanitize_dir_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

// ── Install ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mod_hub_install(
    source_root: String,
    game_root: String,
    plan: PackagePlan,
) -> Result<InstallReport, String> {
    install_plan(Path::new(&source_root), &game_root, &plan).map(|applied| applied.report)
}

/// Core installer shared by the local-folder command and the online catalog:
/// applies `plan` for `game_root`, records every written file (res_mods-
/// relative) and snapshots overwritten originals for later restore.
pub(crate) fn install_plan(
    src: &Path,
    game_root: &str,
    plan: &PackagePlan,
) -> Result<PlanApply, String> {
    if !src.is_dir() {
        return Err(format!("package not found: {}", src.display()));
    }
    let (bin_version, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let res_mods = ver_dir.join("res_mods");

    // Lazily-used snapshot dir; dropped again when nothing was overwritten.
    let restore_dir = restore_root().join(format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        sanitize_dir_name(&plan.name)
    ));
    fs::create_dir_all(&restore_dir).map_err(|e| format!("create restore dir: {e}"))?;

    let mut written: Vec<String> = Vec::new();
    let mut wrote = 0usize;
    let mut warnings = plan.warnings.clone();
    let mut touched_pnf = false;
    for entry in &plan.entries {
        let from = if entry.from_rel == "." {
            src.to_path_buf()
        } else {
            src.join(&entry.from_rel)
        };
        let to = res_mods.join(&entry.to_rel);
        wrote += copy_tree(
            &from,
            &to,
            &res_mods,
            &Some(restore_dir.clone()),
            &mut written,
        )?;
        if entry.from_rel.eq_ignore_ascii_case("PnFMods") {
            touched_pnf = true;
        }
    }

    // PNF skin installs must leave the 0-byte loader marker behind.
    if touched_pnf {
        let loader = res_mods.join("PnFModsLoader.py");
        if !loader.is_file() {
            fs::write(&loader, "").map_err(|e| format!("touch loader: {e}"))?;
            record_written(&loader, &res_mods, &mut written);
            if !warnings.iter().any(|w| w.contains("PnFModsLoader")) {
                warnings.push("created missing PnFModsLoader.py".into());
            }
        }
    }

    // An untouched restore dir means nothing was overwritten — drop it so
    // uninstall does not chase ghosts.
    let restore_dir = if restore_root_has_files(&restore_dir) {
        Some(restore_dir)
    } else {
        fs::remove_dir(&restore_dir).ok();
        None
    };
    written.sort();
    tracing::info!(name = %plan.name, wrote, "install_plan done");
    Ok(PlanApply {
        report: InstallReport {
            name: plan.name.clone(),
            bin_version,
            wrote_files: wrote,
            warnings,
        },
        written,
        restore_dir,
    })
}

fn restore_root_has_files(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some())
}

/// `<data>/mods/restore/` — pre-overwrite snapshots, keyed by ts + mod name.
pub(crate) fn restore_root() -> PathBuf {
    let base = crate::paths::ensure_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("mods")
        .join("restore");
    fs::create_dir_all(&base).ok();
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn scans_mixed_res_mods_layout() {
        let tmp = std::env::temp_dir().join("wowsp_scan_test");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("bin/12668706/res_mods");
        // banks with BOTH case variants (real OTTO pack uses Mods).
        touch(&rm.join("banks/mods/Hoshino/mod.xml"));
        fs::write(
            rm.join("banks/mods/Hoshino/mod.xml"),
            "<AudioModification><Name>Hoshino</Name></AudioModification>",
        )
        .unwrap();
        touch(&rm.join("banks/Mods/OTTO Ver1.0/mod.xml"));
        // PnF skin
        fs::create_dir_all(rm.join("PnFMods/Hina_Moskva")).unwrap();
        fs::write(
            rm.join("PnFMods/Hina_Moskva/Main.py"),
            "API_VERSION = 'API_v1.0'\ncontentSdk.registerShipMod('RSC110_Pr_66_Moskva')",
        )
        .unwrap();
        touch(&rm.join("PnFModsLoader.py"));
        // gui + patch
        touch(&rm.join("gui/ribbons/ribbon_citadel.png"));
        touch(&rm.join("ime_config.xml"));

        let mods = classify_installed_root(&rm);
        let voices: Vec<_> = mods.iter().filter(|m| m.kind == ModKind::Voice).collect();
        assert_eq!(voices.len(), 2);
        assert!(
            voices
                .iter()
                .any(|m| m.detail.as_deref() == Some("Hoshino"))
        );
        let skins: Vec<_> = mods.iter().filter(|m| m.kind == ModKind::Skin).collect();
        assert_eq!(skins[0].detail.as_deref(), Some("RSC110_Pr_66_Moskva"));
        assert!(mods.iter().any(|m| m.kind == ModKind::Gui));
        assert!(
            mods.iter()
                .any(|m| m.kind == ModKind::Patch && m.rel_path == "ime_config.xml")
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn classifies_bare_voice_pack_and_wraps_it() {
        let tmp = std::env::temp_dir().join("wowsp_barepack_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("mod.xml"),
            "<AudioModification><Name>聖園ミカ</Name></AudioModification>",
        )
        .unwrap();
        touch(&tmp.join("01.wem"));

        let plan = classify_package(&tmp).unwrap();
        assert_eq!(plan.kind, ModKind::Voice);
        assert_eq!(plan.name, "聖園ミカ");
        assert_eq!(plan.entries[0].to_rel, "banks/mods/聖園ミカ");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn classify_reports_missing_pnf_loader_and_ship_ids() {
        let tmp = std::env::temp_dir().join("wowsp_pnfcls_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("PnFMods/Arisu_Venezia")).unwrap();
        fs::write(
            tmp.join("PnFMods/Arisu_Venezia/Main.py"),
            "API_VERSION='API_v1.0'; contentSdk.registerShipMod('ISC110_Venezia')",
        )
        .unwrap();

        let plan = classify_package(&tmp).unwrap();
        assert_eq!(plan.kind, ModKind::Skin);
        assert_eq!(plan.detail.as_deref(), Some("ISC110_Venezia"));
        assert!(plan.warnings.iter().any(|w| w.contains("PnFModsLoader")));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn classify_peels_single_wrapper_layer() {
        let tmp = std::env::temp_dir().join("wowsp_wrapper_test");
        let _ = fs::remove_dir_all(&tmp);
        // <系列>/<本体>/PnFMods/…+content/… — real 莫斯科日奈换色版 shape.
        fs::create_dir_all(tmp.join("莫斯科日奈/PnFMods/Hina_Moskva")).unwrap();
        fs::write(
            tmp.join("莫斯科日奈/PnFMods/Hina_Moskva/Main.py"),
            "API_VERSION='API_v1.0'\ncontentSdk.registerShipMod('RSC110_Pr_66_Moskva')",
        )
        .unwrap();
        touch(&tmp.join("莫斯科日奈/PnFModsLoader.py"));
        touch(&tmp.join("莫斯科日奈/content/gameplay/russia/textures/a.dds"));

        let plan = classify_package(&tmp).unwrap();
        assert_eq!(plan.kind, ModKind::Skin);
        assert_eq!(plan.detail.as_deref(), Some("RSC110_Pr_66_Moskva"));
        let froms: Vec<_> = plan.entries.iter().map(|e| e.from_rel.as_str()).collect();
        assert!(froms.contains(&"莫斯科日奈/PnFMods"), "{froms:?}");
        assert!(froms.contains(&"莫斯科日奈/content"), "{froms:?}");
        assert!(plan.warnings.iter().any(|w| w.contains("unwrapped")));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn install_maps_single_file_patches() {
        // Real ime_config patch: the plan's entry is a FILE, not a subtree.
        let pkg = std::env::temp_dir().join("wowsp_inst_ime");
        let game = std::env::temp_dir().join("wowsp_inst_ime_game");
        let _ = fs::remove_dir_all(&pkg);
        let _ = fs::remove_dir_all(&game);
        fs::create_dir_all(&pkg).unwrap();
        touch(&pkg.join("ime_config.xml"));
        fs::create_dir_all(game.join("bin/1")).unwrap();

        let plan = classify_package(&pkg).unwrap();
        assert_eq!(plan.kind, ModKind::Patch);
        let report = mod_hub_install(
            pkg.to_str().unwrap().into(),
            game.to_str().unwrap().into(),
            plan,
        )
        .unwrap();
        assert_eq!(report.wrote_files, 1);
        assert!(game.join("bin/1/res_mods/ime_config.xml").is_file());

        fs::remove_dir_all(&pkg).ok();
        fs::remove_dir_all(&game).ok();
    }

    #[test]
    fn install_copies_tree_and_creates_missing_loader() {
        let pkg = std::env::temp_dir().join("wowsp_inst_pkg");
        let game = std::env::temp_dir().join("wowsp_inst_game");
        let _ = fs::remove_dir_all(&pkg);
        let _ = fs::remove_dir_all(&game);
        fs::create_dir_all(pkg.join("PnFMods/Skin")).unwrap();
        touch(&pkg.join("PnFMods/Skin/Main.py"));
        fs::create_dir_all(game.join("bin/12668706")).unwrap();

        let plan = classify_package(&pkg).unwrap();
        let report = mod_hub_install(
            pkg.to_str().unwrap().into(),
            game.to_str().unwrap().into(),
            plan,
        )
        .unwrap();
        assert_eq!(report.wrote_files, 1);
        assert_eq!(report.bin_version, "12668706");
        let rm = game.join("bin/12668706/res_mods");
        assert!(rm.join("PnFMods/Skin/Main.py").is_file());
        assert!(rm.join("PnFModsLoader.py").is_file());

        fs::remove_dir_all(&pkg).ok();
        fs::remove_dir_all(&game).ok();
    }

    #[test]
    fn zip_files_get_structured_error() {
        let err = mod_hub_classify_path("Z:/not/here/pack.zip".into()).unwrap_err();
        assert_eq!(err, UNSUPPORTED_ARCHIVE);
    }

    // ── Real-world sample harness ───────────────────────────────────────────
    // Run against a local mod collection (skipped in CI):
    //   WOWSP_SAMPLES_DIR="D:\绿色软件\游戏工具\WOWS" cargo test -p wowsp_tauri
    //   -- --ignored --nocapture mod_hub_real
    //
    // `classify` sweep is read-only; the install leg writes only under %TEMP%.

    /// Every top-level entry of the samples dir must classify cleanly: dirs
    /// produce a typed plan, archives hit the structured unpack hint.
    #[test]
    #[ignore]
    fn mod_hub_real_samples_classify() {
        let dir = std::env::var("WOWSP_SAMPLES_DIR").expect("set WOWSP_SAMPLES_DIR");
        let mut seen = 0;
        for ent in fs::read_dir(&dir).unwrap().flatten() {
            let path = ent.path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name == "desktop.ini" {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            // Shortcuts/readmes/etc. are not packages — only archives must
            // classify through the structured unpack hint.
            if path.is_file() && !lower.ends_with(".zip") && !lower.ends_with(".7z") {
                println!("{name}: SKIP (not a package)");
                continue;
            }
            match mod_hub_classify_path(path.to_string_lossy().into_owned()) {
                Ok(plan) => {
                    println!(
                        "{name}: {:?} \"{}\" detail={:?} entries={} warnings={:?}",
                        plan.kind,
                        plan.name,
                        plan.detail,
                        plan.entries.len(),
                        plan.warnings
                    );
                    assert!(!plan.entries.is_empty(), "{name}: empty plan");
                },
                Err(err) => {
                    // Archives must always hit the structured unpack hint.
                    // Non-package payloads (SDK/tutorial trees, standalone
                    // tools, raw asset dumps, wrapper dirs of zips) fail with
                    // "no recognizable structure" by design — log them, don't
                    // treat as harness failures.
                    if err == UNSUPPORTED_ARCHIVE {
                        assert!(lower.ends_with(".zip") || lower.ends_with(".7z"));
                        println!("{name}: ARCHIVE (needs M10.2 unpack)");
                    } else {
                        assert!(err.contains("no recognizable"), "{name}: {err}");
                        println!("{name}: NOT-A-PACKAGE (rejected by design)");
                    }
                },
            }
            seen += 1;
        }
        assert!(seen >= 15, "expected the full sample set, got {seen}");
    }

    /// Install three representative real packs into a throwaway sandbox game
    /// and verify the written tree: bare-voice wrapping, banks passthrough and
    /// PnF loader-marker creation.
    #[test]
    #[ignore]
    fn mod_hub_real_samples_install_sandbox() {
        let dir = PathBuf::from(std::env::var("WOWSP_SAMPLES_DIR").expect("set WOWSP_SAMPLES_DIR"));
        let game = std::env::temp_dir().join("wowsp_realsample_game");
        let _ = fs::remove_dir_all(&game);
        fs::create_dir_all(game.join("bin/12668706")).unwrap();

        // 1. ime_config.xml (config-patch, folder layout).
        let ime = find_dir(&dir, "输入法").expect("ime sample");
        let plan = classify_package(&ime).unwrap();
        let report = mod_hub_install(
            ime.to_string_lossy().into_owned(),
            game.to_string_lossy().into_owned(),
            plan,
        )
        .unwrap();
        assert!(report.wrote_files >= 1);
        assert!(game.join("bin/12668706/res_mods/ime_config.xml").is_file());

        // 2. Miyako_soundmod — standard banks pack.
        let miyako = find_dir(&dir, "Miyako_soundmod").expect("banks sample");
        let plan = classify_package(&miyako).unwrap();
        assert_eq!(plan.kind, ModKind::Voice);
        let report = mod_hub_install(
            miyako.to_string_lossy().into_owned(),
            game.to_string_lossy().into_owned(),
            plan,
        )
        .unwrap();
        assert!(
            report.wrote_files > 90,
            "banks pack copied {} files",
            report.wrote_files
        );
        assert!(
            game.join("bin/12668706/res_mods/banks/mods/Miyako/mod.xml")
                .is_file()
        );

        // 3. 莫斯科日奈换色版 — PnF skin with its own loader, nested one level.
        let hina = find_dir(&dir, "莫斯科日奈换色版").expect("pnf sample");
        let pnf_root = find_dir_within(&hina, "PnFModsLoader.py")
            .or_else(|| Some(hina.clone()))
            .unwrap();
        let plan = classify_package(&pnf_root).unwrap();
        assert_eq!(plan.kind, ModKind::Skin);
        let report = mod_hub_install(
            pnf_root.to_string_lossy().into_owned(),
            game.to_string_lossy().into_owned(),
            plan,
        )
        .unwrap();
        assert!(
            report.wrote_files > 100,
            "pnf pack copied {} files",
            report.wrote_files
        );
        assert!(
            game.join("bin/12668706/res_mods/PnFMods/Hina_Moskva/Main.py")
                .is_file()
        );
        assert!(
            game.join("bin/12668706/res_mods/PnFModsLoader.py")
                .is_file()
        );
        assert!(
            game.join("bin/12668706/res_mods/content/gameplay").is_dir(),
            "texture overrides copied alongside"
        );

        fs::remove_dir_all(&game).ok();
    }

    fn find_dir(root: &Path, needle: &str) -> Option<PathBuf> {
        fs::read_dir(root)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().contains(needle))
                    .unwrap_or(false)
            })
    }

    /// Peel single-wrapper layers until the PNF payload is exposed.
    fn find_dir_within(root: &Path, marker: &str) -> Option<PathBuf> {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if dir.join(marker).is_file() {
                return Some(dir);
            }
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                }
            }
        }
        None
    }
}
