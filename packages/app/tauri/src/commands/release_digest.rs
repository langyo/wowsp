//! Official sha256 digests of this repository's release assets.
//!
//! Every release asset the app consumes — the updater's installer, the
//! Mod Hub index, the resource pack and its chain patches, the data pack —
//! may stream through third-party mirrors (see [`super::github_mirror`]).
//! A mirror able to serve both a payload and the hash published next to it
//! could forge both, so the trust anchors are two channels the payload
//! mirrors can influence neither:
//!
//! 1. the `digest` GitHub itself computes for every release asset, read
//!    straight from `api.github.com` (never a mirror prefix), and
//! 2. the pairing relay worker's signed digest docs
//!    (`GET /api/digests/<channel>[/<tag>]`, see relay-core's `digests`
//!    module and scripts/publish_digests.py) — reachable where
//!    api.github.com is not, and pinned to compile-time Ed25519 keys so
//!    neither the KV store nor the worker can forge one.
//!
//! Both legs run concurrently; a channel that answers alone decides, and
//! two answering channels must agree (a disagreement is terminal). A
//! digest that WAS obtained is always binding, and a channel that answers
//! but cannot name the asset's digest is an `Err`. Whether NO reachable
//! channel also blocks is the caller's choice: [`fetch_official_sha256`]
//! fails closed (Mod Hub — its payloads execute, like the updater's),
//! [`lookup_official_sha256`] reports [`OfficialDigest::Unavailable`] so
//! content-only channels (resource and data packs) can keep their
//! mirror-manifest path.
//!
//! The app's proxy settings still apply (the shared proxy-aware client);
//! only the third-party mirror ladder is bypassed. Each GitHub API
//! document's ETag is remembered for the process lifetime and revalidated
//! with `If-None-Match` — a 304 does not count against the unauthenticated
//! 60-requests-per-hour limit. The updater's app-channel flow
//! (`update.rs::official_release`) consumes this module's shared pieces
//! (signature verification, seq ratchet, channel combiner).

use anyhow::{Result, anyhow, bail};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// The repository every consumed release lives on.
const API_REPO: &str = "https://api.github.com/repos/langyo/wowsp";

/// The official download tree of this repository's releases
/// (`…/releases/download/<tag>/<asset>`). Release assets are only ever
/// fetched below it; the mirror ladder fronts it by URL prefix.
pub const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/langyo/wowsp/releases/download/";

/// Per-attempt cap on an API lookup (the payloads are a few hundred KB at
/// most).
const API_TIMEOUT: Duration = Duration::from_secs(20);

/// Attempts at an API lookup (transport failures and 5xx only).
const API_ATTEMPTS: u32 = 3;

/// Back-off before retry `n` (`n × RETRY_DELAY`).
const RETRY_DELAY: Duration = Duration::from_millis(750);

/// Per-attempt cap and attempts for a relay digest fetch — the fast path
/// gets two short tries before the GitHub budget takes over.
const RELAY_DIGEST_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_DIGEST_ATTEMPTS: u32 = 2;

/// The GitHub cross-check leg runs as ONE attempt with the relay's short
/// cap, so a blackholed api.github.com costs at most one timeout — paid in
/// parallel with the relay leg, never serialized.
const QUICK_API_TIMEOUT: Duration = Duration::from_secs(10);

/// The channels the relay's digest endpoint serves. This mirrors
/// relay-core's `DIGEST_CHANNELS` — that crate belongs to the worker and
/// is not a dependency of the app, so the set is restated here and must
/// not drift (publish_digests.py pushes exactly these).
pub const DIGEST_CHANNELS: [&str; 4] = ["app", "mod-hub", "res", "data"];

/// A channel name the relay endpoint would serve.
fn valid_channel(channel: &str) -> bool {
    DIGEST_CHANNELS.contains(&channel)
}

/// The official release API for one tag. Deliberately NOT routed through
/// `github_mirror`.
pub fn release_api_url(tag: &str) -> String {
    format!("{API_REPO}/releases/tags/{tag}")
}

/// The official release list (newest first, one page of 100).
pub fn releases_api_url() -> String {
    format!("{API_REPO}/releases?per_page=100")
}

/// The official download URL of one release asset.
pub fn release_download_url(tag: &str, asset: &str) -> String {
    format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{asset}")
}

/// A tag or asset name usable as one URL path segment: non-empty, not a
/// dot segment, and limited to the characters release names actually use
/// — no `/`, `\`, `%`, `?` or `#` that could re-target the URL once a
/// client normalizes it.
pub fn is_plain_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
}

/// Whether `url` names exactly one asset on this repository's official
/// release download tree (`<prefix><tag>/<asset>`, plain segments only).
pub fn is_release_download_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(RELEASE_DOWNLOAD_PREFIX) else {
        return false;
    };
    let mut segments = rest.split('/');
    match (segments.next(), segments.next(), segments.next()) {
        (Some(tag), Some(asset), None) => is_plain_segment(tag) && is_plain_segment(asset),
        _ => false,
    }
}

/// Whether `s` is a well-formed sha256 hex string (either case).
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Lowercase hex sha256 of an in-memory body.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The lowercase sha256 GitHub computed for asset `name` in a release-API
/// object (`"digest": "sha256:<hex>"`). `None` when the asset is missing,
/// carries no digest, or the digest is not a well-formed sha256.
pub fn asset_sha256(release: &serde_json::Value, name: &str) -> Option<String> {
    let hex = release["assets"]
        .as_array()?
        .iter()
        .find(|asset| asset["name"].as_str() == Some(name))?["digest"]
        .as_str()?
        .strip_prefix("sha256:")?;
    is_sha256_hex(hex).then(|| hex.to_ascii_lowercase())
}

/// One official API lookup that did not fail outright.
pub enum ApiLookup {
    /// The document (fresh, or the cached copy a 304 revalidated).
    Found(serde_json::Value),
    /// The API is unreachable or refusing service for now: transport
    /// failures or 5xx on every attempt, or 403/429 rate limiting.
    Unavailable(String),
}

/// What a non-success HTTP status means for an API lookup.
#[derive(Debug, PartialEq)]
enum StatusVerdict {
    /// Server-side trouble: retry after a short delay.
    Retry,
    /// Rate limited (GitHub answers 403 or 429): retrying only burns the
    /// budget, report the API as unavailable right away.
    Unavailable,
    /// Anything else (404 for a missing tag, other 4xx): a definitive
    /// answer, never retried and never a reason to fall back.
    Fatal,
}

fn status_verdict(status: reqwest::StatusCode) -> StatusVerdict {
    if status.is_server_error() {
        StatusVerdict::Retry
    } else if status == reqwest::StatusCode::FORBIDDEN
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        StatusVerdict::Unavailable
    } else {
        StatusVerdict::Fatal
    }
}

/// Last (ETag, document) seen per API URL, for conditional revalidation.
static ETAG_CACHE: LazyLock<Mutex<HashMap<String, (String, serde_json::Value)>>> =
    LazyLock::new(Default::default);

/// One conditional GET of an official API document through the ETag cache.
/// The caller owns the retry budget: `Retryable` covers transport
/// failures, unparsable bodies, 5xx and a 304 without a cached copy,
/// `Unavailable` the rate-limit statuses, and definitive statuses (404 …)
/// are an `Err`.
enum ApiAttempt {
    Found(serde_json::Value),
    Unavailable(String),
    Retryable(String),
}

async fn api_attempt(client: &reqwest::Client, url: &str, timeout: Duration) -> Result<ApiAttempt> {
    debug_assert!(
        url.starts_with(API_REPO),
        "official lookups must target {API_REPO}, got {url}"
    );
    let cached = ETAG_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(url).cloned());
    let mut request = client
        .get(url)
        .header("User-Agent", concat!("WoWSP/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .timeout(timeout);
    if let Some((etag, _)) = &cached {
        request = request.header("If-None-Match", etag.as_str());
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return Ok(ApiAttempt::Retryable(format!("{url}: {e}"))),
    };
    let status = response.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        if let Some((_, doc)) = &cached {
            return Ok(ApiAttempt::Found(doc.clone()));
        }
        return Ok(ApiAttempt::Retryable(format!(
            "{url}: HTTP 304 without a cached copy"
        )));
    }
    if !status.is_success() {
        return match status_verdict(status) {
            StatusVerdict::Retry => Ok(ApiAttempt::Retryable(format!("{url}: HTTP {status}"))),
            StatusVerdict::Unavailable => {
                Ok(ApiAttempt::Unavailable(format!("{url}: HTTP {status}")))
            },
            StatusVerdict::Fatal => bail!("{url}: HTTP {status}"),
        };
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match response.json::<serde_json::Value>().await {
        Ok(doc) => {
            if let (Some(etag), Ok(mut cache)) = (etag, ETAG_CACHE.lock()) {
                cache.insert(url.to_string(), (etag, doc.clone()));
            }
            Ok(ApiAttempt::Found(doc))
        },
        Err(e) => Ok(ApiAttempt::Retryable(format!("parse {url}: {e}"))),
    }
}

/// GET one official API document. Transport failures, unparsable bodies
/// and 5xx are retried with a short back-off; 403/429 end the lookup as
/// [`ApiLookup::Unavailable`] at once; any other status is an `Err`.
pub async fn lookup_api_json(client: &reqwest::Client, url: &str) -> Result<ApiLookup> {
    let mut last_err = String::new();
    for attempt in 0..API_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(RETRY_DELAY * attempt).await;
        }
        match api_attempt(client, url, API_TIMEOUT).await? {
            ApiAttempt::Found(doc) => return Ok(ApiLookup::Found(doc)),
            ApiAttempt::Unavailable(e) => return Ok(ApiLookup::Unavailable(e)),
            ApiAttempt::Retryable(e) => last_err = e,
        }
    }
    Ok(ApiLookup::Unavailable(last_err))
}

/// One short GitHub attempt for the dual-channel cross-check: no retry
/// budget, so the blocked-GitHub path costs a single timeout, paid in
/// parallel with the relay leg. Transient shapes read as "GitHub silent
/// right now"; definitive errors are an `Err`.
async fn github_doc_quick(client: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    match api_attempt(client, url, QUICK_API_TIMEOUT).await? {
        ApiAttempt::Found(doc) => Ok(doc),
        ApiAttempt::Retryable(e) | ApiAttempt::Unavailable(e) => Err(anyhow!(e)),
    }
}

// ── The pairing relay's signed digest docs ──────────────────────────────

/// Compile-time pinned Ed25519 public keys (standard base64 of the 32
/// raw bytes) that relay digest docs may be signed with. The private
/// seeds NEVER enter this repository (AGENTS.md §7) — see the ceremony
/// in scripts/catalog_signing.py and res/keys/README.md (seeds live at
/// ~/.wowsp-signing/ on the maintainer's machine; the WOWSP_DIGEST_
/// SIGNING_KEY repo secret carries the `main` seed for release.yml).
///
/// With keys pinned, a valid signature by a listed key is REQUIRED —
/// the KV store and the worker itself can no longer forge a doc, and a
/// replayed old signed doc is all that remains (which the seq ratchet
/// refuses). `backup` is pinned for rotation: publishes sign with
/// `main` and may switch to `backup` with no app release in between.
pub const PINNED_DIGEST_KEYS: &[(&str, &str)] = &[
    ("main", include_str!("../../res/keys/digest-main.pub")),
    ("backup", include_str!("../../res/keys/digest-backup.pub")),
];

/// Verify the doc's optional Ed25519 signature layer against `keys`.
/// The signed bytes are the doc's JSON without the `sig` member,
/// rendered with sorted keys and compact separators — byte-identical
/// to scripts/catalog_signing.py's canonical form (serde_json's Map is
/// sorted; every doc member that reaches the canonical form is ASCII).
/// This relies on serde_json's DEFAULT sorted-key Map: enabling the
/// `preserve_order` feature anywhere in the crate graph would reorder
/// the canonical bytes and break verification — the cross-language
/// fixture test is the canary that catches exactly that.
pub fn verify_doc_signature(doc: &serde_json::Value, keys: &[(&str, &str)]) -> Result<()> {
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

/// A parsed, signature-verified relay digest document (relay-core's
/// `DigestDoc`): the published release tag, the doc's `{asset -> sha256}`
/// table, and the per-channel publish counter (the rollback guard's
/// input).
#[derive(Debug, Clone, PartialEq)]
pub struct RelayDigestDoc {
    /// The release tag this doc was published for.
    pub tag: String,
    /// The doc's asset table, values as published (bare hex expected;
    /// validated per lookup by [`RelayDigestDoc::asset`]).
    pub assets: HashMap<String, String>,
    /// Per-channel, strictly increasing across publishes.
    pub seq: u64,
}

impl RelayDigestDoc {
    /// The doc's sha256 for `name`: present, well-formed, lowercase.
    pub fn asset(&self, name: &str) -> Result<String> {
        let hex = self.assets.get(name).ok_or_else(|| {
            anyhow!(
                "relay digest carries no sha256 for {name} (tag {})",
                self.tag
            )
        })?;
        if !is_sha256_hex(hex) {
            bail!(
                "the relay digest for {name} (tag {}) is not a well-formed sha256",
                self.tag
            );
        }
        Ok(hex.to_ascii_lowercase())
    }
}

/// Parse and verify one relay digest doc for `channel` against `keys`
/// (tests pass their own; production passes [`PINNED_DIGEST_KEYS`]).
/// Field errors and signature failures are both `Err` — a doc that does
/// not check out is never partially trusted.
pub fn parse_relay_digest_with(
    doc: &serde_json::Value,
    keys: &[(&str, &str)],
    channel: &str,
) -> Result<RelayDigestDoc> {
    if doc["channel"].as_str() != Some(channel) {
        bail!("the relay digest doc is not the {channel} channel");
    }
    verify_doc_signature(doc, keys)?;
    let tag = doc["tag"]
        .as_str()
        .ok_or_else(|| anyhow!("the relay digest doc carries no tag"))?;
    if !is_plain_segment(tag) {
        bail!("the relay digest tag {tag:?} is not a plain release tag");
    }
    let assets = doc["assets"]
        .as_object()
        .ok_or_else(|| anyhow!("the relay digest doc carries no asset table"))?
        .iter()
        // Non-string entries parse as empty and fail the hex check at
        // lookup time — the same refusal, without a second pass here.
        .map(|(name, sha)| (name.clone(), sha.as_str().unwrap_or_default().to_string()))
        .collect::<HashMap<_, _>>();
    let seq = doc["seq"]
        .as_u64()
        .filter(|seq| *seq >= 1)
        .ok_or_else(|| anyhow!("the relay digest doc carries no publish sequence number"))?;
    Ok(RelayDigestDoc {
        tag: tag.to_string(),
        assets,
        seq,
    })
}

/// The relay worker's digest endpoint for one channel — the rolling
/// latest pointer, or the doc pinned to `tag`. Root resolution rides the
/// pairing module's helper so the undocumented `WOWSP_RELAY_URL` dev
/// override (trim, scheme mapping, fallback) behaves exactly as it does
/// for pairing.
pub fn relay_digest_url(channel: &str, tag: Option<&str>) -> String {
    let root = super::pairing_relay::builtin_relay_root();
    match tag {
        Some(tag) => format!("{root}/api/digests/{channel}/{tag}"),
        None => format!("{root}/api/digests/{channel}"),
    }
}

/// Fetch and verify the relay doc at `url`. Two short attempts; any
/// failure is an `Err` the dual-channel lookup turns into "the GitHub
/// leg decides" (a doc that does not verify never yields content).
async fn fetch_relay_doc_at(
    client: &reqwest::Client,
    url: &str,
    channel: &str,
) -> Result<RelayDigestDoc> {
    debug_assert!(
        valid_channel(channel),
        "the relay digest endpoint serves {DIGEST_CHANNELS:?}, got {channel}"
    );
    let mut last_err = String::new();
    for _ in 0..RELAY_DIGEST_ATTEMPTS {
        let response = client
            .get(url)
            .header("User-Agent", concat!("WoWSP/", env!("CARGO_PKG_VERSION")))
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
        return parse_relay_digest_with(&doc, PINNED_DIGEST_KEYS, channel);
    }
    bail!("relay digest channel unavailable: {last_err}")
}

/// The channel's rolling latest-pointer doc. The caller learns the tag
/// from the doc (the updater's app channel works this way). The
/// per-tag pinned lookups (the resource pack's `res-delta-*` edges)
/// go through [`relay_pinned_sha256`] instead, which owns its own
/// reachability semantics.
pub async fn fetch_relay_doc_latest(
    client: &reqwest::Client,
    channel: &str,
) -> Result<RelayDigestDoc> {
    fetch_relay_doc_at(client, &relay_digest_url(channel, None), channel).await
}

// ── The rollback ratchet (per channel) ─────────────────────────────────

/// Persisted high-water mark of accepted relay digest docs, one per
/// channel — the rollback guard relay-core's digests module documents.
/// It only REFUSES in the case where the relay doc decides the digest
/// (GitHub unreachable); when GitHub answered and agrees, a regressed
/// seq is an ops artifact (a rebuilt KV namespace restarts the counter),
/// not an attack, and the mark simply never lowers. Defense-in-depth,
/// not tamper-proofing: without doc signatures a store-level attacker
/// can raise seq arbitrarily.
///
/// The app channel keeps its already-deployed file name; the content
/// channels added later are namespaced by channel.
fn relay_seq_file(channel: &str) -> String {
    if channel == "app" {
        ".relay-digest-seq.json".to_string()
    } else {
        format!(".relay-digest-seq-{channel}.json")
    }
}

/// The channel's accepted seq mark, when a readable one exists.
pub async fn accepted_relay_seq(channel: &str) -> Option<u64> {
    let dir = crate::paths::ensure_data_dir().ok()?;
    tokio::fs::read_to_string(dir.join(relay_seq_file(channel)))
        .await
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Best-effort, monotone, and torn-write safe (tmp + rename): a failed
/// or skipped mark only weakens the NEXT rollback check.
pub async fn remember_relay_seq(channel: &str, seq: u64) {
    let Ok(dir) = crate::paths::ensure_data_dir() else {
        return;
    };
    let name = relay_seq_file(channel);
    let tmp = dir.join(format!("{name}.tmp"));
    if tokio::fs::write(&tmp, seq.to_string()).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, dir.join(&name)).await;
    }
}

/// Pure core of the rollback check: a doc may only advance the mark
/// (an equal seq is a replay, a lower one a revert).
pub fn ensure_seq_advances(prev: Option<u64>, next: u64) -> Result<()> {
    if prev.is_some_and(|prev| next <= prev) {
        bail!(
            "the relay digest regressed (seq {next} at/below the accepted {prev:?}) — refusing the update"
        );
    }
    Ok(())
}

/// Combine the two official channels. Both answering must mean the same
/// value — a disagreement means one channel is lying, and the lookup is
/// refused rather than guessed at (this also covers the seconds-wide
/// publish race where the relay doc lags GitHub's retag: refusing until
/// the relay catches up is the price of the cross-check). One channel
/// answering is enough; neither answering leaves only the error to
/// report. `render` names a value in the refusal message.
pub fn choose_official<T: PartialEq>(
    relay: Result<T>,
    github: Result<T>,
    render: impl Fn(&T) -> String,
) -> Result<T> {
    match (relay, github) {
        (Ok(r), Err(_)) => Ok(r),
        (Ok(r), Ok(g)) if r == g => Ok(r),
        (Ok(r), Ok(g)) => bail!(
            "the official digest channels disagree (relay says {}, GitHub says {}) — refusing to proceed",
            render(&r),
            render(&g)
        ),
        (Err(_), Ok(g)) => Ok(g),
        (Err(relay_err), Err(_)) => Err(relay_err),
    }
}

// ── The dual-channel lookups ───────────────────────────────────────────

/// The relay leg's contribution to a lookup: the latest-pointer doc must
/// name `tag` and carry the asset's digest. A doc naming another tag is
/// stale (GitHub retags res-latest / data-latest / mod-hub in place, and
/// the relay push lands after the GitHub upload), and a doc without an
/// entry for the asset is an ops gap (an images-only publish must not
/// break manifest verification) — both downgrade the leg to `Err` so
/// the GitHub leg decides, never a fallback by themselves.
fn relay_leg_sha(
    channel: &str,
    doc: RelayDigestDoc,
    tag: &str,
    name: &str,
) -> Result<(RelayDigestDoc, String)> {
    anyhow::ensure!(
        doc.tag == tag,
        "the relay {channel} doc names tag {:?}, the lookup wants {tag:?}",
        doc.tag
    );
    let sha = doc.asset(name)?;
    Ok((doc, sha))
}

/// The official digest of one release asset, or why no official channel
/// could supply it right now.
pub enum OfficialDigest {
    /// The sha256 both-or-one official channel(s) named — binding on the
    /// caller.
    Verified(String),
    /// Both official channels are unreachable or rate limited (see
    /// [`ApiLookup`]).
    Unavailable(String),
}

/// Look up the official sha256 of asset `name` on the channel's current
/// release (`tag` is the release tag both channels must name — the
/// relay's latest pointer and GitHub's `/releases/tags/<tag>` alike; a
/// relay doc naming another tag is stale and the GitHub leg decides).
/// The relay leg runs first-class with a single short GitHub
/// cross-check; only when BOTH quick legs fail is GitHub's full retry
/// budget spent before reporting [`OfficialDigest::Unavailable`]. A
/// release that answers but carries no digest for the asset is an `Err`,
/// never `Unavailable`.
pub async fn lookup_official_sha256(
    client: &reqwest::Client,
    channel: &str,
    tag: &str,
    name: &str,
) -> Result<OfficialDigest> {
    let api_url = release_api_url(tag);
    let (relay, github_quick) = tokio::join!(
        fetch_relay_doc_latest(client, channel),
        github_doc_quick(client, &api_url),
    );
    let relay = relay.and_then(|doc| relay_leg_sha(channel, doc, tag, name));
    let github_digest = |release: serde_json::Value| {
        asset_sha256(&release, name)
            .ok_or_else(|| anyhow!("release {tag} publishes no sha256 digest for {name}"))
    };
    match (relay, github_quick) {
        // Both quick legs unavailable (the common transient shape on CN
        // networks): spend GitHub's full retry budget before reporting
        // the digest unavailable.
        (Err(relay_err), Err(_)) => match lookup_api_json(client, &api_url).await? {
            ApiLookup::Found(release) => Ok(OfficialDigest::Verified(github_digest(release)?)),
            ApiLookup::Unavailable(github_err) => Ok(OfficialDigest::Unavailable(format!(
                "relay: {relay_err}; GitHub: {github_err}"
            ))),
        },
        (Ok((doc, relay_sha)), github_quick) => {
            let prev = accepted_relay_seq(channel).await;
            let github_side = github_quick.and_then(github_digest);
            // The rollback refusal guards exactly the case where the
            // relay doc DECIDES the digest — GitHub silent, or GitHub
            // answering without a digest for the asset (then the relay
            // is the only voice). When GitHub named the same digest, a
            // regressed seq is an ops artifact — agreement passes below,
            // disagreement still refuses — and the monotone remember
            // keeps the mark from ever lowering.
            if github_side.is_err() {
                ensure_seq_advances(prev, doc.seq)?;
            }
            let sha = choose_official(Ok(relay_sha), github_side, |sha| format!("{}…", &sha[..8]))?;
            if doc.seq > prev.unwrap_or(0) {
                remember_relay_seq(channel, doc.seq).await;
            }
            Ok(OfficialDigest::Verified(sha))
        },
        (Err(_), Ok(release)) => Ok(OfficialDigest::Verified(github_digest(release)?)),
    }
}

/// Fetch the official sha256 of asset `name` on the channel's current
/// release, failing closed: a payload that cannot be verified is never
/// accepted.
pub async fn fetch_official_sha256(
    client: &reqwest::Client,
    channel: &str,
    tag: &str,
    name: &str,
) -> Result<String> {
    match lookup_official_sha256(client, channel, tag, name).await? {
        OfficialDigest::Verified(sha) => Ok(sha),
        OfficialDigest::Unavailable(e) => bail!("official digest unavailable: {e}"),
    }
}

/// Pure core of [`relay_pinned_sha256`] (tests pass their own key
/// table; production passes [`PINNED_DIGEST_KEYS`]): a doc that answers
/// must verify and name `tag` (anything else is a hard `Err`, never a
/// silent downgrade); a missing or malformed asset entry is an ops gap,
/// not an attack — `Ok(None)`, the caller keeps its other source (the
/// tree-hash check still guards the patched result).
fn pinned_sha_from_doc(
    doc: &serde_json::Value,
    keys: &[(&str, &str)],
    channel: &str,
    tag: &str,
    name: &str,
) -> Result<Option<String>> {
    let doc = parse_relay_digest_with(doc, keys, channel)?;
    anyhow::ensure!(
        doc.tag == tag,
        "the pinned relay doc for {tag} names tag {:?} instead",
        doc.tag
    );
    Ok(doc.asset(name).ok())
}

/// The relay's pinned digest for one specific tag's asset (the resource
/// pack's per-delta docs). `Ok(None)` when the relay cannot serve the
/// doc right now — unreachable, unknown tag, or no entry for the asset —
/// leaving the caller's other digest source in charge; a doc that DOES
/// answer but fails its signature or names another tag is a hard `Err`,
/// never silently downgraded.
pub async fn relay_pinned_sha256(
    client: &reqwest::Client,
    channel: &str,
    tag: &str,
    name: &str,
) -> Result<Option<String>> {
    let url = relay_digest_url(channel, Some(tag));
    let mut last_err = String::from("no relay attempt made");
    for _ in 0..RELAY_DIGEST_ATTEMPTS {
        let response = client
            .get(&url)
            .header("User-Agent", concat!("WoWSP/", env!("CARGO_PKG_VERSION")))
            .timeout(RELAY_DIGEST_TIMEOUT)
            .send()
            .await;
        let doc = match response {
            Ok(r) if r.status().is_success() => match r.json::<serde_json::Value>().await {
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
        let doc = pinned_sha_from_doc(&doc, PINNED_DIGEST_KEYS, channel, tag, name)?;
        return Ok(doc);
    }
    tracing::warn!("relay digest lookup for {tag} unavailable: {last_err}");
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_server_errors_are_retried_and_rate_limits_mean_unavailable() {
        use reqwest::StatusCode;
        for code in [500, 502, 503, 504] {
            let status = StatusCode::from_u16(code).unwrap();
            assert_eq!(status_verdict(status), StatusVerdict::Retry, "{code}");
        }
        for code in [403, 429] {
            let status = StatusCode::from_u16(code).unwrap();
            assert_eq!(status_verdict(status), StatusVerdict::Unavailable, "{code}");
        }
        for code in [400, 401, 404, 410, 422] {
            let status = StatusCode::from_u16(code).unwrap();
            assert_eq!(status_verdict(status), StatusVerdict::Fatal, "{code}");
        }
    }

    #[test]
    fn api_urls_target_github_directly() {
        // The digest source must never be a mirror prefix.
        assert_eq!(
            release_api_url("mod-hub"),
            "https://api.github.com/repos/langyo/wowsp/releases/tags/mod-hub"
        );
        assert_eq!(
            releases_api_url(),
            "https://api.github.com/repos/langyo/wowsp/releases?per_page=100"
        );
    }

    #[test]
    fn release_download_urls_round_trip_through_the_allowlist() {
        let url = release_download_url("mod-hub", "battle.cv.hp-center.zip");
        assert_eq!(
            url,
            "https://github.com/langyo/wowsp/releases/download/mod-hub/battle.cv.hp-center.zip"
        );
        assert!(is_release_download_url(&url));
        assert!(is_release_download_url(&release_download_url(
            &format!("res-delta-{}-{}", "a".repeat(64), "b".repeat(64)),
            "wowsp-res-delta.tar.gz"
        )));
    }

    #[test]
    fn allowlist_rejects_foreign_or_retargeting_urls() {
        for url in [
            // Other hosts, schemes and repositories.
            "https://example.test/mod.zip",
            "http://github.com/langyo/wowsp/releases/download/mod-hub/a.zip",
            "https://github.com/someone/wowsp/releases/download/mod-hub/a.zip",
            "https://github.com/langyo/wowsp-evil/releases/download/mod-hub/a.zip",
            "https://ghfast.top/https://github.com/langyo/wowsp/releases/download/mod-hub/a.zip",
            "https://api.github.com/repos/langyo/wowsp/releases/download/mod-hub/a.zip",
            // Shape: exactly <tag>/<asset>.
            "https://github.com/langyo/wowsp/releases/download/mod-hub",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/",
            "https://github.com/langyo/wowsp/releases/download//a.zip",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/sub/a.zip",
            // Dot segments, encoded or not, normalize to another path.
            "https://github.com/langyo/wowsp/releases/download/../../../evil/x/releases/download/t/a.zip",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/..",
            "https://github.com/langyo/wowsp/releases/download/%2e%2e/a.zip",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/a.zip?x=1",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/a.zip#frag",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/a\\b.zip",
        ] {
            assert!(!is_release_download_url(url), "{url} must be rejected");
        }
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"wowsp"),
            "4e77cd87945e2a7b04f550cab34c60d139a3d310b96a86761caee4a9bbcd3109"
        );
        assert!(is_sha256_hex(&sha256_hex(b"")));
        assert!(!is_sha256_hex("abc"));
        assert!(!is_sha256_hex(&"g".repeat(64)));
    }

    #[test]
    fn asset_sha256_picks_the_named_asset() {
        let hex = "d3a298f790192967d4e6a2b688286d8ef8f2d54837d1ac23fde28cab75ff0a1f";
        let release = serde_json::json!({
            "assets": [
                { "name": "battle.cv.hp-center.zip", "digest": "sha256:5d2039e2e047042a8a52f110e99dd0dd5e6dc3a21981b87c44c4cf6833bac43a" },
                { "name": "mod-index.json", "digest": format!("sha256:{}", hex.to_uppercase()) },
            ]
        });
        assert_eq!(
            asset_sha256(&release, "mod-index.json"),
            Some(hex.to_string()),
            "matched by exact name and normalized to lowercase"
        );
        assert_eq!(asset_sha256(&release, "mod-index.json.bak"), None);
    }

    #[test]
    fn asset_sha256_rejects_missing_or_malformed_digests() {
        let name = "wowsp-res.json";
        let with_digest = |digest: serde_json::Value| serde_json::json!({ "assets": [{ "name": name, "digest": digest }] });
        assert_eq!(asset_sha256(&serde_json::json!({}), name), None);
        assert_eq!(
            asset_sha256(&serde_json::json!({ "assets": [{ "name": name }] }), name),
            None,
            "asset without a digest"
        );
        assert_eq!(
            asset_sha256(&with_digest(serde_json::Value::Null), name),
            None
        );
        assert_eq!(
            asset_sha256(
                &with_digest("md5:d41d8cd98f00b204e9800998ecf8427e".into()),
                name
            ),
            None,
            "non-sha256 algorithm"
        );
        assert_eq!(asset_sha256(&with_digest("sha256:abc".into()), name), None);
        assert_eq!(
            asset_sha256(
                &with_digest(format!("sha256:{}", "z".repeat(64)).into()),
                name
            ),
            None,
            "non-hex"
        );
    }

    #[test]
    fn relay_urls_ride_the_pairing_root() {
        let latest = relay_digest_url("res", None);
        assert!(latest.ends_with("/api/digests/res"), "{latest}");
        let pinned = relay_digest_url(
            "res",
            Some(&format!("res-delta-{}-{}", "a".repeat(64), "b".repeat(64))),
        );
        assert!(
            pinned.ends_with(&format!(
                "/api/digests/res/res-delta-{}-{}",
                "a".repeat(64),
                "b".repeat(64)
            )),
            "{pinned}"
        );
        assert_ne!(latest, pinned);
    }

    #[test]
    fn digest_channels_form_the_closed_set() {
        for channel in DIGEST_CHANNELS {
            assert!(valid_channel(channel), "{channel}");
        }
        for foreign in ["app2", "mod_hub", "", "RES"] {
            assert!(!valid_channel(foreign), "{foreign}");
        }
    }

    #[test]
    fn parse_relay_digest_with_checks_the_channel_and_fields() {
        let hex = "a".repeat(64);
        let doc = |channel: &str| {
            serde_json::json!({
                "channel": channel,
                "tag": "res-latest",
                "seq": 7,
                "assets": { "wowsp-res.json": hex },
            })
        };
        // The unsigned transition's key table isolates field checks from
        // the signature layer.
        let parsed = parse_relay_digest_with(&doc("res"), &[], "res").unwrap();
        assert_eq!(parsed.tag, "res-latest");
        assert_eq!(parsed.seq, 7);
        assert_eq!(parsed.asset("wowsp-res.json").unwrap(), hex);
        // Foreign channel (either side of the check).
        assert!(parse_relay_digest_with(&doc("res"), &[], "data").is_err());
        assert!(parse_relay_digest_with(&doc("data"), &[], "res").is_err());
        // Malformed tag, missing assets, zero/missing seq.
        let bad_tag = serde_json::json!({
            "channel": "res", "tag": "res-latest/../x", "seq": 1,
            "assets": { "wowsp-res.json": hex },
        });
        assert!(parse_relay_digest_with(&bad_tag, &[], "res").is_err());
        let no_assets = serde_json::json!({
            "channel": "res", "tag": "res-latest", "seq": 1,
        });
        assert!(parse_relay_digest_with(&no_assets, &[], "res").is_err());
        for seq in [serde_json::json!(0), serde_json::Value::Null] {
            let zeroed = serde_json::json!({
                "channel": "res", "tag": "res-latest", "seq": seq,
                "assets": { "wowsp-res.json": hex },
            });
            assert!(parse_relay_digest_with(&zeroed, &[], "res").is_err());
        }
        // The asset lookup is strict about shape and spelling.
        let parsed = parse_relay_digest_with(&doc("res"), &[], "res").unwrap();
        assert!(parsed.asset("wowsp-res.tar.gz").is_err(), "missing entry");
        let prefixed = serde_json::json!({
            "channel": "res", "tag": "res-latest", "seq": 1,
            "assets": { "wowsp-res.json": format!("sha256:{hex}") },
        });
        let parsed = parse_relay_digest_with(&prefixed, &[], "res").unwrap();
        assert!(
            parsed.asset("wowsp-res.json").is_err(),
            "the relay spelling is bare hex — a prefixed digest is a shape error"
        );
    }

    #[test]
    fn relay_seq_marks_are_namespaced_by_channel() {
        // The app channel keeps its already-deployed file name.
        assert_eq!(relay_seq_file("app"), ".relay-digest-seq.json");
        assert_eq!(relay_seq_file("res"), ".relay-digest-seq-res.json");
        assert_eq!(relay_seq_file("mod-hub"), ".relay-digest-seq-mod-hub.json");
        assert_eq!(relay_seq_file("data"), ".relay-digest-seq-data.json");
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

    #[test]
    fn choose_official_cross_checks_the_channels() {
        let a = "8d88e539c25d9b8a0705c9f858f616e68f6d8ef13af4de7a00af39fb10593927".to_string();
        let b = "b".repeat(64);
        let ok = |s: String| Ok(s);
        let err = || Err(anyhow!("unreachable"));

        // Agreement passes; either channel alone suffices.
        assert_eq!(
            choose_official(ok(a.clone()), ok(a.clone()), |s| s[..8].to_string()).unwrap(),
            a
        );
        assert_eq!(
            choose_official(ok(a.clone()), err(), |s| s[..8].to_string()).unwrap(),
            a
        );
        assert_eq!(
            choose_official(err(), ok(a.clone()), |s| s[..8].to_string()).unwrap(),
            a
        );
        // Disagreement is a hard refusal naming both sides.
        let refused = choose_official(ok(a), ok(b), |s| s[..8].to_string())
            .unwrap_err()
            .to_string();
        assert!(refused.contains("disagree"), "{refused}");
        assert!(refused.contains("8d88e539"), "{refused}");
        // Neither channel leaves only the error to report/retry.
        assert!(choose_official(err(), err(), |s| s[..8].to_string()).is_err());
    }

    #[test]
    fn relay_leg_downgrades_stale_tags_and_missing_entries() {
        let hex = "a".repeat(64);
        let doc = |tag: &str, assets: &[(&str, &str)]| RelayDigestDoc {
            tag: tag.to_string(),
            assets: assets
                .iter()
                .map(|(n, s)| ((*n).to_string(), (*s).to_string()))
                .collect(),
            seq: 5,
        };
        // A doc naming another tag is stale (GitHub retags in place, the
        // relay push lands after the upload) — Err, so the GitHub leg
        // decides; never a fallback by itself.
        let stale = doc("res-latest-old", &[("wowsp-res.json", &hex)]);
        assert!(relay_leg_sha("res", stale, "res-latest", "wowsp-res.json").is_err());
        // A doc without an entry for the asset (images-only publish) or
        // with a malformed one: same downgrade.
        let missing = doc("res-latest", &[]);
        assert!(relay_leg_sha("res", missing, "res-latest", "wowsp-res.json").is_err());
        let malformed = doc("res-latest", &[("wowsp-res.json", "sha256:abc")]);
        assert!(relay_leg_sha("res", malformed, "res-latest", "wowsp-res.json").is_err());
        // A healthy doc yields the asset's sha.
        let healthy = doc("res-latest", &[("wowsp-res.json", &hex)]);
        let (_, sha) = relay_leg_sha("res", healthy, "res-latest", "wowsp-res.json").unwrap();
        assert_eq!(sha, hex);
    }

    #[test]
    fn pinned_lookup_splits_ops_gaps_from_attacks() {
        let hex = "b".repeat(64);
        let asset = "wowsp-res-delta.tar.gz";
        let doc = |tag: &str| {
            serde_json::json!({
                "channel": "res", "tag": tag, "seq": 2,
                "assets": { asset: hex },
            })
        };
        // Ops gaps keep the caller's other digest source.
        assert_eq!(
            pinned_sha_from_doc(&doc("res-delta-a-b"), &[], "res", "res-delta-a-b", asset).unwrap(),
            Some(hex.clone())
        );
        let no_entry = serde_json::json!({
            "channel": "res", "tag": "res-delta-a-b", "seq": 2,
            "assets": { "other.zip": hex.clone() },
        });
        assert_eq!(
            pinned_sha_from_doc(&no_entry, &[], "res", "res-delta-a-b", asset).unwrap(),
            None,
            "a doc without the asset is an ops gap, not an attack"
        );
        // A doc pinned under another tag, or on another channel, refuses.
        assert!(
            pinned_sha_from_doc(&doc("res-delta-c-d"), &[], "res", "res-delta-a-b", asset).is_err()
        );
        assert!(
            pinned_sha_from_doc(&doc("res-delta-a-b"), &[], "data", "res-delta-a-b", asset)
                .is_err()
        );
        // Tampering with a signed doc refuses — never a silent downgrade.
        let mut tampered = signed_digest_fixture();
        tampered["assets"]["WoWSP_0.6.0_x64-installer-lite.exe"] = "c".repeat(64).into();
        assert!(
            pinned_sha_from_doc(
                &tampered,
                &[TEST_DIGEST_KEY],
                "app",
                "v0.6.0",
                "WoWSP_0.6.0_x64-installer-lite.exe"
            )
            .is_err()
        );
    }

    /// A throwaway keypair (seed bytes 0..32) whose signature below was
    /// produced by scripts/catalog_signing.py's canonical form — the
    /// cross-language parity fixture. NOT a trust anchor.
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
        let parsed = parse_relay_digest_with(&signed_digest_fixture(), &keys, "app").unwrap();
        assert_eq!(parsed.seq, 3);
        assert_eq!(parsed.tag, "v0.6.0");

        // Any tampering of a signed member breaks the signature.
        let mut tampered_seq = signed_digest_fixture();
        tampered_seq["seq"] = 4u64.into();
        let err = parse_relay_digest_with(&tampered_seq, &keys, "app")
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not verify"), "{err}");

        // Unknown key ids are refused even with a valid signature.
        let mut wrong_key = signed_digest_fixture();
        wrong_key["key_id"] = "other".into();
        assert!(parse_relay_digest_with(&wrong_key, &keys, "app").is_err());

        // Half-signed is refused.
        let mut half = signed_digest_fixture();
        half.as_object_mut().unwrap().remove("sig");
        assert!(parse_relay_digest_with(&half, &keys, "app").is_err());
        let mut other_half = signed_digest_fixture();
        other_half.as_object_mut().unwrap().remove("key_id");
        assert!(parse_relay_digest_with(&other_half, &keys, "app").is_err());

        // Unsigned: refused while keys are pinned, accepted in the
        // no-keys-pinned transition (tests only — production pins).
        let mut unsigned = signed_digest_fixture();
        unsigned.as_object_mut().unwrap().remove("sig");
        unsigned.as_object_mut().unwrap().remove("key_id");
        let refused = parse_relay_digest_with(&unsigned, &keys, "app")
            .unwrap_err()
            .to_string();
        assert!(refused.contains("unsigned"), "{refused}");
        assert!(parse_relay_digest_with(&unsigned, &[], "app").is_ok());
    }
}
