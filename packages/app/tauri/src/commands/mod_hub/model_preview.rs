//! Custom-model 3D preview: player-made ship/gun/aircraft meshes live in
//! res_mods as BigWorld `.geometry` files (PnFMods skin packs and plain
//! `content/` overrides alike). This module re-emits them as GLB through
//! wowsunpack's loose-file geometry parser + raw glTF exporter — no game
//! `.idx` VFS needed — caching each part under
//! `%LOCALAPPDATA%\WoWSP\model-previews\`, which the static
//! `$LOCALDATA/WoWSP/**` asset-protocol scope already serves.
//!
//! The game splits a hull into independent section geometries (Bow /
//! MidFront / MidBack / Stern + a low-poly base) that all share the ship's
//! coordinate space, so a click on ANY family member expands to the whole
//! family: the webui stacks the parts at identity transforms and the ship
//! assembles itself. `_dead`/`_lod*`/`_ports`/`_wire` variants are excluded
//! (destroyed-state, distance meshes, hardpoint markers, wireframes), and
//! sibling parts that fail to parse are skipped — a mod dir may legitimately
//! mix legacy formats next to current ones.
//!
//! Exports are untextured (holo-style shape previews): material binding
//! lives in the game's `content/assets.bin` prototypes, which a res_mods
//! pack never carries — the pack's recolored `.dds` textures surface through
//! the regular image grid instead.

use std::time::SystemTime;

use serde::Serialize;

use super::*;

/// One cached GLB the webui loads through the asset protocol.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreviewPart {
    /// res_mods-relative source path (display name + identity).
    pub rel: String,
    /// Absolute path of the cached GLB.
    pub path: String,
    /// GLB size in bytes.
    pub size: u64,
}

/// Hull sections of the damageable-ship system — independent geometries in
/// the ship's shared space that preview as one assembled model.
const SECTION_SUFFIXES: [&str; 4] = ["_Bow", "_MidBack", "_MidFront", "_Stern"];

/// A family's membership cap: real hulls are base + 4 sections; anything
/// past this is a pathological tree, not a ship.
const FAMILY_CAP: usize = 16;
/// Refuse to parse beyond this much raw `.geometry` input per request.
const FAMILY_BYTES_CAP: u64 = 384 * 1024 * 1024;
/// Cache eviction thresholds: past KEEP files, the oldest beyond KEEP are
/// deleted (regenerable artifacts, so a lazy sweep is enough).
const CACHE_KEEP: usize = 160;
const CACHE_TRIGGER: usize = 240;

/// Whether a file stem carries a non-preview side-geometry suffix: destroyed
/// state, distance LOD, hardpoint markers, wireframe. Shared with the asset
/// listing, which hides such rows.
pub(crate) fn is_aux_stem(stem: &str) -> bool {
    stem.ends_with("_dead")
        || stem.ends_with("_ports")
        || stem.ends_with("_wire")
        || stem.rsplit_once("_lod").is_some_and(|(_, digits)| {
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        })
}

/// Family root of a geometry stem: strip side-geometry suffixes and one
/// hull-section suffix, repeatedly (`…_Bow_lod1` → `…`).
fn family_stem(stem: &str) -> &str {
    let mut s = stem;
    loop {
        let mut next = s;
        for suffix in SECTION_SUFFIXES {
            if let Some(head) = next.strip_suffix(suffix) {
                next = head;
            }
        }
        if next.ends_with("_dead") || next.ends_with("_ports") || next.ends_with("_wire") {
            next = next.rsplit_once('_').map(|(head, _)| head).unwrap_or(next);
            s = next;
            continue;
        }
        if let Some((head, digits)) = next.rsplit_once("_lod") {
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                s = head;
                continue;
            }
        }
        if next == s {
            return s;
        }
        s = next;
    }
}

/// Filesystem-safe, length-capped cache stem (hash suffix distinguishes
/// same-named files from different mods).
fn cache_stem(stem: &str) -> String {
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut name: String = clean.chars().take(80).collect();
    if name.is_empty() {
        name.push_str("model");
    }
    name
}

/// Build (or reuse) the cached GLB for one `.geometry` file. `rel` is
/// res_mods-relative; returns the absolute cache path.
fn export_part(res_mods: &Path, rel: &str, cache_dir: &Path) -> Result<(String, u64), String> {
    let path = res_mods.join(rel);
    let meta = fs::metadata(&path).map_err(|e| format!("stat {rel}: {e}"))?;
    let mtime = meta
        .modified()
        .or_else(|_| meta.created())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let digest = Sha256::new()
        .chain_update(rel.as_bytes())
        .chain_update(meta.len().to_le_bytes())
        .chain_update(
            mtime
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos().to_le_bytes())
                .unwrap_or([0u8; 16]),
        )
        .finalize();
    let stem = Path::new(rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model".into());
    let out = cache_dir.join(format!("{}-{}.glb", cache_stem(&stem), hex_prefix(&digest)));
    if let Ok(existing) = fs::metadata(&out) {
        return Ok((out.to_string_lossy().into_owned(), existing.len()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {rel}: {e}"))?;
    let geometry =
        wowsunpack::models::geometry::parse_geometry(&bytes).map_err(|e| format!("{rel}: {e}"))?;
    let mut glb = std::io::Cursor::new(Vec::new());
    wowsunpack::export::gltf_export::export_geometry_raw(&geometry, &mut glb)
        .map_err(|e| format!("{rel}: {e}"))?;
    // Write-then-rename so a concurrent request for the same part never
    // reads a half-written GLB. The tmp suffix is unique per invocation
    // (pid + counter): two in-flight exports of the same family must not
    // truncate each other's staging file.
    let tmp = cache_dir.join(format!(".tmp-{}-{}", hex_prefix(&digest), tmp_tag()));
    fs::write(&tmp, glb.get_ref()).map_err(|e| format!("write cache: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &out) {
        let _ = fs::remove_file(&tmp);
        // Lost the race to another writer — keep its copy.
        if !out.exists() {
            return Err(format!("cache rename: {e}"));
        }
    }
    let size = fs::metadata(&out)
        .map(|m| m.len())
        .unwrap_or(glb.get_ref().len() as u64);
    Ok((out.to_string_lossy().into_owned(), size))
}

/// First 12 hex chars of a digest — enough to dodge filename collisions
/// between same-stemmed files from different mods.
fn hex_prefix(digest: &[u8]) -> String {
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// Unique-per-invocation staging-file tag (pid + process-wide counter).
fn tmp_tag() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Delete the oldest cached GLBs once the directory outgrows CACHE_TRIGGER;
/// orphaned staging files from a killed process go too — but only once
/// they're clearly stale (an hour dwarfs any live export), so a concurrent
/// invocation's in-flight tmp is never yanked out from under its rename.
fn prune_cache(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    const TMP_STALE: std::time::Duration = std::time::Duration::from_secs(3600);
    let now = SystemTime::now();
    let mut files: Vec<(SystemTime, std::path::PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".tmp-") {
            let stale = e
                .metadata()
                .and_then(|m| m.modified().or_else(|_| m.created()))
                .is_ok_and(|t| now.duration_since(t).unwrap_or_default() > TMP_STALE);
            if stale {
                let _ = fs::remove_file(e.path());
            }
            continue;
        }
        if !e.path().extension().is_some_and(|x| x == "glb") {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let Ok(mtime) = meta.modified().or_else(|_| meta.created()) else {
            continue;
        };
        files.push((mtime, e.path()));
    }
    if files.len() < CACHE_TRIGGER {
        return;
    }
    files.sort();
    let excess = files.len().saturating_sub(CACHE_KEEP);
    for (_, path) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// Serve one custom model as an assembled set of cached GLB parts. The
/// clicked `.geometry` expands to its family (hull base + sections, or a
/// standalone gun/aircraft mesh); the clicked file itself must parse, other
/// members are best-effort.
#[tauri::command]
pub fn mod_hub_read_model(
    game_root: String,
    rel_path: String,
) -> Result<Vec<ModelPreviewPart>, String> {
    if !rel_path.to_ascii_lowercase().ends_with(".geometry") {
        return Err(format!("{rel_path}: not a .geometry model"));
    }
    let res_mods = super::scan_installed::scan_root(&game_root)?;
    super::assets::safe_rel(&rel_path)?;
    let clicked_path = res_mods.join(&rel_path);
    let family = family_stem(
        &clicked_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .ok_or_else(|| format!("invalid asset path: {rel_path:?}"))?,
    )
    .to_string();
    let dir = clicked_path
        .parent()
        .ok_or_else(|| format!("invalid asset path: {rel_path:?}"))?;

    // Family membership: same directory, same family root, no side-geometry
    // suffix — all compared ASCII-case-insensitively, since Windows paths
    // arrive in whatever casing the listing produced. The clicked file (or
    // its base) first, then the rest sorted.
    let family_lower = family.to_ascii_lowercase();
    let clicked_lower = rel_path.to_ascii_lowercase();
    let mut members: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_file()
                || !path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("geometry"))
            {
                continue;
            }
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            if !family_stem(&stem).eq_ignore_ascii_case(&family_lower) || is_aux_stem(&stem) {
                continue;
            }
            let Ok(rel) = path.strip_prefix(&res_mods) else {
                continue;
            };
            members.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    // A pack of side-only geometries (e.g. just `X_Bow_lod1`) has no
    // previewable family — fall back to the clicked file itself.
    if members.is_empty() {
        members.push(rel_path.clone());
    }
    members.sort_by_key(|rel| {
        let stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        (
            !stem.eq_ignore_ascii_case(&family_lower),
            rel.to_ascii_lowercase(),
        )
    });
    members.dedup();
    members.truncate(FAMILY_CAP);

    let cache_dir = crate::paths::ensure_cache_dir()?.join("model-previews");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("cache dir: {e}"))?;

    let mut parts: Vec<ModelPreviewPart> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut last_err: Option<String> = None;
    for rel in &members {
        if let Ok(meta) = fs::metadata(res_mods.join(rel)) {
            total_bytes = total_bytes.saturating_add(meta.len());
            if total_bytes > FAMILY_BYTES_CAP {
                break;
            }
        }
        match export_part(&res_mods, rel, &cache_dir) {
            Ok((path, size)) => parts.push(ModelPreviewPart {
                rel: rel.clone(),
                path,
                size,
            }),
            // The clicked member must succeed; a broken sibling degrades to
            // a partial ship rather than a dead preview.
            Err(e) if rel.to_ascii_lowercase() == clicked_lower => return Err(e),
            Err(e) => {
                tracing::debug!("model part skipped: {e}");
                last_err = Some(e);
            },
        }
    }
    if parts.is_empty() {
        return Err(last_err.unwrap_or_else(|| format!("{rel_path}: no model parts exported")));
    }
    prune_cache(&cache_dir);
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_stem_groups_hull_sections() {
        for stem in [
            "RSC011_Pr_66_Moskva_1948",
            "RSC011_Pr_66_Moskva_1948_Bow",
            "RSC011_Pr_66_Moskva_1948_MidFront",
            "RSC011_Pr_66_Moskva_1948_MidBack",
            "RSC011_Pr_66_Moskva_1948_Stern",
        ] {
            assert_eq!(family_stem(stem), "RSC011_Pr_66_Moskva_1948", "{stem}");
        }
        // Compound suffixes strip down to the same family.
        assert_eq!(
            family_stem("RSC011_Pr_66_Moskva_1948_Bow_lod1"),
            "RSC011_Pr_66_Moskva_1948"
        );
        assert_eq!(
            family_stem("RSC011_Pr_66_Moskva_1948_Stern_dead"),
            "RSC011_Pr_66_Moskva_1948"
        );
        // A standalone gun keeps its identity (dead variant aside).
        assert_eq!(
            family_stem("RGA066_45mm_SM_20_Zif"),
            "RGA066_45mm_SM_20_Zif"
        );
        // Non-suffix `_lod`-like tails (non-numeric) are NOT stripped.
        assert_eq!(
            family_stem("RAB707_Be_6PLO_loader"),
            "RAB707_Be_6PLO_loader"
        );
    }

    #[test]
    fn aux_stems_recognize_side_geometry() {
        assert!(is_aux_stem("Hull_dead"));
        assert!(is_aux_stem("Hull_lod1"));
        assert!(is_aux_stem("Hull_ports"));
        assert!(is_aux_stem("Hull_wire"));
        assert!(!is_aux_stem("Hull"));
        assert!(!is_aux_stem("Hull_Bow"));
        // `_lod` without digits is a real stem.
        assert!(!is_aux_stem("RAB707_Be_6PLO_loader"));
        assert!(!is_aux_stem("RAB707_Be_6PLO_lod"));
    }

    #[test]
    fn cache_stem_sanitizes() {
        assert_eq!(
            cache_stem("RSC011_Pr_66_Moskva_1948"),
            "RSC011_Pr_66_Moskva_1948"
        );
        assert_eq!(cache_stem("模型/名:称"), "______");
        assert_eq!(cache_stem(""), "model");
        let long = "A".repeat(300);
        assert_eq!(cache_stem(&long).len(), 80);
    }

    /// Real-file verification: point WOWSP_MODEL_FIXTURE at any res_mods
    /// `.geometry` (verified against a local PnFMods recolor pack: the hull
    /// family exports base + sections). CI has no fixture, so the test
    /// ignores itself.
    #[test]
    #[ignore = "set WOWSP_MODEL_FIXTURE to a local .geometry to run"]
    fn exports_real_geometry_family() {
        let fixture = std::env::var("WOWSP_MODEL_FIXTURE").expect("fixture path");
        let rel = fixture.replace('\\', "/");
        let game_root = {
            // fixture path is res_mods-absolute in tests only when env points
            // INSIDE a game tree; otherwise treat its parent chain as root.
            std::env::var("WOWSP_MODEL_FIXTURE_GAME_ROOT").expect("game root containing res_mods")
        };
        let parts = mod_hub_read_model(game_root, rel).expect("parts exported");
        assert!(!parts.is_empty());
        for part in &parts {
            assert!(part.path.ends_with(".glb"), "{}", part.path);
            assert!(std::path::Path::new(&part.path).exists());
            let head = fs::read(&part.path).unwrap();
            assert_eq!(&head[..4], b"glTF", "GLB magic on {}", part.rel);
        }
    }
}
