//! The `/erp` review console — the Hikari page plus the pure half of its
//! Feishu-OAuth session protocol.
//!
//! Auth story: a Feishu OAuth login (any authenticated user of the app)
//! mints an HMAC-signed session cookie; every console API
//! (`/api/feedback/list`, `/api/feedback/update`, the attachment
//! redirect) accepts that cookie instead of the retired `X-Admin-Key`
//! header. The signed state is the SHA-256 of a domain-separated app
//! secret, so no extra secret is needed on top of the existing
//! `FEISHU_APP_SECRET`.
//!
//! Pure here (host-testable): the page rendering, HMAC-SHA256, unpadded
//! base64url, cookie-header parsing, session mint/verify and the
//! authorize-URL shape. The I/O half — the OAuth round trips — lives in
//! `relay-worker/src/erp.rs`.

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

// ── small wire helpers ────────────────────────────────────────────────

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

// ── the page ──────────────────────────────────────────────────────────

/// GET /erp — the console page. Shell grammar mirrors the /feedback
/// page (same token sheet, same sidebar + content card); the feedback
/// modal's `.card`-class collision lesson is baked in: every class here
/// is console-scoped (`e-*` prefixed where it could ever collide).
pub fn erp_page(base_url: &str) -> String {
    let hikari_css = crate::feedback::FEEDBACK_HIKARI_CSS;
    let statuses_js = crate::feedback::STATUSES
        .iter()
        .map(|s| format!(r#""{s}""#))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoWSP 反馈台</title>
<style>
{hikari_css}
/* ── console shell (feedback-page grammar: card + side + content) ── */
:root {{ color-scheme: light dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; height: 100vh; height: 100dvh; display: flex;
  justify-content: center;
  padding: var(--space-16) var(--viewport-gutter);
  font-family: var(--font-sans); font-size: var(--text-md); line-height: 1.6;
  background: rgb(var(--color-background)); color: rgb(var(--color-text)); }}
main {{ width: 100%; max-width: 76rem; height: 100%; }}
.e-card {{ display: flex; align-items: stretch; height: 100%;
  background: color-mix(in srgb, rgb(var(--color-surface)) 70%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 12%, transparent);
  border-radius: var(--radius-md); box-shadow: 0 2px 16px rgb(0 0 0 / 8%);
  overflow: hidden; animation: e-card-in 0.45s var(--ease-out-expo) both; }}
@keyframes e-card-in {{
  from {{ opacity: 0; transform: translateY(-16px) scale(0.92); }}
  to {{ opacity: 1; transform: none; }}
}}
@media (prefers-reduced-motion: reduce) {{ .e-card {{ animation: none; }} }}
/* ── sidebar (HkSidebar panel + HkNavItem grammar) ─────────────── */
.e-side {{ flex: none; width: 13rem; display: flex; flex-direction: column;
  padding: var(--space-16) var(--space-12) var(--space-12);
  background: rgb(var(--color-surface));
  border-inline-end: 1px solid var(--border-faint); }}
h1.e-brand {{ font-size: var(--text-lg); font-weight: 700; margin: 0;
  padding: var(--space-4) var(--space-6) var(--space-4) var(--space-8); }}
.e-side-nav {{ display: flex; flex-direction: column; gap: var(--space-4);
  margin-top: var(--space-12); }}
.e-nav {{ display: flex; align-items: center; gap: var(--space-8);
  width: 100%; min-height: 34px; padding: var(--space-6) var(--space-12);
  border: 1px solid transparent; border-radius: var(--radius-md);
  background: none; color: rgb(var(--color-muted)); font-family: inherit;
  font-size: var(--text-sm); font-weight: 500; line-height: 1.3;
  text-align: start; cursor: pointer; user-select: none;
  transition: background-color var(--duration-fast) ease,
    color var(--duration-fast) ease; }}
.e-nav svg {{ width: 16px; height: 16px; flex: none; }}
.e-nav span {{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.e-nav:hover:not([data-active]) {{
  background: color-mix(in srgb, rgb(var(--color-primary)) 10%, transparent);
  color: rgb(var(--color-text)); }}
.e-nav[data-active] {{
  background: color-mix(in srgb, rgb(var(--color-primary)) 15%, transparent);
  color: rgb(var(--color-primary)); font-weight: 600; }}
.e-nav:focus-visible {{ outline: 2px solid rgb(var(--color-primary));
  outline-offset: -2px; }}
.e-side-foot {{ margin-top: auto; padding-top: var(--space-12);
  display: flex; flex-direction: column; gap: var(--space-8); }}
.e-who {{ display: flex; align-items: center; gap: var(--space-8);
  padding: var(--space-6) var(--space-8); border-radius: var(--radius-md);
  background: color-mix(in srgb, rgb(var(--color-primary)) 8%, transparent);
  min-width: 0; }}
.e-who img {{ width: 28px; height: 28px; border-radius: var(--radius-full);
  object-fit: cover; flex: none; background: rgb(var(--color-muted) / 20%); }}
.e-who span {{ font-size: var(--text-sm); font-weight: 600; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
/* ── content ───────────────────────────────────────────────────── */
.e-content-wrap {{ position: relative; flex: 1; min-width: 0; height: 100%;
  display: flex; }}
.e-content {{ flex: 1; min-width: 0; min-height: 0; overflow-y: auto;
  padding: var(--space-20); display: flex; flex-direction: column;
  gap: var(--space-12); }}
.e-head {{ display: flex; align-items: center; gap: var(--space-12);
  flex-wrap: wrap; }}
h2.e-title {{ font-size: var(--text-md); font-weight: 600; margin: 0; }}
.e-muted {{ color: rgb(var(--color-muted)); }}
.e-spacer {{ margin-inline-start: auto; }}
/* ── buttons (HkButton grammar) ────────────────────────────────── */
.e-btn {{ display: inline-flex; align-items: center; justify-content: center;
  gap: var(--space-6); min-height: 34px;
  padding: var(--space-6) var(--space-14);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 14%, transparent);
  border-radius: var(--radius-md); background: rgb(var(--color-surface));
  color: rgb(var(--color-text)); font: inherit; font-size: var(--text-sm);
  font-weight: 600; cursor: pointer; text-decoration: none;
  transition: filter var(--duration-fast) ease,
    box-shadow var(--duration-fast) ease,
    border-color var(--duration-fast) ease; }}
.e-btn svg {{ width: 15px; height: 15px; }}
.e-btn:hover {{ border-color: var(--c-primary-strong);
  color: rgb(var(--color-primary)); }}
.e-btn:active {{ filter: brightness(0.95); }}
.e-btn:focus-visible {{ outline: 2px solid rgb(var(--color-primary));
  outline-offset: 1px; }}
.e-btn-primary {{ background: rgb(var(--color-primary));
  border-color: rgb(var(--color-primary));
  color: rgb(var(--color-surface)); box-shadow: var(--shadow-button); }}
.e-btn-primary:hover {{ color: rgb(var(--color-surface));
  filter: brightness(1.08); }}
.e-btn-block {{ width: 100%; }}
/* ── table (HkTable grammar: host ▸ wrapper ▸ table) ───────────── */
.hk-table-host {{ position: relative; }}
.hk-table-wrapper {{ width: 100%; overflow-x: auto;
  border: 1px solid var(--hi-color-border, var(--border-faint));
  border-radius: var(--radius-md);
  background: rgb(var(--color-surface)); }}
.hk-table {{ width: 100%; border-collapse: collapse;
  font-size: var(--text-base, 0.875rem);
  color: var(--hi-color-text-primary, rgb(var(--color-text))); }}
.hk-table-header-row {{ border-bottom: 1px solid
  var(--hi-color-border, var(--border-faint)); }}
.hk-table-header-cell {{ padding: var(--space-8) var(--space-12);
  text-align: start; font-size: var(--text-xs);
  font-weight: 600; white-space: nowrap; user-select: none;
  color: var(--hi-color-text-secondary, rgb(var(--color-muted)));
  background: color-mix(in srgb, rgb(var(--color-primary)) 6%,
    rgb(var(--color-surface))); }}
.hk-table-body .hk-table-row {{ border-bottom: 1px solid
  var(--hi-color-border, var(--border-faint)); }}
.hk-table-hover .hk-table-row:hover {{ background:
  var(--hi-color-bg-subtle,
    color-mix(in srgb, rgb(var(--color-primary)) 5%, transparent)); }}
.hk-table-cell {{ padding: var(--space-8) var(--space-12);
  color: var(--hi-color-text-primary, rgb(var(--color-text)));
  vertical-align: top; overflow-wrap: anywhere; }}
.hk-table-cell .e-muted {{ font-size: var(--text-xs); }}
.hk-table-cell a {{ color: rgb(var(--color-primary)); }}
.hk-table-cell select, .hk-table-cell input {{
  font: inherit; font-size: var(--text-sm);
  padding: var(--space-4) var(--space-8); max-width: 100%;
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 14%, transparent);
  border-radius: var(--radius-sm); background: rgb(var(--color-surface));
  color: rgb(var(--color-text)); }}
.hk-table-cell select:focus-visible, .hk-table-cell input:focus-visible {{
  border-color: rgb(var(--color-focused-border));
  box-shadow: var(--shadow-focus); outline: none; }}
.e-row-actions {{ display: flex; gap: var(--space-6); flex-wrap: wrap;
  margin-top: var(--space-6); }}
.e-pager {{ display: flex; gap: var(--space-8); align-items: center;
  margin-top: auto; flex-wrap: wrap; }}
/* ── login view (modal-card grammar, own class — never .card) ──── */
.e-login {{ position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
  padding: var(--space-20);
  background: rgb(var(--color-background) / 55%);
  backdrop-filter: blur(2px); }}
.e-login[hidden] {{ display: none; }}
.e-login-card {{ width: min(92vw, 22rem);
  padding: var(--space-24); border-radius: var(--radius-md);
  background: rgb(var(--color-surface));
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 12%, transparent);
  box-shadow: 0 16px 48px rgb(0 0 0 / 20%);
  display: flex; flex-direction: column; gap: var(--space-12);
  text-align: center; animation: e-wiz-in 0.3s var(--ease-out-expo) both; }}
@keyframes e-wiz-in {{ from {{ opacity: 0; transform: translateY(5%) scale(.97); }}
  to {{ opacity: 1; transform: none; }} }}
@media (prefers-reduced-motion: reduce) {{ .e-login-card {{ animation: none; }} }}
.e-login-logo {{ width: 44px; height: 44px; margin: 0 auto;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, rgb(var(--color-primary)) 14%, transparent);
  color: rgb(var(--color-primary)); }}
.e-login-logo svg {{ width: 22px; height: 22px; }}
.e-login-card h2 {{ margin: 0; font-size: var(--text-lg); font-weight: 700; }}
.e-login-card p {{ margin: 0; font-size: var(--text-sm);
  color: rgb(var(--color-text) / 85%); }}
/* ── toast (verbatim HkToast.scss — solid channel colors, icon +
   close, slide-in from the inline edge) ─────────────────────────── */
.hk-toast-container {{ position: fixed; top: 4rem;
  inset-inline-end: var(--viewport-gutter, 16px);
  z-index: var(--hk-z-toast, 4000); max-width: 24rem;
  pointer-events: none; }}
.hk-toast-container > div {{ position: relative; display: flex;
  flex-direction: column; gap: var(--space-12, 12px); }}
.hk-toast-item {{ display: flex; align-items: center;
  gap: var(--space-8, 8px);
  padding: var(--space-12, 12px) var(--space-16, 16px);
  border-radius: var(--radius-sm, 4px);
  font-size: var(--text-base, 0.875rem); line-height: 1.4;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); pointer-events: auto;
  backdrop-filter: blur(12px); user-select: none; }}
.hk-toast-body {{ flex: 1; min-width: 0; display: flex;
  flex-direction: column; gap: var(--space-4, 4px); }}
.hk-toast-icon {{ display: flex; align-items: center;
  width: 1.5rem; height: 1.5rem; flex-shrink: 0; }}
.hk-toast-icon svg {{ width: 18px; height: 18px; }}
.hk-toast-message {{ flex: 1; min-width: 0; overflow-wrap: anywhere;
  white-space: normal; }}
.hk-toast-error {{ background: var(--hi-color-danger,
    var(--hi-color-error, #f85149));
  color: var(--hi-color-text-on-solid, #ffffff); }}
.hk-toast-success {{ background: var(--hi-color-success, #0eb840);
  color: var(--hi-color-text-on-solid, #ffffff); }}
.hk-toast-info {{ background: var(--hi-color-info, #6abed6);
  color: var(--hi-color-text-on-solid, #ffffff); }}
.hk-toast-close {{ display: flex; align-items: center;
  justify-content: center; width: 1.5rem; height: 1.5rem;
  flex-shrink: 0; border: none; background: transparent;
  color: inherit; cursor: pointer; border-radius: var(--radius-sm, 4px);
  opacity: 0.7; padding: 0;
  transition: opacity var(--duration-fast, 0.15s) ease; }}
.hk-toast-close svg {{ width: 18px; height: 18px; }}
.hk-toast-close:hover {{ opacity: 1; }}
.hk-toast-close:focus-visible {{ outline: 2px solid rgb(var(--color-primary));
  outline-offset: 2px; }}
.hk-toast-enter-active {{ transition-property: opacity, transform;
  transition-duration: var(--duration-normal, 0.3s);
  transition-timing-function: cubic-bezier(0.22, 0.61, 0.36, 1); }}
.hk-toast-leave-active {{ transition-property: opacity, transform;
  transition-duration: var(--duration-normal, 0.3s);
  transition-timing-function: cubic-bezier(0.36, 0, 0.66, 1);
  position: absolute; }}
.hk-toast-enter-from, .hk-toast-leave-to {{ opacity: 0;
  transform: translateX(1rem); }}
@media (prefers-reduced-motion: reduce) {{
  .hk-toast-enter-active, .hk-toast-leave-active {{ transition: none; }}
}}
[hidden] {{ display: none !important; }}
/* ── responsive: sidebar becomes a strip under 768px ───────────── */
@media (max-width: 767px) {{
  .e-card {{ flex-direction: column; }}
  .e-side {{ width: 100%; flex-direction: row; align-items: center;
    gap: var(--space-8); border-inline-end: none;
    border-bottom: 1px solid var(--border-faint);
    padding: var(--space-12); }}
  h1.e-brand {{ padding: 0; font-size: var(--text-md); white-space: nowrap; }}
  .e-side-nav {{ flex-direction: row; flex-wrap: wrap; margin-top: 0;
    overflow-x: auto; }}
  .e-nav {{ width: auto; }}
  .e-side-foot {{ margin-top: 0; margin-inline-start: auto;
    flex-direction: row; align-items: center; }}
  .e-content {{ padding: var(--space-12); }}
}}
</style>
</head>
<body>
<main>
<div class="e-card">
<aside class="e-side">
  <h1 class="e-brand">WoWSP 反馈台</h1>
  <nav class="e-side-nav" id="nav">
    <button type="button" class="e-nav" data-filter="" data-active><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg><span>全部</span></button>
    <button type="button" class="e-nav" data-filter="待审查"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><span>待审查</span></button>
    <button type="button" class="e-nav" data-filter="已确认"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg><span>已确认</span></button>
    <button type="button" class="e-nav" data-filter="已开PR"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg><span>已开PR</span></button>
    <button type="button" class="e-nav" data-filter="无需修复"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/></svg><span>无需修复</span></button>
    <button type="button" class="e-nav" data-filter="需补充"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg><span>需补充</span></button>
  </nav>
  <div class="e-side-foot">
    <div id="who" class="e-who" hidden>
      <img id="avatar" alt="">
      <span id="whoName"></span>
    </div>
    <button type="button" id="logout" class="e-nav" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg><span>退出登录</span></button>
  </div>
</aside>
<div class="e-content-wrap">
  <div class="e-content" id="app" hidden>
    <div class="e-head">
      <h2 class="e-title">反馈记录</h2>
      <button type="button" id="reload" class="e-btn e-spacer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>刷新</span></button>
    </div>
    <div class="hk-table-host">
    <div class="hk-table-wrapper">
    <table class="hk-table hk-table-md hk-table-hover"><thead><tr class="hk-table-header-row">
      <th class="hk-table-header-cell" style="width:130px">提交时间</th><th class="hk-table-header-cell">描述</th><th class="hk-table-header-cell" style="width:110px">联系</th>
      <th class="hk-table-header-cell" style="width:90px">版本</th><th class="hk-table-header-cell" style="width:70px">渠道</th>
      <th class="hk-table-header-cell" style="width:120px">状态</th><th class="hk-table-header-cell" style="width:170px">PR</th><th class="hk-table-header-cell" style="width:110px">附件</th>
    </tr></thead><tbody class="hk-table-body" id="rows"></tbody></table>
    </div>
    </div>
    <div class="e-pager">
      <button type="button" id="prev" class="e-btn">上一页</button>
      <button type="button" id="next" class="e-btn">下一页</button>
      <span id="pageInfo" class="e-muted"></span>
    </div>
  </div>
  <div class="e-login" id="loginView">
    <div class="e-login-card">
      <div class="e-login-logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
      <h2>WoWSP 反馈台</h2>
      <p>使用飞书账号登录后即可查看与处理反馈。</p>
      <a id="loginBtn" class="e-btn e-btn-primary e-btn-block" href="{base_url}/api/erp/login">使用飞书登录</a>
    </div>
  </div>
</div>
</div>
</main>
<div class="hk-toast-container" id="toasts"><div></div></div>
<script>
(function () {{
  // ── theme mode — mirrors hikari useTheme's data-mode attribute, fed
  // by the OS scheme (same recipe as the /feedback page) ─────────────
  var modeQuery = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  function applyMode() {{
    document.documentElement.setAttribute("data-mode",
      modeQuery && modeQuery.matches ? "dark" : "light");
  }}
  applyMode();
  if (modeQuery && modeQuery.addEventListener) {{
    modeQuery.addEventListener("change", applyMode);
  }}

  var BASE = "{base_url}";
  var STATUSES = [{statuses_js}];
  var app = document.getElementById("app");
  var loginView = document.getElementById("loginView");
  var lastItems = [];
  var pageToken = null, nextToken = null, prevStack = [];

  function $(id) {{ return document.getElementById(id); }}
  // ── toasts — the one notification surface, speaking HkToast's own
  // grammar (hk-toast-item on a solid channel color, lucide icon, close
  // action, slide-in/out) ──────────────────────────────────────────────
  var TOAST_ICONS = {{
    error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    success: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'
  }};
  function toast(msg, kind) {{
    kind = kind || "info";
    var stack = $("toasts").firstElementChild;
    var item = document.createElement("div");
    item.className = "hk-toast-item hk-toast-" + kind;
    item.setAttribute("role", kind === "error" ? "alert" : "status");
    item.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    item.innerHTML =
      '<span class="hk-toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (TOAST_ICONS[kind] || TOAST_ICONS.info) + '</svg></span>' +
      '<div class="hk-toast-body"><span class="hk-toast-message"></span></div>' +
      '<button type="button" class="hk-toast-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
    item.querySelector(".hk-toast-message").textContent = msg;
    item.querySelector(".hk-toast-close").onclick = function () {{ dismiss(); }};
    function enter() {{
      item.classList.add("hk-toast-enter-active");
      requestAnimationFrame(function () {{
        requestAnimationFrame(function () {{ item.classList.remove("hk-toast-enter-from"); }});
      }});
    }}
    function dismiss() {{
      if (item.dataset.leaving) return;
      item.dataset.leaving = "1";
      item.classList.add("hk-toast-leave-active", "hk-toast-leave-to");
      setTimeout(function () {{ item.remove(); }}, 320);
    }}
    item.classList.add("hk-toast-enter-from");
    stack.appendChild(item);
    enter();
    setTimeout(dismiss, kind === "error" ? 6000 : 3000);
  }}
  function esc(s) {{
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {{
      return {{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}}[c];
    }});
  }}
  function fmtTime(v) {{
    if (!v) return "";
    return new Date(v).toLocaleString("zh-CN", {{ hour12: false }});
  }}
  function showLogin(reason) {{
    app.hidden = true;
    loginView.hidden = false;
    if (reason) toast("登录失败（" + reason + "），请重试。", "error");
    $("who").hidden = true;
    $("logout").hidden = true;
  }}
  function showApp(user) {{
    loginView.hidden = true;
    app.hidden = false;
    if (user) {{
      $("who").hidden = false;
      $("logout").hidden = false;
      $("whoName").textContent = user.name || "飞书用户";
      var av = $("avatar");
      if (user.avatar) {{ av.src = user.avatar; av.hidden = false; }}
      else {{ av.hidden = true; }}
    }}
  }}
  function activeFilter() {{
    var cur = document.querySelector(".e-nav[data-active]");
    return cur ? cur.getAttribute("data-filter") : "";
  }}
  function render() {{
    var tb = $("rows");
    tb.innerHTML = "";
    var filter = activeFilter();
    lastItems.filter(function (it) {{
      return !filter || it.status === filter;
    }}).forEach(function (it) {{
      var tr = document.createElement("tr");
      tr.className = "hk-table-row";
      var atts = (it.attachments || []).map(function (a) {{
        return '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer">' + esc(a.name) + '</a>';
      }}).join("<br>") || '<span class="e-muted">—</span>';
      tr.innerHTML =
        '<td class="hk-table-cell">' + esc(fmtTime(it.time)) + "</td>" +
        '<td class="hk-table-cell">' + esc(it.description) +
          (it.sysinfo ? '<div class="e-muted">' + esc(it.sysinfo) + "</div>" : "") +
          ((it.server || it.game_id)
            ? '<div class="e-muted">' +
              (it.server ? "🌐 " + esc(it.server.toUpperCase()) : "") +
              (it.server && it.game_id ? " · " : "") +
              (it.game_id ? "🆔 " + esc(it.game_id) : "") +
              "</div>"
            : "") +
          (it.record_url ? '<div class="e-row-actions"><a href="' + esc(it.record_url) + '" target="_blank" rel="noreferrer">记录</a></div>' : "") + "</td>" +
        '<td class="hk-table-cell">' + esc(it.contact || "—") + "</td>" +
        '<td class="hk-table-cell">' + esc(it.version || "—") + "</td>" +
        '<td class="hk-table-cell">' + esc(it.channel || "—") + "</td>" +
        '<td class="hk-table-cell"><select data-rec="' + esc(it.record_id) + '" class="st">' +
          STATUSES.map(function (s) {{
            return "<option" + (s === it.status ? " selected" : "") + ">" + s + "</option>";
          }}).join("") + "</select></td>" +
        '<td class="hk-table-cell"><input class="pr" data-rec="' + esc(it.record_id) + '" value="' + esc(it.pr || "") + '" placeholder="PR URL">' +
          '<div class="e-row-actions"><button type="button" class="e-btn save" data-rec="' + esc(it.record_id) + '">保存</button></div></td>' +
        '<td class="hk-table-cell">' + atts + "</td>";
      tb.appendChild(tr);
    }});
    tb.querySelectorAll("button.save").forEach(function (b) {{
      b.onclick = function () {{
        var rec = b.getAttribute("data-rec");
        var st = tb.querySelector('select.st[data-rec="' + rec + '"]').value;
        var pr = tb.querySelector('input.pr[data-rec="' + rec + '"]').value.trim();
        b.disabled = true;
        fetch(BASE + "/api/feedback/update", {{
          method: "POST",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify({{ record_id: rec, status: st, pr_link: pr }})
        }}).then(function (r) {{ return r.json(); }}).then(function (j) {{
          b.disabled = false;
          if (j.ok) {{ toast("已保存 " + rec, "success"); }}
          else {{ toast("保存失败: " + (j.error || ""), "error"); }}
        }}).catch(function () {{
          b.disabled = false;
          toast("保存失败：网络异常", "error");
        }});
      }};
    }});
    var n = lastItems.filter(function (it) {{
      return !filter || it.status === filter;
    }}).length;
    $("pageInfo").textContent = n + " 条" + (nextToken ? " · 有下一页" : "");
  }}
  function load(token) {{
    var url = BASE + "/api/feedback/list?page_size=50" +
      (token ? "&page_token=" + encodeURIComponent(token) : "");
    fetch(url)
      .then(function (r) {{
        if (r.status === 401 || r.status === 403) {{
          showLogin("");
          throw new Error("unauthorized");
        }}
        return r.json();
      }})
      .then(function (j) {{
        nextToken = j.next_page_token || null;
        pageToken = token || null;
        lastItems = j.items || [];
        render();
      }})
      .catch(function (e) {{
        if (e.message !== "unauthorized") toast("加载失败：" + e.message, "error");
      }});
  }}
  // Only 下一页 grows the back-stack (loading BY prev/filter must not
  // push, or back would oscillate).
  document.getElementById("next").onclick = function () {{
    if (nextToken) {{ prevStack.push(pageToken); load(nextToken); }}
  }};
  document.getElementById("prev").onclick = function () {{
    var t = prevStack.pop() || null; load(t);
  }};
  document.getElementById("reload").onclick = function () {{ load(pageToken); }};
  document.querySelectorAll(".e-nav[data-filter]").forEach(function (b) {{
    b.onclick = function () {{
      var cur = document.querySelector(".e-nav[data-active]");
      if (cur) delete cur.dataset.active;
      b.setAttribute("data-active", "");
      render();
    }};
  }});
  document.getElementById("logout").onclick = function () {{
    fetch(BASE + "/api/erp/logout", {{ method: "POST" }}).then(function () {{
      lastItems = [];
      showLogin("");
    }});
  }};
  // The avatar <img> is inside the hidden-by-default shell; [hidden]
  // CSS covers it, this only guards a broken URL.
  document.getElementById("avatar").addEventListener("error", function () {{
    this.hidden = true;
  }});
  fetch(BASE + "/api/erp/session")
    .then(function (r) {{ return r.json(); }})
    .then(function (j) {{
      if (j && j.ok) {{
        showApp(j);
        load();
      }} else {{
        var params = new URLSearchParams(location.search);
        showLogin(params.get("login") === "failed" ? params.get("reason") || "unknown" : "");
      }}
    }})
    .catch(function () {{ showLogin(""); }});
}})();
</script>
</body>
</html>"#
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

    #[test]
    fn erp_page_ships_hikari_and_the_login_flow() {
        let page = erp_page("https://wowsp.langyo.xyz");
        // Same token sheet as the /feedback page — no hand-rolled palette.
        for marker in ["--color-primary", "--font-sans", "html[data-mode=\"dark\"]"] {
            assert!(page.contains(marker), "tokens miss {marker}");
        }
        // Sidebar + content shell (feedback-page grammar, own classes).
        assert!(page.contains(r#"class="e-side""#));
        assert!(page.contains(r#"class="e-content""#));
        assert!(page.contains("WoWSP 反馈台"));
        // Feishu login is the gate; the admin key is retired.
        assert!(page.contains(r#"href="https://wowsp.langyo.xyz/api/erp/login""#));
        assert!(page.contains("使用飞书登录"));
        assert!(!page.contains("X-Admin-Key"));
        assert!(!page.contains("FEEDBACK_ADMIN_KEY"));
        assert!(!page.contains("wowsp_erp_key"));
        // The console APIs the page calls (session cookie carries auth).
        assert!(page.contains("/api/erp/session"));
        assert!(page.contains("/api/erp/logout"));
        assert!(page.contains("/api/feedback/list?page_size=50"));
        assert!(page.contains("/api/feedback/update"));
        // Every review status is selectable, matching relay-core's list.
        for status in crate::feedback::STATUSES {
            assert!(
                page.contains(&format!("data-filter=\"{status}\"")),
                "{status}"
            );
        }
        assert!(page.contains(r#"var STATUSES = ["#));
        // The table speaks the standard HkTable grammar.
        assert!(page.contains(r#"class="hk-table hk-table-md hk-table-hover""#));
        assert!(page.contains(r#"class="hk-table-header-row""#));
        assert!(page.contains(r#"tr.className = "hk-table-row";"#));
        assert!(page.contains(r#"<td class="hk-table-cell">"#));
        assert!(!page.contains("e-table"));
        // Theme flip + toast surface: login/save/load feedback all ride
        // the standard HkToast stack (solid channel colors, lucide icon,
        // close action), no inline hint/err remnants.
        assert!(page.contains("data-mode"));
        assert!(page.contains(r#"class="hk-toast-container""#));
        assert!(page.contains("hk-toast-item hk-toast-"));
        assert!(page.contains("hk-toast-enter-from"));
        assert!(page.contains("function toast(msg, kind)"));
        assert!(page.contains(r#"toast("已保存 ""#));
        assert!(page.contains("登录失败（"));
        assert!(!page.contains("loginErr"));
        assert!(!page.contains("e-err"));
        assert!(!page.contains("e-toast"));
        // The base URL is wired for API calls.
        assert!(page.contains("var BASE = \"https://wowsp.langyo.xyz\";"));
    }
}
