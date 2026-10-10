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

use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

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
/// the content family (updates/avatars/images/relay).
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

/// Send one GET with the outcome recorded against `host` — the transport
/// choke point for the stats family. Error strings keep the caller's
/// historical `"{label} request: …"` shape so the raw texts the cards
/// already render stay stable. Parse-level failures are NOT recorded:
/// behind a healthy 200 they are ambiguous (a proxy answering HTML, a
/// truncated body) and the send/status pair already covers the outage
/// shapes a degraded host produces.
pub(crate) async fn recorded_get(
    client: &reqwest::Client,
    host: &str,
    label: &str,
    url: String,
) -> Result<reqwest::Response, String> {
    let outcome = client.get(&url).send().await;
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
    outcome.map_err(|e| format!("{label} request: {e}"))
}

/// `recorded_get` for callers that swallow errors (best-effort paths):
/// records the outcome, discards the error, returns whether it worked.
pub(crate) async fn best_effort_get(
    client: &reqwest::Client,
    host: &str,
    label: &str,
    url: String,
) -> Option<reqwest::Response> {
    recorded_get(client, host, label, url).await.ok()
}

/// Record the outcome of a request the caller drove itself — for sites
/// that must keep their exact historical error pipeline (e.g. an anyhow
/// context where the raw `reqwest::Error` flows on unchanged). Same
/// send+status discipline as [`recorded_get`]; the response passes back
/// untouched for the caller to consume.
pub(crate) fn record_response(host: &str, result: &Result<reqwest::Response, reqwest::Error>) {
    match result {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                record_success(host);
            } else {
                record_failure(host, &format!("HTTP {status}"));
            }
        },
        Err(e) => record_failure(host, &format!("request: {e}")),
    }
}

/// Transport-only variant for endpoints whose HTTP status is BUSINESS
/// semantics, not health: the CN vortex answers 404 for unknown accounts
/// and clanless profiles / unknown clans, so counting statuses there
/// would flag the host every time someone queries an absent id. Any HTTP
/// answer counts as the host being alive; only a SEND failure (timeout,
/// connection refused — the shapes a degraded host actually produces)
/// records a failure.
pub(crate) fn record_transport(host: &str, result: &Result<reqwest::Response, reqwest::Error>) {
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
pub async fn upstream_health() -> Result<Vec<UpstreamHostReport>, String> {
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
}
