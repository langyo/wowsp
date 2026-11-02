#!/usr/bin/env python3
"""Trace the battle-HUD ship-class markers into crisp SVG icons.

The app shows a ship-class glyph on the roster rows, the hologram
labels/minimap, the share shots and the class hint cards. Those faces used
to read 27 px WebP bitmaps of the game battle-HUD markers
(/gui/battle_hud/markers/ship/icon_*.png), and at modern display densities
upscaling that art reads as jagged stair-steps (user feedback: the small
ship icons alias badly).

This script vectorises the marker art once, into SVG:

  * the marker is a flat two-ink bitmap — a coloured plate plus a darker
    line ink (the outline and the speed strokes), or one dim ink for the
    sunk family. The two inks TILE the glyph silhouette: the line ink is
    the silhouette MINUS the plate islands, so it renders exactly as an
    evenodd path (silhouette outer + plate-island holes) — no thin-stroke
    tracing is involved anywhere, which is what keeps rings and slashes
    faithful and smooth;
  * every contour is traced at 12x on a bicubic field (lightly blurred,
    marched at 0.5), simplified with RDP, and emitted as "M…L…Z" subpaths
    in the source pixel grid (27 / 28 viewBox);
  * the traced layers are rasterised back and validated against the source
    masks — a region below 0.90 IoU fails the run loudly.

The SOURCE ART lives in scripts/model_convert/ship_icon_sources/ (the 37
bundled WebP markers, committed as the pipeline input so the trace is
reproducible without a game install); the app serves the traced SVGs in
packages/webui/src/res/images/ships/. Re-extracting the markers from a
client is optional: pass --src with an extracted directory instead.

Usage:
    python scripts/model_convert/trace_class_icons.py [--src <dir>] [--out <dir>]
"""
from __future__ import annotations

import argparse
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "scripts" / "model_convert" / "ship_icon_sources"
OUT_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "images" / "ships"

Z = 12          # working supersample for contour tracing
BLUR = 1.4      # field blur at the working scale (smooths the pixel steps)
RDP_EPS = 2.0   # simplification tolerance in working pixels (~0.17 source px)
MIN_IOU = 0.90  # per-region trace fidelity floor


def luminance(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def decompose(img: Image.Image) -> dict:
    """Split one marker into silhouette / plate islands / line ink.

    Returns masks in source pixel space plus the sampled inks: the plate
    colour (median of the bright islands), the line ink colour and both
    source alphas (the art draws the line ink at partial opacity).
    """
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    alpha = a[..., 3] / 255.0
    rgb = a[..., :3]
    sil = alpha > 0.5
    if not sil.any():
        raise SystemExit("empty icon")
    lum = luminance(rgb)
    solid = lum[sil]
    # One dim ink (the sunk family) vs the two-ink plate + line art.
    if solid.max() - solid.min() < 70:
        return {
            "kind": "single",
            "sil": sil,
            "fill": None,
            "plate": np.median(rgb[sil], axis=0),
            "plate_a": float(np.median(alpha[sil])),
            "line": None,
            "line_a": None,
        }
    th = (solid.max() + solid.min()) / 2.0
    fill = sil & (lum >= th)
    dark = sil & (lum < th)
    return {
        "kind": "two",
        "sil": sil,
        "fill": fill,
        "plate": np.median(rgb[fill], axis=0),
        "plate_a": float(np.median(alpha[fill])),
        "line": np.median(rgb[dark], axis=0),
        "line_a": float(np.median(alpha[dark])),
    }


def field(mask: np.ndarray, z: int = Z, blur: float = BLUR) -> np.ndarray:
    """Bicubic + blur + threshold: a smooth binary field at z times the grid."""
    im = Image.fromarray((mask * 255).astype(np.uint8), "L")
    big = im.resize((im.width * z, im.height * z), Image.BICUBIC)
    big = big.filter(ImageFilter.GaussianBlur(blur))
    return (np.asarray(big).astype(np.float32) > 127.5).astype(np.uint8)


def components(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    """All 8-connected foreground components as (x, y) pixel lists."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or seen[y, x]:
                continue
            q = deque([(y, x)])
            seen[y, x] = True
            pts = []
            while q:
                cy, cx = q.popleft()
                pts.append((cx, cy))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            out.append(pts)
    return out


def trace_boundary(mask: np.ndarray, start: tuple[int, int]) -> list[tuple[int, int]]:
    """Moore-neighbour boundary trace of the component containing start."""
    h, w = mask.shape
    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    sy, sx = start
    cy, cx, d = sy, sx, 6
    contour = [(sx, sy)]
    for _ in range(h * w * 4):
        for i in range(8):
            dd = (d + i) % 8
            ny, nx = cy + dirs[dd][0], cx + dirs[dd][1]
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx]:
                cy, cx, d = ny, nx, (dd + 5) % 8
                contour.append((cx, cy))
                break
        else:
            break
        if (cx, cy) == (sx, sy) and len(contour) > 2:
            break
    return contour


def rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Douglas-Peucker simplification of a closed contour."""
    if len(points) < 4:
        return points
    arr = np.array(points, np.float32)
    far = int(np.argmax(((arr - arr[0]) ** 2).sum(axis=1)))

    def run(a: int, b: int) -> list[int]:
        if b <= a + 1:
            return []
        A, B = arr[a], arr[b]
        AB = B - A
        length = float(np.hypot(*AB))
        v = arr[a + 1: b] - A
        if length < 1e-6:
            dist = np.hypot(v[:, 0], v[:, 1])
        else:
            dist = np.abs(AB[0] * v[:, 1] - AB[1] * v[:, 0]) / length
        idx = int(np.argmax(dist))
        if dist[idx] > eps:
            k = a + 1 + idx
            return run(a, k) + [k] + run(k, b)
        return []

    keep = [0] + run(0, far) + [far] + run(far, len(arr) - 1)
    return [tuple(arr[i]) for i in keep]


def trace_layer(mask: np.ndarray) -> dict:
    """Outer and hole contours of one mask, in Z-scaled pixel coordinates."""
    big = field(mask)
    outers = []
    for comp in components(big):
        contour = trace_boundary(big, (comp[0][1], comp[0][0]))
        if len(contour) >= 4:
            outers.append(rdp([(float(x), float(y)) for (x, y) in contour], RDP_EPS))
    holes = []
    h, w = big.shape
    pad = np.zeros((h + 2, w + 2), dtype=np.uint8)
    pad[1:-1, 1:-1] = big
    bg = (pad == 0).astype(np.uint8)
    for comp in components(bg):
        xs = [p[0] for p in comp]
        ys = [p[1] for p in comp]
        if min(xs) == 0 or min(ys) == 0 or max(xs) == w + 1 or max(ys) == h + 1:
            continue
        hole = np.zeros_like(big)
        for (x, y) in comp:
            hole[y - 1, x - 1] = 1
        contour = trace_boundary(hole, (comp[0][1] - 1, comp[0][0] - 1))
        if len(contour) >= 4:
            holes.append(rdp([(float(x), float(y)) for (x, y) in contour], RDP_EPS))
    return {"outers": outers, "holes": holes}


def path_data(contours: list[list[tuple[float, float]]], z: int) -> str:
    parts = []
    for c in contours:
        if len(c) < 3:
            continue
        pts = [(x / z, y / z) for (x, y) in c]
        parts.append("M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z")
    return "".join(parts)


def hex_color(rgb: np.ndarray) -> str:
    return "#" + "".join(f"{max(0, min(255, round(float(v)))):02x}" for v in rgb[:3])


def rasterize(contours: list[list[tuple[float, float]]], size: int, ss: int = 4) -> np.ndarray:
    """Evenodd-rasterise the traced contours back to the source grid.

    A parity test per sample (not a polygon fill): the traced subpaths are
    an evenodd compound path, so holes must XOR out exactly like the SVG
    fill-rule will.
    """
    H = size * ss
    ys, xs = np.mgrid[0:H, 0:H]
    px = (xs + 0.5) * (size / H)
    py = (ys + 0.5) * (size / H)
    inside = np.zeros((H, H), bool)
    for c in contours:
        if len(c) < 3:
            continue
        pts = [(x / Z, y / Z) for (x, y) in c]
        n = len(pts)
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            if y1 == y2:
                continue
            cond = (y1 > py) != (y2 > py)
            xin = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            inside ^= cond & (px < xin)
    im = Image.fromarray((inside * 255).astype(np.uint8), "L")
    return np.asarray(im.resize((size, size), Image.LANCZOS)).astype(np.float32) / 255.0


def iou(a: np.ndarray, b: np.ndarray) -> float:
    A, B = a > 0.5, b > 0.5
    union = int((A | B).sum())
    return float((A & B).sum() / union) if union else 1.0


def write_svg(layers: list[dict], size: int, out: Path) -> None:
    body = []
    for layer in layers:
        d = layer["d"]
        if not d:
            continue
        opacity = layer.get("opacity", 1.0)
        op = "" if abs(opacity - 1.0) < 1e-6 else f' fill-opacity="{opacity:.3f}"'
        body.append(
            f'<path d="{d}" fill="{layer["color"]}" fill-rule="evenodd"{op}/>'
        )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">' + "".join(body) + "</svg>"
    )
    out.write_text(svg, encoding="utf-8")


def trace_sunk(
    img: Image.Image, info: dict, path: Path, size: int, out_dir: Path
) -> tuple[bool, str]:
    """Trace one sunk-family marker (dim black hull under a faint white ink).

    The bright ink sits at ~0.25 alpha and the black hull at ~0.5, so the
    ordinary plate/line split (which keys on a mostly-opaque silhouette)
    would drop the rim. Here the silhouette is the whole faint glyph, the
    white layer fills it at the measured rim alpha, and the black hull is
    painted on top with its slash cut-outs as evenodd holes.
    """
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    alpha = a[..., 3] / 255.0
    rgb = a[..., :3]
    lum = luminance(rgb)
    sil = alpha > 0.15
    solid = sil & (alpha > 0.3)
    if not solid.any():
        return False, f"{path.name}: no solid ink"
    th = (lum[solid].max() + lum[solid].min()) / 2.0
    bright = solid & (lum >= th)
    dark = solid & (lum < th)
    plate = np.median(rgb[bright], axis=0)
    plate_a = float(np.median(alpha[bright]))
    line = np.median(rgb[dark], axis=0)
    line_a = float(np.median(alpha[dark]))

    sil_layer = trace_layer(sil)
    dark_layer = trace_layer(dark)
    got_sil = rasterize(sil_layer["outers"] + sil_layer["holes"], size)
    got_dark = rasterize(dark_layer["outers"] + dark_layer["holes"], size)
    s_sil = iou(got_sil, sil.astype(np.float32))
    s_dark = iou(got_dark, dark.astype(np.float32))
    if s_sil < MIN_IOU or s_dark < MIN_IOU:
        return False, f"{path.name}: silhouette IoU {s_sil:.3f} / hull IoU {s_dark:.3f} < {MIN_IOU}"
    layers = [
        {"d": path_data(sil_layer["outers"] + sil_layer["holes"], Z),
         "color": hex_color(plate), "opacity": plate_a},
        {"d": path_data(dark_layer["outers"] + dark_layer["holes"], Z),
         "color": hex_color(line), "opacity": line_a},
    ]
    out = out_dir / (path.stem + ".svg")
    write_svg(layers, size, out)
    return True, f"wrote {out.name}"


def trace_icon(path: Path, out_dir: Path) -> tuple[bool, str]:
    """Trace one marker file into its SVG; returns (ok, message)."""
    img = Image.open(path)
    info = decompose(img)
    size = img.width
    layers: list[dict] = []

    if "sunk" in path.name:
        # The sunk faces are their own two-tone scheme: a DIM BLACK hull
        # (alpha ~0.5) inside a FAINT WHITE rim/slash ink (alpha ~0.25) —
        # the plate/line roles invert, so the plate layer carries the
        # silhouette in white and the line layer is the black hull on top
        # (its evenodd holes are the faint slash strokes).
        return trace_sunk(img, info, path, size, out_dir)

    if info["kind"] == "single":
        shape = trace_layer(info["sil"])
        got = rasterize(shape["outers"] + shape["holes"], size)
        score = iou(got, info["sil"].astype(np.float32))
        if score < MIN_IOU:
            return False, f"{path.name}: silhouette IoU {score:.3f} < {MIN_IOU}"
        layers = [{"d": path_data(shape["outers"] + shape["holes"], Z),
                   "color": hex_color(info["plate"]), "opacity": info["plate_a"]}]
    else:
        sil = trace_layer(info["sil"])
        fill = trace_layer(info["fill"])
        # The line ink is the silhouette minus the plate islands: one evenodd
        # path, so the hairline rings and slashes come out of LARGE contours
        # instead of thin-stroke tracing.
        dark_contours = sil["outers"] + sil["holes"] + fill["outers"] + fill["holes"]
        fill_contours = fill["outers"] + fill["holes"]
        got_dark = rasterize(dark_contours, size)
        got_fill = rasterize(fill_contours, size)
        ref_dark = (info["sil"] & ~info["fill"]).astype(np.float32)
        sd = iou(got_dark, ref_dark)
        sf = iou(got_fill, info["fill"].astype(np.float32))
        if sd < MIN_IOU or sf < MIN_IOU:
            return False, f"{path.name}: line IoU {sd:.3f} / plate IoU {sf:.3f} < {MIN_IOU}"
        layers = [
            {"d": path_data(dark_contours, Z), "color": hex_color(info["line"]),
             "opacity": info["line_a"]},
            {"d": path_data(fill_contours, Z), "color": hex_color(info["plate"]),
             "opacity": info["plate_a"]},
        ]

    out = out_dir / (path.stem + ".svg")
    write_svg(layers, size, out)
    return True, f"wrote {out.name}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=SOURCE_DIR)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args(argv[1:])
    if not args.src.is_dir():
        raise SystemExit(f"source dir missing: {args.src}")
    args.out.mkdir(parents=True, exist_ok=True)
    failures = []
    written = 0
    for path in sorted(args.src.iterdir()):
        if path.suffix.lower() not in (".webp", ".png") or not path.name.startswith("icon_"):
            continue
        ok, message = trace_icon(path, args.out)
        if not ok:
            failures.append(message)
            continue
        written += 1
        print(message)
    if failures:
        print("\nFAILURES:", *failures, sep="\n  ")
        return 1
    print(f"\n{written} icons written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
