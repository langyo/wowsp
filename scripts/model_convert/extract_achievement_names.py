"""Extract battle-achievement display names from GameParams + gettext catalogs.

Produces packages/webui/src/data/achievement_names.json:

    { "4277330864": { "key": "PCH016_FirstBlood", "type": "honorable",
                      "names": { "zh-CN": "第一滴血", "en-US": "First Blood", ... } }, ... }

Keys are the raw `onAchievementEarned` / battle-results achievement ids (u32,
GameParams Achievement entry ids). The same achievement ships as multiple
template variants with distinct ids (per ship-category sets), so every variant
id gets its own entry — the names resolve via the shared `uiName` key
(`IDS_ACHIEVEMENT_<uiName>` in global.mo).

GameParams scanning streams the dump with a fixed signature anchor
(`"type":"Achievement"}` in the typeinfo block) plus brace matching, instead of
json.load-ing the whole multi-GB dump. Run with `--gameparams-json` to reuse an
existing dump (see `extract_ship_names.py` for the wowsunpack pass).
"""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
from _common import find_wowsunpack  # noqa: E402
from extract_ship_names import (  # noqa: E402
    LANG_DIRS,
    find_game_path,
    latest_bin_dir,
    load_mo,
)

OUT = REPO_ROOT / "packages" / "webui" / "src" / "data" / "achievement_names.json"

# The typeinfo block is uniform for achievements ("nation":"Common" etc.), but
# anchoring on just the type+close-brace keeps the scanner shape-agnostic.
ACHIEVEMENT_ANCHOR = re.compile(r'"type"\s*:\s*"Achievement"\s*\}')


def iter_achievement_entries(gp_text: str):
    """Yield each Achievement-typed entry object parsed from the dump."""
    for anchor in ACHIEVEMENT_ANCHOR.finditer(gp_text):
        # Walk backwards from the typeinfo's own open brace to the entry's.
        typeinfo_open = gp_text.rfind("{", 0, anchor.start())
        depth = 0
        start = typeinfo_open - 1
        while start >= 0:
            ch = gp_text[start]
            if ch == "}":
                depth += 1
            elif ch == "{":
                if depth == 0:
                    break
                depth -= 1
            start -= 1
        # Match the entry object forwards so json.loads sees complete JSON.
        depth = 0
        end = start
        while end < len(gp_text):
            ch = gp_text[end]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    break
            end += 1
        yield json.loads(gp_text[start : end + 1])


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract achievement name DB")
    parser.add_argument("--game-dir", default=None, help="game install path")
    parser.add_argument(
        "--gameparams-json",
        default=None,
        help="reuse an existing GameParams JSON (skip wowsunpack pass)",
    )
    parser.add_argument("--out", default=str(OUT), help="output JSON path")
    args = parser.parse_args()

    game = Path(args.game_dir) if args.game_dir else Path(find_game_path() or "")
    if not game.is_dir():
        print("error: game not found", file=sys.stderr)
        return 1

    # 1. GameParams JSON (full dump — achievements are a tiny fraction of it).
    if args.gameparams_json:
        gp_path = Path(args.gameparams_json)
    else:
        wowsunpack = find_wowsunpack()
        if not wowsunpack:
            print("error: wowsunpack not found.", file=sys.stderr)
            return 1
        tmp = tempfile.mkdtemp(prefix="wowsp_gp_")
        gp_path = Path(tmp) / "gameparams.json"
        import subprocess

        rc = subprocess.call(
            [str(wowsunpack), "--game-dir", str(game), "game-params", str(gp_path)]
        )
        if rc != 0:
            print(f"error: wowsunpack game-params failed (rc={rc})", file=sys.stderr)
            return rc
    print(f"[achievement-names] scanning GameParams: {gp_path}", flush=True)
    gp_text = gp_path.read_text(encoding="utf-8")

    # 2. Localization catalogs.
    bin_dir = latest_bin_dir(game)
    if bin_dir is None:
        print(f"error: no bin/<build> dir under {game}", file=sys.stderr)
        return 1
    catalogs: dict[str, dict[str, str]] = {}
    for code, dirname in LANG_DIRS.items():
        mo = bin_dir / "res" / "texts" / dirname / "LC_MESSAGES" / "global.mo"
        if mo.exists():
            catalogs[code] = load_mo(mo)
    print(
        "[achievement-names] texts: "
        + ", ".join(f"{c}({len(v)})" for c, v in catalogs.items())
    )

    # 3. Build the DB: one entry per achievement id variant.
    db: dict[str, dict] = {}
    for entry in iter_achievement_entries(gp_text):
        ach_id = entry.get("id")
        ui_name = entry.get("uiName")
        if not isinstance(ach_id, int) or not ui_name:
            continue
        names: dict[str, str] = {}
        for code, cat in catalogs.items():
            name = cat.get(f"IDS_ACHIEVEMENT_{ui_name}", "").strip()
            if name:
                names[code] = name
        db[str(ach_id)] = {
            "key": entry.get("name") or "",
            "type": entry.get("uiType") or "",
            "names": names,
        }
    print(f"[achievement-names] {len(db)} achievement ids")

    unnamed = sum(1 for v in db.values() if not v["names"])
    if unnamed:
        print(f"[achievement-names] warning: {unnamed} ids have no translation")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[achievement-names] wrote {len(db)} ids -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
