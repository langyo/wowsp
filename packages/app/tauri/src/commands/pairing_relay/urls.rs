use anyhow::{Result, anyhow};

use super::*;
// ── URL / key helpers (all targets, pure) ────────────────────────────────────

/// The gateway ROOT the desktop bridge resolves: the built-in constant
/// unless the development override (`WOWSP_RELAY_URL`, debug builds ONLY
/// — a release build ignores the variable so a compromised environment
/// cannot retarget production pairing) is set to a non-empty value.
pub fn builtin_relay_root() -> String {
    #[cfg(debug_assertions)]
    {
        builtin_relay_root_from(std::env::var(RELAY_URL_ENV).ok().as_deref())
    }
    #[cfg(not(debug_assertions))]
    {
        builtin_relay_root_from(None)
    }
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

/// Host of an already-normalized `<scheme>host[:port][/path][?query]`
/// URL, port and path stripped (bracket-aware for IPv6 literals).
fn host_of_url(url: &str) -> &str {
    let authority = url.split(['/', '?']).next().unwrap_or("");
    match authority.rfind(':') {
        // A colon outside the brackets is the port separator.
        Some(pos) if !authority.starts_with('[') || authority[..pos].contains(']') => {
            &authority[..pos]
        },
        _ => authority,
    }
}

/// M-5b: the loopback hosts a PLAIN-TEXT gateway is tolerated on
/// (development against `wrangler dev` — any port). Everything else
/// must ride TLS.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.eq_ignore_ascii_case("localhost") || bare == "127.0.0.1" || bare == "::1"
}

/// M-5b: an http(s) gateway ROOT is https-only, except plain http on an
/// explicit loopback host (dev convenience). Runs on every parse AND on
/// every defaulted/derived root before it is used.
fn enforce_https_root(root: &str, raw: &str) -> Result<String> {
    if let Some(rest) = root.strip_prefix("http://") {
        if !is_loopback_host(host_of_url(rest)) {
            return Err(anyhow!(
                "relay root must be https:// (plain http only for loopback dev): {raw}"
            ));
        }
    }
    Ok(root.to_string())
}

/// M-5b: the ws(s) tunnel base is wss-only, except plain ws on an
/// explicit loopback host. The scheme probe is case-insensitive (a
/// `WS://` spelling must not slip past the `ws://` strip — audit review)
/// and the rejected/rebuilt form carries the original casing.
fn enforce_wss_base(ws_base: &str, raw: &str) -> Result<String> {
    let Some(rest) = ws_base.strip_prefix("ws://").or_else(|| {
        ws_base
            .get(..5)
            .filter(|head| head.eq_ignore_ascii_case("ws://"))
            .and_then(|_| ws_base.get(5..))
    }) else {
        return Ok(ws_base.to_string());
    };
    if !is_loopback_host(host_of_url(rest)) {
        return Err(anyhow!(
            "relay WebSocket base must be wss:// (plain ws only for loopback dev): {raw}"
        ));
    }
    let mut out = String::with_capacity(ws_base.len());
    out.push_str("ws://");
    out.push_str(rest);
    Ok(out)
}

/// Normalize any plausible gateway URL into its http(s) ROOT form (the
/// health document is fetched from `<root>/api/health`): `wss:`→`https:`,
/// `ws:`→`http:`, a bare host gets `https://`. A path prefix on the root is
/// allowed (routed gateways). M-5b: https is ENFORCED — plain http is
/// accepted only on explicit loopback hosts (any port, dev convenience).
/// Returns Err on anything that cannot be a gateway origin.
pub fn normalize_relay_root(raw: &str) -> Result<String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(anyhow!("relay URL is empty"));
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
        return Err(anyhow!("unsupported relay URL scheme: {raw}"));
    } else {
        format!("https://{}", url.trim_end_matches('/'))
    };
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty()
        || after_scheme.starts_with('?')
        || after_scheme.starts_with('/')
        || after_scheme.contains("://")
    {
        return Err(anyhow!("unsupported relay URL: {raw}"));
    }
    enforce_https_root(&out, raw)
}

/// Turn a worker URL into the WebSocket base the tunnels dial: trim, strip a
/// trailing slash, and map the scheme (`https:` → `wss:`, `http:` → `ws:`;
/// a bare host gets `wss:`). M-5b: wss is ENFORCED — plain ws is accepted
/// only on explicit loopback hosts (any port, dev convenience). Returns
/// Err on anything that cannot plausibly be a worker origin.
pub fn normalize_relay_ws_url(raw: &str) -> Result<String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(anyhow!("relay URL is empty"));
    }
    let lowered = url.to_ascii_lowercase();
    let out = if let Some(rest) = lowered.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = lowered.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if lowered.starts_with("wss://") || lowered.starts_with("ws://") {
        url.to_string()
    } else if lowered.contains("://") || lowered.starts_with('/') {
        return Err(anyhow!("unsupported relay URL scheme: {raw}"));
    } else {
        format!("wss://{url}")
    };
    // A path prefix is allowed (workers can be routed behind a custom
    // domain path) as long as it stays path-shaped.
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty() || after_scheme.starts_with('?') || after_scheme.contains("://") {
        return Err(anyhow!("unsupported relay URL: {raw}"));
    }
    enforce_wss_base(&out, raw)
}

/// The legacy direct-mode WebSocket base of an (already normalized)
/// root: the relay routes live under `/api/relay` on the same origin.
/// PRECONDITION: `root` went through [`normalize_relay_root`] (or is the
/// built-in constant) — its scheme is already TLS-enforced, so the
/// derived base is plain ws only when the root itself is loopback.
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
/// WebSocket-only). M-5b: wss is ENFORCED on the resolved endpoint —
/// plain ws only on explicit loopback hosts (dev convenience), whatever
/// the manifest asked for.
pub(super) fn resolve_relay_endpoint(root: &str, relay: &str) -> Result<String> {
    let relay = relay.trim();
    if relay.is_empty() {
        return Err(anyhow!("manifest has no relay endpoint"));
    }
    if let Some(rest) = strip_scheme_ci(relay, "wss://") {
        return Ok(format!("wss://{rest}"));
    }
    if let Some(rest) = strip_scheme_ci(relay, "ws://") {
        return enforce_wss_base(&format!("ws://{rest}"), relay);
    }
    if !relay.starts_with('/') {
        return Err(anyhow!(
            "manifest relay endpoint must be a wss URL or a path: {relay}"
        ));
    }
    let after_scheme = root.split_once("://").map(|(_, r)| r).unwrap_or(root);
    let host = after_scheme.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(anyhow!("malformed gateway root: {root}"));
    }
    let scheme = if root.starts_with("https://") {
        "wss"
    } else {
        "ws"
    };
    enforce_wss_base(&format!("{scheme}://{host}{relay}"), relay)
}

/// Random 16-hex-char connection id (OS CSPRNG — getrandom is a direct dep
/// on every target).
pub(super) fn conn_id() -> Result<String> {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}

/// A pairing code the phone enters must be exactly 6 digits.
/// `pub(crate)` so the pairing server can shape-gate the
/// gateway-assigned code too (M-5a, re-exported as
/// `valid_pairing_code`).
pub(crate) fn valid_code(code: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── M-5b: https/wss enforcement, loopback-only exception ──────────

    #[test]
    fn relay_roots_enforce_https_except_loopback() {
        // Loopback keeps plain http in any spelling, any port.
        assert_eq!(
            normalize_relay_root("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_relay_root("ws://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_relay_root("http://[::1]:8787").unwrap(),
            "http://[::1]:8787"
        );
        // Non-loopback plain text is refused…
        assert!(normalize_relay_root("http://gw.example.org").is_err());
        assert!(normalize_relay_root("ws://gw.example.org:8787").is_err());
        assert!(normalize_relay_root("http://203.0.113.7:8787").is_err());
        assert!(normalize_relay_root("ws://192.0.2.10").is_err());
        // …while TLS forms of the same hosts pass.
        assert_eq!(
            normalize_relay_root("https://gw.example.org").unwrap(),
            "https://gw.example.org"
        );
        assert_eq!(
            normalize_relay_root("wss://gw.example.org:8787").unwrap(),
            "https://gw.example.org:8787"
        );
        // Bare hosts default to https (safe default).
        assert_eq!(
            normalize_relay_root("gw.example.org").unwrap(),
            "https://gw.example.org"
        );
    }

    #[test]
    fn relay_ws_bases_enforce_wss_except_loopback() {
        // Loopback keeps plain ws.
        assert_eq!(
            normalize_relay_ws_url("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_relay_ws_url("ws://localhost:9000").unwrap(),
            "ws://localhost:9000"
        );
        // Non-loopback plain text is refused…
        assert!(normalize_relay_ws_url("http://gw.example.org").is_err());
        assert!(normalize_relay_ws_url("ws://gw.example.org:8787").is_err());
        assert!(normalize_relay_ws_url("ws://203.0.113.7:8787").is_err());
        // …while TLS forms pass.
        assert_eq!(
            normalize_relay_ws_url("https://gw.example.org").unwrap(),
            "wss://gw.example.org"
        );
        assert_eq!(
            normalize_relay_ws_url("wss://gw.example.org/x").unwrap(),
            "wss://gw.example.org/x"
        );
    }

    #[test]
    fn manifest_relay_endpoints_enforce_wss_except_loopback() {
        // Absolute plain-ws endpoint on a non-loopback host: refused —
        // even though the serving root itself was TLS.
        assert!(resolve_relay_endpoint("https://gw.example.org", "ws://rebind.example/x").is_err());
        assert!(resolve_relay_endpoint("https://gw.example.org", "ws://203.0.113.7:9000").is_err());
        // Loopback absolute ws stays allowed (dev gateways).
        assert_eq!(
            resolve_relay_endpoint("https://gw.example.org", "ws://127.0.0.1:9000").unwrap(),
            "ws://127.0.0.1:9000"
        );
        // Path form follows the root's scheme: https root → wss, and a
        // loopback http root keeps ws.
        assert_eq!(
            resolve_relay_endpoint("https://gw.example.org", "/relay-ws").unwrap(),
            "wss://gw.example.org/relay-ws"
        );
        assert_eq!(
            resolve_relay_endpoint("http://127.0.0.1:8787", "/relay-ws").unwrap(),
            "ws://127.0.0.1:8787/relay-ws"
        );
    }

    #[test]
    fn loopback_host_detection_is_exact() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LOCALHOST"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("127.0.0.2"));
        assert!(!is_loopback_host("localhost.example.org"));
        assert!(!is_loopback_host("203.0.113.7"));
        assert!(!is_loopback_host(""));
    }

    #[test]
    fn wss_enforcement_is_scheme_case_insensitive() {
        // Audit review: a `WS://` spelling must not slip past the plain-ws
        // gate via the case-sensitive prefix strip.
        assert!(enforce_wss_base("WS://evil.example:9000", "raw").is_err());
        assert!(enforce_wss_base("wS://evil.example:9000", "raw").is_err());
        // Loopback plain ws keeps working (any spelling), rebuilt lowercase.
        assert_eq!(
            enforce_wss_base("WS://127.0.0.1:9000", "raw").unwrap(),
            "ws://127.0.0.1:9000"
        );
        // Already-secure forms pass through untouched.
        assert_eq!(
            enforce_wss_base("wss://evil.example:9000", "raw").unwrap(),
            "wss://evil.example:9000"
        );
    }

    #[test]
    fn host_of_url_strips_port_and_path() {
        assert_eq!(host_of_url("gw.example.org:8787/x"), "gw.example.org");
        assert_eq!(host_of_url("gw.example.org/x"), "gw.example.org");
        assert_eq!(host_of_url("127.0.0.1:8787"), "127.0.0.1");
        assert_eq!(host_of_url("[::1]:8787"), "[::1]");
        assert_eq!(host_of_url("[::1]"), "[::1]");
    }

    // ── M-5a: the code shape gate shared with the server ─────────────

    #[test]
    fn valid_code_is_exactly_six_ascii_digits() {
        assert!(valid_code("000000"));
        assert!(valid_code("987654"));
        // Near misses the gateway must never get away with.
        assert!(!valid_code("12345"));
        assert!(!valid_code("1234567"));
        assert!(!valid_code("12a456"));
        assert!(!valid_code("123456 "));
        assert!(!valid_code("۱۲۳۴۵۶")); // Eastern-Arabic digits are not ASCII
        assert!(!valid_code(" 12345"));
        assert!(!valid_code(""));
    }
}
