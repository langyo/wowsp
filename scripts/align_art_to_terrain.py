#!/usr/bin/env python3
"""Per-map art-registration measurement: how far is the hand-drawn minimap
art from the real island geometry (the baked GLB terrain, which is what the
3D view and replay coordinates use)?

For each map: rasterise the GLB's above-water triangles north-up under the
minimaps.json rect, then FFT cross-correlate (Gaussian-blurred masks, both
signs) against the art's land mask. Reports the shift that best re-aligns
the ART to the TERRAIN, in world units, plus a confidence score and the
unshifted baseline. Diagnostics: dump pre/post overlay PNGs per map.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

MAPS = Path("packages/webui/src/res/models/maps")
OUT = Path("scripts/tmp-align-diag")


def glb_triangles(path: Path):
    data = path.read_bytes()
    jlen, = struct.unpack_from("<I", data, 12)
    g = json.loads(data[20:20 + jlen].rstrip(b"\x00 "))
    off = 20 + jlen
    blen, btype = struct.unpack_from("<I4s", data, off)
    assert btype.rstrip(b"\x00") == b"BIN"
    blob = data[off + 8: off + 8 + blen]
    tris = []
    for mesh in g["meshes"]:
        for prim in mesh["primitives"]:
            pos_acc = g["accessors"][prim["attributes"]["POSITION"]]
            idx_acc = g["accessors"][prim["indices"]]
            bv = g["bufferViews"][pos_acc["bufferView"]]
            vstart = bv.get("byteOffset", 0) + pos_acc.get("byteOffset", 0)
            verts = np.frombuffer(blob, np.float32, pos_acc["count"] * 3, vstart).reshape(-1, 3)
            ibv = g["bufferViews"][idx_acc["bufferView"]]
            istart = ibv.get("byteOffset", 0) + idx_acc.get("byteOffset", 0)
            dt = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32}[idx_acc["componentType"]]
            idx = np.frombuffer(blob, dt, idx_acc["count"], istart).reshape(-1, 3).astype(np.int64)
            t = verts[idx]
            keep = t[:, :, 1].min(axis=1) > 0.0  # above-waterline triangles only
            tris.append(t[keep])
    return np.concatenate(tris)


import struct  # noqa: E402


def land_mask(img: Image.Image) -> np.ndarray:
    rgb = np.asarray(img.convert("RGB"), dtype=np.int16)
    r, gch, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return ((r - b) > 18) | ((gch > 90) & (r > 60))


def rasterise(tris, x0, z0, span, w):
    s = w / span
    px = (tris[:, :, 0] - x0) * s
    py = (z0 + span - tris[:, :, 2]) * s
    img = Image.new("L", (w, w), 0)
    dr = ImageDraw.Draw(img)
    for i in range(0, tris.shape[0], 20000):
        chunk = np.stack([px[i:i + 20000], py[i:i + 20000]], axis=-1)
        for poly in chunk:
            dr.polygon([tuple(v) for v in poly], fill=255)
    return np.asarray(img) > 0


from PIL import ImageDraw  # noqa: E402


def blur(m: np.ndarray, radius: float = 7.0) -> np.ndarray:
    img = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(img).astype(np.float64) / 255.0


def correlate_shift(proj: np.ndarray, land_b: np.ndarray):
    """Best (dx, dy) to move PROJ so it overlaps LAND (screen px, y down)."""
    H, W = proj.shape
    PH, PW = 2 * H, 2 * W
    P = np.zeros((PH, PW))
    L = np.zeros((PH, PW))
    P[:H, :W] = proj
    L[:H, :W] = land_b
    fp = np.fft.rfft2(P)
    fl = np.fft.rfft2(L)
    pos = np.fft.irfft2(fp * np.conj(fl), s=(PH, PW))
    neg = np.fft.irfft2(np.conj(fp) * fl, s=(PH, PW))
    i1, j1 = np.unravel_index(np.argmax(pos), pos.shape)
    i2, j2 = np.unravel_index(np.argmax(neg), neg.shape)
    if pos[i1, j1] >= neg[i2, j2]:
        dy = i1 if i1 < H else i1 - PH
        dx = j1 if j1 < W else j1 - PW
        return float(pos[i1, j1]), dx, dy
    dy = -(i2 if i2 < H else i2 - PH)
    dx = -(j2 if j2 < W else j2 - PW)
    return float(neg[i2, j2]), dx, dy


def main() -> int:
    OUT.mkdir(exist_ok=True)
    bounds = json.loads((MAPS / "minimaps.json").read_text(encoding="utf-8"))
    names = sys.argv[1:] or None
    print(f"{'map':26s} {'dx_w':>7s} {'dz_w':>7s} {'cells':>6s} {'peak':>7s} {'base':>7s} {'island_px':>9s}")
    rows = []
    for p in sorted(MAPS.glob("*.glb")):
        sid = p.stem
        if sid not in bounds or (names and sid not in names):
            continue
        png = MAPS / "minimaps" / f"{sid}.png"
        img = Image.open(png)
        w, h = img.size
        land = land_mask(img)
        if land.mean() < 0.005:
            print(f"{sid:26s}   (no land)")
            continue
        land_b = blur(land)
        tris = glb_triangles(p)
        b = bounds[sid]
        span = b["maxX"] - b["minX"]
        proj = rasterise(tris, b["minX"], b["minZ"], span, w)
        base = float((proj & land).sum()) / max(1, proj.sum())
        proj_b = blur(proj)
        peak, dx, dy = correlate_shift(proj_b, land_b)
        world_per_px = span / w
        dx_w = dx * world_per_px
        dy_w = -dy * world_per_px  # screen y-down → world z (north up)
        rows.append((sid, dx_w, dy_w, peak, base, int(proj.sum()), dx, dy, w))
        print(f"{sid:26s} {dx_w:+7.0f} {dy_w:+7.0f} {max(abs(dx), abs(dy)):6d}px {peak:7.2f} {base:7.2f} {int(proj.sum()):9d}")

        # diagnostic overlay: terrain before (red) / after shift (green)
        ov = np.asarray(img.convert("RGB")).copy()
        ys, xs = np.nonzero(proj)
        ov[ys, xs] = (ov[ys, xs] * 0.3 + np.array([255, 60, 60]) * 0.7).astype(np.uint8)
        ys2 = np.clip(ys + dy, 0, h - 1)
        xs2 = np.clip(xs + dx, 0, w - 1)
        ov[ys2, xs2] = (ov[ys2, xs2] * 0.3 + np.array([60, 255, 60]) * 0.7).astype(np.uint8)
        Image.fromarray(ov).save(OUT / f"{sid}.png")

    if rows:
        shifts = [(abs(r[1]), abs(r[2])) for r in rows]
        big = [r for r in rows if max(abs(r[1]), abs(r[2])) > 60]
        print(f"\n{len(big)}/{len(rows)} maps with |shift| > 60 units:",
              ", ".join(f"{r[0]}({r[1]:+.0f},{r[2]:+.0f})" for r in big))
    return 0


if __name__ == "__main__":
    sys.exit(main())
