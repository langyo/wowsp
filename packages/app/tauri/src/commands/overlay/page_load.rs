//! Overlay-family page-load recovery — the self-healing half of the
//! click-through windows' navigation-failure page.
//!
//! The overlay windows are click-through (`WS_EX_NOACTIVATE` +
//! `set_ignore_cursor_events`), so when their webview lands on WebView2's
//! built-in navigation-failure page (the white "无法访问此页面 —
//! ERR_CONNECTION_REFUSED" card with its 刷新 button), nobody can ever
//! press that button — and the card replaces our document, so none of the
//! overlay page's own code runs to notice. One failed load persists for the
//! whole overlay-mode session: every Tab hold then shows the error card
//! instead of the roster (field report 2026-11-02). The realistic triggers:
//!
//! - dev (`just dev`): the Vite dev server restarting mid-battle — the HMR
//!   client's "server restarted" full reload then hits the briefly-closed
//!   port — or an overlay window created while the server is down;
//! - release: the same classes against the embedded custom protocol (a
//!   renderer-crash recovery reload), where a failure means the shell
//!   itself hiccuped for a moment.
//!
//! The main window's hikari boot-recovery inline script (vite.config.ts)
//! heals MANGLED ORIGINS of a document that did load — an error page has no
//! document of ours to heal — and ships inside `index.html` only. This
//! module is the overlay family's equivalent, placed where the error page
//! cannot hide from it, on the Rust side:
//!
//! - a WebView2 `NavigationCompleted` watcher (via `with_webview`) marks
//!   every FAILED top-level navigation of this window's own overlay page;
//! - a detached retry thread re-navigates the window to that URL on a
//!   short-backoff-then-steady schedule (1s 2s 4s 8s, then every 10 s): a
//!   dev server that returns mid-battle heals the overlay before the
//!   player's next Tab press, with no window recreation and no lost
//!   placement (the page re-pulls `read_temp_arena_info` and the watcher's
//!   next anchor event rehydrates the chips);
//! - every successful navigation resets the schedule, so a much later
//!   failure starts fresh at the fast cadence, and logs the recovery once.
//!
//! The retry target is the webview's own `Source` at the failed completion
//! (the URL the error card sits on), falling back to the last URL this
//! window ever loaded successfully — the bindings' flat interface surface
//! exposes no navigation-event URI, and both URLs are the same page in
//! every realistic failure (a reload of the window's own page). The page
//! guard keeps a foreign navigation (about:blank phases, probe frames)
//! from arming a retry of the wrong URL.
//!
//! Threading: the COM event fires on WebView2's UI thread and the handler
//! only writes the shared schedule cell; the actual navigation goes through
//! Tauri's thread-safe `WebviewWindow::navigate` from the retry thread, so
//! no COM method is re-entered from inside its own event. The loop exits
//! within one tick of the window's teardown (overlay mode end), because
//! `get_webview_window` stops resolving the label.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::*;

// The WebView2 COM surface of the page-load watcher (the retry loop above
// is pure tauri; only the event handler touches the bindings). Module-level
// because both `install_windows` and `source_of` live off it.
#[cfg(target_os = "windows")]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_WEB_ERROR_STATUS, ICoreWebView2},
    NavigationCompletedEventHandler, take_pwstr,
};
#[cfg(target_os = "windows")]
use windows_core::{BOOL, PWSTR};

/// The retry loop's poll period — a retry fires at most one tick after its
/// deadline, and the teardown check rides the same cadence.
const RETRY_TICK: Duration = Duration::from_millis(250);
/// First retry delay — a dev-server restart is usually a couple of seconds,
/// and healing before the player's next Tab press matters most here.
const FIRST_RETRY_DELAY: Duration = Duration::from_secs(1);
/// Steady-state retry cadence. The windows live for the whole overlay mode,
/// so an outage that outlasts the doubling is followed at this rate forever
/// — giving up would strand the mode on the error card until app restart.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(10);

/// Arm the watcher on one overlay-family window. `url_path` is the
/// registry spec's page path ("/overlay.html" — its file name is what
/// identifies the window's own navigations). Fire-and-forget: every
/// failure here logs and leaves the window exactly as it was before this
/// module existed.
pub(super) fn install(app: &AppHandle, win: &tauri::WebviewWindow, url_path: &'static str) {
    let page_file = match url_path.rsplit('/').next() {
        Some(file) if !file.is_empty() => file,
        _ => {
            tracing::warn!(path = %url_path, "overlay page-load watcher skipped — unparsable page path");
            return;
        },
    };
    #[cfg(target_os = "windows")]
    install_windows(app, win, page_file);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, win, page_file); // the overlay mode is Windows-only today
}

/// Retry backoff: attempts 1..=4 double from 1 s (1s 2s 4s 8s); every later
/// attempt sits at the steady [`MAX_RETRY_DELAY`]. Pure — unit-tested.
fn retry_delay(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(u64::BITS - 1);
    Duration::from_secs(
        FIRST_RETRY_DELAY
            .as_secs()
            .checked_shl(shift)
            .unwrap_or(u64::MAX),
    )
    .min(MAX_RETRY_DELAY)
}

/// Whether a navigation URI is this window's own overlay page. Pure —
/// unit-tested.
fn uri_targets_page(uri: &str, page_file: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else {
        return false;
    };
    url.path().rsplit('/').next() == Some(page_file)
}

/// The retry schedule shared between the COM watcher (producer) and the
/// retry thread (consumer). Pure time math — unit-tested; the wrappers add
/// the clock and the log lines.
#[derive(Default)]
struct Schedule {
    /// The last URL this window loaded SUCCESSFULLY and passed the page
    /// guard — the fallback retry target when a failure's own `Source`
    /// cannot be read or does not name the page.
    good_url: Option<String>,
    /// The pending retry target.
    url: Option<String>,
    /// When the next retry fires.
    due: Option<Instant>,
    /// Failed navigations since the last success (drives the backoff).
    attempts: u32,
}

impl Schedule {
    /// Record one successful, guard-passing load. Returns true when the
    /// page HAD been failing (the caller logs the recovery once, not per
    /// healthy load).
    fn note_good(&mut self, url: String) -> bool {
        self.good_url = Some(url);
        self.reset()
    }

    /// Clear the failure streak. True when the page HAD been failing.
    fn reset(&mut self) -> bool {
        let was_failing = self.attempts > 0;
        self.attempts = 0;
        self.url = None;
        self.due = None;
        was_failing
    }

    /// Record one failed page navigation. Returns the attempt number
    /// (1 = first failure of a burst).
    fn arm(&mut self, url: String, at: Instant, web_error_status: i32) -> u32 {
        self.attempts = self.attempts.saturating_add(1);
        let attempt = self.attempts;
        self.url = Some(url);
        self.due = Some(at + retry_delay(attempt));
        // The status names the transport failure (12 = CANNOT_CONNECT, the
        // connection-refused card); kept for the field log only.
        let _ = web_error_status;
        attempt
    }

    /// Hand over one due retry — `None` while nothing is scheduled or the
    /// deadline has not passed yet.
    fn take_due(&mut self, at: Instant) -> Option<(String, u32)> {
        if at < self.due? {
            return None;
        }
        // Consumed: a fresh failure re-arms through `arm`.
        self.due = None;
        Some((self.url.clone()?, self.attempts))
    }

    /// The fallback retry target when a failure's own `Source` is unusable.
    fn fallback_url(&self) -> Option<String> {
        self.good_url.clone()
    }
}

/// The schedule behind a mutex, shared with the COM handler.
#[derive(Default)]
struct RecoveryShared {
    schedule: Mutex<Schedule>,
}

impl RecoveryShared {
    /// Record one successful, guard-passing load; true when the page had
    /// been failing (log the recovery once).
    fn note_good(&self, url: String) -> bool {
        match self.schedule.lock() {
            Ok(mut slot) => slot.note_good(url),
            Err(_) => false,
        }
    }

    /// Record one failed page navigation and schedule its retry. The first
    /// failure of a burst logs loudly (the field-log fingerprint of the
    /// whole incident class), the repeats stay quiet.
    fn arm(&self, url: String, web_error_status: i32) {
        let attempt = match self.schedule.lock() {
            Ok(mut slot) => slot.arm(url.clone(), Instant::now(), web_error_status),
            Err(_) => return, // a wedged lock must never panic the UI thread
        };
        if attempt == 1 {
            tracing::warn!(
                url = %url,
                web_error_status,
                "overlay page failed to load — the retry loop will re-navigate it",
            );
        } else {
            tracing::debug!(web_error_status, attempt, "overlay page load failed again");
        }
    }

    /// Hand over one due retry.
    fn take_due(&self) -> Option<(String, u32)> {
        self.schedule.lock().ok()?.take_due(Instant::now())
    }

    /// The fallback retry target when a failure's own `Source` is unusable.
    fn fallback_url(&self) -> Option<String> {
        self.schedule.lock().ok()?.fallback_url()
    }

    /// Reset the schedule after a success without a usable URL (the page
    /// recovered some other way); true when it had been failing.
    fn reset(&self) -> bool {
        match self.schedule.lock() {
            Ok(mut slot) => slot.reset(),
            Err(_) => false,
        }
    }
}

/// The retry loop: one due navigation per tick, exiting within a tick of
/// the window's teardown. A detached thread — same shape as the Tab
/// watcher, talking to the shell only through thread-safe dispatches.
fn retry_loop(app: AppHandle, label: String, shared: Arc<RecoveryShared>) {
    loop {
        std::thread::sleep(RETRY_TICK);
        if app.get_webview_window(&label).is_none() {
            // Overlay mode tore the window down — nothing left to heal. A
            // destroy→recreate of the same label inside one tick would only
            // briefly leave this thread polling beside the new window's own
            // (it holds the OLD schedule, whose stale retry is the same page
            // URL at worst); overlay cycles are user-paced, ≫ one tick.
            return;
        }
        let Some((url, attempt)) = shared.take_due() else {
            continue;
        };
        let Some(win) = app.get_webview_window(&label) else {
            return;
        };
        match tauri::Url::parse(&url) {
            Ok(url) => match win.navigate(url) {
                Ok(()) => {
                    tracing::info!(window = %label, attempt, "overlay page retry navigation sent")
                },
                Err(error) => {
                    tracing::warn!(window = %label, attempt, error = %error, "overlay page retry navigation failed")
                },
            },
            Err(error) => {
                tracing::warn!(window = %label, error = %error, "overlay page retry url unparsable")
            },
        }
    }
}

fn spawn_retry_thread(app: AppHandle, label: String, shared: Arc<RecoveryShared>) {
    let spawned = std::thread::Builder::new()
        .name(format!("{label}-page-retry"))
        .spawn(move || retry_loop(app, label, shared));
    if let Err(error) = spawned {
        tracing::warn!(error = %error, "overlay page-retry thread spawn failed");
    }
}

/// The Windows watcher: a `NavigationCompleted` COM handler on the window's
/// CoreWebView2, feeding the shared schedule. Registered through
/// `with_webview` — `webview2-com` is the same 0.39/0.62 line wry pulls,
/// so the types unify with the runtime's own.
#[cfg(target_os = "windows")]
fn install_windows(app: &AppHandle, win: &tauri::WebviewWindow, page_file: &'static str) {
    let label = win.label().to_string();
    let shared = Arc::new(RecoveryShared::default());
    let watcher_shared = shared.clone();
    let watcher_label = label.clone();
    let armed_label = label.clone();
    let install_result = win.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            tracing::warn!(window = %watcher_label, "overlay page-load watcher found no CoreWebView2");
            return;
        };
        let handler = NavigationCompletedEventHandler::create(Box::new(
            move |webview: Option<ICoreWebView2>, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut success = BOOL::default();
                if args.IsSuccess(&mut success).is_err() {
                    return Ok(());
                }
                // The webview's own Source at completion — the URL the error
                // card sits on for a failed reload, or the fresh page's URL.
                let source = webview.as_ref().and_then(source_of);
                if success.as_bool() {
                    let healed = match source {
                        Some(url) if uri_targets_page(&url, page_file) => {
                            watcher_shared.note_good(url)
                        }
                        _ => watcher_shared.reset(),
                    };
                    if healed {
                        tracing::info!(window = %watcher_label, "overlay page recovered after failed loads");
                    }
                    return Ok(());
                }
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS(-1);
                if args.WebErrorStatus(&mut status).is_err() {
                    status = COREWEBVIEW2_WEB_ERROR_STATUS(-1);
                }
                match source.filter(|url| uri_targets_page(url, page_file))
                    .or_else(|| watcher_shared.fallback_url())
                {
                    Some(url) => watcher_shared.arm(url, status.0),
                    None => tracing::debug!(
                        window = %watcher_label,
                        web_error_status = status.0,
                        "overlay page navigation failed without a retryable url",
                    ),
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        match core.add_NavigationCompleted(&handler, &mut token) {
            Ok(()) => tracing::debug!(window = %armed_label, page = %page_file, "overlay page-load failure watcher armed"),
            Err(error) => tracing::warn!(window = %armed_label, error = %error, "overlay page-load watcher registration failed"),
        }
    });
    if let Err(error) = install_result {
        tracing::warn!(window = %label, error = %error, "overlay page-load watcher install failed");
        return;
    }
    spawn_retry_thread(app.clone(), label, shared);
}

/// The webview's current top-level URI (`Source`), `None` when the read
/// fails — a watcher never panics the UI thread over a string.
#[cfg(target_os = "windows")]
fn source_of(webview: &ICoreWebView2) -> Option<String> {
    let mut uri = PWSTR::null();
    // SAFETY: COM call on the live webview, on the UI thread the event runs on.
    if unsafe { webview.Source(&mut uri) }.is_err() {
        return None;
    }
    Some(take_pwstr(uri))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_is_short_then_steady() {
        assert_eq!(retry_delay(1), Duration::from_secs(1));
        assert_eq!(retry_delay(2), Duration::from_secs(2));
        assert_eq!(retry_delay(3), Duration::from_secs(4));
        assert_eq!(retry_delay(4), Duration::from_secs(8));
        assert_eq!(retry_delay(5), MAX_RETRY_DELAY);
        assert_eq!(retry_delay(50), MAX_RETRY_DELAY);
    }

    #[test]
    fn uri_guard_matches_only_the_window_page() {
        // dev origin with the realm/locale query — the exact URL the window carries
        assert!(uri_targets_page(
            "http://127.0.0.1:5199/overlay.html?realm=cn&locale=zh-CN",
            "overlay.html",
        ));
        // release custom-protocol origin
        assert!(uri_targets_page(
            "http://tauri.localhost/overlay.html",
            "overlay.html"
        ));
        // a sibling family page must not arm this window's retry
        assert!(!uri_targets_page(
            "http://127.0.0.1:5199/aimcard.html",
            "overlay.html"
        ));
        assert!(!uri_targets_page(
            "http://127.0.0.1:5199/index.html",
            "overlay.html"
        ));
        // a lookalike path suffix is not the page either
        assert!(!uri_targets_page(
            "http://127.0.0.1:5199/not-overlay.html",
            "overlay.html"
        ));
        // non-URL junk never arms
        assert!(!uri_targets_page("about:blank", "overlay.html"));
        assert!(!uri_targets_page("", "overlay.html"));
    }

    #[test]
    fn schedule_arms_takes_and_resets() {
        let mut s = Schedule::default();
        let t0 = Instant::now();
        // Two failures of one burst: attempt 2 is armed, due one backoff step out.
        assert_eq!(s.arm("http://x/overlay.html".into(), t0, 12), 1);
        assert_eq!(s.arm("http://x/overlay.html".into(), t0, 12), 2);
        assert_eq!(s.take_due(t0), None);
        assert_eq!(
            s.take_due(t0 + retry_delay(2)),
            Some(("http://x/overlay.html".into(), 2)),
        );
        // Consumed: the next tick finds nothing until a fresh failure arms again.
        assert_eq!(s.take_due(t0 + retry_delay(2)), None);
        // A success resets; a second one reports no recovery.
        assert!(s.note_good("http://x/overlay.html".into()));
        assert!(!s.note_good("http://x/overlay.html".into()));
        assert_eq!(s.take_due(t0 + retry_delay(2)), None);
        assert_eq!(s.attempts, 0);
    }

    #[test]
    fn failure_falls_back_to_the_last_good_url() {
        let mut s = Schedule::default();
        let t0 = Instant::now();
        // No good URL yet: a failure whose Source is unusable has nothing to arm.
        assert_eq!(s.fallback_url(), None);
        // The page loaded once: that URL becomes the fallback.
        s.note_good("http://x/overlay.html".into());
        assert_eq!(s.fallback_url().as_deref(), Some("http://x/overlay.html"));
        // arm() stores whatever target it is handed verbatim — the
        // about:blank → good-URL substitution lives in the COM handler's
        // source.filter(...) above it, which this unit cannot reach.
        s.arm("about:blank".into(), t0, 12);
        assert_eq!(
            s.take_due(t0 + retry_delay(1)),
            Some(("about:blank".into(), 1)),
        );
    }
}
