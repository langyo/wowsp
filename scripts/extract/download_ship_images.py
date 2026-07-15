#!/usr/bin/env python3
"""Download and cache all ship portrait images from the WG CDN.

Reads the ship encyclopedia cache (populated by the Tauri app) to get each
ship's image URLs, downloads the `medium` portrait to
packages/webui/src/res/images/ships/<shipId>.png, and generates an index
mapping shipId → local filename. This makes images available offline and
removes the runtime dependency on the WG CDN.

The script is idempotent: ships whose image is already cached are skipped.

Usage:
    python scripts/model_convert/download_ship_images.py
    python scripts/model_convert/download_ship_images.py --force
    python scripts/model_convert/download_ship_images.py --size large

    just download-ship-images
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

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


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Download + cache ship portrait images")
    parser.add_argument("--force", action="store_true", help="re-download even if cached")
    parser.add_argument("--size", default="medium", choices=["small", "medium", "large"],
                        help="image size to download (default: medium)")
    args = parser.parse_args()

    ships = load_ships()
    IMAGES_OUT.mkdir(parents=True, exist_ok=True)

    # Load or create index.
    index: dict[str, str] = {}
    if INDEX_FILE.exists():
        index = json.loads(INDEX_FILE.read_text())

    todo = []
    for s in ships:
        sid = str(s.get("shipId", ""))
        if not sid:
            continue
        url = s.get("images", {}).get(args.size, "")
        if not url:
            continue
        local = f"{sid}.png"
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
            (IMAGES_OUT / local).write_bytes(data)
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
