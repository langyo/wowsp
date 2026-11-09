//! Provider-aware mirror context.
//!
//! Every GitHub fetch in the app walks the ladder owned by [`github`]
//! (the command facade with the settings IPC stays in
//! `commands/github_mirror.rs`; the design contract is
//! `docs/en/designs/ai-models.md` section 7). This module is the home that
//! generalizes it: a provider registry, candidate resolution tagged with
//! where each URL came from, and a config snapshot so one pass sees one
//! consistent ladder even if the settings file changes mid-download.
//!
//! The extraction is behaviour-neutral for GitHub (identical candidates,
//! identical order). The Hugging Face provider owns the endpoint-substitution
//! rewrite the `ai` model channel consumes: each candidate is the official
//! `/{repo}/resolve/{revision}/{path}` path under a different endpoint, and
//! the channel's signed manifest plus per-file sha256 decide what is accepted.

// The provider registry and role-tagged candidates are consumed by the
// `ai` model channel; the behaviour-neutral extraction landed first so the
// existing GitHub call sites never changed there.
#![allow(dead_code)]

pub mod github;
pub mod huggingface;

use crate::commands::network::NetworkConfig;

/// The official Hugging Face route (bare, no trailing slash).
pub const HUGGING_FACE_OFFICIAL: &str = "https://huggingface.co";

/// A resource family whose URLs are mirrored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderId {
    GitHub,
    HuggingFace,
}

impl ProviderId {
    /// Stable wire label used by settings DTOs and logs.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::HuggingFace => "huggingface",
        }
    }
}

/// Where one candidate URL comes from — the settings panel's row role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceRole {
    Official,
    BuiltIn,
    User,
}

impl SourceRole {
    /// Stable wire label used by settings DTOs.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::BuiltIn => "built-in",
            Self::User => "user",
        }
    }
}

/// One resolved candidate: the URL to fetch plus its origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorSource {
    pub provider: ProviderId,
    pub role: SourceRole,
    /// The endpoint prefix / official route this candidate came from.
    pub label: String,
    pub url: String,
}

/// How a provider's mirror endpoints combine with an official URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rewrite {
    /// `{prefix}/{official-url}` — the ghproxy-style GitHub rewrite.
    UrlPrefix,
    /// Endpoint substitution keeping the official path (Hugging Face,
    /// ModelScope). The concrete resolve template lands with the `ai`
    /// channel wave.
    Endpoint,
}

/// One provider's static description.
#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub id: ProviderId,
    pub official: &'static str,
    pub built_in: &'static [&'static str],
    pub rewrite: Rewrite,
}

/// The provider registry.
pub const PROVIDERS: [ProviderSpec; 2] = [
    ProviderSpec {
        id: ProviderId::GitHub,
        official: github::OFFICIAL_PREFIX,
        built_in: &github::MIRROR_PREFIXES,
        rewrite: Rewrite::UrlPrefix,
    },
    ProviderSpec {
        id: ProviderId::HuggingFace,
        official: HUGGING_FACE_OFFICIAL,
        built_in: &huggingface::BUILT_IN_ENDPOINTS,
        rewrite: Rewrite::Endpoint,
    },
];

/// A configuration snapshot plus the provider registry.
#[derive(Debug, Clone)]
pub struct MirrorContext {
    config: NetworkConfig,
}

impl MirrorContext {
    /// Snapshot the persisted network config.
    #[must_use]
    pub fn load() -> Self {
        Self::from_config(crate::commands::network::load_config())
    }

    /// A context over an explicit config (tests, callers that already hold
    /// one).
    #[must_use]
    pub fn from_config(config: NetworkConfig) -> Self {
        Self { config }
    }

    /// The snapshot this context resolves against.
    #[must_use]
    pub fn config(&self) -> &NetworkConfig {
        &self.config
    }

    /// One registered provider's static spec.
    #[must_use]
    pub fn provider(&self, id: ProviderId) -> &'static ProviderSpec {
        PROVIDERS
            .iter()
            .find(|spec| spec.id == id)
            .expect("every ProviderId has a registered spec")
    }

    /// GitHub candidates for one official URL — identical to the
    /// historical ladder order (user mirrors, official route, built-ins).
    #[must_use]
    pub fn github_candidates(&self, url: &str) -> Vec<String> {
        github::candidates_with_mirrors(&self.config.github_mirrors, url)
    }

    /// GitHub candidates tagged with their origin (settings / previews).
    #[must_use]
    pub fn github_sources(&self, url: &str) -> Vec<MirrorSource> {
        github::sources_with_mirrors(&self.config.github_mirrors, url)
    }

    /// The updater's effective source rotation for the embedded watch list.
    #[must_use]
    pub fn github_source_list(&self, watch_sources: &[String]) -> Vec<String> {
        github::update_source_list_with(&self.config.github_mirrors, watch_sources)
    }

    /// Candidate URLs for one Hugging Face object: user endpoints first,
    /// then the built-in mainland endpoints, then the official route.
    #[must_use]
    pub fn huggingface_candidates(
        &self,
        resource: &huggingface::HfResource<'_>,
    ) -> Vec<MirrorSource> {
        huggingface::candidates(&self.config.huggingface_mirrors, resource)
    }

    /// The Hugging Face endpoint ladder as the settings panel displays it:
    /// user endpoints first, then the built-in endpoints, then the official
    /// route (this is also the download candidate order).
    #[must_use]
    pub fn huggingface_ladder(&self) -> Vec<MirrorSource> {
        let mut out = Vec::with_capacity(
            self.config.huggingface_mirrors.len() + huggingface::BUILT_IN_ENDPOINTS.len() + 1,
        );
        let mut push = |endpoint: &str, role: SourceRole| {
            let endpoint = endpoint.trim().trim_end_matches('/');
            if endpoint.is_empty()
                || out
                    .iter()
                    .any(|source: &MirrorSource| source.url == endpoint)
            {
                return;
            }
            out.push(MirrorSource {
                provider: ProviderId::HuggingFace,
                role,
                label: endpoint.to_string(),
                url: endpoint.to_string(),
            });
        };
        for endpoint in &self.config.huggingface_mirrors {
            push(endpoint, SourceRole::User);
        }
        for endpoint in huggingface::BUILT_IN_ENDPOINTS {
            push(endpoint, SourceRole::BuiltIn);
        }
        push(HUGGING_FACE_OFFICIAL, SourceRole::Official);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_the_two_providers_with_their_rewrite_kinds() {
        let github = PROVIDERS
            .iter()
            .find(|p| p.id == ProviderId::GitHub)
            .expect("github");
        assert_eq!(github.official, "https://github.com");
        assert_eq!(github.rewrite, Rewrite::UrlPrefix);
        let hf = PROVIDERS
            .iter()
            .find(|p| p.id == ProviderId::HuggingFace)
            .expect("hf");
        assert_eq!(hf.official, "https://huggingface.co");
        assert_eq!(hf.rewrite, Rewrite::Endpoint);
        assert_eq!(
            hf.built_in,
            huggingface::BUILT_IN_ENDPOINTS,
            "the verified mainland mirror is a built-in endpoint"
        );
    }

    #[test]
    fn github_context_overrides_match_the_ladder() {
        let config = NetworkConfig {
            github_mirrors: vec!["https://mirror.example".to_string()],
            huggingface_mirrors: vec!["https://hf-mirror.example".to_string()],
            ..NetworkConfig::default()
        };
        let ctx = MirrorContext::from_config(config);
        let page = "https://github.com/langyo/wowsp/releases/latest/download/latest";
        assert_eq!(
            ctx.github_candidates(page)[0],
            format!("https://mirror.example/{page}")
        );
        let sources = ctx.github_sources(page);
        assert_eq!(sources[0].role, SourceRole::User);
        assert_eq!(sources[0].url, format!("https://mirror.example/{page}"));
        assert_eq!(ctx.huggingface_ladder()[0].url, "https://hf-mirror.example");
        let resource = huggingface::HfResource::new("langyo/wowsp-d1", "main", "manifest.json")
            .expect("resource");
        let candidates = ctx.huggingface_candidates(&resource);
        assert_eq!(
            candidates[0].url,
            "https://hf-mirror.example/langyo/wowsp-d1/resolve/main/manifest.json"
        );
        assert!(candidates.iter().any(|c| c.role == SourceRole::BuiltIn));
        assert_eq!(
            candidates.last().map(|c| c.role),
            Some(SourceRole::Official)
        );
        assert_eq!(
            ctx.huggingface_ladder().last().map(|s| s.role),
            Some(SourceRole::Official)
        );
    }
}
