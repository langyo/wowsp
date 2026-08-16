"""Hunt WoWS domination scoring rules in GameParams.json.

Streams the 372MB GameParams JSON and reports every object whose keys or
name look like domination / capture / score rules (tick rates, points per
tick, battle types). We only keep small candidate sub-objects, so the
354MB monster never fully materialises in the report.
"""
from __future__ import annotations

import io
import json
import re
import sys

PATH = r"C:\Users\langy\AppData\Local\Temp\wows_extract\GameParams.json"

NAME_RE = re.compile(
    r"dominat|capture|score|control|basereg|game_logic|gamelogic|battle_type",
    re.I,
)
KEY_RE = re.compile(
    r"tick|score|point|perSecond|per_second|rate|domination|capture|captureSpeed|",
    re.I,
)


def walk(node, path, out, depth=0):
    if depth > 8:
        return
    if isinstance(node, dict):
        # does this dict itself look like a rules block?
        keys = set(node.keys())
        interesting = [k for k in keys if KEY_RE.search(k) and k]
        nameish = any(NAME_RE.search(str(node.get(k, ""))) for k in ("name", "id"))
        if (interesting or nameish) and len(node) < 40:
            scored = {k: node[k] for k in interesting}
            if scored or nameish:
                out.append((path, scored if scored else {k: node[k] for k in list(node)[:12]}))
        for k, v in node.items():
            if isinstance(v, (dict, list)):
                walk(v, f"{path}.{k}", out, depth + 1)
    elif isinstance(node, list):
        for i, v in enumerate(node[:80]):
            if isinstance(v, (dict, list)):
                walk(v, f"{path}[{i}]", out, depth + 1)


def main() -> None:
    print("loading ...", flush=True)
    with open(PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"entries: {len(data)}", flush=True)
    out = []
    # top-level names first
    for name in data.keys():
        if NAME_RE.search(name):
            out.append((f"TOP:{name}", "TOP-LEVEL ENTRY"))
    print(f"top-level name hits: {len(out)}", flush=True)
    # deep walk only inside promising top-level entries (avoid 300MB walk)
    for name, obj in data.items():
        if NAME_RE.search(name) or name in ("GameLogic", "BattleTypes", "interfaces"):
            walk(obj, name, out)
    for path, blob in out[:120]:
        print(path, "=>", json.dumps(blob, ensure_ascii=False)[:300])


if __name__ == "__main__":
    main()
