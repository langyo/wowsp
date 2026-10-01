//! Feedback pipeline policy: validation limits, Bitable field mapping,
//! Turnstile wire shapes, rate-limit key layout, and the two embedded
//! pages (`/feedback` form + `/erp` console). Pure and host-testable —
//! the worker crate supplies fetch/KV/clock I/O only.

use std::sync::OnceLock;

use serde_json::{Map, Value, json};

// ── Bitable schema (field names as created in the 反馈 table) ──────────

pub const F_DESC: &str = "反馈描述";
pub const F_CONTACT: &str = "联系方式";
pub const F_VERSION: &str = "应用版本";
pub const F_SYS: &str = "系统信息";
pub const F_CHANNEL: &str = "渠道";
pub const F_ANON: &str = "匿名ID";
pub const F_SERVER: &str = "主要服务器";
pub const F_GAME_ID: &str = "游戏ID";
pub const F_LOG: &str = "日志包";
pub const F_STATUS: &str = "处理状态";
pub const F_PR: &str = "PR链接";
pub const F_TIME: &str = "提交时间";

/// The five game servers a submission can name (the app's realm ids).
pub const REALMS: [&str; 5] = ["ru", "eu", "na", "asia", "cn"];

/// Base + table names the bootstrap pass creates.
pub const BASE_NAME: &str = "WoWSP 反馈";
pub const TABLE_NAME: &str = "反馈";

/// Default status a fresh record lands in (the review queue).
pub const STATUS_NEW: &str = "待审查";
/// Every status the /erp console may set on a record.
pub const STATUSES: &[&str] = &["待审查", "已确认", "已开PR", "无需修复", "需补充"];

// ── limits ─────────────────────────────────────────────────────────────

pub const DESC_MAX: usize = 5_000;
pub const CONTACT_MAX: usize = 64;
pub const META_MAX: usize = 200;
pub const ANON_MAX: usize = 48;
/// Log bundle upload cap. Feishu `upload_all` tops out at 20 MiB, but the
/// free-plan Worker CPU budget (parse + rebuild multipart) is the real
/// ceiling — 4 MiB keeps both comfortable (typical log zips are < 1 MiB).
pub const FILE_MAX: usize = 4 * 1024 * 1024;
/// Screenshot/image cap (browser screenshots paste in at a few MB).
pub const IMAGE_MAX: usize = 10 * 1024 * 1024;
/// Screen-recording cap. A 10-second 720p webm lands at 2–8 MB; 18 MiB
/// stays under Feishu `upload_all`'s 20 MiB ceiling with headroom.
pub const VIDEO_MAX: usize = 18 * 1024 * 1024;
/// Log bundles (the app's zip export, raw logs).
pub const LOG_EXTS: &[&str] = &["zip", "log", "txt", "gz"];
/// Screenshots / pasted images.
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];
/// Screen recordings (MediaRecorder in browsers emits webm; mp4 for
/// Safari).
pub const VIDEO_EXTS: &[&str] = &["webm", "mp4", "mov"];
/// The largest cap any single attachment may hit (drives the request
/// body precheck).
pub const ATTACHMENT_MAX: usize = VIDEO_MAX;
/// Uploaded file-name length cap (after control-character stripping).
pub const FILENAME_MAX: usize = 200;

/// Per-IP submissions per hour.
pub const RATE_IP_PER_HOUR: u64 = 5;
/// Per-anonymous-id submissions per UTC day.
pub const RATE_ANON_PER_DAY: u64 = 10;
/// Per-contact (QQ / email) submissions per UTC day — the abuse ceiling
/// the operator asked for.
pub const RATE_CONTACT_PER_DAY: u64 = 20;
/// Global submissions per UTC day (the kill-switch ceiling).
pub const RATE_GLOBAL_PER_DAY: u64 = 300;
/// History lookups per IP per hour (the lookup endpoint is public).
pub const RATE_HISTORY_PER_HOUR: u64 = 30;
/// Description snippet length in public history rows (limits cross-contact
/// information disclosure through the lookup endpoint).
pub const HISTORY_SNIPPET: usize = 120;

/// The kind of an attachment, by extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachKind {
    Log,
    Image,
    Video,
}

/// Classify a (sanitized) file name; `None` when the extension is not
/// accepted at all.
pub fn attach_kind(name: &str) -> Option<AttachKind> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    if LOG_EXTS.contains(&ext.as_str()) {
        Some(AttachKind::Log)
    } else if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(AttachKind::Image)
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        Some(AttachKind::Video)
    } else {
        None
    }
}

/// Size cap for a given attachment kind.
pub fn attach_max(kind: AttachKind) -> usize {
    match kind {
        AttachKind::Log => FILE_MAX,
        AttachKind::Image => IMAGE_MAX,
        AttachKind::Video => VIDEO_MAX,
    }
}

// ── submission ─────────────────────────────────────────────────────────

/// One parsed feedback submission (text fields already owned Strings).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Submission {
    pub description: String,
    pub contact: String,
    pub version: String,
    pub sysinfo: String,
    pub channel: String,
    pub anon_id: String,
    pub server: String,
    pub game_id: String,
    /// Every `file` part of the submission, in order (the desktop form
    /// sends a screenshot AND a log bundle in one request).
    pub files: Vec<(Option<String>, Vec<u8>)>,
}

/// Strip control characters and clamp length — every free-text field runs
/// through this before it reaches the Bitable.
fn clean(s: &str, max: usize) -> String {
    let trimmed: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let trimmed = trimmed.trim().to_string();
    truncated(&trimmed, max)
}

/// Char-boundary-aware truncation.
fn truncated(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Validate + normalize a submission. `Err` carries a stable code the
/// form maps to a localized message.
pub fn normalize(sub: &mut Submission) -> Result<(), &'static str> {
    sub.description = clean(&sub.description, DESC_MAX);
    sub.contact = clean(&sub.contact, CONTACT_MAX);
    sub.version = clean(&sub.version, META_MAX);
    sub.sysinfo = clean(&sub.sysinfo, META_MAX);
    sub.anon_id = clean(&sub.anon_id, ANON_MAX);
    // Server is a single-select: lowercase and keep only known realms so
    // the Bitable column never sees junk; game id is a short opaque token.
    let server = clean(&sub.server, 16).to_lowercase();
    sub.server = if REALMS.contains(&server.as_str()) {
        server
    } else {
        String::new()
    };
    sub.game_id = clean(&sub.game_id, 32);

    if sub.description.is_empty() {
        return Err("empty_description");
    }
    if !matches!(sub.channel.as_str(), "desktop" | "web" | "android") {
        return Err("bad_channel");
    }
    if sub.anon_id.is_empty() {
        sub.anon_id = "anon".into();
    }
    for (name, _) in sub.files.iter_mut() {
        // The name rides an outbound Content-Disposition header line —
        // strip everything that could break the quoting/framing, cap the
        // length (stem-only, extension preserved)…
        *name = name.take().map(|n| {
            let cleaned: String = n
                .chars()
                .filter(|c| *c != '"' && *c != '\r' && *c != '\n' && *c != '\\')
                .collect();
            cap_name(&cleaned, FILENAME_MAX)
        });
    }
    // …then the kind check (extension) and the per-kind size cap run on
    // the FINAL name — for every attachment.
    for (name, bytes) in sub.files.iter() {
        let Some(name) = name.as_deref().filter(|n| !n.is_empty()) else {
            return Err("bad_file_type");
        };
        match attach_kind(name) {
            None => return Err("bad_file_type"),
            Some(kind) if bytes.len() > attach_max(kind) => return Err("file_too_large"),
            Some(_) => {},
        }
    }
    Ok(())
}

/// Truncate a file name to `max` chars by cutting the STEM — the
/// extension (and thus the allowlist verdict) survives.
fn cap_name(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !e.is_empty() && !e.contains(['/', '\\']) => (s, Some(e)),
        _ => (name, None),
    };
    let budget = max.saturating_sub(ext.map(|e| e.chars().count() + 1).unwrap_or(0));
    let mut out: String = stem.chars().take(budget).collect();
    if let Some(e) = ext {
        out.push('.');
        out.push_str(e);
    }
    out
}

/// Bitable `fields` payload for a new record. `now_ms` is injected so the
/// builder stays testable.
pub fn record_fields(sub: &Submission, now_ms: i64) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(F_DESC.into(), json!(sub.description));
    if !sub.contact.is_empty() {
        // Store the canonical lookup form so handle_history's exact-match
        // filter on the normalized query finds mixed-case/spacey originals.
        m.insert(F_CONTACT.into(), json!(normalize_contact(&sub.contact)));
    }
    if !sub.version.is_empty() {
        m.insert(F_VERSION.into(), json!(sub.version));
    }
    if !sub.sysinfo.is_empty() {
        m.insert(F_SYS.into(), json!(sub.sysinfo));
    }
    if !sub.server.is_empty() {
        m.insert(F_SERVER.into(), json!(sub.server));
    }
    if !sub.game_id.is_empty() {
        m.insert(F_GAME_ID.into(), json!(sub.game_id));
    }
    m.insert(F_CHANNEL.into(), json!(sub.channel));
    m.insert(F_ANON.into(), json!(sub.anon_id));
    m.insert(F_STATUS.into(), json!(STATUS_NEW));
    // Bitable date fields take epoch milliseconds.
    m.insert(F_TIME.into(), json!(now_ms));
    m
}

/// `PUT records/{id}` body attaching an uploaded file to the 日志包 field.
pub fn attachment_update_body(file_tokens: &[String]) -> Value {
    json!({ "fields": { F_LOG: file_tokens
        .iter()
        .map(|t| json!({ "file_token": t }))
        .collect::<Vec<_>>() } })
}

/// The 反馈 table schema the bootstrap pass creates (Bitable field types:
/// 1 text, 3 single-select, 5 date, 15 url, 17 attachment).
pub fn table_schema() -> Value {
    json!({
        "table": {
            "name": TABLE_NAME,
            "fields": [
                { "field_name": F_DESC, "type": 1 },
                { "field_name": F_CONTACT, "type": 1 },
                { "field_name": F_VERSION, "type": 1 },
                { "field_name": F_SYS, "type": 1 },
                { "field_name": F_SERVER, "type": 3, "property": { "options": REALMS
                    .iter()
                    .map(|r| json!({ "name": r }))
                    .collect::<Vec<_>>() } },
                { "field_name": F_GAME_ID, "type": 1 },
                { "field_name": F_CHANNEL, "type": 3, "property": { "options": [
                    { "name": "desktop" }, { "name": "web" }, { "name": "android" }
                ] } },
                { "field_name": F_ANON, "type": 1 },
                { "field_name": F_LOG, "type": 17 },
                { "field_name": F_STATUS, "type": 3, "property": { "options": STATUSES
                    .iter()
                    .map(|s| json!({ "name": s }))
                    .collect::<Vec<_>>() } },
                { "field_name": F_PR, "type": 15 },
                { "field_name": F_TIME, "type": 5 },
            ],
        }
    })
}

// ── Turnstile ──────────────────────────────────────────────────────────

/// `application/x-www-form-urlencoded` body for the siteverify call
/// (values percent-encoded — a `+`/`&` in the secret must not be eaten).
pub fn turnstile_verify_body(secret: &str, response: &str, remoteip: &str) -> String {
    format!(
        "secret={}&response={}&remoteip={}",
        urlencode(secret),
        urlencode(response),
        urlencode(remoteip)
    )
}

/// A siteverify response passes when `success` is true (error codes are
/// surfaced by the caller via logging, not branching).
pub fn turnstile_passed(v: &Value) -> bool {
    v.get("success").and_then(Value::as_bool).unwrap_or(false)
}

/// Sitekeys are public but ride into HTML — only allow the Turnstile
/// alphabet so the value can never break out of the attribute.
pub fn valid_sitekey(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 100
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ── rate-limit key layout ──────────────────────────────────────────────

/// Integer time buckets keep the layout clock-format-free (UTC).
/// Submit keys: IP/hour, anon/day, contact/day (only when a contact was
/// given), global/day.
pub fn rate_keys(ip: &str, anon: &str, contact: &str, now_ms: i64) -> Vec<String> {
    let hour = now_ms.div_euclid(3_600_000);
    let day = now_ms.div_euclid(86_400_000);
    let mut keys = vec![
        format!("rl:ip:{ip}:{hour}"),
        format!("rl:anon:{anon}:{day}"),
    ];
    if !contact.is_empty() {
        keys.push(format!("rl:contact:{}:{day}", normalize_contact(contact)));
    }
    keys.push(format!("rl:day:{day}"));
    keys
}

/// Which limit each key from [`rate_keys`] is compared against (same
/// order; the contact slot mirrors the key's presence).
pub fn rate_limits(contact: &str) -> Vec<u64> {
    let mut limits = vec![RATE_IP_PER_HOUR, RATE_ANON_PER_DAY];
    if !contact.is_empty() {
        limits.push(RATE_CONTACT_PER_DAY);
    }
    limits.push(RATE_GLOBAL_PER_DAY);
    limits
}

/// Canonical lookup form for a contact: trimmed, lowercased (emails),
/// interior whitespace collapsed — " QQ 123@QQ.com " and "123@qq.com"
/// must share one bucket.
pub fn normalize_contact(contact: &str) -> String {
    let lower = contact.trim().to_lowercase();
    lower.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// History-lookup rate key (per IP per hour).
pub fn history_rate_key(ip: &str, now_ms: i64) -> String {
    format!("rl:hist:{ip}:{}", now_ms.div_euclid(3_600_000))
}

/// Percent-encode a query/component value (RFC 3986 unreserved kept).
/// Shared by the Turnstile form body and the worker's URL building.
pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            },
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── pages ──────────────────────────────────────────────────────────────

/// The /feedback page's locale table — the SAME res/i18n/locales facility
/// the webui consumes (en-US baseline, 9 locales, key parity enforced by
/// scripts/check_i18n.py). Compile-time embedded so the worker carries no
/// extra fetch; key sets must stay identical across files.
static FEEDBACK_LOCALE_FILES: &[(&str, &str)] = &[
    (
        "en-US",
        include_str!("../../../../../res/i18n/locales/en-US/feedback.json"),
    ),
    (
        "zh-CN",
        include_str!("../../../../../res/i18n/locales/zh-CN/feedback.json"),
    ),
    (
        "zh-SG",
        include_str!("../../../../../res/i18n/locales/zh-SG/feedback.json"),
    ),
    (
        "zh-TW",
        include_str!("../../../../../res/i18n/locales/zh-TW/feedback.json"),
    ),
    (
        "ja-JP",
        include_str!("../../../../../res/i18n/locales/ja-JP/feedback.json"),
    ),
    (
        "ko-KR",
        include_str!("../../../../../res/i18n/locales/ko-KR/feedback.json"),
    ),
    (
        "ru-RU",
        include_str!("../../../../../res/i18n/locales/ru-RU/feedback.json"),
    ),
    (
        "fr-FR",
        include_str!("../../../../../res/i18n/locales/fr-FR/feedback.json"),
    ),
    (
        "es-ES",
        include_str!("../../../../../res/i18n/locales/es-ES/feedback.json"),
    ),
];

/// Merged `{"en-US": {...}, "zh-CN": {...}, ...}` JSON injected into the
/// page once per process. Embedded files are frozen at compile time and
/// validated by tests, so the parse cannot fail in a healthy build.
fn feedback_locales_json() -> &'static str {
    static MERGED: OnceLock<String> = OnceLock::new();
    MERGED.get_or_init(|| {
        let mut m = Map::new();
        for (lang, raw) in FEEDBACK_LOCALE_FILES {
            let v: Value = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("feedback locale {lang} is not valid JSON: {e}"));
            m.insert((*lang).to_string(), v);
        }
        Value::Object(m).to_string()
    })
}

/// The /feedback page's hikari design tokens — generated from the webui's
/// `@celestia-island/hikari` dependency by `scripts/export_feedback_theme.py`
/// (the channels + scale `:root` blocks plus the default preset's light/dark
/// palettes, i.e. the exact pair the app's `initTheme()` applies at runtime).
/// Checked in so the worker build needs no Node toolchain; CI re-runs the
/// exporter with `--check` so a hikari bump cannot drift silently.
const FEEDBACK_HIKARI_CSS: &str = include_str!("../../../../../res/theme/feedback-hikari.css");

/// Minimal HTML escaping for request-derived text (the User-Agent
/// inference) before it lands in the page template or an attribute.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Serialize a JSON value as a JS literal that cannot close its own
/// `<script>` block (serde escapes quotes but not `</`; a hostile
/// User-Agent must not be able to inject markup through the suggestion
/// table).
fn json_script_literal(v: &serde_json::Value) -> String {
    serde_json::to_string(v)
        .unwrap_or_else(|_| "null".into())
        .replace('<', "\\u003c")
}

/// The digits-and-dots run right after `marker`, if any (best-effort
/// version extraction from a lowercased User-Agent fragment).
fn version_after(hay: &str, marker: &str) -> Option<String> {
    let pos = hay.find(marker)? + marker.len();
    let tail = &hay[pos..];
    let end = tail
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(tail.len());
    let run = tail[..end].trim_end_matches('.');
    if run.is_empty() {
        None
    } else {
        Some(run.to_string())
    }
}

fn os_from_ua(l: &str) -> Option<String> {
    if l.contains("windows phone") {
        Some("Windows Phone".into())
    } else if l.contains("windows nt 10.") {
        // The UA string froze at NT 10.0 — it covers both Windows 10 and 11.
        Some("Windows 10/11".into())
    } else if l.contains("windows nt 6.1") {
        Some("Windows 7".into())
    } else if l.contains("windows nt 6.3") {
        Some("Windows 8.1".into())
    } else if l.contains("windows nt 6.2") {
        Some("Windows 8".into())
    } else if l.contains("windows") {
        Some("Windows".into())
    } else if l.contains("ipad") || l.contains("iphone") {
        // "CPU iPhone OS 17_4 like Mac OS X" → 17.4; the `like Mac OS X`
        // decoy never has digits right after "os ", so the scan is safe.
        let name = if l.contains("ipad") { "iPadOS" } else { "iOS" };
        let ver = l
            .match_indices("os ")
            .filter_map(|(i, _)| {
                let run: String = l[i + 3..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '_')
                    .collect();
                if run.is_empty() {
                    None
                } else {
                    Some(run.replace('_', "."))
                }
            })
            .next();
        Some(match ver {
            Some(v) => format!("{name} {v}"),
            None => name.to_string(),
        })
    } else if l.contains("mac os x") || l.contains("macintosh") {
        Some("macOS".into())
    } else if let Some(v) = version_after(l, "android ") {
        Some(format!("Android {v}"))
    } else if l.contains("android") {
        Some("Android".into())
    } else if l.contains("linux") || l.contains("x11") {
        Some("Linux".into())
    } else {
        None
    }
}

fn browser_from_ua(l: &str) -> Option<String> {
    let named = |label: &str, marker: &str| {
        version_after(l, marker).map(|v| {
            // Browser builds carry long dotted runs (126.0.0.0); the OS
            // side keeps its full run, browsers read better as major-only.
            let major = v.split('.').next().unwrap_or(&v);
            format!("{label} {major}")
        })
    };
    // Order matters: Edge/Opera/Samsung UAs all embed a Chrome/ token.
    if l.contains("edgios/") {
        named("Edge", "edgios/")
    } else if l.contains("edga/") {
        named("Edge", "edga/")
    } else if l.contains("edg/") {
        named("Edge", "edg/")
    } else if l.contains("opr/") {
        named("Opera", "opr/")
    } else if l.contains("samsungbrowser/") {
        named("Samsung Internet", "samsungbrowser/")
    } else if l.contains("fxios/") {
        named("Firefox", "fxios/")
    } else if l.contains("firefox/") {
        named("Firefox", "firefox/")
    } else if l.contains("crios/") {
        named("Chrome", "crios/")
    } else if l.contains("chrome/") {
        named("Chrome", "chrome/")
    } else if l.contains("safari/") {
        // Safari carries its real version in the `Version/` token; its
        // dotted run is short (17.4), so keep it whole.
        version_after(l, "version/")
            .map(|v| format!("Safari {v}"))
            .or_else(|| Some("Safari".into()))
    } else {
        None
    }
}

/// Derive a human "system info" string from a request's User-Agent so the
/// web form opens with a sensible default (the desktop app prefills its
/// own build identity via query params, which take precedence). Public so
/// the worker can pass it straight through; best-effort, unknown agents
/// collapse to "Web".
pub fn infer_sysinfo_from_ua(ua: &str) -> String {
    let l = ua.to_ascii_lowercase();
    match (os_from_ua(&l), browser_from_ua(&l)) {
        (Some(os), Some(b)) => format!("{os} · {b}"),
        (Some(os), None) => os,
        (None, Some(b)) => b,
        (None, None) => "Web".into(),
    }
}

/// The /feedback form. `sitekey: None` renders the maintenance notice
/// (deploy before the Turnstile widget exists / after pulling the key).
/// `latest_version` is the current release (empty → no version default),
/// `ua` the request's User-Agent, from which the web-form system-info
/// default is inferred server-side.
pub fn feedback_page(
    sitekey: Option<&str>,
    base_url: &str,
    latest_version: &str,
    ua: &str,
) -> String {
    let key = sitekey.filter(|k| valid_sitekey(k));
    let turnstile_head = match &key {
        Some(_) => r#"<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>"#.into(),
        None => String::new(),
    };
    let turnstile_widget = match &key {
        Some(k) => {
            format!(r#"<div class="cf-turnstile" data-sitekey="{k}" data-theme="auto"></div>"#)
        },
        None => r#"<p class="notice" data-i18n="maintenance"></p>"#.into(),
    };
    let submit_disabled = if key.is_some() { "" } else { " disabled" };
    let locales_json = feedback_locales_json();
    let hikari_css = FEEDBACK_HIKARI_CSS;
    // Web-form defaults: the current release for version, the server-side
    // UA inference for system info. Both ride as EDITABLE combobox
    // defaults — the desktop link's ?version/?sysinfo prefill overrides.
    let inferred = infer_sysinfo_from_ua(ua);
    let version_default = html_escape(latest_version);
    let sysinfo_default = html_escape(&inferred);
    let mut sys_suggest: Vec<String> = Vec::new();
    for candidate in [
        inferred.clone(),
        "Windows".to_string(),
        "macOS".to_string(),
        "Linux".to_string(),
        "Android".to_string(),
        "iOS".to_string(),
    ] {
        if !sys_suggest.contains(&candidate) {
            sys_suggest.push(candidate);
        }
    }
    let suggest = json_script_literal(&serde_json::json!({
        "version": if latest_version.is_empty() { Vec::<String>::new() } else { vec![latest_version.to_string()] },
        "sysinfo": sys_suggest,
    }));
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoWSP Feedback</title>
{turnstile_head}
<style>
{hikari_css}
</style>
<style>
/* Component rules speak hikari's token vocabulary only (mirroring
 * HkButton / HkInput / HkSelect+menu-item / HkSidebar+HkNavItem /
 * HkImagePreview+HkImageLightbox patterns from the library's own SCSS)
 * — no hand-rolled palette. */
* {{ box-sizing: border-box; }}
:root {{ color-scheme: light dark; }}
body {{ margin: 0; height: 100vh; height: 100dvh; display: flex;
  justify-content: center;
  padding: var(--space-16) var(--viewport-gutter);
  font-family: var(--font-sans); font-size: var(--text-md); line-height: 1.6;
  background: rgb(var(--color-background)); color: rgb(var(--color-text)); }}
main {{ width: 100%; max-width: 56rem; height: 100%; }}
.card {{ display: flex; align-items: stretch; height: 100%;
  background: color-mix(in srgb, rgb(var(--color-surface)) 70%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 12%, transparent);
  border-radius: var(--radius-md); box-shadow: 0 2px 16px rgb(0 0 0 / 8%);
  overflow: hidden; animation: card-in 0.45s var(--ease-out-expo) both; }}
@media (prefers-reduced-motion: reduce) {{ .card {{ animation: none; }} }}
@keyframes card-in {{
  from {{ opacity: 0; transform: translateY(-16px) scale(0.92); }}
  to {{ opacity: 1; transform: none; }}
}}
/* ── sidebar (HkSidebar panel + HkNavItem grammar) ──────────────────── */
.side {{ flex: none; width: 13rem; display: flex; flex-direction: column;
  padding: var(--space-16) var(--space-12) var(--space-12);
  background: rgb(var(--color-surface));
  border-inline-end: 1px solid var(--border-faint); }}
h1.brand {{ font-size: var(--text-lg); font-weight: 700; margin: 0;
  padding: var(--space-4) var(--space-6) var(--space-4) var(--space-8); }}
.side-nav {{ display: flex; flex-direction: column; gap: var(--space-4);
  margin-top: var(--space-12); }}
.nav-item {{ display: flex; align-items: center; gap: var(--space-8);
  width: 100%; min-height: 34px; padding: var(--space-6) var(--space-12);
  border: 1px solid transparent; border-radius: var(--radius-md);
  background: none; color: rgb(var(--color-muted)); font-family: inherit;
  font-size: var(--text-sm); font-weight: 500; line-height: 1.3;
  text-align: start; cursor: pointer; user-select: none;
  transition: background-color var(--duration-fast) ease, color var(--duration-fast) ease; }}
.nav-item svg {{ width: 16px; height: 16px; flex: none; }}
.nav-item span {{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.nav-item:hover:not([data-active]) {{
  background: color-mix(in srgb, rgb(var(--color-primary)) 10%, transparent);
  color: rgb(var(--color-text)); }}
.nav-item[data-active] {{
  background: color-mix(in srgb, rgb(var(--color-primary)) 15%, transparent);
  color: rgb(var(--color-primary)); font-weight: 600; }}
.nav-item:focus-visible {{ outline: 2px solid rgb(var(--color-primary)); outline-offset: -2px; }}
.side-foot {{ margin-top: auto; padding-top: var(--space-12); }}
/* ── dropdown trigger + menu (HkSelect trigger + popout + menu-item) ── */
.sel-btn {{ display: flex; align-items: center; gap: var(--space-8); width: 100%;
  padding: var(--space-4) var(--space-10);
  background: color-mix(in srgb, rgb(var(--color-surface)) 55%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 14%, transparent);
  border-radius: var(--radius-sm); color: rgb(var(--color-text));
  font: inherit; font-size: var(--text-xs); cursor: pointer;
  transition-property: background-color, border-color, box-shadow, filter;
  transition-duration: var(--duration-normal);
  transition-timing-function: var(--ease-standard); }}
.sel-btn:hover {{ border-color: var(--c-primary-strong); }}
.sel-btn:active {{ filter: brightness(0.95); }}
.sel-btn:focus-visible, .sel-btn[aria-expanded="true"] {{
  border-color: rgb(var(--color-focused-border)); box-shadow: var(--shadow-focus);
  background: rgb(var(--color-surface)); outline: none; }}
.sel-btn svg {{ flex: none; width: 14px; height: 14px; }}
.sel-btn .ic-globe {{ color: rgb(var(--color-muted)); }}
.sel-btn .ic-caret {{ margin-inline-start: auto; color: rgb(var(--color-muted));
  transition: transform var(--duration-normal) ease; }}
.sel-btn[aria-expanded="true"] .ic-caret {{ transform: rotate(180deg); }}
.sel-btn #langName {{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.hk-menu {{ position: fixed; z-index: 2000; min-width: 180px; width: max-content;
  max-width: calc(100vw - 2 * var(--viewport-gutter));
  max-height: max(240px, min(24rem, calc(100vh - 32px)));
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-8); border-radius: var(--radius-md); overflow-y: auto;
  background: color-mix(in srgb, rgb(var(--color-surface)) 55%, transparent);
  backdrop-filter: blur(var(--blur-md));
  border: 1px solid var(--border-subtle); box-shadow: var(--shadow-dropdown);
  transform-origin: top left; opacity: 0;
  transform: translateY(-4px) scale(0.97); }}
.hk-menu[data-align="end"] {{ transform-origin: top right; }}
.hk-menu.is-in {{ opacity: 1; transform: none;
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); }}
@media (prefers-reduced-motion: reduce) {{ .hk-menu {{ transition: none; }} }}
.hk-opt {{ display: flex; align-items: center; gap: var(--space-8);
  min-height: 34px; padding: var(--space-6) var(--space-12);
  border: 1px solid transparent; border-radius: var(--radius-md);
  background: transparent; color: rgb(var(--color-text) / 88%);
  font-family: inherit; font-size: var(--text-sm); font-weight: 500;
  line-height: 1.3; text-align: start; cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease; }}
.hk-opt:hover, .hk-opt.is-hover {{
  background: var(--c-primary-subtle); border-color: var(--c-primary-medium);
  color: rgb(var(--color-text)); }}
.hk-opt[aria-selected="true"] {{
  background: var(--c-primary-dim); border-color: var(--c-primary-strong);
  color: rgb(var(--color-primary)); font-weight: 600; }}
.hk-opt:focus-visible {{ outline: 2px solid rgb(var(--color-primary) / 70%); outline-offset: -2px; }}
.hk-opt .opt-note {{ margin-inline-start: auto; font-size: var(--text-2xs);
  color: rgb(var(--color-muted)); font-weight: 400; }}
/* ── views ───────────────────────────────────────────────────────────── */
.content-wrap {{ position: relative; flex: 1; min-width: 0; height: 100%;
  display: flex; }}
.content {{ flex: 1; min-width: 0; min-height: 0;
  padding: var(--space-24) var(--space-28) var(--space-24) var(--space-20);
  overflow-y: auto; overscroll-behavior: contain;
  /* Overlay scrollbar (hk-scrollbar grammar) — native chrome hidden; the
   * rail lives on .content-wrap, the non-scrolling viewport per hikari's
   * useOverlayScrollbar host contract. */
  scrollbar-width: none; }}
.content::-webkit-scrollbar {{ display: none; }}
.view[hidden] {{ display: none; }}
h2.view-title {{ font-size: var(--text-lg); font-weight: 600; margin: 0 0 var(--space-8); }}
p.sub {{ margin: 0 0 var(--space-20); color: rgb(var(--color-muted));
  font-size: var(--text-sm); }}
label {{ display: block; margin: var(--space-16) 0 var(--space-4); font-weight: 600;
  font-size: var(--text-xs); letter-spacing: 0.02em;
  color: rgb(var(--color-text) / 72%); }}
/* ── inputs (HkInput box grammar) ───────────────────────────────────── */
textarea, .field {{ width: 100%; padding: var(--space-8) var(--space-12);
  min-height: 2.5rem;
  background: color-mix(in srgb, rgb(var(--color-surface)) 55%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 14%, transparent);
  border-radius: var(--radius-sm); color: rgb(var(--color-text));
  font: inherit; font-size: var(--text-base); line-height: 1.5;
  transition-property: background-color, border-color, box-shadow;
  transition-duration: var(--duration-normal);
  transition-timing-function: var(--ease-standard); }}
textarea:hover:not(:disabled), .field:hover:not(:disabled) {{
  border-color: var(--c-primary-strong); }}
textarea:focus, .field:focus {{ border-color: rgb(var(--color-focused-border));
  box-shadow: var(--shadow-focus); background: rgb(var(--color-surface)); outline: none; }}
textarea {{ min-height: 120px; resize: vertical; }}
textarea::placeholder, input::placeholder {{ color: rgb(var(--color-muted)); opacity: .6; }}
/* ── contact row (HkInput affix chip, HkPhoneInput pattern) ─────────── */
.contact-box {{ display: flex; align-items: center; gap: var(--space-6);
  background: color-mix(in srgb, rgb(var(--color-surface)) 55%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 14%, transparent);
  border-radius: var(--radius-sm); padding: var(--space-4) var(--space-10) var(--space-4) var(--space-6);
  transition-property: background-color, border-color, box-shadow;
  transition-duration: var(--duration-normal);
  transition-timing-function: var(--ease-standard); }}
.contact-box:hover {{ border-color: var(--c-primary-strong); }}
.contact-box:focus-within {{ border-color: rgb(var(--color-focused-border));
  box-shadow: var(--shadow-focus); background: rgb(var(--color-surface)); }}
.affix-chip {{ display: inline-flex; align-items: center; gap: 0.3rem; flex: none;
  padding: 2px 6px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: rgb(var(--color-text)); cursor: pointer;
  font: inherit; font-weight: 600; font-size: var(--text-sm); white-space: nowrap;
  transition: background 0.12s ease; }}
.affix-chip:hover, .affix-chip:focus-visible {{ background: rgb(var(--color-primary) / 14%); }}
.affix-chip:focus-visible {{ outline: 2px solid rgb(var(--color-primary)); outline-offset: -2px; }}
.affix-chip svg {{ width: 12px; height: 12px; color: rgb(var(--color-muted));
  transition: transform var(--duration-normal) ease; }}
.affix-chip[aria-expanded="true"] svg {{ transform: rotate(180deg); }}
.contact-box input {{ flex: 1; min-width: 0; padding: var(--space-4) 0;
  background: transparent; border: none; outline: none;
  font: inherit; font-size: var(--text-base); color: rgb(var(--color-text)); }}
.contact-help {{ flex: none; display: inline-flex; align-items: center;
  justify-content: center; width: 1.25rem; height: 1.25rem; padding: 0;
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 14%, transparent);
  border-radius: var(--radius-full); background: transparent;
  color: rgb(var(--color-muted)); cursor: pointer; font: inherit;
  font-size: var(--text-2xs); font-weight: 600; line-height: 1; }}
.contact-help:hover {{ background: rgb(var(--color-primary) / 14%);
  color: rgb(var(--color-text)); }}
.contact-help:focus-visible {{ outline: 2px solid rgb(var(--color-primary));
  outline-offset: 1px; }}
.contact-help[hidden] {{ display: none; }}
/* ── 联系方式 ? 提示弹窗（HkModal overlay + 卡片语法） ──────────────── */
.fb-modal {{ position: fixed; inset: 0; z-index: 1000; display: flex;
  align-items: center; justify-content: center; }}
.fb-modal[hidden] {{ display: none; }}
.fb-modal .scrim {{ position: absolute; inset: 0; background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(3px); }}
.fb-modal .card {{ position: relative; width: min(92vw, 26rem);
  max-height: min(86vh, 40rem); overflow-y: auto;
  background: color-mix(in srgb, rgb(var(--color-surface)) 92%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-text)) 12%, transparent);
  border-radius: var(--radius-md); box-shadow: 0 16px 48px rgb(0 0 0 / 20%);
  padding: var(--space-20); animation: wiz-in 0.3s var(--ease-out-expo) both; }}
@keyframes wiz-in {{ from {{ opacity: 0; transform: translateY(5%) scale(.97); }}
  to {{ opacity: 1; transform: none; }} }}
@media (prefers-reduced-motion: reduce) {{ .fb-modal .card {{ animation: none; }} }}
.fb-modal h3 {{ margin: 0 0 var(--space-12); font-size: var(--text-md);
  font-weight: 600; }}
.fb-modal p {{ margin: 0 0 var(--space-10); font-size: var(--text-sm);
  line-height: 1.7; color: rgb(var(--color-text) / 85%); }}
.fb-modal .help-join {{ margin-bottom: var(--space-12); }}
.fb-modal .wiz-actions {{ display: flex; gap: var(--space-8); flex-wrap: wrap;
  margin-top: var(--space-16); }}
/* ── editable combobox (HkSearchInput shell + chevron) ──────────────── */
.combo {{ position: relative; }}
.combo .field {{ padding-inline-end: var(--space-32); }}
.combo-btn {{ position: absolute; inset-inline-end: var(--space-4); top: 50%;
  transform: translateY(-50%); display: inline-flex; align-items: center;
  justify-content: center; width: 1.5rem; height: 1.5rem; padding: 0;
  border: none; border-radius: var(--radius-sm); background: transparent;
  color: rgb(var(--color-muted)); cursor: pointer; }}
.combo-btn:hover {{ background: rgb(var(--color-primary) / 14%); color: rgb(var(--color-text)); }}
.combo-btn:focus-visible {{ outline: 2px solid rgb(var(--color-primary) / 70%);
  outline-offset: -2px; }}
.combo-btn svg {{ width: 14px; height: 14px;
  transition: transform var(--duration-normal) ease; }}
.combo-btn[aria-expanded="true"] svg {{ transform: rotate(180deg); }}
/* ── buttons (HkButton grammar, opt-in via .btn) ────────────────────── */
.btn {{ display: inline-flex; align-items: center; justify-content: center;
  gap: var(--space-6); font-family: inherit; font-weight: 600; line-height: 1;
  font-size: var(--text-sm); padding: var(--space-6) var(--space-12); min-height: 1.75rem;
  border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer;
  background: rgb(var(--color-primary)); color: rgb(var(--color-on-solid));
  white-space: nowrap; user-select: none; outline: none;
  transition-property: background-color, border-color, color, box-shadow, opacity, transform, filter;
  transition-duration: var(--duration-normal);
  transition-timing-function: var(--ease-standard); }}
.btn:hover:not(:disabled):not(:focus-visible) {{ filter: brightness(1.1);
  box-shadow: var(--shadow-button); }}
.btn:active:not(:disabled) {{ filter: brightness(0.95); }}
.btn:focus-visible {{ box-shadow: 0 0 0 2px rgb(var(--color-surface)),
  0 0 0 4px rgb(var(--color-primary)); }}
.btn:disabled {{ opacity: .5; cursor: not-allowed; }}
.btn.second {{ background: rgb(var(--color-surface)); color: rgb(var(--color-text));
  border-color: rgb(var(--color-border) / 20%); }}
.btn.second:hover:not(:disabled):not(:focus-visible) {{ border-color: var(--c-primary-strong);
  filter: none; box-shadow: none; }}
.btn.danger {{ background: rgb(var(--color-error)); color: rgb(var(--color-on-solid)); }}
.btn.danger:hover:not(:disabled):not(:focus-visible) {{ box-shadow: var(--shadow-button-danger); }}
.btn.ghost {{ background: transparent; color: rgb(var(--color-text));
  border-color: transparent; }}
.btn.ghost:hover:not(:disabled):not(:focus-visible) {{ background: var(--c-primary-light);
  filter: none; box-shadow: none; }}
#submit {{ width: 100%; margin-top: var(--space-4); padding: var(--space-8) var(--space-16);
  min-height: 2.5rem; font-size: var(--text-base); }}
.filepick-row {{ margin-top: 2px; }}
.cf-turnstile {{ margin: var(--space-16) 0 var(--space-10); }}
.notice {{ padding: var(--space-12); border-radius: 6px; font-size: var(--text-sm);
  color: rgb(var(--color-warning));
  background: color-mix(in srgb, rgb(var(--color-warning)) 10%, transparent);
  border: 1px solid color-mix(in srgb, rgb(var(--color-warning)) 20%, transparent); }}
#msg {{ margin-top: var(--space-12); white-space: pre-wrap; font-size: var(--text-sm); }}
#msg.ok {{ color: rgb(var(--color-success)); }} #msg.err {{ color: rgb(var(--color-error)); }}
a {{ color: rgb(var(--color-primary)); }}
.media-row {{ display: flex; gap: var(--space-8); margin-top: var(--space-10);
  flex-wrap: wrap; align-items: center; }}
#recState {{ font-weight: 600; color: rgb(var(--color-error)); font-size: var(--text-sm); }}
/* ── attachment thumbnail (HkImagePreview tile) ─────────────────────── */
#attachInfo {{ margin-top: var(--space-8); display: none; gap: var(--space-10);
  align-items: flex-start; }}
#attachInfo.is-on {{ display: flex; }}
.attach-col {{ flex: 1; min-width: 0; display: flex; flex-direction: column;
  gap: var(--space-6); align-items: flex-start; }}
#attachText {{ font-size: var(--text-sm); color: rgb(var(--color-muted));
  word-break: break-all; }}
#attachInfo .btn {{ padding: 2px var(--space-8); font-size: var(--text-2xs); min-height: 0; }}
.attach-thumb {{ position: relative; flex: none; width: 5rem; height: 5rem;
  overflow: hidden; padding: 0;
  background: color-mix(in srgb, rgb(var(--color-surface)) 55%, transparent);
  border: 1px solid var(--border-faint); border-radius: var(--radius-md);
  cursor: zoom-in;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease; }}
.attach-thumb:hover {{ border-color: rgb(var(--color-primary));
  box-shadow: inset 0 0 0 1px rgb(var(--color-primary)); }}
.attach-thumb:active {{ filter: brightness(0.95); }}
.attach-thumb:focus-visible {{ outline: 2px solid rgb(var(--color-primary));
  outline-offset: 2px; }}
.attach-thumb img, .attach-thumb video {{ position: absolute; inset: 0;
  width: 100%; height: 100%; object-fit: cover; }}
.attach-thumb .ext {{ position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-size: var(--text-2xs); font-weight: 600;
  letter-spacing: 0.05em; color: rgb(var(--color-muted)); }}
.attach-thumb .play {{ position: absolute; right: 4px; bottom: 4px;
  width: 1.25rem; height: 1.25rem; display: flex; align-items: center;
  justify-content: center; border-radius: var(--radius-full);
  background: rgb(0 0 0 / 55%); color: #fff; }}
.attach-thumb .play svg {{ width: 10px; height: 10px; }}
.privacy {{ margin-top: var(--space-20); padding: var(--space-12) var(--space-16);
  border-radius: var(--radius-md); font-size: var(--text-xs); line-height: 1.7;
  color: rgb(var(--color-muted)); background: rgb(var(--color-surface) / 55%);
  border: 1px solid rgb(var(--color-border) / 15%); }}
/* ── history view ────────────────────────────────────────────────────── */
.hist-row {{ display: flex; gap: var(--space-8); margin: var(--space-12) 0; flex-wrap: wrap; }}
.hist-row input {{ flex: 1; min-width: 200px; }}
@media (max-width: 480px) {{
  .hist-row input, .hist-row .btn {{ width: 100%; flex: 1 1 100%; }}
}}
.hist-count {{ margin: var(--space-12) 0 var(--space-8); color: rgb(var(--color-muted));
  font-size: var(--text-xs); }}
.hist-item {{ padding: var(--space-12); margin-bottom: var(--space-8); font-size: var(--text-sm);
  background: color-mix(in srgb, rgb(var(--color-surface)) 55%, transparent);
  border: 1px solid rgb(var(--color-border) / 15%); border-radius: var(--radius-md); }}
.hist-meta {{ display: flex; align-items: center; gap: var(--space-8); flex-wrap: wrap;
  margin-bottom: var(--space-4); }}
.hist-item .muted {{ color: rgb(var(--color-muted)); font-size: var(--text-xs); }}
.badge {{ display: inline-flex; align-items: center; font-size: var(--text-2xs);
  font-weight: 500; line-height: 1.4; border-radius: var(--radius-sm);
  padding: 2px var(--space-8); border: 1px solid transparent;
  background: color-mix(in srgb, rgb(var(--color-primary)) 10%, transparent);
  color: rgb(var(--color-primary));
  border-color: color-mix(in srgb, rgb(var(--color-primary)) 20%, transparent); }}
.badge.s2 {{ background: color-mix(in srgb, rgb(var(--color-success)) 10%, transparent);
  color: rgb(var(--color-success));
  border-color: color-mix(in srgb, rgb(var(--color-success)) 20%, transparent); }}
/* ── lightbox (HkModal overlay + HkImageLightbox stage) ─────────────── */
.lb {{ position: fixed; inset: 0; z-index: 1000; display: flex;
  align-items: center; justify-content: center; }}
.lb[hidden] {{ display: none; }}
.lb-scrim {{ position: absolute; inset: 0; background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(3px); }}
.lb-stage {{ position: relative; width: min(96vw, 80rem); height: min(90vh, 56rem);
  padding: var(--space-12); display: flex;
  animation: lb-in 0.42s cubic-bezier(0.33, 1, 0.68, 1) both; }}
.lb-canvas {{ flex: 1; min-width: 0; display: flex; align-items: center;
  justify-content: center; background: rgb(0 0 0 / 45%);
  border-radius: var(--radius-md); overflow: hidden; }}
.lb-canvas img {{ max-width: 100%; max-height: 100%; object-fit: contain; }}
.lb-canvas video {{ max-width: 100%; max-height: 100%; width: auto; height: auto;
  background: #000; }}
.lb-close {{ position: absolute; top: var(--space-12); right: var(--space-12); z-index: 2;
  width: 2rem; height: 2rem; display: inline-flex; align-items: center;
  justify-content: center; padding: 0; border: none; border-radius: var(--radius-full);
  background: rgb(0 0 0 / 45%); color: rgb(255 255 255 / 92%); cursor: pointer;
  backdrop-filter: blur(6px); }}
.lb-close:hover, .lb-close:focus-visible {{ background: rgb(0 0 0 / 65%); color: #fff; }}
.lb-close:focus-visible {{ outline: 2px solid rgb(255 255 255 / 80%); outline-offset: -2px; }}
.lb-close svg {{ width: 16px; height: 16px; }}
@keyframes lb-in {{ from {{ opacity: 0; transform: translateY(5%); }}
  to {{ opacity: 1; transform: none; }} }}
@media (prefers-reduced-motion: reduce) {{ .lb-stage {{ animation: none; }} }}
/* ── overlay scrollbar (hikari .hk-scrollbar-track/thumb grammar) ───── */
.hk-scrollbar-track {{ position: absolute; z-index: 10; background: transparent;
  top: 4px; bottom: 4px; right: 2px; width: 6px;
  pointer-events: none; opacity: 0;
  transition: opacity var(--hi-duration-fast, 0.15s) ease; }}
.hk-scrollbar-track.is-scrolling, .hk-scrollbar-track.is-hovering {{
  opacity: 1; pointer-events: auto; }}
.hk-scrollbar-thumb {{ position: absolute; top: 0; left: 0; width: 100%;
  min-height: 20px; border-radius: 3px;
  background: color-mix(in srgb, rgb(var(--color-muted)) 35%, transparent);
  transition: background var(--hi-duration-fast, 0.15s) ease; }}
.hk-scrollbar-track.is-hovering .hk-scrollbar-thumb,
.hk-scrollbar-thumb.is-dragging {{
  background: color-mix(in srgb, rgb(var(--color-muted)) 55%, transparent); }}
/* ── responsive: sidebar becomes a tab strip under 768px ────────────── */
@media (max-width: 767px) {{
  .card {{ flex-direction: column; }}
  .side {{ width: 100%; border-inline-end: none;
    border-bottom: 1px solid var(--border-faint);
    padding: var(--space-12) var(--space-12) var(--space-8); }}
  h1.brand {{ padding-left: var(--space-6); }}
  .side-nav {{ flex-direction: row; gap: var(--space-4); margin-top: var(--space-8); }}
  .nav-item {{ flex: 1; justify-content: center; }}
  .nav-item span {{ overflow: visible; }}
  .side-foot {{ margin-top: var(--space-8); padding-top: 0; }}
  .content-wrap {{ flex: 1; min-height: 0; }}
  .content {{ padding: var(--space-16); }}
  .lb-stage {{ width: 100%; height: 100vh; height: 100dvh; padding: var(--space-8); }}
  .lb-canvas {{ border-radius: 0; }}
  .lb-close {{ top: calc(var(--space-8) + env(safe-area-inset-top, 0px));
    right: calc(var(--space-8) + env(safe-area-inset-right, 0px)); }}
}}
</style>
</head>
<body>
<main>
<div class="card">
<aside class="side">
  <h1 class="brand">WoWSP Feedback</h1>
  <nav class="side-nav">
    <button type="button" class="nav-item" id="navForm" data-active><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/><path d="M12 6v8"/></svg>
      <span data-i18n="navFeedback"></span>
    </button>
    <button type="button" class="nav-item" id="navHistory"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
      <span data-i18n="navHistory"></span>
    </button>
  </nav>
  <div class="side-foot">
    <button type="button" id="langSel" class="sel-btn" aria-haspopup="listbox"
      aria-expanded="false" data-i18n-aria="langLabel"><svg class="ic-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
      <span id="langName"></span><svg class="ic-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
  </div>
</aside>
<div class="content-wrap">
<div class="content">
<section class="view" id="viewForm">
  <p class="sub" data-i18n="subtitle"></p>
  <form id="f" action="{base_url}/api/feedback/submit" method="post" enctype="multipart/form-data">
    <label for="description" data-i18n="descLabel"></label>
    <textarea id="description" name="description" maxlength="5000" required></textarea>
    <label for="contact" data-i18n="contactLabel"></label>
    <div class="contact-box">
      <button type="button" id="contactType" class="affix-chip" aria-haspopup="listbox"
        aria-expanded="false"><span id="ctLabel"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <input type="text" id="contact" name="contact" maxlength="64">
      <button type="button" id="qqHelp" class="contact-help" hidden
        aria-label="?" data-i18n-aria="qqHelpTitle">?</button>
    </div>
    <label for="gameId" data-i18n="serverGameLabel"></label>
    <div class="contact-box">
      <button type="button" id="serverChip" class="affix-chip" aria-haspopup="listbox"
        aria-expanded="false"><span id="serverLabel"></span><svg class="ic-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <input type="text" id="gameId" name="game_id" maxlength="32" data-i18n-placeholder="gameIdPh">
    </div>
    <input type="hidden" name="server" id="serverField">
    <label for="version" data-i18n="versionLabel"></label>
    <div class="combo">
      <input type="text" id="version" name="version" class="field" value="{version_default}">
      <button type="button" class="combo-btn" id="verBtn" aria-haspopup="listbox"
        aria-expanded="false" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>
    <label for="sysinfo" data-i18n="sysLabel"></label>
    <div class="combo">
      <input type="text" id="sysinfo" name="sysinfo" class="field" value="{sysinfo_default}">
      <button type="button" class="combo-btn" id="sysBtn" aria-haspopup="listbox"
        aria-expanded="false" tabindex="-1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>
    <input type="hidden" name="channel" value="web">
    <input type="hidden" name="anon" id="anon">
    <label for="file" data-i18n="fileLabel"></label>
    <input type="file" id="file" name="file" hidden accept=".zip,.log,.txt,.gz,.png,.jpg,.jpeg,.gif,.webp,.bmp,.webm,.mp4,.mov">
    <div class="filepick-row">
      <button type="button" class="btn second" id="filePick" data-i18n="filePick"></button>
    </div>
    <div class="media-row">
      <button type="button" class="btn second" id="shot" data-i18n="shotBtn"></button>
      <button type="button" class="btn second" id="rec" data-i18n="recBtn"></button>
      <button type="button" class="btn danger" id="recStop" style="display:none" data-i18n="recStopBtn"></button>
      <span id="recState"></span>
    </div>
    <div id="attachInfo">
      <button type="button" class="attach-thumb" id="attachThumb" hidden
        data-i18n-aria="previewOpen"></button>
      <div class="attach-col">
        <span id="attachText"></span>
        <button type="button" class="btn ghost" id="attachClear" data-i18n="attachClear"></button>
      </div>
    </div>
    {turnstile_widget}
    <button type="submit" class="btn" id="submit"{submit_disabled} data-i18n="submit"></button>
    <p id="msg" role="status"></p>
  </form>
  <section class="privacy" data-i18n="privacy"></section>
</section>
<section class="view" id="viewHistory" hidden>
  <h2 class="view-title" data-i18n="historyTitle"></h2>
  <div class="hist-row">
    <input type="text" id="histContact" class="field" data-i18n-placeholder="historyContact">
    <button type="button" class="btn" id="histGo" data-i18n="historyGo"></button>
  </div>
  <div id="histResult"></div>
</section>
</div>
</div>
</main>
<div id="qqHelpModal" class="fb-modal" hidden role="dialog" aria-modal="true">
  <div class="scrim"></div>
  <div class="card">
    <h3 data-i18n="qqHelpTitle"></h3>
    <p data-i18n="qqHelpGroup"></p>
    <p class="help-join"><a id="helpJoin" target="_blank" rel="noreferrer"
      data-i18n="qqHelpJoin"></a></p>
    <p data-i18n="qqHelpFollow"></p>
    <div class="wiz-actions">
      <button type="button" class="btn" id="helpDone" data-i18n="qqHelpDone"></button>
    </div>
  </div>
</div>
<div id="lightbox" class="lb" hidden>
  <div class="lb-scrim" id="lbScrim"></div>
  <div class="lb-stage">
    <div class="lb-canvas" id="lbCanvas"></div>
    <button type="button" class="lb-close" id="lbClose" data-i18n-aria="previewClose"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
  </div>
</div>
<script>
(function () {{
  // ── theme mode — mirrors hikari useTheme's data-mode attribute, fed by
  // the OS scheme so the token sheet's [data-mode="dark"] block tracks the
  // system preference exactly like the app's solar mode would ───────────
  var modeQuery = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  function applyMode() {{
    document.documentElement.setAttribute("data-mode",
      modeQuery && modeQuery.matches ? "dark" : "light");
  }}
  applyMode();
  if (modeQuery && modeQuery.addEventListener) {{
    modeQuery.addEventListener("change", applyMode);
  }}

  // ── overlay scrollbar — mirrors hikari useOverlayScrollbar over the
  // .content region: a 6px rail with a proportional thumb that appears
  // while scrolling or hovering, draggable, native bar hidden in CSS ────
  (function () {{
    var el = document.querySelector(".content");
    if (!el) return;
    // hikari's host contract: the rail's parent must be the NON-scrolling
    // viewport wrapper, so the rail never translates with the content.
    var host = el.parentElement;
    var track = document.createElement("div");
    track.className = "hk-scrollbar-track";
    var thumb = document.createElement("div");
    thumb.className = "hk-scrollbar-thumb";
    track.appendChild(thumb);
    host.appendChild(track);
    var hoverTimer = null;
    function sync() {{
      var max = el.scrollHeight - el.clientHeight;
      if (max <= 0) {{ thumb.style.height = "0"; return; }}
      // Thumb geometry lives in TRACK coordinates (the track already
      // carries the 4px insets), so size and travel read off the track —
      // mirroring hikari's useOverlayScrollbar engine.
      var railH = track.clientHeight;
      var h = Math.max(20, (el.clientHeight / el.scrollHeight) * railH);
      var y = (el.scrollTop / max) * (railH - h);
      thumb.style.height = h + "px";
      thumb.style.transform = "translateY(" + y + "px)";
    }}
    function show(cls, on) {{ track.classList.toggle(cls, on); }}
    el.addEventListener("scroll", function () {{
      sync(); show("is-scrolling", true);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {{
        show("is-scrolling", false);
      }}, 600);
    }}, {{ passive: true }});
    el.addEventListener("mouseenter", function () {{ show("is-hovering", true); sync(); }});
    el.addEventListener("mouseleave", function () {{
      show("is-hovering", false);
    }});
    // Drag the thumb to scrub.
    var dragging = false, dragY = 0, startTop = 0;
    thumb.addEventListener("pointerdown", function (ev) {{
      dragging = true; dragY = ev.clientY; startTop = el.scrollTop;
      thumb.classList.add("is-dragging");
      thumb.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }});
    thumb.addEventListener("pointermove", function (ev) {{
      if (!dragging) return;
      var max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      // track.clientHeight already excludes the 4px top/bottom insets —
      // same numbers the render path uses.
      var railH = track.clientHeight;
      var th = thumb.getBoundingClientRect().height;
      var dy = ev.clientY - dragY;
      el.scrollTop = startTop + (dy / Math.max(1, railH - th)) * max;
    }});
    function endDrag(ev) {{
      if (!dragging) return;
      dragging = false;
      thumb.classList.remove("is-dragging");
      if (thumb.hasPointerCapture && thumb.hasPointerCapture(ev.pointerId)) {{
        thumb.releasePointerCapture(ev.pointerId);
      }}
    }}
    thumb.addEventListener("pointerup", endDrag);
    thumb.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", sync);
    sync();
  }})();

  // ── i18n runtime — same 9-locale table the app ships ─────────────────
  var LOCALES = {locales_json};
  // Editable-combobox suggestions: the current release + the
  // server-side UA inference first, then the plain OS families.
  var SUGGEST = {suggest};
  var ORDER = ["en-US", "zh-CN", "zh-SG", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "fr-FR", "es-ES"];
  var NAMES = {{
    "en-US": "English", "zh-CN": "简体中文", "zh-SG": "简体中文（亚服）",
    "zh-TW": "繁體中文", "ja-JP": "日本語", "ko-KR": "한국어",
    "ru-RU": "Русский", "fr-FR": "Français", "es-ES": "Español"
  }};
  var FALLBACK = "en-US";
  var q = new URLSearchParams(location.search);
  function pickLang() {{
    var wanted = (q.get("lang") || "").toLowerCase();
    for (var i = 0; i < ORDER.length; i++) if (ORDER[i].toLowerCase() === wanted) return ORDER[i];
    var saved = localStorage.getItem("wowsp-fb-lang");
    if (saved && ORDER.indexOf(saved) >= 0) return saved;
    var navs = [].concat(navigator.languages || [], navigator.language || []);
    for (var j = 0; j < navs.length; j++) {{
      var n = String(navs[j] || "").toLowerCase();
      if (!n) continue;
      for (var i = 0; i < ORDER.length; i++) if (ORDER[i].toLowerCase() === n) return ORDER[i];
      var base = n.split("-")[0];
      if (base === "zh") {{
        if (n.indexOf("hant") >= 0 || n === "zh-tw" || n === "zh-hk" || n === "zh-mo") return "zh-TW";
        if (n === "zh-sg") return "zh-SG";
        return "zh-CN";
      }}
      var pref = {{ en: "en-US", ja: "ja-JP", ko: "ko-KR", ru: "ru-RU", fr: "fr-FR", es: "es-ES" }}[base];
      if (pref) return pref;
    }}
    return FALLBACK;
  }}
  var lang = pickLang();
  function t(k) {{
    var d = LOCALES[lang] || {{}}, f = LOCALES[FALLBACK] || {{}};
    return d[k] || f[k] || "";
  }}
  function applyI18n() {{
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {{
      var v = t(el.getAttribute("data-i18n"));
      if (v) el.textContent = v;
    }});
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {{
      var v = t(el.getAttribute("data-i18n-placeholder"));
      if (v) el.placeholder = v;
    }});
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {{
      var v = t(el.getAttribute("data-i18n-aria"));
      if (v) el.setAttribute("aria-label", v);
    }});
    var ln = document.getElementById("langName");
    if (ln) ln.textContent = NAMES[lang] || lang;
    updateContactPh();
    applyServer();
  }}
  // ── dropdown menu (hikari HkSelect popout + menu-item grammar) ──────
  // One factory serves the language selector, the contact-type chip and
  // both editable comboboxes. The anchor keeps keyboard focus; rows are
  // mouse-driven plus arrow/Enter traversal, mirroring HkSelect's model.
  function makeMenu(anchor, getItems, onPick, opts) {{
    var menu = null, rows = [], hov = -1;
    function setHov(i) {{
      if (!rows.length) return;
      if (hov >= 0 && rows[hov]) rows[hov].classList.remove("is-hover");
      hov = ((i % rows.length) + rows.length) % rows.length;
      rows[hov].classList.add("is-hover");
      rows[hov].scrollIntoView({{ block: "nearest" }});
    }}
    function close(focusBack) {{
      if (menu) {{ menu.remove(); menu = null; }}
      rows = []; hov = -1;
      anchor.setAttribute("aria-expanded", "false");
      if (focusBack) anchor.focus();
    }}
    function pick(i) {{
      var items = getItems();
      close(true);
      if (items[i]) onPick(items[i]);
    }}
    function render() {{
      var items = getItems();
      menu.textContent = "";
      rows = items.map(function (it, i) {{
        var b = document.createElement("button");
        b.type = "button"; b.className = "hk-opt"; b.setAttribute("role", "option");
        b.setAttribute("aria-selected", String(!!it.selected));
        b.textContent = it.label;
        if (it.note) {{
          var n = document.createElement("span");
          n.className = "opt-note"; n.textContent = it.note;
          b.appendChild(n);
        }}
        b.addEventListener("click", function () {{ pick(i); }});
        b.addEventListener("mouseenter", function () {{ setHov(i); }});
        menu.appendChild(b);
        return b;
      }});
      if (!rows.length) {{
        var e = document.createElement("div");
        e.className = "hk-opt"; e.style.cursor = "default";
        e.setAttribute("role", "option"); e.setAttribute("aria-disabled", "true");
        e.textContent = "\u2014";
        menu.appendChild(e);
      }}
      var sel = items.findIndex(function (it) {{ return it.selected; }});
      if (sel >= 0) setHov(sel);
    }}
    function open() {{
      if (menu) return;
      menu = document.createElement("div");
      menu.className = "hk-menu"; menu.setAttribute("role", "listbox");
      document.body.appendChild(menu);
      render();
      var r = anchor.getBoundingClientRect();
      var mw = menu.offsetWidth, mh = menu.offsetHeight;
      var left = opts && opts.alignEnd ? r.right - mw : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
      var top = r.bottom + 4;
      if (top + mh > window.innerHeight - 8 && r.top - mh - 4 > 8) {{
        top = r.top - mh - 4;
        menu.setAttribute("data-side", "top");
      }}
      menu.style.left = left + "px"; menu.style.top = top + "px";
      if (opts && opts.alignEnd) menu.setAttribute("data-align", "end");
      anchor.setAttribute("aria-expanded", "true");
      requestAnimationFrame(function () {{ if (menu) menu.classList.add("is-in"); }});
    }}
    function toggle() {{ menu ? close(true) : open(); }}
    anchor.addEventListener("click", toggle);
    anchor.addEventListener("keydown", function (ev) {{
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {{
        ev.preventDefault(); toggle();
      }} else if (ev.key === "ArrowDown") {{
        ev.preventDefault(); if (!menu) open(); else setHov(hov + 1);
      }} else if (ev.key === "ArrowUp") {{
        ev.preventDefault(); if (!menu) open(); else setHov(hov - 1);
      }} else if (ev.key === "Escape") {{
        if (menu) {{ ev.stopPropagation(); close(true); }}
      }}
    }});
    document.addEventListener("pointerdown", function (ev) {{
      if (menu && !menu.contains(ev.target) && ev.target !== anchor
        && !anchor.contains(ev.target)) close(false);
    }}, true);
    return {{
      toggle: toggle, open: open,
      close: function () {{ close(false); }},
      isOpen: function () {{ return !!menu; }},
      refresh: function () {{ if (menu) render(); }},
      move: function (d) {{ if (menu) setHov(hov + d); }},
      pickHover: function () {{ if (menu && hov >= 0) pick(hov); }}
    }};
  }}

  var langSel = document.getElementById("langSel");
  makeMenu(langSel, function () {{
    return ORDER.map(function (code) {{
      return {{ value: code, label: NAMES[code] || code, selected: code === lang }};
    }});
  }}, function (it) {{
    lang = it.value;
    localStorage.setItem("wowsp-fb-lang", lang);
    applyI18n();
  }}, {{ alignEnd: true }});
  applyI18n();
  ["version", "sysinfo"].forEach(function (k) {{
    if (q.get(k)) document.getElementById(k).value = q.get(k);
  }});
  function wireCombo(id, btnId, all, noteFor) {{
    var input = document.getElementById(id);
    var btn = document.getElementById(btnId);
    var menu = makeMenu(btn, function () {{
      var query = input.value.trim().toLowerCase();
      return all.filter(function (v) {{
        return !query || String(v).toLowerCase().indexOf(query) >= 0;
      }}).map(function (v) {{
        return {{ value: v, label: v, selected: v === input.value,
          note: noteFor ? noteFor(v) : "" }};
      }});
    }}, function (it) {{ input.value = it.value; }});
    input.addEventListener("focus", function () {{ if (all.length) menu.open(); }});
    input.addEventListener("input", function () {{ menu.refresh(); }});
    input.addEventListener("blur", function () {{
      setTimeout(function () {{ menu.close(); }}, 120);
    }});
    input.addEventListener("keydown", function (ev) {{
      if (ev.key === "Enter" && menu.isOpen()) {{ ev.preventDefault(); menu.pickHover(); }}
      else if (ev.key === "Escape" && menu.isOpen()) menu.close();
      else if (ev.key === "ArrowDown") {{ ev.preventDefault(); menu.move(1); }}
      else if (ev.key === "ArrowUp") {{ ev.preventDefault(); menu.move(-1); }}
    }});
  }}
  wireCombo("version", "verBtn", SUGGEST.version || [], function (v) {{
    return v === (SUGGEST.version || [])[0] ? t("versionLatest") : "";
  }});
  wireCombo("sysinfo", "sysBtn", SUGGEST.sysinfo || [], null);
  if (q.get("channel")) document.querySelector('[name="channel"]').value = q.get("channel");
  // form.reset() reverts to the server-rendered defaults — capture the
  // live values (query prefills included) once and reapply after submit.
  var pre = {{
    version: document.getElementById("version").value,
    sysinfo: document.getElementById("sysinfo").value,
    channel: document.querySelector('[name="channel"]').value
  }};

  var anon = localStorage.getItem("wowsp_fb_anon");
  if (!anon) {{
    anon = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "").slice(0, 24);
    localStorage.setItem("wowsp_fb_anon", anon);
  }}
  document.getElementById("anon").value = anon;
  var contact = document.getElementById("contact");
  contact.value = localStorage.getItem("wowsp_fb_contact") || "";
  contact.addEventListener("change", function () {{ localStorage.setItem("wowsp_fb_contact", contact.value); }});
  // ── contact category chip (hikari HkInput affix-picker pattern) ──────
  var ct = localStorage.getItem("wowsp_fb_contact_type")
    || (contact.value.indexOf("@") >= 0 ? "email"
      : /^\d+$/.test(contact.value) ? "qq" : "qq");
  var ctChip = document.getElementById("contactType");
  var ctLabel = document.getElementById("ctLabel");
  function updateContactPh() {{
    if (!contact) return;
    var type = ct || "qq";
    contact.placeholder = t(type === "email" ? "contactPhEmail" : "contactPhQQ");
  }}
  function setCt(type, save) {{
    ct = type;
    ctLabel.textContent = t(type === "email" ? "contactTypeEmail" : "contactTypeQQ");
    if (save) localStorage.setItem("wowsp_fb_contact_type", type);
    updateContactPh();
  }}
  makeMenu(ctChip, function () {{
    return [
      {{ value: "qq", label: t("contactTypeQQ"), selected: ct === "qq" }},
      {{ value: "email", label: t("contactTypeEmail"), selected: ct === "email" }}
    ];
  }}, function (it) {{ setCt(it.value, true); }});
  setCt(ct, false);
  // ── main server chip + game id (hikari realm vocabulary) ─────────────
  var REALMS = ["ru", "eu", "na", "asia", "cn"];
  var serverChip = document.getElementById("serverChip");
  var serverLabel = document.getElementById("serverLabel");
  var serverField = document.getElementById("serverField");
  var gameId = document.getElementById("gameId");
  var server = localStorage.getItem("wowsp-fb-server") || "";
  if (q.get("server") && REALMS.indexOf(q.get("server")) >= 0) server = q.get("server");
  if (q.get("game_id")) gameId.value = q.get("game_id");
  function serverName(code) {{
    var key = "server" + code.toUpperCase();
    return t(key) || code.toUpperCase();
  }}
  function applyServer() {{
    // Called from applyI18n too, which fires before this block initializes
    // its elements — skip until then.
    if (!serverLabel) return;
    serverLabel.textContent = server ? serverName(server) : t("serverNone");
    serverField.value = server;
  }}
  makeMenu(serverChip, function () {{
    return [
      {{ value: "", label: t("serverNone"), selected: server === "" }}
    ].concat(REALMS.map(function (r) {{
      return {{ value: r, label: serverName(r), selected: server === r }};
    }}));
  }}, function (it) {{
    server = it.value;
    if (server) localStorage.setItem("wowsp-fb-server", server);
    else localStorage.removeItem("wowsp-fb-server");
    applyServer();
  }});
  applyServer();
  if (!q.get("game_id")) {{
    gameId.value = localStorage.getItem("wowsp-fb-gameid") || gameId.value;
  }}
  gameId.addEventListener("change", function () {{
    if (gameId.value) localStorage.setItem("wowsp-fb-gameid", gameId.value);
    else localStorage.removeItem("wowsp-fb-gameid");
  }});
  // ── 联系方式 ? 提示：建议加群，管理员可私聊跟进 ────────────────────
  var qqHelp = document.getElementById("qqHelp");
  var helpModal = document.getElementById("qqHelpModal");
  var helpJoin = document.getElementById("helpJoin");
  function setCtHelpVis() {{
    qqHelp.hidden = ct !== "qq";
  }}
  qqHelp.addEventListener("click", function () {{
    helpJoin.href = t("qqHelpJoinUrl");
    helpModal.hidden = false;
  }});
  helpModal.querySelector(".scrim").addEventListener("click", function () {{ helpModal.hidden = true; }});
  document.getElementById("helpDone").addEventListener("click", function () {{ helpModal.hidden = true; }});
  window.addEventListener("keydown", function (ev) {{
    if (ev.key === "Escape" && !helpModal.hidden) helpModal.hidden = true;
  }});
  var oldSetCt = setCt;
  setCt = function (type, save) {{ oldSetCt(type, save); setCtHelpVis(); }};
  setCtHelpVis();
  // Unambiguous input flips the category for you; anything else keeps
  // the explicit choice.
  contact.addEventListener("input", function () {{
    var v = contact.value;
    if (v.indexOf("@") >= 0 && ct !== "email") setCt("email", false);
    else if (v && /^\d+$/.test(v) && ct !== "qq") setCt("qq", false);
  }});

  // ── attachments: media capture replaces the file-input pick ──────────
  var media = {{ blob: null, name: null, kind: null }};
  var fileInput = document.getElementById("file");
  var attachInfo = document.getElementById("attachInfo");
  var attachThumb = document.getElementById("attachThumb");
  // ── thumbnail tile + fullscreen lightbox (hikari HkImagePreview →
  // HkImageLightbox flow, mirrored in vanilla) ──────────────────────────
  var thumbUrl = null;
  var lb = document.getElementById("lightbox");
  var lbCanvas = document.getElementById("lbCanvas");
  var lbReturnFocus = null;
  function closeLightbox() {{
    lb.hidden = true; lbCanvas.textContent = "";
    if (lbReturnFocus && lbReturnFocus.focus) lbReturnFocus.focus();
    lbReturnFocus = null;
  }}
  document.getElementById("lbClose").addEventListener("click", closeLightbox);
  document.getElementById("lbScrim").addEventListener("click", closeLightbox);
  window.addEventListener("keydown", function (ev) {{
    if (ev.key === "Escape" && !lb.hidden) closeLightbox();
  }});
  function openLightbox() {{
    if (!media.blob || media.kind === "other") return;
    lbReturnFocus = document.activeElement;
    lbCanvas.textContent = "";
    if (media.kind === "video") {{
      var v = document.createElement("video");
      v.src = thumbUrl; v.controls = true; v.playsInline = true; v.preload = "metadata";
      lbCanvas.appendChild(v);
    }} else {{
      var im = document.createElement("img");
      im.src = thumbUrl; im.alt = "";
      lbCanvas.appendChild(im);
    }}
    lb.hidden = false;
    document.getElementById("lbClose").focus();
  }}
  attachThumb.addEventListener("click", openLightbox);
  function setAttachment(name, blob) {{
    media.name = name; media.blob = blob;
    fileInput.value = "";
    if (thumbUrl) {{ URL.revokeObjectURL(thumbUrl); thumbUrl = null; }}
    media.kind = blob
      ? (blob.type.indexOf("video/") === 0 ? "video"
        : blob.type.indexOf("image/") === 0 ? "image" : "other")
      : null;
    attachInfo.classList.toggle("is-on", !!blob);
    attachThumb.textContent = "";
    attachThumb.hidden = !blob;
    if (blob) {{
      thumbUrl = URL.createObjectURL(blob);
      if (media.kind === "video") {{
        var v = document.createElement("video");
        v.src = thumbUrl; v.preload = "metadata"; v.muted = true; v.playsInline = true;
        attachThumb.appendChild(v);
        var p = document.createElement("span");
        p.className = "play";
        p.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3 20 12 6 21 6 3z"/></svg>';
        attachThumb.appendChild(p);
      }} else if (media.kind === "image") {{
        var im = document.createElement("img");
        im.src = thumbUrl; im.alt = "";
        attachThumb.appendChild(im);
      }} else {{
        var e = document.createElement("span");
        e.className = "ext";
        e.textContent = (name.split(".").pop() || "?").slice(0, 6).toUpperCase();
        attachThumb.appendChild(e);
        attachThumb.style.cursor = "default";
      }}
      if (media.kind !== "other") attachThumb.style.cursor = "";
    }}
    document.getElementById("attachText").textContent = blob
      ? name + " (" + (blob.size / 1048576).toFixed(1) + " MB)" : "";
  }}
  document.getElementById("filePick").onclick = function () {{ fileInput.click(); }};
  document.getElementById("attachClear").onclick = function () {{ setAttachment(null, null); }};
  fileInput.addEventListener("change", function () {{
    if (fileInput.files[0]) setAttachment(fileInput.files[0].name, fileInput.files[0]);
  }});
  // Pasting an image straight into the description attaches it.
  document.addEventListener("paste", function (ev) {{
    var item = (ev.clipboardData || {{}}).items && [].slice.call(ev.clipboardData.items)
      .find(function (i) {{ return i.type.indexOf("image/") === 0; }});
    if (!item) return;
    var blob = item.getAsFile();
    if (blob) setAttachment("pasted.png", blob);
  }});

  document.getElementById("shot").onclick = async function () {{
    try {{
      // The browser picker offers both single-window and full-screen.
      var stream = await navigator.mediaDevices.getDisplayMedia({{ video: true }});
      var track = stream.getVideoTracks()[0];
      var video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise(function (r) {{ setTimeout(r, 200); }});
      var canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      stream.getTracks().forEach(function (t) {{ t.stop(); }});
      canvas.toBlob(function (b) {{ if (b) setAttachment("screenshot.png", b); }}, "image/png");
    }} catch (e) {{ /* user cancelled the picker */ }}
  }};

  var recorder = null, recTimer = null;
  var recBtn = document.getElementById("rec"), recStop = document.getElementById("recStop");
  var recState = document.getElementById("recState");
  function recUi(on, left) {{
    recBtn.disabled = on; recStop.style.display = on ? "" : "none";
    recState.textContent = on ? t("recCountdown").replace('#s', left) : "";
  }}
  recBtn.onclick = async function () {{
    try {{
      var stream = await navigator.mediaDevices.getDisplayMedia({{ video: true }});
      var mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9" : "video/webm";
      recorder = new MediaRecorder(stream, {{ mimeType: mime, videoBitsPerSecond: 2500000 }});
      var chunks = [];
      recorder.ondataavailable = function (ev) {{ if (ev.data.size) chunks.push(ev.data); }};
      recorder.onstop = function () {{
        clearInterval(recTimer);
        stream.getTracks().forEach(function (tr) {{ tr.stop(); }});
        setAttachment("recording.webm", new Blob(chunks, {{ type: "video/webm" }}));
        recorder = null; recUi(false, 0);
      }};
      recorder.start(250);
      var left = 10;
      recUi(true, left);
      recTimer = setInterval(function () {{
        left -= 1;
        if (left <= 0) {{ clearInterval(recTimer); if (recorder) recorder.stop(); }}
        else recUi(true, left);
      }}, 1000);
    }} catch (e) {{ /* user cancelled the picker */ }}
  }};
  recStop.onclick = function () {{
    clearInterval(recTimer);
    if (recorder) recorder.stop();
  }};

  // ── submit ────────────────────────────────────────────────────────────
  var form = document.getElementById("f"), msg = document.getElementById("msg"), btn = document.getElementById("submit");
  form.addEventListener("submit", function (ev) {{
    ev.preventDefault();
    msg.className = ""; msg.textContent = t("sending"); btn.disabled = true;
    var fd = new FormData(form);
    if (media.blob) fd.append("file", media.blob, media.name);
    fetch(form.action, {{ method: "POST", body: fd }})
      .then(function (r) {{ return r.json().then(function (j) {{ return {{ status: r.status, j: j }}; }}); }})
      .then(function (res) {{
        if (res.status >= 200 && res.status < 300 && res.j.ok) {{
          msg.className = "ok"; msg.textContent = t("ok");
          form.reset();
          document.getElementById("version").value = pre.version;
          document.getElementById("sysinfo").value = pre.sysinfo;
          document.querySelector('[name="channel"]').value = pre.channel;
          document.getElementById("anon").value = anon;
          contact.value = localStorage.getItem("wowsp_fb_contact") || "";
          gameId.value = localStorage.getItem("wowsp-fb-gameid") || "";
          applyServer();
          setAttachment(null, null);
          if (res.j.record_url) {{
            var a = document.createElement("a");
            a.href = res.j.record_url; a.target = "_blank"; a.textContent = t("viewRecord");
            msg.appendChild(document.createElement("br")); msg.appendChild(a);
          }}
          if (window.turnstile) turnstile.reset();
        }} else {{
          msg.className = "err";
          msg.textContent = res.j.error === "maintenance"
            ? t("maintenance")
            : (t("e_" + (res.j.error || "upstream")) || t("e_upstream"));
          if (window.turnstile) turnstile.reset();
        }}
      }})
      .catch(function () {{ msg.className = "err"; msg.textContent = t("e_upstream"); }})
      .finally(function () {{ btn.disabled = false; }});
  }});

  // ── history lookup ───────────────────────────────────────────────────
  var histContact = document.getElementById("histContact");
  var histResult = document.getElementById("histResult");
  histContact.value = contact.value;
  function esc(s) {{
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {{
      return {{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }}[c];
    }});
  }}
  function loadHistory() {{
    var c = histContact.value.trim();
    if (!c) return;
    histResult.textContent = "...";
    fetch("{base_url}/api/feedback/history?contact=" + encodeURIComponent(c))
      .then(function (r) {{ return r.json(); }})
      .then(function (j) {{
        if (!j.ok) {{ histResult.textContent = t("historyFailed"); return; }}
        if (!j.items.length) {{ histResult.textContent = t("historyEmpty"); return; }}
        // Server statuses are stored in Chinese (Bitable single-select);
        // map them to i18n keys for display, raw value as fallback.
        var STATUS_KEY = {{ "待审查": "statusPending", "已确认": "statusConfirmed",
          "已开PR": "statusPR", "无需修复": "statusWontFix", "需补充": "statusNeedInfo" }};
        var STATUS_DONE = {{ "已开PR": 1, "无需修复": 1 }};
        histResult.innerHTML =
          '<p class="hist-count">' + t("historyCount").replace('#n', j.items.length) + "</p>" +
          j.items.map(function (it) {{
            var d = it.time ? new Date(it.time).toLocaleString() : "";
            var badge = STATUS_DONE[it.status] ? "badge s2" : "badge";
            var label = STATUS_KEY[it.status] ? t(STATUS_KEY[it.status]) : it.status;
            return '<div class="hist-item"><div class="hist-meta">' +
              '<span class="' + badge + '">' + esc(label) + "</span>" +
              '<span class="muted">' + esc(d) + "</span>" +
              (it.pr ? '<a href="' + esc(it.pr) + '" target="_blank">PR</a>' : "") +
              "</div>" + esc(it.description) + "</div>";
          }}).join("");
      }})
      .catch(function () {{ histResult.textContent = t("historyFailed"); }});
  }}
  document.getElementById("histGo").onclick = loadHistory;
  histContact.addEventListener("keydown", function (ev) {{ if (ev.key === "Enter") loadHistory(); }});
  // ── sidebar views: the two nav entries swap form / history panes ─────
  var navForm = document.getElementById("navForm");
  var navHistory = document.getElementById("navHistory");
  function switchView(v) {{
    document.getElementById("viewForm").hidden = v !== "form";
    document.getElementById("viewHistory").hidden = v !== "history";
    if (v === "form") {{ navForm.setAttribute("data-active", ""); navHistory.removeAttribute("data-active"); }}
    else {{ navHistory.setAttribute("data-active", ""); navForm.removeAttribute("data-active"); }}
  }}
  navForm.addEventListener("click", function () {{ switchView("form"); }});
  navHistory.addEventListener("click", function () {{ switchView("history"); }});
  if (q.get("focus") === "history" || q.get("contact")) {{
    switchView("history");
    if (q.get("contact")) histContact.value = q.get("contact");
    if (histContact.value) loadHistory();
  }}
}})();
</script>
</body>
</html>"#
    )
}

/// The /erp review console (admin-key gated; Chinese — it is the
/// maintainer's tool).
pub fn erp_page(base_url: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoWSP 反馈台</title>
<style>
:root {{ color-scheme: light dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #f6f7f9; color: #1f2328; padding: 20px 12px; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #0d1117; color: #e6edf3; }} }}
main {{ max-width: 1100px; margin: 0 auto; }}
h1 {{ font-size: 1.2rem; margin: 0 0 14px; }}
table {{ width: 100%; border-collapse: collapse; background: transparent; }}
th, td {{ padding: 8px 10px; border: 1px solid #d0d7de; text-align: left; vertical-align: top;
  overflow-wrap: anywhere; font-size: .85rem; }}
th {{ background: rgb(110 118 129 / 15%); }}
input, select, button {{ font: inherit; padding: 4px 8px; border: 1px solid #d0d7de;
  border-radius: 6px; background: transparent; color: inherit; }}
button {{ cursor: pointer; }}
#gate {{ display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }}
#gate input {{ flex: 1; min-width: 220px; }}
.muted {{ color: #6b7280; }}
a {{ color: #2563eb; }}
.row-actions {{ display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }}
.bar {{ display: flex; gap: 10px; align-items: center; margin: 12px 0; flex-wrap: wrap; }}
</style>
</head>
<body>
<main>
<h1>WoWSP 反馈台</h1>
<div id="gate">
  <input type="password" id="key" placeholder="管理密钥 (FEEDBACK_ADMIN_KEY)">
  <button id="saveKey">记住密钥</button>
  <button id="reload">刷新</button>
  <select id="statusFilter">
    <option value="">全部状态</option>
    <option>待审查</option><option>已确认</option><option>已开PR</option>
    <option>无需修复</option><option>需补充</option>
  </select>
  <span id="hint" class="muted"></span>
</div>
<table><thead><tr>
  <th style="width:130px">提交时间</th><th>描述</th><th style="width:110px">联系</th>
  <th style="width:90px">版本</th><th style="width:70px">渠道</th>
  <th style="width:120px">状态</th><th style="width:170px">PR</th><th style="width:110px">附件</th>
</tr></thead><tbody id="rows"></tbody></table>
<div class="bar">
  <button id="prev">上一页</button> <button id="next">下一页</button>
  <span id="pageInfo" class="muted"></span>
</div>
</main>
<script>
(function () {{
  var BASE = "{base_url}";
  var key = localStorage.getItem("wowsp_erp_key") || "";
  document.getElementById("key").value = key;
  document.getElementById("saveKey").onclick = function () {{
    key = document.getElementById("key").value.trim();
    localStorage.setItem("wowsp_erp_key", key);
    load();
  }};
  document.getElementById("reload").onclick = function () {{ load(); }};
  var pageToken = null, nextToken = null, prevStack = [];
  function esc(s) {{
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {{
      return {{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}}[c];
    }});
  }}
  function fmtTime(v) {{
    if (!v) return "";
    return new Date(v).toLocaleString("zh-CN", {{ hour12: false }});
  }}
  function render(items) {{
    var filter = document.getElementById("statusFilter").value;
    var tb = document.getElementById("rows");
    tb.innerHTML = "";
    items.filter(function (it) {{ return !filter || it.status === filter; }}).forEach(function (it) {{
      var tr = document.createElement("tr");
      var atts = (it.attachments || []).map(function (a) {{
        return '<a href="' + esc(a.url) + '" target="_blank">' + esc(a.name) + '</a>';
      }}).join("<br>") || '<span class="muted">—</span>';
      tr.innerHTML =
        "<td>" + esc(fmtTime(it.time)) + "</td>" +
        "<td>" + esc(it.description) +
          (it.sysinfo ? '<div class="muted">' + esc(it.sysinfo) + "</div>" : "") +
          ((it.server || it.game_id)
            ? '<div class="muted">' +
              (it.server ? "🌐 " + esc(it.server.toUpperCase()) : "") +
              (it.server && it.game_id ? " · " : "") +
              (it.game_id ? "🆔 " + esc(it.game_id) : "") +
              "</div>"
            : "") +
          (it.record_url ? '<div class="row-actions"><a href="' + esc(it.record_url) + '" target="_blank">记录</a></div>' : "") + "</td>" +
        "<td>" + esc(it.contact || "—") + "</td>" +
        "<td>" + esc(it.version || "—") + "</td>" +
        "<td>" + esc(it.channel || "—") + "</td>" +
        '<td><select data-rec="' + esc(it.record_id) + '" class="st">' +
          ["待审查","已确认","已开PR","无需修复","需补充"].map(function (s) {{
            return "<option" + (s === it.status ? " selected" : "") + ">" + s + "</option>";
          }}).join("") + "</select></td>" +
        '<td><input class="pr" data-rec="' + esc(it.record_id) + '" value="' + esc(it.pr || "") + '" placeholder="PR URL">' +
          '<div class="row-actions"><button class="save" data-rec="' + esc(it.record_id) + '">保存</button></div></td>' +
        "<td>" + atts + "</td>";
      tb.appendChild(tr);
    }});
    tb.querySelectorAll("button.save").forEach(function (b) {{
      b.onclick = function () {{
        var rec = b.getAttribute("data-rec");
        var st = tb.querySelector('select.st[data-rec="' + rec + '"]').value;
        var pr = tb.querySelector('input.pr[data-rec="' + rec + '"]').value.trim();
        fetch(BASE + "/api/feedback/update", {{
          method: "POST",
          headers: {{ "X-Admin-Key": key, "Content-Type": "application/json" }},
          body: JSON.stringify({{ record_id: rec, status: st, pr_link: pr }})
        }}).then(function (r) {{ return r.json(); }}).then(function (j) {{
          document.getElementById("hint").textContent = j.ok ? "已保存 " + rec : "保存失败: " + (j.error || "");
        }});
      }};
    }});
  }}
  function load(token) {{
    if (!key) {{ document.getElementById("hint").textContent = "请先填入管理密钥"; return; }}
    var url = BASE + "/api/feedback/list?page_size=50" + (token ? "&page_token=" + encodeURIComponent(token) : "");
    fetch(url, {{ headers: {{ "X-Admin-Key": key }} }})
      .then(function (r) {{
        if (r.status === 401) throw new Error("密钥无效");
        return r.json();
      }})
      .then(function (j) {{
        nextToken = j.next_page_token || null;
        pageToken = token || null;
        render(j.items || []);
        document.getElementById("pageInfo").textContent = (j.items || []).length + " 条" + (nextToken ? " · 有下一页" : "");
        document.getElementById("hint").textContent = "";
      }})
      .catch(function (e) {{ document.getElementById("hint").textContent = e.message; }});
  }}
  // Only 下一页 grows the back-stack (loading BY prev/filter must not
  // push, or back would oscillate).
  document.getElementById("next").onclick = function () {{
    if (nextToken) {{ prevStack.push(pageToken); load(nextToken); }}
  }};
  document.getElementById("prev").onclick = function () {{ var t = prevStack.pop() || null; load(t); }};
  document.getElementById("statusFilter").onchange = function () {{
    load(pageToken);
  }};
  if (key) load();
}})();
</script>
</body>
</html>"#
    )
}

#[cfg(test)]
mod tests {
    const TEST_VER: &str = "0.4.11";
    const TEST_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36         (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    use super::*;

    fn sample() -> Submission {
        Submission {
            description: "  Tab 面板不显示  ".into(),
            contact: "10001".into(),
            version: "0.4.11".into(),
            sysinfo: "windows x86_64".into(),
            channel: "desktop".into(),
            anon_id: "anon-1".into(),
            server: " ASIA ".into(),
            game_id: " 123456 ".into(),
            files: vec![(Some("wowsp.zip".into()), b"PK".to_vec())],
        }
    }

    #[test]
    fn normalize_trims_and_accepts() {
        let mut s = sample();
        assert!(normalize(&mut s).is_ok());
        assert_eq!(s.description, "Tab 面板不显示");
    }

    #[test]
    fn normalize_rejects_the_expected_codes() {
        let mut s = sample();
        s.description = "   ".into();
        assert_eq!(normalize(&mut s), Err("empty_description"));

        let mut s = sample();
        s.channel = "wasm".into();
        assert_eq!(normalize(&mut s), Err("bad_channel"));

        let mut s = sample();
        s.files = vec![(Some("logs.zip".into()), vec![0u8; FILE_MAX + 1])];
        assert_eq!(normalize(&mut s), Err("file_too_large"));

        let mut s = sample();
        s.files = vec![(Some("payload.exe".into()), vec![1])];
        assert_eq!(normalize(&mut s), Err("bad_file_type"));

        // No file at all is fine.
        let mut s = sample();
        s.files = Vec::new();
        assert!(normalize(&mut s).is_ok());
    }

    #[test]
    fn normalize_sanitizes_the_filename() {
        // The name rides an outbound Content-Disposition line: quotes and
        // CR/LF must go, absurd length must clamp WITHOUT losing the
        // extension (the ext verdict must apply to the FINAL name).
        let mut s = sample();
        s.files = vec![(Some("日志\"evil\r\n.zip".into()), b"PK".to_vec())];
        assert!(normalize(&mut s).is_ok());
        assert_eq!(s.files[0].0.as_deref(), Some("日志evil.zip"));

        let mut s = sample();
        s.files = vec![(
            Some(format!("{}.zip", "x".repeat(FILENAME_MAX + 50))),
            b"PK".to_vec(),
        )];
        assert!(normalize(&mut s).is_ok());
        let capped = s.files[0].0.as_deref().unwrap();
        assert!(capped.chars().count() <= FILENAME_MAX, "{capped}");
        assert!(capped.ends_with(".zip"), "extension survives the cap");

        // An extension that only exists before sanitization/truncation
        // cannot sneak through: the verdict uses the final name.
        let mut s = sample();
        s.files = vec![(Some("no-ext".into()), b"x".to_vec())];
        assert_eq!(normalize(&mut s), Err("bad_file_type"));
    }

    #[test]
    fn record_fields_map_to_bitable_names() {
        let mut s = sample();
        // Mixed-case / spacey contact must land in its canonical lookup
        // form — handle_history exact-matches the normalized query.
        s.contact = "  QQ  1234@Gmail.com ".into();
        normalize(&mut s).unwrap();
        let f = record_fields(&s, 1_750_000_000_000i64);
        assert_eq!(f.get(F_CONTACT).unwrap(), "qq 1234@gmail.com");
        assert_eq!(f.get(F_DESC).unwrap(), "Tab 面板不显示");
        assert_eq!(f.get(F_STATUS).unwrap(), "待审查");
        assert_eq!(f.get(F_TIME).unwrap(), &json!(1_750_000_000_000i64));
        assert_eq!(f.get(F_CHANNEL).unwrap(), "desktop");
        assert!(f.contains_key(F_ANON));
    }

    #[test]
    fn attachment_and_schema_shapes() {
        assert_eq!(
            attachment_update_body(&["ftok".into()]).pointer("/fields/日志包/0/file_token"),
            Some(&json!("ftok"))
        );
        // 多附件（桌面端 截图+日志包）一次挂到数组字段上。
        let two = attachment_update_body(&["t1".into(), "t2".into()]);
        assert_eq!(
            two.pointer("/fields/日志包/1/file_token"),
            Some(&json!("t2"))
        );
        let schema = table_schema();
        let names: Vec<&str> = schema["table"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["field_name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 12);
        assert!(names.contains(&F_LOG));
        assert!(names.contains(&F_STATUS));
        assert!(names.contains(&F_SERVER));
        assert!(names.contains(&F_GAME_ID));
        // The server column is a single-select offering the five realms.
        let server_field = schema["table"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["field_name"] == F_SERVER)
            .unwrap();
        let opts: Vec<&str> = server_field["property"]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["name"].as_str().unwrap())
            .collect();
        assert_eq!(opts, REALMS);
    }

    #[test]
    fn turnstile_shapes() {
        let body = turnstile_verify_body("s", "tok", "1.2.3.4");
        assert!(body.contains("secret=s") && body.contains("response=tok"));
        assert!(turnstile_passed(&json!({ "success": true })));
        assert!(!turnstile_passed(
            &json!({ "success": false, "error-codes": ["invalid-input-response"] })
        ));
        assert!(!turnstile_passed(&json!({})));
        assert!(valid_sitekey("0x4AAAAAAAabc123-_"));
        assert!(!valid_sitekey(""));
        assert!(!valid_sitekey("bad key\" onclick"));
    }

    #[test]
    fn rate_keys_use_integer_buckets() {
        let [a, b, c] = rate_keys("1.2.3.4", "anon", "", 0).try_into().unwrap();
        assert_eq!(a, "rl:ip:1.2.3.4:0");
        assert_eq!(b, "rl:anon:anon:0");
        assert_eq!(c, "rl:day:0");
        assert_eq!(rate_limits(""), vec![5, 10, 300]);
        // One hour later the IP bucket rolls over, the day buckets do not.
        let keys2 = rate_keys("1.2.3.4", "anon", "", 3_600_000);
        assert_ne!(a, keys2[0]);
        assert_eq!(b, keys2[1]);
        assert_eq!(c, keys2[2]);
    }

    #[test]
    fn contact_buckets_normalize_and_limit_at_twenty() {
        let with = rate_keys("1.1.1.1", "anon", "  QQ  123@QQ.COM ", 0);
        assert_eq!(with.len(), 4, "contact adds a fourth key");
        assert_eq!(with[2], "rl:contact:qq 123@qq.com:0");
        assert_eq!(rate_limits("10001"), vec![5, 10, 20, 300]);
        // Same contact spelled differently shares the bucket.
        let alt = rate_keys("2.2.2.2", "anon2", "qq 123@qq.com", 0);
        assert_eq!(with[2], alt[2]);
        assert_eq!(history_rate_key("1.1.1.1", 0), "rl:hist:1.1.1.1:0");
    }

    #[test]
    fn attachment_kinds_have_distinct_caps() {
        assert_eq!(attach_kind("logs.zip"), Some(AttachKind::Log));
        assert_eq!(attach_kind("shot.PNG"), Some(AttachKind::Image));
        assert_eq!(attach_kind("clip.webm"), Some(AttachKind::Video));
        assert_eq!(attach_kind("clip.mp4"), Some(AttachKind::Video));
        assert_eq!(attach_kind("payload.exe"), None);
        assert_eq!(attach_max(AttachKind::Log), FILE_MAX);
        assert_eq!(attach_max(AttachKind::Image), IMAGE_MAX);
        assert_eq!(attach_max(AttachKind::Video), VIDEO_MAX);
        assert!(ATTACHMENT_MAX >= IMAGE_MAX && ATTACHMENT_MAX >= FILE_MAX);
    }

    #[test]
    fn media_sizes_validate_per_kind() {
        // A 5 MB png is fine (image cap 10 MB) but a 5 MB zip is not.
        let mut s = sample();
        s.files = vec![(Some("shot.png".into()), vec![0u8; 5 * 1024 * 1024])];
        assert!(normalize(&mut s).is_ok());

        let mut s = sample();
        s.files = vec![(Some("logs.zip".into()), vec![0u8; 5 * 1024 * 1024])];

        assert_eq!(normalize(&mut s), Err("file_too_large"));

        // A 12 MB webm recording passes (video cap 18 MB).
        let mut s = sample();
        s.files = vec![(Some("rec.webm".into()), vec![0u8; 12 * 1024 * 1024])];
        assert!(normalize(&mut s).is_ok());
    }

    #[test]
    fn feedback_page_injects_the_widget_or_maintenance() {
        let with = feedback_page(
            Some("0x4AAAAsitekey"),
            "https://wowsp.langyo.xyz",
            TEST_VER,
            TEST_UA,
        );
        assert!(with.contains("0x4AAAAsitekey"));
        assert!(with.contains("challenges.cloudflare.com/turnstile"));
        assert!(with.contains("/api/feedback/submit"));
        assert!(!with.contains("id=\"submit\" disabled"));

        let maint = feedback_page(None, "https://wowsp.langyo.xyz", TEST_VER, TEST_UA);
        assert!(!maint.contains("challenges.cloudflare.com"));
        assert!(maint.contains("maintenance"));
        assert!(maint.contains("id=\"submit\" disabled"));

        // A hostile sitekey value is refused (falls back to maintenance).
        let bad = feedback_page(
            Some("x\" onload=alert(1)"),
            "https://wowsp.langyo.xyz",
            TEST_VER,
            TEST_UA,
        );
        assert!(!bad.contains("onload=alert"));
    }

    #[test]
    fn feedback_locales_parse_with_parity_and_tokens() {
        let baseline = FEEDBACK_LOCALE_FILES
            .iter()
            .find(|(l, _)| *l == "en-US")
            .map(|(_, raw)| raw)
            .expect("en-US baseline present");
        let base_map: Map<String, Value> =
            serde_json::from_str(baseline).expect("en-US feedback.json parses");
        let base_keys: Vec<&str> = base_map.keys().map(String::as_str).collect();
        assert!(
            base_keys.contains(&"privacy"),
            "privacy disclaimer is i18n'd"
        );

        for (lang, raw) in FEEDBACK_LOCALE_FILES {
            let m: Map<String, Value> = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("locale {lang} does not parse: {e}"));
            assert_eq!(
                m.keys().map(String::as_str).collect::<Vec<_>>(),
                base_keys,
                "locale {lang} key set drifts from en-US"
            );
            // Runtime #s/##n token replacement breaks silently without the
            // token, so every locale must carry it.
            for key in ["recCountdown", "historyCount"] {
                let v = m.get(key).and_then(Value::as_str).unwrap_or_default();
                let expect = if key == "recCountdown" { "#s" } else { "#n" };
                assert!(
                    v.contains(expect),
                    "{lang}.{key} lost its {expect} token: {v}"
                );
            }
        }
    }

    #[test]
    fn infer_sysinfo_covers_common_agents() {
        let chrome_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
        assert_eq!(
            infer_sysinfo_from_ua(chrome_win),
            "Windows 10/11 \u{b7} Chrome 126"
        );
        let edge_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
        assert_eq!(
            infer_sysinfo_from_ua(edge_win),
            "Windows 10/11 \u{b7} Edge 126"
        );
        let win7 = "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        assert_eq!(infer_sysinfo_from_ua(win7), "Windows 7 \u{b7} Chrome 120");
        let ff_linux = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
        assert_eq!(infer_sysinfo_from_ua(ff_linux), "Linux \u{b7} Firefox 127");
        let mac_safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
        assert_eq!(
            infer_sysinfo_from_ua(mac_safari),
            "macOS \u{b7} Safari 17.4"
        );
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
        assert_eq!(infer_sysinfo_from_ua(iphone), "iOS 17.4 \u{b7} Safari 17.4");
        let ipad = "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1";
        assert_eq!(
            infer_sysinfo_from_ua(ipad),
            "iPadOS 17.4 \u{b7} Safari 17.4"
        );
        let android_edge = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0";
        assert_eq!(
            infer_sysinfo_from_ua(android_edge),
            "Android 14 \u{b7} Edge 126"
        );
        let opera = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0";
        assert_eq!(
            infer_sysinfo_from_ua(opera),
            "Windows 10/11 \u{b7} Opera 111"
        );
        // Unknown tooling collapses instead of guessing.
        assert_eq!(infer_sysinfo_from_ua("curl/8.5.0"), "Web");
        assert_eq!(infer_sysinfo_from_ua(""), "Web");
    }

    #[test]
    fn feedback_page_ships_sidebar_combos_and_preview() {
        let page = feedback_page(
            Some("0x4AAAAsitekey"),
            "https://wowsp.langyo.xyz",
            TEST_VER,
            TEST_UA,
        );
        // Sidebar navigation with the two entries, and both views shipped.
        assert!(page.contains(r#"class="nav-item" id="navForm" data-active"#));
        assert!(page.contains(r#"class="nav-item" id="navHistory""#));
        assert!(page.contains(r#"id="viewForm""#));
        assert!(page.contains(r#"id="viewHistory" hidden"#));
        // The language selector and every other dropdown is the custom
        // hikari-styled menu now \u{2014} no native <select> remains.
        assert!(page.contains(r#"id="langSel" class="sel-btn""#));
        assert!(!page.contains("<select"));
        // Contact category chip before the field; version/sysinfo are
        // editable comboboxes with the server-computed defaults.
        assert!(page.contains(r#"id="contactType" class="affix-chip""#));
        assert!(page.contains(r#"id="contact" name="contact" maxlength="64""#));
        assert!(!page.contains("readonly"));
        assert!(page.contains(r#"value="0.4.11""#));
        assert!(page.contains("value=\"Windows 10/11 \u{b7} Chrome 126\""));
        // Suggestion table present; hostile UA text collapses in the
        // inference and never reaches the page verbatim.
        assert!(page.contains("var SUGGEST = "));
        let hostile = feedback_page(
            None,
            "https://wowsp.langyo.xyz",
            "0.4.11",
            "Mozilla/5.0 </script><script>alert(1)</script>",
        );
        assert!(hostile.contains("value=\"Web\""));
        assert!(!hostile.contains("</script><script>alert"));
        // Belt-and-braces: the JSON literalizer escapes `<` so even a
        // future inference change cannot close the script block.
        let evil = serde_json::json!("a</script>b");
        assert_eq!(json_script_literal(&evil), "\"a\\u003c/script>b\"");
        // Thumbnail tile + lightbox chrome ship.
        assert!(page.contains(r#"class="attach-thumb" id="attachThumb""#));
        assert!(page.contains(r#"id="lightbox" class="lb" hidden"#));
        assert!(page.contains(r#"id="lbClose""#));
        // Server + game-ID row: chip menu, hidden server field, game input.
        assert!(page.contains(r#"id="serverChip" class="affix-chip""#));
        assert!(page.contains(r#"id="gameId" name="game_id" maxlength="32""#));
        assert!(page.contains(r#"name="server" id="serverField""#));
        assert!(page.contains("REALMS = [\"ru\", \"eu\", \"na\", \"asia\", \"cn\"]"));
        // Full-height shell + overlay scrollbar wiring.
        assert!(page.contains("height: 100vh; height: 100dvh;"));
        assert!(page.contains(r#".hk-scrollbar-track"#));
        assert!(page.contains(r#".hk-scrollbar-thumb"#));
        // 提交不再要求进群验证：验证块与签发/查询端点都不随页面下发。
        assert!(!page.contains("qqVerify"));
        assert!(!page.contains("/api/feedback/qq/code"));
        assert!(!page.contains("/api/feedback/qq/status"));
        // ? 按钮弹窗只给加群建议与私聊跟进提示。
        assert!(page.contains(r#"id="qqHelp" class="contact-help" hidden"#));
        assert!(page.contains(r#"id="qqHelpModal" class="fb-modal" hidden"#));
        assert!(page.contains(r#"id="helpJoin""#));
        assert!(page.contains(r#"id="helpDone" data-i18n="qqHelpDone""#));
        assert!(page.contains("hk-scrollbar-track\";"));
    }

    #[test]
    fn feedback_page_ships_the_locale_runtime() {
        let page = feedback_page(
            Some("0x4AAAAsitekey"),
            "https://wowsp.langyo.xyz",
            TEST_VER,
            TEST_UA,
        );
        assert!(page.contains(r#"id="langSel""#));
        for lang in [
            "en-US", "zh-CN", "zh-SG", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "fr-FR", "es-ES",
        ] {
            assert!(
                page.contains(&format!("\"{lang}\":")),
                "page misses locale {lang}"
            );
        }
        // The merged table is valid JSON (it doubles as a JS object literal).
        let start = page.find("var LOCALES = ").expect("LOCALES decl") + "var LOCALES = ".len();
        let end = page[start..].find(";\n").expect("LOCALES terminator") + start;
        let merged: Value = serde_json::from_str(&page[start..end]).expect("LOCALES JSON");
        assert_eq!(merged.as_object().map(Map::len), Some(9));
        // The file picker is a translated custom button, not the OS-locale
        // native control.
        assert!(page.contains(r#"id="filePick" data-i18n="filePick""#));
        assert!(page.contains(r#"<input type="file" id="file" name="file" hidden"#));
    }

    #[test]
    fn feedback_page_carries_hikari_tokens() {
        // The vendored sheet is the real hikari vocabulary: channel palette,
        // scale tokens, fonts, and both default-preset schemes behind the
        // two documented selectors.
        for marker in [
            "--color-primary",
            "--color-focused-border",
            "--space-16",
            "--radius-sm",
            "--text-sm",
            "--font-sans",
            "--c-primary-light",
            "--shadow-button",
            "prefers-color-scheme: dark",
            r#"html[data-mode="dark"]"#,
        ] {
            assert!(FEEDBACK_HIKARI_CSS.contains(marker), "tokens miss {marker}");
        }
        // The page embeds the sheet and flips it with hikari's own
        // data-mode attribute; no hand-rolled palette may remain.
        let page = feedback_page(
            Some("0x4AAAAsitekey"),
            "https://wowsp.langyo.xyz",
            TEST_VER,
            TEST_UA,
        );
        assert!(page.matches("data-mode").count() >= 2);
        assert!(page.contains("--color-primary: 214 51 132")); // preset light
        assert!(page.contains("--color-primary: 136 192 208")); // preset dark
        for stale in ["#2563eb", "#d0d7de", "#0d1117", "#f6f7f9", "#6b7280"] {
            assert!(!page.contains(stale), "hand-rolled color {stale} survived");
        }
    }

    #[test]
    fn erp_page_references_the_admin_apis() {
        let page = erp_page("https://wowsp.langyo.xyz");
        assert!(page.contains("/api/feedback/list"));
        assert!(page.contains("/api/feedback/update"));
        assert!(page.contains("X-Admin-Key"));
    }
}
