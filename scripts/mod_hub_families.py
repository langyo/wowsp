#!/usr/bin/env python3
"""Style-family folding for the Mod Hub catalog index.

Several Aslain variants of the same HUD element shipped as one catalog
entry each — six team panels, three mini panels, five traffic-light SMI
versions — which read as near-duplicate rows ("侧边面板" three times over)
in the hub list. The design doc's answer is the preset (scheme)
mechanism: ONE entry whose named presets replace the default package
list at install time, rendered as a button group. This module folds
those families at index-build time; the upstream Discussions threads
stay one-per-variant, only the published index merges them.

Fold contract (both index builders — mod_hub_publish.build_index and
mod_index.index_discussions — run this over their built `mods` dict):

- Member ids missing from the index are skipped; a family with fewer
  than two payload-carrying survivors is left unfolded.
- Each preset carries the member's package list, its uploaded preview
  image and a zh/en description pair (the per-variant caveats: mutual
  exclusions, replay breakage…), so the app can swap the preview and
  the notes as the user flips the button group.
- `supersedes` maps every member id to its preset id: installed ledger
  records written under the one-entry-per-variant ids keep pairing, and
  the installer rewinds them before writing the merged row.

    python scripts/mod_hub_families.py   # selftest
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Repository-curated per-locale names/descriptions (same file the
# publisher enriches threads from) — the source of preset descriptions
# and the merged entry's i18n block.
_DESC_I18N_PATH = Path(__file__).with_name("mod_hub_desc_i18n.json")


def _desc_table() -> dict:
    if _DESC_I18N_PATH.exists():
        return json.loads(_DESC_I18N_PATH.read_text(encoding="utf-8"))
    return {}


# One row per family. `members` is (catalog id, preset id, zh label,
# en label[, preset desc zh, preset desc en]) in button-group order —
# the FIRST member is the default scheme (its packages mirror the
# entry's plain package list, matching the fully-preset-driven
# convention of mod_index.py). A family id may equal a member id
# (battle.marker.traffic IS the classic variant): the fold then
# replaces that entry in place, and the desc-json key switches to the
# FAMILY intro — the member's own caveat text rides along as the
# explicit description pair in its tuple.
FAMILIES: list[dict] = [
    {
        "id": "battle.panel",
        "members": [
            ("battle.panel.autospy", "classic", "经典（血量条）", "Classic (HP bars)"),
            ("battle.panel.ttaro", "ttaro", "TTaro 版", "TTaro"),
            ("battle.panel.badobest", "badobest", "BADoBEST 风", "BADoBEST style"),
            ("battle.panel.roslich", "roslich", "Roslich 版", "Roslich"),
            ("battle.panel.hakabase", "hakabase", "Haka 极简", "Haka minimal"),
            ("battle.panel.deceased", "deceased", "DeCease 色块", "DeCease blocks"),
        ],
        # battle.panel.division-badges is deliberately NOT a member: it
        # restores division badges INSIDE whatever panel is installed
        # (an additive fix), not an alternative panel style.
    },
    {
        "id": "battle.minipanel",
        "members": [
            ("battle.minipanel.autospy-v1", "autospy-v1", "紧凑 v1", "Compact v1"),
            ("battle.minipanel.autospy-v2", "autospy-v2", "紧凑 v2", "Compact v2"),
            ("battle.minipanel.team-hp", "team-hp", "队伍总血量", "Team HP"),
        ],
    },
    {
        "id": "battle.marker.traffic",
        "members": [
            (
                "battle.marker.traffic",
                "classic",
                "经典红绿灯",
                "Classic",
                "在舰船标记上添加红绿灯式动向指示，显示该舰正在前进、停船还是倒车。",
                "Adds a traffic-light indicator to ship markers showing whether "
                "the ship is moving forward, stopped or reversing.",
            ),
            ("battle.marker.traffic-v2", "v2", "SMI v2", "SMI v2"),
            ("battle.marker.traffic-v2-cb", "v2-cb", "SMI v2 色盲版", "SMI v2 colorblind"),
            ("battle.marker.traffic-v3", "v3", "SMI v3", "SMI v3"),
            ("battle.marker.traffic-v4", "v4", "SMI v4 四态", "SMI v4 four-state"),
        ],
    },
]


def _vkey(version: str) -> tuple:
    """Numeric sort key over dotted version strings (mirror of the
    builders' latest-version pick, local so this module stays
    import-free for both scripts)."""
    return tuple(int(x) if x.isdigit() else 0 for x in (version or "").split("."))


def _member_desc(table: dict, member: tuple) -> tuple[str, str]:
    """zh/en description pair for one member (its per-variant caveats):
    the explicit pair from the members table wins, else the curated
    desc-json entry under the member id."""
    if len(member) >= 6 and (member[4] or member[5]):
        return (member[4], member[5])
    entry = table.get(member[0]) or {}
    return (
        re_space(entry.get("zh-CN") or ""),
        re_space(entry.get("en-US") or ""),
    )


def re_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _family_meta(table: dict, family_id: str) -> dict:
    """Merged-entry meta: zh/en names (curated `_names`) plus the i18n
    block and base English description from the family's desc entry."""
    names = (table.get("_names") or {}).get(family_id) or {}
    desc = table.get(family_id) or {}
    i18n = {
        lang: {"name": names.get(lang, ""), "desc": re_space(text)}
        for lang, text in desc.items()
        if re_space(text)
    }
    return {
        "name_zh": names.get("zh-CN", ""),
        "name_en": names.get("en-US", family_id),
        "description": re_space(desc.get("en-US") or ""),
        "i18n": i18n,
    }


def fold_families(mods: dict) -> dict:
    """Fold the style families into preset-carrying entries, in place.

    `mods` is the built index shape: `{id: {versions: {v: rec}, latest,
    …}}` where each version rec carries packages/preview/authors. The
    merged entry keeps one version (the newest member version —
    families track the same Aslain pack), unions aliases/tags/authors,
    and lands `supersedes` at the entry level.
    """
    table = _desc_table()
    for fam in FAMILIES:
        plan = _plan_family(fam, mods, table)
        if plan is None:
            continue
        for mid in plan["drop"]:
            mods.pop(mid, None)
        mods[fam["id"]] = plan["entry"]
    return mods


def _plan_family(fam: dict, mods: dict, table: dict) -> dict | None:
    presets: list[dict] = []
    supersedes: dict[str, str] = {}
    aliases: list[str] = []
    tags: list[str] = []
    authors: list[dict] = []
    discussion = None
    license_value = None
    category = fam["id"].split(".")[0]
    version = ""
    game = "*"
    preview = ""
    delisted_all = True
    drop: list[str] = []
    for member in fam["members"]:
        mid, pid, zh, en = member[0], member[1], member[2], member[3]
        entry = mods.get(mid)
        if not entry or not entry.get("versions"):
            continue
        latest = entry.get("latest") or max(entry["versions"], key=_vkey)
        rec = entry["versions"][latest]
        pkgs = rec.get("packages") or []
        if not pkgs:
            continue
        desc_zh, desc_en = _member_desc(table, member)
        preset: dict = {"id": pid, "name_zh": zh, "name_en": en, "packages": pkgs}
        if rec.get("preview"):
            preset["preview"] = rec["preview"]
        if desc_zh or desc_en:
            preset["desc_zh"] = desc_zh
            preset["desc_en"] = desc_en
        presets.append(preset)
        supersedes[mid] = pid
        drop.append(mid)
        for a in entry.get("aliases") or []:
            if a not in aliases:
                aliases.append(a)
        for t in entry.get("tags") or []:
            if t not in tags:
                tags.append(t)
        for a in rec.get("authors") or []:
            if a not in authors:
                authors.append(a)
        if discussion is None:
            discussion = entry.get("discussion")
            license_value = entry.get("license")
            category = entry.get("category") or fam["id"].split(".")[0]
        if _vkey(latest) > _vkey(version):
            version, game = latest, rec.get("game", "*")
        if not preview:
            preview = rec.get("preview") or ""
        delisted_all = delisted_all and bool(entry.get("delisted"))
    if len(presets) < 2:
        # Nothing folded (family absent, or a single survivor that is
        # better left as the plain entry it already is).
        return None
    meta = _family_meta(table, fam["id"])
    rec: dict = {
        "game": game,
        "title": meta["name_en"],
        "name_en": meta["name_en"],
        "name_zh": meta["name_zh"],
        "description": meta["description"],
        "i18n": meta["i18n"],
        # The plain list mirrors the default (first) scheme, exactly as
        # mod_index backfills fully-preset-driven threads.
        "packages": presets[0]["packages"],
        "presets": presets,
    }
    if preview:
        rec["preview"] = preview
    if authors:
        rec["authors"] = authors
        rec["author"] = authors[0].get("name", "")
        rec["author_url"] = authors[0].get("url", "")
    merged: dict = {
        "id": fam["id"],
        "category": category,
        "versions": {version: rec},
        "signals": {},
        "discussion": discussion,
        "latest": version,
        "game": game,
        # Old one-entry-per-variant ids → preset ids: ledger pairing
        # and installer rewind both read this map.
        "supersedes": supersedes,
    }
    if license_value:
        merged["license"] = license_value
    if aliases:
        merged["aliases"] = aliases
    if tags:
        merged["tags"] = tags
    if delisted_all:
        merged["delisted"] = True
    return {"drop": drop, "entry": merged}


def selftest() -> None:
    """Offline checks for the fold (no network, no desc file needed —
    the desc table degrades to empty and preset descs drop out)."""
    pkg = lambda name: {"url": f"https://x/{name}", "sha256": "ab", "size": 1, "name": name}
    mods = {}
    for mid in (
        "battle.panel.autospy",
        "battle.panel.ttaro",
        "battle.panel.hakabase",
        "battle.marker.traffic",
        "battle.marker.traffic-v2",
        "battle.marker.traffic-v4",
        "battle.minipanel.team-hp",
        "battle.calculator.penetration",
    ):
        mods[mid] = {
            "id": mid,
            "category": "battle",
            "versions": {"1.0": {"game": ">=15.7 <15.8", "packages": [pkg(mid + ".zip")], "preview": f"https://img/{mid}", "authors": [{"name": mid, "url": ""}]}},
            "latest": "1.0",
            "game": ">=15.7 <15.8",
            "discussion": 1,
            "aliases": [mid + "-alias"],
        }
    # One family member missing (badobest…) and one family below the
    # two-survivor bar (minipanel) — the former folds with fewer
    # presets, the latter stays as-is.
    fold_families(mods)

    panel = mods.get("battle.panel")
    assert panel is not None, "panel family folded"
    assert [p["id"] for p in panel["versions"]["1.0"]["presets"]] == ["classic", "ttaro", "hakabase"]
    assert panel["supersedes"] == {
        "battle.panel.autospy": "classic",
        "battle.panel.ttaro": "ttaro",
        "battle.panel.hakabase": "hakabase",
    }
    assert panel["aliases"] == [
        "battle.panel.autospy-alias",
        "battle.panel.ttaro-alias",
        "battle.panel.hakabase-alias",
    ]
    # Default scheme mirrors the plain list; each preset keeps its own
    # payload and preview so the app can swap them per button.
    rec = panel["versions"]["1.0"]
    assert rec["packages"] == rec["presets"][0]["packages"]
    assert rec["presets"][1]["preview"] == "https://img/battle.panel.ttaro"
    assert "battle.panel.autospy" not in mods and "battle.panel.ttaro" not in mods

    # The family id IS the classic member: folded in place, classic
    # mapped onto itself so legacy exact-id records still pair.
    traffic = mods.get("battle.marker.traffic")
    assert traffic is not None and "battle.marker.traffic-v4" not in mods
    assert traffic["supersedes"]["battle.marker.traffic"] == "classic"
    assert [p["id"] for p in traffic["versions"]["1.0"]["presets"]] == ["classic", "v2", "v4"]

    # Below the survivor bar and untouched by any family.
    assert "battle.minipanel.team-hp" in mods
    assert "battle.calculator.penetration" in mods

    # A family with a single payload-carrying member never folds (the
    # plain entry is already the right shape).
    solo = {
        "battle.panel.autospy": dict(mods["battle.calculator.penetration"], id="battle.panel.autospy"),
        "battle.panel.ttaro": {
            "id": "battle.panel.ttaro",
            "category": "battle",
            "versions": {"1.0": {"game": "*", "packages": []}},  # no payload
            "latest": "1.0",
        },
    }
    fold_families(solo)
    assert "battle.panel.autospy" in solo and "battle.panel" not in solo
    print("mod_hub_families selftest ok")


if __name__ == "__main__":
    selftest()
