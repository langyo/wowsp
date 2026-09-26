//! Mod installer (milestone M6).
//!
//! Overlay mode needs WoWSP to launch alongside the game. The cleanest hook the
//! game exposes is a mod file under `bin/<version>/res_mods/`: the WoWS client
//! loads Python mods from there at startup. A full "launch WoWSP on game start"
//! mod requires the BigWorld Python mod API (PnFMods loader); this module lays
//! the file-structure groundwork and records install state, with the live
//! Python launcher stubbed as TODO.
//!
//! Status: `install_overlay_mod` / `uninstall_overlay_mod` / `is_overlay_mod_installed`
//! write/remove a marker file + a placeholder PnFMods loader under
//! `res_mods/<latest_bin_version>/`. The loader body is a TODO that, once the
//! BigWorld mod entrypoint is reverse-engineered, shells out to the WoWSP exe.
//!
//! Tracking: the placeholder ships until that reverse-engineering lands. Scope,
//! motivation and the remaining gaps are tracked in `docs/en/designs/mod-hub.md`
//! (M6 mod hub — "What exists today" lists this module, gap G8 covers PnFMods
//! script packs). There is no separate issue anchor, so update that document
//! when the loader contract is confirmed.

use std::fs;
use std::path::PathBuf;

/// Files WoWSP drops into res_mods to mark itself installed. The PnFMods.py
/// loader is the conventional WoWS mod entrypoint; `WoWSP.py` is our payload.
const MOD_FILES: &[(&str, &str)] = &[
    // The PnFMods loader the WoWS client imports at startup. The real body
    // registers WoWSP's payload; TODO(M6-bigworld): fill in once the loader
    // contract is confirmed against a running game. Tracked in
    // docs/en/designs/mod-hub.md (M6 mod hub) — a placeholder, not a finished
    // integration.
    (
        "PnFMods.py",
        "# WoWSP loader placeholder — see packages/app/tauri/src/commands/mod_install.rs\n",
    ),
    ("WoWSP.py", include_str!("../../../mod_templates/WoWSP.py")),
];

/// The res_mods target of a game install — the unified game context's
/// `bin/<version>` selection (idx-carrying build preferred, numeric
/// fallback).
fn res_mods_dir(game_root: &str) -> Result<PathBuf, String> {
    super::game_context::res_mods_dir(std::path::Path::new(game_root))
}

/// Install the WoWSP overlay mod files into the game's res_mods. Returns the
/// res_mods path that was written to. Gated and game-guarded like every
/// other res_mods mutation — an ungated write used to race install/rename
/// sweeps from the mod hub.
#[tauri::command]
pub async fn install_overlay_mod(game_root: String) -> Result<String, String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    let dir = res_mods_dir(&game_root)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    for (name, body) in MOD_FILES {
        let path = dir.join(name);
        fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Remove the WoWSP overlay mod files. Idempotent — missing files are fine.
#[tauri::command]
pub async fn uninstall_overlay_mod(game_root: String) -> Result<(), String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    let dir = res_mods_dir(&game_root)?;
    for (name, _) in MOD_FILES {
        let path = dir.join(name);
        match fs::remove_file(&path) {
            Ok(()) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("remove {}: {e}", path.display())),
        }
    }
    Ok(())
}

/// Report whether all WoWSP mod files are present in the game's res_mods.
#[tauri::command]
pub fn is_overlay_mod_installed(game_root: String) -> Result<bool, String> {
    let dir = res_mods_dir(&game_root)?;
    Ok(MOD_FILES.iter().all(|(name, _)| dir.join(name).is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_newest_bin_version() {
        let tmp = std::env::temp_dir().join("wowsp_modtest");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("bin/12668706/res_mods")).unwrap();
        fs::create_dir_all(tmp.join("bin/12506899/res_mods")).unwrap();
        fs::create_dir_all(tmp.join("bin/notaversion")).unwrap();
        let dir = res_mods_dir(tmp.to_str().unwrap()).unwrap();
        assert!(
            dir.ends_with(r"bin\12668706\res_mods") || dir.ends_with("bin/12668706/res_mods"),
            "got {dir:?}"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn install_then_uninstall_is_idempotent() {
        // The commands refuse to run against a live game client — a developer
        // testing with World of Warships open would otherwise see a false
        // failure here.
        if super::super::appdata::find_game_pid().is_some() {
            eprintln!("skipping: World of Warships is running");
            return;
        }
        let tmp = std::env::temp_dir().join("wowsp_modinstall_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("bin/12668706")).unwrap();
        let root = tmp.to_str().unwrap().to_string();

        assert!(!is_overlay_mod_installed(root.clone()).unwrap());
        let dir = tauri::async_runtime::block_on(install_overlay_mod(root.clone())).unwrap();
        assert!(PathBuf::from(&dir).join("WoWSP.py").is_file());
        assert!(is_overlay_mod_installed(root.clone()).unwrap());

        tauri::async_runtime::block_on(uninstall_overlay_mod(root.clone())).unwrap();
        assert!(!is_overlay_mod_installed(root.clone()).unwrap());
        // Second uninstall must not error (idempotent).
        tauri::async_runtime::block_on(uninstall_overlay_mod(root)).unwrap();
        fs::remove_dir_all(&tmp).ok();
    }
}
