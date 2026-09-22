#!/usr/bin/env python3
"""Fetch the resource pack from GitHub Releases into the webui res tree.

The pack is the single content-addressed archive on the fixed `res-latest`
release (asset wowsp-res.tar.gz, top-level `models/` + `dogtags/`), with
its `wowsp-res.json` manifest carrying the content tree hash + asset
sha256. Fresh clones and CI jobs that need local models run this:

    python scripts/fetch_models.py               # fetch + verify the pack
    python scripts/fetch_models.py --dry-run     # print the asset URL only
    python scripts/fetch_models.py --force       # re-fetch even when current

Idempotent by default: when the local `wowsp-res.json` already matches the
remote tree hash AND the GLB/portrait payloads look populated, the script
skips the ~1.3 GB download (the justfile android recipes rely on this to
"fetch if missing" before every APK build). `--force` bypasses the check.

The downloaded archive is verified against the manifest's assetSha256
before extraction, so a truncated mirror copy fails here instead of as a
mid-build surprise. The manifest itself is persisted into the res tree
(`DEST/wowsp-res.json`, gitignored like the GLBs): it rides publicDir into
`dist/webui/wowsp-res.json`, where the MOBILE build's webui fetches it
same-origin to learn the bundled baseline version (see
commands/model_pack.rs `res_report_bundled`). Desktop builds embed the
file too when present, but nothing there reads it.
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
MANIFEST_DEST = os.path.join(DEST, MANIFEST_ASSET)

# ghproxy-style prefixes for networks where github.com itself is
# unreachable (mainland China direct routes) — the same ladder the Rust
# updater races (commands/model_pack.rs BUILTIN_MIRRORS), minus the
# built-in race: here candidates are tried strictly in order, once each
# (bounded — no unbounded retry loops, per the large-download policy).
# WOWSP_MIRROR pins a custom prefix ahead of the ladder.
BUILTIN_MIRRORS = (
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
)

# Bytes actually transferred by this run (successful candidate bodies;
# failed attempts download nothing past their connect timeout).
BYTES_TRANSFERRED = 0


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


def candidate_urls(url: str) -> list[str]:
    """The mirror ladder for one asset URL: WOWSP_MIRROR → direct → the
    built-in ghproxy prefixes (github.com download hosts only — the api.
    github.com calls stay direct; they are small and usually reachable)."""
    if not url.startswith("https://github.com/"):
        return [url]
    out: list[str] = []
    mirror = os.environ.get("WOWSP_MIRROR", "").strip()
    if mirror:
        out.append(mirror.rstrip("/") + "/" + url)
    out.append(url)
    out.extend(m + url for m in BUILTIN_MIRRORS)
    return out


def download(url: str, dest: str, label: str) -> None:
    """Fetch one asset through the mirror ladder. The DIRECT candidate gets
    a short connect budget so a blocked route costs seconds, not minutes;
    mirror candidates keep the full transfer timeout."""
    global BYTES_TRANSFERRED
    last_exc: Exception | None = None
    for candidate in candidate_urls(url):
        direct = candidate == url
        req = urllib.request.Request(candidate, headers={"User-Agent": "WoWSP-model-fetch/2.0"})
        print(f"[fetch-models] downloading {label} from {candidate} ...")
        try:
            with urllib.request.urlopen(req, timeout=30 if direct else 300) as resp, open(
                dest, "wb"
            ) as fh:
                shutil.copyfileobj(resp, fh, length=1 << 20)
            size = os.path.getsize(dest)
            BYTES_TRANSFERRED += size
            print(f"[fetch-models] downloaded {size / 1024 / 1024:.1f} MB")
            return
        except Exception as exc:  # noqa: BLE001 - fall through to the next candidate
            last_exc = exc
            print(f"[fetch-models] {candidate} failed ({exc}) — trying next source")
    raise RuntimeError(f"all sources failed for {label}: {last_exc}")


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


def fetch_manifest() -> dict | None:
    """Download + parse the res-latest manifest (None when unreachable or
    the release predates the manifest asset — those degrade to size-only
    checks)."""
    tmp = tempfile.mkdtemp(prefix="wowsp-manifest-")
    try:
        url = asset_url(TAG, MANIFEST_ASSET)
        manifest_path = os.path.join(tmp, MANIFEST_ASSET)
        download(url, manifest_path, MANIFEST_ASSET)
        with open(manifest_path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:  # noqa: BLE001 - manifest is optional for old releases
        print(f"[fetch-models] {MANIFEST_ASSET} unavailable ({exc})")
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def persist_manifest(manifest: dict) -> None:
    """Write the manifest into the res tree so it rides publicDir into
    `dist/webui/wowsp-res.json` (the mobile build's bundled baseline)."""
    with open(MANIFEST_DEST, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"[fetch-models] manifest persisted -> {MANIFEST_DEST}")


def local_manifest_tree() -> str:
    """treeSha256 recorded by a previous run ("" when absent/corrupt)."""
    try:
        with open(MANIFEST_DEST, encoding="utf-8") as fh:
            return str(json.load(fh).get("treeSha256", ""))
    except (OSError, ValueError):
        return ""


def payload_populated() -> bool:
    """Whether the res tree already holds the fetched payloads (GLB pack +
    portraits) — the local half of the skip check."""
    ships = os.path.join(DEST, "models", "ships")
    try:
        has_glbs = any(n.endswith(".glb") for n in os.listdir(ships))
    except OSError:
        has_glbs = False
    return has_glbs and os.path.isfile(os.path.join(DEST, "images", "ships", "_index.json"))


def main() -> None:
    args = sys.argv[1:]
    dry = "--dry-run" in args
    force = "--force" in args

    url = asset_url(TAG, ASSET)
    print(f"[fetch-models] {TAG}/{ASSET} -> {url}")
    if dry:
        return

    # Optional manifest: verifies the archive when present (older releases
    # without it degrade to the size-only behaviour), drives the skip check
    # and lands in the res tree for the mobile bundle baseline.
    manifest = fetch_manifest()
    expected_sha = str(manifest.get("assetSha256", "")) if manifest else ""
    expected_size = manifest.get("assetSize") if manifest else None
    if manifest:
        print(
            f"[fetch-models] manifest: tree …{str(manifest.get('treeSha256', ''))[-6:].upper()}"
            f" published {manifest.get('version', '?')}"
        )
        remote_tree = str(manifest.get("treeSha256", ""))
        local_tree = local_manifest_tree()
        if (
            not force
            and remote_tree
            and payload_populated()
            and local_tree.lower() == remote_tree.lower()
        ):
            persist_manifest(manifest)
            print("[fetch-models] local pack already current — skipping download")
            print(f"[fetch-models] total downloaded: {BYTES_TRANSFERRED:,} bytes")
            return
        persist_manifest(manifest)

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
        print(f"[fetch-models] total downloaded: {BYTES_TRANSFERRED:,} bytes")


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
