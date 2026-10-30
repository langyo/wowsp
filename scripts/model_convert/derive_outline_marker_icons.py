#!/usr/bin/env python3
"""Derive the outline ("line art") marker icons the hint cards draw.

The game's white minimap markers are a light plate inside a semi-transparent
dark outline, and the hint cards tint that art to the popup's ink
(brightness(0), inverted on the dark palette). Tinting turns the plate and
the strokes into the same ink: at the card's 20 px the glyph collapses into
one solid blob and its interior gaps disappear. This derives the same glyph
as pure line art — the plate is dropped, the strokes keep their pixel
coverage — so the tint renders crisp ink lines with the gaps open.

The source separates cleanly by luminance: plate ~0.91 (darkness ~0.09),
strokes ~0.01 (darkness ~0.99), anti-aliased edge in between. The transfer
maps darkness to ink coverage through a smoothstep, scales the pixel's own
alpha by it (the strokes carry ~75% alpha) and lifts the product so the
hairline survives the 20 px render.

Writes icon_outline_<class>.webp next to the icon_white_<class>.webp sources
(the bundled tree ships WebP). RGB ends up white: every consumer tints the
channel to its own ink, exactly like the white HUD art it derives from.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

CLASSES = ["battleship", "cruiser", "destroyer", "aircarrier", "submarine"]

# Darkness band separating the plate (below) from the strokes (above); the
# anti-aliased edge in between keeps a soft, unthickened transition.
INK_FLOOR = 0.25
INK_CEIL = 0.70
# The source strokes carry ~75% alpha; lift the derived ink to solid coverage
# so the 1 px hairline survives the card's 20 px downscale.
INK_LIFT = 1.30


def smoothstep(x: float, lo: float, hi: float) -> float:
    if x <= lo:
        return 0.0
    if x >= hi:
        return 1.0
    t = (x - lo) / (hi - lo)
    return t * t * (3.0 - 2.0 * t)


def outline(img: Image.Image) -> Image.Image:
    src = img.convert("RGBA")
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    src_px = src.load()
    out_px = out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = src_px[x, y]
            if a == 0:
                continue
            luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
            ink = smoothstep(1.0 - luminance, INK_FLOOR, INK_CEIL)
            coverage = round(a * ink * INK_LIFT)
            if coverage <= 0:
                continue
            out_px[x, y] = (255, 255, 255, min(255, coverage))
    return out


def main() -> None:
    default_dir = Path(__file__).resolve().parents[2] / "packages/webui/src/res/images/ships"
    src_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else default_dir
    for cls in CLASSES:
        src = src_dir / f"icon_white_{cls}.webp"
        if not src.exists():
            print(f"skip {cls}: {src.name} missing")
            continue
        out = src_dir / f"icon_outline_{cls}.webp"
        outline(Image.open(src)).save(out, "WEBP", lossless=True, method=6)
        print(f"wrote {out.name} (from {src.name})")


if __name__ == "__main__":
    main()
