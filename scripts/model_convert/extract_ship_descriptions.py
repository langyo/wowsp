#!/usr/bin/env python3
"""Extract the offline ship-description database for the replay/UI overlay.

The WG encyclopedia API serves the SAME simplified-Chinese ship description
on every realm: the harmonized CN translation where IJN ships are renamed to
animals (Yamato = 鲸). The realm-distinct texts — the 国服 zoo flavor AND the
亚服 formal 简体/繁體 wording — live only in the game client's gettext
catalogs, exactly like the localized ship names (see extract_ship_names.py).
This script bakes them so the webui can overlay descriptions per selected
data language, the same way localizeShips overlays names.

Sources (same layout as extract_ship_names.py):

  - `content/GameParams.data` (dumped to JSON): numeric id + index (PJSB018)
    for every ship; descriptions are msgid `IDS_<index>_DESCR`.
  - `bin/<latest>/res/texts/<lang>/LC_MESSAGES/global.mo`: the catalogs.
    Only the Chinese trio is extracted here — every other language already
    arrives correctly from the WG API, so shipping it would only bloat the
    bundle.

Output: packages/webui/src/data/ship_descriptions.json
    { "<shipId>": { "descriptions": { "<lang>": "..." } } }
    Ships with no non-empty description in ANY of the three catalogs are
    omitted entirely (the caller then keeps the WG API text).

Usage:
    python scripts/model_convert/extract_ship_descriptions.py
    python scripts/model_convert/extract_ship_descriptions.py --gameparams-json dump.json
        (reuse an existing GameParams JSON instead of the slow wowsunpack pass)
"""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path, find_wowsunpack  # noqa: E402

OUT_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages" / "webui" / "src" / "data" / "ship_descriptions.json"
)

# Canonical BCP 47 lang-loc (output key) -> game's texts/<dir> name.
# Chinese trio only: these are the realms the WG API cannot distinguish.
LANG_DIRS = {
    "zh-CN": "zh",
    "zh-SG": "zh_sg",
    "zh-TW": "zh_tw",
}


def load_mo(path: Path) -> dict[str, str]:
    """Parse a gettext .mo (little-endian) into a {msgid: msgstr} dict."""
    data = path.read_bytes()
    if len(data) < 28 or struct.unpack("<I", data[:4])[0] != 0x950412DE:
        return {}
    _, n, off_o, off_t, _, _ = struct.unpack("<6I", data[4:28])
    out: dict[str, str] = {}
    for i in range(n):
        ol, oo = struct.unpack("<2I", data[off_o + i * 8: off_o + i * 8 + 8])
        tl, to = struct.unpack("<2I", data[off_t + i * 8: off_t + i * 8 + 8])
        msgid = data[oo: oo + ol].decode("utf-8", errors="replace")
        msgstr = data[to: to + tl].decode("utf-8", errors="replace")
        out[msgid] = msgstr
    return out


def latest_bin_dir(game: Path) -> Path | None:
    bin_root = game / "bin"
    if not bin_root.is_dir():
        return None
    builds = [p for p in bin_root.iterdir() if p.is_dir() and p.name.isdigit()]
    return max(builds, key=lambda p: int(p.name)) if builds else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract offline ship-description DB")
    parser.add_argument("--game-dir", default=None, help="game install path")
    parser.add_argument(
        "--gameparams-json",
        default=None,
        help="reuse an existing GameParams JSON (skip wowsunpack pass)",
    )
    parser.add_argument("--out", default=str(OUT_PATH), help="output JSON path")
    args = parser.parse_args()

    game = Path(args.game_dir) if args.game_dir else Path(find_game_path() or "")
    if not game:
        print("error: game install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    # 1. GameParams JSON.
    if args.gameparams_json:
        gp_path = Path(args.gameparams_json)
    else:
        wowsunpack = find_wowsunpack()
        if not wowsunpack:
            print("error: wowsunpack not found.", file=sys.stderr)
            return 1
        tmp = tempfile.mkdtemp(prefix="wowsp_gp_")
        gp_path = Path(tmp) / "gameparams.json"
        rc = subprocess.call(
            [str(wowsunpack), "--game-dir", str(game), "game-params", str(gp_path)]
        )
        if rc != 0:
            print(f"error: wowsunpack game-params failed (rc={rc})", file=sys.stderr)
            return rc
    print(f"[ship-desc] reading GameParams: {gp_path}")
    gp = json.loads(gp_path.read_text(encoding="utf-8"))

    # 2. Localization catalogs.
    bin_dir = latest_bin_dir(game)
    if bin_dir is None:
        print(f"error: no bin/<build> dir under {game}", file=sys.stderr)
        return 1
    texts_root = bin_dir / "res" / "texts"
    catalogs: dict[str, dict[str, str]] = {}
    for code, dirname in LANG_DIRS.items():
        mo = texts_root / dirname / "LC_MESSAGES" / "global.mo"
        if mo.exists():
            catalogs[code] = load_mo(mo)
    print(f"[ship-desc] texts from {texts_root}: "
          + ", ".join(f"{c}({len(v)})" for c, v in catalogs.items()))

    # 3. Build the DB: every Ship entry -> {lang: IDS_<index>_DESCR} where the
    # catalog carries a non-empty stripped string. Ships with nothing in any
    # language are skipped so the caller's WG-API description stays in charge.
    db: dict[str, dict] = {}
    total_ships = 0
    coverage = {code: 0 for code in catalogs}
    for _, entry in gp.items():
        typeinfo = entry.get("typeinfo") or {}
        if typeinfo.get("type") != "Ship":
            continue
        total_ships += 1
        sid = entry.get("id")
        index = entry.get("index")
        if not sid or not index:
            continue
        descr_key = f"IDS_{index}_DESCR"
        descriptions: dict[str, str] = {}
        for code, cat in catalogs.items():
            text = cat.get(descr_key, "").strip()
            if text:
                descriptions[code] = text
                coverage[code] += 1
        if descriptions:
            db[str(sid)] = {"descriptions": descriptions}

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    per_lang = ", ".join(f"{c}={n}" for c, n in coverage.items())
    print(f"[ship-desc] {total_ships} ships scanned, kept {len(db)} with text "
          f"({per_lang}); wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
