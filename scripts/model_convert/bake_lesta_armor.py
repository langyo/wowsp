#!/usr/bin/env python3
"""Export armor GLBs for the Lesta-only ships — standalone, no assets.bin.

The armor collision meshes live inside each part `.geometry` file's armor
section (already in ship space), and the plate thicknesses live in the
ship's GameParams hull `armor` dict (raw key = `(layer << 16) |
material_id` → mm). This reproduces wowsunpack's `export-armor-glb` output
(merged triangle soup + per-vertex thickness colors + normalize-to-200)
without the visual layer the Rust path still needs:

  per part .geometry → header → armor models → 16-byte BVH triangle soup
  per triangle: material_id/layer → thickness → the game's 10-bucket
  color ramp; positions/normals get -Z (left→right-handed), then the whole
  mesh is normalized to a 200-unit box — byte-for-byte the WG pack's
  armor GLB contract.

Usage:
    python scripts/model_convert/bake_lesta_armor.py \
        --gameparams "C:/lesta-out/lesta_gameparams.json" \
        --stage "C:/lesta-work/stage" --game-dir "D:/WoWS_Korabli"
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "extract"))

import batch_bake  # noqa: E402  (SHIPS_OUT)

SHIPS_OUT = batch_bake.SHIPS_OUT
WG_TREE = REPO_ROOT / "packages/webui/src/data/tech_tree.json"
LESTA_TREE = REPO_ROOT / "packages/webui/src/data/tech_tree_lesta.json"
SHIP_MODELS = REPO_ROOT / "packages/webui/src/data/ship_models.json"

# The game's ArmorConstants.py 10-bucket scale (mm breakpoint, r, g, b).
ARMOR_COLOR_SCALE = [
    (14.0, 110 / 255, 209 / 255, 176 / 255),
    (16.0, 149 / 255, 210 / 255, 127 / 255),
    (24.0, 170 / 255, 201 / 255, 102 / 255),
    (26.0, 192 / 255, 193 / 255, 80 / 255),
    (28.0, 226 / 255, 195 / 255, 62 / 255),
    (33.0, 225 / 255, 171 / 255, 54 / 255),
    (75.0, 227 / 255, 144 / 255, 49 / 255),
    (160.0, 230 / 255, 115 / 255, 49 / 255),
    (399.0, 220 / 255, 78 / 255, 48 / 255),
    (999.0, 185 / 255, 47 / 255, 48 / 255),
]


def thickness_color(mm: float) -> tuple[float, float, float, float]:
    if mm <= 0:
        return (0.8, 0.8, 0.8, 0.5)
    for bp, r, g, b in ARMOR_COLOR_SCALE:
        if mm <= bp:
            return (r, g, b, 0.8)
    r, g, b = ARMOR_COLOR_SCALE[-1][1:]
    return (r, g, b, 0.8)


def parse_armor_triangles(data: bytes):
    """The BVH triangle soup: 2 global header entries, then node groups of
    (2 header entries + vertex_count vertex entries), 16 bytes per entry."""
    ENTRY = 16
    n = len(data) // ENTRY
    if n < 4:
        return []
    pos = 2
    out = []
    while pos + 1 < n:
        h0 = pos * ENTRY
        material_id = data[h0]
        layer = data[h0 + 2]
        vertex_count = struct.unpack_from("<I", data, (pos + 1) * ENTRY + 12)[0]
        pos += 2
        if vertex_count == 0 or pos + vertex_count > n:
            break
        for t in range(vertex_count // 3):
            tri = []
            for v in range(3):
                o = (pos + t * 3 + v) * ENTRY
                x, y, z = struct.unpack_from("<3f", data, o)
                tri.append((x, y, z))
            out.append((tri, material_id, layer))
        pos += vertex_count
    return out


def geometry_armor_models(geom: bytes):
    """Header @0: 6 u32 counts (merged_v, merged_i, vm, im, collision,
    armor) then 6 i64 relptrs in the same order from @0x18; armor is last
    of each — ptr at 0x18 + 5*8 = 0x40."""
    armor_count = struct.unpack_from("<I", geom, 20)[0]
    armor_ptr = struct.unpack_from("<q", geom, 24 + 5 * 8)[0]
    models = []
    for i in range(armor_count):
        base = armor_ptr + i * 0x20
        if base + 0x20 > len(geom):
            break
        data_relptr = struct.unpack_from("<q", geom, base)[0]
        size = struct.unpack_from("<I", geom, base + 0x18)[0]
        data_start = base + 0x20
        data_end = base + data_relptr + size
        if data_end > len(geom) or data_end <= data_start:
            continue
        name_len = struct.unpack_from("<I", geom, base + 8)[0]
        name_rel = struct.unpack_from("<i", geom, base + 12)[0]
        name = ""
        if name_len and name_rel:
            no = base + 8 + name_rel
            name = geom[no:no + name_len].rstrip(b"\0").decode("utf-8", "replace")
        models.append((name, parse_armor_triangles(geom[data_start:data_end])))
    return models


def write_armor_glb(path: Path, positions, colors, indices):
    n_verts = len(positions) // 3
    idx_type = 5123 if n_verts <= 65535 else 5125

    def pad4(b: bytes, fill: int) -> bytes:
        return b + bytes([fill]) * ((4 - len(b) % 4) % 4)

    pos_bytes = pad4(b"".join(struct.pack("<3f", *positions[i:i + 3]) for i in range(0, len(positions), 3)), 0)
    col_bytes = pad4(b"".join(struct.pack("<4f", *colors[i:i + 4]) for i in range(0, len(colors), 4)), 0)
    if idx_type == 5123:
        idx_bytes = pad4(b"".join(struct.pack("<H", i) for i in indices), 0)
    else:
        idx_bytes = pad4(b"".join(struct.pack("<I", i) for i in indices), 0)
    bin_ = pos_bytes + col_bytes + idx_bytes
    po, co, io = 0, len(pos_bytes), len(pos_bytes) + len(col_bytes)
    js = {
        "asset": {"version": "2.0", "generator": "wowsp-lesta-armor"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"name": "armor", "primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "indices": 2, "mode": 4}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1]}, "emissiveFactor": [0, 0, 0]}],
        "buffers": [{"byteLength": len(bin_)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": po, "byteLength": len(pos_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": co, "byteLength": len(col_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": io, "byteLength": len(idx_bytes), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n_verts, "type": "VEC3"},
            {"bufferView": 1, "componentType": 5126, "count": n_verts, "type": "VEC4"},
            {"bufferView": 2, "componentType": idx_type, "count": len(indices), "type": "SCALAR"},
        ],
    }
    jtxt = pad4(json.dumps(js, separators=(",", ":")).encode(), 0x20)
    total = 12 + 8 + len(jtxt) + 8 + len(bin_)
    path.write_bytes(
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(jtxt), 0x4E4F534A) + jtxt
        + struct.pack("<II", len(bin_), 0x004E4942) + bin_
    )


def normalize_to_200(positions):
    n = len(positions) // 3
    if n == 0:
        return
    mn = [min(positions[i * 3 + j] for i in range(n)) for j in range(3)]
    mx = [max(positions[i * 3 + j] for i in range(n)) for j in range(3)]
    scale = 200.0 / max(mx[j] - mn[j] for j in range(3)) if any(mx[j] > mn[j] for j in range(3)) else 1.0
    c = [(mn[j] + mx[j]) / 2 for j in range(3)]
    for i in range(n):
        for j in range(3):
            positions[i * 3 + j] = (positions[i * 3 + j] - c[j]) * scale


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gameparams", required=True, help="decoded Lesta GameParams.json")
    ap.add_argument("--stage", required=True, help="extraction dir holding content/")
    ap.add_argument("--game-dir", help="Lesta install (to fetch missing part files)")
    ap.add_argument("--ooz", help="Oodle decoder for lesta_extract (unoodle preferred)")
    ap.add_argument("--out", type=Path, default=SHIPS_OUT)
    ap.add_argument("--only", help="comma list of tree indexes")
    args = ap.parse_args()

    import subprocess
    import os

    print(f"[lesta-armor] loading {args.gameparams} ...", flush=True)
    gp = json.loads(Path(args.gameparams).read_text(encoding="utf-8"))
    if isinstance(gp, list):
        gp = next(d for d in gp if isinstance(d, dict) and d)
    by_index = {v["index"]: v for v in gp.values() if isinstance(v, dict) and isinstance(v.get("index"), str)}

    wg_idx = {n["index"] for n in json.loads(WG_TREE.read_text(encoding="utf-8")).values()}
    lesta = json.loads(LESTA_TREE.read_text(encoding="utf-8"))
    only = set(filter(None, (args.only or "").split(",")))
    indexes = sorted({n["index"] for n in lesta.values() if n["index"] not in wg_idx and (not only or n["index"] in only)})

    models = json.loads(SHIP_MODELS.read_text(encoding="utf-8"))
    dir_by_index = {}
    for m in models.values():
        hm = m.get("hullModel")
        if hm and hm.startswith("content/"):
            seg = [p for p in hm.split("/") if p]
            dir_by_index.setdefault(m["index"], "/".join(seg[:-1]))

    meta_path = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract" / "wows_meta_lesta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else None

    args.out.mkdir(parents=True, exist_ok=True)
    done = skipped = failed = 0
    for idx in indexes:
        target = args.out / f"{idx}_armor.glb"
        if target.is_file() and target.stat().st_size > 0:
            skipped += 1
            continue
        base = dir_by_index.get(idx)
        ship = by_index.get(idx)
        if not base or not ship:
            print(f"[lesta-armor] WARN {idx}: no model dir / GameParams entry", flush=True)
            failed += 1
            continue

        # thickness map from the ship's hull component
        armor_dict = None
        for ck, cv in ship.items():
            if isinstance(cv, dict) and isinstance(cv.get("armor"), dict):
                armor_dict = cv["armor"]
                break
        armor_dict = armor_dict or {}

        geoms = sorted(
            e["path"].lstrip("/")
            for e in (meta or [])
            if not e.get("is_directory") and e["path"].startswith(f"/{base}/") and e["path"].endswith(".geometry")
        )
        keep = [g for g in geoms if not any(x in Path(g).stem.lower() for x in ("lod", "wire", "ports", "skinned"))]
        if not keep:
            print(f"[lesta-armor] WARN {idx}: no geometry under {base}", flush=True)
            failed += 1
            continue

        missing = [g for g in keep if not (Path(args.stage) / g).is_file()]
        if missing and args.game_dir and meta:
            subprocess.run(
                [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
                 "--game-dir", args.game_dir, "--out", str(args.stage)]
                + (["--ooz", args.ooz] if args.ooz else []) + missing,
                capture_output=True,
            )

        positions: list[float] = []
        colors: list[float] = []
        indices: list[int] = []
        tris = 0
        for g in keep:
            p = Path(args.stage) / g
            if not p.is_file():
                continue
            for _name, triangles in geometry_armor_models(p.read_bytes()):
                for tri, material_id, layer in triangles:
                    raw = armor_dict.get(str((layer << 16) | material_id))
                    mm = float(raw) if isinstance(raw, (int, float)) else 0.0
                    col = thickness_color(mm)
                    for (x, y, z) in tri:
                        # -Z: left- to right-handed, as the WG exporter does.
                        positions.extend((x, y, -z))
                        colors.extend(col)
                    indices.extend(range(tris * 3, tris * 3 + 3))
                    tris += 1
        if tris == 0:
            print(f"[lesta-armor] WARN {idx}: no armor triangles", flush=True)
            failed += 1
            continue
        normalize_to_200(positions)
        write_armor_glb(target, positions, colors, indices)
        done += 1
        print(f"[lesta-armor] {idx}: {tris:,} tris -> {target.name}", flush=True)
    print(f"[lesta-armor] done: {done} exported, {skipped} present, {failed} failed -> {args.out}")
    return 1 if failed and not done else 0


if __name__ == "__main__":
    raise SystemExit(main())
