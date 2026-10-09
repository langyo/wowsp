"""Build the Lesta ship overlay for the encyclopedia (ships_lesta.json).

The WG API is the encyclopedia's primary source and knows nothing about the
research lines Lesta grew after the split — those ships exist only in the
Lesta client's files. This script derives the missing entries from the
Lesta client's decoded GameParams + its text tables, in the exact shape the
webui overlay consumes (see packages/webui/src/utils/shipsLesta.ts):

    { "gameVersion": "<version stamp>",
      "ships": { "<shipId>": { "index", "tier", "type", "nation",
                               "names": { "<langLoc>": "..." },
                               "descriptions": { ... },
                               "defaultProfile": { WG snake_case shape } } } }

Scope: the Lesta tech tree's ships whose index is absent from the WG tree
(premium/special side leaves are WG-tree-only, so nothing else needs an
overlay entry). The default_profile is synthesized from the top hull's
GameParams numbers — the same fields the ship cards and the build planner
gate on (hull.health / mobility.max_speed / concealment detect distances,
torpedo / AA / depth-charge presence) — NOT the WG API's full tree: sections
the sources cannot derive are simply omitted and degrade to blank rows.

Optionally (--merge-names) the SAME names merge into ship_names.json — but
for EVERY Lesta ship absent from the WG roster (not just the tree set), so
replay rosters and dashboards resolve Lesta-cluster premiums/collabs too.
The WG entries are never touched.

Sources:
  --gameparams  decoded Lesta GameParams.json (wowsunpack game-params from
                the Lesta client, list- or namespace-wrapped roots accepted)
  --texts       { "<langLoc>": { "<IDS key>": "<text>" } } — e.g. the
                lesta_texts.json produced from the client's gettext catalogs
                (ru-RU at least; IDS_<index> = name, IDS_<index>_DESCR =
                description)
  --mo          alternative to --texts: one gettext .mo file (e.g. the
                Lesta install's bin/<build>/res/texts/ru/LC_MESSAGES/
                global.mo), tagged with --mo-lang (default ru-RU)
  --curated     hand-maintained { "<index>": { "<langLoc>": "<name>" } }
                translations (scripts/extract/lesta_names_curated.json) —
                the client only localizes ru, so zh/ja names are curated

Name priority per language: curated > client texts > (en-US) the GameParams
entry-key working name.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_techtree import _params_root  # noqa: E402


def _nation_from_gameparams(nation: str) -> str:
    renames = {"united_kingdom": "uk", "russia": "ussr", "europe": "pan_europe"}
    r = (nation or "").lower()
    return renames.get(r, r)


def _entry_display_name(key: str, index: str) -> str:
    suffix = key[len(index):].lstrip("_") if key.startswith(index) else ""
    return suffix.replace("_", " ") if suffix else f"IDS_{index}"


def _hull_components(entry: dict) -> list[dict]:
    """The ship's hull upgrade modules, structurally: dict values carrying
    the hull numbers (health/maxSpeed/visibilityFactor) under a Hull-ish
    key (A_Hull, B_Hull_1941, …)."""
    out = []
    for key, val in entry.items():
        if not isinstance(val, dict) or "Hull" not in key:
            continue
        if any(f in val for f in ("health", "maxSpeed", "visibilityFactor")):
            out.append(val)
    return out


def _upgrade_types(entry: dict) -> set[str]:
    """The ship's ShipUpgradeInfo component types (ucType values like
    '_Torpedoes' / '_AirDefense' / '_DepthCharges') — the most reliable
    capability probe across client generations: torpedo launchers are named
    ABC1_610-style (no 'Torpedo' in the key) on Lesta."""
    sui = entry.get("ShipUpgradeInfo")
    if not isinstance(sui, dict):
        return set()
    return {
        u.get("ucType") for u in sui.values() if isinstance(u, dict) and isinstance(u.get("ucType"), str)
    }


def _synthesize_profile(entry: dict) -> dict:
    """A WG-API-shaped snake_case profile from the top hull's numbers plus
    capability presence. Only the sections the consumers actually gate on
    are emitted; anything underivable is left out."""
    hulls = _hull_components(entry)
    if not hulls:
        return {}
    top = max(hulls, key=lambda h: h.get("health") or 0)
    profile: dict = {"hull": {}, "mobility": {}, "concealment": {}}

    health = top.get("health")
    if isinstance(health, (int, float)) and health > 0:
        profile["hull"]["health"] = round(float(health))
    speed = top.get("maxSpeed")
    if isinstance(speed, (int, float)) and speed > 0:
        profile["mobility"]["max_speed"] = round(float(speed), 1)
    vis = top.get("visibilityFactor")
    if isinstance(vis, (int, float)) and vis > 0:
        profile["concealment"]["detect_distance_by_ship"] = round(float(vis), 1)
    vis_plane = top.get("visibilityFactorByPlane")
    if isinstance(vis_plane, (int, float)) and vis_plane > 0:
        profile["concealment"]["detect_distance_by_plane"] = round(float(vis_plane), 1)

    # Capability presence for the planner's skill gating (skillTree.ts reads
    # exactly these): torpedoes / AA dps / depth charges. The presence
    # markers are deliberately EMPTY objects — the gating tests "has(...)" —
    # so they must bypass the empty-section sweep below.
    upgrades = _upgrade_types(entry)
    markers: list[str] = []
    if "_Torpedoes" in upgrades or any("Torpedo" in k for k in entry):
        markers.append("torpedoes")
    if "_DepthCharges" in upgrades or any("DepthCharge" in k or "depthCharge" in k for k in entry):
        markers.append("depth_charge")
    aa_dps = _aa_defense(entry)
    if aa_dps is not None:
        profile["anti_aircraft"] = {"defense": aa_dps}

    for section in ("hull", "mobility", "concealment"):
        if not profile[section]:
            del profile[section]
    out = {k: v for k, v in profile.items() if v}
    for marker in markers:
        out[marker] = {}
    return out


def _aa_defense(entry: dict) -> float | None:
    """Total continuous AA dps across the ship's air-defense components
    (both the AirDefense and AirDefence spellings appear across client
    generations). Sums over every hull variant, so it is an upper bound —
    the only consumer today is the planner's `> 0` capability gate, which
    an upper bound serves correctly. Returns None when the ship carries
    none."""
    total = 0.0
    seen = False
    for key, val in entry.items():
        if not isinstance(val, dict) or "AirDefen" not in key:
            continue
        seen = True
        for sub in val.values():
            if not isinstance(sub, dict):
                continue
            for dmg_key in ("areaDamage", "damage"):
                dmg = sub.get(dmg_key)
                if isinstance(dmg, (int, float)) and dmg > 0:
                    total += float(dmg)
                    break
    return round(total, 1) if seen and total > 0 else (0.0 if seen else None)


def _load_mo(path: Path) -> dict[str, str]:
    """Parse a gettext .mo (little-endian) into {msgid: msgstr} — the same
    minimal reader extract_ship_names.py uses."""
    data = path.read_bytes()
    if len(data) < 28 or struct.unpack("<I", data[:4])[0] != 0x950412DE:
        raise SystemExit(f"not a .mo file: {path}")
    _, n, off_o, off_t, _, _ = struct.unpack("<6I", data[4:28])
    out: dict[str, str] = {}
    for i in range(n):
        ol, oo = struct.unpack("<2I", data[off_o + i * 8: off_o + i * 8 + 8])
        tl, to = struct.unpack("<2I", data[off_t + i * 8: off_t + i * 8 + 8])
        msgid = data[oo: oo + ol].decode("utf-8", errors="replace")
        msgstr = data[to: to + tl].decode("utf-8", errors="replace")
        out[msgid] = msgstr
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gameparams", required=True, help="decoded Lesta GameParams.json")
    ap.add_argument("--texts", help="{ langLoc: { IDS key: text } } JSON")
    ap.add_argument("--mo", type=Path, help="gettext .mo alternative to --texts (one language)")
    ap.add_argument("--mo-lang", default="ru-RU", help="lang-loc tag for --mo (default ru-RU)")
    ap.add_argument("--curated", help="{ index: { langLoc: name } } curated translations")
    ap.add_argument("--lesta-tree", required=True, help="tech_tree_lesta.json (scope source)")
    ap.add_argument("--wg-tree", required=True, help="tech_tree.json (WG indexes to exclude)")
    ap.add_argument("--version", default="lesta", help="version stamp for gameVersion")
    ap.add_argument("--out", required=True, help="ships_lesta.json output path")
    ap.add_argument(
        "--merge-names",
        help="ship_names.json to merge into — every Lesta ship absent from the "
             "WG roster (the offline name DB replay/dashboard lookups consult)",
    )
    args = ap.parse_args()

    print(f"[lesta-overlay] loading gameparams {args.gameparams} ...", flush=True)
    gp = _params_root(json.loads(Path(args.gameparams).read_text(encoding="utf-8")))
    if args.texts:
        texts: dict[str, dict[str, str]] = json.loads(Path(args.texts).read_text(encoding="utf-8"))
        if texts and next(iter(texts.keys())) and not isinstance(next(iter(texts.values())), dict):
            raise SystemExit("--texts must be { langLoc: { key: text } }, not a flat { key: text }")
    elif args.mo:
        texts = {args.mo_lang: _load_mo(args.mo)}
    else:
        raise SystemExit("need --texts or --mo for the Lesta ship names")
    curated: dict[str, dict[str, str]] = (
        json.loads(Path(args.curated).read_text(encoding="utf-8")) if args.curated else {}
    )
    lesta_tree = json.loads(Path(args.lesta_tree).read_text(encoding="utf-8"))
    wg_tree = json.loads(Path(args.wg_tree).read_text(encoding="utf-8"))
    wg_indexes = {n["index"] for n in wg_tree.values()}

    # Ship entities by index.
    by_index: dict[str, tuple[str, dict]] = {}
    for key, entry in gp.items():
        if not isinstance(entry, dict):
            continue
        ti = entry.get("typeinfo")
        if not isinstance(ti, dict) or ti.get("type") != "Ship":
            continue
        idx = entry.get("index")
        if isinstance(idx, str):
            by_index[idx] = (key, entry)

    def build_entry(key: str, entry: dict, idx: str) -> tuple[dict, dict]:
        names: dict[str, str] = {}
        for lang, cat in texts.items():
            name = cat.get(f"IDS_{idx}", "").strip()
            if name:
                names[lang] = name
        en = _entry_display_name(key, idx)
        if en and not en.startswith("IDS_"):
            names.setdefault("en-US", en)
        for lang, name in curated.get(idx, {}).items():
            if name:
                names[lang] = name

        descriptions: dict[str, str] = {}
        for lang, cat in texts.items():
            descr = cat.get(f"IDS_{idx}_DESCR", "").strip()
            if descr:
                descriptions[lang] = descr

        hulls = _hull_components(entry)
        hp = None
        for val in hulls:
            h = val.get("health")
            if isinstance(h, (int, float)) and h > 0:
                hp = max(hp or 0, int(h))

        overlay_entry = {
            "index": idx,
            "tier": entry.get("level", 0),
            "type": (entry.get("typeinfo") or {}).get("species", ""),
            "nation": _nation_from_gameparams((entry.get("typeinfo") or {}).get("nation", "")),
            "isPremium": entry.get("group") in {"premium", "ultimate"},
            "isSpecial": entry.get("group") in {"special", "specialUnsellable", "clan"},
            "names": names,
            "defaultProfile": _synthesize_profile(entry),
        }
        if descriptions:
            overlay_entry["descriptions"] = descriptions
        names_entry = {
            "index": idx,
            "tier": entry.get("level"),
            "type": (entry.get("typeinfo") or {}).get("species"),
            "nation": _nation_from_gameparams((entry.get("typeinfo") or {}).get("nation", "")),
            "hp": hp,
            "names": names,
        }
        return overlay_entry, names_entry

    overlay: dict[str, dict] = {}
    names_fragment: dict[str, dict] = {}
    for node in lesta_tree.values():
        idx = node["index"]
        if idx in wg_indexes:
            continue  # WG covers it (names, encyclopedia, images)
        found = by_index.get(idx)
        if not found:
            print(f"[lesta-overlay] WARN no GameParams entity for {idx}", flush=True)
            continue
        key, entry = found
        sid = entry.get("id")
        overlay[str(sid)], names_fragment[str(sid)] = build_entry(key, entry, idx)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"gameVersion": args.version, "ships": overlay},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    with_profile = sum(1 for v in overlay.values() if v.get("defaultProfile"))
    with_descr = sum(1 for v in overlay.values() if v.get("descriptions"))
    print(
        f"[lesta-overlay] wrote {len(overlay)} ships -> {out} "
        f"({with_profile} with profile, {with_descr} with description)"
    )

    if args.merge_names:
        # The name DB covers EVERY Lesta ship the WG roster lacks — replay
        # rosters carry premiums and collabs too, not just tree ships.
        for idx, (key, entry) in by_index.items():
            if idx in wg_indexes or str(entry.get("id")) in names_fragment:
                continue
            sid = entry.get("id")
            if not isinstance(sid, int):
                continue
            _, names_entry = build_entry(key, entry, idx)
            names_fragment[str(sid)] = names_entry
        names_path = Path(args.merge_names)
        db = json.loads(names_path.read_text(encoding="utf-8"))
        added = 0
        for sid, frag in names_fragment.items():
            if sid not in db:
                db[sid] = frag
                added += 1
        names_path.write_text(
            json.dumps(db, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"[lesta-overlay] merged {added} entries into {names_path}")


if __name__ == "__main__":
    main()
