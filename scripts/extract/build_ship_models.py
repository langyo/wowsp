#!/usr/bin/env python3
"""Build ship_models.json — a shipId → base model name map.

Many ships are **skins** of a base ship (ARP/AZUR/FBO/Black/collab variants)
and share the same 3D hull model. GameParams exposes this via:

  - `originShipName` (the base ship's GameParams key, e.g. "PJSB018_Yamato_1944")
  - `A_Hull.model` (the shared `.model` path — collab and base resolve to the
    same file, e.g. "content/.../JSB039_Yamato_1945/JSB039_Yamato_1945.model")

This script walks GameParams once and emits, per ship:

  { "<shipId>": { "index", "name", "baseName", "originShipName", "hullModel" } }

where `baseName` is the display name the frontend should use to resolve a GLB
— for a skin ship, that's the base ship's readable name (so the skin reuses
the base's baked model file). For a non-skin ship, `baseName` equals its own
name.

The frontend `modelLoader.resolveShipModelByShipId` reads this map to skip the
skin model and load the base instead, letting us delete ~50 duplicate GLBs.

Usage:
  python scripts/extract/build_ship_models.py \
      --gameparams <GameParams.json> --bridge <wowsinfo.json> \
      --out packages/webui/src/res/data/ship_models.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def _readable_name(gp_key: str) -> str:
    """PJSB018_Yamato_1944 → 'Yamato'; PASB017_Montana_1945 → 'Montana'.

    Mirrors convert_ship.py's filename logic: strip the type prefix (PJSA…),
    the leading tier number, and any trailing year/suffix tokens.
    """
    stem = gp_key
    for pre in ("PJSB", "PJSC", "PJSD", "PJSS", "PASA", "PASB", "PASC", "PASD",
                "PASS", "PESA", "PFSB", "PFSA", "PCSA", "PISB", "PISA",
                "PISD", "PSSA", "PSSB", "PBSD", "PBSA", "PRSB", "PRSA",
                "PRSD", "PSSB", "PXSB", "PJSB", "PJSA", "PESC", "PESB"):
        if stem.startswith(pre):
            stem = stem[len(pre):]
            break
    parts = stem.split("_")
    # Drop a leading numeric token (tier index) and pure-year tokens.
    cleaned = [p for p in parts if p and not p.isdigit() and not re.fullmatch(r"19\d{2}|20\d{2}", p)]
    # Prefer the first alphabetic token (the ship name).
    for p in cleaned:
        if p and p[0].isalpha():
            return p
    return cleaned[-1] if cleaned else (parts[-1] if parts else "ship")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gameparams", required=True, type=Path)
    ap.add_argument("--bridge", required=True, type=Path, help="wowsinfo.json (ship_id↔index)")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    # Bridge: ship_id (int) → index (e.g. "PJSB018") + region for naming.
    bridge = json.loads(args.bridge.read_text(encoding="utf-8"))
    ships = bridge.get("ships", {})
    if isinstance(ships, list):
        ships = {s["id"]: s for s in ships}
    # index → shipId
    index_to_id = {}
    for sid, s in ships.items():
        idx = s.get("index")
        if idx:
            index_to_id[idx] = int(sid) if isinstance(sid, str) else sid

    # GameParams: stream-parse the top-level dict (it's huge, ~350 MB).
    # Each top-level value is a component/ship/etc.; ships have
    # typeinfo.type == "Ship". We only need ships with originShipName or a
    # shared hull model.
    print(f"[ship_models] parsing GameParams ({args.gameparams.stat().st_size >> 20} MB) ...")
    gp = json.loads(args.gameparams.read_text(encoding="utf-8"))

    # Collect per-key: {key → {originShipName, hullModel}}
    key_info = {}
    skin_count = 0
    for key, obj in gp.items():
        if not isinstance(obj, dict):
            continue
        ti = obj.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        origin = obj.get("originShipName")
        hull = obj.get("A_Hull")
        hull_model = None
        if isinstance(hull, dict):
            hull_model = hull.get("model")
        key_info[key] = {"originShipName": origin, "hullModel": hull_model}
        if origin and origin != key:
            skin_count += 1

    # Resolve base readable name for every ship that has a shipId via the bridge.
    out: dict[str, dict] = {}
    resolved = 0
    deduped = 0
    for idx, ship_id in index_to_id.items():
        # Find the GameParams key for this index. Keys look like "PJSB018_Yamato_1944".
        # Match by index prefix.
        gp_key = None
        for k in key_info:
            if k.startswith(idx + "_") or k == idx:
                gp_key = k
                break
        if gp_key is None:
            continue
        info = key_info[gp_key]
        origin = info["originShipName"]
        # baseName: skin → resolve origin's readable name; else own readable name.
        base_name = _readable_name(gp_key)
        if origin and origin in key_info and origin != gp_key:
            base_name = _readable_name(origin)
            deduped += 1
        bridge_entry = ships.get(str(ship_id)) or ships.get(ship_id)
        name = (bridge_entry or {}).get("name", "")
        out[str(ship_id)] = {
            "index": idx,
            "name": name,
            "baseName": base_name,
            "originShipName": origin,
            "hullModel": info["hullModel"],
        }
        resolved += 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[ship_models] wrote {args.out} ({args.out.stat().st_size // 1024} KB)")
    print(f"[ship_models] {resolved} ships, {deduped} redirect to a base model, "
          f"{skin_count} skin ships detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
