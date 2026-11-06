#!/usr/bin/env python3
"""Extract ribbon display names from the game gettext catalogs.

Produces packages/webui/src/data/ribbon_names.json:

    { "main_caliber": { "zh-CN": "主炮命中", "en-US": "Main Caliber Hit", ... }, ... }

Keys are the frontend's ribbon-kind vocabulary — lower-case snake_case, the
same ids the post-battle panel (features/replay/postBattle.ts RIBBON_SOURCES)
and the ribbon icon map (features/holographic/ribbonIcons.ts) pass into this
table. The catalogs spell the battle-results ribbons IDS_RIBBON_RIBBON_<KEY>;
the <KEY> part is lower-cased here.

The committed table also serves keys a current build has dropped (the manual
counter names main_caliber_shots / hits / aa_hits / salvos / plane_losses /
shells, still referenced by the post-battle panel and the ribbon icon map for
OLDER replays). Entries are therefore MERGED: the catalog wins for the keys it
carries today, entries the current client no longer provides keep their last
committed translations instead of vanishing.
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
from extract_ship_names import LANG_DIRS, latest_bin_dir, load_mo, find_game_path  # noqa: E402

OUT = REPO_ROOT / "packages/webui/src/data/ribbon_names.json"

# The battle-results ribbon ids. Earlier catalog generations spelled the
# same keys as IDS_RIBBON_<KEY>; a build like that simply yields no generated
# keys and the merge below keeps every committed entry intact.
CATALOG_PREFIX = "IDS_RIBBON_RIBBON_"


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

    generated: dict[str, dict[str, str]] = {}
    for code, cat in catalogs.items():
        for k, v in cat.items():
            if not v.strip() or k.endswith("_DESCRIPTION"):
                continue
            if k.startswith(CATALOG_PREFIX):
                key = k[len(CATALOG_PREFIX):].lower()
                generated.setdefault(key, {})[code] = v.strip()

    existing: dict[str, dict[str, str]] = {}
    if OUT.is_file():
        try:
            existing = json.loads(OUT.read_text(encoding="utf-8"))
        except ValueError:
            print(f"warning: unreadable existing table {OUT} — building from scratch",
                  file=sys.stderr)

    # Deterministic layout: catalog keys alphabetical (the committed shape),
    # then the preserved legacy/manual entries in their committed order.
    db: dict[str, dict[str, str]] = {k: generated[k] for k in sorted(generated)}
    preserved = [k for k in existing if k not in generated]
    for key in preserved:
        db[key] = existing[key]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Committed layout: 2-space indent, LF, trailing newline — a compact
    # rewrite would churn every line of the file on every refresh.
    OUT.write_text(json.dumps(db, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"[ribbon-names] wrote {len(db)} ribbons ({len(generated)} from catalogs, "
          f"{len(preserved)} preserved legacy) -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
