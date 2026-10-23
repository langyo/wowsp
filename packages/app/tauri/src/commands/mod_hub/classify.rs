//! Local package classification (audit H-3 closure).
//!
//! Every source-directory enumeration here is a trust boundary. The picker
//! grant (`pick_source`) anchors WHICH folder may be read; the entries below
//! that folder are inspected WITHOUT following links, so a link-shaped
//! reparse point (symlink/junction) cannot impersonate a layout signature the
//! user never previewed — cloud placeholders pass, since their bytes hydrate
//! on read. The install copy enforces the same tag rule again while walking
//! nested trees — see `ensure_plain_source_entry` in the parent module.

use anyhow::anyhow;
use wowsp_tauri_shared::CommandResult;

use super::texture_analysis::analyze_override_tree;
use super::*;

// ── Classify incoming package ───────────────────────────────────────────────

pub(crate) const UNSUPPORTED_ARCHIVE: &str =
    "archive payloads need M10.2 unpack support — extract it to a folder first";

#[tauri::command]
pub fn mod_hub_classify_path(source_path: String) -> CommandResult<PackagePlan> {
    // Audit H-3 closure: classify walks and parses an arbitrary
    // directory it is handed — without the picker grant it doubles as a
    // structure-enumeration oracle for a compromised webview. The webui
    // only ever classifies paths the picker just returned.
    super::pick_source::ensure_source_granted(&source_path)?;
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
            "zip" | "7z" => anyhow::Error::msg(UNSUPPORTED_ARCHIVE),
            _ => anyhow!("unsupported package file: {}", src.display()),
        }
        .into());
    }
    if !src.is_dir() {
        return Err(anyhow!("package not found: {}", src.display()).into());
    }

    let plan = classify_package(src)?;
    if plan.entries.is_empty() {
        return Err(anyhow!(
            "no recognizable mod structure in {} (see docs/designs/mod-formats.md)",
            src.display()
        )
        .into());
    }
    Ok(plan)
}

/// Classify the contents of an unpacked package directory.
pub(crate) fn classify_package(src: &Path) -> anyhow::Result<PackagePlan> {
    let mut plan = classify_package_layout(src)?;

    // Real-world packs often ship behind a single naming-wrapper folder
    // (<系列名>/<本体>/{PnFMods,content,…}, e.g. 莫斯科日奈换色版). When the
    // top level has no signatures but exactly one child directory carries
    // them, re-derive the plan one layer down and shift `fromRel` inward —
    // installs then read payloads relative to the wrapper.
    if plan.entries.is_empty() {
        if let Some(wrapper) = single_wrapper_dir(src)? {
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

/// Read one package directory, refusing link-shaped reparse entries before they
/// can be treated as layout signatures. The picked folder is untrusted input: a
/// link entry must abort classification instead of redirecting the preview (and
/// later the copy) outside the tree the user chose; cloud placeholders pass
fn read_plain_entries(dir: &Path) -> anyhow::Result<Vec<fs::DirEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)
        .map_err(|e| anyhow!("read {}: {e}", dir.display()))?
        .flatten()
    {
        super::ensure_plain_source_entry(&entry.path())?;
        entries.push(entry);
    }
    Ok(entries)
}

/// The only content of `src` is one subdirectory (ignoring explorer noise) —
/// its name is a candidate wrapper layer. Link-checked first: the wrapper is
/// followed by the install copy, so a reparse point must not be allowed to
/// impersonate a plain wrapper folder.
fn single_wrapper_dir(src: &Path) -> anyhow::Result<Option<String>> {
    let mut dirs = Vec::new();
    for e in fs::read_dir(src)
        .map_err(|e| anyhow!("read {}: {e}", src.display()))?
        .flatten()
    {
        super::ensure_plain_source_entry(&e.path())?;
        let name = e.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if lower == "desktop.ini" || lower == "thumbs.db" || lower.ends_with(".txt") {
            continue;
        }
        if !e.path().is_dir() {
            return Ok(None);
        }
        dirs.push(name);
    }
    Ok(if dirs.len() == 1 { dirs.pop() } else { None })
}

/// Signature-level classification of one directory layout (no wrapper peel).
fn classify_package_layout(src: &Path) -> anyhow::Result<PackagePlan> {
    let entries_raw: Vec<String> = read_plain_entries(src)?
        .into_iter()
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
                super::ensure_plain_source_entry(&skin.path())?;
                if let Some(main_py) = find_pnf_main(&skin.path()) {
                    // The entry script is read for its ship id — never via
                    // a link that points outside the picked package.
                    super::ensure_plain_source_entry(&main_py)?;
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

/// Every real file the plan would install, named by its installed location
/// (`<to_rel>/<file>` relative to `res_mods`). The catalog's file-list
/// window renders these — plan entries are install TARGETS (folders), so
/// enumerating them directly would show a single directory name instead of
/// the payload underneath.
///
/// Entries pass the same no-follow guard the install copy applies
/// ([`super::ensure_plain_source_entry`]): a link-shaped reparse point aborts
/// the preview with the offending entry named instead of listing a target
/// outside the picked tree; cloud placeholders still pass and hydrate.
pub(crate) fn collect_plan_files(src: &Path, plan: &PackagePlan) -> anyhow::Result<Vec<String>> {
    let mut files = Vec::new();
    for entry in &plan.entries {
        let base = if entry.from_rel == "." {
            src.to_path_buf()
        } else {
            src.join(&entry.from_rel)
        };
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(read) = fs::read_dir(&dir) else {
                continue;
            };
            for e in read.flatten() {
                let path = e.path();
                super::ensure_plain_source_entry(&path)?;
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let rel = path
                        .strip_prefix(&base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    files.push(format!("{}/{}", entry.to_rel.trim_end_matches('/'), rel));
                }
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
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
