//! Pure protocol + policy core of the WoWSP pairing gateway.
//!
//! Everything here is plain Rust over an injected clock and RNG: no
//! Cloudflare types, no wasm-bindgen, no I/O. `relay-worker` (the wasm
//! crate actually deployed to Cloudflare Workers) is a thin shell that
//! routes requests and owns WebSockets while EVERY policy decision —
//! code allocation and replacement, TTLs, the per-IP brute-force guard,
//! resolve-once semantics, the data-connection cap, the binary frame
//! cap — is made by the state machines in this crate and unit-tested on
//! the host.
//!
//! The wire protocol (protocol v2 of the gateway) is documented in this
//! package's README; the type and enum names here are the executable
//! version of that document.

pub mod directory;
pub mod manifest;
pub mod protocol;
pub mod room;
pub mod route;

/// Machine id of this gateway implementation (manifest `provider`).
pub const PROVIDER_ID: &str = "wowsp-gateway";
/// Human-facing gateway name (manifest `name`).
pub const PROVIDER_NAME: &str = "WoWSP Pairing Gateway";

/// Feature id: the gateway allocates 6-digit pairing codes itself.
pub const FEATURE_PIN_ALLOCATION: &str = "pin-allocation";
/// Feature id: the gateway tunnels opaque byte streams over data sockets.
pub const FEATURE_BYTE_TUNNEL: &str = "byte-tunnel";

/// The one protocol version this gateway speaks (advertised in the
/// manifest and echoed in `welcome` frames).
pub const PROTOCOL_V1: &str = "v1";

/// Default relay base path advertised by the manifest (routes live at
/// `<base>/control`, `<base>/resolve`, `<base>/data/...`).
pub const DEFAULT_RELAY_BASE: &str = "/relay";

/// A room key is exactly 64 lowercase hex chars (minted by the desktop
/// host bridge with its OS CSPRNG).
pub fn valid_room(room: &str) -> bool {
    room.len() == 64
        && room
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A connId is 8–64 chars of `[A-Za-z0-9_-]` (minted by the client).
pub fn valid_conn_id(conn_id: &str) -> bool {
    (8..=64).contains(&conn_id.len())
        && conn_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A pairing code is exactly 6 ASCII digits.
pub fn valid_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

/// A hostId from a `hello` frame is 8–64 lowercase hex chars (minted by
/// the desktop). `hello` is optional, and so is this field's presence.
pub fn valid_host_id(host_id: &str) -> bool {
    (8..=64).contains(&host_id.len())
        && host_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validators_match_the_wire_shapes() {
        let hex64 = "a".repeat(64);
        assert!(valid_room(&hex64));
        assert!(!valid_room(&"A".repeat(64)), "uppercase hex refused");
        assert!(!valid_room(&"g".repeat(64)));
        assert!(!valid_room("deadbeef"));

        assert!(valid_conn_id("abc12345"));
        assert!(valid_conn_id(&"x".repeat(64)));
        assert!(!valid_conn_id("short7"), "7 chars is too short");
        assert!(!valid_conn_id(&"x".repeat(65)));
        assert!(!valid_conn_id("has space"));

        assert!(valid_code("000000"));
        assert!(valid_code("999999"));
        assert!(!valid_code("12345"));
        assert!(!valid_code("1234567"));
        assert!(!valid_code("12a456"));

        assert!(valid_host_id("deadbeef"));
        assert!(!valid_host_id(&"z".repeat(16)));
        assert!(!valid_host_id("short"), "5 chars is too short");
    }
}
