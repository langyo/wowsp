"""List every GameParams entry with a non-empty gameLogicConfig."""
from __future__ import annotations

import json

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"
data = json.load(open(PATH, "r", encoding="utf-8"))
for name, obj in data.items():
    if not isinstance(obj, dict):
        continue
    glc = obj.get("gameLogicConfig")
    if isinstance(glc, dict) and glc:
        s = json.dumps(glc, ensure_ascii=False)
        print(f"{name} ({len(s)} ch): {s[:500]}")
