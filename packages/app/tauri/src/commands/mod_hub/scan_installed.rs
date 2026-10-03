use super::installed_units::{classify_installed_root, display_file_name, existing_with_bak};
use super::texture_analysis::analyze_override_tree;
use super::*;

// ── Scan installed ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn mod_hub_scan_installed(game_root: String) -> Result<Vec<InstalledMod>, String> {
    let res_mods = scan_root(&game_root)?;
    if !res_mods.is_dir() {
        return Ok(Vec::new());
    }
    Ok(classify_installed_root(&res_mods))
}

/// Resolve `bin/<latest>/res_mods` for a game install.
pub(crate) fn scan_root(game_root: &str) -> Result<PathBuf, String> {
    let (_, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    Ok(ver_dir.join("res_mods"))
}

/// One `<mod name="…" version="…" installer="…"/>` row of Aslain's
/// `installed_mods.xml` (the modpack installer writes it at the res_mods
/// root). `span` covers the raw `<mod …` text up to (excluding) the `/>` so
/// rows can be cut out surgically when their unit is uninstalled.
struct ManifestEntry {
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) span: (usize, usize),
}

/// Tolerant reader for Aslain's `installed_mods.xml` — a flat
/// `<data><mod …/></data>` list. Attribute names match
/// ASCII-case-insensitively; rows without a `name` are skipped.
pub(crate) fn parse_installed_manifest(res_mods: &Path) -> Vec<ManifestEntry> {
    let Ok(body) = fs::read_to_string(res_mods.join("installed_mods.xml")) else {
        return Vec::new();
    };
    let lower = body.to_ascii_lowercase();
    let mut entries = Vec::new();
    let mut cursor = 0usize;
    while let Some(at) = lower[cursor..].find("<mod") {
        let start = cursor + at;
        // `<mod` must be its own element name, not a prefix (`<mods …`).
        let next = lower[start + 4..].chars().next();
        if !next.is_none_or(|c| c.is_ascii_whitespace() || c == '/' || c == '>') {
            cursor = start + 4;
            continue;
        }
        let Some(gt) = lower[start..].find('>') else {
            break;
        };
        let tag_end = start + gt; // index of the closing '>'
        if gt >= 2 && &lower[tag_end - 1..tag_end] == "/" {
            let tag = &body[start..tag_end - 1];
            // The removal span covers the whole `<mod … />` element so
            // cutting a row leaves no stray `/>` behind.
            if let Some(name) = tag_attr(tag, "name").filter(|n| !n.is_empty()) {
                entries.push(ManifestEntry {
                    name,
                    version: tag_attr(tag, "version"),
                    span: (start, tag_end + 1),
                });
            }
        }
        cursor = tag_end + 1;
    }
    entries
}

/// Pull `key="value"` out of one raw tag body (attribute names
/// ASCII-case-insensitive, quote-aware so values may contain spaces,
/// basic XML entities unescaped).
fn tag_attr(tag: &str, key: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let k = &tag[key_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let (raw, next) = if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
            let quote = bytes[i];
            i += 1;
            let value_start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            (&tag[value_start..i], i + 1)
        } else {
            let value_start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            (&tag[value_start..i], i)
        };
        if k.eq_ignore_ascii_case(key) {
            return Some(xml_unescape(raw));
        }
        i = next;
    }
    None
}

fn xml_unescape(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// A filesystem grouping candidate: disjoint res_mods-relative roots that
/// layout heuristics treat as one plugin, before any manifest name is
/// attached.
pub(crate) struct UnitCandidate {
    pub(crate) kind: ModKind,
    pub(crate) name: String,
    pub(crate) detail: Option<String>,
    /// Structured content breakdown for texture-override units.
    pub(crate) analysis: Option<TextureAnalysis>,
    /// res_mods-relative roots — directories or single files (files may be
    /// physical `.bak` twins when the unit is disabled).
    pub(crate) paths: Vec<String>,
}

/// Everything recognizable under the res_mods root as disjoint candidate
/// units. Layout facts come from a live Aslain 4.x install:
/// - `banks/<mods-case>/<bank>/mod.xml` — voice banks, `.bak`-tolerant
/// - `PnFMods/<dir>/Main.py` — skins register a ship; PnF dirs without a
///   `registerShipMod` call are script mods
/// - `gui/unbound2/<mod>/` — one Unbound UI mod per grandchild directory;
///   other `gui/<child>` dirs group one unit per child, loose files under
///   `gui/` group into a single unit
/// - top-level `*.xml` files are config patches (`installed_mods.xml` and
///   `PnFModsLoader.py` are markers, never units)
/// - any other top-level directory is a texture-override catch-all
pub(crate) fn gather_candidates(res_mods: &Path) -> Vec<UnitCandidate> {
    let mut cands = Vec::new();
    let Ok(top) = fs::read_dir(res_mods) else {
        return cands;
    };
    for entry in top.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let lower = name.to_ascii_lowercase();

        if lower == "pnfmodsloader.py" || lower == "installed_mods.xml" {
            continue; // markers, not content
        }

        if lower == "banks" && path.is_dir() {
            cands.extend(bank_candidates(&path));
            continue;
        }
        if lower == "pnfmods" && path.is_dir() {
            cands.extend(pnf_candidates(&path));
            continue;
        }
        if lower == "gui" && path.is_dir() {
            cands.extend(gui_candidates(&path));
            continue;
        }
        if path.is_file() && (lower.ends_with(".xml") || lower.ends_with(".xml.bak")) {
            cands.push(UnitCandidate {
                kind: ModKind::Patch,
                name: display_file_name(&name),
                detail: None,
                analysis: None,
                paths: vec![name],
            });
            continue;
        }
        if path.is_dir() {
            cands.push(UnitCandidate {
                kind: ModKind::Textures,
                name: name.clone(),
                detail: None,
                analysis: analyze_override_tree(&path, Some(&name)),
                paths: vec![name],
            });
        }
    }
    cands.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    cands
}

/// Voice banks: `banks/<any-case mods>/<bank>/mod.xml`. Real packs ship both
/// `mods` and `Mods`; Windows folds case variants into one physical
/// directory, so walk the actual children instead of probing spellings.
fn bank_candidates(banks: &Path) -> Vec<UnitCandidate> {
    let mut out = Vec::new();
    let Ok(roots) = fs::read_dir(banks) else {
        return out;
    };
    for root in roots.flatten() {
        if !root.path().is_dir()
            || !root
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("mods")
        {
            continue;
        }
        let Ok(list) = fs::read_dir(root.path()) else {
            continue;
        };
        for bank in list.flatten() {
            if !bank.path().is_dir() {
                continue;
            }
            let (xml, _) = existing_with_bak(&bank.path(), "mod.xml");
            let Some(xml_path) = xml else { continue };
            let detail = fs::read_to_string(xml_path)
                .ok()
                .and_then(|body| first_xml_tag(&body, "Name"));
            let name = bank.file_name().to_string_lossy().into_owned();
            out.push(UnitCandidate {
                kind: ModKind::Voice,
                name,
                detail,
                analysis: None,
                paths: vec![format!(
                    "banks/{}/{}",
                    root.file_name().to_string_lossy(),
                    bank.file_name().to_string_lossy()
                )],
            });
        }
    }
    out
}

/// PnF payload directories: skins register a ship id in `Main.py`, the rest
/// of the PnF ecosystem (gameplay scripts, UI helpers) does not.
fn pnf_candidates(pnf: &Path) -> Vec<UnitCandidate> {
    let mut out = Vec::new();
    let Ok(list) = fs::read_dir(pnf) else {
        return out;
    };
    for dir in list.flatten() {
        if !dir.path().is_dir() {
            continue;
        }
        let Some(main_py) = find_pnf_main(&dir.path()) else {
            continue;
        };
        let body = fs::read(&main_py).unwrap_or_default();
        let detail = registered_ship_id_bytes(&body);
        let name = dir.file_name().to_string_lossy().into_owned();
        out.push(UnitCandidate {
            kind: if detail.is_some() {
                ModKind::Skin
            } else {
                ModKind::Script
            },
            name,
            detail,
            analysis: None,
            paths: vec![format!("PnFMods/{}", dir.file_name().to_string_lossy())],
        });
    }
    out
}

/// HUD groups: `gui/unbound2/<mod>/` hosts one Unbound UI mod per child
/// directory; every other `gui/<child>` directory is its own unit; loose
/// files dropped straight under `gui/` share one catch-all unit.
fn gui_candidates(gui: &Path) -> Vec<UnitCandidate> {
    let mut out = Vec::new();
    let mut loose: Vec<String> = Vec::new();
    let Ok(list) = fs::read_dir(gui) else {
        return out;
    };
    for child in list.flatten() {
        let name = child.file_name().to_string_lossy().into_owned();
        let path = child.path();
        if !path.is_dir() {
            loose.push(format!("gui/{name}"));
            continue;
        }
        let unbound = name.eq_ignore_ascii_case("unbound") || name.eq_ignore_ascii_case("unbound2");
        if unbound {
            let Ok(mods) = fs::read_dir(&path) else {
                continue;
            };
            for sub in mods.flatten() {
                if !sub.path().is_dir() {
                    continue;
                }
                let sub_name = sub.file_name().to_string_lossy().into_owned();
                out.push(UnitCandidate {
                    kind: ModKind::Gui,
                    name: sub_name,
                    detail: None,
                    analysis: None,
                    paths: vec![format!("gui/{name}/{}", sub.file_name().to_string_lossy())],
                });
            }
            continue;
        }
        out.push(UnitCandidate {
            kind: ModKind::Gui,
            name,
            detail: None,
            analysis: None,
            paths: vec![format!("gui/{}", child.file_name().to_string_lossy())],
        });
    }
    if !loose.is_empty() {
        loose.sort();
        out.push(UnitCandidate {
            kind: ModKind::Gui,
            name: "gui".into(),
            detail: None,
            analysis: None,
            paths: loose,
        });
    }
    out
}
