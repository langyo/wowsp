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
//! Access is a two-tier allowlist — ADMINS from `ERP_ALLOWED_OPEN_IDS`
//! (comma-separated) ∪ `FEEDBACK_ADMIN_OPEN_ID` (full control, the
//! people-management surface), MEMBERS granted from the console and
//! stored in KV `erp:members` (view access) — checked at the callback
//! AND on every session use, so a revoked id loses its live cookies
//! immediately. Nothing configured admits nobody (no legacy open mode):
//! bootstrap by setting ERP_ALLOWED_OPEN_IDS to the maintainer's
//! open_id BEFORE deploying this gate.
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
    let allowlist = effective_allowlist(&env).await;
    let mut claims = SessionClaims {
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
        admin: false,
    };
    if claims.open_id.is_empty() {
        return login_failed(&origin, "profile-shape");
    }
    if allowlist.is_empty() {
        // Fail-closed with nothing configured — the maintainer must
        // bootstrap ERP_ALLOWED_OPEN_IDS with their own open_id.
        worker::console_error!(
            "erp: allowlist empty (set ERP_ALLOWED_OPEN_IDS to your open_id)"
        );
        return login_failed(&origin, "unconfigured");
    }
    if !allowlist.admits(&claims.open_id) {
        // Logged so the owner can read a new maintainer's app-scoped
        // open_id off `wrangler tail` before adding it to the list.
        worker::console_log!("erp: denied open_id {}", claims.open_id);
        return login_failed(&origin, "denied");
    }
    claims.admin = allowlist.is_admin(&claims.open_id);

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
    let Some(c) = session_claims(&req, &env).await else {
        return ok(json!({ "ok": false }));
    };
    // Adminity is recomputed live (the cookie's flag can go stale when
    // the env allowlist changes) — the console hides its admin surfaces
    // from members.
    let admin = effective_allowlist(&env).await.is_admin(&c.open_id);
    if !relay_core::erp::profile_needs_refresh(&c.name, &c.avatar) {
        return ok(json!({
            "ok": true, "name": c.name, "avatar": c.avatar, "admin": admin
        }));
    }
    // The profile read is attempted live on every probe while the stored
    // claims are the placeholder; the contact failure code rides back to
    // the console (session-gated) so a stuck 权限 grant self-reports.
    match refresh_profile(&env, c.clone()).await {
        Ok(Some(fresh)) => {
            let mut resp = ok(json!({
                "ok": true, "name": fresh.name, "avatar": fresh.avatar, "debug": "refreshed",
                "admin": admin
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
            "admin": admin
        })),
        Err(d) => ok(json!({
            "ok": true, "name": c.name, "avatar": c.avatar, "debug": d,
            "admin": admin
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
    let _ = session_claims(&req, &env).await;
    let mut resp = ok(json!({ "ok": true }))?;
    resp.headers_mut().set(
        "Set-Cookie",
        &format!("{SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"),
    )?;
    Ok(resp)
}

/// The console APIs' gate: a valid, unexpired `erp_session` cookie whose
/// open_id is still allowlisted (admin or member tier). Replaces the
/// retired `X-Admin-Key` header check.
pub async fn session_ok(req: &Request, env: &Env) -> bool {
    session_claims(req, env).await.is_some()
}

/// The ADMIN tier's gate: a live console session whose open_id sits in
/// the env-configured admin list (people management, member grants).
pub async fn admin_session(req: &Request, env: &Env) -> Option<relay_core::erp::SessionClaims> {
    let c = session_claims(req, env).await?;
    effective_allowlist(env)
        .await
        .is_admin(&c.open_id)
        .then_some(c)
}

async fn session_claims(req: &Request, env: &Env) -> Option<relay_core::erp::SessionClaims> {
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
        &effective_allowlist(env).await,
    )
}

/// The KV row the console-managed member tier lives in (JSON array of
/// open_ids). One key, read on every gate check, written by the people
/// management endpoints.
const KV_MEMBERS: &str = "erp:members";

/// The gate the console actually enforces: the env-configured ADMIN tier
/// (`ERP_ALLOWED_OPEN_IDS` ∪ `FEEDBACK_ADMIN_OPEN_ID` — `env.var` reads a
/// plaintext var or a `wrangler secret` alike; secrets are the
/// recommended home since `wrangler deploy` drops dashboard-set vars)
/// plus the KV-managed MEMBER tier. No legacy open mode: empty admits
/// nobody. Every session check (login, whoami, console APIs, replay
/// admin) funnels through here.
async fn effective_allowlist(env: &Env) -> ConsoleAllowlist {
    let get = |name: &str| env.var(name).ok().map(|v| v.to_string());
    let configured = ConsoleAllowlist::from_config(
        get("ERP_ALLOWED_OPEN_IDS").as_deref(),
        get("FEEDBACK_ADMIN_OPEN_ID").as_deref(),
    );
    // Best-effort member read: a KV hiccup degrades to the admin tier
    // alone (never fails a request on the gate path).
    let members: Vec<String> = match env.kv(crate::feedback::KV) {
        Ok(kv) => kv
            .get(KV_MEMBERS)
            .json::<Vec<String>>()
            .await
            .ok()
            .flatten()
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    configured.with_members(members)
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

// ── people management (admin tier) ─────────────────────────────────────
//
// GET  /api/erp/users?department_id=&page_token= — one page of the
//   Feishu org's users under a department (BFS from the root is the
//   console's job; department_id=0 is the root), for the 人员管理 view.
// GET  /api/erp/members  — the console-managed member tier.
// POST /api/erp/members {open_id, action: "add"|"remove"} — grant or
//   revoke console view access. Admin-gated throughout.

/// Departments/users fetched per /api/erp/users call — the Workers
/// free-tier subrequest ceiling is 50; the caps leave headroom for the
/// token call and stay well inside a worker invocation's budget.
const USERS_PAGE_SIZE: usize = 50;
const USERS_HARD_CAP: usize = 500;

/// `GET /api/erp/users` — one page of org users for the people view.
pub async fn handle_users(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    if admin_session(&req, &env).await.is_none() {
        return err(403, "forbidden");
    }
    let query = req.url()?.query().unwrap_or("").to_string();
    let department = relay_core::route::query_get(&query, "department_id")
        .filter(|d| !d.is_empty() && d.len() <= 64)
        .unwrap_or("0");
    let page_token = relay_core::route::query_get(&query, "page_token")
        .filter(|t| !t.is_empty() && t.len() <= 128);

    let token = match feishu_token(&env).await {
        Ok(t) => t,
        Err(_) => return err(503, "feishu-unconfigured"),
    };
    // find_by_department answers items has_more page_token; the failure
    // code distinguishes a missing 通讯录 scope (the console surfaces
    // the grant guidance) from transport trouble.
    let mut url = format!(
        "{FEISHU}/contact/v3/users/find_by_department?department_id={}&page_size={}&user_id_type=open_id",
        urlencode(&department),
        USERS_PAGE_SIZE,
    );
    if let Some(t) = page_token.as_deref() {
        url.push_str(&format!("&page_token={}", urlencode(t)));
    }
    let (_, page) = match feishu_json(Method::Get, &url, &token, Value::Null).await {
        Ok(p) => p,
        Err(e) => return err(400, &format!("contact:{e}")),
    };
    let users: Vec<Value> = page
        .pointer("/data/items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(USERS_HARD_CAP)
                .map(|u| {
                    json!({
                        "open_id": u.get("open_id").and_then(Value::as_str).unwrap_or_default(),
                        "name": u.get("name").and_then(Value::as_str).unwrap_or_default(),
                        "avatar": u
                            .pointer("/avatar/avatar_240")
                            .or_else(|| u.pointer("/avatar/avatar_640"))
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    })
                })
                .filter(|u| !u["open_id"].as_str().unwrap_or("").is_empty())
                .collect()
        })
        .unwrap_or_default();
    ok(json!({
        "ok": true,
        "users": users,
        "next_page_token": page
            .pointer("/data/page_token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty()),
    }))
}

/// `/api/erp/members` — GET lists the console-managed member tier
/// (admins ride along so the view labels them un-revocable); POST
/// `{open_id, action: "add"|"remove"}` grants/revokes console view
/// access. The admin tier (env) is never writable here.
pub async fn handle_members(mut req: Request, env: Env) -> Result<Response> {
    if req.method() == Method::Get {
        if admin_session(&req, &env).await.is_none() {
            return err(403, "forbidden");
        }
        let allowlist = effective_allowlist(&env).await;
        return ok(json!({
            "ok": true,
            "members": member_ids(&env).await,
            "admins": allowlist.admin_ids(),
        }));
    }
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    if admin_session(&req, &env).await.is_none() {
        return err(403, "forbidden");
    }
    let origin = req.url()?.origin().ascii_serialization();
    if !relay_core::erp::same_origin_write(
        req.headers().get("Origin").ok().flatten().as_deref(),
        req.headers().get("Sec-Fetch-Site").ok().flatten().as_deref(),
        &origin,
    ) {
        return err(403, "forbidden");
    }
    let body: Value = req.json().await.unwrap_or(Value::Null);
    let Some(open_id) = body
        .get("open_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .map(str::to_string)
    else {
        return err(400, "bad_request");
    };
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    let allowlist = effective_allowlist(&env).await;
    if allowlist.is_admin(&open_id) {
        return err(400, "admin-immutable");
    }
    let mut members = member_ids(&env).await;
    match action {
        "add" => {
            if !members.iter().any(|m| m == &open_id) && members.len() < 200 {
                members.push(open_id.clone());
            }
        },
        "remove" => members.retain(|m| m != &open_id),
        _ => return err(400, "bad_action"),
    }
    let kv = env.kv(crate::feedback::KV)?;
    kv.put(KV_MEMBERS, serde_json::to_string(&members).unwrap_or_default())?
        .execute()
        .await?;
    ok(json!({ "ok": true, "members": members }))
}

/// The raw KV member row (empty on any read trouble).
async fn member_ids(env: &Env) -> Vec<String> {
    match env.kv(crate::feedback::KV) {
        Ok(kv) => kv
            .get(KV_MEMBERS)
            .json::<Vec<String>>()
            .await
            .ok()
            .flatten()
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
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
