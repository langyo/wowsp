//! Shared provider registry source (M5): the app's curated LLM provider and
//! model catalog comes from the companion langyo/provider-registry repo.
//!
//! One HTTP request downloads the master-branch tarball (codeload, no GitHub
//! API quota), flate2 + tar unpack it in memory, and the PURE parse picks the
//! entries this app can actually talk to:
//!
//! - only tools whose entrypoint declares protocol == "openai_chat_v1" (the
//!   translation client speaks OpenAI chat completions);
//! - pseudo providers whose provider id ends in "_compatible" are excluded
//!   (the settings page's custom provider mode covers those);
//! - the base URL must be a non-empty http(s) URL;
//! - display names come from the entrypoint's name table (8 languages, missing
//!   entries fall back to English, then to the provider id);
//! - the default model prefers defaults.normal, then deep, then basic, then the
//!   first listed model;
//! - model display names are completed from models/<providerId>/<modelId>.toml
//!   (model.name), fetched from the same tarball.
//!
//! The parsed catalog is cached in the app data dir as chat-providers.json
//! ({"fetchedAt", "providers"}) with a 24 h TTL. A refresh that fails answers
//! the cached copy with stale = true; with no cache it rejects with a short
//! user-facing sentence. Concurrent fetches are serialized behind one async
//! mutex.
//!
//! Everything here is read-only towards the network and the local cache: no
//! keys, no game files, no logging of response bodies. TOML uses
//! toml::Value navigation so a bad field is skipped, never a panic.

use anyhow::{Result, anyhow, bail};

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

use crate::commands::network::HttpPair;
use crate::commands::upstream_health;
use crate::paths;

/// The tarball of the provider-registry repo's master branch (single request,
/// no GitHub API quota). Overridable through the environment for dev/mirrors.
pub(crate) const REGISTRY_TARBALL_URL: &str =
    "https://codeload.github.com/langyo/provider-registry/tar.gz/refs/heads/master";

/// Environment override for [REGISTRY_TARBALL_URL] (read side only; dev and
/// mirror builds point this at a local tarball).
pub(crate) const REGISTRY_URL_ENV: &str = "WOWSP_CHAT_PROVIDER_REGISTRY_URL";

/// Cached catalog file inside the app data dir.
pub(crate) const REGISTRY_FILE: &str = "chat-providers.json";

/// The fetched catalog is considered fresh for one day.
const CACHE_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
/// How far a cache timestamp may sit in the future before it counts as
/// expired (a small tolerance absorbs clock jitter between machines).
const CLOCK_SKEW_TOLERANCE_MS: u64 = 5 * 60 * 1_000;

/// Download/read bounds: the registry repo is a few MB today, but a hostile or
/// broken mirror must never make the app allocate without limit.
const MAX_TARBALL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FILES_BYTES: u64 = 32 * 1024 * 1024;

/// Registry request timeout (the settings page waits on this probe once).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20);

/// One provider catalog entry's model row (id + optional display name).
#[allow(dead_code)] // wire DTO: written by the parser, read by serde/the webui.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRegistryModel {
    /// Model id as sent in the provider's request body.
    pub id: String,
    /// Display name when the registry's model metadata provides one.
    pub name: Option<String>,
}

/// One provider's localized display names (missing languages fall back to
/// English, then to the provider id).
#[allow(dead_code)] // wire DTO: written by the parser, read by serde/the webui.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRegistryNames {
    pub en: String,
    pub zhs: String,
    pub zht: String,
    pub ja: String,
    pub ko: String,
    pub fr: String,
    pub es: String,
    pub ru: String,
}

/// One usable provider preset from the registry.
#[allow(dead_code)] // wire DTO: written by the parser, read by serde/the webui.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRegistryEntry {
    /// Entrypoint id (e.g. deepseek_default).
    pub id: String,
    /// Provider id shared by the entrypoint's models (e.g. deepseek).
    pub provider_id: String,
    /// Localized display names.
    pub names: ProviderRegistryNames,
    /// The provider's OpenAI-compatible base URL.
    pub base_url: String,
    /// Environment variable the registry suggests for the API key (hint only;
    /// this app's own key settings stay authoritative).
    pub env_var: Option<String>,
    /// Preselected model (defaults.normal -> deep -> basic -> first model).
    pub default_model: Option<String>,
    /// The entrypoint's model list, sorted by id, names completed from the
    /// registry's per-model metadata files.
    pub models: Vec<ProviderRegistryModel>,
}

/// The full catalog answer the settings page renders.
#[allow(dead_code)] // wire DTO: written by the fetch, read by serde/the webui.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRegistry {
    /// Unix milliseconds the catalog was fetched at.
    pub fetched_at: u64,
    /// True when a refresh failed and the cached copy is being served.
    pub stale: bool,
    pub providers: Vec<ProviderRegistryEntry>,
}

/// The on-disk cache shape: the stale flag is transient and never persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryCacheFile {
    fetched_at: u64,
    providers: Vec<ProviderRegistryEntry>,
}

/// Serializes registry fetches: one network round trip at a time.
static FETCH_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl ProviderRegistryNames {
    /// Build the name table from an entrypoint's [entrypoint.name] table.
    /// Missing/blank languages fall back to English; a missing English name
    /// falls back to the provider id (the entry is still usable).
    fn from_toml(table: Option<&toml::Value>, provider_id: &str) -> Self {
        let read = |key: &str| trimmed_str(table.and_then(|value| value.get(key)));
        let en = read("en").unwrap_or_else(|| provider_id.to_string());
        let localized = |key: &str| read(key).unwrap_or_else(|| en.clone());
        Self {
            zhs: localized("zhs"),
            zht: localized("zht"),
            ja: localized("ja"),
            ko: localized("ko"),
            fr: localized("fr"),
            es: localized("es"),
            ru: localized("ru"),
            en,
        }
    }
}

// ── pure parsing ───────────────────────────────────────────────────────────

/// A non-empty trimmed string field, or None (missing/wrong-type/blank).
fn trimmed_str(value: Option<&toml::Value>) -> Option<String> {
    value
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Locate the `models/` section of a tarball path, tolerating ANY leading
/// packaging directory (or none at all) — a re-packed mirror whose archive
/// root IS the repository is a valid override target, not garbage.
fn models_section(path: &str) -> Option<&str> {
    let marker = "/models/";
    if let Some(index) = path.find(marker) {
        return Some(&path[index + marker.len()..]);
    }
    path.strip_prefix("models/")
}

/// Locate the `entrypoint/` section of a tarball path (same tolerance).
fn is_entrypoint_toml(path: &str) -> bool {
    path.ends_with(".toml") && (path.contains("/entrypoint/") || path.starts_with("entrypoint/"))
}

fn is_registry_file(path: &str) -> bool {
    path.ends_with(".toml") && (models_section(path).is_some() || is_entrypoint_toml(path))
}

/// Candidate keys for the per-model metadata lookup: the registry stores one
/// file per model with the id SANITIZED for a filesystem (`openai/gpt-5.4` →
/// `openai_gpt-5.4`, `gpt-5.4-pro:batch` → `gpt-5.4-pro-batch`), so the exact
/// id is tried first, then the observed sanitized forms.
fn model_name_keys(model_id: &str) -> Vec<String> {
    let slash = model_id.replace('/', "_");
    let colon = model_id.replace(':', "-");
    let both = slash.replace(':', "-");
    let mut keys = vec![model_id.to_string()];
    for candidate in [colon, slash, both] {
        if !keys.contains(&candidate) {
            keys.push(candidate);
        }
    }
    keys
}

/// Extract (provider id, model id) from a models/<provider>/<model>.toml path.
fn model_path_ids(path: &str) -> Option<(String, String)> {
    let rest = models_section(path)?;
    let (provider, file) = rest.split_once('/')?;
    let model_id = file.strip_suffix(".toml")?;
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }
    Some((provider.to_string(), model_id.to_string()))
}

/// Pick the entrypoint's default model: defaults.normal, then deep, then basic.
fn default_model_from(defaults: Option<&toml::Value>) -> Option<String> {
    let defaults = defaults?;
    for key in ["normal", "deep", "basic"] {
        if let Some(model) = trimmed_str(defaults.get(key)) {
            return Some(model);
        }
    }
    None
}

/// One entrypoint TOML -> one registry entry; None when the entry is not
/// usable by this app (wrong protocol, pseudo provider, bad URL, missing ids).
fn provider_from_toml(
    value: &toml::Value,
    model_names: &HashMap<(String, String), String>,
) -> Option<ProviderRegistryEntry> {
    let entrypoint = value.get("entrypoint")?;
    let id = trimmed_str(entrypoint.get("id"))?;
    let provider_id = trimmed_str(entrypoint.get("provider_id"))?;
    if provider_id.to_ascii_lowercase().ends_with("_compatible") {
        return None;
    }
    // `type = "generation"` entries front image/audio/video models (dall-e,
    // tts, sora) over the chat protocol's shape — they cannot translate a
    // chat line, so they must not appear as chat providers.
    if trimmed_str(entrypoint.get("type")).as_deref() == Some("generation") {
        return None;
    }
    let api = entrypoint.get("api")?;
    if trimmed_str(api.get("protocol")).as_deref() != Some("openai_chat_v1") {
        return None;
    }
    let base_url = trimmed_str(api.get("base_url"))?;
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return None;
    }
    let env_var = trimmed_str(api.get("env_var"));
    let names = ProviderRegistryNames::from_toml(entrypoint.get("name"), &provider_id);

    let mut models: Vec<ProviderRegistryModel> = entrypoint
        .get("models")
        .and_then(toml::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let model_id = trimmed_str(entry.get("id"))?;
                    let name = model_name_keys(&model_id)
                        .into_iter()
                        .find_map(|key| model_names.get(&(provider_id.clone(), key)).cloned());
                    Some(ProviderRegistryModel { id: model_id, name })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);

    let default_model = default_model_from(entrypoint.get("defaults"))
        .or_else(|| models.first().map(|model| model.id.clone()));

    Some(ProviderRegistryEntry {
        id,
        provider_id,
        names,
        base_url,
        env_var,
        default_model,
        models,
    })
}

/// Parse a tarball's relevant files (path, content) into the usable provider
/// catalog. Pure: no I/O, no network, no panic — malformed files are skipped.
///
/// Kept files are the entrypoint TOMLs and the per-model metadata TOMLs (the
/// latter only supply display names, looked up by (provider id, model id)).
pub(crate) fn parse_registry(files: &[(String, String)]) -> Vec<ProviderRegistryEntry> {
    let mut model_names: HashMap<(String, String), String> = HashMap::new();
    for (path, content) in files {
        let Some((provider_id, model_id)) = model_path_ids(path) else {
            continue;
        };
        let Ok(value) = toml::from_str::<toml::Value>(content) else {
            continue;
        };
        let Some(name) = value
            .get("model")
            .and_then(|model| model.get("name"))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        model_names.insert((provider_id, model_id), name.to_string());
    }

    let mut providers: Vec<ProviderRegistryEntry> = Vec::new();
    for (path, content) in files {
        if !is_entrypoint_toml(path) {
            continue;
        }
        let Ok(value) = toml::from_str::<toml::Value>(content) else {
            continue;
        };
        if let Some(entry) = provider_from_toml(&value, &model_names) {
            providers.push(entry);
        }
    }
    // Stable, predictable order for the settings page: English name first.
    providers.sort_by(|a, b| {
        a.names
            .en
            .to_ascii_lowercase()
            .cmp(&b.names.en.to_ascii_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    providers
}

// ── tarball download / unpack ──────────────────────────────────────────────

/// Resolve the tarball URL: the environment override when set and non-blank,
/// else [REGISTRY_TARBALL_URL]. Pure (unit-tested).
fn resolve_registry_url(override_value: Option<&str>) -> String {
    override_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| REGISTRY_TARBALL_URL.to_string())
}

/// The effective registry URL (env override read side; no network).
pub(crate) fn registry_url() -> String {
    resolve_registry_url(std::env::var(REGISTRY_URL_ENV).ok().as_deref())
}

/// Download + gunzip + untar the registry, keeping only the files the parser
/// needs (entrypoint TOMLs and model metadata TOMLs) as (path, content).
pub(crate) async fn download_registry(url: &str) -> Result<Vec<(String, String)>> {
    // The tarball GET rides the proxy→direct chain; the capped body
    // stream below reads off whichever response the chain landed on.
    let clients = HttpPair::build(|b| b)?;
    let host = upstream_health::host_of_url(url).to_string();
    let response =
        upstream_health::send_with_fallback(&clients, &host, "chat-translate", |client| {
            client.get(url).timeout(DOWNLOAD_TIMEOUT)
        })
        .await
        .map_err(|error| anyhow!("provider registry request failed: {error}"))?;
    if !response.status().is_success() {
        bail!(
            "provider registry returned HTTP {}",
            response.status().as_u16()
        );
    }
    if let Some(length) = response.content_length()
        && length > MAX_TARBALL_BYTES
    {
        bail!("provider registry tarball is too large ({length} bytes)");
    }
    // Stream the body with a hard CAP instead of buffering it wholesale: a
    // missing or forged Content-Length must not let the allocation grow
    // without bound (the comment's promise, enforced here).
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("provider registry download was interrupted"))?
    {
        let next = u64::try_from(bytes.len())
            .unwrap_or(u64::MAX)
            .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if next > MAX_TARBALL_BYTES {
            bail!("provider registry tarball is too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    extract_registry_files(&bytes)
}

/// In-memory tarball extraction (also directly unit-tested with a synthetic
/// tarball). Corrupt members are skipped, never fatal; file count/size stays
/// bounded.
pub(crate) fn extract_registry_files(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| anyhow!("provider registry tarball is unreadable: {error}"))?;
    let mut files: Vec<(String, String)> = Vec::new();
    let mut total_bytes: u64 = 0;
    for entry in entries {
        let Ok(mut entry) = entry else {
            continue;
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let Ok(path) = entry.path() else {
            continue;
        };
        let path = path.to_string_lossy().replace('\\', "/");
        if !is_registry_file(&path) {
            continue;
        }
        let size = entry.size();
        if size > MAX_FILE_BYTES {
            continue;
        }
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_FILES_BYTES {
            break;
        }
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_err() {
            continue;
        }
        files.push((path, content));
    }
    Ok(files)
}

// ── cache ──────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Whether a cached catalog is still inside the TTL at a given wall clock.
/// A timestamp from the FUTURE (a clock that jumped, a hand-edited cache) is
/// not "fresh forever": past a small tolerance it is treated as expired so
/// the catalog refreshes instead of freezing.
fn is_fresh_at(registry: &ProviderRegistry, now_ms: u64) -> bool {
    if registry.fetched_at > now_ms.saturating_add(CLOCK_SKEW_TOLERANCE_MS) {
        return false;
    }
    now_ms.saturating_sub(registry.fetched_at) < CACHE_TTL_MS
}

fn is_fresh(registry: &ProviderRegistry) -> bool {
    is_fresh_at(registry, now_ms())
}

/// Load the cache from an explicit directory (production passes the app data
/// dir; tests pass a temp dir). Any unreadable/corrupt file answers None.
pub(crate) fn load_cache_from(dir: &Path) -> Option<ProviderRegistry> {
    let bytes = std::fs::read(dir.join(REGISTRY_FILE)).ok()?;
    let file: RegistryCacheFile = serde_json::from_slice(&bytes).ok()?;
    Some(ProviderRegistry {
        fetched_at: file.fetched_at,
        stale: false,
        providers: file.providers,
    })
}

/// Persist the catalog (stale is never written). Only the cache fields are
/// serialized.
pub(crate) fn save_cache_to(dir: &Path, registry: &ProviderRegistry) -> Result<()> {
    let file = RegistryCacheFile {
        fetched_at: registry.fetched_at,
        providers: registry.providers.clone(),
    };
    let json = serde_json::to_vec_pretty(&file)?;
    // Atomic publish (temp file + rename): a crash or a concurrent reader must
    // never see a half-written catalog. A rename onto the existing file is
    // atomic on every platform we ship.
    let target = dir.join(REGISTRY_FILE);
    let temp = dir.join(format!("{REGISTRY_FILE}.tmp"));
    std::fs::write(&temp, json)
        .map_err(|error| anyhow!("write provider registry cache: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        anyhow!("publish provider registry cache: {error}")
    })
}

fn cache_dir() -> Result<PathBuf> {
    paths::ensure_data_dir()
}

fn load_cache() -> Option<ProviderRegistry> {
    load_cache_from(&cache_dir().ok()?)
}

fn save_cache(registry: &ProviderRegistry) -> Result<()> {
    save_cache_to(&cache_dir()?, registry)
}

// ── fetch pipeline ─────────────────────────────────────────────────────────

/// Return the catalog, from cache when fresh (unless refresh), else by
/// downloading. A failed refresh degrades to the cached copy with stale = true;
/// with no cache the error is surfaced as a user-facing sentence.
pub(crate) async fn fetch_registry(refresh: bool) -> Result<ProviderRegistry> {
    if !refresh
        && let Some(cached) = load_cache()
        && is_fresh(&cached)
    {
        return Ok(cached);
    }

    // One network round trip at a time; a waiter re-checks the cache because
    // another caller may have filled it while this task was parked.
    let _gate = FETCH_GATE.lock().await;
    if !refresh
        && let Some(cached) = load_cache()
        && is_fresh(&cached)
    {
        return Ok(cached);
    }

    let url = registry_url();
    let fetched = async {
        let files = download_registry(&url).await?;
        let providers = parse_registry(&files);
        if providers.is_empty() {
            bail!("provider registry contained no usable providers");
        }
        Ok::<_, anyhow::Error>(ProviderRegistry {
            fetched_at: now_ms(),
            stale: false,
            providers,
        })
    }
    .await;

    match fetched {
        Ok(registry) => {
            // A cache write failure must not fail the answer itself.
            if let Err(error) = save_cache(&registry) {
                tracing::warn!(error = %error, "provider registry cache write failed");
            }
            Ok(registry)
        },
        Err(error) => serve_stale_cache(load_cache(), &error),
    }
}

/// Degrade a failed refresh to the cached catalog (stale = true) or the
/// user-facing unavailable sentence when there is no cache. Pure helper so
/// both branches are unit-tested without a network attempt.
fn serve_stale_cache(
    cached: Option<ProviderRegistry>,
    error: &anyhow::Error,
) -> Result<ProviderRegistry> {
    match cached {
        Some(mut cached) => {
            cached.stale = true;
            Ok(cached)
        },
        None => Err(anyhow!("provider registry unavailable — {error}")),
    }
}

/// The shared provider catalog for the settings page's preset selects.
///
/// refresh = false answers the cached catalog when it is younger than 24 h;
/// refresh = true always tries the network. On a failed refresh a cached copy
/// comes back with stale = true; no cache means the command rejects.
#[tauri::command]
pub async fn get_chat_provider_registry(refresh: bool) -> CommandResult<ProviderRegistry> {
    Ok(fetch_registry(refresh).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-chat-registry-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const ENTRY_OPENAI: &str = r#"
[entrypoint]
id = "deepseek_default"
provider_id = "deepseek"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "https://api.deepseek.com"
env_var = "DEEPSEEK_API_KEY"

[entrypoint.name]
en = "DeepSeek"
zhs = "深度求索"
zht = "深度求索"
ja = "DeepSeek"
ko = "DeepSeek"
fr = "DeepSeek"
es = "DeepSeek"
ru = "DeepSeek"

[entrypoint.defaults]
normal = "deepseek-flash"

[[entrypoint.models]]
id = "deepseek-flash"

[[entrypoint.models]]
id = "deepseek-v4-pro"
"#;

    fn file(path: &str, content: &str) -> (String, String) {
        (path.to_string(), content.to_string())
    }

    #[test]
    fn parse_keeps_openai_entries_and_localizes_the_names() {
        let providers = parse_registry(&[file(
            "provider-registry-master/entrypoint/deepseek/default.toml",
            ENTRY_OPENAI,
        )]);
        assert_eq!(providers.len(), 1);
        let provider = &providers[0];
        assert_eq!(provider.id, "deepseek_default");
        assert_eq!(provider.provider_id, "deepseek");
        assert_eq!(provider.names.en, "DeepSeek");
        assert_eq!(provider.names.zhs, "深度求索");
        assert_eq!(provider.names.ja, "DeepSeek");
        assert_eq!(provider.base_url, "https://api.deepseek.com");
        assert_eq!(provider.env_var.as_deref(), Some("DEEPSEEK_API_KEY"));
        assert_eq!(
            provider
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["deepseek-flash", "deepseek-v4-pro"]
        );

        // Missing languages fall back to English; a missing English name
        // falls back to the provider id.
        let minimal = r#"
[entrypoint]
id = "acme_default"
provider_id = "acme"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "https://api.acme.test/v1"

[entrypoint.name]
en = "Acme"

[[entrypoint.models]]
id = "acme-1"
"#;
        let providers = parse_registry(&[file(
            "provider-registry-master/entrypoint/acme/default.toml",
            minimal,
        )]);
        let provider = &providers[0];
        assert_eq!(provider.names.en, "Acme");
        assert_eq!(provider.names.zhs, "Acme");
        assert_eq!(provider.names.ru, "Acme");

        let unnamed = r#"
[entrypoint]
id = "bare_default"
provider_id = "bare"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "https://api.bare.test"
"#;
        let providers = parse_registry(&[file(
            "provider-registry-master/entrypoint/bare/default.toml",
            unnamed,
        )]);
        assert_eq!(providers[0].names.en, "bare");
        assert_eq!(providers[0].names.ja, "bare");
    }

    #[test]
    fn parse_filters_other_protocols_pseudo_providers_and_bad_urls() {
        let anthropic = r#"
[entrypoint]
id = "claude_default"
provider_id = "claude"

[entrypoint.api]
protocol = "anthropic_messages_v1"
base_url = "https://api.anthropic.test"
"#;
        let compatible = r#"
[entrypoint]
id = "openai_compatible"
provider_id = "openai_compatible"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "https://api.example.test/v1"
"#;
        let bad_url = r#"
[entrypoint]
id = "bad_default"
provider_id = "bad"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "ftp://api.bad.test"
"#;
        let blank_url = r#"
[entrypoint]
id = "blank_default"
provider_id = "blank"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "   "
"#;
        let providers = parse_registry(&[
            file("p/entrypoint/a/one.toml", ENTRY_OPENAI),
            file("p/entrypoint/claude/default.toml", anthropic),
            file("p/entrypoint/openai/default.toml", compatible),
            file("p/entrypoint/bad/default.toml", bad_url),
            file("p/entrypoint/blank/default.toml", blank_url),
        ]);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].provider_id, "deepseek");
    }

    fn entry_with_defaults(provider: &str, defaults: &str, models: &[&str]) -> String {
        let models = models
            .iter()
            .map(|id| format!("\n[[entrypoint.models]]\nid = \"{id}\"\n"))
            .collect::<String>();
        format!(
            r#"
[entrypoint]
id = "{provider}_default"
provider_id = "{provider}"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "https://api.{provider}.test"

[entrypoint.name]
en = "{provider}"

[entrypoint.defaults]
{defaults}
{models}
"#
        )
    }

    #[test]
    fn parse_default_model_prefers_normal_then_deep_then_basic_then_first() {
        let cases = [
            (
                "normal-model",
                "normal = \"normal-model\"\ndeep = \"deep-model\"",
                "normal-model",
            ),
            (
                "deep-model",
                "deep = \"deep-model\"\nbasic = \"basic-model\"",
                "deep-model",
            ),
            ("basic-model", "basic = \"basic-model\"", "basic-model"),
        ];
        for (tag, defaults, expected) in cases {
            let content = entry_with_defaults(tag, defaults, &["first-model"]);
            let providers =
                parse_registry(&[file(&format!("p/entrypoint/{tag}/default.toml"), &content)]);
            assert_eq!(
                providers[0].default_model.as_deref(),
                Some(expected),
                "defaults {defaults:?}"
            );
        }
        // No defaults at all falls back to the first listed model.
        let content = entry_with_defaults("fallback", "", &["a-model", "z-model"]);
        let providers = parse_registry(&[file("p/entrypoint/fallback/default.toml", &content)]);
        assert_eq!(providers[0].default_model.as_deref(), Some("a-model"));
    }

    #[test]
    fn parse_completes_model_names_from_the_metadata_files() {
        let metadata_a = "[model]\nname = \"Alpha Model\"\n";
        let metadata_z = "[model]\nname = \"Zeta Model\"\n";
        let entry = r#"
[entrypoint]
id = "meta_default"
provider_id = "meta"

[entrypoint.api]
protocol = "openai_chat_v1"
base_url = "https://api.meta.test"

[entrypoint.name]
en = "Meta"

[[entrypoint.models]]
id = "z-model"

[[entrypoint.models]]
id = "a-model"

[[entrypoint.models]]
id = "unknown-model"
"#;
        let providers = parse_registry(&[
            file("p/entrypoint/meta/default.toml", entry),
            file("p/models/meta/a-model.toml", metadata_a),
            file("p/models/meta/z-model.toml", metadata_z),
            file("p/models/meta/broken.toml", "not toml ["),
        ]);
        let provider = &providers[0];
        assert_eq!(
            provider.models,
            vec![
                ProviderRegistryModel {
                    id: "a-model".to_string(),
                    name: Some("Alpha Model".to_string()),
                },
                ProviderRegistryModel {
                    id: "unknown-model".to_string(),
                    name: None,
                },
                ProviderRegistryModel {
                    id: "z-model".to_string(),
                    name: Some("Zeta Model".to_string()),
                },
            ]
        );
    }

    #[test]
    fn parse_tolerates_missing_fields_and_garbage() {
        let providers = parse_registry(&[
            file("p/entrypoint/a/broken.toml", "not toml ["),
            file(
                "p/entrypoint/a/no-id.toml",
                "[entrypoint]\nprovider_id = \"x\"\n",
            ),
            file(
                "p/entrypoint/a/no-api.toml",
                "[entrypoint]\nid = \"no_api\"\nprovider_id = \"no_api\"\n",
            ),
            file(
                "p/entrypoint/a/bad-models.toml",
                "[entrypoint]\nid = \"bad_models\"\nprovider_id = \"bad_models\"\n[entrypoint.api]\nprotocol = \"openai_chat_v1\"\nbase_url = \"https://api.bad-models.test\"\n[entrypoint.models]\nnot = \"a list\"\n",
            ),
            file("README.md", "ignored"),
            file(
                "p/models/only-metadata/model.toml",
                "[model]\nname = \"Only\"\n",
            ),
            file("p/entrypoint/a/ok.toml", ENTRY_OPENAI),
        ]);
        // The bad-models file is still a USABLE entry (its non-array model
        // list just yields zero models); the rest are skipped entirely.
        assert_eq!(
            providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bad_models", "deepseek_default"]
        );
        assert!(providers[0].models.is_empty());
        assert!(providers[0].default_model.is_none());
    }

    #[test]
    fn parse_sorts_by_english_name() {
        let zeta = entry_with_defaults("zeta", "", &["m"]);
        let alpha = entry_with_defaults("alpha", "", &["m"]);
        let providers = parse_registry(&[
            file("p/entrypoint/zeta/default.toml", &zeta),
            file("p/entrypoint/alpha/default.toml", &alpha),
        ]);
        assert_eq!(
            providers
                .iter()
                .map(|provider| provider.names.en.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "zeta"]
        );
    }

    #[test]
    fn generation_entrypoints_are_not_chat_providers() {
        let entry = ENTRY_OPENAI.replace(
            "provider_id = \"deepseek\"",
            "provider_id = \"openai\"\ntype = \"generation\"",
        );
        let providers = parse_registry(&[file("p/entrypoint/openai/generation.toml", &entry)]);
        assert!(providers.is_empty(), "{providers:?}");
    }

    #[test]
    fn model_names_resolve_through_the_filesystem_sanitization() {
        // The registry names its metadata files with ':'→'-' and '/'→'_'.
        let entry = ENTRY_OPENAI.replace(
            "[[entrypoint.models]]\nid = \"deepseek-flash\"",
            "[[entrypoint.models]]\nid = \"gpt-5.4-pro:batch\"\n\n[[entrypoint.models]]\nid = \"deepseek-flash\"",
        );
        let providers = parse_registry(&[
            file("p/entrypoint/deepseek/default.toml", &entry),
            file(
                "p/models/deepseek/gpt-5.4-pro-batch.toml",
                "[model]\nname = \"GPT 5.4 Pro (batch)\"\n",
            ),
            file(
                "p/models/deepseek/deepseek-flash.toml",
                "[model]\nname = \"DeepSeek Flash\"\n",
            ),
        ]);
        assert_eq!(providers.len(), 1);
        let names: Vec<(String, Option<String>)> = providers[0]
            .models
            .iter()
            .map(|model| (model.id.clone(), model.name.clone()))
            .collect();
        assert!(names.contains(&(
            "gpt-5.4-pro:batch".to_string(),
            Some("GPT 5.4 Pro (batch)".to_string())
        )));
        assert!(names.contains(&(
            "deepseek-flash".to_string(),
            Some("DeepSeek Flash".to_string())
        )));
    }

    fn tarball(files: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, content) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(u64::try_from(content.len()).unwrap());
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, path, content.as_bytes())
                .unwrap();
        }
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn extract_keeps_only_the_parser_files() {
        let bundle = tarball(&[
            (
                "registry-master/entrypoint/deepseek/default.toml",
                ENTRY_OPENAI,
            ),
            (
                "registry-master/models/deepseek/deepseek-flash.toml",
                "[model]\nname = \"Flash\"\n",
            ),
            ("registry-master/README.md", "# registry"),
            ("registry-master/providers/deepseek.toml", "[x]"),
        ]);
        let files = extract_registry_files(&bundle).unwrap();
        let paths: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "registry-master/entrypoint/deepseek/default.toml",
                "registry-master/models/deepseek/deepseek-flash.toml",
            ]
        );
        assert_eq!(files[0].1, ENTRY_OPENAI);
        // A re-packed mirror whose archive ROOT is the repository (no leading
        // packaging directory) is a valid override target, not garbage.
        let mirror = tarball(&[
            ("entrypoint/deepseek/default.toml", ENTRY_OPENAI),
            (
                "models/deepseek/deepseek-flash.toml",
                "[model]\nname = \"Flash\"\n",
            ),
        ]);
        let mirror_files = extract_registry_files(&mirror).unwrap();
        assert_eq!(mirror_files.len(), 2);
        let providers = parse_registry(&mirror_files);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].base_url, "https://api.deepseek.com");
        // Garbage bytes are tolerated (empty extraction, no panic).
        assert!(
            extract_registry_files(b"not a gzip tarball")
                .unwrap_or_default()
                .is_empty()
        );
    }

    #[test]
    fn cache_round_trips_and_serializes_camel_case() {
        let dir = temp_dir("cache");
        let registry = ProviderRegistry {
            fetched_at: 1_760_000_000_000,
            stale: false,
            providers: vec![ProviderRegistryEntry {
                id: "deepseek_default".to_string(),
                provider_id: "deepseek".to_string(),
                names: ProviderRegistryNames {
                    en: "DeepSeek".to_string(),
                    zhs: "深度求索".to_string(),
                    zht: "深度求索".to_string(),
                    ja: "DeepSeek".to_string(),
                    ko: "DeepSeek".to_string(),
                    fr: "DeepSeek".to_string(),
                    es: "DeepSeek".to_string(),
                    ru: "DeepSeek".to_string(),
                },
                base_url: "https://api.deepseek.com".to_string(),
                env_var: Some("DEEPSEEK_API_KEY".to_string()),
                default_model: Some("deepseek-flash".to_string()),
                models: vec![ProviderRegistryModel {
                    id: "deepseek-flash".to_string(),
                    name: Some("DeepSeek Flash".to_string()),
                }],
            }],
        };
        save_cache_to(&dir, &registry).unwrap();
        let loaded = load_cache_from(&dir).expect("cache loads");
        assert_eq!(loaded, registry);

        let text = std::fs::read_to_string(dir.join(REGISTRY_FILE)).unwrap();
        assert!(text.contains("\"fetchedAt\": 1760000000000"));
        assert!(text.contains("\"providerId\""));
        assert!(text.contains("\"baseUrl\""));
        assert!(text.contains("\"envVar\""));
        assert!(text.contains("\"defaultModel\""));
        assert!(!text.contains("\"stale\""), "stale is transient");

        // The wire shape serializes camelCase.
        let value = serde_json::to_value(&registry).unwrap();
        assert_eq!(value["fetchedAt"], 1_760_000_000_000u64);
        assert_eq!(value["stale"], false);
        assert_eq!(value["providers"][0]["providerId"], "deepseek");
        assert_eq!(value["providers"][0]["baseUrl"], "https://api.deepseek.com");
        assert_eq!(value["providers"][0]["envVar"], "DEEPSEEK_API_KEY");
        assert_eq!(value["providers"][0]["defaultModel"], "deepseek-flash");
        assert_eq!(value["providers"][0]["names"]["zhs"], "深度求索");
        assert_eq!(value["providers"][0]["models"][0]["id"], "deepseek-flash");
        assert_eq!(value["providers"][0]["models"][0]["name"], "DeepSeek Flash");

        // A corrupt/absent cache answers None instead of failing.
        std::fs::write(dir.join(REGISTRY_FILE), "{not json").unwrap();
        assert!(load_cache_from(&dir).is_none());
        std::fs::remove_file(dir.join(REGISTRY_FILE)).unwrap();
        assert!(load_cache_from(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn freshness_uses_the_24h_ttl() {
        let registry = ProviderRegistry {
            fetched_at: 1_000_000,
            stale: false,
            providers: Vec::new(),
        };
        assert!(is_fresh_at(&registry, 1_000_000));
        assert!(is_fresh_at(&registry, 1_000_000 + CACHE_TTL_MS - 1));
        assert!(!is_fresh_at(&registry, 1_000_000 + CACHE_TTL_MS));
        // A clock that went backwards a little still treats the cache as fresh
        // (jitter tolerance)...
        assert!(is_fresh_at(&registry, 1_000_000 - CLOCK_SKEW_TOLERANCE_MS));
        // ...but a timestamp far in the future is NOT fresh forever: it must
        // refresh instead of freezing the catalog.
        assert!(!is_fresh_at(
            &registry,
            1_000_000 - CLOCK_SKEW_TOLERANCE_MS - 1
        ));
    }

    #[test]
    fn failed_refresh_degrades_to_the_cached_catalog() {
        let cached = ProviderRegistry {
            fetched_at: 42,
            stale: false,
            providers: vec![ProviderRegistryEntry {
                id: "deepseek_default".to_string(),
                provider_id: "deepseek".to_string(),
                base_url: "https://api.deepseek.com".to_string(),
                ..ProviderRegistryEntry::default()
            }],
        };
        let error = anyhow!("boom");
        let stale = serve_stale_cache(Some(cached.clone()), &error).expect("cache serves");
        assert!(stale.stale);
        assert_eq!(stale.fetched_at, 42);
        assert_eq!(stale.providers, cached.providers);

        // No cache: the user-facing unavailable sentence carries the reason.
        let missing = serve_stale_cache(None, &error).unwrap_err();
        assert!(
            missing
                .to_string()
                .contains("provider registry unavailable"),
            "{missing}"
        );
    }

    #[test]
    fn registry_url_reads_the_env_override() {
        assert_eq!(resolve_registry_url(None), REGISTRY_TARBALL_URL);
        assert_eq!(resolve_registry_url(Some("   ")), REGISTRY_TARBALL_URL);
        assert_eq!(
            resolve_registry_url(Some(" https://mirror.example.test/registry.tar.gz ")),
            "https://mirror.example.test/registry.tar.gz"
        );
        // The live reader honors the same override without touching the
        // network; without the variable it is the codeload default.
        let from_env = std::env::var(REGISTRY_URL_ENV).ok();
        match from_env.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => assert_eq!(registry_url(), value),
            _ => assert_eq!(registry_url(), REGISTRY_TARBALL_URL),
        }
    }
}
