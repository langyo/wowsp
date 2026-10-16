"""Build the WG-only roster artifact for the encyclopedia (ships_wg_only.json).

The mirror of build_lesta_overlay.py's exclusion walk: that script derives
the ships ONLY the Lesta client carries (overlay entries for the
encyclopedia); this one derives the ships only the WG client carries —
every Ship entity in the WG GameParams dump whose index the Lesta dump has
no entry for. The webui's Lesta mode hides these ids from the encyclopedia
list (packages/webui/src/utils/shipsLesta.ts), closing the gap the
tree-derived set leaves: WG_EXCLUSIVE_TREE_SHIP_IDS covers researchable
hull ids from the two bundled trees, but hundreds of WG premiums, collabs
and event hulls live in no tree — only the full dumps can classify them.

No group filtering is applied on the WG side, deliberately: the artifact is
a pure index-space set-difference, and ids the WG encyclopedia API never
lists (test/unreleased hulls) are inert at runtime — a filter hit requires
the id to arrive in the WG-sourced roster first. The inverse direction is
false-negative only: a WG API ship whose index is missing from the WG dump
stays unclassified (shown in both modes) rather than wrongly hidden.

Output shape (keyed by stringified shipId, same convention as
ships_lesta.json):

    { "gameVersion": "<stamp>", "ships": { "<shipId>": { "index": "PUSC019" } } }

Sources:
  --gameparams        decoded WG GameParams.json
  --lesta-gameparams  decoded Lesta GameParams.json
  --version           version stamp for gameVersion (default "wg")
  --out               ships_wg_only.json output path
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_techtree import _params_root  # noqa: E402


def _ship_index_map(gp: dict) -> dict[str, int]:
    """{index: id} over the dump's Ship entities (last writer wins on the
    rare duplicate index — the duplicates are alpha/test variants sharing
    the production hull's index)."""
    out: dict[str, int] = {}
    for entry in gp.values():
        if not isinstance(entry, dict):
            continue
        ti = entry.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        idx = entry.get("index")
        sid = entry.get("id")
        if isinstance(idx, str) and isinstance(sid, int):
            out[idx] = sid
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gameparams", required=True, help="decoded WG GameParams.json")
    ap.add_argument("--lesta-gameparams", required=True, help="decoded Lesta GameParams.json")
    ap.add_argument("--version", default="wg", help="version stamp for gameVersion")
    ap.add_argument("--out", required=True, help="ships_wg_only.json output path")
    args = ap.parse_args()

    print(f"[wg-only] loading gameparams {args.gameparams} ...", flush=True)
    wg_gp = _params_root(json.loads(Path(args.gameparams).read_text(encoding="utf-8")))
    print(f"[wg-only] loading lesta gameparams {args.lesta_gameparams} ...", flush=True)
    lesta_gp = _params_root(json.loads(Path(args.lesta_gameparams).read_text(encoding="utf-8")))

    wg_ships = _ship_index_map(wg_gp)
    lesta_indexes = set(_ship_index_map(lesta_gp))
    print(
        f"[wg-only] WG ship entities: {len(wg_ships)}, "
        f"Lesta ship entities: {len(lesta_indexes)}",
        flush=True,
    )

    ships: dict[str, dict] = {}
    for idx, sid in sorted(wg_ships.items()):
        if idx in lesta_indexes:
            continue
        ships[str(sid)] = {"index": idx}

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"gameVersion": args.version, "ships": ships},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"[wg-only] wrote {len(ships)} WG-only ships -> {out}")


if __name__ == "__main__":
    main()
