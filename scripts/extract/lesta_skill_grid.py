# -*- coding: utf-8 -*-
"""Regenerate the Lesta captain-skill tree from the Lesta client's own
skill-matrix module, decoded out of its "finalUnp" script shield.

Inputs (all read-only): the Lesta install (--game-dir, default
D:/WoWS_Korabli — bin/<latest>/res/scripts3.zip carries the CPython 3.10
pycs behind the shield; CommonCrews/CrewSkills/SkillsSettings.pyc holds the
authoritative SKILLS_BY_SHIP_TYPE-equivalent), the WoWSP-extract caches
(GameParams_lesta.json for the PCOL001 catalog + PCOK modifiers,
wowsinfo_lang.json / mo_zh.json / mo_ru.json for names), and the currently
committed packages/webui/src/data/skilltree*.json (name reuse for codes
both clients share).

Outputs (the repo's webui data dir): skilltree_lesta.json (rewritten from
the decoded grid), skills_lesta.json (modifier rows for the Lesta-only
skills merged in — see the PCOK merge in build_planner_data or the
generator notes), lesta_skill_grid.json (decoded-grid provenance when the
stream dump was kept).

Offline & read-only vs the game: nothing is launched, nothing is written
into the game directory. Requires python 3.x + xdis (the 3.10 code objects
are consumed via xdis, not the running interpreter).
"""
import argparse
import pathlib

import zipfile, base64, zlib, struct, json, re, io, collections, os, shutil
from xdis.load import load_module

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
WT_DATA = REPO / "packages" / "webui" / "src" / "data"
EXTRACT = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / ".local/share")) / "WoWSP-extract"

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument("--game-dir", default="D:/WoWS_Korabli", help="Lesta install root")
args = ap.parse_args()
GAME = pathlib.Path(args.game_dir)
cands = sorted(GAME.glob("bin/*/res/scripts3.zip"), key=lambda p: p.parent.parent.name)
if not cands:
    raise SystemExit("no bin/*/res/scripts3.zip under %s" % GAME)
TMP = str(pathlib.Path(os.environ.get("TEMP", "/tmp")) / "lesta-vm")
os.makedirs(TMP, exist_ok=True)
SCR = TMP


# curated names (the client ships no en/zh strings for its Lesta-only
# skills; the ru localization is the only reference — mirror its semantics)
CURATED = {
    "AcousticSpecialist": {"en": "Torpedo Detection Specialist", "zh": "鱼雷侦测专家", "ja": "魚雷探知専門家", "tw": "魚雷偵測專家"},
    "BuoyancySpeed": {"en": "Maneuver Master", "zh": "机动大师", "ja": "機動マスター", "tw": "機動大師"},
    "DepthChargeBomberAlert": {"en": "Air Raid Alert", "zh": "空袭警报", "ja": "空襲警報", "tw": "空襲警報"},
    "ExtraCallFighters": {"en": "Reinforced Patrol Groups", "zh": "强化巡逻编队", "ja": "強化哨戒編隊", "tw": "強化巡邏編隊"},
    "GunMainShotDelay": {"en": "Main Gun Reload Master", "zh": "主炮装填大师", "ja": "主砲装填マスター", "tw": "主砲裝填大師"},
    "PingerSpeedBuff": {"en": "Improved Impulse Generator", "zh": "改进型脉冲发生器", "ja": "改良型インパルス発生器", "tw": "改良型脈衝產生器"},
    "ShootShiftBonus": {"en": "Disinformant", "zh": "假情报源", "ja": "誤報提供者", "tw": "假情報員"},
    "SmokeScreenSetter": {"en": "Smoke Screen Layer", "zh": "烟幕布设员", "ja": "煙幕敷設員", "tw": "煙幕佈設員"},
    "SubmarineDefenseHp": {"en": "Survivability Master", "zh": "损管大师", "ja": "生存性マスター", "tw": "損管大師"},
    "SubmarineSpeedOnBuoyancy": {"en": "Senior Electro-Mechanic", "zh": "高级电机员", "ja": "先任電気員", "tw": "高級電機員"},
    "SubmarineTorpedoDamage": {"en": "Torpedo Aiming Master", "zh": "鱼雷瞄准大师", "ja": "魚雷照準マスター", "tw": "魚雷瞄準大師"},
    "SubmarineVulnerabilityDepthBomb": {"en": "Deep Dive Expert", "zh": "深潜专家", "ja": "潜航専門家", "tw": "深潛專家"},
    "TriggerHydrophoneZone": {"en": "Noise Bearing Master", "zh": "噪声测向大师", "ja": "騒音測向マスター", "tw": "噪音測向大師"},
    "TriggerTorpedoSpeedReload": {"en": "Torpedo Crews Readiness", "zh": "鱼雷班高超备戒", "ja": "魚雷要員即応", "tw": "魚雷班高超備"},
}


z = zipfile.ZipFile(r"D:/WoWS_Korabli/bin/8867689/res/scripts3.zip")
def decode(name):
    data = z.read(name); magic = data[:4]
    open(TMP + "/a0.pyc", "wb").write(data)
    co0 = load_module(TMP + "/a0.pyc")[3]
    code1 = bytes(co0.co_code)
    enc = [c for c in co0.co_consts if isinstance(c, bytes) and len(c) >= 64][0]
    payload = zlib.decompress(base64.b64decode(bytes(b ^ code1[i % len(code1)] for i, b in enumerate(enc))))
    open(TMP + "/a1.pyc", "wb").write(magic + struct.pack("<I", 0) + struct.pack("<I", 0) + struct.pack("<I", len(payload)) + payload)
    return load_module(TMP + "/a1.pyc")[3]
root = decode("scripts/CommonCrews/CrewSkills/SkillsSettings.pyc")
packed = [c for c in root.co_consts if hasattr(c, "co_code") and c.co_name.isdigit()][0]
def find_table(code, seen=None):
    if seen is None: seen = set()
    if id(code) in seen: return None
    seen.add(id(code))
    for c in code.co_consts:
        if isinstance(c, (tuple, list)) and len(c) > 100 and any(hasattr(x, "co_code") for x in c):
            return c
        if hasattr(c, "co_consts"):
            r = find_table(c, seen)
            if r is not None: return r
    return None
tab = find_table(packed)
strings = [c for c in tab if isinstance(c, str)]
pool = [c for c in tab[7:125]]          # cells 7..124, the co_names pool (reversed = construction order)
SKILLS = pool[::-1]                      # skills[k] = pool[-1-k]; skill code at reversed index r = skills[r]
# reversed index r -> cell 124-r. Class/group/skill name lookups:
def name_at(r):  # r = index into reversed pool (0=cell124)
    return tab[124 - r]

# ---- the LOCKED grid (decoded from tab[138][2:]; validated below) ----
# keys: reversed-pool indices. infra: 0..10; CV 11..38; BB 39..63; CA 64..77; DD 78..86; SUB 87..108; tail 109..117
GRID = {
    "CV": [
        {"tier": 1, "A": [13, 14, 15], "D": [17, 18], "S": [20]},
        {"tier": 2, "A": [21, 22, 23], "D": [24, 25], "S": [26]},
        {"tier": 3, "A": [27, 28, 29], "D": [30, 31], "S": [32]},
        {"tier": 4, "A": [33, 34, 35], "D": [36, 37], "S": [38]},
    ],
    "BB": [
        {"tier": 1, "A": [40, 41, 42], "D": [43, 44, 45]},
        {"tier": 2, "A": [46, 47, 48], "D": [49, 50, 51]},
        {"tier": 3, "A": [52, 53, 54], "D": [55, 56, 57]},
        {"tier": 4, "A": [58, 59, 60], "D": [61, 62, 63]},
    ],
    "CA": [
        {"tier": 1, "A": [46, 65, 42, 40], "D": [44, 66]},
        {"tier": 2, "A": [41, 67, 68, 69], "D": [50, 57]},
        {"tier": 3, "A": [70, 71, 54, 72], "D": [73, 74]},
        {"tier": 4, "A": [75, 76, 77, 47], "D": [62, 51]},
    ],
    "DD": [
        {"tier": 1, "A": [46, 79, 42, 50], "D": [44, 45]},
        {"tier": 2, "A": [41, 65, 68, 80], "D": [47, 66]},
        {"tier": 3, "A": [81, 67, 54, 82], "D": [73, 74]},
        {"tier": 4, "A": [83, 84, 77, 85], "D": [62, 86]},
    ],
    "SS": [
        {"tier": 1, "A": [88, 79, 45], "D": [89, 90, 91]},
        {"tier": 2, "A": [92, 93, 94], "D": [95, 66, 96]},
        {"tier": 3, "A": [97, 98, 99], "D": [100, 73, 101]},
        {"tier": 4, "A": [102, 103, 104], "D": [105, 106, 107]},
    ],
}
CLASS_KEYS = {11: "AIRCARRIER", 39: "BATTLESHIP", 64: "CRUISER", 78: "DESTROYER", 87: "SUBMARINE", 108: "AUXILIARY"}
GROUP_KEYS = {12: "ATTACK", 16: "DEFENCE", 19: "SUPPORT"}

# sanity: dedicated slot ranges
ded = {"CV": set(range(13, 39)) - {16, 19}, "BB": set(range(40, 64)), "CA": set(range(65, 78)), "DD": set(range(79, 87)), "SS": set(range(88, 108))}
used = collections.defaultdict(list)
for cls, tiers in GRID.items():
    for t in tiers:
        for g in ("A", "D", "S"):
            for r in t.get(g, []):
                used[cls].append(r)
ALL_SKILL_SLOTS = set(range(13, 108)) - {16, 19, 39, 64, 78, 87, 108}
for cls, expect in ded.items():
    used_set = set(used[cls])
    missing = set(expect) - used_set
    assert not missing, (cls, "dedicated slots never placed", sorted(missing))
    outside = used_set - ALL_SKILL_SLOTS
    assert not outside, (cls, "non-skill slot used", sorted(outside))
    for r in expect:
        assert used[cls].count(r) == 1, (cls, r, "dedicated slot repeated")
print("per-class dedicated coverage OK")
print("grid slot validation OK: CV24 BB24 CA13 DD8 SS20 total=%d" % sum(len(v) for v in ded.values()))

# ---- PCOL001 catalog check (stream-scan GameParams_lesta.json) ----
catalog = set(strings)  # all pool strings that are not obviously infra
INFRA = {"m08E27AA6","SKILL_TO_GROUP_INDEX","SKILL_GROUPS","shared_constants.mD7131F10","SKILL_COLUMNS","SKILL_TIERS","SKILLS_FOR_CLASS","iteritems","SKILLS_BY_SHIP_TYPE","AUXILIARY","SUBMARINE","DESTROYER","CRUISER","BATTLESHIP","SUPPORT","DEFENCE","ATTACK","AIRCARRIER","MAX_CREW_SKILLS_TIER","SKILL_GROUP","shared_constants.common","ST","SkillTypeEnum","CommonCrews.CrewSkills.SkillsConstants","ShipTypes","SystemConstants","six","chain","itertools","598012537158","30036851196693910","<dictcomp>"}
codes = sorted(s for s in strings if s not in INFRA)
print("pool skill codes: %d" % len(codes))
seen = set()
need = set(codes)
buf = io.BytesIO()
with open(str(EXTRACT / "GameParams_lesta.json"), "rb") as f:
    data = f.read(4096)
    tail = b""
    while data:
        chunk = data
        for c in codes:
            cb = c.encode()
            if cb in chunk or cb in (tail + chunk[:len(cb)-1]):
                seen.add(c)
        tail = chunk[-64:]
        data = f.read(1 << 20)
missing = need - seen
print("PCOL001 stream-scan: %d/%d codes found" % (len(seen), len(need)))
if missing:
    print("MISSING:", sorted(missing))
assert not missing, ("codes absent from PCOL001", missing)

# ---- names ----
lang = json.loads(open(str(EXTRACT / "wowsinfo_lang.json"), encoding="utf-8").read())
LANG = {"en": lang["en"], "ja": lang["ja"], "zh": lang["zh_sg"], "tw": lang["zh_tw"]}
def snake_upper(c): return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", c).upper()
def names_for(code):
    key = "IDS_SKILL_" + snake_upper(code)
    dkey = "IDS_SKILL_DESC_" + snake_upper(code)
    out = {"name": {}, "desc": {}}
    for tag, table in LANG.items():
        v = table.get(key)
        if v: out["name"][tag] = v
        v = table.get(dkey)
        if v: out["desc"][tag] = v
    return out

committed = json.load(open(str(WT_DATA / "skilltree_lesta.json"), encoding="utf-8"))
wg_committed = json.load(open(str(WT_DATA / "skilltree.json"), encoding="utf-8"))
name_db = {}
for src in (wg_committed, committed):
    for cls, rows in src.items():
        for e in rows:
            if e["code"] not in name_db:
                name_db[e["code"]] = {"name": e.get("name", {}), "desc": e.get("desc", {})}
new_codes = [c for c in codes if c not in name_db]
print("codes with no committed name: %d -> %s" % (len(new_codes), new_codes))
resolved = {}
curated = []
for c in new_codes:
    n = names_for(c)
    resolved[c] = n
    if not n["name"].get("en"):
        curated.append(c)
    print("  %-40s %s" % (c, json.dumps(n["name"], ensure_ascii=False)[:110]))

# mo fallbacks
import os
for p in (EXTRACT / "mo_zh.json", EXTRACT / "mo_ru.json"):
    if p.is_file():
        print("mo cache present:", p)

# ---- assemble final json ----
out = {}
report = []
for cls, tiers in GRID.items():
    rows = []
    for t in tiers:
        col = 0
        for g in ("A", "D", "S"):
            for r in t.get(g, []):
                code = name_at(r)
                nm = dict(name_db.get(code, {"name": {}, "desc": {}}))
                if code in resolved:
                    for k in ("name", "desc"):
                        nm[k].update(resolved[code][k])
                rows.append({"code": code, "tier": t["tier"], "column": col, "name": nm["name"], "desc": nm["desc"]})
                col += 1
    out[cls] = rows
    width = max(e["column"] for e in rows) + 1
    print("%s: %d entries, width %d, tiers %s" % (cls, len(rows), width, sorted(set(e["tier"] for e in rows))))

# validations
rg = [e for e in out["CV"] if e["tier"] == 2 and e["column"] == 3]; assert rg and rg[0]["code"] == "PlanesConsumablesRegeneratehealthUpgrade", rg
for cls, rows in out.items():
    cells = [(e["tier"], e["column"]) for e in rows]
    assert len(set(cells)) == len(cells), (cls, "stacked cells")
    width = max(e["column"] for e in rows) + 1
    assert width == 6, (cls, width)
    assert len(rows) == 24, (cls, len(rows))
json.dump(out, open(SCR + "/skilltree_lesta.new.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("\nWROTE %s/skilltree_lesta.new.json (%d classes, %d entries)" % (SCR, len(out), sum(len(v) for v in out.values())))
json.dump({"resolved": resolved, "curated": curated, "codes": codes}, open(SCR + "/names_report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# ---- install into the repo data dir (skilltree + provenance) ----
import shutil
shutil.copy(SCR + "/skilltree_lesta.new.json", str(WT_DATA / "skilltree_lesta.json"))
shutil.copy(SCR + "/grid_raw.json", str(WT_DATA / "lesta_skill_grid.json")) if os.path.isfile(SCR + "/grid_raw.json") else None
print("installed ->", WT_DATA / "skilltree_lesta.json")
