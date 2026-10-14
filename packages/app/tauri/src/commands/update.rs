//! Shun-config-driven auto-update with a mirror-race download engine.
//!
//! The update-watch config (`[package.metadata.shun.update]`) is embedded at
//! build time (see `build.rs`) — the same table drives the installer shell's
//! delivery pipeline. Every mirror source is probed **in parallel** through
//! the proxy-aware client (10 s cap each): resolution follows the source's
//! `releases/latest` redirect and reads the version straight out of the
//! final tag URL (`…/releases/tag/v0.3.0` → `0.3.0`), so the published tag
//! IS the version truth — nothing has to be uploaded alongside a release
//! for clients to notice it. The legacy `latest` marker file stays as a
//! compatibility fallback for mirrors that serve the download mount but
//! mangle the tag-page redirect. A probed version that is not a well-formed
//! release version ([`is_valid_version`]) counts as a failed probe. The
//! first source to resolve a version wins the resolution
//! ([`resolve_latest`], used by `update_check`).
//!
//! `update_download` never takes the version from a mirror: it installs the
//! official latest release named by the official channels (the relay digest
//! endpoint, cross-checked with api.github.com — see [`official_release`])
//! and refuses anything
//! not newer than the running build, so a stale or hostile mirror cannot
//! turn an update into a downgrade. Every reachable source then enters the
//! unified download hub (`commands/download_hub.rs`) as one
//! FIFO-queued job — mirrors are probed in parallel (the race window
//! reorders the ladder by throughput), a single writer streams the
//! artifact into one version-scoped `.part` file, and a dying mirror
//! fails over to the next candidate FROM THE COMMITTED OFFSET. The part
//! file survives failed and cancelled passes, so a retry resumes where
//! the last attempt died instead of re-downloading from byte 0 (the old
//! failure mode: the bar reaches ~100%, the leader dies at EOF, the
//! runner-up restarts from scratch and it reads as "downloaded it
//! twice"). The completed part becomes `WoWSP-update-<version>-<pid>.exe`,
//! spawned detached with `--silent --dir=<install dir>` — the artifact
//! name `scripts/build_installers.py` produces is
//! `WoWSP_<version>_x64-installer-lite.exe` (see `artifact_url`: an app
//! update never re-ships the resource pack, which updates through its own
//! channel), fetched from the release's VERSIONED download tree
//! (`…/releases/download/v<version>/<file>`) — the URL carries both the
//! version and the file name and is immutable per release, so a stale
//! mirror 404s and fails over instead of serving old bytes under the
//! moving `releases/latest/download` mount.
//! Releases also carry the retired bare name
//! `WoWSP_<version>_x64-installer.exe` as a byte-identical lite alias —
//! pre-v0.3.1 updaters fetch exactly that; this build never does.
//! Before any byte is accepted, the installer's sha256 is read from the
//! same official-channel answers that named the version (the relay digest
//! doc or GitHub's `digest` field — never a mirror) and the hub verifies
//! the stream against it; no
//! reachable digest or a mismatch on every mirror means no installer is
//! spawned.
//! The hardened installer kills the running app and installs over its
//! directory, so the frontend treats the command's promise never resolving
//! (app death) or resolving (installer spawned) as success by design; the
//! only visible failure modes are `Err` strings (`"update cancelled"` maps
//! to a clean frontend reset).
//!
//! Progress flows to the webui on the unified `wowsp://download-progress`
//! channel (`kind: "update"`): `{ phase: "race" }` while probes settle,
//! `{ phase: "download", received, total, speedBps }` while the artifact
//! streams (speed is an EWMA over 500 ms ticks; `received == total` is
//! only ever emitted for a complete, verified file) and finally
//! `{ phase: "install" }` right before the spawn.

use anyhow::{Result, anyhow, bail};

use futures::StreamExt;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::CommandResult;
use wowsp_tauri_shared::download::{kind, phase};
use wowsp_tauri_shared::{DOWNLOAD_PROGRESS_EVENT, DownloadProgress};

use crate::commands::download_hub::{self, DownloadRequest};
use crate::commands::network::build_http_client;

/// Update-watch table embedded by `build.rs` from
/// `[package.metadata.shun.update]` in this crate's Cargo.toml.
const SHUN_UPDATE_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-update.json"));

/// The running app's version, embedded by `build.rs` from
/// `CARGO_PKG_VERSION` (the workspace version).
const APP_VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/app-version.txt"));

/// One pass owns both the installer path and cancellation from resolution
/// through handoff. A cancel between passes cannot affect the next pass.
static UPDATE_PASS: Mutex<Option<Arc<UpdatePass>>> = Mutex::new(None);

#[derive(Default, PartialEq)]
enum UpdateStage {
    #[default]
    Downloading,
    Cancelled,
    Installing,
}

#[derive(Default)]
struct UpdatePass {
    stage: Mutex<UpdateStage>,
    changed: tokio::sync::Notify,
}

impl UpdatePass {
    fn cancel(&self) -> bool {
        let mut stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        if *stage == UpdateStage::Installing {
            return false;
        }
        *stage = UpdateStage::Cancelled;
        self.changed.notify_one();
        true
    }

    fn check_cancelled(&self) -> Result<()> {
        if *self.stage.lock().unwrap_or_else(|e| e.into_inner()) == UpdateStage::Cancelled {
            bail!("{}", CANCEL_MSG)
        } else {
            Ok(())
        }
    }

    async fn cancelled(&self) {
        loop {
            let changed = self.changed.notified();
            if self.check_cancelled().is_err() {
                return;
            }
            changed.await;
        }
    }

    /// Only wrap cancellable reads here. In particular, dropping the hub's
    /// waiter would leave its writer alive and let a retry reuse its path.
    async fn run<T>(&self, operation: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        tokio::select! {
            biased;
            () = self.cancelled() => bail!("{}", CANCEL_MSG),
            result = operation => {
                self.check_cancelled()?;
                result
            },
        }
    }

    /// The last cancellable point. Serialize this transition with cancel:
    /// once handoff starts, a late click must not claim installation stopped.
    fn begin_install(&self) -> Result<()> {
        let mut stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        if *stage == UpdateStage::Cancelled {
            bail!("{}", CANCEL_MSG);
        }
        *stage = UpdateStage::Installing;
        Ok(())
    }
}

struct UpdateGuard<'a> {
    registry: &'a Mutex<Option<Arc<UpdatePass>>>,
    pass: Arc<UpdatePass>,
}

impl<'a> UpdateGuard<'a> {
    fn begin(registry: &'a Mutex<Option<Arc<UpdatePass>>>) -> Option<Self> {
        let mut active = registry.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return None;
        }
        let pass = Arc::new(UpdatePass::default());
        *active = Some(Arc::clone(&pass));
        Some(Self { registry, pass })
    }
}

impl Drop for UpdateGuard<'_> {
    fn drop(&mut self) {
        *self.registry.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// An installer is hundreds of MB; anything smaller is a mirror error page.
const MIN_INSTALLER_BYTES: u64 = 1_000_000;

/// Per-source cap on the version probe: a slow or dead mirror simply times
/// out instead of stalling the race.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the hub's parallel mirror probe runs before the ladder is
/// reordered by measured throughput and the winner streams.
const RACE_WINDOW: Duration = Duration::from_secs(10);

/// The frontend maps this exact error to a clean reset (banner back to the
/// idle prompt, update still available).
const CANCEL_MSG: &str = "update cancelled";

/// The hub job id — cancels and progress events address the pass by it.
const JOB_ID: &str = "update";

/// The installer artifact URL under a mirror base — the exact name
/// `scripts/build_installers.py::emit` produces, under the release's
/// versioned download tree. App updates ALWAYS fetch the `-lite` artifact:
/// the resource pack lives in its own cache and updates through its own
/// hash-versioned channel (see `model_pack.rs`), so an app update never
/// needs to re-ship the ~1.2 GB pack — the full installer is only worth
/// downloading on a fresh install.
///
/// The path carries BOTH the version and the file name
/// (`…/releases/download/v<version>/<file>`), so it is immutable per
/// release: a stale mirror 404s and fails over instead of serving an
/// older release's bytes under the moving `releases/latest/download`
/// mount, and the fetched URL always names the tag it belongs to.
fn artifact_url(base: &str, version: &str) -> String {
    format!(
        "{}/v{version}/{}",
        versioned_download_base(base),
        artifact_name(version)
    )
}

/// The bare installer asset name for a release (see [`artifact_url`]).
fn artifact_name(version: &str) -> String {
    format!("WoWSP_{version}_x64-installer-lite.exe")
}

/// Rewrite a source base into the versioned-download root. Every
/// configured source ends with the `/releases/latest/download` mount
/// (the discovery side: marker fallback + tag-page probe both live one
/// step up); downloads rewrite that tail to the versioned
/// `/releases/download` tree. A base without the suffix is taken as-is —
/// a custom mirror root is then expected to lay out
/// `v<version>/<file>` underneath it.
fn versioned_download_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    match trimmed.strip_suffix("releases/latest/download") {
        Some(head) => format!("{head}releases/download"),
        None => trimmed.to_string(),
    }
}

// ── Artifact integrity (official digest) ─────────────────────────────────

/// The official latest-release API. Deliberately NOT routed through
/// `github_mirror`: together with the relay digest endpoint below it is
/// the trust anchor for both the version an update installs and the
/// digest of installer bytes that may stream from third-party mirrors —
/// a mirror able to name the version and serve both the artifact and its
/// hash could forge all of them. `releases/latest` only ever names a
/// published `v*` app release: data, model and mod-hub releases are
/// published with `make_latest=false`.
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/langyo/wowsp/releases/latest";

/// The relay worker's digest endpoint — the second official channel
/// (see relay-core's `digests` module and scripts/publish_digests.py).
/// The hostname is the app's own pairing gateway, reachable where
/// api.github.com is not; the payload mirrors can influence neither
/// channel. Root resolution rides the pairing module's helper so the
/// undocumented `WOWSP_RELAY_URL` dev override (trim, scheme mapping,
/// fallback) behaves exactly as it does for pairing.
fn relay_digest_url() -> String {
    format!(
        "{}/api/digests/app",
        super::pairing_relay::builtin_relay_root()
    )
}

/// Per-attempt cap and attempts for the relay digest leg: the fast path
/// gets two short tries — enough for one cold edge miss — before the
/// GitHub budget takes over.
const RELAY_DIGEST_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_DIGEST_ATTEMPTS: usize = 2;

/// Per-attempt cap on the official release lookup (version + digest; the
/// payload is a few KB).
const DIGEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Attempts at the official release lookup before the update is refused.
const DIGEST_ATTEMPTS: usize = 3;

/// The lowercase sha256 GitHub computed for asset `name` in a release-API
/// payload (`"digest": "sha256:<hex>"`). `None` when the asset is missing,
/// carries no digest, or the digest is not a well-formed sha256.
fn asset_sha256(release: &serde_json::Value, name: &str) -> Option<String> {
    let hex = release["assets"]
        .as_array()?
        .iter()
        .find(|asset| asset["name"].as_str() == Some(name))?["digest"]
        .as_str()?
        .strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

/// The official latest release: the version to install and the sha256 of
/// its lite installer.
#[derive(Debug, Clone, PartialEq)]
struct OfficialRelease {
    version: String,
    sha256: String,
}

/// Read the version (`tag_name`, strictly validated) and the lite
/// installer digest out of a release-API payload.
fn parse_official_release(release: &serde_json::Value) -> Result<OfficialRelease> {
    let tag = release["tag_name"]
        .as_str()
        .ok_or_else(|| anyhow!("the official release carries no tag name"))?;
    let version = tag
        .strip_prefix('v')
        .filter(|version| is_valid_version(version))
        .ok_or_else(|| anyhow!("the official release tag {tag:?} is not a release version"))?;
    let name = artifact_name(version);
    let sha256 = asset_sha256(release, &name)
        .ok_or_else(|| anyhow!("release v{version} publishes no sha256 digest for {name}"))?;
    Ok(OfficialRelease {
        version: version.to_string(),
        sha256,
    })
}

/// One attempt at the GitHub release-API lookup; the caller owns the
/// retry budget and the error rendering.
async fn github_release_attempt(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<serde_json::Value> {
    let response = client
        .get(url)
        .header("User-Agent", "WoWSP-updater")
        .header("Accept", "application/vnd.github+json")
        .timeout(timeout)
        .send()
        .await;
    match response {
        Ok(r) if r.status().is_success() => r.json().await.map_err(|e| anyhow!("parse {url}: {e}")),
        Ok(r) => Err(anyhow!("{url}: HTTP {}", r.status())),
        Err(e) => Err(anyhow!("{url}: {e}")),
    }
}

/// Fetch the official latest release and its installer sha256 from
/// GitHub, with the full retry budget. Any failure is an `Err`: an
/// installer that cannot be verified is never spawned.
async fn fetch_official_release(client: &reqwest::Client) -> Result<OfficialRelease> {
    let url = LATEST_RELEASE_API;
    let mut last_err = String::new();
    for _ in 0..DIGEST_ATTEMPTS {
        match github_release_attempt(client, url, DIGEST_TIMEOUT).await {
            Ok(release) => return parse_official_release(&release),
            Err(e) => last_err = format!("{e:#}"),
        }
    }
    bail!(
        "cannot verify the update (official release unavailable: {last_err}); download it manually from GitHub Releases"
    )
}

/// The relay's answer: the release fields plus the doc's per-channel
/// publish counter (the rollback guard's input).
#[derive(Debug, Clone, PartialEq)]
struct RelayDigest {
    release: OfficialRelease,
    seq: u64,
}

/// Compile-time pinned Ed25519 public keys (standard base64 of the 32
/// raw bytes) that relay digest docs may be signed with. The private
/// seeds NEVER enter this repository (AGENTS.md §7) — see the ceremony
/// in scripts/catalog_signing.py and res/keys/README.md.
///
/// Transition policy: while this list is EMPTY, unsigned docs are
/// accepted (the channel is young and nothing signs yet) — but SIGNED
/// docs are already refused as unknown-key, so once the signing secret
/// exists, no release may be cut from an empty-pinlist commit. As soon
/// as the first key lands here, a valid signature by a listed key
/// becomes REQUIRED — the KV store and the worker itself can then no
/// longer forge a doc, and a replayed old doc is all that remains
/// (which the seq ratchet refuses). The pin commit and the
/// WOWSP_DIGEST_SIGNING_KEY secret must land in the same wave, before
/// the next release tag (see res/keys/README.md).
const PINNED_DIGEST_KEYS: &[(&str, &str)] = &[
    // ("main", include_str!("../../res/keys/digest-main.pub")),
    // ("backup", include_str!("../../res/keys/digest-backup.pub")),
];

/// Verify the doc's optional Ed25519 signature layer against `keys`.
/// The signed bytes are the doc's JSON without the `sig` member,
/// rendered with sorted keys and compact separators — byte-identical
/// to scripts/catalog_signing.py's canonical form (serde_json's Map is
/// sorted; every doc member that reaches the canonical form is ASCII).
fn verify_doc_signature(doc: &serde_json::Value, keys: &[(&str, &str)]) -> Result<()> {
    use base64::Engine as _;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let key_id = doc.get("key_id").and_then(|v| v.as_str());
    let sig_b64 = doc.get("sig").and_then(|v| v.as_str());
    match (key_id, sig_b64) {
        (None, None) => {
            if keys.is_empty() {
                return Ok(());
            }
            bail!("the relay digest doc is unsigned but the app pins signing keys");
        },
        (Some(_), None) | (None, Some(_)) => {
            bail!("the relay digest doc is half-signed (key_id/sig must appear together)");
        },
        (Some(key_id), Some(sig_b64)) => {
            let pub_b64 = keys
                .iter()
                .find(|(id, _)| *id == key_id)
                .map(|(_, key)| *key)
                .ok_or_else(|| {
                    anyhow!("the relay digest doc is signed by unknown key {key_id:?}")
                })?;
            let key_bytes = base64::engine::general_purpose::STANDARD
                .decode(pub_b64.trim())
                .map_err(|e| anyhow!("pinned key {key_id:?} is not valid base64: {e}"))?;
            let key_bytes: [u8; 32] = key_bytes
                .try_into()
                .map_err(|_| anyhow!("pinned key {key_id:?} is not 32 bytes"))?;
            let sig_bytes = base64::engine::general_purpose::STANDARD
                .decode(sig_b64)
                .map_err(|e| anyhow!("the relay digest signature is not valid base64: {e}"))?;
            let signature = Signature::from_slice(&sig_bytes)
                .map_err(|e| anyhow!("the relay digest signature is malformed: {e}"))?;
            let key = VerifyingKey::from_bytes(&key_bytes)
                .map_err(|e| anyhow!("pinned key {key_id:?} is malformed: {e}"))?;

            let mut unsigned = doc.clone();
            unsigned
                .as_object_mut()
                .ok_or_else(|| anyhow!("the relay digest doc is not a JSON object"))?
                .remove("sig");
            let canonical = serde_json::to_vec(&unsigned)
                .map_err(|e| anyhow!("canonicalizing the relay digest doc: {e}"))?;
            key.verify(&canonical, &signature)
                .map_err(|e| anyhow!("the relay digest signature does not verify: {e}"))?;
            Ok(())
        },
    }
}

/// Read the relay's app-channel digest doc (relay_core::digests::
/// DigestDoc) into the same [`OfficialRelease`] shape the GitHub leg
/// produces, with the same strictness: v-tag, valid version, digest for
/// exactly the artifact this version installs.
fn parse_relay_digest(doc: &serde_json::Value) -> Result<RelayDigest> {
    parse_relay_digest_with(doc, PINNED_DIGEST_KEYS)
}

/// [`parse_relay_digest`] with an explicit pinned-key table (tests pass
/// their own; production passes [`PINNED_DIGEST_KEYS`]).
fn parse_relay_digest_with(doc: &serde_json::Value, keys: &[(&str, &str)]) -> Result<RelayDigest> {
    if doc["channel"].as_str() != Some("app") {
        bail!("the relay digest doc is not the app channel");
    }
    verify_doc_signature(doc, keys)?;
    let tag = doc["tag"]
        .as_str()
        .ok_or_else(|| anyhow!("the relay digest doc carries no tag"))?;
    let version = tag
        .strip_prefix('v')
        .filter(|version| is_valid_version(version))
        .ok_or_else(|| anyhow!("the relay digest tag {tag:?} is not a release version"))?;
    let name = artifact_name(version);
    let sha256 = doc["assets"]
        .get(&name)
        .and_then(|v| v.as_str())
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| anyhow!("relay digest carries no sha256 for {name}"))?;
    let seq = doc["seq"]
        .as_u64()
        .filter(|seq| *seq >= 1)
        .ok_or_else(|| anyhow!("the relay digest doc carries no publish sequence number"))?;
    Ok(RelayDigest {
        release: OfficialRelease {
            version: version.to_string(),
            sha256,
        },
        seq,
    })
}

/// Fetch the relay's app-channel digest doc. Any failure is an `Err`
/// that [`choose_official`] turns into "fall back to GitHub".
async fn fetch_relay_digest(client: &reqwest::Client) -> Result<RelayDigest> {
    let url = relay_digest_url();
    let mut last_err = String::new();
    for _ in 0..RELAY_DIGEST_ATTEMPTS {
        let response = client
            .get(&url)
            .header("User-Agent", "WoWSP-updater")
            .timeout(RELAY_DIGEST_TIMEOUT)
            .send()
            .await;
        let doc: serde_json::Value = match response {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    last_err = format!("parse {url}: {e}");
                    continue;
                },
            },
            Ok(r) => {
                last_err = format!("{url}: HTTP {}", r.status());
                continue;
            },
            Err(e) => {
                last_err = format!("{url}: {e}");
                continue;
            },
        };
        return parse_relay_digest(&doc);
    }
    bail!("relay digest channel unavailable: {last_err}")
}

/// Persisted high-water mark of accepted relay digest docs — the
/// rollback guard relay-core's digests module documents. It only
/// REFUSES in the case where the relay doc decides the update (GitHub
/// unreachable); when GitHub answered and agrees, a regressed seq is an
/// ops artifact (a rebuilt KV namespace restarts the counter), not an
/// attack, and the mark simply never lowers. Defense-in-depth, not
/// tamper-proofing: without doc signatures a store-level attacker can
/// raise seq arbitrarily.
const RELAY_SEQ_FILE: &str = ".relay-digest-seq.json";

async fn accepted_relay_seq() -> Option<u64> {
    let dir = crate::paths::ensure_data_dir().ok()?;
    tokio::fs::read_to_string(dir.join(RELAY_SEQ_FILE))
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Best-effort, monotone, and torn-write safe (tmp + rename): a failed
/// or skipped mark only weakens the NEXT rollback check.
async fn remember_relay_seq(seq: u64) {
    let Ok(dir) = crate::paths::ensure_data_dir() else {
        return;
    };
    let tmp = dir.join(format!("{RELAY_SEQ_FILE}.tmp"));
    if tokio::fs::write(&tmp, seq.to_string()).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, dir.join(RELAY_SEQ_FILE)).await;
    }
}

/// Pure core of the rollback check: a doc may only advance the mark
/// (an equal seq is a replay, a lower one a revert).
fn ensure_seq_advances(prev: Option<u64>, next: u64) -> Result<()> {
    if prev.is_some_and(|prev| next <= prev) {
        bail!(
            "the relay digest regressed (seq {next} at/below the accepted {prev:?}) — refusing the update"
        );
    }
    Ok(())
}

/// Combine the two official channels. Both answering must mean the same
/// version+digest — a disagreement means one channel is lying, and the
/// update is refused rather than guessed at. One channel answering is
/// enough (the relay-only path is precisely the blocked-GitHub case the
/// channel exists for); neither answering is an error the caller may
/// still retry through GitHub's full budget.
fn choose_official(
    relay: Result<OfficialRelease>,
    github: Result<OfficialRelease>,
) -> Result<OfficialRelease> {
    match (relay, github) {
        (Ok(r), Err(_)) => Ok(r),
        (Ok(r), Ok(g)) if r == g => Ok(r),
        (Ok(r), Ok(g)) => bail!(
            "the official digest channels disagree (relay says v{} {}, GitHub says v{} {}) — refusing to update",
            r.version,
            &r.sha256[..8],
            g.version,
            &g.sha256[..8]
        ),
        (Err(_), Ok(g)) => Ok(g),
        (Err(relay_err), Err(_)) => Err(relay_err),
    }
}

/// The official version + digest over both channels. The two legs run
/// concurrently; the GitHub cross-check leg is a single short attempt
/// (no retry budget) so the blocked-GitHub path costs at most one
/// 10 s timeout — paid in parallel, never serialized. Only when both
/// legs fail outright (the common transient shape on CN networks) does
/// GitHub's full retry budget get spent; a channel DISAGREEMENT is
/// terminal and never retried past.
async fn official_release(client: &reqwest::Client) -> Result<OfficialRelease> {
    let github_quick = async {
        github_release_attempt(client, LATEST_RELEASE_API, RELAY_DIGEST_TIMEOUT)
            .await
            .and_then(|release| parse_official_release(&release))
    };
    let (relay, github_quick) = tokio::join!(fetch_relay_digest(client), github_quick);
    match (relay, github_quick) {
        // Both quick legs unavailable: transient failures are the norm
        // (CN networks drop api.github.com silently; the relay may be
        // mid-deploy), so spend GitHub's full retry budget before
        // refusing the update.
        (Err(relay_err), Err(_)) => {
            fetch_official_release(client).await.map_err(|github_err| {
                anyhow!("cannot verify the update (relay: {relay_err}; GitHub: {github_err}); download it manually from GitHub Releases")
            })
        },
        (Ok(relay_doc), github_quick) => {
            let prev = accepted_relay_seq().await;
            // The rollback refusal guards exactly the case where the
            // relay doc DECIDES the update (GitHub unreachable). When
            // GitHub answered, a regressed seq is an ops artifact —
            // choosing below lets choose_official do the deciding
            // (agreement passes, disagreement still refuses), and the
            // monotone remember keeps the mark from ever lowering.
            if github_quick.is_err() {
                ensure_seq_advances(prev, relay_doc.seq)?;
            }
            let release = choose_official(Ok(relay_doc.release.clone()), github_quick)?;
            if relay_doc.seq > prev.unwrap_or(0) {
                remember_relay_seq(relay_doc.seq).await;
            }
            Ok(release)
        },
        (Err(_), Ok(g)) => Ok(g),
    }
}

/// The parsed update-watch config (mirrors `shun::config::UpdateWatchConfig`;
/// re-declared locally so the JSON shape stays explicit at the use site).
#[derive(Debug, serde::Deserialize)]
struct WatchConfig {
    sources: Vec<String>,
    files: Vec<String>,
}

fn watch_config() -> Result<WatchConfig> {
    serde_json::from_str::<WatchConfig>(SHUN_UPDATE_JSON)
        .map_err(|e| anyhow!("embedded shun-update.json: {e}"))
}

// ── Source race (resolution) ─────────────────────────────────────────────

/// The `releases/latest` page URL for a source. Sources point at the
/// download mount (`…/releases/latest/download`); stripping the suffix
/// lands on the redirecting page whose final URL names the latest release
/// tag — version truth that needs no separately-uploaded marker file.
/// A source without the suffix is used as-is (its tag probe then simply
/// fails and the marker fallback takes over).
fn tag_url_from_source(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    match trimmed.strip_suffix("/download") {
        Some(page) => page.to_string(),
        None => trimmed.to_string(),
    }
}

/// The bare version carried by a post-redirect release URL:
/// `…/releases/tag/v0.3.0?x=1` → `0.3.0`. `None` when the URL never landed
/// on a tag page (proxy followed internally, error page, …).
fn version_from_redirect(url: &str) -> Option<String> {
    let (path, _) = url.split_once(['?', '#']).unwrap_or((url, ""));
    let tag = path.rsplit_once("/tag/")?.1;
    let tag = tag.trim_end_matches('/').trim();
    let version = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    (!version.is_empty()).then(|| version.to_string())
}

/// GET `{base}/{marker}` and return the trimmed body — the candidate
/// version. 200 + non-empty text makes the source reachable.
async fn probe_marker(client: &reqwest::Client, base: &str, marker: &str) -> Result<String> {
    let url = format!("{}/{}", base.trim().trim_end_matches('/'), marker);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("probe {url}: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        bail!("probe {url}: unexpected status {}", response.status());
    }
    let version = response
        .text()
        .await
        .map_err(|e| anyhow!("probe {url}: {e}"))?
        .trim()
        .to_string();
    if version.is_empty() {
        bail!("`latest` marker at {url} is empty");
    }
    Ok(version)
}

/// Resolve the latest version by following the source's `releases/latest`
/// redirect and reading the tag out of the final URL. The body is never
/// read — the redirected URL is the payload, then the connection drops.
async fn probe_tag(client: &reqwest::Client, base: &str) -> Result<String> {
    let url = tag_url_from_source(base);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("probe {url}: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        bail!("probe {url}: unexpected status {}", response.status());
    }
    let final_url = response.url().to_string();
    drop(response);
    version_from_redirect(&final_url)
        .ok_or_else(|| anyhow!("probe {url}: redirect landed on a non-tag URL: {final_url}"))
}

/// Resolve the latest version from one source. The tag redirect is the
/// primary mechanism — it needs nothing but the release itself, so a
/// forgotten marker file can never hide a published release. The legacy
/// `latest` marker file stays as the compatibility fallback for mirrors
/// that proxy the download mount but mangle the tag-page redirect.
///
/// The answer is mirror-controlled text that later lands in URLs and file
/// names, so anything but a well-formed release version fails the probe.
async fn probe_source(client: &reqwest::Client, base: &str, marker: &str) -> Result<String> {
    let version = match probe_tag(client, base).await {
        Ok(version) => version,
        Err(tag_err) => probe_marker(client, base, marker)
            .await
            .map_err(|marker_err| anyhow!("tag probe: {tag_err}; marker probe: {marker_err}"))?,
    };
    if !is_valid_version(&version) {
        bail!("probe {base}: malformed version {version:?}");
    }
    Ok(version)
}

/// One mirror that resolved the latest version.
struct SourceCandidate {
    base: String,
    version: String,
}

/// Probe every source concurrently, each capped at [`PROBE_TIMEOUT`]. With
/// `collect_all` the pass waits for every probe (bounded by the cap) so all
/// reachable mirrors can enter the artifact race; without it the first
/// resolution wins and the remaining probes are cancelled by drop. Either
/// way `candidates` is in resolution-arrival order — the first entry is the
/// winner.
async fn race_sources(
    client: &reqwest::Client,
    sources: &[String],
    marker: &str,
    collect_all: bool,
) -> Result<Vec<SourceCandidate>> {
    let mut probes: futures::stream::FuturesUnordered<_> = sources
        .iter()
        .map(|base| async move {
            let probe = tokio::time::timeout(PROBE_TIMEOUT, probe_source(client, base, marker))
                .await
                .map_err(|_| anyhow!("probe {base}: timed out after {}s", PROBE_TIMEOUT.as_secs()));
            (base.clone(), probe)
        })
        .collect();

    let mut candidates: Vec<SourceCandidate> = Vec::new();
    while let Some((base, probe)) = probes.next().await {
        if let Ok(Ok(version)) = probe {
            candidates.push(SourceCandidate { base, version });
            if !collect_all {
                break;
            }
        }
    }
    drop(probes); // cancels still-pending probes at their await points

    if candidates.is_empty() {
        bail!("no update source reachable");
    }
    Ok(candidates)
}

/// Resolves the fastest mirror (first version resolution to arrive),
/// returning the latest version plus the installer artifact URL under the
/// winning source.
async fn resolve_latest() -> Result<(String, String)> {
    let watch = watch_config()?;
    let marker = watch
        .files
        .first()
        .ok_or_else(|| anyhow!("no marker file declared in the update sources"))?;
    let client = build_http_client()?;
    let candidates = race_sources(&client, &watch.sources, marker, false).await?;
    let winner = &candidates[0];
    Ok((
        winner.version.clone(),
        artifact_url(&winner.base, &winner.version),
    ))
}

// ── Version comparison ───────────────────────────────────────────────────

/// Longest version string accepted from a source or the release API.
const MAX_VERSION_LEN: usize = 64;

/// Strict release-version shape, the bare form of this repo's `v*` tags:
/// `^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$` — `0.6.0`, plus an
/// optional prerelease suffix like `0.7.0-beta.1`. Each core segment must
/// fit a u64, so an overflowing segment can never be silently read as 0 by
/// [`is_newer`] (which still compares prerelease suffixes loosely; the
/// official `releases/latest` never names a prerelease). Versions are
/// spliced into artifact URLs and temp file names, so nothing else (path
/// separators, `..`, whitespace, query characters) may pass.
fn is_valid_version(version: &str) -> bool {
    if version.len() > MAX_VERSION_LEN {
        return false;
    }
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let core: Vec<&str> = core.split('.').collect();
    let core_ok = core.len() == 3
        && core.iter().all(|seg| {
            !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()) && seg.parse::<u64>().is_ok()
        });
    let prerelease_ok = prerelease.is_none_or(|pre| {
        pre.split('.')
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric()))
    });
    core_ok && prerelease_ok
}

/// Segment-wise version comparison: split on `.`, parse each segment as u64
/// (non-numeric counts as 0), zero-pad the shorter side; strictly greater
/// wins. `0.1` equals `0.1.0`; `0.1` beats `0.0.9`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|seg| seg.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let mut candidate = parse(candidate);
    let mut current = parse(current);
    let len = candidate.len().max(current.len());
    candidate.resize(len, 0);
    current.resize(len, 0);
    candidate > current
}

/// `update_download` only ever moves forward: an official latest release
/// that is not newer than the running build (a downgrade or a reinstall)
/// is refused before anything is downloaded.
fn ensure_newer(latest: &str, current: &str) -> Result<()> {
    if !is_newer(latest, current) {
        bail!("no newer release to install (latest v{latest}, running {current})");
    }
    Ok(())
}

/// Version-check answer for the webui updater store.
#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub available: bool,
    pub version: Option<String>,
}

/// Check the mirrors for a version newer than the running build. Errors are
/// returned as `Err` — the webui store surfaces them silently (AboutModal
/// only); the startup auto-check must never nag the user.
#[tauri::command]
pub async fn update_check() -> CommandResult<UpdateInfo> {
    let (version, _artifact_url) = resolve_latest().await?;
    let available = is_newer(&version, APP_VERSION);
    tracing::info!(latest = %version, current = APP_VERSION, available, "update check complete");
    Ok(UpdateInfo {
        current: APP_VERSION.to_string(),
        available,
        version: available.then_some(version),
    })
}

// ── Artifact download (via the unified download hub) ─────────────────────

fn emit_phase(app: &AppHandle, progress_phase: &str) {
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            id: JOB_ID.to_string(),
            kind: kind::UPDATE.to_string(),
            phase: progress_phase.to_string(),
            received: 0,
            total: 0,
            speed_bps: 0.0,
            detail: None,
            error: None,
        },
    );
}

/// Best-effort removal of stale `.part` leftovers (other versions/pids,
/// and the pre-hub per-racer layout): without this, the temp dir would
/// accumulate one orphaned multi-hundred-MB part per aborted launch.
/// Files still open on Windows fail to delete and are left for the OS
/// temp dir to reclaim.
async fn cleanup_part_files(keep: Option<&std::path::Path>) {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.starts_with("WoWSP-update-")
            && name.ends_with(".part")
            && Some(path.as_path()) != keep
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The download ladder for `version`: every reachable source, the ones whose
/// probe agreed with `version` first (each group in arrival order). The URL
/// is versioned and the bytes are verified against the official digest, so
/// a mirror whose `latest` redirect still names another release can still
/// serve this one — its opinion of "latest" only orders the ladder, it
/// never picks the artifact.
fn download_sources(version: &str, candidates: &[SourceCandidate]) -> Vec<String> {
    let (agreeing, others): (Vec<&SourceCandidate>, Vec<&SourceCandidate>) =
        candidates.iter().partition(|c| c.version == version);
    agreeing
        .into_iter()
        .chain(others)
        .map(|c| artifact_url(&c.base, version))
        .collect()
}

/// Download the new installer and hand it to the OS. The official latest
/// release names the version (refused unless newer than the running
/// build); every reachable mirror enters the download hub as one job: the
/// hub races the sources, streams through a single writer into the
/// version-scoped part file (resuming across failed/cancelled passes) and
/// walks its ladder on mirror death. On success the part file becomes
/// `WoWSP-update-<version>-<pid>.exe`, spawned with
/// `--silent --dir=<install dir>`; returns after that spawn — the hardened
/// installer then kills this app, installs over its directory and
/// relaunches the new build, so the webui treats the unresolved promise /
/// app exit as success by design.
#[tauri::command]
pub async fn update_download(app: AppHandle) -> CommandResult<()> {
    // Collapse double triggers (banner + About button) into one pass.
    let Some(guard) = UpdateGuard::begin(&UPDATE_PASS) else {
        return Ok(());
    };
    let result = update_download_inner(&app, &guard.pass).await;
    // Cancellation wins over an API/rename error racing with the click.
    guard.pass.check_cancelled()?;
    result.map_err(Into::into)
}

async fn update_download_inner(app: &AppHandle, pass: &UpdatePass) -> Result<()> {
    // Drop a stale cancel pressed while no pass was registered (e.g.
    // during the previous pass's installer spawn tail) - THIS attempt is
    // user-initiated and must not inherit it.
    download_hub::clear_pending(kind::UPDATE, JOB_ID);

    // ── Phase 1: official version + mirror resolution race ─────────────
    // The unified channel's race event lets the toast flip to its
    // indeterminate strip while the lookups settle.
    let watch = watch_config()?;
    let marker = watch
        .files
        .first()
        .ok_or_else(|| anyhow!("no marker file declared in the update sources"))?;
    let client = build_http_client()?;
    emit_phase(app, phase::RACE);
    // The version comes from the official channels — the relay digest
    // endpoint or api.github.com, cross-checked whenever both answer —
    // never from a mirror: the fastest mirror answering with an older
    // tag must not turn the update into a downgrade (or a reinstall).
    // The same answer carries the official digest every mirror byte is
    // verified against; without it the update is refused.
    let official = pass.run(official_release(&client)).await?;
    ensure_newer(&official.version, APP_VERSION)?;
    let version = official.version;
    // Every source is probed in parallel with a 10 s cap each; all that
    // answer enter the artifact race.
    let candidates = pass
        .run(race_sources(&client, &watch.sources, marker, true))
        .await?;
    let sources = download_sources(&version, &candidates);
    let expected_sha256 = official.sha256;
    tracing::info!(%version, racers = sources.len(), "update download starting");

    // Version-scoped, pid-suffixed temp name: the part survives failed
    // passes (the resume base of the next try — same version, same
    // process) while two app instances never share one file.
    let temp = std::env::temp_dir();
    let pid = std::process::id();
    let part_path = temp.join(format!("WoWSP-update-{version}-{pid}.part"));
    let installer_path = temp.join(format!("WoWSP-update-{version}-{pid}.exe"));
    // Sweep parts of other versions/pids (and the pre-hub multi-racer
    // layout) so the temp dir cannot accumulate one stale part per
    // launch; a running instance's part is held open and simply fails
    // the best-effort delete on Windows.
    cleanup_part_files(Some(&part_path)).await;
    pass.check_cancelled()?;

    // ── Phase 2: queued transfer through the unified download hub ─────
    // Cancellation still wins over a transfer error racing with the click
    // (the check_cancelled below runs after the boundary).
    let transferred = download_hub::transfer(
        Some(app),
        DownloadRequest {
            min_bytes: MIN_INSTALLER_BYTES,
            race_window: Some(RACE_WINDOW),
            resume: true,
            cancel_msg: CANCEL_MSG.to_string(),
            // Verified streaming against GitHub's own digest: a mirror
            // serving tampered or truncated bytes fails the check and the
            // hub moves on to the next candidate.
            expected_sha256: Some(expected_sha256),
            // The transfer stays bounded: an unbounded stream would
            // head-of-line-block every later hub job (pack / mods / data
            // pack) behind a dead connection.
            timeout: Some(Duration::from_secs(7200)),
            ..DownloadRequest::new(JOB_ID, kind::UPDATE, sources, part_path)
        },
    )
    .await;
    pass.check_cancelled()?;
    let done = transferred?;
    tracing::info!(%version, bytes = done.bytes, "installer artifact ready");

    // ── Assemble ────────────────────────────────────────────────────────
    // The completed part becomes the installer. Retry briefly: the
    // writer's tokio-side file close can land just after the hub returns.
    let mut renamed = tokio::fs::rename(&done.path, &installer_path).await;
    for _ in 0..3 {
        if renamed.is_ok() {
            break;
        }
        pass.run(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok(())
        })
        .await?;
        renamed = tokio::fs::rename(&done.path, &installer_path).await;
    }
    renamed.map_err(|e| anyhow!("assemble {}: {e}", installer_path.display()))?;
    cleanup_part_files(None).await;

    // Install over the directory the running exe lives in; the hardened
    // installer takes it from here — it kills this app, extracts, leaves
    // every launcher untouched (they point at the same exe) and relaunches
    // the new build. No shortcut flags ride along: the shun headless
    // lane re-applies the manifest policy (start menu always, desktop
    // asked → checked), refreshing launchers in place — paths are
    // stable, so existing links stay valid.
    let install_dir = std::env::current_exe()
        .map_err(|e| anyhow!("resolve current exe: {e}"))?
        .parent()
        .ok_or_else(|| anyhow!("current exe has no parent directory"))?
        .to_path_buf();
    // Tell the webui the install phase started even though the spawned
    // installer may kill this app before the command's promise settles.
    pass.begin_install()?;
    emit_phase(app, phase::INSTALL);
    std::process::Command::new(&installer_path)
        .args(["--silent", &format!("--dir={}", install_dir.display())])
        .spawn()
        .map_err(|e| anyhow!("spawn installer {}: {e}", installer_path.display()))?;
    // The last line the running build writes before the installer kills it —
    // when an update reports "nothing happened", this is the fork in the
    // trail: present here means the handoff succeeded.
    tracing::info!(%version, installer = %installer_path.display(), "installer spawned; handing off");

    Ok(())
}

/// The banner's 取消 button: interrupt resolution/digest reads and cancel
/// the hub job, retaining downloaded bytes for a later retry. The pass
/// returns `Err("update cancelled")`, which the frontend treats as a clean
/// reset. A no-op between passes or after installer handoff begins.
#[tauri::command]
pub fn update_cancel() -> CommandResult<()> {
    // Keep the registration locked until the hub sees the cancel, so the
    // previous pass cannot leave a pending cancel in a newly started pass.
    let active = UPDATE_PASS.lock().unwrap_or_else(|e| e.into_inner());
    if active.as_ref().is_some_and(|pass| pass.cancel()) {
        tracing::info!("update download cancelled by user");
        download_hub::cancel(kind::UPDATE, JOB_ID);
    }
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_lookup() {
        use tokio::io::AsyncReadExt;

        let pass = UpdatePass::default();
        // A local HTTPS proxy accepts CONNECT but never establishes the
        // tunnel. Exercise the real official-digest request without any
        // external traffic or a test-only alternate trust anchor.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::https(proxy).unwrap())
            .build()
            .unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"CONNECT api.github.com:443 "));
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        let cancel = async {
            ready.await.unwrap();
            assert!(pass.cancel());
        };
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(pass.run(fetch_official_release(&client)), cancel)
        })
        .await;
        server.abort();
        let (result, ()) =
            outcome.expect("cancel must not wait for the lookup's 20-second timeout");
        assert_eq!(result.unwrap_err().to_string(), CANCEL_MSG);
    }

    #[tokio::test]
    async fn cancellation_wins_over_a_lookup_error_in_the_same_poll() {
        let pass = UpdatePass::default();
        let result: Result<()> = pass
            .run(async {
                assert!(pass.cancel());
                Err(anyhow!("official digest unavailable"))
            })
            .await;
        assert_eq!(result.unwrap_err().to_string(), CANCEL_MSG);
    }

    #[tokio::test]
    async fn cancellation_before_lookup_never_polls_the_request() {
        let pass = UpdatePass::default();
        assert!(pass.cancel());
        let result: Result<()> = pass
            .run(async { panic!("a cancelled pass must not start another request") })
            .await;
        assert_eq!(result.unwrap_err().to_string(), CANCEL_MSG);
    }

    #[tokio::test]
    async fn an_uncancelled_lookup_preserves_integrity_errors() {
        let pass = UpdatePass::default();
        let result: Result<()> = pass
            .run(async { Err(anyhow!("release publishes no sha256 digest")) })
            .await;
        assert_eq!(
            result.unwrap_err().to_string(),
            "release publishes no sha256 digest"
        );
    }

    #[test]
    fn cancelled_pass_cannot_hand_off_to_the_installer() {
        let pass = UpdatePass::default();
        assert!(pass.cancel());
        assert_eq!(pass.begin_install().unwrap_err().to_string(), CANCEL_MSG);
    }

    #[test]
    fn handoff_is_the_last_cancellable_point() {
        let pass = UpdatePass::default();
        pass.begin_install().unwrap();
        assert!(!pass.cancel());
        assert!(pass.check_cancelled().is_ok());
    }

    #[test]
    fn retry_gets_a_new_pass_and_an_old_cancel_cannot_reach_it() {
        let registry = Mutex::new(None);
        let first = UpdateGuard::begin(&registry).unwrap();
        assert!(UpdateGuard::begin(&registry).is_none());
        let previous = Arc::clone(&first.pass);
        previous.cancel();
        drop(first);
        let retry = UpdateGuard::begin(&registry).unwrap();
        previous.cancel();
        assert!(retry.pass.check_cancelled().is_ok());
    }

    #[test]
    fn newer_patch_is_detected() {
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.1"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1", "0.1.0"));
        assert!(!is_newer("0.1.0.0", "0.1"));
    }

    #[test]
    fn shorter_version_zero_pads() {
        // 0.1 vs 0.0.9: 0 == 0, 1 > 0 → newer.
        assert!(is_newer("0.1", "0.0.9"));
        assert!(!is_newer("0.0", "0.0.9"));
    }

    #[test]
    fn non_numeric_segments_count_as_zero() {
        assert!(is_newer("0.2.0-beta", "0.1.9")); // 0.2.0 > 0.1.9
        assert!(!is_newer("0.1.0-rc", "0.1")); // 0.1.0 == 0.1.0 ("rc" → 0)
        // Tags after a second dot just segment further ("0.1.0-rc.1" →
        // 0.1.0.1, newer than 0.1.0.0). The `latest` marker only ever
        // carries plain release tags, so no semver-prerelease ordering is
        // attempted here — the simple rule is the design.
        assert!(is_newer("0.1.0-rc.1", "0.1"));
        assert!(!is_newer("abc", "0.0.1")); // 0.0.0 < 0.0.1
    }

    #[test]
    fn major_bump_wins_over_patch() {
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn embedded_config_has_latest_marker_and_sources() {
        let watch = watch_config().expect("embedded config parses");
        assert!(!watch.sources.is_empty(), "at least one mirror source");
        assert!(watch.sources.iter().all(|s| s.starts_with("https://")));
        assert_eq!(watch.files, vec!["latest".to_string()]);
    }

    #[test]
    fn embedded_sources_match_the_shared_mirror_ladder() {
        // Cargo.toml's `[package.metadata.shun.update]` table and
        // `github_mirror.rs` both declare the official-first mirror list;
        // this test fails when they drift apart.
        let watch = watch_config().expect("embedded config parses");
        assert_eq!(watch.sources, super::super::github_mirror::update_sources());
    }

    #[test]
    fn app_version_is_a_clean_semver() {
        assert_eq!(APP_VERSION.trim(), APP_VERSION, "no stray whitespace");
        assert!(
            APP_VERSION.split('.').count() >= 2,
            "version carries at least major.minor: {APP_VERSION}"
        );
        assert!(
            is_valid_version(APP_VERSION),
            "the running build's version passes the same strict check: {APP_VERSION}"
        );
    }

    #[test]
    fn artifact_url_matches_build_script_emission() {
        // App updates always fetch the -lite artifact from the release's
        // VERSIONED download tree — the URL carries both the version and
        // the file name and never rides the moving latest mount.
        assert_eq!(
            artifact_url(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.1.0"
            ),
            "https://github.com/langyo/wowsp/releases/download/v0.1.0/WoWSP_0.1.0_x64-installer-lite.exe"
        );
        // Mirror prefixes ride along: only the mount tail is rewritten.
        assert_eq!(
            artifact_url(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download",
                "0.5.9"
            ),
            "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/download/v0.5.9/WoWSP_0.5.9_x64-installer-lite.exe"
        );
    }

    #[test]
    fn versioned_download_base_rewrites_the_latest_mount() {
        // The configured sources end with the /releases/latest/download
        // mount (the discovery side); downloads rewrite exactly that tail.
        assert_eq!(
            versioned_download_base("https://github.com/langyo/wowsp/releases/latest/download"),
            "https://github.com/langyo/wowsp/releases/download"
        );
        // Trailing slashes and stray whitespace are trimmed before matching.
        assert_eq!(
            versioned_download_base(
                "https://ghfast.top/https://github.com/langyo/wowsp/releases/latest/download/"
            ),
            "https://ghfast.top/https://github.com/langyo/wowsp/releases/download"
        );
        // A base without the mount is taken as a versioned root as-is.
        assert_eq!(
            versioned_download_base("https://mirror.example.test/files/"),
            "https://mirror.example.test/files"
        );
    }

    #[test]
    fn tag_url_strips_the_download_mount() {
        // Configured sources end in /releases/latest/download — the tag
        // probe wants the redirecting page one step up.
        assert_eq!(
            tag_url_from_source("https://github.com/langyo/wowsp/releases/latest/download"),
            "https://github.com/langyo/wowsp/releases/latest"
        );
        // Trailing slashes are trimmed first either way.
        assert_eq!(
            tag_url_from_source(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download/"
            ),
            "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest"
        );
        // A source without the suffix is passed through untouched (its tag
        // probe fails and the marker fallback takes over).
        assert_eq!(
            tag_url_from_source("https://mirror.example.test/files/"),
            "https://mirror.example.test/files"
        );
    }

    #[test]
    fn version_from_redirect_reads_the_tag_segment() {
        // The canonical GitHub redirect target.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/tag/v0.3.0"),
            Some("0.3.0".to_string())
        );
        // A mirror that re-hosts the redirect keeps the same path shape.
        assert_eq!(
            version_from_redirect(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/tag/v1.2.3"
            ),
            Some("1.2.3".to_string())
        );
        // Query strings and trailing slashes must not leak into the version.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/tag/v0.3.0?ref=xx/"),
            Some("0.3.0".to_string())
        );
        // A tag without the v prefix still parses.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/tag/0.4.0"),
            Some("0.4.0".to_string())
        );
        // Non-tag landings (proxy followed internally, error page, plain
        // source echo) resolve nothing — the marker fallback then decides.
        assert_eq!(
            version_from_redirect("https://github.com/langyo/wowsp/releases/latest"),
            None
        );
        assert_eq!(
            version_from_redirect(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download"
            ),
            None
        );
        assert_eq!(
            version_from_redirect("https://example.test/tag/"),
            None,
            "empty tag name"
        );
    }

    #[test]
    fn release_api_targets_github_directly() {
        // The version + digest source must never be a mirror prefix.
        assert_eq!(
            LATEST_RELEASE_API,
            "https://api.github.com/repos/langyo/wowsp/releases/latest"
        );
    }

    #[test]
    fn release_versions_are_accepted() {
        for version in [
            "0.1.0",
            "0.4.11",
            "0.6.0",
            "1.0.0",
            "10.20.30",
            "0.7.0-beta",
            "0.7.0-beta.1",
            "0.1.0-rc.1",
            "1.0.0-0.3.7",
        ] {
            assert!(is_valid_version(version), "{version}");
        }
    }

    #[test]
    fn malformed_versions_are_rejected() {
        for version in [
            "",
            "0.6",
            "0.6.0.1",
            "v0.6.0",
            "V0.6.0",
            " 0.6.0",
            "0.6.0\n",
            "0.6.0-",
            "0.6.0-beta.",
            "0.6.0-beta..1",
            "0.6.0-be-ta",
            "0.6.0+build.1",
            "0.6.0-be/ta",
            "0.6.0/../../evil",
            "../../../evil",
            "0.6.0?x=1",
            "0.6.0#frag",
            "0.6.0%2F..",
            "0..0",
            "a.b.c",
            "-1.0.0",
            "+1.0.0",
            "99999999999999999999.0.0",
            "latest",
            "res-latest",
            "<html>",
        ] {
            assert!(!is_valid_version(version), "{version:?}");
        }
        let long = format!("0.6.0-{}", "a".repeat(MAX_VERSION_LEN));
        assert!(!is_valid_version(&long), "over-long");
    }

    #[test]
    fn update_download_refuses_a_downgrade() {
        // The attack: a stale or hostile source names v0.5.4 (a pre-digest
        // build whose own updater verifies nothing).
        let err = ensure_newer("0.5.4", "0.6.1").unwrap_err().to_string();
        assert!(err.contains("no newer release"), "{err}");
        assert!(ensure_newer("0.6.0", "0.6.1").is_err());
        assert!(ensure_newer("0.6.1", "1.0.0").is_err());
    }

    #[test]
    fn update_download_refuses_the_running_version() {
        assert!(ensure_newer("0.6.1", "0.6.1").is_err());
    }

    #[test]
    fn update_download_accepts_a_newer_release() {
        assert!(ensure_newer("0.6.2", "0.6.1").is_ok());
        assert!(ensure_newer("0.7.0", "0.6.9").is_ok());
        assert!(ensure_newer("1.0.0", "0.99.99").is_ok());
    }

    #[test]
    fn mixed_mirror_versions_never_pick_the_artifact() {
        let candidate = |base: &str, version: &str| SourceCandidate {
            base: base.to_string(),
            version: version.to_string(),
        };
        // Arrival order: a stale mirror answers first, a hostile one claims
        // a bogus higher release, and the up-to-date sources come last.
        let candidates = [
            candidate(
                "https://ghfast.top/https://github.com/langyo/wowsp/releases/latest/download",
                "0.5.4",
            ),
            candidate(
                "https://ghp.ci/https://github.com/langyo/wowsp/releases/latest/download",
                "9.9.9",
            ),
            candidate(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.6.2",
            ),
            candidate(
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/latest/download",
                "0.6.2",
            ),
        ];
        // The official version decides; agreeing sources lead the ladder
        // and every source fetches the official version's artifact.
        assert_eq!(
            download_sources("0.6.2", &candidates),
            vec![
                "https://github.com/langyo/wowsp/releases/download/v0.6.2/WoWSP_0.6.2_x64-installer-lite.exe",
                "https://gh-proxy.com/https://github.com/langyo/wowsp/releases/download/v0.6.2/WoWSP_0.6.2_x64-installer-lite.exe",
                "https://ghfast.top/https://github.com/langyo/wowsp/releases/download/v0.6.2/WoWSP_0.6.2_x64-installer-lite.exe",
                "https://ghp.ci/https://github.com/langyo/wowsp/releases/download/v0.6.2/WoWSP_0.6.2_x64-installer-lite.exe",
            ]
        );
        // Even when no mirror agrees, the official version is fetched.
        assert_eq!(
            download_sources("0.6.3", &candidates[..1]),
            vec![
                "https://ghfast.top/https://github.com/langyo/wowsp/releases/download/v0.6.3/WoWSP_0.6.3_x64-installer-lite.exe"
            ]
        );
    }

    #[test]
    fn official_release_names_the_version_and_digest() {
        let hex = "8d88e539c25d9b8a0705c9f858f616e68f6d8ef13af4de7a00af39fb10593927";
        let release = serde_json::json!({
            "tag_name": "v0.6.0",
            "assets": [
                { "name": "WoWSP_0.6.0_x64-installer-lite.exe", "digest": format!("sha256:{hex}") },
            ]
        });
        assert_eq!(
            parse_official_release(&release).unwrap(),
            OfficialRelease {
                version: "0.6.0".to_string(),
                sha256: hex.to_string(),
            }
        );
    }

    #[test]
    fn official_release_rejects_malformed_tags_and_missing_digests() {
        let digest = format!("sha256:{}", "a".repeat(64));
        for tag in [
            serde_json::Value::Null,
            "0.6.0".into(),
            "v0.6".into(),
            "v../../evil".into(),
            "res-latest".into(),
            "v0.6.0/../x".into(),
        ] {
            let release = serde_json::json!({
                "tag_name": tag,
                "assets": [{ "name": "WoWSP_0.6.0_x64-installer-lite.exe", "digest": digest }]
            });
            assert!(parse_official_release(&release).is_err(), "{tag}");
        }
        let without_lite = serde_json::json!({
            "tag_name": "v0.6.0",
            "assets": [{ "name": "WoWSP_0.6.0_x64-installer.exe", "digest": digest }]
        });
        let err = parse_official_release(&without_lite)
            .unwrap_err()
            .to_string();
        assert!(err.contains("publishes no sha256 digest"), "{err}");
    }

    #[test]
    fn relay_digest_names_the_version_and_digest() {
        let hex = "8d88e539c25d9b8a0705c9f858f616e68f6d8ef13af4de7a00af39fb10593927";
        let doc = serde_json::json!({
            "channel": "app",
            "tag": "v0.6.0",
            "seq": 3,
            "generated_at": "2026-10-14T12:00:00Z",
            "assets": {
                "WoWSP_0.6.0_x64-installer-lite.exe": hex,
                "WoWSP_0.6.0_x64-installer.exe": format!("sha256:{hex}"),
            }
        });
        assert_eq!(
            parse_relay_digest(&doc).unwrap(),
            RelayDigest {
                release: OfficialRelease {
                    version: "0.6.0".to_string(),
                    sha256: hex.to_string(),
                },
                seq: 3,
            }
        );
    }

    #[test]
    fn relay_digest_rejects_the_wrong_shapes() {
        let hex = "a".repeat(64);
        let doc = |channel: &str, tag: &str, digest: serde_json::Value| {
            serde_json::json!({
                "channel": channel,
                "tag": tag,
                "seq": 4,
                "assets": { "WoWSP_0.6.0_x64-installer-lite.exe": digest },
            })
        };
        // Foreign channel, non-v / malformed tags, missing digest entry.
        assert!(parse_relay_digest(&doc("res", "v0.6.0", hex.clone().into())).is_err());
        assert!(parse_relay_digest(&doc("app", "0.6.0", hex.clone().into())).is_err());
        assert!(parse_relay_digest(&doc("app", "v0.6.0/../x", hex.clone().into())).is_err());
        assert!(parse_relay_digest(&doc("app", "v0.6.0", serde_json::json!(null))).is_err());
        // Bad digests: wrong length, non-hex, GitHub's prefixed spelling.
        assert!(parse_relay_digest(&doc("app", "v0.6.0", "a".repeat(63).into())).is_err());
        assert!(parse_relay_digest(&doc("app", "v0.6.0", "G".repeat(64).into())).is_err());
        assert!(
            parse_relay_digest(&doc("app", "v0.6.0", format!("sha256:{hex}").into())).is_err(),
            "the relay spelling is bare hex — a prefixed digest is a shape error"
        );
        // The publish counter is mandatory: absent or zero both refuse
        // the doc.
        let without_seq = serde_json::json!({
            "channel": "app",
            "tag": "v0.6.0",
            "assets": { "WoWSP_0.6.0_x64-installer-lite.exe": hex },
        });
        assert!(parse_relay_digest(&without_seq).is_err());
        let zero_seq = serde_json::json!({
            "channel": "app",
            "tag": "v0.6.0",
            "seq": 0,
            "assets": { "WoWSP_0.6.0_x64-installer-lite.exe": "b".repeat(64) },
        });
        assert!(parse_relay_digest(&zero_seq).is_err());
    }

    #[test]
    fn relay_seq_only_advances() {
        assert!(ensure_seq_advances(None, 1).is_ok());
        assert!(ensure_seq_advances(Some(4), 5).is_ok());
        // Equal is a replay, lower is a revert — both refused.
        assert!(ensure_seq_advances(Some(4), 4).is_err());
        let reverted = ensure_seq_advances(Some(9), 2).unwrap_err().to_string();
        assert!(reverted.contains("regressed"), "{reverted}");
    }

    /// A throwaway keypair (seed bytes 0..32) whose signature below was
    /// produced by scripts/catalog_signing.py's canonical form — the
    /// cross-language parity fixture. NOT a trust anchor; production
    /// pins nothing yet (PINNED_DIGEST_KEYS is empty).
    const TEST_DIGEST_KEY: (&str, &str) = ("test", "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=");

    fn signed_digest_fixture() -> serde_json::Value {
        serde_json::json!({
            "channel": "app",
            "tag": "v0.6.0",
            "seq": 3,
            "generated_at": "2026-10-14T12:00:00Z",
            "assets": {
                "WoWSP_0.6.0_x64-installer-lite.exe":
                    "8d88e539c25d9b8a0705c9f858f616e68f6d8ef13af4de7a00af39fb10593927"
            },
            "key_id": "test",
            "sig": "oX05q6v+4ScQSmS08ryM0/ptDB4a3pL7N+eodLZfs4MbMok9j6eK1+20XM2NvB7wCl97zg5hEzfv4E5qaWj7BQ=="
        })
    }

    #[test]
    fn relay_digest_signature_verifies_across_languages() {
        let keys = [TEST_DIGEST_KEY];
        // The python-signed fixture parses AND verifies: this is the
        // canonical-bytes parity proof (sorted-key compact JSON).
        let parsed = parse_relay_digest_with(&signed_digest_fixture(), &keys).unwrap();
        assert_eq!(parsed.seq, 3);
        assert_eq!(parsed.release.version, "0.6.0");

        // Any tampering of a signed member breaks the signature.
        let mut tampered_seq = signed_digest_fixture();
        tampered_seq["seq"] = 4u64.into();
        let err = parse_relay_digest_with(&tampered_seq, &keys)
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not verify"), "{err}");

        // Unknown key ids are refused even with a valid signature.
        let mut wrong_key = signed_digest_fixture();
        wrong_key["key_id"] = "other".into();
        assert!(parse_relay_digest_with(&wrong_key, &keys).is_err());

        // Half-signed is refused.
        let mut half = signed_digest_fixture();
        half.as_object_mut().unwrap().remove("sig");
        assert!(parse_relay_digest_with(&half, &keys).is_err());
        let mut other_half = signed_digest_fixture();
        other_half.as_object_mut().unwrap().remove("key_id");
        assert!(parse_relay_digest_with(&other_half, &keys).is_err());

        // Unsigned: refused while keys are pinned, accepted in the
        // no-keys-pinned transition (production today).
        let mut unsigned = signed_digest_fixture();
        unsigned.as_object_mut().unwrap().remove("sig");
        unsigned.as_object_mut().unwrap().remove("key_id");
        let refused = parse_relay_digest_with(&unsigned, &keys)
            .unwrap_err()
            .to_string();
        assert!(refused.contains("unsigned"), "{refused}");
        assert!(parse_relay_digest_with(&unsigned, &[]).is_ok());
    }

    #[test]
    fn choose_official_cross_checks_the_channels() {
        let a = OfficialRelease {
            version: "0.6.0".to_string(),
            sha256: "a".repeat(64),
        };
        let b = OfficialRelease {
            version: "0.6.1".to_string(),
            sha256: "b".repeat(64),
        };
        let ok = |r: OfficialRelease| Ok(r);
        let err = || Err(anyhow::anyhow!("unreachable"));

        // Agreement passes; either channel alone suffices.
        assert_eq!(choose_official(ok(a.clone()), ok(a.clone())).unwrap(), a);
        assert_eq!(choose_official(ok(a.clone()), err()).unwrap(), a);
        assert_eq!(choose_official(err(), ok(a.clone())).unwrap(), a);
        // Disagreement is a hard refusal naming both sides.
        let refused = choose_official(ok(a), ok(b)).unwrap_err().to_string();
        assert!(refused.contains("disagree"), "{refused}");
        // Neither channel leaves only the error to report/retry.
        assert!(choose_official(err(), err()).is_err());
    }

    #[test]
    fn asset_sha256_picks_the_lite_installer_digest() {
        let hex = "5c25dea369c26b8889c1a0dcd8697d0de6f138c12a68721e47479cd9c675116d";
        let release = serde_json::json!({
            "assets": [
                { "name": "latest", "digest": "sha256:8878893c4e9b58612d5d96a468552e495493152ae49a02196c9af550c556e71d" },
                { "name": "WoWSP_0.5.4_x64-installer-lite.exe", "digest": format!("sha256:{}", hex.to_uppercase()) },
                { "name": "WoWSP_0.5.4_x64-installer.exe", "digest": "sha256:05ba4ab13167014d9ed80f99e4ba5d191b20c859b98689425433075dbe779577" },
            ]
        });
        assert_eq!(
            asset_sha256(&release, &artifact_name("0.5.4")),
            Some(hex.to_string()),
            "matched by exact name and normalized to lowercase"
        );
    }

    #[test]
    fn asset_sha256_rejects_missing_or_malformed_digests() {
        let name = artifact_name("0.5.4");
        let with_digest = |digest: serde_json::Value| serde_json::json!({ "assets": [{ "name": name, "digest": digest }] });
        assert_eq!(
            asset_sha256(&serde_json::json!({}), &name),
            None,
            "no assets"
        );
        assert_eq!(
            asset_sha256(&serde_json::json!({ "assets": [{ "name": name }] }), &name),
            None,
            "asset without a digest"
        );
        assert_eq!(
            asset_sha256(&with_digest(serde_json::Value::Null), &name),
            None
        );
        assert_eq!(
            asset_sha256(
                &with_digest("md5:d41d8cd98f00b204e9800998ecf8427e".into()),
                &name
            ),
            None,
            "non-sha256 algorithm"
        );
        assert_eq!(
            asset_sha256(&with_digest("sha256:abc".into()), &name),
            None,
            "short"
        );
        assert_eq!(
            asset_sha256(
                &with_digest(format!("sha256:{}", "z".repeat(64)).into()),
                &name
            ),
            None,
            "non-hex"
        );
        assert_eq!(
            asset_sha256(
                &with_digest(format!("sha256:{}", "a".repeat(64)).into()),
                "other.exe"
            ),
            None,
            "other asset name"
        );
    }
}
