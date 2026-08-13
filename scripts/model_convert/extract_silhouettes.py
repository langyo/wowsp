#!/usr/bin/env python3
"""Extract hull side-silhouettes from the baked multi-mesh ship GLBs.

For every ship model under packages/webui/src/res/models/ships/, project the
hull/ superstructure triangles onto the side plane (z = length axis, y = up)
and bake a simplified outline into silhouettes.json:

    { "<model>": { "path": "M0 28 L...Z", "bowRight": true } }

`path` is an SVG path in a 0..100 x 0..36 viewBox (bow pointing right), used
by the shared HoloShipCard as the ship's "solid photo" health plaque. Ships
without parseable geometry are skipped — the card falls back to the class
silhouette.

The projected triangles are rasterised into a 2D grid so the outline is the
ship's true side "shadow" (keel → deck), not a per-vertex min/max that
collapses into a sliver when the decimated mesh under-samples the keel.

Usage:
    python scripts/model_convert/extract_silhouettes.py [-o silhouettes.json]
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "ships"
DEFAULT_OUT = (
    REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "silhouettes.json"
)

# Meshes whose vertices belong to the hull silhouette (weapons excluded).
# "hull" also covers the split bakes ("hull_bow", "hull_stern", …) and the
# handful of models whose single hull mesh is named without a suffix.
HULL_CATS = ("hull", "superstructure", "funnel", "deck_house", "misc")

# Rasterisation grid (width = length, height = up). The outline is read back
# at W columns; H only needs to be fine enough that the keel/deck staircase is
# small (72 rows → 0.5 viewBox units per row).
W, H = 200, 72


def parse_glb(path: Path) -> dict:
    data = path.read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    json_data = json.loads(data[20 : 20 + json_len].decode("utf-8").rstrip("\x00"))
    bin_start = 20 + json_len + 8
    bin_data = data[bin_start : bin_start + json_data["buffers"][0]["byteLength"]]
    return {"json": json_data, "binary": bin_data}


def mesh_data(glb: dict) -> tuple[np.ndarray, np.ndarray | None]:
    """Hull positions (N,3) and triangle indices (F,3), or (positions, None)."""
    g = glb["json"]
    verts: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    base = 0  # offset into the *concatenated hull* vertex array (weapons dropped)
    for mesh in g.get("meshes", []):
        name = mesh.get("name", "")
        prim = mesh["primitives"][0]
        acc = g["accessors"][prim["attributes"]["POSITION"]]
        bv = g["bufferViews"][acc["bufferView"]]
        off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        mv = np.frombuffer(
            glb["binary"], dtype="<f4", count=acc["count"] * 3, offset=off
        ).reshape(-1, 3)
        # Single-mesh (legacy) bakes: the whole model is the hull — turrets in
        # the side outline are actually more faithful to the in-game plaque.
        if not name or name.startswith(HULL_CATS):
            if "indices" in prim:
                iacc = g["accessors"][prim["indices"]]
                ibv = g["bufferViews"][iacc["bufferView"]]
                ioff = ibv.get("byteOffset", 0) + iacc.get("byteOffset", 0)
                dt = {5121: "<u1", 5123: "<u2", 5125: "<u4"}.get(
                    iacc.get("componentType", 5123), "<u2"
                )
                idx = (
                    np.frombuffer(
                        glb["binary"], dtype=dt, count=iacc["count"], offset=ioff
                    ).astype(np.int64)
                    + base
                )
                faces.append(idx.reshape(-1, 3))
            verts.append(mv)
            base += len(mv)

    if not verts:
        return np.zeros((0, 3)), None
    all_v = np.concatenate(verts)
    all_f = np.concatenate(faces) if faces else None
    return all_v, all_f


def rasterise(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Fill the side-projection shadow into a boolean (H, W) grid."""
    z = verts[:, 2]
    y = verts[:, 1]
    z0, z1 = float(z.min()), float(z.max())
    y0, y1 = float(y.min()), float(y.max())
    if z1 - z0 <= 1e-6 or y1 - y0 <= 1e-6:
        return np.zeros((H, W), dtype=np.uint8)

    sx = (z - z0) / (z1 - z0) * W
    sy = (1.0 - (y - y0) / (y1 - y0)) * H  # deck (max y) → 0, keel (min y) → H
    P = np.stack([sx, sy], axis=1)

    # PIL's polygon fill is C-accelerated and much faster than a per-triangle
    # numpy barycentric rasterisation for tens of thousands of small triangles.
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)
    for tri in faces:
        p = P[tri]
        draw.polygon(
            [
                (float(p[0, 0]), float(p[0, 1])),
                (float(p[1, 0]), float(p[1, 1])),
                (float(p[2, 0]), float(p[2, 1])),
            ],
            fill=1,
        )
    return np.array(img, dtype=np.uint8)


def fill_nan(vals: np.ndarray) -> np.ndarray:
    """Fill NaN columns by nearest valid neighbour (linear interpolation)."""
    out = vals.copy()
    valid = ~np.isnan(vals)
    if not valid.any():
        return out
    idxs = np.where(valid)[0]
    out[: idxs[0]] = vals[idxs[0]]
    out[idxs[-1] + 1 :] = vals[idxs[-1]]
    for a, b in zip(idxs, idxs[1:]):
        if b - a > 1:
            step = (vals[b] - vals[a]) / (b - a)
            for i in range(a + 1, b):
                out[i] = vals[a] + step * (i - a)
    return out


def smooth_curve(vals: np.ndarray, win: int) -> np.ndarray:
    """Fill NaN columns then apply a centred moving average."""
    out = fill_nan(vals)
    sm = np.empty_like(out)
    half = win // 2
    for i in range(len(out)):
        lo, hi = max(0, i - half), min(len(out), i + half + 1)
        sm[i] = out[lo:hi].mean()
    return sm


def median_filter(vals: np.ndarray, win: int) -> np.ndarray:
    """Sliding median: removes isolated 1–2 column spikes but keeps sustained
    features (masts/funnels are several columns wide)."""
    out = fill_nan(vals)
    res = np.empty_like(out)
    half = win // 2
    for i in range(len(out)):
        lo, hi = max(0, i - half), min(len(out), i + half + 1)
        res[i] = np.median(out[lo:hi])
    return res


def deck_with_features(
    raw: np.ndarray,
    deck_win: int = 25,
    feat_thresh: float = 6.0,
    final_win: int = 3,
) -> np.ndarray:
    """Smooth the deck line but keep tall thin features (masts, funnels).

    A wide moving average gives the deck/superstructure *baseline*; columns
    whose raw top protrudes above that baseline by more than `feat_thresh`
    (viewBox units) are kept at their near-raw height, everything else takes
    the smooth baseline. This removes deck-fittings/rigging "burrs" without
    flattening the masts the way a single wide blur would.
    """
    base = smooth_curve(raw, deck_win)
    thr = feat_thresh / 36.0 * H
    prot = base - raw  # positive = protrudes above the local deck
    med = median_filter(raw, 5)
    out = np.where(prot > thr, med, base)
    return smooth_curve(out, final_win)


def simplify(
    points: list[tuple[float, float]], eps: float
) -> list[tuple[float, float]]:
    """Drop near-collinear points (closed-ring Douglas-Peucker-lite)."""
    if len(points) < 3:
        return points

    def dist(
        p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
    ) -> float:
        dx, dy = b[0] - a[0], b[1] - a[1]
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            return ((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2) ** 0.5
        return (
            abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0])
            / (dx * dx + dy * dy) ** 0.5
        )

    def recurse(lo: int, hi: int) -> list[int]:
        if hi <= lo + 1:
            return []
        a, b = points[lo], points[hi]
        dmax, imax = 0.0, -1
        for i in range(lo + 1, hi):
            d = dist(points[i], a, b)
            if d > dmax:
                dmax, imax = d, i
        if dmax <= eps:
            return []
        return recurse(lo, imax) + [imax] + recurse(imax, hi)

    # Split the ring at index 0 and run DP on both halves.
    n = len(points)
    keep = recurse(0, n - 1)
    keep = sorted({0, n - 1, *keep})
    return [points[i] for i in keep]


def extract_silhouette(glb: dict) -> str | None:
    """Side outline path (0..100 × 0..36, bow right) or None."""
    verts, faces = mesh_data(glb)
    if len(verts) < 64 or faces is None or len(faces) == 0:
        return None

    img = rasterise(verts, faces)
    cols = np.where(img.any(axis=0))[0]
    if len(cols) < 4:
        return None

    top = np.full(W, np.nan)
    bottom = np.full(W, np.nan)
    for c in cols:
        rows = np.where(img[:, int(c)])[0]
        if len(rows):
            top[c] = rows[0] + 0.5
            bottom[c] = rows[-1] + 0.5

    # De-jag the two edges before tracing the outline. The deck keeps tall thin
    # features (masts/funnels) via a baseline + protrusion keep; the keel is
    # mostly featureless, so a plain wide blur is enough.
    top = deck_with_features(top)
    bottom = smooth_curve(bottom, win=25)
    cross = top > bottom
    mid = (top + bottom) / 2.0
    top[cross] = mid[cross]
    bottom[cross] = mid[cross]

    # Closed path: deck (min row) left→right, keel (max row) right→left, in the
    # 100 × 36 viewBox (SVG y grows downward → keel near 36, deck near 0).
    pts: list[tuple[float, float]] = []
    for c in range(W):
        if not np.isnan(top[c]):
            pts.append((c / W * 100.0, top[c] / H * 36.0))
    for c in range(W - 1, -1, -1):
        if not np.isnan(bottom[c]):
            pts.append((c / W * 100.0, bottom[c] / H * 36.0))

    pts = simplify(pts, eps=0.35)
    if len(pts) < 4:
        return None

    d = f"M{pts[0][0]:.1f} {pts[0][1]:.1f}"
    for x, y in pts[1:]:
        d += f" L{x:.1f} {y:.1f}"
    d += " Z"
    return d


def process_one(glb_path: Path) -> tuple[str, str | None]:
    try:
        glb = parse_glb(glb_path)
        return glb_path.stem, extract_silhouette(glb)
    except Exception as e:  # noqa: BLE001
        print(f"  skip {glb_path.name}: {e}", file=sys.stderr)
        return glb_path.stem, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default=str(DEFAULT_OUT))
    parser.add_argument("--dir", default=str(SHIPS_DIR))
    parser.add_argument("--jobs", type=int, default=None)
    args = parser.parse_args()

    glb_paths = sorted(Path(args.dir).glob("*.glb"))
    if not glb_paths:
        print(f"[silhouettes] no GLBs under {args.dir}")
        return 1

    out: dict[str, dict] = {}
    ok = 0
    if args.jobs == 1:
        # Sequential (also works in sandboxes that forbid multiprocessing pipes).
        for glb_path in glb_paths:
            stem, path = process_one(glb_path)
            if path:
                out[stem] = {"path": path}
                ok += 1
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for stem, path in pool.map(process_one, glb_paths):
                if path:
                    out[stem] = {"path": path}
                    ok += 1

    out_path = Path(args.output)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(
        f"[silhouettes] {ok} ships → {out_path} ({out_path.stat().st_size // 1024} KB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
