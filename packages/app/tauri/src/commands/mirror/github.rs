//! The GitHub provider of the mirror context.
//!
//! GitHub is commonly unreachable from mainland China, so every GitHub
//! fetch in the app — update probes, resource-pack manifests and archives,
//! the mod-hub index and packages — walks this ladder: the user-
//! configured mirror prefixes first (in saved order), then the official
//! route, then the built-in ghproxy-style prefixes one by one until a
//! candidate serves.
//!
//! Two out-of-tree consumers must stay in step with this module:
//! - the updater's embedded source list (`[package.metadata.shun.update]`
//!   in this crate's Cargo.toml) is asserted equal to [`update_sources`]
//!   by a unit test in `update.rs`, and
//! - the website's download page (`packages/website`) re-declares the same
//!   prefixes in TypeScript to rotate its version probe and asset links.
//!
//! The configuration-aware entry points (`candidates`, `update_source_list`)
//! live in the `commands/github_mirror.rs` facade; this module stays pure so
//! the ladder can be unit-tested without touching the settings store.

use super::{MirrorSource, ProviderId, SourceRole};

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

/// The official route's bare prefix (no trailing slash) — the ladder's
/// head: what the settings panel probes first and displays as such.
pub const OFFICIAL_PREFIX: &str = "https://github.com";

/// The URL every ladder prefix is probed against: the repo's
/// `releases/latest` page — the same address the updater's tag probe
/// walks, so a green row means "this prefix can carry the update channel
/// right now". The official route probes it bare; every mirror prefix
/// fronts it (`{prefix}/{url}`, the ghproxy-style rewrite).
pub(crate) const PROBE_TARGET: &str = "https://github.com/langyo/wowsp/releases/latest";

/// One probe's ceiling: a dead mirror must fail its row quickly enough
/// for the settings panel to stay responsive even when every prefix is
/// black-holed (all probes run concurrently, so this bounds the wait).
pub(crate) const MIRROR_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

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

/// One user mirror prefix as every ladder builder sees it: trimmed, any
/// trailing '/' stripped, and `None` when nothing remains. (The saved
/// config is already sanitized slash-free; this only guards the edges —
/// older files or hand edits may still carry one, and the ladder must
/// never emit it.)
pub(crate) fn normalized(mirror: &str) -> Option<&str> {
    let trimmed = mirror.trim().trim_end_matches('/');
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Candidate URLs for a GitHub URL: every user-configured mirror first
/// (in order), then the official route, then each built-in mirror prefix.
/// URLs on hosts the prefixes cannot front come back unchanged (single
/// candidate). Empty mirrors are skipped, and so is any mirror whose
/// candidate duplicates an earlier one — a user mirror shadowing a
/// built-in must not get the same URL probed twice.
pub fn candidates_with_mirrors(mirrors: &[String], url: &str) -> Vec<String> {
    if !is_mirrorable(url) {
        return vec![url.to_string()];
    }
    let mut out: Vec<String> = Vec::with_capacity(2 + mirrors.len() + MIRROR_PREFIXES.len());
    let mut push = |candidate: String| {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    };
    for mirror in mirrors {
        let Some(mirror) = normalized(mirror) else {
            continue;
        };
        push(format!("{mirror}/{url}"));
    }
    push(url.to_string());
    for prefix in MIRROR_PREFIXES {
        push(format!("{prefix}{url}"));
    }
    out
}

/// [`candidates_with_mirrors`] with ONE explicit user mirror — the
/// pre-list API shape, kept as a thin wrapper over the general form (the
/// in-crate ladder tests exercise the ladder through it). Production
/// callers read the mirror LIST through [`candidates`], so the lib build
/// no longer reaches this and the lint is silenced deliberately.
#[allow(dead_code)]
pub fn candidates_with_mirror(user_mirror: Option<&str>, url: &str) -> Vec<String> {
    let mirrors: Vec<String> = user_mirror
        .and_then(normalized)
        .map(str::to_string)
        .into_iter()
        .collect();
    candidates_with_mirrors(&mirrors, url)
}

/// Explicit mirrors, no config read — the unit-tested half.
pub(crate) fn update_source_list_with(
    user_mirrors: &[String],
    watch_sources: &[String],
) -> Vec<String> {
    let mirrors: Vec<&str> = user_mirrors.iter().filter_map(|m| normalized(m)).collect();
    if mirrors.is_empty() {
        return watch_sources.to_vec();
    }
    // A ghproxy-style prefix can only front the official release mount —
    // the embedded list opens with it; find the first such source
    // wherever it sits.
    let official_mount = format!("{OFFICIAL_PREFIX}/");
    let base = watch_sources
        .iter()
        .find(|s| s.starts_with(&official_mount));
    let mut out: Vec<String> = Vec::with_capacity(mirrors.len() + watch_sources.len());
    let mut push = |candidate: String| {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    };
    if let Some(base) = base {
        for mirror in &mirrors {
            // A normalized mirror carries no trailing '/', so the
            // ghproxy-style rewrite inserts it here (the embedded
            // built-in sources spell it "prefix + mount" instead).
            push(format!("{mirror}/{base}"));
        }
    }
    for source in watch_sources {
        push(source.clone());
    }
    out
}

/// Candidate URLs tagged with their origin — the settings panel's row
/// model and the future generic probe's input. Same order and the same
/// de-duplication as [`candidates_with_mirrors`]; a foreign (non-mirrorable)
/// URL yields exactly one official row.
pub fn sources_with_mirrors(mirrors: &[String], url: &str) -> Vec<MirrorSource> {
    if !is_mirrorable(url) {
        return vec![MirrorSource {
            provider: ProviderId::GitHub,
            role: SourceRole::Official,
            label: OFFICIAL_PREFIX.to_string(),
            url: url.to_string(),
        }];
    }
    let mut out: Vec<MirrorSource> = Vec::with_capacity(2 + mirrors.len() + MIRROR_PREFIXES.len());
    let mut push = |candidate: MirrorSource| {
        if !out.iter().any(|existing| existing.url == candidate.url) {
            out.push(candidate);
        }
    };
    for mirror in mirrors {
        let Some(mirror) = normalized(mirror) else {
            continue;
        };
        push(MirrorSource {
            provider: ProviderId::GitHub,
            role: SourceRole::User,
            label: mirror.to_string(),
            url: format!("{mirror}/{url}"),
        });
    }
    push(MirrorSource {
        provider: ProviderId::GitHub,
        role: SourceRole::Official,
        label: OFFICIAL_PREFIX.to_string(),
        url: url.to_string(),
    });
    for prefix in MIRROR_PREFIXES {
        push(MirrorSource {
            provider: ProviderId::GitHub,
            role: SourceRole::BuiltIn,
            label: prefix.trim_end_matches('/').to_string(),
            url: format!("{prefix}{url}"),
        });
    }
    out
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
        // "https://ghfast.top" IS built-in #3: the shadowed built-in is
        // skipped, so the ladder loses one entry against the no-mirror
        // shape instead of probing the same candidate twice.
        assert_eq!(urls.len(), 1 + MIRROR_PREFIXES.len());
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

    #[test]
    fn official_prefix_is_the_bare_github_route() {
        assert_eq!(OFFICIAL_PREFIX, "https://github.com");
        assert!(!OFFICIAL_PREFIX.ends_with('/'));
    }

    /// User mirrors lead in saved order; a duplicate (same prefix with and
    /// without the trailing slash) and an empty entry produce nothing
    /// extra; the official route follows the user mirrors.
    #[test]
    fn ladder_user_mirrors_lead_in_order_and_dedupe() {
        let mirrors = vec![
            "https://user1.example/".to_string(),
            "  ".to_string(),
            "https://user1.example".to_string(),
            "https://user2.example".to_string(),
        ];
        let urls = candidates_with_mirrors(&mirrors, PAGE);
        assert_eq!(
            urls[0],
            "https://user1.example/https://github.com/langyo/wowsp/x.tar.gz"
        );
        assert_eq!(
            urls[1],
            "https://user2.example/https://github.com/langyo/wowsp/x.tar.gz"
        );
        assert_eq!(urls[2], PAGE, "official follows the user mirrors");
        assert_eq!(
            urls.len(),
            2 + 1 + MIRROR_PREFIXES.len(),
            "two unique user mirrors + official + built-ins"
        );
        assert_eq!(
            urls.iter().filter(|u| **u == urls[0]).count(),
            1,
            "no duplicated user candidate"
        );
    }

    /// A user mirror identical to a built-in prefix shadows it: the
    /// candidate appears once, at the user's position, not again at the
    /// built-in's.
    #[test]
    fn ladder_user_mirror_shadowing_a_builtin_is_probed_once() {
        let mirrors = vec!["https://ghp.ci".to_string()];
        let urls = candidates_with_mirrors(&mirrors, PAGE);
        assert_eq!(urls[0], format!("{}{PAGE}", MIRROR_PREFIXES[0]));
        assert_eq!(
            urls.len(),
            1 + 1 + MIRROR_PREFIXES.len() - 1,
            "the shadowed built-in is skipped"
        );
    }

    /// A foreign (non-mirrorable) URL is untouched even with user mirrors.
    #[test]
    fn ladder_foreign_url_untouched_with_user_mirrors() {
        let cdn = "https://cdn.example.test/pack.tar.gz";
        let mirrors = vec!["https://user.example/".to_string()];
        assert_eq!(candidates_with_mirrors(&mirrors, cdn), vec![cdn]);
    }

    /// No user mirrors → the updater's source list is an identical clone.
    #[test]
    fn update_source_list_without_user_mirrors_is_a_clone() {
        let sources = update_sources();
        assert_eq!(update_source_list_with(&[], &sources), sources);
    }

    /// One user mirror prepends its candidate for the official release
    /// mount; the embedded sources follow unchanged and in order.
    #[test]
    fn update_source_list_prepends_user_mirrors_to_the_official_mount() {
        let sources = update_sources();
        let mirrors = vec!["https://user.example/".to_string()];
        let out = update_source_list_with(&mirrors, &sources);
        assert_eq!(
            out[0],
            "https://user.example/https://github.com/langyo/wowsp/releases/latest/download"
        );
        assert_eq!(&out[1..], &sources[..]);
        assert_eq!(out.len(), sources.len() + 1);
    }

    /// Several user mirrors all rotate in front of the official mount, in
    /// saved order.
    #[test]
    fn update_source_list_orders_user_mirrors_first() {
        let sources = update_sources();
        let mirrors = vec![
            "https://user2.example".to_string(),
            "https://user1.example".to_string(),
        ];
        let out = update_source_list_with(&mirrors, &sources);
        assert_eq!(
            &out[..2],
            &[
                "https://user2.example/https://github.com/langyo/wowsp/releases/latest/download",
                "https://user1.example/https://github.com/langyo/wowsp/releases/latest/download",
            ]
        );
        assert_eq!(&out[2..], &sources[..]);
    }

    /// A user mirror equal to a built-in prefix dedupes: the candidate
    /// exists once (at the user's position) and the list never grows a
    /// duplicate.
    #[test]
    fn update_source_list_dedupes_a_user_mirror_matching_a_builtin() {
        let sources = update_sources();
        let mirrors = vec!["https://ghp.ci".to_string()];
        let out = update_source_list_with(&mirrors, &sources);
        assert_eq!(out[0], sources[1], "the user mirror shadows built-in #1");
        assert_eq!(out[1], sources[0], "the official mount follows");
        assert_eq!(out.len(), sources.len(), "no duplicate entry");
        assert_eq!(&out[2..], &sources[2..]);
    }

    /// Without an official-mount source there is nothing to prefix — the
    /// list comes back unchanged.
    #[test]
    fn update_source_list_without_an_official_mount_is_a_clone() {
        let sources = vec!["https://mirror.example.test/files/latest".to_string()];
        let mirrors = vec!["https://user.example".to_string()];
        assert_eq!(update_source_list_with(&mirrors, &sources), sources);
    }

    /// An empty (or all-blank) user mirror list behaves like no mirrors.
    #[test]
    fn update_source_list_treats_a_blank_list_as_no_mirrors() {
        let sources = update_sources();
        let mirrors = vec!["   ".to_string(), "/".to_string()];
        assert_eq!(update_source_list_with(&mirrors, &sources), sources);
    }

    /// The role-tagged form mirrors the URL ladder exactly: user mirrors
    /// lead, the official route follows, the built-ins close; a foreign URL
    /// collapses to one official row.
    #[test]
    fn sources_tag_the_ladder_roles() {
        let mirrors = vec!["https://user.example".to_string()];
        let sources = sources_with_mirrors(&mirrors, PAGE);
        assert_eq!(sources[0].provider, ProviderId::GitHub);
        assert_eq!(sources[0].role, SourceRole::User);
        assert_eq!(sources[0].url, format!("https://user.example/{PAGE}"));
        assert_eq!(sources[1].role, SourceRole::Official);
        assert_eq!(sources[1].url, PAGE);
        assert_eq!(sources[2].role, SourceRole::BuiltIn);
        assert_eq!(sources[2].url, format!("{}{PAGE}", MIRROR_PREFIXES[0]));

        let foreign = sources_with_mirrors(&mirrors, "https://cdn.example.test/pack.tar.gz");
        assert_eq!(foreign.len(), 1);
        assert_eq!(foreign[0].role, SourceRole::Official);
    }
}
