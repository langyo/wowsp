#!/usr/bin/env python3
"""Bake the Lesta-only ships' 3D models from a partial Lesta client extract.

The res pack's visual GLBs normally come from `batch_bake.py`, which drives
the third-party wows-gltf-exporter — a WG-client tool that cannot be assumed
to read the Lesta VFS. This driver instead uses the vendored (Lesta-aware)
wowsunpack for the raw export and reuses the repo's own decimator:

  1. scope: every Lesta tech-tree ship whose index is absent from the WG
     tree (the only ships whose models nobody has baked yet);
  2. raw export: `wowsunpack --game-dir <extract> export-ship <model dir>
     --lod 2 --no-textures` (same LOD/no-texture contract as batch_bake);
  3. decimate: `bake_model.py raw -o ships/<INDEX>.glb --triangles 15000`
     (INDEX-named, exactly how modelLoader resolves GLB stems);
  4. armor: `wowsunpack export-armor-glb -o ships/<INDEX>_armor.glb <dir>`.

The game dir is a partial Lesta extract laid out like an install:
`Korabli.exe` marker + `bin/<build>/idx/*.idx` + `res_packages/*.pkg` — see
scripts/extract/run.py's --lesta-gameparams notes for how to produce one
(OpenKorabli/lgc-download + wowsunpack). Resume-safe: ships whose GLB
already exists and looks current are skipped (batch_bake's staleness rule).

Usage:
    python scripts/model_convert/bake_lesta_ships.py \
        --game-dir C:/lesta-extract --gameparams C:/lesta-out/lesta_gameparams.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "extract"))

import batch_bake  # noqa: E402  (SHIPS_OUT, looks_current)
from build_techtree import _params_root  # noqa: E402

REPO_ROOT = SCRIPT_DIR.parent.parent
WG_TREE = REPO_ROOT / "packages/webui/src/data/tech_tree.json"
LESTA_TREE = REPO_ROOT / "packages/webui/src/data/tech_tree_lesta.json"


def find_wowsunpack(explicit: str | None) -> str | None:
    if explicit:
        return explicit if Path(explicit).is_file() else None
    for cand in (
        REPO_ROOT / "target/release/wowsunpack.exe",
        REPO_ROOT / "target/release/wowsunpack",
        REPO_ROOT / "target/model-tools/wowsunpack.exe",
    ):
        if cand.is_file():
            return str(cand)
    import shutil

    return shutil.which("wowsunpack") or shutil.which("wowsunpack.exe")


def hull_model_dir(entry: dict) -> str | None:
    """The ship's hull model directory (e.g. 'JSB039_Yamato_1945') from any
    of its hull upgrade components' `model` paths — researchable ships name
    them A_Hull_<year>/B_Hull_<year>, so the plain A_Hull lookup the WG
    walker uses is not enough here."""
    for key, val in entry.items():
        if not isinstance(val, dict) or "Hull" not in key:
            continue
        model = val.get("model")
        if isinstance(model, str) and model:
            parts = [p for p in model.split("/") if p]
            if len(parts) >= 2:
                return parts[-2]
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", required=True, help="partial Lesta client extract (fake install layout)")
    ap.add_argument("--gameparams", required=True, help="decoded Lesta GameParams.json")
    ap.add_argument("--out", type=Path, default=batch_bake.SHIPS_OUT)
    ap.add_argument("--wowsunpack", help="wowsunpack binary (default: repo target/release)")
    ap.add_argument("--triangles", type=int, default=15000, help="bake triangle budget (pack default 15000)")
    ap.add_argument("--limit", type=int, help="bake at most N ships (bring-up / spot checks)")
    ap.add_argument("--force", action="store_true", help="re-bake even when the GLB looks current")
    ap.add_argument("--only", help="comma list of indexes to bake (default: every Lesta-only tree ship)")
    args = ap.parse_args()

    wowsunpack = find_wowsunpack(args.wowsunpack)
    if not wowsunpack:
        print("error: wowsunpack not found (build it: just build wowsunpack).", file=sys.stderr)
        return 1
    bake_model = SCRIPT_DIR / "bake_model.py"

    wg_indexes = {n["index"] for n in json.loads(WG_TREE.read_text(encoding="utf-8")).values()}
    lesta_tree = json.loads(LESTA_TREE.read_text(encoding="utf-8"))
    only = set(filter(None, (args.only or "").split(",")))
    scope_indexes = [
        n["index"] for n in lesta_tree.values()
        if n["index"] not in wg_indexes and (not only or n["index"] in only)
    ]

    print(f"[bake-lesta] loading {args.gameparams} ...", flush=True)
    gp = _params_root(json.loads(Path(args.gameparams).read_text(encoding="utf-8")))
    by_index: dict[str, dict] = {}
    for key, entry in gp.items():
        if not isinstance(entry, dict):
            continue
        ti = entry.get("typeinfo")
        if isinstance(ti, dict) and ti.get("type") == "Ship" and isinstance(entry.get("index"), str):
            by_index[entry["index"]] = entry

    args.out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="wowsp_lesta_bake_"))
    baked = skipped = failed = 0
    for idx in scope_indexes:
        entry = by_index.get(idx)
        if entry is None:
            print(f"[bake-lesta] WARN no GameParams entity for {idx}", flush=True)
            continue
        target = args.out / f"{idx}.glb"
        if not args.force and target.is_file() and batch_bake.looks_current(target):
            skipped += 1
            continue
        model_dir = hull_model_dir(entry)
        if not model_dir:
            print(f"[bake-lesta] WARN {idx}: no hull model path — skipping", flush=True)
            failed += 1
            continue

        raw = tmp / f"raw_{idx}.glb"
        rc = subprocess.call([
            wowsunpack, "--game-dir", args.game_dir,
            "export-ship", model_dir, "--lod", "2", "--no-textures",
            "-o", str(raw),
        ])
        if rc != 0 or not raw.is_file() or raw.stat().st_size == 0:
            print(f"[bake-lesta] export-ship failed for {idx} ({model_dir})", file=sys.stderr)
            failed += 1
            continue
        rc = subprocess.call([
            sys.executable, str(bake_model), str(raw),
            "-o", str(target), "--triangles", str(args.triangles),
        ])
        if rc != 0 or not target.is_file():
            print(f"[bake-lesta] bake failed for {idx}", file=sys.stderr)
            failed += 1
            continue
        raw.unlink(missing_ok=True)
        baked += 1

        armor = args.out / f"{idx}_armor.glb"
        if args.force or not (armor.is_file() and armor.stat().st_size > 0):
            rc = subprocess.call([
                wowsunpack, "--game-dir", args.game_dir,
                "export-armor-glb", "-o", str(armor), model_dir,
            ])
            if rc != 0:
                # The armor sibling is a bonus layer, not a gate — the
                # visual GLB already landed; log and move on.
                print(f"[bake-lesta] armor export failed for {idx} (visual GLB kept)", flush=True)
                armor.unlink(missing_ok=True)

        if args.limit and baked >= args.limit:
            break

    print(f"[bake-lesta] done: {baked} baked, {skipped} current, {failed} failed -> {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
