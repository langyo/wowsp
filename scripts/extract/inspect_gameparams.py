"""Inspect GameParams.json structure: find rarity / class-related fields.

GameParams.json (from `wowsunpack game-params`) is a 354MB object mapping
internal ship names (e.g. "PAAB001_Douglas_TBD") to their param blobs. We
stream-scan it to collect:
  - every distinct top-level key inside a ship param object
  - any value matching rarity-ish keywords
  - the Typeinfo block (which holds type/nation/level) for a few ships

This tells us whether rarity is an explicit field or must be derived.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"


def main() -> None:
    # Pass 1: collect distinct top-level keys of ship param objects + the
    # Typeinfo block for the first 5 ships, by streaming with a depth tracker.
    key_counter: Counter[str] = Counter()
    typeinfos: list[tuple[str, dict]] = []
    ships_scanned = 0

    with open(PATH, "r", encoding="utf-8") as f:
        # The whole thing is one big JSON object. json.load would need 354MB
        # RAM; that's fine on this machine, so just load it.
        print("loading GameParams.json ...", flush=True)
        data = json.load(f)
    print(f"loaded: {len(data)} entries", flush=True)

    for name, obj in data.items():
        if not isinstance(obj, dict):
            continue
        ships_scanned += 1
        for k in obj.keys():
            key_counter[k] += 1
        ti = obj.get("Typeinfo") or obj.get("typeinfo")
        if isinstance(ti, dict) and len(typeinfos) < 5:
            typeinfos.append((name, ti))
        if ships_scanned >= 2000:
            break

    print(f"\nscanned {ships_scanned} entries")
    print("\n=== all distinct top-level keys (count across first 2000 ships) ===")
    for k, c in sorted(key_counter.items(), key=lambda kv: -kv[1]):
        # flag any rarity-ish key
        flag = "  <-- RARITY-ISH" if re.search(r"rar|tier|level|class|group|grade|rank", k, re.I) else ""
        print(f"  {c:>5}  {k}{flag}")

    print("\n=== Typeinfo blocks (first 5 ships) ===")
    for name, ti in typeinfos:
        print(f"  {name}: {ti}")

    # Search for any rarity-ish key values across a sample
    print("\n=== values of any rarity/tier-like keys (sample) ===")
    rar_keys = [k for k in key_counter if re.search(r"rar|grade|level", k, re.I)]
    print("rarity-like keys found:", rar_keys)
    sample_shown = 0
    for name, obj in data.items():
        if not isinstance(obj, dict):
            continue
        for rk in rar_keys:
            if rk in obj:
                print(f"  {name}.{rk} = {obj[rk]!r}")
                sample_shown += 1
        if sample_shown > 30:
            break


if __name__ == "__main__":
    main()
