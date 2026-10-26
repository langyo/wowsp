#!/usr/bin/env python3
"""Extract the Lesta planner art into the webui res images.

The Lesta captain datasets reference two art groups WG never shipped:

  - gui/crew_commander/skills/planes_consumables_regeneratehealth_upgrade.png
    (the one skill skilltree_lesta.json adds — LESTA_TREE_OVERRIDES in
    build_planner_data.py),
  - gui/signal_flags/PCEF* (the 24 tiered signal flags, PCEF101..154).

Both live only inside the Lesta client's packages, so this script stages
them out with lesta_extract (idx + Oodle decode; the wows_meta_lesta.json
cache in the WoWSP-extract dir skips the game-assets metadata pass entirely
when present), converts them to WebP with build_planner_data.png_to_webp —
the same encoder the WG planner pipeline uses (lossless at native size,
q85/method-6 when downscaled) — and writes them under
packages/webui/src/res/images/{skills,signals}/<stem>.webp.

<stem> is exactly what the webui resolvers look up: skillIconUrl's
snake-case-of-code stem for the skill (skillTree.ts codeToStem) and the
signal entry name for the flags (BuildPlanner.tsx signalIconUrl lowercases
the name and matches file stems). The script prints the resolution check
for every emitted file against those transforms and against
signals_lesta.json.

Usage:
    python scripts/extract/lesta_planner_icons.py --game-dir "D:/WoWS_Korabli"\
        [--ooz PATH] [--game-assets PATH] [--stage DIR]

Offline & read-only vs the game: the only Lesta-install access is READING
res_packages/*.pkg and bin/*/idx — nothing is ever launched, nothing is
written into the game directory. Requires an Oodle decoder (unoodle):
pass --ooz or set WOWSP_OOZ/WOWSP_UNOODLE, or build one with
`python scripts/extract/fetch_oodle.py`. --game-assets is only needed
when the wows_meta_lesta.json cache is missing.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_planner_data as bpd  # noqa: E402
import lesta_extract as le  # noqa: E402
from fetch_oodle import ensure_decoder  # noqa: E402

SKILL_PNGS = (
    "gui/crew_commander/skills/planes_consumables_regeneratehealth_upgrade.png",
)
SIGNAL_PNGS = ("gui/signal_flags/PCEF*",)


def ui_skill_stem(code: str) -> str:
    """Replicate skillTree.ts codeToStem: split before every uppercase
    letter, join with '_', lowercase (a zero-width split at index 0 yields
    no leading empty part in JS)."""
    return (code[0] + re.sub(r"([A-Z])", r"_\1", code[1:])).lower()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--game-dir", help="Lesta install root (default: WOWSP_GAME_PATH_LESTA / registry)")
    ap.add_argument("--ooz", help="ooz/unoodle decoder binary (default: WOWSP_OOZ / WOWSP_UNOODLE)")
    ap.add_argument("--game-assets", help="game-assets binary, only needed when "
                                         "the wows_meta_lesta.json cache is missing")
    ap.add_argument("--stage", help="keep the staged pkg output in this directory "
                                    "instead of a temp dir")
    args = ap.parse_args()

    game = le.find_game_dir(args.game_dir)
    ooz_arg = args.ooz or os.environ.get("WOWSP_OOZ") or os.environ.get("WOWSP_UNOODLE")
    if ooz_arg and not pathlib.Path(ooz_arg).is_file():
        raise SystemExit(f"decoder not found: {ooz_arg}")
    decoder = le.OozDecoder(*ensure_decoder(ooz_arg, auto_build=False))
    print(f"[lesta-icons] oodle backend: {decoder.mode} ({decoder.exe})")

    if le.META_JSON.is_file():
        meta = le.load_meta(le.META_JSON)
    else:
        if not args.game_assets:
            raise SystemExit(
                f"{le.META_JSON} cache missing — pass --game-assets "
                "(build: just build game-assets) so the metadata pass can run"
            )
        meta = le.load_meta(le.ensure_metadata(game, args.game_assets))

    stage = (pathlib.Path(args.stage) if args.stage
             else pathlib.Path(tempfile.mkdtemp(prefix="wowsp_lesta_icons_")))
    try:
        idx_dir = le.latest_idx_dir(game)
        n_ok, _miss, n_fail = le.extract_patterns(
            (*SKILL_PNGS, *SIGNAL_PNGS), meta, idx_dir,
            game / "res_packages", decoder, stage,
        )
        if n_fail or n_ok == 0:
            print(f"error: staged extraction incomplete (ok={n_ok} fail={n_fail})",
                  file=sys.stderr)
            return 1

        signals: list[dict] | None = None
        sig_path = bpd.OUT_DATA / "signals_lesta.json"
        if sig_path.is_file():
            signals = json.loads(sig_path.read_text(encoding="utf-8"))

        wrote: list[tuple[str, str]] = []
        for png in sorted(stage.rglob("*.png")):
            rel = png.relative_to(stage).as_posix()
            stem = png.stem
            if rel.startswith("gui/crew_commander/skills/"):
                dest_dir = bpd.OUT_IMG / "skills"
            elif rel.startswith("gui/signal_flags/"):
                dest_dir = bpd.OUT_IMG / "signals"
            else:
                print(f"[lesta-icons] skipping non-planner staged file {rel}")
                continue
            dest_dir.mkdir(parents=True, exist_ok=True)
            (dest_dir / f"{stem}.webp").write_bytes(bpd.png_to_webp(png.read_bytes()))
            wrote.append((dest_dir.name, stem))
        out_rel = bpd.OUT_IMG.relative_to(bpd.REPO)
        print(f"[lesta-icons] wrote {len(wrote)} webp icons under {out_rel}")

        # Resolution check — replicate the webui's lookups by name.
        ok = True
        want_skill = ui_skill_stem("PlanesConsumablesRegeneratehealthUpgrade")
        for kind, stem in sorted(wrote):
            note = ""
            if kind == "skills" and stem != want_skill:
                note = f"  !! expected stem {want_skill!r} (skillIconUrl)"
                ok = False
            if kind == "signals" and signals is not None:
                hit = next((s for s in signals if s["name"].lower() == stem.lower()), None)
                if hit is None:
                    note = "  !! not referenced by signals_lesta.json"
                    ok = False
                elif hit["name"] != stem:
                    note = f"  !! case mismatch with entry name {hit['name']!r}"
            print(f"[lesta-icons] /images/{kind}/{stem}.webp{note}")
        if signals is not None:
            missing = [s["name"] for s in signals
                       if not (bpd.OUT_IMG / "signals" / f"{s['name']}.webp").is_file()]
            for name in missing:
                print(f"[lesta-icons] !! signals_lesta.json entry {name} has no icon file")
                ok = False
        return 0 if ok else 1
    finally:
        if args.stage:
            print(f"[lesta-icons] staged files kept in {stage}")
        else:
            shutil.rmtree(stage, ignore_errors=True)
            print(f"[lesta-icons] temp stage {stage} removed")


if __name__ == "__main__":
    raise SystemExit(main())
