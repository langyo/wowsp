"""Build the tech-tree branch-feature data for the ships view's ⓘ cards.

The in-game port tech tree draws a small ⓘ button on the research line above
each branch-segment start ship; hovering it opens the "warship
characteristics" popup: the branch's range (start ship — end ship) plus its
feature summary, and the card itself carries the branch's feature icons. The
data behind that lives in the client's encrypted Python, NOT in GameParams:

  ``scripts/BranchesSettings.pyc``   — per-branch feature tables keyed by the
    ``shared_constants.ships.BRANCH`` enum names (``US_CA_LIGHT``, ...):
    ``BD(BranchDescription=[icon keys], <encrypted mainFeatures>=[(CATEGORY.x,
    [FEAT_* ...]) ...])`` records, plus the type-generic (``SHIP_TYPE_FEATURES``)
    and class-generic (``BRANCH_FEATURES``) fallback sets, and the
    ``PREFIX_GOOD``/``PREFIX_BAD`` icon-key prefixes.

The module is a py2.7 obfuscated wrapper, so this script re-uses
``scripts/pyc_deob`` to decode it and then replays the module body's
constant stream statically (the wrapper interleaves junk instructions and
re-orders blocks, so a real interpreter run desyncs; the constant/data stream
in offset order is regular enough to replay directly).

The game computes each branch's ship list at runtime from the tech-tree graph
— there is no static branch→ships table in the client. We therefore rebuild
the same segmentation from the bundled WG tree (``tech_tree.json``): chains
per nation+type in ``nextShips`` order (the game's own line order), segments
per fork column, and branch names assigned by supership-name matching (the
alternative branches are named after their ★ end ship) with the remaining
main lines assigned in enum order. The result carries ``shipBranch`` so the
renderer can find segment boundaries without any per-ship heuristics.

Usage:
  python scripts/extract/build_branch_features.py \
      --scripts-zip "<WG client>/bin/<build>/res/scripts.zip" \
      --gameparams "$LOCALAPPDATA/WoWSP-extract/GameParams.json" \
      --mo-zh "<WG client>/bin/<build>/res/texts/zh/LC_MESSAGES/global.mo" \
      --mo-ru "<Lesta client>/bin/<build>/res/texts/ru/LC_MESSAGES/global.mo" \
      --icons-dir <dir from: wowsunpack extract "/gui/ships_tree_features/*.png"> \
      --out packages/webui/src/data/tech_tree_branch_features.json

The mo carries the official strings (a plain GNU gettext file — mind the
(length, offset) field order); the icons land in the webui publicDir at
packages/webui/src/res/images/tech-tree-features/ (small variants preferred,
~355 KB). The output and the icons are committed; the client dumps are not.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyc_deob"))
import wows_pyc  # noqa: E402  (scripts/pyc_deob toolkit, repo-vendored)

# ── static replay of BranchesSettings ────────────────────────────────────

RE_PLAIN_BYTES = re.compile(rb"[\x20-\x7e]{2,}")


def _is_blob(v: object) -> bool:
    return isinstance(v, bytes) and not RE_PLAIN_BYTES.fullmatch(v)


def replay_branches_settings(zpath: str) -> dict[str, object]:
    """Statically replay the module body's data stream.

    Returns the decoded BD(...) records keyed by branch-enum name
    (``{"__call__": "BD", "BranchDescription": [...], ...}``).
    """
    wows_pyc.open_zip(zpath)
    real = wows_pyc.decode_real(wows_pyc.Z.read("scripts/BranchesSettings.pyc"))
    names = [wows_pyc._s(n) for n in real["names"]]
    consts = real["consts"]

    # The branch-enum attribute names: every LOAD_ATTR name that follows a
    # LOAD_NAME indexToID. Collected on a first pass (the wrapper's junk
    # interleaves, so attribute reads are tracked by name, not stack shape).
    branch_names: set[str] = set()
    prev_name = ""
    for off, op, arg in wows_pyc.walk_ops(real):
        if op == "LOAD_NAME" and arg < len(names):
            prev_name = names[arg]
        elif op == "LOAD_ATTR" and arg < len(names) and prev_name == "indexToID":
            if re.fullmatch(r"[A-Z][A-Z_0-9]*", names[arg]):
                branch_names.add(names[arg])
        elif op in ("STORE_FAST", "LOAD_FAST"):
            prev_name = ""

    st: list[object] = []
    records: dict[str, object] = {}
    pending_key: str | None = None
    last_record: object = None

    for off, op, arg in wows_pyc.walk_ops(real):
        if op == "LOAD_CONST" and arg < len(consts):
            v = consts[arg]
            if _is_blob(v):
                st.append("<blob>")
            elif isinstance(v, bytes):
                st.append(v.decode("utf-8", "replace"))
            else:
                st.append(v)
        elif op in ("LOAD_NAME", "LOAD_GLOBAL") and arg < len(names):
            st.append(names[arg])
        elif op == "LOAD_ATTR" and arg < len(names):
            a = st.pop() if st else "?"
            st.append(f"{a}.{names[arg]}")
            if a == "indexToID" and names[arg] in branch_names:
                pending_key = names[arg]
        elif op in ("BUILD_LIST", "BUILD_TUPLE"):
            items = st[len(st) - arg:] if arg and len(st) >= arg else []
            if arg and len(st) >= arg:
                del st[len(st) - arg:]
            st.append(list(items) if op == "BUILD_LIST" else tuple(items))
        elif op == "CALL_FUNCTION":
            nkw, npos = arg >> 8, arg & 0xFF
            kw: dict[str, object] = {}
            if nkw and len(st) >= 2 * nkw:
                items = st[len(st) - 2 * nkw:]
                del st[len(st) - 2 * nkw:]
                kw = {str(items[2 * i]): items[2 * i + 1] for i in range(nkw)}
            if npos and len(st) >= npos:
                del st[len(st) - npos:]
            callee = str(st.pop()) if st else "?"
            if callee == "BD":
                last_record = {"__call__": callee, **kw}
            st.append({"__call__": callee, **kw})
        elif op == "STORE_MAP":
            if len(st) >= 2:
                st.pop()
                st.pop()
            if pending_key and last_record is not None:
                records[pending_key] = last_record
                pending_key = None
                last_record = None
        elif op == "STORE_NAME" and arg < len(names):
            if st:
                st.pop()
    return records


def flatten_groups(record: dict) -> tuple[list[str], list[tuple[str, list[str]]]]:
    """Decode one BD record into (card icon keys, [(category, [feats]) ...]).

    The BD call is ``BD(BranchDescription=[card icons], <encrypted
    mainFeatures>=[(CATEGORY.x, [FEAT_* ...]), ...])`` — the kwarg NAME for
    the groups list is an encrypted bytes const, so the groups are identified
    by shape: the list value made of (marker, [strings]) pairs.
    """
    card: list[str] = []
    groups: list[tuple[str, list[str]]] = []

    def strings(v: object) -> list[str]:
        if isinstance(v, str):
            return [v]
        if isinstance(v, (list, tuple)):
            out: list[str] = []
            for x in v:
                out.extend(strings(x))
            return out
        return []

    for key, v in record.items():
        if key == "__call__" or not isinstance(v, list):
            continue
        if v and all(isinstance(item, tuple) and len(item) == 2 for item in v):
            for cat, feats in v:
                clean: list[str] = []
                for f in strings(feats):
                    m = re.search(r"(FEAT_(?:GOOD|BAD)_[A-Z_0-9]+)", f)
                    if m:
                        clean.append(m.group(1))
                if clean:
                    groups.append((str(cat).removeprefix("CATEGORY.").lower(), clean))
        else:
            for s in strings(v):
                if s.startswith(("MAIN_", "CLASS_")):
                    card.append(s)
    card = list(dict.fromkeys(card))
    return card, groups


# ── branch enum order (shared_constants.ships BRANCH class body order) ──

BRANCH_ENUM_ORDER = [
    "US_CV", "US_CV_USSUS", "US_CV2", "US_BB", "US_BB_MAINE", "US_BB_TOP",
    "US_BB_NEW", "US_HYB", "US_CA_EARLY", "US_CA_LIGHT", "US_CA_JACKSONVILLE",
    "US_CA_HEAVY", "US_CA_ANNAPOLIS", "US_DD_ARTILLERY", "US_DD_TORPEDO",
    "US_DD_HUMPHREYS", "US_DD2_SMOKEART", "US_SC", "JP_CV", "JP_CV_SEKIRYU",
    "JP_BB", "JP_BB_SATSUMA", "JP_BB_LIGHT", "JP_CA", "JP_CA_KURAMA", "JP_CL",
    "JP_DD_MAIN", "JP_DD_ART", "JP_DD_TORP", "JP_DD_YAMAGIRI", "UK_CV",
    "UK_CV_EAGLE", "UK_BB", "UK_BB_DEVASTATION", "UK_BB_2", "UK_CA_LIGHT",
    "UK_CA_HEAVY", "UK_CA_EDGAR", "UK_DD", "UK_SC", "ASIA_DD",
    "ASIA_DD_KUNMING", "ASIA_CA", "GER_BB", "GER_BB_2", "GER_BB_HANNOVER",
    "GER_CA", "GER_CA_CLAUSEWITZ", "GER_CB", "GER_DD_1", "GER_DD_2",
    "GER_DD_150", "GER_CV", "GER_SC", "ITA_CA", "ITA_CA_PIEMONTE", "ITA_BB",
    "ITA_BB_AFFONDATORE", "ITA_DD", "ITA_SS", "RU_CA", "RU_CA_HEAVY",
    "RU_CA_NOVOSIBIRSK", "RU_BB", "RU_BB_USHAKOV", "RU_DD_1", "RU_DD_ART",
    "RU_DD_SUPPORT", "RU_DD_ZORKY", "RU_CV", "RU_SS", "FR_BB",
    "FR_BB_PATRIE", "FR_CA", "FR_CA2", "FR_CA_CONDE", "FR_DD_1", "FR_DD_2",
    "FR_DD_TORP", "EU_BB", "EU_DD", "EU_DD_DALARNA", "EU_DD_GUN", "NED_CL",
    "NED_CLAA", "NED_CA", "PAM_BB", "PAM_CL_LOW", "PAM_CL_HIGH", "PAM_DD",
    "BATTLESHIPS", "CRUISERS", "DESTROYERS", "AIR_CARRIERS", "SUBMARINES",
    "PREMIUM_SHIP", "ESP_CA_1", "ESP_CA_2", "CW_CA",
]

TYPE_GENERIC = {
    "BATTLESHIPS": "Battleship", "CRUISERS": "Cruiser", "DESTROYERS": "Destroyer",
    "AIR_CARRIERS": "AirCarrier", "SUBMARINES": "Submarine",
}

NATION_CODE = {
    "usa": "US", "japan": "JP", "uk": "UK", "germany": "GER", "ussr": "RU",
    "france": "FR", "pan_europe": "EU", "pan_asia": "ASIA",
    "pan_america": "PAM", "netherlands": "NED", "italy": "ITA",
    "spain": "ESP", "commonwealth": "CW",
}

TYPE_CODE = {
    "Battleship": "BB", "Cruiser": "CA", "Destroyer": "DD",
    "AirCarrier": "CV", "Submarine": "SS",
}

# Ship-index → readable-name suffix comes from the GameParams entry keys
# ("PVSB019_Los_Andes"); branch names name alternative lines after their ★
# end ship ("US_CA_ANNAPOLIS"), so a normalized suffix match pins those.
def _norm(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", s.upper())


# Column-end overrides where the naming heuristics pick the wrong sibling
# line: (nation, type, column-end ship index) → branch enum name.
BRANCH_OVERRIDES = {
    ("japan", "Cruiser", "PJSC210"): "JP_CL",  # the Yodo light-cruiser line
    ("usa", "Cruiser", "PASC111"): "US_CA_LIGHT",  # Dallas→Seattle line (★ Annapolis row split off)
    ("usa", "Cruiser", "PASC011"): "US_CA_HEAVY",  # Pensacola→Baltimore line (★ Jacksonville row split off)
    ("germany", "Destroyer", "PGSD110"): "GER_DD_150",  # the 150mm gun line (Z-23→Z-52)
}

# Cruiser branch names use CA, CL and CB middle tokens (NED_CL, PAM_CL_HIGH).
TYPE_ALT_CODES = {"Cruiser": ("CA", "CL", "CB")}


def _is_supership(node: dict) -> bool:
    return node["tier"] >= 11 or node.get("group") == "superShip"


def build_ship_branch(tree: dict, gp_keys: dict[str, str]) -> dict[str, str]:
    """shipId(str) → branch enum name, mirroring the game's runtime grouping.

    The game splits each fork column into branch runs: the main rows carry
    the line's own record and a ★-capped column's last row is its own branch
    (named after the supership, with rage-mode feature groups). Shared
    prefixes covered by several columns belong to the first branch that
    reaches them.
    """
    nodes = list(tree.values())
    ship_branch: dict[str, str] = {}

    by_nat_type: dict[tuple[str, str], list[dict]] = {}
    for n in nodes:
        if n["isPremium"] or n["isSpecial"]:
            continue
        by_nat_type.setdefault((n["nation"], n["type"]), []).append(n)

    for (nation, type_), list_ in sorted(by_nat_type.items()):
        by_type_id = {n["shipId"]: n for n in list_}
        pointed: set[int] = set()
        for n in list_:
            for nx in n["nextShips"]:
                if nx in by_type_id:
                    pointed.add(nx)
        roots = sorted((n for n in list_ if n["shipId"] not in pointed), key=lambda n: n["tier"])

        # Columns in nextShips order = the game's own line order (#945).
        columns: list[list[dict]] = []
        stack = [(r, [r]) for r in reversed(roots)]
        while stack:
            node, path = stack.pop()
            kids = [by_type_id[i] for i in node["nextShips"] if i in by_type_id]
            if not kids:
                columns.append(path)
                continue
            for k in reversed(kids):
                stack.append((k, path + [k]))

        nat = NATION_CODE.get(nation, nation.upper())
        alt_codes = TYPE_ALT_CODES.get(type_, (TYPE_CODE.get(type_, type_.upper()),))
        prefixes = [f"{nat}_{alt}" for alt in alt_codes]
        prefix = prefixes[0]
        # Candidates include enum names WITHOUT a feature record: they still
        # segment the tree (e.g. US_CA_EARLY owns the shared trunk rows), the
        # renderer just draws no ⓘ for a branch without content. Numeric
        # suffixes (FR_CA2, US_CV2) are second main lines of the same type.
        suffix_res = [
            re.compile(re.escape(p) + r"(?:_[A-Z_0-9]+|\d+)?") for p in prefixes
        ]
        candidates = [
            name for name in BRANCH_ENUM_ORDER
            if any(r.fullmatch(name) for r in suffix_res)
        ]
        # ★-named branches pin onto the column ending at that supership.
        col_branch: list[str | None] = [None] * len(columns)
        taken: set[str] = set()
        for ci, col in enumerate(columns):
            suffix = _norm(gp_keys.get(col[-1]["index"], ""))
            if not suffix:
                continue
            for name in candidates:
                tail = _norm(name.rsplit("_", 1)[-1])
                # Digit tails (GER_DD_150) are distinctive once they have more
                # than one digit; word tails need substance to avoid false pins.
                distinctive = (tail.isdigit() and len(tail) >= 2) or len(tail) >= 5
                if distinctive and tail in suffix and name not in taken:
                    col_branch[ci] = name
                    taken.add(name)
                    break
        supership_rows: dict[int, str] = {}
        for ci, assigned in enumerate(col_branch):
            if assigned is not None and _is_supership(columns[ci][-1]):
                supership_rows[ci] = assigned
                col_branch[ci] = None
        # The shared trunk (rows every column passes through) can be its own
        # branch — US_CA_EARLY-style: a leftover *EARLY* candidate claims it.
        trunk_ids: set[int] = set()
        if len(columns) >= 2:
            a, b = columns[0], columns[1]
            i = 0
            while i < len(a) and i < len(b) and a[i]["shipId"] == b[i]["shipId"]:
                i += 1
            for node in a[:i]:
                trunk_ids.add(node["shipId"])
        used = set(taken) | set(supership_rows.values())
        rest = [name for name in candidates if name not in used]
        trunk_branch = next((n for n in rest if "EARLY" in n), None)
        if trunk_branch and trunk_ids:
            for sid in trunk_ids:
                ship_branch.setdefault(str(sid), trunk_branch)
            rest = [n for n in rest if n != trunk_branch]
        rest.sort(key=lambda n: n != prefix)
        for ci, col in enumerate(columns):
            if col_branch[ci] is not None:
                continue
            ov = BRANCH_OVERRIDES.get((nation, type_, col[-1]["index"]))
            if ov:
                col_branch[ci] = ov
            elif rest:
                col_branch[ci] = rest.pop(0)
        # Emit: supership columns split into main rows + the ★ row.
        for ci, col in enumerate(columns):
            name = col_branch[ci]
            rows = col[:-1] if ci in supership_rows else col
            if name:
                for node in rows:
                    ship_branch.setdefault(str(node["shipId"]), name)
            if ci in supership_rows:
                ship_branch.setdefault(str(col[-1]["shipId"]), supership_rows[ci])
        for node in list_:
            ship_branch.setdefault(str(node["shipId"]), "")
    return ship_branch


def load_mo(path: str) -> dict[str, str]:
    """Read the client's GNU gettext global.mo.

    The tables are plain (length, offset) pairs — an easy field order to get
    backwards; the strings themselves are UTF-8.
    """
    import struct

    data = Path(path).read_bytes()
    magic, _rev, n, o, t = struct.unpack("<IIIII", data[:20])
    if magic != 0x950412DE:
        raise SystemExit(f"[branchfeat] not a .mo file: {path}")
    out: dict[str, str] = {}
    for i in range(n):
        lno, offo = struct.unpack("<II", data[o + 8 * i:o + 8 * i + 8])
        lnt, offt = struct.unpack("<II", data[t + 8 * i:t + 8 * i + 8])
        out[data[offo:offo + lno].decode("utf-8", "replace")] = (
            data[offt:offt + lnt].decode("utf-8", "replace")
        )
    return out


# Official localization keys for the popup chrome. The FEAT/category strings
# are looked up as IDS_<KEY> / IDS_OTHER_FEATURE_CATEGORY_<CODE>.
TITLE_KEY = "IDS_SHIP_BRANCH_FEATURES_TOOLTIP_TITLE"
NOTE_KEY = "IDS_SHIPS_BRANCHES_FEATURES_HINT"


def merge_official_texts(
    texts: dict,
    zh: dict[str, str],
    ru: dict[str, str] | None,
    used_feats: set[str],
    used_cats: set[str],
) -> None:
    """Overlay the client's official strings onto the curated en-US base.

    zh-Hans comes from the CN client's mo (required — every used key must be
    present); ru-RU rides along from the Lesta client where it exists (its
    fork lags WG's newer keys, those fall back to en-US at runtime); en-US
    stays curated (no English client is installed locally).
    """
    def put(bucket: dict, key: str, zh_v: str, ru_v: str | None) -> None:
        entry = bucket.setdefault(key, {})
        put_locale(entry, zh_v, ru_v)

    def put_locale(entry: dict, zh_v: str, ru_v: str | None) -> None:
        entry["zh-Hans"] = zh_v
        if ru_v:
            entry["ru-RU"] = ru_v
        if "en-US" not in entry:
            raise SystemExit("[branchfeat] curated en-US missing")

    put_locale(texts["title"], zh[TITLE_KEY], ru.get(TITLE_KEY) if ru else None)
    put_locale(texts["note"], zh[NOTE_KEY], ru.get(NOTE_KEY) if ru else None)
    missing = [c for c in used_cats if f"IDS_OTHER_FEATURE_CATEGORY_{c.upper()}" not in zh]
    if missing:
        raise SystemExit(f"[branchfeat] categories without an official label: {missing}")
    for c in used_cats:
        k = f"IDS_OTHER_FEATURE_CATEGORY_{c.upper()}"
        put(texts["category"], c, zh[k], ru.get(k) if ru else None)
    missing = [f for f in used_feats if f"IDS_{f}" not in zh]
    if missing:
        raise SystemExit(f"[branchfeat] feats without an official zh string: {missing[:10]}")
    for f in used_feats:
        put(texts["feat"], f, zh[f"IDS_{f}"], ru.get(f"IDS_{f}") if ru else None)


def bundle_icons(
    used_cards: set[str],
    used_cats: set[str],
    icons_dir: str,
    icons_out: str,
) -> dict:
    """Resolve and copy the feature icons (small variants preferred — the
    tree cards and the tooltip render at 12-20px). Returns the manifest the
    webui resolves against `${BASE_URL}images/tech-tree-features/`."""
    import shutil

    root = Path(icons_dir) / "gui" / "ships_tree_features"
    main_dir = root / "main_features"
    cat_dir = root / "categories"
    manifest: dict[str, dict[str, str]] = {"card": {}, "category": {}}

    def pick(key: str, pool: set[str]) -> str | None:
        lo = key.lower()
        for cand in (f"{lo}_small.png", f"{lo}.png"):
            if cand in pool:
                return cand
        return None

    main_pool = {p.name for p in main_dir.glob("*.png")}
    cat_pool = {p.name for p in cat_dir.glob("*.png")}
    wanted: list[tuple[Path, str]] = []
    missing_icons: list[str] = []
    for key in sorted(used_cards):
        f = pick(key, main_pool)
        if not f:
            missing_icons.append(key)
            continue
        manifest["card"][key] = f
        wanted.append((main_dir / f, f))
    for code in sorted(used_cats):
        f = f"category_{code}.png"
        if f not in cat_pool:
            missing_icons.append(code)
            continue
        manifest["category"][code] = f
        wanted.append((cat_dir / f, f))
    if missing_icons:
        # A typo'd --icons-dir must fail loudly, not silently strip the
        # bundle down (or wipe the committed icon set in --icons-out).
        raise SystemExit(f"[branchfeat] icons missing from {icons_dir}: {missing_icons[:10]}")

    out_dir = Path(icons_out)
    # The prune below unlinks PNGs — only ever allow the dedicated folder.
    if out_dir.name != "tech-tree-features":
        raise SystemExit(
            f"[branchfeat] refusing --icons-out {out_dir} (expected .../tech-tree-features)"
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    keep = {f for _, f in wanted}
    for stale in out_dir.glob("*.png"):
        if stale.name not in keep:
            stale.unlink()
    for src, name in wanted:
        shutil.copyfile(src, out_dir / name)
    total = sum(src.stat().st_size for src, _ in wanted)
    print(f"[branchfeat] bundled {len(wanted)} icons ({total / 1024:.0f} KB) → {out_dir}")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scripts-zip", required=True, help="client res/scripts.zip")
    ap.add_argument("--gameparams", required=True, help="GameParams.json (entry keys carry ship names)")
    ap.add_argument("--tree", default="packages/webui/src/data/tech_tree.json")
    ap.add_argument("--mo-zh", required=True, help="CN client texts/<lang>/LC_MESSAGES/global.mo")
    ap.add_argument("--mo-ru", help="Lesta client global.mo (optional ru-RU strings)")
    ap.add_argument(
        "--icons-dir",
        help="dir holding the extracted gui/ships_tree_features tree "
        "(wowsunpack extract \"/gui/ships_tree_features/*.png\")",
    )
    ap.add_argument(
        "--icons-out",
        default="packages/webui/src/res/images/tech-tree-features",
        help="webui publicDir folder the icons are copied into",
    )
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    print("[branchfeat] decoding BranchesSettings ...", flush=True)
    records = replay_branches_settings(args.scripts_zip)
    print(f"[branchfeat] BD records: {len(records)}", flush=True)

    texts = json.loads(
        (Path(__file__).parent / "branch_feat_texts_curated.json").read_text(encoding="utf-8")
    )

    gp = json.loads(Path(args.gameparams).read_text(encoding="utf-8"))
    if isinstance(gp, dict) and isinstance(gp.get(""), dict):
        gp = gp[""]
    gp_keys = {}
    for key, obj in gp.items():
        if isinstance(obj, dict) and obj.get("typeinfo", {}).get("type") == "Ship":
            idx = obj.get("index")
            if isinstance(idx, str):
                gp_keys[idx] = key[len(idx):].lstrip("_")

    tree = json.loads(Path(args.tree).read_text(encoding="utf-8"))
    ship_branch = build_ship_branch(tree, gp_keys)

    branches: dict[str, dict] = {}
    unmatched: list[str] = []
    dropped = [n for n in records if n not in BRANCH_ENUM_ORDER]
    if dropped:
        print(f"[branchfeat] records outside the known enum (check BRANCH_ENUM_ORDER): {sorted(dropped)}")
    for name, rec in records.items():
        if name not in BRANCH_ENUM_ORDER:
            continue
        card, groups = flatten_groups(rec)
        if not groups and not card:
            continue
        branches[name] = {"card": card, "groups": groups}
    for s, b in ship_branch.items():
        if b and b not in branches and b not in unmatched:
            unmatched.append(b)

    # Text coverage: every FEAT key that reaches the bundled data must have a
    # curated en-US string (zh-Hans/ru-RU come from the client mo below).
    used_feats: set[str] = set()
    used_cats: set[str] = set()
    for info in branches.values():
        for cat, feats in info["groups"]:
            used_cats.add(cat)
            used_feats.update(feats)
    missing_texts = sorted(
        f for f in used_feats
        if f not in texts["feat"] or "en-US" not in texts["feat"][f]
    )
    missing_cats = sorted(
        c for c in used_cats
        if c not in texts["category"] or "en-US" not in texts["category"][c]
    )
    if missing_texts or missing_cats:
        raise SystemExit(
            f"[branchfeat] missing curated texts — feats: {missing_texts}; categories: {missing_cats}"
        )

    print("[branchfeat] merging official mo strings ...", flush=True)
    merge_official_texts(
        texts, load_mo(args.mo_zh), load_mo(args.mo_ru) if args.mo_ru else None,
        used_feats, used_cats,
    )

    used_cards: set[str] = set()
    for info in branches.values():
        used_cards.update(info["card"])
    icons: dict | None = None
    if args.icons_dir:
        icons = bundle_icons(used_cards, used_cats, args.icons_dir, args.icons_out)

    out = {
        "branches": branches,
        # Keep record-less branches (US_CA_EARLY...): the renderer needs the
        # names to find segment boundaries even where no ⓘ content exists.
        "shipBranch": {s: b for s, b in ship_branch.items() if b},
        "texts": texts,
    }
    if icons:
        out["icons"] = icons
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"[branchfeat] wrote {len(branches)} branches, {len(out['shipBranch'])} ships → {path}")
    known = set(BRANCH_ENUM_ORDER)
    missing = [n for n in BRANCH_ENUM_ORDER if n not in records]
    print(f"[branchfeat] enum names without records: {missing}")
    print(f"[branchfeat] segments pointing at names without records: {unmatched}")
    print(f"[branchfeat] (enum size {len(known)})")


if __name__ == "__main__":
    main()
