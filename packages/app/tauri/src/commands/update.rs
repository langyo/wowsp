//! Shun-based auto-update: resolve the configured mirror sources, compare
//! the `latest` marker against the running version, download the new
//! installer through the proxy-aware client and hand it to the OS.
//!
//! The update-watch config (`[package.metadata.shun.update]`) is embedded at
//! build time (see `build.rs`) — the same table drives the installer shell's
//! delivery pipeline. Flow: `update_check` resolves the mirrors via
//! [`shun::update::resolve`] + [`shun::update::fetch_text`] and compares the
//! `latest` marker with the embedded app version; `update_download` streams
//! the lite installer artifact (`WoWSP_<version>_x64-installer.exe`, the
//! naming `scripts/build_installers.py::emit` produces) to a temp file and
//! spawns it detached with `--silent --dir=<install dir>` plus the user's
//! shortcut answers (`--shortcut-menu=` / `--shortcut-desktop=`). The
//! hardened installer kills the running app and installs over its directory
//! — no auto-relaunch, the user restarts from the Start menu — so the
//! frontend treats the command's promise never resolving (app death) or
//! resolving (installer spawned) as success by design; the only visible
//! failure mode is `Err`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

use crate::commands::network::build_http_client;

/// Update-watch table embedded by `build.rs` from
/// `[package.metadata.shun.update]` in this crate's Cargo.toml.
const SHUN_UPDATE_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-update.json"));

/// The running app's version, embedded by `build.rs` from
/// `CARGO_PKG_VERSION` (the workspace version).
const APP_VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/app-version.txt"));

/// The lite installer artifact URL under a mirror base — the exact name
/// `scripts/build_installers.py::emit` produces for the suffix-less flavor
/// (`WoWSP_<version>_x64-installer.exe`; updates never use the -full /
/// -webview2 variants).
fn artifact_url(base: &str, version: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    format!("{base}/WoWSP_{version}_x64-installer.exe")
}

/// Set while an update download is in flight: double triggers (auto banner +
/// manual button) collapse into the first pass instead of racing the same
/// temp artifact.
static UPDATE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// An installer is hundreds of MB; anything smaller is a mirror error page.
const MIN_INSTALLER_BYTES: u64 = 1_000_000;

/// Version-check answer for the webui updater store.
#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub available: bool,
    pub version: Option<String>,
}

/// The parsed update-watch config (mirrors `shun::config::UpdateWatchConfig`;
/// re-declared locally so the JSON shape stays explicit at the use site).
#[derive(Debug, serde::Deserialize)]
struct WatchConfig {
    sources: Vec<String>,
    files: Vec<String>,
}

fn watch_config() -> Result<WatchConfig, String> {
    serde_json::from_str::<WatchConfig>(SHUN_UPDATE_JSON)
        .map_err(|e| format!("embedded shun-update.json: {e}"))
}

/// Resolves the first reachable mirror, fetches its `latest` version marker
/// and derives the lite-installer artifact URL under the same source.
/// Blocking (shun's probe rides a plain ureq agent) — call via
/// [`resolve_latest`], which parks it on the blocking pool.
fn resolve_latest_blocking() -> Result<(String, String), String> {
    let watch = watch_config()?;
    let mut on_event = |_: shun::flow::FlowEvent| {};
    let resolved: shun::update::ResolvedWatch =
        shun::update::resolve(&watch.sources, &watch.files, &mut on_event)
            .ok_or_else(|| "no update source reachable".to_string())?;

    let latest_url: &String = resolved
        .files
        .get("latest")
        .ok_or_else(|| "no `latest` marker declared in the update sources".to_string())?;
    let version = shun::update::fetch_text(latest_url)
        .map_err(|e| format!("fetch {latest_url}: {e}"))?
        .trim()
        .to_string();
    if version.is_empty() {
        return Err(format!("`latest` marker at {latest_url} is empty"));
    }

    Ok((version.clone(), artifact_url(&resolved.source, &version)))
}

/// Async wrapper: the shun mirror probe + marker fetch are blocking I/O, so
/// they run on the blocking pool instead of stalling the async runtime.
async fn resolve_latest() -> Result<(String, String), String> {
    tauri::async_runtime::spawn_blocking(resolve_latest_blocking)
        .await
        .map_err(|e| format!("update resolve task: {e}"))?
}

/// Segment-wise version comparison: split on `.`, parse each segment as u64
/// (non-numeric counts as 0), zero-pad the shorter side; strictly greater
/// wins. `0.1` equals `0.1.0`; `0.1` beats `0.0.9`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|seg| seg.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let mut candidate = parse(candidate);
    let mut current = parse(current);
    let len = candidate.len().max(current.len());
    candidate.resize(len, 0);
    current.resize(len, 0);
    candidate > current
}

/// Check the mirrors for a version newer than the running build. Errors are
/// returned as `Err` — the webui store surfaces them silently (AboutModal
/// only); the startup auto-check must never nag the user.
#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    let (version, _artifact_url) = resolve_latest().await?;
    let available = is_newer(&version, APP_VERSION);
    Ok(UpdateInfo {
        current: APP_VERSION.to_string(),
        available,
        version: available.then_some(version),
    })
}

/// Download the new installer and hand it to the OS. `menu` / `desktop`
/// carry the update prompt's shortcut answers (the silent installer
/// creates the Start-menu / desktop shortcuts per them). Emits
/// `update-progress` events (`{ phase: "download", percent: 0-100 }`)
/// while streaming and one final `{ phase: "install", percent: 100 }`
/// right before the installer is spawned; returns after that spawn — the
/// hardened installer then kills this app, installs over its directory
/// and relaunches the new build, so the webui treats the unresolved
/// promise / app exit as success by design.
#[tauri::command]
pub async fn update_download(window: tauri::WebviewWindow) -> Result<(), String> {
    // Collapse double triggers (banner + About button) into one pass.
    if UPDATE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = update_download_inner(&window).await;
    UPDATE_IN_FLIGHT.store(false, Ordering::SeqCst);
    result
}

async fn update_download_inner(window: &tauri::WebviewWindow) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let (version, artifact_url) = resolve_latest().await?;
    let client = build_http_client()?;
    let mut response = client
        .get(&artifact_url)
        .send()
        .await
        .map_err(|e| format!("fetch {artifact_url}: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        let msg = format!(
            "fetch {artifact_url}: unexpected status {}",
            response.status()
        );
        return Err(msg);
    }
    let total = response.content_length().unwrap_or(0);

    // PID-suffixed temp name: two app instances must not race one file.
    let installer_path =
        std::env::temp_dir().join(format!("WoWSP-update-{version}-{}.exe", std::process::id()));
    let mut file = tokio::fs::File::create(&installer_path)
        .await
        .map_err(|e| format!("create {}: {e}", installer_path.display()))?;

    let mut downloaded: u64 = 0;
    let mut last_percent: Option<u64> = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("download {artifact_url}: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {}: {e}", installer_path.display()))?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            // Percent as f64 0-100, rounded for display; emitted when the
            // rounded value ticks so the webview isn't flooded per-chunk.
            let percent = ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0);
            let rounded = percent.round() as u64;
            if last_percent != Some(rounded) {
                last_percent = Some(rounded);
                let _ = window.emit(
                    "update-progress",
                    serde_json::json!({ "phase": "download", "percent": percent }),
                );
            }
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("write {}: {e}", installer_path.display()))?;
    // Release the handle BEFORE spawning — an open handle makes the child
    // process creation fail with os error 32 on Windows.
    drop(file);
    let _ = window.emit(
        "update-progress",
        serde_json::json!({ "phase": "download", "percent": 100.0 }),
    );

    if downloaded <= MIN_INSTALLER_BYTES {
        return Err(format!(
            "downloaded installer is only {downloaded} bytes — the mirror returned an error page, not {artifact_url}"
        ));
    }

    // Install over the directory the running exe lives in; the hardened
    // installer takes it from here — it kills this app, extracts, leaves
    // every launcher untouched (they point at the same exe) and relaunches
    // the new build. No shortcut flags ride along: updates never touch
    // shortcuts.
    let install_dir = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .parent()
        .ok_or_else(|| "current exe has no parent directory".to_string())?
        .to_path_buf();
    // Tell the webui the install phase started even though the spawned
    // installer may kill this app before the command's promise settles.
    let _ = window.emit(
        "update-progress",
        serde_json::json!({ "phase": "install", "percent": 100 }),
    );
    std::process::Command::new(&installer_path)
        .args(["--silent", &format!("--dir={}", install_dir.display())])
        .spawn()
        .map_err(|e| format!("spawn installer {}: {e}", installer_path.display()))?;

    Ok(())
}

/// The `latest` → artifact URL contract with the build script's naming.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_patch_is_detected() {
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.1"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1", "0.1.0"));
        assert!(!is_newer("0.1.0.0", "0.1"));
    }

    #[test]
    fn shorter_version_zero_pads() {
        // 0.1 vs 0.0.9: 0 == 0, 1 > 0 → newer.
        assert!(is_newer("0.1", "0.0.9"));
        assert!(!is_newer("0.0", "0.0.9"));
    }

    #[test]
    fn non_numeric_segments_count_as_zero() {
        assert!(is_newer("0.2.0-beta", "0.1.9")); // 0.2.0 > 0.1.9
        assert!(!is_newer("0.1.0-rc", "0.1")); // 0.1.0 == 0.1.0 ("rc" → 0)
        // Tags after a second dot just segment further ("0.1.0-rc.1" →
        // 0.1.0.1, newer than 0.1.0.0). The `latest` marker only ever
        // carries plain release tags, so no semver-prerelease ordering is
        // attempted here — the simple rule is the design.
        assert!(is_newer("0.1.0-rc.1", "0.1"));
        assert!(!is_newer("abc", "0.0.1")); // 0.0.0 < 0.0.1
    }

    #[test]
    fn major_bump_wins_over_patch() {
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn embedded_config_has_latest_marker_and_sources() {
        let watch = watch_config().expect("embedded config parses");
        assert!(!watch.sources.is_empty(), "at least one mirror source");
        assert!(watch.sources.iter().all(|s| s.starts_with("https://")));
        assert_eq!(watch.files, vec!["latest".to_string()]);
    }

    #[test]
    fn app_version_is_a_clean_semver() {
        assert_eq!(APP_VERSION.trim(), APP_VERSION, "no stray whitespace");
        assert!(
            APP_VERSION.split('.').count() >= 2,
            "version carries at least major.minor: {APP_VERSION}"
        );
    }

    #[test]
    fn artifact_url_matches_build_script_emission() {
        assert_eq!(
            artifact_url(
                "https://github.com/langyo/wowsp/releases/latest/download",
                "0.1.0"
            ),
            "https://github.com/langyo/wowsp/releases/latest/download/WoWSP_0.1.0_x64-installer.exe"
        );
        // Trailing slashes and stray whitespace on a mirror base are trimmed.
        assert_eq!(
            artifact_url("https://mirror.example.test/files/", "1.2.3"),
            "https://mirror.example.test/files/WoWSP_1.2.3_x64-installer.exe"
        );
    }
}
