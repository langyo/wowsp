#!/usr/bin/env python3
"""Publish the `data-latest` ship-data hot-update release.

One command, one channel: bakes nothing itself — it takes the BAKED assets
(the committed `packages/webui/src/data/ship_consumable_kit.json` from
`scripts/extract_ship_consumable_kit.py`, and the extract cache's
`shipdata-bundle.zip` from `scripts/extract/build_shipdata_bundle.py`)
and publishes them to the fixed `data-latest` GitHub release the app's
`commands/data_pack.rs` consumes:

  - `wowsp-data.json` — the manifest, one entry per dataset:
    `{format, datasets: {<name>: {version, sha256, asset, size}}}` where
    `sha256` is OF THE ASSET BODY (what clients hash locally to decide
    freshness) and `asset` is the content-addressed file name
    `<dataset>-<sha8>.json`;
  - one asset per dataset version, uploaded as-is.

Content-addressing makes the publish idempotent: identical content keeps
the same asset name and sha, so republishing after a no-op bake changes
nothing clients see (only the `version` timestamp moves, and clients
ignore it). Old hashed assets are pruned down to the newest few — a
client only ever follows the manifest, so history beyond the retention
window is dead weight.

Requires `gh` (authenticated) — publishing pushes a release, so
it is the repository maintainer's step by design. `--dataset` narrows a
publish to one dataset; its unselected siblings keep their manifest
entries and their release history.

Usage:
    python scripts/publish_data_pack.py            # publish + prune
    python scripts/publish_data_pack.py --dry-run  # show what would happen
    python scripts/publish_data_pack.py --dataset ship-gameparams
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Sibling module (same directory — sys.path[0] when run as
# `python scripts/publish_data_pack.py`).
import publish_digests

REPO_ROOT = Path(__file__).resolve().parent.parent
TAG = "data-latest"
MANIFEST_ASSET = "wowsp-data.json"
RELEASE_TITLE = "Ship data pack (data-latest)"
RELEASE_NOTES = (
    "Auto-published baked ship-data for the in-app hot-update channel "
    "(`wowsp-data.json` + content-addressed dataset assets). Consumed by "
    "`commands/data_pack.rs`; not a software release."
)
# Total kit assets kept per dataset, the freshly published one included.
RETAIN_PER_DATASET = 5

# The extract orchestrator's cache dir — home of the bake-time artifacts that
# are publish inputs but never committed (the ship-data bundle is ~15 MB).
CACHE_DIR = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract"

# dataset name → (baked asset path, content-addressed asset suffix). The
# suffix is what clients and mirrors key on (".json" for the small text
# datasets, ".zip" for the ship-data container), so it is part of the
# registry instead of assumed.
DATASETS: dict[str, tuple[Path, str]] = {
    # The Tab overlay's consumable kit — committed, shipped in the bundle.
    "ship-consumable-kit": (
        REPO_ROOT / "packages/webui/src/data/ship_consumable_kit.json",
        "json",
    ),
    # Both realms' GameParams slices (armor, ballistics, sonar, per-type
    # torpedo detail) for machines with no install to unpack — baked by
    # scripts/extract/build_shipdata_bundle.py, published here so refreshing
    # the fleet's ship data no longer needs an app release.
    "ship-gameparams": (CACHE_DIR / "shipdata-bundle.zip", "zip"),
}


def gh(*args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["gh", *args], capture_output=True, text=True, encoding="utf-8"
    )
    if check and proc.returncode != 0:
        raise SystemExit(f"error: gh {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return proc.stdout.strip()


def release_exists() -> bool:
    proc = subprocess.run(
        ["gh", "release", "view", TAG], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    return proc.returncode == 0


def current_manifest(tmp: Path) -> dict:
    """The manifest currently on the release (empty when absent/unreadable).

    Publishing a SUBSET of the datasets must not drop the others from the
    manifest — a client reads it as the complete dataset vocabulary."""
    if not release_exists():
        return {}
    proc = subprocess.run(
        ["gh", "release", "download", TAG, "--pattern", MANIFEST_ASSET,
         "--dir", str(tmp), "--clobber"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        return {}
    try:
        return json.loads((tmp / MANIFEST_ASSET).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def current_assets() -> dict[str, str]:
    """name → createdAt for every asset on the release (empty when absent)."""
    if not release_exists():
        return {}
    out = gh(
        "api",
        f"repos/langyo/wowsp/releases/tags/{TAG}",
        "--jq",
        '.assets | map({(.name): .createdAt}) | add // {}',
    )
    return json.loads(out or "{}")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--dataset",
        action="append",
        default=None,
        help="publish only these datasets (repeatable or comma-separated; "
        "default: every registered dataset)",
    )
    args = ap.parse_args(argv)

    selected: list[str]
    if args.dataset:
        selected = [n.strip() for chunk in args.dataset for n in chunk.split(",") if n.strip()]
        unknown = [n for n in selected if n not in DATASETS]
        if unknown:
            raise SystemExit(
                f"error: unknown dataset(s) {unknown}; registered: {sorted(DATASETS)}"
            )
    else:
        selected = list(DATASETS)

    entries: dict[str, dict] = {}
    uploads: list[Path] = []
    with tempfile.TemporaryDirectory(prefix="wowsp-data-pack-") as tmp:
        for name in selected:
            path, suffix = DATASETS[name]
            if not path.is_file():
                raise SystemExit(f"error: baked asset missing: {path}")
            body = path.read_bytes()
            sha = hashlib.sha256(body).hexdigest()
            asset = f"{name}-{sha[:8]}.{suffix}"
            entries[name] = {
                "version": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "sha256": sha,
                "asset": asset,
                "size": len(body),
            }
            staged = Path(tmp) / asset
            staged.write_bytes(body)
            uploads.append(staged)
            print(f"{name}: sha256={sha[:16]}… asset={asset} ({len(body)} bytes)")

        # A subset publish keeps every unselected dataset's current entry:
        # the manifest is the client's whole vocabulary, so dropping the kit
        # while refreshing ship data would silently retire it.
        manifest_entries = dict(entries)
        if not args.dry_run and set(selected) != set(DATASETS):
            for name, entry in current_manifest(Path(tmp)).get("datasets", {}).items():
                if name not in manifest_entries and name in DATASETS:
                    manifest_entries[name] = entry
        manifest = json.dumps(
            {"format": 1, "datasets": manifest_entries}, ensure_ascii=False, indent=2
        ) + "\n"
        manifest_path = Path(tmp) / MANIFEST_ASSET
        manifest_path.write_text(manifest, encoding="utf-8", newline="\n")
        uploads.append(manifest_path)

        if args.dry_run:
            # Network-free: report the upload plan only (the prune plan
            # needs the release's live asset list).
            print(f"dry run: would upload {[p.name for p in uploads]}")
            print("dry run: prune plan skipped (needs the live asset list)")
            return 0

        existing = current_assets()
        pending = [p for p in uploads if p.name not in existing]
        prune: list[str] = []
        for name, entry in entries.items():
            history = sorted(
                (created, asset)
                for asset, created in existing.items()
                if asset.startswith(f"{name}-") and asset != entry["asset"]
            )
            for _, asset in history[: max(0, len(history) - (RETAIN_PER_DATASET - 1))]:
                prune.append(asset)
        if pending:
            print(f"pending upload: {[p.name for p in pending]}")
        if prune:
            print(f"pending prune: {prune}")

        if not release_exists():
            gh("release", "create", TAG, "--title", RELEASE_TITLE,
               "--notes", RELEASE_NOTES, "--latest=false")
            print(f"created release {TAG}")
        for path in uploads:
            gh("release", "upload", TAG, str(path), "--clobber")
            print(f"uploaded {path.name}")
        for asset in prune:
            gh("release", "delete-asset", TAG, asset, "--yes")
            print(f"pruned old asset {asset}")
        # Second official channel — the relay worker's digest store;
        # skips without Cloudflare credentials.
        digest_assets = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in uploads
        }
        publish_digests.push_if_configured("data", TAG, digest_assets, latest=True)
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
