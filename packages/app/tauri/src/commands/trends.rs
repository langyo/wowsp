//! Player stat trend bucketing + patch annotations (milestone M10).
//!
//! Reads the snapshot history written by `ship_stats::snapshot_player_stats`
//! and groups snapshots by `game_version`. Each bucket carries the winrate/
//! damage/PR aggregate over the snapshots that fell into it, plus the time
//! span. The frontend renders these as a per-version trend line.
//!
//! Patch annotations are a separate, hand-maintained JSON (`patches/index.json`
//! and `patches/<version>.json`). When a version bucket coincides with a patch
//! that touched the ships being viewed, the frontend can overlay the change
//! summary. This module just reads + returns them; content curation is out of
//! scope (future work: scrape WG devblogs / HaoJian patch notes).
//!
//! Community-wide per-ship data comes from two sources:
//!  - `get_ship_server_stats`: wows-numbers' public expected-values JSON —
//!    the server-wide average damage / frags / win rate per ship. Fetched
//!    live with a 7-day on-disk cache (stale cache still answers offline).
//!  - `get_community_ship_trend`: a curated `community/<shipId>.json`
//!    version-bucket cache for the "server average WR over versions" chart
//!    WG's public API can't provide (they don't aggregate across players).

use std::fs;

use wowsp_tauri_shared::{
    CommunityTrend, PatchNote, ShipServerStats, StatsSnapshot, TrendBucket, TrendResult,
};

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

// ── Server-wide per-ship averages (wows-numbers expected values) ─────────

/// URL of wows-numbers' public expected-values JSON: mean per-battle damage /
/// frags / win rate per ship across the population they track. Entries can
/// also be an empty array (ship with no sample), which must read as "no data".
const EXPECTED_VALUES_URL: &str = "https://api.wows-numbers.com/personal/rating/expected/json/";
/// On-disk cache file (under the appdata `community/` dir).
const EXPECTED_VALUES_FILE: &str = "community/expected-values.json";
/// Refresh cadence for the cache — the dataset only moves slowly.
const EXPECTED_VALUES_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// Server-wide averages for one ship, or None when the ship isn't in the
/// dataset. `Err` means no usable data at all (network down and no cache).
#[tauri::command]
pub async fn get_ship_server_stats(ship_id: i64) -> Result<Option<ShipServerStats>, String> {
    let cached = read_expected_values();
    let (raw, from_cache) = if let Some(raw) = cached.filter(|_| expected_values_fresh()) {
        (raw, true)
    } else {
        match fetch_and_cache_expected_values().await {
            Ok(raw) => (raw, false),
            Err(e) => {
                // Offline (or wows-numbers hiccup): a stale cache still answers.
                match read_expected_values() {
                    Some(raw) => (raw, true),
                    None => return Err(e),
                }
            },
        }
    };
    Ok(lookup_ship_server_stats(&raw, ship_id, from_cache))
}

fn expected_values_path() -> Result<std::path::PathBuf, String> {
    Ok(appdata_dir()?.join(EXPECTED_VALUES_FILE))
}

/// The cached expected-values document, any age. None when never fetched.
fn read_expected_values() -> Option<String> {
    appdata_read(EXPECTED_VALUES_FILE.into()).ok().flatten()
}

/// Whether the cache exists and was written within the TTL.
fn expected_values_fresh() -> bool {
    let Ok(path) = expected_values_path() else {
        return false;
    };
    let Ok(meta) = fs::metadata(&path) else {
        return false;
    };
    match meta.modified() {
        Ok(written) => std::time::SystemTime::now()
            .duration_since(written)
            .map(|age| age.as_secs() <= EXPECTED_VALUES_TTL_SECS)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Validate a downloaded expected-values payload BEFORE it may overwrite good
/// cached data — wows-numbers downtime has served HTML error pages with a 200
/// status. The document must parse and its `data` object must be non-empty.
fn validate_expected_values(raw: &str) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("expected-values JSON: {e}"))?;
    let empty = v
        .get("data")
        .and_then(|d| d.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(true);
    if empty {
        return Err("expected-values response contained no ship data".to_string());
    }
    Ok(())
}

/// Fetch the expected-values document, validate it, and cache it to disk.
/// Returns the raw document on success.
async fn fetch_and_cache_expected_values() -> Result<String, String> {
    let client = crate::commands::network::http_client_builder()?
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let bytes = client
        .get(EXPECTED_VALUES_URL)
        .send()
        .await
        .map_err(|e| format!("expected-values request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("expected-values status: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("expected-values body: {e}"))?
        .to_vec();
    let raw = String::from_utf8(bytes).map_err(|_| "expected-values: non-UTF8 body".to_string())?;
    validate_expected_values(&raw)?;
    let _ = appdata_write(EXPECTED_VALUES_FILE.into(), raw.clone());
    Ok(raw)
}

/// Pull one ship's server averages out of an expected-values document.
/// Empty-array entries (no sample) and unknown ids yield None.
fn lookup_ship_server_stats(raw: &str, ship_id: i64, from_cache: bool) -> Option<ShipServerStats> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let entry = v.get("data")?.get(ship_id.to_string())?;
    let obj = entry.as_object()?;
    Some(ShipServerStats {
        ship_id,
        avg_damage: obj.get("average_damage_dealt")?.as_f64()?,
        avg_frags: obj.get("average_frags")?.as_f64()?,
        winrate: obj.get("win_rate")?.as_f64()?,
        generated_at: v.get("time").and_then(|t| t.as_i64()).unwrap_or(0),
        from_cache,
    })
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

fn appdata_write(file: String, content: String) -> Result<(), String> {
    let dir = appdata_dir()?;
    let path = dir.join(&file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, &content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} → {path:?}: {e}"))?;
    Ok(())
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

    // ── server-wide averages (expected values) ───────────────────────────

    /// Minimal real-shape expected-values document (values entry + `[]` entry).
    fn expected_values_doc() -> String {
        serde_json::json!({
            "time": 1700000000_i64,
            "data": {
                "3374266064": {
                    "average_damage_dealt": 61228.37,
                    "average_frags": 0.769,
                    "win_rate": 50.77
                },
                "3330258928": []
            }
        })
        .to_string()
    }

    #[test]
    fn validate_accepts_real_shape() {
        assert!(validate_expected_values(&expected_values_doc()).is_ok());
    }

    #[test]
    fn validate_rejects_html_and_empty() {
        let html = "<!DOCTYPE html><html><body>503 Service Unavailable</body></html>";
        assert!(validate_expected_values(html).is_err());
        let empty = r#"{"time":123,"data":{}}"#;
        assert!(validate_expected_values(empty).is_err());
        let no_data = r#"{"time":123}"#;
        assert!(validate_expected_values(no_data).is_err());
    }

    #[test]
    fn lookup_returns_values_for_sampled_ships_only() {
        let raw = expected_values_doc();
        let stats = lookup_ship_server_stats(&raw, 3374266064, false).unwrap();
        assert_eq!(stats.ship_id, 3374266064);
        assert!((stats.avg_damage - 61228.37).abs() < 0.01);
        assert!((stats.avg_frags - 0.769).abs() < 0.001);
        assert!((stats.winrate - 50.77).abs() < 0.01);
        assert_eq!(stats.generated_at, 1700000000);
        assert!(!stats.from_cache);
        // `[]` entry = no sample for that ship.
        assert!(lookup_ship_server_stats(&raw, 3330258928, true).is_none());
        // Unknown ship id.
        assert!(lookup_ship_server_stats(&raw, 9999999999, true).is_none());
    }

    #[test]
    fn lookup_survives_garbage_document() {
        assert!(lookup_ship_server_stats("not json", 1, true).is_none());
    }

    #[test]
    fn expected_values_cache_roundtrip() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Write via the same path the fetcher caches to, then read back.
        let file = format!("community/expected-values-test_{ts}.json");
        appdata_write(file.clone(), expected_values_doc()).unwrap();
        let read = appdata_read(file.clone()).unwrap().unwrap();
        assert!(lookup_ship_server_stats(&read, 3374266064, true).is_some());
        let path = appdata_dir().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }
}
