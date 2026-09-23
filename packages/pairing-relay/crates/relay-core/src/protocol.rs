//! Wire frames of the relay protocol. Control and resolve sockets speak
//! JSON TEXT frames tagged with `"type"`; data sockets speak opaque
//! BINARY frames (except the one error notice defined here).
//!
//! Backward compatibility rule: unknown inbound `type`s deserialize to
//! [`InboundFrame::Unknown`] and are ignored, and outbound frames may
//! carry extra fields — v1 clients keep working against this v2 gateway
//! (they simply never send `hello` and never read `room` on `code`).

use serde::{Deserialize, Serialize};

use crate::{FEATURE_BYTE_TUNNEL, FEATURE_PIN_ALLOCATION, PROTOCOL_V1};

/// Text frames a client may send to the gateway. Everything a v2 server
/// must understand; anything else is ignorable chatter (keepalives of
/// future dialects, etc.).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum InboundFrame {
    /// Protocol v2 handshake (control + resolve sockets). OPTIONAL —
    /// v1 clients never send it and the server must tolerate that.
    #[serde(rename = "hello")]
    Hello {
        /// Protocol version the client speaks (`"v1"`).
        protocol: String,
        /// The connecting app instance's random hex id (desktop hosts
        /// mint a stable one; phones may send any well-formed value).
        #[serde(default)]
        host_id: String,
    },
    /// Host → gateway: mint a fresh pairing code for my room.
    #[serde(rename = "allocate")]
    Allocate,
    /// Client → gateway: open data connection `connId`.
    #[serde(rename = "open")]
    Open { conn_id: String },
    /// Liveness ping (any role). Refreshes the room's idle TTL; needs
    /// no reply — Cloudflare's ~100s proxy idle cutoff is beaten by the
    /// SENDER's 30s cadence, not by an echo.
    #[serde(rename = "keepalive")]
    Keepalive,
    /// Anything unrecognized — parsed for tolerance, never acted on.
    #[serde(other)]
    Unknown,
}

/// Text frames the gateway may send to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum OutboundFrame {
    /// Reply to `hello` (only ever sent after a `hello` — v1 clients
    /// that never say hello never see it and never miss it).
    #[serde(rename = "welcome")]
    Welcome {
        protocol: String,
        provider: String,
        capabilities: Vec<String>,
    },
    /// Reply to `allocate`: the minted 6-digit code, plus the room it is
    /// bound to (the `room` field is v2 — v1 readers ignore it).
    #[serde(rename = "code")]
    Code { code: String, room: String },
    /// Allocation failed (code space exhausted, directory error). The
    /// host bridge treats it like a dropped socket and reconnects.
    #[serde(rename = "allocFailed")]
    AllocFailed,
    /// To a client control socket: this room's host is present.
    #[serde(rename = "ready")]
    Ready,
    /// To a client control socket: no host yet, keep waiting.
    #[serde(rename = "waiting")]
    Waiting,
    /// To the host: the client wants data connection `connId`.
    #[serde(rename = "conn")]
    Conn { conn_id: String },
    /// To a resolving phone: the room key the code is bound to.
    #[serde(rename = "room")]
    Room { room: String },
    /// Legacy resolve failure marker (v1 clients expect exactly this).
    #[serde(rename = "err")]
    Err,
    /// Structured error frame (protocol v2). `rate_limited` on resolve
    /// sockets, `frame_too_large`/`conn_limit` on others.
    #[serde(rename = "error")]
    Error {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u32>,
    },
}

/// The `welcome` frame this gateway sends for a `hello`.
pub fn welcome() -> OutboundFrame {
    OutboundFrame::Welcome {
        protocol: PROTOCOL_V1.to_string(),
        provider: crate::PROVIDER_ID.to_string(),
        capabilities: vec![
            FEATURE_PIN_ALLOCATION.to_string(),
            FEATURE_BYTE_TUNNEL.to_string(),
        ],
    }
}

/// Error-code ids used in [`OutboundFrame::Error`].
pub mod error_codes {
    /// Resolve rejected by the per-IP brute-force guard.
    pub const RATE_LIMITED: &str = "rate_limited";
    /// A data-socket binary frame exceeded the 256 KiB cap.
    pub const FRAME_TOO_LARGE: &str = "frame_too_large";
    /// The room already has its maximum concurrent data connections.
    pub const CONN_LIMIT: &str = "conn_limit";
}

impl OutboundFrame {
    /// Serialize to the exact text sent on the wire.
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("outbound frames always serialize")
    }
}

impl InboundFrame {
    /// Parse a text frame; malformed JSON and unknown types both land in
    /// [`InboundFrame::Unknown`] — a busy-talking client must never
    /// crash the socket handler.
    pub fn parse(text: &str) -> InboundFrame {
        serde_json::from_str(text).unwrap_or(InboundFrame::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_parses_the_contract_shape() {
        let f = InboundFrame::parse(r#"{"type":"hello","protocol":"v1","hostId":"deadbeef0011"}"#);
        assert_eq!(
            f,
            InboundFrame::Hello {
                protocol: "v1".into(),
                host_id: "deadbeef0011".into()
            }
        );
        // hostId is optional (serde default) — a phone may omit it.
        assert_eq!(
            InboundFrame::parse(r#"{"type":"hello","protocol":"v1"}"#),
            InboundFrame::Hello {
                protocol: "v1".into(),
                host_id: String::new()
            }
        );
    }

    #[test]
    fn welcome_serializes_to_the_contract_shape() {
        assert_eq!(
            welcome().to_text(),
            r#"{"type":"welcome","protocol":"v1","provider":"wowsp-gateway","capabilities":["pin-allocation","byte-tunnel"]}"#
        );
    }

    #[test]
    fn v1_frames_keep_round_tripping() {
        // The exact strings the shipped v1 client sends/expects.
        assert_eq!(
            InboundFrame::parse(r#"{"type":"allocate"}"#),
            InboundFrame::Allocate
        );
        assert_eq!(
            InboundFrame::parse(r#"{"type":"open","connId":"abc12345"}"#),
            InboundFrame::Open {
                conn_id: "abc12345".into()
            }
        );
        assert_eq!(
            InboundFrame::parse(r#"{"type":"keepalive"}"#),
            InboundFrame::Keepalive
        );
        assert_eq!(
            OutboundFrame::Code {
                code: "012345".into(),
                room: "a".repeat(64)
            }
            .to_text(),
            format!(
                r#"{{"type":"code","code":"012345","room":"{}"}}"#,
                "a".repeat(64)
            )
        );
        assert_eq!(OutboundFrame::Ready.to_text(), r#"{"type":"ready"}"#);
        assert_eq!(OutboundFrame::Waiting.to_text(), r#"{"type":"waiting"}"#);
        assert_eq!(
            OutboundFrame::Conn {
                conn_id: "abc12345".into()
            }
            .to_text(),
            r#"{"type":"conn","connId":"abc12345"}"#
        );
        assert_eq!(
            OutboundFrame::Room {
                room: "b".repeat(64)
            }
            .to_text(),
            format!(r#"{{"type":"room","room":"{}"}}"#, "b".repeat(64))
        );
        assert_eq!(OutboundFrame::Err.to_text(), r#"{"type":"err"}"#);
    }

    #[test]
    fn error_frames_carry_optional_size() {
        assert_eq!(
            OutboundFrame::Error {
                code: error_codes::RATE_LIMITED.into(),
                size: None
            }
            .to_text(),
            r#"{"type":"error","code":"rate_limited"}"#
        );
        assert_eq!(
            OutboundFrame::Error {
                code: error_codes::FRAME_TOO_LARGE.into(),
                size: Some(300_000)
            }
            .to_text(),
            r#"{"type":"error","code":"frame_too_large","size":300000}"#
        );
    }

    #[test]
    fn unknown_and_garbage_frames_are_tolerated() {
        assert_eq!(InboundFrame::parse("junk"), InboundFrame::Unknown);
        assert_eq!(
            InboundFrame::parse(r#"{"type":"nope","x":1}"#),
            InboundFrame::Unknown
        );
        assert_eq!(InboundFrame::parse(""), InboundFrame::Unknown);
        assert_eq!(
            InboundFrame::parse(r#"{"type":"open"}"#),
            InboundFrame::Unknown,
            "open without connId is chatter, not a crash"
        );
    }
}
