//! WoWSP worker site — the Cloudflare Worker entry point for
//! wowsp.langyo.xyz (Rust → wasm32-unknown-unknown via worker-build).
//!
//! Structure:
//! - [`relay_core`] carries every protocol/policy decision (pure, host
//!   testable — `cargo test -p relay-core`).
//! - this crate is routing + WebSocket glue only. The static site rides
//!   the worker's `[assets]` layer; `run_worker_first` in
//!   `wrangler.toml` sends only the paths listed below into this code
//!   (the doc-carrying digest channels are NEGATED back to the assets
//!   layer — their served lookups never arrive here; the doc-less
//!   channels still do, for the gated 404; see src/digests.rs):
//!   - `GET /api/health` — the liveness + identity document (operator
//!     notice via the `GATEWAY_NOTICE` var).
//!   - `GET /gateway/health`, `POST /gateway/session`, `WS
//!     /gateway/pub|sub` — the account-routed battle-push namespace
//!     (mobile-gateway wave; see src/gateway.rs and
//!     docs/en/designs/gateway-push.md): health/session answered here,
//!     the sockets forwarded to the GatewayAuth + GatewayChannel
//!     Durable Objects.
//!   - the cache-mesh namespaces (docs/en/designs/cache-mesh.md):
//!     `GET /api/health` answers the manifest with capabilities +
//!     node (§2), `GET|POST /api/lookup/fetch` the stats cache proxy
//!     (src/lookup.rs), `GET /api/blocks/<cid>[/raw]` and `GET
//!     /ipfs/<cid>` the block store (src/blocks.rs), `GET /api/peers`
//!     + `POST /api/peers/announce` the mesh registry (src/peers.rs).
//!
//! The PIN-pairing rooms (`/api/relay/*`, the Room + Directory Durable
//! Objects) were retired with the pairing mode on 2026-11-13; the
//! account-routed gateway push above is the live phone↔desktop channel.

pub mod blocks;
pub mod digests;
pub mod erp;
pub mod feedback;
pub mod gateway;
pub mod lookup;
pub mod lookup_rate;
pub mod peers;
pub mod qqbot;
pub mod replay;
pub mod replay_index;
pub mod sponsors;

pub use gateway::{GatewayAuth, GatewayChannel};
pub use lookup_rate::LookupRate;
pub use replay_index::ReplayIndex;

use relay_core::manifest::{CapabilitiesDoc, ManifestOverrides, NodeDoc, gateway_manifest};
use relay_core::route::{Route, classify};
use worker::*;

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    with_security_headers(route(req, env).await?).await
}

/// The daily cron (wrangler.toml `[triggers]`): refresh the cached
/// afdian sponsor document (see src/sponsors.rs). Every failure logs
/// inside the poll and keeps yesterday's document serving.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    sponsors::poll(&env).await;
}

/// The request router (every response this worker answers itself).
async fn route(req: Request, env: Env) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();
    let query = url.query().unwrap_or("").to_string();
    let route = classify(&path, &query);

    // The advertised off-switch must be REAL (review finding 3): when
    // LOOKUP_ENABLED=0 the six cache-mesh routes answer 404 exactly
    // like absent routes — no capability is served while the health
    // document says it is off.
    if mesh_disabled(&env, &route) {
        return Response::error("not found", 404);
    }

    match route {
        Route::Health => {
            let notice = env.var("GATEWAY_NOTICE").ok().map(|v| v.to_string());
            let overrides = ManifestOverrides {
                notice: notice
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                capabilities: manifest_capabilities(&env),
                node: manifest_node(&env, &req).await,
            };
            let health = gateway_manifest(&overrides);
            let mut resp = Response::from_json(&health)?;
            resp.headers_mut().set("cache-control", "no-store")?;
            Ok(resp)
        },

        // ── gateway push namespace (see src/gateway.rs) ──────────────────
        Route::GatewayHealth => gateway::handle_health(req, &env),
        Route::GatewaySession => gateway::handle_session(req, env).await,
        Route::GatewayPub {
            route,
            ticket,
            host_id,
        } => gateway::handle_pub(req, env, route, ticket, host_id).await,
        Route::GatewaySub { route, ticket } => gateway::handle_sub(req, env, route, ticket).await,

        // ── release digests (see src/digests.rs) ────────────────────────
        Route::Digests { channel, tag } => digests::handle(req, env, channel, tag).await,

        // ── feedback pipeline (see src/feedback.rs) ─────────────────────
        Route::FeedbackSubmit => feedback::handle_submit(req, env).await,
        Route::FeedbackConfig => feedback::handle_config(req, &env),
        Route::FeedbackList => feedback::handle_list(req, env).await,
        Route::FeedbackHistory { token: _ } => feedback::handle_history(req, env).await,
        Route::FeedbackUpdate => feedback::handle_update(req, env).await,
        Route::QqBotCallback => qqbot::handle_callback(req, &env).await,
        Route::Sponsors => sponsors::handle(req, env).await,
        Route::FeedbackAttachment { file_token: _ } => feedback::handle_attachment(req, env).await,

        // ── replay share (see src/replay.rs) ─────────────────────────────
        Route::ReplaysWanted => replay::handle_wanted(req, env).await,
        Route::ReplaysCheck => replay::handle_check(req, env).await,
        Route::ReplaysMine => replay::handle_mine(req, env).await,
        Route::ReplaysArchive => replay::handle_archive(req, env).await,
        Route::ReplaysUpload => replay::handle_upload(req, env).await,
        Route::ReplaysAdminList => replay::handle_admin_list(req, env).await,
        Route::ReplaysAdminCredits => replay::handle_admin_credits(req, env).await,
        Route::ReplaysAdminWanted => replay::handle_admin_wanted(req, env).await,
        Route::ReplaysAdminArchive { anon_id: _ } => replay::handle_admin_archive(req, env).await,
        Route::ReplaysAdminDrain => replay::handle_admin_drain(req, env).await,
        Route::ReplaysAdminRename => replay::handle_admin_rename(req, env).await,
        Route::ReplaysAdminBackfill => replay::handle_admin_backfill(req, env).await,

        // ── cache-mesh namespaces (docs/en/designs/cache-mesh.md) ───────
        Route::LookupFetch { url } => lookup::handle_fetch(req, env, url).await,
        Route::BlockGet { cid } => blocks::handle_block_get(req, env, cid).await,
        Route::BlockRaw { cid } => blocks::handle_block_raw(req, env, cid).await,
        Route::IpfsGateway { cid } => blocks::handle_ipfs(req, env, cid).await,
        Route::PeersList => peers::handle_list(req, env).await,
        Route::PeersAnnounce => peers::handle_announce(req, env).await,

        // ── erp console auth (see src/erp.rs) ────────────────────────────
        Route::ErpLogin => erp::handle_login(req, env).await,
        Route::ErpCallback => erp::handle_callback(req, env).await,
        Route::ErpSession => erp::handle_session(req, env).await,
        Route::ErpLogout => erp::handle_logout(req, env).await,
        Route::ErpUsers => erp::handle_users(req, env).await,
        Route::ErpMembers => erp::handle_members(req, env).await,

        Route::NotFound => Response::error("not found", 404),
    }
}

// ── cache-mesh manifest inputs (§2) ─────────────────────────────────────

/// Is the cache-mesh namespace OFF (`LOOKUP_ENABLED=0`)? Absent =
/// on (the digest-channel var discipline — a var named in
/// wrangler.toml is a DEPLOYED value).
fn mesh_off(env: &Env) -> bool {
    env.var("LOOKUP_ENABLED")
        .map(|v| v.to_string() == "0")
        .unwrap_or(false)
}

/// Review finding 3's dispatch gate: the six cache-mesh routes when
/// the namespace is off. Answers indistinguishable from absent routes.
fn mesh_disabled(env: &Env, route: &Route) -> bool {
    mesh_off(env)
        && matches!(
            route,
            Route::LookupFetch { .. }
                | Route::BlockGet { .. }
                | Route::BlockRaw { .. }
                | Route::IpfsGateway { .. }
                | Route::PeersList
                | Route::PeersAnnounce
        )
}

/// The §2 capability vector of this deployment: `gateway` always on
/// (this worker IS the push namespace), the three cache-mesh
/// namespaces riding the single `LOOKUP_ENABLED` switch — and the
/// dispatch gate above refuses their routes when it is off, so the
/// advertised flags and the served surface always agree.
fn manifest_capabilities(env: &Env) -> CapabilitiesDoc {
    let mesh_on = !mesh_off(env);
    CapabilitiesDoc {
        gateway: true,
        lookup: mesh_on,
        peers: mesh_on,
        blocks: mesh_on,
    }
}

/// The §2 node doc: stable id (KV `node:id`, minted once from
/// workerd's CSPRNG), role (`NODE_ROLE`, "community" default — the
/// official wrangler.toml sets "official"), sync flag (`LOOKUP_SYNC`,
/// absent = on), peers upstream (`PEERS_UPSTREAM`, or this
/// deployment's own root when official — informational).
async fn manifest_node(env: &Env, req: &Request) -> NodeDoc {
    let role = env
        .var("NODE_ROLE")
        .ok()
        .map(|v| v.to_string())
        .filter(|r| r == "official" || r == "community")
        .unwrap_or_else(|| "community".to_string());
    let peers_upstream = env
        .var("PEERS_UPSTREAM")
        .ok()
        .map(|v| v.to_string())
        .or_else(|| {
            // The official node IS the seed; showing its own root is
            // the doc's example spelling.
            (role == "official")
                .then(|| {
                    req.url()
                        .ok()
                        .and_then(|url| url.host_str().map(|host| format!("https://{host}")))
                })
                .flatten()
        });
    NodeDoc {
        id: node_id(env).await,
        role,
        sync: env
            .var("LOOKUP_SYNC")
            .map(|v| v.to_string() != "0")
            .unwrap_or(true),
        peers_upstream,
    }
}

/// The stable node id (§2: 32 lowercase hex): KV `node:id`, minted
/// from getrandom's workerd CSPRNG on first read and written once.
/// A failing KV write still answers the minted id (stability is
/// best-effort under a quota outage, never a broken health doc).
///
/// The resolved id is edge-cached for 60 s (review finding 6): a warm
/// /api/health pays NO storage ops, so the route cannot be drained by
/// polling. The health document itself stays `no-store` (§2) — only
/// this internal lookup carries the cache.
async fn node_id(env: &Env) -> String {
    #[derive(serde::Serialize, serde::Deserialize)]
    struct NodeIdDoc {
        id: String,
    }
    const EDGE_KEY: &str = "https://health.edge/node-id";
    const KEY: &str = "node:id";
    let cache = Cache::default();
    if let Ok(Some(mut cached)) = cache.get(EDGE_KEY.to_string(), true).await {
        if let Ok(doc) = cached.json::<NodeIdDoc>().await {
            if relay_core::manifest::NodeDoc::valid_id(&doc.id) {
                return doc.id;
            }
        }
    }
    // Binding chain (review finding 4): LOOKUP_KV → FEEDBACK_KV →
    // GATEWAY_KV, so a gateway-only selfhost (which binds GATEWAY_KV
    // alone) still persists its id instead of re-minting per call.
    let kv = env
        .kv("LOOKUP_KV")
        .or_else(|_| env.kv("FEEDBACK_KV"))
        .or_else(|_| env.kv("GATEWAY_KV"));
    if let Ok(kv) = &kv {
        if let Ok(Some(id)) = kv.get(KEY).text().await {
            if relay_core::manifest::NodeDoc::valid_id(&id) {
                fill_node_id_cache(&cache, EDGE_KEY, &id).await;
                return id;
            }
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("workerd crypto.getRandomValues unavailable");
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    if let Ok(kv) = &kv {
        if let Ok(put) = kv.put(KEY, id.clone()) {
            let _ = put.execute().await;
        }
    }
    fill_node_id_cache(&cache, EDGE_KEY, &id).await;
    id
}

/// Best-effort 60 s edge entry for the resolved node id.
async fn fill_node_id_cache(cache: &Cache, edge_key: &str, id: &str) {
    if let Ok(mut entry) = Response::from_json(&serde_json::json!({ "id": id })) {
        let _ = entry
            .headers_mut()
            .set("Cache-Control", "public, max-age=60");
        let _ = cache.put(edge_key.to_string(), entry).await;
    }
}

/// The one response exit: every response this worker sends to a client
/// is decorated here with the security header matrix from
/// [`relay_core::headers`] (the policy itself — which headers on which
/// kind, and why — is unit-tested there). WebSocket upgrades (101, the
/// gateway pub/sub handshakes) pass through byte-identical.
///
/// Header values from subrequests (the Durable Object stubs) carry
/// workerd's immutable guard — a failed `set` falls back to rebuilding
/// the response with a fresh, locally owned `Headers` object.
async fn with_security_headers(resp: Response) -> Result<Response> {
    let content_type = resp.headers().get("Content-Type").ok().flatten();
    let kind = relay_core::headers::response_kind(resp.status_code(), content_type.as_deref());
    let extra = relay_core::headers::security_headers(kind);
    if extra.is_empty() {
        return Ok(resp);
    }

    let mut out = resp;
    for (name, value) in extra {
        if out.headers_mut().set(name, value).is_err() {
            // Immutable-guarded headers (DO-stub responses): rebuild.
            // Only non-101 responses get here, so the body is small
            // JSON/empty and buffering it is free.
            let status = out.status_code();
            let bytes = out.bytes().await?;
            let headers = Headers::from_iter(out.headers().entries());
            out = Response::from_bytes(bytes)?
                .with_status(status)
                .with_headers(headers);
            out.headers_mut().set(name, value)?;
        }
    }
    Ok(out)
}
