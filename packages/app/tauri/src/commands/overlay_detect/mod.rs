//! Team-list (roster) region detector for the in-game overlay (Mode 2 / M8).
//!
//! Pure image analysis over an RGBA screenshot of the game window — no Win32
//! types in here, so the whole pipeline is unit-testable against synthetic
//! frames and a real captured frame (see the tests at the bottom).
//!
//! The detector is HEADER-ANCHORED: the vanilla Tab table always opens with
//! two solid team-header bars — teal-green "我的团队" on the left, brick-red
//! "敌军" on the right — and each player row below carries near-white name
//! text. Those cues survive every scene: the table itself is translucent, so
//! on bright maps its rows read LIGHT (luma ≈ 125) and any dark-projection
//! approach misfires, while the saturated header bars stay recognisable in
//! both the normal and the Tab-dimmed frame. Measured on a real 1440p
//! client (see `testdata/tab_table_768x480.png`):
//!
//!   header green ≈ rgb(81, 148, 140)   — TEAL: blue ≈ green, not far under
//!   header red   ≈ rgb(167, 121, 114)  — muted brick, r−g ≈ 46
//!   bar width    ≈ 24% of the frame each, seam exactly between them
//!   row text     ≈ pure white, row pitch ≈ 0.95× the bar height
//!
//! PVE modes that roster a SINGLE team (scenarios / co-op / operations)
//! draw a variant of that header: ONE teal bar — captioned "my team", NO
//! brick bar to its right — centered on the frame. Its width varies by
//! client generation: an older wide variant spans ~55-65% of the frame,
//! while the WG client's current operation table measures only ~23-24%
//! (see `testdata/tab_table_pve_800x500.png`, a real Tab-held capture).
//! The band locator accepts that green-only shape under extra gates (a
//! width window — the wide variant anywhere, the narrow one only
//! dead-centered — plus a white-row-text check below the bar; see
//! [`find_header_band`]); such a band reports `team_split` exactly 1.0 and
//! emits an ally-rows-only grid.
//!
//! Pipeline: find the row carrying the bars — both bars hugging the seam,
//! or, single-team PVE only, a lone green bar after the width + centering +
//! row-text gates (a red bar FARTHER than the adjacency gap rejects the
//! scan row outright, so mod scoreboards never degrade into green-only
//! hits) → bar spans give the table rectangle and the team split →
//! white-text density bands below the header give the player rows (extended
//! with the median pitch when the arena hint asks for more rows than were
//! visible). Position-agnostic on purpose, so scenario / co-op layouts
//! anchor just as well as random battles.

use wowsp_tauri_shared::{GameInstallKind, Rect};

/// Downscaled working width — caps the analysis cost on QHD/4K captures.
const MAX_WORK_WIDTH: u32 = 800;
/// Vertical band (fractions of the capture height) scanned for the header
/// row. The real table's bars sit at ~23%; pre-battle screens never render
/// them at all.
const HEADER_SCAN_TOP_FRAC: f32 = 0.06;
const HEADER_SCAN_BOTTOM_FRAC: f32 = 0.55;
/// Each header bar must span at least this fraction of the working width —
/// the real bars are ~24% each, water horizons and stray UI stay far below.
const HEADER_MIN_RUN_FRAC: f32 = 0.06;
/// Absolute floor (working px) for the same run, so tiny captures stay sane.
const HEADER_MIN_RUN_PX: usize = 8;
/// The header band must be at least this many consecutive hit rows thick
/// (the real bars are ~14 working px tall; stray same-colored bands —
/// water horizons, mod UI — don't stack that thick).
const HEADER_MIN_ROWS: usize = 3;
/// Maximum horizontal gap between the green bar's right edge and the red
/// bar's left edge (fraction of working width). The real bars hug the table
/// seam (gap ≈ 2 px); the mod scoreboard's corner bars are ~35% apart.
const HEADER_MAX_BAR_GAP_FRAC: f32 = 0.15;
/// Minimum width (fraction of the working width) for a GREEN-ONLY header
/// candidate of the WIDE variant — position-agnostic. The wide single-team
/// bar spans ~55-65% of the frame, comfortably above this floor, while a
/// lone PVP bar is ~24% and mods' corner bars are smaller still. The
/// narrow variant below covers the rest. Two-bar bands are NOT width-gated:
/// their adjacency + pair signature already suffices.
const GREEN_ONLY_MIN_W_FRAC: f32 = 0.30;
/// Minimum width for a GREEN-ONLY candidate of the NARROW variant — the
/// current WG operation table's bar measures ~23-24% of the frame (a real
/// 2000-px capture, `tab_table_pve_800x500.png`); the floor leaves room
/// for shrinkage on other aspect ratios without admitting mod corner bars.
/// Narrow candidates must additionally sit dead-centered (below).
const GREEN_ONLY_NARROW_MIN_W_FRAC: f32 = 0.15;
/// Maximum distance between the NARROW green-only bar's center and the
/// frame center (fraction of the working width). The operation table's
/// panel is centered on the game window (measured center 50.0-50.2% on real
/// captures — offset ≈ 0), which is what separates its ~24% bar from a lone
/// PVP green bar of the SAME width: the ally half of a centered two-bar
/// table spans its left side, so its center sits T/4 (a quarter of the
/// TABLE width) left of the frame center — measured 0.1211 of the frame on
/// the real PVP fixture, i.e. uncomfortably close to any gate above ~0.09.
/// 0.08 keeps a ~32-working-px rejection margin on that geometry while the
/// operation table keeps a ~64-px acceptance margin. Mod scoreboards'
/// corner bars sit even farther out (< 15% / > 85%).
const GREEN_ONLY_MAX_CENTER_OFF_FRAC: f32 = 0.08;
/// Header-bar height bounds in working px (the real bar is ~14 px at 800-wide).
const HEADER_MIN_H: usize = 4;
/// White-text density bands below 22% of the row peak are noise (e.g. our
/// own hint box, which GDI captures include as a layered window).
const ROW_TEXT_FRACTION: f32 = 0.22;
/// A text band shorter than this (working px) is anti-aliasing, not a row.
const ROW_BAND_MIN_H: usize = 2;
/// Vertical range below the header scanned for the white-text profile used
/// by the phase refinement.
const ROW_SCAN_MAX_SPAN_FRAC: f32 = 0.45;
/// Minimum rows of height the overlay window always gets, even when the
/// current roster is smaller (12v12 is the largest standard battle; extra
/// window height is invisible — transparent, click-through — but a short
/// window would clip the chips of a bigger table).
const MIN_WINDOW_ROWS: f32 = 12.0;

mod anchor;
mod band;
mod pixel;
mod profile;
mod roster;
mod scene;
mod strip;

#[cfg(test)]
mod tests;

// Items consumed through direct `overlay_detect::...` paths by the
// `commands::overlay` stack (call sites unchanged).
pub(crate) use anchor::{anchor_meaningfully_moved, build_anchor, fallback_roster};
pub(crate) use band::{
    HeaderBand, header_bars_present, measured_pitch_from_centers, rebuild_roster_from_band,
    verify_header_band,
};
pub(crate) use profile::DetectProfile;
pub(crate) use roster::{DetectedRoster, detect_roster, detect_roster_with_band};
pub(crate) use scene::{detect_battle_scene, probe_battle_scene};
pub(crate) use strip::{
    StripTable, StripThumb, crop_row_name_strips, read_row_alive, row_strip_alive, sink_victims,
    strip_max_luma, strip_thumb,
};

// Items used only by this module's own test suite (invisible to the non-test
// build, keeping `cargo clippy --lib -D warnings` quiet).
#[cfg(test)]
pub(crate) use anchor::{overlay_padding, overlay_padding_x};
#[cfg(test)]
pub(crate) use band::refine_roster_native;
#[cfg(test)]
pub(crate) use scene::is_probe_green;
#[cfg(test)]
pub(crate) use strip::{STRIP_MATCH_THRESHOLD, crop_rgba, row_name_strip_rect, thumb_similarity};
