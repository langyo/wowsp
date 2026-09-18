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
//! One (battle, panel layout) produces at most one dump: the arena roster
//! plus the anchor's first-row position (quantized) are hashed into a battle
//! signature and every signature already SEEN is skipped — a seen-SET, not a
//! last-write slot — so holding Tab (one detection pass per rate-limit
//! window, plus the 5 s anchor revalidation passes while the overlay stays
//! shown) cannot flood the dump directory with near-identical frames even
//! when jitter straddling the bucket boundary alternates between two
//! signatures: each side dumps exactly once, then silence. When the panel
//! MOVES as a whole within one battle — the countdown "waiting players"
//! layout sits ~190 px above the combat layout once the in-battle HUD
//! appears — the first-row bucket changes and the new layout takes its own
//! dump. Those per-layout frames are exactly the ground truth the
//! row-recognition engine needs: the same battle captured under different
//! panel layouts (row-order sampling across survival states is the
//! recognition PR's own work). FAILED detections (the centered-fallback
//! anchor behind the "table not found" hint) dump once per battle as
//! `.miss.` artifacts — a scenario where the detector cannot find the table
//! leaves its frame behind for offline analysis instead of vanishing. Every
//! IO failure is logged and swallowed — a broken dump directory must never
//! panic the watcher thread nor disturb the overlay pipeline this hook sits
//! inside.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use wowsp_tauri_shared::{ArenaInfo, OverlayAnchor};

/// Environment variable that enables the dumps (set to a directory path).
const TAB_DUMP_DIR_ENV: &str = "WOWSP_TAB_DUMP_DIR";

/// Signatures of every (battle, layout) already dumped — a seen-SET, not a
/// last-write slot: the phase refinement moves the grid by up to ±pitch/3
/// (well over one 8 px bucket), so jitter can ALTERNATE the quantized first
/// row between two buckets across passes, and a single-slot comparison
/// would then re-dump on every flip. A `Vec` because `HashSet::new` is not
/// const-constructible for a static — with at most a handful of
/// battle × layout entries per process the linear scan is noise. Lives for
/// the process lifetime, exactly as long as a dump stays "already
/// written". A plain static like the other cross-press state
/// (`LAST_TEAM_SIZES` in arena_info) — keyed by arena roster content plus
/// the anchor's first-row bucket, not by wall clock.
static LAST_DUMPED_BATTLE: Mutex<Vec<u64>> = Mutex::new(Vec::new());

/// Battles whose FAILED detection (the centered-fallback anchor, `.miss.`
/// artifacts) already dumped — its own set so a battle that first misses and
/// later confirms still leaves BOTH frames. Miss signatures carry no layout
/// bucket: the fallback grid is synthetic and its geometry is meaningless.
static SEEN_MISS_BATTLES: Mutex<Vec<u64>> = Mutex::new(Vec::new());

/// Dump the current Tab frame, the arena roster and the detector anchor into
/// `WOWSP_TAB_DUMP_DIR`. Called from the overlay watcher with the exact RGBA
/// frame the detector ran on — both from per-press acquisition passes and
/// from the 5 s revalidation passes while the overlay stays shown. CONFIRMED
/// detections (`table_detected == true`) dump once per (battle, layout);
/// FAILED detections dump once per battle as `.miss.` artifacts, so a
/// scenario where the table cannot be found leaves the frame behind for
/// offline analysis. Does nothing when the env var is unset or empty.
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
    // Confirmed dumps key on (battle, layout); misses key on the battle only
    // — the fallback grid is synthetic (centered rows), its geometry carries
    // no layout information worth bucketing.
    let (variant, signature) = if anchor.table_detected {
        ("", battle_signature(&info, first_row_bucket(anchor)))
    } else {
        (".miss", battle_signature(&info, i64::MIN))
    };
    let claimed = if anchor.table_detected {
        claim_signature(&LAST_DUMPED_BATTLE, signature)
    } else {
        claim_signature(&SEEN_MISS_BATTLES, signature)
    };
    if !claimed {
        return;
    }
    // The signature stays claimed even when the write below fails: a broken
    // dump directory must not turn every subsequent Tab capture into another
    // failing write — the failure is logged once and that is enough.
    let png = encode_frame_png(rgba, width, height);
    if png.is_empty() {
        tracing::warn!("tab dump skipped: frame did not encode to PNG");
        return;
    }
    let stem = timestamp_stem();
    match write_dump_files(&dir, &stem, variant, &png, &arena_json, anchor) {
        Ok(()) => tracing::info!(dir = %dir.display(), "tab roster dump written"),
        Err(e) => tracing::warn!(error = %e, "tab roster dump write failed"),
    }
}

/// Record `signature` in the seen-set and report whether it was new (the
/// caller should dump). Poisoned by a panic elsewhere — stay silent and
/// leave the overlay flow untouched.
fn claim_signature(set: &Mutex<Vec<u64>>, signature: u64) -> bool {
    let Ok(mut seen) = set.lock() else {
        return false;
    };
    first_dump_for_battle(&mut seen, signature)
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

/// Whether `signature` has never been dumped in this process: records it and
/// returns true on the first sighting, false on ANY repeat — including
/// revisits of an older signature after other ones appeared (the
/// bucket-boundary jitter alternation the seen-set exists for; a
/// last-write slot re-dumped on every flip). Pure so the once-per-signature
/// rule is unit-testable without the static.
fn first_dump_for_battle(seen: &mut Vec<u64>, signature: u64) -> bool {
    if seen.contains(&signature) {
        return false;
    }
    seen.push(signature);
    true
}

/// Battle identity from the arena roster PLUS the panel position: date-time +
/// roster size + the first vehicle's id + the anchor's first-row bucket (see
/// [`first_row_bucket`]). `DefaultHasher` is process-local (not stable across
/// compiler releases) which is fine — the signature only feeds this
/// in-process dedup and is never persisted. A new battle rewrites the same
/// tempArenaInfo.json path with a new dateTime/roster, so every real battle
/// hashes differently; the panel moving as a WHOLE inside one battle (the
/// countdown → combat HUD phase shift) changes the bucket and takes its own
/// dump — per-layout ground truth for the recognition engine. Row REORDERS
/// at fixed slot positions (sunk ships) do not move the first row and are
/// deliberately not part of this signature — sampling those is the
/// recognition PR's own work.
fn battle_signature(info: &ArenaInfo, first_row_bucket: i64) -> u64 {
    let mut hasher = DefaultHasher::new();
    info.date_time.hash(&mut hasher);
    info.vehicles.len().hash(&mut hasher);
    info.vehicles.first().map(|v| v.id).hash(&mut hasher);
    first_row_bucket.hash(&mut hasher);
    hasher.finish()
}

/// The anchor's first row center quantized to [`FIRST_ROW_BUCKET_PX`] px
/// buckets — the LAYOUT component of the dump signature. Detector jitter (a
/// few px between passes) stays inside one bucket and keeps the
/// once-per-battle dedup intact, while a real panel shift (~190 px between
/// HUD phases at 3072x1920) crosses dozens of buckets. An anchor without
/// rows (unreachable on the confirmed-detection path) hashes to a fixed
/// bucket so it can never match a real layout.
const FIRST_ROW_BUCKET_PX: i64 = 8;

fn first_row_bucket(anchor: &OverlayAnchor) -> i64 {
    anchor
        .row_centers
        .first()
        .map(|&r| r as i64 / FIRST_ROW_BUCKET_PX)
        .unwrap_or(i64::MIN)
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
/// - `tab-<stem><variant>.frame.png` — the game-window frame the detector
///   ran on;
/// - `tab-<stem><variant>.arena.json` — tempArenaInfo.json's raw JSON text;
/// - `tab-<stem><variant>.anchor.json` — the serialized [`OverlayAnchor`].
///
/// All three share the timestamp stem; `variant` is `""` for a confirmed
/// detection and `".miss"` for a failed one. File names carry no player
/// name, but the arena.json artifact IS the roster text and contains every
/// player's nickname — a dump directory must be sanitized before it is
/// shared.
fn write_dump_files(
    dir: &Path,
    stem: &str,
    variant: &str,
    frame_png: &[u8],
    arena_json: &str,
    anchor: &OverlayAnchor,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let anchor_json =
        serde_json::to_string_pretty(anchor).map_err(|e| format!("serialize anchor: {e}"))?;
    std::fs::write(
        dir.join(format!("tab-{stem}{variant}.frame.png")),
        frame_png,
    )
    .map_err(|e| format!("write frame png: {e}"))?;
    std::fs::write(
        dir.join(format!("tab-{stem}{variant}.arena.json")),
        arena_json,
    )
    .map_err(|e| format!("write arena json: {e}"))?;
    std::fs::write(
        dir.join(format!("tab-{stem}{variant}.anchor.json")),
        anchor_json,
    )
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
            scenario: None,
            bot_count: 0,
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
        let a = battle_signature(&arena("20260917T120000", &[11, 22, 33]), 40);
        let b = battle_signature(&arena("20260917T120000", &[11, 22, 33]), 40);
        assert_eq!(a, b, "same roster must hash to the same signature");
        // Any of the four hashed parts moving must change the signature: a
        // new battle rewrites the same tempArenaInfo.json path, and a layout
        // switch inside one battle moves the first-row bucket — the signature
        // diff is the only once-per-(battle, layout) trigger.
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120001", &[11, 22, 33]), 40),
            "different dateTime"
        );
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120000", &[11, 22]), 40),
            "different roster size"
        );
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120000", &[33, 22, 11]), 40),
            "different first vehicle id"
        );
        assert_ne!(
            a,
            battle_signature(&arena("20260917T120000", &[11, 22, 33]), 64),
            "different panel layout (first-row bucket)"
        );
    }

    /// Minimal anchor whose only varied field is the first row center.
    fn anchor_with_first_row(first: i32) -> OverlayAnchor {
        OverlayAnchor {
            game_rect: Rect {
                x: 0,
                y: 0,
                width: 3072,
                height: 1920,
            },
            overlay_rect: Rect {
                x: 600,
                y: 300,
                width: 1200,
                height: 600,
            },
            roster_rect: Rect {
                x: 150,
                y: 24,
                width: 900,
                height: 520,
            },
            row_centers: vec![first, first + 52, first + 104],
            team_split: 0.5,
            table_detected: true,
            row_players: None,
            row_players_pending: false,
        }
    }

    #[test]
    fn first_row_bucket_absorbs_jitter_and_splits_layouts() {
        // Sub-bucket jitter (≤3 px between passes) keeps ONE bucket, so the
        // per-battle dedup survives detector noise; a real HUD-phase panel
        // shift (~190 px measured at 3072x1920) must change the bucket.
        assert_eq!(
            first_row_bucket(&anchor_with_first_row(500)),
            first_row_bucket(&anchor_with_first_row(503)),
            "within-bucket jitter → same bucket"
        );
        assert_ne!(
            first_row_bucket(&anchor_with_first_row(500)),
            first_row_bucket(&anchor_with_first_row(690)),
            "layout switch → different bucket"
        );
        // An anchor without rows hashes to a fixed bucket — it must never
        // collide with a real layout's bucket.
        let mut empty = anchor_with_first_row(500);
        empty.row_centers.clear();
        assert_ne!(
            first_row_bucket(&empty),
            first_row_bucket(&anchor_with_first_row(500)),
            "empty grid → sentinel bucket"
        );
    }

    #[test]
    fn first_dump_for_battle_allows_once_per_signature() {
        let mut seen: Vec<u64> = Vec::new();
        assert!(first_dump_for_battle(&mut seen, 7), "first sighting dumps");
        assert!(
            !first_dump_for_battle(&mut seen, 7),
            "same battle again → skipped"
        );
        assert!(first_dump_for_battle(&mut seen, 8), "new battle dumps");
        // Back to the EARLIER signature (bucket-boundary jitter revisit):
        // already dumped, must stay silent — the reason the dedup state is a
        // seen-set rather than a last-write slot.
        assert!(
            !first_dump_for_battle(&mut seen, 7),
            "revisit of an old signature → skipped"
        );
    }

    #[test]
    fn alternating_layout_buckets_dump_exactly_twice() {
        // One battle whose quantized first row alternates between two buckets
        // across detection passes (phase-refinement jitter straddling the 8 px
        // bucket boundary): the seen-set must dump each bucket exactly ONCE —
        // the A→B→A→B… tail produces nothing further (a last-write slot would
        // have re-dumped on every flip).
        let mut seen: Vec<u64> = Vec::new();
        let flips = [11u64, 12, 11, 12, 11, 12, 11];
        let dumps: usize = flips
            .iter()
            .map(|&s| usize::from(first_dump_for_battle(&mut seen, s)))
            .sum();
        assert_eq!(dumps, 2, "A→B→A→B… must leave exactly two artifacts");
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
            row_players_pending: false,
        };
        let arena_text = r#"{"dateTime":"20260917T120000","vehicles":[{"id":11}]}"#;
        write_dump_files(&dir, "20260917-120000", "", b"png", arena_text, &anchor)
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

    #[test]
    fn miss_dump_files_carry_the_dot_miss_infix() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp_tab_miss_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut anchor = anchor_with_first_row(500);
        anchor.table_detected = false;
        write_dump_files(&dir, "20260917-120000", ".miss", b"png", "{}", &anchor)
            .expect("miss dump must write all files");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "tab-20260917-120000.miss.anchor.json",
                "tab-20260917-120000.miss.arena.json",
                "tab-20260917-120000.miss.frame.png",
            ],
            "failed detections land under their own .miss. namespace"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn miss_and_confirmed_dumps_of_one_battle_are_independent() {
        // The same battle may first produce a FAILED detection and later a
        // confirmed one (or reconfirm after a layout shift): the `.miss.`
        // dedup set is separate from the confirmed set, so both frames land.
        let mut confirmed: Vec<u64> = Vec::new();
        let mut misses: Vec<u64> = Vec::new();
        assert!(first_dump_for_battle(&mut confirmed, 42), "confirmed dumps");
        assert!(
            first_dump_for_battle(&mut misses, 42),
            "the miss set does not inherit the confirmed set's state"
        );
        assert!(
            !first_dump_for_battle(&mut misses, 42),
            "miss dedups per battle"
        );
    }
}
