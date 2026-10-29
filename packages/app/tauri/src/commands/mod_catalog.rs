//! Mod Hub online catalog (milestone M10.3/10.2 app side).
//!
//! The plugin list is `mod-index.json`, published as an asset of this repo's
//! `mod-hub` release (`scripts/mod_hub_publish.py` builds and uploads it; the
//! crawl indexer in `scripts/mod_index.py` produces the same shape from
//! community-authored threads). Each entry carries per-package SHA-256 hashes,
//! so install = download → verify → unzip → reuse the local classifier +
//! installer from [`super::mod_hub`], then record every written file in
//! `mods/installed.json` for uninstall and (later) game-update migration.
//!
//! Trust chain: the index itself may arrive through a third-party mirror,
//! so its bytes are checked against the official digest of the
//! `mod-index.json` asset (the pairing relay's signed doc, cross-checked
//! with `api.github.com` — see [`super::release_digest`]); only a
//! verified index is cached, and only packages that the verified index
//! pins with a sha256 and that live on this repo's release download tree
//! are installable.
//!
//! Package downloads stream through the unified download hub (mirror
//! ladder + resume + the global proxy-aware client), progress flows on
//! `wowsp://download-progress` with kind "mod-package"; the disk-side
//! install stays serialized by the mod-hub gate below.

use anyhow::anyhow;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use wowsp_tauri_shared::download::{kind, phase};
use wowsp_tauri_shared::{
    CatalogAuthor, CatalogEntry, CatalogEntryI18n, CatalogFilePreview, CatalogIndex,
    CatalogPackage, CatalogPreset, CommandResult, DOWNLOAD_PROGRESS_EVENT, DownloadProgress,
    InstallReport, ModInstallRecord, PackageFilePreview,
};

use super::download_hub::{self, DownloadRequest};
use super::ingame_plugin;
use super::mod_hub;
use super::mod_hub::manifest::{self, WowspManifest};
use super::release_digest;
use crate::paths;

/// The verified-index cache. Caches written before index verification
/// (`mod-catalog.json`) may hold a mirror-forged index, so they are never
/// read again and are removed after the next verified refresh.
const INDEX_CACHE_FILE: &str = "mod-catalog-verified.json";
const LEGACY_INDEX_CACHE_FILE: &str = "mod-catalog.json";
/// Release tag + asset name of the published index, and the relay
/// digest channel serving its official sha256.
const INDEX_CHANNEL: &str = "mod-hub";
const INDEX_TAG: &str = "mod-hub";
const INDEX_ASSET: &str = "mod-index.json";
const LEDGER_FILE: &str = "mods/installed.json";

/// One install's progress tick on the unified `wowsp://download-progress`
/// channel (`kind: "mod-package"`): the hub streams the `download` phase
/// with `{package, packages}` in `detail`, this module continues with
/// `installing` / `done` on the same channel so a listener never joins
/// two streams.
fn emit_progress(
    app: &AppHandle,
    id: &str,
    phase_name: &str,
    package: u32,
    packages: u32,
    received: u64,
    total: u64,
) {
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            id: id.to_string(),
            kind: kind::MOD_PACKAGE.to_string(),
            phase: phase_name.to_string(),
            received,
            total,
            speed_bps: 0.0,
            detail: Some(serde_json::json!({ "package": package, "packages": packages })),
            error: None,
        },
    );
}

/// How long the cached verified index is served without a re-fetch. A
/// stale index whose package hashes drifted from the release is the classic
/// "every install fails the SHA-256 check" trap; refetching keeps them in
/// step while still working offline (a failed refresh — including an
/// unreachable or rate-limited api.github.com — falls back to the last
/// verified cache).
const INDEX_CACHE_TTL_HOURS: i64 = 6;

/// Index candidates: the shared GitHub mirror ladder (user mirror first,
/// then the official route, then the built-in prefixes). Every candidate's
/// bytes are checked against the official digest in [`fetch_index`].
fn index_urls() -> Vec<String> {
    super::github_mirror::candidates(&release_digest::release_download_url(
        INDEX_TAG,
        INDEX_ASSET,
    ))
}

/// Download candidates for a release asset: the same shared ladder.
/// [`checked_package_sha256`] has already confined `url` to this repo's
/// release download tree.
fn download_candidates(url: &str) -> Vec<String> {
    super::github_mirror::candidates(url)
}

/// The sha256 a package download must match, or an error when the package
/// is not installable: the (verified) index must pin its bytes with a
/// well-formed sha256, and its URL must name an asset on this repo's
/// release download tree — the mirror ladder may front that URL, but a
/// catalog entry can never point the download at another host.
fn checked_package_sha256(pkg: &CatalogPackage) -> anyhow::Result<String> {
    if !release_digest::is_release_download_url(&pkg.url) {
        return Err(anyhow!(
            "{} is not hosted on the WoWSP release download tree ({}) — refusing to install it",
            pkg.name,
            pkg.url
        ));
    }
    if !release_digest::is_sha256_hex(&pkg.sha256) {
        return Err(anyhow!(
            "{} has no valid SHA-256 in the catalog — refusing to install an unverifiable package",
            pkg.name
        ));
    }
    Ok(pkg.sha256.to_ascii_lowercase())
}

/// Serializes every mod-hub mutation (catalog install / uninstall, `.bak`
/// toggles, unit uninstall): the guard is held across ledger writes and
/// res_mods renames so parallel commands cannot interleave them. Network
/// downloads stay outside the gate (they serialize globally through the
/// unified download hub's FIFO queue instead — several installs queue
/// behind each other's packages, and only their disk side takes this
/// gate).
static MOD_HUB_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) async fn mod_hub_gate() -> tokio::sync::MutexGuard<'static, ()> {
    MOD_HUB_GATE.lock().await
}

fn data_file(rel: &str) -> anyhow::Result<PathBuf> {
    let dir = paths::ensure_data_dir()?;
    Ok(dir.join(rel))
}

// ── Index fetch / parse ─────────────────────────────────────────────────────

// ── Module split (behavior-preserving refactor) ────────────────────────────
// The former single 3200-line file's sections live in submodules now;
// every historical `commands::mod_catalog::*` path (callers, the
// generate_handler registration, the test suite) keeps resolving through
// the re-exports below.

mod extract;
mod index;
pub(crate) mod install;
pub(crate) mod ledger;
mod pkg_cache;
mod reconcile;
mod uninstall;
mod version_guard;

#[cfg(test)]
mod tests;

pub(crate) use extract::extract_zip;

// Test-only re-exports: the suite (a child of this module) drives private
// helpers through these names without widening any production surface.
#[cfg(test)]
pub(crate) use extract::TEST_EXTRACT_CAPS;
pub(crate) use index::load_cached_index;
#[cfg(test)]
pub(crate) use index::parse_index;
#[cfg(test)]
pub(crate) use install::{
    WorkDir, package_archive, size_within_catalog, unpack_and_install, validate_path_segment,
};
pub(crate) use install::{entry_display_name, newer_owner_records, refresh_newer_snapshots};
#[cfg(test)]
pub(crate) use install::{loose_root_files, package_install_layout};
#[cfg(test)]
pub(crate) use ledger::Ledger;
pub(crate) use ledger::{load_ledger, save_ledger};
#[cfg(test)]
pub(crate) use reconcile::heal_record_names;
#[cfg(test)]
pub(crate) use reconcile::reconcile_core_with_grace;

pub(crate) use uninstall::{
    UninstallReport, rewind_for_reinstall, uninstall_from_ledger, validate_file_removal_order,
    validate_uninstall_order,
};
// The Tauri commands ride with their macro twins (same pattern as
// `commands::pairing`'s re-export block) so the generate_handler
// registration keeps resolving unchanged.
pub use index::{
    __cmd__mod_catalog_refresh, __tauri_command_name_mod_catalog_refresh, mod_catalog_refresh,
};
pub use install::{
    __cmd__mod_catalog_install, __cmd__mod_catalog_preview_files, __cmd__mod_hub_reveal_path,
    __tauri_command_name_mod_catalog_install, __tauri_command_name_mod_catalog_preview_files,
    __tauri_command_name_mod_hub_reveal_path, mod_catalog_install, mod_catalog_preview_files,
    mod_hub_reveal_path,
};
pub use ledger::{__cmd__mod_hub_records, __tauri_command_name_mod_hub_records, mod_hub_records};
pub use reconcile::{
    __cmd__mod_hub_reconcile, __tauri_command_name_mod_hub_reconcile, mod_hub_reconcile,
};
pub use uninstall::{
    __cmd__mod_catalog_uninstall, __tauri_command_name_mod_catalog_uninstall, mod_catalog_uninstall,
};
