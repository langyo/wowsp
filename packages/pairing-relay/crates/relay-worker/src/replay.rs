//! Replay-share endpoints — the I/O half of the /api/replays/* surface.
//! Policy (wanted-ruleset parsing, facts plausibility, verdict
//! precedence, manifest validation, quota/key layout, the ledger state
//! machine) lives in [`relay_core::replay`]; this module owns the
//! request plumbing: FEEDBACK_KV (wanted doc + rate-limit counters),
//! the REPLAY_R2 bucket (per-contributor tar.zst shards, streamed both
//! ways — the upload body is NEVER buffered), and the JSON exchange
//! with the singleton `ReplayIndex` Durable Object
//! (see src/replay_index.rs).
//!
//! Auth (contract §3): no accounts — `x-anon-id` (uuid v4) +
//! `x-upload-token` headers; the first successful upload registers
//! sha256(token) in the ledger. Upload mismatch → 409
//! `anon_exists_token_mismatch`; /mine + /archive mismatch → 403.
//!
//! Admin (drain) routes gate on the same erp session cookie as the
//! feedback console (allowlist union incl. FEEDBACK_ADMIN_OPEN_ID).

use relay_core::replay::{
    self, ManifestError, WantedDoc, WantedRule, b64url_decode, day_bucket, day_retry_after_secs,
    parse_manifest, parse_wanted_doc, rl_archive_key, rl_check_key, rl_upload_keys, shard_key,
    token_hash, valid_anon_id, valid_hex64, valid_upload_token,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{
    Date, Env, FixedLengthStream, Headers, KvStore, Method, Request, RequestInit, Response, Result,
    Stub, js_sys,
};

use crate::feedback::{client_ip, err, ok};

/// KV binding (shared with the feedback pipeline).
const KV: &str = "FEEDBACK_KV";
/// R2 binding (wrangler.toml `r2_buckets`).
const R2: &str = "REPLAY_R2";
/// DO binding + singleton name (wrangler.toml durable_objects).
const DO: &str = "REPLAY_INDEX";
const DO_NAME: &str = "index";

/// KV TTL floor is 60s; day counters get window + slack (same as the
/// feedback rate limits).
const TTL_DAY: u64 = 86_460;
/// Hard cap on a /check request body (400 facts × ~600 B + slack).
const CHECK_BODY_MAX: usize = 4 * 1024 * 1024;
/// Hard cap on a drain batch (one console selection).
const DRAIN_BATCH_MAX: usize = 1000;
/// Retry-After served with a 503 watermark (nothing resets it but a
/// maintainer drain; an hour keeps clients polite).
const WATERMARK_RETRY_AFTER: u64 = 3600;

// ── DO face envelopes (shared with src/replay_index.rs) ───────────────

/// POST /check body.
#[derive(Serialize, Deserialize)]
pub(crate) struct DoCheck {
    pub anon: Option<String>,
    pub facts: Vec<relay_core::replay::ReplayFacts>,
    pub rules: Vec<WantedRule>,
}

/// POST /claim body — `phase` is "prepare" (dry-run before the R2
/// write) or "commit" (re-validate + ledger transaction).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoClaim {
    pub phase: String,
    pub anon: String,
    pub thash: String,
    pub credited_name: String,
    pub realm: String,
    pub archive_bytes: u64,
    pub members: Vec<relay_core::replay::ManifestMember>,
    pub rules: Vec<WantedRule>,
}

/// POST /drain body.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoDrain {
    pub anon_ids: Vec<String>,
}

/// POST /rename body.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoRename {
    pub anon: String,
    pub name: String,
}

/// POST /backfill body.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoBackfill {
    pub anon: String,
    pub name: String,
    pub realm: String,
    pub members: Vec<relay_core::replay::BackfillMember>,
}

// ── DO plumbing ────────────────────────────────────────────────────────

async fn index_stub(env: &Env) -> Result<Stub> {
    env.durable_object(DO)?.id_from_name(DO_NAME)?.get_stub()
}

async fn do_get(env: &Env, path_and_query: &str) -> Result<Response> {
    index_stub(env)
        .await?
        .fetch_with_str(&format!("https://replay-index{path_and_query}"))
        .await
}

async fn do_post<T: Serialize>(env: &Env, path: &str, body: &T) -> Result<Response> {
    let bytes = serde_json::to_vec(body)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    init.with_headers(headers);
    init.with_body(Some(js_sys::Uint8Array::from(bytes.as_slice()).into()));
    let req = Request::new_with_init(&format!("https://replay-index{path}"), &init)?;
    index_stub(env).await?.fetch_with_request(req).await
}

/// The parsed wanted doc from FEEDBACK_KV (`None` = collection closed).
async fn wanted_doc(env: &Env) -> Result<Option<WantedDoc>> {
    let kv = env.kv(KV)?;
    let raw = kv.get(replay::KV_WANTED_KEY).text().await.ok().flatten();
    Ok(raw.as_deref().and_then(parse_wanted_doc))
}

/// Spend one KV rate-limit counter (same pattern as the feedback
/// pipeline): read + 1, refuse past the limit, write with a day TTL
/// otherwise. Shared with the other public GET routes (audit M-10).
///
/// The write is FAIL-CLOSED (audit M-10 revision, after the 2026-10-22
/// quota incident): a flood that exhausts the daily KV write budget
/// flips a fail-open limiter off at the exact moment it is under attack,
/// and the then-unthrottled reads burn the read budget too (the
/// incident's fleet-polling shape). A failing counter write now answers
/// `false` — the route serves its 429 + Retry-After instead of flowing
/// unthrottled. Public GETs do lose availability under a KV write
/// outage; that is the cheaper failure, because edge-cached responses
/// (digests) keep serving and the polite clients the Retry-After
/// reaches are exactly the ones worth serving.
pub(crate) async fn spend(kv: &KvStore, key: &str, limit: u64) -> Result<bool> {
    let count: u64 = kv.get(key).json::<u64>().await.ok().flatten().unwrap_or(0) + 1;
    if count > limit {
        return Ok(false);
    }
    if kv
        .put(key, count)?
        .expiration_ttl(TTL_DAY)
        .execute()
        .await
        .is_err()
    {
        return Ok(false);
    }
    Ok(true)
}

/// The shared public-read budget (audit M-10): one scope/IP/hour counter
/// in FEEDBACK_KV. Best-effort — a missing KV binding answers allowed
/// rather than breaking the route.
pub(crate) async fn spend_public_read(env: &Env, scope: &str, ip: &str) -> Result<bool> {
    let Ok(kv) = env.kv(KV) else {
        return Ok(true);
    };
    spend(
        &kv,
        &replay::public_read_rate_key(scope, ip, now_ms()),
        replay::RATE_PUBLIC_READ_PER_HOUR,
    )
    .await
}

/// 429/503 with a Retry-After header (the plain `err` helper has no
/// header support). Shared with the other public GET routes (audit
/// M-10) so every refusal carries the same JSON + Retry-After shape.
pub(crate) fn err_retry(status: u16, code: &str, retry_after: u64) -> Result<Response> {
    let mut resp = Response::from_json(&json!({ "ok": false, "error": code }))?;
    resp.headers_mut().set("Cache-Control", "no-store")?;
    resp.headers_mut()
        .set("Retry-After", &retry_after.to_string())?;
    Ok(resp.with_status(status))
}

/// An error the DO already shaped for the client (422 rejected /
/// dropped_members carry detail arrays) — re-serve it with the DO's
/// status, optionally adding Retry-After.
async fn passthrough(mut resp: Response, retry_after: Option<u64>) -> Result<Response> {
    let status = resp.status_code();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    let mut out = Response::from_json(&body)?.with_status(status);
    out.headers_mut().set("Cache-Control", "no-store")?;
    if let (Some(secs), true) = (retry_after, status == 503 || status == 429) {
        out.headers_mut().set("Retry-After", &secs.to_string())?;
    }
    Ok(out)
}

/// Validated auth headers (`x-anon-id` + `x-upload-token`); the token
/// travels only as its hash.
struct Auth {
    anon: String,
    thash: String,
}

fn auth_headers(req: &Request) -> Option<Auth> {
    let anon = req.headers().get("x-anon-id").ok().flatten()?;
    let token = req.headers().get("x-upload-token").ok().flatten()?;
    if !valid_anon_id(&anon) || !valid_upload_token(&token) {
        return None;
    }
    Some(Auth {
        anon,
        thash: token_hash(&token),
    })
}

// ── personal routes ───────────────────────────────────────────────────

/// GET /api/replays/wanted — the ruleset with live counters, cached 5
/// minutes at the edge. Served as a 200 with an empty rule list when
/// the KV value is absent (collection closed).
pub async fn handle_wanted(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    // Audit M-10: every hit costs a KV read + a DO round trip — a scripted
    // flood with random query strings must not drain the quota.
    if !spend_public_read(&env, "wanted", &client_ip(&req)).await? {
        return err_retry(429, "rate_limited", 600);
    }
    let doc = wanted_doc(&env).await?;
    let mut counters = do_get(&env, "/counters").await?;
    if counters.status_code() != 200 {
        return err(500, "index_unavailable");
    }
    let v: Value = counters.json().await.unwrap_or(Value::Null);
    let wm = v.get("wm").and_then(Value::as_u64).unwrap_or(0);
    let counters: std::collections::HashMap<String, u64> = v
        .get("rules")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, x)| x.as_u64().map(|n| (k.clone(), n)))
                .collect()
        })
        .unwrap_or_default();
    let mut resp = Response::from_json(&replay::wanted_response(doc.as_ref(), wm, &counters))?;
    resp.headers_mut()
        .set("Cache-Control", "public, max-age=300")?;
    Ok(resp)
}

/// POST /api/replays/check — verdicts for a batch of facts (≤400).
/// Auth headers optional: without a valid anonId every known hash
/// reports duplicate.
pub async fn handle_check(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    // Audit M-9: the length is REQUIRED — a chunked body would otherwise
    // be buffered in full by `req.json()` before any cap could refuse it.
    let Some(len) = req
        .headers()
        .get("Content-Length")?
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return err(411, "length_required");
    };
    if len > CHECK_BODY_MAX {
        return err(413, "payload_too_large");
    }
    let ip = client_ip(&req);
    let day = day_bucket(now_ms());
    let kv = env.kv(KV)?;
    let (key, limit) = rl_check_key(&ip, day);
    if !spend(&kv, &key, limit).await? {
        return err_retry(429, "rate_limited", day_retry_after_secs(now_ms()));
    }

    let body: Value = req.json().await.unwrap_or(Value::Null);
    let Some(facts) = body.get("facts").and_then(Value::as_array) else {
        return err(400, "bad_request");
    };
    if facts.is_empty() || facts.len() > replay::MEMBERS_MAX {
        return err(400, "bad_request");
    }
    let facts: Vec<relay_core::replay::ReplayFacts> =
        match serde_json::from_value(Value::Array(facts.clone())) {
            Ok(f) => f,
            Err(_) => return err(400, "bad_request"),
        };
    for f in &facts {
        if let Err(code) = relay_core::replay::validate_facts(f) {
            return err(400, code);
        }
    }
    // Headers accepted, not required; a malformed pair reads as absent.
    let anon = auth_headers(&req).map(|a| a.anon);

    let rules = wanted_doc(&env).await?.map(|d| d.rules).unwrap_or_default();
    let mut resp = do_post(&env, "/check", &DoCheck { anon, facts, rules }).await?;
    if resp.status_code() != 200 {
        return err(500, "index_unavailable");
    }
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    ok(json!({ "results": v.get("results").cloned().unwrap_or(Value::Null) }))
}

/// GET /api/replays/mine — the caller's staged set. 404 on an unknown
/// anonId (the client treats itself as a fresh contributor).
pub async fn handle_mine(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    // Audit M-10: the token gates WHO, not HOW OFTEN — budget the DO
    // round trip per IP like the other public reads.
    if !spend_public_read(&env, "mine", &client_ip(&req)).await? {
        return err_retry(429, "rate_limited", 600);
    }
    let Some(auth) = auth_headers(&req) else {
        return err(403, "token");
    };
    let mut resp = do_get(
        &env,
        &format!("/mine?anon={}&thash={}", auth.anon, auth.thash),
    )
    .await?;
    match resp.status_code() {
        200 => {
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            ok(v)
        },
        404 => err(404, "not_found"),
        403 => err(403, "token_mismatch"),
        _ => err(500, "index_unavailable"),
    }
}

/// GET /api/replays/archive — the caller's current shard, streamed
/// straight out of R2 (`application/zstd`).
pub async fn handle_archive(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    let Some(auth) = auth_headers(&req) else {
        return err(403, "token");
    };
    let kv = env.kv(KV)?;
    let (key, limit) = rl_archive_key(&auth.anon, day_bucket(now_ms()));
    if !spend(&kv, &key, limit).await? {
        return err_retry(429, "rate_limited", day_retry_after_secs(now_ms()));
    }
    let mut resp = do_get(
        &env,
        &format!("/token?anon={}&thash={}", auth.anon, auth.thash),
    )
    .await?;
    if resp.status_code() != 200 {
        return err(500, "index_unavailable");
    }
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    let known = v.get("known").and_then(Value::as_bool).unwrap_or(false);
    let matched = v.get("matched").and_then(Value::as_bool).unwrap_or(false);
    if !known {
        return err(404, "not_found");
    }
    if !matched {
        return err(403, "token_mismatch");
    }
    shard_response(&env, &auth.anon).await
}

/// Stream one contributor's shard out of R2 (shared by the personal and
/// the admin archive routes).
async fn shard_response(env: &Env, anon: &str) -> Result<Response> {
    let bucket = env.bucket(R2)?;
    let object = bucket.get(shard_key(anon)).execute().await?;
    let Some(object) = object else {
        return err(404, "not_found");
    };
    let Some(body) = object.body() else {
        return err(404, "not_found");
    };
    let body = body.response_body()?;
    let mut resp = Response::from_body(body)?.with_status(200);
    resp.headers_mut().set("Content-Type", "application/zstd")?;
    resp.headers_mut().set("Cache-Control", "no-store")?;
    Ok(resp)
}

/// POST /api/replays/upload — RAW tar.zst body + `x-manifest` header.
/// Server order per contract §4: quotas → manifest shape → ruleset
/// app-version floor (426 `client_too_old`) → per-member verdict +
/// superset + watermark (DO prepare) → stream body into R2 → ledger
/// transaction (DO commit).
pub async fn handle_upload(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    let Some(auth) = auth_headers(&req) else {
        return err(403, "token");
    };

    // Cheap header prechecks before spending a quota slot.
    let Some(len) = req
        .headers()
        .get("Content-Length")?
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return err(411, "length_required");
    };
    if len > replay::ARCHIVE_MAX_BYTES {
        return err(413, "archive_too_large");
    }
    // The explicit per-contributor policy bound — shadowed by the tighter
    // per-upload cap above today (re-uploads replace the blob, they never
    // stack); kept defensive so relaxing ARCHIVE_MAX_BYTES alone can never
    // silently drop the per-anon promise.
    if len > replay::ANON_ARCHIVE_MAX_BYTES {
        return err(413, "archive_per_anon_too_large");
    }
    if let Some(ct) = req.headers().get("Content-Type")?.filter(|c| !c.is_empty()) {
        let base = ct.split(';').next().unwrap_or("").trim();
        if !base.eq_ignore_ascii_case("application/zstd") {
            return err(400, "bad_content_type");
        }
    }

    let ip = client_ip(&req);
    let day = day_bucket(now_ms());
    let kv = env.kv(KV)?;
    for (key, limit) in rl_upload_keys(&auth.anon, &ip, day) {
        if !spend(&kv, &key, limit).await? {
            return err_retry(429, "rate_limited", day_retry_after_secs(now_ms()));
        }
    }

    // Manifest shape.
    let Some(manifest_raw) = req.headers().get("x-manifest")?.filter(|m| !m.is_empty()) else {
        return err(400, "manifest_missing");
    };
    let Some(manifest_bytes) = b64url_decode(&manifest_raw) else {
        return err(400, "bad_manifest_encoding");
    };
    let manifest = match parse_manifest(&String::from_utf8_lossy(&manifest_bytes)) {
        Ok(m) => m,
        Err(ManifestError::Shape(code)) => return err(400, code),
        Err(ManifestError::TooManyMembers) => return err(413, "too_many_members"),
    };

    let wanted = wanted_doc(&env).await?;
    // The ruleset may floor the APP build (`clientVersionMin`): an older
    // build's uploads refuse here, before the DO prepare and the R2
    // stream. Fail CLOSED on an empty/malformed manifest version —
    // version_ge counts junk as 0.0.0, so it never passes a real floor.
    if let Some(min) = wanted
        .as_ref()
        .and_then(|d| d.client_version_min.as_deref())
    {
        if !replay::version_ge(&manifest.app_version, min) {
            return err(426, "client_too_old");
        }
    }
    let rules = wanted.map(|d| d.rules).unwrap_or_default();
    let claim = DoClaim {
        phase: "prepare".into(),
        anon: auth.anon.clone(),
        thash: auth.thash.clone(),
        credited_name: manifest.credited_name.clone(),
        realm: manifest.realm.clone(),
        archive_bytes: len,
        members: manifest.members.clone(),
        rules,
    };
    let resp = do_post(&env, "/claim", &claim).await?;
    if resp.status_code() != 200 {
        return passthrough(resp, Some(WATERMARK_RETRY_AFTER)).await;
    }

    // Stream the body into R2 — never buffered. FixedLengthStream makes
    // R2's required known length explicit and fails the put if the body
    // lies about Content-Length.
    let bucket = env.bucket(R2)?;
    let body = req.stream()?;
    let fixed = FixedLengthStream::wrap(body, len);
    bucket.put(shard_key(&auth.anon), fixed).execute().await?;

    // Ledger transaction (re-validates atomically; a mid-flight state
    // change surfaces as the same 4xx the prepare step would give).
    let claim = DoClaim {
        phase: "commit".into(),
        ..claim
    };
    let mut resp = do_post(&env, "/claim", &claim).await?;
    if resp.status_code() != 200 {
        return passthrough(resp, Some(WATERMARK_RETRY_AFTER)).await;
    }
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    ok(json!({
        "accepted": v.get("accepted").and_then(Value::as_u64).unwrap_or(0),
        "archiveBytes": v.get("archiveBytes").and_then(Value::as_u64).unwrap_or(len),
        "creditCount": v.get("creditCount").and_then(Value::as_u64).unwrap_or(0),
    }))
}

// ── admin (drain) routes — erp-session OR machine-key gated ───────────

/// The admin gate: a logged-in erp console session (Feishu OAuth +
/// allowlist) OR an `x-admin-key` header matching the operator's
/// REPLAY_ADMIN_KEY secret — the drain CLI's machine leg. Neither set
/// means the browser flow only; both set means either works.
async fn admin_authed(req: &Request, env: &Env) -> bool {
    if crate::erp::session_ok(req, env).await {
        return true;
    }
    let provided = req.headers().get("x-admin-key").ok().flatten();
    let expected = env.secret("REPLAY_ADMIN_KEY").ok().map(|s| s.to_string());
    relay_core::replay::admin_key_ok(provided.as_deref(), expected.as_deref())
}

/// The admin WRITE leg's same-origin gate — the check the feedback
/// console's write endpoints already carry (`relay_core::erp::
/// same_origin_write`, review follow-up to the relay report's L-3): a
/// browser POST must come from this site. The session cookie is
/// SameSite=Lax so classic CSRF is already blunted; this is depth, and
/// the drain CLI's machine leg (no Origin, no Sec-Fetch-Site header)
/// passes by the same rules the erp tests pin.
fn admin_write_ok(req: &Request) -> bool {
    let Ok(own) = req.url().map(|u| u.origin().ascii_serialization()) else {
        return false;
    };
    let fetch_origin = req.headers().get("Origin").ok().flatten();
    let fetch_site = req.headers().get("Sec-Fetch-Site").ok().flatten();
    relay_core::erp::same_origin_write(fetch_origin.as_deref(), fetch_site.as_deref(), &own)
}

/// GET /api/replays/admin/list — every contributor + the watermark.
pub async fn handle_admin_list(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let mut resp = do_get(&env, "/admin-list").await?;
    if resp.status_code() != 200 {
        return err(500, "index_unavailable");
    }
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    ok(v)
}

/// GET|POST /api/replays/admin/wanted — the console editor's faces.
/// GET answers the RAW stored ruleset (what the editor round-trips);
/// POST validates strictly (relay-core) and stores the canonical form,
/// stamping updatedAt server-side.
pub async fn handle_admin_wanted(mut req: Request, env: Env) -> Result<Response> {
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let kv = env.kv(KV)?;
    match req.method() {
        Method::Get => {
            let raw = kv.get(replay::KV_WANTED_KEY).text().await.ok().flatten();
            let v = match raw {
                Some(raw) => json!({ "exists": true, "raw": raw }),
                None => json!({ "exists": false, "raw": "" }),
            };
            ok(v)
        },
        Method::Post => {
            // The write leg: same-origin first (the GET editor round-trip
            // above stays readable cross-free).
            if !admin_write_ok(&req) {
                return err(403, "cross_origin");
            }
            // Audit M-9: REQUIRED length — the admin editor always sends
            // one; a chunked body must not buffer unbounded.
            let Some(len) = req
                .headers()
                .get("Content-Length")?
                .and_then(|v| v.parse::<usize>().ok())
            else {
                return err(411, "length_required");
            };
            if len > replay::WANTED_SAVE_MAX_BYTES + 1024 {
                return err(413, "file_too_large");
            }
            let body = req.text().await?;
            let now_ms = Date::now().as_millis();
            match replay::validate_wanted_save(&body, now_ms) {
                Ok(doc) => {
                    let canonical = serde_json::to_string(&doc)
                        .map_err(|e| worker::Error::RustError(format!("serialize: {e}")))?;
                    kv.put(replay::KV_WANTED_KEY, canonical)?.execute().await?;
                    ok(json!({
                        "ok": true,
                        "rulesetVersion": doc.ruleset_version,
                        "rules": doc.rules.len(),
                    }))
                },
                Err(e) => ok(json!({ "ok": false, "error": e })).map(|r| r.with_status(400)),
            }
        },
        _ => err(405, "method_not_allowed"),
    }
}

/// GET /api/replays/admin/credits — the per-identity lifetime share
/// counts (the release-time contributors list's source of truth).
pub async fn handle_admin_credits(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let mut resp = do_get(&env, "/credits").await?;
    if resp.status_code() != 200 {
        return err(500, "index_unavailable");
    }
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    ok(v)
}

/// GET /api/replays/admin/archive?anon_id=… — one contributor's shard.
pub async fn handle_admin_archive(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let query = req.url()?.query().unwrap_or("").to_string();
    let Some(anon) = relay_core::route::query_get(&query, "anon_id") else {
        return err(400, "bad_request");
    };
    if !valid_anon_id(anon) {
        return err(400, "bad_request");
    }
    shard_response(&env, anon).await
}

/// POST /api/replays/admin/drain {anonIds} — the maintainer's collect
/// step: the console lists contributors, downloads what it wants via
/// /admin/archive, then drains. The DO marks staged members drained
/// (rule counters untouched), zeroes the blob totals and the watermark;
/// the worker then deletes the R2 shards.
pub async fn handle_admin_drain(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    if !admin_write_ok(&req) {
        return err(403, "cross_origin");
    }
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let body: Value = req.json().await.unwrap_or(Value::Null);
    let Some(ids) = body.get("anonIds").and_then(Value::as_array) else {
        return err(400, "bad_request");
    };
    if ids.is_empty() || ids.len() > DRAIN_BATCH_MAX {
        return err(400, "bad_request");
    }
    let mut anon_ids: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(id) = id.as_str().filter(|i| valid_anon_id(i)) else {
            return err(400, "bad_request");
        };
        anon_ids.push(id.to_string());
    }

    let mut resp = do_post(&env, "/drain", &DoDrain { anon_ids }).await?;
    if resp.status_code() != 200 {
        return err(500, "index_unavailable");
    }
    let v: Value = resp.json().await.unwrap_or(Value::Null);

    // Shard deletion is post-transaction: a failure here leaves an
    // orphaned (harmless, unread) blob, not a ledger inconsistency.
    let drained: Vec<String> = v
        .get("drained")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if !drained.is_empty() {
        let keys: Vec<String> = drained.iter().map(|a| shard_key(a)).collect();
        if let Err(e) = env.bucket(R2)?.delete_multiple(keys).await {
            worker::console_warn!("replay drain: shard cleanup failed: {e}");
        }
    }
    ok(json!({ "drained": drained, "bytes": v.get("bytes").and_then(Value::as_u64).unwrap_or(0) }))
}

/// POST /api/replays/admin/rename {anonId, name} — correct one
/// contributor's credited name. The identity is self-reported free
/// text, so a typo (an ASCII `_` standing in for a lookalike CJK
/// character, say) only surfaces once the credits list ships and a
/// lookup by that name finds nobody. The DO re-validates both fields —
/// the faces agree by construction.
pub async fn handle_admin_rename(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    if !admin_write_ok(&req) {
        return err(403, "cross_origin");
    }
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let body: Value = req.json().await.unwrap_or(Value::Null);
    let Some(anon) = body
        .get("anonId")
        .and_then(Value::as_str)
        .filter(|a| valid_anon_id(a))
    else {
        return err(400, "bad_request");
    };
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| relay_core::replay::valid_credited_name(n))
    else {
        return err(400, "bad_request");
    };
    let mut resp = do_post(
        &env,
        "/rename",
        &DoRename {
            anon: anon.to_string(),
            name: name.to_string(),
        },
    )
    .await?;
    match resp.status_code() {
        200 => {
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            ok(v)
        },
        // The ledger's own verdicts, passed through verbatim — the DO
        // is the authority on whether the anon id exists at all (its
        // 400 cannot fire past this handler's identical pre-check, but
        // a DO-side storage failure surfaces as 500 and must not read
        // as the operator's mistake).
        404 => err(404, "unknown_contributor"),
        400 => err(400, "bad_request"),
        _ => err(500, "index_unavailable"),
    }
}

/// POST /api/replays/admin/backfill {name, realm, members} — credit
/// manually collected replays: the contributor sent the files outright,
/// so no upload ever rode the pipeline. The anon id is DERIVED from
/// (realm, name) on this side (`backfill_anon_id`) — repeated backfills
/// of one person land on one ledger row without client-side state.
/// Members land at drained status: credited + duplicate-protected, no
/// R2 blob, no watermark. 409 when the derived anon already exists
/// under a different (realm, name) — renames fix names, not this.
pub async fn handle_admin_backfill(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    if !admin_write_ok(&req) {
        return err(403, "cross_origin");
    }
    if !admin_authed(&req, &env).await {
        return err(401, "unauthorized");
    }
    let body: Value = req.json().await.unwrap_or(Value::Null);
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| relay_core::replay::valid_credited_name(n))
    else {
        return err(400, "bad_request");
    };
    let Some(realm) = body
        .get("realm")
        .and_then(Value::as_str)
        .filter(|r| relay_core::replay::valid_realm(r))
    else {
        return err(400, "bad_request");
    };
    let Some(members) = body.get("members").and_then(Value::as_array) else {
        return err(400, "bad_request");
    };
    if members.is_empty() || members.len() > replay::MEMBERS_MAX {
        return err(400, "bad_request");
    }
    let members: Vec<relay_core::replay::BackfillMember> =
        match serde_json::from_value(Value::Array(members.clone())) {
            Ok(m) => m,
            Err(_) => return err(400, "bad_request"),
        };
    for m in &members {
        if !valid_hex64(&m.sha256)
            || !relay_core::replay::valid_file_name(&m.file_name)
            || !(replay::SIZE_MIN..=replay::SIZE_MAX).contains(&m.size_bytes)
        {
            return err(400, "bad_request");
        }
    }
    let anon = relay_core::replay::backfill_anon_id(realm, name);
    let mut resp = do_post(
        &env,
        "/backfill",
        &DoBackfill {
            anon,
            name: name.to_string(),
            realm: realm.to_string(),
            members,
        },
    )
    .await?;
    match resp.status_code() {
        200 => {
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            ok(v)
        },
        // The ledger's own verdicts, verbatim; a DO-side failure must
        // not read as the operator's mistake (see rename).
        409 => err(409, "identity_conflict"),
        400 => err(400, "bad_request"),
        _ => err(500, "index_unavailable"),
    }
}

fn now_ms() -> i64 {
    worker::Date::now().as_millis() as i64
}
