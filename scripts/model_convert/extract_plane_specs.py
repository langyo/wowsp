#!/usr/bin/env python3
"""Bake the ship-detail panel's aircraft performance specs (plane_specs.json).

When the 3D stage's model dropdown switches from the hull to a carrier
aircraft, ShipDetailModal's Specifications tab must show that airframe's
numbers instead of the ship's. shipPlaneSpecs.ts formats this table into the
same grouped spec tree the hull uses (shipSpecs.ts); the labels are i18n keys,
so this script only bakes raw values.

Every number comes from the full GameParams dump:

  aircraft entity    maxHealth, numPlanesInSquadron, attackerSize,
                     hangarSettings.maxValue / .timeToRestore,
                     speedMoveWithBomb * speedMax, visibilityFactor,
                     aimingTime, attackCooldown, attackCount * projectilesPerAttack
  carried projectile torpedoName / bombName / rocketName / skipBombName
                     (in that order - torpedo aircraft commonly store their
                     torpedo under "bombName"), then:
                       ammunition kind  projectile.planeAmmoType (fallback: the
                                        committed plane_types.json role)
                       damage           alphaDamage (bombs / rockets / skip
                                        bombs), alphaDamage / 3 + damage for
                                        torpedoes (TORPEDO_DAMAGE_CONSTANT; see
                                        game-assets ttx/constants.rs)
                       HE pen / fire    alphaPiercingHE (floor, > 0) and
                                        burnProb * 100 (percent, > 0)
                       torpedo          speed (kn), maxDist * BW_TO_BALLISTIC /
                                        KM_TO_M (km), visibilityFactor (km),
                                        uwCritical * 100 (flood %)

Two dumps feed the table, and they are NOT interchangeable. The Lesta client's
numbers diverge from the WG client's on 339 of the 528 airframes both still
carry (restoration time alone differs on 193, damage on 152, HP on 74; 118 of
them dropped their carried-ammunition reference entirely), so a plain "WG dump
then Lesta dump" overwrite would flip every wiki-verified value (e.g. PAAF110
regen 68.0 s WG vs 74.0 s Lesta; the contract anchors are the WG numbers). This
table therefore takes each airframe from the client that authored it:

  * rows without the lesta marker are WG airframes - refreshed from the WG
    GameParams.json;
  * rows with "lesta": true were added by extract_lesta_planes.py for ships
    only the Lesta client carries - refreshed from GameParams_lesta.json.

Each run only touches its own slice and preserves the rest (merge semantics),
so --check passes against the same committed file for both dumps. --source
defaults to "auto", which picks "lesta" when the input file name mentions
"lesta" (the standard cache names do); pass it explicitly when the dump lives
under another name.

Layout matches plane_types.json: one compact JSON line, sorted keys, LF, one
trailing newline. --check recomputes without writing and exits non-zero when
the committed file is out of date (CI / pre-commit use).

Usage:
    python scripts/model_convert/extract_plane_specs.py
    python scripts/model_convert/extract_plane_specs.py \
        --input %LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json
    python scripts/model_convert/extract_plane_specs.py --check \
        --input %LOCALAPPDATA%/WoWSP-extract/GameParams.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
DATA_DIR = REPO_ROOT / "packages" / "webui" / "src" / "data"

# Reuse the mmap entity reader (and the plane role derivation) from the
# sibling WG plane-table extractor.
sys.path.insert(0, str(SCRIPT_DIR))
from extract_plane_types import GameParamsIndex, plane_role  # noqa: E402

DEFAULT_INPUT = Path.home() / "AppData" / "Local" / "WoWSP-extract" / "GameParams.json"

# The ammunition reference fields an Aircraft entity may carry, in the order
# they are tried. Torpedo bombers are the surprise: the game stores their
# torpedo under "bombName" (the projectile's planeAmmoType still says
# "torpedo"), so the field name alone cannot classify the weapon.
AMMO_REF_FIELDS = ("torpedoName", "bombName", "rocketName", "skipBombName")

# Raw projectile planeAmmoType -> the canonical family stored in the table.
# ("skip" is what the dumps carry; the frontend contract calls it "skipBomb".)
AMMO_KINDS = {
    "bomb": "bomb",
    "torpedo": "torpedo",
    "rocket": "rocket",
    "skip": "skipBomb",
    "skipBomb": "skipBomb",
    "depthcharge": "depthcharge",
    "mine": "mine",
    "drop": "drop",
}

# Fallback when the projectile exists but carries no recognizable
# planeAmmoType: derive the family from plane_types.json's role instead.
ROLE_AMMO = {
    "torpedo": "torpedo",
    "heBomber": "bomb",
    "apBomber": "bomb",
    "heSkip": "skipBomb",
    "apSkip": "skipBomb",
    "rocket": "rocket",
    "asw": "depthcharge",
    "mine": "mine",
}

# Ammunition families whose whole warhead lives in alphaDamage.
ALPHA_DAMAGE_AMMO = frozenset({"bomb", "rocket", "skipBomb"})

# Torpedo damage = alphaDamage / TORPEDO_DAMAGE_CONSTANT + damage (the
# flooding portion). Constant mirrored from the vendored game-assets TTX
# (packages/tools/game-assets/src/game_params/ttx/constants.rs).
TORPEDO_DAMAGE_CONSTANT = 3.0
# BigWorld distance units -> ballistic units. Torpedo range in km is
# maxDist * BW_TO_BALLISTIC / KM_TO_M (same constants.rs).
BW_TO_BALLISTIC = 30.0
KM_TO_M = 1000.0


def _num(value: object) -> float | None:
    """Finite number or None - GameParams mixes ints, floats and nulls."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _int(value: object) -> int | None:
    n = _num(value)
    return int(round(n)) if n is not None else None


def _one_decimal(value: object) -> float | None:
    n = _num(value)
    return round(n, 1) if n is not None else None


def resolve_ammo(
    gp: GameParamsIndex, entity: dict, ammo_cache: dict[str, dict | None]
) -> tuple[str | None, dict | None]:
    """(canonical ammo family, projectile entity) carried by the aircraft.

    Walks the reference fields in order; the projectile's planeAmmoType is
    authoritative, with the picker's role as a fallback for a missing /
    unmapped family. Ammunitionless aircraft (pure fighters, scouts) return
    (None, None).
    """
    for field in AMMO_REF_FIELDS:
        ref = entity.get(field)
        if not ref:
            continue
        if ref not in ammo_cache:
            ammo_cache[ref] = gp.entity(ref)
        ammo = ammo_cache[ref]
        if not isinstance(ammo, dict):
            continue
        kind = AMMO_KINDS.get(str(ammo.get("planeAmmoType") or ""))
        if kind:
            return kind, ammo
        role = plane_role(gp, entity, ammo_cache)
        kind = ROLE_AMMO.get(role)
        if kind:
            return kind, ammo
        # Unusable projectile reference - keep looking at the other fields.
    return None, None


def aircraft_specs(
    gp: GameParamsIndex, entity: dict, ammo_cache: dict[str, dict | None]
) -> dict:
    """The committed per-airframe row for one Aircraft entity."""
    specs: dict = {}

    def put_int(key: str, value: object) -> None:
        n = _int(value)
        if n is not None:
            specs[key] = n

    def put_seconds(key: str, value: object) -> None:
        n = _one_decimal(value)
        if n is not None:
            specs[key] = n

    put_int("hp", entity.get("maxHealth"))
    put_int("squadron", entity.get("numPlanesInSquadron"))
    put_int("flight", entity.get("attackerSize"))
    hangar = entity.get("hangarSettings")
    if isinstance(hangar, dict):
        put_int("deck", hangar.get("maxValue"))
        put_seconds("regen", hangar.get("timeToRestore"))
    put_seconds("prep", entity.get("aimingTime"))
    put_seconds("cooldown", entity.get("attackCooldown"))

    cruise = _num(entity.get("speedMoveWithBomb"))
    if cruise is not None:
        specs["cruise"] = int(round(cruise))
        speed_multiplier = _num(entity.get("speedMax"))
        if speed_multiplier is not None:
            specs["maxSpeed"] = int(round(cruise * speed_multiplier))

    put_seconds("detect", entity.get("visibilityFactor"))

    salvo = _num(entity.get("attackCount"))
    per_attack = _num(entity.get("projectilesPerAttack"))
    if salvo is not None and per_attack is not None:
        specs["payload"] = int(round(salvo * per_attack))

    kind, ammo = resolve_ammo(gp, entity, ammo_cache)
    if kind is not None:
        specs["ammo"] = kind
    if not ammo:
        return specs

    ammo_type = ammo.get("ammoType")
    if isinstance(ammo_type, str) and ammo_type:
        specs["ammoType"] = ammo_type

    alpha = _num(ammo.get("alphaDamage"))
    flooding = _num(ammo.get("damage")) or 0.0
    if kind in ALPHA_DAMAGE_AMMO and alpha is not None:
        specs["damage"] = int(round(alpha))
    elif kind == "torpedo" and alpha is not None:
        specs["damage"] = int(round(alpha / TORPEDO_DAMAGE_CONSTANT + flooding))

    if kind in ALPHA_DAMAGE_AMMO:
        # HE penetration / fire only exist for the bomb-like families; AP
        # rounds carry a zero burnProb and torpedoes a dummy 1000 mm value.
        pen = _num(ammo.get("alphaPiercingHE"))
        if pen is not None and pen > 0:
            specs["pen"] = int(math.floor(pen))
        burn = _num(ammo.get("burnProb"))
        if burn is not None and burn > 0:
            specs["fire"] = int(round(burn * 100))

    if kind == "torpedo":
        put_int("torpSpeed", ammo.get("speed"))
        max_dist = _num(ammo.get("maxDist"))
        if max_dist is not None:
            specs["torpRange"] = round(max_dist * BW_TO_BALLISTIC / KM_TO_M, 1)
        put_seconds("torpDetect", ammo.get("visibilityFactor"))
        uw_critical = _num(ammo.get("uwCritical"))
        if uw_critical is not None:
            specs["flood"] = int(round(uw_critical * 100))

    return specs


def canonical(table: dict) -> str:
    """The committed byte layout: one compact sorted line + trailing newline."""
    return json.dumps(table, ensure_ascii=False, sort_keys=True) + "\n"


def resolve_source(explicit: str, input_path: Path) -> str:
    """'wg' / 'lesta' - auto-detected from the standard cache file names."""
    if explicit != "auto":
        return explicit
    return "lesta" if "lesta" in input_path.name.lower() else "wg"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT,
                    help="unpacked GameParams.json (default: the WG client's "
                         "orchestrator cache)")
    ap.add_argument("--source", choices=("auto", "wg", "lesta"), default="auto",
                    help="which client this dump came from - selects the "
                         "airframes it owns (default: auto = lesta when the "
                         "file name mentions lesta)")
    ap.add_argument("--types", type=Path, default=DATA_DIR / "plane_types.json",
                    help="committed plane table (airframe names to look up)")
    ap.add_argument("--out", type=Path, default=DATA_DIR / "plane_specs.json",
                    help="committed aircraft spec table")
    ap.add_argument("--check", action="store_true",
                    help="verify the committed file is up to date; write nothing")
    args = ap.parse_args()

    if not args.input.is_file():
        print(f"GameParams not found at {args.input} - run the orchestrator "
              "extract first (see scripts/extract_gameparams.py)", file=sys.stderr)
        return 1
    if not args.types.is_file():
        print(f"plane_types.json not found at {args.types}", file=sys.stderr)
        return 1

    source = resolve_source(args.source, args.input)
    plane_types: dict = json.loads(args.types.read_text(encoding="utf-8"),
                                   object_pairs_hook=dict)

    # Only the airframes this client authored: the WG client owns the rows
    # without the Lesta-only marker, the Lesta client owns the marked ones.
    # (See the module docstring for why overwriting across clients is wrong.)
    want_lesta = source == "lesta"
    rows = [(key, meta) for key, meta in sorted(plane_types.items())
            if bool(meta.get("lesta")) == want_lesta]

    gp = GameParamsIndex(args.input)
    ammo_cache: dict[str, dict | None] = {}
    extracted: dict[str, dict] = {}
    missing: list[str] = []
    for _key, meta in rows:
        index = meta.get("index")
        name = meta.get("name")
        if not isinstance(index, str) or not isinstance(name, str):
            continue
        entity = gp.entity(name)
        if entity is None:
            missing.append(name)
            continue
        extracted[index] = aircraft_specs(gp, entity, ammo_cache)
    del gp

    if missing:
        print(f"[plane-specs] WARN {len(missing)} {source} airframes not found in "
              f"the dump: {', '.join(missing[:10])}"
              + (" ..." if len(missing) > 10 else ""), file=sys.stderr)

    existing: dict = {}
    if args.out.is_file():
        existing = json.loads(args.out.read_text(encoding="utf-8"),
                              object_pairs_hook=dict)

    # Merge-preserve: entries the dump does not own (the other client's
    # airframes, or rows nobody references any more) keep their committed
    # values; this dump's slice is refreshed.
    merged = dict(existing)
    merged.update(extracted)
    merged = {index: merged[index] for index in sorted(merged)}

    text = canonical(merged)
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.is_file() else None
        if current == text:
            print(f"[plane-specs] up to date - {len(merged)} airframes "
                  f"({source} source, {len(extracted)} checked)")
            return 0
        stale = [index for index in merged if existing.get(index) != merged[index]]
        if stale:
            print(f"[plane-specs] OUT OF DATE - {len(stale)} airframe(s) would "
                  f"change ({source} source); run without --check to regenerate "
                  f"{args.out}", file=sys.stderr)
        else:
            print(f"[plane-specs] OUT OF DATE - the file is not in the canonical "
                  f"one-line sorted layout; run without --check to rewrite "
                  f"{args.out}", file=sys.stderr)
        for index in stale[:20]:
            print(f"  {index}: {json.dumps(merged[index], ensure_ascii=False)}",
                  file=sys.stderr)
        return 1

    if args.out.is_file() and current_text_equal(args.out, text):
        print(f"[plane-specs] unchanged - {len(merged)} airframes "
              f"({source} source, {len(extracted)} checked)")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8", newline="\n")
    print(f"[plane-specs] wrote {args.out} - {len(merged)} airframes "
          f"({source} source: {len(extracted)} baked, "
          f"{len(merged) - len(extracted)} preserved)")
    return 0 if extracted else 1


def current_text_equal(path: Path, text: str) -> bool:
    return path.is_file() and path.read_text(encoding="utf-8") == text


if __name__ == "__main__":
    sys.exit(main())
