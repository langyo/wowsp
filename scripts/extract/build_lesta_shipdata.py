#!/usr/bin/env python3
"""Bundle the Lesta-only ships' GameParams slices into the app (armor & ballistics).

The encyclopedia's Lesta realm is a client snapshot (ships_lesta.json
carries the `lesta-<build>` stamp; tech_tree_lesta.json is its topology)
whose working ship ids exist only in that same client's GameParams. The
armor & ballistics tab
(`get_ship_gameparams`, commands/gameparams.rs) otherwise decodes whatever
install the user has configured — typically the WG client, which has never
heard of these ids — and the loose `GameParams.json` fallbacks are WG dumps
too, so opening any Lesta-only ship failed with

    ship_id <id> not found in GameParams

and, as a direct consequence, carriers showed no squadron plane picker at
all (the picker reads the same slice). This script cuts the slices out of
the decoded Lesta dump and writes them into the app's Rust tree, where
`gameparams.rs` embeds the file with `include_str!` and answers these ids
before ever touching an install. Armor, ballistics, AA rows, the weapon bar
and the plane pickers then work with ANY (or no) install configured — phones
included, whose synced/bundled GameParams pack is WG-derived and equally
blind to these ids.

Scope: the Lesta tech tree's ships whose *index* is absent from the WG tree
— exactly the ships `build_lesta_overlay.py` adds to the encyclopedia, so
the bundled slice and the displayed name/profile always come from the same
snapshot. Ships the two clients share keep resolving from the user's own
install (their ids match across clients).

Sources:
  --gameparams  decoded Lesta GameParams.json (default: the orchestrator
                cache %LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json)
  --lesta-tree  committed Lesta tree (default: src/data/tech_tree_lesta.json)
  --wg-tree     committed WG tree — scope filter (default: src/data/tech_tree.json)
  --overlay     committed overlay, read for the version stamp
                (default: src/data/ships_lesta.json)
  --version     version stamp override (default: the overlay's gameVersion)
  --out         bundle path (default: packages/app/tauri/src/commands/
                lesta_ship_gameparams.json)

The slice pick mirrors `ship_slice_from_pickle` in commands/gameparams.rs:
among the entities sharing a ship id (a CV's hull + module entries), the one
carrying `A_Artillery` wins, then any entry with an `A_*` weapon key, then
the first — so the bundled slice is the same entry (structurally identical,
though Python's number formatting differs in places) that the in-app unpack
produces for a Lesta install. Should a tree ship have no entity carrying its
id (snapshot drift), the index-matched entry is packed anyway — better than
leaving the UI with nothing, and the drift is warned about below.

Usage:
    python scripts/extract/build_lesta_shipdata.py
    python scripts/extract/build_lesta_shipdata.py \
        --gameparams "C:/lesta/GameParams_lesta.json"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from build_techtree import _params_root  # noqa: E402

REPO_ROOT = SCRIPT_DIR.parent.parent
SRC_DATA = REPO_ROOT / "packages" / "webui" / "src" / "data"
OUT_DEFAULT = REPO_ROOT / "packages" / "app" / "tauri" / "src" / "commands" / "lesta_ship_gameparams.json"
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"


def _armed_rank(entry: dict) -> int:
    """Mirror of gameparams.rs's hull preference: A_Artillery > any A_* > rest."""
    if "A_Artillery" in entry:
        return 0
    if any(str(k).startswith("A_") for k in entry):
        return 1
    return 2


def pick_slice(entities: list[dict], ship_id: int) -> dict | None:
    """The armed entry among the entities carrying `ship_id` (None if absent)."""
    hits = [e for e in entities if e.get("id") == ship_id]
    if not hits:
        return None
    hits.sort(key=_armed_rank)
    return hits[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gameparams", type=Path, default=CACHE_DIR / "GameParams_lesta.json")
    ap.add_argument("--lesta-tree", type=Path, default=SRC_DATA / "tech_tree_lesta.json")
    ap.add_argument("--wg-tree", type=Path, default=SRC_DATA / "tech_tree.json")
    ap.add_argument("--overlay", type=Path, default=SRC_DATA / "ships_lesta.json")
    ap.add_argument("--version", default=None, help="version stamp (default: the overlay's gameVersion)")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = ap.parse_args()

    for req, label in (
        (args.gameparams, "Lesta GameParams dump"),
        (args.lesta_tree, "Lesta tech tree"),
        (args.wg_tree, "WG tech tree"),
    ):
        if not req.is_file():
            print(f"error: {label} not found: {req}", file=sys.stderr)
            return 1

    dump = _params_root(json.loads(args.gameparams.read_text(encoding="utf-8")))
    if not dump:
        print(f"error: unrecognized GameParams root in {args.gameparams}", file=sys.stderr)
        return 1

    lesta_tree = json.loads(args.lesta_tree.read_text(encoding="utf-8"))
    wg_indexes = {n["index"] for n in json.loads(args.wg_tree.read_text(encoding="utf-8")).values()}

    by_index: dict[str, dict] = {}
    for entry in dump.values():
        if isinstance(entry, dict) and isinstance(entry.get("index"), str):
            by_index.setdefault(entry["index"], entry)
    entities = [e for e in dump.values() if isinstance(e, dict)]

    version = args.version
    if version is None and args.overlay.is_file():
        version = json.loads(args.overlay.read_text(encoding="utf-8")).get("gameVersion")
        if version:
            # The dump's own build is not recorded in it; the stamp is the
            # encyclopedia snapshot's. `just extract` passes the client's
            # build explicitly when it can read it from the install.
            print(
                f"[lesta-shipdata] note: stamp {version} inherited from {args.overlay.name} "
                "(pass --version to stamp this dump's own build)",
                flush=True,
            )
    version = version or "lesta"

    slices: dict[str, dict] = {}
    missing: list[str] = []
    for node in lesta_tree.values():
        idx = node.get("index")
        if not idx or idx in wg_indexes:
            continue  # the WG install serves it (ids match across clients)
        sid = node.get("shipId")
        entry = by_index.get(idx)
        if entry is None:
            missing.append(idx)
            continue
        picked = pick_slice(entities, int(sid))
        if picked is None:
            print(
                f"[lesta-shipdata] WARN {idx}: no entity carries id {sid} — "
                "packing the index-matched entry",
                file=sys.stderr,
                flush=True,
            )
            picked = entry
        slices[str(sid)] = picked

    if missing:
        print(
            f"[lesta-shipdata] WARN tree ships with no GameParams entity: {', '.join(sorted(missing))}",
            file=sys.stderr,
            flush=True,
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {"gameVersion": version, "ships": slices},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    size_mb = args.out.stat().st_size / 1024 / 1024
    print(
        f"[lesta-shipdata] wrote {len(slices)} ships ({size_mb:.1f} MB) -> {args.out} "
        f"[{version}]"
    )
    return 0 if slices else 1


if __name__ == "__main__":
    raise SystemExit(main())
