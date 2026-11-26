"""Regression tests for extract_ship_live_stats.py's hull selection.

The bake's per-field max across hull blocks assumes an A→B research chain,
where the widest fit IS the top configuration. Collaboration/event ships
break that: they ship SEVERAL base `_Hull` upgrades with an empty `prev` —
parallel loadout variants of ONE shipId (the Bermuda Triangle 远征者
PXSC999_Siegfried_1510: five hulls, 7-16.5 km concealment and 30.7k-73k HP
apart). The pre-fix bake took the max across every A|B|C hull key and
franken-merged them (det from B 16.5, hp from A 63450, spd from C 48).
These tests pin the parallel-variant rule: scope every stat to the FIRST
variant's own prev-chain, and leave normal single-root ships byte-for-byte
on the legacy widest-fit walk.

Run standalone (they are not part of the visual/e2e suites):

    python -m pytest scripts/test_extract_ship_live_stats.py -q
"""
from __future__ import annotations

from extract_ship_live_stats import (
    collect_gameparams_fallback,
    variant_hull_blocks,
)


def _upgrade(uc_type: str, prev: str, hull: str) -> dict:
    return {"ucType": uc_type, "prev": prev, "components": {"hull": [hull]}}


# The PXSC999 shape: five parallel base hulls plus the first variant's
# event-tier chain; numbers are the verified 15.10 event hulls.
PARALLEL_GP = {
    "ShipUpgradeInfo": {
        "PXUH801_HULL_A": _upgrade("_Hull", "", "A_Hull"),
        "PXUH811_HULL_A_TIER2": _upgrade("_Hull", "PXUH801_HULL_A", "A_Hull_TIER2"),
        "PXUH821_HULL_A_TIER3": _upgrade("_Hull", "PXUH811_HULL_A_TIER2", "A_Hull_TIER3"),
        "PXUH802_HULL_B": _upgrade("_Hull", "", "B_Hull"),
        "PXUH803_HULL_C": _upgrade("_Hull", "", "C_Hull"),
        "PXUH804_HULL_D": _upgrade("_Hull", "", "D_Hull"),
        "PXUH805_HULL_E": _upgrade("_Hull", "", "E_Hull"),
    },
    "A_Hull": {"health": 63450, "maxSpeed": 40, "visibilityFactor": 15, "visibilityFactorByPlane": 15},
    "A_Hull_TIER2": {"health": 63450, "maxSpeed": 45, "visibilityFactor": 15, "visibilityFactorByPlane": 15},
    "A_Hull_TIER3": {"health": 73000, "maxSpeed": 45, "visibilityFactor": 15, "visibilityFactorByPlane": 15},
    "B_Hull": {"health": 44600, "maxSpeed": 35, "visibilityFactor": 16.5, "visibilityFactorByPlane": 16.5},
    "C_Hull": {"health": 30700, "maxSpeed": 48, "visibilityFactor": 7, "visibilityFactorByPlane": 7},
    "D_Hull": {"health": 47300, "maxSpeed": 40, "visibilityFactor": 10, "visibilityFactorByPlane": 10},
    "E_Hull": {"health": 42500, "maxSpeed": 40, "visibilityFactor": 13, "visibilityFactorByPlane": 13},
}


# A normal researchable ship: one base hull, one upgrade off it.
CHAIN_GP = {
    "ShipUpgradeInfo": {
        "PBUH110_HULL_A": _upgrade("_Hull", "", "A_Hull"),
        "PBUH111_HULL_B": _upgrade("_Hull", "PBUH110_HULL_A", "B_Hull"),
    },
    "A_Hull": {"health": 13900, "maxSpeed": 33, "visibilityFactor": 7.8, "visibilityFactorByPlane": 3.3},
    "B_Hull": {"health": 17100, "maxSpeed": 35.5, "visibilityFactor": 8.2, "visibilityFactorByPlane": 3.6},
}


def test_single_root_ship_keeps_the_legacy_widest_fit():
    """A normal A→B ship must keep reading the max across hulls (top fit)."""
    assert variant_hull_blocks(CHAIN_GP) is None
    fb = collect_gameparams_fallback(CHAIN_GP, {})
    assert fb["hp"] == 17100
    assert fb["spd"] == 35.5
    assert fb["det"] == 8.2
    assert fb["detAir"] == 3.6


def test_parallel_variants_scope_to_the_first_variant_chain():
    """Five parallel hulls must NOT merge: only the first variant's chain
    (A_Hull → A_Hull_TIER2 → A_Hull_TIER3) feeds the stats."""
    blocks = variant_hull_blocks(PARALLEL_GP)
    assert blocks is not None
    ids = [id(b) for b in blocks]
    assert len(blocks) == 3
    assert PARALLEL_GP["A_Hull"] in blocks
    assert PARALLEL_GP["A_Hull_TIER2"] in blocks
    assert PARALLEL_GP["A_Hull_TIER3"] in blocks
    assert PARALLEL_GP["B_Hull"] not in blocks
    assert PARALLEL_GP["C_Hull"] not in blocks
    assert len(set(ids)) == len(ids)


def test_parallel_variant_stats_stay_inside_the_first_variant():
    """The baked record reads the first variant's chain top (73000 hp at
    15 km concealment), never the cross-variant franken-merge the pre-fix
    bake shipped (det 16.5 from B + hp 63450 from A + spd 48 from C)."""
    fb = collect_gameparams_fallback(PARALLEL_GP, {})
    assert fb["hp"] == 73000
    assert fb["spd"] == 45.0
    assert fb["det"] == 15.0
    assert fb["detAir"] == 15.0


def test_parallel_chain_does_not_wander_across_variants():
    """A prev pointing at ANOTHER variant's upgrade is still followed only
    from the chosen root — the walk must reach the second variant's hulls
    through nothing."""
    gp = {
        "ShipUpgradeInfo": {
            "PXUH801_HULL_A": _upgrade("_Hull", "", "A_Hull"),
            "PXUH805_HULL_E": _upgrade("_Hull", "", "E_Hull"),
            "PXUH815_HULL_E_TIER2": _upgrade("_Hull", "PXUH805_HULL_E", "E_Hull_TIER2"),
        },
        "A_Hull": {"health": 1000, "maxSpeed": 30, "visibilityFactor": 10, "visibilityFactorByPlane": 10},
        "E_Hull": {"health": 900, "maxSpeed": 31, "visibilityFactor": 12, "visibilityFactorByPlane": 12},
        "E_Hull_TIER2": {"health": 1100, "maxSpeed": 32, "visibilityFactor": 12, "visibilityFactorByPlane": 12},
    }
    blocks = variant_hull_blocks(gp)
    assert blocks is not None
    assert blocks == [gp["A_Hull"]]
    fb = collect_gameparams_fallback(gp, {})
    assert fb["hp"] == 1000
    assert fb["det"] == 10.0