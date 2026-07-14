#!/usr/bin/env python3
"""Extract the global captain-skill modifier table from GameParams.json.

GameParams stores the full skill-effect data under `Crew` entries (captain
definitions). Every Crew carries the same 82-skill table; we read one and emit
a compact `skills.json` mapping each skill's internal code → its modifiers +
LogicTrigger (for trigger skills like Adrenaline Rush). The frontend's
`skillEffects.ts` maps human-readable skill names → these internal codes.

This is a one-shot extraction (re-run after a game version update). Output:
`packages/webui/src/res/data/skills.json`.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

# GameParams.json cache written by `just extract` (run_game_params).
_CACHE_BASE = pathlib.Path(
    os.environ.get("LOCALAPPDATA") or pathlib.Path.home() / ".local" / "share"
)
GP_CACHE = _CACHE_BASE / "WoWSP-extract" / "GameParams.json"
DEFAULT_OUT = (
    pathlib.Path(__file__).resolve().parents[2]
    / "packages"
    / "webui"
    / "src"
    / "res"
    / "data"
    / "skills.json"
)


def main() -> int:
    if not GP_CACHE.exists():
        print(f"error: GameParams.json not found at {GP_CACHE}.", file=sys.stderr)
        print("Run `just extract` first (it caches GameParams.json).", file=sys.stderr)
        return 1

    print(f"[build_modifier_data] loading {GP_CACHE} ...", flush=True)
    data = json.loads(GP_CACHE.read_text(encoding="utf-8"))

    # Any Crew entry carries the shared skill table.
    crew = None
    for _name, entry in data.items():
        if entry.get("typeinfo", {}).get("type") == "Crew":
            crew = entry
            break
    if not crew:
        print("error: no Crew entry found in GameParams", file=sys.stderr)
        return 1

    skills = crew.get("Skills", {})
    print(f"[build_modifier_data] {len(skills)} skills found")

    # Compact projection: code → { modifiers, trigger }.
    # `modifiers` is the flat per-stat dict (applied when the skill is active).
    # `trigger` captures LogicTrigger.modifiers for trigger-type skills (e.g.
    # Adrenaline Rush's GMShotDelay scaling with HP), so the frontend can apply
    # the curve. Non-trigger skills have an empty trigger.
    out: dict[str, dict] = {}
    for code, sdata in skills.items():
        mods = sdata.get("modifiers", {}) or {}
        logic = sdata.get("LogicTrigger") or {}
        trig_mods = logic.get("modifiers", {}) or {}
        entry = {
            "modifiers": mods,
            "trigger": {
                "type": logic.get("triggerType", ""),
                "modifiers": trig_mods,
            } if (logic.get("triggerType") or trig_mods) else None,
        }
        # Trim empty dicts to keep the file small.
        if not mods:
            entry["modifiers"] = {}
        out[code] = entry

    DEFAULT_OUT.parent.mkdir(parents=True, exist_ok=True)
    DEFAULT_OUT.write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"[build_modifier_data] wrote {DEFAULT_OUT} ({DEFAULT_OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
