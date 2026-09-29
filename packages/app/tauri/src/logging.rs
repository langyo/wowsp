//! Diagnostics logging: stdout layer (as before) plus a daily-rotating
//! UTF-8 file sink the settings' 问题反馈 section can ship.
//!
//! Layout: `<data root>/logs/wowsp.<YYYY-MM-DD>.log` (data root follows
//! `crate::paths` — `%APPDATA%\WoWSP` locally, `<exe>/data` portable), one
//! file per calendar day, the newest [`MAX_LOG_FILES`] kept. The rolling
//! writer is line-buffered UTF-8 by construction (Rust strings), so logs
//! survive paths and messages containing CJK characters — the whole point
//! of the feedback flow.
//!
//! Init order: this runs before the Tauri builder, so the file layer only
//! attaches where the data root resolves WITHOUT the app handle — every
//! desktop layout (portable marker included). Android has no such path
//! until `setup` captures the handle, and the global subscriber cannot be
//! re-layered after init, so mobile keeps stdout-only logging (logcat)
//! and the feedback section hides on the phone build.
//!
//! Levels: stdout keeps the historic default `wowsp=info,warn` (RUST_LOG
//! overrides). The file sink defaults to `wowsp=debug,warn` — richer, so a
//! feedback bundle actually carries diagnosis signal — with its own
//! `WOWSP_FILE_LOG` override for support sessions.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// Folder name for the log sink, under the writable data root.
pub const LOG_DIR_NAME: &str = "logs";

/// How many daily files the roller keeps on disk (older ones are pruned
/// when a new day rolls over). Mirrored into the settings UI as the
/// retention hint.
pub const MAX_LOG_FILES: usize = 14;

/// Resolve `<data root>/logs` (no side effects).
pub fn log_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::data_dir()?.join(LOG_DIR_NAME))
}

/// Resolve `<data root>/logs`, creating it if missing.
pub fn ensure_log_dir() -> Result<PathBuf, String> {
    let dir = log_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
}

/// One retained log file with the metadata the feedback UI shows.
#[derive(Debug, Clone)]
pub struct LogFile {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified: Option<SystemTime>,
}

/// List the retained `wowsp.<date>.log` files, NEWEST FIRST. The date is
/// zero-padded ISO in the file name, so name order is chronological order;
/// feedback bundles live in the same folder under a different pattern and
/// never match (nor does the roller prune them — its own scan matches only
/// its prefix/suffix). The middle segment is PARSED as `%Y-%m-%d`, so a
/// bare `wowsp.log` (no date) doesn't slip through the prefix/suffix
/// check.
pub fn list_log_files(dir: &Path) -> Vec<LogFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<LogFile> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| is_rolling_log_name(&e.file_name().to_string_lossy()))
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some(LogFile {
                path: e.path(),
                size_bytes: md.len(),
                modified: md.modified().ok(),
            })
        })
        .collect();
    files.sort_by(|a, b| b.path.file_name().cmp(&a.path.file_name()));
    files
}

/// `wowsp.<YYYY-MM-DD>.log` — the roller's exact naming.
fn is_rolling_log_name(name: &str) -> bool {
    name.strip_prefix("wowsp.")
        .and_then(|rest| rest.strip_suffix(".log"))
        .is_some_and(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok())
}

/// Install the global subscriber: stdout layer (same format as always) +
/// file layer when the data root resolves without the app handle.
/// Called once at the top of `run`, before anything logs.
pub fn init() {
    let stdout_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("wowsp=info,warn"));
    let stdout = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_ansi(true)
        .with_filter(stdout_filter);

    // The file layer is built INLINE in each arm: its `Layer<S>` type
    // parameter is the registry-with-stdout stack below it, which has no
    // nameable type — a helper returning `impl Layer<Registry>` only
    // satisfies the outer `.with()` when inference sees the call site.
    match build_appender() {
        Some(appender) => {
            let filter = file_env_filter();
            let file = tracing_subscriber::fmt::layer()
                .with_writer(appender)
                // ANSI escapes would paint the file unreadable in editors
                // that don't parse them — plain text only.
                .with_ansi(false)
                .with_target(true)
                // File + line turn a feedback log from noise into evidence.
                .with_file(true)
                .with_line_number(true)
                .with_filter(filter);
            tracing_subscriber::registry()
                .with(stdout)
                .with(file)
                // try_init (not init): a second `run()` in the same process
                // (tests, embedding) downgrades to stdout-only instead of
                // panicking.
                .try_init()
                .ok();
        },
        None => {
            tracing_subscriber::registry().with(stdout).try_init().ok();
        },
    }

    // First content line of the fresh file (the roller creates today's
    // empty file at build time) — carries the build identity every
    // feedback log should open with.
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        debug_build = cfg!(debug_assertions),
        portable = crate::paths::portable_mode(),
        log_dir = ?log_dir().ok(),
        "wowsp starting"
    );
}

/// Build the rolling appender, or `None` when the sink cannot attach
/// (mobile — see below; unwritable data root; roller failure). Errors are
/// said on stderr — tracing itself is not installed yet.
///
/// Desktop-only by construction: `run()` calls this BEFORE the Tauri
/// `setup`, and only desktop layouts resolve `paths::data_dir()` without
/// the app handle. Mobile logging stays stdout-only (logcat covers it).
#[cfg(desktop)]
fn build_appender() -> Option<tracing_appender::rolling::RollingFileAppender> {
    let dir = match ensure_log_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("wowsp: file logging disabled ({e})");
            return None;
        },
    };
    // No queryable handle is kept here (0.2.x is neither Clone nor
    // introspectable): "the current file" is simply the NEWEST
    // `wowsp.<date>.log` on disk — `build()` eagerly creates today's file,
    // and the day rolls only on the next write after midnight.
    match tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("wowsp")
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(&dir)
    {
        Ok(appender) => Some(appender),
        Err(e) => {
            eprintln!("wowsp: log roller build failed ({e})");
            None
        },
    }
}

/// Mobile arm: no exe-relative or APPDATA root exists before `setup`
/// captures the app handle, and the global subscriber cannot be re-layered
/// afterwards — stdout-only it is.
#[cfg(not(desktop))]
fn build_appender() -> Option<tracing_appender::rolling::RollingFileAppender> {
    None
}

/// The file sink's level filter: `WOWSP_FILE_LOG` overrides the richer
/// default (debug for wowsp itself — a feedback log should carry signal).
fn file_env_filter() -> EnvFilter {
    EnvFilter::try_new(
        std::env::var("WOWSP_FILE_LOG").unwrap_or_else(|_| "wowsp=debug,warn".to_string()),
    )
    .unwrap_or_else(|_| EnvFilter::new("wowsp=debug,warn"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn temp_dir(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("wowsp-logging-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn listing_sorts_newest_first_and_skips_foreign_files() {
        let dir = temp_dir("list");
        for name in [
            "wowsp.2026-09-27.log",
            "wowsp.2026-09-29.log",
            "wowsp.2026-09-28.log",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        // Same folder, must NOT be picked up by OUR listing. (The roller's
        // own prune scan matches looser bare substrings, so it may sweep a
        // stray wowsp.log itself — its business, not ours; the zip never
        // matches either way.)
        std::fs::write(dir.join("feedback-bundle-20260929-000000.zip"), b"x").unwrap();
        std::fs::write(dir.join("wowsp.log"), b"x").unwrap(); // no date segment

        let files = list_log_files(&dir);
        let names: Vec<String> = files
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "wowsp.2026-09-29.log",
                "wowsp.2026-09-28.log",
                "wowsp.2026-09-27.log"
            ]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn utf8_content_round_trips_through_the_sink_layout() {
        // The file sink writes Rust strings verbatim (UTF-8, no transcoding)
        // — the guarantee the feedback flow depends on when paths contain
        // CJK (e.g. D:\源代码\...). Simulate a written file and read it back.
        let dir = temp_dir("utf8");
        let file = dir.join("wowsp.2026-09-29.log");
        let mut f = std::fs::File::create(&file).unwrap();
        writeln!(f, "game path set: D:\\源代码\\工程项目").unwrap();
        drop(f);

        let bytes = std::fs::read(&file).unwrap();
        let text = String::from_utf8(bytes).expect("log file is valid UTF-8");
        assert!(text.contains("D:\\源代码\\工程项目"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
