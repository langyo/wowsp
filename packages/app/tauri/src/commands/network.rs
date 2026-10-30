//! Global outbound network proxy configuration.
//!
//! Every HTTP request WoWSP makes (WG API stats lookups, ship encyclopedia,
//! model pack downloads, update checks) rides a client built here — the
//! [`HttpPair`] twins or [`build_direct_http_client`] — so the
//! Settings -> Network choice applies globally:
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

use anyhow::anyhow;
use std::path::Path;

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

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

/// Audit wowsp-R1-1 (residual hardening): the `github_mirror` setting
/// fronts the installer download channel. The Ed25519-signed digest
/// verification (#1076/#1079) already prevents a tampered installer
/// from ever spawning; rejecting plaintext `http://` mirrors removes
/// the remaining MITM DoS surface (garbage bytes → digest mismatch →
/// blocked update with confusing errors).
fn looks_like_https_mirror(value: &str) -> bool {
    value.starts_with("https://") && !value.chars().any(char::is_whitespace)
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
    // Audit wowsp-R1-1: the mirror fronts the installer channel —
    // https only (see looks_like_https_mirror).
    config.github_mirror = config
        .github_mirror
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && looks_like_https_mirror(v))
        .map(str::to_string)
        .or_else(|| {
            if let Some(v) = config.github_mirror.as_deref() {
                tracing::warn!(
                    "network config: ignoring non-https githubMirror {v:?} \
                     (installer channel requires https)"
                );
            }
            None
        });
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
fn canonical_toml(config: &NetworkConfig) -> anyhow::Result<String> {
    let file = NetworkConfigTomlFile {
        mode: config.mode,
        proxy: config.proxy.clone(),
        resource_cdn: config.resource_cdn.clone(),
        github_mirror: config.github_mirror.clone(),
    };
    let body = toml::to_string(&file).map_err(|e| anyhow!("serialize network config: {e}"))?;
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
pub fn get_network_config() -> CommandResult<NetworkConfigResponse> {
    Ok(load_config().into())
}

/// Persist the config and return the SANITIZED result actually stored. The
/// return value matters: sanitize may correct the payload (unknown mode,
/// scheme-less URL, manual-without-proxy → system), and the settings UI
/// re-syncs from this response so what the user SEES is what every HTTP
/// client now uses — a silent correction would leave the UI claiming a
/// proxy that is not in effect.
#[tauri::command]
pub fn set_network_config(config: NetworkConfig) -> CommandResult<NetworkConfigResponse> {
    // Sanitize BEFORE persisting: the file only ever holds valid values, so
    // a bogus IPC payload self-corrects instead of poisoning every later
    // load (which would sanitize it anyway — belt and suspenders).
    let config = sanitize(config);
    // Mode only — a manual proxy URL may embed credentials.
    tracing::info!(mode = ?config.mode, "network config saved");
    // ensure_data_dir / store are anyhow errors now — `?` flows verbatim.
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

/// Review M-5, pure core of the redirect policy above: a hop is allowed
/// when its TARGET scheme is https (or anything non-plain), and plain
/// http only toward a loopback host (dev mirrors). The scheme history is
/// deliberately ignored — an http→http chain is the caller's original
/// choice; the gate exists to stop an https session being bounced onto
/// cleartext.
fn redirect_hop_allowed(url: &reqwest::Url) -> Result<(), &'static str> {
    if url.scheme() != "http" {
        return Ok(());
    }
    let host = url.host_str().unwrap_or("");
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]";
    if loopback {
        Ok(())
    } else {
        Err("redirect refused: plain-http hop off loopback")
    }
}

/// Build a reqwest client builder honoring the persisted network config.
/// All outbound HTTP in the app goes through here so the Settings -> Network
/// choice is truly global. Callers that need a client-level timeout (small
/// JSON lookups) apply it on the returned builder before build(). Connect
/// gets a global ceiling so a dead host can never stall a lookup forever —
/// per-request bodies set their own `.timeout()` where it matters.
pub fn http_client_builder() -> anyhow::Result<reqwest::ClientBuilder> {
    let config = load_config();
    http_builder_for(&config)
}

/// [`http_client_builder`] against an explicit config — the testable core
/// and the builder [`HttpPair::build`] shares so one config load feeds both
/// clients of a pair.
fn http_builder_for(config: &NetworkConfig) -> anyhow::Result<reqwest::ClientBuilder> {
    let mut builder = reqwest::Client::builder()
        .user_agent("WoWSP/0.1 (https://github.com/langyo/wowsp)")
        .connect_timeout(std::time::Duration::from_secs(15))
        // Audit M-5d + review M-5: follow redirects with a bounded chain
        // (reqwest's default is no redirect handling — an error — which
        // breaks legitimate mirrors), and REFUSE a scheme downgrade: an
        // https origin 302-ing to http strips TLS exactly when the
        // client believed it had it. Plain-http hops stay legal only
        // toward a loopback target (dev mirrors); everything else must
        // stay https (or start plain and stay plain — the policy gates
        // the hop's TARGET scheme, not the chain's history).
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("redirect chain too long");
            }
            match redirect_hop_allowed(attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(reason) => attempt.error(reason),
            }
        }));
    // Android has no SChannel/native-tls, so reqwest builds on rustls there
    // — and reqwest 0.13's rustls support defaults its verifier to
    // rustls-platform-verifier, whose Android backend is JVM Kotlin glue we
    // do not ship. tls_certs_only() switches the verifier to a plain
    // webpki RootCertStore over the bundled Mozilla CA bundle instead (the
    // same trust set the webpki-roots crate compiles in). Desktop keeps its
    // SChannel path untouched.
    #[cfg(target_os = "android")]
    {
        builder = builder.tls_certs_only(android_tls_roots()?);
    }
    if let Some(url) = effective_proxy(config) {
        let mut proxy =
            reqwest::Proxy::all(url.clone()).map_err(|e| anyhow!("proxy {url}: {e}"))?;
        // Loopback targets (locally served update artifacts, dev mirrors)
        // must never ride the proxy — several proxies refuse or mangle
        // requests back to the very machine they run on — and neither
        // must the RFC1918/link-local private ranges: they carry LAN
        // pairing traffic, whose peer is a phone on the same Wi-Fi,
        // never something the user's outbound proxy could reach.
        proxy = proxy.no_proxy(reqwest::NoProxy::from_string(
            "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16",
        ));
        builder = builder.proxy(proxy);
    } else if config.mode == ProxyMode::None {
        builder = builder.no_proxy();
    }
    Ok(builder)
}

/// A deliberately direct client: the persisted proxy policy is bypassed
/// entirely (no configured proxy, no system detection). LAN pairing is
/// the canonical caller — a phone on the same Wi-Fi is unreachable
/// through the user's outbound proxy; the private-range no_proxy entries
/// in http_builder_for are belt-and-braces on top of this, not the only
/// guard.
pub fn build_direct_http_client() -> anyhow::Result<reqwest::Client> {
    http_client_builder()?
        .no_proxy()
        .build()
        .map_err(|e| anyhow!("direct http client: {e}"))
}

/// A proxy-honoring client plus its always-direct twin — the unit the
/// stats-family transports ride (see
/// `upstream_health::get_with_fallback`): the configured policy drives the
/// primary client exactly as the single client it replaces did, and when a
/// proxy is actually in effect a transport-level failure degrades to one
/// attempt over the direct twin before the request fails for good. With no
/// proxy in effect the twins are equivalent and the pair adds nothing.
/// Clone is cheap (both clients are internally Arc'd) — fan-out sites clone
/// the pair per task exactly like they cloned bare clients before.
#[derive(Clone)]
pub struct HttpPair {
    proxied: reqwest::Client,
    direct: reqwest::Client,
    /// Whether the configured policy actually routes the primary client
    /// through a proxy — the fallback arm only makes sense then.
    has_proxy: bool,
}

impl HttpPair {
    /// Build both clients from one configuration closure and the persisted
    /// network config. The closure applies the family's UA/timeout settings
    /// to each builder; it must stay `Copy` because both twins run through
    /// it.
    pub fn build(
        configure: impl FnOnce(reqwest::ClientBuilder) -> reqwest::ClientBuilder + Copy,
    ) -> anyhow::Result<Self> {
        let config = load_config();
        Self::build_with(&config, configure)
    }

    /// [`build`]'s testable core: an explicit config instead of the
    /// persisted one. The builder is reconstructed per client (reqwest's
    /// `ClientBuilder` is not `Clone`) — a cheap config transform.
    fn build_with(
        config: &NetworkConfig,
        configure: impl FnOnce(reqwest::ClientBuilder) -> reqwest::ClientBuilder + Copy,
    ) -> anyhow::Result<Self> {
        let proxied = configure(http_builder_for(config)?)
            .build()
            .map_err(|e| anyhow!("http client: {e}"))?;
        // no_proxy() both clears the policy proxy the base may carry and
        // disables system-proxy detection — the twin is direct by
        // construction, whatever the environment says.
        let direct = configure(http_builder_for(config)?)
            .no_proxy()
            .build()
            .map_err(|e| anyhow!("http client: {e}"))?;
        Ok(Self {
            proxied,
            direct,
            has_proxy: effective_proxy(config).is_some(),
        })
    }

    pub(crate) fn proxied(&self) -> &reqwest::Client {
        &self.proxied
    }

    pub(crate) fn direct(&self) -> &reqwest::Client {
        &self.direct
    }

    pub(crate) fn has_proxy(&self) -> bool {
        self.has_proxy
    }

    /// Hand-built pair for tests (a local stub for the direct twin, a
    /// dead-proxy client for the proxied one).
    #[cfg(test)]
    pub(crate) fn from_clients(
        proxied: reqwest::Client,
        direct: reqwest::Client,
        has_proxy: bool,
    ) -> Self {
        Self {
            proxied,
            direct,
            has_proxy,
        }
    }
}

/// The Mozilla CA root bundle vendored at `res/ca-bundle.pem` (refreshed
/// from https://curl.se/docs/caextract.html). Android-only TLS trust anchor
/// source — see the comment in [http_client_builder].
#[cfg(target_os = "android")]
fn android_tls_roots() -> anyhow::Result<Vec<reqwest::tls::Certificate>> {
    let pem: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/res/ca-bundle.pem"));
    reqwest::tls::Certificate::from_pem_bundle(pem).map_err(|e| anyhow!("bundled CA bundle: {e}"))
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

    /// The pair's proxy flag mirrors the config the twins were built from:
    /// the fallback chain arms itself only when a proxy is actually in
    /// effect (a "none"/proxy-less "system" config rides direct only).
    #[test]
    fn pair_reports_proxy_presence_from_the_config() {
        let none = NetworkConfig {
            mode: ProxyMode::None,
            ..NetworkConfig::default()
        };
        let pair = HttpPair::build_with(&none, |b| b).expect("none pair");
        assert!(!pair.has_proxy());

        let manual = NetworkConfig {
            mode: ProxyMode::Manual,
            proxy: Some("http://127.0.0.1:7890".into()),
            ..NetworkConfig::default()
        };
        let pair = HttpPair::build_with(&manual, |b| b).expect("manual pair");
        assert!(pair.has_proxy());
    }

    /// Review M-5: the redirect gate refuses a plain-http hop off
    /// loopback (the https→http downgrade) and keeps loopback + https
    /// hops legal.
    #[test]
    fn redirect_gate_refuses_plain_http_off_loopback() {
        let https = reqwest::Url::parse("https://mirror.example.org/x").unwrap();
        assert!(redirect_hop_allowed(&https).is_ok());
        let http_loopback = reqwest::Url::parse("http://127.0.0.1:8787/x").unwrap();
        assert!(redirect_hop_allowed(&http_loopback).is_ok());
        let http_localhost = reqwest::Url::parse("http://localhost:8787/x").unwrap();
        assert!(redirect_hop_allowed(&http_localhost).is_ok());
        let downgrade = reqwest::Url::parse("http://evil.example.org/x").unwrap();
        assert!(redirect_hop_allowed(&downgrade).is_err());
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
