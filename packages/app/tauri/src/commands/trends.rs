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

use super::appdata::{appdata_dir_path, read_appdata_json, write_appdata_json};

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
    if let Ok(Some(raw)) = read_appdata_json(&file) {
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
    let (raw, from_cache) = expected_values_document().await?;
    Ok(lookup_ship_server_stats(&raw, ship_id, from_cache))
}

/// Resolve the expected-values document: the on-disk cache when fresh, else a
/// download (validated before it may overwrite the cache), else a stale cache
/// when offline. Returns the raw document and whether it was served from the
/// cache. Shared by `get_ship_server_stats` and the expected PR algorithm in
/// `wg_api` (`load_expected_values`) so both see the same 7-day cadence.
async fn expected_values_document() -> Result<(String, bool), String> {
    if let Some(raw) = read_expected_values().filter(|_| expected_values_fresh()) {
        return Ok((raw, true));
    }
    match fetch_and_cache_expected_values().await {
        Ok(raw) => Ok((raw, false)),
        // Offline (or wows-numbers hiccup): a stale cache still answers.
        Err(e) => match read_expected_values() {
            Some(raw) => Ok((raw, true)),
            None => Err(e),
        },
    }
}

/// Expected (server-wide average) values for one ship, as served by
/// wows-numbers. `win_rate` is in percent — their raw field.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ExpectedValues {
    pub(crate) average_damage_dealt: f64,
    pub(crate) average_frags: f64,
    pub(crate) win_rate: f64,
}

/// Parse a raw expected-values document into a { ship_id → expected } map.
/// Empty-array entries (ship with no sample) and rows missing a field are
/// simply absent — the PR math treats "not in the table" as "no rating".
pub(crate) fn parse_expected_values(
    raw: &str,
) -> Option<std::collections::HashMap<i64, ExpectedValues>> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let data = v.get("data")?.as_object()?;
    let mut map = std::collections::HashMap::with_capacity(data.len());
    for (key, entry) in data {
        let Ok(id) = key.parse::<i64>() else {
            continue;
        };
        let Some(obj) = entry.as_object() else {
            continue; // `[]` = no sample for this ship
        };
        let (Some(average_damage_dealt), Some(average_frags), Some(win_rate)) = (
            obj.get("average_damage_dealt").and_then(|x| x.as_f64()),
            obj.get("average_frags").and_then(|x| x.as_f64()),
            obj.get("win_rate").and_then(|x| x.as_f64()),
        ) else {
            continue;
        };
        map.insert(
            id,
            ExpectedValues {
                average_damage_dealt,
                average_frags,
                win_rate,
            },
        );
    }
    Some(map)
}

/// The expected-values table for the wows-numbers PR algorithm (see
/// `wg_api::expected_account_pr`): fresh cache, else download + cache, else
/// stale cache. None when there is no usable data at all (offline and never
/// fetched) — callers degrade to "no PR" instead of failing their command.
pub(crate) async fn load_expected_values() -> Option<std::collections::HashMap<i64, ExpectedValues>>
{
    let (raw, _) = expected_values_document().await.ok()?;
    parse_expected_values(&raw)
}

fn expected_values_path() -> Result<std::path::PathBuf, String> {
    Ok(appdata_dir_path()?.join(EXPECTED_VALUES_FILE))
}

/// The cached expected-values document, any age. None when never fetched.
fn read_expected_values() -> Option<String> {
    read_appdata_json(EXPECTED_VALUES_FILE).ok().flatten()
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
    let _ = write_appdata_json(EXPECTED_VALUES_FILE, &raw);
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

fn mean(xs: &[f32]) -> f32 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.iter().sum::<f32>() / xs.len() as f32
}

/// Read `patches/index.json`. Returns an empty vec if absent (the default
/// state — no patches curated yet).
fn read_patch_index() -> Result<Vec<PatchNote>, String> {
    match read_appdata_json("patches/index.json")? {
        Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        None => Ok(Vec::new()),
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
    fn parse_expected_values_maps_sampled_ships_only() {
        let map = parse_expected_values(&expected_values_doc()).unwrap();
        let ev = map.get(&3374266064).expect("sampled ship present");
        assert!((ev.average_damage_dealt - 61228.37).abs() < 0.01);
        assert!((ev.average_frags - 0.769).abs() < 0.001);
        assert!((ev.win_rate - 50.77).abs() < 0.01);
        // `[]` entry (no sample) and unknown ids are absent, not zeroed —
        // "not in the table" must read as "no rating".
        assert!(!map.contains_key(&3330258928));
        assert!(!map.contains_key(&9999999999));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn parse_expected_values_survives_garbage() {
        assert!(parse_expected_values("not json").is_none());
        assert!(parse_expected_values(r#"{"time":123}"#).is_none());
        // An empty data object parses to an empty table (callers treat every
        // ship as unrated); the fetch-side validator rejects such a download
        // before it can reach the cache, so this only arises from a
        // hand-edited cache file.
        assert!(
            parse_expected_values(r#"{"time":123,"data":{}}"#)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn expected_values_cache_roundtrip() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Write via the same path the fetcher caches to, then read back.
        let file = format!("community/expected-values-test_{ts}.json");
        write_appdata_json(&file, &expected_values_doc()).unwrap();
        let read = read_appdata_json(&file).unwrap().unwrap();
        assert!(lookup_ship_server_stats(&read, 3374266064, true).is_some());
        let path = appdata_dir_path().unwrap().join(&file);
        let _ = fs::remove_file(&path);
    }
}
