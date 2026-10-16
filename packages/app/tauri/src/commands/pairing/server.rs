//! The desktop-side pairing server (the LAN HTTP/1.1 listener behind the
//! PIN/token data routes). Split from the former single-file
//! `commands/pairing.rs` — everything here is `#[cfg(desktop)]` via the module
//! declaration in `mod.rs`.

use anyhow::{Result, anyhow, bail};

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

/// Everything the connection handlers need; shared via Arc. The token is
/// readable from the state snapshot for diagnostics — kept here only.
struct Shared {
    pin: String,
    token: String,
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
    /// /pair brute-force throttle (see [`PinThrottle`]). Std mutex: the
    /// critical sections are two integer writes, never held across an
    /// await. Fresh per server run.
    pin_throttle: std::sync::Mutex<PinThrottle>,
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

/// PIN brute-force throttle, dependency-free and pure so the behavior is
/// unit-testable: after [`PIN_MAX_FAILURES`] consecutive wrong PINs the
/// exchange rejects EVERY attempt (correct PIN included — the check runs
/// before the comparison) until a [`PIN_BLOCK_WINDOW`] has passed since
/// the failure that tripped the limit. A correct PIN resets the counter;
/// failures keep accumulating across expired windows, so a persistent
/// guesser settles into one guess per window.
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
}

/// Handle to a fixture server: the minted token plus its shutdown signal.
#[cfg(test)]
pub struct ServerHandle {
    #[allow(dead_code)] // read via Debug/diagnostics in tests
    pub token: String,
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
    let token = random_token()?;
    // Relay v2 room identity: a fresh random 64-hex id per run — the
    // gateway binds its allocated pairing code to THIS id; nothing is
    // ever derived from the pin.
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
        token: token.clone(),
        room: room.clone(),
        replay_root,
        gamedata: gd_rx,
        _gamedata_workspace: Some(workspace),
        pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
        shutdown: rx,
    });
    let task = tokio::spawn(serve(listener, shared));
    Ok(ServerState {
        running: true,
        host,
        port,
        pin,
        room,
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
        token: token.clone(),
        room: room.to_string(),
        replay_root,
        gamedata: gd_rx,
        _gamedata_workspace: None,
        pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
        shutdown: rx,
    });
    let task = tokio::spawn(serve(listener, shared));
    Ok(ServerHandle {
        token,
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
            // NO timeout wrapper: handle_conn bounds only the request
            // reading internally; the response may stream for minutes.
            if let Err(e) = handle_conn(stream, &shared).await {
                tracing::warn!(%peer, error = %e, "pairing connection dropped");
            }
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
    /// Percent-decoded path (no query).
    pub(super) path: String,
    /// `?a=b` pairs (percent-decoded).
    pub(super) query: Vec<(String, String)>,
    /// Lowercased header name → value.
    pub(super) headers: Vec<(String, String)>,
    pub(super) content_length: usize,
}

impl Request {
    pub(super) fn query_param(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

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
    // Split query off the target, percent-decode the path.
    let (raw_path, raw_query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    let path = percent_decode(raw_path)?;
    let query = raw_query
        .unwrap_or("")
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => Ok((percent_decode(k)?, percent_decode(v)?)),
            None => Ok((percent_decode(pair)?, String::new())),
        })
        .collect::<Result<Vec<_>>>()?;
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
        query,
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
/// slowloris protection; the routing/response phase is deliberately
/// unbounded so multi-hundred-MB streams are never cut mid-transfer.
/// Routes are resolved BEFORE the auth check so unknown paths 404
/// regardless of token state (the route set is public knowledge; hiding
/// it behind a 401 buys nothing on a LAN toy and muddies client error
/// mapping).
async fn handle_conn(mut stream: TcpStream, shared: &Shared) -> Result<()> {
    let (req, body) = read_request(&mut stream, REQUEST_TIMEOUT).await?;
    let authed = req
        .bearer_token()
        .or_else(|| req.query_param("token"))
        .is_some_and(|t| token_eq(t, &shared.token));

    let method = req.method.clone();
    let path = req.path.clone();

    if method == "POST" && path == "/pair" {
        return handle_pair(&mut stream, shared, &req, body).await;
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
    let pin = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("pin").and_then(|p| p.as_str()).map(str::to_string))
        .unwrap_or_default();
    // Throttle BEFORE the comparison: within a tripped window even the
    // CORRECT PIN is rejected — otherwise the lockout would leak when
    // the guessing stops. The guard is dropped at the end of this
    // statement (std mutexes must never ride an await).
    let blocked_for = shared_throttle(shared)
        .check(std::time::Instant::now())
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
    // tunnel phone always types the code.
    let relay_code = crate::commands::pairing_relay::current_relay_code();
    let pin_ok = token_eq(&pin, &shared.pin)
        || relay_code.is_some_and(|code| !code.is_empty() && token_eq(&pin, &code));
    if !pin_ok {
        shared_throttle(shared).record_failure(std::time::Instant::now());
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
    shared_throttle(shared).record_success();
    // The room id rides along: relay phones address their later tunnels
    // by it (LAN phones ignore it).
    respond_json(
        stream,
        200,
        "OK",
        &serde_json::json!({ "token": shared.token, "room": shared.room }),
    )
    .await
    .map_err(anyhow::Error::from)
}

/// Lock the PIN throttle, treating a poisoned lock as recoverable (the
/// guarded state is two integers; a panicked writer loses nothing but
/// the last update).
fn shared_throttle(shared: &Shared) -> std::sync::MutexGuard<'_, PinThrottle> {
    shared
        .pin_throttle
        .lock()
        .unwrap_or_else(|p| p.into_inner())
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

/// `scan_replays_meta` on the blocking pool — even with `lite_from_path`
/// reading only the bounded first block, an unbounded full-tree listing
/// (every archived version subfolder included) is real disk work that
/// must never stall async runtime workers (the async
/// `list_replays_meta` command wraps the same scan in its own
/// `spawn_blocking`; the hand-rolled server has to do it itself).
async fn scan_remote(
    replay_root: PathBuf,
) -> Result<(PathBuf, Vec<wowsp_tauri_shared::ReplayMetaLite>)> {
    let dir = replay_root.to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || replay::scan_replays_meta(Some(dir), None))
        .await
        .map_err(|e| anyhow!("replay scan task failed: {e}"))?
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

/// Stream a file with Content-Length + Connection: close.
async fn serve_file(stream: &mut TcpStream, path: &Path, content_type: &str) -> Result<()> {
    let len = std::fs::metadata(path)
        .map_err(|e| anyhow!("stat {}: {e}", path.display()))?
        .len();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| anyhow!("write head: {e}"))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    tokio::io::copy(&mut file, stream)
        .await
        .map_err(|e| anyhow!("stream {}: {e}", path.display()))?;
    stream.flush().await.map_err(|e| anyhow!("flush: {e}"))?;
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
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await
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
            token: "test-token".to_string(),
            room: "a".repeat(64),
            replay_root: std::env::temp_dir(),
            gamedata,
            _gamedata_workspace: None,
            pin_throttle: std::sync::Mutex::new(PinThrottle::default()),
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
