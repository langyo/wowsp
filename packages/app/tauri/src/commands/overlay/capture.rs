use super::*;
// ─────────────────────────────────────────────────────────────────────────
// Capture + anchor computation
// ─────────────────────────────────────────────────────────────────────────

/// Capture the game window, resolve the table geometry (via the FSM's
/// per-game-window-mode cache when it verifies; a full detection otherwise)
/// and return the anchor for the chip layer. Falls back to a conservative
/// centered table when detection fails but a battle roster is known — stats
/// must still be readable. Fallback geometry never enters the cache.
#[cfg(target_os = "windows")]
pub(super) fn compute_anchor(game: &GameWindow, fsm: &mut WatchFsm) -> Option<OverlayAnchor> {
    let team_sizes = super::arena_info::last_known_team_sizes();
    let game_rect = rect_from_win32(game.rect);
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
    };
    let mut verify_missed = false;
    let mut band_verified = false;
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
            );
            cache.roster = det.clone();
            cache.team_sizes = team_sizes;
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
            // The misses almost always mean the table itself moved (HUD
            // phase switch): re-arm the pin revalidation so the very next
            // tick re-detects, instead of leaving misplaced chips until
            // the regular 5 s cadence comes around.
            fsm.last_revalidate = None;
        } else {
            verify_missed = true;
        }
        break 'cache None;
    };
    if verify_missed {
        // Band verify missed but the cache is not (yet) declared dead: skip
        // BOTH the gate's full scans and the detection for THIS frame — the
        // next capture (sink probe 500 ms / catch-up 1.5 s / revalidate 5 s
        // / acquisition 1.5 s) re-judges cheaply. A full-frame band search
        // here would find the MOVED table, but rescanning every frame is
        // exactly the cost this cache exists to avoid; the strike counter
        // is the last-resort re-arm.
        return None;
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
        let header_found = overlay_detect::header_bars_present(&rgba, w, h);
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
    let (roster_rel, rows, split, detected) = if let Some(det) = cached {
        (det.rect, det.row_centers, det.team_split, true)
    } else {
        match overlay_detect::detect_roster_with_band(&rgba, w, h, team_sizes) {
            Some((band, det)) => {
                // Confirmed detection → (re)fill the cache. Fallback
                // geometry never enters it (table_detected == false never
                // pins, so it would never be reused by a pin path anyway).
                fsm.geometry_cache = Some(GeometryCacheEntry {
                    key,
                    band,
                    roster: det.clone(),
                    team_sizes,
                });
                fsm.geometry_verify_fails = 0;
                (det.rect, det.row_centers, det.team_split, true)
            },
            None => {
                tracing::info!(
                    allies = team_sizes.0,
                    enemies = team_sizes.1,
                    "team list not detected — using centered fallback table"
                );
                let expected = team_sizes.0.max(team_sizes.1);
                let (r, rows) = overlay_detect::fallback_roster(w as i32, h as i32, expected);
                (r, rows, 0.5, false)
            },
        }
    };
    // Row attribution, per the settings mode. All three run on the DETECTED
    // capture-relative geometry, before build_anchor re-bases it to the
    // overlay origin. `ally_rows` is the SAME team_sizes read the detection
    // grid above was built from — the single source of truth for the block
    // split.
    //
    // - `ocr`: the Windows OCR pipeline names the rows and classifies them
    //   alive/sunk off the same name strips. Every failure inside degrades
    //   to None and must never disturb the anchor flow.
    // - `inferred` (default): NO OCR — the overlay page derives the
    //   row→name mapping from the verified Tab sort rule over the roster,
    //   so this side only contributes the per-row alive/sunk classification
    //   (pure luma, no text recognition). The mapping it implies is exact
    //   for the group structure the game renders and leaves only the
    //   within-(class, tier) ties to chance.
    // - `off`: neither — the frontend falls back to the historical index
    //   mapping, all rows read alive.
    let mode = super::overlay_config::roster_mode();
    let row_state = if !detected {
        None
    } else if mode == super::overlay_config::RosterRecognition::Inferred {
        let alive =
            overlay_detect::read_row_alive(&rgba, w, h, &roster_rel, &rows, split, team_sizes.0);
        Some((None, alive))
    } else {
        row_recognize::recognize_row_players(&row_recognize::RowFrame {
            rgba: &rgba,
            width: w,
            height: h,
            roster: &roster_rel,
            row_centers: &rows,
            team_split: split,
            ally_rows: team_sizes.0,
        })
        .map(|s| (Some(s.names), s.alive))
    };
    let (overlay, mut anchor) =
        overlay_detect::build_anchor(&game_rect, &roster_rel, rows, split, detected);
    let (names, alive) = match row_state {
        Some((n, a)) => (Some(n), Some(a)),
        None => (None, None),
    };
    anchor.row_players = names.flatten();
    anchor.row_alive = alive;
    // Pending flag: only the OCR mode can be "still working on names" — the
    // inferred mode's mapping is derived the moment the roster exists and
    // `off` never names rows. (An all-`None` OCR vec is honest silence, NOT
    // a trusted mapping.) Manual anchors never reach this code and keep the
    // serde-default false.
    anchor.row_players_pending = mode == super::overlay_config::RosterRecognition::Ocr
        && row_recognize::ocr_active()
        && mapping_untrusted(&anchor.row_players);
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
    Some(anchor)
}

/// Pack `GWL_STYLE` + `GWL_EXSTYLE` into one geometry-cache key component:
/// a window-mode switch (borderless ↔ windowed) can theoretically keep the
/// outer rect identical while the styles change — the style bits turn that
/// into a cache miss too.
#[cfg(target_os = "windows")]
fn window_style_bits(hwnd: windows::Win32::Foundation::HWND) -> u64 {
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
pub async fn capture_game_window() -> Result<CaptureResult, String> {
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
        let (anchor, png) = match capture_game_rgba_cached(&game.rect) {
            Some((rgba, w, h)) => {
                // Same dual-channel scene gate as `compute_anchor`: the HUD
                // probe dims badly while Tab is held; the header bars are
                // the primary evidence.
                let in_scene = overlay_detect::detect_battle_scene(&rgba, w, h)
                    || overlay_detect::header_bars_present(&rgba, w, h);
                let det = if in_scene {
                    match overlay_detect::detect_roster(&rgba, w, h, team_sizes) {
                        Some(d) => Some(
                            overlay_detect::build_anchor(
                                &rect_from_win32(game.rect),
                                &d.rect,
                                d.row_centers,
                                d.team_split,
                                true,
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
