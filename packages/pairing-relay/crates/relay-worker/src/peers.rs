//! GET /api/peers + POST /api/peers/announce — the peer registry's
//! I/O half (design contract: docs/en/designs/cache-mesh.md §5).
//! Policy (URL gates, announce body shape, merge rule, budgets) lives
//! in [`relay_core::peers`]; this module owns the registry document,
//! the upstream-list subscription and the §5.2 liveness callback.
//!
//! Quota economics (review findings 1c/2, 2026-11-25 KV incident):
//! the OWN registry is ONE KV document (`peers:own`, the whole
//! `Vec<PeerRow>` — 128 rows × ~300 B fits trivially), rewritten only
//! on announce (already bounded 10/h/IP). The list route and the
//! lookup pull-through share ONE 60 s edge-cached mesh view
//! (`https://mesh.edge/view`), so a warm mesh costs ZERO storage
//! reads; a cold view miss pays ONE read on the official node (its
//! list IS its own registry, and `PEERS_UPSTREAM` — unset there —
//! gates the second read that used to be a guaranteed miss) and TWO
//! on a subscriber. No KV LIST, no per-row GETs, no per-request
//! counter writes: ≤ 2 reads per 60 s view window plus ~1 write per
//! accepted announce.
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
/// The edge-cache key of the list render (60 s, the route's max-age).
const EDGE_LIST_KEY: &str = "https://peers.edge/list";
/// The edge-cache key of the merged mesh view (60 s — the upstream
/// subscription's own window; shared by the list route and the lookup
/// pull-through, see [`mesh_view`]).
const EDGE_MESH_KEY: &str = "https://mesh.edge/view";

/// The cached upstream subscription's wrapper shape.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamCache {
    fetched_at: u64,
    rows: Vec<PeerRow>,
}

/// This node's merged view of the mesh, plus whether the OWN registry
/// contributed any row (the §5.4 pull-through picks candidates
/// deterministically-random when it did not — see lookup.rs).
#[derive(Serialize, Deserialize)]
pub(crate) struct MeshView {
    pub own_empty: bool,
    pub peers: Vec<PeerRow>,
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
/// revalidation and edge-cached a minute. No per-request KV budget
/// counter: the route reads a fixed-key 60 s cache, so the old
/// counter PUT on every edge miss was pure write amplification (the
/// empty-registry autodiscover walk paid it every 10 minutes —
/// 2026-11-25 incident).
pub async fn handle_list(req: Request, env: Env) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Get => {},
        _ => return err(405, "method_not_allowed"),
    }
    // Edge cache first (the digests.rs pattern): a warm edge answers
    // with zero storage reads and zero KV writes.
    let cache = Cache::default();
    if let Ok(Some(cached)) = cache.get(EDGE_LIST_KEY.to_string(), true).await {
        let etag = cached.headers().get("ETag")?.unwrap_or_default();
        if if_none_match(&req, &etag) {
            return not_modified(&etag);
        }
        return Ok(cached);
    }
    // §5.1's subscription: fetch the upstream list at most once per
    // minute (the cache window mirrors the route's own max-age).
    refresh_upstream(&env).await;
    let view = mesh_view(&env).await;
    let doc = peers::peers_doc(view.peers, now_secs());
    let etag = peers::peers_etag(&doc.peers);
    if if_none_match(&req, &etag) {
        return not_modified(&etag);
    }
    let mut resp = Response::from_json(&doc)?;
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Cache-Control", "public, max-age=60")?;
    headers.set("ETag", &etag)?;
    // Best-effort edge fill (needs the cache-control above).
    let _ = cache.put(EDGE_LIST_KEY.to_string(), resp.cloned()?).await;
    Ok(resp)
}

fn if_none_match(req: &Request, etag: &str) -> bool {
    req.headers()
        .get("If-None-Match")
        .ok()
        .flatten()
        .is_some_and(|seen| seen.trim() == etag)
}

fn not_modified(etag: &str) -> Result<Response> {
    let mut resp = Response::empty()?.with_status(304);
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Cache-Control", "public, max-age=60")?;
    headers.set("ETag", etag)?;
    Ok(resp)
}

/// This node's merged view of the mesh: own registry document plus
/// the CACHED upstream subscription (never triggering a fetch — the
/// list route owns the refresh), fronted by a 60 s edge-cache entry
/// so both the list route and the lookup pull-through read ZERO KV
/// rows while the view is warm. On a cold view miss the official node
/// pays exactly ONE read: its list IS its own registry, and
/// `PEERS_UPSTREAM` is unset there, so the never-written
/// `peers:upstream` document is not even attempted (that
/// guaranteed-miss read was half the mesh's read bill in the
/// 2026-11-25 incident). A self-host with a subscription pays two.
///
/// Failure posture: every cache read/serialize/put error silently
/// falls back to the direct computation, so the view's semantics never
/// change — only the read count does.
pub(crate) async fn mesh_view(env: &Env) -> MeshView {
    let cache = Cache::default();
    if let Ok(Some(mut cached)) = cache.get(EDGE_MESH_KEY, true).await {
        if let Ok(view) = cached.json::<MeshView>().await {
            return view;
        }
    }
    let own = own_rows(env).await.unwrap_or_default();
    let own_empty = own.is_empty();
    let upstream = if upstream_var(env).is_some() {
        cached_upstream_rows(env).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let view = MeshView {
        own_empty,
        peers: peers::merge_peers(&own, &upstream),
    };
    // Best-effort edge fill (the cache-control is what makes the entry
    // storable; a failed put just means the next cold miss recomputes).
    if let Ok(mut resp) = Response::from_json(&view) {
        let _ = resp
            .headers_mut()
            .set("Cache-Control", "public, max-age=60");
        let _ = cache.put(EDGE_MESH_KEY, resp).await;
    }
    view
}

/// The configured upstream subscription URL, or `None` when this node
/// is the seed itself (the official node leaves `PEERS_UPSTREAM`
/// unset — it IS the seed everyone subscribes; a set-but-empty var
/// counts as unset). Single source of the "is an upstream configured?"
/// question: [`mesh_view`] skips its second KV read when it is not,
/// [`refresh_upstream`] skips the fetch.
fn upstream_var(env: &Env) -> Option<String> {
    var(env, "PEERS_UPSTREAM").filter(|url| !url.trim().is_empty())
}

/// The own registry document (`peers:own`, one read), lazily
/// expired: a row lives 48 h from its `lastSeenAt` (§5.2.3 — the
/// one-document redesign replaced the per-row KV TTL with this
/// read-time filter, mirroring blocks.rs's lazy expiry). Expired rows
/// simply stop appearing; the next announce-driven rewrite prunes
/// them from the stored document for good.
async fn own_rows(env: &Env) -> Result<Vec<PeerRow>> {
    let kv = registry_kv(env)?;
    let raw = kv.get(peers::OWN_REGISTRY_KEY).text().await.ok().flatten();
    let now = now_secs();
    Ok(raw
        .as_deref()
        .and_then(|text| serde_json::from_str::<Vec<PeerRow>>(text).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.last_seen_at.saturating_add(peers::PEER_TTL_SECS) > now)
        .collect())
}

/// Upsert one row into the own registry document (§5.2.3: re-announce
/// refreshes `lastSeenAt`; past `PEERS_MAX` the oldest-`lastSeenAt`
/// rows are evicted; expired rows are pruned with the rewrite). One
/// read + one write per announce.
///
/// Concurrency, acknowledged: KV is last-writer-wins with cross-colo
/// staleness up to ~60 s, so two near-simultaneous announces can drop
/// each other's row. Self-healing: a dropped peer's next announce
/// re-inserts it (announces repeat), and the 10/h/IP budget plus the
/// tiny registry make the window cheap to accept versus a Durable
/// Object seam.
async fn upsert_own_row(env: &Env, row: PeerRow) -> Result<()> {
    let kv = registry_kv(env)?;
    // own_rows already drops expired rows, so the rewritten document
    // prunes them (and the cap eviction below works on live rows).
    let mut rows = own_rows(env).await?;
    match rows.iter_mut().find(|existing| existing.url == row.url) {
        Some(existing) => *existing = row,
        None => rows.push(row),
    }
    if rows.len() > peers::PEERS_MAX {
        // §5.2.3: evict the oldest-`lastSeenAt` rows past the cap,
        // preserving the survivors' document order.
        let excess = rows.len() - peers::PEERS_MAX;
        let mut order: Vec<usize> = (0..rows.len()).collect();
        order.sort_by_key(|i| rows[*i].last_seen_at);
        let evict: std::collections::HashSet<usize> = order.into_iter().take(excess).collect();
        let mut index = 0;
        rows.retain(|_| {
            let keep = !evict.contains(&index);
            index += 1;
            keep
        });
    }
    let json = serde_json::to_string(&rows)?;
    let _ = kv.put(peers::OWN_REGISTRY_KEY, json)?.execute().await;
    Ok(())
}

/// The upstream subscription rows from the `peers:upstream` cache
/// (stale rows are still merged — a temporarily unreachable upstream
/// must not empty the list). Only reached when [`upstream_var`] says a
/// subscription exists: the official node never writes that document,
/// so reading it there would be a guaranteed miss per cold view.
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
    let Some(upstream) = upstream_var(env) else {
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
    // §5.2.4 rate limit: 10 announces/hour/IP in KV (announce volume
    // is tiny by construction; a KV counter is the right shape here,
    // fail-closed like every other counter).
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

    // Record the row (re-announce refreshes lastSeenAt, §5.2.3; the
    // upsert owns the cap eviction inside the single document).
    let now = now_secs();
    let existing = own_rows(&env)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|row| row.url == public_url);
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
    upsert_own_row(&env, row.clone()).await?;
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
    let now = now_secs();
    let existing = own_rows(env)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|row| row.url == url);
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
    upsert_own_row(env, row).await?;
    listed(false, "private_stored")
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
