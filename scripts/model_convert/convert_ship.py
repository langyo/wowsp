#!/usr/bin/env python3
"""Convert a World of Warships ship hull model into a GLB for three.js.

Status: **skeleton**. The CLI, path resolution, and output scaffolding are in
place; the actual native-format reader (the game stores hull geometry in a
proprietary primitive format under `res/content/<nation>/.../<ship>/`) is TODO.
When a concrete ship is needed, fill in `read_native_ship` + `build_glb`.

Usage:
    python scripts/model_convert/convert_ship.py \
        --input path/to/ship_source \
        --output packages/webui/src/res/models/ships/
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "ships"


def read_native_ship(source: Path) -> dict:
    """TODO: parse the game's native ship format into a neutral mesh dict.

    Expected return shape (what `build_glb` consumes):
        {
            "name": str,
            "vertices": [[x,y,z], ...],
            "indices": [i0,i1,i2, ...],
            "uvs": [[u,v], ...],            # optional
            "material_hint": str | None,    # optional
        }
    """
    raise NotImplementedError(
        "native ship reader not implemented yet — see README.md for how to add a ship"
    )


def build_glb(mesh: dict) -> bytes:
    """TODO: turn the neutral mesh dict into a binary GLB (glTF 2.0).

    Options:
      * `pygltflib` (pure-python, easy)
      * `trimesh` (heavier, more exporters)
      * hand-roll the glTF JSON + binary chunk (no deps)
    """
    raise NotImplementedError("GLB writer not implemented yet")


def convert(input_path: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    mesh = read_native_ship(input_path)
    glb = build_glb(mesh)
    out = output_dir / f"{mesh.get('name', input_path.stem)}.glb"
    out.write_bytes(glb)
    print(f"[convert_ship] wrote {out.relative_to(REPO_ROOT)}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoW ship model to GLB")
    parser.add_argument("--input", required=True, help="path to the native ship source")
    parser.add_argument("--output", default=str(DEFAULT_OUT), help="output directory for the GLB")
    args = parser.parse_args()

    src = Path(args.input).resolve()
    if not src.exists():
        print(f"error: input not found: {src}", file=sys.stderr)
        return 1
    try:
        convert(src, Path(args.output))
    except NotImplementedError as e:
        print(f"[convert_ship] {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
