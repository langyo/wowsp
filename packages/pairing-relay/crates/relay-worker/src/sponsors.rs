//! GET /api/sponsors + the daily afdian poll (cron) — see
//! relay_core::sponsors for the document's shape and every policy
//! decision. The route serves the KV document verbatim with a 30-minute
//! client cache; the poll walks query-sponsor + query-order with the
//! md5-signed open-API envelope and writes the reduced document back to
//! KV only when its CONTENT changed (updatedAt alone never triggers a
//! write, keeping us far under the free plan's 1000 KV writes/day).

use crate::feedback::{http_call, json_headers};
use relay_core::sponsors::{self, OrderRecord, SponsorRecord, SponsorsDoc};
use serde::de::DeserializeOwned;
use serde_json::Value;
use worker::*;

/// The KV namespace the document caches in (prefix-shared with the
/// feedback / qqbot / replay slots — one namespace, disjoint key
/// domains; see relay_core::sponsors::KV_KEY).
const KV: &str = "FEEDBACK_KV";
const API_ROOT: &str = "https://afdian.com/api/open";
/// The documented per-page maximum for both paginated calls.
const PER_PAGE: u32 = 100;
/// Hard caps so a pathological `total_page` can never loop the cron —
/// and so the worst-case walk stays under the Workers FREE plan's
/// 50-subrequests-per-invocation ceiling: 10 + 35 page fetches plus
/// the KV get/put leaves a little headroom (10 pages of 100 sponsors /
/// 35 pages of 100 orders ≈ 3500 orders — far past any realistic
/// sponsor count for this project).
const MAX_SPONSOR_PAGES: u32 = 10;
const MAX_ORDER_PAGES: u32 = 35;

/// Serve the cached document (see the module docs). 503 — not 404 —
/// before the first successful poll: the app treats it like any relay
/// failure and falls back to its own last-good cache.
pub async fn handle(req: Request, env: Env) -> Result<Response> {
    if req.method() != Method::Get {
        return Response::error("method not allowed", 405);
    }
    // Audit M-10: same public-read budget as the other unauthenticated
    // GETs — the page polls this sparingly; floods pay 429 instead of KV.
    if !crate::replay::spend_public_read(&env, "sponsors", &crate::feedback::client_ip(&req))
        .await?
    {
        return crate::replay::err_retry(429, "rate_limited", 600);
    }
    let kv = match env.kv(KV) {
        Ok(kv) => kv,
        Err(_) => return Response::error("sponsor store not configured on this gateway", 503),
    };
    let Some(doc) = kv.get(sponsors::KV_KEY).json::<SponsorsDoc>().await? else {
        return Response::error("sponsor list not ready yet", 503);
    };
    if !sponsors::doc_is_sane(&doc) {
        // Corruption or tampering in the store itself: refuse loudly
        // rather than serve an unverifiable document (digests pattern).
        return Response::error("stored sponsor document failed validation", 500);
    }
    let mut resp = Response::from_json(&doc)?;
    resp.headers_mut()
        .set("cache-control", "public, max-age=1800")?;
    Ok(resp)
}

struct Creds {
    token: String,
    user_id: String,
}

/// Both halves of the open-API identity. The token is a worker SECRET
/// (never a var — it only ever enters the md5 concatenation); the
/// user_id is a public handle and rides [vars]. Missing either disables
/// the whole poll quietly, like the qqbot creds.
fn creds(env: &Env) -> Option<Creds> {
    let token = env.secret("AFDIAN_API_TOKEN").ok()?.to_string();
    let user_id = env.var("AFDIAN_USER_ID").ok()?.to_string();
    (!token.is_empty() && !user_id.is_empty()).then_some(Creds { token, user_id })
}

/// One signed open-API POST. Answers the page's `list` plus `total_page`
/// (both defaulting to empty/1 on a sparse response).
async fn api_call(c: &Creds, endpoint: &str, page: u32) -> Result<(Vec<Value>, u32)> {
    let ts = Date::now().as_millis() as i64 / 1000;
    let params = sponsors::page_params(page, PER_PAGE);
    let body = sponsors::call_body(&c.token, &c.user_id, ts, &params);
    let mut resp = http_call(
        Method::Post,
        &format!("{API_ROOT}/{endpoint}"),
        json_headers(None)?,
        Some(body.into_bytes()),
    )
    .await?;
    let v: Value = resp.json().await?;
    if v.get("ec").and_then(Value::as_i64) != Some(200) {
        return Err(format!("afdian {endpoint}: ec {} em {:?}", v["ec"], v["em"]).into());
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let list = data
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total_page = data
        .get("total_page")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, u64::from(u32::MAX)) as u32;
    Ok((list, total_page))
}

/// Walk every page of one endpoint into typed rows.
async fn paged<T: DeserializeOwned>(c: &Creds, endpoint: &str, cap: u32) -> Result<Vec<T>> {
    let mut out = Vec::new();
    let mut total_page = 1u32;
    let mut page = 1u32;
    while page <= total_page.min(cap) {
        let (list, seen_total) = api_call(c, endpoint, page).await?;
        total_page = seen_total;
        for item in list {
            let row: T = serde_json::from_value(item)
                .map_err(|e| format!("afdian {endpoint}: bad row: {e}"))?;
            out.push(row);
        }
        page += 1;
    }
    Ok(out)
}

/// The cron body: pull → reduce → cache-if-changed. Every failure only
/// logs — a broken poll keeps yesterday's document serving, and a
/// failing cron run is noise, not an incident.
pub async fn poll(env: &Env) {
    let Some(c) = creds(env) else {
        worker::console_warn!(
            "afdian sponsors: AFDIAN_API_TOKEN / AFDIAN_USER_ID unset — poll skipped"
        );
        return;
    };
    let run = async {
        let sponsor_rows: Vec<SponsorRecord> =
            paged(&c, "query-sponsor", MAX_SPONSOR_PAGES).await?;
        let order_rows: Vec<OrderRecord> = paged(&c, "query-order", MAX_ORDER_PAGES).await?;
        let now = Date::now().as_millis() as i64 / 1000;
        let doc = sponsors::build_doc(now, &sponsor_rows, &order_rows);
        let kv = env.kv(KV).map_err(|e| format!("kv bind: {e}"))?;
        // Change detection ignores updatedAt (it moves every run) —
        // only the content array gates the write.
        let content =
            serde_json::to_string(&doc.sponsors).map_err(|e| format!("serialize sponsors: {e}"))?;
        let existing = kv.get(sponsors::KV_KEY).text().await?;
        let changed = existing
            .as_deref()
            .and_then(|prev| serde_json::from_str::<SponsorsDoc>(prev).ok())
            .map(|prev| {
                serde_json::to_string(&prev.sponsors).ok().as_deref() != Some(content.as_str())
            })
            .unwrap_or(true);
        if changed {
            let body = serde_json::to_string(&doc).map_err(|e| format!("serialize doc: {e}"))?;
            kv.put(sponsors::KV_KEY, body)?.execute().await?;
            worker::console_log!(
                "afdian sponsors: refreshed ({} rows, {page_stats} pages)",
                doc.sponsors.len(),
                page_stats = format!("{}s+{}o", sponsor_rows.len(), order_rows.len()),
            );
        }
        Ok::<(), Error>(())
    };
    if let Err(e) = run.await {
        worker::console_warn!("afdian sponsors poll failed: {e}");
    }
}
