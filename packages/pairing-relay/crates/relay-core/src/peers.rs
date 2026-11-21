//! Peer registry + mesh sync policy — the `/api/peers/*` namespace
//! (design contract: docs/en/designs/cache-mesh.md §5). Pure policy,
//! host-tested: URL validators, the announce body gate, the registry
//! budgets and the merge rule live here; the transports (relay-worker,
//! native relay-server, Vercel adapter) own the I/O (KV rows, the
//! liveness callback, the upstream list fetch).
//!
//! - `valid_public_peer_url` — §5.2's shape gate: https names only
//!   (an IP literal or an http URL is NEVER published in a public
//!   list, §5.3), no userinfo, no explicit port except the https
//!   default, no query/fragment, ≤ 253 chars. Returns the normalized
//!   origin+path spelling (host lowercased, default port and trailing
//!   slash trimmed) — the registry key and the wire spelling are the
//!   same string, so re-announces refresh the same row.
//! - `valid_private_peer_url` — the §5.3 LAN shape: http allowed, IP
//!   literals allowed, and an EXPLICIT PORT allowed (the native
//!   server's default bind is 127.0.0.1:8787 — a portless rule would
//!   unregister every real LAN node; private rows are never
//!   re-broadcast, so the looser shape costs nothing publicly).
//! - `merge_peers` — §5.1's gossip rule: a node's view = own rows ∪
//!   upstream's, OWN ROWS WINNING by url, private rows excluded,
//!   capped at [`PEERS_MAX`].

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::manifest::CapabilitiesDoc;

// ── budgets (§5.2) ─────────────────────────────────────────────────────

/// Registry cap: the oldest-`lastSeenAt` row is evicted past it.
pub const PEERS_MAX: usize = 128;
/// Announce rate limit per IP (§5.2.4).
pub const ANNOUNCE_RATE_PER_HOUR: u64 = 10;
/// Row lifetime: 48 h, re-announce refreshes `lastSeenAt` (§5.2.3).
pub const PEER_TTL_SECS: u64 = 172_800;
/// Announce-body ceiling (url + a short contact line).
pub const ANNOUNCE_BODY_MAX: usize = 8 * 1024;
/// The optional contact line's length ceiling (§5.2 body shape).
pub const CONTACT_MAX_CHARS: usize = 120;
/// URL length ceiling — a legal hostname boundary (§5.2.1).
pub const URL_MAX_LEN: usize = 253;
/// KV key prefix of one registry row (`peer:<url>`).
pub const PEER_KEY_PREFIX: &str = "peer:";
/// KV key of the cached upstream list (§5.1's subscription, fetched
/// at most once per minute).
pub const UPSTREAM_CACHE_KEY: &str = "peers:upstream";
/// How long a fetched upstream list stays authoritative (60 s, the
/// list route's own max-age).
pub const UPSTREAM_CACHE_TTL_SECS: u64 = 60;
/// Rate-counter key prefix.
pub const ANNOUNCE_RATE_KEY_PREFIX: &str = "peers:rl:";
/// §5.4: how many peers a pull-through miss asks before the real
/// upstream (`SYNC_PEERS_MAX` var overrides).
pub const SYNC_PEERS_MAX_DEFAULT: usize = 3;
/// §5.4: per-peer block fetch budget (3 s each).
pub const PEER_FETCH_BUDGET_SECS: u64 = 3;

/// The KV counter key for one IP's hourly announce budget (the lookup
/// namespace's `lookup:rl:` shape).
pub fn announce_rate_key(ip: &str, now_ms: i64) -> String {
    format!(
        "{ANNOUNCE_RATE_KEY_PREFIX}{}:{ip}",
        now_ms.div_euclid(3_600_000)
    )
}

// ── wire shapes (§5.1) ─────────────────────────────────────────────────

/// One registry row (§5.1's peer object). `private` defaults to
/// false so public lists (which never carry it) parse into the same
/// type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRow {
    /// Normalized node URL (origin + optional path root).
    pub url: String,
    /// The capabilities the node's /api/health answered with.
    pub capabilities: CapabilitiesDoc,
    /// `official` | `community` (informational).
    pub role: String,
    /// The node's stable id (its manifest node.id; empty when the
    /// callback answered an old deployment).
    pub node_id: String,
    /// Unix seconds of the first accepted announce.
    pub added_at: u64,
    /// Unix seconds of the latest accepted announce.
    pub last_seen_at: u64,
    /// Optional operator note (the announce contact line).
    pub notice: Option<String>,
    /// §5.3: an http/IP-literal row — stored for the local fleet,
    /// never re-broadcast.
    #[serde(default)]
    pub private: bool,
}

/// The list document (§5.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeersDoc {
    /// Shape version (1).
    pub v: u32,
    /// Unix seconds of this rendering.
    pub generated_at: u64,
    /// Public rows only (private rows never reach a list).
    pub peers: Vec<PeerRow>,
}

/// Build a list document from already-public rows.
pub fn peers_doc(peers: Vec<PeerRow>, generated_at: u64) -> PeersDoc {
    PeersDoc {
        v: 1,
        generated_at,
        peers,
    }
}

// ── URL validators ─────────────────────────────────────────────────────

/// Is this host an IP literal (v4 dotted quad / decimal / hex, or a
/// bracketed v6)? Public mesh names only — §5.2.1.
fn is_ip_literal(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return inner.contains(':');
    }
    if host.starts_with("0x") || (host.bytes().all(|b| b.is_ascii_digit()) && !host.is_empty()) {
        return true;
    }
    let quad: Vec<&str> = host.split('.').collect();
    quad.len() == 4
        && quad.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u8>().is_ok()
        })
}

/// Reject the characters a URL key must never carry (control chars,
/// whitespace, and the delimiters that would smuggle a query or
/// fragment past the parser).
fn has_bad_chars(s: &str) -> bool {
    s.chars()
        .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | '@'))
}

/// Split `<scheme>://<authority><path>` with the §5.2 rules. The
/// caller decides which scheme/host shapes are acceptable. `host`
/// keeps its brackets on a v6 literal (lowercased inside), so the
/// rebuilt URL spelling round-trips.
struct UrlParts {
    scheme: String,
    host: String,
    port: Option<u16>,
    path: String,
}

fn parse_peer_url(raw: &str) -> Option<UrlParts> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > URL_MAX_LEN || has_bad_chars(raw) {
        return None;
    }
    // Scheme (case-insensitive per RFC 3986; normalized lowercase).
    let (scheme, rest) = raw.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..end];
    let path = rest[end..].to_string();
    if authority.is_empty() {
        return None;
    }
    // Authority → host + optional port. A v6 literal is bracketed; the
    // port (if any) sits after the closing bracket. A bare host with a
    // ':' that is not a legal port tail is refused outright.
    let (bare, port): (&str, Option<&str>) = if authority.starts_with('[') {
        let close = authority.find(']')?;
        let host = &authority[..=close];
        let tail = &authority[close + 1..];
        if tail.is_empty() {
            (host, None)
        } else {
            (host, Some(tail.strip_prefix(':')?))
        }
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    let host = if let Some(inner) = bare.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        format!("[{}]", inner.to_ascii_lowercase())
    } else {
        bare.to_ascii_lowercase()
    };
    if host.is_empty() || host == "[]" {
        return None;
    }
    let port = match port {
        None => None,
        Some(digits) => {
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some(digits.parse::<u16>().ok()?)
        },
    };
    Some(UrlParts {
        scheme,
        host,
        port,
        path,
    })
}

/// §5.2's public shape gate → the normalized node URL
/// (`https://host[/path]`: host lowercased, `:443` and any trailing
/// slash trimmed). Names only — an IP literal, userinfo, query,
/// fragment, non-default port or oversize URL is refused.
pub fn valid_public_peer_url(raw: &str) -> Option<String> {
    let parts = parse_peer_url(raw)?;
    if parts.scheme != "https" || is_ip_literal(&parts.host) {
        return None;
    }
    if let Some(port) = parts.port {
        if port != 443 {
            return None;
        }
    }
    let path = parts.path.trim_end_matches('/');
    Some(format!("https://{}{path}", parts.host))
}

/// §5.3's private/LAN shape gate → the normalized node URL. http and
/// IP literals are allowed, and an explicit (custom) port is KEPT —
/// LAN nodes live on ports like 8787; only the scheme-default port is
/// trimmed. Such rows are stored `private: true` and filtered from
/// every public list by `merge_peers`.
pub fn valid_private_peer_url(raw: &str) -> Option<String> {
    let parts = parse_peer_url(raw)?;
    let default_port = if parts.scheme == "https" { 443 } else { 80 };
    let port = match parts.port {
        Some(port) if port != default_port => Some(port),
        _ => None,
    };
    let path = parts.path.trim_end_matches('/');
    match port {
        Some(port) => Some(format!("{}://{}:{port}{path}", parts.scheme, parts.host)),
        None => Some(format!("{}://{}{path}", parts.scheme, parts.host)),
    }
}

/// The registry KV key of one row (`peer:<url>`).
pub fn row_key(url: &str) -> String {
    format!("{PEER_KEY_PREFIX}{url}")
}

// ── announce body (§5.2) ───────────────────────────────────────────────

/// A parsed announce body: `{"url": "https://…", "contact": "…"}`.
#[derive(Debug, Clone, PartialEq)]
pub struct AnnounceBody {
    /// The RAW url as announced (validate with the two gates above).
    pub url: String,
    /// Optional contact line, ≤ [`CONTACT_MAX_CHARS`] chars, trimmed.
    pub contact: Option<String>,
}

/// Why an announce body was refused (the transports surface the code
/// verbatim in their 400 documents).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnounceError {
    /// Not JSON / not an object.
    BadJson,
    /// Missing or empty `url` member.
    BadShape,
    /// `contact` over [`CONTACT_MAX_CHARS`] chars.
    BadContact,
}

impl AnnounceError {
    /// The wire code of this refusal.
    pub fn code(self) -> &'static str {
        match self {
            AnnounceError::BadJson => "bad_json",
            AnnounceError::BadShape => "bad_shape",
            AnnounceError::BadContact => "bad_contact",
        }
    }
}

/// Parse + shape-gate an announce body (§5.2). The URL's public/private
/// classification is the transport's next step (this only proves the
/// member exists and is a non-empty string).
pub fn parse_announce_body(json: &str) -> Result<AnnounceBody, AnnounceError> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| AnnounceError::BadJson)?;
    let url = value
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(AnnounceError::BadShape)?
        .to_string();
    if url.len() > URL_MAX_LEN {
        return Err(AnnounceError::BadShape);
    }
    let contact = value
        .get("contact")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(contact) = &contact {
        if contact.chars().count() > CONTACT_MAX_CHARS {
            return Err(AnnounceError::BadContact);
        }
    }
    Ok(AnnounceBody { url, contact })
}

// ── merge + sync selection (§5.1/§5.4) ─────────────────────────────────

/// §5.1's merge: own rows win by url, private rows excluded (from both
/// sides — an upstream list must never leak a private row, and a
/// defensive filter costs nothing), result capped at [`PEERS_MAX`].
/// Own rows keep their order first, then upstream-only rows in theirs.
pub fn merge_peers(own: &[PeerRow], upstream: &[PeerRow]) -> Vec<PeerRow> {
    let mut merged: Vec<PeerRow> = Vec::with_capacity(own.len() + upstream.len());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in own.iter().chain(upstream) {
        if row.private || !seen.insert(row.url.clone()) {
            continue;
        }
        if merged.len() == PEERS_MAX {
            break;
        }
        merged.push(row.clone());
    }
    merged
}

/// §5.4: the pull-through candidates — the first `max` rows that
/// declared the `blocks` capability.
pub fn sync_candidates<'a>(peers: &'a [PeerRow], max: usize) -> Vec<&'a PeerRow> {
    peers
        .iter()
        .filter(|row| !row.private && row.capabilities.blocks)
        .take(max)
        .collect()
}

/// The list route's weak ETag (§5.1: cheap revalidation): a sha256
/// over the peers array's canonical JSON — `generatedAt` is
/// deliberately outside the hash so a re-render of identical content
/// still revalidates.
pub fn peers_etag(peers: &[PeerRow]) -> String {
    let digest = Sha256::digest(serde_json::to_string(peers).unwrap_or_default().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("W/\"{}\"", &hex[..16])
}

// ── unit tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn row(url: &str, blocks: bool, private: bool) -> PeerRow {
        PeerRow {
            url: url.to_string(),
            capabilities: CapabilitiesDoc {
                gateway: true,
                lookup: true,
                peers: true,
                blocks,
            },
            role: "community".into(),
            node_id: "8f14e45fceea167a5a36dedd4bea2543".into(),
            added_at: 1,
            last_seen_at: 2,
            notice: None,
            private,
        }
    }

    // ── public gate ────────────────────────────────────────────────

    #[test]
    fn public_gate_normalizes_legal_names() {
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org"),
            Some("https://wowsp.example.org".into())
        );
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org/"),
            Some("https://wowsp.example.org".into())
        );
        assert_eq!(
            valid_public_peer_url("HTTPS://WOWSP.Example.ORG"),
            Some("https://wowsp.example.org".into())
        );
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org:443/mesh/"),
            Some("https://wowsp.example.org/mesh".into())
        );
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org/mesh"),
            Some("https://wowsp.example.org/mesh".into())
        );
    }

    #[test]
    fn public_gate_refuses_non_names() {
        // http stays private (§5.3).
        assert_eq!(valid_public_peer_url("http://wowsp.example.org"), None);
        // IP literals never publish (§5.3).
        assert_eq!(valid_public_peer_url("https://192.0.2.7"), None);
        assert_eq!(valid_public_peer_url("https://[2001:db8::1]/"), None);
        assert_eq!(valid_public_peer_url("https://0x7f000001/"), None);
        assert_eq!(valid_public_peer_url("https://3232235777/"), None);
        // Userinfo, ports, query, fragment.
        assert_eq!(
            valid_public_peer_url("https://user@wowsp.example.org"),
            None
        );
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org:8443"),
            None
        );
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org/?x=1"),
            None
        );
        assert_eq!(
            valid_public_peer_url("https://wowsp.example.org/#top"),
            None
        );
        // Garbage / oversize.
        assert_eq!(valid_public_peer_url(""), None);
        assert_eq!(valid_public_peer_url("ftp://wowsp.example.org"), None);
        assert_eq!(valid_public_peer_url("wowsp.example.org"), None);
        assert_eq!(
            valid_public_peer_url(&format!("https://{}.example.org", "a".repeat(253))),
            None
        );
    }

    // ── private gate ───────────────────────────────────────────────

    #[test]
    fn private_gate_allows_lan_shapes_and_keeps_ports() {
        assert_eq!(
            valid_private_peer_url("http://192.0.2.7:8787"),
            Some("http://192.0.2.7:8787".into())
        );
        assert_eq!(
            valid_private_peer_url("http://127.0.0.1:8787/"),
            Some("http://127.0.0.1:8787".into())
        );
        assert_eq!(
            valid_private_peer_url("http://[2001:db8::1]:9000/mesh/"),
            Some("http://[2001:db8::1]:9000/mesh".into())
        );
        assert_eq!(
            valid_private_peer_url("http://lanbox:80"),
            Some("http://lanbox".into()),
            "http default port trimmed"
        );
        assert_eq!(
            valid_private_peer_url("https://wowsp.example.org"),
            Some("https://wowsp.example.org".into())
        );
        // The public-hostile shapes are still refused here.
        assert_eq!(valid_private_peer_url("http://user@192.0.2.7/"), None);
        assert_eq!(valid_private_peer_url("http://192.0.2.7/?x=1"), None);
        assert_eq!(valid_private_peer_url("ftp://192.0.2.7"), None);
        assert_eq!(valid_private_peer_url(""), None);
    }

    // ── announce body ──────────────────────────────────────────────

    #[test]
    fn announce_body_parses_and_gates() {
        let ok = parse_announce_body("{\"url\":\" https://wowsp.example.org \"}").unwrap();
        assert_eq!(ok.url, "https://wowsp.example.org");
        assert_eq!(ok.contact, None);
        let with_contact = parse_announce_body(
            "{\"url\":\"https://wowsp.example.org\",\"contact\":\" admin@a.example \"}",
        )
        .unwrap();
        assert_eq!(with_contact.contact.as_deref(), Some("admin@a.example"));
        assert_eq!(
            parse_announce_body("not json").unwrap_err().code(),
            "bad_json"
        );
        assert_eq!(parse_announce_body("{}").unwrap_err().code(), "bad_shape");
        assert_eq!(
            parse_announce_body("{\"url\":\"  \"}").unwrap_err().code(),
            "bad_shape"
        );
        assert_eq!(
            parse_announce_body("{\"url\":7}").unwrap_err().code(),
            "bad_shape"
        );
        let long = "c".repeat(121);
        assert_eq!(
            parse_announce_body(&format!(
                "{{\"url\":\"https://a.example\",\"contact\":\"{long}\"}}"
            ))
            .unwrap_err()
            .code(),
            "bad_contact"
        );
        let edge = "c".repeat(120);
        assert!(
            parse_announce_body(&format!(
                "{{\"url\":\"https://a.example\",\"contact\":\"{edge}\"}}"
            ))
            .is_ok(),
            "exactly 120 is legal"
        );
    }

    // ── merge + sync ───────────────────────────────────────────────

    #[test]
    fn merge_lets_own_rows_win_and_drops_private() {
        let own = vec![
            row("https://own.example.org", true, false),
            row("https://shared.example.org", false, false),
            row("http://192.0.2.9:8787", true, true),
        ];
        let upstream = vec![
            row("https://shared.example.org", true, false),
            row("https://peer.example.org", true, false),
            row("http://198.51.100.3:8787", true, true),
        ];
        let merged = merge_peers(&own, &upstream);
        let urls: Vec<&str> = merged.iter().map(|r| r.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "https://own.example.org",
                "https://shared.example.org",
                "https://peer.example.org"
            ]
        );
        // The shared row is OWN's (blocks=false), not upstream's.
        let shared = merged
            .iter()
            .find(|r| r.url == "https://shared.example.org")
            .unwrap();
        assert!(!shared.capabilities.blocks);
        assert!(merged.iter().all(|r| !r.private));
    }

    #[test]
    fn merge_caps_at_peers_max() {
        let rows: Vec<PeerRow> = (0..PEERS_MAX + 10)
            .map(|i| row(&format!("https://p{i}.example.org"), true, false))
            .collect();
        assert_eq!(merge_peers(&rows, &[]).len(), PEERS_MAX);
        // Own rows keep priority over upstream when the cap bites.
        let own: Vec<PeerRow> = rows[..2].to_vec();
        let merged = merge_peers(&own, &rows[2..]);
        assert_eq!(merged.len(), PEERS_MAX);
        assert_eq!(merged[0].url, "https://p0.example.org");
        assert_eq!(merged[1].url, "https://p1.example.org");
    }

    #[test]
    fn sync_candidates_filter_blocks_capable_public_rows() {
        let peers = vec![
            row("https://a.example.org", false, false),
            row("https://b.example.org", true, false),
            row("http://192.0.2.9:8787", true, true),
            row("https://c.example.org", true, false),
            row("https://d.example.org", true, false),
        ];
        let picked = sync_candidates(&peers, 2);
        assert_eq!(
            picked.iter().map(|r| r.url.as_str()).collect::<Vec<_>>(),
            ["https://b.example.org", "https://c.example.org"]
        );
    }

    #[test]
    fn peers_doc_serializes_camel_case() {
        let doc = peers_doc(
            vec![row("https://a.example.org", true, false)],
            1_732_185_600,
        );
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"v\":1"));
        assert!(json.contains("\"generatedAt\":1732185600"));
        assert!(json.contains("\"nodeId\":\"8f14e45fceea167a5a36dedd4bea2543\""));
        assert!(json.contains("\"lastSeenAt\":2"));
        assert!(
            json.contains("\"private\":false"),
            "the flag serializes explicitly (default false is a parse-time default only)"
        );
        let back: PeersDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn etag_covers_content_not_generated_at() {
        let peers = vec![row("https://a.example.org", true, false)];
        let a = peers_etag(&peers);
        let b = peers_etag(&peers);
        assert_eq!(a, b, "identical content revalidates");
        assert!(a.starts_with("W/\"") && a.ends_with("\"") && a.len() == 2 + 1 + 16 + 1);
        let changed = peers_etag(&[row("https://b.example.org", true, false)]);
        assert_ne!(a, changed);
    }

    #[test]
    fn rate_keys_bucket_by_hour() {
        let k = announce_rate_key("203.0.113.9", 3_600_000 * 5 + 1);
        assert_eq!(k, "peers:rl:5:203.0.113.9");
        assert_eq!(announce_rate_key("203.0.113.9", 3_600_000 * 5), k);
        assert_ne!(announce_rate_key("203.0.113.9", 3_600_000 * 6), k);
    }
}
