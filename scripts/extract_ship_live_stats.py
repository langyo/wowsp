#!/usr/bin/env python3
"""Bake `packages/webui/src/data/ship_live_stats.json` — the per-ship combat
card the live-battle panel (`/live`) puts in every roster row and in its hover
flyout.

Why a baked asset: the panel renders a whole battle roster (2 × 12 ships) and
updates it every 3 s, so every value has to be available synchronously. The
ship-detail modal's road (`api.getShipGameparams` per ship) means 24 IPC round
trips per roster; this asset is a single static import instead, and it stays
correct when the game is not installed (the phone build, or a desktop without
GameParams).

Sources, in order of authority per field:

* `res/data/ships_basics.json` — the bundled WG encyclopedia `default_profile`
  copy (same numbers `ships.spec.*` shows in 舰艇查询): main/secondary/torpedo
  ranges, hull HP, top speed and detectability. Preferred whenever the ship is
  present, so the strip never disagrees with the detail modal.
* `res/data/gameparams/<shipId>.json` — the offline GameParams slices:
  * AA aura bands (the encyclopedia's `anti_aircraft` block carries only an
    opaque rating — see `components/ships/antiAir.ts`),
  * the ASW airstrike block (`A_AirSupport`),
  * `ShipAbilities` (the consumable slots — what `data/ship_consumables.json`
    only carries partially, for skill gating),
  * `maxEquippedFlags` (signal-flag capacity),
  * `ShipUpgradeInfo` (the ship's researchable module kinds),
  * and a fallback for the fields the encyclopedia is missing (newer ships).

Everything here is ship-data (GameParams / WG encyclopedia) — no per-player
information exists in either source, which is why the panel can only ever show
a ship's *capability*, never a player's actual loadout.

Usage:
    python scripts/extract_ship_live_stats.py
    python scripts/extract_ship_live_stats.py --gameparams /path/to/gameparams
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_BASICS = REPO_ROOT / "packages/webui/src/res/data/ships_basics.json"
DEFAULT_NAMES = REPO_ROOT / "packages/webui/src/data/ship_names.json"
DEFAULT_GAMEPARAMS = REPO_ROOT / "packages/webui/src/res/data/gameparams"
DEFAULT_OUT = REPO_ROOT / "packages/webui/src/data/ship_live_stats.json"

# ---------------------------------------------------------------------------
# GameParams extraction
# ---------------------------------------------------------------------------

# Aura-bearing blocks. `antiAir.ts` deliberately reads only the three stock
# A_* blocks; the pack shows a good number of ships whose only AA lives in a
# B_/AB_ hull block (Shimakaze: B_AirDefense, B_Hull, no A_* at all), so the
# bake reads every hull variant and keeps the widest per band — the "top
# configuration" reading the rest of the card uses too.
AA_BLOCK_RE = re.compile(r"^(?:A|B|C|AB|A1|A2|B1|AB1|AB2)_(?:AirDefense|ATBA|Artillery)$")
AA_BANDS = ("near", "medium", "far")
# Main-battery fallback blocks (only used for ships the encyclopedia misses).
ARTILLERY_BLOCK_RE = re.compile(r"^(?:A|B|C|AB|A1|A2|B1|AB1|AB2)_Artillery$")

# `ShipUpgradeInfo.ucType` → the short code baked into the asset. Anything not
# listed is dropped (a kind the frontend has no label for).
UPGRADE_KINDS = {
    "_Hull": "hull",
    "_Artillery": "artillery",
    "_Torpedoes": "torpedoes",
    "_Engine": "engine",
    "_Suo": "fireControl",
    "_Sonar": "sonar",
    "_Fighter": "fighter",
    "_DiveBomber": "diveBomber",
    "_TorpedoBomber": "torpedoBomber",
    "_SkipBomber": "skipBomber",
    "_FlightControl": "flightControl",
}

# Ability-key noise: `PCY009_CrashCrewPremium` and friends collapse onto the
# family the frontend has a label for.
# Prefixes seen in the pack: `PCY009_CrashCrewPremium`, `PXY025_SonarSearch`.
ABILITY_PREFIX_RE = re.compile(r"^P[A-Z]{2}\d+_")
ABILITY_SUFFIXES = (
    "_TimeBased",
    "Premium",
    "Super",
    "_PVP",
    "_H2019",
    "_H2020",
    "_FA2022",
)
# Auto-triggered twins of the manual consumables.
ABILITY_ALIASES = {
    "CrashCrewAuto": "CrashCrew",
    "FighterAuto": "Fighter",
}


def ability_family(name: str) -> str | None:
    """`PCY009_CrashCrewPremium` → `CrashCrew`; None when unparseable."""
    if not isinstance(name, str) or not name:
        return None
    base = ABILITY_PREFIX_RE.sub("", name)
    changed = True
    while changed:
        changed = False
        for suffix in ABILITY_SUFFIXES:
            if base.endswith(suffix) and len(base) > len(suffix):
                base = base[: -len(suffix)]
                changed = True
                break
    return ABILITY_ALIASES.get(base, base)


def num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def round1(v: float | None) -> float | None:
    return None if v is None else round(v, 1)


def is_aura(v: Any) -> bool:
    return (
        isinstance(v, dict)
        and v.get("type") in AA_BANDS
        and ("areaDamage" in v or "bubbleDamage" in v)
    )


def collect_aa(gp: dict[str, Any]) -> dict[str, dict[str, float]] | None:
    """Per-band AA range (m, widest aura) and continuous DPS (summed auras).

    Mirrors `components/ships/antiAir.ts::collectAaBands` band for band, only
    over every hull block instead of the stock trio; bands with no damage at
    all (submarines, ~98 ships carry no auras) yield None.
    """
    ranges: dict[str, float] = {}
    dps: dict[str, float] = {}
    for key, block in gp.items():
        if not AA_BLOCK_RE.match(key) or not isinstance(block, dict):
            continue
        for v in block.values():
            if not is_aura(v):
                continue
            band = v["type"]
            dmg = num(v.get("areaDamage")) or 0.0
            dps[band] = dps.get(band, 0.0) + dmg
            dist = num(v.get("maxDistance"))
            if dist is not None and dist > ranges.get(band, 0.0):
                ranges[band] = dist
    out: dict[str, dict[str, float]] = {}
    for band in AA_BANDS:
        if band not in ranges and not dps.get(band):
            continue
        out[band] = {
            "r": round(ranges.get(band, 0.0) / 1000.0, 1),
            "dps": round(dps.get(band, 0.0)),
        }
    return out or None


def collect_asw(gp: dict[str, Any]) -> dict[str, float] | None:
    """ASW airstrike: range (km), charges, reload (s)."""
    asw = gp.get("A_AirSupport")
    if not isinstance(asw, dict):
        return None
    dist = num(asw.get("maxDist"))
    if dist is None or dist <= 0:
        return None
    out: dict[str, float] = {"r": round(dist / 1000.0, 1)}
    charges = num(asw.get("chargesNum"))
    if charges is not None:
        out["n"] = int(charges)
    reload_s = num(asw.get("reloadTime"))
    if reload_s is not None:
        out["t"] = round(reload_s, 1)
    return out


def collect_loadout(gp: dict[str, Any]) -> list[str]:
    """Consumable families in slot order, deduped (`SkillAbilities` order)."""
    slots = gp.get("ShipAbilities")
    if not isinstance(slots, dict):
        return []
    seen: list[str] = []
    for key in sorted(k for k in slots if k.startswith("AbilitySlot")):
        slot = slots.get(key)
        if not isinstance(slot, dict):
            continue
        for entry in slot.get("abils") or []:
            name = entry[0] if isinstance(entry, (list, tuple)) and entry else entry
            fam = ability_family(name)
            if fam and fam not in seen:
                seen.append(fam)
    return seen


def collect_upgrades(gp: dict[str, Any]) -> list[str]:
    """Researchable module kinds — kinds carrying more than the stock option."""
    info = gp.get("ShipUpgradeInfo")
    if not isinstance(info, dict):
        return []
    options: dict[str, set[str]] = defaultdict(set)
    for name, ent in info.items():
        if not isinstance(ent, dict):
            continue
        code = UPGRADE_KINDS.get(ent.get("ucType") or "")
        if code:
            options[code].add(str(name))
    order = list(UPGRADE_KINDS.values())
    return [code for code in order if len(options.get(code, ())) > 1]


def collect_gameparams_fallback(gp: dict[str, Any]) -> dict[str, Any]:
    """Fields the encyclopedia is missing, read straight off GameParams.

    Only the stock/top hull blocks are considered, and every value is the
    widest across hulls — the same "top configuration" convention as the
    encyclopedia numbers.
    """
    out: dict[str, Any] = {}
    main = 0.0
    for key, block in gp.items():
        if not ARTILLERY_BLOCK_RE.match(key) or not isinstance(block, dict):
            continue
        dist = num(block.get("maxDist"))
        if dist is not None and dist > main:
            main = dist
    if main > 0:
        out["main"] = round(main / 1000.0, 1)

    sec = 0.0
    for key, block in gp.items():
        if not re.match(r"^(?:A|B|C|AB|A1|A2|B1|AB1|AB2)_ATBA$", key):
            continue
        if isinstance(block, dict):
            dist = num(block.get("maxDist"))
            if dist is not None and dist > sec:
                sec = dist
    if sec > 0:
        out["sec"] = round(sec / 1000.0, 1)

    hp = speed = det = det_air = 0.0
    for key, block in gp.items():
        if not re.match(r"^(?:A|B|C|AB)_Hull$", key) or not isinstance(block, dict):
            continue
        for field, slot in (("health", "hp"), ("maxSpeed", "spd")):
            v = num(block.get(field))
            if v is not None:
                if slot == "hp":
                    hp = max(hp, v)
                else:
                    speed = max(speed, v)
        v = num(block.get("visibilityFactor"))
        if v is not None:
            det = max(det, v)
        v = num(block.get("visibilityFactorByPlane"))
        if v is not None:
            det_air = max(det_air, v)
    if hp > 0:
        out["hp"] = round(hp)
    if speed > 0:
        out["spd"] = round(speed, 1)
    if det > 0:
        out["det"] = round(det, 1)
    if det_air > 0:
        out["detAir"] = round(det_air, 1)
    return out


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------


def field_of(profile: dict[str, Any], *path: str) -> float | None:
    cur: Any = profile
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return num(cur)


def from_encyclopedia(entry: dict[str, Any]) -> dict[str, Any]:
    """The fields the panel shows that the encyclopedia can answer."""
    profile = entry.get("default_profile")
    if not isinstance(profile, dict):
        return {}
    out: dict[str, Any] = {}
    for key, path in (
        ("main", ("artillery", "distance")),
        ("sec", ("atbas", "distance")),
        ("torp", ("torpedoes", "distance")),
        ("hp", ("hull", "health")),
        ("spd", ("mobility", "max_speed")),
        ("det", ("concealment", "detect_distance_by_ship")),
        ("detAir", ("concealment", "detect_distance_by_plane")),
    ):
        val = field_of(profile, *path)
        if val is None or val <= 0:
            continue
        out[key] = round(val) if key == "hp" else round(val, 1)
    return out


def main(argv: Iterable[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--basics", type=Path, default=DEFAULT_BASICS)
    ap.add_argument("--names", type=Path, default=DEFAULT_NAMES)
    ap.add_argument("--gameparams", type=Path, default=DEFAULT_GAMEPARAMS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(list(argv))

    if not args.gameparams.is_dir():
        print(f"error: gameparams dir not found: {args.gameparams}", file=sys.stderr)
        print(
            "hint: it is generated by scripts/extract_gameparams.py and gitignored;"
            " point --gameparams at a checkout that has it.",
            file=sys.stderr,
        )
        return 2

    basics = json.loads(args.basics.read_text(encoding="utf-8"))
    basics_ships = basics.get("ships") or {}
    names = json.loads(args.names.read_text(encoding="utf-8"))

    out: dict[str, dict[str, Any]] = {}
    stats: Counter[str] = Counter()
    mismatch: dict[str, list[str]] = defaultdict(list)
    fallback_used: list[str] = []
    missing_basics: list[str] = []
    families: Counter[str] = Counter()
    upgrade_kinds: Counter[str] = Counter()

    slice_paths = sorted(args.gameparams.glob("*.json"))
    for idx, path in enumerate(slice_paths):
        ship_id = path.stem
        if not ship_id.isdigit():
            continue
        try:
            gp = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            print(f"warn: skipping {path.name}: {err}", file=sys.stderr)
            continue
        if (gp.get("typeinfo") or {}).get("type") != "Ship":
            stats["skipped_non_ship"] += 1
            continue

        record: dict[str, Any] = {}
        enc = from_encyclopedia(basics_ships.get(ship_id) or {})
        fb = collect_gameparams_fallback(gp)
        for key, val in enc.items():
            record[key] = val
            stats[f"enc_{key}"] += 1
            if key in fb:
                stats[f"checked_{key}"] += 1
                got, want = fb[key], val
                if abs(got - want) > (0.11 if key != "hp" else max(1.0, want * 0.001)):
                    mismatch[key].append(f"{ship_id}: enc={want} gp={got}")
        for key, val in fb.items():
            if key not in record:
                record[key] = val
                stats[f"fb_{key}"] += 1
        if not enc and fb:
            fallback_used.append(ship_id)
        if not enc and not fb:
            missing_basics.append(ship_id)

        aa = collect_aa(gp)
        if aa:
            record["aa"] = aa
            stats["aa"] += 1
        asw = collect_asw(gp)
        if asw:
            record["asw"] = asw
            stats["asw"] += 1
        load = collect_loadout(gp)
        if load:
            record["load"] = load
            stats["load"] += 1
            for fam in load:
                families[fam] += 1
        upg = collect_upgrades(gp)
        if upg:
            record["upg"] = upg
            stats["upg"] += 1
            for code in upg:
                upgrade_kinds[code] += 1
        flags = num(gp.get("maxEquippedFlags"))
        if flags:
            record["flags"] = int(flags)
            stats["flags"] += 1

        if record:
            out[ship_id] = record

    ordered = {sid: out[sid] for sid in sorted(out, key=lambda s: int(s))}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(ordered, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n",
        encoding="utf-8",
    )

    named = sum(1 for sid in ordered if sid in names)
    print(f"wrote {args.out.relative_to(REPO_ROOT)} — {len(ordered)} ships "
          f"({named} with a localized name), {args.out.stat().st_size / 1024:.0f} KiB")
    for key in sorted(stats):
        print(f"  {key}: {stats[key]}")
    print(f"  ships with NO numeric source: {len(missing_basics)} "
          f"({', '.join(missing_basics[:8])}{' …' if len(missing_basics) > 8 else ''})")
    if fallback_used:
        print(f"  ships served by the GameParams fallback: {len(fallback_used)} "
              f"({', '.join(fallback_used[:8])}{' …' if len(fallback_used) > 8 else ''})")
    for key in sorted(mismatch):
        rows = mismatch[key]
        print(f"  MISMATCH {key}: {len(rows)} ships disagree with the encyclopedia")
        for row in rows[:5]:
            print(f"    {row}")
    print("  consumable families:")
    for fam, count in families.most_common():
        print(f"    {fam}: {count}")
    print("  upgrade kinds:")
    for code, count in upgrade_kinds.most_common():
        print(f"    {code}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
