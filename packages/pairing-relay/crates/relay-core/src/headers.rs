//! Security response header policy for every response this gateway
//! sends to a browser. Pure data: `relay-worker` (the wasm shell) reads
//! [`security_headers`] at its single response-exit point and copies the
//! pairs onto the outgoing response, so the matrix below is the single
//! source of truth and unit-tested here on the host.
//!
//! Scope decisions (see the worker crate's exit wrapper for the kind
//! detection):
//! - `Content-Security-Policy` + `X-Frame-Options` go on **HTML document
//!   responses only** (`/feedback`, `/erp` — every HTML this worker
//!   constructs). They are meaningless on JSON/WebSocket payloads and
//!   MUST NOT ride the `101` WebSocket upgrade.
//! - `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`
//!   go on **every** worker response, `/api` included.
//! - The static site shell (`/` and every SPA path) never reaches this
//!   code — wrangler serves it from the `[assets]` layer, which carries
//!   the same matrix via the bundled `_headers` file
//!   (packages/website/src/res/_headers).
//!
//! `'unsafe-inline'` in `script-src` is a known, documented residue: the
//! site shell ships a build-time-injected inline fallback loader whose
//! entry hash changes per build, so hash-based CSP is not workable
//! today; moving the loader off inline is a follow-up.

/// CSP for HTML document responses.
///
/// Allowances beyond `'self'`, each tied to one real resource:
/// - `https://langyo.github.io` — the built entry module + stylesheets
///   load from the GitHub Pages mirror first (the loader's candidate
///   chain; see scripts/build_worker_site.py).
/// - `https://www.googletagmanager.com` — the gtag.js script tag in
///   packages/website/index.html.
/// - `https://*.google-analytics.com` / `https://*.analytics.google.com`
///   — gtag's measurement beacons (`connect-src`).
/// - `wss://wowsp.langyo.xyz` — the pairing sockets a browser visitor
///   may open from the site.
/// - `https://challenges.cloudflare.com` — the Turnstile widget on
///   /feedback: its `api.js` (script), the challenge iframe (frame-src,
///   which would otherwise fall back to `default-src 'self'` and break
///   the form) and its client-side challenge fetches (connect-src).
/// - `'unsafe-inline'` (script + style) — the /feedback and /erp pages
///   and the shell's fallback loader are inline by design today.
pub const CSP_HTML: &str = "default-src 'self'; \
script-src 'self' https://langyo.github.io https://www.googletagmanager.com https://challenges.cloudflare.com 'unsafe-inline'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: https://langyo.github.io; \
connect-src 'self' wss://wowsp.langyo.xyz https://*.google-analytics.com https://*.analytics.google.com https://challenges.cloudflare.com; \
frame-src https://challenges.cloudflare.com; \
object-src 'none'; \
base-uri 'self'; \
form-action 'self'; \
frame-ancestors 'none'";

/// Old browsers that never understood CSP `frame-ancestors` (kept in
/// sync with it). Nothing embeds /feedback or /erp in a frame: the
/// desktop app POSTs submissions directly and never iframes the page.
pub const X_FRAME_OPTIONS: &str = "DENY";

/// MIME-sniffing is never useful on our responses (JSON/HTML only).
pub const X_CONTENT_TYPE_OPTIONS: &str = "nosniff";

/// Referer leakage is bounded to the origin granularity everywhere.
pub const REFERRER_POLICY: &str = "strict-origin-when-cross-origin";

/// No page this gateway serves needs powerful platform features.
pub const PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=()";

/// Which of the two header rows applies. `WebsocketUpgrade` responses
/// pass through untouched — the `101` handshake must stay byte-identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseKind {
    /// An HTML document (/feedback, /erp): full matrix.
    HtmlDocument,
    /// Everything else the worker answers (/api JSON, redirects, errors).
    Other,
    /// A completed WebSocket handshake (status 101) — no decoration.
    WebsocketUpgrade,
}

/// The header pairs to copy onto a response of `kind`, in stable order.
/// Empty for WebSocket upgrades.
pub fn security_headers(kind: ResponseKind) -> &'static [(&'static str, &'static str)] {
    const COMMON: &[(&str, &str)] = &[
        ("X-Content-Type-Options", X_CONTENT_TYPE_OPTIONS),
        ("Referrer-Policy", REFERRER_POLICY),
        ("Permissions-Policy", PERMISSIONS_POLICY),
    ];
    match kind {
        ResponseKind::WebsocketUpgrade => &[],
        ResponseKind::Other => COMMON,
        ResponseKind::HtmlDocument => &[
            ("Content-Security-Policy", CSP_HTML),
            ("X-Frame-Options", X_FRAME_OPTIONS),
            ("X-Content-Type-Options", X_CONTENT_TYPE_OPTIONS),
            ("Referrer-Policy", REFERRER_POLICY),
            ("Permissions-Policy", PERMISSIONS_POLICY),
        ],
    }
}

/// The response kind for a status + Content-Type pair as observed at the
/// worker's single exit point (kept here so the detection rules are
/// unit-tested too: `101` is the ONLY WebSocket shape we answer with).
pub fn response_kind(status: u16, content_type: Option<&str>) -> ResponseKind {
    if status == 101 {
        return ResponseKind::WebsocketUpgrade;
    }
    match content_type {
        Some(ct)
            if ct
                .to_ascii_lowercase()
                .trim_start()
                .starts_with("text/html") =>
        {
            ResponseKind::HtmlDocument
        },
        _ => ResponseKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The /feedback and /erp HTML pages carry the full matrix: CSP,
    /// XFO and the three universal headers — nothing more, nothing less.
    #[test]
    fn html_documents_carry_the_full_matrix() {
        let got = security_headers(response_kind(200, Some("text/html; charset=utf-8")));
        let names: Vec<&str> = got.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            names,
            [
                "Content-Security-Policy",
                "X-Frame-Options",
                "X-Content-Type-Options",
                "Referrer-Policy",
                "Permissions-Policy",
            ]
        );
        let csp = got
            .iter()
            .find(|(k, _)| *k == "Content-Security-Policy")
            .unwrap()
            .1;
        for directive in [
            "default-src 'self'",
            "script-src 'self' https://langyo.github.io https://www.googletagmanager.com https://challenges.cloudflare.com 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https://langyo.github.io",
            "connect-src 'self' wss://wowsp.langyo.xyz https://*.google-analytics.com https://*.analytics.google.com https://challenges.cloudflare.com",
            "frame-src https://challenges.cloudflare.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive), "CSP missing `{directive}`: {csp}");
        }
        let by_name = |name: &str| got.iter().find(|(k, _)| *k == name).unwrap().1;
        assert_eq!(by_name("X-Frame-Options"), "DENY");
        assert_eq!(by_name("X-Content-Type-Options"), "nosniff");
        assert_eq!(
            by_name("Referrer-Policy"),
            "strict-origin-when-cross-origin"
        );
        assert_eq!(
            by_name("Permissions-Policy"),
            "camera=(), microphone=(), geolocation=()"
        );
    }

    /// /api JSON (health, feedback pipeline, errors) carries the three
    /// universal headers and NO CSP / X-Frame-Options.
    #[test]
    fn api_json_carries_the_universal_headers_only() {
        let got = security_headers(response_kind(200, Some("application/json")));
        let names: Vec<&str> = got.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            names,
            [
                "X-Content-Type-Options",
                "Referrer-Policy",
                "Permissions-Policy",
            ]
        );
        assert!(!names.contains(&"Content-Security-Policy"));
        assert!(!names.contains(&"X-Frame-Options"));
        // The JSON error rows (4xx/5xx) decorate the same way.
        assert_eq!(
            security_headers(response_kind(404, Some("application/json"))).len(),
            3
        );
    }

    /// Redirects (302 /docs, attachment hand-off) decorate like /api.
    #[test]
    fn redirects_carry_the_universal_headers() {
        assert_eq!(security_headers(response_kind(302, None)).len(), 3);
    }

    /// The WebSocket upgrade (the resolve + control + data handshakes,
    /// the latter forwarded from the Room DO) passes through untouched —
    /// header decoration on the 101 must be a no-op.
    #[test]
    fn websocket_upgrades_are_untouched() {
        assert!(security_headers(ResponseKind::WebsocketUpgrade).is_empty());
        assert_eq!(
            response_kind(101, Some("text/html")),
            ResponseKind::WebsocketUpgrade
        );
        assert_eq!(response_kind(101, None), ResponseKind::WebsocketUpgrade);
    }

    /// The static shell's `_headers` file (packages/website/src/res —
    /// the website build's publicDir, bundled into the worker's assets
    /// dir) must carry the SAME CSP as [`CSP_HTML`] — one matrix, two
    /// serving layers (the static shell never reaches this crate at
    /// runtime). This test fails loudly on drift between the two.
    #[test]
    fn static_shell_headers_file_matches_the_worker_csp() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../website/src/res/_headers");
        let text = std::fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", file.display()));
        let mut csp_lines = text
            .lines()
            .filter(|l| l.trim_start().starts_with("Content-Security-Policy:"))
            .map(|l| {
                l.trim()
                    .strip_prefix("Content-Security-Policy:")
                    .unwrap()
                    .trim()
            });
        let shell_csp = csp_lines.next().expect("_headers CSP row");
        assert!(
            csp_lines.next().is_none(),
            "more than one CSP row in _headers"
        );
        // Compare against the EMITTED matrix (not the bare constant) so
        // this test also goes red when `security_headers` itself is
        // mutated — the file must track whatever the worker actually
        // sends. (The constant vs matrix equality is asserted by
        // `html_documents_carry_the_full_matrix`.)
        let worker_csp = security_headers(ResponseKind::HtmlDocument)
            .iter()
            .find(|(name, _)| *name == "Content-Security-Policy")
            .expect("CSP present in the HTML matrix")
            .1;
        assert_eq!(
            shell_csp, worker_csp,
            "shell _headers CSP drifted from the worker matrix"
        );
        // The universal trio rides the same splat row.
        for header in [
            "X-Frame-Options: DENY",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: strict-origin-when-cross-origin",
            "Permissions-Policy: camera=(), microphone=(), geolocation=()",
        ] {
            assert!(text.contains(header), "_headers missing `{header}`");
        }
    }

    /// The kind detection keys on the Content-Type prefix and stays
    /// case/format tolerant.
    #[test]
    fn kind_detection_is_content_type_driven() {
        assert_eq!(
            response_kind(200, Some("TEXT/HTML")),
            ResponseKind::HtmlDocument
        );
        assert_eq!(
            response_kind(200, Some(" text/html;charset=utf-8")),
            ResponseKind::HtmlDocument
        );
        assert_eq!(
            response_kind(200, Some("text/html-validator-nope")),
            ResponseKind::HtmlDocument
        );
        assert_eq!(
            response_kind(200, Some("application/json")),
            ResponseKind::Other
        );
        assert_eq!(response_kind(200, None), ResponseKind::Other);
    }
}
