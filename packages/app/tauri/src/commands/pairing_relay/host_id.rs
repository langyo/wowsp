use super::*;
/// The persistent host identity file (32 hex chars, created on first use).
pub(super) const HOST_ID_FILE: &str = "pairing-host-id.txt";

// ── persistent host identity ────────────────────────────────────────────────

/// The PERSISTENT host identity sent in every v2 hello handshake (`hostId`,
/// 32 hex chars). The gateway's directory keys "one active code per host" by
/// it, so a reconnect replaces the previous code instead of orphaning it.
/// Stored via the appdata helpers (`pairing-host-id.txt`, create-if-missing).
pub fn persistent_host_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        crate::paths::ensure_data_dir()
            .map(|dir| host_id_in(&dir))
            .unwrap_or_else(|_| random_host_id().unwrap_or_else(|_| "0".repeat(32)))
    })
    .clone()
}

/// `persistent_host_id` against an explicit directory (testable core): read
/// a valid id, or mint + persist one.
pub(super) fn host_id_in(dir: &std::path::Path) -> String {
    let path = dir.join(HOST_ID_FILE);
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim();
        if valid_host_id(t) {
            return t.to_ascii_lowercase();
        }
    }
    let id = random_host_id().unwrap_or_else(|_| "0".repeat(32));
    let _ = std::fs::write(&path, &id);
    id
}

fn valid_host_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn random_host_id() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| format!("os entropy: {e}"))?;
    Ok(hex::encode(buf))
}
