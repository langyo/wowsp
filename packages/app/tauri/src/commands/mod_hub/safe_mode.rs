use super::*;

// ── Safe mode ────────────────────────────────────────────────────────────────

/// Is safe mode visible — the current `res_mods` quarantined, or a twin
/// stranded in an old version dir by a game update?
#[tauri::command]
pub fn mod_hub_safe_mode(game_root: String) -> Result<bool, String> {
    Ok(safe_mode_active(&game_root))
}

/// Quarantine (or restore) the current version's `res_mods` in one atomic
/// rename — WG's "safe mode" support move: run the game fully vanilla
/// without deleting anything, the fastest way to bisect a crash.
#[tauri::command]
pub async fn mod_hub_set_safe_mode(game_root: String, enabled: bool) -> Result<bool, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    ensure_game_closed(&game_root)?;
    set_safe_mode_core(&game_root, enabled)
}
