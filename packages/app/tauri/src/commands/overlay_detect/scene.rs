/// Sample stride over the capture (physical px) for the scene probe.
const SCENE_STEP: u32 = 4;
/// The HP bar is a long run of saturated green in the bottom-left corner.
/// Measured on a real 1080p client: it sits at ~78% of the frame height
/// (x ~3-15%), so the band spans well around it.
const HP_GREEN_MIN_RUN: u32 = 48;
/// Vanilla rosters render small light ship silhouettes across the top of
/// the screen. Detection is deliberately FUZZY and position-agnostic —
/// roster placement differs between PvP / scenarios / co-op — so any icon-
/// sized compact bright blob in the top band counts, wherever it sits.
/// The size bounds reject broad sky/cloud expanses (too wide) and thin
/// text strokes (too short).
const ICON_MIN_W: u32 = 12;
const ICON_MAX_W: u32 = 100;
const ICON_MIN_H: u32 = 4;
const ICON_MAX_H: u32 = 40;
/// Bright threshold for icon pixels (silhouettes are near-white).
const ICON_LUMA: u8 = 170;
/// A full roster stacks many icons (PvP 5v5 -> 10+; scenarios fewer); a
/// handful of ship-shaped blobs means a roster is on screen.
const ICONS_MIN: u32 = 5;

/// Green-dominance test for the HP bar, tolerant of the Tab dim: holding
/// Tab darkens the bar from ≈ rgb(50,220,110) to ≈ rgb(28,68,56), and its
/// vanilla hue is TEAL-ish (blue only slightly under green), so the old
/// `g > b + 25` test matched only the pre-dim frame. Bluish water (blue
/// over green) stays excluded.
pub(crate) fn is_probe_green(r: i16, g: i16, b: i16) -> bool {
    g > 55 && g >= r + 20 && g >= b - 10
}

/// True when the frame carries the in-battle HUD: the bottom-left health bar
/// plus the vanilla team rosters' ship silhouettes across the top.
/// None of these render outside the 3D scene — port, login and loading
/// screens all fail this probe — so it gates the whole overlay.
/// Components of the battle-HUD probe, logged on failure so real captures
/// can be tuned from the dev console alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SceneProbe {
    /// Long green run in the bottom-left corner (health bar).
    pub hp_bar: bool,
    /// Icon-sized bright blobs counted across the whole top band (ship
    /// silhouettes of the team rosters, any roster layout).
    pub icon_blobs: u32,
}

impl SceneProbe {
    pub(crate) fn detected(&self) -> bool {
        self.hp_bar && self.icon_blobs >= ICONS_MIN
    }
}

pub(crate) fn probe_battle_scene(rgba: &[u8], width: u32, height: u32) -> SceneProbe {
    let none = SceneProbe {
        hp_bar: false,
        icon_blobs: 0,
    };
    let px = |x: u32, y: u32| -> (u8, u8, u8) {
        let i = ((y * width + x) * 4) as usize;
        (rgba[i], rgba[i + 1], rgba[i + 2])
    };

    // ── HP bar: longest horizontal run of green in the bottom-left region ──
    let x0 = width * 2 / 100;
    let x1 = (width * 25 / 100).min(width.saturating_sub(1));
    let y0 = height * 70 / 100;
    let y1 = (height * 95 / 100).min(height.saturating_sub(1));
    let mut hp_found = false;
    if x1 > x0 && y1 > y0 {
        'outer: for y in (y0..y1).step_by(SCENE_STEP as usize) {
            let mut run = 0u32;
            let mut best = 0u32;
            for x in (x0..x1).step_by(SCENE_STEP as usize) {
                let (r, g, b) = px(x, y);
                if is_probe_green(r as i16, g as i16, b as i16) {
                    run += SCENE_STEP;
                    best = best.max(run);
                } else {
                    run = 0;
                }
            }
            if best >= HP_GREEN_MIN_RUN {
                hp_found = true;
                break 'outer;
            }
        }
    }
    if !hp_found {
        return none;
    }

    // ── Vanilla rosters: fuzzy ship-icon blobs across the whole top band ──
    // Position-agnostic on purpose: scenario / co-op modes place their
    // rosters differently from random battles, and mods may add their own
    // bars — none of that may break the probe.
    let icon_blobs = count_icon_blobs(
        &px,
        width * 2 / 100,
        (width * 98 / 100).min(width.saturating_sub(1)),
        height * 8 / 100,
        (height * 35 / 100).min(height.saturating_sub(1)),
    );
    SceneProbe {
        hp_bar: true,
        icon_blobs,
    }
}

/// Count compact bright blobs (ship silhouettes) in a region. A blob is a
/// set of bright horizontal runs on adjacent scan rows whose x-ranges
/// overlap; its size must fit the icon bounds, which rejects both broad
/// sky/cloud areas and thin text strokes.
fn count_icon_blobs(
    px: &impl Fn(u32, u32) -> (u8, u8, u8),
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
) -> u32 {
    if x1 <= x0 || y1 <= y0 {
        return 0;
    }
    // Collect bright runs per scan row: (y, x_start, x_end).
    let mut runs: Vec<(u32, u32, u32)> = Vec::new();
    for y in (y0..y1).step_by(SCENE_STEP as usize) {
        let mut cur: Option<(u32, u32)> = None;
        for x in (x0..x1).step_by(SCENE_STEP as usize) {
            let (r, g, b) = px(x, y);
            let luma = (u16::from(r) + u16::from(g) + u16::from(b)) / 3;
            if luma >= u16::from(ICON_LUMA) {
                cur = Some(match cur {
                    Some((s, _)) => (s, x),
                    None => (x, x),
                });
            } else if let Some((s, e)) = cur.take() {
                if e - s >= ICON_MIN_W && e - s <= ICON_MAX_W {
                    runs.push((y, s, e));
                }
            }
        }
        if let Some((s, e)) = cur.take() {
            if e - s >= ICON_MIN_W && e - s <= ICON_MAX_W {
                runs.push((y, s, e));
            }
        }
    }
    runs.sort_by_key(|&(y, xs, _)| (y, xs));

    // Greedy vertical clustering: adjacent rows with overlapping x-ranges
    // belong to the same blob.
    let mut blobs = 0u32;
    let mut open: Option<(u32, u32, u32, u32)> = None; // (y_last, x_min, x_max, y_first)
    for (y, xs, xe) in runs {
        open = match open {
            Some((yl, xmin, xmax, yfirst))
                if y - yl <= SCENE_STEP * 2 && xs <= xmax && xe >= xmin =>
            {
                Some((y, xmin.min(xs), xmax.max(xe), yfirst))
            },
            Some((yl, _xmin, _xmax, yfirst)) => {
                let h = yl - yfirst;
                if (ICON_MIN_H..=ICON_MAX_H).contains(&h) {
                    blobs += 1;
                }
                Some((y, xs, xe, y))
            },
            None => Some((y, xs, xe, y)),
        };
    }
    if let Some((yl, _xmin, _xmax, yfirst)) = open {
        let h = yl - yfirst;
        if (ICON_MIN_H..=ICON_MAX_H).contains(&h) {
            blobs += 1;
        }
    }
    blobs
}

/// Gate helper: the full HUD must be present.
pub(crate) fn detect_battle_scene(rgba: &[u8], width: u32, height: u32) -> bool {
    probe_battle_scene(rgba, width, height).detected()
}

// ─────────────────────────────────────────────────────────────────────────
// Anchor construction (pure — unit-testable without Win32)
// ─────────────────────────────────────────────────────────────────────────
