"""Bake the ships missing from the user's replays (found via roster diff)."""
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import batch_bake

MISSING = [
    # 15.7 Pan-America destroyers (new DD line) + cruisers missing from the pack.
    "PVSD010_20_de_Julio",
    "PVSD013_Almirante_Villar",
    "PVSD014_Serrano",
    "PVSD015_Antioquia",
    "PVSD017_Marcilio_Dias",
    "PVSD018_Cuauhtemoc",
    "PVSD019_Nueva_Esparta",
    "PVSD710_La_Pampa",
    "PVSC101_Hercules",
    "PVSC102_Almirante_Barroso",
    "PVSC103_Vicente_Guerrero",
    "PVSC104_Cordoba",
    "PVSC105_La_Argentina",
    "PVSC107_Coronel_Bolognesi",
    "PVSC108_Ignacio_Allende",
    "PVSC109_Santander",
    "PVSC110_San_Martin",
    "PVSC507_Nueve_de_Julio_1951",
    "PVSC508_Almirante_Grau",
    "PVSC708_Comandante_Aguirre",
    "PVSC710_Almirante_Irizar",
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
