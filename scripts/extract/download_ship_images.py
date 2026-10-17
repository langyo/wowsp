#!/usr/bin/env python3
"""Download and cache all ship portrait images from the WG CDN.

Reads the ship encyclopedia cache (populated by the Tauri app) to get each
ship's image URLs, downloads the `medium` portrait, re-encodes it to
packages/webui/src/res/images/ships/<shipId>.webp (quality 85, method 6 —
the res-WebP settings shared with convert_res_webp.py), and generates an
index mapping shipId → local filename. This makes images available offline
and removes the runtime dependency on the WG CDN.

The script is idempotent: ships whose image is already cached are skipped.
`--reencode-existing` is the one-shot that migrates a tree holding old
.png portraits: every [0-9]*.png is converted in place (verified, then the
.png deleted) and the index entries flipped to the .webp filename.

Usage:
    python scripts/extract/download_ship_images.py
    python scripts/extract/download_ship_images.py --force
    python scripts/extract/download_ship_images.py --size large
    python scripts/extract/download_ship_images.py --reencode-existing

    just download-ship-images
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from convert_res_webp import png_bytes_to_webp

REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGES_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "images" / "ships"
INDEX_FILE = IMAGES_OUT / "_index.json"

# Encyclopedia cache location.
ENCYCLOPEDIA_GLOB = "ships-*-s2.json"


def wg_to_short_code(wg: str) -> str:
    """Map a WG API language code to the app's internal locale short-code.

    WG codes like "zh-cn" and "zh-sg" both resolve to "zhs" (Simplified
    Chinese). The compound tag used for cache/file naming is
    ``<short_code>-<realm>`` (e.g. "zhs-asia", "zht-asia", "en-asia").
    """
    _MAP = {
        "zh-cn": "zhs",
        "zh-sg": "zhs",
        "zh-tw": "zht",
        "en": "en",
        "ja": "ja",
        "ko": "ko",
        "ru": "ru",
        "fr": "fr",
        "es": "es",
    }
    return _MAP.get(wg, "en")


def load_ships() -> list[dict]:
    import glob

    appdata = os.environ.get("APPDATA", os.path.expanduser("~/.local/share"))
    wowsp_dir = Path(appdata) / "WoWSP" / "encyclopedia"
    files = sorted(glob.glob(str(wowsp_dir / ENCYCLOPEDIA_GLOB)))
    if not files:
        print(f"error: no encyclopedia cache in {wowsp_dir}. Run the app first.", file=sys.stderr)
        sys.exit(1)
    with open(files[-1]) as f:
        data = json.load(f)
    return data.get("ships", data.get("data", []))


def reencode_existing(index: dict[str, str]) -> int:
    """Convert the tree's legacy [0-9]*.png portraits to .webp in place.

    The maintainer's one-shot for a pre-WebP local tree: each .png is
    re-encoded (q85/method 6), the written .webp re-opened for a dimension
    sanity check, and only then is the .png deleted and the index entry
    flipped. A .png whose .webp sibling already exists is stale and goes
    without a re-encode."""
    converted = 0
    for png in sorted(IMAGES_OUT.glob("[0-9]*.png")):
        webp = png.with_suffix(".webp")
        if not webp.exists():
            blob = png_bytes_to_webp(png.read_bytes(), lossless=False)
            webp.write_bytes(blob)
            from PIL import Image

            with Image.open(webp) as check, Image.open(png) as src:
                if check.size != src.size:
                    webp.unlink()
                    print(f"  ✗ {png.name}: verify failed, kept .png", file=sys.stderr)
                    continue
        png.unlink()
        if index.get(png.stem) == png.name:
            index[png.stem] = webp.name
        converted += 1
    if converted:
        print(f"[download-images] re-encoded {converted} existing portraits to .webp")
    return converted


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Download + cache ship portrait images")
    parser.add_argument("--force", action="store_true", help="re-download even if cached")
    parser.add_argument("--size", default="medium", choices=["small", "medium", "large"],
                        help="image size to download (default: medium)")
    parser.add_argument("--reencode-existing", action="store_true",
                        help="only migrate existing .png portraits to .webp (no download)")
    args = parser.parse_args()

    # Load or create index.
    index: dict[str, str] = {}
    if INDEX_FILE.exists():
        index = json.loads(INDEX_FILE.read_text())

    if args.reencode_existing:
        # Pure local migration — no encyclopedia cache or network needed.
        reencode_existing(index)
        INDEX_FILE.write_text(json.dumps(index, indent=2))
        return 0

    ships = load_ships()
    IMAGES_OUT.mkdir(parents=True, exist_ok=True)

    todo = []
    for s in ships:
        sid = str(s.get("shipId", ""))
        if not sid:
            continue
        url = s.get("images", {}).get(args.size, "")
        if not url:
            continue
        local = f"{sid}.webp"
        if not args.force and (IMAGES_OUT / local).exists():
            continue
        todo.append((sid, url, local))

    print(f"[download-images] {len(todo)} to download (of {len(ships)} ships)")
    if not todo:
        print("[download-images] all cached. Use --force to re-download.")
        return 0

    ok = 0
    fail = 0
    for i, (sid, url, local) in enumerate(todo):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "WoWSP/0.1"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
            # The CDN serves PNGs; re-encode every download to the res tree's
            # WebP format (decode failures leave this ship for a later run).
            (IMAGES_OUT / local).write_bytes(png_bytes_to_webp(data, lossless=False))
            index[sid] = local
            ok += 1
        except Exception as e:
            fail += 1
            if fail <= 5:
                print(f"  ✗ {sid}: {e}", file=sys.stderr)
        if (i + 1) % 50 == 0:
            print(f"  [{i+1}/{len(todo)}] {ok} ok, {fail} fail")
            INDEX_FILE.write_text(json.dumps(index, indent=2))  # checkpoint
        time.sleep(0.05)  # be gentle on the CDN

    INDEX_FILE.write_text(json.dumps(index, indent=2))
    print(f"\n[download-images] done: {ok} downloaded, {fail} failed")
    print(f"[download-images] images in {IMAGES_OUT}, index in {INDEX_FILE}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
