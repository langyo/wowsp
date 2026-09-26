use super::*;
// ── config commands (all targets) ────────────────────────────────────────────

pub const RELAY_CONFIG_FILE: &str = "pairing-relay-config.json";

pub fn load_relay_config() -> RelayConfig {
    let Ok(dir) = crate::paths::ensure_data_dir() else {
        return RelayConfig::default();
    };
    std::fs::read_to_string(dir.join(RELAY_CONFIG_FILE))
        .ok()
        .and_then(|r| serde_json::from_str::<RelayConfig>(&r).ok())
        .unwrap_or_default()
}

fn save_relay_config(config: &RelayConfig) -> Result<(), String> {
    let dir = crate::paths::ensure_data_dir()?;
    let path = dir.join(RELAY_CONFIG_FILE);
    let tmp = dir.join(format!("{RELAY_CONFIG_FILE}.tmp"));
    let json = serde_json::to_string(config).map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&tmp, json).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))?;
    Ok(())
}

/// Current relay configuration (hidden setting — no UI field; the toggle
/// exists for support/diagnostics and the tests). Enabled by default.
#[tauri::command]
pub fn pairing_get_relay_config() -> RelayConfig {
    load_relay_config()
}

/// Persist the relay toggle (enabled only — the endpoint is the built-in
/// gateway, not user-configured). On the desktop a running pairing server's
/// bridge is restarted live so the change applies at once.
#[tauri::command]
pub async fn pairing_set_relay(config: RelayConfig) -> Result<(), String> {
    save_relay_config(&config)?;
    #[cfg(desktop)]
    restart_bridge_for_config(&config).await;
    Ok(())
}

#[cfg(desktop)]
async fn restart_bridge_for_config(config: &RelayConfig) {
    host_session_stop().await;
    if !config.enabled {
        return;
    }
    if let Some((port, room)) = super::pairing::server::server_snapshot().await {
        if let Err(e) = host_session_start(&builtin_relay_root(), port, &room).await {
            tracing::warn!(error = %e, "relay host session failed to start");
        }
    }
}
