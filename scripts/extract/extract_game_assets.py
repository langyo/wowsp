"""Extract game GUI assets (nation flags, skill icons) from the WoWS .pkg blob.

wowsunpack 0.43.0's `extract` subcommand is broken on this Steam install
("Wrote 0 files" / pkg loader unavailable), and its `metadata` command works
but doesn't expose per-file offsets. However:
  - the gui_*.pkg is a flat concatenation of uncompressed resource blobs
    (PNG files appear verbatim with their `\x89PNG` signature),
  - wowsunpack's `metadata --format json` lists every path with its exact
    uncompressed size.

So we scan the .pkg for PNG signatures, slice each by reading the IEND chunk
end, and match each extracted PNG to a known metadata entry by its byte size
(which is unique per file in practice for the small asset classes we need:
faction flags and crew-skill icons). This avoids reverse-engineering the
.idx's directory tree.

Run wowsunpack's metadata once to produce the path→size map, then this script
slices the pkg and renames by size.

Usage:
    python extract_game_assets.py \
        --pkg "D:\\Steam\\...\\res_packages\\gui_0001.pkg" \
        --meta "%LOCALAPPDATA%\\Temp\\wows_meta.json" \
        --prefix "/gui/nation_flag_tree/" --prefix "/gui/crew_commander/skills/" \
        --out packages/webui/src/res/images/nations --webp --rename-by nation_map
"""
from __future__ import annotations

import argparse
import io
import json
import struct
from pathlib import Path


PNG_SIG = b"\x89PNG\r\n\x1a\n"
IEND = b"IEND"


def slice_pngs(pkg_data: bytes):
    """Yield (offset, png_bytes) for every PNG blob in the concatenated pkg."""
    search = 0
    while True:
        start = pkg_data.find(PNG_SIG, search)
        if start < 0:
            return
        # PNG = 8 sig + chunks; each chunk = length(4 BE) + type(4) + data + crc(4).
        # Walk chunks until IEND to find the blob end.
        cur = start + 8
        end = None
        while cur + 8 <= len(pkg_data):
            length = struct.unpack_from(">I", pkg_data, cur)[0]
            ctype = pkg_data[cur + 4:cur + 8]
            cur += 8 + length + 4  # data + crc
            if ctype == IEND:
                end = cur
                break
        if end is None:
            search = start + 1
            continue
        yield start, pkg_data[start:end]
        search = end


def png_to_webp(png_bytes: bytes) -> bytes:
    from PIL import Image
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True, quality=90, method=6)
    return buf.getvalue()


# WG faction crest names → our nation code (WG encyclopedia `nation` field).
NATION_CODE_MAP = {
    "USA": "usa",
    "Japan": "japan",
    "Russia": "ussr",
    "Germany": "germany",
    "United_Kingdom": "uk",
    "France": "france",
    "Italy": "italy",
    "Netherlands": "netherlands",
    "Spain": "spain",
    "Pan_America": "pan_america",
    "Pan_Asia": "pan_asia",
    "Commonwealth": "commonwealth",
    "Europe": "pan_europe",  # the in-game "Europe" crest = our pan_europe slot
    "Poland": "pan_europe",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", required=True)
    ap.add_argument("--meta", required=True, help="wowsunpack metadata --format json output")
    ap.add_argument("--prefix", action="append", default=[], help="metadata path prefix(s) to keep")
    ap.add_argument("--out", required=True)
    ap.add_argument("--webp", action="store_true")
    ap.add_argument("--as-nation-flags", action="store_true",
                    help="rename faction-crest PNGs to our nation codes")
    args = ap.parse_args()

    meta = json.loads(Path(args.meta).read_text())
    # size → list of paths (paths are unique per size for our target classes)
    size_to_paths: dict[int, list[str]] = {}
    keep_prefixes = tuple(args.prefix)
    for e in meta:
        p = e["path"]
        if keep_prefixes and not p.startswith(keep_prefixes):
            continue
        if e.get("is_directory"):
            continue
        sz = e["unpacked_size"]
        size_to_paths.setdefault(sz, []).append(p)
    print(f"[extract] {sum(len(v) for v in size_to_paths.values())} target entries "
          f"({len(size_to_paths)} distinct sizes)")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pkg = Path(args.pkg).read_bytes()
    print(f"[extract] scanning {len(pkg) >> 20} MB pkg for PNGs...")

    written = 0
    for offset, png in slice_pngs(pkg):
        paths = size_to_paths.get(len(png))
        if not paths:
            continue
        for path in paths:
            name = path.rsplit("/", 1)[-1]
            stem = name[:-4] if name.endswith(".png") else name
            # `/gui/nation_flag_tree/USA.png`   → stem "USA"
            # `/gui/nation_flags/small/flag_USA.png` → stem "flag_USA"
            # Strip the leading "flag_" so both resolve via NATION_CODE_MAP.
            if stem.startswith("flag_"):
                stem = stem[len("flag_"):]
            if args.as_nation_flags:
                code = NATION_CODE_MAP.get(stem)
                if not code:
                    continue
                rel = f"{code}.webp" if args.webp else f"{code}.png"
            else:
                rel = path.lstrip("/")
                if args.webp and rel.endswith(".png"):
                    rel = rel[:-4] + ".webp"
            dest = out / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            blob = png_to_webp(png) if args.webp else png
            dest.write_bytes(blob)
            written += 1
            print(f"[extract] {path} → {dest.relative_to(out)} ({len(blob)} B)")
    print(f"[extract] wrote {written} files to {out}")


if __name__ == "__main__":
    main()
