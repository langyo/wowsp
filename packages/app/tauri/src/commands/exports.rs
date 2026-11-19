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
    window: tauri::Window,
    default_name: String,
    filter_name: String,
    filter_exts: Vec<String>,
) -> CommandResult<Option<String>> {
    crate::commands::ensure_main_window_label(window.label())?;
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
pub async fn write_export_bytes(
    window: tauri::Window,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
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

/// Copy one saved export FILE onto the system clipboard as an HDROP
/// payload — the replay clip's post-save hand-off, so a recorded MP4/
/// WebM/GIF pastes straight into a chat window as a file attachment
/// (videos cannot ride the image clipboard, and the webview clipboard
/// API carries neither files nor video blobs). Windows only: other
/// desktops have no cross-app file-clipboard convention here, and
/// mobile has no saved native file at all — both return an error the
/// webui absorbs behind its saved-only toast.
#[tauri::command]
pub async fn copy_file_to_clipboard(path: String) -> CommandResult<()> {
    #[cfg(mobile)]
    {
        let _ = path;
        return Err(anyhow!(crate::mobile_unsupported::CLIPBOARD_FILE).into());
    }
    #[cfg(all(desktop, windows))]
    {
        // Same audit H-1 invariant as write_export_bytes: only paths a
        // native dialog handed out this session may move through the
        // clipboard — a compromised webview must not turn arbitrary files
        // on disk into paste bait. The replay flow always holds the grant
        // (the save dialog just registered it).
        if !export_path_granted(&path) {
            return Err(anyhow!("clipboard copy target was not granted this session").into());
        }
        // Blocking pool: the clipboard open can block briefly while
        // another app holds it (same reasoning as the image copy).
        Ok(
            tokio::task::spawn_blocking(move || write_file_hdrop_windows(&path))
                .await
                .map_err(|e| anyhow!("clipboard task failed: {e}"))??,
        )
    }
    #[cfg(all(desktop, not(windows)))]
    {
        let _ = path;
        Err(anyhow!("file clipboard copy is only implemented on Windows").into())
    }
}

/// Windows-side of [`copy_file_to_clipboard`]: stage the CF_HDROP payload
/// (the shell's file-list format — what Explorer hands around on copy)
/// and set it as the clipboard's content, replacing whatever sat there.
#[cfg(windows)]
fn write_file_hdrop_windows(path: &str) -> anyhow::Result<()> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};

    /// Standard clipboard format 15 — the shell's HDROP file list. Kept
    /// local so the Ole feature table stays untouched for one constant.
    const CF_HDROP: u32 = 15;

    /// Closes the clipboard on every drop — the error paths between the
    /// open and the set never leak an open clipboard (which would freeze
    /// every other app's copy/paste until this process exits).
    struct ClipboardCloser;
    impl Drop for ClipboardCloser {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    let file = std::path::PathBuf::from(path);
    if !file.is_file() {
        return Err(anyhow!("export file missing: {path}"));
    }
    let payload = hdrop_buffer(std::slice::from_ref(&file));
    unsafe {
        // Clipboard managers routinely hold the open for a beat — retry a
        // few times like arboard does before giving up to the saved-only
        // toast.
        let mut open_err: Option<windows::core::Error> = None;
        for _ in 0..5 {
            match OpenClipboard(None) {
                Ok(()) => {
                    open_err = None;
                    break;
                },
                Err(e) => open_err = Some(e),
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Some(e) = open_err {
            return Err(anyhow!("open clipboard: {e}"));
        }
        let _closer = ClipboardCloser;
        // Allocate and stage BEFORE the wipe: an alloc/lock failure must
        // not have destroyed whatever the user had on the clipboard.
        let handle = GlobalAlloc(GMEM_MOVEABLE, payload.len())
            .map_err(|e| anyhow!("alloc clipboard payload: {e}"))?;
        let dst = GlobalLock(handle);
        if dst.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err(anyhow!("lock clipboard payload failed"));
        }
        std::ptr::copy_nonoverlapping(payload.as_ptr(), dst.cast::<u8>(), payload.len());
        // ERROR_NOT_LOCKED after the one decrement is the documented
        // success shape — the BOOL-wrapped error never matters here.
        let _ = GlobalUnlock(handle);
        EmptyClipboard().map_err(|e| {
            let _ = GlobalFree(Some(handle));
            anyhow!("empty clipboard: {e}")
        })?;
        // On success the system OWNS the handle (freed on the next
        // EmptyClipboard, not by us); a failed set hands it back, and the
        // error path frees it so a failed copy never leaks.
        if let Err(e) = SetClipboardData(CF_HDROP, Some(HANDLE(handle.0))) {
            let _ = GlobalFree(Some(handle));
            return Err(anyhow!("set clipboard file: {e}"));
        }
    }
    tracing::info!(path = %path, "saved export copied to clipboard as file");
    Ok(())
}

/// The CF_HDROP wire bytes for `paths`: a DROPFILES header whose list
/// starts right after it, each path UTF-16 + one NUL, the whole list
/// closed by a second NUL (`fWide` marks the wide encoding). Pure —
/// unit-tested below so the layout the shell parses stays pinned.
#[cfg(windows)]
fn hdrop_buffer(paths: &[std::path::PathBuf]) -> Vec<u8> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Shell::DROPFILES;

    let mut list: Vec<u16> = Vec::new();
    for path in paths {
        list.extend(path.as_os_str().to_string_lossy().encode_utf16());
        list.push(0);
    }
    list.push(0);

    let header = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        pt: POINT::default(),
        fNC: false.into(),
        fWide: true.into(),
    };
    let header_bytes = unsafe {
        std::slice::from_raw_parts(
            std::ptr::addr_of!(header).cast::<u8>(),
            std::mem::size_of::<DROPFILES>(),
        )
    };
    let mut buf = Vec::with_capacity(header_bytes.len() + list.len() * 2);
    buf.extend_from_slice(header_bytes);
    buf.extend_from_slice(unsafe {
        std::slice::from_raw_parts(list.as_ptr().cast::<u8>(), list.len() * 2)
    });
    buf
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

    /// The CF_HDROP header the shell parses: 20 bytes — the list offset
    /// (pFiles), a POINT the shell ignores, the on-screen flag, and the
    /// wide-encoding flag that makes CJK filenames survive.
    #[cfg(windows)]
    #[test]
    fn hdrop_buffer_carries_the_shell_layout() {
        let buf = hdrop_buffer(&[std::path::PathBuf::from("D:/回放/a.webm")]);
        // pFiles points at the file list right behind the header.
        let list_offset = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        assert_eq!(list_offset, 20);
        assert_eq!(
            buf.len(),
            20 + ("D:/回放/a.webm".encode_utf16().count() + 2) * 2
        );
        // fWide (header offset 16..20) is TRUE — the wide-encoding flag.
        assert_eq!(u32::from_le_bytes(buf[16..20].try_into().unwrap()), 1);
        // The list itself: UTF-16 path, one NUL, then the closing NUL.
        let wide: Vec<u16> = buf[20..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let mut chars = String::from_utf16_lossy(&wide).chars().collect::<Vec<_>>();
        while chars.last() == Some(&'\0') {
            chars.pop();
        }
        assert_eq!(chars.iter().collect::<String>(), "D:/回放/a.webm");
    }

    /// Multiple files arrive as consecutive NUL-terminated entries sharing
    /// the one closing NUL (the command only ever sends one, but the
    /// layout contract belongs to the format, not the call site).
    #[cfg(windows)]
    #[test]
    fn hdrop_buffer_lists_every_path() {
        let buf = hdrop_buffer(&[
            std::path::PathBuf::from("C:/a.mp4"),
            std::path::PathBuf::from("C:/b.gif"),
        ]);
        let wide: Vec<u16> = buf[20..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let text = String::from_utf16(&wide).unwrap();
        assert_eq!(text, "C:/a.mp4\0C:/b.gif\0\0");
    }
}
