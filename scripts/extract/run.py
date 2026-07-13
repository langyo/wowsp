"""Unified game-asset extraction orchestrator (`just extract`).

Runs every extraction module in dependency order, sharing the slow one-time
wowsunpack outputs (GameParams.json, wowsinfo.json, metadata.json) cached under
AppData/Temp/WoWSP-extract. Each module is idempotent and only the modules
named in --module run (default: all).

Modules:
  assets    nation flags (crest + small), crew skill icons, modernization icons
  rarity    ship_id → rarity map (GameParams RarityCategory, via wowsinfo bridge)
  techtree  tech-tree topology (nextShips) + archetype
  images    ship portrait PNGs from WG CDN (slow; skip with --module to avoid)

Usage:
  just extract                       # auto-detect game, run all modules
  just extract all --path D:\\WoWS   # explicit game path
  just extract rarity,techtree       # only these modules (skip the slow ones)
  python scripts/extract/run.py --module assets --path "D:\\Steam\\...\\World of Warships"
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# Make sibling modules importable when run as a script.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _common import (  # noqa: E402
    find_game_path,
    find_wowsunpack,
    run_game_params,
    run_metadata,
)

ALL_MODULES = ["assets", "rarity", "techtree", "images"]

# Repo root (scripts/extract/ → repo root).
REPO = HERE.parent.parent
RES_DATA = REPO / "packages" / "webui" / "src" / "res" / "data"
RES_IMG = REPO / "packages" / "webui" / "src" / "res" / "images"

# Shared intermediate artifacts cached across runs.
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"
GAMEPARAMS_JSON = CACHE_DIR / "GameParams.json"
WOWSINFO_JSON = CACHE_DIR / "wowsinfo.json"
METADATA_JSON = CACHE_DIR / "wows_meta.json"
RARITY_JSON = RES_DATA / "ship_rarity.json"
TECHTREE_JSON = RES_DATA / "tech_tree.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("module_pos", nargs="?", help="modules (positional alt to --module)")
    ap.add_argument("--module", default="all", help="comma list of modules or 'all'")
    ap.add_argument("--path", default=None, help="game install path (default: auto-detect)")
    ap.add_argument(
        "--bridge",
        default="https://raw.githubusercontent.com/wowsinfo/data/master/live/app/data/wowsinfo.json",
        help="URL or local path to wowsinfo.json (ship_id↔index bridge)",
    )
    ap.add_argument("--refresh", action="store_true", help="re-fetch shared caches even if present")
    args = ap.parse_args()
    # Allow `just extract rarity,techtree` (positional) as a shorthand for --module.
    if args.module_pos and args.module == "all":
        args.module = args.module_pos

    modules = ALL_MODULES if args.module == "all" else [m.strip() for m in args.module.split(",")]
    unknown = [m for m in modules if m not in ALL_MODULES]
    if unknown:
        ap.error(f"unknown module(s): {unknown}. valid: {ALL_MODULES}")

    if not find_wowsunpack():
        _die("wowsunpack not found — run `cargo install wowsunpack` or set WOWSP_WOWSUNPACK.")

    game = find_game_path(args.path)
    if not game:
        _die("WoWS install not found — pass --path or set WOWSP_GAME_PATH.")
    print(f"[extract] game: {game}")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # ── shared caches (built on demand) ──────────────────────────────────
    needs_gp = bool(set(modules) & {"rarity", "techtree"})
    needs_meta = "assets" in modules
    needs_bridge = bool(set(modules) & {"rarity", "techtree"})

    if needs_gp:
        _ensure_gameparams(game, args.refresh)
    if needs_meta:
        _ensure_metadata(game, args.refresh)
    if needs_bridge:
        _ensure_bridge(args.bridge, args.refresh)

    # ── modules ──────────────────────────────────────────────────────────
    if "assets" in modules:
        _run_assets()
    if "rarity" in modules:
        _run_rarity()
    if "techtree" in modules:
        _run_techtree()
    if "images" in modules:
        _run_images()

    print("[extract] done.")


def _ensure_gameparams(game: str, refresh: bool) -> None:
    if GAMEPARAMS_JSON.exists() and not refresh:
        print(f"[extract] GameParams.json cached ({GAMEPARAMS_JSON.stat().st_size >> 20} MB)")
        return
    print("[extract] generating GameParams.json (one-time, ~350 MB) ...")
    rc = run_game_params(GAMEPARAMS_JSON, game)
    if rc != 0:
        _die(f"wowsunpack game-params failed (rc={rc}).")


def _ensure_metadata(game: str, refresh: bool) -> None:
    if METADATA_JSON.exists() and not refresh:
        print(f"[extract] metadata cached ({METADATA_JSON.stat().st_size >> 20} MB)")
        return
    print("[extract] generating wows metadata (one-time) ...")
    rc = run_metadata(METADATA_JSON, game)
    if rc != 0:
        _die(f"wowsunpack metadata failed (rc={rc}).")


def _ensure_bridge(bridge: str, refresh: bool) -> None:
    if WOWSINFO_JSON.exists() and not refresh:
        print(f"[extract] wowsinfo.json cached ({WOWSINFO_JSON.stat().st_size >> 20} MB)")
        return
    if bridge.startswith("http"):
        import urllib.request

        print(f"[extract] downloading wowsinfo.json from {bridge} ...")
        urllib.request.urlretrieve(bridge, WOWSINFO_JSON)
    else:
        Path(bridge).replace(WOWSINFO_JSON)
    print(f"[extract] wowsinfo.json ready ({WOWSINFO_JSON.stat().st_size >> 20} MB)")


def _run_assets() -> None:
    """Nation crests (big) + small flags + skill + modernization icons."""
    meta = str(METADATA_JSON)
    pkg = _first_pkg_with_prefix("/gui/")
    if pkg is None:
        _die("gui_*.pkg not found in res_packages.")
    # Big faction crests (tech-tree header) — already extracted historically,
    # but re-run to keep them current.
    _py(
        "extract_game_assets.py",
        "--pkg", pkg, "--meta", meta,
        "--prefix", "/gui/nation_flag_tree/",
        "--out", str(RES_IMG / "nations"),
        "--webp", "--as-nation-flags",
    )
    # Small list-view flags.
    _py(
        "extract_game_assets.py",
        "--pkg", pkg, "--meta", meta,
        "--prefix", "/gui/nation_flags/small/",
        "--out", str(RES_IMG / "nations_small"),
        "--webp", "--as-nation-flags",
    )
    # Crew skill icons.
    _py(
        "extract_game_assets.py",
        "--pkg", pkg, "--meta", meta,
        "--prefix", "/gui/crew_commander/skills/",
        "--out", str(RES_IMG / "skills"),
        "--webp",
    )
    # Modernization (upgrade) icons.
    _py(
        "extract_game_assets.py",
        "--pkg", pkg, "--meta", meta,
        "--prefix", "/gui/modernization_icons/",
        "--out", str(RES_IMG / "modernization"),
        "--webp",
    )


def _run_rarity() -> None:
    _py(
        "build_rarity_map.py",
        "--gameparams", str(GAMEPARAMS_JSON),
        "--bridge", str(WOWSINFO_JSON),
        "--out", str(RARITY_JSON),
    )


def _run_techtree() -> None:
    _py(
        "build_techtree.py",
        "--bridge", str(WOWSINFO_JSON),
        "--gameparams", str(GAMEPARAMS_JSON),
        "--rarity", str(RARITY_JSON),
        "--out", str(TECHTREE_JSON),
    )


def _run_images() -> None:
    _py("download_ship_images.py")


def _first_pkg_with_prefix(_gui_prefix: str) -> str | None:
    game = find_game_path()
    if not game:
        return None
    pkg = Path(game, "res_packages", "gui_0001.pkg")
    return str(pkg) if pkg.exists() else None


def _py(script: str, *args: str) -> None:
    """Run a sibling extract script, forwarding args."""
    cmd = [sys.executable, str(HERE / script), *args]
    print(f"\n[extract] $ {' '.join(cmd)}")
    rc = subprocess.call(cmd)
    if rc != 0:
        _die(f"{script} failed (rc={rc}).")


def _die(msg: str) -> None:
    print(f"[extract] ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
