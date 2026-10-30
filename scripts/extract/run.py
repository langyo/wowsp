"""Unified game-asset extraction orchestrator (`just extract`).

Runs every extraction module in dependency order, sharing the slow one-time
game-assets outputs (GameParams.json, wowsinfo.json, metadata.json) cached under
AppData/Temp/WoWSP-extract. Each module is idempotent and only the modules
named in --module run (default: all).

Modules:
  assets    nation flags (crest + small), crew skill icons, modernization icons
  rarity    ship_id → rarity map (GameParams RarityCategory, via wowsinfo bridge)
  techtree  tech-tree topology (nextShips) + archetype
  encyclopedia  WG bundle + Lesta snapshot sync with incremental diff reports
  models    shipId → base model name map (skin→base dedup for the 3D viewer)
            + aircraft performance rows (plane_specs.json)
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
OpenKorabli/lgc-download + `game-assets game-params`); without either the
Lesta tree is skipped rather than faked from the WG client's dump. The same
Lesta client snapshot feeds the app-carried ship data: the armor/ballistics
slices bundled into the Rust tree (build_lesta_shipdata.py — read by
commands/gameparams.rs so Lesta-only ids never touch an install), the
Lesta airplanes merged into the plane tables and their performance rows
baked into plane_specs.json (model_convert's extract_lesta_planes.py +
extract_plane_specs.py; their GLBs bake via bake_lesta_planes.py).

The same two GameParams dumps also bake the app's SERVER-DELIVERED ship-data
bundle: build_shipdata_bundle.py writes both realms' slices as a zip
(manifest + one JSON per ship) that publish_data_pack.py ships on the
data-latest hot-update channel — `just publish-shipdata` bakes and
publishes it, so the fleet's armor/ballistics/sonar data reaches install-less
machines without an app release.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Make sibling modules importable when run as a script.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _common import (  # noqa: E402
    find_game_path,
    find_lesta_game_path,
    find_game_assets,
    run_game_params,
    run_metadata,
)
import sync_encyclopedia  # noqa: E402

ALL_MODULES = ["assets", "rarity", "techtree", "encyclopedia", "images", "models", "dogtags"]

# Repo root (scripts/extract/ → repo root).
REPO = HERE.parent.parent
RES_DATA = REPO / "packages" / "webui" / "src" / "res" / "data"
SRC_DATA = REPO / "packages" / "webui" / "src" / "data"
RES_IMG = REPO / "packages" / "webui" / "src" / "res" / "images"

# Shared intermediate artifacts cached across runs.
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"
GAMEPARAMS_JSON = CACHE_DIR / "GameParams.json"
# Build-stamp sidecar for the WG dump above — one line, the bin/<build>
# digits the dump was cut from (the WG client's bin dirs are numeric build
# ids too). Same freshness contract as the Lesta sidecar below: a dump is
# only valid for the client it was cut from.
GAMEPARAMS_BUILD = CACHE_DIR / "GameParams.json.build"
# The Lesta client's own GameParams — a separate dump from a separate game.
# Never reuse GAMEPARAMS_JSON for it: that file comes from the WG client, and
# WG's research graph is not Lesta's (the lines Lesta added — IJN CV line II,
# US BB line IV — exist only in its own client files).
GAMEPARAMS_LESTA_JSON = CACHE_DIR / "GameParams_lesta.json"
# Build-stamp sidecar for the dump cache above: one line, the bin/<build>
# digits the dump was cut from. A dump is only valid for the client it was
# cut from, so the regeneration check is keyed to it (see
# _ensure_lesta_gameparams) instead of the file's mere existence.
GAMEPARAMS_LESTA_BUILD = CACHE_DIR / "GameParams_lesta.json.build"
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
        "lgc-download and decoded with game-assets game-params); "
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

    if not find_game_assets():
        _die("game-assets not found — run `cargo install game-assets` or set WOWSP_GAME_ASSETS.")

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
    if "encyclopedia" in modules:
        _run_encyclopedia(game)
    if "models" in modules:
        _run_plane_specs()
        _run_shipmodels()
    if "dogtags" in modules:
        _run_dogtags(game)
    if "images" in modules:
        _run_images()

    print("[extract] done.")


def _wg_dump_stamp_backfill() -> str | None:
    """The WG dump build the committed roster vouches for, when it carries a
    dual stamp ("wg-<build>+lesta-<build>"): the roster is baked right after
    the dump is pinned, so its wg part is sound backfill evidence that the
    un-sidecar'd dump matches that build (mirrors the Lesta backfill)."""
    roster = _load_json(SRC_DATA / "ships_wg_only.json") or {}
    m = re.fullmatch(r"wg-(\d+)(?:\+lesta-\d+)?", str(roster.get("gameVersion") or ""))
    return m.group(1) if m else None


def _ensure_gameparams(game: str, refresh: bool) -> None:
    """GameParams.json, keyed to the client build it was cut from.

    Same freshness contract as _ensure_lesta_gameparams: the dump
    regenerates when its .build sidecar is missing or no longer matches the
    detected client build (a client update changes every number in the
    dump). A dump vouched for by the committed roster's dual stamp backfills
    the sidecar instead of re-cutting. --refresh still forces it."""
    build = sync_encyclopedia.wg_client_build(game)
    recorded = None
    if GAMEPARAMS_BUILD.exists():
        recorded = GAMEPARAMS_BUILD.read_text(encoding="ascii", errors="ignore").strip() or None
    if GAMEPARAMS_JSON.exists() and not refresh:
        if build is None:
            print(f"[extract] GameParams.json cached ({GAMEPARAMS_JSON.stat().st_size >> 20} MB; "
                  "client build undetectable)")
            return
        if recorded == build:
            print(f"[extract] GameParams.json cached ({GAMEPARAMS_JSON.stat().st_size >> 20} MB, "
                  f"build {build})")
            return
        if recorded is None:
            vouched = _wg_dump_stamp_backfill()
            if vouched == build:
                GAMEPARAMS_BUILD.write_text(build + "\n", encoding="ascii")
                print(f"[extract] WG dump: roster stamp vouches for build "
                      f"{build} — sidecar backfilled")
                return
            print("[extract] WG dump cache has no recorded build — "
                  "regenerating to pin one ...")
        else:
            print(f"[extract] WG client build {build} != dump build "
                  f"{recorded} — regenerating ...")
    else:
        print("[extract] generating GameParams.json (one-time, ~350 MB) ...")
    rc = run_game_params(GAMEPARAMS_JSON, game)
    if rc != 0:
        _die(f"game-assets game-params failed (rc={rc}).")
    if build is not None:
        GAMEPARAMS_BUILD.write_text(build + "\n", encoding="ascii")


def _ensure_metadata(game: str, refresh: bool) -> None:
    if METADATA_JSON.exists() and not refresh:
        print(f"[extract] metadata cached ({METADATA_JSON.stat().st_size >> 20} MB)")
        return
    print("[extract] generating wows metadata (one-time) ...")
    rc = run_metadata(METADATA_JSON, game)
    if rc != 0:
        _die(f"game-assets metadata failed (rc={rc}).")


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
        stamp = _run_lesta_overlay(lesta_gp)
        _run_wg_only_roster(Path(lesta_gp))
        _run_lesta_shipdata(Path(lesta_gp), stamp)
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
    _ensure_lesta_gameparams(lesta, refresh)
    _py(*_lesta_tree_cmd(GAMEPARAMS_LESTA_JSON))
    stamp = _run_lesta_overlay(GAMEPARAMS_LESTA_JSON, lesta)
    _run_wg_only_roster(GAMEPARAMS_LESTA_JSON)
    _run_lesta_shipdata(GAMEPARAMS_LESTA_JSON, stamp)


def _run_wg_only_roster(lesta_gameparams: Path, wg_version: str | None = None) -> None:
    """The WG-only roster artifact (ships_wg_only.json): every WG client
    ship whose index the Lesta client has never carried. The encyclopedia
    list in Lesta mode hides these ids — the tree-derived
    WG_EXCLUSIVE_TREE_SHIP_IDS covers researchable hulls only, while this
    set-difference of the two full dumps also classifies the WG-only
    premiums, collabs and event hulls no tree records. Needs the WG dump
    (a shared cache built earlier in the same run); without it the step
    skips and the bundled artifact stays untouched.

    wg_version stamps the artifact's gameVersion: the techtree flow passes
    nothing (plain "wg"), while the encyclopedia flow forwards the dual
    stamp "wg-<wgdumpbuild>+lesta-<lestabuild>" — the roster is a
    set-difference of the two client dumps, so the stamp records exactly
    the dump pair it was derived from."""
    if not GAMEPARAMS_JSON.exists():
        print(
            "[techtree] WARNING: no WG GameParams — skipping the "
            "ships_wg_only.json roster build (the webui falls back to the "
            "tree-derived WG-exclusive set).",
            flush=True,
        )
        return
    _py(
        "build_wg_only_roster.py",
        "--gameparams", str(GAMEPARAMS_JSON),
        "--lesta-gameparams", str(lesta_gameparams),
        "--version", wg_version or "wg",
        "--out", str(SRC_DATA / "ships_wg_only.json"),
    )


def _run_lesta_shipdata(gameparams: Path, version_stamp: str | None) -> None:
    """The app-carried Lesta ship data: GameParams slices + the plane tables.

    `build_lesta_shipdata.py` cuts the Lesta-only ships' armor/ballistics
    slices out of the dump into the Rust tree (include_str!'d by
    commands/gameparams.rs), so those ids resolve without any game install;
    `extract_lesta_planes.py` merges the carriers' airframes into
    plane_types.json / plane_models.json (labels, roles, geometry paths) and
    `extract_plane_specs.py` bakes their performance rows into
    plane_specs.json (the WG-authored rows there are left as the WG dump
    produced them).
    All three are cut from the same client snapshot as the tree and the overlay.
    The carriers' plane GLBs are baked separately (bake_lesta_planes.py —
    needs the Oodle decoder)."""
    cmd = ["build_lesta_shipdata.py", "--gameparams", str(gameparams)]
    if version_stamp:
        cmd += ["--version", version_stamp]
    _py(*cmd)
    _py_model_convert("extract_lesta_planes.py", "--input", str(gameparams))
    # Performance rows for the airframes the merge above just added — the
    # dump's own realm, so the WG-owned rows stay untouched.
    _py_model_convert("extract_plane_specs.py", "--input", str(gameparams),
                      "--source", "lesta")


def _run_lesta_overlay(gameparams: Path, lesta_game: str | None = None) -> str | None:
    """The encyclopedia overlay + offline-names merge for Lesta-only ships.

    Needs the client's ru gettext catalog next to the dump (a full install
    provides bin/<build>/res/texts/ru/LC_MESSAGES/global.mo); without one the
    bundled ships_lesta.json / ship_names.json stay untouched. Portraits and
    the plaque silhouettes are one-shot asset pulls off the same install —
    see lesta_extract.py's docstring (gui/ship_previews → images/ships,
    gui/ships_silhouettes → trace_silhouettes.py --merge-indexes).

    Returns the version stamp the overlay was written under (None when the
    overlay build was skipped) so the ship-data bundle shares it.
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
        return None
    overlay_cmd = [
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
    ]
    # The non-tree port-fleet walk needs the WG dump's whole index set as
    # its exclusion base (hundreds of WG premiums never appear as tree side
    # leaves); the WG dump is a shared cache built earlier in the same run.
    if GAMEPARAMS_JSON.exists():
        overlay_cmd[1:1] = ["--wg-gameparams", str(GAMEPARAMS_JSON)]
    _py(*overlay_cmd)
    return version_stamp


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


def _ensure_lesta_gameparams(lesta_game: str, refresh: bool) -> None:
    """GameParams_lesta.json, keyed to the client build it was cut from
    (build detection shared with sync_encyclopedia).

    A dump is only valid for the client it was cut from — a client update
    changes every number in it, so the cache must not silently serve an old
    build to a new one. The build digits live in the
    GameParams_lesta.json.build sidecar: the dump regenerates when the
    sidecar is missing or its build no longer matches the detected client
    build. An existing dump whose committed artifacts already stamp the
    detected build backfills the sidecar instead of re-cutting. --refresh
    still forces regeneration."""
    build = sync_encyclopedia.lesta_client_build(lesta_game)
    recorded = None
    if GAMEPARAMS_LESTA_BUILD.exists():
        recorded = GAMEPARAMS_LESTA_BUILD.read_text(
            encoding="ascii", errors="ignore").strip() or None
    if GAMEPARAMS_LESTA_JSON.exists() and not refresh:
        if build is None:
            # Client build undetectable (no bin/<build> with the ru
            # catalog) — keep the dump; the consumers skip on their own.
            print("[extract] GameParams_lesta.json cached (client build undetectable)")
            return
        if recorded == build:
            print(f"[extract] GameParams_lesta.json cached (build {build})")
            return
        if recorded is None:
            stamp = sync_encyclopedia.lesta_committed_build()
            if stamp == build:
                GAMEPARAMS_LESTA_BUILD.write_text(build + "\n", encoding="ascii")
                print(f"[extract] lesta dump: artifacts already stamp client "
                      f"build {build} — sidecar backfilled")
                return
            print("[extract] lesta dump cache has no recorded build — "
                  "regenerating to pin one ...")
        else:
            print(f"[extract] lesta client build {build} != dump build "
                  f"{recorded} — regenerating ...")
    else:
        print("[extract] generating Lesta GameParams_lesta.json (one-time, ~350 MB) ...")
    rc = run_game_params(GAMEPARAMS_LESTA_JSON, lesta_game)
    if rc != 0:
        _die(f"game-assets game-params failed for the Lesta client (rc={rc}).")
    if build is not None:
        GAMEPARAMS_LESTA_BUILD.write_text(build + "\n", encoding="ascii")


def _load_json(path: Path) -> dict | None:
    """Parse a repo JSON artifact, None when absent or malformed."""
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _print_artifact_diff(path: Path, before: bytes | None, after: bytes | None) -> None:
    """One compact line per re-baked artifact: the stamp delta plus
    added/removed/changed/re-id counts for the JSON maps (re-id = the same
    index re-registered under a different shipId); the gunzipped
    entry-count delta covers the .gz bundle the same way."""
    def load(blob: bytes | None) -> tuple[dict, str | None]:
        if not blob:
            return {}, None
        data = json.loads(gzip.decompress(blob) if path.suffix == ".gz" else blob)
        if isinstance(data, dict) and isinstance(data.get("ships"), dict):
            return data["ships"], data.get("gameVersion")
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if isinstance(v, dict)}, None
        return {}, None

    def by_index(map_: dict) -> dict[str, str]:
        return {
            entry.get("index"): sid
            for sid, entry in map_.items()
            if isinstance(entry, dict) and isinstance(entry.get("index"), str)
        }

    old_map, old_stamp = load(before)
    new_map, new_stamp = load(after)
    old_ids, new_ids = set(old_map), set(new_map)
    added, removed = len(new_ids - old_ids), len(old_ids - new_ids)
    changed = sum(1 for sid in old_ids & new_ids if old_map[sid] != new_map[sid])
    old_idx, new_idx = by_index(old_map), by_index(new_map)
    re_id = sum(1 for idx, sid in new_idx.items() if old_idx.get(idx) not in (None, sid))
    parts = []
    if old_stamp != new_stamp:
        parts.append(f"stamp {old_stamp or '-'} -> {new_stamp or '-'}")
    parts.append(
        f"{len(new_map) - len(old_map):+d} entries "
        f"(+{added} / -{removed} / ~{changed} / re-id {re_id})"
    )
    print(f"[encyclopedia] {path.name}: {'; '.join(parts)}")


def _run_encyclopedia(game: str) -> None:
    """The WG encyclopedia bundle + the Lesta snapshot sync, stamp-driven.

    WG: the committed ships_basics.json gameVersion vs the live API's
    game_version — equal prints up-to-date; different snapshots the old
    bundle in memory, re-fetches it through build_planner_data.py's
    --only ship-basics step (the version-stamped cache makes the pass
    incremental) and prints the structured added/removed/changed diff.
    The curated overrides (ship_basics_curated.json) ride along inside
    that step, so every re-bake re-applies them.

    Lesta: the committed ships_lesta.json stamp vs the installed client's
    build, AND the committed ships_wg_only.json dual stamp's wg part vs the
    WG client's build — the roster is a set-difference of the two dumps, so
    a WG client update moves it just like a Lesta one does (the same
    detection sync_encyclopedia.py and the overlay bake share). Both in
    step prints in-sync and writes nothing; drift re-bakes the five Lesta
    artifacts off dump caches that are first re-cut when their recorded
    build no longer matches their client, with before/after snapshots
    compactly diffed.

    No Lesta install → the same skip as the techtree module; the WG half
    runs regardless (it never touches a client)."""
    committed = _load_json(sync_encyclopedia.WG_BUNDLE)
    committed_version = (committed or {}).get("gameVersion")
    try:
        live_version = sync_encyclopedia.wg_live_version()
    except RuntimeError as exc:
        print(f"[encyclopedia] WARNING: {exc} — skipping the WG bundle sync "
              "(the bundled one stays as-is)", flush=True)
    else:
        if live_version is None:
            print("[encyclopedia] WARNING: WG API returned no game_version — "
                  "skipping the WG bundle sync", flush=True)
        elif committed_version == live_version:
            ships = (committed or {}).get("ships") or {}
            print(f"[encyclopedia] WG bundle up to date "
                  f"({live_version}, {len(ships)} ships)")
        else:
            print(f"[encyclopedia] WG bundle {committed_version or '(none)'} -> "
                  f"{live_version} — refreshing ...")
            old_ships = (committed or {}).get("ships") or {}
            _py("build_planner_data.py", "--only", "ship-basics", "--no-icons")
            refreshed = _load_json(sync_encyclopedia.WG_BUNDLE) or {}
            print(sync_encyclopedia.format_ship_diff(
                f"ships_basics.json {committed_version or '(none)'} -> {live_version}",
                old_ships, refreshed.get("ships") or {}))

    lesta = find_lesta_game_path(None)
    if not lesta:
        print(
            "[encyclopedia] WARNING: no Lesta (Мир кораблей) client found — skipping "
            "the Lesta snapshot sync (the bundled artifacts are left as-is); pass "
            "--lesta-path or set WOWSP_GAME_PATH_LESTA to check one.",
            flush=True,
        )
        return
    committed_build = sync_encyclopedia.lesta_committed_build()
    build = sync_encyclopedia.lesta_client_build(lesta)
    if build is None:
        print(
            "[encyclopedia] WARNING: no Lesta ru catalog found under bin/ — skipping "
            "the Lesta snapshot sync.",
            flush=True,
        )
        return
    roster_stamp = str((_load_json(SRC_DATA / "ships_wg_only.json") or {}).get("gameVersion") or "")
    m = re.fullmatch(r"wg-(\d+)\+lesta-(\d+)", roster_stamp)
    roster_wg_build = m.group(1) if m else None
    wg_build = sync_encyclopedia.wg_client_build(game)
    lesta_drift = committed_build != build
    wg_drift = wg_build is not None and roster_wg_build != wg_build
    if not lesta_drift and not wg_drift:
        overlay = _load_json(SRC_DATA / "ships_lesta.json") or {}
        tree = _load_json(TECHTREE_LESTA_JSON) or {}
        print(f"[encyclopedia] Lesta snapshot in sync (build {build}"
              + (f", WG dump build {wg_build}" if wg_build else "")
              + f": {len(overlay.get('ships') or {})} overlay entries, "
              f"{len(tree)} tree nodes)")
        return
    reasons = []
    if lesta_drift:
        reasons.append(f"Lesta client build {build} != snapshot stamp "
                       f"{committed_build or '(none)'}")
    if wg_drift:
        reasons.append(f"WG client build {wg_build} != roster stamp "
                       f"{roster_wg_build or '(none)'}")
    print("[encyclopedia] " + "; ".join(reasons) +
          " — re-baking the Lesta artifacts ...")
    artifacts = [
        SRC_DATA / "ships_lesta.json",
        SRC_DATA / "ships_wg_only.json",
        TECHTREE_LESTA_JSON,
        SRC_DATA / "ship_names.json",
        REPO / "packages" / "app" / "tauri" / "data" / "lesta_ship_gameparams.json.gz",
    ]
    before = {p: p.read_bytes() if p.exists() else None for p in artifacts}
    _ensure_gameparams(game, refresh=False)
    _ensure_lesta_gameparams(lesta, refresh=False)
    _py(*_lesta_tree_cmd(GAMEPARAMS_LESTA_JSON))
    stamp = _run_lesta_overlay(GAMEPARAMS_LESTA_JSON, lesta)
    _run_wg_only_roster(
        GAMEPARAMS_LESTA_JSON,
        wg_version=f"wg-{wg_build}+lesta-{build}",
    )
    _run_lesta_shipdata(GAMEPARAMS_LESTA_JSON, stamp)
    after = {p: p.read_bytes() if p.exists() else None for p in artifacts}
    for artifact in artifacts:
        _print_artifact_diff(artifact, before[artifact], after[artifact])


def _run_plane_specs() -> None:
    """Aircraft performance rows (plane_specs.json) from the WG GameParams.

    Feeds the ship-detail Specifications tab when the 3D stage's model
    dropdown is switched to a carrier aircraft. Only the WG-authored rows are
    refreshed here; the Lesta-only airframes are owned by the Lesta dump and
    updated inside _run_lesta_shipdata (the merge in the script preserves the
    other realm's rows — see model_convert/extract_plane_specs.py for why the
    two dumps must not overwrite each other)."""
    _py_model_convert("extract_plane_specs.py", "--input", str(GAMEPARAMS_JSON))


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
    """Dog-tag id→index/species map + 80x80 part WebPs (player avatars)."""
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


def _py_model_convert(script: str, *args: str) -> None:
    """Run a sibling model_convert script (plane tables / bakes live there)."""
    cmd = [sys.executable, str(HERE.parent / "model_convert" / script), *args]
    print(f"\n[extract] $ {' '.join(cmd)}")
    rc = subprocess.call(cmd)
    if rc != 0:
        _die(f"model_convert/{script} failed (rc={rc}).")


def _die(msg: str) -> None:
    print(f"[extract] ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
