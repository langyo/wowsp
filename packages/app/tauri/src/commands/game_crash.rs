//! Game-crash detection for the World of Warships client.
//!
//! WoWSP never launches the client itself (the game is started by the
//! player, Wargaming Game Center, Steam or the CN launchers), so a crash
//! cannot be observed through a child-process handle. This module watches
//! from the outside instead: a lightweight watchdog thread tracks every
//! running client pid, and when one disappears it hunts for the crash
//! evidence Windows leaves behind —
//!
//! * the Application event log (Event ID 1000 "Application Error" and
//!   Event ID 1001 "Windows Error Reporting", queried with the system
//!   wevtutil tool — no extra crate, and the query only runs at the moment
//!   a client actually vanishes, never per tick);
//! * WER report folders (per-user and machine-wide ReportArchive /
//!   ReportQueue, both exist in the wild: several systems redirect reports
//!   to C:/ProgramData entirely);
//! * the LocalDumps folder (%LOCALAPPDATA%/CrashDumps, one
//!   name.pid.dmp file per crash).
//!
//! Evidence found means crash: a record is persisted (crash-history.json in
//! the app-data root) and broadcast to every window as wowsp://game-crash,
//! where the webui offers the safe-mode + restart flow. No evidence means a
//! clean exit (the player closed the client) and the watchdog stays silent.
//!
//! The follow-up surfaces are explicit user-invoked commands only: an
//! analysis pass that correlates the crash with the game's own logs
//! (profile/python.log, profile/clientrunner.log — the layout the repo
//! actually attests; a logs/ dir is honoured when a client ships one), the
//! res_mods inventory (recently-touched mods are the classic crash
//! culprit), the WoWSP diagnostics log, and a redacted zip export shaped
//! like the feedback bundle. The restart command launches the install's
//! own root stub (WorldOfWarships.exe / Korabli.exe) and deliberately drops
//! the child handle — the client must outlive this process and must NEVER
//! be killed by it; the watchdog only ever observes.
//!
//! Everything is Windows-scoped in substance; the command surface stays
//! registered on every target so the webui can call it unconditionally
//! (mobile answers empty lists / errors, exactly like is_game_running).

use anyhow::anyhow;
#[cfg(windows)]
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(windows)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use wowsp_tauri_shared::CommandResult;

use crate::logging::redact::Redactor;

// ── constants ────────────────────────────────────────────────────────────────

/// Tauri event name broadcast when a client crash is confirmed.
pub const GAME_CRASH_EVENT: &str = "wowsp://game-crash";

/// Crash-history file in the app-data root (flat name, like playtime.json).
const HISTORY_FILE: &str = "crash-history.json";

/// Retained crash records before the oldest drops off.
const MAX_HISTORY: usize = 20;

/// How often the watchdog polls the process list. The session poller runs
/// every 3 s against the same primitives; a slower cadence costs nothing in
/// promptness (the user-visible prompt is allowed to land a few seconds
/// after the crash) and halves the OpenProcess traffic.
#[cfg(windows)]
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// A pid must be missing from this many consecutive polls before its exit
/// is classified — one Toolhelp snapshot gap must not read as a crash.
#[cfg(windows)]
const ABSENCE_CONFIRMATIONS: u32 = 2;

/// Slack around the last-seen timestamp when hunting crash evidence:
/// clock fuzz, the two confirmation polls, and WER writing its report a
/// moment after the process died.
#[cfg(windows)]
const EVIDENCE_SLACK_SECS: i64 = 30;

/// Evidence-source tags persisted on every record.
pub const SOURCE_EVENT_LOG: &str = "event-log";
pub const SOURCE_WER_REPORT: &str = "wer-report";
pub const SOURCE_CRASH_DUMP: &str = "crash-dump";
/// WG's own crash handler reports under <game>/crashes — on installs whose
/// WER handoff is suppressed (the observed CN/Steam shape) this folder is
/// the ONLY durable crash evidence.
pub const SOURCE_GAME_REPORT: &str = "game-report";

/// Record lifecycle: a fresh detection is "new"; the webui's dismiss
/// action flips it so the prompt does not reappear.
pub const STATUS_NEW: &str = "new";
pub const STATUS_DISMISSED: &str = "dismissed";

// ── wire types ───────────────────────────────────────────────────────────────

/// One confirmed client crash. Persisted in crash-history.json (newest
/// first) and broadcast as the wowsp://game-crash payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCrashRecord {
    /// Stable id (timestamp + pid based) the webui keys analysis, export
    /// and dismiss calls on.
    pub id: String,
    /// RFC 3339 UTC timestamp of the detection.
    pub detected_at: String,
    /// OS pid of the vanished client.
    pub pid: u32,
    /// Client process-image name (lowercase), e.g. worldofwarships64.exe.
    pub image_name: String,
    /// Install folder the client ran from, when resolvable.
    pub game_root: Option<String>,
    /// Distribution family of that install (Steam / Wargaming / Lesta / ...).
    pub install_kind: Option<wowsp_tauri_shared::GameInstallKind>,
    /// bin/<build> number the install was on at crash time.
    pub game_build: Option<String>,
    /// Which evidence source confirmed the crash (event-log / wer-report /
    /// crash-dump).
    pub source: String,
    /// Normalized exception code (0xC0000005 shape), when the evidence
    /// carried one.
    pub exception_code: Option<String>,
    /// Faulting module from the event log / WER report, when named.
    pub faulting_module: Option<String>,
    /// WER report folder backing the record, when found.
    pub wer_report_path: Option<String>,
    /// Crash dump file backing the record, when found.
    pub crash_dump_path: Option<String>,
    /// Raw one-line evidence summary (event-log text shape).
    pub summary: Option<String>,
    /// Whether the install had an active, non-empty res_mods at crash time
    /// (mods-in-play hint for the "is it the mods?" bisect).
    pub mods_active: bool,
    /// new | dismissed.
    pub status: String,
    /// Stable evidence identity (evt:<record-id> / wer:<dir-name> /
    /// dmp:<file-name>) — the recent-crash backfill dedupes on it so the
    /// same historical crash never imports twice. Live detections leave
    /// it empty (their time window dedupes them).
    #[serde(default)]
    pub evidence_id: Option<String>,
}

/// One analysis finding: a stable i18n code the webui translates, a
/// severity, and an optional raw detail (module name, mod names, count)
/// the message templates interpolate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashFinding {
    pub code: String,
    /// info | warning | critical.
    pub severity: String,
    pub detail: Option<String>,
}

/// A redacted tail of one log file plus its interesting lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogExcerpt {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    /// RFC 3339 UTC, when the filesystem said.
    pub modified: Option<String>,
    /// Last lines, redacted (the same Redactor the feedback bundle uses).
    pub tail: String,
    /// Lines in the tail window carrying error-shaped keywords, capped.
    pub highlights: Vec<String>,
}

/// One res_mods top-level entry for the inventory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    pub name: String,
    pub is_dir: bool,
    /// RFC 3339 UTC, when the filesystem said.
    pub modified: Option<String>,
}

/// One res_mods entry the analysis pins as a plausible crash culprit,
/// ranked by evidence strength. The webui enriches each suspect against
/// the mod hub's installed units: a suspect no unit claims renders as an
/// unknown mod, pinned + yellow-flagged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuspectMod {
    /// Top-level res_mods entry name (folder or file).
    pub name: String,
    /// logMention (the game log named it in an error-shaped line under
    /// res_mods) — stronger than recentChange (modified inside the 24 h
    /// before the crash).
    pub evidence: String,
    /// The redacted log lines that named it (logMention only).
    pub log_lines: Vec<String>,
}

/// One entry moved out of res_mods into the per-version quarantine dir.
/// The manifest (wowsp-quarantine.json inside the quarantine dir) is the
/// single source of truth for restoring; entries stay until restored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineEntry {
    /// Original res_mods entry name.
    pub name: String,
    /// The crash record that prompted the quarantine, when it was one.
    pub crash_id: Option<String>,
    /// RFC 3339 UTC of the move.
    pub quarantined_at: String,
}

/// The crash-analysis answer: the record, the findings, the log excerpts,
/// the mods inventory. Everything user-visible downstream is already
/// redacted; the webui renders + exports it as-is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashAnalysis {
    pub record: GameCrashRecord,
    pub findings: Vec<CrashFinding>,
    pub game_logs: Vec<LogExcerpt>,
    pub app_logs: Vec<LogExcerpt>,
    pub mods_inventory: Vec<ModEntry>,
    /// Crash-culprit candidates, strongest evidence first.
    pub suspects: Vec<SuspectMod>,
    /// bin/<build> the analysis resolved the install to right now (may be
    /// newer than the record's crash-time build when the client updated).
    pub current_build: Option<String>,
    pub generated_at: String,
}

/// The restart command's answer: what was launched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRestartInfo {
    pub game_root: String,
    pub exe_path: String,
    pub pid: u32,
}

/// Internal: crash evidence as collected from the OS before it becomes a
/// record. Not a wire type.
#[cfg(windows)]
#[derive(Debug, Default)]
struct CrashEvidence {
    source: &'static str,
    /// EventRecordID when the event log backed this evidence — rides onto
    /// the record's evidence_id so live detections dedupe against future
    /// backfills even after history truncation.
    record_id: Option<u64>,
    exception_code: Option<String>,
    faulting_module: Option<String>,
    report_path: Option<String>,
    dump_path: Option<String>,
    summary: String,
}

// ── small shared helpers ─────────────────────────────────────────────────────

/// Unix seconds for a SystemTime (0 for before-epoch oddities).
fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Unix seconds now.
#[cfg(windows)]
fn unix_now() -> i64 {
    unix_secs(SystemTime::now())
}

/// RFC 3339 UTC for a SystemTime, when present.
fn rfc3339(t: Option<SystemTime>) -> Option<String> {
    t.map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}

/// The file-stem of a process image name, lowercase (worldofwarships64)
/// — the name WITHOUT the .exe extension, the shape WER folder names and
/// LocalDumps file names key on.
fn image_stem(image: &str) -> String {
    let lower = image.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .map(|(stem, _)| stem.to_string())
        .unwrap_or(lower)
}

/// Normalize an exception code to the canonical 0xC0000005 shape. Accepts
/// the event-log and Report.wer spellings (0xc0000005, c0000005, C0000005).
fn normalize_exception_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let value = u32::from_str_radix(trimmed, 16).ok()?;
    Some(format!("0x{value:08X}"))
}

// ── crash history (app-data JSON, newest first) ──────────────────────────────

/// Serialize-history lock: appends and dismissals are read-modify-write on
/// one small file, and the watchdog thread + IPC commands race on it.
///
/// The backfill tombstones: evidence ids every import has EVER recorded.
/// The 20-record history cap evicts old records (with their evidence ids),
/// so without this list the backfill would re-import an old crash after it
/// scrolled out — resetting its dismissed state and re-raising the prompt.
const BACKFILL_SEEN_FILE: &str = "crash-backfill-seen.json";
/// Tombstone retention: generous against the 14-day harvest horizon.
const BACKFILL_SEEN_CAP: usize = 200;

/// One backfill at a time: the harvest-dedupe-import sequence must be
/// atomic against itself (startup thread vs scan command vs toggle edge).
static BACKFILL_LOCK: Mutex<()> = Mutex::new(());

/// Serializes every tombstone read-modify-write: the live detection path
/// appends ids while a backfill may be saving its own batch — an unlocked
/// save would clobber the fresh live id (lost update → re-import later).
static SEEN_LOCK: Mutex<()> = Mutex::new(());

/// Load the tombstones; a damaged file resets to empty (the time-window
/// dedupe still holds the line).
fn load_seen_in(dir: &Path) -> Vec<String> {
    super::appdata::read_json_in(dir, BACKFILL_SEEN_FILE)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Persist the tombstones (newest first, capped).
fn save_seen_in(dir: &Path, seen: &[String]) {
    let mut owned: Vec<String> = seen.to_vec();
    owned.truncate(BACKFILL_SEEN_CAP);
    if let Ok(text) = serde_json::to_string(&owned) {
        if let Err(e) = super::appdata::write_json_in(dir, BACKFILL_SEEN_FILE, &text) {
            tracing::warn!(error = %e, "persist backfill tombstones failed");
        }
    }
}
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

/// Load the crash history from one dir; None when the file is absent.
/// A damaged file ERRORS through (never silently clobbered — the same
/// contract as the contribution store).
fn load_history_in(dir: &Path) -> anyhow::Result<Option<Vec<GameCrashRecord>>> {
    let Some(text) = super::appdata::read_json_in(dir, HISTORY_FILE)? else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&text)?)
}

/// Append one record (newest first) under the retention cap.
fn append_record_in(dir: &Path, record: &GameCrashRecord) -> anyhow::Result<()> {
    let _guard = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut records = load_history_in(dir)?.unwrap_or_default();
    records.insert(0, record.clone());
    // Backfill batches import chronologically; a live push can land between
    // them — the contract the webui renders is newest-first by detected_at.
    records.sort_by(|a, b| b.detected_at.cmp(&a.detected_at));
    records.truncate(MAX_HISTORY);
    super::appdata::write_json_in(dir, HISTORY_FILE, &serde_json::to_string(&records)?)
}

/// Flip one record's status to dismissed; missing ids are an error so a
/// stale UI cannot think it silenced something that is not there.
fn dismiss_record_in(dir: &Path, record_id: &str) -> anyhow::Result<()> {
    let _guard = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut records = load_history_in(dir)?.ok_or_else(|| anyhow!("no crash history yet"))?;
    let count = records
        .iter_mut()
        .filter(|r| r.id == record_id)
        .map(|r| r.status = STATUS_DISMISSED.to_string())
        .count();
    if count == 0 {
        return Err(anyhow!("crash record {record_id} not found"));
    }
    super::appdata::write_json_in(dir, HISTORY_FILE, &serde_json::to_string(&records)?)
}

/// One record lookup, newest first.
fn find_record_in(dir: &Path, record_id: &str) -> anyhow::Result<Option<GameCrashRecord>> {
    Ok(load_history_in(dir)?.and_then(|records| records.into_iter().find(|r| r.id == record_id)))
}

// ── per-mod quarantine ───────────────────────────────────────────────────────

/// The per-version quarantine dir (a sibling of res_mods, OUTSIDE the
/// load path — the game never reads it): bin/<build>/res_mods.wowsp-quarantine.
const QUARANTINE_DIR_NAME: &str = "res_mods.wowsp-quarantine";
/// The quarantine manifest inside that dir.
const QUARANTINE_MANIFEST: &str = "wowsp-quarantine.json";

/// The (version dir, quarantine dir) pair of one install.
fn quarantine_dir_of(root: &str) -> anyhow::Result<(PathBuf, PathBuf)> {
    let Some((_, ver_dir)) = super::mod_hub::latest_bin_version(root) else {
        return Err(anyhow!("no numeric bin/<version> under {root}\\bin"));
    };
    let quarantine = ver_dir.join(QUARANTINE_DIR_NAME);
    Ok((ver_dir, quarantine))
}

/// Reject anything that is not a plain top-level entry name — the commands
/// take a webview-supplied name, so path plumbing is refused outright.
/// Normalize a webview-supplied quarantine subject into a SAFE relative
/// path under res_mods: forward slashes only, every component a plain
/// name (no dot-dot, no dot-prefix, no drive colon, no separators), so
/// the move can never escape the tree. Top-level entries and nested
/// files (the dangling-reference fix quarantines single files) both pass.
fn sanitize_entry_name(entry_name: &str) -> anyhow::Result<String> {
    let backslash = "\\".chars().next().unwrap();
    let normalized = entry_name.trim().replace(backslash, "/");
    if normalized.starts_with("/") || normalized.is_empty() {
        return Err(anyhow!("invalid res_mods entry name: {entry_name:?}"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for component in normalized.split("/") {
        if component.is_empty()
            || component == ".."
            || component.starts_with(".")
            || component.contains(":")
        {
            return Err(anyhow!("invalid res_mods entry name: {entry_name:?}"));
        }
        parts.push(component);
    }
    Ok(parts.join("/"))
}

/// Load the quarantine manifest; empty vec when absent, damaged errors
/// through (same contract as the crash history).
fn load_quarantine_manifest(quarantine_dir: &Path) -> anyhow::Result<Vec<QuarantineEntry>> {
    let Some(text) = super::appdata::read_json_in(quarantine_dir, QUARANTINE_MANIFEST)? else {
        return Ok(Vec::new());
    };
    Ok(serde_json::from_str(&text)?)
}

/// Persist the quarantine manifest.
fn save_quarantine_manifest(
    quarantine_dir: &Path,
    entries: &[QuarantineEntry],
) -> anyhow::Result<()> {
    super::appdata::write_json_in(
        quarantine_dir,
        QUARANTINE_MANIFEST,
        &serde_json::to_string(entries)?,
    )
}

/// The shared mutate body behind quarantine + restore: resolve the dirs,
/// guard the game closed, move the entry one way, update the manifest
/// atomically (move first, manifest second — a crash between the two
/// leaves an unlisted entry that restore-all / a manual look still finds).
fn mutate_quarantine(
    root: &str,
    entry_name: &str,
    crash_id: Option<&str>,
    quarantining: bool,
) -> anyhow::Result<Vec<QuarantineEntry>> {
    super::mod_hub::ensure_known_game_root(root)?;
    super::mod_hub::ensure_game_closed(root)?;
    let name = sanitize_entry_name(entry_name)?;
    let (_, res_mods) = super::game_context::latest_bin_dir(Path::new(root))
        .map(|(_, ver_dir)| (ver_dir.clone(), ver_dir.join("res_mods")))
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {root}\\bin"))?;
    let (_, quarantine_dir) = quarantine_dir_of(root)?;
    fs::create_dir_all(&quarantine_dir)?;

    // The quarantine SOURCE follows the same active-or-twin rule the
    // analysis reads: a crash already answered with safe mode leaves every
    // mod in the twin, and the pinned file must still be quarantineable
    // from there. Restore always lands in the ACTIVE res_mods.
    // The quarantine SOURCE is wherever the subject actually lives: the
    // active res_mods first, then the safe-mode twin — a crash already
    // answered with safe mode leaves the whole mod set in the twin and the
    // pinned file must still be quarantineable from there. Restore always
    // lands in the ACTIVE res_mods.
    let (source, target) = if quarantining {
        let subject = if res_mods.join(&name).exists() {
            res_mods.join(&name)
        } else {
            super::mod_hub::disabled_res_mods(quarantine_dir.parent().unwrap_or(Path::new(root)))
                .join(&name)
        };
        (subject, quarantine_dir.join(&name))
    } else {
        (quarantine_dir.join(&name), res_mods.join(&name))
    };
    if !source.exists() {
        return Err(anyhow!(
            "{name}: not found in {} — it may already be {}",
            if quarantining {
                "res_mods"
            } else {
                "the quarantine dir"
            },
            if quarantining {
                "quarantined"
            } else {
                "restored"
            }
        ));
    }
    // Nested subjects (the dangling-reference fix quarantines single
    // files like gui/battle_elements.xml) need their target parent created.
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    // The atomic single rename — the same move class safe mode uses.
    fs::rename(&source, &target)
        .map_err(|e| anyhow!("move {} to {}: {e}", source.display(), target.display()))?;

    let mut entries = load_quarantine_manifest(&quarantine_dir)?;
    if quarantining {
        entries.insert(
            0,
            QuarantineEntry {
                name,
                crash_id: crash_id.map(str::to_string),
                quarantined_at: chrono::Utc::now().to_rfc3339(),
            },
        );
    } else {
        entries.retain(|entry| !entry.name.eq_ignore_ascii_case(&name));
    }
    save_quarantine_manifest(&quarantine_dir, &entries)?;
    Ok(entries)
}

// ── the safeguard switch ─────────────────────────────────────────────────────

/// The safeguard setting file (flat TOML, see settings_store).
const SAFEGUARD_FILE: &str = "crash-safeguard.toml";
const LEGACY_SAFEGUARD_FILE: &str = "crash-safeguard.json";

/// The live flag the watchdog consults every tick. Initialized from the
/// persisted setting at startup; the settings command flips it without
/// any thread lifecycle (the tick simply goes quiet while off).
static SAFEGUARD_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// The persisted shape — one field, default ON (the product promise: the
/// safety net is armed unless the user explicitly opts out).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
struct SafeguardConfig {
    #[serde(default = "default_safeguard_enabled")]
    enabled: bool,
}

fn default_safeguard_enabled() -> bool {
    true
}

fn canonical_safeguard_toml(config: &SafeguardConfig) -> anyhow::Result<String> {
    Ok(toml::to_string_pretty(config)?)
}

/// Load the setting (tolerant heal-on-read) and answer its enabled flag.
fn load_safeguard_in(dir: &Path) -> bool {
    let loaded = crate::settings_store::load_raw(dir, SAFEGUARD_FILE, LEGACY_SAFEGUARD_FILE);
    let Some(raw) = loaded.raw else {
        return true;
    };
    let parsed = match loaded.source {
        crate::settings_store::SettingsSource::Toml => toml::from_str::<SafeguardConfig>(&raw).ok(),
        _ => serde_json::from_str::<SafeguardConfig>(&raw).ok(),
    };
    // unwrap_or_default would land on std Default (false) — the product
    // promise is that a damaged setting heals to the ARMED state.
    let config = parsed.unwrap_or(SafeguardConfig {
        enabled: default_safeguard_enabled(),
    });
    if let Ok(canonical) = canonical_safeguard_toml(&config) {
        crate::settings_store::heal(
            dir,
            SAFEGUARD_FILE,
            LEGACY_SAFEGUARD_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    config.enabled
}

/// Persist the setting (canonical TOML, legacy twin retired).
fn store_safeguard_in(dir: &Path, enabled: bool) -> anyhow::Result<()> {
    let canonical = canonical_safeguard_toml(&SafeguardConfig { enabled })?;
    crate::settings_store::store(dir, SAFEGUARD_FILE, &canonical)?;
    crate::settings_store::retire_legacy_json(dir, LEGACY_SAFEGUARD_FILE);
    Ok(())
}

/// The live switch state (tick gate + commands).
pub(crate) fn safeguard_enabled() -> bool {
    SAFEGUARD_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Publish the switch: persist, flip the atomic, and on the enabling edge
/// run one recent-crash backfill so the net catches up immediately.
fn set_safeguard(app: &tauri::AppHandle, enabled: bool) -> anyhow::Result<()> {
    let dir = super::appdata::appdata_dir_path()?;
    store_safeguard_in(&dir, enabled)?;
    let was = SAFEGUARD_ENABLED.swap(enabled, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(enabled, "crash safeguard switched");
    if enabled && !was {
        if let Err(e) = backfill_recent(app) {
            tracing::warn!(error = %e, "safeguard-enable backfill failed");
        }
    }
    Ok(())
}

// ── the watchdog (Windows) ───────────────────────────────────────────────────

/// What the watchdog remembers per tracked client pid.
#[cfg(windows)]
#[derive(Debug, Clone)]
struct SeenProcess {
    /// Lowercase process-image name from the snapshot.
    image: String,
    /// Full exe path, when queryable (resolution happens inside
    /// game_context::running_processes).
    exe_path: Option<String>,
    /// Validated install root, when the exe path resolved to one.
    root: Option<String>,
    /// Process start time (unix secs) — the pid-reuse guard: the same pid
    /// seen again with a DIFFERENT start time is a new client, not the old
    /// one coming back.
    start_unix: Option<i64>,
    /// Last poll this pid was alive (unix secs).
    last_seen_unix: i64,
    /// Consecutive polls the pid has been missing.
    absent_polls: u32,
}

#[cfg(windows)]
static SEEN: std::sync::LazyLock<Mutex<HashMap<u32, SeenProcess>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(windows)]
static WATCHDOG_SPAWNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

/// Start the crash watchdog thread (session-poller style: one named thread
/// for the app's lifetime). Idempotent — a second call is a no-op.
#[cfg(windows)]
pub(crate) fn spawn_crash_watchdog(app: tauri::AppHandle) -> anyhow::Result<()> {
    if WATCHDOG_SPAWNED.set(()).is_err() {
        return Ok(());
    }
    // Arm (or disarm) from the persisted setting before the first tick.
    let enabled = match super::appdata::appdata_dir_path() {
        Ok(dir) => load_safeguard_in(&dir),
        Err(_) => true,
    };
    SAFEGUARD_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    let backfill_app = app.clone();
    std::thread::Builder::new()
        .name("wowsp-game-crash".into())
        .spawn(move || {
            loop {
                watchdog_tick(&app);
                std::thread::sleep(POLL_INTERVAL);
            }
        })?;
    // The safety net's catch-up pass: crashes that landed while the app was
    // closed (or before this feature existed) are harvested once per boot.
    if enabled {
        if let Err(e) = std::thread::Builder::new()
            .name("wowsp-game-crash-backfill".into())
            .spawn(move || {
                if let Err(e) = backfill_recent(&backfill_app) {
                    tracing::warn!(error = %e, "startup crash backfill failed");
                }
            })
        {
            // Detection itself is running — this failure only delays the
            // catch-up to the next manual scan / toggle cycle.
            tracing::warn!(error = %e, "startup crash backfill thread did not spawn");
        }
    }
    tracing::info!(enabled, "game-crash watchdog started");
    Ok(())
}

/// Non-Windows targets have no client to watch (and no WER evidence to
/// read) — the setup call resolves to a no-op.
#[cfg(not(windows))]
pub(crate) fn spawn_crash_watchdog(_app: tauri::AppHandle) -> anyhow::Result<()> {
    Ok(())
}

/// Non-Windows targets have nothing to harvest — the safeguard toggle and
/// the scan command resolve to no-ops (the mobile shell keeps compiling).
#[cfg(not(windows))]
fn backfill_recent(_app: &tauri::AppHandle) -> anyhow::Result<Vec<GameCrashRecord>> {
    Ok(Vec::new())
}

/// One poll: reconcile the seen-map against the live process list, and for
/// every confirmed disappearance classify the exit.
#[cfg(windows)]
fn watchdog_tick(app: &tauri::AppHandle) {
    if !safeguard_enabled() {
        return;
    }
    let procs = super::game_context::running_processes();
    let now = unix_now();
    let mut gone: Vec<(u32, SeenProcess)> = Vec::new();
    {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        for proc in &procs {
            let start = super::appdata::query_process_start_unix(proc.pid);
            let replaced = seen.get(&proc.pid).is_some_and(|old| {
                match (old.start_unix, start) {
                    (Some(a), Some(b)) => a != b,
                    // A start time we never learned cannot prove reuse.
                    _ => false,
                }
            });
            if replaced {
                if let Some(old) = seen.remove(&proc.pid) {
                    tracing::info!(pid = proc.pid, "game pid was reused by a new client");
                    gone.push((proc.pid, old));
                }
            }
            match seen.get_mut(&proc.pid) {
                Some(entry) => {
                    entry.last_seen_unix = now;
                    entry.absent_polls = 0;
                    if entry.exe_path.is_none() {
                        entry.exe_path = proc.exe_path.clone();
                    }
                    if entry.root.is_none() {
                        entry.root = proc.validated_root.clone();
                    }
                },
                None => {
                    seen.insert(
                        proc.pid,
                        SeenProcess {
                            image: proc
                                .exe_path
                                .as_deref()
                                .and_then(|p| {
                                    Path::new(p)
                                        .file_name()
                                        .map(|n| n.to_string_lossy().into_owned())
                                })
                                .map(|n| n.to_ascii_lowercase())
                                .unwrap_or_default(),
                            exe_path: proc.exe_path.clone(),
                            root: proc.validated_root.clone(),
                            start_unix: start,
                            last_seen_unix: now,
                            absent_polls: 0,
                        },
                    );
                },
            }
        }
        let live: std::collections::HashSet<u32> = procs.iter().map(|p| p.pid).collect();
        let confirmed: Vec<u32> = seen
            .iter()
            .filter(|(pid, entry)| {
                !live.contains(pid) && entry.absent_polls + 1 >= ABSENCE_CONFIRMATIONS
            })
            .map(|(pid, _)| *pid)
            .collect();
        for pid in confirmed {
            if let Some(entry) = seen.remove(&pid) {
                gone.push((pid, entry));
            }
        }
        // Bump the absence counters for the rest (second pass over missing
        // pids keeps the accounting monotonic even when a poll errors).
        for (pid, entry) in seen.iter_mut() {
            if !live.contains(pid) {
                entry.absent_polls += 1;
            }
        }
    }
    for (pid, entry) in gone {
        classify_exit(app, pid, entry, now);
    }
}

/// A tracked client vanished: hunt for crash evidence inside the window
/// around its last-seen moment. Evidence → record + broadcast; silence → a
/// clean exit worth one info line.
#[cfg(windows)]
fn classify_exit(app: &tauri::AppHandle, pid: u32, seen: SeenProcess, now_unix: i64) {
    let window = (
        seen.last_seen_unix - EVIDENCE_SLACK_SECS,
        now_unix + EVIDENCE_SLACK_SECS,
    );
    let Some(evidence) = collect_crash_evidence(&seen.image, seen.exe_path.as_deref(), pid, window)
    else {
        tracing::info!(pid, image = %seen.image, "game client exited cleanly (no crash evidence)");
        return;
    };
    let record = build_crash_record(pid, &seen, &evidence);
    let dir = match super::appdata::appdata_dir_path() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "app-data dir unavailable; crash detected but not persisted");
            return;
        },
    };
    if let Err(e) = append_record_in(&dir, &record) {
        tracing::warn!(error = %e, "persist crash record failed");
    }
    if let Some(evidence_id) = &record.evidence_id {
        let _guard = SEEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut seen = load_seen_in(&dir);
        if !seen.iter().any(|s| s == evidence_id) {
            seen.insert(0, evidence_id.clone());
            save_seen_in(&dir, &seen);
        }
    }
    use tauri::Emitter;
    if let Err(e) = app.emit(GAME_CRASH_EVENT, &record) {
        tracing::warn!(error = %e, "emit game-crash event failed");
    }
    tracing::warn!(
        pid,
        image = %record.image_name,
        code = ?record.exception_code,
        module = ?record.faulting_module,
        source = %record.source,
        "game client crash detected"
    );
}

/// Assemble the persisted record from the seen-process + evidence pair.
#[cfg(windows)]
fn build_crash_record(pid: u32, seen: &SeenProcess, evidence: &CrashEvidence) -> GameCrashRecord {
    let root = seen.root.clone().or_else(|| {
        seen.exe_path
            .as_deref()
            .and_then(super::game_context::exe_game_root)
    });
    let install = root.as_deref().and_then(|r| {
        super::game_context::cached_scan()
            .into_iter()
            .find(|install| super::game_context::same_folder(&install.path, r))
    });
    let build = root
        .as_deref()
        .and_then(super::mod_hub::latest_bin_version)
        .map(|(build, _)| build);
    let mods_active = root.as_deref().is_some_and(res_mods_has_entries);
    GameCrashRecord {
        id: format!("gc-{}-{pid}", chrono::Utc::now().format("%Y%m%d%H%M%S%3f")),
        detected_at: chrono::Utc::now().to_rfc3339(),
        pid,
        image_name: seen.image.clone(),
        game_root: root,
        install_kind: install.map(|install| install.kind),
        game_build: build,
        source: evidence.source.to_string(),
        exception_code: evidence.exception_code.clone(),
        faulting_module: evidence.faulting_module.clone(),
        wer_report_path: evidence.report_path.clone(),
        crash_dump_path: evidence.dump_path.clone(),
        summary: (!evidence.summary.is_empty()).then_some(evidence.summary.clone()),
        mods_active,
        status: STATUS_NEW.to_string(),
        evidence_id: evidence.record_id.map(|id| format!("evt:{id}")),
    }
}

/// Does the install's current res_mods carry any entries? (The classic
/// "did mods play a role?" hint, snapshotted at crash time.)
fn res_mods_has_entries(root: &str) -> bool {
    super::mod_hub::latest_bin_version(root)
        .map(|(_, ver_dir)| ver_dir.join("res_mods"))
        .and_then(|dir| fs::read_dir(dir).ok())
        .map(|entries| entries.flatten().count() > 0)
        .unwrap_or(false)
}

// ── crash-evidence collection (Windows) ──────────────────────────────────────

/// Hunt crash evidence in priority order: the event log (structured codes
/// and module names), then WER report folders, then LocalDumps. The first
/// hit wins; an event-log hit additionally adopts its StorePath report
/// folder.
#[cfg(windows)]
fn collect_crash_evidence(
    image: &str,
    exe_path: Option<&str>,
    pid: u32,
    window: (i64, i64),
) -> Option<CrashEvidence> {
    if let Some(mut evidence) = event_log_evidence(image, exe_path, window) {
        // The 1001 event's StorePath names the WER report folder — adopt
        // its Report.wer for the richer module/code fields when the event
        // itself lacks them.
        if let Some(dir) = evidence.report_path.clone() {
            if let Some(report) = wer_report_values(Path::new(&dir)) {
                if evidence.exception_code.is_none() && report.exception_code.is_some() {
                    evidence.exception_code = report.exception_code;
                }
                if evidence.faulting_module.is_none() && report.faulting_module.is_some() {
                    evidence.faulting_module = report.faulting_module;
                }
            }
        }
        return Some(evidence);
    }
    if let Some(evidence) = wer_dir_evidence(image, window) {
        return Some(evidence);
    }
    local_dump_evidence(image, pid, window)
}

/// Query recent Application-log crash events (wevtutil, XML) and return the
/// best match for this client + window.
#[cfg(windows)]
fn event_log_evidence(
    image: &str,
    exe_path: Option<&str>,
    window: (i64, i64),
) -> Option<CrashEvidence> {
    let events = recent_crash_events()?;
    let mut best: Option<&ParsedEvent> = None;
    for event in &events {
        if !event_matches_client(event, image, exe_path, window) {
            continue;
        }
        // Event ID 1000 (Application Error) carries the structured
        // ExceptionCode / ModuleName pair — prefer it over a 1001; among
        // equals the newest wins (wevtutil already returned newest-first).
        best = match best {
            Some(current) if current.event_id == Some(1000) => Some(current),
            Some(_) if event.event_id == Some(1000) => Some(event),
            Some(current) => Some(current),
            None => Some(event),
        };
    }
    // The fallback chain continues to WER/dumps when the best match is a
    // 1001 that names a report folder we can still mine — but any match
    // already confirms the crash.
    let event = best?;
    Some(evidence_from_event(event))
}

/// Run wevtutil for the last 15 minutes of Event 1000/1001 entries. The
/// query only runs at a confirmed disappearance, never per tick.
#[cfg(windows)]
fn recent_crash_events() -> Option<Vec<ParsedEvent>> {
    // The live-classification lookback: generous around the disappearance
    // moment, nothing like the backfill horizon.
    crash_events_since(15 * 60 * 1000, 60)
}

/// The parameterized query behind the live pass and the backfill harvest.
#[cfg(windows)]
fn crash_events_since(lookback_ms: i64, cap: usize) -> Option<Vec<ParsedEvent>> {
    let output = std::process::Command::new("wevtutil")
        .args([
            "qe",
            "Application",
            &format!(
                "/q:*[System[(EventID=1000 or EventID=1001) and TimeCreated[timediff(@SystemTime) <= {lookback_ms}]]]"
            ),
            &format!("/c:{cap}"),
            "/rd:true",
            "/f:xml",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        tracing::debug!(
            status = ?output.status,
            "wevtutil query failed — event-log evidence unavailable"
        );
        return None;
    }
    Some(parse_wevtutil_xml(&decode_command_output(&output.stdout)))
}

/// Decode external-tool output: BOM-tagged UTF-16 when present, else a
/// NUL-density heuristic (several Windows tools write UTF-16 to pipes
/// without a BOM), else UTF-8 lossy.
#[cfg(windows)]
fn decode_command_output(bytes: &[u8]) -> String {
    fn utf16(bytes: &[u8], big_endian: bool) -> String {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| {
                if big_endian {
                    u16::from_be_bytes([pair[0], pair[1]])
                } else {
                    u16::from_le_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return utf16(&bytes[2..], false);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return utf16(&bytes[2..], true);
    }
    let as_utf8 = String::from_utf8_lossy(bytes);
    let nul_count = as_utf8.matches('\u{0}').count();
    if nul_count > bytes.len() / 8 {
        return utf16(bytes, false);
    }
    as_utf8.into_owned()
}

/// Scan WER report folders (per-user AND machine-wide ReportArchive /
/// ReportQueue) for this client inside the window; parse the newest
/// Report.wer into evidence.
#[cfg(windows)]
fn wer_dir_evidence(image: &str, window: (i64, i64)) -> Option<CrashEvidence> {
    let dir = scan_wer_report_dirs(image, window)?.into_iter().next()?;
    let values = wer_report_values(&dir)?;
    Some(CrashEvidence {
        source: SOURCE_WER_REPORT,
        record_id: None,
        exception_code: values.exception_code,
        faulting_module: values.faulting_module,
        report_path: Some(dir.to_string_lossy().into_owned()),
        dump_path: None,
        summary: format!("WER report folder {}", dir.display()),
    })
}

/// Does a WER folder/file name mention the stem as a whole token? A bare
/// substring contains would let the 32-bit stem "worldofwarships" claim
/// every 64-bit report ("AppCrash_WorldOfWarships64.exe_..." contains it),
/// splitting one crash into phantom candidates.
#[cfg(windows)]
fn wer_name_mentions(lower_name: &str, stem: &str) -> bool {
    if stem.is_empty() {
        return true;
    }
    [".", "_", "-"]
        .iter()
        .any(|sep| lower_name.contains(&format!("{stem}{sep}")))
}

/// Every WER report folder (AppCrash-style names mentioning this client's
/// image) whose mtime falls inside the window, newest first.
#[cfg(windows)]
fn scan_wer_report_dirs(image: &str, window: (i64, i64)) -> Option<Vec<PathBuf>> {
    let stem = image_stem(image);
    let mut roots = Vec::new();
    for base in [
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("PROGRAMDATA").map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    {
        let wer = base.join("Microsoft").join("Windows").join("WER");
        roots.push(wer.join("ReportArchive"));
        roots.push(wer.join("ReportQueue"));
    }
    let mut hits: Vec<(i64, PathBuf)> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if !lower.contains("appcrash") {
                continue;
            }
            if !stem.is_empty() && !wer_name_mentions(&lower, &stem) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let Some(modified) = meta.modified().ok() else {
                continue;
            };
            let mtime = unix_secs(modified);
            if mtime >= window.0 && mtime <= window.1 {
                hits.push((mtime, entry.path()));
            }
        }
    }
    hits.sort_by_key(|(mtime, _)| *mtime);
    if hits.is_empty() {
        None
    } else {
        Some(hits.into_iter().rev().map(|(_, path)| path).collect())
    }
}

/// The two fields the UI cares about, parsed out of one Report.wer.
#[cfg(windows)]
struct WerValues {
    exception_code: Option<String>,
    faulting_module: Option<String>,
}

/// Read + parse the Report.wer inside a WER report folder.
#[cfg(windows)]
fn wer_report_values(dir: &Path) -> Option<WerValues> {
    let bytes = fs::read(dir.join("Report.wer")).ok()?;
    let kv = parse_wer_kv(&decode_wer_bytes(&bytes));
    Some(WerValues {
        exception_code: wer_field(&kv, "exception code").and_then(|v| normalize_exception_code(&v)),
        faulting_module: wer_field(&kv, "fault module name"),
    })
}

/// LocalDumps (%LOCALAPPDATA%/CrashDumps): name.pid.dmp files for this
/// client inside the window. An exact pid match beats a newer mismatch.
#[cfg(windows)]
fn local_dump_evidence(image: &str, pid: u32, window: (i64, i64)) -> Option<CrashEvidence> {
    let stem = image_stem(image);
    if stem.is_empty() {
        return None;
    }
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("CrashDumps");
    let mut hits: Vec<(bool, i64, PathBuf)> = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".dmp") || !lower.starts_with(&format!("{stem}.")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let mtime = unix_secs(modified);
        if mtime < window.0 || mtime > window.1 {
            continue;
        }
        let exact = lower == format!("{stem}.{pid}.dmp");
        hits.push((exact, mtime, entry.path()));
    }
    if hits.is_empty() {
        return None;
    }
    hits.sort_by_key(|(exact, mtime, _)| (*exact, *mtime));
    let (_, mtime, path) = hits.into_iter().next_back()?;
    Some(CrashEvidence {
        source: SOURCE_CRASH_DUMP,
        record_id: None,
        exception_code: None,
        faulting_module: None,
        report_path: None,
        dump_path: Some(path.to_string_lossy().into_owned()),
        summary: format!(
            "LocalDumps dump {} ({})",
            path.display(),
            chrono::DateTime::<chrono::Utc>::from(
                UNIX_EPOCH + Duration::from_secs(mtime.max(0) as u64)
            )
            .to_rfc3339()
        ),
    })
}

// ── recent-crash backfill (the safety net catch-up) ─────────────────────────

/// How far back the backfill harvests: two weeks of event log, WER
/// folders and dumps — long enough to cover a bad modding weekend, short
/// enough to stay cheap and relevant.
#[cfg(windows)]
const BACKFILL_LOOKBACK_SECS: i64 = 14 * 24 * 3600;
/// Same-crash clustering: an event-log entry, its WER folder and its dump
/// land within minutes of each other — one imported record per cluster.
#[cfg(windows)]
const BACKFILL_CLUSTER_SECS: i64 = 300;

/// One historical crash candidate harvested from OS evidence.
#[cfg(windows)]
#[derive(Debug, Clone)]
struct BackfillCandidate {
    /// Stable identity: evt:<record-id|slug> / wer:<dir-name> /
    /// dmp:<file-name> — the import dedupe keys on it.
    evidence_id: String,
    at_unix: i64,
    image: String,
    priority: u8,
    exception_code: Option<String>,
    faulting_module: Option<String>,
    report_path: Option<String>,
    dump_path: Option<String>,
    summary: String,
}

/// The distinct client image names (both families, 32/64) the harvest
/// matches against — straight off the client registry.
#[cfg(windows)]
fn all_game_images() -> Vec<String> {
    super::game_client::CLIENTS
        .iter()
        .flat_map(|client| client.process_names().iter().copied())
        .map(str::to_string)
        .collect()
}

/// The pure merge: sort newest-first with the event-log source outranking
/// WER outranking dumps, then keep ONE candidate per (image ± cluster
/// window) — the same crash never imports twice from three sources.
#[cfg(windows)]
fn merge_backfill_candidates(mut candidates: Vec<BackfillCandidate>) -> Vec<BackfillCandidate> {
    // Priority FIRST: the event-log entry claims its cluster before the
    // WER folder and the dump of the same crash are even considered — a
    // dump written two minutes later must not evict the richer record.
    // Time orders everything within a priority band.
    candidates.sort_by(|a, b| a.priority.cmp(&b.priority).then(b.at_unix.cmp(&a.at_unix)));
    let mut kept: Vec<BackfillCandidate> = Vec::new();
    for candidate in candidates {
        let clustered = kept.iter().any(|k| {
            k.image == candidate.image
                && (k.at_unix - candidate.at_unix).abs() <= BACKFILL_CLUSTER_SECS
        });
        if !clustered {
            kept.push(candidate);
        }
    }
    // Chronological (oldest first): the import loop prepends each record,
    // so a chronological batch lands newest-first in the history.
    kept.sort_by_key(|c| c.at_unix);
    kept
}

/// Which known client image one harvested event belongs to. EXACT name
/// match first — the registry lists the 32-bit name before the 64-bit one
/// and the fuzzy stem-contains pass would otherwise attribute every 64-bit
/// crash to the 32-bit image (the substring "worldofwarships" matches
/// "WorldOfWarships64.exe" too). The fuzzy pass only rescues events whose
/// app name no image states verbatim.
#[cfg(windows)]
fn attributed_image(event: &ParsedEvent, images: &[String], window: (i64, i64)) -> Option<String> {
    let app = event
        .data
        .iter()
        .find(|(key, _)| key == "appname")
        .or_else(|| event.data.iter().find(|(key, _)| key == "p1"))
        .map(|(_, value)| value.to_ascii_lowercase());
    let app = app?;
    if let Some(image) = images.iter().find(|image| app == **image) {
        return Some(image.clone());
    }
    images
        .iter()
        .find(|image| event_matches_client(event, image, None, window))
        .cloned()
}

/// Which known client image a WG crash-report FILENAME belongs to: the
/// name spells <image-stem>-YYYY-MM-DD_HH-MM-SS.crash — the stem must
/// match as a delimited prefix (same token rule as the WER scan, so the
/// 32-bit stem never claims a 64-bit report).
#[cfg(windows)]
fn crash_report_image(file_name: &str, stems: &[String]) -> Option<String> {
    let lower = file_name.to_ascii_lowercase();
    stems.iter().find_map(|stem| {
        lower
            .strip_prefix(&format!("{}-", stem))
            .map(|_| format!("{}.exe", stem))
    })
}

/// The candidate summary for a WG crash report: the report carries the
/// actual cause in its Message block ("Unhandled exception", an assert,
/// ...) — fall back to the application line when the block is absent.
/// Bounded read, one line, no secrets.
#[cfg(windows)]
fn crash_report_summary(path: &Path) -> String {
    let Ok((bytes, _, _)) = read_tail(path, 2048) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    let Some(first) = lines.next() else {
        return String::new();
    };
    let mut after_message = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "Message:" || trimmed.starts_with("Message:") {
            let inline = trimmed.trim_start_matches("Message:").trim();
            if !inline.is_empty() {
                return inline.to_string();
            }
            after_message = true;
            continue;
        }
        if after_message && !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    first.trim().to_string()
}

/// Harvest every historical crash candidate inside the lookback window.
#[cfg(windows)]
fn harvest_backfill_candidates() -> Vec<BackfillCandidate> {
    let now = unix_now();
    let window = (now - BACKFILL_LOOKBACK_SECS, now + 60);
    let images = all_game_images();
    let mut candidates: Vec<BackfillCandidate> = Vec::new();

    // Event log — the richest source (codes + modules + report folders).
    if let Some(events) = crash_events_since(BACKFILL_LOOKBACK_SECS * 1000, 400) {
        for event in &events {
            let at = match event.time_unix {
                Some(t) => t,
                None => continue,
            };
            let image = attributed_image(event, &images, window);
            let Some(image) = image else {
                continue;
            };
            let evidence = evidence_from_event(event);
            let slug = event.record_id.map(|id| id.to_string()).unwrap_or_else(|| {
                format!(
                    "{at}-{}",
                    evidence.exception_code.clone().unwrap_or_default()
                )
            });
            candidates.push(BackfillCandidate {
                evidence_id: format!("evt:{slug}"),
                at_unix: at,
                image,
                priority: 0,
                exception_code: evidence.exception_code,
                faulting_module: evidence.faulting_module,
                report_path: evidence.report_path,
                dump_path: None,
                summary: evidence.summary,
            });
        }
    }

    // WER report folders — one candidate per AppCrash dir, newest facts
    // from its Report.wer when present.
    let stems: Vec<String> = images.iter().map(|i| image_stem(i)).collect();
    for stem in &stems {
        let Some(dirs) = scan_wer_report_dirs(stem, window) else {
            continue;
        };
        for dir in dirs {
            let Ok(meta) = fs::metadata(&dir) else {
                continue;
            };
            let Some(at) = meta.modified().ok().map(unix_secs) else {
                continue;
            };
            let (code, module) = match wer_report_values(&dir) {
                Some(values) => (values.exception_code, values.faulting_module),
                None => (None, None),
            };
            let name = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            candidates.push(BackfillCandidate {
                evidence_id: format!("wer:{name}"),
                at_unix: at,
                image: format!("{stem}.exe"),
                priority: 1,
                exception_code: code,
                faulting_module: module,
                report_path: Some(dir.to_string_lossy().into_owned()),
                dump_path: None,
                summary: format!("WER report folder {}", dir.display()),
            });
        }
    }

    // LocalDumps — bare dump files (no pid context worth trusting at this
    // distance, so every in-window dump of a game stem counts).
    if let Some(dumps) = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|la| la.join("CrashDumps"))
    {
        if let Ok(entries) = fs::read_dir(&dumps) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let lower = name.to_ascii_lowercase();
                if !lower.ends_with(".dmp") {
                    continue;
                }
                let Some(stem) = stems
                    .iter()
                    .find(|s| lower.starts_with(&format!("{}.", s.to_ascii_lowercase())))
                else {
                    continue;
                };
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let Some(at) = meta.modified().ok().map(unix_secs) else {
                    continue;
                };
                if at < window.0 || at > window.1 {
                    continue;
                }
                candidates.push(BackfillCandidate {
                    evidence_id: format!("dmp:{name}"),
                    at_unix: at,
                    image: format!("{stem}.exe"),
                    priority: 2,
                    exception_code: None,
                    faulting_module: None,
                    report_path: None,
                    dump_path: Some(entry.path().to_string_lossy().into_owned()),
                    summary: format!("LocalDumps dump {}", name),
                });
            }
        }
    }
    // WG crash-handler reports: <game>/crashes/<image>-<stamp>.crash. On
    // installs whose WER handoff is suppressed this folder is the ONLY
    // durable evidence — the observed machine had zero event-log and WER
    // entries for a crash that left two reports here.
    let stems: Vec<String> = images.iter().map(|i| image_stem(i)).collect();
    let mut roots: Vec<String> = super::game_context::cached_scan()
        .iter()
        .map(|install| install.path.clone())
        .collect();
    if let Some(active) = super::game_context::persisted_active_path() {
        if !roots.iter().any(|r| r.eq_ignore_ascii_case(&active)) {
            roots.push(active);
        }
    }
    for root in &roots {
        let dir = Path::new(root).join("crashes");
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if !lower.ends_with(".crash") {
                continue;
            }
            let Some(image) = crash_report_image(&name, &stems) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            let Some(at) = meta.modified().ok().map(unix_secs) else {
                continue;
            };
            if at < window.0 || at > window.1 {
                continue;
            }
            candidates.push(BackfillCandidate {
                evidence_id: format!("wgc:{name}"),
                at_unix: at,
                image,
                priority: 1,
                exception_code: None,
                faulting_module: None,
                report_path: Some(entry.path().to_string_lossy().into_owned()),
                dump_path: None,
                summary: crash_report_summary(&entry.path()),
            });
        }
    }
    candidates
}

/// The game root a WG crash report lives under: the file sits in
/// <root>/crashes/, so the root is the segment above that folder — a
/// deterministic attribution that never depends on the install scan
/// having warmed up.
#[cfg(windows)]
fn game_root_of_report(report_path: &str) -> Option<String> {
    let path = Path::new(report_path);
    let mut ancestors = path.ancestors();
    let _file = ancestors.next()?;
    let crashes_dir = ancestors.next()?;
    if crashes_dir.file_name()?.to_string_lossy() != "crashes" {
        return None;
    }
    crashes_dir
        .parent()
        .map(|root| root.to_string_lossy().into_owned())
        .filter(|root| !root.is_empty())
}

/// The catch-up pass: harvest, merge, drop everything the history already
/// knows (by evidence id or by a same-image record inside the cluster
/// window — live detections carry no evidence id), and import the rest.
/// Every imported record is persisted and broadcast. Returns the imports.
#[cfg(windows)]
fn backfill_recent(app: &tauri::AppHandle) -> anyhow::Result<Vec<GameCrashRecord>> {
    let _guard = BACKFILL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let candidates = merge_backfill_candidates(harvest_backfill_candidates());
    let dir = super::appdata::appdata_dir_path()?;
    let history = load_history_in(&dir)?.unwrap_or_default();
    let mut seen = {
        let _guard = SEEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_seen_in(&dir)
    };

    // Single-install machines (the overwhelming majority) can attribute
    // the historical crash to that install; multi-install stays unrooted
    // rather than guessing.
    let installs = super::game_context::cached_scan();
    let single = if installs.len() == 1 {
        installs.first().cloned()
    } else {
        None
    };

    use tauri::Emitter;
    let mut imported = Vec::new();
    for candidate in candidates {
        let already = seen.iter().any(|s| s == &candidate.evidence_id)
            || history.iter().any(|r| {
                r.evidence_id.as_deref() == Some(candidate.evidence_id.as_str())
                    || (r.image_name == candidate.image
                        && r.detected_at
                            .parse::<chrono::DateTime<chrono::Utc>>()
                            .ok()
                            .map(|t| t.timestamp())
                            .is_some_and(|t| {
                                (t - candidate.at_unix).abs() <= BACKFILL_CLUSTER_SECS
                            }))
            })
            || imported.iter().any(|r: &GameCrashRecord| {
                r.evidence_id.as_deref() == Some(candidate.evidence_id.as_str())
            });
        if already {
            continue;
        }
        let root = single.as_ref().map(|i| i.path.clone()).or_else(|| {
            candidate
                .report_path
                .as_deref()
                .and_then(game_root_of_report)
        });
        let mods_active = root.as_deref().is_some_and(res_mods_has_entries);
        let record = GameCrashRecord {
            id: format!("gc-bf-{}", candidate.evidence_id),
            detected_at: chrono::DateTime::<chrono::Utc>::from(
                UNIX_EPOCH + Duration::from_secs(candidate.at_unix.max(0) as u64),
            )
            .to_rfc3339(),
            pid: 0,
            image_name: candidate.image.clone(),
            game_root: root,
            install_kind: single.as_ref().map(|i| i.kind),
            game_build: single
                .as_ref()
                .and_then(|i| super::mod_hub::latest_bin_version(&i.path))
                .map(|(build, _)| build),
            source: match candidate.evidence_id.split(':').next() {
                Some("evt") => SOURCE_EVENT_LOG.to_string(),
                Some("wer") => SOURCE_WER_REPORT.to_string(),
                Some("wgc") => SOURCE_GAME_REPORT.to_string(),
                _ => SOURCE_CRASH_DUMP.to_string(),
            },
            exception_code: candidate.exception_code.clone(),
            faulting_module: candidate.faulting_module.clone(),
            wer_report_path: candidate.report_path.clone(),
            crash_dump_path: candidate.dump_path.clone(),
            summary: (!candidate.summary.is_empty()).then_some(candidate.summary.clone()),
            mods_active,
            status: STATUS_NEW.to_string(),
            evidence_id: Some(candidate.evidence_id.clone()),
        };
        append_record_in(&dir, &record)?;
        seen.insert(0, candidate.evidence_id.clone());
        let _ = app.emit(GAME_CRASH_EVENT, &record);
        imported.push(record);
    }
    if !imported.is_empty() {
        let _guard = SEEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Merge, never overwrite: a live detection may have appended its
        // own id while the harvest ran.
        let mut merged = load_seen_in(&dir);
        for id in &seen {
            if !merged.iter().any(|m| m == id) {
                merged.insert(0, id.clone());
            }
        }
        save_seen_in(&dir, &merged);
        tracing::info!(
            count = imported.len(),
            "recent-crash backfill imported records"
        );
    }
    Ok(imported)
}

// ── evidence parsing (pure, Windows-shaped input) ────────────────────────────

/// One event extracted from wevtutil XML output.
#[cfg(windows)]
#[derive(Debug, Clone)]
struct ParsedEvent {
    event_id: Option<u32>,
    /// EventRecordID — the log's stable per-entry identity; the backfill
    /// dedupes harvested crashes on it.
    record_id: Option<u64>,
    provider: String,
    /// Unix seconds of TimeCreated, when parseable.
    time_unix: Option<i64>,
    /// EventData Name -> raw value pairs (names lowercased).
    data: Vec<(String, String)>,
}

/// Split concatenated wevtutil XML output into events and parse each block.
#[cfg(windows)]
fn parse_wevtutil_xml(text: &str) -> Vec<ParsedEvent> {
    let mut events = Vec::new();
    let mut rest = text;
    while let Some(rel) = rest.find("<Event") {
        rest = &rest[rel..];
        let Some(rel_end) = rest.find("</Event>") else {
            break;
        };
        let block = &rest[..rel_end];
        events.push(parse_event_block(block));
        rest = &rest[rel_end + "</Event>".len()..];
    }
    events
}

/// Parse one Event XML block: EventID, Provider, TimeCreated and every
/// Data element.
#[cfg(windows)]
fn parse_event_block(block: &str) -> ParsedEvent {
    // The Application Error / WER providers emit <EventID Qualifiers='...'>N</EventID>
    // — the attribute must not defeat the parse, so scan past the tag's own
    // closing bracket before reading the number.
    let event_id = block
        .find("<EventID")
        .and_then(|start| block[start..].find('>'))
        .and_then(|rel| {
            let tag_start = block.find("<EventID")?;
            let after = &block[tag_start + rel + 1..];
            between(after, "", "</EventID>").or(Some(after))
        })
        .and_then(|v| v.trim().parse::<u32>().ok());
    let record_id = between(block, "<EventRecordID>", "</EventRecordID>")
        .and_then(|v| v.trim().parse::<u64>().ok());
    let provider = between(block, "<Provider Name='", "'")
        .or_else(|| between(block, "<Provider Name=\"", "\""))
        .unwrap_or_default()
        .to_string();
    let time_unix = between(block, "SystemTime='", "'")
        .or_else(|| between(block, "SystemTime=\"", "\""))
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v.trim()).ok())
        .map(|t| t.timestamp());
    let mut data = Vec::new();
    let mut rest = block;
    while let Some(rel) = rest.find("<Data") {
        rest = &rest[rel..];
        let Some(tag_end_rel) = rest.find('>') else {
            break;
        };
        let tag = &rest[..tag_end_rel];
        let name = tag
            .split("Name=")
            .nth(1)
            .map(|rest| rest.trim_start_matches('\'').trim_start_matches('"'))
            .and_then(|rest| {
                let end = rest.find(['\'', '"'])?;
                Some(rest[..end].to_string())
            })
            .unwrap_or_default();
        rest = &rest[tag_end_rel + 1..];
        let Some(value_end) = rest.find("</Data>") else {
            break;
        };
        let value = xml_unescape(&rest[..value_end]);
        data.push((name.to_ascii_lowercase(), value));
        rest = &rest[value_end + "</Data>".len()..];
    }
    ParsedEvent {
        event_id,
        record_id,
        provider,
        time_unix,
        data,
    }
}

/// First value bounded by open..close, if both appear in order.
#[cfg(windows)]
fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// Minimal XML entity unescape for Data values (&amp; &lt; &gt; &apos;
/// &quot; — the set EventLog actually emits).
#[cfg(windows)]
fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Does one parsed event name this client inside the window? The app-name
/// match accepts the Event 1000 spelling (AppName), the Event 1001
/// spelling (P1), the AppPath / StorePath forms, and falls back to the
/// folder path when only exe_path is known.
#[cfg(windows)]
fn event_matches_client(
    event: &ParsedEvent,
    image: &str,
    exe_path: Option<&str>,
    window: (i64, i64),
) -> bool {
    if !matches!(event.event_id, Some(1000 | 1001)) {
        return false;
    }
    if let Some(time) = event.time_unix {
        if time < window.0 - 60 || time > window.1 + 60 {
            return false;
        }
    }
    let value = |name: &str| {
        event
            .data
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    let stem = image_stem(image);
    let app_name = value("appname").or_else(|| value("p1"));
    if let Some(app) = app_name {
        if !image.is_empty() && app.eq_ignore_ascii_case(image) {
            return true;
        }
        if !stem.is_empty() && app.to_ascii_lowercase().contains(&stem) {
            return true;
        }
    }
    if let (Some(app_path), Some(exe)) = (value("apppath"), exe_path) {
        // Exact image match, or the same FOLDER: on multi-install
        // machines two same-family clients share the image name, so
        // the folder is the only discriminator (a crash of install B
        // must not attach to install A's disappearance).
        if app_path.eq_ignore_ascii_case(exe) || super::game_context::same_folder(&app_path, exe) {
            return true;
        }
    }
    if let Some(store) = value("storepath") {
        if !stem.is_empty() && store.to_ascii_lowercase().contains(&stem) {
            return true;
        }
    }
    false
}

/// Evidence from one matched event: codes from Event 1000's structured
/// fields or Event 1001's P-numbered payload, plus the 1001 StorePath.
#[cfg(windows)]
fn evidence_from_event(event: &ParsedEvent) -> CrashEvidence {
    let value = |name: &str| {
        event
            .data
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    let exception_code = value("exceptioncode")
        .or_else(|| value("p8"))
        .and_then(|raw| normalize_exception_code(&raw));
    let faulting_module = value("modulename")
        .or_else(|| value("p4"))
        .map(|module| module.trim().trim_end_matches("_unloaded").to_string())
        .filter(|module| !module.is_empty());
    let report_path = value("storepath");
    let mut summary = format!(
        "Event {} ({})",
        event.event_id.map(|id| id.to_string()).unwrap_or_default(),
        event.provider
    );
    for (key, val) in &event.data {
        if matches!(
            key.as_str(),
            "appname" | "p1" | "exceptioncode" | "p8" | "modulename" | "p4" | "eventname"
        ) && !val.is_empty()
        {
            summary.push_str(&format!(" {key}={val}"));
        }
    }
    CrashEvidence {
        source: SOURCE_EVENT_LOG,
        record_id: event.record_id,
        exception_code,
        faulting_module,
        report_path,
        dump_path: None,
        summary,
    }
}

/// Decode Report.wer bytes: UTF-16LE (BOM-tagged or bare — WER always
/// writes UTF-16), with a UTF-8 lossy fallback for tools that do not.
#[cfg(windows)]
fn decode_wer_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let as_utf8 = String::from_utf8_lossy(bytes);
    if as_utf8.matches('\u{0}').count() > bytes.len() / 8 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    as_utf8.into_owned()
}

/// Report.wer is a flat Key=Value line list (Signature/Sig[N].Name +
/// Signature/Sig[N].Value pairs among them).
#[cfg(windows)]
fn parse_wer_kv(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

/// The Sig Value whose sibling Name contains the wanted field (case
/// insensitive) — "Exception code" / "Fault Module Name".
#[cfg(windows)]
fn wer_field(kv: &[(String, String)], wanted: &str) -> Option<String> {
    let wanted = wanted.to_ascii_lowercase();
    for (index, (key, name)) in kv.iter().enumerate() {
        let lower = key.to_ascii_lowercase();
        let Some(base) = lower.strip_suffix(".name") else {
            continue;
        };
        if !name.to_ascii_lowercase().contains(&wanted) {
            continue;
        }
        let value_key = format!("{base}.value");
        for (key2, value2) in kv.iter().skip(index + 1) {
            if key2.to_ascii_lowercase() == value_key {
                return Some(value2.clone());
            }
        }
    }
    None
}

// ── analysis ─────────────────────────────────────────────────────────────────

/// Per-file caps for the analysis excerpts.
const EXCERPT_FILE_CAP: u64 = 2 * 1024 * 1024;
const EXCERPT_TAIL_LINES: usize = 160;
const EXCERPT_HIGHLIGHTS_MAX: usize = 30;
/// Newest game-side files taken into one analysis.
const GAME_LOG_FILES_MAX: usize = 4;
/// Newest WoWSP diagnostics logs taken into one analysis.
const APP_LOG_FILES_MAX: usize = 2;
const APP_LOG_TAIL_LINES: usize = 120;
/// Keyword set for the highlight pass (lowercase).
const HIGHLIGHT_KEYWORDS: [&str; 7] = [
    "error",
    "exception",
    "crash",
    "assert",
    "fail",
    "traceback",
    "access violation",
];

/// Game-side log candidates: profile/ first (python.log, clientrunner.log —
/// the layout this repo attests), then a logs/ dir when a client ships one.
/// Newest first, capped.
fn game_log_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir in [root.join("profile"), root.join("logs")] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".log") || lower.ends_with(".txt") {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .map(unix_secs)
            .unwrap_or(0)
    });
    candidates.reverse();
    candidates.truncate(GAME_LOG_FILES_MAX);
    candidates
}

/// Read at most the cap bytes from the END of one file (its mtime rides
/// along), seek-based: a multi-hundred-MB python.log must never be
/// slurped whole just to hand the analysis a 2 MiB window. Returns
/// (window, total size, modified).
fn read_tail(path: &Path, cap: u64) -> anyhow::Result<(Vec<u8>, u64, Option<SystemTime>)> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut file = fs::File::open(path).map_err(|e| anyhow!("open {}: {e}", path.display()))?;
    let meta = file.metadata()?;
    let modified = meta.modified().ok();
    let len = meta.len();
    let start = len.saturating_sub(cap);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| anyhow!("seek {}: {e}", path.display()))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| anyhow!("read {}: {e}", path.display()))?;
    Ok((buf, len, modified))
}

/// Read one file's tail into a redacted excerpt.
fn excerpt_of(path: &Path, tail_lines: usize) -> anyhow::Result<LogExcerpt> {
    let (bytes, size, modified) = read_tail(path, EXCERPT_FILE_CAP)?;
    let window: &[u8] = &bytes;
    let text = String::from_utf8_lossy(window);
    let lines: Vec<&str> = text.lines().collect();
    let mut picked: Vec<&str> = lines.iter().copied().rev().take(tail_lines).collect();
    picked.reverse();
    let tail: String = picked.join("\n");
    let redactor = Redactor::from_env();
    let tail = redactor.redact(&tail);
    let highlights: Vec<String> = lines
        .iter()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            HIGHLIGHT_KEYWORDS.iter().any(|kw| lower.contains(kw))
        })
        .rev()
        .take(EXCERPT_HIGHLIGHTS_MAX)
        .map(|line| redactor.redact(line))
        .collect();
    Ok(LogExcerpt {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        size_bytes: size,
        modified: rfc3339(modified),
        tail,
        highlights,
    })
}

/// The WoWSP diagnostics-log excerpts (newest two).
fn app_log_excerpts() -> anyhow::Result<Vec<LogExcerpt>> {
    let dir = crate::logging::ensure_log_dir()?;
    Ok(crate::logging::list_log_files(&dir)
        .into_iter()
        .take(APP_LOG_FILES_MAX)
        .filter_map(|file| excerpt_of(&file.path, APP_LOG_TAIL_LINES).ok())
        .collect())
}

/// res_mods inventory of one install: the active res_mods, or the
/// quarantined safe-mode twin when the active one is gone (what WOULD load
/// once mods come back).
fn mods_inventory_entries(root: &Path) -> Vec<ModEntry> {
    let Some((_, ver_dir)) = super::mod_hub::latest_bin_version(&root.to_string_lossy()) else {
        return Vec::new();
    };
    let mut dir = ver_dir.join("res_mods");
    if !dir.is_dir() {
        let twin = super::mod_hub::disabled_res_mods(&ver_dir);
        if twin.is_dir() {
            dir = twin;
        }
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut mods: Vec<ModEntry> = entries
        .flatten()
        .map(|entry| {
            let modified = entry.metadata().ok().and_then(|meta| meta.modified().ok());
            ModEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
                modified: rfc3339(modified),
            }
        })
        .collect();
    mods.sort_by(|a, b| a.name.cmp(&b.name));
    mods
}

/// Findings for one record + its collected context.
fn build_findings(
    record: &GameCrashRecord,
    mods: &[ModEntry],
    game_logs: &[LogExcerpt],
    dangling_urls: &[String],
) -> Vec<CrashFinding> {
    let mut findings = Vec::new();
    if let Some(code) = &record.exception_code {
        findings.push(exception_finding(code));
    }
    if let Some(module) = &record.faulting_module {
        findings.push(CrashFinding {
            code: "faultingModule".to_string(),
            severity: "warning".to_string(),
            detail: Some(module.clone()),
        });
    }
    // The mechanical crash link: an asset the death window shows FAILING
    // to load while a mod file still references it — critical, named by
    // the dangling URL itself.
    for url in dangling_urls {
        findings.push(CrashFinding {
            code: "danglingUiReference".to_string(),
            severity: "critical".to_string(),
            detail: Some(url.clone()),
        });
    }
    findings.push(CrashFinding {
        code: match record.source.as_str() {
            SOURCE_EVENT_LOG => "evidenceEventLog",
            SOURCE_WER_REPORT => "evidenceWerReport",
            SOURCE_GAME_REPORT => "evidenceGameReport",
            _ => "evidenceCrashDump",
        }
        .to_string(),
        severity: "info".to_string(),
        detail: None,
    });
    let highlight_total: usize = game_logs.iter().map(|log| log.highlights.len()).sum();
    if highlight_total > 0 {
        findings.push(CrashFinding {
            code: "gameLogErrors".to_string(),
            severity: "warning".to_string(),
            detail: Some(highlight_total.to_string()),
        });
    }
    if let Some(crash_unix) = parse_rfc3339_unix(&record.detected_at) {
        let recent: Vec<String> = mods
            .iter()
            .filter(|entry| {
                entry
                    .modified
                    .as_deref()
                    .and_then(parse_rfc3339_unix)
                    .is_some_and(|t| t >= crash_unix - 24 * 3600 && t <= crash_unix + 60)
            })
            .map(|entry| entry.name.clone())
            .collect();
        if !recent.is_empty() {
            findings.push(CrashFinding {
                code: "recentModChanges".to_string(),
                severity: "warning".to_string(),
                detail: Some(recent.join(", ")),
            });
        }
    }
    if record.mods_active {
        findings.push(CrashFinding {
            code: "modsActiveAtCrash".to_string(),
            severity: "warning".to_string(),
            detail: None,
        });
    }
    let probe_seen = game_logs.iter().any(|log| log.tail.contains("WOWSP_PROBE"));
    if probe_seen {
        findings.push(CrashFinding {
            code: "probeWasActive".to_string(),
            severity: "info".to_string(),
            detail: None,
        });
    }
    if record.crash_dump_path.is_some() {
        findings.push(CrashFinding {
            code: "dumpAvailable".to_string(),
            severity: "info".to_string(),
            detail: record.crash_dump_path.clone(),
        });
    }
    findings
}

/// The exception-code dictionary: stable finding codes the webui
/// translates, with a severity each.
fn exception_finding(code: &str) -> CrashFinding {
    let normalized = normalize_exception_code(code).unwrap_or_else(|| code.to_string());
    let (code, severity) = match normalized.as_str() {
        "0xC0000005" => ("exceptionAccessViolation", "critical"),
        "0xC0000409" => ("exceptionStackBufferOverrun", "critical"),
        "0xC00000FD" => ("exceptionStackOverflow", "critical"),
        "0xC0000374" => ("exceptionHeapCorruption", "critical"),
        "0xC000001D" => ("exceptionIllegalInstruction", "critical"),
        "0xC0000094" => ("exceptionDivideByZero", "critical"),
        "0xC0000096" => ("exceptionPrivilegedInstruction", "critical"),
        "0x80000003" => ("exceptionBreakpoint", "info"),
        "0xE06D7363" => ("exceptionCppException", "critical"),
        "0xE0434352" => ("exceptionClrException", "critical"),
        "0xC0000142" => ("exceptionDllInitFailed", "critical"),
        "0xC0000135" => ("exceptionDllNotFound", "critical"),
        _ => ("exceptionUnknown", "warning"),
    };
    CrashFinding {
        code: code.to_string(),
        severity: severity.to_string(),
        detail: Some(normalized),
    }
}

/// RFC 3339 -> unix seconds (analysis-side date math).
fn parse_rfc3339_unix(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp())
}

// ── dangling-reference detection (the death-window heuristics) ──────────────

/// The loader failure signatures whose URL names an asset some mod file
/// references. The battle_stats.swf crash class: a legacy unbound-v1 mod
/// hosts its UI inside an SWF the current client no longer ships; the
/// load fails and the native layer dies. The URL is the mechanical link
/// between the crash and the mod file that asks for it.
const DANGLING_URL_MARKERS: [&str; 2] = ["Unknown file format at URL ", "[ERROR][SWF]: url:"];

/// Every dangling asset URL the death-window text names, in first-seen
/// order. Pure; both marker spellings carry the URL up to the closing
/// quote of their own kind.
fn dangling_urls_from_text(text: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for line in text.lines() {
        for marker in DANGLING_URL_MARKERS {
            let Some(rest) = line.split_once(marker) else {
                continue;
            };
            let rest = rest.1.trim_start();
            // Consume the OPENING quote (either spelling) so the close
            // search starts inside the URL, not on its own opener.
            let (body, close): (&str, &str) = if let Some(stripped) = rest.strip_prefix("\"") {
                (stripped, "\"")
            } else if let Some(stripped) = rest.strip_prefix("'") {
                (stripped, "'")
            } else {
                continue;
            };
            let Some(end) = body.find(close) else {
                continue;
            };
            let url = body[..end].trim().to_string();
            if !url.is_empty() && !urls.iter().any(|u| u == &url) {
                urls.push(url);
            }
        }
    }
    urls
}

/// Every mods tree the analysis may need to read: the active res_mods
/// (as the game leaves it) AND the safe-mode twin (the set that was loaded
/// when a crash predates the safe-mode answer), deduped.
fn res_mods_bases(root: &Path) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(base) = res_mods_base(root) {
        bases.push(base);
    }
    if let Some((_, ver_dir)) = super::mod_hub::latest_bin_version(&root.to_string_lossy()) {
        let twin = super::mod_hub::disabled_res_mods(&ver_dir);
        if twin.is_dir() && !bases.iter().any(|b| b == &twin) {
            bases.push(twin);
        }
    }
    bases
}

/// The mods tree the analysis reads (active res_mods, or the safe-mode
/// twin — the crash may already have prompted the quarantine of
/// everything, and the dangling files live in the twin).
fn res_mods_base(root: &Path) -> Option<PathBuf> {
    let (_, ver_dir) = super::mod_hub::latest_bin_version(&root.to_string_lossy())?;
    let active = ver_dir.join("res_mods");
    if active.is_dir() {
        return Some(active);
    }
    let twin = super::mod_hub::disabled_res_mods(&ver_dir);
    twin.is_dir().then_some(twin)
}

/// Bounded text-file walk caps: the reference scan stays cheap even on
/// heavy mod trees.
const REF_SCAN_MAX_FILES: usize = 4000;
const REF_SCAN_MAX_BYTES: u64 = 256 * 1024;
const REF_SCAN_EXTENSIONS: [&str; 7] = ["xml", "py", "json", "unbound", "txt", "toml", "cfg"];

/// Which mod files REFERENCE a dangling URL — the reverse lookup that
/// pins the crash to its mod. Every text file under the mods tree is
/// scanned (bounded); a hit becomes a suspect named by its res_mods-
/// relative path, so the existing quarantine action can move exactly
/// that file out of the load path.
fn dangling_ref_suspects(base: &Path, urls: &[String]) -> Vec<SuspectMod> {
    if urls.is_empty() {
        return Vec::new();
    }
    let mut suspects = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if scanned >= REF_SCAN_MAX_FILES {
                return suspects;
            }
            scanned += 1;
            let is_text = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|ext| {
                    REF_SCAN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
                });
            if !is_text {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > REF_SCAN_MAX_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            // A mod file may spell the bare file name while the loader
            // logged a full path (or vice versa) — match either spelling.
            let matched: Vec<&String> = urls
                .iter()
                .filter(|url| {
                    let basename = url.rsplit('/').next().unwrap_or(url.as_str());
                    text.contains(url.as_str()) || (!basename.is_empty() && text.contains(basename))
                })
                .collect();
            let hit = !matched.is_empty();
            if !hit {
                continue;
            }
            let rel = path
                .strip_prefix(base)
                .map(|p| {
                    p.to_string_lossy()
                        .replace("\\".chars().next().unwrap(), "/")
                })
                .unwrap_or_default();
            if rel.is_empty() {
                continue;
            }
            suspects.push(SuspectMod {
                name: rel,
                evidence: EVIDENCE_DANGLING_REF.to_string(),
                log_lines: matched.iter().map(|u| (*u).clone()).collect(),
            });
        }
    }
    suspects.sort_by(|a, b| a.name.cmp(&b.name));
    suspects
}

/// Evidence tags for the suspect ranking.
const EVIDENCE_LOG_MENTION: &str = "logMention";
const EVIDENCE_RECENT_CHANGE: &str = "recentChange";
/// A mod file on disk REFERENCES an asset the crash's death window shows
/// failing to load — the battle_stats.swf class of crash: the strongest
/// localization signal there is (mechanical, not correlational).
pub const EVIDENCE_DANGLING_REF: &str = "danglingRef";
/// A mod file references a client asset that exists in neither the mods
/// tree nor the client index — static evidence, no crash required.
pub const EVIDENCE_MISSING_ASSET: &str = "missingAsset";

/// Pull the crash-culprit candidates out of the game log texts + the mods
/// inventory: an error-shaped line naming a path under res_mods/ pins the
/// entry it points at (the game logs mod failures with that path), and a
/// recently-changed entry pins on recency alone. logMention outranks
/// recentChange; equal ranks keep the inventory order.
fn detect_suspect_mods(
    raw_texts: &[(&str, &str)],
    mods: &[ModEntry],
    crash_unix: Option<i64>,
) -> Vec<SuspectMod> {
    let mut suspects: Vec<SuspectMod> = Vec::new();
    let mut push_or_merge = |name: String, evidence: &str, line: Option<String>| {
        if let Some(existing) = suspects
            .iter_mut()
            .find(|s| s.name.eq_ignore_ascii_case(&name))
        {
            if evidence == EVIDENCE_LOG_MENTION {
                existing.evidence = EVIDENCE_LOG_MENTION.to_string();
                if let Some(line) = line {
                    existing.log_lines.push(line);
                }
            }
            return;
        }
        suspects.push(SuspectMod {
            name,
            evidence: evidence.to_string(),
            log_lines: line.into_iter().collect(),
        });
    };
    for (log_name, text) in raw_texts {
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            if !lower.contains("res_mods") {
                continue;
            }
            if !HIGHLIGHT_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
                continue;
            }
            if let Some((first, second)) = res_mods_path_candidates(line) {
                // Whichever segment the inventory claims wins (the current
                // layout carries no version segment, older lines do); with
                // no claim either way the first segment is the best guess.
                let name = if mods.iter().any(|m| m.name.eq_ignore_ascii_case(&first)) {
                    first
                } else if let Some(second) =
                    second.filter(|s| mods.iter().any(|m| m.name.eq_ignore_ascii_case(s)))
                {
                    second
                } else {
                    first
                };
                let redacted = Redactor::from_env().redact(line);
                let line = if redacted.chars().count() > 240 {
                    format!("{}…", redacted.chars().take(240).collect::<String>())
                } else {
                    redacted
                };
                push_or_merge(
                    name,
                    EVIDENCE_LOG_MENTION,
                    Some(format!("[{log_name}] {line}")),
                );
            }
        }
    }
    if let Some(crash_unix) = crash_unix {
        for entry in mods {
            let fresh = entry
                .modified
                .as_deref()
                .and_then(parse_rfc3339_unix)
                .is_some_and(|t| t >= crash_unix - 24 * 3600 && t <= crash_unix + 60);
            if fresh {
                push_or_merge(entry.name.clone(), EVIDENCE_RECENT_CHANGE, None);
            }
        }
    }
    suspects.sort_by_key(|s| match s.evidence.as_str() {
        EVIDENCE_DANGLING_REF => 0,
        EVIDENCE_MISSING_ASSET => 1,
        EVIDENCE_LOG_MENTION => 2,
        _ => 3,
    });
    suspects
}

/// The res_mods entries a game-log line may name: the FIRST path segment
/// after res_mods/ and (when present) the SECOND. The current layout has
/// NO version segment (bin/<build>/res_mods/<entry>) while older log
/// lines may carry one — the caller resolves the ambiguity against the
/// mods inventory. Both separator spellings appear in the wild.
fn res_mods_path_candidates(line: &str) -> Option<(String, Option<String>)> {
    let normalized = line.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    let pos = lower.find("res_mods/")?;
    let after = &normalized[pos + "res_mods/".len()..];
    let mut segments = after.split('/');
    let first = segments.next()?.trim();
    if first.is_empty() {
        return None;
    }
    let second = segments
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((first.to_string(), second))
}

/// The full analysis pass for one already-loaded record.
fn analyze_sync(record: &GameCrashRecord) -> anyhow::Result<CrashAnalysis> {
    let root = record.game_root.clone();
    let candidates = root
        .as_deref()
        .map(Path::new)
        .map(game_log_candidates)
        .unwrap_or_default();
    let mut game_logs = Vec::new();
    let mut raw_texts: Vec<(String, String)> = Vec::new();
    for path in candidates {
        // Keep the raw (redacted) text of the same tail window the excerpt
        // saw: the suspect scan needs the res_mods lines the highlight
        // keywords alone might miss.
        if let Ok((bytes, _, _)) = read_tail(&path, EXCERPT_FILE_CAP) {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            raw_texts.push((name, text));
        }
        if let Ok(excerpt) = excerpt_of(&path, EXCERPT_TAIL_LINES) {
            game_logs.push(excerpt);
        }
    }
    let app_logs = app_log_excerpts().unwrap_or_default();
    let mods_inventory = root
        .as_deref()
        .map(Path::new)
        .map(mods_inventory_entries)
        .unwrap_or_default();
    let current_build = root
        .as_deref()
        .and_then(super::mod_hub::latest_bin_version)
        .map(|(build, _)| build);
    // The death-window dangling references (Scaleform loader failures):
    // each URL becomes a critical finding, and the reverse lookup pins the
    // mod files that still ask for it — the fast auto-fix path.
    let dangling_urls: Vec<String> = raw_texts
        .iter()
        .flat_map(|(_, text)| dangling_urls_from_text(text))
        .collect();
    let mut seen_urls: Vec<String> = Vec::new();
    for url in dangling_urls {
        if !seen_urls.iter().any(|u| u == &url) {
            seen_urls.push(url);
        }
    }
    // Attribution FIRST: only a dangling URL some mod file still references
    // is worth a finding (the game logs plenty of benign loader misses —
    // icon_default.png and friends — that no mod touched), and same-basename
    // spellings collapse to the most specific one.
    let mut attributed: Vec<SuspectMod> = Vec::new();
    if let Some(root_path) = root.as_deref().map(Path::new) {
        for base in res_mods_bases(root_path) {
            for suspect in dangling_ref_suspects(&base, &seen_urls) {
                if !attributed.iter().any(|s| s.name == suspect.name) {
                    attributed.push(suspect);
                }
            }
        }
    }
    let referenced = |url: &String| {
        let basename = url.rsplit('/').next().unwrap_or(url.as_str());
        attributed.iter().any(|s| {
            s.log_lines
                .iter()
                .any(|l| l == url || l.rsplit('/').next().unwrap_or(l.as_str()) == basename)
        })
    };
    let mut display_urls: Vec<String> = Vec::new();
    for url in &seen_urls {
        if !referenced(url) {
            continue;
        }
        let basename = url.rsplit('/').next().unwrap_or(url.as_str());
        // Longer spelling wins; a bare name only fills when no full path
        // for the same file exists.
        match display_urls
            .iter_mut()
            .find(|u| u.rsplit('/').next().unwrap_or(u.as_str()) == basename)
        {
            Some(existing) => {
                if url.len() > existing.len() {
                    *existing = url.clone();
                }
            },
            None => display_urls.push(url.clone()),
        }
    }
    // Proactive static pass: mod files referencing client assets that exist
    // in neither tree nor the client index. This is the battle_stats.swf
    // class found WITHOUT waiting for a crash — the log-evidenced pass only
    // knows what the loader complained about.
    let mut proactive: Vec<ModReference> = Vec::new();
    if let Some(root_path) = root.as_deref().map(Path::new) {
        if let Some(root_str) = root.as_deref() {
            if let Some(client) = client_asset_basenames(root_str) {
                proactive = dangling_mod_references(&res_mods_bases(root_path), &client);
            }
        }
    }
    let mut findings = build_findings(record, &mods_inventory, &game_logs, &display_urls);
    for reference in proactive.iter().take(6) {
        findings.push(CrashFinding {
            code: "missingModAsset".to_string(),
            severity: "warning".to_string(),
            detail: Some(reference.asset.clone()),
        });
    }
    let raw_refs: Vec<(&str, &str)> = raw_texts
        .iter()
        .map(|(name, text)| (name.as_str(), text.as_str()))
        .collect();
    let mut suspects = detect_suspect_mods(
        &raw_refs,
        &mods_inventory,
        parse_rfc3339_unix(&record.detected_at),
    );
    for suspect in attributed {
        if !suspects.iter().any(|s| s.name == suspect.name) {
            suspects.push(suspect);
        }
    }
    for reference in &proactive {
        for file in &reference.files {
            match suspects.iter_mut().find(|s| s.name == *file) {
                Some(existing) => {
                    if !existing.log_lines.iter().any(|l| l == &reference.asset) {
                        existing.log_lines.push(reference.asset.clone());
                    }
                },
                None => suspects.push(SuspectMod {
                    name: file.clone(),
                    evidence: EVIDENCE_MISSING_ASSET.to_string(),
                    log_lines: vec![reference.asset.clone()],
                }),
            }
        }
    }
    // The user's ignored set: a dismissed suspect stays out of the active
    // list (the managed list surfaces it with a restore action).
    let ignored = super::appdata::appdata_dir_path()
        .map(|dir| load_ignored_in(&dir))
        .unwrap_or_default();
    suspects.retain(|s| !ignored.iter().any(|i| i.name.eq_ignore_ascii_case(&s.name)));
    suspects.sort_by_key(|s| match s.evidence.as_str() {
        EVIDENCE_DANGLING_REF => 0,
        EVIDENCE_LOG_MENTION => 1,
        _ => 2,
    });
    Ok(CrashAnalysis {
        record: record.clone(),
        findings,
        game_logs,
        app_logs,
        mods_inventory,
        suspects,
        current_build,
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
}

// ── proactive dangling-reference scan ───────────────────────────────────────

/// One mod file referencing an asset that exists in neither the mods tree
/// nor the client index — the static sibling of the crash-log heuristic.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ModReference {
    /// The referenced asset basename (lowercase, e.g. `battle_stats.swf`).
    asset: String,
    /// The referencing mod files (paths relative to their mods tree).
    files: Vec<String>,
}

/// Extract every `.swf` reference token from a text blob: XML/Python mod
/// glue spells URLs and script paths bare, so the token charset is path-
/// safe. Placeholder-bearing tokens are ignored — they are format
/// strings, not real references.
#[cfg(windows)]
fn swf_refs_in_text(text: &str) -> Vec<String> {
    fn is_token_char(c: char) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\' | '~')
    }
    let mut refs: Vec<String> = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if is_token_char(c) {
            current.push(c);
        } else {
            push_swf_token(&mut refs, &current);
            current.clear();
        }
    }
    push_swf_token(&mut refs, &current);
    refs
}

/// The token as a reference: only `.swf` files count (the Scaleform crash
/// class), reduced to the basename — idx tables store names only, and a
/// basename match is the conservative presence test.
#[cfg(windows)]
fn push_swf_token(refs: &mut Vec<String>, token: &str) {
    let lower = token.replace('\\', "/").to_ascii_lowercase();
    if !lower.ends_with(".swf") || lower.len() <= 4 {
        return;
    }
    let base = lower.rsplit('/').next().unwrap_or(lower.as_str());
    // Toolchain placeholders spell their stubs with a leading "__"
    // (ModForge's __forge_stub.swf) — never a real load target.
    if !base.is_empty() && !base.contains('%') && !base.starts_with("__") {
        refs.push(base.to_string());
    }
}

/// Every client asset basename the install index knows (all `bin/<ver>/idx`
/// tables, lowercased). Cached per game root: the parse is a few MB and the
/// analysis may run repeatedly.
#[cfg(windows)]
fn client_asset_basenames(game_root: &str) -> Option<Arc<HashSet<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<HashSet<String>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|m| m.get(game_root).cloned()) {
        return Some(hit);
    }
    let (_, ver_dir) = super::game_context::latest_bin_dir(Path::new(game_root))?;
    let idx_dir = ver_dir.join("idx");
    let entries = fs::read_dir(&idx_dir).ok()?;
    let mut set: HashSet<String> = HashSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_idx = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("idx"));
        if !is_idx {
            continue;
        }
        let Ok(data) = fs::read(&path) else { continue };
        let Ok(parsed) = game_assets::data::idx::parse(&data) else {
            continue;
        };
        for resource in parsed.resources {
            set.insert(resource.filename.to_ascii_lowercase());
        }
    }
    let set = Arc::new(set);
    if let Ok(mut map) = cache.lock() {
        map.insert(game_root.to_string(), set.clone());
    }
    Some(set)
}

/// The mod tree files worth scanning for asset references: small text files
/// only (mod glue is XML/Python/JSON; binaries are skipped).
#[cfg(windows)]
fn is_mod_text_file(name: &str) -> bool {
    [
        ".xml", ".py", ".json", ".txt", ".yaml", ".yml", ".cfg", ".ini",
    ]
    .iter()
    .any(|ext| name.to_ascii_lowercase().ends_with(ext))
}

/// Walk the mods trees, extract every `.swf` reference and answer the ones
/// that exist in NEITHER tree NOR the client index. Purely static: the
/// battle_stats.swf class of breakage is found before the first crash.
#[cfg(windows)]
fn dangling_mod_references(bases: &[PathBuf], client: &HashSet<String>) -> Vec<ModReference> {
    // Every file basename present in the mods trees (conservative: a
    // reference whose basename exists anywhere counts as present).
    let mut present: HashSet<String> = HashSet::new();
    let mut scan_files: Vec<(PathBuf, String)> = Vec::new();
    let mut seen = 0usize;
    // The ModForge toolkit builds packages; its templates reference stub
    // SWFs that never load at runtime. Scanning them is pure noise.
    let is_toolchain = |rel: &str| {
        let lower = rel.to_ascii_lowercase();
        lower.starts_with("pnfmods/modforge/")
    };
    for base in bases {
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            if seen > 4000 {
                break;
            }
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                seen += 1;
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                    continue;
                };
                present.insert(name.to_ascii_lowercase());
                if is_mod_text_file(&name) && meta.len() <= 512 * 1024 && scan_files.len() < 400 {
                    let rel = path
                        .strip_prefix(base)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_else(|_| name.clone());
                    if !is_toolchain(&rel) {
                        scan_files.push((path, rel));
                    }
                }
            }
        }
    }
    let mut by_asset: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (path, rel) in scan_files {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        for asset in swf_refs_in_text(&text) {
            if present.contains(&asset) || client.contains(&asset) || asset.len() > 200 {
                continue;
            }
            let files = by_asset.entry(asset).or_default();
            if !files.iter().any(|f| f == &rel) {
                files.push(rel.clone());
            }
        }
    }
    by_asset
        .into_iter()
        .map(|(asset, mut files)| {
            files.sort();
            ModReference { asset, files }
        })
        .collect()
}
// ── suspect management: ignore list + deletion ──────────────────────────────

/// The ignored-suspect store (appdata JSON): a name the user dismissed
/// stays out of the analysis findings until restored.
const IGNORED_FILE: &str = "crash-ignored-suspects.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredSuspect {
    pub name: String,
    pub ignored_at: String,
}

/// Load the ignored list (a damaged file answers empty — worst case the
/// warnings reappear, which is the safe direction).
fn load_ignored_in(dir: &Path) -> Vec<IgnoredSuspect> {
    super::appdata::read_json_in(dir, IGNORED_FILE)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_ignored_in(dir: &Path, list: &[IgnoredSuspect]) -> anyhow::Result<()> {
    super::appdata::write_json_in(dir, IGNORED_FILE, &serde_json::to_string(list)?)
}

/// The stored ignore list (the section renders it with restore actions).
#[tauri::command]
pub fn game_crash_ignored_suspects() -> CommandResult<Vec<IgnoredSuspect>> {
    let dir = super::appdata::appdata_dir_path()?;
    Ok(load_ignored_in(&dir))
}

/// Dismiss one suspect warning by name (the analysis filters it out).
#[tauri::command]
pub fn game_crash_ignore_suspect(window: tauri::Window, name: String) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("empty suspect name").into());
    }
    let dir = super::appdata::appdata_dir_path()?;
    let mut list = load_ignored_in(&dir);
    if !list.iter().any(|i| i.name.eq_ignore_ascii_case(name)) {
        list.insert(
            0,
            IgnoredSuspect {
                name: name.to_string(),
                ignored_at: chrono::Utc::now().to_rfc3339(),
            },
        );
    }
    save_ignored_in(&dir, &list)?;
    Ok(())
}

/// Bring one warning back (undo an ignore).
#[tauri::command]
pub fn game_crash_restore_suspect(window: tauri::Window, name: String) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    let dir = super::appdata::appdata_dir_path()?;
    let mut list = load_ignored_in(&dir);
    list.retain(|i| !i.name.eq_ignore_ascii_case(name.trim()));
    save_ignored_in(&dir, &list)?;
    Ok(())
}

/// The tree a quarantined/deletable subject lives in: the active res_mods
/// first, then the safe-mode twin (same rule as the quarantine source).
fn subject_tree(root: &str, name: &str) -> anyhow::Result<PathBuf> {
    let (_, res_mods) = super::game_context::latest_bin_dir(Path::new(root))
        .map(|(_, ver_dir)| (ver_dir.clone(), ver_dir.join("res_mods")))
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {root}"))?;
    if res_mods.join(name).exists() {
        return Ok(res_mods.join(name));
    }
    let (_, quarantine_dir) = quarantine_dir_of(root)?;
    let twin =
        super::mod_hub::disabled_res_mods(quarantine_dir.parent().unwrap_or(Path::new(root)));
    let candidate = twin.join(name);
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(anyhow!(
        "{name}: not found in res_mods or the safe-mode twin"
    ))
}

/// Permanently delete one pinned entry (file or directory) from the mods
/// tree — the destructive sibling of quarantine. Gates like every
/// mutation (main window, known install, game closed) plus: the path is
/// sanitized, and symlinks/junctions are refused rather than followed.
#[tauri::command]
pub async fn game_crash_delete_entry(
    window: tauri::Window,
    game_root: String,
    entry_name: String,
) -> CommandResult<()> {
    crate::commands::ensure_main_window_label(window.label())?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        super::mod_hub::ensure_known_game_root(&game_root)?;
        super::mod_hub::ensure_game_closed(&game_root)?;
        let name = sanitize_entry_name(&entry_name)?;
        let target = subject_tree(&game_root, &name)?;
        let meta = fs::symlink_metadata(&target)?;
        if meta.file_type().is_symlink() {
            return Err(anyhow!(
                "refusing to delete a symlink: {}",
                target.display()
            ));
        }
        if meta.is_dir() {
            fs::remove_dir_all(&target).map_err(|e| anyhow!("delete {}: {e}", target.display()))?;
        } else {
            fs::remove_file(&target).map_err(|e| anyhow!("delete {}: {e}", target.display()))?;
        }
        tracing::warn!(entry = %name, "suspect entry deleted");
        Ok(())
    })
    .await
    .map_err(|e| anyhow!("delete task failed: {e}"))??)
}

// ── export ───────────────────────────────────────────────────────────────────

/// Per-entry caps for the export bundle.
const EXPORT_WER_CAP: u64 = 1024 * 1024;
const EXPORT_APP_TAIL_LINES: usize = 200;

/// Build the redacted crash-report zip under data/crash-reports and reveal
/// it. Layout: readme.txt manifest, crash-record.json, analysis.json,
/// game-logs/, app-logs/, wer/Report.wer, mods-inventory.json.
fn export_sync(app: &tauri::AppHandle, record_id: &str) -> anyhow::Result<String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = super::appdata::appdata_dir_path()?;
    let record = find_record_in(&dir, record_id)?
        .ok_or_else(|| anyhow!("crash record {record_id} not found"))?;
    let analysis = analyze_sync(&record)?;

    let out_dir = crate::paths::data_dir()?.join("crash-reports");
    fs::create_dir_all(&out_dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let id_part: String = record.id.chars().take(14).collect();
    let bundle_path = out_dir.join(format!("game-crash-{id_part}-{stamp}.zip"));

    let redactor = Redactor::from_env();
    let file = fs::File::create(&bundle_path)
        .map_err(|e| anyhow!("create {}: {e}", bundle_path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut manifest = String::new();
    manifest.push_str("WoWSP game-crash report\n");
    manifest.push_str("encoding: UTF-8\n");
    manifest.push_str(&format!(
        "generated-at: {}\n",
        chrono::Local::now().to_rfc3339()
    ));
    manifest.push_str(&format!("app-version: {}\n", env!("CARGO_PKG_VERSION")));
    manifest.push_str(&format!("crash-id: {}\n", record.id));
    manifest.push_str(&format!("detected-at: {}\n", record.detected_at));
    manifest.push_str(&format!(
        "image: {} (pid {})\n",
        record.image_name, record.pid
    ));
    manifest.push_str(&format!("source: {}\n", record.source));
    manifest.push_str(&format!(
        "exception: {}\n",
        record.exception_code.as_deref().unwrap_or("n/a")
    ));
    manifest.push_str(
        "contents: crash-record.json, analysis.json, game-logs/, app-logs/, mods-inventory.json\n",
    );
    // UTF-8 BOM so legacy Windows editors auto-detect (the feedback
    // bundle's same trick).
    zip.start_file("readme.txt", opts)
        .map_err(|e| anyhow!("bundle readme: {e}"))?;
    let mut bom = Vec::with_capacity(manifest.len() + 3);
    bom.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bom.extend_from_slice(manifest.as_bytes());
    zip.write_all(&bom)
        .map_err(|e| anyhow!("bundle readme: {e}"))?;

    // Every text payload is redacted before entering the zip (the feedback
    // bundle contract): the JSON blobs carry filesystem paths that must
    // not leave the machine raw.
    let mut record_json = redactor.redact(&serde_json::to_string_pretty(&record)?);
    record_json.push('\n');
    zip.start_file("crash-record.json", opts)
        .map_err(|e| anyhow!("bundle record: {e}"))?;
    zip.write_all(record_json.as_bytes())
        .map_err(|e| anyhow!("bundle record: {e}"))?;

    let mut analysis_json = redactor.redact(&serde_json::to_string_pretty(&analysis)?);
    analysis_json.push('\n');
    zip.start_file("analysis.json", opts)
        .map_err(|e| anyhow!("bundle analysis: {e}"))?;
    zip.write_all(analysis_json.as_bytes())
        .map_err(|e| anyhow!("bundle analysis: {e}"))?;

    for log in &analysis.game_logs {
        zip.start_file(format!("game-logs/{}", log.name), opts)
            .map_err(|e| anyhow!("bundle game log: {e}"))?;
        zip.write_all(log.tail.as_bytes())
            .map_err(|e| anyhow!("bundle game log: {e}"))?;
    }
    for log in &analysis.app_logs {
        // The stored excerpt is the tail-window slice; for the bundle take
        // a longer tail of the same file so support sees more context.
        let text = excerpt_of(Path::new(&log.path), EXPORT_APP_TAIL_LINES)
            .map(|excerpt| excerpt.tail)
            .unwrap_or_else(|_| log.tail.clone());
        zip.start_file(format!("app-logs/{}", log.name), opts)
            .map_err(|e| anyhow!("bundle app log: {e}"))?;
        zip.write_all(text.as_bytes())
            .map_err(|e| anyhow!("bundle app log: {e}"))?;
    }

    if let Some(report) = &record.wer_report_path {
        if let Ok(bytes) = fs::read(Path::new(report).join("Report.wer")) {
            let bytes: &[u8] = if bytes.len() as u64 > EXPORT_WER_CAP {
                &bytes[bytes.len() - EXPORT_WER_CAP as usize..]
            } else {
                &bytes
            };
            #[cfg(windows)]
            let text = redactor.redact(&decode_wer_bytes(bytes));
            #[cfg(not(windows))]
            let text = redactor.redact(&String::from_utf8_lossy(bytes));
            zip.start_file("wer/Report.wer", opts)
                .map_err(|e| anyhow!("bundle wer: {e}"))?;
            zip.write_all(text.as_bytes())
                .map_err(|e| anyhow!("bundle wer: {e}"))?;
        }
    }

    let mut mods_json = redactor.redact(&serde_json::to_string_pretty(&analysis.mods_inventory)?);
    mods_json.push('\n');
    zip.start_file("mods-inventory.json", opts)
        .map_err(|e| anyhow!("bundle mods: {e}"))?;
    zip.write_all(mods_json.as_bytes())
        .map_err(|e| anyhow!("bundle mods: {e}"))?;

    zip.finish()
        .map_err(|e| anyhow!("finalize {}: {e}", bundle_path.display()))?;

    tracing::info!(?bundle_path, crash = %record.id, "game-crash report exported");
    let _ = app
        .opener()
        .reveal_item_in_dir(&bundle_path)
        .inspect_err(|e| tracing::warn!(error = %e, "reveal crash report failed"));
    Ok(bundle_path.to_string_lossy().into_owned())
}

// ── restart ──────────────────────────────────────────────────────────────────

/// Resolve the restart target: the explicit root, else the last crash
/// record's root, else the persisted active install, else the first
/// detected one.
fn resolve_restart_root(arg: Option<&str>) -> anyhow::Result<String> {
    if let Some(root) = arg {
        return Ok(root.to_string());
    }
    let dir = super::appdata::appdata_dir_path()?;
    if let Some(records) = load_history_in(&dir)? {
        if let Some(root) = records.into_iter().find_map(|r| r.game_root) {
            return Ok(root);
        }
    }
    if let Some(active) = super::game_context::persisted_active_path() {
        return Ok(active);
    }
    super::game_context::cached_scan()
        .first()
        .map(|install| install.path.clone())
        .ok_or_else(|| anyhow!("no known game install to restart — detect an install first"))
}

/// The install's own launcher stub: the matched family's root stub first
/// (WorldOfWarships.exe / Korabli.exe per the client registry), then any
/// family's stub that exists on disk.
fn stub_exe_for(root: &str) -> anyhow::Result<PathBuf> {
    let mut names: Vec<&'static str> = Vec::new();
    if let Some(install) = super::game_context::cached_scan()
        .into_iter()
        .find(|install| super::game_context::same_folder(&install.path, root))
    {
        names.push(super::game_client::client_for_kind(&install.kind).root_stub());
    }
    for stub in super::game_client::game_root_stubs() {
        if !names.contains(&stub) {
            names.push(stub);
        }
    }
    for name in names {
        let candidate = Path::new(root).join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "no client launcher stub in {root} — expected the family stub exe next to bin/"
    ))
}

/// The user-invoked restart body. Guards: the root must be one the backend
/// knows, and THAT client must not be running. The spawn is detached — the
/// child handle is dropped immediately, so this process can never own,
/// wait on or kill the game.
fn restart_sync(game_root: Option<&str>) -> anyhow::Result<GameRestartInfo> {
    let root = resolve_restart_root(game_root)?;
    super::mod_hub::ensure_known_game_root(&root)?;
    if let Some((pid, live)) = super::game_context::running_root_matching(&root) {
        return Err(anyhow!(
            "World of Warships is already running from {live} (pid {pid}) — nothing to restart"
        ));
    }
    let exe = stub_exe_for(&root)?;
    let child = std::process::Command::new(&exe)
        .current_dir(&root)
        .spawn()
        .map_err(|e| anyhow!("launch {}: {e}", exe.display()))?;
    let pid = child.id();
    drop(child);
    tracing::info!(pid, exe = %exe.display(), root = %root, "game client launched (user-invoked restart)");
    Ok(GameRestartInfo {
        game_root: root,
        exe_path: exe.to_string_lossy().into_owned(),
        pid,
    })
}

// ── commands ─────────────────────────────────────────────────────────────────

/// The safeguard switch state (the settings toggle reads it).
#[cfg(windows)]
#[tauri::command]
pub fn game_crash_safeguard_enabled() -> CommandResult<bool> {
    Ok(safeguard_enabled())
}

/// The mobile stand-in: no watchdog exists, the toggle reads off.
#[cfg(not(windows))]
#[tauri::command]
pub fn game_crash_safeguard_enabled() -> CommandResult<bool> {
    Ok(false)
}

/// Flip the safeguard: persist the setting, arm/disarm the watchdog tick,
/// and on the enabling edge run one recent-crash catch-up. Main-window
/// gated (a state change).
#[tauri::command]
pub async fn game_crash_set_safeguard(
    window: tauri::Window,
    app: tauri::AppHandle,
    enabled: bool,
) -> CommandResult<bool> {
    crate::commands::ensure_main_window_label(window.label())?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        set_safeguard(&app, enabled)?;
        Ok::<bool, anyhow::Error>(enabled)
    })
    .await
    .map_err(|e| anyhow!("safeguard task failed: {e}"))??)
}

/// Parse the recent crash records: harvest OS evidence the history has
/// not recorded yet (crashes that landed while the app was closed) and
/// import them. Returns the newly imported records. Heavy IO on the
/// blocking pool; the settings section toasts the count.
#[cfg(windows)]
#[tauri::command]
pub async fn game_crash_scan_recent(app: tauri::AppHandle) -> CommandResult<Vec<GameCrashRecord>> {
    Ok(
        tauri::async_runtime::spawn_blocking(move || backfill_recent(&app))
            .await
            .map_err(|e| anyhow!("scan task failed: {e}"))??,
    )
}

/// The mobile stand-in: nothing to harvest.
#[cfg(not(windows))]
#[tauri::command]
pub async fn game_crash_scan_recent(_app: tauri::AppHandle) -> CommandResult<Vec<GameCrashRecord>> {
    Ok(Vec::new())
}

/// List every retained crash record, newest first.
#[tauri::command]
pub fn game_crash_list() -> CommandResult<Vec<GameCrashRecord>> {
    let dir = super::appdata::appdata_dir_path()?;
    Ok(load_history_in(&dir)?.unwrap_or_default())
}

/// Mark one crash record dismissed (the prompt stops re-surfacing it).
#[tauri::command]
pub fn game_crash_dismiss(record_id: String) -> CommandResult<()> {
    let dir = super::appdata::appdata_dir_path()?;
    Ok(dismiss_record_in(&dir, &record_id)?)
}

/// The analysis pass for one record: findings + log excerpts + mods
/// inventory. Heavy IO on the blocking pool, like the feedback bundle.
#[tauri::command]
pub async fn game_crash_analyze(record_id: String) -> CommandResult<CrashAnalysis> {
    let dir = super::appdata::appdata_dir_path()?;
    let record = find_record_in(&dir, &record_id)?
        .ok_or_else(|| anyhow!("crash record {record_id} not found"))?;
    Ok(
        tauri::async_runtime::spawn_blocking(move || analyze_sync(&record))
            .await
            .map_err(|e| anyhow!("analysis task failed: {e}"))??,
    )
}

/// Export one crash's redacted report bundle (zip) and reveal it. Returns
/// the bundle path.
#[tauri::command]
pub async fn game_crash_export(app: tauri::AppHandle, record_id: String) -> CommandResult<String> {
    Ok(
        tauri::async_runtime::spawn_blocking(move || export_sync(&app, &record_id))
            .await
            .map_err(|e| anyhow!("export task failed: {e}"))??,
    )
}

/// Launch the game client for the given (or last-crashed / active)
/// install. Main-window only; refuses while THAT client is running; never
/// touches a running or live session — the game just crashed or the user
/// closed it.
#[tauri::command]
pub async fn game_crash_restart(
    window: tauri::Window,
    game_root: Option<String>,
) -> CommandResult<GameRestartInfo> {
    crate::commands::ensure_main_window_label(window.label())?;
    Ok(
        tauri::async_runtime::spawn_blocking(move || restart_sync(game_root.as_deref()))
            .await
            .map_err(|e| anyhow!("restart task failed: {e}"))??,
    )
}

/// Move one top-level res_mods entry into the per-version quarantine dir
/// (a single atomic rename out of the load path, crash-id-attributed).
/// Main-window + game-closed gated, like every other mutating mod op.
/// Returns the quarantine manifest (what the mod list pins).
#[tauri::command]
pub async fn game_crash_quarantine_mod(
    window: tauri::Window,
    game_root: String,
    entry_name: String,
    crash_id: Option<String>,
) -> CommandResult<Vec<QuarantineEntry>> {
    crate::commands::ensure_main_window_label(window.label())?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        mutate_quarantine(&game_root, &entry_name, crash_id.as_deref(), true)
    })
    .await
    .map_err(|e| anyhow!("quarantine task failed: {e}"))??)
}

/// Bring one quarantined entry back into res_mods. Returns the updated
/// manifest.
#[tauri::command]
pub async fn game_crash_restore_mod(
    window: tauri::Window,
    game_root: String,
    entry_name: String,
) -> CommandResult<Vec<QuarantineEntry>> {
    crate::commands::ensure_main_window_label(window.label())?;
    let _gate = super::mod_catalog::mod_hub_gate().await;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        mutate_quarantine(&game_root, &entry_name, None, false)
    })
    .await
    .map_err(|e| anyhow!("restore task failed: {e}"))??)
}

/// The current quarantine manifest of one install (what the mod list
/// pins while entries sit outside the load path).
#[tauri::command]
pub fn game_crash_quarantined_mods(game_root: String) -> CommandResult<Vec<QuarantineEntry>> {
    super::mod_hub::ensure_known_game_root(&game_root)?;
    let (_, quarantine_dir) = quarantine_dir_of(&game_root)?;
    Ok(load_quarantine_manifest(&quarantine_dir)?)
}

#[cfg(test)]
mod tests;
