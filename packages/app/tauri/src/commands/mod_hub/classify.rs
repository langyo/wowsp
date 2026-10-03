use super::texture_analysis::analyze_override_tree;
use super::*;

// ── Classify incoming package ───────────────────────────────────────────────

pub(crate) const UNSUPPORTED_ARCHIVE: &str =
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
                if plan.texture_analysis.is_none() {
                    plan.texture_analysis = candidate.texture_analysis;
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
            texture_analysis: None,
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
        texture_analysis: None,
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
        // Parse every skin's entry script for the ship ids + remember
        // names/details (accepts Main.py and compiled Main.pyc).
        let pnf = src.join("PnFMods");
        if let Ok(skins) = fs::read_dir(&pnf) {
            let mut details: Vec<String> = Vec::new();
            for skin in skins.flatten() {
                if let Some(main_py) = find_pnf_main(&skin.path()) {
                    if let Ok(body) = fs::read(&main_py) {
                        if let Some(id) = registered_ship_id_bytes(&body) {
                            details.push(id);
                        }
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
    // The other override signature roots the installed-scan treats as
    // texture-override catch-alls (real Aslain installs ship these tops).
    for top in ["particles", "spaces", "texts", "system", "camouflage"] {
        if has(top) {
            push_entry(&mut plan, &mut kinds_seen, top, top, ModKind::Textures);
        }
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

    // Override trees (standalone or shipped alongside a PnF skin) get the
    // same structured breakdown the installed list shows.
    if plan.kind == ModKind::Textures || plan.entries.iter().any(|e| is_override_top(&e.to_rel)) {
        plan.texture_analysis = analyze_override_tree(src, None);
    }
    Ok(plan)
}

/// Does a plan destination name an override top-level folder (the
/// texture-override signature roots outside `gui/` / `PnFMods/` / `banks/`)?
fn is_override_top(to_rel: &str) -> bool {
    matches!(
        to_rel
            .trim_end_matches('/')
            .split('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "content" | "particles" | "spaces" | "texts" | "system" | "camouflage"
    )
}

/// Filesystem-safe folder slug for auto-wrapped bank names.
pub(crate) fn sanitize_dir_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}
