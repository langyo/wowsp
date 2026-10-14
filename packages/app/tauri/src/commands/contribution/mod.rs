//! Replay-share contribution (录像共享计划) — the Rust side of the wave-1
//! contract (CONTRACT-replay-share.md §9). The user opts in from the
//! settings wizard: they declare an identity (realm + credited nickname)
//! and record the consent version, which lazily mints the local
//! credentials the personal relay routes accept (a v4 `anonId` + a
//! CSPRNG `uploadToken`, persisted in `contribution.json` under the
//! app-data root — no accounts anywhere).
//!
//! The planner (`contribution_plan`) hashes each selected replay
//! (streaming sha256), reads its header (ONE bounded block-0 read
//! feeding both the lite projection and `clientVersionFromExe`), takes
//! the webui's ship-class/tier hints, and merges the client-side
//! verdict mirror (known-hash cache → duplicate, cached `/mine` set →
//! own_staged, wanted-ruleset match → accept) — advisory only: the
//! pipeline always re-checks through `POST /api/replays/check`.
//!
//! `contribution_start` launches the single-flight background pipeline
//! (plan → check → mine → pack → upload → done): it packs the union of
//! the still-staged set and the freshly accepted items into a tar.zstd
//! package (each member re-hashed while it streams in — a file that
//! changed under the planner aborts the run), pulling the contributor's
//! current archive from the relay ONLY for staged members whose local
//! file is gone, then streams the package to
//! `POST /api/replays/upload` with the base64url `x-manifest` header.
//! A 422 drops the rejected members (or re-syncs a raced `/mine`) and
//! retries once automatically. Every stage transition and per-item
//! outcome lands on `wowsp://contribution-progress` as the full
//! [`QueueSnapshot`], which `contribution_queue` also answers directly.
//!
//! Cross-platform by construction (no desktop-only API): the relay base
//! URL reuses the pairing relay's built-in root + `WOWSP_RELAY_URL`
//! override, and the HTTP client the shared proxy-aware builder.

use anyhow::{Result, anyhow, bail};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use wowsp_tauri_shared::{
    CONTRIBUTION_PROGRESS_EVENT, CommandResult, ContributionIdentity, ContributionState,
    ContributionVerdict, GameInstall, MineDoc, PlanCandidate, PlanItem, QueueOutcome, QueueResult,
    QueueSnapshot, REALMS, ReplayFacts, ReplayFactsCore, SHIP_CLASSES, WantedDoc, stage,
};

mod package;
mod wanted;

use package::PackMember;
use wanted::merge_verdict;

/// The share store under the app-data root (atomic writes via the shared
/// appdata helper, like every other JSON ledger).
const CONTRIBUTION_FILE: &str = "contribution.json";
/// Bump when the store's field semantics change; `#[serde(default)]`
/// keeps plain field additions healing instead of discarding the file.
const STORE_VERSION: u32 = 1;
/// LRU cap on `knownHashes` (contract §9).
const KNOWN_HASHES_CAP: usize = 5000;
/// Local freshness window of the cached wanted document (contract §9).
const WANTED_CACHE_SECS: i64 = 600;
/// `POST /check` batch cap (contract §4: ≤400 facts per request).
const CHECK_BATCH: usize = 400;
const USER_AGENT: &str = "WoWSP-contribution/1.0";
/// Relay-facing caps worth naming in error copy (contract §4: 413).
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MEMBERS: usize = 400;
/// Generous overall caps so a healthy slow link streams through but a
/// stalled one fails (same numbers the pack downloads use).
const SHORT_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const LONG_HTTP_TIMEOUT: Duration = Duration::from_secs(3600);

// ── the store ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WantedCacheEntry {
    doc: WantedDoc,
    fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MineCacheEntry {
    doc: MineDoc,
    fetched_at: i64,
    /// RFC3339 stamp of the last successful `/mine` sync (state card).
    last_sync_at: String,
}

/// One known-hash row: the member's size + when it was last confirmed
/// (uploaded or drained) — the LRU eviction clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownHash {
    size_bytes: u64,
    at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ContributionStore {
    version: u32,
    identity: Option<ContributionIdentity>,
    consent_version: Option<u32>,
    anon_id: Option<String>,
    upload_token: Option<String>,
    wanted_cache: Option<WantedCacheEntry>,
    mine_cache: Option<MineCacheEntry>,
    /// sha256 → {sizeBytes, at}, LRU-capped at [`KNOWN_HASHES_CAP`].
    known_hashes: BTreeMap<String, KnownHash>,
}

impl Default for ContributionStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            identity: None,
            consent_version: None,
            anon_id: None,
            upload_token: None,
            wanted_cache: None,
            mine_cache: None,
            known_hashes: BTreeMap::new(),
        }
    }
}

static STORE: Mutex<Option<ContributionStore>> = Mutex::new(None);

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn rfc3339_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Read the store, healing an absent file to defaults. A damaged file
/// errors through (and is never overwritten with defaults) — the same
/// discipline the playtime ledger keeps.
fn load_store_in(dir: &Path) -> Result<ContributionStore> {
    match super::appdata::read_json_in(dir, CONTRIBUTION_FILE)? {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|e| anyhow!("parse contribution store: {e}"))
        },
        None => Ok(ContributionStore::default()),
    }
}

fn persist_store_in(dir: &Path, store: &ContributionStore) -> Result<()> {
    let json =
        serde_json::to_string(store).map_err(|e| anyhow!("serialize contribution store: {e}"))?;
    super::appdata::write_json_in(dir, CONTRIBUTION_FILE, &json)
}

/// Run `f` against the loaded store without persisting (read paths).
fn with_store<R>(f: impl FnOnce(&ContributionStore) -> R) -> Result<R> {
    let dir = super::appdata::appdata_dir_path()?;
    let mut guard = STORE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        *guard = Some(load_store_in(&dir)?);
    }
    Ok(f(guard.as_ref().expect("loaded store")))
}

/// Mutate the store, persisting only after `f` succeeded (a failed
/// mutation leaves the on-disk file untouched).
fn edit_store<R>(f: impl FnOnce(&mut ContributionStore) -> Result<R>) -> Result<R> {
    let dir = super::appdata::appdata_dir_path()?;
    let mut guard = STORE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        *guard = Some(load_store_in(&dir)?);
    }
    let store = guard.as_mut().expect("loaded store");
    let outcome = f(store)?;
    persist_store_in(&dir, store)?;
    Ok(outcome)
}

/// Upsert hashes + evict down to the LRU cap: the oldest `at` leaves
/// first (ties broken by sha so eviction is deterministic).
fn remember_hashes(
    store: &mut ContributionStore,
    at: i64,
    hashes: impl Iterator<Item = (String, u64)>,
) {
    for (sha, size) in hashes {
        store.known_hashes.insert(
            sha,
            KnownHash {
                size_bytes: size,
                at,
            },
        );
    }
    while store.known_hashes.len() > KNOWN_HASHES_CAP {
        let Some(evict) = store
            .known_hashes
            .iter()
            .min_by_key(|(sha, row)| (row.at, sha.as_str()))
            .map(|(sha, _)| sha.clone())
        else {
            break;
        };
        store.known_hashes.remove(&evict);
    }
}

/// The personal routes' credential pair.
#[derive(Debug, Clone)]
struct Credentials {
    anon_id: String,
    upload_token: String,
}

fn credentials_of(store: &ContributionStore) -> Option<Credentials> {
    Some(Credentials {
        anon_id: store.anon_id.clone()?,
        upload_token: store.upload_token.clone()?,
    })
}

/// 24 CSPRNG bytes → exactly 32 base64url chars (no padding) — the
/// contract's `[A-Za-z0-9_-]` token alphabet, straight from OS entropy.
fn mint_upload_token() -> Result<String> {
    use base64::Engine as _;
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("os entropy: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

/// Mint the credential pair lazily — only the identity/consent saves
/// trigger it, so a user who never opts in never mints an anonId.
fn ensure_credentials(store: &mut ContributionStore) -> Result<()> {
    if store.anon_id.is_none() {
        store.anon_id = Some(uuid::Uuid::new_v4().to_string());
    }
    if store.upload_token.is_none() {
        store.upload_token = Some(mint_upload_token()?);
    }
    Ok(())
}

fn valid_realm(realm: &str) -> bool {
    REALMS.contains(&realm)
}

/// 3..=24 chars, no control characters (contract §3).
fn valid_name(name: &str) -> bool {
    (3..=24).contains(&name.chars().count()) && !name.chars().any(char::is_control)
}

// ── relay HTTP face ─────────────────────────────────────────────────────────

fn relay_url(path: &str) -> String {
    format!(
        "{}/api/replays{path}",
        super::pairing_relay::builtin_relay_root()
    )
}

async fn fetch_wanted_remote(client: &reqwest::Client) -> Result<WantedDoc> {
    let resp = client
        .get(relay_url("/wanted"))
        .header("User-Agent", USER_AGENT)
        .timeout(SHORT_HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| anyhow!("fetch wanted ruleset: {e}"))?;
    if !resp.status().is_success() {
        bail!("fetch wanted ruleset: HTTP {}", resp.status());
    }
    resp.json::<WantedDoc>()
        .await
        .map_err(|e| anyhow!("parse wanted ruleset: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckResponse {
    #[serde(default)]
    results: Vec<CheckResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    sha256: String,
    verdict: ContributionVerdict,
    #[serde(default)]
    rule_id: Option<String>,
}

/// POST the facts (batched ≤400) and collect the server's verdict rows.
async fn post_check(
    client: &reqwest::Client,
    creds: &Credentials,
    facts: &[ReplayFacts],
) -> Result<Vec<CheckResult>> {
    let mut out = Vec::with_capacity(facts.len());
    for batch in facts.chunks(CHECK_BATCH) {
        let resp = client
            .post(relay_url("/check"))
            .header("User-Agent", USER_AGENT)
            .header("x-anon-id", &creds.anon_id)
            .header("x-upload-token", &creds.upload_token)
            .timeout(SHORT_HTTP_TIMEOUT)
            .json(&serde_json::json!({ "facts": batch }))
            .send()
            .await
            .map_err(|e| anyhow!("share check: {e}"))?;
        if !resp.status().is_success() {
            bail!("share check: HTTP {}", resp.status());
        }
        let doc: CheckResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("parse share check: {e}"))?;
        out.extend(doc.results);
    }
    Ok(out)
}

/// GET `/mine`; a 404 is the fresh-contributor answer (empty doc).
async fn get_mine(client: &reqwest::Client, creds: &Credentials) -> Result<MineDoc> {
    let resp = client
        .get(relay_url("/mine"))
        .header("User-Agent", USER_AGENT)
        .header("x-anon-id", &creds.anon_id)
        .header("x-upload-token", &creds.upload_token)
        .timeout(SHORT_HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| anyhow!("sync staged replays: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(MineDoc::default());
    }
    if !resp.status().is_success() {
        bail!("sync staged replays: HTTP {}", resp.status());
    }
    resp.json::<MineDoc>()
        .await
        .map_err(|e| anyhow!("parse staged replays: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    #[serde(default)]
    accepted: u64,
    #[serde(default)]
    archive_bytes: u64,
    #[serde(default)]
    credit_count: u32,
}

// ── facts assembly (the §2 claim + plausibility mirror) ─────────────────────

/// The §2 plausibility window, mirrored client-side so junk claims (an
/// unparseable header, a truncated file) never leave the machine: the
/// planner marks such items unwanted instead of claiming them.
fn facts_plausible(facts: &ReplayFacts) -> bool {
    let is_sha = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    };
    is_sha(&facts.sha256)
        && !facts.file_name.is_empty()
        && facts.file_name.chars().count() <= 128
        && !facts.file_name.contains(['/', '\\'])
        && !facts.file_name.chars().any(char::is_control)
        && (1024..=67_108_864).contains(&facts.size_bytes)
        // Required strings: non-empty within their caps (an empty map or
        // mode means the header never parsed - the claim is not sendable).
        && !facts.core.map.is_empty()
        && facts.core.map.chars().count() <= 64
        && !facts.core.mode.is_empty()
        && facts.core.mode.chars().count() <= 32
        && facts
            .core
            .scenario
            .as_deref()
            .is_none_or(|s| !s.is_empty() && s.chars().count() <= 64)
        && valid_realm(&facts.core.realm)
        && facts.core.client_version.chars().count() <= 32
        && facts.core.battle_time.chars().count() <= 40
        && (1..=64).contains(&facts.core.player_count)
        && facts.core.bot_count <= 64
        && facts.core.tier.is_none_or(|t| (1..=11).contains(&t))
        && facts
            .core
            .ship_class
            .as_deref()
            .is_none_or(|c| SHIP_CLASSES.contains(&c))
}

/// The filename stamp (`YYYYMMDD[_HHMMSS]`) is the only timestamp source;
/// it is the client machine's LOCAL time, so convert through the local
/// zone into an RFC3339 UTC stamp. Unconvertible stamps fall back to
/// treating the stamp as UTC rather than dropping the battle time.
fn battle_time_of(date_time: Option<&str>) -> Option<String> {
    use chrono::TimeZone as _;
    let raw = date_time?;
    let naive = match chrono::NaiveDateTime::parse_from_str(raw, "%Y%m%d_%H%M%S") {
        Ok(dt) => dt,
        Err(_) => chrono::NaiveDate::parse_from_str(raw, "%Y%m%d")
            .ok()?
            .and_hms_opt(0, 0, 0)?,
    };
    let utc = match chrono::Local.from_local_datetime(&naive).single() {
        Some(local) => local.with_timezone(&chrono::Utc),
        None => chrono::DateTime::from_naive_utc_and_offset(naive, chrono::Utc),
    };
    Some(utc.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Streaming sha256 of one file.
fn file_sha256(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| anyhow!("hash {}: {e}", path.display()))?;
    Ok(hex::encode(hasher.finalize()))
}

/// The install whose replay root contains `path` (case-insensitive,
/// separator-agnostic prefix + boundary — the same normalization idea the
/// process matcher uses). User-pinned folders outside every install
/// answer None, and the facts' realm falls back to the declared
/// identity's realm (the user's own replays, their own server).
fn owning_install<'a>(
    roots: &'a [(PathBuf, Option<GameInstall>)],
    path: &Path,
) -> Option<&'a GameInstall> {
    let normalize = |p: &Path| p.to_string_lossy().to_lowercase().replace('/', "\\");
    let target = normalize(path);
    roots
        .iter()
        .filter_map(|(root, owner)| {
            let owner = owner.as_ref()?;
            let dir = normalize(root).trim_end_matches('\\').to_string();
            if target == dir || target.starts_with(&format!("{dir}\\")) {
                Some(owner)
            } else {
                None
            }
        })
        .max_by_key(|owner| owner.path.len())
}

/// The planner's blocking core: per candidate, stream-hash the file,
/// parse the header (one bounded block-0 read feeding BOTH the lite
/// projection and the client version), take the webui's ship class/tier
/// hints, and merge the local verdicts. Per-file failures degrade to an
/// implausible facts row (verdict unwanted) instead of failing the batch
/// — the wizard still lists what it can select.
fn plan_items_blocking(
    candidates: &[PlanCandidate],
    roots: &[(PathBuf, Option<GameInstall>)],
    known_hashes: &HashSet<String>,
    mine_hashes: &HashSet<String>,
    wanted: &WantedDoc,
    identity_realm: Option<&str>,
) -> Vec<PlanItem> {
    candidates
        .iter()
        .map(|candidate| {
            let path = PathBuf::from(&candidate.path);
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let size_bytes = std::fs::metadata(&path)
                .ok()
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .unwrap_or(0);
            let sha256 = if size_bytes > 0 {
                file_sha256(&path).unwrap_or_default()
            } else {
                String::new()
            };
            let (lite, client_version) = super::replay::lite_and_client_version(&path);
            let realm = owning_install(roots, &path)
                .and_then(|i| i.realm.clone())
                .or_else(|| identity_realm.map(str::to_owned))
                .unwrap_or_default();
            let core = ReplayFactsCore {
                map: lite.map_name.clone().unwrap_or_default(),
                mode: lite.match_group.clone().unwrap_or_default(),
                scenario: lite.scenario.clone(),
                realm,
                own_ship_id: lite.own_ship_id.map_or(0, |id| id.max(0) as u64),
                ship_class: candidate.ship_class.clone(),
                tier: candidate.tier,
                player_count: u32::try_from(lite.player_count).unwrap_or(u32::MAX),
                bot_count: lite.bot_count,
                client_version: client_version.unwrap_or_default(),
                // The lite projection's date_time IS the filename stamp.
                battle_time: battle_time_of(lite.date_time.as_deref()).unwrap_or_default(),
            };
            let facts = ReplayFacts {
                sha256: sha256.clone(),
                file_name: file_name.clone(),
                size_bytes,
                core,
            };
            let (verdict, rule_id) = if facts_plausible(&facts) {
                merge_verdict(&facts, known_hashes, mine_hashes, wanted)
            } else {
                (ContributionVerdict::Unwanted, None)
            };
            PlanItem {
                path: candidate.path.clone(),
                sha256,
                size_bytes,
                facts,
                verdict,
                rule_id,
                file_name,
            }
        })
        .collect()
}

/// Facts for a member whose bytes only exist in the contributor archive:
/// parse the extracted copy's header; the realm claim is the declared
/// identity's (it is the contributor's own staged replay), class/tier
/// stay unclaimed (the webui catalog hints are not re-derivable here).
fn facts_for_extracted(path: &Path, file_name: &str, realm: &str) -> ReplayFactsCore {
    let (lite, client_version) = super::replay::lite_and_client_version(path);
    ReplayFactsCore {
        map: lite.map_name.unwrap_or_default(),
        mode: lite.match_group.unwrap_or_default(),
        scenario: lite.scenario,
        realm: realm.to_owned(),
        own_ship_id: lite.own_ship_id.map_or(0, |id| id.max(0) as u64),
        ship_class: None,
        tier: None,
        player_count: u32::try_from(lite.player_count).unwrap_or(u32::MAX),
        bot_count: lite.bot_count,
        client_version: client_version.unwrap_or_default(),
        battle_time: battle_time_of(
            super::replay::parse_datetime_from_filename(file_name).as_deref(),
        )
        .unwrap_or_default(),
    }
}

/// A closed wanted doc (nothing matches) for plans taken with no cache.
fn closed_wanted() -> WantedDoc {
    WantedDoc {
        ruleset_version: 0,
        updated_at: None,
        watermark: wowsp_tauri_shared::Watermark {
            staged_bytes: 0,
            limit_bytes: 0,
            accepting: false,
        },
        rules: Vec::new(),
    }
}

// ── the background pass (single-flight) ────────────────────────────────────

/// One share run: its live snapshot (what `contribution_queue` answers
/// and every progress event carries) plus the cooperative cancel flag.
struct Pass {
    snapshot: Mutex<QueueSnapshot>,
    cancel: AtomicBool,
}

impl Pass {
    fn is_running(&self) -> bool {
        self.snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .running
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn check_cancelled(&self) -> Result<()> {
        if self.cancelled() {
            bail!("share run cancelled")
        }
        Ok(())
    }
}

/// The current pass, RETAINED after it finishes so the wizard's late
/// `contribution_queue` polls still see the done/error snapshot (a fresh
/// `contribution_start` replaces it with a brand-new pass — a stale
/// cancel pressed against a finished run never bleeds into the next).
static PASS: Mutex<Option<Arc<Pass>>> = Mutex::new(None);

fn emit(app: &AppHandle, snapshot: &QueueSnapshot) {
    let _ = app.emit(CONTRIBUTION_PROGRESS_EVENT, snapshot);
}

/// Mutate the pass snapshot and push it to the webui in one step.
fn emit_pass(app: &AppHandle, pass: &Pass, f: impl FnOnce(&mut QueueSnapshot)) {
    let mut snapshot = pass.snapshot.lock().unwrap_or_else(|p| p.into_inner());
    f(&mut snapshot);
    let cloned = snapshot.clone();
    drop(snapshot);
    emit(app, &cloned);
}

// ── commands ────────────────────────────────────────────────────────────────

fn state_of(store: &ContributionStore) -> ContributionState {
    let mine = store.mine_cache.as_ref();
    ContributionState {
        identity: store.identity.clone(),
        consent_version: store.consent_version,
        anon_id: store.anon_id.clone(),
        has_upload_token: store.upload_token.is_some(),
        credit_count: mine.map(|c| c.doc.credit_count).unwrap_or(0),
        staged_count: mine.map(|c| c.doc.staged.len() as u32).unwrap_or(0),
        staged_bytes: mine.map(|c| c.doc.archive_bytes).unwrap_or(0),
        last_sync_at: mine.map(|c| c.last_sync_at.clone()),
    }
}

/// The status card's view of the local share state. A damaged store
/// degrades to the empty state (same fallback shape the playtime
/// overview uses) instead of failing the settings page.
#[tauri::command]
pub fn contribution_state() -> ContributionState {
    with_store(state_of).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "contribution store unavailable");
        state_of(&ContributionStore::default())
    })
}

/// Declare (or re-declare) the contributor identity. First save mints the
/// credential pair — the server only learns it on the first successful
/// upload.
#[tauri::command]
pub fn contribution_set_identity(realm: String, name: String) -> CommandResult<()> {
    let realm = realm.trim().to_ascii_lowercase();
    let name = name.trim().to_string();
    if !valid_realm(&realm) {
        return Err(anyhow!("realm must be one of ru/eu/na/asia/cn").into());
    }
    if !valid_name(&name) {
        return Err(anyhow!("name must be 3..24 characters without control characters").into());
    }
    edit_store(|store| {
        store.identity = Some(ContributionIdentity { realm, name });
        ensure_credentials(store)
    })
    .map_err(Into::into)
}

/// Record the consent version from the wizard's checkbox. Monotonic: an
/// older replay of the flow cannot downgrade an already-given consent.
#[tauri::command]
pub fn contribution_save_consent(version: u32) -> CommandResult<()> {
    edit_store(|store| {
        let given = store.consent_version.unwrap_or(0);
        store.consent_version = Some(version.max(given));
        ensure_credentials(store)
    })
    .map_err(Into::into)
}

/// Forget the persona: identity, credentials and both caches clear;
/// `knownHashes` survive (the contract pins them — they keep duplicate
/// suppression working across identity resets) and so does the consent
/// record (a privacy agreement, not an identity).
#[tauri::command]
pub fn contribution_forget_identity() -> CommandResult<()> {
    edit_store(|store| {
        store.identity = None;
        store.anon_id = None;
        store.upload_token = None;
        store.wanted_cache = None;
        store.mine_cache = None;
        Ok(())
    })
    .map_err(Into::into)
}

/// The wanted ruleset with the 10-minute local cache. `force` bypasses
/// the window. Offline, a stale cache still answers (the wizard shows
/// what it last knew); with no cache at all the network error surfaces.
#[tauri::command]
pub async fn contribution_fetch_wanted(force: bool) -> CommandResult<WantedDoc> {
    let now = now_unix();
    if !force {
        if let Some(cached) = with_store(|s| s.wanted_cache.clone())? {
            if now.saturating_sub(cached.fetched_at) < WANTED_CACHE_SECS {
                return Ok(cached.doc);
            }
        }
    }
    let client = crate::commands::network::build_http_client()?;
    match fetch_wanted_remote(&client).await {
        Ok(doc) => {
            edit_store(|store| {
                store.wanted_cache = Some(WantedCacheEntry {
                    doc: doc.clone(),
                    fetched_at: now,
                });
                Ok(())
            })?;
            Ok(doc)
        },
        Err(e) => match with_store(|s| s.wanted_cache.clone()).ok().flatten() {
            Some(cached) => Ok(cached.doc),
            None => Err(e.into()),
        },
    }
}

/// Cache a `/mine` answer (state card + planner).
fn cache_mine(doc: MineDoc) -> Result<()> {
    let fetched_at = now_unix();
    let last_sync_at = rfc3339_now();
    edit_store(|store| {
        store.mine_cache = Some(MineCacheEntry {
            doc,
            fetched_at,
            last_sync_at,
        });
        Ok(())
    })
}

/// Refresh the staged-replay view from the relay. Without credentials
/// (never opted in) the fresh-contributor empty shape answers — there is
/// nothing to sync and no anonId to ask about yet.
#[tauri::command]
pub async fn contribution_sync_mine() -> CommandResult<MineDoc> {
    let Some(creds) = with_store(credentials_of)? else {
        return Ok(MineDoc::default());
    };
    let client = crate::commands::network::build_http_client()?;
    let doc = get_mine(&client, &creds).await?;
    cache_mine(doc.clone())?;
    Ok(doc)
}

/// Plan a share selection: hash + header-parse each candidate (blocking
/// pool — real file I/O), assemble the §2 facts claim from the webui's
/// class/tier hints, and merge the LOCAL verdict mirror (known hashes,
/// cached mine, wanted ruleset — refreshed first when the 10-minute
/// window lapsed, best-effort so an offline plan still answers).
#[tauri::command]
pub async fn contribution_plan(items: Vec<PlanCandidate>) -> CommandResult<Vec<PlanItem>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let _ = contribution_fetch_wanted(false).await;
    let (wanted, known, mine, identity_realm) = with_store(|s| {
        (
            s.wanted_cache
                .as_ref()
                .map(|c| c.doc.clone())
                .unwrap_or_else(closed_wanted),
            s.known_hashes.keys().cloned().collect::<HashSet<_>>(),
            s.mine_cache
                .as_ref()
                .map(|c| {
                    c.doc
                        .staged
                        .iter()
                        .map(|e| e.sha256.clone())
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default(),
            s.identity.as_ref().map(|i| i.realm.clone()),
        )
    })?;
    let roots = super::game_context::replay_roots();
    let planned = tokio::task::spawn_blocking(move || {
        plan_items_blocking(
            &items,
            &roots,
            &known,
            &mine,
            &wanted,
            identity_realm.as_deref(),
        )
    })
    .await
    .map_err(|e| anyhow!("share plan task failed: {e}"))?;
    Ok(planned)
}

/// Launch the single-flight background pipeline (plan → check → mine →
/// pack → upload). Returns immediately; all progress flows through
/// `wowsp://contribution-progress` and `contribution_queue`. Identity,
/// consent and credentials must already be on record (the wizard's
/// earlier steps guarantee that ordering).
#[tauri::command]
pub async fn contribution_start(app: AppHandle, items: Vec<PlanCandidate>) -> CommandResult<()> {
    if items.is_empty() {
        return Err(anyhow!("nothing selected to share").into());
    }
    let identity = with_store(|s| s.identity.clone())?
        .ok_or_else(|| anyhow!("set your sharing identity first"))?;
    let consent_version = with_store(|s| s.consent_version)?
        .ok_or_else(|| anyhow!("record the sharing consent first"))?;
    let creds =
        with_store(credentials_of)?.ok_or_else(|| anyhow!("set your sharing identity first"))?;
    let client = crate::commands::network::build_http_client()?;
    // Take the single-flight slot BEFORE spawning: a second start while
    // one run is live is rejected; a finished pass is replaced.
    let pass = {
        let mut guard = PASS.lock().map_err(|_| anyhow!("lock poisoned"))?;
        if guard.as_ref().is_some_and(|pass| pass.is_running()) {
            return Err(anyhow!("a share run is already in flight").into());
        }
        let pass = Arc::new(Pass {
            snapshot: Mutex::new(QueueSnapshot {
                running: true,
                stage: stage::PLAN.to_string(),
                total_items: items.len() as u32,
                ..QueueSnapshot::default()
            }),
            cancel: AtomicBool::new(false),
        });
        *guard = Some(Arc::clone(&pass));
        pass
    };
    let roots = super::game_context::replay_roots();
    tauri::async_runtime::spawn(run_pipeline(
        RunContext {
            app,
            pass,
            identity,
            consent_version,
            creds,
            client,
            roots,
        },
        items,
    ));
    Ok(())
}

/// Cooperatively cancel the in-flight run (checked between stages, per
/// member while packing, and per chunk while uploading).
#[tauri::command]
pub fn contribution_cancel() -> CommandResult<()> {
    let guard = PASS.lock().map_err(|_| anyhow!("lock poisoned"))?;
    if let Some(pass) = guard.as_ref() {
        if pass.is_running() {
            pass.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// The current (or last finished) queue snapshot; with no pass ever
/// started, the idle default answers.
#[tauri::command]
pub fn contribution_queue() -> QueueSnapshot {
    let Ok(guard) = PASS.lock() else {
        return QueueSnapshot::default();
    };
    guard
        .as_ref()
        .map(|p| p.snapshot.lock().unwrap_or_else(|p| p.into_inner()).clone())
        .unwrap_or_default()
}

// ── the pipeline ────────────────────────────────────────────────────────────

/// Everything one share run carries end to end (clippy's argument cap is
/// also a readability cap): the app handle for events, the run's pass,
/// the persona + credentials, the HTTP client and the replay roots the
/// planner resolves realms against.
struct RunContext {
    app: AppHandle,
    pass: Arc<Pass>,
    identity: ContributionIdentity,
    consent_version: u32,
    creds: Credentials,
    client: reqwest::Client,
    roots: Vec<(PathBuf, Option<GameInstall>)>,
}

async fn run_pipeline(ctx: RunContext, items: Vec<PlanCandidate>) {
    let outcome = pipeline(&ctx, &items).await;
    match outcome {
        Ok(()) => {
            emit_pass(&ctx.app, &ctx.pass, |s| {
                s.running = false;
                s.stage = stage::DONE.to_string();
            });
        },
        Err(e) => {
            tracing::warn!(error = %e, "contribution share run failed");
            let message = e.to_string();
            emit_pass(&ctx.app, &ctx.pass, |s| {
                s.running = false;
                s.stage = stage::ERROR.to_string();
                s.message = Some(message);
            });
        },
    }
}

async fn pipeline(ctx: &RunContext, items: &[PlanCandidate]) -> Result<()> {
    // Run-scoped scratch under the cache dir (package + archive extract),
    // wiped and recreated on entry so a retry never inherits stale bytes,
    // and cleaned on both exits.
    let scratch = crate::paths::ensure_cache_dir()?.join("contribution");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| anyhow!("create {}: {e}", scratch.display()))?;
    let outcome = pipeline_inner(ctx, items, &scratch).await;
    let _ = std::fs::remove_dir_all(&scratch);
    outcome
}

async fn pipeline_inner(ctx: &RunContext, items: &[PlanCandidate], scratch: &Path) -> Result<()> {
    let (app, pass, client, creds) = (&ctx.app, &ctx.pass, &ctx.client, &ctx.creds);
    // ── plan ── hash + header-parse every candidate.
    emit_pass(app, pass, |s| {
        s.stage = stage::PLAN.to_string();
        s.message = Some("reading replays".to_string());
    });
    let _ = contribution_fetch_wanted(false).await;
    let (wanted, known, mine, identity_realm) = with_store(|s| {
        (
            s.wanted_cache
                .as_ref()
                .map(|c| c.doc.clone())
                .unwrap_or_else(closed_wanted),
            s.known_hashes.keys().cloned().collect::<HashSet<_>>(),
            s.mine_cache
                .as_ref()
                .map(|c| {
                    c.doc
                        .staged
                        .iter()
                        .map(|e| e.sha256.clone())
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default(),
            s.identity.as_ref().map(|i| i.realm.clone()),
        )
    })?;
    let planned = tokio::task::spawn_blocking({
        let items = items.to_vec();
        let roots = ctx.roots.clone();
        move || {
            plan_items_blocking(
                &items,
                &roots,
                &known,
                &mine,
                &wanted,
                identity_realm.as_deref(),
            )
        }
    })
    .await
    .map_err(|e| anyhow!("share plan task failed: {e}"))?;
    pass.check_cancelled()?;

    // ── check ── the server's verdicts are the authoritative ones.
    emit_pass(app, pass, |s| {
        s.stage = stage::CHECK.to_string();
        s.message = Some("checking the wanted list".to_string());
    });
    let plausible: Vec<&PlanItem> = planned
        .iter()
        .filter(|p| facts_plausible(&p.facts))
        .collect();
    let facts: Vec<ReplayFacts> = plausible.iter().map(|p| p.facts.clone()).collect();
    let check = post_check(client, creds, &facts).await?;
    let server: HashMap<String, (ContributionVerdict, Option<String>)> = check
        .into_iter()
        .map(|r| (r.sha256, (r.verdict, r.rule_id)))
        .collect();
    pass.check_cancelled()?;

    // ── mine ── the staged set the upload must be a superset of.
    emit_pass(app, pass, |s| {
        s.stage = stage::MINE.to_string();
        s.message = Some("syncing your staged replays".to_string());
    });
    let mine_doc = get_mine(client, creds).await?;
    cache_mine(mine_doc.clone())?;
    pass.check_cancelled()?;

    // Outcome mapping: accept → accepted; duplicate AND own_staged →
    // duplicate (the replay is already in the collection — re-sending an
    // own_staged member is the superset requirement, not a new
    // contribution, so the accepted count the done screen shows stays
    // honest); unwanted → unwanted; anything that fails locally → failed.
    let mut outcomes: HashMap<String, QueueOutcome> = planned
        .iter()
        .map(|p| (p.facts.sha256.clone(), QueueOutcome::Unwanted))
        .collect();
    for item in &planned {
        if !facts_plausible(&item.facts) {
            outcomes.insert(item.facts.sha256.clone(), QueueOutcome::Failed);
        }
    }

    // ── member assembly ── accept items from local files; own_staged
    // items from local files when they still exist (the rest of the
    // staged set comes out of the archive during pack).
    let mut members: BTreeMap<String, PackMember> = BTreeMap::new();
    for item in plausible {
        let sha = item.facts.sha256.clone();
        let Some((verdict, rule_id)) = server.get(&sha).cloned() else {
            // No server row for a plausible item (protocol drift) — treat
            // as unwanted rather than guessing an accept.
            continue;
        };
        match verdict {
            ContributionVerdict::Accept => {
                if Path::new(&item.path).is_file() {
                    members.insert(
                        sha.clone(),
                        PackMember {
                            sha256: sha.clone(),
                            file_name: item.file_name.clone(),
                            size_bytes: item.size_bytes,
                            facts: item.facts.core.clone(),
                            rule_id,
                            bytes_from: PathBuf::from(&item.path),
                        },
                    );
                    outcomes.insert(sha, QueueOutcome::Accepted);
                } else {
                    outcomes.insert(sha, QueueOutcome::Failed);
                }
            },
            ContributionVerdict::OwnStaged => {
                if Path::new(&item.path).is_file() {
                    members.insert(
                        sha.clone(),
                        PackMember {
                            sha256: sha.clone(),
                            file_name: item.file_name.clone(),
                            size_bytes: item.size_bytes,
                            facts: item.facts.core.clone(),
                            rule_id: item.rule_id.clone().or(rule_id),
                            bytes_from: PathBuf::from(&item.path),
                        },
                    );
                }
                outcomes.insert(sha, QueueOutcome::Duplicate);
            },
            ContributionVerdict::Duplicate => {
                outcomes.insert(sha, QueueOutcome::Duplicate);
            },
            ContributionVerdict::Unwanted => {},
        }
    }

    // ── pack ── (plus the archive pull for staged members without local
    // files — done lazily inside, only when at least one is missing).
    emit_pass(app, pass, |s| {
        s.stage = stage::PACK.to_string();
        s.message = Some("building the share package".to_string());
    });
    let mut extracted: HashMap<String, PathBuf> = HashMap::new();
    ensure_staged_members(ctx, &mine_doc, &mut members, &mut extracted, scratch).await?;
    if members.is_empty() {
        bail!("nothing to share — every selected replay is already known or unwanted");
    }
    if members.len() > MAX_MEMBERS {
        bail!(
            "share package would carry {} members (relay cap {MAX_MEMBERS})",
            members.len()
        );
    }
    let member_list: Vec<PackMember> = members.values().cloned().collect();
    let total_bytes: u64 = member_list.iter().map(|m| m.size_bytes).sum();
    if total_bytes > MAX_ARCHIVE_BYTES {
        bail!(
            "share package would be {} MiB (relay cap {})",
            total_bytes / (1024 * 1024),
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        );
    }
    emit_pass(app, pass, |s| {
        s.total_bytes = total_bytes;
        s.current_bytes = 0;
    });
    let package_path = scratch.join("package.tar.zstd");
    pack_pass(ctx, &package_path, &member_list, planned.len() as u32).await?;
    pass.check_cancelled()?;

    // ── upload ── (one automatic retry after a 422 adjustment).
    let pkg_len = std::fs::metadata(&package_path)
        .map_err(|e| anyhow!("inspect share package: {e}"))?
        .len();
    emit_pass(app, pass, |s| {
        s.stage = stage::UPLOAD.to_string();
        s.total_bytes = pkg_len;
        s.current_bytes = 0;
        s.message = Some("uploading".to_string());
    });
    let mut attempt = upload_package(ctx, &package_path, &member_list).await?;
    if attempt.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        let body = attempt.text().await.unwrap_or_default();
        let rejected = parse_rejected(&body);
        if rejected.is_empty() && !is_dropped_members(&body) {
            bail!("relay rejected the upload: {body}");
        }
        tracing::warn!(
            ?rejected,
            dropped = is_dropped_members(&body),
            "upload 422 — adjusting once"
        );
        for sha in &rejected {
            members.remove(sha);
            if let Some(item) = planned.iter().find(|p| &p.facts.sha256 == sha) {
                outcomes.insert(item.facts.sha256.clone(), QueueOutcome::Failed);
            }
        }
        if is_dropped_members(&body) {
            // The staged set moved under us (a raced upload or a drain):
            // re-sync mine and re-cover whatever is still staged.
            let mine_again = get_mine(client, creds).await?;
            cache_mine(mine_again.clone())?;
            let mut extracted = extracted;
            ensure_staged_members(ctx, &mine_again, &mut members, &mut extracted, scratch).await?;
        }
        let member_list: Vec<PackMember> = members.values().cloned().collect();
        if member_list.is_empty() {
            bail!("every share member was rejected by the relay");
        }
        let _ = std::fs::remove_file(&package_path);
        pack_pass(ctx, &package_path, &member_list, planned.len() as u32).await?;
        let pkg_len = std::fs::metadata(&package_path)
            .map_err(|e| anyhow!("inspect share package: {e}"))?
            .len();
        emit_pass(app, pass, |s| {
            s.total_bytes = pkg_len;
            s.current_bytes = 0;
            s.message = Some("retrying upload".to_string());
        });
        attempt = upload_package(ctx, &package_path, &member_list).await?;
    }
    if !attempt.status().is_success() {
        let status = attempt.status();
        let retry_after = attempt
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = attempt.text().await.unwrap_or_default();
        return Err(upload_error(status, retry_after.as_deref(), &body));
    }
    let uploaded: UploadResponse = attempt
        .json()
        .await
        .map_err(|e| anyhow!("parse upload response: {e}"))?;

    // ── done ── remember the member hashes, refresh the mine cache from
    // the authoritative answer, and publish the per-item results.
    let now = now_unix();
    let member_rows: Vec<(String, u64)> = members
        .values()
        .map(|m| (m.sha256.clone(), m.size_bytes))
        .collect();
    edit_store(|store| {
        remember_hashes(store, now, member_rows.into_iter());
        Ok(())
    })?;
    let mut mine_after = MineDoc {
        staged: Vec::new(),
        archive_bytes: uploaded.archive_bytes,
        credit_count: uploaded.credit_count,
    };
    if let Ok(fresh) = get_mine(client, creds).await {
        mine_after = fresh;
    }
    cache_mine(mine_after)?;
    let results: Vec<QueueResult> = planned
        .iter()
        .map(|item| QueueResult {
            sha256: item.facts.sha256.clone(),
            file_name: item.file_name.clone(),
            outcome: outcomes
                .get(&item.facts.sha256)
                .copied()
                .unwrap_or(QueueOutcome::Unwanted),
        })
        .collect();
    let accepted = uploaded.accepted;
    emit_pass(app, pass, |s| {
        s.done_items = planned.len() as u32;
        s.results = results;
        s.message = Some(format!("{accepted} newly accepted"));
    });
    Ok(())
}

/// One package-build pass on the blocking pool: each member append ticks
/// `currentBytes`/`doneItems` and doubles as the cancellation checkpoint
/// between members (the re-hash gate inside aborts on mismatch).
async fn pack_pass(
    ctx: &RunContext,
    package: &Path,
    members: &[PackMember],
    total_items: u32,
) -> Result<()> {
    let app = ctx.app.clone();
    let pass = Arc::clone(&ctx.pass);
    let package = package.to_path_buf();
    let members = members.to_vec();
    let packed = std::cell::Cell::new(0usize);
    tokio::task::spawn_blocking(move || {
        package::build_package_blocking(&package, &members, |_, bytes| {
            pass.check_cancelled()?;
            let done = packed.replace(packed.get() + 1) as u32;
            emit_pass(&app, &pass, |s| {
                s.current_bytes += bytes;
                s.done_items = done.min(total_items);
            });
            Ok(())
        })
    })
    .await
    .map_err(|e| anyhow!("share pack task failed: {e}"))?
}

/// Pull any staged member that is not yet in `members` (and has no local
/// bytes) out of the contributor's current archive — the manifest's
/// superset requirement. Downloads the archive ONCE per call and only
/// when something is actually missing.
async fn ensure_staged_members(
    ctx: &RunContext,
    mine: &MineDoc,
    members: &mut BTreeMap<String, PackMember>,
    extracted: &mut HashMap<String, PathBuf>,
    scratch: &Path,
) -> Result<()> {
    let (app, pass, client, creds, realm) = (
        &ctx.app,
        &ctx.pass,
        &ctx.client,
        &ctx.creds,
        ctx.identity.realm.as_str(),
    );
    let needed: HashSet<String> = mine
        .staged
        .iter()
        .map(|e| e.sha256.clone())
        .filter(|sha| !members.contains_key(sha) && !extracted.contains_key(sha))
        .collect();
    if needed.is_empty() {
        return Ok(());
    }
    pass.check_cancelled()?;
    emit_pass(app, pass, |s| {
        s.message = Some("fetching your previous archive".to_string());
    });
    let archive_path = scratch.join("archive.tar.zstd");
    download_archive(app, pass, client, creds, &archive_path).await?;
    let extract_dir = scratch.join("extracted");
    let wanted_set = needed.clone();
    let got = tokio::task::spawn_blocking(move || {
        package::extract_members_blocking(&archive_path, &wanted_set, &extract_dir)
    })
    .await
    .map_err(|e| anyhow!("share extract task failed: {e}"))??;
    extracted.extend(got);
    for entry in &mine.staged {
        if members.contains_key(&entry.sha256) {
            continue;
        }
        let Some(path) = extracted.get(&entry.sha256) else {
            bail!("relay archive is missing staged member {}", entry.sha256);
        };
        let facts = facts_for_extracted(path, &entry.file_name, realm);
        let size_bytes = std::fs::metadata(path)
            .map(|m| m.len())
            .unwrap_or(entry.size_bytes);
        members.insert(
            entry.sha256.clone(),
            PackMember {
                sha256: entry.sha256.clone(),
                file_name: entry.file_name.clone(),
                size_bytes,
                facts,
                rule_id: None,
                bytes_from: path.clone(),
            },
        );
    }
    Ok(())
}

/// Stream the contributor's archive blob to `dest`, ticking progress.
async fn download_archive(
    app: &AppHandle,
    pass: &Arc<Pass>,
    client: &reqwest::Client,
    creds: &Credentials,
    dest: &Path,
) -> Result<()> {
    use futures::StreamExt as _;
    use tokio::io::AsyncWriteExt as _;
    let resp = client
        .get(relay_url("/archive"))
        .header("User-Agent", USER_AGENT)
        .header("x-anon-id", &creds.anon_id)
        .header("x-upload-token", &creds.upload_token)
        .timeout(LONG_HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| anyhow!("fetch share archive: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("relay has no archive for these staged replays (staged list is stale — retry)");
    }
    if !resp.status().is_success() {
        bail!("fetch share archive: HTTP {}", resp.status());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| anyhow!("create {}: {e}", dest.display()))?;
    let mut stream = resp.bytes_stream();
    let mut since_emit = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("fetch share archive: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| anyhow!("write share archive: {e}"))?;
        since_emit += chunk.len() as u64;
        if since_emit >= 2 * 1024 * 1024 {
            let tick = since_emit;
            since_emit = 0;
            emit_pass(app, pass, |s| s.current_bytes += tick);
        }
        pass.check_cancelled()?;
    }
    file.flush()
        .await
        .map_err(|e| anyhow!("flush share archive: {e}"))?;
    Ok(())
}

/// A body stream that counts bytes into the pass snapshot (and aborts the
/// request when the run is cancelled) — the upload's progress + cancel
/// hook. Chunks are 64 KiB; events throttle to one per ~2 MiB.
struct CountingStream {
    file: tokio::fs::File,
    pass: Arc<Pass>,
    app: AppHandle,
    buf: Box<[u8; 64 * 1024]>,
    since_emit: u64,
}

impl futures::Stream for CountingStream {
    type Item = std::io::Result<Vec<u8>>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use tokio::io::AsyncRead as _;
        let this = self.get_mut();
        if this.pass.cancelled() {
            return std::task::Poll::Ready(Some(Err(std::io::Error::other("share run cancelled"))));
        }
        let mut read_buf = tokio::io::ReadBuf::new(this.buf.as_mut());
        match std::pin::Pin::new(&mut this.file).poll_read(cx, &mut read_buf) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready(Ok(())) => {
                let n = read_buf.filled().len();
                if n == 0 {
                    return std::task::Poll::Ready(None);
                }
                let bytes = n as u64;
                let emit_now = this.since_emit + bytes >= 2 * 1024 * 1024;
                if emit_now {
                    this.since_emit = 0;
                } else {
                    this.since_emit += bytes;
                }
                let snapshot = this.pass.update(|s| s.current_bytes += bytes);
                if emit_now {
                    emit(&this.app, &snapshot);
                }
                std::task::Poll::Ready(Some(Ok(read_buf.filled().to_vec())))
            },
            std::task::Poll::Ready(Err(e)) => std::task::Poll::Ready(Some(Err(e))),
        }
    }
}

impl Pass {
    /// Mutate the snapshot (no event) — the stream's inner tick.
    fn update(&self, f: impl FnOnce(&mut QueueSnapshot)) -> QueueSnapshot {
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut snapshot);
        snapshot.clone()
    }
}

/// POST the package: `x-manifest` base64url header, raw tar.zstd body
/// streamed from the file with an explicit content-length (required by
/// the relay), `application/zstd` content type.
async fn upload_package(
    ctx: &RunContext,
    package: &Path,
    members: &[PackMember],
) -> Result<reqwest::Response> {
    use base64::Engine as _;
    let (app, pass, client, creds) = (&ctx.app, &ctx.pass, &ctx.client, &ctx.creds);
    let manifest =
        package::build_manifest(members, ctx.consent_version, &ctx.identity, app_version());
    let manifest_header =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(manifest.as_bytes());
    let len = std::fs::metadata(package)
        .map_err(|e| anyhow!("inspect share package: {e}"))?
        .len();
    let file = tokio::fs::File::open(package)
        .await
        .map_err(|e| anyhow!("open share package: {e}"))?;
    let body = CountingStream {
        file,
        pass: Arc::clone(pass),
        app: app.clone(),
        buf: Box::new([0u8; 64 * 1024]),
        since_emit: 0,
    };
    client
        .post(relay_url("/upload"))
        .header("User-Agent", USER_AGENT)
        .header("x-anon-id", &creds.anon_id)
        .header("x-upload-token", &creds.upload_token)
        .header("x-manifest", manifest_header)
        .header(reqwest::header::CONTENT_TYPE, "application/zstd")
        .header(reqwest::header::CONTENT_LENGTH, len)
        .timeout(LONG_HTTP_TIMEOUT)
        .body(reqwest::Body::wrap_stream(body))
        .send()
        .await
        .map_err(|e| anyhow!("upload share package: {e}"))
}

fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The 422 `rejected` list: sha strings, or objects carrying a `sha256`
/// field — both parse (the contract leaves the row shape open).
fn parse_rejected(body: &str) -> Vec<String> {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    doc.get("rejected")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    row.as_str().map(str::to_owned).or_else(|| {
                        row.get("sha256")
                            .and_then(|s| s.as_str())
                            .map(str::to_owned)
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_dropped_members(body: &str) -> bool {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    // The relay answers `{"error":"dropped_members","dropped":[...]}` (the
    // DO's error_json detail key); the two camel/snake spellings stay
    // probed for forward tolerance.
    doc.get("error").and_then(|v| v.as_str()) == Some("dropped_members")
        || ["dropped", "droppedMembers", "dropped_members"]
            .iter()
            .any(|key| {
                doc.get(*key)
                    .and_then(|v| v.as_array())
                    .is_some_and(|rows| !rows.is_empty())
            })
}

/// Frontend-facing copy for the upload failures the user can act on.
fn upload_error(
    status: reqwest::StatusCode,
    retry_after: Option<&str>,
    body: &str,
) -> anyhow::Error {
    let trimmed: String = body.chars().take(300).collect();
    match status {
        reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::CONFLICT => anyhow!(
            "the relay rejected this upload token — forget your sharing identity and set it up again"
        ),
        reqwest::StatusCode::PAYLOAD_TOO_LARGE => {
            anyhow!("share package exceeds the relay's size or member cap")
        },
        reqwest::StatusCode::TOO_MANY_REQUESTS | reqwest::StatusCode::SERVICE_UNAVAILABLE => {
            match retry_after {
                Some(secs) => anyhow!("relay is busy — retry after {secs}s"),
                None => anyhow!("relay is busy — retry later"),
            }
        },
        _ => anyhow!("upload failed: HTTP {status} {trimmed}"),
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::StagedEntry;

    struct StoreFixture(PathBuf);

    impl StoreFixture {
        fn new() -> Self {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let dir = std::env::temp_dir().join(format!("wowsp-contrib-{}", hex::encode(nonce)));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for StoreFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sha(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    #[test]
    fn store_roundtrips_and_forgets_the_persona_but_not_the_hashes() {
        let fixture = StoreFixture::new();
        let mut store = ContributionStore::default();
        store.identity = Some(ContributionIdentity {
            realm: "asia".into(),
            name: "Player".into(),
        });
        store.consent_version = Some(1);
        store.anon_id = Some(uuid::Uuid::new_v4().to_string());
        store.upload_token = Some("t".repeat(32));
        remember_hashes(&mut store, 100, (0..10).map(|i| (sha(i), 1024)));
        persist_store_in(&fixture.0, &store).unwrap();

        let loaded = load_store_in(&fixture.0).unwrap();
        assert_eq!(loaded.identity, store.identity);
        assert_eq!(loaded.consent_version, Some(1));
        assert_eq!(loaded.known_hashes.len(), 10);

        // forget: persona + caches clear, hashes + consent survive.
        let mut forgotten = loaded;
        forgotten.identity = None;
        forgotten.anon_id = None;
        forgotten.upload_token = None;
        forgotten.wanted_cache = None;
        forgotten.mine_cache = None;
        assert_eq!(forgotten.known_hashes.len(), 10);
        assert_eq!(forgotten.consent_version, Some(1));
    }

    #[test]
    fn known_hashes_lru_caps_at_5000_evicting_the_oldest_first() {
        let mut store = ContributionStore::default();
        let stamps: Vec<(String, i64, u64)> = (0..KNOWN_HASHES_CAP + 1)
            .map(|i| {
                let s = format!("{:064x}", i);
                let stamp = 1000 + i as i64;
                (s, stamp, 1024 + i as u64)
            })
            .collect();
        remember_hashes(
            &mut store,
            0,
            stamps.iter().map(|(s, _, n)| (s.clone(), *n)),
        );
        assert_eq!(store.known_hashes.len(), KNOWN_HASHES_CAP);
        // The cap evicted the OLDEST row (stamp 1000, sha 0): refreshing
        // it at a NEW stamp must then evict the next-oldest instead.
        assert!(!store.known_hashes.contains_key(&format!("{:064x}", 0usize)));
        remember_hashes(
            &mut store,
            9_999,
            std::iter::once((format!("{:064x}", 0usize), 1024)),
        );
        assert_eq!(store.known_hashes.len(), KNOWN_HASHES_CAP);
        assert!(store.known_hashes.contains_key(&format!("{:064x}", 0usize)));
        assert!(!store.known_hashes.contains_key(&format!("{:064x}", 1usize)));
        // Sizes ride along for duplicate suppression display.
        assert_eq!(
            store
                .known_hashes
                .get(&format!("{:064x}", 2usize))
                .unwrap()
                .size_bytes,
            1026
        );
    }

    #[test]
    fn identity_validation_pins_realms_and_name_shape() {
        for realm in REALMS {
            assert!(valid_realm(realm));
        }
        for realm in ["ru ", "ASIA", "xyz", ""] {
            assert!(!valid_realm(realm), "{realm:?}");
        }
        assert!(valid_name("abc"));
        assert!(valid_name(&"x".repeat(24)));
        assert!(!valid_name("ab"));
        assert!(!valid_name(&"x".repeat(25)));
        assert!(!valid_name("bad\u{7}name"));
    }

    fn facts_fixture() -> ReplayFacts {
        ReplayFacts {
            sha256: sha(1),
            file_name: "20261014_090000_x.wowsreplay".into(),
            size_bytes: 8123456,
            core: ReplayFactsCore {
                map: "15_NE_north".into(),
                mode: "standard".into(),
                scenario: None,
                realm: "asia".into(),
                own_ship_id: 4183301234,
                ship_class: Some("Battleship".into()),
                tier: Some(10),
                player_count: 12,
                bot_count: 0,
                client_version: "14.5.0".into(),
                battle_time: "2026-10-14T09:00:00Z".into(),
            },
        }
    }

    #[test]
    fn facts_plausibility_mirrors_the_contract_window() {
        assert!(facts_plausible(&facts_fixture()));
        for mutate in [
            |f: &mut ReplayFacts| f.sha256 = "XYZ".into(),
            |f: &mut ReplayFacts| f.size_bytes = 1023,
            |f: &mut ReplayFacts| f.size_bytes = 67_108_865,
            |f: &mut ReplayFacts| f.core.player_count = 0,
            |f: &mut ReplayFacts| f.core.player_count = 65,
            |f: &mut ReplayFacts| f.core.bot_count = 65,
            |f: &mut ReplayFacts| f.core.tier = Some(12),
            |f: &mut ReplayFacts| f.core.ship_class = Some("Boat".into()),
            |f: &mut ReplayFacts| f.core.realm = "sea".into(),
            |f: &mut ReplayFacts| f.file_name = "a/b.wowsreplay".into(),
            |f: &mut ReplayFacts| f.file_name = "x".repeat(129),
        ] {
            let mut f = facts_fixture();
            mutate(&mut f);
            assert!(!facts_plausible(&f), "mutated facts must be implausible");
        }
        // Tier null + unknown realm claim absence are fine; the size
        // bounds are inclusive.
        let mut f = facts_fixture();
        f.core.tier = None;
        f.size_bytes = 1024;
        assert!(facts_plausible(&f));
        f.size_bytes = 67_108_864;
        assert!(facts_plausible(&f));
    }

    #[test]
    fn battle_time_converts_the_filename_stamp_through_local_time() {
        let got = battle_time_of(Some("20261014_090000")).unwrap();
        // Round-trip: whatever the machine's zone, converting back to the
        // local wall clock must land on the stamped time.
        let dt = chrono::DateTime::parse_from_rfc3339(&got).unwrap();
        let local = dt.with_timezone(&chrono::Local);
        assert_eq!(
            local.format("%Y%m%d_%H%M%S").to_string(),
            "20261014_090000",
            "{got}"
        );
        // Date-only stamps heal to midnight; garbage stays None.
        assert!(battle_time_of(Some("20261014")).is_some());
        assert!(battle_time_of(Some("garbage")).is_none());
        assert!(battle_time_of(None).is_none());
    }

    #[test]
    fn malformed_stores_error_instead_of_resetting() {
        let fixture = StoreFixture::new();
        for bytes in [b"{\"version\":1,\"identity\":".as_slice(), &[0xff]] {
            super::super::appdata::write_json_in(
                &fixture.0,
                CONTRIBUTION_FILE,
                &String::from_utf8_lossy(bytes),
            )
            .unwrap();
            assert!(load_store_in(&fixture.0).is_err());
        }
    }

    #[test]
    fn rejected_lists_parse_both_row_shapes_and_dropped_flags() {
        assert_eq!(
            parse_rejected(r#"{"rejected":["aaa","bbb"]}"#),
            vec!["aaa".to_string(), "bbb".to_string()]
        );
        assert_eq!(
            parse_rejected(r#"{"rejected":[{"sha256":"aaa"}]}"#),
            vec!["aaa".to_string()]
        );
        assert!(parse_rejected("{}").is_empty());
        assert!(parse_rejected("not json").is_empty());
        // The relay's real body shape (error code + `dropped` detail).
        assert!(is_dropped_members(
            r#"{"ok":false,"error":"dropped_members","dropped":["aaa"]}"#
        ));
        assert!(is_dropped_members(r#"{"droppedMembers":["aaa"]}"#));
        assert!(!is_dropped_members(r#"{"dropped_members":[]}"#));
        assert!(!is_dropped_members(r#"{"error":"rejected"}"#));
        assert!(!is_dropped_members(r#"{"rejected":["aaa"]}"#));
    }

    // ── the planner core over synthetic replays ─────────────────────────

    /// The replay container magic — mirror of replay.rs's private
    /// REPLAY_MAGIC (kept in lock-step, same as the playtime tests).
    const TEST_REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];

    fn write_synthetic_replay(path: &Path, descriptor: &str, filler: usize) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&TEST_REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
        bytes.extend_from_slice(descriptor.as_bytes());
        bytes.extend(std::iter::repeat(0x5a).take(filler));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, &bytes).unwrap();
    }

    #[test]
    fn plan_core_assembles_facts_and_merges_verdicts() {
        let fixture = StoreFixture::new();
        let root = fixture.0.join("replays");
        let replay = root.join("20261014_090000_PJSB719-Hotaka_15_NE_north.wowsreplay");
        write_synthetic_replay(
            &replay,
            r#"{"matchGroup":"standard","mapDisplayName":"15_NE_north","scenario":null,
                "clientVersionFromExe":"14,5,0,8867689",
                "vehicles":[
                    {"id":1,"name":"langyo","relation":0,"shipId":4183301234},
                    {"id":2,"name":":Sturdee:","relation":2,"shipId":2}
                ]}"#,
            2048,
        );
        let steam = GameInstall {
            kind: wowsp_tauri_shared::GameInstallKind::Steam,
            path: fixture.0.to_string_lossy().into_owned(),
            realm: Some("asia".into()),
        };
        let roots = vec![(root.clone(), Some(steam))];
        let wanted = WantedDoc {
            ruleset_version: 3,
            updated_at: Some("2026-10-14T00:00:00Z".into()),
            watermark: wowsp_tauri_shared::Watermark {
                staged_bytes: 1,
                limit_bytes: 8,
                accepting: true,
            },
            rules: vec![wowsp_tauri_shared::WantedRule {
                id: "std-asia".into(),
                collected: 0,
                max_count: None,
                note: None,
                maps: Vec::new(),
                modes: vec!["standard".into()],
                scenarios: Vec::new(),
                realms: vec!["asia".into()],
                ship_classes: Vec::new(),
                ship_ids: Vec::new(),
                tiers: Vec::new(),
                player_count_min: Some(1),
                player_count_max: None,
                bot_max: None,
                client_version_min: Some("14.0".into()),
            }],
        };
        let known: HashSet<String> = HashSet::new();
        let mine: HashSet<String> = HashSet::new();
        let planned = plan_items_blocking(
            &[PlanCandidate {
                path: replay.to_string_lossy().into_owned(),
                ship_class: Some("Battleship".into()),
                tier: Some(10),
            }],
            &roots,
            &known,
            &mine,
            &wanted,
            Some("eu"),
        );
        assert_eq!(planned.len(), 1);
        let item = &planned[0];
        // Facts: header fields + webui hints + install realm + sha/size.
        assert_eq!(item.facts.core.mode, "standard");
        assert_eq!(item.facts.core.map, "15_NE_north");
        assert_eq!(item.facts.core.own_ship_id, 4183301234);
        assert_eq!(item.facts.core.player_count, 2);
        assert_eq!(item.facts.core.bot_count, 1);
        assert_eq!(item.facts.core.client_version, "14.5.0");
        assert_eq!(item.facts.core.realm, "asia");
        assert_eq!(item.facts.core.ship_class.as_deref(), Some("Battleship"));
        assert_eq!(item.facts.core.tier, Some(10));
        let battle_time = item.facts.core.battle_time.clone();
        assert!(!battle_time.is_empty(), "dated filename");
        let dt = chrono::DateTime::parse_from_rfc3339(&battle_time).unwrap();
        assert_eq!(
            dt.with_timezone(&chrono::Local)
                .format("%Y%m%d_%H%M%S")
                .to_string(),
            "20261014_090000",
            "{battle_time}"
        );
        assert_eq!(
            item.facts.size_bytes,
            std::fs::metadata(&replay).unwrap().len()
        );
        assert_eq!(item.sha256, file_sha256(&replay).unwrap());
        assert_eq!(item.verdict, ContributionVerdict::Accept);
        assert_eq!(item.rule_id.as_deref(), Some("std-asia"));

        // A vanished file degrades to implausible → unwanted, never panics.
        let planned = plan_items_blocking(
            &[PlanCandidate {
                path: fixture
                    .0
                    .join("gone.wowsreplay")
                    .to_string_lossy()
                    .into_owned(),
                ship_class: None,
                tier: None,
            }],
            &roots,
            &known,
            &mine,
            &wanted,
            None,
        );
        assert_eq!(planned[0].verdict, ContributionVerdict::Unwanted);
        assert_eq!(planned[0].sha256, "");

        // A file under an unowned root falls back to the identity realm.
        let loose = fixture.0.join("20261014_080000_y.wowsreplay");
        write_synthetic_replay(&loose, r#"{"matchGroup":"standard","vehicles":[]}"#, 4096);
        let roots_unowned = vec![(fixture.0.join("other"), None)];
        let planned = plan_items_blocking(
            &[PlanCandidate {
                path: loose.to_string_lossy().into_owned(),
                ship_class: None,
                tier: None,
            }],
            &roots_unowned,
            &known,
            &mine,
            &wanted,
            Some("cn"),
        );
        assert_eq!(planned[0].facts.core.realm, "cn");
    }

    #[test]
    fn state_view_projects_the_mine_cache() {
        let mut store = ContributionStore::default();
        assert_eq!(state_of(&store).staged_count, 0);
        assert!(state_of(&store).last_sync_at.is_none());
        store.identity = Some(ContributionIdentity {
            realm: "eu".into(),
            name: "Player".into(),
        });
        store.mine_cache = Some(MineCacheEntry {
            doc: MineDoc {
                staged: vec![StagedEntry {
                    sha256: sha(3),
                    file_name: "x.wowsreplay".into(),
                    size_bytes: 4096,
                }],
                archive_bytes: 4096,
                credit_count: 7,
            },
            fetched_at: 1,
            last_sync_at: "2026-10-14T09:00:00Z".into(),
        });
        let state = state_of(&store);
        assert_eq!(state.staged_count, 1);
        assert_eq!(state.staged_bytes, 4096);
        assert_eq!(state.credit_count, 7);
        assert_eq!(state.last_sync_at.as_deref(), Some("2026-10-14T09:00:00Z"));
        assert!(!state.has_upload_token);
    }
}
