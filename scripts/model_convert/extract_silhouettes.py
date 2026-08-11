#!/usr/bin/env python3
"""Extract hull side-silhouettes from the baked multi-mesh ship GLBs.

For every ship model under packages/webui/src/res/models/ships/, project the
hull/ superstructure vertices onto the side plane (z = length axis, y = up)
and bake a simplified outline into silhouettes.json:

    { "<model>": { "path": "M0 28 L...Z", "bowRight": true } }

`path` is an SVG path in a 0..100 x 0..36 viewBox (bow pointing right), used
by the shared HoloShipCard as the ship's "solid photo" health plaque. Ships
without parseable geometry are skipped — the card falls back to the class
silhouette.

Usage:
    python scripts/model_convert/extract_silhouettes.py [-o silhouettes.json]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "ships"
DEFAULT_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "silhouettes.json"

# Meshes whose vertices belong to the hull silhouette (weapons excluded).
HULL_CATS = ("hull_", "superstructure", "funnel", "deck_house", "misc")


def parse_glb(path: Path) -> dict:
    data = path.read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    json_data = json.loads(data[20 : 20 + json_len].decode("utf-8").rstrip("\x00"))
    bin_start = 20 + json_len + 8
    bin_data = data[bin_start : bin_start + json_data["buffers"][0]["byteLength"]]
    return {"json": json_data, "binary": bin_data}


def mesh_vertices(glb: dict, mesh_idx: int) -> list[tuple[float, float, float]]:
    g = glb["json"]
    prim = g["meshes"][mesh_idx]["primitives"][0]
    acc = g["accessors"][prim["attributes"]["POSITION"]]
    bv = g["bufferViews"][acc["bufferView"]]
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride", 12)
    out = []
    for i in range(acc["count"]):
        x, y, z = struct.unpack_from("<fff", glb["binary"], off + i * stride)
        out.append((x, y, z))
    return out


def extract_silhouette(glb: dict) -> str | None:
    """Side outline path (0..100 × 0..36, bow right) or None."""
    g = glb["json"]
    verts: list[tuple[float, float, float]] = []
    all_verts: list[tuple[float, float, float]] = []
    matched = False
    for mesh in g.get("meshes", []):
        name = mesh.get("name", "")
        idx = g["meshes"].index(mesh)
        mv = mesh_vertices(glb, idx)
        all_verts.extend(mv)
        if name.startswith(HULL_CATS):
            verts.extend(mv)
            matched = True
    # Single-mesh (legacy) bakes: the whole model is the hull — turrets in
    # the side outline are actually more faithful to the in-game plaque.
    if not matched:
        verts = all_verts
    if len(verts) < 64:
        return None

    zs = [v[2] for v in verts]
    ys = [v[1] for v in verts]
    z0, z1 = min(zs), max(zs)
    y0, y1 = min(ys), max(ys)
    span_z = z1 - z0
    span_y = y1 - y0
    if span_z <= 1e-6 or span_y <= 1e-6:
        return None

    # Normalise to the 100 × 36 viewBox (length = x, height = y).
    def nx(z: float) -> float:
        return (z - z0) / span_z * 100.0

    def ny(y: float) -> float:
        return (y - y0) / span_y * 36.0

    # 72 height bands → per-band min/max x (lower edge / upper edge).
    BANDS = 72
    lo = [101.0] * BANDS
    hi = [-1.0] * BANDS
    for v in verts:
        b = min(BANDS - 1, max(0, int(ny(v[1]) / 36.0 * BANDS)))
        x = nx(v[2])
        if x < lo[b]:
            lo[b] = x
        if x > hi[b]:
            hi[b] = x

    # Build the closed path: lower edge left→right, upper edge right→left.
    def clamp(v: float) -> float:
        return max(0.0, min(100.0, v))

    pts: list[tuple[float, float]] = []
    for b in range(BANDS):
        if lo[b] <= 100.0:
            pts.append((clamp(lo[b]), b / BANDS * 36.0))
    for b in range(BANDS - 1, -1, -1):
        if hi[b] >= 0.0:
            pts.append((clamp(hi[b]), b / BANDS * 36.0))

    # Drop redundant collinear points.
    out: list[tuple[float, float]] = []
    for p in pts:
        if out and abs(out[-1][0] - p[0]) < 0.5 and abs(out[-1][1] - p[1]) < 0.5:
            continue
        out.append(p)
    if len(out) < 4:
        return None

    d = f"M{out[0][0]:.1f} {out[0][1]:.1f}"
    for x, y in out[1:]:
        d += f" L{x:.1f} {y:.1f}"
    d += " Z"
    return d


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default=str(DEFAULT_OUT))
    parser.add_argument("--dir", default=str(SHIPS_DIR))
    args = parser.parse_args()

    out: dict[str, dict] = {}
    ok = 0
    for glb_path in sorted(Path(args.dir).glob("*.glb")):
        try:
            glb = parse_glb(glb_path)
            path = extract_silhouette(glb)
        except Exception as e:  # noqa: BLE001
            print(f"  skip {glb_path.name}: {e}")
            continue
        if path:
            out[glb_path.stem] = {"path": path}
            ok += 1

    out_path = Path(args.output)
    out_path.write_text(
        json.dumps(out, separators=(",", ":")), encoding="utf-8"
    )
    print(f"[silhouettes] {ok} ships → {out_path} ({out_path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
