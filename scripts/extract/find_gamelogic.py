"""Find all GameParams entries whose typeinfo marks them as game logic / battle types."""
from __future__ import annotations

import json

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"
data = json.load(open(PATH, "r", encoding="utf-8"))

for name, obj in data.items():
    if not isinstance(obj, dict):
        continue
    ti = obj.get("typeinfo") or obj.get("Typeinfo")
    if not isinstance(ti, dict):
        continue
    t = str(ti.get("type", "")) + " " + str(ti.get("species", "")) + " " + str(ti.get("name", ""))
    if "logic" in t.lower() or "dominat" in t.lower() or "battle" in t.lower():
        print(name, "=>", ti)
