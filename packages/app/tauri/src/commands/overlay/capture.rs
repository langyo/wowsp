use super::*;
use wowsp_tauri_shared::CommandResult;
// ─────────────────────────────────────────────────────────────────────────
// Capture + anchor computation
// ─────────────────────────────────────────────────────────────────────────

/// Capture the game window, resolve the table geometry (via the FSM's
/// per-game-window-mode cache when it verifies; a full detection otherwise)
/// and return the anchor for the chip layer TOGETHER with the strip-layout
/// profile in effect for that anchor (the client-kind base, or the
/// classic-vs-rework WG layout a fresh detection measured — callers pin it
/// alongside the anchor so the sink path never reads strips under a
/// profile a later cache refill could flip to). Falls back to a
/// conservative centered table when detection fails but a battle roster is
/// known — stats must still be readable. Fallback geometry never enters
/// the cache.
#[cfg(target_os = "windows")]
pub(super) fn compute_anchor(
    game: &GameWindow,
    fsm: &mut WatchFsm,
) -> Option<(OverlayAnchor, overlay_detect::DetectProfile)> {
    let team_sizes = super::arena_info::last_known_team_sizes();
    let game_rect = rect_from_win32(game.rect);
    // Per-client tuning (WG vs Lesta scoreboard geometry), resolved once
    // per capture from the window's process.
    let profile = overlay_detect::DetectProfile::for_kind(&game.kind);
    let Some((rgba, w, h)) = capture_game_rgba_cached(&game.rect) else {
        tracing::warn!("game window capture returned no pixels");
        return None;
    };
    if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
        dump_capture(&rgba, w, h);
    }
    // ── Geometry cache: the full-frame scan runs ONCE per game-window mode;
    //    every later capture only re-verifies the cached header band (band-
    //    area cost) and reuses the cached grid. The cache deliberately
    //    survives battle changes — same window rect+style means the same
    //    pixel geometry, and a new battle shape rebuilds from the band.
    //    Resolved BEFORE the scene gate: a verified band IS the in-scene
    //    proof, so cache-hit frames pay no probe scan and no full-frame
    //    band search at all.
    let key = GeometryKey {
        game_size: (game_rect.width, game_rect.height),
        style_bits: window_style_bits(game.hwnd),
        kind: game.kind,
    };
    // Live identity for the persistent anchor calibration (see
    // `calibration.rs`): `None` while the watcher has not resolved a
    // client + battle class yet, in which case every calibration op below
    // is a no-op.
    let cal_key = super::watch::live_calibration_key(fsm, game);
    let mut verify_missed = false;
    let mut band_verified = false;
    // Grid-probe miss on an otherwise band-verified frame (review H-1):
    // set inside the cache block, acted on after it (the cache borrow
    // must end before the retire mutates the FSM).
    let mut grid_missed = false;
    // Set when this frame has ALREADY been proven table-bearing by a full
    // header scan (the early cache retire below) — the scene gate reuses it
    // instead of scanning the same frame twice.
    let mut frame_carries_table = false;
    // The strip-layout profile IN EFFECT for this frame: the client-kind
    // base until a detection (or the cache it filled) resolves the WG
    // classic-vs-rework layout — the strip readers below and every later
    // cache hit must agree on it.
    let mut profile_eff = profile;
    let cached = 'cache: {
        let Some(cache) = fsm.geometry_cache.as_mut() else {
            break 'cache None;
        };
        if cache.key != key {
            // The window resized / changed style: everything about the
            // cached geometry is void — full re-detection on this frame.
            tracing::info!("game window mode changed — roster geometry cache voided");
            fsm.geometry_cache = None;
            fsm.geometry_verify_fails = 0;
            break 'cache None;
        }
        if overlay_detect::verify_header_band(&rgba, w, h, &cache.band) {
            profile_eff = cache.profile;
            // GRID probe (overlay review H-1): the band verify only proves
            // the HEADER is where the cache says — the rows below are what
            // the chips anchor to. A band-right/grid-wrong cache (manual
            // calibration off by rows, a client UI tweak) used to pass
            // every verify and vote itself stable; retire it now and
            // detect on THIS frame (the band IS on frame, so this is the
            // self-heal the three-miss counter was too slow to deliver).
            if !overlay_detect::verify_row_grid(&rgba, w, h, &cache.roster) {
                tracing::info!(
                    "header band verified but the row grid probe missed — roster geometry cache retired"
                );
                grid_missed = true;
                break 'cache None;
            }
            fsm.geometry_verify_fails = 0;
            band_verified = true;
            if cache.team_sizes == team_sizes {
                break 'cache Some(cache.roster.clone());
            }
            // Same window, different battle shape (7v7 after 12v12):
            // rebuild the grid from the still-valid band — geometry, no
            // frame scan — keeping the pitch the cached detection measured
            // (per side; the two sub-tables can pitch differently).
            let measured = overlay_detect::measured_pitch_from_centers(
                &cache.roster.row_centers,
                cache.team_sizes.0,
            );
            let det = overlay_detect::rebuild_roster_from_band(
                &cache.band,
                w,
                h,
                team_sizes,
                Some(measured),
                &cache.profile,
            );
            cache.roster = det.clone();
            cache.team_sizes = team_sizes;
            // The stored calibration entry keeps describing the OLD battle
            // shape — re-shape it to the live roster counts, so the settings
            // list's rows/teams readout and the remap fallback's shape
            // comparison follow the battles actually played.
            if let Some(k) = cal_key.as_ref() {
                fsm.calibration.note_shape(k, team_sizes, &det);
            }
            break 'cache Some(det);
        }
        // The band is NOT at the cached spot on this frame — a HUD-phase
        // table move (or a scene change). The cached geometry must not
        // anchor this frame; count the miss and fall through. After
        // GEOMETRY_VERIFY_MAX_FAILS consecutive misses the cache is
        // declared dead so the full detector can re-acquire.
        fsm.geometry_verify_fails += 1;
        if fsm.geometry_verify_fails >= GEOMETRY_VERIFY_MAX_FAILS {
            tracing::info!(
                fails = fsm.geometry_verify_fails,
                "header band verify kept failing — roster geometry cache dropped"
            );
            fsm.geometry_cache = None;
            fsm.geometry_verify_fails = 0;
            // The stored calibration entry carries the same dead band —
            // drop it too, or every future class flip / app start would
            // re-seed stale geometry and re-buy these three misses.
            if let Some(k) = cal_key.as_ref() {
                fsm.calibration.note_unstable(k);
            }
            // The misses almost always mean the table itself moved (HUD
            // phase switch): re-arm the pin revalidation so the very next
            // tick re-detects, instead of leaving misplaced chips until
            // the regular 5 s cadence comes around.
            fsm.last_revalidate = None;
        } else if overlay_detect::header_bars_present(&rgba, w, h) {
            // The cached spot is wrong, but the frame CARRIES a Tab table
            // somewhere — the cache itself is what is wrong for this
            // client, not the scene. Seen live on a Lesta build (feedback
            // 2026-10-23): the full detector kept re-succeeding at the
            // same geometry while EVERY cached-band verify failed. The miss
            // counter survives across Tab presses, so every press after the
            // first paid one-to-two dead rate-limit windows (a glance
            // shorter than that saw nothing at all) before the third miss
            // finally allowed a scan. Retire the cache on the evidence of
            // this one frame and detect now. (No `last_revalidate = None`
            // here, unlike the max-fails branch above: detection runs on
            // THIS frame below, and nulling the stamp would re-arm the
            // forced revalidation on every tick — a capture+detect hot loop
            // on exactly this always-fail client.)
            tracing::info!(
                "header band verify missed but a table is on frame — roster geometry cache retired early"
            );
            fsm.geometry_cache = None;
            fsm.geometry_verify_fails = 0;
            if let Some(k) = cal_key.as_ref() {
                fsm.calibration.note_unstable(k);
            }
            frame_carries_table = true;
        } else {
            verify_missed = true;
        }
        break 'cache None;
    };
    if grid_missed {
        // The band verified but the row grid did not (review H-1): retire
        // the cache and the calibration vote it kept earning, then detect
        // on THIS frame (the band is on frame — `frame_carries_table`
        // lets the scene gate's scan run without re-proving the table).
        fsm.geometry_cache = None;
        fsm.geometry_verify_fails = 0;
        if let Some(k) = cal_key.as_ref() {
            fsm.calibration.note_unstable(k);
        }
        frame_carries_table = true;
    }
    if verify_missed {
        // Band verify missed AND the frame carries no table anywhere: skip
        // BOTH the gate's full scans and the detection for THIS frame — the
        // next capture (sink probe 500 ms / revalidate 5 s / acquisition
        // 1.5 s, or 400 ms while the hold is young — see
        // `CAPTURE_YOUNG_RETRY_INTERVAL`) re-judges cheaply. (A frame that
        // DOES carry a table never gets here — the cache was retired early
        // above, exactly so a wrong-for-this-client cache cannot park the
        // overlay for the whole miss budget.)
        return None;
    }
    // A frame that verified the cached band AND its row grid is a STABLE
    // press for the calibration store: one vote per Tab press episode,
    // and after `STABLE_PRESSES_TO_CERTIFY` agreeing presses the entry
    // is certified and the watcher's periodic revalidation slows to the
    // certified cadence (never stands down — see H-1).
    if band_verified {
        if let Some(k) = cal_key.as_ref() {
            fsm.calibration.note_stable(k);
        }
    }
    // Scene gate (only reached for frames that will actually be detected:
    // a verified band or no cache). The HUD probe (HP bar + ship icons)
    // only renders inside the 3D scene, but holding Tab DIMS the whole
    // frame and real captures show it then finds as few as 2 icon clusters
    // (threshold 5) or a 12px HP run (threshold 48) — it kept rejecting
    // real battles. So the probe is only the SECOND opinion: the header
    // detection itself is the strongest possible in-scene proof (the
    // teal/brick team-header bars exist ONLY on the in-battle Tab table),
    // and either one passes. With a verified cached band this whole block
    // is skipped — the band verify already proved it.
    if !band_verified {
        let probe = overlay_detect::probe_battle_scene(&rgba, w, h);
        // `frame_carries_table` short-circuits the second full header scan
        // on a frame the early cache retire already proved table-bearing.
        let header_found = frame_carries_table || overlay_detect::header_bars_present(&rgba, w, h);
        if !probe.detected() && !header_found {
            tracing::info!(
                hp_bar = probe.hp_bar,
                icon_blobs = probe.icon_blobs,
                header_found,
                "tab press: no battle HUD and no team header — not in a 3D scene, skipping"
            );
            return None;
        }
    }
    // Fresh detections DEFER their cache/calibration store until the
    // plausibility veto below has approved the geometry — a vetoed misfire
    // must leave no trace anywhere.
    let mut fresh: Option<(overlay_detect::HeaderBand, overlay_detect::DetectedRoster)> = None;
    let (roster_rel, rows, split, detected) = if let Some(det) = cached {
        (det.rect, det.row_centers, det.team_split, true)
    } else {
        match overlay_detect::detect_roster_with_band(&rgba, w, h, team_sizes, &profile) {
            Some((band, det)) => {
                // The strip layout resolves HERE, once per detection: the
                // classic and rework WG tables share this header geometry,
                // and every strip read (this frame's luma pass, the sink
                // probes, all later cache hits) keys on the cached profile.
                profile_eff =
                    overlay_detect::resolve_wg_strip_profile(&rgba, w, h, band, &det, &profile);
                fresh = Some((band, det.clone()));
                (det.rect, det.row_centers, det.team_split, true)
            },
            None => {
                tracing::info!(
                    allies = team_sizes.0,
                    enemies = team_sizes.1,
                    "team list not detected — using fallback table"
                );
                fallback_geometry(fsm, game, w as i32, h as i32, team_sizes)
            },
        }
    };
    // Plausibility veto (silent — see `overlay_detect::roster_plausible`):
    // a detector misfire must not pin, render or certify. A vetoed FRESH
    // detection simply falls back (nothing was stored yet); a vetoed CACHE
    // rebuild additionally charges the verify-miss budget so a cache that
    // keeps producing absurd geometry retires like any other dead band.
    let (roster_rel, rows, split, detected) = if detected
        && overlay_detect::roster_plausible(&roster_rel, &rows, split, w as i32, h as i32)
    {
        (roster_rel, rows, split, true)
    } else if detected {
        tracing::warn!(
            x = roster_rel.x,
            y = roster_rel.y,
            width = roster_rel.width,
            height = roster_rel.height,
            split,
            "detected roster failed the plausibility gates — vetoed, falling back"
        );
        if fresh.is_none() && fsm.geometry_cache.is_some() {
            fsm.geometry_verify_fails += 1;
            if fsm.geometry_verify_fails >= GEOMETRY_VERIFY_MAX_FAILS {
                tracing::info!(
                    fails = fsm.geometry_verify_fails,
                    "vetoed cache geometry one time too many — roster geometry cache dropped"
                );
                fsm.geometry_cache = None;
                fsm.geometry_verify_fails = 0;
                if let Some(k) = cal_key.as_ref() {
                    fsm.calibration.note_unstable(k);
                }
            }
        }
        fresh = None;
        fallback_geometry(fsm, game, w as i32, h as i32, team_sizes)
    } else {
        (roster_rel, rows, split, false)
    };
    if let Some((band, det)) = fresh {
        // Confirmed detection → (re)fill the cache. Fallback geometry never
        // enters it (table_detected == false never pins, so it would never
        // be reused by a pin path anyway). A fresh full-scan detection is
        // also the calibration store's ground truth: the entry takes this
        // geometry wholesale and the stability streak restarts (the NEXT
        // presses vote on it).
        if let Some(k) = cal_key.as_ref() {
            fsm.calibration.note_geometry(
                k,
                band,
                det.clone(),
                team_sizes,
                calibration::StoredProfile::of(&profile_eff),
            );
        }
        fsm.geometry_cache = Some(GeometryCacheEntry {
            key,
            band,
            roster: det,
            team_sizes,
            profile: profile_eff,
        });
        fsm.geometry_verify_fails = 0;
    }
    // A frame that PROVED to carry the Tab table — the verified cached band,
    // or a fresh detection that just matched — is the best possible
    // manual-locate reference: it IS the roster moment the player saw. It
    // replaces the cache even while the hold is still young, bypassing the
    // pre-fade-in gate in `capture_game_rgba_cached` (which exists to skip
    // UNPROVEN frames), so a short glance still leaves the picker a
    // table-bearing frame — and any earlier stale/table-less entry is
    // healed within one detection. Throttled inside `store_capture`.
    if detected && tab_key_down() {
        super::overlay_manual::store_capture(&rgba, w, h, game_rect);
    }
    // Row attribution, per the settings mode. Both branches run on the
    // DETECTED capture-relative geometry, before build_anchor re-bases it
    // to the overlay origin. `ally_rows` is the SAME team_sizes read the
    // detection grid above was built from — the single source of truth for
    // the block split.
    //
    // - `inferred` (default): the overlay page derives the row→name
    //   mapping from the client's own Tab sort key (decompiled) over the
    //   roster, so this side only contributes the per-row alive/sunk
    //   classification (pure luma, no text recognition). The mapping is
    //   exact at battle start on the verified WG-family clients (the key
    //   is a total order; the per-client permutations live in the
    //   frontend, utils/shipClass) and stays exact
    //   mid-battle via the sink fast-path's strip-fingerprint solver.
    // - `off`: neither — the frontend falls back to the historical index
    //   mapping, all rows read alive.
    // Plugin and Passive both feed the anchor's alive vector: it is the
    // PRIMARY input in passive mode and the fallback in plugin mode (the
    // plugin's telemetry overrides it in the frontend when fresh).
    let alive = if !detected {
        None
    } else {
        Some(overlay_detect::read_row_alive(
            &rgba,
            w,
            h,
            overlay_detect::StripTable {
                roster: &roster_rel,
                row_centers: &rows,
                team_split: split,
                ally_rows: team_sizes.0,
            },
            &profile_eff,
        ))
    };
    let (overlay, mut anchor) = overlay_detect::build_anchor(
        &game_rect,
        &roster_rel,
        rows,
        split,
        detected,
        window_dpi_scale(game.hwnd),
    );
    anchor.row_alive = alive;
    tracing::info!(
        detected,
        overlay = format!(
            "{}x{} at ({},{})",
            overlay.width, overlay.height, overlay.x, overlay.y
        ),
        rows = anchor.row_centers.len(),
        "anchor built"
    );
    // Ground-truth dump for the Tab row-order analysis (opt-in via
    // WOWSP_TAB_DUMP_DIR, a no-op by default): the frame the detector just
    // ran on, the arena roster and the anchor, captured at the same instant.
    // CONFIRMED detections dump once per (battle, layout); FAILED detections
    // (the `.miss.` artifacts) dump once per battle, so a scenario where the
    // table cannot be found leaves its frame behind for offline analysis.
    super::tab_dump::maybe_dump_tab_frame(&rgba, w, h, &anchor);
    Some((anchor, profile_eff))
}

/// Fallback geometry when detection failed (or was vetoed): first the
/// stored calibration's PROPORTIONS remapped onto the current window —
/// the table lands where it historically sat, which is the best estimate
/// available on a client whose detection cannot run at all — then the
/// built-in centered prior. Always `table_detected == false`: an estimate
/// never pins, never certifies; every press keeps retrying the real
/// detector.
#[cfg(target_os = "windows")]
fn fallback_geometry(
    fsm: &mut WatchFsm,
    game: &GameWindow,
    w: i32,
    h: i32,
    team_sizes: (usize, usize),
) -> (Rect, Vec<i32>, f32, bool) {
    if let Some(class) = fsm.calibration.cache_class {
        if let Some((rect, rows, split)) =
            fsm.calibration
                .remap_geometry(class, &game.kind, (w, h), team_sizes)
        {
            // The stored proportions are only a prior — an absurd remap
            // (a poisoned entry) falls through to the centered prior
            // instead of parking the fallback hint at the absurd spot.
            if overlay_detect::roster_plausible(&rect, &rows, split, w, h) {
                tracing::info!(
                    class = ?class,
                    "fallback: remapped the stored anchor calibration onto the current window"
                );
                return (rect, rows, split, false);
            }
        }
    }
    let expected = team_sizes.0.max(team_sizes.1);
    let (r, rows) = overlay_detect::fallback_roster(w, h, expected);
    (r, rows, 0.5, false)
}

/// Pack `GWL_STYLE` + `GWL_EXSTYLE` into one geometry-cache key component:
/// a window-mode switch (borderless ↔ windowed) can theoretically keep the
/// outer rect identical while the styles change — the style bits turn that
/// into a cache miss too.
#[cfg(target_os = "windows")]
pub(super) fn window_style_bits(hwnd: windows::Win32::Foundation::HWND) -> u64 {
    use windows::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW};
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        ((style as u64) << 32) | (ex as u64 & 0xffff_ffff)
    }
}

/// Capture the game window region and return it as base64 PNG plus the
/// detected anchor. The image is only encoded when `WOWSP_DEBUG_CAPTURE` is
/// set — normal operation needs nothing but the anchor, and shipping a
/// full-screen PNG on every Tab press would be wasteful.
#[tauri::command]
pub async fn capture_game_window() -> CommandResult<CaptureResult> {
    #[cfg(target_os = "windows")]
    {
        let Some(game) = find_game_window() else {
            return Ok(CaptureResult {
                image_base64: String::new(),
                roster_rect: None,
                anchor: None,
            });
        };
        let team_sizes = super::arena_info::last_known_team_sizes();
        let profile = overlay_detect::DetectProfile::for_kind(&game.kind);
        let (anchor, png) = match capture_game_rgba_cached(&game.rect) {
            Some((rgba, w, h)) => {
                // Same dual-channel scene gate as `compute_anchor`: the HUD
                // probe dims badly while Tab is held; the header bars are
                // the primary evidence.
                let in_scene = overlay_detect::detect_battle_scene(&rgba, w, h)
                    || overlay_detect::header_bars_present(&rgba, w, h);
                let det = if in_scene {
                    match overlay_detect::detect_roster(&rgba, w, h, team_sizes, &profile) {
                        Some(d) => Some(
                            overlay_detect::build_anchor(
                                &rect_from_win32(game.rect),
                                &d.rect,
                                d.row_centers,
                                d.team_split,
                                true,
                                window_dpi_scale(game.hwnd),
                            )
                            .1,
                        ),
                        None => {
                            let (r, rows) = overlay_detect::fallback_roster(
                                w as i32,
                                h as i32,
                                team_sizes.0.max(team_sizes.1),
                            );
                            Some(
                                overlay_detect::build_anchor(
                                    &rect_from_win32(game.rect),
                                    &r,
                                    rows,
                                    0.5,
                                    false,
                                    window_dpi_scale(game.hwnd),
                                )
                                .1,
                            )
                        },
                    }
                } else {
                    None
                };
                let png = if std::env::var_os("WOWSP_DEBUG_CAPTURE").is_some() {
                    encode_png(&rgba, w, h)
                } else {
                    Vec::new()
                };
                (det, png)
            },
            None => (None, Vec::new()),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Ok(CaptureResult {
            image_base64: b64,
            roster_rect: anchor.as_ref().map(|a| a.roster_rect),
            anchor,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(CaptureResult {
            image_base64: String::new(),
            roster_rect: None,
            anchor: None,
        })
    }
}

/// Encode an RGBA buffer as PNG bytes.
#[cfg(target_os = "windows")]
pub(super) fn encode_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    use std::io::Cursor;
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec());
    let mut out = Cursor::new(Vec::new());
    if let Some(img) = img {
        let _ = image::DynamicImage::ImageRgba8(img).write_to(&mut out, image::ImageFormat::Png);
    }
    out.into_inner()
}

/// Save a debug capture to %APPDATA%/WoWSP for detector calibration.
#[cfg(target_os = "windows")]
fn dump_capture(rgba: &[u8], w: u32, h: u32) {
    let Some(dir) = dirs_next::data_dir() else {
        return;
    };
    let dir = dir.join("WoWSP");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("overlay-capture-{ts}.png"));
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec());
    if let Some(img) = img {
        if let Err(e) = img.save(&path) {
            tracing::warn!(error = %e, "dump debug capture failed");
        } else {
            tracing::info!(path = %path.display(), "debug capture dumped");
        }
    }
}
