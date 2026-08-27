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

use wowsp_tauri_shared::{
    InstallReport, InstalledMod, ModKind, PackagePlan, PackagePlanEntry,
};

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

fn eq_ignore_case(a: impl AsRef<Path>, b: &str) -> bool {
    a.as_ref().to_string_lossy().eq_ignore_ascii_case(b)
}

/// Recursive file count for an entry display surface.
fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                n += 1;
            }
        }
    }
    n
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

/// Copy a subtree recursively, counting written files.
fn copy_tree(from: &Path, to: &Path) -> Result<usize, String> {
    if !from.is_dir() {
        return Err(format!("{} is not a directory", from.display()));
    }
    fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let mut count = 0usize;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        for ent in fs::read_dir(&src).map_err(|e| format!("read {}: {e}", src.display()))?.flatten() {
            let s = ent.path();
            let d = dst.join(ent.file_name());
            if s.is_dir() {
                fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
                stack.push((s, d));
            } else {
                fs::copy(&s, &d).map_err(|e| format!("copy {}: {e}", s.display()))?;
                count += 1;
            }
        }
    }
    Ok(count)
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
                if !root.path().is_dir() || !root.file_name().to_string_lossy().eq_ignore_ascii_case("mods") {
                    continue;
                }
                let Ok(banks) = fs::read_dir(root.path()) else { continue };
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
            let Ok(skins) = fs::read_dir(entry.path()) else { continue };
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
    mods.sort_by(|a, b| (a.kind as u8).cmp(&(b.kind as u8)).then(a.name.cmp(&b.name)));
    mods
}

// ── Classify incoming package ───────────────────────────────────────────────

const UNSUPPORTED_ARCHIVE: &str = "archive payloads need M10.2 unpack support — extract it to a folder first";

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
fn classify_package(src: &Path) -> Result<PackagePlan, String> {
    let entries_raw: Vec<String> = fs::read_dir(src)
        .map_err(|e| format!("read {}: {e}", src.display()))?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    let has = |name: &str| entries_raw.iter().any(|n| n.eq_ignore_ascii_case(name));

    // Bare audio pack: root AudioModification xml + loose .wem files.
    if has("mod.xml") && entries_raw.iter().any(|n| n.to_ascii_lowercase().ends_with(".wem")) {
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
        push_entry(&mut plan, &mut kinds_seen, "PnFMods", "PnFMods", ModKind::Skin);
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
        push_entry(&mut plan, &mut kinds_seen, "content", "content", ModKind::Textures);
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
    let src = Path::new(&source_root);
    if !src.is_dir() {
        return Err(format!("package not found: {}", src.display()));
    }
    let (bin_version, ver_dir) = latest_bin_version(&game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    let res_mods = ver_dir.join("res_mods");

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
        wrote += copy_tree(&from, &to)?;
        if entry.from_rel.eq_ignore_ascii_case("PnFMods") {
            touched_pnf = true;
        }
    }

    // PNF skin installs must leave the 0-byte loader marker behind.
    if touched_pnf {
        let loader = res_mods.join("PnFModsLoader.py");
        if !loader.is_file() {
            fs::write(&loader, "").map_err(|e| format!("touch loader: {e}"))?;
            if !warnings
                .iter()
                .any(|w| w.contains("PnFModsLoader"))
            {
                warnings.push("created missing PnFModsLoader.py".into());
            }
        }
    }

    tracing::info!(name = %plan.name, wrote, "mod_hub_install done");
    Ok(InstallReport {
        name: plan.name,
        bin_version,
        wrote_files: wrote,
        warnings,
    })
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
        fs::write(rm.join("banks/mods/Hoshino/mod.xml"), "<AudioModification><Name>Hoshino</Name></AudioModification>").unwrap();
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
        assert!(voices.iter().any(|m| m.detail.as_deref() == Some("Hoshino")));
        let skins: Vec<_> = mods.iter().filter(|m| m.kind == ModKind::Skin).collect();
        assert_eq!(skins[0].detail.as_deref(), Some("RSC110_Pr_66_Moskva"));
        assert!(mods.iter().any(|m| m.kind == ModKind::Gui));
        assert!(mods.iter().any(|m| m.kind == ModKind::Patch && m.rel_path == "ime_config.xml"));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn classifies_bare_voice_pack_and_wraps_it() {
        let tmp = std::env::temp_dir().join("wowsp_barepack_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("mod.xml"), "<AudioModification><Name>聖園ミカ</Name></AudioModification>").unwrap();
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
    fn install_copies_tree_and_creates_missing_loader() {
        let pkg = std::env::temp_dir().join("wowsp_inst_pkg");
        let game = std::env::temp_dir().join("wowsp_inst_game");
        let _ = fs::remove_dir_all(&pkg);
        let _ = fs::remove_dir_all(&game);
        fs::create_dir_all(pkg.join("PnFMods/Skin")).unwrap();
        touch(&pkg.join("PnFMods/Skin/Main.py"));
        fs::create_dir_all(game.join("bin/12668706")).unwrap();

        let plan = classify_package(&pkg).unwrap();
        let report =
            mod_hub_install(pkg.to_str().unwrap().into(), game.to_str().unwrap().into(), plan)
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
}
