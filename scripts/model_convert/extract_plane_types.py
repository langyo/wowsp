#!/usr/bin/env python3
"""Augment `packages/webui/src/data/plane_types.json` with a `role` field.

The frontend's plane model picker labels each baked airframe by its combat
role (torpedo bomber / HE bomber / AP bomber / rocket plane / HE+AP skip
bomber / ASW / minelayer / fighter / scout ...) instead of the raw GameParams
entity suffix ("Hakuryu stock"), which reads like a hull config and collides
across squadrons.

The role is derived from the plane entity in the full GameParams dump: the
aircraft's carried-ammunition reference (`bombName`) points at a projectile
entity whose `planeAmmoType` + `ammoType` decide the role; ammunitionless
aircraft fall back to their `typeinfo.species` (pure fighters vs scouts).

Existing fields (`index` / `name` / `type` / `count`) are preserved verbatim —
this script only adds or refreshes `role`, so it is safe to re-run after a
new GameParams extraction.

Inputs:
  --input : unpacked GameParams.json (default: the shared orchestrator cache
            at %LOCALAPPDATA%/WoWSP-extract/GameParams.json, same source
            scripts/extract_gameparams.py uses)

Run from a checkout that already has plane_types.json + plane_models.json
(both committed):

    python scripts/model_convert/extract_plane_types.py
"""
from __future__ import annotations

import argparse
import json
import mmap
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DATA_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"

DEFAULT_INPUT = Path.home() / "AppData" / "Local" / "WoWSP-extract" / "GameParams.json"

# role decided by the carried ammunition: planeAmmoType [+ ammoType].
AMMO_ROLES: dict[tuple[str, str], str] = {
    ("torpedo", "torpedo"): "torpedo",
    ("torpedo", "torpedo_deepwater"): "torpedo",
    ("bomb", "HE"): "heBomber",
    ("bomb", "AP"): "apBomber",
    ("skip", "HE"): "heSkip",
    ("skip", "AP"): "apSkip",
    ("rocket", "HE"): "rocket",
    ("rocket", "AP"): "rocket",
    ("depthcharge", "depthcharge"): "asw",
    ("mine", "seaMine"): "mine",
}

# Ammunitionless aircraft: fall back to the entity species.
SPECIES_ROLES: dict[str, str] = {
    "fighter": "fighter",
    "scout": "scout",
    "smoke": "smoke",
    "airship": "airship",
    "auxiliary": "auxiliary",
}


class GameParamsIndex:
    """Random-access reader for single-entity lookups in the big dump."""

    def __init__(self, path: Path):
        self._f = open(path, "rb")
        self._mm = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)

    def entity(self, name: str) -> dict | None:
        key = f'"{name}":'.encode()
        i = self._mm.find(key)
        if i < 0:
            return None
        j = self._mm.find(b"{", i)
        depth = 0
        k = j
        in_str = False
        esc = False
        while k < len(self._mm):
            c = self._mm[k:k + 1]
            if in_str:
                if esc:
                    esc = False
                elif c == b"\\":
                    esc = True
                elif c == b'"':
                    in_str = False
            else:
                if c == b'"':
                    in_str = True
                elif c == b"{":
                    depth += 1
                elif c == b"}":
                    depth -= 1
                    if depth == 0:
                        return json.loads(self._mm[j:k + 1].decode("utf-8"))
            k += 1
        return None


def plane_role(gp: GameParamsIndex, ent: dict, ammo_cache: dict[str, dict | None]) -> str:
    for field in ("bombName", "torpedoName", "rocketName", "skipBombName"):
        ref = ent.get(field)
        if not ref:
            continue
        if ref not in ammo_cache:
            ammo_cache[ref] = gp.entity(ref)
        ammo = ammo_cache[ref] or {}
        pair = (ammo.get("planeAmmoType", ""), ammo.get("ammoType", ""))
        role = AMMO_ROLES.get(pair)
        if role:
            return role
        # Known ammo family with an unmapped ammoType — keep the family label.
        family = pair[0]
        if family == "bomb":
            return "heBomber"
        if family == "skip":
            return "heSkip"
        if family == "rocket":
            return "rocket"
        if family == "torpedo":
            return "torpedo"
        break
    species = str(((ent.get("typeinfo") or {}).get("species")) or "").lower()
    return SPECIES_ROLES.get(species, species or "special")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT,
                    help="unpacked GameParams.json")
    args = ap.parse_args()

    if not args.input.exists():
        print(f"GameParams.json not found at {args.input} — run the orchestrator "
              "extract first (see scripts/extract_gameparams.py)", file=sys.stderr)
        return 1

    types_path = DATA_DIR / "plane_types.json"
    plane_types: dict = json.loads(types_path.read_text(encoding="utf-8"),
                                   object_pairs_hook=dict)

    gp = GameParamsIndex(args.input)
    ammo_cache: dict[str, dict | None] = {}
    changed = 0
    missing = 0
    for key, meta in plane_types.items():
        ent = gp.entity(meta["name"])
        if ent is None:
            missing += 1
            continue
        role = plane_role(gp, ent, ammo_cache)
        if meta.get("role") != role:
            changed += 1
        meta["role"] = role

    with open(types_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(plane_types, ensure_ascii=False) + "\n")
    print(f"[plane-types] {len(plane_types)} entries, {changed} roles updated, "
          f"{missing} entities missing from GameParams")
    return 0 if missing < len(plane_types) else 1


if __name__ == "__main__":
    sys.exit(main())
