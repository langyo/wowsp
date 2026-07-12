#!/usr/bin/env python3
"""Convert a WoWS map (space) into a GLB.

Two-step process:
  1. Extract the space's `models.geometry` file from the game's .pkg VFS using
     `wowsunpack` (landaire/wowsunpack).
  2. Convert the `models.geometry` → GLB using `wows-geometry-cli` (from
     wows-tools/wows-geometry).

The resulting GLB contains the map's static geometry (islands, buildings,
rocks) as a single mesh. Terrain heightmap is in a separate `terrain.bin`
(not converted by this script — it requires heightmap DDS parsing).

Usage:
    python scripts/model_convert/convert_map.py --name 18_NE_ice_islands
    python scripts/model_convert/convert_map.py --name 15_NE_north

    just convert-map --name 18_NE_ice_islands
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path  # noqa: E402

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "packages" / "webui" / "src" / "res" / "models" / "maps"


def find_tool(name: str, env_var: str) -> str | None:
    env_path = os.environ.get(env_var)
    if env_path and Path(env_path).exists():
        return env_path
    return shutil.which(name)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoWS map (space) to GLB")
    parser.add_argument("--name", required=True, help="space id (e.g. 18_NE_ice_islands)")
    parser.add_argument("--output", "-o", default=str(DEFAULT_OUT), help="output GLB path or dir (default: maps/)")
    parser.add_argument("--game-dir", default=None, help="game install path (default: auto-detect)")
    args = parser.parse_args()

    space_id = args.name.replace("spaces/", "").rstrip("/")

    game = args.game_dir or find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    wowsunpack = find_tool("wowsunpack", "WOWSP_WOWSUNPACK")
    if not wowsunpack:
        print("error: wowsunpack not found. Download from "
              "https://github.com/landaire/wowsunpack/releases and set WOWSP_WOWSUNPACK.",
              file=sys.stderr)
        return 1

    geometry_cli = find_tool("wows-geometry-cli", "WOWSP_GEOMETRY_CLI")
    if not geometry_cli:
        print("error: wows-geometry-cli not found. Download from "
              "https://github.com/wows-tools/wows-model-exporter/releases and "
              "set WOWSP_GEOMETRY_CLI.", file=sys.stderr)
        return 1

    # Resolve output.
    out = Path(args.output)
    if out.is_dir() or not out.suffix:
        out = out / f"{space_id}.glb"
    out.parent.mkdir(parents=True, exist_ok=True)

    # Step 1: extract models.geometry from the game's .pkg VFS.
    with tempfile.TemporaryDirectory() as tmpdir:
        extract_dir = Path(tmpdir)
        print(f"[convert_map] extracting spaces/{space_id}/models.geometry ...")
        rc = subprocess.call([
            wowsunpack, "--game-dir", game, "extract",
            f"spaces/{space_id}/models.geometry",
            "-o", str(extract_dir), "--strip-prefix",
        ])
        if rc != 0:
            print(f"error: wowsunpack extract failed (rc={rc})", file=sys.stderr)
            return rc

        geo_file = extract_dir / "models.geometry"
        if not geo_file.exists():
            print("error: models.geometry not found in extracted files", file=sys.stderr)
            return 1

        # Step 2: convert geometry → GLB.
        # wows-geometry-cli may fail to write to paths with non-ASCII chars;
        # write to a temp file first, then copy.
        tmp_glb = extract_dir / f"{space_id}.glb"
        print("[convert_map] converting to GLB ...")
        rc = subprocess.call([
            geometry_cli, "-i", str(geo_file), "-o", str(tmp_glb),
        ])
        if rc != 0:
            print(f"error: wows-geometry-cli failed (rc={rc})", file=sys.stderr)
            return rc

        shutil.copy2(tmp_glb, out)

    print(f"[convert_map] wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
