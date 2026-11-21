#!/usr/bin/env python3
"""Bake `packages/webui/src/data/repair_coefficients.json` — the per-hull
Repair-Party recoverable COEFFICIENT behind the grey HP-bar segment.

The grey segment (repairPool.ts) is the HP an active Repair Party can still
restore. Its budget is `coefficient × maxHp`, and the coefficient is a HULL
property: it belongs in a baked GameParams table, never in the replay stream.

DERIVATION (GameParams, the 15.10 client):

1. Ships are the entities with `typeinfo.type == "Ship"`; the table key is
   the entity's numeric `id` — the SAME id the replay roster carries as
   `shipParamsId` and the webui encyclopedia joins on.
2. A ship's consumables live in `ShipAbilities.AbilitySlot0..N`; each slot's
   `abils` list holds `[abilityEntityName, variantName]` alternatives the
   player picks ONE from (a loadout never stacks two Repair Party charges),
   plus an `AbilitySpecial` slot (event / commander talents).
3. The ability entity (`PCY002_RegenCrew`, `PCY010_RegenCrewPremium`,
   `PCY024_RegenCrewSuper`, `PCY059_RegenCrewPremium_TimeBased`, the
   `PXY*`/event forks…) is a variant dict: `variantName` when present, else
   its `Default` variant. Repair Party is the variant whose
   `consumableType == "regenCrew"`.
4. That variant's modifiers are `logic.regenerationHPSpeed` — the HEAL RATE
   as a FRACTION OF MAX HP PER SECOND — and `workTime` — the seconds one
   charge runs. One charge therefore restores

       fraction = clamp(regenerationHPSpeed × workTime, 0, 1)

   of max HP, which is the coefficient the grey-bar state machine caps its
   pool with. The ship's coefficient is the MAX over every mountable
   regenCrew entry (stock values; a slot's alternatives all count, because
   the replay does not tell us which loadout the player took).
5. `ignoreRegenLimit` never appears true in 15.10 (it would remove the cap
   rather than lift it), so it needs no special case.

A derived 0 is DROPPED rather than baked: `PXSC016_Monster_Cruiser`'s
event-mode regen has a 0.0 speed, i.e. it restores nothing, and a 0
coefficient would pin every grey segment of that hull to nothing forever.
An absent key means "unknown hull" and the consumer falls back to the
documented flat 0.5 (`REPAIR_PARTY_RECOVERABLE_FRAC`).

WHY THE REPLAY STREAM IS NOT THE SOURCE (round-5 probe, a real 15.10 replay
with 36 vehicle builds): the Vehicle create-state property
`regenCrewHpLimit` — the pre-15.10-style absolute cap the earlier slice
carried as `ReplayStream.repairHpCaps` — reads `0.0` for EVERY hull in the
create state, and the live index-33 property updates carry CURRENT HP (a
44600 → 41179 damage trajectory), not a repair cap. That stream was
permanently empty dead data and was removed; this table replaces it.

Usage:
    python scripts/extract_repair_coefficients.py            # the cache dump
    python scripts/extract_repair_coefficients.py path/to/GameParams.json
    python scripts/extract_repair_coefficients.py --out /tmp/table.json

The default input is the extraction cache
(`%LOCALAPPDATA%/WoWSP-extract/GameParams.json` on Windows, produced by
`just extract`). The output is committed; re-run this script whenever the
game client version bumps.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_FULL = (
    Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
    / "WoWSP-extract"
    / "GameParams.json"
)
DEFAULT_OUT = REPO_ROOT / "packages/webui/src/data/repair_coefficients.json"

# The GameParams consumableType of the Repair Party ability (the same family
# the replay's raw `onConsumableUsed` id 8 maps onto).
REPAIR_PARTY_CONSUMABLE_TYPE = "regenCrew"


def resolve_variant(entity: Any, variant: Any) -> dict[str, Any] | None:
    """The ability entity's variant dict: the named one, else its `Default`.

    Slot entries always name a variant (`["PCY002_RegenCrew", "Default"]`);
    the `Default` fallback covers hand-written / legacy slices whose entry is
    a bare string. Returns None when neither exists.
    """
    if not isinstance(entity, dict):
        return None
    if isinstance(variant, str) and isinstance(entity.get(variant), dict):
        return entity[variant]
    if isinstance(entity.get("Default"), dict):
        return entity["Default"]
    return None


def slot_entries(ship: dict[str, Any]) -> list[tuple[Any, Any]]:
    """Every `(abilityName, variantName)` a ship can mount, slot order."""
    abilities = ship.get("ShipAbilities")
    if not isinstance(abilities, dict):
        return []
    out: list[tuple[Any, Any]] = []
    for key in sorted(k for k in abilities if k.startswith("AbilitySlot")):
        slot = abilities.get(key)
        if not isinstance(slot, dict):
            continue
        for entry in slot.get("abils") or []:
            if isinstance(entry, (list, tuple)):
                name = entry[0] if len(entry) > 0 else None
                variant = entry[1] if len(entry) > 1 else None
            else:
                name, variant = entry, None
            out.append((name, variant))
    return out


def ship_coefficient(full: dict[str, Any], ship: dict[str, Any]) -> float | None:
    """The hull's Repair-Party recoverable fraction, or None when it cannot
    mount one (or the only one it mounts restores nothing — see the header)."""
    best: float | None = None
    for name, variant in slot_entries(ship):
        if not isinstance(name, str):
            continue
        entity = full.get(name)
        if not isinstance(entity, dict):
            continue
        if (entity.get("typeinfo") or {}).get("type") != "Ability":
            continue
        spec = resolve_variant(entity, variant)
        if not isinstance(spec, dict):
            continue
        if spec.get("consumableType") != REPAIR_PARTY_CONSUMABLE_TYPE:
            continue
        logic = spec.get("logic")
        speed = logic.get("regenerationHPSpeed") if isinstance(logic, dict) else None
        work_time = spec.get("workTime")
        if not isinstance(speed, (int, float)) or isinstance(speed, bool):
            continue
        if not isinstance(work_time, (int, float)) or isinstance(work_time, bool):
            continue
        fraction = float(speed) * float(work_time)
        best = fraction if best is None else max(best, fraction)
    if best is None:
        return None
    return round(max(0.0, min(1.0, best)), 6)


def bake(full: dict[str, Any]) -> dict[str, float]:
    """The whole table: `{"<numeric ship id>": fraction}`, id-sorted."""
    out: dict[str, float] = {}
    for entity in full.values():
        if not isinstance(entity, dict):
            continue
        if (entity.get("typeinfo") or {}).get("type") != "Ship":
            continue
        ship_id = entity.get("id")
        if not isinstance(ship_id, int) or isinstance(ship_id, bool):
            continue
        coefficient = ship_coefficient(full, entity)
        # A 0.0 derivation is "no usable cap" (see the header), not a cap.
        if coefficient is None or coefficient <= 0.0:
            continue
        out[str(ship_id)] = coefficient
    return {sid: out[sid] for sid in sorted(out, key=lambda s: int(s))}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Bake the per-hull Repair-Party recoverable coefficient.",
    )
    ap.add_argument(
        "gameparams",
        nargs="?",
        type=Path,
        default=DEFAULT_FULL,
        help="full GameParams.json (default: the extraction cache dump)",
    )
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output path")
    args = ap.parse_args(argv)

    if not args.gameparams.is_file():
        print(
            f"error: GameParams not found: {args.gameparams} (run `just extract`)",
            file=sys.stderr,
        )
        return 2
    print(f"loading GameParams: {args.gameparams} …")
    full = json.loads(args.gameparams.read_text(encoding="utf-8"))

    table = bake(full)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(table, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    values = sorted(table.values())
    try:
        shown = args.out.relative_to(REPO_ROOT)
    except ValueError:
        shown = args.out  # an out-of-tree --out (tests, scratch runs)
    print(
        f"wrote {shown} — {len(table)} hulls, "
        f"{args.out.stat().st_size / 1024:.1f} KiB"
    )
    print(f"  fraction range: {values[0]:g} .. {values[-1]:g}")
    for value, count in Counter(values).most_common(8):
        print(f"  {value:g}: {count} hulls")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
