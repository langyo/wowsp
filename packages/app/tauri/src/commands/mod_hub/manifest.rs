//! `res_mods/wowsp.toml` — the on-disk manifest of what WoWSP manages.
//!
//! The app-data ledger (`mods/installed.json`, see `mod_catalog`) is
//! WoWSP's private journal — full file lists, snapshot dirs, rollback
//! state. `wowsp.toml` is the SHARED half that lives next to the mods it
//! describes: tool plugins read their config from `[tools.*]`, and anyone
//! inspecting the game folder can see which units WoWSP installed (and
//! with which scheme). WoWSP owns the file: every install / uninstall /
//! toggle rewrites it, and `[tools.*]` tables are carried over untouched
//! (they belong to their tools — hand edits there survive rewrites).
//!
//! Format (schema 1, TOML, snake_case keys):
//!
//! ```toml
//! version = 1
//!
//! [managed."battle.marker.traffic-v4"]
//! name = "Ship Movement Indicator"
//! version = "15.7.0.10"
//! category = "battle"
//! source = "mod-hub"            # mod-hub | local | bundled
//! preset = "sasagcy"            # chosen scheme, when installed with one
//! enabled = true                # kept in step with the `.bak` toggles
//! installed_at = "2026-10-05T00:00:00+00:00"
//!
//! [tools."battle.ingame.stats"]
//! panel_fade_ticks = 3          # tool-defined keys, WoWSP never rewrites
//!
//! [foreign.aslain.shot-timer]   # units FOREIGN installers put on disk —
//! name = "Shot Timer"           # recognition rows, refreshed per scan
//! identity = "battle.timer.shot" # catalog pairing, when one matched
//! ```
//!
//! Forward compatibility: a file whose `version` is NEWER than this build
//! understands is never rewritten (mutations no-op with a warning) — a
//! future schema must not be flattened by an older app.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::*;

/// The schema this build writes and understands.
pub(crate) const MANIFEST_VERSION: i64 = 1;
const MANIFEST_FILE: &str = "wowsp.toml";
/// Backup suffix for a manifest that fails to parse: the broken bytes stay
/// inspectable instead of being silently replaced.
const INVALID_SUFFIX: &str = "wowsp.toml.invalid";

/// One `[managed.<id>]` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ManagedEntry {
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) version: String,
    pub(crate) category: String,
    /// `mod-hub | local | bundled`.
    pub(crate) source: String,
    /// Install-time scheme (see `CatalogPreset`); absent for plain entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) preset: Option<String>,
    #[serde(default = "default_enabled")]
    pub(crate) enabled: bool,
    /// RFC3339.
    pub(crate) installed_at: String,
}

/// One `[foreign.<installer>.<key>]` row — a unit detected on disk that a
/// FOREIGN installer (Aslain's modpack, WG's ModStation, …) put there.
/// WoWSP describes these units, it does not own them: the rows refresh on
/// every scan and `identity` carries the best-effort catalog pairing so
/// every surface (installed list, migration wizard, future tooling) can
/// read the verdict from this one file instead of re-deriving it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ForeignEntry {
    /// The unit's own display name (manifest row / directory name).
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    /// Catalog id this unit was paired against, when a confident match
    /// existed at scan time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) identity: Option<String>,
}

fn default_enabled() -> bool {
    true
}

/// The parsed manifest. `version` is forced to [`MANIFEST_VERSION`] on
/// write; a parsed file claiming a newer schema is refused (see module
/// docs).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct WowspManifest {
    #[serde(default)]
    pub(crate) version: i64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) managed: BTreeMap<String, ManagedEntry>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) tools: BTreeMap<String, toml::Value>,
    /// Units foreign installers put on disk, grouped by installer id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) foreign: BTreeMap<String, BTreeMap<String, ForeignEntry>>,
}

impl WowspManifest {
    /// Build a managed entry mirroring a ledger record.
    pub(crate) fn entry_from_record(record: &ModInstallRecord) -> ManagedEntry {
        ManagedEntry {
            name: record.name.clone(),
            version: record.version.clone(),
            category: record.category.clone(),
            source: record.source.clone(),
            preset: record.preset.clone(),
            enabled: true,
            installed_at: record.installed_at.clone(),
        }
    }
}

fn manifest_path(res_mods: &Path) -> PathBuf {
    res_mods.join(MANIFEST_FILE)
}

/// A manifest loaded off disk, or a fresh empty one when no file exists.
/// `future_schema` marks a file this build must not rewrite.
struct Loaded {
    manifest: WowspManifest,
    future_schema: bool,
}

/// Raw bytes of the manifest, when the file exists — the stale-bin
/// migration captures these before its bookkeeping sweep deletes the file.
pub(crate) fn read_raw(res_mods: &Path) -> Option<String> {
    fs::read_to_string(manifest_path(res_mods)).ok()
}

fn load(res_mods: &Path) -> Loaded {
    let path = manifest_path(res_mods);
    let Ok(raw) = fs::read_to_string(&path) else {
        return Loaded {
            manifest: WowspManifest::default(),
            future_schema: false,
        };
    };
    parse(&raw, Some(&path))
}

/// Parse manifest bytes. `quarantine` names the on-disk file to move aside
/// when the bytes are unparseable — `Some` for the real loader, `None` when
/// the bytes were merely captured (migration): renaming the CURRENT bin's
/// valid manifest because the STALE bin's copy is corrupt would be wrong.
fn parse(raw: &str, quarantine: Option<&Path>) -> Loaded {
    match toml::from_str::<WowspManifest>(raw) {
        Ok(manifest) => {
            let future = manifest.version > MANIFEST_VERSION;
            if future {
                tracing::warn!(
                    version = manifest.version,
                    "wowsp.toml schema is newer than this build — manifest maintenance disabled"
                );
            }
            Loaded {
                manifest,
                future_schema: future,
            }
        },
        Err(e) => {
            // Unparseable: keep the bytes as `.invalid` and start over — a
            // corrupt manifest must not brick every future mutation.
            if let Some(path) = quarantine {
                let _ = fs::rename(path, path.with_file_name(INVALID_SUFFIX));
            }
            tracing::warn!(error = %e, "wowsp.toml unparseable — starting from scratch");
            Loaded {
                manifest: WowspManifest::default(),
                future_schema: false,
            }
        },
    }
}

/// Serialize atomically (tmp + rename). A manifest with nothing left to
/// say (no managed entries, no tool configs) deletes the file instead of
/// littering res_mods with an empty stub.
fn store(res_mods: &Path, manifest: &WowspManifest) -> Result<(), String> {
    let path = manifest_path(res_mods);
    if manifest.managed.is_empty() && manifest.tools.is_empty() && manifest.foreign.is_empty() {
        fs::remove_file(&path).ok();
        return Ok(());
    }
    let mut out: WowspManifest = (*manifest).clone();
    out.version = MANIFEST_VERSION;
    let body = "# WoWSP managed-mod manifest — maintained by WoWSP, hand edits\n\
                # may be overwritten. Tool configs under [tools.*] are yours.\n"
        .to_string()
        + &toml::to_string_pretty(&out).map_err(|e| format!("serialize wowsp.toml: {e}"))?;
    let tmp = path.with_file_name(format!("{MANIFEST_FILE}.tmp"));
    fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

/// res_mods path of one bin version.
pub(crate) fn res_mods_of(game_root: &str, bin_version: &str) -> PathBuf {
    Path::new(game_root)
        .join("bin")
        .join(bin_version)
        .join("res_mods")
}

/// Add or refresh one managed entry under an explicit id (the install id
/// — the ledger record id or the bundled plugin's catalog id). Never
/// touches `[tools.*]`. A reinstall over an existing entry keeps its
/// enabled state — the fresh files are live, but a disabled-then-
/// reinstalled unit would otherwise flip its label while its `.bak`
/// twins stay untouched.
pub(crate) fn upsert_managed(res_mods: &Path, id: &str, entry: ManagedEntry) {
    let loaded = load(res_mods);
    if loaded.future_schema {
        return;
    }
    let mut manifest = loaded.manifest;
    let enabled = manifest.managed.get(id).is_none_or(|prev| prev.enabled);
    let mut entry = entry;
    entry.enabled = enabled;
    manifest.managed.insert(id.to_string(), entry);
    if let Err(e) = store(res_mods, &manifest) {
        tracing::warn!(error = %e, "wowsp.toml update failed");
    }
}

/// Drop one managed entry (uninstall). The file disappears when nothing
/// remains; `[tools.*]` keeps it alive on its own.
pub(crate) fn remove_managed(res_mods: &Path, id: &str) {
    let loaded = load(res_mods);
    if loaded.future_schema {
        return;
    }
    let mut manifest = loaded.manifest;
    if manifest.managed.remove(id).is_none() {
        return;
    }
    if let Err(e) = store(res_mods, &manifest) {
        tracing::warn!(error = %e, "wowsp.toml update failed");
    }
}

/// Flip the enabled flag of entries the `.bak` toggle just touched — and
/// BACKFILL rows for installs that predate the manifest (a toggle is as
/// good a moment as any to start describing them).
pub(crate) fn set_managed_enabled(res_mods: &Path, records: &[ModInstallRecord], enabled: bool) {
    if records.is_empty() {
        return;
    }
    let loaded = load(res_mods);
    if loaded.future_schema {
        return;
    }
    let mut manifest = loaded.manifest;
    let mut touched = false;
    for record in records {
        match manifest.managed.get_mut(&record.id) {
            Some(entry) => {
                entry.enabled = enabled;
                touched = true;
            },
            // No row yet (pre-feature install): create one describing the
            // record, wearing the toggle's verdict.
            None => {
                let mut entry = WowspManifest::entry_from_record(record);
                entry.enabled = enabled;
                manifest.managed.insert(record.id.clone(), entry);
                touched = true;
            },
        }
    }
    if touched {
        if let Err(e) = store(res_mods, &manifest) {
            tracing::warn!(error = %e, "wowsp.toml update failed");
        }
    }
}

/// Ensure a tool's config table exists with the given defaults (keys the
/// tool already set — by hand or a previous seed — are never overwritten).
pub(crate) fn seed_tool_config(res_mods: &Path, tool_id: &str, defaults: &BTreeMap<String, i64>) {
    let loaded = load(res_mods);
    if loaded.future_schema {
        return;
    }
    let mut manifest = loaded.manifest;
    let table = manifest
        .tools
        .entry(tool_id.to_string())
        .or_insert_with(|| toml::Value::Table(Default::default()));
    let Some(table) = table.as_table_mut() else {
        return; // a tool id occupied by a non-table value is not ours to fix
    };
    let mut changed = false;
    for (key, value) in defaults {
        if !table.contains_key(key) {
            table.insert(key.clone(), toml::Value::from(*value));
            changed = true;
        }
    }
    if changed {
        if let Err(e) = store(res_mods, &manifest) {
            tracing::warn!(error = %e, "wowsp.toml update failed");
        }
    }
}

/// Replace every `[foreign.<installer>]` row of one installer with the
/// freshly scanned set (other installers' rows are untouched — each is
/// refreshed by its own scan pass).
pub(crate) fn replace_foreign(
    res_mods: &Path,
    installer: &str,
    units: BTreeMap<String, ForeignEntry>,
) {
    let loaded = load(res_mods);
    if loaded.future_schema {
        return;
    }
    let mut manifest = loaded.manifest;
    if manifest.foreign.get(installer) == Some(&units) {
        return; // identical rows on disk — a no-op scan stays write-free
    }
    if units.is_empty() {
        if manifest.foreign.remove(installer).is_none() {
            return;
        }
    } else {
        manifest.foreign.insert(installer.to_string(), units);
    }
    if let Err(e) = store(res_mods, &manifest) {
        tracing::warn!(error = %e, "wowsp.toml foreign refresh failed");
    }
}

/// Stale-bin migration: entries moved from `from_res_mods` merge into the
/// current bin's manifest. Field data refreshes from the (already
/// re-pointed) ledger; `enabled` states carry over from the stale file;
/// `[tools.*]` tables are unioned (the current bin's values win). The
/// stale file itself is deleted by the migration's bookkeeping sweep.
pub(crate) fn merge_after_migration(
    stale_raw: Option<&str>,
    to_res_mods: &Path,
    records: &[ModInstallRecord],
    game_root: &str,
    bin_version: &str,
) {
    let current = load(to_res_mods);
    if current.future_schema {
        return;
    }
    // The stale copy was captured before the migration's bookkeeping sweep
    // deleted it; unparseable bytes simply contribute nothing (and never
    // quarantine the CURRENT bin's file — no on-disk path is given).
    let stale = stale_raw.map(|raw| parse(raw, None));
    let mut manifest = current.manifest;
    if let Some(stale) = stale.as_ref() {
        if stale.future_schema {
            return;
        }
        // Tool configs: the current bin wins, the stale one fills gaps.
        for (tool, table) in &stale.manifest.tools {
            manifest
                .tools
                .entry(tool.clone())
                .or_insert_with(|| table.clone());
        }
        // Bundled units (the in-game plugin) have no ledger record by
        // design — their rows travel with the manifest itself.
        for (id, entry) in &stale.manifest.managed {
            if entry.source == "bundled" {
                manifest
                    .managed
                    .entry(id.clone())
                    .or_insert_with(|| entry.clone());
            }
        }
    }
    // Managed rows refresh from the ledger (id, name, version, …) while the
    // toggle state survives where it was last recorded: the stale file for
    // migrated units, else the current bin's own row (a mod toggled off
    // HERE must not flip back on because a stale-bin migration ran).
    for record in records
        .iter()
        .filter(|r| r.game_root == game_root || r.game_root.is_empty())
        .filter(|r| r.bin_version == bin_version)
    {
        let mut entry = WowspManifest::entry_from_record(record);
        entry.enabled = stale
            .as_ref()
            .and_then(|st| st.manifest.managed.get(&record.id))
            .map(|prev| prev.enabled)
            .unwrap_or_else(|| {
                manifest
                    .managed
                    .get(&record.id)
                    .is_none_or(|cur| cur.enabled)
            });
        manifest.managed.insert(record.id.clone(), entry);
    }
    if let Err(e) = store(to_res_mods, &manifest) {
        tracing::warn!(error = %e, "wowsp.toml migration merge failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_res_mods(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wowsp_manifest_{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(name: &str) -> ManagedEntry {
        ManagedEntry {
            name: name.into(),
            version: "15.7.0.10".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            preset: Some("sasagcy".into()),
            enabled: true,
            installed_at: "2026-10-05T00:00:00Z".into(),
        }
    }

    #[test]
    fn upsert_remove_and_self_delete() {
        let dir = tmp_res_mods("lifecycle");
        upsert_managed(&dir, "battle.marker.traffic-v4", entry("SMI"));
        let m = load(&dir).manifest;
        assert_eq!(m.version, MANIFEST_VERSION);
        assert_eq!(m.managed.len(), 1);
        assert_eq!(
            m.managed["battle.marker.traffic-v4"].preset.as_deref(),
            Some("sasagcy")
        );

        remove_managed(&dir, "battle.marker.traffic-v4");
        // Nothing managed and no tool configs — the file removes itself.
        assert!(!manifest_path(&dir).is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tools_tables_survive_managed_removal() {
        let dir = tmp_res_mods("tools");
        let mut defaults = BTreeMap::new();
        defaults.insert("panel_fade_ticks".to_string(), 3i64);
        seed_tool_config(&dir, "battle.ingame.stats", &defaults);
        upsert_managed(&dir, "battle.ingame.stats", entry("probe"));
        remove_managed(&dir, "battle.ingame.stats");
        // The tool config keeps the file alive on its own…
        let m = load(&dir).manifest;
        assert!(m.managed.is_empty());
        assert!(m.tools.contains_key("battle.ingame.stats"));
        // …and a re-seed never overwrites the existing key.
        let raw = fs::read_to_string(manifest_path(&dir)).unwrap();
        let hand_tuned = raw.replace("panel_fade_ticks = 3", "panel_fade_ticks = 9");
        fs::write(manifest_path(&dir), hand_tuned).unwrap();
        seed_tool_config(&dir, "battle.ingame.stats", &defaults);
        let m = load(&dir).manifest;
        assert_eq!(
            m.tools["battle.ingame.stats"]
                .get("panel_fade_ticks")
                .unwrap()
                .as_integer(),
            Some(9),
            "seed must not clobber hand-tuned values"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reinstall_keeps_enabled_and_toggle_flips_it() {
        let dir = tmp_res_mods("toggle");
        upsert_managed(&dir, "m", entry("M"));
        let record = ModInstallRecord {
            id: "m".into(),
            name: "M".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/a.png".into()],
            restore_dir: None,
            game_root: String::new(),
        };
        set_managed_enabled(&dir, &[record], false);
        let mut again = entry("M2");
        again.enabled = true; // a fresh install reports live files…
        upsert_managed(&dir, "m", again);
        let m = load(&dir).manifest;
        // …but the row keeps its disabled label (the .bak twins persist).
        assert!(!m.managed["m"].enabled);
        assert_eq!(m.managed["m"].name, "M2", "fields still refresh");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_file_is_quarantined_and_future_schema_is_untouched() {
        let dir = tmp_res_mods("guard");
        fs::write(manifest_path(&dir), "not [ valid toml {{{").unwrap();
        upsert_managed(&dir, "m", entry("M"));
        assert!(dir.join(INVALID_SUFFIX).is_file(), "broken bytes preserved");
        assert!(load(&dir).manifest.managed.contains_key("m"));

        // A future schema refuses every mutation instead of being flattened.
        let future = format!("version = {}\n", MANIFEST_VERSION + 1);
        fs::write(manifest_path(&dir), &future).unwrap();
        remove_managed(&dir, "m");
        assert_eq!(
            fs::read_to_string(manifest_path(&dir)).unwrap(),
            future,
            "newer-schema file must survive untouched"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_merge_carries_toggles_and_unions_tools() {
        let from = tmp_res_mods("mig_from");
        let to = tmp_res_mods("mig_to");
        let record = ModInstallRecord {
            id: "m".into(),
            name: "M refreshed".into(),
            version: "2".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "2".into(),
            installed_at: "2026-10-05T00:00:00Z".into(),
            files: vec!["gui/a.png".into()],
            restore_dir: None,
            game_root: "g".into(),
        };
        // Stale bin: the row (toggled off) + a tool config.
        let stale = format!(
            "version = 1\n\n[managed.m]\nname = \"M old\"\nversion = \"1\"\ncategory = \"battle\"\nsource = \"mod-hub\"\nenabled = false\ninstalled_at = \"2026-09-01T00:00:00Z\"\n\n[tools.\"battle.ingame.stats\"]\npanel_fade_ticks = 7\n"
        );
        merge_after_migration(Some(&stale), &to, std::slice::from_ref(&record), "g", "2");
        let m = load(&to).manifest;
        assert_eq!(
            m.managed["m"].name, "M refreshed",
            "fields come from the ledger"
        );
        assert!(
            !m.managed["m"].enabled,
            "toggle state carried from the stale file"
        );
        assert_eq!(
            m.tools["battle.ingame.stats"]
                .get("panel_fade_ticks")
                .unwrap()
                .as_integer(),
            Some(7)
        );
        // A record of ANOTHER game root never lands in this bin's manifest.
        let foreign = ModInstallRecord {
            game_root: "other".into(),
            ..record.clone()
        };
        let to2 = tmp_res_mods("mig_to2");
        merge_after_migration(Some(&stale), &to2, &[foreign], "g", "2");
        assert!(load(&to2).manifest.managed.is_empty());
        fs::remove_dir_all(&from).ok();
        fs::remove_dir_all(&to).ok();
        fs::remove_dir_all(&to2).ok();
    }
}

// ── The single-writer hub ───────────────────────────────────────────────────
//
// Every wowsp.toml WRITE in the process goes through this actor: commands
// ship a ManifestOp down an mpsc pipe and block for the writer thread's
// receipt, so there is exactly one mutating context no matter how many
// commands race — no parallel copy of the file can drift out of step.
// Reads are the many half of many-read/one-write: they parse the file
// (atomically replaced by the writer, so a reader sees the old or the new
// document, never a torn one) through the same `read_snapshot` entry.

/// One mutating intent for the writer thread.
pub(crate) enum ManifestOp {
    UpsertManaged {
        res_mods: PathBuf,
        id: String,
        entry: ManagedEntry,
    },
    RemoveManaged {
        res_mods: PathBuf,
        id: String,
    },
    SetEnabled {
        res_mods: PathBuf,
        records: Vec<ModInstallRecord>,
        enabled: bool,
    },
    SeedTool {
        res_mods: PathBuf,
        tool: String,
        defaults: BTreeMap<String, i64>,
    },
    ReplaceForeign {
        res_mods: PathBuf,
        installer: String,
        units: BTreeMap<String, ForeignEntry>,
    },
    MergeAfterMigration {
        stale_raw: Option<String>,
        to_res_mods: PathBuf,
        records: Vec<ModInstallRecord>,
        game_root: String,
        bin_version: String,
    },
}

struct ManifestHub {
    tx: std::sync::mpsc::Sender<(ManifestOp, std::sync::mpsc::Sender<Result<(), String>>)>,
}

static HUB: std::sync::LazyLock<ManifestHub> = std::sync::LazyLock::new(ManifestHub::new);

impl ManifestHub {
    fn new() -> Self {
        let (tx, rx) =
            std::sync::mpsc::channel::<(ManifestOp, std::sync::mpsc::Sender<Result<(), String>>)>();

        std::thread::Builder::new()
            .name("wowsp-toml-writer".into())
            .spawn(move || {
                for (op, done) in rx {
                    let out = Self::execute(op);
                    let _ = done.send(out);
                }
            })
            .expect("spawn wowsp.toml writer");
        Self { tx }
    }

    fn execute(op: ManifestOp) -> Result<(), String> {
        match op {
            ManifestOp::UpsertManaged {
                res_mods,
                id,
                entry,
            } => {
                upsert_managed(&res_mods, &id, entry);
                Ok(())
            },
            ManifestOp::RemoveManaged { res_mods, id } => {
                remove_managed(&res_mods, &id);
                Ok(())
            },
            ManifestOp::SetEnabled {
                res_mods,
                records,
                enabled,
            } => {
                set_managed_enabled(&res_mods, &records, enabled);
                Ok(())
            },
            ManifestOp::SeedTool {
                res_mods,
                tool,
                defaults,
            } => {
                seed_tool_config(&res_mods, &tool, &defaults);
                Ok(())
            },
            ManifestOp::ReplaceForeign {
                res_mods,
                installer,
                units,
            } => {
                replace_foreign(&res_mods, &installer, units);
                Ok(())
            },
            ManifestOp::MergeAfterMigration {
                stale_raw,
                to_res_mods,
                records,
                game_root,
                bin_version,
            } => {
                merge_after_migration(
                    stale_raw.as_deref(),
                    &to_res_mods,
                    &records,
                    &game_root,
                    &bin_version,
                );
                Ok(())
            },
        }
    }

    fn apply(&self, op: ManifestOp) -> Result<(), String> {
        let (done, rx) = std::sync::mpsc::channel();
        self.tx
            .send((op, done))
            .map_err(|_| "wowsp.toml writer is gone".to_string())?;
        rx.recv()
            .map_err(|_| "wowsp.toml writer dropped the job".to_string())?
    }
}

/// Route one write through the single writer. Blocks until the writer has
/// persisted the change (file IO is milliseconds); safe to call from async
/// command contexts and spawn_blocking closures alike.
pub(crate) fn hub_apply(op: ManifestOp) {
    if let Err(e) = HUB.apply(op) {
        tracing::warn!(error = %e, "wowsp.toml write routed through the hub failed");
    }
}

/// The one read entry: a snapshot of the manifest at `res_mods`. Concurrent
/// with writer activity by design (atomic tmp+rename stores), and the only
/// parse of the file outside the writer thread. (No production reader yet
/// beyond the tests — the API is the documented read contract.)
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn read_snapshot(res_mods: &Path) -> WowspManifest {
    load(res_mods).manifest
}

#[cfg(test)]
mod hub_tests {
    use super::*;

    #[test]
    fn hub_writes_and_foreign_rides_the_same_file() {
        let dir = std::env::temp_dir().join("wowsp_hub_roundtrip");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        hub_apply(ManifestOp::UpsertManaged {
            res_mods: dir.clone(),
            id: "battle.marker.traffic-v4".into(),
            entry: ManagedEntry {
                name: "SMI".into(),
                version: "1".into(),
                category: "battle".into(),
                source: "mod-hub".into(),
                preset: None,
                enabled: true,
                installed_at: "2026-10-05T00:00:00Z".into(),
            },
        });
        // The single-writer serialized both ops; the snapshot sees both.
        let mut units = BTreeMap::new();
        units.insert(
            "shot-timer".into(),
            ForeignEntry {
                name: "Shot Timer".into(),
                version: Some("15.7.0".into()),
                identity: Some("battle.timer.shot".into()),
            },
        );
        hub_apply(ManifestOp::ReplaceForeign {
            res_mods: dir.clone(),
            installer: "aslain".into(),
            units,
        });
        let snap = read_snapshot(&dir);
        assert!(snap.managed.contains_key("battle.marker.traffic-v4"));
        assert_eq!(
            snap.foreign["aslain"]["shot-timer"].identity.as_deref(),
            Some("battle.timer.shot")
        );
        // The written file really carries the [foreign] section.
        let raw = fs::read_to_string(dir.join(MANIFEST_FILE)).unwrap();
        // `shot-timer` is a bare TOML key, so the table header carries no quotes.
        assert!(raw.contains("[foreign.aslain.shot-timer]"), "{raw}");
        // Removing the managed row keeps the file (foreign still lives).
        hub_apply(ManifestOp::RemoveManaged {
            res_mods: dir.clone(),
            id: "battle.marker.traffic-v4".into(),
        });
        assert!(dir.join(MANIFEST_FILE).is_file());
        // Dropping the foreign set too empties the manifest → self-delete.
        hub_apply(ManifestOp::ReplaceForeign {
            res_mods: dir.clone(),
            installer: "aslain".into(),
            units: BTreeMap::new(),
        });
        assert!(!dir.join(MANIFEST_FILE).exists());
        fs::remove_dir_all(&dir).ok();
    }
}
