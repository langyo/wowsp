"""Find every GameParams object with a key or value mentioning domination /
controlPoint, and dump the small ones fully."""
from __future__ import annotations

import json

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"
data = json.load(open(PATH, "r", encoding="utf-8"))

def walk(node, path, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if "domination" in k.lower() or "controlpoint" in k.lower().replace("_", ""):
                out.append((f"{path}.{k}", v))
            if isinstance(v, (dict, list)):
                walk(v, f"{path}.{k}", out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, (dict, list)):
                walk(v, f"{path}[{i}]", out)

out: list[tuple[str, object]] = []
for name, obj in data.items():
    if isinstance(obj, dict):
        walk(obj, name, out)

print(f"hits: {len(out)}")
for path, v in out[:40]:
    s = json.dumps(v, ensure_ascii=False)
    print(f"{path} => {s[:400]}")
