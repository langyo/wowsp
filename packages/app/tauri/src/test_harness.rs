//! Dev-only HTTP control server for external visual-regression testing.
//!
//! **This entire module is behind `#[cfg(feature = "test-harness")]` and is
//! NEVER compiled into release builds.** `cargo tauri build` does not pass
//! `--features test-harness`, so the control server cannot leak into shipped
//! binaries.
//!
//! When enabled, `main.rs` spawns this server on a background thread. It binds
//! a `127.0.0.1` TCP listener (port from `WOWSP_TEST_PORT`, or 0 = OS-chosen)
//! and serves a minimal HTTP/1.1 surface so an external Python script can
//! drive the running app:
//!
//!   GET  /health           → `{"ok":true}` (Python polls this to wait for ready)
//!   POST /eval  {"code":…} → eval JS in the webview, returns `{"ok":true}`
//!   POST /capture {"name":…} → screenshot to screenshots/<name>.png, returns `{"path":…}`
//!
//! No axum/hyper dependency — the request surface is tiny (3 endpoints, all
//! POST/GET), so a hand-rolled HTTP/1.1 parser keeps the dev-only feature
//! lightweight. The actual screenshot work delegates to the same
//! `capture_window_png` used by the `capture_main_window` Tauri command.

#![cfg(feature = "test-harness")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

use tauri::Manager;

use crate::commands::screenshot::{capture_window_png, default_screenshot_path};

/// Entry point: bind the listener, write the assigned port to a well-known
/// file so Python can discover it, then accept connections forever. Runs on
/// the calling thread (main.rs spawns a dedicated thread for this).
pub fn run(app: tauri::AppHandle) {
    let port: u16 = std::env::var("WOWSP_TEST_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(error = %e, port, "test-harness: failed to bind control server");
            return;
        }
    };

    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    // Publish the port to a file Python reads to discover where we landed
    // (especially when WOWSP_TEST_PORT=0 → OS-chosen random port).
    if let Err(e) = write_port_file(actual_port) {
        tracing::warn!(error = %e, "test-harness: could not write port file");
    }

    tracing::info!(port = actual_port, "test-harness: control server listening on 127.0.0.1");

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let app = app.clone();
                // Handle synchronously — the test driver is single-threaded
                // and sends requests sequentially, so no need for a thread
                // pool. Keeping it sync also avoids pulling in tokio here.
                let _ = std::thread::spawn(move || handle_connection(&mut stream, &app));
            }
            Err(e) => tracing::warn!(error = %e, "test-harness: accept failed"),
        }
    }
}

fn write_port_file(port: u16) -> std::io::Result<()> {
    let dir = dirs_next::data_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir"))?
        .join("WoWSP");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("test-harness-port"), port.to_string())
}

/// Parse one HTTP/1.1 request, dispatch, write one response. Returns when the
/// connection is done (one request per connection — Python's `requests` opens
/// a fresh connection per call, which is fine for our low request volume).
fn handle_connection(stream: &mut std::net::TcpStream, app: &tauri::AppHandle) {
    // Use a BufReader so we can read headers line-by-line, then read exactly
    // Content-Length bytes of body. A single raw read() can split between
    // headers and body (or return only partial body), which was causing the
    // "missing 'code' field" error — the body was being truncated.
    // Clone the stream so the BufReader owns its own handle (the caller still
    // holds `stream` for the response write).
    let read_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(read_stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let request_line = request_line.trim().to_string();

    // Read headers until blank line, capturing Content-Length.
    let mut content_length: usize = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return;
        }
        let trimmed = header.trim_end_matches(|c| c == '\r' || c == '\n');
        if trimmed.is_empty() {
            break; // end of headers
        }
        if let Some(rest) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }

    // Read exactly Content-Length bytes of body (may require multiple reads).
    let mut body = String::new();
    if content_length > 0 {
        let mut taken = reader.take(content_length as u64);
        if taken.read_to_string(&mut body).is_err() {
            return;
        }
    }

    let (status, resp_body) = route(&request_line, &body, app);
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{resp_body}",
        resp_body.len(),
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// Minimal router: match on method + path, return (status_line, json_body).
fn route(request_line: &str, body: &str, app: &tauri::AppHandle) -> (&'static str, String) {
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");

    match (method, path) {
        ("GET", "/health") => (OK, "{\"ok\":true}".into()),
        ("POST", "/eval") => handle_eval(app, body),
        ("POST", "/capture") => handle_capture(app, body),
        ("OPTIONS", _) => (OK, "{\"ok\":true}".into()), // CORS preflight
        _ => bad(&format!("unknown route: {method} {path}")),
    }
}

fn handle_eval(app: &tauri::AppHandle, body: &str) -> (&'static str, String) {
    let code = match json_string_field(body, "code") {
        Some(c) => c,
        None => return bad("missing 'code' field"),
    };
    let win = match app.get_webview_window("main") {
        Some(w) => w,
        None => return bad("main window not found"),
    };
    match win.eval(&code) {
        Ok(()) => (OK, "{\"ok\":true}".into()),
        Err(e) => bad(&format!("eval failed: {e}")),
    }
}

fn handle_capture(app: &tauri::AppHandle, body: &str) -> (&'static str, String) {
    let name = json_string_field(body, "name").unwrap_or_default();
    let out_path = if name.is_empty() {
        match default_screenshot_path() {
            Ok(p) => p,
            Err(e) => return bad(&format!("resolve screenshot dir: {e}")),
        }
    } else {
        // Save under <AppData>/WoWSP/screenshots/<name>.png so Python can
        // find them deterministically.
        let dir = match screenshots_dir() {
            Ok(d) => d,
            Err(e) => return bad(&format!("resolve screenshots dir: {e}")),
        };
        // Sanitize name: only allow alnum/dash/underscore (prevent path traversal).
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        dir.join(format!("{safe}.png"))
    };

    let win = match app.get_webview_window("main") {
        Some(w) => w,
        None => return bad("main window not found"),
    };
    match capture_window_png(&win, &out_path) {
        Ok(()) => {
            let path_str = out_path.to_string_lossy().replace('\\', "/");
            (OK, format!("{{\"path\":\"{path_str}\"}}"))
        }
        Err(e) => bad(&format!("capture failed: {e}")),
    }
}

fn screenshots_dir() -> Result<PathBuf, String> {
    let dir = dirs_next::data_dir()
        .ok_or_else(|| "cannot resolve data dir".to_string())?
        .join("WoWSP")
        .join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Extract a string field from a JSON object without pulling in serde on the
/// hot path. Handles the common `{"code": "..."}` / `{"name": "..."}` shapes
/// the test driver sends. Returns None if the field is absent or malformed.
fn json_string_field(json: &str, field: &str) -> Option<String> {
    let key = format!("\"{field}\"");
    let idx = json.find(&key)?;
    let after_key = &json[idx + key.len()..];
    let colon = after_key.find(':')?;
    let after_colon = &after_key[colon + 1..];
    let trimmed = after_colon.trim_start();
    let quote = trimmed.chars().next()?;
    if quote != '"' {
        return None;
    }
    let value_start = &trimmed[1..];
    // Find the closing quote, respecting escaped quotes.
    let mut chars = value_start.chars().peekable();
    let mut out = String::new();
    let mut escaped = false;
    for c in &mut chars {
        if escaped {
            match c {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                other => out.push(other),
            }
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return Some(out);
        } else {
            out.push(c);
        }
    }
    None
}

const OK: &str = "200 OK";

fn bad(msg: &str) -> (&'static str, String) {
    let escaped = msg.replace('\\', "\\\\").replace('"', "\\\"");
    (
        "400 Bad Request",
        format!("{{\"ok\":false,\"error\":\"{escaped}\"}}"),
    )
}
