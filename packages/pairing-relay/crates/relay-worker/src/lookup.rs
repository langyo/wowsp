//! GET|POST /api/lookup/fetch?url=… — the cache-mesh stats proxy's I/O
//! half (design contract: docs/en/designs/cache-mesh.md §3). Every
//! policy decision — the 13-host allowlist gate, the TTL table, the
//! canonical request line, the CID, the envelope — lives in
//! [`relay_core::lookup`]; this module owns the plumbing:
//!
//! 1. edge Cache API (`https://lookup.edge/<cid>`, the digests.rs
//!    pattern) — hot traffic burns NO storage reads and NO budget;
//!    the rate counter is only spent after an edge miss;
//! 2. the R2 block store via [`crate::blocks`] — the fresh envelope
//!    (TTL + 24 h grace, §4.3), one object per CID;
//! 3. peer pull-through (§5.4, `LOOKUP_SYNC` on): up to
//!    `SYNC_PEERS_MAX` peers with the `blocks` capability answer
//!    `GET {peer}/api/blocks/<cid>`; every peer row is CID-verified
//!    against OUR canonical line and TTL-reclassified locally before
//!    it is stored or served (§4.2/§8 — a lying peer's row fails the
//!    hash check and is dropped; a lying TTL is simply overwritten);
//! 4. the real upstream (browser UA, §3.1) — non-2xx answers
//!    `502 upstream_failed` so the client falls back to its direct
//!    chain; bodies over the 8 MiB store cap pass through UNCACHED.
//!
//! Abuse budget (§3.5): the per-IP hourly counter lives in the
//! LookupRate SQLite Durable Object (`src/lookup_rate.rs`), NOT in KV
//! — a KV counter would PUT once per request against the namespace's
//! 1000-writes/day free budget (the 2026-10-22 incident shape), while
//! DO storage carries no shared quota. Sharded per (hour, IP).
//!
//! Residual risks, documented (workers-rs 0.8's `fetch` carries no
//! per-request timeout — no AbortSignal plumbing through
//! `RequestInit`): the §3.1 15 s upstream budget, the §5.4 3 s peer
//! budget and the §5.2 callback budget are enforced by workerd's own
//! subrequest/wall-clock caps here — the native transport enforces
//! the relay-core constants for real. Upstream bodies are also read
//! whole before the cap check (a trusted-ish allowlist host could
//! buffer a large body into wasm memory); the cap then refuses to
//! STORE it.

use relay_core::lookup::{
    self, CACHE_HEADER, CACHE_HIT, CACHE_MISS, CACHE_PEER_HIT, LookupEnvelope,
};
use relay_core::peers;
use worker::*;

use crate::feedback::{client_ip, err, http_call};

/// Default response content-type (§3.4).
const DEFAULT_CONTENT_TYPE: &str = "application/json";
/// The LookupRate DO binding (wrangler.toml).
const RATE_DO: &str = "LOOKUP_RATE";

/// GET|POST /api/lookup/fetch?url=… — see the module doc.
pub async fn handle_fetch(mut req: Request, env: Env, raw_url: Option<&str>) -> Result<Response> {
    match req.method() {
        Method::Options => return cors_preflight(),
        Method::Get | Method::Post => {},
        _ => return err(405, "method_not_allowed"),
    }

    // ── §3.1/§3.2 gates ────────────────────────────────────────────
    let Some(encoded) = raw_url else {
        return err(400, "missing_url");
    };
    let url = match lookup::percent_decode(encoded) {
        Some(url) if !url.is_empty() => url,
        _ => return err(400, "bad_url"),
    };
    let Some(host) = lookup::allowed_host(&url) else {
        return err(403, "forbidden_host");
    };

    // POST body (§3.1: forwarded verbatim, ≤ 8 KiB). Content-Length
    // is REQUIRED on a POST — a chunked body would otherwise buffer in
    // full before the cap could refuse it (the gateway session
    // handler's discipline).
    let method = req.method();
    let body = if method == Method::Post {
        let Some(len) = req
            .headers()
            .get("Content-Length")?
            .and_then(|v| v.parse::<usize>().ok())
        else {
            return err(411, "length_required");
        };
        if len > lookup::POST_BODY_MAX {
            return err(413, "payload_too_large");
        }
        Some(req.bytes().await?)
    } else {
        None
    };
    let body_hash = body.as_deref().map(lookup::sha256_hex);
    let method_name = if method == Method::Post {
        "POST"
    } else {
        "GET"
    };
    let line = lookup::canonical_request_line(method_name, &url, body_hash.as_deref());
    let cid = lookup::cid_of_request(method_name, &url, body_hash.as_deref());

    // ── 1. edge cache (§3.4) ────────────────────────────────────────
    let cache = Cache::default();
    let cache_key = lookup::edge_cache_key(&cid);
    if let Ok(Some(cached)) = cache.get(cache_key.clone(), true).await {
        return serve_edge_hit(cached).await;
    }

    // ── §3.5 rate limit: only misses spend the counter ─────────────
    let now_ms = Date::now().as_millis() as i64;
    let now_secs = (now_ms / 1000) as u64;
    let ip = client_ip(&req);
    let limit = env
        .var("LOOKUP_RATE_PER_HOUR")
        .ok()
        .and_then(|v| v.to_string().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(lookup::LOOKUP_RATE_PER_HOUR);
    if !spend_rate(&env, &ip, now_ms, limit).await {
        let mut resp =
            crate::replay::err_retry(429, "rate_limited", lookup::hour_retry_after_secs(now_ms))?;
        resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
        return Ok(resp);
    }

    // ── 2. stored envelope (§3.3) ───────────────────────────────────
    if let Some(envelope) = crate::blocks::load_block(&env, &cid).await {
        if envelope.is_fresh(now_secs) {
            let resp = serve_envelope(&envelope, CACHE_HIT, now_secs)?;
            fill_edge_cache(&cache, &cache_key, &envelope, now_secs).await;
            return Ok(resp);
        }
        // Stale (§4.3's grace window): fall through and refresh — the
        // refill overwrites the row.
    }

    // ── 3. peer pull-through (§5.4) ────────────────────────────────
    let sync_on = env
        .var("LOOKUP_SYNC")
        .map(|v| v.to_string() != "0")
        .unwrap_or(true);
    if sync_on {
        // §3.3's own classification is the TTL authority — a peer's
        // claimed TTL never survives verification unclamped.
        let local_ttl = lookup::classify_ttl(host, url_path(&url));
        if let Some(envelope) =
            pull_from_peers(&env, &cid, &line, now_ms, now_secs, local_ttl).await
        {
            let resp = serve_envelope(&envelope, CACHE_PEER_HIT, now_secs)?;
            crate::blocks::store_block(&env, &cid, &envelope).await;
            fill_edge_cache(&cache, &cache_key, &envelope, now_secs).await;
            return Ok(resp);
        }
    }

    // ── 4. the real upstream (§3.1) ────────────────────────────────
    let headers = Headers::new();
    headers.set("User-Agent", lookup::BROWSER_UA)?;
    headers.set("Accept", "application/json, */*")?;
    if body.is_some() {
        headers.set(
            "Content-Type",
            req.headers()
                .get("Content-Type")?
                .unwrap_or_else(|| "application/json".into())
                .as_str(),
        )?;
    }
    let upstream = http_call(method.clone(), &url, headers, body).await;
    let mut upstream = match upstream {
        Ok(resp) => resp,
        Err(_) => return err(502, "upstream_failed"),
    };
    let status = upstream.status_code();
    if !(200..=299).contains(&status) {
        return err(502, "upstream_failed");
    }
    let content_type = upstream
        .headers()
        .get("content-type")?
        .unwrap_or_else(|| DEFAULT_CONTENT_TYPE.into());
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return err(502, "upstream_failed"),
    };
    if bytes.len() > lookup::STORE_CAP {
        // §3.1: over-cap bodies pass through UNCACHED (no store entry,
        // no edge entry) — one stream, then the client's own chain.
        let mut resp = Response::from_bytes(bytes)?.with_status(status);
        let h = resp.headers_mut();
        h.set("Content-Type", &content_type)?;
        h.set("Cache-Control", "no-store")?;
        h.set(CACHE_HEADER, CACHE_MISS)?;
        h.set("Access-Control-Allow-Origin", "*")?;
        return Ok(resp);
    }

    // Store + serve (§3.3/§3.4).
    let ttl = lookup::classify_ttl(host, url_path(&url));
    let envelope = LookupEnvelope::new(status, &content_type, &bytes, now_secs, ttl, host, &line);
    crate::blocks::store_block(&env, &cid, &envelope).await;
    let resp = serve_envelope(&envelope, CACHE_MISS, now_secs)?;
    // The edge entry carries its own cache-control (fill_edge_cache
    // builds the stored response; a put without max-age is a no-op).
    fill_edge_cache(&cache, &cache_key, &envelope, now_secs).await;
    Ok(resp)
}

/// Spend one (hour, IP) shard of the §3.5 budget in the LookupRate
/// DO. FAIL-CLOSED on a DO fetch error (the KV counter's posture: a
/// failing limiter refuses rather than flows unthrottled). A MISSING
/// BINDING skips the limit — stated plainly, that is a deviation only
/// a deliberate binding-less deploy reaches (the official and example
/// configs both bind the class).
async fn spend_rate(env: &Env, ip: &str, now_ms: i64, limit: u64) -> bool {
    let Ok(namespace) = env.durable_object(RATE_DO) else {
        return true;
    };
    let shard = now_ms.div_euclid(3_600_000);
    let Ok(stub) = namespace
        .id_from_name(&format!("{shard}:{ip}"))
        .and_then(|id| id.get_stub())
    else {
        return false;
    };
    match stub
        .fetch_with_str(&format!("https://lookup-rate/spend?limit={limit}"))
        .await
    {
        Ok(resp) => resp.status_code() == 200,
        Err(_) => false,
    }
}

/// The path portion of an absolute URL (query excluded — the TTL table
/// keys on path shapes only).
fn url_path(url: &str) -> &str {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    // Skip the authority (up to the first path/query/fragment marker —
    // the §3.2 gate already refused userinfo authorities).
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let rest = &after_scheme[authority_end..];
    let cut = rest.find(['?', '#']).unwrap_or(rest.len());
    &rest[..cut]
}

/// §5.4: ask up to SYNC_PEERS_MAX blocks-capable peers for the CID.
/// Every candidate row is verified against OUR canonical line
/// (`cid_verify`) and its TTL is reclassified by the LOCAL §3.3 table
/// (review finding 5: a peer's TTL claim is never trusted) — a row
/// failing any check is skipped, not an error.
///
/// Candidate selection (review finding 7): rows from the OWN registry
/// come first (list order); when the own registry is EMPTY the
/// candidates are picked deterministically-random from the merged
/// list — order keyed by sha256(url, cid, hour) — so a hostile
/// upstream list cannot monopolize the first SYNC_PEERS_MAX slots.
async fn pull_from_peers(
    env: &Env,
    cid: &str,
    line: &str,
    now_ms: i64,
    now_secs: u64,
    local_ttl: u64,
) -> Option<LookupEnvelope> {
    let view = crate::peers::mesh_view(env).await;
    if view.peers.is_empty() {
        return None;
    }
    let max = env
        .var("SYNC_PEERS_MAX")
        .ok()
        .and_then(|v| v.to_string().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(peers::SYNC_PEERS_MAX_DEFAULT);
    let candidates = if view.own_empty {
        let hour = now_ms.div_euclid(3_600_000);
        peers::sync_candidates_seeded(&view.peers, max, &format!("{cid}:{hour}"))
    } else {
        peers::sync_candidates(&view.peers, max)
    };
    for peer in candidates {
        let url = format!("{}/api/blocks/{cid}", peer.url);
        let headers = Headers::new();
        let _ = headers.set("User-Agent", lookup::BROWSER_UA);
        let Ok(mut resp) = http_call(Method::Get, &url, headers, None).await else {
            continue;
        };
        if resp.status_code() != 200 {
            continue;
        }
        let Ok(text) = resp.text().await else {
            continue;
        };
        let Ok(envelope) = serde_json::from_str::<LookupEnvelope>(&text) else {
            continue;
        };
        // §4.2/§8: the row must carry the canonical line this CID
        // addresses, and that line must hash to the CID we asked for.
        let Some(peer_line) = envelope.line.as_deref() else {
            continue;
        };
        if peer_line != line || !lookup::cid_verify(cid, line) {
            continue;
        }
        if !(200..=299).contains(&envelope.status) {
            continue;
        }
        let Some(body) = envelope.body() else {
            continue;
        };
        if body.len() > lookup::STORE_CAP {
            continue;
        }
        let mut verified = envelope.clone();
        // Local TTL authority (finding 5); the peer's own claim only
        // ever SHRINKS the window, never extends it.
        verified.ttl = envelope.ttl.min(local_ttl);
        // A peer's already-stale row is no better than a miss — the
        // upstream refresh follows anyway.
        if !verified.is_fresh(now_secs) {
            continue;
        }
        return Some(verified);
    }
    None
}

/// Serve a stored envelope with the §3.4 header set.
fn serve_envelope(envelope: &LookupEnvelope, provenance: &str, now_secs: u64) -> Result<Response> {
    let Some(body) = envelope.body() else {
        return err(500, "stored_block_corrupt");
    };
    let age = envelope.age(now_secs);
    let remaining = lookup::remaining_max_age(envelope.ttl, age);
    let status = if (200..=299).contains(&envelope.status) {
        envelope.status
    } else {
        200
    };
    let mut resp = Response::from_bytes(body)?.with_status(status);
    let headers = resp.headers_mut();
    headers.set(
        "Content-Type",
        if envelope.content_type.is_empty() {
            DEFAULT_CONTENT_TYPE
        } else {
            &envelope.content_type
        },
    )?;
    headers.set("Cache-Control", &lookup::cache_control_public(remaining))?;
    headers.set(CACHE_HEADER, provenance)?;
    headers.set("Age", &age.to_string())?;
    headers.set("Access-Control-Allow-Origin", "*")?;
    Ok(resp)
}

/// Rebuild an edge-cache hit for the client: provenance `hit`, the
/// age from the stored Date header, and a cache-control recomputed to
/// the REMAINING window (the cached object's max-age dates from the
/// fill).
async fn serve_edge_hit(mut cached: Response) -> Result<Response> {
    let now_secs = (Date::now().as_millis() / 1000) as u64;
    let headers = cached.headers();
    let stored_max_age = headers
        .get("Cache-Control")?
        .and_then(|cc| {
            cc.split(',')
                .find_map(|part| part.trim().strip_prefix("max-age="))
                .and_then(|n| n.trim().parse::<u64>().ok())
        })
        .unwrap_or(0);
    let date_secs = headers
        .get("Date")?
        .and_then(|d| parse_http_date_secs(&d))
        .unwrap_or(now_secs);
    let content_type = headers
        .get("Content-Type")?
        .unwrap_or_else(|| DEFAULT_CONTENT_TYPE.into());
    let status = cached.status_code();
    let body = cached.bytes().await?;
    let age = now_secs.saturating_sub(date_secs);
    let remaining = lookup::remaining_max_age(stored_max_age, age);
    let mut resp = Response::from_bytes(body)?.with_status(status);
    let out = resp.headers_mut();
    out.set("Content-Type", &content_type)?;
    out.set("Cache-Control", &lookup::cache_control_public(remaining))?;
    out.set(CACHE_HEADER, CACHE_HIT)?;
    out.set("Age", &age.to_string())?;
    out.set("Access-Control-Allow-Origin", "*")?;
    Ok(resp)
}

/// Best-effort edge fill (§3.4): the entry needs cache-control with
/// max-age on the response object, and its TTL mirrors the envelope's
/// REMAINING window so edge expiry and freshness stay aligned.
async fn fill_edge_cache(cache: &Cache, cache_key: &str, envelope: &LookupEnvelope, now_secs: u64) {
    let Some(body) = envelope.body() else {
        return;
    };
    let age = envelope.age(now_secs);
    let remaining = lookup::remaining_max_age(envelope.ttl, age);
    if remaining == 0 {
        return;
    }
    let status = if (200..=299).contains(&envelope.status) {
        envelope.status
    } else {
        200
    };
    let Ok(mut cached) = Response::from_bytes(body).map(|resp| resp.with_status(status)) else {
        return;
    };
    let headers = cached.headers_mut();
    let _ = headers.set(
        "Content-Type",
        if envelope.content_type.is_empty() {
            DEFAULT_CONTENT_TYPE
        } else {
            &envelope.content_type
        },
    );
    let _ = headers.set("Cache-Control", &lookup::cache_control_public(remaining));
    let _ = cache.put(cache_key.to_string(), cached).await;
}

/// Parse an RFC 7231 IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`)
/// to unix seconds — workerd normalizes Date headers to this shape.
fn parse_http_date_secs(value: &str) -> Option<u64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let value = value.trim();
    let rest = value.split_once(", ")?.1;
    let mut parts = rest.split_whitespace();
    let day: u64 = parts.next()?.parse().ok()?;
    let month_name = parts.next()?;
    let month = MONTHS.iter().position(|m| *m == month_name)? as u64 + 1;
    let year: u64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    let mut clock = time.split(':');
    let hour: u64 = clock.next()?.parse().ok()?;
    let minute: u64 = clock.next()?.parse().ok()?;
    let second: u64 = clock.next()?.parse().ok()?;
    // Days since epoch (civil-from-days algorithm, Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// CORS preflight (§3.4: the stats family is public data; browsers
/// may call directly).
fn cors_preflight() -> Result<Response> {
    let mut resp = Response::empty()?.with_status(204);
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;
    headers.set("Access-Control-Max-Age", "600")?;
    Ok(resp)
}
