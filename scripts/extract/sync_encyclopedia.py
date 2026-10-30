#!/usr/bin/env python3
"""Encyclopedia sync status + diff driver (check-only; writes nothing).

Reports whether the two bundled encyclopedia realms are in step with their
live sources:

  WG     the offline fallback bundle packages/webui/src/res/data/ships_basics.json
         (stamp = gameVersion) vs the live WG encyclopedia API's game_version
         (the same asia-realm info endpoint build_planner_data.py's
         ship-basics step versions its cache with).
  Lesta  the client snapshot overlay packages/webui/src/data/ships_lesta.json
         (stamp "lesta-<build>") vs the installed Lesta (Мир кораблей)
         client's newest bin/<build> carrying res/texts/ru/LC_MESSAGES/
         global.mo — exactly the build rule run.py's overlay bake stamps the
         artifacts with; game_info.xml's client part version is parsed for a
         human-facing display version.

Read-only by design: every fetch and every repo rewrite belongs to the
refresh flow (python scripts/extract/run.py --module encyclopedia). The only
HTTP this tool makes is the small /wows/encyclopedia/info/ version probe,
with the same bounded 4-attempt retry the ship-basics step uses; the full
ship list is never fetched here — a WG drift preview is printed only when
the version-stamped ships_basics_en_<live_version>.json cache already
exists in the WoWSP-extract cache dir.

Exit codes: 0 everything in sync · 2 drift detected somewhere · 3 a live
source unreachable (reported as "unknown" — never silently as drift).

Usage:
    python scripts/extract/sync_encyclopedia.py [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _common import find_game_path, find_lesta_game_path  # noqa: E402

REPO = HERE.parent.parent
# WG public API application_id — the same client-side public identifier as
# WG_SHIPS_URL in build_planner_data.py and WG_APP_ID in wg_realm.rs (the
# three copies must stay in sync); NOT a credential/secret.
WG_APP_ID = "447ec579e994976e39dec0e7d0bac644"
WG_INFO_URL = (
    "https://api.worldofwarships.asia/wows/encyclopedia/info/"
    f"?application_id={WG_APP_ID}&language=en"
)
WG_BUNDLE = REPO / "packages" / "webui" / "src" / "res" / "data" / "ships_basics.json"
LESTA_BUNDLE = REPO / "packages" / "webui" / "src" / "data" / "ships_lesta.json"
LESTA_TREE = REPO / "packages" / "webui" / "src" / "data" / "tech_tree_lesta.json"
WG_ROSTER = REPO / "packages" / "webui" / "src" / "data" / "ships_wg_only.json"
# The version-stamped ship-basics cache (same dir build_planner_data.py uses).
CACHE_DIR = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local/share")))
    / "WoWSP-extract"
)

# Top-level per-ship fields the drift preview calls out by name (anything
# else that differs is still reported, just after these).
DIFF_FIELDS = ("name", "tier", "type", "nation", "is_premium", "is_special",
               "description", "default_profile", "images")
# Sample caps for the human-readable diff preview.
SAMPLE_CAP = 20
WG_ATTEMPTS = 4

_STATUS_LABEL = {"up_to_date": "UP TO DATE", "drift": "DRIFT", "unknown": "UNKNOWN"}


# ── sources ──────────────────────────────────────────────────────────────────

def wg_live_version() -> str | None:
    """The live WG API game_version, or None when the response carries none.

    Raises RuntimeError once the bounded retries are exhausted — callers
    decide how to degrade; the check driver reports it as "unknown".
    """
    data = None
    for attempt in range(WG_ATTEMPTS):
        try:
            with urllib.request.urlopen(WG_INFO_URL, timeout=60) as r:
                data = json.load(r)
            break
        except Exception:
            if attempt == WG_ATTEMPTS - 1:
                raise RuntimeError(
                    f"WG API unreachable after {WG_ATTEMPTS} attempts") from None
            time.sleep(2 * (attempt + 1))
    return ((data or {}).get("data") or {}).get("game_version")


def lesta_client_build(game: str) -> str | None:
    """The build digits of the Lesta install's newest bin/<build> that ships
    res/texts/ru/LC_MESSAGES/global.mo — the same walk run.py's
    _run_lesta_overlay stamps the overlay artifacts with."""
    bin_dir = Path(game, "bin")
    builds = sorted(
        (p for p in bin_dir.iterdir() if p.is_dir() and p.name.isdigit()),
        key=lambda p: int(p.name),
        reverse=True,
    ) if bin_dir.is_dir() else []
    for build in builds:
        if (build / "res" / "texts" / "ru" / "LC_MESSAGES" / "global.mo").is_file():
            return build.name
    return None


def wg_client_build(game: str) -> str | None:
    """The WG install's newest numeric bin/<build> directory — the build the
    WG GameParams dump (and therefore the roster diff) must track."""
    bin_dir = Path(game, "bin")
    builds = sorted(
        (p for p in bin_dir.iterdir() if p.is_dir() and p.name.isdigit()),
        key=lambda p: int(p.name),
        reverse=True,
    ) if bin_dir.is_dir() else []
    return builds[0].name if builds else None


def roster_stamp_parts() -> tuple[str | None, str | None]:
    """(wg build, lesta build) recorded in the committed roster's dual stamp
    ("wg-<build>+lesta-<build>"); (None, None) for the legacy "wg" stamp —
    the encyclopedia flow re-bakes once to establish provenance."""
    m = re.fullmatch(
        r"wg-(\d+)\+lesta-(\d+)",
        str((_read_json(WG_ROSTER) or {}).get("gameVersion") or ""),
    )
    return (m.group(1), m.group(2)) if m else (None, None)


def lesta_display_version(game: str) -> str | None:
    """The client part version from the install root's game_info.xml
    (version[@name="client"]/@installed, e.g. "26.10.0.0.8867689") —
    display only; the build-suffix digits already equal the bin/<build>."""
    info = Path(game, "game_info.xml")
    if not info.is_file():
        return None
    try:
        root = ET.parse(info).getroot()
    except ET.ParseError:
        return None
    for ver in root.iter("version"):
        if ver.get("name") == "client":
            return ver.get("installed")
    return None


# ── committed stamps ─────────────────────────────────────────────────────────

def _read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def wg_committed_version() -> str | None:
    """gameVersion of the committed WG fallback bundle (None when absent)."""
    return (_read_json(WG_BUNDLE) or {}).get("gameVersion")


def lesta_committed_build() -> str | None:
    """Build digits of the committed overlay stamp ("lesta-8867689" →
    "8867689"; None when the bundle is absent or unstamped)."""
    stamp = str((_read_json(LESTA_BUNDLE) or {}).get("gameVersion") or "")
    m = re.fullmatch(r"lesta-(\d+)", stamp)
    return m.group(1) if m else None


# ── diff helpers (shared with run.py's refresh flow) ─────────────────────────

def _ship_id_sort(sid: str) -> tuple:
    s = str(sid)
    return (0, int(s), "") if s.isdigit() else (1, 0, s)


def diff_ship_maps(old_ships: dict, new_ships: dict) -> dict:
    """Structured diff of two {shipId: entry} maps: added/removed id lists
    plus {id: [changed top-level fields]} for entries present in both."""
    old_ids, new_ids = set(old_ships), set(new_ships)
    changed: dict[str, list[str]] = {}
    for sid in sorted(old_ids & new_ids, key=_ship_id_sort):
        old_e, new_e = old_ships[sid] or {}, new_ships[sid] or {}
        differing = [
            f for f in sorted(set(old_e) | set(new_e))
            if old_e.get(f) != new_e.get(f)
        ]
        # Name the well-known fields first; any extra field follows.
        differing.sort(key=lambda f: (f not in DIFF_FIELDS, DIFF_FIELDS.index(f) if f in DIFF_FIELDS else 0))
        if differing:
            changed[sid] = differing
    return {
        "added": sorted(new_ids - old_ids, key=_ship_id_sort),
        "removed": sorted(old_ids - new_ids, key=_ship_id_sort),
        "changed": changed,
    }


def format_ship_diff(label: str, old_ships: dict, new_ships: dict) -> str:
    """Human-readable diff summary, samples capped at SAMPLE_CAP ids."""
    diff = diff_ship_maps(old_ships, new_ships)
    lines = [
        f"[encyclopedia] {label}: {len(new_ships) - len(old_ships):+d} ships "
        f"(+{len(diff['added'])} / -{len(diff['removed'])} / ~{len(diff['changed'])} changed)"
    ]
    for title, ids, source in (
        ("added", diff["added"], new_ships),
        ("removed", diff["removed"], old_ships),
    ):
        for sid in ids[:SAMPLE_CAP]:
            entry = source.get(sid) or {}
            lines.append(f"  {title:>7}: {sid}  {entry.get('name', '?')} (T{entry.get('tier', '?')})")
        if len(ids) > SAMPLE_CAP:
            lines.append(f"         … {len(ids) - SAMPLE_CAP} more {title}")
    for sid in list(diff["changed"])[:SAMPLE_CAP]:
        old_e = old_ships.get(sid) or {}
        new_e = new_ships.get(sid) or {}
        name = new_e.get("name") or old_e.get("name") or "?"
        tier = new_e.get("tier", old_e.get("tier"))
        fields = ", ".join(diff["changed"][sid])
        lines.append(f"  changed: {sid}  {name} (T{tier}) — {fields}")
    if len(diff["changed"]) > SAMPLE_CAP:
        lines.append(f"         … {len(diff['changed']) - SAMPLE_CAP} more changed")
    return "\n".join(lines)


# ── reports ──────────────────────────────────────────────────────────────────

def _wg_report() -> dict:
    committed = wg_committed_version()
    out: dict = {"bundle": str(WG_BUNDLE), "committed": committed, "status": "unknown"}
    try:
        live = wg_live_version()
    except RuntimeError as exc:
        out["error"] = str(exc)
        return out
    out["live"] = live
    if live is None:
        out["error"] = "WG API response carried no game_version"
        return out
    if committed is not None and committed == live:
        out["status"] = "up_to_date"
        out["ships"] = len((_read_json(WG_BUNDLE) or {}).get("ships") or {})
        return out
    out["status"] = "drift"
    # Preview ONLY from an already-present version-stamped cache — the
    # refresh flow owns the full ship-list fetch, never this tool.
    cache = CACHE_DIR / f"ships_basics_en_{live}.json"
    out["cache"] = str(cache)
    if not cache.is_file():
        out["note"] = ("no version-stamped cache yet — run the refresh "
                       "(python scripts/extract/run.py --module encyclopedia) to fetch it")
        return out
    new_ships = (_read_json(cache) or {}).get("ships") or {}
    old_ships = (_read_json(WG_BUNDLE) or {}).get("ships") or {}
    diff = diff_ship_maps(old_ships, new_ships)
    out["preview"] = {
        "cache": str(cache),
        "added": len(diff["added"]),
        "removed": len(diff["removed"]),
        "changed": len(diff["changed"]),
        "ships_after": len(new_ships),
        "added_sample": diff["added"][:SAMPLE_CAP],
        "removed_sample": diff["removed"][:SAMPLE_CAP],
        "changed_sample": {sid: diff["changed"][sid] for sid in list(diff["changed"])[:SAMPLE_CAP]},
        "text": format_ship_diff(
            f"ships_basics.json {committed or '(missing)'} -> {live}", old_ships, new_ships),
    }
    return out


def _lesta_report() -> dict:
    committed = lesta_committed_build()
    out: dict = {
        "bundle": str(LESTA_BUNDLE),
        "committed": committed,
        "committed_stamp": f"lesta-{committed}" if committed else None,
        "status": "unknown",
    }
    game = find_lesta_game_path(None)
    if not game:
        out["error"] = "no Lesta (Мир кораблей) client found"
        return out
    out["install"] = game
    out["client_version"] = lesta_display_version(game)
    build = lesta_client_build(game)
    out["live"] = build
    if build is None:
        out["error"] = "no bin/<build> carrying res/texts/ru/LC_MESSAGES/global.mo"
        return out
    out["live_stamp"] = f"lesta-{build}"
    out["roster_stamp"] = str((_read_json(WG_ROSTER) or {}).get("gameVersion") or "") or None
    roster_wg, roster_lesta = roster_stamp_parts()
    out["roster_wg_build"] = roster_wg
    wg_game = find_game_path(None)
    out["wg_client_build"] = wg_client_build(wg_game) if wg_game else None
    overlay_drift = committed != build
    wg_drift = (
        out["wg_client_build"] is not None and roster_wg != out["wg_client_build"]
    )
    if overlay_drift or wg_drift:
        out["status"] = "drift"
        if wg_drift:
            out["roster_note"] = (
                f"roster stamp wg part {roster_wg or '(none)'} != WG client build "
                f"{out['wg_client_build']}"
            )
        return out
    out["status"] = "up_to_date"
    out["overlay_entries"] = len((_read_json(LESTA_BUNDLE) or {}).get("ships") or {})
    out["tree_nodes"] = len(_read_json(LESTA_TREE) or {})
    return out


def _print_report(report: dict) -> None:
    wg, lesta = report["wg"], report["lesta"]
    print("== WG encyclopedia bundle ==")
    print(f"  committed: {wg.get('committed') or '(missing bundle)'}  ({wg['bundle']})")
    print(f"  live     : {wg.get('live') or '-'}  (api.worldofwarships.asia)")
    print(f"  status   : {_STATUS_LABEL[wg['status']]}")
    for key in ("error", "note"):
        if wg.get(key):
            print(f"  note     : {wg[key]}")
    if wg["status"] == "up_to_date":
        print(f"  ships    : {wg['ships']}")
    preview = wg.get("preview")
    if preview:
        print(f"  preview  : {preview['added']} added / {preview['removed']} removed / "
              f"{preview['changed']} changed -> {preview['ships_after']} ships "
              f"(from cache {Path(preview['cache']).name})")
        print(preview["text"])
        print("  refresh  : python scripts/extract/run.py --module encyclopedia")
    print()
    print("== Lesta client snapshot ==")
    print(f"  committed: {lesta.get('committed_stamp') or '(missing bundle)'}  ({lesta['bundle']})")
    if lesta.get("install"):
        version = lesta.get("client_version")
        suffix = f"  (client {version})" if version else ""
        print(f"  install  : {lesta['install']}{suffix}")
    print(f"  live     : {lesta.get('live_stamp') or '-'}")
    print(f"  status   : {_STATUS_LABEL[lesta['status']]}")
    if lesta.get("error"):
        print(f"  note     : {lesta['error']}")
    if lesta.get("roster_stamp"):
        wg_build = lesta.get("wg_client_build")
        print(f"  roster   : {lesta['roster_stamp']}  (WG client build "
              f"{wg_build or '?'})")
    if lesta.get("roster_note"):
        print(f"  note     : {lesta['roster_note']}")
    if lesta["status"] == "up_to_date":
        print(f"  overlay  : {lesta['overlay_entries']} entries, tree {lesta['tree_nodes']} nodes")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true",
                    help='emit machine-readable {"wg": ..., "lesta": ...}')
    args = ap.parse_args()

    report = {"wg": _wg_report(), "lesta": _lesta_report()}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_report(report)
    statuses = [r["status"] for r in report.values()]
    if "drift" in statuses:
        return 2
    if "unknown" in statuses:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
