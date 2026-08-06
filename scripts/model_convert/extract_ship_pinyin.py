"""Generate pinyin search data for ship names.

Outputs (into packages/webui/src/data/):
  - char_pinyin.json : { char: first-tone pinyin } for every CJK char used in
    any ship name (zh-CN / zh-SG / zh-TW), for query-side conversion.
  - ship_pinyin.json : { shipId: { zh, pinyin, initials } } per ship, for
    near-sound matching (e.g. "boge" -> 博格, "bg" -> 博格).

Consumed by packages/webui/src/features/search/pinyinSearch.ts.
"""

import json
import sys
from pathlib import Path

from pypinyin import Style, lazy_pinyin

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"

SHIP_NAMES = DATA_DIR / "ship_names.json"
CHAR_OUT = DATA_DIR / "char_pinyin.json"
SHIP_OUT = DATA_DIR / "ship_pinyin.json"


def main() -> int:
    ships = json.loads(SHIP_NAMES.read_text(encoding="utf-8"))
    char_pinyin: dict[str, str] = {}
    ship_pinyin: dict[str, dict] = {}
    for sid, entry in ships.items():
        names = entry.get("names") or {}
        zh = next(
            (v for k in ("zh-CN", "zh-SG", "zh-TW") if (v := names.get(k))),
            "",
        )
        if not zh:
            continue
        py = "".join(lazy_pinyin(zh))
        initials = "".join(lazy_pinyin(zh, style=Style.FIRST_LETTER)) if zh else ""
        for ch in zh:
            if "\u4e00" <= ch <= "\u9fff" and ch not in char_pinyin:
                char_pinyin[ch] = lazy_pinyin(ch)[0]
        ship_pinyin[str(sid)] = {"zh": zh, "pinyin": py, "initials": initials}

    CHAR_OUT.write_text(
        json.dumps(char_pinyin, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    SHIP_OUT.write_text(
        json.dumps(ship_pinyin, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"[ship-pinyin] chars={len(char_pinyin)} ships={len(ship_pinyin)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
