//! Foreign-installer unit detection — the "recognize and preliminarily
//! pair" half of wowsp.toml's job.
//!
//! Two installer footprints are known today:
//!
//! - **Aslain's modpack** (and installers writing the same convention):
//!   `<mod name version installer/>` rows in `res_mods/installed_mods.xml`
//!   — the row IS the installer's own ledger, so detection is exact.
//! - **WG's ModStation**: mods land as `bin/<version>/mods/<CamelCaseDir>/`
//!   (a tree `res_mods` scans never see; the station keeps no on-disk
//!   manifest we can rely on, and the tree is wiped by every game
//!   update) — directory presence is the signal.
//!
//! Detected units are recorded under `[foreign.<installer>.<key>]` with a
//! best-effort `identity` pairing against the online catalog (see
//! [`match_identity`]). Pairing is advisory for the describe side; the
//! actionable side builds on it — the catalog pane offers
//! "register & reinstall" over a paired foreign copy, and taking over cuts
//! the foreign installer's manifest rows
//! (`unit_ops::remove_manifest_entries_for_entry`).

use std::collections::BTreeMap;
use std::path::Path;

use wowsp_tauri_shared::{CatalogEntry, CatalogIndex};

use super::manifest::ForeignEntry;
use super::scan_installed::parse_installed_manifest;
use super::*;

const INSTALLER_ASLAIN: &str = "aslain";
const INSTALLER_MODSTATION: &str = "modstation";

/// Scan one install's foreign footprint: every known installer's detected
/// units, keyed `[installer][key]` ready for `[foreign.*]`.
pub(crate) fn scan_foreign(
    res_mods: &Path,
    mods_dir: &Path,
    catalog: Option<&CatalogIndex>,
) -> BTreeMap<String, BTreeMap<String, ForeignEntry>> {
    let mut out: BTreeMap<String, BTreeMap<String, ForeignEntry>> = BTreeMap::new();
    // Both known installers are keyed unconditionally — an EMPTY set is the
    // signal that the footprint vanished (game update wiped ModStation's
    // tree, the modpack's manifest was removed), and the empty rows sweep
    // their stale entries away. Missing keys would leave stale rows behind.
    out.insert(INSTALLER_ASLAIN.to_string(), BTreeMap::new());
    out.insert(INSTALLER_MODSTATION.to_string(), BTreeMap::new());

    // Pairing index: catalog name forms pre-normalized once per scan.
    let pairs = catalog.map(pairing_candidates);

    // Aslain-compatible manifest rows: name + version straight from the
    // installer's own ledger.
    for row in parse_installed_manifest(res_mods) {
        let entry = ForeignEntry {
            identity: match_identity(&row.name, pairs.as_deref()),
            version: row.version,
            name: row.name.clone(),
        };
        out.get_mut(INSTALLER_ASLAIN)
            .expect("keyed above")
            .insert(slug_key(&row.name), entry);
    }

    // ModStation tree: every directory under bin/<ver>/mods/ is one mod
    // (the station installs there and nothing else does). Names are
    // sorted and duplicate slugs keep the FIRST directory, so the scan,
    // `modstation_dir_for_key` and the register-takeover all resolve a
    // colliding slug to the same tree no matter what read_dir yields.
    let mut mod_dirs: Vec<(String, PathBuf)> = fs::read_dir(mods_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|ent| ent.path().is_dir())
        .map(|ent| (ent.file_name().to_string_lossy().into_owned(), ent.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    mod_dirs.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, _) in mod_dirs {
        let slugged = slug_key(&name);
        let station = out.get_mut(INSTALLER_MODSTATION).expect("keyed above");
        if station.contains_key(&slugged) {
            continue;
        }
        let entry = ForeignEntry {
            identity: match_identity(&name, pairs.as_deref()),
            version: None,
            name: name.clone(),
        };
        station.insert(slugged, entry);
    }

    out
}

/// Manifest key for a foreign unit: lowercase, alphanumerics and dashes —
/// stable across rescans regardless of the display name's casing/spaces.
fn slug_key(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "unnamed".to_string()
    } else {
        out
    }
}

/// Resolve a ModStation unit's tree by manifest key (the slug of its
/// directory name) — the uninstall path for a tree res_mods unit-ops
/// never see. Names are sorted and the FIRST slugged match wins, the
/// exact rule the scan applies, so both resolve a colliding slug to the
/// same tree regardless of read_dir order.
pub(crate) fn modstation_dir_for_key(mods_dir: &Path, key: &str) -> Option<PathBuf> {
    let mut names: Vec<(String, PathBuf)> = fs::read_dir(mods_dir)
        .ok()?
        .flatten()
        .filter(|ent| ent.path().is_dir())
        .map(|ent| (ent.file_name().to_string_lossy().into_owned(), ent.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    names
        .into_iter()
        .find(|(name, _)| slug_key(name) == key)
        .map(|(_, path)| path)
}

/// Normalize a display name for comparison: lowercase, letters/digits
/// only, runs collapsed to nothing ("SMI: v4 (sasagcy)" → "smiv4sasagcy").
fn normalize(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Connective words that carry no identity — dropped before comparing, so
/// "Team Panels by TTaro" can reach "TeamPanelTTaro" ("…panels by…" and
/// "…panel…" stay within the similarity threshold once "by" is gone).
const NAME_STOPWORDS: [&str; 9] = ["by", "of", "the", "for", "from", "and", "a", "an", "to"];

/// One candidate in the pairing index: a catalog id plus every normalized
/// name form its display names produce.
pub(crate) struct PairCandidate {
    id: String,
    names: Vec<String>,
}

/// Match a foreign unit's display name against the catalog. Three tiers,
/// best score wins (first entry breaks ties, so the verdict is
/// deterministic across rescans):
///
/// - exact normalized equality (the catalog is Aslain-ingested, so most
///   modpack names match verbatim);
/// - containment either way (≥ 6 chars) — "AdjustableMarkers" inside
///   "Adjustable Markers (fixed)" normalizes to exactly that;
/// - character-bigram similarity ≥ 0.80 (both sides ≥ 8 chars) — the
///   fuzzy tier for CamelCase pack names vs the catalog's prose names
///   ("TeamPanelTTaro" ↔ "Team Panels by TTaro": 12/15 shared bigrams).
///
/// The thresholds are deliberately conservative: a wrong pairing puts a
/// "register & reinstall" button on the wrong entry, so noise costs more
/// than silence.
pub(crate) fn match_identity(name: &str, pairs: Option<&[PairCandidate]>) -> Option<String> {
    let pairs = pairs?;
    let needle_forms = name_forms(name);
    if needle_forms.is_empty() {
        return None;
    }
    let mut best: Option<(u32, &str)> = None;
    for candidate in pairs {
        let mut score = 0u32;
        for needle in &needle_forms {
            for form in &candidate.names {
                score = score.max(match_score(needle, form));
            }
        }
        if score >= SIMILARITY_MIN && best.is_none_or(|(b, _)| score > b) {
            best = Some((score, candidate.id.as_str()));
        }
    }
    best.map(|(_, id)| id.to_string())
}

/// Score one (needle, candidate form) pair. `0` means "no match"; the
/// exact tier outranks everything, containment outranks similarity, and
/// similarity keeps its ratio so near-ties order stably.
fn match_score(needle: &str, form: &str) -> u32 {
    if needle == form {
        return EXACT_SCORE;
    }
    let (short, long) = if needle.len() <= form.len() {
        (needle, form)
    } else {
        (form, needle)
    };
    // Containment, but only when the contained side carries most of the
    // longer name — a bare "Markers" must not latch onto "Adjustable
    // Markers (extended)".
    if short.len() >= 6 && short.len() * 10 >= long.len() * 6 && long.contains(short) {
        return CONTAINMENT_SCORE + short.len() as u32;
    }
    if needle.len() >= 8 && form.len() >= 8 {
        let j = bigram_jaccard(needle, form);
        if j >= 0.80 {
            return (j * 10_000.0) as u32;
        }
    }
    0
}

const EXACT_SCORE: u32 = 1_000_000;
const CONTAINMENT_SCORE: u32 = 100_000;
/// Similarity results are `(j * 10_000)` — the pass mark is 0.80.
const SIMILARITY_MIN: u32 = 8_000;

/// Jaccard similarity over the set of adjacent character pairs — robust
/// to word order, plural drift and inserted stopwords, unlike edit
/// distance over the whole string.
fn bigram_jaccard(a: &str, b: &str) -> f64 {
    let grams = |s: &str| -> std::collections::BTreeSet<(u8, u8)> {
        let bytes = s.as_bytes();
        bytes.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let (ga, gb) = (grams(a), grams(b));
    if ga.is_empty() || gb.is_empty() {
        return 0.0;
    }
    let shared = ga.intersection(&gb).count() as f64;
    let union = ga.union(&gb).count() as f64;
    shared / union
}

/// The pairing index over a catalog: one candidate per listed entry, its
/// display names pre-normalized into comparison forms.
pub(crate) fn pairing_candidates(catalog: &CatalogIndex) -> Vec<PairCandidate> {
    catalog
        .mods
        .iter()
        // Delisted entries are withdrawn — pairing a foreign unit against
        // one would badge it "paired" while the entry itself is
        // unopenable.
        .filter(|entry| !entry.delisted)
        .map(|entry| PairCandidate {
            names: entry_name_forms(entry),
            id: entry.id.clone(),
        })
        .collect()
}

/// The Aslain manifest rows the SCAN-time pairing assigns to `entry_id` —
/// the exact set the UI badged as this entry's foreign copies, and the
/// exact set a register-over-foreign install takes over. Scoped to the
/// scan verdict (best match across the WHOLE catalog), never the loose
/// per-entry threshold, so a sibling row that merely clears the tiers
/// against this entry but best-matches another one is never touched.
pub(crate) fn aslain_rows_for_entry(
    res_mods: &Path,
    catalog: &CatalogIndex,
    entry_id: &str,
) -> Vec<String> {
    let rows = parse_installed_manifest(res_mods);
    if rows.is_empty() {
        return Vec::new();
    }
    let candidates = pairing_candidates(catalog);
    rows.into_iter()
        .filter(|row| match_identity(&row.name, Some(&candidates)).as_deref() == Some(entry_id))
        .map(|row| row.name)
        .collect()
}

/// The ModStation trees the scan-time pairing assigns to `entry_id` —
/// same verdict-scoping as [`aslain_rows_for_entry`]; the register
/// takeover removes them so the game does not load two active copies
/// (the station's tree under mods/ AND the fresh WoWSP install under
/// res_mods).
pub(crate) fn modstation_dirs_for_entry(
    mods_dir: &Path,
    catalog: &CatalogIndex,
    entry_id: &str,
) -> Vec<PathBuf> {
    let mut dirs: Vec<(String, PathBuf)> = fs::read_dir(mods_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|ent| ent.path().is_dir())
        .map(|ent| (ent.file_name().to_string_lossy().into_owned(), ent.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    if dirs.is_empty() {
        return Vec::new();
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    let candidates = pairing_candidates(catalog);
    let mut seen = std::collections::BTreeSet::new();
    dirs.into_iter()
        .filter(|(name, _)| seen.insert(slug_key(name)))
        .filter(|(name, _)| match_identity(name, Some(&candidates)).as_deref() == Some(entry_id))
        .map(|(_, path)| path)
        .collect()
}

/// Every display name a catalog entry answers to.
fn entry_names(entry: &CatalogEntry) -> Vec<&str> {
    let mut names = vec![entry.name_en.as_str(), entry.name_zh.as_str()];
    // Every localized name, not just en-US: a mod's common name in any
    // language may be what the foreign installer wrote.
    for i18n in entry.i18n.values() {
        names.push(i18n.name.as_str());
    }
    names.push(entry.title.as_str());
    names
}

/// The comparison forms of ANY display name (catalog side and foreign
/// side alike): the raw normalization plus, when stopword words were
/// dropped, the stripped one — "Team Panels by TTaro" yields BOTH
/// "teampanelsbyttaro" and "teampanelsttaro", so either side may carry
/// the connectives.
fn name_forms(name: &str) -> Vec<String> {
    let words: Vec<&str> = name.split([' ', ':', '(', ')', '-', '_']).collect();
    let mut forms = vec![normalize(name)];
    let stripped: Vec<&str> = words
        .iter()
        .copied()
        .filter(|w| !NAME_STOPWORDS.iter().any(|s| w.eq_ignore_ascii_case(s)))
        .collect();
    // Only bother when stopwords were actually dropped (otherwise it
    // duplicates the raw form).
    if stripped.len() != words.len() {
        let stripped = normalize(&stripped.join(" "));
        if !stripped.is_empty() {
            forms.push(stripped);
        }
    }
    forms.retain(|f| !f.is_empty());
    forms
}

/// The comparison forms of an entry's names (see [`name_forms`]): every
/// display name plus every declared alias — an Aslain manifest row id or
/// on-disk directory name that shares no words with the display name
/// (`TeamHP` vs "Team HP by TTaro", `ThreeDimentionalHydro` vs "3D
/// Hydro") still pairs exactly through its alias forms.
fn entry_name_forms(entry: &CatalogEntry) -> Vec<String> {
    let mut forms: Vec<String> = entry_names(entry)
        .iter()
        .flat_map(|n| name_forms(n))
        .collect();
    for alias in &entry.aliases {
        forms.extend(name_forms(alias));
    }
    forms
}

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::{CatalogEntryI18n, CatalogPackage};

    fn res_mods(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wowsp_foreign_{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn catalog_entry(id: &str, en: &str, zh: &str) -> CatalogEntry {
        catalog_entry_aliased(id, en, zh, Vec::new())
    }

    fn catalog_entry_aliased(id: &str, en: &str, zh: &str, aliases: Vec<String>) -> CatalogEntry {
        CatalogEntry {
            id: id.into(),
            category: "battle".into(),
            discussion: Some(1),
            version: "1".into(),
            game: "*".into(),
            bundled: false,
            delisted: false,
            presets: Vec::new(),
            tags: Vec::new(),
            title: format!("[Mod] {en} {id} 1"),
            name_zh: zh.into(),
            name_en: en.into(),
            description: String::new(),
            author_url: String::new(),
            i18n: [(
                "en-US".to_string(),
                CatalogEntryI18n {
                    name: en.into(),
                    description: String::new(),
                },
            )]
            .into_iter()
            .collect(),
            aliases,
            preview: None,
            packages: vec![CatalogPackage {
                url: "https://x/a.zip".into(),
                sha256: String::new(),
                size: 1,
                name: "a.zip".into(),
            }],
        }
    }

    #[test]
    fn detects_aslain_rows_and_pairs_by_name() {
        let dir = res_mods("aslain");
        fs::write(
            dir.join("installed_mods.xml"),
            "<data><mod name=\"Shot Timer\" version=\"15.7.0\" installer=\"aslain\"/>\
             <mod name=\"Some Unknown Thing\"/></data>",
        )
        .unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![catalog_entry(
                "battle.timer.shot",
                "Shot Timer",
                "开火后倒计时20s",
            )],
        };
        let out = scan_foreign(&dir, &dir.join("mods-nope"), Some(&catalog));
        let aslain = &out[INSTALLER_ASLAIN];
        assert_eq!(aslain.len(), 2);
        let shot = &aslain["shot-timer"];
        assert_eq!(shot.identity.as_deref(), Some("battle.timer.shot"));
        assert_eq!(shot.version.as_deref(), Some("15.7.0"));
        assert!(aslain["some-unknown-thing"].identity.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_modstation_directories() {
        let dir = res_mods("modstation");
        let mods = dir.join("mods");
        fs::create_dir_all(mods.join("AdjustableMarkers")).unwrap();
        fs::create_dir_all(mods.join(".hidden")).unwrap();
        fs::write(mods.join("loose.txt"), b"x").unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![catalog_entry(
                "battle.marker.adjustable",
                "AdjustableMarkers",
                "可调标记",
            )],
        };
        let out = scan_foreign(&dir, &mods, Some(&catalog));
        let station = &out[INSTALLER_MODSTATION];
        assert_eq!(station.len(), 1, "dot-dirs and files are not mods");
        assert_eq!(
            station["adjustablemarkers"].identity.as_deref(),
            Some("battle.marker.adjustable")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_footprint_keys_both_installers_empty() {
        // The keys must EXIST with empty rows: that is the signal which
        // sweeps stale foreign entries away once a footprint vanishes.
        let dir = res_mods("empty");
        let out = scan_foreign(&dir, &dir.join("mods"), None);
        assert_eq!(out.len(), 2);
        assert!(out[INSTALLER_ASLAIN].is_empty());
        assert!(out[INSTALLER_MODSTATION].is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pairs_camelcase_pack_names_by_similarity() {
        // The tier exact equality always missed: a CamelCase modpack name
        // against the catalog's prose name. "TeamPanelTTaro" vs
        // "Team Panels by TTaro" (stopword-stripped "teampanelsttaro")
        // shares 12 of 15 character bigrams → 0.80, the pass mark.
        let dir = res_mods("fuzzy");
        fs::write(
            dir.join("installed_mods.xml"),
            "<data><mod name=\"TeamPanelTTaro\" version=\"1\" installer=\"aslain\"/></data>",
        )
        .unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![catalog_entry(
                "battle.panel.team",
                "Team Panels by TTaro",
                "TTaro 队伍面板",
            )],
        };
        let out = scan_foreign(&dir, &dir.join("mods-nope"), Some(&catalog));
        assert_eq!(
            out[INSTALLER_ASLAIN]["teampanelttaro"].identity.as_deref(),
            Some("battle.panel.team")
        );
        // …and the takeover scope agrees with the index verdict: the row
        // belongs to this entry, a name the entry does not pair with does
        // not.
        assert_eq!(
            aslain_rows_for_entry(&dir, &catalog, "battle.panel.team"),
            vec!["TeamPanelTTaro".to_string()]
        );
        assert!(aslain_rows_for_entry(&dir, &catalog, "battle.timer.shot").is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn similarity_does_not_pair_unrelated_names() {
        // Unrelated short-ish names must stay unpaired — a wrong pairing
        // plants a "register & reinstall" button on the wrong entry, so
        // the fuzzy tier stays conservative.
        let dir = res_mods("fuzzy_negative");
        fs::write(
            dir.join("installed_mods.xml"),
            "<data><mod name=\"RealAimScope\" installer=\"aslain\"/>\
             <mod name=\"Some Unknown Thing\"/></data>",
        )
        .unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![catalog_entry(
                "battle.crosshair.smart",
                "Smart Hybrid Crosshair",
                "智能混合准星",
            )],
        };
        let out = scan_foreign(&dir, &dir.join("mods-nope"), Some(&catalog));
        assert!(out[INSTALLER_ASLAIN]["realaimscope"].identity.is_none());
        assert!(
            out[INSTALLER_ASLAIN]["some-unknown-thing"]
                .identity
                .is_none()
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn containment_pairs_stripped_down_names() {
        // "AdjustableMarkers" inside "Adjustable Markers (extended)" —
        // the containment tier, ≥ 6 chars and ≥ 60 % of the longer name.
        // A bare "Markers" must not latch on.
        let dir = res_mods("containment");
        fs::write(
            dir.join("installed_mods.xml"),
            "<data><mod name=\"AdjustableMarkers\" installer=\"aslain\"/>\
             <mod name=\"Markers\" installer=\"aslain\"/></data>",
        )
        .unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![catalog_entry(
                "battle.marker.adjustable",
                "Adjustable Markers (extended)",
                "可调标记",
            )],
        };
        let out = scan_foreign(&dir, &dir.join("mods-nope"), Some(&catalog));
        let aslain = &out[INSTALLER_ASLAIN];
        assert_eq!(
            aslain["adjustablemarkers"].identity.as_deref(),
            Some("battle.marker.adjustable")
        );
        assert!(aslain["markers"].identity.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn modstation_dir_resolves_by_slug_key() {
        let dir = res_mods("modstation_slug");
        let mods = dir.join("mods");
        fs::create_dir_all(mods.join("TeamPanelsByTTaro")).unwrap();
        fs::create_dir_all(mods.join("other")).unwrap();
        let hit = modstation_dir_for_key(&mods, "teampanelsbyttaro");
        assert_eq!(hit, Some(mods.join("TeamPanelsByTTaro")));
        assert_eq!(modstation_dir_for_key(&mods, "nope"), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn modstation_slug_collisions_resolve_deterministically() {
        // Two directories whose names slug to the SAME key: the scan
        // keeps the alphabetically first, and the by-key resolver agrees
        // — no matter what order read_dir happens to yield.
        let dir = res_mods("modstation_slug_clash");
        let mods = dir.join("mods");
        fs::create_dir_all(mods.join("Minimap Pro")).unwrap();
        fs::create_dir_all(mods.join("Minimap-Pro")).unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![],
        };
        let out = scan_foreign(&dir, &mods, Some(&catalog));
        let station = &out[INSTALLER_MODSTATION];
        assert_eq!(station.len(), 1, "one slugged key: {station:?}");
        assert_eq!(station["minimap-pro"].name, "Minimap Pro");
        assert_eq!(
            modstation_dir_for_key(&mods, "minimap-pro"),
            Some(mods.join("Minimap Pro"))
        );
        // …and the takeover resolver stays in step.
        assert!(modstation_dirs_for_entry(&mods, &catalog, "battle.any").is_empty());
        fs::remove_dir_all(&dir).ok();
    }
    #[test]
    fn declared_aliases_pair_names_similarity_cannot_reach() {
        // "TeamHP" vs "Team HP by TTaro" (stripped "teamhpttaro", 11
        // chars — containment needs 60 ≥ 66 and the bigram tier needs an
        // 8-char needle) never meets a tier; the declared alias matches
        // exactly. The manifest row pairing and the takeover scoping share
        // the verdict.
        let dir = res_mods("alias");
        fs::write(
            dir.join("installed_mods.xml"),
            "<data><mod name=\"TeamHP\" version=\"1.1.0\" installer=\"aslain\"/></data>",
        )
        .unwrap();
        let catalog = CatalogIndex {
            source_version: String::new(),
            game_version: String::new(),
            fetched_at: String::new(),
            mods: vec![catalog_entry_aliased(
                "battle.minipanel.team-hp",
                "Team HP by TTaro",
                "团队总血量可调版",
                vec!["TeamHP".to_string()],
            )],
        };
        let out = scan_foreign(&dir, &dir.join("mods-nope"), Some(&catalog));
        assert_eq!(
            out[INSTALLER_ASLAIN]["teamhp"].identity.as_deref(),
            Some("battle.minipanel.team-hp")
        );
        assert_eq!(
            aslain_rows_for_entry(&dir, &catalog, "battle.minipanel.team-hp"),
            vec!["TeamHP".to_string()]
        );
        fs::remove_dir_all(&dir).ok();
    }
}
