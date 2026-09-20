#!/usr/bin/env python3
"""Bake terrain height + line-of-sight (LOS) rasters from a distributed map GLB.

Feasibility experiment E4 (decision-AI): proves that the map GLBs already
distributed by the WoWSP model pack are enough to bake (a) a max-height
terrain raster and (b) per-observer LOS visibility rasters — the data source
for future "terrain-aware vision" features of the decision model. No game
install required: the GLB is parsed directly (JSON chunk + BIN chunk, glTF
accessors decoded with numpy), following the parsing conventions already used
by scripts/model_convert/bake_model.py.

World coordinates follow the WoWS convention: x = east, z = north, y = up
(y > 0 is island height, y ~= 0 sea level). The raster extent is taken from
packages/webui/src/res/models/maps/minimaps.json (keyed by map id = GLB file
stem) so rasters align to world coordinates; if the id is absent the vertex
bbox is used as a fallback.

Known approximations (documented on purpose, this is a feasibility probe):
  1. Max-height binning: vertices are binned into res x res cells by (x, z)
     and each cell takes the MAX y of the vertices falling inside it. No
     triangle rasterization is done. For the distributed map GLBs this is
     close to exact because they contain a single "Terrain" mesh exported by
     `wowsunpack export-map` from terrain.bin as a regular ~9 m heightfield
     grid (201 x 201 vertices over +-900 m), not the full models.geometry
     render mesh.
  2. Empty-cell fill: where the source vertex spacing is coarser than the
     raster cell size some cells receive no vertex; they are backfilled by
     iterative neighbourhood MAX dilation (never below sea level). This is
     slightly conservative for LOS (over-estimates terrain, under-estimates
     visibility) and avoids sampling stripes.
  3. Underwater terrain is clamped to y = 0 (sea level) — surface units are
     what the decision model cares about. The raw min y is reported in the
     summary.
  4. LOS ray marching samples the terrain at every grid cell a ray crosses
     (Amanatides-Woo DDA). A cell blocks when its (max) height exceeds the
     ray height anywhere inside that cell (conservative: the lower segment
     endpoint is tested). Earth curvature is ignored (maps are ~1.3 km).

Usage:
    python scripts/experiments/bake_terrain_los.py --selftest
    python scripts/experiments/bake_terrain_los.py \
        --glb "$LOCALAPPDATA/WoWSP/models/maps/50_Gold_harbor.glb" \
        --res 256 --eye-height 20 --obs-grid 8 \
        --out scripts/experiments/out/

Outputs (under --out/<map_id>/):
    heightmap.png     shaded-relief height raster (stdlib PNG writer)
    los_r<r>_c<c>.png visibility mask per observer (green=visible)
    los_montage.png   all observers on one sheet (only if matplotlib exists)
    terrain_los.npz   height, land mask, all LOS masks, observer cells
    summary.json      stats (land fraction, per-observer visible fraction,
                      timings, approximation notes)

Selftest (--selftest) runs the whole pipeline on a synthetic Gaussian-hill
heightmap (plus a tiny synthetic GLB round-trip) and asserts the LOS math:
hilltop sees around, a low observer is shadowed behind the hill, LOS is
symmetric under endpoint swap, flat maps are fully visible. It needs only
stdlib + numpy so it passes on CI machines without any GLB.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
import zlib
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BOUNDS_JSON = (
    REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "maps" / "minimaps.json"
)
DEFAULT_OUT = Path(__file__).resolve().parent / "out"

_EPS = 1e-6  # grazing tolerance for LOS blocking tests

# glTF componentType -> (numpy dtype, byte size)
_COMPONENT_DTYPES = {
    5120: np.dtype("<i1"),
    5121: np.dtype("<u1"),
    5122: np.dtype("<i2"),
    5123: np.dtype("<u2"),
    5125: np.dtype("<u4"),
    5126: np.dtype("<f4"),
}
_TYPE_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


# ---------------------------------------------------------------------------
# GLB parsing (container + accessors + node transforms)
# Conventions follow scripts/model_convert/bake_model.py::parse_glb, with the
# accessor decode vectorized through numpy instead of a per-value struct loop.
# ---------------------------------------------------------------------------

def parse_glb(path: Path) -> dict:
    """Parse a GLB file into {"json": gltf_dict, "binary": bytes}."""
    data = path.read_bytes()
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
    if json_data is None:
        raise ValueError(f"{path}: GLB has no JSON chunk")
    return {"json": json_data, "binary": bin_data or b""}


def read_accessor(gjson: dict, buffers: list[bytearray], acc_idx: int) -> np.ndarray:
    """Decode one glTF accessor into a (count, ncomp) numpy array."""
    acc = gjson["accessors"][acc_idx]
    assert "sparse" not in acc, "sparse accessors are not supported"
    bv = gjson["bufferViews"][acc["bufferView"]]
    buf = buffers[bv["buffer"]]
    dtype = _COMPONENT_DTYPES[acc["componentType"]]
    ncomp = _TYPE_NCOMP[acc["type"]]
    count = acc["count"]
    item_bytes = dtype.itemsize * ncomp
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride")
    if stride is None or stride == item_bytes:
        arr = np.frombuffer(buf, dtype=dtype, count=count * ncomp, offset=start)
    else:  # interleaved buffer view
        raw = (
            np.frombuffer(buf, dtype=np.uint8, count=count * stride, offset=start)
            .reshape(count, stride)[:, :item_bytes]
            .copy()
        )
        arr = raw.view(dtype).reshape(-1)
    return arr.reshape(count, ncomp)


def _node_matrix(node: dict) -> np.ndarray:
    """Local transform of a glTF node (matrix or TRS) as a 4x4."""
    if "matrix" in node:
        return np.asarray(node["matrix"], dtype=np.float64).reshape(4, 4, order="F")
    m = np.eye(4, dtype=np.float64)
    if "translation" in node:
        m[:3, 3] = node["translation"]
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        m[:3, :3] = np.array(
            [
                [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
                [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
                [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
            ],
            dtype=np.float64,
        )
    if "scale" in node:
        m[:3, :3] *= np.asarray(node["scale"], dtype=np.float64)
    return m


def node_world_matrices(gjson: dict) -> list[np.ndarray | None]:
    """World transform of every node (None if not reachable from a root)."""
    nodes = gjson.get("nodes", [])
    children: dict[int, list[int]] = {i: [] for i in range(len(nodes))}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            if c < len(nodes):
                children[i].append(c)
    has_parent = {c for kids in children.values() for c in kids}
    roots = [i for i in range(len(nodes)) if i not in has_parent]
    world = [None] * len(nodes)

    def compute(idx: int, parent: np.ndarray) -> None:
        w = parent @ _node_matrix(nodes[idx])
        world[idx] = w
        for c in children.get(idx, []):
            compute(c, w)

    for r in roots:
        compute(r, np.eye(4))
    return world


def extract_vertices(gltf: dict) -> tuple[np.ndarray, list[dict]]:
    """Collect world-space POSITION vertices from every mesh primitive.

    Triangle indices are intentionally ignored: max-height binning only needs
    where geometry exists vertically, not how vertices are connected.

    Returns (vertices (n,3) float64, per-mesh info dicts).
    """
    gjson = gltf["json"]
    buffers: list[bytearray] = []
    for buf in gjson.get("buffers", []):
        if buf.get("uri", "").startswith("data:"):
            import base64

            buffers.append(bytearray(base64.b64decode(buf["uri"].split(",", 1)[1])))
        else:
            buffers.append(bytearray(gltf["binary"][: buf["byteLength"]]))

    world = node_world_matrices(gjson)
    chunks: list[np.ndarray] = []
    mesh_infos: list[dict] = []
    for mi, mesh in enumerate(gjson.get("meshes", [])):
        owners = [ni for ni, n in enumerate(gjson.get("nodes", [])) if n.get("mesh") == mi]
        mats = [world[ni] for ni in owners if world[ni] is not None] or [np.eye(4)]
        got_verts = 0
        for mat in mats:
            for prim in mesh.get("primitives", []):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None:
                    continue
                v = read_accessor(gjson, buffers, pos).astype(np.float64)
                if v.shape[1] != 3:
                    continue
                if not np.allclose(mat, np.eye(4)):
                    vh = np.column_stack([v, np.ones(len(v))])
                    v = (mat @ vh.T).T[:, :3]
                chunks.append(v)
                got_verts += len(v)
        if got_verts:
            mesh_infos.append(
                {"mesh_index": mi, "name": mesh.get("name", ""), "vertices": got_verts}
            )
    if not chunks:
        raise ValueError("GLB contains no POSITION geometry")
    return np.concatenate(chunks, axis=0), mesh_infos


# ---------------------------------------------------------------------------
# Rasterisation
# ---------------------------------------------------------------------------

def load_map_bounds(map_id: str, bounds_json: Path | None) -> dict | None:
    """Look up world bounds {minX,maxX,minZ,maxZ} for a map id."""
    path = bounds_json or DEFAULT_BOUNDS_JSON
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    entry = data.get(map_id) if isinstance(data, dict) else None
    if not isinstance(entry, dict):
        return None
    if not all(k in entry for k in ("minX", "maxX", "minZ", "maxZ")):
        return None
    return {k: float(entry[k]) for k in ("minX", "maxX", "minZ", "maxZ")}


def rasterize_max_height(
    verts: np.ndarray, bounds: dict, res: int
) -> tuple[np.ndarray, dict]:
    """Bin world vertices into a res x res max-height raster.

    height[r, c]: r indexes z from minZ (south) to maxZ (north), c indexes x
    from minX (west) to maxX (east). Cells without vertices start as NaN and
    are filled by iterative neighbourhood-max dilation (approximation 2);
    heights are then clamped to >= 0 (approximation 3).
    """
    min_x, max_x = bounds["minX"], bounds["maxX"]
    min_z, max_z = bounds["minZ"], bounds["maxZ"]
    span_x = max_x - min_x
    span_z = max_z - min_z

    inside = (
        (verts[:, 0] >= min_x) & (verts[:, 0] < max_x)
        & (verts[:, 2] >= min_z) & (verts[:, 2] < max_z)
    )
    v = verts[inside]

    cols = np.clip(((v[:, 0] - min_x) / span_x * res).astype(np.int64), 0, res - 1)
    rows = np.clip(((v[:, 2] - min_z) / span_z * res).astype(np.int64), 0, res - 1)

    h = np.full((res, res), -np.inf)
    np.maximum.at(h, (rows, cols), v[:, 1])

    empty = np.isinf(h)
    empty_fraction = float(empty.mean())
    raw_min = float(v[:, 1].min()) if len(v) else 0.0

    # Neighbourhood-max dilation until no empty cells remain (bounded by res).
    fill_iterations = 0
    while empty.any() and fill_iterations < res:
        padded = np.pad(h, 1, constant_values=-np.inf)
        neigh_max = np.maximum.reduce(
            [padded[0:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, 0:-2], padded[1:-1, 2:]]
        )
        fill_now = empty & np.isfinite(neigh_max)
        h[fill_now] = neigh_max[fill_now]
        empty = np.isinf(h)
        fill_iterations += 1
    if empty.any():  # raster larger than the data region
        h[empty] = 0.0

    h = np.maximum(h, 0.0)
    meta = {
        "vertices_binned": int(len(v)),
        "vertices_total": int(len(verts)),
        "empty_cell_fraction_before_fill": empty_fraction,
        "fill_iterations": fill_iterations,
        "raw_min_y": raw_min,
        "cell_size_m": [round(span_x / res, 3), round(span_z / res, 3)],
    }
    return h.astype(np.float64), meta


# ---------------------------------------------------------------------------
# LOS: vectorised Amanatides-Woo DDA over all target cells at once
# ---------------------------------------------------------------------------

def rays_blocked(
    h: np.ndarray,
    obs_r: int,
    obs_c: int,
    eye_y: float,
    tgt_r: np.ndarray,
    tgt_c: np.ndarray,
    tgt_y: np.ndarray,
) -> np.ndarray:
    """March rays from one observer to many targets; True where terrain blocks.

    The ray starts at world height eye_y over cell (obs_r, obs_c) and ends at
    height tgt_y[i] over cell (tgt_r[i], tgt_c[i]). Rays are parametrised by
    t in [0, 1] in grid-cell space; because world x/z map affinely onto cell
    columns/rows, t also parametrises the world straight line, so the eye->
    target height lerp is exact. Each grid cell a ray crosses is tested with
    its (max) raster height against the ray height at the LOWER endpoint of
    the in-cell segment (conservative: a cell blocks if the ray dips to or
    below its plateau anywhere inside the cell). The target cell itself is
    never tested as a blocker.
    """
    n = len(tgt_r)
    n_rows, n_cols = h.shape
    blocked = np.zeros(n, dtype=bool)

    same = (tgt_r == obs_r) & (tgt_c == obs_c)
    dr = tgt_r.astype(np.float64) - obs_r
    dc = tgt_c.astype(np.float64) - obs_c

    oi = np.nonzero(~same)[0]  # original indices of rays needing marching
    if len(oi) == 0:
        return blocked

    # Active-ray state (compacted every iteration as rays finish).
    tr = tgt_r[oi].astype(np.int64)
    tc = tgt_c[oi].astype(np.int64)
    ty = tgt_y[oi].astype(np.float64)
    cr = np.full(len(oi), obs_r, dtype=np.int64)
    cc = np.full(len(oi), obs_c, dtype=np.int64)
    step_r = np.sign(dr[oi]).astype(np.int64)
    step_c = np.sign(dc[oi]).astype(np.int64)
    a_r = np.abs(dr[oi])
    a_c = np.abs(dc[oi])
    inf = np.inf
    with np.errstate(divide="ignore"):
        t_max_r = np.where(a_r > 0, 0.5 / a_r, inf)
        t_max_c = np.where(a_c > 0, 0.5 / a_c, inf)
        dt_r = np.where(a_r > 0, 1.0 / a_r, inf)
        dt_c = np.where(a_c > 0, 1.0 / a_c, inf)
    t = np.zeros(len(oi))

    max_iters = 3 * (n_rows + n_cols) + 8
    for _ in range(max_iters):
        # Rays whose current cell is the target cell have arrived: their last
        # in-cell segment is never tested (target is not its own blocker).
        arrived = (cr == tr) & (cc == tc)
        if arrived.any():
            keep = ~arrived
            oi, tr, tc, ty = oi[keep], tr[keep], tc[keep], ty[keep]
            cr, cc = cr[keep], cc[keep]
            step_r, step_c = step_r[keep], step_c[keep]
            t_max_r, t_max_c = t_max_r[keep], t_max_c[keep]
            dt_r, dt_c = dt_r[keep], dt_c[keep]
            t = t[keep]
            if len(oi) == 0:
                break

        t_end = np.minimum(np.minimum(t_max_r, t_max_c), 1.0)
        y0 = eye_y + (ty - eye_y) * t
        y1 = eye_y + (ty - eye_y) * t_end
        # The observer's own cell (t == 0, first segment) is never tested,
        # mirroring the target cell: endpoint cells are excluded so that LOS
        # is symmetric under swapping the endpoints.
        testable = t > 0.0
        hit = testable & (h[cr, cc] > np.minimum(y0, y1) + _EPS)
        if hit.any():
            blocked[oi[hit]] = True
            keep = ~hit
            oi, tr, tc, ty = oi[keep], tr[keep], tc[keep], ty[keep]
            cr, cc = cr[keep], cc[keep]
            step_r, step_c = step_r[keep], step_c[keep]
            t_max_r, t_max_c = t_max_r[keep], t_max_c[keep]
            dt_r, dt_c = dt_r[keep], dt_c[keep]
            t, t_end = t[keep], t_end[keep]
            if len(oi) == 0:
                break

        # Advance every remaining ray across its next cell boundary. Exact,
        # near-exact or floating-point ties (corner crossings) advance BOTH
        # axes at once so the traversed cell set is identical in either
        # direction — required for LOS symmetry under endpoint swap. A corner
        # graze is a measure-zero contact and must not block either way.
        tie = np.abs(t_max_c - t_max_r) < 1e-9
        cross_c = (t_max_c < t_max_r) | tie  # ties advance BOTH axes
        cross_r = (t_max_r < t_max_c) | tie
        t = t_end
        t_max_c = np.where(cross_c, t_max_c + dt_c, t_max_c)
        t_max_r = np.where(cross_r, t_max_r + dt_r, t_max_r)
        cc = cc + np.where(cross_c, step_c, 0)
        cr = cr + np.where(cross_r, step_r, 0)

    return blocked


def visibility_mask(
    h: np.ndarray, obs_r: int, obs_c: int, eye_offset: float, tgt_offset: float
) -> np.ndarray:
    """Boolean visibility raster for one observer placed on the terrain."""
    n_rows, n_cols = h.shape
    rr, cc = np.meshgrid(np.arange(n_rows), np.arange(n_cols), indexing="ij")
    eye_y = float(h[obs_r, obs_c]) + eye_offset
    blocked = rays_blocked(
        h,
        obs_r,
        obs_c,
        eye_y,
        rr.reshape(-1),
        cc.reshape(-1),
        (h + tgt_offset).reshape(-1),
    )
    visible = ~blocked.reshape(n_rows, n_cols)
    visible[obs_r, obs_c] = True
    return visible


def observer_cells(res: int, obs_grid: int) -> list[tuple[int, int]]:
    """Evenly spaced (row, col) observer cells over the raster."""
    cells = []
    for r in range(obs_grid):
        for c in range(obs_grid):
            ri = min(res - 1, int((r + 0.5) * res / obs_grid))
            ci = min(res - 1, int((c + 0.5) * res / obs_grid))
            cells.append((ri, ci))
    return cells


# ---------------------------------------------------------------------------
# PNG output: stdlib writer (works with numpy only) + numpy colour maps
# ---------------------------------------------------------------------------

def write_png(path: Path, rgb: np.ndarray) -> None:
    """Write an (H, W, 3) uint8 array as an 8-bit RGB PNG (stdlib only)."""
    h_px, w_px, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[i].tobytes() for i in range(h_px))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", w_px, h_px, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def _hillshade(h: np.ndarray, cell_m: float) -> np.ndarray:
    """Simple Lambert shading from the north-west, in [0.35, 1.0]."""
    gy, gx = np.gradient(h, cell_m)
    slope = np.sqrt(gx * gx + gy * gy)
    shade = (-(gx + gy) / (slope + 1e-9) * 0.65 + 0.5) / (1.0 + slope * 0.08)
    return np.clip(shade, 0.35, 1.0)


def heightmap_rgb(h: np.ndarray, cell_m: float) -> np.ndarray:
    """Sea = navy, land = green->brown->white ramp, multiplied by hillshade."""
    top = max(float(h.max()), 1.0)
    frac = np.clip(h / top, 0.0, 1.0)
    rgb = np.empty(h.shape + (3,), dtype=np.uint8)
    land = h > _EPS
    # sea: flat navy so the island silhouette pops for eyeball comparison
    rgb[..., 0] = 16
    rgb[..., 1] = 38
    rgb[..., 2] = 74
    # land ramp: (46,110,52) -> (150,132,84) -> (236,236,236)
    a = np.clip(frac / 0.5, 0, 1)
    b = np.clip((frac - 0.5) / 0.5, 0, 1)
    lr = (1 - a) * 46 + a * 150
    lg = (1 - a) * 110 + a * 132
    lb = (1 - a) * 52 + a * 84
    lr = (1 - b) * lr + b * 236
    lg = (1 - b) * lg + b * 236
    lb = (1 - b) * lb + b * 236
    sh = _hillshade(h, cell_m)
    rgb[..., 0] = np.where(land, lr * sh, rgb[..., 0])
    rgb[..., 1] = np.where(land, lg * sh, rgb[..., 1])
    rgb[..., 2] = np.where(land, lb * sh, rgb[..., 2])
    return rgb


def los_mask_rgb(visible: np.ndarray, obs_r: int, obs_c: int) -> np.ndarray:
    """Green = visible, dark magenta = blocked, red dot = observer cell."""
    rgb = np.empty(visible.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = np.where(visible, 46, 74)
    rgb[..., 1] = np.where(visible, 160, 30)
    rgb[..., 2] = np.where(visible, 60, 74)
    lo = max(obs_r - 2, 0)
    hi = min(obs_r + 3, visible.shape[0])
    co = max(obs_c - 2, 0)
    co2 = min(obs_c + 3, visible.shape[1])
    rgb[lo:hi, co:co2] = (255, 60, 60)
    return rgb


def write_montage(path: Path, masks: np.ndarray, cells: list[tuple[int, int]]) -> bool:
    """Optionally render all masks on one sheet. Needs matplotlib; returns ok."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return False
    n = len(cells)
    side = int(math.ceil(math.sqrt(n)))
    fig, axes = plt.subplots(side, side, figsize=(side * 2, side * 2))
    for ax in np.atleast_1d(axes).reshape(-1):
        ax.axis("off")
    for k, (r, c) in enumerate(cells):
        ax = np.atleast_1d(axes).reshape(-1)[k]
        ax.imshow(masks[k], cmap="viridis", origin="upper")
        ax.set_title(f"r{r} c{c}", fontsize=6)
    fig.tight_layout()
    fig.savefig(path, dpi=90)
    plt.close(fig)
    return True


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def run_bake(
    glb_path: Path,
    res: int,
    out_dir: Path,
    eye_height: float,
    obs_grid: int,
    tgt_height: float,
    bounds_json: Path | None,
) -> dict:
    t0 = time.perf_counter()

    gltf = parse_glb(glb_path)
    verts, mesh_infos = extract_vertices(gltf)
    t_parse = time.perf_counter()

    map_id = glb_path.stem
    bounds = load_map_bounds(map_id, bounds_json)
    bounds_source = "minimaps.json"
    if bounds is None:
        bounds = {
            "minX": float(verts[:, 0].min()),
            "maxX": float(verts[:, 0].max()),
            "minZ": float(verts[:, 2].min()),
            "maxZ": float(verts[:, 2].max()),
        }
        bounds_source = "vertex_bbox"
    h, raster_meta = rasterize_max_height(verts, bounds, res)
    t_raster = time.perf_counter()

    cells = observer_cells(res, obs_grid)
    masks = np.zeros((len(cells), res, res), dtype=bool)
    for k, (r, c) in enumerate(cells):
        masks[k] = visibility_mask(h, r, c, eye_height, tgt_height)
    t_los = time.perf_counter()

    out_dir.mkdir(parents=True, exist_ok=True)
    land = h > _EPS
    land_fraction = float(land.mean())
    max_height = float(h.max())

    write_png(out_dir / "heightmap.png", heightmap_rgb(np.flipud(h), raster_meta["cell_size_m"][0]))
    obs_entries = []
    for k, (r, c) in enumerate(cells):
        write_png(out_dir / f"los_r{r}_c{c}.png", los_mask_rgb(np.flipud(masks[k]), r, c))
        obs_entries.append(
            {
                "index": k,
                "row": r,
                "col": c,
                "x": round(bounds["minX"] + (c + 0.5) * (bounds["maxX"] - bounds["minX"]) / res, 2),
                "z": round(bounds["minZ"] + (r + 0.5) * (bounds["maxZ"] - bounds["minZ"]) / res, 2),
                "ground_y": round(float(h[r, c]), 3),
                "visible_fraction": round(float(masks[k].mean()), 4),
            }
        )
    montage_ok = write_montage(out_dir / "los_montage.png", np.flipud(masks), cells)
    t_png = time.perf_counter()

    np.savez_compressed(
        out_dir / "terrain_los.npz",
        height=h.astype(np.float32),
        land_mask=land,
        los_masks=masks,
        obs_cells=np.asarray(cells, dtype=np.int32),
        bounds=np.asarray(
            [bounds["minX"], bounds["maxX"], bounds["minZ"], bounds["maxZ"]],
            dtype=np.float64,
        ),
        params=np.asarray([res, obs_grid], dtype=np.int32),
        eye_tgt_heights=np.asarray([eye_height, tgt_height], dtype=np.float64),
    )

    summary = {
        "map_id": map_id,
        "glb": str(glb_path),
        "bounds": bounds,
        "bounds_source": bounds_source,
        "res": res,
        "meshes": mesh_infos,
        "vertices_total": raster_meta["vertices_total"],
        "vertices_binned": raster_meta["vertices_binned"],
        "empty_cell_fraction_before_fill": raster_meta["empty_cell_fraction_before_fill"],
        "fill_iterations": raster_meta["fill_iterations"],
        "raw_min_y": raster_meta["raw_min_y"],
        "cell_size_m": raster_meta["cell_size_m"],
        "land_fraction": round(land_fraction, 4),
        "max_height_m": round(max_height, 3),
        "eye_height_m": eye_height,
        "tgt_height_m": tgt_height,
        "obs_grid": obs_grid,
        "observer_count": len(cells),
        "observers": obs_entries,
        "mean_visible_fraction": round(float(masks.mean(axis=(1, 2)).mean()), 4),
        "montage_written": montage_ok,
        "timing_s": {
            "glb_parse": round(t_parse - t0, 3),
            "rasterize": round(t_raster - t_parse, 3),
            "los": round(t_los - t_raster, 3),
            "png": round(t_png - t_los, 3),
            "total": round(t_png - t0, 3),
        },
        "raster_orientation": "row 0 = minZ (south), col 0 = minX (west); PNGs flipped so north is up",
        "approximations": [
            "max-height vertex binning, no triangle rasterization",
            "empty cells backfilled by neighbourhood-max dilation (conservative for LOS)",
            "underwater terrain clamped to sea level y=0",
            "cell-crossing DDA samples raster cells, not continuous terrain; earth curvature ignored",
        ],
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary


# ---------------------------------------------------------------------------
# Selftest
# ---------------------------------------------------------------------------

def _write_minimal_glb(path: Path, verts: np.ndarray) -> None:
    """Write a tiny GLB (float32 POSITION + uint32 indices) for round-trip tests."""

    def pad4(b: bytes) -> bytes:
        return b + b"\x00" * ((4 - len(b) % 4) % 4)

    v_bytes = pad4(verts.astype("<f4").tobytes())
    idx = np.arange(len(verts), dtype="<u4")
    i_bytes = pad4(idx.tobytes())
    bin_data = v_bytes + i_bytes
    gjson = {
        "asset": {"version": "2.0", "generator": "bake_terrain_los selftest"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "Terrain"}],
        "meshes": [{"name": "Terrain", "primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
        "buffers": [{"byteLength": len(bin_data)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(v_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": len(v_bytes), "byteLength": len(i_bytes), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(verts), "type": "VEC3"},
            {"bufferView": 1, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ],
    }
    json_bytes = pad4(json.dumps(gjson).encode("utf-8"))
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(bin_data)))
        f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(bin_data), 0x004E4942))
        f.write(bin_data)


def run_selftest(out_dir: Path) -> int:
    print("[selftest] E4 bake_terrain_los — synthetic Gaussian terrain")
    res = 96
    extent = 1200.0  # metres, centred on 0
    xs = (np.arange(res) + 0.5) / res * extent - extent / 2
    xg, zg = np.meshgrid(xs, xs)  # zg rows, xg cols

    # One dominant hill (centre-west, 40 m, sigma 90 -> foothills ~245 m) +
    # one small hill (SE, 12 m). The dominant hill's footprint leaves open
    # water within a few hundred metres of the peak, which the dome-horizon
    # checks below rely on.
    big = 40.0 * np.exp(-((xg + 150.0) ** 2 + (zg - 100.0) ** 2) / (2 * 90.0**2))
    small = 12.0 * np.exp(-((xg - 380.0) ** 2 + (zg + 320.0) ** 2) / (2 * 70.0**2))
    h = big + small
    cell = extent / res

    # --- check 1: rasterizer round-trip on a perfect grid ------------------
    verts = np.column_stack([xg.reshape(-1), h.reshape(-1), zg.reshape(-1)])
    bounds = {"minX": -extent / 2, "maxX": extent / 2, "minZ": -extent / 2, "maxZ": extent / 2}
    h2, meta = rasterize_max_height(verts, bounds, res)
    assert np.allclose(h2, h, atol=1e-6), "rasterizer round-trip failed"
    assert meta["empty_cell_fraction_before_fill"] == 0.0, "perfect grid should leave no empty cells"
    print(f"[selftest] rasterizer round-trip: max diff {np.abs(h2 - h).max():.2e}  OK")

    # --- check 1b: GLB parse round-trip on a synthetic GLB -----------------
    glb_tmp = out_dir / "synthetic_terrain.glb"
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_minimal_glb(glb_tmp, verts)
    gltf = parse_glb(glb_tmp)
    v2, mesh_infos = extract_vertices(gltf)
    assert len(mesh_infos) == 1 and mesh_infos[0]["name"] == "Terrain"
    assert v2.shape == verts.shape and np.allclose(v2, verts, atol=1e-3), "GLB round-trip failed"
    print(f"[selftest] GLB round-trip: {len(v2)} vertices parsed back  OK")

    # --- check 2: flat map -> everything visible ---------------------------
    flat = np.zeros((res, res))
    vis = visibility_mask(flat, res // 2, res // 2, eye_offset=10.0, tgt_offset=0.0)
    assert vis.all(), "flat map should be fully visible"
    print("[selftest] flat-map visibility: 100%  OK")

    # --- check 3: hilltop observer — far field clear, elevation monotonic --
    top_r, top_c = np.unravel_index(int(h.argmax()), h.shape)
    vis_high = visibility_mask(h, top_r, top_c, eye_offset=30.0, tgt_offset=0.0)
    vis_low = visibility_mask(h, top_r, top_c, eye_offset=5.0, tgt_offset=0.0)
    dist = np.hypot(xg - xs[top_c], zg - xs[top_r])
    not_se = ~((xg > 250.0) & (zg < -100.0))  # exclude the sector with the small hill
    far = (dist > 400.0) & not_se
    assert far.any(), "far-field region is empty"
    frac_far = float(vis_high[far].mean())
    assert frac_far > 0.98, f"hilltop should see the far field, got {frac_far:.3f}"
    # Raising the eye lifts every sight line, so no cell may become blocked.
    new_blocks = (~vis_high) & vis_low
    assert not new_blocks.any(), f"raising the eye newly blocked {int(new_blocks.sum())} cells"
    assert 0.3 < vis_low.mean() < vis_high.mean(), "low eye should see strictly less"
    print(
        f"[selftest] hilltop: far field visible {frac_far:.3f}; eye 30 m sees "
        f"{vis_high.mean():.3f} > eye 5 m sees {vis_low.mean():.3f}  OK"
    )

    # --- check 4: low observer shadowed behind the dominant hill -----------
    # Observer far EAST of the big hill, same latitude: the west region lies
    # in the hill's shadow.
    obs_r = top_r
    obs_c = int(np.argmin(np.abs(xs - 520.0)))
    assert h[obs_r, obs_c] < 1.0, "observer should stand near sea level"
    vis_low_obs = visibility_mask(h, obs_r, obs_c, eye_offset=5.0, tgt_offset=0.0)
    # The latitude band directly behind the hill (west of it, same latitude)
    # must sit in the hill's shadow; the near side (east of the hill, away
    # from both hills) must be visible.
    west = (xg < -450.0) & (np.abs(zg - 100.0) < 150.0)
    near = (xg > 200.0) & (zg > -100.0) & (zg < 300.0)
    frac_west = vis_low_obs[west].mean()
    frac_near = vis_low_obs[near].mean()
    assert frac_west < 0.15, f"west region should be shadowed, got {frac_west:.3f}"
    assert frac_near > 0.85, f"near region should be visible, got {frac_near:.3f}"
    print(
        f"[selftest] shadow test: west-behind-hill visible {frac_west:.3f} < 0.15, "
        f"near-side {frac_near:.3f} > 0.85  OK"
    )

    # --- check 5: LOS symmetry under endpoint swap --------------------------
    rng = np.random.default_rng(42)
    eye_off = 5.0
    n_ok = 0
    for _ in range(200):
        r0, c0 = rng.integers(0, res, 2)
        r1, c1 = rng.integers(0, res, 2)
        if (r0, c0) == (r1, c1):
            continue
        a = rays_blocked(
            h, r0, c0, h[r0, c0] + eye_off,
            np.array([r1]), np.array([c1]), np.array([h[r1, c1] + eye_off]),
        )[0]
        b = rays_blocked(
            h, r1, c1, h[r1, c1] + eye_off,
            np.array([r0]), np.array([c0]), np.array([h[r0, c0] + eye_off]),
        )[0]
        assert a == b, f"LOS asymmetry at ({r0},{c0})->({r1},{c1}): {a} vs {b}"
        n_ok += 1
    print(f"[selftest] LOS symmetry: {n_ok} random pairs agree under swap  OK")

    # --- check 6: PNG writer byte structure ---------------------------------
    png_path = out_dir / "selftest_heightmap.png"
    write_png(png_path, heightmap_rgb(h, cell))
    raw_file = png_path.read_bytes()
    assert raw_file[:8] == b"\x89PNG\r\n\x1a\n", "PNG signature missing"
    w_png, h_png = struct.unpack(">II", raw_file[16:24])
    assert (w_png, h_png) == (res, res), "PNG dimensions wrong"
    # decompress IDAT and verify scanline length (filter byte + RGB)
    off = 8
    idat = b""
    while off < len(raw_file):
        (clen,) = struct.unpack(">I", raw_file[off : off + 4])
        tag = raw_file[off + 4 : off + 8]
        if tag == b"IDAT":
            idat += raw_file[off + 8 : off + 8 + clen]
        off += 12 + clen
    dec = zlib.decompress(idat)
    assert len(dec) == res * (1 + res * 3), "PNG pixel payload size wrong"
    print(f"[selftest] PNG writer: {res}x{res} RGB, payload {len(dec)} bytes  OK")

    # Also exercise the full-mask + PNG output paths once on the synthetic map.
    write_png(out_dir / "selftest_los_hilltop.png", los_mask_rgb(np.flipud(vis_high), top_r, top_c))
    write_png(out_dir / "selftest_los_shadow.png", los_mask_rgb(np.flipud(vis_low_obs), obs_r, obs_c))
    np.savez_compressed(
        out_dir / "selftest_terrain_los.npz",
        height=h, vis_high=vis_high, vis_hilltop_loweye=vis_low, vis_shadow=vis_low_obs,
    )
    print("[selftest] ALL CHECKS PASSED")
    return 0


# ---------------------------------------------------------------------------

def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(
        description="Bake terrain height + LOS rasters from a WoWSP map GLB"
    )
    parser.add_argument("--glb", type=Path, help="input map GLB (e.g. 50_Gold_harbor.glb)")
    parser.add_argument("--res", type=int, default=256, help="raster resolution (default 256)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    parser.add_argument("--eye-height", type=float, default=20.0,
                        help="observer eye height above ground/sea in metres (default 20)")
    parser.add_argument("--tgt-height", type=float, default=0.0,
                        help="target offset above ground/sea in metres (default 0 = waterline)")
    parser.add_argument("--obs-grid", type=int, default=8,
                        help="observer grid side (8 -> 64 observers; default 8)")
    parser.add_argument("--bounds-json", type=Path, default=None,
                        help=f"minimaps.json override (default {DEFAULT_BOUNDS_JSON})")
    parser.add_argument("--selftest", action="store_true",
                        help="run synthetic correctness checks (no GLB needed)")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest(args.out / "selftest")

    if not args.glb:
        parser.error("--glb is required unless --selftest is given")
    glb = args.glb
    if not glb.is_absolute():
        glb = (Path.cwd() / glb).resolve()
    if not glb.exists():
        print(f"error: GLB not found: {glb}", file=sys.stderr)
        return 1

    out_dir = args.out / glb.stem
    summary = run_bake(
        glb, args.res, out_dir, args.eye_height, args.obs_grid, args.tgt_height, args.bounds_json
    )

    print(f"[bake_terrain_los] map={summary['map_id']}  bounds={summary['bounds_source']}")
    print(
        f"[bake_terrain_los] res={summary['res']}  vertices={summary['vertices_binned']}  "
        f"land={summary['land_fraction']*100:.1f}%  max_height={summary['max_height_m']}m"
    )
    print(
        f"[bake_terrain_los] observers={summary['observer_count']}  "
        f"mean_visible={summary['mean_visible_fraction']*100:.1f}%  "
        f"timing={summary['timing_s']}"
    )
    print(f"[bake_terrain_los] outputs in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
