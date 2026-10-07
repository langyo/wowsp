use serde::{Deserialize, Serialize};

/// The single resource pack's LOCAL state (Settings → updates panel).
/// Mirrored by `ResStatus` in the webui api client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResStatus {
    /// Whether at least one pack sub-directory (`models/`, `dogtags/`)
    /// exists and holds an entry.
    pub present: bool,
    /// The content tree hash the cached pack was installed from
    /// (`.res-version.json`). `None` when never hash-stamped.
    pub tree_sha256: Option<String>,
    /// The published-at timestamp that shipped with that tree hash,
    /// ISO-8601 (`None` together with a missing hash).
    pub version: Option<String>,
    /// True when only a LEGACY stamp (`.version` / `.version-dogtags`,
    /// the pre-hash `updated_at` scheme) is on disk — the content hash is
    /// unknowable, so the panel offers a one-time full re-download.
    pub legacy_stamp: bool,
    /// Recursive on-disk size of the pack sub-directories in bytes.
    pub size_bytes: u64,
    /// Whether a pack download/apply is currently in flight.
    pub downloading: bool,
    /// Mobile only: true when the APK-BUNDLED pack is the one serving (no
    /// cache pack, or a cache older than the reported bundled baseline).
    /// Always false on desktop — there is no bundled pack there.
    #[serde(default)]
    pub bundled: bool,
}

/// One link of the chain-patch path a client may apply instead of a full
/// download: the `res-delta-<from>-<to>` release's patch asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResDeltaStep {
    /// Tree hash this patch expects on disk before it applies.
    pub from: String,
    /// Tree hash the pack has after the patch applies.
    pub to: String,
    /// Browser download URL of the `wowsp-res-delta.tar.gz` asset.
    pub url: String,
    /// Asset size in bytes (progress display + mirror sanity check).
    pub size: u64,
}

/// Remote resource-pack state after a `res-latest` manifest lookup
/// (updates panel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResUpdate {
    /// The latest published tree hash, `None` when the manifest could not
    /// be reached (offline / rate-limited / no mirror worked).
    pub latest_tree_sha256: Option<String>,
    /// The latest published-at timestamp (ISO-8601), same reachability
    /// caveat as `latest_tree_sha256`.
    pub latest_version: Option<String>,
    /// True when a `res_download` is possible: the manifest is known AND
    /// the local tree hash differs (or is unknown / legacy-stamped).
    pub update_available: bool,
    /// The chain-patch path from the local tree hash to the latest one.
    /// `Some(steps)` (possibly empty — empty means "full download
    /// required") when the delta tag list was queried successfully;
    /// `None` when that lookup failed (network) and the UI should not
    /// claim either way.
    pub delta_steps: Option<Vec<ResDeltaStep>>,
}

/// A clearable auxiliary cache directory (cache-management panel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxCacheStatus {
    /// Machine scope key: `image-cache` | `gameparams` | `encyclopedia` | `community`.
    pub scope: String,
    /// Recursive on-disk size in bytes; 0 when the directory is absent.
    pub size_bytes: u64,
}
