//! Global outbound network proxy configuration.
//!
//! Every HTTP request WoWSP makes (WG API stats lookups, ship encyclopedia,
//! model pack downloads, update checks) is built by build_http_client, so
//! the Settings -> Network choice applies globally:
//!
//!   system  follow the OS proxy settings (env vars, then WinINET)
//!   none    connect directly, ignore any proxy
//!   manual  always use one fixed proxy URL (e.g. http://127.0.0.1:7890)
//!
//! PERSISTENCE (see `settings_store` for the shared policy): a flat TOML
//! file `network-config.toml` under the appdata root. `mode` is a real enum
//! now — an invalid value (typo, removed option, hand edit) deserializes to
//! [`ProxyMode::Unknown`] and is sanitized onto the current-version default
//! (`system`), and the corrected value is FORCED back to disk so the fix
//! sticks instead of silently re-applying every boot. Upgrades from the
//! pre-TOML build find their old `network-config.json`, parse it once, and
//! rewrite it as TOML (the legacy file is deleted only after the TOML write
//! succeeded).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths;
use crate::settings_store::{self, SettingsSource};

pub const NETWORK_CONFIG_FILE: &str = "network-config.toml";
/// Pre-TOML persistence of the same settings — read once, then retired.
const LEGACY_NETWORK_CONFIG_FILE: &str = "network-config.json";

/// Header prepended to the canonical file so a user opening it finds the
/// valid values spelled out. Part of the canonical text (the heal-write
/// comparison in [`load_config_from`] includes it), so hand-removed comments
/// come back on the next corrective write — that is fine.
const FILE_HEADER: &str = "# WoWSP network settings. mode = \"system\" | \"none\" | \"manual\".\n\
                           # Invalid values are reset to the defaults by the app.\n";

/// The proxy strategy. Deserialized everywhere a `mode` string arrives (the
/// TOML/JSON file, the `set_network_config` IPC) so a bad value can never
/// fail a load: serde maps anything unrecognized onto `Unknown`, which
/// [`sanitize`] then resolves to the default. `Unknown` is never persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyMode {
    System,
    None,
    Manual,
    /// Any unrecognized value (typo, removed future option, hand edit).
    /// Sanitizes to [`ProxyMode::System`] before the config is used or saved.
    #[serde(other)]
    Unknown,
}

/// Proxy mode + optional manual URL. Mirrored by the webui NetworkConfig
/// (camelCase field names — the IPC shape doubles as the TOML key set so
/// there is exactly one spelling to keep in sync).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub mode: ProxyMode,
    /// Manual proxy URL, only consulted when mode == "manual".
    #[serde(default)]
    pub proxy: Option<String>,
    /// Mirror base for remote resources (ship portraits etc.). Empty →
    /// the official Wargaming CDN. See commands/media.rs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_cdn: Option<String>,
    /// ghproxy-style mirror prefix for GitHub downloads (resource packs,
    /// mod catalog). Empty → direct GitHub, with the built-in mirror set as
    /// fallback only. See commands/model_pack.rs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_mirror: Option<String>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            mode: ProxyMode::System,
            proxy: None,
            resource_cdn: None,
            github_mirror: None,
        }
    }
}

/// Trim a free-form URL-ish field; `None` for anything empty. URL fields the
/// app must be able to FETCH from additionally require a scheme — a value
/// without one could never produce a working request, so the field resets to
/// its default (direct WG CDN / mirror ladder).
fn sanitize_url_field(
    value: Option<String>,
    field: &'static str,
    require_scheme: bool,
) -> Option<String> {
    let trimmed = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    match trimmed {
        Some(v) if require_scheme && !looks_like_url(&v) => {
            tracing::warn!("network config: ignoring invalid {field} {v:?} (no usable URL scheme)");
            None
        },
        other => other,
    }
}

/// Scheme check that deliberately stays shallow: `http://`, `https://` (and
/// `socks5://`/`socks5h://` for the manual proxy, which reqwest supports),
/// matched case-insensitively. Full URL validation belongs to the HTTP
/// stack; this only filters values that can never work.
fn looks_like_url(value: &str) -> bool {
    let Some((scheme, _rest)) = value.split_once("://") else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "socks5" | "socks5h"
    ) && !value.chars().any(char::is_whitespace)
}

/// The fallback layer proper: resolve every invalid field onto the
/// current-version default. Runs on EVERY load and before EVERY save, so
/// neither the on-disk file nor the webui can smuggle a broken config past
/// this point.
pub fn sanitize(mut config: NetworkConfig) -> NetworkConfig {
    if config.mode == ProxyMode::Unknown {
        tracing::warn!("network config: unknown proxy mode, resetting to \"system\"");
        config.mode = ProxyMode::System;
    }
    config.proxy = sanitize_url_field(config.proxy, "proxy", true);
    config.resource_cdn = sanitize_url_field(config.resource_cdn, "resourceCdn", true);
    config.github_mirror = sanitize_url_field(config.github_mirror, "githubMirror", true);
    // "manual" without a usable URL would silently mean "no proxy at all"
    // — the safest reading of a half-broken manual config is the default.
    if config.mode == ProxyMode::Manual && config.proxy.is_none() {
        tracing::warn!("network config: manual mode without a proxy URL, resetting to \"system\"");
        config.mode = ProxyMode::System;
    }
    config
}

/// The on-disk shape. A dedicated file struct (not the IPC struct) so the
/// TOML writer can skip `None` fields — `toml` cannot serialize a bare null,
/// while the IPC JSON keeps `proxy: null` for the frontend's exact shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkConfigTomlFile {
    mode: ProxyMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource_cdn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    github_mirror: Option<String>,
}

/// Serialize the canonical file text (header + flat TOML keys).
fn canonical_toml(config: &NetworkConfig) -> Result<String, String> {
    let file = NetworkConfigTomlFile {
        mode: config.mode,
        proxy: config.proxy.clone(),
        resource_cdn: config.resource_cdn.clone(),
        github_mirror: config.github_mirror.clone(),
    };
    let body = toml::to_string(&file).map_err(|e| format!("serialize network config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// Load the persisted config; falls back to system-proxy defaults.
pub fn load_config() -> NetworkConfig {
    match paths::ensure_data_dir() {
        Ok(dir) => load_config_from(&dir),
        Err(_) => NetworkConfig::default(),
    }
}

/// Testable core of [`load_config`]: read (TOML first, legacy JSON second),
/// sanitize, and heal-write whenever the disk does not already hold the
/// canonical text — the migration and the invalid-value correction are the
/// same code path by design.
fn load_config_from(dir: &Path) -> NetworkConfig {
    let loaded = settings_store::load_raw(dir, NETWORK_CONFIG_FILE, LEGACY_NETWORK_CONFIG_FILE);
    let Some(raw) = loaded.raw else {
        return NetworkConfig::default();
    };
    // One tolerant parser per source format; a parse failure is just another
    // flavor of "invalid config" and lands on the defaults below.
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<NetworkConfig>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<NetworkConfig>(&raw).ok()
        },
    };
    let config = sanitize(parsed.unwrap_or_default());
    if let Ok(canonical) = canonical_toml(&config) {
        settings_store::heal(
            dir,
            NETWORK_CONFIG_FILE,
            LEGACY_NETWORK_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    config
}

/// Config as returned to the webui, with the OS proxy pre-resolved so the
/// frontend can pass it to plugins (e.g. the updater) that accept a proxy URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfigResponse {
    pub mode: ProxyMode,
    pub proxy: Option<String>,
    pub resource_cdn: Option<String>,
    pub github_mirror: Option<String>,
    pub effective_proxy: Option<String>,
}

impl From<NetworkConfig> for NetworkConfigResponse {
    fn from(cfg: NetworkConfig) -> Self {
        let effective_proxy = effective_proxy(&cfg);
        Self {
            mode: cfg.mode,
            proxy: cfg.proxy,
            resource_cdn: cfg.resource_cdn,
            github_mirror: cfg.github_mirror,
            effective_proxy,
        }
    }
}

#[tauri::command]
pub fn get_network_config() -> Result<NetworkConfigResponse, String> {
    Ok(load_config().into())
}

/// Persist the config and return the SANITIZED result actually stored. The
/// return value matters: sanitize may correct the payload (unknown mode,
/// scheme-less URL, manual-without-proxy → system), and the settings UI
/// re-syncs from this response so what the user SEES is what every HTTP
/// client now uses — a silent correction would leave the UI claiming a
/// proxy that is not in effect.
#[tauri::command]
pub fn set_network_config(config: NetworkConfig) -> Result<NetworkConfigResponse, String> {
    // Sanitize BEFORE persisting: the file only ever holds valid values, so
    // a bogus IPC payload self-corrects instead of poisoning every later
    // load (which would sanitize it anyway — belt and suspenders).
    let config = sanitize(config);
    let dir = paths::ensure_data_dir()?;
    let canonical = canonical_toml(&config)?;
    settings_store::store(&dir, NETWORK_CONFIG_FILE, &canonical)?;
    settings_store::retire_legacy_json(&dir, LEGACY_NETWORK_CONFIG_FILE);
    Ok(config.into())
}

/// Resolve the proxy URL the config selects. "none" yields None (direct);
/// "system" consults the OS settings; "manual" uses the pinned URL.
pub fn effective_proxy(config: &NetworkConfig) -> Option<String> {
    match config.mode {
        ProxyMode::None => None,
        ProxyMode::Manual => config
            .proxy
            .clone()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty()),
        // System (and Unknown, if an unsanitized config ever reaches here —
        // the OS proxy is the safest reading of "we don't know").
        ProxyMode::System | ProxyMode::Unknown => system_proxy(),
    }
}

/// OS proxy detection: env vars first (tools commonly override WinINET with
/// HTTP_PROXY/HTTPS_PROXY), then the Windows registry (WinINET).
fn system_proxy() -> Option<String> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    wininet_proxy()
}

#[cfg(windows)]
fn wininet_proxy() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    // WinINET: "host:port" or per-scheme "http=...;https=...;ftp=...".
    let pick = |scheme: &str| {
        server
            .split(';')
            .find(|s| s.trim_start().starts_with(scheme))
            .and_then(|s| s.split_once('=').map(|x| x.1))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let raw = pick("https=")
        .or_else(|| pick("http="))
        .unwrap_or_else(|| server.trim().to_string());
    if raw.is_empty() {
        return None;
    }
    let url = if raw.contains("://") {
        raw
    } else {
        format!("http://{raw}")
    };
    Some(url)
}

#[cfg(not(windows))]
fn wininet_proxy() -> Option<String> {
    None
}

/// Build a reqwest client builder honoring the persisted network config.
/// All outbound HTTP in the app goes through here so the Settings -> Network
/// choice is truly global. Callers that need a client-level timeout (small
/// JSON lookups) apply it on the returned builder before build(). Connect
/// gets a global ceiling so a dead host can never stall a lookup forever —
/// per-request bodies set their own `.timeout()` where it matters.
pub fn http_client_builder() -> Result<reqwest::ClientBuilder, String> {
    let config = load_config();
    let mut builder = reqwest::Client::builder()
        .user_agent("WoWSP/0.1 (https://github.com/langyo/wowsp)")
        .connect_timeout(std::time::Duration::from_secs(15));
    if let Some(url) = effective_proxy(&config) {
        let mut proxy =
            reqwest::Proxy::all(url.clone()).map_err(|e| format!("proxy {url}: {e}"))?;
        // Loopback targets (locally served update artifacts, dev mirrors)
        // must never ride the proxy — several proxies refuse or mangle
        // requests back to the very machine they run on.
        proxy = proxy.no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1"));
        builder = builder.proxy(proxy);
    } else if config.mode == ProxyMode::None {
        builder = builder.no_proxy();
    }
    Ok(builder)
}

/// Convenience: build the proxy-aware client right away.
pub fn build_http_client() -> Result<reqwest::Client, String> {
    http_client_builder()?
        .build()
        .map_err(|e| format!("http client: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-network-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A legacy JSON config migrates to canonical TOML on load, and the
    /// legacy file is retired only after the TOML write succeeded.
    #[test]
    fn migrates_legacy_json_to_toml() {
        let dir = temp_dir("migrate");
        std::fs::write(
            dir.join(LEGACY_NETWORK_CONFIG_FILE),
            r#"{"mode":"manual","proxy":"http://127.0.0.1:7890"}"#,
        )
        .unwrap();

        let cfg = load_config_from(&dir);
        assert_eq!(cfg.mode, ProxyMode::Manual);
        assert_eq!(cfg.proxy.as_deref(), Some("http://127.0.0.1:7890"));

        let toml_text = std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE)).unwrap();
        assert!(toml_text.contains("mode = \"manual\""));
        assert!(!dir.join(LEGACY_NETWORK_CONFIG_FILE).exists());

        // Second load: canonical file → no rewrite, same values.
        let again = load_config_from(&dir);
        assert_eq!(again, cfg);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An invalid mode (typo / removed value) heals onto the default AND the
    /// corrected value is forced back to disk — the bad value never survives
    /// a boot.
    #[test]
    fn invalid_mode_is_reset_and_healed() {
        let dir = temp_dir("invalid-mode");
        std::fs::write(
            dir.join(LEGACY_NETWORK_CONFIG_FILE),
            r#"{"mode":"maunal","proxy":"http://127.0.0.1:7890"}"#,
        )
        .unwrap();

        let cfg = load_config_from(&dir);
        assert_eq!(cfg.mode, ProxyMode::System);
        // The valid manual URL is retained (mode is the only thing that was
        // broken) — flipping the mode back to manual later finds it intact.
        assert_eq!(cfg.proxy.as_deref(), Some("http://127.0.0.1:7890"));
        let toml_text = std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE)).unwrap();
        assert!(toml_text.contains("mode = \"system\""));
        assert!(!toml_text.contains("maunal"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unknown mode inside the canonical TOML file heals exactly like the
    /// legacy-JSON flavor — reset to the default and forced back to disk.
    #[test]
    fn invalid_mode_in_toml_is_reset_and_healed() {
        let dir = temp_dir("invalid-mode-toml");
        std::fs::write(
            dir.join(NETWORK_CONFIG_FILE),
            "mode = \"maunal\"
",
        )
        .unwrap();
        let cfg = load_config_from(&dir);
        assert_eq!(cfg.mode, ProxyMode::System);
        assert!(
            !std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE))
                .unwrap()
                .contains("maunal"),
            "the corrected value is forced back to disk"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Garbage TOML → defaults, healed file. A canonical file parses back
    /// unchanged (steady state: no rewrite).
    #[test]
    fn garbage_toml_falls_back_to_defaults() {
        let dir = temp_dir("garbage");
        std::fs::write(dir.join(NETWORK_CONFIG_FILE), "not toml at all [").unwrap();
        let cfg = load_config_from(&dir);
        assert_eq!(cfg, NetworkConfig::default());
        let healed = std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE)).unwrap();
        assert_eq!(healed, canonical_toml(&NetworkConfig::default()).unwrap());

        // Steady state: loading the just-healed file keeps it byte-identical.
        let before = std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE)).unwrap();
        let _ = load_config_from(&dir);
        let after = std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE)).unwrap();
        assert_eq!(before, after);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Field sanitization: whitespace-only URLs drop to None, scheme-less
    /// URLs drop to None, manual-without-proxy resets to system, and a
    /// scheme-less CDN does not survive a save.
    #[test]
    fn sanitize_drops_unusable_urls_and_half_manual() {
        let mut cfg = sanitize(NetworkConfig {
            mode: ProxyMode::Manual,
            proxy: Some("   ".into()),
            resource_cdn: Some("example.com/cdn".into()),
            github_mirror: Some("  https://mirror.example/  ".into()),
        });
        assert_eq!(cfg.mode, ProxyMode::System, "manual without proxy → system");
        assert_eq!(cfg.resource_cdn, None);
        assert_eq!(
            cfg.github_mirror.as_deref(),
            Some("https://mirror.example/")
        );

        cfg = sanitize(NetworkConfig {
            mode: ProxyMode::Manual,
            proxy: Some("socks5://127.0.0.1:1080".into()),
            ..NetworkConfig::default()
        });
        assert_eq!(cfg.mode, ProxyMode::Manual);
        assert_eq!(cfg.proxy.as_deref(), Some("socks5://127.0.0.1:1080"));
    }

    /// The mode enum round-trips through serde in every direction the app
    /// uses it (IPC JSON, TOML file), with unknowns collapsing to Unknown.
    #[test]
    fn proxy_mode_serde_round_trip() {
        let json = serde_json::from_str::<NetworkConfig>(r#"{"mode":"none"}"#).unwrap();
        assert_eq!(json.mode, ProxyMode::None);
        let bad = serde_json::from_str::<NetworkConfig>(r#"{"mode":"banana"}"#).unwrap();
        assert_eq!(bad.mode, ProxyMode::Unknown);
        let toml_cfg = toml::from_str::<NetworkConfig>("mode = \"manual\"\n").unwrap();
        assert_eq!(toml_cfg.mode, ProxyMode::Manual);
        assert_eq!(
            serde_json::to_value(ProxyMode::Manual).unwrap(),
            serde_json::json!("manual")
        );
    }
}
