"""Build the tech-tree topology data consumed by the ship tech-tree view.

Outputs a map of shipId → a slim node record carrying just what the renderer
needs (tier, type, name, rarity, archetype, and the shipIds it unlocks). Only
researchable tech-tree ships (group in {start, upgradeable}) plus, in bridge
mode, their premium/special neighbours are emitted; collectors / event ships
with no tech-tree attachment are dropped.

Two sources (--source):

  bridge (default)  The WG-cluster research graph from wowsinfo.json
                    (ship_id → index/group/nextShips/type/...), joined with
                    GameParams.json for archetype. Premium/special side
                    leaves come from the bridge's nextShips. This is the
                    WG tree — wowsinfo is built from the WG live API.
  gameparams        The research graph read straight out of a game client's
                    GameParams.json: each ship's ShipUpgradeInfo top-hull
                    upgrade entry lists the ships it unlocks (`nextShips`).
                    Used for the Lesta tree, where no wowsinfo-equivalent
                    bridge exists. Research lines plus their supership
                    continuations are emitted — GameParams carries no
                    linkage for premium/special side leaves, so those stay
                    WG-tree-only.

The join key chain (bridge mode):
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
# gameparams mode additionally keeps superships: a tier-10 research ship's
# top-hull upgrade lists the ★ ship as its unlock, so they wire in as chain
# continuations exactly like the WG tree's bridge-fed superShip nodes.
GAMEPARAMS_TREE_GROUPS = TREE_GROUPS | {"superShip"}

# GameParams typeinfo.nation spellings that differ from the stored nation
# codes (same renames as the wowsinfo region map below).
_GAMEPARAMS_NATION_RENAMES = {
    "united_kingdom": "uk",
    "russia": "ussr",
    "europe": "pan_europe",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=("bridge", "gameparams"), default="bridge")
    ap.add_argument("--bridge", help="wowsinfo.json (bridge mode)")
    ap.add_argument("--gameparams", required=True, help="GameParams.json")
    ap.add_argument("--rarity", required=True, help="ship_rarity.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.source == "bridge" and not args.bridge:
        ap.error("--bridge is required with --source bridge")

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

    if args.source == "gameparams":
        tree = _tree_from_gameparams(gp, rarity_map)
    else:
        tree = _tree_from_bridge(args.bridge, gp, index_to_archetype, rarity_map)

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


# ── bridge source (WG tree) ─────────────────────────────────────────────


def _tree_from_bridge(
    bridge_path: str,
    gp: dict,
    index_to_archetype: dict[str, str],
    rarity_map: dict,
) -> dict:
    print(f"[techtree] loading bridge {bridge_path} ...", flush=True)
    bridge = json.loads(Path(bridge_path).read_text(encoding="utf-8"))
    ships = bridge.get("ships", {})

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
    return tree


# ── gameparams source (Lesta tree) ──────────────────────────────────────


def _tree_from_gameparams(gp: dict, rarity_map: dict) -> dict:
    # Ship entities keyed by their index (the entry key itself carries
    # suffixes — "PVSB018_Ipiranga" — so go through the `index` field). The
    # raw entry key is kept alongside: ShipUpgradeInfo's nextShips reference
    # ships by that key, not by the bare index.
    by_index: dict[str, dict] = {}
    key_to_index: dict[str, str] = {}
    for key, obj in gp.items():
        if not isinstance(obj, dict):
            continue
        ti = obj.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        idx = obj.get("index")
        if isinstance(idx, str):
            by_index[idx] = obj
            key_to_index[key] = idx

    # Research edges: each ship's ShipUpgradeInfo top-hull upgrade lists the
    # ships it unlocks (`nextShips`). The listed values are GameParams entry
    # keys ("PVSB019_Los_Andes"), not bare indexes ("PVSB019") — resolve both
    # spellings. Union over all upgrade entries — only hull upgrades carry
    # them in practice.
    edges: dict[str, set] = {}
    for idx, e in by_index.items():
        sui = e.get("ShipUpgradeInfo")
        if not isinstance(sui, dict):
            continue
        for u in sui.values():
            if not isinstance(u, dict):
                continue
            ns = u.get("nextShips")
            if not isinstance(ns, list):
                continue
            resolved = set()
            for x in ns:
                if not isinstance(x, str):
                    continue
                if x in by_index:
                    resolved.add(x)
                elif x in key_to_index:
                    resolved.add(key_to_index[x])
            if resolved:
                edges.setdefault(idx, set()).update(resolved)

    # First pass: researchable nodes keyed by shipId.
    tree: dict[str, dict] = {}
    for idx, e in by_index.items():
        if e.get("group") not in GAMEPARAMS_TREE_GROUPS:
            continue
        nation = _nation_from_gameparams((e.get("typeinfo") or {}).get("nation", ""))
        if not nation or nation == "events":
            continue
        sid = e.get("id")
        tree[str(sid)] = {
            "shipId": int(sid),
            "index": idx,
            "name": f"IDS_{idx}",
            "tier": e.get("level", 0),
            "type": (e.get("typeinfo") or {}).get("species", ""),
            "nation": nation,
            "isPremium": False,
            "isSpecial": False,
            "rarity": rarity_map.get(str(sid), "Common"),
            "archetype": e.get("archetype") or "Undefined",
            "nextShips": [],
            "group": e.get("group"),
        }

    # Wire the unlock edges between researchable nodes, tier-then-index
    # ordered so fork columns render deterministically.
    id_by_index = {n["index"]: n["shipId"] for n in tree.values()}
    node_by_index = {n["index"]: n for n in tree.values()}
    for idx, ns in edges.items():
        node = node_by_index.get(idx)
        if node is None:
            continue
        kids = sorted(
            (node_by_index[x] for x in ns if x in node_by_index),
            key=lambda n: (n["tier"], n["index"]),
        )
        seen = set(node["nextShips"])
        for k in kids:
            if k["shipId"] not in seen:
                node["nextShips"].append(k["shipId"])
                seen.add(k["shipId"])
    return tree


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


def _nation_from_gameparams(nation: str) -> str:
    if not nation:
        return ""
    r = nation.lower()
    return _GAMEPARAMS_NATION_RENAMES.get(r, r)


if __name__ == "__main__":
    main()
