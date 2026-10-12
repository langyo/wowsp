#!/usr/bin/env python3
"""Bake the Lesta-only ships' 3D models straight from the client geometry.

The finding that makes this work WITHOUT the assets.bin visual layer: the
per-part `.geometry` files in a ship's model directory are already
positioned in SHIP space (Connecticut: MidFront z∈[-7.2, 0.4], MidBack
z∈[-0.1, 7.3] — disjoint halves meeting at the seam), so the hull is the
union of its non-LOD part meshes. The 26.x assets.bin prototype payload
(new recursive serialization, see docs/lesta-assets-bin-format.md) is not
needed for the pack's texture-less holographic bakes.

Turrets are NOT in the ship's model directory — each gun is its own
GameParams entity with a separate model dir, authored in GUN-LOCAL space
(pivot at the traverse axis). Their placement used to live only in the
undecoded visual layer, but the ship's `.splash` file (a plain packaged
file, same as WG) carries named hit-box AABBs in the hull's coordinate
frame, and the GameParams artillery HP blocks reference them by name
(`HitLocationArtillery.splashBoxes: ["CM_SB_gk_1_1"]`). So each main
turret is placed exactly, with the convention measured against WG's own
export-ship output: the gun origin lands at the box's center-x/z and its
TOP on the box's max-y (the box is the barbette volume, the turret sits
on it), barrels yawed toward the bow.

Coverage follows the data: every CA/BB in the Lesta-only set anchors all
its turrets this way; CVs have no artillery (hull-only, as they should
be); DD/sub deck guns have no separate hit boxes at all — they stay out
until the visual layer (assets.bin) is decoded.

Pipeline per ship (the Lesta-only indexes of tech_tree_lesta.json):
  1. ship + gun model dirs from ship_models.json / GameParams;
  2. extract the dirs' .geometry files + the .splash via lesta_extract.py
     (Oodle pkgs);
  3. `wowsunpack export-model --no-vfs` per part (skips lod*/wire/ports
     duplicates and degenerate <10-tri marker meshes);
  4. merge the parts into one GLB (one node per part, named by stem);
  5. `bake_model.py --triangles 15000` decimates into the pack format
     (INDEX-named, exactly how modelLoader resolves GLB stems).

Resume-safe: a current-looking <INDEX>.glb output is skipped — pass
--force when re-baking after a pipeline change (e.g. picking up turrets).

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

LESTA_GAMEPARAMS = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract" / "GameParams_lesta.json"


# ── turret placement (GameParams artillery HP → .splash boxes) ─────────
def parse_splash_boxes(data: bytes) -> dict[str, tuple[list, list]]:
    """`u32 count`, then per box `u32 name_len, name, 6×f32 (min, max)` —
    the same layout wowsunpack's parse_splash_file reads (models/geometry.rs)."""
    pos = 0
    (count,) = struct.unpack_from("<I", data, pos)
    pos += 4
    boxes: dict[str, tuple[list, list]] = {}
    for _ in range(count):
        (nl,) = struct.unpack_from("<I", data, pos)
        pos += 4
        name = data[pos:pos + nl].decode("utf-8")
        pos += nl
        vals = struct.unpack_from("<6f", data, pos)
        pos += 24
        boxes[name] = (list(vals[:3]), list(vals[3:]))
    return boxes


def artillery_anchors(entry: dict, entity_by_id: dict) -> list[dict]:
    """Main-turret placements for one ship: the A_Artillery HP blocks that
    reference a splash box (top level or inside their HitLocationArtillery
    block — the game keeps it in the latter), resolved to the gun entity's
    model path."""
    anchors: list[dict] = []
    artillery = entry.get("A_Artillery") or {}
    for hp, block in artillery.items():
        if not (isinstance(block, dict) and hp.startswith("HP_")):
            continue
        names = block.get("splashBoxes") \
            or (block.get("HitLocationArtillery") or {}).get("splashBoxes") \
            or []
        entity = entity_by_id.get(block.get("id"))
        if not names or not entity:
            continue
        model = entity.get("model") or ""
        if not model.endswith(".model"):
            continue
        anchors.append({
            "hp": hp,
            "box": names[0],
            "model": model,
            "geometry": "/" + model[: -len(".model")] + ".geometry",
        })
    anchors.sort(key=lambda a: a["hp"])
    return anchors


def bow_forward_sign(boxes: dict[str, tuple[list, list]]) -> int:
    """The bow's z direction in the splash frame (+1 or -1): the `bow`-named
    boxes sit toward the bow, `ruder` (rudder) toward the stern."""
    bow = [c[2] for n, (mn, mx) in boxes.items() if "bow" in n.lower()
           for c in [( (mn[0]+mx[0])/2, (mn[1]+mx[1])/2, (mn[2]+mx[2])/2 )]]
    ruder = [c[2] for n, (mn, mx) in boxes.items() if "ruder" in n.lower()
             for c in [( (mn[0]+mx[0])/2, (mn[1]+mx[1])/2, (mn[2]+mx[2])/2 )]]
    if bow and ruder:
        return 1 if sum(bow) / len(bow) > sum(ruder) / len(ruder) else -1
    return 1


# ── GLB vertex transform (rotate + translate a raw export in place) ────
VEC3_FLOAT = 5126


def _transform_accessor(bin_chunk: bytearray, js: dict, ai: int,
                        rot_xz: int, translate: tuple[float, float, float],
                        is_normal: bool) -> None:
    """Transform one VEC3-float accessor in place. rot_xz = +1/-1 flips the
    x/z components (yaw 180° when -1); translate shifts positions."""
    acc = js["accessors"][ai]
    if acc.get("type") != "VEC3" or acc.get("componentType") != VEC3_FLOAT:
        raise ValueError(f"accessor {ai} is not VEC3 float")
    bv = js["bufferViews"][acc["bufferView"]]
    if bv.get("byteStride") not in (None, 12):
        raise ValueError(f"accessor {ai} is interleaved (stride {bv.get('byteStride')})")
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    dx, dy, dz = translate
    lo = [None, None, None]
    hi = [None, None, None]
    for i in range(count):
        o = base + i * 12
        x, y, z = struct.unpack_from("<3f", bin_chunk, o)
        x *= rot_xz
        z *= rot_xz
        if not is_normal:
            x += dx
            y += dy
            z += dz
        struct.pack_into("<3f", bin_chunk, o, x, y, z)
        for c, v in ((0, x), (1, y), (2, z)):
            lo[c] = v if lo[c] is None else min(lo[c], v)
            hi[c] = v if hi[c] is None else max(hi[c], v)
    acc["min"] = lo
    acc["max"] = hi


def place_gun_glb(src: Path, dst: Path, forward_sign: int,
                  box_min: list, box_max: list) -> None:
    """Mount a gun-local GLB onto the ship, per the convention measured
    against WG's own export-ship output (Myoko: every turret mesh bottom
    sits ON its gk box top, and each mesh center rides the gun-bbox bias
    around the box center exactly as the gun origin does):

      - the gun ORIGIN lands at (box_center_x, box_max_y, box_center_z) —
        the box is the barbette hit volume, the turret sits on its top,
        pivoting at its axis;
      - the barrels face the bow. The barrel side is the longer z half of
        the gun's bbox (barrels stick out far past the housing); the game
        authors guns facing -z, ships face their `bow`-named splash boxes,
        so flip 180° when the two disagree.

    (Turrets the game mounts facing aft — e.g. Myoko's No.3 — can't be
    detected without the visual layer; everything faces forward here.)
    """
    js, bins = read_glb(src)
    bins = bytearray(bins or b"")

    def vec3_accessors() -> list[int]:
        out = []
        for i, acc in enumerate(js["accessors"]):
            if acc.get("type") != "VEC3" or acc.get("componentType") != VEC3_FLOAT:
                continue
            bv = js["bufferViews"][acc["bufferView"]]
            if bv.get("byteStride") not in (None, 12):
                raise ValueError(f"accessor {i} is interleaved "
                                 f"(stride {bv.get('byteStride')})")
            out.append(i)
        return out

    accs = vec3_accessors()
    pos = [i for i in accs if _accessor_is_position(js, i)]
    if not pos:
        raise ValueError("no position accessors")

    # Muzzle side from the stored bbox (accessor min/max), before any change.
    lo_z = min(js["accessors"][i]["min"][2] for i in pos
               if js["accessors"][i].get("min") and js["accessors"][i].get("max"))
    hi_z = max(js["accessors"][i]["max"][2] for i in pos
               if js["accessors"][i].get("min") and js["accessors"][i].get("max"))
    muzzle_sign = -1 if -lo_z > hi_z else 1
    rot_xz = muzzle_sign * forward_sign  # +1: already facing the bow

    # Pass 1 — rotate every VEC3 (positions + normals) about the Y axis
    # through the gun origin (the traverse pivot stays the origin).
    for i in accs:
        acc = js["accessors"][i]
        base = js["bufferViews"][acc["bufferView"]].get("byteOffset", 0) \
            + acc.get("byteOffset", 0)
        for vi in range(acc["count"]):
            o = base + vi * 12
            x, y, z = struct.unpack_from("<3f", bins, o)
            struct.pack_into("<3f", bins, o, x * rot_xz, y, z * rot_xz)

    # Pass 2 — translate the origin onto its anchor; refresh min/max.
    translate = ((box_min[0] + box_max[0]) / 2, box_max[1],
                 (box_min[2] + box_max[2]) / 2)
    for i in accs:
        _transform_accessor(bins, js, i, 1,
                            translate if i in pos else (0.0, 0.0, 0.0),
                            is_normal=i not in pos)
    write_glb(js, bytes(bins), dst)


def _accessor_is_position(js: dict, ai: int) -> bool:
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            if prim.get("attributes", {}).get("POSITION") == ai:
                return True
    return False


def write_glb(js: dict, bins: bytes, out: Path) -> None:
    jtxt = json.dumps(js, separators=(",", ":")).encode()
    padj = (4 - len(jtxt) % 4) % 4
    padb = (4 - len(bins) % 4) % 4
    total = 12 + 8 + len(jtxt) + padj + 8 + len(bins) + padb
    out.write_bytes(
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(jtxt) + padj, 0x4E4F534A) + jtxt + b" " * padj
        + struct.pack("<II", len(bins) + padb, 0x004E4942) + bins + b"\0" * padb
    )


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
    ap.add_argument("--gameparams", type=Path, default=LESTA_GAMEPARAMS,
                    help="decoded Lesta GameParams.json (turret anchors; "
                    "hull-only bakes when absent)")
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

    entity_by_id: dict[int, dict] = {}
    entry_by_index: dict[str, dict] = {}
    if args.gameparams.is_file():
        from build_techtree import _params_root  # noqa: E402

        dump = _params_root(json.loads(args.gameparams.read_text(encoding="utf-8")))
        for e in dump.values():
            if not isinstance(e, dict):
                continue
            if isinstance(e.get("id"), int):
                entity_by_id.setdefault(e["id"], e)
            if isinstance(e.get("index"), str):
                entry_by_index.setdefault(e["index"], e)
    else:
        print(f"[bake-lesta] NOTE {args.gameparams} missing — hull-only bakes "
              "(no turret anchors).", flush=True)

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

        # Turret anchors: artillery HP blocks → splash boxes → gun models.
        anchors: list[dict] = []
        splash_path = ""
        entry = entry_by_index.get(idx)
        if entry:
            anchors = artillery_anchors(entry, entity_by_id)
            splash_path = f"/{base}/" + base.rsplit("/", 1)[-1] + ".splash"
            if not any(e["path"] == splash_path for e in meta):
                splash_path = ""
        extra: list[str] = [a["geometry"].lstrip("/") for a in anchors]
        if splash_path:
            extra.append(splash_path.lstrip("/"))
        if anchors and not splash_path:
            print(f"[bake-lesta] WARN {idx}: no .splash in the ship dir — hull-only.", flush=True)
            anchors = []
            extra = []

        rc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
             "--game-dir", args.game_dir, "--out", str(args.stage),
             "--wowsunpack", wowsunpack]
            + (["--ooz", args.ooz] if args.ooz else []) + keep + extra,
            capture_output=True, text=True,
        )
        if rc.returncode != 0:
            # lesta_extract reports per-file failures on stdout.
            print(f"[bake-lesta] extract failed for {idx}: "
                  f"{(rc.stderr or rc.stdout or '')[-300:]}", flush=True)
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

        # Place the turrets: hull-only if the splash data is missing or a
        # box name does not resolve (a warning, not a bake failure).
        if anchors:
            try:
                boxes = parse_splash_boxes(
                    (Path(args.stage) / splash_path.lstrip("/")).read_bytes())
            except (ValueError, struct.error) as e:
                print(f"[bake-lesta] WARN {idx}: unreadable .splash ({e}) — hull-only",
                      flush=True)
                boxes = None
            forward = bow_forward_sign(boxes) if boxes else 1
            for a in anchors:
                box = boxes.get(a["box"]) if boxes else None
                gun_src = Path(args.stage) / a["geometry"].lstrip("/")
                if box is None or not gun_src.is_file():
                    print(f"[bake-lesta] WARN {idx}: turret {a['hp']} skipped "
                          f"(box {a['box']} or geometry missing)", flush=True)
                    continue
                mn, mx = box
                raw = raw_dir / f"{idx}__gun_{a['hp']}.glb"
                if not raw.is_file() or args.force:
                    r = subprocess.run(
                        [wowsunpack, "export-model", str(gun_src), "--no-vfs", "-o", str(raw)],
                        capture_output=True, text=True,
                    )
                    if r.returncode != 0 or not raw.is_file():
                        print(f"[bake-lesta] WARN {idx}: turret {a['hp']} export failed",
                              flush=True)
                        continue
                placed = raw_dir / f"{idx}__gun_{a['hp']}_placed.glb"
                try:
                    place_gun_glb(raw, placed, forward, mn, mx)
                except (ValueError, KeyError, struct.error) as e:
                    print(f"[bake-lesta] WARN {idx}: turret {a['hp']} place failed: {e}",
                          flush=True)
                    continue
                if tri_count(placed) >= 10:
                    parts.append((f"{a['hp']}_turret", placed))

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
        turrets = sum(1 for name, _ in parts if name.endswith("_turret"))
        print(f"[bake-lesta] {idx}: {len(parts)} parts ({turrets} turrets) -> {target.name} "
              f"({tri_count(target):,} tris)", flush=True)
        merged.unlink(missing_ok=True)
        if args.limit and baked >= args.limit:
            break
    print(f"[bake-lesta] done: {baked} baked, {skipped} current, {failed} failed -> {args.out}")
    return 1 if failed and not baked else 0


if __name__ == "__main__":
    raise SystemExit(main())
