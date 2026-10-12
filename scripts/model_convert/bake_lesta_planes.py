#!/usr/bin/env python3
"""Bake the Lesta airplanes into the plane GLB pack.

The Lesta (Мир кораблей) client's pkgs are Oodle-compressed, which the pkg
reader cannot decode (see lesta_extract.py), so the WG plane route
(bake_planes.py, straight off the pkg VFS) cannot read them from the install.
This script takes the same staged route bake_lesta_ships.py uses for hulls:

  1. lesta_extract.py stages each airframe's `.geometry` (Oodle → plain file);
  2. `wowsunpack export-model --no-vfs` converts the staged file to GLB;
  3. bake_model.py decimates it into the pack format (--dedup-lods: plane
     .geometry files carry every section at three LODs).

The bake set is the `"lesta": true` rows of plane_types.json (added by
extract_lesta_planes.py); each output is named by the plane's GameParams
index under src/res/models/planes/, exactly the stem
modelLoader.resolvePlaneModelUrl serves to the ship-detail plane picker.

Outputs are untracked bake artifacts: the res pack publishes them
(`just release-models`), and a checkout needs `just fetch-models` (or this
bake) to carry them.

Requirements: the Oodle decoder (unoodle, preferred —
github.com/lvlvllvlvllvlvl/oozextract — or powzix/ooz) dropped in
target/release/ or passed via --ooz / WOWSP_OOZ, same as the ship bakes.

Usage:
    python scripts/model_convert/bake_lesta_planes.py \
        --game-dir "D:/WoWS_Korabli" --stage "C:/lesta-work/stage"
    python scripts/model_convert/bake_lesta_planes.py --game-dir ... --stage ... \
        --only PAAB211,PJAF211
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from bake_lesta_ships import find_wowsunpack, tri_count  # noqa: E402

DATA_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"
PLANES_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "planes"
PLANE_TRIS = 1200  # mirrors bake_planes.py


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", required=True, help="Lesta client install root")
    ap.add_argument("--stage", required=True, help="extraction dir (content/ tree + raw glbs)")
    ap.add_argument("--ooz", default=None, help="Oodle decoder for lesta_extract (unoodle preferred)")
    ap.add_argument("--wowsunpack", default=None)
    ap.add_argument("--out", type=Path, default=PLANES_OUT)
    ap.add_argument("--triangles", type=int, default=PLANE_TRIS)
    ap.add_argument("--only", help="comma list of plane indexes")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    wowsunpack = find_wowsunpack(args.wowsunpack)
    if not wowsunpack:
        print("error: wowsunpack not found (build it: just build wowsunpack).", file=sys.stderr)
        return 1

    types = json.loads((DATA_DIR / "plane_types.json").read_text(encoding="utf-8"))
    models = json.loads((DATA_DIR / "plane_models.json").read_text(encoding="utf-8"))
    only = set(filter(None, (args.only or "").split(",")))
    targets = sorted(
        (v["index"], v["name"])
        for v in types.values()
        if v.get("lesta") and (not only or v.get("index") in only)
    )
    if not targets:
        print("error: no Lesta planes in plane_types.json — run "
              "extract_lesta_planes.py first.", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    raw_dir = Path(args.stage) / "rawglb"
    raw_dir.mkdir(parents=True, exist_ok=True)
    baked = skipped = failed = 0
    for index, name in targets:
        target = args.out / f"{index}.glb"
        if target.is_file() and not args.force:
            skipped += 1
            continue
        vfs = models.get(name)
        if not vfs:
            print(f"[bake-lesta-planes] WARN {index}: no model path for {name}", flush=True)
            failed += 1
            continue
        rel = vfs.lstrip("/")
        rc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
             "--game-dir", args.game_dir, "--out", args.stage,
             "--wowsunpack", wowsunpack]
            + (["--ooz", args.ooz] if args.ooz else []) + [rel],
            capture_output=True, text=True,
        )
        staged = Path(args.stage) / rel
        if rc.returncode != 0 or not staged.is_file():
            print(f"[bake-lesta-planes] extract failed for {index}: {(rc.stderr or '')[-200:]}",
                  flush=True)
            failed += 1
            continue
        raw = raw_dir / f"{index}__{name}.glb"
        r = subprocess.run(
            [wowsunpack, "export-model", str(staged), "--no-vfs", "-o", str(raw)],
            capture_output=True, text=True,
        )
        if r.returncode != 0 or not raw.is_file():
            print(f"[bake-lesta-planes] export failed for {index}: {(r.stderr or '')[-200:]}",
                  flush=True)
            failed += 1
            continue
        rc = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "bake_model.py"), str(raw),
             "-o", str(target), "--triangles", str(args.triangles), "--dedup-lods"],
            capture_output=True, text=True,
        )
        raw.unlink(missing_ok=True)
        if rc.returncode != 0 or not target.is_file():
            print(f"[bake-lesta-planes] bake failed for {index}: {(rc.stderr or '')[-200:]}",
                  flush=True)
            failed += 1
            continue
        baked += 1
        print(f"[bake-lesta-planes] {index} ({name}) -> {target.name} "
              f"({tri_count(target):,} tris, {target.stat().st_size // 1024} KB)", flush=True)

    print(f"[bake-lesta-planes] done: {baked} baked, {skipped} present, {failed} failed -> {args.out}")
    # A 19-item set: any failure is a plane the picker will list but cannot
    # stage, so fail loudly rather than reporting a partial run as success.
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
