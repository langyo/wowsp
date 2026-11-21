#!/usr/bin/env python3
"""Dump the alpha channel of the HUD ship-class icons as ASCII grids.

Step 1 of the ship-glyph pipeline (step 2 is scripts/trace_icons.ts, which
Moore-traces the grids into vector polygons for packages/holo's glyph
atlas): each packages/website/src/res/icons/ships/icon_<class>.png becomes
an "y|<row>" line per pixel row with '#' (alpha > 160), '+' (60..160) and
'.' (< 60), written to <outdir>/icon_<class>.txt.

Repo policy (AGENTS.md section 6): helper scripts are Python and run
through justfile recipes — this one is 'just dump-icon-grids' (the recipe
resolves Python via celestia-devtools' python_cmd). Requires Pillow.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLASSES = ("destroyer", "cruiser", "battleship", "aircarrier", "submarine")
SOLID, FAINT, EMPTY = "#", "+", "."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--outdir",
        type=Path,
        default=REPO_ROOT / "tmp",
        help="output directory for icon_<class>.txt (default: <repo>/tmp)",
    )
    parser.add_argument(
        "--classes", nargs="*", default=list(CLASSES), choices=CLASSES,
        help="subset of ship classes to dump (default: all five)",
    )
    args = parser.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("Pillow is required: pip install Pillow", file=sys.stderr)
        return 2

    args.outdir.mkdir(parents=True, exist_ok=True)
    for cls in args.classes:
        src = REPO_ROOT / "packages/website/src/res/icons/ships" / f"icon_{cls}.png"
        with Image.open(src) as img:
            alpha = img.convert("RGBA").getchannel("A")
        px = alpha.tobytes()  # one byte per pixel, row-major
        w, h = alpha.width, alpha.height
        lines = []
        for y in range(h):
            row = "".join(
                SOLID if px[y * w + x] > 160 else FAINT if px[y * w + x] > 60 else EMPTY
                for x in range(w)
            )
            lines.append(f"{y}|{row}")
        out = args.outdir / f"icon_{cls}.txt"
        out.write_text("\n".join(lines) + "\n", encoding="ascii", newline="\n")
        print(f"dumped {cls} -> {out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
