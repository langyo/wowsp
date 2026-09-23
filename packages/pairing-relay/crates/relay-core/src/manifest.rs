//! The `/v1/manifest` document: how a client discovers what this gateway
//! is, where its relay routes live, and whether it is a forwarding
//! station pointing at an upstream exchange.

use serde::{Deserialize, Serialize};

use crate::{DEFAULT_RELAY_BASE, FEATURE_BYTE_TUNNEL, FEATURE_PIN_ALLOCATION, PROTOCOL_V1};

/// Gateway identity + capability discovery document (GET /v1/manifest,
/// always `cache-control: no-store`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    /// Machine id of the implementation (`wowsp-gateway`).
    pub provider: String,
    /// Human-facing name.
    pub name: String,
    /// Protocol versions accepted, oldest first (`["v1"]`).
    pub protocol: Vec<String>,
    /// Where the WebSocket routes live.
    pub endpoints: ManifestEndpoints,
    /// `None` (this gateway IS the exchange) or the absolute https/wss
    /// URL of the real exchange — forwarding-station mode: clients that
    /// see an upstream follow it and stop talking to this gateway.
    pub upstream: Option<String>,
    /// Feature ids the backend supports.
    pub features: Vec<String>,
    /// Optional operator message surfaced to clients (e.g. planned
    /// maintenance). `None` in the common case.
    pub notice: Option<String>,
}

/// Endpoint table of the manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestEndpoints {
    /// Same-origin path (`/relay`) or an absolute `wss://` URL.
    pub relay: String,
}

/// Operator overrides from worker environment variables. Both optional;
/// the plain gateway serves `{ upstream: null, notice: null }`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManifestOverrides {
    /// `GATEWAY_UPSTREAM` — puts the manifest into forwarding-station
    /// mode. Only absolute `https://`/`wss://` values are honored;
    /// anything else is ignored (a typo must not strand clients).
    pub upstream: Option<String>,
    /// `GATEWAY_NOTICE` — free-form operator message.
    pub notice: Option<String>,
}

impl ManifestOverrides {
    /// Build the override set from raw environment strings (already
    /// trimmed by the caller or here). Non-absolute upstream values are
    /// dropped.
    pub fn from_raw(upstream: Option<&str>, notice: Option<&str>) -> Self {
        Self {
            upstream: upstream
                .map(str::trim)
                .filter(|s| s.starts_with("https://") || s.starts_with("wss://"))
                .map(str::to_string),
            notice: notice
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        }
    }
}

/// The manifest this gateway serves for the given overrides.
pub fn gateway_manifest(overrides: &ManifestOverrides) -> Manifest {
    Manifest {
        provider: crate::PROVIDER_ID.to_string(),
        name: crate::PROVIDER_NAME.to_string(),
        protocol: vec![PROTOCOL_V1.to_string()],
        endpoints: ManifestEndpoints {
            relay: DEFAULT_RELAY_BASE.to_string(),
        },
        upstream: overrides.upstream.clone(),
        features: vec![
            FEATURE_PIN_ALLOCATION.to_string(),
            FEATURE_BYTE_TUNNEL.to_string(),
        ],
        notice: overrides.notice.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FEATURE_BYTE_TUNNEL, FEATURE_PIN_ALLOCATION, PROTOCOL_V1};

    /// The exact JSON the contract mandates, field for field.
    #[test]
    fn default_manifest_serializes_to_the_contract_shape() {
        let m = gateway_manifest(&ManifestOverrides::default());
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(
            json,
            "{\"provider\":\"wowsp-gateway\",\"name\":\"WoWSP Pairing Gateway\",\
             \"protocol\":[\"v1\"],\"endpoints\":{\"relay\":\"/relay\"},\
             \"upstream\":null,\"features\":[\"pin-allocation\",\"byte-tunnel\"],\
             \"notice\":null}"
        );

        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
        assert_eq!(back.protocol, vec![PROTOCOL_V1]);
        assert!(back.features.contains(&FEATURE_PIN_ALLOCATION.to_string()));
        assert!(back.features.contains(&FEATURE_BYTE_TUNNEL.to_string()));
    }

    #[test]
    fn forwarding_station_mode_honors_only_absolute_upstreams() {
        let o = ManifestOverrides::from_raw(
            Some("https://exchange.example.org/relay"),
            Some("moving house this weekend"),
        );
        let m = gateway_manifest(&o);
        assert_eq!(
            m.upstream.as_deref(),
            Some("https://exchange.example.org/relay")
        );
        assert_eq!(m.notice.as_deref(), Some("moving house this weekend"));

        // wss upstreams are honored too.
        assert_eq!(
            ManifestOverrides::from_raw(Some("wss://x.example.org"), None)
                .upstream
                .as_deref(),
            Some("wss://x.example.org")
        );

        // Junk is ignored, not propagated: a relative path or a bare host
        // must never strand clients on a nonexistent upstream.
        let bad = [
            "",
            "   ",
            "exchange.example.org",
            "http://insecure.example.org",
            "ftp://nope.example.org",
        ];
        for raw in bad {
            assert!(
                ManifestOverrides::from_raw(Some(raw), None)
                    .upstream
                    .is_none(),
                "upstream {raw:?} must be dropped"
            );
        }
        // Blank notices stay null.
        assert!(
            ManifestOverrides::from_raw(None, Some("  "))
                .notice
                .is_none()
        );
    }

    #[test]
    fn manifest_round_trips_through_value() {
        let m = gateway_manifest(&ManifestOverrides {
            upstream: Some("wss://other.example.org".into()),
            notice: Some("hi".into()),
        });
        let v = serde_json::to_value(&m).unwrap();
        let back: Manifest = serde_json::from_value(v).unwrap();
        assert_eq!(m, back);
    }
}
