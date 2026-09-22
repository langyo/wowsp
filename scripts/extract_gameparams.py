"""Build the offline GameParams ship-data pack for the Android bundle.

The phone app has no WoWS install to unpack GameParams.data from, so the
APK embeds a pre-extracted pack under the webui's public dir:

  packages/webui/src/res/data/gameparams/<shipId>.json   one ship's raw
                                                         GameParams subtree
                                                         (same file format
                                                         the desktop app's
                                                         %APPDATA% per-ship
                                                         cache uses — see
                                                         commands/gameparams.rs)
  packages/webui/src/res/data/gameparams/upgrade-prices.json
                                                         modernization
                                                         credit prices
                                                         (double-keyed map)
  packages/webui/src/res/data/gameparams/build.txt       source game build

The directory is gitignored (like the GLB pack): it is derived data,
regenerated from a local extract by the android just recipes before the
webui build (WOWSP_MOBILE_BUNDLE=1 keeps it in dist; desktop builds prune
it — the desktop reads the install instead). Rust side reads the files
back through the Tauri asset resolver after the appdata-cache miss.

Ship selection mirrors `get_ship_gameparams` semantics exactly: every
entity with `typeinfo.type == "Ship"` carrying an `A_*` weapon block,
keyed by its numeric `id` (`ShipId` fallback); when several entities
share an id (CV hull + plane squadrons) the one with `A_Artillery` wins,
failing that the first with any `A_*` key. The per-ship JSON is written
compact with sorted keys — the exact shape `serde_json::to_string` gives
the desktop cache (serde_json's BTreeMap ordering), so both caches are
field-for-field interchangeable.

Inputs:
  --input  : unpacked GameParams.json (default: the shared orchestrator
             cache at %LOCALAPPDATA%/WoWSP-extract/GameParams.json; when
             missing but a game install is found, one is generated via
             the vendored wowsunpack CLI — a one-time ~350 MB dump)
  --game   : game install root (build detection; auto-detected otherwise)
  --build  : explicit source build number (overrides --game detection)
  --out    : output directory (default below)

Run standalone or via the android just recipes, which re-run it whenever
build.txt lags the installed game's build (the same freshness rule the
desktop appdata cache applies).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "extract"))
from _common import find_game_path, latest_bin_with_idx, run_game_params  # noqa: E402

DEFAULT_OUT = ROOT / "packages/webui/src/res/data/gameparams"
CACHE_DIR = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract"
GAMEPARAMS_JSON = CACHE_DIR / "GameParams.json"


def _as_int(value: object) -> int | None:
    """Coerce a JSON number/string to int (mirrors pickled_as_i64)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _has_weapon_block(entity: dict) -> bool:
    """Any top-level `A_*` key (the Rust pack check is `starts_with("A_")`)."""
    return any(k.startswith("A_") for k in entity)


def _entities(raw: object) -> list[dict]:
    """Normalize the unpacked GameParams root to the entity list.

    `wowsunpack game-params --full` emits a dict keyed by internal name
    (shape 4 in extract_ship_slice); the array / "ships"-wrapper shapes
    are handled defensively so an alternate unpacker still works.
    """
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        if isinstance(raw.get("ships"), list):
            items = raw["ships"]
        else:
            items = list(raw.values())
    else:
        raise SystemExit(f"GameParams root is {type(raw).__name__}, expected dict/list")
    return [e for e in items if isinstance(e, dict)]


def collect_ship_slices(data: object) -> dict[int, dict]:
    """ship id → the armed ship entity (A_Artillery preferred), mirroring
    extract_ship_slice's candidate pick."""
    armed_by_id: dict[int, list[dict]] = {}
    for entity in _entities(data):
        typeinfo = entity.get("typeinfo") or {}
        if not isinstance(typeinfo, dict) or typeinfo.get("type") != "Ship":
            continue
        if not _has_weapon_block(entity):
            continue
        ship_id = _as_int(entity.get("id")) or _as_int(entity.get("ShipId"))
        if ship_id is None:
            continue
        armed_by_id.setdefault(ship_id, []).append(entity)

    slices: dict[int, dict] = {}
    for ship_id, candidates in armed_by_id.items():
        pick = next((c for c in candidates if "A_Artillery" in c), candidates[0])
        slices[ship_id] = pick
    return slices


def _price_cost(entity: dict) -> int | None:
    cost = _as_int(entity.get("cost"))
    return cost if cost is not None and cost > 0 else None


def collect_upgrade_prices(data: object) -> dict[str, dict]:
    """The double-keyed modernization price map, same walk as
    upgrade_prices_from_install: entities named `PC*` or grouped
    "Modernization" with a positive integer `cost`, stored under both the
    index (PCM027) and the full entity name."""
    out: dict[str, dict] = {}
    iterable = data.items() if isinstance(data, dict) else []
    for key, value in iterable:
        if not isinstance(value, dict):
            continue
        group = value.get("group")
        if not key.startswith("PC") and group != "Modernization":
            continue
        cost = _price_cost(value)
        if cost is None:
            continue
        index = value.get("index")
        if not isinstance(index, str) or not index:
            index = key.split("_")[0]
        record: dict = {"name": key, "cost": cost}
        if isinstance(group, str):
            record["group"] = group
        out[index] = record
        out[key] = record
    return out


def _ship_file(out_dir: Path, ship_id: int) -> Path:
    return out_dir / f"{ship_id}.json"


def _write_json(path: Path, value: object, pretty: bool) -> None:
    if pretty:
        text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    else:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    # newline="\n": Rust's fs::write never emits CRLF — keep the pack
    # byte-identical across host OSes.
    path.write_text(text, encoding="utf-8", newline="\n")


def ensure_source_json(game: str | None) -> Path:
    """Locate (or generate via wowsunpack) the unpacked GameParams.json."""
    if GAMEPARAMS_JSON.is_file():
        return GAMEPARAMS_JSON
    if not game:
        raise SystemExit(
            f"GameParams.json not found at {GAMEPARAMS_JSON} and no game install "
            "detected. Open the desktop app once (it caches the unpacked JSON) "
            "or pass --game <WoWS install root> so wowsunpack can generate it."
        )
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[extract-gameparams] generating {GAMEPARAMS_JSON} (one-time, ~350 MB) ...")
    if run_game_params(GAMEPARAMS_JSON, game) != 0:
        raise SystemExit("wowsunpack game-params failed; cannot build the offline pack.")
    return GAMEPARAMS_JSON


def resolve_build(explicit: int | None, game: str | None) -> int | None:
    if explicit is not None:
        return explicit
    if game and (build := latest_bin_with_idx(game)) is not None:
        return int(build.name)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", type=Path, default=GAMEPARAMS_JSON,
                        help="unpacked GameParams.json (default: orchestrator cache)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    parser.add_argument("--game", help="game install root for build detection")
    parser.add_argument("--build", type=int, help="explicit source build number")
    parser.add_argument("--pretty", action="store_true", help="pretty-print the JSON")
    parser.add_argument("--force", action="store_true",
                        help="re-extract ships even when already written")
    args = parser.parse_args()

    game = args.game or find_game_path()
    out_dir: Path = args.out

    # Freshness gate: an up-to-date pack is a no-op (the android just recipes
    # call this every build). Anything stale/missing/partial extracts below —
    # the per-ship skip keeps a partial run resumable.
    def pack_complete() -> bool:
        ships = list(out_dir.glob("*.json"))
        return bool(ships) and (out_dir / "upgrade-prices.json").is_file()

    build = resolve_build(args.build, game)
    build_file = out_dir / "build.txt"
    if not args.force and pack_complete():
        if build is None:
            # No install to compare against — keep the existing pack rather
            # than aborting (a pack of unknown freshness beats no pack).
            total = sum(p.stat().st_size for p in out_dir.glob("*.json"))
            print(
                f"[extract-gameparams] pack present, source build undetectable "
                f"(build.txt={build_file.read_text(encoding='utf-8').strip() or '?'}) "
                f"— skipping. Pass --build/--game to force a freshness check."
            )
            return 0
        if build_file.is_file() and build_file.read_text(encoding="utf-8").strip() == str(build):
            total = sum(p.stat().st_size for p in out_dir.glob("*.json"))
            print(
                f"[extract-gameparams] pack up to date (build {build}, "
                f"{len(list(out_dir.glob('*.json')))} ship files, "
                f"{total / 1024 / 1024:.1f} MB) — skipping."
            )
            return 0

    source = args.input if args.input.is_file() else ensure_source_json(game)
    if build is None:
        raise SystemExit(
            "Cannot determine the source game build (no --build, no install with "
            "bin/<build>/idx). An android pack without a build marker would serve "
            "stale data — aborting."
        )
    if build_file.is_file() and build_file.read_text(encoding="utf-8").strip() != str(build):
        print(f"[extract-gameparams] build changed → re-extracting whole pack.")
        args.force = True

    print(f"[extract-gameparams] loading {source} ...")
    data = json.loads(source.read_text(encoding="utf-8"))

    out_dir.mkdir(parents=True, exist_ok=True)
    slices = collect_ship_slices(data)
    if not slices:
        raise SystemExit("No armed Ship entities found — wrong GameParams shape?")

    written = skipped = 0
    for ship_id in sorted(slices):
        target = _ship_file(out_dir, ship_id)
        if target.is_file() and target.stat().st_size > 0 and not args.force:
            skipped += 1
            continue
        _write_json(target, slices[ship_id], args.pretty)
        written += 1

    prices = collect_upgrade_prices(data)
    _write_json(out_dir / "upgrade-prices.json", prices, args.pretty)
    _write_json(build_file, build, pretty=False)

    raw_total = sum(p.stat().st_size for p in out_dir.glob("*.json"))
    print(
        f"[extract-gameparams] build {build}: {len(slices)} ships "
        f"({written} written, {skipped} skipped), {len(prices)} price keys, "
        f"{raw_total / 1024 / 1024:.1f} MB raw → {out_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
