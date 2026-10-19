//! Upstream host health registry — the data behind the title bar's
//! "upstream service fault" chip.
//!
//! The stats lookups fan out over a fixed set of upstream hosts (the
//! WG/Lesta API realms, the vortex transports, the CN clans host — see
//! [`super::wg_realm`]). When one of them degrades (the 2026-10-09
//! evening-peak vortex slowdown answered 30s+ TTFB behind a 15s client
//! timeout), every tool in the ecosystem fails at once and users have
//! no way to tell "wowsp broke" from "the game vendor's service broke".
//! This module records, per host, the outcome of the transport-level
//! requests the app already makes — never a probe of its own — and the
//! `upstream_health` command serves the joined catalogue + health table
//! so the frontend can flag and DISCLOSE the failing domains.
//!
//! Recording discipline:
//!   - only the stats-family hosts are wired (`kind: "stats"` in the
//!     catalogue); GitHub/Bilibili/CDN surfaces have their own failure
//!     UIs and stay unrecorded until a need shows up,
//!   - a request counts through its SEND + status outcome only. Business
//!     errors behind a healthy 200 (an API `error: …` payload, a 404 the
//!     CN clans endpoint answers for clanless accounts) are semantics,
//!     not outages, and never touch the registry,
//!   - best-effort everywhere: a poisoned mutex degrades to a no-op, a
//!     recording failure must never fail the lookup it rode on.

use anyhow::anyhow;
use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

/// The disclosed host catalogue (one row per external host the app can
/// talk to — including the unrecorded content family, so the tooltip can
/// answer "where do requests go" in full). The parity test below keeps
/// this file and the hosts `wg_realm` actually dials from drifting.
const CATALOGUE_JSON: &str = include_str!("../../../../../res/config/upstream-endpoints.json");

/// Longest `last_error` tail kept per host — enough to recognize an
/// "HTTP 503" vs a timeout, not enough to store a wall of text.
const ERROR_TRUNC: usize = 120;

#[derive(Deserialize)]
struct CatalogueFile {
    entries: Vec<CatalogueEntry>,
}

/// One catalogue row. `purpose` is an i18n key suffix under
/// `upstream.purpose.*`; `kind` splits the recorded stats family from
/// the content family (updates/avatars/images/relay/telemetry).
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    pub id: String,
    pub host: String,
    pub purpose: String,
    pub realms: Vec<String>,
    pub kind: String,
}

/// Per-host rolling outcome. Consecutive failures drive the frontend's
/// "currently failing" verdict; a success resets the streak.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHealth {
    pub consecutive_failures: u32,
    pub last_success_ts: Option<i64>,
    pub last_failure_ts: Option<i64>,
    pub last_error: Option<String>,
}

static HOST_HEALTH: LazyLock<std::sync::Mutex<BTreeMap<String, HostHealth>>> =
    LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn health_of(host: &str) -> HostHealth {
    HOST_HEALTH
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(host.to_string())
        .or_default()
        .clone()
}

pub(crate) fn record_success(host: &str) {
    let mut map = HOST_HEALTH.lock().unwrap_or_else(|p| p.into_inner());
    let h = map.entry(host.to_string()).or_default();
    h.consecutive_failures = 0;
    h.last_success_ts = Some(now_ts());
}

pub(crate) fn record_failure(host: &str, error: &str) {
    // Truncate on a char boundary — the tail of a reqwest error can carry
    // non-ASCII (a URL-escaped host, a localized OS message), and a blind
    // byte truncate would panic on a split code point.
    let mut error = error.to_string();
    if error.len() > ERROR_TRUNC {
        let boundary = error
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|&i| i <= ERROR_TRUNC)
            .last()
            .unwrap_or(0);
        error.truncate(boundary);
    }
    let mut map = HOST_HEALTH.lock().unwrap_or_else(|p| p.into_inner());
    let h = map.entry(host.to_string()).or_default();
    h.consecutive_failures = h.consecutive_failures.saturating_add(1);
    h.last_failure_ts = Some(now_ts());
    h.last_error = Some(error);
}

/// How long a host stays on the direct path after a proxy failure handed
/// it over. The mark keeps a black-holing proxy from taxing every request
/// with a dead-connection wait; its expiry is also the proxy's periodic
/// re-probe — the next request after the TTL pays proxy-first again, and a
/// healed proxy takes the host back on the spot.
const DIRECT_PREFERRED_TTL_MS: i64 = 10 * 60 * 1000;

/// host → the unix-ms instant until which requests prefer the direct path.
static DIRECT_PREFERRED: LazyLock<std::sync::Mutex<BTreeMap<String, i64>>> =
    LazyLock::new(|| std::sync::Mutex::new(BTreeMap::new()));

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether `host` currently rides the direct path — a mark that is still
/// fresh at `now`. Lock-poisoned or absent both read as "no mark", the
/// same degrade-to-normal-policy stance the health table takes.
fn direct_preferred_at(host: &str, now: i64) -> bool {
    DIRECT_PREFERRED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(host)
        .is_some_and(|until| *until > now)
}

/// Hand the host to the direct path for [`DIRECT_PREFERRED_TTL_MS`].
fn prefer_direct(host: &str) {
    DIRECT_PREFERRED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(host.to_string(), now_millis() + DIRECT_PREFERRED_TTL_MS);
}

/// Drop the direct-path mark; true when one existed (fresh or stale).
fn clear_direct_preferred(host: &str) -> bool {
    DIRECT_PREFERRED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(host)
        .is_some()
}

/// One GET attempt over one client. The point is the per-attempt log line:
/// every connection the app makes leaves one here (host, endpoint label,
/// which path rode, how long it took, how it ended), so a support bundle
/// can tell a hung proxy from a dead host instead of staring at silence.
async fn attempt_get(
    client: &reqwest::Client,
    host: &str,
    label: &str,
    url: &str,
    via: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    let started = std::time::Instant::now();
    let outcome = client.get(url).send().await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match &outcome {
        Ok(_) => tracing::debug!(host, label, via, elapsed_ms, "http transport attempt ok"),
        Err(e) => {
            tracing::debug!(host, label, via, elapsed_ms, error = %e, "http transport attempt failed")
        },
    }
    outcome
}

/// One GET through the proxy→direct chain — the stats family's transport
/// primitive. Proxy first (the configured policy is the user's explicit
/// choice); a TRANSPORT-level failure over the proxy (timeout, connect,
/// TLS — not an HTTP error status, which proves the path works) degrades
/// to one attempt on the direct twin; only both failing fails the request.
/// After a proxy failure the host rides the direct path for
/// [`DIRECT_PREFERRED_TTL_MS`], and a proxy success takes it back at once.
///
/// Errors come back UNPREFIXED — callers add their own shape
/// (`recorded_get` restores the historical `"{label} request: …"`).
/// No health is recorded here: callers own the recording
/// ([`recorded_get`] / [`record_transport`]) and key it on the FINAL
/// outcome — a proxy failure rescued by the direct path leaves the host
/// healthy.
/// Loopback targets never ride the proxy in the first place (the base
/// builder exempts `localhost`/`127.0.0.1` — see `http_builder_for`), so
/// the chain must not narrate a proxy→direct fallback for them — nor burn
/// a direct-preference mark on a host whose "proxied" attempt was never a
/// proxy path at all.
fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host.starts_with("127.") || host == "::1" || host.starts_with("[::1]")
}

pub(crate) async fn get_with_fallback(
    pair: &super::network::HttpPair,
    host: &str,
    label: &str,
    url: String,
) -> anyhow::Result<reqwest::Response> {
    let can_proxy = pair.has_proxy() && !is_loopback_host(host);
    if can_proxy && !direct_preferred_at(host, now_millis()) {
        match attempt_get(pair.proxied(), host, label, &url, "proxy").await {
            Ok(resp) => {
                if clear_direct_preferred(host) {
                    tracing::info!(
                        host,
                        label,
                        "proxy transport recovered — host back on the proxy path"
                    );
                }
                return Ok(resp);
            },
            Err(proxy_err) => {
                tracing::info!(
                    host,
                    label,
                    error = %proxy_err,
                    "proxy transport failed — falling back to the direct path"
                );
                prefer_direct(host);
                return match attempt_get(pair.direct(), host, label, &url, "direct-fallback").await
                {
                    Ok(resp) => Ok(resp),
                    Err(direct_err) => Err(anyhow!(
                        "{proxy_err}; the direct fallback also failed: {direct_err}"
                    )),
                };
            },
        }
    }
    let via = if can_proxy {
        "direct-preferred"
    } else {
        "direct"
    };
    attempt_get(pair.direct(), host, label, &url, via)
        .await
        .map_err(|e| anyhow!("{e}"))
}

/// Send one GET through the fallback chain with the outcome recorded
/// against `host` — the transport choke point for the stats family. Error
/// strings keep the caller's historical `"{label} request: …"` shape so
/// the raw texts the cards already render stay stable. Parse-level
/// failures are NOT recorded: behind a healthy 200 they are ambiguous (a
/// proxy answering HTML, a truncated body) and the send/status pair
/// already covers the outage shapes a degraded host produces.
pub(crate) async fn recorded_get(
    pair: &super::network::HttpPair,
    host: &str,
    label: &str,
    url: String,
) -> anyhow::Result<reqwest::Response> {
    let outcome = get_with_fallback(pair, host, label, url).await;
    match &outcome {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                record_success(host);
            } else {
                record_failure(host, &format!("HTTP {status}"));
            }
        },
        Err(e) => record_failure(host, &format!("{label} request: {e}")),
    }
    outcome.map_err(|e| anyhow!("{label} request: {e}"))
}

/// `recorded_get` for callers that swallow errors (best-effort paths):
/// records the outcome, discards the error, returns whether it worked.
pub(crate) async fn best_effort_get(
    pair: &super::network::HttpPair,
    host: &str,
    label: &str,
    url: String,
) -> Option<reqwest::Response> {
    recorded_get(pair, host, label, url).await.ok()
}

/// Transport-only variant for endpoints whose HTTP status is BUSINESS
/// semantics, not health: the CN vortex answers 404 for unknown accounts
/// and clanless profiles / unknown clans, so counting statuses there
/// would flag the host every time someone queries an absent id. Any HTTP
/// answer counts as the host being alive; only a SEND failure (timeout,
/// connection refused — the shapes a degraded host actually produces)
/// records a failure.
pub(crate) fn record_transport(host: &str, result: &anyhow::Result<reqwest::Response>) {
    match result {
        Ok(_) => record_success(host),
        Err(e) => record_failure(host, &format!("request: {e}")),
    }
}

/// The catalogue, parsed once per call site (a few-hundred-byte file —
/// parsing on demand keeps the command self-contained and the test
/// honest about what actually ships).
pub(crate) fn host_catalogue() -> Vec<CatalogueEntry> {
    match serde_json::from_str::<CatalogueFile>(CATALOGUE_JSON) {
        Ok(f) => f.entries,
        Err(e) => {
            // A broken catalogue would leave the fault chip blind (empty
            // table, parity test red in CI) — say so at runtime too.
            tracing::warn!(%e, "upstream-endpoints catalogue failed to parse");
            Vec::new()
        },
    }
}

/// One reported row: catalogue metadata + live health.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamHostReport {
    #[serde(flatten)]
    pub entry: CatalogueEntry,
    pub recorded: bool,
    #[serde(flatten)]
    pub health: HostHealth,
}

/// `#[tauri::command]`: the joined catalogue + health table. Stateless —
/// the frontend polls it around its own lookup failures and renders the
/// verdict (streak threshold, staleness) itself.
#[tauri::command]
pub async fn upstream_health() -> CommandResult<Vec<UpstreamHostReport>> {
    let catalogue = host_catalogue();
    Ok(catalogue
        .into_iter()
        .map(|entry| {
            let recorded = entry.kind == "stats";
            let health = if recorded {
                health_of(&entry.host)
            } else {
                HostHealth::default()
            };
            UpstreamHostReport {
                entry,
                recorded,
                health,
            }
        })
        .collect())
}

/// Host of an `https://…` URL — the CN module's shared `get_json` knows
/// only the full URL, and the catalogue keys on bare hosts.
pub(crate) fn host_of_url(url: &str) -> &str {
    url.trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_resets_the_failure_streak() {
        let host = "test-success-reset.example";
        record_failure(host, "HTTP 503");
        record_failure(host, "request timeout");
        assert_eq!(health_of(host).consecutive_failures, 2);
        record_success(host);
        let h = health_of(host);
        assert_eq!(h.consecutive_failures, 0);
        assert!(h.last_success_ts.is_some());
        assert!(h.last_failure_ts.is_some(), "the failure history stays");
        assert!(h.last_error.is_some());
    }

    #[test]
    fn failures_accumulate_and_errors_truncate() {
        let host = "test-truncate.example";
        let long = "x".repeat(ERROR_TRUNC * 3);
        record_failure(host, &long);
        record_failure(host, &long);
        let h = health_of(host);
        assert_eq!(h.consecutive_failures, 2);
        assert_eq!(h.last_error.as_ref().unwrap().len(), ERROR_TRUNC);
    }

    #[test]
    fn hosts_are_independent() {
        let a = "test-independent-a.example";
        let b = "test-independent-b.example";
        record_failure(a, "HTTP 500");
        assert_eq!(health_of(b).consecutive_failures, 0);
        assert_eq!(health_of(a).consecutive_failures, 1);
    }

    #[test]
    fn catalogue_parses_and_covers_every_wg_realm_host() {
        let catalogue = host_catalogue();
        assert!(!catalogue.is_empty(), "the catalogue file must parse");
        let hosts: std::collections::HashSet<&str> =
            catalogue.iter().map(|e| e.host.as_str()).collect();
        // Every host the realm tables can produce must be disclosed —
        // the parity fence between wg_realm.rs and the config file.
        for realm in ["ru", "eu", "na", "asia"] {
            assert!(hosts.contains(super::super::wg_realm::api_host(realm).unwrap()));
            assert!(hosts.contains(super::super::wg_realm::vortex_host(realm).unwrap()));
        }
        assert!(hosts.contains(super::super::wg_realm::vortex_host("cn").unwrap()));
        assert!(hosts.contains(super::super::wg_realm::cn_clans_host()));
        // The content family is present but unrecorded.
        let github = catalogue.iter().find(|e| e.id == "github").unwrap();
        assert_eq!(github.kind, "content");
    }

    #[test]
    fn catalogue_ids_and_hosts_are_unique() {
        let catalogue = host_catalogue();
        let mut ids: Vec<_> = catalogue.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), catalogue.len(), "duplicate catalogue id");
        // The one deliberate overlap: the encyclopedia row shares the
        // asia API host with the stats row — same domain, two purposes.
        // Everything else must be 1:1.
        let mut hosts: Vec<_> = catalogue.iter().map(|e| e.host.as_str()).collect();
        hosts.sort();
        let dupes = hosts.windows(2).filter(|w| w[0] == w[1]).count();
        assert!(dupes <= 1, "unexpected duplicate hosts beyond asia");
    }

    #[test]
    fn catalogue_discloses_the_telemetry_hosts() {
        // The webui's opt-out GA telemetry dials these (see the CSP in
        // tauri.conf.json) — the "every external host" claim must hold.
        let catalogue = host_catalogue();
        for host in ["www.googletagmanager.com", "*.google-analytics.com"] {
            let row = catalogue
                .iter()
                .find(|e| e.host == host)
                .unwrap_or_else(|| panic!("{host} missing from the catalogue"));
            assert_eq!(row.kind, "content", "{host} is never health-recorded");
            assert_eq!(row.purpose, "analytics");
        }
    }

    #[test]
    fn host_of_url_extracts_the_bare_host() {
        assert_eq!(
            host_of_url("https://vortex.wowsgame.cn/api/accounts/search/x/?limit=10"),
            "vortex.wowsgame.cn"
        );
        assert_eq!(
            host_of_url("https://api.korabli.su/wows/account/list/"),
            "api.korabli.su"
        );
        assert_eq!(host_of_url("not-a-url"), "not-a-url");
    }

    #[test]
    fn direct_preference_marks_expires_and_clears() {
        let host = "test-preference.example";
        assert!(!direct_preferred_at(host, 1000), "no mark yet");
        prefer_direct(host);
        let until = DIRECT_PREFERRED
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(host)
            .copied()
            .expect("mark stored");
        assert!(until > now_millis(), "the mark reaches into the future");
        assert!(direct_preferred_at(host, until - 1), "fresh inside the TTL");
        assert!(
            !direct_preferred_at(host, until),
            "stale exactly at the expiry instant"
        );
        assert!(clear_direct_preferred(host), "a mark existed");
        assert!(!clear_direct_preferred(host), "the second clear finds none");
    }

    /// A minimal HTTP/1.1 stub: answers `len` sequential connections with a
    /// fixed 200 body. The fallback chain tests point the direct twin at it.
    fn stub_server(len: usize) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("stub bind");
        let addr = listener.local_addr().expect("stub addr");
        let handle = std::thread::spawn(move || {
            for _ in 0..len {
                let (mut stream, _) = listener.accept().expect("stub accept");
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                );
            }
        });
        (addr, handle)
    }

    /// The dead-proxy client: an explicit proxy on a refused loopback port,
    /// system detection off — fails in milliseconds regardless of env.
    fn dead_proxy_client() -> reqwest::Client {
        reqwest::Client::builder()
            .proxy(reqwest::Proxy::http("http://127.0.0.1:1").expect("dead proxy"))
            .build()
            .expect("dead proxy client")
    }

    #[tokio::test]
    async fn proxy_failure_falls_back_to_direct_and_marks_the_host() {
        let host = "test-fallback.example";
        let (addr, server) = stub_server(2);
        let pair = crate::commands::network::HttpPair::from_clients(
            dead_proxy_client(),
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("direct"),
            true,
        );
        let url = format!("http://{addr}/probe");

        // First request: the proxy arm fails, the direct twin lands.
        let resp = get_with_fallback(&pair, host, "probe", url.clone())
            .await
            .expect("direct fallback rescues");
        assert_eq!(resp.status(), 200);
        assert!(
            direct_preferred_at(host, now_millis()),
            "the proxy failure hands the host to the direct path"
        );

        // Second request inside the TTL: straight onto the direct path.
        let resp = get_with_fallback(&pair, host, "probe", url)
            .await
            .expect("direct-preferred request");
        assert_eq!(resp.status(), 200);
        server.join().expect("stub served both connections");
        let _ = clear_direct_preferred(host);
    }

    #[tokio::test]
    async fn proxy_success_takes_the_host_back_from_the_direct_path() {
        let host = "test-recovery.example";
        prefer_direct(host);
        // Age the mark past its expiry: a FRESH mark sends requests straight
        // down the direct path (the proxy is not re-probed until the TTL
        // lapses); a STALE mark lets the proxy arm run again, and its
        // success clears the leftover mark on the spot.
        DIRECT_PREFERRED
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(host.to_string(), now_millis() - 1);
        let (addr, server) = stub_server(1);
        // The proxied client talks straight to the stub here (a proxy that
        // WORKS is indistinguishable from a direct client for the chain):
        // its success must clear the stale direct-preference mark.
        let pair = crate::commands::network::HttpPair::from_clients(
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("healthy"),
            dead_proxy_client(),
            true,
        );
        let resp = get_with_fallback(&pair, host, "probe", format!("http://{addr}/probe"))
            .await
            .expect("proxy path serves");
        assert_eq!(resp.status(), 200);
        assert!(
            !direct_preferred_at(host, now_millis()),
            "a proxy success clears the direct-preference mark"
        );
        server.join().expect("stub served");
    }

    #[tokio::test]
    async fn both_paths_failing_fails_the_request_with_both_errors() {
        let host = "test-both-fail.example";
        let pair = crate::commands::network::HttpPair::from_clients(
            dead_proxy_client(),
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("direct"),
            true,
        );
        // Port 9 (discard) is refused on loopback — both arms fail.
        let err = get_with_fallback(&pair, host, "probe", "http://127.0.0.1:9/probe".to_string())
            .await
            .expect_err("both paths dead");
        let text = err.to_string();
        assert!(
            text.contains("direct fallback also failed"),
            "both failures surface: {text}"
        );
        let _ = clear_direct_preferred(host);
    }

    #[tokio::test]
    async fn no_proxy_in_effect_means_a_single_direct_attempt() {
        let host = "test-no-proxy.example";
        let pair = crate::commands::network::HttpPair::from_clients(
            dead_proxy_client(),
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("direct"),
            false,
        );
        let err = get_with_fallback(&pair, host, "probe", "http://127.0.0.1:9/probe".to_string())
            .await
            .expect_err("direct-only fails");
        let text = err.to_string();
        assert!(
            !text.contains("direct fallback"),
            "no fallback is attempted without a proxy: {text}"
        );
        assert!(
            !direct_preferred_at(host, now_millis()),
            "no mark is written without a proxy"
        );
    }

    #[tokio::test]
    async fn loopback_targets_never_narrate_a_proxy_fallback() {
        // The base builder exempts loopback from any proxy, so the chain
        // must treat a loopback host as direct-only even on a proxying
        // pair: no proxy attempt, no fallback narrative, no mark.
        let pair = crate::commands::network::HttpPair::from_clients(
            dead_proxy_client(),
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("direct"),
            true,
        );
        let err = get_with_fallback(
            &pair,
            "127.0.0.1",
            "probe",
            "http://127.0.0.1:9/probe".to_string(),
        )
        .await
        .expect_err("loopback target dead");
        let text = err.to_string();
        assert!(
            !text.contains("direct fallback"),
            "no fallback narrative for a loopback host: {text}"
        );
        assert!(
            !direct_preferred_at("127.0.0.1", now_millis()),
            "no mark is written for a loopback host"
        );
    }
}
