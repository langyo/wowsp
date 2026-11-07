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
  * the geometry is recovered at SUB-PIXEL resolution: soft coverage
    fields are built from the anti-aliased alpha/luminance channels,
    denoised with a small Gaussian, upsampled 16x with bicubic
    interpolation, and contoured with MARCHING SQUARES at the 0.5
    iso-level — the interpolated crossings give a smooth boundary instead
    of the old 1-pixel Moore-neighbour staircase. Contours are simplified
    with a small RDP tolerance in SOURCE pixels, so a diagonal becomes a
    run of near-collinear multi-point segments instead of a zig-zag;
  * the traced layers are rasterised back and validated against the
    sub-pixel coverage fields (thresholded IoU + mean coverage error), with
    a hard silhouette-IoU sanity floor — a bad region fails the run loudly.

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
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "scripts" / "model_convert" / "ship_icon_sources"
OUT_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "images" / "ships"

Z = 16                # working supersample for sub-pixel contour extraction
BLUR_SRC = 0.45       # Gaussian sigma in SOURCE pixels (cancels WebP alpha noise)
RDP_EPS_SRC = 0.090   # simplification tolerance in SOURCE pixels: absorbs the
                      # sub-pixel wobble of the 27 px source on long edges (a
                      # 0.03 tolerance kept it as a visibly wavy hull)
MIN_AREA_SRC = 0.20   # drop specks smaller than this (source px^2)
MIN_IOU = 0.90        # per-region soft-coverage IoU floor
MAX_MAE = 0.06        # per-region mean absolute coverage error ceiling
MIN_BINARY_IOU = 0.85 # sanity floor against the hard source silhouette
# Hairline ink layers (the hull ring / the speed slashes) cover only a few
# source pixels: a sub-pixel contour shift eats a large share of their area,
# so their IoU is hypersensitive while the actual coverage error stays tiny.
# Such layers are judged on the coverage error alone; layers that tile the
# glyph keep the strict IoU floor.
THIN_LAYER_MEAN_COVERAGE = 0.25
THIN_LAYER_MAX_MAE = 0.02


def luminance(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def gaussian_blur(field: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur of a float field (edge-clamped)."""
    if sigma <= 0:
        return field
    radius = max(1, int(math.ceil(sigma * 3)))
    xs = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (xs / sigma) ** 2)
    kernel /= kernel.sum()
    h, w = field.shape

    def conv_axis(src: np.ndarray, axis: int) -> np.ndarray:
        pad = radius
        if axis == 1:
            padded = np.pad(src, ((0, 0), (pad, pad)), mode="edge")
            out = np.zeros_like(src)
            for i, weight in enumerate(kernel):
                out += weight * padded[:, i:i + w]
        else:
            padded = np.pad(src, ((pad, pad), (0, 0)), mode="edge")
            out = np.zeros_like(src)
            for i, weight in enumerate(kernel):
                out += weight * padded[i:i + h, :]
        return out

    return conv_axis(conv_axis(field.astype(np.float64), 1), 0).astype(np.float32)


def upsample(field: np.ndarray, z: int = Z) -> np.ndarray:
    """Bicubic upsample of a float coverage field (the field is already smooth)."""
    im = Image.fromarray(field.astype(np.float32))
    big = im.resize((im.width * z, im.height * z), Image.BICUBIC)
    return np.asarray(big, dtype=np.float32)


def marching_squares(field: np.ndarray, iso: float = 0.5) -> list[list[tuple[float, float]]]:
    """Closed iso-contours of a scalar field via marching squares.

    Every cell crossing emits one or two segments whose endpoints lie on the
    shared grid edges (linearly interpolated, so SUB-PIXEL accurate); the
    segments are then linked into closed loops. Ambiguous saddles resolve on
    the cell-centre average, so saddle topology matches the smooth field.
    Returns loops in the field's own coordinate frame.
    """
    h, w = field.shape
    inside = field >= iso
    a = inside[:-1, :-1]
    b = inside[:-1, 1:]
    c = inside[1:, 1:]
    d = inside[1:, :-1]
    case = (
        a.astype(np.uint8)
        | (b.astype(np.uint8) << 1)
        | (c.astype(np.uint8) << 2)
        | (d.astype(np.uint8) << 3)
    )
    ys, xs = np.nonzero((case > 0) & (case < 15))

    points: dict[tuple[str, int, int], tuple[float, float]] = {}

    def h_point(y: int, x: int) -> tuple[str, int, int]:
        key = ("h", y, x)
        if key not in points:
            f0, f1 = float(field[y, x]), float(field[y, x + 1])
            t = 0.5 if abs(f1 - f0) < 1e-9 else (iso - f0) / (f1 - f0)
            points[key] = (x + t, float(y))
        return key

    def v_point(y: int, x: int) -> tuple[str, int, int]:
        key = ("v", y, x)
        if key not in points:
            f0, f1 = float(field[y, x]), float(field[y + 1, x])
            t = 0.5 if abs(f1 - f0) < 1e-9 else (iso - f0) / (f1 - f0)
            points[key] = (float(x), y + t)
        return key

    # Cell -> crossing-edge pairs, from the 16-case marching-squares table.
    segments: list[tuple[tuple[str, int, int], tuple[str, int, int]]] = []
    for y, x in zip(ys.tolist(), xs.tolist()):
        cs = int(case[y, x])
        top = h_point(y, x)
        right = v_point(y, x + 1)
        bottom = h_point(y + 1, x)
        left = v_point(y, x)
        if cs == 1:
            segments.append((left, top))
        elif cs == 2:
            segments.append((top, right))
        elif cs == 3:
            segments.append((left, right))
        elif cs == 4:
            segments.append((right, bottom))
        elif cs == 5:
            centre = (field[y, x] + field[y, x + 1] + field[y + 1, x + 1] + field[y + 1, x]) / 4.0
            if centre >= iso:
                segments.extend(((top, right), (bottom, left)))
            else:
                segments.extend(((left, top), (right, bottom)))
        elif cs == 6:
            segments.append((top, bottom))
        elif cs == 7:
            segments.append((left, bottom))
        elif cs == 8:
            segments.append((bottom, left))
        elif cs == 9:
            segments.append((top, bottom))
        elif cs == 10:
            centre = (field[y, x] + field[y, x + 1] + field[y + 1, x + 1] + field[y + 1, x]) / 4.0
            if centre >= iso:
                segments.extend(((left, top), (right, bottom)))
            else:
                segments.extend(((top, right), (bottom, left)))
        elif cs == 11:
            segments.append((right, bottom))
        elif cs == 12:
            segments.append((left, right))
        elif cs == 13:
            segments.append((top, right))
        elif cs == 14:
            segments.append((left, top))

    # Link segments into closed loops (each grid edge belongs to at most two
    # segments, so a walk consuming segments finds every loop exactly once).
    adjacency: dict[tuple[str, int, int], list[int]] = {}
    for index, (p, q) in enumerate(segments):
        adjacency.setdefault(p, []).append(index)
        adjacency.setdefault(q, []).append(index)
    used = [False] * len(segments)
    loops: list[list[tuple[float, float]]] = []
    for start in adjacency:
        if all(used[index] for index in adjacency[start]):
            continue
        loop: list[tuple[float, float]] = []
        current = start
        while True:
            pending = [index for index in adjacency[current] if not used[index]]
            if not pending:
                break
            index = pending[0]
            used[index] = True
            p, q = segments[index]
            loop.append(points[current])
            current = q if p == current else p
            if current == start:
                break
        if len(loop) >= 3:
            loops.append(loop)
    return loops


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


def contour_area(points: list[tuple[float, float]]) -> float:
    """Absolute shoelace area of a contour in source pixels."""
    if len(points) < 3:
        return 0.0
    arr = np.asarray(points, dtype=np.float64)
    x, y = arr[:, 0], arr[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def trace_field(coverage: np.ndarray) -> list[list[tuple[float, float]]]:
    """Sub-pixel contours of one soft coverage field, in source pixel coords."""
    smooth = gaussian_blur(coverage, BLUR_SRC)
    big = upsample(smooth)
    loops = marching_squares(big, 0.5)
    out: list[list[tuple[float, float]]] = []
    for loop in loops:
        # Working-grid points -> source pixels, then a small-tolerance RDP so
        # near-straight diagonals collapse into multi-point straight runs
        # while the sub-pixel curve information survives.
        pts = [(x / Z, y / Z) for (x, y) in loop]
        if contour_area(pts) < MIN_AREA_SRC:
            continue
        simplified = rdp(pts, RDP_EPS_SRC)
        if len(simplified) >= 3 and contour_area(simplified) >= MIN_AREA_SRC:
            out.append(simplified)
    return out


def path_data(contours: list[list[tuple[float, float]]]) -> str:
    parts = []
    for contour in contours:
        if len(contour) < 3:
            continue
        parts.append(
            "M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in contour) + "Z"
        )
    return "".join(parts)


def hex_color(rgb: np.ndarray) -> str:
    return "#" + "".join(f"{max(0, min(255, round(float(v)))):02x}" for v in rgb[:3])


def rasterize(contours: list[list[tuple[float, float]]], size: int, ss: int = 8) -> np.ndarray:
    """Evenodd-rasterise traced contours back to the source grid.

    Each contour is filled into a supersampled mask and XORed into the
    accumulator — the evenodd compound-path semantics the SVG fill-rule
    uses (an outer path XOR its holes).
    """
    H = size * ss
    acc = np.zeros((H, H), dtype=bool)
    for contour in contours:
        if len(contour) < 3:
            continue
        im = Image.new("1", (H, H), 0)
        ImageDraw.Draw(im).polygon([(x * ss, y * ss) for x, y in contour], fill=1)
        acc ^= np.asarray(im, dtype=bool)
    covered = acc.reshape(size, ss, size, ss).mean(axis=(1, 3))
    return covered.astype(np.float32)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """Thresholded IoU of two coverage fields (the hard silhouette sanity check)."""
    A, B = a > 0.5, b > 0.5
    union = int((A | B).sum())
    return float((A & B).sum() / union) if union else 1.0


def layer_ok(ref: np.ndarray, score: float, mae: float) -> bool:
    """Fidelity gate for one layer: the strict IoU+MAE pair, with the
    documented hairline exemption (see THIN_LAYER_*)."""
    if score >= MIN_IOU and mae <= MAX_MAE:
        return True
    return float(ref.mean()) <= THIN_LAYER_MEAN_COVERAGE and mae <= THIN_LAYER_MAX_MAE


def coverage_score(got: np.ndarray, ref: np.ndarray) -> tuple[float, float]:
    """Fidelity of a traced layer against its sub-pixel reference coverage.

    The reference is the CONTINUOUS ink-coverage field the trace was built
    from; a hard binary comparison would punish the deliberate edge
    smoothing on hairline strokes, so the floor is a thresholded IoU plus a
    mean-absolute-coverage-error ceiling.
    """
    got_b, ref_b = got > 0.5, ref > 0.5
    union = int((got_b | ref_b).sum())
    score = float((got_b & ref_b).sum() / union) if union else 1.0
    return score, float(np.abs(got - ref).mean())


def decompose(img: Image.Image) -> dict:
    """Split one marker into its ink coverage fields and sampled inks.

    Returns the sub-pixel coverage fields (silhouette / plate / line ink) in
    source pixel space plus each ink's sampled colour and alpha.
    """
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    alpha = a[..., 3] / 255.0
    rgb = a[..., :3]
    lum = luminance(rgb)
    sil = alpha > 0.5
    if not sil.any():
        raise SystemExit("empty icon")
    solid_lum = lum[sil]
    # One dim ink (the outline glyph family) vs the two-ink plate + line art.
    if float(solid_lum.max()) - float(solid_lum.min()) < 70:
        plate = np.median(rgb[sil], axis=0)
        plate_a = max(float(np.median(alpha[sil])), 0.05)
        sil_cov = np.clip(alpha / plate_a, 0.0, 1.0)
        return {
            "kind": "single",
            "sil": sil,
            "fill": None,
            "sil_cov": sil_cov,
            "plate_cov": None,
            "line_cov": None,
            "plate": plate,
            "plate_a": plate_a,
            "line": None,
            "line_a": None,
        }
    th = (float(solid_lum.max()) + float(solid_lum.min())) / 2.0
    fill = sil & (lum >= th)
    dark = sil & ~fill
    plate = np.median(rgb[fill], axis=0)
    plate_a = max(float(np.median(alpha[fill])), 0.05)
    line = np.median(rgb[dark], axis=0)
    line_a = max(float(np.median(alpha[dark])), 0.05)
    bright_lum = float(np.median(lum[fill]))
    dark_lum = float(np.median(lum[dark]))
    span = max(bright_lum - dark_lum, 1.0)
    # Soft ink-class fraction: a plate<->line colour boundary is
    # anti-aliased in luminance, so this crossing is sub-pixel too.
    frac = np.clip((lum - dark_lum) / span, 0.0, 1.0)
    plate_cov = np.clip(alpha * frac / plate_a, 0.0, 1.0)
    line_cov = np.clip(alpha * (1.0 - frac) / line_a, 0.0, 1.0)
    sil_cov = np.clip(plate_cov + line_cov, 0.0, 1.0)
    return {
        "kind": "two",
        "sil": sil,
        "fill": fill,
        "sil_cov": sil_cov,
        "plate_cov": plate_cov,
        "line_cov": line_cov,
        "plate": plate,
        "plate_a": plate_a,
        "line": line,
        "line_a": line_a,
    }


CROP_MARGIN_SRC = 0.35  # breathing room around the cropped silhouette (src px)


def contour_bbox(layers: list[dict]) -> tuple[float, float, float, float] | None:
    """Union bounding box of every emitted contour, in source pixels."""
    xs: list[float] = []
    ys: list[float] = []
    for layer in layers:
        for loop in layer["contours"]:
            for x, y in loop:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def write_svg(layers: list[dict], size: int, out: Path) -> None:
    body = []
    for layer in layers:
        d = path_data(layer["contours"])
        if not d:
            continue
        opacity = layer.get("opacity", 1.0)
        op = "" if abs(opacity - 1.0) < 1e-6 else f' fill-opacity="{opacity:.3f}"'
        body.append(f'<path d="{d}" fill="{layer["color"]}" fill-rule="evenodd"{op}/>')
    # The art is CROPPED to the silhouette: the game marker's 27 px canvas
    # carries ~40% empty padding, which forced consumers to zoom the mask
    # (150%) and resample the raster — and still read small. A cropped
    # viewBox lets every consumer render the silhouette 1:1 in its own box.
    box = contour_bbox(layers)
    if box is None:
        raise SystemExit(f"empty trace for {out.name}")
    x0, y0, x1, y1 = box
    x0 -= CROP_MARGIN_SRC
    y0 -= CROP_MARGIN_SRC
    x1 += CROP_MARGIN_SRC
    y1 += CROP_MARGIN_SRC
    w = x1 - x0
    h = y1 - y0
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}" height="{h:.2f}" '
        f'viewBox="{x0:.2f} {y0:.2f} {w:.2f} {h:.2f}">' + "".join(body) + "</svg>"
    )
    out.write_text(svg, encoding="utf-8")


def trace_sunk(img: Image.Image, info: dict, path: Path, size: int, out_dir: Path) -> tuple[bool, str]:
    """Trace one sunk-family marker (dim black hull under a faint white ink).

    The bright rim sits at ~0.25-0.3 alpha and the black hull at ~0.5-0.6, so
    the ordinary plate/line split (which keys on a mostly-opaque silhouette)
    would drop the rim. Here the silhouette coverage is the union of both
    inks, the white layer fills it at the measured rim alpha, and the black
    hull is painted on top with its slash cut-outs as evenodd holes.
    """
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    alpha = a[..., 3] / 255.0
    rgb = a[..., :3]
    lum = luminance(rgb)
    sil = alpha > 0.15
    solid = sil & (alpha > 0.3)
    if not solid.any():
        return False, f"{path.name}: no solid ink"
    th = (float(lum[solid].max()) + float(lum[solid].min())) / 2.0
    bright = solid & (lum >= th)
    dark = solid & (lum < th)
    plate = np.median(rgb[bright], axis=0)
    plate_a = max(float(np.median(alpha[bright])), 0.05)
    line = np.median(rgb[dark], axis=0)
    line_a = max(float(np.median(alpha[dark])), 0.05)
    bright_lum = float(np.median(lum[bright]))
    dark_lum = float(np.median(lum[dark]))
    frac = np.clip((lum - dark_lum) / max(bright_lum - dark_lum, 1.0), 0.0, 1.0)
    hull_cov = np.clip(alpha * (1.0 - frac) / line_a, 0.0, 1.0)
    rim_cov = np.clip(alpha * frac / plate_a, 0.0, 1.0)
    sil_cov = np.clip(rim_cov + hull_cov, 0.0, 1.0)

    sil_contours = trace_field(sil_cov)
    hull_contours = trace_field(hull_cov)
    got_sil = rasterize(sil_contours, size)
    got_hull = rasterize(hull_contours, size)
    s_sil, m_sil = coverage_score(got_sil, sil_cov)
    s_hull, m_hull = coverage_score(got_hull, hull_cov)
    if s_sil < MIN_IOU or s_hull < MIN_IOU or m_sil > MAX_MAE or m_hull > MAX_MAE:
        return False, (
            f"{path.name}: silhouette {s_sil:.3f}/{m_sil:.3f} "
            f"hull {s_hull:.3f}/{m_hull:.3f} below {MIN_IOU}/{MAX_MAE}"
        )
    layers = [
        {"contours": sil_contours, "color": hex_color(plate), "opacity": plate_a},
        {"contours": hull_contours, "color": hex_color(line), "opacity": line_a},
    ]
    out = out_dir / (path.stem + ".svg")
    write_svg(layers, size, out)
    return True, f"wrote {out.name} (sil {s_sil:.3f} hull {s_hull:.3f})"


def trace_icon(path: Path, out_dir: Path) -> tuple[bool, str]:
    """Trace one marker file into its SVG; returns (ok, message)."""
    img = Image.open(path)
    info = decompose(img)
    size = img.width

    if "sunk" in path.name:
        return trace_sunk(img, info, path, size, out_dir)

    if info["kind"] == "single":
        sil_contours = trace_field(info["sil_cov"])
        got = rasterize(sil_contours, size)
        score, mae = coverage_score(got, info["sil_cov"])
        if score < MIN_IOU or mae > MAX_MAE:
            return False, f"{path.name}: silhouette {score:.3f}/{mae:.3f} below {MIN_IOU}/{MAX_MAE}"
        layers = [
            {"contours": sil_contours, "color": hex_color(info["plate"]),
             "opacity": info["plate_a"]},
        ]
    else:
        sil_contours = trace_field(info["sil_cov"])
        plate_contours = trace_field(info["plate_cov"])
        # The line ink is the silhouette minus the plate islands: one evenodd
        # path, so the hairline rings and slashes come out of LARGE contours
        # instead of thin-stroke tracing.
        line_contours = sil_contours + plate_contours
        got_sil = rasterize(sil_contours, size)
        got_line = rasterize(line_contours, size)
        got_plate = rasterize(plate_contours, size)
        ref_line = np.clip(info["sil_cov"] - info["plate_cov"], 0.0, 1.0)
        s_sil, m_sil = coverage_score(got_sil, info["sil_cov"])
        s_line, m_line = coverage_score(got_line, ref_line)
        s_plate, m_plate = coverage_score(got_plate, info["plate_cov"])
        if not (
            layer_ok(info["sil_cov"], s_sil, m_sil)
            and layer_ok(ref_line, s_line, m_line)
            and layer_ok(info["plate_cov"], s_plate, m_plate)
        ):
            return False, (
                f"{path.name}: sil {s_sil:.3f}/{m_sil:.3f} "
                f"line {s_line:.3f}/{m_line:.3f} plate {s_plate:.3f}/{m_plate:.3f} "
                f"below {MIN_IOU}/{MAX_MAE}"
            )
        binary_sil = iou(got_sil, info["sil"].astype(np.float32))
        if binary_sil < MIN_BINARY_IOU:
            return False, f"{path.name}: hard silhouette IoU {binary_sil:.3f} < {MIN_BINARY_IOU}"
        layers = [
            {"contours": line_contours, "color": hex_color(info["line"]),
             "opacity": info["line_a"]},
            {"contours": plate_contours, "color": hex_color(info["plate"]),
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
