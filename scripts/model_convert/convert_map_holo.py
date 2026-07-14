#!/usr/bin/env python3
"""Convert a WoWS map (space) into a compact holographic GLB with terrain
elevation (contour-friendly, including sea trenches) + simplified islands.

This supersedes `convert_map.py`, which used `wows-geometry-cli` and produced
*only* island geometry (terrain.bin was skipped — "requires heightmap DDS
parsing"). The fix: `wowsunpack export-map` already parses terrain.bin
internally and emits a height-field `Terrain` mesh whose Y spans negative
(sea floor / trenches) to positive (island peaks). We extract that mesh plus
the island meshes, decimate both, and write a single small multi-mesh GLB the
frontend styles as a holographic contour map.

Pipeline:
  1. `wowsunpack export-map spaces/<id>` → full GLB (terrain + islands, ~54MB,
     no water/vegetation/textures).
  2. Split by mesh name: `Terrain` (elevation height-field) vs everything else
     (islands/buildings/rocks, typically `TILEDLAND_*`).
  3. Decimate the terrain to ~4000 triangles (vertex clustering preserves the
     Y centroid, so trench depth survives) and the islands to ~3000.
  4. Write a multi-mesh GLB: a `Terrain` node + an `Islands` node. The frontend
     identifies the `Terrain` node by name and applies the contour shader;
     islands get the plain holo shader.

Output: packages/webui/src/res/models/maps/<spaceId>.glb (target < 300KB).

Usage:
    python scripts/model_convert/convert_map_holo.py --name 18_NE_ice_islands
    just convert-map-holo --name 18_NE_ice_islands
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
from _common import find_game_path, find_wowsunpack  # noqa: E402
from bake_model import (  # noqa: E402
    decimate,
    extract_meshes_by_name,
    parse_glb,
    write_glb_multimesh,
)

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "packages" / "webui" / "src" / "res" / "models" / "maps"

# Decimation targets (triangles). Terrain needs more density than islands to
# keep contour bands + sea-floor bathymetry readable; both stay within budget.
TERRAIN_TARGET_TRIS = 8000
ISLANDS_TARGET_TRIS = 3000


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a WoWS map to a holographic contour GLB")
    parser.add_argument("--name", required=True, help="space id (e.g. 18_NE_ice_islands)")
    parser.add_argument("--output", "-o", default=str(DEFAULT_OUT), help="output GLB path or dir")
    parser.add_argument("--game-dir", default=None, help="game install path (default: auto-detect)")
    parser.add_argument("--terrain-step", type=int, default=8, help="wowsunpack terrain decimation (1=full, 8=coarse)")
    parser.add_argument(
        "--no-keep-submerged",
        action="store_true",
        help="drop submerged terrain (sea floor/trenches). By default the script keeps it "
        "(requires a patched wowsunpack with --keep-submerged; see scripts/model_convert/README).",
    )
    args = parser.parse_args()

    space_id = args.name.replace("spaces/", "").rstrip("/")

    game = args.game_dir or find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    wowsunpack = find_wowsunpack()
    if not wowsunpack:
        print("error: wowsunpack not found. Install it (cargo install wowsunpack) "
              "or set WOWSP_WOWSUNPACK.", file=sys.stderr)
        return 1

    out = Path(args.output)
    if out.is_dir() or not out.suffix:
        out = out / f"{space_id}.glb"
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        raw_glb = Path(tmpdir) / f"{space_id}_raw.glb"

        # Step 1: export the full map (terrain + islands, no water/veg/textures).
        # --keep-submerged preserves sea-floor bathymetry (trenches) as real
        # below-sea-level geometry — requires a patched wowsunpack. If the flag
        # isn't recognized (stock wowsunpack) the call fails and we retry once
        # without it so the script still works on an unpatched binary.
        keep_submerged = not args.no_keep_submerged
        print(f"[convert_map_holo] exporting spaces/{space_id} via wowsunpack export-map "
              f"(keep_submerged={keep_submerged}) ...")
        export_cmd = [
            wowsunpack, "--game-dir", game, "export-map", f"spaces/{space_id}",
            "-o", str(raw_glb),
            "--terrain-step", str(args.terrain_step),
            "--no-water", "--no-vegetation", "--no-textures",
        ]
        if keep_submerged:
            export_cmd.append("--keep-submerged")
        rc = subprocess.call(export_cmd)
        if rc != 0 and keep_submerged:
            print("[convert_map_holo] --keep-submerged rejected (stock wowsunpack); "
                  "retrying without it (trenches will be flattened).", file=sys.stderr)
            keep_submerged = False
            rc = subprocess.call([c for c in export_cmd if c != "--keep-submerged"])
        if rc != 0:
            print(f"error: wowsunpack export-map failed (rc={rc})", file=sys.stderr)
            return rc
        if not raw_glb.exists():
            print("error: export-map produced no output file", file=sys.stderr)
            return 1

        # Step 2: split meshes by name → terrain vs islands.
        print("[convert_map_holo] splitting terrain / islands ...")
        gltf = parse_glb(raw_glb)
        by_name = extract_meshes_by_name(gltf)

        terrain = by_name.pop("Terrain", None)
        if terrain is None:
            print("warning: no 'Terrain' mesh found — exporting islands only.", file=sys.stderr)
        # Everything remaining is treated as island/building geometry.
        island_verts: list[float] = []
        island_indices: list[int] = []
        for v, i in by_name.values():
            base = len(island_verts) // 3
            island_verts.extend(v)
            island_indices.extend(b + base for b in i)

        meshes: list[tuple[str, list[float], list[int]]] = []

        # Step 3a: decimate terrain (Y elevation preserved by vertex clustering).
        if terrain is not None:
            tv, ti = terrain
            print(f"[convert_map_holo] terrain raw: {len(tv)//3} verts, {len(ti)//3} tris")
            tv, ti = decimate(tv, ti, TERRAIN_TARGET_TRIS)
            print(f"[convert_map_holo] terrain baked: {len(tv)//3} verts, {len(ti)//3} tris")
            # Report the elevation span so trench coverage is visible in the log.
            ys = tv[1::3]
            if ys:
                print(f"[convert_map_holo] terrain elevation span: y={min(ys):.1f} .. {max(ys):.1f} "
                      f"(negative = sea floor / trenches)")
            meshes.append(("Terrain", tv, ti))

        # Step 3b: decimate the merged islands.
        if island_verts:
            print(f"[convert_map_holo] islands raw: {len(island_verts)//3} verts, "
                  f"{len(island_indices)//3} tris")
            iv, ii = decimate(island_verts, island_indices, ISLANDS_TARGET_TRIS)
            print(f"[convert_map_holo] islands baked: {len(iv)//3} verts, {len(ii)//3} tris")
            meshes.append(("Islands", iv, ii))

        if not meshes:
            print("error: no geometry extracted from the map", file=sys.stderr)
            return 1

        # Step 4: write the multi-mesh GLB.
        write_glb_multimesh(out, meshes)
        print(f"[convert_map_holo] wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
