#!/usr/bin/env python3
"""Bake the site's replay hull silhouettes from the game's own plaque art.

What it does
    Resolves every ship in a baked battle's roster to the game's HP-plaque
    hull-silhouette bitmap, copies the few needed bitmaps into the site's
    resource tree, and writes the lookup the site renderer reads:

        packages/website/src/res/replay/<slug>/silhouettes-index.json
        packages/website/src/res/replay/<slug>/silhouettes/<INDEX>.webp

    The index is keyed by the roster entry's "model" stem (NOT by pack
    index) because that is what ReplayLive.tsx sees, and each value carries
    the pack file name plus the art's alpha crop band in its native 404x155
    canvas:

        { "<modelStem>": { "file": "<INDEX>.webp", "top": <int>, "bottom": <int> } }

    "top"/"bottom" come verbatim from
    packages/webui/src/res/models/silhouette_boxes.json — the same
    silhouetteBox the app hands to HoloShipCard, so the site plaque crops
    the bitmap exactly like the desktop app's recorder-ship plaque.

Resolver fallback order
    A roster entry's pack <INDEX> is resolved from these sources, the
    first hit that has BOTH a bitmap and a crop box winning:

        1. reverse ship_models.json by baseName == model (case-insensitive)
        2. ships.json row whose id == model (the roster model already is a
           pack index)
        3. ships.json row whose n.en == model, then whose n.en == shipEn
        4. reverse ship_models.json by baseName == shipEn

    Inside a step the candidates are sorted by pack index, so an ambiguous
    baseName (Ryujo -> PJSA009/PJSA106, Ranger -> PASA010/PASA106/PXSA807)
    deterministically selects the art-bearing entry. Models that resolve to
    an index without art are reported as misses and omitted from the index:
    the renderer then keeps the traced VECTOR hull from silhouettes.json.

When to run
    Re-run after scripts/bake_site_replay.py bakes a new or changed battle
    (same roster -> same art). The output is committed to the repo, so the
    site build never needs the game's resource pack.

Usage
    python scripts/bake_site_silhouettes.py [--slug conquest-nagato]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SHIP_MODELS = REPO_ROOT / "packages/webui/src/data/ship_models.json"
SILHOUETTE_ART = REPO_ROOT / "packages/webui/src/res/models/silhouettes"
SILHOUETTE_BOXES = REPO_ROOT / "packages/webui/src/res/models/silhouette_boxes.json"
SITE_SHIPS = REPO_ROOT / "packages/website/src/data/ships.json"
SITE_REPLAY = REPO_ROOT / "packages/website/src/res/replay"
DEFAULT_SLUG = "conquest-nagato"
# Every bitmap in the pack is 404x155 (the app's plaque canvas — CANVAS_H in
# packages/holo/src/HoloShipCard.tsx); the crop box rows live in that space.
CANVAS_H = 155


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def reverse_base_names(ship_models: dict) -> dict[str, list[str]]:
    """baseName (lower-case) -> sorted list of pack indexes."""
    out: dict[str, list[str]] = {}
    for row in ship_models.values():
        base = str(row.get("baseName") or "").strip().lower()
        index = str(row.get("index") or "").strip()
        if base and index:
            out.setdefault(base, []).append(index)
    for indexes in out.values():
        indexes.sort()
    return out


def index_site_ships(ships: list) -> tuple[dict[str, dict], dict[str, list[dict]]]:
    """Catalogue rows by id and (lower-case) English name, id-sorted."""
    by_id: dict[str, dict] = {}
    by_en_name: dict[str, list[dict]] = {}
    for row in ships:
        ship_id = str(row.get("id") or "").strip()
        if not ship_id:
            continue
        by_id[ship_id] = row
        en = str((row.get("n") or {}).get("en") or "").strip().lower()
        if en:
            by_en_name.setdefault(en, []).append(row)
    for rows in by_en_name.values():
        rows.sort(key=lambda r: str(r.get("id") or ""))
    return by_id, by_en_name


def candidate_steps(
    entry: dict,
    by_base: dict[str, list[str]],
    by_ship_id: dict[str, dict],
    by_en_name: dict[str, list[dict]],
):
    """Yield (source, [pack index, ...]) in the documented fallback order."""
    model = str(entry.get("model") or "").strip()
    ship_en = str(entry.get("shipEn") or "").strip()
    yield "ship_models.baseName==model", by_base.get(model.lower(), [])
    yield "ships.id==model", [model] if model in by_ship_id else []
    rows = by_en_name.get(model.lower()) or by_en_name.get(ship_en.lower()) or []
    yield "ships.n.en==model/shipEn", [str(r.get("id")) for r in rows]
    yield "ship_models.baseName==shipEn", by_base.get(ship_en.lower(), [])


def resolve_index(
    entry: dict,
    by_base: dict[str, list[str]],
    by_ship_id: dict[str, dict],
    by_en_name: dict[str, list[dict]],
    art_stems: set[str],
    boxes: dict,
) -> tuple[str | None, str | None, list[str]]:
    """First candidate having both art and a box -> (index, source, rejected).

    rejected lists the candidate indexes skipped and why, so a miss is
    reported instead of silently falling back to the vector hull.
    """
    rejected: list[str] = []
    for source, indexes in candidate_steps(entry, by_base, by_ship_id, by_en_name):
        for index in indexes:
            if index in art_stems and index in boxes:
                return index, source, rejected
            missing = [
                reason
                for reason, present in (
                    ("no bitmap", index in art_stems),
                    ("no crop box", index in boxes),
                )
                if not present
            ]
            rejected.append(f"{index} via {source} ({' + '.join(missing)})")
    return None, None, rejected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Bake the site's replay hull-silhouette bitmaps + index.",
    )
    parser.add_argument(
        "--slug",
        default=DEFAULT_SLUG,
        help=f"replay bundle under packages/website/src/res/replay/ (default: {DEFAULT_SLUG})",
    )
    args = parser.parse_args(argv)

    replay_dir = SITE_REPLAY / args.slug
    battle_path = replay_dir / "battle.json"
    if not battle_path.is_file():
        print(
            f"missing {battle_path.relative_to(REPO_ROOT)} — bake it with scripts/bake_site_replay.py first",
            file=sys.stderr,
        )
        return 1
    roster = load_json(battle_path).get("roster") or []
    if not roster:
        print(f"no roster in {battle_path.relative_to(REPO_ROOT)}", file=sys.stderr)
        return 1

    by_base = reverse_base_names(load_json(SHIP_MODELS))
    by_ship_id, by_en_name = index_site_ships(load_json(SITE_SHIPS))
    boxes = load_json(SILHOUETTE_BOXES)
    art_stems = {path.stem for path in SILHOUETTE_ART.glob("*.webp")}

    # Roster order, first appearance per model (duplicate ships share one entry).
    first_entry: dict[str, dict] = {}
    for entry in roster:
        model = str(entry.get("model") or "").strip()
        if model and model not in first_entry:
            first_entry[model] = entry

    resolved: dict[str, tuple[str, str]] = {}
    misses: list[tuple[str, list[str]]] = []
    for model, entry in first_entry.items():
        index, source, rejected = resolve_index(
            entry, by_base, by_ship_id, by_en_name, art_stems, boxes
        )
        if index is None:
            misses.append((model, rejected))
        else:
            resolved[model] = (index, source)

    out_dir = replay_dir / "silhouettes"
    out_dir.mkdir(parents=True, exist_ok=True)

    index: dict[str, dict] = {}
    rows: list[tuple[str, str, int, int, int]] = []
    total_bytes = 0
    for model in sorted(resolved):
        index_stem, _source = resolved[model]
        box = boxes[index_stem]
        if not (isinstance(box, list) and len(box) == 2):
            print(f"{index_stem}: malformed crop box {box!r}", file=sys.stderr)
            return 1
        top, bottom = int(box[0]), int(box[1])
        if not 0 <= top < bottom <= CANVAS_H:
            print(
                f"{index_stem}: crop box [{top}, {bottom}] outside 0 <= top < bottom <= {CANVAS_H}",
                file=sys.stderr,
            )
            return 1
        src = SILHOUETTE_ART / f"{index_stem}.webp"
        dst = out_dir / f"{index_stem}.webp"
        payload = src.read_bytes()
        if not dst.is_file() or dst.read_bytes() != payload:
            dst.write_bytes(payload)
        total_bytes += len(payload)
        index[model] = {"file": f"{index_stem}.webp", "top": top, "bottom": bottom}
        rows.append((model, index_stem, len(payload), top, bottom))

    # Drop copies from a previous bake that this roster no longer emits.
    keep = {f"{index_stem}.webp" for index_stem, _source in resolved.values()}
    for stale in sorted(out_dir.glob("*.webp")):
        if stale.name not in keep:
            stale.unlink()
            print(f"removed stale {stale.relative_to(REPO_ROOT)}")

    out_path = replay_dir / "silhouettes-index.json"
    text = json.dumps(index, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if not out_path.is_file() or out_path.read_text(encoding="utf-8") != text:
        with out_path.open("w", encoding="utf-8", newline="\n") as f:
            f.write(text)

    name_w = max([len("model")] + [len(row[0]) for row in rows])
    index_w = max([len("index")] + [len(row[1]) for row in rows])
    print(f"{'model':<{name_w}}  {'index':<{index_w}}  {'bytes':>7}  crop")
    for model, index_stem, size, top, bottom in rows:
        print(f"{model:<{name_w}}  {index_stem:<{index_w}}  {size:>7}  [{top},{bottom}]")

    print(
        f"{len(rows)}/{len(first_entry)} roster models resolved from "
        f"{len(roster)} entries -> {out_path.relative_to(REPO_ROOT)}"
    )
    print(
        f"copied {len(index)} bitmap(s) ({total_bytes} bytes) into "
        f"{out_dir.relative_to(REPO_ROOT)}"
    )
    for model, rejected in misses:
        tried = "; ".join(rejected) if rejected else "no candidate at all"
        print(f"MISS {model}: no art-bearing pack index ({tried})", file=sys.stderr)
    if misses:
        print(
            f"{len(misses)} model(s) keep the traced VECTOR hull from silhouettes.json",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
