#!/usr/bin/env python3
"""Convert one WoWS ship hull into a GLB via wows-gltf-exporter.

Drives the `wows-gltf-exporter` binary (from wows-tools/wows-geometry, releases
at https://github.com/wows-tools/wows-model-exporter). The exporter reads the
game's .pkg VFS, parses GameParams.data + .geometry/.visual files, stitches
hull parts, applies textures, and writes a single GLB.

Usage:
    python scripts/model_convert/convert_ship.py --name Montana
    python scripts/model_convert/convert_ship.py --name PASB017_Montana_1945 --lod 2 --no-turrets
    python scripts/model_convert/convert_ship.py --name Yamato --no-textures --texture-size 512

    just convert-ship --name Montana
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path  # noqa: E402

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "packages" / "webui" / "src" / "res" / "models" / "ships"


def find_exporter() -> str | None:
    """Find the wows-gltf-exporter binary."""
    env_path = os.environ.get("WOWSP_GLTF_EXPORTER") or os.environ.get("WOWSP_WOWSUNPACK")
    if env_path and Path(env_path).exists():
        return env_path
    return shutil.which("wows-gltf-exporter")


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoWS ship to GLB")
    parser.add_argument("--name", required=True, help="ship name pattern (e.g. Montana, PASB017_Montana_1945)")
    parser.add_argument("--output", "-o", default=str(DEFAULT_OUT), help="output GLB path or dir (default: ships/)")
    parser.add_argument("--lod", type=int, default=-1, help="LOD level (-1=auto, default: -1)")
    parser.add_argument("--hull", default=None, help="hull upgrade name substring (default: latest)")
    parser.add_argument("--damaged", action="store_true", help="include damage/crack geometry")
    parser.add_argument("--no-turrets", action="store_true", help="exclude turret/mounted models")
    parser.add_argument("--no-textures", action="store_true", help="skip textures")
    parser.add_argument("--texture-size", type=int, default=2048, help="max texture dimension (default: 2048)")
    args = parser.parse_args()

    game = find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    exporter = find_exporter()
    if not exporter:
        print("error: wows-gltf-exporter not found. Download from "
              "https://github.com/wows-tools/wows-model-exporter/releases and "
              "set WOWSP_GLTF_EXPORTER or add to PATH.", file=sys.stderr)
        return 1

    # Resolve output: if a directory, derive filename from --name.
    out = Path(args.output)
    if out.is_dir() or not out.suffix:
        # Use the last token of --name as filename (e.g. PASB017_Montana_1945 → Montana).
        stem = args.name.replace("PASB", "").replace("PJSB", "").replace("PCSC", "")
        stem = stem.replace("PASD", "").replace("PCSA", "").replace("PXSB", "")
        # If still has prefix like 017_Montana_1944, take the readable part.
        parts = stem.split("_")
        readable = next((p for p in parts if p[0].isalpha()), parts[-1] if parts else "ship")
        out = out / f"{readable}.glb"
    out.parent.mkdir(parents=True, exist_ok=True)

    cmd = [exporter, "-W", game, "-s", args.name, "-o", str(out),
           "-L", str(args.lod), "-Z", str(args.texture_size)]
    if args.hull:
        cmd += ["-H", args.hull]
    if args.damaged:
        cmd.append("-D")
    if args.no_turrets:
        cmd.append("-t")
    if args.no_textures:
        cmd.append("-T")

    print(f"[convert_ship] {' '.join(cmd)}")
    rc = subprocess.call(cmd)
    if rc == 0:
        print(f"[convert_ship] wrote {out} ({out.stat().st_size // 1024} KB)")
    return rc


if __name__ == "__main__":
    sys.exit(main())
