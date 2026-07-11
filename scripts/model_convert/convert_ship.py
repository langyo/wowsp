#!/usr/bin/env python3
"""Convert one WoWS ship hull into a GLB by driving `wowsunpack export-ship`.

This is an orchestrator — WoWSP auto-detects the game install and the
wowsunpack binary, then forwards every flag to wowsunpack's export-ship
subcommand. wowsunpack does the actual .pkg VFS read + .geometry → GLB work.

Usage:
    python scripts/model_convert/convert_ship.py --name Montana
    python scripts/model_convert/convert_ship.py --name USA001_Montana_1945 --hull B --lod 0
    python scripts/model_convert/convert_ship.py --name Yamato --no-textures --max-texture-size 512

    just convert-model ship --name Montana
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path, run_wowsunpack  # noqa: E402

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "packages" / "webui" / "src" / "res" / "models" / "ships"


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoWS ship to GLB via wowsunpack")
    parser.add_argument("--name", required=True, help="ship display name (e.g. Montana) or model dir (USA001_Montana_1945)")
    parser.add_argument("--output", "-o", default=str(DEFAULT_OUT), help="output GLB path or dir (default: ships/)")
    parser.add_argument("--hull", default=None, help="hull selection (prefix match, e.g. A / B)")
    parser.add_argument("--lod", type=int, default=0, help="level of detail (0=highest, default 0)")
    parser.add_argument("--damaged", action="store_true", help="export destroyed-hull crack geometry")
    parser.add_argument("--no-textures", action="store_true", help="skip camo textures")
    parser.add_argument("--max-texture-size", type=int, default=None, help="downsample textures to this max edge (px)")
    parser.add_argument("--list-upgrades", action="store_true", help="list hull upgrades and exit")
    args = parser.parse_args()

    game = find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    # Resolve output: if a directory, append <name>.glb.
    out = Path(args.output)
    if out.is_dir() or not out.suffix:
        out.mkdir(parents=True, exist_ok=True)
        out = out / f"{args.name}.glb"
    else:
        out.parent.mkdir(parents=True, exist_ok=True)

    cmd = ["--game-dir", game, "export-ship", args.name, "--output", str(out), "--lod", str(args.lod)]
    if args.hull:
        cmd += ["--hull", args.hull]
    if args.damaged:
        cmd.append("--damaged")
    if args.no_textures:
        cmd.append("--no-textures")
    if args.max_texture_size:
        cmd += ["--max-texture-size", str(args.max_texture_size)]
    if args.list_upgrades:
        cmd.append("--list-upgrades")

    rc = run_wowsunpack(cmd)
    if rc == 0 and not args.list_upgrades:
        print(f"[convert_ship] wrote {out}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
