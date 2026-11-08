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
  torpReload smallest positive HP_* shotDelay (seconds) across the hull's
            *_Torpedoes sections — the authoritative per-launcher torpedo
            reload the E26 labelA uses instead of the observed click gap.
            Written ONLY when a torpedo section exists (the Rust reader
            treats a missing key as 0.0 = unknown).
  torpSpeed max(ammo.speed) across __torpedoAmmo, knots (1 decimal) — the
            fastest loadout the hull can carry (E26e-f feature).
  torpDamage max(ammo.alphaDamage) across __torpedoAmmo, HP (integer) — the
            hardest-hitting loadout (E26e-f feature).
  torpDetect min positive ammo.visibilityFactor across __torpedoAmmo, km
            (2 decimals) — the hardest-to-spot torpedo (E26e-f feature).
  torpCount max number of HP_* launchers in any *_Torpedoes section — the
            launcher mounts per side/top config (E26e-f feature; Daring 2).
  torpDeep  1 if any __torpedoAmmo entry isDeepWater, else 0 — deep-water
            torpedo mechanic flag, written whenever the hull has ammo.
            The five torpedo-performance keys above are written ONLY when a
            torpedo section exists (same policy as cls/torpReload); a missing
            ammo field is skipped per key, never written as 0.

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


def torp_reload_s(d: dict) -> float | None:
    """Smallest positive HP_* shotDelay (seconds) across the torpedo sections.

    GameParams stores the launcher reload in each `HP_<launcher>` sub-dict's
    `shotDelay` (Daring = 125.0); the smallest one is the hull's fastest
    launcher reload. None when the hull carries no torpedo section, so the
    key is omitted and the Rust reader keeps 0.0 (unknown).
    """
    best = None
    for section in _sections(d, "Torpedoes"):
        for key, hp in section.items():
            if not (key.startswith("HP_") and isinstance(hp, dict)):
                continue
            delay = hp.get("shotDelay")
            if isinstance(delay, (int, float)) and delay > 0:
                best = delay if best is None else min(best, float(delay))
    return None if best is None else round(float(best), 1)


def torp_perf_attrs(d: dict) -> dict:
    """E26e-f torpedo performance columns from the hull's __torpedoAmmo table.

    The pack lists every torpedo the hull can mount (one entry per ammo
    choice, several hulls carry 2-6). The feature wave wants the hull's
    best loadout: fastest speed, hardest alphaDamage, hardest-to-spot
    visibilityFactor (smallest positive), plus the deep-water mechanic flag.
    Missing/non-numeric fields are skipped per key (never written as 0) —
    a partial extraction must not fabricate "no torpedoes".
    """
    ammos = [a for a in (d.get("__torpedoAmmo") or {}).values() if isinstance(a, dict)]
    out: dict[str, float | int] = {}
    speeds = [
        float(a["speed"])
        for a in ammos
        if isinstance(a.get("speed"), (int, float))
    ]
    if speeds:
        out["torpSpeed"] = round(max(speeds), 1)
    damages = [
        float(a["alphaDamage"])
        for a in ammos
        if isinstance(a.get("alphaDamage"), (int, float))
    ]
    if damages:
        out["torpDamage"] = round(max(damages), 0)
    detects = [
        float(a["visibilityFactor"])
        for a in ammos
        if isinstance(a.get("visibilityFactor"), (int, float))
        and float(a["visibilityFactor"]) > 0.0
    ]
    if detects:
        out["torpDetect"] = round(min(detects), 2)
    if ammos:
        out["torpDeep"] = 1 if any(a.get("isDeepWater") for a in ammos) else 0
    return out


def torp_launcher_count(d: dict) -> int | None:
    """E26e-f launcher count: max HP_* mounts across the hull's torpedo sections.

    Daring's A1_Torpedoes carries HP_BGT_1/HP_BGT_2 (two five-tube mounts),
    so the count is 2; a section without HP_* entries contributes 0. None
    when the hull carries no torpedo section at all.
    """
    counts = [
        sum(
            1
            for key, hp in section.items()
            if key.startswith("HP_") and isinstance(hp, dict)
        )
        for section in _sections(d, "Torpedoes")
    ]
    if not counts:
        return None
    best = max(counts)
    # A handful of collab/event hulls (PXSD102_Akizuki_H2020,
    # PXSD027_Akatsuki_Romulans, PXSC027_Fiji_Klingons, PXSB027_Gneisenau_Vulkans)
    # mount their torpedo launchers under a Gun_* slot instead of HP_*: for
    # those the HP_* scan is legitimately 0 while __torpedoAmmo still lists
    # torpedoes. Skip the key rather than writing a misleading 0 (the same
    # conservative stance as a missing ammo field); torpReload already skips
    # them for the same reason.
    return best if best > 0 else None


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
    torp_reload = torp_reload_s(d)
    if torp_reload is not None:
        out["torpReload"] = torp_reload
    # E26e-f: torpedo performance columns — same "torpedo section exists"
    # gate as torpReload (a hull without torpedo mounts gets no keys).
    if _sections(d, "Torpedoes"):
        out.update(torp_perf_attrs(d))
        torp_count = torp_launcher_count(d)
        if torp_count is not None:
            out["torpCount"] = torp_count
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
        # Additive-only contract: an E26e-f style regen may ADD columns but
        # must not mutate one the shipped table already carries (training and
        # the Rust reader depend on the old values, e.g. the torpRange scale).
        mutated = sorted(
            k
            for k in table
            if any(table[k].get(col) != base_table[k].get(col) for col in base_table[k])
        )
        if mutated:
            raise SystemExit(
                f"[e24] baseline columns changed for {len(mutated)} shipId(s) "
                f"(first: {mutated[:5]}) — a focused regen must be additive only"
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
    # E26 torpedo-reload liveness: the torpedo dataset's labelA gates on this
    # column, so an extraction regression must abort here (an all-missing
    # column would silently fall back to observed click gaps everywhere).
    live_torp_reload = sum(
        1 for v in table.values() if v.get("torpReload", 0.0) > 0
    )
    # E26e-f torpedo-performance liveness: every hull with torpedo mounts in
    # the shipped pack must carry the four performance columns, or the feature
    # wave silently trains on a constant column. torpDeep is a mechanic subset
    # (deep-water torpedoes): printed and asserted non-empty, not >300.
    live_torp_speed = sum(
        1 for v in table.values() if v.get("torpSpeed", 0.0) > 0
    )
    live_torp_damage = sum(
        1 for v in table.values() if v.get("torpDamage", 0.0) > 0
    )
    live_torp_detect = sum(
        1 for v in table.values() if v.get("torpDetect", 0.0) > 0
    )
    live_torp_count = sum(1 for v in table.values() if v.get("torpCount", 0) > 0)
    live_torp_deep = sum(1 for v in table.values() if v.get("torpDeep"))
    print(
        f"[e24] {len(table)} ships | torp {live_torp} | smoke-firing {live_smoke} "
        f"| radar {live_radar} | hydro {live_hydro} | CV {live_cv} | SS {live_ss} "
        f"| torpReload {live_torp_reload} | torpSpeed {live_torp_speed} "
        f"| torpDamage {live_torp_damage} | torpDetect {live_torp_detect} "
        f"| torpCount {live_torp_count} | torpDeep {live_torp_deep}"
    )
    if live_torp == 0 or live_smoke == 0 or live_radar == 0 or live_hydro == 0:
        raise SystemExit("[e24] a routing column came out dead — extraction regression")
    if live_cv == 0 or live_ss == 0:
        raise SystemExit(
            "[e24] a hull-class column came out dead (no AirCarrier/Submarine) "
            "— extraction regression"
        )
    if live_torp_reload <= 300:
        raise SystemExit(
            f"[e24] torpedo-reload column came out dead ({live_torp_reload} "
            "hulls > 0, expected > 300) — extraction regression"
        )
    for name, live in (
        ("torpSpeed", live_torp_speed),
        ("torpDamage", live_torp_damage),
        ("torpDetect", live_torp_detect),
        ("torpCount", live_torp_count),
    ):
        if live <= 300:
            raise SystemExit(
                f"[e24] torpedo-performance column '{name}' came out dead "
                f"({live} hulls > 0, expected > 300) — extraction regression"
            )
    if live_torp_deep == 0:
        raise SystemExit(
            "[e24] torpDeep column came out dead (no deep-water torpedo hull) "
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
