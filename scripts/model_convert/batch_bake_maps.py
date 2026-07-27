#!/usr/bin/env python3
"""Batch-bake ALL maps (spaces) to holographic contour GLBs.

Uses `convert_map_holo.py` per space — which runs `wowsunpack export-map` with
higher terrain detail (--terrain-step 4, default was 8) so the contour shader
shows clear topographic bands on every map.

The script walks `<game>/res/spaces/` to discover spaces. Each space whose raw
files exist is baked into `packages/webui/src/res/models/maps/<id>.glb`.

Usage:
    python scripts/model_convert/batch_bake_maps.py                     # bake missing
    python scripts/model_convert/batch_bake_maps.py --force             # re-bake all
    python scripts/model_convert/batch_bake_maps.py --terrain-step 2    # extra detail
    python scripts/model_convert/batch_bake_maps.py --limit 5           # only first 5

    just bake-maps
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
CONVERT_SCRIPT = SCRIPT_DIR / "convert_map_holo.py"
MAPS_OUT = (
    REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "maps"
)

# Maps with fewer terrain triangles than this after baking are considered
# incomplete (export failed or terrain.bin absent) and will be re-baked.
MIN_TERRAIN_TRIS = 3000


def find_game_path() -> str | None:
    sys.path.insert(0, str(SCRIPT_DIR))
    from _common import find_game_path as _fgp

    return _fgp()


def find_wowsunpack() -> Path | None:
    sys.path.insert(0, str(SCRIPT_DIR))
    from _common import find_wowsunpack as _fwu

    return _fwu()


def list_spaces(game: str) -> list[str]:
    """Enumerate space IDs from <game>/res/spaces/ (only directories that
    contain a .geometry or terrain.bin — i.e. real maps, not meta-folders)."""
    spaces_dir = Path(game) / "res" / "spaces"
    if not spaces_dir.is_dir():
        print(
            f"error: spaces dir not found at {spaces_dir}",
            file=sys.stderr,
        )
        sys.exit(1)
    ids: list[str] = []
    for entry in sorted(spaces_dir.iterdir()):
        if not entry.is_dir():
            continue
        # A space is real if it has a models.geometry file or terrain.bin.
        geo = entry / "models.geometry"
        terrain = entry / "terrain.bin"
        if geo.exists() or terrain.exists():
            ids.append(entry.name)
    return ids


def glb_terrain_tris(path: Path) -> int:
    """Read a baked map GLB and return the triangle count of its Terrain mesh.
    Returns -1 if unreadable or no Terrain mesh found."""
    try:
        data = path.read_bytes()
        magic, version, length = struct.unpack_from("<III", data, 0)
        if magic != 0x46546C67 or length > len(data):
            return -1
        offset = 12
        json_body = None
        while offset < length:
            chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
            offset += 8
            if chunk_type == 0x4E4F534A:  # "JSON"
                json_body = data[offset : offset + chunk_len]
                break
            offset += chunk_len
        if not json_body:
            return -1
        g = json.loads(json_body.rstrip(b"\x00").decode("utf-8"))
        terrain_tris = 0
        for i, mesh in enumerate(g.get("meshes", [])):
            node_name = g["nodes"][i]["name"] if i < len(g.get("nodes", [])) else ""
            if "Terrain" not in node_name:
                continue
            for prim in mesh.get("primitives", []):
                if "indices" in prim:
                    terrain_tris += (
                        g["accessors"][prim["indices"]].get("count", 0) // 3
                    )
        return terrain_tris if terrain_tris > 0 else -1
    except Exception:
        return -1


def needs_baking(space_id: str, force: bool, resume: bool | None) -> bool:
    if force:
        return True
    out_glb = MAPS_OUT / f"{space_id}.glb"
    if not out_glb.exists():
        return True
    if resume is True:
        tris = glb_terrain_tris(out_glb)
        return tris < MIN_TERRAIN_TRIS
    # resume is False (= --no-resume): file exists → skip.
    return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Batch-bake all WoWS maps to holographic contour GLBs"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-bake every map even if an up-to-date GLB exists",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=True,
        dest="resume",
        help="skip maps whose Terrain mesh has ≥N tris (default on)",
    )
    parser.add_argument(
        "--no-resume",
        action="store_false",
        dest="resume",
        help="skip any map whose GLB file already exists",
    )
    parser.add_argument(
        "--terrain-step",
        type=int,
        default=2,
        help="wowsunpack terrain sampling step (1=full, 2=high, 4=medium, 8=coarse; default: 2)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="max maps to bake this run (0=all)",
    )
    parser.add_argument(
        "--game-dir",
        default=None,
        help="game install path (default: auto-detect)",
    )
    args = parser.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print(
            "error: World of Warships install not found.",
            file=sys.stderr,
        )
        return 1

    wowsunpack = find_wowsunpack()
    if not wowsunpack:
        print(
            "error: wowsunpack not found.",
            file=sys.stderr,
        )
        return 1

    MAPS_OUT.mkdir(parents=True, exist_ok=True)
    space_ids = list_spaces(game)
    print(f"[batch_bake_maps] found {len(space_ids)} spaces in {game}")

    todo: list[str] = []
    skipped = 0
    for sid in space_ids:
        if needs_baking(sid, args.force, args.resume):
            todo.append(sid)
        else:
            skipped += 1
    if args.limit > 0:
        todo = todo[: args.limit]

    mode = "force" if args.force else ("resume" if args.resume else "skip-existing")
    print(
        f"[batch_bake_maps] mode={mode}  terrain-step={args.terrain_step}  "
        f"{len(todo)} to bake, {skipped} up-to-date (of {len(space_ids)} total)"
    )
    if not todo:
        print("[batch_bake_maps] nothing to do. Use --force to re-bake everything.")
        return 0

    ok = 0
    fail = 0
    start = time.time()
    for i, sid in enumerate(todo):
        # Env var for the patched wowsunpack (with --keep-submerged support).
        env = os.environ.copy()
        if "WOWSP_WOWSUNPACK" not in env:
            env["WOWSP_WOWSUNPACK"] = str(wowsunpack)

        cmd = [
            sys.executable,
            str(CONVERT_SCRIPT),
            "--name",
            sid,
            "--terrain-step",
            str(args.terrain_step),
            "--game-dir",
            game,
        ]
        try:
            rc = subprocess.call(cmd, env=env, timeout=120)
            if rc == 0:
                ok += 1
                status = "✓"
            else:
                fail += 1
                status = "✗"
        except subprocess.TimeoutExpired:
            fail += 1
            status = "⏱"
        except Exception:
            fail += 1
            status = "✗"

        elapsed = time.time() - start
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta_min = (len(todo) - i - 1) / rate / 60 if rate > 0 else 0
        print(
            f"  [{i+1}/{len(todo)}] {status} {sid} "
            f"({ok} ok, {fail} fail, ETA {eta_min:.0f}min)",
            flush=True,
        )

    elapsed_min = (time.time() - start) / 60
    print(
        f"\n[batch_bake_maps] done: {ok} baked, {fail} failed in {elapsed_min:.1f}min"
    )
    print(f"[batch_bake_maps] models in {MAPS_OUT}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
