//! The `/erp` console's auth half — the Feishu OAuth round trips and
//! session-cookie issuance. The pure primitives (HMAC signing, cookie
//! parsing, the page) live in `relay_core::erp`; this module owns the
//! request/response plumbing:
//!
//! - `GET /api/erp/login` — 302 to the Feishu authorize page with a
//!   nonce `state` mirrored into a short-lived `erp_oauth` cookie.
//! - `GET /api/erp/callback?code=…&state=…` — verifies the state against
//!   that cookie, exchanges the code for a user access token (v2 token
//!   endpoint), reads the public profile, and mints the signed
//!   `erp_session` cookie (7 days).
//! - `GET /api/erp/session` — the console shell's whoami probe.
//! - `POST /api/erp/logout` — clears the session cookie.
//!
//! Access is limited to an open_id allowlist — `ERP_ALLOWED_OPEN_IDS`
//! (comma-separated) ∪ `FEEDBACK_ADMIN_OPEN_ID`, checked at the callback
//! AND on every session use, so removing an open_id revokes its live
//! cookies. With neither set the legacy gate stays (any user the Feishu
//! app admits) so an upgrade never locks the owner out; each such login
//! logs a warning and the session probe flags it to the console.
//! Session signing derives from `FEISHU_APP_SECRET` (domain-separated),
//! so no extra secret is needed.

use relay_core::erp::{
    ConsoleAllowlist, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECS, SESSION_COOKIE, SESSION_TTL_SECS,
    SessionClaims, authorize_url, cookie_get, ct_eq, mint_session, read_console_session,
    session_key,
};
use relay_core::feedback::urlencode;
use relay_core::route::query_get;
use serde_json::{Value, json};
use worker::{Env, Headers, Method, Request, Response, ResponseBody, Result};

use crate::feedback::{FEISHU, err, feishu_json, feishu_token, http_call, json_headers, ok};

/// 302 responses here are built from parts (`from_body(Empty)` +
/// `Location`): `Response::redirect` wraps the JS static constructor,
/// whose headers carry an immutable guard — ANY later header mutation
/// (in these handlers, and in the security-headers exit wrapper)
/// throws and turns the response into a 500.

/// `GET /api/erp/login` — kick off the OAuth round trip.
pub async fn handle_login(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    let Some(app_id) = env.secret("FEISHU_APP_ID").ok().map(|s| s.to_string()) else {
        return err(503, "feishu app missing");
    };
    let origin = req.url()?.origin().ascii_serialization();
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| "rng unavailable")?;
    let state = hex(&nonce);

    let url = authorize_url(&app_id, &format!("{origin}/api/erp/callback"), &state);
    let headers = Headers::new();
    headers.set("Location", &url)?;
    headers.set(
        "Set-Cookie",
        &format!(
            "{OAUTH_STATE_COOKIE}={state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={OAUTH_STATE_TTL_SECS}"
        ),
    )?;
    // State-bearing redirects must never be cached.
    headers.set("cache-control", "no-store")?;
    Ok(Response::from_body(ResponseBody::Empty)?
        .with_status(302)
        .with_headers(headers))
}

/// `GET /api/erp/callback` — finish the OAuth round trip.
pub async fn handle_callback(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    let url = req.url()?;
    let origin = url.origin().ascii_serialization();
    let query = url.query().unwrap_or("").to_string();

    // State must mirror the erp_oauth cookie (double-submit CSRF guard).
    let state = query_get(&query, "state").unwrap_or_default();
    let cookie = req
        .headers()
        .get("Cookie")
        .ok()
        .flatten()
        .unwrap_or_default();
    let expected = cookie_get(&cookie, OAUTH_STATE_COOKIE).unwrap_or_default();
    if state.len() != 32 || !ct_eq(&state, &expected) {
        return login_failed(&origin, "state");
    }
    let Some(app_secret) = env.secret("FEISHU_APP_SECRET").ok().map(|s| s.to_string()) else {
        return login_failed(&origin, "config");
    };

    // Exchange the code (v2 token endpoint; errors use a different shape
    // than the v1 APIs, so parse it by hand instead of via feishu_json).
    let Some(code) = query_get(&query, "code").filter(|c| !c.is_empty() && c.len() <= 128) else {
        return login_failed(&origin, "code");
    };
    let mut resp = http_call(
        Method::Post,
        &format!("{FEISHU}/authen/v2/oauth/token"),
        json_headers(None)?,
        Some(
            json!({
                "grant_type": "authorization_code",
                "client_id": env.secret("FEISHU_APP_ID").ok().map(|s| s.to_string()).unwrap_or_default(),
                "client_secret": app_secret,
                "code": code,
                "redirect_uri": format!("{origin}/api/erp/callback"),
            })
            .to_string()
            .into_bytes(),
        ),
    )
    .await
    .map_err(|_| "feishu unreachable".to_string())?;
    let status = resp.status_code();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    let uat = v
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|_| (200..300).contains(&status))
        .map(str::to_string);
    let Some(uat) = uat else {
        return login_failed(&origin, "token");
    };

    // Public profile only — the token itself never leaves the server.
    // Called via http_call (not feishu_json) so a rejected profile read
    // can surface the API's own numeric code in the failure reason.
    let mut resp = match http_call(
        Method::Get,
        &format!("{FEISHU}/authen/v1/user_info"),
        json_headers(Some(&uat))?,
        None,
    )
    .await
    {
        Ok(resp) => resp,
        Err(_) => return login_failed(&origin, "profile-net"),
    };
    let status = resp.status_code();
    let ui: Value = resp.json().await.unwrap_or(Value::Null);
    let api_code = ui.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if !(200..300).contains(&status) || api_code != 0 {
        return login_failed(&origin, &format!("profile{api_code}"));
    }
    // The documented shapes moved across endpoint generations: v1
    // nests the profile under data.user_info, some newer docs under
    // data.user, and the oldest shape is flat on data. Accept all
    // three rather than guessing wrong again.
    let data = ui.pointer("/data").cloned().unwrap_or(Value::Null);
    let user = data
        .get("user_info")
        .or_else(|| data.get("user"))
        .cloned()
        .unwrap_or(data);
    let claims = SessionClaims {
        open_id: user
            .get("open_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: user
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        avatar: user
            .get("avatar_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        exp: now_secs() + SESSION_TTL_SECS,
    };
    if claims.open_id.is_empty() {
        return login_failed(&origin, "profile-shape");
    }
    let allowlist = allowlist(&env);
    if !allowlist.admits(&claims.open_id) {
        // Logged so the owner can read a new maintainer's app-scoped
        // open_id off `wrangler tail` before adding it to the list.
        worker::console_log!("erp: denied open_id {}", claims.open_id);
        return login_failed(&origin, "denied");
    }
    if allowlist.is_open() {
        worker::console_warn!(
            "erp: no ERP_ALLOWED_OPEN_IDS / FEEDBACK_ADMIN_OPEN_ID configured; \
             admitting open_id {} under the legacy any-app-user gate",
            claims.open_id
        );
    }

    // Best-effort enrichment: user_info anonymizes the profile to
    // 用户＋digits when the app lacks contact visibility, which reads as
    // a placeholder in the console's user chip. The tenant-token contact
    // read restores the real name + avatar once 权限 is granted; on any
    // failure the anonymized values still log the maintainer in.
    let claims = refresh_profile(&env, claims.clone())
        .await
        .ok()
        .flatten()
        .unwrap_or(claims);

    let key = session_key(&app_secret);
    // Two cookies on one response: Fetch `set()` REPLACES same-named
    // headers, so both Set-Cookie lines must go through `append()`.
    let headers = Headers::new();
    headers.set("Location", &format!("{origin}/erp"))?;
    headers.append(
        "Set-Cookie",
        &format!(
            "{SESSION_COOKIE}={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={SESSION_TTL_SECS}",
            mint_session(&key, &claims)
        ),
    )?;
    headers.append(
        "Set-Cookie",
        &format!("{OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"),
    )?;
    headers.set("cache-control", "no-store")?;
    Ok(Response::from_body(ResponseBody::Empty)?
        .with_status(302)
        .with_headers(headers))
}

/// `GET /api/erp/session` — the console shell's whoami probe. A cookie
/// minted while the app still lacked contact visibility carries the
/// anonymized placeholder profile; the probe re-reads the contact API
/// live in that case and re-mints the cookie, so granting 权限 heals the
/// chip on the next page load instead of at the next re-login.
pub async fn handle_session(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    let Some(c) = session_claims(&req, &env) else {
        return ok(json!({ "ok": false }));
    };
    // Open mode (no allowlist configured) is surfaced to the session
    // holder together with their own open_id — exactly the value the
    // owner needs to close the gate.
    let open_access = allowlist(&env).is_open().then(|| c.open_id.clone());
    if !relay_core::erp::profile_needs_refresh(&c.name, &c.avatar) {
        return ok(json!({
            "ok": true, "name": c.name, "avatar": c.avatar, "open_access": open_access
        }));
    }
    // The profile read is attempted live on every probe while the stored
    // claims are the placeholder; the contact failure code rides back to
    // the console (session-gated) so a stuck 权限 grant self-reports.
    match refresh_profile(&env, c.clone()).await {
        Ok(Some(fresh)) => {
            let mut resp = ok(json!({
                "ok": true, "name": fresh.name, "avatar": fresh.avatar, "debug": "refreshed",
                "open_access": open_access
            }))?;
            if let Some(app_secret) = env.secret("FEISHU_APP_SECRET").ok().map(|s| s.to_string()) {
                let value = mint_session(&session_key(&app_secret), &fresh);
                resp.headers_mut().set(
                    "Set-Cookie",
                    &format!(
                        "{SESSION_COOKIE}={value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={SESSION_TTL_SECS}"
                    ),
                )?;
            }
            Ok(resp)
        },
        // The contact read failed again (权限 still missing) — serve the
        // stored claims and report WHY to the session holder.
        Ok(None) => ok(json!({
            "ok": true, "name": c.name, "avatar": c.avatar, "debug": "unchanged",
            "open_access": open_access
        })),
        Err(d) => ok(json!({
            "ok": true, "name": c.name, "avatar": c.avatar, "debug": d,
            "open_access": open_access
        })),
    }
}

/// `POST /api/erp/logout` — clear the session cookie.
pub async fn handle_logout(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    // Verify when possible so the endpoint isn't a gratuitous oracle;
    // clearing anyway is harmless either way.
    let _ = session_claims(&req, &env);
    let mut resp = ok(json!({ "ok": true }))?;
    resp.headers_mut().set(
        "Set-Cookie",
        &format!("{SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"),
    )?;
    Ok(resp)
}

/// The console APIs' gate: a valid, unexpired `erp_session` cookie whose
/// open_id is still allowlisted. Replaces the retired `X-Admin-Key`
/// header check.
pub fn session_ok(req: &Request, env: &Env) -> bool {
    session_claims(req, env).is_some()
}

fn session_claims(req: &Request, env: &Env) -> Option<relay_core::erp::SessionClaims> {
    let app_secret = env
        .secret("FEISHU_APP_SECRET")
        .ok()
        .map(|s| s.to_string())?;
    let cookie = req.headers().get("Cookie").ok().flatten()?;
    let value = cookie_get(&cookie, SESSION_COOKIE)?;
    read_console_session(
        &session_key(&app_secret),
        &value,
        now_secs(),
        &allowlist(env),
    )
}

/// `ERP_ALLOWED_OPEN_IDS` ∪ `FEEDBACK_ADMIN_OPEN_ID`. `env.var` reads a
/// plaintext var or a `wrangler secret` alike; secrets are the
/// recommended home since `wrangler deploy` drops dashboard-set vars.
fn allowlist(env: &Env) -> ConsoleAllowlist {
    let get = |name: &str| env.var(name).ok().map(|v| v.to_string());
    ConsoleAllowlist::from_config(
        get("ERP_ALLOWED_OPEN_IDS").as_deref(),
        get("FEEDBACK_ADMIN_OPEN_ID").as_deref(),
    )
}

/// Re-read the profile from the contact API with the tenant token.
/// `Err` carries a short failure code (contact-net / contact<api_code>)
/// for the session probe's debug field; `Ok(None)` means the read
/// succeeded but nothing changed. Both keep the caller's stored claims.
async fn refresh_profile(
    env: &Env,
    claims: relay_core::erp::SessionClaims,
) -> Result<Option<relay_core::erp::SessionClaims>, String> {
    let token = feishu_token(env)
        .await
        .map_err(|_| "contact-net".to_string())?;
    let (_, cu) = feishu_json(
        Method::Get,
        &format!(
            "{FEISHU}/contact/v3/users/{}?user_id_type=open_id",
            urlencode(&claims.open_id)
        ),
        &token,
        Value::Null,
    )
    .await
    .map_err(|e| format!("contact{}", e))?;
    let u = cu.pointer("/data/user").cloned().unwrap_or(Value::Null);
    let mut fresh = claims.clone();
    if let Some(n) = u
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        fresh.name = n.to_string();
    }
    let avatar = u
        .pointer("/avatar/avatar_240")
        .or_else(|| u.pointer("/avatar/avatar_640"))
        .or_else(|| u.pointer("/avatar/avatar_origin"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if let Some(a) = avatar {
        fresh.avatar = a.to_string();
    }
    Ok((fresh.name != claims.name || fresh.avatar != claims.avatar).then_some(fresh))
}

fn login_failed(origin: &str, reason: &str) -> Result<Response> {
    // A failed round trip also drops the state cookie so no stale nonce
    // lingers past its purpose. The short reason code rides the URL so
    // the console (and the maintainer) can see WHERE the trip broke.
    let headers = Headers::new();
    headers.set(
        "Location",
        &format!("{origin}/erp?login=failed&reason={reason}"),
    )?;
    headers.set(
        "Set-Cookie",
        &format!("{OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"),
    )?;
    headers.set("cache-control", "no-store")?;
    Ok(Response::from_body(ResponseBody::Empty)?
        .with_status(302)
        .with_headers(headers))
}

fn now_secs() -> i64 {
    (worker::Date::now().as_millis() / 1000) as i64
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0xf) as u32, 16).unwrap_or('0'));
    }
    out
}
