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
    python build_planner_data.py [--game PATH] [--pkg FILE] [--only NAME] [--no-icons] [--no-net]
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
    is absent there, so its layout derives from the Crew table's per-class
    `tier` field (learnable skills only), columns assigned in the crew
    table's own ordering.
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
                if s["name"] not in gp_tiers:
                    continue  # not a learnable skill in the current crew table
                flat.append(named(s["name"], s["tier"], s["column"]))
        out[cls] = flat

    # Submarine: WoWSFT predates subs, so derive the layout from the crew
    # table — every sub-exclusive skill (no surface class offers it) plus a
    # short curated list of surface skills the live sub tree also carries.
    surface_codes = {s["name"] for gp, rows in wowsft.items() for tier in rows for s in tier}
    sub_exclusive = [code for code, tiers in sorted(gp_tiers.items()) if "SS" in tiers and code not in surface_codes]
    sub_shared = [
        "DetectionDirection",        # Priority Target
        "DefenceFireProbability",    # Incoming Fire Alert
        "TriggerGmReload",           # Adrenaline Rush
        "ConsumablesAdditional",     # Superintendent
        "DefenceCritFireFlooding",   # Fire Prevention
        "DetectionVisibilityRange",  # Concealment Expert
    ]
    ss_codes = sub_exclusive + [c for c in sub_shared if c in gp_tiers and "SS" in gp_tiers[c]]
    out["SS"] = [named(code, gp_tiers[code]["SS"], i) for i, code in enumerate(ss_codes)]
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--game", default=None, help="WoWS install root (default auto-detect)")
    ap.add_argument("--pkg", default=None, help="gui pkg file (default <game>/res_packages/gui_0001.pkg)")
    ap.add_argument("--portrait-size", type=int, default=256)
    ap.add_argument("--no-icons", action="store_true", help="data only, skip icon downloads/scan")
    ap.add_argument("--no-net", action="store_true", help="data only from GameParams (skip upstream names/layout)")
    ap.add_argument("--only", choices=("signals", "modernizations", "commanders", "skilltree",
                                       "consumables", "crew-presets", "ship-basics"),
                    help="regenerate a single dataset (skip the rest and all icon work)")
    args = ap.parse_args()

    if not GAMEPARAMS_JSON.exists():
        print(f"error: {GAMEPARAMS_JSON} not found — run `just extract` first", file=sys.stderr)
        return 1

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
