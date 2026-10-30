//! The `/gateway/*` account-routed push namespace (mobile-gateway
//! wave; design contract: docs/en/designs/gateway-push.md) — the I/O
//! half. Every policy decision lives in [`relay_core::gateway`]
//! (health doc, route-id shape, tickets, password lockout, channel
//! rules); this module owns HTTP/WS plumbing, the siteverify round
//! trip (via the feedback pipeline's helpers), and two Durable Objects:
//!
//! - `GatewayAuth` (singleton, "auth") — ticket mint/consume plus the
//!   per-IP password failure counters (KV is not atomic enough; the
//!   contract §3.2 puts them in a DO). Internal routes:
//!     GET /mint?route=<id>&kind=turnstile|password|both|none
//!                                     → {"ticket":"<32hex>","ttl":120}
//!     GET /consume?ticket=<32hex>&route=<id>
//!                                     → 200 | 404 | 409 (route mismatch)
//!     GET /gate?ip=<ip>               → {"locked":bool,"retryAfterMs":n}
//!     GET /pwfail?ip=<ip>             → records one failure, same shape
//! - `GatewayChannel` (one per route id) — host presence, subscriber
//!   fan-out, last-battle snapshot retention + alarm, and the
//!   fire-and-forget `battle:<route>` KV mirror. Sockets upgrade INSIDE
//!   the DO (like the relay's room sockets), keyed by the raw
//!   /gateway/pub|sub path this module forwards untouched.
//!
//! Configuration (official + self-host):
//! - `GATEWAY_TURNSTILE_SITEKEY` (var, optional) — Turnstile on. The
//!   official deployment leaves it unset and FALLS BACK to the feedback
//!   pipeline's `TURNSTILE_SITEKEY` (one widget, no new var); a
//!   self-host sets its own.
//! - `GATEWAY_TURNSTILE_SECRET` (secret) — siteverify; falls back to
//!   `TURNSTILE_SECRET`. Required iff Turnstile is on, else 503.
//! - `GATEWAY_PASSWORD` (secret, optional) — absent ⇒ password off.
//! - `GATEWAY_NOTICE` (var, optional) — rides the health document.
//! - `GATEWAY_KV` (KV binding) — the `battle:<route>` mirror (TTL 1 h).
//!   The official wrangler.toml binds it to the EXISTING FEEDBACK_KV
//!   namespace (two bindings, one namespace — legal; see the comment
//!   there); self-hosts create their own.

use std::cell::RefCell;
use std::rc::Rc;

use futures_util::StreamExt;
use relay_core::gateway::{
    AuthState, ChannelState, ConsumeError, CredentialMissing, GatewayVars, KEEPALIVE_INTERVAL_MS,
    SNAPSHOT_KV_TTL_SECS, TICKET_TTL_MS, TicketEntry, TicketKind, TicketRng, battle_frame_verdict,
    battle_route, check_credentials, frame_kind, health_doc, hello_frame, host_frame,
    keepalive_frame, password_key, password_matches, subs_frame, ticket_key, valid_route_id,
    valid_ticket,
};
use relay_core::room::FrameVerdict;
use relay_core::route::{Route, classify, query_get};
use relay_core::valid_host_id;
use serde_json::{Value, json};
use worker::{WebsocketEvent, *};

/// KV binding name (wrangler.toml `kv_namespaces`).
pub(crate) const KV: &str = "GATEWAY_KV";
/// Singleton name of the GatewayAuth DO.
const AUTH_NAME: &str = "auth";
/// Cloudflare's Turnstile siteverify endpoint (same call the feedback
/// pipeline makes; reuse of its helpers keeps one outbound-HTTP door).
const SITEVERIFY: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/// /gateway/session body cap (the JSON carries ids + one captcha token).
const SESSION_BODY_MAX: usize = 8 * 1024;
/// WS close code for oversized battle frames (contract §3.3).
const CLOSE_MESSAGE_TOO_BIG: u16 = 1009;
/// WS close code for a normal teardown (publisher replaced).
const CLOSE_NORMAL: u16 = 1000;

// ── health ─────────────────────────────────────────────────────────────

/// GET /gateway/health — the deployment config document: no auth,
/// CORS-open (the phone app fetches via a Rust command, but browsers
/// may too), edge-cached for 60 s.
pub fn handle_health(req: Request, env: &Env) -> Result<Response> {
    match req.method() {
        Method::Get => {
            let doc = health_doc(&gateway_vars(env));
            let mut resp = Response::from_json(&doc)?;
            resp.headers_mut()
                .set("Cache-Control", "public, max-age=60")?;
            resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
            Ok(resp)
        },
        Method::Options => cors_preflight(),
        _ => err(405, "method_not_allowed"),
    }
}

/// The deployment's gateway config from vars/secrets. Sitekey falls
/// back to the feedback widget's `TURNSTILE_SITEKEY` (official node);
/// password reflects the `GATEWAY_PASSWORD` secret.
fn gateway_vars(env: &Env) -> GatewayVars {
    let var = |name: &str| env.var(name).ok().map(|v| v.to_string());
    let sitekey = var("GATEWAY_TURNSTILE_SITEKEY").or_else(|| var("TURNSTILE_SITEKEY"));
    let password_required = env
        .secret("GATEWAY_PASSWORD")
        .ok()
        .map(|s| s.to_string())
        .is_some_and(|s| !s.is_empty());
    GatewayVars::from_raw(
        sitekey.as_deref(),
        password_required,
        var("GATEWAY_NOTICE").as_deref(),
    )
}

/// The siteverify secret: gateway-dedicated first, feedback's fallback.
fn turnstile_secret(env: &Env) -> Option<String> {
    env.secret("GATEWAY_TURNSTILE_SECRET")
        .ok()
        .map(|s| s.to_string())
        .or_else(|| env.secret("TURNSTILE_SECRET").ok().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
}

// ── /gateway/session ───────────────────────────────────────────────────

/// POST /gateway/session — verify EXACTLY what the health document
/// demands and mint a single-use ticket:
/// route id → IP lock gate (429) → credential presence (400) →
/// Turnstile siteverify (403) → password constant-time compare (403,
/// failure counted) → ticket (200).
pub async fn handle_session(mut req: Request, env: Env) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Post => {},
        _ => return err(405, "method_not_allowed"),
    }

    // Content-Length is REQUIRED, not just a pre-check: a chunked body
    // would otherwise buffer in full before the cap could refuse it
    // (same audit-driven shape as the feedback submit handler).
    let Some(len) = req
        .headers()
        .get("Content-Length")?
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return err(411, "length_required");
    };
    if len > SESSION_BODY_MAX {
        return err(413, "payload_too_large");
    }
    let body = req.bytes().await?;
    if body.len() > SESSION_BODY_MAX {
        return err(413, "payload_too_large");
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err(400, "bad_json"),
    };
    let field = |name: &str| {
        payload
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let Some(route) = field("route") else {
        return err(400, "bad_route");
    };
    if !valid_route_id(route) {
        return err(400, "bad_route");
    }
    let turnstile_token = field("cf-turnstile-response");
    let password = field("password");
    let ip = crate::feedback::client_ip(&req);

    let vars = gateway_vars(&env);

    // 1. Password lockout gate — refuses before the siteverify call so
    //    a locked IP cannot burn third-party quota.
    if let Some(retry_secs) = auth_gate(&env, &ip).await? {
        return rate_limited(retry_secs);
    }

    // 2. Presence of exactly what health demands.
    if let Err(missing) = check_credentials(&vars, turnstile_token, password) {
        return match missing {
            CredentialMissing::Turnstile => err(400, "missing_captcha"),
            CredentialMissing::Password => err(400, "missing_password"),
        };
    }

    // 3. Turnstile — demanded ⇒ the secret must exist (a widget without
    //    its verification key is a maintenance state, not an open gate).
    let mut turnstile_ok = false;
    if vars.turnstile_required() {
        let Some(secret) = turnstile_secret(&env) else {
            return err(503, "maintenance");
        };
        let headers = Headers::new();
        headers.set("Content-Type", "application/x-www-form-urlencoded")?;
        let mut resp = match crate::feedback::http_call(
            Method::Post,
            SITEVERIFY,
            headers,
            Some(
                relay_core::feedback::turnstile_verify_body(
                    &secret,
                    turnstile_token.unwrap_or_default(),
                    &ip,
                )
                .into_bytes(),
            ),
        )
        .await
        {
            Ok(resp) => resp,
            Err(_) => return err(502, "captcha_unreachable"),
        };
        let verdict: Value = resp.json().await.unwrap_or(Value::Null);
        if !relay_core::feedback::turnstile_passed(&verdict) {
            return err(403, "captcha");
        }
        turnstile_ok = true;
    }

    // 4. Password — constant-time compare against the secret; a failure
    //    is counted in the auth DO and the 5th inside the window locks.
    let mut password_ok = false;
    if vars.password_required {
        let expected = env
            .secret("GATEWAY_PASSWORD")
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if !password_matches(&expected, password.unwrap_or_default()) {
            if let Some(retry_secs) = auth_pwfail(&env, &ip).await? {
                return rate_limited(retry_secs);
            }
            return err(403, "password");
        }
        password_ok = true;
    }

    // 5. Mint the single-use ticket (route-bound, 120 s TTL).
    let kind = TicketKind::from_flags(turnstile_ok, password_ok);
    let mut minted =
        auth_fetch(&env, &format!("/mint?route={route}&kind={}", kind.as_str())).await?;
    if minted.status_code() != 200 {
        return err(503, "ticket_unavailable");
    }
    let v: Value = minted.json().await.unwrap_or(Value::Null);
    let ticket = v.get("ticket").and_then(Value::as_str).map(str::to_string);
    match ticket {
        Some(ticket) if valid_ticket(&ticket) => {
            let mut resp = Response::from_json(&json!({
                "ticket": ticket,
                "route": route,
                "ttl": TICKET_TTL_MS / 1000,
            }))?;
            resp.headers_mut().set("Cache-Control", "no-store")?;
            resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
            Ok(resp)
        },
        _ => err(503, "ticket_unavailable"),
    }
}

// ── WS upgrade (pub/sub) ───────────────────────────────────────────────

/// WS /gateway/pub?route=&ticket=[&hostId=] — validate, consume the
/// single-use ticket HERE (a channel refusal still burns it), then
/// forward the untouched upgrade into the route's GatewayChannel DO.
pub async fn handle_pub(
    req: Request,
    env: Env,
    route: Option<&str>,
    ticket: Option<&str>,
    host_id: Option<&str>,
) -> Result<Response> {
    upgrade(req, env, route, ticket, host_id).await
}

/// WS /gateway/sub?route=&ticket= — same consume-then-forward flow.
pub async fn handle_sub(
    req: Request,
    env: Env,
    route: Option<&str>,
    ticket: Option<&str>,
) -> Result<Response> {
    upgrade(req, env, route, ticket, None).await
}

async fn upgrade(
    req: Request,
    env: Env,
    route: Option<&str>,
    ticket: Option<&str>,
    host_id: Option<&str>,
) -> Result<Response> {
    if req.method() != Method::Get {
        return Response::error("websocket upgrade requires GET", 405);
    }
    let Some(route) = route.filter(|r| valid_route_id(r)) else {
        return Response::error("bad route id", 400);
    };
    let Some(ticket) = ticket.filter(|t| valid_ticket(t)) else {
        return Response::error("bad ticket", 400);
    };
    if let Some(host_id) = host_id {
        if !valid_host_id(host_id) {
            return Response::error("bad host id", 400);
        }
    }
    let consumed = auth_fetch(&env, &format!("/consume?ticket={ticket}&route={route}")).await?;
    if consumed.status_code() != 200 {
        return Response::error("invalid ticket", 401);
    }
    let stub = env
        .durable_object("GATEWAY_CHANNEL")?
        .id_from_name(route)?
        .get_stub()?;
    stub.fetch_with_request(req).await
}

// ── GatewayAuth DO plumbing (worker side) ──────────────────────────────

/// One internal call into the auth DO (single request shape: GET + query).
async fn auth_fetch(env: &Env, path_query: &str) -> Result<Response> {
    let stub = env
        .durable_object("GATEWAY_AUTH")?
        .id_from_name(AUTH_NAME)?
        .get_stub()?;
    stub.fetch_with_str(&format!("https://auth{path_query}"))
        .await
}

/// Remaining lock (SECONDS, rounded up) for `ip`, `None` when open.
async fn auth_gate(env: &Env, ip: &str) -> Result<Option<u64>> {
    auth_retry_after(env, "/gate", ip).await
}

/// Record one password failure; `Some(seconds)` when this call leaves
/// the IP locked (the tripping request is itself refused).
async fn auth_pwfail(env: &Env, ip: &str) -> Result<Option<u64>> {
    auth_retry_after(env, "/pwfail", ip).await
}

async fn auth_retry_after(env: &Env, path: &str, ip: &str) -> Result<Option<u64>> {
    let mut resp = auth_fetch(env, &format!("{path}?ip={ip}")).await?;
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    Ok(v.get("retryAfterMs")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .map(|ms| (ms + 999) / 1000))
}

// ── shared response helpers ────────────────────────────────────────────

/// JSON error body in the feedback pipeline's shape, plus the CORS
/// open door (the session/health surface is cross-origin by design).
fn err(status: u16, code: &str) -> Result<Response> {
    let mut resp = Response::from_json(&json!({ "ok": false, "error": code }))?;
    resp.headers_mut().set("Cache-Control", "no-store")?;
    resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
    Ok(resp.with_status(status))
}

/// 429 with the contract's retryAfter — in the body AND the standard
/// Retry-After header.
fn rate_limited(retry_after_secs: u64) -> Result<Response> {
    let mut resp = Response::from_json(&json!({
        "ok": false,
        "error": "rate_limited",
        "retryAfter": retry_after_secs,
    }))?
    .with_status(429);
    resp.headers_mut().set("Cache-Control", "no-store")?;
    resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
    resp.headers_mut()
        .set("Retry-After", &retry_after_secs.to_string())?;
    Ok(resp)
}

/// CORS preflight (OPTIONS on /gateway/health and /gateway/session).
fn cors_preflight() -> Result<Response> {
    let mut resp = Response::empty()?.with_status(204);
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;
    headers.set("Access-Control-Max-Age", "600")?;
    Ok(resp)
}

// ── GatewayAuth: tickets + password counters (singleton) ───────────────

/// CSPRNG over workerd's `crypto.getRandomValues` (getrandom's wasm
/// JavaScript backend) — the worker side of relay-core's `TicketRng`
/// seam, mirroring the directory's `SystemCodeRng`.
pub struct SystemTicketRng;

impl TicketRng for SystemTicketRng {
    fn ticket_bytes(&mut self) -> [u8; 16] {
        let mut buf = [0u8; 16];
        getrandom::fill(&mut buf).expect("workerd crypto.getRandomValues unavailable");
        buf
    }
}

/// Durable Object state hydrates lazily from storage rows into the pure
/// [`AuthState`] machine and write-throughs every mutation — the same
/// discipline as the code Directory.
#[durable_object]
pub struct GatewayAuth {
    state: State,
    auth: Rc<RefCell<Option<AuthState>>>,
}

impl DurableObject for GatewayAuth {
    fn new(state: State, _env: Env) -> Self {
        Self {
            state,
            auth: Rc::new(RefCell::new(None)),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        self.ensure_loaded().await?;
        let url = req.url()?;
        let query = url.query().unwrap_or("").to_string();
        match url.path() {
            "/mint" => self.mint(&query).await,
            "/consume" => self.consume(&query).await,
            "/gate" => self.gate(&query).await,
            "/pwfail" => self.pwfail(&query).await,
            _ => Response::error("not found", 404),
        }
    }

    /// Expiry sweep: drop dead rows, re-arm to the next deadline, or
    /// clear the alarm when nothing is left.
    async fn alarm(&self) -> Result<Response> {
        self.ensure_loaded().await?;
        let now = Date::now().as_millis();
        let removed = {
            let mut slot = self.auth.borrow_mut();
            let Some(auth) = slot.as_mut() else {
                return not_hydrated();
            };
            auth.sweep(now).0
        };
        if !removed.is_empty() {
            let _ = self.state.storage().delete_multiple(removed).await;
        }
        let next = {
            let slot = self.auth.borrow();
            let Some(auth) = slot.as_ref() else {
                return not_hydrated();
            };
            auth.next_deadline()
        };
        self.arm_alarm(next).await;
        Response::ok("swept")
    }
}

impl GatewayAuth {
    async fn ensure_loaded(&self) -> Result<()> {
        if self.auth.borrow().is_some() {
            return Ok(());
        }
        let map = self.state.storage().list().await?;
        let mut tickets: Vec<(String, TicketEntry)> = Vec::new();
        let mut passwords: Vec<(String, relay_core::gateway::PasswordRate)> = Vec::new();
        for pair in map.entries() {
            let Ok(pair) = pair else { continue };
            let pair = js_sys::Array::from(&pair);
            let Some(key) = pair.get(0).as_string() else {
                continue;
            };
            let value = pair.get(1);
            if let Some(ticket) = key.strip_prefix("t:") {
                if let Ok(entry) = serde_wasm_bindgen::from_value::<TicketEntry>(value) {
                    tickets.push((ticket.to_string(), entry));
                }
            } else if let Some(ip) = key.strip_prefix("p:") {
                if let Ok(row) =
                    serde_wasm_bindgen::from_value::<relay_core::gateway::PasswordRate>(value)
                {
                    passwords.push((ip.to_string(), row));
                }
            }
        }
        *self.auth.borrow_mut() = Some(AuthState::restore(tickets, passwords));
        Ok(())
    }

    async fn mint(&self, query: &str) -> Result<Response> {
        let Some(route) = query_get(query, "route").filter(|r| valid_route_id(r)) else {
            return Response::error("bad route id", 400);
        };
        let kind = query_get(query, "kind")
            .and_then(|k| k.parse().ok())
            .unwrap_or(TicketKind::None);
        let now = Date::now().as_millis();
        let mut rng = SystemTicketRng;
        let (ticket, entry) = {
            let mut slot = self.auth.borrow_mut();
            let Some(auth) = slot.as_mut() else {
                return not_hydrated();
            };
            auth.mint(now, &mut rng, &route, kind)
        };
        let _ = self
            .state
            .storage()
            .put(&ticket_key(&ticket), entry.clone())
            .await;
        self.arm_if_idle(entry.expires_at).await;
        Response::from_json(&json!({ "ticket": ticket, "ttl": TICKET_TTL_MS / 1000 }))
    }

    async fn consume(&self, query: &str) -> Result<Response> {
        let Some(ticket) = query_get(query, "ticket").filter(|t| valid_ticket(t)) else {
            return Response::error("bad ticket", 400);
        };
        let Some(route) = query_get(query, "route").filter(|r| valid_route_id(r)) else {
            return Response::error("bad route id", 400);
        };
        let now = Date::now().as_millis();
        let outcome = {
            let mut slot = self.auth.borrow_mut();
            let Some(auth) = slot.as_mut() else {
                return not_hydrated();
            };
            auth.consume(now, &ticket, &route)
        };
        // The pure machine removed the row for every spent/expired/
        // mismatched outcome; mirror it (Unknown never had a row).
        if !matches!(outcome, Err(ConsumeError::Unknown)) {
            let _ = self.state.storage().delete(&ticket_key(&ticket)).await;
        }
        match outcome {
            Ok(()) => Response::ok("consumed"),
            Err(ConsumeError::Unknown) | Err(ConsumeError::Expired) => {
                Response::error("unknown ticket", 404)
            },
            Err(ConsumeError::RouteMismatch) => Response::error("ticket route mismatch", 409),
        }
    }

    async fn gate(&self, query: &str) -> Result<Response> {
        let ip = query_get(query, "ip").unwrap_or("unknown");
        let now = Date::now().as_millis();
        let retry = {
            let mut slot = self.auth.borrow_mut();
            let Some(auth) = slot.as_mut() else {
                return not_hydrated();
            };
            auth.lock_remaining(now, ip)
        };
        Response::from_json(&json!({
            "locked": retry.is_some(),
            "retryAfterMs": retry.unwrap_or(0),
        }))
    }

    async fn pwfail(&self, query: &str) -> Result<Response> {
        let ip = query_get(query, "ip").unwrap_or("unknown");
        let now = Date::now().as_millis();
        let retry = {
            let mut slot = self.auth.borrow_mut();
            let Some(auth) = slot.as_mut() else {
                return not_hydrated();
            };
            auth.password_failed(now, ip)
        };
        // Write the (possibly emptied) row through and keep the sweep
        // alarm aware of the lock's deadline.
        let row = {
            let slot = self.auth.borrow();
            let Some(auth) = slot.as_ref() else {
                return not_hydrated();
            };
            auth.password_row(ip).cloned()
        };
        let storage = self.state.storage();
        let mut deadline = None;
        match row {
            Some(row) => {
                deadline = row.dead_at();
                if row.is_empty() {
                    let _ = storage.delete(&password_key(ip)).await;
                } else {
                    let _ = storage.put(&password_key(ip), row).await;
                }
            },
            None => {
                let _ = storage.delete(&password_key(ip)).await;
            },
        }
        if let Some(deadline) = deadline {
            self.arm_if_idle(deadline).await;
        }
        Response::from_json(&json!({
            "locked": retry.is_some(),
            "retryAfterMs": retry.unwrap_or(0),
        }))
    }

    /// Arm the sweep alarm unless one is already pending (the sweep
    /// re-arms to the true next deadline; an early deadline merely gets
    /// swept a little late, which the expiry checks tolerate).
    async fn arm_if_idle(&self, deadline: u64) {
        let storage = self.state.storage();
        if storage.get_alarm().await.ok().flatten().is_none() {
            self.arm_alarm(Some(deadline)).await;
        }
    }

    async fn arm_alarm(&self, next: Option<u64>) {
        let storage = self.state.storage();
        match next {
            Some(deadline) => {
                let _ = storage.set_alarm(deadline as i64 + 1_000).await;
            },
            None => {
                let _ = storage.delete_alarm().await;
            },
        }
    }
}

// ── GatewayChannel: one route's pub/sub fan-out ────────────────────────

/// Live socket + policy state of one channel. The pure half lives in
/// [`ChannelState`]; the sockets and route key live here, mirroring
/// how the Room DO wraps [`RoomConns`].
#[derive(Default)]
struct ChannelInner {
    chan: ChannelState,
    host: Option<WebSocket>,
    subs: Vec<WebSocket>,
    hydrated: bool,
}

/// The channel DO's single persisted row key (last battle snapshot).
const SNAPSHOT_KEY: &str = "snap";

#[durable_object]
pub struct GatewayChannel {
    state: State,
    env: Env,
    inner: Rc<RefCell<ChannelInner>>,
}

impl DurableObject for GatewayChannel {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            inner: Rc::new(RefCell::new(ChannelInner::default())),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        if req.method() != Method::Get {
            return Response::error("websocket upgrade requires GET", 405);
        }
        let url = req.url()?;
        let query = url.query().unwrap_or("").to_string();
        let path = url.path().to_string();
        // The worker consumed the ticket before forwarding; the DO
        // re-validates the route id (defense in depth) and classifies
        // the untouched /gateway/pub|sub path.
        match classify(&path, &query) {
            Route::GatewayPub { route, host_id, .. } => self.pub_connect(route, host_id).await,
            Route::GatewaySub { route, .. } => self.sub_connect(route).await,
            _ => Response::error("not found", 404),
        }
    }

    /// Retention expiry: clear an expired snapshot (a phone joining
    /// later sees host presence only), then re-arm or disarm.
    async fn alarm(&self) -> Result<Response> {
        self.ensure_loaded().await?;
        let now = Date::now().as_millis();
        let expired = self.inner.borrow_mut().chan.sweep(now);
        if expired {
            let _ = self.state.storage().delete(SNAPSHOT_KEY).await;
        }
        let next = self.inner.borrow().chan.retention_deadline();
        let storage = self.state.storage();
        match next {
            Some(deadline) => {
                let _ = storage.set_alarm(deadline as i64 + 1_000).await;
            },
            None => {
                let _ = storage.delete_alarm().await;
            },
        }
        Response::ok("swept")
    }
}

impl GatewayChannel {
    /// Hydrate the retained snapshot from storage once (double-checked
    /// after the await so two concurrent fetches cannot race the flag).
    async fn ensure_loaded(&self) -> Result<()> {
        if self.inner.borrow().hydrated {
            return Ok(());
        }
        let snap: Option<relay_core::gateway::SnapshotRow> =
            self.state.storage().get(SNAPSHOT_KEY).await.ok().flatten();
        let now = Date::now().as_millis();
        let mut inner = self.inner.borrow_mut();
        if inner.hydrated {
            return Ok(());
        }
        inner.chan = ChannelState::restore(snap, now);
        inner.hydrated = true;
        Ok(())
    }

    // ── publisher ────────────────────────────────────────────────────

    async fn pub_connect(&self, route: Option<&str>, host_id: Option<&str>) -> Result<Response> {
        let Some(route) = route.filter(|r| valid_route_id(r)) else {
            return Response::error("bad route id", 400);
        };
        if let Some(host_id) = host_id {
            if !valid_host_id(host_id) {
                return Response::error("bad host id", 400);
            }
        }
        self.ensure_loaded().await?;

        let pair = WebSocketPair::new()?;
        let server = pair.server.clone();
        server.accept()?;
        {
            // Decide the host slot under the same borrow that registers
            // it (check-then-act atomic on the single-threaded runtime).
            let mut inner = self.inner.borrow_mut();
            inner.chan.host_connect(host_id);
        }
        // One publisher per channel: the newcomer replaces whoever held
        // the slot (a different persistent hostId wins, mirroring the
        // directory's one-code rule; the old socket's reader teardown
        // sees it is no longer the registered host and stays quiet).
        let previous = self.inner.borrow_mut().host.replace(server.clone());
        if let Some(old) = previous {
            let _ = old.close(Some(CLOSE_NORMAL), Some("replaced by a new host"));
        }
        let _ = server.send_with_str(&hello_frame("pub"));
        let snapshot = self.inner.borrow().chan.snapshot().cloned();
        if let Some(snap) = snapshot {
            let _ = server.send_with_str(&snap.frame);
        }
        broadcast_host(&self.inner, true);
        // A fresh publisher learns the current subscriber count up front
        // (phones may already be parked on the channel).
        broadcast_subs(&self.inner);
        self.spawn_host_reader(server.clone(), route.to_string());
        spawn_pinger(server);
        Ok(Response::from_websocket(pair.client)?)
    }

    /// The desktop publisher's socket: battle frames (size-capped,
    /// route-checked) fan out verbatim and re-arm the snapshot; `bye`
    /// fans out and starts the grace window; anything else is tolerated
    /// chatter (keepalive included).
    fn spawn_host_reader(&self, server: WebSocket, route: String) {
        let inner = self.inner.clone();
        let storage = Rc::new(self.state.storage());
        let env = self.env.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let mut events = match server.events() {
                Ok(events) => events,
                Err(_) => return,
            };
            while let Some(Ok(event)) = events.next().await {
                let WebsocketEvent::Message(msg) = event else {
                    break;
                };
                let Some(text) = msg.text() else { continue };
                let now = Date::now().as_millis();
                match frame_kind(&text) {
                    Some("battle") => {
                        if matches!(
                            battle_frame_verdict(text.len()),
                            FrameVerdict::TooLarge { .. }
                        ) {
                            let _ = server
                                .close(Some(CLOSE_MESSAGE_TOO_BIG), Some("battle frame too large"));
                            break;
                        }
                        // A battle frame naming a different route would
                        // corrupt subscribers' rosters — dropped.
                        if battle_route(&text).is_some_and(|claimed| claimed != route) {
                            continue;
                        }
                        let (deadline, row) = {
                            let mut inner = inner.borrow_mut();
                            let deadline = inner.chan.publish(now, text.clone());
                            (deadline, inner.chan.snapshot().cloned())
                        };
                        if let Some(row) = row {
                            let _ = storage.put(SNAPSHOT_KEY, row).await;
                        }
                        mirror_battle(&env, &route, &text);
                        arm_if_idle(&storage, deadline).await;
                        broadcast(&inner, &text);
                    },
                    Some("bye") => {
                        let (deadline, row) = {
                            let mut inner = inner.borrow_mut();
                            let deadline = inner.chan.bye(now);
                            (deadline, inner.chan.snapshot().cloned())
                        };
                        if let Some(row) = row {
                            let _ = storage.put(SNAPSHOT_KEY, row).await;
                        }
                        if let Some(deadline) = deadline {
                            arm_if_idle(&storage, deadline).await;
                        }
                        broadcast(&inner, &text);
                    },
                    _ => {},
                }
            }
            // The publisher's socket went away (close or error). Only
            // the REGISTERED host announces offline — a replaced host
            // exiting must not shadow its successor.
            let was_host = {
                let mut inner = inner.borrow_mut();
                if inner.host.as_ref() == Some(&server) {
                    inner.host = None;
                    inner.chan.host_gone();
                    true
                } else {
                    false
                }
            };
            if was_host {
                broadcast_host(&inner, false);
            }
        });
    }

    // ── subscribers ──────────────────────────────────────────────────

    async fn sub_connect(&self, route: Option<&str>) -> Result<Response> {
        let Some(route) = route.filter(|r| valid_route_id(r)) else {
            return Response::error("bad route id", 400);
        };
        self.ensure_loaded().await?;
        let joined = {
            let mut inner = self.inner.borrow_mut();
            inner.chan.sub_join()
        };
        if joined.is_err() {
            return Response::error("subscriber limit reached", 409);
        }

        let pair = WebSocketPair::new()?;
        let server = pair.server.clone();
        server.accept()?;
        self.inner.borrow_mut().subs.push(server.clone());

        // hello → host presence → the current battle snapshot (live from
        // storage, else best-effort the KV mirror's stale copy).
        let _ = server.send_with_str(&hello_frame("sub"));
        let (host_up, snapshot) = {
            let inner = self.inner.borrow();
            (inner.host.is_some(), inner.chan.snapshot().cloned())
        };
        let _ = server.send_with_str(&host_frame(host_up));
        if let Some(snap) = snapshot {
            let _ = server.send_with_str(&snap.frame);
        } else if let Some(stale) = kv_stale_snapshot(&self.env, route).await {
            let _ = server.send_with_str(&stale);
        }
        self.spawn_sub_reader(server.clone());
        spawn_pinger(server);
        // A phone just joined: tell the publisher (tray indicator).
        broadcast_subs(&self.inner);
        Ok(Response::from_websocket(pair.client)?)
    }

    /// A subscriber's socket: inbound text is tolerated (30 s keepalives
    /// from the phone) and never forwarded; the read loop exists to
    /// notice the close and free the slot.
    fn spawn_sub_reader(&self, server: WebSocket) {
        let inner = self.inner.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let mut events = match server.events() {
                Ok(events) => events,
                Err(_) => return,
            };
            while let Some(Ok(event)) = events.next().await {
                if !matches!(event, WebsocketEvent::Message(_)) {
                    break;
                }
            }
            {
                let mut inner = inner.borrow_mut();
                inner.subs.retain(|ws| ws != &server);
                inner.chan.sub_leave();
            }
            // A phone left: the publisher's count follows (the borrow
            // above is dropped first — broadcast_subs re-borrows).
            broadcast_subs(&inner);
        });
    }
}

// ── channel helpers ────────────────────────────────────────────────────

/// Fan one text frame out to every live subscriber, verbatim.
fn broadcast(inner: &RefCell<ChannelInner>, text: &str) {
    for ws in &inner.borrow().subs {
        let _ = ws.send_with_str(text);
    }
}

/// Host-presence transition to every live subscriber.
fn broadcast_host(inner: &RefCell<ChannelInner>, online: bool) {
    broadcast(inner, &host_frame(online));
}

/// Tell the PUBLISHER how many phones are currently subscribed — the
/// desktop tray's "phone linked" indicator. Host-only: subscribers never
/// see this frame, and it is a no-op while no host holds the slot.
fn broadcast_subs(inner: &RefCell<ChannelInner>) {
    let guard = inner.borrow();
    let Some(host) = guard.host.as_ref() else {
        return;
    };
    let _ = host.send_with_str(&subs_frame(guard.subs.len()));
}

/// Server-side keepalive: one text ping every 30 s per socket (the
/// contract pings BOTH directions; Cloudflare drops idle proxied
/// sockets at ~100 s). The loop dies with the socket's first send error.
fn spawn_pinger(server: WebSocket) {
    wasm_bindgen_futures::spawn_local(async move {
        loop {
            Delay::from(std::time::Duration::from_millis(KEEPALIVE_INTERVAL_MS)).await;
            if server.send_with_str(&keepalive_frame()).is_err() {
                break;
            }
        }
    });
}

/// Mirror the newest battle frame into KV (`battle:<route>`, TTL 1 h),
/// fire-and-forget: every error is swallowed — the DO storage row is
/// the authoritative snapshot, KV only serves cold starts.
fn mirror_battle(env: &Env, route: &str, frame: &str) {
    let Ok(kv) = env.kv(KV) else { return };
    let key = format!("battle:{route}");
    let value = frame.to_string();
    wasm_bindgen_futures::spawn_local(async move {
        if let Ok(put) = kv.put(&key, value) {
            let _ = put.expiration_ttl(SNAPSHOT_KV_TTL_SECS).execute().await;
        }
    });
}

/// Best-effort stale snapshot from the KV mirror (`None` on any miss:
/// binding absent, quota, or empty row).
async fn kv_stale_snapshot(env: &Env, route: &str) -> Option<String> {
    let kv = env.kv(KV).ok()?;
    let text = kv.get(&format!("battle:{route}")).text().await.ok()??;
    (!text.is_empty()).then_some(text)
}

/// Arm the retention alarm unless one is already pending.
async fn arm_if_idle(storage: &Storage, deadline: u64) {
    if storage.get_alarm().await.ok().flatten().is_none() {
        let _ = storage.set_alarm(deadline as i64 + 1_000).await;
    }
}

/// The (structurally unreachable) not-hydrated guard, same convention
/// as the code Directory.
fn not_hydrated() -> Result<Response> {
    Response::error("gateway auth unavailable", 500)
}
