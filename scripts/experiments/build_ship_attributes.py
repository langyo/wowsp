#!/usr/bin/env python3
"""E24: build the shipId -> weapon-attribute routing table.

Reads the pre-extracted GameParams slices shipped for the mobile bundle
(packages/webui/src/res/data/gameparams/<shipId>.json) and emits the flat
table train_fire_model.py --attr-table consumes:

  vis       smallest visibilityFactor across hull configs  km  (top hull =
            best concealment; matches run top configs)
  visSmoke  smallest visibilityCoefGKInSmoke across hulls km  detect range
            when firing from smoke
  mbRange   largest maxDist across *_Artillery sections  m   (top fire
            control; low-tier hulls keep it in ArtilleryDefault)
  torpRange max(__torpedoAmmo[*].maxDist)    m     torpedo range (see unit note)
  hasRadar  1 if any consumable name matches rls|radar (RLS = the Russian
            abbreviation WG uses internally for the surveillance radar)
  hasHydro  1 if any consumable name matches sonar|hydro
  cls       hull class from typeinfo.species (AirCarrier / Submarine /
            Battleship / Cruiser / Destroyer / Auxiliary), written ONLY when
            the slice is a Ship with a non-empty species — the Rust reader
            (ship_attrs.rs) treats a missing key as Other and keeps the
            fire-decision semantics unchanged for it.

Unit note — torpedo maxDist is NOT meters: GameParams scales torpedo
distances by 70/3 (cross-checked: the Gambra's PUPT014 lists maxDist
233.33 for a 10.0 km torpedo, and the factor holds across the pack), so
km = maxDist * 3 / 70. The first E24 run trained with torpRange and
visSmoke silently all-zero (the extraction read wrong keys) — this
builder is the corrected source and the columns are asserted non-dead
before anything is written.

The radar/hydro/duration/range consumable PARAMETERS are not part of the
per-ship slice, so the router's radar/hydro signal is presence-only for
now; extending the slice is the path to range/duration dims.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

TORP_KM_PER_UNIT = 3.0 / 70.0


def _sections(d: dict, family: str) -> list[dict]:
    """Every `<X>_<family>` section — the stock A_ plus upgraded variants
    (AB_/A1_/ABC_/B_/C_ …; collab and premium slices sometimes ship ONLY
    the upgraded configurations, e.g. HSF Harekaze carries ABC_Hull and
    no A_Hull at all) — plus the suffix-less `<family>Default` some
    low-tier hulls use instead of any prefixed section."""
    return [
        v
        for k, v in d.items()
        if (k.endswith(f"_{family}") or k == f"{family}Default")
        and isinstance(v, dict)
    ]


def ship_class(d: dict) -> str | None:
    """Hull class from the slice's `typeinfo` block, or None.

    Only a Ship-typed entry with a non-empty species names a hull class; any
    other slice (or a missing/malformed typeinfo) yields no key, which the
    Rust reader treats as `Other` (fire semantics unchanged).
    """
    ti = d.get("typeinfo")
    if not isinstance(ti, dict) or ti.get("type") != "Ship":
        return None
    species = ti.get("species")
    if not isinstance(species, str) or not species:
        return None
    return species


def ship_attrs(d: dict) -> dict:
    hulls = _sections(d, "Hull")
    arts = _sections(d, "Artillery")
    abils: list[str] = []
    for slot in (d.get("ShipAbilities") or {}).values():
        if isinstance(slot, dict):
            for grp in slot.get("abils") or []:
                abils += grp if isinstance(grp, list) else [grp]
    low = [a.lower() for a in abils]
    torp_km = 0.0
    for t in (d.get("__torpedoAmmo") or {}).values():
        md = t.get("maxDist") or 0
        torp_km = max(torp_km, md * TORP_KM_PER_UNIT)

    def hull_min(field: str) -> float:
        # best (smallest) non-zero value across hull configs — the top
        # hull improves concealment, and matches run top configs
        vals = [float(h.get(field) or 0) for h in hulls]
        vals = [v for v in vals if v > 0.5]  # 1e-06 sentinels read as zero
        return round(min(vals), 3) if vals else 0.0

    out = {
        "vis": hull_min("visibilityFactor"),
        "visSmoke": hull_min("visibilityCoefGKInSmoke"),
        # farthest artillery section = top fire control (match-representative)
        "mbRange": round(max((float(a.get("maxDist") or 0) for a in arts), default=0.0), 1),
        "torpRange": round(torp_km * 1000.0, 1),
        "hasRadar": 1 if any(("rls" in a or "radar" in a) for a in low) else 0,
        "hasHydro": 1 if any(("sonar" in a or "hydro" in a) for a in low) else 0,
    }
    cls = ship_class(d)
    if cls is not None:
        out["cls"] = cls
    return out


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--gameparams",
        default=str(here.parents[1] / "packages/webui/src/res/data/gameparams"),
        help="directory of per-ship GameParams slices (default: the bundled pack)",
    )
    p.add_argument(
        "--out",
        default=str(here / "ship_attributes.json"),
        help=(
            "output JSON (default: the tracked scripts/experiments/"
            "ship_attributes.json — commit the diff when the pack updates; "
            "tracked like ships_basics.json so training nodes without the "
            "game pack can consume it)"
        ),
    )
    p.add_argument(
        "--baseline",
        default=None,
        help=(
            "optional existing table JSON whose shipId set restricts the "
            "output. Every baseline shipId must still be generated (a missing "
            "one is a hard error, never a silent drop); slices the pack gained "
            "after the baseline was cut are reported and dropped, so a "
            "single-purpose regen cannot smuggle unrelated data into the diff"
        ),
    )
    args = p.parse_args(argv)

    gp_dir = Path(args.gameparams)
    files = sorted(f for f in gp_dir.glob("*.json") if f.stem.isdigit())
    if not files:
        raise SystemExit(f"[e24] no <shipId>.json slices under {gp_dir}")

    table: dict[str, dict] = {}
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        # a ship slice must carry at least one recognizable section —
        # skip stray numeric-id files that are not hulls at all
        if not (
            any(k.endswith(("_Hull", "_Artillery")) for k in d)
            or d.get("__torpedoAmmo")
        ):
            continue
        table[f.stem] = ship_attrs(d)

    # Optional baseline restriction: keep the tracked table's row set stable
    # across gamepack drift so a focused regen (e.g. adding the class column)
    # cannot smuggle unrelated new slices into the diff. Every baseline key
    # must still be generated — a vanished ship is a hard error, not a drop.
    if args.baseline:
        base_table = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        if not isinstance(base_table, dict) or not base_table:
            raise SystemExit("[e24] --baseline must be a non-empty JSON object")
        generated = set(table)
        missing = sorted(set(base_table) - generated)
        if missing:
            raise SystemExit(
                f"[e24] baseline has {len(missing)} shipId(s) the pack no longer "
                f"yields (first: {missing[:5]}) — refusing to drop hulls silently"
            )
        kept = {k: table[k] for k in base_table}
        dropped = len(generated) - len(kept)
        table = kept
        print(
            f"[e24] baseline {args.baseline}: retained {len(table)} / "
            f"dropped {dropped} pack slice(s) added after the baseline"
        )

    # liveness gate: the two columns the first E24 table shipped dead must
    # now be alive — a silent regression here quietly amputates the router
    # input again.
    live_torp = sum(1 for v in table.values() if v["torpRange"] > 0)
    live_smoke = sum(1 for v in table.values() if v["visSmoke"] > 0)
    live_radar = sum(1 for v in table.values() if v["hasRadar"])
    live_hydro = sum(1 for v in table.values() if v["hasHydro"])
    # Classification liveness: the scoring/report gate derives fire
    # applicability from this column, so a silent extraction regression must
    # abort here instead of degrading CV/SS back to main-battery semantics.
    live_cv = sum(1 for v in table.values() if v.get("cls") == "AirCarrier")
    live_ss = sum(1 for v in table.values() if v.get("cls") == "Submarine")
    print(
        f"[e24] {len(table)} ships | torp {live_torp} | smoke-firing {live_smoke} "
        f"| radar {live_radar} | hydro {live_hydro} | CV {live_cv} | SS {live_ss}"
    )
    if live_torp == 0 or live_smoke == 0 or live_radar == 0 or live_hydro == 0:
        raise SystemExit("[e24] a routing column came out dead — extraction regression")
    if live_cv == 0 or live_ss == 0:
        raise SystemExit(
            "[e24] a hull-class column came out dead (no AirCarrier/Submarine) "
            "— extraction regression"
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # Deterministic LF: text-mode writes on Windows would emit CRLF and turn
    # every regeneration into a whole-file diff.
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(table, indent=1))
    print(f"[e24] wrote {out} ({out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
