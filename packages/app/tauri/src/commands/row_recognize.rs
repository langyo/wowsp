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
//! historical index mapping".
//!
//! Engines implement [`RowRecognizer`]. PR 3a shipped the selection plumbing
//! and the `WOWSP_ROW_RECOGNIZER` env; PR 3b added the real on-device engine
//! (`windows-ocr`, the OS-bundled Windows.Media.Ocr — see
//! [`row_ocr_windows`]), which is now the DEFAULT: recognition runs unless
//! the env explicitly opts out (`off` / `null`). The pipeline stays
//! IO-LIGHT: the one arena-file read happens only after some text was
//! actually recognized, and a disabled engine short-circuits before any
//! crop.

use std::sync::atomic::{AtomicBool, Ordering};

use wowsp_tauri_shared::{ArenaInfo, Rect, VehicleEntry};

use super::{arena_info, overlay_detect, row_match};

#[cfg(target_os = "windows")]
#[path = "row_ocr_windows.rs"]
mod row_ocr_windows;

/// Environment variable selecting the row recognizer engine. Unset / empty =
/// the DEFAULT engine (`windows-ocr`; off on non-Windows builds, where that
/// engine does not exist); `off` / `null` explicitly turns the pipeline off;
/// `windows-ocr` names the OS-bundled Windows.Media.Ocr engine (Windows
/// builds); any other value warns once and falls back to the default.
const RECOGNIZER_ENV: &str = "WOWSP_ROW_RECOGNIZER";

/// Parsed engine selection — pure and CHEAP (no engine construction), so
/// tests and the pending/catch-up machinery can ask "is recognition on?"
/// without ever building an OCR engine just to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecognizerKind {
    /// The OS-bundled Windows OCR engine.
    WindowsOcr,
    /// Off: the whole pipeline is skipped — `row_players` stays `None` and
    /// the frontend falls back to the historical index mapping.
    Off,
}

/// What every non-explicit env value resolves to: `windows-ocr` where the
/// engine exists, off on the other compile targets (the `row_ocr_windows`
/// module is cfg-gated to Windows).
#[cfg(target_os = "windows")]
const DEFAULT_RECOGNIZER: RecognizerKind = RecognizerKind::WindowsOcr;
#[cfg(not(target_os = "windows"))]
const DEFAULT_RECOGNIZER: RecognizerKind = RecognizerKind::Off;

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

/// Warn-once latch for "windows-ocr selected but the OS has no usable OCR
/// language pack" — the selection degrades to the null engine (the pipeline
/// keeps running and simply recognizes nothing) and says so exactly once.
static WARNED_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

/// Pure env parse (split from the engine CONSTRUCTION so tests never mutate
/// process state nor build an OCR engine — same pattern as tab_dump's gate).
fn recognizer_kind(raw: Option<&std::ffi::OsStr>) -> RecognizerKind {
    let Some(raw) = raw else {
        return DEFAULT_RECOGNIZER;
    };
    match raw.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "" => DEFAULT_RECOGNIZER,
        "off" | "null" => RecognizerKind::Off,
        // The real on-device engine. On non-Windows builds the constant is
        // Off: the name resolves to off there, exactly as before it existed.
        "windows-ocr" => DEFAULT_RECOGNIZER,
        other => {
            if !WARNED_UNKNOWN.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    engine = %other,
                    "unknown WOWSP_ROW_RECOGNIZER engine — falling back to the default windows-ocr"
                );
            }
            DEFAULT_RECOGNIZER
        },
    }
}

/// Engine selection from the raw env value: parse the kind, then construct
/// its engine. `None` = recognition off — nothing downstream runs.
fn select_recognizer(raw: Option<std::ffi::OsString>) -> Option<Box<dyn RowRecognizer>> {
    match recognizer_kind(raw.as_deref()) {
        RecognizerKind::Off => None,
        // When the OS cannot provide an engine (no recognizer language
        // installed) degrade to the placeholder so the pipeline keeps its
        // shape — it will simply recognize nothing.
        #[cfg(target_os = "windows")]
        RecognizerKind::WindowsOcr => match row_ocr_windows::WindowsOcrRecognizer::acquire() {
            Some(engine) => Some(Box::new(engine)),
            None => {
                if !WARNED_UNAVAILABLE.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        "windows-ocr: no usable OCR language pack — row recognition stays off"
                    );
                }
                Some(Box::new(NullRecognizer))
            },
        },
        // Unreachable: the parse above resolves every value to Off on
        // non-Windows targets, so no WindowsOcr kind can be produced there.
        #[cfg(not(target_os = "windows"))]
        RecognizerKind::WindowsOcr => None,
    }
}

/// Whether row recognition is ON under the current environment: the parsed
/// engine kind selects Windows OCR AND the OS can actually build the engine
/// — a machine with no OCR language pack can never produce a row mapping,
/// so the pending machinery (anchor `row_players_pending`, watcher
/// catch-up) must not wait for one. Consumed by `compute_anchor` and by the
/// Tab watcher's recognition catch-up gate.
pub(crate) fn recognizer_enabled() -> bool {
    recognizer_enabled_for(std::env::var_os(RECOGNIZER_ENV).as_deref())
}

/// Env-injected core of [`recognizer_enabled`] (testable without mutating
/// process state). The engine probe runs through the same lazy `OnceLock`
/// the capture path uses, so after the first capture this is a cheap read.
fn recognizer_enabled_for(raw: Option<&std::ffi::OsStr>) -> bool {
    match recognizer_kind(raw) {
        RecognizerKind::Off => false,
        #[cfg(target_os = "windows")]
        RecognizerKind::WindowsOcr => row_ocr_windows::WindowsOcrRecognizer::acquire().is_some(),
        #[cfg(not(target_os = "windows"))]
        RecognizerKind::WindowsOcr => false,
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
/// Cost contract: with recognition disabled this is one `var_os` read and
/// nothing else; the arena-file IO happens only after at least one row
/// produced text (i.e. never with the null engine).
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
    // the known-wrong index guess. No separate confidence gate downgrades
    // that vec back to None; instead `compute_anchor` reports the anchor as
    // `row_players_pending` and the Tab watcher's catch-up keeps re-running
    // this pipeline until some row actually matches the roster.
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
    use crate::commands::replay;

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
        // Unset / empty / unknown all resolve to the DEFAULT engine — the
        // real Windows OCR, or the degraded placeholder when the OS has no
        // OCR language pack; on non-Windows builds the default is off.
        #[cfg(target_os = "windows")]
        {
            assert!(select_recognizer(None).is_some());
            assert!(select_recognizer(Some("".into())).is_some());
            assert!(select_recognizer(Some("   ".into())).is_some());
            assert!(select_recognizer(Some("rapidocr".into())).is_some());
            // The real engine name selects it — either way the pipeline runs.
            assert!(select_recognizer(Some("windows-ocr".into())).is_some());
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(select_recognizer(None).is_none());
            assert!(select_recognizer(Some("".into())).is_none());
            assert!(select_recognizer(Some("windows-ocr".into())).is_none());
            assert!(select_recognizer(Some("rapidocr".into())).is_none());
        }
        // Explicit off / null → off entirely.
        assert!(select_recognizer(Some("off".into())).is_none());
        assert!(select_recognizer(Some("OFF".into())).is_none());
        assert!(select_recognizer(Some("null".into())).is_none());
    }

    #[test]
    fn recognizer_kind_defaults_to_windows_ocr() {
        use std::ffi::OsStr;
        fn os(s: &str) -> Option<&OsStr> {
            Some(OsStr::new(s))
        }
        let default = if cfg!(target_os = "windows") {
            RecognizerKind::WindowsOcr
        } else {
            RecognizerKind::Off
        };
        // Unset / empty / unknown → the default; only off/null disables.
        assert_eq!(recognizer_kind(None), default);
        assert_eq!(recognizer_kind(os("")), default);
        assert_eq!(recognizer_kind(os("  ")), default);
        assert_eq!(recognizer_kind(os("rapidocr")), default);
        assert_eq!(recognizer_kind(os("off")), RecognizerKind::Off);
        assert_eq!(recognizer_kind(os("NULL")), RecognizerKind::Off);
        #[cfg(target_os = "windows")]
        assert_eq!(
            recognizer_kind(os("windows-ocr")),
            RecognizerKind::WindowsOcr
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(recognizer_kind(os("windows-ocr")), RecognizerKind::Off);
    }

    #[test]
    fn recognizer_enabled_follows_parse_and_engine_availability() {
        use std::ffi::OsStr;
        // Explicit off never enables, whatever the machine has installed.
        assert!(!recognizer_enabled_for(Some(OsStr::new("off"))));
        // Unset → the default: enabled exactly when the Windows OCR engine
        // is constructible (needs an installed OCR language pack) — which
        // this assertion probes through the same lazy OnceLock, so the test
        // makes no assumption about the machine's packs. Never enabled on
        // non-Windows builds, whatever the env says.
        #[cfg(target_os = "windows")]
        assert_eq!(
            recognizer_enabled_for(None),
            row_ocr_windows::WindowsOcrRecognizer::acquire().is_some(),
            "default env enables recognition iff the engine is constructible"
        );
        #[cfg(not(target_os = "windows"))]
        {
            assert!(!recognizer_enabled_for(None));
            assert!(!recognizer_enabled_for(Some(OsStr::new("windows-ocr"))));
        }
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
            scenario: None,
            bot_count: 0,
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
            scenario: None,
            bot_count: 0,
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
            scenario: None,
            bot_count: 0,
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
            scenario: None,
            bot_count: 0,
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

    // ── real-frame acceptance (PR 3b hard gate, opt-in) ──────────────────

    /// Run the REAL pipeline — decode frame, detect the table, crop the name
    /// strips, read them with the Windows OCR engine, match against the
    /// dump's arena roster — over every `*.frame.png` + `*.arena.json` pair
    /// in `WOWSP_OCR_FIXTURES`, and require ≥60% of each frame's rows to
    /// match (20 rows across the two #372 dumps carry ellipsized names and
    /// CJK ship-name noise; 60% is the realistic floor).
    ///
    /// Fixtures whose stem contains `.miss` are pre-battle frames with NO
    /// table on screen: for them the CORRECT outcome is `detect_roster`
    /// returning None, which is ASSERTED here (a detection hit on a
    /// tableless frame is a real detector bug worth failing on) — they never
    /// enter the match-rate accounting.
    ///
    /// `#[ignore]`d because CI has neither the local dump directory nor OCR
    /// language packs; even when run WITHOUT the env it returns early and
    /// stays green. Usage on a dev machine with the dumps:
    ///
    /// ```text
    /// WOWSP_OCR_FIXTURES=D:\wowsp-tab-dumps \
    ///   cargo test -p wowsp_tauri ocr -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs local Tab-frame dumps (WOWSP_OCR_FIXTURES) and Windows OCR language packs"]
    #[cfg(target_os = "windows")]
    fn real_frame_windows_ocr_acceptance() {
        let Some(dir) = std::env::var_os("WOWSP_OCR_FIXTURES")
            .map(std::path::PathBuf::from)
            .filter(|d| !d.as_os_str().is_empty())
        else {
            eprintln!(
                "real_frame_windows_ocr_acceptance: set WOWSP_OCR_FIXTURES to the tab-dump \
                 directory to run the real-frame gate; skipping"
            );
            return;
        };
        let engine = select_recognizer(Some("windows-ocr".into()))
            .expect("windows-ocr must select an engine (real or degraded null)");

        let mut frames: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("fixture dir must be readable")
            .map(|e| e.expect("dir entry").path())
            .filter(|p| p.to_string_lossy().ends_with(".frame.png"))
            .collect();
        frames.sort();
        assert!(
            !frames.is_empty(),
            "no *.frame.png fixtures under {}",
            dir.display()
        );

        let mut failures: Vec<String> = Vec::new();
        for frame_path in frames {
            let raw_stem = frame_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let stem = raw_stem.trim_end_matches(".frame.png").to_owned();
            let arena_path = frame_path.with_file_name(format!("{stem}.arena.json"));

            let img = image::open(&frame_path)
                .unwrap_or_else(|e| panic!("decode {}: {e}", frame_path.display()))
                .to_rgba8();
            let (w, h) = img.dimensions();
            let rgba = img.into_raw();

            // The roster: same parse the live pipeline uses (the dump's
            // arena.json is the raw descriptor text; the extractor tolerates
            // the 8-byte-prefixed file variant too).
            let arena_bytes = std::fs::read(&arena_path)
                .unwrap_or_else(|e| panic!("read {}: {e}", arena_path.display()));
            let json = replay::extract_descriptor_json_pub(&arena_bytes)
                .unwrap_or_else(|| panic!("extract {}", arena_path.display()));
            let raw: serde_json::Value = serde_json::from_str(&json).expect("arena json parse");
            let meta = replay::meta_from_raw_pub(arena_path.to_string_lossy().into_owned(), raw);
            let info = ArenaInfo {
                match_group: meta.match_group,
                date_time: meta.date_time,
                map_name: meta.map_name,
                scenario: meta.scenario,
                bot_count: meta.bot_count,
                vehicles: meta.vehicles,
                raw: serde_json::Value::Null,
            };
            let allies = info.vehicles.iter().filter(|v| v.relation <= 1).count();
            let enemies = info.vehicles.iter().filter(|v| v.relation > 1).count();
            assert!((allies, enemies) != (0, 0), "{stem}: roster is empty");

            // Expected NEGATIVES: `.miss` fixtures are pre-battle frames
            // with no table on screen. Detection must return None for them
            // (asserted — a hit on a tableless frame is a real bug worth
            // failing on); they never reach the OCR/match accounting.
            if stem.contains(".miss") {
                match overlay_detect::detect_roster(&rgba, w, h, (allies, enemies)) {
                    Some(det) => failures.push(format!(
                        "{stem}: expected-negative frame produced a detection (rect {:?})",
                        det.rect
                    )),
                    None => println!("== {stem}: table correctly NOT detected (pre-battle frame)"),
                }
                continue;
            }

            let Some(det) = overlay_detect::detect_roster(&rgba, w, h, (allies, enemies)) else {
                failures.push(format!("{stem}: table not detected"));
                continue;
            };
            let frame = RowFrame {
                rgba: &rgba,
                width: w,
                height: h,
                roster: &det.rect,
                row_centers: &det.row_centers,
                team_split: det.team_split,
                ally_rows: allies,
            };

            let started = std::time::Instant::now();
            let texts = recognize_texts(engine.as_ref(), &frame);
            let elapsed = started.elapsed();
            let matched = row_match_blocks(&texts, &info, allies);

            // Diagnostics: per row, the OCR raw text, the pinned roster name
            // and its score; unmatched rows get their block's best score so
            // the reason (noise vs below-threshold read) is visible.
            let norm: Vec<Vec<char>> = info
                .vehicles
                .iter()
                .map(|v| row_match::normalize(&v.name).chars().collect())
                .collect();
            let score_of = |name: &str, text: &str| -> f32 {
                let tn: Vec<char> = row_match::normalize(text).chars().collect();
                let nn: Vec<char> = row_match::normalize(name).chars().collect();
                row_match::pair_score(&nn, &tn)
            };
            let best_in_block = |row: usize, text: &str| -> f32 {
                let tn: Vec<char> = row_match::normalize(text).chars().collect();
                let (a, b) = if row < allies {
                    (0, allies)
                } else {
                    (allies, norm.len())
                };
                norm[a..b]
                    .iter()
                    .map(|n| row_match::pair_score(n, &tn))
                    .fold(0.0f32, f32::max)
            };
            println!(
                "== {stem}: {w}x{h}, rect {:?}, {} rows, recognize+match {elapsed:?}",
                det.rect,
                texts.len()
            );
            println!("   row centers: {:?}", det.row_centers);
            for (i, (text, name)) in texts.iter().zip(&matched).enumerate() {
                match (text, name) {
                    (Some(t), Some(n)) => println!(
                        "  row {i:2}  MATCH {:?} -> {:?} (score {:.3})",
                        t,
                        n,
                        score_of(n, t)
                    ),
                    (Some(t), None) => println!(
                        "  row {i:2}  MISS  {:?} -> no roster name (best {:.3} < {:.2})",
                        t,
                        best_in_block(i, t),
                        row_match::MATCH_THRESHOLD
                    ),
                    (None, _) => println!("  row {i:2}  MISS  (no text read from the strip)"),
                }
            }
            let hits = matched.iter().filter(|m| m.is_some()).count();
            println!("   {stem}: {hits}/{} rows matched", texts.len());
            if hits * 10 < texts.len() * 6 {
                failures.push(format!("{stem}: only {hits}/{} rows matched", texts.len()));
            }
        }
        assert!(failures.is_empty(), "real-frame gate failed: {failures:?}");
    }
}
