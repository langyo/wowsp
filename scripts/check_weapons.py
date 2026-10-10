"""
Fleet-wide weapon audit over per-ship GameParams entries.

Mirrors the frontend resolution exactly (webui
src/components/ships/shipParts.ts + shipWeapons.ts):
  - role → component blocks resolve through ShipUpgradeInfo (top = the
    upgrade-chain end, stock = the head); entries without a parsable
    ShipUpgradeInfo fall back to canonical literal keys (A_Artillery,
    A_Torpedoes, ...);
  - weapon groups group mount HP_* slots per role: artillery → main
    (ATBA fallback promotes only the largest caliber group), ATBA/AirDefense
    gun-id intersection → dual-purpose, torpedoes → torpedo role ONLY
    (AirArmament is aircraft catapults), AirDefense mounts bucket by aura
    band, DepthCharges → ASW, AirArmament catapults → aircraft.

Historical context this audit guards: the frontend used to read torpedoes
from A_AirArmament (catapults — the X Worcester "2×1 torpedo" bug) and every
ship whose components keep historical codes (~half the fleet: A1_610-style
names) showed no weapon badges at all.

Checks reported per ship class:
  - torpedo groups sourced from anything but the torpedo role (must stay 0);
  - ships with weapon groups ONLY via the canonical fallback (data drift
    watch: new builds renaming components away from canonical);
  - ships with no weapon group at all (surface combatants are suspicious —
    harbour/event ships may be legitimate);
  - cross-check against ship_live_stats.json (extract_ship_live_stats.py):
    torpedo range known but no torpedo mounts found, and the reverse, among
    ships present in both datasets.

Inputs (auto-picked by --gameparams):
  - a directory of per-ship <shipId>.json slices (the bundled Android pack
    at packages/webui/src/res/data/gameparams, or the desktop AppData cache);
  - a single unpacked GameParams.json (ship entries filtered by
    typeinfo.type == "Ship").
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PACK = ROOT / "packages/webui/src/res/data/gameparams"
DEFAULT_LIVE = ROOT / "packages/webui/src/data/ship_live_stats.json"
DEFAULT_NAMES = ROOT / "packages/webui/src/data/ship_names.json"

ROLES = (
    "hull",
    "artillery",
    "atba",
    "torpedoes",
    "airDefense",
    "airArmament",
    "depthCharges",
    "airSupport",
)


def resolve_parts(gp: dict, config: str = "top") -> dict[str, Any]:
    """Python mirror of resolveShipParts() — role → component block dicts."""
    info = gp.get("ShipUpgradeInfo")
    if not isinstance(info, dict) or not info:
        return canonical_parts(gp)
    info = {k: v for k, v in info.items() if isinstance(v, dict)}
    if not info:
        return canonical_parts(gp)

    def uc_kind(uc_type: Any) -> str:
        return str(uc_type or "").lstrip("_").lower()

    def components_of(entry: dict) -> dict[str, list[str]]:
        comps = entry.get("components")
        if not isinstance(comps, dict):
            return {}
        out: dict[str, list[str]] = {}
        for role, names in comps.items():
            if isinstance(names, list):
                out[str(role).lower()] = [n for n in names if isinstance(n, str)]
        return out

    names_by_kind: dict[str, list[str]] = {}
    for name, ent in info.items():
        kind = uc_kind(ent.get("ucType"))
        if kind:
            names_by_kind.setdefault(kind, []).append(name)
    chains: dict[str, dict] = {}
    for kind, kind_names in names_by_kind.items():
        referenced = {info[n].get("prev") for n in kind_names
                      if isinstance(info[n].get("prev"), str)}
        name_set = set(kind_names)
        ends = [n for n in kind_names if n not in referenced]
        heads = [n for n in kind_names
                 if not (isinstance(info[n].get("prev"), str) and info[n]["prev"] in name_set)]
        chains[kind] = {
            "head": heads[0] if heads else kind_names[0],
            "end": ends[0] if ends else kind_names[-1],
        }

    hull_chain = chains.get("hull")
    hull_entry = info.get(hull_chain["end" if config == "top" else "head"]) if hull_chain else None
    if hull_entry is None:
        return canonical_parts(gp)
    hull_comps = components_of(hull_entry)

    parts: dict[str, Any] = {}
    for role in ROLES:
        key = role.lower()
        hull_names = hull_comps.get(key)
        # An explicitly EMPTY hull list means "not mounted on this hull" and
        # must win over the chain pick and the literal fallback; an OMITTED
        # key is fair game for both.
        explicit_empty = hull_names is not None and len(hull_names) == 0
        names: list[str] = []
        if not explicit_empty:
            chain = chains.get(key)
            if chain:
                pick = chain["end" if config == "top" else "head"]
                names = components_of(info[pick]).get(key, [])
                if names:
                    # An upgrade entry may co-list every hull variant's
                    # blocks (stock artillery upgrades name A_Artillery AND
                    # B_Artillery); the hull's own list names exactly what
                    # THAT hull mounts — intersect down to it.
                    if hull_names:
                        hull_set = set(hull_names)
                        mounted = [n for n in names if n in hull_set]
                        if mounted:
                            names = mounted
            if not names:
                names = hull_names or []
        blocks: list[Any] = [gp[n] for n in names if isinstance(gp.get(n), dict)]
        if not blocks and not explicit_empty:
            # Legacy fallback: entries whose hull omits a role still mounted
            # the canonical block (e.g. the Midway legacy hull keeps its
            # secondaries' far AA aura in a literal A_ATBA).
            canonical = {"hull": ("A_Hull", "Hull"), "artillery": ("A_Artillery",),
                         "atba": ("A_ATBA",), "torpedoes": ("A_Torpedoes",),
                         "airDefense": ("A_AirDefense",), "airArmament": ("A_AirArmament",),
                         "depthCharges": ("A_DepthCharge",), "airSupport": ("A_AirSupport",)}[role]
            for lit in canonical:
                if isinstance(gp.get(lit), dict):
                    blocks = [gp[lit]]
                    break
        if role == "hull":
            parts[role] = blocks[0] if blocks else None
        else:
            parts[role] = blocks
    return parts


def canonical_parts(gp: dict) -> dict[str, Any]:
    def one(key: str) -> Any:
        v = gp.get(key)
        return v if isinstance(v, dict) else None

    def lst(key: str) -> list:
        v = gp.get(key)
        return [v] if isinstance(v, dict) else []

    return {
        "hull": one("A_Hull") or one("Hull"),
        "artillery": lst("A_Artillery"),
        "atba": lst("A_ATBA"),
        "torpedoes": lst("A_Torpedoes"),
        "airDefense": lst("A_AirDefense"),
        "airArmament": lst("A_AirArmament"),
        "depthCharges": lst("A_DepthCharge"),
        "airSupport": lst("A_AirSupport"),
    }


def hp_slots(blocks: list) -> list[tuple[str, dict]]:
    # Slot keys are unique per ship assembly — when several resolved blocks
    # carry the same key (variant blocks co-listed by one upgrade entry),
    # the first wins so mounts never double-count.
    out: list[tuple[str, dict]] = []
    seen: set[str] = set()
    for block in blocks:
        for k, v in block.items():
            if k.startswith("HP_") and isinstance(v, dict) and k not in seen:
                seen.add(k)
                out.append((k, v))
    return out


def aura_band_map(blocks: list) -> dict[str, str]:
    priority = {"near": 0, "medium": 1, "far": 2}
    out: dict[str, str] = {}
    for block in blocks:
        for v in block.values():
            if not isinstance(v, dict) or v.get("type") not in priority:
                continue
            if "areaDamage" not in v and "bubbleDamage" not in v:
                continue
            for g in v.get("guns") or []:
                if isinstance(g, str) and (
                    g not in out or priority[v["type"]] > priority[out[g]]
                ):
                    out[g] = v["type"]
    return out


def num_of(v: Any) -> float:
    """JS Number()-style tolerant read (GameParams fields may be strings)."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def barrels_of(m: dict) -> int:
    """JS `Number(m.numBarrels ?? 0) || 1`."""
    return int(num_of(m.get("numBarrels"))) or 1


def mm_of(m: dict) -> int:
    """JS `Math.round(Number(m.barrelDiameter ?? 0) * 1000)` (half up)."""
    return int(num_of(m.get("barrelDiameter")) * 1000 + 0.5)


def groups_desc(slots: list[tuple[str, dict]]) -> list[dict]:
    groups: dict[tuple, dict] = {}
    for k, m in slots:
        barrels = barrels_of(m)
        cal = mm_of(m)
        key = (barrels, cal)
        g = groups.get(key)
        if g:
            g["count"] += 1
            g["slots"].append(k)
        else:
            groups[key] = {"count": 1, "slots": [k], "barrels": barrels, "cal": cal}
    return sorted(groups.values(), key=lambda g: g["cal"], reverse=True)


def summarize_weapons(gp: dict) -> list[dict]:
    """Python mirror of summarizeWeapons() (top configuration)."""
    parts = resolve_parts(gp, "top")
    out: list[dict] = []
    atba_slots = hp_slots(parts["atba"])
    aa_slots = hp_slots(parts["airDefense"])
    art_slots = hp_slots(parts["artillery"])

    promoted: set[str] = set()
    main_from_atba = not art_slots
    main_groups = groups_desc(atba_slots) if main_from_atba else groups_desc(art_slots)
    for i, g in enumerate(main_groups):
        if main_from_atba:
            if i > 0:
                break
            promoted.update(g["slots"])
        out.append({"kind": "mainGun", "count": g["count"], "barrels": g["barrels"], "cal": g["cal"]})

    def mount_id(m: dict) -> str:
        return str(m.get("name") or m.get("id") or "")

    atba_ids = {mount_id(m) for _, m in atba_slots} - {""}
    aa_ids = {mount_id(m) for _, m in aa_slots} - {""}
    dp_slots = {k for k, m in atba_slots if mount_id(m) in aa_ids}
    dp_slots |= {k for k, m in aa_slots if mount_id(m) in atba_ids}

    sec: dict[tuple, int] = {}
    for k, m in atba_slots:
        if k in dp_slots or k in promoted:
            continue
        key = (barrels_of(m), mm_of(m))
        sec[key] = sec.get(key, 0) + 1
    for (barrels, cal), count in sec.items():
        out.append({"kind": "secondary", "count": count, "barrels": barrels, "cal": cal})

    dp: dict[tuple, int] = {}
    for k, m in list(atba_slots) + list(aa_slots):
        if k not in dp_slots:
            continue
        key = (barrels_of(m), mm_of(m))
        dp[key] = dp.get(key, 0) + 1
    for (barrels, cal), count in dp.items():
        out.append({"kind": "dp", "count": count, "barrels": barrels, "cal": cal})

    torp: dict[int, int] = {}
    for _, t in hp_slots(parts["torpedoes"]):
        n = int(num_of(t.get("numBarrels") or t.get("count") or 1)) or 1
        torp[n] = torp.get(n, 0) + 1
    for tubes, count in torp.items():
        out.append({"kind": "torpedo", "count": count, "barrels": tubes, "cal": 0})

    if aa_slots:
        band_of = aura_band_map(parts["airDefense"] + parts["atba"] + parts["artillery"])
        tiers = {"long": 0, "mid": 0, "short": 0}
        for k, _ in aa_slots:
            if k in dp_slots:
                continue
            band = band_of.get(k, "near")
            tiers["long" if band == "far" else "mid" if band == "medium" else "short"] += 1
        for band, n in tiers.items():
            if n > 0:
                out.append({"kind": "aa", "count": n, "barrels": 0, "cal": 0, "band": band})

    dc = len(hp_slots(parts["depthCharges"]))
    if not dc:
        strike = parts["airSupport"][0] if parts["airSupport"] else None
        if isinstance(strike, dict) and float(strike.get("chargesNum") or 0) > 0 \
                and float(strike.get("maxDist") or 0) > 0:
            dc = int(strike["chargesNum"])
    if dc:
        out.append({"kind": "asw", "count": dc, "barrels": 0, "cal": 0})
    ac = len(hp_slots(parts["airArmament"]))
    if ac:
        out.append({"kind": "aircraft", "count": ac, "barrels": 0, "cal": 0})
    return out


def load_ships(path: Path) -> dict[str, dict]:
    """Per-ship slices keyed by ship id, from a slice dir or a full JSON."""
    if path.is_dir():
        ships: dict[str, dict] = {}
        for f in sorted(path.glob("*.json")):
            if f.name in ("upgrade-prices.json", "build.txt"):
                continue
            try:
                entry = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                print(f"warn: skip unreadable slice {f.name}: {exc}", file=sys.stderr)
                continue
            if isinstance(entry, dict):
                ships[f.stem] = entry
        return ships
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and isinstance(raw.get("ships"), list):
        raw = {str(s.get("id")): s for s in raw["ships"] if isinstance(s, dict) and s.get("id")}
    if isinstance(raw, list):
        raw = {str(s.get("id")): s for s in raw if isinstance(s, dict) and s.get("id")}
    return {
        k: v for k, v in raw.items()
        if isinstance(v, dict) and isinstance(v.get("typeinfo"), dict)
        and v["typeinfo"].get("type") == "Ship"
    }


def label_of(ship_id: str, names: dict | None) -> str:
    if not names:
        return ship_id
    ent = names.get(ship_id) or {}
    return f"{ent.get('names', {}).get('zh-CN') or ent.get('names', {}).get('en-US') or ent.get('index') or ship_id}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gameparams", type=Path, default=DEFAULT_PACK,
                    help="per-ship slice dir or a full GameParams.json")
    ap.add_argument("--live-stats", type=Path, default=DEFAULT_LIVE)
    ap.add_argument("--names", type=Path, default=DEFAULT_NAMES)
    ap.add_argument("--limit", type=int, default=15,
                    help="anomalies listed per class")
    args = ap.parse_args(argv)

    if not args.gameparams.exists():
        print(f"error: gameparams not found: {args.gameparams}", file=sys.stderr)
        print("hint: the bundled pack is generated by scripts/extract_gameparams.py "
              "(gitignored); point --gameparams at a checkout or AppData cache that has it.",
              file=sys.stderr)
        return 1
    ships = load_ships(args.gameparams)
    names = json.loads(args.names.read_text(encoding="utf-8")) if args.names.exists() else None
    live = json.loads(args.live_stats.read_text(encoding="utf-8")) if args.live_stats.exists() else {}

    weaponless: list[str] = []
    fallback_only: list[str] = []
    torpedo_inversions: list[tuple[str, str]] = []
    dup_slot_ships: list[tuple[str, int]] = []
    live_missing_torp: list[str] = []
    live_extra_torp: list[str] = []
    kind_totals: dict[str, int] = {}
    bogus_torp_pre_fix = 0

    for ship_id, gp in ships.items():
        # Pre-fix behaviour for reference: AirArmament mounts read as torpedoes.
        pre = gp.get("A_AirArmament")
        pre_has_mounts = isinstance(pre, dict) and any(k.startswith("HP_") for k in pre)
        if pre_has_mounts:
            bogus_torp_pre_fix += 1

        parts = resolve_parts(gp, "top")
        # Drift watch: one upgrade entry co-listing several hull variants'
        # blocks used to double-count mounts; the hull-list intersection
        # must keep every slot key unique across a role's blocks.
        dups = 0
        for role in ("artillery", "atba", "torpedoes", "airDefense",
                     "airArmament", "depthCharges"):
            seen: set[str] = set()
            for block in parts[role]:
                for k in block:
                    if k.startswith("HP_"):
                        if k in seen:
                            dups += 1
                        else:
                            seen.add(k)
        if dups:
            dup_slot_ships.append((ship_id, dups))
        via_fallback = not isinstance(gp.get("ShipUpgradeInfo"), dict)
        groups = summarize_weapons(gp)
        for g in groups:
            kind_totals[g["kind"]] = kind_totals.get(g["kind"], 0) + g["count"]
        kinds = {g["kind"] for g in groups}
        if not kinds:
            weaponless.append(ship_id)
        if via_fallback and kinds:
            fallback_only.append(ship_id)
        if "torpedo" in kinds and not parts["torpedoes"]:
            torpedo_inversions.append((ship_id, "torpedo group without torpedo blocks"))

        live_ent = live.get(ship_id) or {}
        if ship_id in live:
            has_torp_mounts = "torpedo" in kinds
            if "torp" in live_ent and not has_torp_mounts:
                live_missing_torp.append(ship_id)
            if has_torp_mounts and "torp" not in live_ent:
                live_extra_torp.append(ship_id)

    print(f"ships audited: {len(ships)}  ({args.gameparams})")
    print("weapon groups by kind (mount totals): " +
          ", ".join(f"{k}={v}" for k, v in sorted(kind_totals.items())))
    print(f"pre-fix bogus torpedo sources (AirArmament mounts): {bogus_torp_pre_fix} ships")
    print(f"ships resolved via canonical fallback (no ShipUpgradeInfo): {len(fallback_only)}")
    print(f"ships with NO weapon group at all: {len(weaponless)}")
    print(f"torpedo groups not backed by torpedo blocks: {len(torpedo_inversions)} (must be 0)")
    print(f"ships with duplicate slot keys across a role's blocks: {len(dup_slot_ships)} (drift watch)")

    if live:
        both = sum(1 for s in ships if s in live)
        print(f"live-stats cross-check: torpedo range known but no mounts: {len(live_missing_torp)}; "
              f"mounts but no range: {len(live_extra_torp)} (of {both} ships in both)")

    def report(title: str, items: list) -> None:
        if not items:
            return
        print(f"\n{title}:")
        for item in items[: args.limit]:
            print(f"  - {item}")

    report("Ships with no weapon group (review: event/harbour ships are legitimate)",
           [f"{s} {label_of(s, names)}" for s in weaponless])
    report("Canonical-fallback ships",
           [f"{s} {label_of(s, names)}" for s in fallback_only])
    report("Torpedo inversions",
           [f"{s} {label_of(s, names)}: {why}" for s, why in torpedo_inversions])
    report("Ships with duplicate slot keys across a role's blocks",
           [f"{s} {label_of(s, names)}: {n} dup(s)" for s, n in dup_slot_ships])
    report("Live stats says torpedoes, mounts say no",
           [f"{s} {label_of(s, names)}" for s in live_missing_torp])
    report("Mounts say torpedoes, live stats says no",
           [f"{s} {label_of(s, names)}" for s in live_extra_torp])

    return 0 if not torpedo_inversions else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
