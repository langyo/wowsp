//! Tactical-board export commands: native save dialog + raw-bytes file write.
//!
//! Screenshots (PNG/WebP) and screen recordings (MP4/WebM) rendered by the
//! webui arrive here as raw IPC bodies (see `transport.invokeRaw` on the JS
//! side) — never as JSON number arrays, which would balloon a 40 MB video
//! into an unusably large IPC message. The destination path travels in the
//! `x-export-path` header, percent-encoded so paths with non-ASCII segments
//! survive the HTTP header layer.

/// Open a native save-file dialog pre-seeded with `default_name`. Returns the
/// picked absolute path, or `None` when the user cancelled. The frontend
/// derives the file extension filter from the export format it is about to
/// render, so the dialog never offers a mismatched extension.
#[tauri::command]
pub async fn pick_export_path(
    default_name: String,
    filter_name: String,
    filter_exts: Vec<String>,
) -> Result<Option<String>, String> {
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread (same rule as
    // pick_replay_files / pick_game_folder).
    let picked = tokio::task::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .set_title("Save tactical board export")
            .set_file_name(&default_name);
        if !filter_exts.is_empty() {
            dlg = dlg.add_filter(&filter_name, &filter_exts);
        }
        dlg.save_file()
    })
    .await
    .map_err(|e| format!("export save dialog task failed: {e}"))?;
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

/// Write a raw export body (PNG/WebP image bytes or MP4/WebM video bytes) to
/// the path carried in the `x-export-path` header. The path is expected to
/// come straight from [`pick_export_path`]; a write to any other path is fine
/// (it is a user-visible save dialog result, not app data). Async + blocking
/// pool: a multi-MB video write must never stall the UI thread.
#[tauri::command]
pub async fn write_export_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-export-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing x-export-path header".to_string())?;
    let path = percent_decode(encoded)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("expected raw body (pass a Uint8Array to invokeRaw)".into()),
    };
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
        }
        let len = bytes.len();
        std::fs::write(path, &bytes).map_err(|e| format!("write export: {e}"))?;
        tracing::info!(path = %path.display(), bytes = len, "tactical export saved");
        Ok(())
    })
    .await
    .map_err(|e| format!("export write task failed: {e}"))?
}

/// Decode a percent-encoded ASCII string (from `encodeURIComponent` on the JS
/// side) back into UTF-8. Hand-rolled to avoid a new dependency for one call.
fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // Need two hex digits after '%'.
            if i + 2 >= bytes.len() {
                return Err("truncated percent escape".into());
            }
            let hi = hex_val(bytes[i + 1]).ok_or_else(|| "invalid percent escape".to_string())?;
            let lo = hex_val(bytes[i + 2]).ok_or_else(|| "invalid percent escape".to_string())?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| format!("export path is not valid UTF-8: {e}"))
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ascii_and_cjk_paths() {
        assert_eq!(percent_decode("D:/tmp/a.png").unwrap(), "D:/tmp/a.png");
        assert_eq!(percent_decode("D:/%E6%BA%90x/b.png").unwrap(), "D:/源x/b.png");
        // encodeURIComponent leaves these untouched; spaces arrive as %20.
        assert_eq!(percent_decode("a%20b.webm").unwrap(), "a b.webm");
    }

    #[test]
    fn rejects_malformed_escapes() {
        assert!(percent_decode("a%2").is_err());
        assert!(percent_decode("a%ZZ").is_err());
    }
}
