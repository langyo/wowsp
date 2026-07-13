#!/usr/bin/env python3
"""Bake (simplify) a WoWS GLB model for holographic rendering.

Takes a high-poly GLB from wows-gltf-exporter and produces a **baked** low-poly
GLB suitable for three.js holographic display:
  - Merges all mesh primitives into one geometry
  - Drops UV/normal/color attributes (holographic shaders don't need them)
  - Decimates to a target triangle count (default 2000) — enough to show the
    ship's silhouette + turret bumps, not enough to burden the GPU
  - Applies a flat holographic material (no textures)

The result is typically 50-200KB per ship (vs 10-20MB raw), making it
practical to commit many models to the git tree.

Usage:
    python scripts/model_convert/bake_model.py input.glb -o output.glb
    python scripts/model_convert/bake_model.py input.glb --triangles 3000
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path


def parse_glb(path: Path) -> dict:
    """Parse a GLB file and return {json, binary}."""
    data = path.read_bytes()
    # GLB header: magic(4) + version(4) + length(4)
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, f"not a GLB (magic=0x{magic:08X})"
    offset = 12
    json_data = None
    bin_data = None
    while offset < length:
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk_body = data[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:  # "JSON"
            json_data = json.loads(chunk_body.decode("utf-8").rstrip("\x00"))
        elif chunk_type == 0x004E4942:  # "BIN\0"
            bin_data = chunk_body
    return {"json": json_data, "binary": bin_data or b""}


def extract_all_triangles(gltf: dict) -> tuple[list[float], list[int]]:
    """Extract all vertices + triangle indices from the GLB, merged into one
    mesh. Returns (flat_vertices_xyz, indices) where vertices is a flat list
    of floats [x,y,z, x,y,z, ...] and indices is a list of ints."""
    gjson = gltf["json"]
    binary = gltf["binary"]

    buffers = []
    for buf in gjson.get("buffers", []):
        if buf.get("uri", "").startswith("data:"):
            # Embedded base64 — not typical for GLB but handle it.
            import base64
            raw = base64.b64decode(buf["uri"].split(",", 1)[1])
            buffers.append(bytearray(raw))
        else:
            buffers.append(bytearray(binary[: buf["byteLength"]]))

    def get_buffer_view_data(bv_idx):
        bv = gjson["bufferViews"][bv_idx]
        buf = buffers[bv["buffer"]]
        start = bv.get("byteOffset", 0)
        return bytes(buf[start : start + bv["byteLength"]])

    def get_accessor_data(acc_idx):
        acc = gjson["accessors"][acc_idx]
        bv_data = get_buffer_view_data(acc["bufferView"])
        count = acc["count"]
        comp_type = acc["componentType"]
        acc_type = acc["type"]
        # Component sizes
        comp_sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
        comp_fmts = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
        type_ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
        ncomp = type_ncomp[acc_type]
        cs = comp_sizes[comp_type]
        fmt = comp_fmts[comp_type]
        offset = acc.get("byteOffset", 0)
        bv = gjson["bufferViews"][acc["bufferView"]]
        stride = bv.get("byteStride", cs * ncomp)
        values = []
        for i in range(count):
            pos = offset + i * stride
            for j in range(ncomp):
                val = struct.unpack_from(f"<{fmt}", bv_data, pos + j * cs)[0]
                values.append(val)
        if comp_type in (5125,):
            # Normalize UINT indices to int
            pass
        return values, ncomp

    all_verts: list[float] = []
    all_indices: list[int] = []

    for mesh in gjson.get("meshes", []):
        if not mesh.get("primitives"):
            continue
        for prim in mesh["primitives"]:
            if not prim.get("attributes") or prim["attributes"].get("POSITION") is None:
                continue
            # Get vertices
            pos_acc = prim["attributes"]["POSITION"]
            verts, ncomp = get_accessor_data(pos_acc)
            assert ncomp == 3
            base_vert = len(all_verts) // 3
            all_verts.extend(verts)
            # Get indices (or generate if missing)
            if prim.get("indices") is not None:
                idx_vals, _ = get_accessor_data(prim["indices"])
                # If the index accessor used UINT (5125), values are already ints
                all_indices.extend(int(v) + base_vert for v in idx_vals)
            else:
                # Non-indexed: generate sequential
                n_verts = len(verts) // 3
                for i in range(0, n_verts, 3):
                    if i + 2 < n_verts:
                        all_indices.extend([base_vert + i, base_vert + i + 1, base_vert + i + 2])

    return all_verts, all_indices


def decimate(vertices: list[float], indices: list[int], target_tris: int) -> tuple[list[float], list[int]]:
    """Simple uniform-spaced decimation: keeps every Nth vertex and
    re-triangulates as a fan. This is a crude but effective approach for
    holographic silhouettes — we don't need mesh fidelity, just the rough
    shape. For true quadric decimation, install `pymeshlab` or `fast-simplification`."""
    n_tris = len(indices) // 3
    if n_tris <= target_tris:
        return vertices, indices

    # Sample: keep every k-th triangle.
    k = n_tris / target_tris
    new_indices = []
    used_verts = set()
    for i in range(0, n_tris, max(1, int(k))):
        t0, t1, t2 = indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]
        new_indices.extend([t0, t1, t2])
        used_verts.update([t0, t1, t2])

    # Compact vertices: remap old indices to new compact range.
    sorted_used = sorted(used_verts)
    remap = {old: new for new, old in enumerate(sorted_used)}
    new_verts = []
    for old_idx in sorted_used:
        new_verts.extend(vertices[old_idx * 3 : old_idx * 3 + 3])
    new_indices = [remap[idx] for idx in new_indices]
    return new_verts, new_indices


def write_glb(path: Path, vertices: list[float], indices: list[int]):
    """Write a minimal GLB with one mesh: position attribute + indices,
    flat material."""
    # Align to 4 bytes
    def pad4(data: bytes) -> bytes:
        pad = (4 - len(data) % 4) % 4
        return data + b"\x00" * pad

    # Binary: vertices (float32) + indices (uint16 or uint32)
    n_verts = len(vertices) // 3
    idx_type = 5123 if n_verts < 65536 else 5125  # UNSIGNED_SHORT or UNSIGNED_INT
    idx_fmt = "H" if idx_type == 5123 else "I"
    idx_bytes = pad4(struct.pack(f"<{len(indices)}{idx_fmt}", *indices))
    vert_bytes = pad4(struct.pack(f"<{len(vertices)}f", *vertices))

    bin_data = vert_bytes + idx_bytes
    vert_bv_len = len(vert_bytes)
    vert_bv_off = 0
    idx_bv_off = vert_bv_len
    idx_bv_len = len(idx_bytes)  # the index buffer's own length (with its pad)

    gjson = {
        "asset": {"version": "2.0", "generator": "WoWSP bake_model.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0},
                        "indices": 1,
                        "material": 0,
                    }
                ]
            }
        ],
        "materials": [
            {
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.0, 0.67, 0.85, 1.0],
                    "metallicFactor": 0.1,
                    "roughnessFactor": 0.7,
                },
                "alphaMode": "BLEND",
                "alphaCutoff": 0.5,
                "emissiveFactor": [0.0, 0.3, 0.4],
            }
        ],
        "buffers": [{"byteLength": len(bin_data)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": vert_bv_off, "byteLength": vert_bv_len, "target": 34962},
            {"buffer": 0, "byteOffset": idx_bv_off, "byteLength": idx_bv_len, "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n_verts, "type": "VEC3"},
            {"bufferView": 1, "componentType": idx_type, "count": len(indices), "type": "SCALAR"},
        ],
    }

    json_bytes = pad4(json.dumps(gjson, separators=(",", ":")).encode("utf-8"))
    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_data)

    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total_len))
        f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(bin_data), 0x004E4942))
        f.write(bin_data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bake (simplify) a WoWS GLB for holographic rendering")
    parser.add_argument("input", help="input GLB path")
    parser.add_argument("-o", "--output", required=True, help="output GLB path")
    parser.add_argument("--triangles", type=int, default=2000, help="target triangle count (default: 2000)")
    args = parser.parse_args()

    inp = Path(args.input)
    out = Path(args.output)

    print(f"[bake] loading {inp.name} ...")
    gltf = parse_glb(inp)
    verts, indices = extract_all_triangles(gltf)
    print(f"[bake] raw: {len(verts)//3} verts, {len(indices)//3} tris")

    print(f"[bake] decimating to ~{args.triangles} tris ...")
    verts, indices = decimate(verts, indices, args.triangles)
    print(f"[bake] baked: {len(verts)//3} verts, {len(indices)//3} tris")

    write_glb(out, verts, indices)
    print(f"[bake] wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
