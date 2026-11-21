//! The `/api/health` document — liveness plus identity. One job now that
//! the pairing relay is retired: tell a caller (an operator, a monitor,
//! an app probing the site) that the worker is alive and which
//! implementation answered. The pairing-era fields (protocol list,
//! minimum client version, relay endpoints, feature ids, upstream
//! forwarding) went away with the PIN pairing mode on 2026-11-13 — the
//! account-routed gateway push serves its own health document at
//! `/gateway/health` (see gateway.rs), and the apps no longer consume
//! this one.
//!
//! The cache-mesh contract (docs/en/designs/cache-mesh.md §2) adds two
//! members: `capabilities` (which namespaces this deployment serves)
//! and `node` (the mesh identity of this deployment). BOTH are
//! serde-default on every field, in both directions: an old deployment's
//! document (no `capabilities`/`node` at all) parses into the all-off
//! defaults — "unusable for stats, move on" — and this implementation
//! always serializes them, so new readers see one stable shape.

use serde::{Deserialize, Serialize};

use crate::{GATEWAY_VERSION, PROVIDER_ID, PROVIDER_NAME};

/// The capability vector of one deployment (§2). A missing member (or
/// a missing `capabilities` object entirely — an old deployment or a
/// foreign 200) defaults to `false`: the lookup client treats the node
/// as unusable for that namespace and moves on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CapabilitiesDoc {
    /// `/gateway/*` battle-push WebSocket namespace.
    pub gateway: bool,
    /// `/api/lookup/*` stats-cache proxy.
    pub lookup: bool,
    /// `/api/peers/*` registry (list + announce).
    pub peers: bool,
    /// `/api/blocks/*` (+`/ipfs/*`) content store.
    pub blocks: bool,
}

/// The mesh identity of one deployment (§2 `node`). `id` is 32
/// lowercase hex chars, stable per deployment (the Worker keeps it in
/// KV `node:id`; the native server persists it in its data dir) — not
/// a secret, it lets mesh telemetry tell restarts from different nodes
/// apart. Defaults are the all-off placeholder so an old document
/// parses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NodeDoc {
    /// Stable per-deployment id (32 lowercase hex; empty on an old
    /// deployment's parsed document).
    pub id: String,
    /// `official` | `community` (informational).
    pub role: String,
    /// Whether this node pulls blocks from peers on a local cache miss
    /// (§5.4).
    pub sync: bool,
    /// Where this node subscribes the server list from (official
    /// default); also informational for humans.
    pub peers_upstream: Option<String>,
}

impl NodeDoc {
    /// Is `id` the §2 shape (32 lowercase hex)?
    pub fn valid_id(id: &str) -> bool {
        id.len() == 32
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

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
    /// The §2 capability vector (all-off defaults; always serialized).
    #[serde(default)]
    pub capabilities: CapabilitiesDoc,
    /// The §2 mesh identity (all-off defaults; always serialized).
    #[serde(default)]
    pub node: NodeDoc,
}

/// Operator overrides from worker environment variables. Both optional;
/// the plain gateway serves `{ notice: null }` with the all-off
/// capability vector and node doc.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManifestOverrides {
    /// `GATEWAY_NOTICE` — free-form operator message.
    pub notice: Option<String>,
    /// The §2 capability vector this deployment answers.
    pub capabilities: CapabilitiesDoc,
    /// The §2 mesh identity this deployment answers.
    pub node: NodeDoc,
}

impl ManifestOverrides {
    /// Build the override set from a raw environment string (already
    /// trimmed by the caller or here). Capabilities/node keep their
    /// all-off defaults — a deployment that serves the cache-mesh
    /// namespaces fills them in explicitly.
    pub fn from_raw(notice: Option<&str>) -> Self {
        Self {
            notice: notice
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            ..Self::default()
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
        capabilities: overrides.capabilities,
        node: overrides.node.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_health_serializes_to_the_contract_shape() {
        let m = gateway_manifest(&ManifestOverrides::default());
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(
            json,
            "{\"ok\":true,\"provider\":\"wowsp-gateway\",\"name\":\"WoWSP Gateway\",\"version\":\"0.5.0\",\"notice\":null,\"capabilities\":{\"gateway\":false,\"lookup\":false,\"peers\":false,\"blocks\":false},\"node\":{\"id\":\"\",\"role\":\"\",\"sync\":false,\"peersUpstream\":null}}"
        );
    }

    #[test]
    fn capability_manifest_serializes_to_the_mesh_contract_shape() {
        let m = gateway_manifest(&ManifestOverrides {
            notice: None,
            capabilities: CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks: true,
            },
            node: NodeDoc {
                id: "8f14e45fceea167a5a36dedd4bea2543".into(),
                role: "official".into(),
                sync: true,
                peers_upstream: Some("https://wowsp.langyo.xyz".into()),
            },
        });
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(
            json,
            "{\"ok\":true,\"provider\":\"wowsp-gateway\",\"name\":\"WoWSP Gateway\",\"version\":\"0.5.0\",\"notice\":null,\"capabilities\":{\"gateway\":true,\"lookup\":true,\"peers\":true,\"blocks\":true},\"node\":{\"id\":\"8f14e45fceea167a5a36dedd4bea2543\",\"role\":\"official\",\"sync\":true,\"peersUpstream\":\"https://wowsp.langyo.xyz\"}}"
        );
        // Round-trips through the same type.
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn old_manifest_without_capabilities_parses_all_off() {
        // An old deployment's document (or a foreign 200): no
        // capabilities, no node — §2's "gateway only, unusable for
        // stats" reading.
        let old = "{\"ok\":true,\"provider\":\"wowsp-gateway\",\"name\":\"WoWSP Gateway\",\"version\":\"0.4.9\",\"notice\":null}";
        let m: Manifest = serde_json::from_str(old).unwrap();
        assert_eq!(m.capabilities, CapabilitiesDoc::default());
        assert_eq!(m.node, NodeDoc::default());
        assert_eq!(m.version, "0.4.9");
    }

    #[test]
    fn partial_capability_members_default_off() {
        // A forward-compatible deployment listing only some members.
        let partial = "{\"ok\":true,\"provider\":\"wowsp-gateway\",\"name\":\"x\",\"version\":\"1\",\"notice\":null,\"capabilities\":{\"lookup\":true},\"node\":{\"id\":\"8f14e45fceea167a5a36dedd4bea2543\",\"role\":\"community\"}}";
        let m: Manifest = serde_json::from_str(partial).unwrap();
        assert!(m.capabilities.lookup);
        assert!(!m.capabilities.gateway);
        assert!(!m.capabilities.blocks);
        assert!(!m.node.sync);
        assert_eq!(m.node.peers_upstream, None);
    }

    #[test]
    fn notice_override_round_trips() {
        let m = gateway_manifest(&ManifestOverrides {
            notice: Some("maintenance window".into()),
            ..ManifestOverrides::default()
        });
        assert_eq!(m.notice.as_deref(), Some("maintenance window"));
        let back: Manifest = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn node_id_shape_is_validated() {
        assert!(NodeDoc::valid_id("8f14e45fceea167a5a36dedd4bea2543"));
        assert!(
            !NodeDoc::valid_id("8F14E45FCEEA167A5A36DEDD4BEA2543"),
            "uppercase"
        );
        assert!(!NodeDoc::valid_id("short"));
        assert!(!NodeDoc::valid_id(&"z".repeat(32)));
    }
}
