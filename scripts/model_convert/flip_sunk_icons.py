#!/usr/bin/env python3
"""Generate sunk-enemy ship icons (horizontally mirrored sunk art).

The game's HUD ships strip has ally icons facing LEFT and enemy icons
facing RIGHT; the sunk art ships facing LEFT. Rendering it verbatim on the
enemy side flips a casualty's direction mid-row, so the enemy side needs a
mirrored copy. Writes icon_sunk_enemy_<class>.webp next to the sources
(the bundled tree ships WebP; a freshly re-extracted .png tree is read as
a fallback so the flip works on both).
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

CLASSES = ["battleship", "cruiser", "destroyer", "aircarrier", "submarine"]


def main() -> None:
    default_dir = Path(__file__).resolve().parents[2] / "packages/webui/src/res/images/ships"
    src_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else default_dir
    for cls in CLASSES:
        src = next(
            (p for p in (src_dir / f"icon_sunk_{cls}{ext}" for ext in (".webp", ".png")) if p.exists()),
            None,
        )
        if src is None:
            print(f"skip {cls}: icon_sunk_{cls}.webp/.png missing")
            continue
        img = Image.open(src)
        out = src_dir / f"icon_sunk_enemy_{cls}.webp"
        img.transpose(Image.FLIP_LEFT_RIGHT).save(out, quality=85, method=6)
        print(f"wrote {out.name} (from {src.name})")


if __name__ == "__main__":
    main()
