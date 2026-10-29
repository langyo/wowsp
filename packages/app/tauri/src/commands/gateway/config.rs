use anyhow::{Result, anyhow};

use wowsp_tauri_shared::{CommandResult, GatewayClientConfig};

use super::*;
// ── client config (all targets) ──────────────────────────────────────────────

/// Persisted config file (the `pairing-relay-config.json` pattern:
/// appdata dir, tmp + atomic rename).
pub(crate) const GATEWAY_CONFIG_FILE: &str = "gateway-config.json";

/// Current config, normalized (an absent file answers the default: the
/// official route entry, service OFF).
pub(crate) fn load_gateway_config() -> GatewayClientConfig {
    let Ok(dir) = crate::paths::ensure_data_dir() else {
        return GatewayClientConfig::default();
    };
    load_config_in(&dir)
}

/// `load_gateway_config` against an explicit directory (testable core):
/// a missing/unreadable file answers the default; a stored root is
/// re-normalized so the config ALWAYS carries the canonical spelling
/// (policy drift in an old file self-heals on first load).
pub(super) fn load_config_in(dir: &std::path::Path) -> GatewayClientConfig {
    let loaded: Option<GatewayClientConfig> =
        std::fs::read_to_string(dir.join(GATEWAY_CONFIG_FILE))
            .ok()
            .and_then(|r| serde_json::from_str(&r).ok());
    match loaded {
        Some(config) => GatewayClientConfig {
            root: normalize_root(&config.root).unwrap_or(config.root),
            enabled: config.enabled,
        },
        None => GatewayClientConfig::default(),
    }
}

fn save_config_in(dir: &std::path::Path, config: &GatewayClientConfig) -> Result<()> {
    let path = dir.join(GATEWAY_CONFIG_FILE);
    let tmp = dir.join(format!("{GATEWAY_CONFIG_FILE}.tmp"));
    let json = serde_json::to_string(config).map_err(|e| anyhow!("serialize config: {e}"))?;
    std::fs::write(&tmp, json).map_err(|e| anyhow!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| anyhow!("rename {tmp:?} -> {path:?}: {e}"))?;
    Ok(())
}

/// Current gateway client configuration: the normalized route entry plus
/// the mobile-service toggle (default: official entry, OFF).
#[tauri::command]
pub fn gateway_get_config() -> GatewayClientConfig {
    load_gateway_config()
}

/// Update the persisted config. `root` (when given) must pass the relay
/// URL policy (https enforced, loopback dev tolerated); `enabled` is the
/// mobile-service toggle. Disabling the service stops both live gateway
/// sessions at once (publisher + subscriber) so nothing keeps a socket.
#[tauri::command]
pub async fn gateway_set_config(
    root: Option<String>,
    enabled: Option<bool>,
) -> CommandResult<GatewayClientConfig> {
    let mut config = load_gateway_config();
    if let Some(raw) = root.as_deref() {
        config.root = normalize_root(raw)?;
    }
    if let Some(enabled) = enabled {
        config.enabled = enabled;
    }
    let dir = crate::paths::ensure_data_dir()?;
    save_config_in(&dir, &config)?;
    if !config.enabled {
        #[cfg(desktop)]
        super::publish::stop_publish().await;
        super::subscribe::stop_subscribe().await;
    }
    Ok(config)
}
