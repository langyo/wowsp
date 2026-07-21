#!/usr/bin/env python3
"""Batch-bake ALL ships in the current game version to low-poly holographic GLBs.

Uses wows-list-ships to get the authoritative list of GameParams ship names,
then converts + bakes each one. Tools are cached under target/model-tools/.

The conversion takes ~10s per ship (1196 ships ≈ 3h). The script is idempotent
and checkpoints progress, so it can be interrupted and resumed.

Usage:
    python scripts/model_convert/batch_bake.py              # bake all missing
    python scripts/model_convert/batch_bake.py --force       # re-bake all
    python scripts/model_convert/batch_bake.py --limit 10    # bake only 10 (testing)

    just bake-all-ships
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]  # scripts/model_convert/ → scripts/ → repo root
TOOLS_DIR = REPO_ROOT / "target" / "model-tools"
SHIPS_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "ships"
TEMP_DIR = REPO_ROOT / "target" / "model-tmp"

EXPORTER_BIN = TOOLS_DIR / "wows-gltf-exporter.exe"
LIST_SHIPS_BIN = TOOLS_DIR / "wows-list-ships.exe"
BAKE_SCRIPT = SCRIPT_DIR / "bake_model.py"

EXPORTER_URL = "https://github.com/wows-tools/wows-model-exporter/releases/download/0.2.1/wows-model-exporter-windows-x86_64.zip"


def find_game_path() -> str | None:
    sys.path.insert(0, str(SCRIPT_DIR))
    from _common import find_game_path as _fgp
    return _fgp()


def ensure_tools():
    """Ensure the exporter + list-ships binaries exist in target/model-tools/."""
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    if EXPORTER_BIN.exists() and LIST_SHIPS_BIN.exists():
        return
    print(f"[batch_bake] downloading tools to {TOOLS_DIR} ...")
    import urllib.request
    import zipfile
    zip_path = TOOLS_DIR / "exporter.zip"
    urllib.request.urlretrieve(EXPORTER_URL, str(zip_path))
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(TOOLS_DIR)
    zip_path.unlink()
    if not EXPORTER_BIN.exists():
        raise FileNotFoundError(f"{EXPORTER_BIN.name} not found after extraction")


def get_ship_names(game: str) -> list[str]:
    """Get all GameParams ship names via wows-list-ships."""
    print("[batch_bake] listing ships from GameParams ...")
    result = subprocess.run(
        [str(LIST_SHIPS_BIN), "-W", game],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        print(f"error: wows-list-ships failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    # Parse the table output: skip header rows, take column 1 (the key).
    lines = result.stdout.strip().split("\n")
    names = []
    for line in lines:
        parts = line.split()
        if parts and parts[0] != "Key" and not line.startswith("-"):
            names.append(parts[0])
    print(f"[batch_bake] found {len(names)} ships in GameParams")
    return names


def derive_filename(gp_name: str) -> str:
    """Derive a human-readable filename from a GameParams name.
    e.g. PASB017_Montana_1945 → Montana.glb"""
    parts = gp_name.split("_")
    # Skip the prefix (e.g. PASB017) and trailing year/version.
    readable_parts = [p for p in parts[1:] if not p.isdigit() and p != ""]
    # Also skip common suffixes like "HW19", "H2019", "Borg", etc.
    readable = [p for p in readable_parts if len(p) <= 4 or p[0].isupper()]
    if not readable:
        readable = readable_parts
    return "_".join(readable) + ".glb"


def glb_mesh_stats(path: Path) -> tuple[int, int]:
    """Read a baked GLB's triangle + vertex counts from JSON accessor metadata
    only (no binary decode). Every baked GLB from `bake_model.write_glb` has a
    single mesh primitive with POSITION + indices accessors.

    Returns (n_tris, n_verts); (-1, -1) if unreadable. Used by `--resume` to
    spot stale bakes two ways:
      - low triangle count  → old every-Nth-triangle shard algorithm
      - verts ≫ tris×3       → a bake that skipped vertex welding/dedup
                               (bloated ~1.5MB file for a ~75KB model)
    """
    try:
        data = path.read_bytes()
        magic, version, length = struct.unpack_from("<III", data, 0)
        if magic != 0x46546C67 or length > len(data):
            return -1, -1
        offset = 12
        json_body = None
        while offset < length:
            chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
            offset += 8
            if chunk_type == 0x4E4F534A:  # "JSON"
                json_body = data[offset : offset + chunk_len]
                break
            offset += chunk_len
        if not json_body:
            return -1, -1
        g = json.loads(json_body.rstrip(b"\x00").decode("utf-8"))
        n_verts = n_tris = -1
        for mesh in g.get("meshes", []):
            for prim in mesh.get("primitives", []):
                pos_acc = prim.get("attributes", {}).get("POSITION")
                if pos_acc is not None and n_verts < 0:
                    n_verts = g["accessors"][pos_acc].get("count", -1)
                if "indices" in prim and n_tris < 0:
                    n_tris = g["accessors"][prim["indices"]].get("count", -1) // 3
        return n_tris, n_verts
    except Exception:
        return -1, -1


def count_glb_triangles(path: Path) -> int:
    """Back-compat shim: triangle count only (see glb_mesh_stats)."""
    return glb_mesh_stats(path)[0]


def looks_current(path: Path, min_tris: int) -> bool:
    """Resume-mode freshness check. A baked GLB is "current" (skip re-baking)
    iff BOTH:
      - triangle count ≥ a floor (rules out old shard-algorithm bakes, which
        targeted ~2000 tris). The floor is the lesser of `min_tris` and 2500,
        so genuinely small ships (Tier-1 trainers with ~2300 native tris) that
        are correctly welded still pass — they can't have more triangles than
        their source mesh provides.
      - vertices ≤ triangles × 3 + slack (rules out bakes that skipped vertex
        welding — a welded mesh has roughly half as many verts as a tri has
        corners, never more; an un-welded one carries the raw per-face-duplicate
        buffer and balloons to ~1.5MB).
    """
    n_tris, n_verts = glb_mesh_stats(path)
    if n_tris < 0 or n_verts < 0:
        return False  # unreadable → treat as stale, re-bake
    floor = min(min_tris, 2000)
    if n_tris < floor:
        return False
    # A healthy welded mesh: verts ≈ 0.5–1.0 × tris. Allow up to 3× as slack
    # for tiny ships whose geometry is genuinely vertex-heavy. Anything past
    # that is an unwelded buffer.
    return n_verts <= n_tris * 3 + 64


def bake_one(game: str, gp_name: str, output_dir: Path, force: bool,
             resume_min_tris: int = 0) -> bool:
    """Convert + bake a single ship. Returns True on success (including skip).

    `force`           — always re-bake even if output exists.
    `resume_min_tris` — when >0 (resume mode), skip an existing GLB only if it
                        looks current (enough triangles AND welded vertices).
                        This makes the run safely resumable: re-invoking it
                        only touches files still needing work.
    """
    filename = derive_filename(gp_name)
    out_glb = output_dir / filename

    if out_glb.exists():
        if force:
            pass  # re-bake regardless
        elif resume_min_tris > 0:
            if looks_current(out_glb, resume_min_tris):
                return True
        else:
            return True  # plain skip (no --force, no --resume)

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    # Use a unique temp file per ship to avoid collision if a previous run
    # was interrupted mid-bake.
    import hashlib
    tag = hashlib.md5(gp_name.encode()).hexdigest()[:8]
    raw_glb = TEMP_DIR / f"raw_{tag}.glb"

    # Step 1: export raw GLB (no textures, LOD2, include turrets).
    # Convert underscores to spaces — the exporter uses a regex pattern matcher
    # where each space-separated word becomes .*word.*, and underscores in a
    # single word won't disambiguate when the GP key itself contains both the
    # index prefix and the ship name (e.g. PASA002_Bogue_1942 vs PXSX815_Bogue_Clone).
    exporter_ship = gp_name.replace("_", " ")
    try:
        rc = subprocess.call(
            [str(EXPORTER_BIN), "-W", game, "-s", exporter_ship,
             "-o", str(raw_glb), "-T", "-L", "2"],
            timeout=45,
        )
        if rc != 0 or not raw_glb.exists():
            raw_glb.unlink(missing_ok=True)
            print(f"     ↳ exporter rc={rc} (missing game geometry?)")
            return False
    except subprocess.TimeoutExpired:
        raw_glb.unlink(missing_ok=True)
        print(f"     ↳ exporter timed out")
        return False
    except Exception:
        raw_glb.unlink(missing_ok=True)
        print(f"     ↳ exporter crashed")
        return False

    # Step 2: bake to low-poly
    try:
        rc = subprocess.call(
            [sys.executable, str(BAKE_SCRIPT),
             str(raw_glb), "-o", str(out_glb), "--triangles", "10000"],
            timeout=30,
        )
        return rc == 0 and out_glb.exists()
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False
    finally:
        raw_glb.unlink(missing_ok=True)


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Batch-bake all WoWS ships to holographic GLBs")
    parser.add_argument("--force", action="store_true",
                        help="re-bake every ship even if an up-to-date GLB exists")
    parser.add_argument("--resume", action="store_true", default=True,
                        help="only re-bake ships whose existing GLB looks stale "
                             "(triangle count below --resume-min-tris). Default on; "
                             "makes the run safely interruptible + resumable. "
                             "Use --no-resume to skip ships that merely exist.")
    parser.add_argument("--no-resume", dest="resume", action="store_false",
                        help="disable resume checks — skip any ship whose GLB file exists")
    parser.add_argument("--resume-min-tris", type=int, default=3000,
                        help="triangle threshold for --resume: existing GLBs with fewer "
                             "triangles are treated as stale and re-baked (default: 3000, "
                             "which separates the old ~2000-tri shard bakes from the "
                             "current ~6000-tri vertex-clustering bakes)")
    parser.add_argument("--limit", type=int, default=0,
                        help="max ships to bake this run (0=all). Combined with --resume "
                             "this gives safe batched processing: each invocation works off "
                             "N stale models and exits, so no single run must finish the lot.")
    parser.add_argument("--game-dir", default=None, help="game install path (default: auto-detect)")
    args = parser.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    ensure_tools()
    SHIPS_OUT.mkdir(parents=True, exist_ok=True)
    ship_names = get_ship_names(game)

    # Filter: only bake ships that don't have a GLB yet (unless --force).
    # Also skip PX*-prefixed ships (event/consumable/Boss units that have no
    # playable 3D hull model — the exporter returns exit 1 for these).
    PLAYABLE_PREFIXES = ("PA", "PB", "PC", "PD", "PE", "PF", "PG", "PH", "PI",
                         "PJ", "PK", "PL", "PM", "PN", "PO", "PP", "PR", "PT",
                         "PU")  # Commonwealth, Pan-Europe etc.

    # Decide whether an existing GLB is "current" (skip) or "stale" (re-bake):
    #   --force              → never current
    #   --resume (default)   → current iff its triangle count ≥ resume_min_tris
    #   --no-resume          → current iff the file exists
    resume_min_tris = args.resume_min_tris if args.resume else 0

    def needs_baking(gp_name: str) -> bool:
        if args.force:
            return True
        out_glb = SHIPS_OUT / derive_filename(gp_name)
        if not out_glb.exists():
            return True
        if resume_min_tris > 0:
            return not looks_current(out_glb, resume_min_tris)
        return False

    todo = []
    skipped = 0
    stale = 0
    for name in ship_names:
        if not any(name.startswith(p) for p in PLAYABLE_PREFIXES):
            skipped += 1
            continue
        if needs_baking(name):
            todo.append(name)
        else:
            stale += 1  # exists + (current | plain-skip): not baked this run
    if args.limit > 0:
        todo = todo[: args.limit]

    mode = "force" if args.force else ("resume" if args.resume else "skip-existing")
    print(f"[batch_bake] mode={mode}  {len(todo)} to bake, {stale} up-to-date, "
          f"{skipped} non-playable skipped (of {len(ship_names)} total)")
    if not todo:
        print("[batch_bake] nothing to do. Use --force to re-bake everything.")
        return 0

    ok = 0
    fail = 0
    start = time.time()
    for i, gp_name in enumerate(todo):
        success = bake_one(game, gp_name, SHIPS_OUT, args.force, resume_min_tris)
        if success:
            ok += 1
        else:
            fail += 1
        elapsed = time.time() - start
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta = (len(todo) - i - 1) / rate if rate > 0 else 0
        status = "✓" if success else "✗"
        eta_min = eta / 60
        print(f"  [{i+1}/{len(todo)}] {status} {gp_name} ({ok} ok, {fail} fail, ETA {eta_min:.0f}min)", flush=True)

    print(f"\n[batch_bake] done: {ok} baked, {fail} failed in {(time.time()-start)/60:.1f}min")
    print(f"[batch_bake] models in {SHIPS_OUT}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
