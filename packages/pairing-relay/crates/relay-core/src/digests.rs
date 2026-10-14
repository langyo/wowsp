//! Release-digest policy for the `/api/digests` family — the app's
//! second OFFICIAL channel for "which version, and which sha256 does it
//! install against" (the first being api.github.com).
//!
//! The hostname this worker serves is reachable where api.github.com is
//! not, so the app updater prefers it and cross-checks against GitHub
//! whenever both answer; a mirror proxying payload bytes can influence
//! neither channel. Everything the route serves is maintained in a
//! dedicated KV namespace by `scripts/publish_digests.py`, driven from
//! the four publish pipelines (release.yml for `v*` app tags,
//! mod_hub_publish.py for `mod-hub`, release_models.py for `res-*`,
//! publish_data_pack.py for `data-latest`).
//!
//! This module is pure policy — shapes, validation and key layout. The
//! worker crate only maps a validated request onto a KV read.

use std::collections::BTreeMap;

/// The channels the endpoint serves. Fixed set: a channel name becomes
/// part of a KV key, so unknown values are refused rather than stored
/// or looked up.
pub const DIGEST_CHANNELS: [&str; 4] = ["app", "mod-hub", "res", "data"];

/// A release-tag/digest document as stored in KV and served verbatim.
///
/// `assets` maps the release asset name to its LOWERCASE sha256 hex
/// (no `sha256:` prefix — GitHub's API spelling is stripped on publish).
/// `seq` is per-channel and strictly increasing across publishes; the
/// app refuses a doc whose seq regresses below the last one it accepted
/// (rollback guard for the channels that consume it).
///
/// `key_id` + `sig` are the optional Ed25519 signature layer
/// (`scripts/catalog_signing.py`): the signature covers the canonical
/// JSON of the doc without `sig` (sorted keys, compact separators —
/// byte-identical to serde_json's sorted-Map rendering). This worker
/// only transports them; the app verifies against compile-time pinned
/// public keys, which is what makes the KV store and the worker itself
/// unable to forge a doc (an old signed doc can still be replayed —
/// that is what the `seq` ratchet refuses).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DigestDoc {
    pub channel: String,
    pub tag: String,
    pub seq: u64,
    /// RFC 3339 timestamp of the publish run (informational; ordering
    /// is decided by `seq`, never by wall clocks).
    pub generated_at: String,
    pub assets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// Standard base64 (padded) of the 64-byte Ed25519 signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

/// KV key of the doc pinned to one tag (`digest:<channel>:<tag>`).
pub fn kv_key(channel: &str, tag: &str) -> String {
    format!("digest:{channel}:{tag}")
}

/// KV key of the channel's latest pointer (`digest-latest:<channel>` —
/// a separate prefix so a tag literally named `latest` can never
/// shadow or be shadowed by the pointer).
pub fn kv_latest_key(channel: &str) -> String {
    format!("digest-latest:{channel}")
}

/// A channel is one of the fixed names.
pub fn valid_channel(channel: &str) -> bool {
    DIGEST_CHANNELS.contains(&channel)
}

/// A tag is 1–160 chars of `[A-Za-z0-9._-]`. Every real scheme fits
/// (`v0.6.1`, `mod-hub`, `res-latest`, `data-latest`, and the long one:
/// `res-delta-<64hex>-<64hex>` at 139 chars); anything else (slashes,
/// colons, percent escapes) would leak into a KV key and is refused
/// here.
pub fn valid_tag(tag: &str) -> bool {
    (1..=160).contains(&tag.len())
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Shape check on a doc read back from KV before it is served: the doc
/// must belong to the channel it was looked up under, carry at least
/// one asset, and every asset name / digest must be well-formed. The
/// optional signature layer must be either fully present and well
/// formed or fully absent. A doc failing this is corruption (or
/// tampering) in the store — the worker refuses to serve it rather
/// than propagate it.
pub fn doc_is_sane(doc: &DigestDoc, channel: &str) -> bool {
    doc.channel == channel
        && valid_channel(&doc.channel)
        && valid_tag(&doc.tag)
        && doc.seq >= 1
        && !doc.assets.is_empty()
        && doc.assets.iter().all(|(name, sha256)| {
            (1..=128).contains(&name.len())
                && !name.contains(|c: char| c.is_control())
                && sha256.len() == 64
                && sha256.bytes().all(|b| b.is_ascii_hexdigit())
                // Lowercase spelling only (digits are not "lowercase
                // letters" — the check is "no ASCII uppercase").
                && !sha256.bytes().any(|b| b.is_ascii_uppercase())
        })
        && signature_shape_is_sane(&doc.key_id, &doc.sig)
}

/// The signature layer's transport shape: `key_id` 1–16 chars of
/// `[a-z0-9-]`, `sig` exactly the padded standard-base64 spelling of a
/// 64-byte Ed25519 signature (88 chars). Cryptographic verification is
/// the app's job — this only keeps garbage out of the wire.
fn signature_shape_is_sane(key_id: &Option<String>, sig: &Option<String>) -> bool {
    match (key_id, sig) {
        (None, None) => true,
        (Some(key_id), Some(sig)) => {
            (1..=16).contains(&key_id.len())
                && key_id.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
                })
                && sig.len() == 88
                && sig.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
        },
        // Half-signed is corruption, not a policy choice.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(channel: &str, tag: &str) -> DigestDoc {
        DigestDoc {
            channel: channel.to_string(),
            tag: tag.to_string(),
            seq: 7,
            generated_at: "2026-10-14T12:00:00Z".to_string(),
            assets: BTreeMap::from([
                ("WoWSP-0.6.1-x64-setup.exe".to_string(),
                 "a".repeat(64)),
                ("WoWSP-0.6.1-x64-lite.exe".to_string(),
                 "0123456789abcdef".repeat(4)),
            ]),
            key_id: None,
            sig: None,
        }
    }

    #[test]
    fn channels_are_a_closed_set() {
        for good in ["app", "mod-hub", "res", "data"] {
            assert!(valid_channel(good), "{good}");
        }
        for bad in ["", "App", "app ", "apps", "mod_hub", "res/", "latest"] {
            assert!(!valid_channel(bad), "{bad:?}");
        }
    }

    #[test]
    fn tags_accept_the_real_schemes_and_refuse_injection() {
        // The real delta spelling: res-delta-<64hex>-<64hex> (139 chars).
        let real_delta = format!(
            "res-delta-{}-{}",
            "a".repeat(64),
            "0123456789abcdef".repeat(4)
        );
        assert_eq!(real_delta.len(), 139);
        for good in ["v0.6.1", "mod-hub", "res-latest", "data-latest", &real_delta] {
            assert!(valid_tag(good), "{good}");
        }
        for bad in [
            "",
            "v0.6.1/../evil",
            "a:b",
            "a b",
            "a%2Fb",
            &"x".repeat(161),
        ] {
            assert!(!valid_tag(bad), "{bad:?}");
        }
    }

    #[test]
    fn keys_keep_the_latest_pointer_off_the_tag_namespace() {
        assert_eq!(kv_key("app", "v0.6.1"), "digest:app:v0.6.1");
        assert_eq!(kv_latest_key("app"), "digest-latest:app");
        // The pointer can never be produced by kv_key: different prefix.
        assert_ne!(kv_key("app", "latest"), kv_latest_key("app"));
    }

    #[test]
    fn sane_docs_pass_and_every_corruption_fails() {
        assert!(doc_is_sane(&sample("app", "v0.6.1"), "app"));

        let mut wrong_channel = sample("app", "v0.6.1");
        wrong_channel.channel = "res".to_string();
        assert!(!doc_is_sane(&wrong_channel, "app"), "channel mismatch vs lookup");

        let mut zero_seq = sample("app", "v0.6.1");
        zero_seq.seq = 0;
        assert!(!doc_is_sane(&zero_seq, "app"), "seq must start at 1");

        let mut empty = sample("app", "v0.6.1");
        empty.assets.clear();
        assert!(!doc_is_sane(&empty, "app"), "an asset-less doc is useless");

        let mut bad_hex = sample("app", "v0.6.1");
        bad_hex.assets.insert("x.exe".to_string(), "G".repeat(64));
        assert!(!doc_is_sane(&bad_hex, "app"), "non-hex digest refused");

        let mut upper_hex = sample("app", "v0.6.1");
        upper_hex.assets.insert("x.exe".to_string(), "A".repeat(64));
        assert!(!doc_is_sane(&upper_hex, "app"), "uppercase hex refused");

        let mut bad_name = sample("app", "v0.6.1");
        bad_name.assets.insert("x\n.exe".to_string(), "a".repeat(64));
        assert!(!doc_is_sane(&bad_name, "app"), "control chars in an asset name");
    }

    #[test]
    fn signature_layer_shape_is_all_or_nothing() {
        // A well-formed pair passes.
        let mut signed = sample("app", "v0.6.1");
        signed.key_id = Some("main".to_string());
        signed.sig = Some("A".repeat(86) + "==");
        assert!(doc_is_sane(&signed, "app"));

        // Half-signed is refused.
        let mut half = signed.clone();
        half.sig = None;
        assert!(!doc_is_sane(&half, "app"), "key_id without sig");
        let mut other_half = signed.clone();
        other_half.key_id = None;
        assert!(!doc_is_sane(&other_half, "app"), "sig without key_id");

        // Bad key ids and bad sig spellings are refused.
        for bad_id in ["", "Main", "key with space", "toolongkeyiddddddd"] {
            let mut doc = signed.clone();
            doc.key_id = Some(bad_id.to_string());
            assert!(!doc_is_sane(&doc, "app"), "{bad_id:?}");
        }
        for bad_sig in [
            String::new(),
            "A".repeat(87),
            "A".repeat(88).replace('A', "?"),
            "A".repeat(89),
        ] {
            let mut doc = signed.clone();
            doc.sig = Some(bad_sig.clone());
            assert!(!doc_is_sane(&doc, "app"), "{bad_sig:?}");
        }
    }

    #[test]
    fn docs_round_trip_through_json() {
        let doc = sample("mod-hub", "mod-hub");
        let bytes = serde_json::to_vec(&doc).unwrap();
        let back: DigestDoc = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(doc, back);
        // Assets stay deterministically ordered regardless of insertion.
        let text = String::from_utf8(bytes).unwrap();
        let first = text.find("WoWSP-0.6.1-x64-lite").unwrap();
        let second = text.find("WoWSP-0.6.1-x64-setup").unwrap();
        assert!(first < second, "BTreeMap orders asset names");
    }
}
