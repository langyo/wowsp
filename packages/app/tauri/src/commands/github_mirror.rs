//! The single source of truth for the GitHub mirror ladder.
//!
//! GitHub is commonly unreachable from mainland China, so every GitHub
//! fetch in the app — update probes, resource-pack manifests and archives,
//! the mod-hub index and packages — walks the same ladder: the user-
//! configured mirror first (an explicit override from Settings → Network),
//! then the official route, then the built-in ghproxy-style prefixes one
//! by one until a candidate serves.
//!
//! Two out-of-tree consumers must stay in step with this module:
//! - the updater's embedded source list (`[package.metadata.shun.update]`
//!   in this crate's Cargo.toml) is asserted equal to [`update_sources`]
//!   by a unit test in `update.rs`, and
//! - the website's download page (`packages/website`) re-declares the same
//!   prefixes in TypeScript to rotate its version probe and asset links.

/// Hosts eligible for mirror prefixing: release/page URLs and the REST API
/// (`api.github.com`) alike — some proxies serve the API too, and the
/// ladder simply moves on when one does not.
pub const MIRRORABLE_HOSTS: [&str; 2] = ["https://github.com/", "https://api.github.com/"];

/// Built-in ghproxy-style mirror prefixes, tried in order after the
/// official route so they only carry traffic the direct route cannot.
pub const MIRROR_PREFIXES: [&str; 4] = [
    "https://ghp.ci/",
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://ghproxy.net/",
];

/// The updater's source list implied by this module: the official
/// download-mount base first, then every mirror prefix applied to it.
/// Test-only because production consumes the list through the embedded
/// `[package.metadata.shun.update]` table instead — the consistency test
/// in `update.rs` asserts the two never drift apart.
#[cfg(test)]
pub fn update_sources() -> Vec<String> {
    const UPDATE_BASE: &str = "https://github.com/langyo/wowsp/releases/latest/download";
    std::iter::once(UPDATE_BASE.to_string())
        .chain(MIRROR_PREFIXES.map(|m| format!("{m}{UPDATE_BASE}")))
        .collect()
}

/// Whether `url` points at a host the mirror prefixes can front.
fn is_mirrorable(url: &str) -> bool {
    MIRRORABLE_HOSTS.iter().any(|h| url.starts_with(h))
}

/// Candidate URLs for a GitHub URL: an explicit user mirror first, then
/// the official route, then each built-in mirror prefix. URLs on hosts
/// the prefixes cannot front come back unchanged (single candidate).
pub fn candidates_with_mirror(user_mirror: Option<&str>, url: &str) -> Vec<String> {
    if !is_mirrorable(url) {
        return vec![url.to_string()];
    }
    let mut out = Vec::with_capacity(2 + MIRROR_PREFIXES.len());
    if let Some(m) = user_mirror.map(str::trim).filter(|m| !m.is_empty()) {
        out.push(format!("{}/{url}", m.trim_end_matches('/')));
    }
    out.push(url.to_string());
    out.extend(MIRROR_PREFIXES.iter().map(|m| format!("{m}{url}")));
    out
}

/// [`candidates_with_mirror`] with the user mirror read from the network
/// config — the ladder every GitHub fetch in the app should walk.
pub fn candidates(url: &str) -> Vec<String> {
    let cfg = super::network::load_config();
    candidates_with_mirror(cfg.github_mirror.as_deref(), url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://github.com/langyo/wowsp/x.tar.gz";
    const API: &str = "https://api.github.com/repos/langyo/wowsp/releases/latest";

    #[test]
    fn ladder_puts_the_official_route_first() {
        let urls = candidates_with_mirror(None, PAGE);
        assert_eq!(urls[0], PAGE);
        assert_eq!(
            urls[1],
            format!("{}{PAGE}", MIRROR_PREFIXES[0]),
            "mirrors follow in declaration order"
        );
        assert_eq!(urls.len(), 1 + MIRROR_PREFIXES.len());
    }

    #[test]
    fn ladder_puts_the_user_mirror_first() {
        let urls = candidates_with_mirror(Some("https://ghfast.top"), PAGE);
        assert_eq!(
            urls[0],
            "https://ghfast.top/https://github.com/langyo/wowsp/x.tar.gz"
        );
        assert_eq!(urls[1], PAGE, "official second");
        assert_eq!(urls.len(), 2 + MIRROR_PREFIXES.len());
    }

    #[test]
    fn ladder_trims_the_user_mirror_slash() {
        let urls = candidates_with_mirror(Some("https://gh-proxy.com/"), PAGE);
        assert_eq!(
            urls[0],
            "https://gh-proxy.com/https://github.com/langyo/wowsp/x.tar.gz"
        );
    }

    #[test]
    fn ladder_prefixes_the_api_host_too() {
        let urls = candidates_with_mirror(None, API);
        assert_eq!(urls[0], API);
        assert_eq!(urls[1], format!("{}{API}", MIRROR_PREFIXES[0]));
    }

    #[test]
    fn ladder_leaves_foreign_urls_alone() {
        let cdn = "https://cdn.example.test/pack.tar.gz";
        assert_eq!(
            candidates_with_mirror(Some("https://ghfast.top"), cdn),
            vec![cdn]
        );
    }

    #[test]
    fn update_sources_match_the_embedded_shape() {
        let sources = update_sources();
        assert_eq!(
            sources[0],
            "https://github.com/langyo/wowsp/releases/latest/download"
        );
        assert_eq!(sources.len(), 1 + MIRROR_PREFIXES.len());
        assert!(sources.iter().all(|s| s.starts_with("https://")));
    }
}
