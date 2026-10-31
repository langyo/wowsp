//! Force-close fallback for the main window's close button.
//!
//! The close button (and any programmatic `close()`) arrives as
//! `WindowEvent::CloseRequested`, and the shell never closes the window from
//! that handler: it prevents the default close and emits `close-requested` so
//! the webui can ask "quit or minimize to tray?" and run its own teardown
//! (see the handler in `lib.rs`). That contract has one failure mode with no
//! recovery of its own: the renderer is gone — WebView2 process death, a
//! renderer hang, or a page that crashed before its JS registered the
//! listener. The event then lands nowhere, no frontend ever answers, and a
//! window that already handled WM_CLOSE stays up forever: the user's close
//! click produces an unclosable window whose only remaining exit is the tray's
//! Quit (or Task Manager).
//!
//! This module is the dead-man switch for exactly that case. Every close
//! request arms a one-shot watchdog ([`arm_close_watchdog`]) with a fresh
//! epoch token ([`CloseGuard::arm`]). The webui's `close-requested` listener
//! acknowledges as its FIRST action through the `close_requested_ack` command
//! (`crate::commands::close_requested_ack`), which bumps the epoch
//! ([`CloseGuard::ack`]) and makes the armed token stale. A watchdog that
//! wakes to a stale token stands down silently; one whose token is still
//! current after [`FORCE_CLOSE_AFTER`] knows the frontend never heard (or
//! never answered) the request, logs a warning and force-quits through
//! `crate::commands::graceful_exit` — the same drain-then-exit path the close
//! dialog's Quit uses, so background tasks still wind down.
//!
//! The epoch also serialises overlapping close requests: a second close click
//! arms a newer token, and the older watchdog wakes up stale — it must never
//! kill a window that a newer request is still negotiating for. Arming happens
//! BEFORE the event is emitted (see `lib.rs`), so a fast acknowledgement can
//! never be overwritten by a late arm.
//!
//! Everything except [`arm_close_watchdog`] is cross-platform: the command is
//! registered on every target (the IPC surface is shared), while mobile never
//! arms a watchdog (no tray, the system back gesture just closes the app).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// How long the frontend gets to answer a `close-requested` event before the
/// shell force-quits.
///
/// The ack is the listener's first statement, so this budget is NOT how long
/// the user may take on the quit-confirm dialog — acknowledging disarms the
/// watchdog before that dialog even shows. It covers a renderer that was
/// alive when the emit was queued but died before running the listener, plus
/// the IPC round-trip in the healthy case: an order of magnitude above a
/// normal round-trip, and short enough that a wedged close reads as a slow
/// quit rather than a hang.
const FORCE_CLOSE_AFTER: Duration = Duration::from_secs(5);

/// Epoch-based arming state for the close watchdog.
///
/// The epoch is bumped by both sides — arming a request and acknowledging it —
/// and only a token equal to the CURRENT epoch is a live arm. Tokens are the
/// epoch value the arm produced, so any later arm or ack invalidates every
/// earlier token without tracking them.
///
/// All accesses are `SeqCst`: the epoch is the only shared state, and the
/// arm / emit / ack / wake-up sequence genuinely spans threads (the window
/// event handler, Tauri's IPC dispatch for the command, and the watchdog
/// thread), so a single total order is both the simplest argument and
/// effectively free at this once-per-close rate.
pub(crate) struct CloseGuard {
    epoch: AtomicU64,
}

impl CloseGuard {
    /// A guard with epoch 0: nothing is armed (0 is never handed out as a
    /// token, so `is_current(0)` may be true but no watchdog ever holds it).
    pub const fn new() -> Self {
        Self {
            epoch: AtomicU64::new(0),
        }
    }

    /// Arm one close request and return its token: the epoch value this arm
    /// owns. Invalidates every token returned before it.
    pub fn arm(&self) -> u64 {
        // fetch_add returns the PREVIOUS value; the token is the new epoch.
        // The wrapping add only matters at the theoretical u64 wrap (never
        // reached in a real session) and keeps debug overflow checks quiet.
        self.epoch.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
    }

    /// Disarm the current arm — the frontend acknowledged the request. Any
    /// watchdog still sleeping now wakes up stale.
    pub fn ack(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Whether `token` is still the current arm (no ack and no newer arm
    /// since it was taken).
    pub fn is_current(&self, token: u64) -> bool {
        self.epoch.load(Ordering::SeqCst) == token
    }
}

impl Default for CloseGuard {
    /// Equivalent to [`CloseGuard::new`]; present so the constructor keeps
    /// its const signature without tripping `clippy::new_without_default`.
    fn default() -> Self {
        Self::new()
    }
}

/// The process-wide guard the close handler (`lib.rs`) arms and the
/// `close_requested_ack` command disarms.
pub(crate) static CLOSE_GUARD: CloseGuard = CloseGuard::new();

/// Arm [`CLOSE_GUARD`] and start the one-shot watchdog thread for one close
/// request, returning the epoch token the caller logs.
///
/// Call this BEFORE emitting `close-requested` — the ack can only arrive
/// after the emit, so arming first guarantees the ack's epoch bump is newer
/// than this token (the reverse order would let an ack land in between and
/// then be overwritten by the arm, leaving the watchdog armed against a
/// webview that DID answer).
///
/// A spawn failure only disables this fallback: the normal dialog path is
/// unaffected, but an unresponsive renderer would once again leave the window
/// unclosable, so it is logged as a warning rather than swallowed.
#[cfg(desktop)]
pub(crate) fn arm_close_watchdog(app: tauri::AppHandle) -> u64 {
    let token = CLOSE_GUARD.arm();
    let spawned = std::thread::Builder::new()
        .name("wowsp-close-watchdog".into())
        .spawn(move || {
            std::thread::sleep(FORCE_CLOSE_AFTER);
            if !CLOSE_GUARD.is_current(token) {
                tracing::debug!(token, "close watchdog stood down: request acknowledged");
                return;
            }
            tracing::warn!(
                token,
                timeout_secs = FORCE_CLOSE_AFTER.as_secs(),
                "close-requested went unanswered; force-quitting the shell",
            );
            crate::commands::graceful_exit(&app);
        });
    if let Err(err) = spawned {
        tracing::warn!(
            error = %err,
            "close watchdog thread did not spawn; an unresponsive webview would leave the window unclosable",
        );
    }
    token
}

#[cfg(test)]
mod tests {
    use super::CloseGuard;

    /// A fresh guard has no live arm: the first arm hands out epoch 1 (epoch 0
    /// is reserved as "nothing armed") and repeated arms strictly increase.
    #[test]
    fn arms_return_increasing_tokens() {
        let guard = CloseGuard::new();
        let first = guard.arm();
        let second = guard.arm();
        assert_eq!(first, 1);
        assert!(second > first);
        assert!(guard.is_current(second));
        assert!(!guard.is_current(first));
    }

    /// The acknowledgement must invalidate the armed token — this is what
    /// turns a healthy close (dialog shown) into a stood-down watchdog.
    #[test]
    fn ack_invalidates_the_armed_token() {
        let guard = CloseGuard::new();
        let token = guard.arm();
        assert!(guard.is_current(token));
        guard.ack();
        assert!(!guard.is_current(token));
    }

    /// An ack leaves NO token current, including tokens it never saw armed —
    /// and a repeated ack must not make a stale token current again.
    #[test]
    fn ack_never_revives_a_stale_token() {
        let guard = CloseGuard::new();
        let token = guard.arm();
        guard.ack();
        guard.ack();
        assert!(!guard.is_current(token));
    }

    /// A newer arm invalidates the older token: the stale watchdog must exit
    /// instead of force-quitting during the newer request's dialog.
    #[test]
    fn rearm_invalidates_the_previous_token() {
        let guard = CloseGuard::new();
        let first = guard.arm();
        let second = guard.arm();
        assert!(!guard.is_current(first));
        assert!(guard.is_current(second));
    }
}
