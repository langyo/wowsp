//! Feedback pipeline policy: validation limits, Bitable field mapping,
//! Turnstile wire shapes, rate-limit key layout, and the two embedded
//! pages (`/feedback` form + `/erp` console). Pure and host-testable —
//! the worker crate supplies fetch/KV/clock I/O only.

use serde_json::{Map, Value, json};

// ── Bitable schema (field names as created in the 反馈 table) ──────────

pub const F_DESC: &str = "反馈描述";
pub const F_CONTACT: &str = "联系方式";
pub const F_VERSION: &str = "应用版本";
pub const F_SYS: &str = "系统信息";
pub const F_CHANNEL: &str = "渠道";
pub const F_ANON: &str = "匿名ID";
pub const F_LOG: &str = "日志包";
pub const F_STATUS: &str = "处理状态";
pub const F_PR: &str = "PR链接";
pub const F_TIME: &str = "提交时间";

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
    pub file_name: Option<String>,
    pub file_bytes: Option<Vec<u8>>,
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

    if sub.description.is_empty() {
        return Err("empty_description");
    }
    if !matches!(sub.channel.as_str(), "desktop" | "web" | "android") {
        return Err("bad_channel");
    }
    if sub.anon_id.is_empty() {
        sub.anon_id = "anon".into();
    }
    if let Some(name) = sub.file_name.as_mut() {
        // The name rides an outbound Content-Disposition header line —
        // strip everything that could break the quoting/framing, cap the
        // length (stem-only, extension preserved)…
        *name = name
            .chars()
            .filter(|c| *c != '"' && *c != '\r' && *c != '\n' && *c != '\\')
            .collect();
        *name = cap_name(name, FILENAME_MAX);
    }
    // …then the kind check (extension) and the per-kind size cap run on
    // the FINAL name.
    if let Some(bytes) = sub.file_bytes.as_ref() {
        let Some(name) = sub.file_name.as_deref().filter(|n| !n.is_empty()) else {
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
    m.insert(F_CHANNEL.into(), json!(sub.channel));
    m.insert(F_ANON.into(), json!(sub.anon_id));
    m.insert(F_STATUS.into(), json!(STATUS_NEW));
    // Bitable date fields take epoch milliseconds.
    m.insert(F_TIME.into(), json!(now_ms));
    m
}

/// `PUT records/{id}` body attaching an uploaded file to the 日志包 field.
pub fn attachment_update_body(file_token: &str) -> Value {
    json!({ "fields": { F_LOG: [ { "file_token": file_token } ] } })
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

/// The /feedback form. `sitekey: None` renders the maintenance notice
/// (deploy before the Turnstile widget exists / after pulling the key).
pub fn feedback_page(sitekey: Option<&str>, base_url: &str) -> String {
    let key = sitekey.filter(|k| valid_sitekey(k));
    let turnstile_head = match &key {
        Some(_) => r#"<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>"#.into(),
        None => String::new(),
    };
    let turnstile_widget = match &key {
        Some(k) => format!(r#"<div class="cf-turnstile" data-sitekey="{k}" data-theme="auto"></div>"#),
        None => r#"<p class="notice" data-i18n="maintenance"></p>"#.into(),
    };
    let submit_disabled = if key.is_some() { "" } else { " disabled" };
    format!(
        r#"<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoWSP Feedback</title>
{turnstile_head}
<style>
:root {{ color-scheme: light dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font: 15px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #f6f7f9; color: #1f2328; padding: 24px 12px; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #0d1117; color: #e6edf3; }} }}
main {{ max-width: 620px; margin: 0 auto; }}
h1 {{ font-size: 1.35rem; margin: 0 0 4px; }}
p.sub {{ margin: 0 0 20px; color: #6b7280; }}
label {{ display: block; margin: 14px 0 6px; font-weight: 600; font-size: .9rem; }}
textarea, input[type=text] {{ width: 100%; padding: 8px 10px; border: 1px solid #d0d7de;
  border-radius: 8px; font: inherit; background: transparent; color: inherit; }}
textarea {{ min-height: 120px; resize: vertical; }}
input[readonly] {{ opacity: .75; }}
button {{ padding: 9px 18px; border: 0; border-radius: 8px; font: inherit;
  font-weight: 600; background: #2563eb; color: #fff; cursor: pointer; }}
button:disabled {{ opacity: .5; cursor: not-allowed; }}
button.ghost {{ background: transparent; border: 1px solid #d0d7de; color: inherit; }}
.notice {{ padding: 12px; border-radius: 8px; background: rgb(255 159 10 / 12%); }}
#msg {{ margin-top: 14px; white-space: pre-wrap; }}
#msg.ok {{ color: #1a7f37; }} #msg.err {{ color: #cf222e; }}
a {{ color: #2563eb; }}
.media-row {{ display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }}
.media-row button {{ padding: 7px 14px; font-size: .9rem; }}
#recState {{ font-weight: 600; color: #cf222e; }}
#attachInfo {{ margin-top: 8px; font-size: .85rem; color: #6b7280; display: flex;
  gap: 8px; align-items: center; flex-wrap: wrap; }}
#attachInfo button {{ padding: 2px 10px; font-size: .78rem; }}
.privacy {{ margin-top: 18px; padding: 12px; border-radius: 8px; font-size: .82rem;
  line-height: 1.7; color: #6b7280; background: rgb(110 118 129 / 10%); }}
details.history {{ margin-top: 22px; }}
details.history summary {{ cursor: pointer; font-weight: 600; font-size: .95rem; }}
.hist-row {{ display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }}
.hist-row input {{ flex: 1; min-width: 200px; }}
.hist-item {{ padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 8px;
  margin-bottom: 8px; font-size: .88rem; }}
.hist-item .muted {{ color: #6b7280; font-size: .8rem; }}
.badge {{ display: inline-block; padding: 0 8px; border-radius: 999px; font-size: .78rem;
  background: rgb(37 99 235 / 14%); color: #2563eb; }}
.badge.s2 {{ background: rgb(26 127 55 / 14%); color: #1a7f37; }}
</style>
</head>
<body>
<main>
<h1>WoWSP Feedback</h1>
<p class="sub" data-i18n="subtitle"></p>
<form id="f" action="{base_url}/api/feedback/submit" method="post" enctype="multipart/form-data">
  <label for="description" data-i18n="descLabel"></label>
  <textarea id="description" name="description" maxlength="5000" required></textarea>
  <label for="contact" data-i18n="contactLabel"></label>
  <input type="text" id="contact" name="contact" maxlength="64">
  <label for="version" data-i18n="versionLabel"></label>
  <input type="text" id="version" name="version" readonly>
  <label for="sysinfo" data-i18n="sysLabel"></label>
  <input type="text" id="sysinfo" name="sysinfo" readonly>
  <input type="hidden" name="channel" value="web">
  <input type="hidden" name="anon" id="anon">
  <label for="file" data-i18n="fileLabel"></label>
  <input type="file" id="file" name="file" accept=".zip,.log,.txt,.gz,.png,.jpg,.jpeg,.gif,.webp,.bmp,.webm,.mp4,.mov">
  <div class="media-row">
    <button type="button" class="ghost" id="shot" data-i18n="shotBtn"></button>
    <button type="button" class="ghost" id="rec" data-i18n="recBtn"></button>
    <button type="button" class="ghost" id="recStop" style="display:none" data-i18n="recStopBtn"></button>
    <span id="recState"></span>
  </div>
  <div id="attachInfo" style="display:none">
    <span id="attachText"></span>
    <button type="button" class="ghost" id="attachClear" data-i18n="attachClear"></button>
  </div>
  {turnstile_widget}
  <button type="submit" id="submit"{submit_disabled} data-i18n="submit"></button>
  <p id="msg" role="status"></p>
</form>
<section class="privacy" data-i18n="privacy"></section>
<details class="history" id="historyBox">
  <summary data-i18n="historyTitle"></summary>
  <div class="hist-row">
    <input type="text" id="histContact" data-i18n-placeholder="historyContact">
    <button type="button" id="histGo" data-i18n="historyGo"></button>
  </div>
  <div id="histResult"></div>
</details>
</main>
<script>
(function () {{
  var zh = {{
    subtitle: "遇到问题或建议？可以带上截图、录屏或日志提交，我们会尽快处理。",
    descLabel: "反馈描述 *", contactLabel: "联系方式（QQ / 邮箱，选填）",
    versionLabel: "应用版本", sysLabel: "系统信息",
    fileLabel: "附件（日志 .zip / 截图图片 / 录屏视频，选填）",
    shotBtn: "截图", recBtn: "录屏（≤10 秒）", recStopBtn: "停止录制",
    recCountdown: "录制中 #s 秒", attachClear: "移除",
    privacy: "隐私说明：所有附件（截图、录屏、日志）都由你手动选择或手动触发采集，我们不会主动采集任何数据。画面里可能包含你的个人信息，请自行斟酌暴露范围——截图 / 录屏时可以选择只采集某个窗口而不是整个屏幕。你无意中暴露的隐私内容只会被用于定位问题，我们承诺不将其用于任何其他用途，问题处理完毕后随记录一起删除。",
    submit: "提交", maintenance: "反馈通道暂时维护中，请稍后再试或到 QQ 群反馈。",
    sending: "提交中…", ok: "提交成功，感谢反馈！",
    viewRecord: "查看记录",
    historyTitle: "历史反馈记录", historyContact: "QQ 或邮箱（追查处理进度）",
    historyGo: "查询", historyEmpty: "没有查到该联系方式的反馈记录。",
    historyFailed: "查询失败，请稍后再试。", historyCount: "最近 #n 条",
    e_empty_description: "请填写反馈描述。", e_bad_channel: "渠道参数无效。",
    e_file_too_large: "附件超过大小限制（日志 ≤ 4MB，图片 ≤ 10MB，录屏 ≤ 18MB）。",
    e_bad_file_type: "支持的类型：日志 .zip/.log/.txt、图片 .png/.jpg/.webp、录屏 .webm/.mp4。",
    e_turnstile: "人机验证未通过，请重试。", e_rate_limited: "提交过于频繁或超出当日限额（同一联系方式每天最多 20 次），请稍后再试。",
    e_upstream: "服务暂时不可用，请稍后再试。"
  }};
  var en = {{
    subtitle: "Problem or suggestion? Attach a screenshot, a recording or logs and we will take a look.",
    descLabel: "Description *", contactLabel: "Contact (QQ / email, optional)",
    versionLabel: "App version", sysLabel: "System info",
    fileLabel: "Attachment (log .zip / screenshot image / screen recording, optional)",
    shotBtn: "Screenshot", recBtn: "Record (≤10s)", recStopBtn: "Stop recording",
    recCountdown: "Recording #s s", attachClear: "Remove",
    privacy: "Privacy note: every attachment (screenshot, recording, logs) is chosen or triggered by you manually — we never collect anything on our own. Captures may contain personal information; consider limiting the scope (pick a single window instead of the whole screen when capturing). Anything private you expose unintentionally is used only to diagnose your report, never for any other purpose, and is deleted along with the record once the issue is handled.",
    submit: "Submit", maintenance: "The feedback channel is under maintenance — please retry later or use the QQ group.",
    sending: "Submitting…", ok: "Submitted — thank you!",
    viewRecord: "View record",
    historyTitle: "My feedback history", historyContact: "QQ or email (track progress)",
    historyGo: "Look up", historyEmpty: "No feedback found for this contact.",
    historyFailed: "Lookup failed, please retry later.", historyCount: 'Latest #n',
    e_empty_description: "Please describe the problem.", e_bad_channel: "Invalid channel.",
    e_file_too_large: "Attachment exceeds its size limit (logs ≤ 4MB, images ≤ 10MB, recordings ≤ 18MB).",
    e_bad_file_type: "Accepted: logs .zip/.log/.txt, images .png/.jpg/.webp, recordings .webm/.mp4.",
    e_turnstile: "Human verification failed, please retry.", e_rate_limited: "Too many submissions or over the daily cap (max 20 per day per contact) — please retry later.",
    e_upstream: "Service temporarily unavailable, please retry later."
  }};
  var dict = (navigator.language || "zh").toLowerCase().startsWith("zh") ? zh : en;
  function t(k) {{ return dict[k] || ""; }}
  document.querySelectorAll("[data-i18n]").forEach(function (el) {{
    var v = t(el.getAttribute("data-i18n"));
    if (v) el.textContent = v;
  }});
  document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {{
    var v = t(el.getAttribute("data-i18n-placeholder"));
    if (v) el.placeholder = v;
  }});

  var q = new URLSearchParams(location.search);
  ["version", "sysinfo"].forEach(function (k) {{
    if (q.get(k)) document.getElementById(k).value = q.get(k);
  }});
  if (q.get("channel")) document.querySelector('[name="channel"]').value = q.get("channel");
  // form.reset() would wipe the query prefills (readonly inputs have no
  // defaults) — capture them once and reapply after every submit.
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

  // ── attachments: media capture replaces the file-input pick ──────────
  var media = {{ blob: null, name: null }};
  var fileInput = document.getElementById("file");
  var attachInfo = document.getElementById("attachInfo");
  function setAttachment(name, blob) {{
    media.name = name; media.blob = blob;
    if (blob) fileInput.value = "";
    attachInfo.style.display = blob ? "flex" : "none";
    document.getElementById("attachText").textContent = blob
      ? name + " (" + (blob.size / 1048576).toFixed(1) + " MB)" : "";
  }}
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
          setAttachment(null, null);
          if (res.j.record_url) {{
            var a = document.createElement("a");
            a.href = res.j.record_url; a.target = "_blank"; a.textContent = t("viewRecord");
            msg.appendChild(document.createElement("br")); msg.appendChild(a);
          }}
          if (window.turnstile) turnstile.reset();
        }} else {{
          msg.className = "err";
          msg.textContent = dict["e_" + (res.j.error || "upstream")] || t("e_upstream");
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
        histResult.innerHTML =
          '<p class="hist-item">' + t("historyCount").replace('#n', j.items.length) + "</p>" +
          j.items.map(function (it) {{
            var d = it.time ? new Date(it.time).toLocaleString() : "";
            var badge = it.status === "已开PR" || it.status === "无需修复" ? "badge s2" : "badge";
            return '<div class="hist-item"><span class="' + badge + '">' + esc(it.status) + "</span>" +
              ' <span class="muted">' + esc(d) + "</span>" +
              (it.pr ? ' <a href="' + esc(it.pr) + '" target="_blank">PR</a>' : "") +
              "<br>" + esc(it.description) + "</div>";
          }}).join("");
      }})
      .catch(function () {{ histResult.textContent = t("historyFailed"); }});
  }}
  document.getElementById("histGo").onclick = loadHistory;
  histContact.addEventListener("keydown", function (ev) {{ if (ev.key === "Enter") loadHistory(); }});
  if (q.get("focus") === "history" || q.get("contact")) {{
    document.getElementById("historyBox").open = true;
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
    use super::*;

    fn sample() -> Submission {
        Submission {
            description: "  Tab 面板不显示  ".into(),
            contact: "10001".into(),
            version: "0.4.11".into(),
            sysinfo: "windows x86_64".into(),
            channel: "desktop".into(),
            anon_id: "anon-1".into(),
            file_name: Some("wowsp.zip".into()),
            file_bytes: Some(b"PK".to_vec()),
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
        s.file_bytes = Some(vec![0u8; FILE_MAX + 1]);
        assert_eq!(normalize(&mut s), Err("file_too_large"));

        let mut s = sample();
        s.file_name = Some("payload.exe".into());
        assert_eq!(normalize(&mut s), Err("bad_file_type"));

        // No file at all is fine.
        let mut s = sample();
        s.file_name = None;
        s.file_bytes = None;
        assert!(normalize(&mut s).is_ok());
    }

    #[test]
    fn normalize_sanitizes_the_filename() {
        // The name rides an outbound Content-Disposition line: quotes and
        // CR/LF must go, absurd length must clamp WITHOUT losing the
        // extension (the ext verdict must apply to the FINAL name).
        let mut s = sample();
        s.file_name = Some("日志\"evil\r\n.zip".into());
        assert!(normalize(&mut s).is_ok());
        assert_eq!(s.file_name.as_deref(), Some("日志evil.zip"));

        let mut s = sample();
        s.file_name = Some(format!("{}.zip", "x".repeat(FILENAME_MAX + 50)));
        assert!(normalize(&mut s).is_ok());
        let capped = s.file_name.as_deref().unwrap();
        assert!(capped.chars().count() <= FILENAME_MAX, "{capped}");
        assert!(capped.ends_with(".zip"), "extension survives the cap");

        // An extension that only exists before sanitization/truncation
        // cannot sneak through: the verdict uses the final name.
        let mut s = sample();
        s.file_name = Some("no-ext".into());
        s.file_bytes = Some(b"x".to_vec());
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
            attachment_update_body("ftok").pointer("/fields/日志包/0/file_token"),
            Some(&json!("ftok"))
        );
        let schema = table_schema();
        let names: Vec<&str> = schema["table"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["field_name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 10);
        assert!(names.contains(&F_LOG));
        assert!(names.contains(&F_STATUS));
    }

    #[test]
    fn turnstile_shapes() {
        let body = turnstile_verify_body("s", "tok", "1.2.3.4");
        assert!(body.contains("secret=s") && body.contains("response=tok"));
        assert!(turnstile_passed(&json!({ "success": true })));
        assert!(!turnstile_passed(&json!({ "success": false, "error-codes": ["invalid-input-response"] })));
        assert!(!turnstile_passed(&json!({})));
        assert!(valid_sitekey("0x4AAAAAAAabc123-_"));
        assert!(!valid_sitekey(""));
        assert!(!valid_sitekey("bad key\" onclick"));
    }

    #[test]
    fn rate_keys_use_integer_buckets() {
        let [a, b, c] = rate_keys("1.2.3.4", "anon", "", 0)
            .try_into()
            .unwrap();
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
        s.file_name = Some("shot.png".into());
        s.file_bytes = Some(vec![0u8; 5 * 1024 * 1024]);
        assert!(normalize(&mut s).is_ok());

        let mut s = sample();
        s.file_name = Some("logs.zip".into());
        s.file_bytes = Some(vec![0u8; 5 * 1024 * 1024]);
        assert_eq!(normalize(&mut s), Err("file_too_large"));

        // A 12 MB webm recording passes (video cap 18 MB).
        let mut s = sample();
        s.file_name = Some("rec.webm".into());
        s.file_bytes = Some(vec![0u8; 12 * 1024 * 1024]);
        assert!(normalize(&mut s).is_ok());
    }

    #[test]
    fn feedback_page_injects_the_widget_or_maintenance() {
        let with = feedback_page(Some("0x4AAAAsitekey"), "https://wowsp.langyo.xyz");
        assert!(with.contains("0x4AAAAsitekey"));
        assert!(with.contains("challenges.cloudflare.com/turnstile"));
        assert!(with.contains("/api/feedback/submit"));
        assert!(!with.contains("id=\"submit\" disabled"));

        let maint = feedback_page(None, "https://wowsp.langyo.xyz");
        assert!(!maint.contains("challenges.cloudflare.com"));
        assert!(maint.contains("maintenance"));
        assert!(maint.contains("id=\"submit\" disabled"));

        // A hostile sitekey value is refused (falls back to maintenance).
        let bad = feedback_page(Some("x\" onload=alert(1)"), "https://wowsp.langyo.xyz");
        assert!(!bad.contains("onload=alert"));
    }

    #[test]
    fn erp_page_references_the_admin_apis() {
        let page = erp_page("https://wowsp.langyo.xyz");
        assert!(page.contains("/api/feedback/list"));
        assert!(page.contains("/api/feedback/update"));
        assert!(page.contains("X-Admin-Key"));
    }
}
