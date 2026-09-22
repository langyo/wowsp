//! Rust-side read of the overlay settings — the very state the webui's
//! `overlayConfig` pinia store owns (schema v2). The two INDEPENDENT
//! switches the settings modal exposes both need enforcement outside the
//! webui, on threads the store cannot reach:
//!
//! - `table` — table anchoring. `"detect"` (default) anchors the chips to
//!   the pixel-detected team table; `"off"` disables the whole Tab overlay:
//!   the webui never creates the overlay window, and the Rust Tab watcher
//!   (belt-and-suspenders — see `watch_tab_tick`) suppresses every show.
//! - `roster` — roster recognition. `"ocr"` (default) keeps the Windows OCR
//!   row→name pipeline; `"off"` skips it entirely — the anchor carries no
//!   `row_players` payload, the overlay page falls back to the historical
//!   roster/index order, and no "recognizing roster" pending badge is ever
//!   reported.
//!
//! The values are deliberately parsed as plain enums with a per-field safe
//! default, so a future third option (e.g. `"plugin"`) can be added to the
//! schema without breaking older reads: an unknown value resolves to the
//! field's default instead of erroring — and, since the TOML move, is
//! FORCED back to disk so the correction sticks (see `settings_store`).
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
//! panicking the watcher thread. Precedence against the `WOWSP_ROW_RECOGNIZER`
//! env lives in `row_recognize::recognizer_enabled`: config `off` always
//! wins; config `ocr`/absent leaves the env-based dev override in charge.

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
const FILE_HEADER: &str = "# WoWSP overlay settings. table = \"detect\" | \"off\", roster = \"ocr\" | \"off\".\n\
                           # Invalid values are reset to the defaults by the app.\n";

/// How long a cached read stays fresh. The file only changes when the user
/// flips a settings switch, so a couple of seconds of staleness bounds the
/// enforcement delay while keeping the ~30 ms watcher tick at a mutex-guard
/// memcpy in the steady state.
const CONFIG_TTL: Duration = Duration::from_secs(2);

/// Table anchoring switch (schema v2 `table` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TableAnchor {
    /// Pixel detection — the current behavior (default).
    Detect,
    /// The whole Tab overlay feature is off.
    Off,
}

/// Roster recognition switch (schema v2 `roster` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RosterRecognition {
    /// Windows OCR row→name matching — the current default pipeline.
    Ocr,
    /// Recognition off: chips follow the roster/index order.
    Off,
}

impl TableAnchor {
    fn as_str(self) -> &'static str {
        match self {
            TableAnchor::Detect => "detect",
            TableAnchor::Off => "off",
        }
    }
}

impl RosterRecognition {
    fn as_str(self) -> &'static str {
        match self {
            RosterRecognition::Ocr => "ocr",
            RosterRecognition::Off => "off",
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
            roster: RosterRecognition::Ocr,
        }
    }
}

/// Parse the v2 `table` field. Present-but-unknown values (a future
/// `"plugin"`, a wrong type) fall back to the safe default — the overlay
/// must never brick itself over a config typo. An ABSENT field defers to
/// the legacy v1 master switch (see [`resolve_fields`]).
fn parse_table_field(raw: &str) -> TableAnchor {
    match raw {
        "off" => TableAnchor::Off,
        // "detect" and anything unrecognized (incl. future values).
        _ => TableAnchor::Detect,
    }
}

/// Parse the v2 `roster` field with the same unknown-value contract.
fn parse_roster_field(raw: &str) -> RosterRecognition {
    match raw {
        "off" => RosterRecognition::Off,
        // "ocr" and anything unrecognized (incl. future values).
        _ => RosterRecognition::Ocr,
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
        None => RosterRecognition::Ocr,
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

/// Whether roster recognition is switched OFF in the user's settings.
pub(crate) fn roster_recognition_off() -> bool {
    current().roster == RosterRecognition::Off
}

/// Whether the whole Tab overlay (table anchoring) is switched OFF.
pub(crate) fn table_overlay_off() -> bool {
    current().table == TableAnchor::Off
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
        let cfg = parse_config(r#"{"table":"off","roster":"ocr"}"#);
        assert_eq!(cfg.table, TableAnchor::Off);
        assert_eq!(cfg.roster, RosterRecognition::Ocr);
        let cfg = parse_config(r#"{"table":"detect","roster":"off"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Off);
    }

    /// v1 migration: `{enabled:true}` → detect + ocr, `{enabled:false}` →
    /// off + ocr (recognition had no v1 switch and keeps its default).
    #[test]
    fn migrates_legacy_enabled() {
        let cfg = parse_config(r#"{"enabled":true}"#);
        assert_eq!(
            cfg,
            OverlayConfig {
                table: TableAnchor::Detect,
                roster: RosterRecognition::Ocr,
            }
        );
        let cfg = parse_config(r#"{"enabled":false}"#);
        assert_eq!(
            cfg,
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Ocr,
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
                    roster: RosterRecognition::Ocr,
                },
                "raw: {raw:?}"
            );
        }
    }

    /// Unknown enum values (a future `plugin`, a typo, a wrong type) fall
    /// back to the per-field safe default; absent fields take the v1
    /// migration path.
    #[test]
    fn unknown_values_fall_back_per_field() {
        let cfg = parse_config(r#"{"table":"plugin","roster":"plugin"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Ocr);
        let cfg = parse_config(r#"{"table":42,"roster":null}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Ocr);
        // v2 field present wins over a leftover legacy `enabled: false`.
        let cfg = parse_config(r#"{"enabled":false,"table":"detect"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
    }

    /// TOML parse: canonical text round-trips, garbage/non-table TOML and
    /// unknown values fall back per field, and a v1-style TOML `enabled`
    /// key resolves the same way the JSON v1 shape does.
    #[test]
    fn toml_parse_mirrors_json_contract() {
        let canonical = canonical_toml(OverlayConfig {
            table: TableAnchor::Off,
            roster: RosterRecognition::Off,
        })
        .unwrap();
        assert_eq!(
            resolve_fields(fields_from_toml(&canonical)),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Off,
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
                roster: RosterRecognition::Ocr,
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
                roster: RosterRecognition::Ocr,
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
                roster: RosterRecognition::Ocr,
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
