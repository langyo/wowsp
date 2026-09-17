//! Row → player-name recognition pipeline for the overlay anchor.
//!
//! The in-game Tab panel sorts its rows with its own sort, so mapping roster
//! entries onto detected rows BY INDEX can pin stats onto the wrong player.
//! This module is the fix's backbone (PR 3a — architecture only):
//!
//!   1. CROP each detected row's name strip out of the captured frame
//!      (`overlay_detect::crop_row_name_strips` — pure geometry);
//!   2. RECOGNIZE the raw text in each strip through a pluggable engine;
//!   3. MATCH the texts against the arena roster's closed set, per team
//!      block (`row_match::assign_rows`);
//!   4. attach the resulting `row_players` to the anchor, keeping the
//!      `row_centers` order (allies block first, enemies after).
//!
//! Every step degrades to `None` on failure — the pipeline must never block
//! nor panic the Tab watcher, and when it yields nothing the anchor keeps
//! `row_players = None`, which the frontend reads as "fall back to the
//! historical index mapping" (default behavior, byte-identical to master).
//!
//! Engines implement [`RowRecognizer`]. PR 3a ships only the
//! [`NullRecognizer`] placeholder and the `WOWSP_ROW_RECOGNIZER` selection
//! plumbing; PR 3b lands the real engine (Windows OCR / RapidOCR) behind a
//! new env value and tunes the crop constants against the #372 tab dumps.
//! The pipeline stays FAST and IO-FREE while off: an unset env short-
//! circuits before any crop, and the one arena-file read happens only after
//! some text was actually recognized.

use std::sync::atomic::{AtomicBool, Ordering};

use wowsp_tauri_shared::{ArenaInfo, Rect, VehicleEntry};

use super::{arena_info, overlay_detect, row_match};

/// Environment variable selecting the row recognizer engine. Unset / empty =
/// off (the whole pipeline is skipped); `off` / `null` explicitly selects
/// the do-nothing placeholder; any other value warns once and stays off
/// until a real engine registers its own name (PR 3b).
const RECOGNIZER_ENV: &str = "WOWSP_ROW_RECOGNIZER";

/// One row-name recognition engine. Implementations receive the raw RGBA
/// crop of one row's name strip and return the text READ from it — raw and
/// unfiltered; matching against the roster is the matcher's job.
pub(crate) trait RowRecognizer: Send {
    fn recognize(&self, crop_rgba: &[u8], width: u32, height: u32) -> Option<String>;
}

/// The do-nothing engine: recognizes nothing, exists so the selection
/// plumbing, the crop path and the contract shape are exercised end to end
/// before a real OCR backend lands (PR 3b).
pub(crate) struct NullRecognizer;

impl RowRecognizer for NullRecognizer {
    fn recognize(&self, _crop_rgba: &[u8], _width: u32, _height: u32) -> Option<String> {
        None
    }
}

/// Warn-once latch for unknown engine values — an env typo must not spam
/// the log on every Tab capture.
static WARNED_UNKNOWN: AtomicBool = AtomicBool::new(false);

/// Pure engine selection from the raw env value (split from the env read so
/// tests never mutate process state — same pattern as tab_dump's gate).
/// `None` = pipeline off entirely.
fn select_recognizer(raw: Option<std::ffi::OsString>) -> Option<Box<dyn RowRecognizer>> {
    let raw = raw?;
    match raw.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "" => None,
        "off" | "null" => Some(Box::new(NullRecognizer)),
        other => {
            if !WARNED_UNKNOWN.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    engine = %other,
                    "unknown WOWSP_ROW_RECOGNIZER engine — row recognition stays off"
                );
            }
            None
        },
    }
}

/// The capture-side view of one detected table: everything the crop and
/// match steps need, in PHYSICAL px relative to the CAPTURE (game window)
/// origin — the exact values `detect_roster` emitted, before `build_anchor`
/// re-bases them to the overlay origin.
pub(crate) struct RowFrame<'a> {
    pub rgba: &'a [u8],
    pub width: u32,
    pub height: u32,
    /// Detected team-list rect (capture-relative).
    pub roster: &'a Rect,
    /// Detected row centers, allies block first (capture-relative).
    pub row_centers: &'a [i32],
    /// Allies/enemies split as a fraction of the roster width.
    pub team_split: f32,
    /// Ally-block row count THE GRID WAS BUILT WITH (the same
    /// `team_sizes.0` read the detector consumed). Single source of truth:
    /// the crop half-split AND the matcher's texts split both derive from
    /// this — never from a fresh atomic re-read or a roster relation count,
    /// which can disagree with the grid mid-battle.
    pub ally_rows: usize,
}

/// Run the full row → name pipeline for one capture and return the
/// `row_players` payload for the anchor, or `None` when recognition is off
/// or produced nothing. Called from `compute_anchor` with the DETECTED
/// (capture-relative) geometry, BEFORE `build_anchor` re-bases it to the
/// overlay origin.
///
/// Cost contract: with the env off this is one `var_os` read and nothing
/// else; the arena-file IO happens only after at least one row produced
/// text (i.e. never with the null engine).
pub(crate) fn recognize_row_players(frame: &RowFrame) -> Option<Vec<Option<String>>> {
    // Env gate FIRST — with no engine configured this is the whole function.
    let engine = select_recognizer(std::env::var_os(RECOGNIZER_ENV))?;
    let texts = recognize_texts(engine.as_ref(), frame);
    // No row produced any text → recognition yielded nothing usable at all:
    // the anchor keeps row_players = None and the frontend falls back to
    // the historical index mapping.
    if texts.iter().all(Option::is_none) {
        return None;
    }
    // The single arena read pays for itself only once text exists: matching
    // needs the closed set, and without it row text is unusable anyway.
    let (info, _) = arena_info::read_arena_snapshot()?;
    // From here the payload is Some(vec) — recognition RAN. Even when every
    // row then fails to match (an all-None vec) it stays Some: honest
    // silence ("nothing was recognized confidently") beats pinning stats by
    // the known-wrong index guess. A confidence gate that downgrades total
    // match failure back to None is a deliberate PR 3b follow-up.
    Some(row_match_blocks(&texts, &info, frame.ally_rows))
}

/// Crops + recognition only (steps 1–2): one raw text per row, `None` for
/// rows whose strip left the frame or read as nothing. Pure memory work.
fn recognize_texts(engine: &dyn RowRecognizer, frame: &RowFrame) -> Vec<Option<String>> {
    overlay_detect::crop_row_name_strips(
        frame.rgba,
        frame.width,
        frame.height,
        frame.roster,
        frame.row_centers,
        frame.team_split,
        frame.ally_rows,
    )
    .iter()
    .map(|strip| match strip {
        Some((buf, w, h)) => engine.recognize(buf, *w, *h),
        None => None,
    })
    .collect()
}

/// Match the recognized lines against the roster's closed set (step 3):
/// allies are matched within the relation ≤ 1 subset, enemies within the
/// relation > 1 subset. The BLOCK SPLIT is the ally count the detection
/// grid was built with (`ally_rows`, pinned by the caller from the same
/// `team_sizes` read the detector consumed) — NOT a fresh relation count
/// off the roster: roster file and atomic cache can be re-read at different
/// instants and disagree mid-battle, while the grid's count is what the row
/// geometry actually used. The roster subsets stay relation-filtered; a
/// disagreement with the grid is absorbed by the clamped split and by
/// `assign_rows` tolerating candidate/text count mismatches. Output is
/// aligned 1:1 with `texts` (== the anchor's `row_centers` order) and holds
/// the roster's own nickname strings, the frontend's exact cache keys.
fn row_match_blocks(
    texts: &[Option<String>],
    info: &ArenaInfo,
    ally_rows: usize,
) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = vec![None; texts.len()];
    if info.vehicles.is_empty() {
        return out;
    }
    let allies: Vec<VehicleEntry> = info
        .vehicles
        .iter()
        .filter(|v| v.relation <= 1)
        .cloned()
        .collect();
    let enemies: Vec<VehicleEntry> = info
        .vehicles
        .iter()
        .filter(|v| v.relation > 1)
        .cloned()
        .collect();
    let split = ally_rows.min(texts.len());
    for (i, name) in row_match::assign_rows(&texts[..split], &allies)
        .into_iter()
        .enumerate()
    {
        out[i] = name;
    }
    for (i, name) in row_match::assign_rows(&texts[split..], &enemies)
        .into_iter()
        .enumerate()
    {
        out[split + i] = name;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stub engine: reads a strip as bright/dark — `Some("bright")` for a
    /// mostly-white crop, `None` otherwise. Lets the tests verify WHICH
    /// rows get recognized without a real OCR backend.
    struct LumaStub;

    impl RowRecognizer for LumaStub {
        fn recognize(&self, crop_rgba: &[u8], _w: u32, _h: u32) -> Option<String> {
            let mean: u32 = crop_rgba
                .chunks_exact(4)
                .map(|p| u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2]))
                .sum::<u32>()
                / (crop_rgba.len() as u32 / 4).max(1)
                / 3;
            (mean > 100).then(|| "bright".to_string())
        }
    }

    /// Same synthetic table as the overlay_detect strip test: white name
    /// pixels painted only in the strips of rows 0 (ally) and 2 (enemy).
    fn frame_with_two_painted_names() -> (Vec<u8>, u32, u32, Rect, Vec<i32>) {
        let (w, h) = (1280u32, 720u32);
        let mut img = vec![20u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            img[i * 4 + 3] = 255;
        }
        let roster = Rect {
            x: 320,
            y: 160,
            width: 600,
            height: 300,
        };
        let rows = vec![220, 270, 220, 270];
        for row in [0usize, 2] {
            let r = overlay_detect::row_name_strip_rect(&roster, &rows, 0.5, 2, row).unwrap();
            for y in r.y..r.y + r.height {
                for x in r.x..r.x + r.width {
                    let i = ((y as u32 * w + x as u32) * 4) as usize;
                    img[i] = 240;
                    img[i + 1] = 240;
                    img[i + 2] = 240;
                }
            }
        }
        (img, w, h, roster, rows)
    }

    #[test]
    fn null_recognizer_never_recognizes() {
        assert!(NullRecognizer.recognize(&[255; 64], 4, 4).is_none());
        assert!(NullRecognizer.recognize(&[], 0, 0).is_none());
    }

    #[test]
    fn select_recognizer_env_gate() {
        // Unset / empty → off entirely.
        assert!(select_recognizer(None).is_none());
        assert!(select_recognizer(Some("".into())).is_none());
        assert!(select_recognizer(Some("   ".into())).is_none());
        // Explicit off / null → the placeholder engine is selected.
        assert!(select_recognizer(Some("off".into())).is_some());
        assert!(select_recognizer(Some("OFF".into())).is_some());
        assert!(select_recognizer(Some("null".into())).is_some());
        // Unknown values warn once and stay off.
        assert!(select_recognizer(Some("windows-ocr".into())).is_none());
        assert!(select_recognizer(Some("rapidocr".into())).is_none());
    }

    #[test]
    fn recognize_texts_only_fires_on_painted_rows() {
        let (img, w, h, roster, rows) = frame_with_two_painted_names();
        let frame = RowFrame {
            rgba: &img,
            width: w,
            height: h,
            roster: &roster,
            row_centers: &rows,
            team_split: 0.5,
            ally_rows: 2,
        };
        let texts = recognize_texts(&LumaStub, &frame);
        assert_eq!(texts.len(), 4);
        assert_eq!(texts[0].as_deref(), Some("bright"), "ally row 0 painted");
        assert_eq!(texts[2].as_deref(), Some("bright"), "enemy row 0 painted");
        assert!(texts[1].is_none(), "untouched ally row");
        assert!(texts[3].is_none(), "untouched enemy row");
    }

    #[test]
    fn row_match_blocks_split_follows_the_grid_count_not_the_roster() {
        // SF1 lock: the texts split uses the ally count the GRID was built
        // with, not a fresh relation count off the roster. The roster here
        // says 2 allies / 2 enemies, but the grid was built with 3 ally
        // rows — row 2 must therefore resolve inside the ALLY block.
        let info = ArenaInfo {
            match_group: None,
            date_time: None,
            map_name: None,
            vehicles: vec![
                VehicleEntry {
                    id: 1,
                    name: "AlphaOne".into(),
                    relation: 0,
                    ship_id: 0,
                    ship_name: None,
                },
                VehicleEntry {
                    id: 2,
                    name: "BravoTwo".into(),
                    relation: 1,
                    ship_id: 0,
                    ship_name: None,
                },
                VehicleEntry {
                    id: 3,
                    name: "CharlieThree".into(),
                    relation: 2,
                    ship_id: 0,
                    ship_name: None,
                },
                VehicleEntry {
                    id: 4,
                    name: "DeltaFour".into(),
                    relation: 2,
                    ship_id: 0,
                    ship_name: None,
                },
            ],
            raw: serde_json::Value::Null,
        };
        let texts = vec![
            Some("alphaone".to_string()),
            None,
            // Under a roster-count split (2) this row would land in the
            // ENEMY block and pin CharlieThree; with the grid's count it
            // must stay an unmatched ally row.
            Some("charliethree".to_string()),
            Some("deltafour".to_string()),
        ];
        let out = row_match_blocks(&texts, &info, 3);
        assert_eq!(out[0], Some("AlphaOne".into()));
        assert_eq!(out[1], None);
        assert_eq!(out[2], None, "row 2 belongs to the grid's ALLY block");
        assert_eq!(out[3], Some("DeltaFour".into()));
    }

    #[test]
    fn row_match_blocks_splits_teams_and_never_crosses_sides() {
        // The same nickname on BOTH teams: each row must resolve within its
        // own block — the closed set is per side, mirroring the frontend.
        let info = ArenaInfo {
            match_group: None,
            date_time: None,
            map_name: None,
            vehicles: vec![
                VehicleEntry {
                    id: 1,
                    name: "TwinName".into(),
                    relation: 0,
                    ship_id: 0,
                    ship_name: None,
                },
                VehicleEntry {
                    id: 2,
                    name: "AllyMate".into(),
                    relation: 1,
                    ship_id: 0,
                    ship_name: None,
                },
                VehicleEntry {
                    id: 3,
                    name: "TwinName".into(),
                    relation: 2,
                    ship_id: 0,
                    ship_name: None,
                },
                VehicleEntry {
                    id: 4,
                    name: "FoeMate".into(),
                    relation: 2,
                    ship_id: 0,
                    ship_name: None,
                },
            ],
            raw: serde_json::Value::Null,
        };
        let texts = vec![
            Some("foemate".to_string()),  // enemy text in an ALLY row slot…
            Some("twinname".to_string()), // ally block → ally TwinName
            Some("twinname".to_string()), // enemy block → enemy TwinName
            Some("allymate".to_string()), // …must not match the ally block
        ];
        // Grid count 2 agrees with the roster's relation count here.
        let out = row_match_blocks(&texts, &info, 2);
        // Ally rows resolve within the ally subset only: row 0's enemy text
        // is far from every ally name → unmatched.
        assert_eq!(out[0], None);
        assert_eq!(out[1], Some("TwinName".into()));
        // Enemy rows resolve within the enemy subset; the ally nickname's
        // text in an enemy row slot matches nothing over there.
        assert_eq!(out[2], Some("TwinName".into()));
        assert_eq!(out[3], None);
    }

    #[test]
    fn row_match_blocks_tolerates_empty_and_mismatched_inputs() {
        let empty = ArenaInfo {
            match_group: None,
            date_time: None,
            map_name: None,
            vehicles: vec![],
            raw: serde_json::Value::Null,
        };
        let texts = vec![Some("someone".into()), None];
        assert_eq!(row_match_blocks(&texts, &empty, 1), vec![None, None]);
        // All-unread texts → all None. Grid count beyond the roster's ally
        // count is clamped away by the matcher's own tolerance.
        let info = ArenaInfo {
            match_group: None,
            date_time: None,
            map_name: None,
            vehicles: vec![VehicleEntry {
                id: 1,
                name: "Solo".into(),
                relation: 0,
                ship_id: 0,
                ship_name: None,
            }],
            raw: serde_json::Value::Null,
        };
        assert_eq!(row_match_blocks(&[None, None], &info, 2), vec![None, None]);
    }
}
