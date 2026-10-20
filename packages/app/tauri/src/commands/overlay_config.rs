//! Rust-side read of the overlay settings — the very state the webui's
//! `overlayConfig` pinia store owns (schema v2). The switches the settings
//! modal exposes all need enforcement outside the webui, on threads the
//! store cannot reach:
//!
//! - `table` — the hold-Tab view mode. `"detect"` (default) is the
//!   transparent window overlay anchored to the pixel-detected team table;
//!   `"off"` keeps that window down. A stored `"ingame"` value — the
//!   retired in-game plugin rendering, whose stats bridge this build no
//!   longer ships — resolves to the `"detect"` default and is healed back
//!   to disk like any unknown value.
//! - `aim_card` — the second transparent window: the aimed player's stats
//!   card hanging below the crosshair during battles. On (the default)
//!   unless explicitly `false`; the watcher consults it every tick, so a
//!   flip applies live without touching the window lifecycle. The two
//!   window switches are INDEPENDENT — the watcher and windows stay up
//!   while either is on, each switch suppressing only its own window —
//!   and only both-off tears the whole mode down (the webui lifecycle's
//!   decision; see features/overlay/useOverlayLifecycle.ts).
//! - `aim_card_hang_px` — how far the aim card hangs below the crosshair
//!   (the game window's vertical center), in logical px before DPI
//!   scaling: 60 by default; the settings slider offers 60–240 while its
//!   edit box accepts anything from 0 up (placement clamps the card
//!   inside the game rect, so an oversized value just pins it to the
//!   bottom edge). The watcher consults it every tick, so a change
//!   applies live while the card is up.
//! - `roster` — roster attribution. `"plugin"` (default) treats the
//!   in-game plugin's telemetry as the primary detector: authoritative
//!   alive flags, the TAB screen's own tabModeIn/Out marks and the
//!   game-true per-player Tab sort keys (telemetry `sortKeys`, read off
//!   the ship entities each avatar references — the offline per-realm
//!   key ordering stays the fallback for battles without them); a
//!   missing, outdated or stale plugin degrades that battle to the
//!   passive pipeline. `"passive"` keeps the capture-only pipeline
//!   (row strip detection + luma sink solver) and ignores the plugin
//!   even when installed.
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

use anyhow::{Result, anyhow};

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use wowsp_tauri_shared::CommandResult;

use crate::paths;
use crate::settings_store::{self, SettingsSource};

/// Canonical settings file under the appdata root.
const OVERLAY_CONFIG_FILE: &str = "overlay-config.toml";
/// Pre-TOML persistence (webui wrote this via `appdata_write`) — read once,
/// then retired.
const LEGACY_OVERLAY_CONFIG_FILE: &str = "overlay-config.json";

/// Header prepended to the canonical file. Part of the canonical text used
/// for the heal-write comparison, like in `commands/network`.
const FILE_HEADER: &str = "# WoWSP overlay settings. table = \"detect\" | \"off\", roster = \"plugin\" | \"passive\", aim_card = true | false, aim_card_hang_px = <integer px>.\n\
                           # Invalid values are reset to the defaults by the app.\n";

/// Default hang of the aim card's top edge below the game window's vertical
/// center (where the crosshair sits), in logical px before DPI scaling.
/// The value the retired hardcoded constant carried was 120; the shipped
/// setting default is closer to the crosshair. (Private: every consumer —
/// Default, the resolve path, the tests — lives in this module; the webui
/// keeps its own DEFAULT_AIM_CARD_HANG_PX twin in stores/overlayConfig.ts.)
const AIM_CARD_HANG_DEFAULT_PX: i32 = 60;

/// Sanity clamp for a stored/set hang. Generous headroom over any real
/// monitor: `aim_card_rect` clamps the card inside the game rect anyway, so
/// an oversized value just pins the card to the game window's bottom edge —
/// the clamp only keeps absurd hand-edited numbers from overflowing.
const AIM_CARD_HANG_MAX_PX: i64 = 100_000;

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
    /// The Tab table window is off (the aim card may stay on — the two
    /// window switches are independent).
    Off,
}

/// Roster recognition switch (schema v2 `roster` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RosterRecognition {
    /// In-game plugin telemetry (packages/ingame-plugin) is the PRIMARY
    /// detector: the PnFMods bridge feeds the arena walk order with
    /// authoritative `isAlive` sinking and the TAB screen's own
    /// tabModeIn/Out marks (the TAB ROW order itself stays the frontend's
    /// per-client inference — see the plugin design doc's ordering rule).
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
    /// The aimed-player stats card's window switch (schema v2 `aim_card`):
    /// shown during battles unless the user turned it off.
    pub(crate) aim_card: bool,
    /// The aim card's hang below the crosshair (schema v2
    /// `aim_card_hang_px`): logical px between the game window's vertical
    /// center and the card's top edge, before DPI scaling. Already
    /// sanitized on every path that builds a config ([`sanitize_hang_px`]).
    pub(crate) aim_card_hang_px: i32,
}

impl Default for OverlayConfig {
    fn default() -> Self {
        Self {
            table: TableAnchor::Detect,
            roster: RosterRecognition::Plugin,
            aim_card: true,
            aim_card_hang_px: AIM_CARD_HANG_DEFAULT_PX,
        }
    }
}

/// Clamp a hang value from any integer source (file or IPC) into the sane
/// range — negatives land at 0 (the card's top edge on the crosshair),
/// absurd sizes at [`AIM_CARD_HANG_MAX_PX`] (placement pins those to the
/// game rect's bottom edge anyway).
fn sanitize_hang_px(raw: i64) -> i32 {
    raw.clamp(0, AIM_CARD_HANG_MAX_PX) as i32
}

/// Parse the v2 `table` field. Present-but-unknown values (a typo, a wrong
/// type, the RETIRED `"ingame"` in-game rendering — its stats bridge is
/// gone, so the overlay window takes over) fall back to the safe default —
/// the overlay must never brick itself over a config typo, and the read's
/// heal-write makes the correction stick. An ABSENT field defers to the
/// legacy v1 master switch (see [`resolve_fields`]).
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

/// The neutral field set both file formats reduce to before resolution.
#[derive(Default)]
struct RawOverlayFields {
    table: Option<String>,
    roster: Option<String>,
    aim_card: Option<bool>,
    aim_card_hang_px: Option<i64>,
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
    OverlayConfig {
        table,
        roster,
        aim_card: fields.aim_card.unwrap_or(true),
        aim_card_hang_px: fields
            .aim_card_hang_px
            .map(sanitize_hang_px)
            .unwrap_or(AIM_CARD_HANG_DEFAULT_PX),
    }
}

/// Extract the field set from a JSON document (legacy file or v1 shape).
/// Non-object JSON is as good as garbage → empty set → defaults.
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
        aim_card: map.get("aim_card").and_then(|v| v.as_bool()),
        aim_card_hang_px: map.get("aim_card_hang_px").and_then(|v| v.as_i64()),
        enabled: map.get("enabled").and_then(|v| v.as_bool()),
    }
}

/// Extract the field set from a TOML document (the canonical file).
/// Non-table TOML → empty set → defaults.
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
        aim_card: map.get("aim_card").and_then(|v| v.as_bool()),
        aim_card_hang_px: map.get("aim_card_hang_px").and_then(|v| v.as_integer()),
        enabled: map.get("enabled").and_then(|v| v.as_bool()),
    }
}

/// Pure JSON parse (kept for the tests and the legacy migration path).
fn parse_config(raw: &str) -> OverlayConfig {
    resolve_fields(fields_from_json(raw))
}

/// The on-disk shape (flat TOML table; every key always present — a
/// missing key means the same as an unknown one, the field's default).
#[derive(Debug, Serialize, Deserialize)]
struct OverlayConfigTomlFile {
    table: String,
    roster: String,
    aim_card: bool,
    aim_card_hang_px: i32,
}

/// Serialize the canonical file text (header + flat TOML keys).
fn canonical_toml(config: OverlayConfig) -> Result<String> {
    let file = OverlayConfigTomlFile {
        table: config.table.as_str().to_string(),
        roster: config.roster.as_str().to_string(),
        aim_card: config.aim_card,
        aim_card_hang_px: config.aim_card_hang_px,
    };
    let body = toml::to_string(&file).map_err(|e| anyhow!("serialize overlay config: {e}"))?;
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

/// Whether the transparent Tab TABLE window must stay down: only the
/// explicit `"off"` pick suppresses that window and every table-side
/// watcher show (the aim card has its own switch and keeps running).
pub(crate) fn table_overlay_off() -> bool {
    overlay_suppressed(current().table)
}

/// Whether the aimed-player stats card must stay up (the default): the
/// watcher's per-tick aim-card pass consults this, so a flip applies live
/// while the card's window stays owned by the lifecycle.
pub(crate) fn aim_card_shown() -> bool {
    current().aim_card
}

/// The aim card's configured hang below the crosshair (logical px; DPI
/// scaling is applied at placement). The watcher's placement pass consults
/// this every tick together with the game rect, so a settings change
/// re-places the card live — even while the game window stands still.
pub(crate) fn aim_card_hang_px() -> i32 {
    current().aim_card_hang_px
}

/// Pure core of [`table_overlay_off`], unit-testable without the cache.
fn overlay_suppressed(table: TableAnchor) -> bool {
    table != TableAnchor::Detect
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
    pub aim_card: bool,
    pub aim_card_hang_px: i32,
}

impl From<OverlayConfig> for OverlayConfigResponse {
    fn from(config: OverlayConfig) -> Self {
        Self {
            table: config.table.as_str().to_string(),
            roster: config.roster.as_str().to_string(),
            aim_card: config.aim_card,
            aim_card_hang_px: config.aim_card_hang_px,
        }
    }
}

/// The stored overlay config for the webui store — performs the same
/// migration/heal pass a watcher read would, so the very first settings
/// render after an upgrade already reflects (and persists) the fix.
#[tauri::command]
pub fn get_overlay_config() -> CommandResult<OverlayConfigResponse> {
    Ok(current().into())
}

/// Persist all switches. Inputs are sanitized with the same per-field
/// defaults a file read applies — an unknown value from a newer webui can
/// never poison the file — and the cache is refreshed so the watcher sees
/// the change immediately instead of after the TTL.
#[tauri::command]
pub fn set_overlay_config(
    table: String,
    roster: String,
    aim_card: bool,
    aim_card_hang_px: i64,
) -> CommandResult<OverlayConfigResponse> {
    let config = OverlayConfig {
        table: parse_table_field(&table),
        roster: parse_roster_field(&roster),
        aim_card,
        aim_card_hang_px: sanitize_hang_px(aim_card_hang_px),
    };
    let dir = paths::ensure_data_dir()?;
    let canonical = canonical_toml(config)?;
    tracing::info!(table = ?config.table, roster = ?config.roster, aim_card = config.aim_card, aim_card_hang_px = config.aim_card_hang_px, "overlay config saved");
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

    /// v2 round shape: all fields honored, including the aim-card boolean's
    /// explicit off.
    #[test]
    fn parses_v2_fields() {
        // Owner-spec migration: stored `ocr`/`inferred` picks (the retired
        // pixel-comparison pipeline) move to the plugin as the primary.
        let cfg = parse_config(r#"{"table":"off","roster":"ocr"}"#);
        assert_eq!(cfg.table, TableAnchor::Off);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        assert!(cfg.aim_card);
        let cfg = parse_config(r#"{"roster":"inferred"}"#);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        let cfg = parse_config(r#"{"table":"detect","roster":"passive"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Passive);
        // A stored roster "off" lands on passive: the table switch owns the
        // table window's off state, so the roster pick no longer has one.
        let cfg = parse_config(r#"{"table":"detect","roster":"off"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Passive);
        // The RETIRED in-game display pick ("ingame") resolves to the
        // detect default — the overlay window takes over, and the read's
        // heal-write rewrites the stored value.
        let cfg = parse_config(r#"{"table":"ingame"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
        assert_eq!(cfg.roster, RosterRecognition::Plugin);
        // An explicit aim-card off survives; absent/false stay the default.
        let cfg = parse_config(r#"{"table":"detect","aim_card":false}"#);
        assert!(!cfg.aim_card);
        let cfg = parse_config(r#"{"aim_card":true}"#);
        assert!(cfg.aim_card);
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
                aim_card: true,
                ..Default::default()
            }
        );
        let cfg = parse_config(r#"{"enabled":false}"#);
        assert_eq!(
            cfg,
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Plugin,
                aim_card: true,
                ..Default::default()
            }
        );
    }

    /// Missing file / empty / malformed JSON / non-object JSON → defaults.
    #[test]
    fn garbage_falls_back_to_defaults() {
        for raw in ["", "   ", "not json", "[1,2]", "42", "null", "{}"] {
            assert_eq!(parse_config(raw), OverlayConfig::default(), "raw: {raw:?}");
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
        // A wrong-typed aim_card lands on the true default.
        let cfg = parse_config(r#"{"aim_card":"off"}"#);
        assert!(cfg.aim_card);
        // v2 field present wins over a leftover legacy `enabled: false`.
        let cfg = parse_config(r#"{"enabled":false,"table":"detect"}"#);
        assert_eq!(cfg.table, TableAnchor::Detect);
    }

    /// The suppression helper branches exactly on the view mode: `off`
    /// keeps the overlay down, `detect` is the only overlay-on state.
    #[test]
    fn view_mode_helpers_branch() {
        assert!(!overlay_suppressed(TableAnchor::Detect));
        assert!(overlay_suppressed(TableAnchor::Off));
    }

    /// The hang field: honored when valid, clamped into [0, MAX] when out
    /// of range, defaulted when absent or wrong-typed — on both the JSON
    /// and TOML read paths and the IPC set path.
    #[test]
    fn hang_px_sanitizes() {
        // In-range values ride through verbatim (the slider's 60–240 plus
        // the edit box's below/above-range picks).
        for raw in [0, 1, 59, 60, 240, 540, 4096] {
            assert_eq!(
                parse_config(&format!(r#"{{"aim_card_hang_px":{raw}}}"#)).aim_card_hang_px,
                raw,
                "raw: {raw}"
            );
        }
        // Negatives clamp to 0 (the card's top edge on the crosshair);
        // absurd sizes clamp at the sanity ceiling (placement pins those to
        // the game rect's bottom edge anyway).
        assert_eq!(
            parse_config(r#"{"aim_card_hang_px":-50}"#).aim_card_hang_px,
            0
        );
        assert_eq!(
            parse_config(r#"{"aim_card_hang_px":999999999999}"#).aim_card_hang_px,
            AIM_CARD_HANG_MAX_PX as i32
        );
        // Wrong type / absent → the default (and the read path heals it).
        assert_eq!(
            parse_config(r#"{"aim_card_hang_px":"far"}"#).aim_card_hang_px,
            AIM_CARD_HANG_DEFAULT_PX
        );
        assert_eq!(
            parse_config("{}").aim_card_hang_px,
            AIM_CARD_HANG_DEFAULT_PX
        );
        // The TOML path mirrors the contract, float included (a hand-edited
        // 60.5 is not an integer and lands on the default like any wrong
        // type).
        assert_eq!(
            resolve_fields(fields_from_toml("aim_card_hang_px = 240\n")).aim_card_hang_px,
            240
        );
        assert_eq!(
            resolve_fields(fields_from_toml("aim_card_hang_px = 60.5\n")).aim_card_hang_px,
            AIM_CARD_HANG_DEFAULT_PX
        );
        // The IPC set path sanitizes through the same clamp.
        assert_eq!(sanitize_hang_px(-1), 0);
        assert_eq!(sanitize_hang_px(130), 130);
        assert_eq!(sanitize_hang_px(i64::MAX), AIM_CARD_HANG_MAX_PX as i32);
    }

    /// TOML parse: canonical text round-trips (the aim-card boolean
    /// included), garbage/non-table TOML and unknown values fall back per
    /// field, and a v1-style TOML `enabled` key resolves the same way the
    /// JSON v1 shape does.
    #[test]
    fn toml_parse_mirrors_json_contract() {
        let canonical = canonical_toml(OverlayConfig {
            table: TableAnchor::Off,
            roster: RosterRecognition::Passive,
            aim_card: false,
            aim_card_hang_px: 240,
        })
        .unwrap();
        assert!(canonical.contains("aim_card = false"));
        assert!(canonical.contains("aim_card_hang_px = 240"));
        assert_eq!(
            resolve_fields(fields_from_toml(&canonical)),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Passive,
                aim_card: false,
                aim_card_hang_px: 240,
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
                aim_card: true,
                ..Default::default()
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
            r#"{"table":"off","roster":"ocr","aim_card":false}"#,
        )
        .unwrap();
        assert_eq!(
            read_uncached_from(&dir),
            OverlayConfig {
                table: TableAnchor::Off,
                roster: RosterRecognition::Plugin,
                aim_card: false,
                ..Default::default()
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
                aim_card: false,
                ..Default::default()
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(OVERLAY_CONFIG_FILE)).unwrap(),
            migrated,
            "steady state: canonical file is not rewritten"
        );
        assert!(migrated.contains("aim_card = false"));

        // A pre-aim-card legacy file (the realistic v2 shape older builds
        // wrote) migrates with the field landing on the true default. The
        // canonical file from the previous scenario is retired first — the
        // loader prefers it over the legacy JSON.
        std::fs::remove_file(dir.join(OVERLAY_CONFIG_FILE)).unwrap();
        std::fs::write(
            dir.join(LEGACY_OVERLAY_CONFIG_FILE),
            r#"{"table":"detect","roster":"plugin"}"#,
        )
        .unwrap();
        assert_eq!(read_uncached_from(&dir), OverlayConfig::default());
        assert!(dir.join(OVERLAY_CONFIG_FILE).exists());
        assert!(!dir.join(LEGACY_OVERLAY_CONFIG_FILE).exists());
        assert!(
            std::fs::read_to_string(dir.join(OVERLAY_CONFIG_FILE))
                .unwrap()
                .contains("aim_card = true")
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
