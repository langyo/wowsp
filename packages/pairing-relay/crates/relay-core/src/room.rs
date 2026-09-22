//! Per-room connection accounting and the binary frame cap — the pure
//! half of the Room Durable Object's policy.
//!
//! The DO keeps the actual `WebSocket` handles in its own map keyed
//! identically to this one and consults [`RoomConns`] for every
//! decision, which keeps the cap logic testable on the host.

/// Maximum concurrent data connections per room. The phone client is
/// strictly sequential (one request tunnel at a time); 4 covers a
/// reconnect overlap and an aggressive parallel client, and bounds the
/// DO's held-open socket pairs on the free tier.
pub const MAX_DATA_CONNECTIONS: usize = 4;

/// Hard cap on a single BINARY frame crossing a data socket. The
/// protocol mandates ≤ 256 KiB — far under Cloudflare's 32 MiB
/// WebSocket message ceiling (the cap is a design choice bounding
/// per-frame buffering in the DO, not a platform workaround), and far
/// above any HTTP request/response chunk the pairing exchange produces.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

/// Which half of a conn a socket belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The phone (the side that dialed the resolved code's room).
    Client,
    /// The desktop bridge (the room's host).
    Host,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Client => "client",
            Side::Host => "host",
        }
    }

    /// Parse the `role`/`side` query value (`host` | `client`).
    pub fn parse(raw: Option<&str>) -> Option<Side> {
        match raw {
            Some("host") => Some(Side::Host),
            Some("client") => Some(Side::Client),
            _ => None,
        }
    }
}

/// Why a client's `open` request was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// Malformed connId (must be 8–64 of `[A-Za-z0-9_-]`).
    InvalidId,
    /// A connection with this connId already exists.
    Duplicate,
    /// The room already holds [`MAX_DATA_CONNECTIONS`] connections.
    ConnLimit,
}

/// What happened when a data socket attached to a conn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachOutcome {
    /// Both halves are in — start piping bytes.
    Paired,
    /// Only one half so far — hold until the peer arrives.
    HalfOpen,
    /// No such connId was ever opened (or it already finished).
    UnknownId,
    /// This half attached twice (client dial retry after success).
    SideTaken,
}

/// Live connection table for one room.
#[derive(Debug, Default)]
pub struct RoomConns {
    conns: Vec<(String, Halves)>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Halves {
    client: bool,
    host: bool,
}

impl Halves {
    fn count(self) -> usize {
        usize::from(self.client) + usize::from(self.host)
    }
}

impl RoomConns {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of tracked connections (open OR paired).
    pub fn len(&self) -> usize {
        self.conns.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.conns.is_empty()
    }

    /// A client asked to open `connId`. Reserves a slot; the actual
    /// sockets attach later by id.
    pub fn open(&mut self, conn_id: &str) -> Result<(), OpenError> {
        if !crate::valid_conn_id(conn_id) {
            return Err(OpenError::InvalidId);
        }
        if self.conns.iter().any(|(id, _)| id == conn_id) {
            return Err(OpenError::Duplicate);
        }
        if self.conns.len() >= MAX_DATA_CONNECTIONS {
            return Err(OpenError::ConnLimit);
        }
        self.conns.push((conn_id.to_string(), Halves::default()));
        Ok(())
    }

    /// A data socket arrived for `connId` on `side`.
    pub fn attach(&mut self, conn_id: &str, side: Side) -> AttachOutcome {
        let Some((_, halves)) = self.conns.iter_mut().find(|(id, _)| id == conn_id) else {
            return AttachOutcome::UnknownId;
        };
        let taken = match side {
            Side::Client => halves.client,
            Side::Host => halves.host,
        };
        if taken {
            return AttachOutcome::SideTaken;
        }
        match side {
            Side::Client => halves.client = true,
            Side::Host => halves.host = true,
        }
        if halves.client && halves.host {
            AttachOutcome::Paired
        } else {
            AttachOutcome::HalfOpen
        }
    }

    /// One half went away (close or error). The connection dies with
    /// its FIRST departing half — a pipe is useless without both ends —
    /// and the caller closes the surviving peer. Returns `true` when a
    /// tracked conn was actually dropped.
    pub fn detach(&mut self, conn_id: &str) -> bool {
        let idx = self.conns.iter().position(|(id, _)| id == conn_id);
        let Some(idx) = idx else {
            return false;
        };
        self.conns.remove(idx);
        true
    }

    /// Whether both halves of `conn_id` are attached.
    pub fn is_paired(&self, conn_id: &str) -> bool {
        self.conns
            .iter()
            .any(|(id, h)| id == conn_id && h.count() == 2)
    }

    /// Drop every connection (room teardown / idle alarm).
    pub fn clear(&mut self) {
        self.conns.clear();
    }
}

/// Verdict on one inbound binary frame by size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameVerdict {
    /// Forward it verbatim.
    Ok,
    /// Oversized — error-close THAT connection after a text notice.
    TooLarge { size: usize, cap: usize },
}

/// Judge one binary frame.
pub fn frame_verdict(size: usize) -> FrameVerdict {
    if size > MAX_FRAME_BYTES {
        FrameVerdict::TooLarge {
            size,
            cap: MAX_FRAME_BYTES,
        }
    } else {
        FrameVerdict::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CID: &str = "conn0001";

    #[test]
    fn open_tracks_and_enforces_the_connection_cap() {
        let mut conns = RoomConns::new();
        for n in 0..MAX_DATA_CONNECTIONS {
            conns.open(&format!("conn{n:04}")).unwrap();
        }
        assert_eq!(
            conns.open("conn9999").unwrap_err(),
            OpenError::ConnLimit,
            "the 5th concurrent data connection is refused"
        );
        // Freeing one slot lets a new conn in.
        assert!(conns.detach("conn0000"));
        conns.open("conn9999").unwrap();
        assert_eq!(conns.len(), MAX_DATA_CONNECTIONS);
    }

    #[test]
    fn open_validates_and_deduplicates_ids() {
        let mut conns = RoomConns::new();
        assert_eq!(conns.open("short").unwrap_err(), OpenError::InvalidId);
        assert_eq!(
            conns.open(&"x".repeat(65)).unwrap_err(),
            OpenError::InvalidId
        );
        assert_eq!(conns.open("has space").unwrap_err(), OpenError::InvalidId);
        conns.open(CID).unwrap();
        assert_eq!(conns.open(CID).unwrap_err(), OpenError::Duplicate);
    }

    #[test]
    fn attach_pairs_only_when_both_halves_arrive() {
        let mut conns = RoomConns::new();
        conns.open(CID).unwrap();
        assert_eq!(conns.attach(CID, Side::Client), AttachOutcome::HalfOpen);
        assert!(!conns.is_paired(CID));
        assert_eq!(conns.attach(CID, Side::Host), AttachOutcome::Paired);
        assert!(conns.is_paired(CID));
        // A retried half on a paired conn is a conflict, not a re-pair.
        assert_eq!(conns.attach(CID, Side::Client), AttachOutcome::SideTaken);
        // Unknown ids never grow the table.
        assert_eq!(
            conns.attach("nope0001", Side::Client),
            AttachOutcome::UnknownId
        );
    }

    #[test]
    fn first_detach_kills_the_whole_connection() {
        let mut conns = RoomConns::new();
        conns.open(CID).unwrap();
        conns.attach(CID, Side::Client);
        conns.attach(CID, Side::Host);
        assert!(conns.detach(CID));
        assert_eq!(conns.attach(CID, Side::Host), AttachOutcome::UnknownId);
        assert!(conns.is_empty());
        assert!(!conns.detach(CID));
    }

    #[test]
    fn frame_cap_is_256_kib_exclusive() {
        assert_eq!(MAX_FRAME_BYTES, 262_144, "the cap is exactly 256 KiB");
        assert_eq!(frame_verdict(0), FrameVerdict::Ok);
        assert_eq!(frame_verdict(65_536), FrameVerdict::Ok);
        // Exactly at the cap passes…
        assert_eq!(frame_verdict(262_144), FrameVerdict::Ok);
        // …one byte over error-closes the connection.
        assert_eq!(
            frame_verdict(262_145),
            FrameVerdict::TooLarge {
                size: 262_145,
                cap: 262_144
            }
        );
        // Far beyond the 256 KiB tunnel cap too (and still far under
        // the platform's 32 MiB message ceiling — the verdict stays
        // well-defined for any size a client throws at us).
        assert!(matches!(
            frame_verdict(2 * 1024 * 1024),
            FrameVerdict::TooLarge { .. }
        ));
    }

    #[test]
    fn side_parses_role_and_side_query_spellings() {
        assert_eq!(Side::parse(Some("host")), Some(Side::Host));
        assert_eq!(Side::parse(Some("client")), Some(Side::Client));
        assert_eq!(Side::parse(None), None);
        assert_eq!(Side::parse(Some("sidekick")), None);
        assert_eq!(Side::Host.as_str(), "host");
        assert_eq!(Side::Client.as_str(), "client");
    }
}
