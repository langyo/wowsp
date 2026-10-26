#!/usr/bin/env python3
"""Bake the replay-build ID maps (numeric id to GameParams code, skill ordinal to code).

Two generated assets, both cut from the same local GameParams dump
(%LOCALAPPDATA%/WoWSP-extract/GameParams.json, written by "just extract" —
see scripts/extract/run.py / extract_gameparams.py; the vendored game-assets
CLI's "game-params --full" output: a pretty-printed dict keyed by internal
name, 2-space indent, ~359 MB / 23.8k top-level entities on the current game
build):

* packages/webui/src/data/gameparam_ids.json — every top-level entity's
  numeric "id" to its top-level name (the GameParams code)::

      {"4262645680": "PCM030_MainWeapon_Mod_I",
       "4274876336": "PCEF019_JW1_SignalFlag",
       "4284653488": "PCY009_CrashCrewPremium",
       "3409718992": "PJUH844_D9_HULL_TOP_3",
       ...}

  Replay/probe decode reports equipment, signals, consumables and upgrades
  by NUMERIC id; the frontend catalogs (modernizations.json, signals.json,
  consumable_details.json, ship_live_stats.json, ...) are keyed by code.
  This map is that join. Duplicate ids keep the FIRST name in file order and
  warn on stderr (the current dump has no duplicates: 23 859 / 23 859).

* packages/webui/src/data/crew_skill_types.json — captain-skill "skillType"
  ordinal to skill code + per-class tier row::

      {"1": {"code": "GmReloadAaDamageConstant",
             "tier": {"AirCarrier": 3, "Auxiliary": 3, "Battleship": 3,
                      "Cruiser": 3, "Destroyer": 3, "Submarine": 3}},
       ...}

  Replay/probe skill lists carry ordinals (the game's own skill identity);
  the tier row IS the point cost (tier 1..4), so a decoded skill can be
  priced and placed without a second lookup. Deduped across the 14
  "*_DefaultCrew" tables — every non-empty one carries the same 82-entry
  "Skills" map (PXW001_DefaultCrew carries none); a conflict keeps the first
  table's row and warns on stderr (none in the current dump).

Why stream instead of "json.load": the 359 MB pretty dump expands to several
GB of Python objects on a machine that may be running the app. This script
reads it line by line and parses only the 14 crew tables (<=~85 KB each), so
peak memory stays at one crew table — the ids pass keeps just the id->name
dict.

Source keys (verified on the current dump, 2026-10-26):

* top-level key line: '  "<name>": {' — an entity value is always an object;
* an entity's own id is the first '    "id": <int>,' line inside it (a
  DIRECT child at 4-space indent); no entity in the current dump misses one;
* crew tables are top-level names ending "_DefaultCrew"; their reassembled
  JSON's "Skills" is a code->spec dict, and "spec.skillType" is the ordinal
  with "spec.tier" the per-class dict. Skills without "skillType" are not
  tree skills and are skipped;
* unique commanders ("CrewPersonality" entities) carry the SAME 82-ordinal
  table (checked: 0 extra ordinals, 0 code/tier conflicts), so the
  DefaultCrew tables alone are complete; widen the scan if a future patch
  adds a commander-only skill.

Regenerate (the assets are committed; re-run after "just extract" refreshes
the cache for a new game patch)::

    python scripts/extract_gameparam_ids.py
    python scripts/extract_gameparam_ids.py --gameparams D:/path/GameParams.json
    python scripts/extract_gameparam_ids.py --out-dir /tmp/preview

The webui has no consumer for either asset yet (the replay-build UI is a
follow-up PR); the sibling .d.ts declarations only keep tsc from inferring a
24k-key literal type once it imports them.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"
DEFAULT_GAMEPARAMS = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
    / "WoWSP-extract"
    / "GameParams.json"
)
OUT_IDS = "gameparam_ids.json"
OUT_CREW = "crew_skill_types.json"
CREW_SUFFIX = "_DefaultCrew"
# The ids map must stay import-cheap for the webui bundle; the current dump
# bakes to ~1.1 MB, so anything past this points at a shape change.
MAX_IDS_BYTES = 2_000_000

# Pretty-printed dump shape (see the module docstring). All patterns anchor
# on the exact indentation levels so a nested "id"/key can never be mistaken
# for an entity's own.
_ENTRY_KEY = re.compile(r'^  "([^"]+)": \{$')
_ENTRY_KEY_PREFIX = re.compile(r'^  "')
_ENTITY_ID = re.compile(r'^    "id": (-?[0-9]+),?$')
_ENTITY_CLOSE = re.compile(r'^  }[,]?$')


def _is_int(value: object) -> bool:
    """JSON int (bools are ints in Python and must not leak in)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _human_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.2f} MB"
    return f"{size / 1024:.1f} KB"


def _rel(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def scan_gameparams(path: Path) -> tuple[dict[int, str], dict[str, list[str]], list[str]]:
    """Stream one GameParams dump.

    Returns (ids, crew_bodies, idless_names): ids maps each entity id to its
    top-level name (first name wins on a duplicate), crew_bodies holds the raw
    lines of the *_DefaultCrew entries (the only ones this bake parses as
    JSON), and idless_names lists entities without a direct "id" child
    (skipped, reported by the caller).
    """
    ids: dict[int, str] = {}
    crew_bodies: dict[str, list[str]] = {}
    idless: list[str] = []
    state: dict[str, object] = {"name": None, "crew": False, "id": None, "lines": []}

    def flush() -> None:
        raw_name = state["name"]
        if raw_name is None:
            return
        name = str(raw_name)
        ident = state["id"]
        if ident is None:
            idless.append(name)
        else:
            kept = ids.get(int(ident))
            if kept is not None:
                print(
                    f"warning: duplicate id {ident}: keeping {kept} "
                    f"(first in file order), dropping {name}",
                    file=sys.stderr,
                )
            else:
                ids[int(ident)] = name
        if state["crew"]:
            crew_bodies[name] = state["lines"]  # type: ignore[assignment]
        state["name"] = None
        state["crew"] = False
        state["id"] = None
        state["lines"] = []

    with path.open("r", encoding="utf-8", newline="") as handle:
        first = handle.readline()
        if first.strip() != "{":
            raise SystemExit(
                f"error: {path}: expected a pretty-printed GameParams object "
                f"dump, got {first.strip()[:40]!r} - re-run 'just extract'"
            )
        for raw in handle:
            line = raw.rstrip("\r\n")
            match = _ENTRY_KEY.match(line)
            if match:
                flush()
                name = match.group(1)
                state["name"] = name
                state["crew"] = name.endswith(CREW_SUFFIX)
                continue
            if _ENTRY_KEY_PREFIX.match(line):
                # A top-level key whose value is not an object would silently
                # fold into the previous entity - reject the shape instead.
                raise SystemExit(
                    f"error: {path}: top-level entry is not an object: "
                    f"{line[:60]!r} - re-run 'just extract'"
                )
            if state["name"] is None:
                # Root closing brace / stray blank lines.
                continue
            if state["id"] is None:
                id_match = _ENTITY_ID.match(line)
                if id_match:
                    state["id"] = int(id_match.group(1))
            if state["crew"]:
                state["lines"].append(line)  # type: ignore[union-attr]
        flush()
    return ids, crew_bodies, idless


def crew_skills(
    crew_bodies: dict[str, list[str]],
) -> tuple[dict[int, dict[str, object]], int]:
    """Fold the *_DefaultCrew tables into ordinal -> skill record.

    Returns (ordinals, parsed_tables); each record is
    {"code": <GameParams skill code>, "tier": {<class>: <tier 1..4>}}.
    Ordinals are deduped across tables: an identical row is free, a
    conflicting one keeps the first table's row and warns on stderr.
    """
    ordinals: dict[int, dict[str, object]] = {}
    parsed_tables = 0
    for name in sorted(crew_bodies):
        lines = crew_bodies[name]
        close = next(
            (index for index, line in enumerate(lines) if _ENTITY_CLOSE.match(line)),
            None,
        )
        if close is None:
            print(
                f"warning: {name}: crew table has no closing line - skipped",
                file=sys.stderr,
            )
            continue
        try:
            table = json.loads("{\n" + "\n".join(lines[:close]) + "\n}")
        except json.JSONDecodeError as exc:
            print(
                f"warning: {name}: crew table did not parse ({exc}) - skipped",
                file=sys.stderr,
            )
            continue
        rows = table.get("Skills")
        if not isinstance(rows, dict) or not rows:
            print(f"[crew_skill_types] {name}: carries no Skills table - skipped")
            continue
        parsed_tables += 1
        for code, spec in rows.items():
            if not isinstance(code, str) or not isinstance(spec, dict):
                continue
            ordinal = spec.get("skillType")
            if not _is_int(ordinal):
                continue
            tier: dict[str, int] = {}
            raw_tier = spec.get("tier")
            if isinstance(raw_tier, dict):
                for cls, value in sorted(raw_tier.items()):
                    if isinstance(cls, str) and _is_int(value):
                        tier[cls] = int(value)
            row: dict[str, object] = {"code": code, "tier": tier}
            kept = ordinals.get(int(ordinal))
            if kept is None:
                ordinals[int(ordinal)] = row
            elif kept != row:
                print(
                    f"warning: skillType {ordinal}: keeping {kept['code']} "
                    f"(first crew table), dropping {code} ({name})",
                    file=sys.stderr,
                )
    return ordinals, parsed_tables


def dump_json(path: Path, payload: object) -> None:
    """Write one committed asset: indent=1, LF endings, final newline."""
    text = json.dumps(payload, ensure_ascii=False, indent=1) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--gameparams",
        default=str(DEFAULT_GAMEPARAMS),
        help="unpacked full GameParams.json (default: the shared 'just extract' cache)",
    )
    parser.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help="output directory (default: packages/webui/src/data)",
    )
    args = parser.parse_args(argv)

    gameparams = Path(args.gameparams)
    out_dir = Path(args.out_dir)
    if not gameparams.is_file():
        raise SystemExit(f"error: {gameparams} not found - run 'just extract' first")
    out_dir.mkdir(parents=True, exist_ok=True)

    ids, crew_bodies, idless = scan_gameparams(gameparams)
    if not ids:
        raise SystemExit("error: no entity ids found - is this really a GameParams dump?")
    for name in idless:
        print(f'warning: {name}: no direct "id" - skipped', file=sys.stderr)

    ids_path = out_dir / OUT_IDS
    dump_json(ids_path, {str(ident): ids[ident] for ident in sorted(ids)})
    ids_size = ids_path.stat().st_size
    print(
        f"[gameparam_ids] {len(ids)} ids | {_human_size(ids_size)} -> {_rel(ids_path)}"
    )
    if ids_size > MAX_IDS_BYTES:
        print(
            f"warning: {_rel(ids_path)} is past the {_human_size(MAX_IDS_BYTES)} "
            "budget - check the dump shape",
            file=sys.stderr,
        )

    ordinals, tables = crew_skills(crew_bodies)
    if not ordinals:
        print(
            f"warning: no *_DefaultCrew skill table found - {OUT_CREW} left untouched",
            file=sys.stderr,
        )
        return 0
    crew_path = out_dir / OUT_CREW
    dump_json(crew_path, {str(ordinal): ordinals[ordinal] for ordinal in sorted(ordinals)})
    print(
        f"[crew_skill_types] {tables} crew tables | {len(ordinals)} ordinals "
        f"({min(ordinals)}..{max(ordinals)}) | {_human_size(crew_path.stat().st_size)} "
        f"-> {_rel(crew_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
