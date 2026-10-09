#!/usr/bin/env python3
"""Bake the Lesta-only ships' 3D models straight from the client geometry.

The finding that makes this work WITHOUT the assets.bin visual layer: the
per-part `.geometry` files in a ship's model directory are already
positioned in SHIP space (Connecticut: MidFront z∈[-7.2, 0.4], MidBack
z∈[-0.1, 7.3] — disjoint halves meeting at the seam), so the hull is the
union of its non-LOD part meshes. The 26.x assets.bin prototype payload
(new recursive serialization, see docs/lesta-assets-bin-format.md) is not
needed for the pack's texture-less holographic bakes.

Pipeline per ship (the Lesta-only indexes of tech_tree_lesta.json):
  1. model dir from ship_models.json hullModel;
  2. extract the dir's .geometry files via lesta_extract.py (Oodle pkgs);
  3. `wowsunpack export-model --no-vfs` per part (skips lod*/wire/ports
     duplicates and degenerate <10-tri marker meshes);
  4. merge the parts into one GLB (one node per part, named by stem);
  5. `bake_model.py --triangles 15000` decimates into the pack format
     (INDEX-named, exactly how modelLoader resolves GLB stems).

Resume-safe: a current-looking <INDEX>.glb output is skipped.

Usage:
    python scripts/model_convert/bake_lesta_ships.py \
        --game-dir "D:/WoWS_Korabli" \
        --stage "C:/lesta-work/stage" --ooz "C:/ooz/ooz.exe"
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "extract"))

import batch_bake  # noqa: E402  (SHIPS_OUT, looks_current)

SHIPS_OUT = batch_bake.SHIPS_OUT
WG_TREE = REPO_ROOT / "packages/webui/src/data/tech_tree.json"
LESTA_TREE = REPO_ROOT / "packages/webui/src/data/tech_tree_lesta.json"
SHIP_MODELS = REPO_ROOT / "packages/webui/src/data/ship_models.json"
LESTA_META = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract" / "wows_meta_lesta.json"

# Part-file suffix conventions that duplicate or embellish the hull mesh.
PART_EXCLUDE = ("lod", "wire", "ports", "skinned")


# ── GLB helpers ────────────────────────────────────────────────────────
def read_glb(path: Path):
    d = path.read_bytes()
    magic, _, length = struct.unpack_from("<III", d, 0)
    assert magic == 0x46546C67, f"not a GLB: {path}"
    off = 12
    js = bins = None
    while off < length:
        clen, ctype = struct.unpack_from("<II", d, off)
        if ctype == 0x4E4F534A:
            js = json.loads(d[off + 8:off + 8 + clen].rstrip(b" "))
        elif ctype == 0x004E4942:
            bins = d[off + 8:off + 8 + clen]
        off += 8 + clen
    return js, bins


def tri_count(glb: Path) -> int:
    js, _ = read_glb(glb)
    tris = 0
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            ii = prim.get("indices")
            if ii is not None:
                tris += js["accessors"][ii]["count"] // 3
            else:
                tris += js["accessors"][prim["attributes"]["POSITION"]]["count"] // 3
    return tris


def merge_glbs(parts: list[tuple[str, Path]], out: Path) -> None:
    """Concatenate part GLBs into one scene: one named node per part mesh,
    accessors/bufferViews rebased onto a single binary buffer."""
    bin_chunks: list[bytes] = []
    accessors: list[dict] = []
    buffer_views: list[dict] = []
    meshes: list[dict] = []
    nodes: list[dict] = []
    for name, path in parts:
        src, sbin = read_glb(path)
        src_bvs = src.get("bufferViews", [])
        src_accs = src.get("accessors", [])
        base_bin = sum(len(c) for c in bin_chunks)
        base_bv = len(buffer_views)
        base_acc = len(accessors)
        for bv in src_bvs:
            nv = dict(bv)
            nv["buffer"] = 0
            nv["byteOffset"] = bv.get("byteOffset", 0) + base_bin
            buffer_views.append(nv)
        for acc in src_accs:
            nacc = dict(acc)
            nacc["bufferView"] = acc["bufferView"] + base_bv
            accessors.append(nacc)
        for mesh in src.get("meshes", []):
            nm = dict(mesh)
            nm["primitives"] = [
                {**prim, "attributes": dict(prim["attributes"]),
                 "indices": prim["indices"] + base_acc if prim.get("indices") is not None else None}
                if prim.get("indices") is not None else {**prim, "attributes": dict(prim["attributes"])}
                for prim in mesh.get("primitives", [])
            ]
            # rebase attribute indices too
            for prim in nm["primitives"]:
                for k in list(prim["attributes"]):
                    prim["attributes"][k] = prim["attributes"][k] + base_acc
            meshes.append(nm)
            nodes.append({"mesh": len(meshes) - 1, "name": name})
        bin_chunks.append(sbin)
    js = {
        "asset": {"version": "2.0", "generator": "wowsp-lesta-merge"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": sum(len(c) for c in bin_chunks)}],
    }
    blob = b"".join(bin_chunks)
    jtxt = json.dumps(js, separators=(",", ":")).encode()
    padj = (4 - len(jtxt) % 4) % 4
    padb = (4 - len(blob) % 4) % 4
    total = 12 + 8 + len(jtxt) + padj + 8 + len(blob) + padb
    out.write_bytes(
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(jtxt) + padj, 0x4E4F534A) + jtxt + b" " * padj
        + struct.pack("<II", len(blob) + padb, 0x004E4942) + blob + b"\0" * padb
    )


# ── pipeline ───────────────────────────────────────────────────────────
def find_wowsunpack(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    for cand in (
        REPO_ROOT / "target/release/wowsunpack.exe",
        REPO_ROOT.parent / "wowsp/target/release/wowsunpack.exe",
    ):
        if cand.is_file():
            return str(cand)
    import shutil
    return shutil.which("wowsunpack") or shutil.which("wowsunpack.exe")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", required=True, help="Lesta client install root")
    ap.add_argument("--stage", required=True, help="extraction dir (content/ tree + raw glbs)")
    ap.add_argument("--ooz", default=None, help="ooz decoder for lesta_extract")
    ap.add_argument("--wowsunpack", default=None)
    ap.add_argument("--out", type=Path, default=SHIPS_OUT)
    ap.add_argument("--triangles", type=int, default=15000)
    ap.add_argument("--only", help="comma list of tree indexes")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    wowsunpack = find_wowsunpack(args.wowsunpack)
    if not wowsunpack:
        print("error: wowsunpack not found (build it: just build wowsunpack).", file=sys.stderr)
        return 1
    if not LESTA_META.is_file():
        print(f"error: {LESTA_META} missing — run lesta_extract.py once to generate it.",
              file=sys.stderr)
        return 1

    # Scope: Lesta-only tree ships; model dirs from ship_models.json.
    wg_idx = {n["index"] for n in json.loads(WG_TREE.read_text(encoding="utf-8")).values()}
    lesta = json.loads(LESTA_TREE.read_text(encoding="utf-8"))
    only = set(filter(None, (args.only or "").split(",")))
    indexes = sorted(
        {n["index"] for n in lesta.values() if n["index"] not in wg_idx and (not only or n["index"] in only)}
    )
    models = json.loads(SHIP_MODELS.read_text(encoding="utf-8"))
    dir_by_index: dict[str, str] = {}
    for m in models.values():
        idx = m.get("index")
        hm = m.get("hullModel")
        if idx and hm and hm.startswith("content/"):
            seg = [p for p in hm.split("/") if p]
            if len(seg) >= 2:
                dir_by_index.setdefault(idx, "/".join(seg[:-1]))
    meta = json.loads(LESTA_META.read_text(encoding="utf-8"))

    args.out.mkdir(parents=True, exist_ok=True)
    raw_dir = Path(args.stage) / "rawglb"
    raw_dir.mkdir(parents=True, exist_ok=True)
    baked = skipped = failed = 0
    for idx in indexes:
        target = args.out / f"{idx}.glb"
        if not args.force and target.is_file() and batch_bake.looks_current(target, 3000):
            skipped += 1
            continue
        base = dir_by_index.get(idx)
        if not base:
            print(f"[bake-lesta] WARN {idx}: no model dir in ship_models.json", flush=True)
            failed += 1
            continue
        geoms = sorted(
            e["path"].lstrip("/")
            for e in meta
            if not e.get("is_directory") and e["path"].startswith(f"/{base}/") and e["path"].endswith(".geometry")
        )
        keep = [g for g in geoms if not any(x in Path(g).stem.lower() for x in PART_EXCLUDE)]
        if not keep:
            print(f"[bake-lesta] WARN {idx}: no geometry files under {base}", flush=True)
            failed += 1
            continue
        rc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
             "--game-dir", args.game_dir, "--out", str(args.stage),
             "--wowsunpack", wowsunpack]
            + (["--ooz", args.ooz] if args.ooz else []) + keep,
            capture_output=True, text=True,
        )
        if rc.returncode != 0:
            print(f"[bake-lesta] extract failed for {idx}: {rc.stderr[-200:]}", flush=True)
            failed += 1
            continue
        parts: list[tuple[str, Path]] = []
        for g in keep:
            p = Path(args.stage) / g
            if not p.is_file():
                continue
            stem = Path(g).stem
            out = raw_dir / f"{idx}__{stem}.glb"
            if not out.is_file() or args.force:
                r = subprocess.run(
                    [wowsunpack, "export-model", str(p), "--no-vfs", "-o", str(out)],
                    capture_output=True, text=True,
                )
                if r.returncode != 0 or not out.is_file():
                    continue
            if tri_count(out) >= 10:
                parts.append((stem, out))
        if not parts:
            print(f"[bake-lesta] WARN {idx}: all parts degenerate", flush=True)
            failed += 1
            continue
        merged = raw_dir / f"{idx}__merged.glb"
        merge_glbs(parts, merged)
        rc = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "bake_model.py"), str(merged),
             "-o", str(target), "--triangles", str(args.triangles)],
            capture_output=True, text=True,
        )
        if rc.returncode != 0 or not target.is_file():
            print(f"[bake-lesta] bake failed for {idx}: {rc.stderr[-200:]}", flush=True)
            failed += 1
            continue
        baked += 1
        print(f"[bake-lesta] {idx}: {len(parts)} parts -> {target.name} ({tri_count(target):,} tris)", flush=True)
        merged.unlink(missing_ok=True)
        if args.limit and baked >= args.limit:
            break
    print(f"[bake-lesta] done: {baked} baked, {skipped} current, {failed} failed -> {args.out}")
    return 1 if failed and not baked else 0


if __name__ == "__main__":
    raise SystemExit(main())
