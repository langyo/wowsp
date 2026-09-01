#!/usr/bin/env python3
"""Extract the offline nation-name DB for the UI nation labels.

The WG API only returns nation *codes* ("japan", "usa", ...). The display
names come from the game client's own gettext catalogs, keyed by
`IDS_DOGTAGS_EMBLEM_NATIONS_SUBGROUP_<NATION>` — the same short faction
labels the port UI uses. This matters most for the harmonized 国服 (zh)
catalog, where nations carry the CN-only X-系 names (M系/R系/D系/...)
instead of regular country names, so a hardcoded per-locale country list
can never reproduce what the selected 素材翻译 actually shows in game.

Output: packages/webui/src/data/nation_names.json
    { "<canonical lang-loc>": { "<nation code>": "<display name>" } }

Usage:
    python scripts/model_convert/extract_nation_names.py
    python scripts/model_convert/extract_nation_names.py --game-dir <path>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import find_game_path  # noqa: E402
from extract_ship_names import LANG_DIRS, latest_bin_dir, load_mo  # noqa: E402

OUT_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages" / "webui" / "src" / "data" / "nation_names.json"
)

# WG nation code (encyclopedia API + GameParams typeinfo) → msgid suffix
# under IDS_DOGTAGS_EMBLEM_NATIONS_SUBGROUP_*. Both API spellings (uk/ussr)
# and GameParams spellings (united_kingdom/russia) are listed so either
# convention resolves. Codes without a catalog entry (poland, sweden) are
# skipped and fall back to the app's own i18n strings at runtime.
NATION_KEYS = {
    "japan": "JAPAN",
    "usa": "USA",
    "ussr": "RUSSIA",
    "russia": "RUSSIA",
    "germany": "GERMANY",
    "uk": "UNITED_KINGDOM",
    "united_kingdom": "UNITED_KINGDOM",
    "france": "FRANCE",
    "italy": "ITALY",
    "netherlands": "NETHERLANDS",
    "spain": "SPAIN",
    "pan_asia": "PANASIA",
    "pan_america": "PANAMERICA",
    "commonwealth": "COMMONWEALTH",
    "europe": "EUROPE",
    "pan_europe": "EUROPE",
    "poland": "POLAND",
    "sweden": "SWEDEN",
}

MSGID_PREFIX = "IDS_DOGTAGS_EMBLEM_NATIONS_SUBGROUP_"


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract offline nation-name DB")
    parser.add_argument("--game-dir", default=None, help="game install path")
    parser.add_argument("--out", default=str(OUT_PATH), help="output JSON path")
    args = parser.parse_args()

    game = Path(args.game_dir) if args.game_dir else Path(find_game_path() or "")
    if not game:
        print("error: game install not found. Set WOWSP_GAME_PATH.", file=sys.stderr)
        return 1

    bin_dir = latest_bin_dir(game)
    if bin_dir is None:
        print(f"error: no bin/<build> dir under {game}", file=sys.stderr)
        return 1
    texts_root = bin_dir / "res" / "texts"

    db: dict[str, dict[str, str]] = {}
    for code, dirname in LANG_DIRS.items():
        mo = texts_root / dirname / "LC_MESSAGES" / "global.mo"
        if not mo.exists():
            print(f"[nation-names] warn: no catalog for {code} ({mo})")
            continue
        cat = load_mo(mo)
        names: dict[str, str] = {}
        for nation, suffix in NATION_KEYS.items():
            value = cat.get(MSGID_PREFIX + suffix, "").strip()
            if value:
                names[nation] = value
        if names:
            db[code] = names
    print("[nation-names] languages: "
          + ", ".join(f"{c}({len(v)})" for c, v in sorted(db.items())))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(db, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    print(f"[nation-names] wrote {sum(len(v) for v in db.values())} labels "
          f"-> {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
