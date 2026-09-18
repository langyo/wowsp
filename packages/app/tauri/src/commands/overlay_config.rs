//! Rust-side read of `overlay-config.json` — the very file the webui's
//! `overlayConfig` pinia store persists (schema v2). The two INDEPENDENT
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
//! field's default instead of erroring.
//!
//! Reading is CHEAP and panic-free by contract: the file is tiny, a TTL
//! cache bounds the disk traffic (the watcher asks on every ~30 ms tick),
//! and every failure — missing file, unreadable, malformed JSON, wrong
//! field types — degrades to the defaults instead of blocking or panicking
//! the watcher thread. Precedence against the `WOWSP_ROW_RECOGNIZER` env
//! lives in `row_recognize::recognizer_enabled`: config `off` always wins;
//! config `ocr`/absent leaves the env-based dev override in charge.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::paths;

/// File name of the overlay config under the appdata root — the same file
/// the webui store reads/writes via `appdata_read` / `appdata_write`.
const OVERLAY_CONFIG_FILE: &str = "overlay-config.json";

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
/// the legacy v1 master switch (see [`table_from_json`]).
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

/// Pure file-content → config parse (v2 fields + v1 `{enabled}` migration).
///
/// v1 migration: the legacy single switch mapped the whole Tab overlay on
/// and off, so it translates onto the `table` field (`detect` / `off`);
/// v1 had no notion of a roster switch, so `roster` takes the v2 default
/// (`ocr`) either way.
fn parse_config(raw: &str) -> OverlayConfig {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return OverlayConfig::default();
    };
    let v = match v {
        serde_json::Value::Object(map) => map,
        // A JSON scalar/array is as good as garbage — defaults.
        _ => return OverlayConfig::default(),
    };
    let table = match v.get("table") {
        Some(field) => parse_table_field(field.as_str().unwrap_or("detect")),
        None => match v.get("enabled").and_then(|e| e.as_bool()) {
            Some(true) => TableAnchor::Detect,
            Some(false) => TableAnchor::Off,
            None => TableAnchor::Detect,
        },
    };
    let roster = match v.get("roster") {
        Some(field) => parse_roster_field(field.as_str().unwrap_or("ocr")),
        None => RosterRecognition::Ocr,
    };
    OverlayConfig { table, roster }
}

/// TTL cache mirror of the last read. The mutex is only ever held for a
/// memcpy-sized critical section; a poisoned lock (a panic while holding
/// it — impossible by contract, but anyway) recovers instead of panicking
/// every later reader.
static CACHE: Mutex<Option<(Instant, OverlayConfig)>> = Mutex::new(None);

/// Read the config file once, uncached. Every IO/parse failure collapses
/// to the defaults — the watcher must keep running whatever the disk says.
fn read_uncached() -> OverlayConfig {
    let raw = paths::data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(OVERLAY_CONFIG_FILE)).ok())
        .unwrap_or_default();
    parse_config(&raw)
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
