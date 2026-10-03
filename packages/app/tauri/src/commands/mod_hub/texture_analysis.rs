use super::*;
use std::collections::BTreeMap;
use wowsp_tauri_shared::TextureFileKind;

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
pub(crate) fn analyze_override_tree(
    root: &Path,
    top_name: Option<&str>,
) -> Option<TextureAnalysis> {
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
pub(crate) fn ship_unit_name(stem: &str) -> Option<(String, String)> {
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
