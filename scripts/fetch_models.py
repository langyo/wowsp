#!/usr/bin/env python3
"""Fetch the resource pack from GitHub Releases into the webui res tree.

The pack is the single content-addressed archive on the fixed `res-latest`
release (asset wowsp-res.tar.gz, top-level `models/` + `dogtags/`), with
its `wowsp-res.json` manifest carrying the content tree hash + asset
sha256. Fresh clones and CI jobs that need local models run this:

    python scripts/fetch_models.py               # fetch + verify the pack
    python scripts/fetch_models.py --dry-run     # print the asset URL only

The downloaded archive is verified against the manifest's assetSha256
before extraction, so a truncated mirror copy fails here instead of as a
mid-build surprise.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request

REPO = "langyo/wowsp"
ASSET = "wowsp-res.tar.gz"
MANIFEST_ASSET = "wowsp-res.json"
IMAGES_ASSET = "wowsp-images.tar.gz"
TAG = "res-latest"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(REPO_ROOT, "packages", "webui", "src", "res")


def api_json(path: str) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/{path}",
        headers={
            "User-Agent": "WoWSP-model-fetch/2.0",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def asset_url(tag: str, asset: str) -> str:
    release = api_json(f"releases/tags/{tag}")
    for entry in release.get("assets", []):
        if entry.get("name") == asset:
            return entry["browser_download_url"]
    raise RuntimeError(f"asset {asset} not found in release {tag}")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: str, label: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "WoWSP-model-fetch/2.0"})
    print(f"[fetch-models] downloading {label} ...")
    with urllib.request.urlopen(req, timeout=300) as resp, open(dest, "wb") as fh:
        shutil.copyfileobj(resp, fh, length=1 << 20)
    print(f"[fetch-models] downloaded {os.path.getsize(dest) / 1024 / 1024:.1f} MB")


def extract(archive: str, dest: str, skip: set[str] | None = None) -> None:
    skip = skip or set()
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf.getmembers():
            if member.name.startswith("../") or os.path.isabs(member.name):
                raise RuntimeError(f"unsafe archive member: {member.name}")
            if member.name in skip:
                continue
            try:
                tf.extract(member, dest, filter="data")
            except TypeError:
                tf.extract(member, dest)


def main() -> None:
    args = sys.argv[1:]
    dry = "--dry-run" in args

    url = asset_url(TAG, ASSET)
    print(f"[fetch-models] {TAG}/{ASSET} -> {url}")
    if dry:
        return

    # Optional manifest: verifies the archive when present (older releases
    # without it degrade to the size-only behaviour).
    expected_sha = ""
    expected_size: int | None = None
    try:
        manifest_url = asset_url(TAG, MANIFEST_ASSET)
        tmp_manifest = tempfile.mkdtemp(prefix="wowsp-manifest-")
        try:
            download(manifest_url, os.path.join(tmp_manifest, MANIFEST_ASSET), MANIFEST_ASSET)
            with open(os.path.join(tmp_manifest, MANIFEST_ASSET), encoding="utf-8") as fh:
                manifest = json.load(fh)
            expected_sha = str(manifest.get("assetSha256", ""))
            expected_size = manifest.get("assetSize")
            print(
                f"[fetch-models] manifest: tree …{str(manifest.get('treeSha256', ''))[-6:].upper()}"
                f" published {manifest.get('version', '?')}"
            )
        finally:
            shutil.rmtree(tmp_manifest, ignore_errors=True)
    except Exception as exc:  # noqa: BLE001 - manifest is optional for old releases
        print(f"[fetch-models] {MANIFEST_ASSET} unavailable ({exc}) — sha verify skipped")

    fetch_images()

    # ── Download + verify ───────────────────────────────────────────────
    tmp = tempfile.mkdtemp(prefix="wowsp-res-")
    archive = os.path.join(tmp, ASSET)
    try:
        download(url, archive, ASSET)
        if expected_size is not None and os.path.getsize(archive) != expected_size:
            raise RuntimeError(
                f"downloaded size {os.path.getsize(archive):,} != manifest size {expected_size:,}"
            )
        if expected_sha:
            got = sha256_file(archive)
            if got.lower() != expected_sha.lower():
                raise RuntimeError(f"sha256 mismatch: got {got[:12]}…, expected {expected_sha[:12]}…")
            print("[fetch-models] sha256 verified against the manifest")

        # ── Extract (archive root is models/ + dogtags/ -> DEST/*) ──────
        print(f"[fetch-models] extracting into {DEST} ...")
        # silhouettes.json is committed to the repo (traced from the game's
        # silhouette bitmaps by trace_silhouettes.py). The pack ships an older
        # GLB-projection bake, so skip it and keep the committed one.
        extract(archive, DEST, skip={"models/silhouettes.json"})

        ships = len([
            n for n in os.listdir(os.path.join(DEST, "models", "ships"))
            if n.endswith(".glb")
        ])
        print(f"[fetch-models] done — ships: {ships}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch_images() -> None:
    """Fetch the ship-preview portrait pack (wowsp-images.tar.gz) from
    res-latest into res/images. The portraits are gitignored derived
    downloads; without them a local build embeds a frontend without ship
    previews (smaller exe than release CI's — the exact drift this
    reverses). Releases without the asset are tolerated (skip)."""
    try:
        url = asset_url(TAG, IMAGES_ASSET)
    except Exception as exc:  # noqa: BLE001 - optional asset, absent on old packs
        print(f"[fetch-models] {IMAGES_ASSET} unavailable ({exc}) — skipping portraits")
        return
    tmp = tempfile.mkdtemp(prefix="wowsp-images-")
    archive = os.path.join(tmp, IMAGES_ASSET)
    try:
        download(url, archive, IMAGES_ASSET)
        # Archive root is images/ -> DEST/images (mirrors the pack layout).
        print(f"[fetch-models] extracting portraits into {DEST} ...")
        extract(archive, DEST)
        print("[fetch-models] portraits done")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
