# -*- coding: utf-8 -*-
"""Recut the four-char stamp bitmaps from a 2x2 seal face into one line.

The shipped 过街老鼠 / 空中小人 / 水下小人 glyph bitmaps stack two lines of two
glyphs into the classic 2x2 seal face. The IN-GAME TAB chips want them laid
out flat in a single row instead (the chip rows are far too short for a 2x2
face), while every in-app surface keeps the square faces — so the flat faces
are a SECOND asset set, not a replacement. The calligraphy fonts that
produced the glyphs are NOT redistributable (see gen_stamp_bitmaps.py), so
instead of re-rendering from fonts, this script slices the EXISTING bitmaps
apart and recomposes them:

  1. find the inked block (alpha bbox);
  2. split it into the two stacked lines at the lowest-ink row seam near the
     middle (calligraphy ink never fills the gap, so the minimum-density seam
     is safe);
  3. split each line into its two glyphs at the lowest-ink column seam near
     its middle;
  4. reassemble the four glyph tiles in reading order (TL TR BL BR) into one
     row, then fit the row centered into a fixed 800x200 canvas (4:1, matching
     the wide face's 264x66 glyph box inside RatingStamp's 300x100 viewBox).

Only the four-char kinds have a flat face; 神了 / 海猴 / 蛆 are square in
both sets, so the overlay imports those three straight from res/stamps.
The script is one-shot per generation: it refuses to run on an
already-wide (aspect ≥ 2.5) bitmap — re-run gen_stamp_bitmaps.py first to
restore the 2x2 faces, then recut. Run after a glyph bitmap changes:

    python scripts/recut_stamp_bitmaps.py

Output: stamp-{rat,air,sub}.png (800x200) in
packages/webui/src/res/stamps-wide/ — consumed only by the overlay page's
bare <img> chips (see overlay/main.ts); RatingStamp keeps res/stamps.
Requires Pillow."""
import os

from PIL import Image

HERE = os.path.dirname(__file__)
SRC = os.path.join(HERE, "..", "packages", "webui", "src", "res", "stamps")
OUT = os.path.join(HERE, "..", "packages", "webui", "src", "res", "stamps-wide")
# 4:1 canvas — the overlay chips size seals by height with width auto, so
# the aspect lives entirely in the bitmap.
CANVAS_W, CANVAS_H = 800, 200
MARGIN = 14


def alpha(image: Image.Image) -> Image.Image:
    return image.getchannel("A")


def ink_columns(a: Image.Image, x0: int, x1: int, y0: int, y1: int) -> list[int]:
    """Column ink sums inside the box (for seam hunting)."""
    return [sum(a.getpixel((x, y)) for y in range(y0, y1)) for x in range(x0, x1)]


def ink_rows(a: Image.Image, x0: int, x1: int, y0: int, y1: int) -> list[int]:
    return [sum(a.getpixel((x, y)) for x in range(x0, x1)) for y in range(y0, y1)]


def lowest_ink(values: list[int]) -> int:
    """Index of the minimum-ink position — the seam."""
    return min(range(len(values)), key=lambda i: values[i])


def split_box(a: Image.Image, x0: int, x1: int, y0: int, y1: int) -> list[tuple[int, int, int, int]]:
    """Split the box into four glyph tiles: two stacked lines, each split
    into two glyphs. Seams hunt the quietest strip in the middle third so a
    stray stroke is never cut."""
    mid_row = y0 + lowest_ink(ink_rows(a, x0, x1, y0 + (y1 - y0) // 3, y1 - (y1 - y0) // 3)) + (y1 - y0) // 3
    boxes = []
    for (ly0, ly1) in ((y0, mid_row), (mid_row, y1)):
        mid_col = x0 + lowest_ink(ink_columns(a, x0 + (x1 - x0) // 4, x1 - (x1 - x0) // 4, ly0, ly1)) + (x1 - x0) // 4
        boxes.append((x0, ly0, mid_col, ly1))
        boxes.append((mid_col, ly0, x1, ly1))
    return boxes


def trim(tile: Image.Image, pad: int = 2) -> Image.Image:
    """Trim to ink with a small pad so glyph spacing is normalized."""
    box = alpha(tile).getbbox()
    if box is None:
        return tile
    x0, y0, x1, y1 = box
    return tile.crop((max(0, x0 - pad), max(0, y0 - pad), min(tile.width, x1 + pad), min(tile.height, y1 + pad)))


def recut(name: str) -> None:
    src = Image.open(os.path.join(SRC, name)).convert("RGBA")
    if src.width / src.height >= 2.5:
        # Already a one-line face — slicing again would hunt seams through
        # the glyph row and shred it. Restore the 2x2 face via
        # gen_stamp_bitmaps.py before recutting.
        print(f"{name}: already one line ({src.size}), skipped")
        return
    a = alpha(src)
    bx0, by0, bx1, by1 = a.getbbox()
    tiles = [trim(src.crop(box)) for box in split_box(a, bx0, bx1, by0, by1)]
    gap = 10
    line_w = sum(t.width for t in tiles) + gap * (len(tiles) - 1)
    line_h = max(t.height for t in tiles)
    scale = min((CANVAS_W - 2 * MARGIN) / line_w, (CANVAS_H - 2 * MARGIN) / line_h, 1.0)
    line_w, line_h = round(line_w * scale), round(line_h * scale)
    gap = round(gap * scale)
    tiles = [t.resize((round(t.width * scale), round(t.height * scale)), Image.LANCZOS) for t in tiles]
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    x = (CANVAS_W - line_w) // 2
    for t in tiles:
        canvas.alpha_composite(t, (x, (CANVAS_H - t.height) // 2))
        x += t.width + gap
    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, name)
    canvas.save(out_path, optimize=True)
    print(f"{name}: {[t.size for t in tiles]} -> {canvas.size} {os.path.getsize(out_path)} bytes")


def main() -> None:
    for name in ("stamp-rat.png", "stamp-air.png", "stamp-sub.png"):
        recut(name)


if __name__ == "__main__":
    main()
