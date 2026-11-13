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
//!
//! The PIN-pairing rooms (`/api/relay/*`, the Room + Directory Durable
//! Objects) were retired with the pairing mode on 2026-11-13; the
//! account-routed gateway push above is the live phone↔desktop channel.

pub mod digests;
pub mod erp;
pub mod feedback;
pub mod gateway;
pub mod qqbot;
pub mod replay;
pub mod replay_index;
pub mod sponsors;

pub use gateway::{GatewayAuth, GatewayChannel};
pub use replay_index::ReplayIndex;

use relay_core::manifest::{ManifestOverrides, gateway_manifest};
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

    match classify(&path, &query) {
        Route::Health => {
            let notice = env.var("GATEWAY_NOTICE").ok().map(|v| v.to_string());
            let health = gateway_manifest(&ManifestOverrides::from_raw(notice.as_deref()));
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
