"""Tests for `extract_repair_coefficients.py` (the grey HP-bar coefficient bake).

The generator turns GameParams into `packages/webui/src/data/repair_coefficients.json`
(`{"<numeric ship id>": fraction}`). These tests pin the derivation on a small
fixture slice — the ship → ShipAbilities slot → ability entity → regenCrew
variant → `regenerationHPSpeed × workTime` chain — plus the shape of the
COMMITTED table, so a bad rebake cannot land silently.

Run standalone (not part of the visual/e2e suites):

    python -m pytest scripts/test_repair_coefficients.py -q
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from extract_repair_coefficients import (
    DEFAULT_FULL,
    DEFAULT_OUT,
    bake,
    main,
    slot_entries,
)


def regen(speed: float, work_time: float) -> dict[str, Any]:
    """One Repair-Party variant as GameParams spells it."""
    return {
        "consumableType": "regenCrew",
        "logic": {
            "ignoreRegenLimit": False,
            "regenerationHPSpeed": speed,
            "regenerationHPSpeedUnits": 0.0,
        },
        "workTime": work_time,
    }


def slot(*abils: tuple[str, str], special: bool = False) -> dict[str, Any]:
    return {"abils": [list(a) for a in abils], "isSpecial": special}


def ship(ship_id: int, *slots: dict[str, Any]) -> dict[str, Any]:
    abilities: dict[str, Any] = {f"AbilitySlot{i}": s for i, s in enumerate(slots)}
    abilities["AbilitySpecial"] = slot()
    return {
        "typeinfo": {"type": "Ship"},
        "id": ship_id,
        "ShipAbilities": abilities,
    }


FIXTURE: dict[str, Any] = {
    # ── ability entities ──────────────────────────────────────────────
    "PCY002_RegenCrew": {
        "typeinfo": {"type": "Ability"},
        # The slot always names a variant; the entity's own `Default` is the
        # documented fallback for legacy bare-string entries.
        "Default": regen(0.005, 28.0),
        "C_Gold": regen(0.0066, 28.0),
    },
    "PCY024_RegenCrewSuper": {
        "typeinfo": {"type": "Ability"},
        "Default": regen(0.02, 20.0),
        "B": regen(0.005, 28.0),
    },
    "PCY059_RegenCrewPremium_TimeBased": {
        "typeinfo": {"type": "Ability"},
        # A time-based fork without `workTime` cannot form a fraction.
        "Default_TimeBased": {
            "consumableType": "regenCrew",
            "logic": {"regenerationHPSpeed": 0.005},
        },
    },
    "PCY999_SmokeGenerator": {
        "typeinfo": {"type": "Ability"},
        "Default": {"consumableType": "smokeGenerator", "workTime": 90.0},
    },
    "PCY025_ZeroRegen": {
        "typeinfo": {"type": "Ability"},
        "Default": regen(0.0, 15.0),
    },
    "PCY900_NegativeRegen": {
        "typeinfo": {"type": "Ability"},
        "Default": {
            "consumableType": "regenCrew",
            "logic": {"regenerationHPSpeed": -0.5},
            "workTime": 28.0,
        },
    },
    "PCY901_HugeRegen": {
        "typeinfo": {"type": "Ability"},
        "Default": regen(0.5, 10.0),  # 5.0 × maxHp — absurd but bounded
    },
    # ── ships ─────────────────────────────────────────────────────────
    # 100: the plainest mount — 0.005 × 28 s.
    "PASB100_Plain": ship(100, slot(("PCY002_RegenCrew", "Default"))),
    # 200: two alternatives; the MAX wins (the replay does not name the loadout).
    "PASB200_Alternatives": ship(
        200,
        slot(("PCY002_RegenCrew", "Default"), ("PCY024_RegenCrewSuper", "Default")),
    ),
    # 300: a named variant, NOT the entity default.
    "PASB300_Named": ship(300, slot(("PCY002_RegenCrew", "C_Gold"))),
    # 400: only a non-regenCrew consumable — no entry at all.
    "PASB400_Smoke": ship(400, slot(("PCY999_SmokeGenerator", "Default"))),
    # 500: a regen that restores nothing — dropped, never a 0 coefficient.
    "PXSC500_Monster": ship(500, slot(("PCY025_ZeroRegen", "Default"))),
    # 600: no ShipAbilities at all.
    "PASB600_Bare": {"typeinfo": {"type": "Ship"}, "id": 600},
    # 700: the time-based fork's missing workTime leaves nothing to bake.
    "PASB700_TimeBased": ship(
        700, slot(("PCY059_RegenCrewPremium_TimeBased", "Default_TimeBased"))
    ),
    # 900/901: the clamp guards.
    "PASB900_Negative": ship(900, slot(("PCY900_NegativeRegen", "Default"))),
    "PASB901_Big": ship(901, slot(("PCY901_HugeRegen", "Default"))),
    # A non-ship entity carrying an id must never be baked.
    "PAG999_Gun": {"typeinfo": {"type": "Gun"}, "id": 999},
}

EXPECTED: dict[str, float] = {
    "100": 0.14,
    "200": 0.4,  # max(0.005 × 28, 0.02 × 20)
    "300": 0.1848,  # the named C_Gold variant, not Default
    # 900's negative product floors at 0 (no usable cap), so it has no entry.
    "901": 1.0,  # the clamp ceiling
}


def test_fixture_slice_bakes_the_expected_table() -> None:
    assert bake(FIXTURE) == EXPECTED


def test_zero_and_unusable_dust_is_dropped_not_baked() -> None:
    table = bake(FIXTURE)
    for dropped in ("400", "500", "600", "700", "900", "999"):
        assert dropped not in table, f"{dropped} must have no coefficient"
    assert all(value > 0 for value in table.values())


def test_slots_enumerate_bare_string_entries() -> None:
    # Legacy slices list a bare ability name (no variant) — the `Default`
    # fallback must still resolve it.
    legacy = {"ShipAbilities": {"AbilitySlot0": {"abils": ["PCY002_RegenCrew"]}}}
    assert slot_entries(legacy) == [("PCY002_RegenCrew", None)]
    table = bake(
        {
            "PCY002_RegenCrew": FIXTURE["PCY002_RegenCrew"],
            "PASB800_Legacy": {**legacy, "typeinfo": {"type": "Ship"}, "id": 800},
        }
    )
    assert table == {"800": 0.14}


def test_fraction_is_clamped_to_one() -> None:
    assert bake(FIXTURE)["901"] == 1.0


def test_main_writes_a_compact_id_sorted_table(tmp_path: Path) -> None:
    src = tmp_path / "GameParams.json"
    src.write_text(json.dumps(FIXTURE), encoding="utf-8")
    out = tmp_path / "repair_coefficients.json"

    assert main([str(src), "--out", str(out)]) == 0
    raw = out.read_text(encoding="utf-8")
    assert json.loads(raw) == EXPECTED
    # Compact + id-ordered + newline-terminated, like the sibling bakes.
    assert raw == json.dumps(EXPECTED, separators=(",", ":"), sort_keys=True) + "\n"
    assert list(json.loads(raw)) == ["100", "200", "300", "901"]


def test_main_reports_a_missing_gameparams(tmp_path: Path) -> None:
    assert main([str(tmp_path / "nope.json"), "--out", str(tmp_path / "o.json")]) == 2


def test_committed_table_shape() -> None:
    table = json.loads(DEFAULT_OUT.read_text(encoding="utf-8"))
    assert table, "the committed table must not be empty"
    for key, value in table.items():
        assert key.isdigit(), f"non-numeric ship id {key!r}"
        assert isinstance(value, (int, float)) and not isinstance(value, bool)
        assert 0.0 < float(value) <= 1.0, f"{key} has an out-of-range coefficient"


@pytest.mark.skipif(
    not DEFAULT_FULL.is_file(),
    reason="the GameParams extraction cache is absent (run `just extract`)",
)
def test_committed_table_matches_a_fresh_bake() -> None:
    full = json.loads(DEFAULT_FULL.read_text(encoding="utf-8"))
    committed = json.loads(DEFAULT_OUT.read_text(encoding="utf-8"))
    assert bake(full) == committed, (
        "repair_coefficients.json is stale — re-run "
        "scripts/extract_repair_coefficients.py and commit the output"
    )
