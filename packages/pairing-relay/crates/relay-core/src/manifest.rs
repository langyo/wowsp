//! The `/api/health` document — liveness plus identity. One job now that
//! the pairing relay is retired: tell a caller (an operator, a monitor,
//! an app probing the site) that the worker is alive and which
//! implementation answered. The pairing-era fields (protocol list,
//! minimum client version, relay endpoints, feature ids, upstream
//! forwarding) went away with the PIN pairing mode on 2026-11-13 — the
//! account-routed gateway push serves its own health document at
//! `/gateway/health` (see gateway.rs), and the apps no longer consume
//! this one.

use serde::{Deserialize, Serialize};

use crate::{GATEWAY_VERSION, PROVIDER_ID, PROVIDER_NAME};

/// Gateway health + identity document (GET /api/health, always
/// `cache-control: no-store`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Liveness flag (`true` on every reply this gateway serves).
    pub ok: bool,
    /// Machine id of the implementation (`wowsp-gateway`).
    pub provider: String,
    /// Human-facing name.
    pub name: String,
    /// This gateway deployment's version (`x.y.z`, crate version).
    pub version: String,
    /// Optional operator message surfaced to clients (e.g. planned
    /// maintenance). `None` in the common case.
    pub notice: Option<String>,
}

/// Operator overrides from worker environment variables. Both optional;
/// the plain gateway serves `{ notice: null }`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManifestOverrides {
    /// `GATEWAY_NOTICE` — free-form operator message.
    pub notice: Option<String>,
}

impl ManifestOverrides {
    /// Build the override set from a raw environment string (already
    /// trimmed by the caller or here).
    pub fn from_raw(notice: Option<&str>) -> Self {
        Self {
            notice: notice
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        }
    }
}

/// The health document this gateway serves for the given overrides.
pub fn gateway_manifest(overrides: &ManifestOverrides) -> Manifest {
    Manifest {
        ok: true,
        provider: PROVIDER_ID.to_string(),
        name: PROVIDER_NAME.to_string(),
        version: GATEWAY_VERSION.to_string(),
        notice: overrides.notice.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact JSON the contract mandates, field for field.
    #[test]
    fn default_health_serializes_to_the_contract_shape() {
        let m = gateway_manifest(&ManifestOverrides::default());
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(
            json,
            "{\"ok\":true,\"provider\":\"wowsp-gateway\",\"name\":\"WoWSP Gateway\",\"version\":\"0.5.0\",\"notice\":null}"
        );
    }

    #[test]
    fn notice_override_round_trips() {
        let m = gateway_manifest(&ManifestOverrides {
            notice: Some("maintenance window".into()),
        });
        assert_eq!(m.notice.as_deref(), Some("maintenance window"));
        let back: Manifest = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(back, m);
    }
}
