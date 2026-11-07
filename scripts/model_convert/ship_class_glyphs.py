#!/usr/bin/env python3
"""Author the battle-HUD ship-class markers as GEOMETRY, not traced pixels.

The faces used to be 27 px WebP bitmaps; the first vectorisation pass traced
them, which baked the bitmap's pixel stair-steps into the paths (a hull edge
came out as a run of straight segments, the 'steep slashes' of the
2026-11-07 review). The markers are simple GEOMETRIC art — a rounded hull,
a bow wedge and the speed slashes — so there is nothing to trace: this
script draws them directly with the SVG primitives and emits the whole
37-file variant set the app imports.

Geometry space is the marker's 20 x 11 art box (x right = bow, y down):

  destroyer    a full wedge (vertical stern edge, pointed bow)
  cruiser      rounded hull + bow wedge + one speed slash
  battleship   rounded hull + bow wedge + two speed slashes
  aircarrier   two deck bars + bow wedge
  submarine    a narrow hull bar + bow wedge
  auxiliary    a long rounded hull + short bow wedge (no slash)

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

W, H = 20.0, 11.0  # the marker art box (the game canvas' silhouette bounds)

# ── palettes (sampled from the original markers) ──
ALLY = ('#50e8b0', '#0b1f16')
ENEMY = ('#f85030', '#2a0a06')
WHITE = ('#e8e8e8', '#000000')
SUNK_INK = ('#000000', '#ffffff')
OUTLINE_INK = '#ffffff'


def rrect(x, y, w, h, r):
    'Rounded-rect subpath (clockwise).'
    right, bottom = x + w, y + h
    return (
        f'M{x + r:.2f} {y:.2f}H{right - r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {right:.2f} {y + r:.2f}'
        f'V{bottom - r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {right - r:.2f} {bottom:.2f}'
        f'H{x + r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {x:.2f} {bottom - r:.2f}'
        f'V{y + r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {x + r:.2f} {y:.2f}Z'
    )


def hull(x, y, w, h, r):
    'Hull body: rounded STERN corners, square bow-side edge (the bow wedge\'s'
    '    base is flush against it).'
    '    '
    right, bottom = x + w, y + h
    return (
        f'M{x + r:.2f} {y:.2f}H{right:.2f}V{bottom:.2f}H{x + r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {x:.2f} {bottom - r:.2f}'
        f'V{y + r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {x + r:.2f} {y:.2f}Z'
    )


def stern_wedge(stern_x, tip_x, y0=0.0, y1=H, r=1.2):
    'Wedge with a vertical rounded-stern edge and a pointed bow.'
    mid = (y0 + y1) / 2
    return (
        f'M{stern_x + r:.2f} {y0:.2f}'
        f'L{tip_x:.2f} {mid:.2f}'
        f'L{stern_x + r:.2f} {y1:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {stern_x:.2f} {y1 - r:.2f}'
        f'V{y0 + r:.2f}'
        f'A{r:.2f} {r:.2f} 0 0 1 {stern_x + r:.2f} {y0:.2f}Z'
    )


def wedge(base_x, tip_x, y0=0.0, y1=H):
    'Bow wedge: a triangle from the hull edge to the bow tip (mid-height).'
    return (
        f'M{base_x:.2f} {y0:.2f}L{tip_x:.2f} {(y0 + y1) / 2:.2f}L{base_x:.2f} {y1:.2f}Z'
    )


def destroyer():
    # One wedge for the whole hull: vertical stern edge, pointed bow.
    return {'outer': stern_wedge(0.0, W, 0.0, H), 'plate': stern_wedge(0.9, W - 1.1, 0.9, H - 0.9), 'slashes': []}


def cruiser():
    outer = hull(0, 0, 12.2, H, 2.2) + wedge(12.2, W)
    plate = hull(0.9, 0.9, 11.3, H - 1.8, 1.5) + wedge(11.3, W - 1.1, 0.9, H - 0.9)
    return {'outer': outer, 'plate': plate, 'slashes': [((10.6, 0.8), (6.2, 10.2))]}


def battleship():
    outer = hull(0, 0, 12.2, H, 2.2) + wedge(12.2, W)
    plate = hull(0.9, 0.9, 11.3, H - 1.8, 1.5) + wedge(11.3, W - 1.1, 0.9, H - 0.9)
    return {
        'outer': outer,
        'plate': plate,
        'slashes': [((9.4, 0.8), (5.0, 10.2)), ((12.6, 0.8), (8.2, 10.2))],
    }


def aircarrier():
    outer = rrect(0, 0, 12.2, 4.5, 1.6) + rrect(0, 6.5, 12.2, 4.5, 1.6) + wedge(12.2, W)
    plate = rrect(0.9, 0.9, 11.3, 2.9, 1.2) + rrect(0.9, 7.1, 11.3, 2.9, 1.2) + wedge(11.3, W - 1.1, 0.9, H - 0.9)
    return {'outer': outer, 'plate': plate, 'slashes': []}


def submarine():
    outer = rrect(0, 0, 3.1, H, 1.4) + stern_wedge(5.0, W)
    plate = rrect(0.8, 0.8, 1.9, H - 1.6, 0.9) + stern_wedge(5.9, W - 1.1, 0.9, H - 0.9)
    return {'outer': outer, 'plate': plate, 'slashes': []}


def auxiliary():
    outer = hull(0, 0, 15.0, H, 2.2) + wedge(15.0, W)
    plate = hull(0.9, 0.9, 13.9, H - 1.8, 1.5) + wedge(14.1, W - 1.1, 0.9, H - 0.9)
    return {'outer': outer, 'plate': plate, 'slashes': []}


SHAPES = {
    'battleship': battleship,
    'cruiser': cruiser,
    'destroyer': destroyer,
    'aircarrier': aircarrier,
    'submarine': submarine,
    'auxiliary': auxiliary,
}


def svg(body: str, width: float = W, height: float = H) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.2f}" height="{height:.2f}" '
        f'viewBox="0 0 {width:.2f} {height:.2f}">{body}</svg>'
    )


def slash_d(slashes) -> str:
    return ''.join(f'M{a[0]:.2f} {a[1]:.2f}L{b[0]:.2f} {b[1]:.2f}' for a, b in slashes)


def write_plain(shape: dict) -> str:
    # The mask face: ONE solid silhouette (no rim/slash detail — the mask
    # only reads alpha, and the game's plain marker is a solid plate).
    return svg(f'<path d="{shape["outer"]}" fill="#fff"/>')


def write_two_ink(shape: dict, plate_color: str, ink: str) -> str:
    body = f'<path d="{shape["outer"]}" fill="{ink}"/>'
    body += f'<path d="{shape["plate"]}" fill="{plate_color}"/>'
    if shape['slashes']:
        body += (
            f'<path d="{slash_d(shape["slashes"])}" fill="none" stroke="{ink}" '
            'stroke-width="1.1" stroke-linecap="round"/>'
        )
    return svg(body)


def write_outline(shape: dict) -> str:
    # White ink, no plate: the hint cards press this face.
    body = (
        f'<path d="{shape["outer"]}" fill="none" stroke="{OUTLINE_INK}" '
        'stroke-width="1.1" stroke-linejoin="round"/>'
    )
    if shape['slashes']:
        body += (
            f'<path d="{slash_d(shape["slashes"])}" fill="none" stroke="{OUTLINE_INK}" '
            'stroke-width="1.1" stroke-linecap="round"/>'
        )
    return svg(body)


def write_sunk(shape: dict) -> str:
    # A sunk hull: translucent black fill under a faint white rim.
    body = (
        f'<path d="{shape["outer"]}" fill="{SUNK_INK[0]}" fill-opacity="0.55" '
        f'stroke="{SUNK_INK[1]}" stroke-opacity="0.3" stroke-width="1.0" '
        'stroke-linejoin="round"/>'
    )
    return svg(body)


def main() -> int:
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
        # The plain family has no auxiliary face (the app only imports the
        # coloured auxiliaries); the sunk family has no auxiliary either.
        if cls == 'auxiliary':
            # The auxiliary only has the two team faces in shipIcons.ts.
            files.pop(f'icon_{cls}.svg')
            files.pop(f'icon_sunk_{cls}.svg')
            files.pop(f'icon_sunk_enemy_{cls}.svg')
            files.pop(f'icon_white_{cls}.svg')
            files.pop(f'icon_outline_{cls}.svg')
        for name, body in files.items():
            (OUT_DIR / name).write_text(body, encoding='utf-8')
            written += 1
    print(f'{written} ship-class glyphs written to {OUT_DIR}')
    return 0


if __name__ == '__main__':
    sys.exit(main())