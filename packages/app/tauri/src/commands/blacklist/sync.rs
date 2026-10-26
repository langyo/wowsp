//! The blacklist pull: account/info + private.grouped_contacts with the
//! stored OpenID token (Authorization: Bearer — see the sibling auth module
//! for why the token never rides in a URL), then a public batch nickname
//! sweep over the blocked ids. Results land in blacklist-sync.json as a
//! wholesale replacement snapshot.

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

/// GET with the Bearer token in the Authorization header, riding the same
/// proxy-then-direct fallback as upstream_health::recorded_get (which cannot
/// carry custom headers) and recording the outcome against the host so the
/// upstream-health view stays honest. The URL is token-free by construction.
async fn authed_get(
    clients: &HttpPair,
    token: &str,
    host: &str,
    label: &str,
    url: String,
) -> Result<reqwest::Response> {
    let send = |client: &reqwest::Client| {
        client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
    };
    let outcome = send(clients.proxied()).await;
    match outcome {
        Ok(resp) => {
            crate::commands::upstream_health::record_success(host);
            Ok(resp)
        },
        Err(primary) => {
            let second = if clients.has_proxy() {
                send(clients.direct()).await
            } else {
                Err(primary)
            };
            match second {
                Ok(resp) => {
                    crate::commands::upstream_health::record_success(host);
                    Ok(resp)
                },
                Err(e) => {
                    crate::commands::upstream_health::record_failure(
                        host,
                        &format!("{label} request: {e}"),
                    );
                    Err(anyhow!("{label} request: {e}"))
                },
            }
        },
    }
}

/// Pull the account's own blocked-id list. The private block only exists in
/// the response when the Authorization token belongs to the queried account,
/// so this is structurally incapable of reading someone else's blacklist.
async fn fetch_blocked_ids(
    clients: &HttpPair,
    host: &str,
    auth: &super::auth::StoredAuth,
) -> Result<Vec<i64>> {
    let app_id = crate::commands::wg_realm::application_id(&auth.realm);
    let url = format!(
        "https://{host}/wows/account/info/?application_id={app_id}&account_id={}&extra=private.grouped_contacts&fields=private.grouped_contacts",
        auth.account_id,
    );
    let resp = authed_get(
        clients,
        &auth.access_token,
        host,
        "account/info(private)",
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
    let blocked = parsed
        .data
        .as_ref()
        .and_then(|d| d.get(auth.account_id.to_string()))
        .and_then(|v| v.get("private"))
        .and_then(|v| v.get("grouped_contacts"))
        .and_then(|v| serde_json::from_value::<GroupedContacts>(v.clone()).ok())
        .and_then(|g| g.blocked)
        .unwrap_or_default();
    Ok(blocked)
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

fn save_config(config: &BlacklistSyncConfig) -> Result<()> {
    let dir = paths::ensure_data_dir()?;
    let config = sanitize_config(*config);
    settings_store::store(&dir, CONFIG_FILE, &canonical_config_toml(&config)?)
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

    let ids = fetch_blocked_ids(&clients, host, &auth).await?;
    report.fetched = ids.len();

    // Nicknames: fresh sweep, with the previous snapshot's answers carried
    // over for ids the sweep could not answer this run (transient API
    // failures must not erase names the user can already read).
    let previous = load_snapshot_from(&dir, realm);
    let mut fresh = sweep_nicknames(&clients, host, realm, &ids).await;
    let mut unresolved = 0usize;
    let mut entries = Vec::with_capacity(ids.len());
    for id in &ids {
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

/// Persist the sync knobs (main window only — a settings write).
#[tauri::command]
pub fn blacklist_save_config(
    window: tauri::Window,
    config: BlacklistSyncConfig,
) -> CommandResult<()> {
    ensure_main_window_label(window.label())?;
    save_config(&config).map_err(|e| anyhow!("save blacklist config: {e:#}").into())
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
