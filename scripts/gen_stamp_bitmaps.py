# -*- coding: utf-8 -*-
"""Render the four career-stamp glyph bitmaps (packages/webui/src/res/stamps/).

The seal glyphs use calligraphy fonts that are NOT redistributable (毛体 has
unclear terms; 方正鲁迅行书 is a commercial FounderType font), so the repo
carries only these rendered bitmaps — text-to-graphic use — never the font
files. Re-run locally when a glyph or style changes:

    python scripts/gen_stamp_bitmaps.py \
      --mao "D:/path/草檀斋毛泽东字体.ttf" \
      --luxun "D:/path/方正鲁迅行书.ttf"

Output: 400x400 transparent PNGs (2x the 100-unit SVG box), text centered in
cinnabar ink with an outline stroke; two-glyph stamps pre-stretched 2x
vertically (the seal's 2/3-height look). Requires Pillow."""
import argparse
import os

from PIL import Image, ImageDraw, ImageFont

INK = (202, 44, 38, 255)
CANVAS = 400  # 2x supersample of the 100-unit SVG box
FONT_SIZE = 190
STROKE = 6

# (output name, text, which font, vertically stretch 2-char seals)
JOBS = [
    ("stamp-miracle.png", "神了", "mao", True),
    ("stamp-ape.png", "海猴", "luxun", True),
    ("stamp-air.png", "空中小人", "luxun", False),
    ("stamp-sub.png", "水下小人", "luxun", False),
]


def render(text: str, font_path: str, stretch: bool) -> Image.Image:
    font = ImageFont.truetype(font_path, FONT_SIZE)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    box = probe.textbbox((0, 0), text, font=font, stroke_width=STROKE)
    w, h = box[2] - box[0], box[3] - box[1]
    tile = Image.new("RGBA", (w + 8, h + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    d.text((4 - box[0], 4 - box[1]), text, font=font, fill=INK, stroke_width=STROKE, stroke_fill=INK)
    if stretch:
        tile = tile.resize((tile.width, tile.height * 2), Image.LANCZOS)
    # Fit into the square canvas, centered (aspect preserved).
    scale = min((CANVAS - 16) / tile.width, (CANVAS - 16) / tile.height, 1.0)
    if scale < 1.0:
        tile = tile.resize((round(tile.width * scale), round(tile.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(tile, ((CANVAS - tile.width) // 2, (CANVAS - tile.height) // 2))
    return canvas


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mao", required=True, help="Path to the Mao-calligraphy TTF (神了)")
    ap.add_argument("--luxun", required=True, help="Path to the LuXun xingshu TTF (other seals)")
    out = os.path.join(os.path.dirname(__file__), "..", "packages", "webui", "src", "res", "stamps")
    args = ap.parse_args()
    fonts = {"mao": args.mao, "luxun": args.luxun}
    os.makedirs(out, exist_ok=True)
    for name, text, which, stretch in JOBS:
        img = render(text, fonts[which], stretch)
        path = os.path.join(out, name)
        img.save(path, optimize=True)
        print(f"{name}: {img.size} {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
