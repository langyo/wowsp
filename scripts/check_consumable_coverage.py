#!/usr/bin/env python3
"""
Fleet-wide consumable-mount audit over the realm GameParams dumps.

Mirrors the frontend resolution exactly (webui src/components/ships/
consumables.ts buildConsumableSlots → resolveEntry): every non-special
AbilitySlot whose abils carry [entity, variant] string pairs must resolve
against the baked data/consumable_details.json (entities → variants), or the
modal silently drops the row.

Historical context this audit guards: the bake used to cover the WG client
only, so 272 Lesta-realm (Мир кораблей) ships mounted entity/variant pairs
the bake lacked — whole Defensive-AA-Fire columns dropped from the UI even
though Lesta still ships that consumable (the realms legitimately differ;
build_consumable_details.py now merges the Lesta entities in).

Per realm the audit reports:
  - ships mounting an entity the bake does not know (whole rows dropped);
  - mounted pairs whose variant the bake does not know (rows dropped);
  - each miss justified against the dump itself: a variant present in the
    dump but excluded by the bake's filters (group != "ship" / isFake) is a
    deliberate drop, a variant absent from the dump entity is broken game
    test data (the client drops those rows too).

Acceptance: WG may keep at most ONE ship with unresolved mounts (broken test
data — e.g. PJSC769_Ota once mounted variants its own dump lacked); Lesta
must resolve every mounted pair.

Inputs (auto-picked by default, like build_consumable_details.py): the
%LOCALAPPDATA%/WoWSP-extract dumps produced by 'just extract' — WG
GameParams.json and Lesta GameParams_lesta.json — plus the committed bake.
Local dumps only; CI cannot run this.

Usage:
    python scripts/check_consumable_coverage.py
    python scripts/check_consumable_coverage.py --gameparams /path/to/GameParams.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BAKE = ROOT / "packages/webui/src/data/consumable_details.json"
CACHE = (
    Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
    / "WoWSP-extract"
)

# Top-level dump entries — ship entries (PJSC769_Ota) and consumable ability
# entities (PCY011_AirDefenseDispPremium) share the prefix.
NAME_RE = re.compile(r"^P[A-Z]{3}\d{3}_")
ENTRY_HEAD_RE = re.compile(r'\n  "([^"]+)": ')

MAX_WG_UNRESOLVED_SHIPS = 1  # the known broken-test-data allowance


def iter_entries(txt: str):
    """Slice a pretty-printed GameParams dict into (name, entry) pairs without
    holding every parsed entry at once."""
    starts = [m.start() for m in re.finditer(r'\n  "', txt)]
    starts.append(len(txt))
    for i in range(len(starts) - 1):
        seg = txt[starts[i]:starts[i + 1]]
        m = ENTRY_HEAD_RE.match(seg)
        if not m:
            continue
        body = seg[m.end():].rstrip()
        while body.endswith(","):
            body = body[:-1].rstrip()
        try:
            yield m.group(1), json.loads(body)
        except ValueError:
            continue


def scan_dump(txt: str):
    """(ships scanned, mount pair → ship names, dump entity variants).

    The mount collection mirrors buildConsumableSlots: AbilitySlot keys only,
    isSpecial slots skipped, numeric slot required, [entity, variant] string
    pairs. The dump entity map keeps each variant's (group, isFake) so a bake
    miss can be told from broken game data."""
    ships = 0
    pairs: dict[tuple[str, str], list[str]] = defaultdict(list)
    dump_variants: dict[str, dict[str, tuple[Any, bool]]] = {}
    for name, entry in iter_entries(txt):
        if not isinstance(entry, dict):
            continue
        if NAME_RE.match(name) and any(
            isinstance(v, dict) and v.get("group") == "ship"
            for v in entry.values()
        ):
            dump_variants[name] = {
                vn: (vd.get("group"), bool(vd.get("isFake")))
                for vn, vd in entry.items()
                if isinstance(vd, dict)
            }
        abilities = entry.get("ShipAbilities")
        if not isinstance(abilities, dict):
            continue
        ships += 1
        for key, slot in abilities.items():
            if not key.startswith("AbilitySlot") or not isinstance(slot, dict):
                continue
            if slot.get("isSpecial"):
                continue
            slot_no = slot.get("slot")
            if not isinstance(slot_no, (int, float)) or isinstance(slot_no, bool):
                continue
            for pair in slot.get("abils") or []:
                if (
                    isinstance(pair, list)
                    and len(pair) >= 2
                    and isinstance(pair[0], str)
                    and isinstance(pair[1], str)
                ):
                    pairs[(pair[0], pair[1])].append(name)
    return ships, pairs, dump_variants


def audit(
    realm: str,
    path: Path,
    bake: dict[str, Any],
    limit: int,
) -> int:
    """Print the realm's unresolved-mount report; ships found unresolved."""
    if not path.is_file():
        print(f"{realm}: dump not found ({path}) — skipped")
        return 0
    entities = bake["entities"]
    txt = path.read_text(encoding="utf-8")
    ships, pairs, dump_variants = scan_dump(txt)

    ent_missing: dict[str, set[str]] = defaultdict(set)
    var_missing: dict[tuple[str, str], set[str]] = {}
    for (entity, variant), ship_names in pairs.items():
        if entity not in entities:
            ent_missing[entity].update(ship_names)
        elif variant not in entities[entity]["variants"]:
            var_missing[(entity, variant)] = set(ship_names)

    unresolved_ships = {s for names in ent_missing.values() for s in names}
    unresolved_ships |= {s for names in var_missing.values() for s in names}

    print(f"{realm} ({path.name}): {ships} ships, {len(pairs)} distinct "
          f"mounted pairs, {len(unresolved_ships)} ships with unresolved mounts")
    for entity in sorted(ent_missing):
        print(f"  missing ENTITY {entity}: "
              f"{len(ent_missing[entity])} ships "
              f"(in dump: {entity in dump_variants})")
    for (entity, variant), ship_names in sorted(var_missing.items()):
        dump_v = dump_variants.get(entity, {})
        if variant in dump_v:
            group, fake = dump_v[variant]
            why = f"deliberate bake filter: group={group!r}, isFake={fake}"
        elif entity in dump_variants:
            why = "broken game data: variant absent from the dump entity"
        else:
            why = "entity absent from the dump entirely"
        shown = ", ".join(sorted(ship_names)[:limit])
        more = " …" if len(ship_names) > limit else ""
        print(f"  missing VARIANT {entity} :: {variant}: "
              f"{len(ship_names)} ships — {why}")
        print(f"    ships: {shown}{more}")
    return len(unresolved_ships)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--gameparams", type=Path, default=CACHE / "GameParams.json",
                    help="WG GameParams.json dump (default: the extract cache)")
    ap.add_argument("--lesta-gameparams", type=Path,
                    default=CACHE / "GameParams_lesta.json",
                    help="Lesta GameParams.json dump (default: the extract cache)")
    ap.add_argument("--bake", type=Path, default=DEFAULT_BAKE,
                    help="baked consumable_details.json to audit")
    ap.add_argument("--limit", type=int, default=8,
                    help="ship names listed per missing pair")
    args = ap.parse_args(argv)

    if not args.bake.is_file():
        print(f"error: bake not found: {args.bake}", file=sys.stderr)
        return 1
    bake = json.loads(args.bake.read_text(encoding="utf-8"))

    wg_found = audit("WG", args.gameparams, bake, args.limit)
    lesta_found = audit("Lesta", args.lesta_gameparams, bake, args.limit)

    ok = wg_found <= MAX_WG_UNRESOLVED_SHIPS and lesta_found == 0
    print(f"acceptance: WG <= {MAX_WG_UNRESOLVED_SHIPS} unresolved ship(s) "
          f"(found {wg_found}), Lesta 0 (found {lesta_found}) → "
          f"{'OK' if ok else 'FAIL'}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
