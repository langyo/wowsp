//! wowsp-server entry point: load config (env > wowsp-server.toml >
//! defaults), initialize state (SQLite + node id + rate windows), start
//! the housekeeping loop, serve until SIGTERM/SIGINT. All behavior is
//! documented in the crate README; the wire contract is
//! docs/en/designs/cache-mesh.md.

use relay_server::config::Config;
use relay_server::state::AppState;
use relay_server::{serve, sweep_loop};

fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async_main())
}

async fn async_main() -> anyhow::Result<()> {
    let cfg = Config::load();
    let bind = cfg.bind.clone();
    let app = AppState::init(cfg)?;

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let bound = listener.local_addr()?;
    println!(
        "wowsp-server {} listening on http://{bound} (node {})",
        relay_core::GATEWAY_VERSION,
        app.node_id
    );
    println!("data dir: {}", app.cfg.data_dir.display());
    println!(
        "capabilities: gateway, lookup, peers, blocks | sync={} | peersUpstream={}",
        app.cfg.sync, app.cfg.peers_upstream
    );

    let sweeper = tokio::spawn(sweep_loop(app.clone()));
    let serving = serve(app, listener).await;
    sweeper.abort();
    serving
}
