//! App-version one-time actions, on the hifumi scaffold (`hifumi::app`).
//!
//! The Rust shell owns the gate and the ledger: eligibility is "the upgrade
//! crossed into the action's version" (`previous < since <= current`), the
//! ledger is a JSON file in the data root, and actions that must run inside
//! the WebView (localStorage rewrites the shell cannot reach) are declared
//! `delegate` — they surface through [`app_migrations_pending`] and the
//! webui reports completion through [`app_migration_completed`].
//!
//! The previous-run version comes from the ledger once recorded. On the
//! first pass over a fresh ledger the webui passes its own
//! `wowsp-last-run-version` slot as `previous_hint` (that storage outlived
//! every pre-hifumi build), which seeds the ledger exactly once; a fresh
//! install carries no hint and never migrates. The run version is only
//! recorded once nothing remains due, so a mid-migration crash retries the
//! whole pass on the next boot instead of stranding actions.

use std::path::{Path, PathBuf};

use hifumi::app::AppMigrationStore;
use hifumi::app_migrations;
use tracing::warn;

use crate::paths;

/// The shipped action list — ids are the fn names, and the webui's
/// `WEBUI_MIGRATION_ACTIONS` map keys (migrations/definitions.ts) must
/// match them exactly. A mismatched webui leaves the action pending and
/// the shell retries it every boot; it is never silently lost.
#[app_migrations]
mod registry {
    /// 0.5.2 — raise the default UI opacity 80 → 95 for profiles on the
    /// factory default theme. The dial lives in the WebView's localStorage
    /// (`wowsp-ui-opacity`), which the shell cannot reach: the webui runs
    /// the body and reports back.
    #[once("0.5.2", delegate)]
    fn ui_opacity_95_on_default_theme() {}
}

/// Ledger file under the data root (see `paths` for the layout modes).
const APP_MIGRATIONS_FILE: &str = "app-migrations.json";

fn store_path() -> Result<PathBuf, String> {
    Ok(paths::ensure_data_dir()?.join(APP_MIGRATIONS_FILE))
}

fn load_store(store_path: &Path) -> Result<AppMigrationStore, String> {
    AppMigrationStore::load(store_path).map_err(|e| format!("load app migration ledger: {e}"))
}

/// Record the current version only when nothing remains due — recording
/// earlier would make an action that has not run yet look "already
/// crossed" and skip it forever.
fn settle(set: &hifumi::app::AppMigrationSet, store: &mut AppMigrationStore) {
    if set.due(store).is_empty() {
        if let Err(error) = store.record_last_run_version(set.current_version) {
            warn!(%error, "record app migration run version failed");
        }
    }
}

/// One boot pass: run the shell-side actions, then return the still-pending
/// delegated ids.
fn run_pass(store_path: &Path, previous_hint: Option<&str>) -> Result<Vec<String>, String> {
    let mut store = load_store(store_path)?;
    if let Some(hint) = previous_hint.filter(|hint| !hint.is_empty()) {
        // Seeds only a fresh ledger (an upgrade in place); a no-op on every
        // later boot. The library deliberately does not persist the seed —
        // flush it here so a crash before any other write keeps it.
        if store.seed_last_run_version(hint) {
            store
                .save()
                .map_err(|e| format!("write app migration ledger: {e}"))?;
        }
    }
    let set = registry::registry();
    let run = set.run_immediate(&mut store);
    for (id, error) in run.failed {
        warn!(migration = %id, %error, "app migration failed; retrying next boot");
    }
    settle(&set, &mut store);
    Ok(set
        .delegated_pending(&store)
        .into_iter()
        .map(str::to_string)
        .collect())
}

/// Report a delegated action as completed by the WebView; `false` for ids
/// the registry does not know (nothing is written).
fn complete(store_path: &Path, id: &str) -> Result<bool, String> {
    let mut store = load_store(store_path)?;
    let set = registry::registry();
    let known = set
        .mark_completed(&mut store, id)
        .map_err(|e| format!("write app migration ledger: {e}"))?;
    if known {
        settle(&set, &mut store);
    }
    Ok(known)
}

/// Tauri command: ids of delegated app migrations still pending for this
/// profile. `previous_hint` is the webui's `wowsp-last-run-version` slot,
/// consumed once to seed a fresh ledger.
#[tauri::command]
pub fn app_migrations_pending(previous_hint: Option<String>) -> Result<Vec<String>, String> {
    // A duplicate launch never migrates: it shares the data root with the
    // primary, and two concurrent passes would race the ledger and any
    // one-time migration bodies against each other (single-instance guard,
    // see crate::single_instance).
    if crate::single_instance::is_secondary() {
        return Ok(Vec::new());
    }
    run_pass(&store_path()?, previous_hint.as_deref())
}

/// Tauri command: the webui finished a delegated action.
#[tauri::command]
pub fn app_migration_completed(id: String) -> Result<bool, String> {
    complete(&store_path()?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "wowsp-app-migrations-{name}-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn upgrade_seeded_from_hint_surfaces_delegated_pending() {
        let path = temp_store_path("upgrade");

        // First boot after the 0.5.1 → 0.5.2 upgrade: the webui hint seeds
        // the fresh ledger and the delegated action surfaces.
        assert_eq!(
            run_pass(&path, Some("0.5.1")).unwrap(),
            vec!["ui_opacity_95_on_default_theme".to_string()]
        );
        // Unresolved: the run version stays unrecorded, so a crash here
        // retries (and a repeated pass with no hint still sees it pending).
        assert_eq!(run_pass(&path, None).unwrap().len(), 1);

        // The webui reports completion: nothing remains due, the run
        // version records, and later boots see an empty pending list.
        assert!(complete(&path, "ui_opacity_95_on_default_theme").unwrap());
        assert!(run_pass(&path, None).unwrap().is_empty());

        // Unknown ids report false and write nothing.
        assert!(!complete(&path, "unknown").unwrap());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn fresh_install_never_migrates() {
        let path = temp_store_path("fresh");

        // No hint = fresh profile: nothing due, and the very first pass
        // records the run version.
        assert!(run_pass(&path, None).unwrap().is_empty());
        // A stale hint arriving later cannot re-seed the recorded ledger.
        assert!(run_pass(&path, Some("0.4.0")).unwrap().is_empty());

        std::fs::remove_file(&path).ok();
    }
}
