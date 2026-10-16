#!/usr/bin/env python3
"""Generate the website's 1200x630 social share card (og:image).

Usage:
    python scripts/generate_og_card.py [path/to/logo.webp]

Reads the logo (default: packages/webui/public/logo.webp — the same source
generate_icons.py uses), composites it with the site title and tagline onto
the ocean theme background (#040810, the site's theme-color), and writes
packages/website/src/res/og-card.png. index.html references it through the
worker-served absolute URL https://wowsp.langyo.xyz/wowsp/og-card.png:
Vite copies publicDir (src/res) to the dist root, and
scripts/build_worker_site.py nests the same build under /wowsp/ on the
worker origin (the GitHub Pages mirror serves it at /wowsp/og-card.png too).

Run this after replacing logo.webp with a new design.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOGO = ROOT / "packages/webui/public/logo.webp"
OUT_PATH = ROOT / "packages/website/src/res/og-card.png"

SIZE = (1200, 630)
# The site's theme-color (packages/website/index.html).
BACKGROUND = "#040810"
TITLE = "WoWSP"
SUBTITLE = "World of WarShip Panel"
TAGLINE = "Replay review & in-game overlay for World of Warships."
TITLE_COLOR = "#f2f7ff"
SUBTITLE_COLOR = "#7fb2e5"
TAGLINE_COLOR = "#9db2c9"
# Text block geometry: left edge next to the logo, right margin, gaps.
LOGO_SIZE = 300
TEXT_X = 440
TEXT_RIGHT_MARGIN = 60
GAP_TITLE_SUBTITLE = 36
GAP_SUBTITLE_TAGLINE = 44
TAGLINE_LINE_GAP = 14

DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
DEJAVU_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    if not Path(path).exists():
        print(f"error: font not found: {path} (install fonts-dejavu-core)")
        sys.exit(1)
    return ImageFont.truetype(path, size)


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split(" "):
        candidate = f"{current} {word}".strip()
        if current and draw.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def main() -> None:
    logo_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LOGO
    if not logo_path.exists():
        print(f"error: logo not found: {logo_path}")
        sys.exit(1)

    logo = Image.open(logo_path).convert("RGBA")
    print(f"source: {logo_path} ({logo.size[0]}x{logo.size[1]} {logo.mode})")

    title_font = load_font(DEJAVU_BOLD, 150)
    subtitle_font = load_font(DEJAVU_BOLD, 54)
    tagline_font = load_font(DEJAVU_REGULAR, 38)

    card = Image.new("RGB", SIZE, BACKGROUND)
    logo_img = logo.resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS)
    card.paste(logo_img, (80, (SIZE[1] - LOGO_SIZE) // 2), logo_img)

    draw = ImageDraw.Draw(card)
    max_text_width = SIZE[0] - TEXT_X - TEXT_RIGHT_MARGIN
    tagline_lines = wrap(draw, TAGLINE, tagline_font, max_text_width)

    # Measure the stacked block, then center it vertically as a whole.
    blocks: list[tuple[str, object, str]] = [(TITLE, title_font, TITLE_COLOR),
                                             (SUBTITLE, subtitle_font, SUBTITLE_COLOR)]
    tagline_blocks = [(line, tagline_font, TAGLINE_COLOR) for line in tagline_lines]
    gaps = [GAP_TITLE_SUBTITLE, GAP_SUBTITLE_TAGLINE] + [TAGLINE_LINE_GAP] * (len(tagline_blocks) - 1)
    entries = blocks + tagline_blocks
    heights = []
    for text, font, _ in entries:
        box = draw.textbbox((0, 0), text, font=font)
        heights.append(box[3] - box[1])
    block_height = sum(heights) + sum(gaps[: len(entries) - 1])
    y = (SIZE[1] - block_height) // 2
    for i, (text, font, color) in enumerate(entries):
        box = draw.textbbox((0, 0), text, font=font)
        draw.text((TEXT_X - box[0], y - box[1]), text, font=font, fill=color)
        y += heights[i] + (gaps[i] if i < len(gaps) else 0)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    card.save(OUT_PATH)
    print(f"og card: {OUT_PATH} ({SIZE[0]}x{SIZE[1]}, {OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
