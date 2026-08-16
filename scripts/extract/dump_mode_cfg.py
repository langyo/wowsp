"""Dump the domination config blocks from PCVE049_Classic."""
from __future__ import annotations

import json

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"
data = json.load(open(PATH, "r", encoding="utf-8"))
obj = data["PCVE049_Classic"]

def find(node, needle, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}"
            if isinstance(v, str) and needle in v:
                print(f"MATCH {p} = {v!r}")
            if isinstance(v, (dict, list)):
                if needle in k.lower():
                    print(f"KEY   {p}")
                find(v, needle, p)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            find(v, needle, f"{path}[{i}]")

print("top keys:", list(obj.keys()))
find(obj, "domination_2point")
find(obj, "domination")
