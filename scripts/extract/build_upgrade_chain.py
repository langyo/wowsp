#!/usr/bin/env python3
"""Build the per-ship upgrade-chain data consumed by the ships UI (webui).

Two realm bundles are emitted (the ships view's WG/Lesta switch picks one):

  packages/webui/src/data/ship_upgrade_chain.json         WG      (wg-<build>)
  packages/webui/src/data/ship_upgrade_chain_lesta.json   Lesta   (lesta-<build>)

Per ship (keyed by stringified shipId, like tech_tree.json):

  {gameVersion, source, ships: {<shipId>: {
      index,                              # GameParams index ("PRSD207")
      research: {xp, credits, gold},      # ShipUpgradeInfo ship-level economy
      next: {<nextShipId>: {              # every ship this one unlocks
        index,
        xpShip,                           # the NEXT ship's own costXP
        xpWithModules,                    # null: unavailable in GameParams
        requiredModules,                  # null: unavailable in GameParams
      }},
      slots: [{ucType, steps: [           # one bracket per module slot
        {name, gpid, prev, depth, isStock, xp: null, credits: null,
         components, unlocks?},
      ]}],
  }}}

`research` is the ship-level economy of THAT ship, straight from its
ShipUpgradeInfo scalars: costXP = XP needed to research it from its
predecessor, costCR = credits to buy it in port, costGold = doubloon price
(premiums). `next.*.xpShip` is the unlocked (next) ship's own costXP, which is
what the tech-tree connector tooltip renders as the minimal case. Per-module
XP/credits are NOT present in GameParams in current client builds (the
client-UI economy layer holds them) — the per-step xp/credits and the
`xpWithModules`/`requiredModules` pair stay null until such a source is
extracted, so the schema does not have to change when it lands.

`slots` follows the game's own module structure: entries grouped by `ucType`,
each slot ordered by upgrade depth (stock -> top) along the `prev` chains —
the same modules shipParts.ts resolves at runtime. Each step carries its raw
`prev` (the GameParams upgrade entry key it upgrades from; null for stock)
and its `depth` (the upgrade level within the bracket: stock = 0, parallel
variants of the same level share a depth, and a module whose `prev` points
into another bracket — a hull-locked gun/torpedo top — sits one level above
the slot's stock). Steps are ordered by (depth, table order) so alternatives
sit adjacent. `gpid` is the module entry's numeric GameParams ID — the
client's synced price catalog keys its items by exactly that number, so a
captured price_catalog.json joins straight onto the step (null on
slice/bundle-fallback generations, which carry no top-level model ids).
`components` is the entry's component-name map verbatim (hull entries list
every mounted role); `unlocks` carries the numeric shipIds of the entry's
`nextShips`, resolved here so the webui needs no GameParams to map module ->
unlocked ship.

Input resolution order (first available wins; --gameparams always wins):

  WG:
    1. --gameparams <path> — a full decoded GameParams.json
    2. the orchestrator cache %LOCALAPPDATA%/WoWSP-extract/GameParams.json —
       the same dump run.py's techtree module feeds build_techtree.py. Its
       `.build` sidecar stamps the output gameVersion as wg-<build>.
    3. the per-ship GameParams SLICE directory (--slices, default
       packages/webui/src/res/data/gameparams): one verbatim ship subtree per
       <shipId>.json plus build.txt, as cut by extract_gameparams.py for
       install-less builds (gitignored — only present after that extraction).
       The entry key is the subtree's `name` field.
  Lesta:
    1. --gameparams <path> — a full decoded Lesta GameParams_lesta.json
    2. the orchestrator cache %LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json
       (+ its `.build` sidecar)
    3. the committed Lesta slice bundle
       packages/app/tauri/data/lesta_ship_gameparams.json.gz — the Lesta-ONLY
       hulls (build_lesta_shipdata.py's scope: every Lesta-realm ship the WG
       client has no entity for). That covers the Lesta-only tree lines but
       not the shared ships' chains or their key->id joins, so a bundle-only
       run reports the reduced tree coverage instead of faking it.

Unlock targets are GameParams entry keys ("PRSD208_Pr_30"), not bare
indexes; they resolve through the dump's own key and index tables (the
key_to_index join build_techtree.py does), plus the index prefix before "_"
as a last resort. Unresolvable targets are dropped and reported.

Usage:
    python scripts/extract/build_upgrade_chain.py --realm wg --out ...
    python scripts/extract/build_upgrade_chain.py --realm lesta \
        --gameparams "%LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json" --out ...
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from pathlib import Path

# Make sibling modules importable when run as a script.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from build_techtree import _params_root  # noqa: E402  (same dir; dump normalization)

REPO = HERE.parent.parent
SRC_DATA = REPO / "packages/webui/src/data"
DEFAULT_SLICES = REPO / "packages/webui/src/res/data/gameparams"
DEFAULT_LESTA_BUNDLE = REPO / "packages/app/tauri/data/lesta_ship_gameparams.json.gz"
TREES = {
    "wg": SRC_DATA / "tech_tree.json",
    "lesta": SRC_DATA / "tech_tree_lesta.json",
}

# Shared intermediate caches, same paths run.py uses.
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"
CACHE_DUMPS = {
    "wg": CACHE_DIR / "GameParams.json",
    "lesta": CACHE_DIR / "GameParams_lesta.json",
}

# Canonical slot order for the module-chain UI: hull first (its stock column is
# the panel's anchor), then fire control / guns / engine / torpedoes — the game's
# equipment-tab order — with every other ucType (carrier squad controls, sonar,
# secondary batteries, abilities) following alphabetically.
SLOT_ORDER = {"hull": 0, "suo": 1, "artillery": 2, "engine": 3, "torpedoes": 4}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--realm", choices=("wg", "lesta"), default="wg")
    ap.add_argument(
        "--gameparams",
        help="full decoded GameParams.json for the realm (default: the shared "
             "orchestrator cache, then the realm's slice fallback)",
    )
    ap.add_argument(
        "--slices",
        help="per-ship GameParams slice directory for the WG fallback (default: "
             "packages/webui/src/res/data/gameparams)",
    )
    ap.add_argument(
        "--lesta-bundle",
        help="committed Lesta slice bundle for the Lesta fallback (default: "
             "packages/app/tauri/data/lesta_ship_gameparams.json.gz)",
    )
    ap.add_argument(
        "--version",
        help="gameVersion stamp override (default: <realm>-<build> from the "
             "dump's .build sidecar / the slices' build.txt / the bundle stamp)",
    )
    ap.add_argument("--out", required=True, help="output JSON path")
    args = ap.parse_args()

    if args.gameparams and not Path(args.gameparams).is_file():
        ap.error(f"GameParams dump not found: {args.gameparams}")

    entries, key_to_id, index_to_id, module_ids, version, source = _load_source(args)
    print(f"[upgrade-chain] source: {source} ({len(entries)} ship entries, stamp {version})")

    ships: dict[str, dict] = {}
    stats = _Stats()
    for sid, entry in entries.items():
        sui = entry.get("ShipUpgradeInfo")
        if not isinstance(sui, dict):
            continue
        record = _build_ship(entry, sui, entries, key_to_id, index_to_id, module_ids, stats)
        if record is not None:
            ships[sid] = record
    if not ships:
        sys.exit("[upgrade-chain] ERROR: no ship carried ShipUpgradeInfo — wrong input?")

    payload = {"gameVersion": version, "source": "gameparams", "ships": ships}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")

    _report(out, args.realm, version, ships, stats)


class _Stats:
    def __init__(self) -> None:
        self.next_edges = 0
        self.xp_ship_known = 0
        self.unresolved_targets: set[str] = set()
        self.ships_with_next = 0
        self.slots = 0
        self.steps = 0
        self.steps_with_gpid = 0
        self.unlock_steps = 0
        self.parallel_slots = 0
        self.cross_slot_prev = 0
        self.max_depth = 0
        self.kinds: dict[str, int] = {}


def _load_source(args):
    """Resolve the realm's input, see the module docstring for the order.

    Returns (entries, key_to_id, index_to_id, module_ids, gameVersion, source label);
    entries maps stringified shipId -> the ship's GameParams entry, module_ids
    maps a GameParams entity key -> its numeric id (the price-catalog join key;
    empty for the slice/bundle fallbacks, which carry no top-level models).
    """
    realm: str = args.realm
    cache = CACHE_DUMPS[realm]
    dumps = [Path(args.gameparams)] if args.gameparams else []
    dumps.append(cache)
    for dump in dumps:
        if not dump.is_file():
            continue
        gp = _load_dump(dump)
        entries, key_to_id, index_to_id, module_ids = _dump_tables(gp)
        version = args.version or _sidecar_stamp(realm, dump) or realm
        return entries, key_to_id, index_to_id, module_ids, version, f"{realm} GameParams dump {dump}"
    if realm == "wg":
        slices = Path(args.slices) if args.slices else DEFAULT_SLICES
        if not slices.is_dir():
            sys.exit(
                f"[upgrade-chain] ERROR: no WG GameParams dump in {cache} and no slice "
                f"directory at {slices} — run 'just extract' to build the dump first."
            )
        entries, key_to_id, index_to_id = _load_slices(slices)
        build = _read_build_txt(slices)
        version = args.version or (f"wg-{build}" if build else "wg")
        return entries, key_to_id, index_to_id, {}, version, f"wg slice directory {slices}"
    bundle = Path(args.lesta_bundle) if args.lesta_bundle else DEFAULT_LESTA_BUNDLE
    if not bundle.is_file():
        sys.exit(
            f"[upgrade-chain] ERROR: no Lesta GameParams dump in {cache} and no Lesta "
            f"slice bundle at {bundle}."
        )
    entries, key_to_id, index_to_id, stamp = _load_lesta_bundle(bundle)
    return entries, key_to_id, index_to_id, {}, args.version or stamp or "lesta", f"Lesta slice bundle {bundle}"


def _load_dump(path: Path) -> dict:
    print(f"[upgrade-chain] loading gameparams {path} ...", flush=True)
    with path.open(encoding="utf-8") as fh:
        return _params_root(json.load(fh))


def _dump_tables(
    gp: dict,
) -> tuple[dict[str, dict], dict[str, str], dict[str, str], dict[str, int]]:
    """Split a full GameParams dump into ship tables plus the entity-id table.

    Returns (entries by shipId, key->shipId, index->shipId, entityKey->numeric id).

    Only Ship entities qualify for the ship tables. A ship id can in principle
    be carried by more than one Ship entity; prefer the one carrying
    ShipUpgradeInfo (defensive — current client dumps hold exactly one Ship
    entry per id, the other shared-id entities are non-Ship module/air-group
    entries). The entity-id table covers EVERY top-level model (modules
    included) because the client's price catalog keys its items by that
    numeric id — the join the economy fill needs.
    """
    entries: dict[str, dict] = {}
    key_to_id: dict[str, str] = {}
    index_to_id: dict[str, str] = {}
    module_ids: dict[str, int] = {}
    for key, obj in gp.items():
        if isinstance(obj, dict) and isinstance(obj.get("id"), int):
            module_ids[key] = obj["id"]
    for key, obj in gp.items():
        if not isinstance(obj, dict):
            continue
        ti = obj.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        sid, idx = obj.get("id"), obj.get("index")
        if not isinstance(sid, int) or not isinstance(idx, str):
            continue
        sid_str = str(sid)
        if sid_str in entries and not isinstance(obj.get("ShipUpgradeInfo"), dict):
            # Keep the upgrade-bearing entry; the key still resolves.
            key_to_id[key] = sid_str
            index_to_id.setdefault(idx, sid_str)
            continue
        entries[sid_str] = obj
        key_to_id[key] = sid_str
        index_to_id.setdefault(idx, sid_str)
        name = obj.get("name")
        if isinstance(name, str):
            key_to_id.setdefault(name, sid_str)
    return entries, key_to_id, index_to_id, module_ids


def _load_slices(slices: Path) -> tuple[dict[str, dict], dict[str, str], dict[str, str]]:
    """Load a per-ship slice directory (extract_gameparams.py output, format v2)."""
    files = sorted(p for p in slices.iterdir() if p.suffix == ".json" and p.stem.isdigit())
    if not files:
        sys.exit(f"[upgrade-chain] ERROR: no <shipId>.json slices in {slices}")
    print(f"[upgrade-chain] loading {len(files)} GameParams slices from {slices} ...", flush=True)
    entries: dict[str, dict] = {}
    key_to_id: dict[str, str] = {}
    index_to_id: dict[str, str] = {}
    for path in files:
        with path.open(encoding="utf-8") as fh:
            obj = json.load(fh)
        if not isinstance(obj, dict):
            continue
        sid = path.stem
        entries[sid] = obj
        idx = obj.get("index")
        if isinstance(idx, str):
            index_to_id.setdefault(idx, sid)
            key_to_id.setdefault(idx, sid)
        name = obj.get("name")
        if isinstance(name, str):
            key_to_id.setdefault(name, sid)
    return entries, key_to_id, index_to_id


def _load_lesta_bundle(bundle: Path) -> tuple[dict[str, dict], dict[str, str], dict[str, str], str | None]:
    """Load the committed Lesta-only slice bundle (gzip JSON, slice format 2)."""
    print(f"[upgrade-chain] loading Lesta slice bundle {bundle} ...", flush=True)
    with gzip.open(bundle, "rt", encoding="utf-8") as fh:
        data = json.load(fh)
    ship_slices = data.get("ships") if isinstance(data, dict) else None
    if not isinstance(ship_slices, dict):
        sys.exit(f"[upgrade-chain] ERROR: {bundle} is not a ship slice bundle")
    entries: dict[str, dict] = {}
    key_to_id: dict[str, str] = {}
    index_to_id: dict[str, str] = {}
    for sid, obj in ship_slices.items():
        if not isinstance(obj, dict):
            continue
        entries[str(sid)] = obj
        idx = obj.get("index")
        if isinstance(idx, str):
            index_to_id.setdefault(idx, str(sid))
            key_to_id.setdefault(idx, str(sid))
        name = obj.get("name")
        if isinstance(name, str):
            key_to_id.setdefault(name, str(sid))
    stamp = data.get("gameVersion") if isinstance(data.get("gameVersion"), str) else None
    return entries, key_to_id, index_to_id, stamp


def _sidecar_stamp(realm: str, dump: Path) -> str | None:
    """<realm>-<build> from the dump's .build sidecar (run.py's freshness key)."""
    sidecar = Path(str(dump) + ".build")
    if not sidecar.is_file():
        return None
    build = sidecar.read_text(encoding="ascii", errors="ignore").strip()
    return f"{realm}-{build}" if build else None


def _read_build_txt(directory: Path) -> str | None:
    build_txt = directory / "build.txt"
    if not build_txt.is_file():
        return None
    build = build_txt.read_text(encoding="ascii", errors="ignore").strip()
    return build or None


def _build_ship(
    entry: dict,
    sui: dict,
    entries: dict[str, dict],
    key_to_id: dict[str, str],
    index_to_id: dict[str, str],
    module_ids: dict[str, int],
    stats: _Stats,
) -> dict | None:
    index = entry.get("index")
    if not isinstance(index, str):
        return None
    research = {
        "xp": _as_int(sui.get("costXP")),
        "credits": _as_int(sui.get("costCR")),
        "gold": _as_int(sui.get("costGold")),
    }
    next_ships = _next_ships(sui, entries, key_to_id, index_to_id, stats)
    if next_ships:
        stats.ships_with_next += 1
    slots = _slots(sui, key_to_id, index_to_id, module_ids, stats)
    return {"index": index, "research": research, "next": next_ships, "slots": slots}


def _next_ships(
    sui: dict,
    entries: dict[str, dict],
    key_to_id: dict[str, str],
    index_to_id: dict[str, str],
    stats: _Stats,
) -> dict[str, dict]:
    """The ships this ship unlocks, keyed by the unlocked ship's numeric id.

    Every upgrade entry can carry nextShips (in practice the top hull / top
    torpedoes / fire control do); union them in encounter order.
    """
    out: dict[str, dict] = {}
    for up in sui.values():
        if not isinstance(up, dict):
            continue
        targets = up.get("nextShips")
        if not isinstance(targets, list):
            continue
        for target in targets:
            if not isinstance(target, str):
                continue
            tid = _resolve_target(target, key_to_id, index_to_id)
            if tid is None:
                stats.unresolved_targets.add(target)
                continue
            if tid in out:
                continue
            target_entry = entries.get(tid) or {}
            target_sui = target_entry.get("ShipUpgradeInfo")
            xp_ship = None
            if isinstance(target_sui, dict):
                xp_ship = _as_int_or_none(target_sui.get("costXP"))
            stats.next_edges += 1
            if xp_ship is not None:
                stats.xp_ship_known += 1
            target_index = target_entry.get("index")
            out[tid] = {
                "index": target_index if isinstance(target_index, str) else None,
                "xpShip": xp_ship,
                "xpWithModules": None,
                "requiredModules": None,
            }
    return out


def _slots(
    sui: dict,
    key_to_id: dict[str, str],
    index_to_id: dict[str, str],
    module_ids: dict[str, int],
    stats: _Stats,
) -> list[dict]:
    """One slot per ucType, steps ordered by upgrade depth (stock -> top)."""
    by_kind: dict[str, list[tuple[str, dict]]] = {}
    for name, up in sui.items():
        if not isinstance(up, dict):
            continue
        kind = _uc_kind(up.get("ucType"))
        if not kind:
            continue
        by_kind.setdefault(kind, []).append((name, up))
    # Every upgrade entry of the ship, whatever its slot — tells a module whose
    # prev points into another bracket apart from a plain slot root.
    all_names = {name for name, up in sui.items() if isinstance(up, dict)}
    slots: list[dict] = []
    for kind in sorted(by_kind, key=lambda k: (SLOT_ORDER.get(k, len(SLOT_ORDER)), k)):
        slot_names = {name for name, _ in by_kind[kind]}
        ordered = _ordered_steps(by_kind[kind], all_names)
        depths = [depth for _, depth in ordered]
        stats.max_depth = max(stats.max_depth, max(depths, default=0))
        if len(set(depths)) != len(depths):
            stats.parallel_slots += 1
        raw_uc = by_kind[kind][0][1].get("ucType")
        steps: list[dict] = []
        for pos, (name, depth) in enumerate(ordered):
            up = sui[name]
            prev = up.get("prev")
            prev_key = prev if isinstance(prev, str) and prev else None
            if prev_key is not None and prev_key not in slot_names:
                stats.cross_slot_prev += 1
            components = up.get("components")
            step: dict = {
                "name": name,
                # Numeric GameParams entity id: the client's price catalog keys
                # its items by it, so a capture joins straight onto the step.
                "gpid": module_ids.get(name),
                "prev": prev_key,
                "depth": depth,
                "isStock": pos == 0,
                "xp": None,
                "credits": None,
                "components": components if isinstance(components, dict) else {},
            }
            if step["gpid"] is not None:
                stats.steps_with_gpid += 1
            unlocks = _unlocks(up, key_to_id, index_to_id)
            if unlocks:
                step["unlocks"] = unlocks
                stats.unlock_steps += 1
            steps.append(step)
        slots.append({"ucType": raw_uc if isinstance(raw_uc, str) else kind, "steps": steps})
        stats.slots += 1
        stats.steps += len(steps)
        stats.kinds[kind] = stats.kinds.get(kind, 0) + 1
    return slots


def _ordered_steps(
    entries: list[tuple[str, dict]],
    all_names: set[str],
) -> list[tuple[str, int]]:
    """(name, depth) pairs, stock -> top, for one ucType slot.

    Depth is the module's upgrade level inside the slot: 0 for a stock module
    (no prev), otherwise one more than its same-slot prev's depth. A prev
    naming a module of ANOTHER slot (a hull-locked gun/torpedo top) puts the
    entry one level above the slot's stock — the level the prerequisite hull
    variant introduces. Parallel variant chains therefore share a depth level
    and ties keep GameParams table order, so alternatives sit adjacent.
    """
    names = [name for name, _ in entries]
    by_name = dict(entries)
    depth: dict[str, int] = {}
    for name in names:
        prev = by_name[name].get("prev")
        if not (isinstance(prev, str) and prev):
            depth[name] = 0
        elif prev not in by_name:
            # Cross-slot prerequisite (or a missing entry): one level up when
            # it names another module of this ship, else treat as a root.
            depth[name] = 1 if prev in all_names else 0
    # Resolve same-slot prev edges; the SUI table order is not depth order.
    progress = True
    while progress:
        progress = False
        for name in names:
            prev = by_name[name].get("prev")
            if not (isinstance(prev, str) and prev in depth):
                continue
            want = depth[prev] + 1
            if name not in depth or depth[name] < want:
                depth[name] = want
                progress = True
    for name in names:
        depth.setdefault(name, 0)
    ordered = sorted(range(len(names)), key=lambda i: (depth[names[i]], i))
    return [(names[i], depth[names[i]]) for i in ordered]


def _unlocks(up: dict, key_to_id: dict[str, str], index_to_id: dict[str, str]) -> list[int]:
    targets = up.get("nextShips")
    if not isinstance(targets, list):
        return []
    out: list[int] = []
    for target in targets:
        if not isinstance(target, str):
            continue
        tid = _resolve_target(target, key_to_id, index_to_id)
        if tid is not None and int(tid) not in out:
            out.append(int(tid))
    return out


def _resolve_target(target: str, key_to_id: dict[str, str], index_to_id: dict[str, str]) -> str | None:
    """GameParams entry key / index -> numeric shipId (as a string)."""
    sid = key_to_id.get(target)
    if sid is not None:
        return sid
    sid = index_to_id.get(target)
    if sid is not None:
        return sid
    # The key carries the index as its prefix ("PRSD208_Pr_30" -> "PRSD208").
    return index_to_id.get(target.split("_", 1)[0])


def _uc_kind(uc_type: object) -> str:
    """Normalize a ucType for slot grouping ("_Hull" -> "hull")."""
    if not isinstance(uc_type, str):
        return ""
    return uc_type.lstrip("_").lower()


def _as_int(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) else 0


def _as_int_or_none(value: object) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def _report(out: Path, realm: str, version: str, ships: dict[str, dict], stats: _Stats) -> None:
    size_mb = out.stat().st_size / 1e6
    print(f"[upgrade-chain] wrote {len(ships)} ships ({size_mb:.2f} MB) to {out}")
    print(f"[upgrade-chain] version {version}; next edges {stats.next_edges} "
          f"({stats.xp_ship_known} with xpShip), {stats.ships_with_next} ships unlock something")
    print(f"[upgrade-chain] {stats.slots} slots / {stats.steps} steps "
          f"({stats.unlock_steps} steps carry unlocks, "
          f"{stats.steps_with_gpid} carry a GameParams id)")
    print(f"[upgrade-chain] topology: max depth {stats.max_depth}, "
          f"{stats.parallel_slots} slots with parallel variants, "
          f"{stats.cross_slot_prev} cross-slot prev links")
    top = sorted(stats.kinds.items(), key=lambda kv: -kv[1])
    print(f"[upgrade-chain] slots by ucType: {dict(top)}")
    if stats.unresolved_targets:
        sample = sorted(stats.unresolved_targets)[:10]
        print(f"[upgrade-chain] WARNING: {len(stats.unresolved_targets)} unresolved unlock "
              f"target(s), dropped: {sample}", file=sys.stderr)
    _report_tree_coverage(realm, ships, out)


def _report_tree_coverage(realm: str, ships: dict[str, dict], out: Path) -> None:
    """Research-line coverage: every emitted tree node carries research/next data."""
    tree_path = TREES[realm]
    if not tree_path.is_file():
        return
    with tree_path.open(encoding="utf-8") as fh:
        tree = json.load(fh)
    if not isinstance(tree, dict):
        return
    node_ids = set(tree)
    covered = node_ids & ships.keys()
    edges = 0
    covered_edges = 0
    for sid in node_ids:
        for nx in tree[sid].get("nextShips") or []:
            nxs = str(nx)
            if nxs not in node_ids:
                continue
            edges += 1
            if nxs in (ships.get(sid) or {}).get("next", {}):
                covered_edges += 1
    print(f"[upgrade-chain] {realm} tree coverage: {len(covered)}/{len(node_ids)} nodes have "
          f"research data, {covered_edges}/{edges} research edges have a next entry")
    if covered != node_ids or covered_edges != edges:
        print(f"[upgrade-chain] WARNING: {realm} tree coverage incomplete for {out.name} — "
              "the input snapshot may be older than the committed tree.")


if __name__ == "__main__":
    main()
