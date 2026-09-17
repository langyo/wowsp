//! Opt-in ground-truth dumps of the in-game Tab roster (debug aid).
//!
//! The overlay frontend currently maps `tempArenaInfo.json` players onto the
//! detected table rows by array index, but the in-game Tab panel orders its
//! rows with its own sort — so the chips can land on the wrong player. The
//! planned fix ("row → name recognition") needs GROUND TRUTH: the exact Tab
//! frame, the arena roster the frontend indexed, and the detector output, all
//! captured at the same instant, so the REAL row order can be analysed
//! offline.
//!
//! The dump only runs when the developer sets `WOWSP_TAB_DUMP_DIR` to a
//! non-empty path — it is a debugging feature, never a shipped behavior, and
//! with the variable unset the overlay hot path must stay free of any extra
//! work (no PNG encode, no arena re-read, no lock contention).
//!
//! One battle produces at most one dump: the arena roster is hashed into a
//! battle signature and repeated detections of the SAME battle are skipped,
//! so holding Tab (one detection pass per rate-limit window) cannot flood the
//! dump directory with near-identical frames. Every IO failure is logged and
//! swallowed — a broken dump directory must never panic the watcher thread
//! nor disturb the overlay pipeline this hook sits inside.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use wowsp_tauri_shared::{ArenaInfo, OverlayAnchor};

/// Environment variable that enables the dumps (set to a directory path).
const TAB_DUMP_DIR_ENV: &str = "WOWSP_TAB_DUMP_DIR";

/// Signature of the battle whose dump was already written. A plain static
/// like the other cross-press state (`LAST_TEAM_SIZES` in arena_info) — one
/// dump per battle, keyed by arena roster content, not by wall clock.
static LAST_DUMPED_BATTLE: Mutex<Option<u64>> = Mutex::new(None);

/// Dump the current Tab frame, the arena roster and the detector anchor into
/// `WOWSP_TAB_DUMP_DIR`, at most once per battle. Called from the overlay
/// watcher right after a CONFIRMED table detection (`table_detected == true`)
/// with the exact RGBA frame the detector ran on. Does nothing when the env
/// var is unset or empty.
pub(crate) fn maybe_dump_tab_frame(rgba: &[u8], width: u32, height: u32, anchor: &OverlayAnchor) {
    // Env gate FIRST: with the feature off this is the whole function —
    // zero allocation, zero IO, zero locking on the overlay hot path.
    let Some(dir) = dump_dir(std::env::var_os(TAB_DUMP_DIR_ENV)) else {
        return;
    };
    // The battle signature needs the live roster, and the arena.json artifact
    // is its raw text — one read of tempArenaInfo.json serves both. Without a
    // readable roster there is no signature, so skip rather than risk dumping
    // the same battle repeatedly. The snapshot resolves the arena dir via env
    // / auto-detect, which can diverge from the install the overlay watches —
    // an acceptable imprecision for a debugging aid.
    let Some((info, arena_json)) = super::arena_info::read_arena_snapshot() else {
        tracing::debug!("tab dump skipped: no readable tempArenaInfo.json");
        return;
    };
    let signature = battle_signature(&info);
    {
        let mut last = match LAST_DUMPED_BATTLE.lock() {
            Ok(g) => g,
            // Poisoned by a panic elsewhere — stay silent and leave the
            // overlay flow untouched.
            Err(_) => return,
        };
        if !first_dump_for_battle(&mut last, signature) {
            return;
        }
    }
    // The battle stays marked even when the write below fails: a broken dump
    // directory must not turn every subsequent Tab capture into another
    // failing write — the failure is logged once and that is enough.
    let png = encode_frame_png(rgba, width, height);
    if png.is_empty() {
        tracing::warn!("tab dump skipped: frame did not encode to PNG");
        return;
    }
    let stem = timestamp_stem();
    match write_dump_files(&dir, &stem, &png, &arena_json, anchor) {
        Ok(()) => tracing::info!(dir = %dir.display(), "tab roster dump written"),
        Err(e) => tracing::warn!(error = %e, "tab roster dump write failed"),
    }
}

/// Pure env gate: the raw `WOWSP_TAB_DUMP_DIR` value → dump directory. Unset
/// or EMPTY disables the feature (an empty path would otherwise resolve
/// against the process CWD and scatter dumps there). Split from the env read
/// so tests can exercise it without mutating process state.
fn dump_dir(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

/// Whether `signature` is new for this process: records it and returns true
/// on the first sighting, false on repeats (same battle re-detected on a
/// later Tab press). Pure so the once-per-battle rule is unit-testable
/// without the static.
fn first_dump_for_battle(last: &mut Option<u64>, signature: u64) -> bool {
    if *last == Some(signature) {
        return false;
    }
    *last = Some(signature);
    true
}

/// Battle identity from the arena roster: date-time + roster size + the first
/// vehicle's id. `DefaultHasher` is process-local (not stable across compiler
/// releases) which is fine — the signature only feeds this in-process dedup
/// and is never persisted. A new battle rewrites the same tempArenaInfo.json
/// path with a new dateTime/roster, so every real battle hashes differently.
fn battle_signature(info: &ArenaInfo) -> u64 {
    let mut hasher = DefaultHasher::new();
    info.date_time.hash(&mut hasher);
    info.vehicles.len().hash(&mut hasher);
    info.vehicles.first().map(|v| v.id).hash(&mut hasher);
    hasher.finish()
}

/// `YYYYMMDD-HHMMSS` (local time) shared by the three files of one dump so a
/// battle's artifacts sort together in the directory listing.
fn timestamp_stem() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Encode the captured frame as PNG bytes (same encoding as the debug
/// capture path in `overlay`). Returns an empty vec when the pixel buffer
/// does not match the dimensions — the caller skips the dump then.
fn encode_frame_png(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    use std::io::Cursor;
    let Some(img) = image::RgbaImage::from_raw(width, height, rgba.to_vec()) else {
        return Vec::new();
    };
    let mut out = Cursor::new(Vec::new());
    if let Err(e) = image::DynamicImage::ImageRgba8(img).write_to(&mut out, image::ImageFormat::Png)
    {
        // Cannot fail for an in-memory cursor in practice, but a failed
        // write must never leave a PARTIAL buffer that slips past the
        // caller's empty check as a corrupt PNG.
        tracing::warn!(error = %e, "tab dump: PNG encode failed");
        return Vec::new();
    }
    out.into_inner()
}

/// Write the three ground-truth artifacts for one detection:
///
/// - `tab-<stem>.frame.png` — the game-window frame the detector ran on;
/// - `tab-<stem>.arena.json` — tempArenaInfo.json's raw JSON text;
/// - `tab-<stem>.anchor.json` — the serialized [`OverlayAnchor`].
///
/// All three share the timestamp stem. File names carry no player name, but
/// the arena.json artifact IS the roster text and contains every player's
/// nickname — a dump directory must be sanitized before it is shared.
fn write_dump_files(
    dir: &Path,
    stem: &str,
    frame_png: &[u8],
    arena_json: &str,
    anchor: &OverlayAnchor,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let anchor_json =
        serde_json::to_string_pretty(anchor).map_err(|e| format!("serialize anchor: {e}"))?;
    std::fs::write(dir.join(format!("tab-{stem}.frame.png")), frame_png)
        .map_err(|e| format!("write frame png: {e}"))?;
    std::fs::write(dir.join(format!("tab-{stem}.arena.json")), arena_json)
        .map_err(|e| format!("write arena json: {e}"))?;
    std::fs::write(dir.join(format!("tab-{stem}.anchor.json")), anchor_json)
        .map_err(|e| format!("write anchor json: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::{Rect, VehicleEntry};

    /// Minimal well-formed arena roster for the signature tests.
    fn arena(date_time: &str, ids: &[i64]) -> ArenaInfo {
        ArenaInfo {
            match_group: Some("pvp".into()),
            date_time: Some(date_time.into()),
            map_name: None,
            vehicles: ids
                .iter()
                .map(|&id| VehicleEntry {
                    id,
                    name: format!("player{id}"),
                    relation: 0,
                    ship_id: id * 10,
                    ship_name: None,
                })
                .collect(),
            raw: serde_json::Value::Null,
        }
    }

    #[test]
    fn battle_signature_is_stable_and_discriminating() {
        let a = battle_signature(&arena("20260917T120000", &[11, 22, 33]));
        let b = battle_signature(&arena("20260917T120000", &[11, 22, 33]));
        assert_eq!(a, b, "same roster must hash to the same signature");
        // Any of the three hashed parts moving must change the signature: a
        // new battle rewrites the same tempArenaInfo.json path, so the
        // signature diff is the only once-per-battle trigger.
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120001", &[11, 22, 33])),
            "different dateTime"
        );
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120000", &[11, 22])),
            "different roster size"
        );
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120000", &[33, 22, 11])),
            "different first vehicle id"
        );
    }

    #[test]
    fn first_dump_for_battle_allows_once_per_signature() {
        let mut last: Option<u64> = None;
        assert!(first_dump_for_battle(&mut last, 7), "first sighting dumps");
        assert!(
            !first_dump_for_battle(&mut last, 7),
            "same battle again → skipped"
        );
        assert!(first_dump_for_battle(&mut last, 8), "new battle dumps");
    }

    #[test]
    fn dump_dir_gate_requires_non_empty_env_value() {
        assert!(dump_dir(None).is_none(), "unset env → feature off");
        assert!(dump_dir(Some("".into())).is_none(), "empty env → off");
        assert_eq!(
            dump_dir(Some(std::ffi::OsString::from("tab-dumps"))),
            Some(PathBuf::from("tab-dumps"))
        );
    }

    #[test]
    fn encode_frame_png_round_trips_pixels() {
        // 2x2 RGBA with distinct corner pixels: the dump feeds offline row
        // analysis, so a channel-swapped or lossy encode would poison every
        // artifact — the encoded frame must decode back pixel-exact.
        let rgba = vec![
            10, 20, 30, 255, 200, 150, 100, 255, //
            0, 255, 0, 255, 90, 90, 90, 255,
        ];
        let png = encode_frame_png(&rgba, 2, 2);
        assert!(!png.is_empty(), "a matching buffer must encode");
        let back = image::load_from_memory(&png)
            .expect("encoded frame must decode")
            .to_rgba8();
        assert_eq!((back.width(), back.height()), (2, 2));
        assert_eq!(back.as_raw(), &rgba, "pixel-exact round trip");
        // A buffer that does not match the dimensions encodes to nothing —
        // never a truncated PNG.
        assert!(encode_frame_png(&rgba, 3, 2).is_empty());
    }

    #[test]
    fn dump_writes_three_files_with_matching_stem() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp_tab_dump_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let anchor = OverlayAnchor {
            game_rect: Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
            },
            overlay_rect: Rect {
                x: 600,
                y: 300,
                width: 1200,
                height: 250,
            },
            roster_rect: Rect {
                x: 150,
                y: 24,
                width: 900,
                height: 200,
            },
            row_centers: vec![50, 92, 134],
            team_split: 0.5,
            table_detected: true,
            row_players: None,
        };
        let arena_text = r#"{"dateTime":"20260917T120000","vehicles":[{"id":11}]}"#;
        write_dump_files(&dir, "20260917-120000", b"png", arena_text, &anchor)
            .expect("dump must write all files");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "tab-20260917-120000.anchor.json",
                "tab-20260917-120000.arena.json",
                "tab-20260917-120000.frame.png",
            ],
            "three artifacts sharing one timestamp stem"
        );
        // The arena artifact is the RAW text, byte-for-byte — not a
        // re-serialization of the parsed roster.
        assert_eq!(
            std::fs::read_to_string(dir.join("tab-20260917-120000.arena.json")).unwrap(),
            arena_text
        );
        // The anchor artifact round-trips back into OverlayAnchor.
        let back: OverlayAnchor = serde_json::from_str(
            &std::fs::read_to_string(dir.join("tab-20260917-120000.anchor.json")).unwrap(),
        )
        .unwrap();
        assert!(back.table_detected);
        assert_eq!(back.row_centers, vec![50, 92, 134]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
