//! Feedback pipeline policy: validation limits, Bitable field mapping,
//! Turnstile wire shapes, rate-limit key layout, one-time lookup tokens
//! (issued at submit, verified by hash — the contact is never a lookup
//! key). Pure and host-testable — the worker crate supplies fetch/KV/
//! clock I/O only. The `/feedback` and `/erp` PAGES live in the hikari
//! console (`packages/console`), served by the worker's assets layer —
//! nothing here renders HTML anymore.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::erp::ct_eq;

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

/// Read one field off the Feishu Bitable SINGLE-RECORD envelope family
/// (create / single-get / public-history responses all share it): the
/// record wraps under `/data/record`, so a field lives at
/// `/data/record/fields/<name>`.
///
/// Pins the #1351 fix: `record_contact` (the console update flow's
/// notification routing) used to read the TOP-LEVEL `/fields/<name>`,
/// which never exists on this envelope — the lookup returned None for
/// every record and `notify_status` never routed a single follow-up
/// notification. The sibling witnesses are the submit flow's
/// `/data/record/record_id` parse and the public history walk — both
/// production-proven against the same envelope shape.
pub fn record_field<'a>(v: &'a Value, field: &str) -> Option<&'a Value> {
    v.pointer(&format!("/data/record/fields/{field}"))
}

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
/// Description snippet length in public history rows (limits what a
/// leaked lookup token exposes through the lookup endpoint).
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
        // Store the canonical form: it is the maintainer's business AND the
        // exact string the bot's 查询 filter (and the token-resolved
        // history lookup) matches against.
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

// ── lookup tokens (audit M-7) ──────────────────────────────────────────

/// The submitter's progress-lookup credential: 32 bytes of CSPRNG, hex —
/// 64 chars. It is shown ONCE on the success page; only its SHA-256 is
/// ever stored. The contact stays a maintainer-only field (Bitable /
/// console) and is never a lookup key again.
pub const LOOKUP_TOKEN_BYTES: usize = 32;
/// Hex length of a lookup token.
pub const LOOKUP_TOKEN_LEN: usize = LOOKUP_TOKEN_BYTES * 2;
/// KV key prefix for the token-hash rows (`fbtok:{hash}`) in FEEDBACK_KV.
pub const LOOKUP_KV_PREFIX: &str = "fbtok:";
/// The `fbtok:*` rows outlive the review cycle — one year, Workers KV's
/// maximum `expiration_ttl` (the token dies with its row).
pub const LOOKUP_ROW_TTL_SECS: u64 = 31_536_000;

/// Shape gate for a presented lookup token: exactly 64 hex chars (either
/// case — callers normalize to lowercase before hashing).
pub fn valid_lookup_token(token: &str) -> bool {
    token.len() == LOOKUP_TOKEN_LEN && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// sha256hex of a lookup token — the only form ever persisted (the token
/// itself exists in exactly one place: the submit response the submitter
/// saw). Same digest shape as `replay::token_hash`.
pub fn lookup_token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    out
}

/// KV key for a stored token hash (`fbtok:{hash}`).
pub fn lookup_kv_key(hash: &str) -> String {
    format!("{LOOKUP_KV_PREFIX}{hash}")
}

/// The KV row under [`lookup_kv_key`]: the submission's canonical contact
/// (the exact string the Bitable's 联系方式 field carries) plus the stored
/// hash. The token itself is never persisted. `record_id` scopes the row
/// to the one Bitable record its token may read on the public history
/// path (audit M-7 revision); `contact` stays for the QQ bot's 绑定/
/// 回访通知 flow. Rows minted before the revision carry no `record_id`
/// (serde default) and resolve to nothing on the public path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LookupRow {
    pub contact: String,
    pub hash: String,
    #[serde(default)]
    pub record_id: Option<String>,
}

/// The shared hit test behind both resolvers: shape-gate the presented
/// token, hash it, and constant-time compare against the row's stored
/// hash (same hygiene rule as the session MAC). `false` on any mismatch
/// — unknown tokens and malformed rows refuse identically.
fn lookup_row_matches(row: Option<&Value>, token: &str) -> bool {
    let Some(row) = row else {
        return false;
    };
    let Some(stored) = row.get("hash").and_then(Value::as_str) else {
        return false;
    };
    if !valid_lookup_token(token) {
        return false;
    }
    let normalized = token.to_ascii_lowercase();
    ct_eq(&lookup_token_hash(&normalized), stored)
}

/// Resolve a presented lookup token against a fetched `fbtok:*` KV row
/// to the row's canonical contact — the QQ bot's 绑定 command's leg
/// (bind/回访通知 route by contact). `None` on any mismatch; the
/// public history endpoint no longer uses this leg (it resolves the
/// record via [`resolve_lookup_record`] instead — a token must never
/// hand out a whole contact's history).
pub fn resolve_lookup_token(row: Option<&Value>, token: &str) -> Option<String> {
    if !lookup_row_matches(row, token) {
        return None;
    }
    row?.get("contact")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
}

/// Resolve a presented lookup token to THE Bitable record it was minted
/// with (audit M-7 revision): a token proves "I submitted this record",
/// never "I am this contact" — the public history endpoint answers that
/// one record's status and nothing else. Legacy rows without a
/// `record_id` resolve to `None` (the endpoint answers the same empty
/// list as an unknown token, so nothing distinguishes them).
pub fn resolve_lookup_record(row: Option<&Value>, token: &str) -> Option<String> {
    if !lookup_row_matches(row, token) {
        return None;
    }
    row?.get("record_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The single-record envelope family, pinned (see [`record_field`]):
    /// the field read must hit `/data/record/fields/<name>`, the submit
    /// flow's record_id parse must hit the same record object, and the
    /// OLD top-level `/fields/<name>` shape must keep MISSING — that
    /// miss is exactly the #1351 regression being guarded against.
    #[test]
    fn single_record_envelope_field_read_is_pinned() {
        let v = json!({
            "code": 0,
            "msg": "success",
            "data": {
                "record": {
                    "record_id": "recWOWSP1351",
                    "fields": {
                        "联系方式": [{ "text": "13800000000" }],
                        "处理状态": "已开PR"
                    }
                }
            }
        });
        // The contact read the notification routing keys on.
        let contact = record_field(&v, F_CONTACT).and_then(Value::as_array);
        assert_eq!(
            contact.and_then(|a| a.first()).and_then(|t| t.get("text")),
            Some(&json!("13800000000"))
        );
        // Family witness: submit parses the record id off the SAME record.
        assert_eq!(
            v.pointer("/data/record/record_id"),
            Some(&json!("recWOWSP1351"))
        );
        // The pre-fix shape (fields at the top level) never exists on
        // this envelope — a read there must stay None forever.
        assert!(v.pointer(&format!("/fields/{F_CONTACT}")).is_none());
        // Missing record / missing field degrade to None (the caller
        // skips the notification rather than guessing).
        assert!(record_field(&v, "不存在的字段").is_none());
        assert!(record_field(&json!({ "code": 0, "data": {} }), F_CONTACT).is_none());
    }

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
    fn lookup_tokens_shape_hash_and_kv_key() {
        let tok = "a".repeat(LOOKUP_TOKEN_LEN);
        assert_eq!(tok.len(), 64);
        assert!(valid_lookup_token(&tok));
        // Either hex case passes the shape gate (callers normalize before
        // hashing); every other shape refuses.
        assert!(valid_lookup_token(&tok.to_ascii_uppercase()));
        assert!(!valid_lookup_token(&"a".repeat(63)));
        assert!(!valid_lookup_token(&"a".repeat(65)));
        assert!(!valid_lookup_token(&format!("{}g", "a".repeat(63))));
        assert!(!valid_lookup_token(""));

        // Reference vector: sha256("abc") = ba7816bf… (same digest shape
        // replay::token_hash mints for upload tokens).
        assert_eq!(
            lookup_token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Deterministic, 64 lowercase hex chars, and the KV key wraps it.
        let h = lookup_token_hash(&tok);
        assert_eq!(h.len(), 64);
        assert!(
            h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(lookup_token_hash(&tok), h);
        assert_eq!(lookup_kv_key(&h), format!("fbtok:{h}"));
    }

    #[test]
    fn resolve_lookup_token_gates_shape_hash_and_contact() {
        // The QQ bot's 绑定 and the public history lookup share this
        // resolver: hit requires a well-formed token whose hash equals
        // the stored one, plus a non-empty contact.
        let token = format!("{}{}", "0f".repeat(31), "ab");
        assert!(valid_lookup_token(&token));
        let row = json!({
            "contact": "10001",
            "hash": lookup_token_hash(&token),
        });
        assert_eq!(
            resolve_lookup_token(Some(&row), &token),
            Some("10001".into())
        );
        // Uppercase presentation normalizes to the same hash.
        assert_eq!(
            resolve_lookup_token(Some(&row), &token.to_ascii_uppercase()),
            Some("10001".into())
        );
        // Wrong token (well-formed but a different one) → miss.
        let other = format!("{}{}", "aa".repeat(31), "bb");
        assert_eq!(resolve_lookup_token(Some(&row), &other), None);
        // Malformed token → refuse, never panic.
        assert_eq!(resolve_lookup_token(Some(&row), &token[..63]), None);
        assert_eq!(resolve_lookup_token(Some(&row), ""), None);
        // Missing row / malformed row → refuse.
        assert_eq!(resolve_lookup_token(None, &token), None);
        assert_eq!(resolve_lookup_token(Some(&json!({})), &token), None);
        assert_eq!(
            resolve_lookup_token(Some(&json!({ "contact": "10001" })), &token),
            None
        );
        // A contact-less submission's row binds/looks up nothing.
        let anon_row = json!({
            "contact": "",
            "hash": lookup_token_hash(&token),
        });
        assert_eq!(resolve_lookup_token(Some(&anon_row), &token), None);
    }

    #[test]
    fn resolve_lookup_record_scopes_to_the_minting_submission() {
        // audit M-7 修订：凭证只证明「我提交过这一条」，不证明「我是这个
        // 联系方式」——公开历史查询按 record_id 解析，contact 永不出行。
        let token = format!("{}{}", "0e".repeat(31), "cd");
        let row = json!({
            "contact": "victim@example.com",
            "hash": lookup_token_hash(&token),
            "record_id": "recnW9X1zZ",
        });
        assert_eq!(
            resolve_lookup_record(Some(&row), &token),
            Some("recnW9X1zZ".into())
        );
        // 大小写归一化与 contact 变体同一套命中判定。
        assert_eq!(
            resolve_lookup_record(Some(&row), &token.to_ascii_uppercase()),
            Some("recnW9X1zZ".into())
        );
        // 哈希不匹配 / 行缺失 / 畸形行 → 一律 None。
        let other = format!("{}{}", "bb".repeat(31), "aa");
        assert_eq!(resolve_lookup_record(Some(&row), &other), None);
        assert_eq!(resolve_lookup_record(None, &token), None);
        assert_eq!(resolve_lookup_record(Some(&json!({})), &token), None);
        // 修订前的旧行（无 record_id）与空 record_id 都解析不到记录。
        let legacy = json!({
            "contact": "victim@example.com",
            "hash": lookup_token_hash(&token),
        });
        assert_eq!(resolve_lookup_record(Some(&legacy), &token), None);
        let empty = json!({
            "contact": "victim@example.com",
            "hash": lookup_token_hash(&token),
            "record_id": "",
        });
        assert_eq!(resolve_lookup_record(Some(&empty), &token), None);
        // 行的 LookupRow 序列化形态带上 record_id（提交侧写入的 JSON 形状）。
        let built = LookupRow {
            contact: "victim@example.com".into(),
            hash: lookup_token_hash(&token),
            record_id: Some("recnW9X1zZ".into()),
        };
        let v: Value = serde_json::to_value(&built).unwrap();
        assert_eq!(v["record_id"], "recnW9X1zZ");
        // 旧行 JSON（无 record_id 字段）仍能反序列化——兼容读取。
        let parsed: LookupRow = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.record_id, None);
        // 前向兼容（QQ 绑定腿）：部署后 submit 写出的唯一行形状就是
        // 「contact + record_id」——contact 变体必须在它上面照常命中，
        // 否则新凭证全部无法绑定且没有任何测试报警。
        assert_eq!(
            resolve_lookup_token(Some(&v), &token),
            Some("victim@example.com".into())
        );
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
}
