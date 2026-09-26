use super::*;
// ── gateway resolution (protocol v2) ────────────────────────────────────────

/// Health-document route (merged liveness + discovery), fetched from
/// `<root>/api/health` with a 5 s timeout and `Cache-Control: no-store`.
const MANIFEST_PATH: &str = "/api/health";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(5);
/// A manifest body beyond this is not ours — treat like a non-200.
const MANIFEST_MAX_BYTES: usize = 64 * 1024;
/// How many `upstream` hops resolution follows before degrading to the
/// initial root (a cycle aborts the same way).
const MAX_UPSTREAM_HOPS: usize = 2;
/// Resolved-gateway cache lifetime — a pairing session resolves once and
/// every later socket of the session reuses the result.
const RESOLUTION_TTL: Duration = Duration::from_secs(300);

/// The v2 gateway health document. Every field defaults so a
/// partially-shaped JSON body still parses; [`is_gateway_manifest`]
/// separates real documents from foreign 200 responses (captive portals
/// and friends).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GatewayManifest {
    #[serde(default)]
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) provider: String,
    #[serde(default)]
    pub(super) name: String,
    /// The gateway's own version (informational).
    #[serde(default)]
    pub(super) version: Option<String>,
    /// The minimum client the gateway serves — enforced by
    /// [`client_meets_minimum`] before anything else.
    #[serde(default)]
    pub(super) min_client_version: Option<String>,
    #[serde(default)]
    pub(super) protocol: Vec<String>,
    #[serde(default)]
    pub(super) endpoints: GatewayEndpoints,
    #[serde(default)]
    pub(super) upstream: Option<String>,
    #[serde(default)]
    pub(super) features: Vec<String>,
    #[serde(default)]
    pub(super) notice: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GatewayEndpoints {
    #[serde(default)]
    pub(super) relay: String,
}

/// A body only counts as a gateway document when it says something
/// gateway-ish — a protocol list or a relay endpoint. Anything else that
/// parses as JSON (e.g. a captive portal's 200) is treated as "no
/// document" so resolution degrades to legacy direct mode instead of
/// erroring.
pub(super) fn is_gateway_manifest(m: &GatewayManifest) -> bool {
    !m.protocol.is_empty() || !m.endpoints.relay.is_empty()
}

/// Numeric `x.y.z` comparison of dotted versions (any trailing non-numeric
/// suffix on a part is ignored; missing parts count as 0). Returns true
/// when `client` >= `minimum`.
pub(super) fn client_meets_minimum(client: &str, minimum: &str) -> bool {
    let nums = |v: &str| {
        v.split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>()
    };
    let (c, m) = (nums(client), nums(minimum));
    for i in 0..c.len().max(m.len()) {
        let (a, b) = (
            c.get(i).copied().unwrap_or(0),
            m.get(i).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    true
}

/// The outcome of resolving a gateway root through the v2 manifest protocol.
#[derive(Debug, Clone)]
pub(crate) struct GatewayResolution {
    /// The WebSocket base every tunnel of the session dials
    /// (`…/control`, `…/resolve`, `…/data/…` hang off it).
    pub(super) ws_base: String,
    /// The final manifest when one was served (`None` = legacy v1 direct
    /// mode — no manifest existed).
    pub(super) manifest: Option<GatewayManifest>,
    /// At least one `upstream` hop was followed to reach the final gateway.
    pub(super) via_upstream: bool,
}

/// Manifest-derived info the desktop's `PairingStatus` surfaces while a
/// bridge session is live (all defaults in legacy direct mode / offline).
#[derive(Debug, Clone, Default)]
pub struct GatewayInfo {
    pub provider: Option<String>,
    pub via_upstream: bool,
    pub notice: Option<String>,
}

pub(super) fn gateway_info_of(res: &GatewayResolution) -> GatewayInfo {
    match &res.manifest {
        Some(m) => GatewayInfo {
            provider: (!m.provider.is_empty()).then(|| m.provider.clone()),
            via_upstream: res.via_upstream,
            notice: m.notice.clone(),
        },
        None => GatewayInfo::default(),
    }
}

fn gateway_info_slot() -> &'static Mutex<Option<GatewayInfo>> {
    static SLOT: OnceLock<Mutex<Option<GatewayInfo>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Resolved-gateway info of the CURRENT bridge session (defaults while
/// offline or in legacy direct mode) — feeds `PairingStatus`.
pub fn current_gateway_info() -> GatewayInfo {
    gateway_info_slot()
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

pub(super) fn store_gateway_info(info: Option<GatewayInfo>) {
    if let Ok(mut slot) = gateway_info_slot().lock() {
        *slot = info;
    }
}

/// One manifest fetch. `Ok(None)` = "no v2 manifest here" (transport error,
/// non-200, oversize or foreign body) — the caller falls back to legacy
/// direct mode; only a clean gateway manifest yields `Ok(Some(..))`.
async fn fetch_manifest(url: &str) -> Result<Option<GatewayManifest>, String> {
    // The SAME shared HTTP client every other outbound request uses: the
    // Android CA-bundle client there, SChannel on the desktop.
    let client = super::network::build_http_client()?;
    let resp = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .timeout(MANIFEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("manifest fetch failed ({e})"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let Ok(body) = resp.bytes().await else {
        return Ok(None);
    };
    if body.len() > MANIFEST_MAX_BYTES {
        return Ok(None);
    }
    match serde_json::from_slice::<GatewayManifest>(&body) {
        Ok(m) if is_gateway_manifest(&m) => Ok(Some(m)),
        _ => Ok(None),
    }
}

fn manifest_url(root: &str) -> String {
    format!("{root}{MANIFEST_PATH}")
}

/// Legacy v1 direct mode: the tunnels dial the root itself over WebSocket.
fn legacy_resolution(root: &str) -> GatewayResolution {
    GatewayResolution {
        ws_base: ws_base_of_root(root),
        manifest: None,
        via_upstream: false,
    }
}

/// Resolve a gateway root (see the module docs for the algorithm). Errors
/// ONLY on an unsupported final protocol — every other failure degrades to
/// legacy direct mode.
pub(super) async fn resolve_gateway(root_raw: &str) -> Result<GatewayResolution, String> {
    let initial = normalize_relay_root(root_raw)?;
    let mut current = initial.clone();
    let mut seen = vec![initial.clone()];
    let mut via_upstream = false;
    // One manifest fetch per iteration: the initial root plus at most
    // MAX_UPSTREAM_HOPS forwarded ones.
    for _ in 0..=MAX_UPSTREAM_HOPS {
        let manifest = match fetch_manifest(&manifest_url(&current)).await {
            Ok(Some(m)) => m,
            // Fetch failure / non-200 / foreign body → legacy direct mode
            // at the root we were fetching.
            _ => return Ok(legacy_resolution(&current)),
        };
        tracing::debug!(
            provider = %manifest.provider,
            name = %manifest.name,
            healthy = manifest.ok,
            version = ?manifest.version,
            features = ?manifest.features,
            "gateway health document resolved"
        );
        // A gateway that explicitly reports itself unhealthy gets the
        // same treatment as one we could not ask: legacy direct mode at
        // the root (dialing its documented endpoints is not sensible).
        if !manifest.ok {
            tracing::warn!("gateway reports ok:false — legacy direct mode");
            return Ok(legacy_resolution(&current));
        }
        let upstream = manifest
            .upstream
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(upstream) = upstream else {
            return finish_resolution(&current, manifest, via_upstream);
        };
        let next = match normalize_relay_root(upstream) {
            Ok(n) => n,
            Err(_) => {
                tracing::warn!(
                    upstream,
                    "gateway manifest upstream is not a URL — degrading to the built-in root"
                );
                return Ok(legacy_resolution(&initial));
            },
        };
        if seen.contains(&next) {
            tracing::warn!("gateway manifest upstream cycle — degrading to the built-in root");
            return Ok(legacy_resolution(&initial));
        }
        seen.push(next.clone());
        current = next;
        via_upstream = true;
    }
    tracing::warn!(
        "gateway manifest chain exceeds the hop budget — degrading to the built-in root"
    );
    Ok(legacy_resolution(&initial))
}

/// Validate the FINAL health document (minimum-version gate + protocol
/// check + endpoint resolution).
pub(super) fn finish_resolution(
    root: &str,
    manifest: GatewayManifest,
    via_upstream: bool,
) -> Result<GatewayResolution, String> {
    // The version gate runs FIRST: a too-old app must hear "update the
    // app", never a protocol/endpoint complaint it cannot act on.
    if let Some(min) = manifest
        .min_client_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !client_meets_minimum(env!("CARGO_PKG_VERSION"), min) {
            tracing::warn!(
                client = env!("CARGO_PKG_VERSION"),
                minimum = min,
                "the pairing gateway demands a newer client"
            );
            return Err(CLIENT_TOO_OLD.to_string());
        }
    }
    if !manifest
        .protocol
        .iter()
        .any(|p| p.eq_ignore_ascii_case("v1"))
    {
        tracing::warn!(
            protocol = ?manifest.protocol,
            "the resolved gateway speaks an unsupported pairing protocol"
        );
        return Err(UNSUPPORTED_PROTOCOL.to_string());
    }
    match resolve_relay_endpoint(root, &manifest.endpoints.relay) {
        Ok(ws_base) => Ok(GatewayResolution {
            ws_base,
            manifest: Some(manifest),
            via_upstream,
        }),
        Err(e) => {
            tracing::warn!(error = %e, "manifest relay endpoint unusable — legacy direct mode");
            Ok(legacy_resolution(root))
        },
    }
}

struct CachedResolution {
    res: GatewayResolution,
    at: std::time::Instant,
}

fn resolution_cache() -> &'static Mutex<HashMap<String, CachedResolution>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedResolution>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the gateway ONCE per pairing session: successes are cached for
/// [`RESOLUTION_TTL`] keyed by the normalized root, so every relay operation
/// of a session dials the same resolved endpoint without re-fetching the
/// manifest. Failures (unsupported protocol) are never cached — they must
/// surface on every call.
pub async fn resolve_gateway_cached(root: &str) -> Result<GatewayResolution, String> {
    let key = normalize_relay_root(root)?;
    if let Ok(cache) = resolution_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            if hit.at.elapsed() < RESOLUTION_TTL {
                return Ok(hit.res.clone());
            }
        }
    }
    let res = resolve_gateway(&key).await?;
    if let Ok(mut cache) = resolution_cache().lock() {
        cache.insert(
            key,
            CachedResolution {
                res: res.clone(),
                at: std::time::Instant::now(),
            },
        );
    }
    Ok(res)
}

/// Test surface: drop cached resolutions so a later test binding the same
/// loopback port re-resolves against its own mock.
#[cfg(test)]
pub(super) fn clear_resolution_cache_for_test() {
    if let Ok(mut cache) = resolution_cache().lock() {
        cache.clear();
    }
}
