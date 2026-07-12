#!/usr/bin/env python3
"""Batch-bake ALL ships in the current game version to low-poly holographic GLBs.

This is a one-time (per game version) conversion that:
  1. Ensures the wows-gltf-exporter binary is downloaded to target/model-tools/
  2. Reads the ship encyclopedia to get every ship's model name
  3. Converts each ship to a raw GLB (no textures, LOD2)
  4. Bakes each raw GLB to a low-poly holographic model (~2000 tris)
  5. Writes the result to packages/webui/src/res/models/ships/<name>.glb

The script is idempotent: ships that already have a baked GLB are skipped
unless --force is passed.

Tool binaries are cached under <repo>/target/model-tools/ so the conversion
is reproducible without re-downloading on every run.

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
import urllib.request
import zipfile
from pathlib import Path

# Resolve paths relative to this script.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
TOOLS_DIR = REPO_ROOT / "target" / "model-tools"
SHIPS_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "ships"
TEMP_DIR = REPO_ROOT / "target" / "model-tmp"

# Tool download URLs (pinned versions for reproducibility).
EXPORTER_URL = "https://github.com/wows-tools/wows-model-exporter/releases/download/0.2.1/wows-model-exporter-windows-x86_64.zip"
EXPORTER_BIN = "wows-gltf-exporter.exe"

# Encyclopedia cache location (populated by the Tauri app on first run).
ENCYCLOPEDIA_GLOB = "ships-*-s2.json"


def find_game_path() -> str | None:
    """Auto-detect WoWS install via the shared _common module."""
    sys.path.insert(0, str(SCRIPT_DIR))
    from _common import find_game_path as _fgp
    return _fgp()


def ensure_exporter() -> Path:
    """Download + cache the wows-gltf-exporter binary under target/model-tools/.
    Returns the path to wows-gltf-exporter.exe."""
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    exporter_path = TOOLS_DIR / EXPORTER_BIN
    if exporter_path.exists():
        return exporter_path

    print(f"[batch_bake] downloading wows-gltf-exporter to {TOOLS_DIR} ...")
    zip_path = TOOLS_DIR / "exporter.zip"
    urllib.request.urlretrieve(EXPORTER_URL, str(zip_path))
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(TOOLS_DIR)
    zip_path.unlink()
    if not exporter_path.exists():
        raise FileNotFoundError(f"{EXPORTER_BIN} not found after extraction")
    print(f"[batch_bake] exporter ready: {exporter_path}")
    return exporter_path


def load_ship_list() -> list[dict]:
    """Load the ship encyclopedia from AppData to get shipId → name mapping.
    Each entry returns {shipId, name, modelDir} where modelDir is derived
    from the GameParams name (we'll pass it to the exporter)."""
    import glob

    appdata = os.environ.get("APPDATA", os.path.expanduser("~/.local/share"))
    wowsp_dir = Path(appdata) / "WoWSP" / "encyclopedia"
    files = sorted(glob.glob(str(wowsp_dir / ENCYCLOPEDIA_GLOB)))
    if not files:
        print(f"[batch_bake] no encyclopedia cache found in {wowsp_dir}")
        print("[batch_bake] run the app once to populate the encyclopedia, then retry.")
        sys.exit(1)

    with open(files[-1]) as f:
        data = json.load(f)
    ships = data.get("ships", data.get("data", []))
    print(f"[batch_bake] loaded {len(ships)} ships from {Path(files[-1]).name}")
    return ships


def ship_to_model_pattern(ship: dict) -> str | None:
    """Derive the WG model directory pattern from a ship entry.
    We don't have the model dir directly in ShipInfo, but we can search
    by the ship's display name. The exporter does fuzzy matching."""
    name = ship.get("name", "")
    if not name:
        return None
    return name


def bake_one(exporter: Path, game: str, ship: dict, output_dir: Path, force: bool) -> bool:
    """Convert + bake a single ship. Returns True on success."""
    name = ship.get("name", f"ship_{ship.get('shipId','?')}")
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
    out_glb = output_dir / f"{safe_name}.glb"

    if out_glb.exists() and not force:
        return True  # already baked

    pattern = ship_to_model_pattern(ship)
    if not pattern:
        return False

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    raw_glb = TEMP_DIR / f"{safe_name}_raw.glb"

    # Step 1: export raw GLB (no textures, LOD2, no turrets for speed)
    try:
        rc = subprocess.call(
            [str(exporter), "-W", game, "-s", pattern,
             "-o", str(raw_glb), "-t", "-T", "-L", "2"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=120,
        )
        if rc != 0 or not raw_glb.exists():
            return False
    except (subprocess.TimeoutExpired, Exception):
        return False

    # Step 2: bake to low-poly
    try:
        rc = subprocess.call(
            [sys.executable, str(SCRIPT_DIR / "bake_model.py"),
             str(raw_glb), "-o", str(out_glb), "--triangles", "2000"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=60,
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

    exporter = ensure_exporter()
    ships = load_ship_list()

    SHIPS_OUT.mkdir(parents=True, exist_ok=True)

    todo = ships if args.force else [s for s in ships if not (SHIPS_OUT / f"{''.join(c if c.isalnum() or c in '-_' else '_' for c in s.get('name',''))}.glb").exists()]
    if args.limit > 0:
        todo = todo[: args.limit]

    print(f"[batch_bake] {len(todo)} ships to bake (of {len(ships)} total)")
    if not todo:
        print("[batch_bake] all ships already baked. Use --force to re-bake.")
        return 0

    ok = 0
    fail = 0
    start = time.time()
    for i, ship in enumerate(todo):
        name = ship.get("name", "?")
        success = bake_one(exporter, game, ship, SHIPS_OUT, args.force)
        if success:
            ok += 1
        else:
            fail += 1
        elapsed = time.time() - start
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta = (len(todo) - i - 1) / rate if rate > 0 else 0
        status = "✓" if success else "✗"
        print(f"  [{i+1}/{len(todo)}] {status} {name} ({ok} ok, {fail} fail, ETA {eta:.0f}s)")

    print(f"\n[batch_bake] done: {ok} baked, {fail} failed, {ok+fail} total in {time.time()-start:.0f}s")
    print(f"[batch_bake] models in {SHIPS_OUT}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
