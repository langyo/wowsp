//! Rust-side read of the overlay settings — the very state the webui's
//! `overlayConfig` pinia store owns (schema v2). The two INDEPENDENT
//! switches the settings modal exposes both need enforcement outside the
//! webui, on threads the store cannot reach:
//!
//! - `table` — the live-battle view mode. `"detect"` (default) is the
//!   transparent window overlay anchored to the pixel-detected team table;
//!   `"ingame"` renders the stats INSIDE the game through the first-party
//!   plugin's unbound view — the webui never creates the overlay window,
//!   the Rust Tab watcher suppresses every show (belt-and-suspenders — see
//!   `watch_tab_tick`) and the `ingame_bridge` answers the plugin's
//!   request.json instead; `"off"` disables the whole Tab overlay (no
//!   window, no watcher shows, no bridge).
//! - `roster` — roster attribution. `"inferred"` (default) derives the
//!   row→name mapping from the decompiled client's full Tab sort key (alive,
//!   class, tier, nation, ship name, '[tag]nickname) over the roster plus the luma probe's
//!   alive flags — no OCR at all; `"ocr"` keeps the Windows OCR row→name
//!   pipeline (exact, but unavailable on systems without an OCR language
//!   pack); `"off"` skips attribution entirely — the anchor carries no
//!   `row_players` payload, the overlay page falls back to the historical
//!   roster/index order, and no "recognizing roster" pending badge is ever
//!   reported.
//!
//! The values are deliberately parsed as plain enums with a per-field safe
//! default, so a future option can be added to the schema without breaking
//! older reads: an unknown value resolves to the field's default instead of
//! erroring — and, since the TOML move, is FORCED back to disk so the
//! correction sticks (see `settings_store`).
//!
//! PERSISTENCE: a flat `overlay-config.toml` under the appdata root, written
//! exclusively through [`set_overlay_config`] (the webui store's IPC call).
//! Reads additionally perform the fallback migrations on the way past:
//!
//! - pre-TOML `overlay-config.json` (v2 shape) → parsed once, rewritten as
//!   TOML, legacy file retired after the successful write;
//! - schema v1 `{enabled: bool}` (either format) → `table` inherits the
//!   master switch (`true`/absent → detect, `false` → off), `roster` keeps
//!   its default;
//! - unknown enum values / wrong field types / outright garbage → per-field
//!   defaults, healed onto disk.
//!
//! Reading is CHEAP and panic-free by contract: the file is tiny, a TTL
//! cache bounds the disk traffic (the watcher asks on every ~30 ms tick),
//! and every failure degrades to the defaults instead of blocking or
//! panicking the watcher thread.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::paths;
use crate::settings_store::{self, SettingsSource};

/// Canonical settings file under the appdata root.
const OVERLAY_CONFIG_FILE: &str = "overlay-config.toml";
/// Pre-TOML persistence (webui wrote this via `appdata_write`) — read once,
/// then retired.
const LEGACY_OVERLAY_CONFIG_FILE: &str = "overlay-config.json";

/// Header prepended to the canonical file. Part of the canonical text used
/// for the heal-write comparison, like in `commands/network`.
const FILE_HEADER: &str = "# WoWSP overlay settings. table = \"detect\" | \"ingame\" | \"off\", roster = \"plugin\" | \"passive\".\n\
                           # Invalid values are reset to the defaults by the app.\n";

/// How long a cached read stays fresh. The file only changes when the user
/// flips a settings switch, so a couple of seconds of staleness bounds the
/// enforcement delay while keeping the ~30 ms watcher tick at a mutex-guard
/// memcpy in the steady state.
const CONFIG_TTL: Duration = Duration::from_secs(2);

/// Live-battle view mode (schema v2 `table` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TableAnchor {
    /// Pixel detection + transparent window overlay (the default).
    Detect,
    /// The stats render inside the game through the plugin's unbound
    /// view; the overlay window stays down and `ingame_bridge` answers
    /// the plugin's stats requests instead.
    Ingame,
    /// The whole Tab overlay feature is off.
    Off,
}

/// Roster recognition switch (schema v2 `roster` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RosterRecognition {
    /// In-game plugin telemetry (packages/ingame-plugin) is the PRIMARY
    /// detector: the PnFMods bridge feeds the exact arena order with
    /// `isAlive` sinking and the TAB screen's own tabModeIn/Out marks.
    /// A missing/outdated plugin or a stale stream degrades that battle to
    /// the passive capture pipeline.
    Plugin,
    /// Passive capture-only detection (renamed from the old "inferred"
    /// pick): the screen-capture pipeline (row strip detection + luma sink
    /// solver) runs and the plugin is ignored even when installed.
    Passive,
}

impl TableAnchor {
    fn as_str(self) -> &'static str {
        match self {
            TableAnchor::Detect => "detect",
            TableAnchor::Ingame => "ingame",
            TableAnchor::Off => "off",
        }
    }
}

impl RosterRecognition {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RosterRecognition::Plugin => "plugin",
            RosterRecognition::Passive => "passive",
        }
    }
}

/// Parsed overlay config (schema v2), each field already resolved to its
/// safe default when absent or unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OverlayConfig {
    pub(crate) table: TableAnchor,
    pub(crate) roster: RosterRecognition,
}

impl Default for OverlayConfig {
    fn default() -> Self {
        Self {
            table: TableAnchor::Detect,
            roster: RosterRecognition::Plugin,
        }
    }
}

/// Parse the v2 `table` field. Present-but-unknown values (a typo, a wrong
/// type) fall back to the safe default — the overlay must never brick
/// itself over a config typo. An ABSENT field defers to the legacy v1
/// master switch (see [`resolve_fields`]).
fn parse_table_field(raw: &str) -> TableAnchor {
    match raw {
        "ingame" => TableAnchor::Ingame,
        "off" => TableAnchor::Off,
        // "detect" and anything unrecognized (incl. future values).
        _ => TableAnchor::Detect,
    }
}

/// Parse the v2 `roster` field with the same unknown-value contract.
fn parse_roster_field(raw: &str) -> RosterRecognition {
    match raw {
        // Migration (owner spec): the old "inferred"/"ocr" picks — the
        // pixel-comparison pipeline — move to the plugin as the primary
        // detector; only an explicit "passive" pick stays passive.
        "passive" => RosterRecognition::Passive,
        // A stored roster "off" lands on passive: the table switch owns the
        // whole overlay's off state, so the roster pick no longer has one.
        "off" => RosterRecognition::Passive,
        // "inferred"/"ocr" (the retired pixel pipeline), "plugin" and
        // anything unrecognized all land on the plugin primary.
        _ => RosterRecognition::Plugin,
    }
}

/// The neutral field trio both file formats reduce to before resolution.
#[derive(Default)]
struct RawOverlayFields {
    table: Option<String>,
    roster: Option<String>,
    enabled: Option<bool>,
}

/// Pure file-content → config resolution, shared by both formats: v2 fields
/// win, an absent `table` defers to the v1 `{enabled}` master switch, and
/// every unknown value lands on its field's default.
fn resolve_fields(fields: RawOverlayFields) -> OverlayConfig {
    let table = match fields.table.as_deref() {
        Some(raw) => parse_table_field(raw),
        None => match fields.enabled {
            Some(true) => TableAnchor::Detect,
            Some(false) => TableAnchor::Off,
            None => TableAnchor::Detect,
        },
    };
    let roster = match fields.roster.as_deref() {
        Some(raw) => parse_roster_field(raw),
        None => RosterRecognition::Plugin,
    };
    OverlayConfig { table, roster }
}

/// Extract the field trio from a JSON document (legacy file or v1 shape).
/// Non-object JSON is as good as garbage → empty trio → defaults.
fn fields_from_json(raw: &str) -> RawOverlayFields {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return RawOverlayFields::default();
    };
    RawOverlayFields {
        table: map
            .get("table")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        roster: map
            .get("roster")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        enabled: map.get("enabled").and_then(|v| v.as_bool()),
    }
}

/// Extract the field trio from a TOML document (the canonical file).
/// Non-table TOML → empty trio → defaults.
fn fields_from_toml(raw: &str) -> RawOverlayFields {
    let Ok(value) = toml::from_str::<toml::Value>(raw) else {
        return RawOverlayFields::default();
    };
    let map = match value {
        toml::Value::Table(map) => map,
        _ => return RawOverlayFields::default(),
    };
    RawOverlayFields {
        table: map
            .get("table")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        roster: map
            .get("roster")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        enabled: map.get("enabled").and_then(|v| v.as_bool()),
    }
}

/// Pure JSON parse (kept for the tests and the legacy migration path).
fn parse_config(raw: &str) -> OverlayConfig {
    resolve_fields(fields_from_json(raw))
}

/// The on-disk shape (flat TOML table; both fields always present — a
/// missing key means the same as an unknown one, the field's default).
#[derive(Debug, Serialize, Deserialize)]
struct OverlayConfigTomlFile {
    table: String,
    roster: String,
}

/// Serialize the canonical file text (header + flat TOML keys).
fn canonical_toml(config: OverlayConfig) -> Result<String, String> {
    let file = OverlayConfigTomlFile {
        table: config.table.as_str().to_string(),
        roster: config.roster.as_str().to_string(),
    };
    let body = toml::to_string(&file).map_err(|e| format!("serialize overlay config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// TTL cache mirror of the last read. The mutex is held across one disk
/// read (plus, on the rare heal/migration pass, one write) and never
/// nested; a poisoned lock (a panic while holding it — impossible by
/// contract, but anyway) recovers instead of panicking every later reader.
/// A reader that raced a `set_overlay_config` write may cache the pre-write
/// value for at most one TTL window (2 s) — bounded staleness, accepted.
static CACHE: Mutex<Option<(Instant, OverlayConfig)>> = Mutex::new(None);

/// Read the settings once, uncached, migrating/healing on the way past.
/// Every IO/parse failure collapses to the defaults — the watcher must keep
/// running whatever the disk says.
fn read_uncached() -> OverlayConfig {
    match paths::data_dir() {
        Ok(dir) => read_uncached_from(&dir),
        Err(_) => OverlayConfig::default(),
    }
}

/// Testable core of [`read_uncached`]. On top of the parse, this owns the
/// on-disk fallbacks: JSON→TOML migration, v1→v2 resolution and the
/// heal-write of corrected values (see the module docs). The canonical-text
/// comparison keeps the steady state — a file the app itself wrote —
/// strictly read-only, so the watcher's periodic reads never touch the disk
/// write path.
fn read_uncached_from(dir: &Path) -> OverlayConfig {
    let loaded = settings_store::load_raw(dir, OVERLAY_CONFIG_FILE, LEGACY_OVERLAY_CONFIG_FILE);
    let Some(raw) = loaded.raw else {
        return OverlayConfig::default();
    };
    let config = match loaded.source {
        SettingsSource::Toml => resolve_fields(fields_from_toml(&raw)),
        SettingsSource::LegacyJson | SettingsSource::Missing => parse_config(&raw),
    };
    if let Ok(canonical) = canonical_toml(config) {
        settings_store::heal(
            dir,
            OVERLAY_CONFIG_FILE,
            LEGACY_OVERLAY_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    config
}

/// Current overlay config, TTL-cached. Cheap enough for the watcher's
/// ~30 ms tick: after the first read it is one mutex lock and an `Instant`
/// comparison until the TTL expires.
pub(crate) fn current() -> OverlayConfig {
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, cfg)) = *cache {
        if at.elapsed() < CONFIG_TTL {
            return cfg;
        }
    }
    let cfg = read_uncached();
    *cache = Some((Instant::now(), cfg));
    cfg
}

/// The roster attribution mode in force: the overlay pipeline (and, via the
/// anchor payload, the overlay page) branches on this.
pub(crate) fn roster_mode() -> RosterRecognition {
    current().roster
}

/// Whether the transparent Tab overlay must stay down: the explicit `"off"`
/// AND the `"ingame"` mode (the plugin renders instead) both suppress the
/// overlay window and every watcher show.
pub(crate) fn table_overlay_off() -> bool {
    overlay_suppressed(current().table)
}

/// Pure core of [`table_overlay_off`], unit-testable without the cache.
fn overlay_suppressed(table: TableAnchor) -> bool {
    table != TableAnchor::Detect
}

/// Whether the in-game plugin's stats bridge should answer request.json —
/// only the `"ingame"` view mode turns it on.
pub(crate) fn ingame_view_mode() -> bool {
    bridge_active(current().table)
}

/// Pure core of [`ingame_view_mode`].
fn bridge_active(table: TableAnchor) -> bool {
    table == TableAnchor::Ingame
}

// ── typed IPC surface (the webui store's only read/write path) ───────────

/// Config as returned to the webui — plain strings matching the store's
/// `TableAnchorMode` / `RosterRecognitionMode` union types, always valid
/// (already sanitized) values.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayConfigResponse {
    pub table: String,
    pub roster: String,
}

impl From<OverlayConfig> for OverlayConfigResponse {
    fn from(config: OverlayConfig) -> Self {
        Self {
            table: config.table.as_str().to_string(),
            roster: config.roster.as_str().to_string(),
        }
    }
}

/// The stored overlay config for the webui store — performs the same
/// migration/heal pass a watcher read would, so the very first settings
/// render after an upgrade already reflects (and persists) the fix.
#[tauri::command]
pub fn get_overlay_config() -> Result<OverlayConfigResponse, String> {
    Ok(current().into())
}

/// Persist both switches. Inputs are sanitized with the same per-field
/// defaults a file read applies — an unknown value from a newer webui can
/// never poison the file — and the cache is refreshed so the watcher sees
/// the change immediately instead of after the TTL.
#[tauri::command]
pub fn set_overlay_config(table: String, roster: String) -> Result<OverlayConfigResponse, String> {
    let config = OverlayConfig {
        table: parse_table_field(&table),
        roster: parse_roster_field(&roster),
    };
    let dir = paths::ensure_data_dir()?;
    let canonical = canonical_toml(config)?;
    tracing::info!(table = ?config.table, roster = ?config.roster, "overlay config saved");
    settings_store::store(&dir, OVERLAY_CONFIG_FILE, &canonical)?;
    settings_store::retire_legacy_json(&dir, LEGACY_OVERLAY_CONFIG_FILE);
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = Some((Instant::now(), config));
    Ok(config.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-overlay-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// v2 round shape: both fields honored.
    #[test]
    fn parses_v2_fields() {
        // Owner-spec migration: stored `ocr`/`inferred` picks (the retired
        // pixel-comparison pipeline) move to the plugin as the primary.
        let cfg = parse_config(r#"{"table":"off","roster":"ocr"}"#);
        assert_eq!(cfg.table, TableAnchor::Off);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        let cfg = parse_config(r#"{"roster":"inferred"}"#);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        let cfg = parse_config(r#"{"table":"detect","roster":"passive"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Passive);
        // A stored roster "off" lands on passive: the table switch owns the
        // whole overlay's off state, so the roster pick no longer has one.
        let cfg = parse_config(r#"{"table":"detect","roster":"off"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Passive);
        // The in-game display mode (plugin renders, overlay stays down).
        let cfg = parse_config(r#"{"table":"ingame"}"#);
        assert_eq!(cfg.table, TableAnchor::Ingame);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
    }

    /// v1 migration: `{enabled:true}` → detect + plugin,
    /// `{enabled:false}` → off + plugin (recognition had no v1 switch and
    /// keeps its default).
    #[test]
    fn migrates_legacy_enabled() {
        let cfg = parse_config(r#"{"enabled":true}"#);
        assert_eq!(
            cfg,
            OverlayConfig {
                table: TableAnchor::Detect,
                roster: RosterRecognition::Plugin,
            }
        );
        let cfg = parse_config(r#"{"enabled":false}"#);
        assert_eq!(
            cfg,
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Plugin,
            }
        );
    }

    /// Missing file / empty / malformed JSON / non-object JSON → defaults.
    #[test]
    fn garbage_falls_back_to_defaults() {
        for raw in ["", "   ", "not json", "[1,2]", "42", "null", "{}"] {
            assert_eq!(
                parse_config(raw),
                OverlayConfig {
                    table: TableAnchor::Detect,
                    roster: RosterRecognition::Plugin,
                },
                "raw: {raw:?}"
            );
        }
    }

    /// Unknown enum values (a future roster pick, a typo, a wrong type) fall
    /// back to the per-field safe default; absent fields take the v1
    /// migration path.
    #[test]
    fn unknown_values_fall_back_per_field() {
        // "plugin" is a VALID roster pick now; table keeps rejecting it.
        let cfg = parse_config(r#"{"table":"plugin","roster":"plugin"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        let cfg = parse_config(r#"{"table":"future","roster":"future"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        let cfg = parse_config(r#"{"table":42,"roster":null}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        // v2 field present wins over a leftover legacy `enabled: false`.
        let cfg = parse_config(r#"{"enabled":false,"table":"detect"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
    }

    /// The suppression/query helpers branch exactly on the view mode:
    /// `ingame` keeps the overlay down but turns the bridge on; `off`
    /// keeps both down; `detect` is overlay-only.
    #[test]
    fn view_mode_helpers_branch() {
        for (table, suppressed, bridge) in [
            (TableAnchor::Detect, false, false),
            (TableAnchor::Ingame, true, true),
            (TableAnchor::Off, true, false),
        ] {
            assert_eq!(overlay_suppressed(table), suppressed, "{table:?}");
            assert_eq!(bridge_active(table), bridge, "{table:?}");
        }
    }

    /// TOML parse: canonical text round-trips, garbage/non-table TOML and
    /// unknown values fall back per field, and a v1-style TOML `enabled`
    /// key resolves the same way the JSON v1 shape does.
    #[test]
    fn toml_parse_mirrors_json_contract() {
        let canonical = canonical_toml(OverlayConfig {
            table: TableAnchor::Off,
            roster: RosterRecognition::Passive,
        })
        .unwrap();
        assert_eq!(
            resolve_fields(fields_from_toml(&canonical)),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Passive,
            }
        );
        for raw in ["", "garbage [", "42", "[1,2]", "table = \"plugin\""] {
            assert_eq!(
                resolve_fields(fields_from_toml(raw)),
                OverlayConfig::default(),
                "raw: {raw:?}"
            );
        }
        assert_eq!(
            resolve_fields(fields_from_toml("enabled = false\n")),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Plugin,
            }
        );
    }

    /// The full read path against a temp dir: legacy JSON migrates to TOML
    /// (retired only after the write), garbage heals to defaults, and a
    /// canonical file is left byte-identical by repeated reads.
    #[test]
    fn read_path_migrates_and_heals() {
        let dir = temp_dir("read-path");

        // Legacy v2 JSON migrates; v1 JSON migrates through the same pipe.
        std::fs::write(
            dir.join(LEGACY_OVERLAY_CONFIG_FILE),
            r#"{"table":"off","roster":"ocr"}"#,
        )
        .unwrap();
        assert_eq!(
            read_uncached_from(&dir),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Plugin,
            }
        );
        assert!(dir.join(OVERLAY_CONFIG_FILE).exists());
        assert!(!dir.join(LEGACY_OVERLAY_CONFIG_FILE).exists());
        let migrated = std::fs::read_to_string(dir.join(OVERLAY_CONFIG_FILE)).unwrap();
        // Steady state: reading the just-written canonical file leaves it
        // byte-identical (the canonical-text comparison short-circuits).
        assert_eq!(
            read_uncached_from(&dir),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Plugin,
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(OVERLAY_CONFIG_FILE)).unwrap(),
            migrated,
            "steady state: canonical file is not rewritten"
        );

        // Unknown values in the canonical file are corrected on disk.
        std::fs::write(dir.join(OVERLAY_CONFIG_FILE), "table = \"plugin\"\n").unwrap();
        assert_eq!(read_uncached_from(&dir), OverlayConfig::default());
        assert!(
            std::fs::read_to_string(dir.join(OVERLAY_CONFIG_FILE))
                .unwrap()
                .contains("table = \"detect\"")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
