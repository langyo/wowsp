use anyhow::{Result, anyhow, bail};

use std::time::Duration;

use wowsp_tauri_shared::{CommandResult, GatewayHealthDoc};

use super::*;
// ── health resolve (all targets, gateway-push §3.1/§9) ───────────────────────

/// Health-document fetch budget. The document is tiny and edge-cached;
/// anything slower is an unreachable gateway.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
/// A body beyond this is not ours — same cap the relay manifest fetch uses.
const HEALTH_MAX_BYTES: usize = 64 * 1024;

/// `GET {root}/health`: normalize the root, fetch the deployment
/// document (no-store) and validate it. Returns the normalized root with
/// the validated document (the caller reuses the root for /session and
/// the socket URLs so one command never mixes spellings).
pub(super) async fn fetch_gateway_health(root_raw: &str) -> Result<(String, GatewayHealthDoc)> {
    let root = normalize_root(root_raw)?;
    let url = format!("{root}/health");
    let client = super::super::network::build_http_client()?;
    let resp = match client
        .get(&url)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .timeout(HEALTH_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            tracing::debug!(url = %url, error = %e, "gateway health fetch failed");
            bail!("{}", GATEWAY_UNREACHABLE);
        },
    };
    if !resp.status().is_success() {
        tracing::debug!(url = %url, status = resp.status().as_u16(), "gateway health non-200");
        bail!("{}", GATEWAY_UNREACHABLE);
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| anyhow!("{} (body read: {e})", GATEWAY_UNREACHABLE))?;
    if body.len() > HEALTH_MAX_BYTES {
        bail!("{}", GATEWAY_UNREACHABLE);
    }
    let doc: GatewayHealthDoc = serde_json::from_slice(&body)
        .map_err(|e| anyhow!("{} (parse: {e})", GATEWAY_UNREACHABLE))?;
    validate_gateway_health(&doc, env!("CARGO_PKG_VERSION"))?;
    Ok((root, doc))
}

/// Validate a parsed health document against this client, in the relay's
/// gate ORDER: a too-old app must hear `update the app`, never a
/// protocol complaint it cannot act on; a body without a `gateway`
/// field at all is a foreign 200 (captive portal), not a gateway.
///
/// Stable markers (gateway-push §9):
/// `gateway unreachable or health document invalid` |
/// `gateway requires a newer app version` |
/// `gateway speaks an unsupported gateway protocol`.
pub(super) fn validate_gateway_health(doc: &GatewayHealthDoc, client_version: &str) -> Result<()> {
    if doc.gateway.trim().is_empty() {
        bail!("{}", GATEWAY_UNREACHABLE);
    }
    if let Some(min) = doc
        .min_client_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !pairing_relay::client_meets_minimum(client_version, min) {
            tracing::warn!(
                client = client_version,
                minimum = min,
                "the gateway demands a newer client"
            );
            bail!("{}", GATEWAY_TOO_OLD);
        }
    }
    if !doc.gateway.trim().eq_ignore_ascii_case("v1") {
        tracing::warn!(gateway = %doc.gateway, "the gateway speaks an unsupported protocol");
        bail!("{}", GATEWAY_UNSUPPORTED);
    }
    if let Some(notice) = doc
        .notice
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        tracing::info!(notice = %notice, "gateway operator notice");
    }
    Ok(())
}

/// Fetch a deployment's health document (`{root}/health`; `root`
/// defaults to the configured route entry). Pure transport — no
/// credential exchange happens here.
#[tauri::command]
pub async fn gateway_get_health(root: Option<String>) -> CommandResult<GatewayHealthDoc> {
    let root = root.unwrap_or_else(|| super::config::load_gateway_config().root);
    Ok(fetch_gateway_health(&root).await?.1)
}
