#!/usr/bin/env python3
"""Convert a World of Warships map (space) into a GLB for three.js.

Status: **skeleton**. The CLI, path resolution, and output scaffolding are in
place; the actual native-format reader (the game stores map geometry under
`res/content/space/<space_id>/`) is TODO. When a concrete map is needed, fill in
`read_native_map` + `build_glb`. Maps are usually simpler than ships (mostly
static terrain + island meshes), so this is the easier of the two converters.

Usage:
    python scripts/model_convert/convert_map.py \
        --input path/to/map_space \
        --output packages/webui/src/res/models/maps/
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "maps"


def read_native_map(source: Path) -> dict:
    """TODO: parse the game's native map/space format into a neutral mesh dict.

    A space directory typically holds:
      * terrain / island meshes
      * a `spacePyObject` describing bounds + minimap projection
      * static objects (capture zones are gameplay, not geometry — skip)

    Return shape: {"name": str, "vertices": [...], "indices": [...],
                   "bounds": {"min":[x,y,z],"max":[x,y,z]}}
    """
    raise NotImplementedError(
        "native map reader not implemented yet — see README.md for how to add a map"
    )


def build_glb(mesh: dict) -> bytes:
    """TODO: turn the neutral mesh dict into a binary GLB (glTF 2.0)."""
    raise NotImplementedError("GLB writer not implemented yet")


def convert(input_path: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    mesh = read_native_map(input_path)
    glb = build_glb(mesh)
    out = output_dir / f"{mesh.get('name', input_path.stem)}.glb"
    out.write_bytes(glb)
    print(f"[convert_map] wrote {out.relative_to(REPO_ROOT)}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoW map (space) to GLB")
    parser.add_argument("--input", required=True, help="path to the native map source")
    parser.add_argument("--output", default=str(DEFAULT_OUT), help="output directory for the GLB")
    args = parser.parse_args()

    src = Path(args.input).resolve()
    if not src.exists():
        print(f"error: input not found: {src}", file=sys.stderr)
        return 1
    try:
        convert(src, Path(args.output))
    except NotImplementedError as e:
        print(f"[convert_map] {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
