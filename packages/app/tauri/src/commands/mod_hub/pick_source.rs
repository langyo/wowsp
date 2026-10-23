//! Native source-folder picker for local installs (audit H-3 closure).
//!
//! The install's `source_root` used to be any path the webview named, so
//! a compromised webview could plant files from anywhere on disk (its own
//! appdata stash, another mod's folder, a temp dir it wrote via
//! `appdata_write`) into `res_mods`. The native folder dialog is the trust
//! anchor: install and classify only accept paths a dialog has handed out
//! this session. Same grant-registry shape as the export save grants
//! (`commands::exports`): sliding TTL so a retry after a failed install
//! still works, capped because every grant needs a human pick.

use anyhow::anyhow;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use wowsp_tauri_shared::CommandResult;

/// How long a picked source stays usable since its last successful use.
/// The sliding window keeps the analyze → preview → confirm flow (and a
/// retry after a failed install) working without a re-pick, while
/// bounding the table to recently-consented folders.
const SOURCE_GRANT_TTL: Duration = Duration::from_secs(3600);

/// Maximum live grants. Every grant needs a real folder pick in the
/// native dialog — a webview cannot mint grants on its own — so the cap
/// is table hygiene, not a security boundary.
const SOURCE_GRANT_CAP: usize = 16;

fn source_grants() -> &'static std::sync::Mutex<HashMap<String, Instant>> {
    static GRANTS: OnceLock<std::sync::Mutex<HashMap<String, Instant>>> = OnceLock::new();
    GRANTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Register `path` — exactly as the native folder dialog returned it — as
/// an installable source for this session.
///
/// Audit H-3 residual hardening: the app's own data tree is writable by a
/// compromised webview (`appdata_write`), so a source picked under it
/// would enable a preview-clean/install-hostile TOCTOU inside the grant
/// TTL. The grant is refused at pick time with a visible error instead.
pub(crate) fn grant_source_path(path: &str) -> anyhow::Result<()> {
    let data = match crate::paths::ensure_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "data dir unavailable — the source-grant data-root check is skipped"
            );
            std::path::PathBuf::new()
        },
    };
    if !data.as_os_str().is_empty() {
        // Both sides canonicalized (resolves symlinks / 8.3 short names /
        // relative segments) so the prefix comparison cannot be aliased
        // around; an unresolvable pick fails closed.
        let (Ok(picked), Ok(root)) = (
            std::path::Path::new(path).canonicalize(),
            data.canonicalize(),
        ) else {
            return Err(anyhow!(
                "the picked package source could not be resolved ({path})"
            ));
        };
        let picked_s = picked.to_string_lossy().to_ascii_lowercase();
        let root_s = format!("{}\\", root.to_string_lossy().to_ascii_lowercase());
        if picked_s == root_s.trim_end_matches('\\') || picked_s.starts_with(&root_s) {
            return Err(anyhow!(
                "the app data folder is not a valid mod package source ({path})"
            ));
        }
    }
    let mut grants = source_grants().lock().unwrap_or_else(|p| p.into_inner());
    // Drop expired entries first, then make room for the new grant by
    // evicting the oldest survivor. The map is tiny; a linear scan is the
    // cheap and obvious move.
    let now = Instant::now();
    grants.retain(|_, at| now.duration_since(*at) < SOURCE_GRANT_TTL);
    while grants.len() >= SOURCE_GRANT_CAP {
        let Some(oldest) = grants
            .iter()
            .min_by_key(|(_, at)| **at)
            .map(|(p, _)| p.clone())
        else {
            break;
        };
        grants.remove(&oldest);
    }
    grants.insert(path.to_string(), Instant::now());
    Ok(())
}

/// Does `path` carry a live grant? Slides the TTL forward on use, so an
/// actively-installed target never expires mid-flow.
pub(crate) fn source_path_granted(path: &str) -> bool {
    let mut grants = source_grants().lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    grants.retain(|_, at| now.duration_since(*at) < SOURCE_GRANT_TTL);
    match grants.get_mut(path) {
        Some(at) => {
            *at = now;
            true
        },
        None => false,
    }
}

/// The shared guard behind classify and install: a source path must have
/// been handed out by the native picker this session.
pub(crate) fn ensure_source_granted(source_root: &str) -> anyhow::Result<()> {
    if source_path_granted(source_root) {
        return Ok(());
    }
    Err(anyhow!(
        "package paths must be chosen through the folder picker ({source_root:?} was not picked this session)"
    ))
}

/// Open a native folder dialog for the local-package source. The picked
/// path is registered as an installable source and echoed for display;
/// classify and install refuse paths this session never picked.
#[tauri::command]
pub async fn mod_hub_pick_source(window: tauri::Window) -> CommandResult<Option<String>> {
    crate::commands::ensure_main_window_label(window.label())?;
    // Mobile: no native folder dialog — the local-package flow is a
    // desktop phase (same rule as pick_export_path).
    #[cfg(mobile)]
    {
        return Err(anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread (same rule as
    // pick_export_path / pick_replay_files / pick_game_folder).
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_title("Choose the mod package folder to install")
                .pick_folder()
        })
        .await
        .map_err(|e| anyhow!("mod source dialog task failed: {e}"))?;
        match picked.map(|p| p.to_string_lossy().into_owned()) {
            Some(path) => {
                grant_source_path(&path)?;
                Ok(Some(path))
            },
            None => Ok(None),
        }
    }
}

/// Serialize grant-table tests on the shared static (other command tests
/// grant in parallel — see tests.rs's archive probe) — mirror of the
/// export-grant lock. Module level so both this file's tests and
/// tests.rs can take it.
#[cfg(test)]
pub(crate) fn grant_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror of the export-grant tests: an expired grant is refused even
    /// though the path is still in the table.
    #[test]
    fn expired_source_grants_are_refused() {
        let _guard = grant_test_lock();
        // The grant canonicalizes both sides — the picked path must exist.
        let path = "C:/tmp/wowsp-source-grant-test/pack";
        std::fs::create_dir_all(path).unwrap();
        grant_source_path(path).unwrap();
        assert!(source_path_granted(path));
        source_grants().lock().unwrap().insert(
            path.to_string(),
            Instant::now() - SOURCE_GRANT_TTL - Duration::from_secs(1),
        );
        assert!(!source_path_granted(path), "expired grants are refused");
    }

    /// The table is capped and evicts the oldest survivor.
    #[test]
    fn source_grant_table_is_capped_and_evicts_the_oldest() {
        let _guard = grant_test_lock();
        let first = "C:/tmp/wowsp-source-grant-test/first";
        std::fs::create_dir_all(first).unwrap();
        grant_source_path(first).unwrap();
        for i in 0..SOURCE_GRANT_CAP {
            let p = format!("C:/tmp/wowsp-source-grant-test/n{i}");
            std::fs::create_dir_all(&p).unwrap();
            grant_source_path(&p).unwrap();
        }
        assert!(
            !source_path_granted(first),
            "the oldest grant left when the table hit its cap"
        );
        assert!(source_path_granted(&format!(
            "C:/tmp/wowsp-source-grant-test/n{}",
            SOURCE_GRANT_CAP - 1
        )));
    }

    /// The guard is the exact refusal the commands use.
    #[test]
    fn ensure_source_granted_refuses_unpicked_paths() {
        let _guard = grant_test_lock();
        let err = ensure_source_granted("C:/not/picked/this/session").unwrap_err();
        assert!(err.to_string().contains("folder picker"));
    }
}
