//! relay-server — the NATIVE wowsp-server (contract:
//! docs/en/designs/cache-mesh.md). One host-target binary + this lib
//! (the integration tests drive the same builders):
//!
//! - `/gateway/*` — the battle-push namespace, relay-core's gateway
//!   state machines over in-process hubs (gateway.rs);
//! - `/api/lookup/*` — the allowlisted stats-cache proxy (lookup.rs);
//! - `/api/blocks/*` + `/ipfs/*` — the CID-keyed content store (blocks.rs);
//! - `/api/peers/*` — the broadcast server list + announce handshake
//!   (peers.rs) with lazy pull-through sync (sync.rs);
//! - `/api/health` — manifest + capabilities + node (http.rs).
//!
//! Storage is SQLite (store.rs) + in-memory state; configuration is
//! `WOWSP_SERVER_*` env > `wowsp-server.toml` > defaults (config.rs).
//! Every policy decision is relay-core's (lookup/peers/gateway/manifest
//! modules); this crate is transport, storage and configuration only.

pub mod blocks;
pub mod config;
pub mod gateway;
pub mod http;
pub mod lookup;
pub mod peers;
pub mod ratelimit;
pub mod state;
pub mod store;
pub mod sync;

use std::sync::Arc;

use crate::state::AppState;

/// Build the full service router (integration tests reuse this).
pub fn build_router(app: Arc<AppState>) -> axum::Router {
    http::router(app)
}

/// The periodic housekeeping loop: expired blocks/peers/rate windows,
/// channel snapshot sweeps, and (when PUBLIC_URL is set) the
/// self-announce refresh. Runs every 10 minutes.
pub async fn sweep_loop(app: Arc<AppState>) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(600));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let now = app.now();
        app.store.sweep_blocks(now);
        app.store.sweep_peers(now);
        app.store.sweep_snapshots(now);
        app.lookup_rate.sweep(now);
        app.announce_rate.sweep(now);
        // Gateway auth state: minted-never-consumed tickets (120 s TTL)
        // and dead password-rate rows — relay-core's sweep drops them
        // (rows are memory-only natively, the returned keys are the DO
        // storage mirror's and are simply discarded here).
        let _removed = app.auth.lock().unwrap().sweep(state::now_ms()).0;
        // Expired in-memory channel snapshots + empty hubs.
        let ms = state::now_ms();
        app.channels.retain(|_, hub| {
            hub.chan.lock().unwrap().sweep(ms);
            hub.chan.lock().unwrap().sub_count() > 0 || hub.host.lock().unwrap().is_some()
        });
        announce_self(&app).await;
    }
}

/// Best-effort self-announce to peersUpstream (§5.2) when PUBLIC_URL is
/// set: keeps this node's 48 h row fresh on the seed list. Fire and
/// forget — every error is swallowed; the 10-minute cadence stays far
/// under the 10/h/IP announce budget on the receiving side.
async fn announce_self(app: &Arc<AppState>) {
    let Some(url) = app.cfg.public_url.clone() else {
        return;
    };
    let Some(url) = relay_core::peers::valid_public_peer_url(url.trim()) else {
        // Private (http/IP-literal/custom-port) nodes never announce
        // publicly (§5.3) — the relay-core public gate refuses them.
        return;
    };
    let target = app.cfg.resolve_outbound(&format!(
        "{}/api/peers/announce",
        app.cfg.peers_upstream.trim_end_matches('/')
    ));
    let body = serde_json::json!({ "url": url });
    let _ = app
        .plain_http
        .post(target)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
}

/// Graceful-shutdown future: SIGTERM (unix) or SIGINT → resolve.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            },
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

/// Bind the listener and serve until the shutdown signal. Returns the
/// bound address first (tests bind :0 and read it back).
pub async fn serve(app: Arc<AppState>, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    let router = build_router(app);
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}
