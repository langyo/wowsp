//! QQ 机器人接入的 worker 壳：webhook 回调（自报绑定 + 进度查询）与
//! 受理/结果通知。策略与解析都在 relay_core::qqbot；提交反馈不再要求
//! 任何验证，绑定只服务于回访通知与查询。

use crate::feedback::{history_records, http_call, json_headers};
use relay_core::qqbot::{self, Binding, CallbackEvent, Command};
use serde_json::{Value, json};
use worker::*;

const QQ_API: &str = "https://api.sgroup.qq.com";
const QQ_TOKEN_URL: &str = "https://bots.qq.com/app/getAppAccessToken";

/// AppID + Secret 就够：Ed25519 密钥按官方方案从 Secret 派生（wiki
/// event-emit.html / sign.html），控制台不下发单独的密钥对。
#[derive(Clone)]
struct Creds {
    #[allow(dead_code)]
    appid: String,
    secret: String,
}

fn creds(env: &Env) -> Option<Creds> {
    let appid = env.var("QQBOT_APPID").ok()?.to_string();
    let secret = env.var("QQBOT_SECRET").ok()?.to_string();
    Some(Creds { appid, secret })
}

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

fn yyyymm() -> String {
    qqbot::yyyymm(now_ms())
}

// ── access token（KV 缓存，TTL 留缓冲） ────────────────────────────────

async fn qq_token(env: &Env, c: &Creds) -> Result<String> {
    let kv = env.kv("FEEDBACK_KV")?;
    if let Some(cached) = kv.get(qqbot::K_TOKEN).text().await? {
        return Ok(cached);
    }
    let body = json!({ "appId": c.appid, "clientSecret": c.secret });
    let mut resp = http_call(
        Method::Post,
        QQ_TOKEN_URL,
        json_headers(None)?,
        Some(body.to_string().into_bytes()),
    )
    .await?;
    let v: Value = resp.json().await?;
    let token = v
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "qq token fetch failed".to_string())?
        .to_string();
    let ttl: u64 = v
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(7200)
        .saturating_sub(300)
        .max(60);
    kv.put(qqbot::K_TOKEN, &token)?
        .expiration_ttl(ttl)
        .execute()
        .await
        .ok();
    Ok(token)
}

async fn qq_http(env: &Env, c: &Creds, method: Method, url: &str, body: Value) -> Result<u16> {
    let token = qq_token(env, c).await?;
    let headers = json_headers(None)?;
    headers.set("Authorization", &format!("QQBot {token}"))?;
    let resp = http_call(method, url, headers, Some(body.to_string().into_bytes())).await?;
    let status = resp.status_code();
    if !(200..300).contains(&status) {
        worker::console_debug!("qq api {url} -> {status}");
    }
    Ok(status)
}

/// 发群消息（markdown，可带 msg_id 被动回复）。
async fn send_group(
    env: &Env,
    c: &Creds,
    group_openid: &str,
    markdown: &str,
    msg_id: Option<&str>,
) -> Result<()> {
    let mut payload = json!({ "msg_type": 2, "markdown": { "content": markdown } });
    if let Some(id) = msg_id {
        payload["msg_id"] = json!(id);
    }
    qq_http(
        env,
        c,
        Method::Post,
        &format!("{QQ_API}/v2/groups/{group_openid}/messages"),
        payload,
    )
    .await
    .map(|_| ())
}

/// 发私聊消息（纯文本，可带 msg_id 被动回复）。
async fn send_c2c(
    env: &Env,
    c: &Creds,
    openid: &str,
    content: &str,
    msg_id: Option<&str>,
) -> Result<()> {
    let mut payload = json!({ "msg_type": 0, "content": content });
    if let Some(id) = msg_id {
        payload["msg_id"] = json!(id);
    }
    qq_http(
        env,
        c,
        Method::Post,
        &format!("{QQ_API}/v2/users/{openid}/messages"),
        payload,
    )
    .await
    .map(|_| ())
}

// ── POST /api/qqbot/callback ───────────────────────────────────────────

pub async fn handle_callback(mut req: Request, env: &Env) -> Result<Response> {
    let Some(c) = creds(&env) else {
        return Response::error("qq bot not configured", 503);
    };
    let body = req.text().await?;
    let v: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return Response::error("bad json", 400),
    };
    match qqbot::parse_callback(&v) {
        CallbackEvent::Validation {
            plain_token,
            event_ts,
        } => match qqbot::validation_response(&c.secret, &plain_token, &event_ts) {
            Some(resp) => Response::from_json(&resp),
            None => Response::error("bad request", 400),
        },
        event => {
            // 事件推送必须验签（Secret 派生公钥）。
            // headers().get() -> Result<Option<String>, Error>
            let sig = req
                .headers()
                .get("X-Signature-Ed25519")
                .ok()
                .flatten()
                .unwrap_or_default();
            let ts = req
                .headers()
                .get("X-Signature-Timestamp")
                .ok()
                .flatten()
                .unwrap_or_default();
            if sig.is_empty()
                || ts.is_empty()
                || !qqbot::verify_event_signature(&c.secret, &ts, body.as_bytes(), &sig)
            {
                return Response::error("bad signature", 401);
            }
            handle_event(env, &c, event).await?;
            Response::from_json(&json!({ "ok": true }))
        },
    }
}

async fn handle_event(env: &Env, c: &Creds, event: CallbackEvent) -> Result<()> {
    let kv = env.kv("FEEDBACK_KV")?;
    match event {
        CallbackEvent::GroupMessage {
            group_openid,
            member_openid,
            msg_id,
            content,
        } => {
            let incoming = Binding {
                contact: String::new(),
                member_openid,
                group_openid,
                c2c_openid: String::new(),
                bound_at: now_ms(),
            };
            reply_to_command(env, c, &kv, &content, &msg_id, incoming, true).await
        },
        CallbackEvent::C2cMessage {
            user_openid,
            msg_id,
            content,
        } => {
            let incoming = Binding {
                contact: String::new(),
                c2c_openid: user_openid,
                bound_at: now_ms(),
                ..Default::default()
            };
            reply_to_command(env, c, &kv, &content, &msg_id, incoming, false).await
        },
        _ => Ok(()),
    }
}

/// 命令处理：自报绑定（群消息补 member/group openid，私聊补 c2c openid）与进度查询。
/// 回复一律走被动（带 msg_id），不消耗主动消息配额。
async fn reply_to_command(
    env: &Env,
    c: &Creds,
    kv: &KvStore,
    content: &str,
    msg_id: &str,
    incoming: Binding,
    from_group: bool,
) -> Result<()> {
    let member_openid = incoming.member_openid.clone();
    let group_openid = incoming.group_openid.clone();
    let c2c_openid = incoming.c2c_openid.clone();
    let reply = move |text: String| {
        let (env, c, member, group, c2c, msg_id, from_group) = (
            env.clone(),
            c.clone(),
            member_openid.clone(),
            group_openid.clone(),
            c2c_openid.clone(),
            msg_id.to_string(),
            from_group,
        );
        async move {
            if from_group {
                send_group(
                    &env,
                    &c,
                    &group,
                    &qqbot::group_at_markdown(&member, &text),
                    Some(&msg_id),
                )
                .await
            } else {
                send_c2c(&env, &c, &c2c, &text, Some(&msg_id)).await
            }
        }
    };
    match qqbot::parse_command(content) {
        Command::Bind(contact) => {
            let merged = kv
                .get(&qqbot::bind_key(&contact))
                .json::<Binding>()
                .await
                .ok()
                .flatten()
                .unwrap_or_default()
                .merge(Binding {
                    contact: contact.clone(),
                    ..incoming
                });
            kv.put(&qqbot::bind_key(&contact), &merged)?
                .execute()
                .await?;
            reply(qqbot::bind_ok_reply(&contact)).await
        },
        Command::Status => {
            // 反查 openid → 联系方式，再借反馈管线拉最新记录。
            let mut bindings = serde_json::Map::new();
            // KV 分页每页 100 条——绑定表超出后仍要能反查到。
            let mut cursor: Option<String> = None;
            loop {
                let mut q = kv.list().prefix(qqbot::K_BIND.to_string());
                if let Some(c) = cursor.as_deref() {
                    q = q.cursor(c.to_string());
                }
                let page = q.execute().await?;
                for item in page.keys {
                    if let Ok(Some(v)) = kv.get(&item.name).json::<Binding>().await {
                        bindings.insert(item.name, serde_json::to_value(v).unwrap_or(Value::Null));
                    }
                }
                if page.list_complete {
                    break;
                }
                cursor = page.cursor.clone();
            }
            let openid = if from_group {
                incoming.member_openid.as_str()
            } else {
                incoming.c2c_openid.as_str()
            };
            match qqbot::contact_of_binding(&bindings, openid) {
                Some(contact) => {
                    let items = history_records(env, &contact).await.unwrap_or_default();
                    if items.is_empty() {
                        reply("还没有查到你的反馈记录。".to_string()).await
                    } else {
                        let lines: Vec<String> = items
                            .iter()
                            .take(5)
                            .map(|it| {
                                format!(
                                    "· {} — {}",
                                    it.get("description")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .chars()
                                        .take(18)
                                        .collect::<String>(),
                                    it.get("status").and_then(Value::as_str).unwrap_or("?")
                                )
                            })
                            .collect();
                        reply(format!("最近的反馈：\n{}", lines.join("\n"))).await
                    }
                },
                None => {
                    reply("尚未绑定：发送“绑定 你的QQ号”后即可查询进度并接收回访通知。".to_string())
                        .await
                },
            }
        },
        Command::None => reply(qqbot::help_reply().to_string()).await,
    }
}

// ── 通知（反馈管线调用） ──────────────────────────────────────────────

/// 受理通知：仅私聊（月配额内的自限额）；群配额留给处理结果。
pub async fn notify_accepted(env: &Env, contact: &str, head: &str) -> Result<()> {
    let Some(c) = creds(env) else {
        return Ok(());
    };
    if !qqbot::contact_is_qq(contact) {
        return Ok(());
    }
    let kv = env.kv("FEEDBACK_KV")?;
    let Some(b) = kv
        .get(&qqbot::bind_key(contact))
        .json::<Binding>()
        .await
        .ok()
        .flatten()
    else {
        return Ok(());
    };
    // 仅私聊：群主动消息配额（约 4 条/月）留给「已开PR」的群内 @。
    // 未私聊过机器人（无 c2c openid）或月配额用尽则静默跳过——用户可
    // 随时在群里 @机器人 发「查询」被动获取状态。
    if b.c2c_openid.is_empty() || !dm_budget(&kv, contact).await? {
        return Ok(());
    }
    let text = qqbot::accepted_markdown(head);
    send_c2c(env, &c, &b.c2c_openid, &text, None).await?;
    Ok(())
}

/// 处理结果通知：已开PR → 群 @（bug 修复的群内单独 at）；其余 → 私聊
/// （无 c2c 绑定回退群 @）。
pub async fn notify_status(env: &Env, contact: &str, status: &str, pr: &str) -> Result<()> {
    let Some(c) = creds(env) else {
        return Ok(());
    };
    if !qqbot::contact_is_qq(contact) {
        return Ok(());
    }
    let kv = env.kv("FEEDBACK_KV")?;
    let Some(b) = kv
        .get(&qqbot::bind_key(contact))
        .json::<Binding>()
        .await
        .ok()
        .flatten()
    else {
        return Ok(());
    };
    let text = qqbot::status_markdown(status, pr);
    if status == "已开PR" || b.c2c_openid.is_empty() || !dm_budget(&kv, contact).await? {
        if b.group_verified() {
            send_group(
                env,
                &c,
                &b.group_openid,
                &qqbot::group_at_markdown(&b.member_openid, &text),
                None,
            )
            .await?;
        }
        return Ok(());
    }
    send_c2c(env, &c, &b.c2c_openid, &text, None).await?;
    Ok(())
}

/// C2C 主动消息的自限额（qqdm:{contact}:{月}，平台 4 条/人/月留余量）。
async fn dm_budget(kv: &KvStore, contact: &str) -> Result<bool> {
    let key = qqbot::dm_key(contact, &yyyymm());
    let used: u64 = kv.get(&key).json::<u64>().await.ok().flatten().unwrap_or(0);
    if used >= qqbot::DM_MONTHLY_CAP {
        return Ok(false);
    }
    kv.put(&key, used + 1)?
        .expiration_ttl(2_678_400)
        .execute()
        .await?;
    Ok(true)
}
