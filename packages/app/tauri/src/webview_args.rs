//! The single source of truth for the WebView2 (Chromium) browser
//! arguments every WoWSP webview is created with.
//!
//! ## Why one constant for ALL windows
//!
//! Tauri/Wry requires that webviews sharing one user-data folder are created
//! with IDENTICAL browser arguments (see the `additionalBrowserArgs` docs in
//! tauri-utils' window config). WoWSP's main window, tray panel and the
//! overlay family all share the default data directory, so the string below
//! must be passed to every one of them — the config-declared windows carry
//! it in `tauri.conf.json`, the runtime-created overlay windows get it from
//! the builder call, and the test at the bottom of this file keeps the two
//! sides from drifting apart.
//!
//! ## What the switches do
//!
//! - `--force-high-performance-gpu` — on hybrid-GPU machines Chromium's
//!   GPU process (msedgewebview2.exe) defaults to the low-power integrated
//!   adapter, and neither Windows' per-app GPU preference nor WebGL's
//!   powerPreference can change that (the preference would have to target
//!   msedgewebview2.exe, affecting every WebView2 app on the machine). The
//!   switch makes the browser process request the high-performance adapter
//!   for the whole WebView (supported since WebView2 runtime 145; the
//!   replay view's ?perf=1 overlay shows the resulting GL_RENDERER for
//!   verification). Machines without a discrete GPU simply keep their only
//!   adapter.
//! - `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` —
//!   Wry's own default argument set, which setting `additionalBrowserArgs`
//!   REPLACES; re-declared here so nothing is lost by the override.

/// Browser arguments every WoWSP WebView2 window is created with. Keep in
/// sync with the `additionalBrowserArgs` entries in `tauri.conf.json`
/// (enforced by the test below). NOTE: Wry REPLACES its default argument
/// set when this is set — anything its default branch would have added
/// conditionally (e.g. autoplay / proxy switches) must be re-declared here.
pub(crate) const WEBVIEW_BROWSER_ARGS: &str =
    "--force-high-performance-gpu --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[cfg(test)]
mod tests {
    use super::WEBVIEW_BROWSER_ARGS;

    /// Every config-declared window must carry exactly the shared argument
    /// string — a drift would give windows different browser arguments over
    /// the same user-data folder, which Tauri/Wry forbids.
    #[test]
    fn config_windows_carry_the_shared_browser_args() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
        let raw = std::fs::read_to_string(path).expect("tauri.conf.json readable");
        let conf: serde_json::Value = serde_json::from_str(&raw).expect("tauri.conf.json parses");
        let windows = conf["app"]["windows"]
            .as_array()
            .expect("app.windows is an array");
        assert!(
            !windows.is_empty(),
            "app.windows must exist for the parity check"
        );
        for win in windows {
            let label = win["label"].as_str().unwrap_or("<unnamed>");
            let args = win["additionalBrowserArgs"].as_str();
            assert_eq!(
                Some(WEBVIEW_BROWSER_ARGS),
                args,
                "window {label} must declare additionalBrowserArgs == WEBVIEW_BROWSER_ARGS"
            );
        }
    }
}
