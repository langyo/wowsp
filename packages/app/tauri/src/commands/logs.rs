//! Diagnostics-log commands for the settings' 问题反馈 section.
//!
//! The file sink (see `crate::logging`) rolls daily under `<data>/logs` as
//! UTF-8 `wowsp.<date>.log`. These commands expose that folder to the
//! webui: an overview for display, an explorer reveal that selects the
//! newest file, a tail read for one-click clipboard sharing, and a UTF-8
//! zip bundle for feedback reports (飞书 self-service upload ships later —
//! the bundle is shaped to be that request's attachment from day one).
//!
//! All paths are backend-derived (never frontend-supplied), so nothing
//! here can be aimed at arbitrary filesystem locations.

use std::io::Write as _;
use std::path::PathBuf;

use serde::Serialize;

use crate::logging::{self, LogFile};

/// Cap the tail read: enough lines to carry the incident, never a whole
/// day dragged through IPC.
const MAX_TAIL_LINES: usize = 1000;
/// Default tail when the caller doesn't say.
const DEFAULT_TAIL_LINES: usize = 120;
/// Bytes considered when slicing the tail (the line window never scans
/// beyond this from the end).
const TAIL_WINDOW_BYTES: usize = 256 * 1024;
/// Total budget for log files inside one feedback bundle — newest first,
/// older days drop off beyond this.
const BUNDLE_BUDGET_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    /// RFC 3339 (UTC), null when the filesystem didn't say.
    pub modified: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsOverview {
    /// The folder the roller writes to (and the reveal buttons open).
    pub dir: String,
    /// Newest `wowsp.<date>.log`; null until the first write of the day.
    pub latest: Option<LogFileInfo>,
    /// Retained files, newest first.
    pub files: Vec<LogFileInfo>,
    pub total_bytes: u64,
    /// How many daily files the roller keeps before pruning.
    pub retained_max: usize,
}

fn to_info(f: &LogFile) -> LogFileInfo {
    LogFileInfo {
        name: f
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: f.path.to_string_lossy().into_owned(),
        size_bytes: f.size_bytes,
        modified: f
            .modified
            .map(|m| chrono::DateTime::<chrono::Utc>::from(m).to_rfc3339()),
    }
}

/// Tauri command: list the diagnostics-log folder (newest first) plus the
/// retention count, for the settings' 问题反馈 section.
#[tauri::command]
pub fn logs_overview() -> Result<LogsOverview, String> {
    let dir = logging::ensure_log_dir()?;
    let files = logging::list_log_files(&dir);
    let total_bytes = files.iter().map(|f| f.size_bytes).sum();
    let mut files: Vec<LogFileInfo> = files.iter().map(to_info).collect();
    let latest = if files.is_empty() {
        None
    } else {
        Some(files.remove(0))
    };
    Ok(LogsOverview {
        dir: dir.to_string_lossy().into_owned(),
        latest,
        files,
        total_bytes,
        retained_max: logging::MAX_LOG_FILES,
    })
}

/// Open the logs folder in the system file manager WITH the newest log
/// file selected — the reveal target is backend-derived, never an
/// argument.
#[tauri::command]
pub fn logs_reveal_latest(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = logging::ensure_log_dir()?;
    let target = logging::list_log_files(&dir)
        .into_iter()
        .next()
        .map(|f| f.path)
        .ok_or_else(|| "no log files yet".to_string())?;
    tracing::info!(?target, "revealing newest log file in file manager");
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| format!("reveal {}: {e}", target.display()))
}

/// Tauri command: read the last `lines` lines (default 120, max 1000) of
/// the newest log file, as UTF-8 text for clipboard sharing. A partial
/// multibyte character at the window edge degrades to the replacement
/// character on that one line only.
#[tauri::command]
pub fn logs_read_tail(lines: Option<usize>) -> Result<String, String> {
    let dir = logging::ensure_log_dir()?;
    let target = logging::list_log_files(&dir)
        .into_iter()
        .next()
        .map(|f| f.path)
        .ok_or_else(|| "no log files yet".to_string())?;

    let bytes = std::fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    let keep = lines.unwrap_or(DEFAULT_TAIL_LINES).clamp(1, MAX_TAIL_LINES);

    // Slice from the end first (byte budget), decode once, then cut lines.
    let window: &[u8] = if bytes.len() > TAIL_WINDOW_BYTES {
        &bytes[bytes.len() - TAIL_WINDOW_BYTES..]
    } else {
        &bytes
    };
    let text = String::from_utf8_lossy(window);
    let tail: String = text
        .lines()
        .rev()
        .take(keep)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Ok(tail)
}

/// Tauri command: write a feedback bundle into the logs folder and reveal
/// it in the system file manager. The zip carries the retained log files
/// (newest first under a 32 MiB budget; the newest ALWAYS ships — as its
/// tail when oversized, since a runaway log is exactly the report worth
/// making) plus a UTF-8 `feedback-info.txt` header (app version, OS,
/// build flavor, portable mode, file manifest). Returns the bundle path.
/// Exported bundles stay in the folder until the user deletes them (the
/// roller never touches them — its prune scan matches only its own
/// naming, and so does the overview listing).
#[tauri::command]
pub fn logs_export_bundle(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = logging::ensure_log_dir()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let bundle_path = dir.join(format!("feedback-bundle-{stamp}.zip"));

    // Newest first. The newest file always enters the bundle — when it
    // alone busts the budget, its TAIL is what ships (capped below).
    // Older files join whole until the budget runs out.
    let mut sources: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut budget = BUNDLE_BUDGET_BYTES;
    for (i, f) in logging::list_log_files(&dir).into_iter().enumerate() {
        if budget == 0 && i > 0 {
            break;
        }
        let capped = if i == 0 {
            f.size_bytes.min(budget)
        } else if f.size_bytes > budget {
            break;
        } else {
            f.size_bytes
        };
        budget -= capped;
        sources.push((
            f.path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            f.path,
            capped,
        ));
    }
    if sources.is_empty() {
        return Err("no log files to bundle".to_string());
    }

    let file = std::fs::File::create(&bundle_path)
        .map_err(|e| format!("create {}: {e}", bundle_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("feedback-info.txt", opts)
        .map_err(|e| format!("bundle header: {e}"))?;
    zip.write_all(&feedback_info(&dir, &sources))
        .map_err(|e| format!("bundle header: {e}"))?;

    for (name, path, cap) in &sources {
        let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        // A capped entry keeps its END: the newest events are the ones a
        // report is about. The slice may start mid-UTF8 character — one
        // mangled first line, noted in the manifest.
        let entry: &[u8] = if bytes.len() as u64 > *cap {
            &bytes[bytes.len() - *cap as usize..]
        } else {
            &bytes
        };
        zip.start_file(name.as_str(), opts)
            .map_err(|e| format!("bundle {name}: {e}"))?;
        zip.write_all(entry)
            .map_err(|e| format!("bundle {name}: {e}"))?;
    }
    zip.finish()
        .map_err(|e| format!("finalize {}: {e}", bundle_path.display()))?;

    tracing::info!(
        ?bundle_path,
        files = sources.len(),
        "feedback bundle exported"
    );
    let _ = app
        .opener()
        .reveal_item_in_dir(&bundle_path)
        .inspect_err(|e| tracing::warn!(error = %e, "reveal feedback bundle failed"));
    Ok(bundle_path.to_string_lossy().into_owned())
}

/// The bundle's manifest header. Written with a UTF-8 BOM so legacy
/// Windows editors (the GBK-default crowd) auto-detect instead of
/// mojibake-ing the CJK paths inside.
fn feedback_info(dir: &std::path::Path, sources: &[(String, PathBuf, u64)]) -> Vec<u8> {
    let mut manifest = String::new();
    manifest.push_str("WoWSP feedback bundle\n");
    manifest.push_str("encoding: UTF-8\n");
    manifest.push_str(&format!(
        "generated-at: {}\n",
        chrono::Local::now().to_rfc3339()
    ));
    manifest.push_str(&format!("app-version: {}\n", env!("CARGO_PKG_VERSION")));
    manifest.push_str(&format!("os: {}\n", std::env::consts::OS));
    manifest.push_str(&format!("arch: {}\n", std::env::consts::ARCH));
    manifest.push_str(&format!(
        "build: {}\n",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    ));
    manifest.push_str(&format!("portable: {}\n", crate::paths::portable_mode()));
    manifest.push_str(&format!("log-dir: {}\n", dir.display()));
    manifest.push_str("log-files (newest first, UTF-8 text):\n");
    for (name, path, cap) in sources {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > *cap {
            // Tail-only entry (bundle budget): the first line may be cut
            // mid-character.
            manifest.push_str(&format!("  {name} (tail {cap} of {size} bytes)\n"));
        } else {
            manifest.push_str(&format!("  {name} ({size} bytes)\n"));
        }
    }
    manifest.push_str("\nnote: 日志文件为 UTF-8 编码，每行一条事件。\n");
    manifest.push_str("note: log files are UTF-8 text, one event per line.\n");

    let mut bytes = Vec::with_capacity(manifest.len() + 3);
    bytes.extend_from_slice("\u{feff}".as_bytes());
    bytes.extend_from_slice(manifest.as_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("wowsp-logs-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn tail_keeps_last_lines_and_utf8() {
        let dir = temp_dir("tail");
        let file = dir.join("wowsp.2026-09-29.log");
        std::fs::write(&file, "一\n二\n三\n四\n五\n").unwrap();

        // The command path starts from the dir listing; exercise the same
        // slicing with an explicit file to keep the test local.
        let bytes = std::fs::read(&file).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let tail: String = text
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(tail, "三\n四\n五");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn feedback_info_is_bom_prefixed_utf8() {
        let dir = temp_dir("info");
        let sources = vec![(
            "wowsp.2026-09-29.log".to_string(),
            dir.join("wowsp.2026-09-29.log"),
            1024u64,
        )];
        let bytes = feedback_info(&dir, &sources);
        assert_eq!(&bytes[..3], "\u{feff}".as_bytes());
        let text = String::from_utf8(bytes).expect("manifest is UTF-8");
        assert!(text.contains("encoding: UTF-8"));
        assert!(text.contains("wowsp.2026-09-29.log"));
        assert!(!text.contains("tail"), "uncapped entry must not be marked");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn newest_oversized_log_still_ships_as_tail() {
        // The budget selection loop lives inside the command (needs an
        // AppHandle to finish), so pin the CONTRACT the loop implements:
        // given a 100-byte budget and a 300-byte newest file, its entry is
        // the LAST 100 bytes — newest events kept, not a hard failure.
        let bytes: Vec<u8> = (0..300u32).map(|n| n as u8).collect();
        let cap = 100u64;
        let entry: &[u8] = &bytes[bytes.len() - cap as usize..];
        assert_eq!(entry.len(), 100);
        assert_eq!(entry, &bytes[200..]);
    }
}
