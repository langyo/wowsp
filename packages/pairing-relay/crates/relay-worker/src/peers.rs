//! GET /api/peers + POST /api/peers/announce — the peer registry's
//! I/O half (design contract: docs/en/designs/cache-mesh.md §5).
//! Policy (URL gates, announce body shape, merge rule, budgets) lives
//! in [`relay_core::peers`]; this module owns the KV table
//! (`peer:<url>` rows, 48 h TTL), the upstream-list subscription
//! (cached in `peers:upstream`, refreshed at most once a minute) and
//! the §5.2 liveness callback.
//!
//! - The official node leaves `PEERS_UPSTREAM` unset: it IS the seed
//!   everyone subscribes, so its list is its own registry only.
//!   Self-hosts set `PEERS_UPSTREAM` (the example points at
//!   https://wowsp.langyo.xyz).
//! - Announces are best-effort: an unreachable/foreign node answers
//!   `{"ok":true,"listed":false,"reason":…}` with 200 (§5.2.2).
//! - http/IP-literal URLs are accepted as PRIVATE rows: stored for a
//!   LAN fleet's own meshing, never re-broadcast (`merge_peers`
//!   filters them — §5.3). No liveness callback is attempted for them
//!   (the edge cannot reach a private network).

use relay_core::PROVIDER_ID;
use relay_core::manifest::{Manifest, NodeDoc};
use relay_core::peers::{self, AnnounceError, PeerRow};
use serde::{Deserialize, Serialize};
use serde_json::json;
use worker::*;

use crate::feedback::{client_ip, err, http_call};

/// The registry's KV binding (shared namespace).
const KV: &str = "LOOKUP_KV";
/// Pre-cache-mesh selfhosts.
const KV_FALLBACK: &str = "FEEDBACK_KV";

/// The cached upstream subscription's wrapper shape.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamCache {
    fetched_at: u64,
    rows: Vec<PeerRow>,
}

fn registry_kv(env: &Env) -> Result<KvStore> {
    env.kv(KV).or_else(|_| env.kv(KV_FALLBACK))
}

fn var(env: &Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|v| v.to_string())
}

fn now_secs() -> u64 {
    (Date::now().as_millis() / 1000) as u64
}

// ── GET /api/peers (§5.1) ──────────────────────────────────────────────

/// The broadcast list: own registry rows ∪ the upstream subscription
/// (own rows winning — `merge_peers`), ETagged for cheap
/// revalidation, cached a minute.
pub async fn handle_list(req: Request, env: Env) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Get => {},
        _ => return err(405, "method_not_allowed"),
    }
    // §5.1's subscription: fetch the upstream list at most once per
    // minute (the cache window mirrors the route's own max-age).
    refresh_upstream(&env).await;
    let merged = mesh_view(&env).await;
    let doc = peers::peers_doc(merged, now_secs());
    let etag = peers::peers_etag(&doc.peers);
    let mut resp = Response::from_json(&doc)?;
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Cache-Control", "public, max-age=60")?;
    headers.set("ETag", &etag)?;
    if req
        .headers()
        .get("If-None-Match")?
        .is_some_and(|seen| seen.trim() == etag)
    {
        let mut not_modified = Response::empty()?.with_status(304);
        let headers = not_modified.headers_mut();
        headers.set("Access-Control-Allow-Origin", "*")?;
        headers.set("Cache-Control", "public, max-age=60")?;
        headers.set("ETag", &etag)?;
        return Ok(not_modified);
    }
    Ok(resp)
}

/// This node's merged view of the mesh: own rows plus the CACHED
/// upstream subscription (never triggering a fetch — the list route
/// owns the refresh, so the lookup pull-through stays fast).
pub(crate) async fn mesh_view(env: &Env) -> Vec<PeerRow> {
    let own = own_rows(env).await.unwrap_or_default();
    let upstream = cached_upstream_rows(env).await.unwrap_or_default();
    peers::merge_peers(&own, &upstream)
}

/// The registry table (`peer:` prefix; capped at PEERS_MAX rows, so
/// one list page covers it — the cursor loop is defensive only).
async fn own_rows(env: &Env) -> Result<Vec<PeerRow>> {
    let kv = registry_kv(env)?;
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..4 {
        let mut list = kv.list().prefix(peers::PEER_KEY_PREFIX.to_string());
        if let Some(cursor) = cursor.take() {
            list = list.cursor(cursor);
        }
        let page = list.limit(1000).execute().await?;
        for key in page.keys.iter() {
            if let Some(text) = kv.get(&key.name).text().await.ok().flatten() {
                if let Ok(row) = serde_json::from_str::<PeerRow>(&text) {
                    rows.push(row);
                }
            }
        }
        if page.list_complete {
            break;
        }
        cursor = page.cursor;
    }
    Ok(rows)
}

/// The upstream subscription rows from the `peers:upstream` cache
/// (stale rows are still merged — a temporarily unreachable upstream
/// must not empty the list).
async fn cached_upstream_rows(env: &Env) -> Result<Vec<PeerRow>> {
    let kv = registry_kv(env)?;
    let raw = kv
        .get(peers::UPSTREAM_CACHE_KEY)
        .text()
        .await
        .ok()
        .flatten();
    Ok(raw
        .as_deref()
        .and_then(|text| serde_json::from_str::<UpstreamCache>(text).ok())
        .map(|cache| cache.rows)
        .unwrap_or_default())
}

/// §5.1's gossip subscription: when `PEERS_UPSTREAM` is set (never
/// on the official node — it IS the seed), refetch `{upstream}/// /api/peers` once the cached copy is older than a minute. Rows are
/// re-validated through the public URL gate before they enter the
/// cache (a compromised/foreign upstream must not launder a private
/// or garbage row into our list). Every failure keeps the cached
/// rows serving.
async fn refresh_upstream(env: &Env) {
    let Some(upstream) = var(env, "PEERS_UPSTREAM") else {
        return;
    };
    let Ok(kv) = registry_kv(env) else {
        return;
    };
    let now = now_secs();
    let cached = kv
        .get(peers::UPSTREAM_CACHE_KEY)
        .text()
        .await
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<UpstreamCache>(&text).ok());
    if cached
        .is_some_and(|cache| now.saturating_sub(cache.fetched_at) < peers::UPSTREAM_CACHE_TTL_SECS)
    {
        return;
    }
    let url = format!("{}/api/peers", upstream.trim_end_matches('/'));
    let headers = Headers::new();
    let _ = headers.set("User-Agent", relay_core::lookup::BROWSER_UA);
    let Ok(mut resp) = http_call(Method::Get, &url, headers, None).await else {
        return;
    };
    if resp.status_code() != 200 {
        return;
    }
    let Ok(doc) = resp.json::<relay_core::peers::PeersDoc>().await else {
        return;
    };
    // Trust-but-normalize: only rows whose url already carries the
    // canonical public spelling enter the cache.
    let rows: Vec<PeerRow> = doc
        .peers
        .into_iter()
        .filter(|row| {
            !row.private
                && peers::valid_public_peer_url(&row.url).is_some_and(|norm| norm == row.url)
        })
        .collect();
    let cache = UpstreamCache {
        fetched_at: now,
        rows,
    };
    if let Ok(json) = serde_json::to_string(&cache) {
        if let Ok(put) = kv.put(peers::UPSTREAM_CACHE_KEY, json) {
            let _ = put.expiration_ttl(peers::PEER_TTL_SECS).execute().await;
        }
    }
}

// ── POST /api/peers/announce (§5.2) ────────────────────────────────────

pub async fn handle_announce(mut req: Request, env: Env) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Post => {},
        _ => return err(405, "method_not_allowed"),
    }
    // Operator close-the-registry switch (§5.2.5).
    if var(&env, "PEERS_ACCEPT_ANNOUNCES").as_deref() == Some("false") {
        return err(403, "announces_disabled");
    }
    // Body: Content-Length REQUIRED + capped (the gateway session
    // discipline — a chunked body must not buffer past the cap).
    let Some(len) = req
        .headers()
        .get("Content-Length")?
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return err(411, "length_required");
    };
    if len > peers::ANNOUNCE_BODY_MAX {
        return err(413, "payload_too_large");
    }
    // §5.2.4 rate limit: 10 announces/hour/IP, fail-closed like every
    // other counter (the replay `spend`).
    let now_ms = Date::now().as_millis() as i64;
    let ip = client_ip(&req);
    if let Ok(kv) = registry_kv(&env) {
        let key = peers::announce_rate_key(&ip, now_ms);
        if !crate::replay::spend(&kv, &key, peers::ANNOUNCE_RATE_PER_HOUR).await? {
            let mut resp = crate::replay::err_retry(
                429,
                "rate_limited",
                relay_core::lookup::hour_retry_after_secs(now_ms),
            )?;
            resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
            return Ok(resp);
        }
    }
    let body = req.bytes().await?;
    let text = String::from_utf8_lossy(&body);
    let announce = match peers::parse_announce_body(&text) {
        Ok(announce) => announce,
        Err(code) => return err(400, announce_error_code(code)),
    };

    // §5.2.1 shape gate — public names first, private LAN second.
    let Some(public_url) = peers::valid_public_peer_url(&announce.url) else {
        if let Some(private_url) = peers::valid_private_peer_url(&announce.url) {
            return store_private(&env, &private_url, announce.contact.as_deref()).await;
        }
        return err(400, "bad_peer_url");
    };

    // §5.2.2 liveness callback: GET {url}/api/health, 10 s budget
    // (workerd's own subrequest caps enforce it here — no fetch
    // timeout exists in workers-rs 0.8; documented residual).
    let health_url = format!("{public_url}/api/health");
    let headers = Headers::new();
    headers.set("User-Agent", relay_core::lookup::BROWSER_UA)?;
    let mut health = match http_call(Method::Get, &health_url, headers, None).await {
        Ok(resp) => resp,
        Err(_) => return listed(false, "unreachable"),
    };
    if health.status_code() != 200 {
        return listed(false, "unreachable");
    }
    let manifest = match health.json::<Manifest>().await {
        Ok(manifest) => manifest,
        Err(_) => return listed(false, "foreign"),
    };
    if manifest.provider != PROVIDER_ID {
        return listed(false, "foreign");
    }

    // Record the row (re-announce refreshes lastSeenAt, §5.2.3).
    let now = now_secs();
    let kv = registry_kv(&env)?;
    let key = peers::row_key(&public_url);
    let existing = kv
        .get(&key)
        .text()
        .await
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<PeerRow>(&text).ok());
    let row = PeerRow {
        url: public_url.clone(),
        capabilities: manifest.capabilities,
        role: if manifest.node.role.is_empty() {
            "community".to_string()
        } else {
            manifest.node.role
        },
        node_id: if NodeDoc::valid_id(&manifest.node.id) {
            manifest.node.id
        } else {
            String::new()
        },
        added_at: existing.as_ref().map_or(now, |row| row.added_at),
        last_seen_at: now,
        notice: announce.contact.clone(),
        private: false,
    };
    enforce_registry_cap(&env, &kv, &public_url).await;
    let Ok(json) = serde_json::to_string(&row) else {
        return err(500, "row_serialize_failed");
    };
    let _ = kv
        .put(&key, json)?
        .expiration_ttl(peers::PEER_TTL_SECS)
        .execute()
        .await;
    let mut resp = Response::from_json(&json!({
        "ok": true,
        "listed": true,
        "nodeId": row.node_id,
    }))?;
    resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
    Ok(resp)
}

/// §5.3: a private/LAN row — stored for the local fleet, never
/// re-broadcast, no liveness callback (the edge cannot reach the LAN).
async fn store_private(env: &Env, url: &str, contact: Option<&str>) -> Result<Response> {
    let kv = registry_kv(env)?;
    let now = now_secs();
    let key = peers::row_key(url);
    let existing = kv
        .get(&key)
        .text()
        .await
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<PeerRow>(&text).ok());
    let row = PeerRow {
        url: url.to_string(),
        capabilities: Default::default(),
        role: "community".to_string(),
        node_id: String::new(),
        added_at: existing.as_ref().map_or(now, |row| row.added_at),
        last_seen_at: now,
        notice: contact.map(str::to_string),
        private: true,
    };
    enforce_registry_cap(env, &kv, url).await;
    let _ = kv
        .put(&key, serde_json::to_string(&row)?)?
        .expiration_ttl(peers::PEER_TTL_SECS)
        .execute()
        .await;
    listed(false, "private_stored")
}

/// §5.2.3: registry cap 128 — past it, the oldest-`lastSeenAt` row
/// (never the one being written) is evicted. workerd KV lists per key,
/// which is fine at this scale.
async fn enforce_registry_cap(env: &Env, kv: &KvStore, incoming: &str) {
    let Ok(rows) = own_rows(env).await else {
        return;
    };
    if rows.len() < peers::PEERS_MAX {
        return;
    }
    let mut candidates: Vec<&PeerRow> = rows.iter().filter(|row| row.url != incoming).collect();
    candidates.sort_by_key(|row| row.last_seen_at);
    let excess = rows
        .len()
        .saturating_sub(peers::PEERS_MAX.saturating_sub(1));
    for row in candidates.into_iter().take(excess) {
        let _ = kv.delete(&peers::row_key(&row.url)).await;
    }
}

/// §5.2.2's best-effort answer: listed stays 200.
fn listed(listed: bool, reason: &str) -> Result<Response> {
    let mut resp = Response::from_json(&json!({
        "ok": true,
        "listed": listed,
        "reason": reason,
    }))?;
    resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
    Ok(resp)
}

fn announce_error_code(code: AnnounceError) -> &'static str {
    code.code()
}

/// CORS preflight.
fn cors_preflight() -> Result<Response> {
    let mut resp = Response::empty()?.with_status(204);
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;
    headers.set("Access-Control-Max-Age", "600")?;
    Ok(resp)
}
