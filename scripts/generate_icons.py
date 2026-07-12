#!/usr/bin/env python3
"""Generate all WoWSP icon assets from a single logo source.

Usage:
    python scripts/generate_icons.py [path/to/logo.webp]

Reads the logo (default: packages/webui/public/logo.webp), converts it to
RGBA, and emits every icon size the Tauri shell + webui need:
  - Tauri bundle: icon.ico, icon.icns, 32/64/128/128@2x png, Windows Store tiles
  - WebUI favicons: 16/32/48 png + favicon.ico + apple-touch + android-chrome

Run this after replacing logo.webp with a new design.
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOGO = ROOT / "packages/webui/public/logo.webp"
ICON_DIR = ROOT / "packages/app/tauri/icons"
PUBLIC_DIR = ROOT / "packages/webui/src/res"

# Tauri bundle png sizes + Windows Store tiles
BUNDLE_PNG_SIZES = [32, 64, 128]
BUNDLE_PNG_RETINA = [256]  # 128x128@2x
STORE_TILES = {
    "Square30x30": 30, "Square44x44": 44, "Square71x71": 71,
    "Square89x89": 89, "Square107x107": 107, "Square142x142": 142,
    "Square150x150": 150, "Square284x284": 284, "Square310x310": 310,
}
STORE_LOGO_SIZE = 50

# WebUI favicon sizes
FAVICON_SIZES = [16, 32, 48]
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
APPLE_TOUCH = 180
ANDROID_SIZES = [192, 512]


def main():
    logo_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LOGO
    if not logo_path.exists():
        print(f"error: logo not found: {logo_path}")
        sys.exit(1)

    img = Image.open(logo_path).convert("RGBA")
    print(f"source: {logo_path} ({img.size[0]}x{img.size[1]} {img.mode})")

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    # --- Tauri bundle icons ---
    for s in BUNDLE_PNG_SIZES:
        img.resize((s, s), Image.LANCZOS).save(ICON_DIR / f"{s}x{s}.png")
    for s in BUNDLE_PNG_RETINA:
        img.resize((s, s), Image.LANCZOS).save(ICON_DIR / "128x128@2x.png")
    # icon.png (128x128, for window icon reference)
    img.resize((128, 128), Image.LANCZOS).save(ICON_DIR / "icon.png")
    print(f"  bundle png: {BUNDLE_PNG_SIZES} + 128x128@2x + icon.png")

    # Windows Store tiles
    for name, s in STORE_TILES.items():
        img.resize((s, s), Image.LANCZOS).save(ICON_DIR / f"{name}Logo.png")
    img.resize((STORE_LOGO_SIZE, STORE_LOGO_SIZE), Image.LANCZOS).save(ICON_DIR / "StoreLogo.png")
    print(f"  store tiles: {len(STORE_TILES) + 1} files")

    # .ico (Windows multi-size)
    img.save(ICON_DIR / "icon.ico", format="ICO", sizes=ICO_SIZES)
    print(f"  icon.ico ({len(ICO_SIZES)} sizes)")

    # .icns (macOS) — PIL doesn't support icns write well; skip if fails
    try:
        img.save(ICON_DIR / "icon.icns", format="ICNS")
        print("  icon.icns")
    except Exception:
        print("  icon.icns skipped (PIL icns limitation)")

    # --- WebUI favicons + logo (Vite publicDir = src/res) ---
    img.resize((256, 256), Image.LANCZOS).save(PUBLIC_DIR / "logo.webp", format="WEBP", quality=95)
    for s in FAVICON_SIZES:
        img.resize((s, s), Image.LANCZOS).save(PUBLIC_DIR / f"favicon-{s}x{s}.png")
    img.resize((16, 16), Image.LANCZOS).save(PUBLIC_DIR / "favicon.ico", format="ICO")
    img.resize((APPLE_TOUCH, APPLE_TOUCH), Image.LANCZOS).save(PUBLIC_DIR / "apple-touch-icon.png")
    for s in ANDROID_SIZES:
        img.resize((s, s), Image.LANCZOS).save(PUBLIC_DIR / f"android-chrome-{s}x{s}.png")
    print(f"  favicons: {FAVICON_SIZES} + apple-touch({APPLE_TOUCH}) + android({ANDROID_SIZES})")

    print("done.")


if __name__ == "__main__":
    main()
