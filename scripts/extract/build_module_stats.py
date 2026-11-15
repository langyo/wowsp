#!/usr/bin/env python3
"""Extract per-module stats for the ships UI's module-chain tooltip cards.

Output (one file per realm, compact JSON):

  packages/webui/src/data/ship_module_stats.json        WG      (wg-<build>)
  packages/webui/src/data/ship_module_stats_lesta.json  Lesta   (lesta-<build>)

Schema (keyed by the chain bundle's module entry NAME, which is exactly what
BuildPlanner's 装备选择 tooltip cards and the specs panel join on):

  {"source": "wg-<build>",
   "modules": {
     "<ModuleKey>": {"gpid": <int|null>, "ucType": "_Hull",
                     "kind": "hull|artillery|torpedoes|suo|engine|other",
                     "health": <int|null>,      # hull HP
                     "rangeM": <int|null>,      # artillery mount maxDist (m)
                     "reloadS": <num|null>}}}   # first hardpoint shotDelay (s)

JOIN PATH (verified on build wg-13533378): a chain step's name is its
ShipUpgradeInfo ENTRY name ("PJUA931_D10_ART_STOCK"), while the stat-bearing
entities hang off the ship subtree under the entry's COMPONENT names
("AB_127_50"). So each step resolves through its own bundled components map
(step.components[role]) to the ship subtree's entity of the role matching the
step's ucType (hull / artillery / torpedoes / fireControl / engine). The ship
subtree itself is located by its "index" field ("PJSD012"), the same key the
chain bundle records per ship.

Field shapes (current client): a Hull component carries "health"; an
Artillery mount carries "maxDist" (the firing range in meters — Shimakaze's
AB_127_50.maxDist=11370 renders as the 11.4 km spec row) and per-hardpoint
"shotDelay" reloads under HP_* keys; a Torpedo-tube config carries the same
HP_* shotDelay layout (its shells' "maxDist" does NOT decode to the
displayed km, so torpedo rangeM stays null rather than guessing). Fire
control / engine variants change nothing the card shows; they are listed
with null stats so the accessor can distinguish "known empty" from
"unextracted".

Input: the realm's decoded GameParams dump (the shared WoWSP-extract cache —
the same file build_upgrade_chain.py reads). Chain steps whose entity never
resolves are reported (never invented).

Usage:
    python scripts/extract/build_module_stats.py --realm wg
    python scripts/extract/build_module_stats.py --realm lesta
    python scripts/extract/build_module_stats.py --realm wg \
        --gameparams "%LOCALAPPDATA%/WoWSP-extract/GameParams.json" --out ...
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

REPO = HERE.parent.parent
SRC_DATA = REPO / "packages/webui/src/data"
CACHE = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"
DUMP_DEFAULTS = {
    "wg": CACHE / "GameParams.json",
    "lesta": CACHE / "GameParams_lesta.json",
}
BUILD_SIDECARS = {
    "wg": CACHE / "GameParams.json.build",
    "lesta": CACHE / "GameParams_lesta.json.build",
}
CHAIN_PATHS = {
    "wg": SRC_DATA / "ship_upgrade_chain.json",
    "lesta": SRC_DATA / "ship_upgrade_chain_lesta.json",
}
OUT_PATHS = {
    "wg": SRC_DATA / "ship_module_stats.json",
    "lesta": SRC_DATA / "ship_module_stats_lesta.json",
}

# ucType -> the components-map ROLE whose entity carries the slot's stats.
UC_ROLE = {
    "_Hull": "hull",
    "_Artillery": "artillery",
    "_Torpedoes": "torpedoes",
    "_Suo": "fireControl",
    "_FireControl": "fireControl",
    "_Engine": "engine",
}
# ucType -> the card's kind tag.
UC_KINDS = {
    "_Hull": "hull",
    "_Artillery": "artillery",
    "_Torpedoes": "torpedoes",
    "_Suo": "suo",
    "_FireControl": "suo",
    "_Engine": "engine",
}

HARDPOINT_RE = re.compile(r"^HP_", re.IGNORECASE)


def iter_ship_subtrees(txt: str):
    """Yield parsed ship subtrees (entries carrying a ShipUpgradeInfo dict).

    Same top-level slicing build_planner_data.py uses: the dump is
    pretty-printed with two-space indentation, so entry starts line up on
    \n  " and each body parses standalone once trailing commas are shed.
    """
    starts = [m.start() for m in re.finditer(r'\n  "', txt)]
    starts.append(len(txt))
    for i in range(len(starts) - 1):
        seg = txt[starts[i]:starts[i + 1]]
        if '"ShipUpgradeInfo"' not in seg:
            continue
        m = re.match(r'\n  "([^"]+)": ', seg)
        if not m:
            continue
        body = seg[m.end():].rstrip()
        while body.endswith(","):
            body = body[:-1].rstrip()
        try:
            entry = json.loads(body)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("ShipUpgradeInfo"), dict):
            yield m.group(1), entry


def first_hardpoint_shot_delay(ent: dict) -> float | None:
    """shotDelay of the entity's first HP_* hardpoint (key order matches the
    game's mount layout); None when the entity has none."""
    for key in sorted(ent.keys()):
        if not HARDPOINT_RE.match(key):
            continue
        hp = ent[key]
        if isinstance(hp, dict):
            delay = hp.get("shotDelay")
            if isinstance(delay, (int, float)) and not isinstance(delay, bool):
                return float(delay)
    return None


def stats_for(uc_type: str, ent: dict) -> dict:
    kind = UC_KINDS.get(uc_type, "other")
    out = {"gpid": ent.get("id") if isinstance(ent.get("id"), int) else None,
           "ucType": uc_type, "kind": kind,
           "health": None, "rangeM": None, "reloadS": None}
    if kind == "hull":
        health = ent.get("health")
        if isinstance(health, (int, float)) and not isinstance(health, bool):
            out["health"] = int(health)
    elif kind == "artillery":
        dist = ent.get("maxDist")
        if isinstance(dist, (int, float)) and not isinstance(dist, bool):
            out["rangeM"] = int(dist)
        out["reloadS"] = first_hardpoint_shot_delay(ent)
    elif kind == "torpedoes":
        # The tube's HP_* shotDelay IS the displayed reload (Shimakaze's
        # A1_610 → 150 s); its shells' maxDist does not decode to the
        # displayed km, so range stays null instead of guessing.
        out["reloadS"] = first_hardpoint_shot_delay(ent)
    return out


def steps_of(chain: dict):
    """(shipIndex, stepName, ucType) for every module step of a bundle,
    deduplicated by step name (a module entity is shared across hulls; its
    stats are identical wherever it mounts)."""
    out: dict[str, tuple[str, str]] = {}
    for record in (chain.get("ships") or {}).values():
        index = str(record.get("index") or "")
        for slot in record.get("slots") or []:
            uc = str(slot.get("ucType") or "")
            for step in slot.get("steps") or []:
                name = str(step.get("name") or "")
                if name and name not in out:
                    out[name] = (index, uc)
    return out


def entity_for_role(ship: dict, uc_type: str, step: dict) -> dict | None:
    """The ship subtree entity this step mounts for its own slot's role,
    via the step's bundled components map (hull steps mount the swapped
    weapons too — only the ucType's own role answers for stats). ucTypes
    outside the card model (CV armament chains, sonar, abilities, shields,
    …) resolve through their first mountable component so the pack can list
    them as known-empty "other" rows instead of looking unextracted."""
    comps = step.get("components") or {}
    role = UC_ROLE.get(uc_type)
    roles = [role] if role else list(comps.keys())
    for want in roles:
        for name in comps.get(want) or []:
            ent = ship.get(name)
            if isinstance(ent, dict):
                return ent
    return None


def build(realm: str, dump_path: Path, chain_path: Path, out_path: Path) -> dict:
    chain = json.loads(chain_path.read_text(encoding="utf-8"))
    steps = steps_of(chain)
    # shipIndex -> [(stepName, ucType, stepDict), ...]; plus per-ship step
    # dicts (the components map rides the chain bundle, not the dump).
    by_index: dict[str, list] = {}
    for record in (chain.get("ships") or {}).values():
        index = str(record.get("index") or "")
        if not index:
            continue
        rows = []
        for slot in record.get("slots") or []:
            uc = str(slot.get("ucType") or "")
            for step in slot.get("steps") or []:
                name = str(step.get("name") or "")
                if name:
                    rows.append((name, uc, step))
        if rows:
            by_index[index] = rows

    modules: dict[str, dict] = {}
    missing: set[str] = set(steps.keys())
    seen_subtrees = 0
    txt = dump_path.read_text(encoding="utf-8")
    for _key, ship in iter_ship_subtrees(txt):
        seen_subtrees += 1
        index = str(ship.get("index") or "")
        rows = by_index.get(index)
        if not rows:
            continue
        for name, uc, step in rows:
            if name not in missing:
                continue
            ent = entity_for_role(ship, uc, step)
            if ent is None:
                continue
            modules[name] = stats_for(uc, ent)
            missing.discard(name)

    build = ""
    sidecar = BUILD_SIDECARS[realm]
    if sidecar.is_file():
        build = sidecar.read_text(encoding="utf-8").strip()
    out = {"source": f"{realm}-{build}" if build else realm,
           "modules": modules}
    out_path.write_text(json.dumps(out, ensure_ascii=False,
                                   separators=(",", ":")), encoding="utf-8")
    return {"realm": realm, "subtrees": seen_subtrees,
            "wanted": len(steps), "resolved": len(modules),
            "missing": sorted(missing), "out": str(out_path),
            "bytes": out_path.stat().st_size}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--realm", choices=("wg", "lesta"), default="wg")
    ap.add_argument("--gameparams", default=None,
                    help="decoded GameParams dump (default: the shared cache file)")
    ap.add_argument("--chain", default=None,
                    help="chain bundle to enumerate (default: the bundled realm file)")
    ap.add_argument("--out", default=None,
                    help="output pack (default: the bundled realm file)")
    args = ap.parse_args()
    dump = Path(args.gameparams) if args.gameparams else DUMP_DEFAULTS[args.realm]
    chain = Path(args.chain) if args.chain else CHAIN_PATHS[args.realm]
    out = Path(args.out) if args.out else OUT_PATHS[args.realm]
    if not dump.is_file():
        ap.error(f"GameParams dump not found: {dump}")
    if not chain.is_file():
        ap.error(f"chain bundle not found: {chain}")
    report = build(args.realm, dump, chain, out)
    print(json.dumps({k: v for k, v in report.items() if k != "missing"},
                     indent=2))
    if report["missing"]:
        print(f"[module-stats] WARNING: {len(report['missing'])} module names "
              f"resolved to no dump entity (first few: "
              f"{report['missing'][:8]})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
