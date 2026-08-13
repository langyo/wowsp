#!/usr/bin/env python3
"""Fetch the baked GLB model pack from GitHub Releases into the webui res tree.

The model GLBs are gitignored and distributed via the GitHub Release model
pack (tag `res-latest`, asset wowsp-models.tar.gz). Fresh clones and CI jobs
that need local models run this:

    python scripts/fetch_models.py               # fetch the latest pack
    python scripts/fetch_models.py --dry-run     # print the asset URL only
    python scripts/fetch_models.py --tag res-latest-old-1

Fallback order mirrors the app downloader (model_pack.rs):
res-latest -> res-latest-old-1 -> res-latest-old-2.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request

REPO = "langyo/wowsp"
ASSET = "wowsp-models.tar.gz"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(REPO_ROOT, "packages", "webui", "src", "res")
TAGS = ["res-latest", "res-latest-old-1", "res-latest-old-2"]


def api_json(path: str) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/{path}",
        headers={
            "User-Agent": "WoWSP-model-fetch/1.0",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def asset_url(tag: str) -> str:
    release = api_json(f"releases/tags/{tag}")
    for asset in release.get("assets", []):
        if asset.get("name") == ASSET:
            return asset["browser_download_url"]
    raise RuntimeError(f"asset {ASSET} not found in release {tag}")


def main() -> None:
    args = sys.argv[1:]
    dry = "--dry-run" in args
    wanted = "res-latest"
    if "--tag" in args:
        idx = args.index("--tag")
        wanted = args[idx + 1]

    order = [wanted] + [t for t in TAGS if t != wanted]
    url = None
    for tag in order:
        try:
            url = asset_url(tag)
            print(f"[fetch-models] tag {tag} -> {url}")
            break
        except Exception as exc:  # noqa: BLE001 - fallback chain is the point
            print(f"[fetch-models] tag {tag} unavailable: {exc}")
    if url is None:
        print("[fetch-models] no usable release found; aborting.", file=sys.stderr)
        sys.exit(1)
    if dry:
        return

    # ── Download ────────────────────────────────────────────────────────
    tmp = tempfile.mkdtemp(prefix="wowsp-models-")
    archive = os.path.join(tmp, ASSET)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "WoWSP-model-fetch/1.0"})
        print(f"[fetch-models] downloading {ASSET} ...")
        with urllib.request.urlopen(req, timeout=120) as resp, open(archive, "wb") as fh:
            shutil.copyfileobj(resp, fh, length=1 << 20)
        size_mb = os.path.getsize(archive) / 1024 / 1024
        print(f"[fetch-models] downloaded {size_mb:.1f} MB")

        # ── Extract (archive root is models/ -> DEST/models) ───────────
        os.makedirs(DEST, exist_ok=True)
        print(f"[fetch-models] extracting into {DEST} ...")
        # silhouettes.json is committed to the repo (traced from the game's
        # silhouette bitmaps by trace_silhouettes.py). The pack ships an older
        # GLB-projection bake, so skip it and keep the committed one.
        skip = {"models/silhouettes.json"}
        with tarfile.open(archive, "r:gz") as tf:
            for member in tf.getmembers():
                if member.name.startswith("../") or os.path.isabs(member.name):
                    raise RuntimeError(f"unsafe archive member: {member.name}")
                if member.name in skip:
                    continue
                try:
                    tf.extract(member, DEST, filter="data")
                except TypeError:
                    tf.extract(member, DEST)

        ships = len([
            n for n in os.listdir(os.path.join(DEST, "models", "ships"))
            if n.endswith(".glb")
        ])
        print(f"[fetch-models] done — ships: {ships}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
