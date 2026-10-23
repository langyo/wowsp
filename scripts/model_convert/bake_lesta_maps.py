#!/usr/bin/env python3
"""Bake the Lesta-only maps (spaces) into the map GLB pack + minimap art.

The Lesta (Мир кораблей) client's pkgs are Oodle-compressed, which the
vendored game-assets pkg reader cannot decode (see scripts/extract/
lesta_extract.py), so the WG map route (batch_bake_maps.py →
convert_map_holo.py straight off the pkg VFS) cannot read its spaces.
This script takes the staged route bake_lesta_ships.py / bake_lesta_planes.py
use, and produces the exact same per-map artifacts the WG route does:

  1. enumerate the install's spaces via `game-assets list` (idx-only pass,
     no pkgs — the same enumeration extract_map_names.py uses);
  2. dedupe against the WG pack: a space whose GLB already exists under
     src/res/models/maps/ is skipped, so shared ids keep the WG bake and
     only Lesta-exclusives (event maps, new numbered maps, ports) land;
  3. lesta_extract.py stages `spaces/<id>/` (Oodle → plain files);
  4. `game-assets export-map --no-vfs` converts the staged space to a raw
     GLB and the convert_map_holo split/weld step writes the pack GLB
     (Terrain node only, step-2 grid — the pack standard);
  5. the staged minimap art is composited (water+land → 760px WebP) and the
     space.settings bounds merged into minimaps.json — the artifacts
     extract_minimaps.py produces for WG spaces.

Map NAMES are not touched here: run
`extract_map_names.py --game-dir <Lesta> --merge` afterwards to add the
Lesta-only ids to map_names.json (merge keeps WG translations for shared
ids and only fills gaps).

Outputs: packages/webui/src/res/models/maps/<id>.glb (untracked bake
artifact, published via `just release-models`), plus the tracked
minimaps/<id>.webp and the minimaps.json bounds row.

Requirements: none beyond the repo's usual toolchain — when no Oodle
decoder is present, one (unoodle, from
github.com/lvlvllvlvllvlvl/oozextract) is shallow-cloned and built
automatically (scripts/extract/fetch_oodle.py; WOWSP_OODLE_NO_BUILD=1
opts out, a manual binary still wins via --ooz / WOWSP_OOZ).

Usage:
    python scripts/model_convert/bake_lesta_maps.py \
        --game-dir "D:/WoWS_Korabli" --stage "C:/lesta-work/mapstage"
    python scripts/model_convert/bake_lesta_maps.py --game-dir ... --stage ... \
        --only e17_2026_Lukomorye,56_Kamchatka
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from bake_lesta_ships import find_game_assets  # noqa: E402
from bake_model import (  # noqa: E402
    decimate,
    extract_meshes_by_name,
    parse_glb,
    write_glb_multimesh,
)
from extract_minimaps import MAPS_DIR, MINIMAP_SIZE, parse_bounds  # noqa: E402


def list_spaces(game_dir: str, game_assets: str) -> list[str]:
    """Space ids from the Lesta install's idx (the same `(D) /spaces/<id>`
    listing extract_map_names.py scrapes; works on Oodle installs because
    `list` never opens a pkg)."""
    out = subprocess.run(
        [game_assets, "-g", game_dir, "list"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stdout
    ids: set[str] = set()
    for ln in out.splitlines():
        m = re.match(r"\(D\) /spaces/([0-9A-Za-z_]+)/?$", ln.strip())
        if m:
            ids.add(m.group(1))
    return sorted(ids)


def stage_space(game_dir: str, stage: Path, ooz: str | None,
                game_assets: str, sid: str) -> Path | None:
    """Stage `spaces/<sid>/` out of the Oodle pkgs; returns the staged dir
    (None on failure). fnmatch's `*` crosses `/`, so one pattern covers the
    whole subtree."""
    rc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts/extract/lesta_extract.py"),
         "--game-dir", game_dir, "--out", str(stage),
         "--game-assets", game_assets]
        + (["--ooz", ooz] if ooz else [])
        + [f"spaces/{sid}/*"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    staged = stage / "spaces" / sid
    if rc.returncode != 0 or not staged.is_dir():
        print(f"[bake-lesta-maps] stage failed for {sid}: "
              f"{(rc.stderr or rc.stdout or '')[-200:]}", flush=True)
        return None
    return staged


def export_space_glb(game_assets: str, staged: Path, raw: Path,
                     terrain_step: int) -> bool:
    """export-map off the staged dir (--no-vfs). --no-models: the holo pack
    keeps only the Terrain mesh, and Lesta 26.x models.bin is beyond the
    vendored parser — skip the model side entirely (needs the patched
    game-assets; falls back without it like the keep-submerged retry)."""
    base = [game_assets, "export-map", str(staged), "--no-vfs",
            "-o", str(raw), "--terrain-step", str(terrain_step),
            "--no-water", "--no-vegetation", "--no-textures"]
    variants = [
        base + ["--no-models", "--keep-submerged"],
        base + ["--no-models"],
        base + ["--keep-submerged"],
        base,
    ]
    last = ""
    for cmd in variants:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode == 0 and raw.is_file():
            return True
        last = (r.stderr or "")[-200:]
    print(f"[bake-lesta-maps] export failed for {staged.name}: {last}",
          flush=True)
    return False


def bake_holo_glb(raw: Path, out: Path) -> bool:
    """The convert_map_holo post-extract step: keep the Terrain mesh,
    weld-only decimate, write the pack GLB."""
    gltf = parse_glb(raw)
    by_name = extract_meshes_by_name(gltf)
    terrain = by_name.pop("Terrain", None)
    meshes: list[tuple[str, list[float], list[int]]] = []
    if terrain is not None:
        tv, ti = terrain
        tv, ti = decimate(tv, ti, len(ti) // 3)  # weld-only, the pack standard
        meshes.append(("Terrain", tv, ti))
    if not meshes:
        print(f"[bake-lesta-maps] no Terrain mesh in {raw.name}", flush=True)
        return False
    write_glb_multimesh(out, meshes)
    return True


def bake_minimap(staged: Path, sid: str, maps_out: Path) -> bool:
    """Composite the staged minimap art + merge the bounds row — the same
    artifacts extract_minimaps.py writes for WG spaces. Returns True when
    either landed (bounds without art is still a win for the tactics view);
    docks without any art at all report False but are not fatal."""
    out_dir = maps_out / "minimaps"
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = maps_out / "minimaps.json"
    bounds_map: dict[str, dict[str, float]] = {}
    if json_path.exists():
        bounds_map = json.loads(json_path.read_text(encoding="utf-8"))

    water_p = staged / "minimap_water.png"
    land_p = staged / "minimap.png"
    settings_p = staged / "space.settings"

    got_bounds = False
    if settings_p.exists():
        b = parse_bounds(settings_p.read_text(encoding="utf-8", errors="replace"))
        if b:
            bounds_map[sid] = b
            got_bounds = True

    got_art = False
    if water_p.exists() or land_p.exists():
        from PIL import Image

        base = (Image.open(water_p).convert("RGBA")
                if water_p.exists() else None)
        if base is None:
            base = Image.new("RGBA", (MINIMAP_SIZE, MINIMAP_SIZE), (18, 34, 54, 255))
        if land_p.exists():
            land = Image.open(land_p).convert("RGBA")
            if land.size != base.size:
                land = land.resize(base.size, Image.LANCZOS)
            base.alpha_composite(land)
        out = base.convert("RGB").resize((MINIMAP_SIZE, MINIMAP_SIZE), Image.LANCZOS)
        out.save(out_dir / f"{sid}.webp", quality=85, method=6)
        legacy = out_dir / f"{sid}.png"
        if legacy.exists():
            legacy.unlink()
        got_art = True

    if got_bounds:
        # Same degenerate-entry hygiene + compact single-line format as
        # extract_minimaps.py (the committed file's form).
        bounds_map = {
            k: v for k, v in bounds_map.items()
            if v["maxX"] > v["minX"] and v["maxZ"] > v["minZ"]
        }
        json_path.write_text(json.dumps(bounds_map, sort_keys=True),
                             encoding="utf-8")
    return got_bounds or got_art


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", required=True, help="Lesta client install root")
    ap.add_argument("--stage", required=True, help="extraction dir (spaces/ tree)")
    ap.add_argument("--ooz", default=None, help="Oodle decoder for lesta_extract")
    ap.add_argument("--game-assets", default=None)
    ap.add_argument("--out", type=Path, default=MAPS_DIR)
    ap.add_argument("--terrain-step", type=int, default=2,
                    help="game-assets terrain sampling step (pack standard: 2)")
    ap.add_argument("--only", help="comma list of space ids")
    ap.add_argument("--limit", type=int, default=0, help="max spaces this run (0=all)")
    ap.add_argument("--force", action="store_true",
                    help="re-bake spaces whose GLB already exists (shared ids "
                         "are normally left to the WG bake)")
    args = ap.parse_args()

    game_assets = find_game_assets(args.game_assets)
    if not game_assets:
        print("error: game-assets not found (build it: just build game-assets).",
              file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    stage = Path(args.stage)
    stage.mkdir(parents=True, exist_ok=True)

    spaces = list_spaces(args.game_dir, game_assets)
    only = set(filter(None, (args.only or "").split(",")))
    if only:
        spaces = [s for s in spaces if s in only]
    todo = [s for s in spaces
            if args.force or not (args.out / f"{s}.glb").is_file()]
    if args.limit > 0:
        todo = todo[: args.limit]
    print(f"[bake-lesta-maps] {len(spaces)} spaces in install, "
          f"{len(spaces) - len(todo)} already baked (WG pack wins), "
          f"{len(todo)} to bake")
    if not todo:
        print("[bake-lesta-maps] nothing to do.")
        return 0

    raw_dir = stage / "rawglb"
    raw_dir.mkdir(parents=True, exist_ok=True)
    baked = failed = 0
    for i, sid in enumerate(todo):
        staged = stage_space(args.game_dir, stage, args.ooz, game_assets, sid)
        if staged is None:
            failed += 1
            continue
        raw = raw_dir / f"{sid}.glb"
        if not export_space_glb(game_assets, staged, raw, args.terrain_step):
            failed += 1
            continue
        target = args.out / f"{sid}.glb"
        if not bake_holo_glb(raw, target):
            failed += 1
            continue
        raw.unlink(missing_ok=True)
        # Art/bounds are best-effort companions, not bake gates.
        bake_minimap(staged, sid, args.out)
        baked += 1
        print(f"  [{i + 1}/{len(todo)}] + {sid} "
              f"({target.stat().st_size // 1024} KB)", flush=True)

    print(f"[bake-lesta-maps] done: {baked} baked, {failed} failed -> {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
