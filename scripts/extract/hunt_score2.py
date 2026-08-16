"""Locate 'domination_2point' and scoring keys inside GameParams.json."""
from __future__ import annotations

import json

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"

data = json.load(open(PATH, "r", encoding="utf-8"))
print("entries:", len(data))

# 1) which top-level entries mention domination modes in their values?
hits = []
for name, obj in data.items():
    if not isinstance(obj, dict):
        continue
    s = json.dumps(obj, ensure_ascii=False)
    if "domination_2point" in s or "domination2" in s.lower():
        hits.append(name)
print("entries containing 'domination_2point':", hits[:20])

# 2) any entry with a points-per-tick / tickTime style key?
tick_hits = []
for name, obj in data.items():
    if not isinstance(obj, dict):
        continue
    for k in obj.keys():
        lk = k.lower()
        if ("tick" in lk or "scoreper" in lk or "pointsper" in lk) and "control" not in lk:
            tick_hits.append((name, k, obj[k] if not isinstance(obj[k], (dict, list)) else type(obj[k]).__name__))
            break
print("tick/score-key entries:", tick_hits[:40])
