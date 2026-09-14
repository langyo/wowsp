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
//! The handler allowlists `*.wgcdn.co` HTTPS URLs only (so the scheme can
//! never become an open proxy through the user's proxy), serves hits from a
//! disk cache under the app cache dir, and fetches misses through
//! [`crate::commands::network::build_http_client`] so the Settings → Network
//! proxy choice applies here too, like every other outbound request.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::commands::network;
use crate::paths;

/// Only Wargaming's CDN (and its subdomains) may be fetched through the
/// scheme.
const MEDIA_HOST_SUFFIX: &str = "wgcdn.co";

/// Subdirectory of the app cache root holding the fetched images.
const IMAGE_CACHE_DIR: &str = "image-cache";

/// Content type reported when magic-byte sniffing cannot identify the bytes.
const OCTET_STREAM: &str = "application/octet-stream";

/// Whether `url` may be fetched through the scheme: HTTPS only, and the host
/// is Wargaming's CDN or a subdomain of it. Parsed manually (the `url` crate
/// is not a direct dependency) — pure and unit-tested.
pub fn is_allowed(url: &str) -> bool {
    // Scheme must be https (case-insensitive, as URLs are per RFC 3986 §3.1).
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // Host = everything up to the first path/query/fragment separator. Any
    // userinfo (`user@host`) stays inside this chunk and fails the suffix
    // check below, which is the safe direction (rejection).
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Strip a port suffix, then a trailing FQDN dot, then normalize case.
    let host = host.split(':').next().unwrap_or("");
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == format!("wows-gloss-icons.{MEDIA_HOST_SUFFIX}")
        || host.ends_with(&format!(".{MEDIA_HOST_SUFFIX}"))
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
pub fn handler<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let query = request.uri().query().unwrap_or("").to_string();
    tauri::async_runtime::spawn(async move {
        let response = match extract_url_param(&query).filter(|url| is_allowed(url)) {
            Some(url) => match load(&url).await {
                Ok((bytes, content_type)) => {
                    image_response(tauri::http::StatusCode::OK, &content_type, bytes)
                },
                Err(e) => {
                    tracing::warn!(error = %e, "media fetch failed");
                    status_response(tauri::http::StatusCode::NOT_FOUND)
                },
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
            "https://wows-gloss-icons.wgcdn.co/d-containers/images/a.png"
        ));
    }

    #[test]
    fn allows_cdn_subdomains() {
        assert!(is_allowed("https://gloss-icons.wgcdn.co/a.png"));
        assert!(is_allowed("https://a.b.wgcdn.co/a.png"));
    }

    #[test]
    fn allows_case_and_port_variants() {
        assert!(is_allowed(
            "https://WoWs-Gloss-Icons.wgcdn.co:443/d-containers/a.png"
        ));
    }

    #[test]
    fn rejects_wrong_hosts() {
        assert!(!is_allowed("https://evil.example.com/a.png"));
        // Suffix must land on a domain boundary.
        assert!(!is_allowed("https://evilwgcdn.co/a.png"));
        assert!(!is_allowed("https://wgcdn.co.evil.com/a.png"));
        // The bare domain is not a subdomain of itself.
        assert!(!is_allowed("https://wgcdn.co/a.png"));
    }

    #[test]
    fn rejects_non_https_schemes() {
        assert!(!is_allowed("http://wows-gloss-icons.wgcdn.co/a.png"));
        assert!(!is_allowed("ftp://wows-gloss-icons.wgcdn.co/a.png"));
        assert!(!is_allowed("file:///C:/Windows/explorer.exe"));
        assert!(!is_allowed("wows-gloss-icons.wgcdn.co/a.png"));
    }

    #[test]
    fn rejects_userinfo_lookalikes() {
        // Real host would be evil.com — the suffix check must not be fooled.
        assert!(!is_allowed(
            "https://wows-gloss-icons.wgcdn.co@evil.com/a.png"
        ));
        assert!(!is_allowed(
            "https://evil.com:8080@wows-gloss-icons.wgcdn.co.evil.com/a.png"
        ));
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
