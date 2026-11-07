#!/usr/bin/env python3
"""Author the battle-HUD ship-class markers as flat GEOMETRY.

The faces used to be 27 px WebP bitmaps; tracing them baked pixel
stair-steps into the paths (2026-11-07 review: the slashes came out as runs
of straight segments). The markers are simple flat art, so this script draws
them directly: straight-edged polygons and straight ink lines only — no
curves, no arcs, no tracing.

Art box: 20 x 11 (x right = bow, y down). The ink OUTLINE is the silhouette;
the plate is the same silhouette inset, so the rim shows; the speed slashes
(and the carrier's deck divider) are straight ink lines drawn over the
plate, which keeps the gaps part of the ink body instead of see-through
holes (the 'drafty' carrier of 2026-11-07).

Variants (37 files, the names shipIcons.ts imports):

  icon_<class>.svg          plain  — one solid silhouette (CSS mask)
  icon_ally_<class>.svg     ally   — mint plate, dark-green ink
  icon_enemy_<class>.svg    enemy  — salmon plate, dark-red ink
  icon_white_<class>.svg    white  — light plate, black ink
  icon_sunk_<class>.svg     sunk   — translucent black hull, faint rim
  icon_sunk_enemy_<class>.svg       the same sunk face
  icon_outline_<class>.svg  outline— white ink, no plate (hint cards)

Usage:
    python scripts/model_convert/ship_class_glyphs.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / 'packages' / 'webui' / 'src' / 'res' / 'images' / 'ships'

W, H = 20.0, 11.0  # the marker art box
RIM = 0.9          # ink rim width (silhouette minus plate)
SLASH_W = 1.1      # speed-slash / divider line width
EDGE = 0.5         # silhouette inset from the art box
SLASH_SHIFT = 1.1  # how far the hull slashes sit toward the bow side

# ── palettes (sampled from the original markers) ──
ALLY = ('#50e8b0', '#0b1f16')
ENEMY = ('#f85030', '#2a0a06')
WHITE = ('#e8e8e8', '#000000')
SUNK_INK = ('#000000', '#ffffff')
OUTLINE_INK = '#ffffff'


def rect(x0, y0, x1, y1):
    return f'M{x0} {y0}H{x1}V{y1}H{x0}Z'


def tri(x0, y0, tipx, tipy, x1, y1):
    return f'M{x0} {y0}L{tipx} {tipy}L{x1} {y1}Z'


def line(x0, y0, x1, y1):
    return f'M{x0} {y0}L{x1} {y1}'


def hull_rect(right):
    return (EDGE, EDGE, right, H - EDGE)


def hull_plate(right):
    return (EDGE + RIM, EDGE + RIM, right, H - EDGE - RIM)


def bow_outer(x):
    return tri(x, EDGE, W - EDGE, H / 2, x, H - EDGE)


def bow_plate(x, plate_right):
    return tri(x, EDGE + RIM, plate_right, H / 2, x, H - EDGE - RIM)


# ── per-class geometry ──
# Every shape is flat: hull rectangles, bow triangles, straight lines.


def destroyer():
    # A full flat wedge: vertical stern edge, pointed bow.
    return dict(
        outer=f'M{EDGE} {EDGE}L{W - EDGE} {H / 2}L{EDGE} {H - EDGE}Z',
        plate=f'M{EDGE + RIM} {EDGE + RIM}L{W - EDGE - RIM} {H / 2}L{EDGE + RIM} {H - EDGE - RIM}Z',
        lines=[],
    )


def hull_bow(hull_right, plate_right, lines_, *, deck_plate_right=None, bow_plate_base=None, bow_outer_base=None):
    # Hull + bow as ONE flat silhouette (the ink wraps both, so the gap
    # between the deck plate and the bow plate is INK, never a hole). The
    # plates themselves can be separate islands — the carrier wants its bow
    # visibly detached from the deck, exactly like the marker art.
    x0, y0, x1, y1 = hull_rect(hull_right)
    outer = rect(x0, y0, x1, y1) + bow_outer(bow_outer_base or hull_right)
    deck_right = deck_plate_right if deck_plate_right is not None else hull_right
    px0, py0, px1, py1 = hull_plate(deck_right)
    plate = rect(px0, py0, px1, py1)
    if bow_plate_base is not None:
        plate += bow_plate(bow_plate_base, plate_right)
    else:
        plate += bow_plate(hull_right, plate_right)
    return dict(outer=outer, plate=plate, lines=lines_)


def cruiser():
    # One slash: clearly diagonal, and biased toward the hull's bow side —
    # the hull-centre placement still read as skewed LEFT against the marker's
    # hull-plus-bow mass (2026-11-07 review), so it sits SLASH_SHIFT right.
    hull_right = 12.4
    mid = (EDGE + hull_right) / 2 + SLASH_SHIFT
    dx = 3.0
    return hull_bow(
        hull_right,
        W - 1.4,
        [line(mid + dx, EDGE + 0.25, mid - dx, H - EDGE - 0.25)],
    )


def battleship():
    # Two parallel slashes, symmetric about the shifted cut line (same
    # bow-side bias as the cruiser) and clearly diagonal.
    hull_right = 12.4
    mid = (EDGE + hull_right) / 2 + SLASH_SHIFT
    dx = 2.6
    gap = 1.6
    return hull_bow(
        hull_right,
        W - 1.4,
        [
            line(mid - gap + dx, EDGE + 0.25, mid - gap - dx, H - EDGE - 0.25),
            line(mid + gap + dx, EDGE + 0.25, mid + gap - dx, H - EDGE - 0.25),
        ],
    )


def aircarrier():
    # The deck reads as TWO deck rectangles that do not touch: the divider
    # line must run the deck's FULL width to the ink rim (a short one left a
    # connecting sliver on the bow side, 2026-11-07 review). The bow chevron
    # is detached from the deck by a narrow ink band — close, not adrift.
    deck_right = 11.6
    bow_base = 12.6
    return hull_bow(
        13.4,
        W - 1.4,
        [line(EDGE + RIM, H / 2, deck_right, H / 2)],
        deck_plate_right=deck_right,
        bow_plate_base=bow_base,
        bow_outer_base=13.4,
    )


def submarine():
    # A hull BAR, then ink, then the bow wedge: the bar's plate and the bow's
    # plate are separate islands inside ONE silhouette.
    x0, y0, x1, y1 = EDGE, EDGE, 5.6, H - EDGE
    outer = rect(x0, y0, x1, y1) + bow_outer(x1)
    plate = rect(EDGE + RIM, EDGE + RIM, 3.4, H - EDGE - RIM) + bow_plate(
        6.2, W - 1.4
    )
    return dict(outer=outer, plate=plate, lines=[])


def auxiliary():
    return hull_bow(14.8, W - 1.4, [])


SHAPES = {
    'battleship': battleship,
    'cruiser': cruiser,
    'destroyer': destroyer,
    'aircarrier': aircarrier,
    'submarine': submarine,
    'auxiliary': auxiliary,
}


def svg(body, width=W, height=H):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">{body}</svg>'
    )


def write_plain(shape):
    # The mask face: ONE solid silhouette (the mask only reads the alpha).
    return svg(f'<path d="{shape["outer"]}" fill="#fff"/>')


def write_two_ink(shape, plate_color, ink):
    body = f'<path d="{shape["outer"]}" fill="{ink}"/>'
    body += f'<path d="{shape["plate"]}" fill="{plate_color}"/>'
    for d in shape['lines']:
        body += (
            f'<path d="{d}" fill="none" stroke="{ink}" '
            f'stroke-width="{SLASH_W}" stroke-linecap="butt"/>'
        )
    return svg(body)


def write_outline(shape):
    body = (
        f'<path d="{shape["outer"]}" fill="none" stroke="{OUTLINE_INK}" '
        f'stroke-width="{SLASH_W}"/>'
    )
    for d in shape['lines']:
        body += (
            f'<path d="{d}" fill="none" stroke="{OUTLINE_INK}" '
            f'stroke-width="{SLASH_W}"/>'
        )
    return svg(body)


def write_sunk(shape):
    return svg(
        f'<path d="{shape["outer"]}" fill="{SUNK_INK[0]}" fill-opacity="0.55" '
        f'stroke="{SUNK_INK[1]}" stroke-opacity="0.3" stroke-width="1.0"/>'
    )


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for cls, factory in SHAPES.items():
        shape = factory()
        files = {
            f'icon_{cls}.svg': write_plain(shape),
            f'icon_ally_{cls}.svg': write_two_ink(shape, *ALLY),
            f'icon_enemy_{cls}.svg': write_two_ink(shape, *ENEMY),
            f'icon_white_{cls}.svg': write_two_ink(shape, *WHITE),
            f'icon_sunk_{cls}.svg': write_sunk(shape),
            f'icon_sunk_enemy_{cls}.svg': write_sunk(shape),
            f'icon_outline_{cls}.svg': write_outline(shape),
        }
        if cls == 'auxiliary':
            # The auxiliary only has the two team faces in shipIcons.ts.
            for name in (
                f'icon_{cls}.svg',
                f'icon_sunk_{cls}.svg',
                f'icon_sunk_enemy_{cls}.svg',
                f'icon_white_{cls}.svg',
                f'icon_outline_{cls}.svg',
            ):
                files.pop(name)
        for name, body in files.items():
            (OUT_DIR / name).write_text(body, encoding='utf-8')
            written += 1
    print(f'{written} ship-class glyphs written to {OUT_DIR}')
    return 0


if __name__ == '__main__':
    sys.exit(main())