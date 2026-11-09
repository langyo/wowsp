//! The Hugging Face provider of the mirror context.
//!
//! Hugging Face mirrors substitute the endpoint base and keep the official
//! path: `{endpoint}/{repo}/resolve/{revision}/{path}`. The official route
//! is https://huggingface.co; the built-in endpoints are the mainland
//! mirrors verified end-to-end before shipping. The `ai` model channel
//! pins a Hub commit and verifies a signed manifest plus per-file sha256,
//! so a mirror is only ever a transport.

use anyhow::{Result, bail};

use super::{MirrorSource, ProviderId, SourceRole};

/// The official route (bare, no trailing slash).
pub const OFFICIAL_ENDPOINT: &str = "https://huggingface.co";

/// Built-in mainland endpoints: tried after the user endpoints and before
/// the official route (CN-first: huggingface.co is unreachable there).
pub const BUILT_IN_ENDPOINTS: [&str; 1] = ["https://hf-mirror.com"];

/// A plain path segment: non-empty, not a dot segment, and limited to the
/// characters Hub ids/paths use (no `/`, `?`, `#`, `%` or backslash that
/// could re-target a resolved URL).
fn is_plain_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
}

/// Whether `repo` is a two-segment Hub id (`owner/name`).
#[must_use]
pub fn is_valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(owner), Some(name), None) if is_plain_segment(owner) && is_plain_segment(name)
    )
}

/// Whether `revision` is a usable ref: a commit sha (40 hex) or a branch/tag
/// name, always one plain segment.
#[must_use]
pub fn is_valid_revision(revision: &str) -> bool {
    !revision.is_empty()
        && revision.len() <= 64
        && revision != "."
        && revision != ".."
        && revision
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Whether `path` is a repository-relative file path of plain segments.
#[must_use]
pub fn is_valid_path(path: &str) -> bool {
    !path.is_empty() && path.split('/').all(is_plain_segment)
}

/// One immutable Hub object: the repository, the pinned revision and the
/// file path. Validated at construction so a manifest (or any caller) can
/// never steer a resolve URL outside the repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HfResource<'a> {
    pub repo: &'a str,
    pub revision: &'a str,
    pub path: &'a str,
}

impl<'a> HfResource<'a> {
    /// Validate + build one resource reference.
    pub fn new(repo: &'a str, revision: &'a str, path: &'a str) -> Result<Self> {
        if !is_valid_repo(repo) {
            bail!("invalid Hugging Face repo id {repo:?} (want owner/name)");
        }
        if !is_valid_revision(revision) {
            bail!("invalid Hugging Face revision {revision:?}");
        }
        if !is_valid_path(path) {
            bail!("invalid Hugging Face path {path:?}");
        }
        Ok(Self {
            repo,
            revision,
            path,
        })
    }

    /// The rolling manifest object: branch head + the manifest file name.
    pub fn manifest(repo: &'a str) -> Result<Self> {
        Self::new(repo, "main", "manifest.json")
    }
}

/// The resolve URL of one object through one endpoint.
#[must_use]
pub fn resolve_url(endpoint: &str, resource: &HfResource<'_>) -> String {
    format!(
        "{}/{}/resolve/{}/{}",
        endpoint.trim_end_matches('/'),
        resource.repo,
        resource.revision,
        resource.path
    )
}

/// Candidate URLs for one Hub object: user endpoints first (saved order),
/// then the built-in mainland endpoints, then the official route. Duplicate
/// candidates are dropped; every candidate names the same content by the
/// pinned revision, so the caller's sha256 check decides what is accepted.
#[must_use]
pub fn candidates(user_endpoints: &[String], resource: &HfResource<'_>) -> Vec<MirrorSource> {
    let mut out: Vec<MirrorSource> = Vec::with_capacity(2 + BUILT_IN_ENDPOINTS.len());
    let mut push = |endpoint: &str, role: SourceRole| {
        let endpoint = endpoint.trim().trim_end_matches('/');
        if endpoint.is_empty() {
            return;
        }
        let url = resolve_url(endpoint, resource);
        if out.iter().any(|existing| existing.url == url) {
            return;
        }
        out.push(MirrorSource {
            provider: ProviderId::HuggingFace,
            role,
            label: endpoint.to_string(),
            url,
        });
    };
    for endpoint in user_endpoints {
        push(endpoint, SourceRole::User);
    }
    for endpoint in BUILT_IN_ENDPOINTS {
        push(endpoint, SourceRole::BuiltIn);
    }
    push(OFFICIAL_ENDPOINT, SourceRole::Official);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO: &str = "langyo/wowsp-d1";
    const REV: &str = "a1bae028c41641ecb1715aa3c318e8d320c322f2";

    #[test]
    fn resolve_url_keeps_the_official_path() {
        let r = HfResource::new(REPO, REV, "onnx/fire_model.onnx").unwrap();
        assert_eq!(
            resolve_url(OFFICIAL_ENDPOINT, &r),
            format!("{OFFICIAL_ENDPOINT}/{REPO}/resolve/{REV}/onnx/fire_model.onnx")
        );
        assert_eq!(
            resolve_url("https://hf-mirror.com/", &r),
            format!("https://hf-mirror.com/{REPO}/resolve/{REV}/onnx/fire_model.onnx")
        );
    }

    #[test]
    fn candidates_are_cn_first_and_deduped() {
        let user = vec![
            "https://mirror.example".to_string(),
            "https://hf-mirror.com/".to_string(),
        ];
        let r = HfResource::manifest(REPO).unwrap();
        let list = candidates(&user, &r);
        assert_eq!(list[0].role, SourceRole::User);
        assert_eq!(
            list[0].url,
            format!("https://mirror.example/{REPO}/resolve/main/manifest.json")
        );
        let official = list.last().expect("official last");
        assert_eq!(official.role, SourceRole::Official);
        assert_eq!(
            official.url,
            format!("{OFFICIAL_ENDPOINT}/{REPO}/resolve/main/manifest.json")
        );
        assert_eq!(
            list.iter()
                .filter(|s| s.url.contains("hf-mirror.com"))
                .count(),
            1,
            "a user endpoint shadowing the built-in is not probed twice"
        );
        assert_eq!(
            list.iter()
                .find(|s| s.url.contains("hf-mirror.com"))
                .map(|s| s.role),
            Some(SourceRole::User),
            "the user position wins when it duplicates a built-in"
        );

        // A user endpoint that does NOT shadow the built-in leaves the
        // built-in between the user row and the official route.
        let user = vec!["https://mirror.example".to_string()];
        let list = candidates(&user, &r);
        assert!(
            list.iter()
                .any(|s| s.role == SourceRole::BuiltIn && s.url.contains("hf-mirror.com"))
        );
        assert_eq!(list.last().map(|s| s.role), Some(SourceRole::Official));
    }

    #[test]
    fn validation_rejects_escaping_ids() {
        assert!(HfResource::new("langyo", "main", "manifest.json").is_err());
        assert!(HfResource::new("langyo/wowsp-d1", "../main", "manifest.json").is_err());
        assert!(HfResource::new("langyo/wowsp-d1", "main", "../etc/passwd").is_err());
        assert!(HfResource::new("langyo/wowsp-d1", "main", "a//b").is_err());
        assert!(HfResource::new("langyo/wowsp-d1", "main", "ok/file.json").is_ok());
    }
}
