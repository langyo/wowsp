#!/usr/bin/env python3
"""Add the Lesta airplanes to the plane tables (plane_types.json / plane_models.json).

The carrier plane picker (ShipDetailModal) labels each embarked airframe by
its combat role and stages its baked GLB by GameParams index. The tables the
picker reads were generated from the WG client, so every airframe the Lesta
client introduces — the stock/tactical squadrons of the Lesta-only carrier
lines (Independence / Yorktown / Essex, Zuihō / Hiryū / Taihō, Ulyanovsk) —
was absent: the picker fell back to raw entity names with no role and no
model path, and the bake step (bake_lesta_planes.py) never saw them.

This script extracts those planes from the decoded Lesta GameParams and
merges them into both tables:

  plane_types.json  keyed by plane id: { index, name, type, count, role }
                    (`count` = numPlanesInSquadron; `role` derived from the
                    carried ammunition — the same rule as
                    extract_plane_types.py)
  plane_models.json keyed by entity name: "/content/.../<NAME>.geometry" —
                    the aircraft model path with the .model suffix swapped,
                    exactly how the WG entries are shaped

`type` (the coarse battle-HUD icon key: fighter / dive / scout / bomber /
torpedo / attack) is derived from the entity species + role, mirroring the
WG table's conventions (Skip-species and mine-role squadrons included).

Lesta rows carry `"lesta": true`, so the merge is idempotent — re-running
refreshes them from the given dump and drops rows the dump no longer
references — and bake_lesta_planes.py selects its bake set by that flag.

Sources:
  --input       decoded Lesta GameParams.json (default: the orchestrator
                cache %LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json)
  --lesta-tree  committed Lesta tree (default: src/data/tech_tree_lesta.json)
  --wg-tree     committed WG tree — scope filter (default: src/data/tech_tree.json)
  --types / --models  table paths (defaults: src/data/)

Usage:
    python scripts/model_convert/extract_lesta_planes.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
DATA_DIR = REPO / "packages" / "webui" / "src" / "data"
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"

sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "extract"))
from extract_plane_types import plane_role  # noqa: E402
from build_techtree import _params_root  # noqa: E402

# Coarse icon key per species, mirroring the WG table's conventions: Skip
# species and mine-role squadrons show as attack/dive rows there.
SPECIES_TYPES = {
    "Fighter": "fighter",
    "Dive": "dive",
    "Scout": "scout",
    "Bomber": "bomber",  # torpedo-carrying bombers get "torpedo" below
    "Skip": "attack",
    "Mine": "dive",
    "Smoke": "attack",
    "Airship": "attack",
    "Auxiliary": "attack",
}


class DictGameParams:
    """`entity(name)` lookups over an already-loaded dump, so `plane_role`
    (which walks ammunition references) works without a second mmap pass."""

    def __init__(self, root: dict):
        self.root = root

    def entity(self, name: str) -> dict | None:
        ent = self.root.get(name)
        return ent if isinstance(ent, dict) else None


def plane_type(entity: dict, role: str) -> str:
    species = str((entity.get("typeinfo") or {}).get("species") or "")
    if species == "Bomber" and role == "torpedo":
        return "torpedo"
    return SPECIES_TYPES.get(species, "attack")


def geometry_path(model: str) -> str | None:
    """The plane's VFS geometry path from its `.model` path (sibling file)."""
    if not model or not model.endswith(".model"):
        return None
    return "/" + model[: -len(".model")] + ".geometry"


def referenced_planes(entry: dict) -> set[str]:
    """Every `planes` reference inside a GameParams entry — an embarked
    squadron block is any dict value shaped `{ "planes": [<name>, …] }`
    (A_Fighter / A1_TorpedoBomber / AB_DiveBomber / …), wherever it sits."""
    out: set[str] = set()
    stack = [entry]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            planes = node.get("planes")
            if isinstance(planes, list):
                out.update(p for p in planes if isinstance(p, str))
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path, default=CACHE_DIR / "GameParams_lesta.json")
    ap.add_argument("--lesta-tree", type=Path, default=DATA_DIR / "tech_tree_lesta.json")
    ap.add_argument("--wg-tree", type=Path, default=DATA_DIR / "tech_tree.json")
    ap.add_argument("--types", type=Path, default=DATA_DIR / "plane_types.json")
    ap.add_argument("--models", type=Path, default=DATA_DIR / "plane_models.json")
    args = ap.parse_args()

    if not args.input.is_file():
        print(f"error: Lesta GameParams not found: {args.input}", file=sys.stderr)
        return 1

    root = _params_root(json.loads(args.input.read_text(encoding="utf-8")))
    if not isinstance(root, dict):
        print(f"error: unrecognized GameParams root in {args.input}", file=sys.stderr)
        return 1
    gp = DictGameParams(root)

    lesta_tree = json.loads(args.lesta_tree.read_text(encoding="utf-8"))
    wg_indexes = {n["index"] for n in json.loads(args.wg_tree.read_text(encoding="utf-8")).values()}
    lesta_only = {n["index"] for n in lesta_tree.values() if n["index"] not in wg_indexes}

    by_index: dict[str, dict] = {}
    for entry in root.values():
        if isinstance(entry, dict) and isinstance(entry.get("index"), str):
            by_index.setdefault(entry["index"], entry)

    wanted: set[str] = set()
    for index in sorted(lesta_only):
        ent = by_index.get(index)
        if ent is None:
            print(f"[lesta-planes] WARN no GameParams entity for {index}", file=sys.stderr)
            continue
        wanted |= referenced_planes(ent)

    plane_types: dict = json.loads(args.types.read_text(encoding="utf-8"), object_pairs_hook=dict)
    plane_models: dict = json.loads(args.models.read_text(encoding="utf-8"), object_pairs_hook=dict)

    # Refresh the Lesta-marked rows: drop what this dump no longer
    # references, then upsert every referenced plane.
    stale = {
        k for k, v in plane_types.items() if v.get("lesta") and v.get("name") not in wanted
    }
    for k in stale:
        stale_name = plane_types[k].get("name")
        plane_types.pop(k)
        if stale_name:
            plane_models.pop(stale_name, None)

    ammo_cache: dict = {}
    missing: list[str] = []
    added = refreshed = 0
    for name in sorted(wanted):
        ent = gp.entity(name)
        if ent is None:
            missing.append(name)
            continue
        pid = ent.get("id")
        index = ent.get("index")
        if not isinstance(pid, int) or not isinstance(index, str):
            missing.append(name)
            continue
        role = plane_role(gp, ent, ammo_cache)
        key = str(pid)
        refreshed += key in plane_types
        added += key not in plane_types
        plane_types[key] = {
            "index": index,
            "name": name,
            "type": plane_type(ent, role),
            "count": ent.get("numPlanesInSquadron", 1),
            "role": role,
            "lesta": True,
        }
        geom = geometry_path(ent.get("model", ""))
        if geom:
            plane_models[name] = geom
        else:
            print(f"[lesta-planes] WARN no model path for {name}", file=sys.stderr)

    # Preserve each table's committed layout: plane_types.json is a single
    # line in the WG writer's spaced style (extract_plane_types.py writes
    # json.dumps defaults), plane_models.json one entry per line (both LF) —
    # so a re-run leaves the existing bytes untouched and only the Lesta
    # rows move.
    args.types.write_text(
        json.dumps(plane_types, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    model_lines = [
        f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}"
        for k, v in plane_models.items()
    ]
    args.models.write_text(
        "{\n" + ",\n".join(model_lines) + "\n}",
        encoding="utf-8",
        newline="\n",
    )
    if missing:
        print(
            f"[lesta-planes] WARN entities not found in the dump: {', '.join(missing)}",
            file=sys.stderr,
        )
    print(
        f"[lesta-planes] {added} added, {refreshed} refreshed, {len(stale)} stale dropped — "
        f"{len(plane_types)} plane_types / {len(plane_models)} plane_models entries"
    )
    return 0 if not missing else 1


if __name__ == "__main__":
    raise SystemExit(main())
