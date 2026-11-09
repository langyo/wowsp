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
//! identical order). The Hugging Face provider's URL rewriting, probe and
//! hedging land with the `ai` channel wave and consume the types below;
//! the empty Hugging Face built-in endpoint list is deliberate until those
//! endpoints are verified end-to-end.

// The provider registry and role-tagged candidates are consumed by the
// `ai` channel wave (PR2); the behaviour-neutral extraction lands first so
// the existing GitHub call sites never change in this step.
#![allow(dead_code)]

pub mod github;

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
        built_in: &[],
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

    /// The Hugging Face endpoint ladder: user endpoints first, then the
    /// official route. Consumed by the `ai` channel wave.
    #[must_use]
    pub fn huggingface_ladder(&self) -> Vec<MirrorSource> {
        let mut out = Vec::with_capacity(self.config.huggingface_mirrors.len() + 1);
        for endpoint in &self.config.huggingface_mirrors {
            out.push(MirrorSource {
                provider: ProviderId::HuggingFace,
                role: SourceRole::User,
                label: endpoint.clone(),
                url: endpoint.clone(),
            });
        }
        out.push(MirrorSource {
            provider: ProviderId::HuggingFace,
            role: SourceRole::Official,
            label: HUGGING_FACE_OFFICIAL.to_string(),
            url: HUGGING_FACE_OFFICIAL.to_string(),
        });
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
        assert!(
            hf.built_in.is_empty(),
            "HF built-ins land with the ai channel"
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
        assert_eq!(
            ctx.huggingface_ladder().last().map(|s| s.role),
            Some(SourceRole::Official)
        );
    }
}
