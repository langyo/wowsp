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
holes (the 'drafty' carrier of 2026-11-07). The ENEMY faces are authored
as the horizontal MIRROR of the ally faces (see mirrored()): the game's
two fleets face each other across the top strip, so the enemy bow points
LEFT — the traced WebP era carried the flip and the geometry rewrite
dropped it (2026-11-11 review).

INK RULE (2026-11-07 review: the ink line has to be black on every face).
The ink is BLACK on every plate face. The game's own markers ink black too:
the green/red tint the first pass sampled off the WebP copies was chroma
bleed around the thin black lines, not paint. Team identity lives in the
PLATE only. The one deliberate exception is the SUNK face, which INVERTS
the pair (black plate, white ink) so the dead state reads as its own state
marker — the review's "special icon-marking nature". (The outline face is
not a plate face: it is an alpha mask, and its white strokes carry only the
alpha the mask reads.) The plain mask face
cannot paint a black line at all (one alpha channel), so it keeps the class
engraving as PUNCHED SLITS: the ink lines AND the carrier's deck/bow plate
seam (the ink band between the deck and bow plates) are cut out of the
silhouette. The submarine needs no punch: its bar and bow are authored as
two DETACHED silhouette islands, so the gap is open on every face.

SLASH RULE (2026-11-12 review: the slash straddles the drawn mass). The
speed slashes sit symmetric about the SILHOUETTE's area centroid — hull
rectangle and bow wedge weighted by area (silhouette_centroid_x()) — which
is where the game's own markers centre the engraving. The old SLASH_SHIFT
constant offset the axis from the hull centreline and still landed ~0.8 art
units stern of that centroid, which read as the marker leaning.

RIM NOTE (same review, kept as authored): the bow ink thins toward the tip
(0.9 at the hull to ~0.52 on the battleship wedge, ~0.23 on the destroyer)
because the plates follow the game's own SCREEN-SPACE outline — its 27 px
markers draw a ~1 px ring that narrows the same way over their shallow
wedges. Do not re-level this to a perpendicular inset: it would make the
nose ink several times heavier than the original markers.

Variants (6 classes x 7 faces = 42 files, the names shipIcons.ts imports):

  icon_<class>.svg          plain  — silhouette + punched engraving (CSS mask)
  icon_ally_<class>.svg     ally   — mint plate, black ink
  icon_enemy_<class>.svg    enemy  — salmon plate, black ink; the ally face
                            MIRRORED (bow LEFT — the fleets face each other)
  icon_white_<class>.svg    white  — light plate, black ink
  icon_sunk_<class>.svg     sunk   — inverted state marker: black plate, white ink
  icon_sunk_enemy_<class>.svg       the enemy row's inverted state face
                                    (mirrored like the enemy face)
  icon_outline_<class>.svg  outline— white line-art alpha mask, no plate

Every class carries every face. The auxiliary hull used to stop at the two
team faces, which left dead or neutral auxiliary rows with an empty icon
slot (a sunk auxiliary also missed the minimap art); it draws from the same
shape set now.

Usage:
    python scripts/model_convert/ship_class_glyphs.py
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / 'packages' / 'webui' / 'src' / 'res' / 'images' / 'ships'

W, H = 20.0, 11.0  # the marker art box
RIM = 0.9          # ink rim width (silhouette minus plate)
SLASH_W = 1.1      # speed-slash / divider line width
EDGE = 0.5         # silhouette inset from the art box

# ── palettes ──
# One black ink for every plate face (see the INK RULE above); the plate is
# the only per-team colour. The sunk face flips the pair.
INK = '#000000'
ALLY = ('#50e8b0', INK)
ENEMY = ('#f85030', INK)
WHITE = ('#e8e8e8', INK)
SUNK_PLATE, SUNK_INK = INK, '#ffffff'
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


def silhouette_centroid_x(hull_right):
    """The silhouette's AREA centroid x — hull rectangle and bow wedge
    weighted by area. The speed slashes straddle THIS line: the game's own
    markers centre the slash on the drawn mass, while a fixed offset from
    the hull centreline (the old SLASH_SHIFT) sat ~0.8 art units stern of
    it and read as the marker leaning."""
    hull_area = (hull_right - EDGE) * (H - 2 * EDGE)
    hull_x = (EDGE + hull_right) / 2
    bow_area = 0.5 * (H - 2 * EDGE) * (W - EDGE - hull_right)
    bow_x = (2 * hull_right + W - EDGE) / 3
    return (hull_area * hull_x + bow_area * bow_x) / (hull_area + bow_area)


# ── per-class geometry ──
# Every shape is flat: hull rectangles, bow triangles, straight lines.


def destroyer():
    # A full flat wedge: vertical stern edge, pointed bow.
    return dict(
        outer=f'M{EDGE} {EDGE}L{W - EDGE} {H / 2}L{EDGE} {H - EDGE}Z',
        plate=f'M{EDGE + RIM} {EDGE + RIM}L{W - EDGE - RIM} {H / 2}L{EDGE + RIM} {H - EDGE - RIM}Z',
        lines=[],
        seams=[],
    )


def hull_bow(hull_right, plate_right, lines_, *, deck_plate_right=None, bow_plate_base=None, bow_outer_base=None, seams=None):
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
    return dict(outer=outer, plate=plate, lines=lines_, seams=seams or [])


def cruiser():
    # One slash: clearly diagonal, and centred on the marker's drawn mass —
    # the silhouette's area centroid (hull rectangle + bow wedge), which is
    # where the game's own markers centre the engraving. A fixed offset from
    # the hull centreline left the axis stern of that centroid and read as
    # the marker leaning (2026-11-12 review).
    hull_right = 12.4
    mid = silhouette_centroid_x(hull_right)
    dx = 3.0
    return hull_bow(
        hull_right,
        W - 1.4,
        [line(mid + dx, EDGE + 0.25, mid - dx, H - EDGE - 0.25)],
    )


def battleship():
    # Two parallel slashes, symmetric about the silhouette's area centroid
    # (same spine as the cruiser) and clearly diagonal.
    hull_right = 12.4
    mid = silhouette_centroid_x(hull_right)
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
        # The deck/bow ink band: the plain face punches it as a seam so the
        # chevron still reads detached in the one-colour mask.
        seams=[rect(deck_right, EDGE + RIM, bow_base, H - EDGE - RIM)],
    )


def submarine():
    # A hull BAR and the bow wedge as TWO DETACHED silhouette islands. The
    # game's own marker splits the bar from the bow with a transparent gap
    # (the trace pass's connected components find two separate bands), and
    # the joined silhouette authored earlier still read as one connected
    # shape (2026-11-08 review: the bar must sit SEPARATE from the bow, not
    # ink-bridged to it). Each island keeps its own full rim, so every face
    # shows bar | open gap | wedge and no punched slit is needed. The gap is
    # wider than the outline face's stroke pair (2 x SLASH_W / 2 = 1.1) — a
    # narrower slit would let the two strokes kiss and bridge the line art.
    bar_right = 3.9  # bar plate's right edge (3.0) + RIM
    bow_base = 5.6   # bow plate's base (6.5) - RIM; the gap runs 3.9..5.6
    outer = rect(EDGE, EDGE, bar_right, H - EDGE) + bow_outer(bow_base)
    plate = rect(EDGE + RIM, EDGE + RIM, 3.0, H - EDGE - RIM) + bow_plate(
        6.5, W - 1.4
    )
    return dict(outer=outer, plate=plate, lines=[], seams=[])


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


def _clip_to_band(points, y_min, y_max):
    """Clip a convex polygon to the horizontal band [y_min, y_max].

    The slice's butt corners poke a hair past the hull's top/bottom edge
    (the slash centreline stops 0.25 art units short of it, the stroke's
    half-width is 0.55) — and under even-odd fill the part that lands
    OUTSIDE the silhouette would be painted back in as a white spur. The
    slashes only ever cross those two horizontal edges, so a band clip is
    exactly the silhouette clip they need."""

    def clip(pts, y, keep_above):
        out = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            cur_in = cur[1] >= y if keep_above else cur[1] <= y
            prev_in = prev[1] >= y if keep_above else prev[1] <= y
            if cur_in:
                if not prev_in:
                    out.append(cross(prev, cur, y))
                out.append(cur)
            elif prev_in:
                out.append(cross(prev, cur, y))
        return out

    def cross(a, b, y):
        t = (y - a[1]) / (b[1] - a[1])
        return (a[0] + (b[0] - a[0]) * t, y)

    clipped = clip(points, y_min, True)
    if clipped:
        clipped = clip(clipped, y_max, False)
    return clipped


def slash_quad(line_d):
    """The ink line's footprint, clipped to the art's horizontal ink edge —
    the plain face PUNCHES it out of the silhouette (even-odd), so the
    engraving survives in the one-alpha-channel mask face the rows and chips
    draw."""
    (x0, y0), (x1, y1) = (
        tuple(float(v) for v in point.split())
        for point in line_d[1:].split('L')
    )
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / length * SLASH_W / 2, dx / length * SLASH_W / 2
    quad = [
        (x0 + nx, y0 + ny),
        (x1 + nx, y1 + ny),
        (x1 - nx, y1 - ny),
        (x0 - nx, y0 - ny),
    ]
    quad = _clip_to_band(quad, EDGE, H - EDGE)
    if len(quad) < 3:
        return ''

    def n(v):
        # Trim float noise: the generated art is read (and diffed) as text.
        return f'{v:.3f}'.rstrip('0').rstrip('.')

    return 'M' + 'L'.join(f'{n(x)} {n(y)}' for x, y in quad) + 'Z'


def write_plain(shape):
    # The mask face: ONE solid silhouette with the engraving punched through
    # (it is drawn as a CSS mask over the surrounding text ink, so an ink
    # line can only read as the gap the ink would occupy). BOTH parts of the
    # engraving are punched: the speed slashes / deck divider lines, and the
    # plate seams — the ink bands between plate islands (the carrier's
    # detached bow) that the plate face shows as black gaps. Disjoint
    # silhouettes (the submarine's bar/bow gap) need no punch.
    engraving = ''.join(slash_quad(d) for d in shape['lines'])
    # (slash_quad clips its quad to the silhouette's top/bottom ink edge — a
    # raw stroke footprint would paint a sub-pixel white spur outside it.)
    engraving += ''.join(shape['seams'])
    return svg(
        f'<path d="{shape["outer"]}{engraving}" fill="#fff" fill-rule="evenodd"/>'
    )


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
    # The inverted state marker: the plate/ink pair flips (black plate, white
    # ink) so a dead ship reads as its own marker instead of a dimmed team one.
    return write_two_ink(shape, SUNK_PLATE, SUNK_INK)


def _trim(v):
    # Trim float noise: the generated art is read (and diffed) as text.
    return f'{v:.3f}'.rstrip('0').rstrip('.')


def mirror_path(d):
    """Flip authored path data horizontally about the art box (x -> W - x).

    Accepts whole d strings (multi-subpath paths — the hull+bow outer is
    two subpaths — mirror per subpath). The geometry only ever emits
    absolute M/L/H/V/Z commands, so the mirror
    is a coordinate pass: M/L/H carry x (flipped), V carries y (kept), Z
    takes none. M/L coordinates alternate x,y starting at x; H/V stay on
    their single axis. Tokens are rejoined with single spaces — bare
    concatenation would fuse adjacent numbers (0.5 followed by 5.5 emits
    '0.55.5', which reparses as 0.55 / 0.5)."""
    out = []
    cmd = 'M'
    axis = 'x'  # axis of the next number
    for tok in re.finditer(r'[A-Z]|-?(?:\d+\.\d+|\d+|\.\d+)', d):
        s = tok.group(0)
        if s.isalpha():
            out.append(s)
            cmd = s
            axis = {'M': 'x', 'L': 'x', 'H': 'x', 'V': 'y'}.get(cmd, axis)
        elif axis == 'x':
            out.append(_trim(W - float(s)))
            axis = 'y' if cmd in ('M', 'L') else 'x'
        else:
            out.append(s)
            axis = 'x' if cmd in ('M', 'L') else 'y'
    return ' '.join(out)


def mirrored(shape):
    """The enemy-row faces: the ally face MIRRORED horizontally (bow LEFT).

    The game's top strip points the two fleets at each other — ally art
    faces RIGHT and the enemy art is its horizontal mirror. The traced
    WebP era carried the flip; the geometry rewrite dropped it and both
    rows pointed the same way (2026-11-11 review). Every subpath mirrors:
    silhouette, plate, the ink slashes, and the plain face's punched
    seams."""
    return dict(
        outer=mirror_path(shape['outer']),
        plate=mirror_path(shape['plate']),
        lines=[mirror_path(d) for d in shape['lines']],
        seams=[mirror_path(s) for s in shape['seams']],
    )


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for cls, factory in SHAPES.items():
        shape = factory()
        files = {
            f'icon_{cls}.svg': write_plain(shape),
            f'icon_ally_{cls}.svg': write_two_ink(shape, *ALLY),
            f'icon_enemy_{cls}.svg': write_two_ink(mirrored(shape), *ENEMY),
            f'icon_white_{cls}.svg': write_two_ink(shape, *WHITE),
            f'icon_sunk_{cls}.svg': write_sunk(shape),
            f'icon_sunk_enemy_{cls}.svg': write_sunk(mirrored(shape)),
            f'icon_outline_{cls}.svg': write_outline(shape),
        }
        for name, body in files.items():
            (OUT_DIR / name).write_text(body, encoding='utf-8')
            written += 1
    print(f'{written} ship-class glyphs written to {OUT_DIR}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
