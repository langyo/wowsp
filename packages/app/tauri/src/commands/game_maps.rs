//! Playable-map inventory over a local game install's idx/pkg VFS.
//!
//! The client ships every battle map as a "space" — a directory under
//! `spaces/<space_id>/` inside the `bin/<build>/` idx/pkg store. A space is
//! *playable* when it carries the minimap marker `spaces/<id>/minimap.png`
//! (the same marker `scripts/model_convert/extract_minimaps.py` extracts
//! with; `minimap_water.png` alone is not one — docks/legacy spaces ship it
//! without being selectable maps).
//!
//! [`list_game_maps`] mounts the install's full VFS (all idx files of the
//! latest build that carries an `idx/` dir, over the `res_packages` pkg
//! volumes), walks every path, keeps the minimap markers, and resolves each
//! hit to the REAL on-disk `.pkg` volume file backing it — with that file's
//! modification time so the frontend can tell which install copy is freshest
//! when a space ships in several volumes. Pure extraction/dedupe/sort lives
//! in [`collect_map_entries`] so unit tests cover it without an install.

use std::path::Path;

use serde::Serialize;

/// One playable map found in the install's VFS. Mirrors the frontend
/// `GameMapEntry` interface in `packages/webui/src/api/client.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMapEntry {
    /// Space id, e.g. `20_NE_two_brothers`.
    pub space_id: String,
    /// Virtual VFS path of the minimap marker, e.g.
    /// `spaces/20_NE_two_brothers/minimap.png`.
    pub path: String,
    /// Absolute on-disk path of the `.pkg` volume backing this space.
    pub pkg_path: String,
    /// Backing volume's modification time in ms since the UNIX epoch —
    /// `None` when the volume could not be stat'd.
    pub mtime_ms: Option<i64>,
}

/// Inventory every playable map in the WoWS install at `game_root` (the
/// directory containing `bin/`, as detected by `detect_game_install`).
/// Desktop only — a phone has no game install.
#[tauri::command]
pub async fn list_game_maps(game_root: String) -> Result<Vec<GameMapEntry>, String> {
    // A phone has no install to inventory; answer with a clean error instead
    // of the misleading "no bin/ version dir" one. Exactly one of the two
    // bodies compiles per target — same structure as gameparams.rs.
    #[cfg(mobile)]
    {
        let _ = game_root;
        return Err("战术分析需要本地游戏客户端。".into());
    }
    #[cfg(desktop)]
    {
        // Mounting the VFS walks a few hundred MB of idx structures — keep
        // it off the async runtime threads (same as gameparams.rs).
        let root = game_root.clone();
        tokio::task::spawn_blocking(move || list_game_maps_from_install(&root))
            .await
            .map_err(|e| format!("地图清点任务异常退出：{e}"))?
    }
}

/// Synchronous core of [`list_game_maps`]: mount the install's VFS and
/// resolve every `spaces/<id>/minimap.png` marker to its backing volume.
#[cfg(desktop)]
fn list_game_maps_from_install(game_root: &str) -> Result<Vec<GameMapEntry>, String> {
    use std::fs;

    use wowsunpack::data::idx;
    use wowsunpack::data::idx_vfs::{IdxVfs, VfsEntryMeta};
    use wowsunpack::data::wrappers::mmap::MmapPkgSource;

    let root = Path::new(game_root);
    if !root.join("bin").is_dir() {
        return Err(format!(
            "游戏目录无效：{game_root}（应包含 bin/ 子目录）。请在设置中重新指定游戏安装路径。"
        ));
    }

    // The newest build actually carrying idx/ index files (same rule the
    // GameParams unpacker uses — Steam installs keep several builds around).
    let build = super::gameparams::latest_build_with_idx(root).ok_or_else(|| {
        format!("在 {game_root}\\bin 下未找到带 idx/ 的版本目录，无法读取游戏资源索引。")
    })?;

    // Load every idx of the build, tolerating individual parse failures (a
    // game mid-update or an exotic index must not sink the whole inventory —
    // mirrors `build_game_vfs_for_build`'s loop). Hard-fail only when NOTHING
    // parsed.
    let idx_dir = root.join("bin").join(build.to_string()).join("idx");
    let mut idx_files = Vec::new();
    let mut idx_errors: Vec<(String, String)> = Vec::new();
    let dir_entries =
        fs::read_dir(&idx_dir).map_err(|e| format!("读取 idx 目录失败（{idx_dir:?}）：{e}"))?;
    for entry in dir_entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        match fs::read(entry.path()) {
            Ok(data) => match idx::parse(&data) {
                Ok(parsed) => idx_files.push(parsed),
                Err(e) => idx_errors.push((name, e.to_string())),
            },
            Err(e) => idx_errors.push((name, e.to_string())),
        }
    }
    if idx_files.is_empty() {
        let detail = idx_errors
            .iter()
            .map(|(n, e)| format!("{n}: {e}"))
            .collect::<Vec<_>>()
            .join("；");
        return Err(format!("build {build} 的 idx 文件全部解析失败：{detail}"));
    }

    let pkgs_dir = root.join("res_packages");
    if !pkgs_dir.exists() {
        return Err(format!(
            "res_packages 目录缺失：{}（游戏安装不完整或正在更新）。请稍后重试或重新指定安装路径。",
            pkgs_dir.display()
        ));
    }

    // The mmap source is only constructed to satisfy the VFS — the walk below
    // reads index structures, never volume bytes, so no .pkg is opened here.
    let source = MmapPkgSource::new(&pkgs_dir);
    let vfs = IdxVfs::new(source, &idx_files);

    // Collect (virtual path, backing volume) for every minimap marker. A
    // space may appear in several idx files/volumes; dedupe below.
    let mut marker_hits: Vec<(String, String)> = Vec::new();
    for (path, meta) in vfs.paths() {
        if let VfsEntryMeta::File(file) = meta
            && space_id_from_minimap_path(path).is_some()
        {
            marker_hits.push((path.to_string(), file.volume_filename.to_string()));
        }
    }

    // Stat each volume at most once (one volume backs dozens of spaces):
    // on-disk path + mtime in ms, or None when the file is missing/unreadable.
    Ok(collect_map_entries(marker_hits, &pkgs_dir, |volume| {
        let pkg_path = pkgs_dir.join(volume);
        let modified = fs::metadata(&pkg_path).ok()?.modified().ok()?;
        let millis = i64::try_from(
            modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis(),
        )
        .ok()?;
        Some((pkg_path.to_string_lossy().into_owned(), millis))
    }))
}

/// Byte-wise equivalent of the anchored regex `^spaces/([^/]+)/minimap\.png$`
/// — the playable-space marker. Rejects the water background
/// (`minimap_water.png`), nested ids (`spaces/a/b/minimap.png`), and any
/// non-root-anchored spelling.
#[cfg(desktop)]
fn space_id_from_minimap_path(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("spaces/")?;
    let id = rest.strip_suffix("/minimap.png")?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    Some(id)
}

/// Pure core of the inventory: extract space ids from (path, volume) hits,
/// dedupe by space id — keeping the entry whose backing volume has the
/// NEWEST mtime (unknown mtimes rank oldest; ties break by the greater VFS
/// path, deterministic though in practice the path is a pure function of the
/// space id) — and return the entries sorted by space id (byte-wise).
///
/// `stat` resolves a volume name to `(on-disk path, mtime ms)`; returning
/// `None` keeps the entry with `pkg_path` filled from `pkgs_dir.join(volume)`
/// and `mtime_ms: null`. Touches no disk itself — `stat` does — so tests can
/// drive it with in-memory fixtures.
#[cfg(desktop)]
fn collect_map_entries(
    hits: impl IntoIterator<Item = (String, String)>,
    pkgs_dir: &Path,
    stat: impl Fn(&str) -> Option<(String, i64)>,
) -> Vec<GameMapEntry> {
    use std::collections::HashMap;

    // Memoized per-volume stats: one volume backs dozens of spaces.
    let mut stats: HashMap<String, Option<(String, i64)>> = HashMap::new();
    // space_id -> best (path, volume, mtime ms) so far.
    let mut best: HashMap<String, (String, String, Option<i64>)> = HashMap::new();

    for (path, volume) in hits {
        let Some(space_id) = space_id_from_minimap_path(&path) else {
            continue;
        };
        let mtime_ms = stats
            .entry(volume.clone())
            .or_insert_with(|| stat(&volume))
            .as_ref()
            .map(|(_, ms)| *ms);
        let space_id = space_id.to_string();
        let newer = match best.get(&space_id) {
            None => true,
            Some((cur_path, _, cur_mtime)) => {
                let cur_key = (cur_mtime.unwrap_or(i64::MIN), cur_path.as_str());
                let new_key = (mtime_ms.unwrap_or(i64::MIN), path.as_str());
                new_key > cur_key
            },
        };
        if newer {
            best.insert(space_id, (path, volume, mtime_ms));
        }
    }

    let mut entries: Vec<GameMapEntry> = best
        .into_iter()
        .map(|(space_id, (path, volume, mtime_ms))| {
            let pkg_path = match stats.get(&volume).cloned().flatten() {
                Some((pkg_path, _)) => pkg_path,
                // Stat failed (or the volume vanished mid-run): keep the
                // entry, pkg path filled from the join, mtime unknown.
                None => pkgs_dir.join(&volume).to_string_lossy().into_owned(),
            };
            GameMapEntry {
                space_id,
                path,
                pkg_path,
                mtime_ms,
            }
        })
        .collect();
    entries.sort_by(|a, b| a.space_id.cmp(&b.space_id));
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, volume: &str) -> (String, String) {
        (path.to_string(), volume.to_string())
    }

    // ── space-id extraction ───────────────────────────────────────────────

    #[test]
    fn extracts_space_id_from_minimap_path() {
        assert_eq!(
            space_id_from_minimap_path("spaces/20_NE_two_brothers/minimap.png"),
            Some("20_NE_two_brothers")
        );
        assert_eq!(
            space_id_from_minimap_path("spaces/dock_den/minimap.png"),
            Some("dock_den")
        );
    }

    #[test]
    fn water_nested_and_unanchored_paths_do_not_match() {
        // The water background is not the playable-space marker.
        assert_eq!(
            space_id_from_minimap_path("spaces/20_NE_two_brothers/minimap_water.png"),
            None
        );
        // Directory separators inside the id → not a single space segment.
        assert_eq!(space_id_from_minimap_path("spaces/a/b/minimap.png"), None);
        // Must be anchored at the VFS root.
        assert_eq!(
            space_id_from_minimap_path("content/spaces/x/minimap.png"),
            None
        );
        // No trailing content, and no empty id.
        assert_eq!(space_id_from_minimap_path("spaces/x/minimap.png.bak"), None);
        assert_eq!(space_id_from_minimap_path("spaces//minimap.png"), None);
    }

    // ── dedupe / sort / stat-fallback ─────────────────────────────────────

    #[test]
    fn dedupe_keeps_newest_mtime_volume() {
        let entries = collect_map_entries(
            [
                hit("spaces/20_NE_two_brothers/minimap.png", "content_0.pkg"),
                hit("spaces/20_NE_two_brothers/minimap.png", "content_41.pkg"),
            ],
            Path::new("G:/game/res_packages"),
            |volume| match volume {
                "content_0.pkg" => Some(("G:/pkg/content_0.pkg".into(), 1_000)),
                "content_41.pkg" => Some(("G:/pkg/content_41.pkg".into(), 2_000)),
                _ => None,
            },
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].space_id, "20_NE_two_brothers");
        assert_eq!(entries[0].pkg_path, "G:/pkg/content_41.pkg");
        assert_eq!(entries[0].mtime_ms, Some(2_000));
    }

    #[test]
    fn known_mtime_beats_unknown() {
        let entries = collect_map_entries(
            [
                hit("spaces/x/minimap.png", "unknown.pkg"),
                hit("spaces/x/minimap.png", "known.pkg"),
            ],
            Path::new("G:/game/res_packages"),
            |volume| (volume == "known.pkg").then(|| ("G:/pkg/known.pkg".into(), 5)),
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pkg_path, "G:/pkg/known.pkg");
        assert_eq!(entries[0].mtime_ms, Some(5));
    }

    #[test]
    fn stat_failure_keeps_joined_path_with_null_mtime() {
        let entries = collect_map_entries(
            [hit("spaces/15_NE_north/minimap.png", "missing.pkg")],
            Path::new("G:/game/res_packages"),
            |_| None,
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].space_id, "15_NE_north");
        assert_eq!(entries[0].path, "spaces/15_NE_north/minimap.png");
        assert_eq!(entries[0].mtime_ms, None);
        // pkg path still filled from the joined fallback.
        assert!(entries[0].pkg_path.contains("res_packages"));
        assert!(entries[0].pkg_path.ends_with("missing.pkg"));
    }

    #[test]
    fn entries_sorted_byte_wise_by_space_id() {
        let entries = collect_map_entries(
            [
                hit("spaces/3_domains/minimap.png", "a.pkg"),
                hit("spaces/20_NE_two_brothers/minimap.png", "a.pkg"),
                hit("spaces/100_NE_ocean/minimap.png", "a.pkg"),
            ],
            Path::new("G:/game/res_packages"),
            |_| Some(("G:/pkg/a.pkg".into(), 1)),
        );
        let ids: Vec<&str> = entries.iter().map(|e| e.space_id.as_str()).collect();
        // Byte-wise: "1…" < "2…" < "3…" (no numeric awareness).
        assert_eq!(ids, ["100_NE_ocean", "20_NE_two_brothers", "3_domains"]);
    }

    #[test]
    fn non_marker_paths_are_dropped_by_the_pure_core() {
        let entries = collect_map_entries(
            [
                hit("spaces/x/minimap_water.png", "a.pkg"),
                hit("content/GameParams.data", "a.pkg"),
                hit("spaces/x/minimap.png", "a.pkg"),
            ],
            Path::new("G:/game/res_packages"),
            |_| None,
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].space_id, "x");
    }

    // ── wire shape ────────────────────────────────────────────────────────

    #[test]
    fn serializes_camel_case_fields() {
        let entry = GameMapEntry {
            space_id: "20_NE_two_brothers".into(),
            path: "spaces/20_NE_two_brothers/minimap.png".into(),
            pkg_path: "G:/pkg/content_41.pkg".into(),
            mtime_ms: Some(1),
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v.get("spaceId").is_some(), "{v}");
        assert!(v.get("path").is_some(), "{v}");
        assert!(v.get("pkgPath").is_some(), "{v}");
        assert!(v.get("mtimeMs").is_some(), "{v}");
        // And null round-trips for the unknown-mtime case.
        let entry = GameMapEntry {
            mtime_ms: None,
            ..entry
        };
        assert!(
            serde_json::to_value(&entry)
                .unwrap()
                .get("mtimeMs")
                .unwrap()
                .is_null()
        );
    }

    // ── real-install smoke (dev machine only) ─────────────────────────────

    /// End-to-end smoke against a real install: mount the VFS, inventory the
    /// minimap markers, and check every entry resolves to an existing volume.
    /// Guarded by WOWSP_GAME_PATH so CI skips it — same pattern as
    /// gameparams' `smoke_unpack_from_real_install`.
    #[test]
    #[ignore = "manual: requires a local game install; set WOWSP_GAME_PATH to run"]
    fn smoke_list_game_maps_from_real_install() {
        let root = std::env::var("WOWSP_GAME_PATH").expect("WOWSP_GAME_PATH");
        let maps = list_game_maps_from_install(&root).expect("list_game_maps");
        eprintln!("[smoke] {} playable maps", maps.len());
        assert!(!maps.is_empty());

        let mut ids: Vec<&str> = Vec::with_capacity(maps.len());
        for m in &maps {
            assert_eq!(
                space_id_from_minimap_path(&m.path),
                Some(m.space_id.as_str()),
                "path/space-id mismatch: {}",
                m.path
            );
            assert!(
                Path::new(&m.pkg_path).exists(),
                "backing volume missing: {}",
                m.pkg_path
            );
            ids.push(&m.space_id);
        }
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "entries must be sorted by space id");
        eprintln!("[smoke] first = {:?}", maps.first());
    }
}
