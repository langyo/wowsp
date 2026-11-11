#!/usr/bin/env python3
"""Bake the per-ship vertical crop box of the hull silhouette BITMAPS.

For every artwork under packages/webui/src/res/models/silhouettes/*.webp
(the game's own 404x155 HP-plaque silhouettes) compute the alpha bounding
band and emit silhouette_boxes.json:

    { "<INDEX>": [top, bottom] }

`<INDEX>` is the bitmap's stem (the same key shipModelMap carries as
`index`), and [top, bottom] are canvas rows (0..155) that contain the drawn
hull. The shared HoloShipCard crops the plaque board to this band at the
art's native ratio: the pack's art carries large transparent bands above
and below the hull (median content height 86 of 155 px), so drawing the
full canvas made the plaque ~2x taller than the ship it shows. Cropping is
a pure 1:1 crop — the art is never scaled non-uniformly.

Usage:
    python scripts/model_convert/extract_silhouette_boxes.py
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
SILHOUETTES_DIR = (
    REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "silhouettes"
)
DEFAULT_OUT = (
    REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "silhouette_boxes.json"
)


def main() -> int:
    files = sorted(SILHOUETTES_DIR.glob("*.webp"))
    if not files:
        print(f"no silhouettes under {SILHOUETTES_DIR}", file=__import__("sys").stderr)
        return 1
    boxes: dict[str, list[int]] = {}
    for path in files:
        with Image.open(path) as im:
            alpha = im.convert("RGBA").split()[3]
            bbox = alpha.getbbox()
        if bbox is None:
            continue
        _left, top, _right, bottom = bbox
        boxes[path.stem] = [top, bottom]
    DEFAULT_OUT.write_text(
        json.dumps(boxes, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {DEFAULT_OUT.relative_to(REPO_ROOT)}: {len(boxes)} boxes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())