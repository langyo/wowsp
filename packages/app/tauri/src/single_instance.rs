//! Single-instance (duplicate-launch) guard for the desktop shell.
//!
//! Two named Windows kernel objects coordinate the app's copies:
//!
//! - a named **mutex** decides ownership: the first process to create it is
//!   the primary; a process that finds it already existing is a secondary
//!   (a duplicate launch), which boots as a lightweight notice shell — no
//!   tray icon, no telemetry/session pollers, no app migrations (see the
//!   setup gating in `lib.rs`);
//! - a named **auto-reset event** lets a secondary poke the primary: the
//!   confirm button on the duplicate-notice dialog signals it, and the
//!   primary's watcher thread restores the main window in response (the
//!   same show/unminimize/focus a tray double-click performs).
//!
//! Kernel objects (rather than a lock file) are used on purpose: the
//! kernel destroys them the moment the owning process's last handle goes
//! away, so a crashed or killed primary can never leave a stale lock that
//! would block every later launch.
//!
//! Windows-only internals: the desktop product ships Windows bundles only
//! (see release.yml's `runs-on: windows-latest`), so every other target
//! compiles this module as inert no-ops — `probe()` reports primary,
//! `is_secondary()` stays false, nothing is watched or signaled. The
//! public API below must therefore stay callable from un-gated call sites
//! (lib.rs setup, the IPC commands).

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether [`probe`] found another process already owning the instance
/// mutex. Once true this process is a secondary (duplicate launch) for the
/// rest of its lifetime; nothing ever resets it.
static SECONDARY: AtomicBool = AtomicBool::new(false);

/// One-shot boot probe, called at the very top of [`crate::run`] — before
/// the Tauri builder, so every later startup decision (setup gating, IPC)
/// sees the settled flag. The primary claims the mutex and parks the
/// focus-event handle; the secondary only records its role.
pub fn probe() {
    #[cfg(windows)]
    {
        match imp::detect_via_mutex(imp::LOCK_MUTEX_NAME) {
            Some(mutex) => {
                // Primary: hold the mutex for the whole process lifetime.
                // The handle is deliberately never closed (see OWNED_MUTEX).
                imp::OWNED_MUTEX.store(mutex, Ordering::Release);
                let event = imp::create_focus_event();
                if event.is_null() {
                    tracing::warn!(
                        "focus event creation failed; duplicate launches will not be able to raise this window"
                    );
                } else {
                    tracing::debug!(
                        "primary instance: single-instance lock held, focus event ready"
                    );
                }
                imp::FOCUS_EVENT.store(event, Ordering::Release);
            },
            None => {
                SECONDARY.store(true, Ordering::Release);
                tracing::warn!(
                    "another WoWSP copy already owns the single-instance lock: booting as the duplicate-launch notice shell"
                );
            },
        }
    }
    // Non-Windows targets have no lock at all: the flag stays false and
    // every other entry point is a no-op.
    #[cfg(not(windows))]
    {}
}

/// True when [`probe`] marked this process a duplicate launch.
pub fn is_secondary() -> bool {
    SECONDARY.load(Ordering::Acquire)
}

/// Primary only: spawn the detached watcher thread that waits on the focus
/// event and restores the main window whenever a secondary signals it. The
/// thread loops forever and dies with the process; a wait/dispatch failure
/// is logged and ends the thread (the app itself keeps running — losing
/// the focus hand-off is not worth crashing over).
pub fn start_focus_watcher(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        let event = imp::FOCUS_EVENT.load(Ordering::Acquire);
        if event.is_null() {
            tracing::warn!("no focus event; duplicate-launch focus hand-off disabled");
            return;
        }
        let watcher = imp::FocusWatcher { app, event };
        match std::thread::Builder::new()
            .name("wowsp-instance-focus".into())
            .spawn(move || watcher.run())
        {
            Ok(_) => tracing::debug!("single-instance focus watcher thread started"),
            Err(e) => tracing::warn!(error = %e, "failed to spawn the focus watcher thread"),
        }
    }
    // Nothing to watch off Windows — the flag can never mark a secondary.
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// Secondary only: pulse the focus event so the primary's watcher brings
/// its window back to the front. Called right before the duplicate exits;
/// failures are logged and otherwise ignored (non-fatal — the duplicate
/// still exits and the user can always click the primary's taskbar entry).
pub fn signal_primary_to_focus() {
    #[cfg(windows)]
    {
        if !is_secondary() {
            return;
        }
        let name = imp::wide(imp::FOCUS_EVENT_NAME);
        let handle = unsafe {
            windows_sys::Win32::System::Threading::OpenEventW(
                windows_sys::Win32::System::Threading::EVENT_MODIFY_STATE,
                0,
                name.as_ptr(),
            )
        };
        if handle.is_null() {
            tracing::warn!(
                "open focus event failed (the primary may have exited); focusing skipped"
            );
            return;
        }
        let signaled = unsafe { windows_sys::Win32::System::Threading::SetEvent(handle) };
        // Close the borrowed reference again — the primary owns the object;
        // leaving this open would only leak a handle for the moments before
        // the process exits.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        if signaled == 0 {
            tracing::warn!("signal focus event failed; the primary window stays where it is");
        }
    }
    #[cfg(not(windows))]
    {}
}

/// Windows kernel-object plumbing behind the API above.
#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::AtomicPtr;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, INFINITE, WaitForSingleObject,
    };

    /// Kernel object names, `Local\`-scoped to the current login session
    /// (the app is a per-user desktop tool; two Windows user sessions each
    /// get their own single instance, which is the expected behavior).
    /// The `-v1` suffix leaves room for a protocol change without fighting
    /// an old running build over the same object.
    pub(super) const LOCK_MUTEX_NAME: &str = "Local\\wowsp-single-instance-lock-v1";
    pub(super) const FOCUS_EVENT_NAME: &str = "Local\\wowsp-single-instance-focus-v1";

    /// The instance-mutex handle the primary holds for the whole process
    /// lifetime. Deliberately never closed and never released: dropping
    /// the last handle would destroy the kernel object while this process
    /// still runs, letting the next launch believe it is the primary. The
    /// value is parked in a static to document that ownership — HANDLE is
    /// a plain raw pointer, so this only records it; the open handle (not
    /// the stored value) is what keeps the kernel object alive.
    pub(super) static OWNED_MUTEX: AtomicPtr<c_void> = AtomicPtr::new(null_mut());

    /// The primary's focus event (auto-reset). Null when creation failed
    /// or on secondaries — they only OpenEvent it on their way out.
    pub(super) static FOCUS_EVENT: AtomicPtr<c_void> = AtomicPtr::new(null_mut());

    /// NUL-terminated UTF-16 encoding of a kernel object name — the W
    /// entry points take PCWSTR and never read past the terminator.
    pub(super) fn wide(name: &str) -> Vec<u16> {
        name.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Create (or find) the named instance mutex and report ownership of
    /// it: `Some(handle)` = this process created it (primary; the caller
    /// must keep the handle open), `None` = another process already owns
    /// it (secondary; the borrowed handle is closed again so the duplicate
    /// holds no reference of its own). An outright creation failure fails
    /// OPEN as a primary with a null handle — a flaky API must never
    /// block launching the app behind a duplicate-notice dialog.
    pub(super) fn detect_via_mutex(name: &str) -> Option<HANDLE> {
        let wide_name = wide(name);
        let handle = unsafe { CreateMutexW(null(), 0, wide_name.as_ptr()) };
        // Read the error IMMEDIATELY after the create call: any intervening
        // code (logging included) may overwrite the thread's last error.
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if handle.is_null() {
            tracing::warn!("single-instance mutex creation failed; proceeding unguarded");
            return Some(null_mut());
        }
        if already_exists {
            unsafe { CloseHandle(handle) };
            tracing::debug!("instance mutex already owned by another process");
            return None;
        }
        Some(handle)
    }

    /// Create the focus event: auto-reset (`bManualReset = 0`, so one
    /// SetEvent wakes exactly one WaitForSingleObject) and initially
    /// nonsignaled. Null on failure — callers treat that as "focus
    /// hand-off unavailable", never as a launch blocker.
    pub(super) fn create_focus_event() -> HANDLE {
        let name = wide(FOCUS_EVENT_NAME);
        let handle = unsafe { CreateEventW(null(), 0, 0, name.as_ptr()) };
        if handle.is_null() {
            let err = unsafe { GetLastError() };
            tracing::warn!(error = err, "focus event creation failed");
        }
        handle
    }

    /// The primary's watcher thread body. A raw HANDLE is a raw pointer
    /// (not `Send`), but to the OS it is just an integer — moving the copy
    /// into the spawned thread is sound, hence the manual impl.
    pub(super) struct FocusWatcher {
        pub app: tauri::AppHandle,
        pub event: HANDLE,
    }

    // SAFETY: the handle value is an inert integer on another thread; the
    // OS keeps the object alive through the primary's stored handle, and
    // only this thread touches the value after the spawn.
    unsafe impl Send for FocusWatcher {}

    impl FocusWatcher {
        /// Loop on the focus event forever (the thread dies with the
        /// process). One SetEvent from a secondary = one window restore.
        pub fn run(self) {
            use tauri::Manager;
            loop {
                let waited = unsafe { WaitForSingleObject(self.event, INFINITE) };
                if waited != WAIT_OBJECT_0 {
                    tracing::warn!(waited, "focus event wait failed; focus watcher exits");
                    return;
                }
                // Window calls must run on Tauri's main thread; the handle
                // is cloned into the closure (AppHandle is Send + Clone).
                let app = self.app.clone();
                if let Err(e) = self.app.run_on_main_thread(move || {
                    // Mirror the tray double-click restore exactly: drop the
                    // tray panel so the two surfaces never overlap, then
                    // bring the main window back however it was hidden
                    // (tray-minimized or plain minimized).
                    crate::commands::tray_panel::hide_panel(&app);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }) {
                    tracing::warn!(
                        error = %e,
                        "dispatching the focus restore to the main thread failed; focus watcher exits"
                    );
                    return;
                }
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp;

    /// A second detection against a mutex this process already owns must
    /// report secondary — the exact transition a real duplicate launch
    /// sees against the primary's mutex. The probe name is process-unique
    /// (not the shipped LOCK_MUTEX_NAME) so a concurrently running WoWSP
    /// instance on the same machine can never flip the first leg; the
    /// first handle is intentionally leaked (kept open) so the second call
    /// observes the held object, exactly like a primary that never closes.
    #[test]
    fn detection_twice_in_one_process_flips_to_secondary() {
        let name = format!("Local\\wowsp-single-instance-test-{}", std::process::id());
        let first = imp::detect_via_mutex(&name);
        assert!(
            first.is_some(),
            "first detection in a fresh process owns the mutex"
        );
        assert!(
            imp::detect_via_mutex(&name).is_none(),
            "second detection against the held mutex reports secondary"
        );
    }
}
