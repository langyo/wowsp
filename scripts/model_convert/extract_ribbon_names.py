"""Extract ribbon display names from the game gettext catalogs.

Produces packages/webui/src/data/ribbon_names.json:
  { "RIBBON_MAIN_CALIBER": { "zh-CN": "主炮命中", "en-US": "Main Caliber Hit", ... }, ... }
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
from extract_ship_names import LANG_DIRS, latest_bin_dir, load_mo, find_game_path  # noqa: E402

OUT = REPO_ROOT / "packages" / "webui" / "src" / "data" / "ribbon_names.json"


def main() -> int:
    game = Path(find_game_path() or "")
    if not game.is_dir():
        print("error: game not found", file=sys.stderr)
        return 1
    bin_dir = latest_bin_dir(game)
    if bin_dir is None:
        print("error: no bin dir", file=sys.stderr)
        return 1
    texts = bin_dir / "res" / "texts"
    catalogs = {}
    for code, dirname in LANG_DIRS.items():
        mo = texts / dirname / "LC_MESSAGES" / "global.mo"
        if mo.exists():
            catalogs[code] = load_mo(mo)

    db = {}
    for code, cat in catalogs.items():
        for k, v in cat.items():
            if k.startswith("IDS_RIBBON_RIBBON_") and not k.endswith("_DESCRIPTION") and v.strip():
                key = k[len("IDS_RIBBON_"):]
                db.setdefault(key, {})[code] = v.strip()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[ribbon-names] wrote {len(db)} ribbons -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
