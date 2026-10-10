"""Unified game-asset extraction orchestrator (`just extract`).

Runs every extraction module in dependency order, sharing the slow one-time
wowsunpack outputs (GameParams.json, wowsinfo.json, metadata.json) cached under
AppData/Temp/WoWSP-extract. Each module is idempotent and only the modules
named in --module run (default: all).

Modules:
  assets    nation flags (crest + small), crew skill icons, modernization icons
  rarity    ship_id → rarity map (GameParams RarityCategory, via wowsinfo bridge)
  techtree  tech-tree topology (nextShips) + archetype
  models    shipId → base model name map (skin→base dedup for the 3D viewer)
  dogtags   dog-tag id→index/species map + 80x80 part PNGs (player avatars)
  images    ship portrait PNGs from WG CDN (slow; skip with --module to avoid)

Usage:
  just extract                       # auto-detect game, run all modules
  just extract all --path D:\\WoWS   # explicit game path
  just extract rarity,techtree       # only these modules (skip the slow ones)
  python scripts/extract/run.py --module assets --path "D:\\Steam\\...\\World of Warships"

The techtree module also builds the Lesta tree from a Lesta client (Мир
кораблей) install — point one out with --lesta-path / WOWSP_GAME_PATH_LESTA
(or have one registered in the registry), or feed a pre-decoded Lesta
GameParams.json via --lesta-gameparams (pullable without the client through
OpenKorabli/lgc-download + `wowsunpack game-params`); without either the
Lesta tree is skipped rather than faked from the WG client's dump.
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
    find_lesta_game_path,
    find_wowsunpack,
    run_game_params,
    run_metadata,
)

ALL_MODULES = ["assets", "rarity", "techtree", "images", "models", "dogtags"]

# Repo root (scripts/extract/ → repo root).
REPO = HERE.parent.parent
RES_DATA = REPO / "packages" / "webui" / "src" / "res" / "data"
SRC_DATA = REPO / "packages" / "webui" / "src" / "data"
RES_IMG = REPO / "packages" / "webui" / "src" / "res" / "images"

# Shared intermediate artifacts cached across runs.
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"
GAMEPARAMS_JSON = CACHE_DIR / "GameParams.json"
# The Lesta client's own GameParams — a separate dump from a separate game.
# Never reuse GAMEPARAMS_JSON for it: that file comes from the WG client, and
# WG's research graph is not Lesta's (the lines Lesta added — IJN CV line II,
# US BB line IV — exist only in its own client files).
GAMEPARAMS_LESTA_JSON = CACHE_DIR / "GameParams_lesta.json"
WOWSINFO_JSON = CACHE_DIR / "wowsinfo.json"
METADATA_JSON = CACHE_DIR / "wows_meta.json"
RARITY_JSON = SRC_DATA / "ship_rarity.json"
TECHTREE_JSON = SRC_DATA / "tech_tree.json"
TECHTREE_LESTA_JSON = SRC_DATA / "tech_tree_lesta.json"
SHIPMODELS_JSON = SRC_DATA / "ship_models.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("module_pos", nargs="?", help="modules (positional alt to --module)")
    ap.add_argument("--module", default="all", help="comma list of modules or 'all'")
    ap.add_argument("--path", default=None, help="game install path (default: auto-detect)")
    ap.add_argument(
        "--lesta-path",
        default=None,
        help="Lesta client (Мир кораблей) install path for the Lesta tech tree "
        "(default: WOWSP_GAME_PATH_LESTA, then a registry scan for a Lesta install)",
    )
    ap.add_argument(
        "--lesta-gameparams",
        default=None,
        help="pre-decoded Lesta GameParams.json for the Lesta tech tree — skips "
        "the client step entirely (e.g. pulled remotely with OpenKorabli/"
        "lgc-download and decoded with wowsunpack game-params); "
        "WOWSP_LESTA_GAMEPARAMS env works too",
    )
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
    needs_gp = bool(set(modules) & {"rarity", "techtree", "models", "dogtags"})
    needs_meta = bool(set(modules) & {"assets", "dogtags"})
    needs_bridge = bool(set(modules) & {"rarity", "techtree", "models"})

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
        _run_techtree_lesta(args.lesta_path, args.lesta_gameparams, args.refresh)
    if "models" in modules:
        _run_shipmodels()
    if "dogtags" in modules:
        _run_dogtags(game)
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


def _run_techtree_lesta(
    explicit_lesta_path: str | None,
    explicit_gameparams: str | None,
    refresh: bool,
) -> None:
    """Lesta tree: the Lesta client's own research graph (no wowsinfo bridge).

    Requires an actual Lesta (Мир кораблей) install — its GameParams is the
    only source of the research lines Lesta diverged from WG with — or a
    pre-decoded Lesta GameParams.json via --lesta-gameparams. Without either,
    the bundled tech_tree_lesta.json is left untouched: generating it from
    the WG client's dump would silently re-emit the WG tree under the Lesta
    name, which is exactly the defect this separate path exists to prevent.
    """
    lesta_gp = explicit_gameparams or os.environ.get("WOWSP_LESTA_GAMEPARAMS")
    if lesta_gp:
        if not Path(lesta_gp).is_file():
            _die(f"Lesta GameParams not found: {lesta_gp}")
        print(f"[extract] lesta gameparams: {lesta_gp}")
        _py(*_lesta_tree_cmd(lesta_gp))
        _run_lesta_overlay(lesta_gp)
        return
    lesta = find_lesta_game_path(explicit_lesta_path)
    if not lesta:
        print(
            "[techtree] WARNING: no Lesta (Мир кораблей) client found — skipping the "
            "Lesta tech tree. The bundled tech_tree_lesta.json is left as-is; pass "
            "--lesta-path / --lesta-gameparams or set WOWSP_GAME_PATH_LESTA to "
            "regenerate it.",
            flush=True,
        )
        return
    print(f"[extract] lesta game: {lesta}")
    if not GAMEPARAMS_LESTA_JSON.exists() or refresh:
        print("[extract] generating Lesta GameParams_lesta.json (one-time, ~350 MB) ...")
        rc = run_game_params(GAMEPARAMS_LESTA_JSON, lesta)
        if rc != 0:
            _die(f"wowsunpack game-params failed for the Lesta client (rc={rc}).")
    _py(*_lesta_tree_cmd(GAMEPARAMS_LESTA_JSON))
    _run_lesta_overlay(GAMEPARAMS_LESTA_JSON, lesta)


def _run_lesta_overlay(gameparams: Path, lesta_game: str | None = None) -> None:
    """The encyclopedia overlay + offline-names merge for Lesta-only ships.

    Needs the client's ru gettext catalog next to the dump (a full install
    provides bin/<build>/res/texts/ru/LC_MESSAGES/global.mo); without one the
    bundled ships_lesta.json / ship_names.json stay untouched. Portraits and
    the plaque silhouettes are one-shot asset pulls off the same install —
    see lesta_extract.py's docstring (gui/ship_previews → images/ships,
    gui/ships_silhouettes → trace_silhouettes.py --merge-indexes).
    """
    mo = None
    version_stamp = "lesta"
    if lesta_game:
        bin_dir = Path(lesta_game, "bin")
        builds = sorted(
            (p for p in bin_dir.iterdir() if p.is_dir() and p.name.isdigit()),
            key=lambda p: int(p.name),
            reverse=True,
        ) if bin_dir.is_dir() else []
        for build in builds:
            cand = build / "res" / "texts" / "ru" / "LC_MESSAGES" / "global.mo"
            if cand.is_file():
                mo = cand
                version_stamp = f"lesta-{build.name}"
                break
    if mo is None:
        print(
            "[techtree] WARNING: no Lesta ru catalog found — skipping the "
            "ships_lesta.json overlay build (names fall back to the "
            "GameParams working names).",
            flush=True,
        )
        return
    _py(
        "build_lesta_overlay.py",
        "--gameparams", str(gameparams),
        "--mo", str(mo),
        "--mo-lang", "ru-RU",
        "--curated", str(HERE / "lesta_names_curated.json"),
        "--curated-descr", str(HERE / "lesta_descriptions_curated.json"),
        "--lesta-tree", str(TECHTREE_LESTA_JSON),
        "--wg-tree", str(TECHTREE_JSON),
        "--version", version_stamp,
        "--out", str(SRC_DATA / "ships_lesta.json"),
        "--merge-names", str(SRC_DATA / "ship_names.json"),
    )


def _lesta_tree_cmd(gameparams: Path) -> list[str]:
    """build_techtree.py invocation for the Lesta tree.

    The Lesta dump carries no archetype field — borrow the codes for the
    shared ships from the WG client's dump (generated earlier by the same
    run whenever it exists) so branch labels survive on the Lesta tree.
    """
    cmd = [
        "build_techtree.py",
        "--source", "gameparams",
        "--gameparams", str(gameparams),
        "--rarity", str(RARITY_JSON),
        "--out", str(TECHTREE_LESTA_JSON),
    ]
    if GAMEPARAMS_JSON.exists():
        cmd[1:1] = ["--archetypes", str(GAMEPARAMS_JSON)]
    return cmd


def _run_shipmodels() -> None:
    """shipId → base model name map (skin→base dedup for the 3D viewer)."""
    cmd = [
        "build_ship_models.py",
        "--gameparams", str(GAMEPARAMS_JSON),
        "--bridge", str(WOWSINFO_JSON),
        "--out", str(SHIPMODELS_JSON),
    ]
    # The Lesta-only ships ride along (name/silhouette resolution needs their
    # entries even before their GLBs exist — see bake_lesta_ships.py).
    if GAMEPARAMS_LESTA_JSON.exists():
        cmd[1:1] = ["--extra-gameparams", str(GAMEPARAMS_LESTA_JSON)]
    _py(*cmd)


def _run_dogtags(game: str) -> None:
    """Dog-tag id→index/species map + 80x80 part PNGs (player avatars)."""
    _py(
        "build_dogtags.py",
        "--gameparams", str(GAMEPARAMS_JSON),
        "--meta", str(METADATA_JSON),
        "--game", game,
        "--out-map", str(SRC_DATA / "dogtags_map.json"),
        "--res-dir", str(REPO / "packages" / "webui" / "src" / "res" / "dogtags"),
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
