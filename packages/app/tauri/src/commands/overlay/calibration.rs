//! Persistent anchor-calibration store for the Tab overlay — the layer that
//! turns "the detector agrees with itself" into "stop re-detecting".
//!
//! The watcher already keeps the table geometry OUT of the per-press path
//! via the in-memory [`GeometryCacheEntry`] (one full scan per game-window
//! mode, cheap band verifies afterwards). This module adds the two things
//! that cache cannot do:
//!
//! - SURVIVE RESTARTS: the geometry is persisted under the appdata root, so
//!   the first Tab press of a new session verifies the stored band instead
//!   of paying the full-frame scan.
//! - RETIRE THE PERIODIC RE-DETECTION once the geometry has proven STABLE:
//!   every Tab press that confirms the cached band (capture + verify, no
//!   scan) casts one vote; after [`STABLE_PRESSES_TO_CERTIFY`] consecutive
//!   presses the entry is CERTIFIED and the watcher stops scheduling the
//!   5 s anchor revalidations (see `watch_tab_tick`'s revalidate gate) —
//!   the sink probe's band gate keeps watching reactively, so a table that
//!   genuinely moves (HUD phase switch) still drops the cache, forces one
//!   revalidation and restarts the streak.
//!
//! The store is keyed so that everything the pixel geometry actually
//! depends on — plus everything the OWNER asked to treat as a hard
//! invalidation — must match before an entry is reused:
//!
//! - CLIENT ISOLATION: one file per game install
//!   (`overlay-anchors/<install-key>.toml`), so twin installs (a WG and a
//!   Lesta client, two Steam libraries) never share coordinates;
//! - BATTLE CLASS: PvP and PvE tables are different layouts (the PvE
//!   variant renders a single centered team header), so each class keeps
//!   its OWN entry (`[pvp]` / `[pve]` sections);
//! - GAME-WINDOW GEOMETRY: origin, size and style bits — a moved, resized
//!   or re-styled window re-arms detection (the origin deliberately IS
//!   part of the identity here, unlike the in-memory cache, whose
//!   capture-relative geometry is origin-independent);
//! - HARDWARE SCREEN CONFIGURATION: a fingerprint of the monitor layout
//!   (origins, resolutions, per-monitor DPI), so docking/undocking, a
//!   resolution change or a scale change retires every entry at once;
//! - CLIENT KIND: the Lesta scoreboard pitches differently than WG's at
//!   the same window size.
//!
//! All decision logic here is pure and platform-free (Win32 callers
//! assemble a [`LiveKey`] and feed it in), so the whole stability contract
//! is unit-testable off-Windows. Disk I/O is best-effort: a missing,
//! unreadable or corrupt file resolves to an empty store — the watcher
//! falls back to plain uncached detection and rebuilds the entry from the
//! next successful detection.

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::overlay_detect::{self, DetectProfile, DetectedRoster, HeaderBand, MAX_WORK_WIDTH};
use super::rect_from_win32;
use wowsp_tauri_shared::{CommandResult, GameInstallKind, Rect};

/// Stable presses required before an entry is certified (its periodic
/// revalidations stand down). Three mirrors the cache's own
/// `GEOMETRY_VERIFY_MAX_FAILS` symmetry: one press is an anecdote, three
/// consecutive presses with the band verifying at the same spot is a
/// layout the client actually renders.
pub(super) const STABLE_PRESSES_TO_CERTIFY: u32 = 3;

/// Directory (under the appdata root) holding one calibration file per
/// game install.
const CALIBRATION_DIR: &str = "overlay-anchors";

/// DWM frame-bounds jitter the origin comparison tolerates — the same
/// tolerance the pin and manual-anchor checks apply, so a phantom 1–4 px
/// shift must not retire an otherwise stable entry (and a REAL move, far
/// beyond it, always does).
const ORIGIN_JITTER_PX: i32 = 8;

/// Which of the two independently-detected table layouts a battle uses.
/// PvP-class battles (random / ranked / clan …) render the classic
/// two-team table; PvE-class ones (co-op / scenarios / operations) render
/// the single-team variant — different geometry, different entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum BattleClass {
    Pvp,
    Pve,
}

impl BattleClass {
    /// Pure classification mirror of `note_arena_seen`'s PvE rule
    /// (unit-tested): operations are PvE by construction, and co-op
    /// battles carry `matchGroup: "pve"` on the arena file — everything
    /// else (random, ranked, clan, brawls) is the two-team PvP table.
    #[cfg(test)]
    pub(super) fn classify(operation: bool, match_group: Option<&str>) -> Self {
        if operation || matches!(match_group, Some("pve")) {
            BattleClass::Pve
        } else {
            BattleClass::Pvp
        }
    }

    /// The live battle's class off the process-global arena state.
    pub(super) fn current() -> Self {
        if super::super::arena_info::last_battle_pve() {
            BattleClass::Pve
        } else {
            BattleClass::Pvp
        }
    }
}

/// The strip-layout profile selection as persisted — the client-kind base,
/// or the WG next-generation rework a detection measured. Round-trips
/// through the two constants that matter (see [`DetectProfile`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum StoredProfile {
    /// [`DetectProfile::for_kind`] of the entry's client kind.
    Kind,
    /// [`DetectProfile::WG_NEXT`] — measured by `resolve_wg_strip_profile`.
    WgNext,
}

impl StoredProfile {
    /// Persist the profile a detection resolved to.
    pub(super) fn of(profile: &DetectProfile) -> Self {
        if *profile == DetectProfile::WG_NEXT {
            StoredProfile::WgNext
        } else {
            StoredProfile::Kind
        }
    }

    /// Restore the profile for a client kind.
    pub(super) fn resolve(self, kind: &GameInstallKind) -> DetectProfile {
        match self {
            StoredProfile::Kind => DetectProfile::for_kind(kind),
            StoredProfile::WgNext => DetectProfile::WG_NEXT,
        }
    }
}

/// [`HeaderBand`] as persisted (working-px coordinates, end-exclusive
/// spans — identical shape, serde-friendly).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct StoredBand {
    pub top: usize,
    pub height: usize,
    pub green: (usize, usize),
    pub red: Option<(usize, usize)>,
}

impl From<HeaderBand> for StoredBand {
    fn from(b: HeaderBand) -> Self {
        StoredBand {
            top: b.top,
            height: b.height,
            green: b.green,
            red: b.red,
        }
    }
}

impl From<StoredBand> for HeaderBand {
    fn from(b: StoredBand) -> Self {
        HeaderBand {
            top: b.top,
            height: b.height,
            green: b.green,
            red: b.red,
        }
    }
}

/// [`DetectedRoster`] as persisted (capture-relative physical px).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct StoredRoster {
    pub rect: wowsp_tauri_shared::Rect,
    pub row_centers: Vec<i32>,
    pub team_split: f32,
}

impl From<DetectedRoster> for StoredRoster {
    fn from(r: DetectedRoster) -> Self {
        StoredRoster {
            rect: r.rect,
            row_centers: r.row_centers,
            team_split: r.team_split,
        }
    }
}

impl From<StoredRoster> for DetectedRoster {
    fn from(r: StoredRoster) -> Self {
        DetectedRoster {
            rect: r.rect,
            row_centers: r.row_centers,
            team_split: r.team_split,
        }
    }
}

/// One battle class's calibrated geometry plus the identity it is valid
/// under. `stable_presses` counts consecutive press-votes since the
/// geometry was (re)established; at [`STABLE_PRESSES_TO_CERTIFY`] the
/// entry is certified.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct AnchorEntry {
    pub kind: GameInstallKind,
    /// Install-identity key of the client this was measured on.
    pub client_key: String,
    /// Game-window ORIGIN (physical px) — a real move re-arms detection.
    pub origin: (i32, i32),
    pub size: (i32, i32),
    pub style_bits: u64,
    /// Monitor-configuration fingerprint at measurement time.
    pub screen: String,
    pub band: StoredBand,
    pub roster: StoredRoster,
    pub team_sizes: (usize, usize),
    pub profile: StoredProfile,
    pub stable_presses: u32,
    /// Set when the stored band kept failing verification (the cache was
    /// retired): the entry no longer seeds or certifies — but its
    /// PROPORTIONS stay valid as the remap fallback's input, so the
    /// geometry is kept. A later successful detection clears the flag
    /// wholesale (see [`CalibrationCtx::note_geometry`]).
    #[serde(default)]
    pub suspect: bool,
    /// True when the entry was hand-drawn in the settings calibration
    /// editor (not measured by the detector). Manual entries start
    /// certified; they are still subject to the same suspect retirement
    /// every measured entry is.
    #[serde(default)]
    pub manual: bool,
}

impl AnchorEntry {
    pub(super) fn certified(&self) -> bool {
        !self.suspect && self.stable_presses >= STABLE_PRESSES_TO_CERTIFY
    }
}

/// One client's calibration file: PvP and PvE keep independent entries.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct ClientCalibration {
    #[serde(default)]
    pub pvp: Option<AnchorEntry>,
    #[serde(default)]
    pub pve: Option<AnchorEntry>,
}

impl ClientCalibration {
    pub(super) fn entry(&self, class: BattleClass) -> Option<&AnchorEntry> {
        match class {
            BattleClass::Pvp => self.pvp.as_ref(),
            BattleClass::Pve => self.pve.as_ref(),
        }
    }

    fn entry_mut(&mut self, class: BattleClass) -> &mut Option<AnchorEntry> {
        match class {
            BattleClass::Pvp => &mut self.pvp,
            BattleClass::Pve => &mut self.pve,
        }
    }
}

/// Everything the watcher knows about the current moment, assembled per
/// capture/tick and matched against the stored entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LiveKey {
    pub class: BattleClass,
    pub kind: GameInstallKind,
    pub client_key: String,
    pub origin: (i32, i32),
    pub size: (i32, i32),
    pub style_bits: u64,
    pub screen: String,
}

/// Strict identity: every field must match (origin within jitter). This is
/// the CERTIFICATION check — an entry may only stand in for the live
/// geometry when the window sits where the entry was measured and the
/// screen is the screen it was measured on.
pub(super) fn entry_matches_strict(entry: &AnchorEntry, key: &LiveKey) -> bool {
    entry_matches_geometry(entry, key) && origin_within_jitter(entry.origin, key.origin)
}

/// Geometry identity WITHOUT the origin: class, client, kind, window size,
/// style bits and screen fingerprint. The in-memory geometry cache is
/// capture-relative (origin-independent), so a press that verifies the
/// band after a pure window MOVE still confirms the geometry — but the
/// streak re-baselines at the new origin (see
/// [`CalibrationCtx::note_stable`]).
pub(super) fn entry_matches_geometry(entry: &AnchorEntry, key: &LiveKey) -> bool {
    entry.client_key == key.client_key
        && entry.kind == key.kind
        && entry.size == key.size
        && entry.style_bits == key.style_bits
        && entry.screen == key.screen
}

fn origin_within_jitter(a: (i32, i32), b: (i32, i32)) -> bool {
    (a.0 - b.0).abs() <= ORIGIN_JITTER_PX && (a.1 - b.1).abs() <= ORIGIN_JITTER_PX
}

// ─────────────────────────────────────────────────────────────────────────
// Disk persistence (one file per client install)
// ─────────────────────────────────────────────────────────────────────────

/// File name for a client's calibration: the install key sanitized to
/// `[a-z0-9-]` plus a short FNV-1a suffix of the RAW key, so two installs
/// whose sanitized paths collide can never share a file.
pub(super) fn client_file_name(client_key: &str) -> String {
    let mut stem: String = client_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while stem.contains("--") {
        stem = stem.replace("--", "-");
    }
    let stem = stem.trim_matches('-');
    let stem = if stem.is_empty() { "client" } else { stem };
    // Cap the stem so even a deep install path stays a legal Windows file
    // name once the suffix lands.
    let capped: String = stem.chars().take(120).collect();
    format!("{capped}-{:08x}.toml", fnv1a(client_key.as_bytes()))
}

fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Path of a client's calibration file under the given data root.
pub(super) fn client_file_path(data_dir: &Path, client_key: &str) -> PathBuf {
    data_dir
        .join(CALIBRATION_DIR)
        .join(client_file_name(client_key))
}

/// Load a client's calibration; any missing/corrupt file resolves to an
/// empty store (the watcher detects fresh and rewrites it).
pub(super) fn load(path: &Path) -> ClientCalibration {
    match std::fs::read_to_string(path) {
        Ok(raw) => match toml::from_str(&raw) {
            Ok(cal) => cal,
            Err(e) => {
                tracing::warn!(file = %path.display(), error = %e, "anchor calibration unreadable — starting empty");
                ClientCalibration::default()
            },
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ClientCalibration::default(),
        Err(e) => {
            tracing::warn!(file = %path.display(), error = %e, "anchor calibration unreadable — starting empty");
            ClientCalibration::default()
        },
    }
}

/// Modification stamp of a calibration file (`None` when unreadable —
/// treated as "unknown", which forces one reload on the next compare).
fn file_stamp(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

/// Best-effort atomic write; failures are logged, never propagated — a
/// calibration that cannot persist still works for this session.
pub(super) fn save(path: &Path, cal: &ClientCalibration) {
    let body = match toml::to_string_pretty(cal) {
        Ok(body) => body,
        Err(e) => {
            tracing::warn!(error = %e, "anchor calibration serialization failed");
            return;
        },
    };
    let content = format!(
        "# WoWSP anchor calibration (auto-managed; stable Tab-table geometry per battle class).\n\
         # Safe to delete — the app re-detects and rewrites it on the next battles.\n{body}"
    );
    if let Err(e) = crate::atomic_file::write(path, &content) {
        tracing::warn!(file = %path.display(), error = %e, "anchor calibration write failed");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Settings-editor IPC surface (the 游戏内显示校准 subpage)
// ─────────────────────────────────────────────────────────────────────────

/// Display name of a client kind.
fn kind_name(kind: &GameInstallKind) -> &'static str {
    match kind {
        GameInstallKind::Wargaming => "wargaming",
        GameInstallKind::Steam => "steam",
        GameInstallKind::Lesta => "lesta",
        GameInstallKind::Cn360 => "cn360",
        GameInstallKind::CnKongzhong => "kongzhong",
        GameInstallKind::Manual => "manual",
    }
}

/// Parse a client-kind string back into a [`GameInstallKind`] — accepts
/// [`kind_name`]'s spellings plus the shared DTO's camelCase `cnKongzhong`,
/// so the webui can forward whichever spelling it holds. `None` on anything
/// else.
fn kind_from_name(name: &str) -> Option<GameInstallKind> {
    match name {
        "wargaming" => Some(GameInstallKind::Wargaming),
        "steam" => Some(GameInstallKind::Steam),
        "lesta" => Some(GameInstallKind::Lesta),
        "cn360" => Some(GameInstallKind::Cn360),
        "kongzhong" | "cnKongzhong" => Some(GameInstallKind::CnKongzhong),
        "manual" => Some(GameInstallKind::Manual),
        _ => None,
    }
}

/// Placeholder team shape for a CREATED entry (pre-edited before any battle
/// measured one): the classic 12v12 randoms grid for PvP, the 9-row single
/// team for PvE — the likeliest table the class renders. Only the row
/// re-spread and the synthetic band consume them before the next real
/// battle's detection replaces the entry wholesale.
fn placeholder_team_sizes(class: BattleClass) -> (usize, usize) {
    match class {
        BattleClass::Pvp => (12, 12),
        BattleClass::Pve => (9, 0),
    }
}

/// Placeholder column split matching [`placeholder_team_sizes`] — PvE's
/// single-team layout carries no red half.
fn placeholder_team_split(class: BattleClass) -> f32 {
    match class {
        BattleClass::Pvp => 0.5,
        BattleClass::Pve => 1.0,
    }
}

fn entry_info(class: BattleClass, e: &AnchorEntry) -> wowsp_tauri_shared::CalibrationEntryInfo {
    wowsp_tauri_shared::CalibrationEntryInfo {
        class: match class {
            BattleClass::Pvp => "pvp",
            BattleClass::Pve => "pve",
        }
        .into(),
        game_origin: e.origin,
        game_size: e.size,
        screen: e.screen.clone(),
        certified: e.certified(),
        manual: e.manual,
        suspect: e.suspect,
        stable_presses: e.stable_presses,
        roster_rect: e.roster.rect,
        row_centers: e.roster.row_centers.clone(),
        team_split: e.roster.team_split,
        team_sizes: (e.team_sizes.0 as u32, e.team_sizes.1 as u32),
    }
}

/// The settings calibration list: one row per client install that has a
/// stored calibration file, newest write first. Pure read — the watcher's
/// own store is untouched.
#[tauri::command]
pub async fn overlay_calibration_list()
-> CommandResult<Vec<wowsp_tauri_shared::CalibrationClientInfo>> {
    let dir = match crate::paths::data_dir() {
        Ok(dir) => dir.join(CALIBRATION_DIR),
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for ent in entries.flatten() {
            let path = ent.path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            let updated_at_ms = ent
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let cal = load(&path);
            let (client_key, kind) = match (cal.pvp.as_ref(), cal.pve.as_ref()) {
                (Some(e), _) => (e.client_key.clone(), e.kind),
                (None, Some(e)) => (e.client_key.clone(), e.kind),
                (None, None) => continue,
            };
            out.push(wowsp_tauri_shared::CalibrationClientInfo {
                client_key,
                kind: kind_name(&kind).into(),
                pvp: cal.pvp.as_ref().map(|e| entry_info(BattleClass::Pvp, e)),
                pve: cal.pve.as_ref().map(|e| entry_info(BattleClass::Pve, e)),
                updated_at_ms,
            });
        }
    }
    out.sort_by(|a, b| {
        b.updated_at_ms
            .unwrap_or(0)
            .cmp(&a.updated_at_ms.unwrap_or(0))
    });
    Ok(out)
}

/// Submit the calibration editor's hand-drawn box for one client's stored
/// entry: the selection (plus the reference frame's detected band, or a
/// synthetic approximation when the frame carried no readable table) is
/// scaled from the REFERENCE IMAGE's pixels onto the ENTRY's window size —
/// the entry's identity (origin/size/style/screen/kind) is deliberately
/// KEPT, so editing never depends on the client currently running. The
/// entry restarts CERTIFIED and flagged `manual`; a still-running watcher
/// bound to this client reloads the file through the FIFO.
///
/// A target with NO stored entry yet (the settings list pre-edit button)
/// CREATES one here instead of refusing: the reference frame's pixel size
/// becomes the placeholder window size (identity scale — the box lands
/// exactly where drawn) with an empty identity elsewhere, and `kind`
/// (required only in this case — taken from the sibling class's entry when
/// one exists, else the caller's install-kind string) keys the client
/// family. That placeholder never certifies a live window (the strict and
/// geometry matches reject its empty screen/origin), but the remap fallback
/// — which compares only kind and proportions — adopts the drawing
/// immediately; the next successful detection replaces the entry wholesale.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_calibration_anchor(
    client_key: String,
    class: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    source: Option<wowsp_tauri_shared::ManualLocateSource>,
    kind: Option<String>,
) -> CommandResult<()> {
    let class = if class == "pve" {
        BattleClass::Pve
    } else {
        BattleClass::Pvp
    };
    // Normalize the install key the way the watcher derives it
    // (game_detect::install_path_key): the caller passes whichever
    // spelling it holds — the file's stored key, or the install list's
    // display path — and a pre-edit CREATE must land on exactly the file
    // the running watcher binds (the file name hashes the RAW key, so case
    // drift would fork a second file). Idempotent for already-normalized
    // keys.
    let client_key = super::super::game_detect::install_path_key(&client_key);
    let dir = crate::paths::data_dir()?;
    let path = client_file_path(&dir, &client_key);
    let mut cal = load(&path);
    // Resolve the reference frame the drawing was made against FIRST — a
    // created entry's placeholder window size comes from its pixels.
    let Some((rgba, fw, fh)) = resolve_reference_frame(&source)? else {
        return Err(anyhow!("reference frame unavailable — pick an image or retry").into());
    };
    // Validate in FRAME space, then scale onto the entry's window size.
    let frame_rect = Rect {
        x: 0,
        y: 0,
        width: fw as i32,
        height: fh as i32,
    };
    let sel_frame = Rect {
        x,
        y,
        width,
        height,
    };
    super::manual::validate_manual_selection(&sel_frame, &frame_rect)?;
    let (entry, created) = match cal.entry(class).cloned() {
        Some(entry) => (entry, false),
        None => {
            // No sibling entry to inherit the client kind from either, so
            // the caller's kind string is the only source — without it the
            // entry could never remap (kind is the remap's one identity
            // check).
            let kind = cal
                .entry(match class {
                    BattleClass::Pvp => BattleClass::Pve,
                    BattleClass::Pve => BattleClass::Pvp,
                })
                .map(|sibling| sibling.kind)
                .or_else(|| kind.as_deref().and_then(kind_from_name))
                .ok_or_else(|| {
                    anyhow!("unknown client kind — register the client before pre-editing its calibration")
                })?;
            let placeholder = AnchorEntry {
                kind,
                client_key: client_key.clone(),
                origin: (0, 0),
                size: (fw as i32, fh as i32),
                style_bits: 0,
                screen: String::new(),
                band: StoredBand {
                    top: 0,
                    height: 0,
                    green: (0, 0),
                    red: None,
                },
                roster: StoredRoster {
                    rect: Rect {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    },
                    row_centers: Vec::new(),
                    team_split: placeholder_team_split(class),
                },
                team_sizes: placeholder_team_sizes(class),
                profile: StoredProfile::Kind,
                stable_presses: 0,
                suspect: false,
                manual: false,
            };
            (placeholder, true)
        },
    };
    let (fx, fy) = (
        entry.size.0 as f32 / fw as f32,
        entry.size.1 as f32 / fh as f32,
    );
    let sel = Rect {
        x: (x as f32 * fx).round() as i32,
        y: (y as f32 * fy).round() as i32,
        width: ((width as f32 * fx).round() as i32).max(1),
        height: ((height as f32 * fy).round() as i32).max(1),
    };
    let team_sizes = entry.team_sizes;
    let split = entry.roster.team_split;
    let rows = super::manual::manual_row_centers(&sel, team_sizes);
    // Band: prefer the REAL header bars detected on the reference frame,
    // scaled through the frame's working-px scale into the entry's; fall
    // back to a synthetic band derived from the drawn rect (verify will
    // validate or retire it later).
    let profile = entry.profile.resolve(&entry.kind);
    let detected = overlay_detect::detect_roster_with_band(&rgba, fw, fh, team_sizes, &profile);
    let band = match detected.as_ref().map(|(b, _)| *b) {
        Some(b) => scale_band(b, fw, fx, fy, entry.size.0),
        None => synthetic_band(&sel, split, team_sizes, entry.size.0),
    };
    let updated = AnchorEntry {
        band: band.into(),
        roster: StoredRoster {
            rect: sel,
            row_centers: rows,
            team_split: split,
        },
        stable_presses: STABLE_PRESSES_TO_CERTIFY,
        suspect: false,
        manual: true,
        ..entry
    };
    *cal.entry_mut(class) = Some(updated);
    save(&path, &cal);
    super::manual::clear_picker_open();
    tracing::info!(client = %client_key, class = ?class, created,
        "calibration anchor hand-edited");
    // A running watcher bound to this client reloads through the FIFO; one
    // bound elsewhere (or none) ignores the note.
    super::push_watch_command(super::WatchCommand::CalibrationStoreChanged { client_key });
    Ok(())
}

/// Resolve the editor's reference image into raw RGBA: a gallery capture
/// (by stamp — a stamp that aged out is an ERROR, not a silent re-target:
/// the drawn box belongs to the pixels of the image it was drawn on) or
/// the custom base64 image. `Ok(None)` when nothing is available at all
/// (no game window → no captures, or a missing/undecodable image).
#[cfg(target_os = "windows")]
fn resolve_reference_frame(
    source: &Option<wowsp_tauri_shared::ManualLocateSource>,
) -> anyhow::Result<Option<(Vec<u8>, u32, u32)>> {
    match source {
        Some(s) if s.kind == "image" => Ok(s.image_base64.as_deref().and_then(decode_image)),
        _ => {
            let Some(game) = super::game_window::find_game_window() else {
                return Ok(None);
            };
            let rect = rect_from_win32(game.rect);
            match source.as_ref().and_then(|s| s.at_ms) {
                Some(at) => match super::overlay_manual::frame_by_stamp(at, &rect) {
                    Some((rgba, w, h, _, _)) => Ok(Some((rgba, w, h))),
                    None => Err(anyhow!(
                        "the chosen capture is no longer available — pick an image again"
                    )),
                },
                None => Ok(super::overlay_manual::fresh_frame_for(&rect)
                    .map(|(rgba, w, h, _, _)| (rgba, w, h))),
            }
        },
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_reference_frame(
    source: &Option<wowsp_tauri_shared::ManualLocateSource>,
) -> anyhow::Result<Option<(Vec<u8>, u32, u32)>> {
    match source {
        Some(s) if s.kind == "image" => Ok(s.image_base64.as_deref().and_then(decode_image)),
        _ => Ok(None),
    }
}

/// Decode a base64 image into raw RGBA (shared with the picker's
/// custom-image context in `overlay::manual`).
pub(super) fn decode_image(b64: &str) -> Option<(Vec<u8>, u32, u32)> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    (w > 0 && h > 0).then(|| (img.into_raw(), w, h))
}

/// Scale a band measured on a reference frame (working px of THAT frame)
/// into the entry window's working px.
fn scale_band(b: HeaderBand, frame_w: u32, fx: f32, fy: f32, entry_w: i32) -> HeaderBand {
    let frame_scale = frame_w.div_ceil(MAX_WORK_WIDTH).max(1) as f32;
    let entry_scale = (entry_w.max(1) as u32).div_ceil(MAX_WORK_WIDTH).max(1) as f32;
    let conv_x = |v: usize| (((v as f32 * frame_scale * fx) / entry_scale).round() as usize).max(1);
    let conv_y = |v: usize| (((v as f32 * frame_scale * fy) / entry_scale).round() as usize).max(1);
    let green = (
        conv_x(b.green.0),
        conv_x(b.green.0) + conv_x(b.green.1 - b.green.0),
    );
    let red = b.red.map(|(r0, r1)| {
        let w = conv_x(r1.saturating_sub(r0));
        (conv_x(r0), conv_x(r0) + w)
    });
    HeaderBand {
        top: conv_y(b.top),
        height: conv_y(b.height).max(2),
        green,
        red,
    }
}

/// Approximate band for a hand-drawn rect the reference frame could not
/// detect a table on: the header is assumed to sit at the rect's top with
/// the bar split at the team seam. Verify will accept or retire it. The
/// working-px scale comes from the ENTRY WINDOW's width — the same space
/// `verify_header_band` measures in — NOT the rect's (a table-relative
/// scale put the synthetic band at ~2x the real bars and doomed the entry
/// to instant retirement).
fn synthetic_band(sel: &Rect, split: f32, team_sizes: (usize, usize), entry_w: i32) -> HeaderBand {
    let entry_scale = (entry_w.max(1) as u32).div_ceil(MAX_WORK_WIDTH).max(1) as f32;
    let to_work = |v: i32| ((v as f32 / entry_scale).round() as usize).max(1);
    let rows = team_sizes.0.max(team_sizes.1).max(1);
    let pitch = sel.height as f32 / rows as f32;
    let split = if split >= 0.999 { 1.0 } else { split };
    let green_w = ((sel.width as f32 * split) / entry_scale).round() as usize;
    let x0 = to_work(sel.x);
    let red = if split >= 0.999 {
        None
    } else {
        Some((
            x0 + green_w,
            x0 + green_w + ((sel.width as f32 * (1.0 - split)) / entry_scale).round() as usize,
        ))
    };
    HeaderBand {
        top: to_work(sel.y),
        height: (((pitch * 0.25) / entry_scale).round() as usize).max(2),
        green: (x0, x0 + green_w),
        red,
    }
}

/// The watcher FSM's calibration state: which client's file is loaded,
/// the latest screen fingerprint, the battle class the in-memory geometry
/// cache belongs to, and the per-press vote flag. Only the watcher thread
/// touches it (inside [`super::watch::WatchFsm`]) — no locking needed —
/// EXCEPT that the settings calibration editor (`set_calibration_anchor`)
/// writes the same file from the Tauri async runtime. Every mutating pass
/// therefore re-checks the file's modification stamp first and reloads
/// when the editor wrote in between, so a watcher save can never clobber
/// a hand-drawn entry with its own stale copy (the residual race window —
/// an editor write landing between the check and the watcher's own rename
/// — is milliseconds and self-heals on the next pass).
#[derive(Default)]
pub(super) struct CalibrationCtx {
    /// Modification stamp of the file the in-memory store was loaded
    /// from; `None` until a load ran (or when the file did not exist).
    disk_stamp: Option<std::time::SystemTime>,
    /// Install-identity key of the loaded store; `None` until a game
    /// window resolved (and when even the appdata root is unavailable —
    /// the store then runs memory-only and never certifies).
    pub client_key: Option<String>,
    /// Path of the loaded client's file.
    path: Option<PathBuf>,
    /// The loaded store.
    pub store: ClientCalibration,
    /// Latest monitor-configuration fingerprint.
    pub screen: String,
    /// Battle class the in-memory geometry cache + streak belong to.
    pub cache_class: Option<BattleClass>,
    /// Whether the CURRENT Tab press already cast its vote (one vote per
    /// press episode — a long hold must not certify itself).
    pub hold_counted: bool,
}

impl CalibrationCtx {
    /// Point the store at a client, loading its file. No-op when the
    /// client is already bound; a failing appdata root leaves the store
    /// empty and unbound (uncached detection, no certification).
    pub(super) fn bind_client(&mut self, client_key: &str) {
        if self.client_key.as_deref() == Some(client_key) {
            return;
        }
        self.client_key = Some(client_key.to_string());
        self.cache_class = None;
        match crate::paths::data_dir() {
            Ok(dir) => {
                let path = client_file_path(&dir, client_key);
                self.store = load(&path);
                self.disk_stamp = file_stamp(&path);
                self.path = Some(path);
            },
            Err(_) => {
                self.store = ClientCalibration::default();
                self.disk_stamp = None;
                self.path = None;
            },
        }
    }

    /// Re-read the bound client's file from disk (the settings calibration
    /// editor wrote it behind the watcher's back — see
    /// `WatchCommand::CalibrationStoreChanged`).
    pub(super) fn force_reload(&mut self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        self.store = load(&path);
        self.disk_stamp = file_stamp(&path);
    }

    /// Reload the store when the file changed on disk since the last
    /// load — called at the top of every mutating pass (see the struct
    /// docs for the editor-writer coordination).
    fn sync_with_disk(&mut self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        let stamp = file_stamp(&path);
        if stamp != self.disk_stamp {
            self.store = load(&path);
            self.disk_stamp = stamp;
        }
    }

    /// Save and record the new on-disk stamp as OURS.
    fn persist(&mut self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        save(&path, &self.store);
        self.disk_stamp = file_stamp(&path);
    }

    /// Assemble the live identity for a capture, or `None` while no
    /// battle class / client is resolved yet (calibration inactive).
    pub(super) fn live_key(
        &self,
        class: BattleClass,
        kind: &GameInstallKind,
        origin: (i32, i32),
        size: (i32, i32),
        style_bits: u64,
    ) -> Option<LiveKey> {
        Some(LiveKey {
            class,
            kind: *kind,
            client_key: self.client_key.clone()?,
            origin,
            size,
            style_bits,
            screen: self.screen.clone(),
        })
    }

    /// Whether the live geometry's entry is CERTIFIED — the watcher's
    /// signal to stand down its periodic anchor revalidations.
    pub(super) fn certified(&self, key: &LiveKey) -> bool {
        self.store
            .entry(key.class)
            .is_some_and(|e| entry_matches_strict(e, key) && e.certified())
    }

    /// Cast the current press's STABLE vote: a detection pass confirmed
    /// the cached band at the live geometry. One vote per press episode;
    /// a SUSPECT entry never accumulates votes (its geometry already
    /// failed verification and waits to be re-measured); a
    /// geometry-identical entry at a DIFFERENT origin re-baselines there
    /// with this press as the first vote (the window moved — detection
    /// re-arms until the new position proves itself too).
    pub(super) fn note_stable(&mut self, key: &LiveKey) {
        if self.hold_counted {
            return;
        }
        self.hold_counted = true;
        if self.path.is_none() {
            return;
        }
        self.sync_with_disk();
        let class = key.class;
        // (streak re-baselined at a moved origin, new press count) — the
        // borrow ends before the disk write below.
        let outcome = {
            let Some(entry) = self.store.entry_mut(class) else {
                return;
            };
            if entry.suspect || !entry_matches_geometry(entry, key) {
                return;
            }
            if origin_within_jitter(entry.origin, key.origin) {
                let before = entry.stable_presses;
                entry.stable_presses = entry
                    .stable_presses
                    .saturating_add(1)
                    .min(STABLE_PRESSES_TO_CERTIFY);
                (entry.stable_presses != before).then_some((false, entry.stable_presses))
            } else {
                entry.origin = key.origin;
                entry.stable_presses = 1;
                Some((true, 1))
            }
        };
        if let Some((moved, presses)) = outcome {
            self.persist();
            if moved {
                tracing::info!(
                    class = ?class,
                    "anchor calibration: window moved — streak re-baselined at the new position"
                );
            } else {
                tracing::debug!(
                    class = ?class,
                    stable_presses = presses,
                    "anchor calibration: stable press recorded"
                );
            }
        }
    }

    /// Store a FRESH detection's geometry (the full scan ran and found the
    /// table): the entry takes the live identity wholesale and the streak
    /// restarts — this press established the geometry, the next ones vote
    /// on it. (The settings editor's hand-drawn entries are written to
    /// disk directly by `set_calibration_anchor` and reach the watcher via
    /// `WatchCommand::CalibrationStoreChanged`'s file reload — never
    /// through here.)
    pub(super) fn note_geometry(
        &mut self,
        key: &LiveKey,
        band: HeaderBand,
        roster: DetectedRoster,
        team_sizes: (usize, usize),
        profile: StoredProfile,
    ) {
        if self.path.is_none() {
            return;
        }
        self.sync_with_disk();
        let entry = AnchorEntry {
            kind: key.kind,
            client_key: key.client_key.clone(),
            origin: key.origin,
            size: key.size,
            style_bits: key.style_bits,
            screen: key.screen.clone(),
            band: band.into(),
            roster: roster.into(),
            team_sizes,
            profile,
            stable_presses: 0,
            suspect: false,
            manual: false,
        };
        *self.store.entry_mut(key.class) = Some(entry);
        self.persist();
        tracing::info!(class = ?key.class, "anchor calibration: fresh geometry stored");
    }

    /// Record INSTABILITY — the cached band kept failing verification. The
    /// entry is kept but marked SUSPECT: it no longer seeds the geometry
    /// cache or certifies (both would re-buy the failed verifies), while
    /// its proportions remain available to the remap fallback — a
    /// hand-drawn or historically measured layout is still the best
    /// proportional prior when detection cannot run at all.
    pub(super) fn note_unstable(&mut self, key: &LiveKey) {
        if self.path.is_none() {
            return;
        }
        self.sync_with_disk();
        let slot = self.store.entry_mut(key.class);
        if slot
            .as_ref()
            .is_some_and(|e| entry_matches_geometry(e, key) && !e.suspect)
        {
            let entry = slot.as_mut().expect("checked above");
            entry.suspect = true;
            entry.stable_presses = 0;
            self.persist();
            tracing::info!(
                class = ?key.class,
                "anchor calibration: entry marked suspect — geometry kept for the remap fallback only"
            );
        }
    }

    /// Proportional remap of the class's stored geometry onto the CURRENT
    /// window — the persistent-failure fallback (detection keeps failing,
    /// or its result was vetoed): the stored band/roster proportions scale
    /// per-axis onto the live window, so the hint at least lands where the
    /// table historically sits. Suspect entries are still usable here —
    /// their PROPORTIONS are exactly what survives a failed verification.
    pub(super) fn remap_geometry(
        &self,
        class: BattleClass,
        kind: &GameInstallKind,
        size: (i32, i32),
        team_sizes: (usize, usize),
    ) -> Option<(wowsp_tauri_shared::Rect, Vec<i32>, f32)> {
        let entry = self.store.entry(class)?;
        if entry.kind != *kind || entry.size.0 <= 0 || entry.size.1 <= 0 {
            return None;
        }
        let (fx, fy) = (
            size.0 as f32 / entry.size.0 as f32,
            size.1 as f32 / entry.size.1 as f32,
        );
        let src = &entry.roster.rect;
        let rect = wowsp_tauri_shared::Rect {
            x: (src.x as f32 * fx).round() as i32,
            y: (src.y as f32 * fy).round() as i32,
            width: ((src.width as f32 * fx).round() as i32).max(1),
            height: ((src.height as f32 * fy).round() as i32).max(1),
        };
        // Row grid: with the same team shape, scale the stored centers
        // relative to the table's top edge; with a different shape,
        // re-spread the blocks evenly over the remapped rect (the manual
        // anchor's row math — two side-by-side blocks, the taller one
        // fills the box).
        let rows = if entry.team_sizes == team_sizes {
            entry
                .roster
                .row_centers
                .iter()
                .map(|c| (src.y as f32 + (*c as f32 - src.y as f32) * fy).round() as i32)
                .collect()
        } else {
            let tallest = team_sizes.0.max(team_sizes.1).max(1) as f32;
            let pitch = rect.height as f32 / tallest;
            let mut rows = Vec::with_capacity(team_sizes.0 + team_sizes.1);
            for count in [team_sizes.0, team_sizes.1] {
                for i in 0..count {
                    rows.push(rect.y + (pitch * (i as f32 + 0.5)).round() as i32);
                }
            }
            rows
        };
        Some((rect, rows, entry.roster.team_split))
    }

    /// Seed value for the in-memory geometry cache: the stored entry's
    /// cache fields when its window mode matches the live one. Suspect
    /// entries never seed (their band is the one that kept failing).
    pub(super) fn seed_geometry(
        &self,
        class: BattleClass,
        kind: &GameInstallKind,
        size: (i32, i32),
        style_bits: u64,
    ) -> Option<(HeaderBand, DetectedRoster, (usize, usize), DetectProfile)> {
        let entry = self.store.entry(class)?;
        if entry.suspect
            || entry.kind != *kind
            || entry.size != size
            || entry.style_bits != style_bits
        {
            return None;
        }
        Some((
            entry.band.into(),
            entry.roster.clone().into(),
            entry.team_sizes,
            entry.profile.resolve(kind),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(class: BattleClass) -> LiveKey {
        LiveKey {
            class,
            kind: GameInstallKind::Wargaming,
            client_key: "d:\\games\\world of warships".into(),
            origin: (0, 0),
            size: (2560, 1440),
            style_bits: 0x1234,
            screen: "2560x1440@0,0".into(),
        }
    }

    fn entry(key: &LiveKey, stable_presses: u32) -> AnchorEntry {
        AnchorEntry {
            kind: key.kind,
            client_key: key.client_key.clone(),
            origin: key.origin,
            size: key.size,
            style_bits: key.style_bits,
            screen: key.screen.clone(),
            band: StoredBand {
                top: 40,
                height: 14,
                green: (300, 500),
                red: Some((502, 700)),
            }
            .into(),
            roster: StoredRoster {
                rect: wowsp_tauri_shared::Rect {
                    x: 300,
                    y: 40,
                    width: 400,
                    height: 600,
                },
                row_centers: vec![100, 150, 200],
                team_split: 0.5,
            }
            .into(),
            team_sizes: (7, 7),
            profile: StoredProfile::Kind,
            stable_presses,
            suspect: false,
            manual: false,
        }
    }

    fn ctx_with_entry(key: &LiveKey, stable_presses: u32) -> CalibrationCtx {
        let mut ctx = CalibrationCtx::default();
        ctx.client_key = Some(key.client_key.clone());
        ctx.path = Some(PathBuf::from("N:/nonexistent/ignored.toml"));
        *ctx.store.entry_mut(key.class) = Some(entry(key, stable_presses));
        ctx
    }

    #[test]
    fn battle_class_classification() {
        assert_eq!(BattleClass::classify(false, Some("pvp")), BattleClass::Pvp);
        assert_eq!(BattleClass::classify(false, None), BattleClass::Pvp);
        assert_eq!(
            BattleClass::classify(false, Some("ranked")),
            BattleClass::Pvp
        );
        assert_eq!(BattleClass::classify(false, Some("pve")), BattleClass::Pve);
        // Operations are PvE even when the match group is missing.
        assert_eq!(BattleClass::classify(true, None), BattleClass::Pve);
    }

    #[test]
    fn kind_names_round_trip() {
        for kind in [
            GameInstallKind::Wargaming,
            GameInstallKind::Steam,
            GameInstallKind::Lesta,
            GameInstallKind::Cn360,
            GameInstallKind::CnKongzhong,
            GameInstallKind::Manual,
        ] {
            assert_eq!(kind_from_name(kind_name(&kind)), Some(kind));
        }
        // The shared DTO's camelCase spelling parses too (the webui forwards
        // the install list's kind when pre-editing an empty entry).
        assert_eq!(
            kind_from_name("cnKongzhong"),
            Some(GameInstallKind::CnKongzhong)
        );
        assert_eq!(kind_from_name("unknown"), None);
    }

    #[test]
    fn placeholder_shapes_match_their_class() {
        // PvP pre-edits draw a two-team grid; PvE a single-team one — the
        // synthetic band keys its red half off the split, so the pair must
        // stay consistent.
        assert_eq!(placeholder_team_sizes(BattleClass::Pvp), (12, 12));
        assert_eq!(placeholder_team_split(BattleClass::Pvp), 0.5);
        assert_eq!(placeholder_team_sizes(BattleClass::Pve), (9, 0));
        assert!(placeholder_team_split(BattleClass::Pve) >= 0.999);
    }

    #[test]
    fn client_file_names_isolate_installs() {
        let a = client_file_name("d:\\games\\wows");
        let b = client_file_name("e:\\steamapps\\common\\world of warships");
        assert_ne!(a, b);
        assert!(a.ends_with(".toml"));
        for name in [a, b] {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.'),
                "sanitized name {name}"
            );
        }
        // A key with no alphanumeric content still yields a legal stem,
        // and distinct raw keys never collapse onto one file.
        assert_ne!(client_file_name("///"), client_file_name("\\\\\\"));
    }

    #[test]
    fn strict_match_requires_origin_but_tolerates_jitter() {
        let k = key(BattleClass::Pvp);
        let e = entry(&k, 0);
        let mut jittered = k.clone();
        jittered.origin = (3, -4);
        assert!(entry_matches_strict(&e, &jittered));
        let mut moved = k.clone();
        moved.origin = (40, 0);
        assert!(!entry_matches_strict(&e, &moved));
        // The geometry match stays origin-blind.
        assert!(entry_matches_geometry(&e, &moved));
    }

    #[test]
    fn geometry_match_keys_on_everything_else() {
        let k = key(BattleClass::Pvp);
        let e = entry(&k, 0);
        for mutated in [
            LiveKey {
                kind: GameInstallKind::Lesta,
                ..k.clone()
            },
            LiveKey {
                client_key: "e:\\other".into(),
                ..k.clone()
            },
            LiveKey {
                size: (1920, 1080),
                ..k.clone()
            },
            LiveKey {
                style_bits: 99,
                ..k.clone()
            },
            LiveKey {
                screen: "1920x1080@0,0".into(),
                ..k.clone()
            },
        ] {
            assert!(
                !entry_matches_geometry(&e, &mutated),
                "mutation must break the geometry match"
            );
        }
        // The battle class selects a different entry, not a mismatch.
        let pve = key(BattleClass::Pve);
        assert!(!entry_matches_geometry(&e, &pve) || pve.client_key == e.client_key);
    }

    #[test]
    fn stable_presses_certify_after_threshold_votes() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, 0);
        for expected in 1..=STABLE_PRESSES_TO_CERTIFY {
            ctx.hold_counted = false; // a new Tab press
            ctx.note_stable(&k);
            assert_eq!(
                ctx.store.entry(BattleClass::Pvp).unwrap().stable_presses,
                expected
            );
        }
        assert!(ctx.certified(&k));
        // Extra presses neither overflow the counter nor re-vote within
        // one press episode.
        ctx.hold_counted = false;
        ctx.note_stable(&k);
        assert_eq!(
            ctx.store.entry(BattleClass::Pvp).unwrap().stable_presses,
            STABLE_PRESSES_TO_CERTIFY
        );
        ctx.note_stable(&k);
        assert_eq!(
            ctx.store.entry(BattleClass::Pvp).unwrap().stable_presses,
            STABLE_PRESSES_TO_CERTIFY
        );
    }

    #[test]
    fn one_vote_per_press_episode() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, 0);
        ctx.note_stable(&k);
        ctx.note_stable(&k);
        assert_eq!(ctx.store.entry(BattleClass::Pvp).unwrap().stable_presses, 1);
        // The key coming up re-arms the vote.
        ctx.hold_counted = false;
        ctx.note_stable(&k);
        assert_eq!(ctx.store.entry(BattleClass::Pvp).unwrap().stable_presses, 2);
    }

    #[test]
    fn moved_window_rebaselines_the_streak() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, STABLE_PRESSES_TO_CERTIFY);
        assert!(ctx.certified(&k));
        ctx.hold_counted = false;
        let mut moved = k.clone();
        moved.origin = (600, 200);
        // Not certified at the new origin…
        assert!(!ctx.certified(&moved));
        // …and the first stable press there re-baselines.
        ctx.note_stable(&moved);
        let e = ctx.store.entry(BattleClass::Pvp).unwrap();
        assert_eq!(e.origin, (600, 200));
        assert_eq!(e.stable_presses, 1);
    }

    #[test]
    fn fresh_detection_replaces_geometry_and_restarts_the_streak() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, STABLE_PRESSES_TO_CERTIFY);
        let mut resized = k.clone();
        resized.size = (1920, 1080);
        let band = HeaderBand {
            top: 30,
            height: 12,
            green: (200, 400),
            red: None,
        };
        let roster = DetectedRoster {
            rect: wowsp_tauri_shared::Rect {
                x: 200,
                y: 30,
                width: 200,
                height: 400,
            },
            row_centers: vec![80, 120],
            team_split: 1.0,
        };
        ctx.note_geometry(
            &resized,
            band,
            roster.clone(),
            (7, 0),
            StoredProfile::WgNext,
        );
        let e = ctx.store.entry(BattleClass::Pvp).unwrap();
        assert_eq!(e.size, (1920, 1080));
        assert_eq!(e.stable_presses, 0);
        assert_eq!(e.team_sizes, (7, 0));
        assert_eq!(e.profile, StoredProfile::WgNext);
        assert_eq!(e.roster.row_centers, roster.row_centers);
        assert!(!ctx.certified(&resized));
    }

    #[test]
    fn instability_suspects_only_the_matching_entry() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, STABLE_PRESSES_TO_CERTIFY);
        let other = key(BattleClass::Pve);
        *ctx.store.entry_mut(BattleClass::Pve) = Some(entry(&other, 0));
        ctx.note_unstable(&k);
        // The geometry is KEPT (it feeds the remap fallback) but suspect:
        // not certified, never re-seeded, never re-voted.
        let e = ctx.store.entry(BattleClass::Pvp).expect("entry kept");
        assert!(e.suspect);
        assert_eq!(e.stable_presses, 0);
        assert!(!ctx.certified(&k));
        assert!(
            !ctx.seed_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Wargaming,
                (2560, 1440),
                0x1234
            )
            .is_some()
        );
        assert!(!ctx.store.entry(BattleClass::Pve).unwrap().manual);
        ctx.hold_counted = false;
        ctx.note_stable(&k);
        assert_eq!(
            ctx.store.entry(BattleClass::Pvp).unwrap().stable_presses,
            0,
            "a suspect entry never accumulates votes"
        );
        // A repeated unstable note on an already-suspect entry is a no-op,
        // and so is one with no stored entry at all.
        ctx.note_unstable(&k);
    }

    #[test]
    fn remap_falls_back_to_stored_proportions() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, 0);
        // Same team shape, window halved: the stored rect scales per-axis.
        let (rect, rows, split) = ctx
            .remap_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Wargaming,
                (1280, 720),
                (7, 7),
            )
            .expect("remap from the stored entry");
        assert_eq!(split, 0.5);
        assert_eq!(rect.width, 200, "the stored 400 px table halves");
        assert_eq!(rect.x, 150, "the stored x=300 halves");
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0], 70,
            "row y=100, kept relative to the table top y=40 at half scale"
        );
        // A different team shape re-spreads the blocks over the rect.
        let (_, rows7, _) = ctx
            .remap_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Wargaming,
                (2560, 1440),
                (9, 9),
            )
            .expect("remap with a different shape");
        assert_eq!(rows7.len(), 18);
        // Suspect entries still remap — that is their one remaining job.
        ctx.note_unstable(&k);
        assert!(
            ctx.remap_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Wargaming,
                (1280, 720),
                (7, 7)
            )
            .is_some()
        );
        // A different client kind never remaps (per-client isolation), and
        // a class with no entry has nothing to remap.
        assert!(
            ctx.remap_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Lesta,
                (1280, 720),
                (7, 7)
            )
            .is_none()
        );
        assert!(
            ctx.remap_geometry(
                BattleClass::Pve,
                &GameInstallKind::Wargaming,
                (1280, 720),
                (7, 7)
            )
            .is_none()
        );
    }

    #[test]
    fn manual_entries_start_certified() {
        let k = key(BattleClass::Pvp);
        let mut ctx = ctx_with_entry(&k, 0);
        // The settings editor's write path (set_calibration_anchor) marks
        // the entry manual + certified; model the same fields here.
        {
            let slot = ctx.store.entry_mut(BattleClass::Pvp);
            let e = slot.as_mut().expect("entry exists");
            e.manual = true;
            e.stable_presses = STABLE_PRESSES_TO_CERTIFY;
        }
        let e = ctx.store.entry(BattleClass::Pvp).unwrap();
        assert!(e.manual);
        assert!(e.certified(), "a hand-drawn entry starts certified");
        assert!(ctx.certified(&k));
        // It still suspects like any measured entry when its band fails.
        ctx.note_unstable(&k);
        assert!(!ctx.certified(&k));
    }

    #[test]
    fn seed_geometry_requires_window_mode_match() {
        let k = key(BattleClass::Pvp);
        let ctx = ctx_with_entry(&k, 0);
        assert!(
            ctx.seed_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Wargaming,
                (2560, 1440),
                0x1234
            )
            .is_some()
        );
        assert!(
            ctx.seed_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Wargaming,
                (1920, 1080),
                0x1234
            )
            .is_none()
        );
        assert!(
            ctx.seed_geometry(
                BattleClass::Pvp,
                &GameInstallKind::Lesta,
                (2560, 1440),
                0x1234
            )
            .is_none()
        );
        // The other battle class has no entry here.
        assert!(
            ctx.seed_geometry(
                BattleClass::Pve,
                &GameInstallKind::Wargaming,
                (2560, 1440),
                0x1234
            )
            .is_none()
        );
    }

    #[test]
    fn store_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-calibration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = client_file_path(&dir, "d:\\games\\wows");
        let k = key(BattleClass::Pvp);
        let mut cal = ClientCalibration::default();
        *cal.entry_mut(BattleClass::Pvp) = Some(entry(&k, 2));
        save(&path, &cal);
        assert_eq!(load(&path), cal);
        // A corrupt file degrades to an empty store instead of erroring.
        std::fs::write(&path, "not = [a toml document").unwrap();
        assert_eq!(load(&path), ClientCalibration::default());
        // A missing file too.
        let missing = dir.join("missing.toml");
        assert_eq!(load(&missing), ClientCalibration::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The editor's band conversions must land in the ENTRY WINDOW's
    /// working-px space (window width / ceil(w/800)) — a table-relative or
    /// frame-relative scale put synthetic bands at ~2x the real bars.
    #[test]
    fn editor_bands_land_in_the_entry_working_space() {
        // A 1280-wide reference frame (working scale 2) carrying a band at
        // working (150..450) green, scaled onto a 2560-wide entry window
        // (working scale 4, fx = fy = 2): frame-native 300..900 → entry
        // working 150..450.
        let scaled = scale_band(
            HeaderBand {
                top: 10,
                height: 7,
                green: (150, 450),
                red: Some((452, 640)),
            },
            1280,
            2.0,
            2.0,
            2560,
        );
        assert_eq!(scaled.green, (150, 450));
        assert_eq!(scaled.red, Some((452, 640)));
        assert_eq!(scaled.top, 10);
        assert_eq!(scaled.height, 7);

        // The synthetic band derives from the drawn rect directly in the
        // entry window's space: a 1280-wide rect at x=640 in a 2560 window
        // (scale 4) starts at working x=160 and halves for the seam.
        let sel = Rect {
            x: 640,
            y: 440,
            width: 1280,
            height: 640,
        };
        let synth = synthetic_band(&sel, 0.5, (7, 7), 2560);
        assert_eq!(synth.green.0, 160);
        assert_eq!(synth.green.1 - synth.green.0, 160, "half the table width");
        assert!(synth.red.is_some(), "a two-team split draws the red bar");
        assert_eq!(synth.top, 110);
        assert!(synth.height >= 2);

        // The single-team PvE layout draws no red bar.
        let pve = synthetic_band(&sel, 1.0, (7, 0), 2560);
        assert!(pve.red.is_none());
        assert_eq!(pve.green.1 - pve.green.0, 320, "the whole table width");
    }

    #[test]
    fn profile_selection_round_trips() {
        assert_eq!(
            StoredProfile::of(&DetectProfile::WG_NEXT),
            StoredProfile::WgNext
        );
        for kind in [
            GameInstallKind::Wargaming,
            GameInstallKind::Steam,
            GameInstallKind::Lesta,
            GameInstallKind::Cn360,
            GameInstallKind::CnKongzhong,
            GameInstallKind::Manual,
        ] {
            let base = DetectProfile::for_kind(&kind);
            assert_eq!(StoredProfile::of(&base), StoredProfile::Kind);
            assert_eq!(StoredProfile::Kind.resolve(&kind), base);
        }
        assert_eq!(
            StoredProfile::WgNext.resolve(&GameInstallKind::Steam),
            DetectProfile::WG_NEXT
        );
    }
}
