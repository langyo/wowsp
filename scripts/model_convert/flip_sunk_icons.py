#!/usr/bin/env python3
"""Generate sunk-enemy ship icons (horizontally mirrored sunk art).

The game's HUD ships strip has ally icons facing LEFT and enemy icons
facing RIGHT; the sunk art ships facing LEFT. Rendering it verbatim on the
enemy side flips a casualty's direction mid-row, so the enemy side needs a
mirrored copy. Writes icon_sunk_enemy_<class>.png next to the sources.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

CLASSES = ["battleship", "cruiser", "destroyer", "aircarrier", "submarine"]


def main() -> None:
    src_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] /         "packages/webui/src/res/images/ships"
    for cls in CLASSES:
        src = src_dir / f"icon_sunk_{cls}.png"
        if not src.exists():
            print(f"skip {cls}: {src} missing")
            continue
        img = Image.open(src)
        out = src_dir / f"icon_sunk_enemy_{cls}.png"
        img.transpose(Image.FLIP_LEFT_RIGHT).save(out)
        print(f"wrote {out.name}")


if __name__ == "__main__":
    main()
