#!/usr/bin/env python3
"""Bake the Lesta-only ships' 3D models straight from the client geometry.

The hull comes from the per-part `.geometry` files in the ship's model
directory — they are already positioned in SHIP space (Connecticut:
MidFront z∈[-7.2, 0.4], MidBack z∈[-0.1, 7.3] — disjoint halves meeting
at the seam), so the hull is the union of its non-LOD part meshes.

Every gun (main / secondary / AA) is its own GameParams entity with a
separate model dir, authored in GUN-LOCAL space. Their placement comes
from BOTH of these client sources, cross-validating each other:

  - the ship's `.splash` file carries named hit-box AABBs referenced by
    the GameParams artillery HP blocks (`CM_SB_gk_1_1`). Main turrets
    anchor at (box_center_x, box_max_y, -box_center_z) — the splash
    frame is z-mirrored vs the hull geometry frame (bow at -z in the
    geometry, +z in splash), calibrated against WG's own export-ship
    output for hulls both clients share (every pivot to 3 decimals).
  - assets.bin's node-tree blocks (phase 6 of
    docs/lesta-assets-bin-format.md): per ship PART, WG-shaped OOL
    blocks in blob1 carrying every hardpoint's full ROW-major matrix
    in the splash frame — mains, secondaries (`HP_*GS_*`), AA
    (`HP_*GA_*`), catapults. Blocks are attributed per ship by
    content: a block's HP-name set must be a subset of the ship's
    GameParams HP names, anchored by exact (y, z) agreement of its
    `HP_*GM_*` translations with the splash gk boxes; turret-less part
    blocks additionally need storage adjacency to an anchored block.
    Nothing in the file references blocks by offset, so content
    matching is the only attribution path — and it is exact.

With a block attributed, every gun mounts at its node matrix (true
per-mount rotation — side secondaries face outboard, aft mains face
aft); the splash anchor remains the fallback for mains when a ship has
no matched block, with facing inferred from position (aft of the
splash midpoint faces the stern).

Triangle economy: each unique gun MODEL is pre-decimated once via
bake_model (mains 1500 / secondaries 400 / AA 150 tris, cached under
<stage>/rawglb/gunlo) before per-mount placement, so a 67-mount AA
suite costs ~10k tris instead of its raw ~50k; the final whole-ship
bake_model pass then budgets by category as for the WG bakes.

Pipeline per ship (the Lesta-only indexes of tech_tree_lesta.json):
  1. ship + gun model dirs from ship_models.json / GameParams;
  2. extract the dirs' .geometry files + the .splash (+ content/
     assets.bin once per stage) via lesta_extract.py (Oodle pkgs);
  3. `wowsunpack export-model --no-vfs` per part (skips lod*/wire/ports
     duplicates and degenerate <10-tri marker meshes);
  4. merge the parts into one GLB (one node per part, named by stem —
     gun parts are named `<GUN_STEM>_<HP>` so bake_model classifies
     them main_battery / secondary_battery / aa_mount per instance);
  5. `bake_model.py --triangles 15000` decimates into the pack format
     (INDEX-named, exactly how modelLoader resolves GLB stems).

Resume-safe: a current-looking <INDEX>.glb output is skipped — pass
--force when re-baking after a pipeline change (e.g. picking up
secondaries).

Usage:
    python scripts/model_convert/bake_lesta_ships.py \
        --game-dir "D:/WoWS_Korabli" \
        --stage "C:/lesta-work/stage" --ooz "C:/ooz/ooz.exe"
"""
from __future__ import annotations

import argparse
import json
import os
import re
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
WG_GAMEPARAMS = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract" / "GameParams.json"


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


def splash_bow_sign(boxes: dict[str, tuple[list, list]]) -> int:
    """The bow's z direction in the SPLASH frame (+1 or -1): the `bow`-named
    boxes sit toward the bow, `stern`/`ruder` (rudder) toward the stern.
    Every Lesta splash seen so far is bow-at-+z (mirrored vs the hull
    geometry frame); this keeps the mapping data-driven per ship."""
    def centers(sub: str) -> list[float]:
        return [(mn[2] + mx[2]) / 2 for n, (mn, mx) in boxes.items()
                if sub in n.lower()]
    bow = centers("bow")
    for aft in ("stern", "rudder", "ruder"):
        other = centers(aft)
        if bow and other:
            return 1 if sum(bow) / len(bow) > sum(other) / len(other) else -1
    return 1


# ── assets.bin node blocks (phase 6) ───────────────────────────────────
# A gun hardpoint node: HP_<nation>G<M|S|A>_<n> — mains (GM), secondaries
# (GS), AA (GA). Compound names (HP_AGM_2_HP_AGA_4 — AA riding a turret
# top) have no node of their own and stay unmounted.
GUN_HP_RE = re.compile(r"^HP_[A-Z]G[MSA]_\d+$")
MAIN_HP_RE = re.compile(r"^HP_[A-Z]GM_\d+$")
# Per-class pre-decimation budgets for a unique gun model (whole-ship
# bake_model pass then allocates category shares on top; these caps keep
# a 60+-mount AA suite from flooding the raw merge).
GUN_TRI_CAP = {"main": 1500, "secondary": 400, "aa": 150}


def load_node_blocks(stage: Path, game_dir: str, ooz: str | None,
                     wowsunpack: str) -> list[dict] | None:
    """HP-node digest of every assets.bin node block, cached under the
    stage. Each entry: {off, mounts: {HP_name: 16 row-major floats}} for
    blocks carrying at least one gun hardpoint. Returns None when the
    file can't be extracted or parsed (the bake falls back to splash
    anchoring, hull+main-turrets only).

    Two complementary harvesters, merged and content-deduped: the
    structure scan (names-run + following matrices — finds OOL arrays
    wherever they sit) and the legacy record walk (blob1's 0x70-stride
    headers with their five relptrs — authoritative for arrays the scan
    misses, e.g. parts whose names don't start with `Scene Root`)."""
    assets = Path(stage) / "content" / "assets.bin"
    cache = Path(stage) / "lesta_node_blocks_v2.json"
    if cache.is_file():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    if not assets.is_file():
        rc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
             "--game-dir", game_dir, "--out", str(stage), "--wowsunpack", wowsunpack]
            + (["--ooz", ooz] if ooz else []) + ["content/assets.bin"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if rc.returncode != 0 or not assets.is_file():
            print(f"[bake-lesta] WARN: assets.bin unavailable — "
                  f"no secondary/AA mounts ({(rc.stderr or '')[-160:]})", flush=True)
            return None
    from lesta_assetsbin_probe import Bin, scan_node_blocks

    print("[bake-lesta] scanning assets.bin node blocks (once per stage) ...",
          flush=True)
    b = Bin(assets)
    b.sections()
    out = []

    def _mounts(names: list[str], matrices: list[tuple]) -> dict:
        return {name: list(matrices[i]) for i, name in enumerate(names)
                if name and GUN_HP_RE.match(name)}

    for blk in scan_node_blocks(b):
        mounts = _mounts(blk["names"], blk["matrices"])
        if mounts:
            out.append({"off": blk["names_off"], "mounts": mounts})

    # Legacy record walk: blob1's fixed 0x70 headers. The relptrs land on
    # the same five arrays the scan hunts, but records whose names array
    # lacks a `Scene Root` anchor (or sits inside another record's OOL
    # tail) escape the scan entirely — this walk finds them by header.
    base1, size1 = b.dbs[1][:2]
    rec_count = min(b.u64(base1), (size1 - 0x10) // 0x70)
    seen = {tuple(sorted((k, tuple(m)) for k, m in blk["mounts"].items()))
            for blk in out}
    rec_found = 0
    for rec in range(rec_count):
        off = 0x10 + rec * 0x70
        addr = base1 + off
        nc = b.u32(addr)
        if not (4 <= nc <= 4000):
            continue
        rels = struct.unpack_from("<5q", b.data, addr + 8)
        if not all(0 < r < size1 - off for r in rels):
            continue
        a_names, a_mats = addr + rels[2], addr + rels[3]
        try:
            names = [b.get_string_by_id(b.u32(a_names + i * 4)) for i in range(nc)]
            m0 = struct.unpack_from("<16f", b.data, a_mats)
        except struct.error:
            continue
        if any(n is None for n in names):
            continue
        if abs(m0[15] - 1) > 1e-3 or abs(m0[3]) > 1e-3:
            continue
        mounts = {}
        for i, name in enumerate(names):
            if name and GUN_HP_RE.match(name):
                mounts[name] = list(struct.unpack_from("<16f", b.data, a_mats + i * 64))
        if not mounts:
            continue
        sig = tuple(sorted((k, tuple(m)) for k, m in mounts.items()))
        if sig in seen:
            continue
        seen.add(sig)
        out.append({"off": off, "mounts": mounts})
        rec_found += 1
    try:
        cache.write_text(json.dumps(out), encoding="utf-8")
    except OSError:
        pass
    print(f"[bake-lesta] node blocks with gun mounts: {len(out):,} "
          f"(+{rec_found} from legacy record walk)", flush=True)
    return out


def gun_hp_entities(entry: dict, entity_by_id: dict) -> dict[str, dict]:
    """HP name → gun entity placement info for every armament section
    (mains, secondaries, AA). Compound names (turret-top sub-mounts) and
    blocks without a resolvable model are skipped."""
    out: dict[str, dict] = {}
    for section, cls in (("A_Artillery", "main"), ("A_ATBA", "secondary"),
                         ("A_AirDefense", "aa")):
        for hp, block in (entry.get(section) or {}).items():
            if not (isinstance(block, dict) and GUN_HP_RE.match(hp)):
                continue
            entity = entity_by_id.get(block.get("id"))
            model = (entity or {}).get("model") or ""
            if not model.endswith(".model"):
                continue
            out[hp] = {
                "cls": cls,
                "model": model,
                "geometry": "/" + model[: -len(".model")] + ".geometry",
                "stem": model.rsplit("/", 1)[-1][: -len(".model")],
            }
    return out


def ship_mount_blocks(blk_digest: list[dict], spec: dict) -> list[dict]:
    """This ship's node blocks out of the global digest. A block matches
    when it carries main turrets, every main that has a splash box
    agrees with the ship's gk boxes (dy 0.05 / dz 0.04 — the strong
    signal, wrong-family blocks differ by >=0.1; unboxed extra mains are
    revision drift and filter out at mount time), and its gun names
    overlap the ship's set by 90%. Sister hulls
    with identical turret geometry may share a block — harmless, their
    mount layouts coincide and twin mounts dedupe by proximity in
    collect_mounts."""
    def compatible(names: set, mounts: dict) -> bool:
        mains_c = {n for n in names if MAIN_HP_RE.match(n)}
        if not mains_c:
            return False
        # Positional evidence is mandatory: at least one main must have a
        # splash box to anchor the block (ships whose mains lack boxes
        # would otherwise accept every same-nation block). Extra mains
        # WITHOUT boxes are allowed — visual-revision drift (a removed or
        # renumbered turret) — and are filtered out at mount time since
        # they carry no GameParams entity; boxed mains stay the gate.
        boxed = [n for n in mains_c if spec["agm_boxes"].get(n)]
        if not boxed:
            return False
        # A block may carry a few gun nodes the GameParams revision lacks
        # (or vice versa), but the overlap must be near-total — a
        # same-class sister's block (shared turret geometry, different AA
        # revision) falls out here.
        if len(names & spec["gp_names"]) < 0.9 * len(names):
            return False
        for n in boxed:
            exp = spec["agm_boxes"][n]
            m = mounts[n]
            # dz 0.04: same-family blocks measured ≥0.1 apart, while
            # revision drift between a ship's own visual and splash runs
            # up to ~0.04 on some hulls (PASB520's anchors).
            if abs(m[13] - exp[0]) > 0.05 or abs(m[14] - exp[1]) > 0.04:
                return False
        return True

    tight = [blk for blk in blk_digest
             if compatible(set(blk["mounts"]), blk["mounts"])]
    if not tight:
        return []
    # Parts with no main turrets (pure secondary/AA midship parts) carry
    # no positional evidence of their own. Admit the ones that bring at
    # least one still-uncovered name and that are stored next to a tight
    # block of this ship — a sister's pure-AA part sits next to the
    # sister's tight parts, not ours. Names shared with admitted blocks
    # are fine: collect_mounts keeps the tight block's position first and
    # dedupes (or suffix-drops) the overlap.
    covered = set().union(*(set(b["mounts"]) for b in tight))
    anchor_offs = [b["off"] for b in tight]
    spare = [blk for blk in blk_digest
             if not any(MAIN_HP_RE.match(n) for n in blk["mounts"])
             and set(blk["mounts"]) <= spec["gp_names"]
             and set(blk["mounts"]) - covered]
    spare.sort(key=lambda b: min(abs(b["off"] - o) for o in anchor_offs))
    for blk in spare:
        if min(abs(blk["off"] - o) for o in anchor_offs) > 1024 * 1024:
            break
        if not set(blk["mounts"]) - covered:
            continue
        tight.append(blk)
        covered |= set(blk["mounts"])
    return tight


def collect_mounts(matched: list[dict], hull_bounds: tuple[list, list],
                   idx: str) -> dict[str, tuple[str, list[float]]]:
    """Unique mount name → (base HP name, block matrix) across the ship's
    blocks, deduped (twin blocks repeat content) and bounds-checked
    against the hull's splash bbox (attribution safety: a wrong-ship
    block would plant mounts in the air or off-hull). Same-HP collisions
    from different blocks keep both, suffixed x2, x3…"""
    (hx0, hy0, hz0), (hx1, hy1, hz1) = hull_bounds
    margin = 0.5   # x/y; z gets extra headroom below — AA sponsons on the
    margin_z = 0.8  # extreme bow/stern sit past the splash-box extent
    out: dict[str, tuple[str, list[float]]] = {}
    dups = 0
    for blk in matched:
        for base, m in blk["mounts"].items():
            x, y, z = m[12], m[13], m[14]
            if not (hx0 - margin <= x <= hx1 + margin
                    and hy0 - margin <= y <= hy1 + 2.5
                    and hz0 - margin_z <= z <= hz1 + margin_z):
                dups += 1
                continue
            # A DIFFERENT-named mount at the same spot is a visual
            # revision twin: the reworked block renames/re-models the gun
            # (e.g. an open 25mm becoming a shielded triple at the same
            # pivot) while GameParams lists both HP names. First-collected
            # (tight blocks come before spares) wins. The same-CLASS radius
            # is 0.15 — two mounts of one class physically cannot share a
            # pivot (the fleet-wide pair histogram is empty between 0.05
            # and 0.15 per-axis and dense above it; revision twins land
            # 0.05-0.15 apart when generations nudge the pivot), while
            # different classes keep the tight 0.05 (a secondary genuinely
            # abuts a director-sized AA mount more closely).
            hit = False
            for k2, (base2, hm) in out.items():
                if k2 != base2:
                    continue  # suffixed provisional entries are no anchors
                # 'G?' letter (M/S/A) carries the class; names are
                # GUN_HP_RE-filtered so [3:6] is always nation+G+class.
                r = 0.15 if base[4:6] == k2[4:6] else 0.05
                if (abs(hm[12] - x) <= r and abs(hm[13] - y) <= r
                        and abs(hm[14] - z) <= r):
                    hit = True
                    break
            if hit:
                dups += 1
                continue
            name = base
            sfx = 1
            while name in out:
                sfx += 1
                name = f"{base}x{sfx}"
            out[name] = (base, m)
    if dups:
        print(f"[bake-lesta]   {idx}: {dups} mounts skipped (out of hull "
              f"bounds — attribution guard)", flush=True)
    return out


def decimate_gun_glb(src: Path, dst: Path, cap: int) -> None:
    """Pre-decimate one gun model to a triangle cap as a single POSITION+
    indices mesh. bake_model's CLI path is unusable here — its whole-ship
    budget floor (`max(triangles, 6000)`) returns small guns untouched —
    so this drives bake_model.decimate() directly on the vertex soup."""
    import bake_model  # noqa: PLC0415  (module-level import would drag numpy into every run)

    js, bins = read_glb(src)
    bins = bins or b""
    verts: list[float] = []
    idx: list[int] = []
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            ai = prim.get("attributes", {}).get("POSITION")
            ii = prim.get("indices")
            if ai is None:
                continue
            acc = js["accessors"][ai]
            bv = js["bufferViews"][acc["bufferView"]]
            if bv.get("byteStride") not in (None, 12):
                raise ValueError("interleaved POSITION accessor")
            base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            off = len(verts) // 3
            for vi in range(acc["count"]):
                verts.extend(struct.unpack_from("<3f", bins, base + vi * 12))
            if ii is None:
                idx.extend(range(off, off + acc["count"]))
                continue
            iacc = js["accessors"][ii]
            ibv = js["bufferViews"][iacc["bufferView"]]
            ibase = ibv.get("byteOffset", 0) + iacc.get("byteOffset", 0)
            fmt, sz = {5123: ("<H", 2), 5125: ("<I", 4)}[iacc.get("componentType")]
            for k in range(iacc["count"]):
                (v,) = struct.unpack_from(fmt, bins, ibase + k * sz)
                idx.append(off + v)
    if not verts:
        raise ValueError("no geometry")
    dv, di = bake_model.decimate(verts, idx, cap)
    pos = struct.pack(f"<{len(dv)}f", *dv)
    index = struct.pack(f"<{len(di)}{'H' if max(di) < 65536 else 'I'}", *di)
    jtxt = json.dumps({
        "asset": {"version": "2.0", "generator": "wowsp-lesta-gunlo"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": dst.stem}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "accessors": [
            {"bufferView": 0, "componentType": VEC3_FLOAT, "count": len(dv) // 3,
             "type": "VEC3",
             "min": [min(dv[i::3]) for i in range(3)],
             "max": [max(dv[i::3]) for i in range(3)]},
            {"bufferView": 1,
             "componentType": 5123 if max(di) < 65536 else 5125,
             "count": len(di), "type": "SCALAR",
             "min": [min(di)], "max": [max(di)]},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos)},
            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(index)},
        ],
        "buffers": [{"byteLength": len(pos) + len(index)}],
    }, separators=(",", ":")).encode()
    padj = (4 - len(jtxt) % 4) % 4
    binb = pos + index
    padb = (4 - len(binb) % 4) % 4
    total = 12 + 8 + len(jtxt) + padj + 8 + len(binb) + padb
    dst.write_bytes(
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(jtxt) + padj, 0x4E4F534A) + jtxt + b" " * padj
        + struct.pack("<II", len(binb) + padb, 0x004E4942) + binb + b"\0" * padb
    )


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


def place_gun_glb(src: Path, dst: Path, face_z: int, box_min: list,
                  box_max: list, z_sign: int) -> None:
    """Mount a gun-local GLB onto the ship, per the convention calibrated
    against WG's own export-ship output for shared hulls (Montana et al.:
    every pivot reproduced to three decimals):

      - the gun ORIGIN lands at (box_center_x, box_max_y, z_sign*box_center_z)
        — the splash frame is z-mirrored vs the hull geometry frame, so the
        box's z carries the mirror sign; the box is the barbette hit volume
        and the turret sits on its top, pivoting at its axis;
      - the barrels point at face_z in the hull frame (-1 = bow, +1 =
        stern). The barrel side is the longer z half of the gun's bbox
        (barrels stick out far past the housing); yaw 180° when the two
        disagree.

    (WG's visual layer authors per-turret yaw — Myoko-style exceptions to
    the position rule can't be detected; the caller decides BOW/STERN.)
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
    rot_xz = muzzle_sign * face_z  # +1: muzzles already point at face_z

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
                 z_sign * (box_min[2] + box_max[2]) / 2)
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


def place_gun_matrix_glb(src: Path, dst: Path, m16: list[float]) -> None:
    """Mount a gun-local GLB with a full node matrix from an assets.bin
    node block. The block matrix is ROW-major with the translation in
    elements 12-14, expressed in the SPLASH frame (+z = bow); the hull
    geometry frame is z-mirrored, so the transform is conjugated by
    diag(1,1,-1): rotation entries touching the z axis exactly once
    flip sign, and so does the z translation. Vertices (row-vector
    convention, p' = p·M): x' = m0x+m4y+m8z+tx etc.; normals rotate the
    same way without translation (pure rotation, unit length kept)."""
    # hull-frame entries: h[i][j] = s_i * s_j * m[i][j], s = (1, 1, -1)
    m = m16
    r = (m[0], m[4], -m[8],
         m[1], m[5], -m[9],
         -m[2], -m[6], m[10])
    t = (m[12], m[13], -m[14])
    js, bins = read_glb(src)
    bins = bytearray(bins or b"")
    accs = []
    for i, acc in enumerate(js["accessors"]):
        if acc.get("type") != "VEC3" or acc.get("componentType") != VEC3_FLOAT:
            continue
        bv = js["bufferViews"][acc["bufferView"]]
        if bv.get("byteStride") not in (None, 12):
            raise ValueError(f"accessor {i} is interleaved "
                             f"(stride {bv.get('byteStride')})")
        accs.append(i)
    pos = {i for i in accs if _accessor_is_position(js, i)}
    for i in accs:
        acc = js["accessors"][i]
        base = js["bufferViews"][acc["bufferView"]].get("byteOffset", 0) \
            + acc.get("byteOffset", 0)
        is_pos = i in pos
        lo = [None, None, None]
        hi = [None, None, None]
        for vi in range(acc["count"]):
            o = base + vi * 12
            x, y, z = struct.unpack_from("<3f", bins, o)
            nx = r[0] * x + r[1] * y + r[2] * z
            ny = r[3] * x + r[4] * y + r[5] * z
            nz = r[6] * x + r[7] * y + r[8] * z
            if is_pos:
                nx += t[0]
                ny += t[1]
                nz += t[2]
            struct.pack_into("<3f", bins, o, nx, ny, nz)
            if is_pos:
                for c, v in ((0, nx), (1, ny), (2, nz)):
                    lo[c] = v if lo[c] is None else min(lo[c], v)
                    hi[c] = v if hi[c] is None else max(hi[c], v)
        if is_pos:
            acc["min"] = lo
            acc["max"] = hi
    write_glb(js, bytes(bins), dst)


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

    # Scope: the Lesta-only tree ships PLUS the non-tree port fleet
    # (premiums / CLR clones / event hulls — the same PORT_GROUPS cohort the
    # encyclopedia overlay and the gameparams bundle carry), so the reported
    # event ships bake like any tree hull. Model dirs from ship_models.json.
    wg_idx = {n["index"] for n in json.loads(WG_TREE.read_text(encoding="utf-8")).values()}
    lesta = json.loads(LESTA_TREE.read_text(encoding="utf-8"))
    only = set(filter(None, (args.only or "").split(",")))
    indexes = sorted(
        {n["index"] for n in lesta.values() if n["index"] not in wg_idx and (not only or n["index"] in only)}
    )
    from build_lesta_overlay import PORT_GROUPS  # noqa: E402

    # The port-fleet walk needs the WG dump's whole index set, not the tree's:
    # hundreds of WG premiums never appear as tree side leaves, and baking
    # their hulls again under Lesta would duplicate the WG-side GLBs wholesale.
    wg_gp_idx: set[str] | None = None
    if WG_GAMEPARAMS.is_file():
        from build_techtree import _params_root as _pr  # noqa: E402

        wg_gp = _pr(json.loads(WG_GAMEPARAMS.read_text(encoding="utf-8")))
        wg_gp_idx = {
            e.get("index")
            for e in wg_gp.values()
            if isinstance(e, dict) and isinstance(e.get("index"), str)
        }
    else:
        print(
            "[bake-lesta] note: no WG GameParams dump — the port-fleet extension is "
            "excluded by the WG tree only; shared premiums may bake as duplicates",
            flush=True,
        )
    for idx, entry in sorted(entry_by_index.items()):
        ti = entry.get("typeinfo")
        if (
            isinstance(ti, dict)
            and ti.get("type") == "Ship"
            and entry.get("group") in PORT_GROUPS
            and idx not in indexes
            and (wg_gp_idx is None or idx not in wg_gp_idx)
            and (not only or idx in only)
        ):
            indexes.append(idx)
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
    # Node blocks: every mount's exact transform (secondary/AA rely on it
    # entirely; mains use it with the splash anchor as cross-check).
    blocks = load_node_blocks(Path(args.stage), args.game_dir, args.ooz, wowsunpack)

    # Splash files for the whole scope up front — the global block
    # attribution needs every ship's boxes before any ship is baked.
    splash_paths = {}
    for idx in indexes:
        base = dir_by_index.get(idx)
        if not base:
            continue
        sp = f"/{base}/" + base.rsplit("/", 1)[-1] + ".splash"
        if any(e["path"] == sp for e in meta):
            splash_paths[idx] = sp
    if splash_paths:
        rc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
             "--game-dir", args.game_dir, "--out", str(args.stage),
             "--wowsunpack", wowsunpack]
            + (["--ooz", args.ooz] if args.ooz else [])
            + [p.lstrip("/") for p in splash_paths.values()],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if rc.returncode != 0:
            print("[bake-lesta] WARN: splash pre-extract reported failures "
                  f"({(rc.stdout or rc.stderr or '')[-160:]})", flush=True)

    # Per-ship armament specs, then per-ship block attribution (the
    # tight positional anchor discriminates families on its own).
    ship_specs: dict[str, dict] = {}
    ship_boxes: dict[str, dict] = {}
    for idx in indexes:
        entry = entry_by_index.get(idx)
        if not entry or idx not in splash_paths:
            continue
        try:
            boxes = parse_splash_boxes(
                (Path(args.stage) / splash_paths[idx].lstrip("/")).read_bytes())
        except (ValueError, struct.error, OSError):
            continue
        hp_ents = gun_hp_entities(entry, entity_by_id)
        if not hp_ents:
            continue
        agm_boxes = {}
        for a in artillery_anchors(entry, entity_by_id):
            box = boxes.get(a["box"])
            if box:
                agm_boxes[a["hp"]] = (box[1][1], (box[0][2] + box[1][2]) / 2)
        ship_specs[idx] = {"gp_names": set(hp_ents),
                           "main_names": {n for n in hp_ents if MAIN_HP_RE.match(n)},
                           "agm_boxes": agm_boxes}
        ship_boxes[idx] = boxes
    ship_blocks: dict[str, list[dict]] = {}
    if blocks and ship_specs:
        for idx in indexes:
            if idx in ship_specs:
                matched = ship_mount_blocks(blocks, ship_specs[idx])
                if matched:
                    ship_blocks[idx] = matched
        n_attr = sum(len(v) for v in ship_blocks.values())
        print(f"[bake-lesta] block attribution: {n_attr:,} blocks across "
              f"{len(ship_blocks)} ships", flush=True)

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

        # Armament data: splash boxes (main-turret anchor + fallback) and
        # the assets.bin node blocks (every mount's exact transform).
        anchors: list[dict] = []
        splash_path = ""
        entry = entry_by_index.get(idx)
        if entry:
            anchors = artillery_anchors(entry, entity_by_id)
            splash_path = splash_paths.get(idx, "")
        if anchors and not splash_path:
            print(f"[bake-lesta] WARN {idx}: no .splash in the ship dir — hull-only.", flush=True)
            anchors = []

        boxes = ship_boxes.get(idx)

        hp_ents = gun_hp_entities(entry, entity_by_id) if entry else {}
        # unique mount name (base HP, x2… on block collisions) → (hp, matrix)
        mounts: dict[str, tuple[str, list[float]]] = {}
        if hp_ents and boxes and ship_blocks.get(idx):
            hull_bounds = (
                [min(mn[c] for mn, _ in boxes.values()) for c in range(3)],
                [max(mx[c] for _, mx in boxes.values()) for c in range(3)],
            )
            raw_mounts = collect_mounts(ship_blocks[idx], hull_bounds, idx)
            # GameParams HP names are unique per ship — a suffixed (x2…)
            # same-name variant is by construction a sister-revision
            # collision, not a real mount. Keep only unsuffixed mounts.
            mounts = {k: v for k, v in raw_mounts.items()
                      if v[0] in hp_ents and k == v[0]}

        extra: list[str] = [a["geometry"].lstrip("/") for a in anchors]
        seen_geo = set(extra)
        for _, (hp, _) in mounts.items():
            g = hp_ents[hp]["geometry"].lstrip("/")
            if g not in seen_geo:
                seen_geo.add(g)
                extra.append(g)
        if splash_path:
            extra.append(splash_path.lstrip("/"))

        rc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
             "--game-dir", args.game_dir, "--out", str(args.stage),
             "--wowsunpack", wowsunpack]
            + (["--ooz", args.ooz] if args.ooz else []) + keep + extra,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
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
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                )
                if r.returncode != 0 or not out.is_file():
                    continue
            if tri_count(out) >= 10:
                parts.append((stem, out))

        # Place the armament. Mounts come from the node blocks (exact
        # matrix); mains fall back to the splash anchor + positional
        # facing when their block is missing or disagrees with the box.
        gun_raw_dir = raw_dir / "gun"
        gun_lo_dir = raw_dir / "gunlo"
        gun_raw_dir.mkdir(exist_ok=True)
        gun_lo_dir.mkdir(exist_ok=True)

        def gun_model_lo(hp: str) -> Path | None:
            """Export + class-budget pre-decimation of one unique gun
            model, cached across ships under the stage."""
            ent = hp_ents[hp]
            raw = gun_raw_dir / f"{ent['stem']}.glb"
            src = Path(args.stage) / ent["geometry"].lstrip("/")
            if not raw.is_file() or args.force:
                if not src.is_file():
                    return None
                r = subprocess.run(
                    [wowsunpack, "export-model", str(src), "--no-vfs", "-o", str(raw)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                )
                if r.returncode != 0 or not raw.is_file():
                    return None
            cap = GUN_TRI_CAP[ent["cls"]]
            lo = gun_lo_dir / f"{ent['stem']}__{cap}_in.glb"
            if not lo.is_file() or args.force:
                try:
                    decimate_gun_glb(raw, lo, cap)
                except (ValueError, KeyError, struct.error) as e:
                    print(f"[bake-lesta] WARN {idx}: gun decimation failed for "
                          f"{ent['stem']}: {e}", flush=True)
                    return None
            return lo

        def muzzle_flip(lo: Path) -> bool:
            """True when the gun model is authored with its barrels on the
            +z side. Lesta mixes conventions (~15% of main-gun models are
            +z while every node matrix assumes -z), which would render
            those turrets backwards; the node transform is then preceded
            by a local 180° yaw. Small decimated mounts (AA) often lose
            the asymmetry — require a clear signal before flipping."""
            js, _ = read_glb(lo)
            lo_z, hi_z = None, None
            for acc in js.get("accessors", []):
                if acc.get("type") != "VEC3" or not acc.get("min"):
                    continue
                lo_z = acc["min"][2] if lo_z is None else min(lo_z, acc["min"][2])
                hi_z = acc["max"][2] if hi_z is None else max(hi_z, acc["max"][2])
            if lo_z is None:
                return False
            ahead, astern = -lo_z, hi_z
            return astern - ahead > 0.15 * (ahead + astern)

        n_main = n_sec = n_aa = 0
        mounted_hp: set[str] = set()
        anchor_boxes = {a["hp"]: a["box"] for a in anchors} if anchors else {}
        mid_z = half_z = None
        if boxes:
            bow_sign = splash_bow_sign(boxes)
            zs = [v for mn, mx in boxes.values() for v in (mn[2], mx[2])]
            mid_z = -bow_sign * (min(zs) + max(zs)) / 2
            half_z = (max(zs) - min(zs)) / 2
        for uniq in sorted(mounts):
            hp, m16 = mounts[uniq]
            ent = hp_ents[hp]
            # Per-main cross-check vs the splash anchor: the block must
            # agree with its gk box; a gross disagreement means the block
            # belongs to a different (sister) hull — fall back below.
            box = boxes.get(anchor_boxes[hp]) if (anchor_boxes.get(hp) and boxes) else None
            if box is not None and MAIN_HP_RE.match(hp):
                exp = ((box[0][0] + box[1][0]) / 2, box[1][1], (box[0][2] + box[1][2]) / 2)
                if (abs(m16[12] - exp[0]) > 0.05 or abs(m16[13] - exp[1]) > 0.05
                        or abs(m16[14] - exp[2]) > 0.05):
                    print(f"[bake-lesta] WARN {idx}: {hp} block disagrees with its "
                          f"splash box — using splash fallback", flush=True)
                    continue
            lo = gun_model_lo(hp)
            if lo is None:
                print(f"[bake-lesta] WARN {idx}: gun model for {hp} unavailable",
                      flush=True)
                continue
            placed = raw_dir / f"{idx}__gun_{uniq}_placed.glb"
            try:
                flip = muzzle_flip(lo)
                if ent["cls"] == "main" and mid_z is not None and half_z:
                    # Matrix-swap quirk guard: a few fictional ships carry
                    # node blocks whose turret rotations are written
                    # swapped (bow turret rot=180, stern rot=0). When the
                    # composed barrel direction decisively contradicts
                    # the mount's fore/aft position (the rule calibrated
                    # 24/26 against WG's own exports), flip this mount.
                    # The composed direction is ALWAYS -m16[10]: the Y-M
                    # pre-rotation negates m10, exactly compensating a
                    # +z-authored muzzle.
                    d_z = -m16[10]
                    mount_hull_z = -m16[14]
                    if (abs(d_z) > 0.7
                            and abs(mount_hull_z - mid_z) > 0.1 * half_z
                            and (d_z > 0) != (mount_hull_z > mid_z)):
                        flip = not flip
                m_place = m16
                if flip:
                    # pre-rotate 180° about Y in gun-local space. Row-vector
                    # convention: p' = (p·Y)·M, so M' = Y·M — negate the
                    # matrix's row 0 and row 2, translation row untouched.
                    m_place = [-m16[0], -m16[1], -m16[2], -m16[3],
                               m16[4], m16[5], m16[6], m16[7],
                               -m16[8], -m16[9], -m16[10], -m16[11],
                               m16[12], m16[13], m16[14], m16[15]]
                place_gun_matrix_glb(lo, placed, m_place)
            except (ValueError, KeyError, struct.error) as e:
                print(f"[bake-lesta] WARN {idx}: {uniq} place failed: {e}",
                      flush=True)
                continue
            if tri_count(placed) >= 10:
                parts.append((f"{ent['stem']}_{uniq}", placed))
                mounted_hp.add(hp)
                n_main += ent["cls"] == "main"
                n_sec += ent["cls"] == "secondary"
                n_aa += ent["cls"] == "aa"

        # Mains without a (validated) block mount: splash anchor + the
        # positional bow/stern facing rule.
        if anchors:
            if boxes:
                bow_sign = splash_bow_sign(boxes)
                mid_z = -bow_sign * (
                    min(mn[2] for mn, _ in boxes.values())
                    + max(mx[2] for _, mx in boxes.values())) / 2
            for a in anchors:
                if a["hp"] in mounted_hp:
                    continue
                box = boxes.get(a["box"]) if boxes else None
                gun_src = Path(args.stage) / a["geometry"].lstrip("/")
                if box is None or not gun_src.is_file():
                    if boxes is not None:
                        print(f"[bake-lesta] WARN {idx}: turret {a['hp']} skipped "
                              f"(box {a['box']} or geometry missing)", flush=True)
                    continue
                mn, mx = box
                mount_z = -bow_sign * (mn[2] + mx[2]) / 2
                face_z = 1 if mount_z > mid_z else -1
                raw = raw_dir / f"{idx}__gun_{a['hp']}.glb"
                src = gun_model_lo(a["hp"]) if a["hp"] in hp_ents else None
                if src is None:
                    if not raw.is_file() or args.force:
                        r = subprocess.run(
                            [wowsunpack, "export-model", str(gun_src), "--no-vfs", "-o", str(raw)],
                            capture_output=True, text=True, encoding="utf-8", errors="replace",
                        )
                        if r.returncode != 0 or not raw.is_file():
                            print(f"[bake-lesta] WARN {idx}: turret {a['hp']} export failed",
                                  flush=True)
                            continue
                    src = raw
                placed = raw_dir / f"{idx}__gun_{a['hp']}_placed.glb"
                try:
                    place_gun_glb(src, placed, face_z, mn, mx, -bow_sign)
                except (ValueError, KeyError, struct.error) as e:
                    print(f"[bake-lesta] WARN {idx}: turret {a['hp']} place failed: {e}",
                          flush=True)
                    continue
                if tri_count(placed) >= 10:
                    stem = a["model"].rsplit("/", 1)[-1][: -len(".model")]
                    parts.append((f"{stem}_{a['hp']}", placed))
                    n_main += 1
                    print(f"[bake-lesta]   {idx} {a['hp']}: splash fallback "
                          f"mount z={mount_z:+.2f} face={'stern' if face_z > 0 else 'bow'}",
                          flush=True)

        if not parts:
            print(f"[bake-lesta] WARN {idx}: all parts degenerate", flush=True)
            failed += 1
            continue
        gp_mains = sum(1 for h in hp_ents.values() if h["cls"] == "main") if hp_ents else 0
        if gp_mains and n_main == 0:
            print(f"[bake-lesta] WARN {idx}: {gp_mains} main-gun HPs in "
                  f"GameParams but none mounted (stub/incomplete client "
                  f"config) — hull-only bake", flush=True)
        merged = raw_dir / f"{idx}__merged.glb"
        merge_glbs(parts, merged)
        rc = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "bake_model.py"), str(merged),
             "-o", str(target), "--triangles", str(args.triangles)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if rc.returncode != 0 or not target.is_file():
            print(f"[bake-lesta] bake failed for {idx}: {rc.stderr[-200:]}", flush=True)
            failed += 1
            continue
        baked += 1
        print(f"[bake-lesta] {idx}: {len(parts)} parts ({n_main} mains, "
              f"{n_sec} secondaries, {n_aa} AA) -> {target.name} "
              f"({tri_count(target):,} tris)", flush=True)
        merged.unlink(missing_ok=True)
        if args.limit and baked >= args.limit:
            break
    print(f"[bake-lesta] done: {baked} baked, {skipped} current, {failed} failed -> {args.out}")
    return 1 if failed and not baked else 0


if __name__ == "__main__":
    raise SystemExit(main())
