//! Stats-lookup cache policy — the `/api/lookup/*` namespace and the
//! content-addressed block store it feeds (design contract:
//! docs/en/designs/cache-mesh.md §3 and §4.1). Pure policy, exactly like
//! the gateway/replay modules: every host gate, TTL, canonical-spelling
//! and CID decision is made here and unit-tested on the host; the
//! transports (relay-worker on Cloudflare, the native relay-server, the
//! Vercel adapter) only carry I/O. The Vercel adapter mirrors this
//! module's allowlist/TTL/CID tables and is pinned by the shared
//! fixture tests at the bottom.
//!
//! - `allowed_host` — the §3.2 SSRF gate: https-only, exact-match
//!   against the 13-host stats allowlist (the `stats` family of
//!   res/config/upstream-endpoints.json), no userinfo authority, no
//!   explicit port except the https default, no IP literals (an exact
//!   name match cannot be one anyway — the gate is spelled out because
//!   the peers module shares the parsing rules).
//! - `classify_ttl` — the §3.3 TTL table, keyed by host family + path
//!   shape over the REAL upstream paths the app uses (vortex
//!   /api/accounts/…, WG /wows/…; see the tests for the shapes).
//! - `canonical_request_line` + `cid_of_request` — the §3.3/§4.1
//!   cache key: CIDv1(raw, sha2-256 multihash) over
//!   `"<METHOD> <url>[ <sha256(body)>]"` — one space between METHOD
//!   and url, and a THIRD space-separated field only for body-carrying
//!   (POST) requests. The hash field is space-delimited so a URL can
//!   never bleed into it.
//! - `LookupEnvelope` — the stored block shape (§3.3).
//!
//! ## CID spelling decision
//!
//! base58btc is hand-rolled here (const-table big-int encoder/decoder,
//! ~40 lines, pinned by the known-vector tests: the Bitcoin "hello
//! world" vector and the canonical empty-byte raw CIDv1
//! bafkreihdwd…quvyku) rather than adding a dependency — relay-core
//! deliberately carries only the four crates it needs, and the encoder
//! is small enough to test exhaustively against those anchors.
//!
//! ## Envelope `line` field (mesh verification, §4.2/§8)
//!
//! The contract's §3.3 envelope shape is extended with an OPTIONAL
//! `line` member carrying the canonical request line the block's CID
//! addresses. §4.2/§8 demand that a peer-sourced row be verifiable
//! ("the store recomputes the request-line hash before serving a
//! peer-sourced row") — a CID over the request line can only be
//! checked against a row that carries that line, so this field is the
//! verification anchor: a peer row whose `line` is absent or does not
//! CID-verify against the requested CID fails closed and is dropped.
//! Rows minted by this implementation always carry it
//! (`skip_serializing_if` keeps foreign/legacy rows byte-compatible
//! when re-served).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── §3.2 host allowlist ────────────────────────────────────────────────

/// The stats-family hosts the lookup proxy may fetch (§3.2): exactly
/// the `kind: "stats"` entries of res/config/upstream-endpoints.json.
/// Single source of truth — every transport reads this table.
pub const STATS_HOST_ALLOWLIST: [&str; 13] = [
    "api.korabli.su",
    "api.worldofwarships.eu",
    "api.worldofwarships.com",
    "api.worldofwarships.asia",
    "vortex.korabli.su",
    "vortex.worldofwarships.eu",
    "vortex.worldofwarships.com",
    "vortex.worldofwarships.asia",
    "vortex.wowsgame.cn",
    "clans.wowsgame.cn",
    "api.wows-numbers.com",
    "v3-api.wows.shinoaki.com",
    "api.wows.yuyuko.dev",
];

/// The vortex family (account/profile JSON, §3.3 row 1–2).
const VORTEX_HOSTS: [&str; 5] = [
    "vortex.korabli.su",
    "vortex.worldofwarships.eu",
    "vortex.worldofwarships.com",
    "vortex.worldofwarships.asia",
    "vortex.wowsgame.cn",
];

/// The WG/Lesta public API family (§3.3 /wows/* rows).
const WG_API_HOSTS: [&str; 4] = [
    "api.korabli.su",
    "api.worldofwarships.eu",
    "api.worldofwarships.com",
    "api.worldofwarships.asia",
];

/// The yuyuko/shinoaki cloud ban-list pair (§3.3 ban-list row).
const BANLIST_HOSTS: [&str; 2] = ["v3-api.wows.shinoaki.com", "api.wows.yuyuko.dev"];

/// The browser-shaped UA every lookup transport sends upstream (§3.1:
/// CN WAFs reject non-browser UAs). Mirrors the app's own CN transport
/// constant (packages/app/tauri/src/commands/wg_api_cn.rs BROWSER_UA)
/// so cache fills and direct fetches look identical upstream.
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── §3.1/§3.5 budgets ──────────────────────────────────────────────────

/// Per-IP hourly budget on /api/lookup/* (§3.5). Operator override:
/// the LOOKUP_RATE_PER_HOUR var.
pub const LOOKUP_RATE_PER_HOUR: u64 = 240;
/// KV counter-key prefix for the hourly lookup budget.
pub const RATE_KEY_PREFIX: &str = "lookup:rl:";
/// Response-body cap: bodies at or under this size are stored; larger
/// bodies pass through uncached (§3.1).
pub const STORE_CAP: usize = 8 * 1024 * 1024;
/// Forwarded POST body cap (§3.1); larger bodies are refused before
/// the canonical line is built.
pub const POST_BODY_MAX: usize = 8 * 1024;
/// Upstream fetch budget (§3.1). The Worker transport has no explicit
/// fetch timeout (workers-rs 0.8) — workerd's own wall-clock cap is
/// the hard stop there; native/Vercel transports enforce this const.
pub const UPSTREAM_BUDGET_SECS: u64 = 15;

// ── §3.3/§4 blocks ─────────────────────────────────────────────────────

/// KV key of one stored block (`blk:<cid>`, §4.2's store layout).
pub const BLOCK_KEY_PREFIX: &str = "blk:";
/// Storage grace added on top of the envelope TTL (§4.3: TTL + 24 h
/// for late peer hits).
pub const BLOCK_GRACE_SECS: u64 = 86_400;
/// The Worker transport's edge-Cache synthetic host (§3.4: the
/// digests.rs pattern in front of KV).
pub const EDGE_CACHE_HOST: &str = "https://lookup.edge";

/// The edge-cache key for one CID (§3.4).
pub fn edge_cache_key(cid: &str) -> String {
    format!("{EDGE_CACHE_HOST}/{cid}")
}

/// The provenance header (§3.4) and its three values.
pub const CACHE_HEADER: &str = "x-wowsp-cache";
pub const CACHE_HIT: &str = "hit";
pub const CACHE_MISS: &str = "miss";
pub const CACHE_PEER_HIT: &str = "peer-hit";

// ── §3.2 host gate ─────────────────────────────────────────────────────

/// The §3.2 gate: https-only, exact allowlist match, no userinfo
/// authority, no explicit port except the https default (443), no IP
/// literals (unmatched by construction). Returns the canonical
/// (lowercase) allowlist host on success — the input's host casing is
/// normalized away, so `classify_ttl` and the envelope's `upstream`
/// field always see the same spelling.
pub fn allowed_host(url: &str) -> Option<&'static str> {
    let rest = url.strip_prefix("https://")?;
    // The authority ends at the first path/query/fragment marker.
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.len() > 253 {
        return None;
    }
    // Userinfo authorities are refused outright (https://user@host/).
    if authority.contains('@') {
        return None;
    }
    // Split off an explicit port. More than one ':' is an IPv6 literal
    // (or garbage) — either way not an allowlisted name.
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if host.is_empty() {
        return None;
    }
    if let Some(port) = port {
        let ok = !port.is_empty()
            && port.bytes().all(|b| b.is_ascii_digit())
            && port.parse::<u16>() == Ok(443);
        if !ok {
            return None;
        }
    }
    let lowered = host.to_ascii_lowercase();
    STATS_HOST_ALLOWLIST
        .iter()
        .find(|allowed| **allowed == lowered)
        .copied()
}

// ── §3.3 TTL table ─────────────────────────────────────────────────────

/// The §3.3 TTL classification (host + path prefix, pure). `host` is
/// the canonical allowlist host (see `allowed_host`); `path` is the
/// URL path (query ignored — the shapes below never depend on it).
///
/// | shape | TTL |
/// | --- | --- |
/// | vortex `/api/accounts/<id>…` (profile/ships/clans) | 120 |
/// | vortex `/api/accounts/search/…` (search + autocomplete) | 600 |
/// | clans.wowsgame.cn any | 600 |
/// | WG API `/wows/account/*` | 120 |
/// | WG API `/wows/clans/*`, `/wows/seasons/*` | 600 |
/// | WG API `/wows/encyclopedia/*` | 86400 |
/// | api.wows-numbers.com any (expected values) | 86400 |
/// | yuyuko/shinoaki ban list any | 86400 |
/// | anything else on the allowlist | 300 |
pub fn classify_ttl(host: &str, path: &str) -> u64 {
    if host == "clans.wowsgame.cn" {
        return 600;
    }
    if host == "api.wows-numbers.com" || BANLIST_HOSTS.contains(&host) {
        return 86_400;
    }
    if VORTEX_HOSTS.contains(&host) {
        if path.starts_with("/api/accounts/search/") {
            return 600;
        }
        if path.starts_with("/api/accounts/") {
            return 120;
        }
        return 300;
    }
    if WG_API_HOSTS.contains(&host) {
        if path.starts_with("/wows/account/") {
            return 120;
        }
        if path.starts_with("/wows/clans/") || path.starts_with("/wows/seasons/") {
            return 600;
        }
        if path.starts_with("/wows/encyclopedia/") {
            return 86_400;
        }
        return 300;
    }
    300
}

// ── §3.3 canonical request line ────────────────────────────────────────

/// The canonical request line `"<METHOD> <url>[ <sha256hex>]"`
/// (§3.3): method uppercased, url exactly as the client spelled it
/// (the CID deliberately includes that spelling — two spellings of
/// one upstream URL are two cache entries), and a third space-separated
/// field — the lowercase sha256 hex of the body — for body-carrying
/// (POST) requests only. Callers pass `None` for GET.
pub fn canonical_request_line(method: &str, url: &str, body_sha256: Option<&str>) -> String {
    let mut line = format!("{} {}", method.to_ascii_uppercase(), url);
    if let Some(hash) = body_sha256 {
        line.push(' ');
        line.push_str(hash);
    }
    line
}

// ── base58btc + CID (§4.1) ─────────────────────────────────────────────

/// The base58btc alphabet (Bitcoin/IPFS): no 0, O, I, l.
const B58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// base58btc encode (const-table big-int division; leading zero bytes
/// become leading '1's). See the module doc for why this is
/// hand-rolled.
fn base58_encode(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    // log256(58) ≈ 0.7325 digits per byte — 2× is a safe reserve.
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 2);
    for &byte in &bytes[zeros..] {
        let mut carry = u32::from(byte);
        for digit in digits.iter_mut() {
            let x = u32::from(*digit) * 256 + carry;
            *digit = (x % 58) as u8;
            carry = x / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push('1');
    }
    for digit in digits.iter().rev() {
        out.push(B58_ALPHABET[usize::from(*digit)] as char);
    }
    out
}

/// base58btc decode (the exact inverse of `base58_encode`).
fn base58_decode(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() {
        return Some(Vec::new());
    }
    let zeros = text.bytes().take_while(|c| *c == b'1').count();
    let mut bytes: Vec<u8> = Vec::new();
    for c in text.bytes().skip(zeros) {
        let value = usize::from(B58_ALPHABET.iter().position(|a| *a == c)?);
        let mut carry = value;
        for byte in bytes.iter_mut() {
            let x = usize::from(*byte) * 58 + carry;
            *byte = (x % 256) as u8;
            carry = x / 256;
        }
        while carry > 0 {
            bytes.push((carry % 256) as u8);
            carry /= 256;
        }
    }
    let mut out = vec![0u8; zeros];
    out.extend(bytes.iter().rev());
    Some(out)
}

/// CIDv1 binary layout: version 0x01, raw codec 0x55, sha2-256
/// multihash prefix 0x12 0x20, then the 32-byte digest — 36 bytes.
pub const CID_LENGTH: usize = 36;

/// The CID of one sha2-256 digest: `CIDv1(raw, multihash)` in
/// base58btc (§4.1).
pub fn cid_of_digest(digest: &[u8; 32]) -> String {
    let mut bytes = [0u8; CID_LENGTH];
    bytes[0] = 0x01;
    bytes[1] = 0x55;
    bytes[2] = 0x12;
    bytes[3] = 0x20;
    bytes[4..].copy_from_slice(digest);
    base58_encode(&bytes)
}

/// The CID of arbitrary content (sha2-256 then CIDv1 raw) — the
/// IPFS-standard spelling, so an IPFS node computing the CID of the
/// same bytes gets the same string (§4.1).
pub fn cid_of_content(content: &[u8]) -> String {
    cid_of_digest(&Sha256::digest(content).into())
}

/// The §3.3 cache key: the CID of the canonical request line.
pub fn cid_of_request(method: &str, url: &str, body_sha256: Option<&str>) -> String {
    let line = canonical_request_line(method, url, body_sha256);
    cid_of_digest(&Sha256::digest(line.as_bytes()).into())
}

/// A CID path-segment shape: base58btc charset, 8..=80 chars (§4.2's
/// URL spelling — short enough to refuse garbage, long enough for any
/// sha2-256 CID plus future codecs).
pub fn valid_cid(cid: &str) -> bool {
    (8..=80).contains(&cid.len())
        && cid.bytes().all(|b| match b {
            b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'a'..=b'k' | b'm'..=b'z' => {
                true
            },
            _ => false,
        })
}

/// §4.2/§8 verification: does `cid` address exactly this canonical
/// request line? Decodes the full binary layout (version/codec/
/// multihash prefix + digest equality), so a malformed CID or a
/// mismatched digest both fail — a lying peer's row is dropped, never
/// served.
pub fn cid_verify(cid: &str, canonical_line: &str) -> bool {
    let Some(bytes) = base58_decode(cid) else {
        return false;
    };
    if bytes.len() != CID_LENGTH {
        return false;
    }
    if bytes[0] != 0x01 || bytes[1] != 0x55 || bytes[2] != 0x12 || bytes[3] != 0x20 {
        return false;
    }
    let digest = Sha256::digest(canonical_line.as_bytes());
    bytes[4..] == digest[..]
}

// ── §3.3 envelope ──────────────────────────────────────────────────────

/// One stored block (§3.3): the upstream answer, content-typed and
/// base64-wrapped, plus the cache bookkeeping. `line` is this
/// implementation's verification anchor (see the module doc) — always
/// present on rows minted here, optional on rows parsed from peers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupEnvelope {
    /// Shape version (1).
    pub v: u32,
    /// Upstream HTTP status.
    pub status: u16,
    /// Upstream content-type (default `application/json` at mint).
    pub content_type: String,
    /// Standard padded base64 of the body bytes.
    pub body_b64: String,
    /// Unix seconds of the fill.
    pub fetched_at: u64,
    /// §3.3 TTL of this row.
    pub ttl: u64,
    /// Canonical allowlist host the row was fetched from.
    pub upstream: String,
    /// The canonical request line this block's CID addresses (mesh
    /// verification anchor; see the module doc).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

impl LookupEnvelope {
    /// Mint a fresh envelope for one fill.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        status: u16,
        content_type: &str,
        body: &[u8],
        fetched_at: u64,
        ttl: u64,
        upstream: &str,
        line: &str,
    ) -> Self {
        Self {
            v: 1,
            status,
            content_type: content_type.to_string(),
            body_b64: b64_encode(body),
            fetched_at,
            ttl,
            upstream: upstream.to_string(),
            line: Some(line.to_string()),
        }
    }

    /// Seconds since the fill (0 on a clock skew backwards).
    pub fn age(&self, now_secs: u64) -> u64 {
        now_secs.saturating_sub(self.fetched_at)
    }

    /// §3.3 freshness: still inside the TTL window.
    pub fn is_fresh(&self, now_secs: u64) -> bool {
        self.age(now_secs) < self.ttl
    }

    /// The decoded body (None on a corrupt base64 member — treated as
    /// a missing block by the transports).
    pub fn body(&self) -> Option<Vec<u8>> {
        b64_decode(&self.body_b64)
    }
}

/// Age of an envelope in seconds (`envelope_age` in the contract's
/// helper spelling).
pub fn envelope_age(envelope: &LookupEnvelope, now_secs: u64) -> u64 {
    envelope.age(now_secs)
}

/// Freshness helper (`envelope_is_fresh`).
pub fn envelope_is_fresh(envelope: &LookupEnvelope, now_secs: u64) -> bool {
    envelope.is_fresh(now_secs)
}

// ── §3.4 response shaping ──────────────────────────────────────────────

/// `cache-control: public, max-age=<ttl remaining>` (§3.4): edge
/// caches and browsers may serve the row until it expires.
pub fn cache_control_public(remaining_secs: u64) -> String {
    format!("public, max-age={remaining_secs}")
}

/// The remaining max-age of a row (`ttl` minus the seconds already
/// spent; saturating).
pub fn remaining_max_age(ttl: u64, age_secs: u64) -> u64 {
    ttl.saturating_sub(age_secs)
}

// ── §3.5 rate key ──────────────────────────────────────────────────────

/// The KV counter key for one IP's hourly lookup budget (the replay
/// pipeline's `rl:pub:` shape: hour bucket + IP, §3.5).
pub fn lookup_rate_key(ip: &str, now_ms: i64) -> String {
    format!("{RATE_KEY_PREFIX}{}:{ip}", now_ms.div_euclid(3_600_000))
}

/// Seconds until the current hour bucket rolls over (the 429's
/// retry-after; at least 1).
pub fn hour_retry_after_secs(now_ms: i64) -> u64 {
    let ms_left = 3_600_000 - now_ms.rem_euclid(3_600_000);
    ((ms_left / 1000) as u64).max(1)
}

// ── query-value decoding ───────────────────────────────────────────────

/// Strict percent-decoding for the `?url=` query value: every `%`
/// must introduce exactly two hex digits, otherwise the value is
/// refused (a malformed URL must fail the gate loudly, not silently).
/// `+` is LEFT AS-IS — a literal plus is legal in a URL, and the
/// form-encoding `+`-means-space convention does not apply to a
/// percent-encoded URL parameter.
pub fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hi = bytes.get(i + 1)?;
                let lo = bytes.get(i + 2)?;
                let hex = |b: u8| match b {
                    b'0'..=b'9' => Some(u8::from(b - b'0')),
                    b'a'..=b'f' => Some(u8::from(b - b'a') + 10),
                    b'A'..=b'F' => Some(u8::from(b - b'A') + 10),
                    _ => None,
                };
                out.push(hex(*hi)? << 4 | hex(*lo)?);
                i += 3;
            },
            byte => {
                out.push(byte);
                i += 1;
            },
        }
    }
    String::from_utf8(out).ok()
}

// ── small shared helpers ───────────────────────────────────────────────

/// Lowercase sha256 hex of `bytes` — the POST-body hash field of the
/// canonical request line (§3.3). Exposed because every transport
/// needs it before building the line.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

// ── standard base64 (envelope bodies) ──────────────────────────────────

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard padded base64 encode (RFC 4648 §4).
pub fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64_ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Standard padded base64 decode; refuses malformed tails (mirrors
/// replay.rs's `b64url_decode` discipline).
pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return Some(Vec::new());
    }
    if bytes.len() % 4 != 0 || bytes.len() > 4 * 1024 * 1024 * 4 {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let pads = bytes.iter().rev().take_while(|c| **c == b'=').count();
    if pads > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let is_last = i == bytes.len() / 4 - 1;
        let data_len = if is_last { 4 - pads } else { 4 };
        if is_last && data_len == 1 {
            return None;
        }
        let mut n: u32 = 0;
        for (j, c) in chunk.iter().enumerate() {
            let v = if j < data_len { val(*c)? } else { 0 };
            n |= v << (18 - 6 * j);
        }
        out.push((n >> 16) as u8);
        if data_len > 2 {
            out.push((n >> 8) as u8);
        }
        if data_len > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

// ── unit tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── §3.2 host gate ─────────────────────────────────────────────

    #[test]
    fn every_allowlist_host_passes_the_gate() {
        for host in STATS_HOST_ALLOWLIST {
            let url = format!("https://{host}/api/thing/?q=1");
            assert_eq!(allowed_host(&url), Some(host), "host {host}");
        }
    }

    #[test]
    fn gate_accepts_default_port_and_host_case() {
        assert_eq!(
            allowed_host("https://vortex.wowsgame.cn:443/api/accounts/1/"),
            Some("vortex.wowsgame.cn")
        );
        // Host casing is normalized onto the allowlist spelling.
        assert_eq!(
            allowed_host("https://VORTEX.WOWSGAME.CN/api/accounts/1/"),
            Some("vortex.wowsgame.cn")
        );
        // No path at all is still a legal authority.
        assert_eq!(
            allowed_host("https://clans.wowsgame.cn"),
            Some("clans.wowsgame.cn")
        );
    }

    #[test]
    fn gate_rejects_the_evil_spellings() {
        // Not https.
        assert_eq!(allowed_host("http://vortex.wowsgame.cn/api/"), None);
        assert_eq!(allowed_host("httpsx://vortex.wowsgame.cn/"), None);
        // Userinfo authority.
        assert_eq!(allowed_host("https://user@vortex.wowsgame.cn/"), None);
        assert_eq!(allowed_host("https://vortex.wowsgame.cn@evil.com/"), None);
        // Non-default ports.
        assert_eq!(allowed_host("https://vortex.wowsgame.cn:8443/"), None);
        assert_eq!(allowed_host("https://vortex.wowsgame.cn:/"), None);
        assert_eq!(allowed_host("https://vortex.wowsgame.cn:444/"), None);
        // IP literals (v4, v6, decimal) never match the name list.
        assert_eq!(allowed_host("https://192.0.2.1/api/"), None);
        assert_eq!(allowed_host("https://[2001:db8::1]/api/"), None);
        assert_eq!(allowed_host("https://0x7f000001/api/"), None);
        // Non-allowlist hosts, incl. suffix/prefix forgeries.
        assert_eq!(allowed_host("https://evil.com/api/"), None);
        assert_eq!(allowed_host("https://vortex.wowsgame.cn.evil.com/"), None);
        assert_eq!(allowed_host("https://evil-vortex.wowsgame.cn/"), None);
        assert_eq!(allowed_host("https://vortex.wowsgame.cn./"), None);
        // Empty/garbage shapes.
        assert_eq!(allowed_host("https:///api/"), None);
        assert_eq!(allowed_host("vortex.wowsgame.cn/api/"), None);
        assert_eq!(allowed_host(""), None);
        // A fragment/query terminates the authority cleanly (no match).
        assert_eq!(allowed_host("https://evil.com#vortex.wowsgame.cn/"), None);
        assert_eq!(allowed_host("https://evil.com?vortex.wowsgame.cn"), None);
    }

    // ── §3.3 TTL table ─────────────────────────────────────────────

    #[test]
    fn vortex_accounts_are_short_search_is_medium() {
        // The real app shapes (wg_api_cn.rs / stream.rs).
        assert_eq!(
            classify_ttl("vortex.wowsgame.cn", "/api/accounts/503224851/"),
            120
        );
        assert_eq!(
            classify_ttl("vortex.wowsgame.cn", "/api/accounts/503224851/ships/pvp/"),
            120
        );
        assert_eq!(
            classify_ttl("vortex.wowsgame.cn", "/api/accounts/503224851/clans/"),
            120
        );
        assert_eq!(
            classify_ttl("vortex.worldofwarships.eu", "/api/accounts/503224851/"),
            120
        );
        assert_eq!(
            classify_ttl("vortex.wowsgame.cn", "/api/accounts/search/Some%20Player/"),
            600
        );
        assert_eq!(
            classify_ttl(
                "vortex.wowsgame.cn",
                "/api/accounts/search/autocomplete/ab/"
            ),
            600
        );
        // Anything else on a vortex host: default.
        assert_eq!(classify_ttl("vortex.wowsgame.cn", "/api/other/thing"), 300);
    }

    #[test]
    fn clans_cn_and_numbers_and_ban_hosts_are_pinned() {
        assert_eq!(
            classify_ttl("clans.wowsgame.cn", "/api/clans/whatever"),
            600
        );
        assert_eq!(
            classify_ttl("api.wows-numbers.com", "/expected/values"),
            86_400
        );
        assert_eq!(
            classify_ttl("v3-api.wows.shinoaki.com", "/api/v3/ban/list"),
            86_400
        );
        assert_eq!(classify_ttl("api.wows.yuyuko.dev", "/api/ban"), 86_400);
    }

    #[test]
    fn wg_api_paths_classify_per_the_table() {
        assert_eq!(
            classify_ttl("api.worldofwarships.eu", "/wows/account/list/"),
            120
        );
        assert_eq!(
            classify_ttl("api.worldofwarships.eu", "/wows/account/info/"),
            120
        );
        assert_eq!(classify_ttl("api.korabli.su", "/wows/clans/list/"), 600);
        assert_eq!(classify_ttl("api.korabli.su", "/wows/clans/info/"), 600);
        assert_eq!(
            classify_ttl("api.korabli.su", "/wows/clans/accountinfo/"),
            600
        );
        assert_eq!(classify_ttl("api.korabli.su", "/wows/seasons/info/"), 600);
        assert_eq!(
            classify_ttl("api.korabli.su", "/wows/seasons/shipstats/"),
            600
        );
        assert_eq!(
            classify_ttl("api.worldofwarships.asia", "/wows/encyclopedia/info/"),
            86_400
        );
        assert_eq!(
            classify_ttl("api.worldofwarships.asia", "/wows/encyclopedia/ships/"),
            86_400
        );
        // Unlisted WG paths (e.g. /wows/ships/stats) take the default.
        assert_eq!(classify_ttl("api.korabli.su", "/wows/ships/stats/"), 300);
        // Unknown host (defensive — callers gate first): default.
        assert_eq!(classify_ttl("unknown.host", "/anything"), 300);
    }

    // ── canonical line ─────────────────────────────────────────────

    #[test]
    fn canonical_line_is_stable_and_space_delimited() {
        let url = "https://vortex.wowsgame.cn/api/accounts/503224851/";
        assert_eq!(
            canonical_request_line("GET", url, None),
            format!("GET {url}")
        );
        assert_eq!(
            canonical_request_line("get", url, None),
            format!("GET {url}"),
            "method casing is normalized"
        );
        assert_eq!(
            canonical_request_line(
                "POST",
                url,
                Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
            ),
            format!("POST {url} e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            "the body hash rides as a THIRD space-separated field"
        );
    }

    // ── base58 + CID ───────────────────────────────────────────────

    #[test]
    fn base58_known_vectors() {
        // The Bitcoin/IPFS reference vectors.
        assert_eq!(base58_encode(b"hello world"), "StV1DL6CwTryKyV");
        assert_eq!(base58_decode("StV1DL6CwTryKyV").unwrap(), b"hello world");
        assert_eq!(base58_encode(&[]), "");
        assert_eq!(base58_encode(&[0]), "1");
        assert_eq!(base58_encode(&[0, 0, 0, 0]), "1111");
        assert_eq!(base58_decode("1111").unwrap(), [0, 0, 0, 0]);
        assert_eq!(base58_encode(&[1]), "2");
        // Round-trip over every length 0..64 of counting bytes.
        for len in 0..64usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 7 % 256) as u8).collect();
            let spelled = base58_encode(&bytes);
            assert_eq!(base58_decode(&spelled).unwrap(), bytes, "len {len}");
        }
        // Non-alphabet chars refuse.
        assert!(base58_decode("0OIl").is_none());
    }

    #[test]
    fn empty_content_cid_matches_the_ipfs_reference() {
        // The canonical CIDv1(raw, sha2-256) of ZERO bytes. The
        // multibase-base32 spelling every IPFS implementation shows
        // for it is
        // bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku
        // (multibase prefix `b`); §4.1 asks for base58btc in URLs,
        // and the base58btc spelling of the SAME 36 binary bytes
        // (0x01 0x55 0x12 0x20 || sha256(b"")) is the constant below —
        // cross-checked against an independent big-int encoder.
        assert_eq!(
            cid_of_content(b""),
            "b2rhmy65F3REf8SZp7De11gxtECBGgUKaLdiDj7MCGCHxbDW"
        );
    }

    #[test]
    fn cid_layout_is_version_codec_multihash() {
        let cid = cid_of_request(
            "GET",
            "https://vortex.wowsgame.cn/api/accounts/503224851/",
            None,
        );
        assert!(valid_cid(&cid), "spelling is URL-safe base58");
        let bytes = base58_decode(&cid).unwrap();
        assert_eq!(bytes.len(), CID_LENGTH);
        assert_eq!(bytes[0], 0x01, "CIDv1");
        assert_eq!(bytes[1], 0x55, "raw codec");
        assert_eq!(bytes[2], 0x12, "sha2-256 multihash code");
        assert_eq!(bytes[3], 0x20, "32-byte digest length");
        let line = b"GET https://vortex.wowsgame.cn/api/accounts/503224851/";
        assert_eq!(
            &bytes[4..],
            &Sha256::digest(line)[..],
            "digest is over the canonical request line"
        );
    }

    #[test]
    fn cid_is_deterministic_and_verifies() {
        let url = "https://api.worldofwarships.eu/wows/account/list/?application_id=x&search=abc";
        let a = cid_of_request("GET", url, None);
        let b = cid_of_request("GET", url, None);
        assert_eq!(a, b, "same line, same CID");
        // A different body hash on a POST is a different CID.
        let p1 = cid_of_request("POST", url, Some(&sha256_hex(b"one")));
        let p2 = cid_of_request("POST", url, Some(&sha256_hex(b"two")));
        assert_ne!(p1, p2);
        assert_ne!(a, p1);
        // Verification: exact line passes, anything else fails.
        let line = canonical_request_line("GET", url, None);
        assert!(cid_verify(&a, &line));
        assert!(!cid_verify(&a, &format!("{line}x")));
        assert!(!cid_verify(&p1, &line));
        assert!(!cid_verify("not-a-cid-at-all!!", &line));
        assert!(!cid_verify("", &line));
    }

    #[test]
    fn valid_cid_pins_the_url_charset() {
        assert!(valid_cid(
            "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
        ));
        assert!(!valid_cid("0OIl0000"), "forbidden chars");
        assert!(!valid_cid("abc"), "too short");
        assert!(!valid_cid(&"a".repeat(81)), "too long");
        assert!(valid_cid(&"a".repeat(80)), "80 is the ceiling");
    }

    // ── envelope ───────────────────────────────────────────────────

    #[test]
    fn envelope_serializes_to_the_contract_shape() {
        let env = LookupEnvelope::new(
            200,
            "application/json",
            br#"{"ok":true}"#,
            1_732_185_600,
            120,
            "vortex.wowsgame.cn",
            "GET https://vortex.wowsgame.cn/api/accounts/1/",
        );
        let json = serde_json::to_string(&env).unwrap();
        // The §3.3 members in camelCase, plus the verification anchor.
        assert_eq!(
            json,
            "{\"v\":1,\"status\":200,\"contentType\":\"application/json\",\"bodyB64\":\"eyJvayI6dHJ1ZX0=\",\"fetchedAt\":1732185600,\"ttl\":120,\"upstream\":\"vortex.wowsgame.cn\",\"line\":\"GET https://vortex.wowsgame.cn/api/accounts/1/\"}"
        );
        let back: LookupEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env);
        assert_eq!(back.body().unwrap(), br#"{"ok":true}"#);
    }

    #[test]
    fn envelope_line_is_optional_for_foreign_rows() {
        // A peer row without the anchor still parses (verification is
        // the transport's job); re-serializing keeps it absent.
        let json = r#"{"v":1,"status":200,"contentType":"text/plain","bodyB64":"Zm9v","fetchedAt":10,"ttl":60,"upstream":"api.wows.yuyuko.dev"}"#;
        let env: LookupEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(env.line, None);
        let out = serde_json::to_string(&env).unwrap();
        assert!(!out.contains("line"), "absent stays absent: {out}");
    }

    #[test]
    fn envelope_age_and_freshness_boundaries() {
        let env = LookupEnvelope {
            v: 1,
            status: 200,
            content_type: "application/json".into(),
            body_b64: "Zm9v".into(),
            fetched_at: 1_000,
            ttl: 120,
            upstream: "vortex.korabli.su".into(),
            line: None,
        };
        assert_eq!(envelope_age(&env, 1_000), 0);
        assert!(envelope_is_fresh(&env, 1_119));
        assert!(!envelope_is_fresh(&env, 1_120), "age == ttl is stale");
        assert!(!envelope_is_fresh(&env, 9_999));
        assert_eq!(envelope_age(&env, 500), 0, "clock skew saturates at 0");
    }

    // ── response shaping + rate keys ───────────────────────────────

    #[test]
    fn remaining_max_age_saturates() {
        assert_eq!(remaining_max_age(120, 0), 120);
        assert_eq!(remaining_max_age(120, 30), 90);
        assert_eq!(remaining_max_age(120, 120), 0);
        assert_eq!(remaining_max_age(120, 999), 0);
        assert_eq!(cache_control_public(90), "public, max-age=90");
    }

    #[test]
    fn percent_decode_is_strict() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fvortex.wowsgame.cn%2Fapi%2Faccounts%2F1%2F").as_deref(),
            Some("https://vortex.wowsgame.cn/api/accounts/1/")
        );
        // Plain values pass through; '+' stays a literal plus.
        assert_eq!(percent_decode("abc").as_deref(), Some("abc"));
        assert_eq!(percent_decode("a+b%20c").as_deref(), Some("a+b c"));
        // Malformed escapes refuse.
        assert_eq!(percent_decode("%"), None);
        assert_eq!(percent_decode("%A"), None);
        assert_eq!(percent_decode("%GG"), None);
        assert_eq!(percent_decode("100%"), None);
    }

    #[test]
    fn lookup_rate_keys_bucket_by_hour() {
        let a = lookup_rate_key("203.0.113.9", 3_600_000 * 7);
        assert_eq!(a, "lookup:rl:7:203.0.113.9");
        assert_eq!(
            lookup_rate_key("203.0.113.9", 3_600_000 * 7 + 1),
            a,
            "same hour bucket"
        );
        assert_ne!(lookup_rate_key("203.0.113.9", 3_600_000 * 8), a);
        assert_ne!(lookup_rate_key("198.51.100.1", 3_600_000 * 7), a);
        assert_eq!(hour_retry_after_secs(3_600_000 * 7), 3_600);
        assert_eq!(hour_retry_after_secs(3_600_000 * 7 + 500_000), 3_100);
        assert_eq!(hour_retry_after_secs(0), 3_600);
    }

    // ── base64 ─────────────────────────────────────────────────────

    #[test]
    fn b64_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(b64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        for text in [
            "", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy",
        ] {
            let back = b64_decode(text).unwrap_or_default();
            let round = b64_encode(&back);
            assert_eq!(round, text, "text {text}");
        }
        assert!(b64_decode("Zm9vYg===").is_none(), "three pads");
        assert!(b64_decode("Zm9 v").is_none(), "whitespace");
        assert!(b64_decode("Zm9vY").is_none(), "bad length");
        assert!(b64_decode("A").is_none(), "one char");
        assert!(b64_decode("++++").is_some(), "+ is legal here");
    }
}
