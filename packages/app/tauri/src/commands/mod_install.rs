//! Mod installer (milestone M6).
//!
//! Overlay mode needs WoWSP to launch alongside the game. The cleanest hook the
//! game exposes is a mod file under `bin/<version>/res_mods/`: the WoWS client
//! loads Python mods from there at startup. A PnFMods.py loader + WoWSP.py
//! payload are written into the game directory; WoWSP.py uses the BigWorld
//! Python mod API to spawn the WoWSP process on game load and terminate it on
//! game disconnect.

use std::fs;
use std::path::PathBuf;

/// Files WoWSP drops into res_mods to mark itself installed. The PnFMods.py
/// loader is the conventional WoWS mod entrypoint; `WoWSP.py` is our payload.
const MOD_FILES: &[(&str, &str)] = &[
    (
        "PnFMods.py",
        "import WoWSP\n",
    ),
    ("WoWSP.py", include_str!("../../../mod_templates/WoWSP.py")),
];

/// Locate the newest `bin/<version>/` directory in a game install (the client
/// runs from the highest-numbered version dir).
fn latest_bin_version(game_root: &str) -> Option<PathBuf> {
    let bin = PathBuf::from(game_root).join("bin");
    let mut newest: Option<(u64, PathBuf)> = None;
    for ent in fs::read_dir(bin).ok()?.flatten() {
        let name = ent.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if let Ok(n) = name_str.parse::<u64>() {
            let path = ent.path();
            if newest.as_ref().is_none_or(|(v, _)| n > *v) {
                newest = Some((n, path));
            }
        }
    }
    newest.map(|(_, p)| p)
}

fn res_mods_dir(game_root: &str) -> Result<PathBuf, String> {
    let ver = latest_bin_version(game_root)
        .ok_or_else(|| format!("no numeric bin/<version> under {game_root}/bin"))?;
    Ok(ver.join("res_mods"))
}

/// Install the WoWSP overlay mod files into the game's res_mods. Returns the
/// res_mods path that was written to.
#[tauri::command]
pub fn install_overlay_mod(game_root: String) -> Result<String, String> {
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
pub fn uninstall_overlay_mod(game_root: String) -> Result<(), String> {
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
        let v = latest_bin_version(tmp.to_str().unwrap()).unwrap();
        assert!(v.ends_with("12668706"), "got {v:?}");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn install_then_uninstall_is_idempotent() {
        let tmp = std::env::temp_dir().join("wowsp_modinstall_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("bin/12668706")).unwrap();
        let root = tmp.to_str().unwrap().to_string();

        assert!(!is_overlay_mod_installed(root.clone()).unwrap());
        let dir = install_overlay_mod(root.clone()).unwrap();
        assert!(PathBuf::from(&dir).join("WoWSP.py").is_file());
        assert!(is_overlay_mod_installed(root.clone()).unwrap());

        uninstall_overlay_mod(root.clone()).unwrap();
        assert!(!is_overlay_mod_installed(root.clone()).unwrap());
        // Second uninstall must not error (idempotent).
        uninstall_overlay_mod(root).unwrap();
        fs::remove_dir_all(&tmp).ok();
    }
}
