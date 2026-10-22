//! Feedback endpoints — the I/O half of the feedback pipeline. Policy
//! (validation, limits, payloads, page HTML) lives in `relay_core::feedback`;
//! this module owns request/response plumbing: Turnstile siteverify,
//! KV (rate limits + token/base caches), and the Feishu OpenAPI calls
//! (tenant token, Bitable records, drive media upload).
//!
//! Configuration (see the README deploy section):
//! - `TURNSTILE_SITEKEY` (var) + `TURNSTILE_SECRET` (secret) — the form's
//!   human check. Without the sitekey the form renders a maintenance
//!   notice instead of a submittable widget.
//! - `FEISHU_APP_ID` (secret) + `FEISHU_APP_SECRET` (secret) — the
//!   feedback Bitable's tenant token AND the /erp console's Feishu-OAuth
//!   login (see src/erp.rs; the console APIs gate on the signed session
//!   cookie, the old `FEEDBACK_ADMIN_KEY` header gate is retired).
//! - `FEEDBACK_ADMIN_OPEN_ID` (var or secret, optional) — granted
//!   `full_access` on the bootstrap-created Bitable so a human can open it
//!   in Feishu; also always on the /erp console allowlist.
//! - `ERP_ALLOWED_OPEN_IDS` (secret or var, optional) — comma-separated
//!   open_ids admitted to the /erp console on top of the admin (see
//!   src/erp.rs; unset together with the admin = the legacy open gate).
//! - `FEEDBACK_BITABLE_APP_TOKEN` / `FEEDBACK_BITABLE_TABLE_ID` (vars,
//!   optional) — pin to a pre-existing base instead of bootstrapping one.
//! - `FEEDBACK_TURNSTILE_BYPASS` (secret, OPTIONAL, smoke tests only) —
//!   when a submission's `_bypass` field equals this value the siteverify
//!   call is skipped. Delete the secret after smoking.

use relay_core::feedback::{
    self, BASE_NAME, LOOKUP_ROW_TTL_SECS, LookupRow, STATUSES, attachment_update_body,
    lookup_kv_key, lookup_token_hash, normalize, rate_keys, rate_limits, record_fields,
    resolve_lookup_record, table_schema, turnstile_passed, turnstile_verify_body,
    valid_lookup_token,
};
use relay_core::multipart;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{
    Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response, Result, Url,
    js_sys,
};

/// KV binding name (wrangler.toml `kv_namespaces`).
const KV: &str = "FEEDBACK_KV";
pub(crate) const FEISHU: &str = "https://open.feishu.cn/open-apis";

/// KV keys: tenant-token cache + bootstrap base ids.
const K_TOKEN: &str = "fb:token";
const K_BASE: &str = "fb:base";
/// KV TTL floor is 60s; counters get window + slack.
const TTL_HOUR: u64 = 3_660;
const TTL_DAY: u64 = 86_460;

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct BitableIds {
    app_token: String,
    table_id: String,
}

// ── pages ──────────────────────────────────────────────────────────────

/// GET /feedback — the embedded form (maintenance notice when the
/// Turnstile sitekey is absent). The current release (wrangler var
/// FEEDBACK_LATEST_VERSION, kept in sync by scripts/sync_versions.py)
/// and the request's User-Agent prefill the web form's editable
/// version/system-info comboboxes.
pub fn page_feedback(origin: &str, env: &Env, user_agent: Option<&str>) -> Result<Response> {
    let sitekey = env.var("TURNSTILE_SITEKEY").ok().map(|v| v.to_string());
    let latest = env
        .var("FEEDBACK_LATEST_VERSION")
        .map(|v| v.to_string())
        .unwrap_or_default();
    html(relay_core::feedback::feedback_page(
        sitekey.as_deref(),
        origin,
        &latest,
        user_agent.unwrap_or(""),
    ))
}

/// GET /erp — the embedded review console.
pub fn page_erp(origin: &str) -> Result<Response> {
    html(relay_core::erp::erp_page(origin))
}

fn html(body: String) -> Result<Response> {
    let mut resp = Response::from_bytes(body.into_bytes())?;
    resp.headers_mut()
        .set("Content-Type", "text/html; charset=utf-8")?;
    resp.headers_mut().set("Cache-Control", "no-store")?;
    Ok(resp)
}

// ── submit ─────────────────────────────────────────────────────────────

/// POST /api/feedback/submit — multipart form target:
/// normalize → Turnstile → rate limit → Bitable record (+ attachment).
pub async fn handle_submit(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    // Cheap pre-reject before buffering the body (largest attachment
    // kind + form slack).
    // The length is REQUIRED, not just a pre-check (audit M-9): a chunked
    // request would otherwise be buffered in full before the cap could
    // refuse it. The buffered-body check below stays as the belt to the
    // pre-check's suspenders.
    let Some(len) = req
        .headers()
        .get("Content-Length")?
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return err(411, "length_required");
    };
    if len > relay_core::feedback::ATTACHMENT_MAX + 64 * 1024 {
        return err(413, "file_too_large");
    }

    let ct = req.headers().get("Content-Type")?.unwrap_or_default();
    let Some(boundary) = multipart::boundary_from_content_type(&ct) else {
        return err(400, "bad_request");
    };
    let body = req.bytes().await?;
    // Chunked requests carry no Content-Length — enforce the cap on the
    // BUFFERED body too, before any parsing happens.
    if body.len() > relay_core::feedback::ATTACHMENT_MAX + 64 * 1024 {
        return err(413, "file_too_large");
    }
    let parts = multipart::parse(&boundary, &body);

    let mut sub = relay_core::feedback::Submission::default();
    let mut turnstile_response = String::new();
    let mut bypass = String::new();
    for part in parts {
        let text = || String::from_utf8_lossy(&part.bytes).into_owned();
        match part.name.as_str() {
            "description" => sub.description = text(),
            "contact" => sub.contact = text(),
            "version" => sub.version = text(),
            "sysinfo" => sub.sysinfo = text(),
            "channel" => sub.channel = text(),
            "anon" => sub.anon_id = text(),
            "server" => sub.server = text(),
            "game_id" => sub.game_id = text(),
            "file" => sub.files.push((part.filename, part.bytes)),
            "cf-turnstile-response" => turnstile_response = text(),
            "_bypass" => bypass = text(),
            _ => {},
        }
    }
    if let Err(code) = normalize(&mut sub) {
        return err(400, code);
    }

    // Human check. The bypass secret exists purely so deploys can be
    // smoke-tested with curl; keep it absent in normal operation.
    let ip = req
        .headers()
        .get("CF-Connecting-IP")?
        .unwrap_or_else(|| "local".into());
    let bypass_secret = env
        .secret("FEEDBACK_TURNSTILE_BYPASS")
        .ok()
        .map(|s| s.to_string());
    let bypassed = bypass_secret
        .as_deref()
        .is_some_and(|b| !b.is_empty() && ct_eq(&bypass, b));
    // Every channel passes Turnstile: `channel` is client-supplied, and the
    // desktop app hands off to this same web form in the system browser
    // (`?channel=desktop` prefill), where the widget renders normally.
    if !bypassed {
        let Some(secret) = env.secret("TURNSTILE_SECRET").ok().map(|s| s.to_string()) else {
            return err(503, "maintenance");
        };
        let headers = Headers::new();
        headers.set("Content-Type", "application/x-www-form-urlencoded")?;
        let mut resp = http_call(
            Method::Post,
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            headers,
            Some(turnstile_verify_body(&secret, &turnstile_response, &ip).into_bytes()),
        )
        .await
        .map_err(|_| "siteverify unreachable")?;
        let verdict: Value = resp.json().await.unwrap_or(Value::Null);
        if !turnstile_passed(&verdict) {
            return err(403, "turnstile");
        }
    }

    // Rate limits (best-effort KV counters; eventual consistency is fine —
    // Turnstile already carries the abuse load, this is the speed bump).
    // Keys: IP/hour, anon/day, contact/day (when given), global/day.
    let kv = env.kv(KV)?;
    let now = now_ms();
    for (key, limit) in rate_keys(&ip, &sub.anon_id, &sub.contact, now)
        .iter()
        .zip(rate_limits(&sub.contact))
    {
        let count: u64 = kv.get(key).json::<u64>().await.ok().flatten().unwrap_or(0) + 1;
        if count > limit {
            return err(429, "rate_limited");
        }
        let ttl = if key.starts_with("rl:ip:") {
            TTL_HOUR
        } else {
            TTL_DAY
        };
        kv.put(key, count)?.expiration_ttl(ttl).execute().await?;
    }

    // Feishu: record (+ attachment upload, then attach to the record).
    let token = feishu_token(&env).await.map_err(|e| e.to_string())?;
    let ids = ensure_base(&env, &token).await.map_err(|e| e.to_string())?;

    let (_, v) = feishu_json(
        Method::Post,
        &format!(
            "{FEISHU}/bitable/v1/apps/{}/tables/{}/records",
            ids.app_token, ids.table_id
        ),
        &token,
        json!({ "fields": record_fields(&sub, now) }),
    )
    .await?;
    let record_id = v
        .pointer("/data/record/record_id")
        .and_then(Value::as_str)
        .ok_or("record id missing")?
        .to_string();

    // 一次性查询凭证（audit M-7 修订）：32 字节 CSPRNG，只在本次响应里
    // 下发；KV 只落 SHA-256（fbtok:{hash} → 联系方式 + record_id + 哈希）。
    // 凭证收敛到「本次提交的 record_id」——公开历史查询只回这一条记录
    // 的状态，contact 字段仅保留给 QQ 机器人的绑定/回访通知路由。行只能
    // 在 record_id 诞生后写入；此时 Feishu 已受理，KV 写失败不再 500 整
    // 个提交（降级为响应里不带凭证）。没有联系方式的提交不签发（绑定/
    // 通知都路由不到，旧行为不变）。
    let lookup_token = match mint_lookup_token() {
        Ok(token) if !sub.contact.is_empty() => {
            let row = LookupRow {
                contact: relay_core::feedback::normalize_contact(&sub.contact),
                hash: lookup_token_hash(&token),
                record_id: Some(record_id.clone()),
            };
            let stored = kv
                .put(&lookup_kv_key(&row.hash), serde_json::to_string(&row)?)?
                .expiration_ttl(LOOKUP_ROW_TTL_SECS)
                .execute()
                .await
                .is_ok();
            stored.then_some(token)
        },
        _ => None,
    };

    // 每个附件上传一次，收齐 file_token 后一次 PUT 挂到记录上（F_LOG
    // 是数组字段，桌面端一次可能带 截图 + 日志包 两件）。
    if !sub.files.is_empty() {
        let mut tokens: Vec<String> = Vec::new();
        for (name, bytes) in &sub.files {
            let name = name.clone().unwrap_or_else(|| "logs.zip".into());
            let (mp_boundary, mp_body) = multipart::build_seeded(
                now_ms() as u64 + tokens.len() as u64,
                &[
                    ("file_name".into(), None, name.clone().into_bytes()),
                    ("parent_type".into(), None, b"bitable_file".to_vec()),
                    (
                        "parent_node".into(),
                        None,
                        ids.app_token.clone().into_bytes(),
                    ),
                    ("size".into(), None, bytes.len().to_string().into_bytes()),
                    ("file".into(), Some(name), bytes.clone()),
                ],
            );
            let headers = Headers::new();
            headers.set(
                "Content-Type",
                &format!("multipart/form-data; boundary={mp_boundary}"),
            )?;
            headers.set("Authorization", &format!("Bearer {token}"))?;
            let mut resp = http_call(
                Method::Post,
                &format!("{FEISHU}/drive/v1/medias/upload_all"),
                headers,
                Some(mp_body),
            )
            .await
            .map_err(|_| "upload unreachable")?;
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            let file_token = v
                .pointer("/data/file_token")
                .and_then(Value::as_str)
                .ok_or("file token missing")?
                .to_string();
            tokens.push(file_token);
        }
        feishu_json(
            Method::Put,
            &format!(
                "{FEISHU}/bitable/v1/apps/{}/tables/{}/records/{record_id}",
                ids.app_token, ids.table_id
            ),
            &token,
            attachment_update_body(&tokens),
        )
        .await?;
    }

    // 受理通知：尽力而为（C2C 优先，配额/未绑定则跳过），不影响提交。
    let head: String = sub.description.chars().take(24).collect();
    let _ = crate::qqbot::notify_accepted(&env, &sub.contact, &head).await;

    ok(json!({
        "ok": true,
        "record_url": record_url(&ids, &record_id),
        // None（未留联系方式）→ null：页面据此隐藏凭证展示块。
        "lookup_token": lookup_token,
    }))
}

/// 32 字节 CSPRNG（workerd 的 `crypto.getRandomValues`）→ 64 位小写
/// 十六进制——查询凭证的线上形态。
fn mint_lookup_token() -> Result<String> {
    let mut raw = [0u8; relay_core::feedback::LOOKUP_TOKEN_BYTES];
    getrandom::fill(&mut raw).map_err(|_| "rng unavailable")?;
    let mut out = String::with_capacity(raw.len() * 2);
    for b in raw {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    Ok(out)
}

// ── admin surface ──────────────────────────────────────────────────────

/// GET /api/feedback/list?page_token=… — records (Bitable default order),
/// mapped to a compact JSON shape the console (and fix-agents) consume.
pub async fn handle_list(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    if !crate::erp::session_ok(&req, &env) {
        return err(401, "unauthorized");
    }
    let query = req.url()?.query().unwrap_or("").to_string();
    let page_token = relay_core::route::query_get(&query, "page_token");

    let token = feishu_token(&env).await.map_err(|e| e.to_string())?;
    let ids = ensure_base(&env, &token).await.map_err(|e| e.to_string())?;
    let mut api = format!(
        "{FEISHU}/bitable/v1/apps/{}/tables/{}/records?page_size=50",
        ids.app_token, ids.table_id
    );
    if let Some(t) = page_token.filter(|t| !t.is_empty()) {
        api.push_str(&format!("&page_token={}", urlencode(t)));
    }
    let (_, v) = feishu_json(Method::Get, &api, &token, Value::Null).await?;

    let items = v
        .pointer("/data/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|rec| {
            let record_id = rec
                .pointer("/record_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let f = |name: &str| rec.pointer(&format!("/fields/{name}")).cloned();
            let attachments = f(feedback::F_LOG)
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|a| {
                    let ft = a.get("file_token")?.as_str()?;
                    Some(json!({
                        "name": a.get("name").and_then(Value::as_str).unwrap_or("attachment"),
                        "size": a.get("size").and_then(Value::as_i64).unwrap_or(0),
                        "url": format!("/api/feedback/attachment?file_token={}", urlencode(ft)),
                    }))
                })
                .collect::<Vec<_>>();
            json!({
                "record_id": record_id,
                "time": f(feedback::F_TIME).and_then(|v| v.as_i64()),
                "description": text_val(&f(feedback::F_DESC)),
                "contact": text_val(&f(feedback::F_CONTACT)),
                "version": text_val(&f(feedback::F_VERSION)),
                "sysinfo": text_val(&f(feedback::F_SYS)),
                "server": text_val(&f(feedback::F_SERVER)),
                "game_id": text_val(&f(feedback::F_GAME_ID)),
                "channel": text_val(&f(feedback::F_CHANNEL)),
                "status": text_val(&f(feedback::F_STATUS)),
                "pr": f(feedback::F_PR).and_then(|v| {
                    v.get("link").and_then(Value::as_str).map(str::to_string)
                }),
                "attachments": attachments,
                "record_url": record_url(&ids, &record_id),
            })
        })
        .collect::<Vec<_>>();

    ok(json!({
        "ok": true,
        "items": items,
        "next_page_token": v
            .pointer("/data/has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then(|| {
                v.pointer("/data/page_token")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .filter(|t| !t.is_empty()),
    }))
}

/// GET /api/feedback/history?token=… — PUBLIC lookup (the submitter's
/// own progress tracker, audit M-7): the one-time lookup token shown at
/// submit time is the only key. Its SHA-256 resolves through a KV row
/// (constant-time compared) to THE record the token was minted with —
/// owning a token proves "I submitted this record", never "I am this
/// contact" (audit M-7 revision), so the endpoint answers exactly one
/// item and the item shape (time/status/description-snippet/PR-link) is
/// unchanged. The legacy `?contact=` spelling is retired — the contact is
/// the maintainer's business, never a lookup key. Rate-limited per IP;
/// wrong tokens count against the same bucket.
pub async fn handle_history(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    let query = req.url()?.query().unwrap_or("").to_string();
    let Some(token) = relay_core::route::query_get(&query, "token")
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|t| valid_lookup_token(t))
    else {
        return err(400, "bad_request");
    };
    // 限流在凭证解析之前：错误凭证与命中共用同一个 IP 小时桶。
    let kv = env.kv(KV)?;
    let key = relay_core::feedback::history_rate_key(&client_ip(&req), now_ms());
    let count: u64 = kv.get(&key).json::<u64>().await.ok().flatten().unwrap_or(0) + 1;
    if count > relay_core::feedback::RATE_HISTORY_PER_HOUR {
        return err(429, "rate_limited");
    }
    kv.put(&key, count)?
        .expiration_ttl(TTL_HOUR)
        .execute()
        .await?;

    // 凭证 → 哈希 → KV 行 → 常时比对（同会话 MAC 的卫生规则）→ 本条记录。
    let hash = lookup_token_hash(&token);
    let row: Option<Value> = kv
        .get(&lookup_kv_key(&hash))
        .json::<Value>()
        .await
        .ok()
        .flatten();
    let Some(record_id) = resolve_lookup_record(row.as_ref(), &token) else {
        // 未知凭证、修订前的旧行与「记录已删」同形：一律空列表，
        // 不区分存在性（凭证只指向一条记录，见 resolve_lookup_record）。
        return ok(json!({ "ok": true, "items": [] }));
    };
    let items = history_record(&env, &record_id).await?;

    ok(json!({ "ok": true, "items": items }))
}

/// One Bitable record → the public status item shared by the token
/// history endpoint and the QQ bot's 查询 reply (time/status/
/// description-snippet/PR-link — never the full text or the contact).
fn history_item(rec: &Value) -> Value {
    let f = |name: &str| rec.pointer(&format!("/fields/{name}")).cloned();
    let desc = text_val(&f(feedback::F_DESC));
    let snippet: String = desc
        .chars()
        .take(relay_core::feedback::HISTORY_SNIPPET)
        .collect();
    json!({
        "time": f(feedback::F_TIME).and_then(|v| v.as_i64()),
        "status": text_val(&f(feedback::F_STATUS)),
        "description": snippet,
        "pr": f(feedback::F_PR).and_then(|v| {
            v.get("link").and_then(Value::as_str).map(str::to_string)
        }),
    })
}

/// The token-scoped history read (audit M-7 revision): fetch exactly the
/// one record the lookup token was minted with. A deleted record (or an
/// upstream read failure) answers an empty list — the endpoint's
/// contract is best-effort status, and "nothing to show" keeps the
/// unknown-token and known-token shapes indistinguishable (same swallow
/// shape as [`record_contact`]).
async fn history_record(env: &Env, record_id: &str) -> Result<Vec<Value>> {
    let Ok(token) = feishu_token(env).await else {
        return Ok(Vec::new());
    };
    let Ok(ids) = ensure_base(env, &token).await else {
        return Ok(Vec::new());
    };
    let fetched = feishu_json(
        Method::Get,
        &format!(
            "{FEISHU}/bitable/v1/apps/{}/tables/{}/records/{record_id}",
            ids.app_token, ids.table_id
        ),
        &token,
        Value::Null,
    )
    .await;
    Ok(fetched
        .ok()
        .and_then(|(_, v)| v.pointer("/data/record").map(history_item))
        .into_iter()
        .collect())
}

/// One contact's newest submissions (time/status/description/pr only) —
/// the QQ bot's 查询 command's read (the contact arrives from the bot's
/// binding store, never from the request). The public history endpoint
/// no longer reads by contact (audit M-7 revision): it fetches the one
/// record its lookup token was minted with instead.
pub async fn history_records(env: &Env, contact: &str) -> Result<Vec<Value>> {
    let token = feishu_token(env).await.map_err(|e| e.to_string())?;
    let ids = ensure_base(env, &token).await.map_err(|e| e.to_string())?;
    let (_, v) = feishu_json(
        Method::Post,
        &format!(
            "{FEISHU}/bitable/v1/apps/{}/tables/{}/records/search?page_size=20",
            ids.app_token, ids.table_id
        ),
        &token,
        json!({
            "filter": {
                "conjunction": "and",
                "conditions": [{
                    "field_name": feedback::F_CONTACT,
                    "operator": "is",
                    "value": [contact],
                }],
            },
            "sort": [{ "field_name": feedback::F_TIME, "desc": true }],
        }),
    )
    .await?;

    Ok(v.pointer("/data/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(history_item)
        .collect::<Vec<_>>())
}

/// 回读一条记录的联系方式（通知路由用）；读不到返回 None（跳过通知）。
async fn record_contact(token: &str, ids: &BitableIds, record_id: &str) -> Option<String> {
    let (_, v) = feishu_json(
        Method::Get,
        &format!(
            "{FEISHU}/bitable/v1/apps/{}/tables/{}/records/{record_id}",
            ids.app_token, ids.table_id
        ),
        token,
        Value::Null,
    )
    .await
    .ok()?;
    let c = v
        .pointer(&format!("/fields/{}", feedback::F_CONTACT))
        .cloned();
    Some(text_val(&c)).filter(|c| !c.is_empty())
}

/// POST /api/feedback/update {record_id, status?, pr_link?} — the console's
/// review transition (and what fix-agents call to mark 已开PR). Browser
/// requests must be same-origin (the Lax session cookie would still ride
/// a same-site POST from a sibling subdomain); header-less non-browser
/// clients pass on the cookie alone.
pub async fn handle_update(mut req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Post {
        return err(405, "method_not_allowed");
    }
    let own_origin = req.url()?.origin().ascii_serialization();
    let fetch_origin = req.headers().get("Origin").ok().flatten();
    let fetch_site = req.headers().get("Sec-Fetch-Site").ok().flatten();
    if !relay_core::erp::same_origin_write(
        fetch_origin.as_deref(),
        fetch_site.as_deref(),
        &own_origin,
    ) {
        return err(403, "cross_origin");
    }
    if !crate::erp::session_ok(&req, &env) {
        return err(401, "unauthorized");
    }
    let body: Value = req.json().await.unwrap_or(Value::Null);
    let Some(record_id) = body.get("record_id").and_then(Value::as_str) else {
        return err(400, "bad_request");
    };
    if record_id.is_empty()
        || record_id.len() > 64
        || !record_id.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return err(400, "bad_request");
    }
    let status = body.get("status").and_then(Value::as_str).unwrap_or("");
    let pr_link = body
        .get("pr_link")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !status.is_empty() && !STATUSES.contains(&status) {
        return err(400, "bad_status");
    }
    if pr_link.len() > 500 {
        return err(400, "bad_request");
    }

    let mut fields = serde_json::Map::new();
    if !status.is_empty() {
        fields.insert(feedback::F_STATUS.into(), json!(status));
    }
    if !pr_link.is_empty() {
        if !pr_link.starts_with("https://") {
            return err(400, "bad_request");
        }
        fields.insert(
            feedback::F_PR.into(),
            json!({ "text": "PR", "link": pr_link }),
        );
    }
    if fields.is_empty() {
        return err(400, "bad_request");
    }

    let token = feishu_token(&env).await.map_err(|e| e.to_string())?;
    let ids = ensure_base(&env, &token).await.map_err(|e| e.to_string())?;
    feishu_json(
        Method::Put,
        &format!(
            "{FEISHU}/bitable/v1/apps/{}/tables/{}/records/{record_id}",
            ids.app_token, ids.table_id
        ),
        &token,
        json!({ "fields": fields }),
    )
    .await?;
    // 处理结果通知（尽力而为）：回读记录拿联系方式，按状态选渠道。
    if let Some(contact) = record_contact(&token, &ids, record_id).await {
        let final_status = if status.is_empty() {
            None
        } else {
            Some(status)
        };
        if let Some(st) = final_status {
            let _ = crate::qqbot::notify_status(
                &env,
                &contact,
                st,
                if pr_link.is_empty() { "" } else { pr_link },
            )
            .await;
        }
    }
    ok(json!({ "ok": true }))
}

/// GET /api/feedback/attachment?file_token=… — 302 to a Feishu temporary
/// download URL so the console never needs Feishu credentials.
pub async fn handle_attachment(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return err(405, "method_not_allowed");
    }
    if !crate::erp::session_ok(&req, &env) {
        return err(401, "unauthorized");
    }
    let query = req.url()?.query().unwrap_or("").to_string();
    let Some(file_token) = relay_core::route::query_get(&query, "file_token")
        .filter(|t| !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric()))
    else {
        return err(400, "bad_request");
    };
    let token = feishu_token(&env).await.map_err(|e| e.to_string())?;
    let (_, v) = feishu_json(
        Method::Get,
        &format!("{FEISHU}/drive/v1/medias/batch_get_tmp_download_url?file_tokens={file_token}"),
        &token,
        Value::Null,
    )
    .await?;
    let tmp = v
        .pointer("/data/tmp_download_urls/0/tmp_download_url")
        .and_then(Value::as_str)
        .ok_or("tmp url missing")?;
    Response::redirect(Url::parse(tmp)?)
}

/// Length-checking constant-time-ish compare — network jitter already
/// dwarfs the timing signal; this is hygiene, not a hard guarantee.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

// ── Feishu plumbing ────────────────────────────────────────────────────

/// The caller's IP (CF header in production, "local" under wrangler dev).
pub fn client_ip(req: &Request) -> String {
    req.headers()
        .get("CF-Connecting-IP")
        .ok()
        .flatten()
        .unwrap_or_else(|| "local".into())
}

fn now_ms() -> i64 {
    worker::Date::now().as_millis() as i64
}

fn record_url(ids: &BitableIds, record_id: &str) -> String {
    format!(
        "https://feishu.cn/base/{}?table={}&record={}",
        ids.app_token, ids.table_id, record_id
    )
}

/// JSON GET/POST/PUT against the Feishu OpenAPI with a bearer token.
/// Errors when the HTTP call itself fails; API-level failures are
/// returned as `Err` with a short code so handlers map them to 502s.
pub(crate) async fn feishu_json(
    method: Method,
    url: &str,
    token: &str,
    body: Value,
) -> Result<(u16, Value)> {
    let headers = json_headers(Some(token))?;
    let payload = if body.is_null() {
        None
    } else {
        Some(body.to_string().into_bytes())
    };
    let mut resp = http_call(method, url, headers, payload)
        .await
        .map_err(|_| "feishu unreachable")?;
    let status = resp.status_code();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status >= 200 && status < 300 && v.get("code").and_then(Value::as_i64).unwrap_or(0) == 0 {
        Ok((status, v))
    } else {
        Err(format!(
            "feishu api {status} {}",
            v.get("msg").and_then(Value::as_str).unwrap_or("")
        )
        .into())
    }
}

/// Tenant token with a KV cache (Feishu issues 2h tokens; refresh 5 min
/// early). Errors when the credentials var/secret pair is missing.
/// Cache reads are best-effort: a malformed/legacy row is a MISS, never
/// a failed request (KV values are ALWAYS written as plain JSON text —
/// storing a `serde_json::Value` directly lands as "[object Object]").
pub(crate) async fn feishu_token(env: &Env) -> Result<String> {
    let kv = env.kv(KV)?;
    if let Some(cached) = kv.get(K_TOKEN).json::<TokenCache>().await.ok().flatten() {
        if cached.expire_at > now_ms() + 300_000 {
            return Ok(cached.token);
        }
    }
    let app_id = env.secret("FEISHU_APP_ID").ok().map(|s| s.to_string());
    let app_secret = env.secret("FEISHU_APP_SECRET").ok().map(|s| s.to_string());
    let (Some(app_id), Some(app_secret)) = (app_id, app_secret) else {
        return Err("feishu credentials missing".into());
    };

    let headers = json_headers(None)?;
    let mut resp = http_call(
        Method::Post,
        &format!("{FEISHU}/auth/v3/tenant_access_token/internal"),
        headers,
        Some(
            json!({ "app_id": app_id, "app_secret": app_secret })
                .to_string()
                .into_bytes(),
        ),
    )
    .await
    .map_err(|_| "token unreachable")?;
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    let token = v
        .pointer("/tenant_access_token")
        .and_then(Value::as_str)
        .ok_or("token missing")?
        .to_string();
    let expire = v.pointer("/expire").and_then(Value::as_i64).unwrap_or(7200);
    let cache = TokenCache {
        token: token.clone(),
        expire_at: now_ms() + expire * 1000,
    };
    // Plain JSON text (NOT a serde_json::Value — see the fn doc).
    let _ = kv
        .put(K_TOKEN, serde_json::to_string(&cache)?)?
        .execute()
        .await;
    Ok(token)
}

#[derive(Serialize, Deserialize)]
struct TokenCache {
    token: String,
    expire_at: i64,
}

/// Resolve (and on first call bootstrap) the feedback Bitable. The env
/// pin WINS over the KV cache (an operator re-pinning must take effect
/// without hunting down the cached key), then KV, then create base +
/// table (+ admin grant). Idempotent; a bootstrap race between two first
/// submits worst-case orphans one extra base — accepted at this volume.
async fn ensure_base(env: &Env, token: &str) -> Result<BitableIds> {
    let kv = env.kv(KV)?;
    if let (Some(app), Some(tbl)) = (
        env.var("FEEDBACK_BITABLE_APP_TOKEN")
            .ok()
            .map(|v| v.to_string()),
        env.var("FEEDBACK_BITABLE_TABLE_ID")
            .ok()
            .map(|v| v.to_string()),
    ) {
        let ids = BitableIds {
            app_token: app,
            table_id: tbl,
        };
        // Skip the KV write when the pin is unchanged — every feedback API
        // call funnels through here, and list-polling agents would
        // otherwise burn the free-tier daily KV write quota. Best-effort
        // read (a malformed row is just a miss).
        if kv
            .get(K_BASE)
            .json::<BitableIds>()
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&ids)
        {
            let _ = kv
                .put(K_BASE, serde_json::to_string(&ids)?)?
                .execute()
                .await;
        }
        return Ok(ids);
    }
    if let Some(ids) = kv.get(K_BASE).json::<BitableIds>().await.ok().flatten() {
        return Ok(ids);
    }

    // Bootstrap: the app creates and owns the base; a human gets access
    // through FEEDBACK_ADMIN_OPEN_ID (see grant_admin).
    let (_, v) = feishu_json(
        Method::Post,
        &format!("{FEISHU}/bitable/v1/apps"),
        token,
        json!({ "name": BASE_NAME }),
    )
    .await?;
    let app_token = v
        .pointer("/data/app/app_token")
        .and_then(Value::as_str)
        .ok_or("app token missing")?
        .to_string();

    let (_, v) = feishu_json(
        Method::Post,
        &format!("{FEISHU}/bitable/v1/apps/{app_token}/tables"),
        token,
        table_schema(),
    )
    .await?;
    // The create response's table id shows up under either shape; fall
    // back to listing by name (verified live: both shapes occur).
    let table_id = match v
        .pointer("/data/table/table_id")
        .or_else(|| v.pointer("/data/table_id"))
        .and_then(Value::as_str)
    {
        Some(id) => id.to_string(),
        None => list_table_by_name(token, &app_token).await?,
    };

    let ids = BitableIds {
        app_token,
        table_id,
    };
    let _ = kv
        .put(K_BASE, serde_json::to_string(&ids)?)?
        .execute()
        .await;
    if let Ok(open_id) = env.var("FEEDBACK_ADMIN_OPEN_ID").map(|v| v.to_string()) {
        grant_admin(token, &ids.app_token, &open_id).await;
    }
    Ok(ids)
}

async fn list_table_by_name(token: &str, app_token: &str) -> Result<String> {
    let (_, v) = feishu_json(
        Method::Get,
        &format!("{FEISHU}/bitable/v1/apps/{app_token}/tables?page_size=50"),
        token,
        Value::Null,
    )
    .await?;
    v.pointer("/data/items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|t| t.get("name").and_then(Value::as_str) == Some(feedback::TABLE_NAME))
                .and_then(|t| t.get("table_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| "feedback table not found".into())
}

/// Grant a human `full_access` on the base (idempotent; failures are
/// logged-and-ignored — the records pipeline does not need the human).
async fn grant_admin(token: &str, app_token: &str, open_id: &str) {
    let _ = feishu_json(
        Method::Post,
        &format!(
            "{FEISHU}/drive/v1/permissions/{app_token}/members?type=bitable_file&need_notification=false"
        ),
        token,
        json!({ "member_type": "openid", "member_id": open_id, "perm": "full_access" }),
    )
    .await;
}

// ── small helpers ──────────────────────────────────────────────────────

/// The one outbound-HTTP door: every third-party call (Turnstile, Feishu)
/// goes through this so redirect/timeout behavior stays uniform.
pub(crate) async fn http_call(
    method: Method,
    url: &str,
    headers: Headers,
    body: Option<Vec<u8>>,
) -> Result<Response> {
    let mut init = RequestInit::new();
    init.with_method(method)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Follow);
    if let Some(bytes) = body {
        init.with_body(Some(js_sys::Uint8Array::from(bytes.as_slice()).into()));
    }
    let req = Request::new_with_init(url, &init)?;
    Fetch::Request(req).send().await
}

pub(crate) fn json_headers(token: Option<&str>) -> Result<Headers> {
    let headers = Headers::new();
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    if let Some(t) = token {
        headers.set("Authorization", &format!("Bearer {t}"))?;
    }
    Ok(headers)
}

/// Bitable text fields come back as a plain string OR as an array of
/// text segments (multi-line values) — flatten either.
fn text_val(v: &Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(segs)) => segs
            .iter()
            .filter_map(|s| s.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn urlencode(s: &str) -> String {
    relay_core::feedback::urlencode(s)
}

pub(crate) fn ok(v: Value) -> Result<Response> {
    let mut resp = Response::from_json(&v)?;
    resp.headers_mut().set("Cache-Control", "no-store")?;
    Ok(resp)
}

pub(crate) fn err(status: u16, code: &str) -> Result<Response> {
    let mut resp = Response::from_json(&json!({ "ok": false, "error": code }))?;
    resp.headers_mut().set("Cache-Control", "no-store")?;
    Ok(resp.with_status(status))
}
