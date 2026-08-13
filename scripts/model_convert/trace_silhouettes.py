#!/usr/bin/env python3
"""Trace the game's gui/ships_silhouettes PNGs into the HoloShipCard paths.

The in-game HP plaque uses per-ship silhouette bitmaps
(`gui/ships_silhouettes/<INDEX>.png` — a dark solid ship profile on a
transparent background). This script traces those bitmaps into SVG paths and
maps them from ship INDEX to model baseName via `ship_models.json`, producing
the `silhouettes.json` the shared HoloShipCard consumes (keyed by model name,
`0..100 × 0..36` viewBox, bow pointing right).

Usage:
    # 1. unpack the PNGs from the game .pkg (see scripts/extract):
    #    python scripts/extract/extract_game_assets.py \
    #      --pkg "<game>/res_packages/gui_0001.pkg" \
    #      --meta "%LOCALAPPDATA%/WoWSP-extract/wows_meta.json" \
    #      --prefix "/gui/ships_silhouettes/" --out _sil_png
    # 2. trace:
    python scripts/model_convert/trace_silhouettes.py \
        --png _sil_png/gui/ships_silhouettes
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIP_MODELS = REPO_ROOT / "packages" / "webui" / "src" / "data" / "ship_models.json"
DEFAULT_OUT = (
    REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "silhouettes.json"
)


def largest_component(mask: np.ndarray) -> np.ndarray:
    """Keep only the largest 8-connected foreground component."""
    seen = np.zeros_like(mask, dtype=bool)
    best: list[tuple[int, int]] = []
    for r in range(mask.shape[0]):
        for c in range(mask.shape[1]):
            if not mask[r, c] or seen[r, c]:
                continue
            q = deque([(r, c)])
            seen[r, c] = True
            comp: list[tuple[int, int]] = []
            while q:
                rr, cc = q.popleft()
                comp.append((rr, cc))
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        nr, nc = rr + dr, cc + dc
                        if 0 <= nr < mask.shape[0] and 0 <= nc < mask.shape[1]:
                            if mask[nr, nc] and not seen[nr, nc]:
                                seen[nr, nc] = True
                                q.append((nr, nc))
            if len(comp) > len(best):
                best = comp
    out = np.zeros_like(mask)
    for r, c in best:
        out[r, c] = True
    return out


def trace_contour(mask: np.ndarray) -> np.ndarray | None:
    """Marching-squares outline (largest contour), points as (col, row)."""
    cs = plt.contour(mask.astype(np.float64), levels=[0.5])
    best = None
    for segs in cs.allsegs:
        for seg in segs:
            if len(seg) >= 4 and (best is None or len(seg) > len(best)):
                best = seg
    plt.close("all")
    return best


def _perp_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return ((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2) ** 0.5
    return (
        abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0])
        / (dx * dx + dy * dy) ** 0.5
    )


def _rdp_open(
    points: list[tuple[float, float]], eps: float
) -> list[tuple[float, float]]:
    """Ramer–Douglas–Peucker for an OPEN polyline (keeps both endpoints)."""
    if len(points) < 3:
        return points
    dmax, imax = 0.0, -1
    for i in range(1, len(points) - 1):
        d = _perp_dist(points[i], points[0], points[-1])
        if d > dmax:
            dmax, imax = d, i
    if dmax <= eps:
        return [points[0], points[-1]]
    left = _rdp_open(points[: imax + 1], eps)
    right = _rdp_open(points[imax:], eps)
    return left[:-1] + right


def simplify_ring(
    points: list[tuple[float, float]], eps: float
) -> list[tuple[float, float]]:
    """Douglas–Peucker for a CLOSED ring.

    Splits the ring at two far-apart anchor points and simplifies each arc as
    an open polyline, so the closure edge is never treated as a chord (which
    would let over-aggressive simplification self-intersect the outline).
    """
    n = len(points)
    if n < 3:
        return points
    p0 = points[0]
    far = max(
        range(1, n),
        key=lambda i: (points[i][0] - p0[0]) ** 2 + (points[i][1] - p0[1]) ** 2,
    )
    arc1 = points[0 : far + 1]
    arc2 = points[far:] + [points[0]]
    s1 = _rdp_open(arc1, eps)
    s2 = _rdp_open(arc2, eps)
    return s1[:-1] + s2[:-1]


def trace_png(png_bytes: bytes) -> str | None:
    """Trace one silhouette PNG into an SVG path (0..100 × 0..36)."""
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    a = np.array(img)
    mask = a[..., 3] > 128
    mask = largest_component(mask)
    contour = trace_contour(mask)
    if contour is None or len(contour) < 16:
        return None

    xs, ys = contour[:, 0], contour[:, 1]
    xmin, xmax = float(xs.min()), float(xs.max())
    ymin, ymax = float(ys.min()), float(ys.max())
    if xmax - xmin < 2.0 or ymax - ymin < 2.0:
        return None

    pts = [
        ((x - xmin) / (xmax - xmin) * 100.0, (y - ymin) / (ymax - ymin) * 36.0)
        for x, y in contour
    ]
    pts = simplify_ring(pts, eps=0.7)
    if len(pts) < 4:
        return None

    d = f"M{pts[0][0]:.1f} {pts[0][1]:.1f}"
    for x, y in pts[1:]:
        d += f" L{x:.1f} {y:.1f}"
    d += " Z"
    return d


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--png", required=True, help="dir of extracted ships_silhouettes PNGs"
    )
    ap.add_argument("--models", default=str(SHIP_MODELS))
    ap.add_argument("-o", "--output", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    png_dir = Path(args.png)
    if not png_dir.is_dir():
        print(f"[trace] not a directory: {png_dir}", file=sys.stderr)
        return 1

    # index -> traced path
    index_path: dict[str, str] = {}
    skipped = 0
    for png in sorted(png_dir.glob("*.png")):
        if png.stem == "ship_background":
            continue
        path = trace_png(png.read_bytes())
        if path:
            index_path[png.stem] = path
        else:
            skipped += 1
    print(f"[trace] traced {len(index_path)} silhouettes ({skipped} skipped)")

    # baseName -> index(es) from ship_models.json
    models = json.loads(Path(args.models).read_text(encoding="utf-8"))
    name_to_idx: dict[str, set[str]] = {}
    for entry in models.values():
        idx = entry.get("index")
        base = entry.get("baseName")
        if idx and base:
            name_to_idx.setdefault(base, set()).add(idx)

    out: dict[str, dict] = {}
    for base, idxs in sorted(name_to_idx.items()):
        for idx in sorted(idxs):
            if idx in index_path:
                out[base] = {"path": index_path[idx]}
                break

    out_path = Path(args.output)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(
        f"[trace] {len(out)} models → {out_path} ({out_path.stat().st_size // 1024} KB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
