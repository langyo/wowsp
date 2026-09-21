#!/usr/bin/env python3
"""Archive local replays into a durable store.

The WoWS client keeps only the LAST ~30 replays of the current version in the
replays root (older-version replays survive in version subfolders) — anything
not archived is silently deleted by the game. This script mirrors every
*.wowsreplay under the game's replays folder into a durable archive
(default `%LOCALAPPDATA%/WoWSP/replay-archive/`), skipping files already
archived (same relative path + same size). Safe to run repeatedly.

Usage:
  python scripts/experiments/archive_replays.py [--src DIR] [--dst DIR] [--dry-run]
Default source: the Steam install's replays folder.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

DEFAULT_SRC = Path(r"D:/SteamLibrary/steamapps/common/World of Warships/replays")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--src", type=Path, default=DEFAULT_SRC, help="game replays folder")
    p.add_argument(
        "--dst",
        type=Path,
        default=Path.home() / "AppData/Local/WoWSP/replay-archive",
        help="durable archive folder",
    )
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if not args.src.is_dir():
        print(f"source not found: {args.src}")
        return 2

    replays = sorted(args.src.rglob("*.wowsreplay"))
    new, kept = [], 0
    for src in replays:
        rel = src.relative_to(args.src)
        dst = args.dst / rel
        if dst.is_file() and dst.stat().st_size == src.stat().st_size:
            kept += 1
            continue
        new.append((src, dst))

    print(f"archive {args.dst}")
    print(f"  source replays: {len(replays)} (already archived {kept}, new {len(new)})")
    for src, dst in new:
        print(f"  + {src.relative_to(args.src)}")
        if not args.dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    if args.dry_run:
        print("(dry run — nothing copied)")
    else:
        total = sum(1 for _ in args.dst.rglob("*.wowsreplay"))
        print(f"  archive now holds {total} replays")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
