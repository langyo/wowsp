use anyhow::{Result, anyhow};

// ── URL helpers (all targets, pure) — moved from the retired
//    commands/pairing_relay/urls.rs when the PIN pairing mode went
//    away; the gateway push, the digest/sponsor/share HTTP clients and
//    the WebSocket dialer all key off this one policy. ─────────────────

/// The ROOT of the official wowsp.langyo.xyz worker deployment — the
/// host that serves the gateway push namespace (/gateway/*), the release
/// digests, the sponsor list and the replay-share endpoints. Shared by
/// every first-party HTTP client that talks to the site.
pub const BUILTIN_WORKER_ROOT_URL: &str = "https://wowsp.langyo.xyz";

/// Undocumented DEVELOPMENT override for the worker root (never
/// surfaced in any UI). Consulted in DEBUG builds only — a release
/// build always talks to the built-in root, whatever the environment
/// says.
pub const WORKER_ROOT_ENV: &str = "WOWSP_RELAY_URL";

/// The worker root the app talks to: the built-in constant unless the
/// development override (WORKER_ROOT_ENV, debug builds ONLY — a release
/// build ignores the variable so a compromised environment cannot
/// retarget production traffic) is set to a non-empty value.
pub fn builtin_worker_root() -> String {
    #[cfg(debug_assertions)]
    {
        builtin_worker_root_from(std::env::var(WORKER_ROOT_ENV).ok().as_deref())
    }
    #[cfg(not(debug_assertions))]
    {
        builtin_worker_root_from(None)
    }
}

/// Pure core of [`builtin_worker_root`] (testable without touching the
/// process environment). An unusable override falls back to the built-in
/// root rather than erroring — a bad dev var must not break the client.
pub(super) fn builtin_worker_root_from(override_raw: Option<&str>) -> String {
    match override_raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            normalize_https_root(raw).unwrap_or_else(|_| BUILTIN_WORKER_ROOT_URL.to_string())
        },
        None => BUILTIN_WORKER_ROOT_URL.to_string(),
    }
}

/// Case-insensitive scheme strip (keeps the rest of the URL verbatim).
fn strip_scheme_ci<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    (url.len() >= scheme.len() && url[..scheme.len()].eq_ignore_ascii_case(scheme))
        .then(|| &url[scheme.len()..])
}

/// Host of an already-normalized `<scheme>host[:port][/path][?query]`
/// URL, port and path stripped (bracket-aware for IPv6 literals).
///
/// Review M-4: an authority carrying USERINFO (`host:port@evil`) is
/// rejected outright (empty host — never loopback, so every https-only
/// gate refuses it) instead of being sliced at the colon: reqwest would
/// resolve the post-`@` host, so `http://127.0.0.1:80@evil` used to
/// pass the loopback plain-text exception while dialing `evil`.
fn host_of_url(url: &str) -> &str {
    let authority = url.split(['/', '?']).next().unwrap_or("");
    if authority.contains('@') {
        return "";
    }
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
                "gateway root must be https:// (plain http only for loopback dev): {raw}"
            ));
        }
    }
    Ok(root.to_string())
}

/// M-5b: the ws(s) socket base is wss-only, except plain ws on an
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
            "gateway WebSocket base must be wss:// (plain ws only for loopback dev): {raw}"
        ));
    }
    let mut out = String::with_capacity(ws_base.len());
    out.push_str("ws://");
    out.push_str(rest);
    Ok(out)
}

/// Normalize any plausible gateway URL into its http(s) ROOT form:
/// `wss:`→`https:`, `ws:`→`http:`, a bare host gets `https://`. A path
/// prefix on the root is allowed (routed gateways — the official entry
/// lives under /gateway/). M-5b: https is ENFORCED — plain http is
/// accepted only on explicit loopback hosts (any port, dev convenience).
/// Returns Err on anything that cannot be a gateway origin.
pub(super) fn normalize_https_root(raw: &str) -> Result<String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(anyhow!("gateway URL is empty"));
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
        return Err(anyhow!("unsupported gateway URL scheme: {raw}"));
    } else {
        format!("https://{}", url.trim_end_matches('/'))
    };
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty()
        || after_scheme.starts_with('?')
        || after_scheme.starts_with('/')
        || after_scheme.contains("://")
    {
        return Err(anyhow!("unsupported gateway URL: {raw}"));
    }
    enforce_https_root(&out, raw)
}

/// Turn a gateway root into the WebSocket base the sockets dial: trim,
/// strip a trailing slash, and map the scheme (`https:` → `wss:`,
/// `http:` → `ws:`; a bare host gets `wss:`). M-5b: wss is ENFORCED —
/// plain ws is accepted only on explicit loopback hosts (any port, dev
/// convenience). Returns Err on anything that cannot plausibly be a
/// gateway origin.
pub(super) fn normalize_ws_base(raw: &str) -> Result<String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(anyhow!("gateway URL is empty"));
    }
    let lowered = url.to_ascii_lowercase();
    let out = if let Some(rest) = lowered.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = lowered.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if lowered.starts_with("wss://") || lowered.starts_with("ws://") {
        url.to_string()
    } else if lowered.contains("://") || lowered.starts_with('/') {
        return Err(anyhow!("unsupported gateway URL scheme: {raw}"));
    } else {
        format!("wss://{url}")
    };
    // A path prefix is allowed (workers can be routed behind a custom
    // domain path) as long as it stays path-shaped.
    let after_scheme = out.split_once("://").map(|(_, r)| r).unwrap_or(&out);
    if after_scheme.is_empty() || after_scheme.starts_with('?') || after_scheme.contains("://") {
        return Err(anyhow!("unsupported gateway URL: {raw}"));
    }
    enforce_wss_base(&out, raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── M-5b: https/wss enforcement, loopback-only exception ──────────

    #[test]
    fn gateway_roots_enforce_https_except_loopback() {
        // Loopback keeps plain http in any spelling, any port.
        assert_eq!(
            normalize_https_root("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_https_root("ws://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_https_root("http://[::1]:8787").unwrap(),
            "http://[::1]:8787"
        );
        // Non-loopback plain text is refused…
        assert!(normalize_https_root("http://gw.example.org").is_err());
        assert!(normalize_https_root("ws://gw.example.org:8787").is_err());
        assert!(normalize_https_root("http://203.0.113.7:8787").is_err());
        assert!(normalize_https_root("ws://192.0.2.10").is_err());
        // …while TLS forms of the same hosts pass.
        assert_eq!(
            normalize_https_root("https://gw.example.org").unwrap(),
            "https://gw.example.org"
        );
        assert_eq!(
            normalize_https_root("wss://gw.example.org:8787").unwrap(),
            "https://gw.example.org:8787"
        );
        // Bare hosts default to https (safe default).
        assert_eq!(
            normalize_https_root("gw.example.org").unwrap(),
            "https://gw.example.org"
        );
    }

    #[test]
    fn gateway_ws_bases_enforce_wss_except_loopback() {
        // Loopback keeps plain ws.
        assert_eq!(
            normalize_ws_base("http://127.0.0.1:8787").unwrap(),
            "ws://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_ws_base("ws://localhost:9000").unwrap(),
            "ws://localhost:9000"
        );
        // Non-loopback plain text is refused…
        assert!(normalize_ws_base("http://gw.example.org").is_err());
        assert!(normalize_ws_base("ws://gw.example.org:8787").is_err());
        assert!(normalize_ws_base("ws://203.0.113.7:8787").is_err());
        // …while TLS forms pass.
        assert_eq!(
            normalize_ws_base("https://gw.example.org").unwrap(),
            "wss://gw.example.org"
        );
        assert_eq!(
            normalize_ws_base("wss://gw.example.org/x").unwrap(),
            "wss://gw.example.org/x"
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

    /// Review M-4: userinfo in the authority (`host:port@evil`) must not
    /// slice into a loopback-looking host — reqwest dials the post-`@`
    /// host, so `127.0.0.1:80@evil` used to pass the plain-text loopback
    /// exception while dialing `evil`. The empty host never matches
    /// loopback: every https-only gate refuses the URL.
    #[test]
    fn host_of_url_rejects_userinfo_authorities() {
        assert_eq!(host_of_url("127.0.0.1:80@evil.example"), "");
        assert_eq!(host_of_url("user@gw.example.org"), "");
        assert_eq!(host_of_url("user:pass@gw.example.org:8787/x"), "");
        // …and the refusal propagates into the https-only gate.
        assert!(enforce_https_root("http://127.0.0.1:80@evil.example", "raw").is_err());
    }

    #[test]
    fn builtin_worker_root_override_falls_back_cleanly() {
        assert_eq!(builtin_worker_root_from(None), "https://wowsp.langyo.xyz");
        assert_eq!(
            builtin_worker_root_from(Some("")),
            "https://wowsp.langyo.xyz"
        );
        assert_eq!(
            builtin_worker_root_from(Some("   ")),
            "https://wowsp.langyo.xyz"
        );
        // Debug-shaped overrides are honored (loopback wrangler dev).
        assert_eq!(
            builtin_worker_root_from(Some("ws://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            builtin_worker_root_from(Some("http://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
        // Unusable overrides fall back to the built-in root.
        assert_eq!(
            builtin_worker_root_from(Some("ftp://nope")),
            "https://wowsp.langyo.xyz"
        );
    }
}
