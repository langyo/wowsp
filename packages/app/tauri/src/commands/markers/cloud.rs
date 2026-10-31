//! Cloud ban-list markers (云端封禁名单) — automatic yellow "疑似作弊"
//! markers matched against the yuyuko community ban list, CN only.
//!
//! Pipeline (all read-only against the cloud: nothing is ever uploaded):
//!   1. The main window's arena store calls cloud_ban_check when a CN
//!      battle roster appears (tempArenaInfo / probe arena — the vehicle
//!      ids ARE account ids on the WG-family arena file).
//!   2. The command POSTs each uncached account id to the yuyuko ban API
//!      (the service behind wows.mgaia.top/#/banLike; protocol observed
//!      from the MIT-licensed wowsCheaterViewer client) with bounded
//!      concurrency, and caches the answer — negative answers included —
//!      in ban-list.json for a week.
//!   3. A record with BanNameNamesake == 1 counts as a match; matched
//!      players are merged into the markers_list WIRE view as yellow
//!      MarkerSource::Cloud rows (merge_cloud_markers) — never written
//!      into markers.json, which stays the user's purely local list.
//!   4. Every surface that already renders markers (webui panels, the
//!      three bare-DOM overlays, holo beads) picks the yellow up for free;
//!      the wowsp://markers-changed event refreshes the one-shot
//!      copies exactly like a local edit does.
//!   5. A dismissed match (false positive) is a LOCAL judgment: the id
//!      joins the cache's dismissed set and leaves the merged view until
//!      undone — the cloud's word never overrides the user's.
//!
//! Local entries always WIN over cloud matches (both by nickname and by
//! account id — the same precedence the store's lookup contract gives the
//! user's typed judgment). The match itself is a heuristic the source
//! service documents as "可能符合条件" — hence yellow (suspected), never
//! red, and the settings UI carries the disclaimer.

use anyhow::{Result, anyhow};
use futures::stream::{self, StreamExt};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;
use tauri::{Emitter, Manager};

use wowsp_tauri_shared::{
    CloudBanCheckResult, CloudBanConfig, CloudBanEntry, CloudBanMatch, CloudBanPlayer,
    CloudBanRecord, CommandResult, MarkerColor, MarkerEntry, MarkerSource,
};

use crate::commands::appdata::{read_json_in, write_json_in};
use crate::commands::ensure_main_window_label;
use crate::commands::network::HttpPair;
use crate::commands::upstream_health;
use crate::paths;
use crate::settings_store;

use super::store::{MARKERS_CHANGED_EVENT, same_nickname, unix_now};

/// The cache file under the appdata root (data-cache JSON convention).
const BAN_CACHE_FILE: &str = "ban-list.json";
/// The feature toggle (settings-store convention: a small TOML file).
const CONFIG_FILE: &str = "ban-list.toml";
/// Header prepended to the canonical config text (part of the canonical
/// bytes, so a hand-removed header comes back on the next write).
const CONFIG_HEADER: &str = "# WoWSP cloud ban-list (云端封禁名单) settings.\n";

/// The yuyuko ban API — primary v3 host (needs the client-type header) and
/// the documented legacy fallback domain, mirroring wowsCheaterViewer's
/// retry ladder exactly: its ApiClient adds the header only on v3 URLs,
/// so the legacy rung deliberately runs HEADERLESS (verified against the
/// reference client's source).
const API_PRIMARY_HOST: &str = "v3-api.wows.shinoaki.com";
const API_FALLBACK_HOST: &str = "api.wows.yuyuko.dev";
const API_PATH: &str = "/public/wows/ban/cn/user";
const CLIENT_TYPE_HEADER: &str = "Yuyuko-Client-Type";
const CLIENT_TYPE_VALUE: &str = "WEB;01";

/// Politeness cap: the community service publishes no rate limit; 4
/// in-flight mirrors the stats-family batch cap (wg_api/roster.rs).
const QUERY_CONCURRENCY: usize = 4;
/// One cached answer — matched or negative — is fresh for a week: the
/// ban list moves slowly, and a repeated battle must not re-bill the
/// service. Stale entries keep SERVING (a vanished mark is worse than an
/// old one); the TTL only gates when the next battle re-queries.
const CACHE_TTL_SECS: i64 = 7 * 24 * 3600;
/// Upper bound on ids one call may query (a full roster is ~24; a hostile
/// or buggy caller must not drive an unbounded request storm).
const MAX_IDS_PER_CALL: usize = 64;
/// Per-request timeout for the ban API.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Serializes overlapping checks: the arena poll and the watcher push can
/// both fire cloud_ban_check for the same battle — the second caller sees
/// a skipped result instead of duplicating the fan-out (tokio mutex: the
/// guard rides across the query awaits).
static CHECK_GATE: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

// ── cache ────────────────────────────────────────────────────────────────────

/// ban-list.json's shape: per-id answers plus the local dismiss set.
/// BTree ordering keeps the file stable across writes (diff-friendly).
#[derive(Debug, Default, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BanCache {
    #[serde(default)]
    entries: BTreeMap<i64, CloudBanEntry>,
    #[serde(default)]
    dismissed: BTreeSet<i64>,
}

/// Tolerant read: missing/garbage file = empty cache (data-cache JSON
/// convention — the next write heals it).
fn load_cache_from(dir: &Path) -> BanCache {
    read_json_in(dir, BAN_CACHE_FILE)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn store_cache_in(dir: &Path, cache: &BanCache) -> Result<()> {
    let json = serde_json::to_string(cache).map_err(|e| anyhow!("serialize ban cache: {e}"))?;
    write_json_in(dir, BAN_CACHE_FILE, &json)
}

/// Cache housekeeping before a write: NEGATIVE answers older than three
/// TTLs leave (they dominate the file — one row per unique CN player
/// met — and a re-meet simply re-queries), while MATCHED entries survive
/// (dropping one would silently un-mark a cheater; the TTL re-queries
/// those anyway whenever the player is met again).
fn prune_stale_negatives(cache: &mut BanCache, now: i64) {
    let horizon = now - 3 * CACHE_TTL_SECS;
    cache
        .entries
        .retain(|_, e| e.matched || e.fetched_at >= horizon);
}

// ── config ───────────────────────────────────────────────────────────────────

/// The one-key TOML projection: absent file / unparsable line = disabled
/// (the feature is opt-in; a corrupt file must not silently enable it).
fn enabled_from_raw(raw: &str) -> bool {
    for line in raw.lines() {
        let lower = line.trim().to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("enabled") {
            if let Some(value) = rest.trim().strip_prefix('=') {
                return value.trim() == "true";
            }
        }
    }
    false
}

fn load_enabled_from(dir: &Path) -> bool {
    read_json_in(dir, CONFIG_FILE)
        .ok()
        .flatten()
        .map(|raw| enabled_from_raw(&raw))
        .unwrap_or(false)
}

fn store_enabled_in(dir: &Path, enabled: bool) -> Result<()> {
    let text = format!("{CONFIG_HEADER}enabled = {enabled}\n");
    settings_store::store(dir, CONFIG_FILE, &text)
}

// ── the merge into the wire view ─────────────────────────────────────────────

/// Local entries always win; matched-but-dismissed cloud rows never show;
/// empty nicknames cannot match anything. Stale-but-present entries keep
/// serving (the TTL only gates re-queries, never visibility).
pub(crate) fn merge_cloud_markers_in(
    dir: &Path,
    mut markers: Vec<MarkerEntry>,
) -> Vec<MarkerEntry> {
    if !load_enabled_from(dir) {
        return markers;
    }
    let cache = load_cache_from(dir);
    let mut seen_cloud_nicknames: Vec<String> = Vec::new();
    for entry in cache.entries.values() {
        if !entry.matched || cache.dismissed.contains(&entry.account_id) {
            continue;
        }
        if entry.nickname.trim().is_empty() {
            continue;
        }
        // Two accounts CAN carry the same roster nickname (a rename into
        // a taken name) — keep the first so the wire list never holds
        // two rows under one nickname key (the settings list keys by it).
        if seen_cloud_nicknames
            .iter()
            .any(|n| same_nickname(n, &entry.nickname))
        {
            continue;
        }
        let shadowed = markers.iter().any(|m| {
            m.account_id == Some(entry.account_id) || same_nickname(&m.nickname, &entry.nickname)
        });
        if shadowed {
            continue;
        }
        seen_cloud_nicknames.push(entry.nickname.clone());
        markers.push(MarkerEntry {
            nickname: entry.nickname.clone(),
            color: MarkerColor::Yellow,
            note: None,
            account_id: Some(entry.account_id),
            created_at: entry.fetched_at,
            source: Some(MarkerSource::Cloud),
        });
    }
    markers
}

/// merge_cloud_markers_in against the real appdata root — the wrapper
/// every markers command's return value rides through, so the local list
/// and the merged wire view can never drift apart.
pub(crate) fn merge_cloud_markers(markers: Vec<MarkerEntry>) -> Vec<MarkerEntry> {
    match paths::ensure_data_dir() {
        Ok(dir) => merge_cloud_markers_in(&dir, markers),
        Err(_) => markers,
    }
}

// ── the yuyuko query ─────────────────────────────────────────────────────────

/// Extract one optional string field from a raw record value.
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Tolerant raw → record mapping (the wire keeps PascalCase field names;
/// unknown shapes parse as all-empty records instead of failing).
fn record_from_value(v: &serde_json::Value) -> CloudBanRecord {
    CloudBanRecord {
        ban_name: str_field(v, "BanName"),
        user_name: str_field(v, "UserName"),
        ban_time: str_field(v, "BanTime"),
        record_time: str_field(v, "RecordTime"),
        namesake: v
            .get("BanNameNamesake")
            .and_then(|n| n.as_i64())
            .unwrap_or(0),
    }
}

/// Parse one successful HTTP body into a cache entry. The service's own
/// "matched" signal is a namesake count of exactly 1 (ambiguous counts
/// are NOT matches — the upstream viewer colours those nothing).
fn entry_from_body(
    account_id: i64,
    nickname: &str,
    body: &serde_json::Value,
    now: i64,
) -> Result<CloudBanEntry> {
    // The envelope always carries a numeric code; only a MISSING key
    // defaults to success (a present-but-unparseable code is an error —
    // caching a garbled failure as a 7-day negative would be worse).
    let code = match body.get("code") {
        Some(v) => v
            .as_i64()
            .ok_or_else(|| anyhow!("ban api code is not numeric: {v}"))?,
        None => 200,
    };
    if code != 200 {
        return Err(anyhow!("ban api code {code}"));
    }
    let raw_records = body
        .pointer("/data/voList")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let records: Vec<CloudBanRecord> = raw_records.iter().map(record_from_value).collect();
    let matched = records.iter().any(|r| r.namesake == 1);
    Ok(CloudBanEntry {
        account_id,
        nickname: nickname.trim().to_string(),
        matched,
        records,
        fetched_at: now,
    })
}

/// One account id → one cache entry through the proxy→direct chain, with
/// the legacy-domain retry the reference client performs. Health is
/// recorded per host against the FINAL outcome of that host's attempt
/// (any HTTP answer counts as alive — a 4xx/5xx here is the service's
/// business answer, not an outage signal).
async fn query_one(pair: &HttpPair, player: &CloudBanPlayer, now: i64) -> Result<CloudBanEntry> {
    let body = serde_json::json!({ "accountId": player.account_id });
    let primary_url = format!("https://{API_PRIMARY_HOST}{API_PATH}");
    let fallback_url = format!("https://{API_FALLBACK_HOST}{API_PATH}");

    let mut result =
        upstream_health::send_with_fallback(pair, API_PRIMARY_HOST, "ban/cn/user", |client| {
            client
                .post(&primary_url)
                .header(CLIENT_TYPE_HEADER, CLIENT_TYPE_VALUE)
                .json(&body)
        })
        .await;
    upstream_health::record_transport(API_PRIMARY_HOST, &result);
    if result.is_err() {
        tracing::info!(
            host = API_FALLBACK_HOST,
            "ban api primary failed — retrying the legacy domain"
        );
        let fallback =
            upstream_health::send_with_fallback(pair, API_FALLBACK_HOST, "ban/cn/user", |client| {
                client.post(&fallback_url).json(&body)
            })
            .await;
        upstream_health::record_transport(API_FALLBACK_HOST, &fallback);
        result = fallback;
    }

    let resp = result?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("ban api HTTP {status}"));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("ban api body parse: {e}"))?;
    entry_from_body(player.account_id, &player.nickname, &body, now)
}

/// The pure selection behind cloud_ban_check: which roster players need a
/// query right now (id valid, nickname usable, not dismissed, not
/// fresh-cached, deduped, capped).
fn select_to_query(cache: &BanCache, players: &[CloudBanPlayer], now: i64) -> Vec<CloudBanPlayer> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for player in players {
        if out.len() >= MAX_IDS_PER_CALL {
            break;
        }
        if player.account_id <= 0 || player.nickname.trim().is_empty() {
            continue;
        }
        if !seen.insert(player.account_id) {
            continue;
        }
        if cache.dismissed.contains(&player.account_id) {
            continue;
        }
        let fresh = cache
            .entries
            .get(&player.account_id)
            .is_some_and(|e| e.fetched_at + CACHE_TTL_SECS > now);
        if fresh {
            continue;
        }
        out.push(player.clone());
    }
    out
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Query the cloud ban list for one battle roster's players (CN only).
/// Background by design: failures degrade to the stale cache silently and
/// nothing here may block or fail a battle surface. Main window only.
#[tauri::command]
pub async fn cloud_ban_check(
    window: tauri::Window,
    players: Vec<CloudBanPlayer>,
    realm: String,
) -> CommandResult<CloudBanCheckResult> {
    ensure_main_window_label(window.label())?;
    let skipped = CloudBanCheckResult {
        skipped: true,
        queried: 0,
        changed: false,
    };
    if realm != "cn" || players.is_empty() {
        return Ok(skipped);
    }
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    if !load_enabled_from(&dir) {
        return Ok(skipped);
    }
    // One check at a time: the arena poll and the watcher push can both
    // fire for the same battle — the loser returns skipped immediately.
    let Ok(_gate) = CHECK_GATE.try_lock() else {
        return Ok(skipped);
    };

    let now = unix_now();
    let mut cache = load_cache_from(&dir);
    let to_query = select_to_query(&cache, &players, now);
    if to_query.is_empty() {
        return Ok(CloudBanCheckResult {
            skipped: false,
            queried: 0,
            changed: false,
        });
    }

    let pair = HttpPair::build(|b| b.timeout(REQUEST_TIMEOUT))
        .map_err(|e| anyhow!("http client: {e:#}"))?;
    // Owned items through the stream: the tauri command macro rejects
    // the higher-ranked closure a .iter() reference would need here.
    let answers: Vec<Result<CloudBanEntry>> = stream::iter(to_query.iter().cloned())
        .map(|player| {
            let pair = &pair;
            async move { query_one(pair, &player, now).await }
        })
        .buffered(QUERY_CONCURRENCY)
        .collect()
        .await;

    let mut changed = false;
    for answer in answers {
        match answer {
            Ok(entry) => {
                cache.entries.insert(entry.account_id, entry);
                changed = true;
            },
            // A failed id keeps its stale cache entry (or stays uncached
            // for the next battle) — one bad answer never poisons the
            // rest of the roster's marks.
            Err(e) => tracing::warn!(error = %e, "ban api query failed — keeping the cached state"),
        }
    }
    if changed {
        prune_stale_negatives(&mut cache, now);
        store_cache_in(&dir, &cache).map_err(|e| anyhow!("store ban cache: {e:#}"))?;
        let _ = window.app_handle().emit(MARKERS_CHANGED_EVENT, ());
    }
    Ok(CloudBanCheckResult {
        skipped: false,
        queried: to_query.len(),
        changed,
    })
}

/// Every matched player with the tooltip's details (matched entries only;
/// dismissed ones included and flagged so the UI can offer undo). Read
/// path, any window — mirrors markers_list's stance.
#[tauri::command]
pub fn cloud_ban_list() -> CommandResult<Vec<CloudBanMatch>> {
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    let cache = load_cache_from(&dir);
    Ok(cache
        .entries
        .values()
        .filter(|e| e.matched)
        .map(|e| CloudBanMatch {
            account_id: e.account_id,
            nickname: e.nickname.clone(),
            matched: true,
            dismissed: cache.dismissed.contains(&e.account_id),
            records: e.records.clone(),
            fetched_at: e.fetched_at,
        })
        .collect())
}

/// Dismiss (or restore) one cloud match — the user's local judgment about
/// a false positive; the cloud list itself is untouched. Emits the
/// markers-changed event so every surface re-renders at once. Main window
/// only.
#[tauri::command]
pub fn cloud_ban_dismiss(
    window: tauri::Window,
    account_id: i64,
    dismissed: bool,
) -> CommandResult<()> {
    ensure_main_window_label(window.label())?;
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    let mut cache = load_cache_from(&dir);
    if dismissed {
        cache.dismissed.insert(account_id);
    } else {
        cache.dismissed.remove(&account_id);
    }
    store_cache_in(&dir, &cache).map_err(|e| anyhow!("store ban cache: {e:#}"))?;
    let _ = window.app_handle().emit(MARKERS_CHANGED_EVENT, ());
    Ok(())
}

/// The feature toggle (settings → 玩家标记). Default off: enabling it is
/// an informed consent to sending CN roster account ids to a third-party
/// community service.
#[tauri::command]
pub fn cloud_ban_get_config() -> CommandResult<CloudBanConfig> {
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    Ok(CloudBanConfig {
        enabled: load_enabled_from(&dir),
    })
}

/// Persist the toggle. Turning it OFF must drop the cloud rows from every
/// surface at once, so the write rides the markers-changed event too.
/// Main window only.
#[tauri::command]
pub fn cloud_ban_set_config(window: tauri::Window, enabled: bool) -> CommandResult<CloudBanConfig> {
    ensure_main_window_label(window.label())?;
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    store_enabled_in(&dir, enabled).map_err(|e| anyhow!("store ban config: {e:#}"))?;
    let _ = window.app_handle().emit(MARKERS_CHANGED_EVENT, ());
    Ok(CloudBanConfig { enabled })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-banlist-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(id: i64, nickname: &str, matched: bool, fetched_at: i64) -> CloudBanEntry {
        CloudBanEntry {
            account_id: id,
            nickname: nickname.to_string(),
            matched,
            records: Vec::new(),
            fetched_at,
        }
    }

    fn local(nickname: &str, account_id: Option<i64>) -> MarkerEntry {
        MarkerEntry {
            nickname: nickname.to_string(),
            color: MarkerColor::Red,
            note: None,
            account_id,
            created_at: 1,
            source: None,
        }
    }

    #[test]
    fn config_parses_tolerantly_and_defaults_off() {
        assert!(!enabled_from_raw(""));
        assert!(!enabled_from_raw("# comment\nenabled = false\n"));
        assert!(enabled_from_raw("enabled = true\n"));
        assert!(enabled_from_raw("enabled=true"));
        assert!(enabled_from_raw("  Enabled = TRUE  \n"));
        // junk never enables the feature
        assert!(!enabled_from_raw("enabled maybe\n"));
        assert!(!enabled_from_raw("enabled: true\n"));
    }

    #[test]
    fn config_roundtrip() {
        let dir = temp_dir("config");
        assert!(!load_enabled_from(&dir));
        store_enabled_in(&dir, true).unwrap();
        assert!(load_enabled_from(&dir));
        store_enabled_in(&dir, false).unwrap();
        assert!(!load_enabled_from(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_roundtrip_and_tolerant_read() {
        let dir = temp_dir("cache");
        assert!(load_cache_from(&dir).entries.is_empty());
        std::fs::write(dir.join(BAN_CACHE_FILE), "not json").unwrap();
        assert!(load_cache_from(&dir).entries.is_empty());

        let mut cache = BanCache::default();
        cache.entries.insert(5, entry(5, "Cheater", true, 100));
        cache.dismissed.insert(7);
        store_cache_in(&dir, &cache).unwrap();
        let back = load_cache_from(&dir);
        assert_eq!(back.entries.len(), 1);
        assert!(back.dismissed.contains(&7));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_disabled_or_empty_cache_is_identity() {
        let dir = temp_dir("merge-off");
        let markers = vec![local("Alice", None)];
        assert_eq!(merge_cloud_markers_in(&dir, markers.clone()), markers);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_appends_matched_cloud_rows_as_yellow() {
        let dir = temp_dir("merge-on");
        store_enabled_in(&dir, true).unwrap();
        let mut cache = BanCache::default();
        cache.entries.insert(11, entry(11, "Hacker", true, 42));
        cache.entries.insert(12, entry(12, "Clean", false, 42));
        store_cache_in(&dir, &cache).unwrap();

        let merged = merge_cloud_markers_in(&dir, vec![local("Alice", None)]);
        assert_eq!(merged.len(), 2);
        let cloud_row = &merged[1];
        assert_eq!(cloud_row.nickname, "Hacker");
        assert_eq!(cloud_row.color, MarkerColor::Yellow);
        assert_eq!(cloud_row.account_id, Some(11));
        assert_eq!(cloud_row.source, Some(MarkerSource::Cloud));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_respects_local_precedence_and_dismissal() {
        let dir = temp_dir("merge-rules");
        store_enabled_in(&dir, true).unwrap();
        let mut cache = BanCache::default();
        cache
            .entries
            .insert(21, entry(21, "ShadowedById", true, 42));
        cache
            .entries
            .insert(22, entry(22, "shadowedbyname", true, 42));
        cache.entries.insert(23, entry(23, "Dismissed", true, 42));
        cache.entries.insert(24, entry(24, "  ", true, 42)); // blank nickname
        cache.dismissed.insert(23);
        store_cache_in(&dir, &cache).unwrap();

        // local row with account id 21 shadows the cloud row 21; local
        // "ShadowedByName" (case-insensitive) shadows cloud 22.
        let merged = merge_cloud_markers_in(
            &dir,
            vec![local("Other", Some(21)), local("ShadowedByName", None)],
        );
        assert_eq!(
            merged.len(),
            2,
            "every cloud row must be suppressed: id / nickname / dismissed / blank"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_cloud_nicknames_keep_the_first_row() {
        let dir = temp_dir("merge-dup");
        store_enabled_in(&dir, true).unwrap();
        let mut cache = BanCache::default();
        cache.entries.insert(41, entry(41, "TwinName", true, 42));
        cache.entries.insert(42, entry(42, "twinname", true, 43)); // renamed onto
        store_cache_in(&dir, &cache).unwrap();
        let merged = merge_cloud_markers_in(&dir, Vec::new());
        assert_eq!(
            merged.len(),
            1,
            "one nickname — one row (the first id wins)"
        );
        assert_eq!(merged[0].account_id, Some(41));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_entries_still_merge() {
        let dir = temp_dir("merge-stale");
        store_enabled_in(&dir, true).unwrap();
        let mut cache = BanCache::default();
        cache.entries.insert(31, entry(31, "Old", true, 1)); // ancient fetch
        store_cache_in(&dir, &cache).unwrap();
        let merged = merge_cloud_markers_in(&dir, Vec::new());
        assert_eq!(
            merged.len(),
            1,
            "visibility never expires — only freshness does"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn body_parse_maps_records_and_match_flag() {
        let now = 1234;
        let body = serde_json::json!({
            "code": 200,
            "data": { "voList": [
                { "BanName": "BannedName", "UserName": "PastName", "BanTime": "2023-05-01",
                  "RecordTime": "2023-05-02", "BanNameNamesake": 1 },
                { "BanName": "Ambiguous", "BanNameNamesake": 3 }
            ]},
            "support": ["someone"]
        });
        let parsed = entry_from_body(77, " Roster Nick ", &body, now).unwrap();
        assert!(parsed.matched, "namesake == 1 on any record is a match");
        assert_eq!(parsed.nickname, "Roster Nick");
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.records[0].ban_name.as_deref(), Some("BannedName"));
        assert_eq!(parsed.records[0].ban_time.as_deref(), Some("2023-05-01"));
        assert_eq!(parsed.records[1].namesake, 3);
        assert_eq!(parsed.fetched_at, now);

        // ambiguous-only answers are NOT matches
        let ambiguous = serde_json::json!({
            "code": 200, "data": { "voList": [ { "BanName": "X", "BanNameNamesake": 3 } ] }
        });
        assert!(!entry_from_body(78, "n", &ambiguous, now).unwrap().matched);

        // empty / missing voList = clean negative
        let empty = serde_json::json!({ "code": 200, "data": { "voList": [] } });
        assert!(!entry_from_body(79, "n", &empty, now).unwrap().matched);
        let null_vo = serde_json::json!({ "code": 200, "data": null });
        assert!(!entry_from_body(80, "n", &null_vo, now).unwrap().matched);

        // business error codes are errors, never cached
        let err = serde_json::json!({ "code": 5000, "message": "boom" });
        assert!(entry_from_body(81, "n", &err, now).is_err());
        // a present-but-non-numeric code is an error too (never cached)
        let garbled = serde_json::json!({ "code": "5000", "data": null });
        assert!(entry_from_body(82, "n", &garbled, now).is_err());
        // a MISSING code key defaults to success
        let bare = serde_json::json!({ "data": { "voList": [] } });
        assert!(!entry_from_body(83, "n", &bare, now).unwrap().matched);
    }

    #[test]
    fn selection_skips_invalid_dismissed_fresh_and_duplicates() {
        let now = 1000;
        let mut cache = BanCache::default();
        cache.entries.insert(2, entry(2, "Fresh", false, now));
        cache
            .entries
            .insert(3, entry(3, "Stale", false, now - CACHE_TTL_SECS - 1));
        cache.dismissed.insert(4);

        let players = vec![
            CloudBanPlayer {
                account_id: 0,
                nickname: "Zero".into(),
            },
            CloudBanPlayer {
                account_id: -5,
                nickname: "Neg".into(),
            },
            CloudBanPlayer {
                account_id: 1,
                nickname: "  ".into(),
            },
            CloudBanPlayer {
                account_id: 2,
                nickname: "Fresh".into(),
            },
            CloudBanPlayer {
                account_id: 3,
                nickname: "Stale".into(),
            },
            CloudBanPlayer {
                account_id: 4,
                nickname: "Dismissed".into(),
            },
            CloudBanPlayer {
                account_id: 5,
                nickname: "Once".into(),
            },
            CloudBanPlayer {
                account_id: 5,
                nickname: "Twice".into(),
            },
        ];
        let picked = select_to_query(&cache, &players, now);
        let ids: Vec<i64> = picked.iter().map(|p| p.account_id).collect();
        assert_eq!(ids, vec![3, 5], "only the stale and never-queried survive");
    }

    #[test]
    fn selection_caps_the_burst() {
        let cache = BanCache::default();
        let players: Vec<CloudBanPlayer> = (0..200)
            .map(|i| CloudBanPlayer {
                account_id: i + 1,
                nickname: format!("P{i}"),
            })
            .collect();
        assert_eq!(select_to_query(&cache, &players, 0).len(), MAX_IDS_PER_CALL);
    }

    #[test]
    fn freshness_window_boundary() {
        let now = 5000;
        let mut cache = BanCache::default();
        // fetched exactly TTL ago → stale → re-query
        cache
            .entries
            .insert(9, entry(9, "Fresh", false, now - CACHE_TTL_SECS));
        let picked = select_to_query(
            &cache,
            &[CloudBanPlayer {
                account_id: 9,
                nickname: "Fresh".into(),
            }],
            now,
        );
        assert_eq!(picked.len(), 1);
        // one second newer → fresh → skipped
        cache
            .entries
            .insert(9, entry(9, "Fresh", false, now - CACHE_TTL_SECS + 1));
        assert!(
            select_to_query(
                &cache,
                &[CloudBanPlayer {
                    account_id: 9,
                    nickname: "Fresh".into()
                }],
                now
            )
            .is_empty()
        );
    }
}
