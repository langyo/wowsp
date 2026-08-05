"""Extract official (localized) map names from the game's gettext catalogs.

WoWS ships all display strings as gettext catalogs at
`bin/<build>/res/texts/<lang>/LC_MESSAGES/global.mo`, keyed by
`IDS_SPACES/<SPACE_ID>` (uppercase). This script lists every space in the
game VFS, reads the translated names for the supported languages, and writes
`packages/webui/src/data/map_names.json`:

    {
      "20_NE_two_brothers": { "en": "Two Brothers", "zh-cn": "双峰海峡", ... },
      ...
    }

The frontend falls back to the prettified space id when a language is
missing. Run `wowsunpack list` on the spaces root to discover the ids.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from _common import find_game_path  # noqa: E402
from extract_ship_names import LANG_DIRS, latest_bin_dir, load_mo  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "packages" / "webui" / "src" / "data" / "map_names.json"


def list_spaces(game: str, wowsunpack: Path) -> list[str]:
    """Space ids from the VFS `spaces/` root (each is a directory)."""
    out = subprocess.run(
        [str(wowsunpack), "-g", game, "list"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stdout
    ids: set[str] = set()
    for ln in out.splitlines():
        m = re.match(r"\(D\) /spaces/([0-9A-Za-z_]+)/?$", ln.strip())
        if m:
            ids.add(m.group(1))
    # Also accept entries the listing reports as files-at-root (some builds
    # print the dir once as (D) and again under assets).
    return sorted(ids)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--game-dir", default=None)
    args = ap.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print("error: game install not found", file=sys.stderr)
        return 1
    wowsunpack = REPO_ROOT / "target" / "release" / "wowsunpack.exe"
    if not wowsunpack.exists():
        print(f"error: {wowsunpack} missing — build the patched wowsunpack", file=sys.stderr)
        return 1

    spaces = list_spaces(game, wowsunpack)
    print(f"[map-names] {len(spaces)} spaces")

    bin_dir = latest_bin_dir(Path(game))
    if bin_dir is None:
        print("error: no bin/<build> dir", file=sys.stderr)
        return 1
    texts_root = bin_dir / "res" / "texts"
    catalogs: dict[str, dict[str, str]] = {}
    for code, dirname in LANG_DIRS.items():
        mo = texts_root / dirname / "LC_MESSAGES" / "global.mo"
        if mo.exists():
            catalogs[code] = load_mo(mo)
    print("[map-names] catalogs: " + ", ".join(f"{c}({len(v)})" for c, v in catalogs.items()))

    db: dict[str, dict[str, str]] = {}
    missing: list[str] = []
    for sid in spaces:
        key = f"IDS_SPACES/{sid.upper()}"
        names: dict[str, str] = {}
        for code, cat in catalogs.items():
            val = cat.get(key, "").strip()
            if val and val != key:
                names[code] = val
        if not names:
            missing.append(sid)
            # Keep the prettified id so the frontend never shows a raw slug.
            names["en"] = sid.replace("_", " ").title()
        db[sid] = names

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8",
    )
    print(f"[map-names] wrote {len(db)} maps -> {args.out} "
          f"({args.out.stat().st_size // 1024} KB, {len(missing)} untranslated)")
    for sid in missing[:5]:
        print(f"  no translation: {sid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
