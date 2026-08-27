#!/usr/bin/env python3
"""Generate the WoWSP installer art (NSIS wizard + icons).

Produces, from the app logo (packages/app/tauri/icons/icon.png):

- ``icons/installer.ico``      app logo + download-arrow badge → the installer
                               exe looks distinct from the installed app
- ``icons/uninstaller.ico``    same idea with an "×" badge
- ``icons/installer-header.bmp``  150x57 wizard header strip (MUI_HEADERIMAGE)
- ``icons/installer-sidebar.bmp`` 164x314 welcome/finish art (MUI bitmap)

Deterministic output, stdlib + Pillow only:

    python scripts/gen_installer_art.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "packages" / "app" / "tauri"
LOGO = ROOT / "icons" / "icon.png"
OUT = ROOT / "icons"

# Brand palette (matches the webui accent blues).
GRAD_TOP = (16, 48, 82)      # #103052
GRAD_BOTTOM = (27, 114, 208)  # #1B72D0
BADGE_FILL = (29, 155, 240)   # #1D9BF0
BADGE_RING = (255, 255, 255)


def v_gradient(size: tuple[int, int], top, bottom) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        for x in range(w):
            px[x, y] = color
    return img


def draw_arrow(layer: Image.Image, box: tuple[int, int, int, int], width: int, color) -> None:
    """Down-arrow (download glyph) inside `box` = (x0, y0, x1, y1)."""
    d = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = box
    cx = (x0 + x1) / 2
    stem_top = y0
    stem_w = width
    head_h = (y1 - y0) * 0.55
    head_w = (x1 - x0)
    # Stem
    d.rectangle(
        (cx - stem_w / 2, stem_top, cx + stem_w / 2, y1 - head_h * 0.7),
        fill=color,
    )
    # Head (triangle)
    d.polygon(
        [
            (x0, y1 - head_h),
            (x1, y1 - head_h),
            (cx, y1),
        ],
        fill=color,
    )


def compose_icon(logo: Image.Image, badge: str) -> Image.Image:
    """256px master: logo with a bottom-right action badge."""
    size = 256
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    art = logo.resize((size, size), Image.LANCZOS)

    # Slightly shrink the logo so the badge reads at 16px too.
    shrink = int(size * 0.94)
    art = art.resize((shrink, shrink), Image.LANCZOS)
    canvas.paste(art, ((size - shrink) // 2, (size - shrink) // 2), art)

    r = int(size * 0.155)
    cx, cy = int(size * 0.80), int(size * 0.80)
    d = ImageDraw.Draw(canvas)
    # Ring for contrast against any background.
    d.ellipse((cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3), fill=BADGE_RING)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BADGE_FILL)

    inner = (cx - int(r * 0.52), cy - int(r * 0.52), cx + int(r * 0.52), cy + int(r * 0.62))
    badge_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    if badge == "download":
        draw_arrow(badge_layer, inner, width=max(6, r // 3), color=(255, 255, 255, 255))
    else:  # "x" for the uninstaller
        bd = ImageDraw.Draw(badge_layer)
        w = max(7, r // 3)
        off = int(r * 0.38)
        bd.line((cx - off, cy - off, cx + off, cy + off), fill=(255, 255, 255, 255), width=w)
        bd.line((cx - off, cy + off, cx + off, cy - off), fill=(255, 255, 255, 255), width=w)
    canvas = Image.alpha_composite(canvas, badge_layer)
    return canvas


def paste_logo_centered(base: Image.Image, logo: Image.Image, scale: float, y_bias: float = 0.5) -> None:
    h = int(base.height * scale)
    art = logo.resize((h, h), Image.LANCZOS)
    x = (base.width - h) // 2
    y = int((base.height - h) * y_bias)
    base.paste(art, (x, y), art)


def main() -> int:
    logo = Image.open(LOGO).convert("RGBA")

    # Icons: multi-resolution ICO via Pillow's internal downscales.
    installer = compose_icon(logo, "download")
    installer.save(OUT / "installer.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    uninstaller = compose_icon(logo, "x")
    uninstaller.save(OUT / "uninstaller.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # Wizard header strip: gradient + logo anchored left.
    header = v_gradient((150, 57), GRAD_TOP, GRAD_BOTTOM).convert("RGBA")
    art = logo.resize((44, 44), Image.LANCZOS)
    header.paste(art, (8, 6), art)
    # Two chevrons pointing right — "setup in progress" motif.
    chev = Image.new("RGBA", header.size, (0, 0, 0, 0))
    cd = ImageDraw.Draw(chev)
    for i, x in enumerate((112, 126)):
        cd.line(
            (x, 16 + i * 4, x + 12, 28 + i * 2, x, 40 + i * 0),
            fill=(255, 255, 255, 200),
            width=5,
            joint="curve",
        )
    header = Image.alpha_composite(header, chev)
    header.convert("RGB").save(OUT / "installer-header.bmp")

    # Welcome/finish sidebar art: tall gradient + centered logo + arrow.
    sidebar = v_gradient((164, 314), GRAD_TOP, GRAD_BOTTOM).convert("RGBA")
    paste_logo_centered(sidebar, logo, 0.42, y_bias=0.18)
    arrow = Image.new("RGBA", sidebar.size, (0, 0, 0, 0))
    draw_arrow(arrow, (52, 210, 112, 272), width=14, color=(255, 255, 255, 230))
    sidebar = Image.alpha_composite(sidebar, arrow)
    sidebar.convert("RGB").save(OUT / "installer-sidebar.bmp")

    for f in ["installer.ico", "uninstaller.ico", "installer-header.bmp", "installer-sidebar.bmp"]:
        p = OUT / f
        print(f"{p.name}: {p.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
