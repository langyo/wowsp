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
(a dict variant with `group == "ship"`) from BOTH realms — the WG client
plus the Lesta (Мир кораблей) client, whose entities and variants the WG
dump lacks (Defensive AA Fire lives on Lesta; WG removed it — the realms
legitimately differ and both must display). WG strings cover en/ja/zh/tw;
Lesta-only entries carry zh from the Lesta mo dump. Deliberately not just
the entities the per-ship slices reference, so realm slices (the bundled
snapshot the Rust lookup answers from) and future client updates resolve
without a re-bake.

Sources (same layout build_planner_data.py / extract_ship_consumable_kit.py
read):

* ``%LOCALAPPDATA%/WoWSP-extract/GameParams.json`` (`just extract`) — the
  WG entity definitions.
* ``%LOCALAPPDATA%/WoWSP-extract/GameParams_lesta.json`` — the Lesta
  realm's entity definitions, collected exactly like the WG ones and
  merged in: Lesta-only entities whole (icon "" — the art sources below
  are WG-client only), and on entities the WG bake already has, ONLY the
  variants WG lacks (WG's own variant records win untouched). Optional —
  when the file or the mo cache is missing the bake warns and stays
  WG-only.
* ``%LOCALAPPDATA%/WoWSP-extract/wowsinfo_lang.json`` (cached upstream
  wowsinfo/data lang.json) — `IDS_DOCK_CONSUME_TITLE_*` /
  `IDS_DOCK_CONSUME_DESCRIPTION_*` in en/ja/zh_sg/zh_tw (→ en/ja/zh/tw, the
  short codes every baked {names,desc} asset uses).
* ``%LOCALAPPDATA%/WoWSP-extract/mo_zh.json`` — the Lesta client's zh
  strings, filling the zh slot of merged-variant strings keys the WG langs
  cannot resolve (never inventing: keys neither source resolves stay
  absent).
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
# Lesta (Мир кораблей) counterpart dump + its zh strings — the same cache
# dir; when either is missing the bake warns and stays WG-only.
LESTA_GAMEPARAMS_JSON = CACHE / "GameParams_lesta.json"
LESTA_MO_ZH_JSON = CACHE / "mo_zh.json"

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


def strings_entry_for(
    lang: dict[str, dict[str, str]],
    mo_zh: dict[str, str] | None,
    suffix: str,
) -> tuple[dict, dict, bool] | None:
    """({names}, {desc}, zh-filled?) for a MERGED (Lesta-side) variant's
    strings key: the WG langs first (strings_for), then the zh slot filled
    from the Lesta mo dump when the WG langs miss it — they simply do not
    carry the Lesta realm's own keys. None when nothing resolves (never
    invent strings)."""
    resolved = strings_for(lang, suffix)
    names, desc = ({}, {}) if resolved is None else resolved
    zh_filled = False
    if mo_zh:
        if "zh" not in names and (v := mo_zh.get(TITLE_KEY.format(suffix))):
            names["zh"] = v
            zh_filled = True
        if "zh" not in desc and (v := mo_zh.get(DESC_KEY.format(suffix))):
            desc["zh"] = v
            zh_filled = True
    if not names and not desc:
        return None
    return names, desc, zh_filled


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


def collect_entities(
    full: dict[str, Any], lang: dict[str, dict[str, str]],
) -> dict[str, dict[str, Any]]:
    """Every consumable ENTITY in a GameParams dump (either realm): the
    `P[XC]Y<digits>_` entries carrying at least one dict variant with
    `group == "ship"`, each with its compact variant records, the strings
    keys they resolve to, and the raw specs / iconIDs the icon pass needs
    (leading-underscore bookkeeping, dropped before the write).

    Both realms go through this exact same path — same ENTITY_RE, same
    family_of()/variant_record()/strings handling — so a Lesta record is
    shaped like its WG counterpart in every field."""
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
    return entities


def merge_lesta_entities(
    entities: dict[str, dict[str, Any]],
    lesta: dict[str, dict[str, Any]],
    lang: dict[str, dict[str, str]],
    mo_zh: dict[str, str] | None,
    strings_table: dict[str, dict[str, dict[str, str]]],
) -> Counter[str]:
    """Fold the Lesta realm's collected entities into the WG bake — called
    AFTER the icon pass, whose art sources (meta + pkg) are WG-client only:
    an entity the WG bake already has gains ONLY the variants WG lacks
    (WG's own variant records — strings, art overrides — win untouched),
    and an entity WG lacks is added whole with icon "". Incoming variants'
    strings resolve through the WG langs first; keys they cannot resolve
    get their zh filled from the Lesta mo dump (strings_entry_for).
    Returns the merge counters for the bake log."""
    stats: Counter[str] = Counter()

    def add_strings(rec: dict[str, Any]) -> None:
        for key in (rec["t"], rec.get("d")):
            if not key or key in strings_table:
                continue
            resolved = strings_entry_for(lang, mo_zh, key)
            if resolved is None:
                continue
            names, desc, zh_filled = resolved
            entry: dict[str, dict[str, str]] = {}
            if names:
                entry["names"] = names
            if desc:
                entry["desc"] = desc
            strings_table[key] = entry
            stats["strings"] += 1
            if zh_filled:
                stats["zh"] += 1

    for name, lrec in sorted(lesta.items()):
        wrec = entities.get(name)
        if wrec is None:
            entities[name] = {
                "family": lrec["family"],
                "icon": "",
                "variants": dict(lrec["variants"]),
            }
            stats["entities"] += 1
            stats["variants"] += len(lrec["variants"])
            for vrec in lrec["variants"].values():
                add_strings(vrec)
        else:
            for vname, vrec in lrec["variants"].items():
                if vname in wrec["variants"]:
                    continue
                wrec["variants"][vname] = vrec
                stats["variants"] += 1
                add_strings(vrec)
    return stats


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
    ap.add_argument("--lesta-gameparams", default=str(LESTA_GAMEPARAMS_JSON),
                    help="Lesta (Мир кораблей) GameParams.json merged into "
                         "the bake (default: the WoWSP-extract cache dump; "
                         "missing file → warn + WG-only bake)")
    ap.add_argument("--lesta-mo-zh", default=str(LESTA_MO_ZH_JSON),
                    help="Lesta zh strings (flat mo dump) filling the zh slot "
                         "of merged-variant keys the WG langs miss (default: "
                         "the WoWSP-extract cache dump)")
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

    # The Lesta merge is optional: when either source cache is missing the
    # bake warns and reproduces today's WG-only result.
    lesta_gp = Path(args.lesta_gameparams)
    lesta_zh = Path(args.lesta_mo_zh)
    lesta_full: dict[str, Any] | None = None
    mo_zh: dict[str, str] | None = None
    if lesta_gp.is_file() and lesta_zh.is_file():
        print(f"[consumables] loading {lesta_gp.name} + {lesta_zh.name} "
              "(Lesta merge) …", flush=True)
        lesta_full = json.loads(lesta_gp.read_text(encoding="utf-8"))
        mo_zh = json.loads(lesta_zh.read_text(encoding="utf-8"))
    else:
        missing = lesta_gp if not lesta_gp.is_file() else lesta_zh
        print(f"warn: {missing} not found — skipping the Lesta merge "
              "(WG-only bake)", file=sys.stderr)

    # ── collect consumable entities (WG, then Lesta through the same path) ──
    entities = collect_entities(full, lang)
    lesta = collect_entities(lesta_full, lang) if lesta_full is not None else {}

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

    # ── merge the Lesta realm ────────────────────────────────────────────
    # Deliberately AFTER the icon pass: the art sources are WG-client only,
    # so Lesta-only entities carry icon "" and incoming variants never
    # displace a WG record or its art.
    if lesta and mo_zh is not None:
        mstats = merge_lesta_entities(entities, lesta, lang, mo_zh, strings_table)
        print(f"[consumables] lesta merge: +{mstats['entities']} entities, "
              f"+{mstats['variants']} variants, +{mstats['strings']} strings keys "
              f"(zh filled from mo_zh: {mstats['zh']})")
    referenced = sum(len(r["variants"]) for r in entities.values())
    print(f"[consumables] total: {len(entities)} entities, {referenced} variants, "
          f"{len(strings_table)} strings keys (both realms)")

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
