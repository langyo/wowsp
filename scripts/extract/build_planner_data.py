#!/usr/bin/env python3
"""Extract shipyard build-planner data (signals / modernizations / commanders /
skill tree) plus real in-game icons.

Data sources:
  - GameParams.json (LOCALAPPDATA WoWSP-extract cache from `just extract`):
    signal modifiers, modernization catalog, unique commanders, per-class
    skill tiers, commander talent triggers.
  - wowsinfo/data `lang.json` (en/ja/zh_sg/zh_tw): official localized names
    and descriptions — `IDS_SKILL_*` (skills), `IDS_TITLE_PCM*`/`IDS_DESC_PCM*`
    (modernizations), `IDS_PCEF*` (signal flags).
  - WoWSFT-Kotlin `skills.json`: per-class skill-tree layout (tier + column).
  - WoWs-ShipBuilder repo assets: the square skill icons + signal flag icons
    (upstream repo since went dark — cache first; for skills the ShipBuilder
    set misses, the live client's own /gui/crew_commander/skills/*.png are
    real 60x60 square art: slice them from gui_0001.pkg by size+crc32).
  - gui_0001.pkg PNG slicing (size+crc32 matched against wows_meta.json):
    unique-commander portraits from gui/crew_commander/base.

Outputs (under packages/webui/src/):
  data/signals.json         data/modernizations.json
  data/commanders.json      data/skilltree.json
  data/ship_consumables.json
  res/images/signals/       res/images/skills/ (full refresh)
  res/images/commanders/    (downscaled portraits)

Usage:
    python build_planner_data.py [--realm {wg,lesta}] [--game PATH] [--pkg FILE]
        [--only NAME] [--no-icons] [--no-net]

With --realm lesta the script instead emits the Lesta captain datasets
(skilltree_lesta / skills_lesta / signals_lesta / commanders_lesta json plus
the skilltree_lesta.NOTES.md provenance sibling) from the Lesta GameParams
dump (--gameparams-lesta, default the WoWSP-extract cache) — fully offline,
never downloading: the WG caches (names + layout) and the Lesta dump + mo
caches must already exist. Lesta art (skill/flag PNGs from the Lesta client
packages) is extracted by scripts/extract/lesta_planner_icons.py.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import pathlib
import re
import struct
import sys
import zlib

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _common import find_game_path  # noqa: E402

GAMEPARAMS_JSON = (
    pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / ".local/share"))
    / "WoWSP-extract"
    / "GameParams.json"
)
META_JSON = (
    pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / ".local/share"))
    / "WoWSP-extract"
    / "wows_meta.json"
)
# Lesta (Мир кораблей) counterpart dump — a separate client's GameParams, put
# in the same cache dir by run.py's techtree-lesta step. The --realm lesta
# captain datasets also read the ru/zh mo caches dumped next to it.
GAMEPARAMS_LESTA_JSON = (
    pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / ".local/share"))
    / "WoWSP-extract"
    / "GameParams_lesta.json"
)
LESTA_MO_RU_JSON = GAMEPARAMS_LESTA_JSON.parent / "mo_ru.json"
LESTA_MO_ZH_JSON = GAMEPARAMS_LESTA_JSON.parent / "mo_zh.json"
# Upstream data sources (cached next to the GameParams cache).
WOWSFT_SKILLS_URL = (
    "https://raw.githubusercontent.com/alarian/WoWSFT-Kotlin/master/"
    "WoWSFT-App/src/main/resources/json/live/skills.json"
)
WOWSINFO_LANG_URL = "https://raw.githubusercontent.com/wowsinfo/data/master/live/app/lang/lang.json"
# WG online encyclopedia (ship basics for the offline fallback bundle) —
# application id mirrors wg_realm.rs (asia realm; CN is served from ASIA).
# WG public API application_id — a client-side public identifier issued by
# Wargaming for their open API, designed to be embedded in client
# applications; NOT a credential/secret. See
# https://developers.wargaming.net/ for registration.
WG_SHIPS_URL = (
    "https://api.worldofwarships.asia/wows/encyclopedia/ships/"
    "?application_id=447ec579e994976e39dec0e7d0bac644&language=en&limit=100"
    "&fields=ship_id,name,tier,type,nation,is_premium,is_special,description,"
    "default_profile,images"
)
# Real square skill/flag icons (the live client ships unusable 122×22 strips
# at gui/crew_commander/skills — the square art lives in the UI pak).
SHIPBUILDER_RAW = "https://raw.githubusercontent.com/WoWs-Builder-Team/WoWs-ShipBuilder/master/src/WoWsShipBuilder.Common/wwwroot/assets"

REPO = HERE.parents[1]
WEBUI = REPO / "packages" / "webui" / "src"
OUT_DATA = WEBUI / "data"
OUT_IMG = WEBUI / "res" / "images"

PNG_SIG = b"\x89PNG\r\n\x1a\n"

# Classic upgrade-mod catalog placement for entries whose GameParams `slot`
# is -1 (legacy fields). Keys are the icon-name family, values the 0-based
# slot; mirrors the in-game upgrade slots 1..6.
SLOT_BY_FAMILY = {
    "MainGun": 0, "Torpedo": 0, "Airplanes": 0, "AirDefense": 0,
    "SecondaryGun": 0, "MainWeapon": 0, "SecondaryWeapon": 0,
    "PowderMagazine": 0,
    "DamageControl": 1, "Engine": 1, "SteeringGear": 1, "Guidance": 1,
    "FireControl": 2, "LookoutStation": 4, "ConcealmentMeasures": 4,
    "SpeedBooster": 3, "SmokeGenerator": 3, "Spotter": 3, "CrashCrew": 3,
    "AirDefenseDisp": 3,
}
SLOT_BY_LEVEL = {"Mod_I": 0, "Mod_II": 2, "Mod_III": 5, "Mod_0": 1}


def entries_of(txt: str, marker: str, predicate) -> list[tuple[str, dict]]:
    """Slice the pretty-printed GameParams dict into top-level entries and
    yield (name, parsed-entry) for those whose JSON contains `marker` (cheap
    substring pre-filter) and match predicate(parsed)."""
    starts = [m.start() for m in re.finditer(r'\n  "', txt)]
    starts.append(len(txt))
    out = []
    for i in range(len(starts) - 1):
        seg = txt[starts[i]:starts[i + 1]]
        if marker not in seg:
            continue
        m = re.match(r'\n  "([^"]+)": ', seg)
        if not m:
            continue
        body = seg[m.end():].rstrip()
        while body.endswith(","):
            body = body[:-1].rstrip()
        try:
            entry = json.loads(body)
        except json.JSONDecodeError:
            continue
        if predicate(entry):
            out.append((m.group(1), entry))
    return out


def fetch_cached(url: str, name: str) -> pathlib.Path:
    cache = GAMEPARAMS_JSON.parent / name
    if not cache.exists():
        import urllib.request
        print(f"[planner] downloading {url} ...", flush=True)
        with urllib.request.urlopen(url, timeout=180) as r:
            cache.write_bytes(r.read())
    return cache


def load_lang() -> dict:
    data = json.loads(fetch_cached(WOWSINFO_LANG_URL, "wowsinfo_lang.json").read_text(encoding="utf-8"))
    return {"en": data["en"], "ja": data["ja"], "zh": data["zh_sg"], "tw": data["zh_tw"]}


def snake_upper(code: str) -> str:
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", code).upper()


def loc(lang: dict, key: str) -> dict:
    out = {}
    for tag, table in lang.items():
        v = table.get(key)
        if v:
            out[tag] = v
    return out


def skill_names(lang: dict, code: str) -> dict:
    s = snake_upper(code)
    return {"name": loc(lang, f"IDS_SKILL_{s}") or {}, "desc": loc(lang, f"IDS_SKILL_DESC_{s}") or {}}


def extract_signals(txt: str, lang: dict) -> list[dict]:
    rows = []
    for name, e in entries_of(txt, '"species": "Flags"',
                              lambda x: x.get("typeinfo", {}).get("species") == "Flags"):
        mods = e.get("modifiers") or {}
        if not mods:
            continue
        rows.append({
            "index": e.get("index", name[:6]),
            "name": name,
            "names": loc(lang, "IDS_" + name.upper()),
            "desc": loc(lang, "IDS_" + name.upper() + "_DESCRIPTION"),
            "flags": e.get("flags", []),
            "modifiers": mods,
            "sortOrder": e.get("sortOrder", 0),
        })
    rows.sort(key=lambda r: r["sortOrder"])
    return rows


def slot_for(name: str, raw_slot: int) -> int:
    if 0 <= raw_slot <= 5:
        return raw_slot
    stem = name.removeprefix("PCM").split("_", 1)[1] if "_" in name else name
    for fam, slot in SLOT_BY_FAMILY.items():
        if stem.startswith(fam + "_"):
            level = stem.rsplit("_", 1)[-1]
            if fam in ("MainGun", "Torpedo", "Airplanes", "AirDefense", "SecondaryGun"):
                # weapon families: level decides the later slots
                return SLOT_BY_LEVEL.get(level, slot)
            return slot
    return SLOT_BY_LEVEL.get(stem.rsplit("_", 1)[-1], 0)


def extract_modernizations(txt: str, lang: dict) -> list[dict]:
    rows = []
    for name, e in entries_of(txt, '"type": "Modernization"',
                              lambda x: x.get("typeinfo", {}).get("type") == "Modernization"):
        mods = e.get("modifiers") or {}
        if not mods:
            continue
        rows.append({
            "index": e.get("index"),
            "name": name,
            "names": loc(lang, "IDS_TITLE_" + name.upper()),
            "desc": loc(lang, "IDS_DESC_" + name.upper()),
            "slot": slot_for(name, e.get("slot", -1)),
            "modifiers": mods,
            "shiptype": e.get("shiptype", []),
            "nation": e.get("nation", []),
            "shiplevel": e.get("shiplevel", []),
            "tags": e.get("tags", []),
            "ships": e.get("ships", []),
        })
    rows.sort(key=lambda r: (r["slot"], r["index"]))
    return rows


GP_CLASS_BY_CODE = {
    "Battleship": "BB", "Cruiser": "CA", "Destroyer": "DD",
    "AirCarrier": "CV", "Submarine": "SS",
}

# Curated repairs for WoWSFT layout cells the current WG crew table cannot
# confirm (the upstream layout is a snapshot that drifts from the live
# client). Keyed by (GameParams class, tier, column) → the replacement code;
# the replacement must be learnable in the crew table at the cell's own tier
# or the override is ignored and the hole is reported instead of silently
# emitting a stale cell.
LAYOUT_CELL_OVERRIDES: dict[tuple[str, int, int], str] = {
    # build 13187581: the layout's CV tier-2 col-3 cell still teaches
    # PlanesConsumablesRegeneratehealthUpgrade — a skill WG removed (no
    # GameParams object, absent from the crew table), which punched a silent
    # hole into the committed tree. The live tree teaches
    # PlanesConsumablesActiveManeuveringUpgrade there (learnable, tier 2 for
    # every class). Lesta still ships the Regeneratehealth skill — its tree
    # override lives in LESTA_TREE_OVERRIDES below.
    ("AirCarrier", 2, 3): "PlanesConsumablesActiveManeuveringUpgrade",
}


def _flatten_levels(action: dict) -> dict:
    """Split an action dict into {base, levels: {1: {...}, 2: {...}, ...}}.
    `level_N` sub-dicts carry per-talent-level modifier values; sibling scalar
    numbers are base values. Keys ending in `UI` are the tooltip-display
    variants of their twin — the frontend prefers them for labels."""
    base: dict[str, float] = {}
    levels: dict[int, dict[str, float]] = {}
    for k, v in action.items():
        m = re.match(r"level_(\d+)$", k)
        if m and isinstance(v, dict):
            levels[int(m.group(1))] = {kk: vv for kk, vv in v.items() if isinstance(vv, (int, float))}
        elif isinstance(v, (int, float)):
            base[k] = v
    return {"base": base, "levels": {str(k): levels[k] for k in sorted(levels)}}


def extract_commanders(txt: str) -> list[dict]:
    rows = []
    for name, e in entries_of(txt, '"CrewPersonality"',
                              lambda x: x.get("typeinfo", {}).get("type") == "Crew"):
        p = e.get("CrewPersonality") or {}
        if not p.get("isUnique") or not p.get("personName"):
            continue
        talents = []
        for tid, t in (e.get("UniqueSkills") or {}).items():
            act = next((v for k, v in t.items()
                        if isinstance(v, dict) and v.get("type") == "EventTrigger"), None) or {}
            activ = next((v for k, v in act.items()
                          if isinstance(v, dict) and "type" in v and k.startswith("Activator")), None) or {}
            actions = [_flatten_levels(v) for k, v in t.items()
                       if isinstance(v, dict) and k.startswith("Unique")]
            talents.append({
                "id": tid,
                "triggerType": t.get("triggerType", act.get("type", "")),
                "activatorType": activ.get("type", ""),
                "maxTriggerNum": t.get("maxTriggerNum", -1),
                "activator": {k: v for k, v in activ.items() if isinstance(v, (int, float))},
                "actions": actions,
            })
        ships = p.get("ships") or {}
        # The captain's personal copy of the Crew Skills table flags the skill
        # codes they teach at enhanced ("epic") values — the in-game green
        # corner ribbon on the skill tree.
        epic = sorted(code for code, sk in (e.get("Skills") or {}).items() if sk.get("isEpic"))
        row = {
            "name": name,
            "person": p["personName"],
            "nations": ships.get("nation") or [],
            "talents": talents,
        }
        if epic:
            row["epicSkills"] = epic
        rows.append(row)
    rows.sort(key=lambda r: (not r["talents"], r["name"]))
    return rows


def extract_skilltree(txt: str, lang: dict, wowsft: dict) -> dict[str, list[dict]]:
    """Player-facing 4-tier skill tree per class with tier + column positions.

    Surface classes use the WoWSFT in-game layout (tier + column); Submarine
    is absent there, so its layout is the curated SS_LAYOUT table below —
    the live sub tree is the one 4-tier × 5-column grid (every other class
    has six columns). Its cell placement is cross-checked against the live
    client three ways: the crew table's per-skill `tier.Submarine` agrees
    with every row, the client's own recommended sub builds
    (CrewSkillRecomendationPresets — see crew_presets.json) teach
    TorpedoFloodingProbability / DefenseCritProbability / DetectionAiming,
    and the wiki's submarine tree (Ship:List_of_Commander_Skills) matches
    cell for cell. Note the crew table alone cannot derive the tree: it
    over-offers Submarine-tiered skills the live sub UI does not carry
    (Combat Maneuver Specialist, Basics of Survivability, Radio Location,
    Fire Prevention Expert, Fearless Brawler, Concealment Expert).

    Surface cells whose layout code the crew table cannot confirm are no
    longer dropped silently: a curated match from LAYOUT_CELL_OVERRIDES
    fills the cell (with a printed warning), anything else is reported as
    a dropped hole — the committed tree used to come out with a silent CV
    tier-2 hole because the WoWSFT layout still teaches a skill WG removed.
    """
    crew = None
    for _name, e in entries_of(txt, '"CrewPersonality"',
                               lambda x: x.get("typeinfo", {}).get("type") == "Crew"):
        crew = e
        break
    gp_tiers: dict[str, dict[str, int]] = {}
    if crew is not None:
        # NOTE: Trigger-prefixed codes are real learnable tree cells (隐蔽加速 /
        # 怒火满腔 / 近距离作战 / DD 肾上腺素飙升 …), not just triggered talents —
        # skipping them punched holes in the WoWSFT layout (BB rows 2 & 4).
        for code, sk in (crew.get("Skills") or {}).items():
            if not sk.get("canBeLearned"):
                continue
            tiers = {GP_CLASS_BY_CODE[gp]: t for gp, t in (sk.get("tier") or {}).items()
                     if gp in GP_CLASS_BY_CODE and isinstance(t, int) and 1 <= t <= 4}
            if tiers:
                gp_tiers[code] = tiers

    def named(code: str, tier: int, column: int) -> dict:
        n = skill_names(lang, code)
        return {"code": code, "tier": tier, "column": column, **n}

    out: dict[str, list[dict]] = {}
    cls_map = {"Battleship": "BB", "Cruiser": "CA", "Destroyer": "DD", "AirCarrier": "CV"}
    for gp, cls in cls_map.items():
        rows = wowsft.get(gp) or []
        flat = []
        for tier_skills in rows:
            for s in tier_skills:
                override = LAYOUT_CELL_OVERRIDES.get((gp, s["tier"], s["column"]))
                if s["name"] not in gp_tiers:
                    # The upstream layout snapshot teaches something the
                    # current crew table cannot confirm: either a removed
                    # skill (dead cell — the hole this loop once punched
                    # silently) or layout drift. Fill curated cells, report
                    # the rest.
                    tier = override is not None and gp_tiers.get(override, {}).get(cls)
                    if tier == s["tier"]:
                        print(f"!! skilltree: {cls} tier {s['tier']} col "
                              f"{s['column']}: layout cell {s['name']} is not "
                              f"learnable in the crew table — substituted "
                              f"{override}", file=sys.stderr)
                        flat.append(named(override, s["tier"], s["column"]))
                    else:
                        print(f"!! skilltree: {cls} tier {s['tier']} col "
                              f"{s['column']}: layout cell {s['name']} is not "
                              "learnable in the crew table — dropped (hole)",
                              file=sys.stderr)
                    continue
                if override is not None and override != s["name"]:
                    # The layout learned the crew table's code back: the
                    # curated override has gone stale.
                    print(f"!! skilltree: {cls} tier {s['tier']} col "
                          f"{s['column']}: layout cell is learnable again as "
                          f"{s['name']} — the curated override {override} is "
                          "obsolete", file=sys.stderr)
                flat.append(named(s["name"], s["tier"], s["column"]))
        out[cls] = flat

    # Submarine: the live tree as a full 4-tier × 5-column grid (tier,
    # column) — see the docstring for how the placement is corroborated.
    # Tiers still come from the crew table; a layout row that disagrees with
    # it is reported and skipped rather than emitted with the stale tier.
    SS_LAYOUT: dict[str, tuple[int, int]] = {
        "TriggerPingerReloadBuff":      (1, 0),  # Enhanced Sonar
        "TorpedoFloodingProbability":   (1, 1),  # Liquidator
        "TriggerConsRudderTimeCoeff":   (1, 2),  # Helmsman
        "DetectionAiming":              (1, 3),  # Priority Target
        "DetectionAlert":               (1, 4),  # Incoming Fire Alert
        "SubmarineBatteryCapacity":     (2, 0),  # Improved Battery Capacity
        "TriggerSeenTorpedoReload":     (2, 1),  # Torpedo Crew Training
        "SubmarineConsumablesDuration": (2, 2),  # Consumables Enhancements
        "DefenseCritProbability":       (2, 3),  # Preventive Maintenance
        "Maneuverability":              (2, 4),  # Last Stand
        "TriggerPingerSpeedBuff":       (3, 0),  # Enhanced Impulse Generator
        "SubmarineHoldSectors":         (3, 1),  # Sonarman
        "SubmarineConsumablesReload":   (3, 2),  # Consumables Specialist
        "SubmarineDangerAlert":         (3, 3),  # Watchful
        "ConsumablesAdditional":        (3, 4),  # Superintendent
        "ArmamentReloadSubmarine":      (4, 0),  # Adrenaline Rush
        "SubmarineTorpedoPingDamage":   (4, 1),  # Torpedo Aiming Master
        "TriggerConsSonarTimeCoeff":    (4, 2),  # Sonarman Expert
        "SubmarineBatteryBurnDown":     (4, 3),  # Improved Battery Efficiency
        "SubmarineSpeed":               (4, 4),  # Enlarged Propeller Shaft
    }
    out["SS"] = []
    for code, (tier, column) in SS_LAYOUT.items():
        ss_tier = (gp_tiers.get(code) or {}).get("SS")
        if ss_tier is None:
            print(f"!! skilltree: SS layout code {code} is not learnable by "
                  "Submarine in the crew table — skipped", file=sys.stderr)
            continue
        if ss_tier != tier:
            print(f"!! skilltree: SS layout tier for {code} ({tier}) disagrees "
                  f"with the crew table ({ss_tier}) — skipped", file=sys.stderr)
            continue
        out["SS"].append(named(code, tier, column))
    for rows in out.values():
        rows.sort(key=lambda r: (r["tier"], r["column"], r["code"]))
    return out


def extract_ship_consumables(txt: str) -> dict[str, list[str]]:
    """Per-hull consumable ability families, keyed by the ship's index token
    (the tech-tree `index`, which prefixes GameParams ship entry names).

    The WG API does not expose consumable loadouts, so the build planner
    cannot gate consumable-gated skills (空中之眼 needs a Spotter/Fighter
    catapult aircraft) without this table: every ShipAbilities slot carries
    `abils` pairs of `[abilityName, currency]`; the ability name's numeric
    prefix (`PCY010_` regular / `PXY117_` special-hull variants) is stripped
    and a trailing `Premium` collapsed, leaving the family (`Spotter`,
    `CrashCrew`, …). Mode-specific clones (Halloween/PVP/…) surface as their
    own suffixed families — the planner only matches exact `Spotter` /
    `Fighter`, so extra families are inert and missing hulls stay ungated.
    """
    out: dict[str, set[str]] = {}
    for name, e in entries_of(txt, '"ShipAbilities"',
                              lambda x: isinstance(x.get("ShipAbilities"), dict)):
        families: set[str] = set()
        for slot in (e.get("ShipAbilities") or {}).values():
            if not isinstance(slot, dict):
                continue
            for pair in slot.get("abils") or []:
                if not isinstance(pair, list) or not pair or not isinstance(pair[0], str):
                    continue  # defensive: abils entries are [name, currency] pairs
                family = re.sub(r"^P[XC]Y[0-9]+_", "", pair[0]).removesuffix("Premium")
                if family:
                    families.add(family)
        if families:
            out[name.split("_", 1)[0]] = families
    return {idx: sorted(fams) for idx, fams in sorted(out.items())}


# ── Lesta (Мир кораблей) realm emission (--realm lesta) ─────────────────────
# The Lesta client diverged from WG and its dump carries no crew table: no
# canBeLearned, no per-class tier, no grid column anywhere. Skills live in the
# PCOL001_CommonCrewSkills catalog (89 codes) and the PCOK001..091 modifier
# objects ({EPIC, REGULAR: {availableShipTypes, modifiers}, skillType}); the
# classic PCEF00x signal set is replaced by 24 tiered flags PCEF101..154
# (species=Flags, families × tiers 标准/特别/稀有/精英); commanders keep the
# CrewPersonality/UniqueSkills structure but have no per-captain Skills table
# (no isEpic → no epicSkills). Everything below is offline: the Lesta dump and
# the ru/zh mo caches come from the WoWSP-extract cache dir; the tree base and
# every display name come from the WG caches this module already reads.


# The one defensible grid delta vs the WG tree. Lesta's dump has no crew
# table, so there is no independent grid source — the other Lesta-only
# catalog codes stay unplaced rather than invented (see the NOTES sibling).
# The overridden cell must exist in the regenerated WG tree or the emission
# fails loudly instead of drifting silently.
LESTA_TREE_OVERRIDES: dict[tuple[str, int, int], str] = {
    # WG's dead CV tier-2 col-3 cell (see LAYOUT_CELL_OVERRIDES) is alive on
    # Lesta: PCOK052's skillType is PlanesConsumablesRegeneratehealthUpgrade
    # and the wowsinfo bridge still carries its name (WG's own loc had it
    # while the skill lived).
    ("AirCarrier", 2, 3): "PlanesConsumablesRegeneratehealthUpgrade",
}

# Lesta's tiered signal families (PCEF101..154), grid order: (family code,
# art stem = GameParams flags[0], NATO display word). The client's own ru
# loc spells the display names "<NATO> — <tier>" (mo_ru
# IDS_PCEF1xx_<FAM>_SIGNALFLAG_<tier>_<tier>); the NATO word is the family
# name in every language and only the tier word is translated (zh_sg keeps
# NATO words untranslated across the whole signal set — see the committed
# signals.json, where zh is "November Echo Setteseven").
LESTA_SIGNAL_FAMILIES: list[tuple[str, str, str]] = [
    ("HPBoost", "november", "November"),
    ("GM", "yankee", "Yankee"),
    ("ATBA", "foxtrot", "Foxtrot"),
    ("Speed", "sierra", "Sierra"),
    ("Consumable", "india", "India"),
    ("Shift", "charlie", "Charlie"),
]

# tier → (per-locale tier word, ru reference word the mo_ru cross-check
# expects). ru reference: Стандартный/Особый/Редкий/Элитный from mo_ru.
LESTA_TIER_WORDS: dict[int, tuple[dict[str, str], str]] = {
    1: ({"en": "Standard", "ja": "標準", "zh": "标准", "tw": "標準"}, "Стандартный"),
    2: ({"en": "Special", "ja": "特別", "zh": "特别", "tw": "特別"}, "Особый"),
    3: ({"en": "Rare", "ja": "レア", "zh": "稀有", "tw": "稀有"}, "Редкий"),
    4: ({"en": "Elite", "ja": "エリート", "zh": "精英", "tw": "精英"}, "Элитный"),
}


def extract_skilltree_lesta(
    wg_tree: dict[str, list[dict]], lang: dict
) -> dict[str, list[dict]]:
    """Lesta tree: the regenerated WG tree with LESTA_TREE_OVERRIDES applied.

    The Lesta dump has no crew table and no layout snapshot, so there is no
    independent grid source for its 15 Lesta-only skills — the 14 non-override
    codes stay unplaced and are documented in the NOTES sibling file instead
    of being invented into cells.
    """
    tree = {cls: [dict(r) for r in rows] for cls, rows in wg_tree.items()}
    for (gp, tier, column), code in LESTA_TREE_OVERRIDES.items():
        cls = GP_CLASS_BY_CODE[gp]
        cell = next(
            (r for r in tree[cls] if r["tier"] == tier and r["column"] == column), None
        )
        if cell is None:
            raise SystemExit(
                f"skilltree_lesta: base tree has no {cls} tier {tier} col "
                f"{column} cell to override with {code} — regenerate "
                "skilltree.json first"
            )
        print(f"[planner] skilltree_lesta: {cls} tier {tier} col {column}: "
              f"{cell['code']} -> {code}")
        cell.update({"code": code, **skill_names(lang, code)})
    return tree


def extract_skills_lesta(
    tree: dict[str, list[dict]], wg_skills: dict, lesta_txt: str
) -> tuple[dict[str, dict], dict]:
    """Lesta skill modifiers keyed like skills.json ({"modifiers", "trigger"}).

    Key set = the placed tree codes ∪ every PCOL001 catalog code that WG's
    skills.json also carries (matched case-insensitively — the two dumps
    spell a few codes differently, e.g. CallFighters vs Callfighters — with
    the WG spelling as the key so existing consumers keep resolving). Values
    come from the PCOK objects' REGULAR.modifiers; the Lesta dump has no
    trigger framework on these objects, so trigger stays null like WG's
    non-trigger rows. Returns (table, stats); stats carries the modifier-key
    drift vs WG for the PR body.
    """
    pcok: dict[str, dict] = {}
    catalog: list[str] = []
    for _name, e in entries_of(lesta_txt, '"REGULAR"',
                               lambda x: "REGULAR" in x and "skillType" in x):
        pcok[e["skillType"].lower()] = e
    for _name, e in entries_of(lesta_txt, '"PCOL001_CommonCrewSkills"',
                               lambda x: x.get("name") == "PCOL001_CommonCrewSkills"):
        catalog = [k for k in e if k not in ("id", "index", "name", "typeinfo")]
    wg_lower = {c.lower(): c for c in wg_skills}
    keys = sorted({r["code"] for rows in tree.values() for r in rows}
                  | {wg_lower[c.lower()] for c in catalog if c.lower() in wg_lower})
    out: dict[str, dict] = {}
    for code in keys:
        e = pcok.get(code.lower())
        if e is None:
            print(f"!! skills_lesta: {code} has no PCOK object — emitted with "
                  "empty modifiers", file=sys.stderr)
            out[code] = {"modifiers": {}, "trigger": None}
            continue
        out[code] = {"modifiers": e["REGULAR"].get("modifiers") or {}, "trigger": None}
    wg_mod_keys = {k for v in wg_skills.values() for k in (v.get("modifiers") or {})}
    lst_mod_keys = {k for v in out.values() for k in v["modifiers"]}
    stats = {
        "keys": len(out),
        "catalogCodes": len(catalog),
        "catalogAlsoInWgSkills": len({wg_lower[c.lower()] for c in catalog
                                      if c.lower() in wg_lower}),
        # Distinguish the two ways a key can come out empty: Lesta not
        # carrying the skill at all vs a trigger-style PCOK object whose
        # REGULAR.modifiers is legitimately {} (its logic is transient).
        "noPcokObject": sorted(k for k in keys if k.lower() not in pcok),
        "emptyModifiers": sorted(k for k, v in out.items() if not v["modifiers"]),
        "modifierKeysNewVsWg": sorted(lst_mod_keys - wg_mod_keys),
        "modifierKeysWgOnly": sorted(wg_mod_keys - lst_mod_keys),
    }
    return out, stats


def extract_signals_lesta(lesta_txt: str, mo_ru: dict, mo_zh: dict) -> list[dict]:
    """Lesta's 24 tiered signal flags (PCEF101..154), one row per flag.

    GameParams carries no sortOrder and no display names: sortOrder is the
    curated grid (LESTA_SIGNAL_FAMILIES order ×10 + tier); names follow the
    client's own ru pattern "<NATO> — <tier>" (LESTA_TIER_WORDS) and are
    cross-checked against mo_ru whenever it carries the key. desc stays
    empty — no *_DESCRIPTION keys exist for the PCEF1xx set in either mo
    cache; if one appears upstream it is picked up automatically.
    """
    fam_by_code = {fam: (i, group, nato)
                   for i, (fam, group, nato) in enumerate(LESTA_SIGNAL_FAMILIES)}
    rows = []
    for name, e in entries_of(lesta_txt, '"species": "Flags"',
                              lambda x: x.get("typeinfo", {}).get("species") == "Flags"):
        m = re.fullmatch(r"PCEF\d+_(.+)_SignalFlag_\d+", name)
        if m is None:
            print(f"!! signals_lesta: unrecognized Lesta flag name {name} — "
                  "skipped", file=sys.stderr)
            continue
        fam, tier = m.group(1), int(name.rsplit("_", 1)[-1])
        if fam not in fam_by_code or tier not in LESTA_TIER_WORDS:
            print(f"!! signals_lesta: {name}: unknown family {fam!r} / tier "
                  f"{tier} — skipped", file=sys.stderr)
            continue
        fam_idx, group, nato = fam_by_code[fam]
        flags = e.get("flags") or []
        if flags and flags[0] != group:
            print(f"!! signals_lesta: {name}: GameParams art stem {flags[0]!r} "
                  f"!= curated {group!r} — trusting GameParams", file=sys.stderr)
            group = flags[0]
        words, ru_word = LESTA_TIER_WORDS[tier]
        ref_key = "IDS_" + name.upper() + f"_{tier}"
        expected = f"{nato} — {ru_word}"
        # The client loc separates word and tier with a non-breaking space;
        # the curated names use a plain space (display, not data source).
        norm = lambda s: s.replace("\u00a0", " ")
        if mo_ru.get(ref_key) is not None and norm(mo_ru[ref_key]) != norm(expected):
            print(f"!! signals_lesta: {name}: mo_ru {ref_key} = "
                  f"{mo_ru[ref_key]!r} != curated pattern {expected!r}",
                  file=sys.stderr)
        desc = {}
        for tag, mo in (("ru", mo_ru), ("zh", mo_zh)):
            v = mo.get("IDS_" + name.upper() + "_DESCRIPTION")
            if v:
                desc[tag] = v
        rows.append({
            "index": e.get("index", name[:7]),
            "name": name,
            "names": {tag: f"{nato} — {words[tag]}" for tag in ("en", "ja", "zh", "tw")},
            "desc": desc,
            "sortOrder": fam_idx * 10 + tier,
            "modifiers": e.get("modifiers") or {},
            "group": group,
            "tier": tier,
            "family": fam,
        })
    rows.sort(key=lambda r: r["sortOrder"])
    return rows


def extract_commanders_lesta(lesta_txt: str) -> list[dict]:
    """Lesta's unique-commander roster in commanders.json shape.

    Same CrewPersonality/UniqueSkills structure as WG, so extract_commanders
    parses it unchanged; the Lesta dump has no per-captain Skills table (no
    isEpic), so epicSkills never appears. Portraits are deliberately not
    invented — the webui falls back to the initial-letter avatar.
    """
    rows = extract_commanders(lesta_txt)
    for r in rows:
        r.pop("epicSkills", None)
    return rows


def write_skilltree_lesta_notes(
    tree: dict[str, list[dict]],
    wg_tree: dict[str, list[dict]],
    catalog: list[str],
    wg_skills: dict,
    out_path: pathlib.Path,
) -> None:
    """Sibling provenance note for skilltree_lesta.json (machine-readable)."""
    wg_codes = {r["code"] for rows in wg_tree.values() for r in rows}
    lesta_codes = {r["code"] for rows in tree.values() for r in rows}
    catalog_lower = {c.lower() for c in catalog}
    lesta_codes_lower = {c.lower() for c in lesta_codes}
    wg_only = sorted(c for c in lesta_codes if c.lower() not in catalog_lower)
    wg_lower = {c.lower() for c in wg_skills}
    lesta_only = sorted(
        c for c in catalog
        if c.lower() not in wg_lower and c.lower() not in lesta_codes_lower
    )
    payload = {
        "realm": "lesta",
        "base": {
            "file": "skilltree.json",
            "generatedFrom": {
                "gameparams": "GameParams.json (WG client dump, WoWSP-extract cache)",
                "layout": "wowsft_skills.json (WoWSFT-Kotlin live layout cache)",
                "names": "wowsinfo_lang.json (IDS_SKILL_* bridge)",
            },
        },
        "override": [
            {
                "cell": {"class": "CV", "tier": 2, "column": 3},
                "wgCode": "PlanesConsumablesActiveManeuveringUpgrade",
                "lestaCode": "PlanesConsumablesRegeneratehealthUpgrade",
                "why": "WG removed the Regeneratehealth skill (dead WoWSFT "
                       "layout cell, substituted on WG per "
                       "LAYOUT_CELL_OVERRIDES); Lesta still ships it as "
                       "PCOK052. Names from wowsinfo "
                       "IDS_SKILL_PLANES_CONSUMABLES_REGENERATEHEALTH_UPGRADE.",
            }
        ],
        "knownUnknowns": {
            "wgOnlySkillsKeptAsApproximation": wg_only,
            "wgOnlySkillsNote":
                "Present in the Lesta tree only because the tree is a WG-tree "
                "copy; Lesta's PCOL001 catalog does not carry these codes, so "
                "treat those cells as approximate.",
            "lestaOnlySkillsNotPlaced": lesta_only,
            "lestaOnlySkillsNote":
                "In Lesta's PCOL001 catalog but absent from WG's skills.json "
                "and unplaced on any grid — no defensible (tier, column) "
                "source exists, so they are deliberately not invented into "
                "the tree.",
        },
    }
    text = (
        "# skilltree_lesta.json — provenance & caveats\n"
        "\n"
        "Machine-readable sibling note for the Lesta build-planner skill tree.\n"
        "Regenerate both together with:\n"
        "`python scripts/extract/build_planner_data.py --realm lesta`\n"
        "(offline: reads the WG + Lesta GameParams dumps and the ru/zh mo\n"
        "caches in the WoWSP-extract cache dir; never downloads).\n"
        "\n"
        "```json\n"
        + json.dumps(payload, ensure_ascii=False, indent=1) + "\n"
        "```\n"
    )
    out_path.write_text(text, encoding="utf-8")


# ── icon extraction (PNG blob slicing matched by size+crc against metadata) ──

def find_pkg_png(pkg_data: bytes, size: int, crc: int | None) -> bytes | None:
    """Return the raw PNG blob in the pkg matching (unpacked size, crc32)."""
    search = 0
    while True:
        start = pkg_data.find(PNG_SIG, search)
        if start < 0:
            return None
        cur = start + 8
        end = None
        while cur + 8 <= len(pkg_data):
            length = struct.unpack_from(">I", pkg_data, cur)[0]
            ctype = pkg_data[cur + 4:cur + 8]
            cur += 8 + length + 4
            if ctype == b"IEND":
                end = cur
                break
        if end is None:
            search = start + 1
            continue
        blob = pkg_data[start:end]
        if len(blob) == size and (crc is None or (zlib.crc32(blob) & 0xFFFFFFFF) == crc):
            return blob
        search = end


def png_to_webp(png: bytes, max_side: int | None = None) -> bytes:
    from PIL import Image
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    if max_side and max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=max_side is None, quality=85, method=6)
    return buf.getvalue()


def emit_lesta(args) -> int:
    """--realm lesta: the four Lesta captain datasets + the provenance note.

    Fully offline and deterministic: reads the WG GameParams + wowsinfo +
    WoWSFT caches (the base tree and every display name), the Lesta dump
    (--gameparams-lesta) and the ru/zh mo caches. Emits
    skilltree_lesta.json / skills_lesta.json / signals_lesta.json /
    commanders_lesta.json into OUT_DATA plus the skilltree_lesta.NOTES.md
    provenance sibling. --only / --no-net / --no-icons are WG-flow options
    and are rejected here to keep the emission contract exact.
    """
    if args.only or args.no_net or args.no_icons:
        print("error: --realm lesta emits the full captain dataset set; "
              "--only/--no-net/--no-icons are WG-flow options", file=sys.stderr)
        return 1
    lesta_path = pathlib.Path(args.gameparams_lesta)
    if not lesta_path.is_file():
        print(f"error: Lesta GameParams not found: {lesta_path}", file=sys.stderr)
        return 1
    for cache in (LESTA_MO_RU_JSON, LESTA_MO_ZH_JSON):
        if not cache.is_file():
            print(f"error: {cache} not found — dump the Lesta mo caches first",
                  file=sys.stderr)
            return 1

    print(f"[planner] lesta: loading WG base + {lesta_path.name} "
          f"({lesta_path.stat().st_size >> 20} MB) ...", flush=True)
    txt = GAMEPARAMS_JSON.read_text(encoding="utf-8")
    lesta_txt = lesta_path.read_text(encoding="utf-8")
    lang = load_lang()
    wowsft = json.loads(
        fetch_cached(WOWSFT_SKILLS_URL, "wowsft_skills.json").read_text(encoding="utf-8"))
    wg_tree = extract_skilltree(txt, lang, wowsft)
    wg_skills = json.loads((OUT_DATA / "skills.json").read_text(encoding="utf-8"))
    mo_ru = json.loads(LESTA_MO_RU_JSON.read_text(encoding="utf-8"))
    mo_zh = json.loads(LESTA_MO_ZH_JSON.read_text(encoding="utf-8"))

    tree = extract_skilltree_lesta(wg_tree, lang)
    (OUT_DATA / "skilltree_lesta.json").write_text(
        json.dumps(tree, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("[planner] skilltree_lesta.json: "
          + ", ".join(f"{c}={len(v)}" for c, v in tree.items()))
    cv23 = lambda t: next((r["code"] for r in t["CV"]
                           if r["tier"] == 2 and r["column"] == 3), None)
    print(f"[planner] CV tier-2 col-3: WG={cv23(wg_tree)} Lesta={cv23(tree)}")

    skills, stats = extract_skills_lesta(tree, wg_skills, lesta_txt)
    (OUT_DATA / "skills_lesta.json").write_text(
        json.dumps(skills, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n_new = len(stats["modifierKeysNewVsWg"])
    n_wg_only = len(stats["modifierKeysWgOnly"])
    print(f"[planner] skills_lesta.json: {stats['keys']} codes "
          f"(catalog {stats['catalogCodes']}, of which "
          f"{stats['catalogAlsoInWgSkills']} also in WG skills.json); "
          f"modifier keys new vs WG: {n_new}, WG-only: {n_wg_only}")
    if stats["noPcokObject"]:
        print("[planner] skills_lesta.json: no PCOK object for "
              + ", ".join(stats["noPcokObject"]))
    if stats["emptyModifiers"]:
        print("[planner] skills_lesta.json: empty REGULAR.modifiers (trigger "
              "skills) for " + ", ".join(stats["emptyModifiers"]))
    if stats["modifierKeysNewVsWg"]:
        print("[planner]   new modifier keys: "
              + ", ".join(stats["modifierKeysNewVsWg"]))

    signals = extract_signals_lesta(lesta_txt, mo_ru, mo_zh)
    (OUT_DATA / "signals_lesta.json").write_text(
        json.dumps(signals, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tiers = sorted({s["tier"] for s in signals})
    fams = sorted({s["family"] for s in signals})
    print(f"[planner] signals_lesta.json: {len(signals)} flags "
          f"({len(fams)} families x tiers {tiers})")

    commanders = extract_commanders_lesta(lesta_txt)
    (OUT_DATA / "commanders_lesta.json").write_text(
        json.dumps(commanders, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"[planner] commanders_lesta.json: {len(commanders)} unique commanders")

    catalog = []
    for _name, e in entries_of(lesta_txt, '"PCOL001_CommonCrewSkills"',
                               lambda x: x.get("name") == "PCOL001_CommonCrewSkills"):
        catalog = [k for k in e if k not in ("id", "index", "name", "typeinfo")]
    write_skilltree_lesta_notes(
        tree, wg_tree, catalog, wg_skills, OUT_DATA / "skilltree_lesta.NOTES.md")
    print(f"[planner] skilltree_lesta.NOTES.md: base + override + "
          f"{len(catalog)}-code catalog cross-reference")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--game", default=None, help="WoWS install root (default auto-detect)")
    ap.add_argument("--pkg", default=None, help="gui pkg file (default <game>/res_packages/gui_0001.pkg)")
    ap.add_argument("--portrait-size", type=int, default=256)
    ap.add_argument("--no-icons", action="store_true", help="data only, skip icon downloads/scan")
    ap.add_argument("--no-net", action="store_true", help="data only from GameParams (skip upstream names/layout)")
    ap.add_argument("--realm", choices=("wg", "lesta"), default="wg",
                    help="wg (default): the WG datasets as before; lesta: emit "
                         "the Lesta captain datasets (skilltree_lesta.json, "
                         "skills_lesta.json, signals_lesta.json, "
                         "commanders_lesta.json + skilltree_lesta.NOTES.md) "
                         "and skip the WG emission")
    ap.add_argument("--gameparams-lesta", default=str(GAMEPARAMS_LESTA_JSON),
                    help="Lesta GameParams.json for --realm lesta (default: "
                         "the WoWSP-extract cache dump)")
    ap.add_argument("--only", choices=("signals", "modernizations", "commanders", "skilltree",
                                       "consumables", "crew-presets", "ship-basics"),
                    help="regenerate a single dataset (skip the rest and all icon work)")
    args = ap.parse_args()

    if not GAMEPARAMS_JSON.exists():
        print(f"error: {GAMEPARAMS_JSON} not found — run `just extract` first", file=sys.stderr)
        return 1

    if args.realm == "lesta":
        return emit_lesta(args)

    print(f"[planner] loading {GAMEPARAMS_JSON} ...", flush=True)
    txt = GAMEPARAMS_JSON.read_text(encoding="utf-8")

    lang: dict = {}
    wowsft: dict = {}
    # commanders/consumables are pure GameParams datasets — no upstream names needed.
    if not args.no_net and args.only not in ("commanders", "consumables"):
        lang = load_lang()
        if args.only in (None, "skilltree"):
            wowsft = json.loads(
                fetch_cached(WOWSFT_SKILLS_URL, "wowsft_skills.json").read_text(encoding="utf-8"))

    OUT_DATA.mkdir(parents=True, exist_ok=True)

    if args.only in (None, "signals"):
        signals = extract_signals(txt, lang)
        (OUT_DATA / "signals.json").write_text(
            json.dumps(signals, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[planner] signals.json: {len(signals)} flags")

    if args.only in (None, "modernizations"):
        modernizations = extract_modernizations(txt, lang)
        (OUT_DATA / "modernizations.json").write_text(
            json.dumps(modernizations, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[planner] modernizations.json: {len(modernizations)} upgrades")

    if args.only in (None, "commanders"):
        commanders = extract_commanders(txt)
        (OUT_DATA / "commanders.json").write_text(
            json.dumps(commanders, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[planner] commanders.json: {len(commanders)} unique commanders")

    if args.only in (None, "skilltree"):
        skilltree = extract_skilltree(txt, lang, wowsft)
        (OUT_DATA / "skilltree.json").write_text(
            json.dumps(skilltree, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[planner] skilltree.json: " + ", ".join(f"{c}={len(v)}" for c, v in skilltree.items()))

    if args.only in (None, "crew-presets"):
        # The committed crew-presets bundle was decoded from the client's
        # scripts.zip with the pyc_deob reference toolchain (see
        # scripts/pyc_deob/crew_presets.py — the mini-VM validates but does
        # not regenerate the constructor-built step values). Re-validate it
        # against the current GameParams on every extraction pass.
        sys.path.insert(0, str(HERE.parent / "pyc_deob"))
        import crew_presets

        presets_path = OUT_DATA / "crew_presets.json"
        if not presets_path.exists():
            if args.only == "crew-presets":
                print("error: %s not found" % presets_path, file=sys.stderr)
                return 1
            print("[planner] no crew_presets.json — skipping validation", flush=True)
        else:
            presets = json.loads(presets_path.read_text(encoding="utf-8"))
            problems = crew_presets.validate(txt, presets)
            for problem in problems:
                print("!! %s" % problem, file=sys.stderr)
            if problems:
                return 1
            print("[planner] crew_presets.json validated: %d presets, %d groups"
                  % (len(presets["presets"]), len(presets["groups"])))

    if args.only in (None, "ship-basics"):
        # Full WG-API ship basics (default_profile included) as the offline
        # fallback bundle: ~4 MB covering every ship, shipped with lite
        # installs so the encyclopedia works without the WG API reachable.
        def wg_get(url: str):
            import time
            import urllib.request

            for attempt in range(4):
                try:
                    with urllib.request.urlopen(url, timeout=120) as r:
                        return json.load(r)
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(2 * (attempt + 1))

        # Version-stamped: a game patch changes ship data, so the cache must
        # not serve a stale bundle to the next extraction.
        # Same WG public API application_id as WG_SHIPS_URL above (and
        # WG_APP_ID in wg_realm.rs) — a client-side public identifier
        # designed to be embedded in client applications, NOT a
        # credential/secret; the three copies must stay in sync.
        version = wg_get(
            "https://api.worldofwarships.asia/wows/encyclopedia/info/"
            "?application_id=447ec579e994976e39dec0e7d0bac644&language=en"
        )["data"]["game_version"]
        basics_cache = GAMEPARAMS_JSON.parent / ("ships_basics_en_%s.json" % version)
        if basics_cache.exists():
            basics = json.loads(basics_cache.read_text(encoding="utf-8"))
        else:
            page1 = wg_get(WG_SHIPS_URL + "&page_no=1")
            pages = page1["meta"]["page_total"]
            ships = dict(page1["data"])
            for p in range(2, pages + 1):
                print("[planner] ships page %d/%d" % (p, pages), flush=True)
                ships.update(wg_get(WG_SHIPS_URL + "&page_no=%d" % p)["data"])
            basics = {"gameVersion": version, "ships": ships}
            basics_cache.write_text(json.dumps(basics, ensure_ascii=False), encoding="utf-8")
        # Curated overrides for the EMITTED bundle — the cache file above
        # stays raw API data (it is a source cache). ship_basics_curated.json
        # is { "<shipId>": { "name"?: ..., "description"?: ... } }; JSON
        # cannot carry comments, so the table is documented here: the WG
        # encyclopedia API's language=en catalog transliterates CN-exclusive
        # hulls (the RA3 Corona collab battleship PZSB909 / shipId 3341759696
        # comes through as the pinyin "Xuan Ming"), and the hanzi the bundle
        # should show was hand-fixed into it by #1258 — reapplying the table
        # at emit time keeps that fix alive through wholesale re-fetches.
        curated_path = HERE / "ship_basics_curated.json"
        if curated_path.exists():
            overrides = json.loads(curated_path.read_text(encoding="utf-8"))
            applied = 0
            for sid, patch in overrides.items():
                entry = basics["ships"].get(sid)
                if entry is None:
                    print("[planner] ship-basics: curated override for %s skipped (not in the API roster)"
                          % sid, flush=True)
                    continue
                entry.update(patch)
                applied += 1
            print("[planner] ship-basics: %d curated override%s applied (ship_basics_curated.json)"
                  % (applied, "" if applied == 1 else "s"))
        res_data = WEBUI / "res" / "data"
        res_data.mkdir(parents=True, exist_ok=True)
        (res_data / "ships_basics.json").write_text(
            json.dumps(basics, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("[planner] ships_basics.json: %d ships (%.1f MB)"
              % (len(basics["ships"]),
                 (res_data / "ships_basics.json").stat().st_size / 1e6))
        if args.only == "ship-basics":
            return 0

    if args.only in (None, "consumables"):
        consumables = extract_ship_consumables(txt)
        (OUT_DATA / "ship_consumables.json").write_text(
            json.dumps(consumables, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[planner] ship_consumables.json: {len(consumables)} hulls")

    if args.no_icons or args.only:
        return 0

    # ── icons ────────────────────────────────────────────────────────────────
    # Skill + signal-flag icons come from the WoWs-ShipBuilder assets (the
    # ShipBuilder repo is gone, so the fetch relies on the local cache).
    # Skills missing there — the Trigger family (隐蔽加速 / 怒火满腔 / …) — have
    # real 60x60 art in the live client at gui/crew_commander/skills/<stem>.png
    # inside gui_0001.pkg: slice by (size, crc32) like the portraits below.
    # Commander portraits are sliced from the game pkg by (size, crc32).
    skills_out = OUT_IMG / "skills"
    signals_out = OUT_IMG / "signals"
    skills_out.mkdir(parents=True, exist_ok=True)
    signals_out.mkdir(parents=True, exist_ok=True)

    codes = sorted({s["code"] for rows in skilltree.values() for s in rows})

    def icon_stem(code: str) -> str:
        return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", code).lower()

    print(f"[planner] downloading {len(codes)} skill icons + {len(signals)} flag icons ...", flush=True)
    import time
    import urllib.request

    def fetch_bytes(url: str, tries: int = 4) -> bytes:
        for attempt in range(tries):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    return r.read()
            except Exception:
                if attempt == tries - 1:
                    raise
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError("unreachable")

    got = 0
    for code in codes:
        dest = skills_out / f"{icon_stem(code)}.webp"
        if dest.exists():
            continue
        try:
            dest.write_bytes(png_to_webp(fetch_bytes(f"{SHIPBUILDER_RAW}/Skills/{icon_stem(code)}.png")))
            got += 1
        except Exception as exc:
            print(f"[planner] skill icon MISS {code}: {exc}")
    for s in signals:
        stem = s["name"]
        dest = signals_out / f"{stem}.webp"
        if dest.exists():
            continue
        try:
            dest.write_bytes(png_to_webp(fetch_bytes(f"{SHIPBUILDER_RAW}/signal_flags/{stem}.png")))
            got += 1
        except Exception as exc:
            print(f"[planner] signal icon MISS {stem}: {exc}")
    print(f"[planner] downloaded {got} icons from WoWs-ShipBuilder")

    # ── commander portraits from the game pkg ───────────────────────────────
    if not META_JSON.exists():
        print(f"error: {META_JSON} not found — run `just extract` first", file=sys.stderr)
        return 1
    meta = json.loads(META_JSON.read_text(encoding="utf-8"))

    def norm(s: str) -> str:
        return s.replace("_", "").lower()

    by_stem: dict[str, list[str]] = {}
    for e in meta:
        p = e.get("path", "")
        if p.startswith("/gui/crew_commander/base/") and p.endswith(".png") and not e.get("is_directory"):
            stem = p.rsplit("/", 1)[-1][:-4]
            by_stem.setdefault(norm(stem), []).append(p)

    portrait_out = OUT_IMG / "commanders"
    portrait_out.mkdir(parents=True, exist_ok=True)
    wanted: dict[str, str] = {}  # pkg path → output stem
    unmatched = []
    for c in commanders:
        key = norm(c["person"])
        cands = by_stem.get(key) or by_stem.get(norm(key.replace("h18", ""))) or []
        if not cands:
            unmatched.append(c["person"])
            continue
        pick = cands[0]
        if len(cands) > 1 and c["nations"]:
            for cand in cands:
                nation_dir = cand.split("/")[4] if cand.count("/") >= 4 else ""
                if nation_dir in c["nations"]:
                    pick = cand
                    break
        wanted[pick] = pick.rsplit("/", 1)[-1][:-4] + ".webp"
        c["portrait"] = wanted[pick]
    if unmatched:
        print(f"[planner] no portrait for {len(unmatched)}: {unmatched}")
        # drop portrait-less commanders from the roster
        commanders[:] = [c for c in commanders if "portrait" in c]
    (OUT_DATA / "commanders.json").write_text(
        json.dumps(commanders, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"[planner] commanders.json: {len(commanders)} with portraits")

    pkg_path = pathlib.Path(args.pkg) if args.pkg else (
        pathlib.Path(args.game) if args.game else pathlib.Path(find_game_path() or "")
    )
    if pkg_path.is_dir():
        pkg_path = pkg_path / "res_packages" / "gui_0001.pkg"
    if not pkg_path.exists():
        print(f"error: gui pkg not found ({pkg_path})", file=sys.stderr)
        return 1

    print(f"[planner] scanning {pkg_path.name} ({pkg_path.stat().st_size >> 20} MB) ...", flush=True)
    pkg_bytes = pkg_path.read_bytes()

    # Modernization icons: crc-matched slices from /gui/modernization_icons
    # (the previously committed set came from loose size-matching and
    # contained wrong blobs for several entries).
    mod_rows = [e for e in meta
                if e.get("path", "").startswith("/gui/modernization_icons/")
                and not e.get("is_directory")]
    written = 0
    for e in mod_rows:
        png = find_pkg_png(pkg_bytes, e["unpacked_size"], e.get("crc32"))
        if png is None:
            print(f"[planner] MISS {e['path']}")
            continue
        stem = e["path"].rsplit("/", 1)[-1][:-4]
        (OUT_IMG / "modernization" / (stem + ".webp")).write_bytes(png_to_webp(png))
        written += 1
    print(f"[planner] wrote {written} modernization icons")

    written = 0
    for path, stem in wanted.items():
        entry = next((e for e in meta if e["path"] == path), None)
        if entry is None:
            print(f"[planner] MISS {path}")
            continue
        png = find_pkg_png(pkg_bytes, entry["unpacked_size"], entry.get("crc32"))
        if png is None:
            print(f"[planner] MISS {path}")
            continue
        (portrait_out / stem).write_bytes(png_to_webp(png, max_side=args.portrait_size))
        written += 1
    print(f"[planner] wrote {written} portraits")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
