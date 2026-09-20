# -*- coding: utf-8 -*-
"""Render the five career-stamp glyph bitmaps (packages/webui/src/res/stamps/).

The seal glyphs use calligraphy fonts that are NOT redistributable (毛体 has
unclear terms; 方正鲁迅行书 is a commercial FounderType font), so the repo
carries only these rendered bitmaps — text-to-graphic use — never the font
files. Re-run locally when a glyph or style changes:

    python scripts/gen_stamp_bitmaps.py \
      --mao "D:/path/草檀斋毛泽东字体.ttf" \
      --luxun "D:/path/方正鲁迅行书.ttf"

Output: 400x400 transparent PNGs (2x the 100-unit SVG box), centered cinnabar
ink with an outline stroke. Single-glyph verdicts (神 / 猴 / 蛆) dominate the face;
four-char composition tags stack two lines (空中 over 小人) into the classic
2x2 seal face. Requires Pillow."""
import argparse
import os

from PIL import Image, ImageDraw, ImageFont

INK = (202, 44, 38, 255)
CANVAS = 400  # 2x supersample of the 100-unit SVG box
MARGIN = 16
STROKE = 6
GAP = 10

# (output name, lines top-to-bottom, which font, font size)
JOBS = [
    ("stamp-miracle.png", ["神"], "mao", 330),
    ("stamp-ape.png", ["猴"], "luxun", 330),
    ("stamp-maggot.png", ["蛆"], "luxun", 330),
    ("stamp-air.png", ["空中", "小人"], "luxun", 165),
    ("stamp-sub.png", ["水下", "小人"], "luxun", 165),
]


def render(lines, font_path: str, font_size: int) -> Image.Image:
    font = ImageFont.truetype(font_path, font_size)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    tiles = []
    for line in lines:
        box = probe.textbbox((0, 0), line, font=font, stroke_width=STROKE)
        w, h = box[2] - box[0], box[3] - box[1]
        tile = Image.new("RGBA", (w + 8, h + 8), (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        d.text((4 - box[0], 4 - box[1]), line, font=font, fill=INK, stroke_width=STROKE, stroke_fill=INK)
        tiles.append(tile)
    width = max(t.width for t in tiles)
    height = sum(t.height for t in tiles) + GAP * (len(tiles) - 1)
    block = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    y = 0
    for t in tiles:
        block.alpha_composite(t, ((width - t.width) // 2, y))
        y += t.height + GAP
    # Fit into the square canvas, centered (aspect preserved).
    scale = min((CANVAS - MARGIN) / block.width, (CANVAS - MARGIN) / block.height, 1.0)
    if scale < 1.0:
        block = block.resize((round(block.width * scale), round(block.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(block, ((CANVAS - block.width) // 2, (CANVAS - block.height) // 2))
    return canvas


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mao", required=True, help="Path to the Mao-calligraphy TTF (神)")
    ap.add_argument("--luxun", required=True, help="Path to the LuXun xingshu TTF (other seals)")
    out = os.path.join(os.path.dirname(__file__), "..", "packages", "webui", "src", "res", "stamps")
    args = ap.parse_args()
    fonts = {"mao": args.mao, "luxun": args.luxun}
    os.makedirs(out, exist_ok=True)
    for name, lines, which, size in JOBS:
        img = render(lines, fonts[which], size)
        path = os.path.join(out, name)
        img.save(path, optimize=True)
        print(f"{name}: {img.size} {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
