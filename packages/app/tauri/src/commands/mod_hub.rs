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

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use wowsp_tauri_shared::{
    InstallReport, InstalledMod, ModInstallRecord, ModKind, PackagePlan, PackagePlanEntry,
    TextureAnalysis, TextureFileKind, UnitToggleReport,
};

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

/// Pull `registerShipMod('<arg>')` out of a PnF `Main.py`. Byte-level so it
/// also works on compiled `Main.pyc` payloads — real Aslain packs ship
/// bytecode, and the marshal format keeps string constants as plain bytes.
fn registered_ship_id_bytes(body: &[u8]) -> Option<String> {
    let needle = b"registerShipMod";
    let at = body.windows(needle.len()).position(|w| w == needle)?;
    let rest = &body[at + needle.len()..];
    let quote = *rest.iter().find(|b| **b == b'\'' || **b == b'"')?;
    let rest = &rest[rest.iter().position(|b| *b == quote)? + 1..];
    let end = rest.iter().position(|b| *b == quote)?;
    let id = &rest[..end];
    if id.is_ascii() {
        Some(String::from_utf8_lossy(id).trim().to_string())
    } else {
        None
    }
}

/// The PnF entry script, under any real-world spelling: `Main.py`,
/// compiled `Main.pyc`, either with a `.bak` twin when disabled.
fn find_pnf_main(dir: &Path) -> Option<PathBuf> {
    for name in ["Main.py", "Main.pyc"] {
        if let (Some(path), _) = existing_with_bak(dir, name) {
            return Some(path);
        }
    }
    None
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
    let res_mods = scan_root(&game_root)?;
    if !res_mods.is_dir() {
        return Ok(Vec::new());
    }
    Ok(classify_installed_root(&res_mods))
}

/// Resolve `bin/<latest>/res_mods` for a game install.
fn scan_root(game_root: &str) -> Result<PathBuf, String> {
    let (_, ver_dir) = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    Ok(ver_dir.join("res_mods"))
}

/// One `<mod name="…" version="…" installer="…"/>` row of Aslain's
/// `installed_mods.xml` (the modpack installer writes it at the res_mods
/// root). `span` covers the raw `<mod …` text up to (excluding) the `/>` so
/// rows can be cut out surgically when their unit is uninstalled.
struct ManifestEntry {
    name: String,
    version: Option<String>,
    span: (usize, usize),
}

/// Tolerant reader for Aslain's `installed_mods.xml` — a flat
/// `<data><mod …/></data>` list. Attribute names match
/// ASCII-case-insensitively; rows without a `name` are skipped.
fn parse_installed_manifest(res_mods: &Path) -> Vec<ManifestEntry> {
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
struct UnitCandidate {
    kind: ModKind,
    name: String,
    detail: Option<String>,
    /// Structured content breakdown for texture-override units.
    analysis: Option<TextureAnalysis>,
    /// res_mods-relative roots — directories or single files (files may be
    /// physical `.bak` twins when the unit is disabled).
    paths: Vec<String>,
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
fn gather_candidates(res_mods: &Path) -> Vec<UnitCandidate> {
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

// ── Texture-override content analysis ───────────────────────────────────────

/// Upper bound on files inspected per override tree — keeps the best-effort
/// analysis fast on mega-pack trees (integration installs reach tens of
/// thousands of files).
const ANALYSIS_FILE_BUDGET: u64 = 20_000;
/// Directory depth beyond which the walk stops digging.
const ANALYSIS_DEPTH_LIMIT: usize = 16;
/// Collected ship-unit names per tree — enough for display.
const ANALYSIS_SHIP_CAP: usize = 24;

/// `_`-segments that END the readable ship-unit name of a texture file name:
/// `JSB039_Yamato_1945_Hull_a` stops at `Hull`, leaving `JSB039 Yamato 1945`.
const COMPONENT_WORDS: &[&str] = &[
    "hull",
    "hulls",
    "gun",
    "guns",
    "turret",
    "turrets",
    "superstructure",
    "torpedo",
    "plane",
    "planes",
    "float",
    "floats",
    "modern",
    "scope",
    "radar",
    "searchlight",
    "propeller",
    "rudder",
    "fire",
    "smoke",
    "water",
    "wake",
    "flag",
    "flags",
    "pendant",
    "camouflage",
    "mast",
    "deck",
    "bridge",
    "launcher",
    "trunk",
    "ammo",
    "tower",
    "antenna",
    "crane",
    "catapult",
    "damaged",
    "wreck",
    "geometry",
    "visual",
    "model",
    "texture",
    "textures",
];

/// Folder names at the species level that are asset-type dirs, not ship or
/// component classes (`content/gameplay/<nation>/textures/…` skips the
/// species level entirely) — never recorded as species.
const ASSET_DIRS: &[&str] = &[
    "textures", "texture", "model", "models", "visual", "visuals", "geometry", "sounds", "sound",
];

/// A path segment that names a folder, not a stray file (`foo.dds` directly
/// under `spaces/` or `content/gameplay/<nation>/` must not pollute the
/// collected names).
fn dir_like(seg: &str) -> bool {
    !seg.contains('.')
}

/// Best-effort breakdown of what an override tree actually covers, so a unit
/// can say more than its bare top folder name (`content`, `particles`, …).
/// `top_name` is the res_mods-relative top folder of an installed unit
/// (`Some("content")` — paths below it start one level in); package analysis
/// passes `None` because walked paths already start at the top folders.
/// Returns `None` for a tree without files.
///
/// Path conventions mirror the game's content layout (mod-formats.md,
/// wowsunpack's export/texture.rs): `content/gameplay/<nation>/ship/<class>/…`
/// for ship & component textures, `content/unlocks/<nation>/…` for permanent
/// camouflages, `spaces/<map>/…` for scene overrides. Ship identity comes
/// from the texture file names — `JSB039_Yamato_1945_Hull_a.dds` carries the
/// unit code `JSB039` plus its readable name.
fn analyze_override_tree(root: &Path, top_name: Option<&str>) -> Option<TextureAnalysis> {
    let mut file_count = 0u64;
    let mut truncated = false;
    let mut exts: BTreeMap<String, u64> = BTreeMap::new();
    let mut cats: BTreeSet<String> = BTreeSet::new();
    let mut nations: BTreeSet<String> = BTreeSet::new();
    let mut species: BTreeSet<String> = BTreeSet::new();
    let mut ships: BTreeMap<String, String> = BTreeMap::new();
    let mut space_names: BTreeSet<String> = BTreeSet::new();

    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    'walk: while let Some((dir, depth)) = stack.pop() {
        if depth > ANALYSIS_DEPTH_LIMIT {
            // Files deeper than the limit exist but stay uncounted.
            truncated = true;
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if file_count >= ANALYSIS_FILE_BUDGET {
                truncated = true;
                break 'walk;
            }
            file_count += 1;

            // `.bak` twins of disabled units are toggle state, not content.
            let raw_name = ent.file_name().to_string_lossy().into_owned();
            let bare = raw_name.strip_suffix(".bak").unwrap_or(&raw_name);
            let ext = Path::new(bare)
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_else(|| "none".into());
            *exts.entry(ext).or_default() += 1;

            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let mut segs: Vec<String> = top_name.map(|t| vec![t.to_string()]).unwrap_or_default();
            segs.extend(
                rel.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned()),
            );
            let lower: Vec<String> = segs.iter().map(|s| s.to_ascii_lowercase()).collect();

            let category = match lower.first().map(String::as_str) {
                Some("particles") => Some("particles"),
                Some("spaces") => {
                    if let Some(space) = segs.get(1).filter(|s| dir_like(s)) {
                        space_names.insert(space.clone());
                    }
                    Some("spaces")
                },
                Some("texts") => Some("texts"),
                Some("system") => Some("system"),
                Some("camouflage") => Some("camouflage"),
                Some("content") => match lower.get(1).map(String::as_str) {
                    Some("gameplay") => {
                        if let Some(nation) = lower.get(2).filter(|n| dir_like(n)) {
                            nations.insert(nation.clone());
                        }
                        match lower.get(3).map(String::as_str) {
                            // ship/<class>/… — the class says far more than "ship".
                            Some("ship") => {
                                let sp = lower
                                    .get(4)
                                    .filter(|s| dir_like(s))
                                    .cloned()
                                    .unwrap_or_else(|| "ship".into());
                                if !ASSET_DIRS.contains(&sp.as_str()) {
                                    species.insert(sp);
                                }
                            },
                            Some(sp) if !ASSET_DIRS.contains(&sp) && dir_like(sp) => {
                                species.insert(sp.to_string());
                            },
                            // `None` and asset-type dirs (textures/, model/, …)
                            // carry no species level.
                            _ => {},
                        }
                        Some("gameplay")
                    },
                    Some("unlocks") => {
                        if let Some(nation) = lower.get(2).filter(|n| dir_like(n)) {
                            nations.insert(nation.clone());
                        }
                        Some("unlocks")
                    },
                    _ => Some("content"),
                },
                _ => None,
            };
            if let Some(cat) = category {
                cats.insert(cat.to_string());
            }

            if category == Some("gameplay") && ships.len() < ANALYSIS_SHIP_CAP {
                if let Some(stem) = Path::new(bare).file_stem().and_then(|s| s.to_str()) {
                    if let Some((code, display)) = ship_unit_name(stem) {
                        ships.entry(code).or_insert(display);
                    }
                }
            }
        }
    }

    if file_count == 0 {
        return None;
    }
    let mut file_kinds: Vec<TextureFileKind> = exts
        .into_iter()
        .map(|(ext, count)| TextureFileKind { ext, count })
        .collect();
    file_kinds.sort_by(|a, b| b.count.cmp(&a.count).then(a.ext.cmp(&b.ext)));
    file_kinds.truncate(10);

    Some(TextureAnalysis {
        file_count,
        file_kinds,
        categories: cats.into_iter().collect(),
        nations: nations.into_iter().take(16).collect(),
        species: species.into_iter().take(16).collect(),
        ships: ships.into_values().take(ANALYSIS_SHIP_CAP).collect(),
        space_names: space_names.into_iter().take(12).collect(),
        truncated,
    })
}

/// `JSB039_Yamato_1945_Hull_a` → (`JSB039`, `JSB039 Yamato 1945`): the first
/// `_`-segment is a unit code (2–6 capitals + 2–4 digits, e.g. `PJSB011`),
/// the readable name runs until a component word or the length cap. Returns
/// `None` when the stem carries no code (`default_ao`, `wake_01`, …).
fn ship_unit_name(stem: &str) -> Option<(String, String)> {
    let mut segs = stem.split('_');
    let code = segs.next()?;
    let letters = code.chars().take_while(|c| c.is_ascii_uppercase()).count();
    let digits = code[letters..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if !(2..=6).contains(&letters) || !(2..=4).contains(&digits) || letters + digits != code.len() {
        return None;
    }
    let mut display = vec![code.to_string()];
    for seg in segs {
        if seg.is_empty() {
            continue;
        }
        if COMPONENT_WORDS.contains(&seg.to_ascii_lowercase().as_str()) || display.len() > 4 {
            break;
        }
        display.push(seg.to_string());
    }
    Some((code.to_string(), display.join(" ")))
}

/// Classify one installed res_mods root into typed plugin units. When
/// Aslain's `installed_mods.xml` manifest exists, its rows are the
/// authoritative plugin list: filesystem groups attach to rows by name
/// similarity, leftover groups stay standalone, and rows with no matched
/// files become manifest-only rows so the list still mirrors the installer.
fn classify_installed_root(res_mods: &Path) -> Vec<InstalledMod> {
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
        });
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
fn existing_with_bak(dir: &Path, file: &str) -> (Option<PathBuf>, bool) {
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
fn display_file_name(name: &str) -> String {
    name.strip_suffix(".bak").unwrap_or(name).to_string()
}

/// Every file a unit root covers: the root itself when it is a file,
/// otherwise its recursive contents.
fn unit_files(res_mods: &Path, rel: &str) -> Vec<PathBuf> {
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
fn unit_covers(paths: &[String], file_rel: &str) -> bool {
    let bare = file_rel.strip_suffix(".bak").unwrap_or(file_rel);
    paths.iter().any(|p| {
        let p_bare = p.strip_suffix(".bak").unwrap_or(p);
        bare == p_bare
            || bare.starts_with(&format!("{p_bare}/"))
            || file_rel.starts_with(&format!("{p}/"))
    })
}

// ── Unit enable / uninstall ─────────────────────────────────────────────────

#[tauri::command]
pub async fn mod_hub_set_unit_enabled(
    game_root: String,
    rel_path: String,
    enabled: bool,
) -> Result<UnitToggleReport, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    let res_mods = scan_root(&game_root)?;
    if !res_mods.is_dir() {
        return Err("res_mods directory not found".into());
    }
    let unit = classify_installed_root(&res_mods)
        .into_iter()
        .find(|u| u.rel_path == rel_path)
        .ok_or_else(|| format!("no installed plugin at {rel_path}"))?;
    if unit.paths.is_empty() {
        return Err(format!("{rel_path} has no files to toggle"));
    }
    let renamed = set_paths_state(&res_mods, &unit.paths, enabled)?;
    tracing::info!(rel = %rel_path, enabled, renamed, "mod_hub_set_unit_enabled done");
    Ok(UnitToggleReport {
        rel_path,
        disabled: !enabled,
        renamed_files: renamed,
    })
}

/// Rename every file of a unit between live names and `.bak` twins
/// (disabling appends the suffix, enabling strips it). Existing targets are
/// skipped, never clobbered; a partially-applied state heals on the next
/// toggle in the same direction. Returns how many files moved.
fn set_paths_state(res_mods: &Path, paths: &[String], enabled: bool) -> Result<usize, String> {
    let mut renamed = 0usize;
    for rel in paths {
        for file in unit_files(res_mods, rel) {
            let Some(name) = file.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            let target = if enabled {
                if !name.ends_with(".bak") {
                    continue;
                }
                file.with_file_name(&name[..name.len() - 4])
            } else {
                if name.ends_with(".bak") {
                    continue;
                }
                file.with_file_name(format!("{name}.bak"))
            };
            if target.exists() {
                continue;
            }
            fs::rename(&file, &target).map_err(|e| format!("rename {}: {e}", file.display()))?;
            renamed += 1;
        }
    }
    Ok(renamed)
}

#[tauri::command]
pub async fn mod_hub_uninstall_unit(
    game_root: String,
    rel_path: String,
) -> Result<super::mod_catalog::UninstallReport, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    let res_mods = scan_root(&game_root)?;
    if !res_mods.is_dir() {
        return Err("res_mods directory not found".into());
    }
    let unit = classify_installed_root(&res_mods)
        .into_iter()
        .find(|u| u.rel_path == rel_path)
        .ok_or_else(|| format!("no installed plugin at {rel_path}"))?;

    let mut ledger = super::mod_catalog::load_ledger();
    let report = uninstall_unit_core(&game_root, &res_mods, &unit, &mut ledger.installs)?;
    super::mod_catalog::save_ledger(&ledger)?;
    Ok(report)
}

/// Everything [`mod_hub_uninstall_unit`] does once the unit is resolved —
/// split out so tests can drive it against an in-memory record list instead
/// of the real ledger. Deletes the unit's files directly FIRST, then lets
/// the ledger records restore their vanilla snapshots (whose targets may
/// well be paths this unit had overwritten — deleting first means the
/// restore actually lands instead of being wiped by the tree removal),
/// prunes emptied parents and syncs Aslain's manifest when the unit came
/// from it.
fn uninstall_unit_core(
    game_root: &str,
    res_mods: &Path,
    unit: &InstalledMod,
    installs: &mut Vec<ModInstallRecord>,
) -> Result<super::mod_catalog::UninstallReport, String> {
    let mut removed = 0usize;
    let mut restored = 0usize;

    // Everything the ledger did not know about goes away directly — live
    // paths and their `.bak` twins alike. Ledger-covered files are also
    // removed here; the ledger pass below tolerates already-missing files
    // and only counts what it still finds.
    if !unit.paths.is_empty() {
        for rel in &unit.paths {
            let path = res_mods.join(rel);
            let twin = if rel.ends_with(".bak") {
                res_mods.join(&rel[..rel.len() - 4])
            } else {
                res_mods.join(format!("{rel}.bak"))
            };
            if path.is_dir() {
                removed += unit_files(res_mods, rel).len();
                fs::remove_dir_all(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
            } else if path.is_file() {
                fs::remove_file(&path).ok();
                removed += 1;
            }
            if twin.is_file() {
                fs::remove_file(&twin).ok();
                removed += 1;
            }
        }
        prune_empty_parents(res_mods, &unit.paths);
    }

    // Ledger records overlapping the unit get the full treatment: restore
    // the vanilla files they snapshotted, then drop the record.
    let ids: Vec<String> = installs
        .iter()
        .filter(|r| {
            r.files
                .iter()
                .any(|f| !f.starts_with("@game/") && unit_covers(&unit.paths, f))
        })
        .map(|r| r.id.clone())
        .collect();
    for id in &ids {
        let report = super::mod_catalog::uninstall_from_ledger(installs, id, game_root)?;
        removed += report.removed_files;
        restored += report.restored_files;
    }

    // Keep Aslain's manifest describing reality when the unit came from it.
    if unit.version.is_some() {
        remove_manifest_entry(res_mods, &unit.name);
    }

    tracing::info!(rel = %unit.rel_path, removed, restored, "uninstall_unit_core done");
    Ok(super::mod_catalog::UninstallReport {
        id: unit.rel_path.clone(),
        name: unit.name.clone(),
        removed_files: removed,
        restored_files: restored,
    })
}

/// Remove directories a unit emptied, walking each root's parents up to (and
/// excluding) the res_mods root itself. `remove_dir` only succeeds on empty
/// directories, so shared parents with other units survive.
fn prune_empty_parents(res_mods: &Path, paths: &[String]) {
    for rel in paths {
        let mut dir = res_mods.join(rel).parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            if d == res_mods || !d.starts_with(res_mods) {
                break;
            }
            if fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
}

/// Drop one `<mod name="…"/>` row from Aslain's manifest after its unit was
/// uninstalled. Best effort: a failed rewrite leaves the manifest untouched.
fn remove_manifest_entry(res_mods: &Path, name: &str) {
    let path = res_mods.join("installed_mods.xml");
    let Ok(body) = fs::read_to_string(&path) else {
        return;
    };
    let spans: Vec<(usize, usize)> = parse_installed_manifest(res_mods)
        .into_iter()
        .filter(|e| e.name == name)
        .map(|e| e.span)
        .collect();
    if spans.is_empty() {
        return;
    }
    let mut out = String::with_capacity(body.len());
    let mut cursor = 0usize;
    for (start, end) in spans {
        if start < cursor {
            continue;
        }
        out.push_str(&body[cursor..start]);
        cursor = end;
    }
    out.push_str(&body[cursor..]);
    fs::write(&path, out).ok();
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
pub async fn mod_hub_install(
    source_root: String,
    game_root: String,
    plan: PackagePlan,
) -> Result<InstallReport, String> {
    // Same gate as the catalog install: the plan's copy must not interleave
    // with another install's res_mods writes or a `.bak` rename sweep.
    let _gate = super::mod_catalog::mod_hub_gate().await;
    tauri::async_runtime::spawn_blocking(move || {
        install_plan(Path::new(&source_root), &game_root, &plan).map(|applied| applied.report)
    })
    .await
    .map_err(|e| format!("install task: {e}"))?
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
    fn scan_anchors_units_on_installed_mods_manifest() {
        let tmp = std::env::temp_dir().join("wowsp_manifest_scan");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("bin/13187581/res_mods");
        fs::create_dir_all(&rm).unwrap();
        fs::write(
            rm.join("installed_mods.xml"),
            "<?xml version=\"1.0\" ?>\n<data>\n\t<mod installer=\"4.3.1\" name=\"SmokeMarker\" version=\"1.4.0\"/>\n\t<mod installer=\"4.3.1\" name=\"BattleFrame_TorpedoDetection\" version=\"1.0\"/>\n\t<mod installer=\"4.3.1\" name=\"Intuitions\" version=\"1.0.0\"/>\n\t<mod installer=\"4.3.1\" name=\"GhostOnly\" version=\"9.9\"/>\n</data>\n",
        )
        .unwrap();
        // PnF script mod claimed by SmokeMarker through the `Py` convention.
        touch(&rm.join("PnFMods/SmokeMarkerPy/Main.py"));
        fs::write(rm.join("PnFMods/SmokeMarkerPy/Main.py"), "print('no ship')").unwrap();
        // Unbound UI group claimed by the BattleFrame row via shared prefix.
        touch(&rm.join("gui/unbound2/!battleframe/label.xml"));
        // Exact-name PnF skin.
        touch(&rm.join("PnFMods/Intuitions/Main.py"));
        fs::write(
            rm.join("PnFMods/Intuitions/Main.py"),
            "contentSdk.registerShipMod('RSC110')",
        )
        .unwrap();
        touch(&rm.join("PnFModsLoader.py"));
        // Leftover voice bank stays standalone.
        touch(&rm.join("banks/mods/Hoshino/mod.xml"));

        let mods = classify_installed_root(&rm);
        let smoke = mods.iter().find(|m| m.name == "SmokeMarker").unwrap();
        assert_eq!(smoke.version.as_deref(), Some("1.4.0"));
        assert_eq!(smoke.kind, ModKind::Script);
        assert!(
            smoke.paths.contains(&"PnFMods/SmokeMarkerPy".to_string()),
            "{:?}",
            smoke.paths
        );
        let bf = mods
            .iter()
            .find(|m| m.name == "BattleFrame_TorpedoDetection")
            .unwrap();
        assert!(
            bf.paths.contains(&"gui/unbound2/!battleframe".to_string()),
            "{:?}",
            bf.paths
        );
        assert!(!bf.paths.contains(&"PnFMods/SmokeMarkerPy".to_string()));
        let intu = mods.iter().find(|m| m.name == "Intuitions").unwrap();
        assert_eq!(intu.kind, ModKind::Skin);
        assert!(intu.paths.contains(&"PnFMods/Intuitions".to_string()));
        // Manifest-only row survives; its key is the unique row name.
        let ghost = mods.iter().find(|m| m.name == "GhostOnly").unwrap();
        assert!(ghost.paths.is_empty());
        assert_eq!(ghost.rel_path, "GhostOnly");
        assert!(!ghost.disabled);
        // Leftover bank keeps heuristic identity, no version.
        let hoshino = mods.iter().find(|m| m.name == "Hoshino").unwrap();
        assert_eq!(hoshino.version, None);
        // The manifest itself is a marker, never a patch unit.
        assert!(!mods.iter().any(|m| m.name == "installed_mods.xml"));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn toggle_disables_and_reenables_unit_files() {
        let tmp = std::env::temp_dir().join("wowsp_toggle_test");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("bin/1/res_mods");
        touch(&rm.join("PnFMods/SmokeMarkerPy/Main.py"));
        touch(&rm.join("PnFMods/SmokeMarkerPy/data.xml"));
        touch(&rm.join("ime_config.xml"));

        let unit = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.rel_path == "PnFMods/SmokeMarkerPy")
            .unwrap();
        assert!(!unit.disabled);

        // Disable: every file gains `.bak`, the scan reports the unit off.
        let renamed = set_paths_state(&rm, &unit.paths, false).unwrap();
        assert_eq!(renamed, 2);
        assert!(rm.join("PnFMods/SmokeMarkerPy/Main.py.bak").is_file());
        assert!(!rm.join("PnFMods/SmokeMarkerPy/Main.py").exists());
        let unit = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.rel_path == "PnFMods/SmokeMarkerPy")
            .unwrap();
        assert!(unit.disabled, "rescan must recognize the disabled unit");

        // Disabling a single-file patch keeps its name; the path is the twin.
        let ime_before = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.name == "ime_config.xml")
            .unwrap();
        assert!(!ime_before.disabled);
        set_paths_state(&rm, &ime_before.paths, false).unwrap();
        let ime = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.name == "ime_config.xml")
            .unwrap();
        assert!(ime.disabled);
        assert_eq!(ime.paths, vec!["ime_config.xml.bak".to_string()]);

        // Re-enable strips the suffixes again.
        let renamed = set_paths_state(&rm, &unit.paths, true).unwrap();
        assert_eq!(renamed, 2);
        assert!(rm.join("PnFMods/SmokeMarkerPy/Main.py").is_file());
        assert!(!rm.join("PnFMods/SmokeMarkerPy/Main.py.bak").exists());

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn uninstall_unit_removes_files_and_syncs_manifest() {
        let tmp = std::env::temp_dir().join("wowsp_unit_uninstall");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(&rm).unwrap();
        touch(&rm.join("PnFMods/SmokeMarkerPy/Main.py"));
        // The loader marker sits at the res_mods root — no unit owns it, so
        // uninstalling any unit must leave it alone.
        touch(&rm.join("PnFModsLoader.py"));
        // A disabled twin must go too.
        touch(&rm.join("gui/unbound2/!battleframe/label.xml.bak"));
        fs::write(
            rm.join("installed_mods.xml"),
            "<data>\n\t<mod installer=\"4\" name=\"SmokeMarker\" version=\"1.0\"/>\n\t<mod installer=\"4\" name=\"BattleFrame_TorpedoDetection\" version=\"1.0\"/>\n</data>\n",
        )
        .unwrap();

        let smoke = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.name == "SmokeMarker")
            .unwrap();
        let mut installs: Vec<ModInstallRecord> = Vec::new();
        let report =
            uninstall_unit_core(game.to_str().unwrap(), &rm, &smoke, &mut installs).unwrap();
        assert_eq!(report.removed_files, 1);
        assert!(!rm.join("PnFMods/SmokeMarkerPy").exists());
        assert!(rm.join("PnFModsLoader.py").is_file());
        // The manifest row is gone, the untouched row survives.
        let manifest = fs::read_to_string(rm.join("installed_mods.xml")).unwrap();
        assert!(!manifest.contains("SmokeMarker"));
        assert!(manifest.contains("BattleFrame_TorpedoDetection"));

        // A manifest-backed unit with disabled files clears both variants.
        let bf = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.name == "BattleFrame_TorpedoDetection")
            .unwrap();
        assert!(bf.disabled);
        let report = uninstall_unit_core(game.to_str().unwrap(), &rm, &bf, &mut installs).unwrap();
        assert_eq!(report.removed_files, 1);
        assert!(!rm.join("gui/unbound2/!battleframe").exists());
        assert!(
            !fs::read_to_string(rm.join("installed_mods.xml"))
                .unwrap()
                .contains("<mod ")
        );

        // A ledger record whose file the unit overwrote: the vanilla
        // snapshot must survive the uninstall — deletion happens first,
        // the restore lands afterwards (not the other way around).
        let restore = tmp.join("restore-cam");
        fs::create_dir_all(&restore).unwrap();
        fs::write(restore.join("camerasConsumer.xml"), b"vanilla").unwrap();
        fs::write(rm.join("camerasConsumer.xml"), b"modded").unwrap();
        installs.push(ModInstallRecord {
            id: "cam".into(),
            name: "Cam".into(),
            version: "1".into(),
            category: "patch".into(),
            source: "local".into(),
            discussion: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["camerasConsumer.xml".into()],
            restore_dir: Some(restore.to_string_lossy().into_owned()),
        });
        let cam = classify_installed_root(&rm)
            .into_iter()
            .find(|m| m.name == "camerasConsumer.xml")
            .unwrap();
        let report = uninstall_unit_core(game.to_str().unwrap(), &rm, &cam, &mut installs).unwrap();
        assert_eq!(report.restored_files, 1);
        assert_eq!(
            fs::read(rm.join("camerasConsumer.xml")).unwrap(),
            b"vanilla",
            "the vanilla snapshot must outlive the unit deletion"
        );
        assert!(installs.is_empty());

        fs::remove_dir_all(&tmp).ok();
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
    fn ship_unit_name_parses_codes_and_readable_parts() {
        assert_eq!(
            ship_unit_name("JSB039_Yamato_1945_Hull_a"),
            Some(("JSB039".into(), "JSB039 Yamato 1945".into()))
        );
        // Premium prefix is just part of the code; the component word ends
        // the readable name.
        assert_eq!(
            ship_unit_name("PJSB011_Yamato_Hull_a"),
            Some(("PJSB011".into(), "PJSB011 Yamato".into()))
        );
        assert_eq!(
            ship_unit_name("RSC110_Pr_66_Moskva_1948"),
            Some(("RSC110".into(), "RSC110 Pr 66 Moskva 1948".into()))
        );
        // No unit code — nothing to infer a model from.
        assert_eq!(ship_unit_name("default_ao"), None);
        assert_eq!(ship_unit_name("wake_01"), None);
        assert_eq!(ship_unit_name("Gun_barrel"), None);
    }

    #[test]
    fn scan_reports_texture_analysis_for_override_trees() {
        let tmp = std::env::temp_dir().join("wowsp_texanalysis_test");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("bin/12668706/res_mods");
        // content/: one identified ship unit, a gun-class texture without a
        // code, and a nation-wide unlock icon.
        touch(
            &rm.join(
                "content/gameplay/japan/ship/battleship/textures/JSB039_Yamato_1945_Hull_a.dds",
            ),
        );
        touch(&rm.join("content/gameplay/usa/gun/main/textures/default_ao.dds"));
        touch(&rm.join("content/unlocks/germany/texture/camo_icon.dds"));
        touch(&rm.join("particles/smoke_flare.prt"));
        touch(&rm.join("spaces/35_neighbors/env_water.dds"));
        // Loose files dropped directly under gameplay/ or spaces/ must not
        // leak into the nation / map-name collections.
        touch(&rm.join("content/gameplay/ussr_stray.dds"));
        touch(&rm.join("spaces/root_level.dds"));
        // Disabled twin: the `.bak` suffix must not leak into the extension.
        touch(&rm.join("texts/HUD_font_01.dds.bak"));

        let mods = classify_installed_root(&rm);
        let find = |name: &str| {
            mods.iter()
                .find(|m| m.kind == ModKind::Textures && m.name == name)
                .unwrap_or_else(|| panic!("{name} unit missing"))
        };

        let content = find("content");
        let a = content.texture_analysis.as_ref().expect("content analyzed");
        assert_eq!(a.categories, ["gameplay", "unlocks"]);
        // `ussr_stray.dds` directly under gameplay/ is a file, not a nation.
        assert_eq!(a.nations, ["germany", "japan", "usa"]);
        assert_eq!(a.species, ["battleship", "gun"]);
        assert_eq!(a.ships, ["JSB039 Yamato 1945"]);
        assert_eq!(a.file_count, 4);
        assert!(!a.truncated);

        let a = find("particles").texture_analysis.as_ref().unwrap();
        assert_eq!(a.categories, ["particles"]);
        assert_eq!(a.file_kinds[0].ext, "prt");

        let a = find("spaces").texture_analysis.as_ref().unwrap();
        assert_eq!(a.categories, ["spaces"]);
        // `root_level.dds` directly under spaces/ is a file, not a map.
        assert_eq!(a.space_names, ["35_neighbors"]);

        let a = find("texts").texture_analysis.as_ref().unwrap();
        assert_eq!(a.file_kinds[0].ext, "dds");

        // Every other kind carries no analysis.
        touch(&rm.join("gui/ribbons/ribbon_citadel.png"));
        let mods = classify_installed_root(&rm);
        assert!(
            mods.iter()
                .filter(|m| m.kind != ModKind::Textures)
                .all(|m| m.texture_analysis.is_none())
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn classify_package_reports_texture_analysis() {
        let tmp = std::env::temp_dir().join("wowsp_pkgtex_test");
        let _ = fs::remove_dir_all(&tmp);
        touch(
            &tmp.join(
                "content/gameplay/japan/ship/battleship/textures/JSB039_Yamato_1945_Hull_a.dds",
            ),
        );
        touch(&tmp.join("particles/flak.prt"));

        let plan = classify_package(&tmp).unwrap();
        let tos: Vec<_> = plan.entries.iter().map(|e| e.to_rel.as_str()).collect();
        assert!(tos.contains(&"content"), "{tos:?}");
        assert!(tos.contains(&"particles"), "{tos:?}");
        let a = plan
            .texture_analysis
            .as_ref()
            .expect("override plan analyzed");
        assert_eq!(a.categories, ["gameplay", "particles"]);
        assert_eq!(a.ships, ["JSB039 Yamato 1945"]);

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
        let report = install_plan(
            Path::new(pkg.to_str().unwrap()),
            game.to_str().unwrap(),
            &plan,
        )
        .map(|applied| applied.report)
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
        let report = install_plan(
            Path::new(pkg.to_str().unwrap()),
            game.to_str().unwrap(),
            &plan,
        )
        .map(|applied| applied.report)
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

    /// Read-only dump of the scan against a real game install — anchors the
    /// manifest grouping on what Aslain actually writes (skipped in CI):
    ///   WOWSP_GAME_ROOT="D:\...\World of Warships" cargo test -p wowsp_tauri
    ///   -- --ignored --nocapture mod_hub_real_game_scan
    #[test]
    #[ignore]
    fn mod_hub_real_game_scan() {
        let root = std::env::var("WOWSP_GAME_ROOT").expect("set WOWSP_GAME_ROOT");
        let res_mods = scan_root(&root).expect("scan root");
        for m in classify_installed_root(&res_mods) {
            println!(
                "{:?} {:?} v={:?} disabled={} paths={:?}",
                m.kind, m.name, m.version, m.disabled, m.paths
            );
        }
    }

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
        let report = install_plan(
            Path::new(ime.to_string_lossy().as_ref()),
            &game.to_string_lossy(),
            &plan,
        )
        .map(|applied| applied.report)
        .unwrap();
        assert!(report.wrote_files >= 1);
        assert!(game.join("bin/12668706/res_mods/ime_config.xml").is_file());

        // 2. Miyako_soundmod — standard banks pack.
        let miyako = find_dir(&dir, "Miyako_soundmod").expect("banks sample");
        let plan = classify_package(&miyako).unwrap();
        assert_eq!(plan.kind, ModKind::Voice);
        let report = install_plan(
            Path::new(miyako.to_string_lossy().as_ref()),
            &game.to_string_lossy(),
            &plan,
        )
        .map(|applied| applied.report)
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
        let report = install_plan(
            Path::new(pnf_root.to_string_lossy().as_ref()),
            &game.to_string_lossy(),
            &plan,
        )
        .map(|applied| applied.report)
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
