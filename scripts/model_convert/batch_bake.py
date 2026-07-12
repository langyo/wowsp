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
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
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


def bake_one(game: str, gp_name: str, output_dir: Path, force: bool) -> bool:
    """Convert + bake a single ship. Returns True on success."""
    filename = derive_filename(gp_name)
    out_glb = output_dir / filename

    if out_glb.exists() and not force:
        return True  # skip

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    raw_glb = TEMP_DIR / f"{gp_name}_raw.glb"

    # Step 1: export raw GLB (no textures, LOD2, no turrets)
    try:
        rc = subprocess.call(
            [str(EXPORTER_BIN), "-W", game, "-s", gp_name,
             "-o", str(raw_glb), "-t", "-T", "-L", "2"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=60,
        )
        if rc != 0 or not raw_glb.exists():
            return False
    except (subprocess.TimeoutExpired, Exception):
        return False

    # Step 2: bake to low-poly
    try:
        rc = subprocess.call(
            [sys.executable, str(BAKE_SCRIPT),
             str(raw_glb), "-o", str(out_glb), "--triangles", "2000"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=30,
        )
        raw_glb.unlink(missing_ok=True)
        return rc == 0 and out_glb.exists()
    except (subprocess.TimeoutExpired, Exception):
        raw_glb.unlink(missing_ok=True)
        return False


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Batch-bake all WoWS ships to holographic GLBs")
    parser.add_argument("--force", action="store_true", help="re-bake even if output exists")
    parser.add_argument("--limit", type=int, default=0, help="max ships to bake (0=all)")
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
    todo = []
    for name in ship_names:
        fname = derive_filename(name)
        if args.force or not (SHIPS_OUT / fname).exists():
            todo.append(name)
    if args.limit > 0:
        todo = todo[: args.limit]

    print(f"[batch_bake] {len(todo)} ships to bake (of {len(ship_names)} total)")
    if not todo:
        print("[batch_bake] all ships already baked. Use --force to re-bake.")
        return 0

    ok = 0
    fail = 0
    start = time.time()
    for i, gp_name in enumerate(todo):
        success = bake_one(game, gp_name, SHIPS_OUT, args.force)
        if success:
            ok += 1
        else:
            fail += 1
        elapsed = time.time() - start
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta = (len(todo) - i - 1) / rate if rate > 0 else 0
        status = "✓" if success else "✗"
        if (i + 1) % 10 == 0 or i < 5:
            eta_min = eta / 60
            print(f"  [{i+1}/{len(todo)}] {status} {gp_name} ({ok} ok, {fail} fail, ETA {eta_min:.0f}min)")

    print(f"\n[batch_bake] done: {ok} baked, {fail} failed in {(time.time()-start)/60:.1f}min")
    print(f"[batch_bake] models in {SHIPS_OUT}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
