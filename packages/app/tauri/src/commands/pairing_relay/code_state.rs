use super::*;
// ── live pairing-code state (desktop) ────────────────────────────────────────

/// The gateway-allocated pairing code for the CURRENT host session, shared
/// between the bridge task (writer) and the pairing server (status display +
/// extra /pair secret). `None` = the gateway has not answered (yet) — the
/// desktop is in LAN-only fallback.
fn code_watch() -> &'static tokio::sync::watch::Sender<Option<String>> {
    static TX: OnceLock<tokio::sync::watch::Sender<Option<String>>> = OnceLock::new();
    TX.get_or_init(|| tokio::sync::watch::channel(None).0)
}

/// The pairing code the desktop currently displays (gateway-allocated), or
/// None while the gateway has not answered — pairing.rs falls back to its
/// locally-generated LAN PIN then.
pub fn current_relay_code() -> Option<String> {
    code_watch().subscribe().borrow().clone()
}

/// Whether the gateway is online for the current session (a code is live).
/// Tests read it directly; production callers read the code via
/// [`current_relay_code`] (None == offline, the LAN-only fallback).
#[cfg_attr(not(test), allow(dead_code))]
pub fn relay_online() -> bool {
    current_relay_code().is_some()
}

pub(super) fn store_code(code: Option<String>) {
    code_watch().send_if_modified(|current| {
        if *current != code {
            *current = code;
            true
        } else {
            false
        }
    });
}

/// Resolve when the watch holds a code DIFFERENT from `prev` (allocation is
/// always fresh — the directory guarantees uniqueness among live codes), or
/// time out. Used both for the first allocation at server start and for the
/// regenerate button.
pub(super) async fn wait_for_new_code(
    prev: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let mut rx = code_watch().subscribe();
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let current = rx.borrow().clone();
        if let Some(code) = current {
            if Some(code.as_str()) != prev {
                return Ok(code);
            }
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err("pairing code allocation timed out".to_string());
        }
        if tokio::time::timeout(deadline - now, rx.changed())
            .await
            .is_err()
        {
            return Err("pairing code allocation timed out".to_string());
        }
    }
}

/// Bounded wait for the FIRST allocation of a fresh session.
pub async fn wait_for_code(timeout: Duration) -> Result<String, String> {
    wait_for_new_code(None, timeout).await
}
