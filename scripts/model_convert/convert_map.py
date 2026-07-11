#!/usr/bin/env python3
"""Convert one WoWS map (space) into a GLB by driving `wowsunpack export-map`.

Orchestrator only — wowsunpack reads the .pkg VFS and assembles terrain +
water + vegetation + models into a single GLB. WoWSP handles game detection
and output placement.

Usage:
    python scripts/model_convert/convert_map.py --name 15_NE_north
    python scripts/model_convert/convert_map.py --name spaces/15_NE_north --terrain-step 8 --no-vegetation
    python scripts/model_convert/convert_map.py --name 15_NE_north --no-textures --max-texture-size 512

    just convert-model map --name 15_NE_north
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path, run_wowsunpack  # noqa: E402

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "packages" / "webui" / "src" / "res" / "models" / "maps"


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoWS map (space) to GLB via wowsunpack")
    parser.add_argument("--name", required=True, help="space id (e.g. 15_NE_north) or full path (spaces/15_NE_north)")
    parser.add_argument("--output", "-o", default=str(DEFAULT_OUT), help="output GLB path or dir (default: maps/)")
    parser.add_argument("--lod", type=int, default=0, help="level of detail (0=highest, default 0)")
    parser.add_argument("--terrain-step", type=int, default=4, help="terrain decimation (1=full, 4=default, 8=coarse)")
    parser.add_argument("--no-terrain", action="store_true", help="skip terrain mesh")
    parser.add_argument("--no-water", action="store_true", help="skip water plane")
    parser.add_argument("--no-vegetation", action="store_true", help="skip trees/bushes")
    parser.add_argument("--vegetation-density", type=int, default=20, help="vegetation grid cell size in meters (0=none)")
    parser.add_argument("--no-textures", action="store_true", help="skip textures")
    parser.add_argument("--max-texture-size", type=int, default=None, help="downsample textures to this max edge (px)")
    args = parser.parse_args()

    game = find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    # Normalize the space name: wowsunpack accepts both "15_NE_north" and
    # "spaces/15_NE_north". Strip a leading spaces/ for a clean filename.
    space = args.name.removeprefix("spaces/").removeprefix("spaces\\")
    space_arg = args.name if args.name.startswith("spaces/") else f"spaces/{space}"

    out = Path(args.output)
    if out.is_dir() or not out.suffix:
        out.mkdir(parents=True, exist_ok=True)
        out = out / f"{space}.glb"
    else:
        out.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "--game-dir", game, "export-map", space_arg,
        "--output", str(out),
        "--lod", str(args.lod),
        "--terrain-step", str(args.terrain_step),
    ]
    if args.no_terrain:
        cmd.append("--no-terrain")
    if args.no_water:
        cmd.append("--no-water")
    if args.no_vegetation:
        cmd.append("--no-vegetation")
    else:
        cmd += ["--vegetation-density", str(args.vegetation_density)]
    if args.no_textures:
        cmd.append("--no-textures")
    if args.max_texture_size:
        cmd += ["--max-texture-size", str(args.max_texture_size)]

    rc = run_wowsunpack(cmd)
    if rc == 0:
        print(f"[convert_map] wrote {out}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
