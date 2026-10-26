#!/usr/bin/env python3
"""Bake `packages/webui/src/data/consumable_details.json` — the consumable
ABILITY-ENTITY dictionary behind the ship-detail modal's consumables card —
plus the per-family icon webp set under
`packages/webui/src/res/images/consumables/`.

The card's SLOT LAYOUT is read live from the per-ship GameParams slice the
modal already unpacks (`ShipAbilities`: slot order, mountable alternatives —
always build-fresh). What that slice cannot answer is everything the card
rows and their hover cards need about each ability ENTITY: per-variant
charges (`numConsumables`, -1 = unlimited), active duration and cooldown,
localized names/descriptions and the icon art. Those live in the FULL
GameParams (entities keyed by internal name, each holding per-tier/per-ship
variant specs) and in the game's own strings, so this bake snapshots them
into a compact frontend-importable dictionary keyed by entity + variant.

Scope: every `P[XC]Y<digits>_` entity carrying at least one CONSUMABLE spec
(a dict variant with `group == "ship"`) — deliberately not just the entities
the WG pack's per-ship slices reference, so Lesta-realm slices (the bundled
snapshot the Rust lookup answers from) and future client updates resolve
without a re-bake.

Sources (same layout build_planner_data.py / extract_ship_consumable_kit.py
read):

* ``%LOCALAPPDATA%/WoWSP-extract/GameParams.json`` (`just extract`) — the
  entity definitions.
* ``%LOCALAPPDATA%/WoWSP-extract/wowsinfo_lang.json`` (cached upstream
  wowsinfo/data lang.json) — `IDS_DOCK_CONSUME_TITLE_*` /
  `IDS_DOCK_CONSUME_DESCRIPTION_*` in en/ja/zh_sg/zh_tw (→ en/ja/zh/tw, the
  short codes every baked {names,desc} asset uses).
* ``wows_meta.json`` + the gui pkg — `/gui/consumables/consumable_*.png`
  sliced by (unpacked size, crc32) and converted to webp (--no-icons skips).

Output shapes::

  data/consumable_details.json
    strings:  { "<IDS KEY SUFFIX>":
                  { "names": {en,ja,zh,tw}, "desc": {en,ja,zh,tw} } }
    entities: { "<EntityName>": {
                  "family": "CrashCrew",       # prefix+Premium-stripped
                  "icon": "crashcrew",         # webp stem under res/images/consumables/
                  "variants": { "<Variant>": {
                      "t": "<IDS KEY SUFFIX>", # strings key for the name (and desc when not "d")
                      "d": "<IDS KEY SUFFIX>", # desc key, only when it differs from "t"
                      "c": 4,                  # numConsumables; -1 = unlimited (missing → -1)
                      "w": 10.0, "r": 40.0,    # workTime / reloadTime (s, present when > 0)
                      "ds": 5880, "dt": 3960,  # logic distShip / distTorpedo (m, when present)
                      "rad": 450,              # logic radius — smoke cloud / fighter patrol (m)
                      "a": 1,                  # defaultActivationMode == AUTO (no manual key)
                      "i": "stem",             # icon override: this variant's own iconIDs art
                                                # differs from the entity's icon
                  } } } }

  res/images/consumables/<stem>.webp   # one file per DISTINCT source icon,
                                       # shared by the families using it

The strings key suffix is the ability's `titleIDs` (name) / `descIDs`
(description), falling back to the entity's own name when empty — prefixed
in-game with `IDS_DOCK_CONSUME_TITLE_` / `IDS_DOCK_CONSUME_DESCRIPTION_`.
The bake resolves each variant's best present key at bake time so the
frontend needs a single dict lookup.

Usage::

    python scripts/extract/build_consumable_details.py
    python scripts/extract/build_consumable_details.py --no-icons
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from _common import find_game_path  # noqa: E402

REPO = HERE.parents[1]
WEBUI = REPO / "packages" / "webui" / "src"

CACHE = Path(
    os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")
) / "WoWSP-extract"
GAMEPARAMS_JSON = CACHE / "GameParams.json"
LANG_JSON = CACHE / "wowsinfo_lang.json"
META_JSON = CACHE / "wows_meta.json"

OUT_DATA = WEBUI / "data" / "consumable_details.json"
OUT_ICONS = WEBUI / "res" / "images" / "consumables"

ENTITY_RE = re.compile(r"^P[XC]Y\d+_")
LANG_CODES = ("en", "ja", "zh_sg", "zh_tw")  # wowsinfo lang.json → asset short codes
ASSET_CODE = {"en": "en", "ja": "ja", "zh_sg": "zh", "zh_tw": "tw"}
TITLE_KEY = "IDS_DOCK_CONSUME_TITLE_{}"
DESC_KEY = "IDS_DOCK_CONSUME_DESCRIPTION_{}"

# logic-block distances are BigWorld units; ×30 turns them into metres (same
# conversion extract_ship_consumable_kit.py applies — 1 BW unit = 30 m).
BW_TO_METERS = 30.0


def family_of(entity: str) -> str:
    """Same normalizer extract_ship_consumables() uses (build_planner_data):
    `PCY009_CrashCrewPremium` → `CrashCrew` — keeps this asset's families
    interoperable with ship_consumables.json and the CONSUMABLE_KEY table."""
    return re.sub(r"^P[XC]Y[0-9]+_", "", entity).removesuffix("Premium")


def strings_for(lang: dict[str, dict[str, str]], suffix: str) -> tuple[dict, dict] | None:
    """({names}, {desc}) for an IDS key suffix; either dict may be empty when
    a language misses the key (the frontend falls back per code → en)."""
    names: dict[str, str] = {}
    desc: dict[str, str] = {}
    title = TITLE_KEY.format(suffix)
    desc_k = DESC_KEY.format(suffix)
    for code in LANG_CODES:
        table = lang.get(code) or {}
        short = ASSET_CODE[code]
        if v := table.get(title):
            names[short] = v
        if v := table.get(desc_k):
            desc[short] = v
    if not names and not desc:
        return None
    return names, desc



def variant_record(spec: dict[str, Any], lang: dict) -> dict[str, Any] | None:
    """Compact per-variant record, or None when the variant carries nothing
    usable (fake entries, no strings at all)."""
    if spec.get("isFake"):
        return None
    entity = str(spec.get("_entity", ""))
    title_ids = spec.get("titleIDs") or ""
    desc_ids = spec.get("descIDs") or ""
    # Resolve to the best PRESENT strings key per purpose: descIDs first for
    # the description, then titleIDs, then the bare entity name.
    title_key = (title_ids or entity).upper()
    desc_key = title_key
    for cand in (desc_ids, title_ids, entity):
        key = cand.upper()
        if DESC_KEY.format(key) in (lang.get("en") or {}):
            desc_key = key
            break
    entry: dict[str, Any] = {"t": title_key}
    if desc_key != title_key:
        entry["d"] = desc_key
    # Charges: -1 means unlimited in GameParams; absent means the TimeBased
    # special-hull abilities, which are cooldown-gated only → unlimited.
    nc = spec.get("numConsumables")
    entry["c"] = int(nc) if isinstance(nc, (int, float)) and not isinstance(nc, bool) else -1
    work = spec.get("workTime")
    if isinstance(work, (int, float)) and not isinstance(work, bool) and work > 0:
        entry["w"] = round(float(work), 2)
    reload = spec.get("reloadTime")
    if isinstance(reload, (int, float)) and not isinstance(reload, bool) and reload > 0:
        entry["r"] = round(float(reload), 2)
    # Effective ranges out of the variant's logic block (hydro/sonar ship &
    # torpedo detection, radar distance, smoke-screen radius) — BigWorld
    # units × 30 = metres, the conversion extract_ship_consumable_kit.py
    # applies to the same fields (1 BW unit = 30 m). Rounded to 10 m: the
    # game's own cards never quote finer than that.
    logic = spec.get("logic")
    if isinstance(logic, dict):
        for src, dest in (("distShip", "ds"), ("distTorpedo", "dt"), ("radius", "rad")):
            v = logic.get(src)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                entry[dest] = int(round(v * BW_TO_METERS / 10) * 10)
    if spec.get("defaultActivationMode") == "AUTO":
        entry["a"] = 1
    return entry


def pick_family_icons(
    entities: dict[str, dict[str, Any]],
    meta_by_path: dict[str, dict[str, Any]],
) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """family → icon source path, entity → icon source path, and source
    path → webp stem.

    Preference per ENTITY: the most-referenced art across its variants whose
    file exists in the game files. A variant's non-empty `iconIDs` names its
    art (`consumable_<iconIDs>.png`); an EMPTY `iconIDs` means the client
    renders the entity-name art (`consumable_<Entity>.png`) — those variants
    vote for it instead of abstaining, so a family whose mainstream variants
    are un-iconIDs'd cannot be outvoted by one rare event variant (the CV
    auto damage control's family vote was once won by the StarTrek event art
    that way). `_empty` (greyed) art is never chosen. An entity whose votes
    resolve to nothing falls back to its entity-name file, then to its
    family's most-referenced art.

    The family map serves family-level pickers (no entity context): the
    most-referenced art across the family's entities, else the first
    entity's own resolution.

    Dedupe: one webp per distinct icon art — byte-identical files (same
    unpacked size and crc32) share one webp regardless of path — named
    after the alphabetically first family or entity using it.
    """
    def votes_of(
        ent: str, specs: list[dict[str, Any]],
    ) -> tuple[Counter[str], set[str]]:
        """Per-variant votes plus every distinct variant-declared art — the
        webp allocation must also cover arts that only individual variants
        reference (the client renders those per variant)."""
        votes: Counter[str] = Counter()
        arts: set[str] = set()
        for spec in specs:
            ic = spec.get("iconIDs")
            if ic and "_empty" not in ic:
                source = f"/gui/consumables/consumable_{ic}.png"
                votes[source] += 1
                arts.add(source)
            else:
                votes[f"/gui/consumables/consumable_{ent}.png"] += 1
        return votes, arts

    def first_existing(votes: Counter[str]) -> str | None:
        for source, _n in votes.most_common():
            if source in meta_by_path:
                return source
        return None

    fam_votes: dict[str, Counter[str]] = {}
    fam_entities: dict[str, list[str]] = {}
    ent_source: dict[str, str] = {}
    variant_arts: set[str] = set()
    for ent, rec in sorted(entities.items()):
        fam = rec["family"]
        fam_entities.setdefault(fam, []).append(ent)
        votes, arts = votes_of(ent, rec["_specs"])
        variant_arts.update(arts)
        fam_votes.setdefault(fam, Counter()).update(votes)
        source = first_existing(votes)
        if source is None:
            source = f"/gui/consumables/consumable_{ent}.png"
            if source not in meta_by_path:
                source = None
        if source is not None:
            ent_source[ent] = source

    fam_source: dict[str, str] = {}
    for fam in sorted(fam_votes):
        source = first_existing(fam_votes[fam])
        if source is None:
            for ent in fam_entities[fam]:
                if ent in ent_source:
                    source = ent_source[ent]
                    break
        if source is None:
            for ent in fam_entities[fam]:
                candidate = f"/gui/consumables/consumable_{ent}.png"
                if candidate in meta_by_path:
                    source = candidate
                    break
        if source is not None:
            fam_source[fam] = source

    source_stem: dict[str, str] = {}
    by_content: dict[tuple[int, int], str] = {}
    ordered = [(fam_source[f], f.lower()) for f in sorted(fam_source)]
    ordered += [(ent_source[e], e.lower()) for e in sorted(ent_source)]
    # variant-only arts sort last and are named after their art id
    # ("consumable_PCY015_SpeedBooster_Imp_Premium.png" →
    #  "pcy015_speedbooster_imp_premium"); byte-identical ones fold into
    # whichever family/entity stem already carries that art.
    ordered += [
        (src, src.rsplit("consumable_", 1)[-1][:-4].lower())
        for src in sorted(variant_arts)
    ]
    for source, stem in ordered:
        entry = meta_by_path.get(source) or {}
        content = (int(entry.get("unpacked_size") or 0), int(entry.get("crc32") or 0))
        known = by_content.get(content)
        if known is not None:
            source_stem[source] = known
            continue
        source_stem[source] = stem
        by_content[content] = stem
    return fam_source, ent_source, source_stem


def stamp_variant_icons(
    entities: dict[str, dict[str, Any]],
    meta_by_path: dict[str, dict[str, Any]],
    source_stem: dict[str, str],
    ent_source: dict[str, str],
    fam_source: dict[str, str],
) -> None:
    """Stamp per-variant icon overrides ("i" in the variant record) wherever
    a variant's own `iconIDs` art resolves to a different stem than its
    entity's icon — the client renders art PER VARIANT, so the RN big-heal
    repairs (Eheal art), the short sonars, the quick engine boosts and the
    crawler/oil smokes must not be flattened onto their entity's majority
    art. A variant whose iconIDs is empty (or whose art file is missing)
    renders the entity art, so it stays unstamped."""
    for name, rec in entities.items():
        ent_icon = rec["icon"]
        for vname, ic in rec.pop("_icon_ids").items():
            spec = rec["variants"].get(vname)
            if spec is None:
                continue
            source = None
            if ic and "_empty" not in ic:
                candidate = f"/gui/consumables/consumable_{ic}.png"
                if candidate in meta_by_path:
                    source = candidate
            if source is None:
                source = ent_source.get(name) or fam_source.get(rec["family"])
            stem = source_stem.get(source, "")
            if stem and stem != ent_icon:
                spec["i"] = stem


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--game", default=None, help="WoWS install root (default auto-detect)")
    ap.add_argument("--pkg", default=None,
                    help="gui pkg file (default <game>/res_packages/gui_0001.pkg)")
    ap.add_argument("--no-icons", action="store_true", help="data only, skip the icon scan")
    args = ap.parse_args(argv)

    if not GAMEPARAMS_JSON.is_file():
        print(f"error: {GAMEPARAMS_JSON} not found — run `just extract` first", file=sys.stderr)
        return 2
    if not LANG_JSON.is_file():
        print(f"error: {LANG_JSON} not found (wowsinfo lang cache)", file=sys.stderr)
        return 2

    print(f"[consumables] loading {GAMEPARAMS_JSON.name} …", flush=True)
    full = json.loads(GAMEPARAMS_JSON.read_text(encoding="utf-8"))
    lang: dict[str, dict[str, str]] = json.loads(LANG_JSON.read_text(encoding="utf-8"))

    # ── collect consumable entities ──────────────────────────────────────
    entities: dict[str, dict[str, Any]] = {}
    for name, e in full.items():
        if not isinstance(name, str) or not ENTITY_RE.match(name) or not isinstance(e, dict):
            continue
        specs: list[tuple[str, dict[str, Any]]] = [
            (vname, vdict)
            for vname, vdict in e.items()
            if isinstance(vdict, dict) and vdict.get("group") == "ship"
        ]
        if not specs:
            continue
        variants: dict[str, dict[str, Any]] = {}
        icon_ids: dict[str, str] = {}
        strings: dict[str, dict[str, dict[str, str]]] = {}
        for variant_name, raw in specs:
            spec = dict(raw, _entity=name)
            rec = variant_record(spec, lang)
            if rec is None:
                continue
            variants[variant_name] = rec
            icon_ids[variant_name] = str(raw.get("iconIDs") or "")
            for key in (rec["t"], rec.get("d")):
                if key and key not in strings:
                    resolved = strings_for(lang, key)
                    if resolved:
                        names, desc = resolved
                        entry: dict[str, dict[str, str]] = {}
                        if names:
                            entry["names"] = names
                        if desc:
                            entry["desc"] = desc
                        strings[key] = entry
        if variants:
            entities[name] = {
                "family": family_of(name),
                "icon": "",
                "variants": variants,
                "strings": strings,
                "_specs": [raw for _vn, raw in specs],
                "_icon_ids": icon_ids,
            }

    # Merge per-entity strings into the shared table.
    strings_table: dict[str, dict[str, dict[str, str]]] = {}
    for rec in entities.values():
        for key, entry in rec.pop("strings").items():
            merged = strings_table.setdefault(key, {})
            if "names" in entry:
                merged.setdefault("names", {}).update(entry["names"])
            if "desc" in entry:
                merged.setdefault("desc", {}).update(entry["desc"])

    referenced = sum(len(r["variants"]) for r in entities.values())
    print(f"[consumables] {len(entities)} entities, {referenced} variants, "
          f"{len(strings_table)} strings keys")

    # ── icons ────────────────────────────────────────────────────────────
    if not args.no_icons:
        if not META_JSON.is_file():
            print(f"error: {META_JSON} not found — run `just extract` first "
                  "(or pass --no-icons)", file=sys.stderr)
            return 2
        meta = json.loads(META_JSON.read_text(encoding="utf-8"))
        meta_by_path = {e.get("path"): e for e in meta if isinstance(e, dict)}
        fam_source, ent_source, source_stem = pick_family_icons(entities, meta_by_path)
        for name, rec in entities.items():
            source = ent_source.get(name) or fam_source.get(rec["family"])
            rec["icon"] = source_stem[source] if source else ""
        stamp_variant_icons(entities, meta_by_path, source_stem, ent_source, fam_source)
        missing_fams = sorted(
            {r["family"] for r in entities.values() if not r["icon"]})
        if missing_fams:
            print(f"warn: no icon found for families: {', '.join(missing_fams)}")

        pkg_path = Path(args.pkg) if args.pkg else (
            Path(find_game_path() or "") / "res_packages" / "gui_0001.pkg")
        if pkg_path.is_dir():
            pkg_path = pkg_path / "res_packages" / "gui_0001.pkg"
        if not pkg_path.is_file():
            print(f"warn: gui pkg not found ({pkg_path}) — skipping icon extraction "
                  "(existing webp files are left untouched)", file=sys.stderr)
        else:
            from build_planner_data import find_pkg_png, png_to_webp  # noqa: E402

            print(f"[consumables] scanning {pkg_path.name} "
                  f"({pkg_path.stat().st_size >> 20} MB) …", flush=True)
            pkg_bytes = pkg_path.read_bytes()
            OUT_ICONS.mkdir(parents=True, exist_ok=True)
            written = 0
            for source, stem in sorted(source_stem.items()):
                entry = meta_by_path.get(source)
                if not entry:
                    continue
                blob = find_pkg_png(
                    pkg_bytes, int(entry["unpacked_size"]), entry.get("crc32"))
                if blob is None:
                    print(f"warn: {source} not matched in pkg", file=sys.stderr)
                    continue
                (OUT_ICONS / f"{stem}.webp").write_bytes(png_to_webp(blob))
                written += 1
            # Drop webp files a previous bake left behind whose family no
            # longer exists — otherwise retired families linger as orphan
            # assets in git forever.
            pruned = 0
            for stale in OUT_ICONS.glob("*.webp"):
                if stale.stem not in set(source_stem.values()):
                    stale.unlink()
                    pruned += 1
            print(f"[consumables] wrote {written} icons under "
                  f"{OUT_ICONS.relative_to(REPO)}"
                  + (f", pruned {pruned} stale ones" if pruned else ""))
    else:
        for rec in entities.values():
            rec.pop("icon")

    # ── write ────────────────────────────────────────────────────────────
    out = {
        "strings": {k: strings_table[k] for k in sorted(strings_table)},
        "entities": {
            name: {k: v for k, v in rec.items() if not k.startswith("_")}
            for name, rec in sorted(entities.items())
        },
    }
    OUT_DATA.parent.mkdir(parents=True, exist_ok=True)
    OUT_DATA.write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"[consumables] wrote {OUT_DATA.relative_to(REPO)} "
          f"({OUT_DATA.stat().st_size / 1024:.0f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
