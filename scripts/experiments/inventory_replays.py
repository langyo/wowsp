#!/usr/bin/env python3
"""Inventory local .wowsreplay files without full decoding.

Reads only the JSON descriptor block (first block after the 8-byte prologue)
of each replay and reports version / ship / map / date distributions, plus a
prediction of batch-ingest compatibility (decoder method tables cover
0.11.6 -> 15.8.0; E11 vision/consumable events are 15.8.x only).

Usage:
  python scripts/experiments/inventory_replays.py [dirs ...]
Defaults to the Steam install replays folder + the Downloads replay.
"""

from __future__ import annotations

import json
import struct
import sys
from collections import Counter
from pathlib import Path

DEFAULT_DIRS = [
    Path(r"D:/SteamLibrary/steamapps/common/World of Warships/replays"),
    Path.home() / "Downloads",
]

# Ship-class tag: chars 3-4 of the vehicle code (e.g. PASB108 -> SB).
CLASS_TAGS = {
    "SB": "battleship",
    "SC": "cruiser",
    "SD": "destroyer",
    "SV": "carrier",
    "SS": "submarine",
}


def read_header(path: Path) -> dict | None:
    try:
        with path.open("rb") as f:
            head = f.read(8)
            if len(head) < 8:
                return None
            (block_count,) = struct.unpack_from("<I", head, 4)
            if not 1 <= block_count <= 1000:
                return None
            (size,) = struct.unpack("<I", f.read(4))
            if not 2 <= size <= 1_000_000:
                return None
            return json.loads(f.read(size))
    except Exception:
        return None


def ship_class(vehicle: str | None) -> str:
    if not vehicle:
        return "unknown"
    return CLASS_TAGS.get(vehicle[2:4], "unknown")


def main() -> int:
    roots = [Path(a) for a in sys.argv[1:]] or DEFAULT_DIRS
    rows = []
    for root in roots:
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*.wowsreplay")):
            h = read_header(p) or {}
            rows.append(
                {
                    "path": str(p),
                    "version": h.get("clientVersionFromExe") or h.get("clientVersionFromXml") or "?",
                    "vehicle": h.get("playerVehicle") or (p.stem.split("_")[2].split("-")[0] if len(p.stem.split("_")) > 2 else "?"),
                    "map": h.get("mapDisplayName") or h.get("mapName") or "?",
                    "datetime": h.get("dateTime") or p.stem[:15],
                    "player": h.get("playerName") or "?",
                    "gameMode": h.get("matchGroup") or h.get("gameType") or "?",
                }
            )

    print(f"total replays: {len(rows)}")
    print("\n== version ==")
    for v, n in Counter(r["version"] for r in rows).most_common():
        print(f"  {v}: {n}")
    print("\n== recorder ship class (from vehicle tag) ==")
    for c, n in Counter(ship_class(r["vehicle"]) for r in rows).most_common():
        print(f"  {c}: {n}")
    print("\n== recorder vehicle top ==")
    for v, n in Counter(r["vehicle"] for r in rows).most_common(15):
        print(f"  {v}: {n}")
    print("\n== map ==")
    for m, n in Counter(r["map"] for r in rows).most_common():
        print(f"  {m}: {n}")
    print("\n== date span ==")
    dates = sorted(r["datetime"] for r in rows if r["datetime"] != "?")
    if dates:
        print(f"  {dates[0]} .. {dates[-1]}")

    out = Path(__file__).parent / "out" / "replay_inventory.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
