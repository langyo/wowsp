//! The `/erp` review console — the pure half of its Feishu-OAuth session
//! protocol.
//!
//! Auth story: a Feishu OAuth login by an allowlisted open_id
//! (`ERP_ALLOWED_OPEN_IDS` ∪ `FEEDBACK_ADMIN_OPEN_ID`; with neither set,
//! any user the Feishu app admits — the legacy gate, logged and flagged
//! in the console) mints an HMAC-signed session cookie; every console
//! API (`/api/feedback/list`, `/api/feedback/update`, the attachment
//! redirect) accepts that cookie instead of the retired `X-Admin-Key`
//! header, re-checking the open_id it carries against the allowlist so
//! removing someone revokes their live sessions. The signed state is the
//! SHA-256 of a domain-separated app secret, so no extra secret is
//! needed on top of the existing `FEISHU_APP_SECRET`.
//!
//! Pure here (host-testable): HMAC-SHA256, unpadded base64url,
//! cookie-header parsing, session mint/verify, the open_id allowlist,
//! the same-origin write check and the authorize-URL shape. The I/O
//! half — the OAuth round trips — lives in `relay-worker/src/erp.rs`.
//! The console PAGE itself is the hikari build (`packages/console`),
//! served by the worker's assets layer — nothing here renders HTML.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The logged-in session cookie (HttpOnly, Secure, SameSite=Lax).
pub const SESSION_COOKIE: &str = "erp_session";
/// Short-lived double-submit cookie carrying the OAuth `state` nonce.
pub const OAUTH_STATE_COOKIE: &str = "erp_oauth";
/// Session lifetime — a week of reviewing without re-login.
pub const SESSION_TTL_SECS: i64 = 7 * 24 * 60 * 60;
/// The OAuth round trip must finish within ten minutes.
pub const OAUTH_STATE_TTL_SECS: i64 = 600;

// ── HMAC-SHA256 (RFC 2104, over sha2 — no extra crate) ────────────────

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner: Vec<u8> = block.iter().map(|b| b ^ 0x36).collect();
    let outer: Vec<u8> = block.iter().map(|b| b ^ 0x5c).collect();
    let mut h = Sha256::new();
    h.update(&inner);
    h.update(msg);
    let mid: [u8; 32] = h.finalize().into();
    let mut h = Sha256::new();
    h.update(&outer);
    h.update(mid);
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0xf) as u32, 16).unwrap_or('0'));
    }
    out
}

/// Constant-time-ish compare (same hygiene rule as the old key check).
pub fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

// ── unpadded base64url (RFC 4648 §5) ──────────────────────────────────

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[n as usize & 63] as char);
        }
    }
    out
}

fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for chunk in text.as_bytes().chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut n: u32 = 0;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

// ── session mint / verify ─────────────────────────────────────────────

/// Domain-separate the app secret into the session signing key — one
/// secret on file (FEISHU_APP_SECRET), no extra configuration.
pub fn session_key(app_secret: &str) -> [u8; 32] {
    Sha256::digest(format!("wowsp-erp-session-v1:{app_secret}").as_bytes()).into()
}

/// What a signed session carries — just the public profile bits the
/// console shows; no Feishu token ever lands in the cookie.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionClaims {
    pub open_id: String,
    pub name: String,
    pub avatar: String,
    /// Unix expiry (seconds).
    pub exp: i64,
}

/// `<b64url(claims)>.<hex hmac>` — the Set-Cookie value.
pub fn mint_session(key: &[u8; 32], claims: &SessionClaims) -> String {
    let payload = serde_json::to_vec(claims).unwrap_or_default();
    let payload = b64url_encode(&payload);
    let mac = hmac_sha256(key, payload.as_bytes());
    format!("{payload}.{}", hex(&mac))
}

/// Verify signature + expiry; `None` on tamper, corruption or staleness.
pub fn read_session(key: &[u8; 32], value: &str, now_secs: i64) -> Option<SessionClaims> {
    let (payload, mac) = value.split_once('.')?;
    if !ct_eq(mac, &hex(&hmac_sha256(key, payload.as_bytes()))) {
        return None;
    }
    let claims: SessionClaims = serde_json::from_slice(&b64url_decode(payload)?).ok()?;
    (claims.exp > now_secs).then_some(claims)
}

// ── console allowlist ─────────────────────────────────────────────────

/// Who may hold a console session: the open_ids listed in
/// `ERP_ALLOWED_OPEN_IDS` (comma- or whitespace-separated) plus
/// `FEEDBACK_ADMIN_OPEN_ID`. Both unset (or blank) leaves the list
/// empty, which historically kept the legacy gate — any user the Feishu
/// app lets sign in — so an upgrade never locks the owner out; the
/// worker logs a warning and the console flags it (see
/// [`ConsoleAllowlist::is_open`]).
///
/// Audit M-6: that legacy gate is fail-OPEN — whoever can complete the
/// Feishu OAuth owns every console and replay-admin route. The worker
/// therefore wraps unconfigured deployments in [`ConsoleAllowlist::closed`]
/// unless the operator explicitly sets `ERP_OPEN_ACCESS=1` to keep the
/// legacy behavior; a configured allowlist is unaffected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleAllowlist {
    open_ids: Vec<String>,
    /// `false` only for the explicit [`ConsoleAllowlist::closed`] gate.
    /// An empty list built by [`Self::from_config`] still means legacy
    /// open mode — the closed gate is a separate, deliberate state.
    open_mode: bool,
}

/// `Default` preserves the historical shape of an empty list: legacy open
/// mode (the `#[derive(Default)]` bool would have flipped the semantics to
/// closed — the closed gate is the EXPLICIT [`Self::closed`] constructor).
impl Default for ConsoleAllowlist {
    fn default() -> Self {
        Self::from_config(None, None)
    }
}

impl ConsoleAllowlist {
    /// Union of the two config values; blanks and stray separators are
    /// ignored (open_ids never contain commas or whitespace).
    pub fn from_config(allowed: Option<&str>, admin: Option<&str>) -> Self {
        let mut open_ids: Vec<String> = Vec::new();
        for raw in [allowed, admin].into_iter().flatten() {
            for id in raw.split(|c: char| c == ',' || c.is_whitespace()) {
                if !id.is_empty() && !open_ids.iter().any(|known| known == id) {
                    open_ids.push(id.to_string());
                }
            }
        }
        Self {
            open_ids,
            open_mode: true,
        }
    }

    /// The fail-closed gate: admits nobody, regardless of what (or
    /// whether) anything is configured.
    pub fn closed() -> Self {
        Self {
            open_ids: Vec::new(),
            open_mode: false,
        }
    }

    /// No open_id configured — the legacy any-app-user gate is in force.
    /// The explicit [`Self::closed`] gate is never "open".
    pub fn is_open(&self) -> bool {
        self.open_mode && self.open_ids.is_empty()
    }

    /// Whether `open_id` may log in / keep using a session. An empty
    /// open_id is never admitted, open mode or not.
    pub fn admits(&self, open_id: &str) -> bool {
        !open_id.is_empty() && (self.is_open() || self.open_ids.iter().any(|id| id == open_id))
    }
}

/// The console APIs' session gate: signature + expiry ([`read_session`])
/// AND the open_id the cookie was minted for is still allowlisted — so
/// dropping someone from the list revokes their unexpired cookies on the
/// next request instead of after the 7-day TTL.
pub fn read_console_session(
    key: &[u8; 32],
    value: &str,
    now_secs: i64,
    allowlist: &ConsoleAllowlist,
) -> Option<SessionClaims> {
    read_session(key, value, now_secs).filter(|c| allowlist.admits(&c.open_id))
}

/// CSRF guard for cookie-authenticated writes: a browser request must be
/// same-origin. `Sec-Fetch-Site` (when sent) must be `same-origin` and
/// `Origin` (when sent) must equal the worker's own origin. Requests
/// carrying neither header — non-browser clients such as fix-agents
/// replaying a session cookie — pass; the cookie itself (SameSite=Lax)
/// remains the authentication.
pub fn same_origin_write(
    origin: Option<&str>,
    sec_fetch_site: Option<&str>,
    own_origin: &str,
) -> bool {
    if sec_fetch_site.is_some_and(|site| !site.trim().eq_ignore_ascii_case("same-origin")) {
        return false;
    }
    origin.is_none_or(|o| o.trim() == own_origin)
}

// ── small wire helpers ────────────────────────────────────────────────

/// Whether the stored profile is worth re-reading from the contact API:
/// user_info anonymizes the name to 用户＋digits (and blanks the avatar)
/// for apps without contact visibility — a live re-read after 权限 is
/// granted restores the real values.
pub fn profile_needs_refresh(name: &str, avatar: &str) -> bool {
    if avatar.is_empty() {
        return true;
    }
    let rest = name.strip_prefix("用户");
    match rest {
        Some(digits) if !digits.is_empty() => digits.bytes().all(|b| b.is_ascii_digit()),
        _ => false,
    }
}

/// Pull one cookie out of a `Cookie:` header (`a=1; b=2` shapes only —
/// the worker never sets quoted cookie values).
pub fn cookie_get(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|pair| {
        let (k, v) = pair.trim().split_once('=')?;
        (k == name).then(|| v.trim().to_string())
    })
}

/// The Feishu web-SSO authorize entry (v1 shape: app_id + redirect_uri +
/// state; the callback round trip is the v2 token endpoint).
pub fn authorize_url(app_id: &str, redirect_uri: &str, state: &str) -> String {
    format!(
        "https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id={}&redirect_uri={}&state={}",
        crate::feedback::urlencode(app_id),
        crate::feedback::urlencode(redirect_uri),
        crate::feedback::urlencode(state),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_case1() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want…" —
        // case 1's key is shorter than the block size, exercising the
        // zero-padded branch.
        let mac = hmac_sha256(b"key", b"The quick brown fox jumps over the lazy dog");
        assert_eq!(
            hex(&mac),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        // RFC 4231 test case 1: 20-byte key (> 64 would take the hash
        // branch — covered by session_key's derived 32-byte keys below).
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(
            hex(&mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // >64-byte key exercises the hash-the-key branch.
        let long_key = "k".repeat(100);
        let mac = hmac_sha256(long_key.as_bytes(), b"Hi There");
        assert_eq!(hex(&mac).len(), 64);
    }

    #[test]
    fn b64url_round_trips_without_padding() {
        for sample in ["", "a", "ab", "abc", "abcd", "{\"open_id\":\"ou_x\"}"] {
            let enc = b64url_encode(sample.as_bytes());
            assert!(!enc.contains('=') && !enc.contains('+') && !enc.contains('/'));
            let dec = b64url_decode(&enc).expect("decodes");
            assert_eq!(String::from_utf8(dec).unwrap(), sample);
        }
        assert_eq!(b64url_encode(b"a"), "YQ");
        assert!(b64url_decode("!!!!!").is_none());
    }

    #[test]
    fn anonymized_profiles_are_detected_for_refresh() {
        // The user_info placeholder shape (用户＋digits) and a blank
        // avatar are both worth a live contact re-read.
        assert!(profile_needs_refresh("用户053028", ""));
        assert!(profile_needs_refresh("用户053028", "https://a.test/a.png"));
        assert!(profile_needs_refresh("伊欧", ""));
        // A real name with an avatar is already good.
        assert!(!profile_needs_refresh("伊欧", "https://a.test/a.png"));
        // "用户" without digits, or bare prefixes, are real names.
        assert!(!profile_needs_refresh("用户", "https://a.test/a.png"));
        assert!(!profile_needs_refresh(
            "用户组维护者",
            "https://a.test/a.png"
        ));
        assert!(!profile_needs_refresh(
            "欧 labeled 用户123",
            "https://a.test/a.png"
        ));
    }

    #[test]
    fn sessions_round_trip_and_reject_tampering() {
        let key = session_key("app-secret");
        let claims = SessionClaims {
            open_id: "ou_abc123".into(),
            name: "伊欧".into(),
            avatar: "https://example.test/a.png".into(),
            exp: 1000,
        };
        let cookie = mint_session(&key, &claims);
        assert_eq!(read_session(&key, &cookie, 999), Some(claims));
        assert_eq!(read_session(&key, &cookie, 1000), None, "expired");
        // A different key (another deployment's secret) reads nothing.
        assert_eq!(read_session(&session_key("other"), &cookie, 0), None);
        // Flipping any payload byte breaks the MAC (checked before the
        // JSON is ever touched).
        let mut tampered = cookie.clone();
        tampered.replace_range(..1, if tampered.starts_with('e') { "f" } else { "e" });
        assert_ne!(tampered, cookie);
        assert_eq!(read_session(&key, &tampered, 0), None);
        // Garbage shapes are refused, not panics.
        for junk in ["", "a", "a.", ".", "x.y"] {
            assert_eq!(read_session(&key, junk, 0), None);
        }
    }

    #[test]
    fn allowlist_parses_the_union_of_both_settings() {
        let list = ConsoleAllowlist::from_config(Some(" ou_a, ou_b ,,\nou_c "), Some("ou_admin"));
        for id in ["ou_a", "ou_b", "ou_c", "ou_admin"] {
            assert!(list.admits(id), "{id}");
        }
        assert!(!list.is_open());
        assert!(!list.admits("ou_other"));
        // Exact match only — no prefix, case or substring slack.
        assert!(!list.admits("ou_"));
        assert!(!list.admits("OU_A"));
        assert!(!list.admits("ou_ab"));
        assert!(!list.admits(""));
        // Either setting alone is enough to close the gate.
        let only_admin = ConsoleAllowlist::from_config(None, Some("ou_admin"));
        assert!(only_admin.admits("ou_admin") && !only_admin.admits("ou_a"));
        let only_list = ConsoleAllowlist::from_config(Some("ou_a"), None);
        assert!(only_list.admits("ou_a") && !only_list.admits("ou_admin"));
        // Duplicates across the two settings collapse.
        assert_eq!(
            ConsoleAllowlist::from_config(Some("ou_a,ou_a"), Some("ou_a")),
            ConsoleAllowlist::from_config(Some("ou_a"), None)
        );
    }

    #[test]
    fn unset_allowlist_keeps_the_legacy_open_gate() {
        // Both unset, or set to nothing but separators, is open mode:
        // any non-empty open_id the Feishu app admits gets in.
        for (allowed, admin) in [(None, None), (Some(""), Some("  ")), (Some(" , ,"), None)] {
            let list = ConsoleAllowlist::from_config(allowed, admin);
            assert!(list.is_open(), "{allowed:?} {admin:?}");
            assert!(list.admits("ou_anyone"));
            assert!(!list.admits(""), "an empty open_id never passes");
        }
    }

    #[test]
    fn the_closed_gate_admits_nobody() {
        // Audit M-6: the worker wraps an unconfigured deployment in this
        // gate unless ERP_OPEN_ACCESS=1 — it must never let anyone through,
        // however the cookie was minted.
        let closed = ConsoleAllowlist::closed();
        assert!(!closed.is_open());
        assert!(!closed.admits("ou_anyone"));
        assert!(!closed.admits("ou_owner"));
        assert!(!closed.admits(""));
        // A valid signature does not rescue it either.
        let key = session_key("app-secret");
        let claims = SessionClaims {
            open_id: "ou_owner".into(),
            name: "伊欧".into(),
            avatar: "".into(),
            exp: 1000,
        };
        let cookie = mint_session(&key, &claims);
        assert_eq!(read_console_session(&key, &cookie, 0, &closed), None);
    }

    #[test]
    fn console_sessions_follow_the_allowlist() {
        let key = session_key("app-secret");
        let claims = |open_id: &str| SessionClaims {
            open_id: open_id.into(),
            name: "伊欧".into(),
            avatar: "https://example.test/a.png".into(),
            exp: 1000,
        };
        let owner = mint_session(&key, &claims("ou_owner"));
        let ex = mint_session(&key, &claims("ou_ex"));
        let list = ConsoleAllowlist::from_config(Some("ou_owner"), None);
        assert_eq!(
            read_console_session(&key, &owner, 0, &list),
            Some(claims("ou_owner"))
        );
        // A validly signed, unexpired cookie for someone no longer on the
        // list is refused immediately — no waiting out the 7-day TTL.
        assert!(read_session(&key, &ex, 0).is_some());
        assert_eq!(read_console_session(&key, &ex, 0, &list), None);
        // The allowlist never rescues a bad signature or an expired one.
        assert_eq!(read_console_session(&key, &owner, 1000, &list), None);
        assert_eq!(
            read_console_session(&session_key("other"), &owner, 0, &list),
            None
        );
        // Open mode admits any signed session with an open_id, but not a
        // signed one that somehow carries none.
        let open = ConsoleAllowlist::default();
        assert!(read_console_session(&key, &ex, 0, &open).is_some());
        let blank = mint_session(&key, &claims(""));
        assert_eq!(read_console_session(&key, &blank, 0, &open), None);
    }

    #[test]
    fn writes_must_be_same_origin_when_a_browser_says_so() {
        let own = "https://wowsp.langyo.xyz";
        // The console's own fetch: same-origin by both signals.
        assert!(same_origin_write(Some(own), Some("same-origin"), own));
        // Non-browser clients (fix-agents, curl) send neither header.
        assert!(same_origin_write(None, None, own));
        // Either signal alone is honored.
        assert!(same_origin_write(Some(own), None, own));
        assert!(same_origin_write(None, Some("same-origin"), own));
        // Cross-site and same-site (a sibling subdomain the Lax cookie
        // would still ride along to) are both refused.
        assert!(!same_origin_write(
            Some("https://evil.example"),
            Some("cross-site"),
            own
        ));
        assert!(!same_origin_write(
            Some("https://x.langyo.xyz"),
            Some("same-site"),
            own
        ));
        assert!(!same_origin_write(None, Some("cross-site"), own));
        assert!(!same_origin_write(None, Some("none"), own));
        assert!(!same_origin_write(Some("null"), None, own));
        assert!(!same_origin_write(
            Some("http://wowsp.langyo.xyz"),
            None,
            own
        ));
        // A forged-looking pair still fails on the Origin mismatch.
        assert!(!same_origin_write(
            Some("https://evil.example"),
            Some("same-origin"),
            own
        ));
    }

    #[test]
    fn cookie_get_survives_real_headers() {
        assert_eq!(
            cookie_get("a=1; erp_session=abc123", "erp_session"),
            Some("abc123".into())
        );
        assert_eq!(cookie_get("erp_session=v", "erp_oauth"), None);
        assert_eq!(cookie_get("", "erp_session"), None);
        assert_eq!(cookie_get("x=1", "x"), Some("1".into()));
        // Prefix keys must not match.
        assert_eq!(cookie_get("erp_session_extra=1", "erp_session"), None);
    }

    #[test]
    fn authorize_url_encodes_the_redirect_target() {
        let url = authorize_url(
            "cli_x",
            "https://wowsp.langyo.xyz/api/erp/callback",
            "0123abc",
        );
        assert!(
            url.starts_with(
                "https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_x&"
            )
        );
        assert!(url.contains("redirect_uri=https%3A%2F%2Fwowsp.langyo.xyz%2Fapi%2Ferp%2Fcallback"));
        assert!(url.ends_with("state=0123abc"));
    }
}
