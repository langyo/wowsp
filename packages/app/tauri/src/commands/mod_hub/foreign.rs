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
//! best-effort `identity` pairing against the online catalog (name-based:
//! the hub's catalog is Aslain-ingested, so modpack names largely match
//! verbatim). Pairing is advisory — WoWSP describes these units, it never
//! manages them.

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

    // Pairing index: catalog names pre-normalized once per scan.
    let pairs = catalog.map(|cat| {
        cat.mods
            .iter()
            // Delisted entries are withdrawn — pairing a foreign unit
            // against one would badge it "paired" while the entry itself
            // is unopenable.
            .filter(|entry| !entry.delisted)
            .map(|entry| {
                (
                    entry_names(entry)
                        .iter()
                        .map(|n| normalize(n))
                        .collect::<Vec<_>>(),
                    entry.id.clone(),
                )
            })
            .collect::<Vec<_>>()
    });

    // Aslain-compatible manifest rows: name + version straight from the
    // installer's own ledger.
    for row in parse_installed_manifest(res_mods) {
        let entry = ForeignEntry {
            identity: match_identity(&row.name, pairs.as_ref()),
            version: row.version,
            name: row.name.clone(),
        };
        out.get_mut(INSTALLER_ASLAIN)
            .expect("keyed above")
            .insert(slug_key(&row.name), entry);
    }

    // ModStation tree: every directory under bin/<ver>/mods/ is one mod
    // (the station installs there and nothing else does).
    if let Ok(entries) = fs::read_dir(mods_dir) {
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_dir() {
                continue;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            // The station itself leaves no tooling directories here, but a
            // hidden/system dot-dir from anything else is not a mod.
            if name.starts_with('.') {
                continue;
            }
            let entry = ForeignEntry {
                identity: match_identity(&name, pairs.as_ref()),
                version: None,
                name: name.clone(),
            };
            out.get_mut(INSTALLER_MODSTATION)
                .expect("keyed above")
                .insert(slug_key(&name), entry);
        }
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

/// Normalize a display name for comparison: lowercase, letters/digits
/// only, runs collapsed to nothing ("SMI: v4 (sasagcy)" → "smiv4sasagcy").
fn normalize(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn match_identity(name: &str, pairs: Option<&Vec<(Vec<String>, String)>>) -> Option<String> {
    let pairs = pairs?;
    let needle = normalize(name);
    if needle.is_empty() {
        return None;
    }
    pairs
        .iter()
        .find(|(names, _id)| names.contains(&needle))
        .map(|(_, id)| id.clone())
}

/// Every display name a catalog entry answers to.
fn entry_names(entry: &CatalogEntry) -> Vec<&str> {
    let mut names = vec![entry.name_en.as_str(), entry.name_zh.as_str()];
    if let Some(en) = entry.i18n.get("en-US") {
        names.push(en.name.as_str());
    }
    names.push(entry.title.as_str());
    names
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
        CatalogEntry {
            id: id.into(),
            category: "battle".into(),
            discussion: Some(1),
            version: "1".into(),
            game: "*".into(),
            bundled: false,
            delisted: false,
            presets: Vec::new(),
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
}
