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
//! The config is persisted to AppData (network-config.json) like the other
//! user settings.

use serde::{Deserialize, Serialize};

use crate::paths;

pub const NETWORK_CONFIG_FILE: &str = "network-config.json";

/// Proxy mode + optional manual URL. Mirrored by the webui NetworkConfig.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    /// "system" | "none" | "manual".
    pub mode: String,
    /// Manual proxy URL, only consulted when mode == "manual".
    pub proxy: Option<String>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            mode: "system".to_string(),
            proxy: None,
        }
    }
}

/// Load the persisted config; falls back to system-proxy defaults.
pub fn load_config() -> NetworkConfig {
    let Ok(dir) = paths::ensure_data_dir() else {
        return NetworkConfig::default();
    };
    std::fs::read_to_string(dir.join(NETWORK_CONFIG_FILE))
        .ok()
        .and_then(|r| serde_json::from_str::<NetworkConfig>(&r).ok())
        .unwrap_or_default()
}

/// Config as returned to the webui, with the OS proxy pre-resolved so the
/// frontend can pass it to plugins (e.g. the updater) that accept a proxy URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfigResponse {
    pub mode: String,
    pub proxy: Option<String>,
    pub effective_proxy: Option<String>,
}

#[tauri::command]
pub fn get_network_config() -> Result<NetworkConfigResponse, String> {
    let cfg = load_config();
    let effective_proxy = effective_proxy(&cfg);
    Ok(NetworkConfigResponse {
        mode: cfg.mode,
        proxy: cfg.proxy,
        effective_proxy,
    })
}

#[tauri::command]
pub fn set_network_config(config: NetworkConfig) -> Result<(), String> {
    let dir = paths::ensure_data_dir()?;
    let path = dir.join(NETWORK_CONFIG_FILE);
    let tmp = dir.join(format!("{NETWORK_CONFIG_FILE}.tmp"));
    let json = serde_json::to_string(&config).map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&tmp, json).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))?;
    Ok(())
}

/// Resolve the proxy URL the config selects. "none" yields None (direct);
/// "system" consults the OS settings; "manual" uses the pinned URL.
pub fn effective_proxy(config: &NetworkConfig) -> Option<String> {
    match config.mode.as_str() {
        "none" => None,
        "manual" => config
            .proxy
            .clone()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty()),
        _ => system_proxy(),
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
/// JSON lookups) apply it on the returned builder before build().
pub fn http_client_builder() -> Result<reqwest::ClientBuilder, String> {
    let config = load_config();
    let mut builder =
        reqwest::Client::builder().user_agent("WoWSP/0.1 (https://github.com/langyo/wowsp)");
    if let Some(url) = effective_proxy(&config) {
        builder = builder
            .proxy(reqwest::Proxy::all(url.clone()).map_err(|e| format!("proxy {url}: {e}"))?);
    } else if config.mode == "none" {
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
