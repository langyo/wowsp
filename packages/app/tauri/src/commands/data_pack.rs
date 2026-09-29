//! Hot-updatable baked ship-data — the `data-latest` channel.
//!
//! The webui bundles small game-data assets (ship names, live stats, the
//! Tab overlay's consumable kit) as compile-time imports so every surface
//! works offline with zero IPC; the price is that refreshing that DATA
//! used to require an app release. This module adds a tiny download lane
//! for exactly those baked assets, the way the resource pack covers
//! models/dogtags:
//!
//!   - a fixed `data-latest` GitHub release carries `wowsp-data.json` (a
//!     per-dataset manifest: content sha256 + a content-addressed asset
//!     name + published-at version) plus one asset per dataset version
//!     (published by `scripts/publish_data_pack.py`);
//!   - [`refresh_data_pack`] walks the same mirror ladder as every other
//!     GitHub fetch, compares the manifest sha against the locally cached
//!     copy and downloads only on a real content change — republishing
//!     identical content is a no-op for clients;
//!   - [`get_ship_kit`] hands the webui the cached kit JSON,
//!     hash-verified against the sidecar, to overlay onto its bundled
//!     copy; a missing or corrupt cache simply means "keep the baked
//!     asset".
//!
//! Deliberately NOT part of the resource pack: mixing a few KB of data
//! into the ~500 MB models archive would churn its content tree hash on
//! every data tweak (and mobile is full-download-only there), so data
//! gets its own cheap lane. No progress UI, no settings surface — the
//! payload is a few KB and every failure mode degrades to the bundled
//! asset, so the refresh is fire-and-forget from the main window's boot.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::appdata;

const REPO: &str = "langyo/wowsp";
const DATA_TAG: &str = "data-latest";
const DATA_MANIFEST: &str = "wowsp-data.json";
/// The one dataset this shell knows today: the Tab overlay's consumable
/// kit (`packages/webui/src/data/ship_consumable_kit.json`, baked by
/// `scripts/extract_ship_consumable_kit.py`). The manifest may carry
/// more; unknown names are skipped so an old shell keeps working against
/// a newer manifest.
const KIT_DATASET: &str = "ship-consumable-kit";
const KIT_FILE: &str = "data-pack/ship-consumable-kit.json";
const KIT_META: &str = "data-pack/ship-consumable-kit.meta.json";
/// Sanity cap on a dataset body: the kit is ~15 KB, so anything megabyte
/// scale means the manifest pointed at the wrong asset — fail the refresh
/// and keep the cached/bundled copy instead of absorbing it.
const DATASET_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Single-flight guard — the main window fires the refresh once per boot,
/// but nothing stops a second webview from calling it too.
static REFRESH_ACTIVE: Mutex<bool> = Mutex::new(false);

/// The `wowsp-data.json` manifest published alongside the dataset assets
/// (publisher: `scripts/publish_data_pack.py`, snake_case keys — the
/// attributes must never introduce a rename the publisher doesn't share).
#[derive(Debug, serde::Deserialize)]
struct DataManifest {
    /// Kept (deserialized) to document the wire shape; not branched on —
    /// an unknown future format still parses, the entries carry their own
    /// vocabulary.
    #[serde(default)]
    #[allow(dead_code)]
    format: u32,
    datasets: HashMap<String, DatasetEntry>,
}

/// One dataset's published version: the sha256 OF THE ASSET BODY (the
/// content clients hash locally to decide freshness) plus the
/// content-addressed asset name.
#[derive(Debug, Clone, serde::Deserialize)]
struct DatasetEntry {
    #[serde(default)]
    version: String,
    sha256: String,
    asset: String,
    /// Same — informational; the download path trusts Content-Length
    /// and its own cap, not this field.
    #[serde(default)]
    #[allow(dead_code)]
    size: u64,
}

/// Sidecar recording which content the cached dataset body holds — the
/// `sha256` field is what [`refresh_data_pack`] compares against the
/// manifest and what [`get_ship_kit`] verifies the body against.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KitMeta {
    sha256: String,
    #[serde(default)]
    version: String,
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn data_url(asset: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/{DATA_TAG}/{asset}")
}

/// Fetch and PARSE the manifest across the mirror ladder (same contract
/// as `model_pack::fetch_manifest`: user mirror → official → built-in
/// ghproxy prefixes, `Cache-Control: no-cache` so mirrors cannot pin an
/// old version into the check, and a 200-with-garbage answer — the
/// ghproxy interstitial page — falls through to the next candidate
/// instead of failing the pass).
async fn fetch_manifest(client: &reqwest::Client) -> Result<DataManifest, String> {
    let url = data_url(DATA_MANIFEST);
    let mut last_err = format!("no mirror attempted for {url}");
    for candidate in super::github_mirror::candidates(&url) {
        match client
            .get(&candidate)
            .header("User-Agent", "WoWSP-data-pack/1.0")
            .header("Cache-Control", "no-cache")
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.text().await {
                Ok(body) => match serde_json::from_str::<DataManifest>(&body) {
                    Ok(m) => return Ok(m),
                    Err(e) => last_err = format!("parse manifest from {candidate}: {e}"),
                },
                Err(e) => last_err = format!("read manifest from {candidate}: {e}"),
            },
            Ok(resp) => last_err = format!("{candidate}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{candidate}: {e}"),
        }
    }
    Err(last_err)
}

/// The cached kit's recorded sha — `None` when no cache exists (or the
/// sidecar is unreadable, which [`get_ship_kit`] then treats as corrupt).
fn local_kit_sha() -> Result<Option<String>, String> {
    let meta = match appdata::read_appdata_json(KIT_META)? {
        Some(raw) => raw,
        None => return Ok(None),
    };
    match serde_json::from_str::<KitMeta>(&meta) {
        Ok(m) => Ok(Some(m.sha256)),
        Err(_) => Ok(None),
    }
}

/// Freshness decision, split out for tests: current means the cached sha
/// exists and matches the manifest (hex case is not content).
fn kit_is_current(local: Option<&str>, entry: &DatasetEntry) -> bool {
    local.is_some_and(|sha| sha.eq_ignore_ascii_case(&entry.sha256))
}

/// The cached, hash-verified kit JSON for the webui to overlay onto its
/// bundled copy — `None` means "no downloadable copy on this machine"
/// (never downloaded, or the cache failed verification), which the webui
/// maps to the baked asset.
#[tauri::command]
pub fn get_ship_kit() -> Result<Option<String>, String> {
    let body = match appdata::read_appdata_json(KIT_FILE)? {
        Some(body) => body,
        None => return Ok(None),
    };
    let meta = appdata::read_appdata_json(KIT_META)?
        .and_then(|raw| serde_json::from_str::<KitMeta>(&raw).ok());
    let verified = meta.is_some_and(|m| m.sha256 == sha256_hex(body.as_bytes()));
    if verified {
        Ok(Some(body))
    } else {
        // Corrupt or tampered cache (or a missing sidecar): report absent
        // rather than serving data nobody vouched for; the next refresh
        // re-downloads over it.
        Ok(None)
    }
}

/// One refresh pass for every dataset this shell knows: fetch the
/// manifest, skip what is already current, download + verify + cache what
/// changed. Returns whether anything changed. Single-flight — a second
/// concurrent call is a no-op success, not an error.
#[tauri::command]
pub async fn refresh_data_pack() -> Result<bool, String> {
    {
        let mut guard = REFRESH_ACTIVE.lock().map_err(|_| "lock poisoned")?;
        if *guard {
            return Ok(false);
        }
        *guard = true;
    }
    let result = refresh_kit().await;
    if let Ok(mut guard) = REFRESH_ACTIVE.lock() {
        *guard = false;
    }
    result
}

async fn refresh_kit() -> Result<bool, String> {
    let client = super::network::build_http_client()?;
    let manifest = fetch_manifest(&client).await?;
    let entry = match manifest.datasets.get(KIT_DATASET) {
        Some(entry) => entry,
        // A manifest without the kit (older manifest, newer vocabulary)
        // is not an error — the bundled asset simply stays.
        None => return Ok(false),
    };
    if kit_is_current(local_kit_sha()?.as_deref(), entry) {
        return Ok(false);
    }
    let url = data_url(&entry.asset);
    let mut last_err = format!("no mirror attempted for {url}");
    for candidate in super::github_mirror::candidates(&url) {
        match client
            .get(&candidate)
            .header("User-Agent", "WoWSP-data-pack/1.0")
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if resp
                    .content_length()
                    .is_some_and(|len| len > DATASET_MAX_BYTES as u64)
                {
                    last_err = format!(
                        "{candidate}: {} bytes exceeds the data-pack cap",
                        resp.content_length().unwrap_or_default()
                    );
                    continue;
                }
                let bytes = match resp.bytes().await {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        last_err = format!("read {candidate}: {e}");
                        continue;
                    },
                };
                if bytes.len() > DATASET_MAX_BYTES {
                    last_err = format!(
                        "{candidate}: {} bytes exceeds the data-pack cap",
                        bytes.len()
                    );
                    continue;
                }
                // Verify BEFORE committing so a mirror serving the wrong
                // body (200-with-garbage, a stale interstitial) just moves
                // the ladder on; install_kit re-checks as defense in depth.
                let sha = sha256_hex(&bytes);
                if !sha.eq_ignore_ascii_case(&entry.sha256) {
                    last_err = format!("{candidate}: body sha {sha} ≠ manifest {}", entry.sha256);
                    continue;
                }
                return install_kit(bytes.as_ref(), entry);
            },
            Ok(resp) => last_err = format!("{candidate}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{candidate}: {e}"),
        }
    }
    Err(last_err)
}

/// Verify a downloaded body against the manifest sha and install it into
/// the AppData cache. The sha check is the gate: a mirror that serves
/// garbage (or an asset name collision) fails here and the cached /
/// bundled copy keeps serving.
fn install_kit(bytes: &[u8], entry: &DatasetEntry) -> Result<bool, String> {
    let dir = appdata::appdata_dir_path()?;
    install_kit_in(&dir, bytes, entry)
}

/// [`install_kit`] against an explicit directory (tests run against a
/// temp dir instead of the real AppData root). Writes the body FIRST and
/// the sidecar second, both atomically (appdata's tmp+rename), so a crash
/// between the two leaves the cache reading as corrupt → absent, never
/// as a new body with an old hash.
fn install_kit_in(dir: &Path, bytes: &[u8], entry: &DatasetEntry) -> Result<bool, String> {
    let sha = sha256_hex(bytes);
    if !sha.eq_ignore_ascii_case(&entry.sha256) {
        return Err(format!(
            "asset sha mismatch: manifest {} vs downloaded {sha}",
            entry.sha256
        ));
    }
    let body = std::str::from_utf8(bytes)
        .map_err(|e| format!("dataset body is not UTF-8 JSON: {e}"))?
        .to_string();
    appdata::write_json_in(dir, KIT_FILE, &body)?;
    let meta = serde_json::to_string(&KitMeta {
        sha256: sha.to_ascii_lowercase(),
        version: entry.version.clone(),
    })
    .map_err(|e| format!("serialize kit meta: {e}"))?;
    appdata::write_json_in(dir, KIT_META, &meta)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sha: &str) -> DatasetEntry {
        DatasetEntry {
            version: "2026-09-29T00:00:00Z".into(),
            sha256: sha.into(),
            asset: format!("ship-consumable-kit-{}.json", &sha[..8.min(sha.len())]),
            size: 15_453,
        }
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // sha256("wowsp") — a fixed vector pins the hashing itself.
        assert_eq!(
            sha256_hex(b"wowsp"),
            "4e77cd87945e2a7b04f550cab34c60d139a3d310b96a86761caee4a9bbcd3109"
        );
    }

    #[test]
    fn manifest_parses_camel_case_and_tolerates_missing_optionals() {
        let body = r#"{
            "format": 1,
            "datasets": {
                "ship-consumable-kit": {
                    "version": "2026-09-29T00:00:00Z",
                    "sha256": "abc123",
                    "asset": "ship-consumable-kit-abc123.json",
                    "size": 15453
                },
                "future-dataset": {"sha256": "x", "asset": "y.json"}
            }
        }"#;
        let m: DataManifest = serde_json::from_str(body).expect("valid manifest");
        assert_eq!(m.format, 1);
        assert_eq!(m.datasets.len(), 2);
        assert_eq!(
            m.datasets["ship-consumable-kit"].asset,
            "ship-consumable-kit-abc123.json"
        );
        // version/size are optional (serde defaults).
        assert_eq!(m.datasets["future-dataset"].size, 0);
        assert_eq!(m.datasets["future-dataset"].version, "");
    }

    #[test]
    fn freshness_requires_exact_sha_match() {
        let sha = "a".repeat(64);
        let e = entry(&sha);
        assert!(kit_is_current(Some(&sha), &e), "same sha → current");
        assert!(
            kit_is_current(Some(&sha.to_ascii_uppercase()), &e),
            "hex case is not content"
        );
        assert!(!kit_is_current(None, &e), "no cache → not current");
        let mut other = "a".repeat(64);
        other.replace_range(0..1, "b");
        assert!(
            !kit_is_current(Some(&other), &e),
            "any byte differs → stale"
        );
    }

    #[test]
    fn install_rejects_sha_mismatch_and_accepts_match() {
        let body = br#"{"3763300940":{"r":2,"radarM":10000}}"#;
        let dir = std::env::temp_dir().join(format!("wowsp-data-pack-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let sha = sha256_hex(body);
        assert_eq!(install_kit_in(&dir, body, &entry(&sha)), Ok(true));
        let cached = std::fs::read_to_string(dir.join(KIT_FILE)).expect("body cached");
        assert_eq!(cached.as_bytes(), body);
        let meta: KitMeta = serde_json::from_str(
            &std::fs::read_to_string(dir.join(KIT_META)).expect("meta cached"),
        )
        .expect("meta parses");
        assert_eq!(meta.sha256, sha);
        assert_eq!(meta.version, "2026-09-29T00:00:00Z");

        assert!(install_kit_in(&dir, body, &entry(&"0".repeat(64))).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
