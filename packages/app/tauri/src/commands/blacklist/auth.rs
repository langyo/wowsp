//! OpenID login for the blacklist sync (WG / Lesta portals).
//!
//! The flow: WoWSP binds an ephemeral loopback listener, opens the portal's
//! login page in the system browser with
//! redirect_uri=http://127.0.0.1:<port>/callback, the user signs in, and the
//! portal redirects with the answer in the query string:
//!
//!   status=ok&access_token=..&expires_at=..&account_id=..&nickname=..
//!   status=error&code=..&message=..
//!
//! (Lesta documents this shape verbatim for /mk/auth/login/; Wargaming's
//! /wgn/auth/login/ is the same OpenID machinery.)
//!
//! The token is persisted to blacklist-auth.toml under the appdata root.
//! That file is a LOCAL CREDENTIAL (settings-store conventions, §7): it is
//! never shipped, committed, logged, or echoed back over IPC — the state
//! command reports expiry, never the token itself.
//!
//! Loopback redirect URIs are not contractually guaranteed by the portals
//! for this application id, so the settings UI always shows the login URL
//! for manual copy/paste as the fallback when the callback never arrives.

use anyhow::{Result, anyhow};

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use wowsp_tauri_shared::{BlacklistAuthState, BlacklistPlatform, CommandResult};

use crate::commands::ensure_main_window_label;
use crate::paths;
use crate::settings_store;

/// The credential file — TOML by settings-store convention, with a header
/// naming it as a credential.
pub(crate) const AUTH_FILE: &str = "blacklist-auth.toml";
/// One login flow at a time; the listener dies after this long without a
/// callback (the settings page restarts it on demand).
const AUTH_FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Head cap for the single callback request (browsers keep it tiny).
const MAX_HEAD: usize = 16 * 1024;
/// The portals cap token lifetimes at two weeks; ask for the full window.
const REQUESTED_TOKEN_TTL_SECS: i64 = 14 * 24 * 3600;

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Which API family serves one realm's OpenID + private contacts. "cn"
/// answers None — the 360 cluster has no public API (see wg_realm).
pub(crate) fn platform_of(realm: &str) -> Option<BlacklistPlatform> {
    match realm {
        "ru" => Some(BlacklistPlatform::Lesta),
        "eu" | "na" | "asia" => Some(BlacklistPlatform::Wargaming),
        _ => None,
    }
}

/// Portal method prefix: Lesta splits its API under /mk, Wargaming uses
/// /wgn. Mirrors platform_of exactly.
pub(crate) fn portal_base(realm: &str) -> Option<&'static str> {
    match realm {
        "ru" => Some("/mk"),
        "eu" | "na" | "asia" => Some("/wgn"),
        _ => None,
    }
}

/// The portal login page URL for one realm. redirect_uri is percent-encoded
/// (portals echo it verbatim into the redirect, and it carries "://" plus a
/// port that must survive as ONE query component).
pub(crate) fn build_login_url(realm: &str, redirect_uri: &str, now: i64) -> Result<String> {
    let host = crate::commands::wg_realm::api_host(realm)?;
    let base = portal_base(realm)
        .ok_or_else(|| anyhow!("realm '{}' has no blacklist-capable API", realm))?;
    let app_id = crate::commands::wg_realm::application_id(realm);
    Ok(format!(
        "https://{host}{base}/auth/login/?application_id={app_id}&redirect_uri={}&expires_at={}",
        crate::commands::wg_api::encode_query(redirect_uri),
        now + REQUESTED_TOKEN_TTL_SECS,
    ))
}

// ── callback parsing ─────────────────────────────────────────────────────────

/// The success half of a callback redirect.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AuthSuccess {
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub account_id: i64,
    pub nickname: String,
}

/// Ok(Ok(success)) — login completed; Ok(Err(message)) — the portal
/// explicitly reported an error; Err(..) — not a callback at all (a favicon
/// hit, a bare /callback without params, ...) and the listener keeps
/// waiting.
pub(crate) fn parse_callback_query(
    query: &str,
) -> Result<std::result::Result<AuthSuccess, String>> {
    let mut status = None;
    let mut access_token = None;
    let mut expires_at = None;
    let mut account_id = None;
    let mut nickname = None;
    let mut message = None;
    let mut code = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = crate::commands::exports::percent_decode(v).unwrap_or_else(|_| v.to_string());
        match k {
            "status" => status = Some(v),
            "access_token" => access_token = Some(v),
            "expires_at" => expires_at = v.parse().ok(),
            "account_id" => account_id = v.parse().ok(),
            "nickname" => nickname = Some(v),
            "message" => message = Some(v),
            "code" => code = Some(v),
            _ => {},
        }
    }
    match status.as_deref() {
        Some("ok") => {
            // An incomplete status=ok answer IS a callback — it ends the
            // flow with the failure page (inner Err), it must not leave the
            // listener waiting for a redirect that already happened.
            match (access_token, expires_at, account_id, nickname) {
                (Some(access_token), Some(expires_at), Some(account_id), Some(nickname)) => {
                    Ok(Ok(AuthSuccess {
                        access_token,
                        expires_at,
                        account_id,
                        nickname,
                    }))
                },
                _ => Ok(Err("callback status=ok but fields incomplete".to_string())),
            }
        },
        Some("error") => Ok(Err(message
            .or(code)
            .unwrap_or_else(|| "portal reported an error".to_string()))),
        _ => Err(anyhow!("callback query carries no status")),
    }
}

// ── credential store ─────────────────────────────────────────────────────────

/// The stored OpenID credential for the bound realm. One realm at a time:
/// the sync is always "my own blacklist", and switching realms re-runs the
/// login (the snapshot keeps its old realm until the next pull).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAuth {
    pub realm: String,
    pub account_id: i64,
    pub nickname: String,
    /// LOCAL CREDENTIAL — never logged, never sent to the webui.
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

fn auth_header() -> String {
    "# WoWSP blacklist sync credential (Wargaming / Lesta OpenID access token).\n\
     # LOCAL ONLY: treat this file like a password store; deleting it just\n\
     # logs the app's blacklist sync out.\n"
        .to_string()
}

/// Canonical TOML text for one credential (kept whole so the file on disk
/// always carries the credential header).
pub(crate) fn canonical_auth_toml(auth: &StoredAuth) -> Result<String> {
    let body = toml::to_string(auth).map_err(|e| anyhow!("serialize auth: {e}"))?;
    Ok(format!("{}{}", auth_header(), body))
}

/// Tolerant read: unreadable or unparsable files count as logged out (the
/// user re-runs the login; nothing else in the app depends on this file).
pub(crate) fn load_auth() -> Option<StoredAuth> {
    let dir = paths::ensure_data_dir().ok()?;
    let loaded = settings_store::load_raw(&dir, AUTH_FILE, "blacklist-auth.json");
    let raw = loaded.raw?;
    match toml::from_str::<StoredAuth>(&raw) {
        Ok(auth) => Some(auth),
        Err(_) => serde_json::from_str::<StoredAuth>(&raw).ok(),
    }
}

/// Atomic write behind the shared settings-store gate.
pub(crate) fn store_auth(auth: &StoredAuth) -> Result<()> {
    let dir = paths::ensure_data_dir()?;
    settings_store::store(&dir, AUTH_FILE, &canonical_auth_toml(auth)?)
}

/// Remove the credential. A missing file is the steady state of "logged
/// out" — not an error.
pub(crate) fn clear_auth() -> Result<()> {
    let dir = paths::ensure_data_dir()?;
    match std::fs::remove_file(dir.join(AUTH_FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow!("remove blacklist credential: {e}")),
    }
}

// ── the one live login flow ──────────────────────────────────────────────────

struct AuthFlow {
    /// The listener's loopback port — the identity guard for cleanup: an
    /// old flow finishing (timeout / superseded) must never clear the slot
    /// of a NEWER flow that already replaced it.
    port: u16,
    cancel: watch::Sender<bool>,
}

static AUTH_FLOW: std::sync::LazyLock<std::sync::Mutex<Option<AuthFlow>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

fn cancel_flow() {
    if let Ok(mut slot) = AUTH_FLOW.lock() {
        if let Some(flow) = slot.take() {
            let _ = flow.cancel.send(true);
        }
    }
}

/// Clear the slot ONLY when it still holds this flow's port (identity
/// guard against the supersede race — see AuthFlow::port).
fn cancel_flow_for(port: u16) {
    if let Ok(mut slot) = AUTH_FLOW.lock() {
        if slot.as_ref().map(|flow| flow.port) == Some(port) {
            *slot = None;
        }
    }
}

/// Static answer page for the browser tab after the redirect lands.
fn callback_page(success: bool) -> &'static str {
    if success {
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>WoWSP</title></head><body \
         style=\"font-family:sans-serif;background:#1b2430;color:#e8edf4;display:flex;\
         align-items:center;justify-content:center;height:100vh;margin:0\"><div \
         style=\"text-align:center\"><h2>Authorization complete / 授权完成</h2><p>You can close \
         this tab and return to WoWSP / 可以关闭此页面返回 WoWSP。</p></div></body></html>"
    } else {
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>WoWSP</title></head><body \
         style=\"font-family:sans-serif;background:#1b2430;color:#e8edf4;display:flex;\
         align-items:center;justify-content:center;height:100vh;margin:0\"><div \
         style=\"text-align:center\"><h2>Authorization did not complete / 授权未完成</h2><p>Please \
         return to WoWSP and try again / 请回到 WoWSP 重试。</p></div></body></html>"
    }
}

/// Read one request head (bounded), answer it, and report whether it was a
/// real callback — true ends the flow (success, or the portal's explicit
/// error), false keeps listening (favicon hits, stray probes).
async fn handle_conn(mut stream: TcpStream, realm: String) -> bool {
    let mut head: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    let drain = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    head.extend_from_slice(&buf[..n]);
                    if head.len() > MAX_HEAD || head.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                },
            }
        }
    });
    if drain.await.is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&head);
    let request_line = text.lines().next().unwrap_or_default();
    let target = request_line.split_whitespace().nth(1).unwrap_or_default();
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or_default();
    let parsed = parse_callback_query(query);
    let page = matches!(parsed, Ok(Ok(_)));
    let body = callback_page(page);
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \
                 {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            )
            .as_bytes(),
        )
        .await;
    let _ = stream.shutdown().await;
    match parsed {
        Ok(Ok(success)) => {
            let auth = StoredAuth {
                realm,
                account_id: success.account_id,
                nickname: success.nickname,
                access_token: success.access_token,
                expires_at: success.expires_at,
            };
            match store_auth(&auth) {
                Ok(()) => {
                    tracing::info!(
                        realm = %auth.realm,
                        expires_at = auth.expires_at,
                        "blacklist login complete"
                    );
                },
                Err(e) => tracing::error!("blacklist auth store failed: {e:#}"),
            }
            true
        },
        Ok(Err(msg)) => {
            tracing::warn!(realm = %realm, "blacklist login rejected by portal: {msg}");
            true
        },
        Err(_) => false,
    }
}

async fn accept_loop(
    listener: TcpListener,
    port: u16,
    realm: String,
    mut cancel_rx: watch::Receiver<bool>,
    done_tx: watch::Sender<bool>,
    mut done_rx: watch::Receiver<bool>,
) {
    let deadline = tokio::time::Instant::now() + AUTH_FLOW_TIMEOUT;
    loop {
        tokio::select! {
            _ = cancel_rx.changed() => break,
            _ = done_rx.changed() => break,
            _ = tokio::time::sleep_until(deadline) => {
                tracing::info!(realm = %realm, "blacklist login flow timed out");
                break;
            },
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                // Per-connection task: browsers open speculative preconnects
                // that send nothing — an inlined handle_conn would hold the
                // accept loop on its 10 s read timeout and delay a real
                // callback landing behind them.
                let realm2 = realm.clone();
                let done_tx = done_tx.clone();
                tokio::spawn(async move {
                    if handle_conn(stream, realm2).await {
                        let _ = done_tx.send(true);
                    }
                });
            },
        }
    }
    cancel_flow_for(port);
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Bind the loopback listener, open the portal login page, and wait for the
/// redirect in the background. Returns the login URL so the settings page
/// can show it for manual copy/paste (the loopback fallback path). The
/// webui polls blacklist_auth_state while the flow is open.
#[tauri::command]
pub async fn blacklist_auth_start(
    window: tauri::Window,
    app: tauri::AppHandle,
    realm: String,
) -> CommandResult<String> {
    ensure_main_window_label(window.label())?;
    platform_of(&realm)
        .ok_or_else(|| anyhow!("realm '{}' does not support blacklist sync", realm))?;
    cancel_flow();

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| anyhow!("bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| anyhow!("loopback local_addr: {e}"))?
        .port();
    let login_url = build_login_url(
        &realm,
        &format!("http://127.0.0.1:{port}/callback"),
        unix_now(),
    )?;

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(login_url.clone(), None::<&str>)
            .map_err(|e| anyhow!("open login page: {e}"))?;
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (done_tx, done_rx) = watch::channel(false);
    if let Ok(mut slot) = AUTH_FLOW.lock() {
        *slot = Some(AuthFlow {
            port,
            cancel: cancel_tx,
        });
    }
    tokio::spawn(accept_loop(
        listener,
        port,
        realm.clone(),
        cancel_rx,
        done_tx.clone(),
        done_rx,
    ));
    tracing::info!(realm = %realm, port, "blacklist login flow started");
    Ok(login_url)
}

/// Kill a pending login flow (dialog close / rebind / settings leave).
#[tauri::command]
pub fn blacklist_auth_cancel(window: tauri::Window) -> CommandResult<()> {
    ensure_main_window_label(window.label())?;
    cancel_flow();
    Ok(())
}

/// Credential state for one realm, WITHOUT the token. logged_in is true
/// only when the stored binding is this realm and the token has not expired.
#[tauri::command]
pub fn blacklist_auth_state(realm: String) -> CommandResult<BlacklistAuthState> {
    let platform = platform_of(&realm);
    let bound = load_auth().filter(|a| a.realm == realm.as_str());
    let fresh = bound
        .as_ref()
        .map(|a| a.expires_at > unix_now())
        .unwrap_or(false);
    Ok(BlacklistAuthState {
        realm,
        platform,
        logged_in: fresh,
        account_id: bound.as_ref().map(|a| a.account_id),
        nickname: bound.as_ref().map(|a| a.nickname.clone()),
        expires_at: bound.as_ref().map(|a| a.expires_at),
    })
}

/// Forget the stored credential (settings "unbind"). Best-effort portal
/// logout first so the token dies server-side too; removing the local file
/// is the authoritative part and never fails the command.
#[tauri::command]
pub async fn blacklist_auth_forget(window: tauri::Window, realm: String) -> CommandResult<()> {
    ensure_main_window_label(window.label())?;
    cancel_flow();
    let stored = load_auth().filter(|a| a.realm == realm.as_str());
    if let Some(auth) = stored {
        if let (Ok(host), Some(base)) = (
            crate::commands::wg_realm::api_host(&realm),
            portal_base(&realm),
        ) {
            // Server-side logout, strictly best-effort: the documented shape
            // carries the token in the URL, so this request bypasses the
            // health recorder entirely and every transport error collapses
            // to a FIXED string — no reqwest Display (which embeds the full
            // token-bearing URL) may reach a log line or a health record.
            // Removing the local file below is the authoritative part.
            let url = format!(
                "https://{host}{base}/auth/logout/?application_id={}&access_token={}",
                crate::commands::wg_realm::application_id(&realm),
                crate::commands::wg_api::encode_query(&auth.access_token),
            );
            let clients =
                crate::commands::network::HttpPair::build(|b| b.timeout(Duration::from_secs(10)))
                    .map_err(|e| anyhow!("http client: {e:#}"))?;
            let send = |client: &reqwest::Client| client.get(&url).send();
            if send(clients.proxied()).await.is_err() && clients.has_proxy() {
                let _ = send(clients.direct()).await;
            }
        }
    }
    clear_auth().map_err(|e| anyhow!("clear blacklist credential: {e:#}"))?;
    tracing::info!(realm = %realm, "blacklist credential forgotten");
    Ok(())
}
