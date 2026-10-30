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
//!     identical content is a no-op for clients. The manifest body must
//!     match the official digest of `wowsp-data.json` (the pairing
//!     relay's signed doc, cross-checked with `api.github.com` — see
//!     [`super::release_digest`]); only when BOTH official channels are
//!     unreachable or rate-limited does the mirror-served manifest pass
//!     unverified (logged — the kit is data, never executed);
//!   - [`get_ship_kit`] hands the webui the cached kit JSON,
//!     hash-verified against the sidecar, to overlay onto its bundled
//!     copy; a missing or corrupt cache simply means "keep the baked
//!     asset".
//!
//! A SECOND dataset rides the same channel: `ship-gameparams`, both realms'
//! GameParams slices as a zip (~15 MB, baked by
//! `scripts/extract/build_shipdata_bundle.py`). It is consumed by
//! `commands/gameparams.rs` rather than the webui, so the armor/ballistics
//! tab answers install-less machines from our own server — the shape gate
//! (`sliceFormat`) lives at that call site. It keeps the kit's contract
//! (mirror ladder, content sha, sidecar verification, silent degradation)
//! with its own larger byte cap, and the zip container means a lookup
//! inflates exactly one ship entry instead of the whole fleet.
//!
//! Deliberately NOT part of the resource pack: mixing a few KB of data
//! into the ~500 MB models archive would churn its content tree hash on
//! every data tweak (and mobile is full-download-only there), so data
//! gets its own cheap lane. No progress UI, no settings surface — the
//! payload is a few KB and every failure mode degrades to the bundled
//! asset, so the refresh is fire-and-forget from the main window's boot.

use anyhow::{anyhow, bail};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use wowsp_tauri_shared::CommandResult;

use super::appdata;
use super::download_hub::{self, DownloadRequest};
use super::release_digest::{self, OfficialDigest, sha256_hex};

const REPO: &str = "langyo/wowsp";
/// The relay digest channel serving the data pack's official sha256s.
const DATA_CHANNEL: &str = "data";
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
/// Sanity cap on the kit's body: it is ~15 KB, so anything megabyte scale
/// means the manifest pointed at the wrong asset — fail the refresh and
/// keep the cached/bundled copy instead of absorbing it.
const DATASET_MAX_BYTES: usize = 4 * 1024 * 1024;

/// The second dataset: BOTH realms' GameParams slices as a zip — the
/// container baked by `scripts/extract/build_shipdata_bundle.py` and
/// published on this same channel, so the armor/ballistics/sonar data
/// reaches machines with no install (and both realms) without an app
/// release. Consumed by `commands/gameparams.rs`, which tries it
/// before the carried Lesta snapshot and any install.
const SHIPDATA_DATASET: &str = "ship-gameparams";
const SHIPDATA_FILE: &str = "data-pack/ship-gameparams.zip";
const SHIPDATA_META: &str = "data-pack/ship-gameparams.meta.json";
/// The bundle's manifest entry (slice shape + per-realm build stamps).
const SHIPDATA_MANIFEST_ENTRY: &str = "manifest.json";
/// ~15 MB today (1445 ships across both realms); the cap catches a manifest
/// pointing at the wrong asset while leaving room for fleet growth.
const SHIPDATA_MAX_BYTES: usize = 64 * 1024 * 1024;

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

fn data_url(asset: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/{DATA_TAG}/{asset}")
}

/// Fetch and PARSE the manifest across the mirror ladder (same contract
/// as `model_pack::fetch_manifest`: user mirror → official → built-in
/// ghproxy prefixes, `Cache-Control: no-cache` so mirrors cannot pin an
/// old version into the check, and a 200-with-garbage answer — the
/// ghproxy interstitial page — falls through to the next candidate
/// instead of failing the pass). The body must match the official digest
/// of the manifest asset (the pairing relay's signed doc first,
/// cross-checked with api.github.com) — it carries every dataset's
/// sha256, so a mirror able to rewrite it could also swap the datasets.
/// Only when BOTH official channels are unreachable or rate-limited does
/// the mirror-served manifest pass unverified.
async fn fetch_manifest(clients: &super::network::HttpPair) -> anyhow::Result<DataManifest> {
    let expected = match release_digest::lookup_official_sha256(
        clients,
        DATA_CHANNEL,
        DATA_TAG,
        DATA_MANIFEST,
    )
    .await
    .map_err(|e| anyhow!("data pack manifest cannot be verified: {e}"))?
    {
        OfficialDigest::Verified(sha) => Some(sha),
        OfficialDigest::Unavailable(reason) => {
            tracing::warn!(
                %reason,
                "official digest unavailable — accepting the mirror-served data pack manifest unverified"
            );
            None
        },
    };
    let url = data_url(DATA_MANIFEST);
    let mut last_err = format!("no mirror attempted for {url}");
    for candidate in super::github_mirror::candidates(&url) {
        // Each ladder step rides the proxy→direct chain (a dead configured
        // proxy must not stall the refresh behind the 30 s per-mirror cap).
        let host = super::upstream_health::host_of_url(&candidate).to_string();
        match super::upstream_health::send_with_fallback(clients, &host, "data-pack", |client| {
            client
                .get(&candidate)
                .header("User-Agent", "WoWSP-data-pack/1.0")
                .header("Cache-Control", "no-cache")
                .timeout(std::time::Duration::from_secs(30))
        })
        .await
        {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(body)
                    if expected
                        .as_ref()
                        .is_some_and(|sha| sha256_hex(&body) != *sha) =>
                {
                    last_err = format!("{candidate}: manifest does not match the official digest");
                },
                Ok(body) => match serde_json::from_slice::<DataManifest>(&body) {
                    Ok(m) => return Ok(m),
                    Err(e) => last_err = format!("parse manifest from {candidate}: {e}"),
                },
                Err(e) => last_err = format!("read manifest from {candidate}: {e}"),
            },
            Ok(resp) => last_err = format!("{candidate}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{candidate}: {e}"),
        }
    }
    Err(anyhow::Error::msg(last_err))
}

/// The intact cached kit's sha. A matching sidecar alone cannot make a
/// missing/corrupt body current, or refresh would never repair that cache.
fn local_kit_sha() -> anyhow::Result<Option<String>> {
    local_kit_sha_in(&appdata::appdata_dir_path()?)
}

fn local_kit_sha_in(dir: &Path) -> anyhow::Result<Option<String>> {
    Ok(verified_kit_meta_in(dir)?.map(|meta| meta.sha256))
}

/// Freshness decision, split out for tests: current means the cached sha
/// exists and matches the manifest (hex case is not content).
fn kit_is_current(local: Option<&str>, entry: &DatasetEntry) -> bool {
    local.is_some_and(|sha| sha.eq_ignore_ascii_case(&entry.sha256))
}

/// The cached kit's published-at version, for the Settings → resources
/// data-sources row — `None` when no downloadable copy is installed (the
/// bundled asset is serving). Shows the version string verbatim (an ISO
/// timestamp today).
#[tauri::command]
pub fn data_pack_info() -> CommandResult<Option<String>> {
    Ok(verified_kit_meta()?
        .filter(|m| !m.version.is_empty())
        .map(|m| m.version))
}

/// The sidecar of an INTACT cached kit (sidecar present AND its sha
/// matching the body) — `None` for no cache or a corrupt one.
fn verified_kit_meta() -> anyhow::Result<Option<KitMeta>> {
    verified_kit_meta_in(&appdata::appdata_dir_path()?)
}

/// [`verified_kit_meta`] against an explicit directory (tests run the
/// four cache states against a temp dir).
fn verified_kit_meta_in(dir: &Path) -> anyhow::Result<Option<KitMeta>> {
    Ok(verified_kit_in(dir)?.map(|(meta, _)| meta))
}

/// Read the body once and return those exact verified bytes. A concurrent
/// refresh may replace the on-disk file after verification; serving a second
/// read could otherwise return a body that was never checked against its meta.
fn verified_kit_in(dir: &Path) -> anyhow::Result<Option<(KitMeta, String)>> {
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
        Err(e) => return Err(anyhow!("read {}: {e}", KIT_FILE)),
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
pub fn get_ship_kit() -> CommandResult<Option<String>> {
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
pub async fn refresh_data_pack() -> CommandResult<bool> {
    {
        let mut guard = REFRESH_ACTIVE
            .lock()
            .map_err(|_| anyhow!("lock poisoned"))?;
        if *guard {
            return Ok(false);
        }
        *guard = true;
    }
    let result = refresh_datasets().await;
    if let Ok(mut guard) = REFRESH_ACTIVE.lock() {
        *guard = false;
    }
    result.map_err(Into::into)
}

/// One pass over every dataset this shell knows. Each lane is independent:
/// a failure (or a manifest that lacks the dataset) leaves the other lane's
/// cache and every bundled fallback untouched.
async fn refresh_datasets() -> anyhow::Result<bool> {
    let clients = super::network::HttpPair::build(|b| b)?;
    let manifest = fetch_manifest(&clients).await?;
    let mut changed = refresh_kit_dataset(&manifest).await?;
    changed |= refresh_shipdata_dataset(&manifest).await?;
    Ok(changed)
}

async fn refresh_kit_dataset(manifest: &DataManifest) -> anyhow::Result<bool> {
    let entry = match manifest.datasets.get(KIT_DATASET) {
        Some(entry) => entry,
        // A manifest without the kit (older manifest, newer vocabulary)
        // is not an error — the bundled asset simply stays.
        None => return Ok(false),
    };
    if kit_is_current(local_kit_sha()?.as_deref(), entry) {
        return Ok(false);
    }
    // The asset name becomes a URL path segment under data-latest.
    if !release_digest::is_plain_segment(&entry.asset) {
        bail!(
            "data pack manifest names an invalid asset {:?}",
            entry.asset
        );
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
        .map_err(|e| anyhow!("read {}: {e}", done.path.display()))?;
    let outcome = install_kit(&bytes, entry);
    let _ = tokio::fs::remove_file(&done.path).await;
    outcome
}

/// Download + cache the ship-data bundle when the manifest's copy differs
/// from the cached one. Same mirror ladder / streaming sha verification /
/// download-hub queueing as the kit; the cap and timeout are larger because
/// this dataset IS megabytes, not the kit's few KB. Every failure degrades
/// to the carried Lesta snapshot and the install chain.
async fn refresh_shipdata_dataset(manifest: &DataManifest) -> anyhow::Result<bool> {
    let Some(entry) = manifest.datasets.get(SHIPDATA_DATASET) else {
        // A manifest without the bundle (older manifest, newer vocabulary)
        // is not an error — the carried snapshot simply stays.
        return Ok(false);
    };
    if shipdata_is_current(entry)? {
        return Ok(false);
    }
    // The asset name becomes a URL path segment under data-latest.
    if !release_digest::is_plain_segment(&entry.asset) {
        bail!(
            "data pack manifest names an invalid asset {:?}",
            entry.asset
        );
    }
    let url = data_url(&entry.asset);
    let part = appdata::appdata_dir_path()?.join(format!("{SHIPDATA_FILE}.part"));
    let done = download_hub::transfer(
        None,
        DownloadRequest {
            expected_sha256: Some(entry.sha256.clone()),
            timeout: Some(std::time::Duration::from_secs(600)),
            max_bytes: Some(SHIPDATA_MAX_BYTES as u64),
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
        .map_err(|e| anyhow!("read {}: {e}", done.path.display()))?;
    let outcome = install_shipdata(&bytes, entry);
    let _ = tokio::fs::remove_file(&done.path).await;
    outcome
}

/// Whether the cached bundle already carries the manifest's content.
fn shipdata_is_current(entry: &DatasetEntry) -> anyhow::Result<bool> {
    let dir = appdata::appdata_dir_path()?;
    Ok(shipdata_meta_in(&dir)?.is_some_and(|m| m.sha256.eq_ignore_ascii_case(&entry.sha256)))
}

/// The cached bundle's sidecar (None when absent or unparsable).
fn shipdata_meta_in(dir: &Path) -> anyhow::Result<Option<KitMeta>> {
    Ok(
        fs::read_to_string(appdata::data_file_path(dir, SHIPDATA_META)?)
            .ok()
            .and_then(|raw| serde_json::from_str::<KitMeta>(&raw).ok()),
    )
}

/// The verified bundle path (sidecar present AND the body's sha matching),
/// or None for "no cache / corrupt cache" — every caller then degrades.
///
/// The body is re-hashed per call (~15 MB, tens of milliseconds) rather
/// than memoized: a cache keyed on the sidecar cannot see a body replaced
/// or corrupted behind it, and a ship lookup is not a hot enough path to
/// trade that detection away.
fn shipdata_path_in(dir: &Path) -> anyhow::Result<Option<std::path::PathBuf>> {
    let Some(meta) = shipdata_meta_in(dir)? else {
        return Ok(None);
    };
    let path = appdata::data_file_path(dir, SHIPDATA_FILE)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(anyhow!("read {SHIPDATA_FILE}: {e}")),
    };
    if !meta.sha256.eq_ignore_ascii_case(&sha256_hex(&bytes)) {
        return Ok(None);
    }
    Ok(Some(path))
}

/// Read one entry out of the verified bundle as JSON. None (never an error
/// callers must handle specially) when the bundle or the entry is absent,
/// so a ship that predates the bundle simply falls through.
fn bundle_entry(root: &Path, name: &str) -> anyhow::Result<Option<serde_json::Value>> {
    use std::io::Read as _;

    let Some(path) = shipdata_path_in(root)? else {
        return Ok(None);
    };
    let file = fs::File::open(&path).map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| anyhow!("read {}: {e}", path.display()))?;
    let mut entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(anyhow!("read {name} from ship-data bundle: {e}")),
    };
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| anyhow!("read {name} from ship-data bundle: {e}"))?;
    Ok(serde_json::from_str(&text).ok())
}

/// The cached bundle's manifest — slice shape plus per-realm build stamps.
/// The consumer gates on `sliceFormat` before
/// trusting any entry (see commands/gameparams.rs).
pub(crate) fn shipdata_manifest() -> anyhow::Result<Option<serde_json::Value>> {
    bundle_entry(&appdata::appdata_dir_path()?, SHIPDATA_MANIFEST_ENTRY)
}

/// The cached bundle's slice for one ship id — the entry point
/// `commands/gameparams.rs` consumes.
pub(crate) fn shipdata_slice(ship_id: i64) -> anyhow::Result<Option<serde_json::Value>> {
    bundle_entry(&appdata::appdata_dir_path()?, &format!("{ship_id}.json"))
}

/// Verify a downloaded body against the manifest sha and install it into
/// the AppData cache. The sha check is the gate: a mirror that serves
/// garbage (or an asset name collision) fails here and the cached /
/// bundled copy keeps serving.
fn install_kit(bytes: &[u8], entry: &DatasetEntry) -> anyhow::Result<bool> {
    let dir = appdata::appdata_dir_path()?;
    install_kit_in(&dir, bytes, entry)
}

/// [`install_kit`] against an explicit directory (tests run against a
/// temp dir instead of the real AppData root). Writes the body FIRST and
/// the sidecar second, both atomically (appdata's tmp+rename), so a crash
/// between the two leaves the cache reading as corrupt → absent, never
/// as a new body with an old hash.
fn install_kit_in(dir: &Path, bytes: &[u8], entry: &DatasetEntry) -> anyhow::Result<bool> {
    let sha = sha256_hex(bytes);
    if !sha.eq_ignore_ascii_case(&entry.sha256) {
        bail!(
            "asset sha mismatch: manifest {} vs downloaded {sha}",
            entry.sha256
        );
    }
    let body = std::str::from_utf8(bytes)
        .map_err(|e| anyhow!("dataset body is not UTF-8 JSON: {e}"))?
        .to_string();
    appdata::write_json_in(dir, KIT_FILE, &body)?;
    let meta = serde_json::to_string(&KitMeta {
        sha256: sha.to_ascii_lowercase(),
        version: entry.version.clone(),
    })
    .map_err(|e| anyhow!("serialize kit meta: {e}"))?;
    appdata::write_json_in(dir, KIT_META, &meta)?;
    Ok(true)
}

/// Install the ship-data bundle: the body is BINARY (a zip), so it lands
/// through the byte writer; the sidecar write order is the same as the
/// kit's (body first, sidecar second) so a crash between the two reads as
/// corrupt during verification, never as a new body with an old hash.
fn install_shipdata(bytes: &[u8], entry: &DatasetEntry) -> anyhow::Result<bool> {
    install_shipdata_in(&appdata::appdata_dir_path()?, bytes, entry)
}

fn install_shipdata_in(dir: &Path, bytes: &[u8], entry: &DatasetEntry) -> anyhow::Result<bool> {
    let sha = sha256_hex(bytes);
    if !sha.eq_ignore_ascii_case(&entry.sha256) {
        bail!(
            "asset sha mismatch: manifest {} vs downloaded {sha}",
            entry.sha256
        );
    }
    appdata::write_bytes_in(dir, SHIPDATA_FILE, bytes)?;
    let meta = serde_json::to_string(&KitMeta {
        sha256: sha.to_ascii_lowercase(),
        version: entry.version.clone(),
    })
    .map_err(|e| anyhow!("serialize ship-data meta: {e}"))?;
    appdata::write_json_in(dir, SHIPDATA_META, &meta)?;
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

    // ── ship-data bundle (second dataset) ─────────────────────────────

    /// A bundle in the baked shape: manifest entry + one JSON per ship.
    fn shipdata_zip(slice_ids: &[i64], slice_format: u64) -> Vec<u8> {
        use std::io::Write as _;

        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            let manifest = serde_json::json!({
                "format": 1,
                "sliceFormat": slice_format,
                "realms": {},
                "totalShips": slice_ids.len(),
            });
            writer.start_file(SHIPDATA_MANIFEST_ENTRY, options).unwrap();
            writer.write_all(manifest.to_string().as_bytes()).unwrap();
            for id in slice_ids {
                writer.start_file(format!("{id}.json"), options).unwrap();
                writer
                    .write_all(format!("{{\"id\":{id},\"name\":\"ship{id}\"}}").as_bytes())
                    .unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn shipdata_entry(sha: &str, size: usize) -> DatasetEntry {
        DatasetEntry {
            version: "2026-10-30T00:00:00Z".into(),
            sha256: sha.into(),
            asset: format!("ship-gameparams-{}.zip", &sha[..8.min(sha.len())]),
            size: size as u64,
        }
    }

    #[test]
    fn shipdata_bundle_round_trips_and_verifies() {
        let fixture = KitFixture::new();
        let bytes = shipdata_zip(&[1001, 1002], 2);
        let entry = shipdata_entry(&sha256_hex(&bytes), bytes.len());
        install_shipdata_in(&fixture.0, &bytes, &entry).unwrap();

        assert!(shipdata_path_in(&fixture.0).unwrap().is_some());
        let manifest = bundle_entry(&fixture.0, SHIPDATA_MANIFEST_ENTRY)
            .unwrap()
            .unwrap();
        assert_eq!(manifest["sliceFormat"], serde_json::json!(2));
        let slice = bundle_entry(&fixture.0, "1002.json").unwrap().unwrap();
        assert_eq!(slice["name"], serde_json::json!("ship1002"));
        // An id outside the bundle is "absent", not an error.
        assert!(bundle_entry(&fixture.0, "9999.json").unwrap().is_none());

        // A body replaced behind its sidecar must read as "no cache".
        fs::write(fixture.0.join(SHIPDATA_FILE), b"tampered").unwrap();
        assert!(shipdata_path_in(&fixture.0).unwrap().is_none());
        assert!(bundle_entry(&fixture.0, "1002.json").unwrap().is_none());
    }

    #[test]
    fn shipdata_install_rejects_a_sha_mismatch() {
        let fixture = KitFixture::new();
        let bytes = shipdata_zip(&[1001], 2);
        let entry = shipdata_entry(&"0".repeat(64), bytes.len());
        assert!(install_shipdata_in(&fixture.0, &bytes, &entry).is_err());
        assert!(!fixture.0.join(SHIPDATA_FILE).exists());
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
        assert_eq!(install_kit_in(&dir, body, &entry(&sha)).unwrap(), true);
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
