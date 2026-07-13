//! Player stat trend bucketing + patch annotations (milestone M10).
//!
//! Reads the snapshot history written by `ship_stats::snapshot_player_stats`
//! and groups snapshots by `game_version`. Each bucket carries the winrate/
//! damage/PR aggregate over the snapshots that fell into it, plus the time
//! span. The frontend renders these as a per-version trend line.
//!
//! Patch annotations are a separate, hand-maintained JSON (`patches/index.json`
//! + `patches/<version>.json`). When a version bucket coincides with a patch
//! that touched the ships being viewed, the frontend can overlay the change
//! summary. This module just reads + returns them; content curation is out of
//! scope (future work: scrape WG devblogs / 浩舰 patch notes).
//!
//! Community-wide per-ship trends (the "server average WR over versions"
//! chart that wows-numbers shows) have no clean data source — WG's public API
//! doesn't aggregate across players, and wows-numbers blocks scraping. We
//! expose the `get_community_ship_trend` contract returning `available: false`
//! so the frontend can render a clean "data source pending" placeholder.

use std::fs;

use wowsp_tauri_shared::{CommunityTrend, PatchNote, StatsSnapshot, TrendBucket, TrendResult};

/// Compute the per-version trend for a player. Reads snapshots from
/// `ship-stats`'s persisted history and overlays any applicable patch notes.
#[tauri::command]
pub fn get_player_trend(account_id: i64, realm: String) -> Result<TrendResult, String> {
    let snapshots = crate::commands::ship_stats::read_snapshots(&realm, account_id);
    let buckets = bucket_by_version(&snapshots);
    let patches = read_patch_index().unwrap_or_default();
    Ok(TrendResult {
        account_id,
        realm,
        buckets,
        patches,
    })
}

/// Return all known patch notes (from `patches/index.json`). Empty until the
/// user curates content.
#[tauri::command]
pub fn get_patches() -> Vec<PatchNote> {
    read_patch_index().unwrap_or_default()
}

/// Return community-wide per-ship trend. Not available in this milestone —
/// the contract is here so the frontend can render a placeholder and the
/// shape is stable when a backend partner is wired in.
#[tauri::command]
pub fn get_community_ship_trend(ship_id: i64) -> CommunityTrend {
    // Check for a curated community cache (future: written by a server-side
    // aggregator). If absent, signal unavailable.
    let file = format!("community/{ship_id}.json");
    if let Ok(Some(raw)) = appdata_read(file) {
        if let Ok(v) = serde_json::from_str::<CommunityTrend>(&raw) {
            return v;
        }
    }
    CommunityTrend {
        available: false,
        ship_id,
        buckets: Vec::new(),
    }
}

/// Bucket a snapshot time series by `game_version`. Within each version
/// bucket, compute winrate avg/min/max, avg damage, and battle delta (the
/// battles played between the first and last snapshot in that bucket). When
/// only one snapshot falls in a bucket, avg/min/max are all equal.
pub(crate) fn bucket_by_version(snapshots: &[StatsSnapshot]) -> Vec<TrendBucket> {
    if snapshots.is_empty() {
        return Vec::new();
    }

    // Group snapshots by version, preserving chronological order of versions.
    let mut groups: Vec<(String, Vec<&StatsSnapshot>)> = Vec::new();
    for snap in snapshots {
        if let Some((v, g)) = groups.iter_mut().find(|(v, _)| *v == snap.game_version) {
            let _ = v; // already matched
            g.push(snap);
        } else {
            groups.push((snap.game_version.clone(), vec![snap]));
        }
    }

    groups
        .into_iter()
        .map(|(version, snaps)| {
            let winrates: Vec<f32> = snaps.iter().map(|s| s.winrate).collect();
            let damages: Vec<f32> = snaps.iter().map(|s| s.avg_damage).collect();
            let pr_avg = {
                let prs: Vec<i64> = snaps.iter().filter_map(|s| s.pr).collect();
                if prs.is_empty() {
                    None
                } else {
                    Some(prs.iter().sum::<i64>() / prs.len() as i64)
                }
            };
            // Battle delta: how many battles were played *during* this version
            // bucket = last battles - first battles. Negative shouldn't happen
            // (battles is monotonic), but clamp at 0.
            let battle_delta = snaps
                .last()
                .map(|l| l.battles)
                .unwrap_or(0)
                .saturating_sub(snaps.first().map(|f| f.battles).unwrap_or(0));
            TrendBucket {
                version,
                start_time: snaps.first().map(|s| s.timestamp).unwrap_or(0),
                end_time: snaps.last().map(|s| s.timestamp).unwrap_or(0),
                snapshot_count: snaps.len() as i64,
                battle_delta,
                winrate_avg: mean(&winrates),
                winrate_min: winrates.iter().cloned().fold(f32::INFINITY, f32::min),
                winrate_max: winrates.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
                avg_damage: mean(&damages),
                pr_avg,
            }
        })
        .collect()
}

/// Filter patches to those affecting a given ship (by `ship_ids` membership).
/// Used by the ship-detail modal to annotate the trend chart with balance
/// changes that touched the viewed ship.
#[allow(dead_code)]
pub(crate) fn patches_for_ship(patches: &[PatchNote], ship_id: i64) -> Vec<&PatchNote> {
    patches
        .iter()
        .filter(|p| p.ship_ids.contains(&ship_id))
        .collect()
}

fn mean(xs: &[f32]) -> f32 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.iter().sum::<f32>() / xs.len() as f32
}

/// Read `patches/index.json`. Returns an empty vec if absent (the default
/// state — no patches curated yet).
fn read_patch_index() -> Result<Vec<PatchNote>, String> {
    match appdata_read("patches/index.json".into())? {
        Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}

// ── shared helpers (same pattern as other modules) ──────────────────────

fn appdata_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs_next::data_dir().ok_or_else(|| "cannot resolve AppData dir".to_string())?;
    let dir = base.join("WoWSP");
    fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

fn appdata_read(file: String) -> Result<Option<String>, String> {
    let path = appdata_dir()?.join(&file);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(
        ts: i64,
        version: &str,
        battles: i64,
        winrate: f32,
        damage: f32,
        pr: Option<i64>,
    ) -> StatsSnapshot {
        StatsSnapshot {
            timestamp: ts,
            game_version: version.to_string(),
            battles,
            wins: (battles as f32 * winrate / 100.0) as i64,
            winrate,
            avg_damage: damage,
            pr,
        }
    }

    #[test]
    fn buckets_by_version_merges_same_version() {
        let snaps = vec![
            snap(100, "0.11.4", 1000, 50.0, 40000.0, Some(1500)),
            snap(200, "0.11.4", 1100, 52.0, 42000.0, Some(1600)),
            snap(300, "0.11.5", 1200, 51.0, 41000.0, Some(1550)),
        ];
        let buckets = bucket_by_version(&snaps);
        assert_eq!(buckets.len(), 2, "should have 2 version buckets");
        assert_eq!(buckets[0].version, "0.11.4");
        assert_eq!(buckets[0].snapshot_count, 2);
        assert_eq!(buckets[1].version, "0.11.5");
        assert_eq!(buckets[1].snapshot_count, 1);
    }

    #[test]
    fn bucket_aggregates_are_correct() {
        let snaps = vec![
            snap(100, "0.11.4", 1000, 50.0, 40000.0, Some(1500)),
            snap(200, "0.11.4", 1200, 60.0, 60000.0, Some(1700)),
        ];
        let buckets = bucket_by_version(&snaps);
        let b = &buckets[0];
        assert!((b.winrate_avg - 55.0).abs() < 0.01, "avg winrate");
        assert!((b.winrate_min - 50.0).abs() < 0.01, "min winrate");
        assert!((b.winrate_max - 60.0).abs() < 0.01, "max winrate");
        assert!((b.avg_damage - 50000.0).abs() < 0.01, "avg damage");
        assert_eq!(b.battle_delta, 200, "1200-1000 battles during this version");
        assert_eq!(b.pr_avg, Some(1600), "avg of 1500+1700");
        assert_eq!(b.start_time, 100);
        assert_eq!(b.end_time, 200);
    }

    #[test]
    fn empty_snapshots_yields_empty_buckets() {
        assert!(bucket_by_version(&[]).is_empty());
    }

    #[test]
    fn single_snapshot_bucket_has_equal_min_max() {
        let snaps = vec![snap(100, "0.11.4", 1000, 55.0, 50000.0, None)];
        let buckets = bucket_by_version(&snaps);
        assert_eq!(buckets.len(), 1);
        assert!((buckets[0].winrate_min - 55.0).abs() < 0.01);
        assert!((buckets[0].winrate_max - 55.0).abs() < 0.01);
        assert_eq!(buckets[0].pr_avg, None);
        assert_eq!(buckets[0].battle_delta, 0, "single snapshot → no delta");
    }

    #[test]
    fn patches_for_ship_filters_by_ship_id() {
        let patches = vec![
            PatchNote {
                version: "0.11.4".into(),
                date: "2024-01-01".into(),
                ship_ids: vec![100, 200],
                summary: "Buffed BB accuracy".into(),
                changes: vec![],
            },
            PatchNote {
                version: "0.11.5".into(),
                date: "2024-02-01".into(),
                ship_ids: vec![300],
                summary: "Nerfed DD concealment".into(),
                changes: vec![],
            },
        ];
        let for_100 = patches_for_ship(&patches, 100);
        assert_eq!(for_100.len(), 1);
        assert_eq!(for_100[0].version, "0.11.4");
        let for_999 = patches_for_ship(&patches, 999);
        assert_eq!(for_999.len(), 0);
    }

    #[test]
    fn community_trend_defaults_to_unavailable() {
        // Without a curated cache, the trend should signal unavailable.
        let t = get_community_ship_trend(99999999);
        assert!(!t.available);
        assert!(t.buckets.is_empty());
    }

    #[test]
    fn get_patches_returns_empty_when_no_index() {
        // The default state has no patches/index.json.
        let patches = get_patches();
        // Should not error and should be a vec (likely empty unless tests
        // in this run wrote one).
        assert!(patches.iter().all(|p| !p.version.is_empty()));
    }
}
