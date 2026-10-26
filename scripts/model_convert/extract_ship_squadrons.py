#!/usr/bin/env python3
"""Bake the ship-detail plane picker instant seed table (ship_squadrons.json).

The ship-detail modal builds its airframe dropdown and the aircraft-view hint
from the ship GameParams slice - the only place the `planes` squadron blocks
live. On desktop that slice is unpacked from the install on first use (one
VFS mount + full GameParams pickle decode, several seconds per ship that is
not yet in the per-ship AppData cache), so the picker and the hint used to
pop in late on every carrier / hybrid opened for the first time.

This script bakes the ship -> squadron-airframe mapping into a committed
frontend table (same pattern as plane_types.json / plane_specs.json): the
modal seeds the picker and the hint from it the moment the modal opens, and
the live GameParams slice still overrides it with fresher labels once loaded.

Extraction mirrors the backend lookup exactly, so the seed can only list
what get_ship_gameparams itself could ever serve:

  * root entities are grouped by their numeric ship id (`id` / `ShipId`);
  * the group served slice is picked the way gameparams.rs
    (ship_slice_from_pickle) does: the A_Artillery-bearing entry, else any
    A_*-weapon entry, else the first;
  * the pick top-level { "planes": [...] } squadron blocks are collected -
    the same top-level scan ShipDetailModal runs on the live slice;
  * airframes without a baked GLB in plane_models.json are dropped - the
    picker must only offer models the 3D stage can actually load.

Two dumps feed the table with plane_specs.py merge semantics: the WG run
owns rows without the marker, the Lesta run adds / refreshes only the
Lesta-only ships (marked "lesta": true) and never overwrites a WG row -
ids shared by both clients resolve through the user own install anyway,
so a WG-shaped seed is corrected by the live slice seconds later.

Usage:
    python scripts/model_convert/extract_ship_squadrons.py
    python scripts/model_convert/extract_ship_squadrons.py --check
    python scripts/model_convert/extract_ship_squadrons.py \
        --input %LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json
"""
from __future__ import annotations

import argparse
import json
import mmap
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DATA_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"

DEFAULT_INPUT = Path.home() / "AppData" / "Local" / "WoWSP-extract" / "GameParams.json"

# The entity-name shape the picker keys on: index prefix + descriptive tail
# ("PAAB002_Grumman_TBF"). ShipDetailModal dedupes squadrons by the prefix.
INDEX_RE = re.compile(r"^([A-Z]+\d+)_(.+)$")


class RootScanner:
    """Iterate (root_key, entity_dict) pairs of the dump without loading it.

    The dump is one big pretty-printed `{ "<entity>": {...}, ... }` object -
    hundreds of MB. The sibling extractors random-access single entities via
    GameParamsIndex; this table needs EVERY ship entity, so it walks the root
    object in one streaming pass, brace-matching one entity at a time (the
    same string-aware scanner GameParamsIndex.entity uses), handing each
    entity to the caller with its byte span before the next one is parsed.
    """

    def __init__(self, path: Path):
        self._f = open(path, "rb")
        self._mm = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)

    def __enter__(self) -> "RootScanner":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def close(self) -> None:
        self._mm.close()
        self._f.close()

    def entries(self):
        """Yield (key, value, span) for every root-level entry, in file order.

        The span is the entity's raw byte range in the mmap, so a second
        pass can re-read only the entries it actually needs (see
        extract(): the whole dump never sits in memory at once).
        """
        mm = self._mm
        size = len(mm)
        pos = self._skip_ws(0)
        if pos >= size or mm[pos] != 0x7B:  # {
            raise ValueError("GameParams dump root is not a JSON object")
        pos = self._skip_ws(pos + 1)
        while True:
            if pos >= size:
                raise ValueError("unterminated GameParams dump root")
            c = mm[pos]
            if c == 0x7D:  # } - end of root
                return
            if c == 0x2C:  # ,
                pos = self._skip_ws(pos + 1)
                continue
            if c != 0x22:  # "
                raise ValueError(f"unexpected byte {bytes([c])!r} at {pos}")
            key, pos = self._read_string(pos)
            pos = self._skip_ws(pos)
            if pos >= size or mm[pos] != 0x3A:  # :
                raise ValueError(f"expected ':' after root key at {pos}")
            pos = self._skip_ws(pos + 1)
            start = pos
            value, pos = self._read_value(pos)
            yield key, value, (start, pos)
            pos = self._skip_ws(pos)

    # -- low-level readers ------------------------------------------------

    def _skip_ws(self, pos: int) -> int:
        mm = self._mm
        size = len(mm)
        while pos < size and mm[pos] in (0x20, 0x09, 0x0A, 0x0D):
            pos += 1
        return pos

    def _read_string(self, pos: int) -> tuple[str, int]:
        """Decode the JSON string starting at the opening quote at pos.

        Returns (decoded_text, position_after_closing_quote). The closing
        quote is located with a JSON-escape-aware scan (a backslash always
        starts a multi-byte escape, and the bytes that follow a skipped
        escape pair are never a quote), then the raw slice - quotes
        included - goes through json.loads so \\uXXXX and friends decode
        exactly like the sibling extractors' full-file parse would.
        """
        mm = self._mm
        i = pos + 1
        while True:
            b = mm[i]
            if b == 0x5C:  # backslash: the escape pair is never a quote
                i += 2
                continue
            if b == 0x22:  # closing quote
                return json.loads(mm[pos : i + 1].decode("utf-8")), i + 1
            i += 1

    def _read_value(self, pos: int) -> tuple[object, int]:
        """Parse the value starting at pos (objects / arrays / scalars).

        Objects and arrays - every entity in the dump - are slice-matched
        with the string-aware brace counter and handed to json.loads, so
        only one entity ever sits in memory. Scalars (the rare non-entity
        root values some tool versions emit) run through scan_once on the
        small remaining window they occupy.
        """
        mm = self._mm
        c = mm[pos]
        if c == 0x7B or c == 0x5B:  # { or [
            open_ch = c
            close_ch = 0x7D if c == 0x7B else 0x5D
            depth = 0
            in_str = False
            esc = False
            i = pos
            while True:
                b = mm[i]
                if in_str:
                    if esc:
                        esc = False
                    elif b == 0x5C:
                        esc = True
                    elif b == 0x22:
                        in_str = False
                elif b == 0x22:
                    in_str = True
                elif b == open_ch:
                    depth += 1
                elif b == close_ch:
                    depth -= 1
                    if depth == 0:
                        return json.loads(mm[pos : i + 1].decode("utf-8")), i + 1
                i += 1
        # Scalar (root values are objects in practice; tolerate the rest):
        # string-aware scan to the value end (top-level comma or root close),
        # then let json decode the small window.
        end = pos
        in_str = False
        esc = False
        size = len(mm)
        while end < size:
            b = mm[end]
            if in_str:
                if esc:
                    esc = False
                elif b == 0x5C:
                    esc = True
                elif b == 0x22:
                    in_str = False
            elif b == 0x22:
                in_str = True
            elif b in (0x2C, 0x7D):  # , or }
                break
            end += 1
        value = json.loads(mm[pos:end].decode("utf-8"))
        return value, end

    def slice_at(self, span: tuple[int, int]) -> dict:
        """Decode the entity at a raw byte span recorded by entries()."""
        return json.loads(self._mm[span[0] : span[1]].decode("utf-8"))


def entity_id(entity: dict) -> int | None:
    """Numeric ship id of a root entity (id / ShipId, int or digit str).

    Mirrors gameparams.rs pickled_entry_matches / entry_matches_id: the
    id field decides, ShipId is the fallback some unpackers emit.
    """
    for field in ("id", "ShipId"):
        v = entity.get(field)
        if isinstance(v, bool):
            continue
        if isinstance(v, int):
            return v
        if isinstance(v, str):
            try:
                return int(v)
            except ValueError:
                continue
    return None


def plane_names_of_slice(slice: dict) -> list[str]:
    """Squadron airframe names on the slice top level (frontend parity).

    ShipDetailModal scans Object.values(slice) for { planes: [...] }
    blocks; this is the same scan, collecting the raw entity names.
    """
    names: list[str] = []
    for v in slice.values():
        if isinstance(v, dict):
            planes = v.get("planes")
            if isinstance(planes, list):
                names.extend(p for p in planes if isinstance(p, str))
    return names


def extract(path: Path, models: set[str]) -> dict[int, dict]:
    """Ship id -> {name, planes} for every ship the dump can serve.

    Grouping + pick order mirror ship_slice_from_pickle, because the
    frontend only ever scans the slice the backend actually returned:
    when a CV hull and its squadrons share an id, the hull entry (the
    one with A_Artillery) is what ships, and squadrons hidden in the
    sibling entries never reach the picker.

    Memory stays flat: pass 1 walks the dump recording only candidate
    metadata per ship id (the entity dicts are dropped as they are
    scanned), and pass 2 re-reads just the winning entries' byte spans -
    a few hundred KB of ship slices instead of the whole tree.
    """
    # sid -> candidate spans: first id-bearing entry, first A_Artillery
    # entry, first any-A_* entry (root order each - the backend scans
    # candidates in dict order and picks with the same priority).
    cands: dict[int, dict[str, tuple[str, tuple[int, int]]]] = {}

    with RootScanner(path) as scanner:
        for key, entity, span in scanner.entries():
            if not isinstance(entity, dict):
                continue
            sid = entity_id(entity)
            if sid is None:
                continue
            slot = cands.setdefault(sid, {})
            if "first" not in slot:
                slot["first"] = (key, span)
            has_art = "A_Artillery" in entity.keys()
            has_any_a = has_art or any(k.startswith("A_") for k in entity.keys())
            if has_art and "art" not in slot:
                slot["art"] = (key, span)
            if has_any_a and "anyA" not in slot:
                slot["anyA"] = (key, span)

        out: dict[int, dict] = {}
        for sid, slot in cands.items():
            pick = slot.get("art") or slot.get("anyA") or slot["first"]
            entity = scanner.slice_at(pick[1])
            names: list[str] = []
            seen: set[str] = set()
            for name in plane_names_of_slice(entity):
                m = INDEX_RE.match(name)
                # Only stageable airframes: no baked GLB, no picker entry
                # (the 3D stage would just toast a load failure).
                if not m or name not in models or name in seen:
                    continue
                seen.add(name)
                names.append(name)
            if not names:
                continue
            label = entity.get("name")
            if not isinstance(label, str) or not label:
                label = pick[0]
            out[sid] = {"name": label, "planes": names}
    return out


def canonical(table: dict[int, dict]) -> str:
    """The committed byte layout: one compact line, ship ids numeric-sorted.

    Entry keys emit in a fixed order (lesta, name, planes) so the bytes
    stay stable across runs; numeric ordering keeps the diff readable
    where lexicographic would scramble 9/10-digit ids.
    """
    ordered: dict[str, dict] = {}
    for sid in sorted(table):
        row = table[sid]
        entry: dict = {}
        if row.get("lesta"):
            entry["lesta"] = True
        entry["name"] = row["name"]
        entry["planes"] = row["planes"]
        ordered[str(sid)] = entry
    return json.dumps(ordered, ensure_ascii=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT,
                    help="unpacked GameParams.json (default: the WG client "
                         "orchestrator cache)")
    ap.add_argument("--source", choices=("auto", "wg", "lesta"), default="auto",
                    help="which client this dump came from - selects the "
                         "ship ids it owns (default: auto = lesta when the "
                         "file name mentions lesta)")
    ap.add_argument("--models", type=Path, default=DATA_DIR / "plane_models.json",
                    help="committed plane GLB index (stageability filter)")
    ap.add_argument("--out", type=Path, default=DATA_DIR / "ship_squadrons.json",
                    help="committed ship squadron seed table")
    ap.add_argument("--check", action="store_true",
                    help="verify the committed file is up to date; write nothing")
    args = ap.parse_args()

    if not args.input.is_file():
        print(f"GameParams not found at {args.input} - run the orchestrator "
              "extract first (see scripts/extract_gameparams.py)", file=sys.stderr)
        return 1
    if not args.models.is_file():
        print(f"plane_models.json not found at {args.models}", file=sys.stderr)
        return 1

    source = "lesta" if args.source == "lesta" or (
        args.source == "auto" and "lesta" in args.input.name.lower()
    ) else "wg"
    models = set(json.loads(args.models.read_text(encoding="utf-8")).keys())

    extracted = extract(args.input, models)

    existing: dict[int, dict] = {}
    if args.out.is_file():
        for key, row in json.loads(args.out.read_text(encoding="utf-8")).items():
            existing[int(key)] = row

    # Ownership merge (plane_specs.py semantics): the WG run owns the
    # unmarked rows, the Lesta run owns the marked ones - and only ever
    # ADDS the other client ids, never overwriting a WG row.
    merged = dict(existing)
    for sid, row in extracted.items():
        prev = merged.get(sid)
        owned = (prev is None) or (bool(prev.get("lesta")) == (source == "lesta"))
        if owned:
            row = dict(row)
            if source == "lesta":
                row["lesta"] = True
            else:
                row.pop("lesta", None)
            merged[sid] = row

    text = canonical(merged)
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.is_file() else None
        if current == text:
            print(f"[ship-squadrons] up to date - {len(merged)} ships "
                  f"({source} source, {len(extracted)} checked)")
            return 0
        stale = [sid for sid, row in merged.items()
                 if (existing.get(sid) or {}) != row]
        print(f"[ship-squadrons] OUT OF DATE - {len(stale)} ship(s) would "
              f"change ({source} source); run without --check to regenerate "
              f"{args.out}", file=sys.stderr)
        return 1

    args.out.write_text(text, encoding="utf-8", newline="\n")
    added = sum(1 for sid in merged if sid not in existing)
    print(f"[ship-squadrons] wrote {len(merged)} ships to {args.out} "
          f"({source} source: {len(extracted)} extracted, {added} added)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
