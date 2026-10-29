use anyhow::{Result, anyhow, bail};

use std::time::Duration;

use serde_json::json;
use wowsp_tauri_shared::{CommandResult, GatewayHealthDoc, GatewaySessionTicket};

use super::*;
// ── ticket exchange (all targets, gateway-push §3.2/§9) ──────────────────────

/// Session-exchange budget (siteverify + password compare ride the call).
const SESSION_TIMEOUT: Duration = Duration::from_secs(15);
/// A response body beyond this is not ours.
const SESSION_MAX_BYTES: usize = 8 * 1024;
/// Ticket shape the worker mints: exactly 32 lowercase hex chars.
const TICKET_HEX_LEN: usize = 32;

// ── route ids (gateway-push §2) ───────────────────────────────────────────────

/// A channel id the worker accepts: `r:<realm>:<accountId>` with a 2–5
/// lowercase-ASCII realm and an ASCII-digit account id (`^r:[a-z]{2,5}:[0-9]+$`).
/// The client validates BEFORE opening a session so a malformed route
/// never reaches the wire (the worker enforces the same shape).
pub(super) fn valid_route(route: &str) -> bool {
    let Some(rest) = route.strip_prefix('r') else {
        return false;
    };
    let Some(rest) = rest.strip_prefix(':') else {
        return false;
    };
    let Some((realm, id)) = rest.split_once(':') else {
        return false;
    };
    (2..=5).contains(&realm.len())
        && realm.bytes().all(|b| b.is_ascii_lowercase())
        && !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.len() <= 19
}

/// The realm segment of a (validated or not) route id; empty when the
/// shape does not parse.
pub(super) fn route_realm(route: &str) -> &str {
    route
        .strip_prefix("r:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(realm, _)| realm)
        .unwrap_or("")
}

/// The account-id segment of a route id, parsed (`None` when the shape
/// does not parse or overflows).
pub(super) fn route_account_id(route: &str) -> Option<i64> {
    route
        .strip_prefix("r:")
        .and_then(|rest| rest.split_once(':'))
        .and_then(|(_, id)| id.parse::<i64>().ok())
}

// ── credential requirements (gateway-push §3.2/§5/§6) ────────────────────────

/// What one handshake attempt is missing, given the deployment's demands
/// (health document) and the credentials the caller brought.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CredentialReadiness {
    /// The provided credentials satisfy the health document.
    Ready,
    /// The deployment demands a Turnstile token the caller does not have —
    /// emit the `captcha` phase and stop (the token enters through the
    /// webui widget; it re-calls with one).
    NeedCaptcha,
    /// The deployment demands a password the caller did not provide.
    NeedPassword,
}

/// The requirement matrix: Turnstile first (the challenge renders before
/// the password sheet in the phone flow), password second. Blank strings
/// count as absent.
pub(super) fn credential_readiness(
    health: &GatewayHealthDoc,
    turnstile_token: Option<&str>,
    password: Option<&str>,
) -> CredentialReadiness {
    let present = |v: Option<&str>| v.map(str::trim).is_some_and(|v| !v.is_empty());
    if health.auth.turnstile.required && !present(turnstile_token) {
        return CredentialReadiness::NeedCaptcha;
    }
    if health.auth.password.required && !present(password) {
        return CredentialReadiness::NeedPassword;
    }
    CredentialReadiness::Ready
}

/// The `POST /session` JSON body: the route plus exactly the credentials
/// that exist (blank/absent ones are omitted — the worker treats a
/// missing key and an empty string the same, but the wire stays clean).
pub(super) fn session_request_body(
    route: &str,
    turnstile_token: Option<&str>,
    password: Option<&str>,
) -> String {
    let mut body = json!({ "route": route });
    if let Some(token) = turnstile_token.map(str::trim).filter(|t| !t.is_empty()) {
        body["cf-turnstile-response"] = json!(token);
    }
    if let Some(secret) = password.map(str::trim).filter(|p| !p.is_empty()) {
        body["password"] = json!(secret);
    }
    body.to_string()
}

/// Map a refused exchange onto its stable error marker (gateway-push §9).
/// `rate_limited` carries its retry budget (body `retryAfter` or the
/// `Retry-After` header, seconds); the captcha family — a refused token,
/// a missing token, or the gateway failing to REACH siteverify — all
/// remint the challenge; the password family is a plain rejection.
pub(super) fn map_session_error(
    status: u16,
    error_code: Option<&str>,
    retry_after: Option<u64>,
) -> String {
    let code = error_code.unwrap_or("");
    if status == 429 || code == "rate_limited" {
        return gateway_rate_limited(retry_after.unwrap_or(5).max(1));
    }
    match code {
        "captcha" | "captcha_unreachable" | "missing_captcha" => GATEWAY_CAPTCHA_FAILED.to_string(),
        "password" | "missing_password" => GATEWAY_PASSWORD_REJECTED.to_string(),
        "maintenance" => "gateway session unavailable (maintenance)".to_string(),
        other if !other.is_empty() => {
            format!("gateway session exchange failed ({other})")
        },
        _ => format!("gateway session exchange failed (HTTP {status})"),
    }
}

/// `POST {root}/session` — exchange exactly what the deployment demands
/// for a single-use ticket (the caller already resolved health and knows
/// the matrix). `root` must already be normalized.
pub(super) async fn open_gateway_session(
    root: &str,
    route: &str,
    turnstile_token: Option<&str>,
    password: Option<&str>,
) -> Result<GatewaySessionTicket> {
    if !valid_route(route) {
        bail!("gateway route is malformed: {route}");
    }
    let url = format!("{root}/session");
    let client = super::super::network::build_http_client()?;
    let resp = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(SESSION_TIMEOUT)
        .body(session_request_body(route, turnstile_token, password))
        .send()
        .await
        .map_err(|e| anyhow!("{} (session POST: {e})", GATEWAY_UNREACHABLE))?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let headers = resp.headers().clone();
        let body = resp.bytes().await.unwrap_or_default();
        let parsed: serde_json::Value =
            serde_json::from_slice(&body[..body.len().min(SESSION_MAX_BYTES)])
                .unwrap_or(serde_json::Value::Null);
        let code = parsed.get("error").and_then(|v| v.as_str());
        let retry = parsed
            .get("retryAfter")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                headers
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
            });
        bail!("{}", map_session_error(status, code, retry));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| anyhow!("{GATEWAY_UNREACHABLE} (body read: {e})"))?;
    if body.len() > SESSION_MAX_BYTES {
        bail!("{GATEWAY_UNREACHABLE} (session response oversized)");
    }
    let ticket: GatewaySessionTicket = serde_json::from_slice(&body)
        .map_err(|e| anyhow!("{GATEWAY_UNREACHABLE} (session parse: {e})"))?;
    if ticket.ticket.len() != TICKET_HEX_LEN
        || !ticket
            .ticket
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        // Never log the ticket itself.
        bail!("{GATEWAY_UNREACHABLE} (gateway minted a malformed ticket)");
    }
    Ok(ticket)
}

/// Exchange credentials for a ticket (the webui's step-by-step phone
/// flow calls this directly; the socket commands call the helper above).
#[tauri::command]
pub async fn gateway_open_session(
    root: String,
    route: String,
    turnstile_token: Option<String>,
    password: Option<String>,
) -> CommandResult<GatewaySessionTicket> {
    let root = normalize_root(&root)?;
    Ok(open_gateway_session(
        &root,
        &route,
        turnstile_token.as_deref(),
        password.as_deref(),
    )
    .await?)
}
