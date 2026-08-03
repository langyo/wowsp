"""Export + bake plane / shell / torpedo models for the holographic viewer.

Planes are keyed by their GameParams index (from plane_types.json) so the
frontend can map a squadron's paramsId -> index -> GLB. The GameParams ->
VFS geometry path map lives in `packages/webui/src/data/plane_models.json`
(regenerate with `wowsunpack game-params` + the `model` field on each entry).

Usage:
    # Bake the planes that appear in a replay dump (from the dump_replay_json
    # Rust test) — the common case:
    python scripts/model_convert/bake_planes.py --from-dump dump.json

    # Bake specific planes by GP name:
    python scripts/model_convert/bake_planes.py --planes PJAF206_Ryujo_top ...

    # Bake every plane in plane_types.json (slow — hundreds of exports):
    python scripts/model_convert/bake_planes.py --all

    # Bake the shared shell + torpedo props only:
    python scripts/model_convert/bake_planes.py --props-only
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

from _common import find_game_path  # noqa: E402

DATA_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"
PLANES_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "planes"
PROPS_OUT = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models" / "props"
TEMP_DIR = REPO_ROOT / "target" / "model-tmp"
BAKE_SCRIPT = SCRIPT_DIR / "bake_model.py"

# Shared projectile props — every gun shell uses the same generic model in
# game, likewise torpedoes.
PROPS = {
    "shell": "/content/gameplay/common/projectile/artillery/CPA001_Shell_Main/CPA001_Shell_Main.geometry",
    "torpedo": "/content/gameplay/common/projectile/torpedo/CPT001_Torpedo/CPT001_Torpedo.geometry",
}

PROP_TRIS = {"shell": 300, "torpedo": 600}
PLANE_TRIS = 1200


def find_wowsunpack() -> Path:
    exe = REPO_ROOT / "target" / "release" / "wowsunpack.exe"
    if exe.exists():
        return exe
    exe = REPO_ROOT / "target" / "model-tools" / "wowsunpack.exe"
    if exe.exists():
        return exe
    raise FileNotFoundError("wowsunpack.exe not found — run just build-wowsunpack-patched")


def export_and_bake(wowsunpack: Path, game: str, vfs_path: str, out_glb: Path,
                    triangles: int, tag: str) -> bool:
    raw = TEMP_DIR / f"raw_{tag}.glb"
    try:
        rc = subprocess.call(
            [str(wowsunpack), "-g", game, "export-model", vfs_path,
             "-o", str(raw), "--no-textures"],
            timeout=60,
        )
        if rc != 0 or not raw.exists():
            print(f"     ↳ export rc={rc}")
            return False
        rc = subprocess.call(
            [sys.executable, str(BAKE_SCRIPT), str(raw),
             "-o", str(out_glb), "--triangles", str(triangles)],
            timeout=60,
        )
        return rc == 0 and out_glb.exists()
    except subprocess.TimeoutExpired:
        print("     ↳ timed out")
        return False
    finally:
        raw.unlink(missing_ok=True)


def planes_from_dump(path: Path) -> list[str]:
    """Plane GP names referenced by a replay dump (squadronCreates paramsIds)."""
    dump = json.loads(path.read_text(encoding="utf-8"))
    plane_types = json.loads((DATA_DIR / "plane_types.json").read_text(encoding="utf-8"))
    names: set[str] = set()
    for sc in dump.get("squadronCreates") or []:
        hit = plane_types.get(str(sc.get("paramsId")))
        if hit:
            names.add(hit["name"])
    return sorted(names)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-dump", type=Path, default=None, help="replay dump JSON to take the plane set from")
    ap.add_argument("--planes", nargs="*", default=None, help="explicit GP plane names")
    ap.add_argument("--all", action="store_true", help="bake every plane in plane_types.json")
    ap.add_argument("--props-only", action="store_true", help="only bake shell + torpedo props")
    ap.add_argument("--game-dir", default=None)
    args = ap.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print("game install not found", file=sys.stderr)
        return 1
    wowsunpack = find_wowsunpack()
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    PLANES_OUT.mkdir(parents=True, exist_ok=True)
    PROPS_OUT.mkdir(parents=True, exist_ok=True)

    ok = True

    # Props first — tiny.
    for name, vfs in PROPS.items():
        out = PROPS_OUT / f"{name}.glb"
        if out.exists():
            continue
        print(f"[props] {name} ...")
        if export_and_bake(wowsunpack, game, vfs, out, PROP_TRIS[name], name):
            print(f"[props] {name} -> {out.name} ({out.stat().st_size // 1024} KB)")
        else:
            print(f"[props] {name} FAILED")
            ok = False

    if args.props_only:
        return 0 if ok else 1

    plane_types = json.loads((DATA_DIR / "plane_types.json").read_text(encoding="utf-8"))
    path_map = json.loads((DATA_DIR / "plane_models.json").read_text(encoding="utf-8"))
    index_of = {v["name"]: v["index"] for v in plane_types.values()}

    if args.all:
        names = sorted(path_map.keys())
    elif args.planes:
        names = args.planes
    elif args.from_dump:
        names = planes_from_dump(args.from_dump)
    else:
        ap.error("one of --from-dump / --planes / --all / --props-only is required")

    done = 0
    failed: list[str] = []
    for n in names:
        vfs = path_map.get(n)
        index = index_of.get(n)
        if not vfs or not index:
            print(f"[planes] {n}: no model path — skipped")
            failed.append(n)
            continue
        out = PLANES_OUT / f"{index}.glb"
        if out.exists():
            done += 1
            continue
        print(f"[planes] {index} ({n}) ...")
        if export_and_bake(wowsunpack, game, vfs, out, PLANE_TRIS, index):
            done += 1
            print(f"[planes] {index} -> {out.name} ({out.stat().st_size // 1024} KB)")
        else:
            failed.append(n)
            print(f"[planes] {index} FAILED")

    print(f"[planes] {done}/{len(names)} baked, {len(failed)} failed")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
