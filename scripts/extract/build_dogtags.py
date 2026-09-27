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
  3. Glossary backfill — entities whose textures never ship in the pkgs
     come out as the game's 80x80 solid-white stand-ins (they rendered as
     blank-white medals in the app). The glossary GraphQL backing
     profile.wowsgame.cn serves the complete icon set as content-addressed
     CDN URLs; the backfill swaps every placeholder-sized part for that
     art (medium 190x190 — same artwork as the small parts; the badge CSS
     scales). Parts the CDN also only knows as a white tile are left at
     their stand-ins so a later run can retry once art exists. Best-effort
     and idempotent: unreachable network keeps the placeholders too.

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
import gzip
import json
import shutil
import struct
import tempfile
import urllib.request
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

# A real dog-tag part never compresses anywhere near this small (the
# tiniest official symbol is ~600 B; typical parts are 3–30 KB). The game
# stages an 80x80 solid-white stand-in (~224–298 B) for entities whose
# textures never ship in the gui pkgs, which is what this threshold hunts.
PLACEHOLDER_MAX_BYTES = 512

# The glossary GraphQL backing profile.wowsgame.cn serves every DogTag
# component's icon as a content-addressed CDN URL — the complete set,
# including the art the client pkgs never carry. Lang is cosmetic for
# icons; zh-cn matches the CN host this defaults to.
GLOSSARY_HOST_DEFAULT = "vortex.wowsgame.cn"
GLOSSARY_QUERY = """
  query getGlossData($lang: String) {
    dogTagComponents(lang: $lang) {
      id
      icons {
        medium
      }
    }
  }
"""
# The CN hosts apply a basic browser check; a plain urllib UA risks
# rejection or, on the CDN, surprise gzip responses.
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/125.0.0.0 Safari/537.36")


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


# ── glossary backfill ──────────────────────────────────────────────────────

def _glossary_fetch(url: str) -> bytes:
    """One CDN GET with the browser UA the CN hosts require."""
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _is_flat_png(data: bytes) -> bool:
    """True when the decoded image is a single solid colour — the white
    stand-in tile signature. Defilters scanlines rolling (PNG filters
    reference the previous row) and compares each against the first,
    exiting on the first difference, so real art costs two rows. Malformed
    input counts as flat (callers treat that as "no art")."""
    width = height = bit_depth = color_type = None
    idat = b""
    pos = 8
    while pos + 8 <= len(data):
        length, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            try:
                width, height, bit_depth, color_type = struct.unpack(
                    ">IIBB", chunk[:10])
            except struct.error:  # truncated IHDR — malformed counts as flat
                return True
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
    if not width or not height or bit_depth != 8 or color_type is None:
        return True
    try:
        raw = zlib.decompress(idat)
    except zlib.error:
        return True
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if not channels:
        return True
    stride = width * channels
    row_len = 1 + stride
    if len(raw) < row_len * height:
        return True

    def defilter(ftype: int, line: bytearray, prev: bytes) -> None:
        if ftype == 0:
            return
        if ftype == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                # RFC 2083: p = a + b - c, then distance of p to each.
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                guess = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + guess) & 0xFF
        else:
            raise ValueError(f"bad filter type {ftype}")

    first = bytearray(stride)
    prev = bytes(stride)
    for y in range(height):
        offset = y * row_len
        ftype = raw[offset]
        line = bytearray(raw[offset + 1:offset + row_len])
        try:
            defilter(ftype, line, prev)
        except ValueError:
            return True
        if y == 0:
            first = line
        elif line != first:
            return False
        prev = bytes(line)
    return True


def _http_json(url: str) -> dict:
    """POST the glossary query and decode the JSON, transparently handling
    the gzip the CN CDN occasionally answers a browser-UA request with
    (urllib never advertises Accept-Encoding, so it is not automatic)."""
    body = json.dumps({
        "query": GLOSSARY_QUERY,
        "variables": {"lang": "zh-cn"},
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": BROWSER_UA},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def glossary_icon_urls(host: str) -> dict[str, str]:
    """Index (e.g. `PCNP162`) → absolute `icons.medium` CDN URL for every
    DogTag component the glossary knows. Medium (190x190) carries the same
    artwork as the 80x80 small parts the pkgs ship — the badge CSS scales
    the canvas, so substituting one for the other renders identically."""
    data = _http_json(f"https://{host}/api/graphql/glossary/")
    urls: dict[str, str] = {}
    for comp in (data.get("data") or {}).get("dogTagComponents") or []:
        url = (comp.get("icons") or {}).get("medium") or ""
        # …/dog_tags/medium/PCNP162_<sha256>.png — the hash pins the exact
        # bytes, so re-downloads of unchanged art stay byte-identical (the
        # skip itself comes from the placeholder-size predicate).
        name = url.rsplit("/", 1)[-1]
        if "_" not in name:
            continue
        index = name.split("_", 1)[0]
        urls.setdefault(index, "https:" + url if url.startswith("//") else url)
    return urls


def backfill_placeholder_art(res_dir: Path, host: str) -> list[str]:
    """Replace white stand-in PNGs with the official glossary art.

    Some DogTag entities exist in GameParams but their textures never ship
    in the client's gui pkgs (CN-collab patches and friends): the slicer
    then matches the game's own blank 80x80 white stand-in, and the app
    renders a white square where the medal should be. The glossary CDN
    carries the real art for exactly those ids. Best-effort: network
    failures leave the placeholders in place (the next run retries)."""
    blanks = sorted(
        p for p in res_dir.rglob("*.png")
        if p.stat().st_size <= PLACEHOLDER_MAX_BYTES
    )
    if not blanks:
        return []
    print(f"[dogtags] {len(blanks)} placeholder-sized parts, querying the "
          f"glossary for real art ...")
    try:
        urls = glossary_icon_urls(host)
    except Exception as exc:  # noqa: BLE001 — best-effort by contract
        print(f"[dogtags] warning: glossary unreachable ({exc}); "
              f"placeholders kept")
        return []
    replaced: list[str] = []
    for path in blanks:
        url = urls.get(path.stem)
        if not url:
            print(f"[dogtags] no glossary art for {path.name}; placeholder kept")
            continue
        try:
            art = _glossary_fetch(url)
        except Exception as exc:  # noqa: BLE001 — best-effort by contract
            print(f"[dogtags] warning: {path.name} fetch failed ({exc}); "
                  f"placeholder kept")
            continue
        if not art.startswith(b"\x89PNG") or _is_flat_png(art):
            # A flat (single-colour) answer means the CDN itself has no art
            # for this id yet — keep the stand-in so a later run retries
            # instead of pinning a white tile above the size threshold.
            print(f"[dogtags] {path.name}: glossary serves no real art; "
                  f"placeholder kept")
            continue
        path.write_bytes(art)
        replaced.append(path.name)
    if replaced:
        print(f"[dogtags] backfilled {len(replaced)} parts from the "
              f"glossary: {', '.join(replaced)}")
    return replaced


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gameparams", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--game", required=True)
    ap.add_argument("--out-map", required=True)
    ap.add_argument("--res-dir", required=True)
    ap.add_argument("--glossary-host", default=GLOSSARY_HOST_DEFAULT,
                    help="glossary GraphQL host used to backfill placeholder "
                         f"art (default: {GLOSSARY_HOST_DEFAULT})")
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

    # Textures the pkgs never carry come out as the game's white stand-ins;
    # swap them for the glossary art before the snapshot is declared done.
    backfill_placeholder_art(Path(args.res_dir), args.glossary_host)

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
