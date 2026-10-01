//! QQ 官方机器人（QQ 开放平台 q.qq.com）接入的纯策略层。
//!
//! 平台的硬约束决定了这里的形状（2026-10 调研，官方 bot.q.qq.com 文档）：
//! - 用户一律以 `openid`/`member_openid` 标识，与 QQ 号之间**没有任何
//!   官方互换接口**（unionid 也只是同主体跨应用标识）；
//! - 普通 QQ 群不向机器人开放成员列表/按号查成员（频道接口需私域权限，
//!   且返回的仍是平台 ID）。
//!   因此机器人侧的“绑定”是**自报联系方式**：用户在群里 @机器人 或私聊
//!   发送「绑定 QQ号」，回调（`GROUP_AT_MESSAGE_CREATE` /
//!   `C2C_MESSAGE_CREATE`）给出对应 openid，与号码合并进绑定记录。
//!   提交反馈不要求绑定——绑定只服务于回访通知与进度查询。
//! - 配额：C2C 主动消息约 4 条/人/月、群主动消息约 4 条/群/月；带
//!   `msg_id` 的被动回复（群 5 分钟/单聊 60 分钟窗口）不限量。主动
//!   通知一律尽力而为（失败静默），进度查询走“用户 @机器人”的被动回复。
//!
//! 本模块不含任何 Cloudflare/HTTP 类型：验签、回调解析、命令解析、
//! 绑定 KV 形状、消息文案组装都在这里单测；worker 壳只做 IO。

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// KV 键：机器人 access_token 缓存（FEEDBACK_KV）。
pub const K_TOKEN: &str = "qq:token";
/// KV 键前缀：联系方式 → 绑定的 openid 组合（长期）。
pub const K_BIND: &str = "qqbind:";
/// KV 键前缀：C2C 主动消息的自限额计数（qqdm:{contact}:{yyyymm}）。
pub const K_DM: &str = "qqdm:";

/// C2C 主动消息每月自限额（平台 4 条/人/月，自家计数留 1 条余量）。
pub const DM_MONTHLY_CAP: u64 = 3;

/// 表单联系方式的 QQ 判定：5–11 位纯数字。
pub fn contact_is_qq(contact: &str) -> bool {
    let n = contact.trim();
    (5..=11).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit())
}

pub fn bind_key(contact: &str) -> String {
    format!("{K_BIND}{}", contact.trim())
}

pub fn dm_key(contact: &str, yyyymm: &str) -> String {
    format!("{K_DM}{}:{yyyymm}", contact.trim())
}

/// 毫秒时间戳 → “yyyymm”（东八区，民用历法；KV 键用）。
pub fn yyyymm(now_ms: i64) -> String {
    // 东八区日期；days = floor((ms + 8h) / 86400s)。
    let days = (now_ms / 1000 + 8 * 3600).div_euclid(86_400);
    // Howard Hinnant 的 civil_from_days。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}")
}

/// 绑定记录：自报联系方式 + 三路 openid 按事件来源增量合并（群消息给
/// member/group，私聊给 c2c），从不互相覆盖。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    /// 表单里填写的 QQ 号（用户自报，绑定动作即证明）。
    pub contact: String,
    /// 群内成员 openid（群 @ 消息事件给出）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub member_openid: String,
    /// 群 openid（群 @ 消息事件给出）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub group_openid: String,
    /// 私聊 openid（私聊事件给出；@ 通知与私信是两个 id 空间）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub c2c_openid: String,
    #[serde(default)]
    pub bound_at: i64,
}

impl Binding {
    /// 群通知可达的最低条件：群消息事件到过（绑定过群 openid）。
    pub fn group_verified(&self) -> bool {
        !self.member_openid.is_empty() && !self.group_openid.is_empty()
    }

    /// 事件合并（已有值优先保留，新来源补空）。
    pub fn merge(self, other: Binding) -> Binding {
        Binding {
            contact: if self.contact.is_empty() {
                other.contact
            } else {
                self.contact
            },
            member_openid: if self.member_openid.is_empty() {
                other.member_openid
            } else {
                self.member_openid
            },
            group_openid: if self.group_openid.is_empty() {
                other.group_openid
            } else {
                self.group_openid
            },
            c2c_openid: if self.c2c_openid.is_empty() {
                other.c2c_openid
            } else {
                self.c2c_openid
            },
            bound_at: other.bound_at.max(self.bound_at),
        }
    }
}

// ── Webhook：URL 校验（op 13/14）与事件验签 ────────────────────────────

/// hex 解码（大小写容忍；容忍控制台拷贝常见的空白与 0x 前缀）。
fn unhex(raw: &str) -> Option<Vec<u8>> {
    let s: String = raw
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 平台官方方案（wiki event-emit.html / sign.html）：Ed25519 种子不由
/// 控制台下发，而是把机器人 Secret 重复翻倍到 ≥32 字节后取前 32 字节。
fn expand_seed(secret: &str) -> [u8; 32] {
    let mut seed: Vec<u8> = secret.as_bytes().to_vec();
    if seed.is_empty() {
        return [0u8; 32];
    }
    while seed.len() < 32 {
        let dup = seed.clone();
        seed.extend_from_slice(&dup);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&seed[..32]);
    out
}

fn signing_key(secret: &str) -> SigningKey {
    SigningKey::from_bytes(&expand_seed(secret))
}

/// 回调 URL 配置校验（op 13）：对 `event_ts + plain_token` 用 Secret 派生
/// 的 Ed25519 私钥签名，回 op 14。
pub fn validation_response(secret: &str, plain_token: &str, event_ts: &str) -> Option<Value> {
    let msg = format!("{event_ts}{plain_token}");
    let sig = signing_key(secret).sign(msg.as_bytes());
    // 官方示例的应答体是扁平的两字段（无 op/d 信封）——平台按此解析。
    Some(json!({
        "plain_token": plain_token,
        "signature": hex(&sig.to_bytes()),
    }))
}

/// 事件推送验签：`X-Signature-Ed25519`（hex）是对
/// `timestamp 字节串 + 原始 body` 的 Ed25519 签名，用同一 Secret 派生
/// 的公钥校验。
pub fn verify_event_signature(secret: &str, timestamp: &str, body: &[u8], sig_hex: &str) -> bool {
    let Some(sig_bytes) = unhex(sig_hex) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    let verifying = signing_key(secret).verifying_key();
    let mut msg = timestamp.as_bytes().to_vec();
    msg.extend_from_slice(body);
    verifying.verify(&msg, &sig).is_ok()
}

// ── 回调解析与命令解析 ─────────────────────────────────────────────────

/// 平台推送里我们关心的那一小簇事件。
#[derive(Debug, Clone, PartialEq)]
pub enum CallbackEvent {
    /// op 13：回调地址配置校验。
    Validation {
        plain_token: String,
        event_ts: String,
    },
    /// 群 @ 消息（member/group openid，自报绑定的群内来源）。
    GroupMessage {
        group_openid: String,
        member_openid: String,
        msg_id: String,
        content: String,
    },
    /// 私聊消息（c2c openid）。
    C2cMessage {
        user_openid: String,
        msg_id: String,
        content: String,
    },
    /// 其余（心跳/RESUMED/不关心的事件）。
    Other,
}

/// 解析平台回调 JSON。op 13 走 validation；op 0 按事件类型分发。
pub fn parse_callback(body: &Value) -> CallbackEvent {
    let op = body.get("op").and_then(Value::as_u64).unwrap_or(0);
    if op == 13 {
        let d = body.get("d").cloned().unwrap_or(Value::Null);
        return CallbackEvent::Validation {
            plain_token: d
                .get("plain_token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            event_ts: d
                .get("event_ts")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        };
    }
    if op != 0 {
        return CallbackEvent::Other;
    }
    let d = body.get("d").cloned().unwrap_or(Value::Null);
    let ty = d.get("t").and_then(Value::as_str).unwrap_or("");
    let data = d.get("d").cloned().unwrap_or(Value::Null);
    match ty {
        "GROUP_AT_MESSAGE_CREATE" => CallbackEvent::GroupMessage {
            group_openid: data
                .get("group_openid")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            member_openid: data
                .get("author")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            msg_id: data
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            // 群 @ 消息的 content 已被平台剥掉 @ 前缀，含两端空格。
            content: data
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        },
        "C2C_MESSAGE_CREATE" => CallbackEvent::C2cMessage {
            user_openid: data
                .get("author")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            msg_id: data
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            content: data
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        },
        _ => CallbackEvent::Other,
    }
}

/// 群/私聊里用户可用的命令。
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// 验证/绑定/verify/bind + 5–11 位 QQ 号（自报联系方式，用于
    /// 回访通知与进度查询；提交反馈不要求绑定）。
    Bind(String),
    /// 查询/进度/status：查自己反馈的处理状态（被动回复，不耗配额）。
    Status,
    None,
}

/// 从消息文本解析命令。容忍大小写、斜杠前缀与多余空白。
pub fn parse_command(content: &str) -> Command {
    let text = content.trim();
    let lower = text.to_lowercase();
    let has_word = ["验证", "绑定", "verify", "bind"]
        .iter()
        .any(|w| lower.contains(w));
    if has_word {
        // 收取消息里的全部数字：恰好是合法 QQ 号（5–11 位）即绑定。
        let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
        if contact_is_qq(&digits) {
            return Command::Bind(digits);
        }
    }
    if ["查询", "进度", "状态", "status"]
        .iter()
        .any(|w| lower.contains(w))
    {
        return Command::Status;
    }
    Command::None
}

// ── 消息文案 ───────────────────────────────────────────────────────────

/// 群消息里 @ 某成员的 Markdown 片段。
pub fn group_at_markdown(member_openid: &str, text: &str) -> String {
    format!("<@{member_openid}> {text}")
}

/// 受理通知（提交成功后）。
pub fn accepted_markdown(head: &str) -> String {
    format!("✅ 你的反馈已受理：{head}")
}

/// 处理结果通知（状态更新后）。`pr` 为已开 PR 的链接。
pub fn status_markdown(status: &str, pr: &str) -> String {
    let pr_part = if pr.is_empty() {
        String::new()
    } else {
        format!("\nPR：{pr}")
    };
    format!("📣 反馈处理结果：{status}{pr_part}")
}

/// 机器人被动回复的绑定成功文案。
pub fn bind_ok_reply(contact: &str) -> String {
    format!(
        "✅ 已绑定 {contact}。之后可随时发“查询”看处理进度；需要进一步确认时，管理员会通过私聊联系你。"
    )
}

/// 机器人被动回复的帮助文案。
pub fn help_reply() -> &'static str {
    "用法：发送“绑定 你的QQ号”接收回访通知（进群后 @机器人 发送同样有效）；发送“查询”查看自己的反馈进度。"
}

/// 从绑定表（KV 全量 qqbind:* 值）反查 openid 所属的联系 QQ。
pub fn contact_of_binding(bindings: &Map<String, Value>, openid: &str) -> Option<String> {
    bindings
        .iter()
        .find(|(_, v)| {
            let b = serde_json::from_value::<Binding>((*v).clone());
            matches!(b, Ok(ref x) if x.member_openid == openid || x.c2c_openid == openid)
        })
        .map(|(k, _)| k.trim_start_matches(K_BIND).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_pair() -> (String, String) {
        // 固定测试种子；公钥从私钥推导，模拟控制台给的一对密钥。
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let seed = hex(&key.to_bytes());
        let pubhex = hex(key.verifying_key().as_bytes());
        (seed, pubhex)
    }

    #[test]
    fn validation_signature_matches_official_recipe() {
        // 官方 Go 示例：seed = secret 翻倍到 32 字节；msg = event_ts + plain_token。
        let secret = "DG5g3B4j9X2KOErG"; // wiki 示例用的 16 字节短 secret
        let resp = validation_response(secret, "plain-abc", "1690000000").unwrap();
        assert_eq!(resp["plain_token"], "plain-abc");
        let sig = resp["signature"].as_str().unwrap();
        // 用同一派生公钥能验开。
        let verifying = signing_key(secret).verifying_key();
        let msg = b"1690000000plain-abc";
        assert!(
            verifying
                .verify(msg, &Signature::from_slice(&unhex(sig).unwrap()).unwrap())
                .is_ok()
        );
        // 换一个 secret 就不该验开。
        let other = signing_key("another-secret-1234").verifying_key();
        assert!(
            other
                .verify(msg, &Signature::from_slice(&unhex(sig).unwrap()).unwrap())
                .is_err()
        );
    }

    #[test]
    fn expand_seed_doubles_short_secrets() {
        // 16 字节 secret → 重复一次 → 取前 32；32 字节 secret 原样。
        let s16 = b"0123456789abcdef";
        let mut want = Vec::from(s16);
        want.extend_from_slice(s16);
        assert_eq!(&expand_seed("0123456789abcdef")[..], &want[..]);
        let s32 = "0123456789abcdef0123456789abcdef";
        assert_eq!(&expand_seed(s32)[..], s32.as_bytes());
    }

    #[test]
    fn event_signature_verifies() {
        let secret = "mptx-test-secret-0123456789";
        let key = signing_key(secret);
        let body = br#"{"op":0}"#;
        let ts = "1690000123";
        let msg = [ts.as_bytes(), body].concat();
        let sig = hex(&key.sign(&msg).to_bytes());
        assert!(verify_event_signature(secret, ts, body, &sig));
        assert!(!verify_event_signature(
            secret,
            &format!("{ts}1"),
            body,
            &sig
        ));
        assert!(!verify_event_signature(secret, ts, b"tampered", &sig));
        assert!(!verify_event_signature("wrong-secret", ts, body, &sig));
        assert!(!verify_event_signature(secret, ts, body, "deadbeef"));
    }

    #[test]
    fn callback_shapes() {
        let v: Value =
            serde_json::from_str(r#"{"op":13,"d":{"plain_token":"pt","event_ts":"42"}}"#).unwrap();
        assert_eq!(
            parse_callback(&v),
            CallbackEvent::Validation {
                plain_token: "pt".into(),
                event_ts: "42".into()
            }
        );
        let v: Value = serde_json::from_str(
            r#"{"op":0,"d":{"t":"GROUP_AT_MESSAGE_CREATE","d":{
                "id":"msgid","group_openid":"G1","author":{"id":"M1"},
                "content":" 验证 123456 "}}}"#,
        )
        .unwrap();
        assert_eq!(
            parse_callback(&v),
            CallbackEvent::GroupMessage {
                group_openid: "G1".into(),
                member_openid: "M1".into(),
                msg_id: "msgid".into(),
                content: "验证 123456".into(),
            }
        );
        let v: Value = serde_json::from_str(
            r#"{"op":0,"d":{"t":"C2C_MESSAGE_CREATE","d":{
                "id":"m2","author":{"id":"U1"},"content":"查询"}}}"#,
        )
        .unwrap();
        assert_eq!(
            parse_callback(&v),
            CallbackEvent::C2cMessage {
                user_openid: "U1".into(),
                msg_id: "m2".into(),
                content: "查询".into(),
            }
        );
        assert_eq!(parse_callback(&json!({"op": 7})), CallbackEvent::Other);
    }

    #[test]
    fn commands() {
        assert_eq!(parse_command("验证 123456"), Command::Bind("123456".into()));
        assert_eq!(
            parse_command("/verify 654321"),
            Command::Bind("654321".into())
        );
        assert_eq!(parse_command("绑定 000000"), Command::Bind("000000".into()));
        assert_eq!(parse_command("/bind 10001"), Command::Bind("10001".into()));
        // 4 位 / 12 位都不是合法 QQ 号，不触发绑定。
        assert_eq!(parse_command("绑定 1234"), Command::None);
        assert_eq!(parse_command("绑定 123456789012"), Command::None);
        assert_eq!(parse_command("查询"), Command::Status);
        assert_eq!(parse_command(" 查询进度 "), Command::Status);
        assert_eq!(parse_command("status"), Command::Status);
        assert_eq!(parse_command("你好"), Command::None);
    }

    #[test]
    fn qq_contact_detection() {
        assert!(contact_is_qq("10001"));
        assert!(contact_is_qq(" 123456789 "));
        assert!(!contact_is_qq("1234"));
        assert!(!contact_is_qq("123456789012"));
        assert!(!contact_is_qq("a@b.c"));
    }

    #[test]
    fn binding_merge_and_keys() {
        let group = Binding {
            contact: "10001".into(),
            member_openid: "M".into(),
            group_openid: "G".into(),
            ..Default::default()
        };
        assert!(group.group_verified());
        let c2c = Binding {
            contact: "10001".into(),
            c2c_openid: "U".into(),
            bound_at: 99,
            ..Default::default()
        };
        assert!(!c2c.group_verified());
        let merged = group.merge(c2c);
        assert!(merged.group_verified());
        assert_eq!(merged.c2c_openid, "U");
        assert_eq!(merged.bound_at, 99);
        assert_eq!(bind_key(" 10001 "), "qqbind:10001");
        assert_eq!(dm_key("10001", "202610"), "qqdm:10001:202610");
    }

    #[test]
    fn yyyymm_matches_utc8_civil_dates() {
        assert_eq!(yyyymm(0), "197001"); // 1970-01-01 08:00 +08
        assert_eq!(yyyymm(1_728_000_000_000), "202410"); // 2024-10-04 UTC
        assert_eq!(yyyymm(1_767_225_599_000), "202601"); // 2025-12-31 23:59:59 UTC
        assert_eq!(yyyymm(1_767_225_600_000), "202601"); // 2026-01-01 00:00 UTC
    }

    #[test]
    fn markdown_shapes() {
        assert_eq!(group_at_markdown("M1", "hi"), "<@M1> hi");
        assert!(accepted_markdown("Tab 面板不显示").contains("已受理"));
        assert_eq!(
            status_markdown("已开PR", "https://pr"),
            "📣 反馈处理结果：已开PR\nPR：https://pr"
        );
        assert_eq!(status_markdown("无需修复", ""), "📣 反馈处理结果：无需修复");
    }

    #[test]
    fn binding_reverse_lookup() {
        let mut m = Map::new();
        m.insert(
            "qqbind:10001".into(),
            json!({
                "contact": "10001", "member_openid": "M1", "group_openid": "G"
            }),
        );
        m.insert(
            "qqbind:20002".into(),
            json!({
                "contact": "20002", "c2c_openid": "U2"
            }),
        );
        assert_eq!(contact_of_binding(&m, "M1"), Some("10001".into()));
        assert_eq!(contact_of_binding(&m, "U2"), Some("20002".into()));
        assert_eq!(contact_of_binding(&m, "nope"), None);
    }
}
