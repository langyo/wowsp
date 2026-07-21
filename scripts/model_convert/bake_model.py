#!/usr/bin/env python3
"""Bake (simplify) a WoWS GLB model for holographic rendering.

Takes a high-poly GLB from wows-gltf-exporter and produces a **baked** low-poly
GLB suitable for three.js holographic display:
  - Merges all mesh primitives into one geometry
  - Drops UV/normal/color attributes (holographic shaders don't need them)
  - Decimates to a target triangle count (default 6000) via **vertex clustering**
    — quantizing vertices into a voxel grid and collapsing each occupied cell
    to its centroid. This keeps surfaces continuous (each cluster's triangles
    stay connected to their neighbours), unlike naive every-Nth-triangle
    sampling which shreds a watertight hull into disconnected shards.
  - Applies a flat holographic material (no textures)

The result is typically 60-150KB per ship (vs 10-20MB raw), making it
practical to commit many models to the git tree.

Usage:
    python scripts/model_convert/bake_model.py input.glb -o output.glb
    python scripts/model_convert/bake_model.py input.glb --triangles 8000
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np


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
        # All component types unpack to native Python ints/floats above, so no
        # UINT-specific normalization is needed.
        return values, ncomp

    all_verts: list[float] = []
    all_indices: list[int] = []

    # Build node→world transform lookup so turret/mounted meshes are
    # positioned correctly instead of piling up at the origin.
    nodes = gjson.get("nodes", [])
    # Compute the world matrix for every node (parent-chain multiply).
    import numpy as np

    def _node_matrix(node: dict) -> np.ndarray:
        if "matrix" in node:
            # glTF matrices are column-major.
            return np.array(node["matrix"], dtype=np.float64).reshape(4, 4, order="F")
        m = np.eye(4, dtype=np.float64)
        if "translation" in node:
            m[:3, 3] = node["translation"]
        if "rotation" in node:
            q = node["rotation"]  # [x, y, z, w]
            x, y, z, w = q
            m[:3, :3] = np.array([
                [1 - 2*y*y - 2*z*z, 2*x*y - 2*z*w, 2*x*z + 2*y*w],
                [2*x*y + 2*z*w, 1 - 2*x*x - 2*z*z, 2*y*z - 2*x*w],
                [2*x*z - 2*y*w, 2*y*z + 2*x*w, 1 - 2*x*x - 2*y*y],
            ], dtype=np.float64)
        if "scale" in node:
            s = node["scale"]
            m[:3, :3] *= np.array(s, dtype=np.float64)
        return m

    node_world = [None] * len(nodes)
    # Build parent→children map from both standard `children` arrays and
    # the non-standard `parent` field some exporters emit.
    children: dict[int, list[int]] = {i: [] for i in range(len(nodes))}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            if c < len(nodes):
                children[i].append(c)
    # Some exporters write a `parent` field instead of `children`.
    for i, n in enumerate(nodes):
        p = n.get("parent")
        if isinstance(p, int) and 0 <= p < len(nodes) and i not in children.get(p, []):
            children[p].append(i)
    # Find root nodes (nodes not referenced as any other node's child).
    has_parent = set()
    for kids in children.values():
        has_parent.update(kids)
    roots = [i for i in range(len(nodes)) if i not in has_parent]

    def _compute_world(idx: int, parent_matrix: np.ndarray = np.eye(4)):
        n = nodes[idx]
        local = _node_matrix(n)
        world = parent_matrix @ local
        node_world[idx] = world
        for c in children.get(idx, []):
            _compute_world(c, world)

    for r in roots:
        _compute_world(r)

    non_id = sum(1 for w in node_world if w is not None and not np.allclose(w, np.eye(4)))
    print(f"[bake] {len(nodes)} nodes, {len(roots)} roots, {non_id} non-identity world xforms")

    mesh_xforms = 0
    for mesh in gjson.get("meshes", []):
        if not mesh.get("primitives"):
            continue
        # Find which node(s) reference this mesh.
        mesh_idx = gjson["meshes"].index(mesh)
        world_mat = np.eye(4)
        for ni, n in enumerate(nodes):
            if n.get("mesh") == mesh_idx and node_world[ni] is not None:
                world_mat = node_world[ni]
                if not np.allclose(world_mat, np.eye(4)):
                    mesh_xforms += 1
                break
        for prim in mesh["primitives"]:
            if not prim.get("attributes") or prim["attributes"].get("POSITION") is None:
                continue
            # glTF primitive `mode` defaults to 4 (TRIANGLES). WoWS exports are
            # always triangle lists, but bail on any other topology (strip/fan/
            # lines/points) rather than mis-reading its indices as triangles.
            mode = prim.get("mode", 4)
            if mode != 4:
                continue
            # Get vertices
            pos_acc = prim["attributes"]["POSITION"]
            verts, ncomp = get_accessor_data(pos_acc)
            assert ncomp == 3
            base_vert = len(all_verts) // 3
            # Apply node world transform so turrets are at their correct positions.
            if not np.allclose(world_mat, np.eye(4)):
                v = np.array(verts, dtype=np.float64).reshape(-1, 3)
                v_h = np.column_stack([v, np.ones(len(v))])
                v_t = (world_mat @ v_h.T).T[:, :3]
                all_verts.extend(v_t.flatten().tolist())
            else:
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

    print(f"[bake] {mesh_xforms} of {len(gjson.get('meshes',[]))} meshes have non-identity xform")
    return all_verts, all_indices


def _cluster_once(verts: np.ndarray, faces: np.ndarray, pitch: float):
    """One pass of vertex clustering at a fixed voxel `pitch`.

    Each vertex is quantized to its voxel cell; vertices sharing a cell collapse
    to the cell centroid. Faces whose three corners land in the same cell become
    degenerate and are dropped. Duplicate (now-merged) faces are removed.

    Returns (new_verts, new_faces) or (None, None) if nothing survives.
    """
    if len(faces) == 0:
        return None, None
    bb_min = verts.min(axis=0)
    # Offset cells to be non-negative before packing into a single int key.
    cells = np.floor((verts - bb_min) / pitch).astype(np.int64)
    cells_off = cells - cells.min(axis=0)
    dims = cells_off.max(axis=0) + 1
    keys = (
        cells_off[:, 0] * (dims[1] * dims[2])
        + cells_off[:, 1] * dims[2]
        + cells_off[:, 2]
    )
    uniq, inv = np.unique(keys, return_inverse=True)
    # Centroid of each occupied cell (mean of its member vertices).
    new_verts = np.zeros((len(uniq), 3), dtype=np.float64)
    np.add.at(new_verts, inv, verts)
    new_verts /= np.bincount(inv)[:, None]
    # Remap faces into the compact cluster id space.
    new_faces = inv[faces]
    keep = ~(
        (new_faces[:, 0] == new_faces[:, 1])
        | (new_faces[:, 1] == new_faces[:, 2])
        | (new_faces[:, 0] == new_faces[:, 2])
    )
    new_faces = new_faces[keep]
    # Drop duplicate faces (winding ignored — a silhouette doesn't care).
    new_faces.sort(axis=1)
    new_faces = np.unique(new_faces, axis=0)
    if len(new_faces) == 0:
        return None, None
    # Compact: remove vertices left unreferenced after dedup.
    used = np.zeros(len(new_verts), dtype=bool)
    used[new_faces.reshape(-1)] = True
    remap = np.full(len(new_verts), -1, dtype=np.int64)
    remap[used] = np.arange(int(used.sum()))
    new_verts = new_verts[used]
    new_faces = remap[new_faces]
    return new_verts, new_faces


def decimate(vertices: list[float], indices: list[int], target_tris: int) -> tuple[list[float], list[int]]:
    """Vertex-clustering decimation that preserves surface continuity.

    The previous implementation kept every Nth triangle by index, which shreds
    a hull into disconnected shards because triangles in WoWS exports are laid
    out in contiguous per-region runs — sampling by index punches holes through
    every patch. Vertex clustering instead quantizes the geometry onto a voxel
    grid and collapses each cell to its centroid, so neighbouring triangles stay
    welded and the silhouette stays watertight-ish.

    The voxel pitch is searched (binary-search-ish refinement) so the output
    lands near `target_tris` rather than at an arbitrary resolution. When the
    mesh is already small enough, it's returned untouched.
    """
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(indices, dtype=np.int64).reshape(-1, 3)

    extent = float(verts.max() - verts.min())
    if extent <= 0.0:
        return vertices, indices

    n_tris = len(faces)
    if n_tris <= target_tris:
        # Already few enough triangles — but the raw GLB has per-face duplicated
        # vertices (WoWS exports aren't welded), so still run one weld pass at a
        # tiny pitch that only collapses exactly-coincident vertices. This keeps
        # the geometry identical while shrinking the vertex buffer from ~150k to
        # a few thousand, so the output file stays ~75KB instead of ~1.7MB.
        weld_pitch = extent / 100000.0
        nv, nf = _cluster_once(verts, faces, weld_pitch)
        if nv is not None and len(nf) > 0:
            return nv.reshape(-1).tolist(), nf.reshape(-1).tolist()
        return vertices, indices

    # Face count is monotonic *decreasing* in pitch (bigger pitch → more
    # collapsing → fewer faces). Binary search the pitch that yields a face
    # count closest to (but not far above) the target.
    lo = extent / 2048.0  # tiny pitch ≈ no reduction
    hi = extent / 4.0  # huge pitch ≈ aggressive
    best = None
    for _ in range(24):
        mid = (lo + hi) * 0.5
        nv, nf = _cluster_once(verts, faces, mid)
        if nv is None:
            # Too aggressive — this pitch erased everything. Back off.
            hi = mid
            continue
        got = int(len(nf))
        if got > target_tris:
            lo = mid  # need more collapsing → bigger pitch
        else:
            best = (nv, nf)
            hi = mid  # try to get closer to target from above
        if abs(got - target_tris) <= target_tris * 0.15:
            best = (nv, nf)
            break

    if best is None:
        # Fallback: single pass at a pitch sized for ~target faces. Empirical
        # calibration: face count ≈ (extent/pitch)² on a surface, so
        # pitch ≈ extent / sqrt(target).
        pitch = extent / (max(target_tris, 1) ** 0.5)
        nv, nf = _cluster_once(verts, faces, pitch)
        if nv is None:
            # Last resort: return the welded-original (faces intact, vertices
            # deduped) rather than the bloated per-face-duplicated buffer.
            nv, nf = _cluster_once(verts, faces, extent / 100000.0)
            if nv is None:
                return vertices, indices
        best = (nv, nf)

    new_verts, new_faces = best
    # Safety net: strip any vertices left unreferenced by the final face list.
    # Each decimation path is supposed to do this already, but a fallback that
    # kept the original (per-face-duplicated) buffer would otherwise emit a
    # ~1.5MB file for a 75KB model. Cheap to guarantee here.
    if len(new_verts) > 0 and len(new_faces) > 0:
        used = np.zeros(len(new_verts), dtype=bool)
        used[new_faces.reshape(-1)] = True
        if (~used).any():
            remap = np.full(len(new_verts), -1, dtype=np.int64)
            remap[used] = np.arange(int(used.sum()))
            new_verts = new_verts[used]
            new_faces = remap[new_faces]
    return new_verts.reshape(-1).tolist(), new_faces.reshape(-1).tolist()


def extract_meshes_by_name(gltf: dict) -> dict[str, tuple[list[float], list[int]]]:
    """Extract every mesh primitive from a GLB, grouped by mesh name.

    Unlike `extract_all_triangles` (which merges everything into one geometry),
    this keeps each named mesh separate so a caller can decimate + restyle them
    independently (e.g. a map's `Terrain` mesh vs its island meshes). Meshes
    with no name are grouped under the key `""`.

    Returns {name: (flat_vertices_xyz, indices)}.
    """
    gjson = gltf["json"]
    binary = gltf["binary"]

    buffers = []
    for buf in gjson.get("buffers", []):
        if buf.get("uri", "").startswith("data:"):
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
        return values, ncomp

    out: dict[str, tuple[list[float], list[int]]] = {}
    for mesh in gjson.get("meshes", []):
        name = mesh.get("name", "") or ""
        verts: list[float] = []
        indices: list[int] = []
        for prim in mesh.get("primitives", []):
            if not prim.get("attributes") or prim["attributes"].get("POSITION") is None:
                continue
            mode = prim.get("mode", 4)
            if mode != 4:
                continue
            pv, ncomp = get_accessor_data(prim["attributes"]["POSITION"])
            assert ncomp == 3
            base_vert = len(verts) // 3
            verts.extend(pv)
            if prim.get("indices") is not None:
                iv, _ = get_accessor_data(prim["indices"])
                indices.extend(int(v) + base_vert for v in iv)
            else:
                nv = len(pv) // 3
                for i in range(0, nv, 3):
                    if i + 2 < nv:
                        indices.extend([base_vert + i, base_vert + i + 1, base_vert + i + 2])
        if name in out:
            ev, ei = out[name]
            base = len(ev) // 3
            out[name] = (ev + verts, ei + [b + base for b in indices])
        else:
            out[name] = (verts, indices)
    return out


def write_glb_multimesh(
    path: Path,
    meshes: list[tuple[str, list[float], list[int]]],
):
    """Write a GLB with several named meshes in one scene.

    `meshes` is a list of (name, flat_vertices_xyz, indices). Each entry becomes
    its own mesh node (so the frontend can identify e.g. the `Terrain` mesh by
    name and restyle it). All meshes share the material conventions of
    `write_glb` (flat cyan, alpha blend) — the frontend overrides materials at
    load time for holographic styling, so the on-disk material is a placeholder.
    """
    def pad4(data: bytes) -> bytes:
        pad = (4 - len(data) % 4) % 4
        return data + b"\x00" * pad

    bin_chunks: list[bytes] = []
    accessors: list[dict] = []
    buffer_views: list[dict] = []
    gltf_meshes: list[dict] = []
    nodes: list[dict] = []
    cur_offset = 0
    for mi, (name, vertices, indices) in enumerate(meshes):
        n_verts = len(vertices) // 3
        idx_type = 5123 if n_verts < 65536 else 5125
        idx_fmt = "H" if idx_type == 5123 else "I"
        vert_bytes = pad4(struct.pack(f"<{len(vertices)}f", *vertices))
        idx_bytes = pad4(struct.pack(f"<{len(indices)}{idx_fmt}", *indices))
        pos_bv = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": cur_offset, "byteLength": len(vert_bytes), "target": 34962})
        accessors.append({"bufferView": pos_bv, "componentType": 5126, "count": n_verts, "type": "VEC3"})
        cur_offset += len(vert_bytes)
        idx_bv = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": cur_offset, "byteLength": len(idx_bytes), "target": 34963})
        accessors.append({"bufferView": idx_bv, "componentType": idx_type, "count": len(indices), "type": "SCALAR"})
        cur_offset += len(idx_bytes)
        bin_chunks.append(vert_bytes)
        bin_chunks.append(idx_bytes)
        pos_acc = len(accessors) - 2
        idx_acc = len(accessors) - 1
        gltf_meshes.append({
            "name": name,
            "primitives": [{"attributes": {"POSITION": pos_acc}, "indices": idx_acc, "material": 0}],
        })
        nodes.append({"mesh": mi, "name": name})

    bin_data = b"".join(bin_chunks)
    gjson = {
        "asset": {"version": "2.0", "generator": "WoWSP bake_model.write_glb_multimesh"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": gltf_meshes,
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
        "bufferViews": buffer_views,
        "accessors": accessors,
    }

    json_bytes = pad4(json.dumps(gjson, separators=(",", ":")).encode("utf-8"))
    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total_len))
        f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(bin_data), 0x004E4942))
        f.write(bin_data)


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
    parser.add_argument("--triangles", type=int, default=6000, help="target triangle count (default: 6000)")
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
