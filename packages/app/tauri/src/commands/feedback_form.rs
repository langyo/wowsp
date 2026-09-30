//! 内嵌反馈表单的命令面：原生截图（带回传预览）、multipart 提交与
//! QQ 进群验证代理。设置页的表单（FeedbackSection）不再跳浏览器——
//! 截图走 GDI 原生路径（不依赖 WebView 的 getDisplayMedia，老 WebView
//! 也不受影响），提交由 reqwest 直发 Cloudflare Worker。
//!
//! 桌面通道在 worker 侧免 Turnstile（控件域名锁定在 wowsp.langyo.xyz，
//! 无法在 Tauri WebView 内渲染）；IP/匿名/联系/全局 KV 限流与 QQ 进群
//! 门控照常生效，这里的滥用面与网页表单同级。

use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

use super::logs;
use super::network::build_http_client;
use super::pairing_relay::{BUILTIN_RELAY_ROOT_URL, RELAY_URL_ENV};
use super::screenshot::default_screenshot_path;

/// 反馈 Worker 根（开发可用 WOWSP_RELAY_URL 指向本地 wrangler）。
fn relay_root() -> String {
    std::env::var(RELAY_URL_ENV)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| BUILTIN_RELAY_ROOT_URL.into())
}

/// RFC 7578 multipart 构建（worker relay-core::multipart::build_seeded 的
/// 同构实现——不启用 reqwest 的 multipart 特性，少一条依赖边）。
fn multipart(parts: &[(&str, Option<&str>, Vec<u8>)]) -> (String, Vec<u8>) {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let boundary = format!("wowspfb{seed:016x}");
    let mut body = Vec::new();
    for (name, filename, bytes) in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match filename {
            Some(f) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n\r\n"
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            ),
        }
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (boundary, body)
}

/// 应用侧匿名 ID（worker 侧 ≤48 字符；hex 格式与网页端一致——网页端
/// 取 UUID 前 24 位，这里 16 字节熵编 32 hex，限流计数同口径）：
/// 数据目录下 feedback-anon.txt，一次生成长期复用——限流按它计数。
fn anon_id() -> Result<String, String> {
    let dir = crate::paths::ensure_data_dir()?;
    let path = dir.join("feedback-anon.txt");
    if let Ok(saved) = std::fs::read_to_string(&path) {
        let id = saved.trim().to_string();
        if !id.is_empty() && id.len() <= 48 {
            return Ok(id);
        }
    }
    let mut seed = [0u8; 16];
    getrandom::fill(&mut seed).map_err(|e| format!("os entropy: {e}"))?;
    let id = hex::encode(seed);
    std::fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

/// 原生全屏截图（复用反馈截图路径），并生成 ≤480px 的 base64 PNG
/// 预览供表单内缩略图展示；返回 { path, preview }。不再自动打开
/// 资源管理器——附件由表单直接携带。
#[tauri::command]
pub fn feedback_shot() -> Result<Value, String> {
    let path = default_screenshot_path()?
        .to_string_lossy()
        .replace("screenshot-", "feedback-shot-");
    let path = std::path::PathBuf::from(&path);
    super::screenshot::capture_screen_for_feedback(&path)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let preview = preview_png_base64(&bytes, 480)?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "preview": preview,
    }))
}

/// 缩到 `max` 像素内的 PNG base64（缩略图走 IPC，原图留在磁盘）。
fn preview_png_base64(png: &[u8], max: u32) -> Result<String, String> {
    let img = image::load_from_memory(png).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(max, max);
    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf.get_ref()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitArgs {
    pub description: String,
    #[serde(default)]
    pub contact: String,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub game_id: String,
    #[serde(default)]
    pub version: String,
    /// feedback_shot 返回的截图路径（存在即附带）。
    #[serde(default)]
    pub screenshot_path: Option<String>,
    /// 附上日志反馈包（zip，复用导出打包器）。
    #[serde(default)]
    pub attach_logs: bool,
}

/// 提交内嵌表单：multipart 直发 worker 的 /api/feedback/submit。
/// 成功返回记录链接；失败返回 worker 的错误码（前端按 e_* 映射文案），
/// 网络层失败统一为 "unreachable"。
#[tauri::command]
pub async fn feedback_submit(
    app: tauri::AppHandle,
    args: FeedbackSubmitArgs,
) -> Result<Value, String> {
    let anon = anon_id()?;
    let sysinfo = format!(
        "desktop {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let mut parts: Vec<(&str, Option<&str>, Vec<u8>)> = vec![
        ("description", None, args.description.clone().into_bytes()),
        ("contact", None, args.contact.clone().into_bytes()),
        ("server", None, args.server.clone().into_bytes()),
        ("game_id", None, args.game_id.clone().into_bytes()),
        ("version", None, args.version.clone().into_bytes()),
        ("sysinfo", None, sysinfo.into_bytes()),
        ("channel", None, b"desktop".to_vec()),
        ("anon", None, anon.into_bytes()),
    ];
    // 附件用 owned 文件名暂存，最后统一并入 parts（借用生存期简单）。
    let mut attachments: Vec<(String, Vec<u8>)> = Vec::new();
    if let Some(shot) = args.screenshot_path.as_deref().filter(|p| !p.is_empty()) {
        let bytes = std::fs::read(shot).map_err(|e| format!("screenshot unreadable: {e}"))?;
        let name = std::path::Path::new(shot)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("screenshot.png")
            .to_string();
        attachments.push((name, bytes));
    }
    if args.attach_logs {
        let zip_path = logs::logs_export_bundle(app.clone())?;
        let bytes = std::fs::read(&zip_path).map_err(|e| format!("log bundle unreadable: {e}"))?;
        let name = std::path::Path::new(&zip_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("logs.zip")
            .to_string();
        attachments.push((name, bytes));
    }
    for (name, bytes) in &attachments {
        parts.push(("file", Some(name.as_str()), bytes.clone()));
    }
    let (boundary, body) = multipart(&parts);
    let client = build_http_client()?;
    let resp = client
        .post(format!("{}/api/feedback/submit", relay_root()))
        .header("User-Agent", "WoWSP-feedback/1.0")
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|_| "unreachable".to_string())?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) && v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(serde_json::json!({
            "ok": true,
            "record_url": v.get("record_url").and_then(Value::as_str).unwrap_or(""),
        }))
    } else {
        Err(v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("upstream")
            .to_string())
    }
}

/// QQ 进群验证码签发（代理 worker，绕开 WebView 的 CORS 限制）。
#[tauri::command]
pub async fn feedback_qq_code(contact: String) -> Result<Value, String> {
    let client = build_http_client()?;
    let resp = client
        .post(format!("{}/api/feedback/qq/code", relay_root()))
        .json(&serde_json::json!({ "contact": contact }))
        .send()
        .await
        .map_err(|_| "unreachable".to_string())?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status == 200 {
        Ok(v)
    } else {
        Err(v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("upstream")
            .to_string())
    }
}

/// QQ 进群验证状态查询（代理 worker）。
#[tauri::command]
pub async fn feedback_qq_status(contact: String) -> Result<Value, String> {
    let client = build_http_client()?;
    let resp = client
        .get(format!(
            "{}/api/feedback/qq/status?contact={}",
            relay_root(),
            urlencoding_simple(&contact)
        ))
        .send()
        .await
        .map_err(|_| "unreachable".to_string())?;
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    Ok(v)
}

/// 最小 URL 查询转义（仅数字 QQ 号走这里；不引 urlencoding 依赖）。
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_frames_fields_and_files() {
        let (boundary, body) = multipart(&[
            ("description", None, b"hello".to_vec()),
            ("file", Some("shot.png"), vec![1, 2, 3]),
        ]);
        let text = String::from_utf8_lossy(&body).into_owned();
        assert!(text.starts_with(&format!("--{boundary}\r\n")));
        assert!(text.contains("name=\"description\"\r\n\r\nhello\r\n"));
        assert!(text.contains("filename=\"shot.png\"\r\n\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
        // 原始字节保真（文件体不经 lossy 路径）。
        assert!(body.windows(3).any(|w| w == [1u8, 2, 3]));
    }

    #[test]
    fn query_encoding_passes_digits_only() {
        assert_eq!(urlencoding_simple("12345"), "12345");
        assert_eq!(urlencoding_simple("a b"), "a%20b");
    }
}
