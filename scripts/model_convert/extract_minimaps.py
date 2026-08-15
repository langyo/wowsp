#!/usr/bin/env python3
"""Extract the in-game minimap art + world bounds for every converted map.

The holographic replay's bottom-right minimap overlay draws the game's own
minimap image as its base layer. The game ships two textures per space:

  - `spaces/<id>/minimap_water.png` — water/sea background (760x760, opaque)
  - `spaces/<id>/minimap.png`       — land overlay (760x760, alpha)

This script composites them into one RGB PNG per map and records the
space.settings world bounds (chunk coords x100, matching the map GLB and the
replay's world coordinates) so the frontend can project ship positions onto
the image correctly.

Outputs (next to the baked map GLBs):
  packages/webui/src/res/models/maps/minimaps/<spaceId>.png   (760x760 RGB, native)
  packages/webui/src/res/models/maps/minimaps.json            ({id: bounds})

Usage:
    python scripts/model_convert/extract_minimaps.py            # missing only
    python scripts/model_convert/extract_minimaps.py --force    # re-extract all
    just extract-minimaps
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path, find_wowsunpack  # noqa: E402

MAPS_DIR = (
    Path(__file__).resolve().parents[2]
    / "packages" / "webui" / "src" / "res" / "models" / "maps"
)
MINIMAP_SIZE = 760  # native art resolution (was 512 — blurry when zoomed)

def parse_bounds(settings_xml: str) -> dict[str, float] | None:
    """World bounds of the *minimap art* for a space.

    The game's own minimap covers the central `(chunks - 4) * chunk_size`
    metres of the space (see wows-minimap-renderer: `space_size = (chunks-4)
    * chunk_size`), i.e. two chunks are cropped on every side relative to the
    space.settings <bounds> rect that the terrain GLB uses. Ship-position
    projection must use this cropped rect or dots drift onto islands.

    <bounds> is in chunk coordinates (chunk = 100 world units) and appears in
    two spellings: attributes on <bounds> (battle maps) and child elements
    (older/dock maps). Tiny spaces (docks) crop to nothing — those yield no
    entry."""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(settings_xml)
    except ET.ParseError:
        return None
    node = root.find(".//bounds")
    if node is None:
        return None

    def val(name: str) -> float | None:
        raw = node.get(name)
        if raw is None:
            child = node.find(name)
            raw = child.text if child is not None else None
        try:
            return float(str(raw).strip())
        except (TypeError, ValueError):
            return None

    min_x, max_x = val("minX"), val("maxX")
    min_y, max_y = val("minY"), val("maxY")
    if None in (min_x, max_x, min_y, max_y):
        return None
    # Symmetric crop: the minimap covers the central (chunks-4) chunk band,
    # i.e. 2 chunks cropped on EVERY side of the settings rect. The previous
    # +2/-1 asymmetry shifted the window one chunk north — the art's top
    # strip rendered off-canvas.
    out = {
        "minX": (min_x + 2.0) * 100.0,
        "maxX": (max_x - 2.0) * 100.0,
        "minZ": (min_y + 2.0) * 100.0,
        "maxZ": (max_y - 2.0) * 100.0,
    }
    if out["maxX"] <= out["minX"] or out["maxZ"] <= out["minZ"]:
        return None
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract minimap art + bounds for converted maps")
    parser.add_argument("--force", action="store_true", help="re-extract even if the PNG exists")
    parser.add_argument("--game-dir", default=None, help="game install path (default: auto-detect)")
    parser.add_argument("--limit", type=int, default=0, help="max maps this run (0=all)")
    args = parser.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print("error: World of Warships install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1
    wowsunpack = find_wowsunpack()
    if not wowsunpack:
        print("error: wowsunpack not found. Set WOWSP_WOWSUNPACK.", file=sys.stderr)
        return 1

    out_dir = MAPS_DIR / "minimaps"
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = MAPS_DIR / "minimaps.json"
    existing_bounds: dict[str, dict[str, float]] = {}
    if json_path.exists():
        existing_bounds = json.loads(json_path.read_text(encoding="utf-8"))

    # Maps to process = those with a baked GLB. Without --force, skip only
    # maps that already have both the PNG and a bounds entry.
    space_ids = sorted(p.stem for p in MAPS_DIR.glob("*.glb"))
    if not args.force:
        space_ids = [
            sid
            for sid in space_ids
            if not (out_dir / f"{sid}.png").exists() or sid not in existing_bounds
        ]
    if args.limit > 0:
        space_ids = space_ids[: args.limit]
    if not space_ids:
        print("[extract_minimaps] nothing to do (all present). Use --force to redo.")
        return 0
    print(f"[extract_minimaps] {len(space_ids)} maps to extract")

    # One wowsunpack pass for all three file types (each invocation re-opens
    # the game idx, which costs several seconds).
    with tempfile.TemporaryDirectory() as tmp:
        patterns = [
            "/spaces/*/minimap.png",
            "/spaces/*/minimap_water.png",
            "/spaces/*/space.settings",
        ]
        rc = subprocess.call(
            [str(wowsunpack), "--game-dir", game, "extract", "-o", tmp, *patterns]
        )
        if rc != 0:
            print(f"error: wowsunpack extract failed (rc={rc})", file=sys.stderr)
            return rc

        # Delayed import: PIL is only needed for the composite step.
        from PIL import Image

        bounds_map: dict[str, dict[str, float]] = dict(existing_bounds)

        ok = 0
        skipped: list[str] = []
        for i, sid in enumerate(space_ids):
            sdir = Path(tmp) / "spaces" / sid
            water_p = sdir / "minimap_water.png"
            land_p = sdir / "minimap.png"
            settings_p = sdir / "space.settings"

            if settings_p.exists():
                b = parse_bounds(settings_p.read_text(encoding="utf-8", errors="replace"))
                if b:
                    bounds_map[sid] = b

            if not water_p.exists() and not land_p.exists():
                skipped.append(sid)
                print(f"  [{i+1}/{len(space_ids)}] - {sid}: no minimap art (dock/scenario?)")
                continue

            base = Image.open(water_p).convert("RGBA") if water_p.exists() else None
            if base is None:
                base = Image.new("RGBA", (760, 760), (18, 34, 54, 255))
            if land_p.exists():
                land = Image.open(land_p).convert("RGBA")
                if land.size != base.size:
                    land = land.resize(base.size, Image.LANCZOS)
                base.alpha_composite(land)
            out = base.convert("RGB").resize((MINIMAP_SIZE, MINIMAP_SIZE), Image.LANCZOS)
            out.save(out_dir / f"{sid}.png", optimize=True)
            ok += 1
            print(f"  [{i+1}/{len(space_ids)}] + {sid}")

        # Drop degenerate entries (either produced this run or carried over
        # from a previous json) so the frontend never sees inverted bounds.
        bounds_map = {
            k: v
            for k, v in bounds_map.items()
            if v["maxX"] > v["minX"] and v["maxZ"] > v["minZ"]
        }
        json_path.write_text(
            json.dumps(bounds_map, indent=2, sort_keys=True), encoding="utf-8"
        )

    print(f"[extract_minimaps] done: {ok} extracted, {len(skipped)} without art; "
          f"bounds for {len(bounds_map)} maps in minimaps.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
