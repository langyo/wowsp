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
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::appdata;
use super::download_hub::{self, DownloadRequest};

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

/// The unified download hub's job id for the dataset transfer.
const JOB_ID: &str = "data-pack";

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

/// The intact cached kit's sha. A matching sidecar alone cannot make a
/// missing/corrupt body current, or refresh would never repair that cache.
fn local_kit_sha() -> Result<Option<String>, String> {
    local_kit_sha_in(&appdata::appdata_dir_path()?)
}

fn local_kit_sha_in(dir: &Path) -> Result<Option<String>, String> {
    Ok(verified_kit_meta_in(dir)?.map(|meta| meta.sha256))
}

/// Freshness decision, split out for tests: current means the cached sha
/// exists and matches the manifest (hex case is not content).
fn kit_is_current(local: Option<&str>, entry: &DatasetEntry) -> bool {
    local.is_some_and(|sha| sha.eq_ignore_ascii_case(&entry.sha256))
}

/// The cached kit's published-at version, for the Settings → updates
/// data-sources row — `None` when no downloadable copy is installed (the
/// bundled asset is serving). Shows the version string verbatim (an ISO
/// timestamp today).
#[tauri::command]
pub fn data_pack_info() -> Result<Option<String>, String> {
    Ok(verified_kit_meta()?
        .filter(|m| !m.version.is_empty())
        .map(|m| m.version))
}

/// The sidecar of an INTACT cached kit (sidecar present AND its sha
/// matching the body) — `None` for no cache or a corrupt one.
fn verified_kit_meta() -> Result<Option<KitMeta>, String> {
    verified_kit_meta_in(&appdata::appdata_dir_path()?)
}

/// [`verified_kit_meta`] against an explicit directory (tests run the
/// four cache states against a temp dir).
fn verified_kit_meta_in(dir: &Path) -> Result<Option<KitMeta>, String> {
    Ok(verified_kit_in(dir)?.map(|(meta, _)| meta))
}

/// Read the body once and return those exact verified bytes. A concurrent
/// refresh may replace the on-disk file after verification; serving a second
/// read could otherwise return a body that was never checked against its meta.
fn verified_kit_in(dir: &Path) -> Result<Option<(KitMeta, String)>, String> {
    let body = match fs::read_to_string(appdata::data_file_path(dir, KIT_FILE)?) {
        Ok(body) => body,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData
            ) =>
        {
            return Ok(None);
        },
        Err(e) => return Err(format!("read {}: {e}", KIT_FILE)),
    };
    let meta = fs::read_to_string(appdata::data_file_path(dir, KIT_META)?)
        .ok()
        .and_then(|raw| serde_json::from_str::<KitMeta>(&raw).ok());
    Ok(meta
        .filter(|m| m.sha256.eq_ignore_ascii_case(&sha256_hex(body.as_bytes())))
        .map(|meta| (meta, body)))
}

/// The cached, hash-verified kit JSON for the webui to overlay onto its
/// bundled copy — `None` means "no downloadable copy on this machine"
/// (never downloaded, or the cache failed verification), which the webui
/// maps to the baked asset.
#[tauri::command]
pub fn get_ship_kit() -> Result<Option<String>, String> {
    // Corrupt or tampered cache (or a missing sidecar): report absent
    // rather than serving data nobody vouched for; the next refresh
    // re-downloads over it (verification via [`verified_kit_meta`]).
    Ok(verified_kit_in(&appdata::appdata_dir_path()?)?.map(|(_, body)| body))
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
    let part = appdata::appdata_dir_path()?.join(format!("{KIT_FILE}.part"));
    // The tiny transfer goes through the unified download hub so the
    // data pack queues behind (never contends with) the big artifacts:
    // mirror ladder, streaming sha256 verification, the DATASET_MAX_BYTES
    // cap as a hard ceiling. Headless — this lane deliberately has no
    // progress UI.
    let done = download_hub::transfer(
        None,
        DownloadRequest {
            expected_sha256: Some(entry.sha256.clone()),
            timeout: Some(std::time::Duration::from_secs(60)),
            max_bytes: Some(DATASET_MAX_BYTES as u64),
            ..DownloadRequest::new(
                JOB_ID,
                wowsp_tauri_shared::download::kind::DATA_PACK,
                super::github_mirror::candidates(&url),
                part,
            )
        },
    )
    .await?;
    let bytes = tokio::fs::read(&done.path)
        .await
        .map_err(|e| format!("read {}: {e}", done.path.display()))?;
    let outcome = install_kit(&bytes, entry);
    let _ = tokio::fs::remove_file(&done.path).await;
    outcome
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

    struct KitFixture(std::path::PathBuf);

    impl KitFixture {
        fn new() -> Self {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let dir = std::env::temp_dir().join(format!("wowsp-kit-repair-{}", hex::encode(nonce)));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for KitFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn matching_sidecar_does_not_mark_a_missing_or_corrupt_body_current() {
        let fixture = KitFixture::new();
        let body = br#"{"3763300940":{"r":2}}"#;
        let entry = entry(&sha256_hex(body));
        for corrupt in [None, Some(b"{\"corrupt\":1}".as_slice()), Some(&[0xff])] {
            install_kit_in(&fixture.0, body, &entry).unwrap();
            if let Some(bytes) = corrupt {
                fs::write(fixture.0.join(KIT_FILE), bytes).unwrap();
            } else {
                fs::remove_file(fixture.0.join(KIT_FILE)).unwrap();
            }
            assert!(
                !kit_is_current(local_kit_sha_in(&fixture.0).unwrap().as_deref(), &entry),
                "a matching sidecar must not stop refresh from repairing its absent/corrupt body"
            );
        }
    }

    #[test]
    fn verified_kit_snapshot_keeps_the_body_that_was_actually_hashed() {
        let fixture = KitFixture::new();
        let body = br#"{"3763300940":{"r":2}}"#;
        let entry = entry(&sha256_hex(body));
        install_kit_in(&fixture.0, body, &entry).unwrap();
        let (meta, verified) = verified_kit_in(&fixture.0).unwrap().unwrap();
        fs::write(fixture.0.join(KIT_FILE), b"unverified replacement").unwrap();
        assert_eq!(verified.as_bytes(), body);
        assert_eq!(meta.sha256, sha256_hex(verified.as_bytes()));
        assert!(verified_kit_in(&fixture.0).unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn verified_kit_snapshot_rejects_a_cache_directory_junction() {
        use std::os::windows::process::CommandExt;
        let fixture = KitFixture::new();
        let outside = fixture.0.join("outside");
        let body = br#"{"3763300940":{"r":2}}"#;
        let entry = entry(&sha256_hex(body));
        install_kit_in(&outside, body, &entry).unwrap();
        let junction = fixture.0.join("data-pack");
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.join("data-pack"))
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let snapshot = verified_kit_in(&fixture.0);
        fs::remove_dir(junction).unwrap();
        assert!(
            snapshot.is_err(),
            "verified snapshots must retain the AppData path guard"
        );
        assert_eq!(fs::read(outside.join(KIT_FILE)).unwrap(), body);
    }

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
    fn verified_kit_meta_covers_the_four_cache_states() {
        let dir = std::env::temp_dir().join(format!("wowsp-kit-meta-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let body = br#"{"3763300940":{"r":2,"radarM":10000}}"#;

        // absent → None
        assert!(verified_kit_meta_in(&dir).expect("read").is_none());

        // intact → Some, and the version survives data_pack_info's filter
        let e = entry(&sha256_hex(body));
        install_kit_in(&dir, body, &e).expect("install");
        let meta = verified_kit_meta_in(&dir).expect("read").expect("intact");
        assert_eq!(meta.version, "2026-09-29T00:00:00Z");

        // corrupt body (sidecar sha no longer matches) → None
        fs::write(dir.join(KIT_FILE), br#"{"tampered":1}"#).expect("write");
        assert!(verified_kit_meta_in(&dir).expect("read").is_none());

        // missing sidecar over a body → None
        fs::remove_file(dir.join(KIT_META)).expect("remove");
        assert!(verified_kit_meta_in(&dir).expect("read").is_none());

        let _ = fs::remove_dir_all(&dir);
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
