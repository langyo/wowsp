//! QQ 官方机器人（QQ 开放平台 q.qq.com）接入的纯策略层。
//!
//! 平台的硬约束决定了这里的形状（2026-10 调研，官方 bot.q.qq.com 文档）：
//! - 用户一律以 `openid`/`member_openid` 标识，与 QQ 号之间**没有任何
//!   官方互换接口**（unionid 也只是同主体跨应用标识）；
//! - 普通 QQ 群不向机器人开放成员列表/按号查成员（频道接口需私域权限，
//!   且返回的仍是平台 ID）。
//!   因此“按 QQ 号查是否在群”不可行——进群只能通过**交互证明**：表单发
//!   验证码，用户在群里 @机器人 发码，`GROUP_AT_MESSAGE_CREATE` 回调
//!   即同时给出 member_openid + group_openid 与“此人确在群里”的证明；
//!   私聊场景的 `C2C_MESSAGE_CREATE` 同理给出 c2c openid。
//! - 配额：C2C 主动消息约 4 条/人/月、群主动消息约 4 条/群/月；带
//!   `msg_id` 的被动回复（群 5 分钟/单聊 60 分钟窗口）不限量。主动
//!   通知一律尽力而为（失败静默），进度查询走“用户 @机器人”的被动回复。
//!
//! 本模块不含任何 Cloudflare/HTTP 类型：验签、回调解析、命令解析、
//! 验证码/绑定 KV 形状、消息文案组装都在这里单测；worker 壳只做 IO。

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// KV 键：机器人 access_token 缓存（FEEDBACK_KV）。
pub const K_TOKEN: &str = "qq:token";
/// KV 键前缀：验证码 → 联系方式（短 TTL）。
pub const K_CODE: &str = "qqcode:";
/// KV 键前缀：联系方式 → 绑定的 openid 组合（长期）。
pub const K_BIND: &str = "qqbind:";
/// KV 键前缀：C2C 主动消息的自限额计数（qqdm:{contact}:{yyyymm}）。
pub const K_DM: &str = "qqdm:";

/// 验证码有效期（秒）；KV TTL 下限 60s。
pub const CODE_TTL: u64 = 1_800;
/// 验证码长度（纯数字）。
pub const CODE_LEN: usize = 6;
/// C2C 主动消息每月自限额（平台 4 条/人/月，自家计数留 1 条余量）。
pub const DM_MONTHLY_CAP: u64 = 3;

/// 表单联系方式的 QQ 判定：5–11 位纯数字。
pub fn contact_is_qq(contact: &str) -> bool {
    let n = contact.trim();
    (5..=11).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit())
}

/// 验证码合法性（CODE_LEN 位数字）。
pub fn code_valid(code: &str) -> bool {
    code.len() == CODE_LEN && code.bytes().all(|b| b.is_ascii_digit())
}

pub fn code_key(code: &str) -> String {
    format!("{K_CODE}{code}")
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

/// 绑定记录：三路 openid 按事件来源增量合并（群消息给
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
    /// 进群验证成立的最低条件：群消息事件到过。
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

/// hex 解码（大小写容忍）。
fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
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

/// 回调 URL 配置校验（op 13）：对 `event_ts + plain_token` 用机器人的
/// Ed25519 私钥（种子，开放平台控制台给出）签名，回 op 14。
/// 种子 hex 非法时返回 None（worker 应答 503）。
pub fn validation_response(seed_hex: &str, plain_token: &str, event_ts: &str) -> Option<Value> {
    let seed = unhex(seed_hex)?;
    let key: SigningKey = SigningKey::from_bytes(&{
        // 种子既可能是 32 字节原文，也可能是 64 字节 (seed||pub) 形式。
        let mut s = [0u8; 32];
        if seed.len() == 64 {
            s.copy_from_slice(&seed[..32]);
        } else if seed.len() == 32 {
            s.copy_from_slice(&seed);
        } else {
            return None;
        }
        s
    });
    let msg = format!("{event_ts}{plain_token}");
    let sig = key.sign(msg.as_bytes());
    Some(json!({
        "op": 14,
        "d": { "plain_token": plain_token, "signature": hex(&sig.to_bytes()) }
    }))
}

/// 事件推送验签：`X-Signature-Ed25519` 是对
/// `timestamp 字节串 + 原始 body` 的 Ed25519 签名，用控制台公钥校验。
pub fn verify_event_signature(pub_hex: &str, timestamp: &str, body: &[u8], sig_hex: &str) -> bool {
    let (Some(pub_bytes), Some(sig_bytes)) = (unhex(pub_hex), unhex(sig_hex)) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_bytes(&{
        // 兼容既给 32 字节公钥、又给 64 字节 (pub||seed) 的控制台拷贝。
        let mut p = [0u8; 32];
        if pub_bytes.len() == 64 {
            p.copy_from_slice(&pub_bytes[..32]);
        } else if pub_bytes.len() == 32 {
            p.copy_from_slice(&pub_bytes);
        } else {
            return false;
        }
        p
    }) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
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
    /// 群 @ 消息（进群证明 + member/group openid）。
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
    /// 验证/绑定/verify + 6 位验证码。
    Verify(String),
    /// 查询/进度/status：查自己反馈的处理状态（被动回复，不耗配额）。
    Status,
    None,
}

/// 从消息文本解析命令。容忍大小写、斜杠前缀与多余空白。
pub fn parse_command(content: &str) -> Command {
    let text = content.trim();
    let lower = text.to_lowercase();
    let has_word = ["验证", "绑定", "verify"].iter().any(|w| lower.contains(w));
    if has_word {
        // 取最后一段连续数字，长度 6 才算码。
        let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
        if code_valid(&digits) {
            return Command::Verify(digits);
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

/// 机器人被动回复的验证成功文案。
pub fn verify_ok_reply() -> &'static str {
    "✅ 验证成功，该 QQ 已与反馈表单绑定。之后可随时发“查询”看处理进度。"
}

/// 机器人被动回复的帮助文案。
pub fn help_reply() -> &'static str {
    "用法：发送“验证 123456”绑定反馈表单的验证码；发送“查询”查看自己的反馈进度。"
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
    fn validation_signature_round_trips() {
        let (seed, pubhex) = seed_pair();
        let resp = validation_response(&seed, "plain-abc", "1690000000").unwrap();
        assert_eq!(resp["op"], 14);
        assert_eq!(resp["d"]["plain_token"], "plain-abc");
        let sig = resp["d"]["signature"].as_str().unwrap();
        let pb = unhex(&pubhex).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&pb);
        let verifying = VerifyingKey::from_bytes(&arr).unwrap();
        let msg = b"1690000000plain-abc";
        assert!(
            verifying
                .verify(msg, &Signature::from_slice(&unhex(sig).unwrap()).unwrap())
                .is_ok()
        );
        // 坏种子拒绝。
        assert!(validation_response("zz", "p", "t").is_none());
    }

    #[test]
    fn event_signature_verifies() {
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let pubhex = hex(key.verifying_key().as_bytes());
        let body = br#"{"op":0}"#;
        let ts = "1690000123";
        let msg = [ts.as_bytes(), body].concat();
        let sig = hex(&key.sign(&msg).to_bytes());
        assert!(verify_event_signature(&pubhex, ts, body, &sig));
        assert!(!verify_event_signature(
            &pubhex,
            &format!("{ts}1"),
            body,
            &sig
        ));
        assert!(!verify_event_signature(&pubhex, ts, b"tampered", &sig));
        assert!(!verify_event_signature(&pubhex, ts, body, "deadbeef"));
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
        assert_eq!(
            parse_command("验证 123456"),
            Command::Verify("123456".into())
        );
        assert_eq!(
            parse_command("/verify 654321"),
            Command::Verify("654321".into())
        );
        assert_eq!(
            parse_command("绑定 000000"),
            Command::Verify("000000".into())
        );
        assert_eq!(parse_command("验证 12345"), Command::None); // 5 位不算
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
        assert_eq!(code_key("123456"), "qqcode:123456");
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
