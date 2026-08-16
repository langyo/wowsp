"""Dump gameLogicConfig from PCVE049_Classic (current Classic/randoms config)."""
from __future__ import annotations

import json

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"
data = json.load(open(PATH, "r", encoding="utf-8"))
obj = data["PCVE049_Classic"]["gameLogicConfig"]
print(json.dumps(obj, indent=1, ensure_ascii=False)[:8000])
