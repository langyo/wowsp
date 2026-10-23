//! The desktop-side pairing server (the LAN HTTP/1.1 listener behind the
//! PIN/token data routes). Split from the former single-file
//! `commands/pairing.rs` — everything here is `#[cfg(desktop)]` via the module
//! declaration in `mod.rs`.

use anyhow::{Result, anyhow, bail};

use std::collections::HashMap;
use std::net::IpAddr;
use std::net::Ipv4Addr;
#[cfg(test)]
use std::net::TcpListener as StdListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, watch};

use super::super::exports::percent_decode;
use super::super::replay;
use crate::paths;
use wowsp_tauri_shared::PairingStatus;

/// Preferred port (cosmetic — the phone's saved entry stays valid across
/// restarts); falls back to an ephemeral one when taken.
const PREFERRED_PORT: u16 = 58041;
/// Header block cap; anything larger is not one of our requests.
const MAX_HEAD: usize = 32 * 1024;
/// `/pair` body cap (the PIN JSON is ~30 bytes).
const MAX_BODY: usize = 8 * 1024;
/// Per-REQUEST deadline (slowloris bound): the head plus any request
/// body must fully arrive within this window. Response streaming is
/// deliberately UNbounded — the gamedata zip and big replay pulls take
/// minutes, and the client already allows itself 3600 s.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Consecutive wrong PINs that trip the /pair lockout.
const PIN_MAX_FAILURES: u32 = 5;
/// How long a tripped /pair lockout lasts (anchored at the failure that
/// tripped it; a correct PIN resets the counter).
const PIN_BLOCK_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);
/// Distinct peer IPs the /pair throttle tracks before evicting the
/// quiet/expired entries (M-2: a flood of spoofed sources must not grow
/// the map without bound).
const THROTTLE_MAX_IPS: usize = 256;
/// Bearer-token lifetime (M-1): a paired session slides its expiry
/// forward on every successful authenticated use; a fresh /pair always
/// mints a NEW token and revokes the previous one.
const TOKEN_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
/// M-1 residual (audit follow-up): the ABSOLUTE lifetime of a paired
/// token. The sliding TTL above keeps an active session alive, but a
/// refresh can never push a token's death past mint + TOKEN_MAX_LIFE —
/// a token stolen from the plaintext LAN dies within a week no matter
/// how diligently the thief keeps using it. Re-pairing mints a fresh one.
const TOKEN_MAX_LIFE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// One live bearer token: when it expires (sliding 24h, capped at
/// mint + [`TOKEN_MAX_LIFE`]) and when it was minted.
#[derive(Clone, Copy)]
struct LiveToken {
    expiry: std::time::Instant,
    minted: std::time::Instant,
}
/// Concurrently served connections (M-3): one semaphore permit per
/// accepted connection, held for its lifetime. Over-cap connections wait
/// on the semaphore (the kernel backlog holds their sockets) instead of
/// multiplying runtime tasks and disk scans.
const MAX_CONNECTIONS: usize = 64;
/// Per-write stall bound (M-3): any single response write that cannot
/// complete within this window (a client that stops reading) drops the
/// connection. The bound is PER WRITE, not per response — a streaming
/// transfer that keeps progressing is never cut.
const WRITE_STALL: std::time::Duration = std::time::Duration::from_secs(30);
/// How long /api/gamedata waits for the background zip build before
/// answering 503 + Retry-After (a request that lands moments before
/// completion still gets served instead of bounced).
const GAMEDATA_BUILD_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// Retry-After (seconds) the 503 carries while the zip is building.
const GAMEDATA_RETRY_AFTER_SECS: u64 = 2;

// ── state ────────────────────────────────────────────────────────────────

#[derive(Default)]
struct ServerState {
    running: bool,
    host: String,
    port: u16,
    pin: String,
    /// The 64-hex random room id for this run (relay v2: minted here,
    /// shared with the gateway bridge and echoed in /pair responses —
    /// never derived from the pin).
    room: String,
    /// The live session's shared state — the settings' forget-devices
    /// entry clears the token map through it without stopping the server.
    shared: Option<std::sync::Arc<Shared>>,
    shutdown: Option<watch::Sender<bool>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

fn status_of(st: &ServerState) -> PairingStatus {
    if st.running {
        // Relay v2: while the built-in gateway has answered with a
        // pairing code, THAT code is what the desktop displays (and the
        // phone types). Offline gateway → the locally-generated LAN PIN
        // + a LAN-only status the UI hints on.
        let code = crate::commands::pairing_relay::current_relay_code();
        let relay_online = code.is_some();
        // Gateway manifest info (provider / viaUpstream / notice) rides
        // the status only while the gateway is actually online.
        let gw = crate::commands::pairing_relay::current_gateway_info();
        PairingStatus {
            running: true,
            host: Some(st.host.clone()),
            port: Some(st.port),
            pin: Some(code.unwrap_or_else(|| st.pin.clone())),
            mode: Some(if relay_online { "relay" } else { "lan-local" }.into()),
            relay_online,
            provider: relay_online.then(|| gw.provider.clone()).flatten(),
            via_upstream: relay_online && gw.via_upstream,
            notice: relay_online.then(|| gw.notice.clone()).flatten(),
        }
    } else {
        PairingStatus {
            running: false,
            host: None,
            port: None,
            pin: None,
            mode: None,
            relay_online: false,
            provider: None,
            via_upstream: false,
            notice: None,
        }
    }
}

fn state() -> &'static Mutex<ServerState> {
    static SERVER: OnceLock<Mutex<ServerState>> = OnceLock::new();
    SERVER.get_or_init(|| Mutex::new(ServerState::default()))
}

/// Server state and its global sidecars change as one lifecycle operation.
/// The relay-config command takes this same gate before restarting a bridge.
pub(crate) fn lifecycle_gate() -> &'static Mutex<()> {
    static GATE: Mutex<()> = Mutex::const_new(());
    &GATE
}

pub fn current_status() -> PairingStatus {
    status_of(&state().blocking_lock())
}

/// Async twin of `current_status` for call sites already inside a tokio
/// worker (async commands): `blocking_lock` panics there on tokio 1.x.
pub async fn current_status_async() -> PairingStatus {
    let st = state().lock().await;
    status_of(&st)
}

/// `(port, room)` while the server is running — the relay host session
/// needs both (the gateway room is the run's random 64-hex id; the
/// bridge dials 127.0.0.1:port for tunnel conns).
pub async fn server_snapshot() -> Option<(u16, String)> {
    let st = state().lock().await;
    st.running.then(|| (st.port, st.room.clone()))
}

/// Everything the connection handlers need; shared via Arc.
struct Shared {
    pin: String,
    /// The LIVE bearer tokens of this server run (M-1): token → record.
    /// A successful `POST /pair` mints a fresh 256-bit token, REVOKES
    /// every previous one (one active pairing session per server run)
    /// and stores the new token with its expiry and mint time; each
    /// authenticated use slides the expiry forward, never past the
    /// token's absolute lifetime. Std mutex: the critical sections are a
    /// lookup plus one Instant write, never held across an await.
    tokens: std::sync::Mutex<HashMap<String, LiveToken>>,
    /// The run's random room id, echoed in the /pair success body so a
    /// relay phone can address its later tunnels without asking the
    /// gateway again (LAN phones ignore it).
    room: String,
    replay_root: PathBuf,
    /// Game-data zip availability for THIS server run: `Building` until
    /// the background build spawned at start finishes, then the final
    /// result (None = no caches on this desktop → the route 404s).
    gamedata: watch::Receiver<GamedataState>,
    /// Keep this run's ready snapshot alive until all handlers retire.
    _gamedata_workspace: Option<Arc<super::GamedataWorkspace>>,
    /// /pair brute-force throttle keyed by PEER IP (M-2 — see
    /// [`PinThrottle`] and the `PairThrottles` map). Std mutex: the
    /// critical sections are two integer writes, never held across an
    /// await. Fresh per server run.
    pin_throttle: std::sync::Mutex<PairThrottles>,
    /// Connection-lifetime permits (M-3): one per served connection.
    conns: Arc<tokio::sync::Semaphore>,
    shutdown: watch::Receiver<bool>,
}

/// One-shot state of the background game-data zip build. The failure text
/// is a plain `String` (not an anyhow error): `GamedataState` must be
/// `Clone` for the watch channel (anyhow errors are not) and it rides the
/// 500 JSON body, which needs a serializable plain string anyway.
#[derive(Clone)]
enum GamedataState {
    Building,
    Ready(Option<PathBuf>),
    Failed(String),
}

/// PIN brute-force throttle for ONE peer IP, dependency-free and pure so
/// the behavior is unit-testable: after [`PIN_MAX_FAILURES`] consecutive
/// wrong PINs the exchange rejects EVERY attempt (correct PIN included —
/// the check runs before the comparison) until a [`PIN_BLOCK_WINDOW`] has
/// passed since the failure that tripped the limit. A correct PIN resets
/// the counter; failures keep accumulating across expired windows, so a
/// persistent guesser settles into one guess per window.
#[derive(Default)]
struct PinThrottle {
    consecutive_failures: u32,
    blocked_until: Option<std::time::Instant>,
}

impl PinThrottle {
    /// `Ok(())`, or the remaining duration of the current lockout.
    fn check(&self, now: std::time::Instant) -> Result<(), std::time::Duration> {
        match self.blocked_until {
            Some(until) if now < until => Err(until - now),
            _ => Ok(()),
        }
    }

    fn record_failure(&mut self, now: std::time::Instant) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= PIN_MAX_FAILURES {
            self.blocked_until = Some(now + PIN_BLOCK_WINDOW);
        }
    }

    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.blocked_until = None;
    }

    /// Whether the entry carries no live state and may be evicted from a
    /// full map (M-2 eviction): nothing blocked, no failures accumulated.
    fn idle(&self, now: std::time::Instant) -> bool {
        self.consecutive_failures == 0 && self.blocked_until.is_none_or(|until| now >= until)
    }
}

/// The /pair throttle state of every peer IP seen this run (M-2: keyed by
/// the TcpStream's `peer_addr()` — a LAN peer cannot lock out the gateway
/// bridge, whose connections all arrive from 127.0.0.1 and get their own
/// entry by construction). Capped at [`THROTTLE_MAX_IPS`] entries with
/// idle-entry eviction.
#[derive(Default)]
struct PairThrottles {
    by_ip: HashMap<IpAddr, PinThrottle>,
}

impl PairThrottles {
    fn check(&self, peer: IpAddr, now: std::time::Instant) -> Result<(), std::time::Duration> {
        self.by_ip
            .get(&peer)
            .map(|t| t.check(now))
            .unwrap_or(Ok(()))
    }

    fn record_failure(&mut self, peer: IpAddr, now: std::time::Instant) {
        if !self.by_ip.contains_key(&peer) && self.by_ip.len() >= THROTTLE_MAX_IPS {
            self.by_ip.retain(|_, t| !t.idle(now));
            // Still full (that many actively-guessing sources) → drop one
            // arbitrary entry; the bound matters more than the bookkeeping.
            if self.by_ip.len() >= THROTTLE_MAX_IPS {
                if let Some(first) = self.by_ip.keys().next().copied() {
                    self.by_ip.remove(&first);
                }
            }
        }
        self.by_ip.entry(peer).or_default().record_failure(now);
    }

    fn record_success(&mut self, peer: IpAddr) {
        if let Some(t) = self.by_ip.get_mut(&peer) {
            t.record_success();
        }
    }

    /// Total live entries (test surface).
    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_ip.len()
    }
}

/// Handle to a fixture server: the minted token plus its shutdown signal.
#[cfg(test)]
pub struct ServerHandle {
    #[allow(dead_code)] // read via Debug/diagnostics in tests
    pub token: String,
    shared: Arc<Shared>,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

#[cfg(test)]
impl ServerHandle {
    /// Signal shutdown and WAIT for the accept loop to exit, so a
    /// restart on the same port cannot race the old listener.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }

    /// Insert a token with an explicit expiry into the live map — tests
    /// drive time by putting an ALREADY-EXPIRED Instant in directly (a
    /// monotonic clock cannot be rewound).
    #[cfg(test)]
    pub fn inject_token(&self, token: &str, expires: std::time::Instant) {
        self.inject_token_minted(token, expires, std::time::Instant::now());
    }

    /// [`inject_token`] plus an explicit MINT time — the absolute-lifetime
    /// cap drives its refusal off this, so tests backdate it directly.
    #[cfg(test)]
    pub fn inject_token_minted(
        &self,
        token: &str,
        expires: std::time::Instant,
        minted: std::time::Instant,
    ) {
        self.shared.tokens.lock().unwrap().insert(
            token.to_string(),
            LiveToken {
                expiry: expires,
                minted,
            },
        );
    }

    /// Run the bearer check at a synthetic clock reading — tests travel
    /// FORWARD (Instant + duration is always representable).
    #[cfg(test)]
    pub fn valid_at(&self, token: &str, now: std::time::Instant) -> bool {
        shared_token_valid_at(&self.shared, token, now)
    }
}

// ── start / stop ────────────────────────────────────────────────────────

async fn prepare_server() -> Result<ServerState> {
    let listener = bind_listener().await?;
    let port = listener
        .local_addr()
        .map_err(|e| anyhow!("pairing port: {e}"))?
        .port();
    let host = lan_ipv4();
    let pin = random_digits(6)?;
    // Relay v2 room identity: a fresh random 64-hex id per run — the
    // gateway binds its allocated pairing code to THIS id; nothing is
    // ever derived from the pin. No token exists until a /pair succeeds
    // (M-1: each pairing mints its own, previous ones are revoked).
    let room = random_token()?;
    let replay_root = replay::resolve_replay_dir(None)?;
    // Game-data zip: rebuilt on every start so the phone never sees a
    // stale cache snapshot (existing semantics), cached for this server
    // run — but built IN THE BACKGROUND so the status (and the settings
    // toggle behind it) returns immediately: a few hundred MB of
    // per-ship JSON deflates on the blocking pool while /api/gamedata
    // answers 503 + Retry-After until the zip lands.
    let (gd_tx, gd_rx) = watch::channel(GamedataState::Building);
    let workspace = Arc::new(super::GamedataWorkspace::create(
        &paths::ensure_cache_dir()?
    )?);
    let build_workspace = workspace.clone();
    tokio::spawn(async move {
        let res = build_gamedata_zip(build_workspace).await;
        match &res {
            Ok(Some(p)) => {
                tracing::info!(zip = %p.display(), "pairing gamedata zip ready");
            },
            Ok(None) => {
                tracing::info!("pairing: no game-data caches, /api/gamedata will 404");
            },
            Err(e) => tracing::warn!(error = %e, "pairing gamedata zip build failed"),
        }
        // GamedataState keeps a plain String (see its docs): the anyhow
        // error crosses through its Display, byte-identical to the wire.
        let _ = gd_tx.send(match res {
            Ok(zip) => GamedataState::Ready(zip),
            Err(e) => GamedataState::Failed(e.to_string()),
        });
    });
    let (tx, rx) = watch::channel(false);
    let shared = Arc::new(Shared {
        pin: pin.clone(),
        tokens: std::sync::Mutex::new(HashMap::new()),
        room: room.clone(),
        replay_root,
        gamedata: gd_rx,
        _gamedata_workspace: Some(workspace),
        pin_throttle: std::sync::Mutex::new(PairThrottles::default()),
        conns: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
        shutdown: rx,
    });
    let task = tokio::spawn(serve(listener, shared.clone()));
    Ok(ServerState {
        running: true,
        host,
        port,
        pin,
        room,
        // Audit M-1 residual: the settings' forget-devices entry clears
        // the live token map through this handle without stopping the
        // server (a stop would also kill discovery and any relay bridge).
        shared: Some(shared),
        shutdown: Some(tx),
        task: Some(task),
    })
}

/// Returns whether a new run started; idempotent calls must not repeat the
/// optional gateway-code wait when an existing run is already available.
async fn start_with<P, S, F>(
    state: &Mutex<ServerState>,
    gate: &Mutex<()>,
    prepare: P,
    start_sidecars: S,
) -> Result<bool>
where
    P: std::future::Future<Output = Result<ServerState>>,
    S: FnOnce(u16, String) -> F,
    F: std::future::Future<Output = ()>,
{
    let _lifecycle = gate.lock().await;
    let mut st = state.lock().await;
    if st.running {
        return Ok(false);
    }
    // Keep publication adjacent to preparation: once it spawns the serve
    // task there is no await at which cancellation could orphan that task.
    *st = prepare.await?;
    let (port, room) = (st.port, st.room.clone());
    drop(st);
    start_sidecars(port, room).await;
    Ok(true)
}

async fn start_sidecars(port: u16, room: String) {
    if let Err(e) = crate::commands::pairing_discovery::broadcast_start(port, None) {
        tracing::warn!(error = %e, "discovery broadcaster failed to start");
    }
    let relay_cfg = crate::commands::pairing_relay::load_relay_config();
    if relay_cfg.enabled {
        let root = crate::commands::pairing_relay::builtin_relay_root();
        if let Err(e) = crate::commands::pairing_relay::host_session_start(&root, port, &room).await
        {
            tracing::warn!(error = %e, "relay host session failed to start");
        }
    } else {
        tracing::info!("internet gateway disabled by config — LAN-only pairing");
    }
}

pub async fn pairing_start() -> Result<PairingStatus> {
    let started = start_with(state(), lifecycle_gate(), prepare_server(), start_sidecars).await?;
    if started && crate::commands::pairing_relay::load_relay_config().enabled {
        // Waiting for a code does not mutate lifecycle state; let stop run
        // while the gateway is offline, and wake this wait when it stops.
        let shutdown = state()
            .lock()
            .await
            .shutdown
            .as_ref()
            .map(|s| s.subscribe());
        // Bounded wait so the status returned to the UI already carries
        // the gateway-allocated code when the gateway answers. A timeout
        // just means LAN-only for now: the bridge keeps retrying in the
        // background and the next status refresh picks the code up.
        if let Some(mut shutdown) = shutdown {
            if !*shutdown.borrow() {
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => {},
                    result = crate::commands::pairing_relay::wait_for_code(std::time::Duration::from_secs(10)) => {
                        if let Err(e) = result {
                            tracing::info!(error = %e, "relay gateway unreachable — LAN-only pairing for now");
                        }
                    },
                }
            }
        }
    }
    let st = state().lock().await;
    tracing::info!(host = %st.host, port = st.port, mode = ?status_of(&st).mode, "pairing server started");
    Ok(status_of(&st))
}

async fn stop_with(
    state: &Mutex<ServerState>,
    gate: &Mutex<()>,
    stop_sidecars: impl std::future::Future<Output = ()>,
) {
    let _lifecycle = gate.lock().await;
    let joined = {
        let mut st = state.lock().await;
        let old = std::mem::take(&mut *st);
        old.shutdown.zip(old.task)
    };
    if let Some((tx, task)) = joined {
        let _ = tx.send(true);
        // Bounded wait: the accept loop only parks on accept/shutdown, so
        // it exits immediately; the bound guards against a pathological
        // in-flight request hanging stop forever.
        super::await_shutdown(task, std::time::Duration::from_secs(5)).await;
    }
    stop_sidecars.await;
}

pub async fn pairing_stop() -> Result<()> {
    stop_with(state(), lifecycle_gate(), async {
        crate::commands::pairing_discovery::broadcast_stop().await;
        crate::commands::pairing_relay::host_session_stop().await;
    })
    .await;
    tracing::info!("pairing server stopped");
    Ok(())
}

/// Settings entry (audit M-1 residual): drop every live bearer token —
/// paired phones must re-pair — WITHOUT stopping the server (a stop would
/// also kill discovery and any relay bridge). No-op when the server is
/// not running (the token map dies with the run anyway).
pub async fn pairing_forget_devices() -> Result<()> {
    let shared = state().lock().await.shared.clone();
    let Some(shared) = shared else {
        return Ok(());
    };
    let dropped = {
        let mut tokens = shared_tokens(&shared);
        let n = tokens.len();
        tokens.clear();
        n
    };
    tracing::info!(dropped, "pairing tokens cleared from the settings entry");
    Ok(())
}

/// Preferred port first, ephemeral fallback.
async fn bind_listener() -> Result<TcpListener> {
    match TcpListener::bind(("0.0.0.0", PREFERRED_PORT)).await {
        Ok(l) => Ok(l),
        Err(_) => TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|e| anyhow!("bind pairing server: {e}")),
    }
}

/// First non-loopback IPv4 via the UDP-connect trick: connecting a UDP
/// socket sends nothing but makes the OS pick the default-route
/// interface; its local address is the LAN IP the phone can reach. The
/// notional peer uses the RFC 5737 documentation block so no real host
/// is ever contacted. Falls back to loopback (pairing a desktop to
/// itself still works then).
fn lan_ipv4() -> String {
    std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .ok()
        .and_then(|s| {
            s.connect("192.0.2.1:80").ok()?;
            s.local_addr().ok()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

/// Random n-digit PIN from OS entropy. `getrandom` is the CSPRNG
/// interface (already in the dependency tree via tempfile/uuid; direct
/// here so the pairing secrets never depend on wall-clock/pid hashing —
/// those are guessable to within nanoseconds by an observer on the same
/// machine). The u64-modulo bias for n=6 is ~5e-14 relative — noise
/// next to the 10^6 keyspace a throttle already guards.
pub(super) fn random_digits(n: usize) -> Result<String> {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("os entropy: {e}"))?;
    let v = u64::from_be_bytes(buf);
    let modulus = 10u64.pow(n as u32);
    Ok(format!("{:0width$}", v % modulus, width = n))
}

/// 256-bit bearer token / room id from OS entropy, hex-encoded (64
/// chars). `pub(crate)`: the relay module's tests mint room ids with it.
pub(crate) fn random_token() -> Result<String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}

/// Build the game-data zip (AppData `gameparams/**` + `encyclopedia/**`)
/// into the cache dir. Returns None when no source dir exists (fresh
/// desktop) — the route then answers 404 and the phone shows a clean
/// "no game data" toast. Runs on the blocking pool; a few hundred MB of
/// per-ship JSON deflate in seconds there without stalling the runtime.
/// Outcome logging lives in the spawn wrapper in [`pairing_start`].
async fn build_gamedata_zip(workspace: Arc<super::GamedataWorkspace>) -> Result<Option<PathBuf>> {
    let data = paths::ensure_data_dir()?;
    let sources = vec![data.join("gameparams"), data.join("encyclopedia")];
    let existing: Vec<PathBuf> = sources.into_iter().filter(|d| d.is_dir()).collect();
    if existing.is_empty() {
        return Ok(None);
    }
    let dest = workspace.archive();
    let out = {
        tokio::task::spawn_blocking(move || write_gamedata_zip(&existing, &workspace.archive()))
            .await
            .map_err(|e| anyhow!("gamedata zip task failed: {e}"))?
    };
    match out {
        Ok(0) => Ok(None), // dirs existed but were empty — same as missing
        Ok(_) => Ok(Some(dest)),
        Err(e) => Err(e),
    }
}

/// Zip every file under `sources` with its dir name as the zip root
/// (`gameparams/…`, `encyclopedia/…`) so extraction merges cleanly into
/// the phone's data dir. Returns the file count.
pub(super) fn write_gamedata_zip(sources: &[PathBuf], dest: &Path) -> Result<usize> {
    let tmp = dest.with_extension("zip.part");
    let file = std::fs::File::create(&tmp).map_err(|e| anyhow!("create {}: {e}", tmp.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0usize;
    for source in sources {
        let root_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if root_name.is_empty() {
            continue;
        }
        let mut stack = vec![source.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for ent in rd.flatten() {
                let path = ent.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Ok(rel) = path.strip_prefix(source) else {
                    continue;
                };
                // Forward-slash zip name (zip spec) under the source
                // dir's name — matches the extractor's merge layout.
                let name = format!("{root_name}/{}", rel.to_string_lossy().replace('\\', "/"));
                zip.start_file(name.as_str(), opts)
                    .map_err(|e| anyhow!("zip add {name}: {e}"))?;
                let mut f = std::fs::File::open(&path).map_err(|e| anyhow!("open: {e}"))?;
                std::io::copy(&mut f, &mut zip).map_err(|e| anyhow!("zip write: {e}"))?;
                count += 1;
            }
        }
    }
    zip.finish()
        .map_err(|e| anyhow!("finalize gamedata zip: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| anyhow!("finalize {}: {e}", dest.display()))?;
    Ok(count)
}

// ── HTTP core ────────────────────────────────────────────────────────────

/// Test surface: start serving on an ALREADY-BOUND listener with explicit
/// replay root / gamedata zip / room id (the command path derives all of
/// those from the app dirs). Must be called inside a tokio runtime.
#[cfg(test)]
pub async fn spawn_on(
    listener: StdListener,
    replay_root: PathBuf,
    gamedata_zip: Option<PathBuf>,
    pin: &str,
    room: &str,
) -> Result<ServerHandle> {
    // Adopting a std listener into tokio REQUIRES non-blocking mode —
    // a blocking socket makes accept() park the runtime thread
    // synchronously (on a current-thread test runtime that deadlocks
    // everything; on the multi-thread app runtime it stalls a worker).
    listener
        .set_nonblocking(true)
        .map_err(|e| anyhow!("listener nonblocking: {e}"))?;
    let listener = TcpListener::from_std(listener).map_err(|e| anyhow!("adopt listener: {e}"))?;
    let token = random_token()?;
    // The test surface serves an ALREADY-BUILT zip (or none at all) —
    // the Building/503 path belongs to the command start, which spawns
    // the real background build.
    let (gd_tx, gd_rx) = watch::channel(GamedataState::Ready(gamedata_zip));
    drop(gd_tx); // state is terminal; nothing more to signal
    let (tx, rx) = watch::channel(false);
    let shared = Arc::new(Shared {
        pin: pin.to_string(),
        // The fixture's minted token starts ACTIVE (tests authenticate
        // with it directly); production runs start with an empty map —
        // only a successful /pair mints a token.
        tokens: std::sync::Mutex::new(HashMap::from([(
            token.clone(),
            LiveToken {
                expiry: std::time::Instant::now() + TOKEN_TTL,
                minted: std::time::Instant::now(),
            },
        )])),
        room: room.to_string(),
        replay_root,
        gamedata: gd_rx,
        _gamedata_workspace: None,
        pin_throttle: std::sync::Mutex::new(PairThrottles::default()),
        conns: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
        shutdown: rx,
    });
    let task = tokio::spawn(serve(listener, shared.clone()));
    Ok(ServerHandle {
        token,
        shared,
        shutdown: tx,
        task,
    })
}

async fn serve(listener: TcpListener, shared: Arc<Shared>) {
    tracing::info!(addr = ?listener.local_addr(), "pairing server listening");
    let mut shutdown = shared.shutdown.clone();
    let mut connections = tokio::task::JoinSet::new();
    loop {
        if *shutdown.borrow() {
            break;
        }
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            _ = connections.join_next(), if !connections.is_empty() => continue,
            res = listener.accept() => res,
        };
        let (stream, peer) = match accepted {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!(error = %e, "pairing accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            },
        };
        let shared = shared.clone();
        connections.spawn(async move {
            // M-3: one permit per SERVED connection, held for its whole
            // lifetime and released on drop. When all [`MAX_CONNECTIONS`]
            // are busy, further connections park here (their sockets sit
            // in the kernel backlog) instead of multiplying runtime
            // tasks; `connections.shutdown()` on stop aborts the parked
            // tasks and frees every permit.
            let permit = shared.conns.clone().acquire_owned().await;
            // NO timeout wrapper: handle_conn bounds only the request
            // reading internally, and each response WRITE individually
            // (see write_stall) — the response may stream for minutes.
            if let Err(e) = handle_conn(stream, &shared).await {
                tracing::warn!(%peer, error = %e, "pairing connection dropped");
            }
            drop(permit);
        });
    }
    // Closing the listener alone leaves accepted sockets authorized with
    // the old PIN/token. Stop owns and joins every request/response task.
    connections.shutdown().await;
    tracing::info!("pairing server accept loop exited");
}

/// One parsed request (head + lowercase header list). The body is read
/// separately by the only route that has one. `pub(super)` fields so the
/// parse unit test (pairing::tests) can assert on them.
pub(super) struct Request {
    pub(super) method: String,
    /// Percent-decoded path (any `?query` split off and discarded —
    /// M-1 removed the last query consumer, the `?token=` auth leg).
    pub(super) path: String,
    /// Lowercased header name → value.
    pub(super) headers: Vec<(String, String)>,
    pub(super) content_length: usize,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        let lower = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == lower)
            .map(|(_, v)| v.as_str())
    }

    /// `Authorization: Bearer <token>` (case-insensitive scheme).
    pub(super) fn bearer_token(&self) -> Option<&str> {
        self.header("authorization").and_then(|v| {
            let v = v.trim();
            let rest = v
                .strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))?;
            Some(rest.trim())
        })
    }
}

/// Read + parse one whole request — head AND body — bounded by
/// `deadline` (slowloris protection: a client trickling either one gets
/// cut). Only the response that follows is allowed to run unbounded.
/// Returns the parsed request plus the fully-read body (empty for
/// bodyless routes; an over-cap /pair body is left unread so the
/// handler can answer 413 without ever receiving it). reqwest sends
/// the tiny `/pair` JSON body glued to the head in the same TCP
/// segment, so bytes buffered after the head MUST be consumed as body
/// before the socket is touched again. `pub(super)` so the deadline
/// behavior is unit-testable with a short window.
pub(super) async fn read_request(
    stream: &mut TcpStream,
    deadline: std::time::Duration,
) -> Result<(Request, Vec<u8>)> {
    tokio::time::timeout(deadline, read_request_inner(stream))
        .await
        .map_err(|_| anyhow!("request not fully received within {deadline:?}"))?
}

async fn read_request_inner(stream: &mut TcpStream) -> Result<(Request, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(512);
    let mut chunk = [0u8; 4096];
    let (req, mut leftover) = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let req = parse_head(&buf[..pos])?;
            let leftover = buf.split_off(pos + 4);
            break (req, leftover);
        }
        if buf.len() > MAX_HEAD {
            bail!("request head too large");
        }
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| anyhow!("read request: {e}"))?;
        if n == 0 {
            bail!("connection closed mid-request");
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    // /pair is the only route with a body, and only a within-cap one is
    // worth reading — the handler 413s the rest without consuming it.
    let mut body: Vec<u8> = Vec::new();
    if req.method == "POST" && req.path == "/pair" && req.content_length <= MAX_BODY {
        let buffered = leftover.len().min(req.content_length);
        body.extend_from_slice(&leftover[..buffered]);
        leftover.drain(..buffered);
        if body.len() < req.content_length {
            let mut rest = vec![0u8; req.content_length - body.len()];
            stream
                .read_exact(&mut rest)
                .await
                .map_err(|e| anyhow!("read pair body: {e}"))?;
            body.extend_from_slice(&rest);
        }
    }
    // Anything else glued after the head is pipelined junk on a
    // Connection: close protocol — dropped.
    Ok((req, body))
}

/// Parse the head block (everything before CRLFCRLF) into a [`Request`].
pub(super) fn parse_head(head: &[u8]) -> Result<Request> {
    let text = std::str::from_utf8(head).map_err(|_| anyhow!("non-UTF-8 request"))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or_else(|| anyhow!("empty request"))?;
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts
        .next()
        .ok_or_else(|| anyhow!("missing request target"))?;
    if method.is_empty() || parts.next().is_none() {
        bail!("malformed request line");
    }
    // Split the query off the target (discarded — nothing consumes a
    // query string anymore), percent-decode the path.
    let (raw_path, _raw_query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    let path = percent_decode(raw_path)?;
    let mut headers = Vec::new();
    let mut content_length = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        let value = v.trim().to_string();
        if key == "content-length" {
            content_length = value.parse().map_err(|_| anyhow!("bad content-length"))?;
        }
        headers.push((key, value));
    }
    Ok(Request {
        method,
        path,
        headers,
        content_length,
    })
}

/// Constant-time-ish equality (LAN toy, but habits are free): length
/// first, then every byte compared with accumulated XOR.
pub(super) fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Serve one connection: read, route, respond, close. The REQUEST phase
/// (head + body) is deadline-bounded inside [`read_request`] —
/// slowloris protection; each response WRITE is stall-bounded (see
/// [`write_stall`]) while the response as a whole stays unbounded so
/// multi-hundred-MB streams are never cut mid-transfer. Routes are
/// resolved BEFORE the auth check so unknown paths 404 regardless of
/// token state (the route set is public knowledge; hiding it behind a
/// 401 buys nothing on a LAN toy and muddies client error mapping).
async fn handle_conn(mut stream: TcpStream, shared: &Shared) -> Result<()> {
    let (req, body) = read_request(&mut stream, REQUEST_TIMEOUT).await?;

    // M-4a: a request carrying `Origin` comes from a browser (the only
    // clients of this protocol are native — the phone app, the desktop,
    // the relay bridge — and never send one). Rejecting it up front
    // blinds DNS-rebinding pages and drive-by POSTs regardless of what
    // else the request carries.
    if req.header("origin").is_some() {
        return respond_json(
            &mut stream,
            403,
            "Forbidden",
            &serde_json::json!({ "error": "browser clients are not supported" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    // M-4c: Host hygiene — only this machine may be addressed.
    if !host_header_allowed(&req) {
        return respond_json(
            &mut stream,
            403,
            "Forbidden",
            &serde_json::json!({ "error": "unexpected host" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }

    let authed = req
        .bearer_token()
        .is_some_and(|t| shared_token_valid(shared, t));

    let method = req.method.clone();
    let path = req.path.clone();

    if method == "POST" && path == "/pair" {
        let peer = stream
            .peer_addr()
            .map(|a| a.ip())
            .unwrap_or_else(|_| Ipv4Addr::UNSPECIFIED.into());
        return handle_pair(&mut stream, shared, &req, peer, body).await;
    }
    if method == "GET" && path == "/api/ping" {
        return respond_json(&mut stream, 200, "OK", &serde_json::json!({ "ok": true }))
            .await
            .map_err(anyhow::Error::from);
    }

    let replay_name = if method == "GET" && path.starts_with("/api/replay/") {
        Some(path.strip_prefix("/api/replay/").unwrap_or("").to_string())
    } else {
        None
    };
    let known = (method == "GET" && path == "/api/replays")
        || replay_name.is_some()
        || (method == "GET" && path == "/api/gamedata");
    if !known {
        return respond_json(
            &mut stream,
            404,
            "Not Found",
            &serde_json::json!({ "error": "not found" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    if !authed {
        return respond_json(
            &mut stream,
            401,
            "Unauthorized",
            &serde_json::json!({ "error": "invalid or expired token" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    if method == "GET" && path == "/api/replays" {
        return handle_replays(&mut stream, shared).await;
    }
    if let Some(name) = replay_name {
        return handle_replay_file(&mut stream, shared, &name).await;
    }
    handle_gamedata(&mut stream, shared).await
}

async fn handle_pair(
    stream: &mut TcpStream,
    shared: &Shared,
    req: &Request,
    peer: IpAddr,
    body: Vec<u8>,
) -> Result<()> {
    if req.content_length > MAX_BODY {
        return respond_json(
            stream,
            413,
            "Payload Too Large",
            &serde_json::json!({ "error": "pair body too large" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    // M-4b: the JSON body must declare itself. A cross-site form or
    // `fetch` POST cannot send `application/json` without a CORS
    // preflight (already dead — see the Origin rejection), so this is
    // one more cheap gate a browser cannot pass.
    let json_body = req
        .header("content-type")
        .and_then(|v| v.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"));
    if !json_body {
        return respond_json(
            stream,
            415,
            "Unsupported Media Type",
            &serde_json::json!({ "error": "pair body must be application/json" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    let pin = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("pin").and_then(|p| p.as_str()).map(str::to_string))
        .unwrap_or_default();
    // Throttle BEFORE the comparison: within a tripped window even the
    // CORRECT PIN is rejected — otherwise the lockout would leak when
    // the guessing stops. The guard is dropped at the end of this
    // statement (std mutexes must never ride an await). Keyed by the
    // connection's peer IP (M-2): one noisy host cannot lock out the
    // others, and the gateway tunnel's connections (all from
    // 127.0.0.1) own their entry.
    let blocked_for = shared_throttle(shared)
        .check(peer, std::time::Instant::now())
        .err();
    if let Some(remaining) = blocked_for {
        let retry_after = remaining.as_secs().max(1);
        tracing::warn!(retry_after_secs = retry_after, "pairing: PIN lockout hit");
        return respond_json_extra(
            stream,
            429,
            "Too Many Requests",
            &[("Retry-After", retry_after.to_string())],
            &serde_json::json!({ "error": "too many PIN attempts" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    // Relay v2: the gateway-allocated pairing code is an accepted secret
    // alongside the local PIN — a same-network phone types whatever the
    // desktop displays (the code while the gateway is online), and the
    // tunnel phone always types the code. M-5a: only its documented
    // SHAPE (6 ASCII digits) is a secret — a malformed gateway answer
    // never becomes a PIN candidate.
    let relay_code = crate::commands::pairing_relay::current_relay_code()
        .filter(|code| crate::commands::pairing_relay::valid_pairing_code(code));
    let pin_ok =
        token_eq(&pin, &shared.pin) || relay_code.is_some_and(|code| token_eq(&pin, &code));
    if !pin_ok {
        shared_throttle(shared).record_failure(peer, std::time::Instant::now());
        tracing::warn!("pairing: rejected PIN attempt");
        return respond_json(
            stream,
            403,
            "Forbidden",
            &serde_json::json!({ "error": "invalid PIN" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    shared_throttle(shared).record_success(peer);
    // M-1: one active pairing session per server run — mint a NEW
    // token and revoke every previous one, so a re-pair (or a second
    // phone) invalidates whatever was handed out before.
    let token = random_token()?;
    {
        let mut tokens = shared_tokens(shared);
        tokens.clear();
        let now = std::time::Instant::now();
        tokens.insert(
            token.clone(),
            LiveToken {
                expiry: now + TOKEN_TTL,
                minted: now,
            },
        );
    }
    // The room id rides along: relay phones address their later tunnels
    // by it (LAN phones ignore it).
    respond_json(
        stream,
        200,
        "OK",
        &serde_json::json!({ "token": token, "room": shared.room }),
    )
    .await
    .map_err(anyhow::Error::from)
}

/// Lock the per-IP PIN throttle, treating a poisoned lock as recoverable
/// (the guarded state is small integers per IP; a panicked writer loses
/// nothing but the last update).
fn shared_throttle(shared: &Shared) -> std::sync::MutexGuard<'_, PairThrottles> {
    shared
        .pin_throttle
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Lock the live-token map (poisoning treated like [`shared_throttle`]).
fn shared_tokens(shared: &Shared) -> std::sync::MutexGuard<'_, HashMap<String, LiveToken>> {
    shared.tokens.lock().unwrap_or_else(|p| p.into_inner())
}

/// M-1 auth: the presented bearer must match a LIVE token — an entry
/// that exists and is not expired; a hit slides its expiry forward
/// (an active session never expires mid-transfer) but never past the
/// token's absolute lifetime (mint + [`TOKEN_MAX_LIFE`]) — an actively
/// used stolen token still dies within the week. A miss or an
/// absolute-expired entry is dropped on sight. The lookup compares every
/// live entry through [`token_eq`], so the token bytes never leak through
/// an early-exit timing side channel (the map holds at most a handful of
/// entries — one, after a revoke).
fn shared_token_valid(shared: &Shared, candidate: &str) -> bool {
    shared_token_valid_at(shared, candidate, std::time::Instant::now())
}

/// [`shared_token_valid`] with the clock injected — tests travel
/// FORWARD (a monotonic Instant plus a duration is always representable,
/// unlike backdating).
fn shared_token_valid_at(shared: &Shared, candidate: &str, now: std::time::Instant) -> bool {
    let mut tokens = shared_tokens(shared);
    let hit = tokens.keys().find(|t| token_eq(t, candidate)).cloned();
    match hit {
        Some(t) => {
            let live = tokens.get(&t).is_some_and(|tok| now < tok.expiry);
            if live {
                // Slide, capped: once mint + MAX_LIFE passes, the capped
                // expiry stops moving forward and the existing check
                // refuses — no separate absolute-life branch needed.
                let minted = tokens.get(&t).expect("hit checked above").minted;
                tokens.insert(
                    t,
                    LiveToken {
                        expiry: (now + TOKEN_TTL).min(minted + TOKEN_MAX_LIFE),
                        minted,
                    },
                );
            } else {
                tokens.remove(&t);
            }
            live
        },
        None => false,
    }
}

/// M-4c: the Host header, WHEN a client sends one, must name THIS
/// machine — an IP literal (v4 or v6, optional :port) or `localhost`.
/// Any other hostname is DNS-rebinding bait (an attacker domain
/// resolving 127.0.0.1 and driving a browser at the pairing port).
/// Absent Host is fine (HTTP/1.0 clients). A DUPLICATED Host header is
/// rejected too (request-smuggling bait).
fn host_header_allowed(req: &Request) -> bool {
    let mut hosts = req.headers.iter().filter(|(k, _)| k == "host");
    let Some((_, first)) = hosts.next() else {
        return true;
    };
    if hosts.next().is_some() {
        return false;
    }
    host_value_allowed(first)
}

/// The single-value form of [`host_header_allowed`] (unit-testable).
fn host_value_allowed(value: &str) -> bool {
    let h = value.trim();
    let bare = if let Some(rest) = h.strip_prefix('[') {
        // Bracketed IPv6: `[::1]` or `[::1]:58041`.
        match rest.split_once(']') {
            Some((v6, tail)) if tail.is_empty() || tail.starts_with(':') => v6,
            _ => return false,
        }
    } else {
        // Host or v4 with an optional :port. Anything with a colon that
        // is not `host:digits` stays whole and fails the parse below —
        // unbracketed IPv6 (e.g. `::1`, `::1:8080`) is refused; Host
        // requires brackets for IPv6 literals.
        match h.rsplit_once(':') {
            Some((host, port))
                if !host.is_empty()
                    && !port.is_empty()
                    && port.bytes().all(|b| b.is_ascii_digit()) =>
            {
                host
            },
            _ => h,
        }
    };
    bare.parse::<std::net::IpAddr>().is_ok() || bare.eq_ignore_ascii_case("localhost")
}

/// Root-relative remote name (forward slashes) for one enumerated path.
fn remote_name(root: &Path, path: &str) -> String {
    Path::new(path)
        .strip_prefix(root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| {
            Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string())
        })
}

/// `scan_replays_meta` (through the pairing cache — audit L-11: a
/// token-holding client can poll the listing arbitrarily often, so
/// repeated calls answer from the short-TTL in-memory copy instead of
/// re-walking the whole tree) on the blocking pool — even with
/// `lite_from_path` reading only the bounded first block, an unbounded
/// full-tree listing (every archived version subfolder included) is real
/// disk work that must never stall async runtime workers (the async
/// `list_replays_meta` command wraps the same scan in its own
/// `spawn_blocking`; the hand-rolled server has to do it itself).
async fn scan_remote(
    replay_root: PathBuf,
) -> Result<(PathBuf, Vec<wowsp_tauri_shared::ReplayMetaLite>)> {
    let dir = replay_root.to_string_lossy().into_owned();
    let entries =
        tokio::task::spawn_blocking(move || replay::scan_replays_meta_cached(Some(dir), None))
            .await
            .map_err(|e| anyhow!("replay scan task failed: {e}"))??;
    Ok((replay_root, entries))
}

async fn handle_replays(stream: &mut TcpStream, shared: &Shared) -> Result<()> {
    let (root, entries) = scan_remote(shared.replay_root.clone()).await?;
    let projected: Vec<serde_json::Value> = entries
        .iter()
        .map(|e| {
            let mut v = serde_json::to_value(e).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "path".into(),
                    serde_json::Value::String(remote_name(&root, &e.path)),
                );
            }
            v
        })
        .collect();
    respond_json(stream, 200, "OK", &serde_json::Value::Array(projected))
        .await
        .map_err(anyhow::Error::from)
}

/// Serve one replay file. `name` must match an entry of the CURRENT
/// enumeration (root-relative, forward slashes) — the route never touches
/// the filesystem by user-supplied spelling, so traversal cannot reach
/// anything the listing itself doesn't already show. Belt-and-braces the
/// obvious junk anyway.
async fn handle_replay_file(stream: &mut TcpStream, shared: &Shared, name: &str) -> Result<()> {
    if name.is_empty()
        || name.contains("..")
        || name.contains('\\')
        || name.starts_with('/')
        || name.contains(':')
    {
        return respond_json(
            stream,
            404,
            "Not Found",
            &serde_json::json!({ "error": "replay not found" }),
        )
        .await
        .map_err(anyhow::Error::from);
    }
    let (root, entries) = scan_remote(shared.replay_root.clone()).await?;
    let Some(entry) = entries
        .iter()
        .find(|e| remote_name(&root, &e.path) == name)
        .map(|e| PathBuf::from(&e.path))
    else {
        return respond_json(
            stream,
            404,
            "Not Found",
            &serde_json::json!({ "error": "replay not found" }),
        )
        .await
        .map_err(anyhow::Error::from);
    };
    serve_file(stream, &entry, "application/octet-stream").await
}

/// Serve the game-data zip. The zip is built in the background when the
/// server starts; a request that lands while it is still building waits
/// a bounded [`GAMEDATA_BUILD_WAIT`] for completion (a near-miss gets
/// served instead of bounced) and then answers 503 + Retry-After so the
/// phone can nap and come back.
async fn handle_gamedata(stream: &mut TcpStream, shared: &Shared) -> Result<()> {
    handle_gamedata_with_wait(stream, shared, GAMEDATA_BUILD_WAIT).await
}

/// The route above with the wait bound injectable for tests.
async fn handle_gamedata_with_wait(
    stream: &mut TcpStream,
    shared: &Shared,
    wait: std::time::Duration,
) -> Result<()> {
    let mut rx = shared.gamedata.clone();
    let current = rx.borrow().clone();
    let state = match current {
        GamedataState::Building => {
            match tokio::time::timeout(wait, rx.changed()).await {
                // Build finished inside the bound — serve the outcome.
                Ok(Ok(())) => rx.borrow().clone(),
                // Build task died without reporting — surface as 500.
                Ok(Err(_)) => GamedataState::Failed("game-data build task died".to_string()),
                // Still building after the bound — tell the phone to nap.
                Err(_) => GamedataState::Building,
            }
        },
        ready => ready,
    };
    match state {
        GamedataState::Building => respond_json_extra(
            stream,
            503,
            "Service Unavailable",
            &[("Retry-After", GAMEDATA_RETRY_AFTER_SECS.to_string())],
            &serde_json::json!({ "error": "game data zip is still being prepared" }),
        )
        .await
        .map_err(anyhow::Error::from),
        GamedataState::Failed(e) => respond_json(
            stream,
            500,
            "Internal Server Error",
            &serde_json::json!({ "error": e }),
        )
        .await
        .map_err(anyhow::Error::from),
        GamedataState::Ready(None) => respond_json(
            stream,
            404,
            "Not Found",
            &serde_json::json!({ "error": "no game data available" }),
        )
        .await
        .map_err(anyhow::Error::from),
        GamedataState::Ready(Some(zip)) if zip.is_file() => {
            serve_file(stream, &zip, "application/zip").await
        },
        // Zip vanished under us (cache wiped mid-run) — same clean 404.
        GamedataState::Ready(Some(_)) => respond_json(
            stream,
            404,
            "Not Found",
            &serde_json::json!({ "error": "no game data available" }),
        )
        .await
        .map_err(anyhow::Error::from),
    }
}

/// One response WRITE, bounded by [`WRITE_STALL`] (M-3): a client that
/// stops reading for the window gets its connection dropped instead of
/// pinning the handler forever. The bound is PER WRITE, never per
/// response — a streaming transfer that keeps progressing is never cut.
async fn write_stall(
    fut: impl std::future::Future<Output = std::io::Result<()>>,
) -> std::io::Result<()> {
    match tokio::time::timeout(WRITE_STALL, fut).await {
        Ok(r) => r,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "response write stalled",
        )),
    }
}

/// Stream a file with Content-Length + Connection: close. Every chunk
/// write is individually stall-bounded (M-3): a reader that stalls is
/// dropped at the [`WRITE_STALL`] mark, a progressing one streams for
/// minutes untouched.
async fn serve_file(stream: &mut TcpStream, path: &Path, content_type: &str) -> Result<()> {
    // Audit L-11: File::open (and the length stat beside it) follow
    // symlinks and reparse points — a planted link inside the replay tree
    // would redirect a served file outside it. symlink_metadata reads the
    // link itself; on Windows the reparse attribute additionally catches
    // junctions and mount points that do not report as symlinks.
    let meta =
        std::fs::symlink_metadata(path).map_err(|e| anyhow!("stat {}: {e}", path.display()))?;
    let linked = meta.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || meta.file_attributes() & 0x400 != 0
    };
    if linked {
        // Answer 403 instead of dropping the connection: the phone's UI
        // can show a refusal it understands (review nit, 2026-10-23).
        respond_json(
            stream,
            403,
            "Forbidden",
            &serde_json::json!({ "error": "linked path refused" }),
        )
        .await?;
        return Ok(());
    }
    let len = meta.len();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
    );
    write_stall(stream.write_all(head.as_bytes()))
        .await
        .map_err(|e| anyhow!("write head: {e}"))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| anyhow!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        write_stall(stream.write_all(&buf[..n]))
            .await
            .map_err(|e| anyhow!("stream {}: {e}", path.display()))?;
    }
    write_stall(stream.flush())
        .await
        .map_err(|e| anyhow!("flush: {e}"))?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn respond_json(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &serde_json::Value,
) -> std::io::Result<()> {
    respond_json_extra(stream, status, reason, &[], body).await
}

/// `respond_json` plus extra response headers (used for Retry-After on
/// the 429/503 answers).
async fn respond_json_extra(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra: &[(&str, String)],
    body: &serde_json::Value,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        bytes.len()
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    write_stall(stream.write_all(head.as_bytes())).await?;
    write_stall(stream.write_all(&bytes)).await?;
    write_stall(stream.flush()).await
}

// ── server-internal unit tests (visible only in here, where the
// private state lives) ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Connected localhost TCP pair: (server side, client side).
    async fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        (server, client)
    }

    fn test_shared(gamedata: watch::Receiver<GamedataState>) -> Arc<Shared> {
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        Arc::new(Shared {
            pin: "123456".to_string(),
            tokens: std::sync::Mutex::new(HashMap::new()),
            room: "a".repeat(64),
            replay_root: std::env::temp_dir(),
            gamedata,
            _gamedata_workspace: None,
            pin_throttle: std::sync::Mutex::new(PairThrottles::default()),
            conns: Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS)),
            shutdown: shutdown_rx,
        })
    }

    fn fixture_state(port: u16) -> ServerState {
        ServerState {
            running: true,
            host: "127.0.0.1".into(),
            port,
            pin: "123456".into(),
            room: "a".repeat(64),
            ..ServerState::default()
        }
    }

    #[tokio::test]
    async fn repeated_start_keeps_the_existing_run_without_restarting_sidecars() {
        let state = Mutex::new(fixture_state(1));
        let gate = Mutex::new(());
        let started = start_with(
            &state,
            &gate,
            async { panic!("a running server must not be prepared again") },
            |_, _| async { panic!("a running sidecar must not restart") },
        )
        .await
        .unwrap();
        assert!(!started, "an idempotent start skips the first-code wait");
        assert_eq!(state.lock().await.port, 1);
    }

    #[tokio::test]
    async fn stop_waits_for_pending_sidecar_start_before_retiring_the_run() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let state = Mutex::new(ServerState::default());
        let gate = Mutex::new(());
        let sidecar = AtomicBool::new(false);
        let (release, ready) = tokio::sync::oneshot::channel();
        let start = start_with(
            &state,
            &gate,
            async { Ok(fixture_state(1)) },
            |_, _| async {
                ready.await.unwrap();
                sidecar.store(true, Ordering::SeqCst);
            },
        );
        tokio::pin!(start);
        // The real start core has published the server, but its gateway
        // setup is still awaiting an external result.
        assert!(futures::poll!(&mut start).is_pending());
        assert!(state.lock().await.running);
        let stop = stop_with(&state, &gate, async {
            sidecar.store(false, Ordering::SeqCst);
        });
        tokio::pin!(stop);
        assert!(
            futures::poll!(&mut stop).is_pending(),
            "stop must not pass pending setup"
        );
        release.send(()).unwrap();
        start.await.unwrap();
        stop.await;
        assert!(!state.lock().await.running);
        assert!(!sidecar.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn restart_waits_until_old_stop_has_retired_all_sidecars() {
        use std::sync::atomic::{AtomicU16, Ordering};
        let gate = Mutex::new(());
        let sidecar_port = AtomicU16::new(1);
        let (release, retired) = tokio::sync::oneshot::channel();
        let (shutdown, _receiver) = watch::channel(false);
        let mut old = fixture_state(1);
        old.shutdown = Some(shutdown);
        old.task = Some(tokio::spawn(async {
            retired.await.unwrap();
        }));
        let state = Mutex::new(old);
        let stop = stop_with(&state, &gate, async {
            sidecar_port.store(0, Ordering::SeqCst);
        });
        tokio::pin!(stop);
        assert!(futures::poll!(&mut stop).is_pending());
        assert!(!state.lock().await.running);
        let start = start_with(&state, &gate, async { Ok(fixture_state(2)) }, |port, _| {
            let sidecar_port = &sidecar_port;
            async move {
                sidecar_port.store(port, Ordering::SeqCst);
            }
        });
        tokio::pin!(start);
        assert!(
            futures::poll!(&mut start).is_pending(),
            "restart must not overtake cleanup"
        );
        release.send(()).unwrap();
        stop.await;
        start.await.unwrap();
        assert_eq!(state.lock().await.port, 2);
        assert_eq!(sidecar_port.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn stop_budget_aborts_and_joins_a_stalled_session() {
        let owner = Arc::new(());
        let worker_owner = owner.clone();
        let (release, stalled) = tokio::sync::oneshot::channel::<()>();
        let (started, running) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _owner = worker_owner;
            started.send(()).unwrap();
            let _ = stalled.await;
        });
        running.await.unwrap();
        super::super::await_shutdown(task, std::time::Duration::from_millis(10)).await;
        assert_eq!(
            Arc::strong_count(&owner),
            1,
            "stop must not detach the old worker"
        );
        assert!(
            release.send(()).is_err(),
            "cancelled session must be gone before stop returns"
        );
    }

    #[test]
    fn pin_throttle_locks_after_burst_and_resets_on_success() {
        let mut throttle = PinThrottle::default();
        let t0 = std::time::Instant::now();
        assert!(throttle.check(t0).is_ok());
        for i in 1..=4 {
            throttle.record_failure(t0);
            assert!(throttle.check(t0).is_ok(), "{i} failures must not lock yet");
        }
        // Fifth failure trips the window — check fails even at the same
        // instant, and the lockout is bounded by the window length.
        throttle.record_failure(t0);
        let remaining = throttle.check(t0).unwrap_err();
        assert!(!remaining.is_zero());
        assert!(remaining <= PIN_BLOCK_WINDOW);
        // Window expired → open again…
        let later = t0 + PIN_BLOCK_WINDOW + std::time::Duration::from_secs(1);
        assert!(throttle.check(later).is_ok());
        // …but failures accumulate across windows: ONE more re-trips.
        throttle.record_failure(later);
        assert!(throttle.check(later).is_err());
        // A correct PIN clears everything.
        throttle.record_success();
        assert!(throttle.check(std::time::Instant::now()).is_ok());
    }

    /// M-2: the throttle is keyed by peer IP — one IP burning its five
    /// failures locks ONLY itself; the others (including the loopback
    /// entry the gateway tunnel owns) stay open.
    #[test]
    fn pin_throttles_are_isolated_per_ip() {
        let mut throttles = PairThrottles::default();
        let t0 = std::time::Instant::now();
        let lan = IpAddr::from([192, 0, 2, 10]);
        let other = IpAddr::from([203, 0, 113, 7]);
        let tunnel = IpAddr::from([127, 0, 0, 1]);
        for _ in 0..PIN_MAX_FAILURES {
            throttles.record_failure(lan, t0);
        }
        assert!(throttles.check(lan, t0).is_err(), "the offender is locked");
        assert!(throttles.check(other, t0).is_ok(), "a second IP stays open");
        assert!(
            throttles.check(tunnel, t0).is_ok(),
            "the tunnel's loopback entry stays open"
        );
        // A success from the second IP records on ITS entry only.
        throttles.record_success(other);
        assert!(throttles.check(lan, t0).is_err());
        // The loopback entry can lock on its own without touching the
        // LAN one.
        let later = t0 + std::time::Duration::from_secs(11);
        for _ in 0..PIN_MAX_FAILURES {
            throttles.record_failure(tunnel, later);
        }
        assert!(
            throttles.check(tunnel, later).is_err(),
            "the tunnel entry locked independently"
        );
        // lan's own 10 s lockout has expired by now, but its accumulated
        // failures persist — one more re-trips ONLY lan.
        assert!(throttles.check(lan, later).is_ok());
        throttles.record_failure(lan, later);
        assert!(throttles.check(lan, later).is_err());
        assert!(
            throttles.check(other, later).is_ok(),
            "the second IP was never touched"
        );
    }

    /// M-2: the per-IP map is capped — quiet/expired entries are evicted
    /// before a fresh IP is admitted, and even a flood of actively
    /// guessing sources cannot grow it past the bound.
    #[test]
    fn throttle_map_is_capped_and_evicts_idle_entries() {
        let mut throttles = PairThrottles::default();
        let t0 = std::time::Instant::now();
        for i in 0..THROTTLE_MAX_IPS {
            let ip = IpAddr::from([192, 0, 2, i as u8]);
            throttles.record_failure(ip, t0); // 1 failure each = not idle
        }
        assert_eq!(throttles.len(), THROTTLE_MAX_IPS);
        // One more failure from a FRESH IP: everything is non-idle, so a
        // victim is dropped — the map still holds the line.
        let fresh = IpAddr::from([203, 0, 113, 99]);
        throttles.record_failure(fresh, t0);
        assert!(
            throttles.len() <= THROTTLE_MAX_IPS,
            "map must stay capped: {}",
            throttles.len()
        );
        assert!(
            throttles.check(fresh, t0).is_ok(),
            "the fresh IP was admitted"
        );
        // Entries whose failures expired to an unlocked state are idle
        // again and get evicted first.
        let mut throttles = PairThrottles::default();
        for i in 0..THROTTLE_MAX_IPS {
            let ip = IpAddr::from([192, 0, 2, i as u8]);
            // One failure then a success → consecutive_failures == 0 → idle.
            throttles.record_failure(ip, t0);
            throttles.record_success(ip);
        }
        assert_eq!(throttles.len(), THROTTLE_MAX_IPS);
        throttles.record_failure(IpAddr::from([203, 0, 113, 100]), t0);
        assert!(
            throttles.len() <= THROTTLE_MAX_IPS,
            "idle entries must be reclaimed first"
        );
    }

    /// M-4c: Host header shape gate — IP literals (v4/v6, bracketed for
    /// v6, optional ports), localhost; hostnames and duplicates rejected.
    /// An unbracketed IPv6 with a trailing group looks like host:port and
    /// is refused (Host requires brackets for IPv6 per RFC 3986).
    #[test]
    fn host_header_gate() {
        assert!(host_value_allowed("127.0.0.1"));
        assert!(host_value_allowed("127.0.0.1:58041"));
        assert!(host_value_allowed("192.168.1.20:58041"));
        assert!(host_value_allowed("localhost"));
        assert!(host_value_allowed("LOCALHOST:80"));
        assert!(host_value_allowed("[::1]"));
        assert!(host_value_allowed("[::1]:58041"));
        assert!(!host_value_allowed("::1"), "IPv6 in Host must be bracketed");
        assert!(!host_value_allowed("evil.example"));
        assert!(!host_value_allowed("evil.example:80"));
        assert!(!host_value_allowed("localhost."));
        assert!(!host_value_allowed("127.0.0.2.evil.example"));
        assert!(!host_value_allowed("127.0.0.1:"));
        assert!(!host_value_allowed(""));
        assert!(!host_value_allowed("[::1]junk"));

        let parse = |head: &str| {
            host_header_allowed(
                &parse_head(format!("GET / HTTP/1.1\r\n{head}\r\n\r\n").as_bytes()).unwrap(),
            )
        };
        assert!(parse("Host: 127.0.0.1:58041"));
        assert!(parse("Host: localhost"));
        assert!(!parse("Host: rebind.example"));
        // Absent Host is fine (HTTP/1.0).
        assert!(host_header_allowed(
            &parse_head(b"GET / HTTP/1.0\r\n\r\n").unwrap()
        ));
        // Two Host headers are smuggling bait — rejected.
        assert!(!parse("Host: 127.0.0.1\r\nHost: localhost"));
    }

    /// CSPRNG SHAPE only (lengths/charset/distribution sanity) — never
    /// concrete values.
    #[test]
    fn csprng_pin_and_token_shapes() {
        let pins: Vec<String> = (0..24).map(|_| random_digits(6).unwrap()).collect();
        for pin in &pins {
            assert_eq!(pin.len(), 6);
            assert!(pin.bytes().all(|b| b.is_ascii_digit()));
        }
        // 24 draws over a 10^6 keyspace: all-equal has probability
        // ~1e-138, so distinctness is a safe distribution canary.
        let distinct =
            std::collections::HashSet::<&str>::from_iter(pins.iter().map(String::as_str));
        assert!(distinct.len() > 1);
        // Widths zero-pad (v % 10^n can be small).
        assert_eq!(random_digits(4).unwrap().len(), 4);

        let tokens: Vec<String> = (0..2).map(|_| random_token().unwrap()).collect();
        for token in &tokens {
            assert_eq!(token.len(), 64);
            assert!(
                token
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            );
        }
        assert_ne!(tokens[0], tokens[1]);
    }

    #[tokio::test]
    async fn stopping_server_revokes_an_already_accepted_pair_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let (_gd_tx, gd_rx) = watch::channel(GamedataState::Ready(None));
        let (shutdown, stopped) = watch::channel(false);
        let mut shared = test_shared(gd_rx);
        Arc::get_mut(&mut shared).unwrap().shutdown = stopped;
        let task = tokio::spawn(serve(listener, shared.clone()));
        let mut client = TcpStream::connect(address).await.unwrap();
        let body = br#"{"pin":"123456"}"#;
        let head = format!(
            "POST /pair HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        client.write_all(head.as_bytes()).await.unwrap();
        client.write_all(&body[..1]).await.unwrap();
        // The serve loop and this test each hold one Arc. A third proves
        // a handler accepted the socket before shutdown, without sleeps.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while Arc::strong_count(&shared) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        shutdown.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        // Completing a request with the old PIN after stop must not mint
        // a still-usable session token on the old accepted socket.
        let _ = client.write_all(&body[1..]).await;
        let mut response = Vec::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.read_to_end(&mut response),
        )
        .await;
        assert!(
            response.is_empty(),
            "stopped server answered: {}",
            String::from_utf8_lossy(&response)
        );
        assert_eq!(
            Arc::strong_count(&shared),
            1,
            "stop must join every handler"
        );
    }

    #[tokio::test]
    async fn complete_request_with_glued_body_parses() {
        let (mut server, mut client) = tcp_pair().await;
        use tokio::io::AsyncWriteExt;
        let body = br#"{"pin":"123456"}"#;
        let head = format!(
            "POST /pair HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        // Head and body in one flight — reqwest's exact shape.
        client.write_all(head.as_bytes()).await.unwrap();
        client.write_all(body).await.unwrap();
        let (req, read_body) = read_request(&mut server, std::time::Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/pair");
        assert_eq!(req.content_length, body.len());
        assert_eq!(read_body, body.to_vec());
    }

    #[tokio::test]
    async fn trickled_head_hits_the_request_deadline() {
        let (mut server, mut client) = tcp_pair().await;
        use tokio::io::AsyncWriteExt;
        // A slowloris: partial head, then the client stalls forever.
        client
            .write_all(b"POST /pair HTTP/1.1\r\nContent-Len")
            .await
            .unwrap();
        let started = std::time::Instant::now();
        let res = read_request(&mut server, std::time::Duration::from_millis(150)).await;
        assert!(res.is_err(), "trickled head must be cut");
        assert!(
            started.elapsed() >= std::time::Duration::from_millis(140),
            "the deadline, not a parse error, must fire"
        );
    }

    #[tokio::test]
    async fn gamedata_waits_for_the_build_then_serves() {
        // Request lands while Building; the zip arrives within the
        // bound → the SAME response serves the bytes.
        let tmp = super::super::tests::tempfile_dir();
        let src = tmp.join("gameparams");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.json"), b"GP-A").unwrap();
        let zip_path = tmp.join("gd.zip");
        assert_eq!(write_gamedata_zip(&[src], &zip_path).unwrap(), 1);
        let (tx, rx) = watch::channel(GamedataState::Building);
        let shared = test_shared(rx);
        let (mut server, mut client) = tcp_pair().await;
        let handler = tokio::spawn(async move {
            handle_gamedata_with_wait(&mut server, &shared, std::time::Duration::from_secs(5)).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        tx.send(GamedataState::Ready(Some(zip_path.clone())))
            .unwrap();
        handler.await.unwrap().unwrap();

        use tokio::io::AsyncReadExt;
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.starts_with("HTTP/1.1 200 OK"), "got: {text}");
        assert!(text.contains("Content-Type: application/zip"));
        let expected = std::fs::read(&zip_path).unwrap();
        assert_eq!(&raw[raw.len() - expected.len()..], &expected[..]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn gamedata_answers_503_retry_after_while_building() {
        // Build never finishes within the (shortened) bound → 503 with
        // a usable Retry-After, not a hang and not an error.
        let (tx, rx) = watch::channel(GamedataState::Building);
        let shared = test_shared(rx);
        let (mut server, mut client) = tcp_pair().await;
        handle_gamedata_with_wait(&mut server, &shared, std::time::Duration::from_millis(120))
            .await
            .unwrap();
        // The route's caller (the connection task) owns the stream and
        // drops it after the response — closing our side is what makes
        // the client's read_to_end see EOF.
        drop(tx);
        drop(server);

        use tokio::io::AsyncReadExt;
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.starts_with("HTTP/1.1 503"), "got: {text}");
        assert!(text.contains(&format!("Retry-After: {GAMEDATA_RETRY_AFTER_SECS}")));
        assert!(text.contains("still being prepared"));
    }

    #[tokio::test]
    async fn gamedata_surfaces_a_dead_build_task() {
        // Sender dropped without a result → clean 500, never a hang.
        let (tx, rx) = watch::channel(GamedataState::Building);
        drop(tx);
        let shared = test_shared(rx);
        let (mut server, mut client) = tcp_pair().await;
        handle_gamedata_with_wait(&mut server, &shared, std::time::Duration::from_secs(5))
            .await
            .unwrap();
        drop(server);

        use tokio::io::AsyncReadExt;
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.starts_with("HTTP/1.1 500"), "got: {text}");
    }
}
