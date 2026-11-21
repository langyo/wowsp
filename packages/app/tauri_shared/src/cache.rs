//! Cache-mesh client wire types (docs/en/designs/cache-mesh.md §2, §6).
//!
//! The stats-cache mesh lets a WoWSP client route its stats-family lookups
//! through self-hostable cache servers (official node, community nodes,
//! a legion's own box) instead of dialing every WG/Lesta/vortex upstream
//! itself — one player's slow 30 s fetch becomes everyone's 100 ms cache
//! hit. Everything crossing the Tauri IPC boundary for that surface —
//! the `/api/health` capability manifest the probe parses and the
//! per-server probe rows the settings pane renders — lives here so the
//! webui mirrors one source of truth.

use serde::{Deserialize, Serialize};

/// The official cache-mesh node root: the default `stats_cache_servers`
/// entry and the autodiscover broadcast source (`GET /api/peers`, §5.1).
pub const OFFICIAL_CACHE_SERVER_URL: &str = "https://wowsp.langyo.xyz";

/// A node's capability block of `GET /api/health` (§2). Absent on an old
/// deployment or a foreign 200 — "gateway only", unusable for stats. Every
/// field defaults to `false` so a partially-shaped block still parses.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CapabilitiesDoc {
    /// `/gateway/*` battle-push WebSocket namespace.
    pub gateway: bool,
    /// `/api/lookup/*` stats-cache proxy — the capability the client
    /// actually keys on (autodiscover only adopts lookup nodes).
    pub lookup: bool,
    /// `/api/peers/*` registry (list + announce).
    pub peers: bool,
    /// `/api/blocks/*` (+ `/ipfs/*` alias) content store.
    pub blocks: bool,
}

/// The `node` block of `GET /api/health` (§2): mesh telemetry identity —
/// not a secret, it lets telemetry tell restarts from different nodes
/// apart. Informational for the settings pane.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct NodeDoc {
    /// 32 lowercase hex, stable per deployment.
    pub id: String,
    /// `official` | `community`.
    pub role: String,
    /// Whether the node pulls blocks from peers on a local cache miss (§5.4).
    pub sync: bool,
    /// Where this node subscribes the server list from.
    pub peers_upstream: String,
}

/// `GET /api/health` as the cache-mesh probe reads it (§2): the gateway
/// manifest plus the mesh keys. Lenient on purpose — unknown fields are
/// ignored and every known field defaults, because a 200 from an old
/// deployment (or a captive portal) must parse, not fail the probe; the
/// caller separates "alive but gateway-only" (`capabilities: None`) from
/// a foreign body itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CacheNodeHealthDoc {
    pub ok: bool,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<CapabilitiesDoc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<NodeDoc>,
}

/// One `stats_cache_probe` row (§6.3): the server root, whether it
/// answered a usable `/api/health`, the round-trip time, its capability
/// block and the failure text (`None` when ok).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatsCacheProbeRow {
    /// Normalized server root, exactly as probed.
    pub url: String,
    /// `true` when the health document answered 2xx and parsed.
    pub ok: bool,
    pub latency_ms: u64,
    /// The answered capability block. An alive node without the block
    /// reports `lookup: false` here (gateway-only, §2).
    pub capabilities: Option<CapabilitiesDoc>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §2 wire shape: the full manifest parses, and a body WITHOUT the
    /// capabilities object still parses (gateway-only node) — the probe's
    /// leniency contract.
    #[test]
    fn health_doc_parses_with_and_without_capabilities() {
        let full: CacheNodeHealthDoc = serde_json::from_str(
            r#"{
                "ok": true,
                "provider": "wowsp-gateway",
                "name": "WoWSP Gateway",
                "version": "0.5.0",
                "notice": null,
                "capabilities": { "gateway": true, "lookup": true, "peers": true, "blocks": true },
                "node": { "id": "8f14e45fceea167a5a36dedd4bea2543", "role": "official", "sync": true, "peersUpstream": "https://wowsp.langyo.xyz" }
            }"#,
        )
        .expect("full manifest parses");
        assert_eq!(
            full.capabilities,
            Some(CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true
            })
        );
        assert_eq!(
            full.node.as_ref().map(|n| n.role.as_str()),
            Some("official")
        );

        let legacy: CacheNodeHealthDoc =
            serde_json::from_str(r#"{"ok":true,"name":"old","version":"0.1.0"}"#)
                .expect("legacy manifest parses");
        assert!(
            legacy.capabilities.is_none(),
            "no capabilities = gateway-only"
        );
        assert_eq!(legacy.node, None);
    }

    /// A partial capability block defaults its missing fields to false —
    /// a node that only advertises lookup parses without failing.
    #[test]
    fn capability_block_defaults_missing_fields() {
        let doc: CacheNodeHealthDoc =
            serde_json::from_str(r#"{"ok":true,"capabilities":{"lookup":true}}"#)
                .expect("partial capabilities parse");
        assert_eq!(
            doc.capabilities,
            Some(CapabilitiesDoc {
                gateway: false,
                lookup: true,
                peers: false,
                blocks: false
            })
        );
    }

    /// The probe row serializes camelCase for the IPC boundary.
    #[test]
    fn probe_row_serializes_camel_case() {
        let row = StatsCacheProbeRow {
            url: "https://wowsp.langyo.xyz".into(),
            ok: true,
            latency_ms: 42,
            capabilities: Some(CapabilitiesDoc::default()),
            error: None,
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["latencyMs"], 42);
        assert_eq!(json["capabilities"]["lookup"], false);
    }
}
