//! Remote image proxy served over a custom `media` URI scheme.
//!
//! WG CDN ship portraits used to be fetched by the webview directly
//! (`<img src="https://wows-gloss-icons.wgcdn.co/...">`), which bypassed the
//! app's configured network proxy and needed a CSP carve-out. Instead, the
//! frontend now rewrites those URLs onto this scheme:
//!
//! - Windows/WebView2: `http://media.localhost/image?url=<urlencoded-url>`
//!   (Windows-first app; on macOS/Linux the same handler answers
//!   `media://localhost/...`).
//!
//! The allowlist is config-driven: the official Wargaming CDN (`*.wgcdn.co`)
//! plus the host of the "Resource CDN" mirror base configured in
//! Settings → Network — so the scheme can never become an open proxy through
//! the user's proxy. When a mirror base is set, the handler rewrites the
//! original URL's scheme+host onto it (path/query preserved) and falls back
//! to the original URL when the mirror fetch fails. Hits are served from a
//! disk cache under the app cache dir (keyed per fetch URL, so mirror and
//! original copies coexist), and misses are fetched through
//! [`crate::commands::network::build_http_client`] so the Settings → Network
//! proxy choice applies here too, like every other outbound request.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::commands::network;
use crate::paths;

/// Official host served when no Resource CDN mirror is configured.
const DEFAULT_CDN_HOST: &str = "wows-gloss-icons.wgcdn.co";

/// Only Wargaming's CDN (and its subdomains) may be fetched through the
/// scheme (plus the configured Resource CDN mirror host, see [`is_allowed`]).
const MEDIA_HOST_SUFFIX: &str = "wgcdn.co";

/// Subdirectory of the app cache root holding the fetched images.
const IMAGE_CACHE_DIR: &str = "image-cache";

/// Content type reported when magic-byte sniffing cannot identify the bytes.
const OCTET_STREAM: &str = "application/octet-stream";

/// Normalized host of an HTTPS URL: scheme must be https (case-insensitive,
/// as URLs are per RFC 3986 §3.1), port and trailing FQDN dot stripped, case
/// normalized. Parsed manually (the `url` crate is not a direct dependency)
/// — pure and unit-tested. Any userinfo (`user@host`) stays inside the host
/// chunk and simply fails exact/suffix comparisons, which is the safe
/// direction (rejection).
fn https_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    // Host = everything up to the first path/query/fragment separator.
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    Some(host.trim_end_matches('.').to_ascii_lowercase())
}

/// Whether `url` may be fetched through the scheme: HTTPS only, and the host
/// is the official Wargaming CDN, a subdomain of it, or — exact match — the
/// host of the configured Resource CDN mirror base (empty/absent base →
/// official CDN only). Pure and unit-tested.
pub fn is_allowed(url: &str, resource_cdn: Option<&str>) -> bool {
    let Some(host) = https_host(url) else {
        return false;
    };
    if host == DEFAULT_CDN_HOST || host.ends_with(&format!(".{MEDIA_HOST_SUFFIX}")) {
        return true;
    }
    let base = resource_cdn.map(str::trim).filter(|b| !b.is_empty());
    let Some(base_host) = base.and_then(https_host) else {
        return false;
    };
    host == base_host
}

/// Part of `original` that survives a mirror rewrite: everything after the
/// host (path + query + fragment), or `"/"` when the URL carries no path.
fn original_path(original: &str) -> &str {
    let Some((_, rest)) = original.split_once("://") else {
        return "/";
    };
    match rest.find(['/', '?', '#']) {
        Some(i) => &rest[i..],
        None => "/",
    }
}

/// Resolve the URL to actually fetch for `original`: when a Resource CDN
/// mirror base is configured (non-empty `https://…`), its scheme+host
/// replaces the original's (path/query/fragment preserved, one trailing `/`
/// trimmed from the base); otherwise the original URL is returned unchanged.
/// The bool reports whether a rewrite happened, so the caller can fall back
/// to the original URL when the mirror fetch fails. Pure and unit-tested.
fn effective_url(original: &str, resource_cdn: Option<&str>) -> (String, bool) {
    let base = resource_cdn.map(str::trim).filter(|b| !b.is_empty());
    match base {
        Some(base) if base.to_ascii_lowercase().starts_with("https://") => (
            format!("{}{}", base.trim_end_matches('/'), original_path(original)),
            true,
        ),
        _ => (original.to_string(), false),
    }
}

/// Deterministic cache key for a URL: lowercase hex SHA-256 (sha2 + hex are
/// already crate dependencies).
fn cache_key(url: &str) -> String {
    hex::encode(Sha256::digest(url.as_bytes()))
}

/// Resolve `<cache>/image-cache/<key>` for a URL, creating the directory.
fn cache_path(url: &str) -> Result<PathBuf, String> {
    let dir = paths::ensure_cache_dir()?.join(IMAGE_CACHE_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir.join(cache_key(url)))
}

/// Sniff an image content type from magic bytes (PNG / JPEG / WebP / GIF),
/// falling back to `application/octet-stream`.
fn sniff_image_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        return "image/png";
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return "image/jpeg";
    }
    // WebP: "RIFF" + 4-byte size + "WEBP".
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.starts_with(b"GIF8") {
        return "image/gif";
    }
    OCTET_STREAM
}

/// Minimal percent-decoder for query values (the frontend addresses this
/// scheme with `encodeURIComponent`, which never emits `+` for space).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract the `url=` query parameter from a raw query string.
fn extract_url_param(query: &str) -> Option<String> {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("url="))
        .map(percent_decode)
}

/// Serve a cache hit or fetch a miss. Returns the bytes plus the content type
/// to report: magic-byte sniff when recognizable, else the response's own
/// `image/*` content type. Any failure (network, non-200, non-image) is an
/// `Err` — the handler turns it into a 404 so the frontend's AssetImage
/// placeholder flow kicks in.
async fn load(url: &str) -> Result<(Vec<u8>, String), String> {
    // Cache hit: serve straight from disk.
    let path = cache_path(url)?;
    if let Ok(bytes) = std::fs::read(&path) {
        let content_type = sniff_image_type(&bytes).to_string();
        return Ok((bytes, content_type));
    }

    // Miss: fetch through the proxy-aware client (Settings → Network applies).
    let client = network::build_http_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch {url}: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("fetch {url}: status {}", response.status()));
    }
    let response_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !response_type.starts_with("image/") {
        return Err(format!("fetch {url}: not an image ({response_type})"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read {url}: {e}"))?
        .to_vec();

    let content_type = match sniff_image_type(&bytes) {
        OCTET_STREAM => response_type
            .split(';')
            .next()
            .unwrap_or(OCTET_STREAM)
            .trim()
            .to_string(),
        sniffed => sniffed.to_string(),
    };
    // Cache-write failures are tolerated: the fetch already succeeded, so the
    // caller still gets a 200 (the next request just refetches).
    if let Err(e) = std::fs::write(&path, &bytes) {
        tracing::warn!(error = %e, path = ?path, "media cache write failed");
    }
    Ok((bytes, content_type))
}

fn image_response(
    status: tauri::http::StatusCode,
    content_type: &str,
    bytes: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, content_type)
        .body(bytes)
        .expect("static response builder parts cannot fail")
}

fn status_response(status: tauri::http::StatusCode) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static response builder parts cannot fail")
}

/// Handler registered as the `media` scheme
/// (`register_asynchronous_uri_scheme_protocol` in main.rs). Spawns the
/// fetch onto the Tauri async runtime and answers via the responder:
///
/// - missing / non-allowlisted `url` param → 403
/// - fetch or cache-read failure → 404 (frontend falls back to placeholders)
/// - success → 200 with the sniffed image content type
///
/// The network config is re-loaded per request (a tiny JSON read), so
/// Resource CDN changes in Settings apply immediately, without a restart.
/// When a mirror base is configured the request goes to the rewritten URL
/// first; a mirror failure falls back to the original URL (403/404 semantics
/// unchanged).
pub fn handler<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let query = request.uri().query().unwrap_or("").to_string();
    tauri::async_runtime::spawn(async move {
        let resource_cdn = network::load_config().resource_cdn;
        let response = match extract_url_param(&query)
            .filter(|url| is_allowed(url, resource_cdn.as_deref()))
        {
            Some(url) => {
                let (effective, rewritten) = effective_url(&url, resource_cdn.as_deref());
                match load(&effective).await {
                    Ok((bytes, content_type)) => {
                        image_response(tauri::http::StatusCode::OK, &content_type, bytes)
                    },
                    Err(e) if rewritten => {
                        // Mirror missed (or is down): fall back to the
                        // original URL. Cache keys are per fetch URL, so
                        // mirror and original copies coexist.
                        tracing::warn!(
                            error = %e,
                            mirror = %effective,
                            "resource CDN mirror fetch failed, falling back to original URL"
                        );
                        match load(&url).await {
                            Ok((bytes, content_type)) => {
                                image_response(tauri::http::StatusCode::OK, &content_type, bytes)
                            },
                            Err(e) => {
                                tracing::warn!(error = %e, "media fetch failed");
                                status_response(tauri::http::StatusCode::NOT_FOUND)
                            },
                        }
                    },
                    Err(e) => {
                        tracing::warn!(error = %e, "media fetch failed");
                        status_response(tauri::http::StatusCode::NOT_FOUND)
                    },
                }
            },
            None => status_response(tauri::http::StatusCode::FORBIDDEN),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_exact_cdn_host() {
        assert!(is_allowed(
            "https://wows-gloss-icons.wgcdn.co/d-containers/images/a.png",
            None
        ));
    }

    #[test]
    fn allows_cdn_subdomains() {
        assert!(is_allowed("https://gloss-icons.wgcdn.co/a.png", None));
        assert!(is_allowed("https://a.b.wgcdn.co/a.png", None));
    }

    #[test]
    fn allows_case_and_port_variants() {
        assert!(is_allowed(
            "https://WoWs-Gloss-Icons.wgcdn.co:443/d-containers/a.png",
            None
        ));
    }

    #[test]
    fn rejects_wrong_hosts() {
        assert!(!is_allowed("https://evil.example.com/a.png", None));
        // Suffix must land on a domain boundary.
        assert!(!is_allowed("https://evilwgcdn.co/a.png", None));
        assert!(!is_allowed("https://wgcdn.co.evil.com/a.png", None));
        // The bare domain is not a subdomain of itself.
        assert!(!is_allowed("https://wgcdn.co/a.png", None));
    }

    #[test]
    fn rejects_non_https_schemes() {
        assert!(!is_allowed("http://wows-gloss-icons.wgcdn.co/a.png", None));
        assert!(!is_allowed("ftp://wows-gloss-icons.wgcdn.co/a.png", None));
        assert!(!is_allowed("file:///C:/Windows/explorer.exe", None));
        assert!(!is_allowed("wows-gloss-icons.wgcdn.co/a.png", None));
    }

    #[test]
    fn rejects_userinfo_lookalikes() {
        // Real host would be evil.com — the suffix check must not be fooled.
        assert!(!is_allowed(
            "https://wows-gloss-icons.wgcdn.co@evil.com/a.png",
            None
        ));
        assert!(!is_allowed(
            "https://evil.com:8080@wows-gloss-icons.wgcdn.co.evil.com/a.png",
            None
        ));
    }

    #[test]
    fn allows_configured_mirror_host() {
        const BASE: Option<&str> = Some("https://mirror.example.com/wg/");
        assert!(is_allowed("https://mirror.example.com/a.png", BASE));
        // Path/query do not matter — the check is on the host.
        assert!(is_allowed(
            "https://mirror.example.com/wg/d-containers/a.png?x=1",
            BASE
        ));
        // Same normalization as the default host: port / case / FQDN dot.
        assert!(is_allowed("https://MIRROR.example.com:443./a.png", BASE));
        // Base variants (whitespace, non-https) are ignored — default only.
        assert!(!is_allowed("https://mirror.example.com/a.png", Some("  ")));
        assert!(!is_allowed(
            "https://mirror.example.com/a.png",
            Some("http://mirror.example.com/")
        ));
        // Host must match the configured one exactly.
        assert!(!is_allowed("https://other.example.com/a.png", BASE));
        assert!(!is_allowed(
            "https://evil.com:8080@mirror.example.com/a.png",
            BASE
        ));
    }

    #[test]
    fn effective_url_unset_base_keeps_original() {
        let url = "https://wows-gloss-icons.wgcdn.co/a.png";
        assert_eq!(effective_url(url, None), (url.to_string(), false));
        assert_eq!(effective_url(url, Some("")), (url.to_string(), false));
        assert_eq!(effective_url(url, Some("   ")), (url.to_string(), false));
    }

    #[test]
    fn effective_url_rewrites_scheme_and_host_only() {
        assert_eq!(
            effective_url(
                "https://wows-gloss-icons.wgcdn.co/d-containers/images/a.png",
                Some("https://mirror.example.com/wg/")
            ),
            (
                "https://mirror.example.com/wg/d-containers/images/a.png".to_string(),
                true
            )
        );
        // Query and fragment survive the rewrite; a base without a path
        // concatenates directly onto the original path.
        assert_eq!(
            effective_url(
                "https://wows-gloss-icons.wgcdn.co/a.png?v=2#frag",
                Some("https://mirror.example.com")
            ),
            (
                "https://mirror.example.com/a.png?v=2#frag".to_string(),
                true
            )
        );
    }

    #[test]
    fn effective_url_trims_trailing_slashes() {
        assert_eq!(
            effective_url(
                "https://wows-gloss-icons.wgcdn.co/a.png",
                Some("https://mirror.example.com/wg/")
            ),
            ("https://mirror.example.com/wg/a.png".to_string(), true)
        );
        assert_eq!(
            effective_url(
                "https://wows-gloss-icons.wgcdn.co/a.png",
                Some("https://mirror.example.com/")
            ),
            ("https://mirror.example.com/a.png".to_string(), true)
        );
    }

    #[test]
    fn effective_url_ignores_non_https_base() {
        let url = "https://wows-gloss-icons.wgcdn.co/a.png";
        assert_eq!(
            effective_url(url, Some("http://mirror.example.com/")),
            (url.to_string(), false)
        );
        assert_eq!(
            effective_url(url, Some("mirror.example.com")),
            (url.to_string(), false)
        );
    }

    #[test]
    fn effective_url_pathless_original_yields_root() {
        assert_eq!(
            effective_url(
                "https://wows-gloss-icons.wgcdn.co",
                Some("https://mirror.example.com/wg")
            ),
            ("https://mirror.example.com/wg/".to_string(), true)
        );
    }

    #[test]
    fn cache_keys_are_deterministic_and_distinct() {
        let a = "https://wows-gloss-icons.wgcdn.co/a.png";
        let b = "https://wows-gloss-icons.wgcdn.co/b.png";
        let key_a = cache_key(a);
        assert_eq!(key_a, cache_key(a));
        assert_ne!(key_a, cache_key(b));
        // SHA-256 hex digest length.
        assert_eq!(key_a.len(), 64);
        assert!(key_a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn cache_path_lands_in_image_cache_dir() {
        let url = "https://wows-gloss-icons.wgcdn.co/a.png";
        let p1 = cache_path(url).expect("cache path resolves");
        let p2 = cache_path(url).expect("cache path resolves");
        assert_eq!(p1, p2);
        assert_eq!(
            p1.parent()
                .map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
                .flatten()
                .as_deref(),
            Some(IMAGE_CACHE_DIR)
        );
        assert_eq!(
            p1.file_name().and_then(|n| n.to_str()),
            Some(cache_key(url).as_str())
        );
    }

    #[test]
    fn sniffs_known_image_types() {
        assert_eq!(sniff_image_type(b"\x89PNG\r\n\x1a\nrest"), "image/png");
        assert_eq!(sniff_image_type(b"\xFF\xD8\xFF\xE0jpeg"), "image/jpeg");
        assert_eq!(
            sniff_image_type(b"RIFF\x24\x00\x00\x00WEBPVP8 "),
            "image/webp"
        );
        assert_eq!(sniff_image_type(b"GIF89a......"), "image/gif");
        assert_eq!(sniff_image_type(b"GIF87a......"), "image/gif");
    }

    #[test]
    fn sniff_falls_back_to_octet_stream() {
        assert_eq!(sniff_image_type(b"<html>not an image</html>"), OCTET_STREAM);
        assert_eq!(sniff_image_type(b""), OCTET_STREAM);
        // Truncated WebP (missing the RIFF-size + WEBP fields) is unknown.
        assert_eq!(sniff_image_type(b"RIFF"), OCTET_STREAM);
        assert_eq!(sniff_image_type(b"RIFF\x24\x00\x00\x00"), OCTET_STREAM);
    }

    #[test]
    fn decodes_url_query_param() {
        let query = "url=https%3A%2F%2Fwows-gloss-icons.wgcdn.co%2Fa%20b.png";
        assert_eq!(
            extract_url_param(query).as_deref(),
            Some("https://wows-gloss-icons.wgcdn.co/a b.png")
        );
        // Only the url= parameter is decoded; % digits are preserved verbatim
        // when they do not form a valid escape.
        assert_eq!(
            extract_url_param("other=1&url=a%2Fb").as_deref(),
            Some("a/b")
        );
        assert_eq!(extract_url_param("url=a%ZZb").as_deref(), Some("a%ZZb"));
        assert_eq!(extract_url_param("nope=1"), None);
        assert_eq!(extract_url_param(""), None);
    }
}
