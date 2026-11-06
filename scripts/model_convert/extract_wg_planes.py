#!/usr/bin/env python3
"""Add the WG client's new airframes to the committed plane tables.

`packages/webui/src/data/plane_types.json` and `plane_models.json` were
generated from a WG client snapshot, so a game update introduces airframes no
committed row knows: a new carrier's squadrons, the ASW plane a battleship line
embarks, or an event mode's airships. Without a row the ship-detail plane
picker has no role label and `bake_planes.py` never exports the model.

This script walks the decoded WG GameParams dump and APPENDS the aircraft the
tables do not carry yet. It never modifies or drops an existing row — legacy,
event and internal airframes the current client no longer references stay
exactly as committed, and `extract_plane_types.py` owns the role refresh.

Row shape and derivations mirror `extract_lesta_planes.py` (which added the
Lesta client's airframes the same way):

    plane_types.json   keyed by plane id: { index, name, type, count, role }
                       (count = numPlanesInSquadron, role from the carried
                       ammunition — the same rule extract_plane_types.py uses)
    plane_models.json  keyed by entity name: "/content/.../<NAME>.geometry"

Usage:
    python scripts/model_convert/extract_wg_planes.py
    python scripts/model_convert/extract_wg_planes.py --dry-run

Follow-up order after this script: `extract_plane_types.py` (roles) ->
`extract_plane_specs.py` (performance rows) -> `extract_ship_squadrons.py`
(plane-picker seeds) -> `bake_planes.py --planes <the names printed below>`.
The script prints the exact `--planes` list when it adds rows.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent.parent
DATA_DIR = REPO / "packages" / "webui" / "src" / "data"
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))) / "WoWSP-extract"

sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "extract"))
from build_techtree import _params_root  # noqa: E402
from extract_plane_types import plane_role  # noqa: E402
from extract_lesta_planes import DictGameParams, geometry_path, plane_type  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gameparams", type=Path, default=CACHE_DIR / "GameParams.json",
                    help="decoded WG GameParams.json (default: the orchestrator cache)")
    ap.add_argument("--types", type=Path, default=DATA_DIR / "plane_types.json")
    ap.add_argument("--models", type=Path, default=DATA_DIR / "plane_models.json")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    if not args.gameparams.is_file():
        print(f"error: GameParams not found: {args.gameparams}", file=sys.stderr)
        return 1

    root = _params_root(json.loads(args.gameparams.read_text(encoding="utf-8")))
    if not isinstance(root, dict):
        print(f"error: unrecognized GameParams root in {args.gameparams}", file=sys.stderr)
        return 1
    gp = DictGameParams(root)

    plane_types: dict = json.loads(args.types.read_text(encoding="utf-8"), object_pairs_hook=dict)
    plane_models: dict = json.loads(args.models.read_text(encoding="utf-8"), object_pairs_hook=dict)
    known_ids = set(plane_types)
    known_names = {v.get("name") for v in plane_types.values() if isinstance(v, dict)}

    ammo_cache: dict = {}
    added: list[str] = []
    no_model: list[str] = []
    failed: list[str] = []
    for name, ent in sorted(root.items()):
        if not isinstance(ent, dict):
            continue
        ti = ent.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Aircraft":
            continue
        if name in known_names:
            continue
        pid = ent.get("id")
        index = ent.get("index")
        if not isinstance(pid, int) or not isinstance(index, str):
            failed.append(name)
            continue
        if str(pid) in known_ids:
            # The id is already carried under another name — never re-key a
            # committed row from a name-only walk; report it instead.
            failed.append(name)
            continue
        role = plane_role(gp, ent, ammo_cache)
        plane_types[str(pid)] = {
            "index": index,
            "name": name,
            "type": plane_type(ent, role),
            "count": ent.get("numPlanesInSquadron", 1),
            "role": role,
        }
        geom = geometry_path(str(ent.get("model") or ""))
        if geom:
            plane_models[name] = geom
        else:
            no_model.append(name)
        added.append(name)

    if not args.dry_run and added:
        # Preserve each table's committed layout: plane_types.json is a single
        # line in the spaced json.dumps style (extract_plane_types.py writes
        # it), plane_models.json one entry per line — both LF, like the Lesta
        # merger's writer.
        args.types.write_text(
            json.dumps(plane_types, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        model_lines = [
            f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}"
            for k, v in plane_models.items()
        ]
        args.models.write_text(
            "{\n" + ",\n".join(model_lines) + "\n}",
            encoding="utf-8",
            newline="\n",
        )

    verb = "would add" if args.dry_run else "added"
    print(f"[wg-planes] {verb} {len(added)} airframes — "
          f"{len(plane_types)} plane_types / {len(plane_models)} plane_models entries")
    if added:
        print("[wg-planes] bake list: " + " ".join(added))
    if no_model:
        print("[wg-planes] WARN no model path (row added, GLB skipped): " + ", ".join(no_model),
              file=sys.stderr)
    if failed:
        print("[wg-planes] WARN skipped without id/index or id already carried: "
              + ", ".join(failed), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
