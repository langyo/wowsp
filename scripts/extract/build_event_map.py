"""Build a ship_id → event map — the "活动·<event name>" ship tag's data.

Which ships are EVENT ships, and of which event, is the game's own call:
GameParams' `peculiarity` field attributes every hull to its event family
(`azurlane`, `arpeggio`, `startrek_visible`, `halloween_16`, …) far more
reliably than name suffixes. This script resolves, per Ship entity:

  1. exclusions — mode-support NPCs and bots (convoy escorts, invisible
     air units, capture helpers) are not player ships and get no badge;
  2. `peculiarity` families → stable event ids (the collabs map 1:1; the
     Halloween family splits by the `_H20xx` name-suffix year, with the
     unsuffixed 2016 bosses keyed by the ally/enemy peculiarity flags);
  3. name/regex fallbacks for hulls the peculiarity system misses — Azur
     Lane ships without the tag, the Piñata April-Fools hulls (their
     peculiarity is only `decorative`), the modern-era missile hulls, the
     Halloween-event submarines, and the Star Trek mode monsters;
  4. plain `decorative` hulls (Black_, Gold_, STPatric_, East_, Cyber_,
     Olympian_, Pirate_… — permanently sold novelty variants) are
     deliberately NOT badged: they are premium series, not events.

The output is keyed by the WG `ship_id` the encyclopedia returns, joined
through wowsinfo.json's ship_id → index bridge (same join
build_rarity_map.py uses — GameParams.id is NOT the ship_id). Ships absent
from the bridge never surface in the UI and are dropped.

Event ids, official localized names and first-appearance versions live in
the frontend registry (`utils/shipEvents.ts` + res/i18n/locales/*/ships.json
`ships.event.*`); this script only decides membership, deterministically,
so it can be re-run on every game build.

Inputs:
  --gameparams : unpacked GameParams.json (default: the WoWSP-extract cache)
  --bridge     : wowsinfo.json (ship_id → index; same source as
                 build_rarity_map.py)
  --out        : packages/webui/src/data/ship_events.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_GAMEPARAMS = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    / "WoWSP-extract"
    / "GameParams.json"
)
DEFAULT_BRIDGE = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    / "WoWSP-extract"
    / "wowsinfo.json"
)
DEFAULT_OUT = REPO_ROOT / "packages/webui/src/data/ship_events.json"

# peculiarity → event id (1:1 families).
PECULIARITY_EVENTS = {
    "azurlane": "collab_azur_lane",
    "arpeggio": "collab_arp",
    "highSchoolFleet": "collab_hsf",
    "warhammer": "collab_wh40k",
    "ba": "collab_blue_archive",
    "megadeth": "collab_megadeth",
    "april_space": "space_battles",
    "rangers": "star_event",
    "startrek_visible": "collab_star_trek",
    "post_apocalypse": "postap_2022",
    "first_april_2023": "april_fools_2023",
    "ch_dragons": "lunar_new_year",
    "corona": "lunar_new_year",
    "reconstruction": "hunt_bismarck",
    "scarlet_future": "scarlet_future",
}
HALLOWEEN_PECULIARITIES = {"halloween_16", "halloween_2016_ally", "halloween_2016_enemy"}

# Name-regex fallbacks, applied in order when the peculiarity is default or
# decorative. Regexes test the entity NAME (e.g. PXSC519_Azur_Azuma).
NAME_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("collab_azur_lane", re.compile(r"(?:^|_)Azur|AZUR")),
    ("collab_arp", re.compile(r"(?:^|_)ARP_|Arpeggio")),
    ("collab_hsf", re.compile(r"(?:^|_)HSF")),
    ("collab_wh40k", re.compile(r"Warhammer|Ignis_Purgatio|Ragnarok|Cross_of_Dorn|Ship_Smasha|WAAAGH")),
    ("collab_blue_archive", re.compile(r"(?:^|_)BA(?:_|$)")),
    ("april_fools_2024", re.compile(r"^P[A-Z]S[A-Z]9\d+_Pinata_")),
    ("halloween_2022", re.compile(r"^PXSS\d07_")),
]

# Tag fallbacks for hulls the peculiarity system leaves on `default` but the
# catalogue tags directly (HSF Harekaze II carries tag `hsf` with no pec and
# no name hint). Bare `anime` is ambiguous across collabs — not mapped.
TAG_EVENTS = {
    "hsf": "collab_hsf",
    "azur": "collab_azur_lane",
    "arpeggio": "collab_arp",
    "wh40k": "collab_wh40k",
}

# Modern-era missile hulls: nation Events + _modern suffix (plus the one
# Liberty support hull that follows the same scheme).
MODERN_ERA_RE = re.compile(r"_modern2?$")

# Star Trek mode monsters (Dagon Corp) — nation Events hulls the
# peculiarity system leaves on `default`.
STAR_TREK_MONSTERS = {"PXSB015", "PXSC016", "PXSD025"}

# Mode-support / bot hulls: no player-facing badge.
NPC_INDEX_RE = re.compile(r"^PXSX\d+")


def classify(
    name: str, index: str, nation: str, peculiarity: str, flag: str, tags: list[str]
) -> str | None:
    """Event id for one ship entity, or None for a non-event ship."""
    if nation == "Events":
        if NPC_INDEX_RE.match(index) or index in ("PXSA001", "PXSA002", "PXSC503"):
            return None
        if index in STAR_TREK_MONSTERS:
            return "collab_star_trek"
        if MODERN_ERA_RE.search(name):
            return "modern_era"

    if peculiarity in HALLOWEEN_PECULIARITIES:
        year = re.search(r"_H(20\d\d)$", name)
        if year:
            return f"halloween_{year.group(1)}"
        # Unsuffixed hulls of the family are the 2016 bosses/allies.
        if peculiarity in ("halloween_2016_ally", "halloween_2016_enemy") or flag in (
            "halloween_2016_ally",
            "halloween_2016_enemy",
        ):
            return "halloween_2016"
        return None

    hit = PECULIARITY_EVENTS.get(peculiarity)
    if hit:
        return hit

    if peculiarity in ("", "default", "decorative", None):
        for tag in tags:
            hit = TAG_EVENTS.get(tag)
            if hit:
                return hit
        for event, pattern in NAME_RULES:
            if pattern.search(name):
                return event
    return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gameparams", type=Path, default=DEFAULT_GAMEPARAMS)
    ap.add_argument("--bridge", type=Path, default=DEFAULT_BRIDGE)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)

    for path, what in ((args.gameparams, "gameparams"), (args.bridge, "bridge")):
        if not path.exists():
            print(f"error: {what} not found: {path}", file=sys.stderr)
            print(
                "hint: it is the shared WoWSP-extract cache; run the wowsunpack "
                "extract flow first (see scripts/extract/_common.py).",
                file=sys.stderr,
            )
            return 1

    print(f"loading bridge {args.bridge} ...", flush=True)
    bridge = json.loads(args.bridge.read_text(encoding="utf-8"))
    index_to_ship_id: dict[str, str] = {}
    for sid, ent in (bridge.get("ships") or {}).items():
        if isinstance(ent, dict) and ent.get("index"):
            index_to_ship_id[str(ent["index"])] = str(sid)

    print(f"loading gameparams {args.gameparams} ...", flush=True)
    dump = json.loads(args.gameparams.read_text(encoding="utf-8"))
    root = dump.get("", dump) if isinstance(dump, dict) else dump

    out: dict[str, str] = {}
    skipped_npc = 0
    per_event: Counter[str] = Counter()
    for name, ent in root.items():
        if not isinstance(ent, dict):
            continue
        typeinfo = ent.get("typeinfo") or {}
        if typeinfo.get("type") != "Ship":
            continue
        index = str(ent.get("index") or "")
        event = classify(
            name=name,
            index=index,
            nation=str(typeinfo.get("nation") or ""),
            peculiarity=str(ent.get("peculiarity") or ""),
            flag=str(ent.get("peculiarityFlag") or ""),
            tags=[str(t) for t in ent.get("tags") or [] if isinstance(t, str)],
        )
        if event is None:
            continue
        ship_id = index_to_ship_id.get(index)
        if ship_id is None:
            skipped_npc += 1
            continue
        out[ship_id] = event
        per_event[event] += 1

    ordered = {sid: out[sid] for sid in sorted(out, key=int)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(ordered, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )

    shown = args.out
    try:
        shown = args.out.absolute().relative_to(REPO_ROOT)
    except ValueError:
        pass
    print(f"wrote {shown} — {len(out)} ships across {len(per_event)} events "
          f"({skipped_npc} unbridged event hulls dropped)")
    for event, count in sorted(per_event.items(), key=lambda kv: -kv[1]):
        print(f"  {event}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
