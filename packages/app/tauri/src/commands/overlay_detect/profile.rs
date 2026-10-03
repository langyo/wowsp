use super::*;

/// Per-client tuning of the header-anchored detector: the measurements that
/// DO differ between the WG-family clients and the Lesta (Мир кораблей)
/// build. Everything else in the detector is a proportion of the capture and
/// shared; the header colors (teal/brick) are shared too — verified against
/// a real Lesta capture, rgb(90,153,150) / rgb(160,90,99) both classify
/// under the WG predicates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DetectProfile {
    /// Row pitch PRIOR = header-bar height × this factor. WG measured
    /// 52/55 ≈ 0.95 (1440p) and 48/54 ≈ 0.89 (1080p); the Lesta client
    /// scales its rows WITH the bar — 56/56 = 1.00 exactly (3072x1920
    /// capture). This is no longer used verbatim for the grid:
    /// [`fit_row_grid`] reads the TRUE pitch off the frame's own text bands
    /// (the single ratio left a per-resolution error that accumulated down
    /// the table — the "chips drift off the bottom rows" report) and only
    /// falls back to this prior when too few bands vote — but the prior
    /// still centers the plausibility clamp, so it must match the client:
    /// the Lesta pitch (1.00 × bar) sits OUTSIDE the clamp window the WG
    /// prior (0.92 × bar) would impose.
    pub(crate) pitch_per_header: f32,
    /// Name-strip column bounds inside each sub-table half, as fractions of
    /// that half's width (see [`row_name_strip_rect`]). WG: ally names hug
    /// the left edge, enemy names right-align near the outer edge (the #372
    /// tab dumps). Lesta: BOTH name columns hug their panel's left edge —
    /// measured (3072x1920 capture, split ≈ 0.50) at table fractions
    /// 0.00–0.33 (ally) and 0.58–0.88 (enemy), which in half coordinates is
    /// 0.00–0.66 and 0.15–0.78; WG's enemy window (0.62 of the half ≈ 0.81
    /// of the table) would miss almost the entire Lesta enemy column.
    pub(crate) ally_strip_x0_frac: f32,
    pub(crate) ally_strip_x1_frac: f32,
    pub(crate) enemy_strip_x0_frac: f32,
    pub(crate) enemy_strip_x1_frac: f32,
}

impl DetectProfile {
    /// The WG-family layout — Wargaming / Steam / the CN clients (and the
    /// fallback for unknown clients and manual pins).
    pub(crate) const WG: DetectProfile = DetectProfile {
        pitch_per_header: 0.92,
        ally_strip_x0_frac: 0.02,
        ally_strip_x1_frac: 0.40,
        enemy_strip_x0_frac: 0.62,
        enemy_strip_x1_frac: 0.96,
    };

    /// The Lesta (Мир кораблей) layout. Measured on a real 3072x1920
    /// capture: header bars ~26% of the frame width each (WG ~18–20%) with
    /// a ~9.5% center seam (WG ~3%) — both still inside every gate's
    /// tolerance — rows exactly one bar-height apart, and both name columns
    /// left-aligned in their panels (strip fractions here are HALF-relative:
    /// ally table 0.00–0.33 / enemy 0.58–0.88 with the seam at ≈0.50).
    pub(crate) const LESTA: DetectProfile = DetectProfile {
        pitch_per_header: 1.00,
        ally_strip_x0_frac: 0.00,
        ally_strip_x1_frac: 0.66,
        enemy_strip_x0_frac: 0.15,
        enemy_strip_x1_frac: 0.78,
    };

    /// The profile for the client behind a capture. Only the Lesta build is
    /// known to differ; every other kind (and an unknown client) uses the
    /// WG layout.
    pub(crate) fn for_kind(kind: &GameInstallKind) -> DetectProfile {
        if *kind == GameInstallKind::Lesta {
            Self::LESTA
        } else {
            Self::WG
        }
    }
}
