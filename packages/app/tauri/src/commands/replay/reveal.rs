//! Reveal one replay file in the OS file manager (desktop: the phone shell
//! has no file manager to reveal into). Split from [`listing`] so the
//! walk/list module keeps carrying only directory scans.

use anyhow::{Result, anyhow, bail};
use std::path::PathBuf;

use wowsp_tauri_shared::CommandResult;

/// Open one replay file's folder in the system file manager with the file
/// selected — the replay rail's "show in folder" action. Same opener
/// tooling as logs_reveal_latest and the crash-report export; no
/// explorer.exe is spawned by hand.
///
/// The path arrives from the webui but is validated like untrusted input
/// (the mod_hub_reveal_path philosophy): it must name an EXISTING replay
/// file (extension matched through the same classifier the rail's walk
/// lists — .wowsreplay and Lesta's .korablireplay, case-insensitively;
/// nothing else is revealed), which is then canonicalized before the
/// opener receives it —
/// junctions/symlinks resolve to their target and the \\?\
/// extended-length prefix std::fs::canonicalize adds on Windows is
/// stripped (dunce::canonicalize), so the shell's folder-and-select call
/// gets the plain real path.
///
/// Main-window only, like every state-touching command
/// (crate::commands::ensure_main_window_label). A rejected path is a plain
/// user-visible message.
#[tauri::command]
pub fn replays_reveal(
    path: String,
    window: tauri::Window,
    app: tauri::AppHandle,
) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    let target = resolve_reveal_target(&path)?;
    use tauri_plugin_opener::OpenerExt;

    tracing::info!(?target, "revealing replay file in file manager");
    Ok(app
        .opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| anyhow!("reveal {}: {e}", target.display()))?)
}

/// The validated + canonicalized reveal target behind replays_reveal —
/// split out so the guards are unit-testable without a window / opener.
fn resolve_reveal_target(raw: &str) -> Result<PathBuf> {
    if raw.is_empty() {
        bail!("empty replay path");
    }
    let path = std::path::Path::new(raw);
    // Same vocabulary the scan lists: a Lesta client's .korablireplay row
    // is revealed exactly like a .wowsreplay one.
    let is_replay = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(super::game_client::is_replay_extension);
    if !is_replay {
        bail!("not a replay file: {raw}");
    }
    let meta = std::fs::metadata(path).map_err(|e| anyhow!("stat {raw}: {e}"))?;
    if !meta.is_file() {
        bail!("not a file: {raw}");
    }
    dunce::canonicalize(path).map_err(|e| anyhow!("resolve {raw}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_target_rejects_empty_and_non_replay_paths() {
        assert!(resolve_reveal_target("").is_err());
        assert!(resolve_reveal_target("C:/Games/replays/clip.txt").is_err());
        assert!(resolve_reveal_target("C:/Games/replays/clip.korablireplay.txt").is_err());
        // A dotfile-style bare extension is not a replay either.
        assert!(resolve_reveal_target("C:/Games/replays/.wowsreplay").is_err());
    }

    #[test]
    fn reveal_target_accepts_an_existing_replay_case_insensitively() {
        let tmp = std::env::temp_dir().join("wowsp_reveal_target_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("20250622_152405_Hotaka_15_NE_north.wowsreplay");
        std::fs::write(&file, b"PK").unwrap();

        let target = resolve_reveal_target(&file.to_string_lossy()).unwrap();
        assert!(target.is_file());
        assert_eq!(target.file_name().unwrap(), file.file_name().unwrap());

        // Extension match is case-insensitive.
        let upper = tmp.join("LOWER.WOWSREPLAY");
        std::fs::write(&upper, b"PK").unwrap();
        assert!(resolve_reveal_target(&upper.to_string_lossy()).is_ok());

        // The walk's other replay extension — a Lesta client's row.
        let lesta = tmp.join("20250622_152405.korablireplay");
        std::fs::write(&lesta, b"PK").unwrap();
        assert!(resolve_reveal_target(&lesta.to_string_lossy()).is_ok());

        // A directory wearing the extension is not a file.
        let dir = tmp.join("dir.wowsreplay");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_reveal_target(&dir.to_string_lossy()).is_err());

        // A missing file is rejected before any canonicalization.
        let missing = tmp.join("missing.wowsreplay");
        assert!(resolve_reveal_target(&missing.to_string_lossy()).is_err());

        std::fs::remove_dir_all(&tmp).ok();
    }
}
