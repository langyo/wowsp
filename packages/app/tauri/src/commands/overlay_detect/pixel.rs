/// Box-filter downscale to an RGB working image (alpha dropped, opaque).
pub(crate) fn downscale_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    scale: u32,
) -> (Vec<u8>, usize, usize) {
    let w = (width / scale) as usize;
    let h = (height / scale) as usize;
    let mut out = vec![0u8; w * h * 3];
    let n = scale * scale;
    let sw = scale as usize;
    let fw = width as usize;
    for y in 0..h {
        for x in 0..w {
            let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
            for dy in 0..sw {
                for dx in 0..sw {
                    let i = ((y * sw + dy) * fw + x * sw + dx) * 4;
                    if i + 2 < rgba.len() {
                        sr += rgba[i] as u32;
                        sg += rgba[i + 1] as u32;
                        sb += rgba[i + 2] as u32;
                    }
                }
            }
            let o = (y * w + x) * 3;
            out[o] = (sr / n).min(255) as u8;
            out[o + 1] = (sg / n).min(255) as u8;
            out[o + 2] = (sb / n).min(255) as u8;
        }
    }
    (out, w, h)
}

/// Longest contiguous run of pixels matching `matches` on scan row `y` →
/// `(start, end)` with end exclusive, or None when nothing matches.
pub(crate) fn longest_run_span(
    px: &[u8],
    w: usize,
    y: usize,
    matches: impl Fn(i16, i16, i16) -> bool,
) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut start: Option<usize> = None;
    for x in 0..w {
        let i = (y * w + x) * 3;
        let hit = i + 2 < px.len() && matches(px[i] as i16, px[i + 1] as i16, px[i + 2] as i16);
        if hit {
            if start.is_none() {
                start = Some(x);
            }
        } else if let Some(s) = start.take() {
            if best.is_none_or(|(bs, be)| x - s > be - bs) {
                best = Some((s, x));
            }
        }
    }
    if let Some(s) = start {
        if best.is_none_or(|(bs, be)| w - s > be - bs) {
            best = Some((s, w));
        }
    }
    best
}

/// Vanilla team-header green: TEAL (blue sits at/near green) and clearly
/// green-dominant over red. Measured rgb(81,148,140); also survives the
/// Tab-dim. Water is blue-dominant (b > g) and stays excluded.
pub(crate) fn is_header_green(r: i16, g: i16, b: i16) -> bool {
    g >= r + 25 && g >= 75 && b >= g - 45 && b <= g + 25
}

/// Vanilla team-header red: muted brick rgb(167,121,114) — red-dominant but
/// nowhere near a pure red.
pub(crate) fn is_header_red(r: i16, g: i16, b: i16) -> bool {
    r >= g + 25 && r >= 110 && r >= b + 20
}

/// Near-white, low-saturation pixel (player names, bar captions).
pub(crate) fn is_text_white(r: i16, g: i16, b: i16) -> bool {
    r.min(g).min(b) >= 170 && r.max(g).max(b) - r.min(g).min(b) <= 60
}

// ─────────────────────────────────────────────────────────────────────────
// Battle-scene gate
// ─────────────────────────────────────────────────────────────────────────
