"""Regenerate the dog-tag asset pack (map + PNGs) from a WoWS install.

Player avatars ("dog tags") are rendered from two repo-shipped artifacts:

  packages/webui/src/data/dogtags_map.json   Vortex dog_tag id → [index,
                                             species, colorHEX?]
  packages/webui/src/res/dogtags/**          the 80x80 part images
                                             (gui/dogTags/small/*)

Both are snapshots of the game client, so Wargaming's periodic content
updates silently strand new medals: the app then renders the default
placeholder for any id missing from the map. This module re-derives both
artifacts from the local install:

  1. GameParams.json — every entity with `typeinfo.type == "DogTag"` carries
     the Vortex id (`id`), the asset index (`index`, e.g. "PCNP053"), the
     `typeinfo.species` (Symbol / Patch / Emblem / BackgroundShape /
     BackgroundColor / BorderColor / BackgroundTexture) and, for the color
     species, `colorHEX`. These ids are the exact ids the Vortex account API
     returns in `dog_tag` (verified field-by-field against live accounts).
  2. `gui/dogTags/small/**` + `gui/dogTags/DT_Default.png` — the part images,
     sliced out of the gui_*.pkg blobs and mirrored into res/dogtags/ (stale
     files removed). wowsunpack's own `extract` subcommand is broken on the
      Steam install layout ("Wrote 0 files"), so this walks the same
     metadata path→size/crc map + PNG-slicing approach as
     extract_game_assets.py, across every gui_*.pkg.

Run via the orchestrator (`just extract dogtags`); publishing to the app is
a separate step (`python scripts/release_models.py` uploads the dogtags pack
as the `wowsp-dogtags.tar.gz` asset of the rotating `res-latest` release).

Inputs:
  --gameparams : unpacked GameParams.json (shared orchestrator cache)
  --meta       : wowsunpack metadata json (shared orchestrator cache)
  --game       : game install root (locates res_packages/gui_*.pkg)
  --out-map    : packages/webui/src/data/dogtags_map.json
  --res-dir    : packages/webui/src/res/dogtags
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import zlib
from pathlib import Path

from extract_game_assets import slice_pngs

DOG_TAG_SPECIES = {
    "Symbol",
    "Patch",
    "Emblem",
    "BackgroundShape",
    "BackgroundColor",
    "BorderColor",
    "BackgroundTexture",
}


def build_map(gameparams_path: Path) -> dict[str, list[str]]:
    """Vortex dog_tag id → [index, species] / [index, species, colorHEX]."""
    data = json.loads(gameparams_path.read_text(encoding="utf-8"))
    mapping: dict[str, list[str]] = {}
    for entity in data.values():
        if not isinstance(entity, dict):
            continue
        typeinfo = entity.get("typeinfo") or {}
        if typeinfo.get("type") != "DogTag":
            continue
        index = entity.get("index")
        species = typeinfo.get("species")
        entity_id = entity.get("id")
        if not index or species not in DOG_TAG_SPECIES or entity_id is None:
            continue
        entry = [index, species]
        color = entity.get("colorHEX")
        if species in ("BackgroundColor", "BorderColor") and color:
            entry.append(color)
        mapping[str(entity_id)] = entry
    return dict(sorted(mapping.items(), key=lambda kv: int(kv[0])))


def wanted_rel_path(meta_path: str) -> str | None:
    """Metadata path → repo-relative layout under res/dogtags, or None.

    `/gui/dogTags/small/PCNP053.png`      → `PCNP053.png`
    `/gui/dogTags/small/PCNA001/border.png` → `PCNA001/border.png`
    `/gui/dogTags/DT_Default.png`         → `DT_Default.png`
    """
    prefix = "/gui/dogTags/small/"
    if meta_path.startswith(prefix):
        return meta_path[len(prefix):]
    if meta_path == "/gui/dogTags/DT_Default.png":
        return "DT_Default.png"
    return None


def extract_images(
    game: str,
    meta_path: Path,
    out_dir: Path,
) -> tuple[int, int]:
    """Slice the dog-tag PNGs out of the gui_*.pkg blobs into out_dir.

    Returns (matched, wanted) — a mismatch means some wanted paths never
    matched a blob (size+crc), e.g. paths missing from this install.
    Matching counts distinct rel paths: identical-content placeholders share
    one blob, so a raw write counter would overcount and break the early
    exit before later pkgs were scanned.
    """
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    # size → [(rel_path, crc32)] for every dog-tag PNG we want.
    size_to_entries: dict[int, list[tuple[str, int | None]]] = {}
    for e in meta:
        if e.get("is_directory"):
            continue
        rel = wanted_rel_path(e["path"])
        if rel is None:
            continue
        size_to_entries.setdefault(e["unpacked_size"], []).append(
            (rel, e.get("crc32")),
        )
    wanted = sum(len(v) for v in size_to_entries.values())
    print(f"[dogtags] {wanted} target entries in metadata")

    res_packages = Path(game, "res_packages")
    pkgs = sorted(res_packages.glob("gui_*.pkg"))
    if not pkgs:
        raise SystemExit(f"no gui_*.pkg found under {res_packages}")

    matched: set[str] = set()
    for pkg_path in pkgs:
        if len(matched) >= wanted:
            break
        print(f"[dogtags] scanning {pkg_path.name} "
              f"({pkg_path.stat().st_size >> 20} MB) ...")
        pkg = pkg_path.read_bytes()
        for _offset, png in slice_pngs(pkg):
            entries = size_to_entries.get(len(png))
            if not entries:
                continue
            crc = zlib.crc32(png) & 0xFFFFFFFF
            for rel, entry_crc in entries:
                if entry_crc is not None and entry_crc != crc:
                    continue
                if rel in matched:
                    continue
                dest = out_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(png)
                matched.add(rel)
        print(f"[dogtags] {len(matched)}/{wanted} images so far")
    return len(matched), wanted


def sync_images(extracted: Path, res_dir: Path) -> tuple[int, int, int]:
    """Mirror an extracted tree into res_dir, removing stale files.

    Returns (kept, added, removed) file counts relative to the previous
    snapshot.
    """
    wanted = {
        p.relative_to(extracted).as_posix()
        for p in extracted.rglob("*")
        if p.is_file()
    }
    previous = {
        p.relative_to(res_dir).as_posix()
        for p in res_dir.rglob("*")
        if p.is_file()
    } if res_dir.is_dir() else set()

    if res_dir.is_dir():
        shutil.rmtree(res_dir)
    res_dir.mkdir(parents=True)
    for rel in sorted(wanted):
        dest = res_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(extracted / rel, dest)

    added = len(wanted - previous)
    removed = len(previous - wanted)
    return len(wanted), added, removed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gameparams", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--game", required=True)
    ap.add_argument("--out-map", required=True)
    ap.add_argument("--res-dir", required=True)
    args = ap.parse_args()

    gameparams = Path(args.gameparams)
    if not gameparams.is_file():
        raise SystemExit(f"GameParams.json not found: {gameparams}")

    print("[dogtags] building id → index/species map from GameParams ...")
    mapping = build_map(gameparams)
    by_species: dict[str, int] = {}
    for entry in mapping.values():
        by_species[entry[1]] = by_species.get(entry[1], 0) + 1
    print(f"[dogtags] entities: {len(mapping)} {by_species}")
    old_map: dict[str, list[str]] = {}
    out_map = Path(args.out_map)
    if out_map.is_file():
        old_map = json.loads(out_map.read_text(encoding="utf-8"))

    print("[dogtags] slicing part images out of gui_*.pkg ...")
    with tempfile.TemporaryDirectory(prefix="wowsp-dogtags-") as tmp:
        staged = Path(tmp) / "dogtags"
        staged.mkdir(parents=True)
        matched, wanted = extract_images(args.game, Path(args.meta), staged)
        if matched != wanted:
            print(f"[dogtags] warning: matched {matched}/{wanted} wanted images")
        kept, added, removed = sync_images(staged, Path(args.res_dir))
    print(f"[dogtags] images: {kept} files (+{added} -{removed}) at {args.res_dir}")

    # The map goes down only once the images landed, so a crash mid-run can
    # never pair a refreshed map with stale PNGs.
    out_map.parent.mkdir(parents=True, exist_ok=True)
    out_map.write_text(
        json.dumps(mapping, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(
        f"[dogtags] map: {out_map} "
        f"(+{len(mapping.keys() - old_map.keys())} "
        f"-{len(old_map.keys() - mapping.keys())} ids vs previous)"
    )


if __name__ == "__main__":
    main()
