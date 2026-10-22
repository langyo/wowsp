//! Tactical-board export commands: native save dialog + raw-bytes file write.
//!
//! Screenshots (PNG/WebP) and screen recordings (MP4/WebM) rendered by the
//! webui arrive here as raw IPC bodies (see `transport.invokeRaw` on the JS
//! side) — never as JSON number arrays, which would balloon a 40 MB video
//! into an unusably large IPC message. The destination path travels in the
//! `x-export-path` header, percent-encoded so paths with non-ASCII segments
//! survive the HTTP header layer.
//!
//! Security model (audit H-1): the write side only accepts paths a NATIVE
//! dialog has actually handed out this session. [`pick_export_path`]
//! registers every dialog result as a grant and [`write_export_bytes`]
//! refuses paths without one — a compromised webview can no longer name
//! arbitrary destinations (Startup-folder payloads, config clobbers). The
//! tactics profile's dialogless re-save rides the same registry (see
//! `tactics_profile.rs`).

use anyhow::anyhow;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use wowsp_tauri_shared::CommandResult;

// ── Save-target grants ────────────────────────────────────────────────────────

/// How long a dialog grant stays usable since its last successful use. The
/// sliding window keeps the tactics page's all-session dialogless re-save
/// working while bounding the table's value to recently-consented targets.
const EXPORT_GRANT_TTL: Duration = Duration::from_secs(6 * 3600);

/// Maximum live grants. A pick happens behind a native dialog, so the table
/// cannot grow fast — the cap only stops a hostile webview from spinning
/// `pick_export_path` into an unbounded map (each real grant still needs a
/// human click).
const EXPORT_GRANT_CAP: usize = 16;

fn export_grants() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static GRANTS: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    GRANTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Register `path` — exactly as a native dialog returned it — as a writable
/// save target for this session.
pub(crate) fn grant_export_path(path: &str) {
    let mut grants = export_grants().lock().unwrap_or_else(|p| p.into_inner());
    // Drop expired entries first, then make room for the new grant by
    // evicting the oldest survivor. The map is tiny; a linear scan is the
    // cheap and obvious move.
    let now = Instant::now();
    grants.retain(|_, at| now.duration_since(*at) < EXPORT_GRANT_TTL);
    while grants.len() >= EXPORT_GRANT_CAP {
        let Some(oldest) = grants
            .iter()
            .min_by_key(|(_, at)| **at)
            .map(|(p, _)| p.clone())
        else {
            break;
        };
        grants.remove(&oldest);
    }
    grants.insert(path.to_string(), Instant::now());
}

/// Does `path` carry a live grant? Slides the TTL forward on use, so an
/// actively re-saved target never expires mid-session.
pub(crate) fn export_path_granted(path: &str) -> bool {
    let mut grants = export_grants().lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    grants.retain(|_, at| now.duration_since(*at) < EXPORT_GRANT_TTL);
    match grants.get_mut(path) {
        Some(at) => {
            *at = now;
            true
        },
        None => false,
    }
}

/// Open a native save-file dialog pre-seeded with `default_name`. Returns the
/// picked absolute path, or `None` when the user cancelled. The frontend
/// derives the file extension filter from the export format it is about to
/// render, so the dialog never offers a mismatched extension.
#[tauri::command]
pub async fn pick_export_path(
    default_name: String,
    filter_name: String,
    filter_exts: Vec<String>,
) -> CommandResult<Option<String>> {
    // Mobile: no native save dialog — the export flow writes into app
    // storage / the media store instead (later mobile phase).
    #[cfg(mobile)]
    {
        let _ = (default_name, filter_name, filter_exts);
        return Err(anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread (same rule as
    // pick_replay_files / pick_game_folder).
    #[cfg(desktop)]
    {
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
        .map_err(|e| anyhow!("export save dialog task failed: {e}"))?;
        Ok(picked.map(|p| {
            let path = p.to_string_lossy().into_owned();
            grant_export_path(&path);
            path
        }))
    }
}

/// Hard ceiling on one export body. The rendered share shot tops out around
/// a few MB and a battle recording in the tens — anything near this is a
/// hostile or runaway webview, not an export.
const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;

/// Write a raw export body (PNG/WebP image bytes or MP4/WebM video bytes) to
/// the path carried in the `x-export-path` header. The path must carry a live
/// grant from [`pick_export_path`] — a native-dialog result — so the webview
/// can never name a destination no dialog has ever returned (audit H-1).
/// Async + blocking pool: a multi-MB video write must never stall the UI
/// thread.
#[tauri::command]
pub async fn write_export_bytes(request: tauri::ipc::Request<'_>) -> CommandResult<()> {
    let encoded = request
        .headers()
        .get("x-export-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| anyhow!("missing x-export-path header"))?;
    let path = percent_decode(encoded)?;
    if !export_path_granted(&path) {
        return Err(
            anyhow!("export target was not picked in a save dialog this session: {path}").into(),
        );
    }
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err(anyhow!("expected raw body (pass a Uint8Array to invokeRaw)").into()),
    };
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err(anyhow!("export body too large ({})", bytes.len()).into());
    }
    Ok(tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
            }
        }
        let len = bytes.len();
        std::fs::write(path, &bytes).map_err(|e| anyhow!("write export: {e}"))?;
        tracing::info!(path = %path.display(), bytes = len, "tactical export saved");
        Ok::<_, anyhow::Error>(())
    })
    .await
    .map_err(|e| anyhow!("export write task failed: {e}"))??)
}

/// Copy a PNG image (raw IPC body, same channel as [`write_export_bytes`])
/// onto the system clipboard — the post-battle share shot's "copy screenshot"
/// action. Desktop only: arboard has no Android backend, so mobile returns the
/// [`crate::mobile_unsupported::CLIPBOARD_IMAGE`] marker and the webview layer
/// falls back to its own clipboard API. Blocking pool: Windows clipboard open
/// can block briefly when another app holds the clipboard.
#[tauri::command]
pub async fn copy_image_to_clipboard(request: tauri::ipc::Request<'_>) -> CommandResult<()> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err(anyhow!("expected raw body (pass a Uint8Array to invokeRaw)").into()),
    };
    #[cfg(mobile)]
    {
        let _ = bytes;
        return Err(anyhow!(crate::mobile_unsupported::CLIPBOARD_IMAGE).into());
    }
    #[cfg(desktop)]
    {
        Ok(tokio::task::spawn_blocking(move || {
            // arboard 3.6 carries no PNG entry point, so decode through the
            // app's own `image` stack into the RGBA8 it expects.
            let decoded = image::load_from_memory(&bytes)
                .map_err(|e| anyhow!("decode share-shot PNG: {e}"))?
                .to_rgba8();
            let (w, h) = decoded.dimensions();
            let img = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: std::borrow::Cow::Owned(decoded.into_raw()),
            };
            let mut clip = arboard::Clipboard::new().map_err(|e| anyhow!("open clipboard: {e}"))?;
            clip.set_image(img)
                .map_err(|e| anyhow!("set clipboard image: {e}"))?;
            tracing::info!(
                bytes = bytes.len(),
                "post-battle share shot copied to clipboard"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(|e| anyhow!("clipboard task failed: {e}"))??)
    }
}

/// Decode a percent-encoded ASCII string (from `encodeURIComponent` on the JS
/// side) back into UTF-8. Hand-rolled to avoid a new dependency for one call.
/// Shared with the pairing module (URL paths + the import file-name header).
pub(crate) fn percent_decode(input: &str) -> anyhow::Result<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // Need two hex digits after '%'.
            if i + 2 >= bytes.len() {
                return Err(anyhow!("truncated percent escape"));
            }
            let hi = hex_val(bytes[i + 1]).ok_or_else(|| anyhow!("invalid percent escape"))?;
            let lo = hex_val(bytes[i + 2]).ok_or_else(|| anyhow!("invalid percent escape"))?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| anyhow!("export path is not valid UTF-8: {e}"))
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
        assert_eq!(
            percent_decode("D:/%E6%BA%90x/b.png").unwrap(),
            "D:/源x/b.png"
        );
        // encodeURIComponent leaves these untouched; spaces arrive as %20.
        assert_eq!(percent_decode("a%20b.webm").unwrap(), "a b.webm");
    }

    #[test]
    fn rejects_malformed_escapes() {
        assert!(percent_decode("a%2").is_err());
        assert!(percent_decode("a%ZZ").is_err());
    }

    // The grant table is a process-global; these tests serialize on a mutex
    // so parallel test threads cannot evict each other's entries.
    static GRANT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn grant_gates_the_write_side() {
        let _guard = GRANT_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let granted = "C:/tmp/wowsp-grant-test/shot.png";
        assert!(!export_path_granted(granted), "no grant before any pick");
        grant_export_path(granted);
        assert!(export_path_granted(granted));
        assert!(
            !export_path_granted("C:/tmp/wowsp-grant-test/other.png"),
            "a similar but never-picked path stays refused"
        );
    }

    #[test]
    fn expired_grants_stop_applying() {
        let _guard = GRANT_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let path = "C:/tmp/wowsp-grant-test/expired.png";
        grant_export_path(path);
        // Age the grant past the TTL by hand — no test waits six hours.
        export_grants().lock().unwrap().insert(
            path.to_string(),
            Instant::now() - EXPORT_GRANT_TTL - Duration::from_secs(1),
        );
        assert!(!export_path_granted(path), "expired grants are refused");
    }

    #[test]
    fn grant_table_is_capped_and_evicts_the_oldest() {
        let _guard = GRANT_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let first = "C:/tmp/wowsp-grant-test/first.png";
        grant_export_path(first);
        for i in 0..EXPORT_GRANT_CAP {
            grant_export_path(&format!("C:/tmp/wowsp-grant-test/n{i}.png"));
        }
        assert!(
            !export_path_granted(first),
            "the oldest grant left when the table hit its cap"
        );
        assert!(export_path_granted(&format!(
            "C:/tmp/wowsp-grant-test/n{}.png",
            EXPORT_GRANT_CAP - 1
        )));
    }
}
