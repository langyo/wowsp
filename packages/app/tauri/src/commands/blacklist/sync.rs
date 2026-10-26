//! The blacklist pull: account/info + private.grouped_contacts with the
//! stored OpenID token, then a public batch nickname sweep over the blocked
//! ids. Results land in blacklist-sync.json as a wholesale replacement
//! snapshot.
//!
//! Token transport: the portals document access_token as a METHOD PARAMETER
//! (the principles guide never mentions an Authorization header), so the
//! pull sends it as the documented query parameter — and every error string
//! is REDACTED before it can reach a log line or the upstream-health record
//! (reqwest's Display embeds the full URL, and this URL contains the
//! token). See redact_url.

use anyhow::{Result, anyhow};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::Value;

use wowsp_tauri_shared::{
    BlacklistEntry, BlacklistSnapshot, BlacklistSyncConfig, BlacklistSyncReport, CommandResult,
};

use crate::commands::ensure_main_window_label;
use crate::commands::network::HttpPair;
use crate::paths;
use crate::settings_store::{self, SettingsSource};

pub(crate) const SNAPSHOT_FILE: &str = "blacklist-sync.json";
pub(crate) const CONFIG_FILE: &str = "blacklist-config.toml";
/// account/info ids per request (the endpoint's documented cap).
const IDS_PER_REQUEST: usize = 100;
/// In-flight nickname sweep requests — the roster batch's proven pacing
/// against the ~10 req/s standalone rate limit.
const SWEEP_CONCURRENCY: usize = 4;

/// Minimal WG envelope (status/error/data). Local on purpose: the shared
/// WgResponse in wg_api::shared is pub(super) to that module tree, and the
/// blacklist module has no other reason to depend on it.
#[derive(Debug, Deserialize)]
struct WgEnvelope<T> {
    status: String,
    #[serde(default)]
    error: Option<WgErrorInner>,
    #[serde(default)]
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct WgErrorInner {
    #[serde(default)]
    message: Option<String>,
}

impl<T> WgEnvelope<T> {
    fn message(&self) -> String {
        self.error
            .as_ref()
            .and_then(|e| e.message.clone())
            .unwrap_or_default()
    }
}

/// The grouped_contacts shape we care about; every parent node is optional
/// because an account that never used the contacts UI omits the whole block.
#[derive(Debug, Deserialize, Default)]
struct GroupedContacts {
    #[serde(default)]
    blocked: Option<Vec<i64>>,
}

/// Cut every query string out of an error message. reqwest's Display embeds
/// the full request URL, and the private-data URL carries the access token —
/// so no reqwest error text may ever reach a log line, a health record or an
/// anyhow message unredacted (§7). Everything from the first '?' up to the
/// closing paren of the Display form collapses to a marker.
pub(crate) fn redact_url(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut in_query = false;
    for ch in msg.chars() {
        match ch {
            '?' if !in_query => {
                in_query = true;
                out.push_str("?..");
            },
            ')' if in_query => {
                in_query = false;
                out.push(ch);
            },
            _ if in_query => {},
            _ => out.push(ch),
        }
    }
    out
}

/// GET carrying the access token as the documented query parameter, riding
/// the same proxy-then-direct fallback as upstream_health::recorded_get and
/// recording the outcome against the host so the upstream-health view stays
/// honest — with every failure string REDACTED through redact_url first
/// (the raw reqwest text embeds the token-bearing URL).
async fn token_get(
    clients: &HttpPair,
    host: &str,
    label: &str,
    url: String,
) -> Result<reqwest::Response> {
    let send = |client: &reqwest::Client| client.get(&url).send();
    let primary = send(clients.proxied()).await;
    let outcome = match primary {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                crate::commands::upstream_health::record_success(host);
                Ok(resp)
            } else {
                crate::commands::upstream_health::record_failure(host, &format!("HTTP {status}"));
                Ok(resp)
            }
        },
        Err(first) => {
            let second = if clients.has_proxy() {
                send(clients.direct()).await
            } else {
                Err(first)
            };
            match second {
                Ok(resp) => {
                    crate::commands::upstream_health::record_success(host);
                    Ok(resp)
                },
                Err(e) => {
                    let redacted = redact_url(&e.to_string());
                    crate::commands::upstream_health::record_failure(
                        host,
                        &format!("{label} request: {redacted}"),
                    );
                    Err(anyhow!("{label} request: {redacted}"))
                },
            }
        },
    };
    outcome
}

/// What one private pull answered: the blocked ids plus whether the private
/// contacts block came back at all.
struct FetchOutcome {
    ids: Vec<i64>,
    /// The token was accepted (status ok) but the private block is MISSING.
    /// That is either a legitimately-never-used contacts UI or a REJECTED
    /// token scope — the two cannot be told apart from the response, so the
    /// caller surfaces a warning message instead of a silent empty list.
    private_missing: bool,
}

/// Pure core of the response parse: the data node keyed by the account id,
/// the private/grouped_contacts nesting and its blocked list. ` + '`' + String.raw`None` + '`' + String.raw` on
/// the whole node missing (private_missing signal); an empty grouped
/// contacts block parses to an EMPTY list (legitimate empty blacklist).
pub(crate) fn parse_blocked_response(data: Option<&Value>, account_id: i64) -> Option<Vec<i64>> {
    let node = data?.get(account_id.to_string())?;
    let private = node.get("private")?;
    let contacts = private.get("grouped_contacts")?;
    Some(
        serde_json::from_value::<GroupedContacts>(contacts.clone())
            .ok()
            .and_then(|g| g.blocked)
            .unwrap_or_default(),
    )
}

/// Pull the account's own blocked-id list. The private block only exists in
/// the response when the access token belongs to the queried account (and
/// the portal accepted its transport), so this is structurally incapable of
/// reading someone else's blacklist.
async fn fetch_blocked_ids(
    clients: &HttpPair,
    host: &str,
    auth: &super::auth::StoredAuth,
) -> Result<FetchOutcome> {
    let app_id = crate::commands::wg_realm::application_id(&auth.realm);
    let url = format!(
        "https://{host}/wows/account/info/?application_id={app_id}&account_id={}&access_token={}&extra=private.grouped_contacts&fields=private.grouped_contacts",
        auth.account_id,
        crate::commands::wg_api::encode_query(&auth.access_token),
    );
    let resp = token_get(clients, host, "account/info(private)", url).await?;
    let parsed: WgEnvelope<Value> = resp
        .json()
        .await
        .map_err(|e| anyhow!("account/info parse: {e}"))?;
    if parsed.status != "ok" {
        return Err(anyhow!("account/info: {}", parsed.message()));
    }
    match parse_blocked_response(parsed.data.as_ref(), auth.account_id) {
        Some(ids) => Ok(FetchOutcome {
            ids,
            private_missing: false,
        }),
        None => Ok(FetchOutcome {
            ids: Vec::new(),
            private_missing: true,
        }),
    }
}

/// Public nickname sweep over <=100-id chunks; answers id -> nickname
/// (nicknames are public even for hidden profiles — only stats hide).
/// Chunk-level failures degrade to "those ids stay unresolved" instead of
/// failing the whole sync: a snapshot with bare ids still powers the
/// marker matching, which keys on account_id anyway.
async fn sweep_nicknames(
    clients: &HttpPair,
    host: &str,
    realm: &str,
    ids: &[i64],
) -> HashMap<i64, String> {
    let app_id = crate::commands::wg_realm::application_id(realm);
    let chunks: Vec<Vec<i64>> = ids.chunks(IDS_PER_REQUEST).map(|c| c.to_vec()).collect();
    let pair_ref = clients;
    let maps: Vec<Result<HashMap<i64, String>>> = stream::iter(chunks)
        .map(|chunk| {
            let csv = chunk
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let url = format!(
                "https://{host}/wows/account/info/?application_id={app_id}&account_id={csv}&fields=nickname"
            );
            async move {
                let resp = crate::commands::upstream_health::recorded_get(
                    pair_ref,
                    host,
                    "account/info(nicknames)",
                    url,
                )
                .await?;
                let parsed: WgEnvelope<Value> = resp
                    .json()
                    .await
                    .map_err(|e| anyhow!("account/info parse: {e}"))?;
                if parsed.status != "ok" {
                    return Err(anyhow!("account/info: {}", parsed.message()));
                }
                let mut map = HashMap::new();
                if let Some(Value::Object(entries)) = parsed.data {
                    for (id, entry) in entries {
                        if let (Ok(id), Some(name)) = (
                            id.parse::<i64>(),
                            entry.get("nickname").and_then(|n| n.as_str()),
                        ) {
                            map.insert(id, name.to_string());
                        }
                    }
                }
                Ok(map)
            }
        })
        .buffered(SWEEP_CONCURRENCY)
        .collect()
        .await;
    let mut merged = HashMap::new();
    for map in maps.into_iter().flatten() {
        merged.extend(map);
    }
    merged
}

// ── snapshot + config stores ─────────────────────────────────────────────────

pub(crate) fn snapshot_path(dir: &Path) -> PathBuf {
    dir.join(SNAPSHOT_FILE)
}

/// Atomic write behind the shared settings-store gate (JSON is the repo's
/// data-cache convention — see settings_store's module docs).
pub(crate) fn store_snapshot(dir: &Path, snap: &BlacklistSnapshot) -> Result<()> {
    let json = serde_json::to_string(snap).map_err(|e| anyhow!("serialize snapshot: {e}"))?;
    settings_store::store(dir, SNAPSHOT_FILE, &json)
}

/// Tolerant read; None when absent, unreadable, or bound to another realm
/// (the file holds ONE realm's snapshot — the most recent login wins).
pub(crate) fn load_snapshot_from(dir: &Path, realm: &str) -> Option<BlacklistSnapshot> {
    let raw = std::fs::read_to_string(snapshot_path(dir)).ok()?;
    let snap: BlacklistSnapshot = serde_json::from_str(&raw).ok()?;
    (snap.realm == realm).then_some(snap)
}

/// Clamp the tunable knobs. interval_hours outside 1..=168 snaps to the
/// default — the file is user-editable and any hand edit that could never
/// produce a sane timer must not survive (settings-store heal convention).
pub(crate) fn sanitize_config(mut config: BlacklistSyncConfig) -> BlacklistSyncConfig {
    if !(1..=168).contains(&config.interval_hours) {
        config.interval_hours = BlacklistSyncConfig::default().interval_hours;
    }
    config
}

pub(crate) fn canonical_config_toml(config: &BlacklistSyncConfig) -> Result<String> {
    let header =
        "# WoWSP blacklist sync (auto pull) settings. interval_hours is clamped to 1..=168.\n";
    let body = toml::to_string(config).map_err(|e| anyhow!("serialize blacklist config: {e}"))?;
    Ok(format!("{header}{body}"))
}

pub(crate) fn load_config_from(dir: &Path) -> BlacklistSyncConfig {
    let loaded = settings_store::load_raw(dir, CONFIG_FILE, "blacklist-config.json");
    let Some(raw) = loaded.raw else {
        return BlacklistSyncConfig::default();
    };
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<BlacklistSyncConfig>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<BlacklistSyncConfig>(&raw).ok()
        },
    };
    let config = sanitize_config(parsed.unwrap_or_default());
    if let Ok(canonical) = canonical_config_toml(&config) {
        settings_store::heal(
            dir,
            CONFIG_FILE,
            "blacklist-config.json",
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    config
}

/// Persisted sync knobs (settings page: auto-sync switch + interval).
pub(crate) fn load_config() -> BlacklistSyncConfig {
    match paths::ensure_data_dir() {
        Ok(dir) => load_config_from(&dir),
        Err(_) => BlacklistSyncConfig::default(),
    }
}

fn save_config(config: &BlacklistSyncConfig) -> Result<BlacklistSyncConfig> {
    let dir = paths::ensure_data_dir()?;
    let config = sanitize_config(*config);
    settings_store::store(&dir, CONFIG_FILE, &canonical_config_toml(&config)?)?;
    Ok(config)
}

// ── the sync itself ──────────────────────────────────────────────────────────

/// One sync run. Failures land in the REPORT (ok=false + message), not as
/// command rejections — the settings page renders the reason inline and the
/// auto-sync loop can consume every answer uniformly.
async fn run_sync(realm: &str) -> BlacklistSyncReport {
    let mut report = BlacklistSyncReport {
        realm: realm.to_string(),
        ok: false,
        fetched: 0,
        resolved: 0,
        message: None,
    };
    match run_sync_inner(realm, &mut report).await {
        Ok(()) => report.ok = true,
        Err(e) => {
            tracing::warn!(realm = %realm, "blacklist sync failed: {e:#}");
            report.message = Some(format!("{e:#}"));
        },
    }
    report
}

async fn run_sync_inner(realm: &str, report: &mut BlacklistSyncReport) -> Result<()> {
    let platform = super::auth::platform_of(realm)
        .ok_or_else(|| anyhow!("realm '{}' does not support blacklist sync", realm))?;
    let auth = super::auth::load_auth()
        .filter(|a| a.realm == realm)
        .ok_or_else(|| anyhow!("Not logged in on realm '{realm}' — run the login flow first"))?;
    if auth.expires_at <= super::auth::unix_now() {
        return Err(anyhow!("Blacklist access token expired — log in again"));
    }
    let host = crate::commands::wg_realm::api_host(realm)?;
    let dir = paths::ensure_data_dir()?;
    let clients = HttpPair::build(|b| b.timeout(Duration::from_secs(15)))?;

    let outcome = fetch_blocked_ids(&clients, host, &auth).await?;
    report.fetched = outcome.ids.len();
    if outcome.private_missing {
        // Distinguishable failure (NOT a silent empty list): the portal said
        // ok but the private contacts block never arrived — either the token
        // transport was rejected or the account never used contacts. The
        // message rides the successful report so the settings page shows the
        // caveat next to the fresh snapshot.
        report.message = Some(
            "private contacts block missing — the token may have been rejected; try logging \
             in again"
                .to_string(),
        );
        tracing::warn!(realm = %realm, "blacklist pull: private block missing");
    }

    // Nicknames: fresh sweep, with the previous snapshot's answers carried
    // over for ids the sweep could not answer this run (transient API
    // failures must not erase names the user can already read).
    let previous = load_snapshot_from(&dir, realm);
    let mut fresh = sweep_nicknames(&clients, host, realm, &outcome.ids).await;
    let mut unresolved = 0usize;
    let mut entries = Vec::with_capacity(outcome.ids.len());
    for id in &outcome.ids {
        let carried = previous.as_ref().and_then(|p| {
            p.entries
                .iter()
                .find(|e| e.account_id == *id)
                .and_then(|e| e.nickname.clone())
        });
        let nickname = match fresh.remove(id) {
            Some(name) => Some(name),
            None => carried,
        };
        if nickname.is_none() {
            unresolved += 1;
        }
        entries.push(BlacklistEntry {
            account_id: *id,
            nickname,
        });
    }
    entries.sort_by_key(|e| e.account_id);
    report.resolved = entries.iter().filter(|e| e.nickname.is_some()).count();

    let snapshot = BlacklistSnapshot {
        realm: realm.to_string(),
        platform,
        account_id: auth.account_id,
        nickname: Some(auth.nickname.clone()),
        last_synced_at: super::auth::unix_now(),
        unresolved,
        entries,
    };
    store_snapshot(&dir, &snapshot)?;
    tracing::info!(
        realm = %realm,
        fetched = report.fetched,
        unresolved = snapshot.unresolved,
        "blacklist snapshot stored"
    );
    Ok(())
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Sync knobs for the settings page.
#[tauri::command]
pub fn blacklist_load_config() -> CommandResult<BlacklistSyncConfig> {
    Ok(load_config())
}

/// Persist the sync knobs (main window only — a settings write). Returns
/// the SANITIZED config so the webui re-syncs from the response instead of
/// keeping its optimistic local copy (the network-config save pattern).
#[tauri::command]
pub fn blacklist_save_config(
    window: tauri::Window,
    config: BlacklistSyncConfig,
) -> CommandResult<BlacklistSyncConfig> {
    ensure_main_window_label(window.label())?;
    let sanitized = save_config(&config).map_err(|e| {
        wowsp_tauri_shared::CommandError::from(anyhow!("save blacklist config: {e:#}"))
    })?;
    Ok(sanitized)
}

/// The stored snapshot for one realm (settings list + marker matching).
/// None when that realm was never synced on this machine.
#[tauri::command]
pub fn blacklist_snapshot(realm: String) -> CommandResult<Option<BlacklistSnapshot>> {
    let dir = paths::ensure_data_dir().map_err(|e| anyhow!("data dir: {e:#}"))?;
    Ok(load_snapshot_from(&dir, &realm))
}

/// Pull the blacklist for one realm now (the "sync now" button and the
/// auto-sync loop both land here; see run_sync for the failure shape).
#[tauri::command]
pub async fn blacklist_sync_now(
    window: tauri::Window,
    realm: String,
) -> CommandResult<BlacklistSyncReport> {
    ensure_main_window_label(window.label())?;
    Ok(run_sync(&realm).await)
}
