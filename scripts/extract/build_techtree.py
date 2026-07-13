"""Build the tech-tree topology data consumed by the ship tech-tree view.

Outputs `packages/webui/src/res/data/tech_tree.json`: a map of shipId → a slim
node record carrying just what the renderer needs (tier, type, name, rarity,
archetype, and the shipIds it unlocks). Only researchable tech-tree ships
(WG `group in {start, upgradeable}`) plus their premium/special neighbours are
emitted; collectors / event ships with no tech-tree attachment are dropped.

Inputs:
  --bridge       wowsinfo.json (ship_id → index/group/nextShips/type/...)
  --gameparams   GameParams.json (index → archetype, for branch-flavour labels)
  --rarity       res/data/ship_rarity.json (shipId → rarity band)
  --out          output json path

The join key chain is:
    ship_id  →  (wowsinfo.json)  →  index, group, nextShips
                                            ↓ for archetype
                          (GameParams.json, by index)  →  archetype
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

# Tech-tree-eligible groups: tier-1 starters chain into researchable ships.
TREE_GROUPS = {"start", "upgradeable"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", required=True, help="wowsinfo.json")
    ap.add_argument("--gameparams", required=True, help="GameParams.json")
    ap.add_argument("--rarity", required=True, help="ship_rarity.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    print(f"[techtree] loading bridge {args.bridge} ...", flush=True)
    bridge = json.loads(Path(args.bridge).read_text(encoding="utf-8"))
    ships = bridge.get("ships", {})

    print(f"[techtree] loading rarity {args.rarity} ...", flush=True)
    rarity_map = json.loads(Path(args.rarity).read_text(encoding="utf-8"))

    print(f"[techtree] loading gameparams {args.gameparams} ...", flush=True)
    gp = json.loads(Path(args.gameparams).read_text(encoding="utf-8"))
    # index → archetype (Ship entities only).
    index_to_archetype: dict[str, str] = {}
    for name, obj in gp.items():
        if not isinstance(obj, dict):
            continue
        ti = obj.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        idx = obj.get("index")
        arch = obj.get("archetype")
        if isinstance(idx, str) and isinstance(arch, str):
            index_to_archetype[idx] = arch

    # First pass: collect tech-tree nodes keyed by shipId.
    tree: dict[str, dict] = {}
    for sid, s in ships.items():
        if not isinstance(s, dict):
            continue
        group = s.get("group")
        if group not in TREE_GROUPS:
            continue
        idx = s.get("index")
        tree[str(sid)] = {
            "shipId": int(sid),
            "index": idx,
            "name": s.get("name", ""),
            "tier": s.get("tier", 0),
            "type": s.get("type", ""),
            "nation": _nation_from_region(s.get("region", "")),
            "isPremium": False,
            "isSpecial": False,
            "rarity": rarity_map.get(str(sid), "Common"),
            "archetype": index_to_archetype.get(idx, "Undefined"),
            "nextShips": [int(x) for x in (s.get("nextShips") or [])],
            "group": group,
        }

    # Second pass: attach premium/special ships that are direct successors of
    # a tech-tree node (some "special" ships hang off a tree node as a leaf in
    # the in-game UI). We add them with isPremium/isSpecial set so the renderer
    # can style them as side leaves.
    tree_ids = set(tree.keys())
    for sid, node in list(tree.items()):
        for nx in node["nextShips"]:
            nxs = str(nx)
            if nxs in tree_ids:
                continue
            s = ships.get(nxs)
            if not isinstance(s, dict):
                continue
            idx = s.get("index")
            tree[nxs] = {
                "shipId": nx,
                "index": idx,
                "name": s.get("name", ""),
                "tier": s.get("tier", 0),
                "type": s.get("type", ""),
                "nation": _nation_from_region(s.get("region", "")),
                "isPremium": s.get("group") == "premium",
                "isSpecial": s.get("group") in {"special", "specialUnsellable", "clan"},
                "rarity": rarity_map.get(nxs, "Common"),
                "archetype": index_to_archetype.get(idx, "Undefined"),
                "nextShips": [],
                "group": s.get("group", ""),
            }
            tree_ids.add(nxs)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(tree, separators=(",", ":")), encoding="utf-8")

    # Stats.
    by_nation: dict[str, int] = {}
    by_arch: dict[str, int] = {}
    for n in tree.values():
        by_nation[n["nation"]] = by_nation.get(n["nation"], 0) + 1
        by_arch[n["archetype"]] = by_arch.get(n["archetype"], 0) + 1
    print(f"[techtree] wrote {len(tree)} nodes to {out}")
    print(f"[techtree] by nation: {dict(sorted(by_nation.items(), key=lambda kv: -kv[1]))}")
    print(f"[techtree] by archetype: {dict(sorted(by_arch.items(), key=lambda kv: -kv[1]))}")


# wowsinfo region string → WG encyclopedia nation code used everywhere else.
# wowsinfo regions are lowercase_with_underscore ("usa","united_kingdom",
# "pan_america",...); the only renames needed are the codes that differ from
# the encyclopedia's naming.
_REGION_RENAMES = {
    "united_kingdom": "uk",
    "russia": "ussr",
    "europe": "pan_europe",  # in-game "Europe" crest = our pan_europe slot
}


def _nation_from_region(region: str) -> str:
    if not region:
        return ""
    r = region.lower()
    return _REGION_RENAMES.get(r, r)


if __name__ == "__main__":
    main()
