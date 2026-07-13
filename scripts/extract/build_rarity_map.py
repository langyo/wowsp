"""Build a ship_id → rarity map.

The authoritative rarity lives in GameParams' `RarityCategory.name` ("Common" /
"Uncommon" / "Rare" / "Epic" / "Legendary"), keyed there by the internal
`index` string (e.g. "PASB509"). WG's encyclopedia API exposes ships by
`ship_id` (an opaque numeric ID), and `GameParams.id` ≠ WG `ship_id`, so the
two cannot be joined directly.

The bridge is `wowsinfo/data`'s `wowsinfo.json` (live build), which lists every
ship keyed by `ship_id` and includes the matching `index`. So the join is:

    encyclopedia ship_id  →  (wowsinfo.json)  →  index
                                                      ↓
                              (GameParams.json, by index) → RarityCategory.name

Inputs:
  --gameparams  : unpacked GameParams.json (from `wowsunpack game-params`)
  --bridge      : wowsinfo.json (from github.com/wowsinfo/data, live/app/data)
  --out         : packages/webui/src/res/data/ship_rarity.json

The emitted `{ "<ship_id>": "<rarity>" }` ships with the app and is consumed by
`utils/shipRarityData.ts`, so the in-game colour band is correct without the
user needing to unpack anything.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gameparams", required=True)
    ap.add_argument("--bridge", required=True, help="wowsinfo.json (ship_id → index)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    print(f"loading bridge {args.bridge} ...", flush=True)
    bridge = json.loads(Path(args.bridge).read_text(encoding="utf-8"))
    ships = bridge.get("ships", {})
    # ship_id (as str key) → index
    shipid_to_index: dict[str, str] = {}
    for sid, s in ships.items():
        if isinstance(s, dict) and s.get("index"):
            shipid_to_index[str(sid)] = s["index"]
    print(f"bridge: {len(shipid_to_index)} ships with ship_id→index")

    print(f"loading gameparams {args.gameparams} ...", flush=True)
    gp = json.loads(Path(args.gameparams).read_text(encoding="utf-8"))
    # index → rarity
    index_to_rarity: dict[str, str] = {}
    dist: Counter[str] = Counter()
    for name, obj in gp.items():
        if not isinstance(obj, dict):
            continue
        ti = obj.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        idx = obj.get("index")
        rar = obj.get("RarityCategory")
        if not isinstance(idx, str) or not isinstance(rar, dict):
            continue
        rn = rar.get("name")
        if isinstance(rn, str):
            index_to_rarity[idx] = rn
            dist[rn] += 1
    print(f"gameparams: {len(index_to_rarity)} ships with index→rarity")
    print(f"  gameparams rarity distribution: {dict(dist.most_common())}")

    # Join: ship_id → index → rarity
    rarity_map: dict[str, str] = {}
    matched = 0
    missing_rarity = 0
    for sid, idx in shipid_to_index.items():
        rn = index_to_rarity.get(idx)
        if rn:
            rarity_map[sid] = rn
            matched += 1
        else:
            missing_rarity += 1
    print(f"join: {matched} matched, {missing_rarity} ship_ids with no rarity")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rarity_map, separators=(",", ":")), encoding="utf-8")
    final_dist = Counter(rarity_map.values())
    print(f"wrote {len(rarity_map)} entries to {out}")
    print(f"final rarity distribution: {dict(final_dist.most_common())}")


if __name__ == "__main__":
    main()
