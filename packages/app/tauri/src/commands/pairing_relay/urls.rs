use super::*;
// ── URL / key helpers (all targets, pure) ────────────────────────────────────

/// The gateway ROOT the desktop bridge resolves: the built-in constant
/// unless the development override (`WOWSP_RELAY_URL`) is set to a
/// non-empty value.
pub fn builtin_relay_root() -> String {
    builtin_relay_root_from(std::env::var(RELAY_URL_ENV).ok().as_deref())
}

/// Pure core of [`builtin_relay_root`] (testable without touching the
/// process environment). An unusable override falls back to the built-in
/// root rather than erroring — a bad dev var must not break pairing.
pub(super) fn builtin_relay_root_from(override_raw: Option<&str>) -> String {
    match override_raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            normalize_relay_root(raw).unwrap_or_else(|_| BUILTIN_RELAY_ROOT_URL.to_string())
        },
        None => BUILTIN_RELAY_ROOT_URL.to_string(),
    }
}

/// Case-insensitive scheme strip (keeps the rest of the URL verbatim).
fn strip_scheme_ci<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    (url.len() >= scheme.len() && url[..scheme.len()].eq_ignore_ascii_case(scheme))
        .then(|| &url[scheme.len()..])
}

/// Normalize any plausible gateway URL into its http(s) ROOT form (the
/// health document is fetched from `<root>/api/health`): `wss:`→`https:`,
/// `ws:`→`http:`, a bare host gets `https://`. A path prefix on the root is
/// allowed (routed gateways). Returns Err on anything that cannot be a
/// gateway origin.
pub fn normalize_relay_root(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("relay URL is empty".to_string());
    }
    let out = if let Some(rest) = strip_scheme_ci(url, "https://") {
        format!("https://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = strip_scheme_ci(url, "wss://") {
        format!("https://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = strip_scheme_ci(url, "http://") {
        format!("http://{}", rest.trim_end_matches('/'))
    } else if let Some(rest) = strip_scheme_ci(url, "ws://") {
        format!("http://{}", rest.trim_end_matches('/'))
    } else if url.contains("://") || url.starts_with('/') {
        return Err(format!("unsupported relay URL scheme: {raw}"));
    } else {
        format!("https://{}", url.trim_end_matches('/'))
    };
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty()
        || after_scheme.starts_with('?')
        || after_scheme.starts_with('/')
        || after_scheme.contains("://")
    {
        return Err(format!("unsupported relay URL: {raw}"));
    }
    Ok(out)
}

/// Turn a worker URL into the WebSocket base the tunnels dial: trim, strip a
/// trailing slash, and map the scheme (`https:` → `wss:`, `http:` → `ws:`;
/// a bare host gets `wss:`). Returns Err on anything that cannot plausibly
/// be a worker origin.
pub fn normalize_relay_ws_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("relay URL is empty".to_string());
    }
    let lowered = url.to_ascii_lowercase();
    let out = if let Some(rest) = lowered.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = lowered.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if lowered.starts_with("wss://") || lowered.starts_with("ws://") {
        url.to_string()
    } else if lowered.contains("://") || lowered.starts_with('/') {
        return Err(format!("unsupported relay URL scheme: {raw}"));
    } else {
        format!("wss://{url}")
    };
    // A path prefix is allowed (workers can be routed behind a custom
    // domain path) as long as it stays path-shaped.
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty() || after_scheme.starts_with('?') || after_scheme.contains("://") {
        return Err(format!("unsupported relay URL: {raw}"));
    }
    Ok(out)
}

/// The legacy direct-mode WebSocket base of an (already normalized)
/// root: the relay routes live under `/api/relay` on the same origin.
pub(super) fn ws_base_of_root(root: &str) -> String {
    let base = if let Some(rest) = root.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = root.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("ws://{root}")
    };
    format!("{base}/api/relay")
}

/// Resolve the final manifest's `endpoints.relay` against the root it was
/// served from: a path becomes `<ws-scheme>://<root host><path>` (any path
/// prefix on the root is REPLACED — the endpoint addresses the host), an
/// absolute URL must already be ws/wss (the tunneled protocol is
/// WebSocket-only; `wss` in production, `ws` tolerated for local
/// development against plain loopback gateways).
pub(super) fn resolve_relay_endpoint(root: &str, relay: &str) -> Result<String, String> {
    let relay = relay.trim();
    if relay.is_empty() {
        return Err("manifest has no relay endpoint".to_string());
    }
    if let Some(rest) = strip_scheme_ci(relay, "wss://") {
        return Ok(format!("wss://{rest}"));
    }
    if let Some(rest) = strip_scheme_ci(relay, "ws://") {
        return Ok(format!("ws://{rest}"));
    }
    if !relay.starts_with('/') {
        return Err(format!(
            "manifest relay endpoint must be a wss URL or a path: {relay}"
        ));
    }
    let after_scheme = root.split_once("://").map(|(_, r)| r).unwrap_or(root);
    let host = after_scheme.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(format!("malformed gateway root: {root}"));
    }
    let scheme = if root.starts_with("https://") {
        "wss"
    } else {
        "ws"
    };
    Ok(format!("{scheme}://{host}{relay}"))
}

/// Random 16-hex-char connection id (OS CSPRNG — getrandom is a direct dep
/// on every target).
pub(super) fn conn_id() -> Result<String, String> {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| format!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}

/// A pairing code the phone enters must be exactly 6 digits.
pub(super) fn valid_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

pub(super) fn control_url(ws_base: &str, room: &str, role: &str) -> String {
    format!("{ws_base}/control?room={room}&role={role}")
}

pub(super) fn data_url(ws_base: &str, room: &str, conn: &str, side: &str) -> String {
    format!("{ws_base}/data/{room}?conn={conn}&side={side}")
}

/// Validate a room key before it may appear in a URL (the worker enforces
/// the same shape: 64 lowercase hex).
pub(super) fn valid_room(room: &str) -> bool {
    room.len() == 64
        && room
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
