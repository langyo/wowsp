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


# ── Node-name classification ──────────────────────────────────────────────
# WoWS GLB node naming conventions (observed from live exports):
#   JGM*       = main gun (e.g. JGM103_457mm50_2_RF)
#   JGS*       = secondary / dual-purpose gun
#   JGA*       = anti-aircraft gun
#   JTR*       = torpedo launcher
#   JSB* / JDD* / JCR* / JBB* / JCV* / JSS* = ship body
#   JD*        = director (fire-control)
#   JF*        = rangefinder
#   JRS*       = radar
#   *Bow*      = bow hull section
#   *Stern*    = stern hull section
#   *MidBack*  = midship aft
#   *MidFront* = midship fore
#   *DeckHouse*= superstructure
#   *Turret_*  = turret visual part
#   *Director_*,*Rangefinder*,*Radar_*,*Antrenna* = equipment
#   *Funnel*,*Catapult*,*Aircraft* = other
#   *Shield_*  = armor plate

import re
_GUN_PREFIX = re.compile(r'^[A-Z]G[MAST]', re.IGNORECASE)
# G M = main, G S = secondary, G A = anti-air, G T = torpedo

def _classify_node(node_name: str) -> str:
    """Map a raw WoWS GLB node name to a mesh-group category.
    Categories are the keys the frontend uses for per-group coloring."""
    n = (node_name or "").strip()
    if not n:
        return "misc"

    # ── Weapon classification (by WoWS gun prefix) ──
    if _GUN_PREFIX.match(n):
        prefix2 = n[1:3].upper() if len(n) >= 3 else ""
        if prefix2 == "GM":
            return "main_battery"
        if prefix2 == "GS":
            return "secondary_battery"
        if prefix2 == "GA":
            return "aa_mount"
        if prefix2 == "GT":
            return "torpedo"
        # unknown gun prefix → generic weapon
        return "weapon"

    nl = n.lower()

    # ── Torpedo / ASW (by keyword) ──
    if "torpedo" in nl or "jtr" in nl or "tube" in nl:
        return "torpedo"

    # ── Propellers (ship shafts) ──
    # Classified separately from misc so each screw keeps its own bake
    # instance and a decimation floor — clustered at misc's raw-triangle
    # share they collapse into lumps (thin twisted blades weld through).
    if "propeller" in nl or "prop_" in nl:
        return "propeller"

    # ── Aircraft ──
    if "catapult" in nl or "aircraft" in nl or "plane" in nl or "seaplane" in nl:
        return "aircraft"

    # ── Funnel ──
    if "funnel" in nl or "smoke" in nl:
        return "funnel"

    # ── Hull sections ──
    if "bow" in nl:
        return "hull_bow"
    if "stern" in nl:
        return "hull_stern"
    if "midback" in nl or "mid_back" in nl:
        return "hull_mid"
    if "midfront" in nl or "mid_front" in nl:
        return "hull_mid"
    # Ship-body prefix (any nation's S, D, C, B, V, S hull)
    # e.g. JSB, ADB, GBB, PCB, etc.
    if re.match(r'^[A-Z][SDB]B?\d', n) or re.match(r'^[A-Z]CV\d', n):
        return "hull_body"
    if "deckhouse" in nl:
        return "deck_house"

    # ── Equipment / Superstructure ──
    if "director" in nl or re.match(r'^[A-Z]D\d', n):
        return "superstructure"
    if "rangefinder" in nl or re.match(r'^[A-Z]F\d', n):
        return "superstructure"
    if "radar" in nl or re.match(r'^[A-Z]RS\d', n):
        return "superstructure"
    if "antrenna" in nl or "antenna" in nl:
        return "superstructure"
    if "sokutekiban" in nl:
        return "superstructure"

    # ── Turret / mount visual parts ──
    if "turret" in nl:
        return "turret_part"

    # ── Shield / armor ──
    if "shield" in nl:
        return "hull_body"

    # ── LOD mesh copies (generic names, classify by parent) ──
    # We'll handle these via parent-chain lookup later.

    return "misc"


def extract_by_category(gltf: dict) -> dict[str, tuple[list[float], list[int]]]:
    """Extract geometry grouped by semantic category.
    Returns {category_name: (flat_vertices_xyz, indices)}.
    Categories: hull_body, hull_bow, hull_mid, hull_stern, deck_house,
                main_battery, secondary_battery, aa_mount, torpedo, aircraft,
                funnel, superstructure, turret_part, weapon, misc."""
    buckets = extract_by_instance(gltf)
    merged: dict[str, tuple[list[float], list[int]]] = {}
    for cat, insts in buckets.items():
        v: list[float] = []
        i: list[int] = []
        for inst, (iv, ii) in insts.items():
            base = len(v) // 3
            v.extend(iv)
            i.extend(b + base for b in ii)
        merged[cat] = (v, i)
    return merged


# Weapon HP-instance categories: each AGM/AGS/AGA/… node is one physical
# mount. extract_by_instance keeps them SEPARATE (main_battery_0..N) so the
# frontend can address individual turrets while still colouring by category.
# Propellers join them so each screw is decimated (and floored) on its own
# instead of sharing one bucket with boats and deck fittings.
WEAPON_INSTANCE_CATS = {
    "main_battery", "secondary_battery", "aa_mount", "torpedo",
    "aircraft", "weapon", "turret_part", "propeller",
}

_INSTANCE_NO = re.compile(r"\(HP_\w+_(\d+)\)|_(\d+)\s*$")


# Two primitives whose bounding boxes agree on every corner within this
# fraction of the model's structure scale are the same section at different
# LODs. Measured on plane exports: true LOD sets coincide to <0.2% of the
# extent, while neighbouring sections (a canopy inside the fuselage box,
# prim-15-style detail plates) miss at least one bound by >1% — the window
# separates them with margin on both sides.
LOD_BBOX_TOL_PCT = 0.005


def _lod_structure_scale(diags: np.ndarray) -> float:
    """Robust length scale of the model's real structure, from the primitive
    bbox diagonals.

    The window above is RELATIVE, so its reference must not move when a stray
    far-away piece (a discarded catapult shuttle, an unused state mesh parked
    off to the side) inflates the global bounding box: on a 10x-inflated
    extent the tolerance would swallow neighbouring sections that miss their
    shared bounds by ~1% of the TRUE extent — silent geometry loss. The
    SECOND-largest diagonal is the model's largest companion section: one
    large far-away stray — which can only ever rank first — cannot move it,
    and small strays sort below the real structure and are harmless (two or
    more strays larger than everything real would still slip through; none
    exist in the measured exports, and the window can only ever NARROW
    against the master baseline, never widen). With no strays the scale sits
    within a small factor of the global extent — a plane's fuselage and wing
    diagonals are near-equal, a fuselage-dominated model lands near half of
    it — and the window's 5x documented margin absorbs that reference shift
    down to ~0.4x of the extent; a single-primitive model falls back to its
    only diagonal.
    """
    ordered = np.sort(np.asarray(diags, dtype=np.float64))
    if not len(ordered):
        return 0.0
    return float(ordered[-2]) if len(ordered) >= 2 else float(ordered[-1])


def dedup_lod_primitives(
    staged: list[tuple[str, str, np.ndarray, np.ndarray]],
) -> tuple[list[tuple[str, str, np.ndarray, np.ndarray]], dict]:
    """Collapse WoWS LOD sets — equal-bbox primitives — to their top detail.

    Plane .geometry files carry every section at three detail levels: one
    primitive each, identical transforms, IDENTICAL bounding boxes, decreasing
    triangle counts. Merging all of them (the old behaviour) pushes three
    overlapping shells of every section through the vertex clustering, and
    wherever the shells disagree they leave doubled surfaces whose stray bits
    the cull then measures as detached debris — measured on the shipped plane
    pack: 470/865 GLBs carry surviving detached geometry, up to a 19%-extent
    626-triangle flake, which is the "detached small component" the airframe
    stage shows. Grouping by bounding box keeps only the densest primitive of
    each set — the surface the game itself draws.

    Matching is per (category, instance) bucket and per-axis on BOTH bbox
    corners, within `LOD_BBOX_TOL_PCT` of the structure scale (`_lod_structure_scale`,
    robust against far-away strays): mirrored or adjacent sections sit at
    different positions, and sections that merely overlap (a canopy inside the
    fuselage box) never match all six bounds, so both survive. Ties keep the
    earliest primitive, so output is deterministic. Non-finite bounds never
    match (they would silently swallow everything).
    """
    stats = {"sets": 0, "dropped": 0, "dropped_tris": 0}
    if not staged:
        return staged, stats
    boxes: dict[tuple[str, str], list[tuple[int, np.ndarray, np.ndarray, int]]] = {}
    diags: list[float] = []
    for si, (cat, inst, vt, prim_idx) in enumerate(staged):
        if len(vt) == 0:
            continue
        lo = np.asarray(vt, dtype=np.float64).min(axis=0)
        hi = np.asarray(vt, dtype=np.float64).max(axis=0)
        if not (np.isfinite(lo).all() and np.isfinite(hi).all()):
            continue
        diags.append(float(np.linalg.norm(hi - lo)))
        bucket = boxes.setdefault((cat, inst), [])
        bucket.append((si, lo, hi, len(prim_idx) // 3))
    if not diags:  # every primitive empty or non-finite — nothing to scale
        return staged, stats
    scale = _lod_structure_scale(np.asarray(diags, dtype=np.float64))
    if not scale > 0:
        return staged, stats
    tol = LOD_BBOX_TOL_PCT * scale
    drop: set[int] = set()
    for members in boxes.values():
        if len(members) < 2:
            continue
        order = sorted(members, key=lambda m: (-m[3], m[0]))
        for i, rep in enumerate(order):
            if rep[0] in drop:
                continue
            absorbed: set[int] = set()
            for cand in order[i + 1 :]:
                if cand[0] in drop or cand[0] in absorbed:
                    continue
                if np.all(np.abs(rep[1] - cand[1]) <= tol) and np.all(
                    np.abs(rep[2] - cand[2]) <= tol
                ):
                    absorbed.add(cand[0])
            if absorbed:
                stats["sets"] += 1
                stats["dropped"] += len(absorbed)
                stats["dropped_tris"] += sum(m[3] for m in members if m[0] in absorbed)
                drop |= absorbed
    if not drop:
        return staged, stats
    return [s for si, s in enumerate(staged) if si not in drop], stats


def extract_by_instance(gltf: dict, dedup_lods: bool = False) -> dict[str, dict[str, tuple[list[float], list[int]]]]:
    """Extract geometry grouped by (category, weapon instance).

    Returns {category: {instance_label: (verts, indices)}}. Hull categories
    use instance "0"; every weapon mount (AGM_1, AGS_3, …) keeps its own
    labelled group (main_battery_0, main_battery_1, …) so single turrets /
    mounts are addressable downstream, while staying same-coloured per
    category in the UI.

    With `dedup_lods`, primitives whose bounding boxes coincide (WoWS LOD
    sets) collapse to their densest member before any budget is spent — see
    `dedup_lod_primitives`; the matching window keys on a structure scale
    computed from the staged primitives themselves, not the global extent.
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

    from collections import defaultdict
    buckets: dict[str, dict[str, tuple[list[float], list[int]]]] = defaultdict(dict)

    # Node→world transform lookup (same as extract_by_category).
    nodes = gjson.get("nodes", [])
    import numpy as np

    def _node_matrix(node: dict) -> np.ndarray:
        if "matrix" in node:
            return np.array(node["matrix"], dtype=np.float64).reshape(4, 4, order="F")
        m = np.eye(4, dtype=np.float64)
        if "translation" in node:
            m[:3, 3] = node["translation"]
        if "rotation" in node:
            q = node["rotation"]
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
    children: dict[int, list[int]] = {i: [] for i in range(len(nodes))}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            if c < len(nodes):
                children[i].append(c)
    for i, n in enumerate(nodes):
        p = n.get("parent")
        if isinstance(p, int) and 0 <= p < len(nodes) and i not in children.get(p, []):
            children[p].append(i)
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

    parent_of: dict[int, int] = {}
    for pi, kids in children.items():
        for ci in kids:
            parent_of[ci] = pi
    for i, n in enumerate(nodes):
        p = n.get("parent")
        if isinstance(p, int) and 0 <= p < len(nodes) and i not in parent_of:
            parent_of[i] = p

    node_cat: list[str] = []
    for ni, n in enumerate(nodes):
        name = n.get("name") or ""
        cat = _classify_node(name)
        if cat in ("turret_part", "misc"):
            low = name.lower()
            if "lod" in low or "turret" in low:
                pi = parent_of.get(ni)
                if pi is not None:
                    parent_cat = _classify_node(nodes[pi].get("name") or "")
                    if parent_cat not in ("turret_part", "misc"):
                        cat = parent_cat
        node_cat.append(cat)

    def instance_label(ni: int, cat: str) -> str:
        if cat not in WEAPON_INSTANCE_CATS:
            return "0"
        name = nodes[ni].get("name") or ""
        m = _INSTANCE_NO.search(name)
        num = m.group(1) or m.group(2) if m else None
        return num if num is not None else str(ni)

    # Stage every primitive first: the tiny-part cutoff is RELATIVE to the
    # whole model's extent (planes export at ~1 unit overall, so the old
    # absolute 0.2 was erasing spinners and pitot tubes on them), and the
    # billboard cull needs per-primitive shape stats anyway.
    staged: list[tuple[str, str, np.ndarray, np.ndarray]] = []
    for mesh in gjson.get("meshes", []):
        if not mesh.get("primitives"):
            continue
        mesh_idx = gjson["meshes"].index(mesh)
        world_mats: list[tuple[int, np.ndarray]] = []
        for ni, n in enumerate(nodes):
            if n.get("mesh") == mesh_idx and node_world[ni] is not None:
                w = node_world[ni]
                world_mats.append((ni, w))
        if not world_mats:
            world_mats = [(-1, np.eye(4))]

        for ni, world_mat in world_mats:
            cat = node_cat[ni] if ni >= 0 else "misc"
            inst = instance_label(ni, cat) if ni >= 0 else "0"
            # children of a weapon mount (turret parts, barrels) belong to the
            # SAME instance — walk up to the owning weapon HP node.
            if ni >= 0 and cat in ("turret_part", "misc"):
                cur = ni
                while cur is not None:
                    p = parent_of.get(cur)
                    if p is None:
                        break
                    pc = node_cat[p]
                    if pc in WEAPON_INSTANCE_CATS and pc != "turret_part":
                        cat = pc
                        inst = instance_label(p, pc)
                        break
                    cur = p
            for prim in mesh["primitives"]:
                if not prim.get("attributes") or prim["attributes"].get("POSITION") is None:
                    continue
                mode = prim.get("mode", 4)
                if mode != 4:
                    continue
                pos_acc = prim["attributes"]["POSITION"]
                verts, ncomp = get_accessor_data(pos_acc)
                assert ncomp == 3
                if not np.allclose(world_mat, np.eye(4)):
                    v = np.array(verts, dtype=np.float64).reshape(-1, 3)
                    v_h = np.column_stack([v, np.ones(len(v))])
                    vt = (world_mat @ v_h.T).T[:, :3]
                else:
                    vt = np.array(verts, dtype=np.float64).reshape(-1, 3)

                if prim.get("indices") is not None:
                    idx_vals, _ = get_accessor_data(prim["indices"])
                    prim_idx = np.asarray(idx_vals, dtype=np.int64)
                else:
                    n_verts = len(verts) // 3
                    prim_idx = np.arange(n_verts, dtype=np.int64).reshape(-1, 3).reshape(-1)
                staged.append((cat, inst, vt, prim_idx))

    # Relative cutoffs: drop sub-0.2% slivers (same spirit as the old
    # absolute 0.2 on full-scale ships) and texture-billboard quads — flat
    # ≤8-vertex sheets are prop-blur discs, flags and decals that render as
    # translucent rectangles under the holographic material.
    dropped_tiny = 0
    dropped_billboard = 0
    if staged:
        gmin = np.min([s[2].min(axis=0) for s in staged], axis=0)
        gmax = np.max([s[2].max(axis=0) for s in staged], axis=0)
        model_extent = float((gmax - gmin).max())
    else:
        model_extent = 0.0
    if dedup_lods:
        staged, dedup_stats = dedup_lod_primitives(staged)
        if dedup_stats["dropped"]:
            print(f"[bake] deduped {dedup_stats['sets']} LOD set(s): dropped "
                  f"{dedup_stats['dropped']} duplicate primitive(s) "
                  f"({dedup_stats['dropped_tris']} tris)")
    min_extent = min(0.2, model_extent * 0.002) if model_extent > 0 else 0.2
    for cat, inst, vt, prim_idx in staged:
        bb_min = vt.min(axis=0)
        bb_max = vt.max(axis=0)
        extent = bb_max - bb_min
        if extent.max() < min_extent:
            dropped_tiny += 1
            continue
        if len(vt) <= 8 and len(prim_idx) <= 8 and extent.min() < extent.max() * 0.005:
            dropped_billboard += 1
            continue
        target = buckets[cat].setdefault(inst, ([], []))
        verts_target, idx_target = target
        base_vert = len(verts_target) // 3
        verts_target.extend(vt.flatten().tolist())
        idx_target.extend(int(i) + base_vert for i in prim_idx)

    if dropped_tiny or dropped_billboard:
        print(f"[bake] culled {dropped_tiny} tiny / {dropped_billboard} billboard parts "
              f"(min extent {min_extent:.4f})")

    # Report
    for cat in sorted(buckets):
        parts = []
        for inst, (v, idx) in buckets[cat].items():
            if len(idx) > 0:
                parts.append(f"{inst}:{len(v)//3}v/{len(idx)//3}t")
        if parts:
            print(f"[bake] {cat}: {'  '.join(parts)}")
    return {cat: insts for cat, insts in buckets.items() if any(len(i) > 0 for _, (_, i) in insts.items())}


def _face_normal_bins(verts: np.ndarray, faces: np.ndarray, bins: int) -> np.ndarray:
    """Quantize each face's normal direction into a `bins`×`bins` octahedral
    class. Opposite faces of a thin sheet land in different classes, which is
    what keeps clustering from welding them into a blob."""
    tri = verts[faces]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(fn, axis=1)
    ok = ln > 1e-12
    fn[ok] /= ln[ok][:, None]
    l1 = np.abs(fn).sum(axis=1) + 1e-12
    ax = fn[:, 0] / l1
    ay = fn[:, 1] / l1
    # Octahedral fold: the z<0 hemisphere maps onto the square's border, so
    # ±z normals land in different classes (horizontal thin sheets too).
    # sign() is branchless ±1 (never 0) — exact ±z poles would otherwise
    # collapse back onto the +z pole through the fold.
    neg = fn[:, 2] < 0
    sx = np.where(fn[:, 0] >= 0, 1.0, -1.0)
    sy = np.where(fn[:, 1] >= 0, 1.0, -1.0)
    axf = np.where(neg, (1 - np.abs(ay)) * sx, ax)
    ayf = np.where(neg, (1 - np.abs(ax)) * sy, ay)
    qx = np.clip(((axf * 0.5 + 0.5) * bins).astype(np.int64), 0, bins - 1)
    qy = np.clip(((ayf * 0.5 + 0.5) * bins).astype(np.int64), 0, bins - 1)
    return qx * bins + qy


def _cluster_once(verts: np.ndarray, faces: np.ndarray, pitch: float,
                  normal_bins: int = 0):
    """One pass of vertex clustering at a fixed voxel `pitch`.

    Each vertex is quantized to its voxel cell; vertices sharing a cell collapse
    to the cell centroid. Faces whose three corners land in the same cluster
    become degenerate and are dropped. Duplicate (now-merged) faces are removed.

    With `normal_bins` > 0 the cluster key also carries a quantized FACE-normal
    class, and clusters are computed per face corner. Thin structures (propeller
    blades, railings, chain plates) keep their opposite surfaces as separate
    sheets instead of collapsing into a single welded centroid — the classic
    failure that turned propellers into blobs at plane budgets.

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

    if normal_bins > 0:
        # Normal-aware pass: cluster per face corner under (voxel, orientation).
        nb = normal_bins * normal_bins
        fbin = _face_normal_bins(verts, faces, normal_bins)
        corner_keys = (keys[faces] * nb + fbin[:, None]).reshape(-1)
        corner_pos = verts[faces.reshape(-1)]
        uniq, inv = np.unique(corner_keys, return_inverse=True)
        new_verts = np.zeros((len(uniq), 3), dtype=np.float64)
        np.add.at(new_verts, inv, corner_pos)
        cnt = np.bincount(inv, minlength=len(uniq))[:, None]
        new_verts /= np.maximum(cnt, 1)
        new_faces = inv.reshape(-1, 3)
    else:
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


def decimate(vertices: list[float], indices: list[int], target_tris: int,
             normal_bins: int = 3) -> tuple[list[float], list[int]]:
    """Vertex-clustering decimation that preserves surface continuity.

    The previous implementation kept every Nth triangle by index, which shreds
    a hull into disconnected shards because triangles in WoWS exports are laid
    out in contiguous per-region runs — sampling by index punches holes through
    every patch. Vertex clustering instead quantizes the geometry onto a voxel
    grid and collapses each cell to its centroid, so neighbouring triangles stay
    welded and the silhouette stays watertight-ish.

    The reduction passes are normal-aware (`normal_bins` × `normal_bins`
    orientation classes in the cluster key): opposite sides of thin geometry no
    longer weld into one centroid, so propellers, railings and hull fittings
    survive as readable sheets instead of collapsing into blobs. The exact
    weld used for already-small meshes keeps `normal_bins=0` — there we want
    byte-identical geometry, just deduped.

    The voxel pitch is searched (binary-search-ish refinement) so the output
    lands near `target_tris` rather than at an arbitrary resolution. When the
    mesh is already small enough, it's returned untouched.
    """
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(indices, dtype=np.int64).reshape(-1, 3)

    # Defensive: a handful of exporter outputs (mostly multi-primitive plane
    # models) contain a few face indices at/past the vertex-count boundary
    # (off-by-one junk). Dropping those triangles is visually harmless;
    # letting them through crashes np.unique's inverse indexing below.
    in_range = (faces >= 0).all(axis=1) & (faces < len(verts)).all(axis=1)
    if not in_range.all():
        dropped = int((~in_range).sum())
        faces = faces[in_range]
        print(f"[bake] dropped {dropped} out-of-range triangles")

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
        nv, nf = _cluster_once(verts, faces, mid, normal_bins=normal_bins)
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
        nv, nf = _cluster_once(verts, faces, pitch, normal_bins=normal_bins)
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


# ── Floating-artifact cull ────────────────────────────────────────────────
# Vertex clustering leaves two artifacts that read as junk under the viewer's
# rim-lit transparency: NEEDLE triangles (a corner collapsed into a far cell, so
# the triangle keeps a long bounding box while its area collapses — an edge of
# it paints as a floating hairline over the superstructure) and small fragments
# the clustering cut loose from the hull. Both are measured against the model's
# own extent. The viewer prunes the same two artifacts at load time
# (`packages/webui/src/features/holographic/debrisPrune.ts`) so an already
# shipped pack renders clean — keep the thresholds in sync with that module.
CULL_CONTACT_PCT = 0.005
CULL_NEEDLE_MAX_TRIS = 8
CULL_NEEDLE_MIN_EXTENT_PCT = 0.015
CULL_NEEDLE_MIN_FILL = 0.25
CULL_MICRO_MAX_TRIS = 12
CULL_MICRO_SPAN_CEILING_PCT = 0.25
CULL_MICRO_MAX_EXTENT_PCT = 0.03
CULL_MICRO_TRI_CAP = 200


class _DSU:
    def __init__(self, n: int):
        self.parent = np.arange(n, dtype=np.int64)

    def find(self, a: int) -> int:
        p = self.parent
        root = a
        while p[root] != root:
            root = p[root]
        while p[a] != root:
            p[a], a = root, p[a]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _point_triangle_distance2(points: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """Squared distance from each `points` row to the triangle (3, 3).

    Voronoi-region walk of Ericson, Real-Time Collision Detection §5.1.5 —
    the exact surface distance, so a fitting resting in the MIDDLE of a coarse
    plate counts as attached however far the plate's corners are.
    """
    a, b, c = tri[0], tri[1], tri[2]
    ab = b - a
    ac = c - a
    ap = points - a
    d1 = ap @ ab
    d2 = ap @ ac
    bp = points - b
    d3 = bp @ ab
    d4 = bp @ ac
    cp = points - c
    d5 = cp @ ab
    d6 = cp @ ac
    out = np.empty(len(points))
    # Fully degenerate triangles — two corners collapsed onto one another, or
    # exactly collinear points, both of which a cluster bake emits — have no
    # interior to project onto and drive the region walk's divisions into
    # rounding noise. Their surface IS their edges, so measure against each.
    bc = c - b
    cross = np.cross(ab, ac)
    cross2 = float(cross @ cross)
    longest_edge2 = max(float(ab @ ab), float(ac @ ac), float(bc @ bc))
    if cross2 <= 1e-18 * longest_edge2 * longest_edge2:
        def _seg(p0, p1):
            d = p1 - p0
            d2 = float(d @ d)
            if d2 <= 1e-24:
                q = points - p0
                return np.einsum("ij,ij->i", q, q)
            t = np.clip(((points - p0) @ d) / d2, 0.0, 1.0)
            q = (points - p0) - t[:, None] * d
            return np.einsum("ij,ij->i", q, q)

        return np.minimum(np.minimum(_seg(a, b), _seg(a, c)), _seg(b, c))
    m = (d1 <= 0) & (d2 <= 0)
    out[m] = np.einsum("ij,ij->i", ap[m], ap[m])
    m2 = (d3 >= 0) & (d4 <= d3)
    out[m2] = np.einsum("ij,ij->i", bp[m2], bp[m2])
    rest = ~(m | m2)
    vc = d1 * d4 - d3 * d2
    m4 = rest & (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    v = np.where(m4, d1 / np.maximum(d1 - d3, 1e-30), 0.0)
    q = ap - v[:, None] * ab
    out[m4] = np.einsum("ij,ij->i", q[m4], q[m4])
    rest = rest & ~m4
    m3 = rest & (d6 >= 0) & (d5 <= d6)
    out[m3] = np.einsum("ij,ij->i", cp[m3], cp[m3])
    rest = rest & ~m3
    vb = d5 * d2 - d1 * d6
    m5 = rest & (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    w = np.where(m5, d2 / np.maximum(d2 - d6, 1e-30), 0.0)
    q = ap - w[:, None] * ac
    out[m5] = np.einsum("ij,ij->i", q[m5], q[m5])
    rest = rest & ~m5
    va = d3 * d6 - d5 * d4
    m6 = rest & (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    wb = np.where(m6, (d4 - d3) / np.maximum((d4 - d3) + (d5 - d6), 1e-30), 0.0)
    # closest = b + wb·(c - b) = b + wb·(cp - bp), so q = bp + wb·(cp - bp).
    q = bp + wb[:, None] * (cp - bp)
    out[m6] = np.einsum("ij,ij->i", q[m6], q[m6])
    rest = rest & ~m6
    denom = np.maximum(va + vb + vc, 1e-30)
    vv = (vb / denom)[rest]
    ww = (vc / denom)[rest]
    qq = ap[rest] - (vv[:, None] * ab + ww[:, None] * ac)
    out[rest] = np.einsum("ij,ij->i", qq, qq)
    return out


def cull_floating_artifacts(
    parts: list[tuple[str, list[float], list[int]]],
) -> tuple[list[tuple[str, list[float], list[int]]], dict]:
    """Drop needle triangles and detached micro-fragments from baked parts.

    `parts` is [(name, flat_vertices_xyz, indices)] as handled by `main()`.
    Returns the filtered parts plus a stats dict for the bake log.
    """
    if not parts:
        return parts, {"needles": 0, "needle_tris": 0, "fragments": 0, "fragment_tris": 0}

    # Coincident duplicates are the norm in a cluster bake (the orientation-aware
    # clustering keeps per-orientation copies), and the viewer welds them before
    # pruning. Weld the analysis view the same way, or components fragment and
    # perfectly attached fittings read as floating.
    data = []
    for name, verts, idx in parts:
        v = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
        f = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
        keys = np.trunc(v / 1e-4 + 0.5).astype(np.int64)
        _, canon = np.unique(keys, axis=0, return_inverse=True)
        canon = canon.reshape(-1)
        # One representative position per canonical vertex.
        welded = np.zeros((int(canon.max()) + 1, 3), dtype=np.float64)
        welded[canon] = v
        data.append((name, welded, canon[f]))
    allv = np.vstack([v for _, v, _ in data])
    gmin, gmax = allv.min(axis=0), allv.max(axis=0)
    extent = float((gmax - gmin).max())
    if not extent > 0:
        return parts, {"needles": 0, "needle_tris": 0, "fragments": 0, "fragment_tris": 0}

    # ── Components (shared-vertex islands) per part, with their metrics.
    comps = []  # dicts: part, faces(ids), verts(ids), ntri, bbox, area
    drop = [np.zeros(len(f), dtype=bool) for _, _, f in data]
    for pi, (_, verts, faces) in enumerate(data):
        dsu = _DSU(len(verts))
        for a, b, c in faces:
            dsu.union(int(a), int(b))
            dsu.union(int(a), int(c))
        roots = np.array([dsu.find(i) for i in range(len(verts))], dtype=np.int64)
        face_root = roots[faces[:, 0]]
        for r in np.unique(face_root):
            fids = np.flatnonzero(face_root == r)
            tri = faces[fids]
            pts = verts[tri.reshape(-1)]
            cross = np.cross(verts[tri[:, 1]] - verts[tri[:, 0]],
                             verts[tri[:, 2]] - verts[tri[:, 0]])
            # Malformed coordinates are skipped rather than propagated: a NaN
            # bound or sample silences every comparison it takes part in.
            areas = 0.5 * np.linalg.norm(cross, axis=1)
            area = float(areas[np.isfinite(areas)].sum())
            if len(pts) and not np.isfinite(pts).all():
                pts = pts[np.isfinite(pts).all(axis=1)]
            comps.append({
                "part": pi,
                "faces": fids,
                "verts": np.unique(tri),
                "ntri": len(fids),
                "min": pts.min(axis=0) if len(pts) else np.zeros(3),
                "max": pts.max(axis=0) if len(pts) else np.zeros(3),
                "area": area,
            })

    # ── Rule 1 — needle triangles: a long bounding box with no surface left.
    stats = {"needles": 0, "needle_tris": 0, "fragments": 0, "fragment_tris": 0}
    for ci, comp in enumerate(comps):
        if comp["ntri"] > CULL_NEEDLE_MAX_TRIS:
            continue
        bb = comp["max"] - comp["min"]
        longest = float(bb.max())
        if longest < CULL_NEEDLE_MIN_EXTENT_PCT * extent:
            continue
        mid = float(np.sort(bb)[-2])
        fill = comp["area"] / max(0.5 * longest * mid, 1e-12)
        if comp["area"] > 0 and fill > CULL_NEEDLE_MIN_FILL:
            continue
        drop[comp["part"]][comp["faces"]] = True
        stats["needles"] += 1
        stats["needle_tris"] += comp["ntri"]

    # ── Rule 2 — detached fragments. Vertex cells the size of the contact
    #    distance; two samples within it attach their components.
    contact_eps = CULL_CONTACT_PCT * extent
    eps2 = contact_eps * contact_eps
    sample_comp = np.concatenate([np.full(len(c["verts"]), ci, dtype=np.int64)
                                  for ci, c in enumerate(comps)])
    sample_xyz = np.concatenate([data[c["part"]][1][c["verts"]] for c in comps])
    finite = np.isfinite(sample_xyz).all(axis=1)
    if not finite.all():
        keep = np.flatnonzero(finite)
        sample_comp = sample_comp[keep]
        sample_xyz = sample_xyz[keep]
    cells = np.floor((sample_xyz - gmin) / contact_eps).astype(np.int64)
    key = cells[:, 0] + cells[:, 1] * 100000 + cells[:, 2] * 100000 ** 2
    order = np.argsort(key, kind="stable")
    skey = key[order]
    bounds = np.flatnonzero(np.diff(skey) != 0) + 1
    starts = np.concatenate([[0], bounds])
    ends = np.concatenate([bounds, [len(skey)]])
    cell_index = {}
    for cell, s, e in zip(cells[order][starts], starts, ends):
        cell_index[tuple(cell)] = (s, e)
    comp_dsu = _DSU(len(comps))
    offsets = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
               if (dx, dy, dz) > (0, 0, 0)]
    for s0, e0 in zip(starts, ends):
        members_a = order[s0:e0]
        cell_a = cells[order[s0]]
        pairs = [(members_a, members_a)]
        for dx, dy, dz in offsets:
            other = cell_index.get((cell_a[0] + dx, cell_a[1] + dy, cell_a[2] + dz))
            if other is not None:
                pairs.append((members_a, order[other[0]:other[1]]))
        for a_ids, b_ids in pairs:
            if len(a_ids) == 0 or len(b_ids) == 0:
                continue
            d = sample_xyz[a_ids][:, None, :] - sample_xyz[b_ids][None, :, :]
            close = (d * d).sum(axis=2) <= eps2
            for ai, bi in zip(*np.nonzero(close)):
                ca, cb = sample_comp[a_ids[ai]], sample_comp[b_ids[bi]]
                if ca != cb:
                    comp_dsu.union(int(ca), int(cb))

    # ── Rule 2b — the coarse plates. A vertex-to-vertex test proves nothing
    #    about a plate whose corners are far apart, so components stage 1 left
    #    out of the body get an exact point-to-triangle pass against triangles
    #    longer than the contact distance. (The viewer does the same, and the
    #    two implementations must agree: without this pass a fitting resting in
    #    the middle of a deck plate reads as floating.)
    # The body is the group with the widest UNION bounding box (the viewer's
    # `pickBody`): a per-component span would disagree with it and change which
    # components this pass even considers.
    body_root = -1
    best_span = -1.0
    best_surviving = -1
    group_min: dict[int, np.ndarray] = {}
    group_max: dict[int, np.ndarray] = {}
    group_surviving: dict[int, int] = {}
    group_tris: dict[int, int] = {}
    for ci, comp in enumerate(comps):
        root = comp_dsu.find(ci)
        alive = int((~drop[comp["part"]][comp["faces"]]).sum())
        group_surviving[root] = group_surviving.get(root, 0) + alive
        group_tris[root] = group_tris.get(root, 0) + comp["ntri"]
        group_min[root] = np.minimum(group_min.get(root, comp["min"]), comp["min"])
        group_max[root] = np.maximum(group_max.get(root, comp["max"]), comp["max"])
    for root, surviving in group_surviving.items():
        if surviving == 0:
            continue
        span = float((group_max[root] - group_min[root]).max())
        if span > best_span or (span == best_span and surviving > best_surviving):
            body_root, best_span, best_surviving = root, span, surviving

    #    Every triangle is indexed, matching the viewer, and their bounding
    #    boxes pre-filter the exact tests.
    large = []
    large_comp = []
    for ci, comp in enumerate(comps):
        _, verts, faces = data[comp["part"]]
        tri = verts[faces[comp["faces"]]]
        # Every triangle is indexed, matching the viewer: a fitting can rest on
        # the interior of a sliver whose corners are all farther than the
        # contact distance, which the vertex-level pass cannot see.
        large.append(tri)
        large_comp.append(np.full(len(tri), ci, dtype=np.int64))
    if large:
        # Only components in a group small enough that the drop rule could ever
        # apply pay for the exact pass, matching the viewer: a group already
        # past the triangle cap only grows when the pass merges more into it.
        prunable = {
            root for root, surviving in group_surviving.items()
            if surviving > 0 and group_tris.get(root, 0) <= CULL_MICRO_TRI_CAP
        }
        large_tri = np.concatenate(large)
        large_owner = np.concatenate(large_comp)
        large_lo = large_tri.min(axis=1)
        large_hi = large_tri.max(axis=1)
        for ci, comp in enumerate(comps):
            if comp_dsu.find(ci) == body_root or comp["ntri"] > CULL_MICRO_TRI_CAP:
                continue
            if comp_dsu.find(ci) not in prunable:
                continue
            _, verts, _ = data[comp["part"]]
            for p in verts[comp["verts"]]:
                gap = np.maximum(np.maximum(large_lo - p, p - large_hi), 0.0)
                near = np.flatnonzero((gap * gap).sum(axis=1) <= eps2)
                for k in near:
                    cj = int(large_owner[k])
                    if cj == ci or comp_dsu.find(cj) == comp_dsu.find(ci):
                        continue
                    if _point_triangle_distance2(p[None, :], large_tri[k])[0] <= eps2:
                        comp_dsu.union(ci, cj)
                        break

    # ── Groups: the body is the group that spans the model; small detached
    #    groups go. A handful of triangles is a fragment however far it
    #    stretches, larger ones only while their bounding box stays tiny.
    groups: dict[int, dict] = {}
    for ci, comp in enumerate(comps):
        root = comp_dsu.find(ci)
        g = groups.setdefault(root, {"tris": 0, "surviving": 0,
                                     "min": comp["min"].copy(), "max": comp["max"].copy(),
                                     "members": []})
        g["tris"] += comp["ntri"]
        g["surviving"] += int((~drop[comp["part"]][comp["faces"]]).sum())
        g["min"] = np.minimum(g["min"], comp["min"])
        g["max"] = np.maximum(g["max"], comp["max"])
        g["members"].append(ci)

    def span(g):
        return float((g["max"] - g["min"]).max())

    body = None
    for g in groups.values():
        if g["surviving"] == 0:
            continue
        if body is None or span(g) > span(body) or (span(g) == span(body) and g["surviving"] > body["surviving"]):
            body = g
    for g in groups.values():
        if g is body or g["surviving"] == 0 or g["tris"] > CULL_MICRO_TRI_CAP:
            continue
        longest = span(g)
        # A structure spanning a quarter of the model is never debris (and the
        # guard keeps a pathological body pick from deleting the hull itself).
        if longest > CULL_MICRO_SPAN_CEILING_PCT * extent:
            continue
        micro = g["tris"] <= CULL_MICRO_MAX_TRIS or (
            longest <= CULL_MICRO_MAX_EXTENT_PCT * extent and g["tris"] <= CULL_MICRO_TRI_CAP
        )
        if not micro:
            continue
        stats["fragments"] += 1
        for ci in g["members"]:
            comp = comps[ci]
            fresh = ~drop[comp["part"]][comp["faces"]]
            stats["fragment_tris"] += int(fresh.sum())
            drop[comp["part"]][comp["faces"]] = True

    if stats["needle_tris"] == 0 and stats["fragment_tris"] == 0:
        return parts, stats

    # ── Rebuild the parts without the dropped triangles (orphan vertices fall
    #    away), keeping the flat float/int lists the writer expects.
    out: list[tuple[str, list[float], list[int]]] = []
    for pi, ((name, _welded, _canon_faces), (_n, flat, idx)) in enumerate(zip(data, parts)):
        original_v = np.asarray(flat, dtype=np.float64).reshape(-1, 3)
        original_f = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
        keep = ~drop[pi]
        if keep.all():
            out.append((name, flat, idx))
            continue
        kept_faces = original_f[keep]
        used = np.zeros(len(original_v), dtype=bool)
        used[kept_faces.reshape(-1)] = True
        remap = np.full(len(original_v), -1, dtype=np.int64)
        remap[used] = np.arange(int(used.sum()))
        verts_out = original_v[used].reshape(-1).tolist()
        idx_out = remap[kept_faces].reshape(-1).tolist()
        if not idx_out:
            continue  # nothing left of this part — the writer needs vertices
        out.append((name, verts_out, idx_out))
    return out, stats


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
    def pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
        """Align to 4 bytes. Binary chunks pad with zeros; the JSON chunk
        MUST pad with SPACES (glTF 2.0 GLB container rule): NUL padding is what made
        the shipped pack need `repair_glbs.py` and the loader's
        `fixGlbPadding` workaround."""
        pad = (4 - len(data) % 4) % 4
        return data + fill * pad

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
        # min/max keep GLTFLoader quiet and let Box3 work without a
        # geometry-wide compute pass.
        vs = vertices
        accessors.append({
            "bufferView": pos_bv, "componentType": 5126, "count": n_verts, "type": "VEC3",
            "min": [min(vs[i::3]) for i in range(3)],
            "max": [max(vs[i::3]) for i in range(3)],
        })
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

    json_bytes = pad4(json.dumps(gjson, separators=(",", ":")).encode("utf-8"), b" ")
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
    def pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
        """Align to 4 bytes. Binary chunks pad with zeros; the JSON chunk
        MUST pad with SPACES (glTF 2.0 GLB container rule): NUL padding is what made
        the shipped pack need `repair_glbs.py` and the loader's
        `fixGlbPadding` workaround."""
        pad = (4 - len(data) % 4) % 4
        return data + fill * pad

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

    json_bytes = pad4(json.dumps(gjson, separators=(",", ":")).encode("utf-8"), b" ")
    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_data)

    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total_len))
        f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(bin_data), 0x004E4942))
        f.write(bin_data)

def _pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
    """Align to 4 bytes. Binary chunks pad with zeros; the JSON chunk MUST
    pad with SPACES (glTF 2.0 GLB container rule) — NUL padding is rejected
    by strict JSON parsers."""
    pad = (4 - len(data) % 4) % 4
    return data + fill * pad


def write_glb_dual(path: Path,
                   hull_v: list[float], hull_i: list[int],
                   turret_v: list[float], turret_i: list[int]):
    """Write GLB with mesh[0]=hull, mesh[1]=turrets."""
    def _itype(indices): return 5125 if (max(indices) if indices else 0) > 65535 else 5123
    def _pack(v, i):
        nv = len(v)//3; ni = len(i)
        it = _itype(i)
        vb = _pad4(struct.pack(f"<{len(v)}f", *v)) if nv else b""
        ib = _pad4(struct.pack(f"<{ni}{'I' if it==5125 else 'H'}", *i)) if ni else b""
        return nv, ni, it, vb, ib
    nvh,nih,ith,vbh,ibh = _pack(hull_v, hull_i)
    nvt,nit,itt,vbt,ibt = _pack(turret_v, turret_i)
    bin_data = vbh + ibh + vbt + ibt
    off = 0
    hv_off, hv_len = off, len(vbh); off += hv_len
    hi_off, hi_len = off, len(ibh); off += hi_len
    tv_off, tv_len = off, len(vbt); off += tv_len
    ti_off, ti_len = off, len(ibt); off += ti_len
    gjson = {
        "asset":{"version":"2.0","generator":"WoWSP"},
        "scene":0,"scenes":[{"nodes":[0,1]}],
        "nodes":[{"mesh":0,"name":"hull"},{"mesh":1,"name":"turret"}],
        "meshes":[
            {"name":"hull","primitives":[{"attributes":{"POSITION":0},"indices":1,"mode":4,"material":0}]},
            {"name":"turret","primitives":[{"attributes":{"POSITION":2},"indices":3,"mode":4,"material":0}]},
        ],
        "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0,0.67,0.85,1],"metallicFactor":0.1,"roughnessFactor":0.7},"alphaMode":"BLEND","emissiveFactor":[0,0.3,0.4]}],
        "buffers":[{"byteLength":len(bin_data)}],
        "bufferViews":[
            {"buffer":0,"byteOffset":hv_off,"byteLength":hv_len,"target":34962},
            {"buffer":0,"byteOffset":hi_off,"byteLength":hi_len,"target":34963},
            {"buffer":0,"byteOffset":tv_off,"byteLength":tv_len,"target":34962},
            {"buffer":0,"byteOffset":ti_off,"byteLength":ti_len,"target":34963},
        ],
        "accessors":[
            {"bufferView":0,"componentType":5126,"count":nvh,"type":"VEC3"},
            {"bufferView":1,"componentType":ith,"count":nih,"type":"SCALAR"},
            {"bufferView":2,"componentType":5126,"count":nvt,"type":"VEC3"},
            {"bufferView":3,"componentType":itt,"count":nit,"type":"SCALAR"},
        ],
    }
    json_bytes = _pad4(json.dumps(gjson, separators=(",",":")).encode("utf-8"), b" ")
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
    parser.add_argument("--dedup-lods", action="store_true",
                        help="collapse equal-bbox LOD primitives to their densest member "
                             "(plane exports carry every section at 3 detail levels)")
    args = parser.parse_args()

    inp = Path(args.input)
    out = Path(args.output)

    print(f"[bake] loading {inp.name} ...")
    gltf = parse_glb(inp)
    buckets = extract_by_instance(gltf, dedup_lods=args.dedup_lods)

    # Decimate each category: proportional budget with 200-tri floor.
    total_raw = sum(len(idx) // 3 for insts in buckets.values() for _, idx in insts.values())
    budget = max(args.triangles, 6000)
    parts: list[tuple[str, list[float], list[int]]] = []

    if total_raw > 0:
        # Weapon categories get colour labels so the frontend can distinguish them.
        # Hull categories get their own labels for armour-belt separation.
        WEAPON_CATS = {"main_battery", "secondary_battery", "aa_mount", "torpedo",
                       "aircraft", "funnel", "turret_part", "weapon"}
        for cat, insts in buckets.items():
            raw_tris_cat = sum(len(idx) // 3 for _, idx in insts.values())
            if raw_tris_cat == 0:
                continue
            ratio = raw_tris_cat / total_raw
            tgt = max(int(budget * ratio), 200)
            # Give weapons a slightly higher budget share so they're never
            # erased by aggressive decimation of the much-larger hull groups.
            if cat in WEAPON_CATS and ratio > 0:
                tgt = max(tgt, int(budget * 0.04))
            for inst, (v, idx) in insts.items():
                if not v or not idx:
                    continue
                inst_tgt = tgt
                if cat == "propeller":
                    # Each screw keeps a readability floor — at the raw-triangle
                    # share a prop gets ~100 tris, which reads as a lump.
                    inst_tgt = max(tgt, min(len(idx) // 3, 400))
                dv, di = decimate(v, idx, inst_tgt)
                if len(di) > 0:
                    # instance-suffixed name: category_<instance>. The frontend
                    # colours by category prefix, addresses mounts individually.
                    name = f"{cat}_{inst}" if inst != "0" else cat
                    parts.append((name, dv, di))
                else:
                    print(f"  [{cat}/{inst}] decimated to 0 triangles — dropped")

    parts, culled = cull_floating_artifacts(parts)
    if culled["needles"] or culled["fragments"]:
        print(f"[bake] culled floating artifacts: {culled['needles']} needle components "
              f"({culled['needle_tris']} tris) + {culled['fragments']} detached fragments "
              f"({culled['fragment_tris']} tris)")

    print(f"[bake] writing {len(parts)} groups to {out.name} ...")
    write_glb_multimesh(out, parts)
    print(f"[bake] wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
