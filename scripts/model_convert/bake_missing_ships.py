"""Bake the ships missing from the user's replays (found via roster diff)."""
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import batch_bake

MISSING = [
    "PWSB017_Chios",
    "PVSD016_Cervantes",
    "PVSC106_Almirante_Cochrane",
]


def main() -> int:
    batch_bake.ensure_tools()
    game = batch_bake.find_game_path()
    if not game:
        print("game not found", file=sys.stderr)
        return 1
    out = batch_bake.SHIPS_OUT
    ok = 0
    for name in MISSING:
        print(f"[bake_missing] {name} ...")
        if batch_bake.bake_one(game, name, out, force=False, resume_min_tris=0):
            ok += 1
            print(f"[bake_missing] {name} done")
        else:
            print(f"[bake_missing] {name} FAILED")
    print(f"[bake_missing] {ok}/{len(MISSING)} baked")
    return 0 if ok == len(MISSING) else 1


if __name__ == "__main__":
    sys.exit(main())
