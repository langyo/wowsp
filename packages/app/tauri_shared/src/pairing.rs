use serde::{Deserialize, Serialize};

/// Result of `import_replay_file`: the local path of the replay that
/// landed in the managed replays dir (after filename sanitization and
/// the `(1)` dedupe suffix). The PIN-pairing DTOs (status / token /
/// target / progress / discovered hosts / relay config) were retired
/// with the pairing mode on 2026-11-13; live-stats pairing is the
/// account-routed gateway (see gateway.rs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPathResult {
    pub path: String,
}
