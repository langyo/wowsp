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
missing. Run `game-assets list` on the spaces root to discover the ids.

Entries in `map_names_curated.json` override the catalogs (priority:
curated > game texts > prettified id) — the Lesta-only spaces carry
Russian-only catalog names, so their remaining locales are curated by
hand and survive every future extraction pass.
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

from _common import find_game_assets, find_game_path  # noqa: E402
from extract_ship_names import LANG_DIRS, latest_bin_dir, load_mo  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "packages" / "webui" / "src" / "data" / "map_names.json"
CURATED_PATH = SCRIPT_DIR / "map_names_curated.json"


def list_spaces(game: str, game_assets: Path) -> list[str]:
    """Space ids from the VFS `spaces/` root (each is a directory)."""
    out = subprocess.run(
        [str(game_assets), "-g", game, "list"],
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
    ap.add_argument(
        "--curated",
        default=str(CURATED_PATH),
        help="{ space id: { langLoc: name } } hand-curated overrides",
    )
    ap.add_argument("--merge", action="store_true",
                    help="keep existing entries in --out untouched and only "
                         "add ids the current install carries that are "
                         "missing — the Lesta follow-up pass (shared ids "
                         "keep their WG translations; without the flag the "
                         "file is regenerated from this install alone)")
    args = ap.parse_args()

    game = args.game_dir or find_game_path()
    if not game:
        print("error: game install not found", file=sys.stderr)
        return 1
    game_assets = Path(find_game_assets() or "")
    if not game_assets.is_file():
        print("error: game-assets not found — build it (just build game-assets) "
              "or set WOWSP_GAME_ASSETS", file=sys.stderr)
        return 1

    spaces = list_spaces(game, game_assets)
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

    if args.merge and args.out.exists():
        # --merge: existing entries are authoritative (the WG pass wrote
        # them); this run only fills ids the file does not know yet.
        existing = json.loads(args.out.read_text(encoding="utf-8"))
        added = [sid for sid in db if sid not in existing]
        db = {**db, **existing}
        print(f"[map-names] merge: kept {len(existing)} existing, "
              f"added {len(added)} new"
              + (f" ({', '.join(added[:8])}{'…' if len(added) > 8 else ''})"
                 if added else ""))

    # Curated overrides win over everything this run extracted (both the
    # fresh WG pass and the --merge Lesta pass — the merge deliberately
    # keeps existing entries untouched, so the override lands on top).
    curated_file = Path(args.curated)
    curated: dict[str, dict[str, str]] = (
        json.loads(curated_file.read_text(encoding="utf-8"))
        if curated_file.exists() else {}
    )
    applied, absent = 0, []
    for sid, names in curated.items():
        if sid.startswith("_"):
            continue
        if sid not in db:
            absent.append(sid)
            continue
        db[sid].update({code: name for code, name in names.items() if name})
        applied += 1
    print(f"[map-names] curated overrides: {applied} applied from "
          f"{curated_file.name}"
          + (f", {len(absent)} not in this install ({', '.join(absent)})"
             if absent else ""))

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
