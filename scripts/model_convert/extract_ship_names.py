#!/usr/bin/env python3
"""Extract the complete offline ship-name database for the replay UI.

A replay roster only carries the numeric shipId. Resolving it to a localized
ship name currently requires the WG encyclopedia API, which is unreachable in
offline/mock development and incomplete for event/clone ships. The game
install itself has everything needed:

  - `content/GameParams.data`: numeric id, index (PJSB719), level (tier),
    typeinfo (class/nation) for every ship — dumped to JSON by
    `wowsunpack game-params`.
  - `bin/<latest>/res/texts/<lang>/LC_MESSAGES/global.mo`: gettext catalog
    mapping `IDS_<index>` to the localized display name (53k+ entries).

Output: packages/webui/src/data/ship_names.json
    { "<shipId>": { "index", "tier", "type", "nation",
                    "names": { "<wg-lang-code>": "..." } } }

Usage:
    python scripts/model_convert/extract_ship_names.py
    python scripts/model_convert/extract_ship_names.py --gameparams-json dump.json
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
    / "packages" / "webui" / "src" / "data" / "ship_names.json"
)

# WG API language code -> game's texts/<dir> name.
LANG_DIRS = {
    "en": "en",
    "zh-cn": "zh",
    "zh-sg": "zh_sg",
    "zh-tw": "zh_tw",
    "ja": "ja",
    "ko": "ko",
    "ru": "ru",
    "fr": "fr",
    "es": "es",
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


def prettify_entity_name(entity_name: str) -> str:
    """'PFSC108_Charles_Martel' -> 'Charles Martel' (last-resort name)."""
    parts = entity_name.split("_", 1)
    return parts[1].replace("_", " ") if len(parts) == 2 else entity_name


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract offline ship-name DB")
    parser.add_argument("--game-dir", default=None, help="game install path")
    parser.add_argument(
        "--gameparams-json",
        default=None,
        help="reuse an existing GameParams JSON (skip wowsunpack pass)",
    )
    parser.add_argument("--out", default=str(OUT_PATH), help="output JSON path")
    args = parser.parse_args()

    game = Path(args.game_dir) if args.game_dir else find_game_path()
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
    print(f"[ship-names] reading GameParams: {gp_path}")
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
    print(f"[ship-names] texts from {texts_root}: "
          + ", ".join(f"{c}({len(v)})" for c, v in catalogs.items()))

    # 3. Build the DB.
    db: dict[str, dict] = {}
    for entity_name, entry in gp.items():
        typeinfo = entry.get("typeinfo") or {}
        if typeinfo.get("type") != "Ship":
            continue
        sid = entry.get("id")
        index = entry.get("index")
        if not sid or not index:
            continue
        # Max hull HP across upgrade modules (e.g. A_Hull/B_Hull). This gives
        # a battle-accurate-ish full-HP fallback for ships without an HP
        # stream in a replay; the WG encyclopedia's hull.health is equivalent.
        max_hp: int | None = None
        for key, val in entry.items():
            if key.endswith("_Hull") and isinstance(val, dict):
                hp = val.get("health")
                if isinstance(hp, (int, float)) and hp > 0:
                    max_hp = max(max_hp or 0, int(hp))
        ids_key = f"IDS_{index}"
        names: dict[str, str] = {}
        for code, cat in catalogs.items():
            name = cat.get(ids_key, "").strip()
            if name:
                names[code] = name
        if not names:
            # No translation anywhere — keep the prettified entity name as en.
            names["en"] = prettify_entity_name(entity_name)
        db[str(sid)] = {
            "index": index,
            "tier": entry.get("level"),
            "type": typeinfo.get("species"),
            "nation": (typeinfo.get("nation") or "").lower(),
            "hp": max_hp,
            "names": names,
        }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    missing_en = sum(1 for v in db.values() if "en" not in v["names"])
    print(f"[ship-names] wrote {len(db)} ships -> {out} "
          f"({out.stat().st_size // 1024} KB, {missing_en} without en name)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
