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
//! Any authenticated Feishu user of the app gets console access — this
//! is the maintainer's personal tool, and the app is the owner's own.
//! Session signing derives from `FEISHU_APP_SECRET` (domain-separated),
//! so no extra secret is needed.

use relay_core::erp::{
    OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_SECS, SESSION_COOKIE, SESSION_TTL_SECS, SessionClaims,
    authorize_url, cookie_get, ct_eq, mint_session, read_session, session_key,
};
use relay_core::route::query_get;
use serde_json::{Value, json};
use worker::{Env, Headers, Method, Request, Response, ResponseBody, Result};

use crate::feedback::{FEISHU, err, feishu_json, http_call, json_headers, ok};

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
    let (_, ui) = match feishu_json(
        Method::Get,
        &format!("{FEISHU}/authen/v1/user_info"),
        &uat,
        Value::Null,
    )
    .await
    {
        Ok(paired) => paired,
        Err(_) => return login_failed(&origin, "profile"),
    };
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
    let user = ui.pointer("/data/user").cloned().unwrap_or(Value::Null);
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
        return login_failed(&origin, "profile");
    }

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

/// `GET /api/erp/session` — the console shell's whoami probe.
pub async fn handle_session(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    match session_claims(&req, &env) {
        Some(c) => ok(json!({ "ok": true, "name": c.name, "avatar": c.avatar })),
        None => ok(json!({ "ok": false })),
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

/// The console APIs' gate: a valid, unexpired `erp_session` cookie.
/// Replaces the retired `X-Admin-Key` header check.
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
    read_session(&session_key(&app_secret), &value, now_secs())
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
