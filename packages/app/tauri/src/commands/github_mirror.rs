//! The GitHub mirror ladder command facade.
//!
//! GitHub is commonly unreachable from mainland China, so every GitHub
//! fetch in the app — update probes, resource-pack manifests and archives,
//! the mod-hub index and packages — walks the same ladder: the user-
//! configured mirror prefixes first (in saved order, Settings → Network),
//! then the official route, then the built-in ghproxy-style prefixes one
//! by one until a candidate serves.
//!
//! The ladder itself lives in [`crate::commands::mirror::github`]; this
//! module keeps the configuration-aware entry points every existing caller
//! imports and the two settings IPC commands. Two out-of-tree consumers
//! must stay in step with the ladder:
//! - the updater's embedded source list (`[package.metadata.shun.update]`
//!   in this crate's Cargo.toml) is asserted equal to [`update_sources`]
//!   by a unit test in `update.rs`, and
//! - the website's download page (`packages/website`) re-declares the same
//!   prefixes in TypeScript to rotate its version probe and asset links.

use serde::Serialize;

use wowsp_tauri_shared::CommandResult;

use crate::commands::mirror::{MirrorContext, github};
use crate::commands::network::HttpPair;

#[cfg(test)]
pub use github::update_sources;

/// The ladder every GitHub fetch in the app walks, read from the network
/// config on each call.
pub fn candidates(url: &str) -> Vec<String> {
    MirrorContext::load().github_candidates(url)
}

/// The updater's effective source list: the embedded watch sources with
/// every user-configured mirror prefixed onto the official release mount
/// first (user-prefixed candidates, then the original sources, deduped in
/// order). No user mirrors → an identical clone, so the updater's source
/// rotation only ever GAINS candidates when the user opts in — the
/// version truth itself still comes from the official channels only.
pub fn update_source_list(watch_sources: &[String]) -> Vec<String> {
    MirrorContext::load().github_source_list(watch_sources)
}

/// The whole mirror ladder as currently configured — the settings panel's
/// display model and the probe's row order: official route first, then
/// the built-in prefixes, then the saved user mirrors. No field ever
/// carries a trailing slash.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMirrorLadder {
    pub official: String,
    pub built_in: Vec<String>,
    pub user: Vec<String>,
}

/// One mirror-probe row: the prefix, whether it served the release page,
/// the round-trip time, and the failure text (`None` when ok).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorProbeRow {
    pub prefix: String,
    pub ok: bool,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

/// `#[tauri::command]`: the ladder the mirror settings panel displays and
/// probes — the official route, the built-in prefixes and the sanitized
/// user mirrors in saved order.
#[tauri::command]
pub fn github_mirror_ladder() -> CommandResult<GithubMirrorLadder> {
    let cfg = super::network::load_config();
    Ok(GithubMirrorLadder {
        official: github::OFFICIAL_PREFIX.to_string(),
        built_in: github::MIRROR_PREFIXES
            .iter()
            .map(|m| m.trim_end_matches('/').to_string())
            .collect(),
        user: cfg
            .github_mirrors
            .iter()
            .filter_map(|m| github::normalized(m).map(str::to_string))
            .collect(),
    })
}

/// Probe ONE ladder prefix: GET the release page through it, following
/// redirects, timing the attempt. Never fails — a timeout, transport
/// error or non-200 final status becomes a failed row with its reason.
async fn probe_mirror(pair: &HttpPair, prefix: &str, url: &str) -> MirrorProbeRow {
    let host = super::upstream_health::host_of_url(url).to_string();
    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(
        github::MIRROR_PROBE_TIMEOUT,
        super::upstream_health::send_with_fallback(pair, &host, "mirror-probe", |client| {
            client.get(url)
        }),
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let error = match outcome {
        Err(_) => Some(format!(
            "timed out after {}s",
            github::MIRROR_PROBE_TIMEOUT.as_secs()
        )),
        Ok(Err(e)) => Some(format!("{e}")),
        Ok(Ok(resp)) if resp.status() != reqwest::StatusCode::OK => {
            Some(format!("unexpected status {}", resp.status()))
        },
        Ok(Ok(_)) => None,
    };
    MirrorProbeRow {
        prefix: prefix.to_string(),
        ok: error.is_none(),
        elapsed_ms,
        error,
    }
}

/// `#[tauri::command]`: reachability probe over the WHOLE ladder. Every
/// prefix is asked to serve the repo's `releases/latest` page (the
/// official route probes it bare), all probes run concurrently so a
/// black-holed prefix cannot stretch the wait past one timeout, and the
/// command never fails — every failure lands in its row. Rows follow the
/// ladder order: official first, built-ins, then the user mirrors.
#[tauri::command]
pub async fn github_mirror_probe() -> CommandResult<Vec<MirrorProbeRow>> {
    let ladder = github_mirror_ladder()?;
    let mut targets: Vec<(String, String)> =
        Vec::with_capacity(1 + ladder.built_in.len() + ladder.user.len());
    targets.push((ladder.official.clone(), github::PROBE_TARGET.to_string()));
    for prefix in ladder.built_in.iter().chain(ladder.user.iter()) {
        targets.push((prefix.clone(), format!("{prefix}/{}", github::PROBE_TARGET)));
    }
    let pair = HttpPair::build(|b| b)?;
    let rows = futures::future::join_all(targets.into_iter().map(|(prefix, url)| {
        // A shared borrow per future: the pair is Clone-cheap but there is
        // no reason to clone what every probe can share.
        let pair = &pair;
        async move { probe_mirror(pair, &prefix, &url).await }
    }))
    .await;
    Ok(rows)
}
