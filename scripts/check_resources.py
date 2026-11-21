#!/usr/bin/env python3
"""Pre-flight resource check for the replay/3D dev surface.

The 3D replay view loads ship GLBs, map meshes and the minimap index from
the app cache root (%LOCALAPPDATA%\\WoWSP on Windows desktop, the portable
`data` directory in portable builds) via the Tauri asset protocol. When that
pack is missing or unpopulated, the view starts with an empty scene (0
triangles) and no error the user can act on.

This check runs before `just dev` spawns the app and fails loudly with the
fix instead:

  * no cache stamp   -> the res pack was never downloaded: run the app once
    and use the resource hub's download entry (or copy a pack into the
    cache root);
  * models/ships empty -> re-bake with `just bake-ships` / `just bake-maps`
    (requires the game files) or re-download the pack.

Exit codes: 0 = pack present; 1 = pack missing/unusable (message printed).

Usage: python scripts/check_resources.py [--root <cacheRoot>] [--quiet]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

CACHE_VERSION_FILE = ".res-version.json"


def default_cache_root() -> Path:
    """The desktop cache root, mirroring tauri paths.rs cache_dir()."""
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        # Portable/dev shorthand: keep the check usable without the shell vars.
        home = Path.home()
        base = str(home / "AppData" / "Local")
    return Path(base) / "WoWSP"


def count_models(root: Path) -> tuple[int, int]:
    ships = root / "models" / "ships"
    maps = root / "models" / "maps"
    ships_n = sum(1 for p in ships.glob("*.glb")) if ships.is_dir() else 0
    maps_n = sum(1 for p in maps.glob("*")) if maps.is_dir() else 0
    return ships_n, maps_n


def main() -> int:
    ap = argparse.ArgumentParser(description="check the replay resource pack")
    ap.add_argument("--root", default=None, help="cache root override")
    ap.add_argument("--quiet", action="store_true", help="only print on failure")
    args = ap.parse_args()

    root = Path(args.root) if args.root else default_cache_root()
    stamp = root / CACHE_VERSION_FILE
    ships, maps = count_models(root)

    if args.quiet and stamp.is_file() and ships > 0:
        return 0

    ok = stamp.is_file() and ships > 0 and maps > 0
    if ok:
        if not args.quiet:
            print(
                f"resources: ok — {root} (ships {ships} glb, maps {maps} files, "
                f"stamp present)"
            )
        return 0

    print(f"resources: MISSING or incomplete under {root}", file=sys.stderr)
    if not stamp.is_file():
        print(
            "  - no .res-version.json stamp: the res pack was never downloaded.",
            file=sys.stderr,
        )
        print(
            "    Fix: run the app once and download the resource pack from the",
            file=sys.stderr,
        )
        print("    in-app resource hub (or copy a pack into the cache root).", file=sys.stderr)
    if ships == 0:
        print("  - models/ships carries no .glb files.", file=sys.stderr)
        print(
            "    Fix: just bake-ships (requires the game files) or re-download",
            file=sys.stderr,
        )
    if maps == 0:
        print("  - models/maps carries no files.", file=sys.stderr)
        print("    Fix: just bake-maps (requires the game files).", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
