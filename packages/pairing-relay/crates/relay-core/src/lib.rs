//! Pure protocol + policy core of the WoWSP worker site (the dynamic
//! half of wowsp.langyo.xyz).
//!
//! Everything here is plain Rust over injected clocks and RNGs where
//! needed: no Cloudflare types, no wasm-bindgen, no I/O. `relay-worker`
//! (the wasm crate actually deployed to Cloudflare Workers) is a thin
//! shell that routes requests and owns WebSockets while EVERY policy
//! decision — the feedback pipeline's rate limits, the digest channel
//! gates, the replay-share quotas, the gateway-push auth — is made by
//! the state machines in this crate and unit-tested on the host.
//!
//! The PIN-pairing rooms (Room + Directory Durable Objects, the
//! /api/relay/* code-resolution and byte-tunnel sockets, the wire
//! protocol frames) were retired with the pairing mode on 2026-11-13;
//! the account-routed gateway push (gateway.rs) is the live
//! phone↔desktop channel.

pub mod digests;
pub mod erp;
pub mod feedback;
pub mod gateway;
pub mod headers;
pub mod manifest;
pub mod multipart;
pub mod qqbot;
pub mod replay;
pub mod route;
pub mod sponsors;

/// Machine id of this gateway implementation (manifest `provider`).
pub const PROVIDER_ID: &str = "wowsp-gateway";
/// Human-facing gateway name (manifest `name`).
pub const PROVIDER_NAME: &str = "WoWSP Gateway";

/// This gateway's own version, reported by the health document.
pub const GATEWAY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A hostId from a `hello` frame is 8–64 lowercase hex chars (minted by
/// the desktop publisher; see gateway.rs). The pairing-era room/code
/// validators went away with the PIN mode — this one serves the live
/// push namespace.
pub fn valid_host_id(host_id: &str) -> bool {
    (8..=64).contains(&host_id.len())
        && host_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_id_shape_is_validated() {
        assert!(super::valid_host_id("deadbeef"));
        assert!(super::valid_host_id(&"a".repeat(64)));
        assert!(!super::valid_host_id(&"z".repeat(16)));
        assert!(!super::valid_host_id("short"), "5 chars is too short");
        assert!(!super::valid_host_id(&"A".repeat(16)), "uppercase refused");
    }
}
